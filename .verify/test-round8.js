/* 第八轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     · 动态背景随窗口等比缩放 —— 三种窗口尺寸下量 #bgVideo 盒子，必须等于 .bg-layer 盒子
     · 模糊只作用于图片层 —— .bg-layer 的 filter 必须是 none，.bg-image 才有 blur()
     · 面板毛玻璃 —— v2.0.0 起改为三档（plain / prebake / live），
       本文件只做冒烟：默认 prebake 下四块面板没有真 backdrop-filter、live 下恢复；
       三档的完整断言在 test-round9.js
     · "该停就停" —— 窗口失焦暂停 / 回焦恢复 / 打开遮罩暂停
     · 改名 —— 界面文案统一是「动态背景」，不再出现「视频背景」
     · 图片背景不受影响 —— 图片层有背景图，视频层隐藏且暂停
   ★ 沙箱没有真实 GPU（软件光栅），测不了任务管理器里那个 GPU%。
     这里只量"元素盒子 / 计算样式 / 播放状态"，是相对判据；真实 GPU% 要本机对照。
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
const REPORT = path.join(__dirname, 'test-round8-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const BG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bg8-'));
const TEST_VIDEO = 'bg-test.mp4';
const TEST_IMAGE = 'bg-test.png';
fs.writeFileSync(path.join(BG_DIR, TEST_VIDEO), Buffer.alloc(2048, 7));
fs.writeFileSync(path.join(BG_DIR, TEST_IMAGE), Buffer.alloc(64, 3));

protocol.registerSchemesAsPrivileged([{
  scheme: 'bg',
  privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true },
}]);

const { registerBgProtocol } = require(path.join(ROOT, 'src', 'bg-protocol.js'));

let lastSaved = null;
ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved || { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
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
      // 离屏窗口的"页面可见性"在沙箱里可能是 hidden，会让暂停逻辑一直生效 ——
      // 强行按"可见"处理，才能测到播放 / 暂停的真实分支（这只是测试环境的桩）。
      window.__origHidden = document.hidden;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  const hiddenOrig = await evalJS('window.__origHidden');
  say('（沙箱里离屏窗口原始 document.hidden = ' + hiddenOrig + '，测试中已按"可见"处理）');

  /* ================= 1) 动态背景随窗口等比缩放（核心） ================= */
  say('\n[1] 动态背景随窗口等比缩放（核心）：');
  await evalJS(`(async () => {
    DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    applyAppearance(); syncSettingsUI();
    return true; })()`);
  await sleep(400);

  const measure = () => evalJS(`(() => {
    const l = document.getElementById('bgLayer').getBoundingClientRect();
    const v = document.getElementById('bgVideo').getBoundingClientRect();
    const vv = document.getElementById('bgVideo');
    return { layer: { w: Math.round(l.width), h: Math.round(l.height) },
             video: { w: Math.round(v.width), h: Math.round(v.height) },
             on: vv.classList.contains('on'), src: vv.getAttribute('src') };
  })()`);

  const sizes = [[1180, 760], [800, 600], [1500, 900]];
  for (const [w, h] of sizes) {
    win.setContentSize(w, h);
    await sleep(500);
    const m = await measure();
    const dw = Math.abs(m.video.w - m.layer.w);
    const dh = Math.abs(m.video.h - m.layer.h);
    say(`  窗口 ${w}×${h} → .bg-layer ${m.layer.w}×${m.layer.h}，#bgVideo ${m.video.w}×${m.video.h}（差 ${dw}/${dh}px）`);
    if (m.on && dw <= 2 && dh <= 2 && m.video.w > 0) ok(`窗口 ${w}×${h}：视频盒子 == 背景层盒子（等比铺满）`);
    else bad(`窗口 ${w}×${h}：视频盒子没跟着窗口走（${m.video.w}×${m.video.h} vs ${m.layer.w}×${m.layer.h}）`);
  }

  /* ================= 2) 模糊只作用于图片层 ================= */
  say('\n[2] 模糊隔离（视频不参与模糊）：');
  await evalJS(`(() => { DB.settings.bg.blur = 8; applyAppearance(); return true; })()`);
  await sleep(300);
  const blur = await evalJS(`(() => {
    const layer = getComputedStyle(document.getElementById('bgLayer')).filter;
    const img = getComputedStyle(document.getElementById('bgImage')).filter;
    return { layer, img };
  })()`);
  say(`  .bg-layer filter = ${blur.layer}；.bg-image filter = ${blur.img}`);
  if (blur.layer === 'none') ok('.bg-layer 上没有 filter（不会把视频一起每帧重糊）');
  else bad('.bg-layer 还挂着 filter：' + blur.layer);
  if (/blur\(8px\)/.test(blur.img)) ok('.bg-image 承担了模糊（图片背景的模糊滑杆仍然有效）');
  else bad('.bg-image 的模糊不对：' + blur.img);

  /* ================= 3) 面板毛玻璃（v2.0.0 起改为三档，细节见 test-round9.js） ================= */
  say('\n[3] 面板毛玻璃三档（默认 prebake）：');
  const glassOf = () => evalJS(`(() => {
    const sel = ['.titlebar', '.sidebar', '.topbar', '.player'];
    const out = {};
    sel.forEach((s) => { const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).backdropFilter : 'MISSING'; });
    return { mode: DB.settings.glass.mode, filters: out,
             boost: getComputedStyle(document.body).getPropertyValue('--glass-boost').trim() };
  })()`);

  await evalJS(`(() => { DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    DB.settings.glass.mode = 'prebake'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(700);
  const gp = await glassOf();
  say(`  图片背景 + prebake：mode=${gp.mode}，四面板 backdrop-filter=${JSON.stringify(gp.filters)}，--glass-boost=${gp.boost}`);
  if (gp.mode === 'prebake') ok('默认档是 prebake（用预先糊好的图，成本≈0）');
  else bad('默认档不是 prebake：' + gp.mode);
  const notNone = Object.keys(gp.filters).filter((k) => gp.filters[k] !== 'none');
  if (notNone.length === 0) ok('prebake 档四块常驻面板都没有真 backdrop-filter（不再每帧重算）');
  else bad('这些面板还开着毛玻璃：' + notNone.join(' / ') + ' → ' + JSON.stringify(gp.filters));
  if (parseFloat(gp.boost) > 0) ok('关掉真模糊的档同时抬高了面板底色（--glass-boost=' + gp.boost + '）');
  else bad('没有抬高面板底色：' + gp.boost);

  await evalJS(`(() => { DB.settings.glass.mode = 'live'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(400);
  const gl = await glassOf();
  say(`  live 档：四面板 backdrop-filter=${JSON.stringify(gl.filters)}`);
  const allBlur = Object.keys(gl.filters).filter((k) => /blur/.test(gl.filters[k]));
  if (allBlur.length === 4) ok('live 档四块面板恢复真毛玻璃（与 v1.9.0 观感一致，作回归基准）');
  else bad('live 档面板毛玻璃没恢复：' + JSON.stringify(gl.filters));

  // 新开关在界面上真的渲染出来了吗（别只是数据对、控件没画出来）
  await evalJS(`(() => { DB.settings.bg.kind = 'video'; DB.settings.bg.file = '${TEST_VIDEO}';
    DB.settings.glass.mode = 'prebake'; DB.settings.bg.pauseOnBlur = true;
    applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(300);
  // ★ 开关底色带 transition: background 0.2s。离屏窗口**不产生帧**，过渡会"卡在切换前的旧值"上，
  //   于是 getComputedStyle 读到的是勾选**之前**的颜色 —— 看起来就像勾选状态反了。
  //   取样前先把过渡/动画掐掉并强制一次重排，读到的才是真正的目标值。
  await evalJS(`(() => {
    const s = document.createElement('style');
    s.id = '__noAnimForSampling';
    s.textContent = '* { transition: none !important; animation: none !important; }';
    document.head.appendChild(s);
    void document.body.offsetHeight;   // 强制重排，让"无过渡"立刻生效
    return true; })()`);
  const sw = await evalJS(`(() => {
    const ids = ['chkVideoMuted', 'chkVideoLoop', 'chkGlassPerf', 'chkGlassLive', 'chkPauseBlur'];
    const out = {};
    ids.forEach((id) => {
      const i = document.getElementById(id);
      const track = i && i.nextElementSibling;
      out[id] = i ? { checked: i.checked, track: track ? getComputedStyle(track).backgroundColor : 'NO-SWITCH-SPAN' } : 'MISSING';
    });
    return out;
  })()`);
  await evalJS(`(() => { const s = document.getElementById('__noAnimForSampling'); if (s) s.remove(); return true; })()`);
  say(`  五个开关：${JSON.stringify(sw)}`);
  const missingSw = Object.keys(sw).filter((k) => sw[k] === 'MISSING' || sw[k].track === 'NO-SWITCH-SPAN');
  if (missingSw.length) bad('这些开关没渲染出来：' + missingSw.join(' / '));
  else ok('五个开关都在界面上渲染出来了');
  // 只看"勾着的"开关：未勾的开关底色是透明的，拿它比颜色没有意义
  const onTracks = Object.keys(sw).filter((k) => sw[k] && sw[k].checked).map((k) => sw[k].track);
  if (sw.chkGlassPerf && sw.chkGlassPerf.checked === true && sw.chkPauseBlur && sw.chkPauseBlur.checked === true)
    ok('默认档下「省显卡」与「窗口不在前台时暂停」都是开');
  else bad('默认开关值不对：' + JSON.stringify(sw));
  if (new Set(onTracks).size === 1 && /^rgba?\(/.test(onTracks[0]) && !/rgba\(0, 0, 0, 0\)/.test(onTracks[0]))
    ok('新开关的"开"态配色和老开关一致，且真的是主题色（' + onTracks[0] + '）');
  else bad('新开关配色和老开关不一致（勾上的应该是同一个主题色）：' + JSON.stringify(onTracks));

  /* ================= 4) "该停就停" ================= */
  say('\n[4] 该停就停：失焦 / 回焦 / 打开遮罩：');
  await evalJS(`(async () => {
    DB.settings.bg.file = '${TEST_VIDEO}'; DB.settings.bg.kind = 'video';
    DB.settings.bg.pauseOnBlur = true;
    applyAppearance(); syncSettingsUI();
    const v = document.getElementById('bgVideo');
    window.__last = 'init'; window.__plays = 0; window.__pauses = 0;
    v.play = () => { window.__plays++; window.__last = 'play'; return Promise.resolve(); };
    v.pause = () => { window.__pauses++; window.__last = 'pause'; };
    // 保证遮罩都是关的，从"该播"的状态起步
    ['modalMask','collectMask','queueMask','promptMask'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.classList.remove('show');
    });
    updateBgVideoPlayback();
    return true; })()`);
  await sleep(300);
  const st0 = await evalJS('({ last: window.__last, plays: window.__plays, pauses: window.__pauses })');
  say(`  起点（无遮罩、窗口在前台）：last=${st0.last}`);
  if (st0.last === 'play') ok('没有任何"该停"的理由时，动态背景在播');
  else bad('起点就没在播：' + JSON.stringify(st0));

  await evalJS(`window.dispatchEvent(new Event('blur')); true`);
  await sleep(200);
  const stBlur = await evalJS('({ last: window.__last, pauses: window.__pauses })');
  say(`  窗口失焦后：last=${stBlur.last}，pause() 共 ${stBlur.pauses} 次`);
  if (stBlur.last === 'pause') ok('窗口失焦 → 暂停（切到别的软件不再烧显卡）');
  else bad('窗口失焦没有暂停：' + JSON.stringify(stBlur));

  await evalJS(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(200);
  const stFocus = await evalJS('({ last: window.__last, plays: window.__plays })');
  say(`  回焦后：last=${stFocus.last}，play() 共 ${stFocus.plays} 次`);
  if (stFocus.last === 'play') ok('回到前台 → 自动接着播');
  else bad('回焦没有恢复播放：' + JSON.stringify(stFocus));

  await evalJS(`document.getElementById('btnSettings').click(); true`);
  await sleep(350);
  const stMask = await evalJS('({ last: window.__last, pauses: window.__pauses, shown: document.getElementById("modalMask").classList.contains("show") })');
  say(`  打开设置面板后：遮罩显示=${stMask.shown}，last=${stMask.last}`);
  if (stMask.shown && stMask.last === 'pause') ok('打开设置遮罩 → 暂停（遮罩自己也压着毛玻璃，省两次开销）');
  else bad('打开遮罩没有暂停：' + JSON.stringify(stMask));

  await evalJS(`document.getElementById('btnCloseModal').click(); true`);
  await sleep(350);
  const stUnmask = await evalJS('({ last: window.__last })');
  say(`  关掉设置面板后：last=${stUnmask.last}`);
  if (stUnmask.last === 'play') ok('关掉遮罩 → 恢复播放');
  else bad('关掉遮罩没有恢复：' + JSON.stringify(stUnmask));

  // "窗口不在前台时暂停"关掉后，失焦也不该停
  await evalJS(`(() => {
    const c = document.getElementById('chkPauseBlur'); c.checked = false;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    window.dispatchEvent(new Event('blur'));
    return true; })()`);
  await sleep(250);
  const stOff = await evalJS('({ last: window.__last, saved: DB.settings.bg.pauseOnBlur })');
  say(`  关掉"窗口不在前台时暂停"后再失焦：last=${stOff.last}，存档=${stOff.saved}`);
  if (stOff.last === 'play' && stOff.saved === false) ok('该开关可关：关掉后失焦也不停（设置生效并落盘）');
  else bad('"窗口不在前台时暂停"开关没生效：' + JSON.stringify(stOff));
  await evalJS(`window.dispatchEvent(new Event('focus')); true`);

  /* ================= 5) 改名「动态背景」 ================= */
  say('\n[5] 改名「动态背景」：');
  const naming = await evalJS(`(() => {
    const labels = Array.from(document.querySelectorAll('.pane[data-pane="appearance"] .field-label'))
      .map((e) => e.textContent);
    const label = labels.find((t) => t.includes('背景')) || '';
    const hint = document.getElementById('bgHint').textContent;
    const perfLabel = document.querySelector('#bgPerfOpts .switch-label').textContent;
    const htmlAll = document.documentElement.outerHTML;
    return { label, hint, perfLabel, hasOld: htmlAll.includes('视频背景') };
  })()`);
  say(`  分区标题「${naming.label}」，提示「${naming.hint}」，省显卡开关「${naming.perfLabel}」`);
  if (/动态背景/.test(naming.label)) ok('设置分区标题已叫「动态背景」');
  else bad('分区标题没改名：' + naming.label);
  if (/动态背景/.test(naming.hint)) ok('背景提示是「自定义动态背景 ✓」');
  else bad('背景提示没改名：' + naming.hint);
  if (!naming.hasOld) ok('整个界面（含注释）里已无「视频背景」字样');
  else bad('界面上还残留「视频背景」字样');

  /* ================= 6) 图片背景不受影响 ================= */
  say('\n[6] 图片背景不受影响：');
  await evalJS(`(async () => {
    DB.settings.bg.file = '${TEST_IMAGE}'; DB.settings.bg.kind = 'image';
    applyAppearance(); syncSettingsUI();
    return true; })()`);
  await sleep(400);
  const imgState = await evalJS(`(() => {
    const img = document.getElementById('bgImage');
    const v = document.getElementById('bgVideo');
    return {
      bgImage: getComputedStyle(img).backgroundImage,
      imgFilter: getComputedStyle(img).filter,
      videoOn: v.classList.contains('on'),
      videoDisplay: getComputedStyle(v).display,
      last: window.__last,
      hint: document.getElementById('bgHint').textContent,
      videoOptsShown: getComputedStyle(document.getElementById('bgVideoOpts')).display !== 'none',
      perfOptsShown: getComputedStyle(document.getElementById('bgPerfOpts')).display !== 'none',
      blurFieldOff: document.getElementById('fieldBgBlur').classList.contains('is-off'),
    };
  })()`);
  say(`  图片背景：background-image 含 bg:// = ${/bg:\/\/local/.test(imgState.bgImage)}，filter=${imgState.imgFilter}`);
  say(`  视频层：显示=${imgState.videoOn} / display=${imgState.videoDisplay}，last=${imgState.last}，提示「${imgState.hint}」`);
  if (/bg:\/\/local\/bg-test\.png/.test(imgState.bgImage)) ok('图片层挂上了 bg:// 背景图（跟以前一样）');
  else bad('图片背景没挂上：' + imgState.bgImage);
  if (!imgState.videoOn && imgState.videoDisplay === 'none') ok('切回图片后视频层隐藏');
  else bad('视频层没隐藏：' + JSON.stringify(imgState));
  if (imgState.last === 'pause') ok('切回图片后视频被暂停（不白烧电）');
  else bad('切回图片后视频没暂停：' + imgState.last);
  if (!imgState.videoOptsShown && !imgState.perfOptsShown && !imgState.blurFieldOff) ok('视频专属 / 省显卡开关收起，"背景模糊"滑杆恢复可用');
  else bad('切回图片后设置面板状态不对：' + JSON.stringify(imgState));

  // 背景是视频时，"背景模糊"滑杆应置灰
  await evalJS(`(() => { DB.settings.bg.kind = 'video'; DB.settings.bg.file = '${TEST_VIDEO}'; applyAppearance(); syncSettingsUI(); return true; })()`);
  await sleep(250);
  const blurOff = await evalJS(`({ off: document.getElementById('fieldBgBlur').classList.contains('is-off'),
    hint: document.getElementById('bgBlurHint').textContent })`);
  say(`  背景为视频时："背景模糊"置灰=${blurOff.off}，说明「${blurOff.hint.slice(0, 30)}…」`);
  if (blurOff.off && /不参与模糊|不走这一项/.test(blurOff.hint)) ok('背景是视频时"背景模糊"置灰并说明原因');
  else bad('"背景模糊"没置灰 / 没说明：' + JSON.stringify(blurOff));

  /* 截图：动态背景设置面板 */
  await evalJS(`(() => { document.getElementById('btnSettings').click(); return true; })()`);
  await sleep(500);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-round8.png'), shot.toPNG());
  say('\n已保存 shot-round8.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n第八轮实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
