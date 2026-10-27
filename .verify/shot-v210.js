/* 一次性截图：v2.10.0 五项改动，人眼验收用（不做断言）。
   跑完写到 .verify/ 下：
     shot-v210-sticky.png  批量选择滚到中间，操作条吸在顶部
     shot-v210-drag.png    拖选进行中（选了一段）
     shot-v210-search.png  列表内搜索展开 + 结果 + 「内含 N 集」
     shot-v210-locate.png  播放条定位过去之后的高亮
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

const TITLES = ['晴天', '起风了', '夜曲', '海阔天空', '富士山下', '七里香', '稻香', '告白气球',
  '光年之外', '演员', '平凡之路', '成都', '小幸运', '后来', '南山南', '斑马斑马',
  '晴天（一小时合集）', '刚刚好', '半壶纱', '红昭愿'];
const TRACKS = TITLES.map((t, i) => ({
  bvid: 'BVshot' + i, cid: 800 + i, page: 1, title: t,
  author: ['周杰伦', '买辣椒也用券', 'Beyond', '陈奕迅', '某UP'][i % 5],
  duration: t.includes('合集') ? 3600 : 180 + i * 7, cover: '', mid: 1,
}));

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'x', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: 'x', cover: '', owner: { mid: 1, name: 'UP' }, duration: 200,
          pages: [{ bvid, cid: 800, page: 1, title: 'x', duration: 200 }], season: null },
}));
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
  const send = (type, p) => win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });

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
    DB.playlists = [{ id: 'pl1', name: '我的歌单', tracks: ${JSON.stringify(TRACKS)} }];
    DB.collectParts = { 'BVshot16': [
      { bvid: 'BVshot16', cid: 1, page: 1, title: '晴天 (Live)', duration: 200, author: '周杰伦' },
      { bvid: 'BVshot16', cid: 2, page: 2, title: '七里香 (Live)', duration: 200, author: '周杰伦' },
    ] };
    renderPlaylist('pl1');
    return true;
  })()`);
  await sleep(300);

  /* 1) 吸顶：进批量选择，选 3 行，然后滚到中间 */
  await ev(`document.getElementById('btnSelectPl').click(); true`);
  await sleep(400);
  for (const i of [1, 2, 3]) {
    await ev(`(() => { const r = document.querySelectorAll('#content .track.pickable')[${i}]; if (r) r.click(); return true; })()`);
    await sleep(120);
  }
  await ev(`(() => { document.getElementById('content').scrollTop = 320; return true; })()`);
  await shoot('shot-v210-sticky.png');

  /* 2) 拖选进行中：从第 9 行往下拖到第 13 行，停在中间不松手 */
  // 拖之前先清空，截图里"拖出来的一段"更清楚
  await ev(`(() => {
    document.getElementById('content').scrollTop = 0;
    if (selPick) selPick.selected.clear();
    refreshListOnly();
    return true;
  })()`);
  await sleep(300);
  {
    const pt = (i) => ev(`(() => {
      const r = document.querySelectorAll('#content .track.pickable')[${i}];
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    // ★ 只能用可视区内的行：超出窗口高度的坐标 elementFromPoint 会返回 null，拖选不生效
    const a = await pt(0), b = await pt(6);
    console.log('    拖选起点/终点：', JSON.stringify(a), JSON.stringify(b),
                ' 拖前已选：', await ev('selPick ? selPick.selected.size : -1'));
    if (a && b) {
      send('mouseDown', a);
      await sleep(80);
      for (let k = 1; k <= 5; k++) {
        send('mouseMove', { x: a.x, y: Math.round(a.y + (b.y - a.y) * k / 5) });
        await sleep(80);
      }
      console.log('    拖到一半已选：', await ev('selPick ? selPick.selected.size : -1'));
      await shoot('shot-v210-drag.png');
      send('mouseUp', b);
      await sleep(300);
    }
  }

  /* 3) 搜索：搜「晴天」→ 顶层命中 + 合集行带「内含 2 集」 */
  await ev(`(() => { selPick = null; renderPlaylist('pl1'); return true; })()`);
  await sleep(300);
  await ev(`document.getElementById('btnListSearch').click(); true`);
  await sleep(400);
  await ev(`(() => {
    const el = document.getElementById('listSearchInput');
    el.focus();
    el.value = '晴天';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await shoot('shot-v210-search.png');

  /* 3.5) 搜索词自动带进合集面板（v2.10.0 修订） */
  await ev(`(() => {
    const b = document.querySelector('#content .track .badge');
    if (b) b.click();
    return true;
  })()`);
  await shoot('shot-v210-carry.png');
  await ev(`closeCollectPanel(); true`);
  await sleep(250);

  /* 4) 定位：从歌单点第 12 行 → 切到别的页 → 点定位 */
  await ev(`(() => { listSearch = ''; listSearchOpen = false; renderPlaylist('pl1'); return true; })()`);
  await sleep(300);
  await ev(`document.querySelectorAll('#content .track')[11].click(); true`);
  await sleep(900);
  await ev(`(() => { currentView = 'history'; DB.history = ${JSON.stringify(TRACKS.slice(0, 4))}; renderAll(); return true; })()`);
  await sleep(300);
  await ev(`document.getElementById('btnLocate').click(); true`);
  await sleep(600);
  // 测试环境的 bili:// 桩地址取不到音频，会弹一句"音频加载失败"—— 截图里清掉，别挡住界面
  await ev(`(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()`);
  await shoot('shot-v210-locate.png');

  console.log('截图完成');
  setTimeout(() => process.exit(0), 200);
}).catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); setTimeout(() => process.exit(2), 200); });
