/* 第九轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     · P1 歌词页透明化 —— 三档下 .lyric-overlay 背景 alpha ≤ 0.6；
                          plain / prebake 无 backdrop-filter、live 有；歌词行都有文字投影
     · P2 空歌词空状态 —— 纯音乐 / 取词失败两条路都渲染 .lyric-empty，文案不同且含歌名
     · P3 播放按钮     —— 不再有 waiting→转圈；play/pause/playing/ended/emptied 都按 audio.paused 重算
     · 三档毛玻璃 + 两个互斥开关 —— plain / prebake / live，默认 prebake，老存档一律迁 prebake
     · prebake 的"预先糊好的图" —— --glass-img 真的生成出来，面板 background-image 指向它
     · L1 / S3 省显卡 —— 遮罩 / 歌词页 / 失焦时暂停看不见的动画；播放条封面不再旋转
     · L2 —— 「正在播放」的柱子从 SVG 换成普通元素
     · v2.0.2 —— 四块框架不透明度统一成 --frame-a（视频背景四块一致且够透、图片背景四块背景层一致）、
                面板不透明度拖到 0 → 四块全透；歌词页打开时内容区隐藏（背后只剩壁纸）；
                纯色壁纸像素采样：四块面板与内容区的亮度差 == --frame-a、
                歌词页背后只剩"壁纸过一层黑纱"（都是量出来的，不是文本断言）

   ★ 沙箱没有真实 GPU（软件光栅），测不了任务管理器里那个 GPU%。
     这里只量"元素盒子 / 计算样式 / 播放状态 / 生成的图"，是相对判据；真实 GPU% 要本机对照。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
//   这只是"测试环境"的开关，不进应用代码（src/main.js 里没有这些）。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round9-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* 诊断用的裸位图 dump 目录（.tmp/ 已 gitignore）。
   自动建目录 —— 否则在"全新克隆、没有 .tmp/"的环境里会 ENOENT 把测试整跑崩。
   看图工具会有缓存（同路径重复读返回 "Image unchanged"），所以截图有疑问时
   一律 dump 裸位图、直接数像素断案。dump 失败只记一行、不影响判据。 */
const DUMP_DIR = path.join(ROOT, '.tmp');
const dump = (name, buf) => {
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, name), buf);
  } catch (e) {
    say('  (dump ' + name + ' 跳过：' + e.message + ')');
  }
};

/* ---------- 测试用的背景素材 ----------
   图片必须是"真能解码的图"：prebake 档要把它画进 canvas 再糊一遍，
   随手写几个字节的假文件会解不出来，测不到真正想测的那条路。 */
const BG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bg9-'));
const TEST_VIDEO = 'bg-test.mp4';
const TEST_IMAGE = 'bg-test.png';
const TEST_SOLID = 'bg-solid.png';
fs.writeFileSync(path.join(BG_DIR, TEST_VIDEO), Buffer.alloc(2048, 7));
fs.copyFileSync(path.join(ROOT, 'docs', 'images', 'hero.png'), path.join(BG_DIR, TEST_IMAGE));

/* 生成一张纯色 PNG（1×1 就够：CSS 的 background-size:cover 会把它拉伸成整面纯色）。
   用途：v2.0.2 的"像素级"验收 —— 纯色壁纸下，内容区与四块面板的亮度差
   就应该只剩"面板多压的那一点（--frame-a）"，可以直接量出来。 */
function solidPng(r, g, b) {
  const zlib = require('zlib');
  const table = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 位深 8 / 真彩色
  const raw = Buffer.from([0, r, g, b]);   // 1 行、filter=0、1 个像素
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(BG_DIR, TEST_SOLID), solidPng(120, 120, 120));

protocol.registerSchemesAsPrivileged([{
  scheme: 'bg',
  privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true },
}]);

const { registerBgProtocol } = require(path.join(ROOT, 'src', 'bg-protocol.js'));

