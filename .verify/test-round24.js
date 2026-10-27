/* 第二十四轮：v2.9.0「批量下载」→「批量选择」实测（离屏渲染 + 真跑应用代码）

   改的是什么：
     工具条那颗「批量下载」换成「批量选择」，进去以后不只下载，还能
     加入歌单 / 喜欢 / 移出（我喜欢页叫「取消喜欢」，歌单页叫「移出歌单」）。

   量什么（★ = 这条最要紧）：
     [A1] 点「批量选择」→ 每行出现复选框，按钮变成「退出批量选择」
     [A2] ★ 选择条上的动作按钮**按视图变**：我喜欢页没有「喜欢」，只有「取消喜欢」
     [A3] 一个都没选时四个动作全部置灰；全选后都能点
     [B1] ★ 点「下载」→ 主进程真的收到这 4 首（不是只弹个提示）
     [B2] 下载排完队列 → 自动退出选择模式
     [C1] 点「加入歌单」→ 弹出选歌单的窗，列出已有歌单
     [C2] ★ 选一个歌单 → 歌真的进去了，而且**按 sameTrack 判重**
     [C3] 加完**不退模式**（还能接着下载 / 喜欢）
     [D1] ★ 点「取消喜欢」→ 真的从我喜欢里摘掉、退出模式、提示说清几首
     [E1] 歌单页的动作是「喜欢 / 移出歌单」，没有「取消喜欢」
     [E2] ★ 点「喜欢」→ 那批歌真的进了「我喜欢」
     [E3] ★ 点「移出歌单」→ 歌单里少了几首，但「我喜欢」和歌本身不受影响
     [F1] ★ 歌单里混着本地歌时，本地歌**也能勾上**（键是 l:localPath）
     [F2] ★ 全选后点下载 → 只送有 bvid 的，提示里写明"几首本地歌跳过"
     [Z ] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round24-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const die = (e) => {
  try { say('\n💥 测试脚本自身抛异常（不是产品失败）：' + ((e && e.stack) || e)); } catch (_) {}
  try { process.exit(3); } catch (_) {}
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

/* ---------- IPC 桩 ---------- */
let memStore = { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null, local: [] };
ipcMain.handle('store:load', () => ({ ok: true, data: memStore }));
ipcMain.handle('store:save', (_e, d) => { memStore = d; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=https%3A%2F%2Fexample.invalid%2Fa.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:line', () => {});
ipcMain.on('lyric:move', () => {});
ipcMain.on('ui-state', () => {});

const dlStub = require('./stub-download-ipc.js');
dlStub();

let win = null;
let evalJS = null;

/* 测试用的歌：6 首 B 站歌 + 1 首本地歌 */
const TRACKS = Array.from({ length: 6 }, (_, i) => ({
  bvid: 'BVtest' + i, cid: 100 + i, page: 1,
  title: '测试歌 ' + (i + 1), author: '测试UP', duration: 200, cover: '', mid: 1,
}));
const LOCAL1 = { localPath: 'C:\\fake\\local1.flac', title: '本地歌 A', author: '本地', duration: 180, cover: '' };

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败|测试环境/i.test(msg)) {
      errors.push('[页面] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  evalJS = (code) => win.webContents.executeJavaScript(code);
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const text = (sel) => evalJS(`((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || '')`);
  const toastText = () => text('#toast');
  const bodyText = () => evalJS(`document.body.innerText`);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    // 下载目录先给一个假的 —— 否则 enqueueDownloads 会先弹"选目录"的窗，测试会卡在那儿
    DB.settings.download = { dir: 'C:\\\\fake-dl' };
    window.addEventListener('unhandledrejection', (e) => {
      console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason));
    });
    return true;
  })()`);

  /* 铺一屏「我喜欢」 */
  const gotoFav = (tracks) => evalJS(`(() => {
    DB.favorites = ${JSON.stringify(tracks)};
    selPick = null;
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);

  /* 铺一屏歌单 */
  const gotoPl = (tracks) => evalJS(`(() => {
    DB.playlists = [{ id: 'pl1', name: '通勤', tracks: ${JSON.stringify(tracks)} }];
    selPick = null;
    renderPlaylist('pl1');
    return true;
  })()`);

  /* 读选择条上的动作按钮 id（顺序也要对：破坏性的必须最后） */
  const barActions = () => evalJS(`(() => {
    const bar = document.querySelector('.pick-bar');
    if (!bar) return { has: false, ids: [], disabled: [], labels: [] };
    const btns = [...bar.querySelectorAll('.imp-bar-actions .ghost-btn')];
    // 前两个是「全选 / 清空选择」，从 .bar-sep 后面才是动作按钮
    // ★ v2.10.1：条子最右边又多了一个「退出」（它前面也有一个 .bar-sep），
    //   所以不能只按"第一个 bar-sep 之后"取 —— 那会把退出也算成动作按钮。
    //   这里按 id 明确排掉它：它是"结束这件事"，不是"对选中的歌做什么"。
    const sep = bar.querySelector('.bar-sep');
    const acts = sep ? [...sep.parentElement.children].slice([...sep.parentElement.children].indexOf(sep) + 1) : [];
    const actBtns = acts.filter((el) => el.classList && el.classList.contains('ghost-btn') && el.id !== 'btnSelPickExit');
    return {
      has: true,
      ids: actBtns.map((b) => b.id),
      labels: actBtns.map((b) => b.textContent.trim()),
      disabled: actBtns.filter((b) => b.disabled).map((b) => b.id),
      danger: actBtns.filter((b) => b.classList.contains('danger')).map((b) => b.id),
      all: btns.length,
    };
  })()`);

  const pickCount = () => evalJS(`document.querySelectorAll('#content .track.pickable').length`);
  const checkedCount = () => evalJS(`document.querySelectorAll('#content .track.pickable .pick.on').length`);

  /* ★ 勾选必须**一行一行点、每点一次重新查一次 DOM**。
     原因：selToggle 里是 rerenderKeepScroll()，点一下就整块重画，
     第一次查询拿到的 NodeList 在重画之后全是"已经脱离文档"的旧节点 ——
     再点它们不会冒泡到 #content 上的监听器，等于白点。
     （这坑第一次跑就踩了：选 3 行只有第 1 行勾上。） */
  const clickRows = async (idx) => {
    for (const i of idx) {
      await evalJS(`(() => {
        const r = document.querySelectorAll('#content .track.pickable')[${i}];
        if (r) r.click();
        return true;
      })()`);
      await sleep(70);
    }
  };

  /* ============================================================
     A. 进选择模式 + 按钮按视图变
     ============================================================ */
  say('=== A. 「我喜欢」的批量选择 ===');
  await gotoFav(TRACKS.slice(0, 4));
  await sleep(150);

  const toolbar = await evalJS(`(() => {
    const b = document.getElementById('btnSelectFav');
    return { has: !!b, txt: b ? b.textContent.trim() : '', old: !!document.getElementById('btnDownloadFav') };
  })()`);
  if (toolbar.has && /批量选择/.test(toolbar.txt) && !toolbar.old)
    ok(`[A1] 工具条上是「${toolbar.txt}」（旧的「批量下载」按钮已不在）`);
  else bad(`[A1] 工具条不对：${JSON.stringify(toolbar)}`);

  await click('#btnSelectFav');
  await sleep(200);

  const rows = await pickCount();
  if (rows === 4) ok('[A1] 每行都出现复选框（4 行）');
  else bad(`[A1] 勾选行数 = ${rows}，期望 4`);

  const tb2 = await evalJS(`(() => {
    const b = document.getElementById('btnSelectFav');
    return { txt: b ? b.textContent.trim() : '', on: b ? /\\bon\\b/.test(b.className) : false };
  })()`);
  if (/退出批量选择/.test(tb2.txt) && tb2.on) ok('[A1] 按钮变成「退出批量选择」并亮起（ghost-btn.on）');
  else bad(`[A1] 进模式后按钮不对：${JSON.stringify(tb2)}`);

  const a1 = await barActions();
  if (a1.has) ok('[A2] 出现了选择条（.pick-bar）');
  else bad('[A2] 没出现选择条');
  if (JSON.stringify(a1.ids) === JSON.stringify(['btnSelDownload', 'btnSelAddPl', 'btnSelRemove']))
    ok(`[A2] ★ 我喜欢页的动作 = ${a1.labels.join(' / ')}（没有「喜欢」）`);
  else bad(`[A2] ★ 我喜欢页的动作不对：${JSON.stringify(a1.ids)}`);
  if (!a1.ids.includes('btnSelFav')) ok('[A2] ★ 反向断言：没有「喜欢」按钮（这页全已喜欢，放了就是死按钮）');
  else bad('[A2] ★ 我喜欢页居然画了「喜欢」按钮');
  if (a1.danger.length === 1 && a1.danger[0] === 'btnSelRemove') ok('[A2] 破坏性那颗是 danger 配色');
  else bad(`[A2] danger 配色不对：${JSON.stringify(a1.danger)}`);

  if (a1.disabled.length === 3) ok('[A3] 一首都没选时三个动作全部置灰');
  else bad(`[A3] 未选时置灰数量 = ${a1.disabled.length}，期望 3`);

  // 全选
  await click('#btnSelPickAll');
  await sleep(200);
  const n1 = await checkedCount();
  if (n1 === 4) ok('[A3] 全选 → 4 行勾上');
  else bad(`[A3] 全选后勾上 ${n1} 行，期望 4`);
  const cnt = await text('.pick-bar .imp-count');
  if (/4/.test(cnt)) ok(`[A3] 计数写着「${cnt.trim()}」`);
  else bad(`[A3] 计数不对：「${cnt}」`);
  const a2 = await barActions();
  if (a2.disabled.length === 0) ok('[A3] 选上以后三个动作都能点了');
  else bad(`[A3] 选上以后还有置灰的：${JSON.stringify(a2.disabled)}`);

  /* ============================================================
     B. 下载
     ============================================================ */
  say('\n=== B. 「下载」真的把选中的送进队列 ===');
  const addBefore = dlStub.calls.add.length;
  await click('#btnSelDownload');
  await sleep(700);

  const sent = dlStub.calls.add.slice(addBefore);
  const sentN = sent.reduce((s, arr) => s + arr.length, 0);
  if (sentN === 4) ok(`[B1] ★ 主进程收到 4 首（bvid：${sent[0].map((t) => t.bvid).join(',')}）`);
  else bad(`[B1] ★ 主进程收到 ${sentN} 首，期望 4：${JSON.stringify(sent)}`);

  const afterDl = await evalJS(`({ pick: !!selPick, rows: document.querySelectorAll('#content .track.pickable').length, view: currentView })`);
  if (!afterDl.pick && afterDl.rows === 0) ok('[B2] 下载排完队列 → 自动退出选择模式');
  else bad(`[B2] 下完还留在选择模式：${JSON.stringify(afterDl)}`);

  /* ============================================================
     C. 加入歌单
     ============================================================ */
  say('\n=== C. 「加入歌单」 ===');
  await gotoFav(TRACKS.slice(0, 4));
  await evalJS(`(() => { DB.playlists = [{ id: 'plA', name: '已有歌单', tracks: [${JSON.stringify(TRACKS[0])}] }]; return true; })()`);
  await sleep(120);
  await click('#btnSelectFav');
  await sleep(150);
  await click('#btnSelPickAll');
  await sleep(150);
  await click('#btnSelAddPl');
  await sleep(300);

  const promptShown = await evalJS(`!!document.querySelector('#promptMask.show')`);
  const plRows = await evalJS(`[...document.querySelectorAll('#promptBody .pl-row')].map((el) => el.textContent.trim())`);
  if (promptShown && plRows.length === 1) ok(`[C1] 弹出选歌单的窗，列出「${plRows[0]}」`);
  else bad(`[C1] 弹窗/列表不对：shown=${promptShown} rows=${JSON.stringify(plRows)}`);

  await click('#promptBody .pl-row');
  await sleep(500);
  const plAfter = await evalJS(`DB.playlists.find((p) => p.id === 'plA').tracks.length`);
  if (plAfter === 4) ok('[C2] ★ 选中的 4 首进了歌单（原有 1 首 + 新的 3 首 = 4，没重复塞）');
  else bad(`[C2] ★ 歌单里 ${plAfter} 首，期望 4（判重失效会变成 5）`);

  const stillPicking = await evalJS(`!!selPick`);
  if (stillPicking) ok('[C3] 加完不退模式（还能接着下载 / 喜欢）');
  else bad('[C3] 加完歌单就退出了选择模式');

  /* ============================================================
     D. 取消喜欢
     ============================================================ */
  say('\n=== D. 「取消喜欢」 ===');
  // 现在还在选择模式里，且 4 首都还勾着
  await click('#btnSelRemove');
  await sleep(500);
  const d1 = await evalJS(`({
    fav: DB.favorites.length,
    pick: !!selPick,
    rows: document.querySelectorAll('#content .track.pickable').length,
    toast: (document.getElementById('toast') || {}).textContent || '',
  })`);
  if (d1.fav === 0) ok('[D1] ★ 4 首真的从「我喜欢」里摘掉了');
  else bad(`[D1] ★ 取消喜欢后还剩 ${d1.fav} 首，期望 0`);
  if (!d1.pick && d1.rows === 0) ok('[D1] 摘完自动退出选择模式');
  else bad(`[D1] 摘完还在选择模式：${JSON.stringify(d1)}`);
  if (/取消喜欢 4 首/.test(d1.toast)) ok(`[D1] 提示说清了数量：「${d1.toast}」`);
  else bad(`[D1] 提示不对：「${d1.toast}」`);

  /* ============================================================
     E. 歌单页：喜欢 / 移出歌单
     ============================================================ */
  say('\n=== E. 「歌单」的批量选择 ===');
  await gotoPl(TRACKS.slice(0, 5));
  await evalJS(`(() => { DB.favorites = []; return true; })()`);
  await sleep(150);

  const plToolbar = await evalJS(`(() => {
    const b = document.getElementById('btnSelectPl');
    return { has: !!b, txt: b ? b.textContent.trim() : '' };
  })()`);
  if (plToolbar.has && /批量选择/.test(plToolbar.txt)) ok(`[E1] 歌单页工具条是「${plToolbar.txt}」`);
  else bad(`[E1] 歌单页工具条不对：${JSON.stringify(plToolbar)}`);

  await click('#btnSelectPl');
  await sleep(200);
  const e1 = await barActions();
  if (JSON.stringify(e1.ids) === JSON.stringify(['btnSelDownload', 'btnSelAddPl', 'btnSelFav', 'btnSelRemove']))
    ok(`[E1] 歌单页的动作 = ${e1.labels.join(' / ')}`);
  else bad(`[E1] 歌单页动作不对：${JSON.stringify(e1.ids)}`);
  if (/移出歌单/.test(e1.labels.join(''))) ok('[E1] 破坏性那颗写的是「移出歌单」（不是「取消喜欢」）');
  else bad(`[E1] 移出按钮文案不对：${JSON.stringify(e1.labels)}`);

  // 勾前 3 首
  await clickRows([0, 1, 2]);
  await sleep(150);
  const n3 = await checkedCount();
  if (n3 === 3) ok('[E2] 点了 3 行 → 勾上 3 个');
  else bad(`[E2] 勾上 ${n3} 个，期望 3`);

  await click('#btnSelFav');
  await sleep(400);
  const e2 = await evalJS(`({ fav: DB.favorites.length, pick: !!selPick, toast: (document.getElementById('toast') || {}).textContent || '' })`);
  if (e2.fav === 3) ok('[E2] ★ 点「喜欢」→ 3 首真的进了「我喜欢」');
  else bad(`[E2] ★ 喜欢后「我喜欢」里 ${e2.fav} 首，期望 3`);
  if (e2.pick) ok('[E2] 收藏完不退模式（和本地歌曲那边一个口径）');
  else bad('[E2] 收藏完退出了选择模式');

  await click('#btnSelRemove');
  await sleep(400);
  const e3 = await evalJS(`({
    pl: DB.playlists.find((p) => p.id === 'pl1').tracks.length,
    fav: DB.favorites.length,
    pick: !!selPick,
    toast: (document.getElementById('toast') || {}).textContent || '',
  })`);
  if (e3.pl === 2) ok('[E3] ★ 移出歌单后剩 2 首（5 - 3）');
  else bad(`[E3] ★ 移出后歌单里 ${e3.pl} 首，期望 2`);
  if (e3.fav === 3) ok('[E3] 移出歌单**不影响**「我喜欢」（两件事没串）');
  else bad(`[E3] 移出歌单把「我喜欢」也改了：${e3.fav}`);
  if (!e3.pick) ok('[E3] 移出后退出选择模式');
  else bad('[E3] 移出后还在选择模式');

  /* ============================================================
     F. 歌单里混着本地歌
     ============================================================ */
  say('\n=== F. 歌单里混着本地歌 ===');
  await gotoPl([TRACKS[0], LOCAL1, TRACKS[1]]);
  await sleep(150);
  await click('#btnSelectPl');
  await sleep(200);

  await clickRows([0, 1, 2]);
  await sleep(150);
  const f1 = await checkedCount();
  if (f1 === 3) ok('[F1] ★ 本地歌也能勾上（3 行全勾上，键是 l:localPath）');
  else bad(`[F1] ★ 只勾上 ${f1} 行 —— 本地歌勾不上（键没走 selKey）`);

  const addBefore2 = dlStub.calls.add.length;
  await click('#btnSelDownload');
  await sleep(700);
  const sent2 = dlStub.calls.add.slice(addBefore2);
  const sent2N = sent2.reduce((s, arr) => s + arr.length, 0);
  const sent2HasLocal = sent2.some((arr) => arr.some((t) => t.localPath));
  if (sent2N === 2 && !sent2HasLocal) ok('[F2] ★ 只把 2 首有 bvid 的送进下载队列，本地歌被筛掉');
  else bad(`[F2] ★ 送进队列 ${sent2N} 首（含本地歌=${sent2HasLocal}），期望 2 首且不含本地歌`);
  const fToast = await toastText();
  if (/本地歌跳过/.test(fToast)) ok(`[F2] ★ 提示里写明了跳过：「${fToast}」`);
  else bad(`[F2] 提示没说跳过本地歌：「${fToast}」`);

  /* ============================================================
     Z. 收尾
     ============================================================ */
  say('');
  if (!errors.length) ok('[Z] 全程没有页面报错');
  else {
    bad(`[Z] 页面报了 ${errors.length} 条错：`);
    errors.slice(0, 8).forEach((e) => say('        ' + e));
  }

  say(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 条没通过 ❌`);
  finish(fail === 0 ? 0 : 1);
});
