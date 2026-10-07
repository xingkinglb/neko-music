/* 手势实测：在离屏窗口里合成鼠标事件，看
     ① 原地点一下 → 只弹工具条，不发 dragStart
     ② 按下后拖 30px   → 发 dragStart / dragEnd，且不弹工具条
     ③ 拖完再点一下   → 工具条收起
   —— 开发时的行为验证脚本，不参与打包运行。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
const ROOT = path.resolve(__dirname, '..');

const got = { dragStart: 0, dragEnd: 0 };
ipcMain.on('lyric:drag-start', () => { got.dragStart++; });
ipcMain.on('lyric:drag-end', () => { got.dragEnd++; });
ipcMain.on('lyric:resize', () => {});
ipcMain.on('lyric:cmd', () => {});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: 200, y: 200, width: 640, height: 120, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload-lyric.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'lyric.html'));
  win.webContents.send('lyric:style', { fontSize: 28, opacity: 92, lines: 2, barScale: 130, bgStyle: 'none' });
  win.webContents.send('lyric:data', { status: 'ok', lines: [{ t: 0, text: '测试句' }], time: 0.5, playing: true });
  await wait(700);

  const barShown = () => win.webContents.executeJavaScript(
    "document.getElementById('bar').classList.contains('show')");

  const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  const down = (x, y) => { mouse('mouseDown', x, y); };
  const move = async (x, y) => { mouse('mouseMove', x, y); await wait(60); };
  const up = async (x, y) => { mouse('mouseUp', x, y); await wait(120); };

  /* ① 原地点一下 */
  down(320, 80);
  await up(320, 80);
  const s1 = await barShown();
  if (!s1) bad('原地点一下没有弹出工具条');
  else if (got.dragStart !== 0) bad('原地点一下被误判成拖动（发了 dragStart）');
  else ok('原地点一下 → 工具条弹出，且没有被当成拖动');

  /* ② 点一下收起 */
  down(320, 80);
  await up(320, 80);
  const s2 = await barShown();
  if (s2) bad('再点一下没有收起工具条');
  else ok('再点一下 → 工具条收起');

  /* ③ 按住拖动：位移 30px */
  down(320, 80);
  await move(330, 84);
  await move(340, 90);
  await move(350, 96);
  await up(350, 96);
  const s3 = await barShown();
  if (got.dragStart !== 1) bad(`拖动没有发 dragStart（实际 ${got.dragStart} 次）`);
  else if (got.dragEnd !== 1) bad(`拖动结束没有发 dragEnd（实际 ${got.dragEnd} 次）`);
  else if (s3) bad('拖动之后被误判成单击（工具条乱弹）');
  else ok('按住拖 30px → 发 dragStart + dragEnd，没有误弹工具条');

  /* ④ 手抖 2px：应该仍然算单击 */
  down(320, 80);
  await move(321, 81);
  await up(321, 81);
  const s4 = await barShown();
  if (got.dragStart !== 1) bad('手抖 2px 被误判成拖动');
  else if (!s4) bad('手抖 2px 之后单击没生效');
  else ok('手抖 2px → 仍算单击（4px 以内的容差有效）');

  console.log(fail === 0 ? '\n手势实测全部通过 ✅' : `\n发现 ${fail} 处问题 ❌`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
