/* 第十四轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.5.0 —— UP 主主页从「一页页点加载更多」改成「先取总数 + 按 30 分页」

   ★ 判别力：这一组在改造前的代码上会真的失败 ——
     那时没有 total、没有分页条、列表是 concat 累加的、右上角是「加载更多」。

   量什么：
     [1] 137 个视频 → 5 页；副标题「共 137 个视频 · 第 1 / 5 页」；列表 30 行；无「加载更多」
     [2] 页码条：5 页时把 1~5 全列出来（不省略）；第 1 页「上一页」置灰
     [3] 点第 2 页 → 桩里收到 pn=2；列表**替换**成 30 行（不是 60 行），首行是「视频 31」
     [4] 点最后一页（5）→ 只有 17 行；「下一页」置灰
     [5] 837 个视频 → 28 页：第 1 页显示 `1 2 3 … 28`；点「3」滑到中间 → `1 2 3 4 5 … 28`；
         再点「5」→ `1 … 3 4 5 6 7 … 28`（两处省略）
     [6] 右上角「播放本页 (30)」：点一下 → 队列正好是当前页那 30 首（不是 137 首）
     [7] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round14-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const UP_PAGE_SIZE = 30;

/* ---------- 主进程桩 ---------- */
let win = null;

/* ★ UP 主页的桩：总数可调；按 pn 切页返回，并把"界面到底请求了第几页"记下来 */
let upTotal = 137;
let upPns = [];
ipcMain.handle('bili:upVideos', (_e, mid, pn) => {
  upPns.push(pn);
  const start = (pn - 1) * UP_PAGE_SIZE;
  const count = Math.max(0, Math.min(UP_PAGE_SIZE, upTotal - start));
  const list = Array.from({ length: count }, (_, i) => {
    const n = start + i + 1;
    return {
      bvid: 'BV1up' + String(n).padStart(4, '0'), cid: null, page: 1,
      title: `视频 ${n}`, author: '测试UP', mid, cover: '', duration: '3:00', play: n,
    };
  });
  return { ok: true, data: { list, total: upTotal, pageSize: UP_PAGE_SIZE, hasMore: start + count < upTotal } };
});

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win-close', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', (_e, opts) => {
  try { win.webContents.send('win:mini-state', { on: !!(opts && opts.on), expanded: !!(opts && opts.expanded) }); } catch (_) {}
});

/* v2.8.0：下载 / 本地歌曲的 IPC 桩。★ 这个脚本会**把"页面有报错"直接判 FAIL**，
   不打桩的话，"桩缺了"会被当成"产品坏了"，一眼分不出。
   详见 stub-download-ipc.js 顶部的说明。 */
