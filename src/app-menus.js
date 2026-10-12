/**
 * ============================================================
 *  app-menus.js —— 托盘菜单 / 任务栏菜单的"模板"，以及"关窗该干什么"
 * ============================================================
 *  为什么单独一个文件（而不是直接写在 main.js 里）：
 *
 *    菜单长什么样、点 ✕ 该退出还是缩小，这些**都是纯计算** ——
 *    给它一份"当前状态"，它给回一份"菜单长什么样"。
 *    把它们抽出来，离线实测就能直接 require 这个文件、把菜单模板 dump 成
 *    一串普通对象逐项比对（见 .verify/test-round11.js），
 *    不用真的去创建一个系统托盘（离屏 Electron 里根本没有托盘）。
 *
 *    理由和 v2.1.0 抽 win-mini.js、v2.0.0 抽 bg-protocol.js 一样：
 *    **main.js 没法被测试 require**（一 require 就把整个应用启动一遍）。
 *
 *  这个文件里**不许出现 require('electron')** —— 一旦出现，测试就没法加载它了。
 *  所有"需要 Electron 才能做的事"（真的建托盘、真的读图标）都留在 main.js，
 *  通过下面几个 h.xxx 回调传进来。
 * ============================================================
 */

/* ---------- 关窗行为（v2.2.0） ---------- */

// 三种取值：
//   'ask'  —— 每次点 ✕ 都弹窗问（缺省）
//   'quit' —— 直接彻底退出
//   'tray' —— 只把窗口藏起来，后台继续放歌
const CLOSE_ACTIONS = ['ask', 'quit', 'tray'];
const DEFAULT_CLOSE_ACTION = 'ask';

/** 把存档里读到的值洗成三种之一（存档被手改坏了也不会让关窗失灵） */
function normalizeCloseAction(v) {
  return CLOSE_ACTIONS.includes(v) ? v : DEFAULT_CLOSE_ACTION;
}

/**
 * 点 ✕ 的那一刻，到底该做什么。
 * @param {{quitting?:boolean, action?:string}} opts
 *        quitting —— 是不是"正在退出"（托盘菜单的退出 / Ctrl+Q / 系统关机都算）
 * @returns {'quit'|'tray'|'ask'}
 *
 * ★ 顺序很重要：**"正在退出"优先级最高**。
 *   否则会出现"点了托盘里的退出，却被当成缩小到托盘"——用户会以为软件坏了。
 */
function decideCloseAction(opts) {
  const o = opts || {};
  if (o.quitting) return 'quit';
  return normalizeCloseAction(o.action);
}

/* ---------- 播放模式（必须和 app.js 的 PLAY_MODES 一模一样） ---------- */
// 这里只留 id 和名字：主进程不需要图标（图标是界面那边的事）。
// ★ 两份清单对不上时，verify.js 会报错（见第 49 类）。
const PLAY_MODES = [
  { id: 'list',    name: '列表循环' },
  { id: 'one',     name: '单曲循环' },
  { id: 'shuffle', name: '随机播放' },
  { id: 'order',   name: '顺序播放' },
];

/* ---------- 界面状态（界面推给主进程，主进程只拿它画菜单） ---------- */

const DEFAULT_UI_STATE = {
  playing: false,      // 现在在不在播
  hasTrack: false,     // 有没有在放的歌（没有就显示"还没有在播放"）
  title: '',           // 当前歌名
  playMode: 'list',    // 播放模式
  lyricOn: false,      // 桌面歌词窗开着没
  lyricLocked: false,  // 桌面歌词锁着没
  closeAction: DEFAULT_CLOSE_ACTION,
  coverRect: null,     // mini 下封面那块的位置尺寸（见 normalizeUiState 的说明）
};

/** 把界面推过来的状态洗一遍 —— 界面那边写错了也不至于让菜单长歪 */
function normalizeUiState(st) {
  const s = (st && typeof st === 'object') ? st : {};
  return {
    playing: !!s.playing,
    hasTrack: !!s.hasTrack,
    title: typeof s.title === 'string' ? s.title.slice(0, 120) : '',
    playMode: PLAY_MODES.some((m) => m.id === s.playMode) ? s.playMode : DEFAULT_UI_STATE.playMode,
    lyricOn: !!s.lyricOn,
    lyricLocked: !!s.lyricLocked,
    closeAction: normalizeCloseAction(s.closeAction),
    coverRect: normalizeRect(s.coverRect),
  };
}

