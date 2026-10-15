/**
 * ============================================================
 *  app.js —— 界面的大脑
 * ============================================================
 *  负责：响应用户操作 → 调用主进程拿数据 → 把数据画成界面
 *
 *  阅读顺序建议：
 *    第 1 部分  工具函数
 *    第 2 部分  全局状态与存档
 *    第 3 部分  播放核心
 *    第 4 部分  各个页面的渲染
 *    第 5 部分  事件绑定
 *    第 6 部分  启动
 * ============================================================
 */

/* ============================================================
   第 1 部分：工具函数
   ============================================================ */

const $ = (id) => document.getElementById(id);

/**
 * 生成一个图标。
 * 图标形状都定义在 index.html 顶部的"图标库"里（<symbol id="i-xxx">），
 * 这里只是把它取出来用 —— <use> 引用同一个定义，不会重复画。
 *
 *   ic('i-play')          → 播放图标
 *   ic('i-loading','spin')→ 加载图标，并且转起来
 */
function ic(name, extraClass) {
  return `<svg class="ic${extraClass ? ' ' + extraClass : ''}"><use href="#${name}"/></svg>`;
}

/* "正在播放"那行的小动效：三根上下跳的柱子。
   ★ v2.0.0（L2）：从 SVG 的 <rect> 换成普通 <i>。
     原因：Chromium 里 SVG 的 transform 动画**不走合成器**，是每帧重新光栅化（贵）；
     普通元素 + transform 才走合成器，每帧只移动图层、不重绘。观感一模一样，成本降一个量级。
     它同样没放进图标库 —— 动画需要 CSS 精确选中里面每一根柱子，
     而 <use> 引用的内容在"影子树"里，外面的 CSS 选不中它。 */
const BARS_ICON = `<span class="ic bars" aria-hidden="true"><i></i><i></i><i></i></span>`;

/** 秒 → "3:45" */
function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** HTML 转义，防止标题里的特殊字符破坏页面结构 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
/** 屏幕下方弹一句提示 */
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/**
 * 调用主进程提供的接口。
 * 主进程统一返回 {ok, data} 或 {ok:false, error}，这里自动解包，
 * 出错就直接抛出，由调用处 catch 后提示用户。
 */
async function api(name, ...args) {
  const res = await window.neko[name](...args);
  if (!res.ok) {
    const e = new Error(res.error || '操作失败');
    // ★ reason 必须一起带出来：主进程用它区分"没填Cookie / 没字幕 / 被限流"，
    //   界面要据此显示不同的提示文案。漏掉的话所有失败都会退化成同一句。
    if (res.reason) e.reason = res.reason;
    throw e;
  }
  return res.data;
}

/** 生成一个简单唯一 id */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ============================================================
   第 2 部分：全局状态与存档
   ============================================================ */

// 存档数据：歌单、收藏、历史、外观设置
let DB = {
  playlists: [], favorites: [], history: [], lastTrack: null,
  // v2.8.0：本地歌曲库。下载完成的会自动进来（受 settings.download.autoAddToLocal 控制），
  // 手动导入的（导入歌曲 / 导入文件夹）也进这儿。
  // 条目形状见 renderLocal() 上面的注释 —— 渲染时会被适配成 track 形状。
  local: [],
  settings: {
    theme: 'pink',
    volume: 80,
    bg:    { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
             pauseOnBlur: true },
    glass: { blur: 12, frameAlpha: 0.12, mode: 'prebake' },
    autoLyric: false,
  },
};

// 当前播放队列
let queue = { tracks: [], index: -1, name: '' };

/* ---------- 下载的界面侧状态（v2.8.0）----------
   ★ 任务的**唯一 owner 是主进程**（它把状态写在 downloads.json 里）。
     下面这几个变量只是一份"用来画面的镜像"：界面从不自己改任务状态，
     一律发指令 → 等主进程推 download:changed → 再重画。
     这样即便界面崩溃重开，看到的也永远是主进程那份真状态。 */
let dlTasks = [];          // 全部任务（镜像）
let dlStats = null;        // { done, running, failed, queued, paused, bytes, total }
let dlDir = null;          // 主进程当前的下载目录（null = 还没选过）
let dlFilter = 'all';      // 下载管理页当前筛的是哪一类：all / doing / done / failed

/* 「已下载」的 key 集合（`bvid:cid`）。trackRow 每画一行都要查一次，
   如果每次都去遍历 DB.local（可能上万条）+ 任务表，就是 O(n²)。
   所以只在这些东西变化时重算一次，见 rebuildDlKeys()。 */
let dlKeys = new Set();

/* 「批量下载」的勾选模式（我喜欢 / 歌单的工具条点进去）。
   ★ 为什么不复用 impState：那是「导入我的 B 站收藏夹」的状态机，带着 step / folders /
     source 一整套；这里只要一个选择集。
     但**选择集的形状故意做成一样的**（Map<bvid, track>），
     这样 trackRow 里那套"按 bvid 反查勾没勾上"的渲染分支可以原样共用。 */
let dlPick = null;         // { selected: Map<bvid, track> }；null = 不在勾选模式

/* ★ v2.0.4：给每次"切歌"发一个序号。
   为什么需要它：playAt() 里有两段 await（补 cid、取音频地址），期间用户完全可能
   又点了另一首 —— 两个 playAt 会**叠在一起**跑。后一个一旦把 audio.src 换掉，
   前一个还挂着的 audio.play() 就会被浏览器打断并抛
   "The play() request was interrupted by a new load request"。
   那既不是"取地址失败"，也不该弹提示、更不该自动跳下一首。
   有了序号，旧的请求回来时一看序号变了就直接放弃，一声不吭。 */
let playSeq = 0;

/* ★ v2.0.5：最后一次写进 audio.src 的地址。
   用途：给"这次播放请求已经过期"再加一道**不依赖错误消息文字**的闸门 ——
   只要地址已经不是我们刚设的那条，就说明中间有人换过歌，本次的失败一律静默。
   （为什么不直接读 audio.src 来比：浏览器会对 URL 做规范化，比字符串容易误判。） */
let lastSetSrc = '';

/** 这个播放错误是不是"被新的播放请求打断了"（不是真失败，静默忽略）。
 *
 *  ★ v2.0.5 加固：以前只认两条固定的英文句子。但实测发现 Chromium 会在这类消息
 *  **末尾附上媒体地址**（Neo 的截图里就是 "…new load request." 换行后跟一个 URL），
 *  句子本身没变、但整串不再相等 —— 所以这里一律用"包含"判断，并且放宽到
 *  `interrupted by`（既覆盖 "a new load request" 也覆盖 "a call to pause"）。
 *  宁可把"打断"判宽一点（它本来就该静默），也不要漏掉一条又弹一次吓人的提示。 */
function isPlayInterrupted(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /interrupted by|The play\(\) request was interrupted/i.test(String(err.message || err));
}

/** 把 Chromium 附在消息末尾的媒体地址剪掉，弹提示时只显示原因本身。
 *  （否则 toast 里会挂一行又长又难看的 URL，Neo 截图里就是这样。） */
function cleanPlayError(err) {
  const msg = String((err && err.message) || err || '').trim();
  const cut = msg.replace(/\s*https?:\/\/\S+\s*$/i, '').trim();
  return cut || '这首歌的音频地址取不到，换一首试试';
}

/** 播放条那几个按钮直接调 audio.play() 时用这个包一层。
 *  原因：play() 返回的是一个 promise，如果此刻正好有"上一次还没走完的播放请求"，
 *  它会以 AbortError 拒绝 —— 没人接就变成一条"未处理的 promise 拒绝"，控制台一片红。
 *  这里只把"被打断"吞掉（那是正常操作，不是故障），其它错误照旧打日志。 */
function safePlay() {
  const p = audio.play();
  if (p && typeof p.catch === 'function') {
    p.catch((e) => { if (!isPlayInterrupted(e)) console.error('播放出错', e); });
  }
}

/* ============================================================
   ★ v2.8.0 修订：播放断流自愈（真机反馈"放着放着一卡一卡，最后一直卡着"）
   ------------------------------------------------------------
   根因（探针 probe-stall.js 抓到的三条事实）：
     ① audio 只监听了 8 个事件，`stalled` / `waiting` / `progress` **一个都没监听**
        → 流断流时**没有任何自愈动作**，这正好是"一卡一卡 → 一直卡着"的来源。
     ② B 站音频地址带 `deadline=<unix秒>` 签名（有有效期），**地址拿到后就一直用到歌结束**，
        从不刷新。长时间播放 / 暂停很久再继续 → 地址中途过期 → 后续 Range 请求被拒
        → 缓冲耗尽 → stalled。拖进度条、重新点播用的**都是同一个已过期地址**
        → "同一位置卡死"。
     ③ 探针确认 `deadline` 能从地址里解析出来 —— 所以**预防 + 自愈两条都能做**。
        两者一起上：预防为主（到期前主动换地址），自愈兜底（真断了就重解析 + seek 回去）。
   ============================================================ */

/** 从 `bili://get?url=<编码过的真实地址>` 里把真实地址掏出来。掏不出来返回 ''。 */
function realUrlOf(src) {
  try {
    const u = new URL(String(src || ''));
    // bili:// 只是个壳，真实地址在 url 参数里（见 main.js 的 registerBiliProtocol）
    if (u.protocol === 'bili:') return u.searchParams.get('url') || '';
    return '';
  } catch (_) { return ''; }
}

/**
 * 从 audio.src 里解出这个地址的到期时刻（毫秒时间戳）。解不出来返回 0。
 * ★ 只认 `deadline` 那个参数 —— 它是 B 站签名的一部分，值就是 unix 秒。
 */
function srcDeadlineAt(src) {
  const real = realUrlOf(src);
  if (!real) return 0;
  try {
    const v = new URL(real).searchParams.get('deadline');
    const sec = Number(v);
    // 合理区间：2020-01 ~ 2100 年之间才认（防止把别的字段误当 deadline）
    if (!Number.isFinite(sec) || sec < 1.6e9 || sec > 4.1e9) return 0;
    return sec * 1000;
  } catch (_) { return 0; }
}

/* 自愈状态。★ 必须节流 —— 每次 waiting 都刷新地址会让弱网下疯狂重试、反而更卡。 */
let lastHealAt = 0;          // 上次自愈的时间戳（冷却用）
let healBusy = false;        // 一次只跑一个自愈
let deadlineTimer = null;    // 预防式刷新的定时器
const HEAL_COOLDOWN = 8000;  // 两次自愈之间至少隔 8 秒
const DEADLINE_MARGIN = 60000;  // 到期前 60 秒就主动刷新（留足重新解析 + 切换的时间）

/** 清掉预防式刷新的定时器（换歌 / 暂停 / 播完时调）。 */
function clearDeadlineTimer() {
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
}

/**
 * 重新解析当前这首歌的音频地址，把播放位置接回去继续播。
 *
 * @param {number} seq    本次播放的序号（自愈回来时若已换歌，直接放弃）
 * @param {'stalled'|'deadline'|'manual'} 因为什么触发
 * @param {number} [atSec] 想跳回的位置（不传就用当前 audio.currentTime）
 * @returns {Promise<boolean>} 是否成功接上
 *
 * ★ 关键步骤的顺序不能乱：
 *   先记住 currentTime（换 src 会把它清零）→ 再换 src → 等能播了（loadedmetadata/canplay）
 *   → seek 回原位置 → play()。少任何一步都会"从头开始播"或"跳回去又卡"。
 */
async function refreshAudioUrl(seq, reason, atSec) {
  if (healBusy) return false;
  const track = queue.tracks[queue.index];
  if (!track || !track.bvid || !track.cid) return false;
  if (seq !== playSeq) return false;                 // 已经换歌了，别抢

  healBusy = true;
  const resumeAt = Number.isFinite(atSec) ? atSec
                 : (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  const wasPlaying = !audio.paused;
  try {
    const info = await api('audioUrl', track.bvid, track.cid);
    if (seq !== playSeq) return false;               // 期间换歌了 → 放弃
    if (!info || !info.url) return false;

    // 换地址：先把"接回来的位置"挂上，等元数据到了再 seek
    audio.src = info.url;
    lastSetSrc = info.url;
    armDeadlineTimer(info.url, seq);

    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; cleanup(); resolve(); } };
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', fin);
        audio.removeEventListener('canplay', fin);
        clearTimeout(t);
      };
      // 最多等 6 秒 —— 等不到也别把自愈卡死在这儿
      const t = setTimeout(fin, 6000);
      audio.addEventListener('loadedmetadata', fin, { once: true });
      audio.addEventListener('canplay', fin, { once: true });
    });
    if (seq !== playSeq) return false;

    try { if (resumeAt > 0.5) audio.currentTime = resumeAt; } catch (_) { /* 跳不了就算了，从头放也比卡死强 */ }
    if (wasPlaying || reason !== 'manual') safePlay();
    updatePlayBtn();
    return true;
  } catch (err) {
    console.error('[播放自愈] 重新取地址失败', err);
    // 自愈失败就换下一首，别让用户对着一个卡死的播放器干等
    if (seq === playSeq && queue.tracks.length > 1) {
      toast('这一首播放中断了，换下一首');
      setTimeout(() => { if (seq === playSeq) next(1); }, 600);
    }
    return false;
  } finally {
    healBusy = false;
  }
}

/**
 * 给当前地址挂一个"到期前主动刷新"的定时器（预防）。
 * ★ 到期前 60 秒就换 —— 我们这边重新解析要一次网络往返，切 src 后还要等缓冲，
 *   留 60 秒比较稳；太晚（比如剩 5 秒）等于没预防。
 *   解析不出 deadline（0）就不挂定时器，交给 stalled 自愈兜底。
 */
function armDeadlineTimer(src, seq) {
  clearDeadlineTimer();
  const at = srcDeadlineAt(src);
  if (!at) return;
  const delay = at - Date.now() - DEADLINE_MARGIN;
  if (delay <= 0) return;                     // 已经快到期了 —— 等 stalled 自愈去处理
  // 上限 30 分钟：再长的 setTimeout 在系统休眠后不可靠，那时靠 stalled 兜底就行
  if (delay > 30 * 60 * 1000) return;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    if (seq !== playSeq) return;
    if (audio.paused) return;                 // 暂停着就别折腾，恢复播放时再想办法
    refreshAudioUrl(seq, 'deadline');
  }, delay);
}

/**
 * stalled / waiting 的统一处理：节流后自愈。
 * ★ 为什么要节流：弱网下 waiting 会连发几十次，每次都重解析地址 = 疯狂请求接口
 *   + 反复换 src，结果比原来更卡。冷却期内只允许自愈一次。
 */
function healOnStall() {
  if (healBusy) return;
  if (!audio.src) return;                     // 还没设过地址（比如刚换歌）→ 不是断流
  if (audio.paused) return;                   // 用户自己按了暂停 → 别自作主张
  const now = Date.now();
  if (now - lastHealAt < HEAL_COOLDOWN) return;
  lastHealAt = now;
  refreshAudioUrl(playSeq, 'stalled');
}


// 界面当前所处的页面，比如 'discovery' / 'search' / 'favorites' / 'history' / 'playlist:xxx'
// ★ 启动默认落在「发现」（一打开就有推荐，不用先看空搜索页）。
let currentView = 'discovery';

/** 把内存中的数据写到硬盘（每次改动后调用）。
 * ★ 必须走 api()：主进程统一把结果包成 {ok,data}，直接调 window.neko.saveData
 *   拿到的是外壳、ok 恒为 true，失败会被吞掉；走 api() 才会解包并在失败时抛错。
 *   存盘前先深拷贝一份快照，避免序列化过程中 DB 还在被改、写出半新半旧的数据。 */
let lastSaveErrorAt = 0;
async function persist() {
  try {
    const snapshot = JSON.parse(JSON.stringify(DB));
    await api('saveData', snapshot);
    return true;
  } catch (e) {
    console.error('保存失败', e);
    const now = Date.now();
    if (now - lastSaveErrorAt > 4000) {
      lastSaveErrorAt = now;
      toast('本机保存失败：' + (e.message || '请检查应用数据目录权限'));
    }
    return false;
  }
}

let persistTimer = null;
async function flushPersistence() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  return persist();
}

/**
 * "等一下再存"。拖滑杆时每一像素都会触发一次变更，
 * 要是每次都写盘，硬盘会被刷爆。攒 300 毫秒一起写就够了。
 */
function persistLater() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
}

/**
 * 下载设置的默认值（v2.8.0）。
 *
 * ★ 这 5 个值必须和主进程 `src/store-migrate.js` 的 `DEFAULT_DOWNLOAD` **逐字一致** ——
 *   两边都会往存档里补默认值（老存档打开时是 store-migrate 补、设置面板里改是这边补），
 *   写歪一个就会出现"设置里显示 2、实际跑 3"这种查不出来的怪事。
 *   `verify.js` 第 56 类会拿两个文件对一遍，防止以后改一边忘了另一边。
 *
 * dir 的语义：**null = 从没选过** → 第一次点下载时弹窗让用户选（Neo 明确要的行为）。
 */
const DOWNLOAD_DEFAULTS = {
  dir: null,            // 下载目录的绝对路径
  concurrent: 2,        // 同时下载几首（1~4）
  saveCover: true,      // 顺手把封面存到本地（离线也能看到封面）
  autoAddToLocal: true, // 下完自动进「本地歌曲」
  skipExisting: true,   // 本地库里已有的跳过，不重复下
};

/** 外观设置的默认值，用来给老存档补洞 */
const DEFAULT_SETTINGS = {
  theme: 'pink',
  volume: 80,
  bg:    { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
           pauseOnBlur: true },
  // glass.mode：面板毛玻璃三档 —— 'plain' 纯半透明 / 'prebake' 预先糊好的图（默认）/ 'live' 实时毛玻璃
  // glass.frameAlpha：四块面板的"比内容区多压多少"（v2.0.2 起取代旧的 alpha，四块面板共用同一个值）
  glass: { blur: 12, frameAlpha: 0.12, mode: 'prebake' },
  autoLyric: false,   // 自动加载歌词：默认关（用户可开，或手动点「词」）
  lyricWin: null,     // 桌面歌词悬浮窗的设置（默认由 DEFAULT_LYRIC_WIN 补）
  playMode: 'list',   // 播放模式：list 列表循环 / one 单曲循环 / shuffle 随机 / order 顺序
  // v2.1.0：窗口状态 —— 上次是不是 mini、mini 展开没展开、完整模式下的窗口位置尺寸。
  // 缺省全为"不是 mini"，所以老存档零迁移，行为和以前一模一样。
  window: { mini: false, fullBounds: null, miniExpanded: false },
  // v2.2.0：点 ✕ 想怎么关 —— 'ask' 每次询问 / 'quit' 彻底关闭 / 'tray' 缩小到任务栏。
  // ★ 缺省 'ask'：托盘图标是这一轮新加的，第一次关窗问一下最不容易出误会
  //   （用户以为关掉了、其实还在后台跑，或者反过来，两种都会挨骂）。
  close: { action: 'ask' },
  // v2.3.0：自定义快捷键。★ 只存"和默认不一样的那几条"（空对象 = 全用默认），
  // 所以老存档零迁移：没有这一项就是全默认，行为和以前一模一样。
  keys: {},
  // v2.8.0：下载。默认值抽在 DOWNLOAD_DEFAULTS 里（理由见那里的注释）。
  download: Object.assign({}, DOWNLOAD_DEFAULTS),
};

// 关窗行为的三种取值。★ 必须和主进程 src/app-menus.js 的 CLOSE_ACTIONS 一致
// （verify.js 会拿两边对一下，防止以后改一边忘了另一边）。
const CLOSE_ACTIONS = ['ask', 'quit', 'tray'];

/* ============================================================
   快捷键（v2.3.0）—— 一张表当唯一准绳
   ============================================================
   以前这 11 条是"一个功能一行 if"，写死在全局 keydown 里：
   加一条要改三处（if / 界面 / 存档），迟早漏一处。
   现在"加一条快捷键"= 在这张表里加一行，界面、存档、按键匹配全自动。

   ★ id 会存进存档（settings.keys[id]），所以**改 id = 老存档丢键位**，别随便动。
   ★ def 必须是"规范化之后"的写法（见 normalizeKeyName）：
       字母一律小写、空格写 Space、方向键写 ArrowLeft / ArrowRight / ArrowUp / ArrowDown。
     否则"存进去的是 Ctrl+d、默认写的是 Ctrl+D"，永远匹配不上。
   ★ Esc **故意不进表**：它是所有面板的逃生键，绑走了面板就关不掉。 */
const KEY_ACTIONS = [
  { id: 'togglePlay',       name: '播放 / 暂停', def: 'Space',           hint: '播放条中间那个按钮' },
  { id: 'prevTrack',        name: '上一首',     def: 'Ctrl+ArrowLeft',  hint: '' },
  { id: 'nextTrack',        name: '下一首',     def: 'Ctrl+ArrowRight', hint: '' },
  { id: 'seekBack',         name: '快退 5 秒',  def: 'ArrowLeft',       hint: '' },
  { id: 'seekFwd',          name: '快进 5 秒',  def: 'ArrowRight',      hint: '' },
  { id: 'volUp',            name: '音量 +5',    def: 'ArrowUp',         hint: '' },
  { id: 'volDown',          name: '音量 −5',    def: 'ArrowDown',       hint: '' },
  { id: 'toggleLyric',      name: '整页歌词',   def: 'Ctrl+d',          hint: '等于点播放条最左边那张封面' },
  { id: 'toggleDeskLyric',  name: '桌面歌词',   def: 'Ctrl+l',          hint: '等于点播放条上的「词」按钮' },
  { id: 'miniMode',         name: 'mini 模式',  def: 'Ctrl+m',          hint: '在完整模式和 mini 小窗之间切换' },
  { id: 'openSettings',     name: '打开设置',   def: 'Ctrl+,',          hint: '' },
  { id: 'fullscreen',       name: '全屏',       def: 'F11',             hint: '' },
];

/** 键位显示用的"人话"：Space → 空格、ArrowLeft → ← …（存档里存的还是 ArrowLeft 这种） */
const KEY_PRETTY = {
  Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Escape: 'Esc', Enter: '回车', Tab: 'Tab', Backspace: '退格',
};

/** 这是一个合法的播放模式吗（以 PLAY_MODES 为唯一准绳，避免两处清单对不上） */
function isPlayModeId(v) {
  return PLAY_MODES.some((m) => m.id === v);
}

/**
 * 补齐 / 夹住 `settings.download`（v2.8.0）。
 *
 * ★ 只做"值本身合不合法"，**不查目录在不在** —— 渲染层没有文件系统权限，
 *   而且同步查盘会卡住界面。目录是否还在，由主进程在真正下载时判（它会回 needDir）。
 *   主进程那份 store-migrate.js 里才做 `fs.existsSync` 的降级。
 */
function sanitizeDownload(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const n = Number(o.concurrent);
  return {
    // 空串 / 全是空格 = 没选过，一律归一成 null（不然会被当成一个合法目录传下去）
    dir: (typeof o.dir === 'string' && o.dir.trim()) ? o.dir.trim() : null,
    concurrent: Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : DOWNLOAD_DEFAULTS.concurrent,
    // 三个开关都只认"显式写了 false"才算关 —— 老存档没有这一项时必须是开，不能变成关
    saveCover: o.saveCover !== false,
    autoAddToLocal: o.autoAddToLocal !== false,
    skipExisting: o.skipExisting !== false,
  };
}

/** 补齐 DB.settings 里缺的字段（老版本存档没有这一项） */
function migrateSettings() {
  const old = (DB.settings && typeof DB.settings === 'object') ? DB.settings : {};
  DB.settings = {
    theme:  DEFAULT_SETTINGS.theme,
    volume: DEFAULT_SETTINGS.volume,
    bg:     Object.assign({}, DEFAULT_SETTINGS.bg,    old.bg    || {}),
    glass:  Object.assign({}, DEFAULT_SETTINGS.glass, old.glass || {}),
    autoLyric: typeof old.autoLyric === 'boolean' ? old.autoLyric : DEFAULT_SETTINGS.autoLyric,
    lyricWin: null,   // 下面单独补（要逐项夹范围，不能整块照抄）
    // 播放模式：老存档（以前是"随机开关 + 循环开关"两个字段）里没有这一项，就默认列表循环
    playMode: isPlayModeId(old.playMode) ? old.playMode : DEFAULT_SETTINGS.playMode,
    // v2.1.0：窗口状态（mini 模式 + 完整模式的窗口位置尺寸）。
    // 老存档没有这一项 → 补成缺省（非 mini），打开后的行为完全不变。
    window: {
      mini: !!(old.window && old.window.mini),
      miniExpanded: !!(old.window && old.window.mini && old.window.miniExpanded),
      fullBounds: (old.window && typeof old.window.fullBounds === 'object' && old.window.fullBounds)
        ? old.window.fullBounds : null,
    },
    // v2.2.0：关窗行为。老存档没有这一项 → 缺省"每次询问"（新加了托盘，第一次问一下最稳妥）。
    // 值不在三种里（存档被手改坏了）也回落到"每次询问"。
    close: {
      action: CLOSE_ACTIONS.includes(old.close && old.close.action) ? old.close.action : DEFAULT_SETTINGS.close.action,
    },
    // v2.3.0：自定义键位。★ 只认识"字符串"，别的（手改坏了的存档）一律丢掉回到默认，
    // 免得一个 null 让 keyOf() 后面的比较全乱套。
    keys: sanitizeKeys(old.keys),
    // v2.8.0：下载设置。老存档没有这一项 → 全默认（dir 为 null，第一次下载时才问）。
    download: sanitizeDownload(old.download),
  };
  if (typeof old.theme === 'string') DB.settings.theme = old.theme;
  if (typeof old.volume === 'number') DB.settings.volume = old.volume;

  // 背景：老存档只有 {file, dim, blur}，没有 kind / video —— 补默认值。
  //   kind 缺省 = 'image' → 行为跟以前完全一样（旧存档零迁移）；
  //   video 子项逐项夹住，防止存档被手改成 speed=999 这种离谱值。
  const bgv = (DB.settings.bg.video && typeof DB.settings.bg.video === 'object') ? DB.settings.bg.video : {};
  DB.settings.bg.kind = DB.settings.bg.kind === 'video' ? 'video' : 'image';
  DB.settings.bg.video = {
    muted: bgv.muted !== false,   // 默认静音（避免背景视频的声音跟歌打架）
    loop:  bgv.loop  !== false,   // 默认循环
    speed: (typeof bgv.speed === 'number' && bgv.speed >= 0.5 && bgv.speed <= 2) ? bgv.speed : 1,
  };
  // "窗口不在前台时暂停"（老存档没有 → 默认开）
  DB.settings.bg.pauseOnBlur = DB.settings.bg.pauseOnBlur !== false;
  // ★ v2.0.0：老存档里的 bg.perfLite（「降低毛玻璃（省显卡）」开关）被「面板毛玻璃三档」取代。
  //   按 Neo 拍板：**一律迁到 'prebake'（省显卡档）** —— 包括当年主动关过 perfLite 的。
  //   不这样切，老用户永远拿不到这次优化。想换档，去设置里勾一下即可（勾「实时毛玻璃」会有提醒）。
  const gm = old.glass && old.glass.mode;
  DB.settings.glass.mode = (gm === 'plain' || gm === 'live') ? gm : DEFAULT_SETTINGS.glass.mode;
  // ★ v2.0.2：面板不透明度收敛成 glass.frameAlpha（--frame-a），取代旧的 glass.alpha。
  //   老存档没有这一项 → 用新默认 0.12。**故意让老存档也走新默认**：
  //   旧观感（四块面板 47%~75% 深色、互不一致）正是这次要修的问题。
  const fa = DB.settings.glass.frameAlpha;
  DB.settings.glass.frameAlpha = (typeof fa === 'number' && isFinite(fa))
    ? Math.max(0, Math.min(0.4, fa)) : DEFAULT_SETTINGS.glass.frameAlpha;
  delete DB.settings.glass.alpha;   // 字段退役：别在存档里留一个没人再读的旧值
  delete DB.settings.bg.perfLite;   // 字段退役：别在存档里留一个没人再读的旧值

  // 桌面歌词的设置：老存档没有，就给一套默认值；有就逐项夹到合法范围，
  // 防止存档被手改过之后字号变成 999、不透明度变成 -3 这种离谱值。
  const w = (old.lyricWin && typeof old.lyricWin === 'object') ? old.lyricWin : {};
  const clampNum = (v, lo, hi, dft) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, Math.round(v))) : dft;
  // 老版本存档（没有 barScale 这一项）里如果还停在旧的默认字号 22，就升到新的默认 28 ——
  // 字号默认值调大过，不这样处理，老用户会觉得"我明明没改过怎么还是小字"。
  const isOldFormat = (typeof w.barScale !== 'number');
  const oldFontSize = (isOldFormat && w.fontSize === 22) ? DEFAULT_LYRIC_WIN.fontSize : w.fontSize;
  DB.settings.lyricWin = {
    on: w.on === true,
    x: typeof w.x === 'number' && isFinite(w.x) ? w.x : null,
    y: typeof w.y === 'number' && isFinite(w.y) ? w.y : null,
    fontSize: clampNum(oldFontSize, 14, 72, DEFAULT_LYRIC_WIN.fontSize),
    opacity:  clampNum(w.opacity,  30, 100, DEFAULT_LYRIC_WIN.opacity),
    lines:    w.lines === 1 ? 1 : 2,
    barScale: clampNum(w.barScale, 80, 180, DEFAULT_LYRIC_WIN.barScale),
    bgStyle:  (w.bgStyle === 'card') ? 'card' : 'none',
    locked:       w.locked === true,
    clickThrough: w.clickThrough === true,
  };
}

/* ============================================================
   prebake 档：预先糊好的壁纸图（--glass-img）
   ------------------------------------------------------------
   为什么可以"预先糊"：backdrop-filter 做的就是把"面板背后那块"糊一遍。
   当面板背后是一张**不动的壁纸**时，"实时糊"和"预先糊"算出来的是同一张图 ——
   那就干脆只算一次，存成 data:URL 反复用，把"每帧重算"这条最贵的路彻底拿掉。
   真正的差别只在"有内容从面板背后经过（滚动）"时才出现，而当前布局没有这种情况。

   生成时机：换背景图 / 拖动「毛玻璃强度」/ 窗口尺寸变化超过 15%。
   ★ 拿不到 canvas、或 ctx.filter 不被支持、或画布被跨域污染时一律返回 null，
     调用方会自动降级为"纯半透明"（不会白屏，也不会偷偷退回实时毛玻璃）。
   ============================================================ */
const glassImgState = { url: 'none', file: '', blur: -1, w: 0, h: 0, token: 0 };
let glassImgTimer = null;

/** 读一张图（带 crossOrigin，避免画进 canvas 后"污染画布"） */
function loadImageEl(src) {
  return new Promise((resolve) => {
    const im = new Image();
    // ★ bg:// 协议回了 Access-Control-Allow-Origin:*，但必须带 crossOrigin 去请求，
    //   画进 canvas 才不会污染画布 —— 否则 toDataURL() 会直接抛 SecurityError。
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/** 真的去糊一张图，返回 data:URL（失败返回 null） */
async function buildGlassImage(file, blur) {
  const img = await loadImageEl(`bg://local/${file}`);
  if (!img || !img.width || !img.height) return null;

  const W = Math.max(1, window.innerWidth);
  const H = Math.max(1, window.innerHeight);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.filter !== 'string') return null;   // 不支持 ctx.filter → 降级

  // 往外多画一圈（pad），免得模糊在窗口边缘"糊出一圈透明"。
  const pad = Math.round(blur * 2 + 4);
  const bw = W + pad * 2, bh = H + pad * 2;
  const scale = Math.max(bw / img.width, bh / img.height);   // cover：等比放大到至少铺满，再居中裁切
  const dw = img.width * scale, dh = img.height * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;

  try {
    ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.filter = 'none';
    return canvas.toDataURL('image/jpeg', 0.86);
  } catch (e) {
    return null;   // 画布被污染 / 编码失败 → 降级
  }
}

/**
 * 按需生成 / 丢弃 --glass-img。prebake 档 + 图片背景才需要，其余情况一律清空。
 * 不阻塞调用方（生成是异步的，慢个几十毫秒也没关系）。
 */
function syncGlassImage() {
  const s = DB.settings;
  const mode = (s.glass.mode === 'plain' || s.glass.mode === 'live') ? s.glass.mode : 'prebake';
  const want = mode === 'prebake' && !!s.bg.file && s.bg.kind !== 'video';   // 视频没法预先糊

  if (!want) {
    clearTimeout(glassImgTimer);
    if (glassImgState.url !== 'none' || glassImgState.file) {
      glassImgState.url = 'none'; glassImgState.file = ''; glassImgState.blur = -1;
      glassImgState.token++;
      document.documentElement.style.setProperty('--glass-img', 'none');
    }
    document.body.classList.remove('has-imgbg');
    return;
  }

  const file = s.bg.file;
  const blur = Number(s.glass.blur) || 0;
  const st = glassImgState;

  // 已经是最新的一张？文件没换、模糊没改、窗口尺寸变化也没超过 15% → 直接复用。
  // （失败过也算"已处理过"，不反复重试，免得一直白烧 CPU。）
  const sizeOk = st.w > 0 &&
    Math.abs(window.innerWidth - st.w) / st.w <= 0.15 &&
    Math.abs(window.innerHeight - st.h) / st.h <= 0.15;
  if (st.file === file && st.blur === blur && sizeOk) {
    document.body.classList.toggle('has-imgbg', st.url !== 'none');
    return;
  }

  const token = ++st.token;
  // ★ 先判断"是换图/换尺寸（要立刻重生成）"还是"只拖了强度滑杆（防抖 300ms）"，
  //   再写回 st —— 顺序反了的话 st.file 已经等于 file，永远判成"没换图"。
  const fileOrSizeChanged = st.url === 'none' || st.file !== file || !sizeOk;
  st.file = file; st.blur = blur; st.w = window.innerWidth; st.h = window.innerHeight;

  const run = () => {
    buildGlassImage(file, blur).then((url) => {
      if (token !== st.token) return;   // 期间又换过图 / 改过强度 → 丢弃这次结果
      st.url = url || 'none';
      // ★ 必须包成 url("…") 再写进自定义属性：
      //   data:image/jpeg;base64,… 里那个**分号**会让整条 CSS 声明被判非法、被静默丢掉
      //   （表现就是 has-imgbg 打了、--glass-img 却还是 none）。包进带引号的 url() 里，
      //   分号落在字符串内部，才是合法的值。
      document.documentElement.style.setProperty('--glass-img', url ? `url("${url}")` : 'none');
      // 糊好了才打 has-imgbg；失败就退回纯半透明（而不是留一块空面板）
      document.body.classList.toggle('has-imgbg', !!url);
    });
  };

  clearTimeout(glassImgTimer);
  if (fileOrSizeChanged) run();
  else glassImgTimer = setTimeout(run, 300);   // 只是拖强度滑杆：攒 300ms 再糊一次
}

/** 把 DB.settings 里的外观设置"刷"到界面上 */
function applyAppearance() {
  const s = DB.settings;
  const root = document.documentElement;

  // 1) 主题（给 <html> 打标记，CSS 里的 [data-theme="xxx"] 就会生效）
  root.dataset.theme = s.theme || 'pink';
  // 背景压暗是全局设置：放在 <html> 上，让壁纸底层与 prebake 面板背景都能读取。
  root.style.setProperty('--bg-dim', String(s.bg.dim ?? 0.55));

  // 2) 毛玻璃：三档（plain 纯半透明 / prebake 预先糊好的图 / live 实时毛玻璃）
  //    三档共用 --glass-blur；区别只在"面板到底用不用真 backdrop-filter"，
  //    那是靠 <body> 上的类 + CSS 决定的（见 style.css 的「面板毛玻璃三档」）。
  root.style.setProperty('--glass-blur', (s.glass.blur ?? 12) + 'px');
  // ★ v2.0.2：四块面板的不透明度统一成 --frame-a（以前是 --glass-alpha + 每块各一个偏移量）。
  //   写在 <html> 上，让 prebake 的多层背景（也拿 --frame-a 当上层暗罩）读到同一个值。
  root.style.setProperty('--frame-a', String(s.glass.frameAlpha ?? 0.12));
  const glassMode = (s.glass.mode === 'plain' || s.glass.mode === 'live') ? s.glass.mode : 'prebake';
  document.body.classList.toggle('glass-live',    glassMode === 'live');
  document.body.classList.toggle('glass-prebake', glassMode === 'prebake');
  document.body.classList.toggle('glass-plain',   glassMode === 'plain');

  // 3) 背景：图片走 .bg-image 的 CSS 背景（--bg-image），视频走 <video id="bgVideo">；同一时刻只用一种
  const layer = $('bgLayer');
  if (layer) {
    const has = !!s.bg.file;
    const isVideo = has && s.bg.kind === 'video';
    const isImage = has && !isVideo;

    layer.style.setProperty('--bg-image', isImage ? `url("bg://local/${s.bg.file}")` : 'none');
    // blur(0px) 会让多余的图层一直占着显卡，直接用 none 更省
    const b = Number(s.bg.blur) || 0;
    layer.style.setProperty('--bg-blur', b > 0 ? b + 'px' : '0px');
    // ★ 模糊只挂到"只管图片"的 .bg-image 上，绝不再挂到含视频的整层上 ——
    //   挂整层的话每解码一帧都要把视频一起重糊，是显卡被打满的元凶之一。
    const img = $('bgImage');
    if (img) img.style.filter = b > 0 ? `blur(${b}px)` : 'none';

    // 面板毛玻璃的"预先糊好的图"（prebake 档专用）：按需生成 / 丢弃 --glass-img。
    // 放在这里是因为它依赖 bg.file / bg.kind，和上面的背景设置是同一件事。
    syncGlassImage();

    // 视频：显示/隐藏 + 把静音/循环/速度刷上去；播不播统一交给"该停就停"总闸判定
    const v = $('bgVideo');
    if (v) {
      if (isVideo) {
        const vv = s.bg.video || {};
        const url = `bg://local/${s.bg.file}`;
        if (v.getAttribute('src') !== url) v.setAttribute('src', url);
        v.muted = vv.muted !== false;
        v.loop  = vv.loop  !== false;
        v.playbackRate = (typeof vv.speed === 'number' && vv.speed > 0) ? vv.speed : 1;
        v.classList.add('on');
      } else {
        v.classList.remove('on');
      }
    }
    updateBgVideoPlayback();

    document.body.classList.toggle('has-bg', has);
  }

  // 4) 主题换了，桌面歌词悬浮窗的"当前句"颜色也要跟着换
  pushLyricStyle();
}

/* ---------- 动态背景的"该停就停"总闸 ----------
   毛玻璃（backdrop-filter）压在会动的画面上时，每一帧都要重新采样 + 重新模糊，
   显卡就是这么被吃掉的。所以只要视频"没人看得见"或"不该动"，就果断停掉。

   汇总所有"现在不该播"的理由，任一成立就暂停，全不成立才恢复播放：
     1) 当前根本不是动态背景（图片 / 无背景）
     2) 窗口被最小化 / 切到后台（document.hidden）
     3) 窗口失焦（切到别的软件，窗口还露着）—— 可在设置里关掉
     4) 有遮罩盖在界面上（设置面板 / 合集面板 / 队列抽屉 / 输入框弹窗）
   任何一个"理由"发生变化时，调用它重算一次即可。 */
let winFocused = true;   // 窗口是否在前台（由 blur / focus 事件维护）

/** 界面上是否正盖着某个遮罩（这些遮罩都靠加 .show 类来显示） */
function bgOverlayOpen() {
  return ['modalMask', 'collectMask', 'queueMask', 'promptMask'].some((id) => {
    const el = $(id);
    return !!(el && el.classList.contains('show'));
  });
}

/**
 * 省显卡：把"看不见的动画"停掉（v2.0.0 的 L1 / S3）。
 *
 * backdrop-filter 之所以贵，是因为"合成器一直在产帧"，而产帧的源头是**动画**。
 * 所以只要会动的东西被盖住、用户看不见，就应该暂停它 —— 这是纯赚的优化：
 *   · has-overlay —— 模态遮罩盖住整块界面（设置 / 选集 / 队列 / 弹窗）：
 *                    暂停遮罩后的内容区动画与加载转圈。
 *   · lyric-open  —— 整页歌词开着：只盖住内容区，播放条还看得见，
 *                    暂停内容区的跳动柱子与加载转圈。
 *   · perf-idle   —— 窗口失焦 / 最小化 / 切后台：暂停性能规则覆盖的内容区动画与加载转圈。
 *   播放条封面不再有旋转弧线；播放状态由播放 / 暂停按钮表示。
 *
 * CSS 侧在 style.css 的「省显卡：把"看不见的动画"停掉」一节。
 */
function syncPauseClasses() {
  const ly = $('lyricOverlay');
  document.body.classList.toggle('has-overlay', bgOverlayOpen());
  document.body.classList.toggle('lyric-open', !!(ly && ly.classList.contains('show')));
  document.body.classList.toggle('perf-idle', document.hidden || !winFocused);
}

function updateBgVideoPlayback() {
  // 顺手把"看不见就别动"的三个类也刷一遍 —— 它和"视频该不该播"用的是同一批触发点
  // （失焦 / 回焦 / 最小化 / 遮罩开合），放一起不会漏。
  syncPauseClasses();

  const v = $('bgVideo');
  if (!v) return;
  const s = DB.settings;
  const isVideo = s.bg.kind === 'video' && !!s.bg.file;
  const shouldPause =
    !isVideo ||
    document.hidden ||
    (s.bg.pauseOnBlur !== false && !winFocused) ||
    bgOverlayOpen();

  if (shouldPause) {
    try { v.pause(); } catch (e) { /* 还没设过 src 时忽略 */ }
    return;
  }
  // 静音视频一般能自动播；万一被拦（比如系统策略），忽略即可 —— 用户点一下界面就会开始
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
}

/**
 * 读一下这段视频的分辨率，太大就提示用户换更省的素材。
 * 只做提示，**不做自动转码** —— 那要打包 ffmpeg，安装包会大几十 MB，不划算。
 * 读不到（解码器缺失 / 超时）就返回 null，静默放过，绝不挡流程。
 */
function probeVideoSize(file) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      probe.removeAttribute('src');
      resolve(res);
    };
    probe.addEventListener('loadedmetadata', () => finish({ w: probe.videoWidth, h: probe.videoHeight }));
    probe.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 4000);   // 兜底：别让提示卡住界面
    probe.src = `bg://local/${file}`;
  });
}

