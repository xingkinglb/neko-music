/* 第十三轮实测（离屏渲染 + 真跑应用代码，不是文本断言）：
     v2.3.0 —— 设置面板新增「快捷键」页。

   以前那 11 条快捷键**写死在 app.js 的全局 keydown 里**（一个功能一条 if）。
   这一轮把它们搬到 KEY_ACTIONS 一张表上，界面、存档、按键匹配全从表来，
   并且让用户能自己改键位。

   ★★ 这一轮最大的坑（必须专门测）：
      以前是"一个 if 一条"，靠**代码顺序**让 Ctrl+← 先命中（Ctrl+← 写在 ← 前面）。
      改成"查表"之后顺序由表决定，所以匹配时**修饰键必须完全一致** ——
      否则按一次 Ctrl+← 会同时触发"上一首"和"快退 5 秒"。
      本文件第 [6] 组就是专门守这一条的。

   ★ 全部用真代码：真实的 index.html + app.js + preload，
     真派发 KeyboardEvent（不是直接调函数），真点 DOM 按钮。
     main 进程那一侧（store / bili）是桩，因为要联网。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-keys-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const finish = (code) => { say('退出码 ' + code); setTimeout(() => process.exit(code), 150); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

/* ================= 种子存档（★ 老存档：没有 settings.keys） ================= */
function seedStore() {
  return {
    ok: true,
    playlists: [], favorites: [], history: [],
    lastTrack: { bvid: 'BV1ybj66YEpv', cid: '39243287210', page: '1', title: '探故知', duration: '202', author: '皓晨音乐', cover: '' },
    collectOff: {}, collectParts: {}, collectCovers: {},
    settings: {
      theme: 'pink', volume: 60,
      bg: { file: null, dim: 0.55, blur: 0 },
      glass: { blur: 18, alpha: 0.55 },
      autoLyric: false, close: { action: 'ask' },
      // ★ 故意不写 keys —— 这就是所有老存档的样子，必须"零迁移"
    },
  };
}

let lastSaved = seedStore();
let win = null;

/* ---------------- 主进程桩 ---------------- */
ipcMain.on('win:ui-state', () => {});
ipcMain.on('win:close-choice', () => {});
ipcMain.on('win:close-ready', () => {});
ipcMain.on('win-close', () => {});

ipcMain.handle('store:load', () => ({ ok: true, data: lastSaved }));
ipcMain.handle('store:save', (_e, data) => {
  lastSaved = JSON.parse(JSON.stringify(data));
  return { ok: true, data: true };
});
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('cookie:set', () => ({ ok: true, data: true }));
ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '测试环境不给字幕', reason: 'none' }));
ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'https://example.invalid/a.m4s', quality: 30280, duration: 200, backup: [] } }));
ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BV1ybj66YEpv' } }));
ipcMain.handle('bili:upVideos', () => ({ ok: true, data: { list: [], hasMore: false } }));
ipcMain.handle('bili:favFolders', () => ({ ok: true, data: [] }));
ipcMain.handle('bili:favMedias', () => ({ ok: true, data: { list: [] } }));
ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: { bvid: 'BV1ybj66YEpv', title: '测试', cover: '', owner: { mid: 1, name: 'x' }, duration: 200, pages: [], season: null } }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));
ipcMain.handle('shell:open', () => ({ ok: true, data: true }));

ipcMain.on('win-min', () => {});
ipcMain.on('win-max', () => {});
ipcMain.on('win:fullscreen', () => {});
ipcMain.on('win:mini', () => {});
ipcMain.on('win:cmd', () => {});
ipcMain.on('lyric:open', () => {});
ipcMain.on('lyric:close', () => {});
ipcMain.on('lyric:push', () => {});
ipcMain.on('lyric:style', () => {});
ipcMain.on('lyric:through', () => {});
ipcMain.on('lyric:cmd', () => {});
ipcMain.on('lyric:moved', () => {});

