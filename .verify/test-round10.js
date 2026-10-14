/* 第十轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.1.0 mini 模式 —— 同一个窗口换布局，不是另开窗口。

   ★ 这一份的特别之处：窗口尺寸那一半用的是 **src/win-mini.js 里的真代码**
     （applyMiniBounds / restoreFullBounds / handleMiniRequest），
     不是测试里照抄一份的桩 —— 所以"尺寸算得对不对"是真被测到了。
     抽这个模块的理由和 bg-protocol.js 一样（离线实测没法 require 整个 main.js）。

   量什么：
     [1] 进 mini：body.mini 挂上；四块面板 display:none；播放条还在
     [2] 窗口真的缩成 420×132
     [3] 收起态内部布局：封面左 / 控制中 / 杂项右 / ✕▢ 贴右边缘 / 歌名第二行（量坐标，不是看代码）
     [4] 展开态：body.mini-open；队列列表可见且渲染出行；窗口高 520
     [5] mini 下 ☰ 不再拉右侧抽屉（改成就地展开）
     [6] 退出 mini：body.mini 没了；窗口位置尺寸与进入前**逐个数字**一致
     [7] Ctrl+M 也能进 / 出
     [8] 存档：settings.window 的 mini / miniExpanded / fullBounds 都写进去了
     [9] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
//   这只是"测试环境"的开关，不进应用代码（src/main.js 里没有这些）。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round10-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ★ 真逻辑：窗口尺寸怎么算、进出 mini 怎么编排，全在这里 */
const {
  MINI_W, MINI_H_COLLAPSED, MINI_H_EXPANDED,
  handleMiniRequest,
} = require(path.join(ROOT, 'src', 'win-mini.js'));

/* ---------- 主进程桩 ---------- */
let lastSaved = null;
let win = null;

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

/* 窗口按钮：只记一下，别真去动窗口（动了会影响尺寸断言） */
const winCalls = [];
ipcMain.on('win-min', () => winCalls.push('min'));
ipcMain.on('win-max', () => winCalls.push('max'));
ipcMain.on('win-close', () => winCalls.push('close'));
ipcMain.on('win:close-ready', () => winCalls.push('close-ready'));
ipcMain.on('win:fullscreen', () => winCalls.push('fullscreen'));

