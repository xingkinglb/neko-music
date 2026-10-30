/**
 * ============================================================
 *  ai-lyrics.js —— AI 歌词（主进程）
 * ============================================================
 *  用户填一个 OpenAI 兼容的 BaseURL + Key，让大模型帮忙出歌词。两条路：
 *    · polish   —— 有 B 站字幕时**逐句校对**（时间轴用真的，高亮精准）
 *    · generate —— 没字幕时**整段生成**（时间轴是模型估的，界面必须挂"估算"小标）
 *
 *  ★ 为什么整块放主进程，不放渲染层（三条都是硬理由）：
 *    ① 渲染层有 CSP（只放行固定几个源），换 BaseURL 就得改 CSP，不现实
 *    ② **Key 不该经过渲染层** —— 界面只负责显示"有没有配"和掩码，从不持有明文
 *    ③ 超时、错误码、缓存淘汰这些都要一个"活得比页面久"的地方来做
 *
 *  ★ 这个文件**不 import electron 的 app**，目录靠 configure() 注入：
 *    这样离线实测（以及 `node -e` 直接 require）都能跑，不用起一个真窗口。
 *    safeStorage 也是"用到时才去取"，取不到就走明文降级（见下面 Key 那一节）。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ---- 常量：都是"改一个数就会改变行为"的那种，集中放这儿 ----
const KEY_FILE_NAME = 'ai-key.bin';
const CACHE_FILE_NAME = 'ai-lyrics-cache.json';

// 分块大小。80 行 ≈ 2400 字 ≈ 3.6k token，加提示词和输出一次约 8k —— 大多数模型够。
// ★ 定死 80 还有个副作用是好的：块数固定，进度条的分母是确定的。
const CHUNK = 80;

// 缓存上限。一首 60 句约 5 KB，800 首 ≈ 4 MB（和 neko-data.json 一个量级）。
const CACHE_MAX = 800;

// 单块超时。计划书定的是 60 秒（不是 20）：中转站经常排队，20 秒会大面积误杀。
const TIMEOUT_MS = 60000;
// 整首的硬上限。7 块 × 60 秒 = 7 分钟，但用户不该对着屏幕等 7 分钟 ——
// 超过 5 分钟就当失败，退回原字幕（比"永远转圈"强）。
const TOTAL_DEADLINE_MS = 5 * 60 * 1000;

// 联网探测不用等太久：它只是一句"你行不行"，30 秒足够。
const PROBE_TIMEOUT_MS = 30000;

// Key 文件的magic前缀。为什么要它：加密和明文降级**共用一个文件名**，
// 读的时候必须能分辨"这是一段密文"还是"这是一段明文"，否则换台机器会解密出一堆乱码。
const KEY_MAGIC_ENC = 'NEKO-AIKEY-ENC\n';
const KEY_MAGIC_PLAIN = 'NEKO-AIKEY-PLAIN\n';

/* ============================================================
   一、错误：七种 reason（+ 整理专用的 mismatch）
   ============================================================
   界面靠 reason 显示不同文案（见 app.js 的 aiFailText），所以**必须分类**，
   不能所有失败都抛一句"出错了"。`handle()` 会把 reason 原样带到渲染层，
   preload 的 api() 已经会 `e.reason = res.reason` —— 这一层不用改。
   ============================================================ */
// thinking：模型把"思考过程"当正文回了（推理型模型）—— 和"格式解析不出来"是两回事，
// 界面要给出不同的建议（换模型 / 提示词里加一句），所以单独一类。
const REASONS = ['no-config', 'bad-key', 'quota', 'no-model', 'timeout', 'refused', 'bad-format', 'thinking'];

function fail(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

/* ============================================================
   二、配置注入（目录 + 存档读取）
   ============================================================ */
let storeDir = null;
let settingsProvider = () => ({});

/**
 * 由 main.js 在启动时调一次。
 * @param {{dir:string, getSettings?:()=>object}} opts
 *   dir          —— userData 目录（Key 和缓存都放这儿，和存档分开）
 *   getSettings  —— 读存档里的 settings（只读！提示词的写入在渲染层，理由见 setPrompts 的注释）
 */
function configure(opts) {
  const o = opts || {};
  if (o.dir) storeDir = String(o.dir);
  if (typeof o.getSettings === 'function') settingsProvider = o.getSettings;
}

function dirOrThrow() {
  if (!storeDir) throw fail('no-config', 'AI 歌词模块还没配置存储目录');
  return storeDir;
}
const keyPath = () => path.join(dirOrThrow(), KEY_FILE_NAME);
const cachePath = () => path.join(dirOrThrow(), CACHE_FILE_NAME);

/** 存档里的 settings.aiLyrics（永远给一个对象，调用方不用判空） */
function aiSettings() {
  let s = null;
  try { s = settingsProvider(); } catch (_) { s = null; }
  const a = s && s.aiLyrics;
  return (a && typeof a === 'object') ? a : {};
}

/* ============================================================
   三、Key：加密存、只给掩码
   ============================================================
   ★ 用 Electron 的 safeStorage（Windows 底层是 DPAPI，绑当前 Windows 用户）。
     它到底防住了什么，必须说清楚，别让人误以为万无一失：
       把文件拷到别的电脑 / 传网盘 / 发别人   → 解不开 ✅
       同一台电脑上的其他 Windows 用户       → 解不开 ✅
       你自己账户下跑的程序（包括本软件）     → 能解密 ❌（这是必然的，否则软件没法用）
       重装系统 / 换电脑                     → 解不开 ⚠️ 要重填一次
   ★ 降级：safeStorage 不可用时**不静默**，写明文并在设置里明说。
   ============================================================ */

/** 拿到 safeStorage（拿不到就 null）。用到时才 require，是为了让纯 Node 环境也能 require 本模块。 */
function safeStorageOrNull() {
  try {
    // 纯 Node 里 require('electron') 返回的是二进制路径字符串，取不到 safeStorage —— 正好当"不可用"
    const el = require('electron');
    return (el && el.safeStorage) ? el.safeStorage : null;
  } catch (_) {
    return null;
  }
}

/** 本机能不能加密（设置页要显示降级提示） */
function encryptionAvailable() {
  const ss = safeStorageOrNull();
  try { return !!(ss && ss.isEncryptionAvailable()); } catch (_) { return false; }
}

/**
 * 存 Key。传空串 = 删掉这把 Key（不是存一个空文件）。
 * @returns {{encrypted:boolean}}
 */
function setKey(text) {
  const raw = String(text == null ? '' : text).trim()
    // 有人会把 "Bearer sk-xxx" 整串贴进来 —— 我们发请求时自己会加 Bearer，这里先剥掉
    .replace(/^Bearer\s+/i, '');
  const file = keyPath();
  if (!raw) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    return { encrypted: encryptionAvailable() };
  }
  const ss = safeStorageOrNull();
  const canEnc = encryptionAvailable();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (canEnc) {
    const buf = ss.encryptString(raw);   // Buffer，密文
    fs.writeFileSync(file, Buffer.concat([Buffer.from(KEY_MAGIC_ENC, 'utf8'), buf]));
  } else {
    // 降级：明文。文件里带 magic 前缀，读的时候才知道"这段不是密文"。
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from(KEY_MAGIC_PLAIN, 'utf8'),
      Buffer.from(raw, 'utf8'),
    ]));
  }
  return { encrypted: canEnc };
}

