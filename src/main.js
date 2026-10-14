/**
 * ============================================================
 *  main.js —— Electron 主进程（整个应用的"大脑"）
 * ============================================================
 *  负责三件事：
 *   1. 创建并管理软件窗口
 *   2. 注册 bili:// 协议，偷偷给音频请求加上 Referer（破解防盗链）
 *   3. 接收界面的请求，去调 bilibili.js，再把结果送回界面
 * ============================================================
 */

const {
  app, BrowserWindow, ipcMain, protocol, net, dialog, nativeTheme, shell, screen,
  Menu, Tray, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./bilibili');

// 读存档时的"补洞"（★ 只许补、不许删 —— 见这个文件顶部的说明，
// 它原来会悄悄吃掉新加的设置项，是个真 bug）
const { migrate, DEFAULT_DATA, DEFAULT_DOWNLOAD } = require('./store-migrate');

// 固定开发版与安装版共用的本机存储目录，避免 Electron 按不同应用显示名
// 分配出两个 userData 目录，导致用户感觉设置和歌单“消失”。
const LEGACY_USER_DATA_DIR = app.getPath('userData');
const STABLE_USER_DATA_DIR = path.join(app.getPath('appData'), 'neko-music');
app.setPath('userData', STABLE_USER_DATA_DIR);

// 仅在旧位置与新位置不同、且新位置还没有对应文件时复制旧数据；不覆盖、不删除。
function migrateKnownUserFiles() {
  if (path.resolve(LEGACY_USER_DATA_DIR) === path.resolve(STABLE_USER_DATA_DIR)) return;
  try {
    fs.mkdirSync(STABLE_USER_DATA_DIR, { recursive: true });
    for (const name of ['neko-data.json', 'cookie.txt']) {
      const from = path.join(LEGACY_USER_DATA_DIR, name);
      const to = path.join(STABLE_USER_DATA_DIR, name);
      if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
    }
    const oldBg = path.join(LEGACY_USER_DATA_DIR, 'backgrounds');
    const newBg = path.join(STABLE_USER_DATA_DIR, 'backgrounds');
    if (!fs.existsSync(newBg) && fs.existsSync(oldBg)) fs.cpSync(oldBg, newBg, { recursive: true, errorOnExist: true });
  } catch (err) {
    console.error('[store] legacy userData migration failed:', err.message);
  }
}
migrateKnownUserFiles();

// app.getPath('userData') 是系统给我们分配的专用文件夹，
// 现在固定为 %APPDATA%\\neko-music
const DATA_FILE = path.join(app.getPath('userData'), 'neko-data.json');
// 用户自己填的 B 站登录 Cookie（可选，填了搜索会更稳）
const COOKIE_FILE = path.join(app.getPath('userData'), 'cookie.txt');

// ---- 自定义背景 ----
// 用户选的图片/视频会被"复制"到这个专属目录里，而不是直接引用原文件。
// 这样你把原文件删了、移动了，背景也不会变成裂图。
// bg:// 协议的实现（含流式 + Range）抽在 bg-protocol.js 里，方便离线实测直接加载。
const BG_DIR = path.join(app.getPath('userData'), 'backgrounds');
const { BG_MIME, BG_VIDEO_MAX_MB, registerBgProtocol, clearBgDir } = require('./bg-protocol');

// ---- 本地歌曲 / 下载（v2.8.0）----
// 下载下来的封面存这里，**不往用户的音乐文件夹里塞子目录** ——
// 用户打开自己的音乐目录时，应该只看到歌，不该多出一个不知道是什么的 covers/。
const COVERS_DIR = path.join(app.getPath('userData'), 'covers');
// 下载任务的状态单独存一个文件。为什么不塞进 neko-data.json：那个文件已经 6MB 了，
// 而下载进度每 300ms 就变一次 —— 放进去等于每次进度更新都重写 6MB 的 JSON。
const DOWNLOADS_FILE = path.join(app.getPath('userData'), 'downloads.json');
// local:// 协议的实现（含白名单精确匹配）抽在 local-protocol.js 里，方便离线实测。
const { registerLocalProtocol } = require('./local-protocol');
const { createDownloader } = require('./downloader');

let mainWindow = null;
let closeInProgress = false;
let allowCloseOnce = false;
let closeTimeout = null;

// ============================================================
//  mini 模式（v2.1.0）—— 主进程这一半
// ============================================================
//  不是"新开一个小窗口"：就是**同一个窗口**，界面那边给 body 加一个 mini 类换布局，
//  这边负责把窗口本身缩成"一条小窗"。两边各管一半，谁也不越界：
//    · 界面（app.js + style.css）：布局、按钮、存档
//    · 主进程（这里）：窗口的位置和大小
//
//  ★ 真正的"尺寸怎么算"抽在 win-mini.js 里 —— 抽出去是为了让离线实测能拿真窗口
//    跑真逻辑（理由同 bg-protocol.js）。这里只留"什么时候调它"。
const {
  MINI_W, MINI_H_COLLAPSED, MINI_H_EXPANDED,
  FULL_MIN_W, FULL_MIN_H, FULL_DEF_W, FULL_DEF_H,
  applyMiniBounds, restoreFullBounds, handleMiniRequest, setMiniAlwaysOnTop,
} = require('./win-mini');

// 进 mini 之前的窗口位置和大小（退出时原样还回去）+ 当前 mini 的两态
let miniState = { on: false, expanded: false, fullBounds: null };

// ============================================================
//  第 0.5 部分：托盘 / 任务栏菜单 / 关窗行为（v2.2.0）
// ============================================================
//  "菜单长什么样""点 ✕ 该退出还是缩小"这些都是**纯计算**，抽在 app-menus.js 里，
//  好处是离线实测能直接 require 它、把菜单模板 dump 成普通对象逐项比对
//  （离屏 Electron 里根本没有系统托盘，测不了真的托盘）。
//  这里只留"什么时候调它"和"真的去动系统"。
const {
  DEFAULT_UI_STATE, normalizeUiState, normalizeCloseAction, decideCloseAction,
  buildTrayMenu, buildUserTasks, parseSecondInstanceCmd,
} = require('./app-menus');

// 界面推过来的"现在在放什么、桌面歌词开没开、关窗想怎么关"。
// 主进程拿它画托盘菜单和任务栏按钮 —— 界面是这些状态的唯一来源。
// closeAction 先按存档文件兜个底：万一界面还没跑起来用户就点了 ✕，也不至于弹错窗。
let uiState = Object.assign({}, DEFAULT_UI_STATE, { closeAction: readCloseActionFromStore() });

let tray = null;

/* ---------- 单实例锁 ----------
   为什么必须有（两条都是真问题）：
     ① 任务栏右键的「任务」（JumpList）每一项的实现方式是**用参数启动一个新进程** ——
        没有这把锁，点一下就会开出第二个软件，两个窗口抢同一个存档文件。
     ② 就算没有 JumpList，用户连点两次桌面图标，现在也能开出两个软件来。
   第二个进程：直接退出，并把命令转交给已经在跑的那个窗口。 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // 先把窗口叫出来再执行命令 —— 用户点了图标却什么都没发生，是最气人的
    showMainWindow();
    handleExternalCmd(parseSecondInstanceCmd(argv) || 'show');
  });
}

/* ---------- "正在退出"标记 ----------
   ★ 托盘菜单的「退出」、Ctrl+Q、系统关机、任务管理器结束、任何 app.quit()，
     全都会先经过 before-quit。设了这个标记，close 处理就会**跳过询问、跳过隐藏**，
     直接走存盘流程真退出 —— 否则会出现"点了退出却被当成缩小到托盘"。
     （做法参考同类项目 biu，见 docs/参考实现研究-biu.md §2.1） */
app.on('before-quit', () => { app.quitting = true; });

/* ---------- 主进程崩溃时主动退出 ----------
   加了托盘之后这一条变得重要：主进程一旦崩了但没退出，托盘图标会一直留着、
   点它也没反应，用户会以为"软件卡死了"。主动退出比留个僵尸图标好。 */
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  app.quitting = true;
  app.quit();
});

// ============================================================
//  第 1 部分：bili:// 协议 —— 音频流的"偷渡通道"
// ============================================================
//  问题：B 站的音频地址必须带 Referer: https://www.bilibili.com 才能下载，
//        但网页里的 <audio> 标签没法自定义请求头。
//  解法：自己发明一个 bili:// 协议。网页写 <audio src="bili://get?url=...">，
//        Electron 收到后由我们代为请求，并把 Referer 加上去，
//        再把音频数据原样流回去。界面完全感觉不到中间这层。

