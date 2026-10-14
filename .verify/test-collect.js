/* 合集 / 分P 展开面板的实测（离屏渲染 + 合成真实鼠标事件）：
     · 疑似合集的"长视频"行有没有出现「选集」徽章，普通歌行有没有被误加
     · 点徽章能不能滑出右侧面板，并把 134 个分P 全列出来
     · 点某一集能不能真的切成那一集播放；正在播的那一集有没有高亮
     · 面板里搜索能不能过滤；点某一行能不能把整段塞进队列
     · v2.4.0：「加入队列」按钮已删（它把搜索框挤成一个字），搜索框要有 ≥150px
     · 点空白 / 按 Esc 能不能收起；徽章点击该不该误触发"整行播放"
     · 一个"标题像合集、其实只有 1P"的假阳性：点徽章要能优雅回退成直接播
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-collect-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* 造一份"134 个分P"的视频详情，字段形状与 bilibili.js 的 getVideoInfo 输出一致
   （它已把 B 站原始 pages[].part 映射成 pages[].title，所以这里也用 title）。 */
const SONG_NAMES = ['探故知', '春涧', '谪居', '情字最大', '游山鱼', '不怕', '画离弦', '游京'];
const PAGES = Array.from({ length: 134 }, (_, i) => ({
  bvid: 'BV1ybj66YEpv', cid: 39240000000 + i, page: i + 1,
  title: SONG_NAMES[i % SONG_NAMES.length] + (i >= SONG_NAMES.length ? ' ' + (Math.floor(i / SONG_NAMES.length) + 1) : ''),
  duration: 120 + ((i * 7) % 180),
}));
const COLLECT_BVID = 'BV1ybj66YEpv';
const FAKE_BVID = 'BVfake00001';
const NORMAL_BVID = 'BV1normal01';

const collectInfo = {
  bvid: COLLECT_BVID, aid: 1,
  title: '【Hi-Res无损音质】盘点2026浅影阿130首歌曲合集',
  cover: '', owner: { mid: 1, name: '皓晨音乐' }, duration: 25532,
  pages: PAGES, season: null,
};
const singleInfo = (bvid, title) => ({
  bvid, aid: 2, title, cover: '', owner: { mid: 1, name: '测试UP' }, duration: 221,
  pages: [{ bvid, cid: 1, page: 1, title, duration: 221 }], season: null,
});

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => {
  if (bvid === COLLECT_BVID) return { ok: true, data: collectInfo };
  if (bvid === FAKE_BVID) return { ok: true, data: singleInfo(FAKE_BVID, '无损精选 1首') };
  return { ok: true, data: singleInfo(bvid, '普通歌曲') };
});
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: '', quality: 30280, duration: 200, backup: [] } }));

