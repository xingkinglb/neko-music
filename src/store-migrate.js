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

const DEFAULT_DATA = {
  playlists: [],  // 歌单列表，每个歌单里有 tracks
  favorites: [],  // 我喜欢的
  history: [],    // 最近播放
  lastTrack: null,// 上次听到的歌（下次打开可以接着播）
  settings: {     // 外观与习惯
    theme: 'pink',   // pink / violet / green / amber / cyan
    volume: 80,      // 音量记忆，0-100
    bg:    { file: null, dim: 0.55, blur: 0 },  // 背景图文件名 / 压暗程度 / 额外模糊
    glass: { blur: 18, alpha: 0.55 },           // 毛玻璃：模糊半径 / 不透明度
    autoLyric: false,   // 自动加载歌词（默认关，可手动点「词」）
    close: { action: 'ask' },   // 关窗行为（v2.2.0）
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

  // 背景图如果已经不在硬盘上（比如换过电脑、清过缓存），就悄悄置空，别留个裂图
  if (s.bg.file && bgDir) {
    const ok = /^[\w.\-]+$/.test(s.bg.file) && fs.existsSync(path.join(bgDir, s.bg.file));
    if (!ok) s.bg.file = null;
  }

  d.settings = s;
  return d;
}

module.exports = { DEFAULT_DATA, THEMES, migrate };
