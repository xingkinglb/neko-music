/*
  ============================================================
   make-cat-icons.js —— 画 12 只"纯色小猫"候选（v2.3.0）
  ============================================================
   原来的图标是"猫耳方块 + 音符 + 粉紫渐变"。Neo 想要**纯色的小猫**。

   这个脚本一次画出 6 个候选，排成一张带编号的接触表
   （.verify/cat-preview.png），挑中哪一个就：

       node .verify/make-cat-icons.js 3      ← 把第 3 号写进 src/assets

   会同时写两张：
     src/assets/app.png   256×256 —— 窗口图标（任务栏 / Alt+Tab）
     src/assets/tray.ico  16+32+48  —— 托盘图标（多分辨率容器）

   手法沿用 make-icons.js：纯 Node，zlib + 手写 CRC32，
   每个像素 4×4 子采样按覆盖率混色。**零依赖。**

   设计坐标系：0..32（正方形），渲染时按比例换算。
   ============================================================
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const PREVIEW = path.join(__dirname, 'cat-preview.png');

const SS = 4;            // 每像素 4×4 子采样
const SPACE = 32;        // 设计坐标系大小

/* ============================================================
   一、几何图元（都在 0..32 的设计坐标系里）
   ============================================================ */
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTri(x, y, a, b, c) {
  const d1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const d3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function inRoundRect(x, y, x1, y1, x2, y2, r) {
  if (x < x1 || x > x2 || y < y1 || y > y2) return false;
  const cx = Math.min(Math.max(x, x1 + r), x2 - r);
  const cy = Math.min(Math.max(y, y1 + r), y2 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 到线段的距离 <= 半宽（画粗线） */
function onSeg(x, y, x1, y1, x2, y2, w) {
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((x - x1) * vx + (y - y1) * vy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = x - (x1 + t * vx), dy = y - (y1 + t * vy);
  return dx * dx + dy * dy <= (w / 2) * (w / 2);
}

/* ============================================================
   二、6 只猫（返回 true = 涂色，false = 透明）
   ============================================================ */
/* 通用的"头 + 两只耳朵"骨架；eyeHole 用来在脸上挖眼睛 */
function catHead(x, y, opt) {
  const o = opt || {};
  const cy = o.cy || 19.6;
  const r = o.r || 9.6;
  const head = inCircle(x, y, 16, cy, r);
  const earL = inTri(x, y, [6.9, cy - 5.6], [12.5, cy - 7.2], [7.4, 4.2]);
  const earR = inTri(x, y, [19.5, cy - 7.2], [25.1, cy - 5.6], [24.6, 4.2]);
  if (!(head || earL || earR)) return false;
  if (o.eyes && o.eyes(x, y)) return false;      // 挖掉眼睛 → 露出底色
  return true;
}

const CATS = [
  {
    id: '1', name: '纯剪影猫头',
    note: '最简洁：只有轮廓，没有五官。缩到 16px 也绝不会糊成一团。',
    paint: (x, y) => catHead(x, y, {}),
  },
  {
    id: '2', name: '圆眼睛猫',
    note: '剪影 + 两只镂空的圆眼睛。最"像猫"。',
    paint: (x, y) => catHead(x, y, {
      eyes: (px, py) => inCircle(px, py, 12.3, 18.4, 2.35) || inCircle(px, py, 19.7, 18.4, 2.35),
    }),
  },
  {
    id: '3', name: '眯眼猫（满足）',
    note: '眼睛是两道弯弯的缝 —— 一脸"正在听歌、很享受"。',
    paint: (x, y) => catHead(x, y, {
      eyes: (px, py) => onSeg(px, py, 10.0, 17.6, 14.4, 18.8, 2.1) ||
                        onSeg(px, py, 17.6, 18.8, 22.0, 17.6, 2.1),
    }),
  },
  {
    id: '4', name: '胡须猫',
    note: '有胡须和眼睛，细节最多（但小尺寸下胡须会变淡）。',
    paint: (x, y) => {
      const whisker = onSeg(x, y, 7.4, 20.6, 1.6, 18.6, 1.5) ||
                      onSeg(x, y, 7.2, 23.4, 1.2, 23.6, 1.5) ||
                      onSeg(x, y, 7.8, 26.0, 2.2, 28.0, 1.5) ||
                      onSeg(x, y, 24.6, 20.6, 30.4, 18.6, 1.5) ||
                      onSeg(x, y, 24.8, 23.4, 30.8, 23.6, 1.5) ||
                      onSeg(x, y, 24.2, 26.0, 29.8, 28.0, 1.5);
      if (whisker) return true;
      return catHead(x, y, { cy: 20.2, r: 9.0,
        eyes: (px, py) => inCircle(px, py, 12.6, 19.0, 2.0) || inCircle(px, py, 19.4, 19.0, 2.0) });
    },
  },
  {
    id: '5', name: '几何方块猫',
    note: '圆角方块当脑袋 + 两只尖耳朵。偏"图标感"，跟现在的风格最接近。',
    paint: (x, y) => {
      const body = inRoundRect(x, y, 6.2, 11.6, 25.8, 26.4, 5.4);
      const earL = inTri(x, y, [7.4, 13.0], [13.6, 12.4], [8.2, 3.6]);
      const earR = inTri(x, y, [18.4, 12.4], [24.6, 13.0], [23.8, 3.6]);
      return body || earL || earR;
    },
  },
  {
    id: '6', name: '猫脸（眼+鼻）',
    note: '圆脸 + 眼睛 + 小鼻子，五官最全。',
    paint: (x, y) => {
      const face = catHead(x, y, { cy: 19.8, r: 9.4,
        eyes: (px, py) => inCircle(px, py, 12.2, 18.0, 2.2) || inCircle(px, py, 19.8, 18.0, 2.2) });
      if (face) return true;
      // 小鼻子（倒三角）
      return inTri(x, y, [14.6, 22.4], [17.4, 22.4], [16.0, 24.4]);
    },
  },

  /* ---- 以下 7~12 是第二版：Neo 说第 5 只（几何方块猫）那个方向对味，
     所以这一批整体更"图标感"：块面更整、轮廓更硬、小尺寸下更不容易糊 ---- */
  {
    id: '7', name: '方块猫 + 圆眼',
    note: '第 5 只的方块脑袋，再加两只镂空圆眼睛 —— 有脸了，比 5 更像猫。',
    paint: (x, y) => {
      const body = inRoundRect(x, y, 6.2, 11.6, 25.8, 26.4, 5.4);
      const earL = inTri(x, y, [7.4, 13.0], [13.6, 12.4], [8.2, 3.6]);
      const earR = inTri(x, y, [18.4, 12.4], [24.6, 13.0], [23.8, 3.6]);
      if (!(body || earL || earR)) return false;
      if (inCircle(x, y, 12.2, 18.4, 2.5) || inCircle(x, y, 19.8, 18.4, 2.5)) return false;  // 挖眼睛
      return true;
    },
  },
  {
    id: '8', name: '硬边方块猫',
    note: '圆角更小、块面更满 —— 最"图标感"的一只，16px 下也最稳。',
    paint: (x, y) => {
      const body = inRoundRect(x, y, 4.4, 10.2, 27.6, 27.8, 2.6);
      const earL = inTri(x, y, [6.0, 11.6], [13.8, 11.0], [6.4, 2.6]);
      const earR = inTri(x, y, [18.2, 11.0], [26.0, 11.6], [25.6, 2.6]);
      return body || earL || earR;
    },
  },
  {
    id: '9', name: '长耳尖猫',
    note: '耳朵又长又尖、往外撇 —— 猫味最足的一只，剪影一眼就认得出。',
    paint: (x, y) => {
      const head = inCircle(x, y, 16, 20.6, 8.8);
      const earL = inTri(x, y, [6.6, 15.2], [13.2, 14.2], [4.4, 1.6]);
      const earR = inTri(x, y, [18.8, 14.2], [25.4, 15.2], [27.6, 1.6]);
      if (!(head || earL || earR)) return false;
      if (inCircle(x, y, 12.4, 19.4, 2.2) || inCircle(x, y, 19.6, 19.4, 2.2)) return false;
      return true;
    },
  },
  {
    id: '10', name: '坐着的猫（全身 + 尾巴）',
    note: '正脸全身剪影：脑袋 + 身子 + 一条翘起来的尾巴。缩略图里最好认。',
    paint: (x, y) => {
      if (inCircle(x, y, 16, 12.2, 6.8)) return true;                       // 头
      if (inTri(x, y, [9.2, 8.4], [13.4, 7.2], [8.8, 1.6])) return true;    // 左耳
      if (inTri(x, y, [18.6, 7.2], [22.8, 8.4], [23.2, 1.6])) return true;  // 右耳
      if (y >= 16.2 && y <= 29.6) {                                          // 身子：上窄下宽 + 底部收圆
        const hw = 5.4 + (y - 16.2) * 0.42;
        let lim = hw;
        if (y > 27.6) { const t = (y - 27.6) / 2.0; lim = hw - t * t * 2.6; }
        if (Math.abs(x - 16) <= lim) return true;
      }
      return onSeg(x, y, 21.6, 28.4, 26.4, 27.6, 2.0) ||                     // 尾巴：往右 → 往上翘
             onSeg(x, y, 26.4, 27.6, 27.8, 23.0, 2.0);
    },
  },
  {
    id: '11', name: '猫爪印',
    note: '一个大肉垫 + 四个脚趾。不是猫头，但**小尺寸下最清楚**，16px 也不糊。',
    paint: (x, y) => {
      const pad = inCircle(x, y, 16, 21.0, 7.2) || inTri(x, y, [9.6, 20.0], [22.4, 20.0], [16, 29.4]);
      const toes = [[8.0, 13.6, 2.9], [12.8, 10.6, 3.0], [19.2, 10.6, 3.0], [24.0, 13.6, 2.9]]
        .some((t) => inCircle(x, y, t[0], t[1], t[2]));
      return pad || toes;
    },
  },
  {
    id: '12', name: '戴耳罩的猫',
    note: '猫头 + 两只圆耳罩 —— 音乐软件最贴切的一只（一眼就知道是听歌的猫）。',
    paint: (x, y) => {
      const head = inCircle(x, y, 16, 19.6, 8.2);
      const earL = inTri(x, y, [8.4, 14.0], [13.4, 13.0], [8.8, 6.0]);
      const earR = inTri(x, y, [18.6, 13.0], [23.6, 14.0], [23.2, 6.0]);
      // ★ 顺序要紧：先判"在不在头上"，在头上的点才可能被眼睛挖掉。
      //   写成一串 if-return-true 的话，眼睛那句永远轮不到执行（这是个坑，别改回去）。
      if (head && !(inCircle(x, y, 12.4, 18.6, 2.1) || inCircle(x, y, 19.6, 18.6, 2.1))) return true;
      if (earL || earR) return true;
      if (inCircle(x, y, 6.2, 19.8, 3.7)) return true;                       // 左耳罩
      if (inCircle(x, y, 25.8, 19.8, 3.7)) return true;                      // 右耳罩
      return false;
    },
  },
];

const CAT_COLOR = [255, 122, 172];   // 纯色：和界面主题一致的粉

/* ============================================================
   三、渲染 + PNG 编码（和 make-icons.js 同一套手法）
   ============================================================ */
function renderRGBA(size, paint) {
  const k = SPACE / size;
  const buf = Buffer.alloc(size * size * 4);
  let p = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (!paint((px + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k)) continue;
          r += CAT_COLOR[0]; g += CAT_COLOR[1]; b += CAT_COLOR[2]; a += 255;
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function pngFromRGBABuf(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    rgba.copy(raw, p, y * w * 4, (y + 1) * w * 4);
    p += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const renderPNG = (size, paint) => pngFromRGBABuf(size, size, renderRGBA(size, paint));

function icoWrap(items) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(items.length, 4);
  let offset = 6 + items.length * 16;
  const dir = items.map((it) => {
    const e = Buffer.alloc(16);
    e[0] = it.size >= 256 ? 0 : it.size;
    e[1] = it.size >= 256 ? 0 : it.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(it.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += it.png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...items.map((i) => i.png)]);
}

/* ============================================================
   四、接触表（带编号，方便 Neo 直接说"我要 3 号"）
   ============================================================ */
/* 3×5 的点阵数字，画在每只猫下面 */
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};
const DS = 4;   // 数字每一"点"的像素数 → 单个数字 12×20

function drawDigit(sheet, SW, ox, oy, d, color) {
  const rows = DIGITS[d];
  if (!rows) return;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (rows[r][c] !== '1') continue;
      for (let yy = 0; yy < DS; yy++) {
        for (let xx = 0; xx < DS; xx++) {
          const px = ((oy + r * DS + yy) * SW + (ox + c * DS + xx)) * 4;
          sheet[px] = color[0]; sheet[px + 1] = color[1]; sheet[px + 2] = color[2];
        }
      }
    }
  }
}

/** 画一个整数（1~2 位）—— 12 只猫要编到 12，得支持两位数 */
function drawNumber(sheet, SW, cx, oy, n, color) {
  const ds = String(n);
  const w = ds.length * 3 * DS + (ds.length - 1) * DS;
  let ox = cx - Math.round(w / 2);
  for (const ch of ds) {
    drawDigit(sheet, SW, ox, oy, ch, color);
    ox += 3 * DS + DS;
  }
}

/* ★ 自检：v2.2.1 出过"图标文件其实是空 / 纯色块"的事（make-icons.js 形参写错），
   教训是**预览好看不算数，得数像素**。这里对每只猫在 16px 下量三项：
     着墨率（不能是 0，也不能接近 1）/ 最亮处 alpha（不能太淡）/ 有没有抗锯齿过渡。 */
function selfCheck() {
  let bad = 0;
  CATS.forEach((cat) => {
    const size = 16;
    const rgba = renderRGBA(size, cat.paint);
    let inked = 0, maxA = 0, edge = 0;
    for (let i = 0; i < size * size; i++) {
      const a = rgba[i * 4 + 3];
      if (a > 8) inked++;
      if (a > 8 && a < 247) edge++;
      if (a > maxA) maxA = a;
    }
    const ratio = inked / (size * size);
    const why = [];
    if (inked === 0) why.push('全透明（是空的）');
    if (ratio > 0.9) why.push('几乎全不透明（是个方块）');
    if (maxA < 200) why.push(`最亮只有 ${maxA}（太淡）`);
    if (inked > 0 && edge === 0) why.push('没有抗锯齿过渡');
    if (why.length) { bad++; console.log(`  ✗ ${cat.id}. ${cat.name} —— ` + why.join('；')); }
    else console.log(`  ✓ ${cat.id}. ${cat.name}  着墨 ${(ratio * 100).toFixed(0)}%  最亮 ${maxA}  过渡 ${edge}px`);
  });
  console.log(bad === 0 ? '\n12 只都过了像素体检 ✅' : `\n有 ${bad} 只不合格 ❌`);
  return bad === 0;
}

function buildPreview() {
  const COLS = 4, CELL = 132, ICON = 88;
  const rows = Math.ceil(CATS.length / COLS);
  const SW = COLS * CELL, SH = rows * CELL;
  const sheet = Buffer.alloc(SW * SH * 4);
  // 深色底（和托盘 / 任务栏的观感接近）
  for (let i = 0; i < SW * SH; i++) {
    sheet[i * 4] = 0x16; sheet[i * 4 + 1] = 0x16; sheet[i * 4 + 2] = 0x1e; sheet[i * 4 + 3] = 255;
  }
  CATS.forEach((cat, idx) => {
    const col = idx % COLS, row = Math.floor(idx / COLS);
    const ox = col * CELL + Math.round((CELL - ICON) / 2);
    const oy = row * CELL + Math.round((CELL - ICON) / 2) - 12;
    const rgba = renderRGBA(ICON, cat.paint);
    for (let y = 0; y < ICON; y++) {
      for (let x = 0; x < ICON; x++) {
        const s = (y * ICON + x) * 4;
        const a = rgba[s + 3] / 255;
        if (a <= 0) continue;
        const d = ((oy + y) * SW + (ox + x)) * 4;
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a));
      }
    }
    // 编号
    drawNumber(sheet, SW, col * CELL + Math.round(CELL / 2), row * CELL + CELL - 26, cat.id, [235, 235, 245]);
  });
  fs.writeFileSync(PREVIEW, pngFromRGBABuf(SW, SH, sheet));
  return { SW, SH };
}

/* ============================================================
   五、开工
   ============================================================ */
fs.mkdirSync(ASSETS, { recursive: true });
const arg = process.argv[2];

if (!arg) {
  const ok = selfCheck();
  const { SW, SH } = buildPreview();
  console.log('画好了 ' + CATS.length + ' 只猫，接触表在 ' + path.relative(ROOT, PREVIEW) + `  (${SW}×${SH})`);
  console.log(`（每只猫下面有编号，左→右、上→下 依次是 1~${CATS.length}）\n`);
  CATS.forEach((c) => console.log(`  ${c.id}. ${c.name} —— ${c.note}`));
  console.log(`\n挑中哪个就把编号传进来，比如：node .verify/make-cat-icons.js ${CATS.length}`);
  process.exit(ok ? 0 : 1);
}

const pick = CATS.find((c) => c.id === String(arg).trim()) || CATS.find((c) => c.name === String(arg).trim());
if (!pick) {
  console.error('没有这只猫：' + arg + '（可选 1~6 或名字）');
  process.exit(1);
}

const appPng = renderPNG(256, pick.paint);
fs.writeFileSync(path.join(ASSETS, 'app.png'), appPng);

// Windows 安装包把 .ico 当作可执行文件图标，要求至少有 256×256 档。
// 前三档给托盘按 DPI 挑选，256 档专供 EXE / 安装包图标（目录项宽高写 0 表示 256）。
const ico = icoWrap([16, 32, 48, 256].map((size) => ({ size, png: renderPNG(size, pick.paint) })));
fs.writeFileSync(path.join(ASSETS, 'tray.ico'), ico);

console.log(`已把「${pick.id}. ${pick.name}」写进 src/assets：`);
console.log('  app.png   256×256  (' + appPng.length + ' 字节)  ← 任务栏 / Alt+Tab');
console.log('  tray.ico  16+32+48+256 (' + ico.length + ' 字节)  ← 托盘 + Windows 安装包图标');
console.log('\n记得跑一遍 node .verify/check-icons.js 验收。');
