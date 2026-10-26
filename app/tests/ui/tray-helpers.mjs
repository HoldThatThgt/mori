// 系统托盘与主窗口的测试工具（docs/v0/screens/window.md"界面测试怎样碰到托盘"）。
// 托盘和托盘菜单没有界面元素，Playwright 点不到：这里在主进程里用 Node 的 inspector 会话按原型（Tray.prototype、
// Menu.prototype）找出 Mori 建的托盘和托盘菜单（有"Show App"和"Exit"的那个），发出托盘的 click、调用菜单项的 click()；
// 气泡（Tray.prototype.displayBalloon）只记下参数、不真的弹出，确认框（dialog.showMessageBox）记下参数后按测试给的按钮回答。
// src/ 里没有给测试用的入口。下面带 electron 模块参数的函数经 app.evaluate 序列化到主进程里运行，只能用参数和全局对象。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { appRoot, sleep } from './lib.mjs';

/** 第一次关窗口的气泡（照 Claude 的 QlSoWmoIH3、pYqTQaQNu2） */
export const NOTICE_TITLE = 'Mori runs in the system tray';
export const NOTICE_TEXT = 'Mori runs in the background even when you close the window. '
  + 'Click the Mori icon in the system tray to reopen the app, or right-click to quit.';
/** 第一次关窗口的提示显示过之后写下的标记文件（在数据目录里） */
export const NOTICE_MARKER = 'tray-notice-shown';
/** 托盘菜单的项（分隔线写作"—"） */
export const TRAY_ITEMS = ['Show App', '—', 'Exit'];
/** 退出前确认框的说明（照 Claude 的 V9Eb08nwTF），捕获会话数 */
export const QUIT_DETAIL = /^Mori is working in (\d+) sessions?\. Quitting now will interrupt that work\.$/;

/**
 * @brief 主进程里：找出托盘和托盘菜单，存到 globalThis.__moriTray、__moriTrayMenu。
 * @return { tray: 找到没销毁的托盘, items: 托盘菜单的项（分隔线写作"—"），没找到时为 null }
 */
async function locateTray({ Tray, Menu }) {
  const inspector = process.getBuiltinModule('node:inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) => new Promise((done, fail) => {
    session.post(method, params, (error, result) => (error ? fail(error) : done(result)));
  });
  globalThis.__moriFind = { Tray: Tray.prototype, Menu: Menu.prototype };
  try {
    await post('Runtime.enable');
    for (const name of ['Tray', 'Menu']) {
      const proto = await post('Runtime.evaluate', { expression: `globalThis.__moriFind.${name}` });
      const found = await post('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
      await post('Runtime.callFunctionOn', { objectId: found.objects.objectId,
        functionDeclaration: `function () { globalThis.__moriFound${name} = Array.from(this); }` });
    }
  } finally {
    session.disconnect();
    delete globalThis.__moriFind;
  }
  const labels = (menu) => menu.items.map((item) => (item.type === 'separator' ? '—' : item.label));
  globalThis.__moriTray = globalThis.__moriFoundTray.find((tray) => !tray.isDestroyed()) ?? null;
  globalThis.__moriTrayMenu = globalThis.__moriFoundMenu
    .find((menu) => labels(menu).includes('Show App') && labels(menu).includes('Exit')) ?? null;
  delete globalThis.__moriFoundTray;
  delete globalThis.__moriFoundMenu;
  const menu = globalThis.__moriTrayMenu;
  return { tray: Boolean(globalThis.__moriTray), items: menu ? labels(menu) : null };
}

/** @brief 找出 Mori 的托盘和托盘菜单（见 locateTray）；之后才能用 clickTrayIcon、clickTrayItem。 */
export function findTray(app) {
  return app.evaluate(locateTray);
}

/** @brief 主进程里：发出托盘图标的左键 click（参数同 Electron：事件、图标位置）。 */
function emitTrayClick() {
  if (!globalThis.__moriTray) throw new Error('Tray not located: call findTray first');
  globalThis.__moriTray.emit('click', {}, { x: 0, y: 0, width: 0, height: 0 });
}

/** @brief 左键点托盘图标。 */
export function clickTrayIcon(app) {
  return app.evaluate(emitTrayClick);
}

/** @brief 主进程里：调用托盘菜单里名为 label 的项的 click()。 */
function clickMenuItem(_electron, label) {
  const item = globalThis.__moriTrayMenu?.items.find((entry) => entry.label === label);
  if (!item) throw new Error(`Tray menu item not found: ${label}`);
  item.click();
}

/** @brief 点托盘菜单的一项（"Show App"、"Exit"）。点"Exit"后 Mori 可能马上退出，调用方自己处理 evaluate 的失败。 */
export function clickTrayItem(app, label) {
  return app.evaluate(clickMenuItem, label);
}

