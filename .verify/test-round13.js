/* 第十三轮需求的实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.4.0 —— ① mini 置顶  ② 长歌名不撑爆播放条

   ★ 这一份和 test-round10.js 一样，窗口那一半用的是 **src/win-mini.js 里的真代码**
     （handleMiniRequest / applyMiniBounds / restoreFullBounds / setMiniAlwaysOnTop），
     所以"置顶到底开没开"是拿**真窗口的 isAlwaysOnTop()** 验的，不是读代码猜的。

   量什么：
     [1] 进 mini → 真窗口 isAlwaysOnTop() 为 true（以前随便一个窗口都能盖住它）
     [2] setMiniAlwaysOnTop 直调：on → true，off → false（真窗口来回切）
     [3] 退出 mini → 取消置顶（完整模式不该赖在最上面）
     [4] 长歌名：5 种长度（6 / 27 / 43 / 50 / 100 字）
         播放条宽度不许超过窗口；♡ ☰ ✕▢ 的 right 都必须在窗口内；不许出现横向滚动条
     [5] 长作者名：作者名不许被挤成 0 宽（标题先让位）
     [6] 全程没有页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ 本沙箱里渲染进程的沙箱起不来，必须加 --no-sandbox 才能跑。
//   这只是"测试环境"的开关，不进应用代码（src/main.js 里没有这些）。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round13-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ★ 真逻辑：进出 mini 怎么编排、置顶怎么开关，全在这里 */
const {
  MINI_W, MINI_H_COLLAPSED, MINI_H_EXPANDED,
  handleMiniRequest, setMiniAlwaysOnTop,
} = require(path.join(ROOT, 'src', 'win-mini.js'));

/* ---------- 主进程桩 ---------- */
let win = null;

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1song0001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({
  ok: true,
  data: { bvid, aid: 1, title: '普通歌', cover: '', owner: { mid: 1, name: '测试UP' }, duration: 200, pages: [{ bvid, cid: 7, page: 1, title: '普通歌', duration: 200 }], season: null },
}));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

const winCalls = [];
ipcMain.on('win-min', () => winCalls.push('min'));
ipcMain.on('win-max', () => winCalls.push('max'));
ipcMain.on('win-close', () => winCalls.push('close'));
ipcMain.on('win:close-ready', () => winCalls.push('close-ready'));
ipcMain.on('win:fullscreen', () => winCalls.push('fullscreen'));

/* ★ mini：界面发过来的请求，交给 win-mini.js 里的真逻辑处理 */
const miniState = { on: false, expanded: false, fullBounds: null };
ipcMain.on('win:mini', (_e, opts) => {
  const st = handleMiniRequest(win, miniState, opts, screen.getPrimaryDisplay().workAreaSize);
  say(`  [ipc win:mini] opts=${JSON.stringify(opts)} → 置顶=${win && !win.isDestroyed() ? win.isAlwaysOnTop() : '(窗口没了)'}`);
  try { win.webContents.send('win:mini-state', { on: st.on, expanded: st.expanded }); } catch (_) {}
});

