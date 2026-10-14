/* 第十六轮需求的实测（v2.6.1：收藏夹封面不显示）

   Neo 反馈：导入页的收藏夹卡片**一个封面都没有**，全是空色块。

   根因（已用真实 Cookie 实测确认）：`getFavFolders` 用的接口
   `/x/v3/fav/folder/created/list-all` 的返回里**根本没有 cover 字段** ——
   每个收藏夹只有 id / fid / mid / attr / title / fav_state / media_count，
   所以 `toHttps(undefined)` → '' → 封面全空。
   换成**分页版** `/x/v3/fav/folder/created/list` 后，同一账号
   封面从 0/69 变成 59/69（剩下 10 个是 B 站自己没生成，cover_type:0）。

   ★ 判别力：这一组在 v2.6.0 的代码上会失败 ——
     第 1 部分会看到请求打的是 `list-all`；第 2 部分找不到 `.thumb.no-cover`。

   量什么：
     [1] 后端：请求打的是 `created/list`，**不是** `list-all`
     [2] 后端：带 pn / ps，且总数 > 100 时会翻页（150 个 → 2 次请求）
     [3] 后端：cover 走 toHttps（http:// → https://）
     [4] 后端：attr === 1 仍是私密（换接口没把「私密」判断弄坏）
     [5] 界面：有封面的卡片，.thumb 上有行内 background-image，且是 https
     [6] 界面：没封面的卡片，.thumb 带 .no-cover 类、且**没有**行内 background-image
     [7] 界面：两种卡片都还在（占位不会把卡片弄丢）
     [8] 页面报错

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round16-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ============================================================
   第 1 部分：后端 getFavFolders（纯逻辑，直接把 https.request 打桩）
   ============================================================ */
const bili = require(path.join(ROOT, 'src', 'bilibili.js'));

const MY_MID = 12345;
/* 造 150 个收藏夹：ps=100 → 应该正好翻 2 页 */
const TOTAL_FOLDERS = 150;
function stubFolder(i) {
  return {
    id: 900000 + i,
    fid: 90000 + i,
    mid: MY_MID,
    attr: i === 1 ? 1 : 22,                 // 第 1 个设成私密
    title: '收藏夹 ' + i,
    // 第 5 个故意不给封面（模拟 B 站 cover_type:0 的情况）
    cover: i === 5 ? '' : `http://i0.hdslb.com/bfs/archive/f${i}.jpg`,
    media_count: i * 3,
    cover_type: i === 5 ? 0 : 2,
  };
}
const ALL_FOLDERS = Array.from({ length: TOTAL_FOLDERS }, (_, k) => stubFolder(k + 1));

let seenUrls = [];
function fakeRes(body) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = { 'content-type': 'application/json' };
  res.setEncoding = () => {};
  res.destroy = () => {};
  setImmediate(() => { res.emit('data', body); res.emit('end'); });
  return res;
}
const realRequest = https.request;
https.request = function (opts, cb) {
  const url = `https://${opts.hostname}${opts.path}`;
  seenUrls.push(url);
  const q = new URL(url).searchParams;
  const pn = Number(q.get('pn') || 1);
  const ps = Number(q.get('ps') || 20);
  const slice = ALL_FOLDERS.slice((pn - 1) * ps, pn * ps);
  const body = JSON.stringify({ code: 0, message: 'OK', data: { count: TOTAL_FOLDERS, list: slice } });
  const req = new EventEmitter();
  req.end = () => {};
  req.destroy = () => {};
  req.setTimeout = () => {};
  setImmediate(() => cb(fakeRes(body)));
  return req;
};

/* ============================================================
   第 2 部分：界面（离屏真点）
   ============================================================ */
