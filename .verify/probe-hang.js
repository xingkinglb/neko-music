/* 探针：验证「新地址的请求挂住 → 播放永远静默停住」这条路径是否存在。

   背景（probe-transition.js 已经抓到的两个事实）：
     ① 播完一首 → ended → next → playAt 这条路本身是通的（3/3 成功）；
     ② 但**每首歌都会取两次音频地址** —— 开播时的第一个 `waiting` 会触发
        healOnStall → refreshAudioUrl → 换 src 重载。也就是说"自愈"在每首歌开头
        都会跑一次，而它用的是**没有任何超时**的 net.fetch。

   要回答的问题：
     Q1. bili:// 背后的 net.fetch 挂住（连上但一个字节都不回）时，
         `audio.play()` 会不会**永远 pending**（既不 resolve 也不 reject）？
         → 如果会，那就是"完全停止播放、没有提示、没有跳下一首"的直接成因。
     Q2. 这种情况下，界面有没有任何兜底（提示条 / 自动跳歌 / 超时）？
     Q3. 挂住之后再等 30 秒，会不会自己缓过来？

   做法：本机起一个"黑洞"HTTP 服务（accept 之后什么都不写），
   让第二首的地址指向它，然后看切歌时会发生什么。

   开发期检查脚本，不参与打包。
*/
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-hang-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => { fs.appendFileSync(OUT, m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'bili', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
]);

/* ---------- ① 一个能正常播的 wav（5 秒正弦波，纯 Node 拼 WAV 头） ---------- */
function makeWav(seconds) {
  const rate = 44100, ch = 1, bits = 16;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * bits / 8, 28);
  h.writeUInt16LE(ch * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = makeWav(5);

/* ---------- ② 黑洞服务：连上就吊着，一个字节都不回 ---------- */
let hangSockets = 0;
const server = http.createServer((req, res) => {
  const u = req.url || '/';
  if (u.startsWith('/hang')) {
    hangSockets++;
    say('  [黑洞] 收到请求 ' + u.slice(0, 40) + ' —— 故意不回任何数据（挂着）');
    return;   // 什么都不做
  }
  // /ok.wav —— 正常回，支持 Range（媒体元素会带 Range）
  const total = WAV.length;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    res.writeHead(206, {
      'Content-Type': 'audio/wav',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    });
    res.end(WAV.slice(start, end + 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
  res.end(WAV);
});

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
      // ★ 与 main.js 完全一致：没有 signal / 没有超时
      return await net.fetch(realUrl, { method: request.method || 'GET', headers, redirect: 'follow' });
    } catch (err) {
      say('  [bili协议] 代理失败：' + (err && err.message));
      return new Response(String(err), { status: 500 });
    }
  });
}

/* ---------- IPC 桩 ---------- */
let memStore = { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} };
ipcMain.handle('store:load', () => ({ ok: true, data: memStore }));
ipcMain.handle('store:save', (_e, d) => { memStore = d; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [], numPages: 1 } }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: 'x', reason: 'none' }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: bvid, cover: '', owner: { mid: 1, name: 'UP' }, duration: 5,
          pages: [{ bvid, cid: 7, page: 1, title: bvid, duration: 5 }], season: null },
}));

