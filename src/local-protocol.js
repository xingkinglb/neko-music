/**
 * ============================================================
 *  local-protocol.js —— 本地歌曲 / 封面的"专用取件窗口"
 * ============================================================
 *  为什么要它：页面（渲染进程）的 CSP 里没有放行 file:，也不该放行 ——
 *  一旦放行，网页里任何一段被注入的代码都能读遍整台电脑的硬盘。
 *  所以造一个 `local://` 协议，只服务**我们认识的那几个文件**。
 *
 *  ★★ 安全边界（这是本文件存在的全部意义，改它之前请先读三遍）★★
 *
 *    `local://get?p=<绝对路径>`   —— 音频文件
 *        放行条件：`path.resolve(p)` 必须**恰好等于**本地歌曲库里某一条的 path。
 *        白名单是个 Set，做的是**精确匹配**，不是"以某个目录开头"。
 *        为什么不能用前缀匹配：`D:\Music\..\..\Windows\System32\config\SAM`
 *        这种写法一 resolve 就跑到别处去了；只要先 resolve 再精确匹配，
 *        `..` 会被先折叠掉，折叠完对不上白名单，自然就 403。
 *
 *    `local://cover?f=<文件名>`   —— 封面图
 *        放行条件：文件名必须是纯 `[\w.\-]+`，且拼出来的绝对路径仍在 coversDir 里。
 *        这一条照抄 bg-protocol.js 的两道闸（文件名白名单 + 路径前缀校验），
 *        因为封面目录是固定的，前缀校验在这里是安全的。
 *
 *  ★ 为什么核心逻辑抽成不依赖 electron 的 `handleLocalRequest`：
 *    `require('electron')` 在普通 node 下会直接抛，那样这段安全代码就只能靠
 *    "跑起整个 Electron"才能测 —— 太重，最后多半就不测了。抽出来之后
 *    `.verify/test-round19.js` 能用纯字符串构造请求、把"白名单外必须 403"
 *    这类断言一条条钉死。
 * ============================================================
 */
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');   // 把 Node 的文件流转成网页能吃的 ReadableStream

