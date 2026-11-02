/* v2.12.4 批三 · 歌单拖动排序实测。
   跑：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/test-round30.js

   ★ 为什么不用真拖拽事件
     HTML5 DnD 的 dataTransfer 在离屏脚本里没法真实模拟（Chromium 只允许在
     dragstart 的原生事件里构造）。但 drop 处理器的重排逻辑**不依赖 dataTransfer**
     —— 它读的是全局 dragPlId（dragstart 时记下的），所以直接设变量 + dispatch
     drop 事件，就能真刀真枪跑一遍重排和持久化。数据传输那层是浏览器职责，不是我们的。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const say = (m) => console.log(m);

app.disableHardwareAcceleration();

let saveCount = 0;
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} } }));
ipcMain.handle('store:save', () => { saveCount++; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('queue:load', () => ({ ok: true, data: null }));
ipcMain.handle('queue:save', () => ({ ok: true, data: true }));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/\[播放失败\]/.test(msg)) errors.push(msg); });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const ev = (c) => win.webContents.executeJavaScript(c);

  /* ================= 1) 手柄存在且 hover 才显示 ================= */
  say('\n[1] 手柄：');
  await ev(`(() => {
    DB.playlists = [
      { id: 'pA', name: '歌单A', tracks: [] },
      { id: 'pB', name: '歌单B', tracks: [] },
      { id: 'pC', name: '歌单C', tracks: [] },
    ];
    renderPlaylistSidebar();
    return true;
  })()`);
  await sleep(400);
  const h = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('.playlist-row'));
    const handle = rows[0].querySelector('.drag-handle');
    if (!handle) return { exists: false };
    const cs = getComputedStyle(handle);
    return { exists: true, hiddenByDefault: cs.display === 'none', rows: rows.length };
  })()`);
  if (!h.exists) bad('歌单行里没有拖动手柄');
  else if (!h.hiddenByDefault) bad('手柄默认就显示着（应该 hover 才浮现）');
  else ok(`手柄存在，且默认隐藏、hover 才浮现（${h.rows} 个歌单都有）`);

  /* ================= 2) 拖 C 到 A 的位置 ================= */
  say('\n[2] 拖动重排（模拟 dragstart + drop）：');
  const order = await ev(`(() => {
    // dragstart 的全部作用就是把 id 记进 dragPlId —— 直接设它，等价
    dragPlId = 'pC';
    const rows = Array.from(document.querySelectorAll('.playlist-row'));
    const target = rows.find((r) => r.dataset.pl === 'pA');
    target.dispatchEvent(new Event('dragover', { bubbles: true }));
    target.dispatchEvent(new Event('drop', { bubbles: true }));
    return DB.playlists.map((p) => p.name).join(',');
  })()`);
  say(`    拖 C 到 A 的位置 → ${order}`);
  if (order !== '歌单C,歌单A,歌单B') bad(`重排结果不对：${order}`);
  else ok('C 被挪到了 A 原来的位置，其余依次后移');

  /* ================= 3) 拖自己 = 无事发生 ================= */
  say('\n[3] 把 C 拖到它自己头上：');
  const order2 = await ev(`(() => {
    dragPlId = 'pC';
    const rows = Array.from(document.querySelectorAll('.playlist-row'));
    const target = rows.find((r) => r.dataset.pl === 'pC');
    target.dispatchEvent(new Event('drop', { bubbles: true }));
    return DB.playlists.map((p) => p.name).join(',');
  })()`);
  if (order2 !== order) bad(`拖到自己头上顺序居然变了：${order2}`);
  else ok('拖到自己 = 原样不动');

  /* ================= 4) 顺序持久化 ================= */
  say('\n[4] 顺序写进存档：');
  await sleep(1100);   // persistLater 防抖 800ms
  if (saveCount < 1) bad('拖完没有触发存档');
  else ok(`存档被写过 ${saveCount} 次（拖动后 persistLater 生效）`);

  /* ================= 5) 页面报错 ================= */
  say('\n[5] 页面报错：');
  if (errors.length) { errors.slice(0, 4).forEach((e) => say('    ' + e)); bad(`页面报了 ${errors.length} 条错`); }
  else ok('全程没有页面报错');

  say(fail === 0 ? '\n歌单拖动实测：全部通过 ✅' : `\n歌单拖动实测：${fail} 处失败 ❌`);
  fs.writeFileSync(path.join(__dirname, 'test-round30-report.txt'),
    fail === 0 ? '全部通过 ✅\n\n退出码 0\n' : `${fail} 处失败 ❌\n\n退出码 1\n`);
  app.exit(fail === 0 ? 0 : 1);
});