let PORT = 0;
let audioUrlCalls = [];
ipcMain.handle('bili:audioUrl', (_e, bvid) => {
  audioUrlCalls.push({ bvid, t: Date.now() });
  const base = `http://127.0.0.1:${PORT}`;
  const real = bvid === 'BVHANG' ? base + '/hang/audio.m4s' : base + '/ok.wav';
  say(`  [audioUrl#${audioUrlCalls.length}] ${bvid} → ${real}`);
  return { ok: true, data: { url: 'bili://get?url=' + encodeURIComponent(real), backup: [], quality: 30280, duration: 5 } };
});
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
require('./stub-download-ipc.js')({ tasks: [], dir: null });

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  say('黑洞/正常服务起在 127.0.0.1:' + PORT);
  registerBiliProtocol();

  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (_e, lv, msg) => {
    const m = String(msg || '');
    if (/播放|audio|error|Error|失败|打断/.test(m)) say('  [页面console] ' + m.slice(0, 260));
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  await evalJS(`(() => {
    window.__trace = [];
    const a = document.getElementById('audio');
    ['loadstart','loadedmetadata','canplay','play','playing','pause','waiting','stalled','ended','error','emptied','abort']
      .forEach((ev) => a.addEventListener(ev, () => window.__trace.push({
        t: Date.now(), ev, ct: +a.currentTime.toFixed(2),
        paused: a.paused, rs: a.readyState, ns: a.networkState, seq: playSeq,
        err: a.error ? (a.error.code + ':' + a.error.message) : null,
      })));
    window.__ready = true; return true;
  })()`);

  const st = async (tag) => {
    const s = await evalJS(`(() => { const a = document.getElementById('audio');
      return { seq: playSeq, qi: queue.index, paused: a.paused, ct: +a.currentTime.toFixed(2),
               rs: a.readyState, ns: a.networkState, src: (a.src||'').slice(0,32),
               err: a.error ? (a.error.code+':'+a.error.message) : null,
               toast: (document.getElementById('toast')||{}).textContent }; })()`);
    say('  [' + tag + '] ' + JSON.stringify(s));
    return s;
  };

  /* 队列：第一首正常（5 秒 wav），第二首指向黑洞 */
  const tracks = [
    { bvid: 'BVOK', cid: 7, page: 1, title: '正常的一首（5 秒）', author: 'UP', duration: 5, cover: '', mid: 1 },
    { bvid: 'BVHANG', cid: 7, page: 1, title: '地址挂住的一首', author: 'UP', duration: 5, cover: '', mid: 1 },
  ];
  await evalJS(`window.__tracks = ${JSON.stringify(tracks)}; true`);

  say('\n=== Q1/Q2：第一首正常播，跳到结尾前 1 秒 → ended → 自动切到"挂住"的第二首 ===');
  await evalJS(`playTracks(window.__tracks, 0, 'hang-probe'); true`);
  // 等第一首真的在播
  for (let i = 0; i < 60; i++) {
    const ok = await evalJS(`(() => { const a=document.getElementById('audio'); return !a.paused && a.currentTime > 0.2; })()`);
    if (ok) break;
    await sleep(200);
  }
  await st('第一首开播');
  await evalJS(`(() => { const a = document.getElementById('audio'); a.currentTime = Math.max(0, a.duration - 1); return true; })()`);
  say('  已跳到结尾前 1 秒，等它自然 ended → 切第二首…');

  const t0 = Date.now();
  let started = false;
  for (let i = 0; i < 120; i++) {   // 最多等 40 秒
    const s = await evalJS(`(() => { const a=document.getElementById('audio');
      return { seq: playSeq, paused: a.paused, ct: a.currentTime, rs: a.readyState, ns: a.networkState }; })()`);
    if (s.seq >= 2 && !s.paused && s.ct > 0.05) { started = true; break; }
    await sleep(300);
  }
  say('  等了 ' + (Date.now() - t0) + 'ms，第二首开播 = ' + (started ? '✅ 是' : '★★ 否（静默停住）'));
  await st('切歌后');

  const tr = await evalJS(`window.__trace.slice(-14)`);
  say('  事件时间线（末 14 条）：');
  for (const e of tr) say('    +' + (e.t - t0) + 'ms ' + e.ev.padEnd(15) + ' ct=' + e.ct + ' rs=' + e.rs + ' ns=' + e.ns + ' paused=' + e.paused + ' seq=' + e.seq + ' err=' + e.err);

  say('\n=== Q3：再等 30 秒，看有没有任何兜底（提示 / 跳歌 / 自己缓过来） ===');
  await sleep(30000);
  const late = await st('30 秒后');
  say('  提示条 = "' + (late.toast || '') + '"');
  say('  audioUrl 请求次数 = ' + audioUrlCalls.length + '（第一首 1 次 + 第二首 1 次；若更多说明在反复自愈）');
  say('  黑洞连接数 = ' + hangSockets);
  say('  → ' + (!started && late.paused
    ? '★★ 确认：请求挂住时**永远静默停住**，无提示、不跳歌、不自愈'
    : '有兜底，需人工看上面日志'));

  say('\n探针结束');
  setTimeout(() => app.exit(0), 200);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => app.exit(2), 200); });
