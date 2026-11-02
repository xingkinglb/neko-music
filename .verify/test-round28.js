/* v2.12.4 随机播放实测（离屏 + 真跑应用代码）。
   跑：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox .verify/test-round28.js

   ★ 为什么要专门测这个
     用户的原话是"队列一千多歌，两小时内连续听到了很多同一首"。
     旧实现是 `Math.floor(Math.random() * n)` —— 每首独立随机、**有放回**，
     这在数学上必然重复（生日悖论），不是 bug 是设计错。
     所以这里不能用"看起来差不多"来验收，得把**重复次数**量出来。

   ★ 怎么量
     拿同一个队列跑 500 次切歌，数"听到了多少首不同的歌"。
       旧算法：期望约 393 首不同 → 约 107 次重复
       新算法：一轮内 0 次重复
     两套算法都在这个脚本里跑一遍，对比着看。

   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const say = (m) => console.log(m);

app.disableHardwareAcceleration();

/* 只填 boot 需要的几个，别的留空 */
ipcMain.handle('store:load', () => ({ ok: true, data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} } }));
ipcMain.handle('store:save', () => ({ ok: true, data: true }));
ipcMain.handle('cookie:get', () => ({ ok: true, data: '' }));
ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: false }));
ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));

/* ★ 下载/本地那两组 IPC 用公共桩。不加的话渲染层启动时那次 `download:list`
   会挂一条「No handler registered」—— 而本脚本把"页面有报错"判成 FAIL，
   于是**桩缺了会被当成产品坏了**，一眼看不出区别（stub 文件顶上就写着这个坑）。 */
