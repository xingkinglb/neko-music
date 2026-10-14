/* 第十五轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.6.0 —— 导入「我的 B 站收藏夹」，重点是**跨收藏夹累积选择**

   ★ 判别力：这一组在改造前的代码上会**整组失败** ——
     那时根本没有这个页面（没有 #btnImportMine、没有 impState、没有分页的挑歌屏）。

   量什么：
     [1]  没填 Cookie → 出现「去设置填 Cookie」的引导，且 myInfo **一次都没被调用**
     [2]  填了 Cookie → 页面显示昵称 + UID
     [3]  3 个收藏夹 → 卡片列出；「86 个视频」；进去 30 行；分页条 3 页
     [4]  勾 3 个 → 顶部「已选 3 个」；返回列表 → 卡片出现「已选 3」角标
     [5]  ★ 跨收藏夹累积：进另一个收藏夹再勾 2 个 → 已选 5（本次的核心判据）
     [6]  ★ 翻页不丢选择：勾 2 个 → 翻到第 2 页 → 翻回来，勾选还在、总数不变
     [7]  ★ 同一个视频在两个收藏夹里只算一次
     [8]  「清空选择」→ 已选 0
     [9]  「整个导入」→ 已选 86，按钮变「取消整个收藏夹」；再点 → 回 0
     [10] 「全选本页」/「全不选本页」→ 30 / 0
     [11] 已选 0 时「导入」按钮 disabled
     [12] 点「导入选中的 5 个」→ 命名框（默认名 = 收藏夹名）→ 确定 → 新歌单 5 首、跳到新歌单
     [13] 「我的投稿」也能挑 + 「导入全部投稿」→ 137 首
     [14] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round15-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const PAGE_SIZE = 30;

/* ---------- 桩数据 ---------- */
const MY_MID = 12345;

/* 三个收藏夹：86 条 / 5 条（含 1 条与第一个重复）/ 0 条（私密） */
const F1 = { id: 1001, title: '深夜爵士', count: 86, cover: '', private: false };
const F2 = { id: 1002, title: '游戏音乐', count: 5,  cover: '', private: false };
const F3 = { id: 1003, title: '学习',     count: 0,  cover: '', private: true  };

const f1Bvid = (n) => 'BV1f1' + String(n).padStart(4, '0');       // 1..86
// ★ F2 的第 1 条**故意**和 F1 的第 1 条是同一个视频 —— 用来验"只算一次"
const F2_BVIDS = [f1Bvid(1), 'BV1f20002', 'BV1f20003', 'BV1f20004', 'BV1f20005'];

/* 主进程桩的可变开关 */
let hasCookie = true;
let myInfoCalls = 0;
let favFoldersCalls = 0;
let upTotal = 137;
let saveCalls = 0;

ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: hasCookie }));

ipcMain.handle('bili:myInfo', () => {
  myInfoCalls += 1;
  return { ok: true, data: { mid: MY_MID, name: '测试喵', face: '' } };
});

ipcMain.handle('bili:favFolders', (_e, mid) => {
  favFoldersCalls += 1;
  return { ok: true, data: [F1, F2, F3].map((f) => ({ ...f })) };
});

ipcMain.handle('bili:favMedias', (_e, mediaId, pn) => {
  const p = pn || 1;
  let list = [];
  let total = 0;
  if (String(mediaId) === '1001') {
    total = 86;
    const start = (p - 1) * PAGE_SIZE;
    const count = Math.max(0, Math.min(PAGE_SIZE, 86 - start));
    list = Array.from({ length: count }, (_, i) => {
      const n = start + i + 1;
      return { bvid: f1Bvid(n), title: `爵士 ${n}`, cover: '', duration: 200 + n, page: 1 };
    });
  } else if (String(mediaId) === '1002') {
    total = 5;
    if (p === 1) {
      list = F2_BVIDS.map((b, i) => ({ bvid: b, title: `游戏 ${i + 1}`, cover: '', duration: 180, page: 1 }));
    }
  }
  return { ok: true, data: { list, total, pageSize: PAGE_SIZE, hasMore: p * PAGE_SIZE < total } };
});

