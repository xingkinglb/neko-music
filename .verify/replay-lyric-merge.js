// 验证已实现的 mergeShatteredLines 在真实字幕上零误伤；不输出 Cookie
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
// 用户数据目录（不写死本机用户名）：%APPDATA%\neko-music
const NEKO_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'neko-music');
const OUT = path.join(__dirname, 'replay-lyric-merge-report.txt');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');
const bili = require(path.join(__dirname, '..', 'src', 'bilibili.js'));
bili.setUserCookie(fs.readFileSync(path.join(NEKO_DIR, 'cookie.txt'), 'utf8').trim());

const realRequest = https.request;
let bodies = [];
https.request = function (opts, cb) {
  return realRequest.call(https, opts, cb ? (res) => {
    const chunks = [];
    const origOn = res.on.bind(res);
    res.on = (ev, fn) => {
      if (ev === 'data') return origOn('data', (c) => { chunks.push(c); fn(c); });
      if (ev === 'end') return origOn('end', () => { bodies.push(chunks.join('')); fn(); });
      return origOn(ev, fn);
    };
    cb(res);
  } : cb);
};

const db = JSON.parse(fs.readFileSync(path.join(NEKO_DIR, 'neko-data.json'), 'utf8'));
const picks = db.history.filter((x) => (x.duration || 0) >= 60).slice(0, 12);
(async () => {
  let total = 0, changed = 0, mergedCount = 0;
  for (const track of picks) {
    bodies = [];
    try {
      const result = await bili.getSubtitle(track.bvid, track.cid);
      const raw = bodies.map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .find((x) => x && Array.isArray(x.body) && x.body.length);
      if (!raw) { log('跳过/无原始 body：' + (track.title || '').slice(0, 34)); continue; }
      const original = raw.body.filter((x) => String(x.content || '').trim());
      const merged = result.lines;
      const delta = original.length - merged.length;
      total++;
      if (delta > 0) { changed++; mergedCount += delta; }
      log((track.title || '').slice(0, 42));
      log('  原始 ' + original.length + ' → 当前实现 ' + merged.length + '；减少 ' + delta + ' 行');
      if (delta > 0) {
        for (const l of merged.slice(0, 8)) log('  ', JSON.stringify(l.text));
      }
    } catch (err) {
      log('跳过：' + (track.title || '').slice(0, 30) + ' [' + (err.reason || '') + '] ' + err.message);
    }
  }
  log('有效真实样本 ' + total + ' 首；发生合并 ' + changed + ' 首；总计减少 ' + mergedCount + ' 行');
})();
