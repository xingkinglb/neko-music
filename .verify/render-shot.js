/* 离屏渲染截图：把桌面歌词窗按新样式画出来存成 PNG，用来目视确认"没有边框、字号够大"。
   —— 只是开发时的检查脚本，不参与打包运行。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const style = JSON.parse(process.argv[2] || '{}');
const shot = process.argv[3] || 'shot.png';

ipcMain.on('lyric:resize', () => {});
ipcMain.on('lyric:cmd', () => {});
ipcMain.on('lyric:drag-start', () => {});
ipcMain.on('lyric:drag-end', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 220, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload-lyric.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'lyric.html'));

  // 只给截图用的假壁纸：真实运行时这里是透明的，直接截会是一片空
  await win.webContents.executeJavaScript(`
    document.documentElement.style.background = 'linear-gradient(120deg,#f7f7fa 0%,#c9d6ff 45%,#8aa2c8 100%)';
    document.body.style.background = 'transparent';
  `);

  win.webContents.send('lyric:style', style);
  win.webContents.send('lyric:data', {
    status: 'ok',
    lines: [{ t: 0, text: '♪ 人都应该有梦 ♪' }, { t: 2, text: '有梦就别怕痛' }],
    time: 0.5, playing: true,
  });
  await new Promise((r) => setTimeout(r, 900));

  if (process.argv[4] !== 'nobar') {
    await win.webContents.executeJavaScript("document.getElementById('bar').classList.add('show')");
    await new Promise((r) => setTimeout(r, 400));
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, shot), img.toPNG());
  console.log('已保存 ' + shot);
  app.exit(0);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
