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

/* ---- 汇总 ---- */
console.log('\n========================================');
if (fail === 0) console.log('全部静态自检通过 ✅（共 13 大类检查）');
else { console.log(`发现 ${fail} 处问题 ❌`); process.exit(1); }