/* ============================================================
   第 3 部分：播放核心
   ============================================================ */

const audio = $('audio');

/**
 * 播放条上那个大按钮的图标，**只由这一个函数决定**。
 *
 * 规则只有一条：图标 = "现在到底在不在播"。
 *   audio.paused === true  → ▶（播放）
 *   audio.paused === false → ‖（暂停）
 *
 * ★ 为什么要有这个函数（v2.0.0 修的 bug）：
 *   以前在 waiting（缓冲）事件里把按钮换成"转圈"，却没有任何地方负责把它换回来 ——
 *   play 事件只在"开始播"那一刻触发一次，缓冲结束后触发的是 playing，而项目里根本没有
 *   playing 监听。于是只要缓冲发生一次（网络音频非常常见），按钮就永远停在转圈。
 *   现在按 Neo 的要求：**不转圈，直接显示 ‖**。加载中的视觉反馈用"图标不变"来兜底，
 *   不会出现"卡住"的错觉。
 */
function updatePlayBtn() {
  const b = $('btnPlay');
  if (!b) return;
  b.innerHTML = audio.paused ? ic('i-play') : ic('i-pause');
  // ★ v2.2.0：播放状态一变就告诉主进程 —— 托盘菜单里那项要"播放 ⇄ 暂停"，
  //   任务栏缩略图按钮也要换 ▶ / ‖ 图标。这里正是"播放状态刚变"的那个时机。
  reportUiState();
}

/**
 * 播放模式：四种，用一个按钮循环切换。
 * 以前是「随机」+「循环」两个独立按钮（能同时点亮，语义互相打架），现在合成一个状态机：
 *   list    列表循环：播完最后一首回到第一首（默认）
 *   one     单曲循环：一首反复播
 *   shuffle 随机播放：下一首从队列里随机挑
 *   order   顺序播放：播完最后一首就停
 */
const PLAY_MODES = [
  { id: 'list',    icon: 'i-repeat',  name: '列表循环' },
  { id: 'one',     icon: 'i-repeat1', name: '单曲循环' },
  { id: 'shuffle', icon: 'i-shuffle', name: '随机播放' },
  { id: 'order',   icon: 'i-order',   name: '顺序播放' },
];
let playMode = 'list';

/**
 * 播放顺序栈：记"刚才播的是队列里第几个"。
 * 随机模式下"上一首"就靠它回退到真正听过的那首（不然随机模式里的上一首没有意义）。
 */
let playStack = [];

/** 设置播放模式并刷新按钮外观（save=true 时写进存档，下次打开还是这个模式） */
function setPlayMode(id, save) {
  const m = PLAY_MODES.find((x) => x.id === id) || PLAY_MODES[0];
  playMode = m.id;
  const btn = $('btnMode');
  if (btn) {
    btn.innerHTML = ic(m.icon);
    btn.title = `播放模式：${m.name}（点击切换）`;
    // 顺序播放 = 什么循环都没开，不强亮；其余三种都点亮，一眼能看出"开着点什么"
    btn.classList.toggle('on', m.id !== 'order');
  }
  if (save) { DB.settings.playMode = m.id; persistLater(); }
  reportUiState();   // ★ v2.2.0：托盘菜单里「播放模式 ▸」那个打勾要跟着变
}

/**
 * 判断两首歌是不是同一首。
 * B 站的歌用 `bvid + cid` 当身份证；本地歌（导入的、下载落地的）**没有 bvid/cid**，
 * 所以拿**文件绝对路径**当身份证。这条分支只动这一个函数，
 * 收藏 / 历史 / 队列 / "正在播放"高亮全靠它，扩在这里等于让本地歌白蹭整套现有逻辑。
 */
function sameTrack(a, b) {
  if (!a || !b) return false;
  // ★ v2.8.0：本地歌用路径判等。两边都有 localPath 才算同一首；
  //   一边有、一边没有 → 一定不是同一首（B 站歌和本地歌永远不撞）。
  if (a.localPath || b.localPath) return !!a.localPath && a.localPath === b.localPath;
  return a.bvid === b.bvid && String(a.cid) === String(b.cid);
}

function isFav(track) {
  return DB.favorites.some((t) => sameTrack(t, track));
}

/** 同一个cid 的补齐请求只发一次，避免播放和取歌词同时触发两次网络请求 */
const cidInFlight = new Map();
async function ensureCid(track) {
  if (track.cid) return track.cid;

  const key = track.bvid;
  if (cidInFlight.has(key)) {
    const cid = await cidInFlight.get(key);
    track.cid = cid;
    return cid;
  }

  const p = (async () => {
    const info = await api('videoInfo', track.bvid);
    const pg = info.pages && info.pages[0];
    if (!pg) throw new Error('这个视频没有可播放的内容');
    if (!track.duration) track.duration = pg.duration;
    if (!track.author) track.author = info.owner.name;
    // 记下 UP 主的 uid：有了它，列表里的作者名才能点开"这个 UP 的全部视频"
    if (!track.mid && info.owner && info.owner.mid) track.mid = info.owner.mid;
    if (!track.cover) track.cover = info.cover;
    // ★ v2.2.1：这个 bvid 要是"存过曲目表的合集"，顺手把封面记进 collectCovers。
    //   曲目表（DB.collectParts）是**故意剥掉封面**存的 —— 上百集的长链接会把存档撑大，
    //   所以列表 / 播放条要用的封面只能靠 collectCovers 里这单独的一条。
    //   老存档里它是空的（v2.0.5 只在"重新拉一遍曲目表"时才写，缓存过的合集走不到），
    //   在这里补上，等于让老存档自己长好。
    if (track.cover && DB.collectParts && DB.collectParts[track.bvid]) {
      if (!DB.collectCovers) DB.collectCovers = {};
      if (DB.collectCovers[track.bvid] !== track.cover) {
        DB.collectCovers[track.bvid] = track.cover;
        collectCoverMemo.delete(track.bvid);
        persistLater();
      }
    }
    return pg.cid;
  })();

  cidInFlight.set(key, p);
  try {
    const cid = await p;
    track.cid = cid;
    return cid;
  } finally {
    cidInFlight.delete(key);
  }
}

/**
 * 把一首歌的封面贴到播放条左边那块上（没封面就显示音符兜底）。
 *
 * ★ v2.2.1 抽出来的：以前这段只写在 playAt 里、而且**只在开播那一刻贴一次**。
 *   但很多歌的封面是**后到的** —— 搜索来的单曲、合集里的某一集，都要等
 *   ensureCid() 去 B 站查一次 videoInfo 才知道封面（见 ensureCid 里的
 *   `if (!track.cover) track.cover = info.cover`）。查回来时 playAt 早把
 *   "没封面"那版画上去了，于是播放条一直挂着音符兜底 —— 看着就像"合集没封面"。
 *   现在抽成一个函数，封面什么时候到就什么时候贴一次。
 */
function applyTrackCover(track) {
  const el = $('npCover');
  if (!el) return;
  if (track && track.cover) {
    el.style.backgroundImage = `url("${track.cover}")`;
    el.style.backgroundSize = 'cover';
  } else {
    // ★ v2.0.5：没有封面时不再塞 'none'（那会盖掉 CSS 里的音符兜底），
    //   改成清空行内样式 + 挂 .no-art 类，由 CSS 显示一个淡淡的音符。
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
  }
  el.classList.toggle('no-art', !(track && track.cover));
}

/**
 * 播放队列里的第 index 首
 */
async function playAt(index) {
  if (index < 0 || index >= queue.tracks.length) return;
  // 领一个序号：本次播放的唯一身份。中途用户换了歌（又调了一次 playAt），
  // 序号就会变，本次剩下的 await 回来时一律直接放弃（见 playSeq 的注释）。
  const seq = ++playSeq;
  queue.index = index;
  const track = queue.tracks[index];
  // ★ v2.8.0 修订：换歌先把上一首的"到期刷新"定时器和自愈冷却清掉 ——
  //   否则上一首挂的定时器会在新歌上触发一次多余的地址刷新。
  clearDeadlineTimer();
  lastHealAt = 0;

  // 更新底部播放条的外观（先显示信息，再慢慢加载音频）
  $('npTitle').textContent = track.title;
  $('npSub').textContent = track.author || (queue.name || 'B 站');
  applyTrackCover(track);
  $('btnFav').innerHTML = ic(isFav(track) ? 'i-heart-fill' : 'i-heart');
  $('btnFav').classList.toggle('on', isFav(track));
  // ★ 换歌不再先转圈：图标由 updatePlayBtn() 按"当前是否在播"决定。
  //   此刻若上一首还在播就显示 ‖、已停就显示 ▶，都跟真实状态一致。
  updatePlayBtn();
  // v2.8.0：下载按钮也跟着换歌变（没下过 = 箭头 / 在下 = 环形进度 / 下好 = 绿勾）
  syncDownloadBtn();
  $('timeTotal').textContent = fmtTime(track.duration);

  // 换歌了：清掉上一首的歌词（自动模式开着的话会顺手取新的）
  resetLyricsOnTrackChange();

  // 「打开视频」按钮：没有 bvid 就没有页面可开，置灰
  const openBtn = $('btnOpenBili');
  if (openBtn) openBtn.classList.toggle('disabled', !track.bvid);

  // ★★ v2.8.0 批次 B：本地歌（导入的 / 下载落地的）走这条**独立分支**。
  //   它们没有 bvid/cid，不能去问 B 站要地址，直接播 local:// 协议。
  //   `local://get?p=<绝对路径>` —— 主进程只放行"本地歌曲库里有的那几条路径"，
  //   所以这里必须 encodeURIComponent，路径里的反斜杠/空格/中文才不会把 URL 弄坏。
  if (track.localPath) {
    let myLocalSrc = '';
    try {
      myLocalSrc = 'local://get?p=' + encodeURIComponent(track.localPath);
      audio.src = myLocalSrc;
      lastSetSrc = myLocalSrc;
      audio.volume = (DB.settings.volume ?? 80) / 100;

      // 本地歌的时长常常是未知的（导入时拿不到）→ 加载出元数据后回填，
      // 写回 DB.local 那条，下次进来就有时长了。
      const onMeta = () => {
        audio.removeEventListener('loadedmetadata', onMeta);
        if (seq !== playSeq) return;
        if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
          if (!track.duration) track.duration = audio.duration;
          backfillLocalDuration(track.localPath, audio.duration);
          $('timeTotal').textContent = fmtTime(audio.duration);
        }
      };
      audio.addEventListener('loadedmetadata', onMeta);

      try {
        await audio.play();
      } catch (playErr) {
        if (isPlayInterrupted(playErr) || (myLocalSrc && lastSetSrc !== myLocalSrc)) return;
        throw playErr;
      }
      if (seq !== playSeq) return;   // 播放期间被切走 → 不记历史、不刷界面

      DB.history = [track, ...DB.history.filter((t) => !sameTrack(t, track))].slice(0, 100);
      DB.lastTrack = track;
      persistLater();
      renderAll();
    } catch (err) {
      if (seq !== playSeq || isPlayInterrupted(err) || (myLocalSrc && lastSetSrc !== myLocalSrc)) return;
      console.error('[播放失败]', (track && track.title) || '', err);
      // 本地文件找不到了（被挪走/删掉）→ 提示更具体，并顺手标记失效
      toast('本地文件打不开了：' + cleanPlayError(err));
      markLocalMissing(track.localPath);
      if (queue.tracks.length > 1) {
        setTimeout(() => { if (seq === playSeq) next(1); }, 900);
      }
    }
    return;
  }

  let mySrc = '';   // 本次给播放器设的地址（给 catch 里那道"过期"闸门用）
  try {
    // 如果这首歌还不知道自己的 cid（搜索来的），先查一次补上
    await ensureCid(track);
    if (seq !== playSeq) return;   // 期间已经切到别的歌了 → 放弃（别再动 audio.src）
    // ★ v2.2.1：ensureCid 顺手会把封面一起补上（它查的 videoInfo 里就有封面），
    //   所以补完要再贴一次。
    applyTrackCover(track);
    // ★★ 但合集里的歌走不到上面那条 —— 缓存下来的曲目表**自带 cid**，
    //    ensureCid 一开始发现"cid 已经有了"就直接早退，**根本不会去查 videoInfo**，
    //    封面也就永远拿不到（这正是"合集播放条没封面"的直接原因）。
    //    所以这里单独立一道：只要还没封面，就自己去补一次，补到就贴上。
    if (!track.cover) {
      backfillCover(track.bvid).then((cover) => {
        if (cover && seq === playSeq && !track.cover) {
          track.cover = cover;
          applyTrackCover(track);
        }
      });
    }

    // 关键一步：向主进程要音频地址。
    // B 站的真实地址带防盗链，主进程已经帮我们包装成 bili:// 内部地址。
    const info = await api('audioUrl', track.bvid, track.cid);
    if (seq !== playSeq) return;   // 同上：回来晚了就别再抢播放器

    audio.src = info.url;
    lastSetSrc = info.url;
    mySrc = info.url;
    audio.volume = (DB.settings.volume ?? 80) / 100;
    // ★ v2.8.0 修订：挂一个"到期前主动刷新"的定时器（预防式，见 armDeadlineTimer）
    armDeadlineTimer(info.url, seq);

    try {
      await audio.play();
    } catch (playErr) {
      // ★ "The play() request was interrupted by a new load request" 这类错误：
      //   是**用户换了歌**造成的（新的加载把上一次还没走完的 play() 打断了），
      //   不是"取音频地址失败"。旧版本会把它当失败弹提示、还会自动跳下一首 ——
      //   于是你明明已经听到歌在唱，却冒出一句吓人的"播放失败"，还可能莫名跳歌。
      //   两道闸门一起用：① 消息像"被打断"；② 我们**确实设过地址、而它已经被换掉**（不依赖消息文字）。
      //   注意 mySrc 为空表示"还没走到设地址那一步"（比如取地址就失败了），那种不算过期。
      if (isPlayInterrupted(playErr) || (mySrc && lastSetSrc !== mySrc)) return;
      throw playErr;
    }
    if (seq !== playSeq) return;   // 播放期间被切走 → 不记历史、不刷界面

    // 记入历史（同样的歌不重复记录，把它提到最前面）
    DB.history = [track, ...DB.history.filter((t) => !sameTrack(t, track))].slice(0, 100);
    DB.lastTrack = track;
    persistLater();

    renderAll();   // 刷新列表里的"正在播放"高亮
  } catch (err) {
    // 被换歌打断 / 已经是过期的那一次请求 → 静默放弃，不提示也不跳歌
    if (seq !== playSeq || isPlayInterrupted(err) || (mySrc && lastSetSrc !== mySrc)) return;
    // 真的失败了：控制台留下完整信息（含媒体地址，方便排查），提示条只显示原因本身
    console.error('[播放失败]', (track && track.title) || '', err);
    toast('播放失败：' + cleanPlayError(err));
    // 自动跳下一首，避免卡死在这一首（同样只在"还是当前这一次播放"时才跳）
    if (queue.tracks.length > 1) {
      setTimeout(() => { if (seq === playSeq) next(1); }, 900);
    }
  }
}

/** 切到队列里的第 index 首，并把"刚才那首"记进顺序栈（随机模式的"上一首"要用） */
function goTo(index) {
  if (index < 0 || index >= queue.tracks.length) return;
  if (index !== queue.index && queue.index >= 0) {
    playStack.push(queue.index);
    if (playStack.length > 100) playStack.shift();
  }
  playAt(index);
}

/** 顺序播放走到最后一首：停下（不绕回第一首） */
function stopAtEnd() {
  audio.pause();
  toast('已经是最后一首了（顺序播放）');
}

/** 切上一首 / 下一首 —— 具体怎么走由当前播放模式决定 */
function next(step) {
  const n = queue.tracks.length;
  if (!n) return;

  // 随机播放：下一首从队列里随机挑，连点也不会连着两次同一首
  if (playMode === 'shuffle' && step > 0) {
    if (n === 1) { playAt(0); return; }
    let i = queue.index;
    for (let guard = 0; guard < 20 && i === queue.index; guard++) i = Math.floor(Math.random() * n);
    goTo(i);
    return;
  }

  const i = queue.index + step;
  if (i >= n) {
    if (playMode === 'order') { stopAtEnd(); return; }
    goTo(0);
    return;
  }
  if (i < 0) {
    if (playMode === 'order') return;   // 顺序播放：第一首再往前也不绕到末尾
    goTo(n - 1);
    return;
  }
  goTo(i);
}

/** 「上一首」：随机模式按真正听过的顺序回退，其它模式按队列位置回退 */
function prevTrack() {
  if (playMode === 'shuffle') {
    while (playStack.length) {
      const i = playStack.pop();
      if (queue.tracks[i]) { playAt(i); return; }
    }
  }
  next(-1);
}

/**
 * 把一组曲目设为播放队列并开始播放。
 * ★ 队列存的是**副本**：源列表（收藏 / 歌单 / 搜索结果）之后怎么增删，
 *   都不会悄悄改掉正在播的这一份。想同步，重新点一次"播放全部"。
 */
function playTracks(tracks, startIndex = 0, name = '') {
  if (!tracks || !tracks.length) return false;
  queue = { tracks: tracks.slice(), index: -1, name };
  playStack = [];
  playAt(Math.max(0, startIndex));
  return true;
}


/* ============================================================
   第 4 部分：页面渲染
   ============================================================ */

const content = () => $('content');

/** 渲染一首歌的一行 */
function trackRow(track, i, opts = {}) {
  const playing = rowIsPlaying(track);
  const liked = isFav(track);
  // 长视频 / 疑似合集，在行上放一个「选集 N」小徽章当入口（详情见 expandCollection）
  // ★ v2.6.0：挑歌模式（opts.pick）下不画徽章 —— 那一行只留"勾选"一个交互，
  //   而且徽章会多占一列、把网格挤乱（pickable 只定义了四列）。
  const showBadge = !opts.pick && opts.expand !== false && maybeCollection(track);
  const badgeLabel = collectionBadgeLabel(track);

  // v2.6.0：这一行勾没勾上，从**选择集**反查（不是行自己的状态）——
  //   所以翻页 / 换收藏夹回来，勾选状态照样在，同一个视频也不会被算两次。
  // v2.8.0：下载的批量勾选复用同一套渲染，只是换了一个选择集（opts.pickSet）。
  //   不显式传就退回导入页那个 —— 这样导入页那三屏一个字都不用改。
  const pickSet = opts.pick ? (opts.pickSet || (impState && impState.selected) || null) : null;
  const picked = !!(pickSet && track.bvid && pickSet.has(track.bvid));

  // 作者名：知道 UP 的 mid 就做成可点的（点开看这个 UP 的全部视频），
  // 老数据 / 收藏夹导入来的没有 mid，就还是普通文字，不会点出个空页面。
  const authorHTML = track.author
    ? (track.mid
      ? `<span class="a-link" data-act="up" data-i="${i}" title="看 ${esc(track.author)} 的全部视频">${esc(track.author)}</span>`
      : esc(track.author))
    : '';

  return `
    <div class="track ${playing ? 'playing' : ''} ${opts.pick ? 'pickable' : ''} ${picked ? 'picked' : ''} ${track.missing ? 'missing' : ''}" data-i="${i}">
      ${opts.pick ? `<span class="pick${picked ? ' on' : ''}" role="checkbox" aria-checked="${picked ? 'true' : 'false'}" data-pick="${i}">${ic('i-check')}</span>` : ''}
      <div class="idx">${playing ? BARS_ICON : i + 1}</div>
      <div class="cover" style="background-image:url('${esc(track.cover || '')}')"></div>
      <div class="info">
        <div class="t">${esc(track.title)}</div>
        <div class="a">${authorHTML}</div>
      </div>
      ${track.missing ? `<span class="miss-chip">文件不见了</span>` : ''}
      ${showBadge ? `<button class="badge" data-act="expand" data-i="${i}" title="展开选集 / 合集">${badgeLabel}</button>` : ''}
      <div class="dur">${fmtTime(track.duration)}</div>
      <div class="ops">
        <button class="op-ic ${liked ? 'on' : ''}" data-act="fav" data-i="${i}" data-tip="${liked ? '取消收藏' : '收藏'}">${ic(liked ? 'i-heart-fill' : 'i-heart')}</button>
        <button class="op-ic" data-act="add" data-i="${i}" data-tip="加入歌单">${ic('i-plus')}</button>
        ${dlBtnHTML(track, i)}
        ${opts.detail ? `<button class="op-ic" data-act="detail" data-i="${i}" data-tip="详情">${ic('i-info')}</button>` : ''}
        ${opts.remove ? `<button class="op-ic" data-act="remove" data-i="${i}" data-tip="移除">${ic('i-trash')}</button>` : ''}
      </div>
    </div>`;
}

/**
 * 行内那个下载按钮（v2.8.0）。
 *
 * 三种样子，和播放条上那个按钮一一对应：
 *   · 没下过   → 向下的箭头
 *   · 已下载过 → **整体变成绿色的小勾**（Neo 2026-10-15 指定）
 *   · 下过但没成（失败/暂停）→ 仍然是箭头，具体状态去「下载管理」看
 *
 * ★ 绿勾用固定的语义色 `--ok`，**不用主题色 `--accent`** ——
 *   五套主题里有一套就叫「薄荷绿」，用主题色的话"没下载"的按钮也会是绿的，
 *   状态就完全分不出来了。理由在 style.css 顶部 `--ok-rgb` 那里有详述。
 */
function dlBtnHTML(track, i) {
  if (!track || !track.bvid) return '';   // 本地歌 / 没有 bvid 的行不给下载入口
  const done = isDownloaded(track);
  return `<button class="op-ic ${done ? 'done' : ''}" data-act="download" data-i="${i}" data-tip="${done ? '已下载' : '下载'}">${ic(done ? 'i-check' : 'i-download')}</button>`;
}

function trackListHTML(tracks, opts = {}) {
  if (!tracks.length) {
    return `<div class="empty">
      <div class="big">${ic(opts.emptyIcon || 'i-note')}</div>
      <div class="msg">${esc(opts.emptyText || '这里还什么都没有')}</div>
      <div class="hint">${esc(opts.emptyHint || '')}</div>
    </div>`;
  }
  return `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, opts)).join('')}</div>`;
}

/* ============================================================
   第 3.6 部分：合集 / 分P 展开面板
   ------------------------------------------------------------
   背景：B 站上很多"一首歌"其实把一个视频塞进了几十上百首歌（分P），
   或者一个 UP 主把系列打包成"合集"。列表里它只占一行、时长却好几个小时，
   点整行只会播第 1P。这里给这类行加一个「选集 N」小徽章，点开右侧面板列出全部条目。
   注意：B 站搜索接口不返回分P数量，所以只能用"时长 / 标题"先猜；
   真正展开要在点击时再查一次 videoInfo（backend 早就在做、且有缓存）。
   ============================================================ */

/** 猜这行是不是"多合一"长视频（搜索结果拿不到分P数，先用标题 + 时长猜） */
const COLLECT_HINT_RE = /合集|合辑|歌单|串烧|连播|选集|\d+\s*首/;
function maybeCollection(track) {
  if (!track) return false;
  // ★ v2.8.0 批次 B：本地歌没有 bvid/cid，永远不是"合集"，也不该去查选集 ——
  //   否则标题里带「合集」「串烧」的本地文件会触发一次注定失败的网络请求。
  if (track.localPath || !track.bvid) return false;
  if (track.parts > 1) return true;          // 已经查过，确实是分P
  if (track.seasonCount > 1) return true;    // 已经查过，确实是合集
  if (isCollectPart(track)) return false;    // 它自己就是某合集里的一集，不用再给一个入口
  if ((track.duration || 0) >= 30 * 60) return true;   // 半小时以上，多半是长合集
  return COLLECT_HINT_RE.test(track.title || '');
}

/**
 * 这一行本身是不是"某个合集里的一集"。
 * 合集里的分P共用同一个 bvid，所以光看 bvid 分不出来 —— 要拿 cid 去摊开的曲目表里比对。
 * 分出来有什么用：这些行不该再显示父合集的「选集 132/134」徽章（那是整条的数字，挂在每一集上只会让人看不懂）。
 */
function isCollectPart(track) {
  const cached = DB.collectParts && DB.collectParts[track.bvid];
  return !!(cached && cached.length > 1 && cached.some((e) => sameTrack(e, track)));
}

/**
 * 这一行算不算"正在播放"。
 *
 * 算的只有两种情况：
 *   ① 它就是当前这一首（sameTrack）。
 *   ② 它是"合集 / 分P 的入口行"—— 一行代表整支视频，正在播它里面任意一集时保持高亮。
 *      需要这一条，是因为摊开后队列里躺的是"一集一集"，和入口行不是同一个对象，
 *      否则你在发现页点开一条合集，界面上会没有任何一行是亮的。
 *
 * ★ v2.0.3 修的 bug：② 以前写的是"只要 bvid 一样就算在播"，
 *   而分P视频的**每一集共用同一个 bvid**（靠 cid 区分）—— 于是"最近播放"里
 *   这一支视频里播过的每一集全都显示成"正在播放"，看起来像播放器坏了。
 *   现在加一条闸门：**这一行自己就是某合集里的一集**时（有 cid、且能在摊开的
 *   曲目表里找到自己），它是一首独立的歌 —— 只有它自己正在播才算在播。
 */
function rowIsPlaying(track) {
  const cur = queue.tracks[queue.index];
  if (!cur || !track) return false;
  if (sameTrack(track, cur)) return true;
  if (!track.bvid || !cur.bvid) return false;

  // 闸门：它自己是合集里的一集 → 各自独立，不跟着"同一支视频的其它集"一起亮。
  // （入口行没有 cid，所以永远不会被这一条挡住，② 的原有行为完整保留。）
  if (isCollectPart(track)) return false;

  // 同一支视频（分P）：正在播其中一集时，外面那条入口行保持高亮
  if (track.bvid === cur.bvid) return true;
  // UP 合集：每一集自带 bvid，只能拿摊开的曲目表来认
  const parts = DB.collectParts[track.bvid];
  return !!(parts && parts.some((e) => sameTrack(e, cur)));
}

/** 这个合集到底有多少集（优先用查过一次的结果，其次用本地缓存） */
function collectionSize(track) {
  if (track.parts > 1) return { n: track.parts, kind: '选集' };
  if (track.seasonCount > 1) return { n: track.seasonCount, kind: '合集' };
  if (isCollectPart(track)) return { n: 0, kind: '选集' };   // 它自己是一集，不报父合集的总数
  const cached = DB.collectParts[track.bvid];
  if (cached && cached.length > 1) return { n: cached.length, kind: track.seasonTitle ? '合集' : '选集' };
  return { n: 0, kind: '选集' };
}

/** 徽章文字：没查过是「选集」；查过是「选集 134」；有禁用时是「选集 12/134」 */
function collectionBadgeLabel(track) {
  const { n, kind } = collectionSize(track);
  if (!n) return '选集';
  const on = enabledCount(track);
  return (on != null && on < n) ? `${kind} ${on}/${n}` : `${kind} ${n}`;
}

/* ------------------------------------------------------------
   合集里"单集启用 / 禁用"
   ------------------------------------------------------------
   一条合集动辄几十上百集，用户不可能整条都想听，所以每一集都能单独关掉。
   存法：DB.collectOff = { 合集bvid: ['子曲目键', ...] } —— 存的是"被关掉的"。
   · 没存过 = 全部启用 → 老存档不用迁移，行为跟以前一致
   · 键 = bvid#cid：分P 靠 cid 区分，合集里每一集自带 bvid + cid，都能唯一定位
   · 只存禁用键 + 一张剥掉封面 URL 的曲目表，几十集的合集也就一两 KB
   ------------------------------------------------------------ */

function entryKey(e) {
  return `${e.bvid}#${e.cid != null && e.cid !== '' ? e.cid : 'p' + (e.page || 1)}`;
}

function isEntryOff(parentBvid, e) {
  const off = DB.collectOff[parentBvid];
  return !!off && off.indexOf(entryKey(e)) >= 0;
}

/** 开关某一集：off=true 表示禁用 */
function setEntryOff(parentBvid, e, off) {
  const list = DB.collectOff[parentBvid] || (DB.collectOff[parentBvid] = []);
  const k = entryKey(e);
  const i = list.indexOf(k);
  if (off && i < 0) list.push(k);
  else if (!off && i >= 0) list.splice(i, 1);
  if (!list.length) delete DB.collectOff[parentBvid];
  persistLater();
}

/** 只留启用的那几集（parent 只要带 bvid 就行，合集对象 / collectState 都可以传） */
function enabledEntries(parent, entries) {
  return (entries || []).filter((e) => !isEntryOff(parent.bvid, e));
}

/** 现在启用了几集；没摊开过（不知道有几集）时返回 null */
function enabledCount(track) {
  const cached = DB.collectParts[track.bvid];
  if (!cached || !cached.length) return null;
  return cached.filter((e) => !isEntryOff(track.bvid, e)).length;
}

/**
 * 取一条合集的曲目表：先看本地缓存（摊开过一次就存下来了），没有才去查 B 站。
 * 查到了顺手把规模（几集 / 是不是 UP 合集）记在曲目对象上，徽章才能从「选集」变成「选集 N」。
 * 同一个 bvid 同时只查一次（播放和展开面板撞在一起也不会发两次请求）。
 */
const collectFetching = new Map();

/* ★ v2.0.5：给每个合集只存"一张封面"，读缓存时再套给每一条。
   为什么需要：DB.collectParts 是**故意剥掉封面**存的（上百集的长链接会把存档撑大），
   结果是"展开过合集 → 重启 → 再播这个合集"时，缓存里的条目没有 cover，
   播放条和列表的封面全空了（改造计划 v2.0.5 §1.1）。
   存法：DB.collectCovers = { 合集bvid: 封面URL } —— 每个合集只多 1 个 URL，不吃存档。
   memo 是为了保持"同一个 bvid 每次拿到的是同一批对象"（身份稳定），
   免得每次调用都造一批新对象，给后面的比对埋坑。 */
const collectCoverMemo = new Map();
function cachedCollectEntries(bvid, cached) {
  const hit = collectCoverMemo.get(bvid);
  if (hit) return hit;
  const cover = (DB.collectCovers && DB.collectCovers[bvid]) || '';
  const list = cover
    ? cached.map((e) => (e.cover ? e : Object.assign({}, e, { cover })))
    : cached;
  collectCoverMemo.set(bvid, list);
  // ★ v2.2.1：缓存里没记封面 → 异步补一次（补到就重画，见 backfillCover）。
  //   老存档里 32 个合集全都是这种（v2.0.5 只在"重新拉一遍曲目表"时才写 collectCovers，
  //   而缓存过的合集永远走不到那条分支），不补的话列表和播放条一直没封面。
  if (!cover) backfillCover(bvid);
  return list;
}

// 正在补封面的 bvid（同一个合集只补一次，别因为反复渲染发一堆请求）
const coverBackfilling = new Set();

/**
 * 给一个"还没封面"的 bvid 补一次封面（异步、一次性、自动去重）。
 *
 * 谁会用：① 曲目表已缓存、但 collectCovers 里没记的老合集；
 *        ② 存档里的 lastTrack（历史记录也一样，老数据没有 cover 字段）。
 * 补到之后：写进存档 → 丢掉 memo → 把队列里同 bvid 的曲目一起补上 → 重画。
 * @returns {Promise<string>} 补到的封面地址；没补到就是空串
 */
async function backfillCover(bvid) {
  if (!bvid || coverBackfilling.has(bvid)) return '';
  if (DB.collectCovers && DB.collectCovers[bvid]) return DB.collectCovers[bvid];
  coverBackfilling.add(bvid);
  try {
    const info = await api('videoInfo', bvid);
    const cover = (info && info.cover) || '';
    if (!cover) return '';
    // 只有"确实存过曲目表"的合集才需要单独记 —— 单曲的封面跟着它自己走
    if (DB.collectParts && DB.collectParts[bvid]) {
      if (!DB.collectCovers) DB.collectCovers = {};
      DB.collectCovers[bvid] = cover;
      collectCoverMemo.delete(bvid);   // 有封面了，下次取到的是带封面的那一份
    }
    // 队列里属于这个 bvid 的曲目，一起补上
    let touchedCurrent = false;
    const cur = queue.tracks[queue.index];
    queue.tracks.forEach((t) => {
      if (t && t.bvid === bvid && !t.cover) {
        t.cover = cover;
        if (t === cur) touchedCurrent = true;
      }
    });
    persistLater();
    if (touchedCurrent) applyTrackCover(cur);
    if (queue.tracks.length) renderAll();
    return cover;
  } catch (_) {
    // 网络失败就算了：下次再打开这个合集 / 重启还会再试一次
    return '';
  } finally {
    coverBackfilling.delete(bvid);
  }
}

