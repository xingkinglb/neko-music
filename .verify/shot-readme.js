/* README 配图脚本：用**假数据**跑一遍界面，截出 docs/images/*.png。
   ★ 隐私红线：全程使用虚构歌单 / 虚构曲目 / 虚构 UP 主，绝不读取本机真实存档，
     也不碰 %APPDATA%\neko-music\ 下的任何东西（背景目录用的是临时目录）。
   ★ 封面是内联的 SVG data URI（不联网），所以离线也能截出好看的图。
   开发期脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(__dirname, 'shot-readme.log');
fs.writeFileSync(LOG, '');
const say = (m) => { fs.appendFileSync(LOG, m + '\n'); console.log(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-demo-bg-'));
const DEMO_BG = 'demo-wallpaper.png';
protocol.registerSchemesAsPrivileged([{ scheme: 'bg', privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } }]);
// ⚠️ registerBgProtocol 必须在 app ready 之后调用（它要拿默认 session）
const { registerBgProtocol } = require(path.join(ROOT, 'src', 'bg-protocol.js'));

/* 演示壁纸来源：优先用本机这张（可用 NEKO_DEMO_WALLPAPER 覆盖）；
   找不到就自己生成一张渐变，保证脚本在别的机器上也能跑。 */
const WALLPAPER_SRC = process.env.NEKO_DEMO_WALLPAPER
  || 'C:\\Users\\Dico\\Pictures\\新建文件夹\\【哲风壁纸】动漫人物-动漫壁纸.png';

