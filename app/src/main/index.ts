// 主进程：窗口与安全限制、原生对话框，把 MessagePort 分给后台进程与界面，把窗口焦点告诉后台进程（你不在的计时），
// 退出时有序关闭后台进程。
// 2026-10-26 起照 Claude 桌面版（docs/v0/screens/window.md）：同一个数据目录只跑一个 Mori，再次启动时把窗口叫出来；
// 关掉窗口只是藏进系统托盘（tray.ts），会话照常运行；托盘菜单"Exit"等真正退出时才有序关闭后台进程。

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, session, type IpcMainInvokeEvent } from 'electron';
import { registerFeedbackHandlers } from './feedback';
import { registerFileHandlers } from './files';
import { registerIssuesHandlers } from './issues';
import { removeTeamDir, sessionIdOfFile, sessionIdOfName } from './teamDir';
import { currentKernel, lastKernelExitCode, piAgentDir, shutdownKernel, startKernel } from './kernel-process';
import { createAppMenu, createTray, destroyTray, hideToTray, setBusySessions, showWindow } from './tray';

// 测试可以用 MORI_USER_DATA 把数据放到独立目录，避免碰到日常使用的配置。
if (process.env.MORI_USER_DATA) app.setPath('userData', process.env.MORI_USER_DATA);

// Chromium 自带的文字（表单校验气泡、navigator.language）固定用英文，与界面一致；不写时按 Windows 显示语言选，
// 中文 Windows 上是中文。要在 ready 之前设（同安装包的 installerLanguages）。
app.commandLine.appendSwitch('lang', 'en-US');

// 只有开发构建才从开发服务器加载页面；打包后的程序忽略这个变量。
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;
/** 已经开始退出（before-quit 之后）：窗口的 close 不再藏起，照常关掉 */
let quitting = false;
/** 已经开始有序关闭后台进程 */
let shuttingDown = false;
/** 后台进程已经关好，可以真正退出 */
let kernelStopped = false;
/** 上次告诉后台进程的窗口焦点（docs/specs/file-system-permissions.md §9.1）；接上通道时清掉，还没发过为 null */
let sentFocus: boolean | null = null;

/** @brief 判断地址是否是 Mori 自己的页面；只有它能拿到后台进程的通道。 */
function isAppPage(url: string): boolean {
  if (devServerUrl) return new URL(url).origin === new URL(devServerUrl).origin;
  return url.split('#')[0] === pathToFileURL(rendererFile).href;
}

/** @brief 后台进程意外退出时通知页面。 */
function notifyKernelExit(code: number, quitting: boolean): void {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mori:kernel-exit', code);
}

/**
 * @brief 窗口焦点（你不在的计时，docs/specs/file-system-permissions.md §9.1）：按当前状态算窗口在不在前台
 *        （没销毁、有焦点、没最小化），与上次告诉后台进程的值不同时发 window_focus。后台进程不在时不发
 *        （重启后 connectWindow 补发）。分屏、设置页、DevTools 有焦点都不算，只看整个窗口。
 */
function sendFocus(window: BrowserWindow): void {
  const focused = !window.isDestroyed() && window.isFocused() && !window.isMinimized();
  const kernel = currentKernel();
  if (focused === sentFocus || !kernel) return;
  kernel.postMessage({ type: 'window_focus', focused });
  sentFocus = focused;
}

/**
 * @brief 为当前页面建立一条直连后台进程的通道。页面每次加载都重建；后台进程已退出时直接告诉页面。
 *        接上之后把窗口焦点再告诉后台进程一次：新起的后台进程不知道窗口状态，值没变也要发（§9.1）。
 */
function connectWindow(window: BrowserWindow): void {
  if (!isAppPage(window.webContents.getURL())) {
    console.error(`[main] refused to connect page ${window.webContents.getURL()}`);
    return;
  }
  const kernel = currentKernel();
  if (!kernel) {
    window.webContents.send('mori:kernel-exit', lastKernelExitCode() ?? -1);
    return;
  }
  const { port1, port2 } = new MessageChannelMain();
  kernel.postMessage({ type: 'port' }, [port1]);
  window.webContents.postMessage('mori:port', null, [port2]);
  sentFocus = null;
  sendFocus(window);
}

/**
 * @brief 禁止页面跳转、弹新窗口、嵌入 webview 和申请权限。唯一的例外：Mori 自己的页面写剪贴板
 *        （代码块上的"Copy code"用浏览器的剪贴板接口，Chromium 按 clipboard-sanitized-write 申请）。
 */
function lockDown(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && isAppPage(details.requestingUrl));
  });
}

