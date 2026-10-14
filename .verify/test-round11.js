/* 第十一轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.2.0 —— 托盘 / 任务栏缩略图按钮 / 任务栏右键任务 / 关窗弹窗。

   ★ 这一份的特别之处：**能用真代码的地方一律用真代码**，不写桩 ——
     · 菜单长什么样        → src/app-menus.js 的 buildTrayMenu / buildUserTasks（dump 出来逐项比对）
     · 点 ✕ 该干什么        → src/app-menus.js 的 decideCloseAction
     · 第二个实例的参数      → src/app-menus.js 的 parseSecondInstanceCmd
     · 读存档会不会吃掉新字段 → src/store-migrate.js 的 migrate（真的喂一份存档进去）
     · 界面那一半          → 真的把 index.html 加载起来点它（关窗弹窗 / 设置单选 / 状态回传）

   ⚠️ 沙箱里测不了的（如实标注，不糊弄）：
     托盘图标、任务栏缩略图、JumpList **全是系统（Explorer）画的东西**，
     离屏 Electron 里根本不存在 —— "长什么样"只能真机看。
     这一份能验的是：调用路径正确、菜单模板结构正确、IPC 能通、界面行为正确。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round11-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ================= 真逻辑（全部来自 src/，不是测试里抄一份） ================= */
const menus = require(path.join(ROOT, 'src', 'app-menus.js'));
const storeMigrate = require(path.join(ROOT, 'src', 'store-migrate.js'));
const winMini = require(path.join(ROOT, 'src', 'win-mini.js'));

const {
  decideCloseAction, parseSecondInstanceCmd, buildTrayMenu, buildUserTasks,
  describeMenu, normalizeUiState, DEFAULT_UI_STATE, PLAY_MODES, CMD_WHITELIST,
} = menus;

/* ================= 主进程桩（只桩"系统外设"，不桩业务逻辑） ================= */
let lastSaved = null;
let win = null;

/* 界面推过来的状态（复刻 main.js 里那份） */
let uiState = Object.assign({}, DEFAULT_UI_STATE);
const uiStateLog = [];
ipcMain.on('win:ui-state', (_e, st) => {
  const next = normalizeUiState(st);
  uiState = next;
  uiStateLog.push(next);
});

/* 界面回的关窗选择 */
const closeChoices = [];
ipcMain.on('win:close-choice', (_e, payload) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const action = menus.normalizeCloseAction(p.action) === 'quit' ? 'quit' : 'tray';
  closeChoices.push({ action, remember: !!p.remember });
  if (p.remember) uiState = Object.assign({}, uiState, { closeAction: action });
  if (action === 'tray') hideCalls.push('hide');
});

/* "点 ✕" —— 复刻 main.js 的 close 处理，判断那一步用的是真 decideCloseAction */
const closeLog = [];
const hideCalls = [];
function simulateClose() {
  const action = decideCloseAction({ quitting: !!app.quitting, action: uiState.closeAction });
  closeLog.push(action);
  if (action === 'quit') { closeLog.push('requestMainWindowClose'); return action; }
  if (action === 'tray') { hideCalls.push('hide'); return action; }
  win.webContents.send('win:ask-close');
  closeLog.push('ask-close');
  return action;
}

/* mini：交给 win-mini.js 的真逻辑处理真窗口 */
const miniState = { on: false, expanded: false, fullBounds: null };
ipcMain.on('win:mini', (_e, opts) => {
  const st = winMini.handleMiniRequest(win, miniState, opts, screen.getPrimaryDisplay().workAreaSize);
  try { win.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
});

/* 其它渲染层要用的通道 */
ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || storeMigrate.migrate(null, { bgDir: null }) }));
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
ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:push', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:resize', () => {});

