/* 自检：合集缓存的落盘 / 读取（src/cache-collect.js）。
   跑：node .verify/check-cache-collect.js     有问题退出码 1

   ★ 这块纯 Node 能测（cache-collect.js 不依赖 Electron），毫秒级跑完。
   ★ 它存的是**可重建的缓存**（删了下次播放合集再拉），所以容错策略和
     queue-store 不同：不做 index 自愈那套，形状不对就返回空 ——
     空的代价只是"下次播放合集重新拉一遍"，不丢任何用户数据。
     测试重点因此是：原子写 + 坏数据不炸，而不是数据自愈。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'src', 'cache-collect.js'));

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-cache-'));
const file = path.join(dir, 'cache-collect.json');
const PARTS = { BVaaa: [{ bvid: 'BVaaa', cid: 1, title: 'P1' }, { bvid: 'BVaaa', cid: 2, title: 'P2' }] };
const COVERS = { BVaaa: 'https://i0.hdslb.com/x.jpg' };

console.log('\n[1] 写进去再读出来：');
{
  store.save(file, { collectParts: PARTS, collectCovers: COVERS });
  const back = store.load(file);
  if (!back) err('存进去却读不出来');
  else if (back.collectParts.BVaaa.length !== 2) err('collectParts 内容不对');
  else if (back.collectCovers.BVaaa !== COVERS.BVaaa) err('collectCovers 内容不对');
  else ok('曲目表 + 封面表原样回来了');
}

console.log('\n[2] 原子写，无残渣：');
{
  if (fs.existsSync(file + '.tmp')) err('留下 .tmp 残留');
  else ok('没有 .tmp 残留');
  store.save(file, { collectParts: PARTS, collectCovers: {} });
  const back = store.load(file);
  if (!back || Object.keys(back.collectCovers).length) err('覆盖写没有生效');
  else ok('连续写入读到的是最后一次');
}

console.log('\n[3] 坏数据一律当空缓存：');
{
  fs.writeFileSync(file, '{ 不是 JSON', 'utf8');
  if (store.load(file) !== null) err('坏 JSON 被吃进去了');
  else ok('坏 JSON → null');
  fs.writeFileSync(file, '"一个字符串"', 'utf8');
  if (store.load(file) !== null) err('非对象被吃进去了');
  else ok('非对象 → null');
}

console.log('\n[4] 字段缺失自动补空对象（调用方不用判空）：');
{
  fs.writeFileSync(file, '{"collectParts":{"BVx":[{"bvid":"BVx","cid":1}]}}', 'utf8');
  const back = store.load(file);
  if (!back || !back.collectParts.BVx || typeof back.collectCovers !== 'object') err('缺的字段没补');
  else ok('只有 collectParts 也能读，collectCovers 自动补 {}');
  store.save(file, null);   // 界面传了个空值也不该炸
  const back2 = store.load(file);
  if (!back2 || Object.keys(back2.collectParts).length) err('save(null) 后读到旧数据或炸了');
  else ok('save(null) → 空缓存照常落盘');
}

console.log('\n[5] 文件不存在时安静返回：');
{
  if (store.load(path.join(dir, 'nope.json')) !== null) err('文件不存在却返回了东西');
  else ok('文件不存在 → null（不报错、不抛异常）');
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 在系统临时目录里 */ }

console.log(fail ? `\n合集缓存自检未通过 ❌（${fail} 处）\n` : '\n合集缓存自检全部通过 ✅\n');
process.exit(fail ? 1 : 0);
