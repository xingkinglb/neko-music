/*
  一次性脚本：生成 v2.2.0 要用的那一堆小图标。

  为什么还是手搓：项目是"零运行时依赖"，为了几个 16×16 的小图标去装 sharp / canvas 不值当。
  手法沿用 v2.1.0 的 .verify/make-icon.js —— 纯 Node 的 zlib + 手写 CRC32 + IHDR/IDAT/IEND，
  每个像素取 4×4 = 16 个子采样按覆盖率混色（这就是全部"画图"的功夫）。

  产出（都进 src/assets/）：
    tray.ico                 —— 托盘图标。ICO 是"多分辨率容器"，里面塞 16×16 和 32×32 两张 PNG，
                                系统按当前 DPI 自己挑一档（比单张 PNG 清晰）。见 docs/参考实现研究-biu.md §2.5
    thumb-{prev,play,pause,next}.png —— 任务栏缩略图上那三个按钮（白色，任务栏预览是深色的）
    menu-{...}.png           —— 托盘菜单每项前面那个小图标（浅粉，深浅色菜单上都看得见）

  另外出一张 .verify/icons-preview.png 接触表（放大 3~4 倍、深色底），
  方便用眼睛检查"到底画出来是个什么形状"——不靠猜。

  用法：node .verify/make-icons.js
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const PREVIEW = path.join(__dirname, 'icons-preview.png');

const SS = 4;   // 每个像素 4×4 子采样

/* ============================================================
   一、几何图元（都在 0..16 的"设计坐标系"里，最后按 size/16 缩放）
   ============================================================ */

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (!inRect(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 圆角矩形的"框"（外框减内框），画描边用 */
function inRoundRectRing(x, y, x0, y0, x1, y1, r, w) {
  if (!inRoundRect(x, y, x0, y0, x1, y1, r)) return false;
  const r2 = Math.max(0, r - w);
  return !inRoundRect(x, y, x0 + w, y0 + w, x1 - w, y1 - w, r2);
}

const inCircle = (x, y, cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;

function inRing(x, y, cx, cy, r, w) {
  const d = Math.hypot(x - cx, y - cy);
  return Math.abs(d - r) <= w / 2;
}

/** 带缺口的圆环（电源键、循环箭头那种）。gapC = 缺口中心角（弧度），gapH = 缺口半角 */
function inRingGap(x, y, cx, cy, r, w, gapC, gapH) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (Math.abs(d - r) > w / 2) return false;
  let diff = Math.atan2(dy, dx) - gapC;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff) > gapH;
}

/** 点到线段的距离 ≤ w/2 —— 用来画"粗线" */
function onSeg(x, y, x1, y1, x2, y2, w) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((x - x1) * vx + (y - y1) * vy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const px = x1 + t * vx;
  const py = y1 + t * vy;
  return Math.hypot(x - px, y - py) <= w / 2;
}

function inTri(x, y, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([x, y], a, b);
  const d2 = s([x, y], b, c);
  const d3 = s([x, y], c, a);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/* ============================================================
   二、12 个菜单小图标（在 0..16 里画）
   ============================================================ */
// 每个元素：[名字, 判定函数]
const GLYPHS = [
  // 显示主窗口：一个带标题栏的窗口
  ['show', (x, y) => inRoundRectRing(x, y, 2, 3.6, 14, 12.6, 2.2, 1.5) || onSeg(x, y, 2, 6.6, 14, 6.6, 1.5)],

  // 当前歌名：一个八分音符
  ['note', (x, y) => inCircle(x, y, 6.2, 11.3, 2.6) ||
                   onSeg(x, y, 8.7, 11.3, 8.7, 3.4, 1.5) ||
                   onSeg(x, y, 8.7, 3.4, 12.5, 5.2, 1.5)],

  // 播放 ▶
  ['play', (x, y) => inTri(x, y, [5.2, 3.2], [13.4, 8], [5.2, 12.8])],

  // 暂停 ‖
  ['pause', (x, y) => inRoundRect(x, y, 4.2, 3, 7.2, 13, 1.1) || inRoundRect(x, y, 8.8, 3, 11.8, 13, 1.1)],

  // 上一首 |◀
  ['prev', (x, y) => inRoundRect(x, y, 2.6, 3, 4.8, 13, 0.9) ||
                    inTri(x, y, [13.4, 3.2], [13.4, 12.8], [5.8, 8])],

  // 下一首 ▶|
  ['next', (x, y) => inTri(x, y, [2.6, 3.2], [2.6, 12.8], [10.2, 8]) ||
                    inRoundRect(x, y, 11.2, 3, 13.4, 13, 0.9)],

  // 播放模式：带箭头的循环圈
  ['mode', (x, y) => inRingGap(x, y, 8, 8, 5, 1.5, -Math.PI / 4, 0.55) ||
                    inTri(x, y, [10.4, 2.6], [13.6, 5.4], [9.8, 6.4])],

  // 窗口模式：大窗口里套一个小窗口（"能缩成小条"）
  ['win', (x, y) => inRoundRectRing(x, y, 2.4, 3.4, 13.6, 12.6, 2.2, 1.5) ||
                   inRoundRect(x, y, 8.2, 8.4, 12.8, 11.6, 1.1)],

  // 桌面歌词：三行文字
  ['lyric', (x, y) => onSeg(x, y, 3, 5, 13, 5, 1.6) ||
                     onSeg(x, y, 3, 8, 13, 8, 1.6) ||
                     onSeg(x, y, 3, 11, 9.5, 11, 1.6)],

  // 锁定：挂锁
  ['lock', (x, y) => inRoundRect(x, y, 4.2, 7.2, 11.8, 13.6, 1.6) ||
                    inRingGap(x, y, 8, 7.4, 2.7, 1.5, Math.PI / 2, Math.PI / 2 - 0.001)],

  // 设置：齿轮
  ['settings', (x, y) => {
    if (inRing(x, y, 8, 8, 4.5, 1.8)) return true;
    if (inCircle(x, y, 8, 8, 1.5)) return true;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const x1 = 8 + Math.cos(a) * 4.2;
      const y1 = 8 + Math.sin(a) * 4.2;
      const x2 = 8 + Math.cos(a) * 6.2;
      const y2 = 8 + Math.sin(a) * 6.2;
      if (onSeg(x, y, x1, y1, x2, y2, 2.1)) return true;
    }
    return false;
  }],

  // 退出：电源键
  ['quit', (x, y) => inRingGap(x, y, 8, 8.6, 4.6, 1.7, -Math.PI / 2, 0.42) ||
                    onSeg(x, y, 8, 2.9, 8, 8.6, 1.7)],
];

const MENU_COLOR = [255, 138, 184];   // 浅粉：深色菜单上亮眼，浅色菜单上也不糊
const THUMB_COLOR = [255, 255, 255];  // 任务栏预览是深色的，按钮图标用纯白

/* ============================================================
   三、托盘图标（猫耳 + 音符 + 粉紫渐变底）
   ============================================================ */
const PINK = [255, 111, 165];
const PURPLE = [160, 107, 255];

/** 在 size×size 的坐标系里判定（内部统一按 16 设计，再乘 k 放大） */
function trayPaint(size, x, y) {
  const k = size / 16;
  const body = inRoundRect(x, y, 2.0 * k, 4.8 * k, 14.0 * k, 13.8 * k, 3.4 * k);
  const earL = inTri(x, y, [3.0 * k, 5.4 * k], [7.2 * k, 5.4 * k], [4.2 * k, 1.0 * k]);
  const earR = inTri(x, y, [8.8 * k, 5.4 * k], [13.0 * k, 5.4 * k], [11.8 * k, 1.0 * k]);
  if (!(body || earL || earR)) return [0, 0, 0, 0];

  const note = inCircle(x, y, 6.4 * k, 11.0 * k, 2.1 * k) ||
               onSeg(x, y, 8.3 * k, 11.0 * k, 8.3 * k, 5.4 * k, 1.35 * k) ||
               onSeg(x, y, 8.3 * k, 5.4 * k, 11.6 * k, 6.5 * k, 1.35 * k);
  if (note) return [255, 255, 255, 255];

  const t = Math.min(1, Math.max(0, (x / size + y / size) / 2));
  return [
    Math.round(PINK[0] + (PURPLE[0] - PINK[0]) * t),
    Math.round(PINK[1] + (PURPLE[1] - PINK[1]) * t),
    Math.round(PINK[2] + (PURPLE[2] - PINK[2]) * t),
    255,
  ];
}

/* ============================================================
   四、渲染：paint(size, x, y) → [r,g,b,a]；4×4 超采样
   ============================================================ */
function renderRGBA(size, paint) {
  const buf = Buffer.alloc(size * size * 4);
  let p = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = paint(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
          const w = sa / 255;
          r += sr * w; g += sg * w; b += sb * w; a += sa;
        }
      }
      const wSum = a / 255;
      buf[p++] = wSum ? Math.round(r / wSum) : 0;
      buf[p++] = wSum ? Math.round(g / wSum) : 0;
      buf[p++] = wSum ? Math.round(b / wSum) : 0;
      buf[p++] = Math.round(a / (SS * SS));
    }
  }
  return buf;
}

