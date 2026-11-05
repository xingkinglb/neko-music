/* ============================================================
   听歌统计的落盘 / 读取（v2.13.0）
   ============================================================
   单独一个文件、单独一份 stats.json —— 理由和 `queue-store.js` 完全一样：
   主存档 `neko-data.json` 的 persist() 是**全量重写**，而统计每听一首就要改一次。
   混进去等于"每听一首重写几百 KB"，把本来已经瘦下来的存档又拖肿。
   而且统计丢了不影响听歌，主存档丢了影响一切 —— 两件事本来就不该放一起。

   ★ 为什么每次 record 都在内存里改、然后防抖写盘
     真实听歌时 record 的触发频率是"每首歌一次"（不是每秒一次），
     但连点下一首会连着触发好几条。攒 2 秒写一次，够用且不磨硬盘。

   ★ 数据结构
     days   { 'YYYY-MM-DD': { sec, plays } }        —— 按天汇总，画柱状图用
     tracks { 'key': { title, author, cover, ... } } —— 按曲汇总，出"最爱的歌"
     ups    { 'mid': { name, plays, sec } }         —— 按 UP 汇总，出"最爱的 UP"

     tracks 里存了 title/author/cover 的副本，不是冗余 ——
     播放历史只有 100 条，几个月后就翻不到那首歌了，
     但统计页要能一直显示「最爱的歌」是哪首。所以这几项必须自带。
   ============================================================ */
const fs = require('fs');

/** 保留多少天的按天数据（两年，够看年度对比了） */
const KEEP_DAYS = 730;
/** 最多记多少首歌的明细（LRU，超出丢最久没听的） */
const KEEP_TRACKS = 2000;
/** 最多记多少个 UP */
const KEEP_UPS = 300;

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/** 本地时区的 YYYY-MM-DD。★ 不能用 toISOString() —— 那按 UTC 算，
 *  在东八区会把「晚上 11 点听的歌」算到第二天去。 */
function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function empty() {
  return { v: 1, days: {}, tracks: {}, ups: {} };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 读统计。
 * ★ 读不出来 / 形状不对 → 返回空骨架，绝不抛。
 *   统计是"锦上添花"的数据，为它挡住启动不值得。
 *   （和主存档不同：主存档坏了必须让用户知道，统计坏了悄悄重来就行。）
 */
function load(file) {
  try {
    if (!fs.existsSync(file)) return empty();
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = empty();
    if (d && typeof d.days === 'object' && d.days) {
      for (const [k, v] of Object.entries(d.days)) {
        // 只认 YYYY-MM-DD 这种 key：手改坏的、或以后换了格式的，一律丢掉
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        out.days[k] = { sec: num(v.sec), plays: num(v.plays) };
      }
    }
    if (d && typeof d.tracks === 'object' && d.tracks) {
      for (const [k, v] of Object.entries(d.tracks)) {
        if (!v || typeof v !== 'object') continue;
        out.tracks[k] = {
          title: String(v.title || ''),
          author: String(v.author || ''),
          cover: String(v.cover || ''),
          bvid: String(v.bvid || ''),
          // v2.13.1：本地歌（key 以 'l:' 开头）没有 bvid，靠这一项才能还原成可播的 track
          localPath: String(v.localPath || ''),
          mid: num(v.mid),
          plays: num(v.plays),
          sec: num(v.sec),
          last: num(v.last),
        };
      }
    }
    if (d && typeof d.ups === 'object' && d.ups) {
      for (const [k, v] of Object.entries(d.ups)) {
        if (!v || typeof v !== 'object') continue;
        out.ups[k] = { name: String(v.name || ''), plays: num(v.plays), sec: num(v.sec) };
      }
    }
    return out;
  } catch (err) {
    console.error('[stats-store] 读不出来，从空统计重来：', err.message);
    return empty();
  }
}

/** 原子写：先写 .tmp 再 rename（理由同 queue-store） */
function save(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      v: 1,
      days: (data && data.days) || {},
      tracks: (data && data.tracks) || {},
      ups: (data && data.ups) || {},
    }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[stats-store] 写失败：', err.message);
    return false;
  }
}

/**
 * 记一笔。**就地修改** data 并返回它（调用方持有内存副本，不用反复读盘）。
 *
 * @param {object} data 统计对象（load 出来的）
 * @param {object} entry { key, bvid, cid, title, author, mid, cover, sec }
 * @param {'play'|'listen'} kind
 *        'play'   = 达到「真听过」阈值，播放次数 +1（同时也会计入 sec）
 *        'listen' = 只是在听，只累计秒数（不算一次播放）
 */
function record(data, entry, kind) {
  if (!data || !entry) return data;
  const sec = Math.round(num(entry.sec));
  const counted = kind === 'play';
  // 一次都没听够、秒数也是 0 → 没有任何可记的
  if (!counted && sec <= 0) return data;

  const today = dayKey(new Date());

  const day = data.days[today] || (data.days[today] = { sec: 0, plays: 0 });
  day.sec += sec;
  if (counted) day.plays += 1;

  const key = String(entry.key || '');
  if (key) {
    const t = data.tracks[key] || (data.tracks[key] = {
      title: '', author: '', cover: '', bvid: '', localPath: '', mid: 0, plays: 0, sec: 0, last: 0,
    });
    // 元数据随时补：搜索来的歌第一次没封面，播到一半 backfillCover 才补上
    if (entry.title)  t.title  = String(entry.title);
    if (entry.author) t.author = String(entry.author);
    if (entry.cover)  t.cover  = String(entry.cover);
    if (entry.bvid)   t.bvid   = String(entry.bvid);
    if (entry.localPath) t.localPath = String(entry.localPath);
    if (num(entry.mid)) t.mid  = num(entry.mid);
    t.sec += sec;
    if (counted) t.plays += 1;
    t.last = Date.now();
  }

  // UP 主统计：本地歌没有 mid，跳过
  const mid = String(entry.mid || '');
  if (mid && mid !== '0') {
    const u = data.ups[mid] || (data.ups[mid] = { name: '', plays: 0, sec: 0 });
    if (entry.author) u.name = String(entry.author);
    u.sec += sec;
    if (counted) u.plays += 1;
  }

  prune(data);
  return data;
}

/** 超量才剪枝（每次 record 都全量排序太浪费，所以带余量触发） */
function prune(data) {
  const dk = Object.keys(data.days);
  if (dk.length > KEEP_DAYS + 10) {
    dk.sort();   // 'YYYY-MM-DD' 的字典序就是日期序
    for (const k of dk.slice(0, dk.length - KEEP_DAYS)) delete data.days[k];
  }
  const tk = Object.keys(data.tracks);
  if (tk.length > KEEP_TRACKS + 200) {
    tk.sort((a, b) => (data.tracks[b].last || 0) - (data.tracks[a].last || 0));
    for (const k of tk.slice(KEEP_TRACKS)) delete data.tracks[k];
  }
  const uk = Object.keys(data.ups);
  if (uk.length > KEEP_UPS + 20) {
    uk.sort((a, b) => (data.ups[b].sec || 0) - (data.ups[a].sec || 0));
    for (const k of uk.slice(KEEP_UPS)) delete data.ups[k];
  }
}

module.exports = { load, save, record, empty, dayKey, KEEP_DAYS, KEEP_TRACKS, KEEP_UPS };