require('./stub-download-ipc.js')();

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
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败/i.test(msg)) {
      errors.push('[主窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

  /* 读 UP 主页当前状态 */
  const readUp = () => evalJS(`(() => {
    const rows = [...document.querySelectorAll('#content .track')];
    const pager = document.querySelector('#content .pager');
    const nums = pager ? [...pager.querySelectorAll('.pager-num')] : [];
    const btns = pager ? [...pager.querySelectorAll('.pager-btn')] : [];
    const on = pager ? pager.querySelector('.pager-num.on') : null;
    return {
      view: currentView,
      page: upState && upState.page,
      total: upState && upState.total,
      pageSize: upState && upState.pageSize,
      rows: rows.length,
      first: rows.length ? rows[0].querySelector('.t').textContent : '',
      last: rows.length ? rows[rows.length - 1].querySelector('.t').textContent : '',
      sub: (document.querySelector('#content .block-sub') || {}).textContent || '',
      playUpText: (document.getElementById('btnPlayUp') || {}).textContent || '',
      hasMoreBtn: !!document.getElementById('btnMoreUp'),
      hasPager: !!pager,
      pagerText: pager ? pager.textContent.replace(/\\s+/g, ' ').trim() : '',
      nums: nums.map((b) => b.textContent),
      onNum: on ? on.textContent : null,
      prevDisabled: btns[0] ? btns[0].disabled : null,
      nextDisabled: btns[1] ? btns[1].disabled : null,
    };
  })()`);

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1000);
    await evalJS(`(() => {
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      window.__paused = true;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  /* ================= 1) 137 个视频 → 5 页 ================= */
  say('\n[1] 137 个视频：先取总数，再按 30 分页：');
  upTotal = 137;
  upPns = [];
  await evalJS(`openUpPage({ mid: 1, author: '测试UP' })`);
  await sleep(600);
  const p1 = await readUp();
  say('  ' + JSON.stringify({ page: p1.page, total: p1.total, pageSize: p1.pageSize, rows: p1.rows, sub: p1.sub, pager: p1.pagerText }));
  say('  桩收到的 pn = ' + JSON.stringify(upPns));

  if (upPns.length && upPns[0] === 1) ok('第一次请求的是第 1 页');
  else bad('第一次请求的页码不对：' + JSON.stringify(upPns));
  if (p1.total === 137) ok('界面拿到了总数 137');
  else bad('总数不对：' + p1.total);
  if (p1.rows === 30) ok('第 1 页列出 30 条');
  else bad('第 1 页条数不对：' + p1.rows);
  if (/共 137 个视频/.test(p1.sub) && /第 1 \/ 5 页/.test(p1.sub)) ok('副标题「' + p1.sub + '」（137 / 30 向上取整 = 5 页）');
  else bad('副标题不对：' + JSON.stringify(p1.sub));
  if (!p1.hasMoreBtn) ok('「加载更多」按钮不存在（v2.5.0 已删）');
  else bad('「加载更多」还在');

  /* ================= 2) 5 页时页码全列出来 ================= */
  say('\n[2] 5 页时页码条不省略；第 1 页「上一页」置灰：');
  if (!p1.hasPager) bad('没有画出分页条');
  else {
    say('  页码 = [' + p1.nums.join(' ') + ']；高亮 = ' + p1.onNum + '；上一页 disabled = ' + p1.prevDisabled + '，下一页 disabled = ' + p1.nextDisabled);
    if (p1.nums.join(',') === '1,2,3,4,5') ok('页码 1 2 3 4 5 全列出来（页数少，不省略）');
    else bad('页码不对：' + p1.nums.join(','));
    if (!/…/.test(p1.pagerText)) ok('没有多余的省略号');
    else bad('不该出现省略号：' + p1.pagerText);
    if (p1.onNum === '1') ok('当前页 1 高亮');
    else bad('高亮的不是第 1 页：' + p1.onNum);
    if (p1.prevDisabled === true) ok('第 1 页「上一页」置灰不可点');
    else bad('第 1 页「上一页」没有置灰');
    if (p1.nextDisabled === false) ok('第 1 页「下一页」可点');
    else bad('第 1 页「下一页」状态不对');
  }

  /* ================= 3) 点第 2 页 → 替换（不是累加） ================= */
  say('\n[3] 点第 2 页：列表要**替换**成第 2 页的 30 条：');
  upPns = [];
  await click('#content .pager .pager-num[data-page="2"]');
  await sleep(700);
  const p2 = await readUp();
  say('  桩收到的 pn = ' + JSON.stringify(upPns));
  say('  ' + JSON.stringify({ page: p2.page, rows: p2.rows, first: p2.first, last: p2.last, sub: p2.sub, on: p2.onNum, prev: p2.prevDisabled }));
  if (upPns.includes(2)) ok('桩里收到了 pn = 2');
  else bad('没有请求第 2 页：' + JSON.stringify(upPns));
  if (p2.rows === 30) ok('列表是 30 行 —— 是"替换"不是"累加"（累加会是 60 行）');
  else bad('列表行数不对：' + p2.rows + '（60 说明还在用 concat 累加）');
  if (p2.first === '视频 31' && p2.last === '视频 60') ok('内容确实是第 2 页（视频 31 ~ 视频 60）');
  else bad('第 2 页内容不对：' + p2.first + ' ~ ' + p2.last);
  if (/第 2 \/ 5 页/.test(p2.sub)) ok('副标题跟着变成「' + p2.sub + '」');
  else bad('副标题没跟着翻页：' + JSON.stringify(p2.sub));
  if (p2.onNum === '2') ok('高亮移到第 2 页');
  else bad('高亮没跟着走：' + p2.onNum);
  if (p2.prevDisabled === false) ok('第 2 页「上一页」可点了');
  else bad('第 2 页「上一页」不该置灰');

  /* ================= 4) 跳到最后一页 ================= */
  say('\n[4] 跳到最后一页（第 5 页）：只剩 17 条，「下一页」置灰：');
  upPns = [];
  await click('#content .pager .pager-num[data-page="5"]');
  await sleep(700);
  const p5 = await readUp();
  say('  桩收到的 pn = ' + JSON.stringify(upPns));
  say('  ' + JSON.stringify({ page: p5.page, rows: p5.rows, first: p5.first, last: p5.last, sub: p5.sub, next: p5.nextDisabled }));
  if (p5.rows === 17) ok('最后一页只有 17 条（137 − 4×30 = 17）');
  else bad('最后一页条数不对：' + p5.rows);
  if (p5.first === '视频 121' && p5.last === '视频 137') ok('内容是视频 121 ~ 视频 137');
  else bad('最后一页内容不对：' + p5.first + ' ~ ' + p5.last);
  if (p5.nextDisabled === true) ok('最后一页「下一页」置灰不可点');
  else bad('最后一页「下一页」没有置灰');

  /* ================= 5) 837 个视频 → 28 页，页码要省略 ================= */
  say('\n[5] 837 个视频（28 页）：页码要省略：');
  upTotal = 837;
  upPns = [];
  await evalJS(`openUpPage({ mid: 1, author: '测试UP' })`);
  await sleep(600);
  const e1 = await readUp();
  say('  第 1 页页码 = [' + e1.nums.join(' ') + ']  整条 = ' + JSON.stringify(e1.pagerText));
  if (/第 1 \/ 28 页/.test(e1.sub)) ok('副标题「' + e1.sub + '」（837 / 30 → 28 页）');
  else bad('副标题不对：' + JSON.stringify(e1.sub));
  if (e1.nums.join(' ') === '1 2 3 28' && /…/.test(e1.pagerText)) ok('第 1 页显示 `1 2 3 … 28`');
  else bad('第 1 页页码不对：' + e1.nums.join(' '));

  /* ★ 28 页时第 1 页只画 `1 2 3 … 28`，压根没有「5」这个按钮 ——
     直接 querySelector('[data-page="5"]') 会拿到 null，click 静默失败，
     页面还停在第 1 页（第一版脚本就栽在这）。
     所以先点「3」滑到中间，页码变成 `1 2 3 4 5 … 28`，这时才点得到 5。 */
  const hit3 = await click('#content .pager .pager-num[data-page="3"]');
  if (!hit3) bad('第 1 页上找不到「3」按钮');
  await sleep(700);
  const e3 = await readUp();
  say('  第 3 页页码 = [' + e3.nums.join(' ') + ']  整条 = ' + JSON.stringify(e3.pagerText));
  if (e3.nums.join(' ') === '1 2 3 4 5 28' && (e3.pagerText.match(/…/g) || []).length === 1)
    ok('第 3 页显示 `1 2 3 4 5 … 28`（右侧一处省略）');
  else bad('第 3 页页码不对：' + e3.nums.join(' ') + ' / ' + e3.pagerText);

  const hit5 = await click('#content .pager .pager-num[data-page="5"]');
  if (!hit5) bad('第 3 页上找不到「5」按钮');
  await sleep(700);
  const e5 = await readUp();
  say('  第 5 页页码 = [' + e5.nums.join(' ') + ']  整条 = ' + JSON.stringify(e5.pagerText));
  if (e5.nums.join(' ') === '1 3 4 5 6 7 28' && (e5.pagerText.match(/…/g) || []).length === 2)
    ok('第 5 页显示 `1 … 3 4 5 6 7 … 28`（两处省略）');
  else bad('第 5 页页码不对：' + e5.nums.join(' ') + ' / ' + e5.pagerText);
  if (e5.onNum === '5') ok('当前页 5 高亮');
  else bad('高亮不对：' + e5.onNum);

  /* ================= 6) 「播放本页 (30)」只播当前页 ================= */
  say('\n[6] 右上角「播放本页」：只把当前这一页塞进队列：');
  const playBtn = await evalJS(`(() => {
    const b = document.getElementById('btnPlayUp');
    return { text: b ? b.textContent.replace(/\\s+/g, ' ').trim() : null, rows: document.querySelectorAll('#content .track').length };
  })()`);
  say('  按钮文案 = ' + JSON.stringify(playBtn.text) + '；当前页 ' + playBtn.rows + ' 行');
  if (/播放本页 \(30\)/.test(playBtn.text)) ok('按钮文案是「播放本页 (30)」');
  else bad('按钮文案不对：' + JSON.stringify(playBtn.text));

  await click('#btnPlayUp');
  await sleep(700);
  const q = await evalJS(`({ len: queue.tracks.length, first: queue.tracks[0] && queue.tracks[0].title, name: queue.name })`);
  say('  队列 = ' + q.len + ' 首，第一首「' + q.first + '」，来源名「' + q.name + '」');
  if (q.len === 30) ok('队列正好 30 首 —— 只播当前页（不是 837 首）');
  else bad('队列长度不对：' + q.len);
  if (q.first === '视频 121') ok('队列第一首 = 第 5 页的第一首（视频 121）');
  else bad('队列第一首不对：' + q.first);

  /* ================= 7) 页面报错 ================= */
  say('\n[7] 页面报错：');
  if (errors.length) {
    errors.slice(0, 6).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\nUP 主页分页实测：全部通过 ✅' : `\nUP 主页分页实测：${fail} 处失败 ❌`);
  finish(fail === 0 ? 0 : 1);
});
