/* 第十九轮 local:// 协议白名单实测（v2.8.0）

   这是本次改动里**最需要守住**的一块：local:// 把本地文件暴露给了网页层，
   一旦白名单写漏，任何一段被注入的页面脚本都能读遍整台电脑的硬盘。

   所以本脚本的核心不是"能读"，而是"**读不到不该读的**"：
     · 白名单外一律 403（哪怕文件真的存在、真的可读）
     · `..` 穿越一律 403
     · 白名单为空一律 403
     · 封面只认纯文件名，且不得逃出 coversDir

   ★ 判别力：src/local-protocol.js 是本次新增的文件，改前代码里不存在，
     本脚本在改前代码上必然整体失败（require 就抛）。

   纯 Node 运行，不需要 Electron —— 正因为实现里把核心逻辑抽成了
   不依赖 electron 的 handleLocalRequest，这段安全代码才测得上。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round19-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const { handleLocalRequest, kindOf, LOCAL_MIME, safeCoverName, COVER_NAME_RE } = require(path.join(ROOT, 'src', 'local-protocol.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-local-'));
const LIB = path.join(TMP, 'lib');
const COVERS = path.join(TMP, 'covers');
const OUTSIDE = path.join(TMP, 'outside');
for (const d of [LIB, COVERS, OUTSIDE]) fs.mkdirSync(d, { recursive: true });

// 库里的歌（白名单内）
const SONG = path.join(LIB, '歌.m4a');
fs.writeFileSync(SONG, Buffer.alloc(1000, 0xAB));
// 库外但真实存在、且完全可读的敏感文件（白名单外的头号测试对象）
const SECRET = path.join(OUTSIDE, 'secret.txt');
fs.writeFileSync(SECRET, 'top secret');
// 封面
fs.writeFileSync(path.join(COVERS, 'BV1xx_123.jpg'), Buffer.alloc(50, 0x11));

const WL = new Set([path.resolve(SONG)]);
const OPTS = { getWhitelist: () => WL, coversDir: COVERS };

const req = (url, headers = {}) =>
  handleLocalRequest(url, (k) => headers[String(k).toLowerCase()] || null, OPTS);

const getUrl = (p) => `local://get?p=${encodeURIComponent(p)}`;
const coverUrl = (f) => `local://cover?f=${encodeURIComponent(f)}`;

(async () => {
  say('=== 第十九轮：local:// 协议白名单实测（v2.8.0）===');
  say('');

  /* ---------- [1] 白名单内的歌能读 ---------- */
  say('[1] 白名单内的音频：200 + 正确 MIME + 内容一致');
  {
    const res = await req(getUrl(SONG));
    if (res.status !== 200) bad('状态不是 200，而是 ' + res.status);
    else ok('返回 200');
    const ct = res.headers.get('content-type');
    if (ct !== 'audio/mp4') bad('MIME 不对：' + ct);
    else ok('Content-Type = audio/mp4（.m4a 正确映射）');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== 1000) bad('内容长度不对：' + buf.length);
    else ok('内容长度正确（1000 字节）');
  }
  say('');

  /* ---------- [2] 白名单内支持 Range ---------- */
  say('[2] 白名单内的音频支持 Range（拖动进度条靠它）');
  {
    const res = await req(getUrl(SONG), { range: 'bytes=100-199' });
    if (res.status !== 206) bad('Range 请求没回 206，而是 ' + res.status);
    else ok('返回 206 Partial Content');
    const cr = res.headers.get('content-range');
    if (cr !== 'bytes 100-199/1000') bad('Content-Range 不对：' + cr);
    else ok('Content-Range = bytes 100-199/1000');
    if (res.headers.get('accept-ranges') !== 'bytes') bad('没有 Accept-Ranges: bytes');
    else ok('带上了 Accept-Ranges: bytes');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== 100) bad('分段长度不对：' + buf.length);
    else ok('只回了请求的 100 字节');
  }
  say('');

  /* ---------- [3] ★核心★ 白名单外必须 403 ---------- */
  say('[3] ★核心★ 白名单外的文件：即使真实存在且可读，也必须 403');
  {
    if (!fs.existsSync(SECRET)) bad('测试前置条件失败：库外文件不存在');
    const res = await req(getUrl(SECRET));
    if (res.status !== 403) bad('！！白名单外返回了 ' + res.status + '，这是任意文件读取漏洞');
    else ok('白名单外返回 403（文件存在也读不到）');
    const body = await res.text();
    if (/top secret/.test(body)) bad('！！响应里带出了库外文件的内容');
    else ok('响应体里没有泄漏文件内容');
  }
  say('');

  /* ---------- [4] `..` 穿越 ---------- */
  say('[4] 路径穿越：`..` 折叠后对不上白名单 → 403');
  {
    const cases = [
      [path.join(LIB, '..', 'outside', 'secret.txt'), '用 .. 跳出库目录'],
      [path.join(LIB, '..', '..', 'secret.txt'), '用多级 .. 往上跳'],
      [SONG + '/../../outside/secret.txt', '在合法路径后面接 ..'],
    ];
    let allBlocked = true;
    for (const [p, desc] of cases) {
      const res = await req(getUrl(p));
      if (res.status !== 403) { allBlocked = false; bad(`${desc} → 返回了 ${res.status}，应该是 403`); }
    }
    if (allBlocked) ok('三种 `..` 穿越写法全部 403（先 resolve 再精确匹配，折叠完自然对不上）');

    // 同一个文件，绕一圈的写法应当仍被认出来（证明是"折叠后精确匹配"而不是"拒绝一切带点的路径"）
    const roundabout = path.join(LIB, '.', 'sub', '..', '歌.m4a');
    const res2 = await req(getUrl(roundabout));
    if (res2.status !== 200) bad('同一个文件绕一圈的写法被误拒了：' + res2.status);
    else ok('同一个文件绕一圈的写法（./sub/../）仍能读到 —— 是精确匹配而非粗暴拒绝');
  }
  say('');

  /* ---------- [5] 白名单为空 ---------- */
  say('[5] 本地歌曲库是空的时候：一律 403');
  {
    const res = await handleLocalRequest(getUrl(SONG), () => null, { getWhitelist: () => new Set(), coversDir: COVERS });
    if (res.status !== 403) bad('空白名单返回了 ' + res.status);
    else ok('空白名单返回 403');
    const res2 = await handleLocalRequest(getUrl(SONG), () => null, { coversDir: COVERS });
    if (res2.status !== 403) bad('没有 getWhitelist 时返回了 ' + res2.status);
    else ok('没有白名单提供者时也返回 403（fail-closed）');
  }
  say('');

  /* ---------- [6] 白名单里的路径但文件已不在 ---------- */
  say('[6] 白名单里的路径、但文件已被移走：404（不是 403，也不是 500）');
  {
    const gone = path.join(LIB, '已删除.m4a');
    const wl2 = new Set([...WL, path.resolve(gone)]);
    const res = await handleLocalRequest(getUrl(gone), () => null, { getWhitelist: () => wl2, coversDir: COVERS });
    if (res.status !== 404) bad('返回了 ' + res.status + '，应该是 404');
    else ok('返回 404（界面据此把这首歌标成"失效"）');
  }
  say('');

  /* ---------- [7] 封面：文件名白名单 + 不得逃出目录 ---------- */
  say('[7] 封面：只认纯文件名，且不得逃出 coversDir');
  {
    const good = await req(coverUrl('BV1xx_123.jpg'));
    if (good.status !== 200) bad('合法封面读不到：' + good.status);
    else ok('合法封面返回 200');
    if (good.headers.get('content-type') !== 'image/jpeg') bad('封面 MIME 不对：' + good.headers.get('content-type'));
    else ok('封面 Content-Type = image/jpeg');

    const badName = await req(coverUrl('../secret.txt'));
    if (badName.status !== 400) bad('带 ../ 的封面名返回了 ' + badName.status + '，应该是 400');
    else ok('封面名带 ../ → 400（文件名白名单先拦住）');

    const slash = await req(coverUrl('sub/evil.jpg'));
    if (slash.status !== 400) bad('带斜杠的封面名返回了 ' + slash.status + '，应该是 400');
    else ok('封面名带斜杠 → 400');

    const dotdot = await req('local://cover?f=..');
    if (dotdot.status !== 400) bad('封面名为 .. 返回了 ' + dotdot.status + '，应该是 400');
    else ok('封面名为 .. → 400');

    const missing = await req(coverUrl('missing.jpg'));
    if (missing.status !== 404) bad('不存在的封面返回了 ' + missing.status + '，应该是 404');
    else ok('不存在的封面 → 404');

    // 非 ASCII 文件名被有意拒绝：封面名统一由 safeCoverName() 生成，保证是纯 ASCII。
    // 这一条钉住的是"生成规则与校验规则必须一致"——两边写歪的话，封面会存得下但永远读不出来。
    const cn = await req(coverUrl('中文封面.jpg'));
    if (cn.status !== 400) bad('中文封面名返回了 ' + cn.status + '，应该是 400（有意的 ASCII 约束）');
    else ok('非 ASCII 封面名 → 400（与 safeCoverName 的 ASCII 约束一致）');

    // 绝对路径写法（Windows 盘符）必须被文件名白名单挡住
    const abs = await req(coverUrl('C:\\Windows\\win.ini'));
    if (abs.status !== 400) bad('绝对路径当封面名返回了 ' + abs.status + '，应该是 400');
    else ok('绝对路径当封面名 → 400');
  }
  say('');

  /* ---------- [8] 其它畸形请求 ---------- */
  say('[8] 畸形请求：未知类型 / 缺参数 / 非法 Range');
  {
    const unknown = await req('local://nonsense?x=1');
    if (unknown.status !== 400) bad('未知资源类型返回了 ' + unknown.status);
    else ok('未知资源类型 → 400');

    const noP = await req('local://get');
    if (noP.status !== 400) bad('缺 p 参数返回了 ' + noP.status);
    else ok('缺少 p 参数 → 400');

    const badRange = await req(getUrl(SONG), { range: 'bytes=5000-6000' });
    if (badRange.status !== 416) bad('越界 Range 返回了 ' + badRange.status + '，应该是 416');
    else ok('越界 Range → 416（带 Content-Range: bytes */1000）');
  }
  say('');

  /* ---------- [9] 纯函数 ---------- */
  say('[9] kindOf 能同时认出 hostname 与 pathname 两种写法');
  {
    if (kindOf('local://get?p=x') !== 'get') bad('hostname 写法没认出来');
    else ok('local://get?p=x → get');
    if (kindOf('local://cover?f=x') !== 'cover') bad('cover 没认出来');
    else ok('local://cover?f=x → cover');
    if (kindOf('local:///get?p=x') !== 'get') bad('pathname 写法没认出来：' + kindOf('local:///get?p=x'));
    else ok('local:///get?p=x → get（pathname 写法兜底）');
    if (kindOf('local://nope') !== '') bad('未知类型没返回空');
    else ok('未知类型返回空字符串');
    if (kindOf('::::') !== '') bad('垃圾输入没返回空');
    else ok('垃圾输入返回空字符串');
  }
  say('');

  /* ---------- [10] MIME 覆盖常用格式 ---------- */
  say('[10] 常用音频 / 图片扩展名都有 MIME 映射');
  {
    const want = ['.m4a', '.mp3', '.flac', '.wav', '.ogg', '.opus', '.aac', '.jpg', '.png', '.webp'];
    const miss = want.filter((e) => !LOCAL_MIME[e]);
    if (miss.length) bad('缺少 MIME 映射：' + miss.join(' '));
    else ok('10 种常用扩展名全部有映射');
  }
  say('');

  /* ---------- [11] ★不变式★ 生成规则与校验规则必须永远对得上 ---------- */
  say('[11] ★不变式★ safeCoverName() 生成的任何名字都必须能通过校验');
  {
    const keys = [
      'BV1test0001:39243287210',         // 正常的 bvid:cid（合成样本，仓库里不放真实 bvid）
      'BV1xx:1',
      '中文键:中文',                      // 含中文
      '../../etc/passwd',                 // 穿越写法
      '..',
      '.',
      '',
      null,
      undefined,
      'a\\b/c:d*e?f"g<h>i|j',
      'x'.repeat(300),                    // 超长
      '有空格 的 名字',
    ];
    let badOnes = [];
    for (const k of keys) {
      const name = safeCoverName(k);
      const legal = name !== '.' && name !== '..' && COVER_NAME_RE.test(name);
      if (!legal) badOnes.push(JSON.stringify(k) + ' → ' + JSON.stringify(name));
    }
    if (badOnes.length) bad('生成的名字通不过校验：\n         ' + badOnes.join('\n         '));
    else ok('12 种刁钻键（含中文 / 穿越 / 空 / 超长）生成的名字全部通过校验');
    if (safeCoverName('BV1xx:1') !== 'BV1xx_1.jpg') bad('常规键生成的名字不符合预期：' + safeCoverName('BV1xx:1'));
    else ok('BV1xx:1 → BV1xx_1.jpg（冒号换成下划线）');
  }
  say('');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  if (fail) say(`\nlocal:// 协议实测：失败 ${fail} 项 ❌`);
  else say('\nlocal:// 协议实测：全部通过 ✅');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  say('\n脚本异常：' + (err && err.stack || err));
  process.exit(1);
});
