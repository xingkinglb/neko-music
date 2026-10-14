/**
 * ============================================================
 *  downloader.js —— 下载引擎（把 B 站的音频存到本地）
 * ============================================================
 *  为什么单独一个文件：和 win-mini.js / bg-protocol.js / store-migrate.js 同一个理由 ——
 *  main.js 没法被测试 require。抽出来才能离线实测：打桩一个 fetchStream，
 *  真跑一遍「断点续传 / 服务器不支持 Range 回 200 / 并发上限 / 暂停保留断点 /
 *  文件名清洗」这些分支，而不是只在代码里找字符串。
 *
 *  ★ 三条设计要点（都是踩过的坑换来的）：
 *
 *  ① **先写 `.part`，下完才 rename**。
 *     直接往正式文件名上写的话，下到一半断电/崩溃，磁盘上就留了一个"看着像完整"
 *     的坏文件 —— 下次打开播到一半卡住，用户根本不知道为什么。rename 是原子的，
 *     所以"正式文件存在"就等于"它是完整的"。
 *
 *  ② **暂停 = 中断但保留 `.part`**，继续时带 `Range` 从断点续。
 *     但服务器可能不理 Range 直接回 200（回整份）—— 这时**必须截断重下**，
 *     不能接着往后追加，否则文件里会有两段重叠的音频，听感是"突然跳回去重唱"。
 *
 *  ③ **并发靠队列控制（默认 2）**。
 *     B 站对短时间的大量请求会限流；一次把几百个请求全放出去，结果是每个都变慢、
 *     甚至集体失败。排队慢慢来反而更快。
 * ============================================================
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
// 封面文件名的生成规则只写在 local-protocol.js 一处 —— 那边校验、这边生成，
// 共用同一个函数才能保证"存下来的名字一定能被读出来"。
const { safeCoverName } = require('./local-protocol.js');

// Windows 文件名里不能出现的字符（外加 C0 控制字符）
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
// Windows 保留设备名。叫 `CON.m4a` 的文件在 Windows 上根本创建不了。
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// 路径总长上限。Windows 默认 260（含盘符和结尾），留点余量避免边界翻车。
const MAX_FULL_PATH = 240;
const NAME_MAX = 80;

/** 把任意字符串洗成能当文件名的样子 */
function sanitizeName(raw, maxLen = NAME_MAX) {
  let s = String(raw == null ? '' : raw).replace(BAD_NAME_CHARS, '_');
  s = s.replace(/\s+/g, ' ').trim();
  // Windows 不允许文件名以点或空格开头/结尾（"a. " 会被系统悄悄改掉，反而更乱）
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = 'audio';
  if (RESERVED_NAMES.test(s)) s = '_' + s;
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[.\s]+$/, '');
  return s || 'audio';
}

/**
 * 给一个任务挑文件名：`作者 - 标题.m4a`，撞名就加 ` (2)`。
 * @param {string} dir      目标目录（用来查磁盘上已有哪些文件）
 * @param {object} task     任务（要有 title / author / bvid）
 * @param {Set}    taken    本批次里其它任务已经占掉的名字（磁盘上还没有，但不能再抢）
 * @param {object} fsx      fs 模块（测试可打桩）
 */
function allocateName(dir, task, taken, fsx = fs) {
  const parts = [task.author, task.title].filter((x) => x && String(x).trim());
  const base = sanitizeName(parts.join(' - ') || task.bvid || 'audio');

  const used = (name) => {
    if (taken && taken.has(name)) return true;
    try { return fsx.existsSync(path.join(dir, name)); } catch (_) { return false; }
  };

  // 先按「目录长度 + 扩展名」把 base 收到不超长，再谈重名 —— 否则截断会把 " (2)" 也切掉
  const room = () => Math.max(8, MAX_FULL_PATH - dir.length - 1 - 4 /* .m4a */);
  let stem = base.length > room() ? sanitizeName(base, room()) : base;

  let name = `${stem}.m4a`;
  let n = 1;
  while (used(name)) {
    n++;
    const suffix = ` (${n})`;
    const cut = Math.max(8, room() - suffix.length);
    const s2 = stem.length > cut ? sanitizeName(stem, cut) : stem;
    name = `${s2}${suffix}.m4a`;
    if (n > 9999) break;   // 保底，别真的死循环
  }
  return name;
}

/** 解析 `Content-Range: bytes 100-499/1000`。解析不了返回 null。 */
function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
}

