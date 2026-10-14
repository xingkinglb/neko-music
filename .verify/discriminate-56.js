/* 临时脚本：实测 verify.js 第 56 类的**判别力**。
   做法：把某个实现故意改坏 → 跑 verify.js → 看对应那条断言有没有响 → 还原。
   一条都不响的话，说明这条断言只是在"描述现状"，不是在"拦人"。
   ★ 用完就删（它自己会还原文件，不会留下改动）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const VERIFY = path.join(__dirname, 'verify.js');

/** 每一例：文件 + 原文 + 改成什么 + 期望在报告里看到的错误关键词 */
const CASES = [
  {
    name: '绿勾改成主题色（薄荷绿主题下会分不清）',
    file: 'src/ui/style.css',
    from: '.op-ic.done { background: rgb(var(--ok-rgb) / 0.16); color: var(--ok); }',
    to:   '.op-ic.done { background: rgb(var(--accent-rgb) / 0.16); color: var(--accent); }',
    expect: '绿勾用了 var(--accent)',
  },
  {
    name: '下载任务塞回 neko-data.json',
    file: 'src/store-migrate.js',
    from: '  d.local     = Array.isArray(d.local)     ? d.local     : [];',
    to:   '  d.local     = Array.isArray(d.local)     ? d.local     : [];\n  d.downloads = Array.isArray(d.downloads) ? d.downloads : [];',
    expect: '下载任务被塞回了 neko-data.json',
  },
  {
    name: 'local:// 白名单改成拼接 + startsWith（可被 .. 绕过）',
    file: 'src/local-protocol.js',
    from: 'if (!wl.has(target))',
    to:   'if (![...wl].some((x) => target.startsWith(x)))',
    expect: '没有用 Set.has 做精确匹配',
  },
  {
    name: '「我喜欢」的批量下载按钮被删掉',
    file: 'src/ui/app.js',
    from: 'id="btnDownloadFav"',
    to:   'id="btnNoSuchFav"',
    expect: '工具条上没有「批量下载」按钮',
  },
  {
    name: '两处下载默认值写歪（并发 2 vs 3）',
    file: 'src/ui/app.js',
    from: '  concurrent: 2,        // 同时下载几首（1~4）',
    to:   '  concurrent: 3,        // 同时下载几首（1~4）',
    expect: '两处下载默认值不一致',
  },
  {
    name: '下载器不再复用 safeCoverName（中文封面名会被校验拒掉）',
    file: 'src/downloader.js',
    from: 'safeCoverName(',
    to:   'localCoverName(',
    expect: '下载器没有调用 safeCoverName',
  },
  {
    name: 'CSP 去掉 local:（本地歌曲封面 / 音频被拦）',
    file: 'src/ui/index.html',
    from: "img-src 'self' bg: local: https:",
    to:   "img-src 'self' bg: https:",
    expect: 'CSP 里没有 local:',
  },
  {
    name: '侧栏底部的「下载管理」按钮被删',
    file: 'src/ui/index.html',
    from: '<button class="ghost-btn" id="btnDownloads" title="下载管理">',
    to:   '<button class="ghost-btn" id="btnDlManager" title="下载管理">',
    expect: '应该是「设置」+「下载管理」两个按钮',
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const p = path.join(ROOT, c.file);
  const orig = fs.readFileSync(p, 'utf8');
  if (!orig.includes(c.from)) {
    console.log(`  ? 跳过（原文没找到）：${c.name}`);
    fail++;
    continue;
  }
  fs.writeFileSync(p, orig.split(c.from).join(c.to), 'utf8');
  let out = '';
  try {
    out = execFileSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
  } finally {
    fs.writeFileSync(p, orig, 'utf8');
  }
  const hit = out.includes(c.expect);
  if (hit) { console.log(`  ✓ 会响：${c.name}`); pass++; }
  else { console.log(`  ✗ 没响：${c.name}（期望看到「${c.expect}」）`); fail++; }
}

/* 还原之后必须回到全绿，确认这些脚本没把项目改坏 */
let finalOut = '';
try {
  finalOut = execFileSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { finalOut = String((e.stdout || '') + (e.stderr || '')); }
const restored = /全部静态自检通过/.test(finalOut);
console.log(`\n判别力：${pass}/${CASES.length} 条会响；还原后全绿：${restored ? '是' : '否'}`);
if (!restored) console.log(finalOut.split('\n').filter((l) => /✗|❌/.test(l)).join('\n'));
process.exit(pass === CASES.length && restored ? 0 : 1);