async function collectEntriesFor(track) {
  const cached = DB.collectParts[track.bvid];
  if (cached && cached.length > 1) return cachedCollectEntries(track.bvid, cached);

  if (collectFetching.has(track.bvid)) return collectFetching.get(track.bvid);

  const p = (async () => {
    const info = await api('videoInfo', track.bvid);
    const entries = buildCollectionEntries(info);
    if (entries.length > 1) {
      track.parts = info.pages ? info.pages.length : 1;
      track.seasonCount = info.season ? info.season.episodes.length : 0;
      if (info.season) track.seasonTitle = info.season.title;
      // 存一份剥掉封面 URL 的曲目表（封面是长链接，上百集全存会把存档撑大）
      DB.collectParts[track.bvid] = entries.map((e) => ({
        bvid: e.bvid, cid: e.cid, page: e.page,
        title: e.title, duration: e.duration, author: e.author,
      }));
      // ★ v2.0.5：顺手把这张合集封面单独记一条（整张表只多这 1 个 URL）
      const cover = info.cover || (entries[0] && entries[0].cover) || '';
      if (!DB.collectCovers) DB.collectCovers = {};
      if (cover) DB.collectCovers[track.bvid] = cover;
      else delete DB.collectCovers[track.bvid];
      collectCoverMemo.delete(track.bvid);   // 有新封面了，丢掉旧的 memo
      persistLater();
    }
    return entries;
  })();

  collectFetching.set(track.bvid, p);
  try { return await p; } finally { collectFetching.delete(track.bvid); }
}

/**
 * 把"界面上看到的列表"摊成"真正要按顺序播的一串"。
 * ★ 这是本版的核心：合集行会被摊成它的一集一集（跳过被禁用的），
 *   于是顺序 / 随机 / 列表循环都会把合集里的歌当成一个个独立曲目来走，
 *   不会再出现"顺序播到合集只播了第 1 首就跳走"。
 * 返回 { list, startOf }：list 是摊平后的播放序列；
 * startOf[i] = 界面第 i 行在 list 里的起始下标（-1 = 这一行的曲目全被禁用了，不参与播放）。
 */
async function buildSequence(tracks) {
  const list = [];
  const startOf = [];
  const entriesOf = new Map();   // 曲目对象 → 它的曲目表（null = 读取失败）
  let failed = 0;

  // ① 先把所有"看起来是合集"的行**并发**取一遍。
  //    一条一条等会把等待时间叠起来（5 条长视频就是 5 次网络往返），
  //    并发取完，点击后的等待就缩短成"最慢那一条"的时间。
  //    第一次播放过后曲目表就存在本地了，之后点播放是瞬时的。
  const pending = (tracks || []).filter((t) => maybeCollection(t));
  if (pending.length) {
    // 最多同时 4 个（B 站对短时间内的密集请求会限流，别一次把 20 条全发出去）
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const t = pending.shift();
        try { entriesOf.set(t, await collectEntriesFor(t)); }
        catch (_) { entriesOf.set(t, null); }
      }
    });
    await Promise.all(workers);
  }

  // ② 再按界面上的顺序拼装（这一步只读内存，不再发请求）
  for (let i = 0; i < (tracks || []).length; i++) {
    const t = tracks[i];
    startOf[i] = -1;
    if (maybeCollection(t)) {
      const got = entriesOf.get(t);
      if (got === null) {
        failed += 1;   // 读不到 → 这一行退化成"就播它本身"
      } else if (got && got.length > 1) {
        const on = enabledEntries(t, got);
        if (!on.length) continue;   // 整行都被禁完了 → 这一行不参与播放
        startOf[i] = list.length;
        on.forEach((e) => list.push(e));
        continue;
      }
    }
    startOf[i] = list.length;
    list.push(t);
  }

  // 某个合集读不到（断网 / 被风控）时只让它退化成"就播这一首"，不能让整张列表都播不了
  if (failed) toast(`${failed} 个合集读取失败，这次先只播它本身`);
  return { list, startOf };
}

let collectState = null;   // 面板开着时才有值：{ bvid, title, baseSub, entries }

/**
 * 选集面板的「批量下载」勾选态（v2.8.0）。
 * ★ 为什么单独一份、不复用 dlPick：dlPick 是**绑在某个列表视图上**的
 *   （它按 `currentTracks()[i]` 取曲目），而面板里的条目是"这个合集的第 N 集"，
 *   压根不在当前视图的列表里。硬塞进去会取到别的歌。
 *   形状：{ selected: Map<entryKey, entry> }；null = 不在勾选态。
 */
let collectPick = null;

function closeCollectPanel() {
  const mask = $('collectMask');
  if (mask) mask.classList.remove('show');
  collectState = null;
  collectPick = null;   // 关面板一定要退出勾选态，不然下次打开会带着上次的勾
}

/** 点「选集」徽章：把分P / 合集摊开；若其实不是合集就直接播这一首 */
async function expandCollection(track, fallback) {
  if (!track || !track.bvid) return;

  collectState = null;
  collectPick = null;   // 换一个合集 → 上次的勾选不能带过来
  $('collectTitle').textContent = track.title;
  $('collectSub').textContent = '正在读取选集…';
  $('collectSearch').value = '';
  $('collectList').innerHTML = `<div class="loading"><div class="spinner"></div>正在读取…</div>`;
  $('collectMask').classList.add('show');

  let entries;
  try {
    entries = await collectEntriesFor(track);   // 有本地缓存就直接用，不再等网络
  } catch (err) {
    $('collectSub').textContent = '';
    $('collectList').innerHTML = `<div class="err">读取失败：${esc(err.message)}</div>`;
    return;
  }

  if (entries.length <= 1) {
    // 其实只有 1 个分P —— 不是合集，收起来直接播这一首
    closeCollectPanel();
    if (fallback && fallback.list) playTracks(fallback.list, fallback.index, fallback.name);
    return;
  }

  const total = entries.reduce((s, e) => s + (e.duration || 0), 0);
  collectState = {
    bvid: track.bvid,
    title: track.title,
    baseSub: (track.seasonTitle
      ? `合集「${track.seasonTitle}」 · ${entries.length} 集`
      : `${entries.length} 个分P`) + ` · 共 ${fmtTime(total)}`,
    entries,
  };
  renderCollectList('');
  renderAll();   // 让行上的徽章同步成「选集 N」
}

/** 把一个视频详情整理成面板条目（优先 UP 合集，其次分P） */
function buildCollectionEntries(info) {
  if (info.season && info.season.episodes && info.season.episodes.length) {
    return info.season.episodes.map((ep) => ({
      bvid: ep.bvid, cid: ep.cid, page: ep.page || 1, title: ep.title,
      author: info.owner.name, cover: ep.cover || info.cover, duration: ep.duration,
    }));
  }
  return (info.pages || []).map((p) => ({
    bvid: info.bvid, cid: p.cid, page: p.page, title: p.title,
    author: info.owner.name, cover: info.cover, duration: p.duration,
  }));
}

function renderCollectList(filter) {
  if (!collectState) return;
  const q = (filter || '').trim().toLowerCase();
  const entries = collectState.entries;
  const cur = queue.tracks[queue.index];
  const picking = !!collectPick;   // v2.8.0：面板里的「批量下载」勾选态
  const rows = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => !q || (e.title || '').toLowerCase().includes(q) || String(i + 1) === q);

  $('collectList').innerHTML = rows.length
    ? rows.map(({ e, i }) => {
      const liked = isFav(e);
      const off = isEntryOff(collectState.bvid, e);
      const done = isDownloaded(e);

      /* 勾选态：左边是复选框，序号和那排操作按钮全收起来。
         ★ 不显示 .off（划掉）：那个标记说的是"不参与播放"，跟"要不要下载"是两回事，
           在勾选态里显示只会让人以为这集选不了。 */
      if (picking) {
        const picked = collectPick.selected.has(entryKey(e));
        return `
        <div class="collect-row pickable ${picked ? 'picked' : ''}" data-ci="${i}">
          <span class="pick${picked ? ' on' : ''}" role="checkbox" aria-checked="${picked ? 'true' : 'false'}" data-cpick="${i}">${ic('i-check')}</span>
          <span class="ct" title="${esc(e.title)}">${esc(e.title)}</span>
          <span class="cd">${fmtTime(e.duration)}</span>
        </div>`;
      }

      return `
        <div class="collect-row ${off ? 'off' : ''} ${sameTrack(e, cur) ? 'on' : ''}" data-ci="${i}">
          <span class="cn">${i + 1}</span>
          <span class="ct" title="${esc(e.title)}">${esc(e.title)}</span>
          <span class="cd">${fmtTime(e.duration)}</span>
          <span class="cops">
            <button class="op-ic ${done ? 'done' : ''}" data-cact="download" data-ci="${i}" data-tip="${done ? '已下载' : '下载这一集'}">${ic(done ? 'i-check' : 'i-download')}</button>
            <button class="op-ic ${off ? '' : 'on'}" data-cact="toggle" data-ci="${i}" data-tip="${off ? '启用这一集' : '禁用这一集（不参与播放）'}">${ic(off ? 'i-off' : 'i-check')}</button>
            <button class="op-ic ${liked ? 'on' : ''}" data-cact="fav" data-ci="${i}" data-tip="${liked ? '取消收藏' : '收藏'}">${ic(liked ? 'i-heart-fill' : 'i-heart')}</button>
            <button class="op-ic" data-cact="add" data-ci="${i}" data-tip="加入歌单">${ic('i-plus')}</button>
          </span>
        </div>`;
    }).join('')
    : `<div class="err">没有匹配的条目</div>`;

  syncCollectBar();
}

/**
 * 顶部的三个数字/文案跟当前启用状态对齐：
 * 副标题写"已启用 x/y 集"、一键按钮写"全部禁用/全部启用"、批量按钮带上数量。
 *
 * ★ v2.8.0：「播放全部」换成了「批量下载」（Neo 拍板，见改造计划 §3.4）。
 *   代价是这一屏不再有一键播全部选集 —— 想整段听，选集行本身点一下就播，
 *   从那一集开始照样连着往下播。
 */
function syncCollectBar() {
  if (!collectState) return;
  const entries = collectState.entries;
  const on = enabledEntries(collectState, entries);
  $('collectSub').textContent = `${collectState.baseSub} · 已启用 ${on.length}/${entries.length} 集`;
  const all = $('btnCollectToggleAll');
  if (all) {
    all.textContent = (on.length === entries.length) ? '全部禁用' : '全部启用';
    // ★ v2.8.0：勾选态里把「全部启用 / 全部禁用」收起来。
    //   勾选中去改"播放范围"没有意义，而且腾出地方给「退出批量下载」这个长文案
    //   （面板总共才 400px 宽，两个长按钮 + 搜索框挤不下）。
    all.style.display = collectPick ? 'none' : '';
  }
  const dl = $('btnDownloadCollect');
  if (dl) {
    // ★ 文案不再带 (N)：那个 N 是"启用中"的集数，跟"这次要下几首"已经不是一回事了 ——
    //   现在下几首由勾选态里的选择决定，带个旧数字只会误导。
    dl.textContent = collectPick ? '退出批量下载' : '批量下载';
    dl.classList.toggle('on', !!collectPick);
  }
  syncCollectPickBar();
}

/**
 * 勾选态那条工具条（v2.8.0）。不在勾选态时整条藏起来。
 * ★ 单独占一行，不去跟上面那排抢宽度 —— 见 style.css 里 .collect-pickbar 的注释。
 */
function syncCollectPickBar() {
  const bar = $('collectPickBar');
  if (!bar) return;
  bar.style.display = collectPick ? '' : 'none';
  if (!collectPick) { bar.innerHTML = ''; return; }
  const n = collectPick.selected.size;
  const total = collectState ? collectState.entries.length : 0;
  bar.innerHTML = `
    <span class="cp-count">已选 <b>${n}</b> 首</span>
    <button class="ghost-btn" id="btnCollectPickAll">全选 (${total})</button>
    <button class="ghost-btn" id="btnCollectPickNone"${n ? '' : ' disabled'}>清空</button>
    <button class="primary-btn" id="btnCollectPickDo"${n ? '' : ' disabled'}>下载选中的 ${n} 首</button>`;
}

/* ---------- 选集面板的勾选态 ---------- */

/** 面板里「批量下载」= 进 / 出勾选态（和工具条上那个按钮一个手感） */
function toggleCollectPick() {
  if (collectPick) { collectPick = null; renderCollectList($('collectSearch').value); return; }
  if (!collectState) return;
  // ★ 默认**一个都不勾**：真机反馈的原话是"点了就直接下全部"，
  //   所以这里必须让"下什么"由用户明确选出来，不能替他默认全选。
  collectPick = { selected: new Map() };
  renderCollectList($('collectSearch').value);
}

function collectPickToggle(i) {
  if (!collectPick || !collectState) return;
  const e = collectState.entries[i];
  if (!e) return;
  const k = entryKey(e);
  if (collectPick.selected.has(k)) collectPick.selected.delete(k);
  else collectPick.selected.set(k, e);
  renderCollectList($('collectSearch').value);
}

function collectPickAll() {
  if (!collectPick || !collectState) return;
  for (const e of collectState.entries) collectPick.selected.set(entryKey(e), e);
  renderCollectList($('collectSearch').value);
}

function collectPickNone() {
  if (!collectPick) return;
  collectPick.selected.clear();
  renderCollectList($('collectSearch').value);
}

async function collectPickDo() {
  if (!collectPick) return;
  const list = [...collectPick.selected.values()];
  if (!list.length) return;
  // ★ jump:false —— 面板还开着，跳走等于把用户正在挑的选集列表抽掉。
  //   下载完再重画一次面板：刚下过的那些行要变成绿勾。
  await enqueueDownloads(list, { jump: false });
  if (collectState) renderCollectList($('collectSearch').value);
}

/** 一键全部启用 / 全部禁用（按当前状态决定往哪边切） */
function toggleAllEntries() {
  if (!collectState) return;
  const entries = collectState.entries;
  const on = enabledEntries(collectState, entries);
  const turnOff = on.length === entries.length;   // 现在全开着 → 这一下是全关

  if (turnOff) DB.collectOff[collectState.bvid] = entries.map(entryKey);
  else delete DB.collectOff[collectState.bvid];   // 全开 = 不留记录（默认就是全开）
  persistLater();

  renderCollectList($('collectSearch').value);
  renderAll();
  toast(turnOff ? `已禁用全部 ${entries.length} 集` : `已启用全部 ${entries.length} 集`);
}

/** 点面板里的某一集：从这一集开始播（禁用中的那一集点开也照播，是用户主动点的） */
function playCollectEntry(i) {
  if (!collectState) return;
  const e = collectState.entries[i];
  if (!e) return;
  const list = enabledEntries(collectState, collectState.entries);
  let k = list.findIndex((x) => sameTrack(x, e));
  if (k < 0) { list.unshift(e); k = 0; }
  playTracks(list, k, collectState.title);
  renderCollectList($('collectSearch').value);   // 刷新"正在播放"高亮
}

/** 绑定合集面板的开关与交互（点空白 / Esc 收起，跟歌词浮层一致） */
function bindCollect() {
  const mask = $('collectMask');
  if (!mask) return;
  $('btnCloseCollect').addEventListener('click', closeCollectPanel);
  $('collectMask').addEventListener('click', (e) => {
    if (e.target.id === 'collectMask') closeCollectPanel();
  });
  $('collectSearch').addEventListener('input', (e) => renderCollectList(e.target.value));
  $('collectList').addEventListener('click', (e) => {
    // ★ v2.8.0：勾选态优先 —— 这时行里只剩复选框，点整行就是勾 / 取消，不播放。
    if (collectPick) {
      const prow = e.target.closest('.collect-row');
      if (prow) collectPickToggle(Number(prow.dataset.ci));
      return;
    }
    // 每一集右侧的图标按钮（启用开关 / 收藏 / 加歌单）优先，不能顺手把整行"播放"也触发了
    const act = e.target.closest('[data-cact]');
    if (act && collectState) {
      const entry = collectState.entries[Number(act.dataset.ci)];
      if (entry) {
        if (act.dataset.cact === 'toggle') {
          setEntryOff(collectState.bvid, entry, !isEntryOff(collectState.bvid, entry));
          renderCollectList($('collectSearch').value);
          renderAll();   // 行上的徽章要跟着变成「选集 12/134」
        }
        else if (act.dataset.cact === 'fav') { toggleFav(entry); renderCollectList($('collectSearch').value); }
        else if (act.dataset.cact === 'add') addToPlaylist(entry);
        // v2.8.0：只下这一集。下完要重画面板 —— 那个按钮要变成绿色小勾。
        else if (act.dataset.cact === 'download') {
          enqueueDownloads([entry], { jump: false })
            .then(() => { if (collectState) renderCollectList($('collectSearch').value); });
        }
      }
      return;
    }
    const row = e.target.closest('.collect-row');
    if (row) playCollectEntry(Number(row.dataset.ci));
  });
  $('btnCollectToggleAll').addEventListener('click', toggleAllEntries);
  /* v2.8.0：这里原来是「播放全部」，现在是「批量下载」→ **进勾选态**。
     ★ 真机反馈改过一版：最早点它就直接把"启用中"的整批丢进下载队列，
       用户没地方挑（"没有让选择的功能，点击后是直接下载全部了"）。
       现在它只是个入口，下哪几首由勾选态里的选择决定。 */
  $('btnDownloadCollect').addEventListener('click', toggleCollectPick);
  // 勾选工具条里那三个按钮：内容是每次重画生成的，所以在**容器**上做事件代理
  $('collectPickBar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btnCollectPickAll') collectPickAll();
    else if (b.id === 'btnCollectPickNone') collectPickNone();
    else if (b.id === 'btnCollectPickDo') collectPickDo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !collectState) return;
    // 勾选态下先退勾选态，再按一次才收面板 —— 免得一按 Esc 把挑了一半的整个面板关掉
    if (collectPick) { collectPick = null; renderCollectList($('collectSearch').value); return; }
    closeCollectPanel();
  });
}

/* ============================================================
   第 3.8 部分：播放队列
   ------------------------------------------------------------
   队列本来就一直存在（queue.tracks —— 上一首 / 下一首就是按它走的），
   只是以前没有界面，所以播放条/合集面板上的「加入队列」看起来像没生效。
   这里给它一个能从右侧拉开的抽屉：看得见"接下来播什么"，能跳播、移除、打乱、清空。
   ============================================================ */

/**
 * 队列行的 HTML —— 右侧抽屉和 mini 展开态那块列表**共用同一份**。
 * 抽出来是为了不让两处各画一套：改一次两边一起变，样式和"正在播放"高亮不会跑偏。
 * @param {string} filter 关键词（按标题过滤，或直接输序号）；空字符串 = 不过滤
 * @returns {string[]} 每一行一段 HTML
 */
function queueRowsHTML(filter) {
  const cur = queue.tracks[queue.index];
  const q = (filter || '').trim().toLowerCase();
  return queue.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => !q || (t.title || '').toLowerCase().includes(q) || String(i + 1) === q)
    .map(({ t, i }) => `
        <div class="collect-row ${sameTrack(t, cur) ? 'on' : ''}" data-qi="${i}">
          <span class="cn">${i + 1}</span>
          <span class="ct" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="cd">${fmtTime(t.duration)}</span>
          <span class="cops">
            <button class="op-ic" data-qact="remove" data-qi="${i}" data-tip="从队列移除">${ic('i-trash')}</button>
          </span>
        </div>`);
}

function renderQueueList(filter) {
  const box = $('queueList');
  if (!box) return;
  const rows = queueRowsHTML(filter);

  $('queueSub').textContent = queue.tracks.length
    ? `共 ${queue.tracks.length} 首${queue.name ? ' · 来自「' + queue.name + '」' : ''}`
    : '队列是空的';

  box.innerHTML = rows.length
    ? rows.join('')
    : `<div class="empty" style="padding:34px 16px">
         <div class="msg">队列是空的</div>
         <div class="hint">在列表里点整行开始播放，或用合集面板的「加入队列」一次塞进一整段</div>
       </div>`;
}

function openQueue() {
  $('queueMask').classList.add('show');
  $('queueSearch').value = '';
  renderQueueList('');
}

function closeQueue() {
  $('queueMask').classList.remove('show');
}

/** 从队列里拿掉一首。拿掉的正是"正在播"那首时，接着播原来位置的下一首 */
function removeFromQueue(i) {
  if (i < 0 || i >= queue.tracks.length) return;
  queue.tracks.splice(i, 1);
  if (queue.index > i) {
    queue.index -= 1;
  } else if (queue.index === i) {
    if (!queue.tracks.length) queue.index = -1;
    else { queue.index = Math.min(i, queue.tracks.length - 1); playAt(queue.index); }
  }
  renderQueueList($('queueSearch').value);
  renderAll();
}

function bindQueue() {
  const mask = $('queueMask');
  if (!mask) return;
  // ★ v2.1.0：mini 模式下 ☰ 不拉这个抽屉（420px 宽的小窗里塞不下右侧抽屉），
  //   改成"就地展开 / 收起"mini 条下面那块队列列表。完整模式下行为完全没变。
  $('btnQueue').addEventListener('click', () => {
    if (mini.on) { setMini(true, !mini.expanded); return; }
    openQueue();
  });
  $('btnCloseQueue').addEventListener('click', closeQueue);
  mask.addEventListener('click', (e) => { if (e.target.id === 'queueMask') closeQueue(); });
  $('queueSearch').addEventListener('input', (e) => renderQueueList(e.target.value));

  $('queueList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-qact="remove"]');
    if (rm) { removeFromQueue(Number(rm.dataset.qi)); return; }
    const row = e.target.closest('.collect-row');
    if (row) goTo(Number(row.dataset.qi));   // 走 goTo：随机模式的"上一首"才回得去
  });

  $('btnQueueShuffle').addEventListener('click', () => {
    if (queue.tracks.length < 2) { toast('队列里的歌太少，不用打乱'); return; }
    // 注意：这里只是把"队列摆放顺序"打乱一次，跟播放模式里的"随机播放"不是一回事
    const cur = queue.tracks[queue.index];
    for (let i = queue.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
    }
    queue.index = cur ? queue.tracks.indexOf(cur) : -1;
    playStack = [];
    renderQueueList($('queueSearch').value);
    renderAll();
    toast('已打乱队列顺序');
  });

  $('btnQueueClear').addEventListener('click', () => {
    if (!queue.tracks.length) { toast('队列本来就是空的'); return; }
    queue.tracks = [];
    queue.index = -1;
    queue.name = '';
    renderQueueList('');
    renderAll();
    toast('已清空队列');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) closeQueue();
  });
}

/* ============================================================
   第 3.8.5 部分：mini 模式（v2.1.0）
   ------------------------------------------------------------
   不是"另开一个小窗口"，就是**同一个窗口**换一套布局：
     · 界面这一半：给 <body> 加/去 mini 类（CSS 见 style.css 那一节）、
       渲染展开态的队列列表、把状态写进存档。
     · 主进程那一半：把窗口本身缩成 420×132 / 展开 420×520（见 main.js 的 win:mini）。
   两边各管一半，谁也不越界 —— 所以这里只发消息、不直接改窗口尺寸。

   ★ 状态只有一个来源：mini.on / mini.expanded 这两个变量。
     别处一律通过 setMini() / applyMiniUI() 改，免得"界面说在 mini、主进程说不在"。
   ============================================================ */

const mini = { on: false, expanded: false };

/**
 * 只换界面（类名、提示文字、列表），**不通知主进程**。
 * 用途：主进程回推状态时、启动时按存档恢复时 —— 那时窗口尺寸已经是对的了，
 * 再发一次消息就会"回推 → 改界面 → 再发消息"转成死循环。
 */
function applyMiniUI(on, expanded) {
  mini.on = !!on;
  mini.expanded = !!on && !!expanded;

  document.body.classList.toggle('mini', mini.on);
  document.body.classList.toggle('mini-open', mini.on && mini.expanded);

  const bm = $('btnMini');
  if (bm) {
    // v2.3.0：键位改成从表里现拼（改了键位提示就跟着变）
    bm.title = (mini.on ? '退出 mini 模式' : 'mini 模式') + keyHint('miniMode');
    bm.setAttribute('aria-label', bm.title);
  }
  // mini 模式下 ☰ 不再拉右侧抽屉，改成"就地展开 / 收起队列列表"，
  // 所以提示文字也得跟着换，不然鼠标停上去写的是"播放队列"，点出来却是另一回事。
  const bq = $('btnQueue');
  if (bq) bq.title = mini.on ? (mini.expanded ? '收起队列列表' : '展开队列列表') : '播放队列';

  renderMiniList();
}

/**
 * 进 / 出 mini 模式（界面主动触发：点按钮、按 Ctrl+M）。
 * 先换界面，再请主进程调窗口 —— 这样看起来是"布局和窗口同时变"。
 */
function setMini(on, expanded, opts = {}) {
  const wantOn = !!on;
  const wantExpanded = wantOn ? !!expanded : false;
  if (mini.on === wantOn && mini.expanded === wantExpanded) return;

  // ★ 进 mini 前先把整页歌词收起来：那个浮层是铺满整个窗口的，
  //   在 132px 高的小窗里根本没法看（而且小窗里也点不到封面去关它）。
  if (wantOn && lyricState.showing) toggleLyrics(false);

  applyMiniUI(wantOn, wantExpanded);
  window.neko.winMini(wantOn, wantExpanded);

  DB.settings.window = DB.settings.window || {};
  DB.settings.window.mini = wantOn;
  DB.settings.window.miniExpanded = wantExpanded;
  if (!opts.silent) persistLater();
}

/** mini 展开态那块列表：就是当前播放队列（"接下来播什么"最贴图3） */
function renderMiniList() {
  const box = $('miniList');
  if (!box) return;
  if (!mini.on) { box.innerHTML = ''; return; }

  const rows = queueRowsHTML('');
  const head = `<div class="mini-head"><span>播放队列</span><span class="mh-n">共 ${queue.tracks.length} 首</span></div>`;
  box.innerHTML = head + (rows.length
    ? rows.join('')
    : `<div class="empty" style="padding:34px 16px">
         <div class="msg">队列是空的</div>
         <div class="hint">在列表里点整行开始播放，或用合集面板的「加入队列」一次塞进一整段</div>
       </div>`);
}

/** 绑定 mini 模式的所有交互 */
function bindMini() {
  $('btnMini').addEventListener('click', () => setMini(true, false));
  // mini 窗右上角那两个：▢ 回完整模式、✕ 关程序
  $('btnRestoreFull').addEventListener('click', () => setMini(false, false));
  $('miniClose').addEventListener('click', () => window.neko.winClose());

  // 展开态列表里：点整行跳播、点垃圾桶从队列拿掉（和右侧抽屉同一套动作）
  $('miniList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-qact="remove"]');
    if (rm) { removeFromQueue(Number(rm.dataset.qi)); return; }
    const row = e.target.closest('.collect-row');
    if (row) goTo(Number(row.dataset.qi));
  });

  // 主进程回推"现在是不是 mini / 展没展开"。
  // 它是唯一的真相来源（比如它在进 mini 时顺手退掉了最大化，就得由它来定状态）。
  window.neko.onWinMiniState((st) => {
    const on = !!st.on;
    const expanded = !!st.expanded;
    const changed = !(mini.on === on && mini.expanded === expanded);
    if (changed) {
      if (on && lyricState.showing) toggleLyrics(false);
      applyMiniUI(on, expanded);
      DB.settings.window = DB.settings.window || {};
      DB.settings.window.mini = on;
      DB.settings.window.miniExpanded = expanded;
      persistLater();
    }
    // ★ v2.2.0：这一句必须放在"状态没变就跳过"的**外面**。
    //   踩过的坑：第一版写在里面，结果**第一次进 mini 时封面那块的位置根本传不出去**
    //   （进 mini 时 setMini 已经先把 mini.on 置成 true 了，主进程回推的状态"没变"就被跳过）——
    //   主进程拿不到 coverRect，任务栏缩略图就裁不了封面。
    reportUiState();
  });

  // 完整模式下窗口被拖动 / 缩放后，主进程把新位置尺寸送回来 —— 存下来，下次打开还原
  window.neko.onWinBounds((b) => {
    if (!b || !b.width || !b.height) return;
    DB.settings.window = DB.settings.window || {};
    DB.settings.window.fullBounds = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height),
    };
    persistLater();
  });
}

/* ============================================================
   第 3.8.6 部分：把界面状态告诉主进程（v2.2.0）
   ------------------------------------------------------------
   主进程要拿这些去画两样**系统画的东西**：
     · 托盘菜单 —— 当前歌名 / 播放还是暂停 / 播放模式打勾 / 窗口模式打勾 / 歌词开关
     · 任务栏缩略图上的三个按钮 —— "播放 / 暂停"是同一个按钮换图标
   界面是这些状态的**唯一来源**，主进程只当镜子（它自己拿不到"在放哪首歌"）。

   ★ 必须做"状态没变就不发"的过滤：这个函数会被频繁调到
     （换歌、播放 / 暂停、甚至每 250 毫秒的进度推送都可能带一脚），
     不拦一下，主进程就会把**原生菜单**反复重建。
   ============================================================ */

let lastUiStateKey = '';

/** 关窗行为（存档里的 settings.close.action），永远返回三种之一 */
function closeActionSetting() {
  const v = DB.settings && DB.settings.close && DB.settings.close.action;
  return CLOSE_ACTIONS.includes(v) ? v : 'ask';
}

function reportUiState() {
  if (!window.neko || typeof window.neko.reportUiState !== 'function') return;
  const cur = queue.tracks[queue.index];
  const cover = $('npCover');
  const cr = cover ? cover.getBoundingClientRect() : null;
  const st = {
    playing: !audio.paused && !!audio.src,
    hasTrack: !!cur,
    title: cur ? (cur.title || '') : '',
    playMode,
    lyricOn: !!lw().on,
    lyricLocked: !!lw().locked,
    closeAction: closeActionSetting(),
    // mini 下主进程要用它把任务栏缩略图裁到封面那一块。
    // ★ 由界面来量：封面在哪一块是**布局**的事，写死在主进程里，改一次 CSS 就错一次。
    coverRect: (mini.on && cr && cr.width > 0)
      ? { x: Math.round(cr.x), y: Math.round(cr.y), width: Math.round(cr.width), height: Math.round(cr.height) }
      : null,
  };
  const key = JSON.stringify(st);
  if (key === lastUiStateKey) return;   // 没变就别打扰主进程
  lastUiStateKey = key;
  window.neko.reportUiState(st);
}

/**
 * 强制下一次上报一定发出去。
 * ★ 什么时候需要：**改了设置、而主进程那边可能自己动过这个状态**的时候。
 *   踩过的坑：用户在关窗弹窗里勾了「设为默认值」→ 主进程把 uiState.closeAction 自己改成 'tray'，
 *   但界面这边的"上次发出去的快照"还停在 'ask'。之后用户去设置里改回「每次询问」，
 *   算出来的 key 又变回 'ask' —— **正好和缓存撞上，这一次上报就被去重吞掉了**，
 *   主进程还以为设置是 'tray'，下次点 ✕ 直接隐藏，不再弹窗。
 */
function forceReportUiState() {
  lastUiStateKey = '';
  reportUiState();
}

/* ============================================================
   第 3.8.7 部分：关闭方式弹窗（v2.2.0）
   ------------------------------------------------------------
   什么时候会弹：主进程收到 close 事件、而存档里的 settings.close.action 是 'ask' 时，
   它会发一条 win:ask-close 过来。用户在这里选完，回 win:close-choice。
   选"缩小到任务栏"之后窗口会消失但**歌继续放**，点托盘图标能找回来。
   ============================================================ */

let closeChoiceBusy = false;

function showCloseDialog() {
  const mask = $('closeMask');
  if (!mask) return;
  closeChoiceBusy = false;
  const chk = $('closeRemember');
  if (chk) chk.checked = false;   // 每次弹都是"没勾"的状态，别把上次的勾记着
  mask.classList.add('show');
}

function hideCloseDialog() {
  const mask = $('closeMask');
  if (mask) mask.classList.remove('show');
}

/** 用户选了：action 是 'quit'（彻底关闭）或 'tray'（缩小到任务栏） */
async function finishCloseChoice(action, remember) {
  if (closeChoiceBusy) return;   // 防连点：点两下别回两次
  closeChoiceBusy = true;
  hideCloseDialog();

  try {
    if (remember) {
      DB.settings.close = { action };
      syncCloseActionUI();
      // ★ 必须**先存好**再告诉主进程：主进程收到 'quit' 之后马上就会真的退出，
      //   那时候再来不及写盘，用户"设为默认"的勾就白打了。
      await flushPersistence();
      forceReportUiState();   // 主进程那边可能自己动过 closeAction，这里必须强推一次
    }
    window.neko.closeChoice(action, remember);
  } finally {
    // ★ 无论成败都要放开这个标记。
    //   踩过的坑：第一版成功之后不复位，万一哪次主进程没再发 win:ask-close，
    //   弹窗就**再也点不动了**（按下去什么都不发生）。弹窗这时已经藏起来
    //   （.modal-mask 没有 .show 时 pointer-events:none），所以放开也不会被连点。
    closeChoiceBusy = false;
  }
}

function bindCloseDialog() {
  const mask = $('closeMask');
  if (!mask) return;

  $('closeQuit').addEventListener('click', () => finishCloseChoice('quit', $('closeRemember').checked));
  $('closeTray').addEventListener('click', () => finishCloseChoice('tray', $('closeRemember').checked));

  const cancel = () => { hideCloseDialog(); closeChoiceBusy = false; };
  $('closeCancel').addEventListener('click', cancel);
  // 点弹窗外面的暗色区域 / 按 Esc 都算取消（和别的小弹窗一个习惯）
  mask.addEventListener('click', (e) => { if (e.target.id === 'closeMask') cancel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) cancel();
  });

  // 主进程问"点 ✕ 想怎么关"
  window.neko.onAskClose(() => showCloseDialog());
}

/* ============================================================
   第 3.8.8 部分：托盘 / 任务栏发来的命令（v2.2.0）
   ------------------------------------------------------------
   来源有三处：托盘菜单、任务栏缩略图上的三个按钮、任务栏右键的「任务」（JumpList）。
   这里只负责"收到命令 → 调用界面本来就在用的那个函数"，
   不重复实现播放逻辑 —— 播放 / 切歌 / 换模式本来就有现成的入口。
   ============================================================ */

function handleWinCmd(cmd) {
  switch (cmd) {
    case 'toggle':
      if (!audio.src) { toast('先选一首歌吧'); return; }
      audio.paused ? safePlay() : audio.pause();
      return;

    case 'prev': prevTrack(); return;
    case 'next': next(1); return;

    case 'lyric-open': toggleDesktopLyric(); return;

    case 'lyric-lock': {
      const s = lw();
      s.locked = !s.locked;
      pushLyricStyle();
      syncLyricSettingsUI();
      persistLater();
      toast(s.locked ? '桌面歌词已锁定位置' : '桌面歌词已解锁');
      reportUiState();
      return;
    }

    case 'settings': openSettings(); return;

    case 'show':
      // 主进程自己已经把窗口叫到前台了，界面这边不用做什么
      return;

    default:
      // 'mode:shuffle' 这种带参数的
      if (cmd.indexOf('mode:') === 0) {
        const m = PLAY_MODES.find((x) => x.id === cmd.slice(5));
        if (m) { setPlayMode(m.id, true); toast(`播放模式：${m.name}`); }
      }
      return;
  }
}

/* ============================================================
   第 3.9 部分：UP 主主页（点作者名 → 看他的全部视频）
   ------------------------------------------------------------
   B 站的空间接口对"未登录"很敏感：没填 Cookie 时经常直接回风控，
   所以这里的失败提示会明确引导去「设置 → B 站」填 Cookie，而不是丢个看不懂的报错。
   ============================================================ */

let upState = null;   // { mid, name, list, page, pageSize, total, loading, error }

/** 点作者名：打开这个 UP 主的主页 */
async function openUpPage(track) {
  if (!track || !track.mid) { toast('这条没有 UP 主信息，看不了他的主页'); return; }
  upState = {
    mid: track.mid,
    name: track.author || '这个 UP 主',
    list: [], page: 0, pageSize: 30, total: 0, loading: true, error: '',
  };
  currentView = 'up';
  renderUp();
  await loadUp(1);
}

/**
 * 拉 UP 主页的第 pn 页。
 *
 * ★ v2.5.0：从"累加"改成"翻页" —— 列表里**只装当前这一页**。
 *   以前是 `pn === 1 ? mapped : list.concat(mapped)`，翻到第 5 页时列表里堆着 150 条，
 *   而且只能靠「加载更多」一页页往后点。现在每页替换，配上下面的分页条就能任意跳页。
 */
async function loadUp(pn) {
  if (!upState) return;
  upState.loading = true;
  upState.error = '';
  renderUp();
  try {
    const res = await api('upVideos', upState.mid, pn);
    const mapped = res.list.map((v) => ({
      bvid: v.bvid, cid: null, page: 1,
      title: v.title, author: v.author, mid: upState.mid,
      cover: v.cover, duration: parseDuration(v.duration),
    }));
    upState.list = mapped;                       // ★ v2.5.0：只装这一页（原来是 concat 累加）
    upState.page = pn;
    upState.pageSize = res.pageSize || upState.pageSize || 30;
    upState.total = res.total || mapped.length;  // ★ v2.5.0：总数（后端给不出就退回"本页条数"）
  } catch (err) {
    upState.error = err.message || '读取失败';
  } finally {
    upState.loading = false;
    if (currentView === 'up') renderUp();
  }
}

/**
 * 分页条（v2.5.0）
 * ------------------------------------------------------------
 * 产出： [← 上一页] [1] [2] [3] … [28] [下一页 →]
 *
 * 页码规则：
 *   · 总页数 ≤ 7 → 全部列出来（页数本来就少，再省略反而看不懂）；
 *   · 否则只留「首页 + 当前页前后各 2 页 + 末页」，中间断档处用一个 … 顶掉。
 *     例：28 页时，第 1 页显示 `1 2 3 … 28`；第 5 页显示 `1 … 3 4 [5] 6 7 … 28`。
 *   · 当前页高亮（主题色）；首页「上一页」、末页「下一页」置灰。
 *
 * @param {number} page       当前页（从 1 开始）
 * @param {number} totalPages 总页数（至少 1）
 */