/* ★ mini：界面发过来的请求，交给 win-mini.js 里的真逻辑处理 */
const miniState = { on: false, expanded: false, fullBounds: null };
ipcMain.on('win:mini', (_e, opts) => {
  const snap = () => ({
    b: win.getBounds(), min: win.getMinimumSize(), max: win.getMaximumSize(),
    rz: win.isResizable(), norm: win.getNormalBounds(),
  });
  const before = snap();
  const st = handleMiniRequest(win, miniState, opts, screen.getPrimaryDisplay().workAreaSize);
  const after = snap();
  say(`  [ipc win:mini] opts=${JSON.stringify(opts)}  fullBounds=${JSON.stringify(st.fullBounds)}  workArea=${JSON.stringify(screen.getPrimaryDisplay().workAreaSize)}`);
  say(`        before ${JSON.stringify(before)}`);
  say(`        after  ${JSON.stringify(after)}`);
  try { win.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
});

/* 完整模式下窗口被拖动 / 缩放后把尺寸推给界面 —— main.js 里是"停下 0.5 秒后推"，
   这里只保留"推"这一步（防抖那部分由 verify.js 静态查）。
   测试窗口在完整模式下不会自己动，所以下面手动调一次。 */
const pushBounds = () => {
  if (!win || win.isDestroyed() || miniState.on) return;
  try { win.webContents.send('win:bounds', win.getNormalBounds()); } catch (_) {}
};

/* ★ Windows 上 getBounds() 拿到的外框会比"请求的尺寸"大 1~2px
   （那条看不见的缩放边框）。所以尺寸判据一律留 2px 容差，
   但"进出 mini 前后是否一致"仍然是逐数字比对 —— 那才是用户真正能感觉到的。 */
const TOL = 2;
const near = (a, b) => Math.abs(a - b) <= TOL;

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
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败/i.test(msg)) {
      errors.push('[主窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const click = (id) => evalJS(`(() => { document.getElementById('${id}').click(); return true; })()`);
  const bounds = () => win.getBounds();

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1000);
    await evalJS(`(() => {
      // 掐掉音频：沙箱没声卡，audio.play() 必然失败（环境产物）
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      window.__paused = true;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  /* 先灌一个 5 首的队列（收起态/展开态都要用），当前第 3 首 */
  await evalJS(`(() => {
    const rows = Array.from({ length: 5 }, (_, i) => window.__mk('BV1mini' + i, '示例歌曲 ' + (i + 1)));
    queue = { tracks: rows, index: 2, name: '测试来源' };
    renderAll();
    return true;
  })()`);
  await sleep(200);

  const beforeBounds = bounds();
  say(`进入 mini 前的窗口：${beforeBounds.width}×${beforeBounds.height} @ (${beforeBounds.x}, ${beforeBounds.y})`);
  // 完整模式下把窗口尺寸推给界面存档（模拟 main.js 的 win:bounds）
  pushBounds();
  await sleep(250);

  /* ================= 1) 进 mini（收起态） ================= */
  say('\n[1] 进 mini：整个窗口只剩播放条：');
  await click('btnMini');
  await sleep(500);

  const state = await evalJS(`(() => {
    const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : '(没有这个元素)'; };
    const vis = (sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      hasMini: document.body.classList.contains('mini'),
      hasOpen: document.body.classList.contains('mini-open'),
      sidebar: disp('.sidebar'), topbar: disp('.topbar'), content: disp('.content'), titlebar: disp('.titlebar'),
      mainDisp: disp('.main'),
      playerDisp: disp('.player'), playerVisible: vis('.player'),
      innerW: window.innerWidth, innerH: window.innerHeight,
    };
  })()`);
  say('  ' + JSON.stringify(state));

  if (!state.hasMini) bad('body 上没有 mini 类 —— 布局根本没换');
  else ok('body 挂上了 mini 类');

  const hiddenAll = [state.sidebar, state.topbar, state.content, state.titlebar].every((d) => d === 'none');
  if (!hiddenAll) bad(`四块面板没有全藏掉（sidebar=${state.sidebar} topbar=${state.topbar} content=${state.content} titlebar=${state.titlebar}）`);
  else ok('侧栏 / 顶栏 / 内容区 / 标题栏 的计算 display 都是 none');
  if (state.mainDisp !== 'none') bad('.main 没藏 —— 它会占着网格把布局顶歪（display=' + state.mainDisp + '）');
  else ok('.main 也藏了（否则会被塞进隐式行）');
  if (state.playerDisp === 'none' || !state.playerVisible) bad('播放条在 mini 下不可见');
  else ok('播放条仍然可见（它就是 mini 窗的全部）');
  if (state.hasOpen) bad('刚进 mini 就带上了 mini-open —— 应该默认是收起态');
  else ok('默认是收起态（不带 mini-open）');

  /* ================= 2) 窗口尺寸 ================= */
  say('\n[2] 窗口真的缩成了一条小窗：');
  const miniBounds = bounds();
  say(`  mini 窗口：${miniBounds.width}×${miniBounds.height} @ (${miniBounds.x}, ${miniBounds.y})；页面内视口 ${state.innerW}×${state.innerH}`);
  if (!near(miniBounds.width, MINI_W)) bad(`窗口宽 ${miniBounds.width}，应该是 ${MINI_W}（容差 ${TOL}）`);
  else ok(`窗口宽 ≈ ${MINI_W}（实测 ${miniBounds.width}）`);
  if (!near(miniBounds.height, MINI_H_COLLAPSED)) bad(`窗口高 ${miniBounds.height}，收起态应该是 ${MINI_H_COLLAPSED}（容差 ${TOL}）`);
  else ok(`窗口高 ≈ ${MINI_H_COLLAPSED}（收起态，实测 ${miniBounds.height}）`);
  if (!(miniBounds.width <= 460 && miniBounds.height <= 160)) bad('没有满足"宽 ≤ 460 且 高 ≤ 160"这条判据');
  else ok('满足判据：宽 ≤ 460 且 高 ≤ 160');
  // 顶边不动、水平居中 —— 这样展开时是"往下长出来"，不是整条跳走
  if (!near(miniBounds.y, beforeBounds.y)) bad(`顶边动了（${beforeBounds.y} → ${miniBounds.y}），展开时会整条往下跳`);
  else ok(`顶边基本没动（${beforeBounds.y} → ${miniBounds.y}，差 ${miniBounds.y - beforeBounds.y}px，是缩放边框的差）`);
  const expectX = Math.round(beforeBounds.x + (beforeBounds.width - MINI_W) / 2);
  if (!near(miniBounds.x, expectX)) bad(`水平没有居中缩放（x=${miniBounds.x}，期望 ${expectX}）`);
  else ok('水平居中缩放');

  /* ================= 3) 收起态内部布局 ================= */
  say('\n[3] 收起态内部：封面左 / 控制中 / 杂项右 / 歌名第二行：');
  const layout = await evalJS(`(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
    const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : null; };
    return {
      cover: box('.np-cover'), ctrl: box('.controls'), heart: box('.heart-btn'),
      queue: box('#btnQueue'), actions: box('.mini-actions'), title: box('.np-title'),
      player: box('.player'),
      winW: window.innerWidth, winH: window.innerHeight,
      // 图2 里不该出现的东西
      mode: disp('#btnMode'), progress: disp('.progress-row'), lyricWrap: disp('.lyric-wrap'),
      openBili: disp('#btnOpenBili'), volPop: disp('.vol-pop'),
    };
  })()`);
  say('  ' + JSON.stringify(layout));

  const need = ['cover', 'ctrl', 'heart', 'queue', 'actions', 'title'];
  const missing = need.filter((k) => !layout[k]);
  if (missing.length) bad('取不到这些元素的盒子：' + missing.join(' / '));
  else {
    // 播放条要填满整个小窗（收起态整个窗口就这一块）
    if (!near(layout.player.h, layout.winH)) bad(`播放条高 ${layout.player.h}，没填满小窗（视口高 ${layout.winH}）`);
    else ok(`播放条填满小窗（${layout.player.h}px 高）`);
    // 从左到右的顺序
    const order = [['封面', layout.cover.x], ['控制键', layout.ctrl.x], ['♡', layout.heart.x], ['☰', layout.queue.x], ['✕▢', layout.actions.x]];
    const sorted = order.slice().sort((a, b) => a[1] - b[1]);
    if (sorted.map((o) => o[0]).join(' → ') !== '封面 → 控制键 → ♡ → ☰ → ✕▢') {
      bad('横向顺序不对：' + order.map((o) => o[0] + '@' + o[1]).join(' '));
    } else {
      ok('横向顺序正确：封面 → ⏮⏸⏭ → ♡ → ☰ → ✕▢');
    }
    // 封面在最左
    if (layout.cover.x > 30) bad(`封面没贴左边（x=${layout.cover.x}）`);
    else ok('封面贴左边');
    // ✕▢ 贴右边缘（和标题栏一个规矩）
    if (!near(layout.actions.right, layout.winW)) bad(`✕▢ 没贴到右边缘（right=${layout.actions.right}，窗口宽 ${layout.winW}）`);
    else ok('✕▢ 贴到窗口右边缘');
    // ✕▢ 必须和封面在同一行（这一条是"第一行没被挤爆"的哨兵）
    if (layout.actions.y > layout.cover.y + 20) bad(`✕▢ 被挤到第二行去了（y=${layout.actions.y}，封面 y=${layout.cover.y}）—— 第一行宽度超了`);
    else ok('✕▢ 和封面在同一行（第一行没溢出）');
    // 歌名在第二行：它的顶边要低于封面的顶边，且横向从左边起
    if (!(layout.title.y > layout.cover.y + 10)) bad(`歌名没落在第二行（title.y=${layout.title.y}，cover.y=${layout.cover.y}）`);
    else ok('歌名另起一行（在封面下方）');
    if (layout.title.x > 30) bad(`歌名没从左边起（x=${layout.title.x}）`);
    else ok('歌名从左边起');
    // 整条撑满窗口高度（收起态只剩这一块）
    if (Math.abs(layout.cover.y + layout.cover.h / 2 - layout.winH / 2) > 26) {
      say(`  （提示：封面竖直中心 ${Math.round(layout.cover.y + layout.cover.h / 2)}，窗口中心 ${layout.winH / 2}）`);
    }
    // 图2 里没有的零件必须收起来
    const leftovers = [['播放模式键', layout.mode], ['进度条', layout.progress], ['「词」按钮', layout.lyricWrap], ['「在浏览器打开」', layout.openBili], ['音量滑杆', layout.volPop]]
      .filter(([, d]) => d !== 'none');
    if (leftovers.length) bad('这些零件没收起来：' + leftovers.map(([n]) => n).join(' / '));
    else ok('播放模式键 / 进度条 / 「词」/「在浏览器打开」/ 音量滑杆都收起来了');
  }

  /* ================= 4) 展开态 ================= */
  say('\n[4] 展开态：mini 条下面挂出播放队列：');
  await click('btnQueue');   // mini 下 ☰ = 就地展开
  await sleep(500);

  const exp = await evalJS(`(() => {
    const box = document.getElementById('miniList');
    const cs = getComputedStyle(box);
    const rows = box.querySelectorAll('.collect-row');
    const drawer = document.getElementById('queueMask');
    const onRow = box.querySelector('.collect-row.on');
    return {
      hasOpen: document.body.classList.contains('mini-open'),
      disp: cs.display, visible: box.getBoundingClientRect().height > 0,
      rows: rows.length,
      onRowText: onRow ? onRow.querySelector('.ct').textContent : null,
      headText: (box.querySelector('.mini-head') || {}).textContent || null,
      // ☰ 在 mini 下不该拉出右侧抽屉
      drawerOpen: drawer ? drawer.classList.contains('show') : false,
      listH: Math.round(box.getBoundingClientRect().height),
    };
  })()`);
  say('  ' + JSON.stringify(exp));

  if (!exp.hasOpen) bad('body 上没有 mini-open —— 展开态没生效');
  else ok('body 挂上了 mini-open');
  if (exp.disp === 'none' || !exp.visible) bad('展开态的队列列表不可见');
  else ok('队列列表可见');
  if (exp.rows < 1) bad('队列列表里一行都没渲染出来');
  else ok(`队列列表渲染出 ${exp.rows} 行`);
  if (exp.rows !== 5) bad(`应该有 5 行（队列 5 首），实际 ${exp.rows} 行`);
  else ok('行数 = 队列长度（5）');
  if (!exp.onRowText || !/示例歌曲 3/.test(exp.onRowText)) bad(`"正在播放"那一行没高亮对（拿到的是 ${exp.onRowText}）`);
  else ok('正在播放那一行（第 3 首）被高亮');
  if (!exp.headText || !/播放队列/.test(exp.headText)) bad('列表顶部没有标题');
  else ok('列表顶部有「播放队列」小标题');
  if (exp.drawerOpen) bad('mini 下 ☰ 仍然拉开了右侧抽屉 —— 应该改成就地展开');
  else ok('mini 下 ☰ 不再拉右侧抽屉（就地展开）');

  const expBounds = bounds();
  say(`  展开态窗口：${expBounds.width}×${expBounds.height} @ (${expBounds.x}, ${expBounds.y})`);
  if (!near(expBounds.width, MINI_W)) bad(`展开态宽度变了（${expBounds.width}）`);
  else if (!near(expBounds.height, MINI_H_EXPANDED)) bad(`展开态高度 ${expBounds.height}，应该是 ${MINI_H_EXPANDED}（容差 ${TOL}）`);
  else ok(`展开态 ≈ ${MINI_W}×${MINI_H_EXPANDED}（实测 ${expBounds.width}×${expBounds.height}）`);
  if (!near(expBounds.y, beforeBounds.y)) bad('展开时顶边动了 —— 应该只往下长');
  else ok('展开时顶边不动，只往下变高');

  /* ================= 5) 收起 / 展开来回切 ================= */
  say('\n[5] ☰ 再来一下：收起列表、回到 132 高：');
  await click('btnQueue');
  await sleep(450);
  const back = await evalJS(`(() => ({
    hasOpen: document.body.classList.contains('mini-open'),
    hasMini: document.body.classList.contains('mini'),
    rows: document.querySelectorAll('#miniList .collect-row').length,
  }))()`);
  const backBounds = bounds();
  if (back.hasOpen) bad('再点一下 ☰ 没有收起列表');
  else ok('再点一下 ☰ 收起了列表');
  if (!back.hasMini) bad('收起列表时把 mini 也退掉了 —— 应该还留在 mini 里');
  else ok('还留在 mini 里（只是列表收起了）');
  if (!near(backBounds.height, MINI_H_COLLAPSED)) bad(`收起后高度 ${backBounds.height}，应该是 ${MINI_H_COLLAPSED}`);
  else ok(`收起后回到 ${MINI_H_COLLAPSED} 高（实测 ${backBounds.height}）`);

  /* ================= 6) 退出 mini ================= */
  say('\n[6] 退出 mini：回到进入前的位置和大小：');
  await click('btnRestoreFull');
  await sleep(600);

  const afterState = await evalJS(`(() => {
    const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : null; };
    return {
      hasMini: document.body.classList.contains('mini'),
      hasOpen: document.body.classList.contains('mini-open'),
      sidebar: disp('.sidebar'), topbar: disp('.topbar'), content: disp('.content'), titlebar: disp('.titlebar'),
      playerVisible: (() => { const r = document.getElementById('player').getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
      miniActions: disp('.mini-actions'),
      listDisp: disp('#miniList'),
    };
  })()`);
  say('  ' + JSON.stringify(afterState));
  const afterBounds = bounds();
  say(`  退出后的窗口：${afterBounds.width}×${afterBounds.height} @ (${afterBounds.x}, ${afterBounds.y})`);

  if (afterState.hasMini) bad('退出 mini 后 body 上还挂着 mini 类');
  else ok('body.mini 已经去掉');
  if (afterState.hasOpen) bad('退出 mini 后还挂着 mini-open');
  else ok('mini-open 也清掉了');
  const allBack = [afterState.sidebar, afterState.topbar, afterState.content, afterState.titlebar].every((d) => d !== 'none');
  if (!allBack) bad(`四块面板没有回来（sidebar=${afterState.sidebar} topbar=${afterState.topbar} content=${afterState.content} titlebar=${afterState.titlebar}）`);
  else ok('四块面板都回来了');
  if (!afterState.playerVisible) bad('播放条不见了');
  else ok('播放条还在');
  if (afterState.miniActions !== 'none') bad('完整模式下 ✕▢ 没收起来 —— 会挤进播放条的三列网格');
  else ok('完整模式下 ✕▢ 已收起（不会挤坏播放条网格）');
  if (afterState.listDisp !== 'none') bad('完整模式下 mini 列表没收起来');
  else ok('完整模式下 mini 列表已收起');

  // 逐数字比对（容差 2px，见 TOL 的说明）—— 位置和大小都得回来
  const same = ['x', 'y', 'width', 'height'].every((k) => near(afterBounds[k], beforeBounds[k]));
  if (!same) {
    bad(`窗口没还原成进入前的样子：进前 ${beforeBounds.x},${beforeBounds.y} ${beforeBounds.width}×${beforeBounds.height} → 退后 ${afterBounds.x},${afterBounds.y} ${afterBounds.width}×${afterBounds.height}`);
  } else {
    ok(`窗口逐数字还原：${afterBounds.x},${afterBounds.y} ${afterBounds.width}×${afterBounds.height}（进前 ${beforeBounds.x},${beforeBounds.y} ${beforeBounds.width}×${beforeBounds.height}）`);
  }

  /* ================= 7) Ctrl+M ================= */
  say('\n[7] Ctrl+M 也能进 / 出：');
  await evalJS(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const km = await evalJS(`document.body.classList.contains('mini')`);
  const kmBounds = bounds();
  if (!km) bad('Ctrl+M 没能进 mini');
  else if (!near(kmBounds.width, MINI_W) || !near(kmBounds.height, MINI_H_COLLAPSED)) bad(`Ctrl+M 进了 mini 但尺寸不对：${kmBounds.width}×${kmBounds.height}`);
  else ok(`Ctrl+M 进 mini，尺寸也对（${kmBounds.width}×${kmBounds.height}）`);

  await evalJS(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const km2 = await evalJS(`document.body.classList.contains('mini')`);
  const km2Bounds = bounds();
  if (km2) bad('再按一次 Ctrl+M 没退出 mini');
  else if (!near(km2Bounds.width, beforeBounds.width) || !near(km2Bounds.height, beforeBounds.height)) bad(`Ctrl+M 退出后尺寸不对：${km2Bounds.width}×${km2Bounds.height}`);
  else ok(`再按一次 Ctrl+M 退出，尺寸也还原了（${km2Bounds.width}×${km2Bounds.height}）`);

  /* ================= 8) 存档 ================= */
  say('\n[8] 存档：settings.window 三个字段：');
  await evalJS(`(() => { window.neko.winMini(true, true); return true; })()`);
  await sleep(400);
  await evalJS(`flushPersistence()`);
  await sleep(300);
  const savedWin = (lastSaved && lastSaved.settings && lastSaved.settings.window) || null;
  say('  ' + JSON.stringify(savedWin));
  if (!savedWin) bad('存档里没有 settings.window');
  else {
    if (savedWin.mini !== true) bad(`settings.window.mini = ${savedWin.mini}，应该是 true`);
    else ok('settings.window.mini = true');
    if (savedWin.miniExpanded !== true) bad(`settings.window.miniExpanded = ${savedWin.miniExpanded}，应该是 true`);
    else ok('settings.window.miniExpanded = true');
    if (!savedWin.fullBounds || savedWin.fullBounds.width !== beforeBounds.width) {
      bad(`settings.window.fullBounds 不对：${JSON.stringify(savedWin.fullBounds)}（期望宽 ${beforeBounds.width}）`);
    } else ok(`settings.window.fullBounds 记下了完整模式的尺寸（${savedWin.fullBounds.width}×${savedWin.fullBounds.height}）`);
  }

  // 退出 mini，别把窗口留在 mini 上影响后面的收尾
  await evalJS(`(() => { window.neko.winMini(false, false); return true; })()`);
  await sleep(400);

  /* ================= 9) 页面报错 ================= */
  say('\n[9] 页面报错：');
  if (errors.length) {
    errors.slice(0, 6).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\nmini 模式实测：全部通过 ✅' : `\nmini 模式实测：${fail} 处失败 ❌`);
  finish(fail === 0 ? 0 : 1);
});
