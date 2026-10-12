/* 第七轮需求的实测（离屏渲染 + 合成真实鼠标事件 + 真跑应用代码，不是文本断言）：
     · 启动默认进「发现」（不再停在空搜索页）
     · 侧栏已无「搜索」入口；高亮跟着当前界面走（搜索结果页四项都不亮）
     · 视频背景：bg:// 支持 Range —— 真发一个带 Range 的请求，验证"边读边传"这条路
     · 选视频后 <video> 出现并被播放，静音 / 循环 / 速度同步；清除后隐藏并暂停
     · 重启后视频背景还在；老存档（没有 kind）读出来是 image（零迁移）
   ★ 沙箱没有真实视频文件、也不保证带解码器，所以"能不能真的解码出画面"无法在离线环境验证：
     这里验证的是"元素出现 / 地址正确 / 确实调了 play() / 设置项都刷上去了"。
     视频字节的传输路径由上面那条 Range 请求真跑验证。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ★ 本沙箱里渲染进程的沙箱起不来（连 about:blank 都崩），必须加 --no-sandbox 才能跑。
//   这只是"测试环境"的开关，不进应用代码（src/main.js 里没有这些）。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round7-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* 背景目录 + 一个假视频文件：bg:// 只负责按字节发，不解码，所以内容随便。
   长度 4096 是故意的 —— 好算 Range 的 Content-Range。 */
const BG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bg-'));
const TEST_VIDEO = 'bg-test.mp4';
const TEST_IMAGE = 'bg-test.png';
const VIDEO_BYTES = 4096;
fs.writeFileSync(path.join(BG_DIR, TEST_VIDEO), Buffer.alloc(VIDEO_BYTES, 7));
fs.writeFileSync(path.join(BG_DIR, TEST_IMAGE), Buffer.alloc(64, 3));

// bg:// 必须是"特权协议"，fetch / <video> 才能正常用它
protocol.registerSchemesAsPrivileged([{
  scheme: 'bg',
  privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true },
}]);

// 直接加载被测的那份协议实现（不是测试里另写一份）
const { registerBgProtocol } = require(path.join(ROOT, 'src', 'bg-protocol.js'));

