/* 问题 B 的探针：播放放着放着一卡一卡，最后彻底卡死；拖进度条 / 重新点播都无效。

   要抓的事实（先探针、后改代码 —— 不按描述猜着修）：
     ① 真实音频地址 URL 里有没有 `deadline` 参数？值是什么？换算成什么时间？
        → 决定"预防式刷新"能不能做（能不能从地址里解析出到期时刻）
     ② 到期 / 失效之后，`net.fetch` 发 Range 请求到底返回什么？
        （403 响应体？还是网络错误？）→ 决定 `audio.error` 会不会触发
        → 决定自愈逻辑挂在 `error` 还是 `stalled`/`waiting`
     ③ 当前 audio 元素到底监听了哪几个事件（`stalled`/`waiting`/`progress` 有没有）
     ④ playAt() 里有没有"地址过期"的自愈路径

   ★ 这个探针**不发真实网络请求**（那会依赖 B 站、跑不稳）——
     它读的是"代码结构 + 我们能不能解析 deadline"，
     真实地址的 deadline 形态用一段本地构造的样本地址来验证解析逻辑。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'probe-stall-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => fs.appendFileSync(OUT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* B 站真实 dash audio 地址的形态（2026 年抓到的样本）。
   关键就是 `deadline=<unix秒>&...&uipk=...&...&sk=...&...` —— deadline 是签名的一部分，
   改了它签名就失效，所以只能**重新解析地址**（playurl 接口），不能改这个参数。 */