/* ================= 小工具 ================= */
let evalJS = null;
const click = (sel) => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/** 真派发一次 keydown。target 默认 document.body（= 焦点不在输入框里的普通情况） */
const press = (o) => evalJS(`(() => {
  const t = ${o.target ? JSON.stringify(o.target) : 'null'} ||
            (${o.sel ? `document.querySelector(${JSON.stringify(o.sel)})` : 'null'}) || document.body;
  const e = new KeyboardEvent('keydown', {
    key: ${JSON.stringify(o.key)}, code: ${JSON.stringify(o.code || '')},
    ctrlKey: ${!!o.ctrl}, altKey: ${!!o.alt}, shiftKey: ${!!o.shift},
    bubbles: true, cancelable: true,
  });
  t.dispatchEvent(e);
  return true;
})()`);

const state = () => evalJS(`(() => ({
  keys: JSON.parse(JSON.stringify(DB.settings.keys || {})),
  recording: recordingKeyId,
  lyricOn: !!document.getElementById('lyricOverlay').classList.contains('show'),
  vol: Math.round((audio.volume || 0) * 100),
  clash: document.getElementById('keyClashMask').classList.contains('show'),
  settingsOpen: document.getElementById('modalMask').classList.contains('show'),
  clashText: (document.getElementById('keyClashText').textContent || '').slice(0, 80),
  rows: document.querySelectorAll('#keyList .key-row').length,
  boxToggleLyric: (document.querySelector('[data-key-box="toggleLyric"]') || {}).textContent || '',
  boxTogglePlay: (document.querySelector('[data-key-box="togglePlay"]') || {}).textContent || '',
  paneOn: (document.querySelector('.pane[data-pane="keys"]') || {}).classList.contains('show')
        || (document.querySelector('.pane[data-pane="keys"]') || {}).classList.contains('active'),
  coverTitle: document.getElementById('npCover').title,
}))()`);

/* ============================================================
   开工
   ============================================================ */
