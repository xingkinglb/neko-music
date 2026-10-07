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
  if (!res.ok) throw new Error(res.error || '操作失败');
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
  },
};

// 当前播放队列
let queue = { tracks: [], index: -1, name: '' };

// 界面当前所处的页面，比如 'search' / 'favorites' / 'history' / 'playlist:xxx'
let currentView = 'search';

/** 把内存中的数据写到硬盘（每次改动后调用） */
async function persist() {
  try {
    await window.neko.saveData(DB);
  } catch (e) {
    console.error('保存失败', e);
  }
}

let persistTimer = null;
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
};

/** 补齐 DB.settings 里缺的字段（老版本存档没有这一项） */
function migrateSettings() {
  const old = (DB.settings && typeof DB.settings === 'object') ? DB.settings : {};
  DB.settings = {
    theme:  DEFAULT_SETTINGS.theme,
    volume: DEFAULT_SETTINGS.volume,
    bg:     Object.assign({}, DEFAULT_SETTINGS.bg,    old.bg    || {}),
    glass:  Object.assign({}, DEFAULT_SETTINGS.glass, old.glass || {}),
  };
  if (typeof old.theme === 'string') DB.settings.theme = old.theme;
  if (typeof old.volume === 'number') DB.settings.volume = old.volume;
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

/**
 * 补齐 cid。
 * B 站的搜索接口和收藏夹接口只给 BV 号，不给 cid（cid 是"某一P"的身份号），
 * 而拿音频必须要 cid。所以播放前先查一次视频详情补上。
 */
async function ensureCid(track) {
  if (track.cid) return track.cid;
  const info = await api('videoInfo', track.bvid);
  const p = info.pages && info.pages[0];
  if (!p) throw new Error('这个视频没有可播放的内容');
  track.cid = p.cid;
  if (!track.duration) track.duration = p.duration;
  if (!track.author) track.author = info.owner.name;
  if (!track.cover) track.cover = info.cover;
  return track.cid;
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
    persist();

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
  return `
    <div class="track ${playing ? 'playing' : ''}" data-i="${i}">
      <div class="idx">${playing ? BARS_ICON : i + 1}</div>
      <div class="cover" style="background-image:url('${esc(track.cover || '')}')"></div>
      <div class="info">
        <div class="t">${esc(track.title)}</div>
        <div class="a">${esc(track.author || '')}</div>
      </div>
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

/* ---------- 页面 1：搜索结果 ---------- */
let searchResults = [];
let searchKeyword = '';
let searchPage = 1;

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
 * 设置音量（0~100），顺手把喇叭图标也换掉。
 * 三档图标：0 = 静音（叉），小于一半 = 小声（一道弧），其余 = 大声（两道弧）。
 * save 为 true 时写进存档（拖动滑杆时用防抖版，避免一秒钟存上百次）。
 */
function applyVolume(v, save) {
  audio.volume = v / 100;
  $('volIcon').innerHTML = ic(v === 0 ? 'i-vol-x' : (v < 50 ? 'i-vol-1' : 'i-vol-2'));
  if (save) {
    DB.settings.volume = v;
    persistLater();
  }
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
  }
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);

  /* ---- 音量：拖动即时生效，停手后写进存档（下次打开还是这个值） ---- */
  $('volume').addEventListener('input', (e) => {
    applyVolume(Number(e.target.value), true);
  });

  /* ---- 音频事件 ---- */
  // 播放/暂停/缓冲三个状态，换的是图标本身。
  // 用 innerHTML 换 <use> 引用的名字，视觉上就是"换了个图标"。
  audio.addEventListener('play',    () => { $('btnPlay').innerHTML = ic('i-pause'); });
  audio.addEventListener('pause',   () => { $('btnPlay').innerHTML = ic('i-play'); });
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
  });

  audio.addEventListener('ended', () => {
    if (loopMode === 'one') { audio.currentTime = 0; audio.play(); return; }
    next(1);
  });

  audio.addEventListener('error', () => {
    // 地址过期是常事（B 站链接有时效），提示一下就好
    if (audio.src) toast('音频加载失败了，可能链接已过期，换一首试试');
  });
}

/** 有些音频流拿不到总时长，就用曲目信息里的时长兜底 */
function totalDuration() {
  if (audio.duration && isFinite(audio.duration)) return audio.duration;
  const t = queue.tracks[queue.index];
  return t ? t.duration : 0;
}

/** 当前页面正在显示的那组曲目 */
function currentTracks() {
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
  try {
    DB = (await window.neko.loadData()) || DB;
    DB.playlists = DB.playlists || [];
    DB.favorites = DB.favorites || [];
    DB.history = DB.history || [];
  } catch (e) {
    console.error('读取存档失败', e);
  }

  // 2) 补好外观设置，并把它刷到界面上（主题、背景、毛玻璃）
  migrateSettings();
  applyAppearance();

  // 2.5) 音量记忆：把上次退出时的音量填回滑块和播放器
  const vol = DB.settings.volume ?? 80;
  $('volume').value = vol;
  applyVolume(vol, false);

  // 3) 绑事件
  bindEvents();

  // 4) 画界面
  renderAll();

  // 5) 如果上次有在听的歌，把信息显示在底部（不自动播放，免得吓一跳）
  if (DB.lastTrack) {
    $('npTitle').textContent = DB.lastTrack.title;
    $('npSub').textContent = DB.lastTrack.author || '';
    if (DB.lastTrack.cover) {
      $('npCover').style.backgroundImage = `url("${DB.lastTrack.cover}")`;
      $('npCover').style.backgroundSize = 'cover';
    }
  }
}

boot();
