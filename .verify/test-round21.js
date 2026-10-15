/* 第二十一轮：本地歌曲的「文件夹列表 + 批量选择」实测（v2.8.0 修订，离屏渲染 + 真跑应用代码）

   本轮的改动把「本地歌曲」页从"一个平铺列表"改成**左右两栏**：
     左栏 = 文件夹列表（全部歌曲 / 本地下载 / 各导入文件夹 + 悬停 ✕）
     右栏 = 当前分组下的曲目 + 顶部「批量选择」按钮
   本脚本盯的是**行为**，用离屏浏览器真跑 app.js，点真按钮、看真结果。

   ★ 判别力：这一组在本次改动**之前**的代码上会整体失败 ——
     那时没有 localGroups / toggleLocalPick / btnLocalPick / .local-side，
     `typeof localGroups === 'undefined'` 会让每条断言老实报 FAIL（而不是崩掉整轮）。

   量什么：
     [1]  ★ 左栏存在：.local-side + 有「全部歌曲」这一行
     [2]  ★ 分组正确：下载来的进「本地下载」，导入文件夹的进同名的文件夹组（按 folderRoot）
     [3]  ★ 点左栏切分组：点「本地下载」→ 右栏只剩下载来的那几首
     [4]  ★ 单曲导入归「导入的歌曲」组
     [5]  ★ 文件夹组右边有 ✕；点它 → 只删该组记录，其他组不动、磁盘文件不动
     [6]  「批量选择」按钮：点开进入勾选态，出现工具条；默认一个都不勾
     [7]  ★ 勾选用 localPath 当身份（本地歌没有 bvid，不能按 bvid 勾）
     [8]  ★ 全选 / 清空只作用于当前分组
     [9]  ★ 「移出库」：把选中的移除，其他不动
     [10] ★ 换分组自动退出勾选态
     [11] ★ 离开本地页自动退出勾选态
     [12] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round21-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ★ 兜底：测试脚本里任何一处抛出的异常/未处理的 Promise 拒绝，都要**立刻写进报告并退出** ——
   否则 Electron 会静静地挂着（看起来像"卡死"），报告停在半截，排查起来极慢。
   （这条是本次实测踩出来的：click 后读了 null 的属性，整轮就停在那里了。） */
const die = (e) => {
  try { say('\n💥 测试脚本自身抛异常（不是产品失败）：' + ((e && e.stack) || e)); } catch (_) {}
  try { process.exit(3); } catch (_) {}
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

/* ---------- 桩数据 ----------
   两个导入文件夹（各自根目录）+ 若干下载来的歌 + 单曲导入的。
   路径用 Windows 反斜杠，跟真机一致。 */
const ROOT_A = 'D:\\Music\\专辑A';
const ROOT_B = 'E:\\歌单B';
const DL_DIR = 'C:\\Users\\Neko\\Music\\NekoMusic';

const FILES_A = [
  { path: 'D:\\Music\\专辑A\\第一首.m4a', folderRoot: ROOT_A, src: 'folder' },
  { path: 'D:\\Music\\专辑A\\第二首.mp3', folderRoot: ROOT_A, src: 'folder' },
  { path: 'D:\\Music\\专辑A\\子目录\\第三首.flac', folderRoot: ROOT_A, src: 'folder' },
];
const FILES_B = [
  { path: 'E:\\歌单B\\甲.mp3', folderRoot: ROOT_B, src: 'folder' },
  { path: 'E:\\歌单B\\乙.m4a', folderRoot: ROOT_B, src: 'folder' },
];
const DL_FILES = [
  { path: DL_DIR + '\\下好的1.m4a', src: 'download', bvid: 'BV1aaa', key: 'BV1aaa:1' },
  { path: DL_DIR + '\\下好的2.m4a', src: 'download', bvid: 'BV1bbb', key: 'BV1bbb:2' },
];
const IMPORTED = [
  { path: 'D:\\散装\\单曲导入的.mp3', src: 'file' },
];

let pickFilesResult = null;
let pickFolderResult = null;
let missingPaths = new Set();
let saveCalls = 0;

/* ---------- 其余必需桩 ---------- */
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => { saveCalls += 1; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=https%3A%2F%2Fexample.invalid%2Fa.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});