/** 读 Key 明文（只在主进程内存里用，**绝不回给渲染层**） */
function getKey() {
  let buf;
  try {
    const file = keyPath();
    if (!fs.existsSync(file)) return '';
    buf = fs.readFileSync(file);
  } catch (_) {
    return '';
  }
  const head = buf.slice(0, KEY_MAGIC_ENC.length).toString('utf8');
  if (head === KEY_MAGIC_ENC) {
    const ss = safeStorageOrNull();
    if (!ss) return '';                       // 换机器 / 没有 safeStorage：解不开，当没配
    try { return ss.decryptString(buf.slice(KEY_MAGIC_ENC.length)); } catch (_) { return ''; }
  }
  const head2 = buf.slice(0, KEY_MAGIC_PLAIN.length).toString('utf8');
  if (head2 === KEY_MAGIC_PLAIN) return buf.slice(KEY_MAGIC_PLAIN.length).toString('utf8');
  // 老文件 / 手写的裸 Key：原样当明文用（不猜，能用就用）
  return buf.toString('utf8').trim();
}

function hasKey() {
  return !!getKey();
}

function clearKey() {
  return setKey('');
}

/**
 * 掩码：`sk-••••••••••••a1b2`。
 * ★ 只有后 4 位 + 固定长度的圆点，**没有任何"看明文"的入口** ——
 *   后 4 位只是让用户确认"填的是哪一把"，不是用来还原的。
 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  const tail = k.slice(-4);
  const head = /^sk-/i.test(k) ? k.slice(0, 3) : '';
  return head + '•'.repeat(12) + tail;
}

/** 给界面看的 Key 状态（**不含明文**） */
function keyInfo() {
  const k = getKey();
  return {
    has: !!k,
    mask: maskKey(k),
    encrypted: encryptionAvailable(),
  };
}

/* ============================================================
   四、HTTP：一处收口，所有请求都走它
   ============================================================
   ★ 中转站（one-api / new-api 这类）号称"兼容 OpenAI"，实际有六个坑，
     这个函数负责兜住其中四个（另外两个在解析和提示词那边）：
       ① 错误包在 200 里（返回 {error:{...}}）→ 先看 data.error
       ② content 不是字符串（新版返回数组）→ 三种形状都兼容
       ③ 慢 → 超时 60 秒
       ④ 模型名是自定义别名 → 不写死默认模型（这一条在界面）
   ============================================================ */

/** 把用户填的 BaseURL 规范化：补协议、去尾斜杠、只填域名时补 /v1 */
function apiBase(baseURL) {
  let u = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!u) throw fail('no-config', 'AI 歌词没配置 —— 去设置里填 BaseURL 和 Key');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed = null;
  try { parsed = new URL(u); } catch (_) {
    throw fail('no-config', 'BaseURL 格式不对 —— 要像 https://api.openai.com/v1 这样');
  }
  // 只填了域名（path 是空或 "/"）时补 /v1：OpenAI 兼容服务的接口都在 /v1 下面。
  // 不补的话 /chat/completions 会 404，而界面会显示成"模型不存在"，用户根本查不出来。
  if (parsed.pathname === '' || parsed.pathname === '/') u = u + '/v1';
  return u.replace(/\/+$/, '');
}

/** 从返回体里挖出文本（字符串 / 数组 / 老式 choice.text 三种都兼容）
 *  ★ 这里**只取正文**。曾经有一版在正文为空时回落到 reasoning_content，
 *    结果推理型模型的"内心独白"被当成歌词整段渲染出来（实测踩过）。
 *    reasoning_content 只在 chat() 里用来判断"这是不是推理型模型"，绝不进解析。 */
function pickContent(data) {
  const ch = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
  if (!ch) return '';
  const msg = ch.message || ch.delta || {};
  let c = msg.content;
  if (Array.isArray(c)) {
    c = c.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
  }
  if (typeof c !== 'string' || !c) {
    c = (typeof ch.text === 'string') ? ch.text : '';   // 老的 /completions 形状
  }
  return c;
}

/** 模型的思考过程（推理型模型才有）。**只用来诊断，绝不当正文** */
function pickReasoning(data) {
  const ch = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
  const msg = (ch && (ch.message || ch.delta)) || {};
  const v = msg.reasoning_content || msg.reasoning || '';
  return typeof v === 'string' ? v : '';
}

/** 状态码 / 错误文案 → 七种 reason 之一 */
function reasonOfStatus(code, message) {
  const c = Number(code);
  const s = String(message || '');
  if (c === 401 || c === 403) return 'bad-key';
  if (c === 402 || c === 429) return 'quota';
  if (c === 404) return 'no-model';
  if (c === 408 || c === 504) return 'timeout';
  // ★ 有些中转站把"余额不足 / 被限流"塞在 200 的错误体里，code 是字符串 —— 按文案再兜一次
  if (/余额|欠费|quota|insufficient|rate.?limit|too many requests/i.test(s)) return 'quota';
  if (/invalid.*(api.?key|token)|unauthorized|认证失败|密钥无效|no permission/i.test(s)) return 'bad-key';
  if (/model.*(not|does not|不存在|not found)/i.test(s)) return 'no-model';
  if (c >= 500) return 'timeout';    // 服务端挂了 → 对用户来说和"连不上"是一回事
  return 'bad-format';
}

/** 把 status / 错误文案拼成人话（界面直接显示这句） */
function messageOfStatus(reason, code, detail, model) {
  const tail = detail ? '（' + String(detail).slice(0, 120) + '）' : '';
  // ★ 中转站会把错误包在 200 里，这时 code 是 200 —— 不能照着念"AI 返回 200"，
  //   要显示 reason 对应的标准码，用户才看得懂是哪一类错。
  const c = Number(code);
  const shown = (c >= 400 && c < 600) ? c
    : reason === 'quota' ? 429
    : reason === 'bad-key' ? 401
    : reason === 'no-model' ? 404 : 0;
  switch (reason) {
    case 'bad-key':  return 'AI 拒绝了这把 Key（' + shown + '）：Key 无效或没权限' + tail;
    case 'quota':    return 'AI 返回 ' + shown + '：额度用完了或被限流，等会儿再试' + tail;
    case 'no-model': return '找不到模型「' + (model || '') + '」—— 去设置里重新拉一次列表';
    case 'timeout':  return '连不上 AI 服务（超时 ' + Math.round(TIMEOUT_MS / 1000) + ' 秒）—— 检查 BaseURL 或网络' + tail;
    default:         return 'AI 返回的内容解析不出来（不是歌词格式）' + tail;
  }
}

/**
 * 发一次 chat/completions。
 * @returns {Promise<{text:string, data:object, raw:string}>}
 */