/* ---------- PNG 编码（手写 CRC32 + 三块） ---------- */
const CRC_TABLE = (() => {
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
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

/** 任意宽高的 RGBA 缓冲 → PNG */
function pngFromRGBABuf(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;   // filter = None
    rgba.copy(raw, p, y * w * 4, (y + 1) * w * 4);
    p += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型 6 = RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngFromRGBA = (size, rgba) => pngFromRGBABuf(size, size, rgba);
const renderPNG = (size, paint) => pngFromRGBA(size, renderRGBA(size, paint));

/* ============================================================
   五、ICO 容器：6 字节文件头 + 每张 16 字节目录项 + 直接跟 PNG 数据
      （Vista 以后的 ICO 允许内嵌 PNG，不用 BMP）
   ============================================================ */
function icoWrap(items) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);              // reserved
  head.writeUInt16LE(1, 2);              // type = 1（图标）
  head.writeUInt16LE(items.length, 4);   // 有几张

  let offset = 6 + 16 * items.length;
  const dir = [];
  for (const it of items) {
    const e = Buffer.alloc(16);
    e.writeUInt8(it.size >= 256 ? 0 : it.size, 0);   // 宽（0 表示 256）
    e.writeUInt8(it.size >= 256 ? 0 : it.size, 1);   // 高
    e.writeUInt8(0, 2);                              // 调色板数（真彩 = 0）
    e.writeUInt8(0, 3);                              // 保留
    e.writeUInt16LE(1, 4);                           // 平面数
    e.writeUInt16LE(32, 6);                          // 位深
    e.writeUInt32LE(it.png.length, 8);               // 这张图多少字节
    e.writeUInt32LE(offset, 12);                     // 从文件头数起的位置
    dir.push(e);
    offset += it.png.length;
  }
  return Buffer.concat([head, ...dir, ...items.map((i) => i.png)]);
}

/* ============================================================
   六、开工
   ============================================================ */
fs.mkdirSync(ASSETS, { recursive: true });
const made = [];

// 6.1 菜单小图标（12 个，16×16，浅粉）
for (const [name, shape] of GLYPHS) {
  const paint = (size, x, y) => {
    const k = 16 / size;   // 把 size 坐标系换算回 0..16
    return shape(x * k, y * k) ? [MENU_COLOR[0], MENU_COLOR[1], MENU_COLOR[2], 255] : [0, 0, 0, 0];
  };
  const file = path.join(ASSETS, `menu-${name}.png`);
  fs.writeFileSync(file, renderPNG(16, paint));
  made.push([`menu-${name}.png`, fs.statSync(file).size]);
}

// 6.2 任务栏缩略图按钮（4 个，16×16，纯白）
for (const name of ['prev', 'play', 'pause', 'next']) {
  const shape = GLYPHS.find((g) => g[0] === name)[1];
  const paint = (size, x, y) => {
    const k = 16 / size;
    return shape(x * k, y * k) ? [THUMB_COLOR[0], THUMB_COLOR[1], THUMB_COLOR[2], 255] : [0, 0, 0, 0];
  };
  const file = path.join(ASSETS, `thumb-${name}.png`);
  fs.writeFileSync(file, renderPNG(16, paint));
  made.push([`thumb-${name}.png`, fs.statSync(file).size]);
}

// 6.3 托盘图标：ICO 里塞 16×16 + 32×32 两档
const tray16 = renderPNG(16, (x, y) => trayPaint(16, x, y));
const tray32 = renderPNG(32, (x, y) => trayPaint(32, x, y));
const icoFile = path.join(ASSETS, 'tray.ico');
fs.writeFileSync(icoFile, icoWrap([{ size: 16, png: tray16 }, { size: 32, png: tray32 }]));
made.push(['tray.ico', fs.statSync(icoFile).size]);

/* ============================================================
   七、接触表（给人眼看）：5 列 × 4 行，深色底，图标放大 3~4 倍
   ============================================================ */
const CELL = 96;
const COLS = 5;
const items = [];

// 菜单图标：放大 4 倍（16 → 64）
for (const [name, shape] of GLYPHS) {
  items.push({
    px: 64,
    paint: (x, y) => {
      const k = 16 / 64;   // 64px 的图 → 0..16 设计坐标系
      return shape(x * k, y * k) ? [MENU_COLOR[0], MENU_COLOR[1], MENU_COLOR[2], 255] : [0, 0, 0, 0];
    },
  });
}
// 任务栏按钮：放大 4 倍（16 → 64）
for (const name of ['prev', 'play', 'pause', 'next']) {
  const shape = GLYPHS.find((g) => g[0] === name)[1];
  items.push({
    px: 64,
    paint: (x, y) => {
      const k = 16 / 64;
      return shape(x * k, y * k) ? [255, 255, 255, 255] : [0, 0, 0, 0];
    },
  });
}
// 托盘图标：16× 放 4 倍、32× 放 3 倍
items.push({ px: 64, paint: (x, y) => trayPaint(16, (x * 16) / 64, (y * 16) / 64) });
items.push({ px: 96, paint: (x, y) => trayPaint(32, (x * 32) / 96, (y * 32) / 96) });

const rows = Math.ceil(items.length / COLS);
const SW = COLS * CELL;
const SH = rows * CELL;
const sheet = Buffer.alloc(SW * SH * 4);
for (let i = 0; i < SW * SH; i++) {
  sheet[i * 4] = 0x16; sheet[i * 4 + 1] = 0x16; sheet[i * 4 + 2] = 0x1e; sheet[i * 4 + 3] = 255;
}

items.forEach((it, idx) => {
  const col = idx % COLS;
  const row = Math.floor(idx / COLS);
  const ox = col * CELL + Math.round((CELL - it.px) / 2);
  const oy = row * CELL + Math.round((CELL - it.px) / 2);
  const rgba = renderRGBA(it.px, it.paint);
  for (let y = 0; y < it.px; y++) {
    for (let x = 0; x < it.px; x++) {
      const s = (y * it.px + x) * 4;
      const a = rgba[s + 3] / 255;
      if (a <= 0) continue;
      const d = ((oy + y) * SW + (ox + x)) * 4;
      for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a));
    }
  }
});
fs.writeFileSync(PREVIEW, pngFromRGBABuf(SW, SH, sheet));

console.log('已生成 ' + made.length + ' 个图标：');
for (const [n, s] of made) console.log('  src/assets/' + n + '  (' + s + ' 字节)');
console.log('接触表：' + path.relative(ROOT, PREVIEW) + `  (${SW}×${SH}，${items.length} 个)`);
