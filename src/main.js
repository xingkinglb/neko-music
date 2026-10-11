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

const { app, BrowserWindow, ipcMain, protocol, net, dialog, nativeTheme, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./bilibili');

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

let mainWindow = null;
let closeInProgress = false;
let allowCloseOnce = false;
let closeTimeout = null;

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
      stream: true,          // 为将来支持"视频背景"预留
      secure: true,
      corsEnabled: true,
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

function createWindow() {
  closeInProgress = false;
  allowCloseOnce = false;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Neko Music',
    backgroundColor: '#12121c', // 窗口还没画出来时的底色，避免白闪
    autoHideMenuBar: true,       // 隐藏顶部菜单栏，更清爽
    show: false,                 // 等页面准备好再显示，避免白屏闪烁

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
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // 页面渲染完成后再亮相
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 所有关闭方式（自绘按钮、系统窗口按钮、Alt+F4）都先请求渲染进程 flush 存档。
  mainWindow.on('close', (event) => {
    if (allowCloseOnce) { allowCloseOnce = false; return; }
    event.preventDefault();
    requestMainWindowClose();
  });

  // 主窗口关掉时，悬浮歌词也要一起关（不然会剩一个孤零零的窗口挂在桌面上）
  mainWindow.on('closed', () => { closeLyricWindow(); });

  // 窗口被最大化 / 还原时，通知界面，让"最大化"按钮切换成"还原"图标。
  // （双击标题栏最大化、拖到顶部最大化，都会触发这里。）
  mainWindow.on('maximize',   () => { try { mainWindow.webContents.send('win:state', true);  } catch (_) {} });
  mainWindow.on('unmaximize', () => { try { mainWindow.webContents.send('win:state', false); } catch (_) {} });

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

const DEFAULT_DATA = {
  playlists: [],  // 歌单列表，每个歌单里有 tracks
  favorites: [],  // 我喜欢的
  history: [],    // 最近播放
  lastTrack: null,// 上次听到的歌（下次打开可以接着播）
  settings: {     // 外观与习惯（新增）
    theme: 'pink',   // pink / violet / green / amber / cyan
    volume: 80,      // 音量记忆，0-100
    bg:    { file: null, dim: 0.55, blur: 0 },  // 背景图文件名 / 压暗程度 / 额外模糊
    glass: { blur: 18, alpha: 0.55 },           // 毛玻璃：模糊半径 / 不透明度
    autoLyric: false,   // 自动加载歌词（默认关，可手动点「词」）
  },
};

const THEMES = ['pink', 'violet', 'green', 'amber', 'cyan'];

/**
 * 存档"补洞"。
 * 老版本的存档里没有 settings 字段，直接读进来会让界面取到 undefined。
 * 这个函数保证不管多老的存档，读出来都是结构完整的 —— 老数据一条都不会丢。
 */
function migrate(data) {
  const d = (data && typeof data === 'object') ? data : {};
  d.playlists = Array.isArray(d.playlists) ? d.playlists : [];
  d.favorites = Array.isArray(d.favorites) ? d.favorites : [];
  d.history   = Array.isArray(d.history)   ? d.history   : [];
  d.lastTrack = d.lastTrack || null;

  const old = (d.settings && typeof d.settings === 'object') ? d.settings : {};
  const s = {
    theme:  THEMES.includes(old.theme) ? old.theme : 'pink',
    volume: (typeof old.volume === 'number' && old.volume >= 0 && old.volume <= 100) ? old.volume : 80,
    bg:    Object.assign({ file: null, dim: 0.55, blur: 0 }, old.bg || {}),
    glass: Object.assign({ blur: 18, alpha: 0.55 }, old.glass || {}),
    autoLyric: typeof old.autoLyric === 'boolean' ? old.autoLyric : false,
  };

  // 背景图如果已经不在硬盘上（比如换过电脑、清过缓存），就悄悄置空，别留个裂图
  if (s.bg.file) {
    const ok = /^[\w.\-]+$/.test(s.bg.file) && fs.existsSync(path.join(BG_DIR, s.bg.file));
    if (!ok) s.bg.file = null;
  }

  d.settings = s;
  return d;
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
    return migrate(saved || DEFAULT_DATA);
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
  ipcMain.on('win-close', () => requestMainWindowClose());
  ipcMain.on('win:close-ready', (_event, ok) => finishMainWindowClose(!!ok));
  ipcMain.on('win:fullscreen', (flag) => { if (mainWindow) mainWindow.setFullScreen(!!flag); });

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

  registerBiliProtocol();
  registerBgProtocol(BG_DIR);
  registerHandlers();
  createWindow();

  // Windows 上点 Dock/任务栏图标重新打开窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 除了 macOS，其他系统关闭所有窗口就退出程序
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
