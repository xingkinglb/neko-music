/**
 * ============================================================
 *  bg-protocol.js —— 背景文件（图片 / 视频）的"专用取件窗口"
 * ============================================================
 *  为什么不用 file:// ？因为页面的安全策略（CSP）里没有放行 file:，
 *  与其把 CSP 开个大口子，不如造一个只能访问 backgrounds/ 这一个目录的 bg:// 协议。
 *
 *  为什么单独抽成一个文件：这样离线实测（.verify/test-round7.js）能直接把它
 *  注册到测试用的窗口上，然后发一个带 Range 的请求 —— 真正跑一遍"视频边读边传"
 *  这条路，而不是只在代码里找字符串。
 * ============================================================
 */
const path = require('path');
const fs = require('fs');
const { protocol } = require('electron');
const { Readable } = require('stream');   // 把 Node 的文件流转成网页能吃的 ReadableStream

const BG_MIME = {
  // 图片
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  // 视频（视频背景）：这三种容器 Chromium 内核能稳解
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

// 视频大小上限：太大的视频一次性读进内存会卡，超过就不让选（给个提示）
const BG_VIDEO_MAX_MB = 200;

/** 清空背景目录（换背景时调用，避免旧文件越堆越多） */
function clearBgDir(bgDir) {
  try {
    if (!fs.existsSync(bgDir)) return;
    for (const f of fs.readdirSync(bgDir)) {
      const p = path.join(bgDir, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('[bg] 清空背景目录失败：', err.message);
  }
}

/**
 * 注册 bg:// 协议：只允许读取 bgDir 目录里的文件。两道安全闸缺一不可：
 *   ① 文件名必须是纯字母数字（挡掉 ".."、"\"、斜杠这类路径穿越写法）
 *   ② 拼出来的绝对路径必须还在 bgDir 里面（挡掉符号链接之类的逃逸）
 */
function registerBgProtocol(bgDir) {
  protocol.handle('bg', async (request) => {
    try {
      const u = new URL(request.url);
      const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));

      if (!/^[\w.\-]+$/.test(name)) {
        return new Response('文件名不合法', { status: 400 });
      }

      const file = path.resolve(bgDir, name);
      if (!file.startsWith(bgDir + path.sep)) {
        return new Response('越界访问被拒绝', { status: 403 });
      }
      if (!fs.existsSync(file)) {
        return new Response('背景文件不存在', { status: 404 });
      }

      const total = fs.statSync(file).size;
      const type = BG_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

      // ★ 图片和视频都走"流式 + 支持 Range"这一条路。
      //   为什么视频必须这样：一个背景视频几十上百 MB，若像以前那样
      //   fs.readFileSync 一次性读完整份再返回，会瞬间吃满内存、还可能卡住界面；
      //   而 <video> 播放器还会发 Range 请求（拖动、循环回绕都靠它），
      //   必须回 206 + Content-Range 它才认。
      let start = 0;
      let end = total - 1;
      let status = 200;
      // 这个协议只服务本应用自己的背景目录，放行 CORS 是安全的；
      // 不放行的话，页面里用 fetch() 读它会被 CORS 拦掉（<img>/<video> 不受影响）。
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };

      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
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
      // 只读 [start, end] 这一段，边读边传；Node 的流转成网页的 ReadableStream
      const nodeStream = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(nodeStream), { status, headers });
    } catch (err) {
      console.error('[bg协议] 读取背景文件失败：', err);
      return new Response(String(err), { status: 500 });
    }
  });
}

module.exports = { BG_MIME, BG_VIDEO_MAX_MB, registerBgProtocol, clearBgDir };