// 必须在 app 就绪前声明：这个协议是我们自己的，让它有正常网页的权限
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bili',
    privileges: {
      bypassCSP: true,      // 允许被内容安全策略之外的地方加载
      supportFetchAPI: true, // 允许用 fetch 访问它
      stream: true,          // 支持流式传输（音频边下边播的关键）
      secure: true,
      corsEnabled: true,
    },
  },
  {
    // bg:// —— 读取本地背景图片的专用通道
    // 为什么不用 file:// ？因为页面的安全策略（CSP）里没有放行 file:，
    // 与其把 CSP 开个大口子，不如造一个只能访问 backgrounds/ 这一个目录的协议。
    scheme: 'bg',
    privileges: {
      standard: true,        // 按标准 URL 规则解析（bg://local/xxx.png）
      supportFetchAPI: true,
      stream: true,          // 让 <video> 能边下边播（动态背景靠它 + Range 请求）
      secure: true,
      corsEnabled: true,
    },
  },
  {
    // local:// —— 本地歌曲与封面的专用通道（v2.8.0）
    // 同样是因为页面没放行 file:。它的安全边界比 bg:// 更要紧 ——
    // bg:// 只管一个固定目录，local:// 要按"白名单里的任意路径"发文件。
    // 全部校验都在 local-protocol.js 里（先 resolve 再精确匹配，绝不做前缀匹配）。
    scheme: 'local',
    privileges: {
      supportFetchAPI: true,
      stream: true,          // <audio> 要边读边播，拖动进度条还要发 Range
      secure: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

function registerBiliProtocol() {
  protocol.handle('bili', async (request) => {
    try {
      // 从 bili://get?url=xxx 里取出真正的音频地址
      const u = new URL(request.url);
      const realUrl = u.searchParams.get('url');
      if (!realUrl) return new Response('缺少 url 参数', { status: 400 });

      // 原样保留界面发来的请求头（尤其是 Range，拖动进度条时靠它）
      const headers = {};
      request.headers.forEach((value, key) => {
        // 这两个头跟目标服务器不匹配，必须去掉
        if (key.toLowerCase() === 'host' || key.toLowerCase() === 'origin') return;
        headers[key] = value;
      });
      // ★ 关键一步：加上 B 站要求的身份标识
      headers['Referer'] = bili.REFERER;
      headers['User-Agent'] = bili.USER_AGENT;

      // 由 Electron 的网络模块代发请求，返回的是一个流式响应
      return await net.fetch(realUrl, {
        method: request.method || 'GET',
        headers,
        redirect: 'follow',
      });
    } catch (err) {
      console.error('[bili协议] 代理音频失败：', err);
      return new Response(String(err), { status: 500 });
    }
  });
}

// ============================================================
//  第 1.5 部分：bg:// 协议 —— 见 bg-protocol.js
// ============================================================
//  （实现已抽到 bg-protocol.js：只读 backgrounds/ 目录 + 流式 + 支持 Range。
//    抽出去是为了让离线实测能直接加载它、真发一个 Range 请求验证"视频边读边传"。）

// ============================================================
//  第 1.6 部分：本地歌曲库 + 下载引擎（v2.8.0）
// ============================================================
//  两件事在这里汇合：
//    ① 一份"本地歌曲库里都有哪些文件"的内存快照 —— local:// 协议拿它当**唯一**的
//       放行白名单，下载器拿它判断"这首歌是不是已经下过了"。
//       快照在界面 load / save 存档时刷新（界面才是 neko-data.json 的 owner）。
//    ② 一个下载器实例 —— 任务状态由它自己存进 downloads.json。
//
//  ★ 为什么任务状态不塞进 neko-data.json：
//    那个文件已经 6MB（历史 + 合集缓存），而下载进度每 300ms 变一次。
//    放进去等于每次进度更新都重写 6MB 的 JSON，硬盘和 CPU 都白烧。
//    所以：**用户数据归界面，任务状态归主进程**，各存各的文件。

let downloadSettings = Object.assign({}, DEFAULT_DOWNLOAD);
let localWhitelist = new Set();   // 已 resolve 的绝对路径 —— local:// 的唯一放行依据
let localKeys = new Set();        // `bvid:cid` —— "这首歌已经下过了"

/**
 * 界面每次 load / save 存档后调一次，把这份快照对齐。
 * 白名单只在这里被写 —— 别在别处往里面塞路径，那样等于给 local:// 开后门。
 */
function refreshLibraryCache(data) {
  const d = data || {};
  downloadSettings = Object.assign({}, DEFAULT_DOWNLOAD,
    (d.settings && d.settings.download) ? d.settings.download : {});

  const paths = new Set();
  const keys = new Set();
  for (const e of (Array.isArray(d.local) ? d.local : [])) {
    if (!e) continue;
    if (e.path) { try { paths.add(path.resolve(String(e.path))); } catch (_) {} }
    if (e.key) keys.add(String(e.key));
  }
  localWhitelist = paths;
  localKeys = keys;

  // 设置里改了并发 / 跳过重复 / 存封面 → 立刻生效，不用重启
  downloaderCfg.concurrent = downloadSettings.concurrent;
  downloaderCfg.saveCover = downloadSettings.saveCover !== false;
  downloaderCfg.skipExisting = downloadSettings.skipExisting !== false;
  if (downloader) downloader.setConcurrent(downloadSettings.concurrent);
}

function readDownloadsFile() {
  try {
    if (!fs.existsSync(DOWNLOADS_FILE)) return [];
    const j = JSON.parse(fs.readFileSync(DOWNLOADS_FILE, 'utf8'));
    if (Array.isArray(j)) return j;
    return Array.isArray(j && j.tasks) ? j.tasks : [];
  } catch (err) {
    console.error('[下载] 读取 downloads.json 失败，按空处理：', err.message);
    return [];
  }
}

// 任务状态变化很频繁（排队 / 开始 / 暂停 / 完成…），但没必要每变一次就写盘。
// 攒 1.5 秒写一次；退出时会强制写一次，所以不会丢。
let downloadsSaveTimer = null;
function saveDownloadsSoon() {
  if (downloadsSaveTimer) return;
  downloadsSaveTimer = setTimeout(() => { downloadsSaveTimer = null; saveDownloadsNow(); }, 1500);
  if (downloadsSaveTimer.unref) downloadsSaveTimer.unref();
}
function saveDownloadsNow() {
  try {
    fs.mkdirSync(path.dirname(DOWNLOADS_FILE), { recursive: true });
    const tmp = DOWNLOADS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(downloader.list(), null, 2), 'utf8');
    fs.renameSync(tmp, DOWNLOADS_FILE);   // 原子替换，写一半崩了也不会毁掉旧文件
  } catch (err) {
    console.error('[下载] 保存 downloads.json 失败：', err.message);
  }
}

function sendToUi(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch (_) {}
}

// 配置对象要留着引用 —— 下载器是**惰性读** cfg 里的字段的，
// 所以后面在 refreshLibraryCache 里改它就能立刻生效。
const downloaderCfg = {
  getAudioUrl: (bvid, cid) => bili.getAudioUrl(bvid, cid),
  fetchStream: (url, opts) => net.fetch(url, opts),
  getDir: () => downloadSettings.dir || null,
  coversDir: COVERS_DIR,
  referer: bili.REFERER,
  userAgent: bili.USER_AGENT,
  concurrent: DEFAULT_DOWNLOAD.concurrent,
  saveCover: true,
  skipExisting: true,
  isDownloaded: (key) => localKeys.has(key),
  onProgress: (list) => sendToUi('download:progress', list),
  onChanged: (tasks) => { saveDownloadsSoon(); sendToUi('download:changed', tasks); },
  onFinish: (task, info) => {
    saveDownloadsSoon();
    // 把"可以进本地歌曲库的一条"一起送过去 —— 库是界面在管，主进程不直接改存档。
    const dir = downloadSettings.dir;
    const entry = (info && info.file && dir) ? {
      path: path.join(dir, info.file),
      title: task.title || '',
      author: task.author || '',
      cover: info.coverFile || '',
      duration: info.duration || task.duration || 0,
      size: info.size || 0,
      key: task.key || '',
      bvid: task.bvid || '',
      cid: task.cid || 0,
      src: 'download',
    } : null;
    sendToUi('download:finished', { task, info, entry });
  },
};

const downloader = createDownloader(downloaderCfg);

/* ---------- 本地歌曲：扫描一个文件夹 ---------- */

// 认得的音频扩展名。跟 local-protocol.js 的 MIME 表对应 ——
// 那边管"怎么发出去"，这边管"要不要收进来"，两边都得认同一批后缀。
const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.m4s', '.mp4', '.aac', '.flac',
  '.wav', '.wave', '.ogg', '.oga', '.opus', '.wma', '.ape', '.aiff',
]);

