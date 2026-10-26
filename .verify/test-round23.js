/* 第二十三轮：v2.9.0 的三处改动实测（离屏渲染 + 真跑应用代码）

   本轮没有新页面，改的是三个"用起来别扭"的地方：
     A. mini 条上的 ✕（关程序）→ 换成「词」（桌面歌词开关）
     B. 歌曲行右侧按钮：除了"悬停显示"，多一档"一直显示"（亮度可调）
     C. 导入收藏夹：除了"新建歌单"，还能"加入现有歌单"

   量什么：
     [A1] mini 条上有 #miniLyric、没有 #miniClose
     [A2] ★ 点它 = 开桌面歌词（真的发 lyric:open），再点一次 = 关
     [A3] ★ 按钮状态跟着走（.on 亮起 / 关掉后熄灭）
     [B1] ★ 切到「一直显示」→ body 上有 ops-always，未悬停那行的按钮 opacity ≈ 0.55
     [B2] ★ 亮度调满 → opacity ≈ 1；调回 30% → ≈ 0.3
     [B3] ★ 切回「悬停显示」→ opacity 回到 0
     [B4] ★ 反向断言：挑视频那一屏（.track.pickable）的按钮仍然 display:none
     [C1] ★ 点「导入」先问"到哪儿"：列出已有歌单 + 「新建一个歌单…」
     [C2] ★ 选已有歌单 → 歌加进去了、跳到那个歌单、选择集清空
     [C3] ★ 重复导入 → 一首都不加（按 sameTrack 判重），提示说清"已在歌单里"
     [C4] 一个歌单都没有 → 直接进"新建"那一屏，不多问一次
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
const REPORT = path.join(__dirname, 'test-round23-report.txt');
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
let saveCalls = 0;
ipcMain.handle('store:load', () => ({ ok: true, data: memStore }));
ipcMain.handle('store:save', (_e, d) => { saveCalls += 1; memStore = d; return { ok: true, data: true }; });
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

/* ★ 桌面歌词窗口：主进程侧只数次数（真窗口在离屏环境里没意义） */
let lyricOpenCalls = 0, lyricCloseCalls = 0;
ipcMain.on('lyric:open', () => { lyricOpenCalls += 1; });
ipcMain.on('lyric:close', () => { lyricCloseCalls += 1; });
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:line', () => {});
ipcMain.on('lyric:move', () => {});
ipcMain.on('ui-state', () => {});

require('./stub-download-ipc.js')();

let win = null;
let evalJS = null;

