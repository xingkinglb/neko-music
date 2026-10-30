/* 把 mini 模式的两个状态离屏拍下来（收起 / 展开），用来肉眼确认观感。
   判据在 test-round10.js 里；这一份只出图。开发期脚本，不参与打包。
   产物：.verify/shot-mini-collapsed.png / .verify/shot-mini-expanded.png */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { handleMiniRequest } = require(path.join(ROOT, 'src', 'win-mini.js'));

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

const miniState = { on: false, expanded: false, fullBounds: null };
ipcMain.on('win:mini', (_e, opts) => {
  const st = handleMiniRequest(win, miniState, opts, screen.getPrimaryDisplay().workAreaSize);
  try { win.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    window.__mk = (bvid, title, author, cover) => ({ bvid, cid: 7, title, author, mid: 1, cover: cover || '', duration: 200 });
    const covers = [
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23ff6fa5'/><stop offset='1' stop-color='%23a06bff'/></linearGradient></defs><rect width='80' height='80' fill='url(%23g)'/></svg>",
    ];
    const rows = [
      window.__mk('BV1m0', '誰よりも - KG/菅原纱由理（THE SxPLAY）', '菅原纱由理', covers[0]),
      window.__mk('BV1m1', '夜に駆ける', 'YOASOBI'),
      window.__mk('BV1m2', 'ただ声一つ', 'MIMI'),
      window.__mk('BV1m3', '花に亡霊', 'ヨルシカ'),
      window.__mk('BV1m4', 'だから僕は音楽を辞めた', 'ヨルシカ'),
      window.__mk('BV1m5', 'あの夏が飽和する。', 'amazarashi'),
      window.__mk('BV1m6', '春ひさぎ', 'ヨルシカ'),
    ];
    queue = { tracks: rows, index: 0, name: '发现 · 推荐' };
    const t = rows[0];
    document.getElementById('npTitle').textContent = t.title;
    document.getElementById('npSub').textContent = t.author;
    document.getElementById('npCover').style.backgroundImage = 'url("' + covers[0] + '")';
    document.getElementById('npCover').style.backgroundSize = 'cover';
    renderAll();
    return true;
  })()`);
  await sleep(300);

  // 进 mini（收起态）
  await win.webContents.executeJavaScript(`(() => { document.getElementById('btnMini').click(); return true; })()`);
  await sleep(700);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-mini-collapsed.png'), img.toPNG());

  // v2.12.3：取词中的 mini 条（「词」按钮处于 loading 态）。
  // 这一态曾经把整条挤断行 —— 全局 .loading 的 padding:60px 把 32×30 的按钮撑成 120×120。
  await win.webContents.executeJavaScript(`(() => { lyricState.loading = true; updateLyricBtn(); return true; })()`);
  await sleep(500);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-mini-loading.png'), img.toPNG());
  await win.webContents.executeJavaScript(`(() => { lyricState.loading = false; updateLyricBtn(); return true; })()`);
  await sleep(200);

  // 展开态
  await win.webContents.executeJavaScript(`(() => { document.getElementById('btnQueue').click(); return true; })()`);
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-mini-expanded.png'), img.toPNG());

  console.log('已保存 shot-mini-collapsed.png / shot-mini-expanded.png');
  setTimeout(() => process.exit(0), 150);
});