require('./stub-download-ipc.js')();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 760, show: false, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(1200);
  const ev = (code) => win.webContents.executeJavaScript(code);

  const N = 1000;

  /* ================= 1) 洗牌表本身 ================= */
  say('\n[1] 洗牌表是个完整排列：');
  const r1 = await ev(`(() => {
    queue = { tracks: Array.from({ length: ${N} }, (_, i) => ({ bvid: 'BV' + i, cid: i, title: 'T' + i })), index: -1, name: 'x', source: null };
    playMode = 'shuffle';
    reshuffle(0);
    const s = new Set(shuffleOrder);
    return { len: shuffleOrder.length, uniq: s.size, first: shuffleOrder[0], min: Math.min(...shuffleOrder.slice(0, 50)), max: Math.max(...shuffleOrder.slice(0, 50)) };
  })()`);
  if (r1.len !== N) bad(`长度 ${r1.len} ≠ ${N}`);
  else if (r1.uniq !== N) bad(`有重复：${r1.uniq} 个不同的下标`);
  else ok(`${N} 个下标一个不多一个不少`);
  if (r1.first !== 0) bad(`起点没钉在第一位（第一位是 ${r1.first}）`);
  else ok('起点曲目（0）钉在第一位');

  /* ================= 2) 核心：500 次切歌的重复次数 ================= */
  say('\n[2] 500 次切歌，听到多少首不同的歌：');
  const cmp = await ev(`(() => {
    const N = ${N}, STEPS = 500;

    // ---- 旧算法：每次独立随机，只避开"连着两次同一首" ----
    let cur = 0;
    const oldSeen = new Set([cur]);
    for (let k = 0; k < STEPS; k++) {
      let i = cur;
      for (let g = 0; g < 20 && i === cur; g++) i = Math.floor(Math.random() * N);
      cur = i;
      oldSeen.add(i);
    }

    // ---- 新算法：走洗牌表 ----
    queue = { tracks: Array.from({ length: N }, (_, i) => ({ bvid: 'BV' + i, cid: i })), index: -1, name: 'x', source: null };
    reshuffle(0);
    const newSeen = new Set();
    for (let k = 0; k < STEPS; k++) {
      const at = k % N;
      if (at === 0 && k > 0) reshuffle();
      newSeen.add(shuffleOrder[at]);
    }

    return { oldDistinct: oldSeen.size, newDistinct: newSeen.size, steps: STEPS };
  })()`);
  const oldDup = cmp.steps - cmp.oldDistinct;
  const newDup = cmp.steps - cmp.newDistinct;
  say(`    旧算法：${cmp.oldDistinct} 首不同 → ${oldDup} 次重复`);
  say(`    新算法：${cmp.newDistinct} 首不同 → ${newDup} 次重复`);
  if (newDup !== 0) bad(`新算法在一轮内出现了 ${newDup} 次重复`);
  else ok('新算法一轮之内 0 重复');
  if (oldDup < 30) bad(`旧算法的重复只有 ${oldDup} 次，样本可能失效（期望 80 次以上）`);
  else ok(`旧算法确实重复严重（${oldDup} 次）—— 印证了用户的体感不是错觉`);

  /* ================= 3) 换轮时不扎堆 ================= */
  say('\n[3] 换轮重洗后，新一轮开头不会还是刚听过的那批：');
  const r3 = await ev(`(() => {
    // ★ 队列必须**大于** recent 上限（300），否则"最近听过"会把全队列占满，
    //   那前 50 首当然全撞 —— 那是用例设计错了，不是实现错了（第一次就是这么翻车的）。
    const N = 1000;
    queue = { tracks: Array.from({ length: N }, (_, i) => ({ bvid: 'BV' + i, cid: i })), index: -1, name: 'x', source: null };
    shuffleRecent.length = 0;
    // 先把这一轮全播完，让 recent 里装满（它自己会截到最近 300 首）
    reshuffle(0);
    for (const i of shuffleOrder) noteShufflePlay(queue.tracks[i]);
    const before = new Set(shuffleRecent);
    // 换轮
    reshuffle();
    let hit = 0;
    for (let k = 0; k < 50; k++) if (before.has(selKey(queue.tracks[shuffleOrder[k]]))) hit++;
    return { recent: shuffleRecent.length, hit, n: N };
  })()`);
  say(`    队列 ${r3.n} 首、最近听过 ${r3.recent} 首 → 新一轮前 50 首里撞到 ${r3.hit} 首`);
  if (r3.recent !== 300) bad(`recent 应该截到 300，实际 ${r3.recent}`);
  else if (r3.hit > 0) bad(`新一轮开头还有 ${r3.hit} 首是刚听过的（应该被挪到后面）`);
  else ok('新一轮前 50 首全是最近没听过的');

  /* ================= 4) 队列长度变了会重洗 ================= */
  say('\n[4] 队列增删之后自动重洗：');
  const r4 = await ev(`(() => {
    queue.tracks.push({ bvid: 'BVnew', cid: 999 });
    const before = shuffleOrder.length;
    ensureShuffle();
    return { before, after: shuffleOrder.length, n: queue.tracks.length, hasNew: shuffleOrder.includes(queue.tracks.length - 1) };
  })()`);
  if (r4.after !== r4.n) bad(`加了一首之后洗牌表没更新（${r4.after} vs ${r4.n}）`);
  else if (!r4.hasNew) bad('新加的歌没进洗牌表 —— 随机模式下永远播不到它');
  else ok(`加歌后洗牌表从 ${r4.before} 变成 ${r4.after}，新歌也在表里`);

  /* ================= 5) 切到随机模式会自动洗 ================= */
  say('\n[5] 从别的模式切到随机：');
  const r5 = await ev(`(() => {
    queue = { tracks: Array.from({ length: 50 }, (_, i) => ({ bvid: 'BV' + i, cid: i })), index: 7, name: 'x', source: null };
    shuffleOrder = [];
    setPlayMode('list', false);
    setPlayMode('shuffle', false);
    return { len: shuffleOrder.length, first: shuffleOrder[0] };
  })()`);
  if (r5.len !== 50) bad(`切到随机后没洗牌（长度 ${r5.len}）`);
  else if (r5.first !== 7) bad(`洗牌后没把正在播的那首（7）钉在第一位，而是 ${r5.first}`);
  else ok('切到随机立刻重洗，并把正在播的那首钉在第一位');

  /* ================= 5.5) 小队列（最容易露馅） ================= */
  say('\n[5.5] 只有 2 首的队列：');
  /* ★ 这是 test-round6 抓出来的真 bug：队列小的时候「最近听过」名单会把整个
     队列盖住，reshuffle 里"把刚听过的往后挪"等于没做 —— 一轮播完重洗，
     第一首可能还是刚播完的那首，听起来就是"按了下一首还在放同一首"。
     这里单独守一条，比只在 round6 里间接覆盖更明确。 */
  const small = await ev(`(() => {
    queue = { tracks: [{ bvid: 'A' }, { bvid: 'B' }], index: 0, name: 'x', source: null };
    shuffleRecent.length = 0;
    reshuffle(0);
    // 照 next() 的随机分支走一遍（除 goTo 之外逻辑相同）
    let cur = 0;
    const seq = [cur];
    for (let k = 0; k < 20; k++) {
      ensureShuffle();
      let at = shuffleOrder.indexOf(cur);
      if (at < 0) { reshuffle(cur); at = 0; }
      at += 1;
      // 和 next() 保持同一套写法：换轮时把"刚播完的"传给 avoidFirst
      if (at >= 2) { reshuffle(-1, cur); at = 0; }
      cur = shuffleOrder[at];
      seq.push(cur);
    }
    let same = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) same++;
    return { same, seq: seq.slice(0, 8).join('') };
  })()`);
  if (small.same > 0) bad(`2 首队列连走 20 步，出现 ${small.same} 次"连着两次同一首"（序列 ${small.seq}）`);
  else ok('2 首队列连走 20 步，一次都没有连播同一首');

  /* ================= 6) 页面报错 ================= */
  say('\n[6] 页面报错：');
  if (errors.length) {
    errors.slice(0, 5).forEach((e) => say('    ' + e));
    bad(`页面报了 ${errors.length} 条错`);
  } else ok('全程没有页面报错');

  say(fail === 0 ? '\n随机播放实测：全部通过 ✅' : `\n随机播放实测：${fail} 处失败 ❌`);
  fs.writeFileSync(path.join(__dirname, 'test-round28-report.txt'),
    fail === 0 ? '全部通过 ✅\n\n退出码 0\n' : `${fail} 处失败 ❌\n\n退出码 1\n`);
  app.exit(fail === 0 ? 0 : 1);
});
