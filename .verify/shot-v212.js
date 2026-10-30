/* 一次性截图：v2.12.0 AI 歌词，人眼验收用（不做断言）。
   跑完写到 .verify/ 下：
     shot-v212-settings.png  设置 → 歌词 → AI 那一块（配置区打开着）
     shot-v212-prompt.png    提示词编辑面板（整理那一页）
     shot-v212-gen.png       兜底生成：顶上挂「AI 生成 · 时间轴为估算」
     shot-v212-fail.png      生成失败：空状态里写出 429 的原因
   开发期脚本，不进打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACK = { bvid: 'BVlyricB', cid: 202, title: '如果的事', author: '真栗', duration: 240, cover: '' };

let genMode = 'ok';

ipcMain.handle('store:load', () => ({
  ok: true,
  data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} },
}));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', duration: 240, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BVlyricB' } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: { bvid: 'BVlyricB', pages: [{ cid: 202, duration: 240 }], owner: { mid: 1, name: 'x' } } }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '这首没有字幕', reason: 'none' }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

// AI 那一组：全都给假结果（截图不需要真服务）
ipcMain.handle('ai:keyInfo', () => ({ ok: true, data: { has: true, mask: 'sk-••••••••••••a1b2', encrypted: true } }));
ipcMain.handle('ai:getPrompts', () => ({
  ok: true,
  data: {
    polish: { text: '你是一名歌词校对员。下面是一首歌的 B 站自动字幕（语音识别生成）……\n\n现在校对下面这 {n} 行（JSON 数组）：\n{lines}', isDefault: true, defaultText: '你是一名歌词校对员。下面是一首歌的 B 站自动字幕（语音识别生成）……\n\n现在校对下面这 {n} 行（JSON 数组）：\n{lines}' },
    generate: { text: '你是歌词整理助手。请给出下面这首歌的歌词，用 LRC 格式。\n视频时长：{duration} 秒', isDefault: true, defaultText: '你是歌词整理助手。请给出下面这首歌的歌词，用 LRC 格式。\n视频时长：{duration} 秒' },
  },
}));
ipcMain.handle('ai:cacheStats', () => ({ ok: true, data: { count: 37, bytes: 184320, max: 800 } }));
ipcMain.handle('ai:clearCache', () => ({ ok: true, data: true }));
ipcMain.handle('ai:models', () => ({ ok: true, data: ['gpt-4o-mini', 'sonar'] }));
ipcMain.handle('ai:test', () => ({ ok: true, data: { ok: true, reply: '可用', ms: 812, model: 'gpt-4o-mini' } }));
ipcMain.handle('ai:testWebSearch', () => ({ ok: true, data: { level: 'no', evidence: '模型自己说不能联网' } }));
ipcMain.handle('ai:polish', () => ({ ok: true, data: { lines: [], mode: 'polish', fromCache: false, key: 'k' } }));
ipcMain.handle('ai:generate', () => {
  if (genMode === 'fail') {
    return { ok: false, error: 'AI 返回 429：额度用完了或被限流，等会儿再试', reason: 'quota' };
  }
  return {
    ok: true,
    data: {
      mode: 'gen', fromCache: false, instrumental: false, key: 'k',
      debug: {
        mode: 'gen', model: 'gpt-4o-mini', attempt: 1, finish: 'stop',
        prompt: '你是歌词整理助手。请给出下面这首歌的歌词，用 LRC 格式。\n\n视频标题：银河与星斗\n视频时长：269 秒\n…',
        content: '<lrc>\n[00:12.40]晚风轻踩着云朵\n[00:16.80]月亮在贩售快乐\n[00:21.20]你从银河背后靠近我\n</lrc>',
        reasoning: 'Need produce LRC. The instruction says must not fabricate. I think the song is 银河与星斗 by A零距离…',
      },
      lines: [
        { t: 8.5, text: '如果我说我真的爱你' },
        { t: 13.2, text: '来回应你的不言语' },
        { t: 18.0, text: '如果你已经不能控制每天想我一次' },
      ],
    },
  };
});

['win-min', 'win-max', 'win-close', 'win:close-ready', 'win:fullscreen', 'win:mini',
  'lyric:open', 'lyric:close', 'lyric:through', 'lyric:style', 'lyric:push', 'lyric:line',
  'lyric:move', 'ui-state', 'win:ui-state'].forEach((c) => ipcMain.on(c, () => {}));
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);
  const ev = (code) => win.webContents.executeJavaScript(code);

  const shoot = async (name) => {
    await sleep(800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
    console.log('  → ' + name + '  ' + img.getSize().width + '×' + img.getSize().height);
  };
  const clearToast = () => ev(`(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()`);

  /* 1) 设置页 AI 那块 */
  await ev(`(() => {
    const a = DB.settings.aiLyrics;
    a.enabled = true; a.aiPolish = true; a.aiGenerate = true;
    a.baseURL = 'https://api.openai.com/v1';
    a.model = 'gpt-4o-mini';
    a.webSearch = 'no';
    openSettings(); showSettingsTab('lyric');
    return true;
  })()`);
  await sleep(700);
  // 滚到 AI 那一块（设置面板自己的滚动容器）。用 rect 差值算，别用 offsetTop ——
  // 这些元素的 offsetParent 是 .modal-mask（fixed），offsetTop 会带上一截偏移。
  await ev(`(() => {
    const box = document.querySelector('.modal-body');
    const el = document.getElementById('selAiTokens').closest('.ai-row');
    if (box && el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    return true;
  })()`);
  await shoot('shot-v212-settings.png');

  /* 2) 提示词面板 */
  await ev(`document.getElementById('btnAiPrompts').click(); true`);
  await sleep(600);
  await shoot('shot-v212-prompt.png');
  await ev(`document.getElementById('aiPromptMask').classList.remove('show'); true`);

  /* 3) 兜底生成的小标 */
  await ev(`(() => {
    document.getElementById('modalMask').classList.remove('show');
    queue = { tracks: [${JSON.stringify(TRACK)}], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    toggleLyrics(true);
    loadLyrics(false);
    return true;
  })()`);
  await sleep(900);
  await clearToast();
  await shoot('shot-v212-gen.png');

  /* 3b) 点小标 → 看 AI 到底回了什么 */
  await ev(`document.getElementById('lyricTag').click(); true`);
  await sleep(600);
  await shoot('shot-v212-reply.png');
  await ev(`document.getElementById('btnAiReplyClose').click(); true`);

  /* 4) 生成失败：原因写在空状态里 */
  genMode = 'fail';
  await ev(`(() => {
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    loadLyrics(false);
    return true;
  })()`);
  await sleep(900);
  await clearToast();
  await shoot('shot-v212-fail.png');

  console.log('截图完成');
  setTimeout(() => process.exit(0), 200);
}).catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); setTimeout(() => process.exit(2), 200); });