/* 极简 PNG 编码（竖向渐变，纯 Node，不引依赖）—— 只在没找到壁纸时兜底 */
function gradientPng(w, h, top, bottom) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const k = y / (h - 1);
    const off = y * (w * 4 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4;
      raw[p] = Math.round(top[0] + (bottom[0] - top[0]) * k);
      raw[p + 1] = Math.round(top[1] + (bottom[1] - top[1]) * k);
      raw[p + 2] = Math.round(top[2] + (bottom[2] - top[2]) * k);
      raw[p + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k2 = 0; k2 < 8; k2++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let c = 0xffffffff; for (const byte of td) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 虚构封面：内联 SVG（不联网，离线也能出图） ---------- */
const cover = (a, b, ch) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">`
  + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
  + `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`
  + `<rect width="160" height="160" fill="url(#g)"/>`
  + `<circle cx="128" cy="34" r="46" fill="rgba(255,255,255,0.10)"/>`
  + `<text x="80" y="100" font-size="58" text-anchor="middle" fill="rgba(255,255,255,0.94)"`
  + ` font-family="Microsoft YaHei, sans-serif">${ch}</text></svg>`
).toString('base64');

/* ---------- 虚构曲目（全部为杜撰，与真实 B 站内容无关） ---------- */
const DEMO = [
  { bvid: 'BV1Neko00001', title: '星海漫游',           author: '夜色合成器', duration: '4:12', cid: 101, ch: '星', c: ['#5b8cff', '#241a6b'] },
  { bvid: 'BV1Neko00002', title: '凌晨三点的键盘声',   author: 'Lo-Fi 猫',   duration: '3:28', cid: 102, ch: '凌', c: ['#ff8ab0', '#5a1f4a'] },
  { bvid: 'BV1Neko00003', title: 'Neon Rain',          author: '像素花园',   duration: '3:55', cid: 103, ch: 'N',  c: ['#37d6c0', '#0d4a49'] },
  { bvid: 'BV1Neko00004', title: '雨后的便利店',       author: 'Lo-Fi 猫',   duration: '2:47', cid: 104, ch: '雨', c: ['#7a8cff', '#232a5c'] },
  { bvid: 'BV1Neko00005', title: '像素花园 · 全专辑',  author: '像素花园',   duration: '42:10', cid: 105, ch: '像', c: ['#ffd166', '#6b3d0f'] },
  { bvid: 'BV1Neko00006', title: '深海电台',           author: '夜色合成器', duration: '6:20', cid: 106, ch: '深', c: ['#2fa8ff', '#082a4d'] },
  { bvid: 'BV1Neko00007', title: '纸飞机与风',         author: '晴空小组',   duration: '3:12', cid: 107, ch: '纸', c: ['#9be36f', '#1f4a1a'] },
  { bvid: 'BV1Neko00008', title: '晚安，东京',         author: '晴空小组',   duration: '4:40', cid: 108, ch: '晚', c: ['#c08bff', '#3a1d5c'] },
].map((t) => ({ ...t, mid: 90001, cover: cover(t.c[0], t.c[1], t.ch), parts: 1 }));

const byId = (bvid) => DEMO.find((t) => t.bvid === bvid);
const track = (bvid) => { const t = byId(bvid); const { ch, c, ...rest } = t; return { ...rest }; };

/* 合集：给「像素花园 · 全专辑」造 12 集（演示招牌功能） */
const SEASON_EPISODES = Array.from({ length: 12 }, (_, i) => ({
  bvid: 'BV1Neko00005', cid: 500 + i, page: i + 1,
  title: `第 ${i + 1} 乐章 · ${['晨雾', '光合', '霓虹', '苔藓', '风铃', '萤火', '潮汐', '星尘', '雨林', '月相', '回声', '归途'][i]}`,
  duration: 200 + i * 11,
}));

/* 虚构歌词（杜撰） */
const LYRICS = [
  '穿过整片星海 我把灯留在身后',
  '风把云的形状 吹成你名字的轮廓',
  '凌晨三点 键盘还在轻轻地响',
  '像有人在夜里 替我数着心跳',
  '',
  '如果远方真有一盏不会灭的灯',
  '那一定是你 在等我回家',
  '我把每一句没说出口的话',
  '都唱成了这段副歌',
  '',
  '星海漫游 不问归期',
  '只把想念 寄给风',
  '星海漫游 不问归期',
  '愿你今夜 好梦',
  '',
  '（间奏）',
  '',
  '如果远方真有一盏不会灭的灯',
  '那一定是你 在等我回家',
  '我把每一句没说出口的话',
  '都唱成了这段副歌',
  '',
  '星海漫游 不问归期',
  '只把想念 寄给风',
  '星海漫游 不问归期',
  '愿你今夜 好梦',
].map((text, i) => ({ t: 6 + i * 6.5, text }));

/* ---------- 虚构存档（歌单 / 收藏 / 历史 全是杜撰） ---------- */
const FAKE_DB = {
  playlists: [
    { id: 'pl-demo-1', name: '深夜代码', tracks: ['BV1Neko00001', 'BV1Neko00002', 'BV1Neko00004', 'BV1Neko00006', 'BV1Neko00008'].map(track) },
    { id: 'pl-demo-2', name: '通勤路上', tracks: ['BV1Neko00003', 'BV1Neko00007', 'BV1Neko00008'].map(track) },
  ],
  favorites: ['BV1Neko00001', 'BV1Neko00003', 'BV1Neko00006', 'BV1Neko00008'].map(track),
  history: ['BV1Neko00008', 'BV1Neko00006', 'BV1Neko00005', 'BV1Neko00004', 'BV1Neko00003', 'BV1Neko00002', 'BV1Neko00001', 'BV1Neko00007'].map(track),
  lastTrack: null,
  settings: {
    theme: 'violet',
    volume: 80,
    bg: { file: DEMO_BG, kind: 'image', dim: 0.62, blur: 0, video: { muted: true, loop: true, speed: 1 }, perfLite: true, pauseOnBlur: true },
    glass: { blur: 18, alpha: 0.5 },
    autoLyric: true,
    lyricWin: { on: false, x: null, y: null, fontSize: 28, opacity: 90, lines: 2, barScale: 130, bgStyle: 'none', locked: false, clickThrough: false },
    playMode: 'list',
  },
  collectParts: {},
};

let lastSaved = JSON.parse(JSON.stringify(FAKE_DB));

ipcMain.handle('store:load', () => ({ ok: true, data: JSON.parse(JSON.stringify(lastSaved)) }));
ipcMain.handle('store:save', (_e, data) => { lastSaved = JSON.parse(JSON.stringify(data)); return { ok: true, data: true }; });
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '演示用占位（不是真 Cookie）' }));
ipcMain.handle('bili:subtitle', () => ({ ok: true, data: { lines: LYRICS, source: 'manual' } }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 260, backup: [] } }));
ipcMain.handle('bili:search', (_e, kw) => ({ ok: true, data: { list: DEMO.map((t) => ({ ...t })) } }));
ipcMain.handle('bili:parse', (_e, text) => ({ ok: true, data: { bvid: 'BV1Neko00001' } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => {
  if (bvid === 'BV1Neko00005') {
    const t = byId(bvid);
    return { ok: true, data: { bvid, aid: 1, title: t.title, cover: t.cover, owner: { mid: 90001, name: t.author }, duration: 2530,
      pages: SEASON_EPISODES.map((e) => ({ bvid, cid: e.cid, page: e.page, title: e.title, duration: e.duration })),
      season: { id: 1, title: '像素花园 · 全专辑', episodes: SEASON_EPISODES.map((e) => ({ ...e, cover: t.cover })) } } };
  }
  const t = byId(bvid) || DEMO[0];
  return { ok: true, data: { bvid, aid: 1, title: t.title, cover: t.cover, owner: { mid: 90001, name: t.author }, duration: 250,
    pages: [{ bvid, cid: t.cid, page: 1, title: t.title, duration: 250 }], season: null } };
});
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: DEMO.slice(0, 4).map((t) => ({ ...t })), hasMore: false } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: { file: DEMO_BG, kind: 'image', sizeMB: 0.3 } }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

