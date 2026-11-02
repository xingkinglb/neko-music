/* v2.12.4 队列记忆实测（离屏 + 真跑应用代码 + 真的读写文件）。
   跑：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/test-round29.js

   ★ 测什么
     用户的原话：「每次关闭软件后歌单队列都清空了，能不能记住上次的列表，
     一打开软件点击播放就可以听歌了。」—— 所以这一份要端到端验三件事：
       ① 切歌之后，队列**真的**写进了磁盘（不是只在内存里）
       ② 重新打开（reload 模拟重启）之后，队列和"停在哪首"都回来了
       ③ 这时候点播放键，真的会去播那一首，而不是弹"先选一首歌吧"

   ★ 为什么用 reload 而不是开第二个进程
     reload 会重新跑一遍 boot()，和开软件走的是同一条路；
     而 IPC / preload 都是现成的，不用再造一套。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const queueStore = require(path.join(ROOT, 'src', 'queue-store.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const say = (m) => console.log(m);

app.disableHardwareAcceleration();

/* 队列落在一个临时文件里，跑完就删 —— 绝不碰用户真实的 queue.json */
const QFILE = path.join(os.tmpdir(), 'neko-test-queue-' + process.pid + '.json');

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
/* ★ 必须包 { ok, data } 信封 —— 界面 api() 解的就是这层壳，返回裸值会被当成失败 */
ipcMain.handle('queue:load', () => ({ ok: true, data: queueStore.load(QFILE) }));
ipcMain.handle('queue:save', (_e, d) => ({ ok: true, data: queueStore.save(QFILE, d) }));
/* 播放要用：给一个假的音频地址，避免真的去连 B 站 */
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', duration: 200, backup: [] } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: { bvid: 'BV0', pages: [{ cid: 0, duration: 200 }], owner: { mid: 1, name: 'x' } } }));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  try { fs.unlinkSync(QFILE); } catch { /* 本来就没有 */ }

  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    /* ★ 离线环境里播放**必然**失败：audioUrl 桩给的是 `bili://get?url=x` 这种假地址，
       真的去解码只会拿到 DOMException。这几条是环境产物，不是产品问题，
       不排掉的话这一项永远红，等于把"页面有报错"这个信号废掉。 */
    if (level >= 2 && !/\[播放失败\]/.test(msg)) errors.push(msg);
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const ev = (code) => win.webContents.executeJavaScript(code);

  /* ================= 1) 切歌之后真的落盘 ================= */
  say('\n[1] 播一首之后，队列有没有写进磁盘：');
  await ev(`(() => {
    queue = { tracks: Array.from({ length: 20 }, (_, i) => ({ bvid: 'BV' + i, cid: i, title: '歌' + i, author: 'UP' + i, duration: 200 })), index: -1, name: '测试队列', source: { view: 'favorites' } };
    playAt(5);
    return true;
  })()`);
  await sleep(1400);   // 防抖 800ms，多等一会儿
  if (!fs.existsSync(QFILE)) {
    bad('切歌之后磁盘上没有队列文件 —— 防抖没触发？');
  } else {
    const d = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
    if (!Array.isArray(d.tracks) || d.tracks.length !== 20) bad(`落盘的曲目数不对：${d.tracks && d.tracks.length}`);
    else if (d.index !== 5) bad(`落盘的 index 不对：${d.index}（期望 5）`);
    else if (d.name !== '测试队列') bad(`落盘的队列名不对：${d.name}`);
    else if ('source' in d) bad('source 也被存进去了（它指向的页面重启后不存在，不该存）');
    else ok(`20 首 + index=5 + 队列名都落盘了，且没存 source（${(fs.statSync(QFILE).size / 1024).toFixed(1)} KB）`);
  }

  /* ================= 2) reload = 重启，队列要回来 ================= */
  say('\n[2] 重新打开之后，队列和"停在哪首"还在不在：');
  win.webContents.reload();
  await sleep(1600);
  const after = await ev(`(() => ({
    len: queue.tracks.length,
    index: queue.index,
    name: queue.name,
    source: queue.source,
    npTitle: document.getElementById('npTitle').textContent,
    hasSrc: !!audio.src,
  }))()`);
  if (after.len !== 20) bad(`重启后队列是 ${after.len} 首（应为 20）`);
  else if (after.index !== 5) bad(`重启后 index 是 ${after.index}（应为 5）`);
  else if (after.name !== '测试队列') bad(`重启后队列名丢了：${after.name}`);
  else ok('20 首 + index=5 + 队列名都恢复了');
  if (after.source !== null) bad(`重启后 source 被恢复成了 ${JSON.stringify(after.source)}（应为 null）`);
  else ok('source 被有意丢弃（定位按钮不会跳去一个不存在的页面）');
  if (after.npTitle !== '歌5') bad(`播放条显示的是「${after.npTitle}」，应为「歌5」`);
  else ok('播放条显示的是队列里停下的那首（歌5）');
  if (after.hasSrc) bad('重启后 audio 已经带着地址了 —— 不该自动加载，会吓一跳');
  else ok('没有自动加载音频（不会一开软件就出声）');

  /* ================= 3) 点播放：直接接着播，不是"先选一首歌" ================= */
  say('\n[3] 这时候点播放键：');
  const play = await ev(`(async () => {
    let toastText = '';
    const origToast = window.toast;
    window.toast = (m) => { toastText = String(m); };
    document.getElementById('btnPlay').click();
    await new Promise((r) => setTimeout(r, 900));
    window.toast = origToast;
    return { toastText, index: queue.index, hasSrc: !!audio.src, npTitle: document.getElementById('npTitle').textContent };
  })()`);
  if (play.toastText.includes('先选一首歌')) bad('点了播放还是弹「先选一首歌吧」—— 队列明明在');
  else if (play.index !== 5) bad(`点播放后播的不是第 5 首（index=${play.index}）`);
  else if (!play.hasSrc) bad('点播放后 audio 还是没地址 —— 没真的去加载');
  else ok('点播放直接接着播「歌5」，没有弹"先选一首歌"');

  /* ================= 4) 清空队列后不留文件 ================= */
  say('\n[4] 清空队列：');
  await ev(`(() => { queue.tracks = []; queue.index = -1; queue.name = ''; saveQueueSoon(); return true; })()`);
  await sleep(1400);
  if (fs.existsSync(QFILE)) bad('清空队列后文件还在（应该删掉）');
  else ok('清空后 queue.json 被删掉，下次启动就是干净的空队列');

  /* ================= 5) 页面报错 ================= */
  say('\n[5] 页面报错：');
  if (errors.length) {
    errors.slice(0, 5).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  try { fs.unlinkSync(QFILE); } catch { /* 已删 */ }

  say(fail === 0 ? '\n队列记忆实测：全部通过 ✅' : `\n队列记忆实测：${fail} 处失败 ❌`);
  fs.writeFileSync(path.join(__dirname, 'test-round29-report.txt'),
    fail === 0 ? '全部通过 ✅\n\n退出码 0\n' : `${fail} 处失败 ❌\n\n退出码 1\n`);
  app.exit(fail === 0 ? 0 : 1);
});