// 一次最多收这么多首。防手滑选了个几万文件的盘，界面直接卡死。
const SCAN_MAX = 5000;
// 递归深度上限。防目录软链接成环 —— 那种情况下不限深就是无限递归。
const SCAN_DEPTH = 6;

/**
 * 递归扫一个文件夹里所有音频文件。
 * 返回 { paths, truncated } —— truncated=true 表示"撞到 5000 上限被截断了"，
 * 界面要如实告诉用户"只导入了前 5000 首"，不能假装导完了。
 */
function scanAudioFolder(root) {
  const out = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > SCAN_DEPTH) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }  // 没权限的目录直接跳过
    for (const it of items) {
      if (truncated) return;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!it.isFile()) continue;
      if (!AUDIO_EXT.has(path.extname(it.name).toLowerCase())) continue;
      if (out.length >= SCAN_MAX) { truncated = true; return; }
      out.push(full);
    }
  };
  walk(root, 0);
  return { paths: out, truncated };
}

// ============================================================
//  第 2.5 部分：右上角窗口按钮（自绘）
// ============================================================
//  我们不再用系统画的 最小化/最大化/关闭 三个按钮（那是 titleBarOverlay，
//  它既不读 CSS、又是个实心色块，没法做成"跟着主题变色的磨砂按钮"）。
//  改由界面用 HTML 自己画三个按钮（见 index.html 的 .win-controls），
//  它们天然跟着主题色走、还和磨砂标题栏一体。
//  界面点按钮 → 经 IPC 调到这里的 mainWindow.minimize/maximize/close。
//  另外，窗口被最大化/还原时（包括双击标题栏触发的），主动通知界面，
//  让"最大化"按钮切换成"还原"图标。

// ============================================================
//  第 2 部分：创建窗口
// ============================================================
function requestMainWindowClose() {
  if (!mainWindow || mainWindow.isDestroyed() || closeInProgress) return;
  closeInProgress = true;
  if (closeTimeout) clearTimeout(closeTimeout);
  closeTimeout = setTimeout(() => finishMainWindowClose(false), 8000);
  try {
    mainWindow.webContents.send('win:prepare-close');
  } catch (err) {
    finishMainWindowClose(false);
  }
}

function finishMainWindowClose(saved) {
  if (!closeInProgress) return;
  closeInProgress = false;
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 无论最终存盘成功与否都放行关闭：宁可丢一次改动，也不能让用户关不掉窗口。
  // （日常改动的保存失败，界面侧会弹提示，见 app.js 的 persist()。）
  if (!saved) console.error('[store] renderer did not confirm final save before close');
  allowCloseOnce = true;
  mainWindow.close();
}

/* ---------- mini 模式的几个小工具 ---------- */

// 存档里记的"上次完整模式的窗口位置和大小"。读不出来就返回 {}（当成第一次打开）
function readSavedWindowSettings() {
  try {
    const d = readDataFile();
    const w = d && d.settings && d.settings.window;
    return w && typeof w === 'object' ? w : {};
  } catch (_) {
    return {};
  }
}

// 把存档里的 bounds 洗一遍：尺寸不合理（比最小尺寸还小、或不是数字）就当没有，
// 免得存档被写坏之后窗口打不开。
function normalizeBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const width = Math.round(Number(b.width));
  const height = Math.round(Number(b.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < FULL_MIN_W || height < FULL_MIN_H) return null;

  const out = { width, height };
  const x = Math.round(Number(b.x));
  const y = Math.round(Number(b.y));
  // 位置还要确认"这块屏幕还在" —— 拔掉外接显示器之后，存档里的坐标可能已经在屏幕外，
  // 照搬过去窗口就"打开在看不见的地方"了。落不到任何屏幕上就交给系统居中。
  if (Number.isFinite(x) && Number.isFinite(y) && pointOnSomeDisplay(x, y)) {
    out.x = x;
    out.y = y;
  }
  return out;
}

function pointOnSomeDisplay(x, y) {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      // 允许窗口左上角稍微出界一点，但至少要有一小块留在可见区域里
      return x >= a.x - 60 && x < a.x + a.width - 60 && y >= a.y - 20 && y < a.y + a.height - 60;
    });
  } catch (_) {
    return false;
  }
}