function paginationHTML(page, totalPages) {
  const total = Math.max(1, Math.floor(totalPages) || 1);
  const cur = Math.min(Math.max(1, Math.floor(page) || 1), total);

  // ≤ 7 页就全列；再多就只挑「首 + 当前前后各 2 + 尾」
  const nums = [];
  if (total <= 7) {
    for (let p = 1; p <= total; p += 1) nums.push(p);
  } else {
    const picked = new Set([1, total]);
    for (let p = cur - 2; p <= cur + 2; p += 1) {
      if (p >= 1 && p <= total) picked.add(p);
    }
    nums.push(...[...picked].sort((a, b) => a - b));
  }

  // 相邻页码之间断档就插一个 …
  let prev = 0;
  const cells = nums.map((p) => {
    const gap = p - prev > 1 ? '<span class="pager-gap">…</span>' : '';
    prev = p;
    return gap + `<button class="pager-num${p === cur ? ' on' : ''}" data-page="${p}"${p === cur ? ' aria-current="page"' : ''}>${p}</button>`;
  }).join('');

  return `<div class="pager">
    <button class="pager-btn" data-page="${cur - 1}"${cur <= 1 ? ' disabled' : ''}>← 上一页</button>
    ${cells}
    <button class="pager-btn" data-page="${cur + 1}"${cur >= total ? ' disabled' : ''}>下一页 →</button>
  </div>`;
}

function renderUp() {
  if (!upState) { currentView = 'discovery'; renderAll(); return; }
  const loaded = upState.list.length;
  const pageSize = upState.pageSize || 30;
  const page = Math.max(1, upState.page);
  const totalPages = Math.max(1, Math.ceil(upState.total / pageSize));

  const head = `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnUpBack">← 返回</button>
        <div class="block-title" style="margin-top:12px">${esc(upState.name)}</div>
        <div class="block-sub">${loaded ? `共 ${upState.total} 个视频 · 第 ${page} / ${totalPages} 页` : '正在读取这个 UP 主的视频…'}</div>
      </div>
      <div class="block-actions">
        ${loaded ? `<button class="ghost-btn" id="btnPlayUp">${ic('i-play')}<span>播放本页 (${loaded})</span></button>` : ''}
      </div>
    </div>`;

  if (upState.loading && !loaded) {
    content().innerHTML = head + `<div class="loading"><div class="spinner"></div>正在读取…</div>`;
    return;
  }
  if (upState.error && !loaded) {
    content().innerHTML = head + `<div class="err">读取失败：${esc(upState.error)}<br><br>
      这个接口对"未登录"比较敏感。去左下角「设置 → B 站」填一下 Cookie，再回来点作者名就好了。</div>`;
    return;
  }
  content().innerHTML = head + trackListHTML(upState.list, {
    emptyIcon: 'i-note',
    emptyText: '这个 UP 主没有公开的视频',
  }) + (upState.loading ? `<div class="loading"><div class="spinner"></div>正在读取…</div>` : '')
    + (totalPages > 1 ? paginationHTML(page, totalPages) : '');
}

/* ---------- 页面 1：搜索结果 ---------- */
let searchResults = [];
let searchKeyword = '';
let searchPage = 1;
let discoveryResults = [];
let discoveryLoading = false;
let discoveryError = '';
let discoveryPromise = null;
const discoverySearchCache = new Map();
const DISCOVERY_KEYWORDS = ['歌曲', '音乐'];
const DISCOVERY_SIZE = 12;

async function renderSearch() {
  if (!searchResults.length) {
    content().innerHTML = `<div class="empty">
      <div class="big">${ic('i-search')}</div>
      <div class="msg">输入关键词，去 B 站找歌吧</div>
      <div class="hint">也可以把 B 站链接贴到右边的框里，会自动识别合集哦</div>
    </div>`;
    return;
  }
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">“${esc(searchKeyword)}” 的搜索结果</div>
        <div class="block-sub">第 ${searchPage} 页 · 共 ${searchResults.length} 条</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayAll">${ic('i-play')}<span>播放全部</span></button>
        <button class="ghost-btn" id="btnPrevPage">← 上一页</button>
        <button class="ghost-btn" id="btnNextPage">下一页 →</button>
      </div>
    </div>
    ${trackListHTML(searchResults, { detail: true })}`;
}

async function doSearch(keyword, page = 1) {
  searchKeyword = keyword;
  searchPage = page;
  syncNavHighlight();   // 搜索结果是"临时页"，进来就把侧栏高亮清掉（不然会停在上一项）
  content().innerHTML = `<div class="loading"><div class="spinner"></div>正在 B 站搜索…</div>`;
  try {
    const res = await api('search', keyword, page);
    searchResults = res.list.map((v) => ({
      bvid: v.bvid,
      cid: null,        // 搜索结果没有 cid，播放时再补全
      page: 1,
      title: v.title,
      author: v.author,
      mid: v.mid,       // UP 主 uid，用来点开他的主页
      cover: v.cover,
      duration: parseDuration(v.duration),
    }));
    await renderSearch();
  } catch (err) {
    content().innerHTML = `<div class="err">搜索失败：${esc(err.message)}</div>`;
  }
}

function renderDiscovery() {
  currentView = 'discovery';
  if (discoveryLoading) {
    content().innerHTML = `<div class="loading"><div class="spinner"></div>正在为你发现音乐…</div>`;
    return;
  }
  if (discoveryError) {
    content().innerHTML = `<div class="err">发现失败：${esc(discoveryError)}</div><div class="block-actions discovery-retry"><button class="ghost-btn" id="btnRefreshDiscovery">重新加载</button></div>`;
    return;
  }
  if (!discoveryResults.length) {
    content().innerHTML = `<div class="empty"><div class="big">${ic('i-note')}</div><div class="msg">暂时没有发现音乐</div><div class="hint">试试刷新，稍后再来看看</div><button class="ghost-btn" id="btnRefreshDiscovery">刷新</button></div>`;
    return;
  }
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">发现</div>
        <div class="block-sub">从「歌曲」和「音乐」中随机挑选 · ${discoveryResults.length} 个视频</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayDiscovery">${ic('i-play')}<span>播放全部</span></button>
        <button class="ghost-btn" id="btnRefreshDiscovery">随机换一批</button>
      </div>
    </div>
    ${trackListHTML(discoveryResults)}`;
}

async function loadDiscovery(refresh = false) {
  currentView = 'discovery';
  if (discoveryPromise) return discoveryPromise;
  if (!refresh && discoveryResults.length) return renderDiscovery();
  discoveryLoading = true;
  discoveryError = '';
  renderDiscovery();
  discoveryPromise = (async () => {
    try {
      const batches = await Promise.all(DISCOVERY_KEYWORDS.map(async (keyword) => {
        if (!discoverySearchCache.has(keyword)) {
          const request = api('search', keyword, 1).then((res) => res.list.map((v) => ({
            bvid: v.bvid, cid: null, page: 1, title: v.title, author: v.author,
            mid: v.mid, cover: v.cover, duration: parseDuration(v.duration),
          }))).catch((err) => {
            discoverySearchCache.delete(keyword);
            throw err;
          });
          discoverySearchCache.set(keyword, request);
        }
        return discoverySearchCache.get(keyword);
      }));
      const unique = new Map();
      batches.flat().forEach((track) => { if (track.bvid && !unique.has(track.bvid)) unique.set(track.bvid, track); });
      const pool = [...unique.values()];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      discoveryResults = pool.slice(0, DISCOVERY_SIZE);
    } catch (err) {
      discoveryError = err.message || '请检查网络后重试';
    } finally {
      discoveryLoading = false;
      discoveryPromise = null;
      if (currentView === 'discovery') renderDiscovery();
    }
  })();
  return discoveryPromise;
}

