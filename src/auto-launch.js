/* ============================================================
   开机自启的注册逻辑（v2.14.0）
   ============================================================
   ★ 为什么单独一个文件：这段代码**只有真机才可能出错** ——
     离屏 Electron 里没有真的注册表、也没有"下次开机"。所以至少要让它
     能被一个真实的 electron 进程直接 require 进来、对着真注册表跑一遍
     （见 .verify/test-round34.js）。

   ★ 为什么这里不 require('electron')：
     把 app 当参数传进来，这个文件就能在普通 node 里被加载、
     用一个假的 app 测"拼出来的 args 对不对"。

   ★ 一个真机踩过的坑（第一版就错在这儿）：
     `getLoginItemSettings` 是拿你传进去的 `args` 去**精确比对**注册项里那一串的。
     而注册项里的 args 会跟着「启动时只留托盘」变（`--silent` 有或没有）。
     所以只查一种写法时，用户在副开关上切一下，另一种写法就查不到 →
     界面上看就是"开关弹回去、再点也没反应"。
     现在两种写法都查一遍，任一命中即算已注册。
   ============================================================ */

/**
 * @param {object} electronApp  Electron 的 `app`（只要有 isPackaged / getAppPath / get/setLoginItemSettings）
 * @returns {{args:Function, read:Function, write:Function, variants:Function}}
 */
function createAutoLaunch(electronApp) {
  const app = electronApp;

  /**
   * 注册项里要带的参数。
   * ★ 开发期 process.execPath 是 electron.exe，**必须把工程目录带上** ——
   *   否则开机启动的会是一个空白 Electron 窗口，而且它和我们的单实例锁不是同一个应用。
   */
  function args(silent) {
    return app.isPackaged
      ? (silent ? ['--silent'] : [])
      : [app.getAppPath()].concat(silent ? ['--silent'] : []);
  }

  /** 两种写法（带 --silent / 不带）—— 读的时候两种都要试 */
  function variants() {
    return [args(true), args(false)];
  }

  /** 读系统里的真实注册状态（用户可能在「任务管理器 → 启动」里禁用了它） */
  function read() {
    let on = false;
    for (const a of variants()) {
      try {
        if (app.getLoginItemSettings({ path: process.execPath, args: a }).openAtLogin) { on = true; break; }
      } catch (_) { /* 某一种读不出来就试下一种，不要因此判成"没开" */ }
    }
    return { openAtLogin: on, packaged: !!app.isPackaged };
  }

  /** 写注册状态。silent 一变就要重写一次，因为 args 是注册项的一部分 */
  function write(on, silent) {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: process.execPath,
      args: args(!!silent),
    });
    return read();   // ★ 回读：写失败（权限 / 组策略）时不会抛异常，只能靠它发现
  }

  return { args, variants, read, write };
}

module.exports = { createAutoLaunch };