function createWindow() {
  closeInProgress = false;
  allowCloseOnce = false;

  // ★ v2.1.0：上次退出时是不是 mini、完整模式下的窗口多大，都记在存档里。
  //   启动时照着它开窗 —— 否则"上次明明缩在 mini，这次一打开却是个大窗"。
  const saved = readSavedWindowSettings();
  const startMini = !!saved.mini;
  const startExpanded = !!(startMini && saved.miniExpanded);
  const fullBounds = normalizeBounds(saved.fullBounds) || { width: FULL_DEF_W, height: FULL_DEF_H };
  miniState = { on: startMini, expanded: startExpanded, fullBounds };

  const winOpts = {
    width: startMini ? MINI_W : fullBounds.width,
    height: startMini ? (startExpanded ? MINI_H_EXPANDED : MINI_H_COLLAPSED) : fullBounds.height,
    title: 'Neko Music',
    // ★ v2.1.0：窗口图标。之前一个图标文件都没有，任务栏 / Alt+Tab 里显示的是
    //   Electron 的默认图标（一个灰色的电子）。图是 .verify/make-icon.js 手搓出来的。
    icon: path.join(__dirname, 'assets', 'app.png'),
    backgroundColor: '#12121c', // 窗口还没画出来时的底色，避免白闪
    autoHideMenuBar: true,       // 隐藏顶部菜单栏，更清爽
    show: false,                 // 等页面准备好再显示，避免白屏闪烁

    // ★ v2.4.0：存档就是 mini 时，一开窗就置顶。
    //   mini 是一条"悬浮小窗"，和桌面歌词一样该浮在别的窗口上面（Neo 2026-10-14 报的）。
    //   这里先给个普通置顶；真正那一档（'screen-saver'）在 ready-to-show 里升上去。
    //   完整模式不置顶。
    alwaysOnTop: startMini,

    // ★ 干掉窗口最上面那圈"白边"。
    //   那圈白边是 Windows 自带的标题栏，它的颜色跟着系统是浅色还是深色走，
    //   CSS 完全够不着它 —— 所以只能整条藏掉，换成网页里自己画的深色标题栏
    //   （见 index.html 里的 .titlebar）。
    //   'hidden' 的意思是：窗口边框、拖动、缩放这些系统能力都还在，
    //   只是标题栏那一条不画了，交给我们自己画。
    //   关键点：不配 titleBarOverlay。官方文档写明 —— 在 Windows 上，
    //   'hidden' 不配 titleBarOverlay 时"不会显示任何系统窗口控制按钮"，
    //   于是右上角那三个系统按钮彻底消失，正好换成我们自己画的 .win-controls。
    //   同时原生边框还在（圆角、阴影、拖到屏幕边缘自动半屏/全屏都保留）。
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // 注入传话筒
      contextIsolation: true,  // 安全隔离，网页不能直接碰 Node.js
      nodeIntegration: false,
      spellcheck: false,
    },
  };

  // 位置：存档里有、而且那块屏幕还在，就照搬；否则交给系统居中
  if (fullBounds.x !== undefined) { winOpts.x = fullBounds.x; winOpts.y = fullBounds.y; }

  // 尺寸限制：mini 下卡死在 420 宽（高 132~520）；完整模式用常规下限
  if (startMini) {
    winOpts.minWidth = MINI_W;
    winOpts.minHeight = MINI_H_COLLAPSED;
    winOpts.maxWidth = MINI_W;
    winOpts.maxHeight = MINI_H_EXPANDED;
    winOpts.resizable = false;
  } else {
    winOpts.minWidth = FULL_MIN_W;
    winOpts.minHeight = FULL_MIN_H;
  }

  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // ★ v2.2.0 安全加固：禁止开出"原生新窗口"。
  //   target="_blank" / window.open / 中键点击都可能弹出 Electron 原生新窗口 ——
  //   那个窗口没有 preload、没有我们的 CSP 管控，等于开了个后门。
  //   Neko 的外链本来就走 shell.openExternal（见下面的 shell:open），所以 deny 掉不影响任何功能。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 页面渲染完成后再亮相
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // ★ v2.4.0：mini 的置顶也要等窗口**真的显示出来之后**再升档。
    //   和下面 refreshThumbar 是同一个时机问题 —— 窗口还没显示时设了可能不算数。
    if (miniState.on) setMiniAlwaysOnTop(mainWindow, true);
    // ★ v2.2.1：任务栏缩略图按钮必须等窗口**真的显示出来之后**再设。
    //   whenReady 里那次调用发生在 show() 之前 —— 那时 Explorer 还没给窗口建出任务栏按钮，
    //   setThumbarButtons 会返回 false 并且什么都不做。
    //   表现就是"鼠标悬停任务栏图标，预览出来了、但一个按钮都没有"。
    refreshThumbar();
  });

  // 从托盘 / 最小化回到前台时再补一次（Explorer 偶尔会把按钮状态弄丢）
  mainWindow.on('show', () => refreshThumbar());

  // ============================================================
  //  点 ✕ 之后干什么（v2.2.0）
  // ============================================================
  //  加了托盘之后，"点 ✕"就有了两种合理含义，猜错的那个一定会被骂：
  //    · 猜成"退出" → 用户想让它后台放歌，结果被关掉了
  //    · 猜成"缩小" → 用户以为关掉了，其实还在跑（托盘里悄悄留着）
  //  所以缺省是**问一次**，并允许"别再问了"（存档里的 settings.close.action）。
  //
  //  ★ 真退出时**仍然要走存盘握手**（requestMainWindowClose），
  //    只是跳过弹窗、跳过隐藏 —— 这是 Neko 和参考项目 biu 的关键差别
  //    （它关窗前不用存盘，所以能直接放行；见 docs/参考实现研究-biu.md §2.1）。
  mainWindow.on('close', (event) => {
    // 存盘握手完成后的那一次真关，放行
    if (allowCloseOnce) { allowCloseOnce = false; return; }
    event.preventDefault();

    const action = decideCloseAction({ quitting: !!app.quitting, action: uiState.closeAction });
    // ① 真退出（"正在退出" / 用户设成"彻底关闭"）→ 走现有的存盘流程
    if (action === 'quit') { requestMainWindowClose(); return; }
    // ② 缩小到任务栏 → 只把窗口藏起来：播放继续、托盘图标还在
    //    ★ 这里是 hide() 而不是 close()，所以 window-all-closed 不会触发、app.quit() 也不会被调用
    if (action === 'tray') { hideMainWindow(); return; }
    // ③ 每次询问 → 交给界面弹窗，等它回 win:close-choice
    try { mainWindow.webContents.send('win:ask-close'); }
    catch (_) { requestMainWindowClose(); }
  });

  // 主窗口关掉时，悬浮歌词也要一起关（不然会剩一个孤零零的窗口挂在桌面上）
  mainWindow.on('closed', () => { closeLyricWindow(); });

  // 窗口被最大化 / 还原时，通知界面，让"最大化"按钮切换成"还原"图标。
  // （双击标题栏最大化、拖到顶部最大化，都会触发这里。）
  mainWindow.on('maximize',   () => { try { mainWindow.webContents.send('win:state', true);  } catch (_) {} });
  mainWindow.on('unmaximize', () => { try { mainWindow.webContents.send('win:state', false); } catch (_) {} });

  // ============================================================
  //  无边框窗口的三处加固（v2.1.0，做法参考同类项目 biu）
  // ============================================================
  //  我们不用系统标题栏、整套界面都自己画。自绘带来两个副作用，顺手一起堵上。

  // ① 拦掉 Windows 的系统菜单（WM_INITMENU = 0x0116）。
  //    无边框窗口按 Alt+Space、或在标题栏右键，会冒出系统那个"还原/移动/大小/最小化/关闭"菜单，
  //    和我们自绘的界面格格不入。做法是"拦下这条消息，把窗口瞬间禁用再启用"。
  //    ⚠️ hookWindowMessage 是实验性 API，**只在 Windows 有效**，别的平台要跳过
  //    （macOS / Linux 上这个方法不存在，所以先用 typeof 探一下）。
  if (process.platform === 'win32' && typeof mainWindow.hookWindowMessage === 'function') {
    mainWindow.hookWindowMessage(0x0116, () => {
      try { mainWindow.setEnabled(false); } catch (_) {}
      setTimeout(() => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true); } catch (_) {}
      }, 100);
    });
  }

  // ② 禁掉 Ctrl+R（刷新页面）。
  //    误按一下，整个界面会被重载回首页 —— 歌还在响，看着却像崩了。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && String(input.key || '').toLowerCase() === 'r') event.preventDefault();
  });

  // ③ 禁掉 Chromium 自带的右键菜单（"返回 / 重新加载 / 检查"那一坨，和自绘风格完全不搭）。
  //    ⚠️ 但输入框里要放行：搜索框、Cookie 输入框里右键要用系统的"粘贴 / 全选"，
  //       全禁掉会让人没法粘贴 Cookie。
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (params && (params.isEditable || params.selectionText)) return;
    event.preventDefault();
  });

  // ---- 记住"完整模式下的窗口位置和大小" ----
  // 拖动 / 缩放停下来 0.5 秒后，把当前的位置尺寸推给界面存档。
  // 用 getNormalBounds() 而不是 getBounds()：最大化的时候前者给的才是"还原后"的尺寸。
  // mini 模式下不推 —— 那时的尺寸是固定两档，存了反而会把 fullBounds 覆盖掉。
  let boundsTimer = null;
  const pushBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || miniState.on) return;
      try { mainWindow.webContents.send('win:bounds', mainWindow.getNormalBounds()); } catch (_) {}
    }, 500);
  };
  mainWindow.on('resize', pushBounds);
  mainWindow.on('move', pushBounds);

  // 把网页里的日志转发到终端 —— 只在"调试模式"下开启。
  // 平时关着，原因有两个：
  //   ① 网页动不动就刷一堆警告（比如图片被安全策略拦了），全打到终端会很吵；
  //   ② 正常启动时根本没有终端可看，这些日志无处可去。
  // 需要排查问题时，双击"调试启动.bat"，它会把调试开关打开。
  if (process.env.NEKO_DEBUG === '1') {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[页面${level === 3 ? '错误' : '日志'}] ${message}  (${sourceId}:${line})`);
    });
  }

}

// ============================================================
//  第 2.8 部分：托盘 / 任务栏缩略图按钮 / 任务栏右键任务（v2.2.0）
// ============================================================
//  这三样都是**系统（Explorer）画的东西**，离屏 Electron 里根本不存在 ——
//  所以"长什么样"只能真机看，能测的是"调用路径对不对、菜单模板结构对不对"。

/* ---------- 图标读取（带缓存，别每次重建菜单都重新读盘） ---------- */
const iconCache = new Map();
function loadIcon(file) {
  if (!iconCache.has(file)) {
    const p = path.join(__dirname, 'assets', file);
    const img = nativeImage.createFromPath(p);
    // 图标读不出来要"吭声"：路径写错时托盘会**静默不出现**，非常难查
    // （这条是从参考项目 biu 学来的，见 docs/参考实现研究-biu.md §2.5）
    if (img.isEmpty()) {
      console.error('[icon] 图标没读出来：' + p);
      iconCache.set(file, undefined);
      return undefined;
    }
    // ★ v2.2.1：把同名的 @2x（32×32）也挂上去。
    //   菜单图标在 Windows 上占 16×16 的位置，125% / 150% 缩放时系统要把它放大 ——
    //   16×16 放大出来是糊的。挂一张 2 倍图，系统按当前 DPI 自己挑清楚的那张。
    //   没有 @2x 文件也不影响，那就还是用 1 倍图。
    try {
      const p2 = p.replace(/\.png$/i, '@2x.png');
      if (fs.existsSync(p2)) {
        const buf2 = fs.readFileSync(p2);
        if (!nativeImage.createFromBuffer(buf2).isEmpty()) {
          img.addRepresentation({ scaleFactor: 2, buffer: buf2 });
        }
      }
    } catch (err) {
      console.error('[icon] 挂 @2x 失败（不影响使用）：', err);
    }
    iconCache.set(file, img);
  }
  return iconCache.get(file);
}
const menuIcon = (name) => loadIcon(`menu-${name}.png`);
const thumbIcon = (name) => loadIcon(`thumb-${name}.png`);

/** 界面状态 + mini 状态 → 菜单要的那一份 */
function menuState() {
  return Object.assign({}, uiState, { mini: !!miniState.on });
}

/* ---------- 主窗口：叫到前台 / 藏起来 ---------- */

/**
 * 把主窗口叫到前台。
 * ★ 光 show() 不够：窗口处于"最小化"状态时 show() 不会把它还原出来，
 *   用户点了两次图标却什么都没发生。必须先 restore 再 show 再 focus，三步都做才算完整。
 *   （这一条是从参考项目 biu 学来的，见 docs/参考实现研究-biu.md §2.4）
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/** "缩小到任务栏"：只藏起来，不关 —— 播放继续、托盘图标还在、存档一个字节都不动 */
function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

/* ---------- 把命令交给界面执行 ---------- */
function sendCmd(cmd) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('win:cmd', cmd); } catch (_) { /* 窗口正在关，忽略 */ }
}

/**
 * 来自"外部"的命令：第二个实例带的参数、任务栏右键里的「任务」。
 * 有些能主进程自己办（显示窗口 / 切 mini），有些得界面来办（播放控制 / 打开设置）。
 */
function handleExternalCmd(cmd) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  switch (cmd) {
    case 'show':   showMainWindow(); break;
    case 'mini':   applyMini(!miniState.on, false); break;
    case 'settings': showMainWindow(); sendCmd('settings'); break;
    case 'toggle': case 'prev': case 'next': sendCmd(cmd); break;
    default: break;
  }
}

/* ---------- mini：主进程这一半的"进 / 出" ---------- */
function applyMini(on, expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const st = handleMiniRequest(mainWindow, miniState, { on: !!on, expanded: !!expanded },
    screen.getPrimaryDisplay().workAreaSize);
  pushMiniState(st);
}

/** 把 mini 状态回推给界面，并顺手刷新"跟着 mini 变"的两样系统东西 */
function pushMiniState(st) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
  }
  // 注：mini 的置顶不在这里做 —— 它跟着窗口状态走，已经收在 win-mini.js 的
  //     applyMiniBounds / restoreFullBounds 里（进 / 出两个方向各一句），
  //     而那两句是**进 / 出 mini 两条入口**都会经过的 handleMiniRequest 调的。
  applyThumbnailClip();   // 缩略图裁哪一块，跟着 mini 变
  refreshTrayMenu();      // 托盘里「窗口模式」那个打勾，跟着 mini 变
}

/* ---------- 任务栏缩略图上的三个按钮（Neo 图4） ---------- */

/** 悬停任务栏图标时，缩略图裁到"封面那一块"（只在 mini 下说得通） */
function applyThumbnailClip() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setThumbnailClip !== 'function') return;
  try {
    const r = miniState.on ? uiState.coverRect : null;
    // 全 0 = "不裁，用整个窗口的预览"（这是官方文档给的复位写法）
    mainWindow.setThumbnailClip(r || { x: 0, y: 0, width: 0, height: 0 });
  } catch (_) {}
}

/**
 * 重设任务栏缩略图上的三个按钮。
 * ⚠️ 图标必须是 nativeImage（16×16 PNG），**不能用 SVG**。
 * 播放状态一变就要重设一次 —— 因为"播放 / 暂停"是同一个按钮换图标。
 */
function refreshThumbar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setThumbarButtons !== 'function') return;   // 只有 Windows 有

  const playing = !!uiState.playing;
  const btns = [
    { tooltip: '上一首', icon: thumbIcon('prev'), click: () => sendCmd('prev') },
    { tooltip: playing ? '暂停' : '播放', icon: thumbIcon(playing ? 'pause' : 'play'), click: () => sendCmd('toggle') },
    { tooltip: '下一首', icon: thumbIcon('next'), click: () => sendCmd('next') },
  ];
  // 图标没读出来时先不设：setThumbarButtons 里只要有一个图标是空的，整组按钮都不显示，
  // 与其"三个按钮凭空消失"，不如保持上一次的样子。
  if (btns.some((b) => !b.icon)) return;

  try {
    const okSet = mainWindow.setThumbarButtons(btns);
    // ★ v2.2.1：这个 API 会**静默失败**。窗口还没显示出来时（Explorer 那边还没建出
    //   任务栏按钮）它会返回 false 并且什么都不做 —— 表现就是"悬停图标，一个按钮都没有"。
    //   所以把返回值记下来，出问题时有据可查。
    if (!okSet) console.error('[thumbar] setThumbarButtons 返回 false（窗口可能还没显示出来）');
    // 悬停时那行提示文字，成本几乎为零
    const tip = uiState.hasTrack && uiState.title ? `Neko Music —— ${uiState.title}` : 'Neko Music';
    mainWindow.setThumbnailToolTip(tip);
  } catch (err) {
    console.error('[thumbar] 设置任务栏按钮失败：', err);
  }
}

/* ---------- 任务栏右键的「任务」（JumpList 的阉割版：不能有子菜单） ---------- */
function refreshUserTasks() {
  if (process.platform !== 'win32') return;
  if (typeof app.setUserTasks !== 'function') return;
  try {
    app.setUserTasks(buildUserTasks(menuState(), {
      exePath: process.execPath,
      // 打包后是 null（exe 就是自己）；开发期要带上工程目录，否则会开出一个空白 Electron
      appPath: app.isPackaged ? null : app.getAppPath(),
      iconPath: (name) => path.join(__dirname, 'assets', `menu-${name}.png`),
    }));
  } catch (err) {
    console.error('[userTasks] 设置任务栏任务失败：', err);
  }
}

/* ---------- 托盘图标（Neo 图5 那个菜单就挂在这上面） ---------- */
function createTray() {
  // ★ 用 .ico 而不是 .png：ico 是"多分辨率容器"，系统按当前 DPI 自己挑一档，
  //   125% / 150% 缩放下比单张 PNG 清晰（见 docs/参考实现研究-biu.md §2.5）
  const trayIconPath = path.join(__dirname, 'assets', 'tray.ico');
  const img = nativeImage.createFromPath(trayIconPath);
  if (img.isEmpty()) console.error('[tray] 图标没加载出来：' + trayIconPath);

  // 创建前先把旧的销毁，避免"二次调用 / 调试时热重启"在托盘里留下两个图标
  if (tray) { tray.destroy(); tray = null; }

  tray = new Tray(img);
  refreshTrayMenu();
  // 单击 / 双击：把主窗口叫出来 —— 这是"缩小到任务栏"之后的总出口
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

/**
 * 重建托盘菜单。
 * ★ 原生菜单**不能像网页那样局部刷新** —— 歌名 / 播放状态 / 播放模式 / 窗口模式
 *   这四项里任何一项变了，都得整个重建一遍。所以这个函数会被频繁调用，要便宜。
 */
function refreshTrayMenu() {
  if (!tray) return;
  const state = menuState();
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, {
      icon: menuIcon,
      show: showMainWindow,
      toggle: () => sendCmd('toggle'),
      prev: () => sendCmd('prev'),
      next: () => sendCmd('next'),
      setMode: (id) => sendCmd('mode:' + id),
      setMini: (on) => { if (miniState.on !== !!on) applyMini(!!on, false); },
      lyricOpen: () => sendCmd('lyric-open'),
      lyricLock: () => sendCmd('lyric-lock'),
      settings: () => { showMainWindow(); sendCmd('settings'); },
      quit: () => app.quit(),
    })));
    tray.setToolTip(state.hasTrack && state.title ? `Neko Music —— ${state.title}` : 'Neko Music');
  } catch (err) {
    console.error('[tray] 重建菜单失败：', err);
  }
}

// ============================================================
//  第 3 部分：本地存档（歌单、收藏、历史）
// ============================================================
//  就是一个 JSON 文件，存在系统的应用数据目录里。
//  关掉软件再打开，数据还在。

function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('读取存档失败，将使用空白数据：', err);
    return null;
  }
}

/**
 * 直接从存档文件里读"关窗行为"。
 * 用途：界面还没跑起来的时候（比如启动几毫秒内就有人点了 ✕），
 * 主进程也得知道该弹窗、该退、还是该缩小。界面起来之后会通过 win:ui-state 覆盖它。
 */
function readCloseActionFromStore() {
  try {
    const d = readDataFile();
    return normalizeCloseAction(d && d.settings && d.settings.close && d.settings.close.action);
  } catch (_) {
    return 'ask';
  }
}


// ============================================================
//  第 4 部分：接收界面的请求（IPC 处理）
// ============================================================
//  统一包装：出错时返回 { ok:false, error }，界面就能弹出友好提示，
//  而不是让整个软件崩溃。
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data: data === undefined ? null : data };
    } catch (err) {
      console.error(`[${channel}] 出错：`, err);
      // reason 是给界面看的"失败原因分类"（比如字幕的 no-cookie / none / limit），
      // 没有就省略。界面据此显示不同的提示文案。
      return { ok: false, error: err.message || String(err), reason: err.reason };
    }
  });
}

function registerHandlers() {
  handle('bili:parse', (text) => bili.parseUserInput(text));
  handle('bili:videoInfo', (bvid) => bili.getVideoInfo(bvid));
  handle('bili:search', (keyword, page) => bili.searchVideos(keyword, page || 1));

  // 拿到真实音频地址后，包一层 bili:// 给界面用
  handle('bili:audioUrl', async (bvid, cid) => {
    const info = await bili.getAudioUrl(bvid, cid);
    return {
      url: `bili://get?url=${encodeURIComponent(info.url)}`,
      backup: (info.backup || []).map((b) => `bili://get?url=${encodeURIComponent(b)}`),
      quality: info.quality,
      duration: info.duration,
    };
  });

  handle('bili:favFolders', (mid) => bili.getFavFolders(mid));
  handle('bili:favMedias', (mediaId, pn) => bili.getFavMedias(mediaId, pn || 1));
  // v2.6.0：认出"你是谁"（uid / 昵称）—— 「导入我的收藏夹」的入口靠它。
  // 失败时 reason 会原样传回界面（no-cookie / cookie-expired），界面据此给不同引导。
  handle('bili:myInfo', () => bili.getMyInfo());
  // 点作者名 → 看这个 UP 的全部视频
  handle('bili:upVideos', (mid, pn) => bili.getUpVideos(mid, pn || 1));

  // ---------- 字幕（做滚动歌词用） ----------
  // 界面靠返回的 reason 区分失败原因，从而给出不同提示（没登录 / 没字幕 / 被限流）
  handle('bili:subtitle', async (bvid, cid) => {
    try {
      return await bili.getSubtitle(bvid, cid);
    } catch (err) {
      // 把 reason 原样传回界面，别让它自己猜
      const e = new Error(err.message || '字幕获取失败');
      e.reason = err.reason || 'network';
      throw e;
    }
  });

  // 界面用它来决定"词"按钮提示什么（还是提前提示去填 Cookie）
  handle('bili:hasCookie', () => bili.hasLoginCookie());

  // 用系统默认浏览器打开网页（播放条上的「打开视频」按钮）。
  // ⚠️ 一定要自己校验：网页那边如果被注入恶意内容，
  //   就能借这个接口去打开 file:// 之类的本地路径。只放行 http/https。
  handle('shell:open', async (url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) {
      throw new Error('只能打开 http/https 网址');
    }
    await shell.openExternal(u);
    return true;
  });

  // 读取 / 保存用户填的 B 站 Cookie
  handle('cookie:get', () => {
    try {
      return fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8') : '';
    } catch (e) {
      return '';
    }
  });
  handle('cookie:set', (text) => {
    fs.writeFileSync(COOKIE_FILE, String(text || ''), 'utf8');
    bili.setUserCookie(text);   // 立刻生效，不用重启软件
    return true;
  });

  handle('store:load', () => {
    const saved = readDataFile();
    const data = migrate(saved || DEFAULT_DATA, { bgDir: BG_DIR });
    refreshLibraryCache(data);   // 刷新 local:// 的白名单 + 下载器设置
    return data;
  });

  // 存档写成"原子操作"：先写临时文件，写完了再改名顶替。
  // 这样万一写到一半断电/崩溃，原来的好文件还在，不会出现"存档变空"的惨剧。
  handle('store:save', (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('存档数据格式无效');
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
    // ★ 存档是 local:// 白名单的来源 —— 存完必须立刻刷新，
    //   否则新导入的歌要等下一次 load 才能播（表现为"刚加进来点了没反应"）。
    refreshLibraryCache(data);
    return true;
  });

  // 界面右上角自绘的三个窗口按钮：最小化 / 最大化(切换) / 关闭
  ipcMain.on('win-min', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('win-max', () => {
    if (!mainWindow) return;
    // 已经是最大化就还原，否则最大化（一个按钮兼顾两种状态）
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  // ★★ v2.2.1 修的 bug：这里**必须走 mainWindow.close()**，让 close 事件去做决策
  //    （询问 / 缩小到托盘 / 彻底退出）。
  //    早先这一行直接调 requestMainWindowClose()，等于**绕过了整套决策** ——
  //    表现就是"第一次点 ✕，弹窗压根不出现，软件直接退干净了"。
  //    close() 会触发 mainWindow.on('close')：那里 preventDefault 之后再按
  //    settings.close.action 分流；真要退时它才会回头调 requestMainWindowClose() 走存盘握手。
  ipcMain.on('win-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.on('win:close-ready', (_event, ok) => finishMainWindowClose(!!ok));
  ipcMain.on('win:fullscreen', (flag) => { if (mainWindow) mainWindow.setFullScreen(!!flag); });

  // ---- mini 模式（v2.1.0）----
  // 界面那边已经先把 body.mini 类加好了（布局由 CSS 换），这里只负责窗口本身：
  //   进：记下"完整模式的样子" → 缩成 420×132（展开态 420×520）
  //   出：放开尺寸限制 → 还原成记下来的样子
  // 完事回推一条 win:mini-state，让界面把图标、☰ 的行为跟着切过来。
  // ★ 真正的逻辑在 win-mini.js 的 handleMiniRequest 里（抽出去是为了能离线实测）。
  ipcMain.on('win:mini', (_event, opts) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const o = (opts && typeof opts === 'object') ? opts : {};
    const st = handleMiniRequest(mainWindow, miniState, o, screen.getPrimaryDisplay().workAreaSize);
    // 回推状态 + 顺手刷新两样跟着 mini 变的东西（缩略图裁哪一块、托盘里的窗口模式打勾）
    pushMiniState(st);
  });

  // ---- 界面状态回传（v2.2.0）----
  // 歌名 / 播放状态 / 播放模式 / 桌面歌词 / 关窗行为 —— 界面推过来，主进程拿它画托盘菜单。
  // ★ 界面那边做了"状态没变就不发"的过滤（播放中这个会被频繁调到），这里再做一次兜底：
  //   真没变就什么都不做，免得把原生菜单反复重建。
  ipcMain.on('win:ui-state', (_event, st) => {
    const next = normalizeUiState(st);
    const prev = uiState;
    const changed = ['playing', 'hasTrack', 'title', 'playMode', 'lyricOn', 'lyricLocked', 'closeAction']
      .some((k) => next[k] !== prev[k]);
    const rectChanged = JSON.stringify(next.coverRect) !== JSON.stringify(prev.coverRect);
    if (!changed && !rectChanged) return;
    uiState = next;
    if (changed) {
      if (next.playing !== prev.playing || next.title !== prev.title || next.hasTrack !== prev.hasTrack) refreshThumbar();
      refreshTrayMenu();
    }
    if (rectChanged) applyThumbnailClip();
  });

  // ---- 关闭弹窗的结果（v2.2.0）----
  // 界面弹完窗之后回这里：action 只有 'quit' / 'tray' 两种；remember = 勾了「设为默认值」。
  ipcMain.on('win:close-choice', (_event, payload) => {
    const p = (payload && typeof payload === 'object') ? payload : {};
    // 界面只可能选这两个；万一传来别的东西，一律按"缩小到任务栏"处理（这个不会丢数据）
    const action = normalizeCloseAction(p.action) === 'quit' ? 'quit' : 'tray';
    if (p.remember) uiState = Object.assign({}, uiState, { closeAction: action });
    if (action === 'quit') requestMainWindowClose();   // 真退出：走存盘握手
    else hideMainWindow();                             // 缩小到任务栏：只藏起来
  });

  // ---- 自定义背景 ----
  // 弹系统文件选择框 → 把选中的图复制到 backgrounds/ → 返回文件名
  // ---- 自定义背景 ----
  // 弹系统文件选择框 → 把选中的图片/视频复制到 backgrounds/ → 返回文件名
  // kind: 'image'（默认，选图）| 'video'（选视频当背景）
  handle('bg:pick', async (kind) => {
    const isVideo = kind === 'video';
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: isVideo ? '选一段视频当背景' : '选一张图片当背景',
      properties: ['openFile'],
      filters: isVideo
        ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;

    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!BG_MIME[ext]) {
      return { error: isVideo ? '这个视频格式不支持，换 mp4 / webm 吧' : '这个格式不支持，换 png / jpg / webp 吧' };
    }

    const sizeMB = fs.statSync(src).size / 1024 / 1024;
    if (isVideo && sizeMB > BG_VIDEO_MAX_MB) {
      return { error: `视频太大了（${sizeMB.toFixed(0)}MB），换一个小于 ${BG_VIDEO_MAX_MB}MB 的` };
    }

    fs.mkdirSync(BG_DIR, { recursive: true });
    clearBgDir(BG_DIR);   // 一次只留一份（图片和视频共用这个目录，避免堆积）

    const name = 'bg-' + Date.now().toString(36) + ext;
    fs.copyFileSync(src, path.join(BG_DIR, name));
    return { file: name, kind: isVideo ? 'video' : 'image', sizeMB: Number(sizeMB.toFixed(1)) };
  });

  handle('bg:clear', () => { clearBgDir(BG_DIR); return true; });

  // ---- 下载（v2.8.0）----
  // 任务状态归主进程（downloads.json），界面只负责"下指令"和"看结果"。
  handle('download:add', (tracks) => {
    const r = downloader.add(tracks);
    if (!r.needDir) saveDownloadsSoon();
    return r;   // needDir=true 时界面会弹"选下载位置"，选完再调一次
  });

  handle('download:list', () => ({
    tasks: downloader.list(),
    stats: downloader.stats(),
    dir: downloadSettings.dir || null,
  }));

  handle('download:pause',  (id) => downloader.pause(id));
  handle('download:resume', (id) => downloader.resume(id));
  handle('download:retry',  (id) => downloader.retry(id));
  handle('download:cancel', (id) => { const r = downloader.cancel(id); saveDownloadsSoon(); return r; });
  handle('download:remove', (ids, deleteFile) => {
    for (const id of (Array.isArray(ids) ? ids : [ids])) downloader.remove(id, !!deleteFile);
    saveDownloadsSoon();
    return true;
  });
  handle('download:clearFinished', () => {
    const r = downloader.clearFinished();
    saveDownloadsSoon();
    return r;
  });

  // 选下载目录。properties 里带 createDirectory，让用户在对话框里就能顺手新建文件夹。
  handle('download:pickDir', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选一个文件夹，下载的歌存这里',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: downloadSettings.dir || app.getPath('music'),
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return { dir: res.filePaths[0] };
  });

  // 界面选完目录后告诉主进程，好让"立刻"就能下。
  // （真正的持久化还是界面写进 settings.download.dir，主进程不碰存档。）
  handle('download:setDir', (dir) => {
    const d = String(dir || '').trim();
    if (!d) throw new Error('目录不能为空');
    let ok = false;
    try { ok = fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch (_) { ok = false; }
    if (!ok) throw new Error('这个文件夹不存在或打不开');
    downloadSettings.dir = d;
    return true;
  });

  // 打开下载目录。★ 不接受界面传路径，固定用设置里那一个 ——
  //   否则就等于给了网页一个"打开任意目录"的后门。
  handle('download:openDir', async () => {
    const dir = downloadSettings.dir;
    if (!dir) throw new Error('还没设置下载目录');
    if (!fs.existsSync(dir)) throw new Error('下载目录不存在了，请在设置里重新选择');
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });

  // 在资源管理器里定位到某个文件。★ 只取 basename，路径里的目录部分一律丢掉，
  //   所以界面就算传 "../../windows/system32" 也只能落在下载目录里面。
  handle('download:reveal', (file) => {
    const dir = downloadSettings.dir;
    if (!dir) throw new Error('还没设置下载目录');
    const name = path.basename(String(file || ''));
    if (!name) throw new Error('文件名不合法');
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) throw new Error('文件不在了');
    shell.showItemInFolder(full);
    return true;
  });

  // ---- 本地歌曲：挑文件 / 挑文件夹 / 问文件在不在（v2.8.0）----
  // ★ 这里只做"文件系统那一半"：选、扫描、读大小。**绝不碰存档** ——
  //   本地歌曲库是界面在管的（界面才是 neko-data.json 的 owner），
  //   主进程要是也去写，两边会互相覆盖，用户会看到歌莫名其妙少一批。
  handle('local:pickFiles', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选歌导入（可以按住 Ctrl 多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频文件', extensions: [...AUDIO_EXT].map((e) => e.slice(1)) }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return { paths: res.filePaths, truncated: false };
  });

  handle('local:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选一个文件夹，把里面的歌都导入',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return scanAudioFolder(res.filePaths[0]);
  });

  // 批量问"这些文件还在不在、多大" —— 界面拿它标失效、算总占用
  handle('local:stat', (paths) => {
    const arr = Array.isArray(paths) ? paths : [paths];
    return arr.map((p) => {
      const s = String(p || '');
      try {
        const st = fs.statSync(s);
        return { path: s, exists: st.isFile(), size: st.size };
      } catch (_) {
        return { path: s, exists: false, size: 0 };
      }
    });
  });

  // ---- 桌面歌词（第二个窗口） ----
  // 主窗口负责"给内容"，这里负责"转发和操作窗口本身"。
  ipcMain.on('lyric:open',   (_e, opts) => createLyricWindow(opts));
  ipcMain.on('lyric:close',  () => closeLyricWindow());
  ipcMain.on('lyric:push',   (_e, data) => { lastLyricData = data; pushToLyric('lyric:data', data); });
  ipcMain.on('lyric:style',  (_e, style) => { lastLyricStyle = style; pushToLyric('lyric:style', style); });
  ipcMain.on('lyric:resize', (_e, h) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    const hh = Math.max(LYRIC_MIN_H, Math.round(Number(h) || LYRIC_MIN_H));
    const [w] = lyricWindow.getSize();
    lyricWindow.setSize(w, hh, false);
  });
  // 拖动：进入时把"光标相对窗口左上角的偏移"算出来，之后主进程自己跟着光标挪窗口。
  // 中间不再逐帧收消息 —— 那正是之前拖动一卡一卡的原因。
  ipcMain.on('lyric:drag-start', () => startLyricDrag());
  ipcMain.on('lyric:drag-end',   () => { stopLyricDrag(); scheduleLyricPosNotify(); });
  ipcMain.on('lyric:through', (_e, on) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    // forward:true —— 开启时把鼠标事件转给下面的软件，等于"点穿过去"
    lyricWindow.setIgnoreMouseEvents(!!on, { forward: true });
  });
  // 悬浮窗上那排按钮（上一首 / 播放 / 下一首 / 字号 / 锁定 / 关闭）→ 转给主窗口执行
  ipcMain.on('lyric:cmd', (_e, cmd, arg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('lyric:cmd', cmd, arg); } catch (_) { /* 忽略 */ }
    }
  });
}

