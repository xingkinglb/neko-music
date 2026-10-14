/* 探针 2：三个带「批量下载」的界面，各自点下去到底是"进勾选模式"还是"直接排队下载"？
     · 我喜欢 / 歌单工具条 → 预期：进勾选模式
     · 详情页（点开一个视频，列出它的全部分P）→ ?
     · 选集面板（右侧滑出，标题「选集」）→ ?
   顺便量一下下载管理页里有哪些操作按钮（问题 4：缺"全部删除"）。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-dlviews-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => fs.appendFileSync(OUT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAVS = Array.from({ length: 5 }, (_, i) => ({
  bvid: 'BV1fav' + String(i + 1).padStart(4, '0'), cid: 100 + i, page: 1,
  title: '收藏歌 ' + (i + 1), author: '歌手' + (i + 1), cover: '', duration: 200 + i,
}));
const PAGES = Array.from({ length: 6 }, (_, i) => ({
  bvid: 'BV1multi0001', cid: 500 + i, page: i + 1,
  title: '第' + (i + 1) + '首', duration: 180 + i,
}));

ipcMain.handle('store:load', () => ({
  ok: true,
  data: {
    playlists: [{ id: 'pl-a', name: '我的歌单', tracks: FAVS.slice(0, 3) }],
    favorites: FAVS, history: [], settings: {}, lastTrack: null,
  },
}));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '无', reason: 'none' }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '多分P视频', cover: '', owner: { mid: 1, name: 'UP' }, duration: 1200, pages: PAGES, season: null },
}));
require('./stub-download-ipc.js')({ tasks: [], dir: 'C:\\测试\\下载' });
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
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);
  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(400);
  };
  const centerOf = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);
  const state = () => evalJS(`({
    picking: !!document.querySelector('#btnDlPickDo'),
    dlPick: !!dlPick,
    addCalls: window.__addCalls || 0,
  })`);

  // 记一下 download:add 被调了几次、带了几首
  await evalJS(`(() => {
    window.__addCalls = 0;
    const orig = window.neko.downloadAdd;
    if (orig) window.neko.downloadAdd = function (list) { window.__addCalls = (window.__addCalls || 0) + (list ? list.length : 0); return orig.apply(this, arguments); };
    return true;
  })()`);

  /* ---------- A) 歌单视图 ---------- */
  say('=== A) 歌单视图（侧栏点开一个歌单）===');
  await evalJS(`(() => { currentView = 'playlist:pl-a'; dlPick = null; renderAll(); return true; })()`);
  await sleep(300);
  say('  按钮文案 = ' + JSON.stringify(await evalJS(`(document.querySelector('#btnDownloadPl')||{}).textContent`)));
  let b = await centerOf('#btnDownloadPl');
  say('  addCalls 前 = ' + (await evalJS('window.__addCalls')));
  await clickAt(b.x, b.y);
  say('  点后 = ' + JSON.stringify(await state()));
  say('  → ' + ((await evalJS('window.__addCalls')) === 0 ? '进了勾选模式（没直接下载）' : '直接下载了 ' + (await evalJS('window.__addCalls')) + ' 首'));

  /* ---------- B) 详情页 ---------- */
  say('\n=== B) 详情页（解析一个多分P视频）===');
  await evalJS(`(() => {
    dlPick = null;
    window.__addCalls = 0;
    currentView = 'parsed';
    doParseLink('BV1multi0001');
    return true;
  })()`);
  await sleep(1200);
  say('  按钮 = ' + JSON.stringify(await evalJS(`(() => { const el = document.querySelector('#btnDownloadParsed'); return el ? el.textContent : '(没有这个按钮)'; })()`)));
  b = await centerOf('#btnDownloadParsed');
  if (b) {
    await clickAt(b.x, b.y);
    say('  点后 = ' + JSON.stringify(await state()));
    say('  → ' + ((await evalJS('window.__addCalls')) === 0 ? '进了勾选模式（没直接下载）' : '直接下载了 ' + (await evalJS('window.__addCalls')) + ' 首'));
  }

  /* ---------- C) 选集面板 ---------- */
  say('\n=== C) 选集面板（右侧滑出）===');
  await evalJS(`(() => {
    dlPick = null;
    window.__addCalls = 0;
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);
  await sleep(300);
  await evalJS(`(() => {
    const t = DB.favorites[0];
    return buildSequence(DB.favorites).then((seq) => { expandCollection(t, { list: seq.list, index: 0, name: '我喜欢' }); return true; });
  })()`);
  await sleep(900);
  say('  面板标题 = ' + JSON.stringify(await evalJS(`(document.getElementById('collectTitle')||{}).textContent`)));
  say('  按钮文案 = ' + JSON.stringify(await evalJS(`(document.getElementById('btnDownloadCollect')||{}).textContent`)));
  say('  面板里每行的操作按钮 = ' + JSON.stringify(await evalJS(`[...document.querySelectorAll('#collectList [data-cact]')].slice(0,4).map(b=>b.dataset.cact)`)));
  say('  面板里有没有勾选框 = ' + (await evalJS(`!!document.querySelector('#collectList input[type=checkbox], #collectList .pick-box')`)));
  b = await centerOf('#btnDownloadCollect');
  if (b) {
    await clickAt(b.x, b.y);
    say('  点后 = ' + JSON.stringify(await state()));
    say('  → ' + ((await evalJS('window.__addCalls')) === 0 ? '进了勾选模式（没直接下载）' : '直接下载了 ' + (await evalJS('window.__addCalls')) + ' 首'));
  }

  /* ---------- D) 下载管理页有哪些操作（问题 4）---------- */
  say('\n=== D) 下载管理页的操作按钮（问题 4）===');
  await evalJS(`(() => { dlPick = null; currentView = 'downloads'; renderAll(); return true; })()`);
  await sleep(400);
  say('  工具条按钮 = ' + JSON.stringify(await evalJS(`[...document.querySelectorAll('#content .dl-ops button, #content .dl-tool button, #content button')].map(b => b.id + '|' + b.textContent.trim()).slice(0, 12)`)));
  say('  全部按钮 id = ' + JSON.stringify(await evalJS(`[...document.querySelectorAll('#content button')].map(b=>b.id).filter(Boolean)`)));

  say('\n探针结束');
  setTimeout(() => process.exit(0), 120);
});
