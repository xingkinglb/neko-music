/**
 * ============================================================
 *  lyric.js —— 桌面歌词悬浮窗的逻辑
 * ============================================================
 *  这个窗口自己不播歌、不联网，只做四件事：
 *    ① 收主窗口推过来的歌词和进度，算出"现在该显示第几句"
 *    ② 单击歌词弹出工具条（不是悬停 —— 悬停太容易误触），移开 3 秒自动收起
 *    ③ 把工具条上的操作（切歌 / 字号 / 锁定 / 关闭）发回给主窗口执行
 *    ④ 拖动时说一声"开始拖 / 拖完了"，具体挪窗口由主进程跟着光标做（这样才顺滑）
 * ============================================================
 */

const $ = (id) => document.getElementById(id);

/* 当前这份歌词的状态。
   status 有三种：'ok' 有词 / 'loading' 正在取 / 'none' 这首没字幕 / 'idle' 还没放歌 */
let lines = [];
let status = 'idle';
let curTime = 0;
let playing = false;

/* 样式（由主窗口推过来） */
const style = {
  fontSize: 28,        // 歌词字号 14~72
  opacity: 92,         // 底板 / 文字的不透明度 30~100
  lines: 2,            // 1 = 单行，2 = 双行
  barScale: 130,       // 工具条与图标的大小（%）80~180
  bgStyle: 'none',     // 'none' = 只有字（默认）/ 'card' = 半透明底板
  locked: false,
  accentRgb: '255, 111, 165',   // 主题色，写成"逗号分隔的三个数"，好套 rgba(r,g,b,a)
};

/* 上一次画出来的内容，用来避免重复刷新 DOM */
let lastKey = '';

/** 按当前播放时间算出该高亮第几句（最后一句 t <= 播放位置 的那句） */
function currentIndex() {
  if (!lines.length) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= curTime) idx = i; else break;
  }
  return idx;
}

/** 把歌词画到页面上（内容没变就不动 DOM，省得每 250 毫秒重排一次） */
function paint() {
  const idx = currentIndex();
  const curEl = $('lineCur');
  const nextEl = $('lineNext');

  let cur = '';
  let next = '';
  let hint = false;

  if (status === 'ok' && lines.length) {
    cur = idx >= 0 ? (lines[idx].text || '') : '';
    next = lines[idx + 1] ? lines[idx + 1].text : '';
  } else {
    hint = true;
    cur = status === 'loading' ? '正在取歌词…'
      : status === 'none'      ? '这首没有字幕'
      : '还没有播放';
    next = '';
  }

  const key = status + '|' + idx + '|' + cur + '|' + next + '|' + style.lines;
  if (key === lastKey) return;
  lastKey = key;

  curEl.textContent = cur;
  curEl.classList.toggle('hint', hint);
  nextEl.textContent = next;
  nextEl.classList.toggle('hint', hint);

  reportHeight();
}

/** 量一下自己有多高，告诉主进程把窗口调到这么高（字号变了窗口要跟着变） */
function reportHeight() {
  const h = $('win').offsetHeight + 4;
  if (window.lyric && window.lyric.resize) window.lyric.resize(h);
}

/** 应用样式：字号 / 不透明度 / 行数 / 工具条大小 / 底板 / 锁定 / 主题色 */
function applyStyle(next) {
  Object.assign(style, next || {});
  style.fontSize = Math.max(14, Math.min(72, Math.round(style.fontSize || 28)));
  style.opacity  = Math.max(30, Math.min(100, Math.round(style.opacity || 92)));
  style.barScale = Math.max(80, Math.min(180, Math.round(style.barScale || 130)));
  style.bgStyle  = (style.bgStyle === 'card') ? 'card' : 'none';
  style.lines = (style.lines === 1) ? 1 : 2;

  const op = style.opacity / 100;
  // 文字不跟着一起降到底：不透明度拉到最小时文字仍有约七成可见，
  // 否则调低一点就整行看不见了，滑杆会变得不敢碰。
  const fg = 0.55 + 0.45 * op;

  const root = document.documentElement;
  root.style.setProperty('--fs', style.fontSize + 'px');
  root.style.setProperty('--accent-rgb', style.accentRgb || '255, 111, 165');
  root.style.setProperty('--bg-alpha', String(op));
  root.style.setProperty('--fg-alpha', fg.toFixed(3));
  root.style.setProperty('--fg2-alpha', (fg * 0.62).toFixed(3));
  root.style.setProperty('--bar-scale', String(style.barScale / 100));

  const win = $('win');
  win.classList.toggle('locked', !!style.locked);
  win.classList.toggle('single', style.lines === 1);
  win.classList.toggle('bare', style.bgStyle === 'none');   // 默认：只有字，不画底板
  $('lbLock').classList.toggle('on', !!style.locked);

  lastKey = '';       // 强制重画一次（行数 / 字号变了要立刻生效）
  paint();
}

