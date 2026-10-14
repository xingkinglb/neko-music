// 勘察：真实字幕到底是怎么分段的？打印原始 from/to/content
// 做法：劫持 https.request 收集响应体，从中捞出字幕 JSON（含 to 字段）
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
// 用户数据目录（不写死本机用户名）：%APPDATA%\neko-music
const NEKO_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'neko-music');

const OUT = path.join(__dirname, 'probe-lyric-report.txt');
fs.writeFileSync(OUT, '');
function log(...a) {
  const s = a.join(' ');
  fs.appendFileSync(OUT, s + '\n');
}

const bili = require(path.join(__dirname, '..', 'src', 'bilibili.js'));

// 读真实 Cookie（只读，不打印）
const cookie = fs.readFileSync(
  path.join(NEKO_DIR, 'cookie.txt'), 'utf8'
).trim();
bili.setUserCookie(cookie);

// ---- 劫持 https.request 收集响应 ----
const realRequest = https.request;
const bodies = [];
https.request = function (opts, cb) {
  const req = realRequest.call(https, opts, cb ? (res) => {
    const chunks = [];
    const origOn = res.on.bind(res);
    res.on = (ev, fn) => {
      if (ev === 'data') return origOn('data', (c) => { chunks.push(c); fn(c); });
      if (ev === 'end') return origOn('end', () => { bodies.push(chunks.join('')); fn(); });
      return origOn(ev, fn);
    };
    cb(res);
  } : cb);
  return req;
};

// 用户历史里挑几首
const data = JSON.parse(fs.readFileSync(
  path.join(NEKO_DIR, 'neko-data.json'), 'utf8'));
const picks = data.history.slice(0, 4);

(async () => {
  for (const t of picks) {
    log('\n' + '='.repeat(70));
    log('曲目:', t.title);
    log('bvid:', t.bvid, 'cid:', t.cid, 'UP:', t.author);
    bodies.length = 0;
    try {
      const r = await bili.getSubtitle(t.bvid, t.cid);
      log('轨道:', r.lang, ' 行数:', r.lines.length);
      // 找原始字幕 JSON
      const raw = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } })
        .find((j) => j && Array.isArray(j.body) && j.body.length);
      if (!raw) { log('!! 没能截获原始字幕 body（可能是缓存命中）'); continue; }
      log('-- 原始 body 字段 --');
      log('   样本:', JSON.stringify(raw.body[0]));
      const hasTo = raw.body.some((x) => typeof x.to === 'number');
      log('   有 to 字段:', hasTo);

      log('-- 前 24 段 (from → to | 间隔 | 文本) --');
      const b = raw.body;
      for (let i = 0; i < Math.min(24, b.length); i++) {
        const from = +b[i].from, to = +b[i].to;
        const nextFrom = b[i + 1] ? +b[i + 1].from : null;
        const gap = nextFrom != null ? (nextFrom - to) : null;
        log(
          String(i).padStart(3),
          from.toFixed(2).padStart(7), '→', to.toFixed(2).padStart(7),
          ' 占', (to - from).toFixed(2).padStart(5),
          ' 隙', gap == null ? '  -  ' : gap.toFixed(2).padStart(5),
          ' |', JSON.stringify(b[i].content)
        );
      }

      // 统计：间隙分布
      const gaps = [];
      for (let i = 0; i < b.length - 1; i++) gaps.push(+b[i + 1].from - +b[i].to);
      gaps.sort((x, y) => x - y);
      const pct = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
      log('-- 间隙分布 (n=' + gaps.length + ') --');
      log('   min', gaps[0]?.toFixed(3),
        ' p25', pct(0.25)?.toFixed(3),
        ' p50', pct(0.5)?.toFixed(3),
        ' p75', pct(0.75)?.toFixed(3),
        ' p90', pct(0.9)?.toFixed(3),
        ' max', gaps[gaps.length - 1]?.toFixed(3));
      const tight = gaps.filter((g) => g <= 0.05).length;
      const near = gaps.filter((g) => g > 0.05 && g <= 0.4).length;
      log('   ≤0.05s(无缝):', tight, '  0.05~0.4s:', near,
        '  >0.4s:', gaps.filter((g) => g > 0.4).length);

      // 统计：每段字数 & 句末标点
      const lens = b.map((x) => String(x.content || '').length);
      const avg = lens.reduce((s, x) => s + x, 0) / lens.length;
      log('-- 字数 --');
      log('   平均', avg.toFixed(1), ' 最长', Math.max(...lens), ' 最短', Math.min(...lens));
      const ends = {};
      for (const x of b) {
        const s = String(x.content || '').trim();
        const last = s.slice(-1);
        const k = /[，,。、！？!?；;…~～]/.test(last) ? last : '(无标点)';
        ends[k] = (ends[k] || 0) + 1;
      }
      log('   句末字符分布:', JSON.stringify(ends));
    } catch (e) {
      log('!! 失败:', e.reason || '', e.message);
    }
  }
  log('\n完成');
})();
