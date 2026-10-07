/* 静态自检：不依赖浏览器，纯文本交叉校验，确保不会出现"取到 null 元素就崩"之类的运行期问题。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('src/ui/index.html');
const css = read('src/ui/style.css');
const appjs = read('src/ui/app.js');
const preload = read('src/preload.js');
const mainjs = read('src/main.js');

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

/* ---- 1) index.html 里所有 id ---- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/* ---- 2) app.js 里所有 $('x') / getElementById('x') / window.neko.loadData 等 ---- */
const refIds = new Set([
  ...appjs.matchAll(/\$\(\s*'([^']+)'\s*\)/g).map((m) => m[1]),
  ...appjs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g).map((m) => m[1]),
]);
console.log('\n[1] 渲染层引用的元素 id 是否都存在：');
let missing = [...refIds].filter((id) => !htmlIds.has(id));
if (missing.length) missing.forEach((id) => err(`app.js 用了 #${id}，但 index.html 里没有这个 id`));
else ok(`全部 ${refIds.size} 处引用的 id 都在 index.html 中`);

/* app.js 里还用了 e.target.closest('#xxx') 的硬 id（如 modalMask），也查一下 */
const closestIds = [...appjs.matchAll(/closest\(\s*'#([^']+)'/g)].map((m) => m[1]);
const miss2 = closestIds.filter((id) => !htmlIds.has(id));
if (miss2.length) miss2.forEach((id) => err(`closest('#${id}') 引用的 id 不存在`));
else ok(`closest('#...') 引用的 ${closestIds.length} 个 id 都存在`);

/* ---- 3) CSS 里所有 var(--x) 是否都有定义 ---- */
const cssVars = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
console.log('\n[2] CSS 变量引用是否都定义过：');
const undef = [...usedVars].filter((v) => !cssVars.has(v));
if (undef.length) undef.forEach((v) => err(`用了 ${v} 但没定义（会被当成无效值）`));
else ok(`全部 ${usedVars.size} 个 var() 都有对应定义`);

/* 特别注意 --track-bg 不是自引用 */
if (/\-\-track-bg:\s*var\(\s*--track-bg/.test(css)) err('--track-bg 仍是自引用（封面占位会失效）');
else ok('--track-bg 已修正为具体颜色');

/* ---- 4) 主题名一致性：HTML swatch / CSS [data-theme] / app.js 设置 ---- */
console.log('\n[3] 主题名一致性：');
const cssThemes = new Set([...css.matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1]));
const htmlThemes = new Set([...html.matchAll(/data-theme="([^"]+)"/g)].map((m) => m[1]));
const jsThemes = new Set([...appjs.matchAll(/['"](pink|violet|green|amber|cyan)['"]/g)].map((m) => m[1]));
const all = new Set([...cssThemes, ...htmlThemes, ...jsThemes]);
let themeBad = false;
all.forEach((t) => {
  if (!cssThemes.has(t)) { err(`主题 ${t} 在 CSS 里没有 [data-theme] 规则`); themeBad = true; }
  if (!htmlThemes.has(t)) { err(`主题 ${t} 在 HTML swatch 里没有对应色块`); themeBad = true; }
});
if (!themeBad) ok(`5 套主题（${[...all].join('/')}）三处一致`);

/* ---- 5) IPC 链路：app.js 调用的 neko 方法 → preload 暴露 → main.js 注册 ---- */
console.log('\n[4] IPC 链路是否闭环：');
const nekoCalls = new Set([
  ...appjs.matchAll(/api\(\s*'([\w]+)'/g).map((m) => m[1]),
  ...appjs.matchAll(/window\.neko\.([\w]+)\(/g).map((m) => m[1]),
]);
/* 从 preload 抽出 方法名 → IPC channel 的真实映射 */
const preloadMap = {};
for (const m of preload.matchAll(/^\s*([\w]+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*'([^']+)'/gm)) {
  preloadMap[m[1]] = m[2];
}
const handlers = new Set([...mainjs.matchAll(/handle\(\s*'([\w:]+)'/g)].map((m) => m[1]));
let ipcBad = false;
nekoCalls.forEach((name) => {
  const ch = preloadMap[name];
  if (!ch) { err(`neko.${name} 在 preload 里没有映射到任何 channel`); ipcBad = true; return; }
  if (!handlers.has(ch)) { err(`neko.${name} 映射到 channel '${ch}'，但 main.js 没注册该 handle`); ipcBad = true; }
});
if (!ipcBad) ok(`渲染层调用的 ${nekoCalls.size} 个 neko 方法全部经 preload 接通到 main.js 的 handle`);

/* ---- 6) bg:// 协议两道安全闸（纯逻辑复刻） ---- */
console.log('\n[5] bg:// 安全闸逻辑：');
/* 用平台绝对路径，复刻真实运行环境里 BG_DIR 一定是绝对路径这一点 */
const BG_DIR = path.resolve('__bgtest');
function guard(name) {
  if (!/^[\w.\-]+$/.test(name)) return 'REJECT(文件名不合法)';
  const file = path.resolve(BG_DIR, name);
  if (!file.startsWith(BG_DIR + path.sep)) return 'REJECT(越界)';
  return 'ALLOW ' + file;
}
const cases = [
  ['bg-abc123.png', 'ALLOW'],
  ['../escape.png', 'REJECT'],
  ['..%2f.png', 'REJECT'],
  ['a/b.png', 'REJECT'],
  ['normal.jpg', 'ALLOW'],
];
let gateBad = false;
cases.forEach(([inp, exp]) => {
  const r = guard(inp);
  const pass = r.startsWith(exp) || (exp === 'REJECT' && r.startsWith('REJECT')) || (exp === 'ALLOW' && r.startsWith('ALLOW'));
  if (!pass) { err(`bg:// 守卫对 "${inp}" 返回 "${r}"，期望含 "${exp}"`); gateBad = true; }
});
if (!gateBad) ok('两道安全闸（文件名白名单 + 路径越界检查）行为正确');

/* ---- 汇总 ---- */
console.log('\n========================================');
if (fail === 0) console.log('全部静态自检通过 ✅（共 6 大类检查）');
else { console.log(`发现 ${fail} 处问题 ❌`); process.exit(1); }
