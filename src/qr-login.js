/* B 站扫码登录（v2.12.4）
   ============================================================
   为什么要有这个：原来只能手填 SESSDATA —— 得开 F12、翻 Application 面板、
   在几十行 Cookie 里找那一行再复制。大多数人看到这一步就放弃了，
   而"没有 Cookie"意味着字幕、自己的收藏夹、UP 主页都拿不到数据。

   接口（2026-11-02 实测可用，两个都是 GET，不需要登录态）：
     generate → { url, qrcode_key }        url 是 131 字符的登录页地址
     poll     → 外层 code=0 表示"请求成功"，真正状态在内层 data.code：
                86101 未扫码 / 86090 已扫码待确认 / 0 成功 / 86038 已失效
                成功时 data.url 是一串 crossDomain 地址，里面带着 SESSDATA

   ★ 为什么不自己写 QR 编码器：
     纠错分块表和掩码规则差一格，码就"扫不出来"，而自检抓不到这种错
     （要真人拿手机对着屏幕扫才知道）。所以 vendor 了 qrcode-generator
     （MIT / Kazuhiko Arase / 单文件无依赖），见 src/vendor/qrcode.js。
     换来的代价是 56KB 源码，比"写错了没人知道"划算得多。

   ★ qrcode_key 是短期凭证（3 分钟），能换一次登录。
     所以它只活在内存和这一次 IPC 里，绝不写存档、不进日志。
   ============================================================ */

const QR = require('./vendor/qrcode.js');

/* 不带 UA 会被 passport 拒绝；Referer 也不是可选的 —— 少了它偶发返回 -412。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
const API = 'https://passport.bilibili.com/x/passport-login/web/qrcode';

const TIMEOUT_MS = 10000;

/** 把 qrcode 的布尔矩阵转成一条 SVG path。
 *  按行合并连续黑块（M x y h宽 v1 h-宽 z），比"一格一个方块"少 70% 体积。
 *  四周留 4 模块静区：QR 规范要求，少了静区有些扫码器直接认不出。 */
function toPath(qr) {
  const n = qr.getModuleCount();
  const QUIET = 4;
  const parts = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let w = 1;
      while (c + w < n && qr.isDark(r, c + w)) w++;
      parts.push('M' + (c + QUIET) + ' ' + (r + QUIET) + 'h' + w + 'v1h-' + w + 'z');
      c += w;
    }
  }
  return { path: parts.join(''), size: n + QUIET * 2 };
}

/** 从 poll 成功的 url 里抠出 cookie。
 *  B 站给的是 https://passport.biligame.com/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…
 *  只取登录真正需要的几个字段；多带的字段一律不要（少存就少风险）。 */
function cookieFromUrl(u) {
  try {
    const sp = new URL(u).searchParams;
    const keys = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
    const out = [];
    for (const k of keys) {
      const v = sp.get(k);
      if (v) out.push(k + '=' + v);
    }
    // 没有 SESSDATA 就等于没登录 —— 宁可报失败，也别把半截 cookie 存进去
    return /(^|; )SESSDATA=/.test(out.join('; ')) ? out.join('; ') : '';
  } catch {
    return '';
  }
}

/** 生成一张新二维码。返回 { key, url, path, size } —— path 直接塞进 <path d>。 */
async function qrGenerate() {
  const res = await fetch(API + '/generate', {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.data || !j.data.url) {
    throw new Error(j.message || 'B 站没有返回二维码');
  }
  const { url, qrcode_key } = j.data;

  const qr = QR(0, 'M'); // 0 = 自动选版本；M 级纠错，容错约 15%
  qr.addData(url);
  qr.make();
  const { path, size } = toPath(qr);

  return { key: qrcode_key, url, path, size };
}

/** 问一次扫没扫。
 *  state: waiting 未扫 / scanned 已扫待确认 / ok 成功（带 cookie）/ expired 过期 / error
 *  ★ 这里**不做轮询** —— 轮询放渲染层，因为"什么时候该停"只有界面知道
 *    （弹窗被关掉、切了标签页、点了取消）。主进程自己起定时器反而收不住。 */
async function qrPoll(key) {
  if (!key) return { state: 'error', message: '缺少 qrcode_key' };
  const res = await fetch(API + '/poll?qrcode_key=' + encodeURIComponent(key), {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.data) {
    return { state: 'error', message: j.message || 'B 站返回异常' };
  }
  const c = j.data.code;
  if (c === 86101) return { state: 'waiting' };
  if (c === 86090) return { state: 'scanned' };
  if (c === 86038) return { state: 'expired' };
  if (c === 0) {
    const cookie = cookieFromUrl(j.data.url);
    if (!cookie) return { state: 'error', message: '登录成功但没拿到 SESSDATA' };
    return { state: 'ok', cookie };
  }
  return { state: 'error', message: j.data.message || '未知状态 ' + c };
}

module.exports = { qrGenerate, qrPoll, toPath, cookieFromUrl };
