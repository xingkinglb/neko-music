/*
  ============================================================
   check-icons.js —— 图标体检（v2.2.1 新增，v2.3.0 扩到四档托盘）
  ============================================================
   为什么需要它：v2.2.0 出过一次"预览图全对、真图标全坏"的事故 ——
   `.verify/make-icons.js` 里生成菜单图标的 paint 函数形参写错，
   写盘的 16 个 PNG 全变成了**纯色块**或**全透明**，
   但接触表 icons-preview.png 用的是另一条代码路径，看起来完美无缺。
   光靠肉眼看预览图，根本发现不了。

   所以这个脚本干一件事：**把写盘的图标解码回来，直接数像素。**
     · 全不透明（>95%）→ 纯色块，报错
     · 全透明          → 空的，报错
     · 着墨比例不在 2%~75% 之间 → 可疑，报错
     · 两个图标长得一模一样 → 报错（多半是复制粘贴写错了）

   用法：node .verify/check-icons.js
   ============================================================
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const REPORT = path.join(__dirname, 'check-icons-report.txt');

let fail = 0;
let pass = 0;
const out = [];
const say = (s) => { out.push(s); console.log(s); };
const err = (s) => { fail++; say('  ✗ ' + s); };
const ok = (s) => { pass++; say('  ✓ ' + s); };

/* ---------- 一个够用的 PNG 解码器（8 位 RGBA / RGB，滤镜 0~4） ---------- */
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let i = 8;
  let idat = Buffer.alloc(0);
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.slice(i + 8, i + 8 + len);
    i += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, data]);
    } else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位：' + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error('只支持 RGB/RGBA：colorType=' + colorType);

  const raw = zlib.inflateSync(idat);
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride)); pos += stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = y > 0 ? px[prevOff + x] : 0;
      const c = (x >= ch && y > 0) ? px[prevOff + x - ch] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      line[x] = v;
    }
    line.copy(px, y * stride);
  }
  return { w, h, ch, px };
}

/** 数一张图的不透明 / 半透明 / 全透明像素，以及一个能代表"形状"的指纹 */
function stats(img) {
  const { w, h, ch, px } = img;
  let opaque = 0, half = 0, clear = 0, maxA = 0;
  const sig = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ch === 4 ? px[(y * w + x) * ch + 3] : 255;
      if (a > maxA) maxA = a;
      if (a > 200) opaque++;
      else if (a > 20) half++;
      else clear++;
      // 指纹：按 4×4 分块统计着墨量（用来判断两个图标是不是长得一样）
      if (a > 90) {
        const k = (Math.floor(y / Math.max(1, h / 4)) * 4 + Math.floor(x / Math.max(1, w / 4)));
        sig[k] = (sig[k] || 0) + 1;
      }
    }
  }
  return { total: w * h, opaque, half, clear, maxA, sig: sig.join(',') };
}

/* ---------- 体检一张图 ---------- */
function checkImage(label, img) {
  const s = stats(img);
  const inked = s.opaque + s.half;
  const inkRatio = inked / s.total;
  const solidRatio = s.opaque / s.total;
  const notes = [];
  // ★ 判"空"要看**着墨**（不透明 + 半透明），不能只看"全不透明"——
  //   一条细线可能整根都是抗锯齿的，一个全不透明像素都没有，但它是画出来了的。
  if (inked === 0) notes.push('全透明（图标是空的）');
  else if (solidRatio > 0.95) notes.push('几乎全不透明（是个纯色块）');
  else if (inkRatio < 0.03) notes.push('着墨太少（几乎看不见）');
  else if (inkRatio > 0.75) notes.push('着墨偏多（可能有实心块）');
  if (inked > 0 && s.maxA < 200) notes.push(`最亮处只有 ${s.maxA}（图标偏淡：多半是线条骑在像素边界上，没对齐像素中心）`);
  if (inked > 0 && s.half === 0) notes.push('没有任何抗锯齿过渡像素（线条太生硬）');
  if (notes.length) {
    err(`${label}  ${img.w}×${img.h}  着墨${inked}(${(inkRatio * 100).toFixed(0)}%) 最亮${s.maxA} → ${notes.join('；')}`);
  } else {
    ok(`${label}  ${img.w}×${img.h}  着墨${inked}(${(inkRatio * 100).toFixed(0)}%) 实心${s.opaque} 半透明${s.half} 最亮${s.maxA}`);
  }
  return s;
}

