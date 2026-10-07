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
    bg:    { file: null, dim: 0.55, blur: 0 },
    glass: { blur: 18, alpha: 0.55 },
    autoLyric: false,
  },
};

// 当前播放队列
let queue = { tracks: [], index: -1, name: '' };

// 界面当前所处的页面，比如 'search' / 'favorites' / 'history' / 'playlist:xxx'
let currentView = 'search';

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
  bg:    { file: null, dim: 0.55, blur: 0 },
  glass: { blur: 18, alpha: 0.55 },
  autoLyric: false,   // 自动加载歌词：默认关（用户可开，或手动点「词」）
  lyricWin: null,     // 桌面歌词悬浮窗的设置（默认由 DEFAULT_LYRIC_WIN 补）
};

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
  };
  if (typeof old.theme === 'string') DB.settings.theme = old.theme;
  if (typeof old.volume === 'number') DB.settings.volume = old.volume;

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

  // 3) 背景图
  const layer = $('bgLayer');
  if (layer) {
    const has = !!s.bg.file;
    layer.style.setProperty('--bg-image', has ? `url("bg://local/${s.bg.file}")` : 'none');
    layer.style.setProperty('--bg-dim',  String(s.bg.dim  ?? 0.55));
    // blur(0px) 会让多余的图层一直占着显卡，直接用 none 更省
    const b = Number(s.bg.blur) || 0;
    layer.style.setProperty('--bg-blur', b > 0 ? b + 'px' : '0px');
    layer.style.filter = b > 0 ? `blur(${b}px)` : 'none';
    document.body.classList.toggle('has-bg', has);
  }

  // 4) 主题换了，桌面歌词悬浮窗的"当前句"颜色也要跟着换
  pushLyricStyle();
}

/* ============================================================
   第 3 部分：播放核心
   ============================================================ */

const audio = $('audio');
let loopMode = 'list';   // list = 列表循环, one = 单曲循环, shuffle = 随机
let shuffled = false;

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

/** 切上一首 / 下一首 */
function next(step) {
  if (!queue.tracks.length) return;
  let i;
  if (shuffled && step > 0) {
    i = Math.floor(Math.random() * queue.tracks.length);
  } else {
    i = (queue.index + step + queue.tracks.length) % queue.tracks.length;
  }
  playAt(i);
}

/** 把一组曲目设为播放队列并开始播放 */
function playTracks(tracks, startIndex = 0, name = '') {
  if (!tracks || !tracks.length) return;
  queue = { tracks, index: -1, name };
  playAt(startIndex);
}

/* ============================================================
   第 4 部分：页面渲染
   ============================================================ */

const content = () => $('content');

