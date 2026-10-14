/* v2.8.0：下载 / 本地歌曲那两组 IPC 的**公共桩**。
 *
 * 为什么需要它：渲染层启动时会走 `rebuildDlKeys()` + `refreshDownloads()`，
 * 也就是一定会打一次 `download:list`。而每个离屏测试脚本都是**自己的 Electron 主进程**，
 * 只注册自己关心的那几个 handler —— 不打这个桩，控制台就会挂一条
 * "No handler registered for 'download:list'"。
 *
 * ★ 这条报错最坑的地方：好几个脚本（test-keys / round13-16）会把"页面有报错"
 *   直接判成 FAIL。于是**桩缺了**会被当成**产品坏了** —— 一眼看不出区别。
 *   所以这里统一收口，谁要跑离屏测试就 require 一下，别再各写一份。
 *
 * 用法（必须在 app.whenReady() 之前调用）：
 *   require('./stub-download-ipc.js')();                       // 空任务表
 *   require('./stub-download-ipc.js')({ tasks, dir: 'C:\\x' }); // 指定数据
 */
const { ipcMain } = require('electron');

function computeStats(tasks) {
  const st = { done: 0, running: 0, failed: 0, queued: 0, paused: 0, bytes: 0, total: tasks.length };
  for (const t of tasks) {
    if (t.status === 'done')             { st.done++;    st.bytes += t.received || 0; }
    else if (t.status === 'downloading') { st.running++; st.bytes += t.received || 0; }
    else if (t.status === 'failed')      st.failed++;
    else if (t.status === 'paused')      { st.paused++;  st.bytes += t.received || 0; }
    else if (t.status === 'queued')      st.queued++;
  }
  return st;
}

/**
 * 调用记录。测试可以拿它断言"界面确实把指令发出去了"——
 * 光断言"按钮点得动"是不够的，真正要守住的是"点了以后主进程收到了正确的曲目"。
 * 形状：{ add: Array<曲目数组>, pickDir: number, setDir: Array<目录>, remove: Array<[ids, deleteFile]> }
 */
const calls = { add: [], pickDir: 0, setDir: [], remove: [] };

module.exports = function stubDownloadIpc(opts = {}) {
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const dir = opts.dir === undefined ? null : opts.dir;

  ipcMain.handle('download:list', () => ({
    ok: true,
    data: { tasks, stats: computeStats(tasks), dir },
  }));
  ipcMain.handle('download:pickDir', () => {
    calls.pickDir++;
    return { ok: true, data: dir ? { dir } : null };
  });

  /* download:add 要回**真实形状**（added / skipped / duplicates / needDir）——
     回一个 true 的话，界面那句 `if (res.added) currentView = 'downloads'` 永远不成立，
     测试就测不出"加进去之后跳去下载管理"这一步。 */
  ipcMain.handle('download:add', (_e, tracks) => {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    calls.add.push(list);
    return { ok: true, data: { added: list.length, skipped: 0, duplicates: 0, needDir: false } };
  });
  ipcMain.handle('download:setDir', (_e, d) => { calls.setDir.push(d); return { ok: true, data: true }; });
  ipcMain.handle('download:remove', (_e, ids, del) => { calls.remove.push([ids, del]); return { ok: true, data: true }; });

  // 其余都是"发指令"型：离屏测试不关心主进程真去下什么，回个成功即可。
  ['download:pause', 'download:resume', 'download:retry', 'download:cancel',
   'download:clearFinished', 'download:openDir', 'download:reveal'].forEach((ch) => {
    ipcMain.handle(ch, () => ({ ok: true, data: true }));
  });

  // 本地歌曲那三个（批次 B 会用到，先一起桩上，免得下次又要回来改一遍）
  ipcMain.handle('local:pickFiles', () => ({ ok: true, data: null }));
  ipcMain.handle('local:pickFolder', () => ({ ok: true, data: null }));
  ipcMain.handle('local:stat', (_e, paths) => ({
    ok: true,
    data: (Array.isArray(paths) ? paths : []).map((p) => ({ path: p, exists: true, size: 0 })),
  }));
};

module.exports.calls = calls;