async function chat(opts) {
  const o = opts || {};
  const key = String(o.key || '').trim();
  const model = String(o.model || '').trim();
  const base = apiBase(o.baseURL);
  if (!key) throw fail('no-config', 'AI 歌词没配置 —— 去设置里填 BaseURL 和 Key');
  if (!model) throw fail('no-model', '还没选模型 —— 去设置里拉一次列表，或者手填一个');

  const timeout = Math.max(1000, Math.min(o.timeoutMs || TIMEOUT_MS, TOTAL_DEADLINE_MS));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res = null;
  let raw = '';
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(o.prompt || '') }],
        // 歌词校对要稳，不要"创意"。温度低一点，改写幅度会小很多。
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.2,
        stream: false,
        // ★ 刻意**不发** response_format: {type:'json_object'}：
        //   中转站大多不支持，发了会直接 400；靠提示词约束 + 容错解析更稳。
        max_tokens: o.maxTokens || 4000,
      }),
      signal: ctrl.signal,
    });
    raw = await res.text();
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
      throw fail('timeout', messageOfStatus('timeout', 0, '', model));
    }
    throw fail('timeout', '连不上 AI 服务 —— 检查 BaseURL 或网络（' + ((err && err.message) || '') + '）');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = JSON.parse(raw); } catch (_) { data = null; }

  // ★ 坑①：中转站会把错误包在 **200** 里（`{error:{...}}`）。先看它，别当成功处理。
  const wrapped = data && data.error;
  if (wrapped || !res.ok) {
    const code = (wrapped && (wrapped.code || wrapped.status || wrapped.type)) || res.status;
    const detail = (wrapped && (wrapped.message || wrapped.msg)) || (data ? '' : raw.slice(0, 200));
    // ★ 有些模型的输出上限比我们要的小（老模型 4096），给多了直接 400。
    //   **对半降**再试，最多降 4 次（128000 → 64000 → … → 8000）——
    //   一上来砸到 4000 的话，用户明明设了 64k 也白设了。
    const asked = Number(o.maxTokens) || 0;
    if (Number(code) === 400 && (o._tokenTry || 0) < 4 && asked > 4000 &&
        /max_?tokens|max_completion_tokens|too\s*large|exceed|超出/i.test(String(detail))) {
      return chat(Object.assign({}, o, {
        maxTokens: Math.max(4000, Math.floor(asked / 2)),
        _tokenTry: (o._tokenTry || 0) + 1,
      }));
    }
    const reason = reasonOfStatus(code, detail);
    throw fail(reason, messageOfStatus(reason, code, detail, model));
  }
  if (!data) throw fail('bad-format', 'AI 返回的不是 JSON（可能被中转站换成了网页）');

  // ★★ 这里**不再**因为"正文为空"就抛错：推理型模型的答案有可能落在 reasoning_content 里
  //   （尤其是我们要求它把答案包进 <lrc>/<json> 标签之后 —— 标签块在思考里也能捞回来）。
  //   到底算不算失败，交给调用方 pickAnswer() 判断。
  const ch = Array.isArray(data.choices) ? data.choices[0] : null;
  return {
    text: pickContent(data),
    reasoning: pickReasoning(data),
    finish: (ch && ch.finish_reason) || '',
    data, raw,
  };
}

/**
 * 取 `<tag>…</tag>` 里的内容（**取最后一个**）。
 * ★ 为什么取最后一个：提示词里给了示例，推理过程里也可能"预演"一遍答案 ——
 *   真正给用户的那一份总在最后。
 * ★ 为什么要标签：推理型模型会把思考写进正文，而且**带时间戳**（实测见过整屏英文独白
 *   每行都有 `[00:00.00]`），"只认时间戳"的解析器根本分辨不出哪句是歌词。
 *   有了标签就变成"只看最后那个块"，思考写在标签外面完全无所谓 —— 而且这是纯提示词层面的
 *   办法，不依赖任何厂商私有参数（reasoning_effort / enable_thinking 各家都不一样，瞎发会 400）。
 */
function extractTagged(text, tag) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'gi');
  let last = '';
  let m;
  while ((m = re.exec(s)) !== null) last = m[1];
  return last.trim();
}

/**
 * 从一次返回里取出"真正的答案"。
 *   ① 正文里有标签块 → 用块（最理想：推理型模型也能用）
 *   ② 正文没有、思考里有 → 也捞出来（模型把答案写进思考里了，能救就救）
 *   ③ 都没有 → 退回正文原文（老行为，靠后面的解析和 looksLikeThinking 兜）
 * @returns {{body:string, tagged:boolean}}
 */
function pickAnswer(r, tag) {
  const fromMain = extractTagged(r && r.text, tag);
  if (fromMain) return { body: fromMain, tagged: true };
  const fromThink = extractTagged(r && r.reasoning, tag);
  if (fromThink) return { body: fromThink, tagged: true };
  return { body: String((r && r.text) || ''), tagged: false };
}

/** GET /models —— 拉不到就返回空数组，界面允许手填（不报错，这是设计） */
async function listModels(opts) {
  const o = opts || {};
  const base = apiBase(o.baseURL);
  const key = String(o.key || '').trim();
  if (!key) throw fail('no-config', 'AI 歌词没配置 —— 去设置里填 BaseURL 和 Key');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  let res = null;
  let raw = '';
  try {
    res = await fetch(base + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    raw = await res.text();
  } catch (err) {
    throw fail('timeout', '连不上 AI 服务 —— 检查 BaseURL 或网络（' + ((err && err.message) || '') + '）');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = JSON.parse(raw); } catch (_) { data = null; }
  const wrapped = data && data.error;
  if (wrapped || !res.ok) {
    const code = (wrapped && (wrapped.code || wrapped.status)) || res.status;
    const detail = (wrapped && wrapped.message) || '';
    const reason = reasonOfStatus(code, detail);
    throw fail(reason, messageOfStatus(reason, code, detail, o.model));
  }
  // 两种形状都兼容：OpenAI 是 {data:[{id}]}，有的站直接给数组
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  return arr
    .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || ''))
    .filter(Boolean);
}

/**
 * 测试连接：发一个"只回一个字"的极短请求。
 * ★ 为什么不只 GET /models：那只验证了 Key 能过网关，**模型能不能用、能不能真的对话**都没验。
 *   花 1 个 token 换一个"确实能用"的结论，值。
 */
async function testConnection(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const r = await chat({
    baseURL: o.baseURL, key: o.key, model: o.model,
    prompt: '请只回复两个字：可用',
    maxTokens: 16,
    timeoutMs: 30000,
  });
  return {
    ok: true,
    reply: String(r.text || '').trim().slice(0, 40),
    ms: Date.now() - t0,
    model: o.model,
  };
}

/* ============================================================
   五、联网探测（四态）
   ============================================================
   ★ 为什么必须"探测"而不是"读一个开关"：AI 能不能联网取决于**模型和服务商**，
     不是统一能力。gpt-4o-mini / deepseek-chat 这类普通模型压根不能联网；
     只有 gpt-4o-search-preview、Perplexity sonar 这类搜索型模型才自带。
     用户填哪个我们事先不知道，只能问一句试试。
   ★ 为什么**不**问"今天几号"：模型能从训练数据里蒙对，会把"不能联网"误判成"能联网"。
   ============================================================ */
const PROBE_PROMPT =
  '请联网搜索今天的科技新闻，列出 3 条，每条附上来源网址。' +
  '如果你无法联网搜索，请直接回复「无法联网」。';

/** 返回体里有没有"硬证据"（搜索型模型才会带的字段） */
function hasSearchEvidence(data) {
  if (!data) return false;
  const ch = Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = (ch && (ch.message || ch.delta)) || {};
  const spots = [data, msg, ch].filter(Boolean);
  for (const o of spots) {
    for (const f of ['citations', 'annotations', 'sources', 'search_results', 'references']) {
      const v = o[f];
      if (Array.isArray(v) && v.length) return true;
      if (typeof v === 'string' && v.trim()) return true;
    }
  }
  return false;
}

/**
 * 探测联网能力。
 * @returns {Promise<{level:'yes'|'no'|'maybe'|'unknown', evidence:string}>}
 *   yes     = 有 citations / annotations 这类硬证据（搜索型模型）
 *   no      = 它自己说"无法联网"
 *   maybe   = 文本里 ≥ 2 个 URL（可能是它编的，所以不敢算"支持"）
 *   unknown = 其他
 */
