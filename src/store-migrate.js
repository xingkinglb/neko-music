/**
 * ============================================================
 *  store-migrate.js —— 读存档时的"补洞"
 * ============================================================
 *  为什么单独一个文件：
 *    这段逻辑**踩过一次真坑** —— 它原来是"白名单重建"（只列出当时认识的
 *    theme / volume / bg / glass / autoLyric 五个字段，其余一律丢掉）。
 *    结果是：**每加一个新设置项，都会被这里悄悄吃掉**。
 *    `lyricWin`（桌面歌词的位置 / 字号）、`playMode`（播放模式）、
 *    `window`（mini 模式 + 窗口位置尺寸）全都**存得进去、读不出来** ——
 *    每次启动都被抹回默认值。
 *
 *    抽出来是为了让离线实测能直接 require 它、**真的喂一份存档进去**，
 *    逐项断言"新字段有没有活下来"（见 .verify/test-round11.js 第 0 组）。
 *    理由同 win-mini.js / bg-protocol.js：main.js 没法被测试 require。
 *
 *  ★ 铁律：这个函数**只许补、不许删**。
 *    不认识的字段原样留着 —— 界面那边可能正在用。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const THEMES = ['pink', 'violet', 'green', 'amber', 'cyan'];

// 下载相关的默认值（v2.8.0）。抽成常量，migrate 和界面两边都从这儿取，避免写两遍写歪。
const DEFAULT_DOWNLOAD = {
  dir: null,            // 下载目录的绝对路径。null = 从没选过 → 首次下载时弹窗让选
  concurrent: 2,        // 同时下载几个。B 站会对短时间大量请求限流，默认别开太大
  saveCover: true,      // 下载时顺手把封面存到本地（这样离线也能看到封面）
  autoAddToLocal: true, // 下完自动进「本地歌曲」
  skipExisting: true,   // 已经在本地库里的跳过，不重复下
};

const DEFAULT_DATA = {
  playlists: [],  // 歌单列表，每个歌单里有 tracks
  favorites: [],  // 我喜欢的
  history: [],    // 最近播放
  lastTrack: null,// 上次听到的歌（下次打开可以接着播）
  local: [],      // v2.8.0：本地歌曲库（下载来的 + 从硬盘导入的）
  settings: {     // 外观与习惯
    theme: 'pink',   // pink / violet / green / amber / cyan
    volume: 80,      // 音量记忆，0-100
    bg:    { file: null, dim: 0.55, blur: 0 },  // 背景图文件名 / 压暗程度 / 额外模糊
    glass: { blur: 18, alpha: 0.55 },           // 毛玻璃：模糊半径 / 不透明度
    autoLyric: false,   // 自动加载歌词（默认关，可手动点「词」）
    close: { action: 'ask' },   // 关窗行为（v2.2.0）
    download: Object.assign({}, DEFAULT_DOWNLOAD),   // v2.8.0：下载设置
  },
};

/**
 * 把存档洗成"结构完整"的样子。
 * 老版本的存档里没有 settings 字段，直接读进来会让界面取到 undefined；
 * 这个函数保证不管多老的存档，读出来都是结构完整的 —— **老数据一条都不会丢**。
 *
 * @param {any} data 从硬盘读出来的原始对象（可能是 null / 坏掉的 JSON）
 * @param {{bgDir?:string}} [opts] bgDir = 背景图目录（用来确认那张图还在不在）
 */
