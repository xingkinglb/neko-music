/* 本地存档端到端实测（真实界面 + 真实 preload）。
   为什么必须要这个脚本：
     主进程 store:load / store:save 统一返回 {ok, data} 外壳。
     界面若直接调 window.neko.loadData() 而不走 api() 解包，
     DB 就会变成那个外壳对象 —— DB.settings 是 undefined，
     于是每次启动"读不到存档、全变默认"，表现为设置/歌单从没保存过。
   本脚本就盯死这条链路：改 → 存 → 重载 → 读回，三道都要对上。

   跑法（沙箱里必须清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会当 Node 跑）：
     env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .verify/test-persist.js
   开发期脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const W = 1180, H = 760;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPORT = path.join(__dirname, 'test-persist-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 150); };

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const DATA = path.join(__dirname, 'tmp-persist-data.json');
const DEFAULT = {
  playlists: [], favorites: [], history: [], lastTrack: null,
  settings: { theme: 'pink', volume: 80, bg: { file: null, dim: 0.55, blur: 0 }, glass: { blur: 18, alpha: 0.55 }, autoLyric: false },
};

/* ── 主进程 mock：信封契约与 src/main.js 的 handle() 完全一致（{ok, data}） ── */
ipcMain.handle('store:load', () => ({
  ok: true,
  data: fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : DEFAULT,
}));
ipcMain.handle('store:save', (_e, data) => {
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, data: true };
});
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));

app.whenReady().then(async () => {
  try { fs.unlinkSync(DATA); } catch (_) {}

  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);

  /* ── 1) 启动后 DB 必须是"解包后的存档"，不是 {ok,data} 外壳 ── */
  const shape = await win.webContents.executeJavaScript(`({
    isEnvelope: !!(DB && DB.ok === true && 'data' in DB),
    hasSettings: !!(DB && DB.settings && typeof DB.settings === 'object'),
    playlistsIsArray: Array.isArray(DB && DB.playlists),
    theme: (DB && DB.settings) ? DB.settings.theme : null,
  })`);
  say('启动后 DB 形状：' + JSON.stringify(shape));
  if (shape.isEnvelope) {
    bad('DB 是 {ok,data} 外壳 —— loadData 没走 api() 解包，存档永远读不出来（设置会全变默认）');
  } else if (!shape.hasSettings || !shape.playlistsIsArray) {
    bad('DB 缺少 settings 或 playlists 不是数组 —— 存档结构不对');
  } else {
    ok('启动后 DB 是解包后的存档（有 settings、playlists 为数组）');
  }
  if (shape.theme === 'pink') ok('全新存档读到默认主题 pink（首次运行正常）');
  else bad('首次运行的默认主题不是 pink，实际：' + shape.theme);

  /* ── 2) 改设置 + 建歌单 → persist() → 落盘 ── */
  const saved = await win.webContents.executeJavaScript(`(async () => {
    DB.settings.theme = 'cyan';
    DB.settings.volume = 33;
    DB.playlists = [{ id: 'pl-test', name: '测试歌单', tracks: [{ bvid: 'BV1test', title: '一首歌', author: 'UP' }] }];
    return await persist();
  })()`);
  await sleep(400);
  if (saved === true) ok('persist() 返回成功');
  else bad('persist() 返回失败（保存链路有问题）');

  const onDisk = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : null;
  if (!onDisk) {
    bad('硬盘上没有写出存档文件');
  } else if (onDisk.ok === true && 'data' in onDisk) {
    bad('写进硬盘的是 {ok,data} 外壳（说明持久层把外壳当数据存了）');
  } else if (onDisk.settings && onDisk.settings.theme === 'cyan' && onDisk.settings.volume === 33 && Array.isArray(onDisk.playlists) && onDisk.playlists.length === 1) {
    ok('硬盘存档内容正确：主题 cyan、音量 33、歌单 1 个');
  } else {
    bad('硬盘存档内容不对：' + JSON.stringify(onDisk).slice(0, 200));
  }

  /* ── 3) 重载页面（等价于关掉软件再打开）→ 必须读回刚才的改动 ── */
  await win.webContents.reload();
  await sleep(1400);
  const after = await win.webContents.executeJavaScript(`({
    theme: (DB && DB.settings) ? DB.settings.theme : null,
    volume: (DB && DB.settings) ? DB.settings.volume : null,
    playlistCount: Array.isArray(DB && DB.playlists) ? DB.playlists.length : -1,
    playlistName: (DB && DB.playlists && DB.playlists[0]) ? DB.playlists[0].name : null,
    isEnvelope: !!(DB && DB.ok === true && 'data' in DB),
  })`);
  say('重载后读回：' + JSON.stringify(after));
  if (after.isEnvelope) bad('重载后 DB 又变成外壳了');
  else if (after.theme === 'cyan' && after.volume === 33 && after.playlistCount === 1 && after.playlistName === '测试歌单') {
    ok('重载后设置与歌单完整读回（设置不再被重置）');
  } else {
    bad('重载后没有读回改动 —— 设置被重置了');
  }

  if (errors.length) say('页面报错：' + errors.slice(0, 5).join(' | '));

  say(fail === 0 ? '\n存档端到端实测全部通过' : `\n发现 ${fail} 处问题`);
  try { fs.unlinkSync(DATA); } catch (_) {}
  finish(fail === 0 ? 0 : 1);
});