/* 测试用的歌：6 首，bvid 各不相同 */
const TRACKS = Array.from({ length: 6 }, (_, i) => ({
  bvid: 'BVtest' + i, cid: 100 + i, page: 1,
  title: '测试歌 ' + (i + 1), author: '测试UP', duration: 200, cover: '', mid: 1,
}));

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

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  /* 音频全部打桩：不真的播，也不去取网络 */
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason));
    });
    return true;
  })()`);

  /* ============================================================
     A. mini 条：✕ → 「词」
     ============================================================ */
  say('=== A. mini 条上的「词」开关 ===');

  const has = await evalJS(`({
    lyric: !!document.getElementById('miniLyric'),
    close: !!document.getElementById('miniClose'),
    acts: !!document.querySelector('.mini-actions'),
  })`);
  if (has.lyric && !has.close) ok('[A1] mini 条上有 #miniLyric、#miniClose 已经拿掉');
  else bad(`[A1] mini 条结构不对：miniLyric=${has.lyric} miniClose=${has.close}`);

  // 进 mini
  await evalJS(`setMini(true, false); true`);
  await sleep(200);
  const inMini = await evalJS(`({ mini: document.body.classList.contains('mini'), on: (typeof mini !== 'undefined') && mini.on })`);
  if (inMini.mini && inMini.on) ok('已进入 mini 模式');
  else bad(`[A] 没进 mini：${JSON.stringify(inMini)}`);

  // 点「词」→ 应该真的去开桌面歌词
  lyricOpenCalls = 0;
  await click('#miniLyric');
  await sleep(250);
  const afterOpen = await evalJS(`({
    on: !!(typeof lw === 'function' && lw().on),
    cls: (document.getElementById('miniLyric') || {}).className || '',
    autoLyric: !!(typeof DB !== 'undefined' && DB.settings.autoLyric),
  })`);
  if (lyricOpenCalls === 1 && afterOpen.on) ok('[A2] 点「词」→ 发了 lyric:open，桌面歌词已开');
  else bad(`[A2] 点「词」没开桌面歌词：calls=${lyricOpenCalls} on=${afterOpen.on}`);
  if (/\bon\b/.test(afterOpen.cls)) ok('[A3] 按钮亮起（.on）');
  else bad(`[A3] 按钮没亮：class="${afterOpen.cls}"`);
  if (afterOpen.autoLyric) ok('[A2] 顺手把「自动加载歌词」也开了（联动没丢）');
  else bad('[A2] 开了桌面歌词却没联动开「自动加载歌词」');

  // 再点一次 → 关
  await click('#miniLyric');
  await sleep(250);
  const afterClose = await evalJS(`({
    on: !!(typeof lw === 'function' && lw().on),
    cls: (document.getElementById('miniLyric') || {}).className || '',
  })`);
  if (lyricCloseCalls >= 1 && !afterClose.on) ok('[A2] 再点一次 → 桌面歌词关掉');
  else bad(`[A2] 再点没关掉：closeCalls=${lyricCloseCalls} on=${afterClose.on}`);
  if (!/\bon\b/.test(afterClose.cls)) ok('[A3] 按钮熄灭');
  else bad(`[A3] 关了之后按钮还亮着：class="${afterClose.cls}"`);

  await evalJS(`setMini(false, false); true`);
  await sleep(200);

  /* ============================================================
     B. 歌曲行右侧按钮：悬停 / 一直显示
     ============================================================ */
  say('\n=== B. 歌曲行右侧按钮的显示方式 ===');

  // 铺一屏列表（用「我喜欢的」，最直白）
  await evalJS(`(() => {
    DB.favorites = ${JSON.stringify(TRACKS)};
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);
  await sleep(200);

  const rowOK = await evalJS(`!!document.querySelector('#content .track .ops .op-ic')`);
  if (rowOK) ok('列表里画出了行内按钮（.ops > .op-ic）');
  else bad('列表里没画出行内按钮，后面的断言没意义');

  /** 读第一行 .ops 的 computed opacity（切档后要等 transition，所以外面会 sleep） */
  const opsOpacity = () => evalJS(`(() => {
    const el = document.querySelector('#content .track .ops');
    if (!el) return -1;
    return Number(getComputedStyle(el).opacity);
  })()`);

  const setOps = (mode, alpha) => evalJS(`(() => {
    DB.settings.listOps = ${JSON.stringify(mode)};
    ${alpha === undefined ? '' : `DB.settings.opsOpacity = ${alpha};`}
    applyOpsMode();
    return true;
  })()`);

  const o0 = await opsOpacity();
  if (o0 === 0) ok('[B0] 默认（悬停档）未悬停时 opacity = 0（老行为没变）');
  else bad(`[B0] 默认档未悬停时 opacity=${o0}，应该是 0`);

  await setOps('always');
  await sleep(300);
  const o1 = await opsOpacity();
  const cls1 = await evalJS(`document.body.classList.contains('ops-always')`);
  if (cls1) ok('[B1] body 上有 ops-always');
  else bad('[B1] 切到「一直显示」但 body 上没有 ops-always');
  if (Math.abs(o1 - 0.55) < 0.02) ok(`[B1] 常显时压到 55%（实测 ${o1}）`);
  else bad(`[B1] 常显时不透明度=${o1}，期望 ≈0.55`);

  await setOps('always', 100);
  await sleep(300);
  const o2 = await opsOpacity();
  if (Math.abs(o2 - 1) < 0.02) ok(`[B2] 亮度拉满 → opacity = 1（实测 ${o2}）`);
  else bad(`[B2] 亮度拉满后 opacity=${o2}，期望 1`);

  await setOps('always', 30);
  await sleep(300);
  const o3 = await opsOpacity();
  if (Math.abs(o3 - 0.3) < 0.02) ok(`[B2] 亮度调到 30% → opacity ≈ 0.3（实测 ${o3}）`);
  else bad(`[B2] 亮度 30% 时 opacity=${o3}`);

  await setOps('hover');
  await sleep(300);
  const o4 = await opsOpacity();
  if (o4 === 0) ok('[B3] 切回「悬停显示」→ opacity 回到 0');
  else bad(`[B3] 切回悬停档后 opacity=${o4}，应该是 0`);

  // ★ 反向断言：常显档下，挑视频那一屏的按钮仍必须藏起来（它是 display，不是 opacity）
  await setOps('always', 100);
  await sleep(200);
  const pickable = await evalJS(`(() => {
    const row = document.querySelector('#content .track');
    if (!row) return null;
    row.classList.add('pickable');
    const d = getComputedStyle(row.querySelector('.ops')).display;
    row.classList.remove('pickable');
    return d;
  })()`);
  if (pickable === 'none') ok('[B4] ★ 挑视频那一屏（.pickable）的按钮仍然 display:none —— 常显没把它顶开');
  else bad(`[B4] ★ 常显档下 .track.pickable .ops 的 display=${pickable}，应该是 none`);

  // 顺手验一下设置页控件读得到（不是"设置里根本没法选"）
  const uiOps = await evalJS(`(() => {
    DB.settings.listOps = 'always'; DB.settings.opsOpacity = 70;
    syncSettingsUI();
    return {
      sel: (document.getElementById('selListOps') || {}).value,
      rng: (document.getElementById('rngOpsAlpha') || {}).value,
      label: (document.getElementById('valOpsAlpha') || {}).textContent,
      off: (document.getElementById('fieldOpsAlpha') || { classList: { contains: () => null } }).classList.contains('is-off'),
    };
  })()`);
  if (uiOps.sel === 'always' && String(uiOps.rng) === '70' && uiOps.label === '70%')
    ok('[B5] 设置页回填正确（下拉 = always，滑杆 = 70%，标签 = 70%）');
  else bad(`[B5] 设置页回填不对：${JSON.stringify(uiOps)}`);
  if (uiOps.off === false) ok('[B5] 常显档下"亮度"那一行没有置灰');
  else bad('[B5] 常显档下"亮度"那一行被置灰了');

  // 悬停档时亮度行应置灰
  const uiOps2 = await evalJS(`(() => {
    DB.settings.listOps = 'hover'; syncSettingsUI();
    return (document.getElementById('fieldOpsAlpha') || { classList: { contains: () => null } }).classList.contains('is-off');
  })()`);
  if (uiOps2 === true) ok('[B5] 悬停档下"亮度"那一行置灰（没有意义就别让人调）');
  else bad('[B5] 悬停档下"亮度"那一行没有置灰');

  /* ★★ [B6] 带「合集 N」徽章的行 / 不带徽章的行，右边那排按钮必须**贴在同一条竖线上**。
     踩过的坑：网格 6 列，但行里元素是按条件拼的 —— 没有徽章的行只有 5 个元素，
     自动排布把「时长」塞进徽章那列、「操作」塞进时长那列，第 6 列空着；
     空列虽没宽度，但 gap:13px 还在 → 那一行按钮组整体左移 13px。
     修法是把 ops / dur / badge 按"从右往左数"钉死在固定列上（style.css）。 */
  const align = await evalJS(`(() => {
    const mk = (dur, title) => ({ bvid: 'BV' + title, cid: 1, page: 1, title,
      author: 'UP', duration: dur, cover: '', mid: 1 });
    DB.favorites = [mk(200, '普通一首'), mk(1900, '一个很长的合集')];
    currentView = 'favorites';
    renderAll();
    const rows = [...document.querySelectorAll('#content .track')];
    const withBadge = rows.find((r) => r.querySelector('.badge'));
    const noBadge = rows.find((r) => !r.querySelector('.badge'));
    if (!withBadge || !noBadge) return { missing: true, n: rows.length };
    return {
      withBadge: Math.round(withBadge.querySelector('.ops').getBoundingClientRect().right),
      noBadge: Math.round(noBadge.querySelector('.ops').getBoundingClientRect().right),
      durWith: Math.round(withBadge.querySelector('.dur').getBoundingClientRect().right),
      durNo: Math.round(noBadge.querySelector('.dur').getBoundingClientRect().right),
    };
  })()`);
  if (align.missing) bad(`[B6] 没造出"有徽章 / 没徽章"两种行（渲染出 ${align.n} 行），没法验对齐`);
  else if (Math.abs(align.withBadge - align.noBadge) <= 1)
    ok(`[B6] ★ 带徽章和不带徽章的行，按钮组右边缘对齐（${align.withBadge} vs ${align.noBadge}）`);
  else
    bad(`[B6] ★ 按钮组没对齐：有徽章 ${align.withBadge}、没徽章 ${align.noBadge}（差 ${align.noBadge - align.withBadge}px）`);
  if (!align.missing && Math.abs(align.durWith - align.durNo) <= 1)
    ok(`[B6] ★ 时长也钉在同一列（${align.durWith} vs ${align.durNo}）`);
  else if (!align.missing)
    bad(`[B6] ★ 时长没对齐：有徽章 ${align.durWith}、没徽章 ${align.durNo}`);

  /* ============================================================
     C. 导入收藏夹：新建 / 加入现有
     ============================================================ */
  say('\n=== C. 导入时能加入现有歌单 ===');

  // 先摆两个歌单，第一个里已经有 2 首（用来验判重）
  await evalJS(`(() => {
    DB.playlists = [
      { id: 'pl-a', name: '我的通勤', tracks: ${JSON.stringify(TRACKS.slice(0, 2))} },
      { id: 'pl-b', name: '深夜电台', tracks: [] },
    ];
    return true;
  })()`);

  /** 造一个"选好了 4 首"的导入态，然后触发导入（不 await —— 它要等弹窗） */
  const startImport = (tracks) => evalJS(`(() => {
    impState = {
      step: 'list', me: { mid: 1, name: '我' }, loading: false, error: '', errorReason: '',
      folders: [{ id: 11, title: '收藏夹一', count: 4 }],
      source: 'fav', folderId: 11, folderName: '收藏夹一', list: [], page: 0, pageSize: 30, total: 4,
      selected: new Map(${JSON.stringify(tracks)}.map((t) => [t.bvid, { track: t, from: 11 }])),
    };
    currentView = 'importMine';
    window.__importDone = false;
    importPicked().then(() => { window.__importDone = true; });
    return true;
  })()`);

  const readDialog = () => evalJS(`(() => {
    const mask = document.getElementById('promptMask');
    return {
      show: !!(mask && mask.classList.contains('show')),
      title: (document.getElementById('promptTitle') || {}).textContent || '',
      rows: [...document.querySelectorAll('#promptBody .pl-row')].map((r) => ({
        id: r.dataset.pl, name: (r.querySelector('span') || {}).textContent || '',
        n: (r.querySelector('.n') || {}).textContent || '',
      })),
      hasNew: !!document.getElementById('impNew'),
      hasName: !!document.getElementById('impName'),
    };
  })()`);

  // C1：选 4 首（其中 2 首已在 pl-a 里）→ 弹窗应该列出两个歌单 + 新建
  await startImport(TRACKS.slice(0, 4));
  await sleep(300);
  const dlg = await readDialog();
  if (dlg.show) ok('[C1] 点导入先问"到哪儿"（弹窗出来了）');
  else bad('[C1] 点导入没弹"到哪儿"的窗');
  if (dlg.rows.length === 2) ok(`[C1] 列出了 2 个现有歌单（${dlg.rows.map((r) => r.name + '/' + r.n).join('、')}）`);
  else bad(`[C1] 现有歌单列了 ${dlg.rows.length} 个，应该是 2`);
  if (dlg.hasNew) ok('[C1] 也有「新建一个歌单…」这个选项');
  else bad('[C1] 弹窗里没有「新建一个歌单…」');

  // C2：选「我的通勤」（已有 2 首）→ 4 首里只该加进 2 首新的
  const clickPl = (id) => evalJS(`(() => {
    const el = [...document.querySelectorAll('#promptBody .pl-row')].find((r) => r.dataset.pl === ${JSON.stringify(id)});
    if (!el) return false; el.click(); return true;
  })()`);
  await clickPl('pl-a');
  await sleep(400);
  const afterAdd = await evalJS(`({
    n: (DB.playlists.find((p) => p.id === 'pl-a') || { tracks: [] }).tracks.length,
    view: currentView,
    sel: (typeof impState !== 'undefined' && impState) ? impState.selected.size : -1,
    toast: (document.getElementById('toast') || {}).textContent || '',
    promptOpen: document.getElementById('promptMask').classList.contains('show'),
  })`);
  if (afterAdd.n === 4) ok(`[C2] 4 首进了「我的通勤」（原有 2 首 + 新的 2 首 = ${afterAdd.n}）`);
  else bad(`[C2] 「我的通勤」现在 ${afterAdd.n} 首，应该是 4（重复的不该再加）`);
  if (afterAdd.view === 'playlist:pl-a') ok('[C2] 导入后跳到了那个歌单');
  else bad(`[C2] 导入后当前视图是 ${afterAdd.view}，应该是 playlist:pl-a`);
  if (afterAdd.sel === 0) ok('[C2] 选择集已清空');
  else bad(`[C2] 选择集还有 ${afterAdd.sel} 首没清`);
  if (/2 首/.test(afterAdd.toast) && /已在歌单里/.test(afterAdd.toast))
    ok(`[C2] 提示说清了"加了几首、几首重复"：「${afterAdd.toast}」`);
  else bad(`[C2] 提示没说清重复情况：「${afterAdd.toast}」`);
  if (!afterAdd.promptOpen) ok('[C2] 弹窗已关闭');
  else bad('[C2] 落地了但弹窗还开着');

  // C3：同样的 4 首再导一次 → 一首都不该加
  await startImport(TRACKS.slice(0, 4));
  await sleep(300);
  await clickPl('pl-a');
  await sleep(400);
  const again = await evalJS(`({
    n: (DB.playlists.find((p) => p.id === 'pl-a') || { tracks: [] }).tracks.length,
    toast: (document.getElementById('toast') || {}).textContent || '',
  })`);
  if (again.n === 4) ok(`[C3] 重复导入一首都没加（仍是 ${again.n} 首）`);
  else bad(`[C3] 重复导入后变成 ${again.n} 首 —— 判重失效了`);
  if (/都已经在/.test(again.toast)) ok(`[C3] 提示改成了"都已经在歌单里"：「${again.toast}」`);
  else bad(`[C3] 全重复时的提示不对：「${again.toast}」`);

  // C4：新建那条路还在（走 showNew → 填名字 → 导入）
  await startImport(TRACKS.slice(0, 3));
  await sleep(300);
  await click('#impNew');
  await sleep(200);
  const newDlg = await readDialog();
  if (newDlg.hasName) ok('[C4] 点「新建一个歌单…」进到了命名那一屏');
  else bad('[C4] 点「新建」没进命名屏');
  const defName = await evalJS(`(document.getElementById('impName') || {}).value || ''`);
  if (defName) ok(`[C4] 名字预填了「${defName}」（来自收藏夹名）`);
  else bad('[C4] 名字没有预填');

  await evalJS(`(() => { document.getElementById('impName').value = '新的一个'; return true; })()`);
  await click('#impOk');
  await sleep(400);
  const afterNew = await evalJS(`(() => {
    const pl = DB.playlists.find((p) => p.name === '新的一个');
    return { exists: !!pl, n: pl ? pl.tracks.length : -1, view: currentView,
             total: DB.playlists.length };
  })()`);
  if (afterNew.exists && afterNew.n === 3) ok('[C4] 新建那条路照样能用（3 首进了新歌单）');
  else bad(`[C4] 新建失败：${JSON.stringify(afterNew)}`);
  if (afterNew.view === 'playlist:' + (await evalJS(`(DB.playlists.find((p) => p.name === '新的一个') || {}).id || ''`)))
    ok('[C4] 新建后也跳到了新歌单');
  else bad('[C4] 新建后没跳过去');

  // C5：一个歌单都没有 → 直接进新建，不多问一次
  await evalJS(`(() => { DB.playlists = []; return true; })()`);
  await startImport(TRACKS.slice(0, 2));
  await sleep(300);
  const emptyDlg = await readDialog();
  if (emptyDlg.hasName && emptyDlg.rows.length === 0)
    ok('[C5] 没有歌单时直接进"命名"那一屏（不多问一次）');
  else bad(`[C5] 空歌单时的弹窗不对：${JSON.stringify(emptyDlg)}`);
  await evalJS(`closePrompt(null); true`);

  /* ============================================================
     Z. 收尾
     ============================================================ */
  say('');
  if (errors.length) {
    bad(`页面有 ${errors.length} 条报错：`);
    errors.slice(0, 6).forEach((e) => say('       ' + e));
  } else {
    ok('[Z] 全程没有页面报错');
  }

  say('\n' + (fail ? `发现 ${fail} 处问题 ❌` : '全部通过 ✅'));
  finish(fail ? 1 : 0);
}).catch(die);
