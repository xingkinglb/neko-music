/* 第二十五轮：v2.10.0 五项改动的离线实测（离屏渲染 + 真跑应用代码）

   改的是什么：
     A. 禁止选中界面文字（鼠标一划就选蓝、Ctrl+A 全选整个窗口）
     B. 批量选择的操作条吸顶（选到列表下半部分不用再滚回顶部）
     C. 按住鼠标拖动多选（按行区间整段选中，拖到边缘自动滚动）
     D. 「我喜欢」「歌单」两页加列表内搜索；「播放全部」删掉
     E. 播放条加「定位」按钮（跳回这首歌的来源页面并滚到那一行）

   量什么（★ = 这条最要紧）：
     [A1] body 的 user-select = none；输入框是 text
     [A2] ★ 在列表上按住鼠标划一下，选区是空的
     [A3] ★ Ctrl+A 不会选中界面文字
     [A4] ★ 批量选择模式下 Ctrl+A = 全选歌曲
     [B1] 滚到 400px 后 .pick-bar 仍贴在内容区顶部，而 .block-head 已经滚上去
     [C1] ★ 从第 1 行拖到第 4 行 → 4 行全勾上
     [C2] ★ 在已勾的行上反向拖 → 这一段被取消
     [C3] ★ 拖过头再拖回来 → 离开区间的行恢复原样
     [C4] ★ 松手后补发的 click 不会把第一行翻回去
     [C5] 单击仍然能正常切换
     [D1] 点图标 → 输入框出现并自动聚焦
     [D2] ★ 输入即筛，而且**焦点还在输入框里**（不能每敲一个字就失焦）
     [D3] 搜作者名也能命中
     [D4] ★ 合集内部匹配 → 该行留下并带「内含 N 集」小标
     [D5] ★ 搜索中点全选 → 只选筛选出来的那几首
     [D6] Esc 清空并收起
     [D7] 换页面自动清空搜索词
     [D8] ★ 反向断言：「播放全部」按钮已经不在
     [E1] ★ 从歌单点歌 → 队列记下了来源
     [E2] ★ 切到别的页 → 点定位 → 回到歌单、目标行在可视区、并且有高亮
     [E3] ★ 来源不明 → 退回打开播放队列（按钮点了必须有反应）
     [E4] mini 下 #btnLocate 是 display:none
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
const REPORT = path.join(__dirname, 'test-round25-report.txt');
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
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200,
          pages: [{ bvid, cid: 900, page: 1, title: '普通歌', duration: 200 }], season: null },
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

require('./stub-download-ipc.js')();

let win = null;
let evalJS = null;

/* 12 首歌，够撑出一屏滚动；其中第 5 首是个"已展开过"的合集 */
const TRACKS = Array.from({ length: 12 }, (_, i) => ({
  bvid: 'BVr25_' + i, cid: 500 + i, page: 1,
  title: '测试曲 ' + (i + 1), author: '歌手' + (i % 3), duration: 180 + i, cover: '', mid: 1,
}));
TRACKS[0].title = '晴天';
TRACKS[4].title = '晴天（一小时合集）';
TRACKS[4].duration = 3600;

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
  const send = (type, p, extra = {}) => win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1, ...extra });

  /** 第 i 行中心点的窗口坐标 */
  const rowPt = (i) => evalJS(`(() => {
    const r = document.querySelectorAll('#content .track')[${i}];
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  const rowPtSel = (i) => evalJS(`(() => {
    const r = document.querySelectorAll('#content .track.pickable')[${i}];
    if (!r) return null;
    const b = r.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    DB.settings.download = { dir: 'C:\\\\fake-dl' };
    window.addEventListener('unhandledrejection', (e) => {
      console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason));
    });
    return true;
  })()`);

  const gotoFav = (tracks) => evalJS(`(() => {
    DB.favorites = ${JSON.stringify(tracks)};
    selPick = null; listSearch = ''; listSearchOpen = false; listSearchView = '';
    currentView = 'favorites';
    renderAll();
    return true;
  })()`);

  const gotoPl = (tracks) => evalJS(`(() => {
    DB.playlists = [{ id: 'plx', name: '测试歌单', tracks: ${JSON.stringify(tracks)} }];
    selPick = null; listSearch = ''; listSearchOpen = false; listSearchView = '';
    renderPlaylist('plx');
    return true;
  })()`);

  /* ============================================================
     A. 禁止选中界面文字
     ============================================================ */
  say('=== A. 禁止选中界面文字 ===');
  await gotoFav(TRACKS.slice(0, 6));
  await sleep(200);

  const us = await evalJS(`({
    body: getComputedStyle(document.body).userSelect,
    row: getComputedStyle(document.querySelector('#content .track')).userSelect,
    title: getComputedStyle(document.querySelector('#content .block-title')).userSelect,
  })`);
  if (us.body === 'none' && us.row === 'none' && us.title === 'none')
    ok('[A1] body / 歌曲行 / 标题都是 user-select: none');
  else bad(`[A1] user-select 没生效：${JSON.stringify(us)}`);

  // 输入框必须还能选
  await evalJS(`openListSearch(); true`);
  await sleep(300);
  const usInput = await evalJS(`(() => {
    const el = document.getElementById('listSearchInput');
    return el ? getComputedStyle(el).userSelect : 'no-input';
  })()`);
  if (usInput === 'text') ok('[A1] 搜索框仍是 user-select: text（能正常选字）');
  else bad(`[A1] 搜索框不能选字了：${usInput}`);
  await evalJS(`closeListSearch(); true`);
  await sleep(200);

  // 真按住鼠标划一下，选区必须是空的
  {
    const p1 = await rowPt(0), p2 = await rowPt(2);
    send('mouseDown', p1);
    await sleep(50);
    for (let k = 1; k <= 4; k++) {
      send('mouseMove', { x: p1.x + 120, y: Math.round(p1.y + (p2.y - p1.y) * k / 4) });
      await sleep(40);
    }
    send('mouseUp', p2);
    await sleep(200);
    const sel = await evalJS(`String(window.getSelection())`);
    if (sel === '') ok('[A2] ★ 按住鼠标在列表上划一下，选区是空的');
    else bad(`[A2] ★ 划一下选中了文字：${JSON.stringify(sel.slice(0, 40))}`);
  }

  // Ctrl+A 不许选中界面文字
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); true`);
  await sleep(150);
  {
    const sel = await evalJS(`String(window.getSelection())`);
    if (sel === '') ok('[A3] ★ Ctrl+A 没有选中界面文字');
    else bad(`[A3] ★ Ctrl+A 选中了：${JSON.stringify(sel.slice(0, 40))}`);
  }

  // 批量选择模式下 Ctrl+A = 全选歌曲
  await click('#btnSelectFav');
  await sleep(250);
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); true`);
  await sleep(300);
  {
    const n = await evalJS(`selPick ? selPick.selected.size : -1`);
    if (n === 6) ok('[A4] ★ 批量选择模式下 Ctrl+A = 全选歌曲（6 首）');
    else bad(`[A4] ★ Ctrl+A 全选得到 ${n} 首，期望 6`);
  }

  /* ============================================================
     B. 选择条吸顶
     ============================================================ */
  say('\n=== B. 选择条吸顶 ===');
  // 6 首撑不满一屏，滚不动 —— 换成 30 首，内容区才有得滚
  await gotoFav(Array.from({ length: 30 }, (_, i) => ({
    bvid: 'BVsb' + i, cid: 700 + i, title: '滚动曲 ' + (i + 1), author: 'UP', duration: 120, cover: '',
  })));
  await sleep(200);
  await click('#btnSelectFav');
  await sleep(250);
  {
    const pos = await evalJS(`getComputedStyle(document.querySelector('#content .pick-bar')).position`);
    if (pos === 'sticky') ok('[B1] .pick-bar 是 position: sticky');
    else bad(`[B1] .pick-bar 的 position 是 ${pos}`);
  }

  // 滚到 400px，看条子还在不在顶部
  await evalJS(`(() => { document.getElementById('content').scrollTop = 400; return true; })()`);
  await sleep(400);
  {
    const m = await evalJS(`(() => {
      const box = document.getElementById('content').getBoundingClientRect();
      const bar = document.querySelector('#content .pick-bar').getBoundingClientRect();
      const head = document.querySelector('#content .block-head').getBoundingClientRect();
      return {
        barGap: Math.round(bar.top - box.top),
        headTop: Math.round(head.top - box.top),
        scrollTop: Math.round(document.getElementById('content').scrollTop),
      };
    })()`);
    if (m.scrollTop < 300) bad(`[B1] 没滚动起来（scrollTop=${m.scrollTop}），后面的断言没意义`);
    else if (m.barGap >= -1 && m.barGap <= 4) ok(`[B1] ★ 滚到 ${m.scrollTop}px 后，选择条仍贴在顶部（距上沿 ${m.barGap}px）`);
    else bad(`[B1] ★ 滚下去之后选择条跑了：距上沿 ${m.barGap}px`);
    if (m.headTop < -100) ok('[B1] 标题已经滚上去了（说明确实在滚，不是条子没动）');
    else bad(`[B1] 标题没滚上去（top=${m.headTop}），这条断言测不出吸顶`);
  }
  await evalJS(`(() => { document.getElementById('content').scrollTop = 0; selPick = null; renderAll(); return true; })()`);
  await sleep(250);

  /* ---- B2 滚下去以后还能直接退出（v2.10.1） ---- */
  {
    // ★ B1 那段结尾把 selPick 清掉了（它只是量 sticky），所以这里要重新进一次选择模式
    await click('#btnSelectFav');
    await sleep(300);
    // 滚到中间 —— 此时标题已经滚走了，顶部那颗「退出批量选择」看不到
    await evalJS(`(() => { document.getElementById('content').scrollTop = 400; return true; })()`);
    await sleep(350);
    const m = await evalJS(`(() => {
      const box = document.getElementById('content').getBoundingClientRect();
      const exit = document.getElementById('btnSelPickExit');
      if (!exit) return { has: false };
      const rb = exit.getBoundingClientRect();
      const head = document.querySelector('#content .block-head').getBoundingClientRect();
      return {
        has: true,
        exitInView: rb.top >= box.top - 2 && rb.bottom <= box.bottom + 2,
        headGone: head.top - box.top < -50,
      };
    })()`);
    if (!m.has) bad('[B2] ★ 吸顶条里没有「退出」按钮');
    else {
      if (m.exitInView && m.headGone)
        ok('[B2] ★ 滚到 400px 后「退出」仍在可视区（顶部那颗已经滚走了）');
      else bad(`[B2] ★ 退出按钮没跟着吸顶：${JSON.stringify(m)}`);
      await click('#btnSelPickExit');
      await sleep(350);
      const after = await evalJS(`({ pick: !!selPick, rows: document.querySelectorAll('#content .track.pickable').length })`);
      if (!after.pick && after.rows === 0) ok('[B2] ★ 点吸顶条里的「退出」→ 真的退出了选择模式');
      else bad(`[B2] ★ 点了退出没生效：${JSON.stringify(after)}`);
    }
    await evalJS(`(() => { document.getElementById('content').scrollTop = 0; return true; })()`);
    await sleep(250);
  }

  /* ============================================================
     C. 拖动多选
     ============================================================ */
  say('\n=== C. 按住鼠标拖动多选 ===');
  await gotoFav(TRACKS.slice(0, 10));
  await sleep(200);
  await click('#btnSelectFav');
  await sleep(250);

  const pickedArr = () => evalJS(`[...document.querySelectorAll('#content .track.pickable')].map((r) => r.classList.contains('picked'))`);
  const selSize = () => evalJS(`selPick ? selPick.selected.size : -1`);

  /* ---- C1 正向拖 ---- */
  {
    const a = await rowPtSel(0), b = await rowPtSel(3);
    send('mouseDown', a);
    await sleep(60);
    for (let k = 1; k <= 4; k++) {
      send('mouseMove', { x: a.x, y: Math.round(a.y + (b.y - a.y) * k / 4) });
      await sleep(45);
    }
    send('mouseUp', b);
    await sleep(350);
    const arr = await pickedArr();
    if (arr.slice(0, 4).every(Boolean) && !arr.slice(4).some(Boolean) && (await selSize()) === 4)
      ok('[C1] ★ 从第 1 行拖到第 4 行 → 正好 4 行勾上');
    else bad(`[C1] ★ 正向拖结果不对：${JSON.stringify(arr)} size=${await selSize()}`);
  }

  /* ---- C2 在已勾的行上反向拖 = 取消这一段 ---- */
  {
    const a = await rowPtSel(3), b = await rowPtSel(1);
    send('mouseDown', a);
    await sleep(60);
    for (let k = 1; k <= 3; k++) {
      send('mouseMove', { x: a.x, y: Math.round(a.y + (b.y - a.y) * k / 3) });
      await sleep(45);
    }
    send('mouseUp', b);
    await sleep(350);
    const arr = await pickedArr();
    // 第 2、3、4 行原本勾着 → 反向拖把它们取消；第 1 行不在区间里，保持勾着
    if (arr[0] && !arr[1] && !arr[2] && !arr[3] && (await selSize()) === 1)
      ok('[C2] ★ 在已勾的行上反向拖 → 这一段被取消，区间外的第 1 行保留');
    else bad(`[C2] ★ 反向拖结果不对：${JSON.stringify(arr)} size=${await selSize()}`);
  }

  /* ---- C3 拖过头再拖回来 ---- */
  await evalJS(`(() => { selPick = null; renderAll(); document.getElementById('btnSelectFav').click(); return true; })()`);
  await sleep(300);
  {
    const a = await rowPtSel(0), far = await rowPtSel(5), back = await rowPtSel(2);
    send('mouseDown', a);
    await sleep(60);
    send('mouseMove', far); await sleep(90);
    send('mouseMove', back); await sleep(140);
    send('mouseUp', back);
    await sleep(350);
    const arr = await pickedArr();
    if (arr.slice(0, 3).every(Boolean) && !arr.slice(3).some(Boolean))
      ok('[C3] ★ 拖到第 6 行再退回第 3 行 → 只有前 3 行勾着（拖过头的被恢复了）');
    else bad(`[C3] ★ 拖过头再拖回的结果不对：${JSON.stringify(arr)}`);
  }

  /* ---- C4 松手后补发的 click 不会翻回去 ---- */
  {
    // 拖选之后紧接着派发一次 click（浏览器就是这么干的），第一行不能被翻掉
    await evalJS(`(() => {
      const r = document.querySelectorAll('#content .track.pickable')[0];
      if (r) r.click();
      return true;
    })()`);
    await sleep(250);
    const arr = await pickedArr();
    if (arr[0] === true && arr[1] === true && arr[2] === true)
      ok('[C4] ★ 拖选后补发的 click 被吃掉了（前 3 行还是勾着）');
    else bad(`[C4] ★ 补发的 click 把第一行翻掉了：${JSON.stringify(arr)}`);
  }

  /* ---- C5 单击仍然可用 ---- */
  {
    const before = await selSize();
    await evalJS(`document.querySelectorAll('#content .track.pickable')[7].click(); true`);
    await sleep(250);
    const after = await selSize();
    if (after === before + 1) ok('[C5] 单击仍然能正常切换（+1）');
    else bad(`[C5] 单击失效：${before} → ${after}`);
  }

  /* ============================================================
     D. 列表内搜索 + 播放全部已删
     ============================================================ */
  say('\n=== D. 列表内搜索 ===');
  await evalJS(`(() => {
    selPick = null;
    DB.playlists = [{ id: 'pls', name: '搜索测试', tracks: ${JSON.stringify(TRACKS)} }];
    // 假装第 5 首那个合集以前展开过 → 本地有曲目缓存，里面有两集带「晴天」
    DB.collectParts = { 'BVr25_4': [
      { bvid: 'BVr25_4', cid: 41, page: 1, title: '晴天 (Live)', duration: 200, author: '某UP' },
      { bvid: 'BVr25_4', cid: 42, page: 2, title: '七里香', duration: 200, author: '某UP' },
      { bvid: 'BVr25_4', cid: 43, page: 3, title: '晴天 (钢琴版)', duration: 200, author: '某UP' },
    ] };
    listSearch = ''; listSearchOpen = false; listSearchView = '';
    renderPlaylist('pls');
    return true;
  })()`);
  await sleep(250);

  {
    const ids = await evalJS(`[...document.querySelectorAll('#content .block-actions button')].map((b) => b.id)`);
    if (!ids.includes('btnPlayFav') && !ids.includes('btnPlayPl') && !ids.includes('btnPlayAll'))
      ok(`[D8] ★ 「播放全部」已经不在（现在只有 ${ids.join(' / ')}）`);
    else bad(`[D8] ★ 「播放全部」还在：${JSON.stringify(ids)}`);
  }

  await click('#btnListSearch');
  await sleep(300);
  {
    const r = await evalJS(`({ has: !!document.getElementById('listSearchInput'), focus: document.activeElement && document.activeElement.id })`);
    if (r.has && r.focus === 'listSearchInput') ok('[D1] 点图标 → 输入框出现并自动聚焦');
    else bad(`[D1] 搜索框没展开 / 没聚焦：${JSON.stringify(r)}`);
  }

  const typeSearch = async (v) => {
    await evalJS(`(() => {
      const el = document.getElementById('listSearchInput');
      el.focus();
      el.value = ${JSON.stringify(v)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(280);
  };

  await typeSearch('晴天');
  {
    const r = await evalJS(`({
      rows: document.querySelectorAll('#content .track').length,
      titles: [...document.querySelectorAll('#content .track .t')].map((e) => e.textContent),
      focus: document.activeElement && document.activeElement.id,
      sub: (document.querySelector('#content .block-sub') || {}).textContent,
    })`);
    if (r.rows === 2 && r.titles.includes('晴天（一小时合集）'))
      ok(`[D2] ★ 搜「晴天」→ 2 行（${r.titles.join(' / ')}）`);
    else bad(`[D2] ★ 搜索结果不对：${JSON.stringify(r)}`);
    if (r.focus === 'listSearchInput') ok('[D2] ★ 输入之后焦点仍在搜索框里（没有每敲一个字就失焦）');
    else bad(`[D2] ★ 输入后失焦了：activeElement=${r.focus}`);
    // ★ v2.11.0 改了口径：副标题按"展开后的数量"算 —— 那个合集行（缓存里 3 集）
    //   算 3 首，所以 12 行 = 14 首、搜到的 2 行（1 首 + 1 个合集）= 4 首。
    //   （以前是数行数，写 2 / 12。）
    if (/找到 4 首 \/ 共 14 首/.test(r.sub)) ok(`[D2] 副标题写着「${r.sub}」（合集按集数算）`);
    else bad(`[D2] 副标题不对：「${r.sub}」，期望「找到 4 首 / 共 14 首」`);
  }

  {
    const chips = await evalJS(`[...document.querySelectorAll('#content .hit-chip')].map((e) => e.textContent.trim())`);
    if (chips.length === 1 && /内含 2 集/.test(chips[0]))
      ok(`[D4] ★ 合集内部匹配 → 挂上了「${chips[0]}」（缓存里正好 2 集带"晴天"）`);
    else bad(`[D4] ★ 合集内部匹配的小标不对：${JSON.stringify(chips)}`);
  }

  await typeSearch('歌手1');
  {
    const titles = await evalJS(`[...document.querySelectorAll('#content .track .t')].map((e) => e.textContent)`);
    if (titles.length === 4) ok(`[D3] 搜作者名「歌手1」→ 4 首（${titles.join(' / ')}）`);
    else bad(`[D3] 搜作者名得到 ${titles.length} 首：${JSON.stringify(titles)}`);
  }

  /* ---- D5 搜索中全选只选筛选结果 ---- */
  await typeSearch('晴天');
  await click('#btnSelectPl');
  await sleep(300);
  await click('#btnSelPickAll');
  await sleep(300);
  {
    const r = await evalJS(`({ n: selPick ? selPick.selected.size : -1, rows: document.querySelectorAll('#content .track').length })`);
    if (r.n === 2 && r.rows === 2) ok('[D5] ★ 搜索中点「全选」→ 只选中筛选出来的 2 首');
    else bad(`[D5] ★ 搜索中全选得到 ${r.n} 首（列表里 ${r.rows} 行），期望 2`);
  }
  await evalJS(`(() => { selPick = null; renderPlaylist('pls'); return true; })()`);
  await sleep(250);

  /* ---- D9 搜索词自动带进合集面板（v2.10.0 修订） ---- */
  await evalJS(`(() => {
    selPick = null;
    listSearch = ''; listSearchOpen = false; listSearchView = '';
    renderPlaylist('pls');
    return true;
  })()`);
  await sleep(250);
  await click('#btnListSearch');
  await sleep(250);
  await typeSearch('晴天');
  {
    // 点合集行上的「选集」徽章
    const hasBadge = await evalJS(`!!document.querySelector('#content .track .badge')`);
    if (!hasBadge) bad('[D9] 合集行上没有「选集」徽章，这条测不了');
    else {
      await evalJS(`(() => { const b = document.querySelector('#content .track .badge'); b.click(); return true; })()`);
      await sleep(700);
      const r = await evalJS(`({
        input: document.getElementById('collectSearch').value,
        rows: [...document.querySelectorAll('#collectList .collect-row .ct')].map((e) => e.textContent),
        open: document.getElementById('collectMask').classList.contains('show'),
      })`);
      if (r.open && r.input === '晴天')
        ok(`[D9] ★ 点开合集 → 面板的搜索框自动填上了「${r.input}」（不用再打一遍）`);
      else bad(`[D9] ★ 面板没带上搜索词：${JSON.stringify(r)}`);
      if (r.rows.length === 2 && r.rows.every((t) => /晴天/.test(t)))
        ok(`[D9] ★ 面板里只剩匹配的 2 集（${r.rows.join(' / ')}）`);
      else bad(`[D9] ★ 面板没按搜索词过滤：${JSON.stringify(r.rows)}`);
      await evalJS(`closeCollectPanel(); true`);
      await sleep(250);
    }
  }

  /* ---- D6 Esc 清空并收起 ---- */
  await click('#btnListSearch');
  await sleep(250);
  await typeSearch('晴天');
  await evalJS(`(() => {
    const el = document.getElementById('listSearchInput');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  {
    const r = await evalJS(`({ q: listSearch, open: listSearchOpen, rows: document.querySelectorAll('#content .track').length, input: !!document.getElementById('listSearchInput') })`);
    if (r.q === '' && !r.open && r.rows === 12 && !r.input)
      ok('[D6] Esc → 清空搜索词、收起输入框、列表恢复 12 行');
    else bad(`[D6] Esc 没收拾干净：${JSON.stringify(r)}`);
  }

  /* ---- D7 换页面清空 ---- */
  await click('#btnListSearch');
  await sleep(250);
  await typeSearch('晴天');
  await evalJS(`(() => { currentView = 'favorites'; DB.favorites = ${JSON.stringify(TRACKS.slice(0, 3))}; renderAll(); return true; })()`);
  await sleep(250);
  {
    const r = await evalJS(`({ q: listSearch, rows: document.querySelectorAll('#content .track').length })`);
    if (r.q === '' && r.rows === 3) ok('[D7] 换页面后搜索词自动清空（列表恢复 3 行）');
    else bad(`[D7] 换页后没清空：${JSON.stringify(r)}`);
  }

  /* ============================================================
     E. 播放条「定位」
     ============================================================ */
  say('\n=== E. 播放条「定位」 ===');
  await evalJS(`(() => {
    DB.playlists = [{ id: 'pll', name: '定位歌单', tracks: ${JSON.stringify(TRACKS.slice(0, 12))} }];
    selPick = null; listSearch = ''; listSearchOpen = false; listSearchView = '';
    renderPlaylist('pll');
    return true;
  })()`);
  await sleep(250);

  // 点第 10 行播放
  await evalJS(`document.querySelectorAll('#content .track')[9].click(); true`);
  await sleep(800);
  {
    const r = await evalJS(`({
      view: currentView,
      src: queue.source && queue.source.view,
      idx: queue.index,
      title: (queue.tracks[queue.index] || {}).title,
    })`);
    if (r.src === 'playlist:pll' && /测试曲 10/.test(r.title))
      ok(`[E1] ★ 从歌单点第 10 行 → 队列记下来源「${r.src}」，当前是「${r.title}」（队列第 ${r.idx} 项，会被合集摊平影响，不参与断言）`);
    else bad(`[E1] ★ 来源没记对：${JSON.stringify(r)}`);
  }

  // 切到别的页，再点定位
  await evalJS(`(() => { currentView = 'history'; DB.history = []; renderAll(); return true; })()`);
  await sleep(250);
  await click('#btnLocate');
  await sleep(500);
  {
    const r = await evalJS(`(() => {
      const box = document.getElementById('content').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#content .track')];
      const flash = rows.findIndex((x) => x.classList.contains('locate-flash'));
      const target = rows[9];
      const rb = target ? target.getBoundingClientRect() : null;
      return {
        view: currentView,
        flashRow: flash,
        inView: rb ? (rb.top >= box.top - 2 && rb.bottom <= box.bottom + 2) : false,
        scrollTop: Math.round(document.getElementById('content').scrollTop),
      };
    })()`);
    if (r.view === 'playlist:pll') ok('[E2] ★ 点定位 → 跳回了那个歌单');
    else bad(`[E2] ★ 没跳回去：currentView=${r.view}`);
    if (r.inView) ok(`[E2] ★ 目标行滚进了可视区（scrollTop=${r.scrollTop}）`);
    else bad(`[E2] ★ 目标行不在可视区：${JSON.stringify(r)}`);
    if (r.flashRow === 9) ok('[E2] ★ 目标行带了高亮（locate-flash）');
    else bad(`[E2] ★ 高亮加错行了：${r.flashRow}`);
  }

  // 来源不明 → 打开队列抽屉
  await evalJS(`(() => {
    currentView = 'favorites'; DB.favorites = ${JSON.stringify(TRACKS.slice(0, 3))}; renderAll();
    playTracks(DB.favorites, 1, '手动塞的');
    return true;
  })()`);
  await sleep(400);
  await click('#btnLocate');
  await sleep(400);
  {
    const r = await evalJS(`({
      mask: document.getElementById('queueMask').classList.contains('show'),
      flashInQueue: !!document.querySelector('#queueList .collect-row.locate-flash'),
      toast: (document.getElementById('toast') || {}).textContent || '',
    })`);
    if (r.mask) ok('[E3] ★ 来源不明 → 退回打开播放队列（按钮点了有反应）');
    else bad(`[E3] ★ 来源不明时没打开队列：${JSON.stringify(r)}`);
    if (r.flashInQueue) ok('[E3] 队列里也定位到了当前那一项');
    else bad('[E3] 队列里没定位到当前项');
    await evalJS(`closeQueue(); true`);
    await sleep(200);
  }

  // mini 下必须藏起来
  {
    const d = await evalJS(`(() => { setMini(true, false); return getComputedStyle(document.getElementById('btnLocate')).display; })()`);
    await sleep(200);
    if (d === 'none') ok('[E4] mini 下 #btnLocate 是 display:none');
    else bad(`[E4] mini 下 #btnLocate 还在：display=${d}`);
    await evalJS(`setMini(false, false); true`);
    await sleep(250);
  }

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
