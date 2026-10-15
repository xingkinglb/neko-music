/* 第十二轮实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.2.1 —— 真机反馈修的四个问题。

   ① 托盘菜单图标是"粉色实心方块"/空白
      → 根因：make-icons.js 里 paint 的形参写成了 (size, x, y)，
        而 renderRGBA 是按 paint(x, y) 调的 —— "x 坐标"被当成尺寸，
        算出来的缩放是乱的，写盘的 16 个 PNG 全变成纯色块或全透明。
        （接触表是另一条代码路径，所以预览图一直是对的 —— 光看图发现不了。）
  ② 悬停任务栏图标没有 ⏮ ▶ ⏭
      → 除了①（图标本身就是坏的），还有时机问题：refreshThumbar() 在
        window show() 之前就调了，setThumbarButtons 那时会静默失败。
  ③ 第一次点 ✕ 直接彻底关闭了
      → 根因：ipcMain.on('win-close') **直接调 requestMainWindowClose()**，
        绕过了 mainWindow.on('close') 里那套"询问 / 缩小 / 退出"决策。
  ④ 合集音乐播放条没有封面
      → 根因：DB.collectParts 是**故意剥掉封面**存的；v2.0.5 加的
        DB.collectCovers 只在"重新拉一遍曲目表"时才写 —— 而已经缓存过的
        合集永远走不到那条分支。用户真机上 collectCovers 是 **0 条**、
        collectParts 有 **32 个**，于是永远是音符兜底。

   ★ 能用真代码就绝不写桩：app-menus.js（关窗决策）、store-migrate.js、
     真实的 index.html + app.js（界面行为）、真实的图标 PNG（解码回来数像素）。

   ⚠️ 沙箱里测不了的（如实标注）：
     托盘图标、任务栏缩略图、JumpList 都是**系统（Explorer）画的东西**，
     离屏环境不存在 —— "长什么样"只能真机看。这一份验的是"图标字节是对的"
     （解码数像素）+ "调用时机是对的"（静态断言守着）。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round12-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ================= 真逻辑 ================= */
const menus = require(path.join(ROOT, 'src', 'app-menus.js'));
const storeMigrate = require(path.join(ROOT, 'src', 'store-migrate.js'));
const { decideCloseAction, normalizeUiState, DEFAULT_UI_STATE } = menus;

/* ================= 用户的真机情况，原样搬过来 ================= */
const BVID = 'BV1ybj66YEpv';            // 用户当时在听的那个合集
const COVER = 'https://i1.hdslb.com/bfs/archive/testcover0000000000000.jpg';
const TITLE = '探故知';

function seedStore() {
  return {
    ok: true,
    playlists: [], favorites: [], history: [],
    // ★ 故意**没有 cover 字段** —— 这就是用户存档里 lastTrack 的真实样子
    lastTrack: { bvid: BVID, cid: '39243287210', page: '1', title: TITLE, duration: '202', author: '皓晨音乐' },
    collectOff: {},
    // ★ 曲目表是缓存过的、**剥掉封面**的（32 个中的一个）
    collectParts: {
      [BVID]: [
        { bvid: BVID, cid: '39243287210', page: '1', title: '探故知', duration: '202', author: '皓晨音乐' },
        { bvid: BVID, cid: '39242957176', page: '2', title: '春涧', duration: '211', author: '皓晨音乐' },
        { bvid: BVID, cid: '39242957177', page: '3', title: '第三首', duration: '200', author: '皓晨音乐' },
      ],
    },
    collectCovers: {},   // ★ 空 —— 用户真机上就是 0 条
    settings: {
      theme: 'pink', volume: 80,
      bg: { file: null, dim: 0.55, blur: 0 },
      glass: { blur: 18, alpha: 0.55 },
      autoLyric: false, close: { action: 'ask' },
    },
  };
}

let lastSaved = seedStore();
let win = null;

