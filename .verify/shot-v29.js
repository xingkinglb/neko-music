/* 一次性截图：v2.9.0 的三处改动，人眼验收用（不做断言）。
   跑完把图写到 .verify/ 下：
     shot-v29-list.png   歌曲行「一直显示」的样子（55% 亮度）
     shot-v29-set.png    设置 → 外观页的两个新控件
     shot-v29-mini.png   mini 小窗：✕ 已换成「词」，右边 ▢
     shot-v29-import.png 导入时"到哪儿"的弹窗
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

const TRACKS = [
  { bvid: 'BV1aa', cid: 1, page: 1, title: '花海', author: '周杰伦', duration: 258, cover: '', mid: 1 },
  { bvid: 'BV1bb', cid: 1, page: 1, title: '起风了', author: '买辣椒也用券', duration: 325, cover: '', mid: 1 },
  // 这一条故意做成 31 分钟 → 会出「合集 N」徽章，用来人眼验"带徽章的行按钮是否对齐"
  { bvid: 'BV1cc', cid: 1, page: 1, title: '晴天（一小时合集）', author: '周杰伦', duration: 1900, cover: '', mid: 1 },
  { bvid: 'BV1dd', cid: 1, page: 1, title: '海阔天空', author: 'Beyond', duration: 326, cover: '', mid: 1 },
  { bvid: 'BV1ee', cid: 1, page: 1, title: '夜曲', author: '周杰伦', duration: 226, cover: '', mid: 1 },
];

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'x', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '花海', cover: '', owner: { mid: 1, name: 'UP' }, duration: 258,
          pages: [{ bvid, cid: 1, page: 1, title: '花海', duration: 258 }], season: null },
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
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  const shoot = async (name) => {
    // ★ 等久一点：常显那档有 opacity 过渡，离屏窗口的帧会被节流，
    //   等太短会拍到「还没亮起来」的那一帧（列表截图里按钮整排看不见，就是这么来的）。
    await sleep(1000);
    const img = await win.webContents.capturePage();
    const p = path.join(__dirname, name);
    fs.writeFileSync(p, img.toPNG());
    console.log('  → ' + name + '  ' + img.getSize().width + '×' + img.getSize().height);
  };

  /* 1) 歌曲列表 + 常显工具条（55%） */
  await evalJS(`(() => {
    DB.favorites = ${JSON.stringify(TRACKS)};
    DB.settings.listOps = 'always';
    DB.settings.opsOpacity = 55;
    applyOpsMode();
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);
  await shoot('shot-v29-list.png');

  /* 2) 设置 → 外观页 */
  await evalJS(`(() => { showSettingsTab('appearance'); return true; })()`);
  await sleep(400);
  await evalJS(`(() => {
    const f = document.getElementById('fieldOpsAlpha');
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await shoot('shot-v29-set.png');
  await evalJS(`(() => { closeSettings(); return true; })()`);

  /* 3) 导入"到哪儿"的弹窗 */
  await evalJS(`(() => {
    DB.playlists = [
      { id: 'pl-a', name: '我的通勤', tracks: ${JSON.stringify(TRACKS.slice(0, 2))} },
      { id: 'pl-b', name: '深夜电台', tracks: [] },
      { id: 'pl-c', name: '古风', tracks: ${JSON.stringify(TRACKS.slice(2, 5))} },
    ];
    impState = {
      step: 'list', me: { mid: 1, name: '我' }, loading: false, error: '', errorReason: '',
      folders: [{ id: 11, title: '我收藏的宝藏歌单', count: 5 }],
      source: 'fav', folderId: 11, folderName: '我收藏的宝藏歌单', list: [], page: 0, pageSize: 30, total: 5,
      selected: new Map(${JSON.stringify(TRACKS)}.map((t) => [t.bvid, { track: t, from: 11 }])),
    };
    currentView = 'importMine';
    importPicked();
    return true;
  })()`);
  await shoot('shot-v29-import.png');
  await evalJS(`(() => { closePrompt(null); return true; })()`);

  /* 3.5) 「批量选择」：选 3 首的样子（动作条 + 勾选框） */
  await evalJS(`(() => {
    selPick = null;
    DB.settings.listOps = 'hover';
    applyOpsMode();
    DB.favorites = ${JSON.stringify(TRACKS)};
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);
  await sleep(250);
  await evalJS(`document.getElementById('btnSelectFav').click(); true`);
  await sleep(350);
  // ★ 必须一行一行点、每次重查 DOM：点一行会整块重画，旧节点已经脱离文档了
  for (const i of [0, 1, 3]) {
    await evalJS(`(() => { const r = document.querySelectorAll('#content .track.pickable')[${i}]; if (r) r.click(); return true; })()`);
    await sleep(140);
  }
  await shoot('shot-v29-pick.png');

  /* 4) mini 小窗 */
  await evalJS(`(() => { selPick = null; setMini(true, false); return true; })()`);
  await sleep(300);
  win.setContentSize(420, 132);
  await evalJS(`(() => {
    DB.settings.autoLyric = true;
    const t = ${JSON.stringify(TRACKS[0])};
    queue.tracks = ${JSON.stringify(TRACKS)};
    queue.index = 0;
    const npt = document.getElementById('npTitle');
    if (npt) npt.textContent = t.title;
    const nps = document.getElementById('npSub');
    if (nps) nps.textContent = t.author;
    updateLyricBtn();
    return true;
  })()`);
  await shoot('shot-v29-mini.png');

  console.log('截图完成');
  setTimeout(() => process.exit(0), 200);
}).catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); setTimeout(() => process.exit(2), 200); });
