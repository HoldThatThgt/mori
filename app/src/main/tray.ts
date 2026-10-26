// 系统托盘与退出（docs/v0/screens/window.md，照 Claude 桌面版）：关掉窗口时 Mori 藏进托盘、会话照常运行，第一次关时用托盘气泡
// 说一次；左键点图标打开窗口，右键菜单"Show App"/"Exit"；应用菜单的 File → Exit 与托盘的"Exit"同一个退出（同 Claude）：
// 有会话正在生成时先问（Claude 的说法），确认后才真正退出（有序关闭后台进程在 index.ts 的 will-quit 里）。
// 正在生成的会话数由界面报告（mori:busy-sessions），这里只记最后一次的数。

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, Menu, Tray, type BrowserWindow, type MessageBoxOptions } from 'electron';
// 托盘图标（临时图标，见 docs/v0/defaults.md"托盘图标"）：构建时复制进 out/main/chunks；Windows 用系统接口（LoadImage）
// 按路径读 .ico，打包时放进 app.asar.unpacked（electron-builder.yml 的 asarUnpack），让它读的是磁盘上的文件。
import trayIconPath from './assets/tray.ico?asset&asarUnpack';

/** 第一次关窗口的提示显示过之后写下的空标记文件（在 userData 里；临时默认值，见 docs/v0/defaults.md） */
const NOTICE_MARKER = 'tray-notice-shown';
/** "Exit"确认框里"Quit anyway"的序号 */
const QUIT_ANYWAY = 0;

let tray: Tray | null = null;
/** 界面最后一次报告的正在生成的会话数 */
let busySessions = 0;
/** "Exit"的确认框开着 */
let asking = false;

/** @brief 把窗口拿回前台：最小化的先还原，藏起的先显示，再给它焦点。 */
export function showWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/**
 * @brief 建托盘图标：悬停说明"Mori"，左键打开窗口，右键菜单"Show App"、"Exit"（Claude 的 Windows 托盘菜单）。
 * @param mainWindow 取当前的主窗口（还没建或已销毁时为 null）
 */
export function createTray(mainWindow: () => BrowserWindow | null): void {
  tray = new Tray(trayIconPath);
  tray.setToolTip('Mori');
  tray.on('click', () => showWindow(mainWindow()));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show App', click: () => showWindow(mainWindow()) },
    { type: 'separator' },
    { label: 'Exit', click: () => void confirmQuit(mainWindow()) },
  ]));
}

/**
 * @brief 应用菜单：Electron 默认菜单的 Edit、View、Window 照旧（同样的角色和快捷键），File 里只有"Exit"，与托盘菜单的
 *        "Exit"一样先问（Claude 的 File → Exit 也是）。Electron 默认的 Help（链接到 Electron 的网站）不要了。
 * @param mainWindow 取当前的主窗口（还没建或已销毁时为 null）
 */
export function createAppMenu(mainWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Exit', click: () => void confirmQuit(mainWindow()) }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

/** @brief 真正退出时去掉托盘图标，免得进程结束后图标还留在托盘里。 */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** @brief 记下界面报告的正在生成的会话数（侧栏状态 Running、Needs approval、Needs input 的会话）。 */
export function setBusySessions(count: number): void {
  busySessions = count;
}

/** @brief 关掉窗口：藏进托盘，后台进程和会话都不动；第一次时用托盘气泡说明 Mori 还在运行。 */
export function hideToTray(window: BrowserWindow): void {
  window.hide();
  noticeOnce();
}

/** @brief 第一次关窗口时弹托盘气泡（照 Claude 的 QlSoWmoIH3、pYqTQaQNu2），之后写下标记文件，以后不再弹。 */
function noticeOnce(): void {
  const marker = join(app.getPath('userData'), NOTICE_MARKER);
  if (!tray || existsSync(marker)) return;
  tray.displayBalloon({ iconType: 'info', title: 'Mori runs in the system tray',
    content: 'Mori runs in the background even when you close the window. '
      + 'Click the Mori icon in the system tray to reopen the app, or right-click to quit.' });
  try {
    writeFileSync(marker, '');
  } catch (error) {
    console.error(`[main] cannot write ${marker}: ${(error as Error).message}`);
  }
}

/** @brief 退出前的确认框（照 Claude 的 kdoUubpNNW、V9Eb08nwTF、j17BCr6YjW；没有"Wait for …"）。 */
function quitOptions(count: number): MessageBoxOptions {
  const sessions = count === 1 ? '1 session' : `${count} sessions`;
  return { type: 'warning', message: 'Mori is still working',
    detail: `Mori is working in ${sessions}. Quitting now will interrupt that work.`,
    buttons: ['Quit anyway', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true };
}

/**
 * @brief 托盘菜单与 File 菜单的"Exit"：没有会话正在生成时直接退出；有时先问，选"Quit anyway"才退出。确认框开着时再点
 *        不弹第二个。窗口开着时确认框挂在窗口上。别的退出（Playwright 的 app.close()、Windows 注销或关机）不经过这里。
 */
async function confirmQuit(window: BrowserWindow | null): Promise<void> {
  if (asking) return;
  if (busySessions === 0) {
    app.quit();
    return;
  }
  asking = true;
  try {
    const options = quitOptions(busySessions);
    const parent = window && !window.isDestroyed() && window.isVisible() ? window : null;
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === QUIT_ANYWAY) app.quit();
  } catch (error) {
    console.error(`[main] cannot ask before quitting: ${(error as Error).message}`);
  } finally {
    asking = false;
  }
}
