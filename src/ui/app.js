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
   它没有放进图标库，因为动画需要 CSS 精确选中里面每一根柱子，
   而 <use> 引用的内容在"影子树"里，外面的 CSS 选不中它。 */
const BARS_ICON = `<svg class="ic bars" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="4"    y="9" width="3.4" height="6"  rx="1.7"/>
  <rect x="10.3" y="5" width="3.4" height="14" rx="1.7"/>
  <rect x="16.6" y="8" width="3.4" height="8"  rx="1.7"/>
</svg>`;

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
  settings: {
    theme: 'pink',
    volume: 80,
    bg:    { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
             perfLite: true, pauseOnBlur: true },
    glass: { blur: 18, alpha: 0.55 },
    autoLyric: false,
  },
};

// 当前播放队列
let queue = { tracks: [], index: -1, name: '' };

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

/** 外观设置的默认值，用来给老存档补洞 */
const DEFAULT_SETTINGS = {
  theme: 'pink',
  volume: 80,
  bg:    { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
           perfLite: true, pauseOnBlur: true },
  glass: { blur: 18, alpha: 0.55 },
  autoLyric: false,   // 自动加载歌词：默认关（用户可开，或手动点「词」）
  lyricWin: null,     // 桌面歌词悬浮窗的设置（默认由 DEFAULT_LYRIC_WIN 补）
  playMode: 'list',   // 播放模式：list 列表循环 / one 单曲循环 / shuffle 随机 / order 顺序
};

