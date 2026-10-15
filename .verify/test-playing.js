/* 「正在播放」高亮的实测（v2.0.3 修的 bug）：
     · 分P视频：同一支视频的每一集共用 bvid，以前只要 bvid 一样就算"在播" ——
       于是"最近播放"里播过的每一集全都点亮，看着像播放器坏了。
     · UP 合集：每一集自带 bvid，以前那条反向判断（拿"正在播的那首"的曲目表去反查）
       会把同一个合集里的其它集也一起点亮。
   现在判据是：**只有"一行代表整支视频"的入口行才跟着它里面的任意一集亮；
   摊开后的每一集是各自独立的歌，只有它自己正在播才算在播。**

   这里不是文本断言 —— 真的把 src/ui/index.html + app.js 跑起来，
   往 DB.history / DB.collectParts 里灌数据，调 renderHistory()，
   再数 DOM 里到底有几行 .track.playing。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-playing-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => { fs.appendFileSync(REPORT, m + '\n'); process.stdout.write(m + '\n'); };
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ---------- 主进程桩（够页面启动 + 不报错就行） ---------- */
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200,
          pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
/* 下载 / 本地歌曲 IPC：真实主进程都注册了（main.js 的 download:* / local:*）。
   ★ 本脚本会把"页面有报错"直接判 FAIL，不打桩的话，"桩缺了"会被当成"产品坏了"。
   统一走共享桩，与 round13~16 / test-keys 保持一致。 */