/* ---------------- 主进程桩 ---------------- */
let uiState = Object.assign({}, DEFAULT_UI_STATE, { closeAction: 'ask' });
ipcMain.on('win:ui-state', (_e, st) => { uiState = normalizeUiState(st); });

const closeChoices = [];
const hideCalls = [];
const saveHandshakes = [];   // 存盘握手（win:prepare-close → win:close-ready）

ipcMain.on('win:close-choice', (_e, payload) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const action = menus.normalizeCloseAction(p.action) === 'quit' ? 'quit' : 'tray';
  closeChoices.push({ action, remember: !!p.remember });
  if (p.remember) uiState = Object.assign({}, uiState, { closeAction: action });
  if (action === 'tray') hideCalls.push('hide');
});

ipcMain.on('win:close-ready', (_e, okd) => { saveHandshakes.push('ready:' + !!okd); });

/* 取封面故意慢一点，好观察"先没封面 → 后来补上"这两段。
   ★ v2.8.0：原来延迟设 900ms，而下面 [3] 的快照正好在 sleep(900) 拍 ——
     两个 900ms 撞在一起成了**竞态**：补封面有时先回、有时后回，[3] 两条断言
     "collectCovers 应为空 / 应仍挂 no-art"会随机 FAIL。
     现在把桩延迟定成 1800ms、第二次快照前多等 2600ms（合计 ~3500ms）：
     第一拍（900ms）稳在"中间态"，第二拍（3500ms）稳在"补完态"，两头都有余量。 */
let videoInfoDelay = 1800;
let videoInfoCalls = 0;

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: BVID } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
/* v2.8.0：下载 / 本地歌曲 IPC 桩（本脚本会把"页面有报错"判 FAIL）。 */
require('./stub-download-ipc.js')();
ipcMain.handle('bili:videoInfo', async (_e, bvid) => {
  videoInfoCalls++;
  await sleep(videoInfoDelay);
  return {
    ok: true,
    data: {
      bvid, aid: 1, title: '合集·测试', cover: COVER,
      owner: { mid: 1, name: '皓晨音乐' }, duration: 202,
      pages: [
        { bvid, cid: '39243287210', page: 1, title: '探故知', duration: 202 },
        { bvid, cid: '39242957176', page: 2, title: '春涧', duration: 211 },
        { bvid, cid: '39242957177', page: 3, title: '第三首', duration: 200 },
      ],
      season: null,
    },
  };
});

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:push', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:resize', () => {});

/* ============================================================
   点 ✕ 的完整链路（★ 问题③的回归）
   ============================================================
   这一段**忠实复刻** main.js 现在的写法：
     · win-close  →  mainWindow.close()          （v2.2.1 修好之后）
     · close 事件 → preventDefault → decideCloseAction → 分流
   注：close 处理里的判断用的是**真的** decideCloseAction（src/app-menus.js），
   不是测试里抄一份。"win-close 必须走 close()"这条由 verify.js 第 50 类守着。

   测试里**永远不真的关窗口**（不然后面的组跑不了），
   所以实际关闭那一步用 saveHandshakes / hideCalls 记账。 */
const closeLog = [];
let allowCloseOnce = false;

function attachCloseHandler() {
  win.on('close', (event) => {
    event.preventDefault();   // 测试里不真关
    if (allowCloseOnce) { allowCloseOnce = false; closeLog.push('REAL-CLOSE'); return; }
    const action = decideCloseAction({ quitting: !!app.quitting, action: uiState.closeAction });
    closeLog.push(action);
    if (action === 'quit') {
      closeLog.push('requestMainWindowClose');
      saveHandshakes.push('asked');
      try { win.webContents.send('win:prepare-close'); } catch (_) {}
      return;
    }
    if (action === 'tray') { hideCalls.push('hide'); return; }
    try { win.webContents.send('win:ask-close'); } catch (_) {}
  });
}

