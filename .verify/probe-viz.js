/* 探针：mini 律动条到底能不能拿到**真频谱**。

   要回答的问题（决定 D 项走哪条路）：
     Q1. file:// 页面 + bili:// 资源，直接 createMediaElementSource()，能读到数据吗？
         （业界已知坑：跨源资源会被"污染"，analyser 静默返回全 0，不报错）
     Q2. 给 bili:// 代理补 `Access-Control-Allow-Origin: *`、并让 audio 带
         crossOrigin='anonymous'，能不能救回来？（Webamp 就是这么干的）
     Q3. 补了头但**忘了**设 crossOrigin，会怎样？（用来证明"两个都得做"）
     Q4. 建了图之后，声音还在不在？（最危险的失败模式：律动条有了，声音没了）

   做法：本机起一个 wav 服务（支持 Range），bili:// 代理指向它，
   每项测试用**新建的 Audio 元素**（同一个元素只能建一次 source，会抛 InvalidStateError）。

   开发期检查脚本，不参与打包。
*/
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-viz-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => { fs.appendFileSync(OUT, m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'bili', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } },
]);

/* ---------- 一个 8 秒的 wav（440Hz + 880Hz 混合，保证多个频段都有能量） ---------- */
function makeWav(seconds) {
  const rate = 44100, ch = 1, bits = 16;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = (Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 1500 * t) * 0.3) * 12000;
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
const WAV = makeWav(8);

/* ---------- wav 服务。ACAO 由全局开关控制，用来对比"补头 / 不补头" ---------- */
let sendACAO = false;
const server = http.createServer((req, res) => {
  const total = WAV.length;
  const base = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
  if (sendACAO) base['Access-Control-Allow-Origin'] = '*';
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

/* ---------- bili:// 代理（和 main.js 一样，只是多了个"补 ACAO"开关） ---------- */
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
      const res = await net.fetch(realUrl, { method: request.method || 'GET', headers, redirect: 'follow' });
      if (!ADD_ACAO) return res;
      // ★ 候选实现：透传 body 流，只往响应头里补一条 ACAO
      const h = new Headers(res.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    } catch (err) {
      say('  [bili协议] 代理失败：' + (err && err.message));
      return new Response(String(err), { status: 500 });
    }
  });
}
let ADD_ACAO = false;

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
  data: { bvid, aid: 1, title: bvid, cover: '', owner: { mid: 1, name: 'UP' }, duration: 8,
          pages: [{ bvid, cid: 7, page: 1, title: bvid, duration: 8 }], season: null },
}));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=' + encodeURIComponent(`http://127.0.0.1:${PORT}/a.wav`), backup: [], quality: 30280, duration: 8 } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: null, kind: 'image', sizeMB: 0 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
require('./stub-download-ipc.js')({ tasks: [], dir: null });

let PORT = 0;

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  say('wav 服务起在 127.0.0.1:' + PORT);
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
    if (/viz|audio|Audio|CORS|error|Error/i.test(m)) say('  [页面console] ' + m.slice(0, 240));
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  // 页面侧：跑一次"拿频谱"的完整流程，返回诊断数据
  await evalJS(`window.__vizTest = async (opts) => {
    const out = { name: opts.name, err: null, loaded: false, played: false, ct: 0,
                  max: 0, nonzero: 0, bins: 0, duration: 0 };
    let a = null, ctx = null, src = null;
    try {
      const r = await window.neko.audioUrl('BVX', 7);
      const url = r && r.data && r.data.url;
      if (!url) throw new Error('没拿到音频地址');
      a = new Audio();                       // ★ 每个测试用新元素（source 只能建一次）
      if (opts.crossOrigin) a.crossOrigin = 'anonymous';
      a.src = url;
      document.body.appendChild(a);
      // 等元数据
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('loadedmetadata 超时')), 8000);
        a.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
        a.addEventListener('error', () => { clearTimeout(t); reject(new Error('媒体错误 ' + (a.error && a.error.code))); }, { once: true });
      });
      out.loaded = true;
      out.duration = a.duration;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
      src = ctx.createMediaElementSource(a);
      const an = ctx.createAnalyser();
      an.fftSize = 64;                       // 32 个 bin，画 24 根条够用
      an.smoothingTimeConstant = 0.75;
      src.connect(an);
      an.connect(ctx.destination);            // ★ 必须连，否则声音会消失
      await a.play();
      out.played = true;
      await new Promise((r2) => setTimeout(r2, 1200));   // 让它播一会儿再采样
      const buf = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(buf);
      out.bins = buf.length;
      for (const v of buf) { if (v > out.max) out.max = v; if (v > 0) out.nonzero++; }
      out.ct = +a.currentTime.toFixed(2);
    } catch (e) {
      out.err = (e && e.message) || String(e);
    } finally {
      try { if (a) { a.pause(); a.removeAttribute('src'); a.load(); a.remove(); } } catch (_) {}
      try { if (src) src.disconnect(); } catch (_) {}
      try { if (ctx) await ctx.close(); } catch (_) {}
    }
    return out;
  }; true`);

  const run = async (name, crossOrigin, acao) => {
    ADD_ACAO = acao; sendACAO = acao;
    const r = await evalJS(`window.__vizTest(${JSON.stringify({ name, crossOrigin })})`);
    say('\n=== ' + name + ' ===');
    say('  代理补 ACAO = ' + acao + ' / audio.crossOrigin = ' + (crossOrigin ? "'anonymous'" : '不设'));
    say('  元数据加载 = ' + (r.loaded ? '✅ 成功（时长 ' + r.duration + 's）' : '★ 失败'));
    say('  真的播起来 = ' + (r.played ? '✅ 是（currentTime=' + r.ct + '）' : '★ 否'));
    say('  频谱 bins = ' + r.bins + ' / 最大值 = ' + r.max + ' / 非零 bin = ' + r.nonzero);
    if (r.err) say('  异常：' + r.err);
    say('  判定：' + (!r.loaded ? '★ 连音频都加载不了 —— 这条路不能用'
      : (r.max > 0 ? '✅ 拿到真频谱' : '★ 全是 0 —— 被 CORS 污染，只能走合成律动')));
    return r;
  };

  say('\n############ 测试矩阵 ############');
  const t1 = await run('T1 裸奔：不补头、不设 crossOrigin', false, false);
  await sleep(300);
  const t2 = await run('T2 只补 ACAO，但不设 crossOrigin', false, true);
  await sleep(300);
  const t3 = await run('T3 只设 crossOrigin，但不补 ACAO', true, false);
  await sleep(300);
  const t4 = await run('T4 正解候选：补 ACAO + crossOrigin', true, true);

  say('\n############ 结论 ############');
  if (t4.max > 0 && t4.played) {
    say('✅ 真频谱可行：走「代理补 ACAO + audio.crossOrigin=anonymous」这条路。');
    say('   T1 最大值 ' + t1.max + '（对照：裸奔拿不到数据时确实是静默全 0，不报错）');
  } else if (t4.loaded && t4.max === 0) {
    say('★ 补了头也还是全 0 —— 自定义协议的 CORS 在 Chromium 里没按预期生效。');
    say('   兜底：合成律动（不碰 audio 的音频图，绝不会影响声音）。');
  } else {
    say('★ 设 crossOrigin 后连音频都加载不了 —— 绝不能在生产代码里这么干。');
    say('   兜底：合成律动。');
  }
  say('声音检查：T4 的 currentTime = ' + t4.ct + '（>0 说明建图之后声音仍在正常走）');

  say('\n探针结束');
  setTimeout(() => app.exit(0), 200);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => app.exit(2), 200); });
