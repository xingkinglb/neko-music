/* 问题 B 的验证探针（修订后）：确认断流自愈真的接上了。

   验证点：
     ① stalled / waiting 现在被监听了，且会触发"重新解析地址 → 接回去"
     ② 自愈后 audio.src 换了新地址、currentTime 接回原位置、继续播
     ③ 8 秒冷却生效（连发多次 waiting 只自愈一次）
     ④ deadline 定时器会被挂上（预防式）
     ⑤ 文件/接口失败时自愈不把播放器搞崩

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-heal-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => fs.appendFileSync(OUT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const OK = (m) => say('  OK   ' + m);
const BAD = (m) => { fail++; say('  FAIL ' + m); };

const TRACK = { bvid: 'BV1song0001', cid: 7, page: 1, title: '大鱼', author: '周深', cover: '', duration: 312 };

/* 每次 audioUrl 返回**不同的**地址，好验证"确实换了新地址"。
   deadline 故意设成"未来 1 小时"，这样预防式定时器也会被挂上（delay > 0）。 */
const futureDl = Math.floor(Date.now() / 1000) + 3600;
let urlCalls = 0;
function mkUrl(tag) {
  return 'bili://get?url=' + encodeURIComponent(
    'https://xy1x2x3x4x5.mcdn.bilivideo.cn:4483/upgcxcode/a.m4s' +
    '?deadline=' + futureDl + '&gen=playurlv3&os=mcdn&mid=0&sk=' + tag);
}

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200,
          pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
