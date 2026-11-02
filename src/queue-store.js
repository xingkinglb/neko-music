/* 播放队列的落盘 / 读取（v2.12.4）
   ============================================================
   单独抽出来的理由：`main.js` 没法在离线测试里 require（它一被引入就要开窗口、
   注册协议）。而这个模块只碰文件系统，纯 Node 就能测 ——
   和 `win-mini.js` / `app-menus.js` / `store-migrate.js` 一个路子。

   ★ 为什么队列单独存一个文件，不并进 neko-data.json
     主存档已经 7.49 MB（光 collectParts 一个就 4.18 MB），而 persist() 是**全量重写**。
     队列上千首、每切一首 index 就变一次 —— 混进去等于"每切一首写 7.5 MB"。

   ★ 为什么写的时候先写 .tmp 再 rename
     rename 在同一分区上是**原子**的。直接写目标文件的话，写到一半断电 / 崩溃
     会留下半个 JSON，下次启动读到它就等于连上次的队列一起毁了。
     （这个坑不夸张：用户在后台放歌时关机的概率不低。）
   ============================================================ */
const fs = require('fs');

/** 读队列。读不出来 / 形状不对 / 空队列，一律返回 null（当没有队列）。 */
function load(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 形状不对就当没有 —— 老版本写的、或者被手改坏了，绝不能把脏数据塞给界面
    if (!d || !Array.isArray(d.tracks) || !d.tracks.length) return null;
    const ok = Number.isInteger(d.index) && d.index >= 0 && d.index < d.tracks.length;
    return {
      tracks: d.tracks,
      index: ok ? d.index : 0,
      name: String(d.name || ''),
    };
  } catch (err) {
    console.error('[queue-store] 读不出来，当没有队列：', err.message);
    return null;
  }
}

/** 写队列。空队列 = 删除文件（"没有队列"和"空队列"是一回事，不用留个空壳）。 */
function save(file, data) {
  try {
    const tracks = Array.isArray(data && data.tracks) ? data.tracks : [];
    if (!tracks.length) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    }
    const ok = Number.isInteger(data.index) && data.index >= 0 && data.index < tracks.length;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      tracks,
      index: ok ? data.index : 0,
      name: String(data.name || ''),
      at: Date.now(),
    }), 'utf8');
    fs.renameSync(tmp, file);   // ← 原子替换，见文件头那段
    return true;
  } catch (err) {
    console.error('[queue-store] 写失败：', err.message);
    return false;
  }
}

module.exports = { load, save };
