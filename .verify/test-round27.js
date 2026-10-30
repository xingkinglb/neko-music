/* 第二十七轮：v2.12.0 AI 歌词（假 AI 服务 + 真跑模块 + 离屏渲染）

   改的是什么：
     A. 主进程 ai-lyrics.js：Key 加密 / 模型列表 / 测试连接 / 整理 / 生成 / 联网探测 / 缓存
     B. 渲染层：设置页配置区、歌词页来源小标、原文↔整理切换、失败原因、重新获取清缓存

   量什么（★ = 这条最要紧）：
     [A1]  ★ Key 落盘是密文，文件里搜不到明文
     [A2]  ★ 界面拿到的只有掩码（后 4 位），没有明文
     [A3]  /models 两种形状都能解析（{data:[{id}]} 和裸数组）
     [A4]  测试连接真的发了一次对话请求
     [A5]  ★ 401 → bad-key / 200 里包 error(余额) → quota / 404 → no-model / 垃圾 → bad-format
     [A6]  ★ 500 行字幕切成 7 块，按顺序拼回、行数与时间轴不变
     [A7]  ★ 中途一块失败 → 整首失败（不是半块成功）
     [A8]  ★ 行数对不上 → mismatch（界面据此"保留原字幕"）
     [A9]  ★ 整理结果里的空串 "" 被原样保留（合并到上一行的那句）
     [A10] 生成：LRC 解析、[ti:] 元数据行丢弃、时间戳递增、越界裁掉
     [A11] ★ [00:00.00]（纯音乐）→ instrumental（走"没歌词"而不是显示一行字）
     [A12] 联网探测四态（yes / no / maybe / unknown）
     [A13] 缓存：第二次命中不发请求
     [A14] ★ 缓存上限 800，最旧的被淘汰
     [A15] clearCache 给 `BV#cid` 就把这首的整理 + 生成一起清掉
     [A16] guessSongName：书名号 / 歌手-歌名 / 歌名-版本词 / 拿不准退回原标题
     [A17] 提示词校验：整理缺 {lines} / 生成缺 {duration} 都不许存
     [B1]  ★ 总开关关着 → 配置区藏起来；打开 → 出现
     [B2]  ★ Key 只显示掩码，整页找不到明文
     [B3]  ★ 整理模式：小标「AI 整理版」+「看原文」出现
     [B4]  ★ 点「看原文」看到原字幕，再点回整理版
     [B5]  ★ 兜底生成：小标「AI 生成 · 时间轴为估算」，没有「看原文」
     [B6]  ★ 生成失败 → 空状态里写出 429 的原因（不弹窗、不阻断）
     [B7]  ★ 「重新获取」先清这一首的缓存
     [B8]  ★ 提示词缺 {lines} → 红字拦住，不保存
     [B9]  恢复默认 → 保存后字段被清空（不是存一份默认副本）
     [B10] ★ 切歌后回来的结果被丢弃（不会闪到新歌上）
     [B11] ★ 本地歌也走 AI 生成（缓存 key 用 'l:' + 路径，不撞 B 站歌的键）
     [B12] ★ 本地歌没开 AI → 空状态里说明"去设置开 AI 歌词"（不是一句"获取失败"）
     [Z ]  全程没有页面报错

   ★ 测试绝不连真 API（花钱 + 不稳定）：下面自己起一个 http.createServer 当假模型。
   开发期检查脚本，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'test-round27-report.txt');
fs.writeFileSync(REPORT, '');
const say = (m) => fs.appendFileSync(REPORT, m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { say('\n退出码 ' + code); setTimeout(() => process.exit(code), 150); };

let fail = 0;
const ok = (m) => say('  OK   ' + m);
const bad = (m) => { fail++; say('  FAIL ' + m); };
const is = (cond, m, extra) => (cond ? ok(m) : bad(m + (extra ? '  ← ' + extra : '')));

const die = (e) => {
  try { say('\n💥 测试脚本自身抛异常（不是产品失败）：' + ((e && e.stack) || e)); } catch (_) {}
  try { process.exit(3); } catch (_) {}
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-ai-r27-'));
const ai = require(path.join(ROOT, 'src', 'ai-lyrics'));

/* ---------- 假 AI 服务 ----------
   scenario 决定它怎么答。所有分支都记进 reqLog，用来断言"到底发了几次"。 */
let scenario = {};
let reqLog = [];
let polishChunkNo = 0;

