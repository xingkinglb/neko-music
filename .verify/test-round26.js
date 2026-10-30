/* 第二十六轮：v2.11.0 解析页工具条 + 合集「整体加入歌单」（离屏渲染 + 真跑应用代码）

   改的是什么：
     A. 解析页头部：工具条在上、标题在下（标题再长也不挤按钮），搜索接进来
     B. 「整个合集加入」：加的是**一行**「合集 18」，不是摊开的 18 行
     C. 分 P 视频同样处理（用 parts 字段）
     D. 批量选择：解析页不给「移出」，全选 = 摊平后的每一集
     E. 下载：选中合集行先问一句，确认后用 buildSequence 摊平

   量什么（★ = 这条最要紧）：
     [A1] .parsed-top 里工具条排在标题**之前**
     [A2] 按钮是「整个合集加入」「批量选择」；旧的播放全部 / 批量下载都没了
     [A3] ★ 标题很长时工具条仍在上面一行（不被挤走）
     [B1] 搜索能筛，焦点不丢
     [C1] ★ 点「整个合集加入」→ 歌单里**只有 1 行**
     [C2] ★ 那一行 cid 是 null、seasonCount 是 18（入口行的两个硬要求）
     [C3] ★ 徽章显示「合集 18」、副标题「共 18 首」
     [C4] 曲目表写进了 collectParts，而且剥掉了封面
     [D1] 分 P 视频：同样 1 行，parts = 12
     [E1] ★ 解析页的批量选择里没有「移出」
     [E2] 全选 = 18 集
     [F1] ★ 选中合集行点下载 → 先弹确认，文案写明 18 集
     [F2] ★ 取消 → 什么都不发
     [F3] ★ 确认 → 交给主进程的是 18 首（不是 1 首）
     [Z ] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round26-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const die = (e) => {
  try { say('\n💥 测试脚本自身抛异常（不是产品失败）：' + ((e && e.stack) || e)); } catch (_) {}
  try { process.exit(3); } catch (_) {}
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

/* ---------- 两个场景：18 集合集 / 12 段分P ---------- */
const LONG_TITLE = '【真栗】《如果的事》如果我已经不能控制每天想栗亿次那就让我想你想到失眠到天亮好了';

function seasonInfo(n) {
  const eps = Array.from({ length: n }, (_, i) => ({
    bvid: 'BVep' + i, cid: 9000 + i, page: 1,
    title: '第 ' + (i + 1) + ' 集：如果的事', duration: 200 + i, cover: 'https://x/c' + i + '.jpg',
  }));
  return {
    bvid: 'BVseason', aid: 1, title: LONG_TITLE, cover: 'https://x/cover.jpg',
    owner: { mid: 7, name: '听雨GGMU' }, duration: 4000,
    pages: [{ bvid: 'BVseason', cid: 1, page: 1, title: LONG_TITLE, duration: 4000 }],
    season: { id: 1, title: '温柔栗音', cover: 'https://x/s.jpg', episodes: eps },
  };
}
function multiPInfo(n) {
  const pages = Array.from({ length: n }, (_, i) => ({
    bvid: 'BVmulti', cid: 7000 + i, page: i + 1,
    title: 'P' + (i + 1) + ' 片段', duration: 120 + i,
  }));
  return {
    bvid: 'BVmulti', aid: 2, title: '一支有 12 段分 P 的视频', cover: 'https://x/m.jpg',
    owner: { mid: 8, name: '分P狂魔' }, duration: 1800, pages, season: null,
  };
}

let currentInfo = seasonInfo(18);

/* ---------- IPC 桩 ---------- */
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=https%3A%2F%2Fexample.invalid%2Fa.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: currentInfo.bvid } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: currentInfo }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:line', () => {});
ipcMain.on('lyric:move', () => {});
ipcMain.on('ui-state', () => {});

const stubDl = require('./stub-download-ipc.js');
stubDl();

