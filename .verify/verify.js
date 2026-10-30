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
/* 行注释也要挖掉：说明文字里可能提到别的函数名 / 旧写法，
   不挖就会把注释当代码 → 误报（假阳性）。挖的时候同样保留换行。 */
const stripLine = (s) => s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const html = stripHtml(read('src/ui/index.html'));
const css = stripBlock(read('src/ui/style.css'));
const rawAppjs = read('src/ui/app.js');
const appjs = stripLine(stripBlock(rawAppjs));
const preload = stripBlock(read('src/preload.js'));
const mainjs = stripBlock(read('src/main.js'));
const winmini = stripBlock(read('src/win-mini.js'));
const bgproto = stripBlock(read('src/bg-protocol.js'));
/* v2.2.0 新增的三个模块 + main.js 的"去行注释"版本。
   ★ 为什么 main.js 要多一份去行注释的：新加的断言要查 setThumbnailClip / hide() /
     `const s = {` 这类片段，而注释里正好会举例提到它们 —— 不挖掉就会把注释当代码（假阳性）。 */
const appmenus = stripLine(stripBlock(read('src/app-menus.js')));
const storemigrate = stripLine(stripBlock(read('src/store-migrate.js')));
const mainCode = stripLine(stripBlock(read('src/main.js')));
const gitignore = read('.gitignore');
/* v2.8.0 新增的两个模块。同样用"去注释"版本 —— 它们的注释里会大量提到
   `local://get` / 白名单 / Range 这些词，不去注释就会把说明文字当成代码（假阳性）。 */
const downloaderjs = stripLine(stripBlock(read('src/downloader.js')));
const localproto  = stripLine(stripBlock(read('src/local-protocol.js')));
/* v2.12.0：AI 歌词。ai-lyrics.js 的注释里会大量提到 safeStorage / 明文 / response_format
   这些词，不去注释就会把说明文字当成代码（假阳性），所以用"去注释"版本。 */
const ailyrics    = stripLine(stripBlock(read('src/ai-lyrics.js')));
const preloadCode = stripLine(stripBlock(read('src/preload.js')));

/* ---- v2.3.0：KEY_ACTIONS 那张表（快捷键的唯一准绳）----
   以前断言是直接找 `ctrl && (e.key === 'd' ...)` 这种字面量；
   改成表驱动之后字面量没了，所以改成"从表里把默认键读出来对"。 */
const keyTableSrc = (appjs.match(/const KEY_ACTIONS = \[([\s\S]*?)\n\];/) || [])[1] || '';
function keyDefOf(id) {
  const m = keyTableSrc.match(new RegExp("id:\\s*'" + id + "'[\\s\\S]{0,160}?def:\\s*'([^']*)'"));
  return m ? m[1] : '';
}

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
/* app.js 自己用 innerHTML 生成的元素（比如小弹窗里的输入框、按钮）也算"存在"——
   它们不在静态 HTML 里，是运行时拼出来的，但同样是可以 $() 到手的。
   不把这类算上，就会误报"引用了不存在的 id"（假阳性）。 */
const runtimeIds = new Set([...appjs.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

console.log('\n[1] 渲染层引用的元素 id 是否都存在：');
let missing = [...refIds].filter((id) => !htmlIds.has(id) && !runtimeIds.has(id));
if (missing.length) missing.forEach((id) => err(`app.js 用了 #${id}，但 index.html 里没有这个 id`));
else ok(`全部 ${refIds.size} 处引用的 id 都在 index.html 或 app.js 动态生成的元素里`);

/* app.js 里还用了 e.target.closest('#xxx') 的硬 id（如 modalMask），也查一下 */
const closestIds = [...appjs.matchAll(/closest\(\s*'#([^']+)'/g)].map((m) => m[1]);
const miss2 = closestIds.filter((id) => !htmlIds.has(id));
if (miss2.length) miss2.forEach((id) => err(`closest('#${id}') 引用的 id 不存在`));
else ok(`closest('#...') 引用的 ${closestIds.length} 个 id 都存在`);

/* ---- 3) CSS 里所有 var(--x) 是否都有定义 ---- */
const cssVars = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
/* ★ v2.8.0：有一类变量是**运行时由 JS 填进行内 style** 的（比如环形进度的 --p），
   它们本来就不该在 CSS 里出现定义。把这类单独认出来：
   只从 `style="..."` 这种行内写法里取，别把 app.js 里普通字符串中的 `--x:` 也算上。
   ★ 白名单是"从真实的赋值处"推出来的，所以拼错的名字（CSS 写 var(--pp)、JS 写 --p）
     仍然会被下面这条查出来 —— 这正是它还有判别力的原因。 */
const inlineVars = new Set();
for (const m of appjs.matchAll(/style="([^"]*)"/g)) {
  for (const v of m[1].matchAll(/(--[\w-]+)\s*:/g)) inlineVars.add(v[1]);
}
console.log('\n[2] CSS 变量引用是否都定义过：');
const undef = [...usedVars].filter((v) => !cssVars.has(v) && !inlineVars.has(v));
if (undef.length) undef.forEach((v) => err(`用了 ${v} 但没定义（会被当成无效值）`));
else ok(`全部 ${usedVars.size} 个 var() 都有对应定义（其中 ${inlineVars.size} 个由 JS 运行时填行内值）`);

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
/* 从 preload 抽出三类桥：invoke（请求-响应）/ send（单向通知主进程）/ on（订阅主进程推送） */
const preloadInvoke = {};
const preloadSend = {};
const preloadOn = {};
for (const m of preload.matchAll(/^\s*([\w]+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*'([^']+)'/gm)) preloadInvoke[m[1]] = m[2];
for (const m of preload.matchAll(/^\s*([\w]+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.send\(\s*'([^']+)'/gm))   preloadSend[m[1]]   = m[2];
for (const m of preload.matchAll(/^\s*([\w]+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.on\(\s*'([^']+)'/gm))     preloadOn[m[1]]     = m[2];
const handlers = new Set([...mainjs.matchAll(/handle\(\s*'([\w:]+)'/g)].map((m) => m[1]));
const onHandlers = new Set([...mainjs.matchAll(/ipcMain\.on\(\s*'([\w:-]+)'/g)].map((m) => m[1]));
const allChannels = new Set([...handlers, ...onHandlers]);
let ipcBad = false;
nekoCalls.forEach((name) => {
  const ch = preloadInvoke[name] || preloadSend[name] || preloadOn[name];
  if (!ch) { err(`neko.${name} 在 preload 里没有映射到任何 channel`); ipcBad = true; return; }
  if (preloadOn[name]) return; // 订阅型：主进程主动推，不需要渲染端 handler，跳过
  if (!allChannels.has(ch)) { err(`neko.${name} 映射到 channel '${ch}'，但 main.js 没注册该 handle/on`); ipcBad = true; }
});
if (!ipcBad) ok(`渲染层调用的 ${nekoCalls.size} 个 neko 方法全部经 preload 接通到 main.js`);

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
  // 运行时通过 setAttribute('href', '#i-xxx') 切换的图标也要算上
  ...appjs.matchAll(/#(i-[\w-]+)/g).map((m) => m[1]),
]);
const iconMissing = [...usedIcons].filter((n) => !symbols.has(n));
if (iconMissing.length) iconMissing.forEach((n) => err(`用了图标 #${n}，但图标库里没有 <symbol id="${n}">`));
else ok(`全部 ${usedIcons.size} 个图标引用都能找到定义`);
const iconUnused = [...symbols].filter((n) => !usedIcons.has(n));
if (iconUnused.length) console.log(`  · 提示：图标库里这些暂时没人用 → ${iconUnused.join(', ')}`);

/* ---- 8) 自绘标题栏：高度、拖动区、系统按钮已隐藏 ---- */
console.log('\n[7] 自绘标题栏一致性：');
if (!/--titlebar-h:\s*\d+px/.test(css)) err('style.css 里找不到 --titlebar-h（标题栏高度没定义，布局会乱）');
else ok('.titlebar 有高度变量 --titlebar-h');

const tbRule = (css.match(/\.titlebar\s*\{[\s\S]*?\n\}/) || [''])[0];
if (!/app-region:\s*drag/.test(tbRule)) err('.titlebar 少了 -webkit-app-region: drag —— 窗口会拖不动（标题栏藏起来后就没有别的拖动区了）');
else ok('.titlebar 是拖动区，窗口能拖着走');

// 标题栏里放了自绘按钮（最小化/最大化/关闭），它们必须用 .win-controls 包起来并标 no-drag，
// 否则会被 drag 区域吃掉点击。这里静态确认：按钮存在 + no-drag 存在。
const tbHtml = (html.match(/<header class="titlebar">[\s\S]*?<\/header>/) || [''])[0];
const hasBtns = /class="win-controls"/.test(tbHtml);
if (/<button|<input|<a\s/.test(tbHtml) && !hasBtns) err('.titlebar 里有可点击元素，但没用 .win-controls 包起来 —— 会被 drag 吃掉点击');
else if (/<button|<input|<a\s/.test(tbHtml) && !/no-drag/.test(css)) err('.titlebar 里有可点击按钮，但 CSS 里找不到 no-drag —— 按钮会点不动');
else if (hasBtns) ok('.titlebar 里的自绘按钮在 .win-controls 中（已标 no-drag），点击不会被拖动区吃掉');
else ok('.titlebar 里只有装饰内容');

if (!/titleBarStyle:\s*'hidden'/.test(mainjs)) err("main.js 没有 titleBarStyle: 'hidden' —— 系统那条白色标题栏还在");
else ok("main.js 已设置 titleBarStyle: 'hidden'（系统标题栏已隐藏）");

// 关键：不能配 titleBarOverlay，否则 Windows 又会把系统按钮画回来（正是之前用户吐槽的"深色方块"）
// 只在它作为"真正的配置项"（titleBarOverlay: ...）或调用（setTitleBarOverlay(）时才算数，注释里提到不算。
if (/\btitleBarOverlay\s*[:\(]/.test(mainjs)) err('main.js 还配了 titleBarOverlay —— Windows 会重新画出系统按钮，和我们的自绘按钮重叠');
else ok("main.js 没有配 titleBarOverlay（系统按钮彻底消失，只剩我们的自绘按钮）");

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

const tbRuleNow = (css.match(/\.titlebar\s*\{[\s\S]*?\n\}/) || [''])[0];
if (!/backdrop-filter/.test(tbRuleNow)) err('.titlebar 没有 backdrop-filter —— 顶栏不是磨砂玻璃');
// 底色必须是半透明的 --glass-rgb（斜杠语法）。别写回 rgba(var(--glass-rgb), …) ——
// 那是非法混搭，整条声明会被 Chromium 丢掉，顶栏会变成完全透明。
else if (!/rgb\(\s*var\(\s*--glass-rgb\s*\)\s*\//.test(tbRuleNow)) err('.titlebar 不是半透明玻璃底（太实、会显得暗）');
else ok('.titlebar 是半透明磨砂玻璃，且能透出背景主题色');

/* ---- 11) 自绘窗口按钮的 IPC 链路（界面 → preload.send → main.ipcMain.on） ---- */
console.log('\n[10] 自绘窗口按钮的 IPC 链路：');
const winApi = ['winMin', 'winMax', 'winClose'];
const winCh = {};
let winBad = false;
winApi.forEach((name) => {
  const ch = preloadSend[name];
  if (!ch) { err(`neko.${name} 在 preload 里没映射到 send channel`); winBad = true; return; }
  if (!onHandlers.has(ch)) { err(`neko.${name} → '${ch}'，但 main.js 没用 ipcMain.on 注册`); winBad = true; }
  winCh[name] = ch;
});
// 这三个按钮的 id 必须都存在于 index.html
['winMin', 'winMax', 'winClose'].forEach((id) => {
  if (!htmlIds.has(id)) { err(`index.html 里没有 #${id} 按钮`); winBad = true; }
});
// 最大化/还原切换：主进程要能主动把状态推回界面
if (!/onWinState/.test(preload)) err('preload 没有暴露 onWinState（界面收不到最大化/还原状态）');
else if (!/webContents\.send\(\s*'win:state'/.test(mainjs)) err("main.js 没有 webContents.send('win:state') —— 图标不会在最大化/还原间切换");
else ok('主进程在最大化/还原时会通知界面（onWinState 已接通），图标能切换');

if (!winBad) ok(`自绘窗口按钮 ${winApi.length} 个经 preload.send 接通到 main.js 的 ipcMain.on（${winApi.map((n) => winCh[n]).join(' / ')}）`);

/* ---- 12) 歌词：失败原因必须能传回界面（否则一律显示"获取失败"） ---- */
console.log('\n[11] 歌词失败原因的传递链路：');
/* 主进程 handle() 统一包了 {ok, error}，必须额外把 err.reason 带出去，
   界面才能区分"没填Cookie / 没字幕 / 被限流"这三种完全不同的提示。 */
if (!/reason:\s*err\.reason/.test(mainjs)) err("handle() 包装器没有把 err.reason 传回界面 —— 所有歌词失败都会显示同一句废话");
else ok('主进程把 reason 透传给界面（能区分失败原因）');

/* bilibili.js 必须区分三种 reason，且把"限流造成的假空"单列出来——
   这两种"空"含义完全不同，混在一起会让界面误报"这歌没字幕"。 */
const biliSrc = read('src/bilibili.js');
const reasons = [...biliSrc.matchAll(/e\.reason\s*=\s*'(\w[\w-]*)'/g)].map((m) => m[1]);
['no-cookie', 'none', 'limit'].forEach((r) => {
  if (!reasons.includes(r)) err(`bilibili.js 里没有 reason='${r}'，界面会显示错误的提示文案`);
});
if (reasons.includes('limit')) ok(`getSubtitle 区分了失败原因（${[...new Set(reasons)].join(' / ')}）`);

/* "假残缺"必须被判成限流，而不是当成"没字幕" —— 这是两个完全不同的现象 */
if (!/body\.length\s*===\s*0[\s\S]*?reason\s*=\s*'limit'/.test(biliSrc)) {
  err("getSubtitle 没有识别'轨道非空但下载为空'的限流假象 —— 会误报成'这歌没字幕'");
} else ok('识别了"轨道存在但内容为空"的限流假象（不会误报成没字幕）');

/* ---- 13) 歌词 UI 要素 ---- */
console.log('\n[12] 歌词界面要素：');
['btnLyric', 'lyricTip', 'lyricOverlay', 'lyricBox', 'chkAutoLyric', 'btnLyricClose'].forEach((id) => {
  if (!htmlIds.has(id)) err(`index.html 里缺少 #${id}`);
});
if (['btnLyric', 'lyricTip', 'lyricOverlay', 'lyricBox', 'chkAutoLyric', 'btnLyricClose'].every((id) => htmlIds.has(id))) {
  ok('「词」按钮 / 提示气泡 / 歌词大屏 / 自动开关 都在页面里');
}
/* 没有字幕时提示要能"淡出消散"，所以必须有 .show 状态 + transition */
const tipRule = (css.match(/\.lyric-tip\s*\{[\s\S]*?\n\}/) || [''])[0];
if (!/transition/.test(tipRule) || !/\.lyric-tip\.show/.test(css)) err('.lyric-tip 缺少 transition 或 .show 状态 —— 提示不会淡出消散');
else ok('.lyric-tip 有淡入淡出动画（提示会慢慢消散）');

/* 大屏必须避开侧边栏/标题栏/播放条，否则会盖住它们 */
const ovRule = (css.match(/\.lyric-overlay\s*\{[\s\S]*?\n\}/) || [''])[0];
if (!/var\(--sidebar-w\)/.test(ovRule) || !/var\(--titlebar-h\)/.test(ovRule)) {
  err('.lyric-overlay 没有用布局变量定位 —— 可能盖住侧边栏/标题栏/播放条');
} else ok('歌词大屏精确避开侧边栏 / 标题栏 / 播放条');

/* 换歌时必须清掉上一首歌词，否则会出现"这首歌的词配那首歌的音" */
if (!/function resetLyricsOnTrackChange/.test(appjs)) err('app.js 里没有 resetLyricsOnTrackChange() —— 换歌后歌词不会被清掉');
else if (!/resetLyricsOnTrackChange\(\)/.test(appjs.split('function resetLyricsOnTrackChange')[0])) {
  err('resetLyricsOnTrackChange() 定义了却从没被调用 —— 换歌后旧歌词会残留');
} else ok('换歌时会清掉上一首的歌词');

/* 自动歌词开关必须真的连着存档字段，而不是写死。
   ★ v2.2.0：主进程那半边的"补洞"搬到了 src/store-migrate.js，所以这里改查那个文件。 */
if (!/autoLyric/.test(appjs) || !/autoLyric/.test(storemigrate)) err('autoLyric 没贯穿 界面↔ 主进程存档 —— 开关关掉后再开软件会丢');
else ok('自动歌词开关会存进存档（重启后还记得）');

/* ---- 14) 字幕必须走 api() 解包（这是个真实踩过的坑） ---- */
console.log('\n[13] 字幕结果解包：');
/* 主进程统一返回 {ok, data}。如果绕开 api() 直连 preload，
   res.lines 恒为 undefined → 不管成功失败都显示"（没有歌词）"却提示"歌词已加载"。 */
const rawSubtitleCall = (appjs.split('//')[0] + appjs.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'));
if (/window\.neko\.subtitle\(/.test(rawSubtitleCall)) {
  err('loadLyrics 绕开了 api() 直连 preload —— 没解 {ok,data} 外壳，失败会被误报成"歌词已加载"');
} else if (!/api\(\s*'subtitle'/.test(appjs)) {
  err("loadLyrics 没有通过 api('subtitle', ...) 取歌词 —— 拿不到数据也不会抛错");
} else ok('字幕经 api() 解包（失败会真的抛错，不会误报成功）');

/* reason 必须一路传到界面，否则 no-cookie/none/limit 全都退化成同一句提示 */
if (!/if\s*\(res\.reason\)\s*e\.reason\s*=\s*res\.reason/.test(appjs)) {
  err("api() 没把 reason 带进抛出的 Error —— '没填Cookie/没字幕/被限流' 会显示成同一句话");
} else ok('失败原因（reason）能传到界面，三种情况分别提示');

/* 用户很可能从开发者工具的「Cookie Value」列复制，只有一段值、没有 SESSDATA= 前缀 */
if (!/function setUserCookie[\s\S]*?!\/=\/\.test\(t\)/.test(biliSrc)) {
  err('setUserCookie 没处理"只有值、没有 SESSDATA= 前缀"的粘贴 —— 用户填了却等于没填，字幕永远拿不到');
} else ok('粘贴纯 Cookie 值（无 SESSDATA= 前缀）也能识别');

/* ---- 26) 发现页 ---- */
console.log('\n[25] 发现页：');
const navBlock = (html.match(/<nav class="nav" id="nav">([\s\S]*?)<\/nav>/) || [])[1] || '';
// 侧栏已去掉「搜索」入口（它点进去只是一句占位提示，而顶部搜索栏随时能搜）；
// 现在要求：侧栏没有 search 项，且第一项是「发现」。
const firstView = (navBlock.match(/data-view="([^"]+)"/) || [])[1];
if (/data-view="search"/.test(navBlock)) {
  err('侧边栏又出现了「搜索」入口（本轮已按用户要求去掉）');
} else if (firstView !== 'discovery') {
  err(`侧边栏第一项不是「发现」（现在是 ${firstView}）`);
} else ok('侧边栏无「搜索」入口，且「发现」排在第一');
if (!/const DISCOVERY_KEYWORDS = \['歌曲', '音乐'\]/.test(appjs) || !/api\('search', keyword, 1\)/.test(appjs)) {
  err('发现页没有通过现有搜索 API 查询「歌曲」和「音乐」');
} else ok('发现页通过现有搜索 API 查询歌曲与音乐');
if (!/discoverySearchCache = new Map\(\)/.test(appjs) || !/unique\.has\(track\.bvid\)/.test(appjs) || !/pool\.slice\(0, DISCOVERY_SIZE\)/.test(appjs)) {
  err('发现页缺少会话搜索缓存、bvid 去重或随机展示数量限制');
} else ok('发现页有会话内缓存、bvid 去重与最多 12 条抽样');
if (!/id="btnRefreshDiscovery"/.test(appjs) || !/function renderDiscovery/.test(appjs) || !/发现失败：/.test(appjs) || !/正在为你发现音乐/.test(appjs)) {
  err('发现页缺少刷新或加载 / 空 / 错误状态 UI');
} else ok('发现页有刷新按钮及加载、空、错误状态');
if (!/currentView === 'discovery'\) return discoveryResults/.test(appjs) || !/id === 'btnPlayDiscovery'/.test(appjs)) {
  err('发现页曲目没有接入当前播放列表与播放全部行为');
} else ok('发现页曲目接入播放、收藏与歌单交互');

/* ---- 27) 本地记忆与分享隐私 ---- */
console.log('\n[26] 本地记忆与分享隐私：');
if (!/app\.setPath\('userData',\s*STABLE_USER_DATA_DIR\)/.test(mainjs) || !/path\.join\(app\.getPath\('appData'\),\s*'neko-music'\)/.test(mainjs)) {
  err('userData 没固定到 %APPDATA%\\neko-music —— 开发版与安装版可能读写不同目录');
} else ok('本地数据目录固定在 %APPDATA%\\neko-music');
if (!/function migrateKnownUserFiles\(\)/.test(mainjs) || !/if \(!fs\.existsSync\(to\) && fs\.existsSync\(from\)\) fs\.copyFileSync/.test(mainjs) || !/fs\.cpSync\(oldBg, newBg/.test(mainjs)) {
  err('旧用户数据迁移缺失 —— 固定目录后可能读不到原有存档 / Cookie / 背景');
} else ok('旧存档、Cookie、背景仅复制到稳定目录，不覆盖也不删除原文件');
/* ★ 存档读写的真凶：store:load / store:save 返回的是 {ok, data} 外壳。
   界面若直接调 window.neko.loadData() 而不走 api() 解包，DB 会变成外壳对象，
   DB.settings 是 undefined —— 每次启动都读不到存档、全变默认，"设置像从没保存过"。 */
/* 只看真正会跑的代码：verify 已挖掉块注释，但没挖 // 行注释，
   而上面的说明里正好举了 window.neko.loadData 这个反例，会误报。这里再滤掉整行 // 注释。 */
const appCode = appjs.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
if (/window\.neko\.(loadData|saveData)\(/.test(appCode)) {
  err('app.js 直接调 window.neko.loadData/saveData —— 拿到 {ok,data} 外壳，设置每次启动都被重置');
} else if (!/api\(\s*'loadData'/.test(appCode) || !/api\(\s*'saveData'/.test(appCode)) {
  err("存档读写没有走 api('loadData'/'saveData') —— 外壳没解包，设置与歌单无法持久化");
} else ok('存档读写都经 api() 解包（DB 不会变成 {ok,data} 外壳）');
if (!/mainWindow\.on\('close',[\s\S]*?requestMainWindowClose\(\)/.test(mainjs) || !/win:prepare-close/.test(preload) || !/flushPersistence\(\)[\s\S]*?closeReady\(saved\)/.test(appjs)) {
  err('关闭路径没有等待渲染端 flush 保存 —— 窗口关闭时 300ms 防抖写入可能丢失');
} else ok('关闭按钮 / Alt+F4 都等待最后一次存档成功再退出');
if (!/JSON\.parse\(JSON\.stringify\(DB\)\)/.test(appjs) || !/return false/.test(appjs) || !/toast\('本机保存失败：'/.test(appjs)) {
  err('保存没有快照 / 失败反馈 —— 用户仍可能无提示地丢失本机数据');
} else ok('保存使用快照，失败会给出可见提示（关窗失败也不会把窗口卡住）');
if (!/\.workbuddy\//.test(gitignore) || !/node_modules\//.test(gitignore) || !/同步到GitHub\.bat/.test(gitignore)) {
  err('Git 忽略规则没有排除项目记忆 / 依赖目录 / 本机同步脚本');
} else ok('Git 排除项目记忆、依赖目录与本机同步工具');
if (!/用户记忆[\s\S]*?本机 `%APPDATA%\\neko-music\\`[\s\S]*?不会随 Git 上传/.test(read('README.md'))) {
  err('README 缺少用户记忆留在本机、不随 Git 上传的说明');
} else ok('README 说明用户记忆留在本机应用目录且不随 Git 上传');

/* ---- 汇总 ---- */
console.log('\n========================================');

/* ---- 15) cid 必须校验（实测踩过的坑，最阴的一个） ---- */
console.log('\n[14] 字幕 cid 的权威性：');
/* 实测：/x/player/v2 只认 cid、无视 bvid。
   把 A 的 bvid 和 B 的 cid 拼一起请求，接口照样返回 code 0 并给出 B 的字幕，不报错。*/
if (!/pages\.find\(\s*\(p\)\s*=>\s*Number\(p\.cid\)\s*===\s*Number\(cid\)\s*\)/.test(biliSrc)) {
  err("getSubtitle 没校验 cid 是否属于该 bvid —— 一旦 cid 是旧的就会显示别的视频的歌词且不报错");
} else ok('getSubtitle 会核对 cid 是否属于该 bvid（旧 cid 自动纠正）');

/* 多 P 视频共用 bvid、各 P 的 cid 不同，所以不能无脑用第 1P */
if (/usedPage\s*=\s*pages\[0\]\s*;?\s*$/m.test(biliSrc) && !/usedPage\s*=\s*pages\.find/.test(biliSrc)) {
  err('getSubtitle 无条件用第 1P —— 多 P 视频会拿到错误那一P 的字幕');
} else if (!/if\s*\(usedPage\.page\s*>\s*1\)/.test(biliSrc)) {
  err('getSubtitle 没处理多 P 情况（标题里应标出 P几）');
} else ok('多 P 视频按实际 P 取字幕，不会错位到第 1P');

/* 取错了必须"看得见"，不能悄悄显示 —— 字幕来源标题要能警示 */
if (!htmlIds.has('lyricWarn')) err('index.html 里缺少 #lyricWarn（字幕来源不符时无法警示）');
else if (!/lyric-warn/.test(css)) err('style.css 里缺少 .lyric-warn 样式');
else if (!/videoTitle/.test(appjs)) err('app.js 没用 videoTitle 做来源核对');
else ok('字幕来源与当前歌曲不一致时会明确警示（不再静默取错）');

/* 警告行绝不能混进 .lyric-box —— syncLyric 按 children 下标对应歌词，混进去会整体错位 */
const warnRule = (css.match(/\.lyric-warn\s*\{[\s\S]*?\n\}/) || [''])[0];
if (/position:\s*absolute/.test(warnRule) === false) err('.lyric-warn 未独立定位，可能挤进歌词列表导致高亮错位');
else if (!/id="lyricWarn"[\s\S]{0,120}?class="lyric-box"|class="lyric-warn" id="lyricWarn"[\s\S]{0,80}?lyric-box/.test(html)) {
  err('#lyricWarn 与 #lyricBox 的相对位置不对 —— 警告必须在歌词容器之外');
} else ok('#lyricWarn 在 .lyric-box 之外（不会打乱歌词高亮下标）');

/* ---- 16) 旧路径被降级时会返回"别的视频的字幕"，必须缓存 + 检乱码 ---- */
console.log('\n[15] 异常字幕防护：');
/* 实测：旧接口降级时同一 cid 会随机返回 0/1/6 条轨道，内容是别的视频的文本
   （"今天我们要飞1500km"）。不防护就会显示别人的歌词。 */
if (!/subtitleCache\s*=\s*new Map\(\)/.test(biliSrc)) {
  err('getSubtitle 没有字幕结果缓存 —— 连点「词」会反复打 B 站');
} else if (!/SUBTITLE_TTL/.test(biliSrc)) {
  err('字幕缓存没有过期时间 —— 会永远返回旧歌词');
} else ok('字幕结果带 TTL 缓存（连点不再反复打 B 站，避免限流）');

if (!/uniq\.size\s*<\s*10/.test(biliSrc) || !/zhRatio\s*<\s*0\.2/.test(biliSrc)) {
  err("getSubtitle 没有乱码检测 —— 被限流时会照单全收显示成别人的歌词");
} else ok('检测乱码字幕（限流返回的他人内容会被判为 limit 而不是当成功）');

if (!/body\.length\s*===\s*0[\s\S]*?reason\s*=\s*'limit'/.test(biliSrc)) {
  err("getSubtitle 没有识别'轨道非空但内容为空'的限流假象");
} else ok('识别"轨道存在但内容为空"的限流假象（不会误报成没字幕）');

/* 实测：降级时 B 站会塞"别的视频的字幕"，甚至给不同视频返回同一份
   "♪ 音乐 ♪"占位。这些诱饵每次都不一样 → 靠重试 + 特征识别兜底。 */
if (!/DECOY_PATTERNS/.test(biliSrc)) {
  err('没有识别 B 站诱饵字幕的特征（如"♪ 音乐 ♪"占位）—— 会把别的视频的歌词当成功显示');
} else if (!/reason\s*=\s*'decoy'/.test(biliSrc)) {
  err("诱饵字幕没有被标成 reason='decoy'");
} else ok('能识别 B 站的诱饵字幕（♪音乐♪ 等占位内容）');

if (!/SUBTITLE_ATTEMPTS/.test(biliSrc) || !/attempt\s*<=\s*SUBTITLE_ATTEMPTS/.test(biliSrc)) {
  err('取字幕没有重试机制 —— 诱饵/限流时一次就放弃了，必然取错');
} else if (!/err\.reason\s*!==\s*'none'/.test(biliSrc)) {
  err("重试没有把 reason='none'（0 轨道）算进去 —— 实测限流时就会返回 0 轨道");
} else ok(`取字幕最多重试 ${(biliSrc.match(/SUBTITLE_ATTEMPTS\s*=\s*(\d+)/) || [])[1]} 次（含 0 轨道的情况）`);

/* ---- 17) 「打开视频」按钮 ---- */
console.log('\n[16] 打开 B 站视频：');
['btnOpenBili', 'btnLyric'].forEach((id) => {
  if (!htmlIds.has(id)) err(`index.html 里缺少 #${id}`);
});
if (!htmlIds.has('i-open-bili')) err('缺少 #i-open-bili 图标');
if (!/openExternal:\s*\(url\)/.test(preload)) err('preload 没有暴露 openExternal');
if (!/shell:open/.test(mainjs)) err("main.js 没有 handle('shell:open')");
if (!/api\(\s*'openExternal'/.test(appjs)) err('app.js 没有调用 openExternal');
if (/https?:\/\/\$\{/.test(mainjs) && !/\/\^https\?:\\\/\\\//i.test(mainjs)) {
  err('shell:open 没有校验协议 —— 可能被拿去打开本地文件（file://）');
}
if (htmlIds.has('btnOpenBili') && /api\(\s*'openExternal'/.test(appjs) && /shell:open/.test(mainjs)) {
  ok('播放条有「打开视频」按钮：默认浏览器打开，且只放行 http/https');
}

/* ---- 18) 字幕接口路径 + WBI 签名（"歌词张冠李戴"的真正根因） ---- */
console.log('\n[17] 字幕接口路径与 WBI 签名：');
/* 实测：旧路径 /x/player/v2 被 B 站**主动降级** —— 同一个视频请求 6 次只有 1 次正确，
   其余 5 次返回别的视频的字幕（"♪ 音乐 ♪""今天吃几碗烧烤的总结就是两个字"…），
   而且 HTTP 200 + code 0，从返回值上完全看不出错。
   真实网页播放器走 /x/player/wbi/v2，6/6 正确。downkyicore 走的也是这条。 */
const subCall = (biliSrc.match(/requestJSON\(\s*`([^`]*player[^`]*)`/) || [])[1] || '';
if (!/player\/wbi\/v2/.test(subCall)) {
  err(`字幕接口没走 /x/player/wbi/v2（实际: ${subCall.slice(0, 70) || '找不到'}）—— 旧路径已被降级，会随机返回别的视频的字幕`);
} else ok('字幕走 /x/player/wbi/v2（B 站真实播放器用的那条路径）');

/* 乱序表必须是 0~63 的一次全排列。
   这里曾经是一张坏表：漏了 0 和 41，而 62 和 57 各重复了一次 —— 签名从一开始就是错的。 */
const tabBlock = (biliSrc.match(/MIXIN_KEY_ENC_TAB\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
const tabArr = (tabBlock.match(/\d+/g) || []).map(Number);
const tabSet = new Set(tabArr);
if (tabArr.length !== 64 || tabSet.size !== 64 || tabArr.some((n) => n < 0 || n > 63)) {
  err(`MIXIN_KEY_ENC_TAB 不是 0~63 的全排列（${tabArr.length} 项 / 去重后 ${tabSet.size}）—— 签名必错`);
} else ok('WBI 乱序表是 0~63 的合法全排列');

/* mixinKey 的算法：用**整张 64 项的表**抽出 64 个字符，再取前 32 个。
   写成 MIXIN_KEY_ENC_TAB.slice(0,32).map(...) 只用了半张表，是错的。 */
if (/MIXIN_KEY_ENC_TAB\.slice\(/.test(biliSrc)) {
  err('mixinKey 用了 MIXIN_KEY_ENC_TAB.slice(0,32) —— 算法写反了（必须整表抽满后再截前 32 位）');
} else if (!/MIXIN_KEY_ENC_TAB\.map\([\s\S]{0,90}?\.slice\(0,\s*32\)/.test(biliSrc)) {
  err('mixinKey 没按"整表抽满 → 截前 32 位"计算');
} else ok('mixinKey 按 B 站算法计算（整表抽出后取前 32 位）');

/* 去字幕 CDN 取文件时不应携带登录 Cookie（aisubtitle.hdslb.com 与主站不是一回事） */
if (!/httpRequest\(subUrl,\s*\{\s*noCookie:\s*true\s*\}\)/.test(biliSrc)) {
  err('下载字幕时把登录 Cookie 发给了字幕 CDN —— 既没必要也不安全');
} else ok('下载字幕不带登录 Cookie（SESSDATA 不外发给 CDN）');

/* ---- 19) 歌词必须跟着播放滚动 ---- */
console.log('\n[18] 歌词跟随播放滚动：');
/* 真机现象：歌词取对了，但播到副歌了高亮还停在第一句。
   根因：syncLyric() 只在"渲染完"和"展开面板"时被调用过，
   播放过程中完全没有驱动 —— 少接了一根线。 */
const tuBlock = (appjs.match(/addEventListener\('timeupdate',[\s\S]*?\n  \}\)/) || [])[0] || '';
if (!tuBlock) {
  err("找不到 audio 的 timeupdate 监听 —— 歌词没有滚动的驱动源");
} else if (!/syncLyric\(\)/.test(tuBlock)) {
  err('timeupdate 里没有调用 syncLyric() —— 播放时歌词不会跟着滚动（高亮会一直停在第一句）');
} else ok('timeupdate 里驱动 syncLyric()（播放时歌词实时跟随）');

/* 暂停状态下 timeupdate 不触发：拖进度条 / 快捷键跳转后必须自己补一次 */
if (!/addEventListener\('seeked'[\s\S]{0,80}?syncLyric/.test(appjs)) {
  err("没有监听 'seeked' —— 暂停时拖进度条，歌词不会跟着跳");
} else ok("监听 'seeked'（暂停时跳转歌词也跟得上）");

/* scrollIntoView 会把所有可滚动的祖先一起滚（整页跟着抖），必须自己算 scrollTop */
if (/scrollIntoView/.test(appjs)) {
  err('歌词滚动用了 scrollIntoView —— 会连带滚动祖先容器，浮层里会整页抖动');
} else if (!/function scrollLyricTo/.test(appjs)) {
  err('缺少 scrollLyricTo() —— 歌词无法居中滚动');
} else ok('歌词滚动自己算 scrollTop（只动歌词容器，不牵动整页）');

/* ★ 滚动是否平滑，必须由 JS 每次调用显式指定，不能让 CSS 插手：
     CSS 里写了 scroll-behavior: smooth 的话，behavior:'auto' 的含义就变成"听 CSS 的"
     = 永远平滑 —— "打开歌词页立刻定位到当前句"会变成从顶上慢慢滑下来。
     而 behavior:'instant' 看着更直观，却在部分内核里被当成非法值退回 auto，
     一旦 CSS 里有 smooth 又会退化成"永远平滑"（实测踩过：三处测量都停在半路，偏 191px）。 */
const cssSmooth = /\.lyric-box\s*\{[^}]*scroll-behavior:\s*smooth/.test(css);
if (cssSmooth) {
  err(".lyric-box 里写了 scroll-behavior: smooth —— 会让 behavior:'auto' 变成'永远平滑'，打开歌词页会从顶上慢慢滑下来");
} else if (!/behavior:\s*\(instant \|\| far\)\s*\?\s*'auto'\s*:\s*'smooth'/.test(appjs)) {
  err("scrollTo 没有显式区分 'auto'（立刻到位）与 'smooth'（平滑跟进）");
} else ok("滚动行为由 JS 指定：跳转 / 刚渲染立刻到位，逐句跟进才平滑");

/* ---- 20) 桌面歌词悬浮窗（第二个窗口） ---- */
console.log('\n[19] 桌面歌词悬浮窗：');
const lyricHtml = stripHtml(read('src/ui/lyric.html'));
const lyricCss  = stripBlock(read('src/ui/lyric.css'));
const lyricJs   = stripBlock(read('src/ui/lyric.js'));
const lyricPre  = stripBlock(read('src/preload-lyric.js'));

/* 窗口本体：无边框 + 透明 + 不在任务栏 + 独立预加载 + 隔离。
   少了 transparent / backgroundColor 就是一整块黑方块，不是"悬浮歌词"。 */
const lwBlock = (mainjs.match(/lyricWindow = new BrowserWindow\(\{([\s\S]*?)\n  \}\);/) || [])[1] || '';
if (!lwBlock) err('找不到桌面歌词窗口的创建代码');
const LW_MUST = [
  ['frame:false',     /frame:\s*false/],
  ['transparent:true', /transparent:\s*true/],
  ['skipTaskbar:true', /skipTaskbar:\s*true/],
  ['alwaysOnTop:true', /alwaysOnTop:\s*true/],
  ['contextIsolation:true', /contextIsolation:\s*true/],
  ['nodeIntegration:false', /nodeIntegration:\s*false/],
  ['独立预加载脚本',   /preload-lyric\.js/],
];
LW_MUST.forEach(([name, re]) => {
  if (!re.test(lwBlock)) err(`桌面歌词窗口缺少 ${name}（安全 / 外观会出问题）`);
});
if (lwBlock) ok('悬浮窗：无边框 + 透明 + 不在任务栏 + 独立预加载 + 开启隔离');

/* 置顶等级必须是 screen-saver：普通 alwaysOnTop 会被全屏程序盖住 */
if (!/setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(mainjs)) {
  err("悬浮窗没有用 setAlwaysOnTop(true,'screen-saver') —— 别的软件全屏时会被盖住");
} else ok("置顶等级为 screen-saver（全屏软件也压得住）");
if (!/backgroundColor:\s*'#00000000'/.test(mainjs)) err('透明窗口的 backgroundColor 不是 #00000000（会变成黑块）');
else ok('透明窗口底色为 #00000000');

/* 页面资源在自己目录下（CSP 写的是 'self'，路径错了就整页空白） */
if (!/href="lyric\.css"/.test(lyricHtml)) err('lyric.html 没有引 lyric.css');
if (!/src="lyric\.js"/.test(lyricHtml))   err('lyric.html 没有引 lyric.js');
if (/href="lyric\.css"/.test(lyricHtml) && /src="lyric\.js"/.test(lyricHtml)) ok('悬浮窗的 css / js 都挂在自己目录下');

/* 悬浮窗自己的 CSS 变量也要都能对上 —— 少一个，整行字就会没颜色 / 没透明度。
   这四类变量是设置页那几根滑杆的直接下游：字号、工具条大小、底板透明度、文字透明度。 */
const lwCssVars = new Set([...lyricCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const lwUsedVars = new Set([...lyricCss.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
const lwUndef = [...lwUsedVars].filter((v) => !lwCssVars.has(v));
if (lwUndef.length) err(`悬浮窗用了没定义的 CSS 变量：${lwUndef.join(', ')}`);
else {
  const need = ['--fs', '--bar-scale', '--bg-alpha', '--fg-alpha', '--fg2-alpha', '--accent-rgb'];
  const lack = need.filter((v) => !lwCssVars.has(v));
  if (lack.length) err(`悬浮窗缺少可调变量：${lack.join(', ')}（设置页的滑杆就白调了）`);
  else ok(`悬浮窗的 ${lwUsedVars.size} 个 CSS 变量都有定义，且 6 个可调项齐全`);
}

/* ★ 鼠标穿透的关闭入口必须在主窗口：开启后悬浮窗点不到自己，关不掉自己 */
if (!htmlIds.has('chkLyricThrough')) err('主窗口设置里没有「鼠标穿透」开关 —— 开了就关不掉了');
else if (/clickThrough|穿透/.test(lyricHtml) || /clickThrough|穿透/.test(lyricJs)) {
  err('穿透开关出现在悬浮窗自己身上 —— 开启后它点不到自己，必须放主窗口');
} else ok('鼠标穿透的开关只在主窗口（悬浮窗自己没有，避免开了关不掉）');

/* ★ 拖动不能用 -webkit-app-region: drag —— 拖拽区会吞掉鼠标事件，
   那样"单击歌词弹工具条"永远收不到点击 */
if (/app-region:\s*drag/.test(lyricCss)) {
  err('悬浮窗用了 -webkit-app-region: drag —— 拖拽区会吞掉点击，工具条弹不出来');
} else if (!/window\.lyric\.dragStart\(/.test(lyricJs)) {
  err('悬浮窗没有在拖动时发出 dragStart（拖不动）');
} else ok('拖动绕开了拖拽区：按下后交给主进程跟着光标走');

/* 工具条：点击才显示 + 3 秒自动收起 + 4px 区分单击与拖动 */
if (!/moved <= 4/.test(lyricJs)) err('没有"位移超过 4px 才算拖动"的判定 —— 手抖会误弹工具条');
else if (/e\.screenX/.test(lyricJs)) {
  err('拖动判定用了 e.screenX（屏幕坐标）—— 它并不总是可靠，应该用窗口内坐标 e.clientX');
} else if (!/Math\.abs\(e\.clientX - downAt\.x\)/.test(lyricJs)) {
  err('拖动判定没有用窗口内坐标算位移');
} else if (!/setTimeout\(hideBar, 3000\)/.test(lyricJs)) err('工具条没有 3 秒自动收起');
else if (!/\.lyric-bar\.show/.test(lyricCss)) err('CSS 里没有 .lyric-bar.show（工具条显示不出来）');
else ok('工具条：单击才出现、移开 3 秒收起、4px 以内算单击');

/* ★ 默认不画底板：屏幕上只有字，边框只在点出工具条时出现。
   实现是"基础规则什么都不画，:not(.bare) 才画" —— 两边都要验。 */
const lwBase = (lyricCss.match(/\.lyric-win\s*\{([\s\S]*?)\}/) || [])[1] || '';
if (!lwBase) err('找不到 .lyric-win 的基础样式');
else if (/background:\s*(?!transparent)/.test(lwBase)) err('.lyric-win 基础样式带了背景色 —— 默认就不是"只有字"了');
else if (!/\.lyric-win:not\(\.bare\)\s*\{[^}]*background:/.test(lyricCss)) err('选了「半透明底板」也没底色（:not(.bare) 缺背景）');
else if (!/\.lyric-win\.bare \.lyric-bar\.show/.test(lyricCss)) err('工具条在纯文字模式下没有自己的底板 —— 点出来会看不清');
else if (!/bgStyle === 'card'\) \? 'card' : 'none'/.test(lyricJs)) err('悬浮窗没有把"底板"当成两种模式处理（bgStyle 只认 card/none）');
else ok('默认纯文字（无底无边框），底板只在点出工具条时露出来');

/* 字号 / 工具条大小 / 不透明度都要能调，且范围在两端一致 */
const fontRange = (html.match(/id="rngLyricFont"[^>]*min="(\d+)"[^>]*max="(\d+)"/) || []);
if (fontRange[1] !== '14' || fontRange[2] !== '72') err('歌词字号滑杆范围不是 14~72（设置页与悬浮窗要对齐）');
else if (!/Math\.max\(14, Math\.min\(72/.test(lyricJs)) err('悬浮窗没有把字号夹在 14~72');
else if (!/Math\.max\(14, Math\.min\(72/.test(appjs)) err('工具条上的字号按钮没有把字号夹在 14~72');
else ok('歌词字号 14~72（设置页与悬浮窗两侧都夹了范围）');
if (!htmlIds.has('rngLyricBar') || !htmlIds.has('valLyricBar')) err('设置页缺少「工具条大小」滑杆');
else if (!/--bar-scale/.test(lyricCss) || !/calc\(24px \* var\(--bar-scale\)\)/.test(lyricCss)) {
  err('工具条与图标没有跟着 --bar-scale 缩放（图标还是原来的大小）');
} else if (!/barScale:\s*s\.barScale/.test(appjs)) err('工具条大小没有推给悬浮窗');
else ok('工具条与图标大小可调（80~180%）');

/* IPC：悬浮窗那一侧的通道必须在 main.js 注册 */
[['lyric:open', 1], ['lyric:close', 1], ['lyric:push', 1], ['lyric:style', 1],
 ['lyric:resize', 1], ['lyric:drag-start', 1], ['lyric:drag-end', 1],
 ['lyric:through', 1], ['lyric:cmd', 1]]
  .forEach(([ch]) => {
    if (!new RegExp("ipcMain\\.on\\('" + ch + "'").test(mainjs)) {
      err(`main.js 没有注册 ${ch}`);
    }
  });
if (!/onData:/.test(lyricPre) || !/onStyle:/.test(lyricPre) || !/cmd:/.test(lyricPre) || !/resize:/.test(lyricPre)
    || !/dragStart:/.test(lyricPre) || !/dragEnd:/.test(lyricPre)) {
  err('preload-lyric 暴露的桥不完整（onData / onStyle / cmd / resize / dragStart / dragEnd）');
} else ok('悬浮窗的 IPC 通道两端都接上了');

/* 主题色要传给悬浮窗，不然它永远是一个颜色（传的是 "r g b" 三个数，好单独套不透明度） */
if (!/accentRgb:\s*currentAccentRgb\(\)/.test(appjs)) err('推送样式时没有带上主题色（悬浮窗不会跟着换主题）');
else if (!/--accent-rgb/.test(lyricCss)) err('悬浮窗 CSS 里没有用 --accent-rgb（当前句上不了主题色）');
else if (!/split\(' '\)\.join\(', '\)/.test(appjs)) {
  err('主题色没有转成逗号分隔就推过去了 —— rgba(r g b, a) 这种混写取不到颜色');
} else if (/--accent-rgb:\s*\d+\s+\d+\s+\d+;/.test(lyricCss)) {
  err('悬浮窗 CSS 里的 --accent-rgb 是空格分隔的（要和 JS 推过来的逗号形式一致）');
} else ok('主题色会推给悬浮窗，且按逗号形式传（换主题时当前句颜色跟着变）');

/* ---- 21) 音量：悬停展开的竖向滑杆 ---- */
console.log('\n[20] 音量控件：');
['volWrap', 'volTrack', 'volFill', 'volKnob', 'volNum', 'btnMute'].forEach((id) => {
  if (!htmlIds.has(id)) err(`index.html 缺少 #${id}（音量浮层不完整）`);
});
if (!/\.vol-wrap:hover \.vol-pop/.test(css)) err('CSS 里没有 .vol-wrap:hover .vol-pop —— 悬停不会展开');
else ok('音量悬停展开（.vol-wrap:hover .vol-pop）');
if (!/\.vol-track\s*\{[^}]*height:/.test(css)) err('.vol-track 是竖向的但没有高度');
else ok('音量滑杆是竖向的（有固定高度）');
if (/\$\('volume'\)/.test(appjs)) err('app.js 还在引用已经删掉的 #volume（会取到 null 报错）');
else ok('旧的横向音量条已彻底移除（没有残留引用）');
const volFn = (appjs.match(/function bindVolume\(\)\s*\{[\s\S]*?\n\}/) || [])[0] || '';
if (!volFn) err('找不到 bindVolume() —— 音量交互整套都没接上');
else if (!/\$\('btnMute'\)/.test(volFn)) err('bindVolume 里没有取到 #btnMute（静音按钮不存在）');
else if (!/muteBtn\.addEventListener\('click'/.test(volFn)) err('点音量图标静音没接上');
else if (!/addEventListener\('wheel'/.test(volFn)) err('滚轮调音量没接上');
else ok('点图标静音 + 滚轮调音量 + 竖向滑杆拖动都已绑定');

/* ★ 悬停不能"离开图标就消失"：图标与面板之间要有隐形桥，移开还要留一点缓冲。
   之前少了这两样，鼠标从图标往上游走时面板会在半路消失。 */
if (!/\.vol-pop::after/.test(css)) {
  err('音量面板少了那条"隐形桥"（.vol-pop::after）—— 鼠标从图标往上滑时会中途消失');
} else if (!/\.vol-wrap\.open \.vol-pop/.test(css)) {
  err('音量面板没有"延迟收起"用的 .open 状态');
} else if (!/setTimeout\(\(\) => wrap\.classList\.remove\('open'\), 450\)/.test(appjs)) {
  err('音量面板没有"移开后延迟 0.45 秒再收起"');
} else if (!/pointerenter'[\s\S]{0,200}?pointerleave'/.test(appjs)) {
  err('音量面板的悬停进出没有接上（pointerenter / pointerleave）');
} else ok('音量面板：图标与面板之间有隐形桥 + 移开后延迟 450ms 收起');

/* ---- 22) 封面 = 整页歌词入口 ---- */
console.log('\n[21] 封面进歌词页：');
if (!/<button[^>]*id="npCover"/.test(html)) err('#npCover 不是按钮（点不动）');
else if (!/\$\('npCover'\)/.test(appjs) || !/cover\.addEventListener\('click'/.test(appjs)) {
  err('#npCover 没有点击处理（点了没反应）');
}
else ok('播放条封面可点击进入整页歌词');
if (keyDefOf('toggleLyric') !== 'Ctrl+d') err('KEY_ACTIONS 里没有「整页歌词 = Ctrl+D」这一条');
else ok('Ctrl+D 可开关整页歌词（现在从 KEY_ACTIONS 表来）');
if (!/closest\('\.l'\)/.test(appjs)) err('整页歌词不支持"点某句跳到那一句"');
else ok('整页歌词点某句可跳到那一句的时间');

/* ---- 23) 桌面歌词存档：换歌 / 改设置都不能丢 ---- */
console.log('\n[22] 桌面歌词存档：');
const lwKeys = ['on', 'x', 'y', 'fontSize', 'opacity', 'lines', 'barScale', 'bgStyle', 'locked', 'clickThrough'];
const lwDef = (appjs.match(/DEFAULT_LYRIC_WIN = \{([\s\S]*?)\n\};/) || [])[1] || '';
const lwMiss = lwKeys.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(lwDef));
if (lwMiss.length) err(`DEFAULT_LYRIC_WIN 缺少字段：${lwMiss.join(', ')}`);
else ok(`桌面歌词设置 ${lwKeys.length} 个字段都有默认值`);
const lwMig = lwKeys.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(mainjs) && !new RegExp('\\b' + k + '\\s*:').test(appjs));
if (!/lyricWin:/.test(appjs)) err('migrateSettings 没有给 lyricWin 补默认值（老存档会取到 undefined）');
else if (lwMig.length) err(`migrate 后仍缺少字段：${lwMig.join(', ')}`);
else ok('老存档会自动补出 lyricWin（逐项夹到合法范围，不会被手改坏）');

/* ---- 24) 拖动顺滑：主进程跟着光标走，不逐帧走 IPC ---- */
console.log('\n[23] 悬浮窗拖动顺滑：');
if (/ipcMain\.on\('lyric:move'/.test(mainjs)) {
  err("还留着逐帧的 lyric:move 通道 —— 鼠标一动就发一次消息，拖动又会一卡一卡");
} else if (!/screen\.getCursorScreenPoint\(\)/.test(mainjs)) {
  err('主进程没有读光标位置 —— 拖动跟不上手');
} else if (!/setBounds\(\{ x, y, width: lyricDragSize\.w, height: lyricDragSize\.h \}, false\)/.test(mainjs)) {
  err('拖动没有用 setBounds 一次挪到位');
} else if (!/setInterval\([\s\S]*?\}, 16\);/.test(mainjs)) {
  err('拖动跟随不是每 16 毫秒一次（太慢会顿、太快白烧 CPU）');
} else if (!/lyricDragDeadline/.test(mainjs)) {
  err('拖动没有安全绳（万一半路没收到"拖完"，窗口会一直黏着光标）');
} else if (!/blur', \(\) => stopLyricDrag\(\)/.test(mainjs)) {
  err('拖动时窗口失去焦点不会松手（会一直黏着光标）');
} else if (!/if \(x === lyricDragLast\.x && y === lyricDragLast\.y\) return;/.test(mainjs)) {
  err('拖动每帧都会去动窗口（光标没动时也在白干活，会更费 CPU）');
} else ok('拖动：主进程每 16ms 跟着光标 setBounds + 有安全绳 + 失焦松手');

/* 位置回传必须防抖：拖动时窗口每 16 毫秒动一次，每次都写盘会把拖动拖慢 */
if (!/function scheduleLyricPosNotify\(\)/.test(mainjs)) err('位置回传没有防抖函数');
else if (!/lyricWindow\.on\('moved', \(\) => scheduleLyricPosNotify\(\)\)/.test(mainjs)) {
  err('moved 事件没有走防抖（拖动时会疯狂写盘）');
} else ok('拖动中的位置回传防抖 140ms（不会边拖边写盘）');

/* ---- 25) 歌词页的开关与"点别处收起"（用户实机反馈的三条） ---- */
console.log('\n[24] 歌词页开关与点别处收起：');

/* 浮层必须从"标题栏 + 顶部工具栏"的下沿开始铺。
   只从标题栏下沿开始 = 搜索框被整块盖住 = 看着歌词页"压在最上面"，点了却没反应。 */
if (!/\.lyric-overlay\s*\{[^}]*top:\s*calc\(var\(--titlebar-h\)\s*\+\s*var\(--topbar-h\)\)/.test(css)) {
  err('歌词浮层不是从顶部工具栏下沿开始铺 —— 会盖住搜索框（点了没反应）');
} else if (!/--topbar-h:/.test(css)) {
  err('--topbar-h 没有兜底值（脚本还没跑起来时浮层位置会错位）');
} else if (!/function syncTopbarHeight\(\)/.test(appjs)) {
  err('没有 syncTopbarHeight() —— 工具栏高度写死会在换字体 / 系统缩放后错位');
} else if (!/window\.addEventListener\('resize', syncTopbarHeight\)/.test(appjs)) {
  err('窗口大小变化后没有重新量工具栏高度');
} else ok('歌词页从顶部工具栏下沿开始铺，搜索框始终露在外面');

/* 封面必须是"能开也能收"的开关：写死 toggleLyrics(true) 就是"点了收不回去"的根因 */
if (/if \(lyricState\.showing\) \{ toggleLyrics\(false\); return; \}/.test(appjs)) {
  ok('点封面能开、再点能收（不是单程开关）');
} else err('封面的点击处理没有"已展开就收起"的分支 —— 点它收不起来');

/* 点歌词页以外的界面要收起；但播放条部件与标题栏不算"别的界面" */
if (!/document\.addEventListener\('pointerdown'/.test(appjs)) {
  err('没有"点歌词页以外就收起"的处理（点侧栏它会一直压在上面）');
} else if (!/t\.closest\('#lyricOverlay'\)/.test(appjs) || !/t\.closest\('#player'\)/.test(appjs) || !/t\.closest\('\.titlebar'\)/.test(appjs)) {
  err('收起逻辑没有把 歌词页自己 / 播放条 / 标题栏 排除掉（会误收或点不动）');
} else ok('点歌词页以外会收起；播放条按钮与标题栏不受影响');

/* ★ 用 pointerdown 而不是 click：click 的落点是"按下与松开两个元素的共同祖先"，
   拖进度条时松手滑到别处会算成点在空白区，把歌词页莫名收掉。 */
if (!/pointerdown', \(e\) => \{/.test(appjs)) {
  err('收起判定没有用 pointerdown —— 拖进度条松手滑到别处会误收歌词页');
} else ok('用 pointerdown 判定（拖进度条不会误收歌词页）');

if (/\.np-cover\.open::after/.test(css) && /content:\s*"收起"/.test(css)) {
  ok('歌词页开着时封面悬停显示「收起」');
} else err('封面在歌词页开着时没有"收起"提示 —— 看不出再点一下是收起来');

/* ★ 歌词容器上下必须各留"半屏"的空白，让它滚到任一句都能停在正中。
   但本工程全局 box-sizing: border-box，而 .lyric-box 用 inset:0 被撑成铺满浮层的高（约 558）：
   若用 padding: 50% 当上下留白，border-box 下内容区被压成 0、clientHeight 反而变成 ~941，
   比浮层可见的 558 还高 —— 居中公式按 941 算、浮层只显示 558，当前句恒偏 (941-558)/2 = 191px
   （自测确实每项都偏 191）。正确做法：用 .lyric-box::before / ::after 伪元素各撑半屏多 40px，
   它们算进 scrollHeight、不撑大 clientHeight，clientHeight 始终等于浮层可见高，居中公式才对得上。 */
const lboxBlock = (css.match(/\.lyric-box\s*\{([^}]*)\}/) || [])[1] || '';
const lboxPad = ((lboxBlock.match(/padding:\s*([^;]+);/) || [])[1] || '').trim().split(/\s+/);
const vertPctPad = lboxPad.length >= 3 && (lboxPad[0].endsWith('%') || lboxPad[2].endsWith('%'));
const hasSpacer = /\.lyric-box::before[^{]*\{[^}]*height:\s*calc\(50%\s*\+\s*\d+px\)/.test(css)
               && /\.lyric-box::after[^{]*\{[^}]*height:\s*calc\(50%\s*\+\s*\d+px\)/.test(css);
if (vertPctPad) {
  err('.lyric-box 上下用了百分比 padding —— 本工程 border-box + inset:0 会让 clientHeight 变成 ~941（不是浮层可见的 558），当前句恒偏 191px；请改用 ::before/::after 伪元素撑半屏');
} else if (hasSpacer) {
  ok('歌词容器上下用 ::before/::after 伪元素各撑半屏多 40px（不撑大 clientHeight，居中公式对得上）');
} else {
  err('歌词容器没有"上下各留半屏"的居中留白（伪元素 calc(50% + Npx) 或 padding 上/下 ≥45%）—— 第一句或最后一句滚不到正中');
}
if (!/scrollLyricTo\(idx, force\)/.test(appjs)) {
  err('没有把当前句滚到中间的 scrollLyricTo(idx, force)');
}

if (!/^\s*syncTopbarHeight\(\);$/m.test(appjs)) {
  err('启动时没有调用 syncTopbarHeight()（--topbar-h 还是 CSS 里的兜底值）');
} else ok('启动时量过顶部工具栏高度并写进 --topbar-h');

/* ---- 27) 合集 / 分P 展开面板 ---- */
console.log('\n[27] 合集 / 分P 展开：徽章入口 + 右侧抽屉 + 点空白/Esc 收起：');
{
  const need = ['collectMask', 'collectTitle', 'collectSub', 'collectSearch', 'collectList',
                'btnCloseCollect', 'btnDownloadCollect'];
  const miss = need.filter((id) => !htmlIds.has(id));
  if (miss.length) err(`index.html 缺少合集面板元素：${miss.join(', ')}`);
  else ok('合集面板的遮罩 / 标题 / 搜索框 / 列表 / 两个按钮都在 index.html');

  /* ★ v2.8.0：合集工具条的「播放全部」换成了「批量下载」（Neo 拍板，改造计划原文已挪到 docs/_local-notes/ 不进仓库）。
     这条是**反向**断言 —— 防它哪天又被加回来，那样这一屏会同时挂两个"整批操作"按钮，
     而「播放全部」的语义已经被"选集行点一下就播"覆盖了。 */
  if (htmlIds.has('btnPlayCollect')) err('v2.8.0 换掉的「播放全部」又回来了 —— 合集工具条上会多出一个重复语义的按钮');
  else ok('合集工具条上没有退回「播放全部」（v2.8.0 已换成「批量下载」）');

  if (!/id="btnDownloadCollect"/.test(html) || !/btnDownloadCollect'\)\.addEventListener/.test(appjs))
    err('合集工具条的「批量下载」没接上点击');
  else ok('合集工具条的「批量下载」绑上了点击（整批 enqueueDownloads）');

  /* ★ v2.4.0：删掉「加入队列」之后，这里改成**反向**断言 —— 防它哪天又被加回来 */
  if (htmlIds.has('btnQueueCollect')) err('v2.4.0 删掉的「加入队列」又回来了 —— 搜索框会被重新挤成一个字');
  else ok('合集面板里没有「加入队列」（v2.4.0 已删，搜索框才有地方）');

  /* ★ v2.4.0：搜索框必须有下限，不许被按钮挤成一个字（Neo 这次报的问题） */
  if (!/\.collect-search\s*\{[^}]*min-width:\s*140px/.test(css))
    err('.collect-search 没有 min-width:140px —— 搜索框可能又被挤成一个字');
  else ok('合集面板的搜索框有最小宽度（min-width:140px）');

  if (!/\.collect-mask\s*\{[^}]*position:\s*fixed/.test(css) || !/\.collect-panel\s*\{/.test(css))
    err('style.css 缺少 .collect-mask / .collect-panel 右侧抽屉样式');
  else ok('合集面板用 .collect-mask + .collect-panel 从右侧滑出');

  if (!/\.track\s+\.badge\s*\{/.test(css)) err('缺少行上「选集 N」徽章样式 .track .badge');
  else ok('歌曲行有「选集 N」徽章样式');

  const trackBlock = (css.match(/\.track\s*\{([^}]*)\}/) || [])[1] || '';
  const colsRaw = (trackBlock.match(/grid-template-columns:\s*([^;]+);/) || [])[1] || '';
  const nCols = colsRaw.trim() ? colsRaw.trim().split(/\s+/).length : 0;
  if (nCols < 6) err(`.track 仍是 ${nCols} 列 —— 徽章会挤坏整行布局（应为 6 列：序号/封面/信息/徽章/时长/操作）`);
  else ok('.track 增到 6 列（给徽章留了一列，不挤坏布局）');

  if (!/function maybeCollection\(/.test(appjs) || !/COLLECT_HINT_RE/.test(appjs))
    err('没有 maybeCollection —— 无法判断哪一行该显示「选集」徽章');
  else ok('有 maybeCollection（已查过的分P/合集数 + 时长 + 标题关键词）');

  if (!/function expandCollection\(/.test(appjs) || !/api\(\s*'videoInfo'/.test(appjs))
    err("expandCollection 没有经 api('videoInfo') 拉取分P/合集");
  else ok("点徽章时才经 api('videoInfo') 拉取分P/合集（搜索结果拿不到，不在列表阶段乱发请求）");

  if (!/function buildCollectionEntries\(/.test(appjs) || !/info\.season[\s\S]*?info\.pages/.test(appjs))
    err('buildCollectionEntries 没有"优先合集、其次分P"的兜底');
  else ok('优先展开 UP 合集；没有合集时退回分P列表');

  if (!/data-act="expand"/.test(appjs) || !/closest\(\s*'\.badge'\s*\)/.test(appjs))
    err("行上的徽章没有接上点击（data-act=\"expand\" / closest('.badge')）");
  else ok('徽章点击被单独拦下，不会误触发"整行播放"');

  /* ★ v2.4.0：整段入队的能力改由"点行 / 播放全部"承担，queueCollection 已删 */
  if (/function queueCollection\(/.test(appjs)) err('v2.4.0 删掉的 queueCollection 还在（按钮没了它就是死代码）');
  else ok('整段入队由"点行 / 播放全部"承担（queueCollection 已删）');

  /* 合集面板的两种收起方式。
     ★ 断言"性质"而不是"写法"：原来这里写死了 `e.key === 'Escape' && collectState`，
       v2.8.0 给 Esc 加了一层"勾选态下先退勾选态、再按一次才收面板"，写法一变就误报。
       现在只要求 bindCollect 里那个 keydown 处理器**最终会调 closeCollectPanel()**。 */
  {
    const bi = appjs.indexOf('function bindCollect(');
    const body = bi < 0 ? '' : appjs.slice(bi, bi + 6000);
    const ki = body.indexOf("addEventListener('keydown'");
    const kb = ki < 0 ? '' : body.slice(ki, ki + 400);
    const hasEsc = /'Escape'/.test(kb) && /closeCollectPanel\(\)/.test(kb);
    const hasMask = /e\.target\.id === 'collectMask'/.test(body);
    if (!hasEsc || !hasMask) err('合集面板没有"点空白 / Esc 收起"');
    else ok('合集面板可点空白或按 Esc 收起（与歌词浮层一致）');
  }

  if (!/^\s*bindCollect\(\);$/m.test(appjs)) err('启动时没有调用 bindCollect()');
  else ok('启动时绑定合集面板');
}

console.log('\n[28] 小弹窗 / 播放队列 / 图标操作 / UP 主页：');
{
  /* --- A. 不能用 prompt()/confirm()：Electron 没实现，会静默失效 --- */
  const codeOnly = appjs.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  if (/[^.\w]prompt\s*\(/.test(codeOnly)) {
    err('app.js 仍在调用 prompt() —— Electron 里它不弹窗、直接返回空，点了会"没反应"');
  } else if (/[^.\w]confirm\s*\(/.test(codeOnly)) {
    err('app.js 仍在调用 confirm() —— 换成本项目自己的弹窗，样式才统一');
  } else ok('已不再使用 prompt() / confirm()（Electron 不支持 prompt，会静默失效）');

  /* --- B. 小弹窗的元素与样式都在 --- */
  const needIds = ['promptMask', 'promptTitle', 'promptBody', 'promptFoot', 'promptClose'];
  const missIds = needIds.filter((id) => !htmlIds.has(id));
  if (missIds.length) err(`index.html 缺少小弹窗元素：${missIds.join(', ')}`);
  else ok('通用小弹窗（#promptMask / 标题 / 主体 / 按钮区 / 关闭）都在 index.html');

  if (!/function openPrompt\(/.test(appjs) || !/function closePrompt\(/.test(appjs) || !/function bindPrompt\(/.test(appjs))
    err('缺少小弹窗的 openPrompt / closePrompt / bindPrompt');
  else ok('小弹窗有打开的、关闭的和事件绑定三件套');

  if (!/function askName\(/.test(appjs)) err('缺少"输入名字"的 askName（新建歌单 / 重命名要用）');
  else ok('新建歌单与重命名都走 askName（输入框弹窗）');

  if (!/function pickPlaylistFor\(/.test(appjs) || !/data-pl=/.test(appjs))
    err('缺少"选一个歌单"的弹窗（pickPlaylistFor / 歌单行）');
  else if (!/function addToPlaylist[\s\S]*?pickPlaylistFor\(\[track\]\)/.test(appjs))
    err('行内的 ＋ 没有接到 pickPlaylistFor —— 点＋不会弹出歌单列表');
  else if (!/function addManyToPlaylist[\s\S]*?pickPlaylistFor\(tracks\)/.test(appjs))
    err('"全部加入歌单"没有走同一个选歌单弹窗');
  else ok('点 ＋ / 全部加入歌单都会弹出歌单列表（可在其中新建）');

  if (!/id="plNew"/.test(appjs) || !/plCreate/.test(appjs))
    err('歌单弹窗里没有"新建歌单…"入口 —— 用户没法在选歌单时就地创建');
  else ok('歌单弹窗内有「新建歌单…」入口，且建完直接加入');

  if (!/\$\(\s*'btnNewPlaylist'\s*\)[\s\S]{0,120}?askName/.test(appjs))
    err('侧栏「＋ 新建歌单」没接到 askName —— 这就是"点了没反应"的直接原因');
  else ok('侧栏「＋ 新建歌单」已改为自家弹窗（不再是那个不弹的 prompt）');

  /* --- C. 行内按钮改图标 + 悬停提示 --- */
  for (const icon of ['i-list', 'i-info', 'i-trash']) {
    if (!new RegExp(`id="${icon}"`).test(html)) err(`图标库里缺少 ${icon}`);
  }
  if (!/\.op-ic\s*\{/.test(css)) err('缺少 .op-ic 图标按钮样式');
  else ok('行内操作已改为图标按钮（.op-ic）');

  if (!/\[data-tip\]::after\s*\{[\s\S]*?content:\s*attr\(data-tip\)/.test(css))
    err('缺少 [data-tip] 悬停提示样式 —— 图标按钮就没有名字了');
  else ok('图标按钮鼠标移上去会浮出名字（[data-tip]::after）');

  if (!/data-act="fav"[\s\S]{0,200}?i-heart/.test(appjs) || !/data-act="add"[\s\S]{0,200}?i-plus/.test(appjs))
    err('收藏 / 加歌单没有用 ♡ 与 ＋ 图标');
  else ok('收藏＝♡（已收藏实心）、加歌单＝＋');

  if (!/\.a-link\s*\{/.test(css) || !/data-act="up"/.test(appjs) || !/function openUpPage\(/.test(appjs))
    err('作者名没有做成可点（.a-link / data-act="up" / openUpPage）');
  else ok('列表里的作者名可点，点开该 UP 主的主页');

  if (!/closest\(\s*'\.a-link'\s*\)/.test(appjs))
    err("作者名的点击没有在内容区被拦下 —— 点作者会顺手把这首也播了");
  else ok('点作者名被单独拦下，不会误触发"整行播放"');

  /* --- D. 合集面板每一集也有操作按钮 --- */
  if (!/data-cact="fav"/.test(appjs) || !/data-cact="add"/.test(appjs))
    err('合集面板的每一集没有"收藏 / 加歌单"按钮');
  else if (!/closest\(\s*'\[data-cact\]'\s*\)/.test(appjs))
    err('合集面板的按钮点击没有拦下 —— 点收藏会变成"播放这一集"');
  else ok('合集面板每一集都有 hover 出现的收藏 / 加歌单按钮，且不会误触发播放');

  if (!/\.collect-row\s+\.cops\s*\{/.test(css) || !/\.collect-row:hover\s+\.cops\s*\{/.test(css))
    err('合集行缺少 .cops（悬停才显示的按钮列）');
  else ok('合集行的按钮平时藏起来，鼠标移到这一行才淡出');

  /* --- E. 播放队列 --- */
  const qIds = ['queueMask', 'queueTitle', 'queueSub', 'queueList', 'queueSearch',
                'btnQueue', 'btnCloseQueue', 'btnQueueShuffle', 'btnQueueClear'];
  const qMiss = qIds.filter((id) => !htmlIds.has(id));
  if (qMiss.length) err(`index.html 缺少队列面板元素：${qMiss.join(', ')}`);
  else ok('播放队列抽屉的遮罩 / 标题 / 列表 / 搜索 / 三个按钮都在');

  if (!/function renderQueueList\(/.test(appjs) || !/function bindQueue\(/.test(appjs) || !/function removeFromQueue\(/.test(appjs))
    err('缺少队列的渲染 / 绑定 / 移除函数');
  else if (!/^\s*bindQueue\(\);$/m.test(appjs)) err('启动时没有调用 bindQueue()');
  else ok('队列面板有渲染、绑定与"移除某一首"');

  if (!/queue\.tracks\.length/.test(appjs) || !/function currentTracks\(/.test(appjs))
    err('队列状态与列表取数的链路断了');
  else ok('队列复用既有的 queue.tracks（上一首/下一首用的就是它，不是新造一套）');

  /* ★ v2.4.0：refreshQueueIfOpen 是给「加入队列」同步队列面板用的；按钮删了它就是死代码 */
  if (/function refreshQueueIfOpen\(/.test(appjs))
    err('v2.4.0 删掉的 refreshQueueIfOpen 还在（它只服务于已删的「加入队列」，是死代码）');
  else ok('refreshQueueIfOpen 已随「加入队列」一起删除');

  /* --- F. UP 主页的后端链路 --- */
  if (!/async function getUpVideos\(/.test(read('src/bilibili.js'))) err('bilibili.js 缺少 getUpVideos');
  else if (!/getUpVideos,/.test(read('src/bilibili.js'))) err('getUpVideos 没有导出');
  else ok('bilibili.js 新增 getUpVideos（带 wbi 签名的空间接口）');

  if (!/handle\(\s*'bili:upVideos'/.test(mainjs)) err('main.js 没有注册 bili:upVideos');
  else if (!/upVideos:\s*\(/.test(preload)) err('preload.js 没有暴露 upVideos');
  else if (!/api\(\s*'upVideos'/.test(appjs)) err("app.js 没有经 api('upVideos') 调用（会拿到 {ok,data} 外壳）");
  else ok("UP 主页的 IPC 链路闭环：app.js → preload → main.js → bilibili.js");

  if (!/mid:\s*v\.mid/.test(read('src/bilibili.js'))) {
    err('searchVideos 没有把 mid 带出来 —— 作者名就点不开主页');
  } else if (!/mid:\s*v\.mid/.test(appjs)) {
    err('搜索结果映射时把 mid 丢了 —— 列表里的作者名点不开');
  } else ok('搜索结果已带上 UP 的 mid（作者名才能点）');

  /* --- G. ★ v2.5.0：UP 主页分页 --- */
  const bilijs = read('src/bilibili.js');
  if (!/total:\s*page\.count/.test(bilijs))
    err('bilibili.js 的 getUpVideos 没有把 page.count 当 total 带出来 —— 界面算不出总页数');
  else ok('getUpVideos 带出 total（B 站给的总投稿数）');
  if (!/pageSize:\s*UP_PAGE_SIZE/.test(bilijs) || !/ps:\s*UP_PAGE_SIZE/.test(bilijs))
    err('每页条数没有收敛到 UP_PAGE_SIZE 这一个常量（ps 和 pageSize 必须同源）');
  else ok('每页条数只有 UP_PAGE_SIZE 一个来源（ps / pageSize 同源）');

  if (!/function paginationHTML\(/.test(appjs)) err('app.js 缺少 paginationHTML —— 分页条画不出来');
  else ok('有 paginationHTML（页码省略 / 当前页高亮 / 到头置灰都在里面）');
  if (!/totalPages\s*>\s*1\s*\?\s*paginationHTML\(/.test(appjs))
    err('只有一页时也会画出分页条（应该藏起来）');
  else ok('只有一页时不画分页条');
  if (!/\.pager-num,\s*\.pager-btn|\.pager-num, \.pager-btn/.test(appjs))
    err('分页按钮没有接上点击代理 —— 点了没反应');
  else ok('分页按钮接进了全局点击代理');

  // ★ 反向断言：旧的「加载更多」不许复活（列表已经是"翻页替换"，再累加就自相矛盾）
  if (/btnMoreUp/.test(html) || /btnMoreUp/.test(appjs))
    err('v2.5.0 删掉的「加载更多」（btnMoreUp）又回来了 —— 和"翻页替换"是两套矛盾的模型');
  else ok('「加载更多」已删除（列表改成翻页替换，不再累加）');
  if (/upState\.list\s*=\s*pn\s*===\s*1\s*\?/.test(appjs))
    err('loadUp 又变回"累加"写法了（翻到第 5 页会堆 150 条）');
  else ok('loadUp 是"替换"而不是"累加"（列表里只有当前页）');
  if (!/共 \$\{upState\.total\} 个视频 · 第 \$\{page\} \/ \$\{totalPages\} 页/.test(appjs))
    err('UP 主页副标题没有写「共 N 个视频 · 第 x / y 页」');
  else ok('UP 主页副标题写明总数与页码');

  const pagercss = /\.pager\s*\{/.test(css) && /\.pager-num\.on\s*\{/.test(css) && /\.pager-btn:disabled\s*\{/.test(css);
  if (!pagercss) err('style.css 缺少分页条样式（.pager / .pager-num.on / .pager-btn:disabled）');
  else ok('分页条样式齐全（当前页高亮 + 到头置灰）');
}

/* ---------------------------------------------------------------
   [29]~[34] 第六轮：详情返回 / 队列来源 / 合集单集开关 / 播放模式
   --------------------------------------------------------------- */

/* ---- 29) 详情页必须回得去 ---- */
console.log('\n[29] 详情页返回：');
{
  if (!/id="btnParsedBack"/.test(appjs)) err('解析/详情页没有返回按钮（点进详情就出不来）');
  else ok('详情页头部有返回按钮 #btnParsedBack');

  // 有写入（点详情时记下来路）也要有读取（点返回时用到）
  if (!/parsedOrigin\s*=\s*\{/.test(appjs)) err('点「详情」时没有记下来路（parsedOrigin 没写入）');
  else if (!/const o = parsedOrigin;[\s\S]{0,300}?currentView\s*=\s*o\.view;/.test(appjs)) err('返回时没有还原原来的视图');
  else if (!/parsedOrigin\s*=\s*null/.test(appjs)) err('返回后没有清掉来路记录（会残留脏数据）');
  else ok('来路记录三件套齐全：写入 / 还原视图 / 用完清掉');

  if (!/scrollTop\s*=\s*o\.scroll/.test(appjs)) err('返回时没有还原滚动位置');
  else ok('返回时会还原原来那一页的滚动位置');

  if (!/parsedOrigin\s*=\s*null;\s*\n\s*currentView\s*=\s*'parsed'/.test(appjs))
    err('从链接框直接解析时没有清掉 parsedOrigin（返回按钮会指向错误的来路）');
  else if (!/parsedOrigin\s*\?\s*`← 返回\$\{parsedOrigin\.label/.test(appjs) || !/:\s*'← 返回发现'/.test(appjs))
    err('详情页"没有来路"时的返回按钮文案没改成「← 返回发现」');
  else ok('粘贴链接解析时清掉来路 → 返回按钮回到「发现」首页');
}

/* ---- 30) 播放队列 = 来源界面的快照 ---- */
console.log('\n[30] 播放队列跟随"你点播放的那个界面"：');
{
  if (!/function viewLabel\(/.test(appjs)) err('缺少 viewLabel()：队列的来源名没有统一出处');
  else {
    const need = [
      /'discovery'\)\s*return\s*'发现'/, /'favorites'\)\s*return\s*'我喜欢'/,
      /'history'\)\s*return\s*'最近播放'/, /upState\.name/, /parsedView\.info\.title/,
    ];
    const miss = need.filter((re) => !re.test(appjs));
    if (miss.length) err(`viewLabel() 少了 ${miss.length} 种界面的名字`);
    else ok('viewLabel() 覆盖 发现/我喜欢/最近播放/UP主页/解析页/歌单/搜索');
  }

  // 所有播放"整张列表"的入口都要经过 startFromView（否则又是旧的 queue.name）
  // ★ v2.10.0：「我喜欢」「歌单」两页的「播放全部」删掉了（Neo 拍板），调用点从 7 处降到 6 处。
  //   这里改成"点名要求这几个入口必须在"，比死守一个数字有意义 ——
  //   数量会因为加/删按钮一直变，而"哪几个入口必须统一"才是真正要守的东西。
  const starts = [...appjs.matchAll(/startFromView\(([^,]+),/g)].map((m) => m[1].trim());
  // ★ v2.11.0：解析页的「播放全部」也删了，所以 parsedView.tracks 不再是播放入口
  const needStarts = ['searchResults', 'discoveryResults', 'upState.list', 'tracks'];
  const missStarts = needStarts.filter((x) => !starts.includes(x));
  if (missStarts.length) err(`这些播放入口没走 startFromView()：${missStarts.join(' / ')}`);
  else ok(`${starts.length} 处播放入口统一走 startFromView()（发现 / UP主页 / 点行播放都在；解析页的播放全部 v2.11.0 已删）`);

  if (/playTracks\([^)]*queue\.name/.test(appjs)) err('还有播放入口在传旧队列名 queue.name');
  else ok('没有任何播放入口再传旧队列名');

  // 队列必须是副本：源列表后续增删不能改到正在播的这一份
  if (!/queue\s*=\s*\{\s*tracks:\s*tracks\.slice\(\)/.test(appjs))
    err('playTracks 没有把列表复制一份（队列还是源数组的引用，会被悄悄改掉）');
  else ok('队列存的是 slice() 副本（源列表增删不影响正在播的队列）');

  // 队列里的"随机打乱"跟"随机播放模式"不是一回事，名字要能区分
  if (!/id="btnQueueShuffle">打乱顺序</.test(html)) err('队列里的"打乱"按钮没改名，跟随机播放模式容易混');
  else ok('队列里的按钮叫「打乱顺序」，与随机播放模式区分开');
}

/* ---- 31) 播放模式合并成一个按钮 ---- */
console.log('\n[31] 播放模式：一个按钮切换四种：');
{
  let dirty = 0;
  ['loopMode', 'shuffled', 'btnShuffle', 'btnLoop'].forEach((w) => {
    const hit = [['app.js', appjs], ['index.html', html], ['style.css', css]]
      .filter(([, s]) => new RegExp('\\b' + w + '\\b').test(s)).map(([f]) => f);
    if (hit.length) { dirty++; err(`旧的 ${w} 在 ${hit.join('/')} 里还有残留（两套状态会打架）`); }
  });
  if (!dirty) ok('旧的 loopMode / shuffled / btnShuffle / btnLoop 已全部清干净');

  if (!/id="btnMode"/.test(html)) err('播放条上没有 #btnMode');
  else if (!/\$\('btnMode'\)\.addEventListener/.test(appjs)) err('#btnMode 没有绑定点击');
  else ok('播放模式按钮 #btnMode 存在且绑定了点击');

  // ★ v2.9.0：这个正则原来是在**整个 app.js** 里捞 `{id:'x', icon:'i-y'}`，
  //   后来「批量选择」的动作表（selActions）也长成这个形状，一捞就多出 4 条 → 误报。
  //   现在先切出 PLAY_MODES 那一段再捞，断言才真的在验"播放模式四态"。
  const pmBody = (appjs.split('const PLAY_MODES')[1] || '').split('];')[0];
  const ids = [...pmBody.matchAll(/\{\s*id:\s*'(\w+)',\s*icon:\s*'(i-[\w-]+)'/g)].map((m) => [m[1], m[2]]);
  const want = [['list', 'i-repeat'], ['one', 'i-repeat1'], ['shuffle', 'i-shuffle'], ['order', 'i-order']];
  const bad = want.filter(([id, icon]) => !ids.some(([a, b]) => a === id && b === icon));
  if (ids.length !== 4 || bad.length) err(`PLAY_MODES 四态不完整（缺：${bad.map((b) => b[0]).join('/') || '数量 ' + ids.length}）`);
  else ok('四种模式齐全：列表循环 / 单曲循环 / 随机 / 顺序');

  if (!/function setPlayMode\(/.test(appjs) || !/btn\.classList\.toggle\('on'/.test(appjs))
    err('setPlayMode 没有同步按钮的图标/提示/高亮');
  else if (!/btn\.title = .*播放模式：/.test(appjs)) err('按钮提示里没写当前模式名');
  else ok('切模式时图标、提示文字、高亮一起变');

  // 顺序播放走到最后一首要停，不能绕回第一首
  if (!/function stopAtEnd\(/.test(appjs) || !/playMode === 'order'\)\s*\{\s*stopAtEnd\(\)/.test(appjs))
    err('顺序播放走到最后一首不会停（会绕回第一首）');
  else ok('顺序播放：走到最后一首会停（stopAtEnd）');

  // 单曲循环 / 随机播放都读同一个 playMode
  if (!/playMode === 'one'\)\s*\{\s*audio\.currentTime = 0/.test(appjs)) err('单曲循环没有读 playMode');
  else if (!/playMode === 'shuffle'\)/.test(appjs)) err('随机播放没有读 playMode');
  else ok('单曲循环 / 随机播放都读同一个 playMode（不会两套状态打架）');

  // 模式要记住
  if (!/playMode: 'list'/.test(appjs)) err('DEFAULT_SETTINGS 里没有 playMode 的默认值');
  else if (!/playMode:\s*isPlayModeId\(old\.playMode\)/.test(appjs)) err('老存档迁移时没有校验 playMode');
  else if (!/playMode = m\.id;/.test(appjs) || !/DB\.settings\.playMode = m\.id/.test(appjs))
    err('切模式后没有写进存档');
  else ok('模式默认列表循环 + 老存档校验 + 切换后写入存档');

  // 播放键要仍然居中（4 个按钮 + 等宽占位）
  if (!/\.ctrl-row::after\s*\{[^}]*width:\s*31px/.test(css))
    err('.ctrl-row 少了一个槽位的等宽占位，播放键会偏右');
  else ok('.ctrl-row::after 用 31px 等宽占位，播放键保持居中');
}

/* ---- 32) 合集单集启用 / 禁用 ---- */
console.log('\n[32] 合集里单集启用 / 禁用：');
{
  // 兜底写法两种都算：`X = X || {}` 或 `X = (X && typeof X === 'object') ? X : {}`
  const guarded = (name) => new RegExp(`DB\\.${name}\\s*=[^;]*?\\|\\|\\s*\\{\\}`).test(appjs)
    || new RegExp(`DB\\.${name}\\s*=\\s*\\([^;]*?\\)\\s*\\?\\s*DB\\.${name}\\s*:\\s*\\{\\}`).test(appjs);

  if (!guarded('collectOff'))
    err('启动时没有给 DB.collectOff 兜底（老存档会读到 undefined）');
  else if (!guarded('collectParts'))
    err('启动时没有给 DB.collectParts 兜底');
  else ok('存档字段 collectOff / collectParts 有兜底（老存档不会崩）');

  if (!/function entryKey\(/.test(appjs) || !/return `\$\{e\.bvid\}#\$\{/.test(appjs))
    err('没有 entryKey（单集的唯一键）：分P 靠 cid 区分，键必须带上它');
  else ok('单集键 = bvid#cid（分P 与合集集数都能唯一定位）');

  if (!/function isEntryOff\(/.test(appjs) || !/function setEntryOff\(/.test(appjs))
    err('缺少单集开关的读 / 写函数');
  else if (!/persistLater\(\);/.test(appjs.slice(appjs.indexOf('function setEntryOff'))))
    err('setEntryOff 没有落盘（重启后开关就丢了）');
  else ok('单集开关有读有写，且改动会写进存档');

  if (!/function enabledEntries\(/.test(appjs) || !/function enabledCount\(/.test(appjs))
    err('缺少只取"启用的那几集"的函数（播放 / 数量统计都要用）');
  else ok('enabledEntries / enabledCount 齐全');

  if (!/data-cact="toggle"/.test(appjs)) err('合集面板每一行没有启用/禁用开关');
  else if (!/id: 'i-off'|i-off/.test(appjs)) err('禁用态没有图标');
  else ok('合集面板每一行都有启用/禁用图标按钮');

  if (!/id="btnCollectToggleAll"/.test(html)) err('合集面板顶部没有"一键全部启用/禁用"按钮');
  else if (!/btnCollectToggleAll'\)\.addEventListener/.test(appjs)) err('一键按钮没有绑定');
  else ok('顶部一键「全部启用 / 全部禁用」存在且绑定');

  if (!/已启用 \$\{on\.length\}\/\$\{entries\.length\} 集/.test(appjs))
    err('副标题没有显示"已启用 x/y 集"');
  else ok('副标题实时显示"已启用 x/y 集"');

  if (!/function collectionBadgeLabel\(/.test(appjs) || !/\$\{kind\} \$\{on\}\/\$\{n\}/.test(appjs))
    err('列表行徽章没有显示启用数（看不出一行被筛过）');
  else ok('徽章在有禁用时显示「选集 12/134」');

  if (!/\.collect-row\.off \.ct/.test(css) || !/text-decoration: line-through/.test(css))
    err('禁用的那一集没有视觉区分（划掉 / 变暗）');
  else ok('禁用的那一集文字划掉并变暗，且按钮保持可见（好放回来）');
}

/* ---- 33) 合集摊平进播放序列 ---- */
console.log('\n[33] 合集摊平进播放序列（顺序/随机/循环都算上它）：');
{
  if (!/async function buildSequence\(/.test(appjs)) err('缺少 buildSequence()：合集还是只当一行播');
  else ok('有 buildSequence() 负责把合集摊平成真正的播放序列');

  const body = appjs.slice(appjs.indexOf('async function buildSequence'), appjs.indexOf('/** 点面板里的某一集'));
  if (!/const on = enabledEntries\(t, got\)/.test(body)) err('摊平时没有过滤被禁用的单集');
  else if (!/if \(!on\.length\) continue;/.test(body)) err('整行被禁完时没有跳过这一行');
  else if (!/on\.forEach\(\(e\) => list\.push\(e\)\)/.test(body)) err('摊平后没有把每一集放进序列');
  else ok('摊平时跳过被禁用的单集；整行禁完则跳过该行');

  if (!/Promise\.all\(workers\)/.test(body) || !/Math\.min\(4, pending\.length\)/.test(body))
    err('合集的曲目表不是并发预取的（列表里有多条合集时，点击后要一条一条等）');
  else ok('合集曲目表并发预取（最多同时 4 条，避免 B 站限流）');

  if (!/startOf\[i\] = list\.length/.test(body)) err('没有记录"界面第 i 行对应序列的哪个位置"（点行播放会播错）');
  else ok('用 startOf[] 记住每一行在序列里的起点（点哪一行就从哪一行开始播）');

  if (!/if \(got === null\)/.test(body) || !/list\.push\(t\);/.test(body))
    err('合集读取失败时没有退化成"只播这一首"');
  else ok('合集读取失败只退化成单曲，不会让整张列表播不了');

  if (!/await buildSequence\(tracks\)/.test(appjs)) err('startFromView 没有调用 buildSequence');
  else ok('所有播放入口经 startFromView → buildSequence');

  // 正在播合集的某一集时，外面那一行要跟着高亮
  if (!/function rowIsPlaying\(/.test(appjs) || !/DB\.collectParts\[track\.bvid\]/.test(appjs))
    err('列表高亮没有认领"正在播的合集子条目"（会没有任何一行是亮的）');
  else if (!/const playing = rowIsPlaying\(track\)/.test(appjs)) err('trackRow 没有用 rowIsPlaying');
  else ok('正在播合集的第 N 集时，外面那一行保持高亮');

  /* ---- v2.0.3：上面那条规则以前写得太宽，把"同一支视频里的其它集"也一起点亮了 ----
     分P视频的每一集**共用同一个 bvid**（靠 cid 区分），所以"只比 bvid"会让
     "最近播放"里播过的每一集全部显示成"正在播放"。闸门必须落在 rowIsPlaying 函数体**里面**
     ——（`if (isCollectPart(track)) return false;` 在 maybeCollection 里也有一份，
     全文搜会假通过，所以这里先把函数体抠出来再查。） */
  const ripBody = (() => {
    const m = /function rowIsPlaying\(track\)\s*\{([\s\S]*?)\n\}/.exec(appjs);
    return m ? m[1] : '';
  })();
  if (!ripBody) err('抠不出 rowIsPlaying 的函数体（v2.0.3 的闸门没法验）');
  else if (!/if \(isCollectPart\(track\)\) return false;/.test(ripBody))
    err('rowIsPlaying 缺 v2.0.3 的闸门：分P 的每一集共用 bvid，"最近播放"里播过的每一集都会点亮');
  else if (/DB\.collectParts\[cur\.bvid\]/.test(ripBody))
    err('rowIsPlaying 里还留着"拿正在播那首的曲目表反查"那条 —— 会把同合集的其它集一起点亮');
  else ok('"合集里的一集"自己不再跟着亮（v2.0.3：修掉"最近播放整列高亮"）');

  // 缓存：展开过一次就不再等网络；存的是剥掉封面的曲目表
  if (!/DB\.collectParts\[track\.bvid\] = entries\.map\(\(e\) => \(\{/.test(appjs))
    err('摊平结果没有缓存到本地（每次播放都要等网络）');
  else if (!/bvid: e\.bvid, cid: e\.cid, page: e\.page,/.test(appjs))
    err('缓存里存了多余字段（封面 URL 是长链接，上百集会把存档撑大）');
  else ok('摊平结果剥掉封面后缓存到 collectParts，第二次起即时开播');

  if (!/const collectFetching = new Map\(\)/.test(appjs)) err('没有合并同一 bvid 的并发请求');
  else ok('同一个合集同时只查一次（播放与面板撞一起也不重复发请求）');

  // 合集里的一集自己和父合集共用 bvid，要靠 cid 比对认出来；认出来了就别再挂父合集的数量
  if (!/function isCollectPart\(/.test(appjs)) err('没有 isCollectPart：分不出"一条合集"和"合集里的一集"');
  else if (!/if \(isCollectPart\(track\)\) return false;/.test(appjs))
    err('分P 行仍会挂上父合集的徽章（每一集都写"选集 132/134"，看不懂）');
  else ok('分P 行被认出是"合集中的一集"，不再挂父合集的徽章数量');

  /* 隐私保险丝：使用数据（设置 / 歌单 / 收藏 / 历史 / B站Cookie / 背景图）
     只准待在 %APPDATA%\neko-music\，一个字都不许进仓库。
     这里查三件事：.gitignore 有没有保险条目、当前有没有被跟踪、历史里有没有出现过。 */
  const gitignore = read('.gitignore');
  const PRIVATE = ['neko-data.json', 'cookie.txt', 'backgrounds/'];
  const noGuard = PRIVATE.filter((f) => !gitignore.includes(f));
  if (noGuard.length) err(`.gitignore 缺隐私保险条目：${noGuard.join(' / ')}（将来误生成到项目目录就会被提交）`);
  else ok('.gitignore 有隐私保险：存档 / Cookie / 背景图 都不会被提交');

  try {
    const { execSync } = require('child_process');
    const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const tracked = run('git ls-files');
    const leakedNow = PRIVATE.filter((f) => tracked.includes(f));
    if (leakedNow.length) err(`仓库正在跟踪使用数据：${leakedNow.join(' / ')}（立刻 git rm --cached 掉）`);
    else ok('仓库当前没有跟踪任何使用数据文件');

    const history = run('git log --all --pretty=format: --name-only');
    const leakedEver = PRIVATE.filter((f) => history.includes(f));
    if (leakedEver.length) err(`历史提交里出现过使用数据：${leakedEver.join(' / ')}（推送前必须清理历史，否则永远擦不掉）`);
    else ok('历史提交里从未出现过使用数据（推送不会翻出旧数据）');
  } catch (_) {
    // 没有 git 环境就跳过，不算失败（避免在别人机器上误报）
  }
}

/* ---- 36) 启动默认进「发现」+ 侧栏高亮跟着界面走 ---- */
console.log('\n[36] 启动默认「发现」+ 侧栏高亮同步：');
{
  if (!/let currentView = 'discovery';/.test(appjs))
    err('currentView 初值不是 discovery（启动会停在空搜索页）');
  else ok("启动默认落在「发现」（currentView 初值 = 'discovery'）");

  if (!/function syncNavHighlight\(/.test(appjs)) err('缺少 syncNavHighlight()：侧栏高亮不会跟着界面走');
  else if (!/syncNavHighlight\(\);/.test(appjs)) err('renderAll() 没有调用 syncNavHighlight()');
  else if (!/n\.dataset\.view === currentView/.test(appjs)) err('syncNavHighlight() 没有按 currentView 点亮对应项');
  else ok('侧栏高亮由 renderAll → syncNavHighlight() 统一刷（不再只在点侧栏时更新）');

  // nav 点击处理里不该再手动改 class（否则和 syncNavHighlight 两套逻辑打架）
  if (/querySelectorAll\('\.nav-item'\)\.forEach\(\(n\)\s*=>\s*n\.classList\.remove\('active'\)\)/.test(appjs))
    err('nav 点击处理里还留着手动改 class 的旧写法（和 syncNavHighlight 重复）');
  else ok('nav 点击处理已改为只设 currentView，高亮交给 syncNavHighlight');

  // "回退到搜索页"的地方都要改指「发现」，只剩顶部搜索框那 1 处切到 search
  const searchSet = (appjs.match(/currentView = 'search'/g) || []).length;
  if (searchSet !== 1) {
    err(`还有 ${searchSet} 处把 currentView 设成 'search'（只应剩顶部搜索框那 1 处）`);
  } else if (!/currentView = 'search';\s*\n\s*doSearch\(kw, 1\);/.test(appjs)) {
    err("剩下的那处 search 不是顶部搜索框的入口");
  } else if (!/if \(!upState\) \{ currentView = 'discovery'; renderAll\(\); return; \}/.test(appjs)) {
    err('UP 页无数据时的回退没改指「发现」');
  } else if (!/if \(id === 'btnUpBack'\) \{ currentView = 'discovery'; renderAll\(\); return; \}/.test(appjs)) {
    err('UP 页「← 返回」没改指「发现」');
  } else ok('只剩顶部搜索框 1 处切到搜索结果页，其它回退都改指「发现」');
}

/* ---- 37) 动态背景（主进程）：bg:// 流式 + Range + 视频类型 + CSP ---- */
console.log('\n[37] 动态背景 · 主进程通道：');
{
  // 协议实现抽在 bg-protocol.js 里（main.js 负责传目录并注册）
  if (!/registerBgProtocol\(BG_DIR\)/.test(mainjs) || !/require\('\.\/bg-protocol'\)/.test(mainjs))
    err('main.js 没有把 bg:// 协议交给 bg-protocol.js 注册');
  else ok('main.js 把 bg:// 协议交给 bg-protocol.js（传 BG_DIR 注册）');

  if (!/fs\.createReadStream\(file, \{ start, end \}\)/.test(bgproto))
    err('bg:// 还在一次性读整份文件（视频会吃满内存）—— 要改成 createReadStream 分段读');
  else ok('bg:// 改用 createReadStream 分段读（视频不再一次性进内存）');

  if (!/Content-Range/.test(bgproto) || !/status = 206/.test(bgproto) || !/Accept-Ranges/.test(bgproto))
    err('bg:// 没实现 Range（视频拖动 / 循环回绕会失败）');
  else ok('bg:// 支持 Range：返回 206 + Content-Range + Accept-Ranges');

  if (!/Readable\.toWeb\(/.test(bgproto)) err('Node 流没有转成网页的 ReadableStream（Response 拿不到 body）');
  else ok('Node 文件流转成 ReadableStream 交给 Response');

  if (!/require\('stream'\)/.test(bgproto)) err("没引入 require('stream')");
  else ok("引入了 require('stream') 的 Readable");

  const missV = ['.mp4', '.webm', '.mov'].filter((e) => !bgproto.includes("'" + e + "'"));
  if (missV.length) err(`BG_MIME 缺视频类型：${missV.join(' / ')}`);
  else ok('BG_MIME 含 mp4 / webm / mov');

  if (!/BG_VIDEO_MAX_MB/.test(bgproto)) err('没有视频大小上限（几十上百 MB 的视频会让界面卡住）');
  else if (!/isVideo && sizeMB > BG_VIDEO_MAX_MB/.test(mainjs)) err('没有对超限视频给出提示并拒绝');
  else ok('视频有大小上限，超限会被拒绝并提示换小的');

  if (!/isVideo\s*\?\s*'video'\s*:\s*'image'/.test(mainjs)) err("bg:pick 没有按 kind 区分图片 / 视频");
  else ok("bg:pick 支持 kind='image' / 'video' 两种选择");

  if (!/media-src 'self' bili: bg:/.test(html)) err('CSP 的 media-src 没放行 bg: —— 视频会被安全策略拦下');
  else ok('CSP media-src 放行了 bg:（视频能加载）');
}

/* ---- 38) 动态背景（渲染层）：video 元素 + 显示分支 + 存档兜底 + 设置交互 ---- */
console.log('\n[38] 动态背景 · 渲染层：');
{
  if (!/id="bgVideo"/.test(html)) err('index.html 背景层里没有 <video id="bgVideo">');
  else ok('背景层里有 <video id="bgVideo">');

  if (!/\.bg-layer #bgVideo\b/.test(css) || !/object-fit:\s*cover/.test(css))
    err('#bgVideo 没有铺满 + object-fit:cover 的样式');
  else ok('#bgVideo 铺满整层并等比裁切');

  if (!/s\.bg\.kind === 'video'/.test(appjs)) err("applyAppearance() 没有按 settings.bg.kind 区分图片 / 视频");
  else ok('applyAppearance() 按 bg.kind 显示图片或视频');

  if (!/v\.play\(\)/.test(appjs) || !/v\.pause\(\)/.test(appjs))
    err('视频背景没有 play/pause（切走时不会停，白耗电）');
  else ok('视频背景有 play / pause（切回图片或最小化时会停）');

  if (!/v\.muted = vv\.muted !== false/.test(appjs) || !/v\.loop\s*=\s*vv\.loop\s*!== false/.test(appjs))
    err('视频的静音 / 循环没有从设置读出来');
  else ok('视频的静音 / 循环 / 速度都从设置读出来');

  if (!/DB\.settings\.bg\.kind = DB\.settings\.bg\.kind === 'video' \? 'video' : 'image'/.test(appjs))
    err('migrateSettings() 没有给 bg.kind 兜底（老存档会读出 undefined）');
  else if (!/DB\.settings\.bg\.video = \{/.test(appjs))
    err('migrateSettings() 没有给 bg.video 补默认值');
  else ok('老存档零迁移：缺 kind → image，缺 video → 补默认');

  if (!/id="btnPickBgVideo"/.test(html) || !/api\('pickVideoBackground'\)/.test(appjs))
    err('设置面板没有「选择视频」按钮，或没绑定到 IPC');
  else ok('设置面板有「选择视频」按钮且绑定了 IPC');

  if (!/pickVideoBackground:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('bg:pick',\s*'video'\)/.test(preload))
    err('preload 没有暴露 pickVideoBackground');
  else ok("preload 暴露了 pickVideoBackground（走 bg:pick + 'video'）");

  if (!/id="chkVideoMuted"/.test(html) || !/id="chkVideoLoop"/.test(html) || !/id="rngVideoSpeed"/.test(html))
    err('视频专属开关（静音 / 循环 / 速度）不齐');
  else ok('视频专属开关齐全：静音 / 循环 / 播放速度');

  // 换背景时要把 kind 同步切过去，否则会"选了图片却还在播视频"
  if (!/DB\.settings\.bg\.kind = 'image';/.test(appjs) || !/DB\.settings\.bg\.kind = 'video';/.test(appjs))
    err('换背景时没有同步切换 kind（选了图却还在播视频）');
  else ok('换图片 / 换视频时 kind 同步切换');
}

/* ---- 39) 动态背景随窗口缩放（<video> 是替换元素，inset:0 拉不满，必须显式写 100%） ---- */
console.log('\n[39] 动态背景 · 随窗口等比缩放：');
{
  const m = /\.bg-layer #bgVideo\s*\{([\s\S]*?)\}/.exec(css);
  const rule = m ? m[1] : '';
  if (!rule) err('找不到 .bg-layer #bgVideo 的样式规则');
  else {
    if (!/width:\s*100%/.test(rule))
      err('#bgVideo 没写 width:100% —— <video> 是替换元素，inset:0 拉不满，盒子会恒等于素材分辨率（窗口小就只露左上角一块）');
    else ok('#bgVideo 显式写了 width:100%');
    if (!/height:\s*100%/.test(rule)) err('#bgVideo 没写 height:100%');
    else ok('#bgVideo 显式写了 height:100%');
    if (!/object-fit:\s*cover/.test(rule)) err('#bgVideo 没有 object-fit:cover（会拉伸变形）');
    else ok('#bgVideo 用 object-fit:cover 等比裁切');
  }
}

/* ---- 40) 面板毛玻璃三档（plain / prebake / live）---- */
console.log('\n[40] 面板毛玻璃 · 三档：');
{
  const panels = ['titlebar', 'sidebar', 'topbar', 'player'];

  // .bg-layer 本体不许再挂 filter —— 挂了就等于"每解码一帧把整层（含视频）重糊一遍"
  const lm = /(^|\n)\.bg-layer\s*\{([\s\S]*?)\}/.exec(css);
  const layerRule = lm ? lm[2] : '';
  if (!layerRule) err('找不到 .bg-layer 的样式规则');
  else if (/(^|[^-\w])filter\s*:/.test(layerRule))
    err('.bg-layer 上还挂着 filter —— 会连视频一起每帧重糊，显卡白烧');
  else ok('.bg-layer 上不再挂 filter（视频不参与模糊）');

  // 图片的模糊下沉到 .bg-image
  const im = /(^|\n)\.bg-layer \.bg-image\s*\{([\s\S]*?)\}/.exec(css);
  const imgRule = im ? im[2] : '';
  if (!imgRule) err('没有 .bg-layer .bg-image 规则（图片背景的模糊应该挂在它身上）');
  else if (!/filter:\s*blur\(var\(--bg-blur\)\)/.test(imgRule))
    err('.bg-image 没有 filter:blur(var(--bg-blur))（图片背景的模糊滑杆会失效）');
  else ok('.bg-image 承载图片背景的模糊');

  if (!/id="bgImage"/.test(html)) err('index.html 背景层里没有独立的图片层 <div class="bg-image" id="bgImage">');
  else ok('背景层里图片 / 视频是两个兄弟节点');

  // app.js 的 filter 要挪到 #bgImage 上
  if (!/\$\('bgImage'\)/.test(appjs)) err("applyAppearance() 没有把模糊设到 #bgImage 上");
  else if (/layer\.style\.filter/.test(appjs)) err('还在往 .bg-layer 上设 filter（应该设到 #bgImage）');
  else ok('模糊由 applyAppearance() 设到 #bgImage 上');

  // 三档：plain / prebake 关掉真 backdrop-filter，live 保留
  const missPanels = panels.filter((p) =>
    !new RegExp('body\\.glass-plain \\.' + p + '\\b').test(css) ||
    !new RegExp('body\\.glass-prebake \\.' + p + '\\b').test(css));
  if (missPanels.length) err('body.glass-plain / glass-prebake 下没有覆盖这些常驻面板：' + missPanels.join(' / '));
  else ok('glass-plain / glass-prebake 覆盖了 4 块常驻面板');

  // 遮罩层也要跟着档位走（S4）
  const missOverlay = ['modal', 'collect-panel', 'modal-mask'].filter((c) =>
    !new RegExp('body\\.glass-plain \\.' + c + '\\b').test(css));
  if (missOverlay.length) err('遮罩层没有跟随档位（只有 live 该保留真模糊）：' + missOverlay.join(' / '));
  else ok('3 个遮罩层也跟随档位');

  if (!/body\.glass-plain[\s\S]{0,900}?backdrop-filter:\s*none/.test(css))
    err('glass-plain 下没有把 backdrop-filter 设成 none（用 blur(0px) 仍会把背后画面拷进纹理，省不下来）');
  else ok('glass-plain / glass-prebake 下把 backdrop-filter 设为 none');

  // ★ v2.0.2：--glass-boost 机制退役；四块面板的不透明度必须来自**同一个** --frame-a。
  //   （以前四块各写一个偏移量，导致"动态背景只在内容区看得见" + "四块框架看着不协调"。）
  if (/--glass-boost/.test(css))
    err('style.css 里还有 --glass-boost（v2.0.2 已删除该机制，面板底色统一由 --frame-a 控制）');
  else ok('--glass-boost 机制已移除');
  const offFrame = panels.filter((p) => {
    const r = new RegExp('(^|\\n)\\.' + p + '\\s*\\{([\\s\\S]*?)\\}').exec(css);
    if (!r) return true;
    const m = /--panel-a:([^;]*);/.exec(r[2]);
    return !m || !/^\s*var\(--frame-a\)\s*$/.test(m[1]);   // 必须"直接等于 --frame-a"，不许再 calc 偏移
  });
  if (offFrame.length) err('这些面板的 --panel-a 没有统一成 var(--frame-a)（四块会不一致）：' + offFrame.join(' / '));
  else ok('4 块面板的 --panel-a 统一来自 var(--frame-a)（不再各写偏移量）');

  const noPanelA = panels.filter((p) => {
    const r = new RegExp('(^|\\n)\\.' + p + '\\s*\\{([\\s\\S]*?)\\}').exec(css);
    return !r || !/--panel-a/.test(r[2]);
  });
  if (noPanelA.length) err('这些面板的底色没有走 --panel-a（三档共用它）：' + noPanelA.join(' / '));
  else ok('4 块面板的底色都走 --panel-a');

  // prebake：面板背景改用"预先糊好的图"，并复用全局背景压暗值
  const pre = /body\.glass-prebake\.has-imgbg[\s\S]{0,650}?\}/.exec(css);
  if (!pre) err('没有 body.glass-prebake.has-imgbg 的规则');
  else {
    if (!/var\(--glass-img\)/.test(pre[0])) err('prebake 档没有把面板背景接上 --glass-img（会退化成纯半透明）');
    else ok('prebake 档面板背景接上了 --glass-img（预先糊好的壁纸图）');
    if (!/linear-gradient\(rgb\(0 0 0 \/ var\(--bg-dim\)\),\s*rgb\(0 0 0 \/ var\(--bg-dim\)\)\)/.test(pre[0]))
      err('prebake 面板没有应用全局 --bg-dim（压暗滑杆只会影响内容区）');
    else ok('prebake 面板与内容区共用 --bg-dim 全局压暗值');
    if (!/fixed/.test(pre[0]))
      err('prebake 的面板背景没有 background-attachment:fixed —— 四块面板显示的就不是壁纸的"对应那一块"');
    else ok('prebake 用 background-attachment:fixed 对齐壁纸');
  }

  // 没有自定义背景时三档都不挂真模糊
  if (!/body:not\(\.has-bg\) \.titlebar/.test(css))
    err('没有自定义背景时没有把面板毛玻璃关掉（背后是纯色，糊了没收益）');
  else ok('没有自定义背景 → 面板一律不挂真模糊');

  // app.js 侧
  if (!/root\.style\.setProperty\('--bg-dim',\s*String\(s\.bg\.dim\s*\?\?\s*0\.55\)\)/.test(appjs))
    err('applyAppearance() 没有把背景压暗值设为全局变量 --bg-dim');
  else ok('applyAppearance() 把背景压暗值设为全局 --bg-dim');
  if (!/async function buildGlassImage/.test(appjs)) err('没有生成"预先糊好的图"的函数 buildGlassImage()');
  else ok('有 buildGlassImage() 生成预先糊好的图');
  if (!/glassImgState/.test(appjs)) err('预先糊好的图没有"该不该重生成"的状态记录');
  else ok('预先糊好的图有复用 / 重生成判断');
  if (!/ctx\.filter/.test(appjs)) err('没有用 canvas 的 ctx.filter 去糊图');
  else ok('用 canvas 一次性糊好（不是每帧重算）');
  if (!/crossOrigin/.test(appjs))
    err('加载背景图时没有 crossOrigin —— 画进 canvas 会污染画布，toDataURL() 会抛错');
  else ok('加载背景图带 crossOrigin（避免污染画布）');
  if (!/classList\.toggle\('glass-prebake'/.test(appjs) || !/classList\.toggle\('glass-live'/.test(appjs))
    err("applyAppearance() 没有按 glass.mode 给 <body> 切类");
  else ok('applyAppearance() 按 glass.mode 切 body 的类');
}

/* ---- 41) 省显卡 · 暂停规则 + 老存档迁移 + 改名「动态背景」 ---- */
console.log('\n[41] 省显卡 · 暂停规则 + 迁移 + 改名：');
{
  if (!/winFocused/.test(appjs) || !/addEventListener\('blur'/.test(appjs) || !/addEventListener\('focus'/.test(appjs))
    err('没有窗口失焦 / 回焦的暂停恢复（切到别的软件时窗口还露着，会一直烧显卡）');
  else ok('窗口失焦暂停、回焦恢复');

  if (!/function bgOverlayOpen/.test(appjs) || !/MutationObserver/.test(appjs))
    err('遮罩打开时没有暂停动态背景（设置面板盖在上面还在播）');
  else ok('任意遮罩开合都会重算播放状态');

  if (!/addEventListener\('visibilitychange',\s*updateBgVideoPlayback\)/.test(appjs))
    err('最小化 / 切后台的暂停没接上总闸');
  else ok('最小化 / 切后台暂停仍然生效');

  if (!/function updateBgVideoPlayback/.test(appjs)) err('没有统一的"该不该播"总闸 updateBgVideoPlayback()');
  else ok('播放 / 暂停统一由总闸 updateBgVideoPlayback() 判定');

  // L1 / S3：把看不见的动画停掉
  if (!/function syncPauseClasses/.test(appjs)) err('没有统一处理"看不见就别动"的 syncPauseClasses()');
  else ok('有 syncPauseClasses() 统一处理 L1 / S3');
  if (!/classList\.toggle\('has-overlay'/.test(appjs) ||
      !/classList\.toggle\('lyric-open'/.test(appjs) ||
      !/classList\.toggle\('perf-idle'/.test(appjs))
    err('has-overlay / lyric-open / perf-idle 三个类没齐');
  else ok('has-overlay / lyric-open / perf-idle 三个类都在');

  ['has-overlay', 'lyric-open', 'perf-idle'].forEach((cls) => {
    if (!new RegExp('body\\.' + cls + '[\\s\\S]{0,500}?animation-play-state:\\s*paused').test(css))
      err(`body.${cls} 下没有把无限动画设成 paused`);
    else ok(`body.${cls} 下暂停了无限动画`);
  });

  // 迁移
  if (!/DB\.settings\.glass\.mode\s*=/.test(appjs)) err('migrateSettings() 没有给 glass.mode 兜底');
  else ok('migrateSettings() 给 glass.mode 兜底（缺省 = prebake）');
  if (!/delete DB\.settings\.bg\.perfLite/.test(appjs)) err('退役的 bg.perfLite 字段没有被清掉');
  else ok('bg.perfLite 字段已退役');

  if (!/id="chkGlassPerf"/.test(html) || !/id="chkGlassLive"/.test(html))
    err('设置面板缺少「省显卡 / 实时毛玻璃」两个开关');
  else ok('设置面板有面板毛玻璃的两个开关');
  if (/id="chkPerfLite"/.test(html)) err('旧的「降低毛玻璃（省显卡）」开关还在');
  else ok('旧的 chkPerfLite 开关已删掉');

  if (!/id="glassLiveWarn"/.test(html)) err('没有"实时毛玻璃更费显卡"的常驻警示行');
  else ok('有常驻警示行（勾高画质才显示）');

  if (!/\.field\.is-off/.test(css) || !/id="fieldBgBlur"/.test(html))
    err('背景是视频时"背景模糊"滑杆没有置灰态');
  else ok('背景是视频时"背景模糊"滑杆置灰并说明原因');

  // 用户可见文案统一叫「动态背景」—— 连注释一起清，避免以后又混着写
  const srcFiles = ['src/ui/index.html', 'src/ui/app.js', 'src/ui/style.css', 'src/main.js', 'src/preload.js', 'src/bg-protocol.js'];
  const bad2 = srcFiles.filter((f) => read(f).includes('视频背景'));
  if (bad2.length) err('这些文件里还残留「视频背景」字样：' + bad2.join(' / '));
  else ok('源码里已无「视频背景」字样，统一叫「动态背景」');

  if (!/动态背景/.test(html)) err('设置面板标题没有改成「动态背景」');
  else ok('设置面板标题为「动态背景」');
}

/* ---- 42) 歌词页 · 透明化（P1） ---- */
console.log('\n[42] 歌词页 · 透明化：');
{
  const m = /(^|\n)\.lyric-overlay\s*\{([\s\S]*?)\}/.exec(css);
  const rule = m ? m[2] : '';
  if (!rule) err('找不到 .lyric-overlay 的样式规则');
  else {
    if (/backdrop-filter/.test(rule))
      err('.lyric-overlay 本体还挂着 backdrop-filter —— 那是"一坨黑"和显卡被打满的共同来源（该放到 body.glass-live 下）');
    else ok('.lyric-overlay 本体不再挂 backdrop-filter（只有 live 档才挂）');
    const bm = /background:\s*rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(rule);
    if (!bm) err('读不到 .lyric-overlay 的背景色（或写法不是 rgba）');
    else if (parseFloat(bm[1]) > 0.6) err(`.lyric-overlay 的背景还是太不透明（alpha=${bm[1]}），壁纸透不出来`);
    else ok(`.lyric-overlay 背景 alpha=${bm[1]} ≤ 0.6（壁纸能透出来）`);
  }
  if (!/body\.glass-live \.lyric-overlay[\s\S]{0,200}?backdrop-filter:\s*blur\(/.test(css))
    err('live 档下歌词页没有跟着糊（Neo 定的：高画质档歌词页要一起通透）');
  else ok('live 档下歌词页跟着糊');
  if (!/--lyric-blur/.test(css)) err('没有 --lyric-blur（歌词页的模糊半径该比面板更小）');
  else ok('歌词页用 --lyric-blur，半径比面板更小');

  const lm2 = /\.lyric-box \.l\s*\{([\s\S]*?)\}/.exec(css);
  if (!lm2 || !/text-shadow/.test(lm2[1])) err('歌词行没有 text-shadow —— 去掉糊背景后文字会读不清');
  else ok('歌词行有 text-shadow（可读性不靠糊背景）');

  // ★ v2.0.2：打开整页歌词时把内容区藏起来 —— 否则 34% 的浮层挡不住列表，上一个页面会透出来。
  //   藏的是 #content 的**子元素**（不是容器本身）：容器走的是"合成器隐藏整个滚动图层"，
  //   实测在离屏软件光栅下不重绘（计算样式是 hidden，画面照旧）；藏子元素才真正重绘成空。
  //   而且子元素 hidden 之后，它下面新渲染出来的行一律继承 hidden，不用再补规则。
  if (!/body\.lyric-open\s+#content\s*>\s*\*\s*\{\s*visibility:\s*hidden/.test(css))
    err('没有 body.lyric-open #content > * { visibility: hidden } —— 歌词页背后会透出上一个页面');
  else ok('歌词页打开时内容区（列表）被隐藏（背后只剩壁纸）');
  if (/body\.lyric-open\s+#content\s*[,{]/.test(css))
    err('歌词页把 #content 容器本身也藏了 —— 会丢滚动位置，而且那条在离屏下不重绘');
  else ok('只藏内容、不藏容器（布局与滚动位置不变）');
}

/* ---- 43) 歌词页 · 空状态（P2） ---- */
console.log('\n[43] 歌词页 · 空状态：');
{
  // ★ v2.1.0：以前这里是"全局搜 box.innerHTML = ''"，范围太宽 ——
  //   mini 展开态那块列表里也有一个 box.innerHTML = ''，会被这条误伤。
  //   改成"只有被清空的 box 确实是歌词区（$('lyricBox')）时才算问题"，
  //   这才是这条断言真正要守的东西。
  const blanked = [...appjs.matchAll(/innerHTML\s*=\s*''/g)]
    .filter((m) => /lyricBox/.test(appjs.slice(Math.max(0, m.index - 240), m.index)));
  if (blanked.length)
    err("取词失败时还是把歌词区清成空白（box.innerHTML = ''）");
  else ok('取词失败不再把歌词区清成空白');
  if (/（没有歌词）/.test(appjs)) err('还在用「（没有歌词）」那种空提示');
  else ok('不再用「（没有歌词）」占位');
  if (!/function renderLyricEmpty/.test(appjs)) err('没有 renderLyricEmpty()');
  else ok('有 renderLyricEmpty() 统一空状态');
  if (!/renderLyricEmpty\('failed'\)/.test(appjs) || !/renderLyricEmpty\('instrumental'\)/.test(appjs))
    err('纯音乐 / 取词失败两条路没有都走空状态');
  else ok('纯音乐 / 取词失败两条路都走空状态');
  if (!/lyric-empty/.test(appjs) || !/\.lyric-empty/.test(css)) err('空状态的 DOM / 样式不齐');
  else ok('空状态有 DOM 结构与样式');
  if (!/btnLyricRetry/.test(appjs)) err('空状态里没有「重新获取」按钮');
  else ok('空状态里有「重新获取」按钮');
}

/* ---- 44) 毛玻璃三档 · 数据与设置项 ---- */
console.log('\n[44] 毛玻璃三档 · 数据与设置项：');
{
  if (!/glass:\s*\{\s*blur:\s*12,\s*frameAlpha:\s*0\.12,\s*mode:\s*'prebake'\s*\}/.test(appjs))
    err("DEFAULT_SETTINGS.glass 不是 { blur:12, frameAlpha:0.12, mode:'prebake' }");
  else ok("默认设置 = blur 12 / frameAlpha 0.12 / mode 'prebake'");
  // 只允许"一行 delete 清理存档"提到旧字段；其余任何读写都算没退役干净
  const alphaUses = appjs.split('\n').filter((l) => /glass\.alpha/.test(l) && !/^\s*delete\b/.test(l));
  if (alphaUses.length) err('app.js 里还在读写 glass.alpha（v2.0.2 已由 glass.frameAlpha 取代）：' + alphaUses[0].trim());
  else ok('旧的 glass.alpha 已退役（存档里只留一行 delete 清理），改用 glass.frameAlpha');
  if (!/setProperty\('--frame-a'/.test(appjs))
    err('applyAppearance() 没有把面板不透明度写成全局 --frame-a');
  else ok('applyAppearance() 把面板不透明度写成全局 --frame-a');
  if (!/s\.glass\.mode === 'plain' \|\| s\.glass\.mode === 'live'/.test(appjs))
    err('没有对 glass.mode 做合法性校验（非法值该退回 prebake）');
  else ok('glass.mode 有合法性校验');
  if (/perfLite:/.test(appjs)) err('app.js 里还有 perfLite 的默认值（字段应退役）');
  else ok('app.js 里不再有 perfLite 默认值');
  if (!/chkGlassPerf/.test(appjs) || !/chkGlassLive/.test(appjs)) err('两个新开关没有绑定事件');
  else ok('两个新开关都绑了事件');
  if (!/function setGlassMode/.test(appjs)) err('没有 setGlassMode() 统一改档');
  else ok('有 setGlassMode() 统一改档');
  if (!/s\.glass\.blur\s*\?\?\s*12/.test(appjs))
    err('applyAppearance() 没有按 12px 的缺省写 --glass-blur');
  else ok('applyAppearance() 写 --glass-blur（缺省 12px）');
}

/* ---- 45) 性能 · 每帧重算的路径已拿掉 ---- */
console.log('\n[45] 性能 · 每帧重算的路径已拿掉 ｜ 播放请求的健壮性：');
{
  if (!/body\.has-overlay \.idx \.bars i/.test(css) || !/body\.perf-idle \.idx \.bars i/.test(css))
    err('has-overlay / perf-idle 没有暂停内容区跳动柱子');
  else ok('遮罩 / 窗口失焦时暂停内容区跳动柱子');
  if (/\.np-cover\.spin::before|@keyframes\s+coverSpin/.test(css) || /updateCoverSpin/.test(appjs))
    err('播放条封面仍残留旋转动画或播放状态切换逻辑');
  else ok('播放条封面不再有旋转动画');
  if (!/body\.lyric-open \.idx \.bars i/.test(css))
    err('打开整页歌词时没有暂停内容区的动画');
  else ok('打开整页歌词时暂停内容区动画');
  if (!/animation-play-state:\s*paused/.test(css)) err('没有任何"暂停无限动画"的规则');
  else ok('有"暂停无限动画"的规则');

  if (!/classList\.toggle\('has-imgbg'/.test(appjs)) err('没有 has-imgbg 类（prebake 的面板背景开关）');
  else ok('有 has-imgbg 类控制 prebake 的面板背景');

  if (/perf-lite/.test(appjs) || /perf-lite/.test(css))
    err('还残留 perf-lite（旧的省电方式应被 glass.mode 取代）');
  else ok('旧的 perf-lite 机制已彻底移除，改由 glass.mode 决定');

  if (!/BARS_ICON = `<span/.test(appjs)) err('柱子还是 SVG（SVG 的 transform 动画不走合成器，每帧重光栅化）');
  else ok('柱子已从 SVG 换成普通元素（走合成器）');
  if (/\.idx \.bars rect/.test(css)) err('CSS 里还留着 .idx .bars rect（SVG 那套）');
  else ok('CSS 里的柱子样式已改成普通元素');

  if (!/function updatePlayBtn/.test(appjs)) err('没有唯一的按钮刷新函数 updatePlayBtn()');
  else ok('有 updatePlayBtn()（图标只由 audio.paused 决定）');
  if (/addEventListener\(\s*'waiting'[\s\S]{0,160}?i-loading/.test(appjs))
    err("源码里还有 waiting → i-loading 的绑定（缓冲一次就永远转圈）");
  else ok('不再有 waiting → 转圈的绑定');

  /* ---- v2.0.4：播放请求的健壮性 ----
     playAt() 里有两段 await（补 cid / 取音频地址），期间用户又点了另一首时，
     后一次会把 audio.src 换掉，前一次还挂着的 audio.play() 就被浏览器打断并抛
     AbortError（"interrupted by a new load request"）。那**不是**取地址失败：
     旧代码会弹「播放失败」、还会 900ms 后自动跳下一首（莫名跳歌）。 */
  // playAt 的函数体（下面多条断言都要用，先抠出来）
  const playAtBody = (() => {
    const m = /async function playAt\(index\)\s*\{([\s\S]*?)\n\}/.exec(appjs);
    return m ? m[1] : '';
  })();
  if (!playAtBody) err('抠不出 playAt 的函数体（播放健壮性的断言没法验）');

  if (!/let playSeq = 0;/.test(appjs)) err('没有 playSeq：两次 playAt 会叠在一起跑，旧的请求回来还会抢播放器');
  else ok('有 playSeq（每次切歌领一个序号，旧的请求回来直接放弃）');

  if (!/function isPlayInterrupted\(/.test(appjs)) err('没有 isPlayInterrupted：分不出"被新加载打断"和"真失败"');
  else if (!/AbortError/.test(appjs) || !/interrupted by/.test(appjs))
    err('isPlayInterrupted 没有认 AbortError / "interrupted by"（Chromium 的消息末尾还会附媒体地址，必须用"包含"判断）');
  else ok('isPlayInterrupted 认得出"被打断"（AbortError / interrupted by…，不靠整串相等）');

  // ★ v2.0.5：再加一道**不依赖错误消息文字**的闸门 —— 地址被换过就算过期
  if (!/let lastSetSrc = '';/.test(appjs))
    err("没有 lastSetSrc：只靠消息文字判断「被打断」太脆（Chromium 会在消息末尾附媒体地址）");
  else if (!/lastSetSrc !== mySrc/.test(playAtBody))
    err('playAt 里没有"地址已被换掉 → 本次过期"的闸门（只认消息文字）');
  else if (!/\(mySrc && lastSetSrc !== mySrc\)/.test(playAtBody))
    err('那道闸门没有先确认"我们确实设过地址"（mySrc 为空时会误判成过期，把真失败也吞掉）');
  else ok('playAt 另有一道闸门：地址被换掉就判过期（不依赖错误消息文字）');

  if (!/function cleanPlayError\(/.test(appjs))
    err('没有 cleanPlayError：真失败时会把 Chromium 附的媒体地址一起弹出来（又长又难看）');
  else ok('真失败时剪掉消息末尾的媒体地址再弹提示');

  const gates = (playAtBody.match(/if \(seq !== playSeq\) return;/g) || []).length;
  if (gates < 3) err(`playAt 里的"过期就放弃"闸门只有 ${gates} 处（应当 ≥3：补 cid 后 / 取地址后 / play 后）`);
  else ok(`playAt 里有 ${gates} 处"过期就放弃"的闸门（旧的播放请求不会再来抢播放器）`);

  if (!/if \(isPlayInterrupted\(playErr\)/.test(playAtBody))
    err('playAt 把"被打断"当成真失败了（会弹「播放失败」+ 莫名跳歌）');
  else ok('playAt 把"被打断"静默忽略，不再误报、不再误跳');

  if (!/if \(seq === playSeq\) next\(1\);/.test(playAtBody))
    err('自动跳下一首没有序号闸门（过期的失败也会带着跳歌）');
  else ok('自动跳下一首只在"还是当前这一次播放"时才跳');

  if (!/function safePlay\(/.test(appjs)) err('没有 safePlay：播放条按钮那些不 await 的 play() 会留下未处理的 promise 拒绝');
  else if (/audio\.paused \? audio\.play\(\) : audio\.pause\(\);/.test(appjs))
    err('还有"不 await 且不接错"的 audio.play()（被打断时会变成未处理的 promise 拒绝）');
  else ok('播放条按钮统一走 safePlay()，被打断不会变成未处理的 promise 拒绝');
}

console.log('\n[46] 颜色语法 · 空格三元组只能配斜杠写法：');
{
  // 本项目有 4 组"空格分隔的 RGB 三元组"自定义属性：
  //   --glass-rgb / --accent-rgb / --accent-2-rgb / --sw / --sw2   （形如 16 16 26）
  // 它们套进 rgba() 会变成 rgba(16 16 26, .55) —— RGB 用空格、alpha 用逗号，
  // 这种混搭在 Chromium 里非法；而且因为是 var() 替换，报错时机在"computed-value 期"，
  // 属性会直接取**初始值**（background-color → transparent），不是回退到上一条声明。
  // 结果就是"整条样式静默失效"：面板没有底色、开关勾上不变色、正在播放那行的粉色渐变没了。
  // 正确写法只有斜杠：rgb(R G B / A)。（逗号三元组的 --accent-rgb 在 lyric.css 里，
  // 那是悬浮窗自己的一份变量，配 rgba(r, g, b, a) 是对的，不在本检查范围内。）
  const triplets = ['glass-rgb', 'accent-rgb', 'accent-2-rgb', 'sw', 'sw2'];
  const offenders = [];
  triplets.forEach((name) => {
    const re = new RegExp('rgba\\(\\s*var\\(--' + name + '\\)\\s*,', 'g');
    const hit = css.match(re);
    if (hit) offenders.push(`${name}×${hit.length}`);
  });
  if (offenders.length)
    err(`style.css 里还有非法写法 rgba(var(--…), α)：${offenders.join(' / ')} —— var() 替换后非法，属性会取初始值（透明）`);
  else ok('5 组空格三元组都没有配 rgba(var(--…), α) 这种非法写法');

  const slash = css.match(/rgb\(\s*var\(--(?:glass|accent|accent-2|sw|sw2)-?r?g?b?\)\s*\//g);
  if (!slash || slash.length < 10)
    err(`斜杠写法 rgb(var(--… ) / α) 只有 ${slash ? slash.length : 0} 处，半透明主题色可能整片失效`);
  else ok(`斜杠写法 rgb(var(--…) / α) 共 ${slash.length} 处`);

  if (!/linear-gradient\(rgb\(var\(--glass-rgb\) \/ var\(--frame-a\)\),\s*rgb\(var\(--glass-rgb\) \/ var\(--frame-a\)\)\)\s*center\/cover no-repeat fixed/.test(css))
    err('prebake 的上层暗罩没有用全局 var(--frame-a)（会与动态背景那条路不是一个来源、四块也不一致）');
  else ok('prebake 多层背景的上层暗罩与面板共用 var(--frame-a)，且保持斜杠颜色语法');

  // 开关勾上必须真的变色（曾经因为上面那个坑，勾上反而变成全透明）
  if (!/input:checked \+ \.switch \{ background: rgb\(var\(--accent-rgb\) \/ 0\.85\)/.test(css))
    err('开关"开"态的底色没写成斜杠语法 → 勾上会变成全透明（只剩白圆点）');
  else ok('开关"开"态用的是斜杠语法（勾上会显示主题色底槽）');

  // 反向兜底：全局再扫一遍有没有别的"空格 RGB + 逗号 alpha"混搭漏网
  const mixed = css.match(/rgba\(\s*\d+\s+\d+\s+\d+\s*,/g);
  if (mixed) err(`style.css 里还有 ${mixed.length} 处硬编码的 rgba(R G B, A) 混搭写法`);
  else ok('没有其它硬编码的 rgba(R G B, A) 混搭写法');
}

console.log('\n[47] 播放条 · 封面兜底 ｜ 歌词页「收起」不再常驻（v2.0.5）：');
{
  // ① 「收起」改成"移上去才出现"：.np-cover.open::after 里**不能**再有常驻的 opacity:1
  //    （出现时机交给上面那条 .np-cover:hover::after）。抠规则体再查，避免全文搜到别处。
  const openAfter = /\.np-cover\.open::after\s*\{([^}]*)\}/.exec(css);
  if (!openAfter) err('找不到 .np-cover.open::after 规则（歌词页开着时封面上的提示没了？）');
  else if (/opacity\s*:\s*1/.test(openAfter[1]))
    err('歌词页开着时「收起」还是常驻（.np-cover.open::after 里仍写着 opacity:1），会一直挡住封面');
  else ok('歌词页开着时「收起」不再常驻，鼠标移上去才出现');

  // ② 没封面时的音符兜底
  if (!/\.np-cover\.no-art\s*\{/.test(css))
    err('没有 .np-cover.no-art 的音符兜底：没封面时只剩一块纯色，看着像坏了');
  else if (!/\.np-cover\.no-art\s*\{[^}]*background-image\s*:\s*url\(/.test(css))
    err('.np-cover.no-art 里没有 background-image（兜底图形没画上）');
  else ok('没封面时有 .np-cover.no-art 的音符兜底（底图是内联 SVG data-URI）');

  // ③ app.js：没封面时挂 no-art（且不能再塞 'none' 把兜底盖掉）
  if (!/classList\.toggle\('no-art'/.test(appjs))
    err('app.js 里没有 no-art 类的切换 —— 兜底 CSS 永远不会生效');
  else if (/style\.backgroundImage\s*=\s*track\.cover\s*\?\s*`url\("?\$\{track\.cover\}"?\)`\s*:\s*'none'/.test(appjs))
    err("没封面时仍把 backgroundImage 设成 'none'（行内样式会盖掉 CSS 兜底）");
  else ok('没封面时挂 no-art，且不再把 backgroundImage 设成 none');

  // ④ 合集封面缓存：存缓存时记下、读缓存时套给每一条
  if (!/DB\.collectCovers/.test(appjs))
    err('没有 DB.collectCovers：重启后再播"展开过的合集"，缓存里没封面 → 播放条和列表封面全空');
  else if (!/DB\.collectCovers\[track\.bvid\]\s*=/.test(appjs))
    err('collectCovers 只读不写（存曲目表缓存时没把合集封面记下来）');
  else if (!/cachedCollectEntries\(/.test(appjs))
    err('读缓存时没有把合集封面套给每一条（collectEntriesFor 仍直接 return cached）');
  else ok('合集封面只存一张（collectCovers）：存缓存时记下、读缓存时套给每一条');
}

/* ---- 48) mini 模式（v2.1.0） ---- */
console.log('\n[48] mini 模式 · 同一个窗口换布局（v2.1.0）：');
{
  /* ---- ① index.html：按钮和图标都得在 ---- */
  if (!htmlIds.has('btnMini')) err('index.html 里没有 #btnMini（mini 模式的入口）');
  else if (!htmlIds.has('btnRestoreFull')) err('index.html 里没有 #btnRestoreFull（回完整模式的出口）');
  // ★ v2.9.0：#miniClose（关程序）换成了 #miniLyric（桌面歌词开关）。
  //   关程序还剩三条路：托盘菜单退出 / Alt+F4 / 回完整模式再点 ✕。
  //   所以这里盯的是"mini 条上那个歌词开关在不在"，而不是"关闭在不在"。
  else if (!htmlIds.has('miniLyric')) err('index.html 里没有 #miniLyric（mini 条上的桌面歌词开关）');
  else if (!htmlIds.has('miniActions')) err('index.html 里没有 .mini-actions 那一块');
  else if (!htmlIds.has('miniList')) err('index.html 里没有 #miniList（展开态的队列列表容器）');
  else ok('index.html：入口 / 出口 / 歌词开关 / 展开列表，四样都在');

  // 图标：照 #i-win-close 那一套画的两个新 symbol
  if (!/<symbol id="i-win-mini"/.test(html)) err('没有 #i-win-mini 这个 SVG symbol');
  else if (!/<symbol id="i-win-expand"/.test(html)) err('没有 #i-win-expand 这个 SVG symbol（mini 条的 ▢）');
  else ok('两个新图标 #i-win-mini / #i-win-expand 都定义了');

  // #btnMini 必须排在 #winMin 左边（顺序 = mini / 最小化 / 最大化 / 关闭）
  const iMini = html.indexOf('id="btnMini"');
  const iMin = html.indexOf('id="winMin"');
  if (iMini < 0 || iMin < 0 || iMini > iMin)
    err('#btnMini 不在 #winMin 左边 —— 标题栏按钮顺序不是 [mini][min][max][close]');
  else ok('标题栏顺序正确：#btnMini 在 #winMin 左边');

  /* ---- ② style.css：body.mini 那一节 ---- */
  if (!/body\.mini\s+\.app\s*\{/.test(css)) err('style.css 里没有 body.mini .app 那一节');
  else ok('style.css 有 body.mini .app（整个窗口只剩播放条）');

  // 收起态只留 player 一块
  const miniAppRule = /body\.mini\s+\.app\s*\{([^}]*)\}/.exec(css);
  if (!miniAppRule || !/grid-template-areas:\s*"player"/.test(miniAppRule[1]))
    err('mini 收起态没有把网格收成只有 "player" 一块');
  else ok('收起态网格只留 "player" 一块');

  // ★★ 铁律：mini 下给 .app（或它的祖先 body）加 transform/filter/opacity/will-change，
  //    会生成 backdrop root，把子元素的毛玻璃打成一块纯色。这是本项目最容易踩、也最难查的坑。
  const rootBodies = [
    ...css.matchAll(/body\.mini[^{]*\.app\s*\{([^}]*)\}/g),
    ...css.matchAll(/body\.mini\s*\{([^}]*)\}/g),
  ].map((m) => m[1]);
  const badProp = rootBodies
    .map((b) => (/(^|[\s;{])transform\s*:/.test(b) ? 'transform'
      : /(^|[\s;{])opacity\s*:/.test(b) ? 'opacity'
      : /(^|[\s;{])will-change\s*:/.test(b) ? 'will-change'
      : /(^|[\s;{])filter\s*:/.test(b) || /backdrop-filter\s*:/.test(b) ? 'filter' : null))
    .find(Boolean);
  if (badProp) err(`body.mini 下给 .app / body 加了 ${badProp} —— 会生成 backdrop root，毛玻璃会变成纯色`);
  else ok('body.mini 下没有给 .app / body 加 transform / filter / opacity / will-change');

  // .np / .volume 用 display:contents 让子元素直接参与 flex 布局（不改 HTML 结构的关键一招）
  if (!/body\.mini\s+\.np\s*,[\s\S]{0,40}body\.mini\s+\.volume\s*\{[^}]*display:\s*contents/.test(css))
    err('.np / .volume 没有 display:contents —— 封面和歌名拆不到两行去');
  else ok('.np / .volume 在 mini 下用 display:contents 让位');

  // 播放条整条是窗口把手（没有标题栏了）
  const miniPlayerRule = /body\.mini\s+\.player\s*\{([^}]*)\}/.exec(css);
  if (!miniPlayerRule || !/-webkit-app-region:\s*drag/.test(miniPlayerRule[1]))
    err('body.mini .player 没设成可拖动 —— mini 窗没有标题栏，会拖不动');
  else if (!/body\.mini\s+\.player\s+button[\s\S]{0,200}no-drag/.test(css))
    err('拖动区里的按钮没有单独放行 no-drag —— 会被拖动区吃掉点击、按不动');
  else ok('mini 播放条整条可拖动，里面的按钮都单独放行了 no-drag');

  // 平时（完整模式）必须藏起来 —— 否则它们会挤进 .player 那套三列网格，把布局撑坏
  if (!/\.mini-actions\s*\{[^}]*display:\s*none/.test(css))
    err('.mini-actions 平时没有 display:none —— 完整模式下会多出一列，播放条布局会被撑坏');
  else ok('.mini-actions 平时藏起来（不会挤进完整模式的播放条网格）');
  if (!/\.mini-list\s*\{[^}]*display:\s*none/.test(css))
    err('.mini-list 平时没有 display:none —— 会被自动塞进 .app 的隐式行');
  else ok('.mini-list 平时藏起来（不会在 .app 里多占一行）');

  /* ---- ★ v2.8.0：mini 收起态"第一行溢出"回归哨兵 ----
     症状（batch A 无意引入，round10 [3] 实测抓到）：.volume 在 mini 下是 display:contents，
     它的**每个直接子元素**都会顶替 .volume 参与播放条那一条 flex 布局。
     batch A 新加的 #btnDownload 既没有显式 order、也没有 display:none ——
     于是它以默认 order:0 排到封面**前面**，把整行右移 37px，
     ✕▢ 被 flex-wrap 挤到第二行去（实测 actions.y=68 而 cover.y=16）。
     修法：mini 下把 #btnDownload 也收起来（和 #btnOpenBili / .lyric-wrap 一视同仁）。
     这条断言就盯住"新加的 .volume 子元素有没有在 mini 下收干净"。 */
  if (!/body\.mini\s+#btnDownload[\s\S]{0,80}display:\s*none/.test(css))
    err('mini 下没有把 #btnDownload 收起来 —— 它会以 order:0 插到封面前面，把 ✕▢ 挤到第二行（round10 [3] 会 FAIL）');
  else ok('mini 下 #btnDownload 已收起（不会插队撑爆第一行）');

  // .volume 的直接子元素（在 mini 下 display:contents 时全部会上浮到播放条那一行）：
  // ★ 只看**一级子节点** —— 嵌在 .lyric-wrap / .vol-wrap 里的孙子元素（#btnLyric / #btnMute…）
  //   不会单独上浮，别把它们误判进来。做法：取 .volume 那一块，按 6 空格缩进找直接开的标签。
  const volBlock = /<div class="volume">([\s\S]*?)\n    <\/div>/.exec(html);
  if (!volBlock) err('取不到 .volume 那一块（HTML 结构变了？）');
  else {
    const volKids = [...volBlock[1].matchAll(/^ {6}<(?:button|div)[^>]*\bid="([^"]+)"/gm)].map((m) => m[1]);
    if (!volKids.length) err('.volume 的直接子元素一个都没取到（缩进 / 结构变了？）');
    else {
      const unhandled = volKids.filter((id) => {
        const hidden = new RegExp(`body\\.mini\\s+#${id}[\\s\\S]{0,80}display:\\s*none`).test(css);
        const ordered = new RegExp(`body\\.mini\\s+#${id}\\s*\\{[^}]*order:`).test(css);
        // 也可能是用 class 选择器归位的（例如 #volWrap → body.mini .vol-wrap { order:4 }）
        const cls = (new RegExp(`class="([^"]*)"[^>]*\\bid="${id}"`).exec(html) || new RegExp(`id="${id}"[^>]*class="([^"]*)"`).exec(html) || [])[1] || '';
        const orderedByClass = cls.split(/\s+/).filter(Boolean).some((c) => new RegExp(`body\\.mini\\s+\\.${c}\\s*\\{[^}]*order:`).test(css));
        const hiddenByClass = cls.split(/\s+/).filter(Boolean).some((c) => new RegExp(`body\\.mini\\s+\\.${c}[\\s\\S]{0,80}display:\\s*none`).test(css));
        return !(hidden || ordered || orderedByClass || hiddenByClass);
      });
      if (unhandled.length)
        err(`.volume 里这些直接子元素在 mini 下既没 display:none 也没显式 order：${unhandled.join(' / ')} —— 会以默认顺序插进播放条第一行把布局撑坏`);
      else ok(`.volume 的 ${volKids.length} 个直接子元素在 mini 下都已归位（收起或显式 order）`);
    }
  }

  // 展开态：播放条在上、列表在下
  if (!/body\.mini\.mini-open\s+\.app\s*\{[^}]*grid-template-areas:\s*"player"\s*"mini-list"/.test(css))
    err('mini 展开态没有把网格排成"播放条在上、队列列表在下"');
  else ok('展开态：播放条在上，队列列表在下');

  /* ---- ★ v2.4.0：mini 长歌名会把右边那排图标挤出窗口（Neo 报的真 bug） ---- */
  if (!/body\.mini\s+\.player\s*\{[^}]*min-width:\s*0/.test(css))
    err('body.mini .player 没有 min-width:0 —— 歌名一长播放条会被撑宽，右边那排图标会被挤出窗口');
  else ok('body.mini .player 有 min-width:0（长歌名撑不宽播放条）');
  if (!/body\.mini\s+\.np-title\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(css))
    err('body.mini .np-title 不是 flex:1 1 auto —— 标题不会先让位，作者名会被挤没');
  else ok('mini 下标题先让位（flex:1 1 auto）');
  if (!/body\.mini\s+\.np-sub\s*\{[^}]*max-width:\s*45%/.test(css))
    err('body.mini .np-sub 没有 max-width:45% —— 超长作者名会把标题挤没');
  else ok('mini 下作者名最多占 45%（短作者名原样显示）');

  /* ---- ★ v2.4.0：mini 是一条"悬浮小窗"，要跟桌面歌词一样置顶 ----
     实现落在 win-mini.js（独立模块，离线实测能拿真窗口验 isAlwaysOnTop），
     main.js 只负责"开窗时"和"ready-to-show 时"把档升上去。 */
  if (!/function setMiniAlwaysOnTop\(/.test(winmini))
    err('win-mini.js 没有 setMiniAlwaysOnTop —— mini 不会置顶');
  else if (!/setAlwaysOnTop\(!!on,\s*'screen-saver'\)/.test(winmini))
    err("mini 置顶没有用 'screen-saver' 这一档 —— 会被全屏程序盖住");
  else if (!/setMiniAlwaysOnTop\(win,\s*true\)/.test(winmini))
    err('applyMiniBounds 里没开置顶 —— 进 mini 不会浮起来');
  else if (!/setMiniAlwaysOnTop\(win,\s*false\)/.test(winmini))
    err('restoreFullBounds 里没关置顶 —— 退出 mini 会一直赖在最上面');
  else if (!/alwaysOnTop:\s*startMini/.test(mainjs))
    err('存档就是 mini 时，开窗没有置顶（首帧会闪一下被盖住）');
  else if (!/setMiniAlwaysOnTop\(mainWindow,\s*true\)/.test(mainjs))
    err('ready-to-show 里没升置顶档 —— mini 首帧不是最高档');
  else ok('mini 置顶：进/出 mini 双向开关 + 存档即 mini 时开窗即置顶（screen-saver 档）');

  /* ---- ③ app.js：设置、存档、绑定、快捷键 ---- */
  if (!/window:\s*\{\s*mini:\s*false/.test(appjs))
    err('DEFAULT_SETTINGS 里没有 window:{mini:false} —— 老存档没有这一项，缺省必须是"非 mini"');
  else ok('DEFAULT_SETTINGS 有 window 且缺省 mini:false（老存档零迁移）');
  if (!/old\.window\s*&&\s*old\.window\.mini/.test(appjs))
    err('migrateSettings 没有补 window 这一项');
  else ok('migrateSettings 会补齐 settings.window');

  for (const fn of ['applyMiniUI', 'setMini', 'renderMiniList', 'bindMini']) {
    if (!new RegExp(`function ${fn}\\b`).test(appjs)) { err(`app.js 里没有 ${fn}()`); }
  }
  if (!/function applyMiniUI[\s\S]*?function setMini/.test(appjs)) err('mini 的几个函数没找齐');
  else ok('applyMiniUI / setMini / renderMiniList / bindMini 都在');

  // 状态只能有一个来源：applyMiniUI 不能反过来再通知主进程（否则会来回死循环）
  const applyBody = /function applyMiniUI\([\s\S]*?\n\}/.exec(appjs);
  if (!applyBody) err('取不到 applyMiniUI 的函数体');
  else if (/winMini\(/.test(applyBody[0]))
    err('applyMiniUI 里又调了一次 winMini —— 主进程回推 → 改界面 → 再发消息，会转成死循环');
  else ok('applyMiniUI 只改界面、不回调主进程（不会和主进程来回打转）');

  if (!/window\.neko\.winMini\(/.test(appjs)) err('app.js 没请主进程调窗口（没有调 winMini）');
  else ok('app.js 会请主进程把窗口缩起来 / 还回去');
  if (!/window\.neko\.onWinMiniState\(/.test(appjs)) err('app.js 没有监听 win:mini-state 的回推');
  else ok('app.js 监听主进程回推的 mini 状态');
  if (!/window\.neko\.onWinBounds\(/.test(appjs)) err('app.js 没有监听 win:bounds（记不住窗口尺寸）');
  else ok('app.js 会把完整模式的窗口尺寸存下来');

  // ☰ 在 mini 下要改成"就地展开/收起"，不能再拉右侧抽屉
  if (!/\$\(\s*'btnQueue'\s*\)\.addEventListener\('click',[\s\S]{0,200}mini\.on/.test(appjs))
    err('mini 模式下 #btnQueue 仍然直接开右侧抽屉 —— 小窗里塞不下，应该是就地展开列表');
  else ok('mini 下 ☰ 改成"就地展开/收起队列列表"');

  // Ctrl+M（v2.3.0 起从 KEY_ACTIONS 表来，所以改成读表）
  if (keyDefOf('miniMode') !== 'Ctrl+m')
    err('KEY_ACTIONS 里没有「mini 模式 = Ctrl+M」这一条');
  else if (!/case 'miniMode':[\s\S]{0,120}?setMini\(!mini\.on, false\)/.test(appjs))
    err('miniMode 这个动作没有调用 setMini 切换');
  else ok('Ctrl+M 能进 / 出 mini 模式（现在从 KEY_ACTIONS 表来）');

  // 封面在 mini 下不再进歌词页
  if (!/function bindLyrics[\s\S]*?if \(mini\.on\) return;/.test(appjs))
    err('mini 下点封面仍会打开整页歌词 —— 132px 高的小窗里没法看，应该直接不响应');
  else ok('mini 下封面不再是歌词页入口（小窗里铺不开）');

  // 进 mini 时收起歌词大屏
  if (!/function setMini[\s\S]*?lyricState\.showing\)\s*toggleLyrics\(false\)/.test(appjs))
    err('进 mini 时没有把整页歌词收起来 —— 会留一个铺满小窗的歌词浮层');
  else ok('进 mini 时先收起整页歌词');

  // 启动时按存档恢复
  if (!/savedWin\.mini[\s\S]{0,200}applyMiniUI\(true/.test(appjs))
    err('boot() 没有按存档恢复 mini 状态 —— 上次缩在 mini，这次打开会"窗口小、界面却是完整的"');
  else ok('启动时按存档恢复 mini 状态');

  // 队列行 HTML 两处共用（抽屉 + mini 列表）
  if (!/function queueRowsHTML/.test(appjs))
    err('没有 queueRowsHTML()：抽屉和 mini 列表各画一套行，样式迟早跑偏');
  else if (!/renderMiniList[\s\S]{0,400}queueRowsHTML\(/.test(appjs))
    err('renderMiniList 没有复用 queueRowsHTML');
  else ok('mini 列表和队列抽屉共用同一份行 HTML');

  /* ---- ④ preload.js：三个新传话筒 ---- */
  for (const api of ['winMini', 'onWinMiniState', 'onWinBounds']) {
    if (!new RegExp(`${api}\\s*:`).test(preload)) err(`preload.js 没有暴露 ${api}()`);
  }
  if (!/winMini[\s\S]*onWinMiniState[\s\S]*onWinBounds/.test(preload)) err('preload 里的三个接口没找齐');
  else ok('preload 暴露了 winMini / onWinMiniState / onWinBounds');

  /* ---- ⑤ main.js：通道 + 尺寸记忆 + 三处加固 ---- */
  if (!/ipcMain\.on\('win:mini'/.test(mainjs)) err('main.js 没有 win:mini 通道');
  else ok('main.js 有 win:mini 通道');

  const miniHandler = /ipcMain\.on\('win:mini'[\s\S]*?\n  \}\);/.exec(mainjs);
  // ★ 真正的逻辑抽在 win-mini.js 里（为了离线实测能拿真窗口跑真逻辑），
  //   所以这条断言要跨两个文件看：main.js 负责"什么时候调"，win-mini.js 负责"怎么调"。
  const applyFn = /function applyMiniBounds\([\s\S]*?\n\}/.exec(winmini);
  const reqFn = /function handleMiniRequest\([\s\S]*?\n\}/.exec(winmini);
  if (!miniHandler) err('取不到 win:mini 的处理体');
  else if (!applyFn) err('win-mini.js 里没有 applyMiniBounds()');
  else if (!reqFn) err('win-mini.js 里没有 handleMiniRequest()');
  else {
    const body = miniHandler[0] + reqFn[0] + applyFn[0];
    const need = ['setMinimumSize', 'setMaximumSize', 'setResizable', 'getNormalBounds'];
    const lack = need.filter((n) => !body.includes(n));
    if (lack.length) err('win:mini 这条路上少了：' + lack.join(' / '));
    else ok('win:mini 会卡住最小/最大尺寸、关掉自由缩放，并记住完整模式的窗口样子');

    // 退出 mini 要还原成"进 mini 之前"的样子，而不是回默认尺寸
    if (!/restoreFullBounds\(win,\s*state\.fullBounds/.test(reqFn[0]))
      err('退出 mini 没有拿进 mini 前记下的 fullBounds 去还原 —— 会回到默认尺寸而不是原来的位置');
    else ok('退出 mini 会还原成进 mini 之前的大小和位置');

    // 主进程真的调了它（不是抽出来没人用）
    if (!/handleMiniRequest\(mainWindow/.test(miniHandler[0]))
      err('main.js 的 win:mini 没有调 handleMiniRequest()（抽出去的那份逻辑没人用）');
    else ok('main.js 的 win:mini 走的就是 win-mini.js 里那份逻辑');

    // 尺寸常数只许有一处定义（两处各写一份迟早对不上）
    if (!/MINI_W = 420/.test(winmini) || !/MINI_H_COLLAPSED = 132/.test(winmini) || !/MINI_H_EXPANDED = 520/.test(winmini))
      err('win-mini.js 里的两档尺寸不是 420×132 / 420×520');
    else ok('两档尺寸 420×132 / 420×520 只在 win-mini.js 定义一次');
  }

  // 三处加固（§6.2）
  if (!/hookWindowMessage\(0x0116/.test(mainjs))
    err('没有拦 WM_INITMENU(0x0116) —— 无边框窗口按 Alt+Space 会冒出系统菜单');
  else if (!/process\.platform === 'win32'[\s\S]{0,200}hookWindowMessage\(0x0116/.test(mainjs))
    err('hookWindowMessage 没有用 win32 判断包起来 —— 别的平台这个方法不存在，会直接抛错');
  else ok('拦掉了 Windows 系统菜单（WM_INITMENU 0x0116，且只在 win32 下挂）');

  if (!/before-input-event[\s\S]{0,200}preventDefault\(\)/.test(mainjs))
    err('没有拦 Ctrl+R —— 误按会把界面重载回首页，看着像崩了');
  else ok('拦掉了 Ctrl+R 刷新');

  if (!/context-menu'[\s\S]{0,200}preventDefault\(\)/.test(mainjs))
    err('没有拦 Chromium 的默认右键菜单');
  else ok('拦掉了 Chromium 默认右键菜单（输入框里放行，不然没法粘贴）');

  /* ---- ⑥ 窗口图标 ---- */
  if (!fs.existsSync(path.join(ROOT, 'src/assets/app.png')))
    err('src/assets/app.png 不存在 —— 任务栏 / Alt+Tab 里会是 Electron 的默认图标');
  else if (!/icon:\s*path\.join\(__dirname, 'assets', 'app\.png'\)/.test(mainjs))
    err('createWindow 没有把 icon 指到 assets/app.png');
  else ok('窗口图标已接上（src/assets/app.png）');
}

/* ============================================================
   [49] 托盘 / 任务栏缩略图按钮 / 关窗弹窗（v2.2.0）
   ============================================================ */
console.log('\n[49] 托盘 / 任务栏缩略图按钮 / 关窗弹窗（v2.2.0）：');
{
  /* ---- ① 单实例锁 ---- */
  if (!/requestSingleInstanceLock\(\)/.test(mainCode)) {
    err('main.js 没有 requestSingleInstanceLock —— 双击两次图标能开出两个软件，JumpList 任务也会各开一个抢存档');
  } else ok('main.js 有单实例锁（第二个进程直接退出）');

  // ★ 这里要**跨函数**看：second-instance 只负责"叫窗口 + 转交命令"，
  //   "最小化也要还原"那三步在 showMainWindow() 里（抽出来给托盘单击一起用）。
  const si = (mainCode.match(/app\.on\('second-instance'[\s\S]*?\n\}\);/) || [''])[0];
  const showFn = (mainCode.match(/function showMainWindow\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  if (!showFn) {
    err('没找到 showMainWindow()');
  } else if (!/isMinimized\(\)/.test(showFn) || !/\.restore\(\)/.test(showFn)) {
    err('showMainWindow 里没有 isMinimized → restore —— 窗口最小化时点图标会"什么都不发生"');
  } else if (!/\.show\(\)/.test(showFn) || !/\.focus\(\)/.test(showFn)) {
    err('showMainWindow 里少了 show() / focus()');
  } else if (!/showMainWindow\(\)/.test(si)) {
    err('second-instance 没有先调 showMainWindow —— 第二个实例启动时窗口不会露头');
  } else ok('second-instance → showMainWindow：restore → show → focus 三步都做（最小化时也能叫回来）');

  if (!/parseSecondInstanceCmd/.test(mainCode)) err('没有解析第二个实例带来的 --cmd= 参数 —— JumpList 任务点了没反应');
  else ok('会从第二个实例的 argv 里解析 --cmd=（且只认白名单里的命令）');

  /* ---- ② 安全与崩溃兜底 ---- */
  if (!/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/.test(mainCode)) {
    err('没有 setWindowOpenHandler deny —— target="_blank" / window.open 会开出没 preload 的原生窗口');
  } else ok('堵住了"原生新窗口"这个后门（setWindowOpenHandler deny）');

  if (!/process\.on\('uncaughtException'/.test(mainCode)) {
    err('没有 uncaughtException 兜底 —— 主进程崩了会留一个没反应的托盘图标，用户以为卡死了');
  } else ok('主进程崩溃时会主动退出（不留僵尸托盘图标）');

  /* ---- ③ 关窗流程 ---- */
  if (!/app\.on\('before-quit'[\s\S]{0,80}app\.quitting = true/.test(mainCode)) {
    err("没有在 before-quit 里设 app.quitting —— 托盘里的「退出」可能被当成缩小到托盘");
  } else ok("before-quit 会设 app.quitting（覆盖托盘退出 / Ctrl+Q / 系统关机所有路径）");

  const closeH = (mainCode.match(/mainWindow\.on\('close'[\s\S]*?\n  \}\);/) || [''])[0];
  if (!closeH) {
    err('没找到 mainWindow.on(\'close\') 的处理函数');
  } else {
    if (!/decideCloseAction/.test(closeH)) err('close 处理没有走 decideCloseAction（三态分叉）');
    else ok('close 处理走 decideCloseAction 分三态（quit / tray / ask）');

    if (!/action === 'quit'[\s\S]{0,160}requestMainWindowClose\(\)/.test(closeH)) {
      err('"真退出"分支没有走 requestMainWindowClose —— 会丢掉最后一次存盘');
    } else ok('真退出仍然走存盘握手（跳过弹窗，但不跳过存盘）');

    if (!/action === 'tray'[\s\S]{0,80}hideMainWindow\(\)/.test(closeH)) {
      err('"缩小到任务栏"分支没走 hideMainWindow');
    } else ok('"缩小到任务栏"走的是 hide()（后台播放靠这一点）');

    if (/action === 'tray'[\s\S]{0,80}mainWindow\.close\(\)/.test(closeH)) {
      err('★ "缩小到任务栏"居然调了 close() —— 会把后台播放直接弄没');
    }

    if (!/win:ask-close/.test(closeH)) err('close 处理里没有发 win:ask-close —— 缺省不会弹窗');
    else ok('缺省（ask）会发 win:ask-close，让界面弹窗');
  }

  /* ---- ④ 托盘 ---- */
  if (!/new Tray\(/.test(mainCode)) err('main.js 里没有 new Tray —— 图5 那个菜单没地方挂');
  else ok('main.js 建了托盘图标');

  if (!/tray\.ico/.test(mainCode)) err('托盘图标不是 .ico —— 高分屏（125% / 150%）会糊');
  else ok('托盘图标用的是 .ico（多分辨率容器，系统按 DPI 自己挑）');

  if (!/isEmpty\(\)/.test(mainCode)) err('没有 isEmpty() 检查 —— 图标路径写错时托盘会静默不出现，非常难查');
  else ok('图标加载失败会吭声（isEmpty 检查）');

  /* ★ v2.8.0：这条以前写成"will-quit' 之后 80 字符内必须出现 destroyTray()"——
     距离式断言，中间多插一行收尾代码（这次是下载收尾：停任务 + 强制落盘）就会误报。
     改成把 will-quit 的处理体整块抠出来，断言它**确实**调了 destroyTray()。
     判别力反而更强：以前只要 80 字符内出现过就算过，现在是"在处理体里"。 */
  const wqBlock = (mainCode.match(/app\.on\(\s*'will-quit'[\s\S]*?\n\}\);/) || [])[0] || '';
  if (!wqBlock) err("main.js 里找不到 app.on('will-quit', ...) 的处理体");
  else if (!/destroyTray\(\)/.test(wqBlock)) err('退出前没有销毁托盘图标 —— 它会残留在托盘里直到鼠标划过去');
  else ok('退出前会销毁托盘图标（不会残留到鼠标划过去）');

  if (!/tray\.setContextMenu\(/.test(mainCode)) err('托盘没有设置右键菜单');
  else ok('托盘挂上了右键菜单（状态一变就整个重建）');

  if (!/tray\.on\('click'/.test(mainCode)) err('托盘图标不能单击唤回窗口 —— "缩小到任务栏"之后就没出口了');
  else ok('单击 / 双击托盘图标能把窗口叫回来');

  if (!/if \(tray\) \{ tray\.destroy\(\)/.test(mainCode)) err('createTray 没有"先销毁旧的" —— 热重启会在托盘里留两个图标');
  else ok('建托盘前先销毁旧的（不会出现两个图标）');

  /* ---- ⑤ 菜单模板结构 ---- */
  const menuFn = (appmenus.match(/function buildTrayMenu\(state, h\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  if (!menuFn) err('app-menus.js 里没找到 buildTrayMenu');
  else {
    const subs = (menuFn.match(/submenu:/g) || []).length;
    if (subs < 2) err(`托盘菜单只有 ${subs} 个子菜单 —— 图5 有「播放模式 ▸」和「窗口模式 ▸」两个`);
    else ok(`托盘菜单有两个子菜单（播放模式 / 窗口模式）`);

    if (!/type: 'radio'/.test(menuFn)) err('子菜单里没有 type: radio —— 当前项不会打勾');
    else ok('子菜单用 radio 打勾标出当前项');

    if (!/type: 'checkbox'/.test(menuFn)) err('「锁定桌面歌词」没有做成 checkbox');
    else ok('「锁定桌面歌词」是 checkbox（能看到锁没锁）');

    const want = ['显示主窗口', '上一首', '下一首', '设置', '退出'];
    const miss = want.filter((l) => !menuFn.includes(`'${l}'`));
    if (miss.length) err('托盘菜单少了：' + miss.join(' / '));
    else ok('托盘菜单该有的项都在（显示主窗口 / 上一首 / 下一首 / 设置 / 退出 …）');

    if (!/enabled: false/.test(menuFn)) err('菜单里没有"只读"的当前歌名项（图5 第一项）');
    else ok('当前歌名是只读项（enabled: false）');

    if (!/s\.lyricOn \? '关闭桌面歌词' : '打开桌面歌词'/.test(menuFn)) err('歌词那项不是动态标签 —— 开着的时候还写着"打开"会很怪');
    else ok('歌词项标签跟着开关状态走（打开 ⇄ 关闭）');
  }

  /* ---- ⑥ 播放模式清单两边必须一致 ---- */
  const appModes = [...appjs.matchAll(/\{\s*id:\s*'(\w+)',\s*icon:\s*'[\w-]+',\s*name:\s*'([^']+)'\s*\}/g)].map((m) => m[1] + '=' + m[2]);
  const menuModes = [...appmenus.matchAll(/\{\s*id:\s*'(\w+)',\s*name:\s*'([^']+)'\s*\}/g)].map((m) => m[1] + '=' + m[2]);
  if (!appModes.length || !menuModes.length) {
    err('没解析到播放模式清单（两边的写法可能改了，正则要跟着改）');
  } else if (appModes.join('|') !== menuModes.join('|')) {
    err(`播放模式清单两边对不上：app.js [${appModes.join(' ')}] vs app-menus.js [${menuModes.join(' ')}]`);
  } else ok(`播放模式清单两边一致（${appModes.join(' / ')}）`);

  /* ---- ⑦ CLOSE_ACTIONS 两边必须一致 ---- */
  const normList = (s) => String(s || '').split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).join(',');
  const ca1 = normList((appjs.match(/const CLOSE_ACTIONS = \[([^\]]+)\]/) || [, ''])[1]);
  const ca2 = normList((appmenus.match(/const CLOSE_ACTIONS = \[([^\]]+)\]/) || [, ''])[1]);
  if (!ca1 || !ca2) err('两边的 CLOSE_ACTIONS 没找齐');
  else if (ca1 !== ca2) err(`CLOSE_ACTIONS 两边对不上：app.js [${ca1}] vs app-menus.js [${ca2}]`);
  else ok(`CLOSE_ACTIONS 两边一致（${ca1}）`);

  /* ---- ⑧ 任务栏缩略图按钮 ---- */
  const missThumb = ['setThumbarButtons', 'setThumbnailClip', 'setThumbnailToolTip'].filter((f) => !mainCode.includes(f));
  if (missThumb.length) err('main.js 里没有：' + missThumb.join(' / '));
  else ok('任务栏缩略图三件套齐了（按钮 / 裁剪区域 / 悬停提示）');

  if (!/nativeImage\.createFromPath/.test(mainCode)) err('图标不是用 nativeImage 读的 —— setThumbarButtons 不接受 SVG');
  else ok('图标走 nativeImage（setThumbarButtons 只吃这个）');

  if (!/coverRect/.test(appjs) || !/coverRect/.test(mainCode)) {
    err('缩略图裁哪一块不是由界面量好交给主进程的 —— 写死在主进程里，改一次 CSS 就错一次');
  } else ok('缩略图裁哪一块由界面量好交给主进程（coverRect）');

  if (!/thumbIcon\(playing \? 'pause' : 'play'\)/.test(mainCode)) err('播放 / 暂停按钮不会跟着状态换图标');
  else ok('播放 / 暂停按钮跟着播放状态换图标');

  /* ---- ⑨ JumpList（任务栏右键的「任务」） ---- */
  if (!/app\.setUserTasks\(/.test(mainCode)) err('没有 setUserTasks —— 任务栏右键看不到「任务」那一组');
  else ok('任务栏右键的「任务」已接上（阉割版，无子菜单 —— Windows 的硬限制）');

  if (!/--cmd=/.test(appmenus)) err('JumpList 任务没有带 --cmd= 参数 —— 点了不会有任何反应');
  else ok('JumpList 任务带 --cmd= 参数，靠单实例锁转交给已经在跑的窗口');

  if (!/app\.isPackaged/.test(mainCode)) err('JumpList 没有区分"打包后 / 开发期" —— 开发期点任务会开出一个空白 Electron');
  else ok('JumpList 在开发期会把工程目录一起带上（不会开出空白 Electron）');

  /* ---- ⑩ ★★ 存档"补洞"绝不许白名单重建 ---- */
  const migFn = (storemigrate.match(/function migrate\(data, opts\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  if (!migFn) {
    err('没找到 store-migrate.js 的 migrate 函数');
  } else if (/const s = \{/.test(migFn)) {
    err('★ migrate 又写成了"白名单重建"（const s = {）—— 每加一个新设置项都会被它悄悄吃掉，存得进去读不出来');
  } else if (!/Object\.assign\(\{\},\s*old\)/.test(migFn)) {
    err('★ migrate 不是"从存档里已有的出发" —— 新字段会被丢掉');
  } else ok('★ migrate 只补不删（lyricWin / playMode / window 这些不会再被吃掉）');

  if (!/s\.close\s*=\s*Object\.assign\(\{\s*action:\s*'ask'\s*\}/.test(storemigrate)) {
    err('store-migrate.js 没给 settings.close 兜默认值');
  } else ok('store-migrate.js 给 settings.close 兜了默认值（老存档零迁移）');

  /* ---- ⑪ 关窗弹窗的界面 ---- */
  const needIds = ['closeMask', 'closeQuit', 'closeTray', 'closeRemember', 'closeCancel'];
  const missIds = needIds.filter((id) => !htmlIds.has(id));
  if (missIds.length) err('index.html 少了：' + missIds.map((i) => '#' + i).join(' / '));
  else ok('关窗弹窗的五个元素都在（遮罩 / 彻底关闭 / 缩小到任务栏 / 设为默认 / 取消）');

  if (!htmlIds.has('i-power')) err('没有 #i-power 图标（"彻底关闭"那个电源键）');
  else ok('"彻底关闭"用的是电源键图标（不是 ✕，避免和"关窗口"歧义）');

  if (!/\.close-choice/.test(css)) err('style.css 里没有 .close-choice（两张大按钮）的样式');
  else ok('关窗弹窗的样式在（两张大按钮 + 一行小字说明后果）');

  if (!/finishCloseChoice/.test(appjs)) err('app.js 里没有 finishCloseChoice —— 弹窗点了没反应');
  else if (!/await flushPersistence\(\)/.test(appjs)) err('勾了「设为默认值」之后没有先存盘 —— 主进程马上退出，勾就白打了');
  else ok('勾了「设为默认值」会先存盘再通知主进程（不然勾白打）');

  if (!/onAskClose\(/.test(appjs)) err('app.js 没有监听 win:ask-close —— 弹窗不会自己冒出来');
  else ok('界面会响应主进程的"问一次"');

  /* ---- ⑫ 设置面板「窗口」页 ---- */
  if (!/data-tab="window"/.test(html)) err('设置面板没有「窗口」标签页');
  else ok('设置面板新增了「窗口」页');
  const radios = ['radCloseAsk', 'radCloseQuit', 'radCloseTray'].filter((id) => htmlIds.has(id));
  if (radios.length !== 3) err(`「关闭主窗口时」的三选一没齐（只找到 ${radios.join(' / ') || '无'}）`);
  else ok('「关闭主窗口时」是三个单选（每次询问 / 彻底关闭 / 缩小到任务栏）');

  if (!/syncCloseActionUI/.test(appjs)) err('app.js 里没有 syncCloseActionUI —— 设置里的选项不会跟着弹窗的选择同步');
  else ok('设置里的选项和弹窗的「设为默认」共用同一个字段，两边同步');

  if (!/close:\s*\{\s*action:\s*'ask'\s*\}/.test(appjs)) err("DEFAULT_SETTINGS 里没有 close（缺省 action:'ask'）");
  else ok("DEFAULT_SETTINGS 有 close，缺省 action:'ask'（老用户升级后第一次关窗会问一下）");

  if (!/close:\s*\{\s*\n?\s*action:\s*CLOSE_ACTIONS\.includes/.test(appjs)) err('migrateSettings 没有把 settings.close 洗成三种之一');
  else ok('migrateSettings 会把 settings.close 洗成三种之一（存档被手改坏也不会失灵）');

  /* ---- ⑬ 界面 → 主进程的状态回传 ---- */
  const needPreload = ['onWinCmd', 'reportUiState', 'onAskClose', 'closeChoice'];
  const missP = needPreload.filter((k) => !preload.includes(k));
  if (missP.length) err('preload.js 少了：' + missP.join(' / '));
  else ok('preload 暴露了 onWinCmd / reportUiState / onAskClose / closeChoice');

  if (!/win:ui-state/.test(mainCode) || !/win:close-choice/.test(mainCode)) err('main.js 少了 win:ui-state 或 win:close-choice 通道');
  else ok('主进程收得到界面状态和关窗选择');

  if (!/reportUiState\(\);\s*\n\}/.test(appjs)) err('updatePlayBtn 里没有调 reportUiState —— 播放状态变了托盘菜单不会跟着变');
  else ok('播放状态一变就上报（托盘菜单 / 任务栏按钮跟着变）');

  if (!/if \(key === lastUiStateKey\) return;/.test(appjs)) {
    err('reportUiState 没有"状态没变就不发"的过滤 —— 主进程会把原生菜单反复重建');
  } else ok('reportUiState 有去重（状态没变不打扰主进程）');

  if (!/handleWinCmd/.test(appjs)) err('app.js 没有 handleWinCmd —— 托盘 / 任务栏发来的命令没人接');
  else ok('托盘 / 任务栏发来的命令有处理（复用播放条本来就在用的那些函数）');

  /* ---- ⑭ 图标文件必须真的在 ---- */
  const iconFiles = [
    'tray.ico',
    'thumb-prev.png', 'thumb-play.png', 'thumb-pause.png', 'thumb-next.png',
    'menu-show.png', 'menu-note.png', 'menu-play.png', 'menu-pause.png',
    'menu-prev.png', 'menu-next.png', 'menu-mode.png', 'menu-win.png',
    'menu-lyric.png', 'menu-lock.png', 'menu-settings.png', 'menu-quit.png',
  ];
  const missIcon = iconFiles.filter((f) => !fs.existsSync(path.join(ROOT, 'src/assets', f)));
  if (missIcon.length) err('src/assets 里少了：' + missIcon.join(' / ') + '（跑 node .verify/make-icons.js 生成）');
  else ok(`图标文件都在（托盘 1 + 缩略图 4 + 菜单 12 = ${iconFiles.length} 个）`);

  /* ---- ⑮ .gitignore 不能把图标挡在门外 ---- */
  if (/assets\/\*\.png/.test(gitignore) || /^\s*\*\.ico\s*$/m.test(gitignore)) {
    err('.gitignore 把图标挡住了 —— 提交上去会缺图');
  } else ok('.gitignore 不会挡住 src/assets 里的图标');
}

/* ============================================================
   [50] v2.2.1 真机反馈修的四个问题 —— 每一条都是"当时没人拦住"的
   ============================================================ */
{
  const mkIcons = fs.readFileSync(path.join(ROOT, '.verify', 'make-icons.js'), 'utf8');

  /* ---- ① 点 ✕ 必须走 mainWindow.close()（否则第一次点 ✕ 直接退出） ---- */
  const wcAt = mainCode.indexOf("ipcMain.on('win-close'");
  const wcBody = wcAt >= 0 ? mainCode.slice(wcAt, wcAt + 260) : '';
  if (wcAt < 0) {
    err("main.js 里没有 ipcMain.on('win-close') —— 标题栏的 ✕ 没人接");
  } else if (/requestMainWindowClose/.test(wcBody)) {
    err('★ win-close 仍然直接调 requestMainWindowClose() —— 这**绕过了关窗决策**，' +
        '表现是"第一次点 ✕ 弹窗不出现、软件直接退干净"。必须改成 mainWindow.close()');
  } else if (!/mainWindow\.close\(\)/.test(wcBody)) {
    err("win-close 既没走 mainWindow.close()、也没走 requestMainWindowClose() —— 关窗逻辑不对");
  } else {
    ok('点 ✕ 走的是 mainWindow.close()（会经过 close 事件的"询问 / 缩小 / 退出"分流）');
  }

  /* ---- ② 任务栏缩略图按钮必须在窗口显示出来之后再设 ---- */
  if (!/ready-to-show[\s\S]{0,240}?mainWindow\.show\(\);[\s\S]{0,240}?refreshThumbar\(\);/.test(mainCode)) {
    err('★ ready-to-show 里没有在 show() 之后调 refreshThumbar() —— ' +
        'setThumbarButtons 在窗口还没显示时会静默失败，表现是"悬停任务栏图标没有 ⏮▶⏭"');
  } else ok('任务栏按钮在窗口 show() 之后才设（setThumbarButtons 会静默失败，时机很关键）');

  if (!/mainWindow\.on\('show'/.test(mainCode)) {
    err('没监听 mainWindow 的 show 事件 —— 从托盘回来后任务栏按钮可能丢');
  } else ok('从托盘 / 最小化回到前台时会补一次任务栏按钮');

  if (!/okSet|返回 false/.test(mainCode)) {
    err('setThumbarButtons 的返回值没记账 —— 它静默失败时没有任何线索');
  } else ok('setThumbarButtons 静默失败时会在控制台留痕');

  /* ---- ③ 图标：生成脚本的 paint 形参 + @2x 两档 ---- */
  if (/\(\s*size\s*,\s*x\s*,\s*y\s*\)\s*=>/.test(mkIcons)) {
    err('★ make-icons.js 里又出现了 paint(size, x, y) —— ' +
        'renderRGBA 是按 paint(x, y) 调用的，多写一个 size 会把"x 坐标"当成尺寸，' +
        '写盘的图标会全变成纯色块或全透明（v2.2.0 就是这么坏的，而预览图看不出来）');
  } else ok('make-icons.js 的 paint 只有 (x, y) 两个形参（和 renderRGBA 的调用一致）');

  if (!/glyphPaint/.test(mkIcons)) err('make-icons.js 没有用 glyphPaint 这个统一的画笔工厂');
  else ok('菜单 / 缩略图图标走同一个 glyphPaint（尺寸换算只有一处，不会再写错）');

  const twoX = ['menu-play@2x.png', 'menu-note@2x.png', 'thumb-play@2x.png', 'thumb-prev@2x.png'];
  const miss2x = twoX.filter((f) => !fs.existsSync(path.join(ROOT, 'src/assets', f)));
  if (miss2x.length) err('少了 @2x 图标：' + miss2x.join(' / ') + '（高分屏下菜单图标会糊）');
  else ok('@2x 图标都在（高分屏下系统挑清楚的那张）');

  if (!/addRepresentation/.test(mainCode)) {
    err('loadIcon 没有把 @2x 那张挂到 nativeImage 上 —— 高分屏还是会用放大的 16×16');
  } else ok('loadIcon 会把 @2x 挂成 2 倍档（nativeImage.addRepresentation）');

  /* ---- ④ 必须有"把写盘的图标解码回来数像素"的体检脚本 ---- */
  if (!fs.existsSync(path.join(ROOT, '.verify', 'check-icons.js'))) {
    err('少了 .verify/check-icons.js —— 预览图会和写盘走两条路径，' +
        '光看 icons-preview.png 发现不了"真图标是坏的"');
  } else ok('有 .verify/check-icons.js（把写盘的 .png 解码回来数像素，不看预览图猜）');

  /* ---- ⑤ 合集封面：贴封面的时机 + 存档自愈 ---- */
  if (!/function applyTrackCover/.test(appjs)) {
    err('app.js 没有 applyTrackCover —— 封面"后到"时没法再贴一次');
  } else ok('贴封面抽成了 applyTrackCover（封面什么时候到就什么时候贴）');

  const ecAt = appjs.indexOf('await ensureCid(track);');
  const ecBody = ecAt >= 0 ? appjs.slice(ecAt, ecAt + 400) : '';
  if (ecAt < 0) {
    err('playAt 里没有 await ensureCid(track)');
  } else if (!/applyTrackCover\(track\)/.test(ecBody)) {
    err('★ ensureCid 补到封面之后没有再贴一次 —— ' +
        '播放条会一直停在开播时那版"没封面"上（合集里的歌最明显）');
  } else ok('ensureCid 补到封面后会重新贴一次播放条');

  if (!/async function backfillCover/.test(appjs)) {
    err('app.js 没有 backfillCover —— 老存档里没封面的合集永远补不回来');
  } else ok('有 backfillCover（给"曲目表已缓存但没记封面"的合集补一次）');

  if (!/if \(!cover\) backfillCover\(bvid\);/.test(appjs)) {
    err('cachedCollectEntries 里没有触发补封面 —— 缓存过的合集还是没封面');
  } else ok('取缓存曲目表发现没封面时会触发补一次');

  if (!/backfillCover\(DB\.lastTrack\.bvid\)/.test(appjs)) {
    err('开机恢复的 lastTrack 没封面时没有补 —— 一开机播放条就是个音符');
  } else ok('开机恢复的那一首也会补封面');

  if (!/DB\.collectCovers\[track\.bvid\] = track\.cover/.test(appjs)) {
    err('ensureCid 没有把封面记进 collectCovers —— 老存档不会自己长好');
  } else ok('ensureCid 顺手把合集封面记进存档（老存档自动长好）');

  if (!/coverBackfilling/.test(appjs)) {
    err('补封面没有去重 —— 同一个合集会被反复请求');
  } else ok('补封面有去重（同一个 bvid 只补一次）');
}

/* ============================================================
   [51] v2.3.0 快捷键设置页 —— 表驱动 + 存档 + 录制 + 冲突
   ============================================================ */
{
  console.log('\n[51] 快捷键（v2.3.0）：');

  /* ---- ① 那张表本身 ---- */
  if (!keyTableSrc) {
    err('app.js 里找不到 KEY_ACTIONS 这张表');
  } else {
    const rows = [...keyTableSrc.matchAll(/id:\s*'([^']+)',\s*name:\s*'[^']*',\s*def:\s*'([^']+)'/g)];
    if (rows.length < 11) err(`KEY_ACTIONS 只有 ${rows.length} 条（以前写死在代码里的是 11 条，不能变少）`);
    else ok(`KEY_ACTIONS 有 ${rows.length} 条动作（界面列哪几行、按下去做什么，全看它）`);

    // 以前那 10 条 + mini 模式，一条都不能丢（老用户的肌肉记忆）
    const must = ['togglePlay', 'prevTrack', 'nextTrack', 'seekBack', 'seekFwd',
                  'volUp', 'volDown', 'toggleLyric', 'toggleDeskLyric', 'miniMode', 'fullscreen'];
    const lost = must.filter((id) => !rows.some((r) => r[1] === id));
    if (lost.length) err('这些动作从表里丢了（以前有）：' + lost.join(' / '));
    else ok('以前那 11 条快捷键一条都没丢');

    // ★ Esc 绝不能进表：它是所有面板的逃生键，绑走了面板就关不掉
    if (rows.some((r) => r[1] === 'escape' || r[2] === 'Escape')) {
      err('★ Esc 被放进了 KEY_ACTIONS —— 它是所有面板的逃生键，绑走之后面板就关不掉了');
    } else ok('Esc 没有进键位表（它永远是"取消 / 关面板"）');

    // def 必须是"规范化"写法，否则存进去的 'Ctrl+d' 和表里的 'Ctrl+D' 永远对不上
    const badDef = rows.filter((r) => /[A-Z]/.test(r[2].split('+').pop()) && r[2].split('+').pop().length === 1);
    if (badDef.length) err('默认键里的字母必须小写（要和 normalizeKeyName 的输出一致）：' + badDef.map((r) => r[1] + '=' + r[2]).join(' / '));
    else ok('默认键用的是规范化写法（字母小写 / 空格写 Space）');
  }

  /* ---- ② 存档：老存档零迁移 ---- */
  if (!/keys:\s*\{\}/.test(appjs)) err('DEFAULT_SETTINGS 里没有 keys（老存档读进来会是 undefined）');
  else ok('DEFAULT_SETTINGS.keys 存在（缺省 = 全用默认键）');

  if (!/keys:\s*sanitizeKeys\(old\.keys\)/.test(appjs)) {
    err('migrateSettings 没有补 settings.keys —— 老存档读进来键位是 undefined');
  } else ok('migrateSettings 会把 settings.keys 补上并洗干净');

  if (!/function sanitizeKeys/.test(appjs)) err('没有 sanitizeKeys（存档被手改坏会崩）');
  else ok('sanitizeKeys 会把存档里不认识的键位丢掉（不会崩）');

  /* ---- ③ 匹配：修饰键必须"完全一致"（★ 这一轮最大的坑） ---- */
  if (!/function keyFromEvent/.test(appjs)) err('没有 keyFromEvent（按键 → 字符串）');
  else {
    const kf = (appjs.match(/function keyFromEvent\(e\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
    if (!/ctrlKey/.test(kf) || !/altKey/.test(kf) || !/shiftKey/.test(kf)) {
      err('★ keyFromEvent 没有把三个修饰键都拼进字符串 —— ' +
          '以前靠"代码顺序"让 Ctrl+← 先命中，改成表驱动后必须比得完全一致，' +
          '否则按一次 Ctrl+← 会同时触发"上一首"和"快退 5 秒"');
    } else ok('keyFromEvent 把 Ctrl / Alt / Shift 都拼进比对串（修饰键完全一致才算命中）');

    if (!/Control'\s*\|\|\s*k === 'Shift'\s*\|\|\s*k === 'Alt'/.test(kf)) {
      err('keyFromEvent 没有挡掉"只按修饰键"（只按 Ctrl 会被当成键位）');
    } else ok('只按修饰键不算一次按键（继续等）');
  }

  if (!/const hit = KEY_ACTIONS\.find\(\(a\) => keyOf\(a\.id\) === key\)/.test(appjs)) {
    err('全局 keydown 没有改成"查表命中"（还是一条条 if？）');
  } else ok('全局 keydown 改成查表命中（加一条快捷键 = 表里加一行）');

  if (!/if \(recordingKeyId\) \{ captureRecordedKey\(e\); return; \}/.test(appjs)) {
    err('录制键位时没有先拦下这一下 —— 会把"新键位"当成"执行功能"');
  } else ok('录制中按下的键会被吃掉（不会顺手执行功能）');

  // ★ v2.10.0 修：这条原来用"到 `}, true)` 不超过 400 字符"来间接判断"录制检查靠前"，
  //   太脆 —— 中间插一段别的逻辑（这次是 Ctrl+A 拦截）就误报。
  //   改成直接断言**先后顺序**：recordingKeyId 那句必须排在 KEY_ACTIONS.find 之前，
  //   这才是"先接键、再执行"的真正含义。
  if (!/document\.addEventListener\('keydown',[\s\S]{0,900}?if \(recordingKeyId\) \{ captureRecordedKey\(e\); return; \}[\s\S]{0,1600}?KEY_ACTIONS\.find\(/.test(appjs)) {
    err('录制监听没有先于"查表执行"接键 —— Esc 可能先被其它面板当成"关闭"处理，或者新键位被当成执行功能');
  } else ok('录制键盘监听先于查表执行（录制 Esc 不会被面板抢先处理）');

  /* ---- ④ 界面那一页 ---- */
  if (!/data-tab="keys"/.test(html)) err('设置面板没有「快捷键」标签');
  else ok('设置面板有「快捷键」标签');

  if (!/data-pane="keys"/.test(html)) err('设置面板没有「快捷键」那一页');
  else ok('设置面板有「快捷键」那一页');

  ['keyList', 'btnResetKeys', 'keyClashMask', 'keyClashText', 'keyClashTake', 'keyClashCancel']
    .forEach((id) => { if (!htmlIds.has(id)) err(`index.html 少了 #${id}`); });
  if (['keyList', 'btnResetKeys', 'keyClashMask', 'keyClashTake', 'keyClashCancel'].every((id) => htmlIds.has(id)))
    ok('快捷键页需要的元素都在（列表 / 全部恢复默认 / 冲突弹窗）');

  if (!/function renderKeyList/.test(appjs)) err('没有 renderKeyList（列表画不出来）');
  else if (!/KEY_ACTIONS\.map/.test(appjs)) err('renderKeyList 不是从 KEY_ACTIONS 生成的（会两处清单对不上）');
  else ok('列表由 KEY_ACTIONS 生成（不写死在 HTML 里，永远对得上）');

  /* ---- ⑤ 录制 / 冲突 / 恢复默认 ---- */
  if (!/if \(e\.key === 'Escape'\) \{[\s\S]{0,260}?stopRecordKey\(\);\s*return;/.test(appjs)) {
    err('录制时按 Esc 没有取消 —— Esc 会被当成键位绑上去（然后所有面板都关不掉）');
  } else ok('录制时按 Esc = 取消（Esc 永远绑不走）');

  if (!/const clash = KEY_ACTIONS\.find\(\(a\) => a\.id !== id && keyOf\(a\.id\) === key\)/.test(appjs)) {
    err('改键位时没有查冲突 —— 两个功能会绑到同一个键上，谁生效全看顺序');
  } else ok('改键位前会查冲突（不静默改）');

  if (!/function yieldKey/.test(appjs)) {
    err('没有 yieldKey —— "让出来"之后两条可能还指着同一个键');
  } else ok('冲突后旧那条会"让出来"（不会两条同时指着同一个键）');

  if (!/function resetAllKeys/.test(appjs)) err('没有「全部恢复默认」');
  else ok('有单条恢复（↺）和「全部恢复默认」');

  /* ---- ⑥ 界面上写死的提示必须跟着键位走 ---- */
  if (/Ctrl\+D|Ctrl\+L|Ctrl\+M/.test(html)) {
    err('★ index.html 里还硬写着 Ctrl+D / Ctrl+L / Ctrl+M —— 键位一改提示就对不上');
  } else ok('index.html 里没有硬写的键位（提示全由 JS 现拼）');

  if (!/function refreshKeyHints/.test(appjs)) err('没有 refreshKeyHints（提示不会跟着改）');
  else ok('有 refreshKeyHints（改完键位提示立刻就对）');

  if (!/cover\.title = \(show \? '收起歌词' : '查看歌词'\) \+ keyHint\('toggleLyric'\)/.test(appjs)) {
    err('播放条封面的提示还是写死的 —— 改了键位提示会对不上');
  } else ok('封面 / 「词」/ mini 三个提示都从键位表现拼');

  /* ---- ⑦ CSS ---- */
  ['.key-list', '.key-row', '.key-box', '.key-box.recording', '.key-reset'].forEach((sel) => {
    if (!new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{').test(css)) err(`style.css 少了 ${sel} 的样式`);
  });
  ok('快捷键页的样式都在（列表 / 行 / 键位框 / 录制态 / 恢复按钮）');

  /* ---- ⑧ 必须有离屏实测 ---- */
  if (!fs.existsSync(path.join(ROOT, '.verify', 'test-keys.js'))) {
    err('少了 .verify/test-keys.js —— 快捷键这种"按下去有没有反应"必须真按一次');
  } else ok('有 .verify/test-keys.js（离屏真派发键盘事件验证）');
}

/* ============================================================
   [52] 导入我的 B 站收藏夹（v2.6.0）
   ------------------------------------------------------------
   这一版的新东西集中在一条链路上：认人（myinfo）→ 列收藏夹 → 挑视频 → 建歌单。
   链子任何一环断了都是"点了没反应"或白屏，所以逐环都钉住。
   ============================================================ */
console.log('\n[52] 导入我的 B 站收藏夹（v2.6.0）：');
{
  const bilijs = read('src/bilibili.js');

  /* ---- ① 后端：认人 ---- */
  if (!/async function getMyInfo\(/.test(bilijs)) err('bilibili.js 没有 getMyInfo —— 认不出"你是谁"');
  else ok('bilibili.js 有 getMyInfo（拿 uid / 昵称）');
  if (!/space\/myinfo/.test(bilijs)) err('getMyInfo 没打 /x/space/myinfo 这个接口');
  else ok('getMyInfo 打的是 /x/space/myinfo');
  if (!/getMyInfo,/.test(bilijs)) err('getMyInfo 没有导出 —— 主进程 require 不到');
  else ok('getMyInfo 已导出');

  /* ---- ② 没填 Cookie 必须提前退出（别白跑一次请求） ---- */
  const myinfoBody = (bilijs.match(/async function getMyInfo\(\)[\s\S]*?\n}/) || [''])[0];
  if (!/hasLoginCookie\(\)/.test(myinfoBody)) {
    err('getMyInfo 开头没查 hasLoginCookie —— 没填 Cookie 时会白跑一次请求、白挨一次限流');
  } else ok('getMyInfo 没填 Cookie 时提前退出（不白跑请求）');
  if (!/reason\s*=\s*'no-cookie'/.test(myinfoBody)) err('getMyInfo 没把"没填 Cookie"标成 reason:no-cookie');
  else ok('getMyInfo 会抛 reason:"no-cookie"');
  if (!/cookie-expired/.test(myinfoBody)) err('getMyInfo 没把 -101 映射成 cookie-expired（界面就分不清"没填"和"过期了"）');
  else ok('getMyInfo 把 -101 映射成 reason:"cookie-expired"');

  /* ---- ③ 错误码要挂成字段（别再靠字符串匹配 "-101"） ---- */
  if (!/e\.code\s*=\s*json\.code/.test(bilijs)) {
    err('requestJSON 没把 B 站的 code 挂到 error 上 —— 界面只能去匹配字符串，改一次文案就失效');
  } else ok('requestJSON 把原始 code 挂成 e.code');

  /* ---- ④ 收藏夹要带总数（卡片「86 个视频」+ 分页都靠它） ---- */
  const favBody = (bilijs.match(/async function getFavMedias\([\s\S]*?\n}/) || [''])[0];
  if (!/total:/.test(favBody)) err('getFavMedias 没返回 total —— 卡片显示不出条数、分页算不出总页数');
  else ok('getFavMedias 带出 total（media_count）');
  if (!/private:\s*f\.attr\s*===\s*1/.test(bilijs)) err('getFavFolders 没标出私密收藏夹');
  else ok('getFavFolders 标出了私密收藏夹（attr === 1）');

  /* ---- ⑤ IPC 链路：main 注册 → preload 暴露 → 界面用 api() 调 ---- */
  if (!/handle\('bili:myInfo'/.test(mainjs)) err('main.js 没注册 bili:myInfo');
  else ok('main.js 注册了 bili:myInfo');
  if (!/myInfo:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('bili:myInfo'\)/.test(preload)) {
    err('preload.js 没暴露 myInfo');
  } else ok('preload.js 暴露了 myInfo');
  if (!/api\('myInfo'\)/.test(appjs)) err('app.js 没通过 api(\'myInfo\') 调用（可能绕过了解包那层）');
  else ok('app.js 走 api(\'myInfo\') 调用');
  // ★ 没填 Cookie 时界面**不能**去调 myInfo（后端那道闸是双保险，第一道在界面）
  if (!/api\('hasCookie'\)/.test(appjs)) {
    err('app.js 没有先问 hasCookie —— 没填 Cookie 时还会去打一次 myinfo');
  } else ok('app.js 先问 hasCookie 再决定要不要打 myinfo');

  /* ---- ⑥ 入口与图标 ---- */
  if (!/<symbol id="i-import"/.test(html)) err('index.html 的 sprite 里没有 #i-import 图标');
  else ok('有 #i-import 图标');
  if (!/id="btnImportMine"/.test(html)) err('侧栏没有 #btnImportMine 入口按钮');
  else ok('侧栏有 #btnImportMine 入口按钮');
  if (!/use href="#i-import"/.test(html)) err('#btnImportMine 没用上 #i-import 图标');
  else ok('#btnImportMine 用的是 #i-import 图标');
  if (!/getElementById\('btnImportMine'\)|\$\('btnImportMine'\)/.test(appjs) && !/btnImportMine'\)\.addEventListener/.test(appjs)) {
    err('#btnImportMine 没绑点击事件 —— 点了没反应');
  } else ok('#btnImportMine 绑上了点击事件');

  /* ---- ⑦ ★★ 核心：选择集必须是 Map，且跨收藏夹累积 ---- */
  if (!/selected:\s*new Map\(\)/.test(appjs)) {
    err('★ impState.selected 不是 Map —— 同一个视频出现在两个收藏夹里会被算两次');
  } else ok('★ 选择集是 Map（用 bvid 当键，天然去重）');
  /* ★ v2.8.0 修订：身份键从写死的 bvid 抽成了 pickKey（本地歌没有 bvid，要按 localPath 查）。
     断言改成认"用某个身份键去选择集里查"这件事本身 —— 不再绑死 bvid。 */
  if (!/(pickSet|selected)\.has\((track\.bvid|pickId)\)/.test(appjs)) {
    err('★ 行的勾选状态没有"从选择集反查" —— 换收藏夹 / 翻页回来勾就丢了');
  } else ok('★ 行的勾选状态从选择集反查（翻页 / 换收藏夹都不丢）');
  /* ★ v2.8.0：勾选渲染被抽成了 pickSet（下载的批量勾选复用了同一套行渲染）。
     必须保证 opts.pickSet 为空时**回落到 impState.selected** ——
     否则导入页那三屏会渲染成"一个都勾不上"，而这是条很容易被漏掉的分支。 */
  if (!/opts\.pickSet \|\| \(impState && impState\.selected\)/.test(appjs)) {
    err('★ opts.pickSet 没有回落到 impState.selected —— 导入页的勾选会整片失效');
  } else ok('★ 导入页仍走 impState.selected（opts.pickSet 为空时自动回落）');
  // 返回键不许顺手清空选择 —— 这是"跨收藏夹累积"能成立的前提
  const backBody = (appjs.match(/function impBack\(\)[\s\S]*?\n}/) || [''])[0];
  if (/selected\.clear\(\)/.test(backBody)) {
    err('★ impBack 里清了选择集 —— 跨收藏夹累积会当场失效（返回一次就白挑了）');
  } else ok('★ 返回不清空选择（跨收藏夹累积的前提）');
  /* 只有"导入成功"和"清空选择"两处能清。
     ★ v2.8.0：这里以前数的是全局 `selected.clear()` —— 下载的批量勾选也有一处，
       会把计数顶到 3。计数要**限定在导入页那个选择集**上，否则断言测的就不是它想测的东西了。 */
  const clearCount = (appjs.match(/impState\.selected\.clear\(\)/g) || []).length;
  if (clearCount !== 2) {
    err(`★ 清空导入选择集的地方有 ${clearCount} 处，应该正好 2 处（导入成功 + 清空选择）`);
  } else ok('★ 只有 2 处会清空选择集（导入成功 / 清空选择）');

  /* ---- ⑧ 四屏渲染与按钮都在 ---- */
  ['openImportMine', 'renderImportMine', 'renderImpHome', 'renderImpFolders',
   'renderImpList', 'loadImpFolders', 'loadImpList', 'impToggle', 'impClear',
   'impWholeFolder', 'importPicked'].forEach((fn) => {
    if (!new RegExp('function ' + fn + '\\(').test(appjs)) err(`app.js 缺少 ${fn}()`);
  });
  ok('导入页的渲染 / 加载 / 选择 / 落地函数都在');
  if (!/currentView === 'importMine'/.test(appjs)) err('renderAll() 里没有 importMine 分支 —— 这页永远画不出来');
  else ok('renderAll() 里有 importMine 分支');
  ['btnImpBack', 'btnImpUp', 'btnImpFav', 'btnImpPickAll', 'btnImpPickNone',
   'btnImpClear', 'btnImpDo', 'btnImpWholeUp'].forEach((id) => {
    if (!new RegExp(`id === '${id}'`).test(appjs)) err(`点击代理里没有 ${id} 的处理`);
  });
  ok('八个导入页按钮都接进了点击代理');

  /* ---- ⑨ 复用 v2.5.0 的分页条（别再抄一份） ---- */
  if (!/paginationHTML\(page, totalPages\)/.test(appjs)) {
    err('导入页没有复用 paginationHTML —— 分页条抄成两份，以后改一处漏一处');
  } else ok('导入页复用了 v2.5.0 的 paginationHTML');
  // 分页条的点击要按"当前在哪一页"分流，别让 UP 主页和导入页互相踩
  if (!/currentView === 'importMine'[\s\S]{0,120}loadImpList\(p\)/.test(appjs)) {
    err('分页条的点击没有按 importMine 分流 —— 在导入页点页码会去翻 UP 主页');
  } else ok('分页条点击按页面分流（UP 主页 / 导入页各翻各的）');

  /* ---- ⑩ 挑歌行的三个约束 ---- */
  if (!/opts\.pick/.test(appjs)) err('trackRow 没有 opts.pick 分支 —— 行左边长不出复选框');
  else ok('trackRow 支持挑歌模式（opts.pick）');
  if (!/class="pick/.test(appjs)) err('挑歌行没有画 .pick 复选框');
  else ok('挑歌行画出了 .pick 复选框');
  if (!/closest\('\.track\.pickable'\)/.test(appjs)) {
    err('没有拦下"点挑歌行" —— 会一路漏到"点整行 = 播放"，挑歌时点一下就把歌播了');
  } else ok('挑歌时点整行 = 勾选（不会误播）');
  // 反向断言：徽章那列在 pickable 里不存在，多画一个就把网格挤乱
  if (!/showBadge = !opts\.pick/.test(appjs)) {
    err('挑歌模式下还会画「选集 N」徽章 —— pickable 只定义四列，会被挤乱');
  } else ok('挑歌模式下不画徽章（四列网格对得上）');

  /* ---- ⑪ 卡片上的「整个导入」要抢在"点卡片进收藏夹"之前 ---- */
  const wholeIdx = appjs.indexOf("closest('[data-imp-whole]')");
  const cardIdx = appjs.indexOf("closest('[data-imp-folder]')");
  if (wholeIdx < 0 || cardIdx < 0) err('收藏夹卡片的点击没接');
  else if (wholeIdx > cardIdx) {
    err('★「整个导入」的判断排在"点卡片"之后 —— 点它会顺带进收藏夹');
  } else ok('「整个导入」抢在"点卡片进收藏夹"之前判（不会顺带跳走）');

  /* ---- ⑫ CSS ---- */
  ['.imp-bar', '.src-card', '.c-pick', '.c-sel', '.pick', '.track.pickable'].forEach((sel) => {
    if (!new RegExp(sel.replace(/[.]/g, '\\.') + '[\\s,{]').test(css)) err(`style.css 少了 ${sel} 的样式`);
  });
  ok('导入页的样式都在（工具条 / 来源卡 / 整夹按钮 / 角标 / 复选框 / 挑歌行）');
  if (!/\.track\.pickable\s+\.ops\s*\{\s*display:\s*none/.test(css)) {
    err('挑歌行没有把右侧那排操作按钮藏掉 —— 挑歌时它们是干扰，还会抢走点击');
  } else ok('挑歌行藏掉了右侧那排操作按钮');

  /* ---- ⑬ 边界文案：没填 Cookie 要有引导，不能白屏 ---- */
  if (!/impBlockedHTML/.test(appjs) || !/设置 → B 站/.test(appjs)) {
    err('没填 Cookie 时没有给出"去设置填 Cookie"的引导');
  } else ok('没填 Cookie / 过期时都有整页引导（不留白屏）');

  /* ---- ⑭ 必须有离屏实测 ---- */
  if (!fs.existsSync(path.join(ROOT, '.verify', 'test-round15.js'))) {
    err('少了 .verify/test-round15.js —— "跨收藏夹累积选择"这种必须真点一次才算数');
  } else ok('有 .verify/test-round15.js（离屏真点，含跨收藏夹累积）');
}

/* ============================================================
   53) 收藏夹封面（v2.6.1）
   ------------------------------------------------------------
   Neo 报「收藏夹封面展示没有」。根因不是 CSS，是**接口选错了**：
   `/folder/created/list-all` 的返回里压根没有 cover 字段（实测 69 个
   收藏夹一个封面都没有），换成分页版 `/folder/created/list` 才有。
   这类"数据源字段缺失"的 bug 静态查不出来，但**"用了哪个接口"**能查 ——
   所以这里钉死接口，再加一条反向断言防止退回 list-all。
   ============================================================ */
console.log('\n[53] 收藏夹封面（v2.6.1）：');
{
  const bilijs = read('src/bilibili.js');
  const appjs = read('src/ui/app.js');
  const css = read('src/ui/style.css');

  /* ---- ① 接口必须是分页版（带 cover 的那个） ---- */
  if (!/created\/list\?up_mid=\$\{mid\}/.test(bilijs)) {
    err('getFavFolders 没打分页版 /x/v3/fav/folder/created/list');
  } else ok('getFavFolders 打的是分页版 /folder/created/list（带 cover）');

  /* 反向断言：不许退回 list-all —— 那个接口的返回里没有 cover 字段，
     退回去 = 封面全空（这正是 v2.6.0 的 bug）。 */
  if (/created\/list-all\?up_mid=/.test(bilijs)) {
    err('★ 又用回 list-all 了 —— 那个接口不返回 cover，封面必然全空');
  } else ok('★ 没有退回 list-all（反向断言：退回去封面就全没了）');

  /* ---- ② 要分页（收藏夹可能上百个） ---- */
  if (!/FAV_FOLDER_PAGE_SIZE/.test(bilijs)) err('没有 FAV_FOLDER_PAGE_SIZE —— 分页尺寸写死在 URL 里了');
  else ok('分页尺寸是具名常量 FAV_FOLDER_PAGE_SIZE');
  if (!/pn=\$\{pn\}&ps=\$\{FAV_FOLDER_PAGE_SIZE\}/.test(bilijs)) {
    err('分页参数没接上（pn / ps 至少少一个）');
  } else ok('pn / ps 都接上了');
  if (!/all\.length >= total/.test(bilijs)) {
    err('分页没有"拿满就收工"的判据 —— 会一直翻到第 10 页白跑请求');
  } else ok('拿到 count 个就收工（不会白翻页）');
  if (!/typeof d\.count === 'number'/.test(bilijs)) {
    err('没有对 d.count 缺失的兜底 —— 拿不到 count 时会死循环翻页');
  } else ok('count 拿不到时有兜底（不会死循环）');

  /* ---- ③ cover 必须过 toHttps（CSP 只放行 https:） ---- */
  if (!/cover:\s*toHttps\(f\.cover\)/.test(bilijs)) {
    err('cover 没过 toHttps —— B 站给的是 http://，会被 CSP 的 img-src 拦掉');
  } else ok('cover 走了 toHttps（http → https，CSP 才放行）');

  /* ---- ④ 换接口不能把「私密」判断弄坏 ---- */
  if (!/private:\s*f\.attr === 1/.test(bilijs)) {
    err('private 判断不是 attr === 1 了 —— 换接口后「私密」小标会失效');
  } else ok('私密判断仍是 attr === 1（两个接口的 attr 实测逐条一致）');

  /* ---- ⑤ 没封面时不给行内 background-image，好让 CSS 占位生效 ---- */
  if (/background-image:url\('\$\{esc\(f\.cover \|\| ''\)\}'\)'/.test(appjs)) {
    err('★ 还在无条件写行内 background-image —— 空封面会把 CSS 占位盖掉（一块空色块）');
  } else ok('★ 没封面时不再写行内 background-image（占位才盖得住）');
  const noCoverUses = (appjs.match(/f\.cover \? '' : ' no-cover'/g) || []).length;
  if (noCoverUses < 2) {
    err(`只有 ${noCoverUses} 处加了 .no-cover —— 导入页和"别人的收藏夹"两处都要加`);
  } else ok(`${noCoverUses} 处卡片都加了 .no-cover（导入页 + 别人的收藏夹）`);

  /* ---- ⑥ 占位样式 ---- */
  if (!/\.card\s+\.thumb\.no-cover\s*\{/.test(css)) {
    err('style.css 少了 .card .thumb.no-cover —— 没封面时还是一块空色块');
  } else ok('有 .card .thumb.no-cover 规则（音符占位，跟播放条 .no-art 同一套做法）');
  if (!/background-image:\s*url\("data:image\/svg\+xml/.test(css)) {
    err('.no-cover 的底图不是内联 SVG —— 又要多一个图片文件，还会被 CSP 拦');
  } else ok('占位底图是内联 SVG data-URI（CSP 的 img-src 已放行 data:）');

  /* ---- ⑦ 必须有离屏实测（这次还要打桩 https 验"打了哪个接口"） ---- */
  if (!fs.existsSync(path.join(ROOT, '.verify', 'test-round16.js'))) {
    err('少了 .verify/test-round16.js —— 接口选错这种 bug 必须实测才抓得住');
  } else ok('有 .verify/test-round16.js（打桩 https 验接口 + 离屏验封面/占位）');
}

/* ============================================================
   54) 打包内容白名单（v2.6.1）
   ------------------------------------------------------------
   以前 build 里没有 files，electron-builder 走默认的"整个目录全收"，于是
   .tmp/（61MB，含 winCodeSign 镜像）/ .verify/（100 个开发期脚本）/
   docs/（README 截图）/ .workbuddy*（项目笔记）全被打进 app.asar。
   加上白名单后安装包从 119.6MB 降到 81.8MB。
   JSON 不支持注释，所以**只能靠断言把这条规矩守住**。
   ============================================================ */
console.log('\n[54] 打包内容白名单（v2.6.1）：');
{
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
  catch (e) { err('package.json 解析不了：' + e.message); }

  if (pkg) {
    const files = pkg.build && pkg.build.files;
    if (!Array.isArray(files) || !files.length) {
      err('★ build.files 是空的 —— 又回到"把整个工程都打进去"了（.tmp 61MB 会跟着进包）');
    } else ok('build.files 白名单在（' + files.length + ' 条）');

    /* 必须有的三样 */
    ['src/**', 'package.json', 'LICENSE'].forEach((need) => {
      if (!files.includes(need)) err(`白名单少了 "${need}" —— 运行时会缺东西`);
      else ok(`白名单里有 "${need}"`);
    });

    /* 反向断言：不许出现"全部打包"的写法 */
    ['**/*', '.', '*'].forEach((bad) => {
      if (files.includes(bad)) err(`★ 白名单里出现了 "${bad}" —— 等于没设白名单`);
    });
    ok('★ 没有 "**/*" / "." 这种等于没设的写法');

    /* 反向断言：开发期的东西不许进包 */
    ['.tmp', 'docs', '.verify', '.workbuddy', '.workbuddy-ai'].forEach((junk) => {
      if (files.some((f) => f === junk || f.startsWith(junk + '/'))) {
        err(`★ 白名单里混进了 "${junk}" —— 那是开发期/笔记文件，不该发给用户`);
      }
    });
    ok('★ .tmp / docs / .verify / .workbuddy* 都没进包（这些是开发期文件和项目笔记）');
  }
}

/* ============================================================
   55) 歌词碎句合并（v2.7.0）
   ------------------------------------------------------------
   只修「歌唱置信度高 + 时间轴确实有真停顿 + 合并后字数合理」的碎句。
   缺少 to / music 时 fail-closed，不用缺失值猜歌词边界。
   ============================================================ */
console.log('\n[55] 歌词碎句合并（v2.7.0）：');
{
  const bilijs = read('src/bilibili.js');
  const test = path.join(ROOT, '.verify', 'test-round17.js');

  const thresholds = [
    ['LYRIC_MUSIC_MIN', '0.5'],
    ['LYRIC_GAP_REAL', '0.4'],
    ['LYRIC_GAP_TRUST', '0.6'],
    ['LYRIC_GAP_MERGE', '0.05'],
    ['LYRIC_MERGE_MAX', '15'],
  ];
  for (const [name, value] of thresholds) {
    if (bilijs.includes(`const ${name} = ${value};`)) ok(`${name} 阈值存在且为 ${value}`);
    else err(`${name} 缺失或数值不符（应为 ${value}）`);
  }

  for (const name of ['plainLyricLen', 'joinLyricText', 'mergeShatteredLines']) {
    if (new RegExp(`function\\s+${name}\\s*\\(`).test(bilijs)) ok(`有 ${name}() 纯函数`);
    else err(`缺少 ${name}() —— 歌词合并算法不完整`);
  }

  if (/tEnd:\s*it\.to/.test(bilijs) && /music:\s*Number\(it\.music\)/.test(bilijs)) {
    ok('原始字幕保留 to / music 字段供安全判别');
  } else err('字幕映射漏了 to 或 music，无法判断碎句 / 对白');

  if (/let lines\s*=\s*body\s*\.map\(\(it\)\s*=>\s*\(\{\s*t:\s*Number\(it\.from\)/.test(bilijs)) {
    err('★ 退回只取 from / content 的旧映射 —— 字幕又会原样碎句显示');
  } else ok('★ 没有退回只取 from / content 的旧映射（反向断言）');

  if (/lines\s*=\s*mergeShatteredLines\(rawSegs\)\.map\(\(\{\s*t,\s*text\s*\}\)\s*=>\s*\(\{\s*t,\s*text\s*\}\)\)/.test(bilijs)) {
    ok('经过算法后只公开 {t, text}，内部字段不会泄漏到 UI');
  } else err('lines 没有走碎句合并，或公开格式已改变');

  if (/!Number\.isFinite\(line\.tEnd\)\s*\|\|\s*line\.tEnd\s*<\s*line\.t/.test(bilijs)) {
    ok('缺少 to / to 早于 from 时 fail-closed');
  } else err('无效 to 没有保护，可能把未知时间轴当成真停顿');

  if (/musicAvg\s*<\s*LYRIC_MUSIC_MIN/.test(bilijs)) ok('music 置信度不够时不合并（挡口播）');
  else err('缺少 music 闸门，口播可能被合成一句');

  if (/realGapRatio\s*<\s*LYRIC_GAP_TRUST/.test(bilijs)) ok('时间轴真停顿占比不足时不合并');
  else err('缺少时间轴可信度闸门，铺满式字幕可能被糊成一团');

  if (/line\.t\s*-\s*previous\.tEnd\s*<=\s*LYRIC_GAP_MERGE\s*\+\s*1e-6/.test(bilijs)) {
    ok('只考虑无缝边界，并容忍毫秒级浮点误差');
  } else err('合并边界没有限制在无缝区间或缺少浮点误差保护');

  if (/plainLyricLen\(text\)\s*<=\s*LYRIC_MERGE_MAX/.test(bilijs)) ok('合并后字数有上限，避免跨句粘连');
  else err('缺少合并后字数上限');

  if (bilijs.includes('const separator = /[A-Za-z0-9]$/.test(left)')) {
    ok('中文拼接不插空格，英文词边界留空格');
  } else err('接缝拼接规则缺失或没有保护英文分词');

  if (fs.existsSync(test)) ok('有 .verify/test-round17.js 离线实测');
  else err('缺少 test-round17.js —— 必须打桩实测三道闸门');

  if (/music 缺失按低置信度/.test(fs.existsSync(test) ? fs.readFileSync(test, 'utf8') : '')) {
    ok('离线实测覆盖 music 缺失的保守行为');
  } else err('实测未覆盖 music 缺失边界');

  if (/to 缺失时不把未知时间轴/.test(fs.existsSync(test) ? fs.readFileSync(test, 'utf8') : '')) {
    ok('离线实测覆盖 to 缺失的保守行为');
  } else err('实测未覆盖 to 缺失边界');
}

/* ---- 56) 下载与本地歌曲（v2.8.0）----
   这一类的重点是三件"静默出错、上线后极难查"的事：
     ① 两处下载默认值写歪（设置里显示 2、实际跑 3）
     ② local:// 的白名单写成了可绕过的形式（任意文件读取）
     ③ 下载任务被塞回 6MB 的 neko-data.json（界面每 300ms 卡一次）
   所以它们各自都有一条**反向断言**在盯着。 */
console.log('\n[56] 下载与本地歌曲（v2.8.0）：');
{
  /* ---- ① 下载设置的 5 个默认值，两个文件必须逐项一致 ---- */
  const dlKeys = ['dir', 'concurrent', 'saveCover', 'autoAddToLocal', 'skipExisting'];
  const dlDefaults = (storemigrate.match(/const DEFAULT_DOWNLOAD = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const missKeys = dlKeys.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(dlDefaults));
  if (missKeys.length) err(`store-migrate.js 的 DEFAULT_DOWNLOAD 缺字段：${missKeys.join(', ')}`);
  else ok('DEFAULT_DOWNLOAD 五个字段齐全（dir / concurrent / saveCover / autoAddToLocal / skipExisting）');

  const appDl = (appjs.match(/const DOWNLOAD_DEFAULTS = \{([\s\S]*?)\n\};/) || [])[1] || '';
  if (!appDl) {
    err('app.js 里没有 DOWNLOAD_DEFAULTS —— 设置面板补默认值时没得参照');
  } else {
    const pick = (src, k) => String((src.match(new RegExp('\\b' + k + '\\s*:\\s*([^,\\n]+)')) || [])[1] || '').trim();
    const bad = dlKeys.filter((k) => pick(dlDefaults, k) !== pick(appDl, k));
    if (bad.length) err(`★ 两处下载默认值不一致：${bad.join(', ')} —— 会出现"设置里显示 2、实际跑 3"这种查不出来的怪事`);
    else ok('★ app.js 与 store-migrate.js 的下载默认值逐项一致');
  }

  /* ---- ② 存档字段：必须有 local / settings.download，且**不能**有 downloads ---- */
  if (!/d\.local\s*=\s*Array\.isArray\(d\.local\)/.test(storemigrate))
    err('store-migrate 没有补 DB.local —— 老存档打开时本地库是 undefined，遍历就崩');
  else ok('老存档会补出 DB.local');
  if (!/s\.download\s*=\s*Object\.assign\(\{\},\s*DEFAULT_DOWNLOAD/.test(storemigrate))
    err('store-migrate 没有补 settings.download');
  else ok('老存档会补出 settings.download');
  if (!/existsSync\(dir\)[\s\S]{0,80}isDirectory\(\)/.test(storemigrate) || !/s\.download\.dir\s*=\s*null/.test(storemigrate))
    err('★ 下载目录不存在时没有降级成 null —— 换电脑 / 删目录之后下载会一直失败在"目录不存在"');
  else ok('★ 下载目录不存在会降级成 null（下次下载重新问）');

  /* ★ 反向断言：下载任务**不许**进 neko-data.json。
     那个文件已经 6MB，而进度每 300ms 变一次 —— 写进去等于每 300ms 序列化并落盘 6MB。 */
  if (/d\.downloads\s*=/.test(storemigrate) || /downloads\s*:\s*\[\]/.test(storemigrate))
    err('★ 下载任务被塞回了 neko-data.json —— 6MB 的存档每 300ms 写一次，界面会卡死');
  else ok('★ 下载任务没有进 neko-data.json（归主进程的 downloads.json）');
  if (!/downloads\.json/.test(mainCode)) err('主进程没有 downloads.json —— 任务状态没地方落盘');
  else ok('主进程单独存 downloads.json');

  /* ---- ③ local:// 的安全闸：必须是"折叠后精确匹配"，不能是拼接 + startsWith ---- */
  if (!/wl\.has\(target\)/.test(localproto))
    err('★ local:// 没有用 Set.has 做精确匹配 —— 拼接 + startsWith 可以被 .. 绕过，等于任意文件读取');
  else ok('★ local:// 只放行白名单里的精确路径（Set.has，不是 startsWith）');
  if (!/path\.resolve\(raw\)/.test(localproto))
    err('★ local:// 没有先 path.resolve 再比对 —— D:\\库\\..\\..\\秘密.txt 会以"库里的路径"身份蒙混过关');
  else ok('★ 先 path.resolve 把 .. 折叠掉再比对（顺序不能反）');
  if (!/本地歌曲库是空的/.test(localproto) || !/status:\s*403/.test(localproto))
    err('local:// 白名单为空时没有 fail-closed（应返回 403）');
  else ok('白名单为空时 fail-closed（403，不是放行）');

  /* ---- ④ 两个入口的字符串 / 封面校验 / CSP / 协议注册 ---- */
  if (!/'get'/.test(localproto) || !/'cover'/.test(localproto))
    err('local:// 的 get / cover 两个入口字符串不见了');
  else ok('local:// 有 get（音频）和 cover（封面）两个入口');
  if (!/COVER_NAME_RE/.test(localproto) || !/function safeCoverName/.test(localproto))
    err('封面文件名没有统一的白名单校验（safeCoverName / COVER_NAME_RE）');
  else ok('封面文件名有统一校验（safeCoverName + COVER_NAME_RE）');
  /* ★ 断言必须查**调用**（带括号），不能只查名字 ——
     downloader.js 顶部那句 `require('./local-protocol.js')` 里就带着 safeCoverName，
     只查名字的话，把真正的调用换成自己一套实现，这条也照样"通过"（实测踩到过）。 */
  if (!/safeCoverName\(/.test(downloaderjs))
    err('★ 下载器没有调用 safeCoverName —— 两边各写一套，会生成出中文封面名又被校验拒掉（实际就是这么翻的车）');
  else ok('★ 下载器调用同一个 safeCoverName（生成与校验是同一套规则）');
  if (!/img-src[^;]*local:/.test(html) || !/media-src[^;]*local:/.test(html))
    err('★ CSP 里没有 local: —— 本地歌曲的封面 / 音频会被 CSP 直接拦掉');
  else ok('★ CSP 的 img-src / media-src 都放行了 local:');
  if (!/scheme:\s*'local'/.test(mainCode) || !/registerLocalProtocol\(/.test(mainCode))
    err('main.js 没有注册 local:// 协议（registerSchemesAsPrivileged + protocol.handle）');
  else ok('main.js 注册了 local:// 协议');

  /* ---- ⑤ 侧栏底部两个按钮 ---- */
  const footBlock = (html.match(/<div class="sidebar-foot">([\s\S]*?)\n\s*<\/div>/) || [])[1] || '';
  const footBtns = [...footBlock.matchAll(/id="(btn[\w]+)"/g)].map((m) => m[1]);
  if (footBtns.length !== 2 || !footBtns.includes('btnSettings') || !footBtns.includes('btnDownloads'))
    err(`.sidebar-foot 里应该是「设置」+「下载管理」两个按钮，实际是 [${footBtns.join(', ')}]`);
  else ok('侧栏底部是「设置」+「下载管理」两个并排按钮');
  if (!/\.sidebar-foot\s*\{[^}]*display:\s*flex/.test(css))
    err('.sidebar-foot 没有 display:flex —— 两个按钮不会并排');
  else ok('.sidebar-foot 是 flex 布局（两个按钮各占一半）');
  if (!/id="dlBadge"/.test(html)) err('「下载管理」按钮上没有角标元素 #dlBadge');
  else ok('「下载管理」按钮带角标 #dlBadge（有任务时才显示）');

  /* ---- ⑥ 绿勾必须是固定语义色，不能跟主题色走 ---- */
  if (!/--ok-rgb:\s*\d+\s+\d+\s+\d+/.test(css) || !/--ok:\s*rgb\(var\(--ok-rgb\)\)/.test(css))
    err('style.css 没有定义固定语义色 --ok-rgb / --ok');
  else ok('style.css 有固定语义色 --ok（成功 / 已完成，五套主题都不改它）');
  const doneRules = [...css.matchAll(/\.(?:op-ic|ico-btn)\.done[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
  if (!doneRules) err('style.css 没有 .op-ic.done / .ico-btn.done 的绿勾态');
  else if (/var\(--accent/.test(doneRules)) {
    err('★ 绿勾用了 var(--accent) —— 「薄荷绿」主题下没下载的按钮也是绿的，状态当场分不清');
  } else if (!/var\(--ok\)/.test(doneRules)) {
    err('★ 绿勾没有用 var(--ok)');
  } else ok('★ 绿勾用 var(--ok)，且**没有**混进 var(--accent)（反向断言：薄荷绿主题下仍能一眼分辨）');

  /* ---- ⑦ 四个下载入口都在 ---- */
  if (!/data-act="download"/.test(appjs)) err('歌曲行内没有下载按钮（data-act="download"）');
  else ok('入口①：歌曲行内有下载按钮');
  if (!/id="btnDownload"/.test(html) || !/btnDownload'\)\.addEventListener/.test(appjs))
    err('播放条上没有下载按钮 / 没绑事件');
  else ok('入口②：播放条上有下载按钮');
  if (!/id="btnSelectFav"/.test(appjs) || !/id="btnSelectPl"/.test(appjs))
    err('「我喜欢」/「歌单」工具条上没有「批量选择」按钮');
  else ok('入口③：「我喜欢」和「歌单」都有「批量选择」（点进去是选择模式，能全选）');
  if (!/data-cact="download"/.test(appjs) || !/btnDownloadCollect'\)\.addEventListener/.test(appjs))
    err('合集面板没有下载入口（选集行内按钮 / 工具条）');
  else ok('入口④：合集面板的选集行 + 工具条都能下');

  /* ---- ⑧ 任务状态的 owner 是主进程，界面只维护镜像 ---- */
  if (!/onDownloadChanged/.test(preload) || !/onDownloadProgress/.test(preload) || !/onDownloadFinished/.test(preload))
    err('preload 没有把下载的三条推送接出来');
  else ok('preload 接出了 changed / progress / finished 三条推送');
  if (!/function rebuildDlKeys\(\)/.test(appjs))
    err('app.js 没有 rebuildDlKeys —— 行内绿勾要每行查一次，不预先把 key 集合算好就是 O(n²)');
  else ok('app.js 有 rebuildDlKeys（预先把"已下载"的 key 算成集合）');
  if (!/function enqueueDownloads\(/.test(appjs))
    err('app.js 没有 enqueueDownloads —— 四个入口没有汇合点');
  else ok('四个下载入口汇到同一个 enqueueDownloads（先补 cid 再排队）');

  /* ---- ⑨ 离线实测 ---- */
  [['test-round18.js', '下载引擎（续传 / 并发 / 文件名）'],
   ['test-round19.js', 'local:// 白名单']].forEach(([f, name]) => {
    if (fs.existsSync(path.join(ROOT, '.verify', f))) ok(`有 .verify/${f}（${name} 离线实测）`);
    else err(`缺少 .verify/${f} —— ${name} 必须打桩实测`);
  });
  const p19 = path.join(ROOT, '.verify', 'test-round19.js');
  const t19 = fs.existsSync(p19) ? fs.readFileSync(p19, 'utf8') : '';
  if (/白名单外/.test(t19)) ok('test-round19 覆盖了"白名单外必须 403"这条头号断言');
  else err('test-round19 没有把"白名单外必须 403"写成断言');

  /* ---- ⑩ 真机反馈修的五处（v2.8.0 修订）---- */

  // ① 收起的整页歌词不能接鼠标 —— 它的「桌面歌词」按钮正好压在工具栏「批量下载」上面
  {
    const lhb = (css.match(/\.lyric-head-btn\s*\{[^}]*\}/) || [''])[0];
    const scoped = /\.lyric-overlay\.show\s+\.lyric-head-btn\s*\{[^}]*pointer-events:\s*auto/.test(css);
    if (/pointer-events:\s*auto/.test(lhb))
      err('.lyric-head-btn 又写了无条件的 pointer-events: auto —— 收起歌词页后它会顶掉父级的 none，把工具栏最右侧的按钮盖住');
    else if (!scoped)
      err('没有 .lyric-overlay.show .lyric-head-btn { pointer-events: auto } —— 展开时那个「桌面歌词」按钮会点不动');
    else ok('★ 歌词浮层收起时不接鼠标（pointer-events: auto 只在 .lyric-overlay.show 下放行）');
  }

  // ② 勾选态按钮不变形：换的是配色，不是盒子
  {
    const pb = (css.match(/\.primary-btn\s*\{[^}]*\}/) || [''])[0];
    if (!/display:\s*inline-flex/.test(pb))
      err('.primary-btn 没有 display: inline-flex —— 里面放图标时（.ic 是 display:block）图标会独占一行，按钮从 32px 撑到 47px');
    else ok('★ .primary-btn 也是 inline-flex（带图标的按钮不会变成两行）');
    if (!/\.ghost-btn\.on\s*\{/.test(css)) err('没有 .ghost-btn.on —— 勾选态只能切到 .primary-btn，盒子会变');
    else ok('有 .ghost-btn.on（勾选态只换配色、不动盒子）');
    if (!/ghost-btn\$\{picking \? ' on' : ''\}/.test(appjs))
      err('工具条那两个「批量下载」按钮没在用 ghost-btn + on');
    else ok('工具条的「批量下载」用 ghost-btn + on 表示勾选态（不再切 primary-btn）');
  }

  // ③ 选集面板的「批量下载」进勾选态，不再"点一下直接下全部"
  {
    const miss = ['btnCollectPickAll', 'btnCollectPickNone', 'btnCollectPickDo']
      .filter((k) => !new RegExp('id="' + k + '"').test(appjs));
    if (miss.length) err('选集勾选工具条缺按钮：' + miss.join(' '));
    else ok('★ 选集面板有勾选工具条（全选 / 清空 / 下载选中的 N 首）');
    if (!/id="collectPickBar"/.test(html)) err('index.html 里没有 #collectPickBar');
    else ok('index.html 有 #collectPickBar（独立一行，不跟搜索框抢那 368px）');
    if (!/function collectPickToggle\(/.test(appjs) || !/function toggleCollectPick\(/.test(appjs))
      err('app.js 缺 collectPickToggle / toggleCollectPick');
    else ok('app.js 有 collectPick 勾选态（点行 = 勾选）');
    if (!/btnDownloadCollect'\)\.addEventListener\('click', toggleCollectPick\)/.test(appjs))
      err('合集面板的「批量下载」没有改成进勾选态');
    else ok('合集面板的「批量下载」→ toggleCollectPick');
    if (/const on = enabledEntries\(collectState, collectState\.entries\);[\s\S]{0,160}enqueueDownloads\(on/.test(appjs))
      err('合集面板又变回"点一下直接下载启用中的全部"了');
    else ok('★ 反向断言：合集面板不再"点一下直接下全部"');
  }

  // ④ 下载管理有「全部删除」
  if (!/id="btnDlClearAll"/.test(appjs) || !/function dlClearAll\(/.test(appjs))
    err('下载管理没有「全部删除」（真机反馈）');
  else ok('★ 下载管理有「全部删除」');
  if (!/id === 'btnDlClearAll'/.test(appjs)) err('「全部删除」没绑点击事件');
  else ok('「全部删除」绑了点击事件');

  // ⑤ 删任务要连本地库那条一起清 —— 否则「已下载」绿勾一直挂着
  if (!/function dropLocalEntryOf\(/.test(appjs)) err('app.js 没有 dropLocalEntryOf');
  else ok('★ 有 dropLocalEntryOf（删任务时清掉本地库里那条）');
  if (!/dropLocalEntryOf\(t\)/.test(appjs))
    err('dlRemoveOne / dlClearAll 没有调 dropLocalEntryOf —— 删完任务绿勾不会消失');
  else ok('★ 单条删除 / 全部删除都会清本地库记录（绿勾据此消失）');
}

/* ---- 57) 两个新问题的修复（v2.8.0 修订二）----
   这一类的重点是两件"静默失效"的事 —— 它们都不会报错、平时也看不出来，
   只有真机上操作一遍才会暴露，所以每条都配了**反向断言**：

     问题 A：在资源管理器里**直接删文件**后，绿勾还在、再点不肯重下。
             根因是 rebuildDlKeys() 纯字符串运算，从不查磁盘。
     问题 B：播放一卡一卡 → 彻底卡死，拖进度条也没用。
             根因是地址带 deadline 会过期，而 audio 完全没监听 stalled/waiting。 */
console.log('\n[57] 两个新问题的修复（v2.8.0 修订二）：');
{
  /* ============ 问题 A：失联文件体检 ============ */

  // ① 必须有体检函数，且**真的去问了磁盘**（不能又是纯字符串）
  if (!/async function sweepMissingLocal\(/.test(appjs))
    err('★ app.js 没有 sweepMissingLocal —— 外部删文件后绿勾一直是绿的（根因：rebuildDlKeys 从不查磁盘）');
  else ok('★ 有 sweepMissingLocal（失联文件批量体检）');
  if (!/async function localFileAlive\(/.test(appjs))
    err('★ app.js 没有 localFileAlive —— 点绿勾那一刻没法确认文件还在不在');
  else ok('★ 有 localFileAlive（单条即时体检）');
  if (!/api\('localStat'/.test(appjs))
    err('★ 体检没有调 localStat（现成的 local:stat，main.js:1232）—— 没查磁盘等于没体检');
  else ok('★ 体检走 localStat（现成的 local:stat IPC）');
  if (!/alive\.set\(String\(r\.path\), r\.exists === true\)/.test(appjs))
    err('体检没有按 exists 真假建表 —— "命中的算活着、缺失的剔掉"这条判据不清');
  else ok('★ 按 exists 真假建表（exists === true 才算活着）');

  // ② 反向断言：体检**不能**在查询失败时误删用户记录
  if (!/const exists = alive\.has\(String\(e\.path\)\) \? alive\.get\(String\(e\.path\)\) : true/.test(appjs))
    err('★ 体检没有"查不到就当它还活着"的兜底 —— 一次查询遗漏会误删用户明明还在的下载记录');
  else ok('★ 反向断言：批量体检查不到时不删（宁可多留一个绿勾，也不误删真记录）');
  if (!/catch \(err\) \{[\s\S]{0,220}return true;[\s\S]{0,40}\}/.test(appjs.slice(appjs.indexOf('async function localFileAlive'))))
    err('★ localFileAlive 出错时不是返回 true（当它还在）—— 一次 IPC 异常就会把用户的绿勾打掉');
  else ok('★ 反向断言：单条检查出错时返回 true（不因一次异常误判"文件没了"）');

  // ③ 体检必须挂进启动流程（在 renderAll 之前，否则第一次画出来就是假绿勾）
  {
    const bootBlock = (appjs.match(/async function boot\(\)[\s\S]*?\n\}/) || [''])[0];
    if (!/sweepMissingLocal\(true\)/.test(bootBlock))
      err('★ boot() 里没有调 sweepMissingLocal(true) —— 启动时不会体检，第一屏就是假绿勾');
    else ok('★ boot() 启动时做一次体检（force，不受 60 秒节流限制）');
    const idxSweep = bootBlock.indexOf('sweepMissingLocal');
    const idxRender = bootBlock.indexOf('renderAll()');
    if (idxSweep > 0 && idxRender > 0 && idxSweep < idxRender)
      ok('★ 体检排在 renderAll 之前（第一屏画出来就是干净的）');
    else err('体检没有排在 renderAll 之前 —— 第一次画出来还是会带假绿勾');
  }

  // ④ 点击那一刻的兜底
  if (!/async function revealOrRedownload\(/.test(appjs))
    err('★ app.js 没有 revealOrRedownload —— 文件被外部删了之后点绿勾只会弹一句报错');
  else ok('★ 有 revealOrRedownload（点绿勾时先确认文件还在）');

  // ⑤ 反向断言：判据必须是 isDownloaded，不能只看"有没有已完成任务"
  {
    // 拿到行内按钮那个分支
    const branch = (appjs.match(/if \(act === 'download'\)[\s\S]{0,420}?\n\s{6}\}/) || [''])[0];
    if (!/if \(isDownloaded\(track\)\)/.test(branch))
      err('★ 行内下载按钮的判据不是 isDownloaded(track) —— 清过 downloads.json 之后' +
          '任务没了、本地库还在，绿勾照绿，却会一路掉到"重新入队"（既不清记录也不体检）');
    else ok('★ 行内按钮判据是 isDownloaded(track)（绿勾的真实来源，不只认任务表）');
    if (/task && task\.status === 'done'/.test(branch))
      err('行内按钮还在用 `task && task.status === "done"` 当判据 —— 这就是漏掉"任务记录没了但绿勾还在"那个分支的原因');
    else ok('★ 反向断言：行内按钮不再只认"已完成任务"');
  }
  {
    // ★ 播放条按钮：从 addEventListener 起截到"第一处 isDownloaded / task.status === 'done'"为止
    const barStart = appjs.indexOf("$('btnDownload').addEventListener('click'");
    const barBranch = barStart < 0 ? '' : appjs.slice(barStart, barStart + 900);
    if (!/if \(isDownloaded\(t\)\)/.test(barBranch))
      err('★ 播放条下载按钮的判据不是 isDownloaded(t) —— 同一个漏分支');
    else ok('★ 播放条按钮同样用 isDownloaded(t) 当判据');
    if (/if \(task && task\.status === 'done'\)/.test(barBranch))
      err('播放条按钮还在用 `task.status === "done"` 当判据 —— 漏分支');
    else ok('★ 反向断言：播放条按钮也不再只认"已完成任务"');
  }

  // ⑥ 反向断言：重下之前必须先把"已完成任务"那条删掉，否则被 skipExisting 拦下
  if (!/api\('downloadRemove', \[t\.id\], false\)/.test(appjs))
    err('★ 清失效任务时没调 downloadRemove —— 主进程那份 downloads.json 里的"已完成"记录还在，' +
        '重下会被 skipExisting 拦下来说"本地已有"，用户看到的是"点了没反应"');
  else ok('★ 清失效任务时调了 downloadRemove（否则重下会被 skipExisting 拦下）');
  // ★ 要查到 revealOrRedownload 内部那一处（不是别处的 downloadList）——
  //   先切出这个函数的函数体再查，否则别处也有 downloadList，断言就永远"响"。
  {
    const fnStart = appjs.indexOf('async function revealOrRedownload(');
    const fnBody = fnStart < 0 ? '' : appjs.slice(fnStart, fnStart + 2600);
    if (!/api\('downloadList'\)/.test(fnBody))
      err('★ 清失效任务时没有回查 downloadList —— 只看界面镜像的话，镜像为空时清不掉主进程那条');
    else ok('★ 清失效任务时回查 downloadList（镜像为空也能清掉主进程那条）');
  }

  // ⑦ 节流：别每次切视图都摸盘
  // ★ 必须查到**主动作**那一行（`if (!force && ...)`），不能只 grep 到
  //   `now - localSweepAt < 60000` —— 把条件改成 `false && ...` 时那个子串还在，
  //   断言就成了"描述现状"而不是"拦人"（判别力实测抓到的）。
  if (!/if \(!force && now - localSweepAt < 60000\) return 0;/.test(appjs))
    err('★ 体检没有 60 秒节流（或闸门被短路了）—— 每次切视图都发一轮 IPC 问磁盘，纯浪费');
  else ok('★ 体检有 60 秒节流（切视图不会每次都摸盘）');

  /* ============ 问题 B：播放断流自愈 ============ */

  // ① 断流事件必须接上（探针确认：以前 stalled/waiting/progress 一个都没监听）
  // ★ 要查到**注册那一行**，不能只查名字 —— 改成 addEventListener('stalledX') 名字还在。
  if (!/audio\.addEventListener\('stalled', \(\) => \{ healOnStall\(\); \}\)/.test(appjs))
    err('★ audio 没有监听 stalled（或没接到 healOnStall）—— 地址过期后断流没有任何自愈动作（"一卡一卡最后卡死"的直接原因）');
  else ok('★ audio 监听了 stalled 且接到 healOnStall（断流时能自愈）');
  if (!/audio\.addEventListener\('waiting', \(\) => \{ healOnStall\(\); \}\)/.test(appjs))
    err('★ audio 没有监听 waiting（或没接到 healOnStall）—— 缓冲不足时同样没有自愈');
  else ok('★ audio 监听了 waiting 且接到 healOnStall');
  if (!/function healOnStall\(/.test(appjs)) err('没有 healOnStall()');
  else ok('★ 有 healOnStall（stalled / waiting 统一入口）');

  // ② 自愈的核心动作：重解析地址 + 记住位置 + seek 回去
  if (!/async function refreshAudioUrl\(/.test(appjs))
    err('★ 没有 refreshAudioUrl —— 断流后没法重新解析地址接回去');
  else ok('★ 有 refreshAudioUrl（重新解析地址并接回原位置）');
  // ★ 查到主动作那一行，并确保它没被短路（`if (false)` / `if (0)`）
  if (!/try \{ if \(resumeAt > 0\.5\) audio\.currentTime = resumeAt; \}/.test(appjs))
    err('★ 自愈没有把播放位置接回去（或这行被短路了）—— 会"从头开始播"，用户以为歌曲重启了');
  else ok('★ 自愈会把播放位置接回去（不会从头开始）');
  if (!/const resumeAt = Number\.isFinite\(atSec\)/.test(appjs))
    err('★ 自愈没有在换 src **之前**记住 currentTime —— 换 src 会把它清零，之后再读就是 0');
  else ok('★ 换 src 之前先记住 currentTime（顺序不能反）');

  // ③ 反向断言：必须节流，否则弱网下疯狂重试反而更卡
  // ★ 同样要查到主动作行，防止 `false &&` 短路。
  if (!/if \(now - lastHealAt < HEAL_COOLDOWN\) return;/.test(appjs))
    err('★ 自愈没有冷却（或闸门被短路了）—— 弱网下 waiting 连发几十次，每次都重解析地址 + 换 src，比原来更卡');
  else ok('★ 反向断言：自愈有冷却（弱网下不会疯狂重试）');
  if (!/if \(healBusy\) return;/.test(appjs))
    err('自愈没有"一次只跑一个"的闸门 —— 并发自愈会互相抢 audio.src');
  else ok('★ 自愈有 healBusy 闸门（一次只跑一个）');

  // ④ 反向断言：用户自己暂停时别自作主张
  // ★ 必须切到 healOnStall 函数体里查 —— 文件里别处也有 `audio.paused` 判断
  //   （armDeadlineTimer 里），不切开的话把 healOnStall 那条删掉照样"通过"。
  // ★ v2.8.2 语义化：闸门从 `audio.paused` 放宽成 `audio.paused && !startPending` ——
  //   "设了地址、play() 还挂着"时 paused 仍是 true，那正是最需要救的状态，
  //   不能把它当成"用户按了暂停"（probe-hang.js 复现的静默停死就是这种）。
  {
    const hsStart = appjs.indexOf('function healOnStall()');
    const hsBody = hsStart < 0 ? '' : appjs.slice(hsStart, hsStart + 900);
    if (!/if \(audio\.paused && !startPending\) return;/.test(hsBody))
      err('★ healOnStall 没判 audio.paused（或被短路）—— 用户按了暂停，界面却跑去重新解析地址、还 safePlay() 继续播');
    else ok('★ 反向断言：用户暂停时不擅自自愈（但"等着出声"时要救）');
  }

  // ⑤ 预防式：解析 deadline，到期前主动刷新
  if (!/function srcDeadlineAt\(/.test(appjs))
    err('★ 没有 srcDeadlineAt —— 地址里的 deadline（探针确认可解析）没用上，只能等断了才自愈');
  else ok('★ 有 srcDeadlineAt（解析地址里的 deadline）');
  if (!/function armDeadlineTimer\(/.test(appjs))
    err('★ 没有 armDeadlineTimer —— 没做"到期前主动刷新"的预防');
  else ok('★ 有 armDeadlineTimer（到期前 60 秒主动换地址）');
  if (!/armDeadlineTimer\(info\.url, seq\)/.test(appjs))
    err('★ playAt 里设完 src 没有挂 deadline 定时器 —— 预防式刷新没接上');
  else ok('★ playAt 设完 audio.src 就挂了 deadline 定时器');
  if (!/clearDeadlineTimer\(\)/.test(appjs) || !/clearDeadlineTimer\(\);\s*\n\s*lastHealAt = 0;/.test(appjs))
    err('★ 换歌时没有清 deadline 定时器 / 自愈冷却 —— 上一首挂的定时器会在新歌上误触发');
  else ok('★ 换歌时清掉 deadline 定时器与自愈冷却');

  // ⑥ error 也要自愈（探针：地址过期多半走 error 而不是 stalled）
  {
    const errStart = appjs.indexOf("audio.addEventListener('error'");
    const errBlock = errStart < 0 ? '' : appjs.slice(errStart, errStart + 700);
    if (!/refreshAudioUrl\(seq, 'manual', at\)/.test(errBlock))
      err('★ error 事件里没有试着自愈 —— 地址过期（多半走 error）时只弹一句"换一首试试"，用户换回来还是同一个过期地址');
    else ok('★ error 事件也会先试着自愈，接不上才提示 + 跳下一首');
    // 反向断言：error 里不能是"光弹提示、不做任何自愈"
    if (!/refreshAudioUrl\(/.test(errBlock) && /toast\('音频加载失败/.test(errBlock))
      err('error 事件变回"只弹提示、什么都不做"了');
    else ok('★ 反向断言：error 不是"只弹提示、什么都不做"');
  }

  // ⑦ v2.8.2：开播看门狗 + 代理超时（"播完该切下一首时彻底停住"）
  // ★ 探针 probe-hang.js 复现的成因：bili:// 背后的 net.fetch 挂住时，
  //   play() 的 promise 永远 pending（不 resolve 也不 reject），
  //   界面既不提示也不跳歌 —— 整条链路静默停死。
  //   所以这两道闸门少一道，那个"静默停住"就会回来。
  {
    if (!/async function onStartGuardTimeout\(/.test(appjs))
      err('★ 没有 onStartGuardTimeout —— 设了地址却一直不出声时没人兜底，播放会静默停死');
    else ok('★ 有开播看门狗 onStartGuardTimeout（设了地址 12 秒不出声就介入）');
    if (!/startPending = true;\s*\n\s*armStartGuard\(seq\);/.test(appjs))
      err('★ playAt 设完 src 没有 armStartGuard —— 看门狗根本没挂上');
    else ok('★ playAt 设完 audio.src 就挂上开播看门狗');
    if (!/addEventListener\('playing', \(\) => \{ updatePlayBtn\(\); endStartWait\(\); \}\)/.test(appjs))
      err('★ playing 事件没有 endStartWait —— 真出声了看门狗还留着，12 秒后会误判成"打不开"');
    else ok('★ 反向断言：真的出声（playing）就收掉看门狗，不会误判');
    // 反向断言：重试过还不行必须跳下一首，不能只是提示一句就干等
    {
      const gStart = appjs.indexOf('async function onStartGuardTimeout(');
      const gBody = gStart < 0 ? '' : appjs.slice(gStart, gStart + 900);
      if (!/next\(1\)/.test(gBody))
        err('★ 看门狗重试后仍然失败时没有 next(1) —— 用户只能对着一个哑巴播放器干等');
      else ok('★ 看门狗重试一次还不行就跳下一首（不会干等）');
    }
    // 开播还没播起来时的那次 waiting 不许重载（否则每首歌多取一次地址）
    if (!/if \(!\(audio\.currentTime > 0\.5\)\) return;/.test(appjs))
      err('★ 自愈没判"还没真的播起来" —— 每首歌开播的正常缓冲都会触发一次换地址重载（多打一次 playurl，更容易被限流，也多一次可能挂住的机会）');
    else ok('★ 反向断言：还没播起来时的正常缓冲不折腾（每首歌只取一次地址）');
    // 播到结尾的 waiting 是"该切歌了"，不是断流 —— 不许重载（重载会把 ended 吃掉）
    {
      const hsStart = appjs.indexOf('function healOnStall()');
      const hsBody = hsStart < 0 ? '' : appjs.slice(hsStart, hsStart + 1400);
      if (!/const nearEnd = Number\.isFinite\(dur\) && dur > 0 && \(dur - audio\.currentTime\) < 1\.0;/.test(hsBody))
        err('★ healOnStall 没判"已经播到结尾" —— 结尾那次 waiting 会去重载地址，把本该来的 ended 吃掉（"播完停在那儿不动"的一个入口）');
      else ok('★ 反向断言：播到结尾的 waiting 直接切歌，不重载（不会吃掉 ended）');
    }
    // refreshAudioUrl 不能"恒 return true" —— 那会把"没救活"当"救活了"
    {
      const rStart = appjs.indexOf('async function refreshAudioUrl(');
      const rBody = rStart < 0 ? '' : appjs.slice(rStart, rStart + 2600);
      if (!/const loaded = audio\.readyState >= 1;/.test(rBody) || !/return loaded;/.test(rBody))
        err('★ refreshAudioUrl 还是"恒 return true" —— 地址换了但流打不开时会被当成救活了，调用方就不提示、不跳歌（又一个静默停住的入口）');
      else ok('★ refreshAudioUrl 按"真的加载出来了"返回（没救活要如实说）');
    }
    // 主进程：代理必须带首字节超时
    if (!/BILI_FIRST_BYTE_TIMEOUT/.test(mainjs))
      err('★ bili:// 代理没有首字节超时 —— CDN"连上却不回数据"时 net.fetch 会永远挂着，播放静默停死');
    else ok('★ bili:// 代理有首字节超时（12 秒拿不到响应头就断）');
    if (!/signal: ac\.signal/.test(mainjs))
      err('★ bili:// 代理没有把 signal 传给 net.fetch —— 超时/取消都不会真的断掉连接');
    else ok('★ bili:// 代理把 signal 传给了 net.fetch（超时 / 换歌能真的断开）');
  }

  /* ---- 离线实测脚本必须在 ---- */
  [['probe-ghost-cb.js', '问题 A 探针（失联文件）'],
   ['probe-stall.js', '问题 B 探针（deadline / 断流）'],
   ['probe-heal.js', '问题 B 自愈实测'],
   ['probe-transition.js', 'v2.8.2 探针（真实音源切歌）'],
   ['probe-hang.js', 'v2.8.2 探针（请求挂住 → 静默停死）']].forEach(([f, name]) => {
    if (fs.existsSync(path.join(ROOT, '.verify', f))) ok(`有 .verify/${f}（${name}）`);
    else err(`缺少 .verify/${f} —— ${name} 必须留档，否则下次改动没法复现`);
  });
}

/* ============================================================
   [58] 批次 B：本地歌曲视图与导入（v2.8.0）
   ------------------------------------------------------------
   批次 B 把"下载来的歌 + 从硬盘导入的歌"合成一个曲库。
   这一类盯三件容易静默失效的事：
     · sameTrack 加没加本地歌分支（漏了 → 收藏/历史/高亮全对不上本地歌）
     · playAt 有没有本地歌分支（漏了 → 点本地歌会去问 B 站要地址，必然失败）
     · 导入有没有"只记录路径、不删/不动文件"（违反会误删用户自己的歌）
   ============================================================ */
console.log('\n[58] 批次 B：本地歌曲视图与导入（v2.8.0）：');
{
  /* ---- ① sameTrack 的本地歌分支 ---- */
  {
    const fn = (appjs.match(/function sameTrack\(a, b\)[\s\S]*?\n\}/) || [''])[0];
    if (!fn) err('★ 找不到 sameTrack —— 它是全局"是不是同一首"的判据，本地歌全靠它融进现有体系');
    else ok('有 sameTrack()');
    // 必须有"按 localPath 判等"的分支（只在两个都有 localPath 时才认得同一首）
    if (!/if \(a\.localPath \|\| b\.localPath\) return !!a\.localPath && a\.localPath === b\.localPath;/.test(fn))
      err('★ sameTrack 没有本地歌分支 —— 本地歌没有 bvid/cid，收藏/历史/正在播放高亮全对不上');
    else ok('★ sameTrack 有本地歌分支（用 localPath 当身份证）');
    // 反向断言：本地歌分支必须在 bvid 比较**之前**（否则 bvid 都是 undefined 会误判"同一首"）
    const idxLocal = fn.indexOf('a.localPath || b.localPath');
    const idxBvid  = fn.indexOf('a.bvid === b.bvid');
    if (idxLocal < 0 || idxBvid < 0 || idxLocal > idxBvid)
      err('★ sameTrack 的本地歌分支没排在 bvid 比较之前 —— 两首本地歌 bvid 都是 undefined，会被误判成同一首');
    else ok('★ 本地歌分支排在 bvid 比较之前（两首本地歌不会因 bvid 都是 undefined 而误判相等）');
  }

  /* ---- ② playAt 的本地歌分支 ---- */
  {
    const fn = (appjs.match(/async function playAt\(index\)[\s\S]*?\n\}/) || [''])[0];
    if (!fn) err('★ 找不到 playAt');
    else ok('有 playAt()');
    if (!/if \(track\.localPath\)/.test(fn))
      err('★ playAt 没有本地歌分支 —— 点本地歌会一路走到"问 B 站要地址"，没有 bvid 必然失败');
    else ok('★ playAt 有本地歌分支（track.localPath 先分流）');
    if (!/audio\.src = myLocalSrc|myLocalSrc = 'local:\/\/get\?p=' \+ encodeURIComponent\(track\.localPath\)/.test(fn))
      err('★ 本地歌分支没有走 local://get 协议 —— 页面 CSP 没放行 file:，用 file:// 会被拦');
    else ok('★ 本地歌走 local://get?p=<encodeURIComponent(路径)>（CSP 允许的唯一本地音频通道）');
    // 用 encodeURIComponent 包路径：反斜杠/空格/中文不转义会把 URL 弄坏
    if (!/encodeURIComponent\(track\.localPath\)/.test(fn))
      err('★ local:// 的路径没经过 encodeURIComponent —— 带空格/中文/反斜杠的路径会拼坏 URL');
    else ok('★ 路径经过 encodeURIComponent（空格/中文/反斜杠不会拼坏 URL）');
    // 本地分支不能落到"要 cid"的那条路上
    const localBlock = fn.slice(fn.indexOf('if (track.localPath)'), fn.indexOf('if (track.localPath)') + 1600);
    if (/await ensureCid\(track\)/.test(localBlock) || /api\('audioUrl'/.test(localBlock))
      err('★ 本地歌分支里还去调 ensureCid / audioUrl —— 本地歌没有 bvid/cid，这一步必然失败');
    else ok('★ 本地歌分支跳过了 ensureCid / audioUrl（不会去问 B 站要地址）');
  }

  /* ---- ③ 本地库的渲染与适配 ---- */
  if (!/function localTrack\(entry\)/.test(appjs))
    err('★ 没有 localTrack() 适配器 —— DB.local 的条目得转成 track 形状才能复用 trackRow/trackListHTML');
  else ok('★ 有 localTrack()（DB.local 条目 → track 形状）');
  if (!/function renderLocal\(\)/.test(appjs))
    err('★ 没有 renderLocal() —— 本地歌曲页画不出来');
  else ok('★ 有 renderLocal()（本地歌曲页）');
  if (!/else if \(currentView === 'local'\) renderLocal\(\);/.test(appjs))
    err('★ renderAll 里没有 local 分支 —— 切到本地歌曲页会画成空/上一页');
  else ok('★ renderAll 已接 local 分支');
  // ★ v2.8.0 修订：local 分支从 localTracks() 改成了 localFilteredTracks()（跟着左栏筛选走）。
  //   这里只要求"有 local 分支"；"必须走 localFilteredTracks"由第 [59] 类断言。
  if (!/if \(currentView === 'local'\) return (localFilteredTracks|localTracks)\(\);/.test(appjs))
    err('★ currentTracks 里没有 local 分支 —— 点本地歌行不会播它（走不到正确队列）');
  else ok('★ currentTracks 已接 local 分支（点行 = 播这首本地歌）');
  if (!/if \(currentView === 'local'\) return '本地歌曲';/.test(appjs))
    err("★ viewLabel 里没有 local 分支 —— 队列抽屉会显示错页面名");
  else ok('★ viewLabel 已接 local 分支');
  // 导航项
  if (!/data-view="local"/.test(html))
    err('★ index.html 没有 data-view="local" 导航项 —— 侧栏点不到本地歌曲');
  else ok('★ index.html 有「本地歌曲」导航项（data-view="local"）');
  // 本地歌行不给下载按钮（dlBtnHTML 对没有 bvid 的行返回空）
  {
    const fn = (appjs.match(/function dlBtnHTML\(track, i\)[\s\S]*?\n\}/) || [''])[0];
    if (!/if \(!track \|\| !track\.bvid\) return '';/.test(fn))
      err('★ dlBtnHTML 没有"本地歌不给下载按钮"的早退 —— 本地歌行会多出一个点了没用的下载箭头');
    else ok('★ dlBtnHTML 对没有 bvid 的行（本地歌）返回空（不画下载按钮）');
  }

  /* ---- ④ 导入：只记录路径，绝不动文件 ---- */
  if (!/async function importLocal\(kind\)/.test(appjs))
    err('★ 没有 importLocal() —— 导入歌曲/文件夹两个入口都点不动');
  else ok('★ 有 importLocal()（导入歌曲 / 导入文件夹共用）');
  if (!/api\('localPickFiles'\)|api\('localPickFolder'\)|fn = kind === 'folder' \? 'localPickFolder' : 'localPickFiles'/.test(appjs))
    err('★ importLocal 没有调 localPickFiles / localPickFolder（主进程现成的挑文件 IPC）');
  else ok('★ importLocal 走主进程的 localPickFiles / localPickFolder');
  // 反向断言：导入**绝不能**出现"删文件 / 移动文件"这类破坏性动作
  {
    const fn = (appjs.match(/async function importLocal\(kind\)[\s\S]*?\n\}/) || [''])[0];
    if (/unlink|rmdir|rename|copyFile|localDelete|localMove/.test(fn))
      err('★ importLocal 里出现了删/移/复制文件的操作 —— 导入必须是"只记录路径、不动文件"（Neo 拍板）');
    else ok('★ 反向断言：importLocal 只记录路径，没有任何删/移/复制文件的动作');
  }
  // 去重：按路径
  if (!/const have = new Set\(DB\.local\.filter\(\(e\) => e && e\.path\)\.map\(\(e\) => String\(e\.path\)\)\);/.test(appjs))
    err('★ importLocal 没有按路径去重 —— 重复导入会把同一首歌加好几遍');
  else ok('★ importLocal 按路径去重（重复导入不会加两遍）');

  /* ---- ⑤ 失联文件的检测与清理（与问题 A 互补：那个删记录，这个只标记） ---- */
  if (!/async function checkLocalMissing\(\)/.test(appjs))
    err('★ 没有 checkLocalMissing() —— 导入的文件被挪走后列表不会标失效');
  else ok('★ 有 checkLocalMissing()（本地库失联检测）');
  {
    const fn = (appjs.match(/async function checkLocalMissing\(\)[\s\S]*?\n\}/) || [''])[0];
    // 反向断言：检测**只标记不删**（删了用户得重新导入一遍）
    if (/DB\.local\s*=\s*DB\.local\.filter/.test(fn))
      err('★ checkLocalMissing 里在删 DB.local —— 本地库体检只该**标记**失效，不该删记录（用户可能只是换了盘符）');
    else ok('★ 反向断言：checkLocalMissing 只标记 missing，不删记录');
    // 查不到这条 → 当它还在（别误标）
    if (!/const miss = r \? r\.exists !== true : false;/.test(fn))
      err('★ checkLocalMissing 没有"查不到这条就当它还在"的兜底 —— 一次查询遗漏会误标一整批');
    else ok('★ 查不到当还在（不因查询遗漏误标失效）');
  }
  if (!/function cleanLocalMissing\(\)/.test(appjs))
    err('★ 没有 cleanLocalMissing() —— 顶部黄条的「清理失效项」按钮点了没反应');
  else ok('★ 有 cleanLocalMissing()（清理失效项）');
  if (!/btnLocalClean/.test(appjs) || !/btnLocalClean/.test(rawAppjs))
    err('★ 没有接 btnLocalClean —— 黄条上的「清理失效项」按钮没有绑定');
  else ok('★ 「清理失效项」按钮已绑定');

  /* ---- ⑥ 下载管理页的「播放」（批次 A 压着没放的那颗） ---- */
  if (!/dlOpBtn\('play', '播放'/.test(appjs))
    err('★ 下载管理页的"已完成"行没有「播放」按钮 —— 批次 A 压着的这颗现在该接上了');
  else ok('★ 下完的歌在下载管理页能直接播（dlOpBtn(\'play\')）');
  if (!/else if \(act === 'play'\)\s*\{ dlPlayTask\(t\); return; \}/.test(appjs))
    err('★ handleDlAction 里没有 play 分支 —— 点了没反应');
  else ok('★ handleDlAction 已接 play 分支');
  if (!/function dlPlayTask\(t\)/.test(appjs))
    err('★ 没有 dlPlayTask()');
  else ok('★ 有 dlPlayTask()（任务相对文件名 → 本地库绝对路径 → 播）');

  /* ---- ⑦ 样式：本地页必备的几个类 ---- */
  if (!/\.local-warn\b/.test(css)) err('★ style.css 没有 .local-warn（失效黄条）');
  else ok('★ 有 .local-warn（失效提示黄条）');
  if (!/\.miss-chip\b/.test(css)) err('★ style.css 没有 .miss-chip（失效小标）');
  else ok('★ 有 .miss-chip（失效小标）');
  if (!/\.track\.missing\b/.test(css)) err('★ style.css 没有 .track.missing（失效行压暗）');
  else ok('★ 有 .track.missing（失效行压暗）');
  if (!/\.local-empty\b/.test(css)) err('★ style.css 没有 .local-empty（空库状态）');
  else ok('★ 有 .local-empty（本地库空状态）');

  /* ---- ⑧ 离线实测脚本必须在 ---- */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round20.js'))) ok('有 .verify/test-round20.js（本地库离线实测）');
  else err('缺少 .verify/test-round20.js —— 本地库（导入/同曲判定/去重/missing）必须有离线实测');
}

/* ============================================================
   [59] 本地歌曲：左栏文件夹列表 + 批量选择（v2.8.0 修订）
   ------------------------------------------------------------
   两个新交互：
     · 左栏把本地库按"来源"分组（本地下载 / 各导入文件夹 / 导入的歌曲）
     · 右栏「批量选择」→ 复用 .track.pickable 渲染，但选择集按 **localPath** 记
   这一类盯四件容易静默失效的事：
     · 分组信息的来源（folderRoot 必须由主进程给，界面不许自己反推）
     · 批量选择的身份键（本地歌没有 bvid，用 bvid 当 key 会永远勾不上）
     · 移除只动记录不动磁盘文件
     · 左栏渲染/点击绑定在不在
   ============================================================ */
console.log('\n[59] 本地歌曲：文件夹列表 + 批量选择（v2.8.0 修订）：');
{
  /* ---- ① 分组：编译期信息 ---- */
  if (!/function localGroups\(\)/.test(appjs))
    err('★ 没有 localGroups() —— 左栏文件夹列表没有数据源');
  else ok('★ 有 localGroups()（左栏分组）');
  if (!/function folderNameOf\(p\)/.test(appjs))
    err('★ 没有 folderNameOf() —— 文件夹分组标题取不到目录名');
  else ok('★ 有 folderNameOf()（取目录名当分组标题）');
  if (!/function localGroupById\(id\)/.test(appjs))
    err('★ 没有 localGroupById()');
  else ok('★ 有 localGroupById()');
  if (!/function localFilteredTracks\(\)/.test(appjs))
    err('★ 没有 localFilteredTracks() —— 右栏不会跟着左栏筛选');
  else ok('★ 有 localFilteredTracks()（右栏跟着左栏筛选）');
  // ★ currentTracks 的 local 分支必须走 localFilteredTracks（否则点行播的是"全部"而不是"当前分组"）
  if (!/if \(currentView === 'local'\) return localFilteredTracks\(\);/.test(appjs))
    err('★ currentTracks 的 local 分支没走 localFilteredTracks —— 点行播放的顺序会和右栏看到的对不上');
  else ok('★ currentTracks 的 local 分支走 localFilteredTracks（播放顺序 = 右栏看到的顺序）');
  // 分组规则：下载来的归 download；有 folderRoot 的按根目录；其余归 imported
  {
    const fn = (appjs.match(/function localGroups\(\)[\s\S]*?\n\}/) || [''])[0];
    if (!/e\.src === 'download' \|\| e\.bvid \|\| e\.key/.test(fn))
      err("★ localGroups 没把\"下载落地\"的判出来 —— 下载来的歌会掉进别的组");
    else ok('★ 下载落地（src===\'download\' / 带 bvid.key）归「本地下载」组');
    if (!/if \(e\.folderRoot\) \{ bump\('folder:' \+ e\.folderRoot/.test(fn))
      err('★ localGroups 没按 folderRoot 分导入文件夹的组');
    else ok('★ 导入文件夹的按 folderRoot 分组（每个文件夹一组）');
    if (!/bump\('imported', '导入的歌曲'/.test(fn))
      err('★ localGroups 没有"单曲导入"的兜底组');
    else ok('★ 单曲导入的归「导入的歌曲」组');
  }

  /* ---- ② folderRoot 的唯一来源：主进程 ---- */
  // 主进程 local:pickFolder 必须把 root 带回来
  if (!/return Object\.assign\(\{ root \}, scanAudioFolder\(root\)\);/.test(mainjs))
    err('★ 主进程 local:pickFolder 没带回 root —— 界面拿不到"用户选的根目录"，分组必然错（多级子目录/同名文件夹会分错）');
  else ok('★ 主进程 local:pickFolder 把 root 一起返回（folderRoot 的唯一来源）');
  // 界面必须用 main 给的 root，不许自己 path.dirname 反推
  {
    const fn = (appjs.match(/async function importLocal\(kind\)[\s\S]*?\n\}/) || [''])[0];
    if (!/const root = \(kind === 'folder' && res\.root\) \? String\(res\.root\) : null;/.test(fn))
      err('★ importLocal 没用主进程给的 res.root 当 folderRoot —— 分组信息来路不明');
    else ok('★ importLocal 用主进程给的 res.root（不从每首歌的路径反推）');
    if (!/folderRoot: root,/.test(fn))
      err('★ importLocal 没把 folderRoot 写进条目 —— 导入的文件夹在左栏分不出组');
    else ok('★ importLocal 把 folderRoot 写进新条目');
    // 反向断言：界面不许自己从路径反推分组
    if (/folderRoot:\s*[^\n]*path\.dirname|folderRoot:\s*[^\n]*split\(/.test(fn))
      err('★ importLocal 在从路径反推 folderRoot —— 必须用主进程给的 root（多级子目录会分错）');
    else ok('★ 反向断言：importLocal 不自行反推 folderRoot');
  }

  /* ---- ③ 迁移：老条目补 folderRoot（只补不删） ---- */
  {
    const mig = fs.readFileSync(path.join(ROOT, 'src', 'store-migrate.js'), 'utf8');
    if (!/d\.local\.forEach\(\(e\) => \{[\s\S]*?e\.folderRoot = null/.test(mig))
      err('★ store-migrate 没给老 local 条目补 folderRoot —— 老用户升级后左栏分不出组（一律 null 归"其他"）');
    else ok('★ store-migrate 给老条目补 folderRoot（缺失→null）');
    if (!/e\.src = 'file'/.test(mig))
      err("★ store-migrate 没给老条目补 src 兜底");
    else ok("★ store-migrate 给老条目补 src 兜底（认不出的来源当 'file'）");
    // 反向断言：不许用 filter/map **替换** d.local（那等于"删掉不认识的条目"）
    if (/d\.local\s*=\s*d\.local\.filter/.test(mig))
      err('★ store-migrate 在 filter 替换 d.local —— 违反"只补不删"，坏条目会被悄悄吞掉');
    else ok('★ 反向断言：store-migrate 原地补字段，不 filter / 不丢条目');
  }

  /* ---- ④ 批量选择：选择集的键必须是 localPath ---- */
  if (!/let localPick = null;/.test(appjs))
    err('★ 没有 localPick 状态 —— 批量选择模式没地方存');
  else ok('★ 有 localPick 状态（本地歌曲的批量选择）');
  if (!/function toggleLocalPick\(\)/.test(appjs))
    err('★ 没有 toggleLocalPick() —— 「批量选择」按钮点了没反应');
  else ok('★ 有 toggleLocalPick()');
  if (!/function localBarHTML\(\)/.test(appjs))
    err('★ 没有 localBarHTML() —— 批量工具条画不出来');
  else ok('★ 有 localBarHTML()（批量工具条）');
  if (!/function localToggle\(i\)/.test(appjs))
    err('★ 没有 localToggle() —— 点行勾不上');
  else ok('★ 有 localToggle()');
  // ★ 核心：选择集按 localPath 存（本地歌没有 bvid）
  {
    const fn = (appjs.match(/function localToggle\(i\)[\s\S]*?\n\}/) || [''])[0];
    if (!/if \(!t \|\| !t\.localPath\) return;/.test(fn))
      err('★ localToggle 没有"没有 localPath 就早退" —— 会往选择集里塞空 key');
    else ok('★ localToggle 用 localPath 当身份（本地歌没有 bvid）');
    if (!/localPick\.selected\.has\(t\.localPath\)/.test(fn) || !/localPick\.selected\.set\(t\.localPath, t\)/.test(fn))
      err('★ localToggle 的键不是 localPath —— 用 bvid 的话本地歌永远勾不上（bvid 是 null）');
    else ok('★ localToggle 按 localPath 存取选择集');
    // 反向断言：不许用 bvid
    if (/localPick\.selected\.[a-z]+\(t\.bvid/.test(fn))
      err('★ localToggle 里用了 t.bvid 当键 —— 本地歌 bvid 恒为 null，勾选会串成一锅粥');
    else ok('★ 反向断言：localToggle 不用 bvid 当键');
  }
  // trackRow 必须支持按指定键反查勾选（pickKey）
  {
    const fn = (appjs.match(/function trackRow\(track, i, opts = \{\}\)[\s\S]*?\n\}/) || [''])[0];
    if (!/const pickKey = opts\.pickKey \|\| 'bvid';/.test(fn))
      err('★ trackRow 不支持 opts.pickKey —— 本地歌的勾选状态查不到（会永远显示未勾）');
    else ok('★ trackRow 支持 opts.pickKey（默认 bvid，本地歌传 localPath）');
    if (!/const pickId = opts\.pickIdOf \? opts\.pickIdOf\(track\) : track\[pickKey\];/.test(fn) || !/pickSet\.has\(pickId\)/.test(fn))
      err('★ trackRow 没用 pickKey / pickIdOf 取身份键去查选择集');
    else ok('★ trackRow 按 pickKey（或 pickIdOf）取身份键查选择集');
  }
  // localTrackOpts 必须把 pickKey 传成 localPath
  if (!/function localTrackOpts\(\)/.test(appjs))
    err('★ 没有 localTrackOpts()');
  else {
    const fn = (appjs.match(/function localTrackOpts\(\)[\s\S]*?\n\}/) || [''])[0];
    if (!/pickKey: 'localPath'/.test(fn))
      err('★ localTrackOpts 没传 pickKey:\'localPath\' —— 本地歌的勾选态渲染不出来');
    else ok("★ localTrackOpts 给批量选择传 pickKey:'localPath'");
  }

  /* ---- ⑤ 移除：只动记录、不动磁盘文件 ---- */
  if (!/function removeLocalPaths\(paths\)/.test(appjs))
    err('★ 没有 removeLocalPaths()');
  else ok('★ 有 removeLocalPaths()');
  {
    const fn = (appjs.match(/function removeLocalPaths\(paths\)[\s\S]*?\n\}/) || [''])[0];
    if (/unlink|rmdir|copyFile|localDelete/.test(fn))
      err('★ removeLocalPaths 里出现了删文件的操作 —— 移出库必须**只删记录**（文件是用户自己的）');
    else ok('★ 反向断言：removeLocalPaths 只删记录，不碰磁盘文件');
  }
  if (!/async function localDoRemovePicked\(\)/.test(appjs))
    err('★ 没有 localDoRemovePicked() —— 「移出库」按钮点了没反应');
  else ok('★ 有 localDoRemovePicked()');
  if (!/async function localRemoveFolder\(root\)/.test(appjs))
    err('★ 没有 localRemoveFolder() —— 左栏文件夹行的 ✕ 点了没反应');
  else ok('★ 有 localRemoveFolder()（左栏 ✕ 移除整组）');
  {
    const fn = (appjs.match(/async function localRemoveFolder\(root\)[\s\S]*?\n\}/) || [''])[0];
    if (!/if \(localFilter === 'folder:' \+ r\) localFilter = 'all';/.test(fn))
      err("★ localRemoveFolder 没处理\"删掉正在看的分组\" —— 用户会停在一个已经不存在的分组上，右栏空白");
    else ok('★ 删掉正在看的分组 → 自动退回「全部歌曲」');
    if (/unlink|rmdir|copyFile/.test(fn))
      err('★ localRemoveFolder 里出现了删文件的操作');
    else ok('★ 反向断言：localRemoveFolder 只动记录');
  }

  /* ---- ⑥ 退出勾选态的三条路（换分组 / 离开页面 / 干完） ---- */
  if (!/if \(localPick && currentView !== 'local'\) localPick = null;/.test(appjs))
    err('★ renderAll 里没有"离开本地页就退出勾选态" —— 跑到别的页面还会带着勾选框');
  else ok('★ 离开本地页自动退出勾选态');
  if (!/localFilter = gid;[\s\S]{0,80}localPick = null;/.test(appjs))
    err('★ 换分组时没有清 localPick —— 选择集是按上一个分组选的，留着会串');
  else ok('★ 换分组时自动退出勾选态');

  /* ---- ⑦ 左栏渲染与点击绑定 ---- */
  if (!/class="local-side"/.test(appjs))
    err('★ renderLocal 里没有 .local-side —— 左栏没画出来');
  else ok('★ renderLocal 画出左栏（.local-side）');
  if (!/class="local-folder-row[^"]*" data-lgroup=/.test(appjs))
    err('★ 左栏行没有 data-lgroup —— 点了不切换');
  else ok('★ 左栏行带 data-lgroup（可点切换）');
  if (!/data-lrmfolder=/.test(appjs))
    err('★ 文件夹行没有 data-lrmfolder —— 文件夹的 ✕ 点了不生效');
  else ok('★ 文件夹行带 data-lrmfolder（✕ 可点）');
  if (!/const folderRow = e\.target\.closest\('\[data-lgroup\]'\);/.test(appjs))
    err('★ 点击分发里没有接 [data-lgroup] —— 点左栏没反应');
  else ok('★ 点击分发已接左栏（[data-lgroup]）');
  // ★ 顺序：✕ 必须在"切分组"之前判（✕ 在行里面，不先拦会被整行点击吃掉）
  {
    const iRm = appjs.indexOf("const rmFolder = e.target.closest('[data-lrmfolder]')");
    const iRow = appjs.indexOf("const folderRow = e.target.closest('[data-lgroup]')");
    if (iRm < 0 || iRow < 0 || iRm > iRow)
      err('★ 点击分发里 ✕ 没排在"切分组"之前 —— 点 ✕ 会先被整行点击吃掉（删不掉）');
    else ok('★ ✕ 排在整行点击之前（点 ✕ 不会被切换分组吃掉）');
  }
  if (!/id === 'btnLocalPick'\) \{ toggleLocalPick\(\); return; \}/.test(appjs))
    err('★ 「批量选择」按钮没绑定 —— 点了没反应');
  else ok('★ 「批量选择」按钮已绑定');
  if (!/id === 'btnLocalPickAll'\) \{ localPickAll\(\); return; \}/.test(appjs) || !/id === 'btnLocalPickNone'\) \{ localPickNone\(\); return; \}/.test(appjs))
    err('★ 「全选 / 清空选择」没绑定');
  else ok('★ 「全选 / 清空选择」已绑定');
  // 点行：本地批量选择要排在"点整行 = 播放"之前
  if (!/if \(selPick\) selToggle\(i\);[\s\S]{0,120}else if \(localPick\) localToggle\(i\);/.test(appjs))
    err('★ 点行分发里没有 localPick 分支 —— 在本地页点行会直接播放，勾不上');
  else ok('★ 点行分发已接 localPick（在"点整行=播放"之前）');
  {
    // ★ 注意 appjs 是**去注释**过的，所以不能拿注释文字当锚点。
    //   也不能用 `const tracks = currentTracks();`（别处出现过多次）——
    //   用**紧跟播放那一句**的 startFromView 当锚点才唯一。
    const iPick = appjs.indexOf("const pickRow = e.target.closest('.track.pickable')");
    const iPlay = appjs.lastIndexOf('startFromView(tracks, i)');
    if (iPick < 0 || iPlay < 0 || iPick > iPlay)
      err('★ pickable 行分发没排在"点整行=播放"之前 —— 勾选模式点行会把歌播掉');
    else ok('★ pickable 行分发排在"点整行=播放"之前');
  }

  /* ---- ⑧ 样式 ---- */
  if (!/\.local-wrap\b/.test(css)) err('★ style.css 没有 .local-wrap（左右两栏容器）');
  else ok('★ 有 .local-wrap（两栏容器）');
  if (!/\.local-side\b/.test(css)) err('★ style.css 没有 .local-side（左栏）');
  else ok('★ 有 .local-side（左栏）');
  if (!/\.local-folder-row\b/.test(css)) err('★ style.css 没有 .local-folder-row');
  else ok('★ 有 .local-folder-row');
  if (!/\.local-folder-row:hover \.del/.test(css)) err('★ 没有 .local-folder-row:hover .del（✕ 悬停出现）');
  else ok('★ 文件夹行的 ✕ 悬停才出现');
  if (!/\.ghost-btn\.danger\b/.test(css)) err('★ 没有 .ghost-btn.danger（「移出库」的破坏性配色）');
  else ok('★ 有 .ghost-btn.danger（「移出库」按钮的破坏性配色）');

  /* ---- ⑨ 离线实测脚本必须在 ---- */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round21.js'))) ok('有 .verify/test-round21.js（文件夹列表 + 批量选择离线实测）');
  else err('缺少 .verify/test-round21.js —— 左栏分组 / 批量选择 / 移出库必须有离线实测');
}

/* ---- 60) v2.9.0：mini 词开关 / 工具条常显 / 导入落地方式 ---- */
console.log('\n[60] v2.9.0 · mini 词开关 + 工具条常显 + 导入落地（v2.9.0）：');
{
  /* ===== A. mini 条上的 ✕ 换成「词」 ===== */
  if (!htmlIds.has('miniLyric'))
    err('★ mini 条上没有 #miniLyric（桌面歌词开关）—— mini 里就再没有歌词入口了');
  else if (htmlIds.has('miniClose'))
    err('★ #miniClose 还在 —— 说好换成「词」，两个都留着第一行会挤（mini 的宽度是算出来的）');
  else ok('★ mini 条：✕ 已换成「词」，两个没并存');

  if (!/\$\('miniLyric'\)\.addEventListener\('click', \(\) => toggleDesktopLyric\(\)\)/.test(appjs))
    err('★ #miniLyric 没绑到 toggleDesktopLyric —— 点了不会开桌面歌词');
  else ok('★ #miniLyric 绑到了 toggleDesktopLyric');

  // ★ 真机反馈：`#i-lyric`（三横 + 小圆点）和旁边的播放队列 ☰ 长得几乎一样，放一起分不出来。
  //   所以 mini 条上那个按钮必须是**汉字「词」**，不许再退回图标。
  if (!/<button[^>]*id="miniLyric"[^>]*>\s*<span>词<\/span>\s*<\/button>/.test(html))
    err('★ mini 条的「词」按钮不是纯汉字（图标 #i-lyric 和播放队列 ☰ 太像，会认错）');
  else ok('★ mini 条的「词」是汉字，不是图标');

  // 状态同步：按钮要跟着"桌面歌词开没开"亮灭（否则点了看不出状态）
  if (!/const mb = \$\('miniLyric'\)/.test(appjs) || !/mb\.classList\.toggle\('on'/.test(appjs))
    err('★ updateLyricBtn 没同步 mini 那个「词」按钮 —— 点了不亮、关了不灭');
  else ok('★ mini「词」按钮跟着桌面歌词状态亮灭');
  if (!/body\.mini \.mini-actions \.win-btn#miniLyric\.on/.test(css))
    err('★ style.css 没有 #miniLyric.on 的样式（亮起状态看不出来）');
  else ok('★ 有 #miniLyric.on 的亮起样式');

  /* ===== B. 歌曲行右侧按钮：悬停 / 一直显示 ===== */
  if (!/body\.ops-always \.track \.ops\s*\{[^}]*opacity:\s*var\(--ops-alpha/.test(css))
    err('★ 没有 body.ops-always 那条规则 —— 设置里选「一直显示」不会有任何效果');
  else ok('★ 有 body.ops-always .track .ops（用 --ops-alpha 控制亮度）');
  if (!/--ops-alpha:\s*0?\.\d+/.test(css))
    err('★ :root 没定义 --ops-alpha 默认值 —— var() 取不到值时整条规则会失效');
  else ok('★ :root 给了 --ops-alpha 默认值');
  // ★ 反向断言：常显只能动 opacity，不能动 display（动了会让整行宽度跳一下）
  if (/body\.ops-always \.track \.ops\s*\{[^}]*display:/.test(css))
    err('★ 常显规则里动了 display —— .ops 一直占着宽度，改成 display 会让列表在切档时跳一下');
  else ok('★ 反向断言：常显只动 opacity、不动 display（切档不跳）');
  // ★ 反向断言：挑视频那一屏仍然要藏起来
  if (!/\.track\.pickable \.ops\s*\{\s*display:\s*none/.test(css))
    err('★ .track.pickable .ops 的 display:none 没了 —— 挑视频那一屏会冒出一排按钮');
  else ok('★ 反向断言：挑视频那一屏的按钮仍然 display:none');

  if (!/function applyOpsMode\(\)/.test(appjs) || !/classList\.toggle\('ops-always'/.test(appjs))
    err('★ 没有 applyOpsMode() —— 设置切了也不会立即生效');
  else ok('★ 有 applyOpsMode()（切档立即生效，不用重启）');

  /* ★★ 真机反馈：带「合集 N」徽章的行，右边按钮比别的行更靠右。
     根因是网格 6 列、但元素按条件拼 —— 没有徽章的行少一个元素，自动排布把
     「时长」塞进徽章列、「操作」塞进时长列，第 6 列空着；空列没宽度但 gap 还在 → 左移 13px。
     修法是把 ops / dur / badge 按"从右往左数"钉死在固定列上。这三条少一条就会复发。 */
  if (!/\.track:not\(\.pickable\) \.ops\s*\{[^}]*grid-column:\s*-2/.test(css))
    err('★ 没有把 .ops 钉在第 6 列 —— 没有徽章的行按钮组会左移 13px（和带徽章的行对不齐）');
  else ok('★ .ops 钉死在最后一列（-2 / -1）');
  if (!/\.track:not\(\.pickable\) \.dur\s*\{[^}]*grid-column:\s*-3/.test(css))
    err('★ 没有把 .dur 钉在第 5 列 —— 时长会跟着徽章有无而左右乱跳');
  else ok('★ .dur 钉死在第 5 列（-3 / -2）');
  if (!/\.track:not\(\.pickable\) \.badge,\s*\n?\.track:not\(\.pickable\) \.miss-chip\s*\{[^}]*grid-column:\s*-4/.test(css))
    err('★ 没有把 .badge / .miss-chip 钉在第 4 列 —— 有徽章时会把时长和按钮一起推走');
  else ok('★ .badge / .miss-chip 钉死在第 4 列（-4 / -3）');
  // ★ 反向断言：这几条只许管非勾选态。勾选态是另一套 4 列布局，插手会把复选框那屏挤乱。
  if (/\.track \.ops\s*\{[^}]*grid-column/.test(css) || /\.track \.dur\s*\{[^}]*grid-column/.test(css))
    err('★ 列位置规则没限定 :not(.pickable) —— 会把勾选态那套 4 列布局挤乱');
  else ok('★ 反向断言：列位置规则只作用于非勾选态');
  if (!/applyOpsMode\(\);\s*\n?\s*\/\*|applyOpsMode\(\)/.test(appjs))
    err('★ applyAppearance 没调 applyOpsMode —— 启动时不会按存档恢复');
  else ok('★ 启动时会按存档恢复（applyAppearance 里调了）');
  if (!htmlIds.has('selListOps') || !htmlIds.has('rngOpsAlpha'))
    err('★ 设置页缺控件：selListOps（悬停/常显）或 rngOpsAlpha（亮度）');
  else ok('★ 设置页有两个控件：显示方式 + 亮度');
  // 老存档零迁移：没这一项就是 'hover'
  if (!/listOps:\s*old\.listOps === 'always' \? 'always' : DEFAULT_SETTINGS\.listOps/.test(appjs))
    err('★ migrateSettings 没给 listOps 兜默认值 —— 老存档会拿到 undefined');
  else ok('★ migrateSettings 给 listOps 兜了默认（老存档 = 悬停，行为不变）');
  if (!/s\.listOps\s*=/.test(storemigrate) || !/s\.opsOpacity\s*=/.test(storemigrate))
    err('★ store-migrate.js 没补 listOps / opsOpacity —— 主进程写回存档时会把这两项弄丢');
  else ok('★ store-migrate.js 也补了这两个字段（主进程那条路不会丢）');

  /* ===== C. 导入收藏夹：新建 / 加入现有 ===== */
  if (!/async function askImportTarget\(\)/.test(appjs))
    err('★ 没有 askImportTarget() —— 导入时没法选"加入现有歌单"');
  else ok('★ 有 askImportTarget()（先问"到哪儿"）');
  // ★★ 这条是这次踩出来的坑：用 showPrompt() 会把 promptResolve 清成 null，
  //    closePrompt(v) 没人接，await 永远不返回 —— 弹窗关了但歌没进去。
  // ★ 必须**切开函数体**再查：openPrompt 里也有一句 `promptResolve = resolve;`，
  //   不切的话把 askImportTarget 里那句删掉照样"通过"（判别力实测当场抓到）。
  const aitStart = appjs.indexOf('async function askImportTarget()');
  const aitBody = aitStart < 0 ? '' : appjs.slice(aitStart, aitStart + 2600);
  if (/showPrompt\(/.test(aitBody))
    err('★ askImportTarget 里用了 showPrompt() —— 它会把等待者清成 null，导入流程会静默卡住（必须自己挂 promptResolve）');
  else ok('★ 反向断言：askImportTarget 没用 showPrompt（用 renderPrompt + 自己挂等待者）');
  if (!/promptResolve = resolve;/.test(aitBody))
    err('★ askImportTarget 没自己挂 promptResolve —— closePrompt 找不到人接');
  else ok('★ askImportTarget 自己挂了 promptResolve');
  if (!/importPicked[\s\S]{0,600}?await askImportTarget\(\)/.test(appjs))
    err('★ importPicked 没走 askImportTarget —— 还是只能新建');
  else ok('★ importPicked 已改为先问"到哪儿"');
  // ★ 必须切开 addInto 的函数体再查：v2.9.0 的「批量移出」里也有一句
  //   `list.some((x) => sameTrack(x, t))`，全局 grep 会被它骗过去（判别力实测抓到过一次）。
  const addIntoBody = (() => {
    const i = appjs.indexOf('const addInto = async (pl) => {');
    if (i < 0) return '';
    const j = appjs.indexOf('\n  };', i);
    return appjs.slice(i, j < 0 ? i + 700 : j);
  })();
  // ★ v2.11.1：判重逻辑挪进了 addToPlaylistFront()（两处入口共用），
  //   所以这里改成"addInto 必须走那个函数，且那个函数里确实按 sameTrack 判重"。
  // ★ 注意：第 60 类这个作用域里没有 bodyOf()（那是第 62/63 类块内定义的），
  //   所以这里用正则直接切 addToPlaylistFront 那一段。
  if (!/addToPlaylistFront\(pl, list\)/.test(addIntoBody) ||
      !/function addToPlaylistFront\(pl, tracks\) \{[\s\S]{0,400}?sameTrack\(x, t\)/.test(appjs))
    err('★ 加入现有歌单时没按 sameTrack 判重 —— 同一首歌会被塞两遍');
  else ok('★ 加入现有歌单按 sameTrack 判重（和「加入歌单」同一条规则）');
  if (!/\.pl-sep\b/.test(css)) err('★ 没有 .pl-sep 样式（现有歌单与「新建」之间那道分隔）');
  else ok('★ 有 .pl-sep 分隔样式');

  /* ===== ⑨ 离线实测 / 探针必须在 ===== */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round23.js'))) ok('有 .verify/test-round23.js（本轮三处改动的离线实测）');
  else err('缺少 .verify/test-round23.js —— mini 词开关 / 工具条常显 / 导入落地必须有离线实测');
  if (fs.existsSync(path.join(ROOT, '.verify', 'probe-viz.js'))) ok('有 .verify/probe-viz.js（律动条频谱可行性探针，留给下一版）');
  else err('缺少 .verify/probe-viz.js —— 律动条的技术结论靠它，删了以后要重新趟一遍');
}

/* ---- 61) v2.9.0：「批量下载」→「批量选择」（下载 / 加入歌单 / 喜欢 / 移出） ---- */
console.log('\n[61] v2.9.0 · 列表的「批量选择」：');
{
  /** 切出一段函数体（从函数签名到下一个顶层 `\n}`）。
   *  ★ 必须切开查，不能直接在整个 app.js 里 grep —— 同名字样在别处出现会误命中，
   *    上一轮 askImportTarget 就是这么被骗过一次的。 */
  const bodyOf = (sig) => {
    const i = appjs.indexOf(sig);
    if (i < 0) return '';
    const j = appjs.indexOf('\n}\n', i);
    return appjs.slice(i, j < 0 ? appjs.length : j);
  };

  /* ===== ① 工具条那颗按钮换了名 ===== */
  if (!/id="btnSelectFav"[^`]*?批量选择/.test(appjs) || !/id="btnSelectPl"[^`]*?批量选择/.test(appjs))
    err('★ 「我喜欢」/「歌单」工具条上的按钮不叫「批量选择」');
  else ok('★ 工具条：两个列表都改成了「批量选择」');

  if (!/picking \? '退出批量选择' : '批量选择'/.test(appjs))
    err('★ 进了选择模式后按钮没变成「退出批量选择」');
  else ok('★ 进模式后按钮变「退出批量选择」（再点一下能出来）');

  // 反向：旧的 btnDownloadFav / btnDownloadPl 不许留 —— 两套并存会有一个是死按钮
  if (/\bbtnDownloadFav\b/.test(appjs) || /\bbtnDownloadPl\b/.test(appjs))
    err('★ 旧的 btnDownloadFav / btnDownloadPl 还有残留（两套入口会打架）');
  else ok('★ 旧的 btnDownloadFav / btnDownloadPl 已清干净');

  // ★ v2.11.0 改了口径：解析页的「播放全部 (N)」和「批量下载 (N)」**都删掉了** ——
  //   Neo 拍板"工具条照搬「我喜欢」"，下载走批量选择。所以这里从"必须留着"改成"不许复活"。
  if (/id="btnDownloadParsed"|id="btnPlayParsed"/.test(appjs))
    err('★ 解析页的「播放全部 / 批量下载」又回来了 —— v2.11.0 已按"照搬我喜欢"删掉');
  else ok('★ 反向断言：解析页的「播放全部 / 批量下载」没有复活');

  /* ===== ② 选择集改名：dlPick → selPick ===== */
  if (!/let selPick = null;/.test(appjs))
    err('★ 没有 selPick（选择集）');
  else ok('★ 选择集变量叫 selPick');
  // 反向：dlPick 只允许活在注释里（历史说明），不许再有活的代码引用
  if (/\bdlPick\.selected\b/.test(appjs) || /\bdlPick = /.test(appjs) || /\bif \(dlPick\)/.test(appjs))
    err('★ 还有活的 dlPick 引用 —— 改名只改了一半（会有一半代码读旧变量）');
  else ok('★ 没有活的 dlPick 引用（改名改干净了）');

  /* ===== ③ 四个动作 + 按视图分叉 ===== */
  const acts = ['btnSelDownload', 'btnSelAddPl', 'btnSelFav', 'btnSelRemove'];
  const missAct = acts.filter((a) => !new RegExp(`id: '${a}'`).test(appjs));
  if (missAct.length) err(`★ 批量选择的动作缺了：${missAct.join(' / ')}`);
  else ok('★ 四个动作都在：下载 / 加入歌单 / 喜欢 / 移出');

  if (!/if \(currentView !== 'favorites'\) \{\s*\n\s*acts\.push\(\{ id: 'btnSelFav'/.test(appjs))
    err('★ 「我喜欢」页里也画了「喜欢」按钮 —— 那一页每首都已经喜欢了，点不出任何反应');
  else ok('★ 「我喜欢」页不画「喜欢」（那一页全已喜欢，放了就是死按钮）');

  if (!/label: currentView === 'favorites' \? '取消喜欢' : '移出歌单'/.test(appjs))
    err('★ 移出按钮的文案没按视图分叉（「取消喜欢」/「移出歌单」）');
  else ok('★ 移出按钮按视图换文案：取消喜欢 / 移出歌单');

  // 破坏性那个必须 danger 配色，且**是最后 push 进去的那一个**（位置固定，别让肌肉记忆点错）。
  // ★ 还要禁掉 unshift / splice：它们能"看起来写在最后、实际插到前面去"，
  //   只比文字顺序是查不出来的（判别力实测就是这么漏过一条的）。
  {
    const fn = bodyOf('function selActions()');
    const lastPush = fn.lastIndexOf('acts.push(');
    const isLast = lastPush >= 0 && fn.indexOf("id: 'btnSelRemove'", lastPush) >= 0;
    if (!/danger: true/.test(fn)) err('★ 「移出」按钮没标 danger');
    else if (!isLast || /acts\.unshift\(/.test(fn) || /acts\.splice\(/.test(fn))
      err('★ 「移出」不是最后 push 进去的按钮 —— 破坏性操作必须永远排在最后（不然肌肉记忆会点错）');
    else ok('★ 「移出」是 danger 配色、且永远排在最后');
  }

  /* ===== ④ 两条选择条共用一个渲染器 ===== */
  if (!/function pickBarHTML\(n, actions, opts\)/.test(appjs))
    err('★ 没有统一的 pickBarHTML() —— 两条选择条又会各写一份，早晚不一致');
  else ok('★ 有统一的 pickBarHTML(n, actions, opts)');
  if (!/return pickBarHTML\(n, selActions\(\), \{[\s\S]{0,160}?allId: 'btnSelPickAll'/.test(appjs))
    err('★ 列表那条选择条没走 pickBarHTML');
  else ok('★ 列表的选择条走 pickBarHTML');
  if (!/return pickBarHTML\(n, \[/.test(appjs))
    err('★ 本地歌曲那条选择条没走 pickBarHTML');
  else ok('★ 本地歌曲的选择条也走 pickBarHTML（两边永远长得一样）');

  if (!/\.bar-sep\b/.test(css)) err('★ 没有 .bar-sep 样式（"选哪些"和"做什么"之间那道竖线）');
  else ok('★ 有 .bar-sep 分组竖线');
  // 4 个动作按钮在窄窗口下必须能换行，否则右边那颗「移出」会被裁掉
  if (!/\.imp-bar-actions \{[^}]*flex-wrap: wrap/.test(css))
    err('★ .imp-bar-actions 没有 flex-wrap —— 按钮一多，窄窗口下最右边那颗会被裁掉');
  else ok('★ .imp-bar-actions 允许换行（4 个动作按钮不会挤出内容区）');

  /* ===== ⑤ 下载：跳过本地歌，并且把跳过的数量说出来 ===== */
  {
    const fn = bodyOf('async function selDoDownload()');
    if (!/const dlAble = list\.filter\(\(t\) => t && t\.bvid\)/.test(fn))
      err('★ 批量下载没筛掉本地歌 —— 本地文件送进下载队列只会报错');
    else ok('★ 批量下载先筛掉本地歌（只送有 bvid 的）');
    if (!/note: localN \?/.test(fn))
      err('★ 跳过几首本地歌没说 —— 用户会以为"选了 5 首怎么只下了 3 首"');
    else ok('★ 跳过的本地歌数量会拼进提示');
    if (!/if \(opts\.note\)\s+parts\.push\(opts\.note\)/.test(appjs))
      err('★ enqueueDownloads 不支持 opts.note —— 跳过说明会被后一条 toast 盖掉');
    else ok('★ enqueueDownloads 支持 opts.note（拼进同一条 toast）');
  }

  /* ===== ⑥ 移出：按视图分叉、不弹确认、干完退出模式 ===== */
  {
    const fn = bodyOf('async function selDoRemove()');
    if (!/if \(inFav\)/.test(fn) || !/currentView\.startsWith\('playlist:'\)/.test(fn))
      err('★ 批量移出没按视图分叉（我喜欢 / 歌单）');
    else ok('★ 批量移出按视图分叉：我喜欢 / 歌单');
    if (/askConfirm/.test(fn))
      err('★ 批量移出弹了确认框 —— 和行内那个垃圾桶口径不一致（那里是直接移的）');
    else ok('★ 批量移出不弹确认（和行内垃圾桶同口径）');
    if (!/selPick = null;/.test(fn))
      err('★ 移出后没退出选择模式 —— 选择集里指着已经不在列表上的行');
    else ok('★ 移出后自动退出选择模式');
  }

  /* ===== ⑦ 歌单里混着本地歌也能勾上 ===== */
  // ★ v2.11.0：B 站歌那支的键变成 'b:' + bvid + '#' + cid（分P 要靠 cid 区分），
  //   所以这里只认前缀 'b:' + t.bvid，不再要求整行以分号结尾。
  if (!/function selKey\(t\)/.test(appjs) || !/return 'b:' \+ t\.bvid/.test(appjs) || !/return 'l:' \+ t\.localPath;/.test(appjs))
    err('★ 没有 selKey()（B 站歌 b: + bvid / 本地歌 l: + localPath）—— 歌单里的本地歌勾不上');
  else ok('★ selKey() 给两种歌各自的身份键（b: / l:）');
  if (!/pickIdOf: selKey/.test(appjs))
    err('★ 列表渲染没传 pickIdOf: selKey —— 本地歌的勾选状态永远显示未勾');
  else ok('★ 两个列表都传了 pickIdOf: selKey');
  if (!/const pickId = opts\.pickIdOf \? opts\.pickIdOf\(track\) : track\[pickKey\];/.test(appjs))
    err('★ trackRow 不认 pickIdOf');
  else ok('★ trackRow 认 pickIdOf（取身份键的口子）');

  /* ===== ⑧ 干完能自动退出（换页也退出） ===== */
  if (!/if \(selPick && selPick\.view !== currentView\) selPick = null;/.test(appjs))
    err('★ 换页不会退出选择模式 —— 跑到「发现」会发现每行都带勾选框');
  else ok('★ 换页自动退出选择模式');
  // ★ 注意：appjs 是**去掉注释之后**的源码（见文件顶部 stripLine/stripBlock），
  //   所以这里只能按代码形状断言，不能靠注释里的文字。
  if (!/\n  if \(selPick\) selPick = null;/.test(appjs))
    err('★ 下载排完队列后没退出选择模式');
  else ok('★ 下载排完队列后退出选择模式');

  /* ===== ⑨ 离线实测必须在 ===== */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round24.js'))) ok('有 .verify/test-round24.js（批量选择四个动作的离线实测）');
  else err('缺少 .verify/test-round24.js —— 四个动作必须真的点一遍');
}

/* ---- 62) v2.10.0：吸顶 / 拖选 / 禁止选中文字 / 列表搜索 / 快速定位 ---- */
console.log('\n[62] v2.10.0 · 吸顶 + 拖选 + 禁选文字 + 搜索 + 定位：');
{
  /** 切出一段函数体（从函数签名到下一个顶层 `\n}`）。必须切开查 —— 全局 grep 会被别处同名写法骗过。 */
  const bodyOf = (sig) => {
    const i = appjs.indexOf(sig);
    if (i < 0) return '';
    const j = appjs.indexOf('\n}\n', i);
    return appjs.slice(i, j < 0 ? appjs.length : j);
  };

  /* ===== ① 禁止选中界面文字 ===== */
  if (!/html,\s*body\s*\{[^}]*user-select:\s*none/.test(css))
    err('★ 没有全局 user-select: none —— 鼠标一划就把歌名/按钮整片选蓝');
  else ok('★ 全局禁止选中文字（html, body）');
  // 白名单：输入框必须能选，否则没法正常输入
  if (!/input,\s*textarea,\s*select,\s*\[contenteditable="true"\]/.test(css))
    err('★ 输入框没开 user-select: text —— 输入框里选不了字了');
  else ok('★ 输入框仍然能选文字（白名单）');
  if (!/\.lyric-box[^{]*\{[^}]*user-select:\s*text/.test(css))
    err('★ 整页歌词没开 user-select: text —— 想复制一句歌词复制不了');
  else ok('★ 整页歌词能选（要复制歌词）');
  if (!/\.err[^{]*\{[^}]*user-select:\s*text/.test(css))
    err('★ 报错信息没开 user-select: text —— 出错时没法复制出来查');
  else ok('★ 报错信息能选（要复制出来查）');

  // Ctrl+A：光靠 CSS 不保险，还要在 keydown 里拦
  if (!/if \(key === 'Ctrl\+a'\)\s*\{\s*e\.preventDefault\(\);/.test(appjs))
    err('★ 没有拦下 Ctrl+A —— 它还会触发 Chromium 的"全选"，把选区/焦点搞乱');
  else ok('★ Ctrl+A 在全局 keydown 里被拦下（不再全选界面文字）');
  if (!/if \(key === 'Ctrl\+a'\)[\s\S]{0,260}?selPickAll\(\)/.test(appjs))
    err('★ 批量选择模式下 Ctrl+A 没有做成「全选歌曲」');
  else ok('★ 批量选择模式下 Ctrl+A = 全选歌曲（同一个键，语义更合理）');
  // 反向：Ctrl+A 的处理必须在 isTypingTarget 之后，否则输入框里按 Ctrl+A 全选不了文字
  {
    // ★ 锚点用 `if (recordingKeyId) { captureRecordedKey(e); return; }` —— 这句只有
    //   全局 keydown handler 里有。别拿 `keyFromEvent(e)` 当锚点：captureRecordedKey
    //   里也有一句一样的，indexOf 会先撞上它（踩过）。
    const anchor = appjs.indexOf('if (recordingKeyId) { captureRecordedKey(e); return; }');
    const kd = anchor < 0 ? '' : appjs.slice(Math.max(0, anchor - 700), anchor + 1600);
    const typingAt = kd.indexOf('isTypingTarget(e.target)');
    const ctrlAAt = kd.indexOf("if (key === 'Ctrl+a')");
    if (typingAt < 0 || ctrlAAt < 0 || ctrlAAt < typingAt)
      err('★ Ctrl+A 的拦截排在 isTypingTarget 之前 —— 输入框里按 Ctrl+A 就选不了文字了');
    else ok('★ Ctrl+A 拦截排在"输入框放行"之后（输入框里仍能全选文字）');
  }

  /* ===== ② 选择条吸顶 ===== */
  if (!/\.pick-bar\s*\{[^}]*position:\s*sticky/.test(css))
    err('★ .pick-bar 没有 position: sticky —— 选到列表下半部分还得滚回顶部才能点动作');
  else ok('★ .pick-bar 吸顶（position: sticky）');
  if (!/\.pick-bar\s*\{[^}]*z-index:\s*30/.test(css))
    err('★ .pick-bar 没有 z-index —— 吸顶后会被下面的歌曲行盖住');
  else ok('★ .pick-bar 有 z-index（压得住歌曲行）');
  // ★ v2.10.1：退出按钮必须在**吸顶的那条**里 ——
  //   不然条子吸住了、"退出"却跟着标题滚走，滚到列表下半部分想退出还是得先滚回顶部。
  if (!/exitId: 'btnSelPickExit'/.test(appjs))
    err('★ 「退出」没放进吸顶条 —— 选到列表下半部分想退出还得滚回顶部');
  else ok('★ 「退出」在吸顶条里（滚到哪儿都能退出）');
  if (!/id === 'btnSelPickExit'\) \{ toggleSelPick\(\); return; \}/.test(appjs))
    err('★ 吸顶条的「退出」没绑事件 —— 按钮画出来了，点了没反应');
  else ok('★ 吸顶条的「退出」已绑定');
  if (!/exitId: 'btnLocalPickExit'/.test(appjs) || !/id === 'btnLocalPickExit'\) \{ toggleLocalPick\(\); return; \}/.test(appjs))
    err('★ 本地歌曲那条的「退出」没接上');
  else ok('★ 本地歌曲那条也有「退出」');
  // 反向：退出按钮必须由 opts.exitId 控制 —— 导入页没有"退出选择模式"这个概念，不该画
  if (!/const exitBtn = opts\.exitId/.test(appjs))
    err('★ 退出按钮不是可选的 —— 导入页会被塞一个没意义的「退出」');
  else ok('★ 退出按钮由 opts.exitId 控制（导入页不画）');

  // 导入页那条也得吸（同一个类）
  if (!/<div class="imp-bar pick-bar">/.test(appjs))
    err('★ 导入页那条"已选 N 个"没加 pick-bar 类 —— 它同样很长，却没吸顶');
  else ok('★ 导入页的"已选 N 个"也一起吸顶');

  /* ===== ③ 拖动多选 ===== */
  if (!/const DRAG_THRESHOLD = \d+/.test(appjs))
    err('★ 没有拖动阈值 —— 手一抖就变成拖选，单击会失灵');
  else ok('★ 有拖动阈值（超过才算是拖选）');
  if (!/function pickOps\(\)/.test(appjs))
    err('★ 没有 pickOps() —— 三种选择模式的读写没统一');
  else ok('★ pickOps() 统一了三种选择模式的读写');
  {
    const fn = bodyOf('function applyDragRange(cur) {');
    if (!/const lo = Math\.min\(d\.anchor, cur\)/.test(fn) || !/const hi = Math\.max\(d\.anchor, cur\)/.test(fn))
      err('★ 拖选没按"行区间"算 —— 往上拖会失效');
    else ok('★ 拖选按行区间算（上下两个方向都支持）');
    if (!/d\.snap\.get\(i\)/.test(fn))
      err('★ 拖选没恢复快照 —— 拖过头再拖回来，中间那些行会留下误勾');
    else ok('★ 拖选能恢复拖动前的快照（拖过头再拖回来不会留脏）');
    // ★ 反向断言：拖选里不许调用 selToggle / localToggle —— 那是"逐行切换"，手一抖就来回翻
    if (/selToggle\(|localToggle\(|impToggle\(/.test(fn))
      err('★ 拖选里调用了逐行 toggle —— 鼠标在同一行上来回动会让它反复勾上又取消');
    else ok('★ 反向断言：拖选用的是"整段置位"，不是逐行 toggle');
  }
  if (!/function updateDragAutoScroll/.test(appjs) || !/requestAnimationFrame\(dragScrollTick\)/.test(appjs))
    err('★ 拖到边缘没有自动滚动 —— "按着鼠标滑到底"就用不了');
  else ok('★ 拖到内容区边缘会自动滚动');
  if (!/if \(dragSel\.suppressClick\) \{ dragSel\.suppressClick = false; return; \}/.test(appjs))
    err('★ 拖选结束后没吃掉补发的 click —— 拖 5 行会有 1 行被翻回去');
  else ok('★ 拖选结束后吃掉补发的 click（不会把第一行翻回去）');
  // 定位滚动必须自己算 scrollTop，不许 scrollIntoView（第 16 类那条红线的延伸）
  if (!/function centerInScroll\(box, el\)/.test(appjs))
    err('★ 没有 centerInScroll() —— 定位滚动会退回 scrollIntoView（整页抖）');
  else ok('★ 有 centerInScroll()（自己算 scrollTop，不碰 scrollIntoView）');

  /* ===== ④ 列表内搜索 ===== */
  if (!/function listSearchFilter\(tracks\)/.test(appjs) || !/function collectInnerHits\(track, q\)/.test(appjs))
    err('★ 没有 listSearchFilter / collectInnerHits —— 搜索没接上');
  else ok('★ 有 listSearchFilter() + collectInnerHits()');
  if (!/if \(currentView === 'favorites'\) return listSearchFilter\(DB\.favorites\);/.test(appjs) ||
      !/return pl \? listSearchFilter\(pl\.tracks\) : \[\];/.test(appjs))
    err('★ currentTracks() 没走搜索过滤 —— 搜索时点行播放/全选会作用于全部，和"看到什么就是什么"不符');
  else ok('★ currentTracks() 在两页走搜索过滤（播放/全选/拖选自动对齐）');
  // 关键：输入时只能重画列表，不能 renderAll（否则输入框失焦）
  {
    const fn = bodyOf('function refreshListOnly() {');
    if (!/box\.innerHTML = currentListHTML\(\)/.test(fn))
      err('★ refreshListOnly 没有只替换列表那一块');
    else ok('★ refreshListOnly 只替换列表那一块');
    if (/^\s*renderAll\(\);/m.test(fn))
      err('★ refreshListOnly 里无条件调了 renderAll —— 每敲一个字输入框就失焦一次');
    else ok('★ 反向断言：refreshListOnly 没有无条件 renderAll（输入框不会失焦）');
  }
  if (!/addEventListener\('input', \(e\) => \{[\s\S]{0,200}?listSearchInput[\s\S]{0,200}?refreshListOnly\(\)/.test(appjs))
    err('★ 搜索框的 input 没接 refreshListOnly');
  else ok('★ 搜索框输入即筛（走 refreshListOnly）');
  // ★ v2.10.0 修订：搜索词要自动带进合集面板
  if (!/\$\('collectSearch'\)\.value = listSearchCarry\(\);/.test(appjs))
    err('★ 打开合集面板时没把列表搜索词带过去 —— 用户还得在面板里再打一遍');
  else ok('★ 打开合集面板时自动带上列表搜索词');
  // ★ v2.11.0：判定收口到 viewHasListSearch()（现在有三页要用），断言也跟着改
  if (!/function viewHasListSearch\(view\)/.test(appjs) ||
      !/if \(!viewHasListSearch\(currentView\)\) return '';/.test(appjs))
    err('★ listSearchCarry 没走 viewHasListSearch —— 从歌单切到发现页再点合集会带上莫名其妙的搜索词');
  else ok('★ 只有"有列表搜索的页面"才带搜索词（viewHasListSearch 收口）');
  if (/renderCollectList\(''\);/.test(appjs))
    err('★ 打开面板后还是用空串渲染 —— 搜索框填了字，列表却没过滤');
  else ok('★ 面板用搜索框里的词渲染（填了字就真的过滤）');
  // 面板的匹配规则必须和列表页一致（title + author），否则"内含 22 集"点开一集都搜不到
  {
    const fn = bodyOf('function renderCollectList(filter) {');
    if (!/searchBlob\(e\)\.includes\(q\)/.test(fn))
      err('★ 面板搜索只匹配标题 —— 列表页按作者名算出的「内含 N 集」点开会对不上');
    else ok('★ 面板搜索和列表页同一套规则（标题 + 作者）');
  }
  // 离开这两页要清空，否则会把搜索词带到别的页面
  if (!/if \(!viewHasListSearch\(currentView\)\) \{[\s\S]{0,120}?listSearch = '';/.test(appjs))
    err('★ 离开这些页没清空搜索词 —— 切到发现页再点合集会把歌单的搜索词带进去');
  else ok('★ 离开这些页自动清空搜索词');

  if (!/\.hit-chip/.test(css) || !/内含 \$\{inner\} 集/.test(appjs))
    err('★ 没有「内含 N 集」小标 —— 合集内部匹配时用户看不懂这一行为什么留下');
  else ok('★ 有「内含 N 集」小标');
  if (!/\.block-head\.has-search/.test(css))
    err('★ 没有 .block-head.has-search —— 三栏布局会连另外 11 处 block-head 一起改');
  else ok('★ 搜索用的三栏布局只作用于 .has-search（不影响其他页面）');
  // ★ 反向断言：「播放全部」不许复活
  if (/btnPlayFav|btnPlayPl/.test(appjs))
    err('★ btnPlayFav / btnPlayPl 又回来了 —— 这两页的「播放全部」已经删掉（Neo 拍板）');
  else ok('★ 反向断言：btnPlayFav / btnPlayPl 没有复活');

  /* ===== ⑤ 播放条「定位」 ===== */
  if (!/function playTracks\(tracks, startIndex = 0, name = '', source = null\)/.test(appjs))
    err('★ playTracks 没有 source 参数 —— 队列不知道"这次是从哪个列表点进来的"，定位就无从谈起');
  else ok('★ playTracks 记了来源 source');
  if (!/playTracks\(seq\.list, at, viewLabel\(\), \{ view: currentView \}\)/.test(appjs))
    err('★ startFromView 没把当前视图传给 playTracks');
  else ok('★ startFromView 传了 { view: currentView }');
  if (!/function locateCurrentTrack\(\)/.test(appjs) || !/function locateCanRestore\(view\)/.test(appjs))
    err('★ 没有 locateCurrentTrack / locateCanRestore');
  else ok('★ 有 locateCurrentTrack() + locateCanRestore()');
  // 数据没了必须退回队列抽屉（不能点了没反应）
  {
    const fn = bodyOf('function locateCurrentTrack() {');
    if (!/openQueue\(\)/.test(fn))
      err('★ 定位失败时没退回打开播放队列 —— 按钮会点了没反应');
    else ok('★ 定位失败时退回打开播放队列（按钮永远有反应）');
  }
  if (!/\$\('btnLocate'\)\.addEventListener\('click', locateCurrentTrack\)/.test(appjs))
    err('★ #btnLocate 没绑到 locateCurrentTrack');
  else ok('★ #btnLocate 已绑定');
  // mini 下必须收起（第 48 类那条哨兵的延伸，这里再钉一次）
  if (!/body\.mini\s+#btnLocate\s*\{[^}]*display:\s*none/.test(css))
    err('★ mini 下没把 #btnLocate 收起来 —— 它会插队把 ✕▢ 挤到第二行');
  else ok('★ mini 下 #btnLocate 已收起');
  if (!/symbol id="i-locate"/.test(html))
    err('★ 没有 i-locate 图标');
  else ok('★ 有 i-locate 图标');
  if (!/\.locate-flash/.test(css) || !/function flashRow\(row\)/.test(appjs))
    err('★ 定位后没有高亮反馈 —— 滚过去也看不出是哪一行');
  else ok('★ 定位后有高亮闪一下');

  /* ===== ⑥ 离线实测必须在 ===== */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round25.js'))) ok('有 .verify/test-round25.js（本轮五项改动的离线实测）');
  else err('缺少 .verify/test-round25.js —— 拖选/搜索/定位必须真的点一遍');
}

/* ---- 63) v2.11.0：解析页工具条 + 合集整体加入 ---- */
console.log('\n[63] v2.11.0 · 解析页工具条 + 合集整体加入：');
{
  const bodyOf = (sig) => {
    const i = appjs.indexOf(sig);
    if (i < 0) return '';
    const j = appjs.indexOf('\n}\n', i);
    return appjs.slice(i, j < 0 ? appjs.length : j);
  };
  const parsedFn = bodyOf('function renderParsed() {');

  /* ===== ① 头部：工具条在上、标题在下 ===== */
  if (!/class="parsed-top"/.test(appjs))
    err('★ 解析页没用 .parsed-top —— 标题和工具条还挤在 .block-head 里');
  else ok('★ 解析页头部用 .parsed-top（标题和工具条分开）');
  if (/<div class="block-head">[\s\S]{0,400}?btnParsedBack/.test(appjs))
    err('★ 解析页还在用 .block-head —— 标题一长就会把按钮压扁');
  else ok('★ 解析页不再用 .block-head');
  if (!/class="parsed-bar"/.test(appjs))
    err('★ 没有 .parsed-bar（工具条那一行）');
  else ok('★ 有 .parsed-bar（工具条独占一行）');
  // 工具条必须在标题**之前**（Neo 定的：工具条在上、标题在下）
  {
    const barAt = parsedFn.indexOf('class="parsed-bar"');
    const titleAt = parsedFn.indexOf('parsed-title');
    if (barAt < 0 || titleAt < 0 || barAt > titleAt)
      err('★ 工具条没排在标题前面 —— 应该是"工具条在上、标题在下"');
    else ok('★ 工具条在标题上面（操作区靠上，标题跟着列表走）');
  }
  if (!/\.parsed-bar\s*\{[^}]*display:\s*flex/.test(css) || !/\.parsed-title\s*\{[^}]*word-break:\s*break-word/.test(css))
    err('★ .parsed-bar / .parsed-title 的样式没写全（标题长的时候要能换行）');
  else ok('★ .parsed-bar / .parsed-title 样式齐全（标题可换行）');

  /* ===== ② 解析页接进"列表内搜索" ===== */
  if (!/function viewHasListSearch\(view\)/.test(appjs) || !/view === 'parsed'/.test(bodyOf('function viewHasListSearch(view) {')))
    err('★ viewHasListSearch() 没把 parsed 算进去 —— 解析页的搜索词会被别页清掉/带错');
  else ok('★ viewHasListSearch() 覆盖了解析页');
  if (!/if \(currentView === 'parsed' && parsedView\) return listSearchFilter\(parsedView\.tracks\);/.test(appjs))
    err('★ currentTracks() 的解析页分支没走搜索过滤 —— 搜索时点行播放会播全部');
  else ok('★ currentTracks() 的解析页分支走搜索过滤');
  if (!/if \(currentView === 'parsed'\) \{[\s\S]{0,320}?trackListHTML\(list/.test(appjs))
    err('★ currentListHTML() 没有解析页分支 —— 搜索时列表重画不出来');
  else ok('★ currentListHTML() 有解析页分支（只重画列表，输入框不失焦）');
  if (!/listSearchHTML\(\)/.test(parsedFn))
    err('★ 解析页头部没放搜索框');
  else ok('★ 解析页头部有搜索框');

  /* ===== ③ 批量选择：解析页不给「移出」 ===== */
  {
    const fn = bodyOf('function selActions() {');
    if (!/currentView !== 'parsed'/.test(fn))
      err('★ 解析页也会生成「移出歌单」按钮 —— 解析页不是用户的库，点了只会问"从哪移出"');
    else ok('★ 解析页不生成「移出」按钮');
  }
  if (!/id === 'btnSelectParsed'\) \{ toggleSelPick\(\); return; \}/.test(appjs))
    err('★ 解析页的「批量选择」按钮没绑上');
  else ok('★ 解析页的「批量选择」已绑定');
  // ★★ 分P 视频的每一段共用同一个 bvid —— selKey 只按 bvid 算的话会全撞成一个键
  if (!/return 'b:' \+ t\.bvid \+ '#' \+ \(t\.cid == null \? '' : t\.cid\);/.test(appjs))
    err('★ ★ selKey 没带 cid —— 分P 视频在批量选择里会全撞成一个键（勾 12 行、选择集里只剩 1 个）');
  else ok('★ ★ selKey 带上了 cid（分P 不会撞键）');

  /* ===== ④ 整体加入：入口行 ===== */
  if (!/function makeEntryTrack\(\)/.test(appjs))
    err('★ 没有 makeEntryTrack() —— 整体加入无从谈起');
  else ok('★ 有 makeEntryTrack()');
  {
    const fn = bodyOf('function makeEntryTrack() {');
    if (!/cid:\s*null/.test(fn))
      err('★ ★ 入口行带了 cid —— 会被 isCollectPart() 认成"某合集里的一集"，徽章消失、播放也不展开');
    else ok('★ ★ 入口行 cid 是 null（不然徽章和展开都会失效）');
    // seasonCount 和 parts 必须互斥（collectionSize 先看 parts）
    if (!/if \(isSeason\)[\s\S]{0,160}?else if \(isMultiP\)/.test(fn))
      err('★ seasonCount 和 parts 不是互斥填的 —— collectionSize() 先看 parts，两个都填会判成「选集」');
    else ok('★ seasonCount / parts 互斥填写（合集不会被判成选集）');
    if (!/title:\s*info\.title/.test(fn))
      err('★ 入口行标题不是视频标题（Neo 定的用视频标题）');
    else ok('★ 入口行用视频标题');
  }
  if (!/function addWholeParsed\(\)/.test(appjs))
    err('★ 没有 addWholeParsed()');
  else ok('★ 有 addWholeParsed()');
  {
    const fn = bodyOf('function addWholeParsed() {');
    if (!/addManyToPlaylist\(\[entry\]\)/.test(fn))
      err('★ 整体加入没有只加"一行"（还是把摊平的每一集都塞进去了？）');
    else ok('★ 整体加入只塞一行 entry');
    if (!/DB\.collectParts\[info\.bvid\] = src\.map/.test(fn))
      err('★ 没把曲目表写进 collectParts —— 点播放时还得联网展开');
    else ok('★ 曲目表写进了 collectParts（播放不用再联网）');
    if (/cover:\s*e\.cover/.test(fn))
      err('★ 缓存里带了 cover —— 长链接，几十集全存会把存档撑大');
    else ok('★ 缓存剥掉了封面（和 collectEntriesFor 一个口径）');
  }
  if (!/multi \? '整个合集加入' : '加入歌单'/.test(appjs))
    err('★ 按钮文案不是「整个合集加入 / 加入歌单」—— 会和批量选择里的「加入歌单」混');
  else ok('★ 按钮文案「整个合集加入」/「加入歌单」（和批量里那个区分开）');
  if (!/id === 'btnAddParsed'\) \{ addWholeParsed\(\); return; \}/.test(appjs))
    err('★ 「整个合集加入」没绑到 addWholeParsed');
  else ok('★ 「整个合集加入」已绑定');

  /* ===== ④b 加进歌单要排在**最前面**（v2.11.1） ===== */
  if (!/function addToPlaylistFront\(pl, tracks\)/.test(appjs))
    err('★ 没有 addToPlaylistFront() —— 加进歌单的曲目又会排到末尾');
  else ok('★ 有 addToPlaylistFront()');
  {
    const fn = bodyOf('function addToPlaylistFront(pl, tracks) {');
    if (!/pl\.tracks = fresh\.concat\(pl\.tracks\);/.test(fn))
      err('★ 新加的没排在最前面（应该 fresh.concat(pl.tracks)）—— 和「我喜欢」不一致');
    else ok('★ 新加的排在最前面（fresh.concat(pl.tracks)）');
    if (/unshift/.test(fn))
      err('★ 用 unshift 逐条插会**把顺序反过来**（批量加 18 集时第 1 集被挤到最后）');
    else ok('★ 没用 unshift（批量加时内部顺序不变）');
  }
  // 两个入口都必须走它：加入歌单弹窗 / 导入收藏夹并进已有歌单
  if (!/addToPlaylistFront\(pl, list\)/.test(appjs) || !/addToPlaylistFront\(pl, picked\)/.test(appjs))
    err('★ 还有入口没走 addToPlaylistFront —— 那条路加进去的还是会排在末尾');
  else ok('★ 「加入歌单」弹窗和「导入收藏夹」两处都走它');
  // 反向：不许再出现裸的 pl.tracks.push(
  if (/pl\.tracks\.push\(/.test(appjs))
    err('★ 还有地方在 pl.tracks.push( —— 那条路加进去会排到末尾');
  else ok('★ 反向断言：没有裸的 pl.tracks.push( 了');

  /* ===== ⑤ 共 N 首算进集数 ===== */
  if (!/function expandedCount\(tracks\)/.test(appjs))
    err('★ 没有 expandedCount()');
  else ok('★ 有 expandedCount()');
  if (!/const total = expandedCount\(listAllTracks\(\)\);/.test(appjs))
    err('★ listSubText() 还在数行数 —— 歌单里 1 行「合集 18」会写成「共 1 首」');
  else ok('★ 副标题用 expandedCount() 算（1 行合集 → 共 18 首）');
  if (!/共 \$\{expandedCount\(DB\.history\)\} 首/.test(appjs))
    err('★ 「最近播放」的副标题还在数行数');
  else ok('★ 「最近播放」也按展开后的数量算');

  /* ===== ⑥ 下载前确认 + 摊平 ===== */
  {
    const fn = bodyOf('async function enqueueDownloads(tracks, opts = {}) {');
    if (!/maybeCollection\(t\) && collectionSize\(t\)\.n > 1/.test(fn))
      err('★ 下载前没挑出合集行 —— 选中「合集 18」会只下第一集，而且一声不吭');
    else ok('★ 下载前挑出了合集行');
    if (!/await askConfirm\('全部下载？'/.test(fn))
      err('★ 下载前没问一句');
    else ok('★ 下载前问一句（askConfirm）');
    if (!/const seq = await buildSequence\(list\);/.test(fn))
      err('★ 确认后没摊平 —— 合集行还是只会下第一集');
    else ok('★ 确认后用 buildSequence 摊平（和点播放同一套逻辑）');
    if (/showPrompt\(/.test(fn))
      err('★ 下载确认用了 showPrompt —— 它会把等待者清空，await 永不返回（v2.9.0 踩过）');
    else ok('★ 下载确认没用 showPrompt');
  }

  /* ===== ⑦ 离线实测必须在 ===== */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round26.js'))) ok('有 .verify/test-round26.js（本轮四项的离线实测）');
  else err('缺少 .verify/test-round26.js —— 解析页 / 整体加入 / 下载确认必须真的点一遍');
}

/* ============================================================
   [64] v2.12.0 · AI 歌词
   ============================================================
   这一类的断言全部按"代码形状"写（源码已经去过注释），所以每条都对应一句
   "以后谁会把它改坏、改坏之后会怎样"。★ 标星的是这次最容易踩的。 */
console.log('\n[64] v2.12.0 · AI 歌词（整理字幕 / 没字幕时兜底生成）：');
{
  const bodyOf = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    const j = src.indexOf('\n}\n', i);
    return src.slice(i, j < 0 ? src.length : j);
  };

  /* ===== ① 模块与导出 ===== */
  if (!fs.existsSync(path.join(ROOT, 'src', 'ai-lyrics.js'))) err('★ 没有 src/ai-lyrics.js');
  else ok('★ 有 src/ai-lyrics.js（主进程模块）');
  const exportsNeeded = ['configure', 'keyInfo', 'setKey', 'listModels', 'testConnection',
    'testWebSearch', 'polishLyrics', 'generateLyrics', 'getPrompts', 'cacheStats', 'clearCache'];
  {
    const tail = ailyrics.slice(ailyrics.lastIndexOf('module.exports'));
    const missing2 = exportsNeeded.filter((n) => !new RegExp('\\b' + n + '\\b').test(tail));
    if (missing2.length) err('★ ai-lyrics.js 少导出：' + missing2.join(', '));
    else ok(`★ ai-lyrics.js 导出齐全（${exportsNeeded.length} 个）`);
  }

  /* ===== ② Key：加密存、只给掩码 ===== */
  if (!/\.encryptString\(/.test(ailyrics)) err('★ 没调 safeStorage.encryptString —— Key 是明文落盘');
  else ok('★ Key 用 safeStorage.encryptString 加密后落盘');
  if (!/\.decryptString\(/.test(ailyrics)) err('★ 没有 decryptString —— 存进去读不回来');
  else ok('★ 读的时候走 decryptString');
  if (!/isEncryptionAvailable\(\)/.test(ailyrics) || !/KEY_MAGIC_PLAIN/.test(ailyrics))
    err('★ 没有"不支持加密 → 明文 + 标记"的降级分支（拍板 #8：要明确降级，不许静默）');
  else ok('★ 有加密不可用时的降级分支（明文 + magic 标记）');
  if (!/ai-key\.bin/.test(ailyrics)) err('★ Key 文件名不是 ai-key.bin');
  else ok('Key 单独存 ai-key.bin（不进存档）');
  if (!/maskKey/.test(ailyrics) || !/•'\.repeat\(12\)/.test(ailyrics))
    err('★ 没有掩码函数（Key 会整串显示出来）');
  else ok('★ Key 只显示 12 个圆点 + 后 4 位');
  // 反向：给界面的对象里不许带明文
  {
    const fn = bodyOf(ailyrics, 'function keyInfo() {');
    if (/key:\s*k\b|text:\s*k\b|plain:\s*k\b/.test(fn))
      err('★ keyInfo() 把明文 Key 回给渲染层了（拍板 #11：界面永远不持有明文）');
    else ok('★ keyInfo() 只回 { has, mask, encrypted }，没有明文字段');
  }
  if (/aiGetKey|ai:getKey/.test(preloadCode) || /aiGetKey|ai:getKey/.test(mainCode))
    err('★ 有"取明文 Key"的通道 —— 拍板 #11 明确不要');
  else ok('★ 反向断言：没有任何"取明文 Key"的 IPC');

  /* ===== ③ 中转站兼容（六条里最要命的三条） ===== */
  if (/response_format\s*:/.test(ailyrics))
    err('★ 用了 response_format —— 中转站大多不支持，会直接 400');
  else ok('★ 反向断言：没有用 response_format（靠提示词 + 容错解析）');
  if (!/const wrapped = data && data\.error/.test(ailyrics))
    err('★ 没检查 data.error —— 中转站把错误包在 200 里，会被当成成功');
  else ok('★ 先看 data.error 再当成功（200 里包错误的坑）');
  if (!/Array\.isArray\(c\)/.test(ailyrics) || !/ch\.text/.test(ailyrics))
    err('★ content 不是字符串的两种情况没兼容（新版返回数组 / 老式 choice.text）');
  else ok('★ content 三种形状都兼容（字符串 / 数组 / choice.text）');
  if (!/TIMEOUT_MS = 60000/.test(ailyrics))
    err('★ 单块超时不是 60 秒（中转站排队，20 秒会大面积误杀）');
  else ok('★ 单块超时 60 秒、整首硬上限 5 分钟');
  if (!/stripFence|replace\(\/\^\\s\*```/.test(ailyrics))
    err('★ 没有剥 ``` 包裹 —— 模型一加 markdown 解析就废');
  else ok('★ 容错解析会剥 ```json 包裹、抓第一个 [ 到最后一个 ]');
  // ★ 真实模型的花式姿势（v2.12.0 实测反馈"解析失败"后补的）：外面包对象 / 元素是对象 / 不回 JSON
  if (!/function coerceItem\(v\)/.test(ailyrics) || !/firstArr/.test(ailyrics))
    err('★ 解析器没兼容"对象包裹 / 对象元素"—— 真实模型常回 {"lyrics":[...]} 或 {"text":"..."}，String() 会变成 [object Object]');
  else ok('★ 解析器兼容对象包裹与对象元素（真实模型的花式姿势）');
  if (!/withPreview/.test(bodyOf(ailyrics, 'async function polishChunk(o) {')) ||
      !/withPreview/.test(bodyOf(ailyrics, 'async function generateLyrics(o) {')))
    err('★ bad-format 的报错没带模型原文开头 —— 解析失败时查不出它到底回了什么形状');
  else ok('★ bad-format 报错带模型原文开头（整理 / 生成两条路都有）');

  /* ★★ v2.12.0 实测踩到的坑：推理型模型把"内心独白"写进正文，还带时间戳 */
  if (/reasoning_content/.test(bodyOf(ailyrics, 'function pickContent(data) {')))
    err('★ ★ pickContent 里出现了 reasoning_content —— 推理型模型的内心独白会被当成歌词整段渲染');
  else ok('★ ★ 反向断言：pickContent 只取正文，绝不拿 reasoning_content 顶替');
  if (!/function looksLikeThinking\(text\)/.test(ailyrics) ||
      !/looksLikeThinking\(text\)/.test(bodyOf(ailyrics, 'async function polishChunk(o) {')) ||
      !/looksLikeThinking\(text\)/.test(bodyOf(ailyrics, 'async function generateLyrics(o) {')))
    err('★ 没有"思考过程当歌词"的拦截 —— 模型会把独白写进正文，而且带 [00:00.00] 前缀，解析器分辨不出来');
  else ok('★ 思考过程当正文 → 判成 thinking（整理 / 生成两条路都拦）');
  if (!/case 'thinking':/.test(appjs)) err('★ 界面没给 thinking 单独的文案');
  else ok('★ 界面给 thinking 单独的、可操作的文案（再点一次 / 加哪句话）');

  /* ★★ 推理型模型的**正解**：让答案进标签，思考写在标签外面就无所谓 */
  {
    const pol = (ailyrics.match(/const DEFAULT_PROMPT_POLISH = `([\s\S]*?)`;/) || [])[1] || '';
    const gen = (ailyrics.match(/const DEFAULT_PROMPT_GENERATE = `([\s\S]*?)`;/) || [])[1] || '';
    if (!/<json>[\s\S]*<\/json>/.test(pol) || !/标签外面写什么都不看/.test(pol))
      err('★ ★ 整理提示词没要求把答案放进 <json> 标签 —— 推理型模型的思考会和答案混在一起，解析器分不出来');
    else ok('★ ★ 整理提示词要求答案进 <json> 标签（思考写在外面无所谓）');
    if (!/<lrc>[\s\S]*<\/lrc>/.test(gen) || !/标签外面写什么都不看/.test(gen))
      err('★ ★ 生成提示词没要求把答案放进 <lrc> 标签 —— 推理型模型的思考也带时间戳，会一起被当成歌词');
    else ok('★ ★ 生成提示词要求答案进 <lrc> 标签');
  }
  if (!/function extractTagged\(text, tag\)/.test(ailyrics))
    err('★ 没有 extractTagged() —— 标签方案等于没做');
  else ok('★ 有 extractTagged()');
  {
    const fn = bodyOf(ailyrics, 'function extractTagged(text, tag) {');
    // 取最后一个块：循环里不断覆盖 last，而不是第一次命中就 return
    if (!/while \(\(m = re\.exec\(s\)\) !== null\) last = m\[1\]/.test(fn))
      err('★ extractTagged 取的不是**最后一个**标签块（提示词示例 / 思考里的预演会被当成答案）');
    else ok('★ extractTagged 取最后一个标签块（示例和预演不会抢答）');
  }
  {
    const fn = bodyOf(ailyrics, 'function pickAnswer(r, tag) {');
    if (!/extractTagged\(r && r\.reasoning, tag\)/.test(fn))
      err('★ pickAnswer 没从 reasoning_content 里捞答案（正文空时白跑一次，等于不支持推理模型）');
    else ok('★ pickAnswer 会从 reasoning_content 里捞标签块（正文空也能救回来）');
  }
  if (!/function thinkingError\(r, tag\)/.test(ailyrics) ||
      !/thinkingError\(r, 'json'\)/.test(bodyOf(ailyrics, 'async function polishChunk(o) {')) ||
      !/thinkingError\(r, 'lrc'\)/.test(bodyOf(ailyrics, 'async function generateLyrics(o) {')))
    err('★ 两条路没有统一的 thinking 报错（文案会不一致）');
  else ok('★ 两条路都用 thinkingError（文案统一、可操作）');
  if (!/finish === 'length'/.test(bodyOf(ailyrics, 'async function generateLyrics(o) {')))
    err('★ 没处理"输出被 max_tokens 截断"—— 推理模型最常见的失败，报错却只会说"格式不对"');
  else ok('★ 输出被截断时单独提示（推理模型把额度花在思考上）');

  /* ★★ 实测第二轮反馈：正文空 + finish=length（想太久被截断）。三条对策都要在 */
  {
    const fn = bodyOf(ailyrics, 'async function generateLyrics(o) {');
    if (!/let budget = opts\.maxTokens \|\| 12000/.test(fn))
      err('★ ★ 生成的起步预算不是"用户设置优先 / 默认 12000"');
    else ok('★ ★ 生成起步预算：用户设了就用他的，否则 12000');
    if (!/budget \* 2/.test(fn) || !/attempt < 2/.test(fn))
      err('★ 截断后没有"加大预算重试一次"');
    else ok('★ 截断后自动加大预算重试一次');
  }
  if (!/_tokenTry/.test(ailyrics) || !/Math\.floor\(asked \/ 2\)/.test(ailyrics))
    err('★ 没处理"预算给太大 → 老模型 400"（而且应该对半降，不能一上来砸到 4000）');
  else ok('★ 预算给太大被 400 时对半降重试（最多 4 次，老模型也能用）');
  if (!/function salvageFromReasoning\(reasoning, duration\)/.test(ailyrics))
    err('★ 没有"从思考过程里捞歌词"的兜底（有的模型把整首 LRC 写在思考里，正文空）');
  else ok('★ 有"从思考过程里捞歌词"的兜底');
  {
    const fn = bodyOf(ailyrics, 'function salvageFromReasoning(reasoning, duration) {');
    if (!/line\.slice\(lastAt\)/.test(fn))
      err('★ 捞词没只取"最后一个时间戳之后"的文字 —— 思考里的英文前缀会被当成歌词');
    else ok('★ 捞词只取最后一个时间戳之后的文字（英文前缀不会混进歌词）');
    if (!/kept\.length < 3/.test(fn)) err('★ 捞词没有最少行数门槛（两行也能当歌词）');
    else ok('★ 捞词有门槛（≥3 行、且不能是提示词示例的复读）');
  }
  if (!/const truncated = !!\(r && r\.finish === 'length'\)/.test(ailyrics))
    err('★ thinkingError 没区分"被截断"和"只回了思考"（用户看不出该改什么）');
  else ok('★ thinkingError 区分"被截断"与"只回了思考"');

  /* ★ 歌名提取：写了必须接上（计划书 §3.0），而且本地文件名里的序号 / 编码后缀要剥掉 */
  if (ailyrics.indexOf('\\d{1,3}\\s*[.、') < 0)
    err('★ guessSongName 没去掉开头的序号（本地歌常是 "14. xxx"、"01 - xxx"）');
  else ok('★ guessSongName 去掉开头序号（14. / 01 -）');
  if (ailyrics.indexOf('AAC|FLAC|MP3') < 0)
    err('★ guessSongName 没去编码后缀（_AAC / _FLAC / _320K —— 本地歌文件名常有）');
  else ok('★ guessSongName 去掉编码后缀（_AAC / _FLAC / _320K）');
  if (!/title: guessSongName\(o\.title\)/.test(ailyrics) || !/title: guessSongName\(opts\.title\)/.test(ailyrics))
    err('★ ★ guessSongName 写了却没接进提示词 —— 整串标题丢给模型，它会把 UP 主当歌手去搜');
  else ok('★ ★ 两条路的提示词都用提取后的歌名（不只是写了个函数）');

  /* ===== ④ 整理：80 行分块 + 行数校验 ===== */
  if (!/const CHUNK = 80/.test(ailyrics)) err('★ 分块不是 80 行');
  else ok('★ 80 行一块');
  {
    const fn = bodyOf(ailyrics, 'async function polishLyrics(o) {');
    if (!/i \+= CHUNK/.test(fn)) err('★ polishLyrics 没按 CHUNK 切块');
    else ok('★ polishLyrics 按 CHUNK 切块');
    if (!/const arr = await polishChunk\(/.test(fn) || !/for \(const t of arr\) out\.push\(t\)/.test(fn))
      err('★ 块结果没有按顺序拼回');
    else ok('★ 各块结果按顺序拼回');
    // ★ 任何一块失败 → 整首失败：循环里不许 try/catch 吞掉单块错误
    if (/try\s*\{[\s\S]{0,200}?polishChunk\([\s\S]{0,200}?catch/.test(fn))
      err('★ ★ 单块失败被 catch 掉了 —— 会出现"半块成功半块失败"，时间轴全错位');
    else ok('★ ★ 单块失败不吞：整首退回原字幕');
  }
  if (!/arr\.length !== chunk\.length/.test(ailyrics))
    err('★ 没有行数校验 —— AI 合并了句子，时间轴就对不上了');
  else ok('★ 逐块校验行数（不一致就丢弃）');
  if (!/reason === 'mismatch'|fail\('mismatch'/.test(ailyrics)) err('★ 行数不一致没有单独的 reason（界面分不出"改动太大"和"格式错误"）');
  else ok("★ 行数不一致抛 reason 'mismatch'");
  // 空串必须保留：这个函数里**一个 filter 都不该有**（filter 一次 = 行数对不上）
  if (/\.filter\(/.test(bodyOf(ailyrics, 'async function polishLyrics(o) {')))
    err('★ ★ 整理结果被 filter 过了 —— "合并到上一行"留的空串会丢，行数就对不上');
  else ok('★ ★ 空串 "" 原样保留（合并句靠它占位）');
  if (!/return lines\.map\(\(l, i\) => \(\{ t: l\.t, text: out\[i\] \}\)\)/.test(ailyrics))
    err('★ 整理结果没有用回原来的时间轴');
  else ok('★ 时间轴用原字幕的 t（高亮精准）');

  /* ===== ⑤ 生成：LRC 解析 / 元数据 / 纯音乐 ===== */
  if (!/\(ti\|ar\|al\|by\|offset/.test(ailyrics))
    err('★ 没丢弃 [ti:] [ar:] [al:] 元数据行 —— 它们会被当成歌词渲染出来');
  else ok('★ [ti:] [ar:] [al:] 元数据行丢弃');
  if (!/kept\.sort\(\(x, y\) => x\.t - y\.t\)/.test(ailyrics))
    err('★ 没给时间戳排序 —— 模型偶尔会把两句写反，高亮会来回跳');
  else ok('★ 时间戳排序（单调递增）');
  if (!/r\.t <= lim \+ 1/.test(ailyrics)) err('★ 没裁掉越界时间戳');
  else ok('★ 超出时长的行被裁掉');
  if (!/isInstrumentalMark\(rows\[0\]\.text\)/.test(ailyrics))
    err('★ 没识别「（纯音乐）」—— 会显示一行"（纯音乐）"而不是走空状态');
  else ok('★ 「[00:00.00]（纯音乐）」识别成 instrumental');

  /* ===== ⑥ 提示词 ===== */
  if (!/const DEFAULT_PROMPT_POLISH = `/.test(ailyrics) || !/const DEFAULT_PROMPT_GENERATE = `/.test(ailyrics))
    err('★ 默认提示词不在主进程（界面自己存一份迟早对不上）');
  else ok('★ 两条默认提示词都在主进程');
  {
    const pol = (ailyrics.match(/const DEFAULT_PROMPT_POLISH = `([\s\S]*?)`;/) || [])[1] || '';
    if (!/示例/.test(pol) || !/\["嗯嗯"/.test(pol)) err('★ 整理提示词没有 few-shot 示例（模型会过度润色）');
    else ok('★ 整理提示词带 few-shot 示例');
    if (!/不要输出 markdown/.test(pol)) err('★ 提示词没禁 markdown 代码块');
    else ok('★ 提示词禁 markdown 代码块');
    if (!/不要翻译/.test(pol)) err('★ 提示词没禁翻译（有的模型会把英文歌词翻成中文）');
    else ok('★ 提示词禁翻译');
    if (!/不要润色/.test(pol)) err('★ 提示词没禁"润色/创作"（那就不是原歌词了）');
    else ok('★ 提示词禁润色 / 创作');
    if (!/\{lines\}/.test(pol) || !/\{n\}/.test(pol)) err('★ 整理提示词缺 {lines} / {n} 占位符');
    else ok('★ 整理提示词有 {n} / {lines} 占位符');
    // 反向：不许把 UP 主写进提示词（拍板 #9）
    if (/UP\s*主：|up主：|author\}|UP 主名：/.test(pol)) err('★ ★ 提示词里写了 UP 主 —— 会误导模型去搜别人的歌（拍板 #9）');
    else ok('★ ★ 反向断言：提示词里没有 UP 主');
    const gen = (ailyrics.match(/const DEFAULT_PROMPT_GENERATE = `([\s\S]*?)`;/) || [])[1] || '';
    if (!/宁可少写也不要编造/.test(gen)) err('★ ★ 生成提示词没有"允许说不知道"的出口 —— 逼它硬写只会编');
    else ok('★ ★ 生成提示词给了"宁可少写也不要编造"的出口');
    if (!/\{duration\}/.test(gen)) err('★ 生成提示词缺 {duration}');
    else ok('★ 生成提示词有 {duration}');
    if (!/前奏一般占开头/.test(gen)) err('★ 没给时间戳分配原则（50 句会全挤在开头 30 秒）');
    else ok('★ 给了时间戳分配原则（前奏 5~10%、一句 3~6 秒）');
  }
  if (!/text: p \|\| DEFAULT_PROMPT_POLISH/.test(ailyrics))
    err('★ 自定义提示词没有"空串=用默认"的回退');
  else ok('★ 空串 = 用默认（代码升级默认提示词时用户也能拿到）');
  if (!/function validatePrompt\(kind, text\)/.test(ailyrics) || !/\{duration\}'/.test(ailyrics))
    err('★ 没有提示词占位符校验');
  else ok('★ 校验占位符（整理要 {lines}、生成要 {duration}）');
  // 界面侧：缺占位符不许保存 + 恢复默认是清字段
  if (!/function checkAiPrompt\(kind, text\)/.test(appjs)) err('★ 界面没做占位符校验，用户能存一个没 {lines} 的提示词');
  else ok('★ 界面也拦一道（缺占位符不许保存）');
  if (!/const val = \(text === dft\) \? '' : text;/.test(appjs))
    err('★ 「恢复默认」存了一份默认副本 —— 以后代码升级默认提示词就跟着不动了');
  else ok('★ 「恢复默认」= 把字段清空，不是存副本');

  /* ===== ⑦ 缓存 ===== */
  if (!/const CACHE_MAX = 800/.test(ailyrics)) err('★ 缓存上限不是 800');
  else ok('★ 缓存上限 800 条');
  if (!/keys\.sort\(\(a, b\) => \(Number\(c\[a\] && c\[a\]\.at\) \|\| 0\) - \(Number\(c\[b\] && c\[b\]\.at\) \|\| 0\)\)/.test(ailyrics))
    err('★ 超上限时没按 at 淘汰最旧的');
  else ok('★ 超上限按 at 淘汰最旧的');
  if (!/mode\) \{|cacheKeyOf\(bvid, cid, mode\)/.test(ailyrics) || !/\|' \+ mode/.test(ailyrics))
    err('★ 缓存 key 没带 mode（整理和生成会互相覆盖）');
  else ok('★ 缓存 key 带 mode（整理 / 生成分开存）');
  if (!/kk\.indexOf\(k \+ '\|'\) === 0/.test(ailyrics))
    err('★ 清缓存不支持"按这首歌"清（整理 + 生成要各清一次）');
  else ok('★ 清缓存支持给 `BV#cid` 一次清掉这首的两份');

  /* ===== ⑧ 七种失败 reason ===== */
  {
    const need = ['no-config', 'bad-key', 'quota', 'no-model', 'timeout', 'refused', 'bad-format'];
    const miss = need.filter((r) => ailyrics.indexOf("'" + r + "'") < 0);
    if (miss.length) err('★ 少了失败 reason：' + miss.join(', '));
    else ok('★ 七种失败 reason 齐全（界面据此显示不同文案）');
    const missUi = need.filter((r) => appjs.indexOf("case '" + r + "'") < 0);
    if (missUi.length) err('★ 界面的 aiFailText 没覆盖：' + missUi.join(', '));
    else ok('★ 界面 aiFailText 七种都有人话');
  }
  if (!/401/.test(ailyrics) || !/402 \|\| c === 429/.test(ailyrics))
    err('★ 状态码到 reason 的映射不全（401/403 → bad-key、402/429 → quota）');
  else ok('★ 状态码映射（401/403 / 402/429 / 404）');

  /* ===== ⑨ 联网探测四态 ===== */
  if (!/hasSearchEvidence\(r\.data\)/.test(ailyrics)) err('★ 没有"citations/annotations 算硬证据"的判据');
  else ok('★ 硬证据优先（citations / annotations）');
  if (!/urls\.length >= 2/.test(ailyrics)) err('★ 没按"≥2 个网址"判 maybe');
  else ok('★ ≥2 个网址判 maybe（不敢算"支持"）');
  if (/今天几号|今天日期/.test(ailyrics)) err('★ 用了"问今天几号"来探测 —— 模型能从训练数据蒙对，会误判');
  else ok('★ 反向断言：没用"问今天几号"这种能蒙对的题');
  if (!/resetAiWebState/.test(appjs) || !/aiCfg\(\)\.webSearch = 'unknown'/.test(appjs))
    err('★ 换模型时没把联网结论重置成 unknown（旧结论就作废不了）');
  else ok('★ 换模型 / 换 BaseURL → 联网结论重置成 unknown');

  /* ===== ⑩ 接进 loadLyrics：两条路 + 小标 + 切歌丢弃 ===== */
  {
    const fn = bodyOf(appjs, 'async function loadLyrics(byUser, fresh) {');
    if (!fn) err('★ loadLyrics 签名没带 fresh（「重新获取」没法清缓存）');
    else ok('★ loadLyrics(byUser, fresh) 有 fresh 参数');
    const subAt = fn.indexOf("api('subtitle'");
    const polishAt = fn.indexOf("aiRequest('polish'");
    if (subAt < 0 || polishAt < 0 || subAt > polishAt)
      err('★ ★ 「AI 优先」时没有先取字幕 —— 时间轴只能从真字幕里来');
    else ok('★ ★ 先取字幕再交给 AI 整理（时间轴用真的）');
    // v2.12.0：总开关 + 两个子开关（整理 / 生成），各管一条路
    if (!/const aiOn = !!ai\.enabled/.test(fn)) err('★ loadLyrics 没读总开关');
    else ok('★ loadLyrics 读总开关（aiOn）');
    if (!/if \(aiOn && ai\.aiPolish\) \{/.test(fn))
      err('★ 有字幕时没同时看「总开关 + AI 整理」');
    else ok('★ 有字幕时看「总开关 + AI 整理」');
    if (!/if \(aiOn && ai\.aiGenerate\) \{/.test(fn))
      err('★ 没字幕时没同时看「总开关 + AI 生成」');
    else ok('★ 没字幕时看「总开关 + AI 生成」');
    if (!/if \(lyricState\.trackKey !== key\) return;/.test(fn))
      err('★ ★ 结果回来时没检查"还是不是这首歌" —— 上一首的歌词会闪到当前这首上');
    else ok('★ ★ 结果回来先比对 trackKey，切歌就丢弃');
    if (!/aiClearCache/.test(fn)) err('★ 「重新获取」没清缓存（点了等于没点）');
    else ok('★ 「重新获取」先清这一首的缓存');
  }
  if (!/const aiInFlight = new Map\(\)/.test(appjs))
    err('★ 没有 in-flight 去重（快速切走又切回会并发两个请求，白花钱）');
  else ok('★ in-flight 去重（同一首歌不重复发）');
  if (!/loadLyrics\(true, true\)/.test(appjs))
    err('★ 空状态那颗「重新获取」没传 fresh');
  else ok('★ 「重新获取」按钮传 fresh=true');
  if (!/AI 生成 · 时间轴为估算/.test(appjs))
    err('★ ★ 兜底模式没有「AI 生成 · 时间轴为估算」小标（用户会拿估算的时间轴当准的）');
  else ok('★ ★ 兜底模式挂「AI 生成 · 时间轴为估算」');
  if (!/lyricState\.mode === 'gen'/.test(appjs) || !/tag\.classList\.toggle\('est'/.test(appjs))
    err('★ 小标没有"估算"那一档样式');
  else ok('★ 估算小标单独一档（比整理版显眼）');
  if (!/lyricState\.showRaw = false;/.test(appjs))
    err('★ 整理完成后没把 showRaw 置回 false（默认该显示整理版，拍板 #14）');
  else ok('★ 整理版默认显示，原文靠切换（拍板 #14）');
  if (!/function toggleLyricRaw\(\)/.test(appjs) || !/lyricState\.rawLines\.length > 0/.test(appjs))
    err('★ 没有「看原文 / 看整理」切换');
  else ok('★ 有「看原文 / 看整理」切换');
  if (!/failNote/.test(appjs) || !/le-ai/.test(appjs))
    err('★ 失败原因没写进空状态（拍板 #4：把原因显示出来）');
  else ok('★ 失败原因写进歌词空状态（不弹窗、不阻断）');

  /* ===== ⑪ IPC / preload / 进度推送 ===== */
  {
    const need = ['aiKeyInfo', 'aiSetKey', 'aiModels', 'aiTest', 'aiTestWebSearch',
      'aiGetPrompts', 'aiPolish', 'aiGenerate', 'aiCacheStats', 'aiClearCache'];
    const miss = need.filter((n) => !new RegExp('\\b' + n + ':').test(preloadCode));
    if (miss.length) err('preload 少暴露：' + miss.join(', '));
    else ok(`preload 暴露了 ${need.length} 个 AI 方法`);
  }
  if (!/onAiProgress: \(cb\) => ipcRenderer\.on\('ai:progress'/.test(preloadCode))
    err('★ 没有 onAiProgress 订阅（分块进度推不到界面）');
  else ok('★ onAiProgress 订阅 ai:progress');
  if (!/webContents\.send\('ai:progress'/.test(mainCode))
    err('★ 主进程没有主动推 ai:progress（invoke 中途推不出去）');
  else ok('★ 主进程分块循环里推 ai:progress');
  if (!/opts\.onProgress = \(done, total\) => pushAiProgress/.test(mainCode))
    err('★ polish 没接上进度回调');
  else ok('★ polish 接上了进度回调');
  if (/handle\('ai:[a-zA-Z]+',[^)]*key/.test(mainCode) && /aiOpts/.test(mainCode) === false)
    err('★ IPC 直接收了界面传来的 Key');
  else ok('★ 反向断言：Key 由主进程自己取（aiOpts），不收界面传来的');
  if (!/aiLyrics\.configure\(\{/.test(mainCode)) err('★ main.js 没给 ai-lyrics 注入目录/存档读取');
  else ok('★ main.js 注入了存储目录 + 读存档回调');

  /* ===== ⑫ 设置项与存档 ===== */
  if (!/function sanitizeAiLyrics\(raw\)/.test(appjs)) err('★ 没有 sanitizeAiLyrics（老存档会读到 undefined）');
  else ok('★ 有 sanitizeAiLyrics 补洞');
  if (!/aiLyrics: sanitizeAiLyrics\(old\.aiLyrics\)/.test(appjs))
    err('★ migrateSettings 没补 aiLyrics —— 每次启动都会丢设置');
  else ok('★ migrateSettings 补了 aiLyrics');
  if (!/aiLyrics: Object\.assign\(\{\}, DEFAULT_DOWNLOAD\)|aiLyrics: \{/.test(appjs))
    err('★ DEFAULT_SETTINGS 里没有 aiLyrics');
  else ok('★ DEFAULT_SETTINGS 里有 aiLyrics（默认全关）');
  {
    const fn = bodyOf(appjs, 'function sanitizeAiLyrics(raw) {');
    if (!/const polish = \(typeof o\.aiPolish === 'boolean'\)/.test(fn) ||
        !/const generate = \(typeof o\.aiGenerate === 'boolean'\)/.test(fn))
      err('★ 两个子开关没做"只认显式布尔"（老存档 / 手改坏的存档会被当成开，白花钱）');
    else ok('★ 两个子开关只认显式布尔（默认不花钱）');
    // 老存档只有 enabled / prefer 两个字段 → 必须换算，不能丢设置
    if (!/const legacyOn = o\.enabled === true/.test(fn) || !/legacyOn && legacyPrefer/.test(fn))
      err('★ 没做老存档 enabled/prefer → aiPolish/aiGenerate 的换算（升级后设置全丢）');
    else ok('★ 老存档的两个开关能换算成新开关（升级不丢设置）');
    if (!/AI_WEB_STATES\.includes\(o\.webSearch\)/.test(fn)) err('★ webSearch 没夹到四态');
    else ok('★ webSearch 只认四态，其余回落 unknown');
  }
  // ★ 反向断言：老的「AI 优先」开关不许复活（它已经被拆成两个子开关，
  //   留着就是一个点了没反应的死控件 —— 实测截图里就露出来过一次）
  if (/chkAiPrefer/.test(html) || /AI 优先/.test(html))
    err('★ ★ 设置页还有「AI 优先」—— 已经被拆成 AI 整理 / AI 生成，留着就是死控件');
  else ok('★ ★ 反向断言：没有残留的「AI 优先」死控件');

  if (!/id="chkAiPolish"/.test(html) || !/id="chkAiGenerate"/.test(html) || !/id="aiBox"/.test(html))
    err('★ 设置页没有「AI 整理 / AI 生成」两个开关（或配置区）');
  else ok('★ 设置页有两个独立开关（整理 / 生成）+ 配置区');
  // ★ 生成那条不可靠：开之前必须弹窗提醒（用户明确要求），取消要把开关弹回去
  {
    const fn = bodyOf(appjs, 'function bindAiSettings() {');
    if (!/askConfirm\('打开「AI 生成」？'/.test(fn))
      err('★ 打开「AI 生成」没有弹窗提醒 —— 用户不知道它会编');
    else ok('★ 打开「AI 生成」会弹窗提醒"大概率对不上"');
    if (!/e\.target\.checked = false;/.test(fn))
      err('★ 弹窗取消后没把开关弹回去（界面显示开着、实际没开）');
    else ok('★ 取消后开关弹回原位');
    if (!/askConfirm/.test(fn) || /showPrompt\(/.test(fn))
      err('★ 用了 showPrompt（它会把等待者清空，await 永不返回）');
    else ok('★ 弹窗走 askConfirm，没用 showPrompt');
  }
  if (!/id="btnAiTest"/.test(html) || !/id="btnAiWebTest"/.test(html))
    err('★ 少了「测试连接」或「测试联网」按钮');
  else ok('★ 两个测试按钮都在');
  if (!/id="aiPromptMask"/.test(html)) err('★ 没有提示词编辑面板');
  else ok('★ 有提示词编辑面板（整理 / 生成分开）');
  if (!/\.ai-box\s*\{/.test(css) || !/\.lyric-tag\.est\s*\{/.test(css))
    err('★ 样式没写全（配置区 / 估算小标）');
  else ok('★ 样式齐全（配置区 + 估算小标 + 提示词浮层）');
  // ★ 反向：提示词浮层常驻 DOM（只靠 opacity 藏），再加 backdrop-filter 就是每帧多算一次。
  //   实测这一条会把离屏实测里别的 transition 拖到 300ms 都走不完（round23 的 .ops 透明度偶发失败）。
  {
    const maskRule = (css.match(/\.ai-prompt-mask\s*\{[\s\S]*?\n\}/) || [''])[0];
    const panelRule = (css.match(/\.ai-prompt-panel\s*\{[\s\S]*?\n\}/) || [''])[0];
    const rMask = (css.match(/\.ai-reply-mask\s*\{[\s\S]*?\n\}/) || [''])[0];
    const rPanel = (css.match(/\.ai-reply-panel\s*\{[\s\S]*?\n\}/) || [''])[0];
    if (/backdrop-filter/.test(maskRule) || /backdrop-filter/.test(panelRule) ||
        /backdrop-filter/.test(rMask) || /backdrop-filter/.test(rPanel))
      err('★ ★ AI 的两个浮层用了 backdrop-filter —— 它们常驻 DOM，会把每帧成本抬高（实测拖慢别的 transition）');
    else ok('★ ★ 反向断言：两个 AI 浮层都没有 backdrop-filter（常驻浮层不叠实时模糊）');
  }

  /* ===== ⑫a2 整理那条路也要有预算阶梯（v2.12.0 实测反馈）===== */
  {
    const fn = bodyOf(ailyrics, 'async function polishChunk(o) {');
    if (!/for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(fn))
      err('★ ★ 整理没有"被截断就重试一次"—— 实测 54 行字幕把 token 全花在思考上，整首直接失败');
    else ok('★ ★ 整理被截断会重试一次');
    if (!/budget = Math\.min\(128000, budget \* 2\)/.test(fn))
      err('★ 整理重试时没加大预算');
    else ok('★ 整理重试时预算翻倍（上限 128000）');
    // ★ 实测第二轮：52 行把 8160 也花光了 —— 光加预算不够，得让模型少想
    if (!/const LEAN_PROMPT_POLISH = `你是歌词校对员。/.test(ailyrics))
      err('★ 没有"精简提示词"—— 长规则 + 示例会让推理模型越想越多');
    else ok('★ 有精简提示词（砍掉长规则和示例）');
    if (!/o\.lean \? LEAN_PROMPT_POLISH/.test(fn) || !/只改明显的错别字/.test(ailyrics))
      err('★ 重试时没换精简提示词');
    else ok('★ 重试时换精简提示词');
    if (!/chunk\.length > 24/.test(fn) || !/chunk\.slice\(0, mid\)/.test(fn))
      err('★ ★ 长块被截断时没折半 —— 52 行想不完，26 行就写得完（实测最有效的一招）');
    else ok('★ ★ 长块被截断会折半重来（行数少 → 想得少）');
    if (!/直接输出最终答案，不要输出任何思考过程/.test(fn))
      err('★ 整理重试时没加"别想了，直接给答案"');
    else ok('★ 整理重试时加了"别想了，直接给答案"');
    if (!/let budget = o\.maxTokens \|\| o\.budget \|\| Math\.min\(32000, 6000 \+ chunk\.length \* 100\)/.test(fn))
      err('★ 整理的起步预算不是"用户设置优先 / 自动按行数给"');
    else ok('★ 整理起步预算：用户设了就用他的，否则 6000 + 100/行（上限 32000）');
  }

  /* ===== ⑫b 看 AI 到底回了什么（v2.12.0 追加）===== */
  // 小标要是**按钮**：用户点它才能看到"这歌词是不是编的"的依据
  if (!/<button class="lyric-tag" id="lyricTag"/.test(html))
    err('★ 歌词页顶上那颗小标不是按钮 —— 点不开"AI 原始回复"');
  else ok('★ 小标是按钮（点开看 AI 原始回复）');
  if (!/id="aiReplyMask"/.test(html) || !/data-rtab="answer"/.test(html) ||
      !/data-rtab="think"/.test(html) || !/data-rtab="prompt"/.test(html))
    err('★ 没有「回复 / 思考过程 / 提示词」三页');
  else ok('★ 浮层有三页：回复 / 思考过程 / 发出去的提示词');
  if (!/function rememberDebug\(key, info\)/.test(ailyrics) || !/function getDebug\(key\)/.test(ailyrics))
    err('★ 主进程没有留调试快照（界面点开只能看到空白）');
  else ok('★ 主进程留调试快照（rememberDebug / getDebug）');
  if (!/debugMap\.size > 30/.test(ailyrics))
    err('★ 调试快照没有条数上限 —— 长会话会把整首歌词一直攒在内存里');
  else ok('★ 调试快照只留最近 30 条（不落盘、有上限）');
  {
    const p1 = bodyOf(ailyrics, 'async function polishCached(o) {');
    const g1 = bodyOf(ailyrics, 'async function generateCached(o) {');
    if (!/err\.debug = getDebug\(ck\)/.test(p1) || !/err\.debug = getDebug\(ck\)/.test(g1))
      err('★ ★ 失败时没把快照挂到错误上 —— 偏偏失败时最需要看模型原话');
    else ok('★ ★ 失败也带快照（整理 / 生成两条路都有）');
    if (!/debug: getDebug\(ck\)/.test(p1) || !/debug: getDebug\(ck\)/.test(g1))
      err('★ 成功时结果里没带 debug');
    else ok('★ 成功时结果里带 debug');
  }
  if (!/debug: err\.debug \|\| undefined/.test(mainCode))
    err('★ ★ handle() 没把 debug 透传出去 —— 错误对象过 IPC 时会被序列化成 {ok,error,reason}，debug 就丢了');
  else ok('★ ★ handle() 把 debug 一起透传（否则失败时界面拿不到）');
  if (!/if \(res\.debug\) e\.debug = res\.debug;/.test(appjs))
    err('★ api() 没把 debug 带到 Error 上');
  else ok('★ api() 把 debug 带到 Error 上');
  if (!/id="btnLyricAiDetail"|btnLyricAiDetail/.test(appjs) || !/openAiReplyPanel/.test(appjs))
    err('★ 失败的空状态里没有"看 AI 原始回复"的入口');
  else ok('★ 失败时空状态里也有入口（这时最需要看）');
  if (!/function aiReplyText\(tab\)/.test(appjs) || !/reasoning \|\|/.test(appjs))
    err('★ 思考过程那一页没有兜底文案（普通模型没有思考过程时会显示空白）');
  else ok('★ 没有思考过程时给的是说明，不是空白');

  /* ===== ⑫c 总开关关掉后，整理过的缓存照样用（v2.12.0 追加）===== */
  {
    const fn = bodyOf(appjs, 'async function loadLyrics(byUser, fresh) {');
    if (!/api\('aiCachePeek', aiCacheKey\(track, 'polish'\)\)/.test(fn))
      err('★ ★ 总开关关着时没去读整理缓存 —— 之前花过钱的成果白扔了');
    else ok('★ ★ 总开关关着时只读缓存（aiCachePeek），不调 API');
    if (!/lyricState\.polishFromCache = true;/.test(fn))
      err('★ 用缓存版时没做标记（标签上看不出这是缓存）');
    else ok('★ 缓存版会标记出来（小标写「AI 整理版 · 缓存」）');
    // 缓存版也要能切原文：polishedLines + rawLines 都得在
    if (!/lyricState\.polishedLines = hit\.lines;/.test(fn))
      err('★ 缓存版没存进 polishedLines —— 「看原文 / 看整理」就切不动了');
    else ok('★ 缓存版存进 polishedLines（看原文 / 看整理照样能切）');
  }
  if (!/handle\('ai:cachePeek'/.test(mainCode) || !/aiCachePeek: \(key\) => ipcRenderer\.invoke\('ai:cachePeek'/.test(preloadCode))
    err('★ 没有 ai:cachePeek 通道（渲染层读不到缓存）');
  else ok('★ ai:cachePeek 通道通了（preload → main）');
  if (!/enabled: \(typeof o\.enabled === 'boolean'\) \? o\.enabled : \(polish \|\| generate\)/.test(appjs))
    err('★ sanitizeAiLyrics 没算总开关（只存两个子开关的话，老存档/新存档会打架）');
  else ok('★ 总开关在 sanitize 里补算（缺省 = 两个子开关有一个开）');

  /* ===== ⑫c2 输出上限可调（v2.12.1 实测反馈：推理模型额度不够）===== */
  if (!/id="selAiTokens"/.test(html))
    err('★ 设置页没有「输出上限」—— 推理模型的额度用户调不了');
  else ok('★ 设置页有「输出上限」下拉');
  if (!/maxTokens: \[0, 16000, 32000, 64000, 128000\]\.includes\(Number\(o\.maxTokens\)\)/.test(appjs))
    err('★ maxTokens 没夹到固定档位（手改坏的存档会传个离谱值进去）');
  else ok('★ maxTokens 只认固定档位，其余回落"自动"');
  if (!/maxTokens: ai\.maxTokens \|\| 0/.test(appjs))
    err('★ 请求里没把用户设的上限带上（设了等于没设）');
  else ok('★ 两条请求都带上用户设的上限');

  /* ===== ⑫d mini 模式下整页歌词必须藏掉（v2.12.1 实测反馈）===== */
  if (!/body\.mini \.lyric-overlay \{ display: none/.test(css))
    err('★ ★ mini 下没把整页歌词藏掉 —— 取歌词时空状态会整个糊在 420×132 的小窗上');
  else ok('★ ★ mini 下整页歌词 display:none');
  if (!/if \(mini\.on && lyricState\.showing\) toggleLyrics\(false\)/.test(appjs))
    err('★ 进 mini 时没把歌词页收起来（退出 mini 会突然弹出来）');
  else ok('★ 进 mini 时顺手收起歌词页');

  /* ===== ⑬ 离线实测必须在 ===== */
  if (fs.existsSync(path.join(ROOT, '.verify', 'test-round27.js')))
    ok('有 .verify/test-round27.js（假 AI 服务的全流程实测）');
  else err('缺少 .verify/test-round27.js —— AI 那两条路必须用假服务真跑一遍');
  if (!/test-round27/.test(read('.verify/run-regression.sh')))
    err('★ run-regression.sh 没加 test-round27');
  else ok('★ run-regression.sh 已加 test-round27');

  /* ===== ⑭ 本地歌曲 + 模型下拉（v2.12.0 追加的两个反馈）===== */
  // 本地歌没有 bvid/cid：缓存 key 必须换 'l:' + 路径，否则全撞成一个键
  if (!/function aiCacheBase\(track\)/.test(appjs) ||
      !/if \(track\.localPath\) return 'l:' \+ track\.localPath;/.test(appjs))
    err('★ 缓存 key 没有 localPath 分支 —— 本地歌的歌词会全撞到同一个键上');
  else ok("★ 本地歌的缓存 key 用 'l:' + 路径（不和 B 站歌撞）");
  {
    const fn = bodyOf(appjs, 'async function loadLyrics(byUser, fresh) {');
    if (!/const isLocal = !!track\.localPath/.test(fn))
      err('★ loadLyrics 没认本地歌（会白跑 ensureCid → videoInfo 必败 → 提示"信息没取到"）');
    else ok('★ loadLyrics 认出本地歌（跳过 ensureCid 和字幕）');
    if (!/本地歌曲没有 B 站字幕可取/.test(fn))
      err('★ 本地歌没开 AI 时没说明原因（用户会以为功能坏了）');
    else ok('★ 本地歌没开 AI → 空状态里写明"去设置开 AI 歌词"');
    // 「重新获取」的清缓存也必须认本地歌
    if (!/aiClearCache', aiCacheBase\(track\)/.test(fn))
      err('★ 「重新获取」的清缓存没走 aiCacheBase（本地歌清不到）');
    else ok('★ 「重新获取」清缓存走 aiCacheBase（本地歌也能清）');
  }
  // 模型下拉：原生 <datalist> 行多时在 Windows 上滚不动（实测反馈），必须自己画
  if (/list="aiModelList"/.test(html))
    err('★ 还在用原生 <datalist> 选模型 —— 行多的时候滚不动');
  else ok('★ 反向断言：模型选择没用原生 datalist');
  if (!/id="aiModelPop"/.test(html) || !/\.ai-model-pop\s*\{[^}]*overflow-y:\s*auto/.test(css))
    err('★ 模型下拉没有可滚动的自绘列表');
  else ok('★ 模型下拉是自绘的滚动列表（最多 ~7 行，其余滚）');
}

if (fail === 0) console.log('\n全部静态自检通过 ✅（共 64 大类检查）');
else { console.log(`发现 ${fail} 处问题 ❌`); process.exit(1); }