const SRV = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const json = (content, extra) => send(200, Object.assign({
      choices: [{ message: { content } }],
    }, extra || {}));

    // GET /v1/models
    if (req.url.indexOf('/models') >= 0) {
      reqLog.push({ kind: 'models' });
      if (scenario.models === '404') return send(404, { error: { message: 'not found' } });
      if (scenario.models === 'array') return send(200, [{ id: 'm-a' }, { id: 'm-b' }]);
      return send(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'sonar' }] });
    }

    const prompt = (() => {
      try { return JSON.parse(body).messages[0].content || ''; } catch (_) { return ''; }
    })();

    // ---- 联网探测 ----
    if (prompt.indexOf('联网搜索今天的科技新闻') >= 0) {
      reqLog.push({ kind: 'web' });
      if (scenario.web === 'yes') return send(200, { choices: [{ message: { content: '三条新闻…', annotations: [{ type: 'url_citation' }] } }] });
      if (scenario.web === 'no') return json('抱歉，我无法联网搜索。');
      if (scenario.web === 'maybe') return json('1. https://a.com/x  2. https://b.com/y');
      return json('今天有几条科技新闻，都在路上。');
    }

    // ---- 整理 ----
    if (prompt.indexOf('歌词校对员') >= 0) {
      polishChunkNo++;
      const idx = polishChunkNo;
      let pTokens = 0;
      try { pTokens = JSON.parse(body).max_tokens || 0; } catch (_) {}
      reqLog.push({ kind: 'polish', idx, prompt, maxTokens: pTokens });
      if (scenario.polishFailAt === idx) return send(500, { error: { message: 'boom' } });
      if (scenario.polish === 'refused') return json('抱歉，我不能提供这首歌词，涉及版权。');
      if (scenario.polish === 'garbage') return json('这首歌我没有把握，就不乱写了。');
      // 从提示词尾巴挖出这一块的 JSON 数组，原样回（改一个错字 + 第 2 行留空）
      const tail = prompt.slice(prompt.lastIndexOf('['));
      let arr = [];
      try { arr = JSON.parse(tail); } catch (_) { arr = []; }
      if (scenario.polish === 'mismatch') arr = arr.slice(0, Math.max(1, arr.length - 1));
      const fixed = (s) => String(s).replace('以经', '已经');
      // 真实模型的花式姿势：外面包对象 / 元素是对象 / 根本不回 JSON 回一行一句
      if (scenario.polish === 'objwrap') {
        return json('当然可以！以下是校对结果：\n```json\n' + JSON.stringify({ lyrics: arr.map(fixed) }) + '\n```');
      }
      if (scenario.polish === 'objitems') {
        return json(JSON.stringify(arr.map((s, i) => ({ text: (scenario.polish === 'empty2' && i === 1) ? '' : fixed(s) }))));
      }
      if (scenario.polish === 'lines') return json(arr.map(fixed).join('\n'));
      // ★ 实测复现：54 行字幕，模型把 6240 个 token 全花在思考上（正文空 + finish=length）
      if (scenario.polish === 'truncated' || scenario.polish === 'truncated-short') {
        if (idx === 1) {
          return send(200, { choices: [{
            message: { content: '', reasoning_content: 'We need answer JSON array length ' + arr.length + ', correct lyrics. Need align lines…' },
            finish_reason: 'length',
          }] });
        }
        return json('<json>' + JSON.stringify(arr.map(fixed)) + '</json>');
      }
      // 推理型模型：思考 + <json> 标签里的答案
      if (scenario.polish === 'tagged') {
        return json('[00:00.00]Need check each line. The instruction says output exactly ' + arr.length + ' items.\n' +
          'Hmm, line 2 has a typo 以经. Let me output now.\n' +
          '<json>' + JSON.stringify(arr.map(fixed)) + '</json>');
      }
      const out = arr.map((s, i) => {
        if (scenario.polish === 'empty2' && i === 1) return '';
        return fixed(s);
      });
      return json('```json\n' + JSON.stringify(out) + '\n```');
    }

    // ---- 生成 ----
    if (prompt.indexOf('LRC') >= 0) {
      let sentTokens = 0;
      try { sentTokens = JSON.parse(body).max_tokens || 0; } catch (_) {}
      reqLog.push({ kind: 'gen', prompt, maxTokens: sentTokens });
      const genNo = reqLog.filter((r) => r.kind === 'gen').length;
      // ★ 实测复现：推理模型把额度全花在思考上 → 正文空 + finish_reason=length
      if (scenario.gen === 'truncated') {
        if (genNo === 1) {
          return send(200, { choices: [{
            message: { content: '', reasoning_content: 'We need answer in Chinese likely. Need provide LRC lyrics for song "银河与星斗". Need identify actual song…' },
            finish_reason: 'length',
          }] });
        }
        // 第二次（预算翻倍）给正常答案
        return json('<lrc>\n[00:05.00]第一句\n[00:09.50]第二句\n</lrc>');
      }
      if (scenario.gen === 'truncated-twice') {
        return send(200, { choices: [{
          message: { content: '', reasoning_content: 'Need produce LRC. The instruction says must not fabricate…' },
          finish_reason: 'length',
        }] });
      }
      // 答案写在思考里（没标签）→ 应该被"捞"出来
      if (scenario.gen === 'salvage') {
        return send(200, { choices: [{
          message: { content: '', reasoning_content: 'Let me draft the LRC now.\n[00:05.00]如果的事\n[00:09.00]我想和你看银河\n[00:13.00]与星斗\n[00:17.00]直到天亮\nThat looks right.' },
          finish_reason: 'stop',
        }] });
      }
      if (scenario.gen === 'instrumental') return json('[00:00.00]（纯音乐）');
      if (scenario.gen === 'garbage') return json('我不太确定这首歌的歌词。');
      if (scenario.gen === 'refused') return json('对不起，我无法提供受版权保护的歌词。');
      // ★ 实测复现：推理型模型把"内心独白"写进正文，而且还带着时间戳前缀 ——
      //   只认时间戳的解析器会照单全收，用户看到一大段英文被当成歌词逐句高亮
      if (scenario.gen === 'thinking') {
        return json('[00:00.00]Need produce LRC. We need accurate lyrics. If cannot know, maybe output only （纯音乐）?\n' +
          '[00:04.00]But likely vocal. We need decide. The instruction says if uncertain, prefer less/no fake.\n' +
          '[00:08.00]Could output pure music line only if completely don\'t know or pure music. But it\'s not pure music likely.\n' +
          '[00:12.00]Could be from Douyin: 想要和你一起看银河与星斗 maybe. But must not fabricate.\n' +
          '[00:16.00]The user wants lyrics. If we can\'t know, maybe we should still output only （纯音乐）?');
      }
      // ★ 推理型模型的正确姿势：思考写在标签外面，答案在 <lrc> 里 → 应该成功
      if (scenario.gen === 'tagged') {
        return json('[00:00.00]Need produce LRC. We need accurate lyrics. The instruction says must not fabricate.\n' +
          '[00:04.00]Hmm, maybe it is 银河与星斗. Let me write the final answer below.\n' +
          '<lrc>\n[00:05.00]第一句\n[00:09.50]第二句\n</lrc>');
      }
      // 答案整个落在 reasoning_content 里（正文空）→ 也要能捞回来
      if (scenario.gen === 'tagged-reasoning') {
        return send(200, { choices: [{ message: {
          content: '',
          reasoning_content: 'Need produce LRC. The instruction says must not fabricate.\n<lrc>\n[00:05.00]第一句\n[00:09.50]第二句\n</lrc>',
        } }] });
      }
      // 正文空、只有 reasoning_content：以前会被当成"正文"渲染出来，现在必须判成 thinking
      if (scenario.gen === 'reasoning-only') {
        return send(200, { choices: [{ message: { content: '', reasoning_content: '[00:00.00]Need produce LRC. The instruction says…' } }] });
      }
      if (scenario.gen === 'meta') {
        return json('[ti:晴天]\n[ar:周杰伦]\n[al:叶惠美]\n[00:12.40]第一句\n[00:16.85]第二句\n[00:09.00]倒回去的\n[00:999.00]越界的');
      }
      return json('[00:05.00]第一句\n[00:09.50]第二句');
    }

    // ---- 测试连接 ----
    reqLog.push({ kind: 'test' });
    if (scenario.test === '401') return send(401, { error: { message: 'invalid api key' } });
    if (scenario.test === 'quota200') return send(200, { error: { message: 'insufficient quota, 余额不足' } });
    if (scenario.test === '404') return send(404, { error: { message: 'model not found' } });
    return json('可用');
  });
});

/* ---------- 主进程模块的初始化（真模块 + 假服务） ---------- */
let srvBase = '';
const SRV_SETTINGS = { aiLyrics: {} };
const KEY = 'sk-test-SECRET-abcdef1234';

