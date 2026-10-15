/* 一次性截图：本地歌曲页的"左栏文件夹 + 右栏批量选择"（v2.8.0 修订）。
   不是为了断言，是为了**人眼验收**布局 —— 跑完把图写到 .verify/ 下。
   开发期脚本，不进打包。 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT_A = 'D:\\Music\\专辑A';
const ROOT_B = 'E:\\歌单B';
const DL_DIR = 'C:\\Users\\Neko\\Music\\NekoMusic';

const SEED = [
  { path: DL_DIR + '\\下好的1.m4a', src: 'download', bvid: 'BV1aaa', key: 'BV1aaa:1' },
  { path: DL_DIR + '\\下好的2.m4a', src: 'download', bvid: 'BV1bbb', key: 'BV1bbb:2' },
  { path: 'D:\\Music\\专辑A\\第一首.m4a', folderRoot: ROOT_A, src: 'folder' },
  { path: 'D:\\Music\\专辑A\\第二首.mp3', folderRoot: ROOT_A, src: 'folder' },
  { path: 'D:\\Music\\专辑A\\子目录\\第三首.flac', folderRoot: ROOT_A, src: 'folder' },
  { path: 'E:\\歌单B\\甲.mp3', folderRoot: ROOT_B, src: 'folder' },
  { path: 'E:\\歌单B\\乙.m4a', folderRoot: ROOT_B, src: 'folder' },
  { path: 'D:\\散装\\单曲导入的.mp3', src: 'file' },
];

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'x', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: { bvid: 'BV1', aid: 1, title: 'x', cover: '', owner: { mid: 1, name: 'UP' }, duration: 200, pages: [], season: null } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
['win-min', 'win-max', 'win-close', 'win:close-ready', 'win:fullscreen', 'win:mini'].forEach((c) => ipcMain.on(c, () => {}));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const evalJS = (c) => win.webContents.executeJavaScript(c);
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  await evalJS(`(() => {
    DB.local = ${JSON.stringify(SEED)}.map((e, i) => Object.assign({
      id: 'id' + i, title: (e.path.split(/[\\\\/]/).pop() || '').replace(/\\.[^.]+$/, ''),
      author: '', cover: '', duration: 0, size: 4211000, key: '', bvid: null, cid: null, addedAt: i,
    }, e));
    currentView = 'local';
    localFilter = 'all';
    renderAll();
    return true;
  })()`);
  await sleep(400);

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
    console.log('shot →', name);
  };

  await shot('shot-local-folders.png');

  // 进入批量选择态截第二张
  await evalJS(`(() => { document.getElementById('btnLocalPick').click(); return true; })()`);
  await sleep(300);
  await evalJS(`(() => { const r = document.querySelectorAll('#content .track'); if (r[0]) r[0].click(); if (r[2]) r[2].click(); return true; })()`);
  await sleep(300);
  await shot('shot-local-pick.png');

  setTimeout(() => process.exit(0), 150);
});
