/* 静态自检：不依赖浏览器，纯文本交叉校验，确保不会出现"取到 null 元素就崩"之类的运行期问题。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 检查前先把注释挖掉，只留下"真正会跑起来的代码"。
   否则注释里举例说明用的字符（比如"以前这里是 🔍，现在换成 SVG"）
   会被当成真代码误报 —— 这类误报最消耗信任。
   注意：挖空时保留换行符，否则报告出来的行号会全部错位。 */
const blankKeepLines = (m) => m.replace(/[^\n]/g, ' ');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, blankKeepLines);
const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blankKeepLines);

const html = stripHtml(read('src/ui/index.html'));
const css = stripBlock(read('src/ui/style.css'));
const appjs = stripBlock(read('src/ui/app.js'));
const preload = stripBlock(read('src/preload.js'));
const mainjs = stripBlock(read('src/main.js'));

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

/* ---- 7) 图标：每个 <use href="#i-xxx"> 都能找到 <symbol id="i-xxx"> ---- */
console.log('\n[6] 图标引用是否都能找到定义：');
const symbols = new Set([...html.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1]));
const usedIcons = new Set([
  ...html.matchAll(/<use\s+href="#([^"]+)"/g).map((m) => m[1]),
  ...appjs.matchAll(/ic\(\s*'([^']+)'/g).map((m) => m[1]),
  // 三元里写的图标名（如 ic(v === 0 ? 'i-vol-x' : ...)）也要捞出来
  ...appjs.matchAll(/'(i-[\w-]+)'/g).map((m) => m[1]),
]);
const iconMissing = [...usedIcons].filter((n) => !symbols.has(n));
if (iconMissing.length) iconMissing.forEach((n) => err(`用了图标 #${n}，但图标库里没有 <symbol id="${n}">`));
else ok(`全部 ${usedIcons.size} 个图标引用都能找到定义`);
const iconUnused = [...symbols].filter((n) => !usedIcons.has(n));
if (iconUnused.length) console.log(`  · 提示：图标库里这些暂时没人用 → ${iconUnused.join(', ')}`);

/* ---- 8) 自绘标题栏：CSS 高度必须等于主进程 titleBarOverlay 的高度 ---- */
console.log('\n[7] 自绘标题栏一致性：');
const cssTbH = (css.match(/--titlebar-h:\s*(\d+)px/) || [])[1];
const jsTbH = (mainjs.match(/titleBarOverlay:\s*\{[\s\S]*?height:\s*(\d+)/) || [])[1];
if (!cssTbH) err('style.css 里找不到 --titlebar-h');
else if (!jsTbH) err('main.js 里找不到 titleBarOverlay.height');
else if (cssTbH !== jsTbH) err(`--titlebar-h=${cssTbH}px，但 titleBarOverlay.height=${jsTbH}px —— 两者必须一致，否则系统按钮会和标题栏错位`);
else ok(`标题栏高度两处一致（${cssTbH}px）`);

const tbRule = (css.match(/\.titlebar\s*\{[\s\S]*?\n\}/) || [''])[0];
if (!/app-region:\s*drag/.test(tbRule)) err('.titlebar 少了 -webkit-app-region: drag —— 窗口会拖不动（标题栏藏起来后就没有别的拖动区了）');
else ok('.titlebar 是拖动区，窗口能拖着走');

const tbHtml = (html.match(/<header class="titlebar">[\s\S]*?<\/header>/) || [''])[0];
if (/<button|<input|<a\s/.test(tbHtml)) err('.titlebar 里放了可点击元素 —— drag 会让它们点不动（应给该元素单独加 no-drag）');
else ok('.titlebar 里只有装饰内容，没有会被 drag 吃掉点击的控件');

if (!/titleBarStyle:\s*'hidden'/.test(mainjs)) err("main.js 没有 titleBarStyle: 'hidden' —— 系统那条白色标题栏还在");
else ok("main.js 已设置 titleBarStyle: 'hidden'（系统标题栏已隐藏）");

/* ---- 9) 界面里不该再出现彩色 emoji ---- */
console.log('\n[8] 彩色 emoji 残留检查：');
/* 这些字符在 Windows 上会被 Segoe UI Emoji 接管，渲染成五颜六色的小方块。
   箭头（← →）和几个常见符号（★ ✕ ✓）是例外：它们在 Windows 上是单色的，留着无妨。
   范围说明：1F000-1FAFF 图形符号 / 2600-27BF 杂项+装饰 / 2B00-2BFF / 25A0-25FF 几何图形
   / 23E9-23FF 媒体控制键 / FE0F 变体选择符（它的作用就是"强制彩色"）。 */
const OK_SYMBOLS = new Set(['★', '✕', '✓', '⏻']);
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{23E9}-\u{23FF}\u{FE0F}]/gu;
function findEmoji(text, label) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const ch of line.match(EMOJI_RE) || []) {
      if (!OK_SYMBOLS.has(ch)) hits.push(`${label}:${i + 1} 出现 "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase()})`);
    }
  });
  return hits;
}
const emojiHits = [...findEmoji(html, 'index.html'), ...findEmoji(appjs, 'app.js'), ...findEmoji(css, 'style.css')];
if (emojiHits.length) emojiHits.forEach((h) => err(`彩色 emoji 残留 → ${h}`));
else ok('界面里已没有任何彩色 emoji（图标全部走 SVG）');

/* ---- 10) 主题色是否真的"渗透"进了背景与边框（而不只是点缀色） ---- */
console.log('\n[9] 主题色是否渗透进背景与边框：');
const lineDef = (css.match(/--line:\s*([^;]+);/) || [])[1] || '';
if (!/var\(\s*--accent/.test(lineDef)) err('--line 没有引用 var(--accent) —— 分隔线/卡片边框不会跟着主题变色');
else ok(`边框 --line 跟着主色走（${lineDef.trim()}）`);

const tbBgDef = (css.match(/--titlebar-bg:\s*([^;]+);/) || [])[1] || '';
if (!/var\(\s*--accent/.test(tbBgDef)) err('--titlebar-bg 没有引用 var(--accent) —— 标题栏不会跟着主题变色');
else ok(`标题栏底色 --titlebar-bg 跟着主色走（${tbBgDef.trim()}）`);

const tbBgUsed = /\.titlebar\s*\{[\s\S]*?background:\s*var\(\s*--titlebar-bg\s*\)/.test(css);
if (!tbBgUsed) err('.titlebar 没有用 var(--titlebar-bg)，标题栏底色没接上');
else ok('.titlebar 用上了 --titlebar-bg');

/* ---- 11) 标题栏按钮颜色链路（preload → main → 调用 setTitleBarOverlay） ---- */
console.log('\n[10] 标题栏按钮跟随主题的链路：');
if (!preloadMap['setTitlebarTheme']) err('preload 没有暴露 setTitlebarTheme');
else if (!handlers.has('theme:overlay')) err("main.js 没有 handle('theme:overlay')");
else ok('换主题时主色经 setTitlebarTheme → theme:overlay 传到主进程');

if (!/setTitleBarOverlay/.test(mainjs)) err('main.js 从未调用 setTitleBarOverlay —— 按钮颜色不会更新');
else ok('main.js 会在换主题时重设 setTitleBarOverlay');

/* ---- 汇总 ---- */
console.log('\n========================================');
if (fail === 0) console.log('全部静态自检通过 ✅（共 10 大类检查）');
else { console.log(`发现 ${fail} 处问题 ❌`); process.exit(1); }
