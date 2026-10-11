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
const bgproto = stripBlock(read('src/bg-protocol.js'));
const gitignore = read('.gitignore');

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
else if (!/rgba\(\s*var\(\s*--glass-rgb/.test(tbRuleNow)) err('.titlebar 不是半透明玻璃底（太实、会显得暗）');
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

/* 自动歌词开关必须真的连着存档字段，而不是写死 */
if (!/autoLyric/.test(appjs) || !/autoLyric/.test(mainjs)) err('autoLyric 没贯穿 界面↔ 主进程存档 —— 开关关掉后再开软件会丢');
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
if (!/ctrl && \(e\.key === 'd' \|\| e\.key === 'D'\)/.test(appjs)) err('没有 Ctrl+D 切换整页歌词');
else ok('Ctrl+D 可开关整页歌词');
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
                'btnCloseCollect', 'btnPlayCollect', 'btnQueueCollect'];
  const miss = need.filter((id) => !htmlIds.has(id));
  if (miss.length) err(`index.html 缺少合集面板元素：${miss.join(', ')}`);
  else ok('合集面板的遮罩 / 标题 / 搜索框 / 列表 / 三个按钮都在 index.html');

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

  if (!/function queueCollection\(/.test(appjs)) err('缺少"整段加入队列"的 queueCollection');
  else ok('支持把整段合集加入播放队列');

  if (!/e\.key === 'Escape' && collectState/.test(appjs) || !/e\.target\.id === 'collectMask'/.test(appjs))
    err('合集面板没有"点空白 / Esc 收起"');
  else ok('合集面板可点空白或按 Esc 收起（与歌词浮层一致）');

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

  if (!/function refreshQueueIfOpen\(/.test(appjs) || !/refreshQueueIfOpen\(\)/.test(appjs))
    err('"加入队列"后没有同步队列面板');
  else ok('"加入队列"后，打开着的队列面板会同步刷新');

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
  const starts = [...appjs.matchAll(/startFromView\(([^,]+),/g)].map((m) => m[1].trim());
  if (starts.length < 7) err(`只有 ${starts.length} 处走 startFromView()，播放入口没统一`);
  else ok(`${starts.length} 处播放入口统一走 startFromView()`);

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

  const ids = [...appjs.matchAll(/\{\s*id:\s*'(\w+)',\s*icon:\s*'(i-[\w-]+)'/g)].map((m) => [m[1], m[2]]);
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

/* ---- 37) 视频背景（主进程）：bg:// 流式 + Range + 视频类型 + CSP ---- */
console.log('\n[37] 视频背景 · 主进程通道：');
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

/* ---- 38) 视频背景（渲染层）：video 元素 + 显示分支 + 存档兜底 + 设置交互 ---- */
console.log('\n[38] 视频背景 · 渲染层：');
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

if (fail === 0) console.log('\n全部静态自检通过 ✅（共 38 大类检查）');
else { console.log(`发现 ${fail} 处问题 ❌`); process.exit(1); }