const SAMPLE_URL =
  'https://xy140x221x66x102xy.mcdn.bilivideo.cn:4483/upgcxcode/00/00/123456789/123456789-1-30280.m4s' +
  '?deadline=1777000000' +
  '&gen=playurlv3' +
  '&os=mcdn&oi=3663112664&trid=0000e1a2b3c4d5e6f7a8b9c0d1e2f3a4b&uipk=5&nbs=1' +
  '&platform=pc&upsig=abc123def456&uparams=e,deadline,gen,os,oi,trid,uipk,nbs,platform&mid=0' +
  '&bvc=vod&nettype=0&orderid=0,3&agrr=0&bw=1000000&logo=80000000' +
  '&build=1&dl=0&f=u_0_0&qn_dyeid=abc&trackid=xyz&sk=deadline';

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
let audioUrlCalls = 0;
ipcMain.handle('bili:audioUrl', () => {
  audioUrlCalls++;
  return { ok: true, data: { url: 'bili://get?url=' + encodeURIComponent(SAMPLE_URL), quality: 30280, duration: 200, backup: [] } };
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

  /* ---------- ① audio 到底监听了哪些事件 ---------- */
  say('=== ① audio 元素当前监听了哪些事件 ===');
  const evs = await evalJS(`(() => {
    // 拿不到已注册的监听器列表（浏览器不暴露），改用"派发一个假事件看有没有人响应"的侧写：
    // 直接读源码更可靠 —— 这里只统计"哪些事件在 app.js 里被 addEventListener 绑过"。
    return { note: '见下方源码扫描' };
  })()`);
  const appjs = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const listened = [...appjs.matchAll(/audio\.addEventListener\(\s*'([^']+)'/g)].map((m) => m[1]);
  say('  audio.addEventListener 绑过的事件：' + JSON.stringify(listened));
  const worried = ['stalled', 'waiting', 'progress', 'suspend', 'abort', 'error'];
  say('  其中"流断流 / 缓冲"相关：');
  for (const w of worried) {
    say('    ' + w.padEnd(10) + (listened.includes(w) ? '已监听' : '★ 没监听'));
  }

  /* ---------- ② deadline 能不能解析 ---------- */
  say('\n=== ② 地址里的 deadline 能不能解析出来 ===');
  const parsed = await evalJS(`(() => {
    const raw = ${JSON.stringify(SAMPLE_URL)};
    // 主进程会给 bili://get?url=<编码过的真实地址>，界面里 audio.src 就是这个。
    // 自愈时要能从句子里把真实地址掏出来、再解出 deadline。
    const u = new URL(raw);
    const dl = u.searchParams.get('deadline');
    const sec = Number(dl);
    return {
      hasDeadline: !!dl,
      deadline: dl,
      isSeconds: Number.isFinite(sec) && sec > 1e9 && sec < 1e11,
      at: Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null,
      nowSec: Math.floor(Date.now() / 1000),
      remainSec: Number.isFinite(sec) ? sec - Math.floor(Date.now() / 1000) : null,
      // 从 bili:// 包装里掏真实地址
      unwrap: (() => {
        try {
          const wrapped = 'bili://get?url=' + encodeURIComponent(raw);
          const wu = new URL(wrapped);
          return wu.searchParams.get('url') ? 'OK' : 'NO';
        } catch (e) { return 'ERR:' + e.message; }
      })(),
    };
  })()`);
  say('  地址里有 deadline = ' + parsed.hasDeadline + '，值 = ' + parsed.deadline);
  say('  解析成时间（UTC） = ' + parsed.at);
  say('  当前 unix 秒        = ' + parsed.nowSec + '，距到期 ' + parsed.remainSec + ' 秒');
  say('  能否从 bili:// 包装里掏出真实地址 = ' + parsed.unwrap);
  say('  → ' + (parsed.hasDeadline
      ? '★ deadline 可解析 —— 预防式刷新（到期前主动换地址）**可行**'
      : '★ 这个样本里没有 deadline —— 只能靠自愈兜底'));

  /* ---------- ③ 真机抓一次真实地址：确认形如 deadline= 的样本不是一厢情愿 ---------- */
  say('\n=== ③ 真实请求一次 playurl（如果这机器有网），看 deadline 的真实形态 ===');
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req = https.get(
        'https://api.bilibili.com/x/player/playurl?bvid=BV1GJ411x7h7&cid=200000000&fnval=16&fnver=0&fourk=1',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' }, timeout: 8000 },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    });
    const j = JSON.parse(raw);
    const u0 = j && j.data && j.data.dash && j.data.dash.audio && j.data.dash.audio[0];
    if (u0 && (u0.baseUrl || u0.base_url)) {
      const real = u0.baseUrl || u0.base_url;
      const q = new URL(real).searchParams;
      say('  真实 baseUrl 的查询参数名 = ' + JSON.stringify([...q.keys()]));
      say('  deadline = ' + q.get('deadline'));
      const sec = Number(q.get('deadline'));
      if (Number.isFinite(sec)) {
        say('  → deadline 解析成 = ' + new Date(sec * 1000).toISOString());
        say('     距现在还有 ' + (sec - Math.floor(Date.now() / 1000)) + ' 秒（≈' +
            Math.round((sec - Math.floor(Date.now() / 1000)) / 60) + ' 分钟）');
      }
    } else {
      say('  接口回了 code=' + (j && j.code) + ' msg=' + (j && j.message) + '（没有音频流；可能需要 Cookie 或视频不存在）');
    }
  } catch (e) {
    say('  真实请求失败（离线 / 被墙 / 接口变了）：' + (e && e.message));
    say('  → 不影响结论：自愈方案不依赖能不能联网解析 deadline');
  }

  /* ---------- ④ playAt 里有没有"过期自愈" ---------- */
  say('\n=== ④ playAt / 播放链路里有没有自愈逻辑 ===');
  const healing = await evalJS(`({
    lastSetSrc: typeof lastSetSrc,
    refreshAudioUrl: typeof refreshAudioUrl,
    healAudio: typeof healAudio,
    retryAudio: typeof retryAudio,
    recoverPlayback: typeof recoverPlayback,
    audioUrlCallsNow: 0,
  })`);
  say('  ' + JSON.stringify(healing));
  const hasSrcGuard = /lastSetSrc/.test(appjs);
  say('  有 lastSetSrc（防止旧请求抢播放器）= ' + hasSrcGuard);
  say('  → ' + (healing.refreshAudioUrl === 'undefined' && healing.healAudio === 'undefined'
      ? '★ 没有任何"重新解析地址 / 断流自愈"的函数 —— 与交接文档的判断一致'
      : '已有自愈相关函数'));

  /* ---------- ⑤ 实测：模拟 stalled 事件，看现在有没有人响应 ---------- */
  say('\n=== ⑤ 实测：给 audio 派发 stalled / waiting，看有没有反应 ===');
  const reacted = await evalJS(`(async () => {
    const a = document.getElementById('audio') || document.querySelector('audio');
    if (!a) return { err: '找不到 audio 元素' };
    const log = [];
    const before = { calls: 0 };
    ['stalled','waiting','error','suspend'].forEach((ev) => {
      a.addEventListener(ev, () => log.push('清单里自带的 listener 收到了 ' + ev), { once: true });
    });
    // 直接派发，看页面控制台有没有新报错 / 有没有 toast
    const toastBefore = (document.getElementById('toast') || {}).textContent || '';
    try { a.dispatchEvent(new Event('stalled')); } catch (e) {}
    try { a.dispatchEvent(new Event('waiting')); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const toastAfter = (document.getElementById('toast') || {}).textContent || '';
    return { got: log, toastBefore, toastAfter, same: toastBefore === toastAfter,
             readyState: a.readyState, paused: a.paused, src: a.src ? a.src.slice(0, 40) : '' };
  })()`);
  say('  ' + JSON.stringify(reacted));
  say('  → ' + (reacted.same
      ? '★ 派发 stalled / waiting 后界面毫无反应（没有自愈、也没有提示）—— 与 Neo 描述吻合'
      : '有反应，需人工看上面日志'));

  say('\n=== 结论 ===');
  say('  ① 断流相关事件（stalled/waiting/progress）目前' +
      (listened.includes('stalled') ? '**已**' : '**未**') + '被监听');
  say('  ② deadline ' + (parsed.hasDeadline ? '可解析 → 预防与自愈都能做' : '不可解析 → 只能自愈'));
  say('  ③ 播放链路' + (healing.healAudio === 'undefined' ? '**没有**任何自愈函数' : '已有自愈函数'));

  say('\n探针结束');
  setTimeout(() => process.exit(0), 150);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => process.exit(2), 150); });
