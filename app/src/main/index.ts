// 主进程：窗口与安全限制、原生对话框，把 MessagePort 分给后台进程与界面，退出时有序关闭后台进程。

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, session, type IpcMainInvokeEvent } from 'electron';
import { registerFeedbackHandlers } from './feedback';
import { registerFileHandlers } from './files';
import { registerReviewHandlers } from './review';
import { currentKernel, lastKernelExitCode, piAgentDir, shutdownKernel, startKernel } from './kernel-process';

// 测试可以用 MORI_USER_DATA 把数据放到独立目录，避免碰到日常使用的配置。
if (process.env.MORI_USER_DATA) app.setPath('userData', process.env.MORI_USER_DATA);

// 只有开发构建才从开发服务器加载页面；打包后的程序忽略这个变量。
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;

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

/** @brief 为当前页面建立一条直连后台进程的通道。页面每次加载都重建；后台进程已退出时直接告诉页面。 */
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
  // 批准卡让任务栏闪烁（mori:attention），切回窗口时停止。
  window.on('focus', () => window.flashFrame(false));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(rendererFile);
  return window;
}

ipcMain.handle('mori:pick-folder', async (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
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
// 后台进程已先关闭这个会话；文件不存在（还没发过消息的新会话）时什么都不做。删不掉时把原文交回界面。
ipcMain.handle('mori:delete-session', async (event: IpcMainInvokeEvent, file: unknown) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  const target = sessionFilePath(file);
  if (!existsSync(target)) return { deleted: false, error: null };
  try {
    await rm(target);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot delete ${target}: ${message}`);
    return { deleted: false, error: message };
  }
  return { deleted: true, error: null };
});

// 后台进程意外退出后，界面上的"Restart"重启它并重连通道；页面不刷新，草稿等界面状态保留。
ipcMain.handle('mori:restart-kernel', (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  if (!currentKernel()) startKernel(notifyKernelExit);
  if (mainWindow) connectWindow(mainWindow);
});

// 出现批准卡时，窗口不在前台就让任务栏按钮闪烁（方案 5.7）。
ipcMain.handle('mori:attention', (event: IpcMainInvokeEvent) => {
  if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

registerFeedbackHandlers(isAppPage);
registerFileHandlers(isAppPage);
registerReviewHandlers(isAppPage);

void app.whenReady().then(() => {
  // 不用拼写检查：Chromium 默认按系统语言从 redirector.gvt1.com 下载词典，离线使用时不能有这种对外连接。
  session.defaultSession.setSpellCheckerLanguages([]);
  startKernel(notifyKernelExit);
  mainWindow = createWindow();
});

app.on('window-all-closed', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownKernel().finally(() => app.quit());
});
