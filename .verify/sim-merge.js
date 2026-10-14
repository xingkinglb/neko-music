// 实施前的算法验证：把「三闸门合并」在真实字幕上跑一遍，人工检查对不对
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
// 用户数据目录（不写死本机用户名）：%APPDATA%\neko-music
const NEKO_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'neko-music');

const OUT = path.join(__dirname, 'sim-merge-report.txt');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');

// ---- 待验证的算法（和准备写进 bilibili.js 的一模一样）----
const LYRIC_GAP_MERGE = 0.05;
const LYRIC_GAP_REAL = 0.4;
const LYRIC_GAP_TRUST = 0.6;
const LYRIC_MERGE_MAX = 15;
const LYRIC_MUSIC_MIN = 0.5;

const plainLen = (s) => s.replace(/[♪\s]/g, '').length;

function joinLyricText(a, b) {
  const la = a.replace(/\s*♪\s*$/, '');
  const rb = b.replace(/^\s*♪\s*/, '');
  return (la + ' ' + rb).trim();
}

function mergeShatteredLines(segs) {
  if (segs.length < 2) return { lines: segs, gateMusic: false, gateTrust: false, realRatio: 0, merged: 0 };
  const musicAvg = segs.reduce((s, x) => s + x.music, 0) / segs.length;
  const gateMusic = musicAvg >= LYRIC_MUSIC_MIN;
  const gaps = [];
  for (let i = 0; i < segs.length - 1; i++) gaps.push(Math.max(0, segs[i + 1].t - segs[i].tEnd));
  const real = gaps.filter((g) => g > LYRIC_GAP_REAL).length;
  const realRatio = gaps.length ? real / gaps.length : 0;
  const gateTrust = realRatio >= LYRIC_GAP_TRUST;
  if (!gateMusic || !gateTrust) {
    return { lines: segs, gateMusic, gateTrust, realRatio, merged: 0, musicAvg };
  }
  const out = [];
  let merged = 0;
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (prev && seg.t - prev.tEnd <= LYRIC_GAP_MERGE) {
      const joined = joinLyricText(prev.text, seg.text);
      if (plainLen(joined) <= LYRIC_MERGE_MAX) {
        prev.text = joined;
        prev.tEnd = Math.max(prev.tEnd, seg.tEnd);
        merged++;
        continue;
      }
    }
    out.push({ t: seg.t, tEnd: seg.tEnd, music: seg.music, text: seg.text });
  }
  return { lines: out, gateMusic, gateTrust, realRatio, merged, musicAvg };
}

// ---- 拉真实字幕 ----
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
const picks = data.history.filter((t) => (t.duration || 0) >= 60).slice(0, 12);

(async () => {
  let n = 0;
  for (const t of picks) {
    bodies = [];
    let raw = null;
    try {
      await bili.getSubtitle(t.bvid, t.cid);
      raw = bodies.map((b) => { try { return JSON.parse(b); } catch { return null; } })
        .find((j) => j && Array.isArray(j.body) && j.body.length);
    } catch (e) { log('[跳过]', (t.title || '').slice(0, 24), '→', e.reason); continue; }
    if (!raw) { log('[跳过/缓存]', (t.title || '').slice(0, 24)); continue; }
    n++;

    const segs = raw.body
      .map((it) => ({
        t: Number(it.from) || 0,
        tEnd: Number(it.to) || 0,
        music: Number(it.music) || 0,
        text: String(it.content || '').trim(),
      }))
      .filter((x) => x.text)
      .sort((a, b) => a.t - b.t);

    const r = mergeShatteredLines(segs);

    log('\n' + '='.repeat(74));
    log('《' + (t.title || '').slice(0, 40) + '》');
    log('  原始 ' + segs.length + ' 行 → 合并后 ' + r.lines.length + ' 行（合并 ' + r.merged + ' 次）');
    log('  闸门1 是歌: ' + (r.gateMusic ? 'YES' : 'NO ') + ' (music 均值 ' + (r.musicAvg || 0).toFixed(2) + ')');
    log('  闸门2 时间轴可信: ' + (r.gateTrust ? 'YES' : 'NO ') + ' (真停顿边界占 ' + (r.realRatio * 100).toFixed(0) + '%, 需 ≥60%)');

    if (!r.gateMusic || !r.gateTrust) { log('  → 判定：不动（安全）'); continue; }

    log('  -- 合并明细 --');
    // 重放一遍，把每次合并打出来
    const out = [];
    for (const seg of segs) {
      const prev = out[out.length - 1];
      if (prev && seg.t - prev.tEnd <= LYRIC_GAP_MERGE) {
        const joined = joinLyricText(prev.text, seg.text);
        const ok = plainLen(joined) <= LYRIC_MERGE_MAX;
        log('     ' + (ok ? '[并]' : '[留]') + ' ' + JSON.stringify(prev.text) + ' + ' + JSON.stringify(seg.text));
        if (ok) {
          log('          → ' + JSON.stringify(joined) + '  (' + plainLen(joined) + '字)');
          prev.text = joined; prev.tEnd = Math.max(prev.tEnd, seg.tEnd);
          continue;
        }
        log('          合并后 ' + plainLen(joined) + ' 字 > ' + LYRIC_MERGE_MAX + '，判为作者因显示限制才拆的，不动');
      }
      out.push({ ...seg });
    }
  }
  log('\n完成，有效样本 ' + n + ' 首');
})();
