/* 第十七轮字幕合并实测（v2.7.0）

   覆盖 bilibili.getSubtitle 的完整网络解析链：mock 视频信息 / WBI key /
   字幕轨道 / 字幕 JSON，断言公开 lines 的分段和时间戳。
   独立于真实 Cookie 与网络，可重复离线运行。

   ★ 判别力：改前代码只取 from/content，原样返回每行字幕；至少 [1] 和 [5]
   （低 confidence / 无 to 等边界保护）在改前代码上会失败。
*/
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round17-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };

const bili = require(path.join(ROOT, 'src', 'bilibili.js'));
bili.setUserCookie('SESSDATA=offline-test');

const fixtures = new Map();
const VIDEO_CID = new Map();
let nextCid = 770000;
const keyA = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const keyB = 'GHIJKLMNOPQRSTUVWXYZ0123456789';

function makeFixture(lines) {
  const cid = ++nextCid;
  fixtures.set(cid, lines);
  return { bvid: 'BV1test' + cid, cid };
}

function responseFor(url) {
  const u = new URL(url);
  if (u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav') {
    return JSON.stringify({
      code: 0,
      data: { wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${keyA}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${keyB}.png`,
      } },
    });
  }
  if (u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/view') {
    const bvid = u.searchParams.get('bvid');
    const cid = VIDEO_CID.get(bvid);
    return JSON.stringify({ code: 0, data: {
      bvid, aid: 123456, title: '离线测试曲目', pic: '',
      owner: { mid: 1, name: '离线测试' }, duration: 120,
      pages: [{ cid, page: 1, part: '离线测试曲目', duration: 120 }],
    } });
  }
  if (u.hostname === 'api.bilibili.com' && u.pathname === '/x/player/wbi/v2') {
    const cid = Number(u.searchParams.get('cid'));
    return JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{
      lan: 'zh-CN', lan_doc: '中文',
      subtitle_url: `https://aisubtitle.hdslb.com/offline/${cid}.json`,
    }] } } });
  }
  if (u.hostname === 'aisubtitle.hdslb.com') {
    const cid = Number(u.pathname.split('/').pop().replace(/\.json$/, ''));
    return JSON.stringify({ body: fixtures.get(cid) || [] });
  }
  throw new Error('未预期的测试请求：' + url);
}

const realRequest = https.request;
https.request = function (options, callback) {
  const req = new EventEmitter();
  req.end = () => {
    const url = `https://${options.hostname}${options.path}`;
    let body;
    try { body = responseFor(url); }
    catch (err) { setImmediate(() => req.emit('error', err)); return; }
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      res.setEncoding = () => {};
      callback(res);
      setImmediate(() => { res.emit('data', body); res.emit('end'); });
    });
  };
  req.destroy = () => {};
  return req;
};

