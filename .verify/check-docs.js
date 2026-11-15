/* 自检：文档的"骨头"有没有断（锚点 / 章节编号 / 交叉引用）。
   跑：node .verify/check-docs.js     有问题退出码 1

   ★ 为什么需要它：v2.14.0 之前，`技术说明.md` 的第 13 节（托盘 / 任务栏 / 关窗弹窗）
     整节是**缺失**的 —— 目录里有链接、`.verify` 里两处写着"见第 13 节 ⑧"，
     正文却从 14 直接接上去。这种烂法**不影响任何代码运行**，
     静态自检（纯文本校验 id / CSS 变量那种）也看不到，
     于是它就这么躺了整整一年才被发现。

   ★ 所以这个脚本只管三件事，全是"读起来没问题、点下去才发现"的类型：
     ① 每个 `](#锚点)` 都真的能跳到某个标题
     ② 每个编号章节都在目录里挂号
     ③ 正文里"第 N 节"的引用都指向存在的章节

   它**不检查内容对不对** —— 那是人的事。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

/**
 * GitHub 的标题锚点规则（只实现这个项目实际用到的部分）：
 *   转小写 → 去掉标点（保留 字母/数字/下划线/连字符/中日韩/空格）→ **每个空格各转一个连字符**。
 * ★ 最后这一步不能合并连续空格：`13. 托盘 / 任务栏` 去掉 `/` 之后是两个空格，
 *   GitHub 生成的是 `13-托盘--任务栏`（两个连字符）。合并了就永远比不上，
 *   我第一次写这个脚本就是在这儿误报了 10 条"断链"。
 */
function slug(title) {
  return String(title)
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\u4e00-\u9fa5\- ]/g, '')
    .trim()
    .replace(/ /g, '-');
}

/** 读一份文档，抽出：所有标题锚点、所有目录链接、所有编号章节、所有"第 N 节"引用 */
function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const anchors = new Set();
  const headings = [];          // { num, title, anchor, line }
  const links = [];             // { anchor, text, line }
  const sectionRefs = [];       // { num, line }
  let inFence = false;

  text.split(/\r?\n/).forEach((ln, i) => {
    // 代码块里的 `# 注释` 不是标题，不许算进来
    if (/^\s*```/.test(ln)) { inFence = !inFence; return; }
    if (inFence) return;

    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(ln);
    if (h) {
      const a = slug(h[2]);
      anchors.add(a);
      // 只认「一级 / 二级标题 里的 N. xxx」当成"章节"；N.1 那种子节不算
      const num = /^(?:#{2,3})\s+(\d+)\.\s+/.exec(ln);
      if (num) headings.push({ num: Number(num[1]), title: h[2], anchor: a, line: i + 1 });
    }

    // 目录里的 [文字](#锚点)
    for (const m of ln.matchAll(/\]\(#([^)\s]+)\)/g)) {
      links.push({ anchor: m[1], line: i + 1 });
    }

    // 正文里的「第 13 节」「第 15.5 节」
    for (const m of ln.matchAll(/第\s*(\d+(?:\.\d+)?)\s*节/g)) {
      sectionRefs.push({ num: m[1], line: i + 1 });
    }
  });

  return { text, anchors, headings, links, sectionRefs };
}

const DOCS = ['docs/技术说明.md', 'README.md', 'docs/路线图.md', 'docs/参考实现研究-biu.md'];
const parsed = {};
DOCS.forEach((f) => { parsed[f] = parse(path.join(ROOT, f)); });

/* ================= [1] 锚点全部能落地 ================= */
console.log('\n[1] 目录锚点都能跳到某个标题：');
{
  let total = 0;
  for (const f of DOCS) {
    const { anchors, links } = parsed[f];
    const bad = [...new Set(links.filter((l) => !anchors.has(l.anchor)).map((l) => l.anchor))];
    total += links.length;
    if (bad.length) {
      bad.forEach((b) => err(`${f} 第 ${links.find((l) => l.anchor === b).line} 行 → #${b} 没有对应标题`));
    }
  }
  if (!fail) ok(`${total} 条目录链接全部命中（4 份文档）`);
}

/* ================= [2] 编号章节都在目录里 ================= */
console.log('\n[2] 技术说明的每个编号章节都在目录里挂号：');
{
  const f = 'docs/技术说明.md';
  const { headings, text } = parsed[f];
  const missing = headings.filter((h) => !text.includes('](#' + h.anchor + ')'));
  if (missing.length) missing.forEach((h) => err(`第 ${h.line} 行的「${h.num}. ${h.title}」没有目录条目`));
  else ok(`${headings.length} 个编号章节全都有目录条目`);
}

/* ================= [3] 章节编号连续、不重号 ================= */
console.log('\n[3] 章节编号连续、不重号：');
{
  const nums = parsed['docs/技术说明.md'].headings.map((h) => h.num);
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (dup.length) err(`编号重复：${[...new Set(dup)].join(', ')}`);
  else ok(`${nums.length} 个章节没有重号`);

  const gaps = [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) gaps.push(`${nums[i - 1]} → ${nums[i]}`);
  }
  if (gaps.length) err(`编号不连续：${gaps.join(' / ')}`);
  else ok(`编号从 ${nums[0]} 一路连续到 ${nums[nums.length - 1]}（中间没有跳号、没有降级成子标题）`);
}

/* ================= [4] "第 N 节"的交叉引用都指向存在的章节 ================= */
console.log('\n[4] 正文里"第 N 节"的引用都指向存在的章节：');
{
  const nums = new Set(parsed['docs/技术说明.md'].headings.map((h) => String(h.num)));
  let checked = 0;
  for (const f of DOCS) {
    for (const r of parsed[f].sectionRefs) {
      checked++;
      const head = r.num.split('.')[0];
      if (!nums.has(head)) err(`${f} 第 ${r.line} 行引用了「第 ${r.num} 节」，但技术说明里没有第 ${head} 节`);
    }
  }
  if (!fail) ok(`${checked} 处交叉引用全部指向真实存在的章节`);
}

/* ================= [5] 版本号三处一致（README badge / package.json / CHANGELOG 最新一条） ================= */
console.log('\n[5] 版本号三处一致：');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = parsed['README.md'].text;
  const change = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

  const badge = /version-([\d.]+)-/.exec(readme);
  const latest = /^## v([\d.]+)/m.exec(change);
  if (!badge) err('README 里找不到 version badge');
  else if (badge[1] !== pkg.version) err(`README badge 是 ${badge[1]}，package.json 是 ${pkg.version}`);
  else if (!latest) err('CHANGELOG 里找不到最新版本行');
  else if (latest[1] !== pkg.version) err(`CHANGELOG 最新一条是 v${latest[1]}，package.json 是 ${pkg.version}`);
  else ok(`三处都是 v${pkg.version}`);
}

console.log(fail ? `\n文档自检未通过 ❌（${fail} 处）\n` : '\n文档自检全部通过 ✅\n');
process.exit(fail ? 1 : 0);