async function groupA() {
  say('【A】主进程 ai-lyrics.js');
  ai.configure({ dir: TMP, getSettings: () => SRV_SETTINGS });

  // A1/A2 Key
  const setRes = ai.setKey(KEY);
  const rawFile = fs.readFileSync(path.join(TMP, 'ai-key.bin'));
  is(setRes.encrypted === true, 'A1a 本机 safeStorage 可用，走加密分支');
  is(rawFile.indexOf(KEY) < 0 && rawFile.indexOf('SECRET') < 0,
    'A1b ★ Key 落盘是密文（文件里搜不到明文）', rawFile.slice(0, 40).toString());
  is(ai.getKey() === KEY, 'A1c 主进程自己能解回来（否则软件没法用）');
  const info = ai.keyInfo();
  is(info.has === true && info.mask === 'sk-••••••••••••1234' && info.mask.indexOf('SECRET') < 0,
    'A2 ★ 界面只拿到掩码（后 4 位 + 圆点，没有明文）', JSON.stringify(info));

  // A3 /models 两种形状
  scenario = { models: 'openai' };
  const m1 = await ai.listModels({ baseURL: srvBase, key: KEY });
  scenario = { models: 'array' };
  const m2 = await ai.listModels({ baseURL: srvBase, key: KEY });
  is(m1.length === 2 && m1[0] === 'gpt-4o-mini', 'A3a /models 的 {data:[{id}]} 能解析');
  is(m2.length === 2 && m2[1] === 'm-b', 'A3b /models 直接给数组也能解析');

  // A4 测试连接
  scenario = {};
  reqLog = [];
  const t = await ai.testConnection({ baseURL: srvBase, key: KEY, model: 'gpt-4o-mini' });
  is(t.ok && t.reply.indexOf('可用') >= 0 && reqLog.filter((r) => r.kind === 'test').length === 1,
    'A4 测试连接真的发了一次对话请求');

  // A5 四类错误
  const errOf = async (sc, fn) => {
    scenario = sc;
    try { await fn(); return null; } catch (e) { return e; }
  };
  const e401 = await errOf({ test: '401' }, () => ai.testConnection({ baseURL: srvBase, key: KEY, model: 'x' }));
  is(e401 && e401.reason === 'bad-key', 'A5a 401 → bad-key', e401 && e401.message);
  const eQuota = await errOf({ test: 'quota200' }, () => ai.testConnection({ baseURL: srvBase, key: KEY, model: 'x' }));
  is(eQuota && eQuota.reason === 'quota', 'A5b ★ 200 里包 error(余额) → quota（没当成功）', eQuota && eQuota.message);
  is(eQuota && eQuota.message.indexOf('429') >= 0, 'A5c 包在 200 里的错误也说成 429（不是"返回 200"）', eQuota && eQuota.message);
  const e404 = await errOf({ test: '404' }, () => ai.testConnection({ baseURL: srvBase, key: KEY, model: 'gpt-4o-mini' }));
  is(e404 && e404.reason === 'no-model' && e404.message.indexOf('gpt-4o-mini') >= 0,
    'A5d 404 → no-model，文案里带上模型名', e404 && e404.message);
  const eGarbage = await errOf({ gen: 'garbage' }, () => ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'x', title: 't', duration: 200 }));
  is(eGarbage && (eGarbage.reason === 'bad-format' || eGarbage.reason === 'refused'),
    'A5e 返回垃圾 → bad-format / refused', eGarbage && eGarbage.reason);
  const eNoCfg = await errOf({}, () => ai.testConnection({ baseURL: '', key: KEY, model: 'x' }));
  is(eNoCfg && eNoCfg.reason === 'no-config', 'A5f 没填 BaseURL → no-config', eNoCfg && eNoCfg.reason);
  const eNet = await errOf({}, () => ai.testConnection({ baseURL: 'http://127.0.0.1:1/v1', key: KEY, model: 'x' }));
  is(eNet && eNet.reason === 'timeout', 'A5g 连不上 → timeout（界面显示"检查 BaseURL 或网络"）', eNet && eNet.reason);

  // A6 500 行 → 7 块
  scenario = {};
  polishChunkNo = 0;
  reqLog = [];
  const lines = Array.from({ length: 500 }, (_, i) => ({ t: i * 2, text: '我以经等了你很久' + i }));
  const progress = [];
  const out = await ai.polishLyrics({
    baseURL: srvBase, key: KEY, model: 'm', title: '测试歌', lines,
    onProgress: (d, tt) => progress.push(d + '/' + tt),
  });
  is(out.length === 500, 'A6a ★ 500 行进来 500 行出去');
  is(reqLog.filter((r) => r.kind === 'polish').length === 7, 'A6b ★ 切成 7 块（500 / 80 向上取整）');
  is(progress.join(',') === '1/7,2/7,3/7,4/7,5/7,6/7,7/7', 'A6c 进度是 1/7 … 7/7', progress.join(','));
  is(out[0].text === '我已经等了你很久0' && out[499].text === '我已经等了你很久499',
    'A6d ★ 按顺序拼回（首尾都对得上）');
  is(out[0].t === 0 && out[499].t === 998, 'A6e 时间轴用的是原来的（一个字都没动）');

  // A7 中途一块失败 → 整首失败
  scenario = { polishFailAt: 3 };
  polishChunkNo = 0;
  let partErr = null;
  try {
    await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines });
  } catch (e) { partErr = e; }
  is(!!partErr, 'A7 ★ 第 3 块失败 → 整首失败（没有"半块成功半块失败"）', partErr && partErr.reason);

  // A8 行数不一致
  scenario = { polish: 'mismatch' };
  polishChunkNo = 0;
  let misErr = null;
  try { await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 40) }); }
  catch (e) { misErr = e; }
  is(misErr && misErr.reason === 'mismatch', 'A8 ★ 行数对不上 → mismatch（界面据此"保留原字幕"）', misErr && misErr.reason);

  // A9 空串保留
  scenario = { polish: 'empty2' };
  polishChunkNo = 0;
  const out2 = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 5) });
  is(out2.length === 5 && out2[1].text === '' && out2[0].text !== '',
    'A9 ★ 整理结果里的空串 "" 被原样保留（合并到上一行的那句）', JSON.stringify(out2.map((x) => x.text)));

  // A9b~A9e 真实模型的花式姿势（计划书 §9：真实返回和假服务不一样，当场调解析）
  scenario = { polish: 'objwrap' };
  polishChunkNo = 0;
  const oWrap = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 5) });
  is(oWrap.length === 5 && oWrap[0].text.indexOf('已经') >= 0,
    'A9b 外面还包一层 {"lyrics":[...]} 也能抠出来', JSON.stringify(oWrap && oWrap[0]));
  scenario = { polish: 'objitems' };
  polishChunkNo = 0;
  const oItems = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 5) });
  is(oItems.length === 5 && oItems[1].text === '我已经等了你很久1',
    'A9c 元素是 {"text":"..."} 对象 → 抠出字符串（不是 [object Object]）', JSON.stringify(oItems && oItems[1]));
  scenario = { polish: 'lines' };
  polishChunkNo = 0;
  const oLines = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 5) });
  is(oLines.length === 5 && oLines[0].text.indexOf('已经') >= 0,
    'A9d 不回 JSON、回"一行一句"且行数对上 → 也收', JSON.stringify(oLines && oLines[0]));
  scenario = { gen: 'garbage' };
  let prevErr = null;
  try { await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 }); }
  catch (e) { prevErr = e; }
  is(prevErr && prevErr.reason === 'bad-format' && prevErr.message.indexOf('它的开头是') >= 0,
    'A9e ★ bad-format 的报错带上模型原文开头（下次失败不用猜）', prevErr && prevErr.message);

  // A9f/A9g 推理型模型（v2.12.0 实测反馈：整屏英文内心独白被当成歌词渲染）
  scenario = { gen: 'thinking' };
  let thinkErr = null;
  try { await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: '银河与星斗', duration: 200 }); }
  catch (e) { thinkErr = e; }
  is(thinkErr && thinkErr.reason === 'thinking',
    'A9f ★ 思考过程当正文回（带时间戳）→ 判成 thinking，绝不渲染成歌词', thinkErr && thinkErr.reason);
  is(thinkErr && thinkErr.message.indexOf('不思考的模型') >= 0 && thinkErr.message.indexOf('它的开头是') >= 0,
    'A9g thinking 的报错给出可操作建议（换不思考的模型 / 加一句提示词）并带上原文开头',
    thinkErr && thinkErr.message.slice(0, 60));

  scenario = { gen: 'reasoning-only' };
  let reasonErr = null;
  try { await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 }); }
  catch (e) { reasonErr = e; }
  is(reasonErr && reasonErr.reason === 'thinking',
    'A9h ★ 正文为空、只有 reasoning_content → 判成 thinking（以前会拿它当正文）', reasonErr && reasonErr.reason);

  // A9k~A9m 推理型模型的**正确姿势**：思考写在标签外面，答案在 <lrc> / <json> 里 → 必须能用
  scenario = { gen: 'tagged' };
  const tagGen = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 });
  is(!tagGen.instrumental && tagGen.lines.length === 2 && tagGen.lines[0].text === '第一句',
    'A9k ★ 正文里混着思考、但答案在 <lrc> 标签里 → 正常出歌词（推理模型可用）',
    JSON.stringify(tagGen && tagGen.lines));
  scenario = { gen: 'tagged-reasoning' };
  const tagThink = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 });
  is(tagThink.lines.length === 2 && tagThink.lines[1].text === '第二句',
    'A9l ★ 答案整个落在 reasoning_content 的标签里 → 也捞回来（正文空也不白跑）',
    JSON.stringify(tagThink && tagThink.lines));
  scenario = { polish: 'tagged' };
  polishChunkNo = 0;
  const tagPolish = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 5) });
  is(tagPolish.length === 5 && tagPolish[0].text.indexOf('已经') >= 0,
    'A9m ★ 整理：思考 + <json> 标签 → 正常拼回 5 行', JSON.stringify(tagPolish && tagPolish[0]));

  // A9n~A9p 实测那条报错："正文空 + 被截断"（推理模型把额度全花在思考上）
  scenario = { gen: 'truncated' };
  reqLog = [];
  const trunc = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: '银河与星斗', duration: 200 });
  const genReqs = reqLog.filter((r) => r.kind === 'gen');
  is(trunc.lines.length === 2 && genReqs.length === 2 && genReqs[1].maxTokens > genReqs[0].maxTokens,
    'A9n ★ 被截断 → 自动加大输出预算重试一次（第二次的 max_tokens 更大）',
    JSON.stringify(genReqs.map((r) => r.maxTokens)));
  is(genReqs.length === 2 && genReqs[1].prompt.indexOf('直接输出最终答案，不要输出任何思考过程') === 0,
    'A9n2 ★ 重试时还加了"别想了，直接给答案"（光加预算治不了"想太多"）',
    genReqs.length === 2 ? genReqs[1].prompt.slice(0, 30) : '');

  scenario = { gen: 'truncated-twice' };
  reqLog = [];
  let truncErr = null;
  try { await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 }); }
  catch (e) { truncErr = e; }
  is(truncErr && truncErr.reason === 'thinking' && truncErr.message.indexOf('截断') >= 0,
    'A9o ★ 两次都被截断 → 明说"想太久被截断"（不是笼统的格式错误）', truncErr && truncErr.message.slice(0, 50));

  scenario = { gen: 'salvage' };
  const salv = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 });
  is(salv.lines.length === 4 && salv.lines[0].text === '如果的事' && salv.fromReasoning === true,
    'A9p ★ 正文空、答案写在思考里 → 从思考里把带时间戳的歌词捞出来（去掉英文前缀）',
    JSON.stringify(salv.lines && salv.lines.slice(0, 2)));

  // A9i 歌名提取：本地文件名里的序号 / 编码后缀都要剥掉，且真的用在了提示词里
  is(ai.guessSongName('14. A零距离 - 银河与星斗_AAC') === '银河与星斗',
    'A9i ★ 歌名提取：去掉序号 14. 和编码后缀 _AAC', ai.guessSongName('14. A零距离 - 银河与星斗_AAC'));
  {
    scenario = {};
    reqLog = [];
    await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: '14. A零距离 - 银河与星斗_AAC', duration: 200 });
    const genReq = reqLog.filter((r) => r.kind === 'gen');
    is(genReq.length === 1 && genReq[0].prompt.indexOf('银河与星斗') >= 0 &&
       genReq[0].prompt.indexOf('A零距离') < 0,
      'A9j ★ 提示词里发的是提取后的歌名（"A零距离"这种疑似歌手/台名不进去）',
      genReq.length ? genReq[0].prompt.split('\n').slice(0, 4).join(' / ') : '没发请求');
  }

  // A9q 整理被截断：长块（54 行）→ 折半分别送（行数少，模型想得少）
  scenario = { polish: 'truncated' };
  polishChunkNo = 0;
  reqLog = [];
  const pTrunc = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 54) });
  const pReqs = reqLog.filter((r) => r.kind === 'polish');
  is(pTrunc.length === 54 && pReqs.length === 3,
    'A9q ★ 整理被截断 → 长块折半重来（1 次大块失败 + 2 次半块成功）',
    `行数 ${pTrunc.length} / 请求 ${pReqs.length}`);
  is(pReqs.length >= 2 && pReqs[1].prompt.indexOf('不要输出任何思考过程') >= 0 &&
     pReqs[1].prompt.indexOf('只改明显的错别字') >= 0 &&
     pReqs[1].prompt.length < pReqs[0].prompt.length,
    'A9r ★ 折半重来用的是精简提示词（比原来短一半，且明确"不要思考"）',
    pReqs.length >= 2 ? `原 ${pReqs[0].prompt.length} 字 → 重试 ${pReqs[1].prompt.length} 字` : '');

  // A9t 用户设了"输出上限"→ 第一次请求就得按他设的来（不是按行数算）
  scenario = {};
  polishChunkNo = 0;
  reqLog = [];
  await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 10), maxTokens: 64000 });
  const tReqs = reqLog.filter((r) => r.kind === 'polish');
  is(tReqs.length === 1 && tReqs[0].maxTokens === 64000,
    'A9t ★ 用户在设置里设的上限会真的用上（10 行也按 64000 发）',
    tReqs.length ? String(tReqs[0].maxTokens) : '没发请求');

  // A9s 短块（20 行）被截断：不折半，改成"加预算 + 精简提示词"再来一次
  scenario = { polish: 'truncated-short' };
  polishChunkNo = 0;
  reqLog = [];
  const pShort = await ai.polishLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', lines: lines.slice(0, 20) });
  const sReqs = reqLog.filter((r) => r.kind === 'polish');
  is(pShort.length === 20 && sReqs.length === 2 && sReqs[1].maxTokens > sReqs[0].maxTokens,
    'A9s ★ 短块被截断 → 加预算重试（不折半）',
    JSON.stringify(sReqs.map((r) => r.maxTokens)));

  // A10 生成 + 元数据 + 递增 + 越界
  scenario = { gen: 'meta' };
  const g = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: '晴天', duration: 200 });
  is(g.lines.length === 3, 'A10a [ti:] [ar:] [al:] 三行元数据被丢弃（只剩 3 句）', JSON.stringify(g.lines));
  is(g.lines[0].t === 9 && g.lines[1].t === 12.4 && g.lines[2].t === 16.85,
    'A10b 时间戳按递增排好（倒着写的那句被摆正）');
  is(!g.lines.some((l) => l.t > 200), 'A10c 越界的 [00:999.00] 被裁掉');

  // A11 纯音乐
  scenario = { gen: 'instrumental' };
  const gi = await ai.generateLyrics({ baseURL: srvBase, key: KEY, model: 'm', title: 't', duration: 200 });
  is(gi.instrumental === true && gi.lines.length === 0,
    'A11 ★ （纯音乐）→ instrumental（走"没歌词"空状态）', JSON.stringify(gi));

  // A12 联网四态
  const lv = {};
  for (const w of ['yes', 'no', 'maybe', 'unknown']) {
    scenario = { web: w };
    lv[w] = (await ai.testWebSearch({ baseURL: srvBase, key: KEY, model: 'm' })).level;
  }
  is(lv.yes === 'yes' && lv.no === 'no' && lv.maybe === 'maybe' && lv.unknown === 'unknown',
    'A12 联网四态都对', JSON.stringify(lv));

  // A13 缓存命中
  scenario = {};
  polishChunkNo = 0;
  reqLog = [];
  ai.clearCache();
  const c1 = await ai.polishCached({ bvid: 'BVa', cid: 11, baseURL: srvBase, model: 'm', title: 't', lines: lines.slice(0, 10) });
  const after1 = reqLog.filter((r) => r.kind === 'polish').length;
  const c2 = await ai.polishCached({ bvid: 'BVa', cid: 11, baseURL: srvBase, model: 'm', title: 't', lines: lines.slice(0, 10) });
  const after2 = reqLog.filter((r) => r.kind === 'polish').length;
  is(c1.fromCache === false && c2.fromCache === true && after1 === after2,
    'A13 ★ 第二次走缓存，没有重复请求', `请求数 ${after1} → ${after2}`);

  // A14 上限 800
  ai.clearCache();
  for (let i = 0; i < 900; i++) ai.cachePut('k' + i, 'gen', [{ t: 0, text: 'x' }]);
  const st = ai.cacheStats();
  is(st.count === 800, 'A14a ★ 写 900 条只剩 800 条', String(st.count));
  is(ai.cacheGet('k0') === null && !!ai.cacheGet('k899'),
    'A14b ★ 淘汰的是最旧的（k0 没了、k899 还在）');

  // A15 单首清缓存（两个 mode 一起）
  ai.clearCache();
  ai.cachePut(ai.cacheKeyOf('BVz', 7, 'polish'), 'polish', [{ t: 0, text: 'a' }]);
  ai.cachePut(ai.cacheKeyOf('BVz', 7, 'gen'), 'gen', [{ t: 0, text: 'b' }]);
  ai.cachePut(ai.cacheKeyOf('BVother', 8, 'gen'), 'gen', [{ t: 0, text: 'c' }]);
  ai.clearCache('BVz#7');
  is(!ai.cacheGet(ai.cacheKeyOf('BVz', 7, 'polish')) && !ai.cacheGet(ai.cacheKeyOf('BVz', 7, 'gen')) &&
     !!ai.cacheGet(ai.cacheKeyOf('BVother', 8, 'gen')),
    'A15 ★ 给「BVz#7」把这首的整理 + 生成一起清掉，别的歌不受影响');

  // A15b 本地歌的缓存 key：有 base 用 base，别拼出 null#null（所有本地歌会共享一份缓存）
  is(ai.cacheKeyFor({ base: 'l:C:/a.m4a' }, 'gen') === 'l:C:/a.m4a|gen' &&
     ai.cacheKeyFor({ bvid: 'BVx', cid: 3 }, 'polish') === 'BVx#3|polish' &&
     ai.cacheKeyFor({ bvid: null, cid: null }, 'gen') === '#|gen',
    'A15b ★ cacheKeyFor：界面传了 base 就用 base（本地歌专用）；不传的话本地歌全撞成 #|gen 一份缓存',
    ai.cacheKeyFor({ bvid: null, cid: null }, 'gen'));

  // A16 歌名提取
  const gn = [
    ai.guessSongName('【真栗】《如果的事》如果我已经不能控制每天想栗亿次…'),
    ai.guessSongName('周杰伦 - 晴天'),
    ai.guessSongName('晴天 - 官方MV'),
    ai.guessSongName(''),
  ];
  is(gn[0] === '如果的事', 'A16a 书名号优先', gn[0]);
  is(gn[1] === '晴天', 'A16b 「歌手 - 歌名」取歌名那一半', gn[1]);
  is(gn[2] === '晴天', 'A16c 「歌名 - 版本词」取歌名那一半', gn[2]);
  is(gn[3] === '', 'A16d 空标题不炸');

  // A17 提示词校验
  is(ai.validatePrompt('polish', '没有占位符').ok === false, 'A17a 整理提示词缺 {lines} → 不许存');
  is(ai.validatePrompt('generate', '只有 {title}').ok === false, 'A17b 生成提示词缺 {duration} → 不许存');
  is(ai.validatePrompt('polish', 'a {lines} b').ok === true, 'A17c 占位符齐了 → 通过');
  const pr = ai.getPrompts();
  is(pr.polish.isDefault === true && pr.polish.text === ai.DEFAULT_PROMPT_POLISH &&
     pr.polish.text.indexOf('不要输出 markdown') >= 0,
    'A17d 没改过 → 用主进程的默认提示词（含"不要输出 markdown"）');
  SRV_SETTINGS.aiLyrics = { promptPolish: '我自己写的 {lines}' };
  is(ai.getPrompts().polish.isDefault === false && ai.getPrompts().polish.text === '我自己写的 {lines}',
    'A17e 改过 → 用自定义的');
  SRV_SETTINGS.aiLyrics = { promptPolish: '' };
  is(ai.getPrompts().polish.isDefault === true, 'A17f 空串 = 恢复默认（不是"存了一个空提示词"）');
}