async function testWebSearch(opts) {
  const o = opts || {};
  const r = await chat({
    baseURL: o.baseURL, key: o.key, model: o.model,
    prompt: PROBE_PROMPT,
    maxTokens: 400,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const text = String(r.text || '');
  if (hasSearchEvidence(r.data)) return { level: 'yes', evidence: '返回里带 citations / annotations 这类引用字段' };
  if (/无法联网|不能联网|无法访问(实时|互联网|网络)|没有联网|不能访问实时|无法搜索|can(not|'t) (access|browse)/i.test(text)) {
    return { level: 'no', evidence: '模型自己说不能联网' };
  }
  const urls = text.match(/https?:\/\/[^\s)」】"'<>]+/g) || [];
  if (urls.length >= 2) return { level: 'maybe', evidence: '回复里有 ' + urls.length + ' 个网址（但可能是它编的）' };
  return { level: 'unknown', evidence: '看不出它到底联没联网' };
}

/* ============================================================
   六、歌名提取（保守）
   ============================================================
   B 站标题长这样：`【真栗】《如果的事》如果我已经不能控制每天想栗亿次…`
   整串丢给模型，它可能把「真栗」当歌手、去回忆别人的歌。
   ★ 拿不准就**退回原始标题** —— 提取失败绝不能变成"不调 AI"。
   ★ 不传 UP 主（拍板 #9）：UP 主经常是搬运工 / 翻唱者 / "XX音乐台"，
     写进去只会让模型误以为那是歌手，反而搜错。
   ============================================================ */
const VERSION_WORDS = /(官方|高清|完整版|翻唱|伴奏|纯音乐|现场|live|MV|PV|AMV|4K|1080P|无损|高音质|合集|重制|字幕版)/i;

function guessSongName(title) {
  const origin = String(title == null ? '' : title).trim();
  if (!origin) return '';
  let s = origin;

  // ⓪ 先去掉开头的序号（本地歌最常见："14. A零距离 - 银河与星斗_AAC"、"01 - 晴天"）
  s = s.replace(/^\s*\d{1,3}\s*[.、)）:：]\s*/, '').trim() || origin;

  // ① 书名号里就是歌名（最常见）
  const book = s.match(/《([^》]{1,80})》/);
  if (book && book[1].trim()) {
    s = book[1].trim();
  } else {
    // ② 没有书名号 → 看「A - B」两半该怎么取
    //   「歌手 - 歌名」取后半（周杰伦 - 晴天）
    //   「歌名 - 说明」取前半（晴天 - 官方MV），判据是后半带"版本词"
    const parts = s.split(/\s+[-—–－]\s+/);
    if (parts.length > 1) {
      const left = parts[0].trim();
      const right = parts.slice(1).join(' - ').trim();
      if (right && VERSION_WORDS.test(right)) s = left || right;
      else if (right) s = right;
    }
  }

  // ③ 统一收拾：去掉开头的【…】、结尾的（翻唱）/（纯音乐）这类括号后缀、
  //    以及本地歌常见的编码后缀（_AAC / _320K / -FLAC …）
  s = s.replace(/^【[^】]*】\s*/, '')
       .replace(/[（(]\s*(翻唱|纯音乐|伴奏|cover|Cover|MV|官方|高音质|完整版)[^）)]*[）)]\s*$/g, '')
       .replace(/[_\-\s](AAC|FLAC|MP3|WAV|M4A|OGG|OPUS|APE|320K|256K|128K|HQ|SQ|无损)$/i, '')
       .trim();

  return s || origin;   // 收拾完变空了 → 退回原始标题
}

/* ============================================================
   七、默认提示词
   ============================================================
   ★ 默认值**只在主进程**这一份（界面只负责显示和编辑），
     存储用 settings.aiLyrics.promptPolish / promptGenerate：
       字段不存在 / 空串 = 用默认（跟着代码升级走）
       用户改过 = 存他的版本（"恢复默认"就是把字段清空，不是存一个空字符串）
   ============================================================ */

const DEFAULT_PROMPT_POLISH = `你是一名歌词校对员。下面是一首歌的 B 站自动字幕（语音识别生成），
里面可能有错别字、同音字错误、断句错误、重复词、以及「嗯 / 啊 / 那个」这类口水话。

视频标题：{title}
（这只是一个 B 站视频标题，可能带 UP 主名、书名号、装饰符号，请自行判断真正的歌名）

【最重要的规则】
输出必须是一个 JSON 字符串数组，长度**必须正好是 {n}**，第 i 个元素对应输入的第 i 行。
· 不需要改的行，**原样照抄**，一个字都不要动。
· 某行只有口水话，或者它的内容被并到上一行了 → 输出空字符串 ""。
· 断句错误的相邻两行可以**合并到前一行**，后一行输出 ""（这样时间轴还能对上）。
· 不允许新增行、删除行、改变顺序。

【可以改什么】
· 明显的错别字、同音字（"在见"→"再见"、"以经"→"已经"、"的/得/地"用错）
· 标点：补句末标点、合并重复标点
· 纯口水话（"嗯""啊""那个""就是说"）
· 无意义的重复（"我我我"→"我"）

【不要做什么】
· 不要润色、不要改写、不要"创作更美的句子" —— 原文哪怕不通顺，只要不是明显错字就保留
· 不要翻译（中文保持中文、英文保持英文、日文保持日文）
· 不要加标题、歌手名、时间戳、序号、括号注释
· 不要输出 markdown 代码块，不要任何解释文字

【示例】
输入（3 行）：["嗯嗯", "我以经等了你很久了", "你你你怎么才来"]
输出：["", "我已经等了你很久了", "你怎么才来"]
（第 1 行纯口水话 → ""；第 2 行"以经"→"已经"；第 3 行去重复）

【输出位置 —— 这条对推理型模型尤其重要】
把最终结果放进 <json> 和 </json> 之间。标签外面写什么都不看 ——
如果你习惯先思考，那就先想，想完再把答案写进标签里：
<json>
["第一行", "", "第三行"]
</json>

现在校对下面这 {n} 行（JSON 数组）：
{lines}`;

const DEFAULT_PROMPT_GENERATE = `你是歌词整理助手。请给出下面这首歌的歌词，用 LRC 格式。

视频标题：{title}
（这只是一个 B 站视频标题，可能带 UP 主名、书名号，也可能带「翻唱」「纯音乐」「合集」
  这类字样 —— 请自行判断真正的歌名，以及它是不是翻唱 / 纯音乐）
视频时长：{duration} 秒

【输出格式】
1. 一句一行，格式为 [分:秒.百分秒]歌词，例如：
   [00:12.40]第一句歌词
   [00:16.85]第二句歌词
2. 时间戳必须**严格递增**，且都落在 0 到 {duration} 之间。
3. 不要输出 [ti:] [ar:] [al:] 这类元数据行。
4. 只输出 LRC 文本本身 —— 不要解释、不要 markdown 代码块、不要序号。

【时间戳怎么分】
· 前奏一般占开头的 5%~10%，尾奏留最后 5%~10%，中间才是歌词
· 中文歌一句大约 3~6 秒，按这个把整首铺开
· 宁可估粗一点，也不要让 50 句挤在开头 30 秒里

【如果不知道】
· 不确定这首歌的歌词时，**宁可少写也不要编造**。编出来的假歌词用户分辨不出来，比没有更糟。
· 完全不知道、或者判断它是纯音乐 / 无人声，就只输出这一行：
  [00:00.00]（纯音乐）

【输出位置 —— 这条对推理型模型尤其重要】
把最终的 LRC 放进 <lrc> 和 </lrc> 之间。标签外面写什么都不看 ——
如果你习惯先思考，那就先想，想完再把答案写进标签里：
<lrc>
[00:12.40]第一句歌词
</lrc>

现在请给出这首歌的 LRC 歌词：`;

// 被截断时用的"精简版"：把长规则和示例全砍掉，只留"改错字 + 行数不变 + 别思考"。
// ★ 为什么有用：推理型模型的思考量跟提示词复杂度强相关 —— 规则越多、示例越长，
//   它越想越多（实测 52 行、8160 token 全花在思考上）。砍短之后思考量明显下降。
const LEAN_PROMPT_POLISH = `你是歌词校对员。下面是 {n} 行歌词（JSON 数组），可能有错别字和断句错误。
只改明显的错别字，不改行数、不合并、不新增、不润色；拿不准就原样照抄。
输出长度正好 {n} 的 JSON 字符串数组，放在 <json></json> 里。不要输出任何思考过程。
{lines}`;

// 联网时自动拼在用户提示词前面的那段（不改用户自己写的内容）
const WEB_SEARCH_PREFIX =
  '【先联网搜索】请先联网搜索这首歌的歌词原文，再按下面的要求整理输出。\n' +
  '如果搜不到可靠来源，就按"不知道"处理 —— 不要凭记忆编造。\n\n';

/** 占位符替换。★ 只替换认识的键，别的一律原样留着（提示词里可能有别的花括号） */
function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(title|n|lines|duration)\}/g, (m, k) => {
    const v = vars[k];
    return v == null ? m : String(v);
  });
}