require('./stub-download-ipc.js')();

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
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2) errors.push('[页面] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  // 掐掉音频：沙箱没声卡，audio.play() 必然失败（环境产物，不是应用缺陷）
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    Object.defineProperty(a, 'paused', { configurable: true, get: () => true, set: () => {} });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
    return true;
  })()`);
  await sleep(200);

  /* ---------- 工具：灌数据 → 渲染最近播放 → 数高亮行 ---------- */
  const countPlaying = (setupJS) => evalJS(`(() => {
    ${setupJS}
    renderHistory();
    const rows = Array.from(document.querySelectorAll('#content .track'));
    const lit = rows.filter((r) => r.classList.contains('playing'));
    return {
      total: rows.length,
      lit: lit.length,
      litTitles: lit.map((r) => r.querySelector('.t').textContent),
      // 高亮那行的左边是不是"跳动的柱子"（而不是序号）—— 这是 playing 的视觉标记
      litHasBars: lit.map((r) => !!r.querySelector('.idx .bars')),
    };
  })()`);

  /* ================= 1) 分P视频：每一集共用 bvid ================= */
  say('\n[1] 分P视频（每一集共用同一个 bvid，靠 cid 区分）：');
  say('    场景 = 这次启动听了这一支视频里的第 1~6 集，正在播第 5 集；');
  say('           最近播放里这 6 集都应该只有"第 5 集"是高亮的。');

  const PART_SETUP = `
    DB.favorites = [];
    DB.collectParts = {
      BVPARTS: [1,2,3,4,5,6].map((n) => ({
        bvid: 'BVPARTS', cid: 100 + n, page: n,
        title: '分P 第' + n + '集', duration: 200, author: '喵晨音乐',
      })),
    };
    DB.history = DB.collectParts.BVPARTS.map((e) => Object.assign({}, e));   // 播过的 6 集都在历史里
    queue = { tracks: [DB.collectParts.BVPARTS[4]], index: 0, name: '合集' };  // 正在播第 5 集
  `;

  const r1 = await countPlaying(PART_SETUP);
  say(`    历史里 ${r1.total} 行，其中 ${r1.lit} 行带 .playing → ${JSON.stringify(r1.litTitles)}`);
  if (r1.total === 6 && r1.lit === 1) ok('6 集里只有正在播的那 1 集高亮（bug 已修：以前 6 集全亮）');
  else bad(`6 集里应当只有 1 集高亮，实际 ${r1.lit} 集：${JSON.stringify(r1.litTitles)}`);
  if (r1.litTitles[0] && r1.litTitles[0] === '分P 第5集') ok('高亮的正是"分P 第5集"（正在播的那一集）');
  else bad(`高亮的不是正在播的那一集：${JSON.stringify(r1.litTitles)}`);
  if (r1.litHasBars.every(Boolean)) ok('高亮行左边是"跳动的柱子"图标（视觉标记也对）');
  else bad('高亮行左边没有柱子图标 —— 视觉标记没跟上');

  /* ================= 2) 入口行仍然要跟着亮（不能改坏原有行为） ================= */
  say('\n[2] 回归：合集 / 分P 的"入口行"仍然要跟着亮：');
  say('    场景 = 发现页里那条"一行代表整支视频"的行，正在播它里面的第 5 集。');
  say('           （入口行没有 cid —— 要播的时候才去补，所以它不该被新闸门挡住。）');

  const ENTRY_SETUP = `
    DB.favorites = [];
    DB.collectParts = {
      BVPARTS: [1,2,3,4,5,6].map((n) => ({
        bvid: 'BVPARTS', cid: 100 + n, page: n,
        title: '分P 第' + n + '集', duration: 200, author: '喵晨音乐',
      })),
    };
    DB.history = [{ bvid: 'BVPARTS', title: '整支视频（入口行）', author: '喵晨音乐', duration: 1200 }];
    queue = { tracks: [DB.collectParts.BVPARTS[4]], index: 0, name: '合集' };
  `;

  const r2 = await countPlaying(ENTRY_SETUP);
  say(`    历史里 ${r2.total} 行，其中 ${r2.lit} 行带 .playing`);
  if (r2.total === 1 && r2.lit === 1) ok('入口行在"播它里面某一集"时保持高亮（原有行为没被改坏）');
  else bad(`入口行应当高亮，实际 lit=${r2.lit}`);

  /* ================= 3) UP 合集：每一集自带 bvid ================= */
  say('\n[3] UP 合集（每一集自带 bvid）：');
  say('    场景 = 合集入口行就是第 1 集（bvid 相同），正在播第 1 集；');
  say('           合集里的 3 集都在最近播放里，应该只有第 1 集高亮。');

  const SEASON_SETUP = `
    DB.favorites = [];
    DB.collectParts = {
      BVEP1: [
        { bvid: 'BVEP1', cid: 201, page: 1, title: '合集 第1集', duration: 200, author: '测试UP' },
        { bvid: 'BVEP2', cid: 202, page: 1, title: '合集 第2集', duration: 200, author: '测试UP' },
        { bvid: 'BVEP3', cid: 203, page: 1, title: '合集 第3集', duration: 200, author: '测试UP' },
      ],
    };
    DB.history = DB.collectParts.BVEP1.map((e) => Object.assign({}, e));
    queue = { tracks: [DB.collectParts.BVEP1[0]], index: 0, name: '合集' };   // 正在播第 1 集
  `;

  const r3 = await countPlaying(SEASON_SETUP);
  say(`    历史里 ${r3.total} 行，其中 ${r3.lit} 行带 .playing → ${JSON.stringify(r3.litTitles)}`);
  if (r3.total === 3 && r3.lit === 1) ok('合集 3 集里只有正在播的那 1 集高亮（反向误判那条已去掉）');
  else bad(`合集 3 集里应当只有 1 集高亮，实际 ${r3.lit} 集：${JSON.stringify(r3.litTitles)}`);

  const r3b = await countPlaying(`
    DB.favorites = [];
    DB.collectParts = {
      BVEP1: [
        { bvid: 'BVEP1', cid: 201, page: 1, title: '合集 第1集', duration: 200, author: '测试UP' },
        { bvid: 'BVEP2', cid: 202, page: 1, title: '合集 第2集', duration: 200, author: '测试UP' },
        { bvid: 'BVEP3', cid: 203, page: 1, title: '合集 第3集', duration: 200, author: '测试UP' },
      ],
    };
    DB.history = [{ bvid: 'BVEP1', title: '合集入口行', author: '测试UP', duration: 600 }];
    queue = { tracks: [DB.collectParts.BVEP1[1]], index: 0, name: '合集' };   // 正在播第 2 集
  `);
  say(`    入口行场景：${r3b.total} 行 / ${r3b.lit} 行高亮`);
  if (r3b.lit === 1) ok('UP 合集的入口行在"播它里面第 2 集"时也保持高亮');
  else bad(`UP 合集入口行应当高亮，实际 lit=${r3b.lit}`);

  /* ================= 4) 单曲 / 普通视频：不受影响 ================= */
  say('\n[4] 回归：普通单曲（没有合集）行为不变：');
  const r4 = await countPlaying(`
    DB.favorites = [];
    DB.collectParts = {};
    DB.history = [
      { bvid: 'BVA', cid: 301, title: '普通歌 A', duration: 200, author: 'UP' },
      { bvid: 'BVB', cid: 302, title: '普通歌 B', duration: 200, author: 'UP' },
      { bvid: 'BVC', cid: 303, title: '普通歌 C', duration: 200, author: 'UP' },
    ];
    queue = { tracks: [DB.history[1]], index: 0, name: '' };
  `);
  say(`    历史里 ${r4.total} 行，其中 ${r4.lit} 行带 .playing → ${JSON.stringify(r4.litTitles)}`);
  if (r4.total === 3 && r4.lit === 1 && r4.litTitles[0] === '普通歌 B') ok('普通列表里只有正在播的那一首高亮');
  else bad(`普通列表里应当只有 1 首高亮，实际 ${r4.lit}：${JSON.stringify(r4.litTitles)}`);

  /* ================= 5) 页面报错检查 ================= */
  say('\n[5] 页面控制台报错：');
  const real = errors.filter((m) => !/media|video|decode|DEMUXER|pipeline|autoplay|Audio/i.test(m));
  if (!real.length) ok('没有非预期的页面报错');
  else { bad('页面有报错：'); real.forEach((m) => say('       ' + m)); }

  say(`\n${fail ? '有 ' + fail + ' 项没过 ❌' : '全部通过 ✅'}`);
  finish(fail ? 1 : 0);
});