// ============================================================
//  第 4.5 部分：桌面歌词（第二个窗口）
// ============================================================
//  这是一个独立的无边框小窗，浮在所有软件最上面，专门显示当前歌词。
//  它自己不播歌、也不联网 —— 所有内容都由主窗口推过来（见下面的 lyric:push）。
//
//  四个必须知道的点：
//    ① transparent:true + frame:false 才能做出"只有字、没有框"的效果；
//       同时 backgroundColor 必须是 #00000000，否则会是一整块黑。
//       底板和边框画不画，由页面里的 .bare 类决定（默认不画，只有字）。
//    ② alwaysOnTop 用 'screen-saver' 这一级 —— 比普通置顶更高，
//       别的软件全屏播放时也压得住（普通置顶会被全屏程序盖掉）。
//    ③ 窗口高度不固定：字号 / 行数 / 工具条大小变了之后由 lyric.js 量完回报（lyric:resize）。
//    ④ 鼠标穿透（clickThrough）开启后，点击会穿到下面的软件，
//       此时悬浮窗自己收不到点击 —— 所以关闭穿透的入口只能放在主窗口。
//    ⑤ 拖动由主进程跟着光标做（startLyricDrag）：整段拖动只通信两次，
//       逐帧走 IPC 会让拖动一卡一卡。
// ============================================================

