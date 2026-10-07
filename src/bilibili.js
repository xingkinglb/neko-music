/**
 * ============================================================
 *  bilibili.js —— 和 B 站服务器对话的"翻译官"
 * ============================================================
 *  这个文件只干一件事：把 B 站那些复杂的接口包装成简单的函数。
 *  比如你想知道一个视频的信息，只要调用 getVideoInfo('BV号') 就行。
 *
 *  ⚠️ 这个文件运行在 Electron 的"主进程"里（有 Node.js 权限），
 *     所以它可以随便发网络请求，不受浏览器的跨域限制。
 * ============================================================
 */

const https = require('https');
const crypto = require('crypto');

// ============================================================
//  第 1 部分：伪装成浏览器
// ============================================================
//  B 站只愿意跟"真正的浏览器"说话。如果我们不伪装，它就会把我们
//  踢出去（返回一个风控页面）。所以需要这两个道具：

// ① User-Agent：告诉 B 站"我是 Chrome 浏览器"
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ② Cookie：buvid3 相当于浏览器的"身份证号"。
//    没有它，搜索接口会拒绝我们。这里用一张固定的身份证
//    （实测：固定的反而比每次新申请的更不容易被风控）。
const BUVID3 = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890infoc';
let BASE_COOKIE = `buvid3=${BUVID3}; b_nut=1700000000; buvid4=${BUVID3}`;

/**
 * 让用户填自己的 B 站登录 Cookie（就是其中的 SESSDATA）。
 * 登录用户几乎不会被限流，搜索和收藏夹都会稳定很多。
 * 不填也能用，只是偶尔会撞上风控。
 */
function setUserCookie(cookieText) {
  const t = String(cookieText || '').trim();
  if (!t) return;

  // 情况 1：标准写法，里面明确带着 SESSDATA=xxx（可能还粘了别的字段）
  const sess = t.match(/SESSDATA=([^;\s]+)/);
  if (sess) {
    BASE_COOKIE = `buvid3=${BUVID3}; b_nut=1700000000; SESSDATA=${sess[1]}`;
    return;
  }

  // 情况 2：用户从浏览器开发者工具的「Cookie Value」那一列复制，
  //         粘过来的只是 SESSDATA 的"值"，前面没有 SESSDATA= 这段。
  //         这种情况如果原样拼上去，看起来像填了 Cookie，其实等于没填 ——
  //         请求照样是匿名，字幕永远拿不到。所以这里主动当成 SESSDATA 处理。
  //         特征：整段里没有分号、也没有等号的百分号编码串。
  if (!/=/.test(t)) {
    BASE_COOKIE = `buvid3=${BUVID3}; b_nut=1700000000; SESSDATA=${t}`;
    return;
  }

  // 情况 3：其他情况（贴了一堆字段但没有 SESSDATA），原样附加
  BASE_COOKIE = `${BASE_COOKIE}; ${t}`;
}

// 音频流必须带着这个 Referer 才能下载（B 站的防盗链机制）
const REFERER = 'https://www.bilibili.com';

// ============================================================
//  第 2 部分：wbi 签名（看不懂没关系，照抄就能用）
// ============================================================
//  B 站为了防止别人乱调接口，要求请求带上一个"签名"。
//  签名的算法是：把参数排序 + 拼接 + 用一张固定的乱序表搅乱 + MD5。
//  下面这张表是写死的，不用理解它的含义。

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 57, 37, 45, 10, 31, 25, 4,
  54, 60, 49, 58, 1, 52, 20, 19, 50, 29, 28, 6, 56, 27, 17, 62,
  48, 24, 59, 5, 34, 14, 62, 61, 35, 30, 11, 42, 43, 21, 12, 38,
  55, 39, 33, 3, 44, 13, 40, 22, 9, 16, 51, 57, 63, 26, 7, 36,
];

// 签名用的两把"钥匙"，每天会变，所以启动时先去 B 站要一次，然后缓存起来
let cachedWbiKeys = null;

