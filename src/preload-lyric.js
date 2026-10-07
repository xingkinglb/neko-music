/**
 * ============================================================
 *  preload-lyric.js —— 桌面歌词悬浮窗的"传话筒"
 * ============================================================
 *  这个窗口只做一件事：把主窗口推过来的歌词画出来。
 *  它不能自己联网、不能读硬盘，只能：
 *    · 收主进程转发过来的歌词与样式（onData / onStyle）
 *    · 把自己身上的操作发回去（cmd）
 *    · 量完自己的高度回报给主进程，好让窗口跟着字号变高变矮（resize）
 *
 *  单独给它一个传话筒（而不是复用 preload.js），是为了让它拿到的权限最小 ——
 *  拿不到存档、拿不到网络，就算哪天页面被注入了怪东西，也碰不到你的数据。
 * ============================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyric', {
  // 收到新歌词 / 新的播放进度
  onData:  (cb) => ipcRenderer.on('lyric:data', (_e, data) => cb(data)),

  // 收到新的样式（字号 / 不透明度 / 行数 / 主题色 / 是否锁定）
  onStyle: (cb) => ipcRenderer.on('lyric:style', (_e, style) => cb(style)),

  // 主进程把窗口当前位置同步过来（拖动要靠它算偏移量）
  onPos:   (cb) => ipcRenderer.on('lyric:pos', (_e, pos) => cb(pos)),

  // 拖动中：把算好的新位置交给主进程去移动窗口
  move:    (x, y) => ipcRenderer.send('lyric:move', Math.round(x), Math.round(y)),

  // 把悬浮窗上的操作发回主窗口：prev / toggle / next / font / lock / close
  cmd:     (name, arg) => ipcRenderer.send('lyric:cmd', name, arg),

  // 告诉主进程"我现在这么高"，让它调整窗口高度
  resize:  (h) => ipcRenderer.send('lyric:resize', h),
});