/** 当前生效的两条提示词（自定义优先，空串=用默认） */
function getPrompts() {
  const a = aiSettings();
  const p = (typeof a.promptPolish === 'string' && a.promptPolish.trim()) ? a.promptPolish : '';
  const g = (typeof a.promptGenerate === 'string' && a.promptGenerate.trim()) ? a.promptGenerate : '';
  return {
    // defaultText 是给"恢复默认"用的：界面要知道默认长什么样，
    // 但它不该自己存一份（存两份迟早对不上，代码升级默认提示词时界面还是旧的）
    polish:   { text: p || DEFAULT_PROMPT_POLISH, isDefault: !p, defaultText: DEFAULT_PROMPT_POLISH },
    generate: { text: g || DEFAULT_PROMPT_GENERATE, isDefault: !g, defaultText: DEFAULT_PROMPT_GENERATE },
  };
}

/** 校验自定义提示词：缺了关键占位符就不许保存（否则 AI 不知道是哪首歌，白花钱） */
function validatePrompt(kind, text) {
  const s = String(text == null ? '' : text);
  if (kind === 'generate') {
    if (!s.includes('{duration}')) return { ok: false, need: '{duration}' };
  } else if (!s.includes('{lines}')) {
    return { ok: false, need: '{lines}' };
  }
  return { ok: true, need: '' };
}

/* ============================================================
   八、容错解析
   ============================================================ */

/** 剥掉 ```json 包裹（模型很爱加，加了 JSON.parse 就废） */
function stripFence(text) {
  return String(text == null ? '' : text)
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
}

/** 给 bad-format 的报错带上模型原文的开头（界面直接显示），下次再失败一眼能看出它回了什么 */
function withPreview(message, raw) {
  const head = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return head ? message + ' —— 它的开头是「' + head + '」' : message;
}

/** 数组元素归一成字符串。★ 模型偶尔不给纯字符串，给 {"text":"..."} 这种 —— String() 会变 [object Object] */
function coerceItem(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    for (const k of ['text', 'lyric', 'content', 'line', 'sentence', 'original', 'corrected']) {
      if (typeof v[k] === 'string') return v[k];
    }
    const vals = Object.values(v).filter((x) => typeof x === 'string');
    if (vals.length === 1) return vals[0];
  }
  return String(v);
}

/**
 * 解析"字符串数组"。容错到不能再容错（这些全是真实模型的姿势）：
 *   剥 ``` 包裹 → 抓第一个 `[` 到最后一个 `]` → JSON.parse → 失败再试"去尾逗号"
 *   → 外面还包了一层对象（{"lyrics":[...]}）→ 抠出第一个"字符串数组"值
 *   → 元素是 {"text":"..."} 对象 → 抠出里面的字符串
 * ★ 刻意不用 response_format:json_object（中转站大多不支持）。
 */
function parseJsonArray(text) {
  const s = stripFence(text);
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) throw fail('bad-format', 'AI 返回的内容解析不出来（不是歌词格式）');
  const slice = s.slice(a, b + 1);
  // JSON.parse 失败的常见原因：尾逗号（模型爱写 ["a", "b",]）
  const tries = [slice, slice.replace(/,\s*\]/g, ']')];
  let parsed = null;
  for (const t of tries) {
    try { parsed = JSON.parse(t); break; } catch (_) { /* 继续试下一种 */ }
  }
  // 外面还包了一层对象：{"lyrics":[...]} / {"result":[...]} / {"data":[...]}
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    for (const k of ['lines', 'lyrics', 'lyric', 'result', 'data', 'output', 'corrected', 'songs']) {
      if (Array.isArray(parsed[k])) { parsed = parsed[k]; break; }
    }
    if (!Array.isArray(parsed)) {
      const firstArr = Object.values(parsed).find((v) => Array.isArray(v));
      if (firstArr) parsed = firstArr;
    }
  }
  if (Array.isArray(parsed)) return parsed.map(coerceItem);
  throw fail('bad-format', 'AI 返回的内容解析不出来（不是歌词格式）');
}

/**
 * 解析 LRC → [{t, text}]
 * ★ 三条规矩：
 *   ① `[ti:] [ar:] [al:] [by:] [offset:]` 这类元数据行**丢掉**（LRC 标准里有，模型爱加，
 *      不丢的话会被当成一句歌词渲染出来）
 *   ② 时间戳必须单调递增 → 排一次序（模型偶尔会把两句写反）
 *   ③ 超出时长的一律裁掉（模型估时间轴时经常给到歌外面去）
 */