/** 扩展名 → MIME。音频靠它让 <audio> 认得，图片靠它让 <img> 认得。 */
const LOCAL_MIME = {
  // ---- 音频 ----
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.m4s': 'audio/mp4', '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.aiff': 'audio/aiff',
  // ---- 图片（封面）----
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 从 URL 里认资源类型：`local://get?...` / `local://cover?...` */
function kindOf(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { return ''; }
  // 自定义 scheme 下 hostname 和 pathname 的落点跟写法有关，两个都看一眼更稳
  const host = (u.hostname || '').toLowerCase();
  if (host === 'get' || host === 'cover') return host;
  const p = (u.pathname || '').replace(/^\/+/, '').toLowerCase();
  if (p === 'get' || p === 'cover') return p;
  return '';
}

/**
 * 封面文件名的**唯一生成规则**。下载端（downloader.js）和校验端（下面那个白名单）
 * 都从这里取，绝不许各写一份 —— 两边一旦写歪，表现是"封面存下来了但永远显示不出来"，
 * 而且不报任何错，排查起来极费劲。
 *
 * 规则：非 `[A-Za-z0-9_.-]` 的字符一律换成下划线，所以结果**保证是纯 ASCII**。
 * 校验端因此可以用严格的 `[\w.\-]+`，不用担心中文被误杀。
 */
function safeCoverName(key) {
  let base = String(key == null ? '' : key).replace(/[^\w.\-]/g, '_');
  if (!base || /^\.+$/.test(base)) base = 'cover';   // 空 / 全是点 → 兜底
  return base + '.jpg';
}

/** 封面文件名的校验规则，与 safeCoverName 一一对应 */
const COVER_NAME_RE = /^[\w.\-]+$/;

/**
 * 把文件按 HTTP 语义回给网页：支持 Range（拖动进度条、边下边播全靠它）。
 * 逻辑与 bg-protocol.js 一致，抽出来是因为这里有两个入口都要用。
 */
function serveFile(file, getHeader, type) {
  const total = fs.statSync(file).size;
  let start = 0;
  let end = total - 1;
  let status = 200;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // 这个协议只服务本应用自己认识的本地文件，放行 CORS 是安全的；
    // 不放行的话页面里用 fetch() 读它会被 CORS 拦掉。
    'Access-Control-Allow-Origin': '*',
  };

  const range = getHeader('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, total - Number(m[2]));   // bytes=-N → 最后 N 个字节
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
      }
      if (!isFinite(start) || start < 0 || start > end || start >= total) {
        return new Response('请求范围不合法', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
  }

  headers['Content-Length'] = String(end - start + 1);
  const nodeStream = fs.createReadStream(file, { start, end });
  return new Response(Readable.toWeb(nodeStream), { status, headers });
}

/**
 * 处理一个 local:// 请求。**不依赖 electron**，可以直接单测。
 *
 * @param {string} rawUrl         完整 URL，如 `local://get?p=D%3A%5CMusic%5Ca.m4a`
 * @param {(k:string)=>string|null} getHeader  取请求头（大小写不敏感由调用方保证）
 * @param {object} opts
 * @param {()=>Set<string>} opts.getWhitelist  本地歌曲库里所有 path（已 resolve 过的绝对路径）
 * @param {string} opts.coversDir              封面目录
 * @returns {Promise<Response>}
 */
async function handleLocalRequest(rawUrl, getHeader, opts) {
  const gh = typeof getHeader === 'function' ? getHeader : () => null;
  const kind = kindOf(rawUrl);
  if (!kind) return new Response('未知的资源类型', { status: 400 });

  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { return new Response('地址不合法', { status: 400 }); }

  /* ---------- ① 音频：白名单精确匹配 ---------- */
  if (kind === 'get') {
    const raw = u.searchParams.get('p');
    if (!raw) return new Response('缺少 p 参数', { status: 400 });

    // ★ 先 resolve（把 `..`、`.`、重复分隔符全部折叠掉），再拿折叠后的结果去比对。
    //   顺序不能反 —— 先比对再 resolve 的话，`D:\库\..\..\秘密.txt` 会以"库里的路径"身份蒙混过关。
    let target;
    try { target = path.resolve(raw); } catch (_) { return new Response('路径不合法', { status: 400 }); }

    const wl = (opts && opts.getWhitelist) ? opts.getWhitelist() : null;
    if (!wl || !wl.size) return new Response('本地歌曲库是空的', { status: 403 });
    if (!wl.has(target)) return new Response('这个文件不在本地歌曲库里', { status: 403 });

    if (!fs.existsSync(target)) return new Response('文件不存在（可能已被移动或删除）', { status: 404 });

    let stat;
    try { stat = fs.statSync(target); } catch (_) { return new Response('文件读不到', { status: 500 }); }
    if (!stat.isFile()) return new Response('不是一个文件', { status: 404 });

    const type = LOCAL_MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    return serveFile(target, gh, type);
  }

  /* ---------- ② 封面：固定目录 + 文件名白名单 ---------- */
  const coversDir = (opts && opts.coversDir) || '';
  if (!coversDir) return new Response('没有配置封面目录', { status: 404 });

  const name = u.searchParams.get('f') || '';
  // 闸门一：文件名必须是纯 ASCII 的字母数字点横线（挡掉 ".."、"\"、斜杠这类穿越写法）。
  //   中文会被这一条拦掉 —— 这是**有意的**：封面名由 safeCoverName 统一生成，保证是 ASCII。
  //   单独把 "." 和 ".." 拎出来报 400，是因为它们能通过正则但语义上根本不是文件名。
  if (name === '.' || name === '..' || !COVER_NAME_RE.test(name)) {
    return new Response('文件名不合法', { status: 400 });
  }

  const file = path.resolve(coversDir, name);
  // 闸门二：拼出来的绝对路径必须还在 coversDir 里面（挡掉符号链接之类的逃逸）
  if (!file.startsWith(path.resolve(coversDir) + path.sep)) {
    return new Response('越界访问被拒绝', { status: 403 });
  }
  if (!fs.existsSync(file)) return new Response('封面不存在', { status: 404 });

  const type = LOCAL_MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
  return serveFile(file, gh, type);
}

/**
 * 注册 local:// 协议（需要在 Electron 里调用）。
 * @param {object} opts 同 handleLocalRequest
 */
function registerLocalProtocol(opts) {
  const { protocol } = require('electron');   // 懒加载：这样上面的纯函数能在普通 node 下被测试
  protocol.handle('local', async (request) => {
    try {
      return await handleLocalRequest(
        request.url,
        (k) => request.headers.get(k),
        opts,
      );
    } catch (err) {
      console.error('[local协议] 读取失败：', err);
      return new Response(String(err), { status: 500 });
    }
  });
}

module.exports = { LOCAL_MIME, kindOf, safeCoverName, COVER_NAME_RE, serveFile, handleLocalRequest, registerLocalProtocol };