async function getWbiKeys() {
  if (cachedWbiKeys) return cachedWbiKeys; // 已经要过了，直接用

  // ⚠️ 注意：这个接口在未登录时会返回 code = -101，但数据里照样有我们要的钥匙。
  //    所以这里不能走 requestJSON（它会把 code≠0 当成失败），得手动解析。
  await throttle();
  const res = await httpRequest('https://api.bilibili.com/x/web-interface/nav');
  const nav = JSON.parse(res.body);

  // 钥匙藏在两张图片的文件名里（去掉路径和后缀）
  const pick = (url) => url.split('/').pop().split('.')[0];
  cachedWbiKeys = {
    img: pick(nav.data.wbi_img.img_url),
    sub: pick(nav.data.wbi_img.sub_url),
  };
  return cachedWbiKeys;
}

// 给参数计算签名，返回拼好的查询字符串（xxx=1&yyy=2&w_rid=签名）
async function signParams(params) {
  const { img, sub } = await getWbiKeys();
  // 把两把钥匙拼起来（共 80 个字符），再按乱序表抽出 32 个
  const raw = img + sub;
  const mixinKey = MIXIN_KEY_ENC_TAB.slice(0, 32).map((i) => raw[i]).join('');

  // 加上时间戳（B 站用它判断请求是否过期）
  const all = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
  const keys = Object.keys(all).sort(); // 参数名按字母排序，顺序错了签名就错

  const query = keys
    .map((k) => {
      // B 站要求去掉这几个特殊符号
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

// ============================================================
//  第 3 部分：发请求的底层工具（带节流 + 自动重试）
// ============================================================
//  B 站很敏感：如果你疯狂发请求，它会临时把你拉黑（返回 HTML 风控页）。
//  所以每次请求之间至少间隔 350 毫秒。

let lastRequestAt = 0;
const MIN_INTERVAL = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const gap = Date.now() - lastRequestAt;
  if (gap < MIN_INTERVAL) await sleep(MIN_INTERVAL - gap);
  lastRequestAt = Date.now();
}

/**
 * 最底层的请求函数。返回 { status, body, headers }
 * @param {string} url      完整网址
 * @param {object} options  可选：{ headers, method, timeout }
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: REFERER,
          Cookie: BASE_COOKIE,
          Accept: 'application/json, text/plain, */*',
          ...(options.headers || {}),
        },
        timeout: options.timeout || 15000,
      },
      (res) => {
        // 只取响应头就够了的情况（比如只看跳转地址）
        if (options.headersOnly) {
          resolve({ status: res.statusCode, headers: res.headers, body: '' });
          res.destroy();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 请求一个返回 JSON 的接口。
 * 自动处理节流、风控重试，失败时抛出中文错误。
 */
async function requestJSON(url, options = {}) {
  await throttle();
  let lastErr = null;

  // 最多试 3 次（被限流时重试往往就好了）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpRequest(url, options);
      // 风控时会返回一段 HTML 而不是 JSON
      if (!res.body || res.body.trim().startsWith('<')) {
        throw new Error('被 B 站风控了（返回了网页而不是数据）');
      }
      const json = JSON.parse(res.body);

      // B 站偶尔会返回"正常但没数据"的响应，里面只有一个 v_voucher 字段，
      // 这其实也是风控的一种（要求你过验证码）。识别出来，当作失败处理。
      if (json.data && Object.keys(json.data).length === 1 && json.data.v_voucher !== undefined) {
        const e = new Error('被 B 站临时限流了（要求验证），稍后再试');
        e.retryable = true;
        throw e;
      }

      if (json.code !== 0) {
        // -101 未登录 / -412 请求太频繁 / -509 请求超限 —— 都属于限流
        const limited = [-101, -412, -509].includes(json.code);
        const e = new Error(`B 站返回错误 ${json.code}：${json.message}`);
        e.retryable = limited;   // 限流类的错误，等一会儿重试往往就好了
        throw e;
      }
      return json;
    } catch (err) {
      lastErr = err;
      // 被限流就多等一会儿（1.2 秒、2.4 秒、3.6 秒）
      await sleep(err.retryable ? 1200 * attempt : 600 * attempt);
    }
  }
  throw lastErr;
}