/** 渲染一首歌的一行 */
function trackRow(track, i, opts = {}) {
  const playing = sameTrack(track, queue.tracks[queue.index]);
  const liked = isFav(track);
  // 长视频 / 疑似合集，在行上放一个「选集 N」小徽章当入口（详情见 expandCollection）
  const showBadge = opts.expand !== false && maybeCollection(track);
  const badgeLabel = track.parts > 1 ? `选集 ${track.parts}`
    : track.seasonCount > 1 ? `合集 ${track.seasonCount}` : '选集';
  return `
    <div class="track ${playing ? 'playing' : ''}" data-i="${i}">
      <div class="idx">${playing ? BARS_ICON : i + 1}</div>
      <div class="cover" style="background-image:url('${esc(track.cover || '')}')"></div>
      <div class="info">
        <div class="t">${esc(track.title)}</div>
        <div class="a">${esc(track.author || '')}</div>
      </div>
      ${showBadge ? `<button class="badge" data-act="expand" data-i="${i}" title="展开选集 / 合集">${badgeLabel}</button>` : ''}
      <div class="dur">${fmtTime(track.duration)}</div>
      <div class="ops">
        <button class="op-btn ${liked ? 'liked' : ''}" data-act="fav" data-i="${i}">${liked ? '已收藏' : '收藏'}</button>
        <button class="op-btn" data-act="add" data-i="${i}">＋歌单</button>
        ${opts.detail ? `<button class="op-btn" data-act="detail" data-i="${i}">详情</button>` : ''}
        ${opts.remove ? `<button class="op-btn" data-act="remove" data-i="${i}">移除</button>` : ''}
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
  if (track.parts > 1) return true;          // 已经查过，确实是分P
  if (track.seasonCount > 1) return true;    // 已经查过，确实是合集
  if ((track.duration || 0) >= 30 * 60) return true;   // 半小时以上，多半是长合集
  return COLLECT_HINT_RE.test(track.title || '');
}

let collectState = null;   // 面板开着时才有值：{ title, sub, entries }

function closeCollectPanel() {
  const mask = $('collectMask');
  if (mask) mask.classList.remove('show');
  collectState = null;
}

/** 点「选集」徽章：查一次 videoInfo 把分P/合集摊开；若其实不是合集就直接播 */
async function expandCollection(track, fallback) {
  if (!track || !track.bvid) return;

  collectState = { title: track.title, sub: '', entries: [] };
  $('collectTitle').textContent = track.title;
  $('collectSub').textContent = '正在读取选集…';
  $('collectSearch').value = '';
  $('collectList').innerHTML = `<div class="loading"><div class="spinner"></div>正在读取…</div>`;
  $('collectMask').classList.add('show');

  let info;
  try {
    info = await api('videoInfo', track.bvid);
  } catch (err) {
    $('collectSub').textContent = '';
    $('collectList').innerHTML = `<div class="err">读取失败：${esc(err.message)}</div>`;
    return;
  }

  const entries = buildCollectionEntries(info);
  if (entries.length <= 1) {
    // 其实只有 1 个分P —— 不是合集，收起来直接播这一首
    closeCollectPanel();
    if (fallback && fallback.tracks) playTracks(fallback.tracks, fallback.index, fallback.name);
    return;
  }

  // 记下数量，让行上的徽章从「选集」变成「选集 N」
  track.parts = info.pages ? info.pages.length : 1;
  track.seasonCount = info.season ? info.season.episodes.length : 0;

  const total = entries.reduce((s, e) => s + (e.duration || 0), 0);
  collectState = {
    title: info.title || track.title,
    sub: (info.season
      ? `合集「${info.season.title}」 · ${entries.length} 集`
      : `${entries.length} 个分P`) + ` · 共 ${fmtTime(total)}`,
    entries,
  };
  $('collectSub').textContent = collectState.sub;
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
    ? rows.map(({ e, i }) => `
        <div class="collect-row ${sameTrack(e, cur) ? 'on' : ''}" data-ci="${i}">
          <span class="cn">${i + 1}</span>
          <span class="ct" title="${esc(e.title)}">${esc(e.title)}</span>
          <span class="cd">${fmtTime(e.duration)}</span>
        </div>`).join('')
    : `<div class="err">没有匹配的条目</div>`;
}

/** 点面板里的某一集：直接播这一集（用它的 cid 单独取音频） */
function playCollectEntry(i) {
  if (!collectState) return;
  const entries = collectState.entries;
  if (!entries[i]) return;
  playTracks(entries, i, collectState.title);
  renderCollectList($('collectSearch').value);   // 刷新"正在播放"高亮
}

/** 把整段合集塞进播放队列（队列空就直接播） */
function queueCollection() {
  if (!collectState) return;
  const entries = collectState.entries;
  const title = collectState.title;
  if (!entries.length) return;

  if (!queue.tracks.length) {
    closeCollectPanel();
    playTracks(entries.slice(), 0, title);
    toast(`已开始播放 ${entries.length} 首`);
    return;
  }
  let added = 0;
  entries.forEach((e) => {
    if (!queue.tracks.some((t) => sameTrack(t, e))) { queue.tracks.push(e); added += 1; }
  });
  toast(added ? `已加入队列 ${added} 首` : '这些都已经在队列里了');
  closeCollectPanel();
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
    const row = e.target.closest('.collect-row');
    if (row) playCollectEntry(Number(row.dataset.ci));
  });
  $('btnPlayCollect').addEventListener('click', () => {
    if (!collectState) return;
    const n = collectState.entries.length;
    playTracks(collectState.entries, 0, collectState.title);
    renderCollectList($('collectSearch').value);
    toast(`开始播放 ${n} 首`);
  });
  $('btnQueueCollect').addEventListener('click', queueCollection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && collectState) closeCollectPanel();
  });
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
  content().innerHTML = `<div class="loading"><div class="spinner"></div>正在 B 站搜索…</div>`;
  try {
    const res = await api('search', keyword, page);
    searchResults = res.list.map((v) => ({
      bvid: v.bvid,
      cid: null,        // 搜索结果没有 cid，播放时再补全
      page: 1,
      title: v.title,
      author: v.author,
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
            cover: v.cover, duration: parseDuration(v.duration),
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

  content().innerHTML = `
    <div class="block-head">
      <div>
        <div class="block-title">${esc(info.title)}</div>
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
  if (!pl) return renderSearch();
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
  if (currentView === 'search') renderSearch();
  else if (currentView === 'discovery') {
    renderDiscovery();
    if (!discoveryResults.length && !discoveryLoading && !discoveryError) loadDiscovery();
  }
  else if (currentView === 'favorites') renderFavorites();
  else if (currentView === 'history') renderHistory();
  else if (currentView.startsWith('playlist:')) renderPlaylist(currentView.split(':')[1]);
  else if (currentView === 'parsed') renderParsed();
}