/* v2.8.0：下载 / 本地歌曲的 IPC 桩。渲染层启动必打一次 download:list，
   不打桩控制台就会挂一条 "No handler registered"（桩缺了，不是产品坏了）。
   详见 stub-download-ipc.js 顶部的说明。 */
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);
  /* ★ 沙箱没有音频设备：把 play 换成直接成功、把 src 的写入掐掉。
     否则每首歌都会"播放失败 → 900ms 后自动跳下一首"，一路连环跳下去，
     队列下标就变成随机的了（那是环境产物，不是应用缺陷）。 */
  await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    return true;
  })()`);
  await sleep(150);

  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const centerOf = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })()`);

  /* ---- 铺一份搜索结果：一条 130首合集 + 一条普通歌 + 一条"标题像合集其实只有1P" ---- */
  await evalJS(`(() => {
    searchKeyword = '测试';
    searchResults = [
      { bvid: '${COLLECT_BVID}', cid: null, page: 1, title: '【Hi-Res无损音质】盘点2026浅影阿130首歌曲合集', author: '皓晨音乐', cover: '', duration: 25532 },
      { bvid: '${NORMAL_BVID}', cid: null, page: 1, title: '大鱼', author: '周深', cover: '', duration: 312 },
      { bvid: '${FAKE_BVID}', cid: null, page: 1, title: '无损精选 1首', author: '测试UP', cover: '', duration: 221 },
    ];
    currentView = 'search';
    renderSearch();
    return searchResults.length;
  })()`);

  const rowInfo = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('#content .track')];
    return rows.map((r) => ({
      title: r.querySelector('.t').textContent,
      badge: r.querySelector('.badge') ? r.querySelector('.badge').textContent.trim() : null,
    }));
  })()`);
  say('\n--- 列表里的徽章 ---');
  rowInfo.forEach((r) => say(`  「${r.title.slice(0, 26)}」徽章=${r.badge || '(无)'}`));

  const badgeCount = rowInfo.filter((r) => r.badge).length;
  if (badgeCount === 2 && rowInfo[1].badge === null) ok('只有疑似合集的长视频行有徽章，普通歌行没被误加');
  else bad(`徽章出现次数不对（应 2 个：合集长视频 + "标题像合集"那条；实际 ${badgeCount} 个）`);
  if (rowInfo[0].badge === '选集') ok('未展开时徽章写「选集」');
  else bad('未展开时徽章文案异常：' + rowInfo[0].badge);

  /* ---- 点徽章：应该滑出面板，且不该播放（徽章点击要拦下，不能触发整行播放） ---- */
  const bc = await centerOf('#content .track .badge');
  await clickAt(bc.x, bc.y);
  await sleep(500);
  const opened = await evalJS(`(() => {
    const mask = document.getElementById('collectMask');
    const rows = document.querySelectorAll('#collectList .collect-row');
    return {
      show: mask.classList.contains('show'),
      rows: rows.length,
      sub: document.getElementById('collectSub').textContent,
      queueLen: queue.tracks.length,
    };
  })()`);
  say('\n--- 点开徽章 ---');
  say('  面板显示=' + opened.show + '，列出 ' + opened.rows + ' 行，副标题「' + opened.sub + '」');
  if (opened.show) ok('点徽章滑出右侧合集面板');
  else bad('点徽章没有滑出面板');
  if (opened.rows === 134) ok('把 134 个分P 全列了出来');
  else bad('面板行数不对（应 134，实际 ' + opened.rows + '）');
  if (/134/.test(opened.sub)) ok('副标题写明「134 个分P」');
  else bad('副标题没写清数量：' + opened.sub);
  if (opened.queueLen === 0) ok('点徽章没有误触发"整行播放"（队列仍为空）');
  else bad('点徽章把歌也播了（队列=' + opened.queueLen + '）');

  const badgeAfter = await evalJS(`document.querySelector('#content .track .badge').textContent.trim()`);
  if (badgeAfter === '选集 134') ok('展开后徽章同步成「选集 134」');
  else bad('展开后徽章没有更新为「选集 134」，实际：' + badgeAfter);

  /* ---- 点面板里的第 5 集：应切成那一集播，并高亮 ---- */
  const rc = await centerOf('#collectList .collect-row[data-ci="4"]');
  await clickAt(rc.x, rc.y);
  await sleep(500);
  const played = await evalJS(`(() => {
    const on = document.querySelector('#collectList .collect-row.on');
    return {
      idx: queue.index,
      title: queue.tracks[queue.index] && queue.tracks[queue.index].title,
      np: document.getElementById('npTitle').textContent,
      onIdx: on ? Number(on.dataset.ci) : -1,
    };
  })()`);
  say('\n--- 点第 5 集 ---');
  say('  queue.index=' + played.idx + '，当前曲目「' + played.title + '」，播放条「' + played.np + '」，高亮行=' + played.onIdx);
  if (played.idx === 4 && played.onIdx === 4 && played.title && played.np) ok('点某一集就切到那一集播放，且该行高亮');
  else bad('点集没有切歌 / 高亮（index=' + played.idx + '，高亮=' + played.onIdx + '，标题=' + played.title + '）');

  /* ---- 面板里搜索：过滤 ---- */
  const filtered = await evalJS(`(() => {
    const inp = document.getElementById('collectSearch');
    inp.value = '春涧';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const n = document.querySelectorAll('#collectList .collect-row').length;
    const noMatch = (() => { inp.value = 'zzzzz'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('#collectList .err') ? true : false; })();
    inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { n, noMatch, back: document.querySelectorAll('#collectList .collect-row').length };
  })()`);
  say('\n--- 面板内搜索 ---');
  say('  「春涧」命中 ' + filtered.n + ' 行；乱输时给提示=' + filtered.noMatch + '；清空后恢复 ' + filtered.back + ' 行');
  if (filtered.n > 0 && filtered.n < 134 && filtered.noMatch && filtered.back === 134) ok('面板内搜索能过滤，无结果有提示，清空恢复全部');
  else bad('面板内搜索行为异常：' + JSON.stringify(filtered));

  /* ---- Esc 收起 ---- */
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(250);
  const afterEsc = await evalJS(`document.getElementById('collectMask').classList.contains('show')`);
  if (!afterEsc) ok('按 Esc 收起面板');
  else bad('按 Esc 没收起面板');

  /* ---- 点面板外空白（遮罩）收起 ---- */
  await evalJS(`expandCollection(searchResults[0], { tracks: searchResults, index: 0, name: '' })`);
  await sleep(500);
  await clickAt(20, 300);      // 左侧空白 = 遮罩本身
  await sleep(200);
  const afterMask = await evalJS(`document.getElementById('collectMask').classList.contains('show')`);
  if (!afterMask) ok('点面板外空白收起面板');
  else bad('点空白没收起面板');

  /* ---- ★ v2.4.0：删掉「加入队列」之后 ----
     ① 按钮不该存在（它把搜索框挤成了一个字，Neo 报的）；
     ② 搜索框要有足够宽度（≥150px）；
     ③ 整段入队改由"点某一行"承担 —— 队列要变成整段 134 首。 */
  await evalJS(`expandCollection(searchResults[0], { tracks: searchResults, index: 0, name: '' })`);
  await sleep(500);
  const bar = await evalJS(`(() => {
    const q = document.getElementById('btnQueueCollect');
    const inp = document.getElementById('collectSearch');
    return { hasBtn: !!q, searchW: Math.round(inp.getBoundingClientRect().width) };
  })()`);
  say('\n--- 合集面板按钮（v2.4.0）---');
  say('  「加入队列」还在吗=' + bar.hasBtn + '；搜索框宽=' + bar.searchW + 'px');
  if (bar.hasBtn) bad('「加入队列」按钮还在 —— v2.4.0 应该已经删掉');
  else ok('「加入队列」按钮已删除（v2.4.0）');
  if (bar.searchW < 150) bad('搜索框只有 ' + bar.searchW + 'px，还是太窄（应该 ≥150）');
  else ok('搜索框宽度 ' + bar.searchW + 'px（够显示十几个字）');

  const firstRow = await evalJS(`(() => {
    const r = document.querySelector('#collectList .collect-row');
    const b = r.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  await clickAt(firstRow.x, firstRow.y);
  await sleep(700);
  const queued = await evalJS(`({ len: queue.tracks.length, first: queue.tracks[0] && queue.tracks[0].title })`);
  say('  点第 1 行后：队列长度=' + queued.len + '，第一首「' + queued.first + '」');
  if (queued.len === 134) ok('点列表里任意一行 = 整段 134 首成为队列（原来的能力没丢）');
  else bad('点行后队列数量不对：' + queued.len);

  /* ★ 点行之后面板**仍然开着** —— 这是有意的（方便接着挑下一首；旧的「加入队列」会顺手关掉，
     点行不会）。但下一步要回到搜索结果列表去点徽章，所以这里得先把面板收起来，
     否则徽章那一下会点在盖在上面的面板上（第一次跑就是这么失败的）。 */
  await evalJS(`closeCollectPanel()`);
  await sleep(300);
  const closedForFb = await evalJS(`document.getElementById('collectMask').classList.contains('show')`);
  if (closedForFb) bad('点行之后面板没收起来（下一步点徽章会被它挡住）');
  else ok('点行后面板仍开着、由测试主动收起（不挡住下一步）');

  /* ---- 假阳性：标题像合集、其实只有 1P —— 点徽章应优雅回退成直接播 ----
     ★ 队列现在是"当前列表摊平后的结果"：列表里那条 134 集合集会摊成 134 首，
       所以队列 = 134 + 其余 2 行 = 136。这跟"点一下只播它自己"不矛盾：
       播放条上显示的必须是被点的那一行（无损精选 1首）。 */
  await evalJS(`queue = { tracks: [], index: -1, name: '' }; renderSearch();`);
  await sleep(200);
  const fb = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('#content .track')];
    const r = rows.find((x) => x.querySelector('.t').textContent.includes('无损精选'));
    const b = r.querySelector('.badge').getBoundingClientRect();
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) };
  })()`);
  await clickAt(fb.x, fb.y);
  await sleep(900);
  const fallback = await evalJS(`({
    show: document.getElementById('collectMask').classList.contains('show'),
    np: document.getElementById('npTitle').textContent,
    queueLen: queue.tracks.length,
    idx: queue.index,
  })`);
  say('\n--- 假阳性（标题像合集、其实 1P）---');
  say('  面板显示=' + fallback.show + '，播放条「' + fallback.np + '」，队列=' + fallback.queueLen + '（下标 ' + fallback.idx + '）');
  if (!fallback.show && fallback.np === '无损精选 1首' && fallback.queueLen === 136)
    ok('其实是单P时收面板、直接播这一首（队列按当前列表摊平：134 集合集 + 2 行 = 136）');
  else bad('假阳性回退异常：' + JSON.stringify(fallback));

  /* ---- 截图 ---- */
  await evalJS(`expandCollection(searchResults[0], { tracks: searchResults, index: 0, name: '' })`);
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-collect.png'), img.toPNG());
  say('\n已保存 shot-collect.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n合集面板实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