/**
 * 封面那块的位置尺寸（只有 mini 模式下界面才会给）。
 * ★ 为什么要界面来告诉主进程：网易云那种"任务栏缩略图直接换成专辑封面"用的是 Windows 私有接口
 *   DwmSetIconicThumbnail，Electron 没暴露。能做的近似是 setThumbnailClip（把窗口截图裁一块）——
 *   而"封面在哪一块"是**界面布局**才知道的事，写死在主进程里，改一次 CSS 就错一次。
 */
function normalizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const x = Math.round(Number(r.x));
  const y = Math.round(Number(r.y));
  const width = Math.round(Number(r.width));
  const height = Math.round(Number(r.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/* ---------- 托盘菜单（对照 Neo 图5 逐项还原） ---------- */

/**
 * @param {object} state  normalizeUiState() 的结果，外加 mini（窗口是不是 mini）
 * @param {object} h      主进程塞进来的"外设"：
 *                          h.icon(name) → 图标（nativeImage 或 undefined）
 *                          h.exePath    → 程序自己的 exe 路径（JumpList 用）
 *                          h.iconPath(name) → 图标的磁盘路径（JumpList 用）
 * @returns {Array} 可以直接交给 Menu.buildFromTemplate 的模板
 *
 * ★ 原生菜单**不能像网页那样局部刷新**：歌名 / 播放状态 / 播放模式 / 窗口模式
 *   这四项里任何一项变了，都要整个重建一遍（main.js 的 refreshTrayMenu 负责）。
 */
function buildTrayMenu(state, h) {
  const s = state || {};
  const a = h || {};
  const call = (fn, ...args) => { if (typeof fn === 'function') fn(...args); };
  const ic = (name) => (typeof a.icon === 'function' ? a.icon(name) : undefined);

  return [
    // 这一项是"缩小到任务栏"之后的总出口（图5 里没有，本轮补上）
    { label: '显示主窗口', icon: ic('show'), click: () => call(a.show) },

    { type: 'separator' },

    // 当前歌名（图5 的第一项）。它是"只读"的，所以 enabled:false
    {
      label: s.hasTrack && s.title ? s.title : '还没有在播放',
      icon: ic('note'),
      enabled: false,
    },

    { type: 'separator' },

    {
      label: s.playing ? '暂停' : '播放',
      icon: ic(s.playing ? 'pause' : 'play'),
      click: () => call(a.toggle),
    },
    { label: '上一首', icon: ic('prev'), click: () => call(a.prev) },
    { label: '下一首', icon: ic('next'), click: () => call(a.next) },

    { type: 'separator' },

    // ↻ 播放模式 ▸ —— 当前那个打勾（type:'radio'）
    {
      label: '播放模式',
      icon: ic('mode'),
      submenu: PLAY_MODES.map((m) => ({
        label: m.name,
        type: 'radio',
        checked: s.playMode === m.id,
        click: () => call(a.setMode, m.id),
      })),
    },

    // ⧉ 窗口模式 ▸ —— 完整模式 / mini 模式
    {
      label: '窗口模式',
      icon: ic('win'),
      submenu: [
        { label: '完整模式', type: 'radio', checked: !s.mini, click: () => call(a.setMini, false) },
        { label: 'mini 模式', type: 'radio', checked: !!s.mini, click: () => call(a.setMini, true) },
      ],
    },

    { type: 'separator' },

    { label: s.lyricOn ? '关闭桌面歌词' : '打开桌面歌词', icon: ic('lyric'), click: () => call(a.lyricOpen) },
    {
      label: '锁定桌面歌词',
      icon: ic('lock'),
      type: 'checkbox',
      checked: !!s.lyricLocked,
      enabled: !!s.lyricOn,   // 歌词窗没开的时候"锁"没有意义，置灰
      click: () => call(a.lyricLock),
    },

    { type: 'separator' },

    { label: '设置', icon: ic('settings'), click: () => call(a.settings) },
    { label: '退出', icon: ic('quit'), click: () => call(a.quit) },
  ];
}

/* ---------- 任务栏右键的"任务"（JumpList，阉割版：不能有子菜单） ---------- */

/**
 * Windows 的 JumpList「任务」有个硬限制：**不支持子菜单**（见 docs/改造计划-v2.2.0 §4.3）。
 * 而且它每一条的实现方式是"用参数启动一个新进程" —— 所以本轮必须先有单实例锁，
 * 否则点一下就会开出第二个软件来抢存档。
 *
 * @param {object} state 同 buildTrayMenu
 * @param {object} h     h.exePath（程序自己的 exe）、h.appPath（开发期要带的工程目录）、h.iconPath(name)
 */
function buildUserTasks(state, h) {
  const s = state || {};
  const a = h || {};
  const exe = a.exePath || process.execPath;
  const ip = (name) => (typeof a.iconPath === 'function' ? a.iconPath(name) : undefined);

  // 打包后：exe 就是 Neko Music 自己，直接跟参数。
  // 开发期（electron .）：exe 是 electron.exe，**必须把工程目录一起带上**，
  //   否则点一下会打开一个空白的 Electron 窗口，而且那个进程和我们的单实例锁不是同一个应用。
  const argPrefix = a.appPath ? `"${a.appPath}" ` : '';

  const task = (title, description, cmd, icon) => ({
    program: exe,
    arguments: argPrefix + '--cmd=' + cmd,
    title,
    description,
    iconPath: ip(icon),
    iconIndex: 0,
  });

  return [
    task(s.playing ? '暂停' : '播放', '播放 / 暂停', 'toggle', 'play'),
    task('上一首', '切到上一首', 'prev', 'prev'),
    task('下一首', '切到下一首', 'next', 'next'),
    { type: 'separator' },
    task('切换到 mini 模式', '把窗口缩成一条小播放条', 'mini', 'win'),
    task('设置', '打开设置面板', 'settings', 'settings'),
  ];
}

/* ---------- 第二个实例带过来的参数 ---------- */

// 允许从命令行传进来的命令（JumpList 的任务就是靠这个生效的）
const CMD_WHITELIST = ['toggle', 'prev', 'next', 'mini', 'settings', 'show'];

/**
 * 从第二个实例的 argv 里抠出 --cmd=xxx。
 * @returns {string|null} 白名单里的命令；没写、写错、或不在白名单里都返回 null
 */
function parseSecondInstanceCmd(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (const raw of list) {
    const m = /^--cmd=([a-z:]+)$/i.exec(String(raw == null ? '' : raw));
    if (!m) continue;
    const cmd = m[1].toLowerCase();
    if (CMD_WHITELIST.includes(cmd)) return cmd;
  }
  return null;
}

/* ---------- 把菜单模板变成"可以打印出来比对"的普通对象 ---------- */

/**
 * 原生菜单模板里带的是**函数**（click 回调），没法 JSON.stringify。
 * 这个函数把它压成纯数据，测试就能逐项断言"第 9 项是不是 radio、有没有打勾"。
 * click 只记"有没有"（true/false），不记函数体。
 */
function describeMenu(tpl) {
  if (!Array.isArray(tpl)) return null;
  return tpl.map((it) => {
    const src = (it && typeof it === 'object') ? it : {};
    const out = {
      label: src.label === undefined ? null : src.label,
      type: src.type || 'normal',
      click: typeof src.click === 'function',
      icon: src.icon !== undefined && src.icon !== null,
    };
    if (src.enabled !== undefined) out.enabled = !!src.enabled;
    if (src.checked !== undefined) out.checked = !!src.checked;
    if (src.submenu) out.submenu = describeMenu(src.submenu);
    return out;
  });
}

module.exports = {
  CLOSE_ACTIONS,
  DEFAULT_CLOSE_ACTION,
  PLAY_MODES,
  CMD_WHITELIST,
  DEFAULT_UI_STATE,
  normalizeCloseAction,
  decideCloseAction,
  normalizeUiState,
  normalizeRect,
  buildTrayMenu,
  buildUserTasks,
  parseSecondInstanceCmd,
  describeMenu,
};
