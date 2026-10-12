# 参考实现研究 —— `wood3n/biu`　（取其精华，去其糟粕）

> 这是 Neo 给的参考项目 [github.com/wood3n/biu](https://github.com/wood3n/biu) 的研究笔记。
> 目的：**看别人怎么做 mini 模式 / 任务栏缩略图按钮 / 托盘菜单 / 关闭行为**，把好的吸收进三轮计划，把不好的记下来避免踩。
>
> 状态：📖 研究笔记（不改源码）；对计划的修改已经落到 `改造计划-v2.1.0-mini模式.md` 和 `改造计划-v2.2.0-任务栏与托盘.md`。

---

## 〇 先说结论

| 结论 | 说明 |
|---|---|
| **biu 的技术栈** | Electron + React + TypeScript + rsbuild，**2725 star**，就是个 B 站音乐播放器（和 Neko 同类） |
| **它的 mini 模式和我们不一样** | 它**另开一个小窗口**（`320×100`，`skipTaskbar: true`）；我们计划用**同一个窗口缩小** |
| **它的 thumbar 和我们计划一致** | `setThumbarButtons` + 4 个 PNG 图标 + 播放状态回传 —— **连图标文件名都一样**，等于帮我们验证了方案 |
| **它的托盘菜单比图5 简单** | 只有「播放/暂停、上一曲、下一曲、显示/隐藏、设置、退出」，**没有子菜单** |
| **它的关闭行为比你要的简单** | 只有 `hide` / `exit` 两项设置，**没有"每次询问"弹窗**，也没有"设为默认值" |
| **你的四张图应该是网易云的** | 见 §四：biu 的 mini 截图长的是另一个样子 |

**一句话**：**按钮和托盘的"骨架"照抄它没问题；mini 模式的"做法"不要照抄；关闭弹窗它没有，得我们自己设计。**

---

## 一、我读了它的哪些文件

| 文件 | 内容 |
|---|---|
| `electron/main.ts` | 主进程入口：窗口创建、单实例锁、关闭行为、生命周期清理 |
| `electron/mini-player.ts` | mini 窗口的创建 / 销毁 |
| `electron/windows/thumbar.ts` | 任务栏缩略图按钮 |
| `electron/windows/tray.ts` | 系统托盘 + 右键菜单 |
| `electron/ipc/window.ts` | 窗口相关 IPC（含 `toggleMini`） |
| `shared/settings/app-settings.ts` | 默认设置（含 `closeWindowOption`） |
| `src/common/utils/mini-player.ts` | 渲染侧的 mini 同步协议 |
| `electron/icons/win/*` | 图标资产清单 |
| `screenshots/mini.jpg` | mini 播放器实际长相 |

---

## 二、精华（值得吸收的，逐条）

### 2.1 关闭行为：用 `app.on('before-quit')` 设"正在退出"标记 ⭐ 最值得学

**它的写法**（`electron/main.ts`）：

```js
mainWindow.on("close", event => {
  const closeWindowOption = appSettingsStore.get("appSettings").closeWindowOption;
  if ((app as any).quitting) return;          // ← 正在退出：放行
  if (closeWindowOption === "hide") {
    event.preventDefault();
    mainWindow?.hide();                        // ← 否则：缩小到托盘
  } else if (closeWindowOption === "exit") { ... }
});

app.on("before-quit", () => { (app as any).quitting = true; });   // ★ 关键
```

**为什么好**：托盘的「退出」只调 `app.quit()`，而 `before-quit` 会**在每一次真退出时**触发 ——
所以不只是托盘退出，`Ctrl+Q`、系统关机、任务管理器结束、任何代码里的 `app.quit()` **全都会**正确放行，
不会出现"点了退出却被 `hide()` 拦住"的情况。

**比我原来的方案好**：我原计划是"在托盘退出那里手动设一个 `forceQuit` 标记" ——
那只能覆盖**我想到的那一条**退出路径。→ **已改**（见 v2.2.0 计划 §5.4）。

> ⚠️ 但**不能照抄它的 `close` 分支**：Neko 关窗前要做一次"存盘握手"（`requestMainWindowClose`，`main.js:149-171`）。
> 它没有这个需求（用的是实时写入的 store），所以 `if (quitting) return;` 直接放行。
> Neko 必须改成：**真退出时仍然走存盘握手**，只是跳过弹窗 / 跳过 `hide()`。

### 2.2 无边框窗口：拦掉系统菜单 / Ctrl+R / 右键菜单

**它的写法**：

```js
// 拦截 WM_INITMENU (0x0116)，阻止系统菜单（无边框窗口按 Alt+Space 或右键会冒出来）
if (process.platform === "win32") {
  win.hookWindowMessage(0x0116, () => {
    win.setEnabled(false);
    setTimeout(() => win.setEnabled(true), 100);
    return true;
  });
}

// 禁止 Ctrl+R / Cmd+R 刷新页面
win.webContents.on("before-input-event", (event, input) => {
  if ((input.control || input.meta) && input.key.toLowerCase() === "r") event.preventDefault();
});

// 禁止右键菜单
win.webContents.on("context-menu", e => e.preventDefault());
```

**为什么好**：这三个在**自绘标题栏**的窗口上都是真实痛点 ——
① 右键标题栏 / Alt+Space 会冒出 Windows 的系统菜单，和自绘界面格格不入；
② 误按 Ctrl+R 会把整个界面重载（音乐还在放但界面回到首页，看着像崩了）；
③ 右键会冒出 Chromium 的默认菜单。

**用到哪**：mini 窗口（v2.1.0）和主窗口都值得加。**已加进 v2.1.0 计划**。

### 2.3 安全加固：禁止开新窗口

```js
win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
```

**为什么好**：`target="_blank"` / `window.open` / 中键点击都可能弹出 Electron 原生新窗口 ——
那个窗口**没有 preload、没有我们的 CSP 管控**，等于开了个后门。Neko 现在**没有**这条。
（Neko 的外链走的是 `shell.openExternal`，所以 deny 掉不影响正常功能。）

### 2.4 单实例锁：`second-instance` 里连"最小化"也要还原

```js
app.on("second-instance", () => {
  if (mainWindow.isMinimized()) mainWindow.restore();   // ★ 这一条容易漏
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});
```

**为什么好**：只 `show()` 不够 —— 窗口是最小化状态时 `show()` 不会把它还原出来。
**已加进 v2.2.0 计划**。

### 2.5 托盘：图标用 `.ico`、创建前先销毁旧的、退出时清理

```js
const iconName = isLinux ? "logo.png" : isDev ? "dev.ico" : "tray.ico";   // ★ Windows 用 .ico
let icon = nativeImage.createFromPath(trayIconPath);
if (icon.isEmpty()) log.warn(`[tray] Tray icon not found: ${trayIconPath}`);  // ★ 加载失败要吭声

function createTray(...) {
  if (tray) { tray.destroy(); tray = null; }   // ★ 防重复创建
  ...
}
// will-quit 里 destroyTray()
```

**为什么好**：① Windows 托盘图标用 `.ico` 比 PNG 更清晰（ico 里可以塞多分辨率，系统按 DPI 挑）；
② `icon.isEmpty()` 检查 —— 图标路径错了会**静默失败**，托盘直接不出现，很难查；
③ 创建前先销毁，避免"热重载 / 二次调用"留下两个图标；
④ `will-quit` 里 `destroyTray()`，否则图标会**残留在托盘里**直到鼠标划过去才消失。

**已加进 v2.2.0 计划**（我原来写的是 `tray.png`，改成 `tray.ico`）。

### 2.6 生命周期兜底：`uncaughtException` 也要退出

```js
process.on("uncaughtException", err => {
  log.error("[uncaughtException]", err);
  (app as any).quitting = true;
  app.quit();
});
```

**为什么好**：**加了托盘之后这条变得重要** —— 主进程一旦崩了但没退出，
托盘图标会一直留着、点它也没反应，用户会以为"软件卡死了"。主动退出比留个僵尸图标好。

### 2.7 其它小细节

| 细节 | 说明 |
|---|---|
| `useContentSize: true` | 窗口尺寸按"网页内容区"算，不被边框/标题栏吃掉几十像素。Neko 的窗口是无边框的，影响小，但写上有好处 |
| `getMainWindow` 回调解耦 | 托盘模块不直接引用 `mainWindow` 变量，而是接收 `getMainWindow` 回调 —— 好测试、不会拿到过期引用 |
| 托盘 `onExit` 回调 | 托盘不自己 `app.quit()`，而是把"退出"这件事交回主进程处理（因为要设 `quitting` 标记） |
| `show: true` 之外用 `ready-to-show` | 它用了 `show: true`；Neko 用的是 `show:false` + `ready-to-show`（`main.js:184/208`）—— **Neko 这条更稳**，能避免白闪，保持现状 |

---

## 三、糟粕（不要照抄的，逐条）

### 3.1 ❌ mini 模式另开一个 `skipTaskbar` 小窗口

**它的做法**（`electron/mini-player.ts` + `electron/ipc/window.ts`）：

```js
// 进 mini：把主窗口藏起来，另开一个小窗
ipcMain.handle(channel.window.toggleMini, () => {
  if (miniPlayer && !miniPlayer.isDestroyed()) { destroyMiniPlayer(); mainWindow?.show(); }
  else { mainWindow?.hide(); createMiniPlayer(); }     // ← 主窗口 hide
});

miniPlayer = new BrowserWindow({
  width: 320, height: 100, frame: false, transparent: true,
  alwaysOnTop: true, skipTaskbar: true,                 // ← 不在任务栏里占位
  ...
});
miniPlayer.loadFile(indexPath, { hash: "mini-player" }); // ← 同一个页面，靠 hash 区分
```

**为什么对 Neko 不行（两条硬伤）**：

1. **`skipTaskbar: true` 会让任务栏图标消失** —— 而你要的**图4（悬停任务栏图标出缩略图按钮）正是挂在任务栏图标上的**。
   进了 mini 反而没有任务栏图标可悬停，两条需求**直接打架**。
   Neko 的计划是"同一个窗口缩小"，任务栏图标**一直在**，悬停它就能看到缩略图 + 三个按钮。
2. **两个窗口就要同步状态** —— 它为此写了一整套协议（`src/common/utils/mini-player.ts`，150 行）：
   `BroadcastChannel` + `init/seek/next/prev/togglePlay/togglePlayMode` 命令 + 状态快照 + 订阅/退订。
   因为 mini 窗口**自己不播歌**，播放状态、进度、歌名、封面全靠主窗口推。
   Neko 是 vanilla JS（没有 React/zustand），照搬这套会**更麻烦**；用同一个窗口则**一行同步代码都不用写**。

> 结论：**做法不抄，但它证明了"同一个页面 + 一个模式标记"这个思路**（它用 URL hash，我们用 `body.mini` 类，等价）。

### 3.2 ❌ 托盘菜单没有子菜单

它的菜单是平的：`播放/暂停 · 上一曲 · 下一曲 · 显示/隐藏界面 · ─── · 设置 · 退出程序`。

**做不出你图5 里的「列表循环 ▸」「完整模式 ▸」**。Neko 要做子菜单（`submenu` + `type: 'radio'` 打勾）。

### 3.3 ❌ 关闭行为太简单，而且有一段死代码

```js
} else if (closeWindowOption === "exit") {
  if ((app as any).quitting) { mainWindow = null; }    // ← 永远为假
}
```

上面已经 `if ((app as any).quitting) return;` 过了，进到这个分支时 `quitting` **一定是 false**，
所以这个 `if` 是**永远不执行**的死代码（它靠"不 preventDefault"来放行关闭，能跑通，但读起来是坑）。

而且它**只有 hide / exit 两项**，**没有"每次询问"**、**没有"设为默认值"复选框** ——
你要的那套（弹窗 + 记住选择 + 设置里能改）**它没有，得我们自己设计**。

### 3.4 ❌ 一堆运行时依赖

`electron-is-dev`、`electron-log`、`zustand`、`@heroui/react`、`axios`、`electron-updater` …
Neko 是**零运行时依赖**的 vanilla 项目（`package.json` 里只有 `electron` 和 `electron-builder` 两个 devDependencies）。
**不引入**：判断开发环境用 `process.env.NEKO_DEBUG`（项目已有），日志用 `console.error`。

### 3.5 ❌ 窗口 `show: true` 而不是 `ready-to-show`

会有一瞬间白闪。Neko 已经是 `show:false` + `ready-to-show`（`main.js:184` / `main.js:208`），**保持不动**。

### 3.6 ⚠️ 它没有做 `setThumbnailClip`

我原计划里"把任务栏预览裁成封面"这一条，它**没做** —— 所以这条仍然是"我自己的推断 + 官方 API 文档支撑"，
**没有现成先例可抄**。真机上要重点验证（v2.2.0 计划里已经标了）。

---

## 四、和你那四张图的对照（顺便确认一下来源）

| 你的图 | 我判断的来源 | 依据 |
|---|---|---|
| 图1（标题栏 mini 按钮） | 网易云 | 图标是 Windows「向下还原」样式，位置在最小化左边 |
| 图2（mini 收起态） | 网易云 | 有 ♡ / 🔊 / ☰ 和"歌名在下面"的排布；**biu 的 mini 长的是另一个样子**（见下） |
| 图3（mini + 播放列表） | 网易云 | biu 的 mini **没有播放列表** |
| 图4（悬停任务栏图标的小窗） | 网易云 | 里面那个圆形图标是**红色**的（网易云 logo）；biu 的主色是**绿色**（`primaryColor: "#1ed760"`） |
| 图5（带子菜单的菜单） | 网易云 | biu 的托盘菜单**没有子菜单**（§3.2） |

**biu 的 mini 播放器实际长相**（`screenshots/mini.jpg`，我下载后看过）：

```
┌──────────────────────────────────────────────┐
│ ┌────────┐  在百万级录音棚听周杰伦《青…      │
│ │  封面  │  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░           │
│ └────────┘  ⟳   ⏮   ⏸   ⏭   ⤢              │
└──────────────────────────────────────────────┘
   约 320 × 100，横条，没有播放列表
```

→ **所以：你的图 = 网易云的观感；biu = 另一份"能跑通的 Electron 实现"。**
两份都要看：**网易云给"长什么样"，biu 给"代码怎么写"**。

---

## 五、对三轮计划的具体影响

| 轮次 | 改了什么 | 依据 |
|---|---|---|
| v2.0.3（播放条小修） | **没有影响** —— biu 没有这两处问题的对应实现可参考 | — |
| v2.1.0（mini 模式） | ① 新增"参考对照"一节，说明**为什么不照抄 biu 的独立小窗**；② 新增三条打磨项：拦 `WM_INITMENU`、拦 Ctrl+R、拦右键菜单；③ 明确 `body.mini` ≈ 它的 URL hash 模式标记 | §2.2 / §3.1 |
| v2.2.0（任务栏 + 托盘 + 关闭弹窗） | ① thumbar 写法**确认无误**（图标名 `prev/play/pause/next.png` 都对上了）；② 关闭行为的"正在退出"标记**改成 `app.on('before-quit')`**（比我原来的 `forceQuit` 覆盖更全）；③ 托盘图标从 `.png` 改成 **`.ico`**，加 `isEmpty()` 检查 + 创建前销毁 + `will-quit` 清理；④ `second-instance` 加 `if (isMinimized()) restore()`；⑤ 新增 `setWindowOpenHandler` 安全加固 + `uncaughtException` 兜底；⑥ 明确**不做**它的 `skipTaskbar` 独立小窗 | §2.1 / §2.4 / §2.5 / §2.6 / §3.1 / §3.3 |
