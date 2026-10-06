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

const { app, BrowserWindow, ipcMain, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./bilibili');

// app.getPath('userData') 是系统给我们分配的专用文件夹，
// 比如 C:\Users\Neo\AppData\Roaming\neko-music
const DATA_FILE = path.join(app.getPath('userData'), 'neko-data.json');
// 用户自己填的 B 站登录 Cookie（可选，填了搜索会更稳）
const COOKIE_FILE = path.join(app.getPath('userData'), 'cookie.txt');

let mainWindow = null;

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
//  第 2 部分：创建窗口
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Neko Music',
    backgroundColor: '#12121c', // 窗口还没画出来时的底色，避免白闪
    autoHideMenuBar: true,       // 隐藏顶部菜单栏，更清爽
    show: false,                 // 等页面准备好再显示，避免白屏闪烁
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

  // 开发时方便调试：按 F12 打开开发者工具
  // 正式发布时可以把这段删掉
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });

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
};

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
      return { ok: false, error: err.message || String(err) };
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

  handle('store:load', () => readDataFile() || DEFAULT_DATA);
  handle('store:save', (data) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  });
}

// ============================================================
//  第 5 部分：启动
// ============================================================
app.whenReady().then(() => {
  // 如果用户之前填过 Cookie，启动时就装上
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      bili.setUserCookie(fs.readFileSync(COOKIE_FILE, 'utf8'));
    }
  } catch (e) {
    /* 没填过就跳过 */
  }

  registerBiliProtocol();
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