/* ---- 工具条：单击歌词才出现，移开 3 秒自动收起 ---- */
let barTimer = null;
function showBar() {
  $('bar').classList.add('show');
  scheduleHide();
}
function hideBar() {
  clearTimeout(barTimer);
  $('bar').classList.remove('show');
}
/** 3 秒后自动收起；鼠标还在工具条上动就重新计时 */
function scheduleHide() {
  clearTimeout(barTimer);
  barTimer = setTimeout(hideBar, 3000);
}

/* ---- 拖动 + 单击 ----
   拖动是"主进程跟着光标走"：按下后一旦移动超过 4px，就喊一声"开始拖"，
   之后由主进程每 16 毫秒读一次真实光标位置直接挪窗口（见 main.js）。

   为什么不再由这里逐帧算：以前鼠标每动一下都要走一次
   "渲染进程 → 主进程 → 挪窗口"，鼠标快的时候一秒钟几十上百次，就成一卡一卡的了。
   现在整段拖动只有"开始 / 结束"两次通信，中间一帧都不过 IPC。

   单击 vs 拖动的分界仍是 4px —— 手抖不会误弹工具条。
   判据用**窗口内的本地坐标**（clientX/clientY），不用屏幕坐标：
   判这 4px 的时候窗口还一动没动，本地坐标最准；等判定成拖动、窗口开始跟着光标跑之后，
   本地坐标就不再可靠了 —— 但那时候已经不需要它了。 */
const win = $('win');
let downAt = null;       // 按下时的窗口内坐标
let moved = 0;           // 按下后累计位移，用来区分单击 / 拖动
let dragSent = false;    // 这一次按下是否已经进入拖动状态

win.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;                   // 只响应左键
  if (e.target.closest('.lyric-bar')) return;   // 工具条上的按钮交给按钮自己处理
  if (style.locked) return;                     // 锁定时不许拖
  downAt = { x: e.clientX, y: e.clientY };
  moved = 0;
  dragSent = false;
  try { win.setPointerCapture(e.pointerId); } catch (_) { /* 指针已经没了，忽略 */ }
});

win.addEventListener('pointermove', (e) => {
  if (!downAt || dragSent) return;
  moved = Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y);
  if (moved <= 4) return;                       // 还在抖动范围内，先不算拖动
  dragSent = true;
  win.classList.add('dragging');
  if (window.lyric && window.lyric.dragStart) window.lyric.dragStart();
});

/** 收尾：告诉主进程别再跟着光标了（重复调用没有副作用） */
function endDrag() {
  if (!dragSent) return;
  dragSent = false;
  win.classList.remove('dragging');
  if (window.lyric && window.lyric.dragEnd) window.lyric.dragEnd();
}

win.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  downAt = null;
  try { win.releasePointerCapture(e.pointerId); } catch (_) { /* 同上 */ }
  if (dragSent) { endDrag(); return; }          // 刚才是在拖动，不算单击
  if (e.target.closest('.lyric-bar')) return;
  if ($('bar').classList.contains('show')) hideBar(); else showBar();
});
win.addEventListener('pointercancel', () => {
  downAt = null;
  endDrag();
});
// 拖到一半窗口失去焦点（比如误触 Alt+Tab）也要收手，不然窗口会一直黏着光标
window.addEventListener('blur', endDrag);
/* 鼠标移出窗口：开始 3 秒倒计时收起 */
document.addEventListener('mouseleave', () => {
  if ($('bar').classList.contains('show')) scheduleHide();
});
$('bar').addEventListener('mousemove', scheduleHide);

/* ---- 工具条按钮 ---- */
const send = (cmd, arg) => { if (window.lyric && window.lyric.cmd) window.lyric.cmd(cmd, arg); };
$('lbPrev').addEventListener('click', () => send('prev'));
$('lbNext').addEventListener('click', () => send('next'));
$('lbPlay').addEventListener('click', () => send('toggle'));
$('lbFontDown').addEventListener('click', () => send('font', -2));
$('lbFontUp').addEventListener('click', () => send('font', 2));
$('lbClose').addEventListener('click', () => send('close'));
$('lbLock').addEventListener('click', () => {
  style.locked = !style.locked;
  $('win').classList.toggle('locked', style.locked);
  $('lbLock').classList.toggle('on', style.locked);
  send('lock', style.locked);   // 让主窗口把它存进设置
});

/* ---- 收主窗口推过来的内容 ---- */
if (window.lyric) {
  window.lyric.onData((data) => {
    if (!data) return;
    if (Array.isArray(data.lines)) lines = data.lines;
    if (data.status) status = data.status;
    if (typeof data.time === 'number') curTime = data.time;
    playing = !!data.playing;
    // 播放图标跟着实际状态换
    const icon = $('lbPlayIcon');
    if (icon) icon.innerHTML = playing ? '<rect x="8" y="5" width="3.2" height="14" rx="1.4"/><rect x="12.8" y="5" width="3.2" height="14" rx="1.4"/>' : '<path d="M8 5l11 7-11 7z"/>';
    paint();
  });

  window.lyric.onStyle((s) => applyStyle(s));
}

/* 首次渲染：先按默认样式画一次，等主窗口把设置推过来会再刷新 */
applyStyle(style);
reportHeight();