function parseLrc(text, duration) {
  const src = String(text == null ? '' : text).replace(/```[a-zA-Z]*/g, '');
  const rows = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,4}))?\]/g;
  for (const line of src.split(/\r?\n/)) {
    // 元数据行：`[ti:xxx]` 这种冒号后面不是数字的，直接跳过
    if (/^\s*\[(ti|ar|al|by|offset|re|ve|length)\s*:/i.test(line)) continue;
    stamp.lastIndex = 0;
    const times = [];
    let m;
    while ((m = stamp.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const fracRaw = m[3] || '';
      // 小数位：1 位 = 十分之一秒，2 位 = 百分之一秒，3 位 = 毫秒
      const frac = fracRaw ? Number(fracRaw) / Math.pow(10, fracRaw.length) : 0;
      const t = min * 60 + sec + frac;
      if (isFinite(t) && t >= 0) times.push(t);
    }
    if (!times.length) continue;
    const body = line.replace(stamp, '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    for (const t of times) rows.push({ t, text: body });
  }

  const lim = Number(duration);
  const kept = rows.filter((r) => (!isFinite(lim) || lim <= 0) ? true : r.t <= lim + 1);
  kept.sort((x, y) => x.t - y.t);
  return kept;
}

/** 这一行是不是"纯音乐"标记（生成模式的兜底返回值） */
function isInstrumentalMark(text) {
  const s = String(text == null ? '' : text).trim();
  return /^[（(【\[]?\s*纯音乐\s*[）)】\]]?$/.test(s);
}

/** 模型拒答的样子：空的，或者一句"我不能提供歌词（版权）" */
function looksRefused(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return true;
  if (s.length > 300) return false;
  return /(不能|无法|不会|抱歉|对不起).{0,12}(提供|给出|生成|帮).{0,12}(歌词|内容|版权)|版权|copyright|I (can't|cannot|am unable to|won't)/i.test(s);
}

/**
 * 这段文字是不是模型的"思考过程"（而不是歌词）。
 *
 * ★ 为什么需要它：推理型模型（或者被中转站换成的推理模型）会把内心独白写进正文 ——
 *   实测遇到过整屏英文：「Need produce LRC. We need accurate lyrics… Could output（纯音乐）…
 *   must not fabricate…」。它**还带着 `[00:00.00]` 前缀**，所以"只认时间戳"的解析器会照单全收，
 *   于是用户看到一大段英文被当成歌词逐句高亮。
 *
 * ★ 判据故意写得很窄（只认"讨论任务本身"的话），阈值 ≥2 条：
 *   普通英文歌词里出现 "I need you" 很正常，绝不能因此误判成思考过程。
 */
const THINK_PATTERNS = [
  /the instruction/i, /instruction says/i, /must not fabricate/i, /could output/i,
  /need (produce|output)/i, /we (need|should|must) (to )?(output|produce|decide|find)/i,
  /the user (wants|asked)/i, /用户想要/, /提示词(里|说|要求)/, /不能编造/, /应该输出/,
];

function looksLikeThinking(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  let hits = 0;
  for (const re of THINK_PATTERNS) {
    if (re.test(s)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * 拿不到答案时统一报"思考过程"。
 * ★ 文案要**可操作**：告诉用户"再点一次多半就好"（推理模型偶尔就是不写标签），
 *   以及"一直不行就加一句提示词"——而不是甩一句"失败了"。
 */
function thinkingError(r, tag) {
  const truncated = !!(r && r.finish === 'length');
  const head = truncated
    ? 'AI 想太久被截断了（输出额度用完，正文一个字都没剩）—— 这是推理型模型最容易踩的坑。'
    : 'AI 只回了「思考过程」，正文是空的 —— 它把答案写在思考里了，或者根本没写完。';
  const advice = '建议换一个不思考的模型（gpt-4o-mini / deepseek-chat / qwen-plus 这类），' +
    '或者在提示词末尾加一句「不要思考，直接输出 <' + tag + '> 标签里的内容」。';
  return fail('thinking', withPreview(head + advice, (r && (r.text || r.reasoning)) || ''));
}

/**
 * 从思考过程里捞歌词（最后的兜底）。
 * 有些推理模型会把"我想输出的是……"连同完整的 LRC 一起写在思考里，正文却是空的。
 * ★ 门槛：至少 3 行带时间戳，且不能只是把提示词里的示例念一遍（那样等于没有）。
 */
function salvageFromReasoning(reasoning, duration) {
  const src = String(reasoning || '');
  if (!src.trim()) return null;
  // ★ 这里不能直接用 parseLrc：思考里的时间戳经常夹在句子中间
  //   （"Let me draft: [00:05.00]如果的事"），parseLrc 会把前面的英文一起当歌词。
  //   所以只取**最后一个时间戳之后**的文字。
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,4}))?\]/g;
  const rows = [];
  for (const line of src.split(/\r?\n/)) {
    stamp.lastIndex = 0;
    let m, lastAt = -1, lastT = 0;
    while ((m = stamp.exec(line)) !== null) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lastT = Number(m[1]) * 60 + Number(m[2]) + frac;
      lastAt = stamp.lastIndex;
    }
    if (lastAt < 0) continue;
    const body = line.slice(lastAt).replace(/^[\s:：\-—>»]+/, '').trim();
    if (body) rows.push({ t: lastT, text: body });
  }
  const lim = Number(duration);
  const kept = rows.filter((r) => (!isFinite(lim) || lim <= 0) ? true : r.t <= lim + 1);
  kept.sort((a, b) => a.t - b.t);
  if (kept.length < 3) return null;
  // 别把提示词里的示例当成答案（只有"第一句歌词 / 第一行"这种）
  const echo = kept.every((r) => /^(第一句歌词|第二句歌词|第一行|第三行|第一句|第二句)$/.test(r.text));
  return echo ? null : kept;
}

/* ============================================================
   八点五、调试快照：把"发出去的提示词 + 模型原话 + 思考过程"留一份
   ============================================================
   ★ 为什么要这个：用户看到"这歌词不对"时，唯一能判断的依据就是模型到底说了什么。
     界面上那个「AI 生成」小标点开就是这三样东西（回复 / 思考 / 提示词）。
   ★ 只放内存、只留最近 30 条 —— 不落盘：里面可能有整首歌词，没必要写进硬盘。
     重启后就没有了，界面会照实说"这份来自缓存 / 已不在内存里"。
   ============================================================ */
const debugMap = new Map();

function rememberDebug(key, info) {
  if (!key) return;
  debugMap.set(key, Object.assign({ at: Date.now() }, info || {}));
  while (debugMap.size > 30) {
    const first = debugMap.keys().next();
    if (first.done) break;
    debugMap.delete(first.value);
  }
}

/** 取某一首歌的调试快照（没有就 null） */
function getDebug(key) {
  return debugMap.get(String(key || '')) || null;
}

/* ============================================================
   九、整理（polish）
   ============================================================
   ★ 核心约束：**输出行数必须和输入一模一样**。
     为什么不让它自由合并断句：一旦 3 句合成 1 句，时间轴就没法对了 ——
     要么猜一个，要么整段偏移。宁可保守（逐句改字），也不要"看起来更漂亮但对不上时间"。
     断句错了怎么办？允许"并到上一行、本行留空串"—— 行数不乱，时间轴还能对上。
   ============================================================ */

/** 整理一块（≤80 行），返回等长数组 */
async function polishChunk(o) {
  const chunk = o.chunk;
  const tpl = o.lean ? LEAN_PROMPT_POLISH : (o.prompt || DEFAULT_PROMPT_POLISH);
  const prompt = fill(tpl, {
    // ★ 发出去的是**猜出来的歌名**（计划书 §3.0）：整串标题里有 UP 主名 / 书名号 / 序号 / 编码后缀，
    //   直接丢给模型它可能把「真栗」「A零距离」当歌手去回忆别人的歌。
    //   猜错也不致命 —— 提示词里那句"请自行判断真正的歌名"就是留给它的第二次机会。
    title: guessSongName(o.title) || o.title,
    n: chunk.length,
    lines: JSON.stringify(chunk, null, 0),
  });
  // 精简版不带联网前缀（它已经把话说到最少了）
  const sent = (o.webSearch && !o.lean) ? WEB_SEARCH_PREFIX + prompt : prompt;

  // ★★ 和"生成"那条路一样要给预算阶梯：推理型模型会先花几千 token 想，
  //   实测 54 行 / 52 行的字幕，模型把 6240 / 8160 个 token 全花在思考上
  //   （completion_thinking_tokens 正好等于 max_tokens），正文一个字都没剩。
  //   所以：起步预算给宽，被截断就换精简提示词 + 加预算再来一次；
  //   如果这一块本来就长（> 24 行），干脆**折半**分别送 —— 行数少，它想得也少。
  // 用户在设置里指定了"输出上限"就照他说的来（0 = 自动）
  let budget = o.maxTokens || o.budget || Math.min(32000, 6000 + chunk.length * 100);
  let r = null;
  let ans = null;
  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let sentFor = sent;
    if (attempt > 0) {
      // 重试换成精简提示词（长规则 + 示例会让推理模型想更多）
      const leanPrompt = fill(LEAN_PROMPT_POLISH, {
        title: guessSongName(o.title) || o.title,
        n: chunk.length,
        lines: JSON.stringify(chunk, null, 0),
      });
      sentFor = '直接输出最终答案，不要输出任何思考过程。\n\n' + leanPrompt;
    }
    r = await chat({
      baseURL: o.baseURL, key: o.key, model: o.model,
      prompt: sentFor,
      timeoutMs: o.timeoutMs,
      maxTokens: budget,
    });
    // ★ 先留快照再解析：解析失败时界面也能看到模型原话（失败正是最需要看的时候）
    rememberDebug(o.debugKey, {
      mode: 'polish', model: o.model, chunk: o.chunkNo, attempt: attempt + 1,
      prompt: sentFor, content: r.text, raw: r.raw, reasoning: r.reasoning, finish: r.finish,
    });
    // ★ 先按 <json> 标签取答案（推理型模型把思考写在标签外面就完全不影响）；
    //   正文没有标签块就去思考里找（模型把答案写进思考里也能救回来）。
    ans = pickAnswer(r, 'json');
    text = ans.body;
    if (!String(text).trim() && r.finish === 'length' && attempt === 0) {
      // ① 长块：折半分别送（行数少 → 模型想得少），这是最有效的一招
      if (!o.lean && chunk.length > 24) {
        const mid = Math.ceil(chunk.length / 2);
        const base = Object.assign({}, o, { lean: true });
        const a = await polishChunk(Object.assign({}, base, { chunk: chunk.slice(0, mid), chunkNo: (o.chunkNo || 1) + '.1' }));
        const b = await polishChunk(Object.assign({}, base, { chunk: chunk.slice(mid), chunkNo: (o.chunkNo || 1) + '.2' }));
        return a.concat(b);
      }
      // ② 短块（或已经是精简版）：加预算 + 精简提示词再来一次
      budget = Math.min(128000, budget * 2);
      continue;
    }
    break;
  }
  if (!String(text).trim()) {
    if (String(r.reasoning || '').trim()) throw thinkingError(r, 'json');
    throw fail('refused', 'AI 拒绝生成这首的歌词（可能是版权原因）');
  }
  if (looksRefused(text)) throw fail('refused', 'AI 拒绝生成这首的歌词（可能是版权原因）');
  // 没有标签块时才看"是不是思考过程"—— 有标签块就说明它按格式给了答案
  if (!ans.tagged && looksLikeThinking(text)) throw thinkingError(r, 'json');
  let arr;
  try {
    arr = parseJsonArray(text);
  } catch (e) {
    // 兜底：有的模型不听"回 JSON 数组"的话，回的是一行一句。行数正好对上就收
    // （和"合并留空串"同一条契约 —— 行数不乱，时间轴就能对上）；
    // 对不上就照常报错，并带上模型原文的开头（界面能直接看出它回了什么）。
    const lines = String(text).split(/\r?\n/)
      .map((l) => l.replace(/^\s*\d+\s*[.、)）:：]\s*/, '').replace(/^[-*]\s+/, '').trim())
      .filter(Boolean);
    if (lines.length !== chunk.length) throw fail('bad-format', withPreview(e.message, r.raw || text));
    arr = lines;
  }
  if (arr.length !== chunk.length) {
    // ★ 不抛 bad-format：这是"AI 自作主张"，不是"解析不出来"。
    //   界面据此显示「AI 改动太大，已保留原字幕」，比"格式错误"准确得多。
    throw fail('mismatch', 'AI 改动太大（返回 ' + arr.length + ' 行，原字幕 ' + chunk.length + ' 行），已保留原字幕');
  }
  return arr;
}

/**
 * 逐句校对整首字幕。
 * @param {object} o { baseURL, key, model, title, lines, onProgress, prompt, webSearch, key(cacheKey) }
 * @returns {Promise<Array<{t:number,text:string}>>} 时间轴用**原来的**，文字用 AI 的
 */
async function polishLyrics(o) {
  const opts = o || {};
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  if (!lines.length) throw fail('bad-format', '没有可整理的字幕');
  const texts = lines.map((l) => String((l && l.text) == null ? '' : l.text));

  const chunks = [];
  for (let i = 0; i < texts.length; i += CHUNK) chunks.push(texts.slice(i, i + CHUNK));

  const started = Date.now();
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    // 整首的硬上限：7 块 × 60 秒会拖到 7 分钟，用户早就换歌了
    const left = TOTAL_DEADLINE_MS - (Date.now() - started);
    if (left <= 1000) throw fail('timeout', 'AI 整理超时（整首超过 5 分钟）—— 已保留原字幕');
    // 进度用"第几块"（从 1 开始）：界面要显示的是「正在整理 3/7 段」，不是「已完成 2」
    if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, chunks.length);
    // ★ 任何一块失败 → 整首失败（由界面退回原字幕）。
    //   绝不"半块成功半块失败"：那样时间轴和文字会错位，比没有 AI 更糟。
    const arr = await polishChunk({
      baseURL: opts.baseURL, key: opts.key, model: opts.model,
      title: guessSongName(opts.title) || opts.title, chunk: chunks[i],
      prompt: opts.prompt, webSearch: opts.webSearch,
      // ★ 用户在设置里设的"输出上限"要一路传下去（漏了这一步，设了也白设）
      maxTokens: opts.maxTokens || 0,
      timeoutMs: Math.min(TIMEOUT_MS, left),
      debugKey: cacheKeyFor(opts, 'polish'), chunkNo: i + 1,
    });
    for (const t of arr) out.push(t);
  }

  // 行数在每一块里都校验过了，这里一定等长；仍然兜一道，防将来改坏
  if (out.length !== lines.length) throw fail('mismatch', 'AI 改动太大，已保留原字幕');
  return lines.map((l, i) => ({ t: l.t, text: out[i] }));
}

/* ============================================================
   十、生成（generate）
   ============================================================ */
/**
 * 没字幕时整段生成。
 * @returns {Promise<{instrumental:boolean, lines:Array<{t,text}>}>}
 *   纯音乐 → { instrumental: true, lines: [] }（界面走"没歌词"空状态，不是显示一行"（纯音乐）"）
 */
async function generateLyrics(o) {
  const opts = o || {};
  const tpl = opts.prompt || DEFAULT_PROMPT_GENERATE;
  const duration = Number(opts.duration) > 0 ? Math.round(Number(opts.duration)) : 0;
  const prompt = fill(tpl, {
    title: guessSongName(opts.title) || opts.title,   // 同上：先做一次保守的歌名提取
    duration: duration || 240,   // 拿不到时长就给一个中位数，别把 0 写进提示词
  });
  // ★ 输出预算给足：推理型模型会先花掉几千 token 想，4000 经常"想完就没额度了"（正文为空 +
  //   finish_reason=length）。给 8000 起步；真被截断了再翻倍重试一次。
  //   给太多会被老模型 400 拒（它上限 4096），chat() 里会自动降到 4000 再试。
  let budget = opts.maxTokens || 12000;
  let lastR = null;
  const promptOf = (n) => {
    const base = opts.webSearch ? WEB_SEARCH_PREFIX + prompt : prompt;
    // 第二次重试时明确说"别想了，直接给答案"：加预算只解决"额度不够"，
    // 有些模型是"想得太多"，得靠这句话把它拽回来（Qwen3 那类还认 /no_think，但不通用，就不硬塞了）
    return n === 0 ? base : '直接输出最终答案，不要输出任何思考过程。\n\n' + base;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({
      baseURL: opts.baseURL, key: opts.key, model: opts.model,
      prompt: promptOf(attempt),
      timeoutMs: Math.min(TIMEOUT_MS, TOTAL_DEADLINE_MS),
      maxTokens: budget,
    });
    lastR = r;
    // 失败时界面也要能看到模型原话（"这歌词是编的"这种事，只有看原话才能判断）
    rememberDebug(cacheKeyFor(opts, 'gen'), {
      mode: 'gen', model: opts.model, attempt: attempt + 1,
      prompt: promptOf(attempt), content: r.text, raw: r.raw, reasoning: r.reasoning, finish: r.finish,
    });

    // ★ 只要它把答案写进 <lrc> 标签，标签外面写多少思考都不影响
    const ans = pickAnswer(r, 'lrc');
    const text = ans.body;

    // 被截断 → 加预算再来一次（推理模型最常见的一种"失败"）
    if (r.finish === 'length' && attempt === 0) {
      budget = Math.min(128000, budget * 2);
      continue;
    }

    if (!String(text).trim()) {
      // 正文空的两种可能：① 全花在思考上被截断 ② 答案写进了思考里
      //   ② 的话能从思考里把带时间戳的歌词捞出来 —— 捞到了就用，别让用户白等一次
      const salvaged = salvageFromReasoning(r.reasoning, duration);
      if (salvaged) return { instrumental: false, lines: salvaged, fromReasoning: true };
      if (String(r.reasoning || '').trim()) throw thinkingError(r, 'lrc');
      throw fail('refused', 'AI 拒绝生成这首的歌词（可能是版权原因）');
    }
    if (looksRefused(text)) throw fail('refused', 'AI 拒绝生成这首的歌词（可能是版权原因）');
    // 没标签块时才看"是不是思考过程"（它也可能带 `[00:00.00]` 前缀，解析器分辨不出来）
    if (!ans.tagged && looksLikeThinking(text)) {
      const salvaged = salvageFromReasoning(r.reasoning, duration);
      if (salvaged) return { instrumental: false, lines: salvaged, fromReasoning: true };
      throw thinkingError(r, 'lrc');
    }

    const rows = parseLrc(stripFence(text), duration);
    if (!rows.length) {
      // ★ 报错带上模型原文的开头：解析失败时用户（和我）能直接看出它到底回了什么形状，
      //   不用再来回猜是"加了废话"还是"完全没写时间戳"
      throw fail('bad-format', withPreview('AI 返回的内容解析不出来（不是歌词格式）', r.raw || text));
    }
    // 纯音乐：模型被要求"不知道就只输出 [00:00.00]（纯音乐）"
    if (rows.length === 1 && isInstrumentalMark(rows[0].text)) {
      return { instrumental: true, lines: [] };
    }
    return { instrumental: false, lines: rows };
  }
  // 两轮都截断
  throw thinkingError(lastR, 'lrc');
}

/* ============================================================
   十一、缓存
   ============================================================
   一首 60 句约 5 KB，800 首 ≈ 4 MB。上限 800 条，超了按 at 淘汰最旧的。
   key 带 mode：同一首歌"整理"和"生成"分开存，互不覆盖。
   ★ 单独一个文件（不进 neko-data.json）：那个文件已经 6MB 了，
     歌词缓存是"可以随时删掉重来"的东西，不该和歌单混在一起。
   ============================================================ */
let cacheMemo = null;   // 内存里留一份，省得每次读盘

function cacheLoad() {
  if (cacheMemo) return cacheMemo;
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const obj = JSON.parse(raw);
    cacheMemo = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (_) {
    cacheMemo = {};   // 文件不在 / 坏了 → 当空缓存（坏文件下次写的时候自然被顶掉）
  }
  return cacheMemo;
}

function cacheFlush() {
  const file = cachePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cacheMemo || {}), 'utf8');
  } catch (err) {
    // 缓存写不进去不该影响"歌词已经拿到了"这件事 —— 只记一笔，不抛
    console.error('[ai-lyrics] 缓存写入失败：', err.message);
  }
}

/** 缓存 key：`BV1xx#123|polish` */
function cacheKeyOf(bvid, cid, mode) {
  return String(bvid || '') + '#' + (cid == null ? '' : cid) + '|' + mode;
}

/**
 * 从请求参数里解析缓存 key。
 * ★ 本地歌曲没有 bvid/cid（都是 null），直接拿它们拼会得到 `#|gen` ——
 *   **所有本地歌共享同一份缓存**，A 歌的歌词会出现在 B 歌上。
 *   所以渲染层会传一个 `base`（B 站歌 = `BVx#cid`，本地歌 = `l:` + 完整路径），
 *   有 base 就用 base，没有才回落到 bvid/cid 的拼法。
 */
function cacheKeyFor(opts, mode) {
  const o = opts || {};
  return o.base ? String(o.base) + '|' + mode : cacheKeyOf(o.bvid, o.cid, mode);
}

function cacheGet(key) {
  const c = cacheLoad();
  const e = c[key];
  if (!e || !Array.isArray(e.lines)) return null;
  return e;
}

/** 写一条，顺手裁一次（超 800 条按 at 淘汰最旧的） */
function cachePut(key, mode, lines) {
  const c = cacheLoad();
  c[key] = { at: Date.now(), mode, lines: Array.isArray(lines) ? lines : [] };
  const keys = Object.keys(c);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => (Number(c[a] && c[a].at) || 0) - (Number(c[b] && c[b].at) || 0));
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
  }
  cacheFlush();
}