/** @brief 创建主窗口。 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Mori',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true,
      spellcheck: false },
  });
  lockDown(window);
  window.webContents.on('did-finish-load', () => connectWindow(window));
  // 批准卡让任务栏闪烁（mori:attention），切回窗口时停止。四个事件都重算窗口焦点交给后台进程（§9.1）；
  // 藏进托盘时窗口失去焦点（blur），同样算你不在。
  window.on('focus', () => {
    window.flashFrame(false);
    sendFocus(window);
  });
  window.on('blur', () => sendFocus(window));
  window.on('minimize', () => sendFocus(window));
  window.on('restore', () => sendFocus(window));
  // 关掉窗口（×、Alt+F4、任务栏的"Close window"）只是藏进托盘；真正退出时（before-quit 之后）照常关掉。
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideToTray(window);
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(rendererFile);
  return window;
}

ipcMain.handle('mori:pick-folder', async (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  // 标题和按钮写明英文（"Open folder…"和"Add plugin from folder…"共用）；不写时是 Windows 按显示语言给的"Select Folder"。
  const options: Electron.OpenDialogOptions = { title: 'Select a folder', buttonLabel: 'Select folder',
    properties: ['openDirectory'] };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

/** @brief 检查路径是 pi 会话目录（`<agentDir>/sessions`）里的会话文件，返回绝对路径；不是时抛错。 */
function sessionFilePath(file: unknown): string {
  const sessionsDir = join(piAgentDir(), 'sessions');
  const target = typeof file === 'string' ? resolve(file) : '';
  const inside = relative(sessionsDir, target);
  if (!target.toLowerCase().endsWith('.jsonl') || !inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`Not a session file: ${String(file)}`);
  }
  return target;
}

// 删除会话：照 Claude 桌面版永久删除会话文件（方案第 4 节"会话归档与删除"由 Mori 负责；归档只在界面记下）。
// 后台进程已先关闭这个会话；文件不存在（还没发过消息的新会话）时不删文件。删不掉时把原文交回界面。
// 删掉会话文件之后，按它第一行里的会话 id 一并删除 <userData>/teams/<id>/（平行 Agent 规格 §11.5，teamDir.ts）；
// 还没写盘的会话按文件名里的 id 删。
ipcMain.handle('mori:delete-session', async (event: IpcMainInvokeEvent, file: unknown) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  const target = sessionFilePath(file);
  if (!existsSync(target)) {
    const unsaved = sessionIdOfName(target);
    return { deleted: false, error: unsaved === null ? null : await removeTeamDir(app.getPath('userData'), unsaved) };
  }
  const sessionId = await sessionIdOfFile(target);
  try {
    await rm(target);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot delete ${target}: ${message}`);
    return { deleted: false, error: message };
  }
  const error = sessionId === null ? null : await removeTeamDir(app.getPath('userData'), sessionId);
  return { deleted: true, error };
});

// 后台进程意外退出后，界面上的"Restart"重启它并重连通道；页面不刷新，草稿等界面状态保留。
ipcMain.handle('mori:restart-kernel', (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  if (!currentKernel()) startKernel(notifyKernelExit);
  if (mainWindow) connectWindow(mainWindow);
});

// 出现批准卡时，窗口不在前台就让任务栏按钮闪烁（方案 5.7）。窗口藏在托盘里时任务栏上没有它的按钮：
// 先以最小化的样子放回任务栏（不抢焦点、不弹到前面），再闪烁（docs/v0/screens/window.md）。
ipcMain.handle('mori:attention', (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  if (!mainWindow.isVisible()) mainWindow.minimize();
  mainWindow.flashFrame(true);
});

// 界面报告正在生成的会话数（变了才发）；托盘菜单的"Exit"按它决定先不先问。只收 Mori 自己的页面发来的、不小于 0 的整数。
ipcMain.on('mori:busy-sessions', (event, count: unknown) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) {
    console.error('[main] refused mori:busy-sessions from another page');
    return;
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    console.error(`[main] invalid busy session count: ${String(count)}`);
    return;
  }
  setBusySessions(count);
});

registerFeedbackHandlers(isAppPage);
registerFileHandlers(isAppPage);
registerIssuesHandlers(isAppPage);

/** @brief 拿到单实例锁之后启动：后台进程、主窗口和托盘图标。 */
function startApp(): void {
  // 不用拼写检查：Chromium 默认按系统语言从 redirector.gvt1.com 下载词典，离线使用时不能有这种对外连接。
  session.defaultSession.setSpellCheckerLanguages([]);
  startKernel(notifyKernelExit);
  createAppMenu(() => mainWindow);
  mainWindow = createWindow();
  createTray(() => mainWindow);
}

// 同一个数据目录只跑一个 Mori（Electron 的锁按 userData，所以要在上面设好 MORI_USER_DATA 之后）：
// 再次启动时第二个进程把窗口叫出来后马上退出，不起第二个后台进程。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow(mainWindow));
  void app.whenReady().then(startApp);
}

// 开始真正退出（托盘或 File 菜单的"Exit"、测试的 app.quit()）：之后窗口的 close 照常关掉，托盘图标马上去掉。
// Windows 注销或关机时不发 before-quit、will-quit（Electron 的说明），进程直接被结束，后台进程和它的命令随作业对象结束。
app.on('before-quit', () => {
  quitting = true;
  destroyTray();
});

// 窗口都关掉之后、进程结束之前：先有序关闭后台进程（释放会话、结束它的作业），再退出。
app.on('will-quit', (event) => {
  if (kernelStopped) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  // 再退出要放到下一轮事件循环：Electron 在 will-quit 的处理返回之后才复位"正在退出"，在那之前 app.quit() 不起作用。
  // 后台进程已经不在（意外退出后点"Exit"）时 shutdownKernel 马上返回，直接 app.quit() 会让 Mori 没有窗口、没有托盘图标
  // 却一直不退出（还占着单实例锁，再启动也打不开）。
  void shutdownKernel().finally(() => {
    kernelStopped = true;
    setImmediate(() => app.quit());
  });
});
