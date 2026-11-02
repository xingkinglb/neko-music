/* 自检：播放队列的落盘 / 读取（src/queue-store.js）。
   跑：node .verify/check-queue-store.js        有问题退出码 1

   ★ 为什么这块能纯 Node 测
     读写逻辑抽在 src/queue-store.js 里，只碰文件系统，不依赖 Electron。
     所以不用起离屏窗口（那要 10 秒），这里毫秒级跑完，CI 里很划算。

   ★ 重点测什么
     队列是要"跨重启"活下来的东西，最怕的不是写不进去，而是**写坏了**：
     半个 JSON、index 越界、形状不对 —— 这些一旦被当正常数据吃进去，
     用户下次打开就是"队列乱了"或"直接空掉"，而且看起来像随机故障。
     所以这里的用例大部分是"喂脏数据，看它会不会老实当没有"。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'src', 'queue-store.js'));

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-q-'));
const file = path.join(dir, 'queue.json');
const T = (i) => ({ bvid: 'BV' + i, cid: i, title: '歌' + i, author: 'UP' + i, duration: 200 });

console.log('\n[1] 写进去再读出来：');
{
  const tracks = Array.from({ length: 50 }, (_, i) => T(i));
  store.save(file, { tracks, index: 7, name: '我喜欢的音乐' });
  const back = store.load(file);
  if (!back) err('存进去却读不出来');
  else if (back.tracks.length !== 50) err(`曲目数不对：${back.tracks.length}`);
  else if (back.index !== 7) err(`index 不对：${back.index}`);
  else if (back.name !== '我喜欢的音乐') err(`队列名不对：${back.name}`);
  else if (back.tracks[7].title !== '歌7') err('第 7 首的内容不对');
  else ok('50 首 + index=7 + 队列名，原样回来了');
}

console.log('\n[2] 写得原子，不留残渣：');
{
  if (fs.existsSync(file + '.tmp')) err('留下了 .tmp 残留（rename 没成功？）');
  else ok('没有 .tmp 残留');
  // 连写 5 次，最后读到的必须是最后一次
  for (let k = 0; k < 5; k++) store.save(file, { tracks: [T(k)], index: 0, name: 'n' + k });
  const back = store.load(file);
  if (!back || back.name !== 'n4') err(`连写之后读到的是旧内容：${back && back.name}`);
  else ok('连续写入 5 次，读到的是最后一次');
}

console.log('\n[3] 空队列 = 删文件：');
{
  store.save(file, { tracks: [], index: -1, name: '' });
  if (fs.existsSync(file)) err('空队列时没有删掉文件（留了个空壳）');
  else if (store.load(file) !== null) err('文件没了但 load 没返回 null');
  else ok('存空队列会把文件删掉，load 返回 null');
}

console.log('\n[4] 脏数据一律当"没有队列"：');
{
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  if (store.load(file) !== null) err('坏 JSON 被当成有效队列了');
  else ok('坏 JSON → null');

  fs.writeFileSync(file, '{"tracks":"不是数组","index":0}', 'utf8');
  if (store.load(file) !== null) err('tracks 不是数组也被吃进去了');
  else ok('tracks 不是数组 → null');

  fs.writeFileSync(file, '{"tracks":[],"index":0}', 'utf8');
  if (store.load(file) !== null) err('空 tracks 被当成有效队列了');
  else ok('空 tracks → null');
}

console.log('\n[5] index 越界要能自己修：');
{
  store.save(file, { tracks: [T(0), T(1)], index: 0, name: 'x' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.index = 999;               // 手改坏 / 老版本写坏
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const back = store.load(file);
  if (!back) err('index 越界导致整个队列被丢掉（应该修成 0 而不是丢弃）');
  else if (back.index !== 0) err(`index 越界没有归零，而是 ${back.index}`);
  else ok('index 越界 → 自动归 0，队列本身保住');

  raw.index = -5;
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const back2 = store.load(file);
  if (!back2 || back2.index !== 0) err(`index 负数没有归零：${back2 && back2.index}`);
  else ok('index 负数 → 归 0');

  // 存的时候越界也要兜住（界面理论上不会传，但别赌）
  store.save(file, { tracks: [T(0), T(1)], index: 77, name: 'x' });
  const back3 = store.load(file);
  if (!back3 || back3.index !== 0) err(`存入时 index 越界没有兜住：${back3 && back3.index}`);
  else ok('存入时 index 越界 → 落盘前就归 0');
}

console.log('\n[6] 文件不存在时安静返回：');
{
  const gone = path.join(dir, 'nope.json');
  if (store.load(gone) !== null) err('文件不存在却返回了东西');
  else ok('文件不存在 → null（不报错、不抛异常）');
}

/* 收尾：把临时目录删干净 */
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch { /* 删不掉就算了，在系统临时目录里 */ }

console.log(fail ? `\n队列存储自检未通过 ❌（${fail} 处）\n` : '\n队列存储自检全部通过 ✅\n');
process.exit(fail ? 1 : 0);
