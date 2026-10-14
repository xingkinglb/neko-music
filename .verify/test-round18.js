/* 第十八轮下载引擎实测（v2.8.0）

   覆盖 src/downloader.js 的全部关键分支：正常下完 / 断点续传 / 服务器忽略 Range
   回 200 时截断重下 / 暂停保留 .part / 并发上限 / 失败重试 / 长度不符不谎报成功 /
   文件名清洗与重名 / add() 的去重与 needDir。

   ★ 判别力：src/downloader.js 是本次新增的文件，改前代码里**根本不存在**，
     所以本脚本在改前代码上必然整体失败（require 就抛）。这就是它存在的意义 ——
     把「先写 .part 再 rename」「忽略 Range 必须截断」「并发不超过上限」这些
     不看代码就想不到的分支钉死。

   独立于真实网络与 Cookie，可重复离线运行。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round18-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const dl = require(path.join(ROOT, 'src', 'downloader.js'));
const { createDownloader, sanitizeName, allocateName, parseContentRange, trackKey } = dl;

/* ---------------- 打桩工具 ---------------- */

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-dl-'));
let caseNo = 0;
function newCase() {
  const d = path.join(ROOT_TMP, 'case' + (++caseNo));
  fs.mkdirSync(d, { recursive: true });
  const covers = path.join(d, 'covers');
  return { dir: d, covers };
}

/** 造一个"看起来像 fetch 响应"的对象。故意不用真的 Response —— 它会对 content-length 动手脚。 */
function mkRes(body, { status = 200, contentRange = null, contentLength = null } = {}) {
  const h = new Map();
  if (contentLength != null) h.set('content-length', String(contentLength));
  if (contentRange) h.set('content-range', contentRange);
  const stream = body && typeof body.getReader === 'function'
    ? body
    : new Response(body == null ? '' : body).body;
  return { status, headers: { get: (k) => h.get(String(k).toLowerCase()) || null }, body: stream };
}

/** 慢速流：一边发一边等，好让测试有机会在中途暂停 */
function slowStream(total, chunk, delayMs) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) { controller.close(); return; }
      const n = Math.min(chunk, total - sent);
      controller.enqueue(new Uint8Array(n).fill(0x41));
      sent += n;
      return new Promise((r) => setTimeout(r, delayMs));
    },
  });
}