/** 下载任务的身份键：同一个视频的不同分P要分开算 */
function trackKey(t) {
  return `${t && t.bvid}:${t && t.cid}`;
}

/** 把 fetch 的 body（网页流）转成 Node 流；已经是 Node 流就原样返回（测试打桩用） */
function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return body;
}

function makeError(message, reason) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

/**
 * 造一个下载器。
 *
 * @param {object} cfg
 * @param {(bvid:string, cid:number)=>Promise<{url:string,duration?:number}>} cfg.getAudioUrl
 * @param {(url:string, opts:object)=>Promise<{status:number,headers:{get:Function},body:any}>} cfg.fetchStream
 * @param {()=>string|null} cfg.getDir            当前下载目录（可能中途被改）
 * @param {string} cfg.coversDir                  封面存放目录（在应用数据目录里，不污染用户的音乐文件夹）
 * @param {string} cfg.referer                    B 站要求的 Referer
 * @param {string} cfg.userAgent
 * @param {(key:string)=>boolean} [cfg.isDownloaded] 本地库里是否已有这首歌
 * @param {(list:Array)=>void} [cfg.onProgress]   每 300ms 汇总一次进度（不是每个 chunk 都发）
 * @param {(tasks:Array)=>void} [cfg.onChanged]   任务增删/状态变化
 * @param {(task:object, info:object)=>void} [cfg.onFinish] 下完了（主进程拿它写本地库）
 */