ipcMain.handle('bili:audioUrl', () => {
  urlCalls++;
  return { ok: true, data: { url: mkUrl('call' + urlCalls), quality: 30280, duration: 312, backup: [] } };
});
require('./stub-download-ipc.js')({ tasks: [], dir: null });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  /* ---------- ① 事件是否已监听 ---------- */
  say('=== ① 断流事件是否已接上（源码扫描）===');
  const appjs = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const listened = [...appjs.matchAll(/audio\.addEventListener\(\s*'([^']+)'/g)].map((m) => m[1]);
  say('  已监听：' + JSON.stringify(listened));
  for (const ev of ['stalled', 'waiting']) {
    if (listened.includes(ev)) OK(ev + ' 已监听');
    else BAD(ev + ' 没监听');
  }
  if (/function healOnStall\(/.test(appjs)) OK('有 healOnStall()');
  else BAD('没有 healOnStall()');
  if (/function refreshAudioUrl\(/.test(appjs)) OK('有 refreshAudioUrl()');
  else BAD('没有 refreshAudioUrl()');
  if (/function armDeadlineTimer\(/.test(appjs)) OK('有 armDeadlineTimer()（预防式）');
  else BAD('没有 armDeadlineTimer()');
  if (/function srcDeadlineAt\(/.test(appjs)) OK('有 srcDeadlineAt()（解析 deadline）');
  else BAD('没有 srcDeadlineAt()');
  if (/audio\.addEventListener\('stalled', \(\) => \{ healOnStall\(\); \}\)/.test(appjs)) OK('stalled → healOnStall');
  else BAD('stalled 没接到 healOnStall');
  if (/audio\.addEventListener\('waiting', \(\) => \{ healOnStall\(\); \}\)/.test(appjs)) OK('waiting → healOnStall');
  else BAD('waiting 没接到 healOnStall');

  /* ---------- ② 纯逻辑：srcDeadlineAt / realUrlOf 解析 ---------- */
  say('\n=== ② deadline 解析逻辑 ===');
  const parsed = await evalJS(`(() => {
    const u = ${JSON.stringify(mkUrl('x'))};
    return { real: realUrlOf(u) ? 'OK' : 'NO', dl: srcDeadlineAt(u), expect: ${futureDl} * 1000,
             bad: srcDeadlineAt('bili://get?url=' + encodeURIComponent('https://a/b.m4s?deadline=nope')) };
  })()`);
  say('  realUrlOf 能从 bili:// 里掏出真实地址 = ' + parsed.real);
  say('  srcDeadlineAt = ' + parsed.dl + '（期望 ' + parsed.expect + '）');
  say('  坏值返回 = ' + parsed.bad + '（期望 0）');
  if (parsed.real === 'OK' && parsed.dl === parsed.expect && parsed.bad === 0) OK('解析正确');
  else BAD('解析不对：' + JSON.stringify(parsed));

  /* ---------- ③ 端到端：模拟 stalled → 应换 src 并接回位置 ---------- */
  say('\n=== ③ 端到端：播一首 → 派发 stalled → 看会不会换地址接回去 ===');
  const setup = await evalJS(`(async () => {
    currentView = 'search'; searchKeyword = '测试';
    searchResults = [${JSON.stringify(TRACK)}];
    renderAll();
    playTracks(searchResults.slice(), 0, '测试');
    return true;
  })()`);
  await sleep(1600);   // 等 playAt 走完（cid 已有，直接取地址）

  const before = await evalJS(`({
    src: audio.src, currentTime: audio.currentTime, paused: audio.paused,
    deadlineTimer: deadlineTimer !== null, lastSetSrcHasDeadline: /deadline/.test(realUrlOf(lastSetSrc)),
    lastSetSrc: lastSetSrc.slice(0, 60),
  })`);
  say('  播放前 src = ' + before.src.slice(0, 80));
  say('  audio.paused = ' + before.paused + '（★ 离屏沙箱没有音频设备 → 多半是 true，' +
      '这会命中 healOnStall 里"用户暂停"那条闸门，所以下面要显式把 paused 置成 false 再测）');
  say('  deadline 定时器已挂 = ' + before.deadlineTimer + '（预防式）');
  const callsBefore = urlCalls;
  say('  此刻 audioUrl 调用次数 = ' + callsBefore);

  // 把播放位置设到一个"半中间"的样子
  await evalJS(`(() => { try { audio.currentTime = 42; } catch(e) {} return true; })()`);
  await sleep(200);
  // ★ 关键：沙箱里 audio 永远 paused（没声卡），healOnStall 会以为"用户按了暂停"直接返回。
  //   这里用 Object.defineProperty 把这个只读属性临时改掉，模拟"正在播但断流了"。
  const patched = await evalJS(`(() => {
    try {
      Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
      return { ok: true, pausedNow: audio.paused };
    } catch (e) { return { ok: false, err: e.message }; }
  })()`);
  say('  强制 audio.paused=false 以模拟"正在播" = ' + JSON.stringify(patched));
  const gate = await evalJS(`({
    healBusy, lastHealAt, cooldown: HEAL_COOLDOWN,
    sinceHeal: Date.now() - lastHealAt,
    paused: audio.paused, src: !!audio.src,
    wouldReturn: (healBusy ? 'healBusy' : (audio.paused ? 'paused' : (!audio.src ? 'noSrc' : (Date.now() - lastHealAt < HEAL_COOLDOWN ? 'cooldown' : 'PASS'))))
  })`);
  say('  healOnStall 闸门诊断：' + JSON.stringify(gate));
  if (gate.wouldReturn !== 'PASS') say('  ★ 注意：此刻 healOnStall 会因为 "' + gate.wouldReturn + '" 直接返回，先清掉它再测');
  await evalJS(`(() => { healBusy = false; lastHealAt = 0; return true; })()`);
  await evalJS(`(() => { audio.dispatchEvent(new Event('stalled')); return true; })()`);
  await sleep(2500);

  const after = await evalJS(`({
    src: audio.src, currentTime: audio.currentTime, paused: audio.paused,
    deadlineTimer: deadlineTimer !== null,
  })`);
  const newCalls = urlCalls - callsBefore;
  say('  派发 stalled 后：audioUrl 调用次数增 = ' + newCalls + '（>0 说明重新解析了地址）');
  say('  新 src = ' + String(after.src).slice(0, 80));
  say('  src 换了吗 = ' + (after.src !== before.src));
  say('  currentTime 接回 = ' + after.currentTime + '（期望 ≈ 42）');

  if (newCalls > 0) OK('stalled 触发了重新解析地址');
  else BAD('stalled 没有触发重新解析（自愈没接上）');
  if (after.src !== before.src) OK('音频地址真的换成了新解析出来的那条');
  else BAD('audio.src 没换');
  if (after.currentTime >= 40 && after.currentTime <= 44) OK('播放位置接回原处（没有从头开始）');
  else BAD('播放位置没接回去：' + after.currentTime);

  /* ---------- ④ 冷却：连发 5 次 stalled/waiting，只该自愈一次 ---------- */
  say('\n=== ④ 8 秒冷却：连发 5 次 stalled / waiting ===');
  const c2 = urlCalls;
  await evalJS(`(() => {
    for (let i = 0; i < 5; i++) { audio.dispatchEvent(new Event('stalled')); audio.dispatchEvent(new Event('waiting')); }
    return true;
  })()`);
  await sleep(2500);
  const extra = urlCalls - c2;
  say('  5 次事件后 audioUrl 调用次数增 = ' + extra + '（期望 ≤1 —— 冷却期内只许自愈一次）');
  if (extra <= 1) OK('冷却生效，弱网下不会疯狂重试');
  else BAD('冷却没生效，狂发请求：' + extra);

  /* ---------- ⑤ 暂停时不该自愈 ---------- */
  say('\n=== ⑤ 用户暂停时不擅自自愈 ===');
  // ★ 先把上一节为测试强行改掉的 paused 恢复成"真暂停"，
  //   并清掉冷却 —— 否则"没自愈"可能是被冷却挡的，测不出真正原因。
  await evalJS(`(() => {
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => true });
    lastHealAt = 0;
    return true;
  })()`);
  await sleep(300);
  const c3 = urlCalls;
  await evalJS(`(() => { audio.dispatchEvent(new Event('stalled')); return true; })()`);
  await sleep(1200);
  const extra3 = urlCalls - c3;
  say('  暂停状态派发 stalled → audioUrl 调用次数增 = ' + extra3 + '（期望 0）');
  if (extra3 === 0) OK('暂停时不自愈（不会把用户晾在半路）');
  else BAD('暂停时也去自愈了：' + extra3);

  /* ---------- ⑥ 接口失败时不能崩 ---------- */
  say('\n=== ⑥ 自愈时接口失败 → 不崩、有兜底 ===');
  // 把 audioUrl 临时换成"失败"
  const origHandler = ipcMain.removeHandler('bili:audioUrl');
  let failMode = false;
  ipcMain.handle('bili:audioUrl', () => {
    if (failMode) return { ok: false, error: '模拟接口挂了' };
    urlCalls++;
    return { ok: true, data: { url: mkUrl('call' + urlCalls), quality: 30280, duration: 312, backup: [] } };
  });
  await evalJS(`(() => {
    queue = { tracks: [${JSON.stringify(TRACK)}, { bvid: 'BV1x', cid: 8, title: '第二首', duration: 100 }], index: 0, name: 't' };
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });   // 当作在播
    lastHealAt = 0; healBusy = false;
    window.__nexted = 0;
    window.next = () => { window.__nexted = (window.__nexted || 0) + 1; };
    return true;
  })()`);
  failMode = true;
  await evalJS(`(() => { audio.dispatchEvent(new Event('stalled')); return true; })()`);
  await sleep(1800);
  const survived = await evalJS(`({ alive: true, healBusy: healBusy, nexted: window.__nexted || 0 })`);
  say('  接口失败后：页面还活着 = ' + survived.alive + '，healBusy 释放 = ' + !survived.healBusy
      + '，自动跳下一首次数 = ' + survived.nexted);
  if (survived.alive && !survived.healBusy) OK('自愈失败后状态正确释放（不会永久卡死自愈锁）');
  else BAD('自愈失败后状态没释放：' + JSON.stringify(survived));

  say('\n=== 小结 ===');
  say(fail === 0 ? '  全部通过 ✅' : '  发现 ' + fail + ' 处问题 ❌');
  say('\n探针结束');
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => process.exit(2), 200); });
