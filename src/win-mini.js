/**
 * ============================================================
 *  win-mini.js —— mini 模式的窗口状态（主进程这一半的"纯计算 + 编排"）
 * ============================================================
 *  mini 模式不是"另开一个小窗口"，就是**同一个窗口**换一套布局：
 *    · 界面那一半（app.js + style.css）：加 body.mini 类、渲染列表、存档
 *    · 主进程那一半（这里）：把窗口缩成 420×132（展开态 420×520）、置顶、退出时还原
 *
 *  为什么单独一个文件：和 bg-protocol.js 一样的理由 ——
 *  离线实测（.verify/test-round10.js / test-round13.js）没法 require 整个 main.js
 *  （那会把 app 启动一遍），但可以 require 这个模块，
 *  于是测试能拿**真窗口**跑**真逻辑**，而不是在测试里照抄一份、最后测的是自己写的桩。
 * ============================================================
 */

// mini 的两档尺寸：收起 420×132 / 展开 420×520
const MINI_W = 420;
const MINI_H_COLLAPSED = 132;
const MINI_H_EXPANDED = 520;

// 完整模式的最小 / 默认尺寸（和 createWindow 里的窗口选项一致）
const FULL_MIN_W = 900;
const FULL_MIN_H = 600;
const FULL_DEF_W = 1180;
const FULL_DEF_H = 760;

/**
 * mini 置顶开关（v2.4.0）
 * ------------------------------------------------------------
 * ★ 为什么用 'screen-saver' 这一档：跟桌面歌词窗一个规矩 —— 普通置顶（'floating'）
 *   会被全屏程序盖住，而 mini 播放条存在的意义就是"一直看得见"。
 * ★ 为什么抽成独立函数：① 进 / 出 mini 两个方向都要用它；
 *   ② 抽出来之后离线实测能拿**真窗口**验 `isAlwaysOnTop()`（同本文件其它函数）。
 * @param {object} win
 * @param {boolean} on
 */
function setMiniAlwaysOnTop(win, on) {
  if (!win || win.isDestroyed()) return;
  if (typeof win.setAlwaysOnTop !== 'function') return;
  try { win.setAlwaysOnTop(!!on, 'screen-saver'); } catch (_) { /* 窗口正在关，忽略 */ }
}

/**
 * 把窗口调成 mini 的某个状态。
 * 顶边不动、水平居中缩放 —— 展开时看起来是"往下长出来"，而不是整条往右下跳。
 * 同时把最小/最大尺寸卡死在 420 宽、132~520 高，并关掉自由缩放：
 * 这套布局是按固定尺寸设计的，允许用户随便拖会拖出难看的中间态。
 */
function applyMiniBounds(win, expanded) {
  if (!win || win.isDestroyed()) return;
  const h = expanded ? MINI_H_EXPANDED : MINI_H_COLLAPSED;
  const b = win.getBounds();
  const x = Math.round(b.x + (b.width - MINI_W) / 2);

  win.setMinimumSize(MINI_W, MINI_H_COLLAPSED);
  win.setMaximumSize(MINI_W, MINI_H_EXPANDED);
  win.setBounds({ x, y: b.y, width: MINI_W, height: h });
  win.setResizable(false);

  // ★ v2.4.0：mini 是一条"悬浮小窗"，要浮在别的窗口上面（Neo 报的：以前随便一个窗口都能盖住它）
  setMiniAlwaysOnTop(win, true);
}

/**
 * 退出 mini：先把尺寸限制放开，再还原成进 mini 之前的位置和大小。
 * @param {object} win
 * @param {object|null} fullBounds 进 mini 时记下来的 {x,y,width,height}；没有就用默认尺寸
 * @param {object} workArea 屏幕可用区域 {width,height}（用来当"最大尺寸"的上限）
 */
function restoreFullBounds(win, fullBounds, workArea) {
  if (!win || win.isDestroyed()) return;
  const b = fullBounds || { width: FULL_DEF_W, height: FULL_DEF_H };
  const wa = workArea || { width: 1920, height: 1080 };

  // ★★ 顺序是踩出来的，三步都不能换（离线实测 test-round10.js 第 6 组先失败才改对）：
  //   ① setResizable(true) 必须放**最前面**。
  //      Windows 上 setResizable(false) 会把 min/max 一起钉死成"当前尺寸"
  //      （这就是"不可缩放"的实现方式）—— 不解开它，后面两句 setMinimumSize /
  //      setMaximumSize 全都会被无视，窗口就还原不回去、一直卡在 mini 那个大小上。
  //   ② 再放大上限。
  //   ③ 最后才调最小值 —— 顺序反了会出现"min > max"的瞬时冲突，这一句会被直接丢掉。
  win.setResizable(true);
  win.setMaximumSize(wa.width, wa.height);
  win.setMinimumSize(FULL_MIN_W, FULL_MIN_H);
  win.setBounds(b);

  // ★ v2.4.0：退出 mini 就别再置顶了（完整模式是普通窗口，不该赖在最上面）
  setMiniAlwaysOnTop(win, false);
}

/**
 * 处理界面发来的"进 / 出 mini"请求。**这就是生产的全部逻辑** ——
 * main.js 里的 IPC 处理体只是"取窗口、调它、把结果回推"，没有别的东西，
 * 所以离线实测能直接拿它跑真窗口（见 .verify/test-round10.js）。
 *
 * @param {object} win       主窗口
 * @param {object} state     调用方持有的状态对象 { on, expanded, fullBounds }（会被就地改写）
 * @param {object} opts      界面发来的 { on, expanded }
 * @param {object} workArea  屏幕可用区域 { width, height }
 * @returns {object} 同一个 state 对象（方便调用方直接回推）
 */
function handleMiniRequest(win, state, opts, workArea) {
  if (!win || win.isDestroyed()) return state;
  const on = !!(opts && opts.on);
  const expanded = !!(opts && opts.expanded);

  if (on) {
    if (!state.on) {
      // 进 mini 前先"退出全屏 / 最大化"，并记下完整模式的样子。
      // ★ 用 getNormalBounds()：窗口正最大化时 getBounds() 给的是全屏尺寸，
      //   拿它当"还原目标"的话，退出 mini 会得到一个全屏那么大的窗口。
      if (win.isFullScreen()) win.setFullScreen(false);
      state.fullBounds = win.getNormalBounds();
      if (win.isMaximized()) win.unmaximize();
      state.on = true;
    }
    state.expanded = expanded;
    applyMiniBounds(win, expanded);
  } else {
    if (!state.on) return state;
    state.on = false;
    state.expanded = false;
    restoreFullBounds(win, state.fullBounds, workArea);
  }
  return state;
}

module.exports = {
  MINI_W, MINI_H_COLLAPSED, MINI_H_EXPANDED,
  FULL_MIN_W, FULL_MIN_H, FULL_DEF_W, FULL_DEF_H,
  applyMiniBounds, restoreFullBounds, handleMiniRequest, setMiniAlwaysOnTop,
};
