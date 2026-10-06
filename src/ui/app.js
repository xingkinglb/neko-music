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

// 存档数据：歌单、收藏、历史
let DB = { playlists: [], favorites: [], history: [], lastTrack: null };

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
  $('btnFav').textContent = isFav(track) ? '♥' : '♡';
  $('btnFav').classList.toggle('on', isFav(track));
  $('btnPlay').textContent = '⏳';
  $('timeTotal').textContent = fmtTime(track.duration);

  try {
    // 如果这首歌还不知道自己的 cid（搜索来的），先查一次补上
    await ensureCid(track);

    // 关键一步：向主进程要音频地址。
    // B 站的真实地址带防盗链，主进程已经帮我们包装成 bili:// 内部地址。
    const info = await api('audioUrl', track.bvid, track.cid);
    audio.src = info.url;
    audio.volume = ($('volume').value || 80) / 100;

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
      <div class="idx">${playing ? '♪' : i + 1}</div>
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
      <div class="big">${opts.emptyIcon || '🎧'}</div>
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
      <div class="big">🔍</div>
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
        <button class="ghost-btn" id="btnPlayAll">▶ 播放全部</button>
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
        <button class="ghost-btn" id="btnPlayParsed">▶ 播放全部 (${tracks.length})</button>
        <button class="ghost-btn" id="btnAddParsed">＋ 全部加入歌单</button>
      </div>
    </div>

    ${hasSeason ? `
      <div class="card-grid" style="margin-bottom:18px">
        <div class="card" style="cursor:default">
          <div class="thumb" style="background-image:url('${esc(info.season.cover || info.cover)}')"></div>
          <div class="c-title">📚 ${esc(info.season.title)}</div>
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
        <div class="block-title">💗 我喜欢</div>
        <div class="block-sub">共 ${DB.favorites.length} 首</div>
      </div>
      <div class="block-actions">
        <button class="ghost-btn" id="btnPlayFav">▶ 播放全部</button>
      </div>
    </div>
    ${trackListHTML(DB.favorites, {
      remove: true,
      emptyIcon: '💗',
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
        <div class="block-title">🕘 最近播放</div>
        <div class="block-sub">共 ${DB.history.length} 首</div>
      </div>
    </div>
    ${trackListHTML(DB.history, {
      emptyIcon: '🕘',
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
        <button class="ghost-btn" id="btnPlayPl">▶ 播放全部</button>
        <button class="ghost-btn" id="btnRenamePl">重命名</button>
        <button class="ghost-btn" id="btnDelPl">删除歌单</button>
      </div>
    </div>
    ${trackListHTML(pl.tracks, {
      remove: true,
      emptyIcon: '📝',
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
          <div class="block-title">📁 选择要导入的收藏夹</div>
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
    ul.innerHTML = `<li style="padding:8px 10px;font-size:12px;color:#6b6b83">还没有歌单，点 ＋ 建一个</li>`;
    return;
  }
  ul.innerHTML = DB.playlists.map((p) => `
    <li class="playlist-row ${currentView === 'playlist:' + p.id ? 'active' : ''}" data-pl="${p.id}">
      <span class="name">🎵 ${esc(p.name)}</span>
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
   第 5 部分：事件绑定
   ============================================================ */

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

  /* ---- 设置：填 B 站 Cookie ---- */
  $('btnSettings').addEventListener('click', async () => {
    const cur = await api('cookieGet');
    const text = prompt(
      '填 B 站登录 Cookie，能大幅减少"搜索被限流"。\n\n' +
      '怎么拿：\n' +
      '1. 用浏览器打开 bilibili.com 并登录\n' +
      '2. 按 F12 → 点「Application / 应用程序」\n' +
      '3. 左边找 Cookies → www.bilibili.com\n' +
      '4. 找到名叫 SESSDATA 的一行，复制它的值\n\n' +
      '粘贴到这里即可（也可以把整串 Cookie 都贴进来）。\n' +
      '不填也能用，只是偶尔会撞上限流。',
      cur || ''
    );
    if (text === null) return;
    await api('cookieSet', text.trim());
    toast(text.trim() ? '已保存 ✔ 搜索会更稳定' : '已清空 Cookie');
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

    // 块级按钮
    const id = e.target.id;
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
    toast(loopMode === 'one' ? '单曲循环' : '列表循环');
  });

  $('btnFav').addEventListener('click', () => {
    const t = queue.tracks[queue.index];
    if (t) toggleFav(t);
  });

  /* ---- 进度条：点击跳转 ---- */
  $('progress').addEventListener('click', (e) => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  });

  /* ---- 音量 ---- */
  $('volume').addEventListener('input', (e) => {
    audio.volume = e.target.value / 100;
  });

  /* ---- 音频事件 ---- */
  audio.addEventListener('play', () => { $('btnPlay').textContent = '⏸'; });
  audio.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; });
  audio.addEventListener('waiting', () => { $('btnPlay').textContent = '⏳'; });

  audio.addEventListener('timeupdate', () => {
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
    toast('已加入我喜欢 💗');
  }
  await persist();
  if (sameTrack(track, queue.tracks[queue.index])) {
    $('btnFav').textContent = isFav(track) ? '♥' : '♡';
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

  // 2) 绑事件
  bindEvents();

  // 3) 画界面
  renderAll();

  // 4) 如果上次有在听的歌，把信息显示在底部（不自动播放，免得吓一跳）
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