/** B 站搜索返回的 duration 形如 "3:45" 或 "1:02:03" */
function parseDuration(d) {
  if (!d) return 0;
  const parts = String(d).split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/* ---------- 页面 2：解析链接（含合集自动展开） ---------- */
let parsedView = null;   // 保存当前解析出来的视频/合集信息
/**
 * 从列表点「详情」进来时记下"来路"，好原路返回。
 * 没有它的话点进详情页就出不去了（页面本身没有别的返回入口）。
 */
let parsedOrigin = null;   // { view, label, scroll }

async function doParseLink(text) {
  content().innerHTML = `<div class="loading"><div class="spinner"></div>正在解析…</div>`;
  try {
    const parsed = await api('parse', text);
    if (!parsed) {
      content().innerHTML = `<div class="err">没认出来这是什么。请粘贴 B 站视频链接，或者 BV 号（比如 BV1xx411c7mD）</div>`;
      return;
    }
    const info = await api('videoInfo', parsed.bvid);

    // 把分 P 也整理成曲目
    const pages = info.pages.map((p) => ({
      bvid: info.bvid, cid: p.cid, page: p.page,
      title: p.title, author: info.owner.name,
      cover: info.cover, duration: p.duration,
    }));

    // 合集：B 站把合集的所有集数直接放在视频详情里，我们把它摊开
    let seasonTracks = [];
    if (info.season && info.season.episodes.length) {
      seasonTracks = info.season.episodes.map((ep) => ({
        bvid: ep.bvid, cid: ep.cid, page: ep.page || 1,
        title: ep.title, author: info.owner.name,
        cover: ep.cover || info.cover, duration: ep.duration,
      }));
    }

    // 默认展示的曲目：优先合集，其次分 P
    const tracks = seasonTracks.length ? seasonTracks : pages;
    parsedView = { info, pages, seasonTracks, tracks };
    renderParsed();
  } catch (err) {
    content().innerHTML = `<div class="err">解析失败：${esc(err.message)}</div>`;
  }
}

function renderParsed() {
  const { info, pages, seasonTracks, tracks } = parsedView;
  const hasSeason = seasonTracks.length > 0;
  const isMultiP = pages.length > 1;

  // 从列表点进来 → 回原来那一页；直接粘链接解析的 → 回「发现」首页
  const backLabel = parsedOrigin
    ? `← 返回${parsedOrigin.label ? '：' + parsedOrigin.label : ''}`
    : '← 返回发现';

  content().innerHTML = `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnParsedBack">${esc(backLabel)}</button>
        <div class="block-title" style="margin-top:12px">${esc(info.title)}</div>
        <div class="block-sub">
          UP 主：${esc(info.owner.name)}
          ${hasSeason ? ` · 已识别到合集「${esc(info.season.title)}」，共 ${seasonTracks.length} 集` : ''}
          ${!hasSeason && isMultiP ? ` · 共 ${pages.length} 个分 P` : ''}
        </div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayParsed">${ic('i-play')}<span>播放全部 (${tracks.length})</span></button>
        <button class="ghost-btn" id="btnDownloadParsed">${ic('i-download')}<span>批量下载 (${tracks.length})</span></button>
        <button class="ghost-btn" id="btnAddParsed">＋ 全部加入歌单</button>
      </div>
    </div>

    ${hasSeason ? `
      <div class="card-grid" style="margin-bottom:18px">
        <div class="card" style="cursor:default">
          <div class="thumb" style="background-image:url('${esc(info.season.cover || info.cover)}')"></div>
          <div class="c-title">${esc(info.season.title)}</div>
          <div class="c-sub">${seasonTracks.length} 集 · 已自动展开</div>
        </div>
      </div>` : ''}

    ${trackListHTML(tracks, {})}`;
}

/* ---------- 页面 3：我的收藏 ---------- */
function renderFavorites() {
  currentView = 'favorites';
  const picking = !!dlPick;   // v2.8.0：正在批量勾选
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">我喜欢</div>
        <div class="block-sub">共 ${DB.favorites.length} 首</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayFav">${ic('i-play')}<span>播放全部</span></button>
        <button class="ghost-btn${picking ? ' on' : ''}" id="btnDownloadFav">${ic('i-download')}<span>${picking ? '退出批量下载' : '批量下载'}</span></button>
      </div>
    </div>
    ${picking ? dlBarHTML() : ''}
    ${trackListHTML(DB.favorites, {
      // 勾选模式下把「移除」收起来：一行里"点一下是勾选、旁边那个点一下是删掉"太容易点错
      remove: !picking,
      pick: picking,
      pickSet: picking ? dlPick.selected : null,
      emptyIcon: 'i-heart',
      emptyText: '还没有收藏任何歌',
      emptyHint: '在列表里点「收藏」，或者按播放条上的小爱心',
    })}`;
}

/* ---------- 页面 4：最近播放 ---------- */
function renderHistory() {
  currentView = 'history';
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">最近播放</div>
        <div class="block-sub">共 ${DB.history.length} 首</div>
      </div>
    </div>
    ${trackListHTML(DB.history, {
      emptyIcon: 'i-history',
      emptyText: '还没有播放记录',
    })}`;
}

/* ---------- 页面 5：某个歌单 ---------- */
function renderPlaylist(playlistId) {
  const pl = DB.playlists.find((p) => p.id === playlistId);
  if (!pl) { currentView = 'discovery'; return renderAll(); }   // 歌单没了（被删）→ 回「发现」首页
  currentView = 'playlist:' + playlistId;
  const picking = !!dlPick;   // v2.8.0：正在批量勾选
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">${esc(pl.name)}</div>
        <div class="block-sub">共 ${pl.tracks.length} 首</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayPl">${ic('i-play')}<span>播放全部</span></button>
        <button class="ghost-btn${picking ? ' on' : ''}" id="btnDownloadPl">${ic('i-download')}<span>${picking ? '退出批量下载' : '批量下载'}</span></button>
        <button class="ghost-btn" id="btnRenamePl">重命名</button>
        <button class="ghost-btn" id="btnDelPl">删除歌单</button>
      </div>
    </div>
    ${picking ? dlBarHTML() : ''}
    ${trackListHTML(pl.tracks, {
      remove: !picking,
      pick: picking,
      pickSet: picking ? dlPick.selected : null,
      emptyIcon: 'i-note',
      emptyText: '这个歌单还是空的',
      emptyHint: '去搜索页面，用「＋歌单」把歌加进来',
    })}`;
}

/* ---------- 页面 6：导入收藏夹 ---------- */
// 输入一个 B 站收藏夹链接，比如
// https://space.bilibili.com/123456/favlist?fid=789
async function doImportFav(text) {
  const m = String(text).match(/space\.bilibili\.com\/(\d+)/);
  if (!m) {
    toast('请填一个形如 space.bilibili.com/数字 的主页或收藏夹链接');
    return;
  }
  const mid = m[1];
  content().innerHTML = `<div class="loading"><div class="spinner"></div>正在读取收藏夹…</div>`;
  try {
    const folders = await api('favFolders', mid);
    if (!folders.length) {
      content().innerHTML = `<div class="err">这个 UP 主没有公开的收藏夹</div>`;
      return;
    }
    content().innerHTML = `
      <div class="block-head">
        <div>
          <div class="block-title">选择要导入的收藏夹</div>
          <div class="block-sub">共 ${folders.length} 个</div>
        </div>
      </div>
      <div class="card-grid">
        ${folders.map((f, i) => `
          <div class="card" data-fav="${f.id}">
            <div class="thumb${f.cover ? '' : ' no-cover'}"${f.cover ? ` style="background-image:url('${esc(f.cover)}')"` : ''}></div>
            <div class="c-title">${esc(f.title)}</div>
            <div class="c-sub">${f.count} 个视频</div>
          </div>`).join('')}
      </div>`;
    // 点卡片 → 加载里面的视频
    content().querySelectorAll('[data-fav]').forEach((el) => {
      el.addEventListener('click', () => loadFavItems(el.dataset.fav));
    });
  } catch (err) {
    content().innerHTML = `<div class="err">读取失败：${esc(err.message)}</div>`;
  }
}

async function loadFavItems(mediaId) {
  content().innerHTML = `<div class="loading"><div class="spinner"></div>正在读取内容…</div>`;
  try {
    const res = await api('favMedias', mediaId, 1);
    const tracks = res.list.map((m) => ({
      bvid: m.bvid, cid: null, page: 1,
      title: m.title, author: '', cover: m.cover, duration: m.duration,
    }));
    parsedView = { info: { title: '收藏夹', owner: { name: '' } }, pages: tracks, seasonTracks: [], tracks };
    renderParsed();
  } catch (err) {
    content().innerHTML = `<div class="err">读取失败：${esc(err.message)}</div>`;
  }
}

/* ============================================================
   页面 7：导入我的 B 站收藏夹（v2.6.0）
   ------------------------------------------------------------
   侧栏「我的歌单」那一行、＋ 左边那个按钮进来的整页。三步：
       选来源（我的投稿 / 我的收藏夹） → 选收藏夹 → 挑视频 → 起名落地
   ★ 和上面「页面 6：导入收藏夹」的分工（两套都留着，别互相顶掉）：
       · 页面 6（旧的）：**别人的**收藏夹 —— 粘一个 space.bilibili.com/xxx 链接，要手填 uid；
       · 页面 7（这个）：**自己的**收藏夹 —— 点一下，myinfo 自动认出你是谁，
         连私密收藏夹都列得出来（那是本人登录才看得见的）。
   ============================================================ */

/**
 * 导入页的全部状态。
 *
 * ★★ 这个功能最容易做错的地方就是 `selected`：**它是跨收藏夹累积的**。
 *    在收藏夹 A 里挑 3 个 → 回列表 → 进收藏夹 B 再挑 2 个 → 最后一起导入成**一个**歌单。
 *
 *    所以 `selected` 是独立于"当前在看哪一页 / 哪一个收藏夹"的一等状态，三条铁律：
 *      1. **只有两件事会清空它**：导入成功之后、用户点「清空选择」。
 *         翻页 / 换收藏夹 / 返回列表 / 回到来源选择 —— 一律不动它。
 *      2. 进任何一个收藏夹时，行的勾选状态**从 selected 反查**（`selected.has(bvid)`）——
 *         所以同一个视频出现在两个收藏夹里时，第二次进去它已经是勾上的，**不会重复计数**。
 *      3. `from` 记着"这一条是从哪儿选的"，用来算收藏夹卡片上的「已选 N」角标。
 *
 *    为什么是 Map 而不是数组：B 站收藏夹里同一个视频可以同时存在于多个收藏夹，
 *    用 bvid 当键**天然去重**；数组就得自己写一遍 find + 判重。
 *
 *    shape: { step, me, loading, error, errorReason, folders,
 *             source, folderId, folderName, list, page, pageSize, total, selected }
 *      step       : 'home' | 'folders' | 'list'
 *      me         : { mid, name, face } —— myinfo 拿到的
 *      errorReason: '' | 'no-cookie' | 'cookie-expired'（这两种要整页给引导）
 *      source     : 'up'（我的投稿）| 'fav'（某个收藏夹）
 *      selected   : Map<bvid, { track, from }>   from = 收藏夹 id 或 'up'
 */
let impState = null;

/** 进入导入页（从侧栏按钮进来）—— 全新一次，选择集重新开一个 */
function openImportMine() {
  impState = {
    step: 'home',
    me: null,
    loading: true,
    error: '',
    errorReason: '',
    folders: [],
    source: 'up',
    folderId: '',
    folderName: '',
    list: [],
    page: 0,
    pageSize: 30,
    total: 0,
    selected: new Map(),
  };
  currentView = 'importMine';
  renderImportMine();
  content().scrollTop = 0;
  loadMyInfo();
}

/**
 * 认出"你是谁"。
 *
 * ★ 先问 `hasCookie` 再问 `myInfo` —— 没填 Cookie 时**根本不发 myinfo 请求**。
 *   和字幕那条一样的规矩：既然注定拿不到，就别白跑一趟、白挨一次限流。
 *   后端 `getMyInfo()` 里也有一道同样的闸（双保险）。
 */
async function loadMyInfo() {
  if (!impState) return;
  try {
    const has = await api('hasCookie');
    if (!impState) return;
    if (!has) {
      impState.errorReason = 'no-cookie';
      return;                       // 下面的 finally 会把 loading 关掉并重画
    }
    impState.me = await api('myInfo');
    impState.error = '';
    impState.errorReason = '';
  } catch (err) {
    if (!impState) return;
    impState.error = err.message || '认不出你是谁';
    impState.errorReason = err.reason || '';
  } finally {
    if (impState) {
      impState.loading = false;
      renderImportMine();
    }
  }
}

/** 换"屏"（step 变了）→ 重画并回到顶部 */
function impGo(step) {
  if (!impState) return;
  impState.step = step;
  renderImportMine();
  content().scrollTop = 0;
}

/** 重画导入页但**保留滚动位置** —— 勾选 / 全选这种不该把人弹回顶部 */
function impRerender() {
  if (!impState) return;
  const top = content().scrollTop;
  renderImportMine();
  content().scrollTop = top;
}

/** 顶部的「← 返回」——★ 返回**不清空选择**（这是跨收藏夹累积能成立的前提） */
function impBack() {
  if (!impState) return;
  if (impState.step === 'list' && impState.source === 'fav') { impGo('folders'); return; }
  if (impState.step === 'list' || impState.step === 'folders') { impGo('home'); return; }
  // 已经在来源选择页了 → 再返回就是离开这个页面
  currentView = 'discovery';
  renderAll();
}

/** 带「← 返回」的页头（导入页三屏共用） */
function impSimpleHead(title, sub = '') {
  return `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnImpBack">← 返回</button>
        <div class="block-title" style="margin-top:12px">${esc(title)}</div>
        ${sub ? `<div class="block-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
}

/**
 * 「已选 N 个 · 清空选择 · 导入选中的 N 个」工具条。
 * 收藏夹列表屏和挑视频屏共用 —— 用户在哪一屏都能看到"我现在选了多少"。
 * 已选 0 个时「导入」置灰（disabled 的按钮在浏览器里连 click 都不派发，天然点不动）。
 */
function impBarHTML() {
  const n = impState ? impState.selected.size : 0;
  return `
    <div class="imp-bar">
      <span class="imp-count">已选 <b>${n}</b> 个</span>
      <span class="imp-bar-actions">
        <button class="ghost-btn" id="btnImpClear"${n ? '' : ' disabled'}>清空选择</button>
        <button class="primary-btn" id="btnImpDo"${n ? '' : ' disabled'}>导入选中的 ${n} 个</button>
      </span>
    </div>`;
}

/** 没填 Cookie / Cookie 过期 —— 整页给引导，不留白屏 */
function impBlockedHTML() {
  const expired = impState.errorReason === 'cookie-expired';
  return `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnImpBack">← 返回</button>
        <div class="block-title" style="margin-top:12px">从 B 站导入</div>
      </div>
    </div>
    <div class="empty">
      <div class="big">${ic('i-import')}</div>
      <div class="msg">${expired ? 'Cookie 好像过期了' : '这个功能要用你自己的 B 站账号'}</div>
      <div class="hint">${expired
        ? '去左下角「设置 → B 站」重新粘一次 Cookie，再回来点这个按钮。'
        : '去左下角「设置 → B 站」填一下 Cookie，再回来点这个按钮 —— 填了才能认出你是谁，也才看得到你自己的收藏夹（包括私密的）。'}</div>
    </div>`;
}

/** 按当前状态画导入页 */
function renderImportMine() {
  if (!impState) { currentView = 'discovery'; renderAll(); return; }

  // ① 没填 Cookie / Cookie 过期：整页引导（不会去白跑 myinfo，见 loadMyInfo）
  if (impState.errorReason === 'no-cookie' || impState.errorReason === 'cookie-expired') {
    content().innerHTML = impBlockedHTML();
    return;
  }
  // ② 还没认出"你是谁"
  if (!impState.me) {
    content().innerHTML = impSimpleHead('从 B 站导入') + (impState.error
      ? `<div class="err">${esc(impState.error)}</div>`
      : `<div class="loading"><div class="spinner"></div>正在认出你是谁…</div>`);
    return;
  }
  // ③ 认出来了 → 按 step 画
  if (impState.step === 'folders') return renderImpFolders();
  if (impState.step === 'list') return renderImpList();
  return renderImpHome();
}

/* ---------- 屏 2：选来源 ---------- */
function renderImpHome() {
  content().innerHTML = `
    ${impSimpleHead('从 B 站导入', `已识别：${impState.me.name} · UID ${impState.me.mid}`)}
    <div class="src-grid">
      <div class="src-card" id="btnImpUp">
        <div class="sc-ic">${ic('i-note')}</div>
        <div>
          <div class="sc-t">我的投稿</div>
          <div class="sc-s">按发布时间列出你投稿的全部视频</div>
        </div>
      </div>
      <div class="src-card" id="btnImpFav">
        <div class="sc-ic">${ic('i-heart')}</div>
        <div>
          <div class="sc-t">我的收藏夹</div>
          <div class="sc-s">整个收藏夹导入，或者进去一个一个挑</div>
        </div>
      </div>
    </div>
    ${impState.selected.size ? impBarHTML() : ''}`;
}

/* ---------- 屏 3：收藏夹列表 ---------- */
function openImpFolders() {
  if (!impState) return;
  impGo('folders');
  loadImpFolders();
}

async function loadImpFolders() {
  if (!impState) return;
  impState.loading = true;
  impState.error = '';
  renderImportMine();
  try {
    impState.folders = await api('favFolders', impState.me.mid) || [];
  } catch (err) {
    impState.folders = [];
    impState.error = err.message || '读取收藏夹失败';
  } finally {
    if (impState) {
      impState.loading = false;
      renderImportMine();
    }
  }
}

/** 一张收藏夹卡片。右下角：「整个导入」/「取消整个收藏夹」+ 已选角标 */
function impFolderCardHTML(f) {
  const from = String(f.id);
  const picked = [...impState.selected.values()].filter((v) => v.from === from).length;
  // 已经"整个都选上"了 → 按钮换成"取消整个收藏夹"
  const isWhole = (f.count || 0) > 0 && picked >= f.count;
  return `
    <div class="card" data-imp-folder="${esc(from)}">
      <div class="thumb${f.cover ? '' : ' no-cover'}"${f.cover ? ` style="background-image:url('${esc(f.cover)}')"` : ''}></div>
      <div class="c-title">${esc(f.title)}${f.private ? '<span class="c-priv">私密</span>' : ''}</div>
      <div class="c-sub">${f.count} 个视频</div>
      <div class="c-foot">
        ${picked ? `<span class="c-sel">已选 ${picked}</span>` : ''}
        <button class="c-pick${isWhole ? ' on' : ''}" data-imp-whole="${esc(from)}"${f.count > 0 ? '' : ' disabled'}>${isWhole ? '取消整个收藏夹' : '整个导入'}</button>
      </div>
    </div>`;
}

function renderImpFolders() {
  const n = impState.folders.length;
  const head = impSimpleHead(`我的收藏夹${n ? ' · ' + n + ' 个' : ''}`);
  if (impState.loading && !n) {
    content().innerHTML = head + impBarHTML() + `<div class="loading"><div class="spinner"></div>正在读取你的收藏夹…</div>`;
    return;
  }
  if (impState.error && !n) {
    content().innerHTML = head + impBarHTML() + `<div class="err">读取失败：${esc(impState.error)}</div>`;
    return;
  }
  if (!n) {
    content().innerHTML = head + impBarHTML() + `<div class="empty">
      <div class="big">${ic('i-heart')}</div>
      <div class="msg">你的 B 站账号下没有收藏夹</div>
      <div class="hint">在 B 站网页上建一个收藏夹，再回来点这个按钮就能看到。</div>
    </div>`;
    return;
  }
  content().innerHTML = head + impBarHTML()
    + `<div class="card-grid">${impState.folders.map(impFolderCardHTML).join('')}</div>`;
}

/* ---------- 屏 4：挑视频 ---------- */
function openImpUp() {
  if (!impState) return;
  impState.source = 'up';
  impState.folderId = '';
  impState.folderName = '我的投稿';
  impState.list = [];
  impState.page = 0;
  impState.total = 0;
  impGo('list');
  loadImpList(1);
}

function openImpFolder(id) {
  if (!impState) return;
  const f = impState.folders.find((x) => String(x.id) === String(id));
  impState.source = 'fav';
  impState.folderId = String(id);
  impState.folderName = f ? f.title : '收藏夹';
  impState.list = [];
  impState.page = 0;
  impState.total = (f && f.count) || 0;
  impGo('list');
  loadImpList(1);
}

/** 把后端返回的一条视频转成"曲目"对象 */
function impTrackOf(v, source, mid) {
  if (source === 'up') {
    // 空间接口的 duration 是 "3:45" 这种字符串，得换算成秒
    return {
      bvid: v.bvid, cid: null, page: 1,
      title: v.title, author: v.author || '', mid: v.mid || mid,
      cover: v.cover || '', duration: parseDuration(v.duration),
    };
  }
  // 收藏夹接口的 duration 已经是秒数
  return {
    bvid: v.bvid, cid: null, page: 1,
    title: v.title, author: '', cover: v.cover || '', duration: v.duration || 0,
  };
}

/** 拉导入页的第 pn 页（我的投稿 / 某个收藏夹，同一个屏） */
async function loadImpList(pn) {
  if (!impState || !impState.me) return;
  impState.loading = true;
  impState.error = '';
  renderImportMine();
  try {
    const res = impState.source === 'up'
      ? await api('upVideos', impState.me.mid, pn)
      : await api('favMedias', impState.folderId, pn);
    impState.list = (res.list || []).map((v) => impTrackOf(v, impState.source, impState.me.mid));
    impState.page = pn;
    impState.pageSize = res.pageSize || impState.pageSize || 30;
    // 总数：后端给得出就用后端的；收藏夹接口偶尔给 0，就退回卡片上那个数字
    const known = impState.source === 'fav'
      ? ((impState.folders.find((x) => String(x.id) === String(impState.folderId)) || {}).count || 0)
      : 0;
    impState.total = res.total || known || impState.list.length;
  } catch (err) {
    impState.error = err.message || '读取失败';
  } finally {
    if (impState) {
      impState.loading = false;
      impRerender();
    }
  }
}

function renderImpList() {
  const loaded = impState.list.length;
  const pageSize = impState.pageSize || 30;
  const page = Math.max(1, impState.page);
  const totalPages = Math.max(1, Math.ceil(impState.total / pageSize));
  const isUp = impState.source === 'up';

  const sub = impState.total
    ? `共 ${impState.total} 个视频 · 第 ${page} / ${totalPages} 页`
    : (loaded ? `本页 ${loaded} 个` : '正在读取…');

  const head = `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnImpBack">← 返回</button>
        <div class="block-title" style="margin-top:12px">${esc(impState.folderName)}</div>
        <div class="block-sub">${esc(sub)}</div>
      </div>
      <div class="block-actions">
        ${loaded ? `<button class="ghost-btn" id="btnImpPickAll">全选本页</button>
        <button class="ghost-btn" id="btnImpPickNone">全不选本页</button>` : ''}
        ${isUp ? '<button class="ghost-btn" id="btnImpWholeUp">导入全部投稿</button>' : ''}
      </div>
    </div>`;

  if (impState.loading && !loaded) {
    content().innerHTML = head + impBarHTML() + `<div class="loading"><div class="spinner"></div>正在读取…</div>`;
    return;
  }
  if (impState.error && !loaded) {
    content().innerHTML = head + impBarHTML() + `<div class="err">读取失败：${esc(impState.error)}</div>`;
    return;
  }
  content().innerHTML = head + impBarHTML()
    + trackListHTML(impState.list, {
        // ★ 挑歌模式：左边换成复选框、右侧那排操作按钮藏掉、点整行 = 勾选
        pick: true, expand: false,
        emptyIcon: isUp ? 'i-note' : 'i-heart',
        emptyText: isUp ? '你还没有投稿过视频' : '这个收藏夹里没有视频',
      })
    // 分页条直接复用 v2.5.0 的（同一个函数，别再抄一份）
    + (totalPages > 1 ? paginationHTML(page, totalPages) : '');
}

/* ---------- 选择集操作 ---------- */

/** 勾 / 取消勾一行（点整行或点复选框都走这里 —— 只有一条代码路径） */
function impToggle(i) {
  if (!impState) return;
  const t = impState.list[i];
  if (!t || !t.bvid) return;
  if (impState.selected.has(t.bvid)) {
    impState.selected.delete(t.bvid);
  } else {
    impState.selected.set(t.bvid, { track: t, from: impState.source === 'fav' ? impState.folderId : 'up' });
  }
  impRerender();
}

/** 本页的当前来源标记（'up' 或收藏夹 id） */
function impFrom() {
  return impState.source === 'fav' ? impState.folderId : 'up';
}

/** 全选本页 */
function impPickAll() {
  if (!impState) return;
  const from = impFrom();
  impState.list.forEach((t) => {
    if (t.bvid) impState.selected.set(t.bvid, { track: t, from });
  });
  impRerender();
}

/** 全不选本页（只影响这一页，别的收藏夹选的不动） */
function impPickNone() {
  if (!impState) return;
  impState.list.forEach((t) => { if (t.bvid) impState.selected.delete(t.bvid); });
  impRerender();
}

/** 清空选择（唯一会整体清掉的两个入口之一，另一个是导入成功） */
function impClear() {
  if (!impState) return;
  impState.selected.clear();
  impRerender();
}

/**
 * 把"整个来源"逐页拉下来，全部塞进选择集。
 * 逐页是**必须**的 —— 接口一次只给 30 条，没有"一次给全部"的用法。
 * @param {'fav'|'up'} source
 * @param {string|number} id 收藏夹 id（fav）或 mid（up）
 * @param {number} total     已知总数（估页数用；估错了靠 hasMore 兜底）
 * @param {string} from      选择集里的来源标记
 * @returns {Promise<number>} 新加进去的条数
 */
async function impFetchAll(source, id, total, from) {
  const pageSize = 30;
  const cap = 20;   // 最多自动翻 20 页（600 首）。再多就请用户进去逐页挑，别把接口刷爆
  const pages = Math.min(Math.max(1, Math.ceil((total || 0) / pageSize)), cap);
  let added = 0;
  for (let p = 1; p <= pages; p += 1) {
    const res = source === 'fav'
      ? await api('favMedias', id, p)
      : await api('upVideos', id, p);
    (res.list || []).forEach((v) => {
      const t = impTrackOf(v, source, id);
      if (!t.bvid) return;
      if (!impState.selected.has(t.bvid)) {
        impState.selected.set(t.bvid, { track: t, from });
        added += 1;
      }
    });
    if (!res.hasMore) break;   // 页数估多了（count 不准）→ 提前收工
  }
  return added;
}

/** 卡片右下角：整个导入 / 取消整个收藏夹 */
async function impWholeFolder(folder) {
  if (!impState || !folder) return;
  const from = String(folder.id);
  const picked = [...impState.selected.values()].filter((v) => v.from === from).length;
  if ((folder.count || 0) > 0 && picked >= folder.count) {
    // 已经整个选上了 → 这一步是"取消整个收藏夹"
    [...impState.selected.keys()].forEach((k) => {
      if (impState.selected.get(k).from === from) impState.selected.delete(k);
    });
    toast(`已取消「${folder.title}」的 ${picked} 首`);
    impRerender();
    return;
  }
  if (!(folder.count > 0)) { toast('这个收藏夹里没有视频'); return; }
  toast(`正在把「${folder.title}」整个读进来…`);
  try {
    const added = await impFetchAll('fav', folder.id, folder.count, from);
    toast(added ? `已把「${folder.title}」整个选上（新加 ${added} 个）` : `「${folder.title}」已经整个选上了`);
  } catch (err) {
    toast('读取失败：' + (err.message || ''));
  }
  impRerender();
}

/** 「导入全部投稿」（我的投稿那一屏的快捷入口） */
async function impWholeUp() {
  if (!impState || impState.source !== 'up' || !impState.me) return;
  toast('正在把你的投稿全部读进来…');
  try {
    const added = await impFetchAll('up', impState.me.mid, impState.total, 'up');
    toast(added ? `已选上你的全部投稿（新加 ${added} 个）` : '你的投稿都已经选上了');
  } catch (err) {
    toast('读取失败：' + (err.message || ''));
  }
  impRerender();
}

/**
 * 新歌单的默认名字。
 * 只在一个收藏夹里挑的 → 用收藏夹名；跨收藏夹 / 我的投稿 → 「我的收藏」。
 */
function impDefaultName() {
  const froms = new Set([...impState.selected.values()].map((v) => v.from));
  if (froms.size === 1) {
    const only = [...froms][0];
    if (only !== 'up') {
      const f = impState.folders.find((x) => String(x.id) === String(only));
      if (f) return f.title;
    }
    return '我的投稿';
  }
  return '我的收藏';
}

/* ---------- 屏 5：命名 + 落地 ---------- */
async function importPicked() {
  if (!impState) return;
  const picked = [...impState.selected.values()].map((v) => v.track);
  if (!picked.length) { toast('还没选任何视频'); return; }

  const name = await askName('新建歌单', impDefaultName(), '导入');
  if (!name) return;

  const pl = { id: uid(), name, tracks: picked };
  DB.playlists.push(pl);
  await persist();
  // ★ 导入成功 = 选择集该清空的时刻之一（另一个是「清空选择」）
  impState.selected.clear();
  toast(`已导入 ${picked.length} 首到新歌单「${name}」`);
  // 跳到刚建好的歌单（走 renderAll 才会把侧栏的歌单列表一起刷出来）
  currentView = 'playlist:' + pl.id;
  renderAll();
}

/* ============================================================
   第 4.7 部分：下载（v2.8.0）
   ------------------------------------------------------------
   四个下载入口（歌曲行内 / 播放条 / 歌单与喜欢的批量 / 合集选集）都汇到
   enqueueDownloads() 这一个函数，再由它调主进程的 download:add。

   任务状态、进度、完成通知**全部由主进程推回来**
   （download:changed / download:progress / download:finished），这边只维护一份镜像 + 重画。

   ★ 为什么任务状态不放 DB（neko-data.json）：那个文件已经 6MB 了，而进度每 300ms 变一次，
     写进去等于每 300ms 序列化并落盘 6MB。任务状态归主进程的 downloads.json。
   ============================================================ */

/** 字节数 → "1.2 MB"。下载管理页显示速度、体积都用它。 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/** 目录 + 文件名 → 完整路径。渲染层没有 path 模块，自己拼（本项目只跑 Windows）。 */
function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return d + '\\' + String(name || '');
}

/** 重画当前页但**保留滚动位置** —— 勾选 / 全选这种不该把人弹回顶部 */
function rerenderKeepScroll() {
  const top = content().scrollTop;
  renderAll();
  content().scrollTop = top;
}

/** 重算「已下载」的 key 集合。DB.local 或任务表一变就得调一次。 */
function rebuildDlKeys() {
  const s = new Set();
  for (const e of (DB.local || [])) if (e && e.key) s.add(String(e.key));
  for (const t of dlTasks) if (t && t.key && t.status === 'done') s.add(String(t.key));
  dlKeys = s;
}

/* ★★ v2.8.0 修订：失联文件体检（真机反馈 —— 在资源管理器里直接删文件后，绿勾还在，
   再点还显示「已下载」不肯重下）。

   根因：rebuildDlKeys() 是**纯字符串**运算，从头到尾没查过磁盘 —— 它只认
   DB.local 与已完成任务表里那两条记录。文件被外部删掉后记录还在，于是绿勾一直挂着；
   而点「已下载」走的是 download:reveal（开文件夹），不是重新入队 → 点多少次都不重下。

   所以补一道体检：拿现成的 local:stat（main.js:1232）问一遍"这些路径还在不在"，
   把 exists:false 的条目从 DB.local 里剔掉，再重算绿勾。

   ★ 三个节制点：
     ① **60 秒节流** —— 切换视图会频繁调它，每次都发 IPC 问一遍磁盘没必要。
     ② **只在有东西可查时才发** —— 空库直接返回，不发空请求。
     ③ **只在真的删掉了条目时才落盘** —— 免得白白写那个 6MB 的存档。

   ★ 为什么"删 DB.local 里的数据条目"是允许的：store-migrate.js 那条「只许补、不许删」
     管的是**结构字段定义**（dir / concurrent 这些字段不能悄悄删掉，否则老存档读不出来）。
     数据条目本来就该随用户的删除而消失 —— 下载管理里的「删除」早就在干这件事了。
     凡是被剔掉的 key，顺手把已完成任务也从任务表里清掉，两边保持一致。 */
let localSweepAt = 0;          // 上次体检的时间戳（节流用）
let localSweepBusy = false;

async function sweepMissingLocal(force) {
  const now = Date.now();
  // ① 60 秒内且不是强制 → 直接跳过。切视图那几次够用了，别每次都摸盘
  if (!force && now - localSweepAt < 60000) return 0;
  if (localSweepBusy) return 0;          // 上一次还没回来，别叠着发
  const list = Array.isArray(DB.local) ? DB.local.filter((e) => e && e.path) : [];
  if (!list.length) { localSweepAt = now; return 0; }   // ② 空库不查

  localSweepBusy = true;
  let gone = [];
  try {
    const res = await api('localStat', list.map((e) => e.path));
    const arr = Array.isArray(res) ? res : [];
    // 建立"路径 → 还在不在"的表。★ 主进程逐条返回，顺序与传入一致，
    //   但这里按 path 建表而不是按下标 —— 万一以后主进程改了顺序也不会错删。
    const alive = new Map();
    for (const r of arr) if (r && r.path) alive.set(String(r.path), r.exists === true);
    for (const e of list) {
      // ★ 查不到的那条**当它还活着** —— 宁可多留一个绿勾，也不能因为一次查询遗漏
      //   就把用户的下载记录误删（那才是真正找不回来的损失）。
      const exists = alive.has(String(e.path)) ? alive.get(String(e.path)) : true;
      if (!exists) gone.push(e);
    }
  } catch (err) {
    // 问不到就当没体检过：不清、不提示。下次进视图再试
    console.error('检查本地文件是否还在失败', err);
    localSweepBusy = false;
    return 0;
  }
  localSweepAt = now;
  localSweepBusy = false;
  if (!gone.length) return 0;

  const gonePaths = new Set(gone.map((e) => String(e.path)));
  const goneKeys = new Set(gone.filter((e) => e.key).map((e) => String(e.key)));
  DB.local = (DB.local || []).filter((e) => !e || !gonePaths.has(String(e.path)));

  // 已完成任务表里那些对应的也清掉 —— 否则绿的来源从任务表那边又冒出来
  if (goneKeys.size) {
    let removed = false;
    for (const t of dlTasks) {
      if (t && t.status === 'done' && t.key && goneKeys.has(String(t.key))) {
        t.status = 'gone'; removed = true;      // 界面不显示这种状态，等同于删除
      }
    }
    if (removed) dlTasks = dlTasks.filter((t) => t.status !== 'gone');
  }
  rebuildDlKeys();
  persistLater();                 // ③ 只有真删了东西才落盘
  return gone.length;
}

/**
 * 给单条本地记录做一次即时体检。
 * ★ 与 sweepMissingLocal 的区别：这个是"点它那一刻"用的，**不节流、不看缓存** ——
 *   要的就是"现在这一刻磁盘上到底有没有"。返回 true = 文件还在。
 *
 * ★ 关键：问不到（IPC 挂了 / 超时）时返回 **true**（当它还活着）。
 *   理由同上 —— 宁可让用户点一下开文件夹失败，也不能因为一次查询异常
 *   就把他明明还在的下载记录清掉。
 */
async function localFileAlive(entry) {
  if (!entry || !entry.path) return false;
  try {
    const res = await api('localStat', [entry.path]);
    const r = Array.isArray(res) ? res[0] : null;
    if (!r) return true;
    return r.exists === true;
  } catch (err) {
    console.error('检查单个本地文件失败', err);
    return true;
  }
}

/**
 * 找出某一首歌在本地库里的那条记录（没有就 null）。
 * ★ 匹配方式：优先用 key（bvid:cid，最可靠）；key 没有时退回比路径。
 *   注意下载条目**一定有 key**（downloader 落盘时写进去的），
 *   手动导入的条目才可能没有 key —— 那种本来也不参与"已下载"判定。
 */
function findLocalEntryOf(track) {
  if (!track || !track.bvid || !track.cid) return null;
  const key = track.bvid + ':' + String(track.cid);
  return (DB.local || []).find((e) => e && e.key && String(e.key) === key) || null;
}

/**
 * 绿勾被点那一刻的兜底（真机反馈的核心一条）。
 *
 * 原逻辑：已下载 → 直接 download:reveal 去开文件夹。外部删了文件后，
 * reveal 抛「文件不在了」，界面只弹一句报错，**然后什么都不做** ——
 * 用户得自己去下载管理里删掉那条记录才能重下。
 *
 * 新逻辑：先 stat 一次，
 *   · 文件还在  → 照旧开文件夹（原行为不变）
 *   · 文件没了  → 静默把失效记录剔掉（本地库 + 已完成任务），
 *                 重算绿勾 → 行内按钮**立刻变回下载箭头**，
 *                 并把这首歌**直接加进下载队列**（Neo 要的"能重新下"）
 */
async function revealOrRedownload(track, task) {
  const entry = findLocalEntryOf(track);
  const path = (entry && entry.path) || (task && task.file && dlDir ? joinPath(dlDir, task.file) : '');
  const alive = path ? await localFileAlive({ path }) : true;

  if (alive) {
    try {
      await api('downloadReveal', entry ? entry.path : (task && task.file));
    } catch (err) {
      toast(err.message || '找不到这个文件');
    }
    return;
  }

  // ---- 文件真的没了 ----
  // ① 清本地库那条（绿勾的第一来源）
  if (entry) {
    DB.local = (DB.local || []).filter((e) => e !== entry);
    persistLater();
  }

  // ② 清"已完成任务"那条（绿勾的第二来源）。
  //   ★ 不能只看界面这份 dlTasks 镜像 —— 它可能是空的（清过 downloads.json，
  //     或者这次会话还没拉到任务表）。所以**直接问主进程要一份全量**再挑出同 key 的。
  const key = track.bvid + ':' + String(track.cid);
  let candidates = dlTasks.filter((t) => t && t.status === 'done' && String(t.key) === key);
  if (!candidates.length) {
    try {
      const r = await api('downloadList');
      const all = Array.isArray(r && r.tasks) ? r.tasks : [];
      candidates = all.filter((t) => t && t.status === 'done' && String(t.key) === key);
    } catch (_) { /* 问不到就算了，下面照样重下 */ }
  }
  for (const t of candidates) {
    // 文件已经不在，这条"已完成"记录没有任何意义了。删掉它（deleteFile 传 false ——
    // 文件本来就没了，别让主进程去删一个不存在的路径）。
    // ★ 这一步很关键：主进程的 localKeys（它判"已下过"用的）是界面存档驱动的，
    //   界面清了存档之后它下次 save 会跟着对齐；但它的 downloads.json 里那条
    //   带 skipExisting 的"已完成"记录必须主动删掉，否则重下会被它拦下来说"本地已有"。
    try { await api('downloadRemove', [t.id], false); } catch (_) { /* 失败也不影响重下 */ }
  }
  if (candidates.length) {
    const ids = new Set(candidates.map((t) => t.id));
    dlTasks = dlTasks.filter((t) => !ids.has(t.id));
  }

  rebuildDlKeys();
  renderAll();                       // 行内绿勾 → 立刻变回下载箭头
  toast('本地文件已不在了，已清掉这条记录，重新下载中…');
  enqueueDownloads([track]);         // ★ 直接重下，用户不用自己去下载管理删
}

/** 这首歌是不是已经在本地库里了（行内按钮 / 播放条按钮据此变成绿勾）。 */
function isDownloaded(track) {
  if (!track || !track.bvid || !track.cid) return false;
  return dlKeys.has(track.bvid + ':' + String(track.cid));
}

/** 这首歌对应的下载任务（没有就 null）。cid 还没补齐时判不出来 —— 那就当没有。 */
function taskForTrack(track) {
  if (!track || !track.bvid || !track.cid) return null;
  const key = track.bvid + ':' + String(track.cid);
  return dlTasks.find((x) => x.key === key) || null;
}

/**
 * 按任务表算统计。
 * ★ 用"自己算"而不是取主进程返回的 stats：`download:changed` 那条推送只带任务表、
 *   不带 stats，两处各留一份迟早会漂。规则和主进程 downloader.stats() 一致。
 */
function computeDlStats() {
  const st = { done: 0, running: 0, failed: 0, queued: 0, paused: 0, bytes: 0, total: dlTasks.length };
  for (const t of dlTasks) {
    if (t.status === 'done')             { st.done++;    st.bytes += t.received || 0; }
    else if (t.status === 'downloading') { st.running++; st.bytes += t.received || 0; }
    else if (t.status === 'failed')      st.failed++;
    else if (t.status === 'paused')      { st.paused++;  st.bytes += t.received || 0; }
    else if (t.status === 'queued')      st.queued++;
  }
  return st;
}

/** 侧栏「下载管理」上的角标：还有几个没下完（0 个就藏起来）。 */
function syncDlBadge() {
  const el = $('dlBadge');
  if (!el) return;
  const n = dlStats ? (dlStats.running + dlStats.queued + dlStats.paused) : 0;
  el.textContent = n > 99 ? '99+' : String(n);
  el.hidden = n <= 0;
}

/** 拉一次全量任务列表（打开下载管理页 / 每次操作之后调） */
async function refreshDownloads() {
  try {
    const r = await api('downloadList');
    dlTasks = Array.isArray(r.tasks) ? r.tasks : [];
    dlDir = r.dir || null;
  } catch (err) {
    console.error('读取下载列表失败', err);
  }
  dlStats = computeDlStats();
  rebuildDlKeys();
  syncDlBadge();
}

/**
 * 弹"选个文件夹存下载"。返回 true = 选好了可以继续下；false = 用户取消 / 目录用不了。
 *
 * ★ 选完必须**同时**告诉两边，漏一边就会出现"设置里显示对了、下载还是报没目录"：
 *   · 界面写进 DB.settings.download.dir（存档归界面管，主进程不碰 neko-data.json）
 *   · 主进程收到 downloadSetDir，好让**这一次**立刻就能下（它不读存档，只看内存里那份）
 */
async function openDownloadPicker() {
  let res;
  try { res = await api('downloadPickDir'); }
  catch (err) { toast('选目录失败：' + (err.message || '')); return false; }
  if (!res || !res.dir) return false;                     // 用户点了取消
  try { await api('downloadSetDir', res.dir); }
  catch (err) { toast('这个文件夹用不了：' + (err.message || '')); return false; }

  if (!DB.settings.download) DB.settings.download = Object.assign({}, DOWNLOAD_DEFAULTS);
  DB.settings.download.dir = res.dir;
  dlDir = res.dir;
  await persist();          // 存了 → 主进程 refreshLibraryCache 也会跟着对齐
  syncSettingsUI();         // 设置面板里那个"当前下载目录"跟着变（面板没开着也无害）
  toast('下载位置已设为 ' + res.dir);
  return true;
}

/**
 * 把一批曲目丢进下载队列 —— 四个下载入口的唯一汇合点。
 *
 * ★ 为什么必须先逐首补齐 cid：下载引擎要 `bvid + cid` 两个都在才肯排，
 *   而收藏夹 / 歌单里的歌经常只有 bvid（搜出来直接加歌单、从没播过，cid 一直是空的）。
 *   补 cid 一首一次网络请求，所以串行做，并如实报出"有几首取不到"——
 *   不能让一首失败把整批带崩，也不能假装全都排上了。
 *
 * @param {Array} tracks
 * @param {{jump?:boolean}} [opts] jump=false 时不跳到「下载管理」（合集面板里下载时用）
 */
async function enqueueDownloads(tracks, opts = {}) {
  const jump = opts.jump !== false;
  const list = (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => t && t.bvid);
  if (!list.length) { toast('这里没有可以下载的曲目'); return; }

  // ① 还没选过下载目录 → 先弹窗选。Neo 定的行为：不预设目录，第一次下载时才问。
  if (!(DB.settings.download && DB.settings.download.dir)) {
    const ok = await openDownloadPicker();
    if (!ok) return;
  }

  // ② 补齐 cid（已经有了的直接跳过）
  const ready = [];
  let failed = 0;
  if (list.length > 1) toast(`正在准备 ${list.length} 首…`);
  for (const t of list) {
    if (!t.cid) {
      try { await ensureCid(t); } catch (_) { /* 视频被删 / 是番剧 → 算取不到 */ }
    }
    if (t.cid) ready.push(t); else failed++;
  }
  if (!ready.length) { toast('这些曲目都取不到下载地址'); return; }

  // ③ 交给主进程排队
  let res;
  try {
    res = await api('downloadAdd', ready);
  } catch (err) { toast('加入下载失败：' + (err.message || '')); return; }

  if (res.needDir) {
    // 目录在两次调用之间被删了 → 再给用户一次机会
    const ok = await openDownloadPicker();
    if (!ok) return;
    try { res = await api('downloadAdd', ready); }
    catch (err) { toast('加入下载失败：' + (err.message || '')); return; }
  }

  const parts = [];
  if (res.added)      parts.push(`已加入下载 ${res.added} 首`);
  if (res.skipped)    parts.push(`${res.skipped} 首本地已有`);
  if (res.duplicates) parts.push(`${res.duplicates} 首已在队列`);
  if (failed)         parts.push(`${failed} 首取不到`);
  toast(parts.length ? parts.join(' · ') : '没有新的可下载曲目');

  if (dlPick) dlPick = null;                     // 批量勾选干完了 → 退出勾选模式
  if (collectPick) collectPick = null;           // 选集面板的勾选态同理
  await refreshDownloads();
  if (jump && res.added) currentView = 'downloads';
  renderAll();
}

/**
 * 播放条上"当前这一首"。
 * ★ 队列里没有时（刚启动、还没播过）退回 `DB.lastTrack` —— 播放条上的歌名/作者
 *   本来就是从 lastTrack 恢复出来的（见 boot 第 5 步），下载按钮要跟它对齐，
 *   不然会出现"歌名显示着、下载按钮却是灰的"。
 */
function currentBarTrack() {
  return queue.tracks[queue.index] || DB.lastTrack || null;
}

/**
 * 播放条上那个下载按钮（index.html:405）。三种样子，和行内按钮一一对应：
 *   · 没下过 → 向下箭头，点一下把当前这首加进下载队列
 *   · 在队列 / 正在下 → 环形进度，点一下跳到「下载管理」
 *   · 已下好 → 绿色小勾，点一下在资源管理器里定位到那个文件
 * ★ 绿用固定的 --ok，不跟主题色走（理由同 dlBtnHTML 的注释）。
 */
function syncDownloadBtn() {
  const btn = $('btnDownload');
  if (!btn) return;
  const t = currentBarTrack();
  if (!t || !t.bvid) {
    btn.className = 'ico-btn disabled';
    btn.innerHTML = ic('i-download');
    btn.title = '下载这首歌';
    return;
  }
  const task = taskForTrack(t);
  // ★ v2.8.0 修订：「已下载」的按钮现在点下去会先确认文件还在 —— 所以提示语
  //   不能只写"打开所在文件夹"（万一文件被外部删了，那一下会变成重新下载）。
  if (task && task.status === 'done') {
    btn.className = 'ico-btn done';
    btn.innerHTML = ic('i-check');
    btn.title = '已下载 · 点一下打开所在文件夹（文件不在了会重新下载）';
  } else if (task && (task.status === 'downloading' || task.status === 'queued')) {
    const pct = task.total ? Math.min(100, Math.round((task.received / task.total) * 100)) : 0;
    btn.className = 'ico-btn';
    btn.innerHTML = `<span class="dl-ring" style="--p:${pct}"></span>`;
    btn.title = task.status === 'queued' ? '排队中 · 点一下看下载管理' : `正在下载 ${pct}% · 点一下看下载管理`;
  } else {
    btn.className = 'ico-btn';
    btn.innerHTML = ic('i-download');
    btn.title = (task && task.status === 'paused') ? '下载已暂停 · 点一下继续'
              : (task && task.status === 'failed') ? '上次下载失败 · 点一下重试'
              : '下载这首歌';
  }
}

/* ---------------- 批量勾选模式 ---------------- */

/** 工具条上「批量下载」：进入 / 退出勾选模式（我喜欢、歌单两个视图共用） */
function toggleDlPick() {
  if (dlPick) { dlPick = null; renderAll(); return; }
  // 把"从哪个视图进来的"记下来：换页就自动退出，不然跑到「发现」会发现每行都带勾选框
  dlPick = { view: currentView, selected: new Map() };
  renderAll();
}

/** 勾选模式下那条「已选 N 首 · 全选 · 清空 · 开始下载」（复用导入页 .imp-bar 的样式） */
function dlBarHTML() {
  const n = dlPick ? dlPick.selected.size : 0;
  return `
    <div class="imp-bar">
      <span class="imp-count">已选 <b>${n}</b> 首</span>
      <span class="imp-bar-actions">
        <button class="ghost-btn" id="btnDlPickAll">全选</button>
        <button class="ghost-btn" id="btnDlPickNone"${n ? '' : ' disabled'}>清空选择</button>
        <button class="primary-btn" id="btnDlPickDo"${n ? '' : ' disabled'}>下载选中的 ${n} 首</button>
      </span>
    </div>`;
}

/** 点整行 = 勾 / 取消（和导入页 impToggle 一套逻辑，只是换了个选择集） */
function dlToggle(i) {
  if (!dlPick) return;
  const t = currentTracks()[i];
  if (!t || !t.bvid) return;
  if (dlPick.selected.has(t.bvid)) dlPick.selected.delete(t.bvid);
  else dlPick.selected.set(t.bvid, t);
  rerenderKeepScroll();
}

function dlPickAll() {
  if (!dlPick) return;
  for (const t of currentTracks()) if (t && t.bvid) dlPick.selected.set(t.bvid, t);
  rerenderKeepScroll();
}

function dlPickNone() {
  if (!dlPick) return;
  dlPick.selected.clear();
  rerenderKeepScroll();
}

async function dlDoPicked() {
  if (!dlPick) return;
  const list = Array.from(dlPick.selected.values());
  if (!list.length) return;
  await enqueueDownloads(list);
}

/* ---------------- 下载管理页（页面 7） ---------------- */

const DL_FILTERS = [
  { id: 'all',    name: '全部' },
  { id: 'doing',  name: '下载中' },
  { id: 'done',   name: '已完成' },
  { id: 'failed', name: '失败' },
];

function dlMatch(t, f) {
  if (f === 'doing') return t.status === 'downloading' || t.status === 'queued' || t.status === 'paused';
  if (f === 'done') return t.status === 'done';
  if (f === 'failed') return t.status === 'failed';
  return true;
}

function dlCountOf(f) { return dlTasks.filter((t) => dlMatch(t, f)).length; }

/** 任务行的操作按钮。图标 + 悬停提示（跟列表行内那套 .op-ic 一致）。 */
function dlOpBtn(act, tip, icon, id) {
  return `<button class="op-ic" data-dlact="${act}" data-dlid="${esc(id)}" data-tip="${esc(tip)}">${ic(icon)}</button>`;
}

function dlRowHTML(t) {
  const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
  const cover = t.cover
    ? `<div class="dl-cover" style="background-image:url('${esc(t.cover)}')"></div>`
    : `<div class="dl-cover"></div>`;

  let status = '';
  let sub = '';                 // ★ 一律存**纯文本**，由下面模板统一 esc 一次，别在这儿先转义
  let ops = '';
  if (t.status === 'downloading') {
    status = `${pct}% · ${fmtBytes(t.speed)}/s`;
    sub = `${t.author ? t.author + ' · ' : ''}${fmtBytes(t.received)}${t.total ? ' / ' + fmtBytes(t.total) : ''}`;
    ops = dlOpBtn('pause', '暂停', 'i-pause', t.id) + dlOpBtn('cancel', '取消并删掉临时文件', 'i-off', t.id);
  } else if (t.status === 'queued') {
    status = '等待中';
    sub = `${t.author ? t.author + ' · ' : ''}前面还有任务在排队`;
    ops = dlOpBtn('cancel', '取消', 'i-off', t.id);
  } else if (t.status === 'paused') {
    status = `已暂停 · ${pct}%`;
    sub = `${t.author ? t.author + ' · ' : ''}${fmtBytes(t.received)}${t.total ? ' / ' + fmtBytes(t.total) : ''}`;
    ops = dlOpBtn('resume', '继续下载', 'i-play', t.id) + dlOpBtn('cancel', '取消并删掉临时文件', 'i-off', t.id);
  } else if (t.status === 'done') {
    status = '已完成';
    sub = `${t.author ? t.author + ' · ' : ''}${fmtBytes(t.received)}`;
    // ★ v2.8.0 批次 B：下完的歌现在能直接从下载管理播了（批次 A 故意压着没放 ——
    //   那时 local:// 的渲染分支还没接，放一个点了没反应的「播放」比不放更糟）。
    ops = dlOpBtn('play', '播放', 'i-play', t.id)
        + dlOpBtn('reveal', '打开所在位置', 'i-reveal', t.id)
        + dlOpBtn('remove', '删除这条记录', 'i-trash', t.id);
  } else {
    status = '失败';
    sub = `${t.author ? t.author + ' · ' : ''}${t.error || '下载失败'}`;
    ops = dlOpBtn('retry', '重试', 'i-retry', t.id) + dlOpBtn('remove', '删除这条记录', 'i-trash', t.id);
  }

  return `
    <div class="dl-row" data-dlid="${esc(t.id)}">
      ${cover}
      <div class="dl-meta">
        <div class="dl-line1">
          <span class="dl-title" title="${esc(t.title)}">${esc(t.title || t.bvid)}</span>
          <span class="dl-status${t.status === 'done' ? ' ok' : (t.status === 'failed' ? ' err' : '')}">${esc(status)}</span>
        </div>
        <div class="dl-sub">${esc(sub)}</div>
        ${(t.status === 'downloading' || t.status === 'paused')
          ? `<div class="dl-bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="dl-ops">${ops}</div>
    </div>`;
}

function dlEmptyHTML() {
  const txt = {
    all:    ['还没有下载任务', '在歌曲行、播放条或歌单里点「下载」就会出现在这里'],
    doing:  ['没有正在下载的任务', ''],
    done:   ['还没有下完的歌', ''],
    failed: ['没有失败的任务', ''],
  }[dlFilter] || ['', ''];
  return `<div class="empty">
    <div class="big">${ic('i-download')}</div>
    <div class="msg">${esc(txt[0])}</div>
    <div class="hint">${esc(txt[1])}</div>
  </div>`;
}

function renderDownloads() {
  currentView = 'downloads';
  const st = dlStats || computeDlStats();
  const doing = st.running + st.queued + st.paused;
  const rows = dlTasks.filter((t) => dlMatch(t, dlFilter));

  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">下载管理</div>
        <div class="block-sub dl-stats">
          已完成 ${st.done} · 下载中 ${doing} · 失败 ${st.failed} · 共占用 ${fmtBytes(st.bytes)}
        </div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnDlOpenDir"${dlDir ? '' : ' disabled'}>${ic('i-folder')}<span>打开下载文件夹</span></button>
        <button class="ghost-btn" id="btnDlClearDone"${st.done ? '' : ' disabled'}>清空已完成</button>
        <button class="ghost-btn" id="btnDlClearAll"${dlTasks.length ? '' : ' disabled'}>全部删除</button>
      </div>
    </div>

    ${dlDir ? '' : `
      <div class="local-warn">
        ${ic('i-info')}
        <span>还没设置下载位置 —— 点任意一首歌的下载按钮，会先让你选一个文件夹。</span>
        <span class="spacer"></span>
        <button class="ghost-btn" id="btnDlSetDir">去设置</button>
      </div>`}

    <div class="dl-tabs">
      ${DL_FILTERS.map((f) => `<button class="dl-tab${dlFilter === f.id ? ' on' : ''}" data-dlf="${f.id}">${f.name} ${dlCountOf(f.id)}</button>`).join('')}
      <span class="spacer"></span>
      <button class="ghost-btn" id="btnDlPauseAll"${st.running || st.queued ? '' : ' disabled'}>全部暂停</button>
      <button class="ghost-btn" id="btnDlRetryAll"${st.failed ? '' : ' disabled'}>重试失败项</button>
    </div>

    ${rows.length ? `<div class="dl-list">${rows.map(dlRowHTML).join('')}</div>` : dlEmptyHTML()}`;
}

/**
 * 进度是每 300ms 一条的高频推送：**只改那一小块宽度和文字，不重画整页** ——
 * 重画会把滚动位置和按钮的悬停状态一起打断，列表长了还会掉帧。
 */
function patchDlProgress(list) {
  for (const t of list) {
    const row = content().querySelector(`.dl-row[data-dlid="${t.id}"]`);
    if (!row) continue;
    const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
    const bar = row.querySelector('.dl-bar > i');
    if (bar) bar.style.width = pct + '%';
    const st = row.querySelector('.dl-status');
    if (st && t.status === 'downloading') st.textContent = `${pct}% · ${fmtBytes(t.speed)}/s`;
  }
}

/* ---------------- 任务操作 ---------------- */

/** 「删除记录」确认框。★ 默认**不勾**"同时删磁盘文件"——
 *  删记录可逆（重下就有），删文件不可逆，所以危险的那一半必须用户主动勾。
 *  ★ v2.8.0：文案写明"本地歌曲库里那条也会一起走" —— 否则用户会以为绿勾还挂着是没删掉。 */
function askRemoveTask(title) {
  const p = openPrompt('删除下载记录',
    `<div class="pl-empty" style="padding:0">「${esc(title || '这首歌')}」会从下载列表和本地歌曲库里移掉。</div>` +
    `<label class="dl-del-chk"><input type="checkbox" id="promptDelFile" /><span>同时删掉磁盘上的文件（不可恢复）</span></label>`,
    `<button class="ghost-btn" id="promptCancel">取消</button>` +
    `<button class="primary-btn" id="promptOk">删除</button>`);
  $('promptOk').addEventListener('click', () => {
    const c = $('promptDelFile');
    closePrompt({ deleteFile: !!(c && c.checked) });
  });
  $('promptCancel').addEventListener('click', () => closePrompt(null));
  return p;
}

/**
 * 把本地库里指向这个任务文件的那条记录删掉（真删了东西就落盘）。
 * ★ 这是"绿勾消失"的关键：`rebuildDlKeys()` 会同时看本地库和"已完成"的任务，
 *   只删任务、不清本地库的话，绿勾会一直挂着 —— 真机反馈的就是这个。
 * @returns {boolean} 是否真的删掉了一条
 */
function dropLocalEntryOf(t) {
  if (!t || !t.file || !dlDir) return false;
  const full = joinPath(dlDir, t.file);
  const before = (DB.local || []).length;
  DB.local = (DB.local || []).filter((e) => !e || e.path !== full);
  if (DB.local.length === before) return false;
  rebuildDlKeys();
  persistLater();
  return true;
}

async function dlRemoveOne(t) {
  const res = await askRemoveTask(t.title);
  if (!res) return;                       // 用户取消 / 直接关掉了弹窗
  try { await api('downloadRemove', [t.id], !!res.deleteFile); }
  catch (err) { toast(err.message || '删除失败'); return; }

  // ★ 不管勾没勾"同时删磁盘文件"，本地库那条都要走：
  //   不勾 → 文件留在磁盘上，但它不该再算"已下载"；勾 → 文件也没了，更不该算。
  dropLocalEntryOf(t);
  await refreshDownloads();
  renderAll();
}

/**
 * 「全部删除」：清空下载列表（v2.8.0，真机反馈"下载管理里没有全部删除的功能"）。
 * ★ 规矩和单条删除完全一致：默认只清记录（本地库那条也一起走，绿勾才会消失），
 *   勾上"同时删磁盘文件"才真去删文件。
 * ★ 正在下载的会先被中止 —— 主进程 `downloader.remove()` 里会 abort 掉运行中的请求。
 */
async function dlClearAll() {
  if (!dlTasks.length) return;
  const ids = dlTasks.map((t) => t.id);
  const res = await askRemoveTask(`全部 ${ids.length} 条下载记录`);
  if (!res) return;
  try { await api('downloadRemove', ids, !!res.deleteFile); }
  catch (err) { toast(err.message || '删除失败'); return; }

  for (const t of dlTasks) dropLocalEntryOf(t);
  await refreshDownloads();
  renderAll();
  toast(`已删除 ${ids.length} 条下载记录`);
}

async function dlClearFinished() {
  try { await api('downloadClearFinished'); }
  catch (err) { toast(err.message || '清空失败'); return; }
  await refreshDownloads();
  renderAll();
  toast('已清空完成记录（磁盘上的文件没动）');
}

async function dlPauseAll() {
  const ids = dlTasks.filter((t) => t.status === 'downloading' || t.status === 'queued').map((t) => t.id);
  if (!ids.length) return;
  for (const id of ids) { try { await api('downloadPause', id); } catch (_) {} }
  await refreshDownloads();
  renderAll();
  toast(`已暂停 ${ids.length} 个任务`);
}

async function dlRetryAll() {
  const ids = dlTasks.filter((t) => t.status === 'failed').map((t) => t.id);
  if (!ids.length) return;
  for (const id of ids) { try { await api('downloadRetry', id); } catch (_) {} }
  await refreshDownloads();
  renderAll();
  toast(`正在重试 ${ids.length} 个任务`);
}

/**
 * 从下载管理页直接播一首"已完成"的歌（v2.8.0 批次 B）。
 * ★ 它其实是"找到这条任务对应的本地库条目 → 用 localTrack 适配 → 单首播"。
 *   任务里存的是**相对文件名**（t.file），本地库里存的是**绝对路径**，
 *   所以要先拼出绝对路径再去找 DB.local 里那条。
 */
function dlPlayTask(t) {
  if (!t || !t.file || !dlDir) { toast('这个文件的位置还不知道呢'); return; }
  const full = joinPath(dlDir, t.file);
  const entry = (DB.local || []).find((e) => e && e.path === full);
  if (!entry) {
    // 任务还在、本地库那条没了（用户手动删过 / 存档没对上）→ 兜底造一条临时曲目
    playTracks([{ localPath: full, title: t.title, author: t.author, cover: t.cover, duration: t.duration || 0, bvid: null, cid: null }], 0, '下载管理');
    return;
  }
  playTracks([localTrack(entry)], 0, '下载管理');
}

async function handleDlAction(act, id) {
  const t = dlTasks.find((x) => x.id === id);
  if (!t) return;
  try {
    if (act === 'pause')       await api('downloadPause', id);
    else if (act === 'resume') await api('downloadResume', id);
    else if (act === 'retry')  await api('downloadRetry', id);
    else if (act === 'cancel') await api('downloadCancel', id);
    else if (act === 'play')   { dlPlayTask(t); return; }
    else if (act === 'reveal') { await api('downloadReveal', t.file); return; }
    else if (act === 'remove') { await dlRemoveOne(t); return; }
    else return;
  } catch (err) {
    toast(err.message || '操作失败');
    return;
  }
  await refreshDownloads();
  renderAll();
}

/**
 * 下载完成 → 把这条并进本地歌曲库。
 * ★ 去重键用**路径**：下载器已经保证同一首歌不会重复下，但用户可能删过记录又重下，
 *   所以这里再兜一道（同一条路径只会留一条）。
 */
function addLocalEntry(entry) {
  if (!entry || !entry.path) return;
  DB.local = Array.isArray(DB.local) ? DB.local : [];
  DB.local = DB.local.filter((e) => e && e.path !== entry.path);
  DB.local.unshift(Object.assign({ id: uid(), addedAt: Date.now(), src: 'download' }, entry));
  if (DB.local.length > 20000) DB.local.length = 20000;   // 兜底，别让存档无限长
  rebuildDlKeys();
  persistLater();
}

/* ============================================================
   本地歌曲（v2.8.0 批次 B）
   ------------------------------------------------------------
   两条来源合成一个曲库：
     · 下载落地的（src:'download'，带 bvid/cid/key）
     · 从硬盘导入的（src:'file' / 'folder'，没有 bvid/cid）
   渲染时把 DB.local 的条目**适配成 track 形状**（localTrack），
   于是 trackRow / trackListHTML / 收藏 / 历史 / 队列全都原样复用。
   ============================================================ */

/** 本地库条目 → 曲目形状（多一个 localPath 当身份证）。 */
function localTrack(entry) {
  if (!entry) return null;
  return {
    localPath: entry.path,
    localId: entry.id,
    title: entry.title || fileNameOf(entry.path),
    author: entry.author || '',
    cover: entry.cover || '',
    duration: entry.duration || 0,
    missing: !!entry.missing,
    bvid: null,
    cid: null,
  };
}

/** 从路径里抠文件名（不带扩展名）当兜底标题。 */
function fileNameOf(p) {
  const s = String(p || '');
  const base = s.split(/[\\/]/).pop() || s;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** 当前本地库里所有曲目（列表渲染用）。 */
function localTracks() {
  return (DB.local || []).filter((e) => e && e.path).map(localTrack);
}

/**
 * 回填本地歌时长（播放时从 audio.duration 拿到）。
 * ★ 只在"真的变了"时才写盘，避免每播一首白写一次存档。
 */
function backfillLocalDuration(p, dur) {
  if (!p || !dur || !isFinite(dur) || dur <= 0) return;
  const e = (DB.local || []).find((x) => x && x.path === p);
  if (!e) return;
  const rounded = Math.round(dur);
  if (Math.round(e.duration || 0) === rounded) return;
  e.duration = rounded;
  persistLater();
}

/** 播放时发现文件不在了 → 标记失效（列表置灰 + 顶部黄条），不删记录。 */
function markLocalMissing(p) {
  const e = (DB.local || []).find((x) => x && x.path === p);
  if (!e || e.missing) return;
  e.missing = true;
  persistLater();
  renderAll();
}

/**
 * 批量标记失联（进「本地歌曲」页时体检一次）。
 * ★ 与 sweepMissingLocal 的区别：那个是"下载记录 + 绿勾"的体检（会**删**记录、允许重下）；
 *   这个是本地库的"导入文件被挪走"检测（**只标记不删** —— 用户可能只是换了盘符，
 *   删了记录他得重新导入一遍，标一下让他自己决定）。
 */
async function checkLocalMissing() {
  const list = (DB.local || []).filter((e) => e && e.path);
  if (!list.length) return;
  let res;
  try { res = await api('localStat', list.map((e) => e.path)); }
  catch (_) { return; }   // 查不到就当都还在，别误标
  if (!Array.isArray(res)) return;
  const byPath = new Map(res.map((r) => [String(r.path), r]));
  let changed = false;
  for (const e of list) {
    const r = byPath.get(String(e.path));
    // 查不到这条 → 当它还在（宁可不标，别误标）
    const miss = r ? r.exists !== true : false;
    if (!!e.missing !== miss) { e.missing = miss; changed = true; }
    if (r && r.exists && r.size && e.size !== r.size) e.size = r.size;
  }
  if (changed) persistLater();
}

/** 统计本地库：N 首、总占用、几首失效。 */
function localStats() {
  const list = (DB.local || []).filter((e) => e && e.path);
  let bytes = 0;
  let missing = 0;
  for (const e of list) {
    if (e.missing) { missing++; continue; }
    bytes += Number(e.size) || 0;
  }
  return { total: list.length, bytes, missing };
}

/**
 * 导入本地歌（两个入口共用）：
 *   · kind='files'  → 系统多选文件框
 *   · kind='folder' → 系统选文件夹框（主进程递归扫，限深限量）
 * ★ 只记录路径，**绝不移动/复制文件**（Neo 拍板：非破坏性）。
 *   去重按路径：已在库里的跳过。
 */
async function importLocal(kind) {
  const fn = kind === 'folder' ? 'localPickFolder' : 'localPickFiles';
  let res;
  try { res = await api(fn); }
  catch (err) { toast('选择失败：' + (err.message || '')); return; }

  if (!res || !res.paths || !res.paths.length) return;   // 用户取消 / 空文件夹

  DB.local = Array.isArray(DB.local) ? DB.local : [];
  const have = new Set(DB.local.filter((e) => e && e.path).map((e) => String(e.path)));
  const fresh = [];
  for (const p of res.paths) {
    if (have.has(String(p))) continue;   // 已在库里
    have.add(String(p));
    fresh.push({
      id: uid(),
      path: p,
      title: fileNameOf(p),      // 导入时不知道真标题，先用文件名；播放条/B 站那套不适用，这里就是最终标题
      author: '',
      cover: '',
      duration: 0,
      size: 0,
      src: kind === 'folder' ? 'folder' : 'file',
      key: '',
      bvid: null,
      cid: null,
      addedAt: Date.now(),
    });
  }

  if (!fresh.length) { toast('这些歌已经在本地库里了'); return; }

  DB.local = fresh.concat(DB.local);
  persistLater();
  currentView = 'local';
  renderAll();
  toast(res.truncated
    ? `已导入 ${fresh.length} 首（文件太多，只取了前 5000 个）`
    : `已导入 ${fresh.length} 首`);
}

/**
 * 从本地库里移除一条记录。
 * ★ 只从库里移除，**绝不删磁盘文件** —— 导入遵循 Neo 拍板的"非破坏性"原则：
 *   文件是用户自己的，我们只是"记录了一条路径"，没资格替他删。
 *   真要删文件，用户去资源管理器删（删完列表会自动标失效，再点「清理失效项」即可）。
 */
function removeLocalEntry(entry) {
  if (!entry) return;
  const before = DB.local.length;
  DB.local = DB.local.filter((e) => e !== entry && (!e || e.path !== entry.path));
  if (DB.local.length === before) return;
  rebuildDlKeys();
  persistLater();
  renderAll();
  toast('已从本地库移除（磁盘上的文件没动）');
}

/** 本地库顶部那个"失效清单 + 清理"黄条。 */
function localWarnHTML() {
  const st = localStats();
  if (!st.missing) return '';
  return `
    <div class="local-warn">
      ${ic('i-info')}
      <span>有 <b>${st.missing}</b> 首文件找不到了（可能被移动或删除）。</span>
      <span class="spacer"></span>
      <button class="ghost-btn" id="btnLocalClean">清理失效项</button>
    </div>`;
}

/** 「清理失效项」：把所有 missing 的条目从库里移除（不动磁盘 —— 反正也找不到）。 */
function cleanLocalMissing() {
  const before = (DB.local || []).length;
  DB.local = (DB.local || []).filter((e) => e && !e.missing);
  const removed = before - DB.local.length;
  if (!removed) return;
  rebuildDlKeys();
  persistLater();
  renderAll();
  toast(`已清理 ${removed} 首失效记录`);
}

/** 本地歌曲页（currentView === 'local'）。 */
function renderLocal() {
  currentView = 'local';
  const st = localStats();
  const list = localTracks();

  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">本地歌曲</div>
        <div class="block-sub">${st.total} 首${st.bytes ? ' · 共 ' + fmtBytes(st.bytes) : ''}${st.missing ? ' · ' + st.missing + ' 首失效' : ''}</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnLocalImportFiles">${ic('i-note')}<span>导入歌曲</span></button>
        <button class="ghost-btn" id="btnLocalImportFolder">${ic('i-folder')}<span>导入文件夹</span></button>
      </div>
    </div>

    ${localWarnHTML()}

    ${list.length
      ? `<div class="track-list" id="trackList">${trackListHTML(list, { remove: true })}</div>`
      : `<div class="local-empty">
           ${ic('i-note')}
           <div class="local-empty-title">还没有本地歌曲</div>
           <div class="local-empty-sub">点右上角「导入歌曲」或「导入文件夹」把硬盘上的歌加进来；下载完成的歌也会自动出现在这里。</div>
           <div class="local-empty-actions">
             <button class="primary-btn" id="btnLocalEmptyFiles">导入歌曲</button>
             <button class="ghost-btn" id="btnLocalEmptyFolder">导入文件夹</button>
           </div>
         </div>`}`;
}

/* ---------- 侧边栏：歌单列表 ---------- */
function renderPlaylistSidebar() {
  const ul = $('playlistList');
  if (!DB.playlists.length) {
    ul.innerHTML = `<li style="padding:8px 10px;font-size:12px;color:var(--muted-2)">还没有歌单，点 ＋ 建一个</li>`;
    return;
  }
  ul.innerHTML = DB.playlists.map((p) => `
    <li class="playlist-row ${currentView === 'playlist:' + p.id ? 'active' : ''}" data-pl="${p.id}">
      <span class="name">${ic('i-note')}<span class="nm">${esc(p.name)}</span></span>
      <span class="cnt">${p.tracks.length}</span>
      <button class="del" data-del="${p.id}" title="删除">✕</button>
    </li>`).join('');

  ul.querySelectorAll('[data-pl]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.del) { deletePlaylist(e.target.dataset.del); return; }
      // ★ 走 renderAll（而不是直接 renderPlaylist）：这样"批量勾选模式绑定在某个视图上"
      //   那条清理规则只在 renderAll 里有一处，从这个入口进来也能被清掉。
      currentView = 'playlist:' + el.dataset.pl;
      renderAll();
    });
  });
}

