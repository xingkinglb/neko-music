/* 第二十轮：本地歌曲库实测（v2.8.0 批次 B，离屏渲染 + 真跑应用代码）

   批次 B 把"下载来的歌 + 从硬盘导入的歌"合成一个曲库。本脚本盯的是**行为**，
   不是文本断言 —— 用离屏浏览器真跑 app.js，点真按钮、看真结果。

   ★ 判别力：这一组在批次 B 之前的代码上会**整组失败** ——
     那时没有 importLocal / renderLocal / localTrack，也没有 data-view="local" 导航项，
     `typeof importLocal === 'undefined'` 会让每条断言老老实实报 FAIL（而不是崩掉）。

   量什么：
     [1]  侧栏有「本地歌曲」导航项，点进去是空库状态（两个导入按钮）
     [2]  导入歌曲（多选）→ 3 首进库，列表 3 行，统计「3 首」
     [3]  ★ 去重：同一个路径再导入一次 → 库里还是 3 首（不重复加）
     [4]  导入文件夹 → 递归扫进来的都进库，且**标了 truncated**时如实提示
     [5]  ★ sameTrack 本地歌按路径判定：同一路径算同一首；不同路径不算
     [6]  ★ 收藏一首本地歌 → 我喜欢里出现；再取消 → 消失（走 sameTrack）
     [7]  点本地歌行 → 队列里是它，且播放地址是 local://get（不是 B 站地址）
     [8]  ★ 失效：localStat 说文件没了 → 列表标 .missing + 顶部黄条
     [9]  ★ 「清理失效项」→ 失效记录从库里移除、黄条消失
     [10] 本地歌行**没有**下载按钮（dlBtnHTML 对没有 bvid 的行返回空）
     [11] 全程没有页面报错

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
const REPORT = path.join(__dirname, 'test-round20-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ---------- 桩数据：本地文件路径（不真读盘，主进程桩自己说了算） ---------- */
const DIR = 'D:\\Music';
const P1 = DIR + '\\距离隔不开.m4a';
const P2 = DIR + '\\晚风.mp3';
const P3 = DIR + '\\旧巷子.flac';
const FOLDER_FILES = [P1, P2, 'D:\\Music\\专辑A\\第一首.m4a', 'D:\\Music\\专辑A\\第二首.mp3'];

/* 主进程桩的可变开关 */
let pickFilesResult = null;      // 下次 local:pickFiles 返回什么
let pickFolderResult = null;     // 下次 local:pickFolder 返回什么
let missingPaths = new Set();    // 哪些路径 localStat 要说"不存在"
let localStatCalls = 0;
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

/* ★ 共享桩里已经把 local:pickFiles / local:pickFolder / local:stat 都注册了。
   本脚本要按用例改这三个的返回值，所以先把共享桩那份**摘掉**，再注册自己的版本
   （Electron 同一个 channel 注册两次会抛 "second handler"，必须先 remove）。
   ★ 返回**必须包成 { ok:true, data }** —— 界面 api() 解的就是这层壳（真实 main.js 的
     handle() 也这么包），返回裸值会被 api() 当成失败。 */
