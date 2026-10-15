/* 问题 A 的探针（修订版）：绿勾（幽灵勾）—— 文件在资源管理器里被直接删掉之后，
   界面还认它是「已下载」，而且再点只去开文件夹、不肯重下。

   要抓的事实：
     ① 启动时有没有做失联体检（sweepMissingLocal）
     ② 点行内「已下载」按钮 → 文件不在时有没有清记录 + 重新入队
     ③ 点播放条「已下载」按钮 → 同上
     ④ 文件**还在**时，行为不能变（仍然开文件夹）
     ⑤ 60 秒节流是否生效

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-ghost-cb-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => fs.appendFileSync(OUT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DL_DIR = 'C:\\测试\\下载';
/* ★ 磁盘状态可切换：默认"文件已不在" */
let fileExists = false;
const TRACK = { bvid: 'BV1song0001', cid: 7, page: 1, title: '大鱼', author: '周深', cover: '', duration: 312 };
const LOCAL_ENTRY = {
  id: 'L1', path: DL_DIR + '\\周深 - 大鱼.m4a', title: '大鱼',
  key: TRACK.bvid + ':' + TRACK.cid, bvid: TRACK.bvid, cid: TRACK.cid, src: 'download',
};
const DL_TASKS = [
  { id: 'dl_test1', key: TRACK.bvid + ':' + TRACK.cid, bvid: TRACK.bvid, cid: TRACK.cid, page: 1,
    title: '大鱼', author: '周深', cover: '', duration: 312,
    status: 'done', received: 4211000, total: 4211000, speed: 0,
    file: '周深 - 大鱼.m4a', coverFile: '', error: '', createdAt: 1, finishedAt: 2 },
];

/* ★ 关键桩：download:reveal 抛错 —— 和真实主进程 main.js:1201「文件不在了」一致 */
let revealCalls = 0;
let lastRemove = null;

const stub = require('./stub-download-ipc.js');
/* ★ 桩的任务表必须和主进程一样**真的会被改** —— 回个 true 就完事的话，
   删完再拉一次列表拿到的还是原来那条，"删掉之后绿勾消失"就永远测不出来（假通过）。 */
const TASKS = DL_TASKS.slice();
stub({ tasks: TASKS, dir: DL_DIR });
/* ★ 计数器只在**主进程这一侧**数（不要跨进 evaluateJavaScript 里数 —— 那里数不到）。
   同时把每次调用的落点写进文件，跑完直接读。 */
const CALLS = { stat: 0, reveal: 0, add: 0, remove: 0, clear: 0 };
let ADD_LOG = [];
let REMOVE_LOG = [];
ipcMain.removeHandler('local:stat');
ipcMain.handle('local:stat', (_e, paths) => {
  CALLS.stat++;
  const arr = Array.isArray(paths) ? paths : [paths];
  return { ok: true, data: arr.map((p) => ({ path: String(p || ''), exists: fileExists, size: fileExists ? 4211000 : 0 })) };
});
ipcMain.removeHandler('download:reveal');
ipcMain.handle('download:reveal', () => {
  CALLS.reveal++;
  if (!fileExists) throw new Error('文件不在了');
  return { ok: true, data: true };
});
ipcMain.removeHandler('download:add');
ipcMain.handle('download:add', (_e, tracks) => {
  CALLS.add++;
  ADD_LOG.push(Array.isArray(tracks) ? tracks : [tracks]);
  return { ok: true, data: { added: (Array.isArray(tracks) ? tracks : [tracks]).length, skipped: 0, duplicates: 0, needDir: false } };
});
ipcMain.removeHandler('download:remove');
ipcMain.handle('download:remove', (_e, ids, del) => {
  CALLS.remove++;
  const list = Array.isArray(ids) ? ids : [ids];
  REMOVE_LOG.push([list, del]);
  for (const id of list) {                    // ★ 真的从任务表里删掉（和真主进程一致）
    const i = TASKS.findIndex((t) => t.id === id);
    if (i >= 0) TASKS.splice(i, 1);
  }
  return { ok: true, data: true };
});

