// 系统托盘与主窗口的测试工具（docs/v0/screens/window.md"界面测试怎样碰到托盘"）。
// 托盘和托盘菜单没有界面元素，Playwright 点不到：这里在主进程里用 Node 的 inspector 会话按原型（Tray.prototype、
// Menu.prototype）找出 Mori 建的托盘和托盘菜单（有"Show App"和"Exit"的那个），发出托盘的 click、调用菜单项的 click()；
// 气泡（Tray.prototype.displayBalloon）只记下参数、不真的弹出，确认框（dialog.showMessageBox）记下参数后按测试给的按钮回答。
// src/ 里没有给测试用的入口。下面带 electron 模块参数的函数经 app.evaluate 序列化到主进程里运行，只能用参数和全局对象。
// 2026-10-26（WP-20 状态表各行的用例）：悬停说明与右键菜单经 tray-hook.cjs（开发构建启动时 -r 载入）记下的调用读出；
// 确认框可以先不回答（holdMessageBox，测"确认框开着时又点 Exit"）；主窗口的状态多了位置和大小，focus 的调用可以数。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { appRoot, sleep } from './lib.mjs';

/** 开发构建启动时用 -r 载入的托盘记录脚本（打包程序不认 -r） */
export const TRAY_HOOK = resolve(import.meta.dirname, 'tray-hook.cjs');

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

/** @brief 有 count 个会话正在生成时确认框说明的原文（1 个时是单数 "1 session"，window.md"退出，有会话正在生成"）。 */
export const quitDetail = (count) => `Mori is working in ${count === 1 ? '1 session' : `${count} sessions`}. `
  + 'Quitting now will interrupt that work.';

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
  // 按原型找到的不全是真正的实例（原生方法对它们报"Illegal invocation"，也没有 items），这些跳过
  const labels = (menu) => (Array.isArray(menu.items)
    ? menu.items.map((item) => (item.type === 'separator' ? '—' : item.label)) : []);
  const alive = (tray) => {
    try {
      return !tray.isDestroyed();
    } catch {
      return false;
    }
  };
  globalThis.__moriTray = globalThis.__moriFoundTray.find(alive) ?? null;
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

/**
 * @brief 主进程里：tray-hook.cjs 记下的调用，与 findTray 找到的托盘、托盘菜单比对。
 * @return 没有载入时 { loaded: false }；否则 { loaded, toolTips: 悬停说明的参数, toolTipOnTray: 都是对找到的托盘调的,
 *         menuCalls: setContextMenu 的次数, menuItems: 最后一次交给托盘的菜单的项（分隔线写作"—"）,
 *         sameMenu: 那份菜单就是 clickTrayItem 点的对象, sameTray: 是对找到的托盘调的 }
 */
function readTrayHook() {
  const calls = globalThis.__moriTrayHook;
  if (!calls) return { loaded: false };
  const labels = (menu) => (Array.isArray(menu?.items)
    ? menu.items.map((item) => (item.type === 'separator' ? '—' : item.label)) : null);
  const tray = globalThis.__moriTray ?? null;
  const last = calls.menus.at(-1) ?? null;
  return { loaded: true, error: calls.error, toolTips: calls.toolTips.map((call) => call.text),
    toolTipOnTray: calls.toolTips.length > 0 && calls.toolTips.every((call) => call.tray === tray),
    menuCalls: calls.menus.length, menuItems: labels(last?.menu),
    sameMenu: Boolean(last) && last.menu === globalThis.__moriTrayMenu, sameTray: Boolean(last) && last.tray === tray };
}

/** @brief 托盘的悬停说明与右键菜单（见 readTrayHook）；先调用 findTray。只有开发构建载入了 tray-hook.cjs。 */
export function trayHook(app) {
  return app.evaluate(readTrayHook);
}

/** 应用菜单的顶层项与 File 里的项（Electron 默认的 Edit、View、Window 照旧，File 里只有"Exit"，没有 Help） */
export const APP_MENU = { top: ['File', 'Edit', 'View', 'Window'], file: ['Exit'] };

/** @brief 主进程里：应用菜单的顶层项和 File 里的项（分隔线写作"—"）；没有应用菜单时为 null。 */
function readAppMenu({ Menu }) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return null;
  const labels = (items) => items.map((item) => (item.type === 'separator' ? '—' : item.label));
  const file = menu.items.find((item) => item.label === 'File');
  return { top: labels(menu.items), file: file?.submenu ? labels(file.submenu.items) : null };
}

/** @brief 应用菜单的项：{ top: 顶层项, file: File 里的项 }。 */
export function appMenu(app) {
  return app.evaluate(readAppMenu);
}

/** @brief 主进程里：调用应用菜单 File 里"Exit"的 click()（同你从菜单栏点 File → Exit）。 */
function clickFileExitItem({ Menu }) {
  const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File');
  const exit = file?.submenu?.items.find((item) => item.label === 'Exit');
  if (!exit) throw new Error('File > Exit not found in the application menu');
  exit.click();
}

