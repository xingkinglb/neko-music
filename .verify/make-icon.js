/*
  一次性脚本：生成窗口图标 src/assets/app.png（256×256）。

  为什么手搓：项目是"零运行时依赖"，为了一个图标去装 sharp / canvas 不值当。
  手法和 .verify/test-round9.js 里的 solidPng() 一样 —— 纯 Node 的 zlib + 手写
  CRC32 + IHDR/IDAT/IEND 三块，一个字节都不靠第三方库。

  画什么：猫耳 + 音符。
    · 底：圆角方，粉→紫的对角渐变（和界面主题色一致）
    · 顶：两只猫耳（Neko = 猫）
    · 中：一个白色的"双头联梁"音符

  抗锯齿：每个像素取 4×4 = 16 个子采样，按覆盖率混色（这就是全部"画图"的功夫）。

  用法：node .verify/make-icon.js
  产物：src/assets/app.png
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'assets', 'app.png');

const W = 256;
const H = 256;
const SS = 4;              // 每个像素 4×4 个子采样
const S = W * SS;          // 超采样坐标系边长

/* ---------- 颜色 ---------- */
const PINK = [255, 111, 165];    // --accent
const PURPLE = [160, 107, 255];  // --accent-2
const WHITE = [255, 255, 255];

/* ---------- 几何判定（都在 0..S 的超采样坐标系里） ---------- */

// 点 (x,y) 是不是落在圆里
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 点 (x,y) 是不是落在椭圆里（可以带一点旋转，用来把音符头"歪"一下）
function inEllipse(x, y, cx, cy, rx, ry, rot) {
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const dx = x - cx;
  const dy = y - cy;
  const ux = dx * c - dy * s;
  const uy = dx * s + dy * c;
  return (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1;
}

// 射线法：点是不是在多边形里
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 圆角矩形
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* ---------- 图形定义 ---------- */
const k = S / 256;   // 把"按 256 设计的坐标"换算到超采样坐标系

// 圆角方底：留出四周的空白，让猫耳顶上去
const BODY = { x0: 22 * k, y0: 46 * k, x1: 234 * k, y1: 234 * k, r: 54 * k };

// 两只猫耳（三角形：底边埋进圆角方里，尖顶冒出来）
const EAR_L = [[56, 66], [110, 66], [70, 10]].map(([x, y]) => [x * k, y * k]);
const EAR_R = [[146, 66], [200, 66], [186, 10]].map(([x, y]) => [x * k, y * k]);

// 音符：两个头 + 两根竖杆 + 一道联梁（和界面里"没有封面"时那个兜底音符同一个意思）
const HEAD_L = { cx: 92 * k, cy: 176 * k, rx: 27 * k, ry: 20 * k, rot: -0.35 };
const HEAD_R = { cx: 176 * k, cy: 158 * k, rx: 27 * k, ry: 20 * k, rot: -0.35 };
const STEM_L = [[106, 74], [118, 74], [118, 176], [106, 176]].map(([x, y]) => [x * k, y * k]);
const STEM_R = [[190, 56], [202, 56], [202, 158], [190, 158]].map(([x, y]) => [x * k, y * k]);
const BEAM = [[106, 74], [202, 56], [202, 84], [106, 102]].map(([x, y]) => [x * k, y * k]);

/* ---------- 采样：返回该点的 RGBA（0..255） ---------- */
function sample(x, y) {
  const inBody = inRoundRect(x, y, BODY.x0, BODY.y0, BODY.x1, BODY.y1, BODY.r);
  const inEar = inPoly(x, y, EAR_L) || inPoly(x, y, EAR_R);
  const inSilhouette = inBody || inEar;

  if (!inSilhouette) return [0, 0, 0, 0];

  const inNote =
    inEllipse(x, y, HEAD_L.cx, HEAD_L.cy, HEAD_L.rx, HEAD_L.ry, HEAD_L.rot) ||
    inEllipse(x, y, HEAD_R.cx, HEAD_R.cy, HEAD_R.rx, HEAD_R.ry, HEAD_R.rot) ||
    inPoly(x, y, STEM_L) ||
    inPoly(x, y, STEM_R) ||
    inPoly(x, y, BEAM);

  if (inNote) return [WHITE[0], WHITE[1], WHITE[2], 255];

  // 底色：沿左上→右下做粉→紫的渐变
  const t = Math.min(1, Math.max(0, (x / S + y / S) / 2));
  return [
    Math.round(PINK[0] + (PURPLE[0] - PINK[0]) * t),
    Math.round(PINK[1] + (PURPLE[1] - PINK[1]) * t),
    Math.round(PINK[2] + (PURPLE[2] - PINK[2]) * t),
    255,
  ];
}

/* ---------- 渲染 ---------- */
const raw = Buffer.alloc(H * (1 + W * 4));   // 每行前面一个 filter 字节（0 = None）
let p = 0;
for (let py = 0; py < H; py++) {
  raw[p++] = 0;
  for (let px = 0; px < W; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(px * SS + sx + 0.5, py * SS + sy + 0.5);
        // 先按 alpha 加权累加颜色，最后再除以 alpha 总量 —— 否则透明像素会把颜色拉黑
        const w = sa / 255;
        r += sr * w;
        g += sg * w;
        b += sb * w;
        a += sa;
      }
    }
    const n = SS * SS;
    const aAvg = a / n;
    const wSum = a / 255;
    raw[p++] = wSum ? Math.round(r / wSum) : 0;
    raw[p++] = wSum ? Math.round(g / wSum) : 0;
    raw[p++] = wSum ? Math.round(b / wSum) : 0;
    raw[p++] = Math.round(aAvg);
  }
}

/* ---------- 装成 PNG ---------- */
const table = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;    // 位深
ihdr[9] = 6;    // 颜色类型 6 = 真彩色 + alpha（RGBA）
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`已生成 ${path.relative(ROOT, OUT)}（${W}×${H}，${png.length} 字节）`);
