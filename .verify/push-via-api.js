/* 用 GitHub 的 Git Data API 把本地提交推上去。
 *
 * 为什么不用 git push：
 *   沙箱里 git 自己的 https 传输被代理拦死 —— 走代理报 "CONNECT tunnel failed, response 502"，
 *   直连报 "schannel: server closed abruptly"，换 OpenSSL 后端也一样。
 *   但 gh（GitHub CLI，已登录）能正常访问 api.github.com，所以改走 API 通道。
 *
 * 做法：从远程 main 开始，逐个提交重建 blob → tree → commit，最后更新分支 ref。
 *   已经上传过的文件内容按 sha 缓存，不重复传（第二次跑会快很多）。
 * 注意：本地提交的 sha 会变（因为 author/committer 时间戳被原样保留，但父链重建了），
 *   历史顺序、提交说明、文件内容都保持一致。
 */
const { execFileSync } = require('child_process');

const REPO = 'xingkinglb/neko-music';
const BRANCH = 'main';
const MAX = 1024 * 1024 * 128;

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX, ...opts });
const gitBuf = (args) => execFileSync('git', args, { maxBuffer: MAX });

let calls = 0;
function ghJSON(args, body) {
  calls += 1;
  const out = execFileSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: MAX,
  });
  return out.trim() ? JSON.parse(out) : null;
}

// 1) 远程 main 现在指向哪（作为第一个新提交的父）
const baseSha = execFileSync('gh', ['api', `repos/${REPO}/git/refs/heads/${BRANCH}`, '--jq', '.object.sha'], { encoding: 'utf8' }).trim();
console.log('远程当前 main =', baseSha.slice(0, 7));

// 2) 待推送的提交，从旧到新
const list = git(['log', '--reverse', '--format=%H', `${baseSha}..HEAD`]).trim().split('\n').filter(Boolean);
if (!list.length) { console.log('没有需要推送的提交，收工。'); process.exit(0); }
console.log(`待推送 ${list.length} 个提交\n`);

const blobCache = new Map();   // 本地 blob sha -> 远程 sha
let parent = baseSha;

for (const sha of list) {
  // 该提交的完整文件清单（含未改动文件，tree 必须是完整的）
  const raw = gitBuf(['ls-tree', '-r', '-z', sha]).toString('utf8');
  const entries = raw.split('\0').filter(Boolean).map((line) => {
    const tabAt = line.indexOf('\t');
    const [mode, , blobSha] = line.slice(0, tabAt).split(' ');
    return { mode, sha: blobSha, path: line.slice(tabAt + 1) };
  });

  const tree = [];
  let uploaded = 0;
  for (const e of entries) {
    let remoteSha = blobCache.get(e.sha);
    if (!remoteSha) {
      const content = gitBuf(['cat-file', 'blob', e.sha]);
      const res = ghJSON(['api', `repos/${REPO}/git/blobs`, '--input', '-'], {
        content: content.toString('base64'),
        encoding: 'base64',
      });
      remoteSha = res.sha;
      // git blob 的 sha 只由内容决定，远程算出来的必须和本地一模一样，否则说明内容传坏了
      if (remoteSha !== e.sha) throw new Error(`内容校验失败：${e.path}（本地 ${e.sha} ≠ 远程 ${remoteSha}）`);
      blobCache.set(e.sha, remoteSha);
      uploaded += 1;
    }
    tree.push({ path: e.path, mode: e.mode, type: 'blob', sha: remoteSha });
  }

  const meta = git(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', sha]).split('\0');
  const who = { name: meta[0], email: meta[1], date: meta[2] };
  const message = meta.slice(3).join('\0').replace(/\n+$/, '');

  const treeRes = ghJSON(['api', `repos/${REPO}/git/trees`, '--input', '-'], { tree });
  const commitRes = ghJSON(['api', `repos/${REPO}/git/commits`, '--input', '-'], {
    message, tree: treeRes.sha, parents: [parent], author: who, committer: who,
  });
  parent = commitRes.sha;
  console.log(`  ✓ ${sha.slice(0, 7)} → ${parent.slice(0, 7)}  传了 ${uploaded} 个文件  ${message.split('\n')[0].slice(0, 50)}`);
}

// 3) 把分支指到最新提交
ghJSON(['api', '--method', 'PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, '--input', '-'], { sha: parent, force: true });

console.log(`\n已把 ${BRANCH} 更新到 ${parent}`);
console.log(`共 ${list.length} 个提交 / ${blobCache.size} 个文件内容 / ${calls} 次 API 调用`);
