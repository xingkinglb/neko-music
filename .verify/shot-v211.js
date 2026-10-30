/* 一次性截图：v2.11.0 两项改动，人眼验收用（不做断言）。
   跑完写到 .verify/ 下：
     shot-v211-parsed.png   解析页新头部（工具条在上、标题在下）
     shot-v211-whole.png    歌单里那一行「合集 18」+「共 18 首」
     shot-v211-confirm.png  选中合集行点下载时的确认弹窗
   开发期脚本，不进打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG_TITLE = '【真栗】《如果的事》如果我已经不能控制每天想栗亿次那就让我想你想到失眠到天亮好了';
const EPS = Array.from({ length: 18 }, (_, i) => ({
  bvid: 'BVep' + i, cid: 9000 + i, page: 1,
  title: '第 ' + (i + 1) + ' 集：如果的事', duration: 200 + i, cover: '',
}));
const INFO = {
  bvid: 'BVseason', aid: 1, title: LONG_TITLE, cover: '',
  owner: { mid: 7, name: '听雨GGMU' }, duration: 4000,
  pages: [{ bvid: 'BVseason', cid: 1, page: 1, title: LONG_TITLE, duration: 4000 }],
  season: { id: 1, title: '温柔栗音', cover: '', episodes: EPS },
};

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'x', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BVseason' } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: INFO }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
['win-min', 'win-max', 'win-close', 'win:close-ready', 'win:fullscreen', 'win:mini'].forEach((c) => ipcMain.on(c, () => {}));
['lyric:open', 'lyric:close', 'lyric:through', 'lyric:style', 'lyric:line', 'lyric:move', 'ui-state'].forEach((c) => ipcMain.on(c, () => {}));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);
  const ev = (code) => win.webContents.executeJavaScript(code);

  const shoot = async (name) => {
    await sleep(900);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
    console.log('  → ' + name + '  ' + img.getSize().width + '×' + img.getSize().height);
  };

  await ev(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
    DB.settings.download = { dir: 'C:\\\\fake-dl' };
    DB.playlists = [{ id: 'p1', name: '我的歌单', tracks: [] }];
    return true;
  })()`);

  /* 1) 解析页新头部 */
  await ev(`doParseLink('BVseason')`);
  await sleep(800);
  await ev(`(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()`);
  await shoot('shot-v211-parsed.png');

  /* 2) 整个合集加入 → 歌单里 1 行 */
  await ev(`document.getElementById('btnAddParsed').click(); true`);
  await sleep(400);
  await ev(`(() => { const r = document.querySelector('.pl-row[data-pl="p1"]'); if (r) r.click(); return true; })()`);
  await sleep(700);
  await ev(`(() => { selPick = null; renderPlaylist('p1'); return true; })()`);
  await sleep(400);
  await ev(`(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()`);
  await shoot('shot-v211-whole.png');

  /* 3) 选中合集行点下载 → 确认弹窗 */
  await ev(`document.getElementById('btnSelectPl').click(); true`);
  await sleep(350);
  await ev(`document.getElementById('btnSelPickAll').click(); true`);
  await sleep(350);
  await ev(`document.getElementById('btnSelDownload').click(); true`);
  await sleep(700);
  await ev(`(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()`);
  await shoot('shot-v211-confirm.png');

  console.log('截图完成');
  setTimeout(() => process.exit(0), 200);
}).catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); setTimeout(() => process.exit(2), 200); });