/* ============================================================
   图标体检：把写盘的 PNG 解码回来数像素（问题①的回归）
   ============================================================ */
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let i = 8, idat = Buffer.alloc(0), w = 0, h = 0, bitDepth = 0, colorType = 0;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.slice(i + 8, i + 8 + len);
    i += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error('位深不是 8');
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(idat);
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride)); pos += stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = y > 0 ? px[prevOff + x] : 0;
      const c = (x >= ch && y > 0) ? px[prevOff + x - ch] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      line[x] = v;
    }
    line.copy(px, y * stride);
  }
  return { w, h, ch, px };
}

/* ============================================================
   开工
   ============================================================ */
app.whenReady().then(async () => {
  /* ========================================================
     [1] 图标：解码回来数像素（问题①的回归）
     ======================================================== */
  say('\n[1] 图标体检（把写盘的 .png 解码回来数像素 —— 不看预览图猜）：');
  {
    const names = ['show', 'note', 'play', 'pause', 'prev', 'next', 'mode', 'win', 'lyric', 'lock', 'settings', 'quit'];
    const all = names.map((n) => `menu-${n}.png`)
      .concat(['thumb-prev.png', 'thumb-play.png', 'thumb-pause.png', 'thumb-next.png']);
    let broken = 0;
    const rows = [];
    for (const f of all) {
      const p = path.join(ROOT, 'src/assets', f);
      if (!fs.existsSync(p)) { bad(`少了 ${f}`); broken++; continue; }
      let img;
      try { img = decodePNG(fs.readFileSync(p)); }
      catch (e) { bad(`${f} 解码失败：${e.message}`); broken++; continue; }
      let opaque = 0, inked = 0, maxA = 0;
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          const a = img.ch === 4 ? img.px[(y * img.w + x) * img.ch + 3] : 255;
          if (a > maxA) maxA = a;
          if (a > 200) { opaque++; inked++; }
          else if (a > 20) inked++;
        }
      }
      const total = img.w * img.h;
      rows.push(`${f}:${((inked / total) * 100).toFixed(0)}%/最亮${maxA}`);
      // ★ 这两个就是 v2.2.0 坏掉时的样子
      if (inked === 0) { bad(`★ ${f} 全透明（图标是空的 —— v2.2.0 的坏法之一）`); broken++; }
      else if (opaque / total > 0.95) { bad(`★ ${f} 几乎全不透明（是个纯色块 —— v2.2.0 的坏法之二）`); broken++; }
      else if (maxA < 200) { bad(`★ ${f} 最亮处只有 ${maxA}（整根线条都没对齐像素中心）`); broken++; }
      else if (inked / total < 0.03 || inked / total > 0.75) { bad(`★ ${f} 着墨比例 ${((inked / total) * 100).toFixed(0)}% 不对劲`); broken++; }
    }
    say('  ' + rows.join('  '));
    if (!broken) ok(`${all.length} 个图标像素级正常（有形状、有抗锯齿、没有纯色块也没有空白）`);
    else say(`  → ${broken} 个图标有问题`);

    // @2x 两档
    const twoX = ['menu-play@2x.png', 'menu-note@2x.png', 'thumb-play@2x.png'];
    const miss2x = twoX.filter((f) => !fs.existsSync(path.join(ROOT, 'src/assets', f)));
    if (miss2x.length) bad('少了 @2x 图标：' + miss2x.join(' / '));
    else ok('@2x 图标也在（高分屏下系统挑清楚的那张）');
  }

  /* ========================================================
     [2] 把界面加载起来
     ======================================================== */
  win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  attachCloseHandler();
  ipcMain.on('win-close', () => { if (win && !win.isDestroyed()) win.close(); });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败/i.test(msg)) {
      errors.push('[主窗口] ' + msg + '  ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const click = (id) => evalJS(`(() => { const el = document.getElementById('${id}'); if (!el) return false; el.click(); return true; })()`);

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);

  /* ========================================================
     [3] 开机：老存档的 lastTrack 没有封面 → 先是音符，补到之后贴上（问题④）
     ======================================================== */
  say('\n[3] 开机恢复那一首（v2.2.1：老存档没有封面，要自己补回来）：');
  {
    const st = await evalJS(`(() => ({
      title: document.getElementById('npTitle').textContent,
      noArt: document.getElementById('npCover').classList.contains('no-art'),
      bg: document.getElementById('npCover').style.backgroundImage,
      covers: Object.keys(DB.collectCovers || {}).length,
      parts: Object.keys(DB.collectParts || {}).length,
    }))()`);
    say(`  开机瞬间：歌名「${st.title}」  no-art=${st.noArt}  存档 collectCovers=${st.covers} / collectParts=${st.parts}`);
    if (st.title !== TITLE) bad(`播放条歌名是「${st.title}」，期望「${TITLE}」`);
    else ok(`播放条恢复了上次那首「${st.title}」`);
    if (st.parts < 1 || st.covers !== 0) bad('种子存档没按用户真机的样子准备好（collectParts 应有值、collectCovers 应为空）');
    else ok(`种子存档就是用户真机的样子：曲目表 ${st.parts} 个、封面表 ${st.covers} 条`);
    if (!st.noArt) bad('封面还没补到，播放条就已经不带 no-art 了 —— 判定可疑');
    else ok('封面还没到时挂的是音符兜底（.no-art），不是一张裂图');

    // 等补封面回来（桩延迟 1800ms，这里给到 ~2600ms 的余量）
    await sleep(2600);
    const st2 = await evalJS(`(() => ({
      noArt: document.getElementById('npCover').classList.contains('no-art'),
      bg: document.getElementById('npCover').style.backgroundImage,
      covers: (DB.collectCovers || {})['${BVID}'] || '',
    }))()`);
    say(`  补完之后：no-art=${st2.noArt}  封面=${st2.bg ? st2.bg.slice(0, 60) : '(无)'}`);
    if (st2.noArt) bad('★ 补完封面后播放条还挂着 .no-art（音符兜底）—— 用户看到的还是"没封面"');
    else ok('★ 封面补到之后播放条立刻贴上了（.no-art 摘掉）');
    if (!st2.bg || st2.bg.indexOf('hdslb') < 0) bad('播放条的背景图不是补到的那个封面地址');
    else ok('播放条的背景图就是补到的封面');
    if (!st2.covers) bad('★ 补到的封面没写进存档 collectCovers —— 下次还得再查一次');
    else ok(`封面写进了存档 collectCovers['${BVID}']（下次不用再查）`);
    if (videoInfoCalls !== 1) bad(`videoInfo 被调了 ${videoInfoCalls} 次，应该只查一次（有去重）`);
    else ok('补封面只查了一次（backfillCover 有去重，不会反复请求）');
  }

  /* ========================================================
     [4] 取缓存曲目表 → 现在应该每条都有封面了（问题④的另一半）
     ======================================================== */
  say('\n[4] 再取一次这个合集的曲目表（缓存里本来是没有封面的）：');
  {
    const r = await evalJS(`(() => {
      collectCoverMemo.delete('${BVID}');
      const list = cachedCollectEntries('${BVID}', DB.collectParts['${BVID}']);
      return { n: list.length, withCover: list.filter((e) => !!e.cover).length };
    })()`);
    say(`  ${r.n} 集，其中带封面 ${r.withCover} 集`);
    if (r.n !== 3) bad('曲目表条数不对：' + r.n);
    if (r.withCover !== r.n) bad(`★ 只有 ${r.withCover}/${r.n} 集有封面 —— 列表里还是会空一片`);
    else ok(`${r.n} 集全部拿到封面（列表里不会再空着）`);
  }

  /* ========================================================
     [5] 播放一首合集里的歌 → 播放条要有封面（问题④的核心）
     ======================================================== */
  say('\n[5] 播一首合集里的歌（封面是"后到"的，必须补贴一次）：');
  {
    // ★ [3] 用大延迟（1800ms）稳住"中间态"；从这里开始恢复成快延迟，
    //   否则 [5] 的 sleep(1500) 等不到封面（本段只关心"最终有没有贴上"，不关心中间态）。
    videoInfoDelay = 300;
    await evalJS(`(() => {
      const a = document.getElementById('audio');
      a.play = () => Promise.resolve();
      Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
      Object.defineProperty(a, 'paused', { configurable: true, get: () => false, set: () => {} });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      window.addEventListener('unhandledrejection', (e) => { console.error('NEKO-UNHANDLED ' + ((e.reason && e.reason.stack) || e.reason)); });
      return true;
    })()`);
    // 清空封面表 + 队列里放一条"没封面"的合集曲目，模拟最坏情况
    const before = await evalJS(`(() => {
      DB.collectCovers = {};
      collectCoverMemo.delete('${BVID}');
      queue = { tracks: [{ bvid: '${BVID}', cid: '39242957176', page: '2', title: '春涧', duration: '211', author: '皓晨音乐' }], index: 0, name: '测试' };
      return true;
    })()`);
    await evalJS('playAt(0)');
    await sleep(1500);
    const after = await evalJS(`(() => ({
      noArt: document.getElementById('npCover').classList.contains('no-art'),
      bg: document.getElementById('npCover').style.backgroundImage,
      title: document.getElementById('npTitle').textContent,
    }))()`);
    say(`  播放中：歌名「${after.title}」  no-art=${after.noArt}`);
    if (after.title !== '春涧') bad('播放条歌名不对：' + after.title);
    else ok('播放条切到了「春涧」');
    if (after.noArt) bad('★ 播着合集里的歌，播放条还是音符兜底 —— 这正是用户报的现象');
    else ok('★ 合集里的歌播起来后播放条有封面了（ensureCid 补到封面后会再贴一次）');
  }

  /* ========================================================
     [6] 点 ✕ → 必须弹窗问（问题③的回归）
     ======================================================== */
  say('\n[6] 点标题栏 ✕（v2.2.1：第一次必须弹窗问，不能直接退出）：');
  {
    closeLog.length = 0; hideCalls.length = 0; saveHandshakes.length = 0;
    const clicked = await click('winClose');
    if (!clicked) bad('页面上找不到 #winClose（标题栏的 ✕）');
    await sleep(400);
    const shown = await evalJS(`document.getElementById('closeMask').classList.contains('show')`);
    say('  closeLog = ' + JSON.stringify(closeLog));
    if (!closeLog.includes('ask')) bad(`★ 点 ✕ 之后的决策是 ${JSON.stringify(closeLog)}，期望走 'ask'（问一次）`);
    else ok('点 ✕ 走到了 "ask"（询问）这一步 —— 没有直接退出');
    if (!shown) bad('★ 点 ✕ 之后关窗弹窗没有出来 —— 这正是用户说的"第一次点 ✕ 直接彻底关闭"');
    else ok('★ 关窗弹窗真的弹出来了（两张大按钮 + 设为默认值）');
    if (saveHandshakes.length) bad('☆ 询问阶段不该走存盘握手，却走了：' + JSON.stringify(saveHandshakes));
    else ok('询问阶段没有提前走存盘握手（用户还要选呢）');

    const labels = await evalJS(`(() => {
      const q = document.getElementById('closeQuit'), t = document.getElementById('closeTray');
      return { quit: q ? q.textContent.replace(/\\s+/g, ' ').trim() : '', tray: t ? t.textContent.replace(/\\s+/g, ' ').trim() : '' };
    })()`);
    say(`  两张按钮：「${labels.quit}」/「${labels.tray}」`);
    if (!/彻底关闭/.test(labels.quit) || !/任务栏/.test(labels.tray)) bad('两张按钮的文案不对：' + JSON.stringify(labels));
    else ok('两张按钮文案正确（彻底关闭软件 / 缩小到任务栏）');
  }

  /* ========================================================
     [7] 弹窗里选「缩小到任务栏」
     ======================================================== */
  say('\n[7] 弹窗里选「缩小到任务栏」：');
  {
    await click('closeTray');
    await sleep(400);
    const hidden = !(await evalJS(`document.getElementById('closeMask').classList.contains('show')`));
    if (!hidden) bad('选完之后弹窗没收起');
    else ok('弹窗收起了');
    const last = closeChoices[closeChoices.length - 1];
    if (!last || last.action !== 'tray') bad('主进程没有收到 "缩小到任务栏"：' + JSON.stringify(closeChoices));
    else ok('主进程收到了 {action:"tray"}');
    if (!hideCalls.length) bad('决策是 tray，却没有走 hide()');
    else ok('窗口走了 hide()（藏起来，歌继续放）');
  }

  /* ========================================================
     [8] 设成 tray 之后再点 ✕ → 不再问，直接藏
     ======================================================== */
  say('\n[8] 设置成「缩小到任务栏」后，再点 ✕：');
  {
    uiState = Object.assign({}, uiState, { closeAction: 'tray' });
    closeLog.length = 0; hideCalls.length = 0;
    await click('winClose');
    await sleep(300);
    const shown = await evalJS(`document.getElementById('closeMask').classList.contains('show')`);
    say('  closeLog = ' + JSON.stringify(closeLog));
    if (shown) bad('设成"缩小到任务栏"之后还在弹窗问');
    else ok('不再弹窗了');
    if (!closeLog.includes('tray')) bad('决策不是 tray：' + JSON.stringify(closeLog));
    else ok('决策是 tray（直接藏起来）');
    if (!hideCalls.length) bad('没有走 hide()');
    else ok('走了 hide()');
  }

  /* ========================================================
     [9] 设成 quit 之后点 ✕ → 走存盘握手
     ======================================================== */
  say('\n[9] 设置成「彻底关闭软件」后，再点 ✕（要真走存盘握手，不能丢数据）：');
  {
    uiState = Object.assign({}, uiState, { closeAction: 'quit' });
    closeLog.length = 0; saveHandshakes.length = 0;
    await click('winClose');
    await sleep(700);
    say('  closeLog = ' + JSON.stringify(closeLog) + '  saveHandshakes = ' + JSON.stringify(saveHandshakes));
    if (!closeLog.includes('quit')) bad('决策不是 quit：' + JSON.stringify(closeLog));
    else ok('决策是 quit（彻底退出）');
    if (!saveHandshakes.includes('asked')) bad('没有发起存盘握手（win:prepare-close）');
    else ok('发起了存盘握手（win:prepare-close）');
    if (!saveHandshakes.some((s) => s === 'ready:true')) bad('界面没有回 win:close-ready:true —— 存档可能没存完就退了');
    else ok('界面回了 close-ready:true（存档存完了才放行关闭）');
  }

  /* ========================================================
     [10] "正在退出"时点 ✕ → 永远真退（不能被"缩到托盘"拦住）
     ======================================================== */
  say('\n[10] app.quitting = true（托盘菜单点「退出」）时点 ✕：');
  {
    app.quitting = true;
    uiState = Object.assign({}, uiState, { closeAction: 'tray' });   // 故意设成 tray
    closeLog.length = 0; hideCalls.length = 0;
    await click('winClose');
    await sleep(300);
    say('  closeLog = ' + JSON.stringify(closeLog));
    if (!closeLog.includes('quit')) bad('★ "正在退出"时决策不是 quit —— 托盘里点退出会被"缩到托盘"拦住');
    else ok('★ "正在退出"压过一切：就算设成 tray 也真退');
    if (hideCalls.length) bad('"正在退出"时还走了 hide()');
    else ok('没有走 hide()');
    app.quitting = false;
  }

  /* ========================================================
     [11] 页面报错
     ======================================================== */
  say('\n[11] 页面报错检查：');
  if (errors.length) { errors.forEach((e) => bad(e)); }
  else ok('页面没有报错');

  say('');
  if (fail === 0) say('第十二轮实测全部通过 ✅');
  else say(`第十二轮实测有 ${fail} 处失败 ❌`);
  finish(fail ? 1 : 0);
});
