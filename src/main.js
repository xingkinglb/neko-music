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

const { app, BrowserWindow, ipcMain, protocol, net, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./bilibili');

// app.getPath('userData') 是系统给我们分配的专用文件夹，
// 比如 C:\Users\Neo\AppData\Roaming\neko-music
const DATA_FILE = path.join(app.getPath('userData'), 'neko-data.json');
// 用户自己填的 B 站登录 Cookie（可选，填了搜索会更稳）
const COOKIE_FILE = path.join(app.getPath('userData'), 'cookie.txt');

// ---- 自定义背景 ----
// 用户选的图片会被"复制"到这个专属目录里，而不是直接引用原图。
// 这样你把原图删了、移动了，背景也不会变成裂图。
const BG_DIR = path.join(app.getPath('userData'), 'backgrounds');
const BG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

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
//  第 1.5 部分：bg:// 协议 —— 背景图片的"专用取件窗口"
// ============================================================
//  只允许读取 backgrounds/ 目录里的文件。两道安全闸缺一不可：
//   ① 文件名必须是纯字母数字（挡掉 ".."、"\"、斜杠这类路径穿越写法）
//   ② 拼出来的绝对路径必须还在 BG_DIR 里面（挡掉符号链接之类的逃逸）
function registerBgProtocol() {
  protocol.handle('bg', async (request) => {
    try {
      const u = new URL(request.url);
      const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));

      if (!/^[\w.\-]+$/.test(name)) {
        return new Response('文件名不合法', { status: 400 });
      }

      const file = path.resolve(BG_DIR, name);
      if (!file.startsWith(BG_DIR + path.sep)) {
        return new Response('越界访问被拒绝', { status: 403 });
      }
      if (!fs.existsSync(file)) {
        return new Response('背景图不存在', { status: 404 });
      }

      const buf = fs.readFileSync(file);
      const type = BG_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(buf.length) },
      });
    } catch (err) {
      console.error('[bg协议] 读取背景图失败：', err);
      return new Response(String(err), { status: 500 });
    }
  });
}

/** 清空 backgrounds 目录（换背景时调用，避免旧图越堆越多） */
function clearBgDir() {
  try {
    if (!fs.existsSync(BG_DIR)) return;
    for (const f of fs.readdirSync(BG_DIR)) {
      const p = path.join(BG_DIR, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('清理背景目录失败：', err);
  }
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

    // ★ 干掉窗口最上面那圈"白边"。
    //   那圈白边是 Windows 自带的标题栏，它的颜色跟着系统是浅色还是深色走，
    //   CSS 完全够不着它 —— 所以只能整条藏掉，换成网页里自己画的深色标题栏
    //   （见 index.html 里的 .titlebar）。
    //   'hidden' 的意思是：窗口边框、拖动、缩放这些系统能力都还在，
    //   只是标题栏那一条不画了，交给我们自己画。
    titleBarStyle: 'hidden',
    // 让 Windows 把 最小化 / 最大化 / 关闭 三个按钮画在右上角，
    // 并且用我们指定的深色，而不是系统的白色。
    titleBarOverlay: {
      color: '#12121c',        // 三个按钮所在那块方块的底色（跟界面底色一致，接缝就看不出来）
      symbolColor: '#e6e6f2',  // 按钮里那几条符号（横杠/方框/叉）的颜色
      height: 38,              // ★ 必须和 CSS 里的 --titlebar-h 一模一样，否则会对不齐
    },
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
  settings: {     // 外观与习惯（新增）
    theme: 'pink',   // pink / violet / green / amber / cyan
    volume: 80,      // 音量记忆，0-100
    bg:    { file: null, dim: 0.55, blur: 0 },  // 背景图文件名 / 压暗程度 / 额外模糊
    glass: { blur: 18, alpha: 0.55 },           // 毛玻璃：模糊半径 / 不透明度
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

  handle('store:load', () => migrate(readDataFile() || DEFAULT_DATA));

  // 存档写成"原子操作"：先写临时文件，写完了再改名顶替。
  // 这样万一写到一半断电/崩溃，原来的好文件还在，不会出现"存档变空"的惨剧。
  handle('store:save', (data) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    return true;
  });

  // ---- 自定义背景 ----
  // 弹系统文件选择框 → 把选中的图复制到 backgrounds/ → 返回文件名
  handle('bg:pick', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选一张图片当背景',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;

    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!BG_MIME[ext]) return { error: '这个格式不支持，换 png / jpg / webp 吧' };

    const sizeMB = fs.statSync(src).size / 1024 / 1024;
    fs.mkdirSync(BG_DIR, { recursive: true });
    clearBgDir();   // 一次只留一张，避免堆积

    const name = 'bg-' + Date.now().toString(36) + ext;
    fs.copyFileSync(src, path.join(BG_DIR, name));
    return { file: name, sizeMB: Number(sizeMB.toFixed(1)) };
  });

  handle('bg:clear', () => { clearBgDir(); return true; });
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
  registerBgProtocol();
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
