/* 探针：为 v2.14.0 的「音量均衡」回答一个能推翻整个方案的问题 ——
   ★ **这个功能后来撤回了**（真机上把播放搞坏，见 docs/技术说明.md §35）。
     探针留着，因为下面这几个结论是确定的、以后重做还用得上。
   **`audio.volume` 会不会污染 Web Audio 的测量？**

   为什么必须先探：
     音量均衡的做法是「用 analyser 测这首歌的真实响度，再算一个增益补到目标值」。
     如果 analyser 拿到的信号**已经被用户音量滑杆衰减过**，那么：
         用户把音量调到 20% → 测出来"这首歌很轻" → 自动加倍增益
         → 用户调音量等于没调（滑杆像坏了一样），而且会自己越调越响。
     这种情况下就必须先把「用户音量」从 <audio>.volume 搬到 GainNode 上（"音量搬家"）。

   要回答的四件事：
     Q1  同一个信号，volume = 1.0 / 0.5 / 0.2 时 analyser 测到的 RMS 会不会跟着变？
     Q2  volume = 0 / muted = true 时 analyser 还能不能拿到信号？
     Q3  `local://` 和 `bili://` 两个协议行为一不一致？（probe-viz.js 当年只测了 bili://）
     Q4  建图之后声音还在不在（回归：这是最危险的失败模式）

   做法沿用 probe-viz.js：本机起一个 wav 服务（支持 Range），两个自定义协议都代理到它，
   每项测试用**新建的 Audio 元素**（同一个元素只能建一次 source，会抛 InvalidStateError）。

   开发期检查脚本，不参与打包。跑：
     env -u ELECTRON_RUN_AS_NODE npx electron .verify/probe-loudness.js
   结论写 .verify/probe-loudness-report.txt（electron 不自己退出，用 timeout 包一层，看报告为准） */