let lastSaved = null;
const pickCalls = [];

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', (_e, kw) => ({
  ok: true,
  data: {
    list: [
      { bvid: 'BV1disc0001', title: kw + '·测试歌', author: '测试UP', mid: 1, cover: '', duration: '3:20' },
      { bvid: 'BV1disc0002', title: kw + '·第二首', author: '测试UP', mid: 1, cover: '', duration: '4:01' },
    ],
  },
}));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', (_e, kind) => {
  pickCalls.push(kind);
  return kind === 'video'
    ? { ok: true, data: { file: TEST_VIDEO, kind: 'video', sizeMB: 0.1 } }
    : { ok: true, data: { file: TEST_IMAGE, kind: 'image', sizeMB: 0.1 } };
});
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

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
  win.webContents.on('console-message', (_e, level, msg) => {
    // 假视频解不了码会报错，那是测试素材的产物，不算应用缺陷
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline/i.test(msg)) errors.push(msg);
  });

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1100);
    // 掐掉音频：沙箱没声卡，audio.play() 必然失败（环境产物）。
    // src 的 getter 给一个合法 URL（不是空串）—— 给空串会让 Electron 内部的
    // 媒体代码 new URL('') 抛 "Invalid URL"，在报告里变成一条误导性的"页面报错"。
    await win.webContents.executeJavaScript(`(() => {
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(340);
  };
  const centerOf = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);
  const clickSel = async (sel) => { const p = await centerOf(sel); if (!p) { bad('找不到元素 ' + sel); return false; } await clickAt(p.x, p.y); return true; };
  const navState = () => evalJS(`Array.from(document.querySelectorAll('.nav-item')).map((n) => ({ v: n.dataset.view, on: n.classList.contains('active') }))`);

  /* ================= 1) 启动默认进「发现」 ================= */
  say('[1] 启动默认落在「发现」：');
  await sleep(600);   // 等发现页把推荐拉回来
  const boot1 = await evalJS(`({
    view: currentView,
    navs: Array.from(document.querySelectorAll('.nav-item')).map((n) => n.dataset.view),
    title: (document.querySelector('#content .block-title') || {}).textContent || '',
    hasSearchNav: !!document.querySelector('.nav-item[data-view="search"]'),
  })`);
  say(`  启动后 currentView=${boot1.view}，侧栏=[${boot1.navs.join(', ')}]，标题「${boot1.title}」`);
  if (boot1.view === 'discovery') ok('启动默认落在「发现」（不是空搜索页）');
  else bad('启动没有默认进发现：' + boot1.view);
  if (!boot1.hasSearchNav) ok('侧栏里没有「搜索」入口');
  else bad('侧栏里仍然有「搜索」入口');
  if (/发现/.test(boot1.title)) ok('内容区渲染的是发现页（有推荐列表）');
  else bad('内容区不是发现页，标题=' + boot1.title);

  /* ================= 2) 顶部搜索 → 结果页；侧栏不高亮 ================= */
  say('\n[2] 顶部搜索 → 结果页，侧栏不误亮：');
  await evalJS(`(() => { const el = document.getElementById('searchInput');
    el.value = '测试'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(600);
  const afterSearch = await evalJS(`({
    view: currentView,
    title: (document.querySelector('#content .block-title') || {}).textContent || '',
  })`);
  const navAfterSearch = await navState();
  const litAfterSearch = navAfterSearch.filter((n) => n.on).map((n) => n.v);
  say(`  搜索后 currentView=${afterSearch.view}，标题「${afterSearch.title}」，高亮=[${litAfterSearch.join(', ')}]`);
  if (afterSearch.view === 'search' && /搜索结果/.test(afterSearch.title)) ok('顶部搜索仍然能出结果页（搜索功能没被删）');
  else bad('顶部搜索没出结果页：' + JSON.stringify(afterSearch));
  if (litAfterSearch.length === 0) ok('搜索结果页是"临时页"，侧栏四项都不亮（不误亮）');
  else bad('搜索结果页侧栏不该有高亮，实际亮了：' + litAfterSearch.join(', '));

  /* ================= 3) 点侧栏 → 高亮跟着走 ================= */
  say('\n[3] 点侧栏，高亮跟着走：');
  await clickSel('.nav-item[data-view="favorites"]');
  const navFav = (await navState()).filter((n) => n.on).map((n) => n.v);
  await clickSel('.nav-item[data-view="discovery"]');
  const navDisc = (await navState()).filter((n) => n.on).map((n) => n.v);
  say(`  点「我喜欢」后高亮=[${navFav.join(', ')}]；点「发现」后高亮=[${navDisc.join(', ')}]`);
  if (navFav.length === 1 && navFav[0] === 'favorites') ok('点「我喜欢」→ 只有它亮');
  else bad('点「我喜欢」高亮不对：' + navFav.join(', '));
  if (navDisc.length === 1 && navDisc[0] === 'discovery') ok('点「发现」→ 只有它亮');
  else bad('点「发现」高亮不对：' + navDisc.join(', '));

  /* ================= 4) bg:// 支持 Range（真发请求） ================= */
  say('\n[4] bg:// 真的支持 Range（视频边读边传的关键）：');
  // 用主进程的 net.fetch 发请求：它没有页面源、不受 CORS 约束，
  // 打的就是应用里那个 bg:// 处理器本身（协议注册在默认 session 上）。
  const bgFetch = async (range) => {
    const r = await net.fetch('bg://local/' + TEST_VIDEO, range ? { headers: { Range: range } } : {});
    const b = await r.arrayBuffer();
    return { status: r.status, cr: r.headers.get('content-range'), ar: r.headers.get('accept-ranges'), type: r.headers.get('content-type'), len: b.byteLength };
  };

  const r206 = await bgFetch('bytes=0-99');
  say(`  Range: bytes=0-99 → HTTP ${r206.status}，Content-Range=${r206.cr}，Accept-Ranges=${r206.ar}，收到 ${r206.len} 字节`);
  if (r206.status === 206 && r206.cr === `bytes 0-99/${VIDEO_BYTES}` && r206.len === 100) ok('带 Range 的请求返回 206 + 正确的 Content-Range，且只回了这一段');
  else bad('Range 没生效：' + JSON.stringify(r206));

  const rFull = await bgFetch(null);
  say(`  不带 Range → HTTP ${rFull.status}，${rFull.len} 字节，type=${rFull.type}`);
  if (rFull.status === 200 && rFull.len === VIDEO_BYTES && rFull.type === 'video/mp4') ok('不带 Range 时返回完整文件 + 正确的 video/mp4 类型');
  else bad('整文件返回不对：' + JSON.stringify(rFull));

  const rTail = await bgFetch('bytes=-50');
  say(`  Range: bytes=-50（最后 50 字节）→ HTTP ${rTail.status}，Content-Range=${rTail.cr}，${rTail.len} 字节`);
  if (rTail.status === 206 && rTail.cr === `bytes ${VIDEO_BYTES - 50}-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`) ok('后缀 Range（bytes=-N）也正确');
  else bad('后缀 Range 不对：' + JSON.stringify(rTail));

  const rBad = await bgFetch('bytes=99999-100000');
  say(`  越界 Range: bytes=99999-100000 → HTTP ${rBad.status}`);
  if (rBad.status === 416) ok('越界 Range 返回 416（不是崩掉）');
  else bad('越界 Range 没返回 416：' + rBad.status);

  /* ================= 5) 选视频 → video 元素出现并播放 ================= */
  say('\n[5] 选视频当背景：');
  await evalJS(`(() => { const v = document.getElementById('bgVideo');
    window.__playCalls = 0; window.__pauseCalls = 0;
    v.play = () => { window.__playCalls++; return Promise.resolve(); };
    v.pause = () => { window.__pauseCalls++; };
    return true; })()`);
  await evalJS(`document.getElementById('btnSettings').click(); true`);
  await sleep(250);
  await evalJS(`document.getElementById('btnPickBgVideo').click(); true`);
  await sleep(500);
  const vs = await evalJS(`(() => {
    const v = document.getElementById('bgVideo');
    return {
      on: v.classList.contains('on'), src: v.getAttribute('src'),
      muted: v.muted, loop: v.loop, rate: v.playbackRate,
      kind: DB.settings.bg.kind, file: DB.settings.bg.file,
      play: window.__playCalls,
      hint: document.getElementById('bgHint').textContent,
      optsShown: getComputedStyle(document.getElementById('bgVideoOpts')).display !== 'none',
      picks: ${JSON.stringify(pickCalls)}.slice(-1)[0],
    };
  })()`);
  say(`  选完：src=${vs.src}，kind=${vs.kind}，静音=${vs.muted}，循环=${vs.loop}，速度=${vs.rate}，play() 调了 ${vs.play} 次`);
  say(`  面板提示「${vs.hint}」，视频专属开关可见=${vs.optsShown}，bg:pick 收到的 kind=${vs.picks}`);
  if (vs.on && vs.src === `bg://local/${TEST_VIDEO}`) ok('背景层出现 <video>，地址走 bg:// 协议');
  else bad('video 元素没显示或地址不对：' + JSON.stringify(vs));
  if (vs.kind === 'video' && vs.file === TEST_VIDEO) ok('存档里的背景类型变成 video');
  else bad('kind / file 没更新：' + vs.kind + ' / ' + vs.file);
  if (vs.muted === true && vs.loop === true && vs.rate === 1) ok('静音 / 循环 / 速度都按默认值刷上去了');
  else bad('视频属性不对：' + JSON.stringify(vs));
  // ★ 第八轮改了行为：遮罩（含设置面板）盖在界面上时，动态背景要暂停 ——
  //   遮罩自己还压着毛玻璃，不暂停就是白烧显卡。所以"选完立刻 play"这条老断言不再成立，
  //   改成：面板开着时先不播 → 关掉面板后必须自动开始播。
  if (vs.play === 0) ok('设置面板开着时先不播（第八轮新增：遮罩打开就暂停，省显卡）');
  else bad('设置面板开着时不该播，实际 play() 调了 ' + vs.play + ' 次');
  await evalJS(`document.getElementById('btnCloseModal').click(); true`);
  await sleep(450);
  const afterClose = await evalJS('({ play: window.__playCalls })');
  if (afterClose.play >= 1) ok(`关掉设置面板后自动开始播（play() 共 ${afterClose.play} 次）`);
  else bad('关掉设置面板后没有开始播');
  if (/动态背景/.test(vs.hint) && vs.optsShown) ok('设置面板提示"动态背景"并展开专属开关');
  else bad('设置面板没同步：' + vs.hint + ' / ' + vs.optsShown);
  if (vs.picks === 'video') ok("点了「选择视频」→ IPC 收到 kind='video'");
  else bad('IPC 收到的 kind 不对：' + vs.picks);

  /* 改设置：静音关掉 + 速度 1.5× → 立刻反映到 video 上 */
  await evalJS(`(() => {
    const m = document.getElementById('chkVideoMuted'); m.checked = false;
    m.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.getElementById('rngVideoSpeed'); s.value = '1.5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);
  await sleep(250);
  const vs2 = await evalJS(`(() => { const v = document.getElementById('bgVideo');
    return { muted: v.muted, rate: v.playbackRate, savedMuted: DB.settings.bg.video.muted, savedSpeed: DB.settings.bg.video.speed }; })()`);
  say(`  改设置后：静音=${vs2.muted}（存档 ${vs2.savedMuted}），速度=${vs2.rate}（存档 ${vs2.savedSpeed}）`);
  if (vs2.muted === false && vs2.rate === 1.5 && vs2.savedMuted === false && vs2.savedSpeed === 1.5) ok('静音 / 速度的改动即时生效并写进存档');
  else bad('视频设置没生效：' + JSON.stringify(vs2));

  /* ================= 6) 清除背景 → video 隐藏并暂停 ================= */
  say('\n[6] 清除背景：');
  await evalJS(`document.getElementById('btnClearBg').click(); true`);
  await sleep(400);
  const clr = await evalJS(`(() => { const v = document.getElementById('bgVideo');
    return { on: v.classList.contains('on'), pause: window.__pauseCalls, file: DB.settings.bg.file,
      hint: document.getElementById('bgHint').textContent,
      optsShown: getComputedStyle(document.getElementById('bgVideoOpts')).display !== 'none' }; })()`);
  say(`  清除后：video 显示=${clr.on}，pause() 调了 ${clr.pause} 次，file=${clr.file}，提示「${clr.hint}」`);
  if (!clr.on && clr.file === null) ok('video 隐藏了，存档里的背景也清空');
  else bad('清除没生效：' + JSON.stringify(clr));
  if (clr.pause >= 1) ok('清除时调用了 pause()（不播了，省电）');
  else bad('清除时没有暂停视频');
  if (!clr.optsShown && /默认深色背景/.test(clr.hint)) ok('视频专属开关收起，提示回到"默认深色背景"');
  else bad('清除后设置面板没同步：' + clr.hint + ' / ' + clr.optsShown);

  /* ================= 7) 重启后视频背景还在；老存档零迁移 ================= */
  say('\n[7] 重启后状态 + 老存档兼容：');
  await evalJS(`(async () => {
    DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    DB.settings.bg.video = { muted: true, loop: true, speed: 1 };
    await persist(); return true; })()`);
  await sleep(700);
  await boot();
  const reb = await evalJS(`(() => { const v = document.getElementById('bgVideo');
    return { kind: DB.settings.bg.kind, file: DB.settings.bg.file,
      on: v.classList.contains('on'), src: v.getAttribute('src') }; })()`);
  say(`  重启后：kind=${reb.kind}，file=${reb.file}，video 显示=${reb.on}，src=${reb.src}`);
  if (reb.kind === 'video' && reb.file === TEST_VIDEO && reb.on) ok('重启后视频背景还在（自动接着播）');
  else bad('重启后视频背景丢了：' + JSON.stringify(reb));

  // 老存档：settings.bg 只有 {file, dim, blur}，没有 kind —— 必须当成图片（旧行为），不能崩
  lastSaved.settings.bg = { file: 'old.png', dim: 0.55, blur: 0 };
  await boot();
  const legacy = await evalJS(`(() => { const v = document.getElementById('bgVideo');
    return { kind: DB.settings.bg.kind, file: DB.settings.bg.file, videoDefault: DB.settings.bg.video,
      on: v.classList.contains('on') }; })()`);
  say(`  老存档（无 kind）→ kind=${legacy.kind}，video 默认=${JSON.stringify(legacy.videoDefault)}，video 显示=${legacy.on}`);
  if (legacy.kind === 'image' && !legacy.on) ok('老存档零迁移：没有 kind → 当作图片背景（跟以前一样）');
  else bad('老存档兼容失败：' + JSON.stringify(legacy));
  if (legacy.videoDefault && legacy.videoDefault.muted === true && legacy.videoDefault.speed === 1) ok('老存档也会补上 video 的默认值（静音 / 循环 / 1×）');
  else bad('video 默认值没补：' + JSON.stringify(legacy.videoDefault));

  /* 截图：启动即发现页 + 视频背景设置面板 */
  await evalJS(`(async () => {
    DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    applyAppearance(); syncSettingsUI();
    document.getElementById('btnSettings').click();
    return true; })()`);
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round7.png'), img.toPNG());
  say('\n已保存 shot-round7.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n第七轮实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
