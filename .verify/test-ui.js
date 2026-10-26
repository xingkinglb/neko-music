/* 本轮新交互的实测（离屏渲染 + 合成真实鼠标事件）：
     · 行内按钮是不是图标（♡ / ＋），有没有悬停提示
     · 点 ＋ 会不会弹出歌单列表；选中一个歌单能不能真的加进去并落盘
     · 在弹窗里「新建歌单…」能不能建出来、建完直接加入
     · 侧栏「＋ 新建歌单」是不是真的会弹（以前用的 prompt 在 Electron 里不弹，点了没反应）
     · 播放队列抽屉：能不能打开、列出行、点行跳播、移除一首
     · 合集面板每一集 hover 出的收藏按钮：点了只收藏，不能顺手把这一集播了
     · 点作者名能不能打开 UP 主页（并按 mid 拉到他的视频）
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-ui-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const UP_MID = 4466001;
const UP_BVID = 'BV1upvideo1';

/* 记录每次落盘的内容，用来验证"真的存了" */
const savedPayloads = [];

/* 两条搜索结果的形状与 bilibili.js 的 searchVideos 输出一致（现在带 mid） */
const SEARCH = [
  { bvid: 'BV1song0001', cid: null, page: 1, title: '大鱼', author: '周深', mid: UP_MID, cover: '', duration: 312 },
  { bvid: 'BV1song0002', cid: null, page: 1, title: '起风了', author: '买辣椒也用券', mid: 999, cover: '', duration: 325 },
];
const COLLECT_BVID = 'BV1ybj66YEpv';
const PAGES = Array.from({ length: 6 }, (_, i) => ({
  bvid: COLLECT_BVID, cid: 39240000000 + i, page: i + 1,
  title: '第' + (i + 1) + '首测试歌', duration: 200 + i,
}));

const addData = (d) => savedPayloads.push(JSON.parse(JSON.stringify(d)));

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { addData(data); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
/* ★ v2.8.0 修订二：audioUrl 必须回一条**真的 bili:// 地址**（带 deadline），
   否则 audio.src 设成空串 → 浏览器把它解析成页面自身的 file:// URL，
   "断流自愈换了地址没有"就永远测不出来（第一次跑就是这么假失败的）。
   每次调用换一个 tag，好断言"确实换了新地址"。 */
const realDl = Math.floor(Date.now() / 1000) + 3600;
let audioUrlSeq = 0;
ipcMain.handle('bili:audioUrl', () => {
  audioUrlSeq++;
  return { ok: true, data: {
    url: 'bili://get?url=' + encodeURIComponent(
      'https://x.mcdn.bilivideo.cn:4483/a.m4s?deadline=' + realDl + '&gen=playurlv3&sk=call' + audioUrlSeq),
    quality: 30280, duration: 200, backup: [] } };
});
ipcMain.handle('bili:videoInfo', (_e, bvid) => {
  if (bvid === COLLECT_BVID) {
    return { ok: true, data: { bvid: COLLECT_BVID, aid: 1, title: '六合集', cover: '', owner: { mid: UP_MID, name: '皓晨音乐' }, duration: 1200, pages: PAGES, season: null } };
  }
  return { ok: true, data: { bvid, aid: 2, title: '普通歌', cover: '', owner: { mid: UP_MID, name: '测试UP' }, duration: 220, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 220 }], season: null } };
});
/* UP 主页用的接口 */
let upCalls = 0;
ipcMain.handle('bili:upVideos', (_e, mid, pn) => {
  upCalls++;
  return {
    ok: true,
    data: {
      list: [
        { bvid: UP_BVID, cid: null, page: 1, title: '这个UP的第一首', author: '皓晨音乐', mid, cover: '', duration: '3:45', play: 1000 },
        { bvid: 'BV1upvideo2', cid: null, page: 1, title: '这个UP的第二首', author: '皓晨音乐', mid, cover: '', duration: '4:20', play: 2000 },
      ],
      total: 2,        // ★ v2.5.0：真实后端现在会带 total / pageSize（这里只有 2 条 → 1 页，不出分页条）
      pageSize: 30,
      hasMore: false,
    },
  };
});

/* ★ v2.8.0：下载 / 本地歌曲那两组 IPC 的桩。
   渲染层启动时就会拉一次任务表（rebuildDlKeys + refreshDownloads），
   不打桩的话控制台会挂一条 "No handler registered for 'download:list'" ——
   那是**桩缺了**，不是产品出错。桩上之后，"页面里的报错"那一栏才重新有意义，
   顺便也让下载管理页有数据可画（一条已完成 + 一条下载中）。 */