const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-loudness-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => { fs.appendFileSync(OUT, m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'bili', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
  { scheme: 'local', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
]);

/* ---------- 一段稳定的 wav：440Hz 正弦，幅度 0.5（峰值 -6 dBFS） ---------- */
function makeWav(seconds, amp) {
  const rate = 44100, ch = 1, bits = 16;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = Math.sin(2 * Math.PI * 440 * t) * amp * 32767;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * bits / 8, 28);
  h.writeUInt16LE(ch * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = makeWav(12, 0.5);
let PORT = 0;

/* ---------- 本机 wav 服务（Range 必须支持，否则 <audio> 可能不加载） ---------- */
const server = http.createServer((req, res) => {
  const total = WAV.length;
  const base = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    res.end(WAV.slice(start, end + 1));
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': total });
  res.end(WAV);
});

/* ---------- bili:// 代理（结构照抄 main.js，但不补 ACAO —— 裸奔才真实） ----------
   ★ 必须在 app ready 之后才能 protocol.handle（否则报
     "Session can only be received when app is ready"，第一次就踩了） */
function registerBiliProtocol() {
  protocol.handle('bili', async (request) => {
    const u = new URL(request.url);
    const realUrl = u.searchParams.get('url');
    if (!realUrl) return new Response('缺少 url 参数', { status: 400 });
    return net.fetch(realUrl, { method: request.method || 'GET' });
  });
}

/* ---------- local:// 白名单（用产品里的真实现，不写桩） ---------- */
const { registerLocalProtocol } = require(path.join(ROOT, 'src', 'local-protocol.js'));
const LOCAL_WAV = path.join(__dirname, 'probe-local.wav');

/* ---------- IPC 桩（只要够页面加载起来，别的一律返回空） ---------- */
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
  data: { bvid, aid: 1, title: bvid, cover: '', owner: { mid: 1, name: 'UP' }, duration: 12,
          pages: [{ bvid, cid: 7, page: 1, title: bvid, duration: 12 }], season: null },
}));
ipcMain.handle('bili:audioUrl', () => ({
  ok: true,
  data: { url: 'bili://get?url=' + encodeURIComponent(`http://127.0.0.1:${PORT}/a.wav`), backup: [], quality: 30280, duration: 12 },
}));
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
// 页面启动时会主动要这两样，桩不全就会在报告里刷两条红色 console —— 补上，报告才干净
ipcMain.handle('queue:load', () => ({ ok: true, data: null }));
ipcMain.handle('cache-collect:load', () => ({ ok: true, data: null }));
require('./stub-download-ipc.js')({ tasks: [], dir: null });

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  say('wav 服务起在 127.0.0.1:' + PORT + '（12 秒 / 440Hz / 峰值 -6dBFS）');

  // 两个协议都要在 ready 之后注册
  registerBiliProtocol();
  fs.writeFileSync(LOCAL_WAV, WAV);
  registerLocalProtocol({ getWhitelist: () => new Set([LOCAL_WAV]), coversDir: __dirname });

  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (_e, lv, msg) => {
    const m = String(msg || '');
    if (/probe|audio|Audio|error|Error/i.test(m)) say('  [页面] ' + m.slice(0, 200));
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  /* 页面侧：完整跑一遍"建图 → 测 RMS/峰值"，参数只有 url / volume / muted */
  await evalJS(`window.__probe = async (opts) => {
    const out = { name: opts.name, err: null, loaded: false, played: false,
                  ct: 0, rms: 0, peak: 0, samples: 0, ctxState: '' };
    let a = null, ctx = null, src = null, an = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      a = new Audio();
      a.src = opts.url;
      if (typeof opts.volume === 'number') a.volume = opts.volume;
      if (opts.muted) a.muted = true;
      document.body.appendChild(a);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('loadedmetadata 超时')), 8000);
        a.addEventListener('loadedmetadata', () => { clearTimeout(t); res(); }, { once: true });
        a.addEventListener('error', () => { clearTimeout(t); rej(new Error('媒体错误 ' + (a.error && a.error.code))); }, { once: true });
      });
      out.loaded = true;

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
      out.ctxState = ctx.state;

      src = ctx.createMediaElementSource(a);     // ★ 每个元素只能建一次
      an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      an.connect(ctx.destination);               // ★ 必须连，否则声音消失

      await a.play();
      out.played = true;
      await sleep(1000);                         // 让它稳定播一秒

      // 采 10 次，每次 80ms，取 RMS 中位数（抗单点抖动）+ 峰值最大
      const buf = new Float32Array(an.fftSize);
      const rmsList = [];
      for (let i = 0; i < 10; i++) {
        an.getFloatTimeDomainData(buf);
        let sum = 0, pk = 0;
        for (let j = 0; j < buf.length; j++) {
          const v = buf[j];
          sum += v * v;
          const av = v < 0 ? -v : v;
          if (av > pk) pk = av;
        }
        rmsList.push(Math.sqrt(sum / buf.length));
        if (pk > out.peak) out.peak = pk;
        out.samples++;
        await sleep(80);
      }
      rmsList.sort((x, y) => x - y);
      out.rms = rmsList[Math.floor(rmsList.length / 2)];
      out.ct = +a.currentTime.toFixed(2);
    } catch (e) {
      out.err = (e && e.message) || String(e);
    } finally {
      try { if (a) { a.pause(); a.removeAttribute('src'); a.load(); a.remove(); } } catch (_) {}
      try { if (src) src.disconnect(); } catch (_) {}
      try { if (an) an.disconnect(); } catch (_) {}
      try { if (ctx) await ctx.close(); } catch (_) {}
    }
    return out;
  }; true`);

  const dB = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-∞');
  const run = async (name, url, volume, muted) => {
    const r = await evalJS(`window.__probe(${JSON.stringify({ name, url, volume, muted })})`);
    say(`\n=== ${name} ===`);
    say(`  url=${url.slice(0, 46)}${url.length > 46 ? '…' : ''}  volume=${volume}${muted ? '  muted=true' : ''}`);
    if (r.err) { say('  ★ 异常：' + r.err); return r; }
    say(`  加载=${r.loaded ? '✅' : '✗'} 播放=${r.played ? '✅' : '✗'} (currentTime=${r.ct}) ctx=${r.ctxState}`);
    say(`  RMS=${r.rms.toFixed(5)} (${dB(r.rms)} dBFS)  峰值=${r.peak.toFixed(4)} (${dB(r.peak)} dBFS)  样本=${r.samples}`);
    return r;
  };

  const biliUrl = 'bili://get?url=' + encodeURIComponent(`http://127.0.0.1:${PORT}/a.wav`);
  const localUrl = 'local://get?p=' + encodeURIComponent(LOCAL_WAV);

  say('\n############ A 组：bili:// 协议（Q1 / Q2 / Q4） ############');
  const a100 = await run('A1 volume=1.0', biliUrl, 1.0, false);
  await sleep(250);
  const a050 = await run('A2 volume=0.5', biliUrl, 0.5, false);
  await sleep(250);
  const a020 = await run('A3 volume=0.2', biliUrl, 0.2, false);
  await sleep(250);
  const a000 = await run('A4 volume=0.0', biliUrl, 0.0, false);
  await sleep(250);
  const amut = await run('A5 volume=1.0 + muted', biliUrl, 1.0, true);

  say('\n############ B 组：local:// 协议（Q3） ############');
  const b100 = await run('B1 local volume=1.0', localUrl, 1.0, false);
  await sleep(250);
  const b050 = await run('B2 local volume=0.5', localUrl, 0.5, false);

  /* ---------------- 结论 ---------------- */
  say('\n############ 结论 ############');

  // Q4：建图之后声音还在不在（用 currentTime 在走 + RMS 不为 0 判）
  const soundOk = a100.played && a100.ct > 0 && a100.rms > 0;
  say((soundOk ? '✅ Q4 建图之后声音还在' : '★ Q4 建图之后没声音 / 拿不到数据') +
      `（A1: currentTime=${a100.ct}, RMS=${a100.rms.toFixed(5)}）`);

  // Q1：音量是否影响测量值
  const base = a100.rms;
  const ratio = (x) => (base > 0 ? x / base : 0);
  const r5 = ratio(a050.rms), r2 = ratio(a020.rms);
  say(`\nQ1 volume 对测量值的影响（以 volume=1.0 为基准 1.000）：`);
  say(`   volume=0.5 → 比值 ${r5.toFixed(3)}     volume=0.2 → 比值 ${r2.toFixed(3)}`);

  // 判据：如果比值接近 volume 比例（0.5 / 0.2），就是线性跟随 → 被污染
  const polluted = Math.abs(r5 - 0.5) < 0.12 && Math.abs(r2 - 0.2) < 0.08;
  if (polluted) {
    say('\n★★ 结论：`audio.volume` **会**污染测量（测量值随音量线性缩放）。');
    say('   → 必须走「音量搬家」：元素 volume 恒为 1.0，用户滑杆 / 静音 / 上下键接到 userGain 节点。');
    say('   → 链路：source → analyser → loudGain → userGain → destination');
  } else if (Math.abs(r5 - 1) < 0.08 && Math.abs(r2 - 1) < 0.08) {
    say('\n★★ 结论：`audio.volume` **不会**污染测量（analyser 拿到的是解码后的原始信号）。');
    say('   → 方案最简单：按 §2.3 直接接 gain，用户音量留在 <audio>.volume 上，不用搬家。');
  } else {
    say('\n★★ 结论：**两种情况都不是**（既没完全跟随、也没完全不变）—— 需要人来判断。');
    say('   把上面的比值和波形贴到会话里，别急着动手。');
  }

  // Q2：静音 / 0 音量时还能不能测到
  const silentOk = a000.rms > 0 || amut.rms > 0;
  say(`\nQ2 volume=0 时 RMS=${a000.rms.toFixed(5)} / muted 时 RMS=${amut.rms.toFixed(5)}`);
  say(silentOk
    ? '   → 静音时 analyser 仍能拿到信号（对我们是好事：静音也能继续测响度）'
    : '   → 静音时 analyser 是 0（测量期间要记得"静音照样能测"，否则得暂停测量）');

  // Q3：两个协议是否一致
  if (b100.err) {
    say(`\n★ Q3 local:// 走不通：${b100.err}（本地歌可能不能一起支持，需要单独排查）`);
  } else {
    const same = Math.abs(b100.rms - a100.rms) / (a100.rms || 1) < 0.1;
    say(`\n${same ? '✅' : '★'} Q3 local:// RMS=${b100.rms.toFixed(5)} vs bili:// ${a100.rms.toFixed(5)}` +
        `（含 volume=0.5 时 local 的比值 ${(b050.rms / (b100.rms || 1)).toFixed(3)}）`);
    if (!same) say('   → 两个协议行为不一致，本地歌这条路要单独验证');
  }

  say('\n探针结束');
  // 跑完把临时 wav 删掉（它是探针自己生成的，不该留在仓库里）
  try { fs.unlinkSync(LOCAL_WAV); } catch (_) {}
  setTimeout(() => app.exit(0), 300);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => app.exit(2), 300); });
