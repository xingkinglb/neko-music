/* 整页歌词浮层的实测：
     · 打开歌词页之后，右上角那个 X 到底能不能点（合成真实鼠标事件，数点击次数）
     · 浮层的实际范围有没有压到侧边栏 / 播放条 / 顶部工具栏（那些地方必须还能点）
     · 点封面能不能开也能不能收
     · 点歌词页以外的界面（侧栏 / 搜索框）能不能收起歌词页
     · 点播放条上的按钮不该把歌词页收掉（看歌词时还要接着控制播放）
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const W = 1180, H = 760;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 报告直接写文件：这个环境里 Electron 进程收尾时 stdout 会丢，
   所以别依赖控制台，一切结论都落到 .verify/test-overlay-report.txt。
   进程结束也自己硬退，不等 Electron 慢慢收摊。 */
const REPORT = path.join(__dirname, 'test-overlay-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 120); };

// boot() 只会用到存档读取，其余通道返回空实现即可
ipcMain.handle('store:load', () => ({ playlists: [], favorites: [], history: [], settings: {}, lastTrack: null }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false,
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

  // 造一份歌词 + 一首正在播的歌，然后正式打开歌词页（走真实函数，不手工加 class）
  // ★ 必须塞一首歌：封面的点击处理里有"没歌就先提示、不展开"的守卫，
  //   没有歌的话整个用例会被这条守卫拦下，测不到真正的开关行为。
  const opened = await win.webContents.executeJavaScript(`(() => {
    queue.tracks = [{ bvid: 'BV1test0001', title: '测试曲目', author: '测试歌手' }];
    queue.index = 0;
    // ★ 用真实长度的歌词（40 句）：3 句那种短字幕撑不满一屏、滚动被夹在 0 上，
    //   拿它验"当前句居中"是验不出来的（会误报）。
    lyricState.lines = Array.from({ length: 40 }, (_, i) => ({ t: i * 5, text: '第 ' + (i + 1) + ' 句歌词' }));
    lyricState.failed = false;
    renderLyricLines('测试曲目');   // 真的把歌词画进 .lyric-box（顺带验证居中位置）
    toggleLyrics(true);
    window.__closeClicks = 0;
    document.getElementById('btnLyricClose').addEventListener('click', () => { window.__closeClicks++; });
    return document.getElementById('lyricOverlay').classList.contains('show');
  })()`);
  if (opened) ok('歌词页已打开（.lyric-overlay.show）');
  else bad('歌词页没打开');

  await sleep(300);

  const geo = await win.webContents.executeJavaScript(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
      const b = el.getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; };
    const nameOf = (el) => el ? (el.tagName.toLowerCase() + (el.id?'#'+el.id:'') +
      (typeof el.className === 'string' && el.className.trim() ? '.'+el.className.trim().split(/\\s+/).join('.') : '')) : 'null';
    const btn = document.getElementById('btnLyricClose');
    const bb = btn.getBoundingClientRect();
    const cx = Math.round(bb.x + bb.width/2), cy = Math.round(bb.y + bb.height/2);
    const n = (sel) => r(sel);
    const ov = n('#lyricOverlay');
    const inter = (a,b) => { if (!a||!b) return 0;
      const w = Math.max(0, Math.min(a.x+a.w,b.x+b.w) - Math.max(a.x,b.x));
      const h = Math.max(0, Math.min(a.y+a.h,b.y+b.h) - Math.max(a.y,b.y));
      return w*h; };
    return {
      win: { w: innerWidth, h: innerHeight },
      overlay: ov, sidebar: n('.sidebar'), player: n('#player'), titlebar: n('.titlebar'),
      topbar: n('.topbar'),
      cover: n('#npCover'), close: n('#btnLyricClose'), head: n('.lyric-head'),
      closeCenter: { x: cx, y: cy },
      hitAtClose: nameOf(document.elementFromPoint(cx, cy)),
      hitAtSidebar: nameOf(document.elementFromPoint(60, 300)),
      hitAtPlayer: nameOf(document.elementFromPoint(600, innerHeight - 40)),
      hitAtTopbar: nameOf(document.elementFromPoint(600, 100)),
      playCenter: (() => { const b = document.getElementById('btnPlay').getBoundingClientRect();
        return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })(),
      searchCenter: (() => { const b = document.getElementById('searchInput').getBoundingClientRect();
        return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }; })(),
      overlapSidebar: inter(ov, n('.sidebar')),
      overlapPlayer: inter(ov, n('#player')),
      overlapTitlebar: inter(ov, n('.titlebar')),
      overlapTopbar: inter(ov, n('.topbar')),
      topbarBottom: n('.topbar') ? n('.topbar').y + n('.topbar').h : -1,
    };
  })()`);

  say('\n--- 几何 ---');
  say('  窗口 ' + geo.win.w + 'x' + geo.win.h);
  say('  浮层 ' + JSON.stringify(geo.overlay));
  say('  侧边栏 ' + JSON.stringify(geo.sidebar) + '｜播放条 ' + JSON.stringify(geo.player));
  say('  顶部工具栏 ' + JSON.stringify(geo.topbar) + '，下沿 y=' + geo.topbarBottom);
  say('  X 按钮 ' + JSON.stringify(geo.close) + '，信息条 ' + JSON.stringify(geo.head));

  if (geo.overlapSidebar === 0 && geo.overlapPlayer === 0 && geo.overlapTitlebar === 0) {
    ok('浮层没压到侧边栏 / 播放条 / 标题栏（它们仍可点）');
  } else {
    bad(`浮层压住了其他区域：侧边栏 ${geo.overlapSidebar}px²，播放条 ${geo.overlapPlayer}px²，标题栏 ${geo.overlapTitlebar}px²`);
  }

  /* ★ 浮层必须严格从顶部工具栏的下沿开始：盖住它 = 搜索框点不到，
     留缝 = 看起来像没铺满。 */
  if (geo.overlapTopbar === 0 && geo.overlay.y === geo.topbarBottom) {
    ok(`浮层正好从顶部工具栏下沿开始（y=${geo.overlay.y}），搜索框没被盖住`);
  } else {
    bad(`浮层与顶部工具栏的关系不对：重叠 ${geo.overlapTopbar}px²，浮层 y=${geo.overlay.y}，工具栏下沿 y=${geo.topbarBottom}`);
  }
  say('  侧边栏中点到的元素：' + geo.hitAtSidebar);
  say('  播放条中点到的元素：' + geo.hitAtPlayer);
  say('  顶部工具栏点到的元素：' + geo.hitAtTopbar);

  /* ★ 浮层起点下移之后，当前句还居不居中？
     居中是拿"浮层自身的高度"算的，浮层范围一变就得重新确认。
     三处都要验：第一句（最容易被顶到上半屏）/ 中间 / 最后一句。 */
  const centers = await win.webContents.executeJavaScript(`(() => {
    const ov = document.getElementById('lyricOverlay').getBoundingClientRect();
    const ovCenter = Math.round(ov.y + ov.height/2);
    const box = document.getElementById('lyricBox');
    return [0, 20, box.children.length - 1].map((i) => {
      scrollLyricTo(i, true);
      const b = box.children[i].getBoundingClientRect();
      return { i, d: Math.abs(Math.round(b.y + b.height/2) - ovCenter), scrollTop: Math.round(box.scrollTop) };
    });
  })()`);
  say('\n--- 当前句居不居中（浮层中心 y=' + geo.overlay.y + '+' + geo.overlay.h + '/2）---');
  centers.forEach((c) => say(`  第 ${c.i + 1} 句：偏离中心 ${c.d}px（scrollTop=${c.scrollTop}）`));
  if (centers.every((c) => c.d <= 30)) ok('第一句 / 中间 / 最后一句都能停在正中间');
  else bad('有句子没能停在正中间：' + centers.filter((c) => c.d > 30).map((c) => '第' + (c.i + 1) + '句偏' + c.d + 'px').join('、'));

  /* ★ "立刻到位"必须真的是立刻。
     实测踩过：behavior:'instant' 在部分内核里被当成非法值退回 auto，而 CSS 里写着
     scroll-behavior: smooth → 变成"永远平滑"，三处测量全部停在半路、偏 191px。
     判据：跳转后立刻读一次 scrollTop，500ms 后再读一次，两次必须一致。 */
  const jump = await win.webContents.executeJavaScript(`(() => {
    scrollLyricTo(0, true);
    return document.getElementById('lyricBox').scrollTop;
  })()`);
  await sleep(500);
  const settled = await win.webContents.executeJavaScript('document.getElementById("lyricBox").scrollTop');
  say('\n--- 立刻到位是不是真的"立刻" ---');
  say(`  跳转后 scrollTop=${Math.round(jump)}，500ms 后 scrollTop=${Math.round(settled)}`);
  if (Math.abs(jump - settled) <= 2) ok('跳转立刻到位（不是慢慢滑过去的）');
  else bad(`跳转后还在继续滑动（${Math.round(jump)} → ${Math.round(settled)}）—— 打开歌词页会看到从顶上慢慢滑下来`);

  say('\n--- X 按钮点得到吗 ---');
  say('  X 中心点 (' + geo.closeCenter.x + ',' + geo.closeCenter.y + ') 命中的元素：' + geo.hitAtClose);
  if (/#btnLyricClose/.test(geo.hitAtClose)) ok('X 就是该点上最上层的元素');
  else bad('X 被别的元素挡住了（命中 ' + geo.hitAtClose + '）');

  // 真·合成鼠标点击
  const { x, y } = geo.closeCenter;
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 });
  await sleep(400);
  const after = await win.webContents.executeJavaScript(
    '({ clicks: window.__closeClicks, showing: document.getElementById("lyricOverlay").classList.contains("show") })');
  say('  点了一下 X：收到 ' + after.clicks + ' 次点击，歌词页 ' + (after.showing ? '仍然开着' : '已收起'));
  if (after.clicks === 1 && after.showing === false) ok('点 X 能收起歌词页');
  else bad('点 X 没反应（收到 ' + after.clicks + ' 次点击，showing=' + after.showing + '）');

  // 封面再点一次 = 收起 / 再展开（用真实鼠标事件，把 pointerdown 与 click 两条路都走到）
  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 });
    await sleep(250);
  };
  const showing = () => win.webContents.executeJavaScript(
    'document.getElementById("lyricOverlay").classList.contains("show")');

  const cc = { x: Math.round(geo.cover.x + geo.cover.w / 2), y: Math.round(geo.cover.y + geo.cover.h / 2) };
  const s0 = await showing();
  await clickAt(cc.x, cc.y);
  const s1 = await showing();                       // 本来是收起的 → 应该展开
  const coverOpen = await win.webContents.executeJavaScript(
    'document.getElementById("npCover").classList.contains("open")');
  await clickAt(cc.x, cc.y);
  const s2 = await showing();                       // 再点一次 → 应该收起
  say('\n--- 封面点了两下 --- 前=' + s0 + ' 中=' + s1 + ' 后=' + s2 + '，中间封面的 .open=' + coverOpen);
  if (s0 === false && s1 === true && s2 === false) ok('点封面能开、再点能收（真实鼠标事件走通）');
  else bad('封面点了不能来回切换（' + s0 + ' → ' + s1 + ' → ' + s2 + '）');
  if (coverOpen === true) ok('歌词页开着时封面带 .open（提示变成「收起」）');
  else bad('歌词页开着时封面没有 .open —— 看不出点下去是"收起"');

  // ★ 点侧边栏 → 歌词页应该收起（用户反馈：点别的界面它一直压在上面）
  await win.webContents.executeJavaScript('toggleLyrics(true)');
  await sleep(200);
  await clickAt(60, 300);
  const afterSidebar = await showing();
  say('\n--- 点侧边栏 --- 歌词页 ' + (afterSidebar ? '仍开着' : '已收起'));
  if (!afterSidebar) ok('点侧边栏会收起歌词页，露出下面的界面');
  else bad('点侧边栏歌词页不收（就是用户反馈的那种"它一直在最上面"）');

  // ★ 点搜索框 → 收起歌词页 + 光标落进搜索框
  await win.webContents.executeJavaScript('toggleLyrics(true)');
  await sleep(200);
  await clickAt(geo.searchCenter.x, geo.searchCenter.y);
  const afterTop = await showing();
  const focused = await win.webContents.executeJavaScript('(document.activeElement && document.activeElement.id) || ""');
  say('--- 点搜索框 --- 歌词页 ' + (afterTop ? '仍开着' : '已收起') + '，光标在 ' + (focused || '(没落进去)'));
  if (!afterTop && focused === 'searchInput') ok('点搜索框：歌词页收起，且能立刻开始打字');
  else bad('点搜索框没按预期收起（showing=' + afterTop + '，焦点=' + focused + '）');

  // ★ 点播放条上的按钮不该收起歌词页（看歌词时还要接着控制播放）
  await win.webContents.executeJavaScript('toggleLyrics(true)');
  await sleep(200);
  await clickAt(geo.playCenter.x, geo.playCenter.y);
  const afterPlayer = await showing();
  say('--- 点播放条的播放键 --- 歌词页 ' + (afterPlayer ? '仍开着' : '被收起了'));
  if (afterPlayer) ok('点播放条上的按钮不会误收歌词页');
  else bad('点播放条按钮把歌词页误收了');

  // 截一张开着歌词页的图，肉眼确认
  await win.webContents.executeJavaScript('toggleLyrics(true)');
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'shot-overlay.png'), img.toPNG());
  say('\n已保存 shot-overlay.png');

  if (errors.length) say('\n页面里的报错：\n  ' + errors.slice(0, 6).join('\n  '));
  say(fail === 0 ? '\n浮层实测全部通过' : `\n发现 ${fail} 处问题`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); finish(2); });
