/* 探针：**播完一首 → 自动切下一首** 这个阶段偶尔彻底停住（Neo 反馈）。

   要抓的事实（先探针、后改代码）：
     ① 用**真实 B 站音源**跑一条 3 首的队列，每首都 seek 到结尾前 2 秒，
        让它自然走到 ended → next(1) → playAt() 这条路。
     ② 每次切歌都记时间线：ended 有没有到、audioUrl 有没有回来、
        src 有没有换、paused / readyState 是什么、有没有抛异常。
     ③ 关键判别：切歌之后 `audio.play()` 到底 reject 了（有提示）还是**永远 pending**（静默停住）。

   ★ 为什么用真实音源：本地 wav 走 local:// 分支，不经过 bili:// 代理，
     测不出"B 站音频流 + 自定义协议"这条路上的问题。

   开发期检查脚本，不参与打包。跑法：
     env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/probe-transition.js
*/
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-transition-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => { fs.appendFileSync(OUT, m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bili = require(path.join(ROOT, 'src', 'bilibili.js'));

/* bili:// 协议 —— 与 main.js 里那段保持一致（探针必须自己注册，因为 main.js 不能被 require） */
protocol.registerSchemesAsPrivileged([
  { scheme: 'bili', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
]);

function registerBiliProtocol() {
  protocol.handle('bili', async (request) => {
    try {
      const u = new URL(request.url);
      const realUrl = u.searchParams.get('url');
      if (!realUrl) return new Response('缺少 url 参数', { status: 400 });
      const headers = {};
      request.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'host' || key.toLowerCase() === 'origin') return;
        headers[key] = value;
      });
      headers['Referer'] = bili.REFERER;
      headers['User-Agent'] = bili.USER_AGENT;
      return await net.fetch(realUrl, { method: request.method || 'GET', headers, redirect: 'follow' });
    } catch (err) {
      say('  [bili协议] 代理音频失败：' + (err && err.message));
      return new Response(String(err), { status: 500 });
    }
  });
}

/* ---------- IPC 桩：存档在内存、其余走真接口 ---------- */
let memStore = { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} };
// ★ ipcMain.handle 的 fn 第一个参数是 event，必须吃掉它，否则会把 event 当成 bvid 传下去
//   （第一次跑探针就是这么错的：playurl 拿到 cid=undefined → B 站回 -400）
const wrap = (fn) => async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e), reason: e && e.reason }; }
};

let SEARCH_LIST = [];   // 主进程先搜好，界面直接用（避免启动时两次真搜索干扰时序）