/** @brief 主进程里：气泡只记下参数（globalThis.__moriBalloons），不真的弹出。 */
function installBalloonRecorder({ Tray }) {
  if (globalThis.__moriBalloons) return;
  globalThis.__moriBalloons = [];
  Object.defineProperty(Tray.prototype, 'displayBalloon', { configurable: true, writable: true, value(options) {
    globalThis.__moriBalloons.push(options);
  } });
}

/** @brief 换掉托盘气泡：之后的气泡只记下参数，用 balloonCalls 读出。 */
export function recordBalloons(app) {
  return app.evaluate(installBalloonRecorder);
}

/** @brief 记下的气泡参数（{ iconType, title, content }）。 */
export function balloonCalls(app) {
  return app.evaluate(() => globalThis.__moriBalloons ?? []);
}

/** @brief 主进程里：确认框记下参数（globalThis.__moriBoxes），按 response（按钮序号）回答。 */
function installMessageBoxStub({ dialog }, response) {
  globalThis.__moriBoxes ??= [];
  globalThis.__moriBoxResponse = response;
  if (globalThis.__moriBoxStubbed) return;
  globalThis.__moriBoxStubbed = true;
  dialog.showMessageBox = async (...args) => {
    const options = args.find((arg) => arg && typeof arg === 'object' && 'message' in arg) ?? null;
    globalThis.__moriBoxes.push({ withParent: args.length > 1, options });
    return { response: globalThis.__moriBoxResponse, checkboxChecked: false };
  };
}

/** @brief 换掉确认框：之后弹的确认框按 response（按钮序号）回答，用 messageBoxes 读出参数。 */
export function stubMessageBox(app, response) {
  return app.evaluate(installMessageBoxStub, response);
}

/** @brief 记下的确认框（{ withParent: 挂在窗口上, options }）。 */
export function messageBoxes(app) {
  return app.evaluate(() => globalThis.__moriBoxes ?? []);
}

/** @brief 主进程里：主窗口（加载 Mori 页面的那个）的状态；没有时为 null。 */
function readWindowState({ BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  if (!main) return null;
  return { visible: main.isVisible(), minimized: main.isMinimized(), focused: main.isFocused() };
}

/**
 * @brief 主窗口的状态：{ visible, minimized, focused }，没有窗口时为 null。Windows 上最小化的窗口 visible 也是 false
 *        （Electron 的 isVisible 去掉了最小化），所以藏进托盘是 visible、minimized 都为 false。
 */
export function windowState(app) {
  return app.evaluate(readWindowState);
}

/** @brief 每 100 毫秒读一次主窗口的状态，直到 want(状态) 为真或超时；返回最后一次读到的状态和是否等到了。 */
export async function waitWindow(app, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = await windowState(app);
  while (!(state && want(state)) && Date.now() < deadline) {
    await sleep(100);
    state = await windowState(app);
  }
  return { state, ok: Boolean(state && want(state)) };
}

/** @brief 关掉主窗口（同点窗口的 ×；2026-10-26 起窗口藏进托盘，Mori 不退出）。 */
export function closeWindow(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    (windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0])?.close();
  });
}

/**
 * @brief 像你一样从托盘菜单退出：找出托盘、点"Exit"，等进程结束；timeoutMs 内没结束时返回 false。
 *        有会话正在生成时会弹确认框，调用方先用 stubMessageBox 给出回答。
 */
export async function exitFromTray(app, timeoutMs = 20000) {
  const exited = new Promise((done) => app.process().once('exit', () => done(true)));
  const found = await findTray(app).catch((error) => {
    console.error(`[tray-helpers] cannot locate the tray: ${error}`);
    return null;
  });
  if (!found?.items) return false;
  await clickTrayItem(app, 'Exit').catch(() => {});
  return Promise.race([exited, sleep(timeoutMs).then(() => false)]);
}

/**
 * @brief 用同一个数据目录再启动一次 Mori（不经 Playwright，同你双击图标）：返回它的退出码；timeoutMs 内没退出时
 *        结束它并返回 null。开发构建用 node_modules 里的 electron 启动 app 目录（MORI_APP_DIR 给出时用它）。
 */
export async function launchSecond({ exePath, userData, timeoutMs = 15000 }) {
  const appDir = process.env.MORI_APP_DIR ? resolve(process.env.MORI_APP_DIR) : appRoot;
  const command = exePath ?? createRequire(import.meta.url)('electron');
  const child = spawn(command, exePath ? [] : [appDir], { cwd: exePath ? undefined : appDir, stdio: 'ignore',
    env: { ...process.env, MORI_USER_DATA: userData } });
  const exited = new Promise((done) => child.once('exit', (code) => done(code)));
  const code = await Promise.race([exited, sleep(timeoutMs).then(() => undefined)]);
  if (code !== undefined) return code;
  console.error('[tray-helpers] the second Mori did not exit; killing it');
  child.kill();
  return null;
}
