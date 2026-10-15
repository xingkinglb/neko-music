/* 探针：mini 收起态第一行到底谁超宽了。
   不改代码，只量尺寸 —— 确认 round10 [3] 那 4 条断言背后的真实数值。
   开发期脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'probe-mini-layout-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { handleMiniRequest } = require(path.join(ROOT, 'src', 'win-mini.js'));

let lastSaved = null;
let win = null;
const miniState = { on: false, expanded: false, fullBounds: null };

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'no', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({ ok: true, data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
require('./stub-download-ipc.js')();

ipcMain.on('win-min', () => {}); ipcMain.on('win-max', () => {}); ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {}); ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', (_e, opts) => {
  const st = handleMiniRequest(win, miniState, opts, screen.getPrimaryDisplay().workAreaSize);
  try { win.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const evalJS = (code) => win.webContents.executeJavaScript(code);
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    window.__paused = true;
    Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
    window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
    return true;
  })()`);
  await sleep(150);
  await evalJS(`(() => { const rows = Array.from({length:5},(_,i)=>window.__mk('BV1mini'+i,'示例歌曲 '+(i+1))); queue = { tracks: rows, index: 2, name: '测试来源' }; renderAll(); return true; })()`);
  await sleep(200);
  await evalJS(`(() => { document.getElementById('btnMini').click(); return true; })()`);
  await sleep(500);

  const playerStyle = await evalJS(`(() => {
    const p = document.querySelector('.player');
    const s = getComputedStyle(p);
    return { justify: s.justifyContent, alignContent: s.alignContent, alignItems: s.alignItems, flexWrap: s.flexWrap, display: s.display, gridCols: s.gridTemplateColumns, padding: s.padding, gap: s.gap };
  })()`);
  say('player computed: ' + JSON.stringify(playerStyle));

  // 假设：margin-right:auto 在 wrap 下把第一行推爆。临时去掉再看。
  const after = await evalJS(`(() => {
    const p = document.querySelector('.player');
    const st = document.createElement('style');
    st.id = '__probe__';
    st.textContent = 'body.mini .controls { margin-right: 0 !important; }';
    document.head.appendChild(st);
    void p.offsetHeight;
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), right: Math.round(b.right) }; };
    return { cover: r('.np-cover'), ctrl: r('.controls'), heart: r('.heart-btn'), vol: r('.vol-wrap'), queue: r('#btnQueue'), actions: r('.mini-actions'), title: r('.np-title'), winW: window.innerWidth };
  })()`);
  say('去掉 controls 的 auto margin 后: ' + JSON.stringify(after));

  const rows = await evalJS(`(() => {
    const p = document.querySelector('.player');
    const items = [];
    const walk = (node) => {
      for (const c of node.children) {
        const s = getComputedStyle(c);
        if (s.display === 'contents') { walk(c); continue; }
        const b = c.getBoundingClientRect();
        items.push({ cls: c.className, id: c.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), right: Math.round(b.right), order: s.order, disp: s.display });
      }
    };
    walk(p);
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    return { winW: window.innerWidth, items, contentBox: { left: p.getBoundingClientRect().left + parseFloat(getComputedStyle(p).paddingLeft) } };
  })()`);
  say('分行明细: ' + JSON.stringify(rows, null, 2));

  const info = await evalJS(`(() => {
    const st = document.getElementById('__probe__'); if (st) st.remove();
    const el = (sel) => document.querySelector(sel);
    const r = (sel) => { const e = el(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right), disp: getComputedStyle(e).display, css: { w: getComputedStyle(e).width, flex: getComputedStyle(e).flex, mr: getComputedStyle(e).marginRight, gap: getComputedStyle(e).gap } }; };
    const p = el('.player');
    const kids = Array.from(p.children).map((c) => ({ cls: c.className, disp: getComputedStyle(c).display, x: Math.round(c.getBoundingClientRect().x), w: Math.round(c.getBoundingClientRect().width), right: Math.round(c.getBoundingClientRect().right), order: getComputedStyle(c).order }));
    return {
      winW: window.innerWidth, winH: window.innerHeight,
      playerW: Math.round(p.getBoundingClientRect().width),
      playerRect: { x: Math.round(p.getBoundingClientRect().x), w: Math.round(p.getBoundingClientRect().width), right: Math.round(p.getBoundingClientRect().right) },
      playerPad: getComputedStyle(p).padding, playerGap: getComputedStyle(p).gap,
      cover: r('.np-cover'), ctrl: r('.controls'), ctrlRow: r('.ctrl-row'),
      heart: r('.heart-btn'), vol: r('.vol-wrap'), queue: r('#btnQueue'), actions: r('.mini-actions'),
      kids,
      // 数一下第一行总占用
      ctrlBtns: Array.from(document.querySelectorAll('.ctrl-row .ctrl-btn')).map((b) => ({ id: b.id, disp: getComputedStyle(b).display, w: Math.round(b.getBoundingClientRect().width), mr: getComputedStyle(b).marginRight })),
    };
  })()`);
  say(JSON.stringify(info, null, 2));
  say('退出码 0');
  setTimeout(() => process.exit(0), 120);
});
