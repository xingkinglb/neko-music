/* 探针：点「批量下载」按钮**里面的图标**时，事件到底落到哪个元素上？
   以及为什么会产生"打开悬浮歌词"的效果。

   四个真机反馈问题里的第 1 个，光看代码推不出来（按 closest('[id]') 的读法应该命中按钮本身），
   所以直接把点击落点、命中分支、状态变化全打出来。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-dlicon-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => fs.appendFileSync(OUT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAVS = Array.from({ length: 8 }, (_, i) => ({
  bvid: 'BV1fav' + String(i + 1).padStart(4, '0'), cid: 100 + i, page: 1,
  title: '收藏歌 ' + (i + 1), author: '歌手' + (i + 1), cover: '', duration: 200 + i,
}));

ipcMain.handle('store:load', () => ({
  ok: true,
  data: { playlists: [], favorites: FAVS, history: [], settings: {}, lastTrack: null },
}));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 200, backup: [] } }));
require('./stub-download-ipc.js')({ tasks: [], dir: 'C:\\测试\\下载' });

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

  // 进「我喜欢」
  await evalJS(`(() => { DB.favorites = ${JSON.stringify(FAVS)}; renderFavorites(); return true; })()`);
  await sleep(300);

  // 装一个捕获阶段的记录器：把点击落点的完整身份记下来
  await evalJS(`(() => {
    window.__hits = [];
    document.addEventListener('click', (e) => {
      const t = e.target;
      window.__hits.push({
        tag: t.tagName,
        cls: t.getAttribute && t.getAttribute('class') || '',
        id: t.id || '',
        parent: t.parentElement ? (t.parentElement.tagName + '.' + (t.parentElement.getAttribute('class') || '') + '#' + (t.parentElement.id || '')) : '',
        closestId: (t.closest && t.closest('[id]') || {}).id || '',
        closestOp: !!(t.closest && t.closest('.op-ic, .op-btn')),
      });
    }, true);
    return true;
  })()`);

  const box = (sel) => evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
  })()`);

  const snap = () => evalJS(`({
    dlPick: !!dlPick,
    picking: !!document.querySelector('#btnDlPickDo'),
    btnText: (document.querySelector('#btnDownloadFav') || {}).textContent,
    btnClass: (document.querySelector('#btnDownloadFav') || {}).className,
    btnH: (document.querySelector('#btnDownloadFav') || {getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height,
    lyricOverlay: document.getElementById('lyricOverlay').classList.contains('show'),
    deskOn: !!(window.neko && DB.settings && DB.settings.lyricWin && DB.settings.lyricWin.on),
  })`);

  const btnB = await box('#btnDownloadFav');
  const svgB = await box('#btnDownloadFav svg.ic');
  const useB = await box('#btnDownloadFav svg.ic use');
  say('按钮 rect = ' + JSON.stringify(btnB));
  say('  svg.ic rect = ' + JSON.stringify(svgB));
  say('  svg>use  rect = ' + JSON.stringify(useB));

  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(400);
  };

  say('\n=== 状态（点击前）===');
  say(JSON.stringify(await snap()));

  // ★ 关键：点图标本身（按钮最左边那个 ↓），不是点按钮中间
  say('\n=== 点图标（按钮左边缘 + 12px）===');
  await clickAt(btnB.x + 12, btnB.cy);
  say('落点记录 = ' + JSON.stringify(await evalJS('window.__hits')));
  say('状态 = ' + JSON.stringify(await snap()));

  // 复位
  await evalJS(`(() => { dlPick = null; renderFavorites(); window.__hits = []; return true; })()`);
  await sleep(300);
  say('\n=== 点按钮中间（文字处）===');
  await clickAt(btnB.cx, btnB.cy);
  say('落点记录 = ' + JSON.stringify(await evalJS('window.__hits')));
  say('状态 = ' + JSON.stringify(await snap()));

  // 顺便量一下勾选模式下的按钮尺寸（问题 2）
  say('\n=== 勾选模式下按钮尺寸（问题 2）===');
  await evalJS(`(() => { if (!dlPick) toggleDlPick(); return true; })()`);
  await sleep(300);
  say('按钮 = ' + JSON.stringify(await box('#btnDownloadFav')));
  say('  文字 = ' + JSON.stringify(await evalJS(`(() => { const s = document.querySelector('#btnDownloadFav span'); const b = s.getBoundingClientRect(); return { t: s.textContent, w: Math.round(b.width), h: Math.round(b.height) }; })()`)));
  say('  图标 = ' + JSON.stringify(await box('#btnDownloadFav svg.ic')));
  say('状态 = ' + JSON.stringify(await snap()));

  say('\n探针结束');
  setTimeout(() => process.exit(0), 120);
});
