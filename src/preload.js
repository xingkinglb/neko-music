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

  // ---------- 本地存档 ----------
  // 读取整个数据库（歌单、收藏、历史）
  loadData: () => ipcRenderer.invoke('store:load'),

  // 保存整个数据库
  saveData: (data) => ipcRenderer.invoke('store:save', data),
});