/* ---------- 主进程桩 ---------- */
let lastSaved = null;
// 字幕的返回值由测试随时改：'fail' 取不到 / 'empty' 取到但没词 / 'ok' 有词
let subtitleReply = { ok: false, error: '测试环境不给字幕', reason: 'none' };

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => subtitleReply);
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', (_e, kw) => ({
  ok: true,
  data: { list: [{ bvid: 'BV1disc0001', title: kw + '·测试歌', author: '测试UP', mid: 1, cover: '', duration: '3:20' }] },
}));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', (_e, kind) => (kind === 'video'
  ? { ok: true, data: { file: TEST_VIDEO, kind: 'video', sizeMB: 0.1 } }
  : { ok: true, data: { file: TEST_IMAGE, kind: 'image', sizeMB: 0.1 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

/* ---------- 静态：源码里不该再有的东西（读文件即可，不必进渲染进程） ---------- */
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const stripLine = (s) => s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const appCode = stripLine(stripBlock(appSrc));

app.whenReady().then(async () => {
  registerBgProtocol(BG_DIR);

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
    // 假视频解不了码会报错，那是测试素材的产物，不算应用缺陷
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline/i.test(msg)) {
      errors.push('[主窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);

  /** 离屏窗口在"页面静止"之后就不再产帧，capturePage() 会一直把上一帧还给你。
      只改可见性（歌词页把 #content 藏掉）这种操作因此拍不到 —— 实测踩过：
      DOM 里 #content 已经是 visibility:hidden，截图里列表还挂在歌词页后面。
      所以这里改成"连拍"：一直拍，直到连续两张字节完全一样（说明画面追上当前 DOM）为止。 */
  const snap = async (tries = 8, gap = 200, doNudge = true) => {
    if (doNudge) await nudge();
    let prevBuf = null, last = null;
    for (let i = 0; i < tries; i++) {
      win.webContents.invalidate();
      await sleep(gap);
      last = await win.webContents.capturePage();
      const buf = last.toPNG();
      if (prevBuf && buf.equals(prevBuf)) return last;
      prevBuf = buf;
    }
    return last;
  };
  /** ★★ 比"旧帧"更阴的坑：#content 是 overflow-y:auto 的滚动容器，自带合成层。
      "隐藏它"改的是可见性，离屏软件光栅下这个合成层不会被重新光栅化 ——
      于是连拍多少张都一样，拍到的都是"还带列表"的旧图层。
      对付办法：截图前先抖一下内容区（给它的子元素加一次行内 visibility 再撤掉），
      逼这个图层重新光栅化；最后仍落在 CSS 规则决定的状态上（撤掉行内样式 = 没有行内样式）。 */
  const nudge = async () => {
    await evalJS(`(() => { const k = document.querySelector('#content > *'); if (k) k.style.visibility = 'visible'; return true; })()`);
    await sleep(150);
    await evalJS(`(() => { const k = document.querySelector('#content > *'); if (k) k.style.visibility = ''; return true; })()`);
    await sleep(200);
  };

  /** 轮询等一个条件成立（生成"预先糊好的图"是异步的，固定 sleep 容易假阴性） */
  const waitFor = async (code, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJS(`(() => { try { return !!(${code}); } catch (e) { return false; } })()`)) return true;
      await sleep(200);
    }
    return false;
  };

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1000);
    await evalJS(`(() => {
      // 掐掉音频：沙箱没声卡，audio.play() 必然失败（环境产物）
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      // src 的 getter 给一个合法 URL（不是空串）—— 给空串会让 Electron 内部的
      // 媒体代码 new URL('') 抛 "Invalid URL"，在报告里变成一条误导性的"页面报错"。
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      // ★ paused 是可读属性，这里接管成可控开关 —— 用来模拟"真的在播 / 真的停了"，
      //   否则 play() 被桩掉之后 paused 永远是 true，测不到播放中的那个分支。
      window.__paused = true;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
      // 离屏窗口的"页面可见性"在沙箱里可能是 hidden，会让暂停逻辑一直生效 ——
      // 强行按"可见"处理，才能测到播放 / 暂停的真实分支（这只是测试环境的桩）。
      window.__origHidden = document.hidden;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      // 造一首假歌的小工具
      window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
      // 未处理的 promise 拒绝：连栈一起打进报告。
      // 不挂这个监听时，Chromium 只会丢一句 "Uncaught (in promise) TypeError: …"，没有栈、很难查。
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  /* ================= 1) 歌词页透明化（P1） ================= */
  say('\n[1] 歌词页透明化（P1）：');
  const lyricStyle = () => evalJS(`(() => {
    const ov = document.getElementById('lyricOverlay');
    const cs = getComputedStyle(ov);
    const m = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor);
    const parts = m ? m[1].split(',').map((x) => parseFloat(x)) : [];
    return { alpha: parts.length === 4 ? parts[3] : 1, bf: cs.backdropFilter, bg: cs.backgroundColor };
  })()`);

  for (const mode of ['plain', 'prebake', 'live']) {
    await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
      DB.settings.glass.mode = '${mode}'; applyAppearance(); syncSettingsUI(); return true; })()`);
    await sleep(450);
    const s = await lyricStyle();
    say(`  ${mode} 档：.lyric-overlay background=${s.bg}，backdrop-filter=${s.bf}`);
    if (s.alpha <= 0.6) ok(`${mode} 档：歌词页底色 alpha=${s.alpha} ≤ 0.6（"一坨黑"已修掉）`);
    else bad(`${mode} 档：歌词页底色还是太不透明（alpha=${s.alpha}）`);
    if (mode === 'live') {
      if (/blur\(/.test(s.bf)) ok('live 档：歌词页保留真 backdrop-filter（跟着糊）');
      else bad('live 档：歌词页没有 backdrop-filter：' + s.bf);
    } else {
      if (s.bf === 'none') ok(`${mode} 档：歌词页不挂 backdrop-filter（不再每帧重算）`);
      else bad(`${mode} 档：歌词页还挂着 backdrop-filter：${s.bf}`);
    }
  }

  // 歌词行的文字投影（去掉"糊背景"之后，可读性靠它）
  subtitleReply = { ok: true, data: { lines: [{ t: 0, text: '第一句' }, { t: 5, text: '第二句' }], videoTitle: '普通歌' } };
  await evalJS(`(async () => {
    queue = { tracks: [window.__mk('BV1lyric', '普通歌')], index: 0, name: '' };
    lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
    await loadLyrics(false);
    return true; })()`);
  await sleep(300);
  const lShadow = await evalJS(`(() => {
    const l = document.querySelector('#lyricBox .l');
    return l ? getComputedStyle(l).textShadow : 'NO-LINE';
  })()`);
  say(`  歌词行的 text-shadow = ${lShadow}`);
  if (lShadow !== 'none' && lShadow !== 'NO-LINE') ok('歌词行有文字投影（不靠糊背景也能读清）');
  else bad('歌词行没有文字投影：' + lShadow);

  /* ================= 2) 空歌词空状态（P2） ================= */
  say('\n[2] 空歌词空状态（P2）：');

  // 2a) 纯音乐：取到了、但没有词
  subtitleReply = { ok: true, data: { lines: [], videoTitle: '一首纯音乐' } };
  await evalJS(`(async () => {
    queue = { tracks: [window.__mk('BV1inst', '一首纯音乐')], index: 0, name: '' };
    lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
    await loadLyrics(false);
    return true; })()`);
  await sleep(300);
  const inst = await evalJS(`(() => {
    const e = document.querySelector('#lyricBox .lyric-empty');
    return { has: !!e, text: e ? e.textContent : '', msg: e ? (e.querySelector('.le-msg') || {}).textContent : '',
             title: e ? (e.querySelector('.le-title') || {}).textContent : '',
             hasRetry: !!(e && e.querySelector('.le-retry')) };
  })()`);
  say(`  纯音乐：.lyric-empty=${inst.has}，标题「${inst.title}」，说明「${inst.msg}」，有重试按钮=${inst.hasRetry}`);
  if (inst.has) ok('纯音乐时渲染了 .lyric-empty（不再只塞一句很暗的「（没有歌词）」）');
  else bad('纯音乐时没有渲染空状态');
  if (inst.text.includes('一首纯音乐')) ok('空状态里显示了当前歌名');
  else bad('空状态里没显示歌名：' + inst.text.slice(0, 60));
  if (inst.hasRetry) ok('空状态里带「重新获取」按钮');

  // 2b) 取词失败：压根没取到
  subtitleReply = { ok: false, error: '测试环境不给字幕', reason: 'none' };
  await evalJS(`(async () => {
    queue = { tracks: [window.__mk('BV1fail', '取不到词的歌')], index: 0, name: '' };
    lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
    await loadLyrics(false);
    return true; })()`);
  await sleep(300);
  const failedState = await evalJS(`(() => {
    const box = document.getElementById('lyricBox');
    const e = box.querySelector('.lyric-empty');
    return { has: !!e, empty: box.innerHTML.trim() === '', text: e ? e.textContent : '',
             msg: e ? (e.querySelector('.le-msg') || {}).textContent : '' };
  })()`);
  say(`  取词失败：.lyric-empty=${failedState.has}，innerHTML 为空=${failedState.empty}，说明「${failedState.msg}」`);
  if (failedState.has) ok('取词失败也渲染空状态（不再是 innerHTML = "" 一片空白）');
  else bad('取词失败时歌词区还是空的');
  if (failedState.text.includes('取不到词的歌')) ok('失败态里也显示了当前歌名');
  else bad('失败态里没显示歌名');
  if (failedState.msg && inst.msg && failedState.msg !== inst.msg) ok('纯音乐 / 取词失败两种说明文字能区分');
  else bad(`两种情况说明文字一样（无法区分）：纯音乐「${inst.msg}」 vs 失败「${failedState.msg}」`);

  /* ================= 3) 播放按钮（P3） ================= */
  say('\n[3] 播放按钮不再转圈（P3）：');
  if (/addEventListener\(\s*'waiting'[\s\S]{0,160}?i-loading/.test(appCode))
    bad("源码里还有 waiting → i-loading 的绑定（会永远转圈）");
  else ok('源码里不再有 waiting → i-loading 的绑定');
  if (/function updatePlayBtn/.test(appCode)) ok('有唯一的按钮刷新函数 updatePlayBtn()');
  else bad('没有 updatePlayBtn()');

  const btnState = () => evalJS(`(() => {
    const b = document.getElementById('btnPlay');
    return { pause: b.innerHTML.includes('i-pause'), play: b.innerHTML.includes('i-play'),
             spin: b.innerHTML.includes('i-loading') };
  })()`);

  await evalJS(`(() => { window.__paused = false; document.getElementById('audio').dispatchEvent(new Event('play')); return true; })()`);
  await sleep(120);
  const b1 = await btnState();
  say(`  播放中：pause 图标=${b1.pause} / play 图标=${b1.play} / 转圈=${b1.spin}`);
  if (b1.pause && !b1.spin) ok('播放中显示 ‖（不再转圈）');
  else bad('播放中的图标不对：' + JSON.stringify(b1));

  await evalJS(`(() => { window.__paused = true; document.getElementById('audio').dispatchEvent(new Event('pause')); return true; })()`);
  await sleep(120);
  const b2 = await btnState();
  say(`  暂停时：play 图标=${b2.play}`);
  if (b2.play) ok('暂停时显示 ▶');
  else bad('暂停时的图标不对：' + JSON.stringify(b2));

  // ★ 本轮 bug 的回归断言：缓冲（waiting）事件不该动按钮
  await evalJS(`(() => { window.__paused = false; document.getElementById('audio').dispatchEvent(new Event('play')); return true; })()`);
  await sleep(80);
  await evalJS(`(() => { document.getElementById('audio').dispatchEvent(new Event('waiting')); return true; })()`);
  await sleep(150);
  const b3 = await btnState();
  say(`  派发一次 waiting 之后：pause 图标=${b3.pause} / 转圈=${b3.spin}`);
  if (b3.pause && !b3.spin) ok('缓冲（waiting）不再把按钮变成转圈（本轮 bug 的回归断言）');
  else bad('waiting 又把按钮弄坏了：' + JSON.stringify(b3));

  // 换歌之后立刻：图标跟着真实状态走（此时是暂停态 → ▶）
  const b4 = await evalJS(`(() => {
    window.__paused = true;
    playTracks([window.__mk('BV1switch', '换歌测试')], 0, '');
    const b = document.getElementById('btnPlay');
    return { play: b.innerHTML.includes('i-play'), spin: b.innerHTML.includes('i-loading') };
  })()`);
  say(`  换歌之后立刻：play 图标=${b4.play} / 转圈=${b4.spin}`);
  if (b4.play && !b4.spin) ok('换歌时不再先转圈，直接按真实状态显示 ▶');
  else bad('换歌时的图标不对：' + JSON.stringify(b4));

  /* ================= 4) 三档毛玻璃 + 两个互斥开关 ================= */
  say('\n[4] 三档毛玻璃 + 两个互斥开关：');

  const mig = await evalJS(`(() => {
    const snapshot = JSON.stringify(DB.settings);
    const out = {};
    // 全新存档（什么都没有）
    DB.settings = {}; migrateSettings(); out.fresh = DB.settings.glass.mode;
    // 老存档：有 glass 但没有 mode
    DB.settings = { glass: { blur: 18, alpha: 0.55 } }; migrateSettings(); out.noMode = DB.settings.glass.mode;
    // 老存档：当年主动关过 perfLite
    DB.settings = { bg: { perfLite: false }, glass: { blur: 18, alpha: 0.55 } }; migrateSettings();
    out.perfLiteOff = DB.settings.glass.mode;
    out.perfLiteGone = !('perfLite' in DB.settings.bg);
    // 还原
    DB.settings = JSON.parse(snapshot); migrateSettings();
    applyAppearance(); syncSettingsUI();
    return out;
  })()`);
  say(`  迁移：全新=${mig.fresh}，无 mode=${mig.noMode}，当年关过 perfLite=${mig.perfLiteOff}，perfLite 字段已移除=${mig.perfLiteGone}`);
  if (mig.fresh === 'prebake' && mig.noMode === 'prebake') ok("默认档是 'prebake'（全新 + 老存档无 mode）");
  else bad('默认档不对：' + JSON.stringify(mig));
  if (mig.perfLiteOff === 'prebake' && mig.perfLiteGone) ok("当年关过 perfLite 的老存档也迁到 'prebake'，且 perfLite 字段退役");
  else bad('老存档迁移不对：' + JSON.stringify(mig));

  // 两个互斥开关
  const swState = () => evalJS(`(() => ({
    mode: DB.settings.glass.mode,
    perf: document.getElementById('chkGlassPerf').checked,
    live: document.getElementById('chkGlassLive').checked,
    warn: getComputedStyle(document.getElementById('glassLiveWarn')).display,
  }))()`);

  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(300);
  await evalJS(`(() => { const c = document.getElementById('chkGlassLive'); c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(350);
  const sLive = await swState();
  say(`  勾「实时毛玻璃」后：mode=${sLive.mode}，省显卡勾=${sLive.perf}，高画质勾=${sLive.live}，警示行 display=${sLive.warn}`);
  if (sLive.mode === 'live' && sLive.perf === false && sLive.live === true) ok('勾「实时毛玻璃」→ live，且「省显卡」自动被取消（互斥）');
  else bad('互斥没生效：' + JSON.stringify(sLive));
  if (sLive.warn !== 'none') ok('勾了高画质 → 常驻警示行可见');
  else bad('勾了高画质但警示行没出现');

  await evalJS(`(() => { const c = document.getElementById('chkGlassPerf'); c.checked = true;
    c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(350);
  const sPerf = await swState();
  say(`  反向勾「省显卡」后：mode=${sPerf.mode}，高画质勾=${sPerf.live}，警示行 display=${sPerf.warn}`);
  if (sPerf.mode === 'prebake' && sPerf.live === false && sPerf.perf === true) ok('反向勾「省显卡」→ prebake，且「实时毛玻璃」自动被取消（双向互斥）');
  else bad('反向互斥没生效：' + JSON.stringify(sPerf));
  if (sPerf.warn === 'none') ok('不是高画质档时警示行隐藏');
  else bad('非高画质档警示行还在');

  await evalJS(`(() => { const p = document.getElementById('chkGlassPerf'), l = document.getElementById('chkGlassLive');
    p.checked = false; p.dispatchEvent(new Event('change', { bubbles: true }));
    l.checked = false; l.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  await sleep(350);
  const sPlain = await swState();
  say(`  两个都不勾：mode=${sPlain.mode}`);
  if (sPlain.mode === 'plain') ok('两个都不勾 → plain（纯半透明，最省的一档，必须允许存在）');
  else bad('两个都不勾没有落到 plain：' + sPlain.mode);

  // 各档下面板的实际表现
  const panels = () => evalJS(`(() => {
    const sel = ['.titlebar', '.sidebar', '.topbar', '.player'];
    const out = {};
    sel.forEach((s) => { const el = document.querySelector(s);
      out[s] = { bf: el ? getComputedStyle(el).backdropFilter : 'MISSING',
                 bgImg: el ? getComputedStyle(el).backgroundImage : 'MISSING' }; });
    return { out, img: getComputedStyle(document.documentElement).getPropertyValue('--glass-img').trim().slice(0, 30),
             hasImgbg: document.body.classList.contains('has-imgbg') };
  })()`);

  // 4a) prebake + 图片背景 → 无真模糊 + 面板背景指向预先糊好的图
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  const imgReady = await waitFor("document.body.classList.contains('has-imgbg')");
  await sleep(300);
  const pPre = await panels();
  const bfNone = Object.keys(pPre.out).filter((k) => pPre.out[k].bf !== 'none');
  const bgHasImg = Object.keys(pPre.out).filter((k) => /data:image/.test(pPre.out[k].bgImg));
  say(`  prebake + 图片：--glass-img 前缀=${pPre.img}…，has-imgbg=${pPre.hasImgbg}，无真模糊的面板=${4 - bfNone.length}/4，背景含 data:image 的面板=${bgHasImg.length}/4`);
  if (bfNone.length === 0) ok('prebake + 图片背景 → 4 块面板都没有真 backdrop-filter');
  else bad('这些面板还开着毛玻璃：' + bfNone.join(' / '));
  if (bgHasImg.length === 4) ok('prebake + 图片背景 → 面板背景指向"预先糊好的图"（不是纯色）');
  else bad(`面板背景没接上预先糊好的图（${bgHasImg.length}/4）：` + JSON.stringify(pPre.out['.sidebar']));
  if (/data:image\//.test(pPre.img)) ok('--glass-img 真的生成出来了（url("data:image/…")）');
  else bad('--glass-img 没生成：' + pPre.img);

  // 背景压暗必须同时改变预烘焙面板和内容区透出的壁纸，不需重生成 --glass-img。
  const bgDim = await evalJS(`(() => {
    const sel = ['.titlebar', '.sidebar', '.topbar', '.player'];
    const previous = DB.settings.bg.dim;
    const sample = () => Object.fromEntries(sel.map((s) => [s, getComputedStyle(document.querySelector(s)).backgroundImage]));
    DB.settings.bg.dim = 0; applyAppearance(); const clear = sample();
    DB.settings.bg.dim = 0.63; applyAppearance(); const dimmed = sample();
    const rootDim = getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim();
    DB.settings.bg.dim = previous; applyAppearance();
    return { rootDim, changed: sel.filter((s) => clear[s] !== dimmed[s]),
      hasDimLayer: sel.filter((s) => dimmed[s].includes('0.63')) };
  })()`);
  say(`  背景压暗 63%：root --bg-dim=${bgDim.rootDim}，变化面板=${bgDim.changed.length}/4，带 0.63 暗罩=${bgDim.hasDimLayer.length}/4`);
  if (bgDim.rootDim === '0.63' && bgDim.changed.length === 4 && bgDim.hasDimLayer.length === 4)
    ok('背景压暗滑杆同步影响四块预烘焙面板，与内容区共用全局值');
  else bad('背景压暗未覆盖全部预烘焙面板：' + JSON.stringify(bgDim));

  // 4b) prebake + 视频背景 → 没真模糊，也没有预先糊的图（视频糊不了）
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(400);
  const pVid = await panels();
  const bfNoneV = Object.keys(pVid.out).filter((k) => pVid.out[k].bf !== 'none');
  say(`  prebake + 视频：--glass-img=${pVid.img}，has-imgbg=${pVid.hasImgbg}，无真模糊的面板=${4 - bfNoneV.length}/4`);
  if (bfNoneV.length === 0 && !pVid.hasImgbg) ok('prebake + 视频背景 → 无真模糊，且不生成预先糊的图（视频没法预先糊）');
  else bad('prebake + 视频的表现不对：' + JSON.stringify({ bfNoneV, hasImgbg: pVid.hasImgbg }));

  // 4c) plain → 无真模糊，且面板背景为 none（纯半透明）
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'plain'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(400);
  const pPlain = await panels();
  const bfNoneP = Object.keys(pPlain.out).filter((k) => pPlain.out[k].bf !== 'none');
  const bgNoneP = Object.keys(pPlain.out).filter((k) => pPlain.out[k].bgImg === 'none');
  say(`  plain：无真模糊的面板=${4 - bfNoneP.length}/4，背景为 none 的面板=${bgNoneP.length}/4，--glass-img=${pPlain.img}`);
  if (bfNoneP.length === 0 && bgNoneP.length === 4) ok('plain → 4 块面板无真模糊、背景为 none（纯半透明）');
  else bad('plain 档表现不对：' + JSON.stringify({ bfNoneP, bgNoneP }));

  // 4d) live → 恢复真毛玻璃，且不含预先糊的图
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'live'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(500);
  const pLive = await panels();
  const bfBlur = Object.keys(pLive.out).filter((k) => /blur\(/.test(pLive.out[k].bf));
  const bgImgL = Object.keys(pLive.out).filter((k) => /data:image/.test(pLive.out[k].bgImg));
  say(`  live：含 blur( 的面板=${bfBlur.length}/4，背景含 data:image 的面板=${bgImgL.length}/4，--glass-img=${pLive.img}`);
  if (bfBlur.length === 4) ok('live → 4 块面板恢复真 backdrop-filter（回归基准）');
  else bad('live 档面板毛玻璃没恢复：' + JSON.stringify(pLive.out));
  if (bgImgL.length === 0 && pLive.img === 'none') ok('live → 不再挂预先糊的图（切回真模糊）');
  else bad('live 档还留着预先糊的图：' + JSON.stringify({ bgImgL, img: pLive.img }));

  // 4e) 没有自定义背景 → 无论哪一档，面板都不挂真模糊
  const noBg = await evalJS(`(() => {
    const out = {};
    for (const m of ['plain', 'prebake', 'live']) {
      DB.settings.bg.file = null; DB.settings.bg.kind = 'image';
      DB.settings.glass.mode = m; applyAppearance();
      out[m] = ['.titlebar', '.sidebar', '.topbar', '.player']
        .filter((s) => getComputedStyle(document.querySelector(s)).backdropFilter !== 'none');
    }
    return out;
  })()`);
  say(`  没有自定义背景时，各档仍开着毛玻璃的面板：${JSON.stringify(noBg)}`);
  if (!noBg.plain.length && !noBg.prebake.length && !noBg.live.length) ok('没有自定义背景 → 三档一律不挂真模糊（背后是纯色，糊了没收益）');
  else bad('没有背景时还在挂毛玻璃：' + JSON.stringify(noBg));

  /* ================= 5) L1 / S3：看不见的动画要停 ================= */
  say('\n[5] 省显卡 L1 / S3：看不见的动画要停：');

  // 先把"正在播放"的那一行真的画进 DOM，才量得到柱子的计算样式
  await evalJS(`(() => {
    const t = window.__mk('BV1bars', '柱子在跳');
    queue = { tracks: [t], index: 0, name: '' };
    document.getElementById('content').innerHTML = trackListHTML([t], {});
    // 即使旧类名被意外加回，封面也不应再出现旋转动画。
    document.getElementById('npCover').classList.add('spin');
    return true; })()`);
  await sleep(200);

  const animState = () => evalJS(`(() => {
    const bar = document.querySelector('#content .idx .bars i');
    const cov = document.getElementById('npCover');
    return {
      bar: bar ? getComputedStyle(bar).animationPlayState : 'NO-BAR',
      cover: getComputedStyle(cov, '::before').animationName,
      overlay: document.body.classList.contains('has-overlay'),
      lyric: document.body.classList.contains('lyric-open'),
      idle: document.body.classList.contains('perf-idle'),
    };
  })()`);

  const a0 = await animState();
  say(`  起点：柱子=${a0.bar}，封面动画=${a0.cover}（has-overlay=${a0.overlay}）`);
  if (a0.bar === 'running' && a0.cover === 'none') ok('无遮罩时跳动柱子正常播放，封面无旋转动画');
  else bad('起点动画状态不对：' + JSON.stringify(a0));

  // 打开设置（模态遮罩）→ 暂停被遮住的内容区动画，封面始终不旋转
  await evalJS(`document.getElementById('btnSettings').click(); true`);
  await sleep(350);
  const a1 = await animState();
  say(`  打开设置后：has-overlay=${a1.overlay}，柱子=${a1.bar}，封面动画=${a1.cover}`);
  if (a1.overlay && a1.bar === 'paused' && a1.cover === 'none') ok('模态遮罩打开 → 内容区动画暂停，封面无旋转动画（L1）');
  else bad('打开模态遮罩后的动画状态不对：' + JSON.stringify(a1));
  await evalJS(`document.getElementById('btnCloseModal').click(); true`);
  await sleep(350);

  // 打开整页歌词 → 暂停内容区动画，播放条封面仍无旋转动画
  await evalJS(`(() => { queue = { tracks: [window.__mk('BV1bars','柱子在跳')], index: 0, name: '' };
    document.getElementById('content').innerHTML = trackListHTML([queue.tracks[0]], {});
    toggleLyrics(true); return true; })()`);
  await sleep(350);
  const a2 = await animState();
  say(`  打开歌词页后：lyric-open=${a2.lyric}，柱子=${a2.bar}，封面动画=${a2.cover}`);
  if (a2.lyric && a2.bar === 'paused' && a2.cover === 'none') ok('整页歌词打开 → 内容区柱子暂停，封面无旋转动画（L1）');
  else bad('打开歌词页后的动画状态不对：' + JSON.stringify(a2));
  await evalJS(`toggleLyrics(false); true`);
  await sleep(300);

  // S3：窗口失焦 → 暂停仍在使用的无限动画，封面保持静止
  await evalJS(`window.dispatchEvent(new Event('blur')); true`);
  await sleep(250);
  const a3 = await animState();
  say(`  窗口失焦后：perf-idle=${a3.idle}，柱子=${a3.bar}，封面动画=${a3.cover}`);
  if (a3.idle && a3.bar === 'paused' && a3.cover === 'none') ok('窗口失焦 → 内容区动画暂停，封面无旋转动画（S3）');
  else bad('失焦后的动画状态不对：' + JSON.stringify(a3));

  await evalJS(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(250);
  const a4 = await animState();
  say(`  回焦后：柱子=${a4.bar}，封面动画=${a4.cover}`);
  if (a4.bar === 'running' && a4.cover === 'none') ok('回到前台 → 内容区动画恢复，封面仍无旋转动画（S3）');
  else bad('回焦后的动画状态不对：' + JSON.stringify(a4));

  /* ================= 6) L2：柱子不再是 SVG ================= */
  say('\n[6] L2：柱子从 SVG 换成普通元素：');
  const bars = await evalJS(`(() => {
    const t = window.__mk('BV1bars2', '柱子在跳');
    queue = { tracks: [t], index: 0, name: '' };
    const html = trackListHTML([t], {});
    const d = document.createElement('div'); d.innerHTML = html;
    const b = d.querySelector('.idx .bars');
    return { found: !!b, hasSvg: !!(b && b.querySelector('svg')), items: b ? b.querySelectorAll('i').length : 0,
             svgInHtml: html.includes('<svg class="ic bars"') };
  })()`);
  say(`  .idx .bars 存在=${bars.found}，里面还有 <svg>=${bars.hasSvg}，<i> 数量=${bars.items}`);
  if (bars.found && !bars.hasSvg && bars.items === 3) ok('柱子是普通 <i>（走合成器），不再用 SVG（每帧重光栅化）');
  else bad('柱子结构不对：' + JSON.stringify(bars));

  /* ================= 7) v2.0.2：四块框架统一 + 歌词页背后干净 ================= */
  say('\n[7] v2.0.2：四块框架不透明度统一 / 歌词页背后干净：');

  const panelsInfo = () => evalJS(`(() => {
    const sel = ['.titlebar', '.sidebar', '.topbar', '.player'];
    const pick = (s, k) => getComputedStyle(document.querySelector(s))[k];
    return { frameA: getComputedStyle(document.documentElement).getPropertyValue('--frame-a').trim(),
      alphas: sel.map((s) => pick(s, 'backgroundColor')),
      bgis: sel.map((s) => pick(s, 'backgroundImage').slice(0, 80)),
      contentBg: pick('#content', 'backgroundColor') };
  })()`);
  const uniq = (a) => [...new Set(a)];

  // 7a) 动态背景（视频）：四块必须一致，且足够透（背景要铺满整个界面）
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    DB.settings.glass.mode = 'prebake'; DB.settings.glass.frameAlpha = 0.12; applyAppearance(); return true; })()`);
  await sleep(400);
  const vp = await panelsInfo();
  say(`  动态背景（视频）：--frame-a=${vp.frameA}，四块底色=${JSON.stringify(vp.alphas)}`);
  if (uniq(vp.alphas).length === 1) ok('动态背景（视频）下四块框架的不透明度完全相同');
  else bad('动态背景（视频）下四块框架不一致：' + JSON.stringify(vp.alphas));
  const vAlpha = parseFloat((/rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(vp.alphas[0]) || [])[1]);
  if (isFinite(vAlpha) && vAlpha <= 0.2) ok(`动态背景下面板只压 ${vAlpha}（≤0.2）→ 背景能铺满整个界面`);
  else bad('动态背景下面板还是太实（背景铺不满）：' + vp.alphas[0]);
  if (vp.contentBg === 'rgba(0, 0, 0, 0)') ok('内容区仍是零压暗（四块面板与它只差 --frame-a）');
  else bad('内容区底色不是全透明：' + vp.contentBg);

  // 7b) 图片背景：四块必须一致（同一个 --frame-a，不再有谁多一层暗罩）
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); return true; })()`);
  for (let i = 0; i < 25; i++) { if (await evalJS(`document.body.classList.contains('has-imgbg')`)) break; await sleep(200); }
  await sleep(300);
  const ip = await panelsInfo();
  say(`  图片背景：四块背景层前 80 字相同=${uniq(ip.bgis).length === 1}`);
  if (uniq(ip.bgis).length === 1) ok('图片背景下四块框架的背景层完全相同（不再有谁多一层暗罩）');
  else bad('图片背景下四块框架不一致：' + JSON.stringify(ip.bgis));

  // 7c) 面板不透明度拖到 0 → 四块完全透出背景
  //     ★ 两条路都要验：动态背景（视频）看 background-color；图片背景看"暗罩"那一层（background-color 本就是透明的）
  await evalJS(`(() => { DB.settings.glass.frameAlpha = 0;
    DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video'; applyAppearance(); return true; })()`);
  await sleep(350);
  const zv = await panelsInfo();
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image'; applyAppearance(); return true; })()`);
  for (let i = 0; i < 25; i++) { if (await evalJS(`document.body.classList.contains('has-imgbg')`)) break; await sleep(200); }
  await sleep(300);
  const zi = await panelsInfo();
  const noSpace = (s) => (s || '').replace(/\s/g, '');
  say(`  拖到 0（动态背景路）：--frame-a=${zv.frameA}，四块底色=${JSON.stringify(zv.alphas)}`);
  say(`  拖到 0（图片背景路）：暗罩层=${zi.bgis[0]}`);
  const v0 = zv.frameA === '0' && uniq(zv.alphas).length === 1 && /,0\)$/.test(noSpace(zv.alphas[0]));
  const i0 = uniq(zi.bgis).length === 1 && /rgba\(16,16,26,0\)/.test(noSpace(zi.bgis[0]));
  if (v0 && i0) ok('面板不透明度拖到 0 → 四块面板完全透出背景（两条路都不再压任何东西）');
  else bad('拖到 0 没有完全透明：' + JSON.stringify({ zv, zi }));

  // 7d) 歌词页打开 → 内容区被隐藏（背后只剩壁纸，不再透出上一个页面）
  await evalJS(`(() => { DB.settings.glass.frameAlpha = 0.12; applyAppearance(); toggleLyrics(true); return true; })()`);
  await sleep(400);
  const lv = await evalJS(`(() => {
    const c = document.getElementById('content');
    const k = c.firstElementChild;
    return { lyricOpen: document.body.classList.contains('lyric-open'),
      containerVis: getComputedStyle(c).visibility,
      childVis: k ? getComputedStyle(k).visibility : 'no-child',
      childTag: k ? k.tagName + '.' + (k.className || '') : '' }; })()`);
  say(`  歌词页打开：lyric-open=${lv.lyricOpen}，#content=${lv.containerVis}（容器要留着，布局不能动），` +
    `子元素 ${lv.childTag}=${lv.childVis}`);
  if (lv.lyricOpen && lv.childVis === 'hidden') ok('歌词页打开 → 内容区（列表）隐藏，背后只剩壁纸');
  else bad('歌词页打开时列表没有隐藏：' + JSON.stringify(lv));
  if (lv.containerVis === 'visible') ok('容器 #content 本身保持 visible → 布局 / 滚动位置完全不变');
  else bad('容器 #content 被藏了（会丢滚动位置）：' + lv.containerVis);
  await evalJS(`toggleLyrics(false); true`);
  await sleep(350);
  const lc = await evalJS(`(() => { const c = document.getElementById('content');
    const k = c.firstElementChild; return k ? getComputedStyle(k).visibility : 'no-child'; })()`);
  say(`  歌词页关闭：子元素 visibility=${lc}`);
  if (lc === 'visible') ok('歌词页关闭 → 内容区恢复显示');
  else bad('歌词页关闭后内容区没恢复：' + lc);

  /* 7e) 像素采样（纯色壁纸）—— 直接量"背景到底铺满没铺满"。
     ★ 做法：先把前景内容临时藏掉（visibility:hidden，不改布局），让四块面板和内容区
       都只剩"背景层"；再在 --frame-a=0 与 0.4 两种设置下各采一次样，比较同一个点的亮度差。
       亮度差只跟面板底色有关（前景两次完全一样，相减即抵消），所以这个判据
       不受列表行 / 按钮 / 文字的干扰 —— 比"找一块空地采一个点"可靠得多。
     ★ 壁纸用 1×1 纯色 PNG（120 灰）：拉伸后整面同色，糊过之后还是同色，
       于是"面板多压了多少"可以直接跟理论值对账。
     ★★ 坑：.bg-layer .bg-image 上有 transition: background-image 0.4s（换壁纸时淡入淡出）。
        刚换完壁纸就截图，内容区还在两张图之间过渡，采到的是"半张旧图"（实测差 4.3 个色阶）。
        所以采样前必须先等读数稳定（连续两次一样）—— 见 settle()。 */
  const probeStyle = () => evalJS(`(() => {
    let st = document.getElementById('pixel-probe');
    if (!st) { st = document.createElement('style'); st.id = 'pixel-probe';
      st.textContent = '.titlebar > *, .sidebar > *, .topbar > *, .player > *, #content > * { visibility: hidden !important; }';
      document.head.appendChild(st); }
    return true; })()`);
  /** 两张图在 **#content 那一块**里有多少像素不同（百分比）。
      ★ 必须限定在内容区里比：整个窗口比的话，面板的预烘焙图 / 壁纸淡入也会算进去，
        测出来的百分比跟"列表藏没藏"没关系（实测踩过：整窗比 5.3%，其实全是别处的变化）。 */
  const diffPctIn = async (imgA, imgB) => {
    const r = await evalJS(`(() => { const b = document.getElementById('content').getBoundingClientRect();
      return [b.left, b.top, b.width, b.height, window.innerWidth, window.innerHeight]; })()`);
    const sz = imgA.getSize(), bA = imgA.getBitmap(), bB = imgB.getBitmap();
    const sx = sz.width / r[4], sy = sz.height / r[5];
    const x0 = Math.max(0, Math.round(r[0] * sx)), x1 = Math.min(sz.width, Math.round((r[0] + r[2]) * sx));
    const y0 = Math.max(0, Math.round(r[1] * sy)), y1 = Math.min(sz.height, Math.round((r[1] + r[3]) * sy));
    let d = 0, t = 0;
    for (let yy = y0; yy < y1; yy += 2) {
      for (let xx = x0; xx < x1; xx += 2) {
        t++;
        const o = (yy * sz.width + xx) * 4;
        if (Math.abs(bA[o] - bB[o]) > 6 || Math.abs(bA[o + 1] - bB[o + 1]) > 6 ||
            Math.abs(bA[o + 2] - bB[o + 2]) > 6) d++;
      }
    }
    return 100 * d / Math.max(1, t);
  };

  /** 指定区域里"有文字笔画"的格子数：切成 34×118 格，格内明暗差够大就算一笔。
      ★ 为什么用"明暗差"而不是"够不够亮"：背景被压暗之后，列表标题只有 ~90 亮度，
        用绝对亮度阈值根本挑不出来（实测踩过：整块内容区被判成"什么都没有"）。
      ★ i0/i1 用来把上下两头裁掉：那两处是歌词浮层自己的标题 / 按钮，不是列表。 */
  const strokeCells = (img, r, i0 = 4, i1 = 30) => {
    const sz = img.getSize(), bmp = img.getBitmap();
    const sx = sz.width / r[4], sy = sz.height / r[5];
    const x0 = Math.max(0, Math.round(r[0] * sx)), x1 = Math.min(sz.width, Math.round((r[0] + r[2]) * sx));
    const y0 = Math.max(0, Math.round(r[1] * sy)), y1 = Math.min(sz.height, Math.round((r[1] + r[3]) * sy));
    let n = 0;
    for (let i = i0; i < i1; i++) {
      for (let j = 0; j < 118; j++) {
        const cx0 = x0 + Math.floor((x1 - x0) * j / 118), cx1 = x0 + Math.floor((x1 - x0) * (j + 1) / 118);
        const cy0 = y0 + Math.floor((y1 - y0) * i / 34), cy1 = y0 + Math.floor((y1 - y0) * (i + 1) / 34);
        let mx = 0, mn = 255;
        for (let y = cy0; y < cy1; y += 2) {
          for (let x = cx0; x < cx1; x += 2) {
            const o = (y * sz.width + x) * 4;
            const v = (bmp[o] + bmp[o + 1] + bmp[o + 2]) / 3;
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
        }
        if (mx - mn > 28 && mx > 70) n++;
      }
    }
    return n;
  };

  const sampleAll = async (img0) => {
    const img = img0 || await snap(3, 150);   // 采样只要"别是旧帧"，连拍两三张足够；稳定性另有 settle() 把关
    const size = img.getSize();
    const bmp = img.getBitmap();
    const geo = await evalJS(`(() => {
      const g = (s) => { const r = document.querySelector(s).getBoundingClientRect();
        return [r.left, r.top, r.width, r.height]; };
      return { W: window.innerWidth, H: window.innerHeight,
        titlebar: g('.titlebar'), sidebar: g('.sidebar'), topbar: g('.topbar'),
        player: g('.player'), content: g('#content') };
    })()`);
    const sx = size.width / geo.W, sy = size.height / geo.H;
    // 在该元素"中间 60% 区域"上打 7×7 个点取中位数：一个脏点 / 一条分隔线都带不偏结果。
    // （BGRA / RGBA 都无所谓：只取三通道均值当亮度）
    const med = (r) => {
      const vals = [];
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        const x = Math.max(0, Math.min(size.width - 1,
          Math.round((r[0] + r[2] * (0.2 + 0.6 * i / 6)) * sx)));
        const y = Math.max(0, Math.min(size.height - 1,
          Math.round((r[1] + r[3] * (0.2 + 0.6 * j / 6)) * sy)));
        const o = (y * size.width + x) * 4;
        vals.push((bmp[o] + bmp[o + 1] + bmp[o + 2]) / 3);
      }
      vals.sort((a, b) => a - b);
      return vals[24];
    };
    return { W: size.width, H: size.height,
      titlebar: med(geo.titlebar), sidebar: med(geo.sidebar), topbar: med(geo.topbar),
      player: med(geo.player), content: med(geo.content) };
  };
  /** 等画面稳定：连续两次采到同样的读数才算数（躲开换壁纸的 0.4s 淡入淡出） */
  const settle = async (tries = 16) => {
    let prev = null;
    for (let i = 0; i < tries; i++) {
      const s = await sampleAll();
      if (prev && s.content === prev.content && s.titlebar === prev.titlebar) return s;
      prev = s;
      await sleep(250);
    }
    return prev;
  };
  const setProbe = (frameA) => evalJS(`(() => {
    DB.settings.bg.file = '${TEST_SOLID}'; DB.settings.bg.kind = 'image';
    DB.settings.bg.dim = 0;      /* 压暗先关掉：让"面板多压的那一点"成为唯一变量 */
    DB.settings.glass.mode = 'prebake'; DB.settings.glass.frameAlpha = ${frameA};
    applyAppearance(); return true; })()`);

  await probeStyle();
  await setProbe(0);
  for (let i = 0; i < 25; i++) { if (await evalJS(`document.body.classList.contains('has-imgbg')`)) break; await sleep(200); }
  await sleep(500);
  const q0 = await settle();
  await setProbe(0.4);
  const q4 = await settle();
  say(`  纯色壁纸像素采样（位图 ${q0.W}×${q0.H}，网格中位数）：`);
  say(`    --frame-a=0   → ${JSON.stringify(q0)}`);
  say(`    --frame-a=0.4 → ${JSON.stringify(q4)}`);

  const PKEYS = ['titlebar', 'sidebar', 'topbar', 'player'];
  const deltas = PKEYS.map((k) => q0[k] - q4[k]);
  const dContent = q0.content - q4.content;
  const spread = Math.max(...deltas) - Math.min(...deltas);
  const expect = 0.4 * (q0.content - (16 + 16 + 26) / 3);   /* 0.4 ×（壁纸色 − 玻璃底色） */
  say(`    四块面板被压暗的幅度=${deltas.map((d) => d.toFixed(1)).join(' / ')}（理论 ${expect.toFixed(1)}），内容区=${dContent.toFixed(1)}`);

  const q0Diff = PKEYS.map((k) => +(q0[k] - q0.content).toFixed(1));
  if (PKEYS.every((k) => Math.abs(q0[k] - q0.content) <= 8)) ok('--frame-a=0 时四块面板与内容区亮度一致 → 背景铺满了整个界面');
  else bad('--frame-a=0 时面板与内容区亮度仍不一致（偏差 ' + JSON.stringify(q0Diff) + '）');
  if (deltas.every((d) => d >= expect - 8 && d <= expect + 8)) ok(`四块面板的压暗幅度都等于 --frame-a（实测 ${deltas.map((d) => d.toFixed(1)).join('/')}，理论 ${expect.toFixed(1)}）`);
  else bad('面板压暗幅度与 --frame-a 对不上：' + JSON.stringify(deltas) + '，理论 ' + expect.toFixed(1));
  if (spread <= 5) ok(`四块面板的压暗幅度彼此一致（最大差 ${spread.toFixed(1)} 个色阶）`);
  else bad('四块面板的压暗幅度不一致，最大差 ' + spread.toFixed(1));
  if (Math.abs(dContent) <= 4) ok('内容区不受"面板不透明度"影响（两次亮度差 ≈ 0）');
  else bad('内容区也被面板不透明度影响了：' + dContent.toFixed(1));

  // 采完样把前景放回来（不然截图会全是空的）
  await evalJS(`(() => { const st = document.getElementById('pixel-probe'); if (st) st.remove();
    DB.settings.bg.dim = 0.55; return true; })()`);

  /* 7f) 歌词页背后到底干净没干净 —— 用像素量，不看计算样式。
     计算样式说 hidden 不等于画面上真没画（实测踩过：只藏 #content 时，
     离屏软件光栅下"合成器隐藏滚动图层"这条优化不生效，列表照旧挂在歌词页后面）。
     纯色壁纸 + 关掉压暗：歌词页开着时，内容区应该只剩"壁纸过一层 34% 黑纱"，
     即 0.66×120 + 0.34×10.3 ≈ 82.8；再把内容区强行显示出来，像素必须明显变化。 */
  const VEIL = [8, 8, 14], VEIL_A = 0.34, SOLID_C = 120;
  const lyricExpect = (1 - VEIL_A) * SOLID_C + VEIL_A * ((VEIL[0] + VEIL[1] + VEIL[2]) / 3);
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_SOLID}'; DB.settings.bg.kind = 'image';
    DB.settings.bg.dim = 0; DB.settings.glass.mode = 'prebake'; DB.settings.glass.frameAlpha = 0.12;
    applyAppearance(); return true; })()`);
  for (let i = 0; i < 25; i++) { if (await evalJS(`document.body.classList.contains('has-imgbg')`)) break; await sleep(200); }
  await evalJS(`toggleLyrics(true); true`);
  await sleep(400);
  const imgHidden = await snap();
  dump('main-solid-hidden.raw', imgHidden.getBitmap());
  const pxHidden = (await sampleAll(imgHidden)).content;
  const setKids = (v) => evalJS(`(() => { document.querySelectorAll('#content > *').forEach((k) => { k.style.visibility = '${v}'; }); return true; })()`);
  await setKids('visible');
  const imgShown = await snap(8, 200, false);   // ★ 不能抖：抖一下就把"强行显示"撤掉了
  dump('main-solid-shown.raw', imgShown.getBitmap());
  const pxShown = (await sampleAll(imgShown)).content;
  await setKids('');
  // 逐像素比对（只比内容区那一块）：如果"藏起来"真的改到了画面，两张图必须有大量像素不同。
  // 只看中位数不行 —— 列表行本身是半透明的，它的中位数跟壁纸几乎一样，区分不出来（实测踩过）。
  const diffPct = await diffPctIn(imgHidden, imgShown);
  say(`  歌词页像素：藏起来=${pxHidden.toFixed(1)}（理论 ${lyricExpect.toFixed(1)}） / 把内容区强行显示=${pxShown.toFixed(1)}；两图不同像素占 ${diffPct.toFixed(1)}%`);
  if (Math.abs(pxHidden - lyricExpect) <= 8) ok('歌词页背后只剩壁纸（内容区像素 = 壁纸过一层 34% 黑纱，量出来的）');
  else bad('歌词页背后还画着内容区：实测 ' + pxHidden.toFixed(1) + '，理论 ' + lyricExpect.toFixed(1));
  if (diffPct >= 2) ok(`把内容区强行显示出来，画面 ${diffPct.toFixed(1)}% 的像素变了 → 上面那条确实是"藏起来了"的效果`);
  else bad('把内容区强行显示出来画面几乎没变（' + diffPct.toFixed(1) + '%）→ 这条判据没有区分力');
  await evalJS(`(() => { toggleLyrics(false); DB.settings.bg.dim = 0.55; applyAppearance(); return true; })()`);
  await sleep(300);

  /* 截图：三档面板对比 + 歌词页 + 空状态 */
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(900);
  const shot1 = await snap();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-prebake.png'), shot1.toPNG());

  await evalJS(`(() => { DB.settings.glass.mode = 'live'; applyAppearance(); return true; })()`);
  await sleep(500);
  const shot2 = await snap();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-live.png'), shot2.toPNG());

  await evalJS(`(() => { DB.settings.glass.mode = 'plain'; applyAppearance(); return true; })()`);
  await sleep(500);
  const shot3 = await snap();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-plain.png'), shot3.toPNG());

  /* 歌词页的两张图另开一个**全新窗口**拍，并在这里做终局验证。
     为什么另开窗口：主窗口里 #content 是 overflow-y:auto 的滚动容器（自带合成层），
     离屏软件光栅下"改可见性"不会让它重新光栅化 —— 连拍多少张都是同一张旧图层，
     于是截图里列表一直挂在歌词页后面（实测：png 的 md5 跨多次运行都不变）。
     新窗口没有旧图层，拍到的一定是当下这一帧。 */
  {
    const win2 = new BrowserWindow({
      width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
      webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    const e2 = (code) => win2.webContents.executeJavaScript(code);
    win2.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
      if (level >= 2 && !/media|video|decode|DEMUXER|pipeline/i.test(msg)) {
        errors.push('[歌词窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
      }
    });
    const snap2 = async () => { await sleep(400); return win2.webContents.capturePage(); };
    const rect2 = () => e2(`(() => { const b = document.getElementById('content').getBoundingClientRect();
      return [b.left, b.top, b.width, b.height, window.innerWidth, window.innerHeight]; })()`);
    await win2.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1200);
    await e2(`(() => {
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      window.__paused = true;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
      // 新窗口是干净加载的，列表从没渲染过 —— 用应用自己的渲染函数造一份出来，
      // 否则"列表被藏住了"这件事没东西可藏，验证不成立。
      // ★ 不能拿主窗口的 innerHTML 搬过来：发现页是异步加载的，抓到的可能只有一两行。
      const rows = Array.from({ length: 8 }, (_, i) => window.__mk('BV1demo' + i, '示例歌曲 ' + (i + 1)));
      document.getElementById('content').innerHTML = trackListHTML(rows);
      window.__rowCount = document.querySelectorAll('#content .track-list > *').length;
      return true; })()`);
    const nRows = await e2(`window.__rowCount`);

    /* 终局验证：纯色壁纸（背景本身没有任何笔画）+ 关掉压暗。
       歌词页打开时，内容区如果真藏干净了，整块应该是"平的"（只剩遮罩自己的字）；
       把内容区强行显示出来，才该冒出一排排文字笔画。 */
    await e2(`(() => { DB.settings.bg.file = '${TEST_SOLID}'; DB.settings.bg.kind = 'image';
      DB.settings.bg.dim = 0; DB.settings.glass.mode = 'prebake'; DB.settings.glass.frameAlpha = 0.12;
      applyAppearance(); return true; })()`);
    await sleep(1500);
    await e2(`toggleLyrics(true); true`);
    await sleep(700);
    const hidImg = await snap2();
    const hiddenCells = strokeCells(hidImg, await rect2());
    await e2(`(() => { document.querySelectorAll('#content > *').forEach((k) => { k.style.visibility = 'visible'; }); return true; })()`);
    const shoImg = await snap2();
    const shownCells = strokeCells(shoImg, await rect2());
    const cellsDiff = await diffPctIn(hidImg, shoImg);
    await e2(`(() => { document.querySelectorAll('#content > *').forEach((k) => { k.style.visibility = ''; }); return true; })()`);
    say(`  终局验证：新窗口造了 ${nRows} 行列表；纯色壁纸下"有文字笔画"的格子（只数中间那段）` +
      `藏起来=${hiddenCells} / 强行显示=${shownCells}；内容区不同像素 ${cellsDiff.toFixed(1)}%`);
    if (nRows >= 8 && shownCells >= 30 && hiddenCells * 4 <= shownCells)
      ok(`歌词页开着时内容区是"平的"（笔画格 ${hiddenCells} 个 vs 强行显示 ${shownCells} 个）→ 列表真的被藏住了`);
    else bad(`歌词页背后还有内容：笔画格 藏起来=${hiddenCells} / 强行显示=${shownCells}（列表 ${nRows} 行）`);
    if (cellsDiff >= 2) ok(`把列表强行显示出来，内容区 ${cellsDiff.toFixed(1)}% 的像素变了 → 上面那条判据有区分力`);
    else bad('强行显示列表后内容区几乎没变（' + cellsDiff.toFixed(1) + '%）→ 判据没有区分力');

    const lyricShot = async (reply, bvid, title) => {
      subtitleReply = reply;
      await e2(`(async () => {
        DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
        DB.settings.bg.dim = 0.55; DB.settings.glass.mode = 'prebake'; DB.settings.glass.frameAlpha = 0.12;
        applyAppearance();
        queue = { tracks: [window.__mk('${bvid}', '${title}')], index: 0, name: '' };
        lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
        document.getElementById('lyricTitle').textContent = '${title}';
        await loadLyrics(false);
        toggleLyrics(true);
        return true; })()`);
      await sleep(1200);
      return { img: await snap2(), st: await e2(`(() => { const k = document.querySelector('#content > *');
        return { cls: document.body.className, childVis: k ? getComputedStyle(k).visibility : 'none' }; })()`) };
    };

    const a = await lyricShot({ ok: true, data: { lines: [{ t: 0, text: '这是第一句歌词' }, { t: 4, text: '这是第二句歌词' }], videoTitle: '普通歌' } }, 'BV1shot', '普通歌');
    fs.writeFileSync(path.join(__dirname, 'shot-round9-lyric.png'), a.img.toPNG());
    // 裸位图 + 内容区矩形也 dump 一份到 .tmp/：看图工具会有缓存，怀疑截图时直接拿原始像素断案
    dump('lyric.raw', a.img.getBitmap());
    dump('lyric.geo.json', JSON.stringify({ size: a.img.getSize(), rect: await rect2() }));
    say(`  歌词页截图（新窗口）：body=${a.st.cls}，列表=${a.st.childVis}`);

    const b = await lyricShot({ ok: true, data: { lines: [], videoTitle: '一首纯音乐' } }, 'BV1shot2', '一首纯音乐');
    fs.writeFileSync(path.join(__dirname, 'shot-round9-empty.png'), b.img.toPNG());
    win2.destroy();
  }

  say('\n已保存 shot-round9-{plain,prebake,live,lyric,empty}.png');
  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 8).join('\n  '));
  else say('\n页面里没有报错');
  say(fail === 0 ? '\n第九轮实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