/** 这是一个合法的播放模式吗（以 PLAY_MODES 为唯一准绳，避免两处清单对不上） */
function isPlayModeId(v) {
  return PLAY_MODES.some((m) => m.id === v);
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
  // 动态背景的两个"省显卡"开关（老存档没有 → 默认开）
  DB.settings.bg.perfLite    = DB.settings.bg.perfLite    !== false;
  DB.settings.bg.pauseOnBlur = DB.settings.bg.pauseOnBlur !== false;

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

/** 把 DB.settings 里的外观设置"刷"到界面上 */
function applyAppearance() {
  const s = DB.settings;
  const root = document.documentElement;

  // 1) 主题（给 <html> 打标记，CSS 里的 [data-theme="xxx"] 就会生效）
  root.dataset.theme = s.theme || 'pink';

  // 2) 毛玻璃
  root.style.setProperty('--glass-blur',  (s.glass.blur  ?? 18) + 'px');
  root.style.setProperty('--glass-alpha', String(s.glass.alpha ?? 0.55));

  // 3) 背景：图片走 .bg-image 的 CSS 背景（--bg-image），视频走 <video id="bgVideo">；同一时刻只用一种
  const layer = $('bgLayer');
  if (layer) {
    const has = !!s.bg.file;
    const isVideo = has && s.bg.kind === 'video';
    const isImage = has && !isVideo;

    layer.style.setProperty('--bg-image', isImage ? `url("bg://local/${s.bg.file}")` : 'none');
    layer.style.setProperty('--bg-dim',  String(s.bg.dim  ?? 0.55));
    // blur(0px) 会让多余的图层一直占着显卡，直接用 none 更省
    const b = Number(s.bg.blur) || 0;
    layer.style.setProperty('--bg-blur', b > 0 ? b + 'px' : '0px');
    // ★ 模糊只挂到"只管图片"的 .bg-image 上，绝不再挂到含视频的整层上 ——
    //   挂整层的话每解码一帧都要把视频一起重糊，是显卡被打满的元凶之一。
    const img = $('bgImage');
    if (img) img.style.filter = b > 0 ? `blur(${b}px)` : 'none';

    // 动态背景（视频）时给 <body> 打 perf-lite，把四块常驻面板的毛玻璃整个关掉 —— 省显卡收益最大的一步。
    // 背景是图片时不动（静态图糊一次就缓存住了，毛玻璃几乎不花钱）。
    document.body.classList.toggle('perf-lite', !!(isVideo && s.bg.perfLite !== false));

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

function updateBgVideoPlayback() {
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
}

/** 判断两首歌是不是同一首（用 bvid + cid 当身份证） */
function sameTrack(a, b) {
  return !!a && !!b && a.bvid === b.bvid && String(a.cid) === String(b.cid);
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
 * 播放队列里的第 index 首
 */
async function playAt(index) {
  if (index < 0 || index >= queue.tracks.length) return;
  queue.index = index;
  const track = queue.tracks[index];

  // 更新底部播放条的外观（先显示信息，再慢慢加载音频）
  $('npTitle').textContent = track.title;
  $('npSub').textContent = track.author || (queue.name || 'B 站');
  $('npCover').style.backgroundImage = track.cover ? `url("${track.cover}")` : 'none';
  $('npCover').style.backgroundSize = 'cover';
  $('btnFav').innerHTML = ic(isFav(track) ? 'i-heart-fill' : 'i-heart');
  $('btnFav').classList.toggle('on', isFav(track));
  $('btnPlay').innerHTML = ic('i-loading', 'spin');
  $('timeTotal').textContent = fmtTime(track.duration);

  // 换歌了：清掉上一首的歌词（自动模式开着的话会顺手取新的）
  resetLyricsOnTrackChange();

  // 「打开视频」按钮：没有 bvid 就没有页面可开，置灰
  const openBtn = $('btnOpenBili');
  if (openBtn) openBtn.classList.toggle('disabled', !track.bvid);

  try {
    // 如果这首歌还不知道自己的 cid（搜索来的），先查一次补上
    await ensureCid(track);

    // 关键一步：向主进程要音频地址。
    // B 站的真实地址带防盗链，主进程已经帮我们包装成 bili:// 内部地址。
    const info = await api('audioUrl', track.bvid, track.cid);
    audio.src = info.url;
    audio.volume = (DB.settings.volume ?? 80) / 100;

    await audio.play();

    // 记入历史（同样的歌不重复记录，把它提到最前面）
    DB.history = [track, ...DB.history.filter((t) => !sameTrack(t, track))].slice(0, 100);
    DB.lastTrack = track;
    persistLater();

    renderAll();   // 刷新列表里的"正在播放"高亮
  } catch (err) {
    toast('播放失败：' + err.message);
    // 自动跳下一首，避免卡死在这一首
    if (queue.tracks.length > 1) setTimeout(() => next(1), 900);
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
  const showBadge = opts.expand !== false && maybeCollection(track);
  const badgeLabel = collectionBadgeLabel(track);

  // 作者名：知道 UP 的 mid 就做成可点的（点开看这个 UP 的全部视频），
  // 老数据 / 收藏夹导入来的没有 mid，就还是普通文字，不会点出个空页面。
  const authorHTML = track.author
    ? (track.mid
      ? `<span class="a-link" data-act="up" data-i="${i}" title="看 ${esc(track.author)} 的全部视频">${esc(track.author)}</span>`
      : esc(track.author))
    : '';

  return `
    <div class="track ${playing ? 'playing' : ''}" data-i="${i}">
      <div class="idx">${playing ? BARS_ICON : i + 1}</div>
      <div class="cover" style="background-image:url('${esc(track.cover || '')}')"></div>
      <div class="info">
        <div class="t">${esc(track.title)}</div>
        <div class="a">${authorHTML}</div>
      </div>
      ${showBadge ? `<button class="badge" data-act="expand" data-i="${i}" title="展开选集 / 合集">${badgeLabel}</button>` : ''}
      <div class="dur">${fmtTime(track.duration)}</div>
      <div class="ops">
        <button class="op-ic ${liked ? 'on' : ''}" data-act="fav" data-i="${i}" data-tip="${liked ? '取消收藏' : '收藏'}">${ic(liked ? 'i-heart-fill' : 'i-heart')}</button>
        <button class="op-ic" data-act="add" data-i="${i}" data-tip="加入歌单">${ic('i-plus')}</button>
        ${opts.detail ? `<button class="op-ic" data-act="detail" data-i="${i}" data-tip="详情">${ic('i-info')}</button>` : ''}
        ${opts.remove ? `<button class="op-ic" data-act="remove" data-i="${i}" data-tip="移除">${ic('i-trash')}</button>` : ''}
      </div>
    </div>`;
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
 * 合集展开后队列里躺的是它的一集一集，所以不能只比 cid：
 * 正在播这个合集的第 5 集时，外面那一整行也要保持高亮（否则界面上没有任何一行是亮的）。
 */
function rowIsPlaying(track) {
  const cur = queue.tracks[queue.index];
  if (!cur || !track) return false;
  if (sameTrack(track, cur)) return true;
  if (!track.bvid || !cur.bvid) return false;
  // 同一支视频的不同分P：正在播其中一集时，相关的行也算"在播"
  if (track.bvid === cur.bvid) return true;
  // 合集行 ↔ 它的某一集：合集的每一集自带 bvid，只能拿摊开的曲目表来认
  const parts = DB.collectParts[track.bvid];
  if (parts && parts.some((e) => sameTrack(e, cur))) return true;
  const curParts = DB.collectParts[cur.bvid];
  return !!(curParts && curParts.some((e) => sameTrack(e, track)));
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
async function collectEntriesFor(track) {
  const cached = DB.collectParts[track.bvid];
  if (cached && cached.length > 1) return cached;

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

function closeCollectPanel() {
  const mask = $('collectMask');
  if (mask) mask.classList.remove('show');
  collectState = null;
}

/** 点「选集」徽章：把分P / 合集摊开；若其实不是合集就直接播这一首 */
async function expandCollection(track, fallback) {
  if (!track || !track.bvid) return;

  collectState = null;
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
  const rows = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => !q || (e.title || '').toLowerCase().includes(q) || String(i + 1) === q);

  $('collectList').innerHTML = rows.length
    ? rows.map(({ e, i }) => {
      const liked = isFav(e);
      const off = isEntryOff(collectState.bvid, e);
      return `
        <div class="collect-row ${off ? 'off' : ''} ${sameTrack(e, cur) ? 'on' : ''}" data-ci="${i}">
          <span class="cn">${i + 1}</span>
          <span class="ct" title="${esc(e.title)}">${esc(e.title)}</span>
          <span class="cd">${fmtTime(e.duration)}</span>
          <span class="cops">
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
 * 副标题写"已启用 x/y 集"、一键按钮写"全部禁用/全部启用"、两个批量按钮带上数量。
 */
function syncCollectBar() {
  if (!collectState) return;
  const entries = collectState.entries;
  const on = enabledEntries(collectState, entries);
  $('collectSub').textContent = `${collectState.baseSub} · 已启用 ${on.length}/${entries.length} 集`;
  const all = $('btnCollectToggleAll');
  if (all) all.textContent = (on.length === entries.length) ? '全部禁用' : '全部启用';
  const play = $('btnPlayCollect');
  if (play) play.textContent = `播放全部 (${on.length})`;
  const addQ = $('btnQueueCollect');
  if (addQ) addQ.textContent = on.length ? `加入队列 (${on.length})` : '加入队列';
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

/** 把这条合集里"启用的那几首"塞进播放队列（队列空就直接播） */
function queueCollection() {
  if (!collectState) return;
  const on = enabledEntries(collectState, collectState.entries);
  const title = collectState.title;
  if (!on.length) { toast('这条合集里的曲目都被禁用了'); return; }

  if (!queue.tracks.length) {
    closeCollectPanel();
    playTracks(on, 0, title);
    toast(`已开始播放 ${on.length} 首`);
    return;
  }
  let added = 0;
  on.forEach((e) => {
    if (!queue.tracks.some((t) => sameTrack(t, e))) { queue.tracks.push(e); added += 1; }
  });
  toast(added ? `已追加 ${added} 首到当前队列` : '这些都已经在队列里了');
  closeCollectPanel();
  refreshQueueIfOpen();
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
      }
      return;
    }
    const row = e.target.closest('.collect-row');
    if (row) playCollectEntry(Number(row.dataset.ci));
  });
  $('btnCollectToggleAll').addEventListener('click', toggleAllEntries);
  $('btnPlayCollect').addEventListener('click', () => {
    if (!collectState) return;
    const on = enabledEntries(collectState, collectState.entries);
    if (!on.length) { toast('这条合集里的曲目都被禁用了'); return; }
    playTracks(on, 0, collectState.title);
    renderCollectList($('collectSearch').value);
    toast(`开始播放 ${on.length} 首`);
  });
  $('btnQueueCollect').addEventListener('click', queueCollection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && collectState) closeCollectPanel();
  });
}

/* ============================================================
   第 3.8 部分：播放队列
   ------------------------------------------------------------
   队列本来就一直存在（queue.tracks —— 上一首 / 下一首就是按它走的），
   只是以前没有界面，所以播放条/合集面板上的「加入队列」看起来像没生效。
   这里给它一个能从右侧拉开的抽屉：看得见"接下来播什么"，能跳播、移除、打乱、清空。
   ============================================================ */

function renderQueueList(filter) {
  const box = $('queueList');
  if (!box) return;
  const cur = queue.tracks[queue.index];
  const q = (filter || '').trim().toLowerCase();
  const rows = queue.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => !q || (t.title || '').toLowerCase().includes(q) || String(i + 1) === q);

  $('queueSub').textContent = queue.tracks.length
    ? `共 ${queue.tracks.length} 首${queue.name ? ' · 来自「' + queue.name + '」' : ''}`
    : '队列是空的';

  box.innerHTML = rows.length
    ? rows.map(({ t, i }) => `
        <div class="collect-row ${sameTrack(t, cur) ? 'on' : ''}" data-qi="${i}">
          <span class="cn">${i + 1}</span>
          <span class="ct" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="cd">${fmtTime(t.duration)}</span>
          <span class="cops">
            <button class="op-ic" data-qact="remove" data-qi="${i}" data-tip="从队列移除">${ic('i-trash')}</button>
          </span>
        </div>`).join('')
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
  $('btnQueue').addEventListener('click', openQueue);
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

/** 队列变了（比如刚"加入队列"）就把抽屉里看到的内容同步一下 */
function refreshQueueIfOpen() {
  const mask = $('queueMask');
  if (mask && mask.classList.contains('show')) renderQueueList($('queueSearch').value);
}

/* ============================================================
   第 3.9 部分：UP 主主页（点作者名 → 看他的全部视频）
   ------------------------------------------------------------
   B 站的空间接口对"未登录"很敏感：没填 Cookie 时经常直接回风控，
   所以这里的失败提示会明确引导去「设置 → B 站」填 Cookie，而不是丢个看不懂的报错。
   ============================================================ */

let upState = null;   // { mid, name, list, page, hasMore, loading, error }

/** 点作者名：打开这个 UP 主的主页 */
async function openUpPage(track) {
  if (!track || !track.mid) { toast('这条没有 UP 主信息，看不了他的主页'); return; }
  upState = {
    mid: track.mid,
    name: track.author || '这个 UP 主',
    list: [], page: 0, hasMore: true, loading: true, error: '',
  };
  currentView = 'up';
  renderUp();
  await loadUp(1);
}

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
    upState.list = pn === 1 ? mapped : upState.list.concat(mapped);
    upState.page = pn;
    upState.hasMore = !!res.hasMore;
  } catch (err) {
    upState.hasMore = false;
    upState.error = err.message || '读取失败';
  } finally {
    upState.loading = false;
    if (currentView === 'up') renderUp();
  }
}

function renderUp() {
  if (!upState) { currentView = 'discovery'; renderAll(); return; }
  const loaded = upState.list.length;

  const head = `
    <div class="block-head">
      <div>
        <button class="ghost-btn" id="btnUpBack">← 返回</button>
        <div class="block-title" style="margin-top:12px">${esc(upState.name)}</div>
        <div class="block-sub">${loaded ? `已加载 ${loaded} 个视频${upState.hasMore ? '（还能继续往下加载）' : ''}` : '正在读取这个 UP 主的视频…'}</div>
      </div>
      <div class="block-actions">
        ${loaded ? `<button class="ghost-btn" id="btnPlayUp">${ic('i-play')}<span>播放全部</span></button>` : ''}
        ${loaded && upState.hasMore ? '<button class="ghost-btn" id="btnMoreUp">加载更多</button>' : ''}
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
  }) + (upState.loading ? `<div class="loading"><div class="spinner"></div>正在读取更多…</div>` : '');
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
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">我喜欢</div>
        <div class="block-sub">共 ${DB.favorites.length} 首</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayFav">${ic('i-play')}<span>播放全部</span></button>
      </div>
    </div>
    ${trackListHTML(DB.favorites, {
      remove: true,
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
  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">${esc(pl.name)}</div>
        <div class="block-sub">共 ${pl.tracks.length} 首</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayPl">${ic('i-play')}<span>播放全部</span></button>
        <button class="ghost-btn" id="btnRenamePl">重命名</button>
        <button class="ghost-btn" id="btnDelPl">删除歌单</button>
      </div>
    </div>
    ${trackListHTML(pl.tracks, {
      remove: true,
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
            <div class="thumb" style="background-image:url('${esc(f.cover || '')}')"></div>
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
      renderPlaylist(el.dataset.pl);
    });
  });
}

/** 根据 currentView 重新画整个界面 */
function renderAll() {
  renderPlaylistSidebar();
  syncNavHighlight();   // 侧栏高亮永远跟着"当前在哪一页"走（不再只在点侧栏时才更新）
  if (currentView === 'search') renderSearch();
  else if (currentView === 'discovery') {
    renderDiscovery();
    if (!discoveryResults.length && !discoveryLoading && !discoveryError) loadDiscovery();
  }
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'history') renderHistory();
  else if (currentView === 'up') renderUp();
  else if (currentView.startsWith('playlist:')) renderPlaylist(currentView.split(':')[1]);
  else if (currentView === 'parsed') renderParsed();
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
  // 两个"省显卡"开关：同样只在背景是视频时才有意义
  const pOpts = $('bgPerfOpts');
  if (pOpts) {
    pOpts.style.display = isVid ? '' : 'none';
    $('chkPerfLite').checked  = s.bg.perfLite    !== false;
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

  $('rngGlassBlur').value = s.glass.blur ?? 18;
  $('valGlass').textContent = $('rngGlassBlur').value + 'px';

  $('rngGlassAlpha').value = Math.round((s.glass.alpha ?? 0.55) * 100);
  $('valAlpha').textContent = $('rngGlassAlpha').value + '%';

  // 自动歌词开关
  const chk = $('chkAutoLyric');
  if (chk) chk.checked = !!s.autoLyric;

  // Cookie 只在还没填过的时候拉一次，避免覆盖用户正在编辑的内容
  if (!$('cookieInput').value) {
    api('cookieGet').then((t) => { $('cookieInput').value = t || ''; }).catch(() => {});
  }
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
    if (e.key === 'Escape') closeSettings();
  });

  /* ---- 左右两个 Tab ---- */
  $('modalTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $('modalTabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('active', p.dataset.pane === tab.dataset.tab);
    });
  });

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

  // 省显卡两开关
  $('chkPerfLite').addEventListener('change', (e) => {
    DB.settings.bg.perfLite = e.target.checked;
    applyAppearance(); persist();
  });
  $('chkPauseBlur').addEventListener('change', (e) => {
    DB.settings.bg.pauseOnBlur = e.target.checked;
    updateBgVideoPlayback(); persist();
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
  bindRange('rngGlassAlpha', 'valAlpha',  '%',  (v) => { DB.settings.glass.alpha = v / 100; });

  /* ---- 恢复默认外观 ---- */
  $('btnResetAppearance').addEventListener('click', () => {
    DB.settings.theme = 'pink';
    DB.settings.bg    = { file: null, kind: 'image', dim: 0.55, blur: 0, video: { muted: true, loop: true, speed: 1 },
                          perfLite: true, pauseOnBlur: true };
    DB.settings.glass = { blur: 18, alpha: 0.55 };
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
  $('nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    currentView = item.dataset.view;
    renderAll();   // 高亮由 renderAll → syncNavHighlight() 统一刷，这里不再手动改 class
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
      if (act === 'detail') {
        // 记下"来路"再跳走，详情页左上角才有得返回（连滚动位置一起还原）
        parsedOrigin = { view: currentView, label: viewLabel(), scroll: content().scrollTop };
        currentView = 'parsed';
        doParseLink(track.bvid);
        return;
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
    if (id === 'btnPlayUp') { if (upState) startFromView(upState.list, 0); return; }
    if (id === 'btnMoreUp') { if (upState) loadUp(upState.page + 1); return; }
    if (id === 'btnPlayParsed') { startFromView(parsedView.tracks, 0); return; }
    if (id === 'btnAddParsed') { addManyToPlaylist(parsedView.tracks); return; }
    if (id === 'btnPlayFav') { startFromView(DB.favorites, 0); return; }
    if (id === 'btnPlayPl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (pl) startFromView(pl.tracks, 0);
      return;
    }
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
    audio.paused ? audio.play() : audio.pause();
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
  // 播放/暂停/缓冲三个状态，换的是图标本身。
  // 用 innerHTML 换 <use> 引用的名字，视觉上就是"换了个图标"。
  audio.addEventListener('play',    () => { $('btnPlay').innerHTML = ic('i-pause'); updateCoverSpin(); pushLyricToDesktop(); });
  audio.addEventListener('pause',   () => { $('btnPlay').innerHTML = ic('i-play');  updateCoverSpin(); pushLyricToDesktop(); });
  audio.addEventListener('waiting', () => { $('btnPlay').innerHTML = ic('i-loading', 'spin'); });

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
    if (playMode === 'one') { audio.currentTime = 0; audio.play(); return; }
    next(1);
  });

  audio.addEventListener('error', () => {
    // 地址过期是常事（B 站链接有时效），提示一下就好
    if (audio.src) toast('音频加载失败了，可能链接已过期，换一首试试');
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
    //输入框 / 滑杆里，一律不抢键盘（除了 Esc，那是关面板 universally 要的）
    if (isTypingTarget(e.target) && e.key !== 'Escape') return;

    const ctrl = e.ctrlKey || e.metaKey;   // macOS 上 Cmd 也认

    // F11 全屏
    if (e.key === 'F11') {
      e.preventDefault();
      window.neko.setFullScreen(true);
      return;
    }

    // Esc：关歌词大屏 / 关设置面板（在bindSettings 和歌词模块里各自监听，
    //这里只负责放行，不要preventDefault，否则会连输入框里的 Esc 一起吞掉）
    if (e.key === 'Escape') return;

    // Ctrl + L：开 / 关桌面歌词（等价于点「词」按钮）
    if (ctrl && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      toggleDesktopLyric();
      return;
    }

    // Ctrl + D：开 / 关整页歌词（等价于点播放条最左边那张封面）
    if (ctrl && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      toggleLyrics();
      return;
    }

    // 空格：播放 / 暂停
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();   // 防止页面被空格滚下去
      if (!audio.src) { toast('先选一首歌吧'); return; }
      audio.paused ? audio.play() : audio.pause();
      return;
    }

    // Ctrl + 左右方向：上一首 / 下一首
    if (ctrl && e.key === 'ArrowLeft')  { e.preventDefault(); next(-1); return; }
    if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); next(1);  return; }

    // 上下方向：音量 ±5（先挡住浏览器滚动）
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const v = Math.min(100, Math.round((audio.volume || 0) * 100) + 5);
      applyVolume(v, true);
      toast('音量 ' + v + '%');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const v = Math.max(0, Math.round((audio.volume || 0) * 100) - 5);
      applyVolume(v, true);
      toast('音量 ' + v + '%');
      return;
    }

    // 左右方向：快退 / 快进 5 秒
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (audio.src) audio.currentTime = Math.max(0, audio.currentTime - 5);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (audio.src) audio.currentTime = Math.min(totalDuration() || 1e9, audio.currentTime + 5);
      return;
    }
  });

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
    const box = $('lyricBox');
    if (box) box.innerHTML = '';
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
    box.innerHTML = '<p class="l">（没有歌词）</p>';
    return;
  }
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

/** 播放中给封面套一圈旋转弧线（暂停就停），一眼能看出在播 */
function updateCoverSpin() {
  const cover = $('npCover');
  if (cover) cover.classList.toggle('spin', !audio.paused && !!audio.src);
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
  btn.title = lyricState.loading ? '正在取歌词…'
    : (desktopOn ? '关闭桌面歌词（Ctrl+L）' : '桌面歌词（Ctrl+L）');
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

  // 封面是它的开关，得跟着亮/灭，不然点了不知道现在是什么状态
  const cover = $('npCover');
  if (cover) {
    cover.classList.toggle('open', show);
    cover.title = show ? '收起歌词（Ctrl+D）' : '查看歌词（Ctrl+D）';
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
}

function closeDesktopLyric() {
  lw().on = false;
  window.neko.lyricClose();
  updateLyricBtn();
  syncLyricSettingsUI();
  updateLyricHeadBtn();
  persistLater();
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
      audio.paused ? audio.play() : audio.pause();
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
  const box = $('lyricBox');
  if (box) box.innerHTML = '';
  const warn = $('lyricWarn');
  if (warn) { warn.innerHTML = ''; warn.classList.remove('show'); }
  if (DB.settings.autoLyric) loadLyrics(false);
  else updateLyricBtn();
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
    // 合集的"单集开关"与"曲目表缓存"：老存档没有这两项，补成空的（= 全部启用）
    DB.collectOff = (DB.collectOff && typeof DB.collectOff === 'object') ? DB.collectOff : {};
    DB.collectParts = (DB.collectParts && typeof DB.collectParts === 'object') ? DB.collectParts : {};
  } catch (e) {
    console.error('读取存档失败', e);
  }

  // 2) 补好外观设置，并把它刷到界面上（主题、背景、毛玻璃）
  migrateSettings();
  applyAppearance();

  // 2.2) 播放模式：恢复上次选的那个（老存档没有 → 列表循环），并把按钮图标刷成对应形状
  setPlayMode(DB.settings.playMode, false);

  // 2.5) 音量记忆：把上次退出时的音量填回播放器（浮层里的数字和滑块由 updateVolumeUI 同步）
  const vol = DB.settings.volume ?? 80;
  if (vol > 0) volBeforeMute = vol;
  applyVolume(vol, false);

  // 3) 绑事件
  bindEvents();

  // 4) 画界面
  renderAll();

  // 4.5) 量出顶部工具栏的真实高度（歌词大屏要贴着它的下沿铺，不能盖住搜索框）
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);

  // 5) 如果上次有在听的歌，把信息显示在底部（不自动播放，免得吓一跳）
  if (DB.lastTrack) {
    $('npTitle').textContent = DB.lastTrack.title;
    $('npSub').textContent = DB.lastTrack.author || '';
    if (DB.lastTrack.cover) {
      $('npCover').style.backgroundImage = `url("${DB.lastTrack.cover}")`;
      $('npCover').style.backgroundSize = 'cover';
    }
  }

  // 6) 上次退出时桌面歌词是开着的，就把它重新挂回屏幕上（位置也还是上次那个）
  syncLyricSettingsUI();
  if (lw().on) {
    openDesktopLyric();
    if (DB.settings.autoLyric && DB.lastTrack) loadLyrics(false);
  }
}

boot();