/** 根据 currentView 重新画整个界面 */
function renderAll() {
  // v2.8.0：批量勾选模式是**绑定在某个视图上**的（进的时候记下了 dlPick.view）。
  //   换到别的页面就自动退出 —— 不然跑到「发现」会发现每行都带着勾选框、
  //   点一下还会弹出下载，看着像界面坏了。
  if (dlPick && dlPick.view !== currentView) dlPick = null;

  renderPlaylistSidebar();
  syncNavHighlight();   // 侧栏高亮永远跟着"当前在哪一页"走（不再只在点侧栏时才更新）
  if (currentView === 'search') renderSearch();
  else if (currentView === 'discovery') {
    renderDiscovery();
    if (!discoveryResults.length && !discoveryLoading && !discoveryError) loadDiscovery();
  }
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'history') renderHistory();
  else if (currentView === 'downloads') renderDownloads();
  else if (currentView === 'local') renderLocal();   // v2.8.0 批次 B
  else if (currentView === 'up') renderUp();
  else if (currentView === 'importMine') renderImportMine();   // v2.6.0：导入我的 B 站收藏夹
  else if (currentView.startsWith('playlist:')) renderPlaylist(currentView.split(':')[1]);
  else if (currentView === 'parsed') renderParsed();

  // mini 展开态那块队列列表也跟着刷（不在 mini 里的话它直接返回，不做事）
  renderMiniList();
}

/**
 * 按 currentView 刷新侧栏高亮。
 * 为什么要有它：以前高亮只在"点侧栏"那一刻改（见 bindEvents 的 nav 点击），
 * 于是从顶部搜索栏搜歌时，界面已经换成搜索结果页，侧栏却还亮着上一项，对不上。
 * 注意：搜索结果页（search）、UP 主页（up）、详情页（parsed）都是"临时页"，
 * 不属于侧栏任何一个分类 —— 这时四项都不点亮，反而更准。
 */
function syncNavHighlight() {
  const nav = $('nav');
  if (!nav) return;
  nav.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === currentView);
  });
}

/* ============================================================
   第 4.4 部分：小弹窗（替掉 Electron 里根本不工作的 prompt）
   ------------------------------------------------------------
   ⚠️ 为什么不能用 prompt()：
   Electron 的渲染进程**没有实现** window.prompt —— 调它不会弹出任何窗口，
   而是直接返回 null。以前"新建歌单 / 重命名 / 选一个歌单选进去"全靠 prompt，
   所以点了全无反应（歌单建不出来就是这个原因）。
   这里改用页面自己的弹窗（#promptMask），行为可控、样式也统一。
   ============================================================ */

let promptResolve = null;

/** 往弹窗里填内容。标题 / 主体 / 按钮都是现填的，所以一个小弹窗能当多种用 */
function renderPrompt(title, bodyHTML, footHTML) {
  $('promptTitle').textContent = title;
  $('promptBody').innerHTML = bodyHTML;
  $('promptFoot').innerHTML = footHTML;
}

/** 关闭弹窗并把结果交给等待者（点取消 / 关窗 = null） */
function closePrompt(value = null) {
  const mask = $('promptMask');
  if (mask) mask.classList.remove('show');
  const done = promptResolve;
  promptResolve = null;
  if (done) done(value);
}

/** 打开弹窗，返回 Promise：closePrompt(v) 时 resolve(v) */
function openPrompt(title, bodyHTML, footHTML) {
  renderPrompt(title, bodyHTML, footHTML);
  $('promptMask').classList.add('show');
  return new Promise((resolve) => { promptResolve = resolve; });
}

/** 打开弹窗但不需要返回值（"选歌单"这种自己就把活干完了） */
function showPrompt(title, bodyHTML, footHTML) {
  promptResolve = null;
  renderPrompt(title, bodyHTML, footHTML);
  $('promptMask').classList.add('show');
}

/** 输入一个名字（新建歌单 / 重命名都用它） */
async function askName(title, defaultValue = '', okText = '确定') {
  const p = openPrompt(title,
    `<input class="prompt-input" id="promptInput" type="text" value="${esc(defaultValue)}" />`,
    `<button class="ghost-btn" id="promptCancel">取消</button>` +
    `<button class="primary-btn" id="promptOk">${esc(okText)}</button>`);
  const input = $('promptInput');
  input.focus();
  input.select();
  const submit = () => {
    const v = (input.value || '').trim();
    if (!v) { toast('名字不能为空'); return; }
    closePrompt(v);
  };
  $('promptOk').addEventListener('click', submit);
  $('promptCancel').addEventListener('click', () => closePrompt(null));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return p;
}

/** 一个"你确定吗"的小弹窗，返回 true / false */
async function askConfirm(title, text, okText = '确定') {
  const p = openPrompt(title,
    `<div class="pl-empty" style="padding:0">${esc(text)}</div>`,
    `<button class="ghost-btn" id="promptCancel">取消</button>` +
    `<button class="primary-btn" id="promptOk">${esc(okText)}</button>`);
  $('promptOk').addEventListener('click', () => closePrompt(true));
  $('promptCancel').addEventListener('click', () => closePrompt(false));
  return p;
}

/** 绑定弹窗自己的开关（点右上角 ✕ / 点暗色区域 / 按 Esc 都算取消） */
function bindPrompt() {
  const mask = $('promptMask');
  if (!mask) return;
  $('promptClose').addEventListener('click', () => closePrompt(null));
  mask.addEventListener('click', (e) => { if (e.target.id === 'promptMask') closePrompt(null); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) closePrompt(null);
  });
}

/* ============================================================
   第 4.5 部分：把曲目加进歌单
   ============================================================ */

/**
 * 弹出一个歌单列表让用户选（也能就地新建），选好后把曲目加进去。
 * 这就是"点 ＋ 时弹出歌单列表供选择，并且可以在里面创建歌单"的实现。
 */
function pickPlaylistFor(tracks) {
  const list = tracks.filter(Boolean);
  if (!list.length) return;
  const count = list.length;

  const addInto = async (pl) => {
    let added = 0;
    list.forEach((t) => {
      if (!pl.tracks.some((x) => sameTrack(x, t))) { pl.tracks.push(t); added += 1; }
    });
    await persist();
    renderAll();
    closePrompt(pl.id);
    toast(added ? `已把 ${added} 首加入「${pl.name}」` : `这些都已经在「${pl.name}」里了`);
  };

  // 视图 1：列出现有歌单
  const showPick = () => {
    const rows = DB.playlists.map((p) => `
      <button class="pl-row" data-pl="${p.id}">
        <span>${esc(p.name)}</span><span class="n">${p.tracks.length}</span>
      </button>`).join('');
    showPrompt(
      count > 1 ? `把 ${count} 首加入歌单` : '加入歌单',
      `<button class="pl-new" id="plNew">${ic('i-plus')}<span>新建歌单…</span></button>` +
      `<div class="pl-list">${rows || '<div class="pl-empty">还没有歌单，点上面新建一个</div>'}</div>`,
      `<button class="ghost-btn" id="plCancel">取消</button>`);
    $('plNew').addEventListener('click', showNew);
    $('plCancel').addEventListener('click', () => closePrompt(null));
    $('promptBody').querySelectorAll('.pl-row').forEach((el) => {
      el.addEventListener('click', () => {
        const pl = DB.playlists.find((p) => p.id === el.dataset.pl);
        if (pl) addInto(pl);
      });
    });
  };

  // 视图 2：就地新建一个歌单，建完直接加入
  const showNew = () => {
    renderPrompt('新建歌单',
      `<input class="prompt-input" id="plName" type="text" value="我的歌单" />`,
      `<button class="ghost-btn" id="plBack">返回</button>` +
      `<button class="primary-btn" id="plCreate">创建并加入</button>`);
    const input = $('plName');
    input.focus();
    input.select();
    const create = async () => {
      const name = (input.value || '').trim();
      if (!name) { toast('名字不能为空'); return; }
      const pl = { id: uid(), name, tracks: [] };
      DB.playlists.push(pl);
      await addInto(pl);
    };
    $('plCreate').addEventListener('click', create);
    $('plBack').addEventListener('click', showPick);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  };

  showPick();
}

/** 加一首到歌单（行内的 ＋ 按钮、播放条上的操作都走它） */
function addToPlaylist(track) {
  pickPlaylistFor([track]);
}

async function deletePlaylist(id) {
  const pl = DB.playlists.find((p) => p.id === id);
  if (!pl) return;
  const sure = await askConfirm('删除歌单', `确定删除「${pl.name}」吗？删了就找不回来了。`, '删除');
  if (!sure) return;
  DB.playlists = DB.playlists.filter((p) => p.id !== id);
  await persist();
  currentView = 'discovery';   // 删完当前歌单，回「发现」首页（侧栏已经没有搜索入口了）
  renderAll();
  toast(`已删除歌单「${pl.name}」`);
}

/* ============================================================
   第 4.7.5 部分：快捷键（v2.3.0）—— 表驱动
   ============================================================
   这一节管三件事：
     1. 键位怎么存、怎么比（sanitizeKeys / normalizeKeyName / keyFromEvent / keyOf）
     2. 按下去做什么（runKeyAction）
     3. 界面上那一页怎么画、怎么改（renderKeyList / 录制 / 冲突 / 恢复默认）
   三件事**全部**从 KEY_ACTIONS 那张表来，所以加一条快捷键 = 表里加一行。 */

/** 存档里读出来的 keys 洗干净：只留"认识的动作 id + 字符串值"，其余全丢。
 *  存档被人手改坏（比如 keys 写成 [] 或 null）也不会让后面的比较崩掉。 */
function sanitizeKeys(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  KEY_ACTIONS.forEach((a) => {
    const v = raw[a.id];
    if (typeof v === 'string' && v) out[a.id] = v;
  });
  return out;
}

/** 把 KeyboardEvent.key 规范化：' ' → 'Space'、单字母统一小写、'Esc' → 'Escape'。
 *  ★ 单字母必须统一大小写：按住 Shift 时 e.key 是大写 'D'，不按住是小写 'd'，
 *    不统一的话"Ctrl+D"和"Ctrl+Shift+D"会打架。 */
function normalizeKeyName(k) {
  if (!k) return '';
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (k === 'Esc') return 'Escape';
  if (k.length === 1) return k.toLowerCase();
  return k;
}

/** 一次按键 → 'Ctrl+Shift+p' 这种字符串；认不出来（只按了修饰键）返回 null。
 *  ★★ 修饰键**参与比较**：'Ctrl+ArrowLeft' 和 'ArrowLeft' 是两个完全不同的键。
 *     以前那套是"一个 if 一条"，靠**代码顺序**让 Ctrl+← 先命中；
 *     改成表驱动之后顺序由表决定，所以必须比得**完全一致**，
 *     否则按一次 Ctrl+← 会同时触发"上一首"和"快退 5 秒"。 */
function keyFromEvent(e) {
  const k = normalizeKeyName(e.key || '');
  if (!k) return null;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;  // 光按修饰键不算
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');   // macOS 上 Cmd 也算 Ctrl（和以前一致）
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

/** 某个动作当前绑的是哪个键：改过就用改过的，没改就用默认的。
 *  'none' 是个特殊值 = "这条不绑键"（keyFromEvent 永远产生不出它，所以永远匹配不上）。 */
function keyOf(id) {
  const custom = DB.settings && DB.settings.keys;
  if (custom && typeof custom[id] === 'string' && custom[id]) return custom[id];
  const a = KEY_ACTIONS.find((x) => x.id === id);
  return a ? a.def : '';
}

/** 键位 → 给人看的样子：'Ctrl+Shift+p' → 'Ctrl + Shift + P' */
function keyLabel(combo) {
  if (!combo || combo === 'none') return '未设置';
  return combo.split('+').map((p) => {
    if (KEY_PRETTY[p]) return KEY_PRETTY[p];
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(' + ');
}

/** 提示里那半截：'（Ctrl + D）'。
 *  ★ 界面上凡是写键位的地方都用它 —— 这样改完键位提示立刻就对，
 *    不会出现"提示说 Ctrl+D、按下去没反应"。 */
function keyHint(id) {
  const k = keyOf(id);
  return (!k || k === 'none') ? '' : '（' + keyLabel(k) + '）';
}

/** 按下去做什么 —— 就是把以前那 11 段 if 里的动作体原样搬进来。
 *  ★ 以后加快捷键：在 KEY_ACTIONS 加一行 + 在这里加一个 case，两处缺一不可。 */
function runKeyAction(id) {
  switch (id) {
    case 'togglePlay':
      if (!audio.src) { toast('先选一首歌吧'); return; }
      if (audio.paused) safePlay(); else audio.pause();
      return;
    case 'prevTrack': next(-1); return;
    case 'nextTrack': next(1); return;
    case 'seekBack':
      if (audio.src) audio.currentTime = Math.max(0, audio.currentTime - 5);
      return;
    case 'seekFwd':
      if (audio.src) audio.currentTime = Math.min(totalDuration() || 1e9, audio.currentTime + 5);
      return;
    case 'volUp': bumpVolume(5); return;
    case 'volDown': bumpVolume(-5); return;
    case 'toggleLyric': toggleLyrics(); return;
    case 'toggleDeskLyric': toggleDesktopLyric(); return;
    case 'miniMode': setMini(!mini.on, false); return;   // 进来一律是"收起态"，不带上次的展开状态
    case 'openSettings': openSettings(); return;
    case 'fullscreen': window.neko.setFullScreen(true); return;
    default: return;
  }
}

/** 音量 ±5（上下方向键）—— 抽出来是因为表里两条（volUp / volDown）都要用 */
function bumpVolume(delta) {
  const cur = Math.round((audio.volume || 0) * 100);
  const v = Math.max(0, Math.min(100, cur + delta));
  applyVolume(v, true);
  toast('音量 ' + v + '%');
}

/* ---- 界面那一页 ---- */
let recordingKeyId = null;    // 正在录制键位的动作 id（null = 没在录）
let keyClashPending = null;   // 冲突弹窗里待处理的那个"抢夺"请求

/** 把「快捷键」页的列表画出来（全从 KEY_ACTIONS 来，不写死在 HTML 里） */
function renderKeyList() {
  const box = $('keyList');
  if (!box) return;
  const custom = DB.settings.keys || {};
  box.innerHTML = KEY_ACTIONS.map((a) => {
    const rec = recordingKeyId === a.id;
    return `<div class="key-row">
      <div class="key-name">${a.name}${a.hint ? `<small>${a.hint}</small>` : ''}</div>
      <button class="key-box${rec ? ' recording' : ''}" data-key-box="${a.id}"
        title="点一下，然后直接按你想用的键">${rec ? '按下新键…' : keyLabel(keyOf(a.id))}</button>
      <button class="key-reset" data-key-reset="${a.id}" title="这一条恢复默认"
        ${custom[a.id] ? '' : 'disabled'}>↺</button>
    </div>`;
  }).join('');
}

function startRecordKey(id) {
  recordingKeyId = id;
  renderKeyList();
}
function stopRecordKey() {
  recordingKeyId = null;
  renderKeyList();
}

/** 正在录制时按下的那一下 —— 这是"新键位"，不是"执行功能" */
function captureRecordedKey(e) {
  const id = recordingKeyId;
  if (!id) return;
  e.preventDefault();
  // 录制中的按键只属于这个录制流程。阻止后续 document 监听器（特别是"Esc 关设置 / 关歌词"）
  // 把同一个 Esc 再当作第二个动作处理。
  e.stopImmediatePropagation();
  if (e.key === 'Escape') {
    // 冲突提示正开着时 Esc 也视作取消：收起提示并丢掉待确认的抢键请求。
    keyClashPending = null;
    const clashMask = $('keyClashMask');
    if (clashMask) clashMask.classList.remove('show');
    stopRecordKey();
    return;                                           // Esc = 取消录制，不把它当成键位
  }
  const key = keyFromEvent(e);
  if (!key) return;                                       // 只按了 Ctrl / Alt → 继续等
  const clash = KEY_ACTIONS.find((a) => a.id !== id && keyOf(a.id) === key);
  if (clash) { askKeyClash(id, key, clash); return; }     // 撞车了 → 先问，不静默改
  applyKey(id, key);
}

/** 把某个动作绑到新键位上 */
function applyKey(id, key) {
  if (!DB.settings.keys) DB.settings.keys = {};
  const a = KEY_ACTIONS.find((x) => x.id === id);
  if (a && key === a.def) delete DB.settings.keys[id];    // 改回默认 → 存档里不留痕
  else DB.settings.keys[id] = key;
  recordingKeyId = null;
  renderKeyList();
  refreshKeyHints();
  persist();
  toast(key === 'none' ? '已取消这一条的快捷键' : '已改成 ' + keyLabel(key));
}

/** 冲突：这个键已经被别的动作用了。★ 不静默改 —— 弹出来让用户决定 */
function askKeyClash(id, key, owner) {
  keyClashPending = { id, key, ownerId: owner.id };
  const t = $('keyClashText');
  if (t) t.textContent = `${keyLabel(key)} 现在是「${owner.name}」在用。要把它让出来吗？让出来之后「${owner.name}」就没有快捷键了，你可以再给它设一个。`;
  $('keyClashMask').classList.add('show');
}

/** 旧的那条"让出来"：先回到默认；如果它的默认键**正好就是**这个键，那就只能让它空着
 *  （否则两条同时指着同一个键，谁生效全看表里的先后顺序 —— 那种 bug 极难查）。 */
function yieldKey(ownerId, key) {
  if (!DB.settings.keys) DB.settings.keys = {};
  delete DB.settings.keys[ownerId];
  if (keyOf(ownerId) === key) DB.settings.keys[ownerId] = 'none';
}

function resetOneKey(id) {
  if (DB.settings.keys) delete DB.settings.keys[id];
  recordingKeyId = null;
  renderKeyList();
  refreshKeyHints();
  persist();
  toast('已恢复默认');
}

function resetAllKeys() {
  DB.settings.keys = {};
  recordingKeyId = null;
  renderKeyList();
  refreshKeyHints();
  persist();
  toast('全部快捷键已恢复默认');
}

/** 界面上那几处写着键位的提示（播放条封面 / 「词」按钮 / mini 按钮），
 *  全部改成"现拼"，这样改完键位立刻就对。 */
function refreshKeyHints() {
  const cover = $('npCover');
  if (cover) cover.title = '查看歌词' + keyHint('toggleLyric');
  const bl = $('btnLyric');
  if (bl) bl.title = '歌词' + keyHint('toggleDeskLyric');
  const bm = $('btnMini');
  if (bm) bm.title = (mini.on ? '退出 mini 模式' : 'mini 模式') + keyHint('miniMode');
  const br = $('btnRestoreFull');
  if (br) br.title = '回到完整模式' + keyHint('miniMode');
}

function bindKeyList() {
  const box = $('keyList');
  if (!box) return;

  box.addEventListener('click', (e) => {
    const rst = e.target.closest('[data-key-reset]');
    if (rst && !rst.disabled) { resetOneKey(rst.dataset.keyReset); return; }
    const kb = e.target.closest('[data-key-box]');
    if (kb) startRecordKey(kb.dataset.keyBox);
  });

  $('btnResetKeys').addEventListener('click', resetAllKeys);

  // 点键位框以外的地方 = 取消录制（点另一个框 = 换一个录，不算取消）。
  // ★★ 必须挂在**捕获阶段**（第三个参数 true），不能挂在冒泡阶段：
  //    点键位框的那一下，本页的 click 处理会先跑 → startRecordKey() 里
  //    renderKeyList() 把列表整个重建 → 原来那个按钮**从 DOM 上被摘下来**。
  //    这时候冒泡阶段才轮到 document 的监听器，它 closest('.key-list')
  //    顺着"已断链"的节点往上找爹 → 找不到 → 误判成"点在外面" → 把刚开的录制立刻取消。
  //    （离屏实测第 [3] 组抓出来的：表现为"怎么点都进不了录制态"。）
  //    捕获阶段在 target 处理之前跑，那时候 e.target 还挂在树上，判断才可靠。
  document.addEventListener('click', (e) => {
    if (!recordingKeyId) return;
    if (e.target.closest('.key-list')) return;
    if (e.target.closest('#keyClashMask')) return;
    stopRecordKey();
  }, true);

  // 冲突弹窗的两个按钮
  const take = $('keyClashTake'), cancel = $('keyClashCancel');
  if (take) take.addEventListener('click', () => {
    const p = keyClashPending;
    keyClashPending = null;
    $('keyClashMask').classList.remove('show');
    if (!p) return;
    yieldKey(p.ownerId, p.key);
    applyKey(p.id, p.key);
  });
  if (cancel) cancel.addEventListener('click', () => {
    keyClashPending = null;
    $('keyClashMask').classList.remove('show');
    stopRecordKey();
  });
}

/* ============================================================
   第 4.8 部分：设置面板（外观 + B 站 Cookie）
   ============================================================ */

/** 显示设置面板 */
function openSettings() {
  $('modalMask').classList.add('show');
  syncSettingsUI();
}
function closeSettings() {
  $('modalMask').classList.remove('show');
}

/**
 * 打开设置面板并直接停在某一页（tab）。
 * ★ 抽出来是为了让"从别处跳到设置某页"（比如下载管理页那条「去设置」）
 *   和"点 tab"走同一条路 —— 两处各写一遍 toggle 逻辑，迟早会有一处忘了同步。
 */
function showSettingsTab(name) {
  openSettings();
  const tabs = $('modalTabs');
  if (tabs) {
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  }
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
}

/** 打开面板前，先把存档里的值回填到各个控件上 */
function syncSettingsUI() {
  const s = DB.settings;

  $('themeGrid').querySelectorAll('.swatch').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === s.theme);
  });

  // 背景提示 + 动态背景专属开关（只在背景是视频时显示）
  const bgKind = s.bg.kind === 'video' ? 'video' : 'image';
  const isVid = !!s.bg.file && bgKind === 'video';
  $('bgHint').textContent = s.bg.file
    ? (isVid ? '当前：自定义动态背景 ✓' : '当前：自定义图片背景 ✓')
    : '当前：默认深色背景';
  const vOpts = $('bgVideoOpts');
  if (vOpts) {
    vOpts.style.display = isVid ? '' : 'none';
    const vv = s.bg.video || {};
    $('chkVideoMuted').checked = vv.muted !== false;
    $('chkVideoLoop').checked  = vv.loop  !== false;
    $('rngVideoSpeed').value = vv.speed ?? 1;
    $('valVideoSpeed').textContent = (vv.speed ?? 1) + '×';
  }
  // "窗口不在前台时暂停"：只在背景是视频时才有意义
  const pOpts = $('bgPerfOpts');
  if (pOpts) {
    pOpts.style.display = isVid ? '' : 'none';
    $('chkPauseBlur').checked = s.bg.pauseOnBlur !== false;
  }
  // "背景模糊"只作用于图片层：背景是视频时置灰并说明原因（见 style.css 的 .field.is-off）
  const fBlur = $('fieldBgBlur');
  if (fBlur) fBlur.classList.toggle('is-off', isVid);
  const bHint = $('bgBlurHint');
  if (bHint) {
    bHint.textContent = isVid
      ? '动态背景（视频）不走这一项 —— 模糊只作用于图片背景，视频不参与模糊，否则每帧重糊会拖垮显卡。'
      : '不喜欢太花哨的背景，可以糊掉它';
  }

  $('rngDim').value = Math.round((s.bg.dim ?? 0.55) * 100);
  $('valDim').textContent = $('rngDim').value + '%';

  $('rngBgBlur').value = s.bg.blur ?? 0;
  $('valBgBlur').textContent = $('rngBgBlur').value + 'px';

  // ---- 面板毛玻璃三档：两个互斥的平级开关 ----
  //   只勾「省显卡」= prebake（默认） / 只勾「实时毛玻璃」= live / 两个都不勾 = plain
  const gm = (s.glass.mode === 'plain' || s.glass.mode === 'live') ? s.glass.mode : 'prebake';
  const hasBg = !!s.bg.file;
  const fMode = $('fieldGlassMode');
  if (fMode) fMode.classList.toggle('is-off', !hasBg);   // 没背景时这一块用不上 → 置灰
  const cPerf = $('chkGlassPerf');
  const cLive = $('chkGlassLive');
  if (cPerf) { cPerf.checked = (gm === 'prebake'); cPerf.disabled = !hasBg; }
  if (cLive) { cLive.checked = (gm === 'live');    cLive.disabled = !hasBg; }
  const gWarn = $('glassLiveWarn');
  if (gWarn) gWarn.classList.toggle('show', gm === 'live' && hasBg);   // 勾了高画质才常驻这行警示
  const gHint = $('glassModeHint');
  if (gHint) {
    gHint.textContent = hasBg
      ? '两个都不勾 = 面板完全不做模糊（最省，就是网易云插件那种做法）'
      : '还没有自定义背景：面板背后是纯色，做不做模糊看不出差别，所以这里暂时用不上。';
  }

  $('rngGlassBlur').value = s.glass.blur ?? 12;
  $('valGlass').textContent = $('rngGlassBlur').value + 'px';
  // 「毛玻璃强度」在 plain 档没有任何作用 → 置灰
  const fGB = $('fieldGlassBlur');
  if (fGB) fGB.classList.toggle('is-off', gm === 'plain');

  $('rngGlassAlpha').value = Math.round((s.glass.frameAlpha ?? 0.12) * 100);
  $('valAlpha').textContent = $('rngGlassAlpha').value + '%';

  // 自动歌词开关
  const chk = $('chkAutoLyric');
  if (chk) chk.checked = !!s.autoLyric;

  // Cookie 只在还没填过的时候拉一次，避免覆盖用户正在编辑的内容
  if (!$('cookieInput').value) {
    api('cookieGet').then((t) => { $('cookieInput').value = t || ''; }).catch(() => {});
  }

  // v2.2.0：窗口页的「关闭主窗口时」三选一
  syncCloseActionUI();

  // v2.3.0：快捷键页的列表（每次打开面板都重画一遍，改过的键位才会在框里显示出来）
  renderKeyList();

  // v2.8.0：下载页
  const dls = DB.settings.download || DOWNLOAD_DEFAULTS;
  const dirBox = $('dlDirBox');
  if (dirBox) {
    dirBox.textContent = dls.dir || '还没选过 —— 第一次点下载时会弹窗让你选';
    dirBox.classList.toggle('empty', !dls.dir);
  }
  const rngC = $('rngDlConcurrent');
  if (rngC) {
    rngC.value = dls.concurrent;
    $('valDlConcurrent').textContent = dls.concurrent;
  }
  const cCover = $('chkDlCover');
  if (cCover) cCover.checked = dls.saveCover !== false;
  const cAuto = $('chkDlAutoAdd');
  if (cAuto) cAuto.checked = dls.autoAddToLocal !== false;
  const cSkip = $('chkDlSkip');
  if (cSkip) cSkip.checked = dls.skipExisting !== false;
}

/**
 * 设置面板「窗口」页的单选 ← 读存档。
 * ★ 关闭弹窗里那个「设为默认值」改的也是同一个字段，所以两边**永远同步**
 *   （弹窗里勾完，这里会自动跟着变；反过来也一样）。
 */
function syncCloseActionUI() {
  const v = closeActionSetting();
  const map = { ask: 'radCloseAsk', quit: 'radCloseQuit', tray: 'radCloseTray' };
  Object.keys(map).forEach((k) => {
    const el = $(map[k]);
    if (el) el.checked = (k === v);
  });
}

function bindSettings() {
  /* ---- 开关 ---- */
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseModal').addEventListener('click', closeSettings);
  $('btnDoneModal').addEventListener('click', closeSettings);
  // 点面板外的暗色区域也能关
  $('modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    // v2.3.0：录制中按 Esc 是"取消录制"，不应把整个设置面板也关掉。
    // 全局录制监听会在捕获阶段先截住；这里留一道保险，免得将来监听顺序被改乱。
    if (recordingKeyId) return;
    if (e.key === 'Escape') closeSettings();
  });

  /* ---- 左右两个 Tab ---- */
  $('modalTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showSettingsTab(tab.dataset.tab);
  });

  /* ---- 快捷键页（v2.3.0） ---- */
  bindKeyList();

  /* ---- 主题色块 ---- */
  $('themeGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    DB.settings.theme = btn.dataset.theme;
    applyAppearance();
    syncSettingsUI();
    persist();
  });

  /* ---- 背景图 ---- */
  $('btnPickBg').addEventListener('click', async () => {
    try {
      const res = await api('pickBackground');
      if (!res) return;                       // 用户点了取消
      if (res.error) { toast(res.error); return; }
      DB.settings.bg.file = res.file;
      DB.settings.bg.kind = 'image';          // 换回图片背景
      applyAppearance(); syncSettingsUI(); persist();
      toast(res.sizeMB > 20
        ? `背景已换（${res.sizeMB}MB，图有点大，可能会略卡）`
        : '背景已换 ✓');
    } catch (err) {
      toast('选图失败：' + err.message);
    }
  });

  /* ---- 背景视频 ---- */
  $('btnPickBgVideo').addEventListener('click', async () => {
    try {
      const res = await api('pickVideoBackground');
      if (!res) return;                       // 用户点了取消
      if (res.error) { toast(res.error); return; }
      DB.settings.bg.file = res.file;
      DB.settings.bg.kind = 'video';
      applyAppearance(); syncSettingsUI(); persist();
      // 分辨率太大就提个醒（不做自动转码，引导用户自己压到 720p/1080p）
      const size = await probeVideoSize(res.file);
      if (size && size.w > 1920) {
        toast(`动态背景已换 ✓ 素材 ${size.w}×${size.h} 偏大，建议压到 720p/1080p 更省显卡`);
      } else {
        toast('动态背景已换 ✓');
      }
    } catch (err) {
      toast('选视频失败：' + err.message);
    }
  });

  // 动态背景专属：静音 / 循环 / 播放速度
  $('chkVideoMuted').addEventListener('change', (e) => {
    DB.settings.bg.video.muted = e.target.checked;
    applyAppearance(); persist();
  });
  $('chkVideoLoop').addEventListener('change', (e) => {
    DB.settings.bg.video.loop = e.target.checked;
    applyAppearance(); persist();
  });
  $('rngVideoSpeed').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('valVideoSpeed').textContent = v + '×';
    DB.settings.bg.video.speed = v;
    applyAppearance();
    persistLater();
  });

  // 「窗口不在前台时暂停」
  $('chkPauseBlur').addEventListener('change', (e) => {
    DB.settings.bg.pauseOnBlur = e.target.checked;
    updateBgVideoPlayback(); persist();
  });

  /* ---- 面板毛玻璃：两个**互斥**的平级开关（勾一个自动取消另一个）----
     只勾「省显卡」= prebake（默认） / 只勾「实时毛玻璃」= live / 两个都不勾 = plain。
     ★ 允许"两个都不勾"是有意的：否则两个平级开关就退化成"伪装成开关的单选"，
       而"都不勾"正好对应 BetterNCM / 网易云插件那种最省的做法，是个真实有用的档。 */
  function setGlassMode(mode) {
    DB.settings.glass.mode = mode;
    applyAppearance(); syncSettingsUI(); persist();
  }
  $('chkGlassPerf').addEventListener('change', (e) => {
    if (e.target.checked) setGlassMode('prebake');
    else setGlassMode($('chkGlassLive').checked ? 'live' : 'plain');
  });
  $('chkGlassLive').addEventListener('change', (e) => {
    if (e.target.checked) {
      setGlassMode('live');
      // Neo 定的提醒方式：一条 toast + 开关下面常驻一行警示（不做二次确认弹窗）
      toast('已切到实时毛玻璃：更通透，但显卡占用会明显变高');
    } else {
      setGlassMode($('chkGlassPerf').checked ? 'prebake' : 'plain');
    }
  });

  $('btnClearBg').addEventListener('click', async () => {
    try { await api('clearBackground'); } catch (e) { /* 目录本来就是空的 */ }
    DB.settings.bg.file = null;
    DB.settings.bg.kind = 'image';
    applyAppearance(); syncSettingsUI(); persist();
    toast('已恢复默认背景');
  });

  /* ---- 四根调节杆：拖动时就看到效果，停手 300ms 才写盘 ---- */
  function bindRange(rangeId, labelId, unit, apply) {
    $(rangeId).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $(labelId).textContent = unit === '%' ? v + '%' : v + 'px';
      apply(v);
      applyAppearance();
      persistLater();
    });
  }
  bindRange('rngDim',        'valDim',    '%',  (v) => { DB.settings.bg.dim = v / 100; });
  bindRange('rngBgBlur',     'valBgBlur', 'px', (v) => { DB.settings.bg.blur = v; });
  bindRange('rngGlassBlur',  'valGlass',  'px', (v) => { DB.settings.glass.blur = v; });
  bindRange('rngGlassAlpha', 'valAlpha',  '%',  (v) => { DB.settings.glass.frameAlpha = v / 100; });

  /* ---- 恢复默认外观 ---- */
  $('btnResetAppearance').addEventListener('click', () => {
    DB.settings.theme = 'pink';
    DB.settings.bg    = { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
                          pauseOnBlur: true };
    DB.settings.glass = { blur: 12, frameAlpha: 0.12, mode: 'prebake' };
    api('clearBackground').catch(() => {});
    applyAppearance(); syncSettingsUI(); persist();
    toast('外观已恢复默认');
  });

  /* ---- 动态背景省电：把"该停就停"的几条规则接上总闸 ----
     ① 最小化 / 切到后台（visibilitychange）
     ② 窗口失焦 / 回前台（blur / focus）
     ③ 任意遮罩开合（设置面板 / 合集面板 / 队列抽屉 / 输入框弹窗）
     前两条直接调总闸；第三条用 MutationObserver 盯着那 4 个遮罩的 class 变化，
     这样不用去改每一个 open/close 函数，将来新增遮罩也只要往 bgOverlayOpen() 里加个 id。 */
  document.addEventListener('visibilitychange', updateBgVideoPlayback);
  window.addEventListener('blur',  () => { winFocused = false; updateBgVideoPlayback(); });
  window.addEventListener('focus', () => { winFocused = true;  updateBgVideoPlayback(); });
  ['modalMask', 'collectMask', 'queueMask', 'promptMask'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    new MutationObserver(updateBgVideoPlayback).observe(el, { attributes: true, attributeFilter: ['class'] });
  });

  /* ---- 保存 Cookie ---- */
  $('btnSaveCookie').addEventListener('click', async () => {
    const text = $('cookieInput').value.trim();
    try {
      await api('cookieSet', text);
      toast(text ? '已保存 ✓ 搜索会更稳定' : '已清空 Cookie');
    } catch (err) {
      toast('保存失败：' + err.message);
    }
  });

  /* ---- v2.2.0：「关闭主窗口时」三选一 ---- */
  document.querySelectorAll('input[name="closeAction"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      DB.settings.close = { action: el.value };
      persistLater();
      forceReportUiState();   // ★ 必须强推：见 forceReportUiState 的说明（去重会把这一次吞掉）
    });
  });

  /* ---- v2.8.0：下载分页 ----
     ★ 这几个设置**不用额外通知主进程**：改完 persist() → 主进程 store:save 里会跑
       refreshLibraryCache()，它把 settings.download 抄进内存那份并调 downloader.setConcurrent()。
       所以"改完立刻生效"是这么来的，别在这儿再补一次 IPC（补了反而两处打架）。 */
  const dlCfg = () => {
    if (!DB.settings.download) DB.settings.download = Object.assign({}, DOWNLOAD_DEFAULTS);
    return DB.settings.download;
  };

  $('btnPickDlDir').addEventListener('click', async () => {
    // 换目录：openDownloadPicker 会把结果同时写给界面和主进程，并 toast 出来
    await openDownloadPicker();
  });

  $('btnOpenDlDir').addEventListener('click', async () => {
    try { await api('downloadOpenDir'); }
    catch (err) { toast(err.message || '打不开下载目录'); }
  });

  $('rngDlConcurrent').addEventListener('input', (e) => {
    const v = Math.min(4, Math.max(1, Math.round(Number(e.target.value) || DOWNLOAD_DEFAULTS.concurrent)));
    $('valDlConcurrent').textContent = v;
    dlCfg().concurrent = v;
    persistLater();
  });

  // 三个开关。★ 都写成"显式布尔"再存 —— 拖动过程中反复 persistLater 不会把值写歪。
  const bindDlSwitch = (id, field) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      dlCfg()[field] = !!el.checked;
      persist();   // 立刻存：这三个是"行为开关"，用户勾完可能马上就去下载了
    });
  };
  bindDlSwitch('chkDlCover',   'saveCover');
  bindDlSwitch('chkDlAutoAdd', 'autoAddToLocal');
  bindDlSwitch('chkDlSkip',    'skipExisting');
}

