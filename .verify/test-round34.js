/* 真机实测：开机自启的注册表读写（v2.14.0）
   跑：env -u ELECTRON_RUN_AS_NODE npx electron .verify/test-round34.js
   报告：.verify/test-round34-report.txt

   ★ 为什么这个必须用真的 electron 跑、而不是纯 node 假一个 app：
     这块的 bug **只有真机才暴露** —— 第一版把 `getLoginItemSettings` 写死成一种 args，
     用户在主开关上关掉再点一次就"没反应"（因为注册项里的 args 已经变了，查不到）。
     假 app 永远测不出这种"参数不匹配"的行为。

   ★ 它会**真的写 Windows 启动项**，所以末尾必须恢复原状（fail 也要恢复）。
     恢复的是"开/关"这个状态；`--silent` 参数恢复不了（读不出来），
     但下次用户在界面上切一次就会重写。 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'test-round34-report.txt');
fs.writeFileSync(OUT, '');
const say = (m) => { fs.appendFileSync(OUT, m + '\n'); };

let fail = 0, pass = 0;
const ok = (m) => { pass++; say('  OK   ' + m); };
const bad = (m) => { fail++; say('  FAIL ' + m); };

const { createAutoLaunch } = require(path.join(ROOT, 'src', 'auto-launch.js'));

app.whenReady().then(async () => {
  const al = createAutoLaunch(app);
  const before = al.read();

  say('环境：packaged=' + app.isPackaged + '  execPath=' + process.execPath);
  say('appPath=' + app.getAppPath());
  say('起始状态：openAtLogin=' + before.openAtLogin + '（跑完会恢复成这个）');

  /* ---------- [1] 参数拼得对不对 ---------- */
  say('\n[1] 注册项里的参数：');
  {
    const aOn = al.args(true), aOff = al.args(false);
    if (!aOn.includes('--silent')) bad('silent=true 时没带 --silent');
    else if (aOff.includes('--silent')) bad('silent=false 时还带着 --silent（开机还是静默）');
    else if (!app.isPackaged && !aOn[0].endsWith(path.basename(app.getAppPath()))) {
      bad('开发期没把工程目录带上（会打开一个空白 Electron 窗口）');
    } else {
      ok(`silent=true → ${JSON.stringify(aOn)}`);
      ok(`silent=false → ${JSON.stringify(aOff)}`);
    }
  }

  /* ---------- [2] 开 → 关 → 再开（Neo 报的那个 bug） ---------- */
  say('\n[2] 开 → 关 → 再开（「关了再点没反应」就是在这儿）：');
  try {
    const r1 = al.write(true, true);
    if (!r1.openAtLogin) bad('打开后读回来还是"没开"（写失败或回读不对）');
    else ok('打开成功，回读 = 已注册');

    const r2 = al.write(false, true);
    if (r2.openAtLogin) bad('关掉之后读回来还是"开着"');
    else ok('关掉成功，回读 = 未注册');

    // ★★ 关键一步：关掉之后**再打开**，而且这次 silent 换成 false（args 变了）
    const r3 = al.write(true, false);
    if (!r3.openAtLogin) {
      bad('★ 关了再开没反应 —— 回读失败（就是 args 不匹配那个 bug）');
    } else ok('★ 关了再打开，回读 = 已注册（args 变了也能查到）');

    const r4 = al.write(true, true);
    if (!r4.openAtLogin) bad('切换到"只留托盘"之后读回来是"没开"');
    else ok('切到 silent=true 再回读，仍然是已注册');
  } catch (err) {
    bad('抛异常：' + (err && err.message));
  }

  /* ---------- [3] 两种 args 都要能读出来 ---------- */
  say('\n[3] 注册的 args 和读的时候传的 args 不一致，也得能查到：');
  {
    al.write(true, false);                    // 注册成"不带 --silent"
    const v = al.variants();
    const a = app.getLoginItemSettings({ path: process.execPath, args: v[0] }).openAtLogin;  // 用带 --silent 去查
    const b = app.getLoginItemSettings({ path: process.execPath, args: v[1] }).openAtLogin;  // 用不带去查
    if (a && b) ok('两种写法都查得到（Electron 本身不区分 args）');
    else if (b && !a) ok(`带 --silent 查不到（${a}）、不带查得到 —— 所以 read() 必须两种都试`);
    else if (!b && a) ok('不带查不到、带查得到 —— 同样说明必须两种都试');
    else bad('两种都查不到，但 al.read() 说已注册 —— 状态不一致');
    if (al.read().openAtLogin) ok('read() 依旧认得出"已注册"');
    else bad('read() 漏判了');
  }

  /* ---------- [4] 交给界面的那份数据形状 ---------- */
  say('\n[4] 返回给界面的字段：');
  {
    const r = al.read();
    if (typeof r.openAtLogin !== 'boolean') bad('openAtLogin 不是布尔值（界面会判错）');
    else if (typeof r.packaged !== 'boolean') bad('缺 packaged（开发模式提示会失灵）');
    else ok(`{ openAtLogin: ${r.openAtLogin}, packaged: ${r.packaged} }`);
  }

  /* ---------- 恢复现场 ---------- */
  say('\n[5] 恢复原状：');
  try {
    al.write(before.openAtLogin, true);
    const after = al.read();
    if (after.openAtLogin === before.openAtLogin) ok(`已恢复成 openAtLogin=${before.openAtLogin}`);
    else bad(`恢复失败：现在 ${after.openAtLogin}，本来是 ${before.openAtLogin}`);
  } catch (err) {
    bad('恢复时抛异常：' + (err && err.message));
  }

  say(`\n开机自启实测：${fail === 0 ? '全部通过 ✅' : fail + ' 处失败 ❌'}（${pass} 通过 / ${fail} 失败）`);
  setTimeout(() => app.exit(fail === 0 ? 0 : 1), 300);
}).catch((e) => {
  say('FAIL ' + (e && e.stack || e));
  setTimeout(() => app.exit(2), 300);
});