ipcMain.handle('bili:upVideos', (_e, mid, pn) => {
  const p = pn || 1;
  const start = (p - 1) * PAGE_SIZE;
  const count = Math.max(0, Math.min(PAGE_SIZE, upTotal - start));
  const list = Array.from({ length: count }, (_, i) => {
    const n = start + i + 1;
    return {
      bvid: 'BV1up' + String(n).padStart(4, '0'), cid: null, page: 1,
      title: `投稿 ${n}`, author: '测试喵', mid, cover: '', duration: '3:00', play: n,
    };
  });
  return { ok: true, data: { list, total: upTotal, pageSize: PAGE_SIZE, hasMore: start + count < upTotal } };
});

/* ---------- 其余必需桩 ---------- */
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => { saveCalls += 1; return { ok: true, data: true }; });
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试喵' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
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

let win = null;

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

  /* 读导入页当前状态 */
  const readImp = () => evalJS(`(() => {
    // ★ 用 typeof 兜一下：在**改造前**的代码上跑（没有 impState）时，
    //   这样会老老实实给出 FAIL，而不是抛 ReferenceError 把整轮测试炸掉 ——
    //   判别力要能"报出来"，不是"崩掉"。
    const st = (typeof impState === 'undefined') ? null : impState;
    const bar = document.querySelector('#content .imp-bar');
    const rows = [...document.querySelectorAll('#content .track')];
    const pager = document.querySelector('#content .pager');
    const cards = [...document.querySelectorAll('#content .card[data-imp-folder]')];
    const doBtn = document.getElementById('btnImpDo');
    return {
      view: currentView,
      step: st ? st.step : null,
      source: st ? st.source : null,
      size: st ? st.selected.size : -1,
      page: st ? st.page : -1,
      total: st ? st.total : -1,
      folders: st ? st.folders.length : -1,
      rows: rows.length,
      pickedRows: rows.filter((r) => r.classList.contains('picked')).length,
      checkedBoxes: rows.filter((r) => { const p = r.querySelector('.pick'); return p && p.classList.contains('on'); }).length,
      firstTitle: rows.length ? rows[0].querySelector('.t').textContent : '',
      barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
      doDisabled: doBtn ? doBtn.disabled : null,
      cards: cards.map((c) => ({
        id: c.dataset.impFolder,
        title: c.querySelector('.c-title') ? c.querySelector('.c-title').textContent : '',
        sub: c.querySelector('.c-sub') ? c.querySelector('.c-sub').textContent : '',
        sel: c.querySelector('.c-sel') ? c.querySelector('.c-sel').textContent : '',
        btn: c.querySelector('.c-pick') ? c.querySelector('.c-pick').textContent : '',
      })),
      pagerNums: pager ? [...pager.querySelectorAll('.pager-num')].map((b) => b.textContent) : [],
      emptyMsg: (document.querySelector('#content .empty .msg') || {}).textContent || '',
      emptyHint: (document.querySelector('#content .empty .hint') || {}).textContent || '',
      headTitle: (document.querySelector('#content .block-title') || {}).textContent || '',
      headSub: (document.querySelector('#content .block-sub') || {}).textContent || '',
      hasSrcUp: !!document.getElementById('btnImpUp'),
      hasSrcFav: !!document.getElementById('btnImpFav'),
      promptShown: !!(document.getElementById('promptMask') || {}).classList && document.getElementById('promptMask').classList.contains('show'),
      promptValue: (document.getElementById('promptInput') || {}).value || '',
    };
  })()`);

  /** 勾选导入列表里的第 i 行（点整行 —— 走的是真点击代理） */
  const pickRow = async (i) => {
    const hit = await click(`#content .track[data-i="${i}"]`);
    await sleep(180);
    return hit;
  };

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

  /* ================= 1) 没填 Cookie → 引导，且不白跑 myinfo ================= */
  say('\n[1] 没填 Cookie：给引导，且 myInfo 一次都不该被调用：');
  hasCookie = false;
  myInfoCalls = 0;
  await click('#btnImportMine');
  await sleep(500);
  const n1 = await readImp();
  say('  view=' + n1.view + '；提示=' + JSON.stringify(n1.emptyMsg));
  say('  myInfo 被调用次数 = ' + myInfoCalls);
  if (n1.view === 'importMine') ok('点侧栏导入按钮进到了导入页');
  else bad('没进到导入页：' + n1.view);
  if (/B 站账号/.test(n1.emptyMsg)) ok('给出了「去设置填 Cookie」的引导');
  else bad('没有引导文案：' + JSON.stringify(n1.emptyMsg));
  if (/设置 → B 站/.test(n1.emptyHint)) ok('引导里指明了去哪儿填（设置 → B 站）');
  else bad('引导没说去哪儿填：' + JSON.stringify(n1.emptyHint));
  if (myInfoCalls === 0) ok('★ myInfo 一次都没被调用（没白跑请求）');
  else bad('★ 没填 Cookie 却打了 ' + myInfoCalls + ' 次 myinfo');

  /* ================= 2) 填了 Cookie → 认出你是谁 ================= */
  say('\n[2] 填了 Cookie：显示昵称 + UID：');
  hasCookie = true;
  myInfoCalls = 0;
  await click('#btnImportMine');
  await sleep(500);
  const n2 = await readImp();
  say('  页头 = ' + JSON.stringify(n2.headSub) + '；两个来源卡 = ' + n2.hasSrcUp + ' / ' + n2.hasSrcFav);
  if (myInfoCalls === 1) ok('这次打了 1 次 myInfo');
  else bad('myInfo 调用次数不对：' + myInfoCalls);
  if (/测试喵/.test(n2.headSub) && /UID 12345/.test(n2.headSub)) ok('页头显示「' + n2.headSub + '」');
  else bad('没显示出昵称 / UID：' + JSON.stringify(n2.headSub));
  if (n2.hasSrcUp && n2.hasSrcFav) ok('两个来源卡片都在（我的投稿 / 我的收藏夹）');
  else bad('来源卡片不全：' + n2.hasSrcUp + ' / ' + n2.hasSrcFav);

  /* ================= 3) 收藏夹列表 ================= */
  say('\n[3] 收藏夹列表 → 进第一个收藏夹：');
  await click('#btnImpFav');
  await sleep(600);
  const n3 = await readImp();
  say('  卡片 = ' + JSON.stringify(n3.cards.map((c) => `${c.title}/${c.sub}`)));
  if (n3.cards.length === 3) ok('列出 3 个收藏夹');
  else bad('收藏夹数量不对：' + n3.cards.length);
  const c1 = n3.cards.find((c) => c.id === '1001');
  if (c1 && /86 个视频/.test(c1.sub)) ok('「深夜爵士」卡片显示「86 个视频」');
  else bad('卡片条数不对：' + JSON.stringify(c1));
  const c3 = n3.cards.find((c) => c.id === '1003');
  if (c3 && /私密/.test(c3.title)) ok('私密收藏夹带「私密」小标');
  else bad('私密收藏夹没标记：' + JSON.stringify(c3));

  await click('#content .card[data-imp-folder="1001"]');
  await sleep(700);
  const n3b = await readImp();
  say('  step=' + n3b.step + '；行数=' + n3b.rows + '；副标题=' + JSON.stringify(n3b.headSub) + '；页码=' + JSON.stringify(n3b.pagerNums));
  if (n3b.step === 'list') ok('点卡片进到了挑视频屏');
  else bad('没进挑视频屏：' + n3b.step);
  if (n3b.rows === 30) ok('第 1 页列出 30 行');
  else bad('行数不对：' + n3b.rows);
  if (/共 86 个视频/.test(n3b.headSub) && /第 1 \/ 3 页/.test(n3b.headSub)) ok('副标题「' + n3b.headSub + '」');
  else bad('副标题不对：' + JSON.stringify(n3b.headSub));
  if (n3b.pagerNums.join(',') === '1,2,3') ok('分页条 3 页（复用了 v2.5.0 的 paginationHTML）');
  else bad('分页条不对：' + n3b.pagerNums.join(','));

  /* ================= 4) 勾 3 个 ================= */
  say('\n[4] 勾 3 个 → 顶部计数 + 卡片角标：');
  await pickRow(0);
  await pickRow(1);
  await pickRow(2);
  const n4 = await readImp();
  say('  ' + JSON.stringify({ size: n4.size, pickedRows: n4.pickedRows, checkedBoxes: n4.checkedBoxes, bar: n4.barText }));
  if (n4.size === 3) ok('已选 3 个');
  else bad('已选数不对：' + n4.size);
  if (/已选 3 个/.test(n4.barText)) ok('顶部工具条写着「已选 3 个」');
  else bad('顶部工具条不对：' + JSON.stringify(n4.barText));
  if (n4.pickedRows === 3 && n4.checkedBoxes === 3) ok('那 3 行都带上了勾选态（复选框 + 整行高亮）');
  else bad('勾选态没画出来：picked=' + n4.pickedRows + ' checked=' + n4.checkedBoxes);

  await click('#btnImpBack');
  await sleep(400);
  const n4b = await readImp();
  const c1b = n4b.cards.find((c) => c.id === '1001');
  say('  返回后：step=' + n4b.step + '；卡片角标=' + JSON.stringify(c1b && c1b.sel) + '；按钮=' + JSON.stringify(c1b && c1b.btn));
  if (n4b.step === 'folders') ok('「← 返回」回到了收藏夹列表');
  else bad('返回没到收藏夹列表：' + n4b.step);
  if (n4b.size === 3) ok('★ 返回没有清空选择（还是 3 个）');
  else bad('★ 返回把选择清了：' + n4b.size);
  if (c1b && /已选 3/.test(c1b.sel)) ok('卡片右下角出现「已选 3」角标');
  else bad('卡片没有角标：' + JSON.stringify(c1b && c1b.sel));

  /* ================= 5) ★ 跨收藏夹累积 ================= */
  say('\n[5] ★ 跨收藏夹累积：进第二个收藏夹再勾 2 个：');
  await click('#content .card[data-imp-folder="1002"]');
  await sleep(700);
  const n5a = await readImp();
  say('  进第二个收藏夹：行数=' + n5a.rows + '；已选=' + n5a.size + '；勾着的行=' + n5a.checkedBoxes);
  if (n5a.rows === 5) ok('第二个收藏夹列出 5 行');
  else bad('行数不对：' + n5a.rows);
  if (n5a.size === 3) ok('★ 换了收藏夹，之前选的 3 个还在');
  else bad('★ 换收藏夹把选择弄丢了：' + n5a.size);
  // 第 1 行和第一个收藏夹的第 1 行是同一个视频 → 它应该已经是勾上的
  if (n5a.checkedBoxes === 1) ok('★ 第 1 行（与上个收藏夹重复的那个视频）自动是勾上的');
  else bad('重复的那个视频没自动勾上：勾着 ' + n5a.checkedBoxes + ' 行');

  await pickRow(1);
  await pickRow(2);
  const n5 = await readImp();
  say('  再勾 2 个 → 已选 ' + n5.size + '；工具条=' + JSON.stringify(n5.barText));
  if (n5.size === 5) ok('★★ 已选 5 个 —— 跨收藏夹累积成功（本次核心判据）');
  else bad('★★ 跨收藏夹累积不对：' + n5.size + '（应该是 5）');
  if (/已选 5 个/.test(n5.barText)) ok('顶部工具条跟着变成「已选 5 个」');
  else bad('顶部工具条没跟着变：' + JSON.stringify(n5.barText));

  /* ================= 6) ★ 翻页不丢选择 ================= */
  say('\n[6] ★ 翻页不丢选择：');
  await click('#btnImpBack');       // → folders
  await sleep(350);
  await click('#content .card[data-imp-folder="1001"]');
  await sleep(700);
  await pickRow(3);
  await pickRow(4);
  const n6a = await readImp();
  say('  在第一个收藏夹再勾 2 个 → 已选 ' + n6a.size + '；勾着的行=' + n6a.checkedBoxes);
  if (n6a.size === 7) ok('已选 7 个（5 + 2）');
  else bad('已选数不对：' + n6a.size);

  await click('#content .pager .pager-num[data-page="2"]');
  await sleep(700);
  const n6b = await readImp();
  say('  翻到第 2 页：page=' + n6b.page + '；行数=' + n6b.rows + '；首行=' + JSON.stringify(n6b.firstTitle) + '；已选=' + n6b.size);
  if (n6b.page === 2 && n6b.rows === 30) ok('第 2 页列出 30 行');
  else bad('第 2 页不对：page=' + n6b.page + ' rows=' + n6b.rows);
  if (n6b.firstTitle === '爵士 31') ok('第 2 页首行是「爵士 31」（列表是替换不是累加）');
  else bad('第 2 页内容不对：' + JSON.stringify(n6b.firstTitle));
  if (n6b.size === 7) ok('★ 翻到第 2 页，已选还是 7 个');
  else bad('★ 翻页把选择弄丢了：' + n6b.size);

  await click('#content .pager .pager-num[data-page="1"]');
  await sleep(700);
  const n6c = await readImp();
  say('  翻回第 1 页：page=' + n6c.page + '；勾着的行=' + n6c.checkedBoxes + '；已选=' + n6c.size);
  if (n6c.page === 1 && n6c.checkedBoxes === 5) ok('★ 翻回来后前 5 行仍然勾着');
  else bad('★ 翻回来勾选丢了：page=' + n6c.page + ' checked=' + n6c.checkedBoxes);
  if (n6c.size === 7) ok('★ 翻回来总数还是 7 个');
  else bad('★ 总数变了：' + n6c.size);

  /* ================= 7) ★ 同一个视频只算一次 ================= */
  say('\n[7] ★ 同一个视频在两个收藏夹里只算一次：');
  await click('#btnImpBack');
  await sleep(350);
  await click('#content .card[data-imp-folder="1002"]');
  await sleep(700);
  const n7a = await readImp();
  say('  进第二个收藏夹：已选=' + n7a.size + '；勾着的行=' + n7a.checkedBoxes);
  // ★ 这里勾着 3 行是**对的**：f2 里第 1 条和 f1 重复，第 2、3 条正是刚才在 f2 勾的那两个。
  //   关键判据是**第 1 行（重复 bvid）自动勾上了** —— 换了个收藏夹，它认得出来。
  const dupChecked = await evalJS(`(() => {
    const p = document.querySelector('#content .track[data-i="0"] .pick');
    return !!(p && p.classList.contains('on'));
  })()`);
  if (dupChecked) ok('★ 第 1 行（与第一个收藏夹重复的 bvid）自动是勾上的');
  else bad('重复的 bvid 没被识别出来（第 1 行没勾上）');
  if (n7a.checkedBoxes === 3) ok('已选的 3 个（重复那个 + 刚在 f2 勾的 2 个）都显示为勾上');
  else bad('勾着的行数不对：' + n7a.checkedBoxes + '（应该是 3）');
  await pickRow(0);                      // 取消勾选 → 会把"那个视频"整个取消掉
  await sleep(200);
  const n7b = await readImp();
  await pickRow(0);                      // 再勾回来
  await sleep(200);
  const n7c = await readImp();
  say('  取消再勾回来：' + n7a.size + ' → ' + n7b.size + ' → ' + n7c.size);
  if (n7b.size === n7a.size - 1) ok('取消后只少了 1 个（不是少 2 个）');
  else bad('取消后的数量不对：' + n7b.size);
  if (n7c.size === n7a.size) ok('★★ 勾回来后**没有**变成 +1 —— 同一个视频只算一次');
  else bad('★★ 重复计数了：' + n7c.size + '（应该回到 ' + n7a.size + '）');

  /* ================= 8) 清空选择 ================= */
  say('\n[8] 「清空选择」：');
  await click('#btnImpClear');
  await sleep(300);
  const n8 = await readImp();
  say('  已选=' + n8.size + '；工具条=' + JSON.stringify(n8.barText));
  if (n8.size === 0) ok('已选归 0');
  else bad('清空失败：' + n8.size);
  if (n8.checkedBoxes === 0) ok('页面上的勾也全没了');
  else bad('还有勾没清掉：' + n8.checkedBoxes);

  /* ================= 9) 整个导入 / 取消整个收藏夹 ================= */
  say('\n[9] 「整个导入」→ 再点一次取消：');
  await click('#btnImpBack');
  await sleep(350);
  // ★ data-imp-whole 挂在卡片**里面的那个小按钮**上，不在卡片上 ——
  //   写成 '.card[data-imp-whole=...]' 会匹配不到，click 静默失败（第一版就栽在这）。
  const hitWhole = await click('#content [data-imp-whole="1001"]');
  if (!hitWhole) bad('收藏夹列表里找不到「整个导入」按钮');
  await sleep(1800);                     // 86 条要翻 3 页，留足时间
  const n9a = await readImp();
  const c1c = n9a.cards.find((c) => c.id === '1001');
  say('  已选=' + n9a.size + '；卡片按钮=' + JSON.stringify(c1c && c1c.btn) + '；角标=' + JSON.stringify(c1c && c1c.sel));
  if (n9a.size === 86) ok('★「整个导入」把 86 条全加进来了');
  else bad('整个导入数量不对：' + n9a.size);
  if (c1c && /取消整个收藏夹/.test(c1c.btn)) ok('按钮变成「取消整个收藏夹」');
  else bad('按钮文案不对：' + JSON.stringify(c1c && c1c.btn));
  if (c1c && /已选 86/.test(c1c.sel)) ok('角标显示「已选 86」');
  else bad('角标不对：' + JSON.stringify(c1c && c1c.sel));

  const hitWhole2 = await click('#content [data-imp-whole="1001"]');
  if (!hitWhole2) bad('第二下点不到「取消整个收藏夹」');
  await sleep(500);
  const n9b = await readImp();
  const c1d = n9b.cards.find((c) => c.id === '1001');
  say('  再点一次：已选=' + n9b.size + '；按钮=' + JSON.stringify(c1d && c1d.btn));
  if (n9b.size === 0) ok('★ 再点一次 = 取消整个收藏夹（回到 0）');
  else bad('取消整个失败：' + n9b.size);
  if (c1d && /整个导入/.test(c1d.btn)) ok('按钮变回「整个导入」');
  else bad('按钮没变回来：' + JSON.stringify(c1d && c1d.btn));

  /* ================= 10) 全选本页 / 全不选本页 ================= */
  say('\n[10] 「全选本页」/「全不选本页」：');
  await click('#content .card[data-imp-folder="1001"]');
  await sleep(700);
  await click('#btnImpPickAll');
  await sleep(350);
  const n10a = await readImp();
  say('  全选本页后：已选=' + n10a.size + '；勾着的行=' + n10a.checkedBoxes);
  if (n10a.size === 30 && n10a.checkedBoxes === 30) ok('全选本页 → 30 个（只这一页，不是 86）');
  else bad('全选本页不对：size=' + n10a.size + ' checked=' + n10a.checkedBoxes);
  await click('#btnImpPickNone');
  await sleep(350);
  const n10b = await readImp();
  if (n10b.size === 0 && n10b.checkedBoxes === 0) ok('全不选本页 → 归 0');
  else bad('全不选本页不对：size=' + n10b.size);

  /* ================= 11) 已选 0 时导入按钮置灰 ================= */
  say('\n[11] 已选 0 个时「导入」按钮置灰：');
  const n11 = await readImp();
  say('  doDisabled=' + n11.doDisabled + '；工具条=' + JSON.stringify(n11.barText));
  if (n11.doDisabled === true) ok('已选 0 个时「导入选中的 0 个」置灰不可点');
  else bad('按钮没有置灰：' + n11.doDisabled);

  /* ================= 12) 导入 → 命名 → 落地 ================= */
  say('\n[12] 选 5 个 → 导入 → 命名框 → 新歌单：');
  await pickRow(0);
  await pickRow(1);
  await pickRow(2);
  await pickRow(3);
  await pickRow(4);
  const n12a = await readImp();
  say('  已选=' + n12a.size + '；导入按钮=' + JSON.stringify(n12a.barText) + '；disabled=' + n12a.doDisabled);
  if (n12a.size === 5 && n12a.doDisabled === false) ok('选了 5 个，导入按钮可点了');
  else bad('状态不对：size=' + n12a.size + ' disabled=' + n12a.doDisabled);

  await click('#btnImpDo');
  await sleep(400);
  const n12b = await readImp();
  say('  命名框弹出=' + n12b.promptShown + '；默认名=' + JSON.stringify(n12b.promptValue));
  if (n12b.promptShown) ok('弹出了命名框');
  else bad('命名框没弹出来');
  if (n12b.promptValue === '深夜爵士') ok('默认名 = 收藏夹名「深夜爵士」');
  else bad('默认名不对：' + JSON.stringify(n12b.promptValue));

  await evalJS(`(() => { const i = document.getElementById('promptInput'); i.value = '我的爵士歌单'; return true; })()`);
  saveCalls = 0;
  await click('#promptOk');
  await sleep(600);
  const after = await evalJS(`({
    plCount: DB.playlists.length,
    name: DB.playlists[0] && DB.playlists[0].name,
    tracks: DB.playlists[0] ? DB.playlists[0].tracks.length : -1,
    view: currentView,
    rows: document.querySelectorAll('#content .track').length,
    sub: (document.querySelector('#content .block-sub') || {}).textContent || '',
    impSize: impState ? impState.selected.size : -1,
  })`);
  after.saveCalls = saveCalls;
  say('  ' + JSON.stringify(after));
  if (after.plCount === 1) ok('DB.playlists 多了 1 个歌单');
  else bad('歌单数量不对：' + after.plCount);
  if (after.saveCalls > 0) ok('建完就写盘了（store:save 被调用 ' + after.saveCalls + ' 次）');
  else bad('建完没写盘 —— 重启就没了');
  if (after.name === '我的爵士歌单') ok('名字用的是我填的「我的爵士歌单」');
  else bad('名字不对：' + after.name);
  if (after.tracks === 5) ok('新歌单里正好 5 首');
  else bad('曲目数不对：' + after.tracks);
  if (/^playlist:/.test(after.view)) ok('导入后跳到了新歌单（currentView = ' + after.view + '）');
  else bad('没有跳到新歌单：' + after.view);
  if (after.rows === 5) ok('页面显示 5 行');
  else bad('页面行数不对：' + after.rows);
  if (after.impSize === 0) ok('★ 导入成功后选择集被清空');
  else bad('★ 导入后选择集没清：' + after.impSize);

  /* ================= 13) 我的投稿 + 导入全部投稿 ================= */
  say('\n[13] 「我的投稿」也能挑，并且能一键全导：');
  upTotal = 137;
  await click('#btnImportMine');
  await sleep(500);
  await click('#btnImpUp');
  await sleep(700);
  const n13a = await readImp();
  say('  行数=' + n13a.rows + '；副标题=' + JSON.stringify(n13a.headSub) + '；页码=' + JSON.stringify(n13a.pagerNums));
  if (n13a.rows === 30) ok('我的投稿第 1 页 30 行');
  else bad('行数不对：' + n13a.rows);
  if (/共 137 个视频/.test(n13a.headSub) && /第 1 \/ 5 页/.test(n13a.headSub)) ok('副标题「' + n13a.headSub + '」');
  else bad('副标题不对：' + JSON.stringify(n13a.headSub));
  if (n13a.pagerNums.join(',') === '1,2,3,4,5') ok('分页条 5 页');
  else bad('分页条不对：' + n13a.pagerNums.join(','));

  await click('#btnImpWholeUp');
  await sleep(2200);                     // 137 条要翻 5 页
  const n13b = await readImp();
  say('  「导入全部投稿」→ 已选 ' + n13b.size);
  if (n13b.size === 137) ok('★ 一键把 137 个投稿全选上了');
  else bad('导入全部投稿数量不对：' + n13b.size);

  /* ================= 14) 页面报错 ================= */
  say('\n[14] 页面报错：');
  if (errors.length) {
    errors.slice(0, 6).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\n导入我的 B 站收藏夹实测：全部通过 ✅' : `\n导入我的 B 站收藏夹实测：${fail} 处失败 ❌`);
  finish(fail === 0 ? 0 : 1);
});