let lyricWindow = null;

const LYRIC_W = 640;    // 悬浮窗宽度（高度按内容算）
const LYRIC_MIN_H = 56; // 高度下限，防止字号调到最小时窗口被压成一条线

/** 存档里的坐标还在不在某个显示器的可视范围内（换过显示器 / 改过分辨率就会失效） */
function lyricPosUsable(x, y, w, h) {
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // 至少要露出右上角一小块，别整个飘到屏幕外面去
    return x >= a.x - w + 60 && x <= a.x + a.width - 60 &&
           y >= a.y - h + 24 && y <= a.y + a.height - 24;
  });
}

/** 默认位置：主显示器工作区底部居中、任务栏上方一点 */
function lyricDefaultBounds() {
  const a = screen.getPrimaryDisplay().workArea;
  const w = Math.min(LYRIC_W, Math.round(a.width * 0.6));
  const h = 104;
  return { x: a.x + Math.round((a.width - w) / 2), y: a.y + a.height - h - 56, w, h };
}

/** 往悬浮窗发消息（窗口可能已经关了，所以每次都要判一下） */
function pushToLyric(channel, payload) {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  try { lyricWindow.webContents.send(channel, payload); } catch (_) { /* 窗口正在关闭，忽略 */ }
}

/* ---- 拖动：由主进程跟着光标走 ----
   为什么不让悬浮窗自己逐帧算：那样鼠标每动一下都要走一趟
   "渲染进程算 → IPC → 主进程挪窗口"，鼠标快的时候一秒钟几十上百趟，就成了"一卡一卡"。
   改成：开始拖的时候算一次"光标相对窗口左上角的偏移"，之后每 16 毫秒读一次真实光标位置，
   直接 setBounds —— 整段拖动只有开始 / 结束两次通信，中间一帧都不过 IPC。 */