app.whenReady().then(async () => {
  registerBgProtocol(BG_DIR);

  /* ---------- 0) 先把演示壁纸准备好（必须在页面加载之前！） ----------
     ★ 踩过的坑：壁纸文件若在页面加载之后才写进去，浏览器第一次请求会 404，
       而"失败"这个结果会被缓存住；之后即使文件就位、重新设置同一个 url，也不会重试 ——
       表现就是"壁纸死活不显示"，白白排查半天。所以顺序必须是：先放文件，再加载页面。 */
  const dst = path.join(BG_DIR, DEMO_BG);
  if (fs.existsSync(WALLPAPER_SRC)) {
    fs.copyFileSync(WALLPAPER_SRC, dst);
    say('演示壁纸：' + path.basename(WALLPAPER_SRC) + '（' + Math.round(fs.statSync(dst).size / 1024) + ' KB）');
  } else {
    fs.writeFileSync(dst, gradientPng(1600, 900, [27, 42, 122], [143, 62, 196]));
    say('没找到本机壁纸，改用生成的渐变兜底');
  }

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const evalJS = (code) => win.webContents.executeJavaScript(code);

  const shoot = async (name) => {
    await sleep(450);
    const img = await win.webContents.capturePage();
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, img.toPNG());
    say('  已保存 docs/images/' + name);
  };

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);

  // 掐掉音频（沙箱没声卡）；src 给合法 URL，避免 Electron 内部 new URL('') 抛错
  await evalJS(`(() => {
    const a = document.getElementById('audio');
    a.play = () => Promise.resolve();
    a.pause = () => {};
    Object.defineProperty(a, 'src', { configurable: true, get: () => 'https://example.invalid/a.m4s', set: () => {} });
    return true; })()`);

  // 让界面用上演示壁纸 + 虚构数据
  await evalJS(`(async () => {
    applyAppearance(); renderAll();
    return true; })()`);
  await sleep(1000);

  // 确认壁纸真的挂上去了（不然截出来的图会是一片纯黑，白忙一场）
  const bgInfo = await evalJS(`(() => {
    const img = document.getElementById('bgImage');
    return {
      cssVar: document.getElementById('bgLayer').style.getPropertyValue('--bg-image'),
      computed: getComputedStyle(img).backgroundImage.slice(0, 60),
      hasBgClass: document.body.classList.contains('has-bg'),
      file: DB.settings.bg.file, dim: DB.settings.bg.dim,
    };
  })()`);
  say('背景状态：' + JSON.stringify(bgInfo));

  // 用像素说话：内容区中心必须不是纯底色（#0e0e14 = R14 G14 B20）
  const probePixel = async (label) => {
    const img = await win.webContents.capturePage();
    const { width } = img.getSize();
    const bmp = img.getBitmap();
    const i = (Math.round(700 * width / 1280) * width + Math.round(600 * width / 1280)) * 4;
    const r = bmp[i + 2], g = bmp[i + 1], b = bmp[i];
    const flat = Math.abs(r - 14) < 4 && Math.abs(g - 14) < 4 && Math.abs(b - 20) < 4;
    say(`  ${label}：内容区像素 R${r} G${g} B${b} ${flat ? '← 还是纯底色（壁纸没画出来！）' : '← 有内容，壁纸画出来了'}`);
    return !flat;
  };
  if (!(await probePixel('壁纸自检'))) say('  ⚠️ 壁纸没显示，后面截出来的图会很难看，请检查上面几行');


  /* ---------- 1) 主图：发现页 ---------- */
  say('\n[1] 发现页（主图）');
  await evalJS(`(async () => { currentView = 'discovery'; renderAll(); return true; })()`);
  await sleep(1400);   // 等推荐列表回来
  await shoot('hero.png');

  /* ---------- 2) 搜索 → 合集「选集」面板 ---------- */
  say('\n[2] 合集选集面板');
  await evalJS(`(async () => {
    const el = document.getElementById('searchInput');
    el.value = '像素花园';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true; })()`);
  await sleep(1200);
  // 直接调 expandCollection 打开右侧面板（点徽章要算坐标，脚本里更容易失手）
  await evalJS(`(async () => {
    const t = queue.tracks[0] || (window.DEMO_TRACK || null);
    const target = { bvid: 'BV1Neko00005', title: '像素花园 · 全专辑', author: '像素花园', mid: 90001, duration: '42:10', cover: '' };
    await expandCollection(target, null);
    return true; })()`);
  await sleep(900);
  await shoot('collect.png');
  await evalJS(`closeCollectPanel(); true`);
  await sleep(400);

  /* ---------- 3) 整页歌词 ---------- */
  say('\n[3] 整页歌词');
  await evalJS(`(async () => {
    const tracks = DB.playlists[0].tracks.slice();
    await startFromView(tracks, 0);
    return true; })()`);
  await sleep(1200);
  await evalJS(`(async () => { await loadLyrics(true); toggleLyrics(true); return true; })()`);
  await sleep(1200);
  await shoot('lyric.png');

  /* ---------- 4) 设置面板（动态背景） ---------- */
  say('\n[4] 动态背景设置面板');
  await evalJS(`(() => { toggleLyrics(false); openSettings(); return true; })()`);
  await sleep(900);
  await shoot('settings.png');

  if (errors.length) say('\n页面报错：\n  ' + errors.slice(0, 8).join('\n  '));
  else say('\n页面无报错');
  say('\n完成');
  setTimeout(() => process.exit(0), 150);
}).catch((e) => { say('FAIL ' + (e && e.stack || e)); setTimeout(() => process.exit(2), 150); });