/* ============================================================
   第 4.5 部分：把曲目加进歌单
   ============================================================ */
async function addToPlaylist(track) {
  if (!DB.playlists.length) {
    DB.playlists.push({ id: uid(), name: '我的歌单', tracks: [] });
  }
  let pl;
  if (DB.playlists.length === 1) {
    pl = DB.playlists[0];
  } else {
    // 多个歌单时，弹出列表让用户选一个（输入序号）
    const names = DB.playlists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const pick = prompt(`要加到哪个歌单？\n\n${names}\n\n请输入序号：`, '1');
    if (!pick) return;
    pl = DB.playlists[Number(pick) - 1];
  }
  if (!pl) { toast('序号不对哦'); return; }
  if (pl.tracks.some((t) => sameTrack(t, track))) { toast('这首歌已经在歌单里了'); return; }
  pl.tracks.push(track);
  await persist();
  renderAll();
  toast(`已加入「${pl.name}」`);
}

function deletePlaylist(id) {
  const pl = DB.playlists.find((p) => p.id === id);
  if (!pl) return;
  if (!confirm(`确定删除歌单「${pl.name}」吗？`)) return;
  DB.playlists = DB.playlists.filter((p) => p.id !== id);
  persist();
  currentView = 'search';
  renderAll();
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

  $('bgHint').textContent = s.bg.file ? '当前：自定义背景 ✓' : '当前：默认深色背景';

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
      applyAppearance(); syncSettingsUI(); persist();
      toast(res.sizeMB > 20
        ? `背景已换（${res.sizeMB}MB，图有点大，可能会略卡）`
        : '背景已换 ✓');
    } catch (err) {
      toast('选图失败：' + err.message);
    }
  });

  $('btnClearBg').addEventListener('click', async () => {
    try { await api('clearBackground'); } catch (e) { /* 目录本来就是空的 */ }
    DB.settings.bg.file = null;
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
    DB.settings.bg    = { file: null, dim: 0.55, blur: 0 };
    DB.settings.glass = { blur: 18, alpha: 0.55 };
    api('clearBackground').catch(() => {});
    applyAppearance(); syncSettingsUI(); persist();
    toast('外观已恢复默认');
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
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    currentView = item.dataset.view;
    renderAll();
  });

  /* ---- 设置面板（外观 + Cookie） ---- */
  bindSettings();

  /* ---- 合集 / 分P 展开面板 ---- */
  bindCollect();

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

  /* ---- 新建歌单 ---- */
  $('btnNewPlaylist').addEventListener('click', async () => {
    const name = prompt('新歌单叫什么名字？', '我的歌单');
    if (!name) return;
    const pl = { id: uid(), name, tracks: [] };
    DB.playlists.push(pl);
    await persist();
    currentView = 'playlist:' + pl.id;
    renderAll();
  });

  /* ---- 内容区：列表点击（事件委托，一次绑定管所有动态行） ---- */
  $('content').addEventListener('click', async (e) => {
    // 「选集 N」徽章：展开合集 / 分P 面板（单独拦下，不触发整行"播放"）
    const badge = e.target.closest('.badge');
    if (badge) {
      const i = Number(badge.dataset.i);
      const tracks = currentTracks();
      if (tracks[i]) expandCollection(tracks[i], { tracks, index: i, name: queue.name || '' });
      return;
    }

    // 行内的小按钮
    const btn = e.target.closest('.op-btn');
    if (btn) {
      const i = Number(btn.dataset.i);
      const tracks = currentTracks();
      const track = tracks[i];
      if (!track) return;
      const act = btn.dataset.act;

      if (act === 'fav') { toggleFav(track); return; }
      if (act === 'add') { addToPlaylist(track); return; }
      if (act === 'remove') { removeFromCurrent(track); return; }
      if (act === 'detail') { currentView = 'parsed'; doParseLink(track.bvid); return; }
      return;
    }

    // 块级按钮（用 closest('[id]') 而不是直接 e.target.id，
    // 这样按钮里万一包了子元素，点子元素也能正确命中按钮本身）
    const idEl = e.target.closest('[id]');
    const id = idEl ? idEl.id : '';
    if (id === 'btnPlayAll') { playTracks(searchResults, 0, `搜索：${searchKeyword}`); return; }
    if (id === 'btnRefreshDiscovery') { loadDiscovery(true); return; }
    if (id === 'btnPlayDiscovery') { playTracks(discoveryResults, 0, '发现'); return; }
    if (id === 'btnPrevPage') { if (searchPage > 1) doSearch(searchKeyword, searchPage - 1); return; }
    if (id === 'btnNextPage') { doSearch(searchKeyword, searchPage + 1); return; }
    if (id === 'btnPlayParsed') { playTracks(parsedView.tracks, 0, parsedView.info.title); return; }
    if (id === 'btnAddParsed') { addManyToPlaylist(parsedView.tracks); return; }
    if (id === 'btnPlayFav') { playTracks(DB.favorites, 0, '我喜欢'); return; }
    if (id === 'btnPlayPl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (pl) playTracks(pl.tracks, 0, pl.name);
      return;
    }
    if (id === 'btnRenamePl') {
      const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
      if (!pl) return;
      const name = prompt('改个新名字：', pl.name);
      if (!name) return;
      pl.name = name;
      await persist();
      renderAll();
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
      if (tracks.length) playTracks(tracks, i, queue.name || '');
    }
  });

  /* ---- 播放条：播放/暂停、上下首、随机、循环 ---- */
  $('btnPlay').addEventListener('click', () => {
    if (!audio.src) { toast('先选一首歌吧'); return; }
    audio.paused ? audio.play() : audio.pause();
  });
  $('btnPrev').addEventListener('click', () => next(-1));
  $('btnNext').addEventListener('click', () => next(1));
  $('btnShuffle').addEventListener('click', () => {
    shuffled = !shuffled;
    $('btnShuffle').classList.toggle('on', shuffled);
    toast(shuffled ? '随机播放：开' : '随机播放：关');
  });
  $('btnLoop').addEventListener('click', () => {
    loopMode = loopMode === 'list' ? 'one' : 'list';
    $('btnLoop').classList.toggle('on', loopMode === 'one');
    // 单曲循环的图标右边多一个小 "1"，一眼就能看出当前是哪种模式
    $('btnLoop').innerHTML = ic(loopMode === 'one' ? 'i-repeat1' : 'i-repeat');
    toast(loopMode === 'one' ? '单曲循环' : '列表循环');
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
    if (loopMode === 'one') { audio.currentTime = 0; audio.play(); return; }
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
  if (currentView === 'parsed' && parsedView) return parsedView.tracks;
  if (currentView.startsWith('playlist:')) {
    const pl = DB.playlists.find((p) => 'playlist:' + p.id === currentView);
    return pl ? pl.tracks : [];
  }
  return searchResults;
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

/** 把一整批曲目加入歌单（比如整个合集） */
async function addManyToPlaylist(tracks) {
  if (!tracks || !tracks.length) return;
  if (!DB.playlists.length) DB.playlists.push({ id: uid(), name: '我的歌单', tracks: [] });
  let pl = DB.playlists[0];
  if (DB.playlists.length > 1) {
    const names = DB.playlists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const pick = prompt(`把 ${tracks.length} 首加到哪个歌单？\n\n${names}\n\n请输入序号：`, '1');
    if (!pick) return;
    pl = DB.playlists[Number(pick) - 1];
  }
  if (!pl) { toast('序号不对哦'); return; }
  let added = 0;
  tracks.forEach((t) => {
    if (!pl.tracks.some((x) => sameTrack(x, t))) { pl.tracks.push(t); added++; }
  });
  await persist();
  renderAll();
  toast(`已把 ${added} 首加入「${pl.name}」`);
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
  } catch (e) {
    console.error('读取存档失败', e);
  }

  // 2) 补好外观设置，并把它刷到界面上（主题、背景、毛玻璃）
  migrateSettings();
  applyAppearance();

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
