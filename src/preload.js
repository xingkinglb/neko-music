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

  // ---------- 设置 ----------
  // 填写自己的 B 站登录 Cookie（填了能大幅减少"被限流"）
  cookieGet: () => ipcRenderer.invoke('cookie:get'),
  cookieSet: (text) => ipcRenderer.invoke('cookie:set', text),

  // ---------- 外观 ----------
  // 弹出系统文件选择框，让用户挑一张背景图（内部会复制到应用目录）
  pickBackground: () => ipcRenderer.invoke('bg:pick'),

  // 清掉已选的背景图
  clearBackground: () => ipcRenderer.invoke('bg:clear'),

  // ---------- 窗口控制（右上角自绘按钮） ----------
  // 这三个按钮是界面自己画的 HTML 按钮，点一下就发个"请主进程帮忙"的消息。
  winMin:   () => ipcRenderer.send('win-min'),     // 最小化
  winMax:   () => ipcRenderer.send('win-max'),     // 最大化 / 还原（切换）
  winClose: () => ipcRenderer.send('win-close'),   // 关闭

  // 主进程告诉我们窗口现在是被最大化还是还原了（双击标题栏也会触发），
  // 界面收到后用它来切换"最大化 / 还原"图标。
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, maximized) => cb(!!maximized)),

  // F11 全屏切换（网页自己没法直接进全屏，得请主进程帮忙）
  setFullScreen: (flag) => ipcRenderer.send('win:fullscreen', !!flag),

  // ---------- 字幕 / 歌词 ----------
  // 取某个视频（某一 P）的字幕，返回 [{t: 开始秒数, text: 一句话}]
  subtitle: (bvid, cid) => ipcRenderer.invoke('bili:subtitle', bvid, cid),

  // 有没有填 B 站 Cookie（取字幕的前提，没填直接省掉一次白跑的请求）
  hasCookie: () => ipcRenderer.invoke('bili:hasCookie'),

  // ---------- 本地存档 ----------
  // 读取整个数据库（歌单、收藏、历史）
  loadData: () => ipcRenderer.invoke('store:load'),

  // 保存整个数据库
  saveData: (data) => ipcRenderer.invoke('store:save', data),
});
