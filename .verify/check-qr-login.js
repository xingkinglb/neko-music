/* 自检：扫码登录里"从响应抠 cookie"那段。
   跑：node .verify/check-qr-login.js        有问题退出码 1

   ---- 为什么要单独立这个 ----
   2026-11-02 真机扫码，界面卡在「登录成功但没拿到 SESSDATA」：
   code=0 明明成功了，但当时只从 data.url 里抠，而官方文档写的是
   「登录成功后会设置 cookie」（Set-Cookie 响应头）。真机上 Set-Cookie 有值、
   data.url 是游戏分站跳转地址，里面不一定带 SESSDATA。

   这段逻辑纯字符串处理，不需要网络也不需要真扫码，正好用假 Response 全覆盖：
     · getSetCookie() 可用 → 走主路
     · getSetCookie() 不可用 → 退回 get('set-cookie')，且**不能被 Expires 里的逗号切错**
     · 只有 data.url → 后备路；值里的 %2C 不许被解码（解码后服务端会从逗号处截断）
     · 没有 SESSDATA → 一律返回空串，宁可报错也不存半截 cookie */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { cookieFromSetCookie, cookieFromUrl } = require(path.join(ROOT, 'src', 'qr-login.js'));

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

const SESS = 'SESSDATA=abc%2C1700000000%2Cxyz***';
/** 造一个假 Response，只为测头解析 */
function fakeRes(list, raw) {
  return {
    headers: {
      getSetCookie: list ? () => list : undefined,
      get: (n) => (n === 'set-cookie' ? (raw || '') : ''),
    },
  };
}

console.log('\n[1] Set-Cookie 是主路：');
{
  const r = cookieFromSetCookie(fakeRes([
    SESS + '; Path=/; Domain=.bilibili.com; Expires=Wed, 21 Oct 2026 10:00:00 GMT; HttpOnly',
    'bili_jct=token123; Path=/',
    'DedeUserID=12345; Path=/',
    'buvid3=AAA; Path=/',
  ]));
  if (!r) err('有多条 Set-Cookie 时没抠出 cookie');
  else if (!r.startsWith('SESSDATA=abc%2C1700000000%2Cxyz***')) err('SESSDATA 不在第一位（拼装顺序错了）：' + r);
  else if (r.includes('buvid3')) err('把 buvid3 也捎上了（只该取登录需要的那几个字段）：' + r);
  else if (!r.includes('bili_jct=token123') || !r.includes('DedeUserID=12345')) err('漏了 bili_jct / DedeUserID：' + r);
  else ok('抠出 SESSDATA + bili_jct + DedeUserID，按固定顺序，没捎带 buvid3');
}

console.log('\n[2] 拿不到 getSetCookie 时的退路（不能被 Expires 的逗号坑到）：');
{
  const raw =
    'SESSDATA=abc%2C1700000000%2Cxyz***; Path=/; Expires=Wed, 21 Oct 2026 10:00:00 GMT; HttpOnly, ' +
    'bili_jct=token123; Path=/; Expires=Wed, 21 Oct 2026 10:00:00 GMT';
  const r = cookieFromSetCookie(fakeRes(null, raw));
  if (!r.includes('SESSDATA=')) err('退路没抠出 SESSDATA');
  else if (!r.includes('bili_jct=token123')) err('退路里 Expires 的逗号把后一条切没了（这正是要防的）');
  else ok('按「逗号 + name=」切分，Expires 里的逗号没被误当分隔符');
}

console.log('\n[3] 没有 SESSDATA 一律判失败：');
{
  const r = cookieFromSetCookie(fakeRes(['buvid3=AAA; Path=/', 'b_nut=170; Path=/']));
  if (r) err('没有 SESSDATA 却返回了内容（会把半截 cookie 存进去当登录）：' + r);
  else ok('没有 SESSDATA → 返回空串');
}

console.log('\n[4] data.url 后备路（值不许被解码）：');
{
  const u = 'https://passport.biligame.com/crossDomain?DedeUserID=12345&SESSDATA=abc%2C1700000000%2Cxyz***&bili_jct=t1&gourl=x';
  const r = cookieFromUrl(u);
  if (!r.startsWith('SESSDATA=abc%2C1700000000%2Cxyz***')) {
    err('url 里的 SESSDATA 被解码或遗漏了（解码后服务端会从逗号处截断）：' + r);
  } else ok('原样保留 %2C，没有走 URLSearchParams 解码');
}
{
  if (cookieFromUrl('') || cookieFromUrl(undefined) || cookieFromUrl('https://x.com/a')) {
    err('空 url / 无 query 的 url 应该返回空串');
  } else ok('空 url / 没有 query 都安全返回空串');
}

console.log(fail ? `\n扫码登录解析自检未通过 ❌（${fail} 处）\n` : '\n扫码登录解析自检全部通过 ✅\n');
process.exit(fail ? 1 : 0);
