/* 合集缓存的落盘 / 读取（v2.13.0）
   ============================================================
   `collectParts`（合集曲目表）和 `collectCovers`（合集封面）从主存档拆出来，
   单独存 `cache-collect.json`。为什么：

     主存档 7.49 MB 里这两项占 4.18 MB + 6.6 KB —— 它们本质是**可以重新拉的
     临时缓存**（删了下次播放合集时再拉一遍就行），却混在需要长期保存的
     用户数据（歌单 / 收藏 / 设置）里，每次 persist（改个音量也触发）都跟着
     全量重写一遍。拆出去之后主存档瘦到几百 KB，缓存爱怎么写怎么写。

   结构和 queue-store.js 一样：先写 .tmp 再 rename（原子），坏数据一律当没有。
   ★ 和队列不同的点：缓存**丢了不心疼**（可重建），所以这里不做迁移兜底、
   不做 index 自愈那套 —— load 形状不对就返回空，大不了下次重新拉。
   ============================================================ */
const fs = require('fs');

/** 读缓存。读不出来 / 形状不对 → null（调用方会回退用主存档里的旧数据做迁移）。 */
function load(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    return {
      collectParts: (d.collectParts && typeof d.collectParts === 'object') ? d.collectParts : {},
      collectCovers: (d.collectCovers && typeof d.collectCovers === 'object') ? d.collectCovers : {},
    };
  } catch (err) {
    console.error('[cache-collect] 读不出来，当空缓存：', err.message);
    return null;
  }
}

/** 写缓存（原子写）。永远返回 true/false，调用方不依赖它成功 —— 缓存写失败下次重建。 */
function save(file, data) {
  try {
    const out = {
      collectParts: (data && data.collectParts && typeof data.collectParts === 'object') ? data.collectParts : {},
      collectCovers: (data && data.collectCovers && typeof data.collectCovers === 'object') ? data.collectCovers : {},
      at: Date.now(),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[cache-collect] 写失败（缓存可重建，不影响正确性）：', err.message);
    return false;
  }
}

module.exports = { load, save };
