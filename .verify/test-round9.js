/* 第九轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     · P1 歌词页透明化 —— 三档下 .lyric-overlay 背景 alpha ≤ 0.6；
                          plain / prebake 无 backdrop-filter、live 有；歌词行都有文字投影
     · P2 空歌词空状态 —— 纯音乐 / 取词失败两条路都渲染 .lyric-empty，文案不同且含歌名
     · P3 播放按钮     —— 不再有 waiting→转圈；play/pause/playing/ended/emptied 都按 audio.paused 重算
     · 三档毛玻璃 + 两个互斥开关 —— plain / prebake / live，默认 prebake，老存档一律迁 prebake
     · prebake 的"预先糊好的图" —— --glass-img 真的生成出来，面板 background-image 指向它
     · L1 / S3 省显卡 —— 遮罩 / 歌词页 / 失焦时暂停看不见的动画；播放条封面不再旋转
     · L2 —— 「正在播放」的柱子从 SVG 换成普通元素

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

/* ---------- 测试用的背景素材 ----------
   图片必须是"真能解码的图"：prebake 档要把它画进 canvas 再糊一遍，
   随手写几个字节的假文件会解不出来，测不到真正想测的那条路。 */
const BG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bg9-'));
const TEST_VIDEO = 'bg-test.mp4';
const TEST_IMAGE = 'bg-test.png';
fs.writeFileSync(path.join(BG_DIR, TEST_VIDEO), Buffer.alloc(2048, 7));
fs.copyFileSync(path.join(ROOT, 'docs', 'images', 'hero.png'), path.join(BG_DIR, TEST_IMAGE));

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
      errors.push(msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);

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

  /* 截图：三档面板对比 + 歌词页 + 空状态 */
  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(900);
  const shot1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-prebake.png'), shot1.toPNG());

  await evalJS(`(() => { DB.settings.glass.mode = 'live'; applyAppearance(); return true; })()`);
  await sleep(500);
  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-live.png'), shot2.toPNG());

  await evalJS(`(() => { DB.settings.glass.mode = 'plain'; applyAppearance(); return true; })()`);
  await sleep(500);
  const shot3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-plain.png'), shot3.toPNG());

  // 歌词页（要看得到壁纸）
  await evalJS(`(() => { DB.settings.glass.mode = 'prebake'; applyAppearance(); return true; })()`);
  subtitleReply = { ok: true, data: { lines: [{ t: 0, text: '这是第一句歌词' }, { t: 4, text: '这是第二句歌词' }], videoTitle: '普通歌' } };
  await evalJS(`(async () => {
    queue = { tracks: [window.__mk('BV1shot', '普通歌')], index: 0, name: '' };
    lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
    document.getElementById('lyricTitle').textContent = '普通歌';
    await loadLyrics(false);
    toggleLyrics(true);
    return true; })()`);
  await sleep(600);
  const shot4 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-lyric.png'), shot4.toPNG());
  await evalJS(`toggleLyrics(false); true`);
  await sleep(300);

  // 空状态（纯音乐）
  subtitleReply = { ok: true, data: { lines: [], videoTitle: '一首纯音乐' } };
  await evalJS(`(async () => {
    queue = { tracks: [window.__mk('BV1shot2', '一首纯音乐')], index: 0, name: '' };
    lyricState.lines = []; lyricState.trackKey = ''; lyricState.failed = false;
    await loadLyrics(false);
    toggleLyrics(true);
    return true; })()`);
  await sleep(600);
  const shot5 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round9-empty.png'), shot5.toPNG());

  say('\n已保存 shot-round9-{plain,prebake,live,lyric,empty}.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 8).join('\n  '));
  else say('\n页面里没有报错');
  say(fail === 0 ? '\n第九轮实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