let lyricDragOffset = null;   // 光标相对窗口左上角的偏移
let lyricDragSize = null;     // 开始拖那一刻的窗口尺寸（整段拖动里不会变，先记住省得每帧再问系统）
let lyricDragLast = null;     // 上一次设过去的位置（没变就不再去动窗口）
let lyricDragTimer = null;    // 跟随用的定时器
let lyricDragDeadline = 0;    // 安全绳

function startLyricDrag() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = lyricWindow.getBounds();
  lyricDragOffset = { x: p.x - b.x, y: p.y - b.y };
  lyricDragSize = { w: b.width, h: b.height };
  lyricDragLast = { x: b.x, y: b.y };
  lyricDragDeadline = Date.now() + 15000;   // 万一"拖完"那句没收到，15 秒后自动松手
  if (lyricDragTimer) return;
  lyricDragTimer = setInterval(() => {
    if (!lyricWindow || lyricWindow.isDestroyed()) { stopLyricDrag(); return; }
    if (!lyricDragOffset || Date.now() > lyricDragDeadline) {
      stopLyricDrag();
      scheduleLyricPosNotify();
      return;
    }
    const cur = screen.getCursorScreenPoint();
    const x = Math.round(cur.x - lyricDragOffset.x);
    const y = Math.round(cur.y - lyricDragOffset.y);
    if (x === lyricDragLast.x && y === lyricDragLast.y) return;   // 没动就别白干活
    lyricDragLast = { x, y };
    lyricWindow.setBounds({ x, y, width: lyricDragSize.w, height: lyricDragSize.h }, false);
  }, 16);
}

