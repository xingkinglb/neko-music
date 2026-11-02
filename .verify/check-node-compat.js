/* 自检：仓库里的 JS 不许依赖「Node 22 才有的 Iterator Helpers」。
   跑：node .verify/check-node-compat.js      有问题退出码 1

   ---- 为什么单独搞一个脚本 ----
   2026-11-02 给仓库上 CI 时踩出来的：.verify/verify.js 里有 8 处写成
       xxx.matchAll(re).map(...)
   matchAll 返回的是**迭代器**，不是数组；能直接 .map 全靠 Node 22 的
   Iterator Helpers（Iterator.prototype.map）。作者本地是 v22，所以一直是绿的，
   CI 用 Node 20 就当场 TypeError —— 一条断言都跑不到，看上去像"项目坏了"。

   ---- 为什么 src/ 也要扫 ----
   Electron 33 内置的 Node 就是 20。同一句写法要是出现在 src/ 里，
   不是"别人跑自检才崩"，而是**用户一开软件就崩**。所以这里连产品代码一起扫。

   ---- 正确写法 ----
   先把迭代器展开成数组，再链式调用：
       [...xxx.matchAll(re)].map(f)
   注意外层还有展开运算符时也一样：
       ...[...xxx.matchAll(re)].map(f)

   ---- 怎么判断一处有没有问题 ----
   从 matchAll 的左括号开始做括号匹配（跳过字符串 / 正则字面量），
   找到配对的右括号，看它后面紧跟的是不是 ] ——
   是 ] 说明已经包好了（数组），不是就直接 .map 才需要报。
   ⚠ 必须做真括号匹配，不能用 `.matchAll([^)]*)` 这种正则 ——
   参数本身常常就是正则字面量（如 /getUserID\(/g），里面有括号会把匹配截断。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ★ 扫描前先把注释挖掉。
   不挖的话，这段说明文字自己就会命中自己 —— 上面第 6 行那个反例
   `xxx.matchAll(re).map(...)` 会被当成真代码报出来（第一次跑就是这么翻车的）。
   挖的时候**保留换行**（替换成等长空格），否则报出来的行号全错位。
   这套手法和 verify.js 开头那几个 strip 函数是同一套。 */
const blankKeepLines = (m) => m.replace(/[^\n]/g, ' ');
const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blankKeepLines);
const stripLine = (s) => s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripComments = (s) => stripLine(stripBlock(s));

/* 哪几个链式方法在迭代器上是 Node 22 才有的。只列会踩坑的这几个：
   for...of / 展开 / Array.from 在迭代器上本来就能用，不算问题。 */
const CHAIN = /^\s*\.\s*(map|filter|forEach|some|every|flatMap|reduce|find|take|drop)\s*\(/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 只跳 node_modules / dist / .git —— 别的都扫
      if (['node_modules', 'dist', '.git', '.tmp'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/** 找出一份源码里"没包方括号就直接链式调用"的 matchAll */
function findBareChains(src) {
  const hits = [];
  const re = /\.matchAll\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1; // 指向 '('
    let depth = 0;
    let j = open;
    let inRe = false; // 在正则字面量里
    let inStr = null; // 在 ' 或 " 或 ` 里
    for (; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (inRe) {
        if (c === '\\') { j++; continue; }
        if (c === '/') inRe = false;
        continue;
      }
      // 不是注释的 / 就是正则开头（这里只出现在 matchAll 的参数位置）
      if (c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*') { inRe = true; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    const after = src.slice(j + 1, j + 18);
    const wrapped = /^\]/.test(after); // )]  → 已经是数组了
    if (!wrapped && CHAIN.test(after)) {
      hits.push({
        line: src.slice(0, m.index).split('\n').length,
        snippet: src.slice(m.index, j + 20).replace(/\s+/g, ' ').trim().slice(0, 90),
      });
    }
    re.lastIndex = j + 1; // 从右括号之后继续扫，别陷进参数里
  }
  return hits;
}

console.log('\n扫描 src/ 与 .verify/ 下所有 .js：');
const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, '.verify'))];
let bad = 0;
const report = [];
for (const f of files) {
  const hits = findBareChains(stripComments(fs.readFileSync(f, 'utf8')));
  if (!hits.length) continue;
  bad += hits.length;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  report.push(`${rel}（${hits.length} 处）`);
  hits.forEach((h) => report.push(`    ${h.line}| ${h.snippet}`));
}

if (bad) {
  console.log('  ✗ 找到 ' + bad + ' 处"matchAll 结果直接链式调用"的写法');
  console.log('    这些在 Node 22 上能跑，在 Node 18/20（含 Electron 33 内置的 Node 20）上会 TypeError。');
  console.log('    改法：把 matchAll 的调用整个包进方括号 —— [...x.matchAll(re)].map(f)\n');
  report.forEach((l) => console.log('    ' + l));
  console.log('');
  process.exit(1);
}

console.log('  ✓ ' + files.length + ' 个文件里没有裸 matchAll 链式调用');
console.log('  ✓ 迭代器用法都先展开成数组（[...x.matchAll(re)].map(f)）');
console.log('\nNode 版本兼容检查全部通过 ✅\n');