let win = null;

/* v2.8.0：下载 IPC 桩（本脚本把"页面有报错"直接判 FAIL，缺桩会被当成产品坏了）。 */
require('./stub-download-ipc.js')();

/* ★ 共享桩里已经注册了 local:pickFiles / local:pickFolder / local:stat。
   本脚本要按用例改它们，先摘掉共享那份，再注册自己的。
   返回**必须包成 { ok:true, data }**（界面 api() 解的就是这层壳）。 */
for (const ch of ['local:pickFiles', 'local:pickFolder', 'local:stat']) {
  try { ipcMain.removeHandler(ch); } catch (_) {}
}
ipcMain.handle('local:pickFiles', () => ({ ok: true, data: pickFilesResult }));
// ★ 这次的 pickFolder 要**带 root**（左栏分组靠它），跟真实 main.js 的新返回形状一致。
ipcMain.handle('local:pickFolder', () => ({ ok: true, data: pickFolderResult }));
ipcMain.handle('local:stat', (_e, paths) => {
  const arr = Array.isArray(paths) ? paths : [paths];
  return { ok: true, data: arr.map((p) => {
    const s = String(p || '');
    const miss = missingPaths.has(s);
    return { path: s, exists: !miss, size: miss ? 0 : 4211000 };
  }) };
});

/** 用给定条目把本地库整成"一条路径一条记录"的样子（id/addedAt 自动补）。 */
const seedLib = (entries) => eval2(`(() => {
  DB.local = ${JSON.stringify(entries)}.map((e, i) => Object.assign({
    id: 'id' + i, title: (e.path.split(/[\\\\/]/).pop() || '').replace(/\\.[^.]+$/, ''),
    author: '', cover: '', duration: 0, size: 4211000,
    key: '', bvid: null, cid: null, addedAt: i,
  }, e));
  currentView = 'local';
  localFilter = 'all';
  localPick = null;
  renderAll();
  return true;
})()`);