for (const ch of ['local:pickFiles', 'local:pickFolder', 'local:stat']) {
  try { ipcMain.removeHandler(ch); } catch (_) {}
}
ipcMain.handle('local:pickFiles', () => ({ ok: true, data: pickFilesResult }));
ipcMain.handle('local:pickFolder', () => ({ ok: true, data: pickFolderResult }));
ipcMain.handle('local:stat', (_e, paths) => {
  localStatCalls += 1;
  const arr = Array.isArray(paths) ? paths : [paths];
  return { ok: true, data: arr.map((p) => {
    const s = String(p || '');
    const miss = missingPaths.has(s);
    return { path: s, exists: !miss, size: miss ? 0 : 4211000 };
  }) };
});

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
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

  /* 读本地页当前状态（★ 用 typeof 兜底：批次 B 之前的代码上 importLocal 不存在，
     这样会老实报 FAIL 而不是抛 ReferenceError 把整轮炸掉）。 */
  const readLocal = () => evalJS(`(() => {
    const rows = [...document.querySelectorAll('#content .track')];
    const hasNav = !!document.querySelector('.nav-item[data-view="local"]');
    const st = (typeof DB !== 'undefined' && DB.local) ? DB.local : [];
    return {
      hasNav,
      view: currentView,
      libSize: st.length,
      paths: st.map((e) => e.path),
      missingFlags: st.map((e) => !!e.missing),
      rows: rows.length,
      missingRows: rows.filter((r) => r.classList.contains('missing')).length,
      missChips: document.querySelectorAll('#content .miss-chip').length,
      hasWarn: !!document.querySelector('#content .local-warn'),
      hasEmpty: !!document.querySelector('#content .local-empty'),
      emptyTitle: (document.querySelector('#content .local-empty-title') || {}).textContent || '',
      headTitle: (document.querySelector('#content .block-title') || {}).textContent || '',
      headSub: (document.querySelector('#content .block-sub') || {}).textContent || '',
      importBtns: !!document.getElementById('btnLocalImportFiles') && !!document.getElementById('btnLocalImportFolder'),
      rowDownloadBtns: document.querySelectorAll('#content .track .op-ic[data-act="download"]').length,
      firstTitle: rows.length ? (rows[0].querySelector('.t') || {}).textContent : '',
    };
  })()`);

  const readQueue = () => evalJS(`(() => {
    const q = (typeof queue === 'undefined') ? null : queue;
    const a = document.getElementById('audio');
    return {
      size: q ? q.tracks.length : -1,
      firstLocalPath: q && q.tracks[0] ? (q.tracks[0].localPath || '') : '',
      firstTitle: q && q.tracks[0] ? (q.tracks[0].title || '') : '',
      src: (a && a.src) || '',
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

  /* ================= 1) 导航项 + 空库状态 ================= */
  say('\n[1] 侧栏「本地歌曲」导航项 + 空库状态：');
  {
    const s0 = await readLocal();
    if (s0.hasNav) ok('侧栏有「本地歌曲」导航项'); else bad('侧栏**没有**「本地歌曲」导航项（data-view="local"）');
    await click('.nav-item[data-view="local"]');
    await sleep(300);
    const s1 = await readLocal();
    if (s1.view === 'local') ok('点导航项切到了本地歌曲页'); else bad('点了导航项没切过来（currentView=' + s1.view + '）');
    if (s1.hasEmpty) ok('空库时显示空状态'); else bad('空库时没有空状态');
    if (/还没有本地歌曲/.test(s1.emptyTitle)) ok('空状态文案是「还没有本地歌曲」'); else bad('空状态文案不对：「' + s1.emptyTitle + '」');
    if (s1.importBtns) ok('空库状态有「导入歌曲」「导入文件夹」两个按钮'); else bad('空状态缺导入按钮');
  }

  /* ================= 2) 导入歌曲（多选） ================= */
  say('\n[2] 导入歌曲（多选 3 个文件）：');
  pickFilesResult = { paths: [P1, P2, P3], truncated: false };
  await click('#btnLocalImportFiles');
  await sleep(500);
  {
    const s = await readLocal();
    if (s.libSize === 3) ok('3 首进了本地库'); else bad('库里条目数不对：' + s.libSize + '（应为 3）');
    if (s.view === 'local') ok('导入后停在本地歌曲页'); else bad('导入后没停在本地页（view=' + s.view + '）');
    if (s.rows === 3) ok('列表画出 3 行'); else bad('列表行数不对：' + s.rows);
    if (/3 首/.test(s.headSub)) ok('统计显示「3 首」'); else bad('统计不对：「' + s.headSub + '」');
    if (/距离隔不开/.test(s.firstTitle)) ok('标题取的是文件名（距离隔不开）'); else bad('标题不对：「' + s.firstTitle + '」');
    if (s.rowDownloadBtns === 0) ok('本地歌行**没有**下载按钮（没有 bvid 就不画）'); else bad('本地歌行多出了 ' + s.rowDownloadBtns + ' 个下载按钮');
  }

  /* ================= 3) 去重：同一路径再导入 ================= */
  say('\n[3] ★ 去重：同一路径再导入一次：');
  pickFilesResult = { paths: [P1, P2, P3, DIR + '\\新歌.m4a'], truncated: false };
  await click('#btnLocalImportFiles');
  await sleep(500);
  {
    const s = await readLocal();
    if (s.libSize === 4) ok('★ 只新增了那一首新的（3→4），重复的没再加'); else bad('去重失效：库里有 ' + s.libSize + ' 条（应为 4）');
  }

  /* ================= 4) 导入文件夹（递归 + 截断提示） ================= */
  say('\n[4] 导入文件夹（递归扫进来）：');
  // 先把库清空，便于验证文件夹导入的结果
  await evalJS(`(() => { DB.local = []; rebuildDlKeys && rebuildDlKeys(); })()`);
  pickFolderResult = { paths: FOLDER_FILES, truncated: false };
  await click('#btnLocalImportFolder');
  await sleep(500);
  {
    const s = await readLocal();
    if (s.libSize === FOLDER_FILES.length) ok('文件夹里的 ' + FOLDER_FILES.length + ' 个文件都进了库（含子目录）'); else bad('文件夹导入条目数不对：' + s.libSize + '（应为 ' + FOLDER_FILES.length + '）');
  }
  // 截断提示
  await evalJS(`(() => { DB.local = []; })()`);
  pickFolderResult = { paths: [P1], truncated: true };
  await click('#btnLocalImportFolder');
  await sleep(500);
  {
    const toastTxt = await evalJS(`(() => { const t = document.querySelector('#toast, .toast'); return t ? t.textContent : ''; })()`);
    if (/5000|前 5000/.test(toastTxt)) ok('文件夹太大被截断时有如实提示'); else bad('截断时没有提示（toast：「' + toastTxt + '」）');
  }

  /* ================= 5) sameTrack：本地歌按路径判定 ================= */
  say('\n[5] ★ sameTrack 本地歌按路径判定：');
  {
    const r = await evalJS(`(() => {
      if (typeof sameTrack === 'undefined') return { err: 'no-sameTrack' };
      const a = { localPath: 'D:\\\\Music\\\\a.m4a' };
      const b = { localPath: 'D:\\\\Music\\\\a.m4a' };
      const c = { localPath: 'D:\\\\Music\\\\b.m4a' };
      const remote = { bvid: 'BV1', cid: 7 };
      const remote2 = { bvid: 'BV1', cid: 7 };
      const remote3 = { bvid: 'BV1', cid: 8 };
      return {
        sameLocal: sameTrack(a, b),
        diffLocal: sameTrack(a, c),
        localVsRemote: sameTrack(a, remote),
        sameRemote: sameTrack(remote, remote2),
        diffRemote: sameTrack(remote, remote3),
      };
    })()`);
    if (r.err) bad('找不到 sameTrack');
    else {
      if (r.sameLocal) ok('★ 同一路径 = 同一首'); else bad('同一路径没认成同一首');
      if (!r.diffLocal) ok('不同路径 = 不同首'); else bad('不同路径被误判成同一首');
      if (!r.localVsRemote) ok('本地歌 vs B 站歌 = 不同首（不会互相撞）'); else bad('本地歌和 B 站歌被误判成同一首');
      if (r.sameRemote) ok('B 站歌回归：同 bvid+cid 仍算同一首'); else bad('B 站歌的原有判定被改坏了');
      if (!r.diffRemote) ok('B 站歌回归：不同 cid 仍是不同首'); else bad('B 站歌不同 cid 被误判');
    }
  }

  /* ================= 6) 收藏本地歌 → 我喜欢 ================= */
  say('\n[6] ★ 收藏一首本地歌（走 sameTrack）：');
  await evalJS(`(() => { DB.local = [{ id:'x1', path:'D:\\\\Music\\\\收藏这首.m4a', title:'收藏这首', author:'', cover:'', duration:0, size:0, src:'file', key:'', bvid:null, cid:null, addedAt:Date.now() }]; currentView='local'; renderAll(); })()`);
  await sleep(200);
  await click('#content .track[data-i="0"] .op-ic[data-act="fav"]');
  await sleep(300);
  {
    const r = await evalJS(`(() => ({ favs: DB.favorites.length, favTitle: DB.favorites[0] ? DB.favorites[0].title : '', favPath: DB.favorites[0] ? (DB.favorites[0].localPath || '') : '' }))()`);
    if (r.favs === 1 && /收藏这首/.test(r.favTitle)) ok('★ 点了收藏 → 进了「我喜欢」'); else bad('收藏本地歌失败（favs=' + r.favs + '）');
    if (r.favPath) ok('★ 收藏的是本地歌（带 localPath），sameTrack 认得它'); else bad('收藏进去的条目丢了 localPath');
  }
  // 再点一次取消
  await click('#content .track[data-i="0"] .op-ic[data-act="fav"]');
  await sleep(300);
  {
    const n = await evalJS(`(() => DB.favorites.length)()`);
    if (n === 0) ok('再点一次 → 取消收藏（仍在「我喜欢」里）'); else bad('取消收藏失败（favs=' + n + '）');
  }

  /* ================= 7) 点本地歌行 → 队列 + local:// 地址 ================= */
  say('\n[7] 点本地歌行 → 播它，地址走 local://：');
  await click('#content .track[data-i="0"]');
  await sleep(400);
  {
    const q = await readQueue();
    if (q.size === 1) ok('队列只有这一首'); else bad('队列曲目数不对：' + q.size);
    if (/收藏这首/.test(q.firstTitle)) ok('队列里是点的那首本地歌'); else bad('队列里不是本地歌：「' + q.firstTitle + '」');
    if (/^local:\/\/get\?p=/.test(q.src)) ok('★ 播放地址是 local://get?p=…（不是 B 站地址）'); else bad('播放地址不对：「' + q.src + '」');
    if (/encodeURIComponent|%5C|%3A/.test(q.src) || q.src.indexOf('%') >= 0) ok('★ 路径被 URL 编码（反斜杠/冒号没错乱）'); else bad('路径没被编码：「' + q.src + '」');
  }

  /* ================= 8) 失效标记 ================= */
  say('\n[8] ★ 文件被挪走 → 标失效 + 顶部黄条：');
  await evalJS(`(() => { DB.local = [
    { id:'m1', path:'D:\\\\Music\\\\还在的.m4a', title:'还在的', author:'', cover:'', duration:0, size:0, src:'file', key:'', bvid:null, cid:null, addedAt:1 },
    { id:'m2', path:'D:\\\\Music\\\\没了的.m4a', title:'没了的', author:'', cover:'', duration:0, size:0, src:'file', key:'', bvid:null, cid:null, addedAt:2 }
  ]; currentView='local'; })()`);
  missingPaths = new Set(['D:\\Music\\没了的.m4a']);
  // 模拟"再进一次本地页" → 触发 checkLocalMissing
  await click('.nav-item[data-view="favorites"]');
  await sleep(200);
  await click('.nav-item[data-view="local"]');
  await sleep(500);
  {
    const s = await readLocal();
    if (s.missingRows === 1) ok('★ 找不到的那首标了 .missing'); else bad('失效行数不对：' + s.missingRows);
    if (s.missChips === 1) ok('失效行挂了「文件不见了」小标'); else bad('失效小标数不对：' + s.missChips);
    if (s.hasWarn) ok('★ 顶部出现失效黄条'); else bad('没有失效黄条');
    if (s.libSize === 2) ok('★ 只标记、不删记录（库里还是 2 条）'); else bad('记录被误删了（库里 ' + s.libSize + ' 条）');
  }

  /* ================= 9) 清理失效项 ================= */
  say('\n[9] ★ 「清理失效项」：');
  await click('#btnLocalClean');
  await sleep(400);
  {
    const s = await readLocal();
    if (s.libSize === 1) ok('★ 失效记录被清掉（2→1）'); else bad('清理后条目数不对：' + s.libSize);
    if (!s.hasWarn) ok('黄条消失'); else bad('清理后黄条还在');
    if (s.missingRows === 0) ok('不再有失效行'); else bad('还有失效行');
  }

  /* ================= 10) 本地歌行没有下载按钮（已在上方 [2] 验过一遍，这里换库再确认） ================= */
  say('\n[10] 本地歌行的下载按钮：');
  {
    const s = await readLocal();
    if (s.rowDownloadBtns === 0) ok('本地歌行依然没有下载按钮'); else bad('本地歌行出现了下载按钮：' + s.rowDownloadBtns);
  }

  /* ================= 11) 页面报错 ================= */
  say('\n[11] 页面控制台报错：');
  if (errors.length) {
    bad('页面有报错：');
    errors.slice(0, 6).forEach((e) => say('       ' + e));
  } else ok('全程没有页面报错');

  say('');
  if (fail === 0) { say('本地歌曲库实测：全部通过 ✅'); finish(0); }
  else { say('有 ' + fail + ' 项没过 ❌'); finish(1); }
});