ipcMain.handle('store:load', () => ({
  ok: true,
  data: {
    playlists: [], favorites: [], history: [],
    settings: { download: { dir: DL_DIR, concurrent: 2, saveCover: true, autoAddToLocal: true, skipExisting: true } },
    lastTrack: null,
    local: [LOCAL_ENTRY],
  },
}));
let lastSave = null;
ipcMain.handle('store:save', (_e, data) => { lastSave = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 312, backup: [] } }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1500);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  /* ---------- ① 启动体检：磁盘上没文件 → 记录该被剔掉 ---------- */
  say('=== ① 启动体检（local:stat 一律回 exists:false）===');
  const afterBoot = await evalJS(`({ localLen: (DB.local || []).length, dlKeys: [...dlKeys] })`);
  say('  DB.local 条数 = ' + afterBoot.localLen);
  say('  dlKeys        = ' + JSON.stringify(afterBoot.dlKeys));
  say('  local:stat 调用次数 = ' + CALLS.stat);
  const bootOk = afterBoot.localLen === 0 && afterBoot.dlKeys.length === 0 && CALLS.stat > 0;
  say('  → ' + (bootOk ? '★ 启动时做了体检，失效记录已剔除（绿勾不会假装还在）'
                    : '✗ 体检没生效'));

  /* ---------- ② 文件不在时，点行内「已下载」按钮 ---------- */
  say('\n=== ② 文件不在 + 点行内按钮（先手动把记录塞回去，模拟"体检之后用户又删了文件"）===');
  await evalJS(`(() => {
    DB.local = [${JSON.stringify(LOCAL_ENTRY)}];
    rebuildDlKeys();
    currentView = 'search'; searchKeyword = '测试';
    searchResults = [${JSON.stringify(TRACK)}];
    renderAll();
    return true;
  })()`);
  await sleep(300);
  const beforeClick = await evalJS(`(() => {
    const b = document.querySelector('#content .track [data-act="download"]');
    return { isDl: isDownloaded(searchResults[0]), cls: b.className, icon: (b.querySelector('use')||{}).getAttribute('href'),
             dlTasks: dlTasks.map((t) => ({ id: t.id, key: t.key, status: t.status })),
             taskForTrack: (() => { const t = taskForTrack(searchResults[0]); return t ? t.id + '/' + t.status : null; })(),
             entry: (() => { const e = findLocalEntryOf(searchResults[0]); return e ? e.id : null; })(),
             local: (DB.local || []).map((e) => e.key) };
  })()`);
  say('  点击前：isDownloaded=' + beforeClick.isDl + '，按钮=' + beforeClick.cls + ' / ' + beforeClick.icon);
  say('          dlTasks=' + JSON.stringify(beforeClick.dlTasks));
  say('          taskForTrack=' + beforeClick.taskForTrack + '，findLocalEntryOf=' + beforeClick.entry);
  say('          DB.local keys=' + JSON.stringify(beforeClick.local));

  const c = Object.assign({}, CALLS);
  await evalJS(`document.querySelector('#content .track [data-act="download"]').click()`);
  await sleep(1200);
  const afterClick = await evalJS(`(() => {
    currentView = 'search'; searchKeyword = '测试'; renderAll();
    const b = document.querySelector('#content .track [data-act="download"]');
    return { localLen: (DB.local || []).length, dlKeys: [...dlKeys],
             toast: (document.getElementById('toast') || {}).textContent || '',
             isDl: isDownloaded(searchResults[0]),
             cls: b.className, icon: (b.querySelector('use')||{}).getAttribute('href') };
  })()`);
  say('  点击后：DB.local=' + afterClick.localLen + '，dlKeys=' + JSON.stringify(afterClick.dlKeys));
  say('          isDownloaded=' + afterClick.isDl + '，按钮=' + afterClick.cls + ' / ' + afterClick.icon);
  say('          提示=' + JSON.stringify(afterClick.toast));
  say('  download:reveal 次数增 = ' + (CALLS.reveal - c.reveal) + '（应为 0 —— 文件不在不该去开文件夹）');
  say('  download:add    次数增 = ' + (CALLS.add - c.add) + '，内容=' + JSON.stringify(ADD_LOG.slice(c.add)));
  say('  download:remove 次数增 = ' + (CALLS.remove - c.remove) + '，内容=' + JSON.stringify(REMOVE_LOG.slice(c.remove)));
  const clickOk = (CALLS.add > c.add) && (CALLS.reveal === c.reveal)
    && afterClick.localLen === 0 && afterClick.dlKeys.length === 0;
  say('  任务表内容 = ' + JSON.stringify(TASKS.map((t) => t.id + '/' + t.status)));
  say('  → ' + (clickOk ? '★ 文件不在 → 清了失效记录 + 直接重新入队（用户不用自己去删）'
                     : '✗ 点击兜底没生效'));

  /* ---------- ③ 文件**还在**时，行为不能变（仍然开文件夹，不入队） ---------- */
  say('\n=== ③ 文件还在 + 点行内按钮（回归：不能变成重新下载）===');
  fileExists = true;
  await evalJS(`(() => {
    DB.local = [${JSON.stringify(LOCAL_ENTRY)}];
    rebuildDlKeys();
    currentView = 'search'; searchKeyword = '测试'; renderAll();
    return true;
  })()`);
  await sleep(300);
  const c3 = Object.assign({}, CALLS);
  await evalJS(`document.querySelector('#content .track [data-act="download"]').click()`);
  await sleep(1200);
  const after3 = await evalJS(`({ localLen: (DB.local || []).length, dlKeys: [...dlKeys],
    toast: (document.getElementById('toast') || {}).textContent || '' })`);
  say('  download:reveal 次数增 = ' + (CALLS.reveal - c3.reveal) + '（应为 1）');
  say('  download:add    次数增 = ' + (CALLS.add - c3.add) + '（应为 0）');
  say('  download:remove 次数增 = ' + (CALLS.remove - c3.remove) + '（应为 0）');
  say('  记录还在吗：DB.local=' + after3.localLen + '，dlKeys=' + JSON.stringify(after3.dlKeys));
  const regOk = (CALLS.reveal > c3.reveal) && (CALLS.add === c3.add) && (CALLS.remove === c3.remove)
    && after3.localLen === 1;
  say('  → ' + (regOk ? '★ 回归正常：文件还在就只开文件夹，不动记录、不重下'
                   : '✗ 回归被破坏'));

  /* ---------- ④ 播放条按钮（文件不在） ---------- */
  say('\n=== ④ 文件不在 + 点播放条按钮 ===');
  fileExists = false;
  await evalJS(`(() => {
    DB.local = [${JSON.stringify(LOCAL_ENTRY)}];
    rebuildDlKeys();
    currentView = 'search'; searchKeyword = '测试';
    searchResults = [${JSON.stringify(TRACK)}];
    renderAll();
    // 直接把播放条那颗按钮刷成"已下载"的样子：模拟正在播这首歌
    queue = { tracks: [Object.assign({}, searchResults[0])], index: 0, name: '测试' };
    rebuildDlKeys(); syncDownloadBtn();
    return true;
  })()`);
  await sleep(300);
  const barBefore = await evalJS(`(() => { const b = document.getElementById('btnDownload');
    return { cls: b.className, icon: (b.querySelector('use')||{}).getAttribute('href'), title: b.title }; })()`);
  say('  点击前播放条按钮：' + JSON.stringify(barBefore));
  const c4 = Object.assign({}, CALLS);
  await evalJS(`document.getElementById('btnDownload').click()`);
  await sleep(1200);
  const after4 = await evalJS(`({ localLen: (DB.local || []).length, dlKeys: [...dlKeys],
    toast: (document.getElementById('toast') || {}).textContent || '' })`);
  say('  download:reveal 次数增 = ' + (CALLS.reveal - c4.reveal) + '（应为 0）');
  say('  download:add    次数增 = ' + (CALLS.add - c4.add) + '（应为 1）');
  say('  DB.local=' + after4.localLen + '，dlKeys=' + JSON.stringify(after4.dlKeys));
  const barOk = (CALLS.add > c4.add) && (CALLS.reveal === c4.reveal) && after4.localLen === 0;
  say('  → ' + (barOk ? '★ 播放条按钮同样有兜底' : '✗ 播放条按钮没兜底'));

  /* ---------- ⑤ 60 秒节流 ---------- */
  say('\n=== ⑤ 节流：连续调两次 sweepMissingLocal() ===');
  const throttle = await evalJS(`(async () => {
    DB.local = [${JSON.stringify(LOCAL_ENTRY)}];
    rebuildDlKeys();
    const n1 = await sweepMissingLocal(true);   // 绕过"上次时间戳"的节流，先做一次真体检
    const n2 = await sweepMissingLocal();       // 紧接着再来一次 → 该被 60 秒节流挡住
    return { n1, n2, localLen: (DB.local || []).length };
  })()`);
  say('  force 一次返回 ' + throttle.n1 + '，紧接着非 force 返回 ' + throttle.n2 + '（期望第二次 = 0）');
  say('  之后 DB.local=' + throttle.localLen);
  const throttleOk = throttle.n1 === 1 && throttle.n2 === 0;
  say('  → ' + (throttleOk ? '★ 节流生效（60 秒内不重复摸盘）' : '✗ 节流没生效'));

  /* ---------- ⑥ 落盘 ---------- */
  await sleep(800);
  const savedKeys = lastSave ? (lastSave.local || []).map((e) => e.key) : null;
  say('\n=== ⑥ 最后一次落盘的 local ===');
  say('  ' + JSON.stringify(savedKeys));

  say('\n=== 小结 ===');
  say('  ① 启动体检        : ' + (bootOk ? 'PASS' : 'FAIL'));
  say('  ② 行内点击兜底    : ' + (clickOk ? 'PASS' : 'FAIL'));
  say('  ③ 文件在时回归    : ' + (regOk ? 'PASS' : 'FAIL'));
  say('  ④ 播放条点击兜底  : ' + (barOk ? 'PASS' : 'FAIL'));
  say('  ⑤ 60 秒节流       : ' + (throttleOk ? 'PASS' : 'FAIL'));

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 8).join('\n  '));
  say('\n探针结束');
  setTimeout(() => process.exit(0), 150);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => process.exit(2), 150); });