/**
 * 清缓存。三种给法：
 *   `BV1x#123|polish` → 只清这一条
 *   `BV1x#123`        → 这首的**整理 + 生成**一起清（「重新获取」就是这么调的：
 *                        点的时候还不知道这次会走哪条路，两条都清掉才不会读到旧结果）
 *   不给              → 全清
 * ★ 「重新获取」必须先清这一首：否则用户嫌这次生成得不好、再点一次，
 *   读的还是同一份缓存 —— 点了等于没点。
 */
function clearCache(key) {
  const c = cacheLoad();
  if (key) {
    const k = String(key);
    if (k.indexOf('|') >= 0) {
      delete c[k];
    } else {
      for (const kk of Object.keys(c)) {
        if (kk === k || kk.indexOf(k + '|') === 0) delete c[kk];
      }
    }
  } else {
    for (const k of Object.keys(c)) delete c[k];
  }
  cacheFlush();
  return true;
}

function cacheStats() {
  const c = cacheLoad();
  let bytes = 0;
  try { bytes = fs.statSync(cachePath()).size; } catch (_) { bytes = 0; }
  return { count: Object.keys(c).length, bytes, max: CACHE_MAX };
}

/* ============================================================
   十二、对外：带缓存的两条路（main.js 的 IPC 直接调这两个）
   ============================================================ */
