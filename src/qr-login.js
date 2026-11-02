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

/** 从 poll 成功的**响应头**里抠 cookie。
 *  官方文档原话：「验证登录成功后会进行设置以下 cookie 项：DedeUserID / DedeUserID__ckMd5 /
 *  SESSDATA / bili_jct」—— 也就是走 Set-Cookie 响应头。
 *  ★ 这是 2026-11-02 真机扫码踩出来的：code=0 了，但 data.url 里抠不出 SESSDATA，
 *    界面卡在「登录成功但没拿到 SESSDATA」。当时错在只认 data.url。 */
function cookieFromSetCookie(res) {
  let list = [];
  try {
    if (res && res.headers && typeof res.headers.getSetCookie === 'function') {
      list = res.headers.getSetCookie();   // Node 20 的 undici 提供的，能正确拆多条
    } else {
      const raw = (res && res.headers && res.headers.get('set-cookie')) || '';
      // ★ 不能简单 split(',')：Expires=Wed, 21 Oct 2026 10:00:00 GMT 里也有逗号。
      //   只在「逗号后面紧跟着 name=」时才切。
      list = raw.split(/,(?=\s*[A-Za-z0-9_.#-]+=)/);
    }
  } catch {
    return '';
  }

  const got = new Map();
  for (const line of list) {
    const head = String(line).split(';')[0];   // 去掉 Path / Expires / HttpOnly 那些属性
    const i = head.indexOf('=');
    if (i < 0) continue;
    const k = head.slice(0, i).trim();
    const v = head.slice(i + 1).trim();
    if (v) got.set(k, v);                      // 值保持原样，不解码
  }
  return assembleCookie(got);
}

/** 从 data.url 里抠 cookie（老版本接口会带，留着当后备）。
 *  ★ 不用 URL.searchParams：它会把 %2C 解成逗号，而 SESSDATA 的值里本来就带
 *    **编码过的**逗号，解码后再拼回 Cookie 头，服务端会从逗号处截断 —— 看着有值，其实登录不了。 */
function cookieFromUrl(u) {
  const s = String(u || '');
  const qi = s.indexOf('?');
  if (qi < 0) return '';
  const got = new Map();
  for (const pair of s.slice(qi + 1).split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    got.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return assembleCookie(got);
}

const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/** 只取登录真正需要的几个字段，按固定顺序拼。
 *  没有 SESSDATA 一律当失败 —— 宁可报错，也别把半截 cookie 存进去当"登录了"。 */
function assembleCookie(got) {
  if (!got.has('SESSDATA')) return '';
  return COOKIE_KEYS.filter((k) => got.has(k)).map((k) => k + '=' + got.get(k)).join('; ');
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
    // ★ 两个来源都试。Set-Cookie 是官方文档写的主路（真机上也是这条有值），
    //   data.url 只是"游戏分站跨域登录地址"，新版不一定带 SESSDATA —— 留作后备。
    let cookie = cookieFromSetCookie(res);
    if (!cookie) cookie = cookieFromUrl(j.data && j.data.url);
    if (!cookie) {
      // 失败时把"到底拿到了什么"带出去 —— 只给字段名、不给值，不泄露凭据。
      // 没有这个的话，下次再遇到只能瞎猜（这次就是这么卡住的）。
      const hint = [];
      try {
        const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        hint.push('响应头: ' + (sc.map((x) => String(x).split('=')[0].trim()).filter(Boolean).join(' / ') || '空'));
      } catch {
        hint.push('响应头: 读不出来');
      }
      hint.push('data: ' + Object.keys(j.data || {}).join(' / '));
      return { state: 'error', message: '登录成功但没拿到 SESSDATA（' + hint.join('；') + '）' };
    }
    return { state: 'ok', cookie };
  }
  return { state: 'error', message: j.data.message || '未知状态 ' + c };
}

module.exports = { qrGenerate, qrPoll, toPath, cookieFromUrl, cookieFromSetCookie };
