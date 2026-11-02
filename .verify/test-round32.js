/* v2.13.0 存档瘦身实测（离屏 + 真跑应用代码）。
   跑：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/test-round32.js

   ★ 存档膨胀的病灶与手术（Neo 拍板的待办第 1 条）：
     主存档 7.49MB，光 collectParts（合集曲目表缓存）就 4.18MB —— 它是**可重建的缓存**，
     却混在用户数据里跟着每次 persist 全量重写。
     手术：拆去 cache-collect.json + 主存档 persist 时剥离 + migrate 顺手剥掉
     {ok, data} 历史残骸（远古信封没解包就 persist 了，156KB 冗余副本跟到今天）。

   ★ 这份测的是**迁移链路**（老存档第一次启动）：
     ① 主存档带着 collectParts 进来、cache 还是空的 → boot 自动把缓存搬出去
     ② 之后的 persist，payload 里**不许再出现** collectParts / collectCovers
     ③ beforeunload 兜底（reload 触发）推的存档同样剥离
     ④ DB.data / DB.ok 残骸被 migrate 剥掉（migrate 本身在 round11 已测）
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const cacheCollect = require(path.join(ROOT, 'src', 'cache-collect.js'));
const QFILE = path.join(os.tmpdir(), 'neko-r32-queue.json');
const CFILE = path.join(os.tmpdir(), 'neko-r32-cache.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const say = (m) => console.log(m);

app.disableHardwareAcceleration();

/* 主存档 mock：老存档形状 —— 带着该搬走的 collectParts / collectCovers，
   还有该被 migrate 剥掉的历史残骸（ok / data）。
   ★ store:load 走**真实的 migrate**（不是手写 mock）—— 残骸剥离是真的被测到。 */
const storeMigrate = require(path.join(ROOT, 'src', 'store-migrate.js'));
let savedPayloads = [];
let cacheSaved = null;

ipcMain.handle('store:load', () => ({
  ok: true,
  data: storeMigrate.migrate({
    ok: true,
    data: { playlists: [{ id: 'old' }] },          // 远古信封残骸
    playlists: [], favorites: [], history: [], local: [], lastTrack: null,
    collectParts: { BVm: [{ bvid: 'BVm', cid: 1, page: 1, title: 'P1', duration: 200 }] },
    collectCovers: { BVm: 'https://i0.hdslb.com/x.jpg' },
    settings: {},
  }, { bgDir: null }),
}));
ipcMain.handle('store:save', (_e, payload) => { savedPayloads.push(payload); return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('queue:load', () => ({ ok: true, data: null }));
ipcMain.handle('queue:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://x', duration: 200, backup: [] } }));
/* cache：真实的 queue-store 同款模块 —— load 一直返回 null（模拟"老用户第一次启动"），
   save 真落盘（临时文件），boot 的迁移逻辑真跑 */
ipcMain.handle('cache-collect:load', () => ({ ok: true, data: cacheCollect.load(CFILE) }));
ipcMain.handle('cache-collect:save', (_e, d) => ({ ok: true, data: cacheCollect.save(CFILE, d) }));
ipcMain.on('queue:save:now', (_e, d) => { require(path.join(ROOT, 'src', 'queue-store.js')).save(QFILE, d); });
ipcMain.on('store:save:now', (_e, d) => { savedPayloads.push({ ...(d || {}), __fromBeforeunload: true }); });
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  try { fs.unlinkSync(CFILE); fs.unlinkSync(QFILE); } catch { /* 本来就没有 */ }

  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/\[播放失败\]/.test(msg)) errors.push(msg); });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1300);
  const ev = (c) => win.webContents.executeJavaScript(c);

  /* ================= 1) 迁移：cache 被自动建出来 ================= */
  say('\n[1] 老存档带 collectParts、cache 为空 → boot 自动迁移：');
  await sleep(400);
  const r1 = cacheCollect.load(CFILE);
  if (!r1 || !r1.collectParts.BVm) bad('cache 文件没有自动生成 / 内容不对');
  else if (r1.collectCovers.BVm !== 'https://i0.hdslb.com/x.jpg') bad('封面表没迁过去');
  else ok('曲目表 + 封面表都搬进了 cache-collect.json');
  const inMemory = await ev(`(() => ({ parts: Object.keys(DB.collectParts || {}).length, covers: Object.keys(DB.collectCovers || {}).length, ok: 'ok' in DB, data: 'data' in DB }))()`);
  if (inMemory.parts !== 1 || inMemory.covers !== 1) bad(`内存里的缓存丢了（${JSON.stringify(inMemory)}）`);
  else ok('内存里缓存照常可用（播放合集要读）');
  if (inMemory.ok || inMemory.data) bad(`migrate 没剥掉残骸：ok=${inMemory.ok} data=${inMemory.data}`);
  else ok('历史残骸 ok / data 被 migrate 剥掉了');

  /* ================= 2) persist 的 payload 不带缓存 ================= */
  say('\n[2] persist 的落盘 payload：');
  await ev(`(() => { persistLater(); return true; })()`);
  await sleep(700);
  const p = savedPayloads[savedPayloads.length - 1];
  if (!p) bad('persist 没有发出保存');
  else if ('collectParts' in p || 'collectCovers' in p) bad('★ payload 里还带着缓存 —— 主存档没有瘦');
  else if ('ok' in p || 'data' in p) bad('payload 里还有残骸字段');
  else ok(`payload 干净（${Object.keys(p).length} 个字段，无 collectParts / collectCovers / ok / data）`);
  const size = JSON.stringify(p).length;
  say(`    payload 体积：${(size / 1024).toFixed(1)} KB（老存档是 7.49MB）`);
  if (size > 300 * 1024) bad('payload 还是太大');
  else ok('主存档瘦身生效');

  /* ================= 3) beforeunload 兜底推的同样剥离 ================= */
  say('\n[3] beforeunload 兜底（reload 触发）：');
  win.webContents.reload();
  await sleep(900);
  const last = savedPayloads[savedPayloads.length - 1];
  if (!last || !last.__fromBeforeunload) bad('beforeunload 没有触发兜底保存');
  else if ('collectParts' in last || 'collectCovers' in last) bad('兜底推的存档还带着缓存');
  else ok('兜底路径同样剥离');

  /* ================= 4) 二次启动：cache 直接用，不再重复迁移 ================= */
  say('\n[4] 二次启动（cache 已存在）：');
  win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1300);
  const r4 = cacheCollect.load(CFILE);
  if (!r4 || !r4.collectParts.BVm) bad('二次启动后 cache 丢了');
  else ok('cache 稳定存在，缓存走 cache 文件');

  /* ================= 5) 页面报错 ================= */
  say('\n[5] 页面报错：');
  if (errors.length) { errors.slice(0, 5).forEach((e) => say('    ' + e)); bad(`页面报了 ${errors.length} 条错`); }
  else ok('全程没有页面报错');

  try { fs.unlinkSync(CFILE); fs.unlinkSync(QFILE); } catch { /* 已删 */ }

  say(fail === 0 ? '\n存档瘦身实测：全部通过 ✅' : `\n存档瘦身实测：${fail} 处失败 ❌`);
  fs.writeFileSync(path.join(__dirname, 'test-round32-report.txt'),
    fail === 0 ? '全部通过 ✅\n\n退出码 0\n' : `${fail} 处失败 ❌\n\n退出码 1\n`);
  app.exit(fail === 0 ? 0 : 1);
});