/* ============================================================
   B：渲染层（离屏真跑 index.html + app.js）
   ============================================================ */
const LYRIC_TRACK_A = { bvid: 'BVlyricA', cid: 101, title: '如果的事', author: '真栗', duration: 240, cover: '' };
const LYRIC_TRACK_B = { bvid: 'BVlyricB', cid: 202, title: '没字幕的歌', author: '某人', duration: 200, cover: '' };

const SUB_LINES = [
  { t: 1, text: '嗯嗯' },
  { t: 5, text: '我以经等了你很久了' },
  { t: 9, text: '你你你怎么才来' },
];

let uiMode = 'polish';       // polish / gen / gen-fail
let lastGenOpts = null;      // ai:generate 桩收到的最后一次参数（B11b 断言用）
let clearCalls = [];
let polishDelay = 0;
let polishHits = 0;
let aiPeekCalls = [];

function stubIpc() {
  ipcMain.handle('store:load', () => ({
    ok: true,
    data: { playlists: [], favorites: [], history: [], lastTrack: null, local: [], settings: {} },
  }));
  ipcMain.handle('store:save', () => ({ ok: true, data: true }));
  ipcMain.handle('cookie:get', () => ({ ok: true, data: 'SESSDATA=test' }));
  ipcMain.handle('bili:hasCookie', () => ({ ok: true, data: true }));
  ipcMain.handle('bili:audioUrl', () => ({ ok: true, data: { url: 'bili://get?url=x', duration: 240, backup: [] } }));
  ipcMain.handle('bili:search', () => ({ ok: true, data: { list: [] } }));
  ipcMain.handle('bili:parse', () => ({ ok: true, data: { bvid: 'BVlyricA' } }));
  ipcMain.handle('bili:videoInfo', () => ({ ok: true, data: { bvid: 'BVlyricA', pages: [{ cid: 101, duration: 240 }], owner: { mid: 1, name: 'x' } } }));
  ipcMain.handle('bili:subtitle', () => ({ ok: true, data: { lines: SUB_LINES, videoTitle: '如果的事', lang: '中文' } }));
  ipcMain.handle('bg:pick', () => ({ ok: true, data: null }));
  ipcMain.handle('bg:clear', () => ({ ok: true, data: true }));

  /* AI 那组：直接转给**真的** ai-lyrics 模块（Key 也走真的加密文件） */
  ipcMain.handle('ai:keyInfo', () => ({ ok: true, data: ai.keyInfo() }));
  ipcMain.handle('ai:setKey', (_e, t) => ({ ok: true, data: ai.setKey(t) }));
  ipcMain.handle('ai:clearKey', () => ({ ok: true, data: ai.clearKey() }));
  ipcMain.handle('ai:getPrompts', () => ({ ok: true, data: ai.getPrompts() }));
  ipcMain.handle('ai:cacheStats', () => ({ ok: true, data: ai.cacheStats() }));
  // 只读缓存：模拟"之前整理过、这次总开关关着"
  ipcMain.handle('ai:cachePeek', (_e, key) => {
    aiPeekCalls.push(key);
    return { ok: true, data: { lines: SUB_LINES.map((l, i) => ({ t: l.t, text: i === 1 ? '' : String(l.text).replace('以经', '已经') })), at: Date.now(), mode: 'polish' } };
  });
  ipcMain.handle('ai:clearCache', (_e, key) => {
    clearCalls.push(key === undefined ? '<all>' : key);
    ai.clearCache(key);
    return { ok: true, data: true };
  });
  ipcMain.handle('ai:models', () => ({ ok: true, data: ['gpt-4o-mini'] }));
  ipcMain.handle('ai:test', () => ({ ok: true, data: { ok: true, reply: '可用', ms: 12, model: 'm' } }));
  ipcMain.handle('ai:testWebSearch', () => ({ ok: true, data: { level: 'no', evidence: '模型自己说不能联网' } }));
  ipcMain.handle('ai:polish', async (_e, o) => {
    polishHits++;
    if (polishDelay) await sleep(polishDelay);
    return {
      ok: true,
      data: {
        mode: 'polish', fromCache: false, key: 'k',
        lines: o.lines.map((l, i) => ({ t: l.t, text: i === 1 ? '' : String(l.text).replace('以经', '已经') })),
      },
    };
  });
  ipcMain.handle('ai:generate', async (_e, o) => {
    lastGenOpts = o;
    const debug = {
      mode: 'gen', model: 'm', attempt: 1, finish: 'stop',
      prompt: '【调试用】发出去的提示词正文',
      content: '<lrc>\n[00:05.00]第一句\n[00:09.50]第二句\n</lrc>',
      reasoning: 'Need produce LRC. The instruction says must not fabricate…',
    };
    if (uiMode === 'gen-fail') {
      return { ok: false, error: 'AI 返回 429：额度用完了或被限流，等会儿再试', reason: 'quota', debug };
    }
    return {
      ok: true,
      data: { mode: 'gen', fromCache: false, instrumental: false, key: 'k', debug,
        lines: [{ t: 5, text: '第一句' }, { t: 9.5, text: '第二句' }] },
    };
  });

  ['win-min', 'win-max', 'win-close', 'win:close-ready', 'win:fullscreen', 'win:mini',
    'lyric:open', 'lyric:close', 'lyric:through', 'lyric:style', 'lyric:push', 'lyric:line',
    'lyric:move', 'ui-state', 'win:ui-state'].forEach((c) => ipcMain.on(c, () => {}));
  require('./stub-download-ipc.js')();
}

