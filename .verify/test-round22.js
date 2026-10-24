/* v2.8.2 实测：「播完一首 → 自动切下一首」这一下偶尔**彻底停住**（Neo 反馈）。

   探针（probe-transition / probe-hang）抓到的两条事实：
     ① 切歌链路本身是通的（真实音源 3/3 成功）；
     ② 但 bili:// 背后的请求一旦"连上了却不回数据"，net.fetch 会**永远挂着** ——
        媒体元素停在 readyState=0，既不 error 也不 ended，界面 `await audio.play()`
        永远 pending：不弹提示、不跳歌、不记历史，40 秒都不动一下。

   这一版补了四道闸门（对应下面四组断言）：
     A. 还没真的播起来时的那次 waiting 不重载（否则每首歌白打一次 playurl，多一次挂住的机会）
     B. 刚拖过进度之后的重新缓冲不重载（同上）
     C. 已经播到结尾的 waiting 是"该切歌了"，直接切（重载会把本该来的 ended 吃掉）
     D. 设了地址 12 秒还不出声 → 重试一次 → 还不行就跳下一首并提示（不许静默停死）

   ★ 用本机 HTTP 服务当音源（真实 WAV + Range），不依赖 B 站网络；
     只有"挂住"那一组故意指向一个"连上就不回数据"的黑洞端点。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round22-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => { fs.appendFileSync(REPORT, m + '\n'); process.stdout.write(m + '\n'); };
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ---------- 音源：一段 8 秒 WAV + 一个"连上不回数据"的黑洞 ---------- */
function makeWav(seconds) {
  const rate = 44100, ch = 1, bits = 16;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * bits / 8, 28);
  h.writeUInt16LE(ch * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = makeWav(8);
let hangHits = 0;

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  if (u.startsWith('/hang')) { hangHits++; return; }   // 连上就吊着，一个字节都不回
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

protocol.registerSchemesAsPrivileged([
  { scheme: 'bili', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
]);

/* ★ 与 src/main.js 的 registerBiliProtocol 保持一致（含 v2.8.2 的首字节超时）。
   这里不能 require main.js，所以照抄一份；两边不一致时这一组会先响。 */
const BILI_FIRST_BYTE_TIMEOUT = 12000;
function registerBiliProtocol() {
  protocol.handle('bili', async (request) => {
    let ac = null, timer = null;
    try {
      const u = new URL(request.url);
      const realUrl = u.searchParams.get('url');
      if (!realUrl) return new Response('缺少 url 参数', { status: 400 });
      const headers = {};
      request.headers.forEach((v, k) => { if (k !== 'host' && k !== 'origin') headers[k] = v; });
      ac = new AbortController();
      if (request.signal) request.signal.addEventListener('abort', () => ac.abort(), { once: true });
      timer = setTimeout(() => { try { ac.abort(new Error('首字节超时')); } catch (_) {} }, BILI_FIRST_BYTE_TIMEOUT);
      const res = await net.fetch(realUrl, { method: request.method || 'GET', headers, redirect: 'follow', signal: ac.signal });
      if (timer) { clearTimeout(timer); timer = null; }
      return res;
    } catch (err) {
      if (timer) { clearTimeout(timer); timer = null; }
      return new Response(String(err && err.message), { status: 504 });
    }
  });
}

/* ---------- 主进程桩 ---------- */
let PORT = 0;
const urlCalls = {};   // bvid → 取了几次地址
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: bvid, cover: '', owner: { mid: 1, name: '测试UP' }, duration: 8,
          pages: [{ bvid, cid: 7, page: 1, title: bvid, duration: 8 }], season: null },
}));
ipcMain.handle('bili:audioUrl', (_e, bvid) => {
  urlCalls[bvid] = (urlCalls[bvid] || 0) + 1;
  const real = bvid === 'BVHANG'
    ? `http://127.0.0.1:${PORT}/hang/audio.m4s`
    : `http://127.0.0.1:${PORT}/ok.wav`;
  return { ok: true, data: { url: 'bili://get?url=' + encodeURIComponent(real), quality: 30280, duration: 8, backup: [] } };
});
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  registerBiliProtocol();

  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2) errors.push('[页面] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  const st = () => evalJS(`(() => { const a = document.getElementById('audio');
    return { seq: playSeq, qi: queue.index, paused: a.paused, ct: +a.currentTime.toFixed(2),
             rs: a.readyState, dur: Number.isFinite(a.duration) ? +a.duration.toFixed(2) : String(a.duration),
             toast: (document.getElementById('toast') || {}).textContent }; })()`);

  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJS(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
      await sleep(150);
    }
    return false;
  };

  const TRACKS = [
    { bvid: 'BV1', cid: 7, page: 1, title: '第一首（8 秒）', author: 'UP', duration: 8, cover: '', mid: 1 },
    { bvid: 'BV2', cid: 7, page: 1, title: '第二首（8 秒）', author: 'UP', duration: 8, cover: '', mid: 1 },
    { bvid: 'BVHANG', cid: 7, page: 1, title: '第三首（地址挂住）', author: 'UP', duration: 8, cover: '', mid: 1 },
  ];
  await evalJS(`window.__tracks = ${JSON.stringify(TRACKS)}; true`);

  say('--- A. 还没真的播起来时的那次 waiting 不许重载 ---');
  await evalJS(`playTracks(window.__tracks, 0, 'round22'); true`);
  const started = await waitFor(`!document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.2`, 8000);
  if (started) ok('第一首开播了'); else bad('第一首 8 秒内没开播（环境问题，后面几组会连带失败）');
  await sleep(600);
  const callsA0 = urlCalls.BV1 || 0;
  // 复刻"开播时那次正常缓冲"：currentTime 还是 0 时来一发 waiting
  await evalJS(`(() => { const a = document.getElementById('audio');
    const keep = a.currentTime; a.currentTime = 0;
    a.dispatchEvent(new Event('waiting'));
    a.currentTime = keep; return true; })()`);
  await sleep(500);
  if ((urlCalls.BV1 || 0) === callsA0) ok('开播缓冲的 waiting 没有触发重载（地址只取了 ' + callsA0 + ' 次）');
  else bad('开播缓冲的 waiting 又触发了一次重载（地址取了 ' + urlCalls.BV1 + ' 次，应为 ' + callsA0 + '）');

  say('\n--- B. 刚拖过进度之后的重新缓冲不许重载 ---');
  const callsB0 = urlCalls.BV1 || 0;
  await evalJS(`(() => { const a = document.getElementById('audio'); a.currentTime = 3; return true; })()`);
  await sleep(300);
  await evalJS(`(() => { document.getElementById('audio').dispatchEvent(new Event('waiting')); return true; })()`);
  await sleep(500);
  if ((urlCalls.BV1 || 0) === callsB0) ok('拖进度后的 waiting 没有触发重载');
  else bad('拖进度后又重解析了一次地址（' + callsB0 + ' → ' + urlCalls.BV1 + '）—— 每次拖进度都白打一次 playurl');

  say('\n--- C. 播到结尾的 waiting 直接切歌（不许重载吃掉 ended）---');
  const beforeC = await st();
  const callsC0 = urlCalls.BV1 || 0;
  await evalJS(`(() => { const a = document.getElementById('audio');
    a.currentTime = Math.max(0, a.duration - 0.4);
    a.dispatchEvent(new Event('waiting')); return true; })()`);
  const switched = await waitFor(`playSeq > ${beforeC.seq} && !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0.1`, 8000);
  const afterC = await st();
  if (switched) ok('结尾的 waiting 直接切到下一首了（seq ' + beforeC.seq + ' → ' + afterC.seq + '）');
  else bad('结尾的 waiting 之后没有切歌（seq 还是 ' + afterC.seq + '，paused=' + afterC.paused + '）');
  if ((urlCalls.BV1 || 0) === callsC0) ok('切歌时没有为上一首多解析一次地址');
  else bad('切歌边界又为上一首重解析了一次地址（' + callsC0 + ' → ' + urlCalls.BV1 + '）');

  say('\n--- D. 地址挂住：12 秒后必须介入，不许静默停死 ---');
  // 直接跳到第三首（挂住的那首）
  const beforeD = await st();
  await evalJS(`playAt(2); true`);
  say('  已切到挂住的那首，最多等 30 秒看它有没有兜底…');
  const t0 = Date.now();
  let recovered = false;
  while (Date.now() - t0 < 30000) {
    const s = await st();
    // "救活了"的判据：要么真的在播（ct>0.1 且不 paused），要么已经跳到别的歌（seq 变了且不在挂住那首）
    if ((!s.paused && s.ct > 0.1) || (s.seq > beforeD.seq + 1 && s.qi !== 2)) { recovered = true; break; }
    await sleep(400);
  }
  const afterD = await st();
  say('  等了 ' + (Date.now() - t0) + 'ms：seq=' + afterD.seq + ' qi=' + afterD.qi + ' paused=' + afterD.paused +
      ' readyState=' + afterD.rs + ' 提示="' + afterD.toast + '"');
  if (recovered) ok('挂住的流没有让播放器静默停死（自己跳走或重新播起来了）');
  else bad('★ 挂住之后 30 秒仍无任何动作（静默停死 —— 这正是 Neo 反馈的那个 bug）');
  if (/连不上|换下一首|正在重试|加载/.test(afterD.toast)) ok('给了用户提示（"' + afterD.toast + '"）');
  else bad('挂住时没有给用户任何提示（提示条为空）');
  say('  黑洞端点被连了 ' + hangHits + ' 次（>0 说明确实走到"连上不回数据"那条路）');
  if (hangHits > 0) ok('确实命中了"连上不回数据"的黑洞端点');
  else bad('没有命中黑洞端点（这一组没测到东西）');

  say('\n--- E. 页面不能有新报错 ---');
  const real = errors.filter((e) => !/播放失败|DOMException|NotSupportedError|MEDIA_ELEMENT_ERROR|连不上/.test(e));
  if (real.length) { bad('页面有报错：'); real.slice(0, 5).forEach((e) => say('    ' + e)); }
  else ok('页面没有意外报错');

  say('\n' + (fail ? '发现 ' + fail + ' 处问题' : 'v2.8.2 切歌 / 挂住实测全部通过 ✅'));
  finish(fail ? 1 : 0);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