let eval2 = null;

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败/i.test(msg)) {
      errors.push('[主窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  eval2 = evalJS;
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  /** 按 data-lgroup 值点左栏（★ 走 querySelector 的 dataset 比对，避免把路径里的反斜杠塞进 CSS 选择器）。 */
  const clickFolder = (gid) => evalJS(`(() => {
    const el = [...document.querySelectorAll('#content .local-folder-row')].find((r) => r.dataset.lgroup === ${JSON.stringify(gid)});
    if (!el) return false; el.click(); return true;
  })()`);
  const clickFolderDel = (root) => evalJS(`(() => {
    const el = [...document.querySelectorAll('#content .local-folder-row [data-lrmfolder]')].find((r) => r.dataset.lrmfolder === ${JSON.stringify(root)});
    if (!el) return false; el.click(); return true;
  })()`);

  /* 读本地页当前结构（★ 全部走 typeof 兜底：改前的代码上没有这些函数/元素，
     会老实报 FAIL 而不是把整轮炸掉）。 */
  const readLocal = () => evalJS(`(() => {
    const rows = [...document.querySelectorAll('#content .local-main .track')];
    const folderRows = [...document.querySelectorAll('#content .local-folder-row')];
    const hasSide = !!document.querySelector('#content .local-side');
    const mainHead = document.querySelector('#content .local-main-head .lm-title');
    const bar = document.querySelector('#content .local-bar');
    const pick = (typeof localPick === 'undefined') ? 'undef' : (localPick ? { n: localPick.selected.size, keys: [...localPick.selected.keys()] } : null);
    return {
      hasSide,
      folderCount: folderRows.length,
      folderNames: folderRows.map((r) => (r.querySelector('.nm') || {}).textContent || ''),
      folderIds: folderRows.map((r) => r.dataset.lgroup || ''),
      folderDelBtns: folderRows.filter((r) => !!r.querySelector('[data-lrmfolder]')).length,
      activeFolder: (folderRows.find((r) => r.classList.contains('active')) || {}).dataset ? (folderRows.find((r) => r.classList.contains('active')) || {}).dataset.lgroup : null,
      mainTitle: mainHead ? mainHead.textContent : '',
      rows: rows.length,
      rowPaths: rows.map((r) => {
        const i = Number(r.dataset.i);
        const t = (typeof currentTracks === 'function') ? currentTracks()[i] : null;
        return t ? (t.localPath || '') : '';
      }),
      pickable: document.querySelectorAll('#content .track.pickable').length,
      pickedRows: document.querySelectorAll('#content .track.picked').length,
      hasBar: !!bar,
      barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
      pickBtn: !!document.getElementById('btnLocalPick'),
      pickBtnOn: !!document.querySelector('.block-actions .ghost-btn.on#btnLocalPick'),
      cv: (typeof currentView === 'undefined') ? '?' : currentView,
      filter: (typeof localFilter === 'undefined') ? '?' : localFilter,
      libSize: (typeof DB !== 'undefined' && DB.local) ? DB.local.length : -1,
      pick,
    };
  })()`);

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(900);
    await evalJS(`(() => {
      const a = document.getElementById('audio');
      a.play = () => { window.__playingSrc = a.src; return Promise.resolve(); };
      Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  const ALL = [...DL_FILES, ...FILES_A, ...FILES_B, ...IMPORTED];

  /* ================= 1) 左栏存在 + 「全部歌曲」行 ================= */
  say('\n[1] 左栏存在：「文件夹」列表 + 「全部歌曲」行：');
  {
    await seedLib(ALL);
    await sleep(250);
    const s = await readLocal();
    if (s.hasSide) ok('★ 有左栏 .local-side'); else bad('没有左栏（.local-side 不存在）');
    if (s.folderCount >= 1) ok('左栏画出了文件夹行（' + s.folderCount + ' 行）'); else bad('左栏一行都没有');
    if (s.folderIds[0] === 'all') ok('第一行是「全部歌曲」'); else bad('第一行不是 all（' + s.folderIds[0] + '）');
    if (s.rows === ALL.length) ok('右栏「全部歌曲」下显示全部 ' + ALL.length + ' 首'); else bad('右栏行数不对：' + s.rows + '（应为 ' + ALL.length + '）');
    if (s.mainTitle === '全部歌曲') ok('右栏标题是「全部歌曲」'); else bad('右栏标题不对：「' + s.mainTitle + '」');
  }

  /* ================= 2) 分组：下载 / 两个文件夹 / 单曲导入 ================= */
  say('\n[2] ★ 按来源分组（本地下载 / 各文件夹 / 导入的歌曲）：');
  {
    const s = await readLocal();
    const ids = s.folderIds;
    if (ids.includes('download')) ok('★ 有「本地下载」分组'); else bad('没有 download 分组（ids=' + JSON.stringify(ids) + '）');
    if (ids.includes('folder:' + ROOT_A)) ok('★ 有「专辑A」这个文件夹分组'); else bad('没有 ROOT_A 文件夹分组');
    if (ids.includes('folder:' + ROOT_B)) ok('★ 有「歌单B」这个文件夹分组'); else bad('没有 ROOT_B 文件夹分组');
    if (ids.includes('imported')) ok('★ 单曲导入归到「导入的歌曲」分组'); else bad('没有 imported 分组');
    // 名字取"最后一级目录名"
    if (s.folderNames.includes('专辑A')) ok('文件夹分组标题取的是目录名（专辑A）'); else bad('分组标题没取目录名：' + JSON.stringify(s.folderNames));
    // 「本地下载」的曲目数应等于 DL_FILES 长度 —— 用点进去看行数来验（见下一组）
    // 组数 = all + download + imported + 2 个文件夹 = 5
    if (s.folderCount === 5) ok('左栏共 5 行（全部 + 下载 + 导入 + 2 文件夹）'); else bad('左栏行数不对：' + s.folderCount + '（应为 5）');
  }

  /* ================= 3) 点左栏切分组 ================= */
  say('\n[3] ★ 点「本地下载」→ 右栏只剩下载来的歌：');
  {
    await click('#content .local-folder-row[data-lgroup="download"]');
    await sleep(250);
    const s = await readLocal();
    if (s.filter === 'download') ok('筛选变量切到 download'); else bad('localFilter 没切（' + s.filter + '）');
    if (s.rows === DL_FILES.length) ok('★ 右栏只剩 ' + DL_FILES.length + ' 首下载来的歌'); else bad('右栏行数不对：' + s.rows + '（应为 ' + DL_FILES.length + '）');
    if (s.mainTitle === '本地下载') ok('右栏标题跟着变成「本地下载」'); else bad('右栏标题不对：「' + s.mainTitle + '」');
    // 每个路径都应是下载目录下的
    const allDl = s.rowPaths.every((p) => p.indexOf(DL_DIR) === 0);
    if (allDl) ok('★ 右栏每一首都在下载目录下（没有混进导入的）'); else bad('混进了非下载曲目：' + JSON.stringify(s.rowPaths));

    // 再点「专辑A」
    await clickFolder('folder:' + ROOT_A);
    await sleep(250);
    const s2 = await readLocal();
    if (s2.rows === FILES_A.length) ok('★ 点「专辑A」→ 只剩该文件夹的 ' + FILES_A.length + ' 首（含子目录）'); else bad('专辑A 分组行数不对：' + s2.rows);
    if (s2.activeFolder === 'folder:' + ROOT_A) ok('该文件夹行被标成 active'); else bad('active 没落到「专辑A」上');
  }

  /* ================= 4) 单曲导入归「导入的歌曲」 ================= */
  say('\n[4] ★ 点「导入的歌曲」→ 只剩单曲导入的那首：');
  {
    await click('#content .local-folder-row[data-lgroup="imported"]');
    await sleep(250);
    const s = await readLocal();
    if (s.rows === IMPORTED.length) ok('★ 只剩单曲导入的 ' + IMPORTED.length + ' 首'); else bad('导入的歌曲分组行数不对：' + s.rows);
    if (s.rowPaths[0] === IMPORTED[0].path) ok('★ 正是那首单曲导入的歌'); else bad('不是那首：「' + s.rowPaths[0] + '」');
  }

  /* ================= 5) 文件夹组的 ✕ ================= */
  say('\n[5] ★ 文件夹组的 ✕：只删该组记录：');
  {
    // ★ 先点进「专辑A」再删它 —— 这样才能顺带验证"删掉正在看的分组会自动退回全部"。
    await clickFolder('folder:' + ROOT_A);
    await sleep(200);
    const before = await readLocal();
    if (before.filter === 'folder:' + ROOT_A) ok('先停到「专辑A」分组上'); else bad('没能停到「专辑A」（' + before.filter + '）');
    if (before.folderDelBtns >= 2) ok('两个文件夹组各有一个 ✕'); else bad('✕ 数量不对：' + before.folderDelBtns);

    // 点「专辑A」那行的 ✕
    await clickFolderDel(ROOT_A);
    await sleep(200);
    // 确认框 -> 点「移除」
    await click('#promptOk');
    await sleep(350);
    const s = await readLocal();
    const want = ALL.length - FILES_A.length;
    if (s.libSize === want) ok('★ 只移除了「专辑A」的 ' + FILES_A.length + ' 条（' + ALL.length + '→' + want + '）'); else bad('移除条数不对：' + s.libSize + '（应为 ' + want + '）');
    const stillHasDL = s.folderIds.includes('download');
    const stillHasB = s.folderIds.includes('folder:' + ROOT_B);
    const goneA = !s.folderIds.includes('folder:' + ROOT_A);
    if (stillHasDL && stillHasB && goneA) ok('★ 其他分组原封不动（下载 / 歌单B 还在，「专辑A」消失）'); else bad('误伤了别的分组：' + JSON.stringify(s.folderIds));
    if (s.filter === 'all') ok('★ 删掉正在看的分组 → 自动退回「全部歌曲」'); else bad('删完没回 all（' + s.filter + '）');
    if (s.rows === want) ok('右栏跟着切到全部 ' + want + ' 首'); else bad('右栏行数不对：' + s.rows);
  }

  /* ================= 6) 批量选择：进勾选态，默认全不勾 ================= */
  say('\n[6] 「批量选择」按钮：点开进入勾选态、默认一个都不勾：');
  {
    const s0 = await readLocal();
    if (s0.pickBtn) ok('右上角有「批量选择」按钮'); else bad('没有 btnLocalPick');
    if (!s0.hasBar && !s0.pickable) ok('未进勾选态时没有工具条、也没有勾选框'); else bad('没进勾选态却已经有勾选框/工具条');

    await click('#btnLocalPick');
    await sleep(250);
    const s1 = await readLocal();
    if (s1.pick && s1.pick.n === 0) ok('★ 进勾选态，默认 0 个被勾'); else bad('进勾选态后选中数不为 0（' + JSON.stringify(s1.pick) + '）');
    if (s1.pickable === s1.rows) ok('★ 每一行都变成可选（.track.pickable）'); else bad('pickable 行数不对：' + s1.pickable + ' / ' + s1.rows);
    if (s1.hasBar) ok('出现批量工具条'); else bad('没有批量工具条');
    if (s1.pickBtnOn) ok('「批量选择」按钮切成"已进入"态（.on）'); else bad('按钮没切成 .on');
  }

  /* ================= 7) 勾选用 localPath ================= */
  say('\n[7] ★ 勾选按 localPath 记（本地歌没有 bvid）：');
  {
    await click('#content .track[data-i="0"]');
    await sleep(200);
    const s = await readLocal();
    const t0 = s.rowPaths[0];
    if (s.pick && s.pick.n === 1 && s.pick.keys[0] === t0) ok('★ 勾上的键 = 那行的 localPath（不是 bvid）'); else bad('选择集键不对：' + JSON.stringify(s.pick) + '，期望 ' + t0);
    if (s.pickedRows === 1) ok('那一行画上了 .picked'); else bad('picked 行数不对：' + s.pickedRows);
    // 再点一次取消
    await click('#content .track[data-i="0"]');
    await sleep(200);
    const s2 = await readLocal();
    if (s2.pick && s2.pick.n === 0) ok('再点一次 → 取消勾选'); else bad('取消勾选失败');
  }

  /* ================= 8) 全选 / 清空只作用于当前分组 ================= */
  say('\n[8] ★ 全选 / 清空只作用于当前分组：');
  {
    // ★ 关键：必须**停在一个子分组**上，全选才可能"跨组" —— 停在「全部歌曲」上时
    //   "全选 = 全部"本来就是对的，验不出跨组 bug。先点进「本地下载」（2 首）。
    await clickFolder('download');
    await sleep(200);
    await click('#btnLocalPick');   // 换分组会退出勾选态，重新进
    await sleep(200);
    const s1 = await readLocal();
    if (s1.filter === 'download' && s1.rows === DL_FILES.length) ok('停到「本地下载」分组（' + DL_FILES.length + ' 首）'); else bad('没停到下载分组（' + s1.filter + ' / ' + s1.rows + '）');

    await click('#btnLocalPickAll');
    await sleep(250);
    const s2 = await readLocal();
    const cur = s2.rows;
    if (s2.pick && s2.pick.n === cur) ok('★ 全选 = 当前分组全部 ' + cur + ' 首'); else bad('全选数量不对：' + (s2.pick && s2.pick.n) + ' / ' + cur);
    const total = await evalJS('(() => DB.local.length)()');
    if (s2.pick && s2.pick.n < total) ok('★ 没有跨分组全选（总数 ' + total + '，只选了当前组 ' + s2.pick.n + '）'); else bad('全选跨组了（选了 ' + (s2.pick && s2.pick.n) + ' / 总 ' + total + '）');
    if (s2.pickedRows === cur) ok('★ 被勾的正好是右栏那 ' + cur + ' 行（没有隔空勾到别的组）'); else bad('picked 行数不对：' + s2.pickedRows);

    await click('#btnLocalPickNone');
    await sleep(200);
    const s3 = await readLocal();
    if (s3.pick && s3.pick.n === 0) ok('清空选择生效'); else bad('清空失败');
  }

  /* ================= 9) 移出库 ================= */
  say('\n[9] ★ 「移出库」：只移除选中的：');
  {
    // ★ 先回「全部歌曲」，保证右栏行数够勾两首（上一组结束时停在 imported 分组，只有 1 行）。
    //   ★★ 换分组会**自动退出勾选态**（这是产品行为），所以回来之后要重新点一次「批量选择」。
    await clickFolder('all');
    await sleep(200);
    await click('#btnLocalPick');
    await sleep(200);
    const before = await readLocal();
    if (before.pick) ok('回到「全部歌曲」并重新进入勾选态'); else bad('没能重新进入勾选态');
    const beforeLib = before.libSize;
    // 勾前两行
    await click('#content .track[data-i="0"]');
    await sleep(150);
    await click('#content .track[data-i="1"]');
    await sleep(150);
    const s1 = await readLocal();
    if (s1.pick && s1.pick.n === 2) ok('勾了 2 首'); else bad('勾选数不对：' + (s1.pick ? s1.pick.n : 'null'));

    await click('#btnLocalRemove');
    await sleep(200);
    await click('#promptOk');   // 确认
    await sleep(350);
    const s2 = await readLocal();
    if (s2.libSize === beforeLib - 2) ok('★ 库里正好少了 2 条（' + beforeLib + '→' + s2.libSize + '）'); else bad('移出条数不对：' + s2.libSize + '（应为 ' + (beforeLib - 2) + '）');
    if (!s2.pick) ok('★ 移出后自动退出勾选态'); else bad('移出后还在勾选态');
  }

  /* ================= 10) 换分组自动退出勾选 ================= */
  say('\n[10] ★ 切换分组 → 自动退出勾选态：');
  {
    // 先重播一份数据，保证分组齐全
    await seedLib(ALL);
    await sleep(200);
    await click('#btnLocalPick');
    await sleep(150);
    const s1 = await readLocal();
    if (s1.pick) ok('先进了勾选态'); else bad('没能进勾选态');
    await click('#content .local-folder-row[data-lgroup="download"]');
    await sleep(250);
    const s2 = await readLocal();
    if (!s2.pick) ok('★ 换分组后自动退出勾选态'); else bad('换分组后还在勾选态');
  }

  /* ================= 11) 离开本地页自动退出勾选 ================= */
  say('\n[11] ★ 离开本地页 → 自动退出勾选态：');
  {
    await click('#btnLocalPick');
    await sleep(150);
    await click('.nav-item[data-view="favorites"]');
    await sleep(250);
    const cv = await evalJS('(() => currentView)()');
    const lp = await evalJS('(() => (typeof localPick === "undefined") ? "undef" : (localPick ? "on" : "off"))()');
    if (cv === 'favorites') ok('切到了「我喜欢」'); else bad('没切过去（' + cv + '）');
    if (lp === 'off') ok('★ 离开本地页后 localPick 被清空'); else bad('离开后 localPick 仍是 ' + lp);
  }

  /* ================= 12) 页面报错 ================= */
  say('\n[12] 页面控制台报错：');
  if (errors.length) {
    bad('页面有报错：');
    errors.slice(0, 6).forEach((e) => say('       ' + e));
  } else ok('全程没有页面报错');

  say('');
  if (fail === 0) { say('本地文件夹列表 + 批量选择实测：全部通过 ✅'); finish(0); }
  else { say('有 ' + fail + ' 项没过 ❌'); finish(1); }
});
