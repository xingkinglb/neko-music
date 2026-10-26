/* 临时脚本：实测 verify.js 第 56 类的**判别力**。
   做法：把某个实现故意改坏 → 跑 verify.js → 看对应那条断言有没有响 → 还原。
   一条都不响的话，说明这条断言只是在"描述现状"，不是在"拦人"。
   ★ 用完就删（它自己会还原文件，不会留下改动）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const VERIFY = path.join(__dirname, 'verify.js');

/** 每一例：文件 + 原文 + 改成什么 + 期望在报告里看到的错误关键词 */
const CASES = [
  {
    name: '绿勾改成主题色（薄荷绿主题下会分不清）',
    file: 'src/ui/style.css',
    from: '.op-ic.done { background: rgb(var(--ok-rgb) / 0.16); color: var(--ok); }',
    to:   '.op-ic.done { background: rgb(var(--accent-rgb) / 0.16); color: var(--accent); }',
    expect: '绿勾用了 var(--accent)',
  },
  {
    name: '下载任务塞回 neko-data.json',
    file: 'src/store-migrate.js',
    from: '  d.local     = Array.isArray(d.local)     ? d.local     : [];',
    to:   '  d.local     = Array.isArray(d.local)     ? d.local     : [];\n  d.downloads = Array.isArray(d.downloads) ? d.downloads : [];',
    expect: '下载任务被塞回了 neko-data.json',
  },
  {
    name: 'local:// 白名单改成拼接 + startsWith（可被 .. 绕过）',
    file: 'src/local-protocol.js',
    from: 'if (!wl.has(target))',
    to:   'if (![...wl].some((x) => target.startsWith(x)))',
    expect: '没有用 Set.has 做精确匹配',
  },
  {
    name: '「我喜欢」的「批量选择」按钮被删掉',
    file: 'src/ui/app.js',
    from: 'id="btnSelectFav"',
    to:   'id="btnNoSuchFav"',
    expect: '工具条上没有「批量选择」按钮',
  },
  {
    name: '两处下载默认值写歪（并发 2 vs 3）',
    file: 'src/ui/app.js',
    from: '  concurrent: 2,        // 同时下载几首（1~4）',
    to:   '  concurrent: 3,        // 同时下载几首（1~4）',
    expect: '两处下载默认值不一致',
  },
  {
    name: '下载器不再复用 safeCoverName（中文封面名会被校验拒掉）',
    file: 'src/downloader.js',
    from: 'safeCoverName(',
    to:   'localCoverName(',
    expect: '下载器没有调用 safeCoverName',
  },
  {
    name: 'CSP 去掉 local:（本地歌曲封面 / 音频被拦）',
    file: 'src/ui/index.html',
    from: "img-src 'self' bg: local: https:",
    to:   "img-src 'self' bg: https:",
    expect: 'CSP 里没有 local:',
  },
  {
    name: '侧栏底部的「下载管理」按钮被删',
    file: 'src/ui/index.html',
    from: '<button class="ghost-btn" id="btnDownloads" title="下载管理">',
    to:   '<button class="ghost-btn" id="btnDlManager" title="下载管理">',
    expect: '应该是「设置」+「下载管理」两个按钮',
  },

  /* ---- v2.8.0 修订（真机反馈）那五处，各自一条 ---- */
  {
    name: '歌词浮层的「桌面歌词」按钮又变成无条件可点（收起时会盖住工具栏）',
    file: 'src/ui/style.css',
    from: '  background: rgba(255,255,255,0.07);\n  transition: background 0.14s, color 0.14s;\n}',
    to:   '  background: rgba(255,255,255,0.07);\n  transition: background 0.14s, color 0.14s;\n  pointer-events: auto;\n}',
    expect: '又写了无条件的 pointer-events: auto',
  },
  {
    name: '.primary-btn 丢掉 inline-flex（带图标时按钮会变成两行）',
    file: 'src/ui/style.css',
    from: '  display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n}\n.primary-btn .ic',
    to:   '}\n.primary-btn .ic',
    expect: '.primary-btn 没有 display: inline-flex',
  },
  {
    name: '.ghost-btn.on 被删（勾选态只能切 primary-btn，盒子会变）',
    file: 'src/ui/style.css',
    from: '.ghost-btn.on {\n  background: rgb(var(--accent-rgb) / 0.18);',
    to:   '.ghost-btn--on {\n  background: rgb(var(--accent-rgb) / 0.18);',
    expect: '没有 .ghost-btn.on',
  },
  {
    name: '工具条「批量下载」又切回 primary-btn（真机反馈的"变形变高"）',
    file: 'src/ui/app.js',
    from: `class="ghost-btn\${picking ? ' on' : ''}"`,
    to:   'class="primary-btn"',
    expect: '没在用 ghost-btn + on',
  },
  {
    name: '选集面板的勾选工具条被删（又变成点一下直接下全部）',
    file: 'src/ui/app.js',
    from: 'id="btnCollectPickAll"',
    to:   'id="btnCollectPickAllX"',
    expect: '选集勾选工具条缺按钮',
  },
  {
    name: '合集面板的「批量下载」改回直接 enqueueDownloads',
    file: 'src/ui/app.js',
    from: "$('btnDownloadCollect').addEventListener('click', toggleCollectPick);",
    to:   "$('btnDownloadCollect').addEventListener('click', () => { const on = enabledEntries(collectState, collectState.entries); enqueueDownloads(on, { jump: false }); });",
    expect: '没有改成进勾选态',
  },
  {
    name: '下载管理的「全部删除」被删',
    file: 'src/ui/app.js',
    from: 'id="btnDlClearAll"',
    to:   'id="btnDlClearAllX"',
    expect: '下载管理没有「全部删除」',
  },
  {
    name: '删任务不再清本地库那条（绿勾会一直挂着）',
    file: 'src/ui/app.js',
    from: 'function dropLocalEntryOf(t) {',
    to:   'function dropLocalEntryOfXX(t) {',
    expect: 'app.js 没有 dropLocalEntryOf',
  },

  /* ---- v2.8.0 修订二：问题 A（失联文件）与问题 B（断流自愈），各自一条 ---- */
  {
    name: '★ 问题A：体检改回纯字符串（外部删文件后绿勾又是绿的）',
    file: 'src/ui/app.js',
    from: 'async function sweepMissingLocal(force) {',
    to:   'async function sweepMissingLocalX(force) {',
    expect: '没有 sweepMissingLocal',
  },
  {
    name: '★ 问题A：行内按钮判据退回"只看已完成任务"（漏掉任务记录没了的绿勾）',
    file: 'src/ui/app.js',
    from: `      if (act === 'download') {
        const task = taskForTrack(track);
        if (isDownloaded(track)) {`,
    to: `      if (act === 'download') {
        const task = taskForTrack(track);
        if (task && task.status === 'done') {`,
    expect: '判据不是 isDownloaded(track)',
  },
  {
    name: '★ 问题A：清失效任务时不再回查 downloadList（重下被 skipExisting 拦）',
    file: 'src/ui/app.js',
    from: "      const r = await api('downloadList');",
    to:   "      const r = null;",
    expect: '没有回查 downloadList',
  },
  {
    name: '★ 问题A：体检去掉 60 秒节流（每次切视图都摸盘）',
    file: 'src/ui/app.js',
    from: '  if (!force && now - localSweepAt < 60000) return 0;',
    to:   '  if (false && !force && now - localSweepAt < 60000) return 0;',
    expect: '体检没有 60 秒节流',
  },
  {
    name: '★ 问题B：audio 不再监听 stalled（断流没有任何自愈）',
    file: 'src/ui/app.js',
    from: "  audio.addEventListener('stalled', () => { healOnStall(); });",
    to:   "  audio.addEventListener('stalledX', () => { healOnStall(); });",
    expect: '没有监听 stalled',
  },
  {
    name: '★ 问题B：自愈不接回播放位置（变成从头开始播）',
    file: 'src/ui/app.js',
    from: '    try { if (resumeAt > 0.5) audio.currentTime = resumeAt; }',
    to:   '    try { if (false) audio.currentTime = resumeAt; }',
    expect: '没有把播放位置接回去',
  },
  {
    name: '★ 问题B：自愈去掉冷却（弱网下疯狂重试，比原来更卡）',
    file: 'src/ui/app.js',
    from: '  if (now - lastHealAt < HEAL_COOLDOWN) return;',
    to:   '  if (false && now - lastHealAt < HEAL_COOLDOWN) return;',
    expect: '自愈没有冷却',
  },
  {
    // ★ v2.8.2 语义化：闸门放宽成 `audio.paused && !startPending` 之后，
    //   样例的 from 也要跟着换 —— 否则这条样例恒为"找不到"，判别力就白丢了。
    name: '★ 问题B：healOnStall 不再判 audio.paused（暂停时也乱动）',
    file: 'src/ui/app.js',
    from: `  if (audio.paused && !startPending) return;  // 用户自己按了暂停 → 别自作主张`,
    to:   `  if (false) return;                          // 用户自己按了暂停 → 别自作主张`,
    expect: '没判 audio.paused',
  },
  {
    name: '★ 问题B：playAt 不再挂 deadline 定时器（预防式刷新失效）',
    file: 'src/ui/app.js',
    from: '    armDeadlineTimer(info.url, seq);',
    to:   '    armDeadlineTimerX(info.url, seq);',
    expect: '没有挂 deadline 定时器',
  },
  {
    name: '★ 问题B：error 事件改回"只弹提示、什么都不做"',
    file: 'src/ui/app.js',
    from: `    refreshAudioUrl(seq, 'manual', at).then((okNow) => {
      if (!okNow && seq === playSeq) toast('音频加载失败了，可能链接已过期，换一首试试');`,
    to:   `    (async () => {
      if (seq === playSeq) toast('音频加载失败了，可能链接已过期，换一首试试');`,
    expect: '没有试着自愈',
  },

  /* ---- v2.8.0 批次 B：本地歌曲视图与导入，逐条判据 ---- */
  {
    name: '★ 批次B：sameTrack 去掉本地歌分支（本地歌的收藏/历史/高亮全对不上）',
    file: 'src/ui/app.js',
    from: '  if (a.localPath || b.localPath) return !!a.localPath && a.localPath === b.localPath;',
    to:   '  if (false) return !!a.localPath && a.localPath === b.localPath;',
    expect: 'sameTrack 没有本地歌分支',
  },
  {
    name: '★ 批次B：playAt 去掉本地歌分支（点本地歌会去问 B 站要地址）',
    file: 'src/ui/app.js',
    from: '  if (track.localPath) {',
    to:   '  if (false && track.localPath) {',
    expect: 'playAt 没有本地歌分支',
  },
  {
    name: '★ 批次B：本地歌地址不用 encodeURIComponent（带空格/中文的路径会拼坏）',
    file: 'src/ui/app.js',
    from: "      myLocalSrc = 'local://get?p=' + encodeURIComponent(track.localPath);",
    to:   "      myLocalSrc = 'local://get?p=' + track.localPath;",
    expect: '没经过 encodeURIComponent',
  },
  {
    name: '★ 批次B：renderAll 去掉 local 分支（本地页画不出来）',
    file: 'src/ui/app.js',
    from: "  else if (currentView === 'local') renderLocal();   // v2.8.0 批次 B",
    to:   "  else if (false) renderLocal();   // v2.8.0 批次 B",
    expect: 'renderAll 里没有 local 分支',
  },
  {
    name: '★ 批次B：currentTracks 去掉 local 分支（点本地歌行不播它）',
    file: 'src/ui/app.js',
    from: "  if (currentView === 'local') return localFilteredTracks();   // v2.8.0 批次 B / 修订：跟着左栏筛选走",
    to:   "  if (false) return localFilteredTracks();   // v2.8.0 批次 B / 修订：跟着左栏筛选走",
    expect: 'currentTracks 里没有 local 分支',
  },
  {
    name: '★ 批次B：侧栏「本地歌曲」导航项被删（点不到本地库）',
    file: 'src/ui/index.html',
    from: '<div class="nav-item" data-view="local">',
    to:   '<div class="nav-item" data-view="localX">',
    expect: '没有 data-view="local" 导航项',
  },
  {
    name: '★ 批次B：importLocal 改成破坏性（去删用户自己的文件）',
    file: 'src/ui/app.js',
    from: "  DB.local = fresh.concat(DB.local);",
    to:   "  fs.unlinkSync(fresh[0].path);\n  DB.local = fresh.concat(DB.local);",
    expect: 'importLocal 里出现了删/移/复制文件的操作',
  },
  {
    name: '★ 批次B：importLocal 去掉路径去重（重复导入会加两遍）',
    file: 'src/ui/app.js',
    from: '  const have = new Set(DB.local.filter((e) => e && e.path).map((e) => String(e.path)));',
    to:   '  const have = new Set();',
    expect: 'importLocal 没有按路径去重',
  },
  {
    name: '★ 批次B：checkLocalMissing 改成直接删记录（用户换盘符后歌全没了）',
    file: 'src/ui/app.js',
    from: '    if (!!e.missing !== miss) { e.missing = miss; changed = true; }',
    to:   '    DB.local = DB.local.filter((x) => !x.missing);\n    if (!!e.missing !== miss) { e.missing = miss; changed = true; }',
    expect: 'checkLocalMissing 里在删 DB.local',
  },
  {
    name: '★ 批次B：下载管理的「播放」按钮被删（下完的歌不能直接播）',
    file: 'src/ui/app.js',
    from: "    ops = dlOpBtn('play', '播放', 'i-play', t.id)",
    to:   "    ops = dlOpBtn('playX', '播放', 'i-play', t.id)",
    expect: '没有「播放」按钮',
  },
  {
    name: '★ mini 回归：mini 下没把 #btnDownload 收起来（✕▢ 被挤到第二行）',
    file: 'src/ui/style.css',
    from: 'body.mini #btnOpenBili,\nbody.mini #btnDownload,\nbody.mini .vol-pop { display: none; }',
    to:   'body.mini #btnOpenBili,\nbody.mini .vol-pop { display: none; }',
    expect: 'mini 下没有把 #btnDownload 收起来',
  },
  /* ---------- v2.8.0 修订：左栏文件夹列表 + 批量选择 ---------- */
  {
    name: '★ 修订：localGroups 删掉（左栏文件夹列表没数据源）',
    file: 'src/ui/app.js',
    from: 'function localGroups() {',
    to:   'function localGroupsX() {',
    expect: '没有 localGroups()',
  },
  {
    name: '★ 修订：下载落地的歌没归到「本地下载」组',
    file: 'src/ui/app.js',
    from: "    if (e.src === 'download' || e.bvid || e.key) { bump('download', '本地下载', 'download', null, e); continue; }",
    to:   "    if (false) { bump('download', '本地下载', 'download', null, e); continue; }",
    expect: '下载落地',
  },
  {
    name: '★ 修订：currentTracks 的 local 分支退回 localTracks（点行播的和右栏看到的不一致）',
    file: 'src/ui/app.js',
    from: "  if (currentView === 'local') return localFilteredTracks();",
    to:   "  if (currentView === 'local') return localTracks();",
    expect: '没走 localFilteredTracks',
  },
  {
    name: '★ 修订：localToggle 用 bvid 当键（本地歌永远勾不上）',
    file: 'src/ui/app.js',
    from: '  if (localPick.selected.has(t.localPath)) localPick.selected.delete(t.localPath);\n  else localPick.selected.set(t.localPath, t);',
    to:   '  if (localPick.selected.has(t.bvid)) localPick.selected.delete(t.bvid);\n  else localPick.selected.set(t.bvid, t);',
    expect: 'localToggle 的键不是 localPath',
  },
  {
    name: '★ 修订：localTrackOpts 没传 pickKey（本地歌勾选态渲染不出来）',
    file: 'src/ui/app.js',
    from: "  if (localPick) return { pick: true, pickSet: localPick.selected, pickKey: 'localPath' };",
    to:   "  if (localPick) return { pick: true, pickSet: localPick.selected };",
    expect: '没传 pickKey',
  },
  {
    name: '★ 修订：importLocal 从路径反推 folderRoot（多级子目录会分错组）',
    file: 'src/ui/app.js',
    from: '  const root = (kind === \'folder\' && res.root) ? String(res.root) : null;',
    to:   '  const root = (kind === \'folder\') ? String(res.paths[0] || \'\').split(/[\\\\/]/).slice(0, -1).join(\'/\') : null;',
    expect: '没用主进程给的 res.root',
  },
  {
    name: '★ 修订：主进程 local:pickFolder 不返回 root',
    file: 'src/main.js',
    from: '    return Object.assign({ root }, scanAudioFolder(root));',
    to:   '    return scanAudioFolder(root);',
    expect: '没带回 root',
  },
  {
    name: '★ 修订：store-migrate 用 filter 替换 d.local（吞掉坏条目）',
    file: 'src/store-migrate.js',
    from: '  d.local.forEach((e) => {',
    to:   '  d.local = d.local.filter((e) => !!e).forEach((e) => {',
    expect: 'filter 替换 d.local',
  },
  {
    name: '★ 修订：renderAll 没在离开本地页时清 localPick',
    file: 'src/ui/app.js',
    from: "  if (localPick && currentView !== 'local') localPick = null;",
    to:   "  if (false) localPick = null;",
    expect: '没有"离开本地页就退出勾选态"',
  },
  {
    name: '★ 修订：localRemoveFolder 不处理"删掉正在看的分组"',
    file: 'src/ui/app.js',
    from: "  if (localFilter === 'folder:' + r) localFilter = 'all';",
    to:   "  if (false) localFilter = 'all';",
    expect: '没处理',
  },
  {
    name: '★ 修订：左栏行的 ✕ 排在"切分组"之后（点 ✕ 被整行点击吃掉）',
    file: 'src/ui/app.js',
    from: "    const rmFolder = e.target.closest('[data-lrmfolder]');\n    if (rmFolder) { localRemoveFolder(rmFolder.dataset.lrmfolder); return; }\n    const folderRow = e.target.closest('[data-lgroup]');\n    if (folderRow) {",
    to:   "    const folderRow = e.target.closest('[data-lgroup]');\n    if (folderRow) {",
    expect: '✕ 没排在"切分组"之前',
  },
  {
    name: '★ 修订：「批量选择」按钮没绑定',
    file: 'src/ui/app.js',
    from: "    if (id === 'btnLocalPick') { toggleLocalPick(); return; }",
    to:   "    if (id === 'btnLocalPickX') { toggleLocalPick(); return; }",
    expect: '「批量选择」按钮没绑定',
  },
  {
    name: '★ 修订：removeLocalPaths 改成删磁盘文件（违反非破坏性红线）',
    file: 'src/ui/app.js',
    from: '  DB.local = (DB.local || []).filter((e) => !e || !set.has(String(e.path)));\n  const removed = before - DB.local.length;',
    to:   '  try { for (const p of set) fs.unlinkSync(p); } catch (_) {}\n  DB.local = (DB.local || []).filter((e) => !e || !set.has(String(e.path)));\n  const removed = before - DB.local.length;',
    expect: 'removeLocalPaths 里出现了删文件',
  },
  {
    name: '★ 修订：trackRow 不支持 pickKey（默认拿 bvid 查）',
    file: 'src/ui/app.js',
    from: "  const pickKey = opts.pickKey || 'bvid';",
    to:   "  const pickKey = 'bvid';",
    expect: '不支持 opts.pickKey',
  },
  {
    name: '★ 修订：.local-side 样式被删（左栏没样式、挤成一团）',
    file: 'src/ui/style.css',
    from: '.local-side {',
    to:   '.local-sideX {',
    expect: '.local-side',
  },

  /* ===== v2.9.0 新增 4 条 ===== */
  {
    name: 'v2.9.0：mini 的「词」按钮没绑上（点了没反应）',
    file: 'src/ui/app.js',
    from: "$('miniLyric').addEventListener('click', () => toggleDesktopLyric());",
    to:   "$('miniLyric').addEventListener('click', () => {});",
    expect: '#miniLyric 没绑到 toggleDesktopLyric',
  },
  {
    name: 'v2.9.0：常显规则被改成 opacity:0（设置里选了也没效果）',
    file: 'src/ui/style.css',
    from: 'body.ops-always .track .ops { opacity: var(--ops-alpha, 0.55); }',
    to:   'body.ops-always .track .ops { opacity: 0; }',
    expect: '没有 body.ops-always 那条规则',
  },
  {
    name: 'v2.9.0：askImportTarget 用 showPrompt（等待者被清空，导入静默卡住）',
    file: 'src/ui/app.js',
    from: '      promptResolve = resolve;          // 每换一屏都重新挂一次',
    to:   '      promptResolve = null;            // 每换一屏都重新挂一次',
    expect: '没自己挂 promptResolve',
  },
  {
    name: 'v2.9.0：加入现有歌单不判重（同一首歌被塞两遍）',
    file: 'src/ui/app.js',
    from: '      if (!pl.tracks.some((x) => sameTrack(x, t))) { pl.tracks.push(t); added += 1; }',
    to:   '      if (true) { pl.tracks.push(t); added += 1; }',
    expect: '没按 sameTrack 判重',
  },
  {
    name: 'v2.9.0 修订：.ops 不再钉死在最后一列（带徽章的行按钮会右移）',
    file: 'src/ui/style.css',
    from: '.track:not(.pickable) .ops        { grid-column: -2 / -1; }',
    to:   '.track:not(.pickable) .ops        { grid-column: auto; }',
    expect: '没有把 .ops 钉在第 6 列',
  },
  {
    name: 'v2.9.0 修订：mini 的「词」退回图标（和播放队列 ☰ 认不出来）',
    file: 'src/ui/index.html',
    from: '<button class="win-btn ml-word" id="miniLyric" title="桌面歌词" aria-label="桌面歌词"><span>词</span></button>',
    to:   '<button class="win-btn ml-word" id="miniLyric" title="桌面歌词" aria-label="桌面歌词"><svg class="ic"><use href="#i-lyric"/></svg></button>',
    expect: '不是纯汉字',
  },

  /* ===== v2.9.0 追加：「批量下载」→「批量选择」 ===== */
  {
    name: '★ 批量选择：我喜欢页也画了「喜欢」（那一页全已喜欢，死按钮）',
    file: 'src/ui/app.js',
    from: "  if (currentView !== 'favorites') {\n    acts.push({ id: 'btnSelFav'",
    to:   "  if (currentView !== 'nosuchview') {\n    acts.push({ id: 'btnSelFav'",
    expect: '「我喜欢」页里也画了「喜欢」按钮',
  },
  {
    name: '★ 批量选择：本地那条选择条不再共用 pickBarHTML',
    file: 'src/ui/app.js',
    from: '  return pickBarHTML(n, [\n    { id: \'btnLocalFav\'',
    to:   '  const _s = pickBarHTML(n, [\n    { id: \'btnLocalFav\'',
    expect: '本地歌曲那条选择条没走 pickBarHTML',
  },
  {
    name: '★ 批量选择：selKey 的本地歌分支打错字（歌单里的本地歌勾不上）',
    file: 'src/ui/app.js',
    from: "  if (t.localPath) return 'l:' + t.localPath;",
    to:   "  if (t.localPath) return 'l:' + t.localPathx;",
    expect: '没有 selKey()',
  },
  {
    name: '★ 批量选择：批量下载没筛掉本地歌（本地文件送进下载队列）',
    file: 'src/ui/app.js',
    from: '  const dlAble = list.filter((t) => t && t.bvid);',
    to:   '  const dlAble = list.slice();',
    expect: '批量下载没筛掉本地歌',
  },
  {
    name: '★ 批量选择：批量移出弹了确认框（和行内垃圾桶口径不一致）',
    file: 'src/ui/app.js',
    from: "  const inFav = currentView === 'favorites';",
    to:   "  const inFav = currentView === 'favorites';\n  await askConfirm('x', 'y');",
    expect: '批量移出弹了确认框',
  },
  {
    name: '★ 批量选择：换页不退出选择模式（跑到「发现」每行都带勾选框）',
    file: 'src/ui/app.js',
    from: '  if (selPick && selPick.view !== currentView) selPick = null;',
    to:   '  if (false) selPick = null;',
    expect: '换页不会退出选择模式',
  },
  {
    name: '★ 批量选择：动作按钮不换行（窄窗口下最右边那颗被裁掉）',
    file: 'src/ui/style.css',
    from: '.imp-bar-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 8px; }',
    to:   '.imp-bar-actions { display: inline-flex; align-items: center; gap: 8px; row-gap: 8px; }',
    expect: '.imp-bar-actions 没有 flex-wrap',
  },
  {
    name: '★ 批量选择：把「移出」挪到最前面（破坏性操作不该夹在中间）',
    file: 'src/ui/app.js',
    from: "  acts.push({\n    id: 'btnSelRemove',\n    icon: 'i-trash',\n    label: currentView === 'favorites' ? '取消喜欢' : '移出歌单',\n    danger: true,\n  });",
    to:   "  acts.unshift({\n    id: 'btnSelRemove',\n    icon: 'i-trash',\n    label: currentView === 'favorites' ? '取消喜欢' : '移出歌单',\n    danger: true,\n  });",
    expect: '不是最后 push 进去的按钮',
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const p = path.join(ROOT, c.file);
  const orig = fs.readFileSync(p, 'utf8');
  if (!orig.includes(c.from)) {
    console.log(`  ? 跳过（原文没找到）：${c.name}`);
    fail++;
    continue;
  }
  fs.writeFileSync(p, orig.split(c.from).join(c.to), 'utf8');
  let out = '';
  try {
    out = execFileSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
  } finally {
    fs.writeFileSync(p, orig, 'utf8');
  }
  const hit = out.includes(c.expect);
  if (hit) { console.log(`  ✓ 会响：${c.name}`); pass++; }
  else { console.log(`  ✗ 没响：${c.name}（期望看到「${c.expect}」）`); fail++; }
}

/* 还原之后必须回到全绿，确认这些脚本没把项目改坏 */
let finalOut = '';
try {
  finalOut = execFileSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { finalOut = String((e.stdout || '') + (e.stderr || '')); }
const restored = /全部静态自检通过/.test(finalOut);
console.log(`\n判别力：${pass}/${CASES.length} 条会响；还原后全绿：${restored ? '是' : '否'}`);
if (!restored) console.log(finalOut.split('\n').filter((l) => /✗|❌/.test(l)).join('\n'));
process.exit(pass === CASES.length && restored ? 0 : 1);
