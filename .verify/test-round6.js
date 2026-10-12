/* 第六轮需求的实测（离屏渲染 + 合成真实鼠标事件 + 真跑应用代码，不是文本断言）：
     · 详情页返回：点 ⓘ → 进详情 → 点「← 返回」→ 回到原来那一页（含滚动位置）
     · 队列来源：从哪个界面点的播放，队列里就写哪个界面的名字
     · 队列快照：播放后删掉源列表里的歌，正在播的队列不受影响
     · 合集摊平：合集行进队列时摊成它的一集一集（顺序播放会一集接一集走）
     · 合集单集开关：禁用 3 集 → 队列少 3 首、徽章变 选集 131/134；一键全开/全关
     · 播放模式：一个按钮循环切换四种；顺序播放走到最后一首会停；随机不连播同一首
     · 播放键仍然居中（4 个按钮 + 等宽占位）
     · 重启后：单集开关与播放模式还在（真重载页面，不是看变量）
   ★ 沙箱没有音频设备：把 audio.play 换成直接成功，避免"播不出来就自动跳下一首"的兜底干扰。
     应用里真能出声时不会触发那条兜底。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round6-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const UP_MID = 4466001;
const COLLECT_BVID = 'BV1ybj66YEpv';
const TOTAL = 134;                       // 合集一共 134 集（跟用户截图里那条 369:22 的长合集一个量级）
const PAGES = Array.from({ length: TOTAL }, (_, i) => ({
  bvid: COLLECT_BVID, cid: 39240000000 + i, page: i + 1,
  title: '第' + (i + 1) + '首甜歌', duration: 200 + i,
}));

const NORMAL = { bvid: 'BV1song0001', cid: null, page: 1, title: '大鱼', author: '周深', mid: UP_MID, cover: '', duration: 312 };
const NORMAL2 = { bvid: 'BV1song0002', cid: null, page: 1, title: '起风了', author: '买辣椒也用券', mid: 999, cover: '', duration: 325 };
const COLLECT_ROW = { bvid: COLLECT_BVID, cid: null, page: 1, title: '超甜合集100首甜歌', author: '皓晨音乐', mid: UP_MID, cover: '', duration: 13632 };

/* 记下每次落盘的内容：验证"真的存了"，重启时也把最后一次存档喂回去 */
let lastSaved = null;
let infoCalls = 0;

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:parse', (_e, text) => ({ ok: true, data: { bvid: String(text).includes('BV') ? String(text).trim() : NORMAL.bvid } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => {
  infoCalls++;
  if (bvid === COLLECT_BVID) {
    return { ok: true, data: { bvid: COLLECT_BVID, aid: 1, title: COLLECT_ROW.title, cover: '', owner: { mid: UP_MID, name: '皓晨音乐' }, duration: 13632, pages: PAGES, season: null } };
  }
  return { ok: true, data: { bvid, aid: 2, title: '普通歌', cover: '', owner: { mid: UP_MID, name: '测试UP' }, duration: 312, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 312 }], season: null } };
});
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1100);
    // 关掉"播不出来就跳下一首"的兜底：沙箱没有声卡，audio.play() 必然失败（环境产物，不是缺陷）。
    // 顺手把 src 的写入也掐掉：空地址会让 audio 抛 error 事件，弹一句"链接已过期"，
    // 把该测的那句 toast 顶掉 —— 那是测试环境的噪声。
    await win.webContents.executeJavaScript(`(() => {
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      return true;
    })()`);
    await sleep(120);
  };
  await boot();

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(340);
  };
  const centerOf = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);
  const clickSel = async (sel) => { const p = await centerOf(sel); if (!p) { bad('找不到元素 ' + sel); return false; } await clickAt(p.x, p.y); return true; };

  const seed = () => evalJS(`(() => {
    DB.playlists = [{ id: 'pl-a', name: '跑步歌单', tracks: [] }];
    DB.favorites = [${JSON.stringify(COLLECT_ROW)}, ${JSON.stringify(NORMAL)}];
    DB.collectOff = {};
    DB.collectParts = {};
    searchKeyword = '测试';
    searchResults = [${JSON.stringify(NORMAL)}, ${JSON.stringify(NORMAL2)}];
    currentView = 'search';
    renderSearch();
    renderPlaylistSidebar();
    return true;
  })()`);

  /* ================= 1) 详情页返回 ================= */
  say('\n[1] 详情页返回：');
  await seed();
  await evalJS(`(() => { document.getElementById('content').scrollTop = 120; return true; })()`);
  const beforeDetail = await evalJS(`({ view: currentView, scroll: document.getElementById('content').scrollTop })`);
  if (!await clickSel('#content .track[data-i="1"] .op-ic[data-act="detail"]')) {
    say('  （搜索结果行没有详情按钮，测试无法继续）');
  }
  await sleep(900);
  const inDetail = await evalJS(`({
    view: currentView,
    hasBack: !!document.getElementById('btnParsedBack'),
    backText: document.getElementById('btnParsedBack') ? document.getElementById('btnParsedBack').textContent : '',
    rows: document.querySelectorAll('#content .track').length,
  })`);
  say('  点 ⓘ 后：view=' + inDetail.view + '，返回按钮=「' + inDetail.backText + '」，列表 ' + inDetail.rows + ' 行');
  if (inDetail.view === 'parsed' && inDetail.hasBack) ok('详情页有「返回」按钮（以前是进去就出不来）');
  else bad('详情页没有返回按钮：' + JSON.stringify(inDetail));
  if (/搜索/.test(inDetail.backText)) ok('返回按钮上写着来路（' + inDetail.backText + '）');
  else bad('返回按钮没写来路：' + inDetail.backText);

  await clickSel('#btnParsedBack');
  await sleep(500);
  const backHome = await evalJS(`({
    view: currentView,
    scroll: document.getElementById('content').scrollTop,
    rows: document.querySelectorAll('#content .track').length,
    title: document.querySelector('#content .block-title') ? document.querySelector('#content .block-title').textContent : '',
  })`);
  say('  点返回后：view=' + backHome.view + '，滚动=' + backHome.scroll + '，列表 ' + backHome.rows + ' 行');
  if (backHome.view === 'search' && backHome.rows === 2) ok('返回后回到原来的搜索结果页（列表还原）');
  else bad('返回没有回到原页面：' + JSON.stringify(backHome));
  if (backHome.scroll === beforeDetail.scroll) ok('返回后滚动位置也还原了（' + backHome.scroll + '）');
  else bad(`滚动位置没还原：去之前 ${beforeDetail.scroll}，回来 ${backHome.scroll}`);

  /* ================= 2) 队列来源 = 点播放的那个界面 ================= */
  say('\n[2] 队列来源跟着播放界面走：');
  const srcA = await evalJS(`(async () => { currentView = 'favorites'; renderFavorites(); await new Promise(r => setTimeout(r, 60)); return true; })()`);
  await sleep(400);
  await clickSel('#content .track[data-i="1"]');     // 在「我喜欢」里点一首普通歌
  await sleep(600);
  const qFav = await evalJS(`({ name: queue.name, len: queue.tracks.length, sub: document.getElementById('queueSub').textContent })`);
  say('  从「我喜欢」点播放 → 队列来源「' + qFav.name + '」，' + qFav.len + ' 首');
  if (qFav.name === '我喜欢') ok('从「我喜欢」点播放，队列来源就是「我喜欢」');
  else bad('队列来源不对：' + JSON.stringify(qFav));

  await evalJS(`(() => { currentView = 'search'; renderSearch(); return true; })()`);
  await sleep(300);
  await clickSel('#content .track[data-i="0"]');
  await sleep(600);
  const qSearch = await evalJS(`({ name: queue.name, len: queue.tracks.length })`);
  say('  从搜索结果点播放 → 队列来源「' + qSearch.name + '」');
  if (qSearch.name === '搜索：测试') ok('换到搜索结果点播放，队列来源跟着变成「搜索：测试」（不再是上一次的名字）');
  else bad('队列来源没有跟着界面变：' + JSON.stringify(qSearch));

  const subShown = await evalJS(`(() => { openQueue(); return document.getElementById('queueSub').textContent; })()`);
  await sleep(300);
  say('  队列抽屉副标题：' + subShown);
  if (/来自「搜索：测试」/.test(subShown)) ok('队列抽屉里显示"来自「搜索：测试」"');
  else bad('队列抽屉没显示来源：' + subShown);
  await evalJS(`(() => { closeQueue(); return true; })()`);

  /* ================= 3) 队列是快照，不是源数组的引用 ================= */
  say('\n[3] 队列快照：');
  await evalJS(`(async () => { currentView = 'favorites'; renderFavorites(); return true; })()`);
  await sleep(300);
  await clickSel('#content .track[data-i="1"]');
  await sleep(500);
  const snapBefore = await evalJS(`({ qlen: queue.tracks.length, favs: DB.favorites.length })`);
  await evalJS(`(async () => { DB.favorites.pop(); await persist(); return true; })()`);
  await sleep(500);
  const snapAfter = await evalJS(`({ qlen: queue.tracks.length, favs: DB.favorites.length })`);
  say(`  删掉一首收藏：收藏 ${snapBefore.favs} → ${snapAfter.favs}，队列 ${snapBefore.qlen} → ${snapAfter.qlen}`);
  if (snapAfter.favs === snapBefore.favs - 1 && snapAfter.qlen === snapBefore.qlen) ok('源列表少了一首，正在播的队列纹丝不动（存的是副本）');
  else bad('队列被源列表带着改了：' + JSON.stringify({ snapBefore, snapAfter }));

  /* ================= 4) 合集摊平进队列（顺序播放一集接一集） ================= */
  say('\n[4] 合集摊平进播放序列：');
  await evalJS(`(() => { DB.favorites = [${JSON.stringify(COLLECT_ROW)}, ${JSON.stringify(NORMAL)}]; return true; })()`);
  await evalJS(`(() => { currentView = 'favorites'; renderFavorites(); return true; })()`);
  await sleep(400);
  const badge = await evalJS(`(() => { const b = document.querySelector('#content .track[data-i="0"] .badge'); return b ? b.textContent : null; })()`);
  say('  合集行徽章：' + badge);
  if (/选集/.test(String(badge))) ok('合集行有「选集」入口');
  else bad('合集行没有徽章：' + badge);

  await clickSel('#content .track[data-i="0"]');
  await sleep(1200);
  const flat = await evalJS(`({
    len: queue.tracks.length,
    first: queue.tracks[0] && queue.tracks[0].title,
    idx: queue.index,
    name: queue.name,
    playing: !!document.querySelector('#content .track[data-i="0"].playing'),
    nonCollectRow: !!document.querySelector('#content .track[data-i="1"].playing'),
  })`);
  say(`  点合集行后：队列 ${flat.len} 首，从「${flat.first}」开始，来源「${flat.name}」，合集行高亮=${flat.playing}`);
  if (flat.len === TOTAL + 1) ok(`队列把合集摊成了 ${TOTAL} 集 + 1 首普通歌（以前这里只有 2 行）`);
  else bad(`队列长度不对：${flat.len}（期望 ${TOTAL + 1}）`);
  if (flat.first === '第1首甜歌') ok('从合集第 1 集开始播');
  else bad('起点不对：' + flat.first);
  if (flat.playing && !flat.nonCollectRow) ok('外面那一整行保持"正在播放"高亮，别的行没有误亮');
  else bad('高亮不对：' + JSON.stringify(flat));

  await evalJS(`(() => { next(1); return true; })()`);
  await sleep(600);
  const step2 = await evalJS(`({ idx: queue.index, title: queue.tracks[queue.index].title })`);
  say('  按下一首 → 第 ' + (step2.idx + 1) + ' 首「' + step2.title + '」');
  if (step2.idx === 1 && step2.title === '第2首甜歌') ok('合集里能一集接一集往下走（不再只播第 1 首就跳过）');
  else bad('没有走到合集第 2 集：' + JSON.stringify(step2));

  const wrap = await evalJS(`(() => { queue.index = ${TOTAL} - 1; next(1); return { idx: queue.index, title: queue.tracks[queue.index].title }; })()`);
  await sleep(400);
  say('  播到合集最后一集再按下一首 → 「' + wrap.title + '」（队列第 ' + (wrap.idx + 1) + ' 首）');
  if (wrap.idx === TOTAL && wrap.title === '大鱼') ok('合集最后一集播完，接着走列表里的下一行（顺序衔接上了）');
  else bad('合集结束后没有接上下一行：' + JSON.stringify(wrap));

  /* ================= 5) 单集启用 / 禁用 + 一键开关 ================= */
  say('\n[5] 合集里单集启用 / 禁用：');
  await clickSel('#content .track[data-i="0"] .badge');
  await sleep(1000);
  const panel = await evalJS(`({
    open: document.getElementById('collectMask').classList.contains('show'),
    rows: document.querySelectorAll('#collectList .collect-row').length,
    toggles: document.querySelectorAll('#collectList [data-cact="toggle"]').length,
    sub: document.getElementById('collectSub').textContent,
    allBtn: document.getElementById('btnCollectToggleAll').textContent,
    playBtn: document.getElementById('btnPlayCollect').textContent,
  })`);
  say(`  面板打开=${panel.open}，${panel.rows} 行，${panel.toggles} 个开关，「${panel.sub}」`);
  say(`  顶部按钮：「${panel.allBtn}」「${panel.playBtn}」`);
  if (panel.open && panel.rows === TOTAL && panel.toggles === TOTAL) ok('每一集都有一个启用/禁用开关');
  else bad('开关数量不对：' + JSON.stringify(panel));
  if (/已启用 134\/134 集/.test(panel.sub) && panel.allBtn === '全部禁用') ok('副标题与一键按钮状态正确（默认全部启用）');
  else bad('默认状态显示不对：' + JSON.stringify(panel));

  // 禁用第 2/3/4 集（下标 1/2/3）
  for (const i of [1, 2, 3]) await clickSel(`#collectList .collect-row[data-ci="${i}"] [data-cact="toggle"]`);
  await sleep(500);
  const afterOff = await evalJS(`({
    off: (DB.collectOff['${COLLECT_BVID}'] || []).length,
    sub: document.getElementById('collectSub').textContent,
    allBtn: document.getElementById('btnCollectToggleAll').textContent,
    playBtn: document.getElementById('btnPlayCollect').textContent,
    offRows: document.querySelectorAll('#collectList .collect-row.off').length,
  })`);
  const offSaved = lastSaved && lastSaved.collectOff && (lastSaved.collectOff[COLLECT_BVID] || []).length;
  say(`  禁用 3 集后：禁用表 ${afterOff.off} 条，暗淡行 ${afterOff.offRows}，「${afterOff.sub}」，按钮「${afterOff.allBtn}」「${afterOff.playBtn}」`);
  if (afterOff.off === 3 && afterOff.offRows === 3 && /已启用 131\/134 集/.test(afterOff.sub))
    ok('禁用 3 集：开关状态、暗淡行、副标题计数三方一致');
  else bad('禁用状态没对齐：' + JSON.stringify(afterOff));
  if (offSaved === 3) ok('禁用状态已落盘（重启后还在）');
  else bad('禁用状态没落盘：saved=' + offSaved);

  const bar = await evalJS(`document.getElementById('collectSub').textContent`);
  say('  面板副标题：' + bar);
  await evalJS(`(() => { closeCollectPanel(); return true; })()`);
  await sleep(400);
  const badge2 = await evalJS(`(() => { const b = document.querySelector('#content .track[data-i="0"] .badge'); return b ? b.textContent : null; })()`);
  say('  关掉面板后，行上徽章：' + badge2);
  if (/选集 131\/134/.test(String(badge2))) ok('行上徽章同步显示「选集 131/134」（一眼看出筛过）');
  else bad('徽章没有同步启用数：' + badge2);

  await clickSel('#content .track[data-i="0"]');
  await sleep(1300);
  const playedOff = await evalJS(`(() => {
    const cids = queue.tracks.map((t) => String(t.cid));
    const banned = [${PAGES[1].cid}, ${PAGES[2].cid}, ${PAGES[3].cid}].map(String);
    return { len: queue.tracks.length, hit: banned.filter((c) => cids.includes(c)).length };
  })()`);
  say(`  禁用后播放：队列 ${playedOff.len} 首，被禁的 3 集出现在队列里的次数=${playedOff.hit}`);
  if (playedOff.len === TOTAL - 3 + 1 && playedOff.hit === 0) ok('被禁用的那 3 集不进队列、不会被播到');
  else bad('禁用没有生效：' + JSON.stringify(playedOff));

  /* 一键开关：先确认"按键含义跟着当前状态走"，再走一个完整来回。
     ★ 起始状态是"禁了 3 集"（部分启用），所以第一次点击的含义是"全部启用" ——
       按钮上写的就是它接下来会做什么，测试也按这个语义断言。 */
  await clickSel('#content .track[data-i="0"] .badge');
  await sleep(900);
  const readAll = () => evalJS(`({
    off: (DB.collectOff['${COLLECT_BVID}'] || []).length,
    sub: document.getElementById('collectSub').textContent,
    allBtn: document.getElementById('btnCollectToggleAll').textContent,
    icon: document.querySelector('#collectList [data-cact="toggle"] use').getAttribute('href'),
  })`);

  const half = await readAll();
  say(`  重新打开面板（前面禁了 3 集）：禁用表 ${half.off} 条，按钮写「${half.allBtn}」`);
  if (half.off === 3 && half.allBtn === '全部启用') ok('部分禁用时，一键按钮写的是「全部启用」（按钮文字=接下来会发生什么）');
  else bad('部分禁用时的按钮文案不对：' + JSON.stringify(half));

  await clickSel('#btnCollectToggleAll');
  await sleep(700);
  const allOn = await readAll();
  say(`  点一下 → 禁用表 ${allOn.off} 条，「${allOn.sub}」，按钮变「${allOn.allBtn}」，行内图标 ${allOn.icon}`);
  if (allOn.off === 0 && /已启用 134\/134 集/.test(allOn.sub) && allOn.allBtn === '全部禁用' && allOn.icon === '#i-check')
    ok('一键「全部启用」生效（全开=不留记录，存档干净），图标变回对勾');
  else bad('一键全部启用不对：' + JSON.stringify(allOn));

  await clickSel('#btnCollectToggleAll');
  await sleep(700);
  const allOff = await readAll();
  say(`  再点一下 → 禁用表 ${allOff.off} 条，「${allOff.sub}」，按钮变「${allOff.allBtn}」，行内图标 ${allOff.icon}`);
  if (allOff.off === TOTAL && /已启用 0\/134 集/.test(allOff.sub) && allOff.allBtn === '全部启用' && allOff.icon === '#i-off')
    ok('一键「全部禁用」生效，134 集全部关掉，按钮自动变成「全部启用」');
  else bad('一键全部禁用不对：' + JSON.stringify(allOff));

  // 全部禁用时点播放：要给出明确提示，不静默
  const qLenBefore = await evalJS(`queue.tracks.length`);
  await clickSel('#btnPlayCollect');
  await sleep(400);
  const allOffPlay = await evalJS(`({ qlen: queue.tracks.length, toast: document.getElementById('toast').textContent })`);
  say(`  全禁用后点「播放全部」：队列还是 ${allOffPlay.qlen} 首，提示「${allOffPlay.toast}」`);
  if (allOffPlay.qlen === qLenBefore && /都被禁用/.test(allOffPlay.toast)) ok('全禁用时给明确提示，不会静默什么也不发生');
  else bad('全禁用时的提示不对：' + JSON.stringify(allOffPlay));

  await clickSel('#btnCollectToggleAll');   // 还原成全部启用
  await sleep(500);
  // 截图：面板里同时有"启用"和"禁用"两种行，能看清开关与暗淡效果
  await evalJS(`(async () => { currentView = 'favorites'; renderFavorites(); buildSequence(DB.favorites); return true; })()`);
  await sleep(700);
  await clickSel('#content .track[data-i="0"] .badge');
  await sleep(800);
  for (const i of [1, 2, 3, 20, 21]) await clickSel(`#collectList .collect-row[data-ci="${i}"] [data-cact="toggle"]`);
  await sleep(500);
  const imgCollect = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-collect-toggle.png'), imgCollect.toPNG());
  await clickSel('#btnCollectToggleAll');   // 一键全开（把那 5 集放回来）
  await sleep(400);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(300);

  /* ================= 6) 播放模式：一个按钮四种模式 ================= */
  say('\n[6] 播放模式合并成一个按钮：');
  const btnCount = await evalJS(`document.querySelectorAll('.ctrl-row .ctrl-btn').length`);
  say('  控制行里的按钮数：' + btnCount);
  if (btnCount === 4) ok('控制行只剩 4 个按钮（随机/循环已合并）');
  else bad('控制行按钮数不对：' + btnCount);

  const seq = [];
  for (let i = 0; i < 5; i++) {
    await clickSel('#btnMode');
    await sleep(220);
    seq.push(await evalJS(`({
      mode: playMode,
      icon: document.querySelector('#btnMode use').getAttribute('href'),
      title: document.getElementById('btnMode').title,
      on: document.getElementById('btnMode').classList.contains('on'),
      toast: document.getElementById('toast').textContent,
    })`));
  }
  seq.forEach((s) => say(`    ${s.mode.padEnd(8)} icon=${s.icon.padEnd(11)} 高亮=${s.on} 提示「${s.title}」toast「${s.toast}」`));
  const wantOrder = ['one', 'shuffle', 'order', 'list', 'one'];
  const wantIcon = ['#i-repeat1', '#i-shuffle', '#i-order', '#i-repeat', '#i-repeat1'];
  if (seq.map((s) => s.mode).join() === wantOrder.join()) ok('连点 5 次：列表循环 → 单曲循环 → 随机 → 顺序 → 列表循环');
  else bad('模式切换顺序不对：' + seq.map((s) => s.mode).join());
  if (seq.map((s) => s.icon).join() === wantIcon.join() && seq.every((s) => /播放模式：/.test(s.title)))
    ok('每次切换图标与提示同步变化');
  else bad('图标/提示没同步：' + JSON.stringify(seq.map((s) => [s.icon, s.title])));
  if (seq[2].on === false && seq[3].on === true) ok('顺序播放不强亮、其它三种点亮（一眼看出开着什么）');
  else bad('高亮状态不对：' + JSON.stringify(seq.map((s) => s.on)));
  await sleep(700);   // 等 persistLater 落盘
  const modeSaved = lastSaved && lastSaved.settings && lastSaved.settings.playMode;
  if (modeSaved) ok('播放模式已写进存档：' + modeSaved);
  else bad('播放模式没有落盘');

  /* ================= 7) 顺序播放走到最后一首会停 ================= */
  say('\n[7] 顺序播放会停 / 随机不连播同一首：');
  const stop = await evalJS(`(() => {
    setPlayMode('order', false);
    playTracks([${JSON.stringify(NORMAL)}, ${JSON.stringify(NORMAL2)}], 1, '测试');
    toast('');
    next(1);
    return { idx: queue.index, len: queue.tracks.length, toast: document.getElementById('toast').textContent };
  })()`);
  await sleep(300);
  say('  顺序播放最后一首按下一首 → 仍是第 ' + (stop.idx + 1) + ' 首，提示「' + stop.toast + '」');
  if (stop.idx === stop.len - 1 && /最后一首/.test(stop.toast)) ok('顺序播放走到最后一首就停（不绕回第一首）');
  else bad('顺序播放没有停：' + JSON.stringify(stop));

  const shuff = await evalJS(`(() => {
    setPlayMode('shuffle', false);
    playTracks([${JSON.stringify(NORMAL)}, ${JSON.stringify(NORMAL2)}, ${JSON.stringify(COLLECT_ROW)},
      { bvid: 'BV1x3', cid: 3, page: 1, title: '第三', duration: 100 },
      { bvid: 'BV1x4', cid: 4, page: 1, title: '第四', duration: 100 }], 0, '测试');
    let same = 0, out = 0, prev = queue.index;
    for (let i = 0; i < 20; i++) { next(1); if (queue.index === prev) same++; if (queue.index < 0 || queue.index > 4) out++; prev = queue.index; }
    return { same, out, mode: playMode };
  })()`);
  say(`  随机模式连按 20 次下一首：连着两次同一首 ${shuff.same} 次，越界 ${shuff.out} 次`);
  if (shuff.same === 0 && shuff.out === 0) ok('随机模式每次都在队列内，且不会连着两次同一首');
  else bad('随机播放有问题：' + JSON.stringify(shuff));

  /* ================= 8) 播放键居中（4 按钮 + 等宽占位） ================= */
  say('\n[8] 播放键仍然居中：');
  const geo = await evalJS(`(() => {
    const c = document.querySelector('.controls').getBoundingClientRect();
    const p = document.getElementById('btnPlay').getBoundingClientRect();
    const m = document.getElementById('btnMode').getBoundingClientRect();
    const n = document.getElementById('btnNext').getBoundingClientRect();
    return {
      controls: c.x + c.width / 2, play: p.x + p.width / 2,
      mode: m.x + m.width / 2, next: n.x + n.width / 2,
    };
  })()`);
  const off = Math.abs(geo.play - geo.controls);
  say(`  播放键中心 ${geo.play.toFixed(1)} vs 控制区中心 ${geo.controls.toFixed(1)} → 偏差 ${off.toFixed(1)}px`);
  say(`  （模式按钮中心 ${geo.mode.toFixed(1)} 在播放键左边：${geo.mode < geo.play}）`);
  if (off <= 1) ok('播放键与控制区中线偏差 ≤ 1px（没有因为少了一个按钮而偏掉）');
  else bad(`播放键偏了 ${off.toFixed(1)}px（等宽占位没生效？）`);
  if (geo.mode < geo.play && geo.next > geo.play) ok('模式按钮在左、下一首在右，排布正常');
  else bad('控制按钮排布异常：' + JSON.stringify(geo));

  const imgBar = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-mode.png'), imgBar.toPNG());

  /* ================= 9) 重启后：开关与模式还在 ================= */
  say('\n[9] 重启后状态还在：');
  await evalJS(`(async () => {
    DB.collectOff = { '${COLLECT_BVID}': ['${COLLECT_BVID}#${PAGES[0].cid}', '${COLLECT_BVID}#${PAGES[1].cid}'] };
    setPlayMode('order', true);
    await persist();
    return true;
  })()`);
  await sleep(700);
  await boot();   // 真·重载页面（重新走一遍 boot()，从存档里读）
  const reboot = await evalJS(`({
    off: (DB.collectOff['${COLLECT_BVID}'] || []).length,
    parts: (DB.collectParts['${COLLECT_BVID}'] || []).length,
    mode: playMode,
    modeIcon: document.querySelector('#btnMode use').getAttribute('href'),
    badge: (() => { currentView='favorites'; DB.favorites=[${JSON.stringify(COLLECT_ROW)}]; renderFavorites();
      const b = document.querySelector('#content .track[data-i="0"] .badge'); return b ? b.textContent : ''; })(),
  })`);
  say(`  重启后：禁用表 ${reboot.off} 条，缓存的曲目表 ${reboot.parts} 集，模式=${reboot.mode}(${reboot.modeIcon})，徽章「${reboot.badge}」`);
  if (reboot.off === 2 && reboot.mode === 'order' && reboot.modeIcon === '#i-order') ok('重启后单集开关与播放模式都还在');
  else bad('重启后状态丢了：' + JSON.stringify(reboot));
  if (reboot.parts === TOTAL) ok(`重启后曲目表缓存还在（${TOTAL} 集），不用再等网络`);
  else bad('曲目表缓存没存下来：' + reboot.parts);
  if (/选集 132\/134/.test(reboot.badge)) ok('重启后徽章直接显示「选集 132/134」');
  else bad('重启后徽章不对：' + reboot.badge);

  /* 截图：详情页（含返回按钮） */
  await evalJS(`(async () => {
    DB.favorites = [${JSON.stringify(COLLECT_ROW)}]; currentView = 'favorites'; renderFavorites();
    parsedOrigin = { view: currentView, label: viewLabel(), scroll: 0 };
    currentView = 'parsed';
    await doParseLink('${COLLECT_BVID}');
    return true;
  })()`);
  await sleep(1200);
  const imgDetail = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-detail.png'), imgDetail.toPNG());
  say('\n已保存 shot-detail.png / shot-collect-toggle.png / shot-mode.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n第六轮实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