function createDownloader(cfg) {
  const fsx = cfg.fsx || fs;
  const now = cfg.now || (() => Date.now());
  const tasks = [];                    // 持久化用的任务数组
  const runtime = new Map();           // id → { controller, received, total, speed, lastBytes, lastAt, ws }
  let seq = 0;
  let timer = null;

  const concurrent = () => {
    const n = Number(cfg.concurrent);
    return Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : 2;
  };

  /* ---------------- 对外可见的任务视图 ---------------- */

  function publicTask(t) {
    const rt = runtime.get(t.id);
    return Object.assign({}, t, { speed: rt ? rt.speed : 0 });
  }
  function list() { return tasks.map(publicTask); }

  function stats() {
    let done = 0, running = 0, failed = 0, queued = 0, paused = 0, bytes = 0;
    for (const t of tasks) {
      if (t.status === 'done') { done++; bytes += t.received || 0; }
      else if (t.status === 'downloading') { running++; bytes += t.received || 0; }
      else if (t.status === 'failed') failed++;
      else if (t.status === 'paused') { paused++; bytes += t.received || 0; }
      else if (t.status === 'queued') queued++;
    }
    return { done, running, failed, queued, paused, bytes, total: tasks.length };
  }

  /* ---------------- 通知 ---------------- */

  function emitChanged() { if (cfg.onChanged) cfg.onChanged(list()); }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
      const running = tasks.filter((t) => t.status === 'downloading');
      const tick = now();
      for (const t of running) {
        const rt = runtime.get(t.id);
        if (!rt) continue;
        const dt = Math.max(1, tick - rt.lastAt);
        rt.speed = Math.round(((rt.received - rt.lastBytes) * 1000) / dt);
        rt.lastBytes = rt.received;
        rt.lastAt = tick;
      }
      if (cfg.onProgress) cfg.onProgress(running.map(publicTask));
      if (!running.length) { clearInterval(timer); timer = null; }
    }, 300);
    if (timer.unref) timer.unref();   // 别因为这个定时器把进程吊住
  }

  /* ---------------- 队列 ---------------- */

  function pump() {
    let running = tasks.filter((t) => t.status === 'downloading').length;
    while (running < concurrent()) {
      const next = tasks.find((t) => t.status === 'queued');
      if (!next) break;
      running++;
      runTask(next);   // 故意不 await：它自己跑完会再调一次 pump
    }
    if (!running) emitChanged();
  }

  /* ---------------- 单个任务 ---------------- */

  async function runTask(task) {
    task.status = 'downloading';
    task.error = '';
    const rt = { controller: new AbortController(), received: task.received || 0, total: task.total || 0, speed: 0, lastBytes: 0, lastAt: now(), ws: null, nodeStream: null };
    runtime.set(task.id, rt);
    ensureTimer();
    emitChanged();

    let partPath = '';
    try {
      const dir = cfg.getDir();
      if (!dir) throw makeError('还没选下载目录', 'no-dir');

      // 目录可能在下载途中被删了/移动盘拔了 —— 早报错，别等到写文件才炸
      try {
        if (!fsx.existsSync(dir)) throw makeError('下载目录不存在了，请在设置里重新选择', 'no-dir');
      } catch (e) { if (e.reason) throw e; throw makeError('下载目录读不到，请在设置里重新选择', 'no-dir'); }

      const info = await cfg.getAudioUrl(task.bvid, task.cid);
      const url = info && info.url;
      if (!url) throw makeError('这个视频没有可用的音频流', 'no-stream');
      if (info.duration) task.duration = info.duration;

      // 文件名定下来就不再变（续传时还用同一个，否则会算出两个不同的名字）
      if (!task.file) task.file = allocateName(dir, task, takenNames(task));
      const finalPath = path.join(dir, task.file);
      partPath = finalPath + '.part';

      // 正式文件已经在、也没有 .part → 上一次其实下完了（比如崩在 rename 之后）
      if (fsx.existsSync(finalPath) && !fsx.existsSync(partPath)) {
        const size = safeSize(fsx, finalPath);
        task.received = size; task.total = size; task.status = 'done';
        task.finishedAt = now();
        runtime.delete(task.id);
        if (cfg.onFinish) cfg.onFinish(publicTask(task), { file: task.file, size, coverFile: task.coverFile || '', duration: task.duration || 0 });
        emitChanged(); pump();
        return;
      }

      // 断点：.part 有多大就从哪儿接着下
      const start = fsx.existsSync(partPath) ? safeSize(fsx, partPath) : 0;
      rt.received = start;

      const headers = { Referer: cfg.referer, 'User-Agent': cfg.userAgent };
      if (start > 0) headers.Range = `bytes=${start}-`;

      const res = await cfg.fetchStream(url, { headers, signal: rt.controller.signal });
      if (!res) throw makeError('没有拿到响应', 'empty');
      if (res.status && res.status >= 400) throw makeError(`服务器返回 ${res.status}`, 'http');

      let mode = 'w';
      if (start > 0) {
        if (res.status === 206) {
          mode = 'a';   // 服务器认了 Range，接着往后写
        } else {
          // ★ 服务器没理 Range，回了整份 → 必须从头写，否则文件里会有两段重叠音频
          mode = 'w'; rt.received = 0;
        }
      }

      const cr = parseContentRange(res.headers && res.headers.get ? res.headers.get('content-range') : '');
      const len = res.headers && res.headers.get ? Number(res.headers.get('content-length')) || 0 : 0;
      task.total = cr && cr.total ? cr.total : (len + (mode === 'a' ? start : 0));
      rt.total = task.total;
      task.received = mode === 'a' ? start : 0;

      const nodeStream = toNodeStream(res.body);
      if (!nodeStream) throw makeError('响应没有内容', 'empty');

      const ws = fsx.createWriteStream(partPath, { flags: mode });
      rt.ws = ws;
      rt.nodeStream = nodeStream;
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        ws.on('error', (e) => done(reject, e));
        ws.on('finish', () => done(resolve));
        // ★ destroy() 之后不会再有 finish，只会 close —— 不接住它这个 Promise 就永远不 settle，
        //   任务会卡在 downloading 状态，界面上表现为"暂停了但一直转圈"。
        ws.on('close', () => done(reject, makeError('已暂停', 'aborted')));
        nodeStream.on('error', (e) => done(reject, e));
        nodeStream.on('data', (chunk) => {
          rt.received += chunk.length;
          task.received = rt.received;
        });
        nodeStream.pipe(ws);
      });

      if (rt.controller.signal.aborted) throw makeError('已暂停', 'aborted');

      // ★ 长度校验必须在 rename **之前** —— 反过来的话（先改名再发现长度不对）会在磁盘上
      //   留下一个"看着完整、其实播到一半就断"的正式文件，那正是本文件开头第①条要防的事。
      const partSize = safeSize(fsx, partPath);
      if (task.total && partSize !== task.total) {
        throw makeError(`下载不完整（${partSize}/${task.total} 字节）`, 'incomplete');
      }

      // 下完了：原子改名。这一步之后"正式文件存在"就等于"它是完整的"。
      fsx.renameSync(partPath, finalPath);
      const size = safeSize(fsx, finalPath);
      task.received = size;
      task.total = size;

      // 封面：失败不算任务失败（有没有封面不影响歌能不能听）
      let coverFile = task.coverFile || '';
      if (cfg.saveCover !== false && task.cover && !coverFile) {
        coverFile = await fetchCover(task, cfg);
        task.coverFile = coverFile;
      }

      task.status = 'done';
      task.finishedAt = now();
      runtime.delete(task.id);
      if (cfg.onFinish) cfg.onFinish(publicTask(task), { file: task.file, size, coverFile: coverFile || '', duration: task.duration || 0 });
      emitChanged();
      pump();
    } catch (err) {
      const aborted = (runtime.get(task.id) && runtime.get(task.id).controller.signal.aborted) || err.reason === 'aborted';
      runtime.delete(task.id);
      if (aborted) {
        // 暂停：**保留 .part**，下次从这里接着下
        task.status = 'paused';
        task.error = '';
      } else {
        task.status = 'failed';
        task.error = err.message || String(err);
        task.reason = err.reason || 'unknown';
      }
      emitChanged();
      pump();
    }
  }

  function safeSize(fsx, p) {
    try { return fsx.statSync(p).size; } catch (_) { return 0; }
  }

  /** 本批次里其它任务已经占掉的文件名（磁盘上还没有，但也不能再抢） */
  function takenNames(except) {
    const s = new Set();
    for (const t of tasks) if (t !== except && t.file) s.add(t.file);
    return s;
  }

  async function fetchCover(task, cfg) {
    const fileName = safeCoverName(task.key || trackKey(task));
    const dest = path.join(cfg.coversDir, fileName);
    try {
      if (!fsx.existsSync(cfg.coversDir)) fsx.mkdirSync(cfg.coversDir, { recursive: true });
      const res = await cfg.fetchStream(task.cover, {
        headers: { Referer: cfg.referer, 'User-Agent': cfg.userAgent },
      });
      if (!res || res.status >= 400) return '';
      const nodeStream = toNodeStream(res.body);
      if (!nodeStream) return '';
      await new Promise((resolve, reject) => {
        const ws = fsx.createWriteStream(dest);
        ws.on('error', reject);
        ws.on('finish', resolve);
        nodeStream.on('error', reject);
        nodeStream.pipe(ws);
      });
      return safeSize(fsx, dest) > 0 ? fileName : '';
    } catch (_) {
      return '';   // 封面拿不到就算了，别把整首歌判失败
    }
  }

  /* ---------------- 对外操作 ---------------- */

  /**
   * 加一批下载。返回 { added, skipped, needDir }。
   * needDir=true 表示"还没选过下载目录" —— 界面据此弹选目录框，选完再调一次。
   */
  function add(tracks, opts = {}) {
    const list_ = Array.isArray(tracks) ? tracks : [tracks];
    if (!cfg.getDir()) return { added: 0, skipped: 0, needDir: true, duplicates: 0 };

    let added = 0, skipped = 0, duplicates = 0;
    for (const t of list_) {
      if (!t || !t.bvid || !t.cid) continue;
      const key = trackKey(t);

      // 已经有一条没跑完的同名任务 → 不重复排队
      const pending = tasks.find((x) => x.key === key && x.status !== 'done' && x.status !== 'failed');
      if (pending) { duplicates++; continue; }

      // 本地库里已经有了 → 按设置跳过
      if (cfg.skipExisting !== false && cfg.isDownloaded && cfg.isDownloaded(key)) { skipped++; continue; }
      // 已下完的任务也算"有了"（本地库可能被用户清过，但文件还在）
      const doneTask = tasks.find((x) => x.key === key && x.status === 'done');
      if (cfg.skipExisting !== false && doneTask) { skipped++; continue; }

      const task = {
        id: `dl_${now().toString(36)}${(seq++).toString(36)}`,
        key,
        bvid: t.bvid,
        cid: t.cid,
        page: t.page || 1,
        title: t.title || '',
        author: t.author || '',
        cover: t.cover || '',
        duration: t.duration || 0,
        status: 'queued',
        received: 0,
        total: 0,
        file: '',
        coverFile: '',
        error: '',
        createdAt: now(),
        finishedAt: 0,
      };
      tasks.push(task);
      added++;
    }
    if (added) { emitChanged(); pump(); }
    return { added, skipped, needDir: false, duplicates };
  }

  function find(id) { return tasks.find((t) => t.id === id); }

  /**
   * 真正把一条正在跑的任务掐停。
   *
   * ★ 只调 `controller.abort()` 是**不够的**：那个信号只作用于"还没拿到响应"的阶段。
   *   一旦响应体已经在流式写盘了，abort 对它没有任何影响 —— 后台会一直写到整首下完，
   *   而界面上却显示"已暂停"。实测就是这么翻的车（.part 涨到了完整大小）。
   *   所以这里必须把读（网络流）和写（文件流）两头都 destroy 掉。
   */
  function abortRuntime(rt) {
    if (!rt) return;
    try { rt.controller.abort(); } catch (_) {}
    try { if (rt.nodeStream && rt.nodeStream.destroy) rt.nodeStream.destroy(); } catch (_) {}
    try { if (rt.ws && rt.ws.destroy) rt.ws.destroy(); } catch (_) {}
  }

  /** 暂停：中断但保留 .part */
  function pause(id) {
    const t = find(id); if (!t) return false;
    const rt = runtime.get(t.id);
    if (rt) abortRuntime(rt);
    else if (t.status === 'queued') { t.status = 'paused'; emitChanged(); }
    return true;
  }

  /** 继续 / 重试：都是重新排队，区别只在清不清 error */
  function requeue(id, clearError) {
    const t = find(id); if (!t) return false;
    if (t.status === 'downloading') return false;
    if (clearError) { t.error = ''; t.reason = ''; }
    t.status = 'queued';
    emitChanged();
    pump();
    return true;
  }
  const resume = (id) => requeue(id, false);
  const retry = (id) => requeue(id, true);

  /** 取消：中断 + 删掉 .part + 移除任务（不留痕迹，跟"删除"不是一回事） */
  function cancel(id) {
    const t = find(id); if (!t) return false;
    const rt = runtime.get(t.id);
    if (rt) abortRuntime(rt);
    const dir = cfg.getDir();
    if (dir && t.file) {
      try { const p = path.join(dir, t.file + '.part'); if (fsx.existsSync(p)) fsx.unlinkSync(p); } catch (_) {}
    }
    const i = tasks.indexOf(t);
    if (i >= 0) tasks.splice(i, 1);
    runtime.delete(id);
    emitChanged();
    pump();
    return true;
  }

  /**
   * 删除任务记录。deleteFile=true 才动磁盘上的文件。
   * ★ 默认不删文件 —— 误删一首下载好的歌，比在列表里多留一条记录难受得多。
   */
  function remove(id, deleteFile) {
    const t = find(id); if (!t) return false;
    const rt = runtime.get(t.id);
    if (rt) abortRuntime(rt);
    if (deleteFile) {
      const dir = cfg.getDir();
      if (dir && t.file) {
        for (const p of [path.join(dir, t.file), path.join(dir, t.file + '.part')]) {
          try { if (fsx.existsSync(p)) fsx.unlinkSync(p); } catch (_) {}
        }
      }
    }
    const i = tasks.indexOf(t);
    if (i >= 0) tasks.splice(i, 1);
    runtime.delete(id);
    emitChanged();
    pump();
    return true;
  }

  /** 清掉所有「已完成」的记录（不动文件，也不动本地库） */
  function clearFinished() {
    let removed = 0;
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].status === 'done') { tasks.splice(i, 1); removed++; }
    }
    if (removed) emitChanged();
    return { removed };
  }

  /** 接管已存盘的任务：上次没下完的一律先标成"已暂停"，等用户点继续 */
  function adopt(saved) {
    if (!Array.isArray(saved)) return;
    tasks.length = 0;
    for (const t of saved) {
      if (!t || !t.id) continue;
      const copy = Object.assign({}, t);
      if (copy.status === 'downloading') copy.status = 'paused';
      if (copy.status === 'queued') copy.status = 'paused';   // 重启后不自动开跑，避免一开机就一堆请求
      copy.speed = 0;
      tasks.push(copy);
    }
    emitChanged();
  }

  /** 退出前调用：把所有进行中的任务落成「已暂停」，下次打开能接着下 */
  function stopAll() {
    for (const t of tasks) {
      const rt = runtime.get(t.id);
      if (rt) abortRuntime(rt);
      if (t.status === 'downloading' || t.status === 'queued') t.status = 'paused';
    }
    if (timer) { clearInterval(timer); timer = null; }
    return list();
  }

  return {
    add, pause, resume, retry, cancel, remove, clearFinished,
    adopt, stopAll, list, stats,
    setConcurrent(n) { cfg.concurrent = n; pump(); },
    hasRunning: () => tasks.some((t) => t.status === 'downloading'),
  };
}

module.exports = {
  createDownloader,
  sanitizeName,
  allocateName,
  parseContentRange,
  trackKey,
  toNodeStream,
  MAX_FULL_PATH,
  NAME_MAX,
};