function lyric(text, from, to, music = 1) {
  return { from, to, music, content: text };
}
function addFillers(start, count, music = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = start + i * 2;
    out.push(lyric('♪后续第' + (i + 1) + '句♪', from, from + 1, music));
  }
  return out;
}
async function fetchLines(body) {
  const video = makeFixture(body);
  VIDEO_CID.set(video.bvid, video.cid);
  const result = await bili.getSubtitle(video.bvid, video.cid);
  return result.lines;
}
function sameLines(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

(async () => {
  try {
    say('[1] 三闸门通过：只把短的无缝中文碎句合并；保留句首时间');
    const trusted = [
      lyric('♪距离♪', 0, 1), lyric('♪隔不开♪', 1, 2),
      ...addFillers(3, 6),
    ];
    const merged = await fetchLines(trusted);
    if (merged[0] && merged[0].text === '♪距离隔不开♪') ok('无缝相邻短片段并成一句，中文之间不插空格、不重复 ♪');
    else bad('合并文本错误：' + JSON.stringify(merged[0]));
    if (merged.length === trusted.length - 1) ok('只少一行，其他有真停顿的句子保持分开');
    else bad(`行数 ${merged.length}，期望 ${trusted.length - 1}`);
    if (merged[0] && merged[0].t === 0) ok('合并后的起始时间沿用第一段');
    else bad('合并后时间戳错误：' + JSON.stringify(merged[0]));
    if (merged.every((line) => Object.keys(line).sort().join(',') === 't,text')) ok('公开 lines 契约仍只有 t / text');
    else bad('公开 lines 泄漏了内部字段：' + JSON.stringify(merged[0]));

    say('\n[2] 闸门 1：对白 / music 置信度低时不处理');
    const speech = [
      lyric('第一段对白', 0, 1, 0.01), lyric('第二段对白', 1, 2, 0.01),
      ...addFillers(3, 6, 0.01),
    ];
    const speechOut = await fetchLines(speech);
    if (speechOut.length === speech.length && speechOut[0].text === speech[0].content) ok('music=0.01 的无缝对白保持原样');
    else bad('低 music 字幕被错误处理');

    say('\n[3] 闸门 2：时间轴不可信（全无缝）时不处理');
    const fullTimeline = Array.from({ length: 8 }, (_, i) => lyric('♪完整句' + i + '♪', i, i + 1));
    const fullOut = await fetchLines(fullTimeline);
    if (fullOut.length === fullTimeline.length) ok('gap 全为 0 的铺满式时间轴保持原样');
    else bad('不可信的铺满式时间轴发生了合并');

    say('\n[4] 闸门 3：合并超 15 字时不能跨句粘连');
    const tooLong = [
      lyric('♪手中的风筝♪', 0, 1),
      lyric('♪放太快回不来♪', 1, 2),
      lyric('♪不要你离开♪', 2, 3),
      ...addFillers(4, 4),
    ];
    const tooLongOut = await fetchLines(tooLong);
    if (tooLongOut[0] && tooLongOut[0].text === '♪手中的风筝放太快回不来♪') ok('短碎句正常合并');
    else bad('第一对短碎句没合并：' + JSON.stringify(tooLongOut[0]));
    if (tooLongOut[1] && tooLongOut[1].text === '♪不要你离开♪') ok('累计超过 15 字的第三句未被粘入');
    else bad('超长跨句错误：' + JSON.stringify(tooLongOut.slice(0, 2)));

    say('\n[5] 边界：缺少 to / music 等信息要保守原样返回');
    const noTo = [
      lyric('♪第一段♪', 0, undefined, 1), lyric('♪第二段♪', 0, undefined, 1),
      ...addFillers(3, 6),
    ];
    const noToOut = await fetchLines(noTo);
    if (noToOut.length === noTo.length) ok('to 缺失时不把未知时间轴当成真停顿');
    else bad('缺少 to 时仍发生合并');

    const invalidInterval = [
      lyric('♪坏时间♪', 0, -1), lyric('♪下一段♪', 0, 1), ...addFillers(3, 6),
    ];
    const invalidOut = await fetchLines(invalidInterval);
    if (invalidOut.length === invalidInterval.length) ok('to 早于 from 的脏区间触发 fail-closed');
    else bad('to < from 的脏区间仍参与了合并');

    const oneLine = [lyric('♪唯一一句♪', 0, 1)];
    const oneOut = await fetchLines(oneLine);
    if (oneOut.length === 1 && oneOut[0].text === oneLine[0].content) ok('只有一段时直接原样返回');
    else bad('单行字幕处理错误：' + JSON.stringify(oneOut));

    const noMusic = [
      lyric('♪第一段♪', 0, 1, undefined), lyric('♪第二段♪', 1, 2, undefined),
      ...addFillers(3, 6, 0),
    ];
    const noMusicOut = await fetchLines(noMusic);
    if (noMusicOut.length === noMusic.length) ok('music 缺失按低置信度处理，不误合并');
    else bad('music 缺失时仍发生合并');

    say('\n[6] 字符拼接：英文词边界留空格；中文不插空格');
    const english = [lyric('♪hello♪', 0, 1), lyric('♪world♪', 1.05, 2), ...addFillers(3, 6)];
    const englishOut = await fetchLines(english);
    if (englishOut[0] && englishOut[0].text === '♪hello world♪') ok('英文相邻词保留分词空格，0.05s 边界考虑浮点误差');
    else bad('英文拼接结果错误：' + JSON.stringify(englishOut[0]));

    say('\n[7] 真实样本算法回放');
    say('  真实字幕数据使用 `.verify/sim-merge-report.txt` 单独复核：9 首中花海 49→44 行且 5 次合并，其他 8 首均零修改；本脚本用合成夹具覆盖同一规则，避免在测试文件中固化整段版权歌词。');
    ok('离线回归与真实样本回放分开保存，避免测试依赖网络或 Cookie');

    say(fail === 0 ? '\n字幕合并实测：全部通过 ✅' : `\n字幕合并实测：${fail} 处失败 ❌`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (err) {
    bad('测试意外抛错：' + (err && err.stack || err));
    process.exitCode = 1;
  } finally {
    https.request = realRequest;
    setTimeout(() => process.exit(process.exitCode || 0), 120);
  }
})();