let win = null;
let evalJS = null;

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败|测试环境/i.test(msg)) {
      errors.push('[页面] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  evalJS = (code) => win.webContents.executeJavaScript(code);
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    DB.settings.download = { dir: 'C:\\\\fake-dl' };
    window.addEventListener('unhandledrejection', (e) => {
      console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason));
    });
    return true;
  })()`);

  /* ============================================================
     A. 解析页头部结构
     ============================================================ */
  say('=== A. 解析页头部 ===');
  await evalJS(`doParseLink('BVseason')`);
  await sleep(800);

  {
    const r = await evalJS(`(() => {
      const top = document.querySelector('#content .parsed-top');
      const bar = document.querySelector('#content .parsed-bar');
      const title = document.querySelector('#content .parsed-title');
      const btns = [...document.querySelectorAll('#content .parsed-bar .block-actions button')].map((b) => b.textContent.trim());
      return {
        hasTop: !!top, hasBar: !!bar, hasTitle: !!title,
        barBeforeTitle: !!(bar && title && (bar.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)),
        btns,
        rows: document.querySelectorAll('#content .track').length,
        oldBtns: [!!document.getElementById('btnPlayParsed'), !!document.getElementById('btnDownloadParsed')],
        blockHead: !!document.querySelector('#content .block-head'),
      };
    })()`);
    if (r.hasTop && r.hasBar && r.hasTitle) ok('[A1] 解析页有 .parsed-top / .parsed-bar / .parsed-title');
    else bad(`[A1] 头部结构不全：${JSON.stringify(r)}`);
    if (r.barBeforeTitle) ok('[A1] ★ 工具条排在标题**之前**（工具条在上、标题在下）');
    else bad('[A1] ★ 工具条没排在标题前面');
    if (r.blockHead) bad('[A1] 解析页还在用 .block-head（标题一长就会压扁按钮）');
    else ok('[A1] 解析页不再用 .block-head');
    if (JSON.stringify(r.btns) === JSON.stringify(['＋ 整个合集加入', '批量选择']))
      ok(`[A2] 按钮是 ${r.btns.join(' / ')}`);
    else bad(`[A2] 按钮不对：${JSON.stringify(r.btns)}`);
    if (!r.oldBtns[0] && !r.oldBtns[1]) ok('[A2] 旧的「播放全部」「批量下载」都不在了');
    else bad(`[A2] 旧按钮还在：${JSON.stringify(r.oldBtns)}`);
    if (r.rows === 18) ok('[A2] 列表是摊平后的 18 集');
    else bad(`[A2] 列表行数 ${r.rows}，期望 18`);
  }

  // 长标题不能把工具条挤走：标题的宽度不能超过内容区，且两者不重叠
  {
    const r = await evalJS(`(() => {
      const bar = document.querySelector('#content .parsed-bar').getBoundingClientRect();
      const title = document.querySelector('#content .parsed-title').getBoundingClientRect();
      const box = document.getElementById('content').getBoundingClientRect();
      return {
        overlap: !(title.top >= bar.bottom - 1 || title.bottom <= bar.top + 1),
        titleInside: title.right <= box.right + 1,
        barHeight: Math.round(bar.height),
      };
    })()`);
    if (!r.overlap) ok('[A3] ★ 30 个字的标题没有压到工具条（各占一行）');
    else bad('[A3] ★ 标题和工具条重叠了');
    if (r.titleInside) ok('[A3] 标题没有溢出内容区');
    else bad('[A3] 标题溢出了内容区');
  }

  /* ============================================================
     B. 解析页搜索
     ============================================================ */
  say('\n=== B. 解析页搜索 ===');
  await click('#btnListSearch');
  await sleep(300);
  {
    const r = await evalJS(`({ has: !!document.getElementById('listSearchInput'), focus: document.activeElement && document.activeElement.id })`);
    if (r.has && r.focus === 'listSearchInput') ok('[B1] 点 🔍 → 输入框出现并聚焦');
    else bad(`[B1] 搜索框没展开/没聚焦：${JSON.stringify(r)}`);
  }
  await evalJS(`(() => {
    const el = document.getElementById('listSearchInput');
    el.focus(); el.value = '第 3 集';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(320);
  {
    const r = await evalJS(`({
      rows: document.querySelectorAll('#content .track').length,
      titles: [...document.querySelectorAll('#content .track .t')].map((e) => e.textContent),
      focus: document.activeElement && document.activeElement.id,
    })`);
    if (r.rows === 1 && /第 3 集/.test(r.titles[0])) ok(`[B1] ★ 搜「第 3 集」→ 1 行（${r.titles[0]}）`);
    else bad(`[B1] ★ 搜索结果不对：${JSON.stringify(r)}`);
    if (r.focus === 'listSearchInput') ok('[B1] ★ 输入后焦点仍在搜索框里');
    else bad(`[B1] ★ 输入后失焦了：${r.focus}`);
  }
  // 搜作者名
  await evalJS(`(() => {
    const el = document.getElementById('listSearchInput');
    el.focus(); el.value = '听雨GGMU';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(320);
  {
    const n = await evalJS(`document.querySelectorAll('#content .track').length`);
    if (n === 18) ok('[B2] 搜 UP 主名 → 18 集全中');
    else bad(`[B2] 搜作者名得到 ${n} 行，期望 18`);
  }
  await evalJS(`(() => { listSearch = ''; listSearchOpen = false; renderParsed(); return true; })()`);
  await sleep(300);

  /* ============================================================
     C. 整个合集加入
     ============================================================ */
  say('\n=== C. 整个合集加入歌单 ===');
  await evalJS(`DB.playlists = [{ id: 'p1', name: '测试歌单', tracks: [] }]; true`);
  await click('#btnAddParsed');
  await sleep(400);
  {
    const r = await evalJS(`({ open: document.getElementById('promptMask').classList.contains('show') })`);
    if (r.open) ok('[C1] 点「整个合集加入」→ 弹出歌单选择');
    else bad('[C1] 没弹歌单选择框');
  }
  await evalJS(`(() => { const r = document.querySelector('.pl-row[data-pl="p1"]'); if (r) r.click(); return true; })()`);
  await sleep(700);
  {
    const r = await evalJS(`(() => {
      const pl = DB.playlists.find((p) => p.id === 'p1');
      const t = pl.tracks[0] || {};
      return {
        len: pl.tracks.length,
        cid: t.cid === undefined ? 'undef' : t.cid,
        seasonCount: t.seasonCount,
        seasonTitle: t.seasonTitle,
        title: t.title,
        parts: t.parts,
        cached: (DB.collectParts['BVseason'] || []).length,
        hasCover: (DB.collectParts['BVseason'] || []).some((e) => 'cover' in e),
      };
    })()`);
    if (r.len === 1) ok('[C1] ★ 歌单里只有 **1 行**（不是摊开的 18 行）');
    else bad(`[C1] ★ 歌单里有 ${r.len} 行，期望 1`);
    if (r.cid === null) ok('[C2] ★ 入口行 cid 是 null（带 cid 会被当成"某合集里的一集"）');
    else bad(`[C2] ★ 入口行 cid 是 ${r.cid}，必须是 null`);
    if (r.seasonCount === 18 && r.seasonTitle === '温柔栗音') ok('[C2] ★ seasonCount = 18、seasonTitle = 温柔栗音');
    else bad(`[C2] ★ 合集字段不对：seasonCount=${r.seasonCount} seasonTitle=${r.seasonTitle}`);
    if (r.parts === undefined) ok('[C2] 没多填 parts（两个字段只能填一个）');
    else bad(`[C2] ★ 合集行还填了 parts=${r.parts} —— collectionSize 会判成「选集」`);
    if (/如果的事/.test(r.title)) ok('[C3] 标题用的是视频标题');
    else bad(`[C3] 标题不对：${r.title}`);
    if (r.cached === 18) ok('[C4] 曲目表写进了 collectParts（18 条，播放不用再联网）');
    else bad(`[C4] collectParts 里只有 ${r.cached} 条`);
    if (!r.hasCover) ok('[C4] 缓存剥掉了封面（不会把存档撑大）');
    else bad('[C4] ★ 缓存里带了 cover 长链接');
  }

  await evalJS(`(() => { selPick = null; renderPlaylist('p1'); return true; })()`);
  await sleep(300);
  {
    const r = await evalJS(`({
      sub: (document.querySelector('#content .block-sub') || {}).textContent,
      badge: (document.querySelector('#content .track .badge') || {}).textContent,
      rows: document.querySelectorAll('#content .track').length,
    })`);
    if (/共 18 首/.test(r.sub)) ok(`[C3] ★ 副标题「${r.sub}」（1 行也算 18 首）`);
    else bad(`[C3] ★ 副标题是「${r.sub}」，期望「共 18 首」`);
    if (/合集 18/.test(r.badge)) ok(`[C3] ★ 徽章显示「${r.badge}」`);
    else bad(`[C3] ★ 徽章是「${r.badge}」，期望「合集 18」`);
    if (r.rows === 1) ok('[C3] 歌单列表只有 1 行');
    else bad(`[C3] 歌单列表有 ${r.rows} 行`);
  }

  /* ---- C5 加进歌单要排在**最前面**（v2.11.1） ---- */
  {
    // 先放两首"旧歌"，再从解析页批量加 3 集进去
    // ★ 用 push，不能整体覆盖 —— 覆盖会把前面 C 组 / D 组建的 p1、p2 冲掉，F 组就找不到它们了
    await evalJS(`(() => {
      DB.playlists.push({ id: 'p3', name: '顺序测试', tracks: [
        { bvid: 'BVold1', cid: 11, title: '旧歌 1', author: 'X', duration: 100, cover: '' },
        { bvid: 'BVold2', cid: 12, title: '旧歌 2', author: 'X', duration: 100, cover: '' },
      ] });
      return true;
    })()`);
    await evalJS(`doParseLink('BVseason')`);
    await sleep(800);
    await click('#btnSelectParsed');
    await sleep(350);
    // ★ 勾一行会整块重画，旧节点会脱离文档 —— 每次都要重新查（项目红线）
    for (let i = 0; i < 3; i++) {
      await evalJS(`(() => { const r = document.querySelectorAll('#content .track.pickable')[${i}]; if (r) r.click(); return true; })()`);
      await sleep(180);
    }
    await click('#btnSelAddPl');
    await sleep(450);
    await evalJS(`(() => { const r = document.querySelector('.pl-row[data-pl="p3"]'); if (r) r.click(); return true; })()`);
    await sleep(700);
    const order = await evalJS(`(() => {
      const pl = DB.playlists.find((p) => p.id === 'p3');
      return pl.tracks.map((t) => t.title);
    })()`);
    if (order.length === 5 &&
        /第 1 集/.test(order[0]) && /第 2 集/.test(order[1]) && /第 3 集/.test(order[2]) &&
        order[3] === '旧歌 1' && order[4] === '旧歌 2')
      ok('[C5] ★ 新加的排在**最前面**，批量加的内部顺序也没反（第1/2/3集 → 旧歌1/旧歌2）');
    else bad(`[C5] ★ 加进歌单的顺序不对：${JSON.stringify(order)}`);
    // ★ 退出批量选择 —— 不然下一组点「批量选择」会变成"退出"（踩过）
    await evalJS(`selPick = null; true`);
    await sleep(200);
  }

  /* ============================================================
     D. 分 P 视频
     ============================================================ */
  say('\n=== D. 分 P 视频也当整体 ===');
  currentInfo = multiPInfo(12);
  // ★ 用 push 而不是整体覆盖 —— 覆盖会把 C 组建的 p1（18 集合集）一起冲掉，
  //   后面 F 组就找不到它了（踩过）。
  await evalJS(`DB.playlists.push({ id: 'p2', name: '分P歌单', tracks: [] }); true`);
  await evalJS(`doParseLink('BVmulti')`);
  await sleep(800);
  {
    const r = await evalJS(`({
      rows: document.querySelectorAll('#content .track').length,
      btn: (document.querySelector('#content #btnAddParsed') || {}).textContent,
    })`);
    if (r.rows === 12) ok('[D1] 分 P 视频摊平成 12 行');
    else bad(`[D1] 分 P 行数 ${r.rows}，期望 12`);
    if (/整个合集加入/.test(r.btn)) ok(`[D1] 按钮也是「${r.btn.trim()}」`);
    else bad(`[D1] 分 P 的按钮文案是「${r.btn}」`);
  }
  await click('#btnAddParsed');
  await sleep(400);
  await evalJS(`(() => { const r = document.querySelector('.pl-row[data-pl="p2"]'); if (r) r.click(); return true; })()`);
  await sleep(700);
  {
    const r = await evalJS(`(() => {
      const pl = DB.playlists.find((p) => p.id === 'p2');
      const t = pl.tracks[0] || {};
      return { len: pl.tracks.length, cid: t.cid === undefined ? 'undef' : t.cid, parts: t.parts, seasonCount: t.seasonCount };
    })()`);
    if (r.len === 1 && r.parts === 12 && r.cid === null) ok('[D1] ★ 分 P 也是 1 行、parts = 12、cid = null');
    else bad(`[D1] ★ 分 P 入口行不对：${JSON.stringify(r)}`);
    if (r.seasonCount === undefined) ok('[D1] 分 P 行没多填 seasonCount');
    else bad(`[D1] ★ 分 P 行还填了 seasonCount=${r.seasonCount}`);
  }

  /* ============================================================
     E. 解析页的批量选择
     ============================================================ */
  say('\n=== E. 解析页批量选择 ===');
  currentInfo = seasonInfo(18);          // ★ D 组把它换成分P 了，这里要换回来
  await evalJS(`selPick = null; true`);  // 兜一道：上一组可能留着选择态
  await evalJS(`doParseLink('BVseason')`);
  await sleep(800);
  await click('#btnSelectParsed');
  await sleep(400);
  {
    const r = await evalJS(`(() => {
      const bar = document.querySelector('#content .pick-bar');
      if (!bar) return { has: false };
      const skip = new Set(['btnSelPickAll', 'btnSelPickNone', 'btnSelPickExit']);
      const ids = [...bar.querySelectorAll('.imp-bar-actions .ghost-btn')].map((b) => b.id).filter((id) => !skip.has(id));
      return { has: true, ids, rows: document.querySelectorAll('#content .track.pickable').length };
    })()`);
    if (!r.has) bad('[E1] 解析页进不了批量选择（没有选择条）');
    else {
      if (r.rows === 18) ok('[E1] 18 行都能勾');
      else bad(`[E1] 可勾的行数 ${r.rows}，期望 18`);
      if (!r.ids.includes('btnSelRemove')) ok(`[E1] ★ 解析页没有「移出」按钮（动作：${r.ids.join(' / ')}）`);
      else bad('[E1] ★ 解析页居然有「移出」按钮');
      if (r.ids.includes('btnSelDownload') && r.ids.includes('btnSelAddPl') && r.ids.includes('btnSelFav'))
        ok('[E1] 下载 / 加入歌单 / 喜欢 都在');
      else bad(`[E1] 动作不全：${JSON.stringify(r.ids)}`);
    }
  }
  await click('#btnSelPickAll');
  await sleep(350);
  {
    const n = await evalJS(`selPick ? selPick.selected.size : -1`);
    if (n === 18) ok('[E2] ★ 全选 = 18 集（摊平后的每一集都能选）');
    else bad(`[E2] ★ 全选得到 ${n} 个，期望 18`);
  }
  await click('#btnSelPickExit');
  await sleep(350);

  /* ============================================================
     F. 下载前确认 + 摊平
     ============================================================ */
  say('\n=== F. 下载前确认 ===');
  await evalJS(`(() => { selPick = null; renderPlaylist('p1'); return true; })()`);
  await sleep(300);
  await click('#btnSelectPl');
  await sleep(300);
  await click('#btnSelPickAll');
  await sleep(300);

  await evalJS(`closePrompt(null); true`);   // 清掉前面可能残留的弹窗
  await sleep(200);
  const before = stubDl.calls.add.length;
  {
    const hasBtn = await evalJS(`!!document.getElementById('btnSelDownload')`);
    if (!hasBtn) bad('[F1] 选择条里没有「下载」按钮，这条测不了');
  }
  await click('#btnSelDownload');
  await sleep(600);
  {
    const r = await evalJS(`({
      open: document.getElementById('promptMask').classList.contains('show'),
      title: (document.getElementById('promptTitle') || {}).textContent,
      body: (document.getElementById('promptBody') || {}).textContent.trim(),
    })`);
    if (r.open) ok('[F1] ★ 选中合集行点下载 → 先弹确认');
    else bad('[F1] ★ 点下载没弹确认（会直接只下第一集）');
    if (/18 集/.test(r.body)) ok(`[F1] ★ 确认文案写明了集数：「${r.body.slice(0, 46)}…」`);
    else bad(`[F1] ★ 确认文案没写集数：「${r.body}」`);
  }

  // 先取消
  await evalJS(`(() => { const b = document.getElementById('promptCancel'); if (b) b.click(); return true; })()`);
  await sleep(500);
  {
    const after = stubDl.calls.add.length;
    if (after === before) ok('[F2] ★ 取消 → 一个任务都没发出去');
    else bad(`[F2] ★ 取消后还是发了 ${after - before} 批任务`);
  }

  // 再确认
  await click('#btnSelDownload');
  await sleep(500);
  await evalJS(`(() => { const b = document.getElementById('promptOk'); if (b) b.click(); return true; })()`);
  await sleep(1200);
  {
    const last = stubDl.calls.add[stubDl.calls.add.length - 1] || [];
    if (stubDl.calls.add.length > before && last.length === 18)
      ok('[F3] ★ 确认 → 交给主进程的是 **18 首**（摊平了，不是 1 首）');
    else bad(`[F3] ★ 交给主进程的是 ${last.length} 首（期望 18），批次 ${stubDl.calls.add.length - before}`);
    const allHaveCid = last.every((t) => t.cid);
    if (allHaveCid) ok('[F3] 18 首都带 cid（下载不会因为缺 cid 失败）');
    else bad('[F3] ★ 有曲目缺 cid');
  }

  /* ============================================================
     Z. 收尾
     ============================================================ */
  say('');
  if (!errors.length) ok('[Z] 全程没有页面报错');
  else {
    bad(`[Z] 页面报了 ${errors.length} 条错：`);
    errors.slice(0, 8).forEach((e) => say('        ' + e));
  }

  say(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 条没通过 ❌`);
  finish(fail === 0 ? 0 : 1);
});