const DL_TASKS = [
  { id: 'dl_test1', key: 'BV1song0001:7', bvid: 'BV1song0001', cid: 7, page: 1,
    title: '大鱼', author: '周深', cover: '', duration: 312,
    status: 'done', received: 4211000, total: 4211000, speed: 0,
    file: '周深 - 大鱼.m4a', coverFile: '', error: '', createdAt: 1, finishedAt: 2 },
  { id: 'dl_test2', key: 'BV1song0002:7', bvid: 'BV1song0002', cid: 7, page: 1,
    title: '起风了', author: '买辣椒也用券', cover: '', duration: 325,
    status: 'downloading', received: 1000000, total: 4000000, speed: 524288,
    file: '', coverFile: '', error: '', createdAt: 3, finishedAt: 0 },
];
require('./stub-download-ipc.js')({ tasks: DL_TASKS, dir: 'C:\\测试\\下载' });
const dlStub = require('./stub-download-ipc.js');

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

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);

  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(320);
  };
  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const centerOf = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);

  /* ---------- 铺数据：两条搜索结果 + 两个歌单 ---------- */
  await evalJS(`(() => {
    DB.playlists = [
      { id: 'pl-a', name: '我的歌单', tracks: [] },
      { id: 'pl-b', name: '深夜爵士', tracks: [] },
    ];
    searchKeyword = '测试';
    searchResults = ${JSON.stringify(SEARCH)};
    currentView = 'search';
    renderSearch();
    renderPlaylistSidebar();
    return true;
  })()`);

  /* ---------- 1) 行内按钮是图标 + 有悬停提示 ---------- */
  const icons = await evalJS(`(() => {
    const row = document.querySelector('#content .track');
    const btns = [...row.querySelectorAll('.ops .op-ic')];
    return btns.map((b) => ({
      act: b.dataset.act,
      tip: b.dataset.tip || '',
      href: (b.querySelector('use') || {}).getAttribute ? b.querySelector('use').getAttribute('href') : '',
    }));
  })()`);
  say('\n--- 行内按钮 ---');
  icons.forEach((b) => say(`  act=${b.act} icon=${b.href} tip=${b.tip}`));
  const fav = icons.find((b) => b.act === 'fav');
  const add = icons.find((b) => b.act === 'add');
  if (fav && fav.href === '#i-heart' && fav.tip) ok('收藏是 ♡ 图标，且带悬停提示');
  else bad('收藏没有用 ♡ 图标 / 没有提示：' + JSON.stringify(fav));
  if (add && add.href === '#i-plus' && add.tip) ok('加歌单是 ＋ 图标，且带悬停提示');
  else bad('加歌单没有用 ＋ 图标 / 没有提示：' + JSON.stringify(add));

  /* ---------- 2) 点 ＋：弹出歌单列表 → 选中一个 → 真的加进去 ---------- */
  const addBtn = await centerOf('#content .track[data-i="0"] .op-ic[data-act="add"]');
  await clickAt(addBtn.x, addBtn.y);
  const pickShown = await evalJS(`(() => ({
    show: document.getElementById('promptMask').classList.contains('show'),
    title: document.getElementById('promptTitle').textContent,
    rows: [...document.querySelectorAll('#promptBody .pl-row')].map((r) => r.textContent.trim()),
    hasNew: !!document.getElementById('plNew'),
  }))()`);
  say('\n--- 点 ＋ 弹出的选歌单窗 ---');
  say('  显示=' + pickShown.show + ' 标题「' + pickShown.title + '」歌单=' + JSON.stringify(pickShown.rows));
  if (pickShown.show && pickShown.rows.length === 2 && pickShown.hasNew) ok('点 ＋ 弹出歌单列表（2 个歌单 + 新建入口）');
  else bad('选歌单弹窗不对：' + JSON.stringify(pickShown));

  const plRow = await centerOf('#promptBody .pl-row[data-pl="pl-b"]');
  await clickAt(plRow.x, plRow.y);
  const afterPick = await evalJS(`({
    closed: !document.getElementById('promptMask').classList.contains('show'),
    n: DB.playlists.find((p) => p.id === 'pl-b').tracks.length,
    title: DB.playlists.find((p) => p.id === 'pl-b').tracks[0] && DB.playlists.find((p) => p.id === 'pl-b').tracks[0].title,
  })`);
  const savedHit = savedPayloads.some((d) => (d.playlists || []).some((p) => p.id === 'pl-b' && p.tracks.length === 1));
  say('  选中「深夜爵士」后：弹窗关闭=' + afterPick.closed + '，歌单里=' + afterPick.n + ' 首（' + afterPick.title + '）');
  if (afterPick.n === 1 && afterPick.title === '大鱼' && savedHit) ok('选中歌单后真的加进去了，并且已落盘');
  else bad('加入歌单失败：' + JSON.stringify(afterPick) + ' saved=' + savedHit);

  /* ---------- 3) 在弹窗里"新建歌单…"：建完直接加入 ---------- */
  const addBtn2 = await centerOf('#content .track[data-i="1"] .op-ic[data-act="add"]');
  await clickAt(addBtn2.x, addBtn2.y);
  const newBtn = await centerOf('#plNew');
  await clickAt(newBtn.x, newBtn.y);
  const newView = await evalJS(`(() => ({ hasInput: !!document.getElementById('plName'), hasCreate: !!document.getElementById('plCreate') }))()`);
  if (newView.hasInput) ok('点「新建歌单…」切到输入框');
  else bad('没有切到新建歌单的输入框');
  await evalJS(`(() => { const i = document.getElementById('plName'); i.value = '跑步歌单'; return true; })()`);
  const createBtn = await centerOf('#plCreate');
  await clickAt(createBtn.x, createBtn.y);
  const afterNew = await evalJS(`(() => {
    const pl = DB.playlists.find((p) => p.name === '跑步歌单');
    return {
      closed: !document.getElementById('promptMask').classList.contains('show'),
      total: DB.playlists.length,
      n: pl ? pl.tracks.length : -1,
      title: pl && pl.tracks[0] ? pl.tracks[0].title : '',
    };
  })()`);
  say('\n--- 弹窗内新建歌单 ---');
  say('  歌单数=' + afterNew.total + '，新歌单里=' + afterNew.n + ' 首（' + afterNew.title + '）');
  if (afterNew.n === 1 && afterNew.title === '起风了' && afterNew.closed) ok('弹窗内新建歌单成功，并把这首歌直接加了进去');
  else bad('弹窗内新建歌单失败：' + JSON.stringify(afterNew));

  /* ---------- 4) 侧栏「＋ 新建歌单」必须真的弹窗（以前是 prompt，点了没反应） ---------- */
  const sideBtn = await centerOf('#btnNewPlaylist');
  await clickAt(sideBtn.x, sideBtn.y);
  const sideModal = await evalJS(`({
    show: document.getElementById('promptMask').classList.contains('show'),
    hasInput: !!document.getElementById('promptInput'),
    title: document.getElementById('promptTitle').textContent,
  })`);
  say('\n--- 侧栏 ＋ 新建歌单 ---');
  say('  弹窗显示=' + sideModal.show + ' 标题「' + sideModal.title + '」输入框=' + sideModal.hasInput);
  if (sideModal.show && sideModal.hasInput) ok('侧栏「＋ 新建歌单」真的弹出输入框（不再是点了没反应的 prompt）');
  else bad('侧栏新建歌单仍无反应：' + JSON.stringify(sideModal));

  await evalJS(`(() => { document.getElementById('promptInput').value = '测试新建'; return true; })()`);
  const okBtn = await centerOf('#promptOk');
  await clickAt(okBtn.x, okBtn.y);
  const afterSide = await evalJS(`({
    exists: DB.playlists.some((p) => p.name === '测试新建'),
    view: currentView,
    title: document.querySelector('#content .block-title') ? document.querySelector('#content .block-title').textContent : '',
  })`);
  if (afterSide.exists) ok('输入名字后真的建出来了，并自动切到新歌单页（' + afterSide.title + '）');
  else bad('侧栏新建歌单没有生效：' + JSON.stringify(afterSide));

  /* ---------- 5) 播放队列抽屉 ----------
     ★ 先把"播不出来就自动跳下一首"的兜底关掉：这个沙箱没有音频输出设备，
       audio.play() 必然失败，于是 playAt 会在 900ms 后自动 next(1)，
       把刚点过去的 queue.index 又挪走 —— 那是测试环境的产物，不是队列的问题。
       （应用里真能播出声时不会触发这条兜底。） */
  await evalJS(`window.next = () => {}; true`);
  await evalJS(`(() => {
    currentView = 'search';
    searchResults = ${JSON.stringify(SEARCH)};
    renderSearch();
    playTracks(searchResults.slice(), 0, '测试队列');
    return queue.tracks.length;
  })()`);
  await sleep(400);
  const qBtn = await centerOf('#btnQueue');
  await clickAt(qBtn.x, qBtn.y);
  const qOpen = await evalJS(`({
    show: document.getElementById('queueMask').classList.contains('show'),
    rows: document.querySelectorAll('#queueList .collect-row').length,
    sub: document.getElementById('queueSub').textContent,
    hasRemove: !!document.querySelector('#queueList [data-qact="remove"]'),
  })`);
  say('\n--- 播放队列 ---');
  say('  打开=' + qOpen.show + ' 行数=' + qOpen.rows + ' 副标题「' + qOpen.sub + '」');
  if (qOpen.show && qOpen.rows === 2 && qOpen.hasRemove) ok('队列抽屉打开并列出队列里的每一首（带移除按钮）');
  else bad('队列抽屉不对：' + JSON.stringify(qOpen));

  const qRow2 = await centerOf('#queueList .collect-row[data-qi="1"]');
  await clickAt(qRow2.x, qRow2.y);
  await sleep(400);
  const qJump = await evalJS(`({ idx: queue.index, title: queue.tracks[queue.index] && queue.tracks[queue.index].title })`);
  say('  点队列第 2 行 → queue.index=' + qJump.idx + '（' + qJump.title + '）');
  if (qJump.idx === 1) ok('点队列里的某一首就能跳过去播');
  else bad('点队列行没有跳播：' + JSON.stringify(qJump));

  const qDel = await centerOf('#queueList .collect-row[data-qi="0"] [data-qact="remove"]');
  await clickAt(qDel.x, qDel.y);
  const qAfterDel = await evalJS(`({ len: queue.tracks.length, rows: document.querySelectorAll('#queueList .collect-row').length })`);
  say('  移除一首后：队列=' + qAfterDel.len + '，列表行=' + qAfterDel.rows);
  if (qAfterDel.len === 1 && qAfterDel.rows === 1) ok('能从队列里移除某一首');
  else bad('移除队列项失败：' + JSON.stringify(qAfterDel));

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(250);
  const qClosed = await evalJS(`document.getElementById('queueMask').classList.contains('show')`);
  if (!qClosed) ok('按 Esc 收起队列抽屉');
  else bad('Esc 没收起队列抽屉');

  /* ---------- 6) 合集面板每一集：点收藏不能顺手播 ---------- */
  await evalJS(`(() => { queue = { tracks: [], index: -1, name: '' }; DB.favorites = []; return true; })()`);
  await evalJS(`expandCollection({ bvid: '${COLLECT_BVID}', title: '六合集' }, { tracks: [], index: 0, name: '' })`);
  await sleep(600);
  const cCount = await evalJS(`document.querySelectorAll('#collectList .collect-row [data-cact="fav"]').length`);
  if (cCount === 6) ok('合集面板每一集都有收藏按钮（6 集 → 6 个）');
  else bad('合集面板的收藏按钮数量不对：' + cCount);

  const favC = await centerOf('#collectList .collect-row[data-ci="0"] [data-cact="fav"]');
  await clickAt(favC.x, favC.y);
  await sleep(400);
  const cFav = await evalJS(`({ favs: DB.favorites.length, queueLen: queue.tracks.length, on: !!document.querySelector('#collectList .collect-row.on') })`);
  say('\n--- 合集面板的收藏按钮 ---');
  say('  收藏数=' + cFav.favs + '，队列=' + cFav.queueLen);
  if (cFav.favs === 1 && cFav.queueLen === 0) ok('点收藏只收藏，没有顺手把这一集播了');
  else bad('合集面板点收藏误触发了播放：' + JSON.stringify(cFav));

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(250);

  /* ---------- 7) 点作者名 → UP 主页 ---------- */
  await evalJS(`(() => { currentView = 'search'; searchResults = ${JSON.stringify(SEARCH)}; renderSearch(); return true; })()`);
  await sleep(150);
  const linkInfo = await evalJS(`(() => {
    const a = document.querySelector('#content .track[data-i="0"] .a-link');
    return { text: a ? a.textContent : null, tip: a ? a.title : null };
  })()`);
  say('\n--- 作者名 ---');
  say('  第 1 行作者：' + JSON.stringify(linkInfo));
  if (linkInfo.text === '周深') ok('有 mid 的作者名做成了可点');
  else bad('作者名不可点：' + JSON.stringify(linkInfo));

  const aLink = await centerOf('#content .track[data-i="0"] .a-link');
  await clickAt(aLink.x, aLink.y);
  await sleep(900);
  const upView = await evalJS(`({
    view: currentView,
    upName: upState && upState.name,
    rows: document.querySelectorAll('#content .track').length,
    first: document.querySelector('#content .track .t') ? document.querySelector('#content .track .t').textContent : '',
    hasPlayAll: !!document.getElementById('btnPlayUp'),
    playUpText: (document.getElementById('btnPlayUp') || {}).textContent || '',
    sub: (document.querySelector('#content .block-sub') || {}).textContent || '',
    hasPager: !!document.querySelector('#content .pager'),
    queueLen: queue.tracks.length,
  })`);
  say('  点作者名后：view=' + upView.view + '，UP=' + upView.upName + '，列出 ' + upView.rows + ' 个视频，右上角按钮=' + JSON.stringify(upView.playUpText));
  say('  副标题：' + JSON.stringify(upView.sub) + '；有分页条=' + upView.hasPager);
  if (upView.view === 'up' && upView.rows === 2 && upView.hasPlayAll && upCalls > 0) ok('点作者名打开了 UP 主页，并按 mid 拉到了他的视频');
  else bad('UP 主页没有正常打开：' + JSON.stringify(upView));
  // ★ v2.5.0：只有 1 页时不该出现分页条；副标题要写明"共 N 个视频 · 第 x / y 页"
  if (upView.hasPager) bad('只有 1 页却画出了分页条（应该藏起来）');
  else ok('只有 1 页时不画分页条（v2.5.0）');
  if (/共 2 个视频/.test(upView.sub) && /第 1 \/ 1 页/.test(upView.sub)) ok('副标题写明总数与页码：' + upView.sub);
  else bad('副标题没写总数 / 页码：' + JSON.stringify(upView.sub));
  if (/播放本页 \(2\)/.test(upView.playUpText)) ok('右上角按钮已改成「播放本页 (N)」（v2.5.0）');
  else bad('右上角按钮文案不对：' + JSON.stringify(upView.playUpText));

  /* 截图：UP 主页 */
  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-up.png'), img1.toPNG());

  /* 截图：选歌单弹窗 */
  await evalJS(`(() => { currentView = 'search'; renderSearch(); return true; })()`);
  await sleep(150);
  const addBtn3 = await centerOf('#content .track[data-i="0"] .op-ic[data-act="add"]');
  await clickAt(addBtn3.x, addBtn3.y);
  await sleep(300);
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-pick.png'), img2.toPNG());

  /* 把鼠标停在某一行的 ＋ 上：行内图标按钮和悬停提示都要真的出来 */
  await evalJS(`(() => { closePrompt(null); return true; })()`);
  await sleep(250);
  await evalJS(`(() => { currentView = 'search'; searchResults = ${JSON.stringify(SEARCH)}; renderSearch(); return true; })()`);
  await sleep(150);
  const addPos = await centerOf('#content .track[data-i="0"] .op-ic[data-act="add"]');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: addPos.x, y: addPos.y });
  await sleep(500);
  const hoverState = await evalJS(`(() => {
    const r = document.querySelector('#content .track[data-i="0"]');
    const ops = r.querySelector('.ops');
    const add = r.querySelector('.op-ic[data-act="add"]');
    return {
      opsOpacity: getComputedStyle(ops).opacity,
      tipOpacity: getComputedStyle(add, '::after').opacity,
      tipText: getComputedStyle(add, '::after').content,
    };
  })()`);
  say('\n--- 鼠标停在这一行的 ＋ 上 ---');
  say('  按钮不透明度=' + hoverState.opsOpacity + '，提示不透明度=' + hoverState.tipOpacity + '，提示内容=' + hoverState.tipText);
  if (Number(hoverState.opsOpacity) > 0.9 && Number(hoverState.tipOpacity) > 0.9 && /加入歌单/.test(hoverState.tipText))
    ok('鼠标移上去按钮真的浮现，并且浮出了「加入歌单」的提示');
  else bad('悬停提示没有真正显示：' + JSON.stringify(hoverState));

  const img3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-rows.png'), img3.toPNG());

  /* 截图：队列抽屉 */
  await evalJS(`(() => {
    queue = { tracks: searchResults.concat(searchResults.map((t, i) => Object.assign({}, t, { bvid: t.bvid + 'b', title: t.title + '（重唱版）' }))), index: 1, name: '测试队列' };
    openQueue();
    return queue.tracks.length;
  })()`);
  await sleep(500);
  const img4 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-queue.png'), img4.toPNG());
  say('\n已保存 shot-up.png / shot-pick.png / shot-rows.png / shot-queue.png');

  /* ================= v2.8.0：下载入口 + 下载管理页 + 绿勾 ================= */
  say('\n--- v2.8.0 下载 ---');

  /* ① 侧栏底部：设置 + 下载管理，两个并排 */
  const foot = await evalJS(`(() => {
    const a = document.getElementById('btnSettings'), b = document.getElementById('btnDownloads');
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return { n: document.querySelectorAll('.sidebar-foot button').length,
             sameRow: Math.abs(ra.top - rb.top) < 2, leftFirst: ra.left < rb.left,
             aw: Math.round(ra.width), bw: Math.round(rb.width),
             hasBadge: !!document.getElementById('dlBadge') };
  })()`);
  if (foot && foot.n === 2 && foot.sameRow && foot.leftFirst && foot.hasBadge)
    ok(`侧栏底部是「设置」+「下载管理」两个并排按钮（${foot.aw}px / ${foot.bw}px），带角标`);
  else bad('侧栏底部布局不对：' + JSON.stringify(foot));

  /* ② 播放条：下载按钮紧挨着「词」（Neo 的原话是"在歌词按钮边上"）。
     ★ 断言的是"挨着"，不是"在左边" —— 具体在哪一侧是版式选择，
       真正要守住的是"它跟「词」在同一排、中间不夹别的按钮、一眼能看出是一对"。 */
  const bar = await evalJS(`(() => {
    const d = document.getElementById('btnDownload'), l = document.getElementById('btnLyric');
    if (!d || !l) return null;
    const rd = d.getBoundingClientRect(), rl = l.getBoundingClientRect();
    // 两个按钮之间的净间距（不论谁在左，重叠时为负）
    const gap = Math.round(Math.max(rd.left - rl.right, rl.left - rd.right));
    return { sameRow: Math.abs((rd.top + rd.height / 2) - (rl.top + rl.height / 2)) < 6,
             gap, icon: (d.querySelector('use') || {}).getAttribute('href'),
             w: Math.round(rd.width) };
  })()`);
  if (bar && bar.sameRow && bar.gap >= 0 && bar.gap <= 30 && bar.icon === '#i-download')
    ok(`播放条上有下载按钮，紧挨着「词」（同一排、间距 ${bar.gap}px、宽 ${bar.w}px）`);
  else bad('播放条的下载按钮没有紧挨着「词」：' + JSON.stringify(bar));

  /* ③ 下载管理页：2 条任务 / 4 个筛选 / 进度条 / 「已完成」 */
  await evalJS(`(async () => { currentView = 'downloads'; await refreshDownloads(); renderAll(); return true; })()`);
  await sleep(400);
  const dlPage = await evalJS(`({
    view: currentView,
    rows: document.querySelectorAll('#content .dl-row').length,
    tabs: [...document.querySelectorAll('#content .dl-tab')].map((t) => t.textContent.trim()),
    bars: document.querySelectorAll('#content .dl-bar > i').length,
    done: document.querySelectorAll('#content .dl-status.ok').length,
    badge: (document.getElementById('dlBadge') || {}).textContent || '',
  })`);
  if (dlPage.rows === 2 && dlPage.tabs.length === 4 && dlPage.bars === 1 && dlPage.done === 1)
    ok('下载管理页画出了 2 条任务 / 4 个筛选胶囊 / 1 条进度条 / 1 条「已完成」');
  else bad('下载管理页渲染不对：' + JSON.stringify(dlPage));
  say(`  侧栏角标 = "${dlPage.badge}"（1 个进行中）`);

  /* ★ 截图前一定要 sleep：offscreen 合成是异步的，紧接着 capturePage 会拿到**上一帧**
     （第一次跑就是这样截到了一张过期的画面，白折腾一轮）。 */
  await sleep(400);
  fs.writeFileSync(path.join(__dirname, 'shot-downloads.png'), (await win.webContents.capturePage()).toPNG());

  /* ④ 绿勾：必须是**固定语义绿**，在「薄荷绿」主题下也不能跟成主题色。
     ★ 这条是本次最容易出错的地方：--accent 在 green 主题下是 rgb(90,214,154)，
       和 --ok 的 rgb(74,222,128) 非常接近 —— 一旦写错，肉眼几乎分不出来，只能靠断言拦。 */
  const green = await evalJS(`(() => {
    document.documentElement.dataset.theme = 'green';
    currentView = 'search'; searchKeyword = '测试';
    const t = searchResults[0]; t.cid = 7;      // 与桩里 dl_test1 的 key 对上 → 视为已下载
    renderAll();
    const row = document.querySelector('#content .track');
    const btn = row && row.querySelector('[data-act="download"]');
    if (!btn) return null;
    return { cls: btn.className,
             icon: (btn.querySelector('use') || {}).getAttribute('href'),
             color: getComputedStyle(btn).color,
             accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() };
  })()`);
  if (green && /\bdone\b/.test(green.cls) && green.icon === '#i-check' && green.color === 'rgb(74, 222, 128)')
    ok(`已下载的行内按钮变成绿勾，颜色 ${green.color} —— 薄荷绿主题下也不会跟主题色混（主题色是 ${green.accent}）`);
  else bad('绿勾状态不对（薄荷绿主题下会不会混成主题色？）：' + JSON.stringify(green));
  await evalJS(`(() => { document.documentElement.dataset.theme = 'pink'; return true; })()`);

  /* ⑤ 批量选择模式：进得去、每行有勾选框、能全选 */
  const pick = await evalJS(`(() => {
    DB.favorites = searchResults.slice();
    currentView = 'favorites';
    renderAll();
    document.getElementById('btnSelectFav').click();
    return { picking: !!selPick,
             pickable: document.querySelectorAll('#content .track.pickable').length,
             bar: !!document.querySelector('#content .imp-bar') };
  })()`);
  await sleep(200);
  const pick2 = await evalJS(`(() => {
    document.getElementById('btnSelPickAll').click();
    const doBtn = document.getElementById('btnSelDownload');
    return { n: selPick ? selPick.selected.size : -1,
             doText: (doBtn || {}).textContent || '',
             doEnabled: !!(doBtn && !doBtn.disabled),
             count: ((document.querySelector('.pick-bar .imp-count') || {}).textContent || '') };
  })()`);
  if (pick && pick.picking && pick.pickable === 2 && pick.bar && pick2.n === 2 && /下载/.test(pick2.doText) && pick2.doEnabled && /2/.test(pick2.count))
    ok('「我喜欢」点「批量选择」进入选择模式；全选后工具条写着「已选 2 首」且「下载」可点');
  else bad('批量选择模式不对：' + JSON.stringify(pick) + ' / ' + JSON.stringify(pick2));
  await evalJS(`(() => { if (selPick) { selPick = null; renderAll(); } return true; })()`);

  /* ⑥ 闭环：点行内下载按钮 → 主进程真的收到了这首歌（这才是"能下"的实质）。
     ★ 光断言"按钮点得动"是不够的 —— 真正要守住的是"点了以后发出去的是哪首"。
       第二首的 cid 故意换成一个桩里没有的（999）→ 它变成"没下过"的那一行。
       同时顺带验证"没设过下载目录时会先弹选目录框"（Neo 明确要的行为）。 */
  await evalJS(`(() => {
    DB.settings.download.dir = null;              // 回到"从没选过"的状态
    currentView = 'search'; searchKeyword = '测试';
    searchResults[0].cid = 7; searchResults[1].cid = 999;
    renderAll();
    return true;
  })()`);
  const addBefore = dlStub.calls.add.length;
  const pickBefore = dlStub.calls.pickDir;
  await evalJS(`document.querySelectorAll('#content .track')[1]
    .querySelector('[data-act="download"]').click()`);
  await sleep(700);
  const sent = dlStub.calls.add.slice(addBefore);
  const last = sent.length ? sent[sent.length - 1] : null;
  const pickedDir = dlStub.calls.pickDir > pickBefore;
  const dirSaved = (await evalJS(`(DB.settings.download || {}).dir || ''`)) || '';
  if (last && last.length === 1 && last[0].bvid === 'BV1song0002' && last[0].cid === 999 && pickedDir && dirSaved)
    ok(`点行内下载按钮 → 主进程收到 ${last[0].bvid}:${last[0].cid}；且首次下载先弹了选目录框（已记住 ${dirSaved}）`);
  else bad('下载链路没有闭环：' + JSON.stringify({ last, pickedDir, dirSaved }));

  /* ================= v2.8.0 修订（真机反馈） ================= */

  /* ⑦ 收起的整页歌词不能接鼠标 —— 它的「桌面歌词」按钮正好压在工具栏最右侧
     「批量选择」那个 ✓ 图标上面。之前点那个图标会莫名其妙把悬浮歌词开出来。 */
  await evalJS(`(() => {
    if (selPick) selPick = null;
    closeQueue();
    currentView = 'favorites'; renderAll();
    DB.settings.lyricWin = DB.settings.lyricWin || {};
    DB.settings.lyricWin.on = false;
    return true;
  })()`);
  await sleep(300);
  {
    const icPos = await evalJS(`(() => {
      const s = document.getElementById('btnSelectFav').querySelector('svg.ic').getBoundingClientRect();
      return { x: Math.round(s.x + s.width / 2), y: Math.round(s.y + s.height / 2) };
    })()`);
    await clickAt(icPos.x, icPos.y);
    const after = await evalJS(`({
      lyricOn: !!(DB.settings.lyricWin && DB.settings.lyricWin.on),
      overlay: document.getElementById('lyricOverlay').classList.contains('show'),
      picking: !!document.getElementById('btnSelDownload'),
    })`);
    if (!after.lyricOn && !after.overlay && after.picking)
      ok('★ 点「批量选择」前面的 ✓ 图标 → 进选择模式，不再误开悬浮歌词');
    else bad('点那个图标的行为不对（疑似又落在隐藏歌词浮层的按钮上）：' + JSON.stringify(after));
    await evalJS(`(() => { if (selPick) { selPick = null; renderAll(); } return true; })()`);
    await sleep(250);
  }

  /* ⑧ 勾选态下按钮**不许变形**（真机反馈"变形变高"）。
     量的是同一颗按钮在两种状态下的高度 + 图标文字是否还在同一行。 */
  {
    const b1 = await evalJS(`Math.round(document.getElementById('btnSelectFav').getBoundingClientRect().height)`);
    await evalJS(`document.getElementById('btnSelectFav').click()`);
    await sleep(320);
    const b2 = await evalJS(`(() => {
      const b = document.getElementById('btnSelectFav');
      const i = b.querySelector('svg.ic').getBoundingClientRect();
      const s = b.querySelector('span').getBoundingClientRect();
      return { h: Math.round(b.getBoundingClientRect().height), text: b.textContent, cls: b.className,
               oneRow: Math.abs((i.top + i.height / 2) - (s.top + s.height / 2)) < 6 };
    })()`);
    if (b2.h === b1 && b2.oneRow && /退出批量选择/.test(b2.text) && /\bon\b/.test(b2.cls))
      ok(`★ 勾选态下按钮不变形：${b1}px → ${b2.h}px，图标和文字仍在同一行（class="${b2.cls}"）`);
    else bad('勾选态按钮变形了：' + JSON.stringify({ before: b1, after: b2 }));
    await evalJS(`(() => { if (selPick) { selPick = null; renderAll(); } return true; })()`);
    await sleep(250);
  }

  /* ⑨ 下载管理有「全部删除」（真机反馈"没有全部删除的功能"）。 */
  await evalJS(`(async () => { currentView = 'downloads'; dlFilter = 'all'; await refreshDownloads(); renderAll(); return true; })()`);
  await sleep(350);
  {
    const ids = await evalJS(`[...document.querySelectorAll('#content button')].map((b) => b.id).filter(Boolean)`);
    if (ids.includes('btnDlClearAll')) ok('★ 下载管理有「全部删除」按钮');
    else bad('下载管理缺「全部删除」：' + JSON.stringify(ids));
  }

  /* ⑩ 删掉下载记录后绿勾必须消失（真机反馈"下载后又删除了，图标还是下载成功图标"）。
     ★ 关键在**本地库那条也要一起清**：绿勾是"本地库 ∪ 已完成任务"两个来源的并集。
       只删任务不清本地库的话绿勾会一直挂着 —— 老代码只在"同时删文件"时才清本地库，
       而那个勾默认**不勾**，所以这条断言在旧代码上必挂（判别力就在这儿）。 */
  await evalJS(`(() => {
    DB.local = [{ id: 'L1', path: 'C:\\\\测试\\\\下载\\\\周深 - 大鱼.m4a', title: '大鱼',
                  key: 'BV1song0001:7', bvid: 'BV1song0001', cid: 7, src: 'download' }];
    dlDir = 'C:\\\\测试\\\\下载';
    rebuildDlKeys();
    currentView = 'search'; searchKeyword = '测试';
    searchResults[0].cid = 7;
    renderAll();
    return true;
  })()`);
  await sleep(300);
  const greenBefore = await evalJS(`(() => {
    const b = document.querySelector('#content .track [data-act="download"]');
    return b ? { done: /\\bdone\\b/.test(b.className), icon: (b.querySelector('use') || {}).getAttribute('href') } : null;
  })()`);
  if (greenBefore && greenBefore.done && greenBefore.icon === '#i-check') ok('（前置）这首歌先是「已下载」绿勾');
  else bad('前置条件不成立，后面那条就测不出东西：' + JSON.stringify(greenBefore));

  await evalJS(`(async () => { currentView = 'downloads'; dlFilter = 'all'; await refreshDownloads(); renderAll(); return true; })()`);
  await sleep(350);
  const rmBtn = await centerOf('#content .dl-row[data-dlid="dl_test1"] [data-dlact="remove"]');
  const rmBefore = dlStub.calls.remove.length;
  if (rmBtn) {
    await clickAt(rmBtn.x, rmBtn.y);
    await sleep(350);
    const okBtn = await centerOf('#promptOk');
    if (okBtn) { await clickAt(okBtn.x, okBtn.y); await sleep(800); }
    const after = await evalJS(`(() => {
      const keys = (DB.local || []).filter((e) => e && e.key).map((e) => e.key);
      currentView = 'search'; searchKeyword = '测试'; renderAll();
      const b = document.querySelector('#content .track [data-act="download"]');
      return { localKeys: keys, done: b ? /\\bdone\\b/.test(b.className) : null,
               icon: b ? (b.querySelector('use') || {}).getAttribute('href') : '' };
    })()`);
    const sent = dlStub.calls.remove.slice(rmBefore);
    if (sent.length && sent[0][1] === false && !after.localKeys.length && after.done === false && after.icon === '#i-download')
      ok('★ 删掉下载记录（没勾"同时删文件"）→ 本地库那条也清了，绿勾变回下载箭头');
    else bad('删除后绿勾没消失：' + JSON.stringify({ sent, after }));
  } else {
    bad('下载管理里找不到这条任务的「删除」按钮');
  }

  /* ================= v2.8.0 修订二：两个新问题（真机反馈） ================= */

  /* ⑪ 问题 A：在资源管理器里**直接删文件**后，绿勾要消失、并且能重下。
     ★ 判别力关键：旧代码里 rebuildDlKeys() 是纯字符串运算、从不查磁盘，
       所以"文件没了但绿勾还在"；点它只会去 download:reveal，既不体检也不重下。
       这里把 local:stat 打开成"一律不存在"，走一遍真实点击链路。 */
  {
    dlStub.setLocalMissing(true);            // ★ 模拟"文件已被外部删掉"
    const addBefore = dlStub.calls.add.length;
    // 塞一条本地库记录（绿勾的第一来源），并把任务表那条也放回来（第二来源）
    await evalJS(`(() => {
      DB.local = [{ id: 'L2', path: 'C:\\\\测试\\\\下载\\\\周深 - 大鱼.m4a', title: '大鱼',
                    key: 'BV1song0001:7', bvid: 'BV1song0001', cid: 7, src: 'download' }];
      dlDir = 'C:\\\\测试\\\\下载';
      rebuildDlKeys();
      currentView = 'search'; searchKeyword = '测试';
      searchResults[0].cid = 7; searchResults[0].bvid = 'BV1song0001'; searchResults[0].title = '大鱼';
      renderAll();
      return true;
    })()`);
    await sleep(400);
    const beforeA = await evalJS(`(() => {
      const b = document.querySelector('#content .track [data-act="download"]');
      return { done: b ? /\\bdone\\b/.test(b.className) : null,
               icon: b ? (b.querySelector('use') || {}).getAttribute('href') : '' };
    })()`);
    if (beforeA.done && beforeA.icon === '#i-check') ok('（前置）外部删文件前这首歌是绿勾');
    else bad('前置条件不成立：' + JSON.stringify(beforeA));

    // 点它 —— 应该：发现文件没了 → 清记录 → 变回下载箭头 → 重新入队
    await evalJS(`document.querySelector('#content .track [data-act="download"]').click()`);
    await sleep(1500);
    const afterA = await evalJS(`(() => {
      currentView = 'search'; searchKeyword = '测试'; renderAll();
      const b = document.querySelector('#content .track [data-act="download"]');
      return { localLen: (DB.local || []).length,
               dlKeys: [...dlKeys],
               done: b ? /\\bdone\\b/.test(b.className) : null,
               icon: b ? (b.querySelector('use') || {}).getAttribute('href') : '' };
    })()`);
    const sentAdd = dlStub.calls.add.slice(addBefore);
    say('\n--- 问题 A：外部删除后点绿勾 ---');
    say('  点击后 DB.local=' + afterA.localLen + '，dlKeys=' + JSON.stringify(afterA.dlKeys)
        + '，按钮=' + afterA.icon);
    say('  重新入队的曲目 = ' + JSON.stringify(sentAdd.map((l) => l.map((t) => t.bvid + ':' + t.cid))));
    if (afterA.localLen === 0 && afterA.dlKeys.length === 0 && afterA.done === false
        && afterA.icon === '#i-download' && sentAdd.length > 0)
      ok('★ 外部删文件后点绿勾 → 清掉失效记录、绿勾变回下载箭头、并重新入队');
    else bad('问题 A 没修好：' + JSON.stringify({ afterA, sentAdd }));
    dlStub.setLocalMissing(false);           // 复位，别影响后面的用例

    // 补一条：文件还在时点绿勾不能变成"重新下载"（回归）
    const addBefore2 = dlStub.calls.add.length;
    const revBefore = dlStub.calls.reveal;
    await evalJS(`(() => {
      DB.local = [{ id: 'L3', path: 'C:\\\\测试\\\\下载\\\\周深 - 大鱼.m4a', title: '大鱼',
                    key: 'BV1song0001:7', bvid: 'BV1song0001', cid: 7, src: 'download' }];
      rebuildDlKeys();
      currentView = 'search'; searchKeyword = '测试'; renderAll();
      return true;
    })()`);
    await sleep(300);
    await evalJS(`document.querySelector('#content .track [data-act="download"]').click()`);
    await sleep(1200);
    const sameAdd = dlStub.calls.add.length - addBefore2;
    const sameRev = dlStub.calls.reveal - revBefore;
    const stillLocal = await evalJS(`(DB.local || []).length`);
    if (sameAdd === 0 && sameRev === 1 && stillLocal === 1)
      ok('★ 回归：文件还在时点绿勾只开文件夹（reveal+1），不清记录、不重下');
    else bad('回归被破坏（文件在时不该重下）：' + JSON.stringify({ sameAdd, sameRev, stillLocal }));
  }

  /* ⑫ 问题 B：断流自愈（stalled → 重新解析地址 → 接回原位置）
     ★ 只验"机制接上了"这件事 —— 真实的断流要在真机上才复现得了，
       这里把 audio 的 paused 临时改成 false（离屏沙箱没声卡，它永远是 paused），
       再派发 stalled，看有没有走一遍"重新取地址"。 */
  {
    const healProbe = await evalJS(`(async () => {
      window.next = () => {};                      // 别让兜底真的跳歌
      currentView = 'search'; searchKeyword = '测试';
      searchResults = [{ bvid: 'BV1song0001', cid: 7, page: 1, title: '大鱼', author: '周深', cover: '', duration: 312 }];
      renderAll();
      playTracks(searchResults.slice(), 0, '断流测试');
      return true;
    })()`);
    await sleep(1600);
    const healBefore = await evalJS(`({
      hasHeal: typeof healOnStall === 'function',
      hasRefresh: typeof refreshAudioUrl === 'function',
      hasDeadline: typeof srcDeadlineAt === 'function',
      listened: ['stalled','waiting'].every((ev) => {
        // 用"派发后有没有反应"间接确认（拿不到监听器列表）
        return true;
      }),
      src: audio.src ? audio.src.slice(0, 30) : '',
    })`);
    say('\n--- 问题 B：断流自愈 ---');
    say('  healOnStall=' + healBefore.hasHeal + ' refreshAudioUrl=' + healBefore.hasRefresh
        + ' srcDeadlineAt=' + healBefore.hasDeadline);
    if (healBefore.hasHeal && healBefore.hasRefresh && healBefore.hasDeadline)
      ok('★ 自愈三件套都在（healOnStall / refreshAudioUrl / srcDeadlineAt）');
    else bad('自愈函数缺失：' + JSON.stringify(healBefore));

    // 真派发一次 stalled：把 paused 强行改成 false（模拟"正在播"），清掉冷却
    const healed = await evalJS(`(async () => {
      try { Object.defineProperty(audio, 'paused', { configurable: true, get: () => false }); } catch (e) {}
      healBusy = false; lastHealAt = 0;
      const gate = { healBusy, lastHealAt, paused: audio.paused, hasSrc: !!audio.src,
                     would: (healBusy ? 'busy' : (audio.paused ? 'paused' : (!audio.src ? 'nosrc' : 'PASS'))) };
      const oldSrc = audio.src;
      try { audio.currentTime = 55; } catch (e) {}
      audio.dispatchEvent(new Event('stalled'));
      await new Promise((r) => setTimeout(r, 2400));
      return { changed: audio.src !== oldSrc, ct: audio.currentTime, gate, oldSrc: String(oldSrc).slice(0, 40),
               newSrc: String(audio.src).slice(0, 40), healBusyAfter: healBusy };
    })()`);
    say('  闸门诊断：' + JSON.stringify(healed.gate));
    say('  stalled 后：src 换了=' + healed.changed + '，currentTime=' + healed.ct + '（≈55 说明接回了原位置）');
    say('  src: ' + healed.oldSrc + ' → ' + healed.newSrc);
    if (!/^bili:\/\//.test(healed.oldSrc))
      say('  ★ 注意：这一条依赖 bili:// 桩地址；若 src 不是 bili:// 说明桩没生效');
    if (healed.changed && healed.ct >= 53 && healed.ct <= 57)
      ok('★ 断流后真的重新解析了地址并把播放位置接了回去（不会从头开始、不会卡死）');
    else bad('自愈没生效：' + JSON.stringify(healed));
  }

  /* 勾选模式的那张图：要的是"已选 2 首"的样子，所以先重进一次勾选模式再截 */
  await evalJS(`(() => { closeQueue(); if (selPick) selPick = null;
    currentView = 'favorites'; renderAll();
    document.getElementById('btnSelectFav').click();
    document.getElementById('btnSelPickAll').click();
    return true; })()`);
  await sleep(400);
  fs.writeFileSync(path.join(__dirname, 'shot-dl-pick.png'), (await win.webContents.capturePage()).toPNG());
  say('已保存 shot-downloads.png / shot-dl-pick.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n新交互实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
