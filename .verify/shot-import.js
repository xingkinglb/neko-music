/* 把 v2.6.0 新增的「导入我的 B 站收藏夹」三屏离屏拍下来，用来肉眼确认观感 + 给 README 配图。
   判据在 test-round15.js 里；这一份只出图。开发期脚本，不参与打包。

   ★ 隐私红线：这里用的是**假数据**（测试喵 / 深夜爵士 / 爵士 1…），
     绝不能拿真账号的昵称、收藏夹名或视频标题出图。

   产物：docs/images/import-home.png / import-folders.png / import-pick.png
        （同时留一份在 .verify/ 下，方便对比） */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_SIZE = 30;
const f1Bvid = (n) => 'BV1f1' + String(n).padStart(4, '0');
const F2_BVIDS = [f1Bvid(1), 'BV1f20002', 'BV1f20003', 'BV1f20004', 'BV1f20005'];

/* 封面用纯色占位（不外链任何真实图片，避免出图带上网址） */
const cover = (hue) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="hsl(${hue} 45% 34%)"/></svg>`
)}`;

const FOLDERS = [
  { id: 1001, title: '深夜爵士', count: 86, cover: cover(275), private: false },
  { id: 1002, title: '游戏音乐', count: 5,  cover: cover(205), private: false },
  { id: 1003, title: '学习白噪音', count: 41, cover: cover(150), private: false },
  { id: 1004, title: '私藏小曲', count: 12, cover: cover(20), private: true },
  // ★ v2.6.1：故意留一个**没封面**的（B 站 cover_type:0 的情况），
  //   用来肉眼确认「音符占位」长什么样，别又是一块空色块。
  { id: 1005, title: '很久没听', count: 7,  cover: '', private: false },
];

ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], settings: {}, lastTrack: null } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:myInfo', () => ({ ok: true, data: { mid: 12345, name: '测试喵', face: '' } }));
ipcMain.handle('bili:favFolders', () => ({ ok: true, data: FOLDERS.map((f) => ({ ...f })) }));
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
      return { bvid: f1Bvid(n), title: `爵士 ${n}`, cover: cover(260 + (n % 30)), duration: 200 + n, page: 1 };
    });
  } else if (String(mediaId) === '1002') {
    total = 5;
    if (p === 1) list = F2_BVIDS.map((b, i) => ({ bvid: b, title: `游戏 ${i + 1}`, cover: cover(200 + i * 8), duration: 180, page: 1 }));
  } else {
    total = 41;
    const start = (p - 1) * PAGE_SIZE;
    const count = Math.max(0, Math.min(PAGE_SIZE, 41 - start));
    list = Array.from({ length: count }, (_, i) => ({ bvid: 'BV1x' + (start + i), title: `白噪音 ${start + i + 1}`, cover: cover(150), duration: 3600, page: 1 }));
  }
  return { ok: true, data: { list, total, pageSize: PAGE_SIZE, hasMore: p * PAGE_SIZE < total } };
});
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:videoInfo', (_e, bvid) => ({ ok: true, data: { bvid, aid: 1, title: '歌', cover: '', owner: { mid: 1, name: 'UP' }, duration: 200, pages: [], season: null } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.on('win-close', () => {});
ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('win:ui-state', () => {});
ipcMain.on('win:close-choice', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:push', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const evalJS = (c) => win.webContents.executeJavaScript(c);
  const clickBtn = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const shoot = async (name) => {
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), buf);
    fs.writeFileSync(path.join(__dirname, 'shot-' + name), buf);
  };

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);

  /* ① 选来源（我的投稿 / 我的收藏夹） */
  await clickBtn('#btnImportMine');
  await sleep(700);
  await shoot('import-home.png');

  /* ② 收藏夹列表 —— 先进「深夜爵士」勾 3 个，再返回，好让卡片有「已选 3」角标 */
  await clickBtn('#btnImpFav');
  await sleep(800);
  await clickBtn('#content .card[data-imp-folder="1001"]');
  await sleep(800);
  for (const i of [0, 1, 2]) { await clickBtn(`#content .track[data-i="${i}"]`); await sleep(200); }
  await clickBtn('#btnImpBack');
  await sleep(600);
  await shoot('import-folders.png');

  /* ③ 挑视频（勾着的行 + 顶部「已选 3 个」+ 分页条） */
  await clickBtn('#content .card[data-imp-folder="1001"]');
  await sleep(800);
  await shoot('import-pick.png');

  console.log('已保存 docs/images/import-{home,folders,pick}.png');
  setTimeout(() => process.exit(0), 150);
});