/* ============================================================
   第 5 部分：事件绑定
   ============================================================ */

/**
 * 设置音量（0~100），顺手把喇叭图标、浮层里的数字、滑块位置一起刷新。
 * 三档图标：0 = 静音（叉），小于一半 = 小声（一道弧），其余 = 大声（两道弧）。
 * save 为 true 时写进存档（拖动滑杆时用防抖版，避免一秒钟存上百次）。
 */
function applyVolume(v, save) {
  const val = Math.max(0, Math.min(100, Math.round(v)));
  audio.volume = val / 100;
  if (save && val > 0) volBeforeMute = val;   // 记住最后一次"有声"的音量
  if (save) {
    DB.settings.volume = val;
    persistLater();
  }
  updateVolumeUI(val);
}

/** 静音前的音量，用来在点"取消静音"时还原。只在本次运行里记，不写进存档。 */
let volBeforeMute = 80;

/** 把音量的三处显示同步：喇叭图标 + 浮层数字 + 竖向滑块 */
function updateVolumeUI(v) {
  const val = (v === undefined) ? Math.round((audio.volume || 0) * 100) : v;
  const icon = $('btnMute');
  if (icon) icon.innerHTML = ic(val === 0 ? 'i-vol-x' : (val < 50 ? 'i-vol-1' : 'i-vol-2'));
  const wrap = $('volWrap');
  if (wrap) wrap.classList.toggle('muted', val === 0);
  const num = $('volNum');    if (num)  num.textContent = String(val);
  const fill = $('volFill');  if (fill) fill.style.height = val + '%';
  const knob = $('volKnob');  if (knob) knob.style.bottom = val + '%';
}

function bindEvents() {
  /* ---- 顶部搜索框：按回车搜索 ---- */
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const kw = e.target.value.trim();
    if (!kw) return;
    // 如果贴的是收藏夹链接，走导入流程
    if (/space\.bilibili\.com/.test(kw)) { doImportFav(kw); return; }
    currentView = 'search';
    doSearch(kw, 1);
  });

  /* ---- 顶部链接框：点解析按钮 ---- */
  $('btnParseLink').addEventListener('click', () => {
    const text = $('linkInput').value.trim();
    if (!text) { toast('先粘贴一个 B 站链接或 BV 号'); return; }
    if (/space\.bilibili\.com/.test(text)) { doImportFav(text); return; }
    parsedOrigin = null;   // 这是从链接框直接解析的，没有"来路"，返回按钮就回「发现」首页
    currentView = 'parsed';
    doParseLink(text);
  });
  $('linkInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnParseLink').click();
  });

  /* ---- 左侧导航 ---- */
  $('nav').addEventListener('click', async (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    currentView = item.dataset.view;
    // v2.8.0 批次 B：进「本地歌曲」先体检一次（标出被挪走的文件），再画界面。
    if (currentView === 'local') await checkLocalMissing();
    renderAll();   // 高亮由 renderAll → syncNavHighlight() 统一刷，这里不再手动改 class
  });

  /* ---- 侧栏底部「下载管理」（v2.8.0）----
     每次点都重新拉一遍任务表：主进程才是真状态，界面这份可能已经过时
     （比如上个页面刚点过"暂停"）。 */
  $('btnDownloads').addEventListener('click', async () => {
    currentView = 'downloads';
    await refreshDownloads();
    // ★ v2.8.0 修订：进下载管理时顺带体检一次（60 秒节流）——
    //   下载页是"文件可能已被外部删掉"最该被看见的地方。
    await sweepMissingLocal();
    renderAll();
  });

  /* ---- 播放条上的下载按钮（v2.8.0）----
     行为随当前状态变：没下过 → 排队下载；在下 → 跳「下载管理」；已下好 → 打开所在文件夹。
     和按钮的 title 一一对应（见 syncDownloadBtn）。 */
  $('btnDownload').addEventListener('click', async () => {
    const t = currentBarTrack();
    if (!t || !t.bvid) { toast('先选一首歌吧'); return; }
    const task = taskForTrack(t);

    // ★ v2.8.0 修订：判据用 isDownloaded(t)（绿勾的真实来源），不是"有没有已完成任务" ——
    //   理由同行内按钮那条：清过 downloads.json 之后任务没了、本地库还在，绿勾仍然是绿的。
    if (isDownloaded(t)) {
      // 已下好 → 在资源管理器里定位。★ v2.8.0 修订：先确认文件还在，
      //   外部删掉的话改走"清记录 + 重新下载"（和行内按钮同一套，见 revealOrRedownload）
      revealOrRedownload(t, task);
      return;
    }
    if (task && (task.status === 'downloading' || task.status === 'queued')) {
      currentView = 'downloads';
      dlFilter = 'doing';
      await refreshDownloads();
      renderAll();
      return;
    }
    if (task && (task.status === 'paused' || task.status === 'failed')) {
      try {
        await api(task.status === 'paused' ? 'downloadResume' : 'downloadRetry', task.id);
      } catch (err) { toast(err.message || '操作失败'); return; }
      await refreshDownloads();
      renderAll();
      return;
    }
    enqueueDownloads([t]);
  });

  /* ---- v2.8.0：下载状态的三条推送 ----
     ★ 三条的分工：changed = 任务增删/状态变化（低频，重画整页）；
       progress = 每 300ms 一次的进度（高频，只改进度条那一小块）；
       finished = 下完一首（要顺手写进本地歌曲库，所以单独一条）。 */
  window.neko.onDownloadChanged((tasks) => {
    dlTasks = Array.isArray(tasks) ? tasks : [];
    dlStats = computeDlStats();
    rebuildDlKeys();
    syncDlBadge();
    syncDownloadBtn();
    if (currentView === 'downloads') renderAll();
  });
  window.neko.onDownloadProgress((list) => {
    for (const t of list) {
      const cur = dlTasks.find((x) => x.id === t.id);
      if (cur) { cur.received = t.received; cur.total = t.total; cur.speed = t.speed; cur.status = t.status; }
      else dlTasks.push(t);
    }
    dlStats = computeDlStats();
    syncDlBadge();
    syncDownloadBtn();
    if (currentView === 'downloads') patchDlProgress(list);
  });
  window.neko.onDownloadFinished(({ task, info, entry }) => {
    // ★ 「下完自动进本地歌曲」是界面这边的开关（主进程不读存档），所以判断放这儿
    const auto = !(DB.settings.download && DB.settings.download.autoAddToLocal === false);
    if (entry && auto) addLocalEntry(entry);
    dlTasks = dlTasks.map((x) => (x.id === task.id ? Object.assign({}, x, task) : x));
    dlStats = computeDlStats();
    rebuildDlKeys();
    syncDlBadge();
    syncDownloadBtn();
    renderAll();   // 行内 / 播放条上的绿勾要跟着变（任何列表页都可能正显示这首歌）
    toast(`已下载：${(task && task.title) || ''}`);
  });

  /* ---- 设置面板（外观 + Cookie） ---- */
  bindSettings();

  /* ---- 合集 / 分P 展开面板 ---- */
  bindCollect();

  /* ---- 播放队列抽屉 ---- */
  bindQueue();

  /* ---- 通用小弹窗（新建歌单 / 重命名 / 选歌单，替掉不工作的 prompt） ---- */
  bindPrompt();

  /* ---- 右上角自绘窗口按钮：最小化 / 最大化(切换) / 关闭 ---- */
  $('winMin').addEventListener('click', () => window.neko.winMin());
  $('winMax').addEventListener('click', () => window.neko.winMax());
  $('winClose').addEventListener('click', () => window.neko.winClose());
  window.neko.onPrepareClose(async () => {
    const saved = await flushPersistence();
    window.neko.closeReady(saved);
  });
  // 主进程告诉我们窗口已被最大化 / 还原（双击标题栏也会触发），
  // 这里把"最大化"图标切换成"还原"图标，反之亦然。
  window.neko.onWinState((max) => {
    const use = $('winMax').querySelector('use');
    if (use) use.setAttribute('href', max ? '#i-win-restore' : '#i-win-max');
    $('winMax').title = max ? '还原' : '最大化';
    $('winMax').setAttribute('aria-label', max ? '还原' : '最大化');
  });

  /* ---- mini 模式（v2.1.0）：标题栏那个按钮 + mini 条里的 ✕ / ▢ ---- */
  bindMini();

  /* ---- 关闭方式弹窗 + 托盘 / 任务栏发来的命令（v2.2.0） ---- */
  bindCloseDialog();
  window.neko.onWinCmd(handleWinCmd);

  /* ---- 新建歌单（用自家弹窗，不能用 prompt —— 见第 4.4 部分的说明） ---- */
  $('btnNewPlaylist').addEventListener('click', async () => {
    const name = await askName('新建歌单', '我的歌单', '创建');
    if (!name) return;
    const pl = { id: uid(), name, tracks: [] };
    DB.playlists.push(pl);
    await persist();
    currentView = 'playlist:' + pl.id;
    renderAll();
    toast(`已创建歌单「${name}」`);
  });

  /* ---- 导入我的 B 站收藏夹（v2.6.0）—— 侧栏「我的歌单」那一行的导入按钮 ---- */
  $('btnImportMine').addEventListener('click', openImportMine);

  /* ---- 内容区：列表点击（事件委托，一次绑定管所有动态行） ---- */
  $('content').addEventListener('click', async (e) => {
    // 作者名：点开这个 UP 主的主页（看他的全部视频）。
    // 必须放在"点整行=播放"前面，否则点作者名会顺手把这首也播了。
    const upLink = e.target.closest('.a-link');
    if (upLink) {
      const i = Number(upLink.dataset.i);
      const tracks = currentTracks();
      if (tracks[i]) openUpPage(tracks[i]);
      return;
    }

    // 「选集 N」徽章：展开合集 / 分P 面板（单独拦下，不触发整行"播放"）
    const badge = e.target.closest('.badge');
    if (badge) {
      const i = Number(badge.dataset.i);
      const tracks = currentTracks();
      const t = tracks[i];
      if (t) {
        // 顺手把当前界面的播放序列算出来：万一这条"长视频"其实只有一个分P，
        // 面板会收起来直接播它 —— 那时只有一份算好的序列才能播得对。
        const seq = await buildSequence(tracks);
        expandCollection(t, { list: seq.list, index: seq.startOf[i], name: viewLabel() });
      }
      return;
    }

    // ---- v2.8.0：下载管理页 ----
    // ★ 必须放在下面 `.op-ic` 那条**之前**：任务行的操作按钮也是 .op-ic，
    //   不先拦下就会走到"按 data-i 去当前列表里找曲目"那条路，拿到 undefined 静默什么都不做。
    const dlActBtn = e.target.closest('[data-dlact]');
    if (dlActBtn) { handleDlAction(dlActBtn.dataset.dlact, dlActBtn.dataset.dlid); return; }
    const dlTabBtn = e.target.closest('[data-dlf]');
    if (dlTabBtn) { dlFilter = dlTabBtn.dataset.dlf; renderAll(); return; }

    // 行内的小按钮（现在都画成图标了，类名是 .op-ic；.op-btn 是旧写法，一起兼容）
    const btn = e.target.closest('.op-ic, .op-btn');
    if (btn) {
      const i = Number(btn.dataset.i);
      const tracks = currentTracks();
      const track = tracks[i];
      if (!track) return;
      const act = btn.dataset.act;

      if (act === 'fav') { toggleFav(track); return; }
      if (act === 'add') { addToPlaylist(track); return; }
      if (act === 'remove') { removeFromCurrent(track); return; }
      // v2.8.0：下载这一首。已下载的再点一次 → 打开所在文件夹（和播放条那个按钮一致）
      // ★ v2.8.0 修订：判据从"有没有一条已完成的任务"改成 **isDownloaded(track)**。
      //   绿勾有两个来源（DB.local ∪ 已完成任务），只认任务的话会漏掉一整类情况：
      //   用户清过 downloads.json / 重启过 / 任务记录没了，但本地库那条还在 ——
      //   那时绿勾照样是绿的，可 taskForTrack 返回 null，就会一路掉到"重新入队"，
      //   既不体检也不清记录（真机反馈里"绿勾一直在"的另一半就是这个）。
      if (act === 'download') {
        const task = taskForTrack(track);
        if (isDownloaded(track)) {
          revealOrRedownload(track, task);      // 先确认文件还在，不在就清记录 + 重下
        } else if (task && (task.status === 'downloading' || task.status === 'queued')) {
          currentView = 'downloads'; dlFilter = 'doing'; refreshDownloads().then(renderAll);
        } else {
          enqueueDownloads([track]);
        }
        return;
      }
      if (act === 'detail') {
        // 记下"来路"再跳走，详情页左上角才有得返回（连滚动位置一起还原）
        parsedOrigin = { view: currentView, label: viewLabel(), scroll: content().scrollTop };
        currentView = 'parsed';
        doParseLink(track.bvid);
        return;
      }
      return;
    }

    // 导入页的收藏夹卡片（v2.6.0）。★ 「整个导入」那个小按钮在卡片**里面**，
    //   必须先判它 —— 否则点它会一路走到下面"点卡片 = 进收藏夹"那条去。
    const wholeBtn = e.target.closest('[data-imp-whole]');
    if (wholeBtn) {
      const f = impState && impState.folders.find((x) => String(x.id) === wholeBtn.dataset.impWhole);
      if (f) impWholeFolder(f);
      return;
    }
    const folderCard = e.target.closest('[data-imp-folder]');
    if (folderCard) {
      openImpFolder(folderCard.dataset.impFolder);
      return;
    }

    // 分页条（v2.5.0）：上一页 / 下一页 / 具体页码。
    // ★ 得放在下面 closest('[id]') 之前 —— 这些按钮只有 data-page，没有 id，
    //   不单独拦下的话会一路漏到最后"点整行 = 播放"那段去。
    const pager = e.target.closest('.pager-num, .pager-btn');
    if (pager) {
      if (pager.disabled) return;              // 首页的「上一页」/ 末页的「下一页」
      const p = Number(pager.dataset.page);
      // 同一条分页条现在有两个页面在用：UP 主页（v2.5.0）/ 导入页的挑视频（v2.6.0）。
      // 按当前在哪一页决定翻谁的页 —— 别让它俩互相踩。
      if (currentView === 'importMine') {
        if (impState && p >= 1 && p !== impState.page) loadImpList(p);
      } else if (upState && p >= 1 && p !== upState.page) {
        loadUp(p);
      }
      return;
    }

    // 块级按钮（用 closest('[id]') 而不是直接 e.target.id，
    // 这样按钮里万一包了子元素，点子元素也能正确命中按钮本身）
    const idEl = e.target.closest('[id]');
    const id = idEl ? idEl.id : '';
    // 详情页返回：回原来那一页（直接粘链接解析进来的那种没有"来路"，就回「发现」首页）
    if (id === 'btnParsedBack') {
      if (parsedOrigin) {
        const o = parsedOrigin;
        parsedOrigin = null;
        currentView = o.view;
        renderAll();
        content().scrollTop = o.scroll || 0;
      } else {
        currentView = 'discovery';
        renderAll();
      }
      return;
    }
    // 所有"播放"入口都先摊平合集，并用 viewLabel() 把来源界面的名字写进队列
    if (id === 'btnPlayAll') { startFromView(searchResults, 0); return; }
    if (id === 'btnRefreshDiscovery') { loadDiscovery(true); return; }
    if (id === 'btnPlayDiscovery') { startFromView(discoveryResults, 0); return; }
    if (id === 'btnPrevPage') { if (searchPage > 1) doSearch(searchKeyword, searchPage - 1); return; }
    if (id === 'btnNextPage') { doSearch(searchKeyword, searchPage + 1); return; }
    if (id === 'btnUpBack') { currentView = 'discovery'; renderAll(); return; }
    // v2.5.0：只播当前这一页（翻页后 upState.list 自动就是当前页）。
    // 播 800 首会把队列、随机、单曲循环全搞难用，而且每首都得先补 cid 才能播。
    if (id === 'btnPlayUp') { if (upState) startFromView(upState.list, 0); return; }
    if (id === 'btnPlayParsed') { startFromView(parsedView.tracks, 0); return; }
    if (id === 'btnAddParsed') { addManyToPlaylist(parsedView.tracks); return; }
    if (id === 'btnPlayFav') { startFromView(DB.favorites, 0); return; }
    if (id === 'btnPlayPl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (pl) startFromView(pl.tracks, 0);
      return;
    }

    // ---- v2.8.0：批量下载 ----
    // 我喜欢 / 歌单：点一下进勾选模式（再点退出）；详情页：整批直接排（那一页本来就是一个视频的全部曲目）
    if (id === 'btnDownloadFav' || id === 'btnDownloadPl') { toggleDlPick(); return; }
    if (id === 'btnDlPickAll') { dlPickAll(); return; }
    if (id === 'btnDlPickNone') { dlPickNone(); return; }
    if (id === 'btnDlPickDo') { dlDoPicked(); return; }
    if (id === 'btnDownloadParsed') {
      if (parsedView) enqueueDownloads(parsedView.tracks);
      return;
    }
    // 下载管理页的几个块级按钮
    if (id === 'btnDlOpenDir') {
      api('downloadOpenDir').catch((err) => toast(err.message || '打不开下载目录'));
      return;
    }
    if (id === 'btnDlClearDone') { dlClearFinished(); return; }
    if (id === 'btnDlClearAll') { dlClearAll(); return; }
    if (id === 'btnDlPauseAll') { dlPauseAll(); return; }
    if (id === 'btnDlRetryAll') { dlRetryAll(); return; }
    if (id === 'btnDlSetDir') { showSettingsTab('download'); return; }

    // ---- v2.8.0 批次 B：本地歌曲 ----
    if (id === 'btnLocalImportFiles' || id === 'btnLocalEmptyFiles') { importLocal('files'); return; }
    if (id === 'btnLocalImportFolder' || id === 'btnLocalEmptyFolder') { importLocal('folder'); return; }
    if (id === 'btnLocalClean') { cleanLocalMissing(); return; }

    if (id === 'btnRenamePl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (!pl) return;
      const name = await askName('重命名歌单', pl.name, '保存');
      if (!name || name === pl.name) return;
      pl.name = name;
      await persist();
      renderAll();
      toast(`已改名为「${name}」`);
      return;
    }
    if (id === 'btnDelPl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (pl) deletePlaylist(pl.id);
      return;
    }

    // ---- 导入我的 B 站收藏夹（v2.6.0）----
    if (id === 'btnImpBack') { impBack(); return; }
    if (id === 'btnImpUp') { openImpUp(); return; }
    if (id === 'btnImpFav') { openImpFolders(); return; }
    if (id === 'btnImpPickAll') { impPickAll(); return; }
    if (id === 'btnImpPickNone') { impPickNone(); return; }
    if (id === 'btnImpClear') { impClear(); return; }
    if (id === 'btnImpDo') { importPicked(); return; }
    if (id === 'btnImpWholeUp') { impWholeUp(); return; }

    // 挑歌模式（v2.6.0）：点整行 = 勾选 / 取消，**不播放**。
    // ★ 必须放在下面"点整行 = 播放"之前 —— 否则在导入页点一下行就把歌播了。
    // v2.8.0：下载的批量勾选复用了同一套行渲染（.track.pickable），靠 dlPick 分辨是谁在用。
    const pickRow = e.target.closest('.track.pickable');
    if (pickRow) {
      const i = Number(pickRow.dataset.i);
      if (dlPick) dlToggle(i); else impToggle(i);
      return;
    }

    // 点整行 = 播放
    const row = e.target.closest('.track');
    if (row) {
      const i = Number(row.dataset.i);
      const tracks = currentTracks();
      if (tracks.length) startFromView(tracks, i);
    }
  });

  /* ---- 播放条：播放/暂停、上下首、播放模式 ---- */
  $('btnPlay').addEventListener('click', () => {
    if (!audio.src) { toast('先选一首歌吧'); return; }
    audio.paused ? safePlay() : audio.pause();
  });
  $('btnPrev').addEventListener('click', () => prevTrack());
  $('btnNext').addEventListener('click', () => next(1));
  // 播放模式：点一次换一个，图标和提示跟着变（以前是两个按钮，现在合并成一个）
  $('btnMode').addEventListener('click', () => {
    const cur = PLAY_MODES.findIndex((m) => m.id === playMode);
    const m = PLAY_MODES[(cur + 1) % PLAY_MODES.length];
    setPlayMode(m.id, true);
    toast(`播放模式：${m.name}`);
  });

  $('btnFav').addEventListener('click', () => {
    const t = queue.tracks[queue.index];
    if (t) toggleFav(t);
  });

  /* ---- 进度条：可以按住拖动 ---- */
  // 关键思路：拖动过程中**只改画面**，真正的跳转留到松手那一刻。
  // 因为 B 站的音频是边下边播的，拖动中途每动一下都去跳音频，
  // 会疯狂发网络请求，直接卡成幻灯片。
  let seeking = false;   // 现在是不是正按着在拖
  let seekRatio = 0;     // 拖到了整条进度的百分之多少（0~1）

  /** 鼠标位置换算成 0~1 的比例 */
  function ratioFromEvent(e) {
    const rect = $('progress').getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  /** 只画画面、不动音频 —— 拖动时的"预览" */
  function paintSeek(ratio) {
    $('progressFill').style.width = (ratio * 100) + '%';
    $('progressKnob').style.left  = (ratio * 100) + '%';
    $('timeNow').textContent = fmtTime(ratio * totalDuration());
  }

  const progress = $('progress');

  progress.addEventListener('pointerdown', (e) => {
    if (!totalDuration()) return;
    seeking = true;
    seekRatio = ratioFromEvent(e);
    progress.classList.add('dragging');
    // 捕获指针：就算手滑拖到进度条外面（甚至拖出窗口一点点），也照样跟手
    progress.setPointerCapture(e.pointerId);
    paintSeek(seekRatio);
  });

  progress.addEventListener('pointermove', (e) => {
    if (!seeking) return;
    seekRatio = ratioFromEvent(e);
    paintSeek(seekRatio);
  });

  function endSeek(e) {
    if (!seeking) return;
    seeking = false;
    progress.classList.remove('dragging');
    try { progress.releasePointerCapture(e.pointerId); } catch (_) { /* 指针已经没了，忽略 */ }
    const d = (audio.duration && isFinite(audio.duration)) ? audio.duration : totalDuration();
    if (d) audio.currentTime = seekRatio * d;   // 松手才真的跳
    syncLyric(true);   // 跳完立刻把歌词对到新位置，不等下一次 timeupdate
  }
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);

  /* ---- 音量：点图标静音、滚轮 ±5、竖向滑杆拖动（见 bindVolume） ---- */
  bindVolume();

  /* ---- 音频事件 ---- */
  // ★ 播放按钮的图标只有一个来源：updatePlayBtn()（按 audio.paused 决定 ▶ / ‖）。
  //   这里**故意不监听 waiting 去换图标** —— 缓冲时不再换成转圈（那样一旦没人换回来就永远转圈）。
  //   ★ v2.8.0 修订：waiting / stalled 现在**要监听**了，但不是为了换图标，
  //     而是为了"断流自愈"（见 healOnStall）。两件事分开，别再混在一起。
  audio.addEventListener('play',    () => { updatePlayBtn(); pushLyricToDesktop(); });
  audio.addEventListener('pause',   () => { updatePlayBtn(); pushLyricToDesktop(); clearDeadlineTimer(); });
  audio.addEventListener('playing', () => { updatePlayBtn(); });
  audio.addEventListener('emptied', () => { updatePlayBtn(); });

  // ★ v2.8.0 修订：断流自愈。
  //   stalled = 浏览器尝试取数据但超时（典型：地址过期后 Range 被拒）。
  //   waiting = 播放中缓冲不足，先停下来等数据。
  //   两个都接上，统一走 healOnStall（内部有 8 秒冷却，不会疯狂重试）。
  audio.addEventListener('stalled', () => { healOnStall(); });
  audio.addEventListener('waiting', () => { healOnStall(); });

  audio.addEventListener('timeupdate', () => {
    // 正在拖动时不要抢着刷新画面，否则进度条会被自己拖回去，疯狂抖动
    if (seeking) return;
    const d = totalDuration();
    if (!d) return;
    const ratio = Math.min(1, audio.currentTime / d);
    $('progressFill').style.width = (ratio * 100) + '%';
    $('progressKnob').style.left = (ratio * 100) + '%';
    $('timeNow').textContent = fmtTime(audio.currentTime);
    $('timeTotal').textContent = fmtTime(d);

    // ★ 歌词滚动的"发动机"就在这里：播放位置一变，就重新算当前该高亮哪一句。
    //   少了这一行，歌词只会停在刚加载时那一句，之后再也不动。
    syncLyric();
    pushLyricToDesktop();
  });

  // 跳转结束后立刻重新定位歌词。
  // ★ 这一条不能省：暂停状态下 timeupdate 是不触发的，
  //   没有它的话，暂停时拖进度条歌词不会跟着走。
  audio.addEventListener('seeked', () => { syncLyric(true); pushLyricToDesktop(); });

  audio.addEventListener('ended', () => {
    updatePlayBtn();
    clearDeadlineTimer();                 // 这一首结束了，别再挂"到期刷新"
    if (playMode === 'one') { audio.currentTime = 0; safePlay(); return; }
    next(1);
  });

  // ★ v2.8.0 修订：error 也要试着自愈。
  //   地址过期时 net.fetch 多半回一个 403/404 响应（而不是网络错误），
  //   浏览器会把它当"媒体加载失败" → 触发 error。以前这里只弹一句
  //   "可能链接已过期，换一首试试"，**然后什么都不做** —— 用户按提示换回来
  //   还是同一首、还是同一个过期地址，于是"同一位置卡死"。
  //   现在：先试着重新解析地址接回去；接不上才提示 + 跳下一首。
  audio.addEventListener('error', () => {
    updatePlayBtn();
    if (!audio.src) return;                     // 没地址（比如切歌清空）→ 不是过错
    const seq = playSeq;
    const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    // 自愈里已经带了"失败就换下一首"，这里只在它明确失败时才提示
    refreshAudioUrl(seq, 'manual', at).then((okNow) => {
      if (!okNow && seq === playSeq) toast('音频加载失败了，可能链接已过期，换一首试试');
    });
  });

  /* ---- 全局快捷键 ---- */
  // ★ 最关键的一条：焦点在输入框里时，所有快捷键都让路。
  //   否则你在搜索框打"深夜"想搜"深"，按空格会变成暂停。
  //   range（音量/进度滑杆）也要放行：方向键本来就用来调滑杆。
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
  }

  document.addEventListener('keydown', (e) => {
    // 输入框 / 滑杆里，一律不抢键盘（除了 Esc，那是关面板 universally 要的）
    if (isTypingTarget(e.target) && e.key !== 'Escape') return;

    // v2.3.0：正在录制键位？那这一下是"新键位"，不是"执行功能"
    if (recordingKeyId) { captureRecordedKey(e); return; }

    // v2.3.0：改成表驱动 —— 不再一条条 if，改成"查表"。
    //   Esc 压根不在表里，所以走到这里会"查不到 → 什么都不做"，
    //   也就是**不会** preventDefault —— 和以前那句 `if (e.key === 'Escape') return;` 完全等价，
    //   各个面板自己的 Esc 监听照旧能收到。
    const key = keyFromEvent(e);
    if (!key) return;                                   // 只按了修饰键
    const hit = KEY_ACTIONS.find((a) => keyOf(a.id) === key);
    if (!hit) return;                                   // 没绑这个键
    e.preventDefault();   // 空格 / 方向键会滚页面，Ctrl+D 之类浏览器也有默认行为 → 一律挡掉
    runKeyAction(hit.id);
  }, true);  // 捕获阶段：录制时先于各面板的 Esc 监听截住按键

  /* ---- 歌词 ---- */
  bindLyrics();
  bindDesktopLyric();
}

/**
 * 音量交互：点图标静音 / 滚轮 ±5 / 竖向滑杆拖动。
 * 滑杆平时是收起的（CSS 里 opacity:0 + 不可点），鼠标移进 .vol-wrap 才浮出来，
 * 所以这里只管数值，不管显隐。
 */
function bindVolume() {
  const wrap = $('volWrap');
  const track = $('volTrack');
  const muteBtn = $('btnMute');
  if (!wrap || !track || !muteBtn) return;

  // 点喇叭 = 静音 / 取消静音（网易云、Spotify 都是这个习惯）
  muteBtn.addEventListener('click', () => {
    const cur = Math.round((audio.volume || 0) * 100);
    if (cur > 0) {
      volBeforeMute = cur;
      applyVolume(0, true);
      toast('已静音');
    } else {
      applyVolume(volBeforeMute > 0 ? volBeforeMute : 80, true);
    }
  });

  // 滚轮调音量：只在鼠标停在音量这一块上时才生效，
  // 否则你在列表里随便滚一下就改了音量，很莫名。
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = Math.round((audio.volume || 0) * 100);
    applyVolume(cur + (e.deltaY < 0 ? 5 : -5), true);
  }, { passive: false });

  // 竖向滑杆：按住拖动即时生效，松手才写盘（拖动中每一像素都存一次会把硬盘刷爆）
  let dragging = false;
  const setFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    const ratio = 1 - (e.clientY - r.top) / r.height;   // 底部 = 0，顶部 = 100
    applyVolume(Math.max(0, Math.min(1, ratio)) * 100, false);
  };
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch (_) { /* 指针已经没了，忽略 */ }
    setFromEvent(e);
  });
  track.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { track.releasePointerCapture(e.pointerId); } catch (_) { /* 同上 */ }
    persistLater();
  };
  track.addEventListener('pointerup', stopDrag);
  track.addEventListener('pointercancel', stopDrag);

  /* ---- 面板的显隐 ----
     规矩：鼠标在喇叭图标或面板上 → 展开；移开后**多留 0.45 秒**再收起。
     为什么要多留这一会儿：手从图标往上游走时，中间那几像素的空隙容易扫空一下，
     没有这点缓冲，面板会在你正要够到它的时候消失。
     （CSS 的 :hover 也管展开，这里再加一个 .open 类，专门负责"延迟收起"这一件事。） */
  let hideTimer = null;
  const showPop = () => { clearTimeout(hideTimer); wrap.classList.add('open'); };
  const hidePopSoon = () => {
    clearTimeout(hideTimer);
    if (dragging) return;     // 正在拖滑杆，别把面板收走
    hideTimer = setTimeout(() => wrap.classList.remove('open'), 450);
  };
  wrap.addEventListener('pointerenter', showPop);
  wrap.addEventListener('pointerleave', hidePopSoon);
}

/* ============================================================
   第 5.5 部分：歌词
   ============================================================
   几个角色，各管一段：
     lyricState   —— 记住当前这首歌的歌词、加载状态
     loadLyrics() —— 真正去要歌词（自动 / 手动都走它）
     syncLyric()  —— 跟着播放进度，把当前句高亮 + 滚动到中间
     scrollLyricTo() —— 只负责"把第 N 句滚到正中间"

   ★ syncLyric 由三处驱动，缺一个就会出现"歌词不动"：
       ① timeupdate —— 播放中，进度每变一次就对一次词（主力）
       ② seeked     —— 跳转后（暂停时 timeupdate 不触发，必须靠它）
       ③ 渲染完 / 展开面板 —— 刚拿到歌词、刚打开大屏时立刻定位
   ============================================================ */

const lyricState = {
  lines: [],      // [{ t: 秒, text: 一句 }]
  index: -1,      // 当前高亮的是第几句
  trackKey: '',   // 这份歌词属于哪首歌（bvid+cid），用来判断换歌了没
  loading: false,
  failed: false,  // 这首歌取过字幕且失败了（没字幕 / 被限流）
  showing: false, // 大屏是否展开
};

/** 正在播的这首歌的"身份证"（换歌后靠它判断歌词要不要清掉） */
function currentTrackKey() {
  const t = queue.tracks[queue.index];
  if (!t || !t.bvid || !t.cid) return '';
  return t.bvid + ':' + t.cid;
}

/** 在「词」按钮上方弹一句提示，然后慢慢消散（CSS 负责淡出动画） */
let lyricTipTimer = null;
function showLyricTip(msg) {
  const tip = $('lyricTip');
  if (!tip) return;
  tip.textContent = msg;
  tip.classList.add('show');
  clearTimeout(lyricTipTimer);
  lyricTipTimer = setTimeout(() => tip.classList.remove('show'), 2600);
}

/** 把失败原因翻译成人话。reason 由主进程给出（见 bilibili.js 的 getSubtitle） */
function lyricFailText(reason, fallback) {
  if (reason === 'no-cookie') return '还没填 B站 Cookie，先去设置里填一下';
  if (reason === 'none')      return '这首没有字幕（可点「打开视频」去B 站看）';
  if (reason === 'limit')     return '被 B 站限流了，等一分钟再点一次';
  if (reason === 'decoy')     return 'B 站返回的不是这首歌的字幕，稍后再试';
  return fallback || '歌词获取失败';
}

/**
 * 歌词页的"空状态"（v2.0.0 的 P2）：没有歌词时，别留一片空白。
 * @param {'instrumental'|'failed'|'loading'|'idle'} kind
 *   instrumental = 取到了、但确实没词（纯音乐）
 *   failed       = 压根没取到（没填 Cookie / 被限流 / 接口变更 / 网络）
 *   loading      = 正在取（换歌之后马上就有新词，先给个交代）
 *   idle         = 还没取过（没开"自动加载歌词"，也没点过「词」）
 *
 * ★ 以前几条路都是"空"：纯音乐只塞一句很暗的「（没有歌词）」，
 *   取词失败 / 换歌干脆 innerHTML='' —— 用户看到的就是一片什么都没有。
 *   现在全部走这里：把歌名（+歌手）摆出来，按原因给不同说明，
 *   需要的话再给一个按钮（复用已有的 loadLyrics，不另造轮子）。
 */