ipcMain.handle('store:load', () => ({ ok: true, data: memStore }));
ipcMain.handle('store:save', (_e, d) => { memStore = d; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('cookie:set', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: SEARCH_LIST, numPages: 1 } }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bili:videoInfo', wrap((bvid) => bili.getVideoInfo(bvid)));

let audioUrlCalls = 0;
ipcMain.handle('bili:audioUrl', async (_e, bvid, cid) => {
  audioUrlCalls++;
  const n = audioUrlCalls;
  const t0 = Date.now();
  say(`  [audioUrl#${n}] 请求 bvid=${bvid} cid=${cid}`);
  try {
    const info = await bili.getAudioUrl(bvid, cid);
    say(`  [audioUrl#${n}] 回来 ${Date.now() - t0}ms，quality=${info.quality}`);
    return {
      ok: true,
      data: {
        url: 'bili://get?url=' + encodeURIComponent(info.url),
        backup: (info.backup || []).map((b) => 'bili://get?url=' + encodeURIComponent(b)),
        quality: info.quality,
        duration: info.duration,
      },
    };
  } catch (e) {
    say(`  [audioUrl#${n}] ★失败 ${Date.now() - t0}ms：${e && e.message}`);
    return { ok: false, error: (e && e.message) || String(e), reason: e && e.reason };
  }
});

ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
ipcMain.handle('lyric:open', () => {});
require('./stub-download-ipc.js')({ tasks: [], dir: null });

/* ---------- 跑起来 ---------- */
app.whenReady().then(async () => {
  registerBiliProtocol();

  say('=== 0. 先搜几首真实曲目 ===');
  try {
    const res = await bili.searchVideos("花海", 1);
    SEARCH_LIST = (res.list || []).slice(0, 6);
    say('  搜到 ' + SEARCH_LIST.length + ' 条：');
    for (const v of SEARCH_LIST) say('    ' + v.bvid + '  ' + v.title.slice(0, 30) + '  ' + v.duration + 's');
  } catch (e) {
    say('  搜索失败：' + (e && e.message));
    say('  → 没有真实音源，探针无法继续');
    setTimeout(() => app.exit(3), 100);
    return;
  }
  if (SEARCH_LIST.length < 3) {
    say('  ★ 曲目不足 3 条，无法测连续切歌');
    setTimeout(() => app.exit(3), 100);
    return;
  }

  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  /* 页面里所有 console 都记下来（[播放失败] 就在这儿） */
  win.webContents.on('console-message', (_e, level, message) => {
    const m = String(message || '');
    if (/播放|audio|Audio|error|Error|打断|过期|失败/.test(m)) say('  [页面console] ' + m.slice(0, 300));
  });

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  /* ---------- 装一个"时间线记录器"：所有 audio 事件都进 __trace ---------- */
  await evalJS(`(() => {
    window.__trace = [];
    const a = document.getElementById('audio');
    const evs = ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing',
                 'pause','waiting','stalled','suspend','progress','seeking','seeked','ended','error',
                 'emptied','abort','durationchange','ratechange','timeupdate'];
    evs.forEach((ev) => a.addEventListener(ev, () => {
      // timeupdate 太密，只在"接近结尾"时记
      if (ev === 'timeupdate' && !(a.duration && a.currentTime > a.duration - 3)) return;
      window.__trace.push({
        t: Date.now(), ev,
        ct: +a.currentTime.toFixed(2),
        dur: Number.isFinite(a.duration) ? +a.duration.toFixed(2) : String(a.duration),
        paused: a.paused, rs: a.readyState, ns: a.networkState,
        seq: playSeq, qi: queue.index, qn: queue.tracks.length,
        src: (a.src || '').slice(0, 24),
        err: a.error ? (a.error.code + ':' + a.error.message) : null,
      });
    }));
    // 把每一次 api() 调用（含耗时 / 成功失败）也记上 —— 判"取地址失败"还是"取地址没回来"
    window.__apiCalls = [];
    const origApi = api;
    api = async function (name, ...args) {
      const t0 = Date.now();
      try {
        const r = await origApi(name, ...args);
        window.__apiCalls.push({ t: Date.now(), name, ms: Date.now() - t0, ok: true });
        return r;
      } catch (e) {
        window.__apiCalls.push({ t: Date.now(), name, ms: Date.now() - t0, ok: false, err: (e && e.message) || String(e) });
        throw e;
      }
    };
    // 把 playAt 的进出也记上（包一层，不改行为）
    window.__playCalls = [];    const orig = playAt;
    playAt = async function (i) {
      const rec = { t: Date.now(), at: i, seqBefore: playSeq, done: false, err: null };
      window.__playCalls.push(rec);
      try { const r = await orig(i); rec.done = true; return r; }
      catch (e) { rec.err = (e && (e.name + ': ' + e.message)) || String(e); throw e; }
    };
    window.__ready = true;
    return true;
  })()`);

  /* ---------- 组一条 3 首队列 ---------- */
  const tracks = SEARCH_LIST.slice(0, 3).map((v) => ({
    bvid: v.bvid, cid: null, page: 1,
    title: v.title, author: v.author, duration: v.duration,
    cover: v.cover || '', mid: v.mid || 0,
  }));
  await evalJS(`window.__tracks = ${JSON.stringify(tracks)}; true`);

  say('\n=== 1. 开播第一首（真实音源） ===');
  await evalJS(`playTracks(window.__tracks, 0, '探针队列'); true`);

  /* 等第一首真的出声 */
  const waitState = async (expr, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok = await evalJS(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`);
      if (ok) return { ok: true, ms: Date.now() - t0 };
      await sleep(200);
    }
    say('  ★ 等超时：' + label + '（' + timeoutMs + 'ms）');
    return { ok: false, ms: Date.now() - t0 };
  };

  const dump = async (tag) => {
    const st = await evalJS(`(() => {
      const a = document.getElementById('audio');
      return {
        seq: playSeq, qi: queue.index, qn: queue.tracks.length, mode: playMode,
        paused: a.paused, ct: +a.currentTime.toFixed(2),
        dur: Number.isFinite(a.duration) ? +a.duration.toFixed(2) : String(a.duration),
        rs: a.readyState, ns: a.networkState,
        src: (a.src || '').slice(0, 40),
        err: a.error ? (a.error.code + ':' + a.error.message) : null,
        title: (document.getElementById('npTitle') || {}).textContent,
        toast: (document.getElementById('toast') || {}).textContent,
      };
    })()`);
    say('  [' + tag + '] ' + JSON.stringify(st));
    return st;
  };

  const first = await waitState(`!document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.3`, 25000, '第一首开播');
  say('  第一首开播 = ' + (first.ok ? '成功，用了 ' + first.ms + 'ms' : '★ 失败'));
  await dump('第一首开播后');
  if (!first.ok) {
    const tr = await evalJS('window.__trace.slice(-20)');
    say('  最近事件：' + JSON.stringify(tr, null, 1).slice(0, 3000));
    say('\n★ 第一首就播不出来，先修这个再谈切歌');
    setTimeout(() => app.exit(4), 100);
    return;
  }

  /* ---------- 逐首：seek 到结尾前 2 秒，等它自然 ended → 自动切歌 ---------- */
  for (let round = 0; round < 3; round++) {
    const before = await dump('第 ' + (round + 1) + ' 轮开始');
    say('\n=== 2.' + (round + 1) + ' 第 ' + (round + 1) + ' 首：跳到结尾前 2 秒，等自动切歌 ===');
    const dur = before.dur;
    if (!(typeof dur === 'number' && dur > 3)) {
      say('  ★ 拿不到时长（' + dur + '），跳过本轮');
      break;
    }
    await evalJS(`(() => { const a = document.getElementById('audio'); a.currentTime = Math.max(0, a.duration - 2); return true; })()`);
    say('  已跳到 ' + (dur - 2) + 's，等 ended → 自动下一首…');

    const t0 = Date.now();
    // 判定"切歌成功"：seq 变大 + 新歌真的在播（currentTime 在走）
    const ok = await waitState(
      `(playSeq > ${before.seq} && !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.3)`,
      25000,
      '自动切到下一首'
    );
    const after = await dump('第 ' + (round + 1) + ' 轮结果');
    say('  切歌结果 = ' + (ok.ok ? '✅ 成功（' + (Date.now() - t0) + 'ms）' : '★★ 停了'));
    say('  seq: ' + before.seq + ' → ' + after.seq + '，queue.index: ' + before.qi + ' → ' + after.qi);
    say('  paused=' + after.paused + ' readyState=' + after.rs + ' networkState=' + after.ns + ' ct=' + after.ct);
    if (after.toast) say('  提示条内容：' + after.toast);

    // 把这一轮的事件时间线打出来（只看关键事件）
    const trace = await evalJS(`window.__trace.filter(e => ['ended','error','emptied','waiting','stalled','playing','play','pause','loadstart','loadedmetadata','abort'].includes(e.ev)).slice(-24)`);
    say('  事件时间线（末 24 条）：');
    for (const e of trace) say('    +' + (e.t - t0) + 'ms ' + e.ev.padEnd(15) + ' ct=' + e.ct + ' rs=' + e.rs + ' ns=' + e.ns + ' paused=' + e.paused + ' seq=' + e.seq + ' qi=' + e.qi + ' err=' + e.err);

    const calls = await evalJS('window.__playCalls.slice(-6)');
    say('  playAt 调用记录（末 6 条）：' + JSON.stringify(calls));

    if (!ok.ok) {
      say('\n★★★ 复现了：第 ' + (round + 1) + ' 轮切歌后播放停住');
      say('  当前 audioUrl 调用次数 = ' + audioUrlCalls);
      // 再等 10 秒，看是不是"只是慢"（比如 play() 一直 pending）
      say('  再观察 10 秒，看会不会自己缓过来…');
      await sleep(10000);
      const late = await dump('10 秒后');
      say('  10 秒后 = ' + (late.paused ? '仍然停着' : '竟然自己播了'));
      break;
    }
  }

  say('\n=== 3. 汇总 ===');
  const calls = await evalJS('window.__playCalls');
  say('  playAt 总共调用 ' + calls.length + ' 次，audioUrl 请求 ' + audioUrlCalls + ' 次');
  const bad = calls.filter((c) => c.err);
  say('  抛异常的 playAt：' + (bad.length ? JSON.stringify(bad) : '无'));
  const never = calls.filter((c) => !c.done && !c.err);
  say('  永远没返回的 playAt：' + (never.length ? JSON.stringify(never) : '无'));

  say('\n探针结束');
  setTimeout(() => app.exit(0), 200);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => app.exit(2), 200); });