/* ============================================================
   开工
   ============================================================ */
say('图标体检 —— 把写盘的 .png 解码回来数像素\n');

const MENU = ['show', 'note', 'play', 'pause', 'prev', 'next', 'mode', 'win', 'lyric', 'lock', 'settings', 'quit'];
const THUMB = ['prev', 'play', 'pause', 'next'];

say('[1] 菜单小图标（12 个，各两档）：');
const menuSigs = new Map();
for (const name of MENU) {
  for (const suffix of ['', '@2x']) {
    const f = path.join(ASSETS, `menu-${name}${suffix}.png`);
    if (!fs.existsSync(f)) { err(`缺文件 menu-${name}${suffix}.png`); continue; }
    const s = checkImage(`menu-${name}${suffix}.png`, decodePNG(fs.readFileSync(f)));
    if (!suffix) {
      if (menuSigs.has(s.sig)) err(`menu-${name}.png 和 menu-${menuSigs.get(s.sig)}.png 长得一模一样`);
      else menuSigs.set(s.sig, name);
    }
  }
}

say('\n[2] 任务栏缩略图按钮（4 个，各两档）：');
const thumbSigs = new Map();
for (const name of THUMB) {
  for (const suffix of ['', '@2x']) {
    const f = path.join(ASSETS, `thumb-${name}${suffix}.png`);
    if (!fs.existsSync(f)) { err(`缺文件 thumb-${name}${suffix}.png`); continue; }
    const s = checkImage(`thumb-${name}${suffix}.png`, decodePNG(fs.readFileSync(f)));
    if (!suffix) {
      if (thumbSigs.has(s.sig)) err(`thumb-${name}.png 和 thumb-${thumbSigs.get(s.sig)}.png 长得一模一样`);
      else thumbSigs.set(s.sig, name);
    }
  }
}

say('\n[3] 托盘 .ico（多分辨率容器，里面是 16 / 32 / 48 / 256 四张内嵌 PNG）：');
{
  const f = path.join(ASSETS, 'tray.ico');
  if (!fs.existsSync(f)) err('缺文件 tray.ico');
  else {
    const buf = fs.readFileSync(f);
    const count = buf.readUInt16LE(4);
    if (count < 4) err(`tray.ico 只塞了 ${count} 档，v2.3.0 应该是 4 档（16 + 32 + 48 + 256）`);
    else ok(`tray.ico 共 ${count} 档（16 / 32 / 48 + 安装包用 256）`);
    let off = 6;
    for (let i = 0; i < count; i++) {
      const sz = buf.readUInt32LE(off + 8);
      const dataOff = buf.readUInt32LE(off + 12);
      off += 16;
      const png = buf.slice(dataOff, dataOff + sz);
      checkImage(`tray.ico[${i}]`, decodePNG(png));
    }
  }
}

say('\n[4] 窗口图标 app.png（v2.1.0 的，顺手一起看）：');
{
  const f = path.join(ASSETS, 'app.png');
  if (!fs.existsSync(f)) err('缺文件 app.png');
  else checkImage('app.png', decodePNG(fs.readFileSync(f)));
}

say('');
if (fail === 0) say(`图标体检全部通过 ✅（${pass} 项）`);
else say(`图标体检失败 ${fail} 项 ❌（通过 ${pass} 项）`);
fs.writeFileSync(REPORT, out.join('\n') + '\n');
process.exit(fail ? 1 : 0);