/** 把 handler 包成 fetchStream；尊重 signal（暂停要靠它） */
function stubFetch(handler, counters = {}) {
  return (url, opts = {}) => new Promise((resolve, reject) => {
    const signal = opts.signal;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve()
      .then(() => handler(url, opts, counters))
      .then((r) => { if (!settled) { settled = true; resolve(r); } },
            (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const TRACK = { bvid: 'BV1a', cid: 111, page: 1, title: '测试曲', author: '测试歌手', cover: '', duration: 120 };

function mkDownloader(c, extra = {}) {
  return createDownloader(Object.assign({
    getAudioUrl: async () => ({ url: 'https://cdn.example/audio.m4s', duration: 120 }),
    fetchStream: stubFetch(() => mkRes(new Uint8Array(10), { contentLength: 10 })),
    getDir: () => c.dir,
    coversDir: c.covers,
    referer: 'https://www.bilibili.com',
    userAgent: 'neko-test',
    concurrent: 2,
    saveCover: false,
  }, extra));
}

(async () => {
  say('=== 第十八轮：下载引擎实测（v2.8.0）===');
  say('');

  /* ---------- [1] 正常下完 ---------- */
  say('[1] 正常下完：先写 .part，下完才 rename');
  {
    const c = newCase();
    const bytes = new Uint8Array(300).fill(7);
    const d = mkDownloader(c, {
      fetchStream: stubFetch(() => mkRes(bytes, { contentLength: 300 })),
    });
    d.add([TRACK]);
    const done = await waitFor(() => d.list()[0] && d.list()[0].status === 'done');
    const t = d.list()[0];
    if (!done) bad('没能在超时内下完');
    else {
      const finalPath = path.join(c.dir, t.file);
      if (!fs.existsSync(finalPath)) bad('正式文件不存在：' + t.file);
      else if (fs.statSync(finalPath).size !== 300) bad('正式文件大小不对：' + fs.statSync(finalPath).size);
      else ok('正式文件已生成且大小正确（300 字节）');
      if (fs.existsSync(finalPath + '.part')) bad('.part 残留了 —— rename 没做干净');
      else ok('.part 已被 rename 掉，没有残留');
      if (t.received !== 300) bad('received 不对：' + t.received); else ok('received 记录为 300');
    }
  }
  say('');

  /* ---------- [2] 断点续传（服务器回 206） ---------- */
  say('[2] 断点续传：.part 已有 100 字节 → 带 Range 续，服务器回 206');
  {
    const c = newCase();
    const name = sanitizeName(TRACK.author + ' - ' + TRACK.title) + '.m4a';
    fs.writeFileSync(path.join(c.dir, name + '.part'), Buffer.alloc(100, 0x42));
    let seenRange = null;
    const d = mkDownloader(c, {
      fetchStream: stubFetch((url, opts) => {
        seenRange = opts.headers.Range || null;
        return mkRes(new Uint8Array(200).fill(0x43), {
          status: 206, contentLength: 200, contentRange: 'bytes 100-299/300',
        });
      }),
    });
    const t = { id: 'x' };
    d.add([TRACK]);
    // 让任务自己挑到同一个文件名（作者 - 标题）
    await waitFor(() => d.list()[0] && (d.list()[0].status === 'done' || d.list()[0].status === 'failed'));
    const task = d.list()[0];
    if (seenRange !== 'bytes=100-') bad('没有带正确的 Range 头，实际：' + seenRange);
    else ok('带了 Range: bytes=100-');
    if (!task || task.status !== 'done') bad('续传没下完，状态：' + (task && task.status) + ' ' + (task && task.error));
    else {
      const size = fs.statSync(path.join(c.dir, task.file)).size;
      if (size !== 300) bad('续传后大小不对：' + size + '（应该是 100 + 200）');
      else ok('续传后大小正确（100 旧 + 200 新 = 300）');
      const head = fs.readFileSync(path.join(c.dir, task.file));
      if (head[0] !== 0x42 || head[299] !== 0x43) bad('内容拼接不对：首字节应保留旧数据');
      else ok('前 100 字节保留旧数据、后面接新数据（追加写正确）');
    }
  }
  say('');

  /* ---------- [3] 服务器忽略 Range 回 200 → 必须截断重下 ---------- */
  say('[3] 服务器忽略 Range 回 200 → 必须截断重下（不能追加，否则音频重叠）');
  {
    const c = newCase();
    const name = sanitizeName(TRACK.author + ' - ' + TRACK.title) + '.m4a';
    fs.writeFileSync(path.join(c.dir, name + '.part'), Buffer.alloc(100, 0x00));
    const d = mkDownloader(c, {
      fetchStream: stubFetch(() => mkRes(new Uint8Array(300).fill(0x43), { contentLength: 300 })),
    });
    d.add([TRACK]);
    await waitFor(() => d.list()[0] && (d.list()[0].status === 'done' || d.list()[0].status === 'failed'));
    const task = d.list()[0];
    if (!task || task.status !== 'done') bad('没下完：' + (task && task.error));
    else {
      const buf = fs.readFileSync(path.join(c.dir, task.file));
      if (buf.length !== 300) bad('大小不对：' + buf.length + '（若为 400 说明错误地追加了）');
      else ok('大小正确 300（旧的 100 字节被截断，没有变成 400）');
      if (buf[0] === 0x00) bad('首字节还是旧的 0x00 —— 没有截断');
      else ok('首字节是新数据 —— 确实从头重下了');
    }
  }
  say('');

  /* ---------- [4] 暂停保留 .part，继续后从断点接着下 ---------- */
  say('[4] 暂停：保留 .part 且状态为 paused；继续后从断点接着下');
  {
    const c = newCase();
    let calls = 0;
    const d = mkDownloader(c, {
      fetchStream: stubFetch((url, opts) => {
        calls++;
        if (calls === 1) return mkRes(slowStream(400, 40, 12), { contentLength: 400 });
        // 第二次（继续）：带 Range，回剩下的部分
        const m = /bytes=(\d+)-/.exec(opts.headers.Range || '');
        const from = m ? Number(m[1]) : 0;
        return mkRes(new Uint8Array(400 - from).fill(0x43), {
          status: 206, contentLength: 400 - from,
          contentRange: `bytes ${from}-399/400`,
        });
      }),
    });
    d.add([TRACK]);
    await waitFor(() => {
      const t = d.list()[0];
      return t && t.received >= 80;
    }, 4000);
    const id = d.list()[0].id;
    d.pause(id);
    const paused = await waitFor(() => d.list()[0].status === 'paused', 3000);
    const t1 = d.list()[0];
    if (!paused) bad('暂停后状态不是 paused，而是：' + t1.status);
    else ok('暂停后状态为 paused');
    const partPath = path.join(c.dir, t1.file + '.part');
    if (!fs.existsSync(partPath)) bad('暂停后 .part 不见了 —— 断点丢了，下次只能重下');
    else {
      const sz = fs.statSync(partPath).size;
      if (sz <= 0 || sz >= 400) bad('.part 大小不合理：' + sz);
      else ok('暂停后 .part 保留且为部分数据（' + sz + '/400 字节）');
    }
    d.resume(id);
    const done = await waitFor(() => d.list()[0] && d.list()[0].status === 'done', 6000);
    const t2 = d.list()[0];
    if (!done) bad('继续后没能下完：' + (t2 && t2.status) + ' ' + (t2 && t2.error));
    else {
      const size = fs.statSync(path.join(c.dir, t2.file)).size;
      if (size !== 400) bad('继续后大小不对：' + size);
      else ok('继续后下完整（400 字节）');
      if (calls !== 2) bad('fetch 调用次数异常：' + calls);
      else ok('只发起了 2 次请求（首次 + 继续），没有从头重下');
    }
  }
  say('');

  /* ---------- [5] 并发上限 ---------- */
  say('[5] 并发上限：5 个任务 + concurrent=2 → 同时下载数不超过 2');
  {
    const c = newCase();
    let maxSeen = 0;
    const d = mkDownloader(c, {
      concurrent: 2,
      fetchStream: stubFetch(() => mkRes(slowStream(200, 20, 8), { contentLength: 200 })),
    });
    const tracks = [];
    for (let i = 0; i < 5; i++) tracks.push({ bvid: 'BV1c' + i, cid: 200 + i, page: 1, title: '曲' + i, author: 'A', cover: '', duration: 60 });
    d.add(tracks);
    const poll = setInterval(() => {
      const n = d.list().filter((t) => t.status === 'downloading').length;
      if (n > maxSeen) maxSeen = n;
    }, 5);
    const allDone = await waitFor(() => d.list().filter((t) => t.status === 'done').length === 5, 15000);
    clearInterval(poll);
    if (!allDone) bad('没能全部下完：' + JSON.stringify(d.stats()));
    else ok('5 个任务全部下完');
    if (maxSeen > 2) bad('并发超过上限：同时下载 ' + maxSeen + ' 个');
    else ok('同时下载数峰值为 ' + maxSeen + '（未超过 concurrent=2）');
  }
  say('');

  /* ---------- [6] 失败重试 ---------- */
  say('[6] 失败重试：先回 500 → failed；retry 后成功');
  {
    const c = newCase();
    let n = 0;
    const d = mkDownloader(c, {
      fetchStream: stubFetch(() => {
        n++;
        if (n === 1) return mkRes('boom', { status: 500, contentLength: 4 });
        return mkRes(new Uint8Array(120).fill(1), { contentLength: 120 });
      }),
    });
    d.add([TRACK]);
    await waitFor(() => d.list()[0] && d.list()[0].status === 'failed');
    const t1 = d.list()[0];
    if (t1.status !== 'failed') bad('第一次没失败，状态：' + t1.status);
    else ok('第一次失败（status=failed，原因：' + t1.error + '）');
    d.retry(t1.id);
    const done = await waitFor(() => d.list()[0] && d.list()[0].status === 'done', 5000);
    if (!done) bad('重试后仍失败：' + d.list()[0].error);
    else ok('重试后成功');
  }
  say('');

  /* ---------- [7] 长度不符 → 不许谎报成功 ---------- */
  say('[7] 长度不符：声称 300 实际只给了 100 → 必须判失败');
  {
    const c = newCase();
    const d = mkDownloader(c, {
      fetchStream: stubFetch(() => mkRes(new Uint8Array(100).fill(9), { contentLength: 300 })),
    });
    d.add([TRACK]);
    await waitFor(() => {
      const t = d.list()[0];
      return t && (t.status === 'done' || t.status === 'failed');
    });
    const t = d.list()[0];
    if (t.status !== 'failed') bad('长度不符却判成功了 —— 会留下一个播到一半卡住的坏文件');
    else ok('正确判为失败：' + t.error);
    if (fs.existsSync(path.join(c.dir, t.file))) bad('失败却留下了正式文件（应该是 .part）');
    else ok('没有生成正式文件（半成品留在 .part 里，可重试）');
  }
  say('');

  /* ---------- [8] 纯函数：文件名清洗 ---------- */
  say('[8] 文件名清洗与重名处理');
  {
    if (sanitizeName('a/b\\c:d*e?f"g<h>i|j') !== 'a_b_c_d_e_f_g_h_i_j') bad('非法字符没洗掉：' + sanitizeName('a/b\\c:d*e?f"g<h>i|j'));
    else ok('Windows 非法字符全部替换成下划线');
    if (sanitizeName('   ') !== 'audio') bad('空名字没兜底：' + sanitizeName('   '));
    else ok('空名字兜底成 audio');
    if (sanitizeName('..') !== 'audio') bad('纯点没兜底：' + sanitizeName('..'));
    else ok('纯点兜底成 audio');
    if (sanitizeName('CON') !== '_CON') bad('Windows 保留名没处理：' + sanitizeName('CON'));
    else ok('Windows 保留名 CON 加了前缀');
    if (sanitizeName('a. ') !== 'a') bad('首尾点/空格没去掉：' + JSON.stringify(sanitizeName('a. ')));
    else ok('首尾的点与空格被去掉');
    const long = sanitizeName('长'.repeat(300));
    if (long.length > dl.NAME_MAX) bad('超长名字没截断：' + long.length);
    else ok('超长名字截断到 ' + long.length + ' 字符');

    const c = newCase();
    fs.writeFileSync(path.join(c.dir, 'A - B.m4a'), 'x');
    const n2 = allocateName(c.dir, { author: 'A', title: 'B' }, new Set());
    if (n2 !== 'A - B (2).m4a') bad('重名没有加序号：' + n2);
    else ok('磁盘上已存在时自动加 (2)');
    const n3 = allocateName(c.dir, { author: 'A', title: 'B' }, new Set(['A - B (2).m4a']));
    if (n3 !== 'A - B (3).m4a') bad('本批次占用没算进去：' + n3);
    else ok('本批次已占用的名字也会跳过（(3)）');
    // 超长目录 + 超长标题：最终完整路径必须仍在 240 以内
    const deep = path.join(c.dir, 'x'.repeat(150));
    fs.mkdirSync(deep, { recursive: true });
    const n4 = allocateName(deep, { author: '歌手'.repeat(20), title: '标题'.repeat(20) }, new Set());
    if (deep.length + 1 + n4.length > dl.MAX_FULL_PATH) bad('完整路径超长：' + (deep.length + 1 + n4.length));
    else ok('超长目录下完整路径仍控制在 ' + (deep.length + 1 + n4.length) + ' 字符（≤' + dl.MAX_FULL_PATH + '）');
  }
  say('');

  /* ---------- [9] 纯函数：parseContentRange / trackKey ---------- */
  say('[9] 纯函数：Content-Range 解析与任务身份键');
  {
    const r = parseContentRange('bytes 100-499/1000');
    if (!r || r.start !== 100 || r.end !== 499 || r.total !== 1000) bad('解析 206 的 Content-Range 失败：' + JSON.stringify(r));
    else ok('解析 bytes 100-499/1000 正确');
    const r2 = parseContentRange('bytes 0-99/*');
    if (!r2 || r2.total !== 0) bad('通配总长度没处理：' + JSON.stringify(r2));
    else ok('总长度是 * 时按未知（0）处理');
    if (parseContentRange('garbage') !== null) bad('垃圾输入没有返回 null');
    else ok('无法解析时返回 null');
    if (trackKey({ bvid: 'BV1', cid: 9 }) !== 'BV1:9') bad('身份键不对');
    else ok('任务身份键 = bvid:cid（同一视频不同分P会分开算）');
  }
  say('');

  /* ---------- [10] add() 的 needDir / 去重 / skipExisting ---------- */
  say('[10] add()：没选目录要报 needDir；重复排队要去重；库里已有要跳过');
  {
    const c = newCase();
    let noDir = true;
    const d = mkDownloader(c, {
      getDir: () => (noDir ? null : c.dir),
      fetchStream: stubFetch(() => mkRes(new Uint8Array(10), { contentLength: 10 })),
    });
    const r1 = d.add([TRACK]);
    if (!r1.needDir) bad('没选目录却没报 needDir');
    else ok('没选下载目录时返回 needDir=true（界面据此弹选目录框）');
    if (d.list().length !== 0) bad('没选目录却建了任务');
    else ok('没有目录时不建任务（不留幽灵记录）');

    noDir = false;
    d.add([TRACK]);
    const r2 = d.add([TRACK]);
    if (r2.duplicates !== 1) bad('同一首重复排队没被去重：' + JSON.stringify(r2));
    else ok('重复点下载会被去重（duplicates=1）');

    const c2 = newCase();
    const d2 = mkDownloader(c2, {
      isDownloaded: () => true,
      skipExisting: true,
      fetchStream: stubFetch(() => mkRes(new Uint8Array(10), { contentLength: 10 })),
    });
    const r3 = d2.add([TRACK]);
    if (r3.skipped !== 1 || r3.added !== 0) bad('库里已有却没跳过：' + JSON.stringify(r3));
    else ok('本地库里已有的歌会跳过（skipped=1）');
  }
  say('');

  /* ---------- [11] 接管存盘任务 / 退出前落成 paused ---------- */
  say('[11] 重启接管：downloading / queued 一律先落成 paused，等用户点继续');
  {
    const c = newCase();
    const d = mkDownloader(c);
    d.adopt([
      { id: 'a', key: 'BV1:1', status: 'downloading', received: 50, file: 'x.m4a' },
      { id: 'b', key: 'BV1:2', status: 'queued' },
      { id: 'c', key: 'BV1:3', status: 'done', received: 100, file: 'y.m4a' },
    ]);
    const l = d.list();
    if (l[0].status !== 'paused' || l[1].status !== 'paused') bad('重启后没落成 paused：' + l.map((x) => x.status).join(','));
    else ok('downloading / queued 都落成了 paused（开机不会自动发一堆请求）');
    if (l[2].status !== 'done') bad('已完成的被改坏了');
    else ok('已完成的任务保持 done 不变');
    if (l[0].received !== 50) bad('断点字节数丢了');
    else ok('断点字节数保留（50）');

    const stopped = d.stopAll();
    if (stopped.some((t) => t.status === 'downloading')) bad('stopAll 后仍有 downloading');
    else ok('stopAll 后没有进行中的任务（退出前调用）');
  }
  say('');

  /* ---------- 收尾 ---------- */
  try { fs.rmSync(ROOT_TMP, { recursive: true, force: true }); } catch (_) {}

  if (fail) say(`\n下载引擎实测：失败 ${fail} 项 ❌`);
  else say('\n下载引擎实测：全部通过 ✅');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  say('\n脚本异常：' + (err && err.stack || err));
  process.exit(1);
});