const UI_FOLDERS = [
  { id: 1001, title: '深夜爵士', count: 86, cover: 'https://i0.hdslb.com/bfs/archive/aaa.jpg', private: false },
  { id: 1002, title: '游戏音乐', count: 5,  cover: 'https://i1.hdslb.com/bfs/archive/bbb.jpg', private: false },
  { id: 1003, title: '学习',     count: 0,  cover: '',                                       private: true  },
];

ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:myInfo', () => ({ ok: true, data: { mid: MY_MID, name: '测试喵', face: '' } }));
ipcMain.handle('bili:favFolders', () => ({ ok: true, data: UI_FOLDERS.map((f) => ({ ...f })) }));
ipcMain.handle('bili:favMedias', () => ({ ok: true, data: { list: [], total: 0, pageSize: 30, hasMore: false } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], total: 0, pageSize: 30, hasMore: false } }));
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
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
ipcMain.on('win:mini', () => {});

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

  win.webContents.once('did-finish-load', async () => {
    await sleep(700);

    /* ================= [1]~[4] 后端 ================= */
    say('[1] 后端 getFavFolders 打的接口：');
    try {
      const folders = await bili.getFavFolders(MY_MID);

      const allList = seenUrls.every((u) => u.includes('/x/v3/fav/folder/created/list?'));
      const anyListAll = seenUrls.some((u) => u.includes('list-all'));
      if (allList && !anyListAll) ok('打的是 /folder/created/list（分页版，带 cover）');
      else bad('接口不对：' + seenUrls.map((u) => u.replace(/^https:\/\/[^/]+/, '')).join(' | '));

      say('  请求次数=' + seenUrls.length + '  第一个=' + seenUrls[0]);
      if (!anyListAll) ok('★ 没有再用 list-all（那个接口没有 cover 字段）');
      else bad('还在用 list-all —— 封面必然为空');

      /* [2] 分页 */
      say('\n[2] 分页：');
      if (seenUrls.length === 2) ok('150 个 / ps=100 → 正好 2 次请求');
      else bad('请求次数不对：' + seenUrls.length + '（应为 2）');
      const hasPn = seenUrls.some((u) => /[?&]pn=1\b/.test(u)) && seenUrls.some((u) => /[?&]pn=2\b/.test(u));
      if (hasPn) ok('pn=1 与 pn=2 都请求到了');
      else bad('pn 参数不对：' + seenUrls.join(' | '));
      if (seenUrls.every((u) => /[?&]ps=\d+/.test(u))) ok('带上了 ps 参数');
      else bad('缺 ps 参数');
      if (folders.length === TOTAL_FOLDERS) ok('两页拼起来正好 ' + TOTAL_FOLDERS + ' 个（没漏没重）');
      else bad('拼出来的数量不对：' + folders.length);

      /* [3] cover 走 toHttps */
      say('\n[3] cover 映射：');
      const withCover = folders.filter((f) => f.cover);
      const allHttps = withCover.every((f) => f.cover.startsWith('https://'));
      if (withCover.length === TOTAL_FOLDERS - 1) ok('149 个有封面、1 个没有（桩里第 5 个故意留空）');
      else bad('有封面的数量不对：' + withCover.length);
      if (allHttps) ok('★ 封面都转成了 https://（CSP 的 img-src 才放行）');
      else bad('还有 http:// 的封面，会被 CSP 拦掉');
      if (folders.find((f) => f.id === 900005).cover === '') ok('B 站没给封面的那个，老实是空字符串');
      else bad('空封面的处理不对');

      /* [4] 私密 */
      say('\n[4] 私密标记（换接口后不能坏）：');
      const priv = folders.filter((f) => f.private);
      if (priv.length === 1 && priv[0].id === 900001) ok('attr===1 的那个仍是私密');
      else bad('私密判断坏了：' + priv.map((f) => f.id).join(','));

      /* 还原 https，别影响后面 */
      https.request = realRequest;
    } catch (err) {
      https.request = realRequest;
      bad('getFavFolders 抛错：' + err.message);
    }

    /* ================= [5]~[7] 界面 ================= */
    say('\n[5] 界面：有封面的卡片：');
    const opened = await click('#btnImportMine');
    if (!opened) bad('点不到侧栏的导入按钮');
    await sleep(500);
    const wentFav = await click('#btnImpFav');
    if (!wentFav) bad('点不到「我的收藏夹」来源卡');
    await sleep(600);

    const view = await evalJS(`(() => {
      const cards = [...document.querySelectorAll('#content .card[data-imp-folder]')];
      return cards.map((c) => {
        const t = c.querySelector('.thumb');
        return {
          id: c.dataset.impFolder,
          title: c.querySelector('.c-title') ? c.querySelector('.c-title').textContent : '',
          hasNoCover: t ? t.classList.contains('no-cover') : null,
          style: t ? (t.getAttribute('style') || '') : null,
        };
      });
    })()`);
    say('  卡片：' + JSON.stringify(view));

    if (view.length === 3) ok('3 张收藏夹卡片都在');
    else bad('卡片数量不对：' + view.length);

    const c1 = view.find((c) => c.id === '1001');
    if (c1 && !c1.hasNoCover && /background-image:\s*url\(/.test(c1.style || '')) {
      ok('有封面的卡片：.thumb 上有行内 background-image');
    } else bad('有封面的卡片没画出封面：' + JSON.stringify(c1));
    if (c1 && /https:\/\/i0\.hdslb\.com/.test(c1.style || '')) ok('★ 行内用的是 https 封面地址');
    else bad('行内封面地址不对：' + (c1 && c1.style));

    say('\n[6] 界面：没封面的卡片走占位：');
    const c3 = view.find((c) => c.id === '1003');
    if (c3 && c3.hasNoCover === true) ok('★ 没封面的卡片带 .no-cover 类');
    else bad('没封面的卡片没有 .no-cover：' + JSON.stringify(c3));
    if (c3 && !/background-image/.test(c3.style || '')) ok('★ 没封面的卡片**不给**行内 background-image（好让 CSS 占位生效）');
    else bad('没封面的卡片还写着行内 background-image，会把占位盖掉：' + (c3 && c3.style));

    const cssHasNoCover = await evalJS(`(() => {
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of rules) if (r.selectorText === '.card .thumb.no-cover') return true;
      }
      return false;
    })()`);
    if (cssHasNoCover) ok('★ 样式表里有 .card .thumb.no-cover 规则（音符占位）');
    else bad('找不到 .card .thumb.no-cover 规则，占位不会显示');

    say('\n[7] 两种卡片共存：');
    if (view.filter((c) => c.hasNoCover).length === 1 && view.filter((c) => !c.hasNoCover).length === 2) {
      ok('2 张有封面 + 1 张占位，各归各的');
    } else bad('占位/封面的分布不对');

    /* ================= [8] 页面报错 ================= */
    say('\n[8] 页面报错：');
    if (errors.length) {
      errors.slice(0, 6).forEach((e) => say('    ' + e));
      bad(`页面报了 ${errors.length} 条错`);
    } else ok('全程没有页面报错');

    say(fail === 0 ? '\n收藏夹封面实测：全部通过 ✅' : `\n收藏夹封面实测：${fail} 处失败 ❌`);
    finish(fail === 0 ? 0 : 1);
  });

  win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
});
