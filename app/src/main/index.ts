// 主进程：窗口与安全限制、原生对话框，把 MessagePort 分给后台进程与界面，退出时有序关闭后台进程。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, type IpcMainInvokeEvent } from 'electron';
import { currentKernel, lastKernelExitCode, shutdownKernel, startKernel } from './kernel-process';

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

/** @brief 禁止页面跳转、弹新窗口、嵌入 webview 和申请权限。 */
function lockDown(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

/** @brief 创建主窗口。 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Mori',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  });
  lockDown(window);
  window.webContents.on('did-finish-load', () => connectWindow(window));
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

void app.whenReady().then(() => {
  startKernel(notifyKernelExit);
  mainWindow = createWindow();
});

app.on('window-all-closed', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownKernel().finally(() => app.quit());
});
