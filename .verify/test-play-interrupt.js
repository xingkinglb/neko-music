/* 「The play() request was interrupted by a new load request」的实测（v2.0.4 修的 bug，v2.0.5 加固）：

   现象（Neo 的截图）：有些歌点了播放会弹「播放失败：The play() request was interrupted
   by a new load request.」，可歌**已经在唱了**；提示条第二行还挂着那首歌的媒体地址。

   真相：这**不是"取音频地址失败"**，而是**两次播放请求叠在一起**了 ——
   playAt() 里有两段 await（补 cid、取音频地址），期间用户又点了另一首，
   后一次把 audio.src 换掉，前一次还挂着的 audio.play() 就被浏览器打断并抛 AbortError。
   旧代码把这个 AbortError 当成真失败：弹提示 + 900ms 后自动跳下一首（会莫名跳歌）。

   v2.0.5 加固：Chromium 会在这类消息**末尾再附一行媒体地址**，所以判定改成"包含"，
   并加了第二道不依赖消息文字的闸门（地址被换掉 = 本次已过期）；真失败时提示条只显示原因。

   这里不是文本断言 —— 真的把 index.html + app.js 跑起来，把 audio 的 play()/src
   换成"和浏览器一样的行为"（src 一变，还挂着的 play() 就以 AbortError 拒绝，
   消息末尾同样附上地址），然后连点两首，看有没有弹提示、有没有多跳一首。

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
const REPORT = path.join(__dirname, 'test-play-interrupt-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => { fs.appendFileSync(REPORT, m + '\n'); process.stdout.write(m + '\n'); };
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ---------- 主进程桩 ---------- */
let audioUrlDelay = 0;   // 让"取音频地址"慢一点，制造两次播放重叠
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', async (_e, bvid) => {
  if (bvid === 'BVBAD') return { ok: false, error: '取音频地址失败（测试桩）' };   // 真失败：要提示、要跳下一首
  if (audioUrlDelay) await sleep(audioUrlDelay);
  return { ok: true, data: { url: 'https://example.invalid/' + bvid + '.m4s', quality: 30280, duration: 200, backup: [] } };
});
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

  /* ★ 把 audio 换成"和真浏览器一样"的桩：
     - play() 返回一个**过一会儿才 resolve** 的 promise（模拟"要缓冲才开唱"）；
     - 一旦 src 被重新赋值（= 新的加载请求），上一个还没 resolve 的 play() 就以
       AbortError 拒绝，消息和 Chromium 一模一样。 */
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    window.__playCalls = 0;
    window.__aborts = 0;
    window.__unhandled = 0;
    window.__src = '';
    let pending = null;

    Object.defineProperty(a, 'src', {
      configurable: true,
      get: () => window.__src,
      set: (v) => {
        window.__src = v;
        if (pending) {
          const fire = pending; pending = null;
          window.__aborts++;
          // ★ 和真实 Chromium 一致：消息末尾会**再附一行媒体地址**（Neo 的截图就是这样，
          //   第二行是 https://goo.gl/LdLk22）。所以判定不能用"整串相等"。
          const e = new Error('The play() request was interrupted by a new load request. https://goo.gl/LdLk22');
          e.name = 'AbortError';
          fire(e);
        }
      },
    });
    Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
    window.__paused = true;

    a.play = () => {
      window.__playCalls++;
      window.__paused = false;
      // 专门用来测"真失败 + 消息里带媒体地址"：应该弹提示，但提示里不该出现那串地址
      if (/BVBADPLAY/.test(window.__src)) {
        const e = new Error('Failed to load because no supported source was found. https://goo.gl/LdLk22');
        e.name = 'NotSupportedError';
        return Promise.reject(e);
      }
      return new Promise((res, rej) => {
        const t = setTimeout(() => { if (pending) pending = null; res(); }, 800);
        pending = (e) => { clearTimeout(t); rej(e); };
      });
    };
    a.pause = () => { window.__paused = true; };

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.addEventListener('unhandledrejection', (e) => {
      window.__unhandled++;
      console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason));
    });
    return true;
  })()`);
  await sleep(200);

  /* ---------- 场景：连点两首（第二次打断第一次还没走完的 play()） ---------- */
  const runCase = (gapMs) => evalJS(`(async () => {
    // 清场
    document.getElementById('toast').classList.remove('show');
    document.getElementById('toast').textContent = '';
    window.__playCalls = 0; window.__aborts = 0; window.__unhandled = 0;

    DB.history = []; DB.lastTrack = null; DB.favorites = [];
    const mk = (n) => ({ bvid: 'BVX' + n, cid: 900 + n, title: '测试歌 ' + n, author: 'UP', duration: 200 });
    queue = { tracks: [mk(0), mk(1), mk(2), mk(3)], index: -1, name: '测试' };

    playAt(0);                       // 第一首：play() 要 800ms 才 resolve
    await new Promise((r) => setTimeout(r, ${gapMs}));
    playAt(1);                       // 第二首：把 src 换掉 → 打断第一首的 play()

    await new Promise((r) => setTimeout(r, 1400));   // 等过"自动跳下一首"的 900ms
    return {
      index: queue.index,
      toastShown: document.getElementById('toast').classList.contains('show'),
      toastText: document.getElementById('toast').textContent,
      aborts: window.__aborts,
      playCalls: window.__playCalls,
      unhandled: window.__unhandled,
      nowTitle: document.getElementById('npTitle').textContent,
    };
  })()`);

  say('\n[1] 连点两首：第二首打断第一首还没走完的 play()（这是 Neo 截图里那条提示的来源）');
  const r1 = await runCase(120);
  say(`    play() 被调了 ${r1.playCalls} 次，其中被"新的加载请求"打断 ${r1.aborts} 次`);
  say(`    queue.index=${r1.index}（点了第 2 首，下标应当是 1）｜ 播放条显示「${r1.nowTitle}」`);
  say(`    提示条：${r1.toastShown ? '显示着「' + r1.toastText + '」' : '没有显示'}`);

  if (r1.aborts >= 1) ok(`真的制造出了"被新的加载请求打断"（${r1.aborts} 次）—— 场景有效`);
  else bad('没能制造出打断，这个用例没测到东西');

  if (r1.index === 1) ok('停在第 2 首（没有因为"打断"而莫名多跳一首）');
  else bad(`本该停在第 2 首（index=1），实际 index=${r1.index} —— 被"打断"带着跳歌了`);

  if (!r1.toastShown) ok('没有弹「播放失败」提示（被打断不是故障，静默忽略）');
  else bad(`还是弹了提示：「${r1.toastText}」`);

  say('\n[2] 播放条按钮（不 await 的那种 audio.play）在加载中途被打断时，不该产生"未处理的 promise 拒绝"');
  const r2 = await evalJS(`(async () => {
    window.__playCalls = 0; window.__aborts = 0; window.__unhandled = 0;
    window.__paused = true;
    const btn = document.getElementById('btnPlay');
    btn.click();                                  // 按下播放 → safePlay()
    await new Promise((r) => setTimeout(r, 100));
    // 此刻 play() 还挂着；再换一次 src（= 又点了一首）→ 打断它
    document.getElementById('audio').src = 'https://example.invalid/other.m4s';
    await new Promise((r) => setTimeout(r, 300));
    return { aborts: window.__aborts, unhandled: window.__unhandled };
  })()`);
  say(`    打断 ${r2.aborts} 次，未处理的 promise 拒绝 ${r2.unhandled} 条`);
  if (r2.aborts >= 1 && r2.unhandled === 0) ok('被打断的 play() 被吞掉了，没有变成未处理的拒绝');
  else if (r2.aborts === 0) bad('没制造出打断，这个用例没测到东西');
  else bad(`有 ${r2.unhandled} 条未处理的 promise 拒绝`);

  say('\n[3] 真失败仍然要提示 + 自动跳下一首（别把"打断静默"做成"什么都静默"）');
  const r3 = await evalJS(`(async () => {
    document.getElementById('toast').classList.remove('show');
    document.getElementById('toast').textContent = '';
    DB.history = [];
    // BVBAD 那一首：桩里让"取音频地址"直接返回失败
    queue = { tracks: [{ bvid: 'BVBAD', cid: 1, title: '坏链接', author: 'UP', duration: 200 },
                       { bvid: 'BVOK',  cid: 2, title: '下一首', author: 'UP', duration: 200 }], index: -1, name: '' };
    playAt(0);
    await new Promise((r) => setTimeout(r, 1400));   // 等过自动跳下一首的 900ms
    return { toastShown: document.getElementById('toast').classList.contains('show'),
             toastText: document.getElementById('toast').textContent,
             index: queue.index };
  })()`);
  say(`    提示条：${r3.toastShown ? '「' + r3.toastText + '」' : '没有显示'} ｜ queue.index=${r3.index}`);
  if (r3.toastShown && /播放失败/.test(r3.toastText)) ok('真失败（取不到音频地址）照旧弹「播放失败」');
  else bad('真失败却没有任何提示 —— 静默做过头了');
  if (r3.index === 1) ok('真失败后自动跳下一首（原有兜底行为保留）');
  else bad(`真失败后应当自动跳到第 2 首，实际 index=${r3.index}`);

  say('\n[4] 真失败的消息末尾带着媒体地址时，提示条只显示原因本身（别把那串 URL 也弹出来）');
  const r4 = await evalJS(`(async () => {
    document.getElementById('toast').classList.remove('show');
    document.getElementById('toast').textContent = '';
    DB.history = [];
    queue = { tracks: [{ bvid: 'BVBADPLAY', cid: 1, title: '放不出来的歌', author: 'UP', duration: 200 }],
              index: -1, name: '' };
    playAt(0);
    await new Promise((r) => setTimeout(r, 600));
    return { shown: document.getElementById('toast').classList.contains('show'),
             text: document.getElementById('toast').textContent };
  })()`);
  say(`    提示条：${r4.shown ? '「' + r4.text + '」' : '没有显示'}`);
  if (!r4.shown) bad('真失败（源不支持）却没有任何提示 —— 静默做过头了');
  else if (/https?:\/\//.test(r4.text)) bad(`提示里还挂着媒体地址：「${r4.text}」`);
  else if (!/播放失败/.test(r4.text)) bad(`提示文案不对：「${r4.text}」`);
  else ok('真失败照旧提示，且剪掉了消息末尾的媒体地址');

  say('\n[5] 页面控制台报错：');
  // 本脚本会**故意**制造真失败，app 会按设计打一条 `[播放失败] …` 到控制台（含媒体地址，方便排查），
  // 那是预期内的，不算"非预期报错"。
  const real = errors.filter((m) => !/media|video|decode|DEMUXER|pipeline|autoplay|Audio|播放失败/i.test(m));
  if (!real.length) ok('没有非预期的页面报错');
  else { bad('页面有报错：'); real.forEach((m) => say('       ' + m)); }

  say(`\n${fail ? '有 ' + fail + ' 项没过 ❌' : '全部通过 ✅'}`);
  finish(fail ? 1 : 0);
});