async function polishCached(o) {
  const opts = o || {};
  const ck = cacheKeyFor(opts, 'polish');
  const hit = cacheGet(ck);
  if (hit) return { lines: hit.lines, mode: 'polish', fromCache: true, key: ck, debug: getDebug(ck) };
  try {
    const out = await polishLyrics(Object.assign({}, opts, { key: getKey() }));
    cachePut(ck, 'polish', out);
    return { lines: out, mode: 'polish', fromCache: false, key: ck, debug: getDebug(ck) };
  } catch (err) {
    // ★ 失败也把快照带出去：界面上"查看 AI 原始回复"就是靠它
    err.debug = getDebug(ck);
    throw err;
  }
}

async function generateCached(o) {
  const opts = o || {};
  const ck = cacheKeyFor(opts, 'gen');
  const hit = cacheGet(ck);
  if (hit) return { lines: hit.lines, mode: 'gen', fromCache: true, key: ck, instrumental: false, debug: getDebug(ck) };
  try {
    const out = await generateLyrics(Object.assign({}, opts, { key: getKey() }));
    // ★ 纯音乐不写缓存：它是"没有歌词"，写进去只会占一条位置，
    //   而且用户下次换了判断（比如模型升级了）也还是读到同一个"没有"。
    if (!out.instrumental) cachePut(ck, 'gen', out.lines);
    return {
      lines: out.lines, mode: 'gen', fromCache: false, key: ck,
      instrumental: out.instrumental, fromReasoning: !!out.fromReasoning, debug: getDebug(ck),
    };
  } catch (err) {
    err.debug = getDebug(ck);
    throw err;
  }
}

module.exports = {
  // 配置
  configure,
  // Key
  keyInfo, setKey, getKey, hasKey, clearKey, maskKey, encryptionAvailable,
  // 网络
  listModels, testConnection, testWebSearch,
  // 两条路
  polishLyrics, generateLyrics, polishCached, generateCached,
  // 提示词
  getPrompts, validatePrompt, fill, DEFAULT_PROMPT_POLISH, DEFAULT_PROMPT_GENERATE, WEB_SEARCH_PREFIX,
  // 缓存
  cacheStats, clearCache, cacheKeyOf, cacheKeyFor, cacheGet, cachePut, getDebug,
  // 纯函数（给离线实测用）
  guessSongName, parseLrc, parseJsonArray, stripFence, apiBase, pickContent, pickReasoning,
  reasonOfStatus, isInstrumentalMark, looksRefused, looksLikeThinking,
  extractTagged, pickAnswer, salvageFromReasoning,
  // 常量
  REASONS, CHUNK, CACHE_MAX, TIMEOUT_MS,
};