function migrate(data, opts) {
  const bgDir = (opts && opts.bgDir) || null;
  const d = (data && typeof data === 'object') ? data : {};

  d.playlists = Array.isArray(d.playlists) ? d.playlists : [];
  d.favorites = Array.isArray(d.favorites) ? d.favorites : [];
  d.history   = Array.isArray(d.history)   ? d.history   : [];
  d.lastTrack = d.lastTrack || null;
  // v2.8.0：本地歌曲库。同样是"不是数组就当空数组"，老存档没有这一项。
  // ★ 注意**没有** downloads —— 下载任务的状态由主进程单独存一个 downloads.json。
  //   为什么不放这儿：这个文件已经 6MB 了，而下载进度每 300ms 就变一次，
  //   放进来等于每次进度更新都重写 6MB 的 JSON。任务状态和"用户数据"是两种东西。
  d.local     = Array.isArray(d.local)     ? d.local     : [];

  // v2.8.0 修订（左栏文件夹分组）：给每条本地库条目补齐 `folderRoot`（导入文件夹时选的根目录）。
  // ★ 这是**数据条目内部字段的兜底**，不是删数据 —— 铁律"只许补、不许删"针对的是**结构字段**，
  //   这里正好相反：老条目的 folderRoot 缺失 → 补成 null（渲染时按"没有分组信息"处理），
  //   而 src 字段也一并按老数据兜底（老条目都有 src，这里只防手改存档/半途写入）。
  //   补齐之后「本地歌曲」左栏才能稳定地把曲目分到「本地下载 / 各导入文件夹」下面。
  // ★ 用 forEach **原地补字段**、不过滤、不丢条目 —— 哪怕某条是坏对象，也留着让界面自己判，
  //   绝不在这里悄悄吞掉用户的一条记录。
  d.local.forEach((e) => {
    if (!e || typeof e !== 'object') return;
    if (typeof e.folderRoot !== 'string') e.folderRoot = null;   // 没记录分组 = null，渲染时归"其他"
    if (typeof e.src !== 'string' || !e.src) e.src = 'file';     // 认不出来的来源一律当"导入的单曲"
  });

  const old = (d.settings && typeof d.settings === 'object') ? d.settings : {};

  // ★★ 从这里开始是修 bug 的地方：**从存档里已有的出发**，只覆盖我们认识的字段。
  //    以前写的是 `const s = { theme: ..., volume: ..., ... }` —— 那是"白名单重建"，
  //    没列进去的字段（lyricWin / playMode / window / 以后新增的任何一项）全被丢掉。
  const s = Object.assign({}, old);

  s.theme  = THEMES.includes(old.theme) ? old.theme : 'pink';
  s.volume = (typeof old.volume === 'number' && old.volume >= 0 && old.volume <= 100) ? old.volume : 80;
  s.bg     = Object.assign({ file: null, dim: 0.55, blur: 0 }, old.bg || {});
  s.glass  = Object.assign({ blur: 18, alpha: 0.55 }, old.glass || {});
  s.autoLyric = typeof old.autoLyric === 'boolean' ? old.autoLyric : false;

  // v2.2.0：关窗行为。这里只兜一个默认值，真正的合法性由界面那边的 migrateSettings 管。
  s.close = Object.assign({ action: 'ask' },
    (old.close && typeof old.close === 'object') ? old.close : {});

  // v2.8.0：下载设置。★ 写法必须跟上面一样 —— 从 `old.download` 出发只覆盖认识的字段，
  //   不能 `s.download = { dir: ..., concurrent: ... }` 那样白名单重建（会被铁律罚）。
  s.download = Object.assign({}, DEFAULT_DOWNLOAD,
    (old.download && typeof old.download === 'object') ? old.download : {});

  // 并发数夹到 1~4：存档可能被手改过，也可能是老版本写的怪值。
  // 小于 1 会让队列永远卡住（pump 一个都起不来），所以这一条是**功能性**的，不只是好看。
  const cc = Number(s.download.concurrent);
  s.download.concurrent = Number.isFinite(cc) ? Math.min(4, Math.max(1, Math.round(cc))) : DEFAULT_DOWNLOAD.concurrent;

  // 三个开关强制成布尔：界面拿它们做 if 判断，拿到 undefined 会走成"关"，
  // 但用户其实没关过 —— 显式归一化，默认值一律是 true。
  s.download.saveCover      = s.download.saveCover      !== false;
  s.download.autoAddToLocal  = s.download.autoAddToLocal  !== false;
  s.download.skipExisting    = s.download.skipExisting    !== false;

  // 下载目录如果已经不在了（换电脑 / 手动删了 / 移动硬盘没插），就降级成 null，
  // 让它回到"首次下载时弹窗选目录"那条路。否则下载会一直失败在"目录不存在"，
  // 而用户根本不知道该去哪儿改 —— 设置里显示的还是那个已经不存在的路径。
  if (s.download.dir) {
    const dir = String(s.download.dir);
    let alive = false;
    try { alive = fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch (_) { alive = false; }
    if (!alive) s.download.dir = null;
  }

  // 背景图如果已经不在硬盘上（比如换过电脑、清过缓存），就悄悄置空，别留个裂图
  if (s.bg.file && bgDir) {
    const ok = /^[\w.\-]+$/.test(s.bg.file) && fs.existsSync(path.join(bgDir, s.bg.file));
    if (!ok) s.bg.file = null;
  }

  d.settings = s;
  return d;
}

module.exports = { DEFAULT_DATA, DEFAULT_DOWNLOAD, THEMES, migrate };
