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
const calls = { add: [], pickDir: 0, setDir: [], remove: [], reveal: 0 };

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

  /* ★ 删除类必须**真的改任务表**：回个 true 就完事的话，界面删完再拉一次列表
     拿到的还是原来那两条 —— "删掉之后绿勾消失"这类断言就永远测不出来（假通过）。 */
  ipcMain.handle('download:remove', (_e, ids, del) => {
    const list = Array.isArray(ids) ? ids : [ids];
    calls.remove.push([list, del]);
    for (const id of list) {
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    }
    return { ok: true, data: true };
  });
  ipcMain.handle('download:clearFinished', () => {
    let removed = 0;
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].status === 'done') { tasks.splice(i, 1); removed++; }
    }
    return { ok: true, data: { removed } };
  });

  // 其余都是"发指令"型：离屏测试不关心主进程真去下什么，回个成功即可。
  ['download:pause', 'download:resume', 'download:retry', 'download:cancel',
   'download:openDir'].forEach((ch) => {
    ipcMain.handle(ch, () => ({ ok: true, data: true }));
  });
  /* ★ reveal 单列：问题 A 要断言"文件在时点绿勾 = 开文件夹；文件不在时 = 不开，改重下"，
     所以得数它被调了几次。 */
  ipcMain.handle('download:reveal', () => {
    calls.reveal++;
    return { ok: true, data: true };
  });

  // 本地歌曲那三个（批次 B 会用到，先一起桩上，免得下次又要回来改一遍）
  // ★ 返回要包成 { ok:true, data } —— 界面 api() 解的就是这层壳（真实 main.js 的
  //   handle() 也这么包）；返回裸值会被 api() 当成失败。
  ipcMain.handle('local:pickFiles', () => ({ ok: true, data: null }));
  ipcMain.handle('local:pickFolder', () => ({ ok: true, data: null }));
  /* ★ local:stat 默认"文件都在"。但问题 A 要测"外部把文件删了"，
     所以给一个**可切换开关**：测试里 `setLocalMissing(true)` → 一律回 exists:false。
     用开关而不是让每个测试各写一份 handler：改一处就够了，别的测试也不受影响。 */
  ipcMain.handle('local:stat', (_e, paths) => ({
    ok: true,
    data: (Array.isArray(paths) ? paths : []).map((p) => ({
      path: p,
      exists: !module.exports.localMissing,
      size: module.exports.localMissing ? 0 : 4211000,
    })),
  }));
};

/* 测试用开关：true = 所有本地文件都"不存在"（模拟外部删除） */
module.exports.localMissing = false;
module.exports.setLocalMissing = (v) => { module.exports.localMissing = !!v; };

module.exports.calls = calls;
