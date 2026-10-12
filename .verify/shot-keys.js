/* 把 v2.3.0 新增的「快捷键」页离屏拍下来，用来肉眼确认观感。
   判据在 test-keys.js 里；这一份只出图。开发期脚本，不参与打包。
   产物：.verify/shot-keys-page.png / shot-keys-recording.png / shot-keys-clash.png */
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

let lastSaved = null;
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, d) => { lastSaved = d; return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('cookie:set', () => ({ ok: true, data: true }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({ ok: true, data: { bvid, aid: 1, title: '歌', cover: '', owner: { mid: 1, name: 'UP' }, duration: 200, pages: [], season: null } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.on('win-close', () => {});
ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('win:ui-state', () => {});
ipcMain.on('win:close-choice', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:push', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const evalJS = (c) => win.webContents.executeJavaScript(c);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);

  /* ① 快捷键页（先改一条，好让 ↺ 有"亮着"的样子） */
  await evalJS(`(() => {
    DB.settings.keys = { togglePlay: 'Ctrl+p' };
    document.getElementById('btnSettings').click();
    document.querySelector('#modalTabs .tab[data-tab="keys"]').click();
    return true;
  })()`);
  await sleep(700);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-keys-page.png'), img.toPNG());

  /* ② 录制中（键位框呼吸高亮的样子） */
  await evalJS(`(() => {
    document.querySelector('[data-key-box="togglePlay"]').click();
    return true;
  })()`);
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-keys-recording.png'), img.toPNG());

  /* ③ 撞车提示（录制「播放/暂停」时按 Ctrl+D —— 那是「整页歌词」在用的键） */
  await evalJS(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(600);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-keys-clash.png'), img.toPNG());

  console.log('已保存 shot-keys-page.png / shot-keys-recording.png / shot-keys-clash.png');
  setTimeout(() => process.exit(0), 150);
});