// ============================================================
//  第 4 部分：解析用户输入
// ============================================================
//  用户可能粘贴各种奇怪的东西：完整链接、短链接、纯 BV 号、av 号……
//  这个函数把它们统一整理成 { bvid, page }

/**
 * 把用户粘贴的内容解析成视频信息
 * @returns {Promise<{bvid:string, page:number}|null>}
 */
async function parseUserInput(text) {
  if (!text) return null;
  let s = String(text).trim();

  // 情况一：b23.tv 短链接 —— 需要访问一次拿到真实地址
  if (/b23\.tv/i.test(s)) {
    const match = s.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/i);
    if (match) {
      try {
        const res = await httpRequest(match[0], { headersOnly: true });
        if (res.headers && res.headers.location) s = res.headers.location;
      } catch (e) {
        /* 短链解析失败就当普通文本处理 */
      }
    }
  }

  // 情况二：BV 号（以 BV 开头的 10~12 位字母数字）
  const bvMatch = s.match(/(BV[0-9A-Za-z]{10})/);
  let bvid = bvMatch ? bvMatch[1] : null;

  // 情况三：av 号（纯数字，或 av123456 形式）
  if (!bvid) {
    const avMatch = s.match(/av(\d+)/i) || (s.startsWith('http') ? null : s.match(/^(\d{1,15})$/));
    if (avMatch) bvid = await convertAidToBvid(avMatch[1]);
  }

  if (!bvid) return null;

  // 提取分 P 号：链接里的 ?p=2
  const pageMatch = s.match(/[?&]p=(\d+)/);
  const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;

  return { bvid, page };
}