const TOL = 2;
const near = (a, b) => Math.abs(a - b) <= TOL;

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
  const click = (id) => evalJS(`(() => { document.getElementById('${id}').click(); return true; })()`);
  const onTop = () => (win && !win.isDestroyed() ? win.isAlwaysOnTop() : null);

  const boot = async () => {
    await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
    await sleep(1000);
    await evalJS(`(() => {
      // 掐掉音频：沙箱没声卡，audio.play() 必然失败（环境产物）
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      window.__paused = true;
      Object.defineProperty(a, 'paused', { configurable: true, get: () => window.__paused, set: (v) => { window.__paused = !!v; } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.__mk = (bvid, title) => ({ bvid, cid: 7, title, author: '测试UP', mid: 1, cover: '', duration: 200 });
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    await sleep(150);
  };
  await boot();

  /* 灌一个 5 首的队列（mini 列表要用），当前第 3 首 */
  await evalJS(`(() => {
    const rows = Array.from({ length: 5 }, (_, i) => window.__mk('BV1mini' + i, '示例歌曲 ' + (i + 1)));
    queue = { tracks: rows, index: 2, name: '测试来源' };
    renderAll();
    return true;
  })()`);
  await sleep(200);

  /* ================= 0) 进 mini 前：不该置顶 ================= */
  say('\n[0] 进 mini 前（完整模式）：');
  say(`  isAlwaysOnTop() = ${onTop()}`);
  if (onTop() === true) bad('完整模式下就已经置顶了 —— 普通窗口不该赖在最上面');
  else ok('完整模式下没有置顶');

  /* ================= 1) 进 mini → 真窗口置顶 ================= */
  say('\n[1] 进 mini（收起态）→ 真窗口 isAlwaysOnTop()：');
  await click('btnMini');
  await sleep(600);
  const miniBounds = win.getBounds();
  say(`  mini 窗口 ${miniBounds.width}×${miniBounds.height}；isAlwaysOnTop() = ${onTop()}`);
  if (!near(miniBounds.width, MINI_W)) bad(`mini 窗口宽 ${miniBounds.width}，应该是 ${MINI_W}`);
  else ok(`mini 窗口宽 ≈ ${MINI_W}（实测 ${miniBounds.width}）`);
  if (onTop() !== true) bad('进了 mini 但窗口没置顶 —— 随便一个窗口都能盖住它（这就是 Neo 报的问题）');
  else ok('mini 窗口已置顶（isAlwaysOnTop() === true）');

  /* ================= 2) 展开态仍然置顶 ================= */
  say('\n[2] 展开成"播放条 + 队列"仍然置顶：');
  await click('btnQueue');
  await sleep(550);
  const expBounds = win.getBounds();
  say(`  展开态 ${expBounds.width}×${expBounds.height}；isAlwaysOnTop() = ${onTop()}`);
  if (!near(expBounds.height, MINI_H_EXPANDED)) bad(`展开态高 ${expBounds.height}，应该是 ${MINI_H_EXPANDED}`);
  else ok(`展开态高 ≈ ${MINI_H_EXPANDED}（实测 ${expBounds.height}）`);
  if (onTop() !== true) bad('展开后置顶丢了 —— 展开态也必须在最上面');
  else ok('展开态仍然置顶');
  await click('btnQueue');   // 收回收起态
  await sleep(450);

  /* ================= 3) setMiniAlwaysOnTop 直调 ================= */
  say('\n[3] setMiniAlwaysOnTop 直调（真窗口来回切）：');
  setMiniAlwaysOnTop(win, false);
  await sleep(120);
  const offNow = onTop();
  setMiniAlwaysOnTop(win, true);
  await sleep(120);
  const onNow = onTop();
  say(`  传 false → isAlwaysOnTop()=${offNow}；传 true → isAlwaysOnTop()=${onNow}`);
  if (offNow !== false) bad('传 false 之后窗口还在置顶');
  else ok('传 false → 取消置顶');
  if (onNow !== true) bad('传 true 之后窗口没置顶');
  else ok('传 true → 置顶');

  /* ================= 4) 长歌名不撑爆播放条 ================= */
  say('\n[4] 长歌名：播放条宽度 / 右边那排图标是否越界：');
  const CASES = [
    ['短标题 + 短作者', '示例歌曲 1', '测试UP'],
    ['中等标题', '【真栗x巴老师】《此生不换》要分散不习惯 怎么算都太难', '九思JIUS'],
    ['长标题 + 长作者', '【Hi-Res无损音质】盘点2026浅影阿130首歌曲合集 全网最全收藏版 持续更新中', '某个名字很长的UP主昵称'],
    ['长标题 + 短作者', '【真栗】跨时空合唱《看得见的自己》从呆萌少女到大姐姐，你依然是如初的少年啊这一行要非常非常长才能撑爆', '真栗'],
    ['超长无空格标题', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'UP'],
  ];

  for (const [label, title, author] of CASES) {
    await evalJS(`(() => {
      // 直接照 playAt() 里那两行写（playAt 会走网络，测试里不跑）
      document.getElementById('npTitle').textContent = ${JSON.stringify(title)};
      document.getElementById('npSub').textContent = ${JSON.stringify(author)};
      return true;
    })()`);
    await sleep(320);

    const m = await evalJS(`(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }; };
      const pl = document.getElementById('player');
      return {
        winW: window.innerWidth,
        docScrollW: document.documentElement.scrollWidth,
        playerW: Math.round(pl.getBoundingClientRect().width),
        heart: box('.heart-btn'), vol: box('.vol-wrap'), queue: box('#btnQueue'),
        actions: box('.mini-actions'), title: box('.np-title'), sub: box('.np-sub'),
        titleLen: document.getElementById('npTitle').textContent.length,
      };
    })()`);

    say(`  ── ${label}（标题 ${m.titleLen} 字 / 作者「${author}」）`);
    say(`     视口 ${m.winW}  播放条宽 ${m.playerW}  docScrollW ${m.docScrollW}  ` +
        `♡right=${m.heart && m.heart.right} ☰right=${m.queue && m.queue.right} ✕▢right=${m.actions && m.actions.right} ` +
        `标题w=${m.title && m.title.w} 作者w=${m.sub && m.sub.w}`);

    // 播放条不许超过窗口（以前 50 字被撑到 684、100 字到 992）
    if (m.playerW > m.winW + 1) bad(`${label}：播放条被撑到 ${m.playerW} 宽，超过窗口 ${m.winW}`);
    else ok(`${label}：播放条 ${m.playerW} ≤ 窗口 ${m.winW}`);
    // 不许出现横向滚动
    if (m.docScrollW > m.winW + 1) bad(`${label}：出现了横向滚动（docScrollW=${m.docScrollW} > ${m.winW}）`);
    else ok(`${label}：没有横向滚动`);
    // 右边那排图标都必须在窗口内
    for (const [name, b] of [['♡', m.heart], ['☰', m.queue], ['✕▢', m.actions]]) {
      if (!b) { bad(`${label}：取不到 ${name} 的盒子`); continue; }
      if (b.right > m.winW + 1) bad(`${label}：${name} 越界了（right=${b.right}，窗口宽 ${m.winW}）`);
      else ok(`${label}：${name} 在窗口内（right=${b.right}）`);
    }
    // 标题也得在窗口内（不该被 nowrap 撑出去）
    if (m.title && m.title.right > m.winW + 1) bad(`${label}：歌名越界（right=${m.title.right}）`);
    else if (m.title) ok(`${label}：歌名在窗口内（right=${m.title.right}）`);
  }

  /* ================= 5) 长作者名不许被挤没 ================= */
  say('\n[5] 超长作者名：作者名不许被挤成 0 宽（标题先让位）：');
  await evalJS(`(() => {
    document.getElementById('npTitle').textContent = '${'标'.repeat(60)}';
    document.getElementById('npSub').textContent = '${'某个名字特别特别长的UP主昵称测试'.repeat(3)}';
    return true;
  })()`);
  await sleep(320);
  const subCase = await evalJS(`(() => {
    const t = document.querySelector('.np-title').getBoundingClientRect();
    const s = document.querySelector('.np-sub').getBoundingClientRect();
    return { titleW: Math.round(t.width), titleRight: Math.round(t.right), subW: Math.round(s.width), subRight: Math.round(s.right), winW: window.innerWidth };
  })()`);
  say(`  标题宽 ${subCase.titleW}（right=${subCase.titleRight}）；作者宽 ${subCase.subW}（right=${subCase.subRight}）`);
  if (subCase.subW < 40) bad(`超长作者名被挤成 ${subCase.subW}px 宽 —— 至少该留 40px 给它`);
  else ok(`超长作者名仍有 ${subCase.subW}px 宽（没被挤没）`);
  if (subCase.subRight > subCase.winW + 1) bad(`作者名越界（right=${subCase.subRight} > ${subCase.winW}）`);
  else ok(`作者名在窗口内（right=${subCase.subRight}）`);

  /* ================= 6) 退出 mini → 取消置顶 ================= */
  say('\n[6] 退出 mini：窗口不该再置顶：');
  await click('btnRestoreFull');
  await sleep(650);
  const afterBounds = win.getBounds();
  say(`  退出后 ${afterBounds.width}×${afterBounds.height}；isAlwaysOnTop() = ${onTop()}`);
  if (onTop() !== false) bad('退出 mini 后窗口还置顶 —— 完整模式会一直压在别的软件上面');
  else ok('退出 mini 后已取消置顶');
  if (!near(afterBounds.width, 1180)) bad(`退出后宽度 ${afterBounds.width}，应该回到 1180`);
  else ok(`退出后宽度 ≈ 1180（实测 ${afterBounds.width}）`);

  /* ================= 7) 页面报错 ================= */
  say('\n[7] 页面报错：');
  if (errors.length) {
    errors.slice(0, 6).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\nmini 置顶 + 长歌名实测：全部通过 ✅' : `\nmini 置顶 + 长歌名实测：${fail} 处失败 ❌`);
  finish(fail === 0 ? 0 : 1);
});
