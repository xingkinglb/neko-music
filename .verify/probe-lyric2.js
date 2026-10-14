// 勘察第二轮：扩大样本，按「是不是唱歌(music 字段)」分类，看 gap 判别力
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
// 用户数据目录（不写死本机用户名）：%APPDATA%\neko-music
const NEKO_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'neko-music');

const OUT = path.join(__dirname, 'probe-lyric2-report.txt');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');

const bili = require(path.join(__dirname, '..', 'src', 'bilibili.js'));
bili.setUserCookie(
  fs.readFileSync(path.join(NEKO_DIR, 'cookie.txt'), 'utf8').trim()
);

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

const data = JSON.parse(fs.readFileSync(
  path.join(NEKO_DIR, 'neko-data.json'), 'utf8'));

// 只留时长合理的（>=60s），跳过太短的
const picks = data.history.filter((t) => (t.duration || 0) >= 60).slice(0, 12);

const summary = [];

(async () => {
  for (const t of picks) {
    bodies = [];
    let raw = null, lan = '';
    try {
      const r = await bili.getSubtitle(t.bvid, t.cid);
      lan = r.lang || '';
      raw = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } })
        .find((j) => j && Array.isArray(j.body) && j.body.length);
    } catch (e) {
      log('[跳过]', (t.title || '').slice(0, 30), '→', e.reason || e.message);
      continue;
    }
    if (!raw) { log('[跳过/缓存]', (t.title || '').slice(0, 30)); continue; }

    const b = raw.body;
    const musicAvg = b.reduce((s, x) => s + (Number(x.music) || 0), 0) / b.length;
    const isSong = musicAvg > 0.5;
    const hasNote = b.filter((x) => /♪/.test(String(x.content || ''))).length / b.length;

    // 间隙（只统计同一轨道内相邻）
    const gaps = [];
    for (let i = 0; i < b.length - 1; i++) gaps.push(+b[i + 1].from - +b[i].to);
    const sorted = [...gaps].sort((x, y) => x - y);
    const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
    const zero = gaps.filter((g) => g <= 0.05).length;

    // 模拟「无缝就合并 + 字数上限 N」后的行数
    const merge = (maxLen) => {
      const out = [];
      for (const seg of b) {
        const txt = String(seg.content || '').trim();
        const prev = out[out.length - 1];
        if (prev && (+seg.from - +prev.to) <= 0.05) {
          const joined = (prev.text + ' ' + txt).replace(/♪\s*♪/g, '♪');
          const plain = joined.replace(/♪/g, '').trim();
          if (plain.length <= maxLen) { prev.to = +seg.to; prev.text = joined; continue; }
        }
        out.push({ from: +seg.from, to: +seg.to, text: txt });
      }
      return out;
    };

    const m18 = merge(18), m24 = merge(24);
    const line = (s) => s.length + '行';
    summary.push({
      title: (t.title || '').slice(0, 26), lan, n: b.length,
      music: musicAvg.toFixed(2), note: (hasNote * 100).toFixed(0) + '%',
      gapP50: p(0.5).toFixed(2), gapP90: p(0.9).toFixed(2),
      zero: zero + '/' + gaps.length,
      m18: line(m18), m24: line(m24), isSong,
    });

    log('='.repeat(72));
    log(('《' + (t.title || '') + '》').slice(0, 60));
    log('  lan=' + lan, ' 行数=' + b.length, ' music均值=' + musicAvg.toFixed(3),
      ' ♪占比=' + (hasNote * 100).toFixed(0) + '%', isSong ? ' [歌]' : ' [说话/非歌]');
    log('  gap: p25=' + p(0.25).toFixed(2), 'p50=' + p(0.5).toFixed(2),
      'p75=' + p(0.75).toFixed(2), 'p90=' + p(0.9).toFixed(2),
      ' 无缝=' + zero + '/' + gaps.length);
    log('  合并上限18字: ' + b.length + ' → ' + m18.length + ' 行');
    if (isSong && zero > 0) {
      log('  -- 会发生合并的位置（前 8 处）--');
      let shown = 0;
      for (let i = 0; i < b.length - 1 && shown < 8; i++) {
        if (+b[i + 1].from - +b[i].to <= 0.05) {
          log('     ', JSON.stringify(String(b[i].content || '')),
            ' + ', JSON.stringify(String(b[i + 1].content || '')));
          shown++;
        }
      }
    }
  }

  log('\n' + '#'.repeat(72));
  log('汇总');
  log('  曲目'.padEnd(28), 'lan'.padEnd(8), '行'.padEnd(5), 'music'.padEnd(7),
    '♪%'.padEnd(5), 'gapP50'.padEnd(7), '无缝'.padEnd(9), '→18字');
  for (const s of summary) {
    log('  ' + s.title.padEnd(26), String(s.lan).padEnd(8), String(s.n).padEnd(5),
      String(s.music).padEnd(7), String(s.note).padEnd(5),
      String(s.gapP50).padEnd(7), String(s.zero).padEnd(9), s.m18);
  }
  log('\n完成，样本 ' + summary.length + ' 首');
})();