// av 号 → BV 号
async function convertAidToBvid(aid) {
  const json = await requestJSON(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`);
  return json.data.bvid;
}

// ============================================================
//  第 5 部分：对外提供的功能函数
// ============================================================

/**
 * 把图片地址统一成 https。
 *
 * 为什么要这一步：B 站的图片 CDN 两种协议都支持，但搜索接口、收藏夹接口
 * 经常返回 http:// 开头的地址。而我们的页面开了内容安全策略（CSP），
 * 只允许加载 https 的图片 —— 结果就是封面全变成破图，控制台里刷满
 * "Refused to load the image"。
 *
 * 这里统一转成 https，封面就能正常显示了。
 */
function toHttps(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;   // //i0.hdslb.com/xxx 这种省略协议的
  return s.replace(/^http:\/\//i, 'https://');   // http:// → https://
}

/**
 * 获取视频详情：标题、UP 主、封面、分 P 列表、所属合集
 *
 * 带一个 60 秒的短缓存：同一首歌反复点「词」时不必每次都打B 站，
 * 既快又不会被当成刷接口而限流（限流后会返回乱码字幕，很难察觉）。
 */
const videoInfoCache = new Map();
const VIDEO_INFO_TTL = 60 * 1000;

async function getVideoInfo(bvid) {
  const hit = videoInfoCache.get(bvid);
  if (hit && Date.now() - hit.at < VIDEO_INFO_TTL) return hit.info;

  const json = await requestJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const d = json.data;

  // 把分 P 整理成统一的"曲目"格式
  const pages = (d.pages || []).map((p) => ({
    bvid: d.bvid,
    cid: p.cid,
    page: p.page,
    title: p.part || d.title,
    duration: p.duration,
  }));

  // 合集（一个 UP 主把相关视频打包成的系列）
  // B 站很贴心：合集的所有集数直接就藏在视频详情里，不用再单独请求
  let season = null;
  if (d.ugc_season && d.ugc_season.id) {
    const episodes = [];
    (d.ugc_season.sections || []).forEach((sec) => {
      (sec.episodes || []).forEach((ep) => {
        episodes.push({
          bvid: ep.bvid,
          cid: ep.cid,
          page: ep.page || 1,
          title: ep.title,
          duration: ep.arc ? ep.arc.duration : 0,
        });
      });
    });
    season = {
      id: d.ugc_season.id,
      title: d.ugc_season.title,
      cover: toHttps(d.ugc_season.cover),
      episodes,
    };
  }

  const info = {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    cover: toHttps(d.pic),
    owner: { mid: d.owner.mid, name: d.owner.name },
    duration: d.duration,
    pages,
    season,
  };
  videoInfoCache.set(bvid, { at: Date.now(), info });
  return info;
}

/**
 * 搜索视频
 * @param {string} keyword 关键词
 * @param {number} page    页码，从 1 开始
 */
async function searchVideos(keyword, page = 1) {
  const base = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
  const query = await signParams({ search_type: 'video', keyword, page, page_size: 30 });
  const json = await requestJSON(`${base}?${query}`);

  const list = (json.data.result || []).map((v) => ({
    bvid: v.bvid,
    // 搜索结果的标题里 B 站会插入 <em> 高亮标签，清理掉
    title: String(v.title || '').replace(/<\/?em[^>]*>/g, ''),
    author: v.author,
    cover: toHttps(v.pic),
    duration: v.duration,
    play: v.play,
    pubdate: v.pubdate,
  }));
  return { list, numPages: json.data.numPages || 1 };
}

/**
 * 获取某个视频（某一 P）的音频流地址
 * B 站的视频和音频是分开存放的，我们只要声音那一半，
 * 这样既省流量又能秒开。
 */
async function getAudioUrl(bvid, cid) {
  const url =
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}` +
    `&fnval=16&fnver=0&fourk=1`; // fnval=16 = 我要 DASH 格式（音视频分离）
  const json = await requestJSON(url);
  const d = json.data;

  if (!d || !d.dash || !d.dash.audio || !d.dash.audio.length) {
    throw new Error('这个视频没有可用的音频流（可能是会员专属或版权限制）');
  }

  // 音质列表里选 id 最大的那个（数字越大音质越好）
  const best = d.dash.audio.slice().sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  return {
    url: best.baseUrl || best.base_url,
    quality: best.id,
    duration: d.duration || d.dash.duration,
    // 备用地址：主地址挂了还能顶上
    backup: (d.dash.audio[0].backup_url || []).slice(0, 2),
  };
}

/**
 * 列出某个 UP 主的所有公开收藏夹
 */
async function getFavFolders(mid) {
  const json = await requestJSON(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`
  );
  const list = (json.data && json.data.list) || [];
  return list.map((f) => ({
    id: f.id,
    title: f.title,
    count: f.media_count,
    cover: toHttps(f.cover),
  }));
}

/**
 * 读取收藏夹里的视频
 * @param {number} mediaId 收藏夹 id
 * @param {number} pn      页码
 */
async function getFavMedias(mediaId, pn = 1) {
  const json = await requestJSON(
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${pn}&ps=30&platform=web`
  );
  const medias = (json.data && json.data.medias) || [];
  return {
    list: medias.map((m) => ({
      bvid: m.bvid,
      title: m.title,
      cover: toHttps(m.cover),
      duration: m.duration,
      page: 1,
    })),
    hasMore: !!json.data.has_more,
  };
}

// ============================================================
//  第 6 部分：字幕（拿来做滚动歌词）
// ============================================================
//  链路一共三步，跟B 站自己的播放器完全一致：
//    ① /x/player/v2  → 这个视频有哪些字幕轨道（中文、AI 中文、英文……）
//    ② 挑一条中文轨道（优先真人字幕，其次 B 站自动生成的 AI 字幕）
//    ③ 下载那条字幕的 JSON，里面是一句一句的 {from, to, content}
//
//  ⚠️ 三个必须知道的坑（都是实测踩出来的，别删）：
//    1) **不登录基本拿不到**。匿名请求 /x/player/v2 返回的字幕列表是空的。
//       所以没填 Cookie 时我们会提前返回"没登录"，不去白跑一趟请求。
//    2) **cid 才是唯一依据，bvid 形同虚设**。把 A 的 bvid 和 B 的 cid 拼一起请求，
//       接口照样返回 code 0，还给出 B 的字幕，不报任何错。所以必须自己核对 cid。
//    3) **被限流时它会给你一份"别的视频"的字幕**，而不是报错。
//       实测连着快速请求几次，同一个 cid 会随机返回 1 条 / 6 条 / 0 条轨道，
//       内容是"今天我们要飞1500km""可以保护别人啊"这类完全无关的文本。
//       → 所以：a) 结果要缓存，别反复打 B 站；b) 内容要做乱码检测。

/** 用户有没有填 Cookie —— 决定能不能取字幕 */
function hasLoginCookie() {
  return /SESSDATA=/.test(BASE_COOKIE);
}

/**
 * 已取到的字幕缓存（只存在内存里，不进存档）。
 * 存在的原因很实际：B 站被连续快速请求时会给回**别的视频**的字幕（见坑 3），
 * 而用户往往会手快地连点几下「词」。缓存住第一次的正确结果，
 * 一来二次点击秒回，二来不再给 B 站刷接口的机会。
 */
const subtitleCache = new Map();
const SUBTITLE_TTL = 10 * 60 * 1000;   // 10 分钟，够用且不会占多少内存

/** 取字幕最多试几次（被限流时重试是唯一有效的办法，见 fetchSubtitleOnce 的注释） */
const SUBTITLE_ATTEMPTS = 4;

/**
 * 取某个视频（某一 P）的字幕，返回逐句歌词
 *
 * ⚠️ 这里必须自己核对 cid，因为 /x/player/v2 这个接口**只认 cid，
 *    完全无视传进去的 bvid**。
 *    实测：把 A 视频的 bvid 和 B 视频的 cid 拼在一起请求，
 *    接口照样返回 code 0，还老老实实返回了 **B 视频**的字幕，不报任何错。
 *    所以只要 cid 是旧的/串了，界面就会显示另一首歌的词，
 *    而且看起来"加载成功"，非常难发现。
 *    → 因此这里不信调用方传来的 cid，一律以bvid 现场查出来的为准。
 *
 * @param {string} bvid 视频号
 * @param {number} [cid] 期望的 cid；不给或对不上会自动纠正
 * @returns {Promise<{lines: Array<{t:number, text:string}>}>}
 * @throws  {Error} 带 reason 字段，用来区分失败原因（界面据此给不同提示）
 *   reason: 'no-cookie' | 'limit' | 'none' | 'network' | 'mismatch'
 */
async function getSubtitle(bvid, cid) {
  // 没登录就别试了 —— 直接告诉界面"先去填 Cookie"，省一次被限流的机会
  if (!hasLoginCookie()) {
    const e = new Error('还没填 B 站 Cookie，拿不到字幕');
    e.reason = 'no-cookie';
    throw e;
  }

  // 命中缓存直接返回，别再打 B 站（理由见subtitleCache 的注释）
  const ck = bvid + ':' + (cid || '');
  const cached = subtitleCache.get(ck);
  if (cached && Date.now() - cached.at < SUBTITLE_TTL) return cached.data;

  // ② 真正去取。**必须重试**：B 站被限流时不报错，而是返回一堆"诱饵"字幕
  //    （实测见过"珍妮古道尔讲环保""很多父母和孩子沟通像驯化动物"，
  //    甚至给不同视频返回同一份"♪ 音乐 ♪"占位字幕）。
  //    这些诱饵每次都不一样，所以重试几次总会撞到真的那份。
  let lastErr = null;
  for (let attempt = 1; attempt <= SUBTITLE_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(900 * attempt);   // 1.8s / 2.7s / 3.6s 逐次加长
    try {
      const data = await fetchSubtitleOnce(bvid, cid);
      const now = Date.now();
      subtitleCache.set(ck, { at: now, data });
      return data;
    } catch (err) {
      lastErr = err;
      // 'none'（0 轨道）也要重试 —— 实测被限流时就会返回"没有字幕"，
      // 而真的没字幕的视频重试几次仍然是 0 轨道，两边都能靠重试区分开：
      //   ·中途某次拿到了 → 说明之前是限流，用这份
      //   ·试完仍然 0 轨道 → 那就是真没字幕，报none 是诚实的
      if (err.reason !== 'limit' && err.reason !== 'decoy' && err.reason !== 'none') throw err;
      console.warn(`[getSubtitle] 第 ${attempt} 次没拿到字幕（${err.reason}），重试…`);
    }
  }
  throw lastErr;
}

/** B 站被限流时塞给我们的假字幕特征（这些内容绝不可能是这首歌的歌词） */
const DECOY_PATTERNS = [
  /♪\s*音乐\s*♪/,          // 纯音乐占位
  /^♪\s*纯音乐/,
  /古道尔|珍·?古道尔/,      // 实测出现过的诱饵内容
];

/**
 * 只取一次（不重试）。成功返回字幕，失败抛出带 reason 的错误。
 * reason: 'no-cookie' | 'limit' | 'decoy' | 'none' | 'network'
 */
async function fetchSubtitleOnce(bvid, cid) {
  // 没登录就别试了 —— 直接告诉界面"先去填 Cookie"，省一次被限流的机会
  if (!hasLoginCookie()) {
    const e = new Error('还没填 B 站 Cookie，拿不到字幕');
    e.reason = 'no-cookie';
    throw e;
  }

  // ① 权威地查这个 bvid 真正的分 P 列表
  //    注意：多 P 视频的所有分 P 共用同一个 bvid，各 P 的 cid 不同。
  //    所以不能简单粗暴地强制用第 1P —— 那样用户听第 3P 就会拿到第 1P 的字幕。
  let pages = [];
  let videoTitle = '';
  try {
    const info = await getVideoInfo(bvid);
    pages = info.pages || [];
    videoTitle = info.title || '';
    if (!pages.length) {
      const e = new Error('这个视频没有可播放的内容');
      e.reason = 'none';
      throw e;
    }
  } catch (err) {
    if (err.reason) throw err;                // 上面自己抛的，保留原因
    const e = new Error(err.message || '视频信息获取失败');
    e.reason = 'network';
    throw e;
  }

  // 调用方给的 cid 只能当"参考"，而且必须验证它确实属于这个 bvid。
  //   · 在 pages 里找得到 → 是这个视频的某一 P，正常使用（多 P 视频靠它区分）
  //   · 找不到 → 多半是存档里的旧 cid 串到了别的视频上，
  //     绝不能继续用它 —— 那正是"显示另一首歌的歌词"的元凶。改用第 1P。
  let usedPage = pages.find((p) => Number(p.cid) === Number(cid));
  if (!usedPage) {
    if (cid) {
      console.warn(
        `[getSubtitle] cid不属于 ${bvid}（传入 ${cid}），已改用第 1P 的 ${pages[0].cid}`
      );
    }
    usedPage = pages[0];
  }
  cid = usedPage.cid;
  if (usedPage.page > 1) videoTitle = `${videoTitle} - P${usedPage.page} ${usedPage.title || ''}`.trim();

  // ②拿字幕轨道列表
  let list;
  try {
    const json = await requestJSON(
      `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`
    );
    list = (json.data && json.data.subtitle && json.data.subtitle.subtitles) || [];
  } catch (err) {
    // requestJSON 抛出来的多为限流类问题，换个 reason 让界面说人话
    const e = new Error(err.message || '字幕接口请求失败');
    e.reason = /风控|限流|验证|频繁|超限/.test(e.message) ? 'limit' : 'network';
    throw e;
  }

  // 没有字幕轨道 = 这视频就没字幕
  if (!list.length) {
    const e = new Error('这首没有字幕');
    e.reason = 'none';
    throw e;
  }

  // ②挑轨道：真人中文 > AI 中文 > 任何中文 > 第一条
  const pick =
    list.find((s) => s.lan && s.lan.startsWith('zh') && !s.lan.startsWith('ai')) ||
    list.find((s) => s.lan && s.lan.startsWith('ai-zh')) ||
    list.find((s) => s.lan && s.lan.startsWith('zh')) ||
    list[0];

  if (!pick || !pick.subtitle_url) {
    const e = new Error('这首没有字幕');
    e.reason = 'none';
    throw e;
  }

  // subtitle_url 常常是 "//aisubtitle.hdslb.com/..." 这种省略协议的，必须补上 https:
  const subUrl = toHttps(pick.subtitle_url);

  // ③下载字幕 JSON
  let body;
  try {
    await throttle();
    const res = await httpRequest(subUrl);
    const parsed = JSON.parse(res.body);
    body = parsed && parsed.body;
  } catch (err) {
    const e = new Error(err.message || '字幕下载失败');
    // URL 为空时 new URL() 会直接抛，那也是限流的信号，值得重试
    e.reason = /URL|Invalid/i.test(e.message) ? 'limit' : 'network';
    throw e;
  }

  // ★ 坑 2 在这里：轨道存在但 body 为空 —— 这是被限流了，不是"这歌没字幕"。
  //   所以 reason 要明确区分开，否则界面会误报"没字幕"。
  if (!Array.isArray(body) || body.length === 0) {
    const e = new Error('被 B 站限流了，字幕没下下来');
    e.reason = 'limit';
    throw e;
  }

  // 整理成统一格式：t = 开始时间（秒），text = 这一句
  let lines = body
    .map((it) => ({
      t: Number(it.from) || 0,
      text: String(it.content || '').trim(),
    }))
    .filter((l) => l.text)          // 丢掉空行（有的是换行占位）
    .sort((a, b) => a.t - b.t);   // 保证按时间递增

  // ★ 坑 4：B 站的"诱饵字幕"。实测被限流时它会返回**别的视频**的字幕，
  //   甚至给完全不同的视频返回同一份"♪ 音乐 ♪"占位。
  //   诱饵每次内容都不一样，所以唯一可靠的办法是**重试**，撞到真的那份为止。
  const joined = lines.map((l) => l.text).join('');
  if (DECOY_PATTERNS.some((re) => re.test(joined))) {
    const e = new Error('B 站返回的不是这首歌的字幕（正在重试确认）');
    e.reason = 'decoy';
    throw e;
  }

  // ★ 坑 3：被限流时 B 站有时不报错，而是**返回一份胡乱拼的假字幕**。
  //   实测连着快速请求几次，会拿到 200 多行"小瓶粉皮莱卡"这种完全无关的乱码。
  //   它同样是"轨道非空 + body 非空"，所以上面两道检查都拦不住。
  //   判据：真正的歌词里不会有大段连续重复的乱词。
  if (lines.length >= 20) {
    const head = lines.slice(0, 20).map((l) => l.text).join('');
    const uniq = new Set(lines.slice(0, 20).map((l) => l.text));
    const zhRatio = (head.match(/[\u4e00-\u9fa5]/g) || []).length / Math.max(head.length, 1);
    // 前 20 句里重复度极高（<一半是不同句子）→ 乱码
    if (uniq.size < 10 || zhRatio < 0.2) {
      const e = new Error('被 B 站限流了，返回的内容是乱码');
      e.reason = 'limit';
      throw e;
    }
  }

  if (!lines.length) {
    // body 有内容但每行 content 都是空的 —— 同样是限流，不是"没字幕"
    const e = new Error('被 B 站限流了，字幕没下下来');
    e.reason = 'limit';
    throw e;
  }

  const result = {
    lines,
    lang: pick.lan_doc || pick.lan,
    bvid,                // 原样带回，方便界面核对
    cid,                 // 实际使用的 cid（已纠正）
    videoTitle,          // 这个字幕属于哪个视频 —— 万一还对不上，用户能一眼看出来
  };

  // 缓存由外层 getSubtitle 统一写入（它才知道调用方带来的那个查询键），
  // 同时按"实际使用的 cid"再写一份，保证下次无论带哪个 cid 都能命中。
  subtitleCache.set(bvid + ':' + cid, { at: Date.now(), data: result });
  return result;
}

// 把上面这些函数导出，让主进程可以使用
module.exports = {
  setUserCookie,
  parseUserInput,
  getVideoInfo,
  searchVideos,
  getAudioUrl,
  getFavFolders,
  getFavMedias,
  getSubtitle,
  hasLoginCookie,
  USER_AGENT,
  REFERER,
};