async function groupB() {
  say('\n【B】渲染层（设置页 + 歌词页）');
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false,
    frame: false, backgroundColor: '#0e0e14',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) pageErrors.push(msg);
  });
  await win.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  await sleep(900);
  const ev = (code) => win.webContents.executeJavaScript(code);

  // 先存一把 Key（走真的加密文件），后面 B2 要检查界面上看不到明文
  ai.setKey(KEY);

  /* B1 总开关 */
  await ev(`(() => { DB.settings.aiLyrics = sanitizeAiLyrics({ aiPolish: false, aiGenerate: false }); openSettings(); showSettingsTab('lyric'); return true; })()`);
  await sleep(400);
  const hidden = await ev(`document.getElementById('aiBox').style.display`);
  await ev(`(() => { document.getElementById('chkAiEnabled').click(); return true; })()`);
  await sleep(300);
  const shown = await ev(`document.getElementById('aiBox').style.display`);
  is(hidden === 'none' && shown === '', 'B1 ★ 总开关关着 → 配置区藏起来；打开 → 出现', hidden + ' / ' + shown);

  /* B2 掩码 */
  await sleep(400);
  const maskTxt = await ev(`document.getElementById('aiKeyMask').textContent`);
  const bodyTxt = await ev(`document.body.innerHTML`);
  is(maskTxt.indexOf('1234') >= 0 && maskTxt.indexOf('SECRET') < 0,
    'B2a ★ Key 只显示掩码（后 4 位 + 圆点）', maskTxt);
  is(bodyTxt.indexOf('SECRET') < 0 && bodyTxt.indexOf(KEY) < 0,
    'B2b ★ 整页 HTML 里找不到明文 Key');
  is(await ev(`!document.querySelector('[data-ai-reveal]') && !document.getElementById('btnAiKeyShow')`),
    'B2c ★ 没有任何"看明文"的入口');

  /* 配置好 AI，准备测歌词 */
  await ev(`(() => {
    const a = DB.settings.aiLyrics;
    a.enabled = true; a.aiPolish = true; a.aiGenerate = true;
    a.baseURL = 'http://127.0.0.1:1/v1'; a.model = 'gpt-4o-mini';
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_A)}], index: 0, name: '' };
    return true;
  })()`);

  /* B3 整理模式 */
  await ev(`loadLyrics(false)`);
  await sleep(700);
  const tagP = await ev(`(() => ({ t: document.getElementById('lyricTag').textContent,
    show: document.getElementById('lyricTag').classList.contains('show'),
    raw: document.getElementById('btnLyricRaw').classList.contains('show'),
    rawTxt: document.getElementById('btnLyricRaw').textContent,
    first: document.querySelector('#lyricBox .l') ? document.querySelector('#lyricBox .l').textContent : '' }))()`);
  is(tagP.show && tagP.t === 'AI 整理版', 'B3a ★ 整理模式挂「AI 整理版」小标', tagP.t);
  is(tagP.raw && tagP.rawTxt === '看原文', 'B3b ★ 有「看原文」切换', tagP.rawTxt);
  is(tagP.first === '嗯嗯', 'B3c 默认显示的是整理版（第 1 行原样照抄）', tagP.first);

  /* B4 看原文 / 看整理 */
  await ev(`document.getElementById('btnLyricRaw').click(); true`);
  await sleep(250);
  const rawView = await ev(`(() => ({ t: document.getElementById('lyricTag').textContent,
    l2: document.querySelectorAll('#lyricBox .l')[1].textContent,
    btn: document.getElementById('btnLyricRaw').textContent }))()`);
  is(rawView.t === '原字幕' && rawView.btn === '看整理', 'B4a 切到原文：小标变「原字幕」、按钮变「看整理」', rawView.t + '/' + rawView.btn);
  is(rawView.l2 === '我以经等了你很久了', 'B4b ★ 原文是没改过的字幕（"以经"还在）', rawView.l2);
  await ev(`document.getElementById('btnLyricRaw').click(); true`);
  await sleep(250);
  const backView = await ev(`document.querySelectorAll('#lyricBox .l')[1].textContent`);
  is(backView === '', 'B4c ★ 切回整理版：那一行是 AI 合并后留的空串', JSON.stringify(backView));

  /* B5 兜底生成 */
  await ev(`(() => {
    DB.settings.aiLyrics.aiPolish = false;
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_B)}], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.mode = '';
    return true;
  })()`);
  // 让这首歌"没有字幕"
  ipcMain.removeHandler('bili:subtitle');
  ipcMain.handle('bili:subtitle', () => ({ ok: false, error: '这首没有字幕', reason: 'none' }));
  await ev(`loadLyrics(false)`);
  await sleep(600);
  const genTag = await ev(`(() => ({ t: document.getElementById('lyricTag').textContent,
    est: document.getElementById('lyricTag').classList.contains('est'),
    raw: document.getElementById('btnLyricRaw').classList.contains('show'),
    first: document.querySelector('#lyricBox .l') ? document.querySelector('#lyricBox .l').textContent : '' }))()`);
  is(genTag.t === 'AI 生成 · 时间轴为估算' && genTag.est,
    'B5a ★ 兜底生成挂「AI 生成 · 时间轴为估算」（高亮那档）', genTag.t);
  is(!genTag.raw, 'B5b 生成模式没有「看原文」（没有原文可看）');
  is(genTag.first === '第一句', 'B5c 生成的两句渲染出来了', genTag.first);

  /* B6 生成失败 → 原因写进空状态 */
  await ev(`(() => { lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; return true; })()`);
  uiMode = 'gen-fail';
  await ev(`loadLyrics(false)`);
  await sleep(600);
  const failBox = await ev(`(() => ({
    msg: (document.querySelector('.le-msg') || {}).textContent || '',
    note: (document.querySelector('.le-ai') || {}).textContent || '',
    toast: document.getElementById('lyricTip').textContent,
  }))()`);
  is(failBox.note.indexOf('429') >= 0, 'B6a ★ 空状态里写出了失败原因（429 额度用完）', failBox.note);
  is(failBox.msg.indexOf('没取到歌词') >= 0, 'B6b 退回"没歌词"的普通空状态', failBox.msg);

  /* B7 重新获取先清缓存 */
  clearCalls = [];
  uiMode = 'gen';
  await ev(`document.getElementById('btnLyricRetry').click(); true`);
  await sleep(700);
  is(clearCalls.length === 1 && clearCalls[0] === 'BVlyricB#202',
    'B7 ★ 「重新获取」先清掉这一首的缓存（否则点了等于没点）', JSON.stringify(clearCalls));

  /* B8 / B9 提示词面板 */
  await ev(`(() => { openSettings(); showSettingsTab('lyric'); return true; })()`);
  await sleep(300);
  await ev(`document.getElementById('btnAiPrompts').click(); true`);
  await sleep(500);
  const pOpen = await ev(`document.getElementById('aiPromptMask').classList.contains('show')`);
  is(pOpen, 'B8a 提示词面板能打开');

  await ev(`(() => {
    document.getElementById('aiPromptText').value = '我把占位符删掉了';
    document.getElementById('btnAiPromptSave').click();
    return true;
  })()`);
  await sleep(200);
  const pWarn = await ev(`document.getElementById('aiPromptWarn').textContent`);
  const pSaved = await ev(`DB.settings.aiLyrics.promptPolish`);
  is(pWarn.indexOf('{lines}') >= 0 && !pSaved,
    'B8b ★ 缺 {lines} → 红字拦住，没保存', pWarn);

  await ev(`document.getElementById('btnAiPromptReset').click(); true`);
  await sleep(200);
  const pReset = await ev(`document.getElementById('aiPromptText').value`);
  await ev(`document.getElementById('btnAiPromptSave').click(); true`);
  await sleep(300);
  const pAfter = await ev(`DB.settings.aiLyrics.promptPolish`);
  is(pReset.indexOf('歌词校对员') >= 0, 'B9a 「恢复默认」把默认提示词填回框里');
  is(pAfter === '', 'B9b ★ 恢复默认后保存 → 字段被清空（不是存一份默认副本）', JSON.stringify(pAfter));

  /* B10 切歌丢弃 */
  await ev(`(() => {
    document.getElementById('aiPromptMask').classList.remove('show');
    DB.settings.aiLyrics.aiPolish = true;
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_A)}], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    polishDelay = 800;
    loadLyrics(false);
    return true;
  })()`);
  await sleep(200);
  // 请求还在路上时切歌（模拟用户两分钟内换了歌）
  await ev(`(() => {
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_B)}], index: 0, name: '' };
    lyricState.trackKey = 'BVlyricB:202';
    lyricState.lines = []; lyricState.mode = '';
    return true;
  })()`);
  await sleep(1200);
  const afterSwitch = await ev(`(() => ({ key: lyricState.trackKey, mode: lyricState.mode, n: lyricState.lines.length }))()`);
  is(afterSwitch.key === 'BVlyricB:202' && afterSwitch.mode !== 'polish' && afterSwitch.n === 0,
    'B10 ★ 切歌后回来的整理结果被丢弃（没闪到新歌上）', JSON.stringify(afterSwitch));
  polishDelay = 0;

  /* B11 本地歌 + AI：没有 bvid/cid，直接走生成（跳过 ensureCid 和字幕） */
  await ev(`(() => {
    DB.settings.aiLyrics.aiPolish = false;
    queue = { tracks: [{ localPath: 'C:/music/周杰伦 - 晴天.m4a', title: '晴天', author: '周杰伦', duration: 269, bvid: null, cid: null }], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    loadLyrics(false);
    return true;
  })()`);
  await sleep(600);
  const locTag = await ev(`(() => ({ t: document.getElementById('lyricTag').textContent,
    n: lyricState.lines.length, key: lyricState.trackKey }))()`);
  is(locTag.t === 'AI 生成 · 时间轴为估算' && locTag.n > 0 &&
     locTag.key === 'l:C:/music/周杰伦 - 晴天.m4a',
    'B11 ★ 本地歌也走 AI 生成（缓存 key 用 l: + 路径，不撞 B 站歌的键）', JSON.stringify(locTag));
  is(lastGenOpts && lastGenOpts.base === 'l:C:/music/周杰伦 - 晴天.m4a',
    'B11b ★ 传给主进程的参数带 base（否则主进程拼出 null#null，本地歌共享一份缓存）',
    JSON.stringify(lastGenOpts && { base: lastGenOpts.base, bvid: lastGenOpts.bvid }));

  /* B12 本地歌 + AI 没开：把"为什么没词"说清楚 */
  await ev(`(() => {
    DB.settings.aiLyrics.enabled = false;
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    loadLyrics(false);
    return true;
  })()`);
  await sleep(400);
  const locNote = await ev(`((document.querySelector('.le-ai') || {}).textContent) || ''`);
  is(locNote.indexOf('本地歌曲没有 B 站字幕') >= 0,
    'B12 ★ 本地歌没开 AI → 空状态里说明去开 AI 歌词', locNote);
  await ev(`(() => { DB.settings.aiLyrics.enabled = true; DB.settings.aiLyrics.aiGenerate = true; return true; })()`);

  /* B13 小标点开 → 能看到 AI 的回复 / 思考 / 提示词 */
  await ev(`(() => {
    DB.settings.aiLyrics.enabled = true;
    DB.settings.aiLyrics.aiGenerate = true;
    uiMode = 'gen';
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_B)}], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    return true;
  })()`);
  await ev(`loadLyrics(false)`);
  await sleep(700);
  await ev(`document.getElementById('lyricTag').click(); true`);
  await sleep(300);
  const replyOpen = await ev(`(() => ({
    show: document.getElementById('aiReplyMask').classList.contains('show'),
    body: document.getElementById('aiReplyBody').textContent,
    meta: document.getElementById('aiReplyMeta').textContent,
  }))()`);
  is(replyOpen.show && replyOpen.body.indexOf('第一句') >= 0 && replyOpen.meta.indexOf('AI 生成') >= 0,
    'B13 ★ 点小标 → 打开浮层，回复页就是模型原话', replyOpen.body.slice(0, 30));

  await ev(`document.querySelector('#aiReplyMask .rtab[data-rtab="think"]').click(); true`);
  await sleep(200);
  const thinkBody = await ev(`document.getElementById('aiReplyBody').textContent`);
  is(thinkBody.indexOf('Need produce LRC') >= 0, 'B14 ★ 思考过程页能看（推理模型的独白）', thinkBody.slice(0, 30));

  await ev(`document.querySelector('#aiReplyMask .rtab[data-rtab="prompt"]').click(); true`);
  await sleep(200);
  const promptBody = await ev(`document.getElementById('aiReplyBody').textContent`);
  is(promptBody.indexOf('发出去的提示词正文') >= 0, 'B15 ★ 提示词页能看到发出去的那份', promptBody.slice(0, 30));
  await ev(`document.getElementById('btnAiReplyClose').click(); true`);

  /* B16 失败时空状态也给入口 */
  await ev(`(() => { lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; return true; })()`);
  uiMode = 'gen-fail';
  await ev(`loadLyrics(false)`);
  await sleep(600);
  const detailBtn = await ev(`!!document.getElementById('btnLyricAiDetail')`);
  is(detailBtn, 'B16a ★ 失败时空状态里有「看看 AI 到底回了什么」按钮');
  if (detailBtn) {
    await ev(`document.getElementById('btnLyricAiDetail').click(); true`);
    await sleep(300);
    const failPanel = await ev(`(() => ({
      show: document.getElementById('aiReplyMask').classList.contains('show'),
      body: document.getElementById('aiReplyBody').textContent,
    }))()`);
    is(failPanel.show && failPanel.body.indexOf('第一句') >= 0,
      'B16b ★ 失败也能点开看模型原话（这才是最需要看的时候）', failPanel.body.slice(0, 24));
    await ev(`document.getElementById('btnAiReplyClose').click(); true`);
  }
  uiMode = 'gen';

  /* B17 ★ 打开「AI 生成」必须弹窗，取消后开关要弹回去 */
  await ev(`(() => {
    DB.settings.aiLyrics.enabled = true;
    DB.settings.aiLyrics.aiGenerate = false;
    openSettings(); showSettingsTab('lyric');
    return true;
  })()`);
  await sleep(400);
  await ev(`document.getElementById('chkAiGenerate').click(); true`);
  await sleep(400);
  const warn = await ev(`(() => ({
    shown: document.getElementById('promptMask').classList.contains('show'),
    text: (document.getElementById('promptBody') || {}).textContent || '',
  }))()`);
  is(warn.shown && warn.text.indexOf('大概率') >= 0,
    'B17a ★ 打开「AI 生成」会弹窗提醒"大概率对不上"', warn.text.slice(0, 26));
  await ev(`document.getElementById('promptCancel').click(); true`);
  await sleep(300);
  const afterCancel = await ev(`(() => ({
    checked: document.getElementById('chkAiGenerate').checked,
    saved: !!DB.settings.aiLyrics.aiGenerate,
  }))()`);
  is(!afterCancel.checked && !afterCancel.saved,
    'B17b ★ 取消后开关弹回去、设置不变', JSON.stringify(afterCancel));

  // 再点一次并确认 → 真的打开
  await ev(`document.getElementById('chkAiGenerate').click(); true`);
  await sleep(300);
  await ev(`document.getElementById('promptOk').click(); true`);
  await sleep(300);
  const afterOk = await ev(`(() => ({
    checked: document.getElementById('chkAiGenerate').checked,
    saved: !!DB.settings.aiLyrics.aiGenerate,
  }))()`);
  is(afterOk.checked && afterOk.saved, 'B17c 确认后真的打开并写进存档', JSON.stringify(afterOk));
  await ev(`(() => { document.getElementById('modalMask').classList.remove('show'); return true; })()`);

  /* B18 ★ 总开关关掉，但之前整理过 → 用缓存版，且还能切原文 */
  // 先把字幕恢复成"有字幕"（B5 为了测生成，把它换成了"没字幕"的桩）
  ipcMain.removeHandler('bili:subtitle');
  ipcMain.handle('bili:subtitle', () => ({ ok: true, data: { lines: SUB_LINES, videoTitle: '如果的事', lang: '中文' } }));
  await ev(`(() => {
    DB.settings.aiLyrics.enabled = false;          // 总开关关
    DB.settings.aiLyrics.aiPolish = false;
    queue = { tracks: [${JSON.stringify(LYRIC_TRACK_A)}], index: 0, name: '' };
    lyricState.trackKey = ''; lyricState.lines = []; lyricState.failed = false; lyricState.mode = '';
    aiPeekCalls = [];
    loadLyrics(false);
    return true;
  })()`);
  await sleep(600);
  const cached = await ev(`(() => ({
    mode: lyricState.mode,
    fromCache: lyricState.polishFromCache,
    tag: document.getElementById('lyricTag').textContent,
    rawBtn: document.getElementById('btnLyricRaw').classList.contains('show'),
    l1: (document.querySelectorAll('#lyricBox .l')[1] || {}).textContent || '',
  }))()`);
  // peeks 要在测试进程这一侧读（aiPeekCalls 是桩里的变量，渲染层看不到）
  is(cached.mode === 'polish' && cached.fromCache && aiPeekCalls.length === 1,
    'B18a ★ 总开关关着也读了整理缓存（只读缓存，不调 API）',
    JSON.stringify(cached) + ' peeks=' + aiPeekCalls.length);
  is(cached.tag.indexOf('缓存') >= 0, 'B18b 小标标明这是缓存版', cached.tag);
  is(cached.rawBtn && cached.l1 === '',
    'B18c ★ 缓存版默认显示整理版（第 2 行是 AI 合并后留的空串）', JSON.stringify(cached.l1));
  // 再切到原文：那一行应该回到没改过的字幕
  await ev(`document.getElementById('btnLyricRaw').click(); true`);
  await sleep(250);
  const rawAgain = await ev(`document.querySelectorAll('#lyricBox .l')[1].textContent`);
  is(rawAgain === '我以经等了你很久了',
    'B18d ★ 缓存版照样能在原版 / 整理版之间切', rawAgain);

  /* Z 页面报错 */
  is(pageErrors.length === 0, 'Z 全程没有页面报错', pageErrors.join(' | '));

  win.destroy();
}

app.whenReady().then(async () => {
  SRV.listen(0, '127.0.0.1', async () => {
    srvBase = 'http://127.0.0.1:' + SRV.address().port + '/v1';
    try {
      stubIpc();
      await groupA();
      await groupB();
    } catch (e) {
      die(e);
      return;
    }
    say('\n' + (fail === 0 ? '全部通过 ✅' : `有 ${fail} 条没过 ❌`));
    finish(fail === 0 ? 0 : 1);
  });
}).catch(die);
