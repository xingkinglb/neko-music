/* v2.12.5 · 定位按钮实测（Neo 抓的老 bug）。
   跑：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/test-round31.js

   ★ 这个 bug 藏了多久：定位是「点整行播放」时代就有的功能，
     而从搜索加进歌单的歌 cid 一直是 null（播放时才补到队列副本上）——
     sameTrack 严格比 cid，null ≠ 补齐后的 202，所以**在歌单里定位永远失败**，
     只会一直弹「这个列表里已经找不到这一首了」。真机上天天撞，静态自检抓不到
     （功能"能跑"，只是语义错了 —— toast 弹得还挺客气）。

   ★ 怎么测：歌单里放一首 cid=null 的歌，把队列副本的 cid 补成 999（模拟播放时
     ensureCid 补齐的那一下），然后调 locateCurrentTrack()，看它是否还弹"找不到"。
     修复后应该：滚动高亮成功（scrollToCurrentRow 返回 true，toast 里没有"找不到"）。
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

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('queue:load', () => ({ ok: true, data: null }));
ipcMain.handle('queue:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://x', duration: 200, backup: [] } }));
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

  /* ================= 1) 歌单里 cid=null 的歌（主场景） ================= */
  say('\n[1] 歌单里 cid=null 的歌，播放副本 cid 已补齐：');
  await ev(`(() => {
    DB.playlists = [{ id: 'p1', name: '测试歌单', tracks: [
      { bvid: 'BVaaa', cid: null, title: '歌一', author: 'UP', duration: 200 },
      { bvid: 'BVbbb', cid: null, title: '歌二', author: 'UP', duration: 200 },
    ]}];
    // 模拟"点过歌单第 1 首播放"之后的队列状态：副本的 cid 被 ensureCid 补成 999
    queue = {
      tracks: [{ bvid: 'BVaaa', cid: 999, title: '歌一', author: 'UP', duration: 200 }],
      index: 0,
      name: '测试歌单',
      source: { view: 'playlist:p1' },
    };
    currentView = 'playlist:p1';
    renderAll();
    return true;
  })()`);
  await sleep(500);
  const r1 = await ev(`(async () => {
    let toastText = '';
    const orig = window.toast;
    window.toast = (m) => { toastText = String(m); };
    locateCurrentTrack();
    window.toast = orig;
    await new Promise((r) => setTimeout(r, 300));
    return { toastText, view: currentView };
  })()`);
  say(`    toast：「${r1.toastText}」`);
  if (r1.toastText.includes('找不到')) bad('定位失败 —— cid=null 的歌在歌单里还是找不到（修复没生效？）');
  else ok('定位成功，没有弹「找不到」');
  if (r1.view !== 'playlist:p1') bad(`定位后视图跑去了 ${r1.view}`);
  else ok('留在歌单页');

  /* ================= 2) 收藏里的同款场景 ================= */
  say('\n[2] 我喜欢里 cid=null 的歌：');
  await ev(`(() => {
    DB.favorites = [{ bvid: 'BVccc', cid: null, title: '收藏歌', author: 'UP', duration: 200 }];
    queue = {
      tracks: [{ bvid: 'BVccc', cid: 888, title: '收藏歌', author: 'UP', duration: 200 }],
      index: 0, name: '我喜欢', source: { view: 'favorites' },
    };
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);
  await sleep(400);
  const r2 = await ev(`(() => {
    let toastText = '';
    const orig = window.toast;
    window.toast = (m) => { toastText = String(m); };
    locateCurrentTrack();
    window.toast = orig;
    return toastText;
  })()`);
  if (r2.includes('找不到')) bad('我喜欢里也定位失败');
  else ok('我喜欢里定位成功');

  /* ================= 3) 真·不同分P 依然不许认错 ================= */
  say('\n[3] 反向：cid 都齐全但不同（分P 的另一集）不许误定位：');
  const r3 = await ev(`(() => {
    // 目标列表里是分P 第 1 集（cid=1），在播的是第 2 集（cid=2）—— 两边 cid 都有值
    const tracks = [{ bvid: 'BVpp', cid: 1, title: '第1集' }];
    const cur = { bvid: 'BVpp', cid: 2, title: '第2集' };
    // scrollToCurrentRow 只做滚动，这里直接测它的匹配逻辑等价式
    const i = tracks.findIndex((t) => {
      if (sameTrack(t, cur)) return true;
      return !!(t && cur && t.bvid && t.bvid === cur.bvid
        && !t.localPath && !cur.localPath
        && (t.cid == null || cur.cid == null));
    });
    return i;
  })()`);
  if (r3 !== -1) bad('分P 的另一集被误认成同一首（定位会滚到错的行上）');
  else ok('两边 cid 都齐全且不同 → 不误认（分P 歧义没有被放宽破坏）');

  /* ================= 4) 我的主页的收藏夹也能定位 ================= */
  say('\n[4] locateCanRestore 认得新视图：');
  const r4 = await ev(`(() => ({ my: locateCanRestore('my'), folder: locateCanRestore('myfolder'), old: locateCanRestore('playlist:p1') }))()`);
  if (!r4.my || !r4.folder || !r4.old) bad(`定位来源恢复没认全新视图：${JSON.stringify(r4)}`);
  else ok('my / myfolder / playlist 都能恢复来源');

  /* ================= 4.5) 合集摊平条目 → 打开选集面板 ================= */
  say('\n[4.5] 合集里的歌（摊平条目在列表上没有自己的行）：');
  await ev(`(() => {
    // 解析页：列表上只有一行合集入口（cid 是 1P 的，parts 记了 3 —— 有「选集」徽章）
    parsedView = {
      info: { title: '音乐合集', owner: { name: 'UP' } },
      pages: [{ cid: 1, duration: 300 }],
      seasonTracks: [],
      tracks: [{ bvid: 'BVpp', cid: 1, title: '音乐合集', author: 'UP', duration: 900, parts: 3 }],
    };
    // 曲目表（分P 摊平后每集 cid 不同 —— 这就是入口行和摊平条目"sameTrack 对不上"的原因）
    DB.collectParts['BVpp'] = [
      { bvid: 'BVpp', cid: 1, page: 1, title: '第1首', duration: 300 },
      { bvid: 'BVpp', cid: 2, page: 2, title: '第2首', duration: 300 },
      { bvid: 'BVpp', cid: 3, page: 3, title: '第3首', duration: 300 },
    ];
    queue = {
      tracks: [{ bvid: 'BVpp', cid: 2, title: '第2首', author: 'UP', duration: 300 }],
      index: 0, name: '音乐合集', source: { view: 'parsed' },
    };
    currentView = 'parsed';
    renderAll();
    return true;
  })()`);
  await sleep(500);
  const r6 = await ev(`(async () => {
    let toastText = '';
    const orig = window.toast;
    window.toast = (m) => { toastText = String(m); };
    locateCurrentTrack();
    await new Promise((r) => setTimeout(r, 700));
    window.toast = orig;
    const maskOn = document.getElementById('collectMask').classList.contains('show');
    const onRow = document.querySelector('#collectList .collect-row.on');
    return { toastText, maskOn, onTitle: onRow ? (onRow.querySelector('.ct') || {}).textContent || '' : '' };
  })()`);
  say(`    toast：「${r6.toastText}」 面板打开：${r6.maskOn} 面板高亮：「${r6.onTitle}」`);
  if (r6.toastText.includes('找不到')) bad('合集摊平条目定位失败 —— 还是弹「找不到」');
  else if (!r6.maskOn) bad('定位到了合集行但没有自动打开选集面板');
  else if (r6.onTitle !== '第2首') bad(`面板里高亮的不是正在播的那集（高亮了「${r6.onTitle}」）`);
  else ok('定位到合集行 + 自动打开选集面板 + 面板里高亮第 2 首');

  /* ================= 5) 页面报错 ================= */
  say('\n[5] 页面报错：');
  if (errors.length) { errors.slice(0, 4).forEach((e) => say('    ' + e)); bad(`页面报了 ${errors.length} 条错`); }
  else ok('全程没有页面报错');

  say(fail === 0 ? '\n定位实测：全部通过 ✅' : `\n定位实测：${fail} 处失败 ❌`);
  fs.writeFileSync(path.join(__dirname, 'test-round31-report.txt'),
    fail === 0 ? '全部通过 ✅\n\n退出码 0\n' : `${fail} 处失败 ❌\n\n退出码 1\n`);
  app.exit(fail === 0 ? 0 : 1);
});