app.whenReady().then(async () => {
  say('=== v2.3.0 快捷键设置页 · 离屏实测 ===\n');

  win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  evalJS = (code) => win.webContents.executeJavaScript(code);

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
    if (level >= 2 && !/media|video|decode|DEMUXER|pipeline|播放失败/i.test(msg)) {
      errors.push('[页面] ' + msg + ' ← ' + String(sourceId || '').replace(/^.*[\\/]/, '') + ':' + line);
    }
  });

  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1000);

  /* ========================================================
     [1] 老存档零迁移：存档里没有 keys → 全用默认键
     ======================================================== */
  say('[1] 老存档零迁移（存档里本来没有 settings.keys）：');
  {
    const s = await state();
    say(`  DB.settings.keys = ${JSON.stringify(s.keys)}`);
    if (Object.keys(s.keys).length !== 0) bad(`老存档读进来 keys 不是空的：${JSON.stringify(s.keys)}`);
    else ok('老存档读进来 settings.keys 是空的（= 全用默认键，行为和以前一模一样）');

    if (!s.coverTitle || s.coverTitle.indexOf('Ctrl') < 0) {
      bad(`★ 开机时封面的提示里没有键位：「${s.coverTitle}」—— refreshKeyHints 没跑`);
    } else ok(`开机时提示已经拼上键位：「${s.coverTitle}」`);

    const hasEsc = await evalJS(`KEY_ACTIONS.some((a) => a.def === 'Escape' || a.id === 'escape')`);
    if (hasEsc) bad('★ Esc 被放进了键位表 —— 它是所有面板的逃生键，绑走之后面板就关不掉');
    else ok('Esc 不在键位表里（它永远是"取消 / 关面板"）');
  }

  /* ========================================================
     [2] 打开设置 → 快捷键页：列表画出来了吗
     ======================================================== */
  say('\n[2] 设置面板的「快捷键」页：');
  {
    await click('#btnSettings');
    await sleep(200);
    await click('.tab[data-tab="keys"]');
    await sleep(200);
    const s = await state();
    say(`  行数 = ${s.rows}，整页歌词那一格显示「${s.boxToggleLyric}」`);
    if (!s.paneOn) bad('点了「快捷键」标签，那一页没有切出来');
    else ok('「快捷键」页能切出来（标签切换逻辑是通用的，一页都没改）');
    if (s.rows < 11) bad(`列表只有 ${s.rows} 行（以前写死在代码里的是 11 条，不能变少）`);
    else ok(`列表画出了 ${s.rows} 行（全从 KEY_ACTIONS 来）`);
    if (s.boxToggleLyric.replace(/\s/g, '') !== 'Ctrl+D') {
      bad(`「整页歌词」那格显示「${s.boxToggleLyric}」，期望「Ctrl + D」`);
    } else ok('默认键位显示的是人话（Ctrl + D，不是 ctrl && e.key === "d"）');
  }

  /* ========================================================
     [3] 改键：点框 → 按新键 → 存进存档 + 框里跟着变 + 提示跟着变
     ======================================================== */
  say('\n[3] 改键（点键位框 → 直接按新键）：');
  {
    await click('[data-key-box="toggleLyric"]');
    await sleep(120);
    let s = await state();
    if (s.recording !== 'toggleLyric') bad(`点了键位框没进入录制态（recordingKeyId=${s.recording}）`);
    else ok('点键位框 → 进入录制态');

    await press({ key: 'j', ctrl: true });
    await sleep(400);
    s = await state();
    say(`  DB.settings.keys = ${JSON.stringify(s.keys)}  框里显示「${s.boxToggleLyric}」`);
    if (s.keys.toggleLyric !== 'Ctrl+j') bad(`★ 存档里没记上：期望 'Ctrl+j'，实际 ${JSON.stringify(s.keys.toggleLyric)}`);
    else ok('新键位存进了 settings.keys.toggleLyric');
    if (s.boxToggleLyric.replace(/\s/g, '') !== 'Ctrl+J') bad(`框里显示「${s.boxToggleLyric}」，期望「Ctrl + J」`);
    else ok('框里立刻显示成新键位');
    if (s.coverTitle.indexOf('Ctrl') < 0 || s.coverTitle.indexOf('J') < 0) {
      bad(`★ 播放条封面的提示没跟着变：「${s.coverTitle}」`);
    } else ok(`界面提示也跟着变了：「${s.coverTitle}」`);
  }

  /* ========================================================
     [4] 改完真的能用 + [5] 旧键位失效
     ======================================================== */
  say('\n[4] 改完真的能用 / [5] 旧键位失效：');
  {
    let s = await state();
    const before = s.lyricOn;
    await press({ key: 'j', ctrl: true });          // 新键
    await sleep(250);
    s = await state();
    if (s.lyricOn === before) bad('★ 按新键 Ctrl+J 没有打开整页歌词 —— 改了键位却没生效');
    else ok('按新键 Ctrl+J 真的打开了整页歌词（改完就能用）');

    await press({ key: 'j', ctrl: true });          // 收回去
    await sleep(250);
    s = await state();
    if (s.lyricOn !== before) bad('再按一次没有收回去（toggle 失灵）');
    else ok('再按一次又收回去了（是"开 / 关"切换，不是只能开）');

    await press({ key: 'd', ctrl: true });          // 旧键
    await sleep(250);
    s = await state();
    if (s.lyricOn !== before) bad('★ 旧键位 Ctrl+D 还在生效 —— 改了等于没改');
    else ok('旧键位 Ctrl+D 不再触发（改键是真的改了）');
  }

  /* ========================================================
     [6] ★★ 修饰键必须"完全一致"（这一轮最大的坑）
     ======================================================== */
  say('\n[6] ★ 修饰键完全一致（按 Ctrl+← 只许触发「上一首」，不能顺带「快退」）：');
  {
    // 给 runKeyAction 挂个记录器，看一次按键到底触发了哪几条。
    // ★ 用默认键位来测（Ctrl+←=上一首、←=快退）—— 这正是改造前靠"代码顺序"
    //   才没出事的那对组合，改成查表之后必须"修饰键完全一致"才守得住。
    await evalJS(`(() => {
      window.__keylog = [];
      const orig = runKeyAction;
      runKeyAction = function (id) { window.__keylog.push(id); return orig(id); };
      DB.settings.keys = {}; persist(); renderKeyList(); return true;
    })()`);
    await sleep(300);

    await press({ key: 'ArrowLeft', ctrl: true });  // 带 Ctrl → 只该命中「上一首」
    await sleep(250);
    let log = await evalJS('window.__keylog');
    say(`  按 Ctrl+← 触发了：${JSON.stringify(log)}`);
    if (!log.includes('prevTrack')) bad('★ 按 Ctrl+← 没有触发「上一首」');
    else ok('按 Ctrl+← 触发了「上一首」');
    if (log.includes('seekBack')) bad('★★ 按 Ctrl+← 还顺带触发了「快退 5 秒」—— 修饰键没参与比较！（一轮最大的坑）');
    else ok('★ 按 Ctrl+← **没有**顺带触发「快退 5 秒」（修饰键完全一致才算命中）');

    await evalJS('window.__keylog = []');
    await press({ key: 'ArrowLeft' });              // 不带 Ctrl → 只该命中「快退」
    await sleep(250);
    log = await evalJS('window.__keylog');
    say(`  按 ← 触发了：${JSON.stringify(log)}`);
    if (!log.includes('seekBack')) bad('★ 按 ← 没有触发「快退 5 秒」');
    else ok('按 ← 触发了「快退 5 秒」');
    if (log.includes('prevTrack')) bad('★ 按 ← 还顺带触发了「上一首」');
    else ok('按 ← **没有**顺带触发「上一首」');

    // 换成自定义键位再来一遍同样的事（证明"存进存档的字符串"匹配也一样严）
    await evalJS(`(() => {
      window.__keylog = [];
      DB.settings.keys = { prevTrack: 'Ctrl+ArrowLeft', seekBack: 'ArrowLeft' };
      persist(); renderKeyList(); return true;
    })()`);
    await sleep(300);
    await press({ key: 'ArrowLeft', ctrl: true });
    await sleep(250);
    log = await evalJS('window.__keylog');
    say(`  （自定义键位）按 Ctrl+← 触发了：${JSON.stringify(log)}`);
    if (!log.includes('prevTrack') || log.includes('seekBack')) {
      bad('★ 自定义键位下修饰键比较不对：' + JSON.stringify(log));
    } else ok('自定义键位下同样只命中「上一首」（存档里的字符串匹配也一样严）');

    await evalJS(`(() => { DB.settings.keys = {}; persist(); renderKeyList(); return true; })()`);
    await sleep(300);
  }

  /* ========================================================
     [7] 冲突：这个键已经被别的动作用了 → 弹提示，不静默改
     ======================================================== */
  say('\n[7] 撞车了要问一句（不静默改）：');
  {
    await evalJS(`(() => { DB.settings.keys = { toggleLyric: 'Ctrl+j' }; persist(); renderKeyList(); return true; })()`);
    await sleep(300);

    await click('[data-key-box="toggleDeskLyric"]');
    await sleep(120);
    await press({ key: 'j', ctrl: true });          // 已被「整页歌词」用了
    await sleep(250);
    let s = await state();
    say(`  弹窗=${s.clash}  文案「${s.clashText}」  settings.keys=${JSON.stringify(s.keys)}`);
    if (!s.clash) bad('★ 撞车了却没弹提示 —— 会静默改成两条共用一个键');
    else ok('撞车时弹出了冲突提示');
    if (s.keys.toggleDeskLyric) bad('★ 还没确认就已经把键位改掉了');
    else ok('没确认之前不会改（确定要改才算）');

    await click('#keyClashCancel');                 // 取消
    await sleep(200);
    s = await state();
    if (s.clash) bad('点了「取消」弹窗没关');
    else ok('点「取消」→ 弹窗关掉，键位保持原样');
    if (s.keys.toggleLyric !== 'Ctrl+j') bad('取消之后原来那条被动了');
    else ok('取消之后原来那条没被动');

    await click('[data-key-box="toggleDeskLyric"]');
    await sleep(120);
    await press({ key: 'j', ctrl: true });
    await sleep(250);
    await click('#keyClashTake');                   // 让出来
    await sleep(400);
    s = await state();
    say(`  让出来之后 settings.keys = ${JSON.stringify(s.keys)}`);
    if (s.keys.toggleDeskLyric !== 'Ctrl+j') bad(`★ 点「让出来」之后没绑上：${JSON.stringify(s.keys)}`);
    else ok('点「让出来」→ 新键位绑上了');
    if (s.keys.toggleLyric === 'Ctrl+j') bad('★ 旧的那条还指着同一个键 —— 两条会打架，谁生效全看顺序');
    else ok(`旧的那条让出来了（整页歌词回到默认 ${JSON.stringify(s.keys.toggleLyric || 'Ctrl+d')}）`);

    // 冲突提示开着时 Esc 也要取消待确认操作，不可把设置页一起关掉
    await evalJS(`(() => { DB.settings.keys = { toggleLyric: 'Ctrl+j' }; persist(); renderKeyList(); return true; })()`);
    await sleep(300);
    await click('[data-key-box="toggleDeskLyric"]');
    await sleep(120);
    await press({ key: 'j', ctrl: true });
    await sleep(180);
    await press({ key: 'Escape' });
    await sleep(250);
    s = await state();
    if (s.clash || s.recording) bad('冲突提示里按 Esc 没有清掉待确认的录制');
    else ok('冲突提示里按 Esc → 关提示并取消待确认改键');
    if (!s.settingsOpen) bad('★ 录制冲突时按 Esc 把整个设置面板也关了');
    else ok('冲突提示 / 录制时的 Esc 不会顺带关掉设置页');
    if (s.keys.toggleLyric !== 'Ctrl+j' || s.keys.toggleDeskLyric) bad('Esc 取消冲突时改动了原键位');
    else ok('Esc 取消冲突时没有动任何键位');
  }

  /* ========================================================
     [8] Esc 取消录制（Esc 永远绑不走）
     ======================================================== */
  say('\n[8] 录制时按 Esc = 取消：');
  {
    await evalJS(`(() => { DB.settings.keys = {}; persist(); renderKeyList(); return true; })()`);
    await sleep(300);
    await click('[data-key-box="togglePlay"]');
    await sleep(120);
    let s = await state();
    if (s.recording !== 'togglePlay') bad('没进入录制态');
    await press({ key: 'Escape' });
    await sleep(250);
    s = await state();
    say(`  recording=${s.recording}  settings.keys=${JSON.stringify(s.keys)}`);
    if (s.recording) bad('★ 按了 Esc 还在录制态');
    else ok('按 Esc → 退出录制态');
    if (!s.settingsOpen) bad('★ 按 Esc 取消录制时把整个设置面板也关掉了');
    else ok('Esc 只取消录制，不会关掉设置页');
    if (s.keys.togglePlay) bad(`★ Esc 被当成键位绑上去了：${JSON.stringify(s.keys.togglePlay)}`);
    else ok('Esc 没有被绑成键位（它永远是"取消 / 关面板"）');
  }

  /* ========================================================
     [9] 恢复默认（单条 ↺ + 全部）
     ======================================================== */
  say('\n[9] 恢复默认：');
  {
    await evalJS(`(() => { DB.settings.keys = { toggleLyric: 'Ctrl+j', volUp: 'Ctrl+ArrowLeft' }; persist(); renderKeyList(); return true; })()`);
    await sleep(300);

    await click('[data-key-reset="toggleLyric"]');
    await sleep(400);
    let s = await state();
    if (s.keys.toggleLyric) bad(`★ 单条恢复默认没生效：${JSON.stringify(s.keys.toggleLyric)}`);
    else ok('点那一行的 ↺ → 这一条回到默认');
    if (!s.keys.volUp) bad('★ 恢复一条把另一条也恢复了');
    else ok('只恢复了点的那一条，别的没动');
    if (s.boxToggleLyric.replace(/\s/g, '') !== 'Ctrl+D') bad(`框里没回到默认显示：「${s.boxToggleLyric}」`);
    else ok('框里的显示也回到默认了');

    await click('#btnResetKeys');
    await sleep(400);
    s = await state();
    say(`  全部恢复之后 settings.keys = ${JSON.stringify(s.keys)}`);
    if (Object.keys(s.keys).length !== 0) bad(`★ 「全部恢复默认」没清空：${JSON.stringify(s.keys)}`);
    else ok('点「全部恢复默认」→ 键位全清空（= 都用默认键）');
  }

  /* ========================================================
     [10] 输入框里快捷键让路（老规矩，一点都不能动）
     ======================================================== */
  say('\n[10] 焦点在输入框里时快捷键让路：');
  {
    let s = await state();
    const before = s.lyricOn;
    await press({ key: 'd', ctrl: true, sel: '#searchInput' });
    await sleep(250);
    s = await state();
    if (s.lyricOn !== before) bad('★★ 在搜索框里按 Ctrl+D 还是触发了整页歌词 —— 打个字就被切走，这规矩不能破');
    else ok('在搜索框里按 Ctrl+D 不触发（输入框里一律让路）');

    await press({ key: 'd', ctrl: true });          // 焦点在 body → 该触发
    await sleep(250);
    s = await state();
    if (s.lyricOn === before) bad('★ 焦点不在输入框时 Ctrl+D 反而不触发了');
    else ok('焦点不在输入框时 Ctrl+D 正常触发（让路只让输入框里的）');
    await press({ key: 'd', ctrl: true });
    await sleep(200);
  }

  /* ========================================================
     [11] 存档往返：改完 → 存盘 → 读回来还在
     ======================================================== */
  say('\n[11] 存档往返（改完重启还在）：');
  {
    await evalJS(`(() => { DB.settings.keys = { nextTrack: 'Ctrl+ArrowRight', togglePlay: 'Ctrl+p' }; persist(); return true; })()`);
    await sleep(500);
    const saved = (lastSaved.settings && lastSaved.settings.keys) || null;
    say(`  写盘的 settings.keys = ${JSON.stringify(saved)}`);
    if (!saved || saved.togglePlay !== 'Ctrl+p') bad(`★ 没写进存档：${JSON.stringify(saved)}`);
    else ok('改过的键位写进了存档');

    // 模拟"下次启动"：拿写盘那份再过一遍 sanitizeKeys（migrateSettings 里走的就是它）
    const round = await evalJS(`(() => {
      const back = sanitizeKeys(${JSON.stringify(saved)});
      return back;
    })()`);
    if (round.togglePlay !== 'Ctrl+p' || round.nextTrack !== 'Ctrl+ArrowRight') {
      bad(`★ 读回来丢了：${JSON.stringify(round)}`);
    } else ok('用写盘那份重跑 sanitizeKeys → 键位还在（存档往返没问题）');

    // 手改坏了的存档不能把界面搞崩
    const junk = await evalJS(`(() => {
      const a = sanitizeKeys(null);
      const b = sanitizeKeys([]);
      const c = sanitizeKeys({ togglePlay: 123, 不存在的动作: 'Ctrl+z', volUp: 'Ctrl+ArrowUp' });
      return { a, b, c };
    })()`);
    if (Object.keys(junk.a).length || Object.keys(junk.b).length) bad('sanitizeKeys 对 null / 数组没有返回空对象');
    else if (junk.c.togglePlay || junk.c['不存在的动作']) bad(`sanitizeKeys 没丢掉不合法的值：${JSON.stringify(junk.c)}`);
    else if (!junk.c.volUp) bad('sanitizeKeys 把合法的也丢了');
    else ok('sanitizeKeys 会把 null / 数组 / 不认识的动作 / 非字符串全丢掉（存档被手改坏也不崩）');
  }

  /* ========================================================
     [12] 页面报错
     ======================================================== */
  say('\n[12] 页面报错：');
  if (errors.length) { errors.slice(0, 8).forEach((e) => bad(e)); }
  else ok('全程没有页面报错');

  say(`\n=== 结果：${fail === 0 ? '全部通过 ✅' : fail + ' 处失败 ❌'} ===`);
  finish(fail === 0 ? 0 : 1);
}).catch((e) => {
  say('崩了：' + (e && e.stack ? e.stack : e));
  finish(2);
});
