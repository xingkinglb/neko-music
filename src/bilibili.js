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
  // 用户可能只填了 SESSDATA=xxx 这一段，也可能把整个 Cookie 都贴进来了
  const sess = t.match(/SESSDATA=([^;\s]+)/);
  BASE_COOKIE = sess
    ? `buvid3=${BUVID3}; b_nut=1700000000; SESSDATA=${sess[1]}`
    : `${BASE_COOKIE}; ${t}`;
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
 */
async function getVideoInfo(bvid) {
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

  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    cover: toHttps(d.pic),
    owner: { mid: d.owner.mid, name: d.owner.name },
    duration: d.duration,
    pages,
    season,
  };
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

// 把上面这些函数导出，让主进程可以使用
module.exports = {
  setUserCookie,
  parseUserInput,
  getVideoInfo,
  searchVideos,
  getAudioUrl,
  getFavFolders,
  getFavMedias,
  USER_AGENT,
  REFERER,
};
