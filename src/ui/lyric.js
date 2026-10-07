/**
 * ============================================================
 *  lyric.js —— 桌面歌词悬浮窗的逻辑
 * ============================================================
 *  这个窗口自己不播歌、不联网，只做三件事：
 *    ① 收主窗口推过来的歌词和进度，算出"现在该显示第几句"
 *    ② 单击歌词弹出工具条（不是悬停 —— 悬停太容易误触），移开 3 秒自动收起
 *    ③ 把工具条上的操作（切歌 / 字号 / 锁定 / 关闭）发回给主窗口执行
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
const style = { fontSize: 22, opacity: 86, lines: 2, locked: false, accent: '#f472b6' };

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

/** 应用样式：字号 / 不透明度 / 行数 / 锁定 / 主题色 */
function applyStyle(next) {
  Object.assign(style, next || {});
  style.fontSize = Math.max(12, Math.min(48, Math.round(style.fontSize || 22)));
  style.opacity = Math.max(30, Math.min(100, Math.round(style.opacity || 86)));
  style.lines = (style.lines === 1) ? 1 : 2;

  const root = document.documentElement;
  root.style.setProperty('--fs', style.fontSize + 'px');
  root.style.setProperty('--accent', style.accent || '#f472b6');
  root.style.setProperty('--bg-alpha', String(style.opacity / 100));

  const win = $('win');
  win.classList.toggle('locked', !!style.locked);
  win.classList.toggle('single', style.lines === 1);
  $('lbLock').classList.toggle('on', !!style.locked);

  lastKey = '';       // 强制重画一次（行数变了要立刻生效）
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
   拖动是自己算的：按下时记下"屏幕坐标 + 窗口位置"，移动时把新位置发给主进程。
   （没有用 Electron 的 -webkit-app-region: drag，因为拖拽区会吞掉鼠标事件，
     那样"单击弹工具条"就永远收不到点击了。）

   单击 vs 拖动的分界：位移超过 4px 算拖动，否则算单击 —— 手抖不会误弹工具条。 */
const win = $('win');
let winPos = { x: 0, y: 0 };     // 窗口左上角在屏幕上的位置（主进程会同步过来）
let downScreen = null;           // 按下时的屏幕坐标
let downPos = null;              // 按下时窗口的位置
let moved = 0;                   // 累计位移，用来区分单击 / 拖动

win.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;                   // 只响应左键
  if (e.target.closest('.lyric-bar')) return;   // 工具条上的按钮交给按钮自己处理
  if (style.locked) return;                     // 锁定时不许拖
  downScreen = { x: e.screenX, y: e.screenY };
  downPos = { x: winPos.x, y: winPos.y };
  moved = 0;
  win.classList.add('dragging');
  try { win.setPointerCapture(e.pointerId); } catch (_) { /* 指针已经没了，忽略 */ }
});

win.addEventListener('pointermove', (e) => {
  if (!downScreen) return;
  const dx = e.screenX - downScreen.x;
  const dy = e.screenY - downScreen.y;
  moved = Math.abs(dx) + Math.abs(dy);
  if (moved <= 4) return;                       // 还在抖动范围内，先不动
  winPos = { x: downPos.x + dx, y: downPos.y + dy };
  if (window.lyric && window.lyric.move) window.lyric.move(winPos.x, winPos.y);
});

win.addEventListener('pointerup', (e) => {
  if (!downScreen) return;
  downScreen = null;
  win.classList.remove('dragging');
  try { win.releasePointerCapture(e.pointerId); } catch (_) { /* 同上 */ }
  if (moved > 4) return;                        // 刚才是在拖动，不算单击
  if (e.target.closest('.lyric-bar')) return;
  if ($('bar').classList.contains('show')) hideBar(); else showBar();
});
win.addEventListener('pointercancel', () => {
  downScreen = null;
  win.classList.remove('dragging');
});
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

  // 主进程把窗口位置同步过来（拖动后、以及刚创建时都会推一次）
  if (window.lyric.onPos) {
    window.lyric.onPos((p) => { if (p && typeof p.x === 'number') winPos = { x: p.x, y: p.y }; });
  }
}

/* 首次渲染：先按默认样式画一次，等主窗口把设置推过来会再刷新 */
applyStyle(style);
reportHeight();