/* ================= 开始 ================= */
app.whenReady().then(async () => {
  /* ============================================================
     [0] 读存档：migrate 只补不删（这是本轮修掉的那个真 bug）
     ============================================================ */
  say('\n[0] 读存档：migrate 不许把新设置项吃掉（v2.1.0 埋下的 bug）：');
  const full = {
    playlists: [], favorites: [], history: [], lastTrack: null,
    settings: {
      theme: 'cyan', volume: 15,
      bg: { file: null, kind: 'image', dim: 0.38, blur: 0, video: { muted: true, loop: true, speed: 1 }, pauseOnBlur: true },
      glass: { blur: 0, frameAlpha: 0.12, mode: 'prebake' },
      autoLyric: true,
      lyricWin: { on: true, x: 300, y: 700, fontSize: 34, opacity: 88, lines: 2, barScale: 130, bgStyle: 'card', locked: true, clickThrough: false },
      playMode: 'shuffle',
      window: { mini: true, miniExpanded: true, fullBounds: { x: 262, y: 152, width: 900, height: 600 } },
      close: { action: 'tray' },
      /* 故意塞一个"以后的版本才会用"的字段：它也必须活下来 */
      futureThing: { a: 1 },
    },
  };
  const out = storeMigrate.migrate(JSON.parse(JSON.stringify(full)), { bgDir: null });
  const kept = ['lyricWin', 'playMode', 'window', 'close', 'futureThing'].filter((k) => out.settings[k] !== undefined);
  say('  活下来的字段：' + kept.join(' / '));
  if (!kept.includes('window')) bad('★ settings.window 被吃掉了 —— mini 模式下次启动会"窗口小、界面却是完整布局"');
  else ok('settings.window 活下来了（mini: ' + out.settings.window.mini + '，展开: ' + out.settings.window.miniExpanded + '）');
  if (!kept.includes('playMode')) bad('★ settings.playMode 被吃掉了 —— 播放模式每次启动都会回到列表循环');
  else ok('settings.playMode 活下来了（' + out.settings.playMode + '）');
  if (!kept.includes('lyricWin')) bad('★ settings.lyricWin 被吃掉了 —— 桌面歌词的位置 / 字号每次启动都会回到默认');
  else ok('settings.lyricWin 活下来了（位置 ' + out.settings.lyricWin.x + ',' + out.settings.lyricWin.y + '，字号 ' + out.settings.lyricWin.fontSize + '）');
  if (!kept.includes('close')) bad('settings.close 被吃掉了');
  else ok('settings.close 活下来了（' + out.settings.close.action + '）');
  if (!kept.includes('futureThing')) bad('★ 不认识的字段被吃掉了 —— 以后每加一个设置项都会踩同一个坑');
  else ok('连"不认识的字段"也原样留着（futureThing）');
  if (out.settings.theme !== 'cyan' || out.settings.volume !== 15) bad('老字段没有正确保留');
  else ok('老字段（theme / volume / bg / glass / autoLyric）一个没丢');
  // 坏存档不能让它崩
  const broken = storeMigrate.migrate({ settings: 'not-an-object' }, { bgDir: null });
  if (!broken.settings || broken.settings.theme !== 'pink' || broken.settings.close.action !== 'ask') bad('坏存档没有被兜住');
  else ok('坏存档（settings 不是对象）也能兜住，不会崩');
  const empty = storeMigrate.migrate(null, { bgDir: null });
  if (empty.settings.close.action !== 'ask') bad('空存档没有拿到 close 的默认值');
  else ok('空存档拿到 close 默认值 ask');

  /* ============================================================
     [1] 第二个实例的参数解析
     ============================================================ */
  say('\n[1] 第二个实例带来的 --cmd= 参数：');
  const cases = [
    [['electron', 'app', '--cmd=prev'], 'prev'],
    [['--cmd=toggle'], 'toggle'],
    [['--cmd=mini'], 'mini'],
    [['--cmd=settings'], 'settings'],
    [['--cmd=show'], 'show'],
    [['--cmd=rm -rf'], null],
    [['--cmd=evil'], null],
    [['--cmd='], null],
    [['--other=prev'], null],
    [[], null],
    [null, null],
  ];
  let pFail = 0;
  for (const [argv, want] of cases) {
    const got = parseSecondInstanceCmd(argv);
    if (got !== want) { bad(`parseSecondInstanceCmd(${JSON.stringify(argv)}) = ${got}，期望 ${want}`); pFail++; }
  }
  if (!pFail) ok(`${cases.length} 组参数都解析正确（白名单外的一律 null）`);
  if (!CMD_WHITELIST.includes('toggle')) bad('白名单里没有 toggle');

  /* ============================================================
     [2] 关窗决策：三种设置 × 是否正在退出
     ============================================================ */
  say('\n[2] 点 ✕ 该干什么（decideCloseAction）：');
  const dcases = [
    [{ quitting: false, action: 'ask' }, 'ask'],
    [{ quitting: false, action: 'quit' }, 'quit'],
    [{ quitting: false, action: 'tray' }, 'tray'],
    [{ quitting: true, action: 'ask' }, 'quit'],
    [{ quitting: true, action: 'tray' }, 'quit'],   // ★ 最关键：正在退出时不能被"缩到托盘"拦住
    [{ quitting: true, action: 'quit' }, 'quit'],
    [{ quitting: false, action: 'garbage' }, 'ask'],
    [{}, 'ask'],
  ];
  let dFail = 0;
  for (const [input, want] of dcases) {
    const got = decideCloseAction(input);
    if (got !== want) { bad(`decideCloseAction(${JSON.stringify(input)}) = ${got}，期望 ${want}`); dFail++; }
  }
  if (!dFail) ok(`${dcases.length} 组决策全对（含"正在退出时一律真退"）`);

  /* ============================================================
     [3] 托盘菜单模板：dump 出来逐项比对
     ============================================================ */
  say('\n[3] 托盘菜单模板（对照 Neo 图5）：');
  const clicks = [];
  const mkHandlers = () => ({
    icon: (name) => 'icon:' + name,
    show: () => clicks.push('show'),
    toggle: () => clicks.push('toggle'),
    prev: () => clicks.push('prev'),
    next: () => clicks.push('next'),
    setMode: (id) => clicks.push('mode:' + id),
    setMini: (on) => clicks.push('mini:' + on),
    lyricOpen: () => clicks.push('lyricOpen'),
    lyricLock: () => clicks.push('lyricLock'),
    settings: () => clicks.push('settings'),
    quit: () => clicks.push('quit'),
  });
  const st1 = normalizeUiState({ playing: true, hasTrack: true, title: '誰よりも - KG/菅原纱由理', playMode: 'shuffle', lyricOn: true, lyricLocked: false, closeAction: 'ask' });
  const tpl = buildTrayMenu(Object.assign({}, st1, { mini: false }), mkHandlers());
  const shape = describeMenu(tpl);
  shape.forEach((it, i) => {
    say(`   ${String(i).padStart(2)} ${it.type.padEnd(10)} ${(it.label === null ? '—' : it.label).slice(0, 34).padEnd(36)}${it.checked !== undefined ? 'checked=' + it.checked : ''}${it.enabled !== undefined ? ' enabled=' + it.enabled : ''}${it.submenu ? '  submenu(' + it.submenu.length + ')' : ''}`);
  });

  const labels = shape.map((i) => i.label);
  for (const need of ['显示主窗口', '誰よりも - KG/菅原纱由理', '暂停', '上一首', '下一首', '播放模式', '窗口模式', '关闭桌面歌词', '锁定桌面歌词', '设置', '退出']) {
    if (!labels.includes(need)) bad(`菜单里没有「${need}」`);
  }
  if (labels.includes('上一首') && labels.includes('下一首') && labels.includes('退出')) ok('图5 那几项都在（歌名 / 播放 / 上一首 / 下一首 / 播放模式 / 窗口模式 / 歌词 / 设置 / 退出）');

  const byLabel = (l) => tpl[labels.indexOf(l)];
  if (byLabel('誰よりも - KG/菅原纱由理').enabled !== false) bad('当前歌名那项不是"只读"');
  else ok('当前歌名是只读项（enabled:false）');
  if (byLabel('暂停').label !== '暂停') bad('正在播放时菜单没显示「暂停」');
  else ok('正在播放 → 菜单显示「暂停」');

  const modeSub = byLabel('播放模式').submenu;
  const modeChecked = modeSub.filter((m) => m.checked).map((m) => m.label);
  if (modeSub.length !== PLAY_MODES.length) bad(`播放模式子菜单有 ${modeSub.length} 项，应该 ${PLAY_MODES.length}`);
  else if (modeChecked.join() !== '随机播放') bad(`播放模式打勾打错了：${modeChecked.join()}（当前是 shuffle）`);
  else ok('播放模式子菜单 4 项，当前 shuffle 那一项打勾（随机播放）');

  const winSub = byLabel('窗口模式').submenu;
  if (!winSub[0].checked || winSub[1].checked) bad('窗口模式子菜单的打勾不对（当前是完整模式）');
  else ok('窗口模式子菜单：完整模式打勾');

  const lockItem = byLabel('锁定桌面歌词');
  if (lockItem.type !== 'checkbox') bad('「锁定桌面歌词」不是 checkbox');
  else if (lockItem.checked !== false) bad('「锁定桌面歌词」的勾不对');
  else ok('「锁定桌面歌词」是 checkbox 且状态正确（未锁）');

  // 点菜单项 → 真的调到对应处理
  clicks.length = 0;
  byLabel('下一首').click();
  byLabel('播放模式').submenu[2].click();
  byLabel('窗口模式').submenu[1].click();
  byLabel('设置').click();
  byLabel('退出').click();
  const wantClicks = ['next', 'mode:shuffle', 'mini:true', 'settings', 'quit'];
  if (clicks.join('|') !== wantClicks.join('|')) bad(`点菜单项调错了：${clicks.join('|')}，期望 ${wantClicks.join('|')}`);
  else ok('点菜单项 → 调到的都是对的（' + clicks.join(' / ') + '）');

  // 状态一变，菜单要跟着变
  const st2 = normalizeUiState({ playing: false, hasTrack: true, title: '夜に駆ける', playMode: 'list', lyricOn: false, lyricLocked: true });
  const shape2 = describeMenu(buildTrayMenu(Object.assign({}, st2, { mini: true }), mkHandlers()));
  const l2 = shape2.map((i) => i.label);
  if (l2[l2.indexOf('播放模式')] !== '播放模式') bad('重建菜单失败');
  else if (!shape2.some((i) => i.label === '播放') ) bad('暂停状态时菜单没显示「播放」');
  else ok('状态变了菜单跟着重建（暂停 → 显示「播放」）');
  if (l2.includes('打开桌面歌词')) ok('歌词项标签跟着开关走（关着 → 「打开桌面歌词」）');
  else bad('歌词项标签没跟着开关走');
  const winSub2 = shape2[shape2.findIndex((i) => i.label === '窗口模式')].submenu;
  if (!winSub2[1].checked) bad('mini 模式下「窗口模式」没有勾到 mini');
  else ok('mini 模式下「窗口模式 ▸」勾到 mini 模式');
  if (shape2.find((i) => i.label === '锁定桌面歌词').enabled !== false) bad('歌词窗没开时「锁定桌面歌词」没有置灰');
  else ok('歌词窗没开时「锁定桌面歌词」置灰');

  /* ============================================================
     [4] 任务栏右键的「任务」（JumpList）
     ============================================================ */
  say('\n[4] 任务栏右键的「任务」：');
  const tasks = buildUserTasks(Object.assign({}, st1, { mini: false }), {
    exePath: 'C:/fake/NekoMusic.exe',
    appPath: null,
    iconPath: (n) => 'C:/fake/menu-' + n + '.png',
  });
  tasks.forEach((t, i) => say(`   ${String(i).padStart(2)} ${(t.title || '—').padEnd(20)} ${t.arguments || ''}`));
  const taskCmds = tasks.filter((t) => t.arguments).map((t) => t.arguments);
  for (const c of ['--cmd=toggle', '--cmd=prev', '--cmd=next', '--cmd=mini', '--cmd=settings']) {
    if (!taskCmds.includes(c)) bad(`JumpList 少了 ${c}`);
  }
  if (taskCmds.length === 5) ok('五个任务都在（播放/暂停 · 上一首 · 下一首 · mini · 设置）');
  if (!tasks.some((t) => t.type === 'separator')) say('  （提示：这一版没有分隔条 —— Windows 支持，但去掉更保险）');
  else ok('中间有分隔条');
  if (!tasks.every((t) => !t.submenu)) ok('没有子菜单（Windows 的 JumpList 本来就不支持）');
  const devTasks = buildUserTasks({}, { exePath: 'C:/fake/electron.exe', appPath: 'C:/proj', iconPath: () => 'i' });
  if (!/"C:\/proj" --cmd=/.test(devTasks[0].arguments)) bad('开发期没有把工程目录带上 —— 点任务会开出空白 Electron');
  else ok('开发期会把工程目录一起带上（' + devTasks[0].arguments + '）');

  /* ============================================================
     下面开始真的把界面加载起来
     ============================================================ */
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
  const click = (id) => evalJS(`(() => { const el = document.getElementById('${id}'); if (!el) return false; el.click(); return true; })()`);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1100);
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    window.__paused = false;
    Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
    window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
    return true;
  })()`);
  await sleep(200);

  /* ============================================================
     [5] 界面 → 主进程的状态回传
     ============================================================ */
  say('\n[5] 界面把状态回传给主进程（托盘菜单靠它画）：');
  await evalJS(`(() => {
    queue = { tracks: [window.__mk('BV1r11a', '誰よりも - KG/菅原纱由理'), window.__mk('BV1r11b', '夜に駆ける')], index: 0, name: '测试' };
    setPlayMode('shuffle', true);
    updatePlayBtn();
    return true;
  })()`);
  await sleep(300);
  say('  最后一次回传：' + JSON.stringify(uiStateLog[uiStateLog.length - 1]));
  const last = uiStateLog[uiStateLog.length - 1];
  if (!last) bad('界面一条状态都没回传 —— 托盘菜单会永远是"还没有在播放"');
  else {
    if (!last.hasTrack || last.title !== '誰よりも - KG/菅原纱由理') bad(`歌名回传不对：${last.title}`);
    else ok('回传了当前歌名（' + last.title + '）');
    if (last.playMode !== 'shuffle') bad(`播放模式回传不对：${last.playMode}`);
    else ok('回传了播放模式（' + last.playMode + '）');
    if (last.playing !== true) bad(`播放状态回传不对：${last.playing}`);
    else ok('回传了播放状态（playing=' + last.playing + '）');
    if (last.closeAction !== 'ask') bad(`关窗行为回传不对：${last.closeAction}`);
    else ok('回传了关窗行为（' + last.closeAction + '）');
  }
  // 去重：状态没变不该再发
  const n1 = uiStateLog.length;
  await evalJS('reportUiState(); reportUiState();');
  await sleep(200);
  if (uiStateLog.length !== n1) bad(`状态没变却又回传了 ${uiStateLog.length - n1} 次 —— 主进程会被反复重建原生菜单`);
  else ok('状态没变就不回传（去重生效）');

  /* ============================================================
     [6] 点 ✕：action='ask' 时应该弹窗
     ============================================================ */
  say('\n[6] 点 ✕（设置成"每次询问"）：');
  app.quitting = false;
  uiState = Object.assign({}, uiState, { closeAction: 'ask' });
  closeLog.length = 0;
  const a1 = simulateClose();
  await sleep(300);
  const dlg = await evalJS(`(() => {
    const m = document.getElementById('closeMask');
    const cs = getComputedStyle(m);
    return {
      action: document.getElementById('closeQuit') ? 'has-buttons' : 'no-buttons',
      show: m.classList.contains('show'),
      opacity: cs.opacity, pointer: cs.pointerEvents,
      quitText: document.getElementById('closeQuit').textContent.replace(/\\s+/g, ' ').trim(),
      trayText: document.getElementById('closeTray').textContent.replace(/\\s+/g, ' ').trim(),
      remember: document.getElementById('closeRemember').checked,
      hasPower: !!document.querySelector('#closeQuit use[href="#i-power"]'),
    };
  })()`);
  say('  ' + JSON.stringify(dlg));
  if (a1 !== 'ask') bad(`decideCloseAction 给的是 ${a1}，应该是 ask`);
  else ok('决策是 ask');
  if (!dlg.show || dlg.opacity === '0' || dlg.pointer === 'none') bad('弹窗没显示出来');
  else ok('弹窗显示出来了（遮罩 show，opacity=' + dlg.opacity + '）');
  if (!/彻底关闭软件/.test(dlg.quitText) || !/停止播放并退出/.test(dlg.quitText)) bad('「彻底关闭软件」那张大按钮的文字不对');
  else ok('第一张：彻底关闭软件 + 一行小字说明后果');
  if (!/缩小到任务栏/.test(dlg.trayText) || !/继续在后台播放/.test(dlg.trayText)) bad('「缩小到任务栏」那张大按钮的文字不对');
  else ok('第二张：缩小到任务栏 + 一行小字说明后果');
  if (!dlg.hasPower) bad('「彻底关闭」没用电源键图标');
  else ok('「彻底关闭」用的是电源键图标');
  if (dlg.remember) bad('弹窗刚出来就勾着「设为默认值」');
  else ok('弹窗刚出来时「设为默认值」是没勾的');

  /* ============================================================
     [7] 弹窗里选「缩小到任务栏」
     ============================================================ */
  say('\n[7] 选「缩小到任务栏」：');
  await click('closeTray');
  await sleep(400);
  const dlgGone = await evalJS(`document.getElementById('closeMask').classList.contains('show')`);
  if (dlgGone) bad('选完之后弹窗没收起来');
  else ok('弹窗收起来了');
  if (closeChoices.length !== 1) bad(`主进程收到的关窗选择有 ${closeChoices.length} 条，应该 1 条`);
  else if (closeChoices[0].action !== 'tray' || closeChoices[0].remember !== false) bad('收到的选择不对：' + JSON.stringify(closeChoices[0]));
  else ok('主进程收到 { action: "tray", remember: false }');
  if (hideCalls.length !== 1) bad('主进程没有把窗口藏起来');
  else ok('主进程把窗口藏起来了（hide，不是 close）');

  /* ============================================================
     [8] 勾「设为默认值」再选一次 → 存档要跟上
     ============================================================ */
  say('\n[8] 勾上「设为默认值」再选一次（真实流程：再点一次 ✕ 把弹窗叫出来）：');
  closeChoices.length = 0;
  hideCalls.length = 0;
  const a8 = simulateClose();          // ← 再点一次 ✕
  await sleep(300);
  const reShown = await evalJS(`document.getElementById('closeMask').classList.contains('show')`);
  const reChecked = await evalJS(`document.getElementById('closeRemember').checked`);
  if (a8 !== 'ask' || !reShown) bad(`再点一次 ✕ 没有把弹窗叫回来（action=${a8}，show=${reShown}）`);
  else ok('再点一次 ✕ 弹窗又出来了');
  if (reChecked) bad('第二次弹出时「设为默认值」还勾着 —— 应该是清空状态');
  else ok('第二次弹出时「设为默认值」是清的');
  await evalJS(`(() => { document.getElementById('closeRemember').checked = true; return true; })()`);
  await click('closeTray');
  await sleep(500);
  if (closeChoices.length !== 1 || closeChoices[0].remember !== true) bad('主进程收到的 remember 不是 true：' + JSON.stringify(closeChoices[0]));
  else ok('主进程收到 { action: "tray", remember: true }');
  await evalJS('flushPersistence()');
  await sleep(300);
  const savedClose = lastSaved && lastSaved.settings && lastSaved.settings.close;
  say('  存档里的 settings.close = ' + JSON.stringify(savedClose));
  if (!savedClose || savedClose.action !== 'tray') bad('存档没写成 tray —— 勾了"设为默认"却没记住');
  else ok('存档写成 { action: "tray" }（下次点 ✕ 不再问）');
  if (uiState.closeAction !== 'tray') bad('界面回传的 closeAction 没跟上');
  else ok('界面回传的 closeAction 也跟着变成 tray');

  /* ============================================================
     [9] 设成 tray 之后再点 ✕ → 直接藏起来，不再弹窗
     ============================================================ */
  say('\n[9] 设成 tray 之后再点 ✕：');
  closeLog.length = 0;
  hideCalls.length = 0;
  const a2 = simulateClose();
  await sleep(250);
  const shown2 = await evalJS(`document.getElementById('closeMask').classList.contains('show')`);
  if (a2 !== 'tray') bad(`决策是 ${a2}，应该是 tray`);
  else ok('决策是 tray（没再弹窗）');
  if (shown2) bad('设成 tray 之后还弹窗了');
  else ok('没有弹窗');
  if (hideCalls.length !== 1) bad('没有隐藏窗口');
  else ok('直接隐藏了窗口');

  /* ============================================================
     [10] "正在退出"时一律真退（托盘里的「退出」不能被拦住）
     ============================================================ */
  say('\n[10] 正在退出时（托盘「退出」/ Ctrl+Q / 关机）：');
  closeLog.length = 0;
  hideCalls.length = 0;
  app.quitting = true;   // main.js 里是 before-quit 设的
  const a3 = simulateClose();
  app.quitting = false;
  if (a3 !== 'quit') bad(`正在退出时决策是 ${a3}，应该是 quit —— 用户点了「退出」却只缩小了`);
  else ok('正在退出 → 决策是 quit（即使设置里选的是"缩小到任务栏"）');
  if (hideCalls.length) bad('正在退出时居然隐藏了窗口');
  else ok('没有去隐藏窗口');
  if (!closeLog.includes('requestMainWindowClose')) bad('真退出没有走存盘握手 —— 会丢掉最后一次改动');
  else ok('走了存盘握手（requestMainWindowClose）');

  /* ============================================================
     [11] 设置面板「窗口」页：三选一和存档同步
     ============================================================ */
  say('\n[11] 设置面板「窗口」页：');
  await evalJS(`(() => { document.getElementById('btnSettings').click(); return true; })()`);
  await sleep(350);
  const paneInfo = await evalJS(`(() => {
    const tab = document.querySelector('#modalTabs .tab[data-tab="window"]');
    if (tab) tab.click();
    const pane = document.querySelector('.pane[data-pane="window"]');
    const cs = pane ? getComputedStyle(pane) : null;
    const checked = ['radCloseAsk','radCloseQuit','radCloseTray'].filter((id) => document.getElementById(id) && document.getElementById(id).checked);
    return {
      hasTab: !!tab,
      paneActive: cs ? cs.display !== 'none' : false,
      checked,
      label: (pane ? pane.textContent : '').replace(/\\s+/g, ' ').slice(0, 90),
    };
  })()`);
  say('  ' + JSON.stringify(paneInfo));
  if (!paneInfo.hasTab) bad('设置面板里没有「窗口」标签页');
  else ok('设置面板有「窗口」标签页');
  if (!paneInfo.paneActive) bad('「窗口」页没有显示出来');
  else ok('「窗口」页显示出来了');
  if (paneInfo.checked.join() !== 'radCloseTray') bad(`单选框勾的是 ${paneInfo.checked.join()}，应该是 radCloseTray（存档里是 tray）`);
  else ok('单选框跟着存档走（存档 tray → 勾中「缩小到任务栏」）');

  // 改成"每次询问"，看存档和回传跟不跟
  await evalJS(`(() => { const el = document.getElementById('radCloseAsk'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalJS('flushPersistence()');
  await sleep(250);
  const savedAsk = lastSaved && lastSaved.settings && lastSaved.settings.close;
  if (!savedAsk || savedAsk.action !== 'ask') bad('在设置里改成"每次询问"没存进去：' + JSON.stringify(savedAsk));
  else ok('在设置里改成「每次询问」→ 存档跟着变（' + savedAsk.action + '）');
  if (uiState.closeAction !== 'ask') bad('改成 ask 之后没回传给主进程');
  else ok('改成 ask 之后回传给了主进程（下次点 ✕ 会弹窗）');

  // 关掉设置面板
  await evalJS(`(() => { document.getElementById('closeCancel') && null; document.getElementById('btnCloseModal').click(); return true; })()`);
  await sleep(250);

  /* ============================================================
     [12] 托盘 / 任务栏发来的命令（界面这一半）
     ============================================================ */
  say('\n[12] 托盘 / 任务栏发来的命令：');
  const before = await evalJS(`({ mode: playMode, paused: audio.paused })`);
  await evalJS(`(() => {
    window.__cmds = [];
    // 直接调用界面里那个处理函数（主进程发 win:cmd 时走的就是它）
    handleWinCmd('next');
    handleWinCmd('mode:order');
    handleWinCmd('lyric-lock');
    handleWinCmd('show');
    handleWinCmd('不认识的命令');
    return true;
  })()`);
  await sleep(400);
  const after = await evalJS(`({
    mode: playMode,
    index: queue.index,
    locked: !!(DB.settings.lyricWin && DB.settings.lyricWin.locked),
    title: (document.getElementById('npTitle') || {}).textContent || '',
  })`);
  say('  前：' + JSON.stringify(before) + '  后：' + JSON.stringify(after));
  if (after.mode !== 'order') bad('mode:order 没生效，当前是 ' + after.mode);
  else ok('「播放模式 ▸ 顺序播放」生效（playMode=order）');
  if (after.index !== 1) bad(`next 没生效（队列下标 ${after.index}，应该是 1）`);
  else ok('「下一首」生效（队列走到第 2 首：' + after.title + '）');
  if (!after.locked) bad('lyric-lock 没生效');
  else ok('「锁定桌面歌词」生效（locked=true）');
  if (uiState.playMode !== 'order') bad('换了模式之后没回传给主进程');
  else ok('换了模式之后回传给了主进程（托盘菜单的打勾会跟着动）');

  /* ============================================================
     [13] mini 下：界面把封面那块量给主进程（缩略图要裁它）
     ============================================================ */
  say('\n[13] mini 下把封面那块的位置交给主进程（任务栏缩略图裁它）：');
  await evalJS(`(() => { document.getElementById('btnMini').click(); return true; })()`);
  await sleep(600);
  const miniInfo = await evalJS(`(() => {
    const c = document.getElementById('npCover').getBoundingClientRect();
    return {
      rect: { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(c.height) },
      hasMini: document.body.classList.contains('mini'),
      inner: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`);
  const reported = uiState.coverRect;
  say('  界面实测封面：' + JSON.stringify(miniInfo.rect) + '；回传给主进程的：' + JSON.stringify(reported));
  if (!miniInfo.hasMini) bad('没进 mini');
  else ok('进了 mini（窗口内视口 ' + miniInfo.inner.w + '×' + miniInfo.inner.h + '）');
  if (!reported) bad('mini 下没有把封面位置回传给主进程 —— 任务栏缩略图裁不了');
  else {
    const same = ['x', 'y', 'width', 'height'].every((k) => Math.abs(reported[k] - miniInfo.rect[k]) <= 1);
    if (!same) bad(`回传的封面位置和实测对不上：${JSON.stringify(reported)} vs ${JSON.stringify(miniInfo.rect)}`);
    else ok(`回传的封面位置 = 实测（${reported.width}×${reported.height} @ ${reported.x},${reported.y}）`);
    if (!(reported.y >= 0 && reported.y + reported.height <= miniInfo.inner.h)) bad('封面位置跑到窗口外面去了');
    else ok('封面位置落在小窗可视区域内（裁剪出来不会是空白）');
  }
  // 回完整模式：coverRect 必须清掉，主进程才会复位裁剪区域
  await evalJS(`(() => { document.getElementById('btnRestoreFull').click(); return true; })()`);
  await sleep(600);
  if (uiState.coverRect !== null) bad('回到完整模式后 coverRect 没清掉 —— 缩略图会裁一块莫名其妙的区域');
  else ok('回到完整模式后 coverRect 变回 null（主进程会复位裁剪）');

  /* ============================================================
     [14] 页面报错
     ============================================================ */
  say('\n[14] 页面报错：');
  if (errors.length) {
    errors.slice(0, 8).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\n托盘 / 任务栏 / 关窗弹窗实测：全部通过 ✅' : `\n托盘 / 任务栏 / 关窗弹窗实测：${fail} 处失败 ❌`);
  finish(fail === 0 ? 0 : 1);
});