/** @brief 点应用菜单的 File → Exit（同托盘菜单的"Exit"，有会话正在生成时先问）。点后 Mori 可能马上退出。 */
export function clickFileExit(app) {
  return app.evaluate(clickFileExitItem);
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

/**
 * @brief 主进程里：确认框记下参数（globalThis.__moriBoxes），按 response（按钮序号）回答；response 为 null 时先不回答，
 *        确认框一直开着，直到 releaseMessageBox 给出回答。
 */
function installMessageBoxStub({ dialog }, response) {
  globalThis.__moriBoxes ??= [];
  globalThis.__moriBoxResponse = response;
  if (globalThis.__moriBoxStubbed) return;
  globalThis.__moriBoxStubbed = true;
  dialog.showMessageBox = async (...args) => {
    const options = args.find((arg) => arg && typeof arg === 'object' && 'message' in arg) ?? null;
    globalThis.__moriBoxes.push({ withParent: args.length > 1, options });
    const answer = globalThis.__moriBoxResponse !== null ? globalThis.__moriBoxResponse
      : await new Promise((done) => { globalThis.__moriBoxRelease = done; });
    return { response: answer, checkboxChecked: false };
  };
}

/** @brief 换掉确认框：之后弹的确认框按 response（按钮序号）回答，用 messageBoxes 读出参数。 */
export function stubMessageBox(app, response) {
  return app.evaluate(installMessageBoxStub, response);
}

/** @brief 换掉确认框，之后弹的确认框先不回答、一直开着（releaseMessageBox 回答）。 */
export function holdMessageBox(app) {
  return app.evaluate(installMessageBoxStub, null);
}

/** @brief 主进程里：用 response 回答开着的确认框，之后的确认框也按它马上回答；返回有没有开着的确认框。 */
function releaseBox(_electron, response) {
  globalThis.__moriBoxResponse = response;
  const release = globalThis.__moriBoxRelease;
  delete globalThis.__moriBoxRelease;
  release?.(response);
  return Boolean(release);
}

/** @brief 按 response（按钮序号）回答 holdMessageBox 之后开着的确认框；返回有没有开着的确认框。 */
export function releaseMessageBox(app, response) {
  return app.evaluate(releaseBox, response);
}

/** @brief 记下的确认框（{ withParent: 挂在窗口上, options }）。 */
export function messageBoxes(app) {
  return app.evaluate(() => globalThis.__moriBoxes ?? []);
}

/** @brief 每 100 毫秒读一次记下的确认框，直到有 count 个或超时；返回最后读到的。 */
export async function waitMessageBoxes(app, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let boxes = await messageBoxes(app);
  while (boxes.length < count && Date.now() < deadline) {
    await sleep(100);
    boxes = await messageBoxes(app);
  }
  return boxes;
}

/** @brief 主进程里：主窗口（加载 Mori 页面的那个）的状态；没有时为 null。 */
function readWindowState({ BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  if (!main) return null;
  return { visible: main.isVisible(), minimized: main.isMinimized(), focused: main.isFocused(),
    bounds: main.getBounds() };
}

/**
 * @brief 主窗口的状态：{ visible, minimized, focused, bounds（位置和大小） }，没有窗口时为 null。Windows 上最小化的
 *        窗口 visible 也是 false（Electron 的 isVisible 去掉了最小化），所以藏进托盘是 visible、minimized 都为 false。
 */
export function windowState(app) {
  return app.evaluate(readWindowState);
}

/**
 * @brief 主进程里：把 BrowserWindow.prototype.focus 换成先数主窗口的调用、再调原方法的版本（showWindow 给窗口焦点用的
 *        就是它；同 m2-app 记 flashFrame 的写法，按窗口 id 认主窗口）；已经换过时不再换。测试进程不在前台时 Windows
 *        不把焦点交给 Mori，所以测试数调用，不看 isFocused。
 */
function installFocusCounter({ BrowserWindow }) {
  if (globalThis.__moriFocus) return;
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  if (!main) return;
  const original = BrowserWindow.prototype.focus;
  globalThis.__moriFocus = { calls: 0, id: main.id };
  Object.defineProperty(BrowserWindow.prototype, 'focus', { configurable: true, writable: true, value(...args) {
    if (this.id === globalThis.__moriFocus.id) globalThis.__moriFocus.calls += 1;
    return original.apply(this, args);
  } });
}

/** @brief 开始数主窗口 focus 的调用（focusCalls 读出）。 */
export function countFocus(app) {
  return app.evaluate(installFocusCounter);
}

/** @brief countFocus 之后主窗口 focus 被调用的次数。 */
export function focusCalls(app) {
  return app.evaluate(() => globalThis.__moriFocus?.calls ?? 0);
}

/** @brief 主窗口在桌面上（显示着、没有最小化）；waitWindow 的 want。 */
export const onScreen = (state) => state.visible && !state.minimized;
/** @brief 主窗口藏进托盘（不显示、也不是最小化）；waitWindow 的 want。 */
export const offScreen = (state) => !state.visible && !state.minimized;

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
