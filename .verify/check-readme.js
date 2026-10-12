/* README 完整性检查（纯文本，不需要浏览器）：
     ① 每一个相对链接 / 图片指向的文件真实存在
     ② 每一个锚点（#xxx）在目标文档里能找到对应标题
     ③ 徽章里的版本号 == package.json 的 version
     ④ LICENSE 存在且是 MIT
     ⑤ 旧 README 的每一个小节，在新 README 或 docs/技术说明.md 里都有落点（内容不丢）
   开发期检查脚本，不参与打包。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const README = read('README.md');
const TECH = read('docs/技术说明.md');
const pkg = JSON.parse(read('package.json'));

let fail = 0;
const err = (m) => { console.log('  ✗ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

/* GitHub 的标题锚点算法：转小写 → 去掉非「字母/数字/组合符/空格/_/-」的字符 → 空格换成 -
   （去掉 emoji、中英文标点、反引号、星号等；中文字符属于 \p{L}，会保留） */
const slug = (t) => t.trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
  .replace(/\s+/g, '-');

/** 把一份 markdown 里所有标题抽成锚点集合 */
function anchorsOf(md) {
  const set = new Set();
  for (const line of md.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  return set;
}

const readmeAnchors = anchorsOf(README);
const techAnchors = anchorsOf(TECH);

/* ---------- 1) 链接与图片 ---------- */
console.log('\n[1] 链接 / 图片指向的文件是否存在：');
const links = [];
// markdown 链接与图片： [text](target) / ![alt](target)
for (const m of README.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push(m[1]);
// HTML 里的 src="..."
for (const m of README.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) links.push(m[1]);

let checkedFiles = 0, checkedAnchors = 0;
for (const raw of links) {
  const target = raw.trim();
  if (/^(https?:|mailto:|data:)/i.test(target)) continue;      // 外链 / 内联数据，跳过

  const [filePart, anchor] = target.split('#');
  const file = filePart.replace(/^\.\//, '');

  if (!file) {
    // 纯锚点：必须在本文件里找得到
    if (!readmeAnchors.has(anchor)) err(`锚点 #${anchor} 在 README.md 里找不到对应标题`);
    else checkedAnchors++;
    continue;
  }

  if (!exists(file)) { err(`链接指向的文件不存在：${file}（来自 ${target}）`); continue; }
  checkedFiles++;

  if (anchor) {
    const md = read(file);
    const set = anchorsOf(md);
    if (!set.has(anchor)) err(`${file} 里找不到锚点 #${anchor}（该文件的标题锚点：${[...set].slice(0, 8).join(' / ')}…）`);
    else checkedAnchors++;
  }
}
if (checkedFiles) ok(`${checkedFiles} 个相对链接 / 图片指向的文件都存在`);
if (checkedAnchors) ok(`${checkedAnchors} 个锚点都能在目标文档里找到对应标题`);

/* ---------- 2) 图片确实是图片、且真的存在 ---------- */
console.log('\n[2] 配图：');
const imgRefs = [...README.matchAll(/<img[^>]*\ssrc="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const previewImgs = imgRefs.filter((s) => /^docs\/images\//.test(s));
if (previewImgs.length < 4) err(`README 里的界面配图只有 ${previewImgs.length} 张（计划是 4 张）`);
else ok(`README 引用了 ${previewImgs.length} 张界面配图`);
const uniqImgs = new Set(previewImgs);
if (uniqImgs.size !== previewImgs.length) err('有重复引用的配图');
else ok('配图没有重复引用');

const onDisk = exists('docs/images') ? fs.readdirSync(path.join(ROOT, 'docs', 'images')).filter((f) => /\.(png|jpg|gif|webp)$/i.test(f)) : [];
const unused = onDisk.filter((f) => !previewImgs.some((p) => p.endsWith('/' + f)));
if (unused.length) err('docs/images/ 里有没被引用的图片：' + unused.join(' / '));
else ok('docs/images/ 里的图片都被引用了（没有多余文件）');

/* ---------- 3) 徽章版本 == package.json ---------- */
console.log('\n[3] 徽章与版本号：');
const vBadge = /img\.shields\.io\/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/.exec(README);
if (!vBadge) err('README 里没有版本徽章');
else if (vBadge[1] !== pkg.version) err(`版本徽章写的是 ${vBadge[1]}，package.json 是 ${pkg.version}（两处必须一致）`);
else ok(`版本徽章与 package.json 一致（${pkg.version}）`);

const relNote = /最近更新（v([0-9]+\.[0-9]+\.[0-9]+)）/.exec(README);
if (!relNote) err('「更新日志」里没有「最近更新（vX.Y.Z）」小节');
else if (relNote[1] !== pkg.version) err(`更新日志写的是 v${relNote[1]}，package.json 是 ${pkg.version}`);
else ok(`更新日志的版本与 package.json 一致（v${pkg.version}）`);

if (!/img\.shields\.io\/badge\/license-MIT/.test(README)) err('缺少 MIT 许可证徽章');
else ok('有 MIT 许可证徽章');

/* ---------- 4) LICENSE ---------- */
console.log('\n[4] LICENSE：');
if (!exists('LICENSE')) err('仓库里没有 LICENSE 文件（GitHub 侧栏会显示"无许可证"）');
else {
  const lic = read('LICENSE');
  if (!/MIT License/.test(lic)) err('LICENSE 不是 MIT 文本');
  else if (!/Permission is hereby granted/.test(lic)) err('LICENSE 缺少 MIT 的授权段落');
  else ok('LICENSE 存在且是完整的 MIT 文本');
}

/* ---------- 5) 必备文件 ---------- */
console.log('\n[5] 仓库门面文件：');
const must = [
  ['LICENSE', 'LICENSE'],
  ['.github/ISSUE_TEMPLATE/bug_report.md', 'Bug 反馈模板'],
  ['.github/ISSUE_TEMPLATE/feature_request.md', '功能建议模板'],
  ['docs/技术说明.md', '技术说明'],
  ['CHANGELOG.md', '更新日志'],
];
for (const [f, label] of must) {
  if (!exists(f)) err(`缺少 ${label}：${f}`);
  else ok(`有 ${label}（${f}）`);
}
// Issue 模板要有 front matter，否则 GitHub 不认
for (const f of ['.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md']) {
  if (!exists(f)) continue;
  const t = read(f);
  if (!/^---[\s\S]*?name:/.test(t) || !/about:/.test(t)) err(`${f} 缺少 front matter（name / about），GitHub 不会识别成模板`);
  else ok(`${f} 的 front matter 完整`);
}

/* ---------- 6) 旧 README 的内容有没有丢 ---------- */
console.log('\n[6] 旧 README 的小节落点（内容不丢）：');
const combined = (README + '\n' + TECH).toLowerCase();
const checklist = [
  ['怎么跑起来（3 步）',        ['快速上手', 'npm install', 'node -v']],
  ['① 发现音乐（默认页）',      ['发现', '随机换一批']],
  ['② 搜歌 / 搜索结果',         ['搜索', '关键词']],
  ['③ 合集「选集」面板',        ['选集', '合集']],
  ['④ 粘贴链接播放',            ['解析', 'b23.tv']],
  ['⑤ 导入 B 站收藏夹',         ['收藏夹']],
  ['⑥ 歌单与收藏',              ['歌单', '收藏']],
  ['⑦ 播放队列',                ['队列']],
  ['⑧ 播放模式（四种）',        ['播放模式', '列表循环']],
  ['⑨ 外观与主题色',            ['主题色', '毛玻璃']],
  ['⑩ 动态背景（图片 / 视频）', ['动态背景']],
  ['⑪ 歌词（桌面 / 整页）',     ['桌面歌词', '整页歌词']],
  ['⑫ 快捷键表',                ['快捷键', 'ctrl + l']],
  ['限流怎么办 / 填 SESSDATA',  ['限流', 'sessdata']],
  ['代码是怎么工作的',          ['wbi', 'bili://', 'csp']],
  ['打包 exe',                  ['npm run build']],
  ['常见问题',                  ['常见问题']],
  ['免责声明',                  ['免责声明']],
  ['调试启动.bat 说明',         ['调试启动.bat']],
  ['数据保存位置 / 备份',       ['%appdata%', 'neko-data.json']],
  ['启动器为什么用 .vbs',       ['启动播放器.vbs', 'wscript']],
];
for (const [label, pats] of checklist) {
  const hit = pats.filter((p) => combined.includes(p));
  if (!hit.length) err(`旧 README 的「${label}」在新文档里找不到落点（关键词：${pats.join(' / ')}）`);
  else ok(`「${label}」有落点（命中：${hit.join(' / ')}）`);
}

/* ---------- 7) 隐私：README 里不能出现本机路径 / 私人数据 ---------- */
console.log('\n[7] 隐私：');
const bad = [];
/* C:\Users\<用户名>\… 只有在「用户名看起来是真的」时才算泄露。
   占位符（<你的用户名>、%USERNAME%、你的用户名、username…）是正常写法，放行。 */
const PLACEHOLDER = /^(<[^>]*>|%[^%]+%|你的用户名|用户名|username|your_?name|user|xxx+)$/i;
function leakPaths(text, label) {
  for (const m of text.matchAll(/C:\\Users\\([^\\\s]+)/gi)) {
    if (!PLACEHOLDER.test(m[1])) bad.push(`${label} 里出现了疑似真实的用户名路径：${m[0]}`);
  }
}
leakPaths(README, 'README');
leakPaths(TECH, '技术说明');
if (/neko-data\.json\s*=/i.test(README)) bad.push('README 里疑似贴了存档内容');
if (bad.length) bad.forEach(err);
else ok('文档里没有本机绝对路径 / 私人数据（占位符写法已放行）');

if (fail === 0) console.log('\nREADME 检查全部通过 ✅');
else { console.log(`\n发现 ${fail} 处问题 ❌`); process.exit(1); }
