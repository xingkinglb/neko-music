/**
 * ============================================================
 *  preload-lyric.js —— 桌面歌词悬浮窗的"传话筒"
 * ============================================================
 *  这个窗口只做一件事：把主窗口推过来的歌词画出来。
 *  它不能自己联网、不能读硬盘，只能：
 *    · 收主进程转发过来的歌词与样式（onData / onStyle）
 *    · 把自己身上的操作发回去（cmd）
 *    · 量完自己的高度回报给主进程，好让窗口跟着字号变高变矮（resize）
 *    · 开始拖动 / 结束拖动时各喊一声（dragStart / dragEnd）
 *
 *  单独给它一个传话筒（而不是复用 preload.js），是为了让它拿到的权限最小 ——
 *  拿不到存档、拿不到网络，就算哪天页面被注入了怪东西，也碰不到你的数据。
 * ============================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyric', {
  // 收到新歌词 / 新的播放进度
  onData:  (cb) => ipcRenderer.on('lyric:data', (_e, data) => cb(data)),

  // 收到新的样式（字号 / 不透明度 / 行数 / 工具条大小 / 底板 / 主题色 / 是否锁定）
  onStyle: (cb) => ipcRenderer.on('lyric:style', (_e, style) => cb(style)),

  // 拖动：进入拖动 / 结束拖动时各喊一声，中间的移动由主进程自己跟着光标做
  //（每次挪动都来回通信的话，鼠标快的时候会一卡一卡 —— 这是之前卡顿的原因）
  dragStart: () => ipcRenderer.send('lyric:drag-start'),
  dragEnd:   () => ipcRenderer.send('lyric:drag-end'),

  // 把悬浮窗上的操作发回主窗口：prev / toggle / next / font / lock / close
  cmd:     (name, arg) => ipcRenderer.send('lyric:cmd', name, arg),

  // 告诉主进程"我现在这么高"，让它调整窗口高度
  resize:  (h) => ipcRenderer.send('lyric:resize', h),
});