function renderLyricEmpty(kind) {
  const box = $('lyricBox');
  if (!box) return;
  const cur = queue.tracks[queue.index];
  const title = (cur && cur.title) || '未知曲目';
  const artist = (cur && cur.author) || '';

  const loading = kind === 'loading';
  const msg = loading ? '正在取歌词…'
    : kind === 'failed' ? '这次没取到歌词'
    : kind === 'idle'   ? '还没取歌词'
    : '这首是纯音乐，没有歌词';
  const hint = loading ? '稍等一下，取到就自动显示。'
    : kind === 'failed'
      ? '可能是没填 B 站 Cookie、被限流，或者这首本来就没有字幕。可以点下面的「重新获取」再试一次。'
      : kind === 'idle'
        ? '点下面的按钮取一次歌词（取词要先在设置里填 B 站 Cookie）。'
        : '安静地听吧 —— 也可以点「打开视频」去 B 站看看 UP 主有没有配词。';
  const btnLabel = kind === 'idle' ? '获取歌词' : '重新获取';

  box.classList.add('has-empty');
  box.innerHTML =
    '<div class="lyric-empty">' +
      (cur && cur.cover ? `<div class="le-cover" style="background-image:url('${esc(cur.cover)}')"></div>` : '') +
      `<div class="le-title">${esc(title)}</div>` +
      (artist ? `<div class="le-artist">${esc(artist)}</div>` : '') +
      `<div class="le-msg">${esc(msg)}</div>` +
      (hint ? `<div class="le-hint">${esc(hint)}</div>` : '') +
      (loading ? '' : `<button class="le-retry" id="btnLyricRetry">${btnLabel}</button>`) +
    '</div>';

  const retry = $('btnLyricRetry');
  if (retry) {
    retry.addEventListener('click', () => {
      lyricState.failed = false;   // 解除"自动模式不再重试"的锁，让这次能真的再问一次
      loadLyrics(true);            // byUser=true：失败会给提示，成功了会弹「歌词已加载」
    });
  }

  updateLyricHead();
}

/**
 * 取歌词并渲染。
 * @param {boolean} byUser true = 用户主动点的（展开大屏 + 失败给提示）
 *                     false = 自动模式触发的（安静点，失败不打扰）
 */
async function loadLyrics(byUser) {
  const track = queue.tracks[queue.index];
  if (!track) {
    if (byUser) showLyricTip('先放首歌再取歌词');
    return;
  }

  // cid 可能还没补上（搜索来的歌），先补齐，否则接口拿不到字幕
  try {
    await ensureCid(track);
  } catch (err) {
    if (byUser) showLyricTip('这首歌的信息没取到');
    return;
  }

  const key = currentTrackKey();
  if (!key) { if (byUser) showLyricTip('这首歌没法取歌词'); return; }

  // 同一首歌已经拿到过了，不用重复请求
  if (lyricState.trackKey === key && lyricState.lines.length) {
    if (byUser) toggleLyrics(true);
    return;
  }
  // 自动模式下已经确认过取不到，不再重复去烦 B 站
  if (!byUser && lyricState.failed && lyricState.trackKey === key) return;

  lyricState.loading = true;
  lyricState.failed = false;
  updateLyricBtn();

  try {
    // ★ 必须走 api()，不能直接调 window.neko 上的 subtitle。
    //   主进程统一返回 {ok, data} 外壳，直接调的话 res.lines 永远是 undefined，
    //   于是不管成功失败都会走进"成功"分支，显示"（没有歌词）"却提示"歌词已加载"。
    const res = await api('subtitle', track.bvid, track.cid);

    lyricState.lines = Array.isArray(res.lines) ? res.lines : [];
    lyricState.trackKey = key;
    lyricState.index = -1;
    renderLyricLines(res.videoTitle);
    pushLyricToDesktop();
    if (byUser) toast('歌词已加载' + (res.lang ? '（' + res.lang + '）' : ''));
  } catch (err) {
    // 失败：记住原因，换歌时会自动清掉
    lyricState.lines = [];
    lyricState.trackKey = key;
    lyricState.failed = true;
    lyricState.index = -1;
    // 取词失败也走"空状态"，而不是把歌词区清成一片空白（P2）
    renderLyricEmpty('failed');
    const warnEl = $('lyricWarn');
    if (warnEl) { warnEl.innerHTML = ''; warnEl.classList.remove('show'); }
    if (byUser) showLyricTip(lyricFailText(err.reason, err.message));
  } finally {
    lyricState.loading = false;
    updateLyricBtn();
    pushLyricToDesktop();   // 不管成功失败，都让悬浮窗知道最新状态
  }
}

/**
 * 把歌词行画到页面上（一行一句<p>）
 * @param {string} [videoTitle] 这份字幕实际来自哪个视频。
 *   万一取错了，标题会和我们正在播的那首不一致，用户一眼就能看出来
 *   —— B站的字幕接口只认cid、不认 bvid，取错时不会报错，
 *   所以必须把"来源"摆出来，不能让它悄悄过去。
 */
function renderLyricLines(videoTitle) {
  const box = $('lyricBox');
  if (!box) return;
  if (!lyricState.lines.length) {
    // 取到了、但确实没词（纯音乐）—— 也走空状态，别留一片空白（P2）
    renderLyricEmpty('instrumental');
    return;
  }
  box.classList.remove('has-empty');   // 有真歌词了，撤掉空状态那套布局
  const rows = lyricState.lines
    .map((l) => '<p class="l">' + esc(l.text) + '</p>')
    .join('');

  // 来源标题和当前播放标题不一致 = 极可能取错了歌，必须明确警告。
  //   注意：这里刻意不用class="l" —— syncLyric 是按 box.children 的下标对应歌词的，
  //   混进去会让每一句的高亮都错位一位。
  const cur = queue.tracks[queue.index];
  const warn =
    videoTitle && cur && cur.title && videoTitle.trim() !== cur.title.trim()
      ? '<p class="lyric-warn">这份字幕看起来不属于当前这首歌（来源：' +
        esc(videoTitle) +
        '）。已按视频重新核对过，如果仍不一致，可能是 B 站把字幕标错了</p>'
      : '';

  // 警告行放在歌词列表外面（box 的兄弟节点），完全不参与下标计算
  const warnBox = $('lyricWarn');
  if (warnBox) {
    warnBox.innerHTML = warn;
    warnBox.classList.toggle('show', !!warn);
  }

  box.innerHTML = rows;
  updateLyricHead();
  syncLyric(true);
}

/** 整页歌词顶部那条信息：歌名 + 歌手（顺便刷新「桌面歌词」按钮的亮灭） */
function updateLyricHead() {
  const cur = queue.tracks[queue.index];
  const t = $('lyricTitle'); if (t) t.textContent = cur ? (cur.title || '歌词') : '歌词';
  const sub = $('lyricSub'); if (sub) sub.textContent = cur ? (cur.author || '') : '';
  updateLyricHeadBtn();
}

function updateLyricHeadBtn() {
  const btn = $('btnLyricDesktop');
  if (!btn) return;
  btn.classList.toggle('on', !!lw().on);
  btn.title = lw().on ? '关闭桌面歌词' : '在桌面上挂一个悬浮歌词窗';
}

/**
 * 量一下顶部工具栏（搜索框那条）的实际高度，写进 CSS 变量 --topbar-h。
 *
 * 为什么非要量：歌词大屏要从它的下沿开始铺（见 style.css 里 .lyric-overlay 的 top）。
 * 高度写死在 CSS 里的话，换了字体或系统缩放对不上，要么盖住搜索框、
 * 要么露出一条缝。所以用真实测量值覆盖掉 CSS 里的兜底值。
 */
function syncTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const h = Math.round(bar.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
}

/**
 * 跟着播放进度更新高亮。
 * @param {boolean} force 强制重新定位（刚渲染完时用）
 */
function syncLyric(force) {
  if (!lyricState.showing || !lyricState.lines.length) return;
  const box = $('lyricBox');
  if (!box) return;

  const t = audio.currentTime || 0;
  // 找当前该高亮哪一句：最后一句 t <= 播放位置 的那句
  let idx = 0;
  for (let i = 0; i < lyricState.lines.length; i++) {
    if (lyricState.lines[i].t <= t) idx = i; else break;
  }
  if (!force && idx === lyricState.index) return;
  lyricState.index = idx;

  // 逐行切换高亮
  const rows = box.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('on', i === idx);
    rows[i].classList.toggle('near', i === idx - 1 || i === idx + 1);
  }

  scrollLyricTo(idx, force);
}

/**
 * 把第 idx 句滚到歌词容器的正中间。
 * @param {number} idx 要居中的那句（下标）
 * @param {boolean} instant true=瞬间到位（刚渲染 / 刚跳转），false=平滑滑过去
 *
 * ★ 这里刻意**不用** cur.scrollIntoView({block:'center'})：
 *   它会把**所有能滚动的祖先**一起滚（包括整个窗口），在浮层里容易出现"整页抖一下"。
 *   直接算容器的 scrollTop 就只动这一个盒子，稳，而且能自己夹住上下边界。
 */
function scrollLyricTo(idx, instant) {
  const box = $('lyricBox');
  if (!box) return;
  const cur = box.children[idx];
  if (!cur) return;

  // 想让这一句居中：目标 = 它顶部到容器顶部的距离 - 一半容器高 + 半行高
  const target = cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2;
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  const top = Math.min(Math.max(0, target), max);   // 夹在 [0, 最底] 之间，别滚出界

  // 差得远（比如刚跳到副歌）就立刻到位，差得近就平滑滑过去，看着不突兀。
  // ★ 平滑与否必须在这里显式指定，不能靠 CSS：
  //   · 'auto' 的含义是"听 CSS 的"，只要 .lyric-box 没写 scroll-behavior，它就是立刻到位；
  //   · 'instant' 看着更直观，但在部分内核里会被当成非法值退回 auto —— 一旦 CSS 里
  //     写着 scroll-behavior: smooth，就变成"永远平滑"，打开歌词页会看到从顶上慢慢滑下来。
  //   所以：CSS 不写 scroll-behavior，这里用 'auto' = 立刻到位，'smooth' = 平滑跟进。
  const far = Math.abs(box.scrollTop - top) > box.clientHeight * 1.2;
  if (box.scrollTo) box.scrollTo({ top, behavior: (instant || far) ? 'auto' : 'smooth' });
  else box.scrollTop = top;
}

/** 刷新「词」按钮的样子（加载中 / 桌面歌词已开 / 没字幕） */
function updateLyricBtn() {
  const btn = $('btnLyric');
  if (!btn) return;
  const desktopOn = lw().on;
  btn.classList.toggle('loading', lyricState.loading);
  btn.classList.toggle('on', desktopOn && !lyricState.loading);
  btn.classList.toggle('none', !desktopOn && !lyricState.loading && lyricState.failed);
  // v2.3.0：键位改成从表里现拼（改了键位提示就跟着变）
  btn.title = lyricState.loading ? '正在取歌词…'
    : (desktopOn ? '关闭桌面歌词' : '桌面歌词') + keyHint('toggleDeskLyric');
}

/**
 * 展开 / 收起歌词大屏。
 * @param {boolean} want true=展开 false=收起（不传则取反）
 */
function toggleLyrics(want) {
  const show = want === undefined ? !lyricState.showing : !!want;
  lyricState.showing = show;

  const ov = $('lyricOverlay');
  if (ov) ov.classList.toggle('show', show);

  // 歌词页开 / 关，直接影响"哪些动画该停"（L1）—— 立刻重算一次
  syncPauseClasses();

  // 封面是它的开关，得跟着亮/灭，不然点了不知道现在是什么状态
  const cover = $('npCover');
  if (cover) {
    cover.classList.toggle('open', show);
    cover.title = (show ? '收起歌词' : '查看歌词') + keyHint('toggleLyric');
    cover.setAttribute('aria-label', show ? '收起歌词' : '查看歌词');
  }

  if (show) updateLyricHead();

  // 展开时如果还没歌词，就去取
  if (show && !lyricState.lines.length && !lyricState.failed && !lyricState.loading) {
    loadLyrics(false);
  } else if (show) {
    syncLyric(true);
  }
  updateLyricBtn();
}

/** 绑定歌词相关的所有交互 */
function bindLyrics() {
  const btn = $('btnLyric');
  if (btn) {
    btn.addEventListener('click', () => {
      // 正在加载时按了：给个提示，别让人以为没反应
      if (lyricState.loading) { showLyricTip('正在取歌词…'); return; }
      // 点一下 = 开 / 关桌面歌词（悬浮窗开起来后一直挂着，直到再点一次）
      toggleDesktopLyric();
    });
  }

  const close = $('btnLyricClose');
  if (close) close.addEventListener('click', () => toggleLyrics(false));

  // 播放条最左边那张封面 = 整页歌词的开关（悬停会浮出"歌词"/"收起"提示）
  const cover = $('npCover');
  if (cover) {
    cover.addEventListener('click', () => {
      // ★ v2.1.0：mini 模式下封面不再是"进歌词页"的入口 ——
      //   整页歌词是铺满整个窗口的，在 132px 高的小窗里没法看。
      //   （style.css 里同时把封面上的"歌词"两字也藏了，免得提示一个点了没反应的按钮。）
      if (mini.on) return;
      // 正开着 → 再点一次就是收起，回到刚才那个列表（这就是"收起"该有的行为）
      if (lyricState.showing) { toggleLyrics(false); return; }
      if (!queue.tracks[queue.index]) { toast('先放一首歌，再点封面看歌词'); return; }
      // 还没取过就去取一次；取过了（或已知取不到）就直接展开
      if (!lyricState.lines.length && !lyricState.failed && !lyricState.loading) loadLyrics(false);
      toggleLyrics(true);
    });
  }

  /* 点歌词页以外的任何地方 → 收起歌词页，露出下面的界面。
     ★ 用 pointerdown 而不是 click：click 的落点是"按下与松开两个元素的共同祖先"，
       拖进度条时松手滑到别处会算成点在空白区域，把歌词页莫名收掉。
       pointerdown 的落点就是真正按下去的那个元素，不会误判。
     播放条与标题栏不算"别的界面"：
       · 播放条上是播放/暂停/切歌/音量，看歌词时还得接着控制播放；
       · 标题栏是拖窗口用的，拖一下不该把歌词页收掉。 */
  document.addEventListener('pointerdown', (e) => {
    if (!lyricState.showing || e.button !== 0) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#lyricOverlay')) return;   // 点在歌词页自己身上
    if (t.closest('#player')) return;         // 播放条：继续控制播放
    if (t.closest('.titlebar')) return;       // 标题栏：拖窗口
    toggleLyrics(false);
  });

  // 点某一句歌词 → 跳到那一句的时间（找副歌特别好用）
  const box = $('lyricBox');
  if (box) {
    box.addEventListener('click', (e) => {
      const row = e.target.closest('.l');
      if (!row || !audio.src) return;
      const i = Array.prototype.indexOf.call(box.children, row);
      const line = lyricState.lines[i];
      if (!line) return;
      audio.currentTime = Math.max(0, line.t);
      syncLyric(true);
      pushLyricToDesktop();
      toast('已跳到 ' + fmtTime(line.t));
    });
  }

  // 歌词页里的「桌面歌词」按钮：不用退回主界面就能开悬浮窗
  const deskBtn = $('btnLyricDesktop');
  if (deskBtn) {
    deskBtn.addEventListener('click', () => {
      toggleDesktopLyric();
      updateLyricHeadBtn();
      syncLyricSettingsUI();
    });
  }

  // 「打开视频」：用默认浏览器打开当前这首的 B 站页面。
  // 字幕取不到或不对劲时，这是最直接的核对/替代办法 ——
  // B 站网页版自带字幕，而且不会踩接口限流的坑。
  const openBtn = $('btnOpenBili');
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      const t = queue.tracks[queue.index];
      if (!t || !t.bvid) {
        showLyricTip('还没有在放歌');
        return;
      }
      const p = t.page > 1 ? `?p=${t.page}` : '';
      try {
        await api('openExternal', `https://www.bilibili.com/video/${t.bvid}/${p}`);
        toast('已在浏览器里打开');
      } catch (err) {
        showLyricTip('打不开浏览器');
      }
    });
  }

  // Esc 收起歌词
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lyricState.showing) {
      // 焦点在输入框时不抢 Esc —— 那是给人打字用的
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      toggleLyrics(false);
    }
  });

  // 「自动加载歌词」= 供词能力。
  // ★ 关掉它时，如果桌面歌词正开着，就一起关 —— 没有词可显示，悬浮窗就没意义了。
  const chk = $('chkAutoLyric');
  if (chk) {
    chk.addEventListener('change', () => {
      DB.settings.autoLyric = chk.checked;
      persist();
      if (chk.checked) {
        loadLyrics(false);        // 开着就立刻给当前这首歌补上
        toast('已开启自动歌词');
      } else if (lw().on) {
        closeDesktopLyric();
        syncLyricSettingsUI();
        toast('已关闭自动歌词，桌面歌词也一起关了');
      } else {
        toast('已关闭自动歌词');
      }
    });
  }

  bindLyricSettings();
}

/* ============================================================
   第 5.6 部分：桌面歌词（独立置顶小窗）
   ============================================================
   一句话分工：**「自动加载歌词」是供词能力，「桌面歌词」是用词方式。**
   悬浮窗要一直显示后面的歌，就必须能自动取词 —— 所以两者是联动的：
     开桌面歌词 → 自动打开「自动加载歌词」
     手动关「自动加载歌词」→ 桌面歌词一起关
   ============================================================ */

/** 桌面歌词悬浮窗设置的默认值（老存档没有这一项时用它补上） */
const DEFAULT_LYRIC_WIN = {
  on: false,            // 悬浮窗是否开着
  x: null, y: null,     // 上次拖到的位置（null = 用默认位置）
  fontSize: 28,         // 歌词字号 14~72
  opacity: 92,          // 底板与文字的不透明度 30~100
  lines: 2,             // 1 = 单行，2 = 双行
  barScale: 130,        // 工具条与图标的大小（%）80~180
  bgStyle: 'none',      // 'none' = 只有字（默认）/ 'card' = 半透明底板
  locked: false,        // 锁定位置：拖不动，但按钮还能点
  clickThrough: false,  // 鼠标穿透：点歌词会穿到下面的软件
};

/** 取当前悬浮窗的设置（顺手保证它一定存在，防止老存档取到 undefined） */
function lw() {
  if (!DB.settings.lyricWin) DB.settings.lyricWin = Object.assign({}, DEFAULT_LYRIC_WIN);
  return DB.settings.lyricWin;
}

/**
 * 当前主题色，转成"逗号分隔的三个数"（例如 "255, 111, 165"）。
 * 为什么转成逗号：悬浮窗要用 rgba(r, g, b, 透明度) 给"当前句"同时上色和上透明度，
 * 而主窗口里的 --accent-rgb 是空格分隔的（rgb(255 111 165) 那种写法用），
 * 两种写法不能混在一对括号里，所以在推过去之前先统一成逗号形式。
 */
function currentAccentRgb() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb');
  const t = (v || '').trim().replace(/\s+/g, ' ');
  if (!/^\d+\s+\d+\s+\d+$/.test(t)) return '255, 111, 165';
  return t.split(' ').join(', ');
}

/**
 * 把"现在该显示什么"推给悬浮窗。
 * 不做逐帧广播 —— 只在换歌 / 跳转 / 播放状态变化 / 播放中每 250 毫秒推一次，
 * 悬浮窗自己算当前是第几句，这样平时几乎不占资源。
 */
function pushLyricToDesktop() {
  if (!lw().on) return;
  const status = lyricState.loading ? 'loading'
    : (lyricState.lines.length ? 'ok' : (lyricState.failed ? 'none' : 'idle'));
  window.neko.lyricPush({
    status,
    lines: lyricState.lines,
    time: audio.currentTime || 0,
    playing: !audio.paused && !!audio.src,
  });
}

/** 把悬浮窗的长相（字号 / 不透明度 / 行数 / 工具条大小 / 底板 / 锁定 / 主题色）推过去 */
function pushLyricStyle() {
  if (!lw().on) return;
  const s = lw();
  window.neko.lyricStyle({
    fontSize: s.fontSize, opacity: s.opacity, lines: s.lines,
    barScale: s.barScale, bgStyle: s.bgStyle,
    locked: s.locked, accentRgb: currentAccentRgb(),
  });
}

function openDesktopLyric() {
  const s = lw();
  s.on = true;
  window.neko.lyricOpen({
    x: s.x, y: s.y, fontSize: s.fontSize, opacity: s.opacity,
    lines: s.lines, barScale: s.barScale, bgStyle: s.bgStyle,
    locked: s.locked, clickThrough: s.clickThrough,
    accentRgb: currentAccentRgb(),
  });
  // 穿透状态要单独设一次：窗口刚创建时还来不及设
  window.neko.lyricThrough(!!s.clickThrough);
  updateLyricBtn();
  syncLyricSettingsUI();
  updateLyricHeadBtn();
  persistLater();
  reportUiState();   // ★ v2.2.0：托盘菜单里「打开/关闭桌面歌词」「锁定」两项要跟着变
}

function closeDesktopLyric() {
  lw().on = false;
  window.neko.lyricClose();
  updateLyricBtn();
  syncLyricSettingsUI();
  updateLyricHeadBtn();
  persistLater();
  reportUiState();   // ★ v2.2.0
}

/** 开 / 关桌面歌词。不传参数就是"切换" */
function toggleDesktopLyric(want) {
  const on = (want === undefined) ? !lw().on : !!want;
  if (!on) { closeDesktopLyric(); return; }

  // ★ 联动：要一直显示后面的歌，就必须能自动取词
  if (!DB.settings.autoLyric) {
    DB.settings.autoLyric = true;
    syncLyricSettingsUI();
    toast('已同时开启「自动加载歌词」');
  }
  openDesktopLyric();
  if (lyricState.lines.length) pushLyricToDesktop();
  else if (!lyricState.failed) loadLyrics(false);
  else pushLyricToDesktop();
}

/** 设置面板「歌词」页里所有控件 ← 读设置（开关窗口 / 改字号后也要跟着变） */
function syncLyricSettingsUI() {
  const chkAuto = $('chkAutoLyric');
  if (chkAuto) chkAuto.checked = !!DB.settings.autoLyric;

  const s = lw();
  const desk = $('chkDesktopLyric');    if (desk)  desk.checked = !!s.on;
  const lines = $('selLyricLines');     if (lines) lines.value = String(s.lines);
  const bg = $('selLyricBg');           if (bg)    bg.value = s.bgStyle;
  const font = $('rngLyricFont');
  if (font) { font.value = s.fontSize; $('valLyricFont').textContent = s.fontSize + 'px'; }
  const bar = $('rngLyricBar');
  if (bar) { bar.value = s.barScale; $('valLyricBar').textContent = s.barScale + '%'; }
  const op = $('rngLyricOpacity');
  if (op) { op.value = s.opacity; $('valLyricOpacity').textContent = s.opacity + '%'; }
  const lock = $('chkLyricLock');       if (lock)    lock.checked = !!s.locked;
  const through = $('chkLyricThrough'); if (through) through.checked = !!s.clickThrough;
}

/** 设置面板「歌词」页里所有控件 → 写设置 */
function bindLyricSettings() {
  const desk = $('chkDesktopLyric');
  if (desk) desk.addEventListener('change', () => {
    toggleDesktopLyric(desk.checked);
    syncLyricSettingsUI();
  });

  const lines = $('selLyricLines');
  if (lines) lines.addEventListener('change', () => {
    lw().lines = lines.value === '1' ? 1 : 2;
    pushLyricStyle(); persistLater();
  });

  // 底板：默认不要（屏幕上只有字）；想有个板子垫着就选「半透明底板」
  const bg = $('selLyricBg');
  if (bg) bg.addEventListener('change', () => {
    lw().bgStyle = bg.value === 'card' ? 'card' : 'none';
    pushLyricStyle(); persistLater();
  });

  const font = $('rngLyricFont');
  if (font) font.addEventListener('input', () => {
    lw().fontSize = Number(font.value);
    $('valLyricFont').textContent = lw().fontSize + 'px';
    pushLyricStyle(); persistLater();
  });

  // 工具条大小：调的是歌词上那排按钮和图标
  const bar = $('rngLyricBar');
  if (bar) bar.addEventListener('input', () => {
    lw().barScale = Number(bar.value);
    $('valLyricBar').textContent = lw().barScale + '%';
    pushLyricStyle(); persistLater();
  });

  const op = $('rngLyricOpacity');
  if (op) op.addEventListener('input', () => {
    lw().opacity = Number(op.value);
    $('valLyricOpacity').textContent = lw().opacity + '%';
    pushLyricStyle(); persistLater();
  });

  const lock = $('chkLyricLock');
  if (lock) lock.addEventListener('change', () => {
    lw().locked = lock.checked;
    pushLyricStyle(); persistLater();
    reportUiState();   // ★ v2.2.0：托盘菜单里「锁定桌面歌词」那个勾要跟着变
  });

  // 鼠标穿透：开启后悬浮窗自己点不到自己，所以开关只能放在主窗口这一页
  const through = $('chkLyricThrough');
  if (through) through.addEventListener('change', () => {
    lw().clickThrough = through.checked;
    window.neko.lyricThrough(through.checked);
    persistLater();
    toast(through.checked ? '已开启鼠标穿透（点歌词会穿到下面的软件）' : '已关闭鼠标穿透');
  });

  // 拖到屏幕外找不回来时的救急按钮
  const reset = $('btnLyricResetPos');
  if (reset) reset.addEventListener('click', () => {
    lw().x = null; lw().y = null;
    persistLater();
    if (lw().on) { closeDesktopLyric(); openDesktopLyric(); pushLyricToDesktop(); }
    toast('已恢复默认位置');
  });
}

/** 悬浮窗上的按钮 → 在这里执行（切歌 / 播放暂停 / 字号 / 锁定 / 关闭） */
function bindDesktopLyric() {
  if (!window.neko.onLyricCmd) return;

  window.neko.onLyricCmd((cmd, arg) => {
    if (cmd === 'prev') next(-1);
    else if (cmd === 'next') next(1);
    else if (cmd === 'toggle') {
      if (!audio.src) { toast('先选一首歌吧'); return; }
      audio.paused ? safePlay() : audio.pause();
    } else if (cmd === 'close') {
      closeDesktopLyric();          // 里面会顺手把设置页的开关也刷成"关"
      toast('已关闭桌面歌词');
    } else if (cmd === 'font') {
      const s = lw();
      s.fontSize = Math.max(14, Math.min(72, s.fontSize + (Number(arg) || 0)));
      pushLyricStyle();
      syncLyricSettingsUI();
      persistLater();
    } else if (cmd === 'lock') {
      lw().locked = !!arg;
      pushLyricStyle();
      syncLyricSettingsUI();
      persistLater();
    }
  });

  // 悬浮窗被拖动 → 记下新坐标（下次打开还在原处）
  window.neko.onLyricMoved((pos) => {
    if (!pos || typeof pos.x !== 'number') return;
    lw().x = pos.x;
    lw().y = pos.y;
    persistLater();
  });
}

/** 换歌时：把上一首的歌词清掉；自动开着就顺手取新的 */
function resetLyricsOnTrackChange() {
  lyricState.lines = [];
  lyricState.index = -1;
  lyricState.trackKey = '';
  lyricState.failed = false;
  const warn = $('lyricWarn');
  if (warn) { warn.innerHTML = ''; warn.classList.remove('show'); }
  // ★ 别把歌词区清成一片空白：开着自动取词就显示"正在取歌词…"，
  //   没开就显示"还没取歌词 + 一个获取按钮"。两种都比空着强。
  if (DB.settings.autoLyric) {
    renderLyricEmpty('loading');
    loadLyrics(false);
  } else {
    renderLyricEmpty('idle');
    updateLyricBtn();
  }
  pushLyricToDesktop();
}

/** 有些音频流拿不到总时长，就用曲目信息里的时长兜底 */
function totalDuration() {
  if (audio.duration && isFinite(audio.duration)) return audio.duration;
  const t = queue.tracks[queue.index];
  return t ? t.duration : 0;
}

/** 当前页面正在显示的那组曲目 */
function currentTracks() {
  if (currentView === 'discovery') return discoveryResults;
  if (currentView === 'favorites') return DB.favorites;
  if (currentView === 'history') return DB.history;
  // v2.8.0：下载管理页的行是任务行（.dl-row），不是曲目行，没有"当前曲目"这回事。
  //   返回空数组而不是落到底下的 searchResults —— 否则在下载页点空白处
  //   有可能误触"播放搜索结果里的第 N 首"。
  if (currentView === 'downloads') return [];
  if (currentView === 'local') return localTracks();   // v2.8.0 批次 B
  if (currentView === 'up' && upState) return upState.list;
  if (currentView === 'parsed' && parsedView) return parsedView.tracks;
  if (currentView.startsWith('playlist:')) {
    const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
    return pl ? pl.tracks : [];
  }
  return searchResults;
}

/**
 * 当前这个界面叫什么名字。
 * 队列抽屉里的"来自「XXX」"用的就是它 —— 这样"从哪个界面点的播放，队列就写着哪个界面的名字"，
 * 不会再出现"在搜索结果点播放、队列却写着上次那个歌单"的情况。
 */
function viewLabel() {
  if (currentView === 'discovery') return '发现';
  if (currentView === 'favorites') return '我喜欢';
  if (currentView === 'history') return '最近播放';
  if (currentView === 'downloads') return '下载管理';   // v2.8.0
  if (currentView === 'local') return '本地歌曲';        // v2.8.0 批次 B
  if (currentView === 'up' && upState) return `${upState.name} 的视频`;
  if (currentView === 'parsed' && parsedView) return parsedView.info.title;
  if (currentView.startsWith('playlist:')) {
    const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
    return pl ? pl.name : '歌单';
  }
  return searchKeyword ? `搜索：${searchKeyword}` : '搜索结果';
}

/**
 * 从"当前界面这一份列表"开始播放某一首。
 * 统一入口：先把合集摊平成真正的播放序列（跳过被禁用的单集），再交给 playTracks，
 * 并把来源界面的名字写进队列 —— 点整行 / 播放全部 / 发现 / UP 主页 / 解析页 / 我喜欢 / 歌单 全走这里。
 */
async function startFromView(tracks, index) {
  if (!tracks || !tracks.length) return;
  const seq = await buildSequence(tracks);
  if (!seq.list.length) { toast('这个列表里没有可播放的曲目'); return; }
  const at = seq.startOf[index];
  if (at < 0) { toast('这一行的曲目都被禁用了（在合集面板里可以重新启用）'); return; }
  playTracks(seq.list, at, viewLabel());
}

/** 收藏 / 取消收藏 */
async function toggleFav(track) {
  if (isFav(track)) {
    DB.favorites = DB.favorites.filter((t) => !sameTrack(t, track));
    toast('已取消收藏');
  } else {
    DB.favorites = [track, ...DB.favorites];
    toast('已加入我喜欢');
  }
  await persist();
  if (sameTrack(track, queue.tracks[queue.index])) {
    $('btnFav').innerHTML = ic(isFav(track) ? 'i-heart-fill' : 'i-heart');
    $('btnFav').classList.toggle('on', isFav(track));
  }
  renderAll();
}

/** 从当前列表里移除（收藏页 / 歌单页） */
async function removeFromCurrent(track) {
  if (currentView === 'favorites') {
    DB.favorites = DB.favorites.filter((t) => !sameTrack(t, track));
  } else if (currentView.startsWith('playlist:')) {
    const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
    if (pl) pl.tracks = pl.tracks.filter((t) => !sameTrack(t, track));
  } else if (currentView === 'local') {
    // v2.8.0 批次 B：本地歌曲页的「移除」= 从本地库里删掉这条记录（只删记录，不动磁盘文件）。
    const entry = (DB.local || []).find((e) => e && e.path === track.localPath);
    if (entry) removeLocalEntry(entry);
    return;
  }
  await persist();
  renderAll();
}

/** 把一整批曲目加入歌单（比如整个合集）—— 走同一个"选歌单"弹窗 */
function addManyToPlaylist(tracks) {
  if (!tracks || !tracks.length) return;
  pickPlaylistFor(tracks);
}

/* ============================================================
   第 6 部分：启动
   ============================================================ */
async function boot() {
  // 1) 读取本地存档
  // ★ 必须走 api() 解包。主进程 store:load 返回的是 {ok:true, data: 存档}；
  //   直接调 window.neko.loadData() 拿到的是外壳对象，DB.settings 会是 undefined，
  //   于是每次启动都"读不到、全变默认"—— 设置和歌单看起来就像没保存过。
  try {
    const loaded = await api('loadData');
    if (loaded && typeof loaded === 'object') DB = loaded;
    DB.playlists = DB.playlists || [];
    DB.favorites = DB.favorites || [];
    DB.history = DB.history || [];
    // ★ v2.8.0：本地歌曲库。老存档没有这一项 → 补成空数组（不是 null），
    //   否则后面每一处 `DB.local.filter/for...of` 都要先判一次空。
    DB.local = Array.isArray(DB.local) ? DB.local : [];
    // 合集的"单集开关"与"曲目表缓存"：老存档没有这两项，补成空的（= 全部启用）
    DB.collectOff = (DB.collectOff && typeof DB.collectOff === 'object') ? DB.collectOff : {};
    DB.collectParts = (DB.collectParts && typeof DB.collectParts === 'object') ? DB.collectParts : {};
    // ★ v2.0.5：合集封面表（每个合集一张）。老存档没有 → 补成空的（= 走音符兜底，不报错）
    DB.collectCovers = (DB.collectCovers && typeof DB.collectCovers === 'object') ? DB.collectCovers : {};
  } catch (e) {
    console.error('读取存档失败', e);
  }

  // 2) 补好外观设置，并把它刷到界面上（主题、背景、毛玻璃）
  migrateSettings();
  applyAppearance();

  // 2.1) v2.3.0：键位补洞 + 把界面上那几处提示（封面 / 「词」/ mini）拼成当前键位。
  //   migrateSettings 已经补过了，这里再补一次是防"DB.settings 被别处整体换掉"；
  //   提示必须在这里刷一次，否则开机时 title 里还是光秃秃的"查看歌词"。
  DB.settings.keys = sanitizeKeys(DB.settings.keys);
  refreshKeyHints();

  // 2.2) 播放模式：恢复上次选的那个（老存档没有 → 列表循环），并把按钮图标刷成对应形状
  setPlayMode(DB.settings.playMode, false);

  // 2.5) 音量记忆：把上次退出时的音量填回播放器（浮层里的数字和滑块由 updateVolumeUI 同步）
  const vol = DB.settings.volume ?? 80;
  if (vol > 0) volBeforeMute = vol;
  applyVolume(vol, false);

  // 3) 绑事件
  bindEvents();

  // 3.5) v2.8.0：下载。先把「已下载」的 key 集合算出来（行内绿勾要用），
  //   再拉一次任务表（环形进度、侧栏角标要用）。
  //   ★ 必须排在 renderAll 前面 —— 否则第一次画出来的列表里，所有下载按钮
  //     都是"没下过"的样子，要等下一次重画才会变成绿勾。
  rebuildDlKeys();
  await refreshDownloads();
  // ★ v2.8.0 修订：启动时给本地库做一次失联体检 —— 用户在资源管理器里删过文件的话，
  //   这里就该把失效记录剔掉，免得第一次画出来就是一排假绿勾。
  //   force=true：开机这一次不受 60 秒节流限制（上一次会话的时间戳早就过期了）。
  await sweepMissingLocal(true);
  // ★ v2.8.0 批次 B：本地库（导入的文件）也体检一次 —— 只**标记**失效，不删记录。
  //   本地库里没东西时它内部会立刻返回，几乎零成本。
  await checkLocalMissing();

  // 4) 画界面
  renderAll();

  // 4.2) mini 模式：上次退出时缩在 mini 里，这次照样缩着。
  //   窗口尺寸主进程已经按存档开好了（见 main.js 的 createWindow），这里只负责
  //   把 body.mini 类补上 —— 少了这一步就会"窗口是小的、界面还是完整布局"。
  const savedWin = DB.settings.window || {};
  if (savedWin.mini) {
    applyMiniUI(true, !!savedWin.miniExpanded);
    window.neko.winMini(true, !!savedWin.miniExpanded);
  }

  // 4.5) 量出顶部工具栏的真实高度（歌词大屏要贴着它的下沿铺，不能盖住搜索框）
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  // 窗口尺寸变化超过 15% 时，prebake 档那张"预先糊好的壁纸图"要重生成（尺寸变了就对不上）
  window.addEventListener('resize', syncGlassImage);

  // 5) 如果上次有在听的歌，把信息显示在底部（不自动播放，免得吓一跳）
  if (DB.lastTrack) {
    $('npTitle').textContent = DB.lastTrack.title;
    $('npSub').textContent = DB.lastTrack.author || '';
    // 没封面就挂音符兜底（和 playAt 里一致）
    applyTrackCover(DB.lastTrack);
    // ★ v2.2.1：老存档里的 lastTrack 没有 cover 字段（历史记录也一样），
    //   不补的话一开机播放条上就是个音符 —— 看着像"封面丢了"。
    //   异步补一次，补到就贴上去；补不到就保持音符，不会更差。
    if (!DB.lastTrack.cover && DB.lastTrack.bvid) {
      backfillCover(DB.lastTrack.bvid).then((cover) => {
        if (cover && DB.lastTrack && !DB.lastTrack.cover) {
          DB.lastTrack.cover = cover;
          applyTrackCover(DB.lastTrack);
        }
      });
    }
  }

  // 6) 上次退出时桌面歌词是开着的，就把它重新挂回屏幕上（位置也还是上次那个）
  syncLyricSettingsUI();
  if (lw().on) {
    openDesktopLyric();
    if (DB.settings.autoLyric && DB.lastTrack) loadLyrics(false);
  }

  // 7) v2.2.0：把界面状态告诉主进程（托盘菜单 / 任务栏按钮要用）。
  //    放在最后 —— 这时歌名、播放状态、mini 状态、歌词开关都已经定了。
  reportUiState();

  // 7.5) v2.8.0：下载按钮的最后一次对齐。
  //   ★ 放在最后：上面第 5 步刚把 lastTrack 贴到播放条上，下载按钮要跟着它
  //     （绿勾 / 环形进度），不然"歌名有了、按钮还是灰的"。
  syncDownloadBtn();
}

boot();
