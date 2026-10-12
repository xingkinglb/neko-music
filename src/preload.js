/**
 * ============================================================
 *  preload.js —— 安全的"传话筒"
 * ============================================================
 *  网页（界面）本身没有权限访问网络和硬盘，
 *  它只能通过这里暴露出来的一组函数，去请主进程帮忙办事。
 *  这种机制叫 IPC（进程间通信）。
 * ============================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neko', {
  // ---------- B 站相关 ----------
  // 把用户粘贴的链接/ BV 号解析成标准格式
  parse: (text) => ipcRenderer.invoke('bili:parse', text),

  // 查视频详情（标题、分P、合集）
  videoInfo: (bvid) => ipcRenderer.invoke('bili:videoInfo', bvid),

  // 按关键词搜索
  search: (keyword, page) => ipcRenderer.invoke('bili:search', keyword, page),

  // 拿到某个视频的音频流地址（返回的是 bili:// 开头的内部地址）
  audioUrl: (bvid, cid) => ipcRenderer.invoke('bili:audioUrl', bvid, cid),

  // 列出某 UP 主的收藏夹
  favFolders: (mid) => ipcRenderer.invoke('bili:favFolders', mid),

  // 读取收藏夹里的视频
  favMedias: (mediaId, pn) => ipcRenderer.invoke('bili:favMedias', mediaId, pn),

  // 某个 UP 主公开的投稿视频（点作者名 → 看他的全部视频）
  upVideos: (mid, pn) => ipcRenderer.invoke('bili:upVideos', mid, pn),

  // ---------- 设置 ----------
  // 填写自己的 B 站登录 Cookie（填了能大幅减少"被限流"）
  cookieGet: () => ipcRenderer.invoke('cookie:get'),
  cookieSet: (text) => ipcRenderer.invoke('cookie:set', text),

  // ---------- 外观 ----------
  // 弹出系统文件选择框，让用户挑一张背景图（内部会复制到应用目录）
  pickBackground: () => ipcRenderer.invoke('bg:pick', 'image'),

  // 弹框挑一段视频当动态背景
  pickVideoBackground: () => ipcRenderer.invoke('bg:pick', 'video'),

  // 清掉已选的背景（图片或视频）
  clearBackground: () => ipcRenderer.invoke('bg:clear'),

  // ---------- 窗口控制（右上角自绘按钮） ----------
  // 这三个按钮是界面自己画的 HTML 按钮，点一下就发个"请主进程帮忙"的消息。
  winMin:   () => ipcRenderer.send('win-min'),     // 最小化
  winMax:   () => ipcRenderer.send('win-max'),     // 最大化 / 还原（切换）
  winClose: () => ipcRenderer.send('win-close'),   // 请求关闭（主进程会先等待本地数据保存完成）
  closeReady: (ok) => ipcRenderer.send('win:close-ready', !!ok),
  onPrepareClose: (cb) => ipcRenderer.on('win:prepare-close', () => cb()),

  // 主进程告诉我们窗口现在是被最大化还是还原了（双击标题栏也会触发），
  // 界面收到后用它来切换"最大化 / 还原"图标。
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, maximized) => cb(!!maximized)),

  // F11 全屏切换（网页自己没法直接进全屏，得请主进程帮忙）
  setFullScreen: (flag) => ipcRenderer.send('win:fullscreen', !!flag),

  // ---------- mini 模式（v2.1.0） ----------
  // 请主进程把窗口缩成"一条小窗"（on=true，expanded 表示要不要展开队列列表），
  // 或还原成进 mini 之前的大小和位置（on=false）。
  // 布局那一半由界面自己加/去 body.mini 类完成，这里只管窗口本身。
  winMini: (on, expanded) => ipcRenderer.send('win:mini', { on: !!on, expanded: !!expanded }),

  // 主进程回推"现在是不是 mini / 展没展开"，界面据此切换按钮和 ☰ 的行为
  onWinMiniState: (cb) => ipcRenderer.on('win:mini-state', (_e, st) => cb(st || {})),

  // 完整模式下窗口被拖动 / 缩放后，主进程把新位置尺寸送回来存档
  // （下次打开就能回到上次那样的大小和位置）
  onWinBounds: (cb) => ipcRenderer.on('win:bounds', (_e, b) => cb(b || {})),

  // ---------- 字幕 / 歌词 ----------
  // 取某个视频（某一 P）的字幕，返回 [{t: 开始秒数, text: 一句话}]
  subtitle: (bvid, cid) => ipcRenderer.invoke('bili:subtitle', bvid, cid),

  // 有没有填 B 站 Cookie（取字幕的前提，没填直接省掉一次白跑的请求）
  hasCookie: () => ipcRenderer.invoke('bili:hasCookie'),

  // 用系统默认浏览器打开一个网址。
  // 网页自己没法调系统浏览器，必须请主进程用系统的 shell 打开。
  // 安全上只允许 http/https，主进程会再校验一次，防止被拿去打开本地文件。
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // ---------- 桌面歌词（独立置顶小窗） ----------
  // 打开那个浮在桌面上的歌词窗（opts 里带字号、位置、是否穿透等设置）
  lyricOpen:    (opts) => ipcRenderer.send('lyric:open', opts),

  // 关掉它
  lyricClose:   () => ipcRenderer.send('lyric:close'),

  // 把歌词和播放进度推给悬浮窗（换歌 / 跳转 / 播放中每 250 毫秒各推一次）
  lyricPush:    (data) => ipcRenderer.send('lyric:push', data),

  // 推送样式：字号 / 不透明度 / 行数 / 主题色
  lyricStyle:   (style) => ipcRenderer.send('lyric:style', style),

  // 鼠标穿透：开启后点歌词会穿到下面的软件上。
  // 关闭入口只能放在主窗口 —— 开启后悬浮窗自己收不到点击，关不掉自己。
  lyricThrough: (on) => ipcRenderer.send('lyric:through', !!on),

  // 悬浮窗上那排按钮发来的命令（prev / toggle / next / font / lock / close）
  onLyricCmd:   (cb) => ipcRenderer.on('lyric:cmd', (_e, cmd, arg) => cb(cmd, arg)),

  // 悬浮窗被拖动后，主进程把新坐标送回来存档
  onLyricMoved: (cb) => ipcRenderer.on('lyric:moved', (_e, pos) => cb(pos)),

  // ---------- 本地存档 ----------
  // 读取整个数据库（歌单、收藏、历史）
  loadData: () => ipcRenderer.invoke('store:load'),

  // 保存整个数据库
  saveData: (data) => ipcRenderer.invoke('store:save', data),
});
