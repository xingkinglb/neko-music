/* 把 v2.2.0 新增的两块界面离屏拍下来，用来肉眼确认观感。
   判据在 test-round11.js 里；这一份只出图。开发期脚本，不参与打包。
   产物：.verify/shot-close-dialog.png / .verify/shot-settings-window.png */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let lastSaved = null;
ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, d) => { lastSaved = d; return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({ ok: true, data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [], season: null } }));
ipcMain.on('win-close', () => {});
ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('win:ui-state', () => {});
ipcMain.on('win:close-choice', () => {});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);

  await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    window.__mk = (bvid, title, author, cover) => ({ bvid, cid: 7, title, author, mid: 1, cover: cover || '', duration: 200 });
    const cover = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23ff6fa5'/><stop offset='1' stop-color='%23a06bff'/></linearGradient></defs><rect width='80' height='80' fill='url(%23g)'/></svg>";
    const rows = [
      window.__mk('BV1c0', '誰よりも - KG/菅原纱由理（THE SxPLAY）', '菅原纱由理', cover),
      window.__mk('BV1c1', '夜に駆ける', 'YOASOBI'),
      window.__mk('BV1c2', 'ただ声一つ', 'MIMI'),
    ];
    queue = { tracks: rows, index: 0, name: '发现 · 推荐' };
    const t = rows[0];
    document.getElementById('npTitle').textContent = t.title;
    document.getElementById('npSub').textContent = t.author;
    document.getElementById('npCover').style.backgroundImage = 'url("' + cover + '")';
    document.getElementById('npCover').style.backgroundSize = 'cover';
    renderAll();
    return true;
  })()`);
  await sleep(400);

  // ① 关闭方式弹窗
  await win.webContents.executeJavaScript(`(() => { showCloseDialog(); return true; })()`);
  await sleep(600);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-close-dialog.png'), img.toPNG());

  // ② 设置面板「窗口」页
  await win.webContents.executeJavaScript(`(() => {
    hideCloseDialog();
    document.getElementById('btnSettings').click();
    const tab = document.querySelector('#modalTabs .tab[data-tab="window"]');
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-settings-window.png'), img.toPNG());

  console.log('已保存 shot-close-dialog.png / shot-settings-window.png');
  setTimeout(() => process.exit(0), 150);
});
