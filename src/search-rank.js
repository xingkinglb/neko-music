/* ============================================================
   搜索结果本地相关性重排（v2.13.0）
   ------------------------------------------------------------
   为什么需要这一层：
   B 站搜索的 `totalrank` 优化的是**点击率**，不是"这是不是你要的那首歌"。
   于是搜「晴天」，排在最前面的是三小时的周杰伦合集、八分钟的翻唱串烧、
   还有标题里塞满关键词的二创 —— 真正的原曲被压到第十几条。
   这一层在拿到结果之后重排一次，把人要找的那首顶上去。

   ★ 为什么是纯函数、不碰网络也不碰 DOM
     排序规则是这个功能里最容易出错、也最值得反复调的部分。
     抽成纯函数才能单独写测试、单独看每首歌到底得了多少分
     （`rankSearch` 的返回里带 details，调试时直接 console.log 就行）。

   ★ 为什么是"加权打分"而不是"过滤掉不合格的"
     用户真的会去听三小时的合集。所以长视频只是**得分低**，不是被删掉 ——
     它还在列表里，只是排到后面。过滤会让"我就想找那个合集"的人抓狂。

   ★ 四项权重加起来必须正好是 1
     这样 score 天然落在 0~1，调试时一眼能看出"这首歌接近满分"还是"基本不相关"。
     .verify/verify.js 有一条断言守着这个和（改权重忘了改另一处就会红）。
   ============================================================ */

/** 四项权重。★ 改动这里必须让它们和仍然是 1（见文件头）。 */
const W = {
  keyword: 0.5,   // 关键词覆盖率：主信号，最能说明"标题里确实有我要的词"
  duration: 0.2,  // 时长合理性：把三小时合集压下去
  phrase: 0.2,    // 精确短语：整串关键词连着出现，几乎就是原曲
  order: 0.1,     // B 站原始位次：弱先验，只做微调
};

/** 搜索接口给的时长可能是 "12:34" 也可能是秒数，统一成秒 */
function toSeconds(d) {
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? d : 0;
  const s = String(d || '').trim();
  if (!s) return 0;
  // 纯数字（有些接口直接给秒）
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/**
 * 时长合理性打分（0~1）
 *
 *   0~30 秒   0.35   多半是片段 / 切片，不是完整的一首
 *   30~60 秒  0.60   短歌、片头曲
 *   1~10 分钟 1.00   ★ 绝大多数歌曲都在这儿
 *   10~20 分  1→0.5  现场版、串烧、长一点的 DJ 版
 *   20~60 分  0.5→0  合集 / 直播回放
 *   >60 分钟  0      几小时的"100 首合集"
 *
 * ★ 不知道时长给 0.5（中性）而不是 0：搜出来的条目偶尔没有 duration，
 *   直接判 0 等于"没时长的歌全沉底"，那比不排还糟。
 */
function durationScore(sec) {
  if (!sec || sec <= 0) return 0.5;
  if (sec < 30) return 0.35;
  if (sec < 60) return 0.6;
  if (sec <= 600) return 1;
  if (sec <= 1200) return 1 - (sec - 600) / 1200;              // 1 → 0.5
  if (sec <= 3600) return Math.max(0, 0.5 - (sec - 1200) / 4800);  // 0.5 → 0
  return 0;
}

/**
 * 把关键词切成词。
 * ★ 中英文混排：英文按空格切；中文不切（"周杰伦晴天"当一个词，因为
 *   中文没有空格，硬切反而会把"晴天"切成"晴"+"天"，到处误命中）。
 * ★ 标点当分隔符：用户常写成「周杰伦 - 晴天」「晴天/周杰伦」。
 */
function tokenize(kw) {
  return String(kw || '')
    .toLowerCase()
    .split(/[\s,，、|/\\+_.·\-—–()（）[\]【】"'"'']+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 给单条结果打分
 * @param {object} v      B 站返回的一条（title / author / duration / play / pubdate）
 * @param {string[]} kws  切好的关键词
 * @param {string} raw    原样的关键词（判断"精确短语"用）
 * @param {number} idx    它在原始结果里的位次（0 开始）
 */
function scoreOne(v, kws, raw, idx) {
  const title  = String(v.title  || '').toLowerCase();
  const author = String(v.author || '').toLowerCase();
  const lowerRaw = String(raw || '').toLowerCase().trim();

  // ---- 1) 关键词覆盖率 ----
  // 用 |K∩T| / |K|（覆盖率）而不是 Dice 系数：搜「晴天 周杰伦」时，
  // 标题是「周杰伦《晴天》官方MV」的应该满分；Dice 会因为标题更长而扣分。
  const hit = kws.filter((k) => title.includes(k)).length;
  let kwScore = kws.length ? hit / kws.length : 0;

  // ★ 作者名命中也算 —— 搜「某某UP」时，人家的视频标题里当然没有自己的名字。
  //   给 0.85 而不是 1：让"标题精确命中"仍然排在"只是 UP 主的视频"前面。
  if (kws.length) {
    const authorHit = kws.some((k) => author.includes(k)) ||
                      (lowerRaw && author.includes(lowerRaw));
    if (authorHit) kwScore = Math.max(kwScore, 0.85);
  }

  // ---- 2) 时长合理性 ----
  const durScore = durationScore(toSeconds(v.duration));

  // ---- 3) 精确短语 ----
  // 整串关键词连着出现在标题里。这是最强的"就是这首"信号，
  // 但只给 0.2 —— 因为标题里堆关键词的搬运号也满足这一条。
  const phraseScore = lowerRaw && title.includes(lowerRaw) ? 1 : 0;

  // ---- 4) B 站原始位次（弱先验）----
  // 第 1 条给 1，第 30 条给 0。它只在前面三项打平时起作用 ——
  // 但"打平"很常见（同一首歌的几十个搬运），所以这一项不能省。
  const orderScore = Math.max(0, 1 - idx / 30);

  const score =
    W.keyword  * kwScore +
    W.duration * durScore +
    W.phrase   * phraseScore +
    W.order    * orderScore;

  return {
    score,
    // 调试用：哪一项拖了后腿，一眼看得出
    parts: {
      keyword: +kwScore.toFixed(3),
      duration: +durScore.toFixed(3),
      phrase: +phraseScore.toFixed(3),
      order: +orderScore.toFixed(3),
    },
  };
}

/**
 * 重排一次搜索结果。
 *
 * @param {string} keyword 用户输入的原始关键词
 * @param {Array}  list    bilibili.js 已经洗过的结果（title 里的 <em> 已去掉）
 * @returns {Array} 新的数组（不改原数组）
 *
 * ★ 同分时按原始位次升序 —— 也就是"保持 B 站的相对顺序"。
 *   Array.prototype.sort 在现代 V8 里是稳定的，但这里显式带 index 兜底：
 *   以后谁把这段挪进别的运行环境，也不会因为"不稳定排序"让列表每次刷新都乱跳。
 */
function rankSearch(keyword, list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return [];

  const raw = String(keyword || '');
  const kws = tokenize(raw);
  // 关键词全是标点（切完是空数组）→ 没有可判的依据，原样返回
  if (!kws.length) return arr.slice();

  return arr
    .map((v, i) => {
      const r = scoreOne(v, kws, raw, i);
      return { v, i, score: r.score, parts: r.parts };
    })
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => {
      // 把得分挂回去，方便调试；界面不显示它（是个内部字段，不是给用户看的）
      x.v.__rank = +x.score.toFixed(4);
      return x.v;
    });
}

module.exports = { rankSearch, durationScore, tokenize, W };
