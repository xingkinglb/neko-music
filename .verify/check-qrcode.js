/* 自检：扫码登录的二维码画得对不对。
   跑：node .verify/check-qrcode.js      有问题退出码 1

   ---- 为什么不直接检查"能不能扫" ----
   那需要解码器，而本项目是零运行时依赖 —— 不能为了自检把 jsqr 拉进来。
   2026-11-02 开发时人工验过一次：把渲染结果截成 PNG 再用 jsqr 解，
   解出来的内容和 bilibili 的登录地址**完全一致**（版本 8 / 49×49）。
   所以这里固化的是**结构和几何** —— 尺寸公式、三个定位图形、时序图形、静区。
   这几项错了必然扫不出来，能抓住"画歪了 / 少了一圈 / 静区没留"这类事故。

   ---- 顺带守住一件事 ----
   qr-login.js 里 toPath() 的输入是库给的布尔矩阵，输出是 SVG 路径。
   这里用真库生成真矩阵，再逐格比对 path 覆盖的格子 ——
   防止"路径拼错导致某些黑块漏画"（那种错肉眼很难发现，扫不出来却毫无征兆）。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const qrLogin = require(path.join(ROOT, 'src', 'qr-login.js'));
const QR = require(path.join(ROOT, 'src', 'vendor', 'qrcode.js'));

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

/* 用 B 站真实会返回的那种地址（131 字符）当样本 */
const SAMPLE =
  'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close' +
  '&qrcode_key=0d2e853d619d699f3766e5960f059341&from=';

const qr = QR(0, 'M');
qr.addData(SAMPLE);
qr.make();
const n = qr.getModuleCount();

console.log('\n[1] 矩阵尺寸：');
// QR 规范：模块数 = 4 × 版本 + 17
if (n !== 21 && (n - 17) % 4 !== 0) err(`模块数 ${n} 不符合 4×版本+17 的公式`);
else ok(`${n}×${n}，版本 ${(n - 17) / 4}（4×${(n - 17) / 4}+17 = ${n}）`);

console.log('\n[2] 三个定位图形（左上 / 右上 / 左下）：');
/* 定位图形是 7×7：外圈全黑、第二圈全白、中心 3×3 全黑。
   少一圈、位置偏一格，都必然扫不出来。 */
function finderGood(top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3)); // 0=中心 3×3，3=最外圈
      const wantDark = ring !== 2; // 第 2 圈是白的，其余黑
      if (qr.isDark(top + r, left + c) !== wantDark) return false;
    }
  }
  return true;
}
const corners = [['左上', 0, 0], ['右上', 0, n - 7], ['左下', n - 7, 0]];
for (const [name, top, left] of corners) {
  if (finderGood(top, left)) ok(`${name}定位图形正确（7×7，外黑中白心黑）`);
  else err(`${name}定位图形不对 —— 这个码扫不出来`);
}

console.log('\n[3] 时序图形（第 6 行 / 第 6 列的黑白交替）：');
/* 时序图形是定位图形之间那条"斑马线"，用来给扫码器定格子大小。
   它必须是严格交替的，错一格整体采样就会偏。 */
let timingBad = 0;
for (let i = 8; i < n - 8; i++) {
  const want = i % 2 === 0;
  if (qr.isDark(6, i) !== want) timingBad++;
  if (qr.isDark(i, 6) !== want) timingBad++;
}
if (timingBad) err(`时序图形有 ${timingBad} 格不对（应为严格交替）`);
else ok(`横竖两条时序图形都严格交替（各 ${n - 16} 格）`);

console.log('\n[4] SVG 路径覆盖是不是完整：');
const { path: d, size } = qrLogin.toPath(qr);
if (size !== n + 8) err(`静区不对：size=${size}，应为 ${n}+8=${n + 8}（四周各留 4 模块）`);
else ok(`四周各留 4 模块静区（size ${size} = ${n} + 8）`);

/* 把 path 还原成"哪些格子是黑的"，和矩阵逐格比对。
   path 的写法是 M x y h宽 v1 h-宽 z —— 每个 M 是一条横向黑段。 */
const painted = new Set();
let segs = 0;
for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
  const x = +m[1], y = +m[2], w = +m[3];
  segs++;
  for (let i = 0; i < w; i++) painted.add((y - 4) + ',' + (x - 4 + i));
}
let darkCount = 0;
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) darkCount++;
if (painted.size !== darkCount) {
  err(`path 画了 ${painted.size} 个黑格，矩阵里有 ${darkCount} 个 —— 有漏画或多画`);
} else if (segs === 0) {
  err('path 里没有任何一段（生成失败）');
} else {
  ok(`${darkCount} 个黑格全部画到（合并成 ${segs} 段横向条，省了 ${darkCount - segs} 段）`);
}

/* 逐格核对：path 画出来的每一格，矩阵里都必须是黑的。
   ⚠ 必须先判越界再问矩阵 —— 库的 isDark() 在行列越界时是 **throw** 而不是返回 false，
     直接传进去会抛一个 "49,0" 这种莫名其妙的字符串，把自检本身搞崩。
     （2026-11-02 做判别力测试时踩到：代码下移一格，自检崩了而不是报错。） */
let mismatch = 0;
for (const key of painted) {
  const [r, c] = key.split(',').map(Number);
  if (r < 0 || r >= n || c < 0 || c >= n) { mismatch++; continue; }
  if (!qr.isDark(r, c)) mismatch++;
}
if (mismatch) err(`path 有 ${mismatch} 格画在了"白格"或矩阵外面`);
else ok('path 覆盖的每一格都对应矩阵里的黑格');

console.log(fail ? `\n二维码自检未通过 ❌（${fail} 处）\n` : '\n二维码自检全部通过 ✅\n');
process.exit(fail ? 1 : 0);