function stopLyricDrag() {
  if (lyricDragTimer) { clearInterval(lyricDragTimer); lyricDragTimer = null; }
  lyricDragOffset = null;
  lyricDragSize = null;
  lyricDragLast = null;
}

/* 窗口位置变了 → 隔 140 毫秒再把最终坐标告诉主窗口去存档。
   为什么不等每次挪动都发：拖动时窗口每 16 毫秒动一下，
   每次都发消息 + 每次都写盘，光这一项就能把拖动拖慢。 */
let lyricPosTimer = null;
function scheduleLyricPosNotify() {
  clearTimeout(lyricPosTimer);
  lyricPosTimer = setTimeout(() => {
    lyricPosTimer = null;
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [x, y] = lyricWindow.getPosition();
    try { mainWindow.webContents.send('lyric:moved', { x, y }); } catch (_) { /* 忽略 */ }
  }, 140);
}

/* 最后一次推过去的样式和歌词。
   为什么要存：窗口刚创建时页面还没跑完脚本，这时候发过去的消息会被丢掉 ——
   等页面自己加载好了（did-finish-load）再补发一次，就不会出现"开着却是默认字号"。 */
let lastLyricStyle = null;
let lastLyricData = null;

function createLyricWindow(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    pushToLyric('lyric:style', o);   // 已经开着了，只更新样式
    return;
  }

  const fb = lyricDefaultBounds();
  const useSaved = lyricPosUsable(o.x, o.y, fb.w, 104);

  lyricWindow = new BrowserWindow({
    x: useSaved ? Math.round(o.x) : fb.x,
    y: useSaved ? Math.round(o.y) : fb.y,
    width: fb.w,
    height: fb.h,
    frame: false,            // 无边框
    transparent: true,       // 背景透明，才只有字没有框
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,       // 不在任务栏里再占一个图标
    resizable: false,
    hasShadow: false,
    title: '桌面歌词',
    webPreferences: {
      preload: path.join(__dirname, 'preload-lyric.js'),  // 它有自己的传话筒
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // 用更高一级的置顶：普通 alwaysOnTop 会被全屏程序盖住
  lyricWindow.setAlwaysOnTop(true, 'screen-saver');
  lyricWindow.loadFile(path.join(__dirname, 'ui', 'lyric.html'));

  // 位置变了（拖动中会连续触发）→ 防抖后再告诉主窗口存档
  lyricWindow.on('moved', () => scheduleLyricPosNotify());

  lyricWindow.on('closed', () => { stopLyricDrag(); lyricWindow = null; });
  // 拖到一半窗口被抢走焦点（比如误按 Alt+Tab）就松手，不然它会一直黏着光标
  lyricWindow.on('blur', () => stopLyricDrag());

  // 页面画好了再亮相，避免闪一下白块
  lyricWindow.once('ready-to-show', () => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    pushToLyric('lyric:style', o);
    if (o.clickThrough) lyricWindow.setIgnoreMouseEvents(true, { forward: true });
    lyricWindow.show();
  });

  // 页面脚本跑完了：把之前可能丢掉的消息补发一遍
  lyricWindow.webContents.once('did-finish-load', () => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    pushToLyric('lyric:style', lastLyricStyle || o);
    if (lastLyricData) pushToLyric('lyric:data', lastLyricData);
  });
}

function closeLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.close();
}

// ============================================================
//  第 5 部分：启动
// ============================================================
app.whenReady().then(() => {
  // 告诉 Electron 这个应用本身是"深色"的。
  // 这样滚动条、右键菜单、系统弹窗这些"系统画的东西"也会跟着变深色，
  // 不会突然冒出一块刺眼的白色。我们没有浅色主题，所以写死 dark 就行。
  nativeTheme.themeSource = 'dark';

  // 如果用户之前填过 Cookie，启动时就装上
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      bili.setUserCookie(fs.readFileSync(COOKIE_FILE, 'utf8'));
    }
  } catch (e) {
    /* 没填过就跳过 */
  }

  // 先把本地歌曲库的白名单和下载设置装好 —— local:// 协议从**第一次请求**起就要能判断，
  // 不能等界面来调 store:load（那时候可能已经有人在播本地歌了，会被误判成 403）。
  try {
    refreshLibraryCache(migrate(readDataFile() || DEFAULT_DATA, { bgDir: BG_DIR }));
  } catch (err) {
    console.error('[启动] 预读本地歌曲库失败，按空库处理：', err.message);
    refreshLibraryCache(null);
  }
  // 接管上次没下完的任务：downloading / queued 一律先落成"已暂停"，
  // 等用户点继续 —— 不能一开机就自动放出一堆请求（B 站会限流）。
  try { downloader.adopt(readDownloadsFile()); } catch (_) {}

  registerBiliProtocol();
  registerBgProtocol(BG_DIR);
  registerLocalProtocol({ getWhitelist: () => localWhitelist, coversDir: COVERS_DIR });
  registerHandlers();
  createWindow();

  // ---- v2.2.0：托盘 / 任务栏缩略图按钮 / 任务栏右键任务 ----
  // 都必须在窗口建好之后 —— 它们要挂在 mainWindow 上（托盘除外，但菜单里要显示歌名）
  createTray();
  refreshThumbar();
  refreshUserTasks();

  // Windows 上点 Dock/任务栏图标重新打开窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出前把托盘图标销毁，否则它会**残留在托盘里**，直到鼠标划过去才消失
// （这条是从参考项目 biu 学来的，见 docs/参考实现研究-biu.md §2.5）
app.on('will-quit', () => {
  // 退出前把下载收干净：进行中的一律落成"已暂停"（保留 .part，下次能接着下），
  // 并把任务状态强制写一次盘 —— 平时是攒 1.5 秒写的，退出时不补这一下就会丢最近的进度。
  try {
    downloader.stopAll();
    saveDownloadsNow();
  } catch (err) {
    console.error('[退出] 收尾下载任务失败：', err.message);
  }
  destroyTray();
});

// 除了 macOS，其他系统关闭所有窗口就退出程序。
// ★ 注意：选「缩小到任务栏」时窗口是 hide() 而不是 close()，
//   所以这里**不会**被触发、app.quit() 也不会被调用 —— 后台播放正是靠这一点。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
