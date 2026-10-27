// M2 整机测试（m2-app.mjs）在主进程里运行的函数：经 app.evaluate 序列化，只能用参数里的 electron 模块；pollMain 在
// 测试进程里反复求其中一个。2026-10-27 合并文件系统分支后 m2-app.mjs 超过 2000 行，从那里原样挪出来。

import { sleep } from './lib.mjs';

/** @brief 记录主窗口 flashFrame 的调用，再开一个小窗口把焦点抢走。 */
export function installFlashRecorder({ BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const proto = BrowserWindow.prototype;
  const original = proto.flashFrame;
  const state = { calls: [], descriptor: Object.getOwnPropertyDescriptor(proto, 'flashFrame'), mainId: main.id };
  Object.defineProperty(proto, 'flashFrame', { configurable: true, writable: true, value(flag) {
    state.calls.push({ id: this.id, flag });
    return original.call(this, flag);
  } });
  const helper = new BrowserWindow({ width: 320, height: 200, x: 40, y: 40, title: 'focus helper' });
  helper.focus();
  state.helperId = helper.id;
  globalThis.__m2Flash = state;
}

/** @brief 主窗口现在有没有焦点。 */
export function mainFocused({ BrowserWindow }) {
  return BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.isFocused() ?? false;
}

/** @brief 记下的主窗口 flashFrame 调用（true / false 序列）。 */
export function flashCalls() {
  const { calls, mainId } = globalThis.__m2Flash;
  return calls.filter((call) => call.id === mainId).map((call) => call.flag);
}

/** @brief 关掉小窗口，把焦点交回主窗口。 */
export function focusMain({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  BrowserWindow.fromId(state.helperId)?.destroy();
  const main = BrowserWindow.fromId(state.mainId);
  main?.show();
  main?.focus();
}

/** @brief 系统不肯把焦点交给 Mori 时（测试进程不在前台），直接发出主窗口的 focus 事件。 */
export function emitMainFocus({ BrowserWindow }) {
  BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.emit('focus');
}

/** @brief 让主窗口回到桌面上（最小化的先还原，藏起的先显示），后面的步骤照常操作页面。 */
export function showMain({ BrowserWindow }) {
  const main = BrowserWindow.fromId(globalThis.__m2Flash?.mainId ?? -1) ?? BrowserWindow.getAllWindows()[0];
  if (main?.isMinimized()) main.restore();
  if (main && !main.isVisible()) main.show();
  main?.focus();
}

/** @brief 恢复 flashFrame，关掉小窗口，停止闪烁。 */
export function restoreFlash({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  if (!state) return;
  BrowserWindow.fromId(state.helperId)?.destroy();
  if (state.descriptor) Object.defineProperty(BrowserWindow.prototype, 'flashFrame', state.descriptor);
  else delete BrowserWindow.prototype.flashFrame;
  BrowserWindow.fromId(state.mainId)?.flashFrame(false);
  delete globalThis.__m2Flash;
}

/** @brief 把 shell.showItemInFolder 换成只记路径的版本；换不了时返回 false。 */
export function stubShowItem({ shell }) {
  globalThis.__m2Shown = [];
  const stub = (path) => { globalThis.__m2Shown.push(path); };
  try {
    shell.showItemInFolder = stub;
  } catch {
    // 只读属性时下面改用 defineProperty
  }
  if (shell.showItemInFolder !== stub) {
    try {
      Object.defineProperty(shell, 'showItemInFolder', { value: stub, configurable: true, writable: true });
    } catch {
      return false;
    }
  }
  return shell.showItemInFolder === stub;
}

/** @brief 把主窗口改成 width×height（content 为真时是内容区大小），返回改之前的位置和大小。 */
export function resizeMain({ BrowserWindow }, { width, height, content }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const bounds = main.getBounds();
  if (main.isMaximized()) main.unmaximize();
  if (content) main.setContentSize(width, height);
  else main.setSize(width, height);
  return bounds;
}

/** @brief 恢复主窗口的位置和大小。 */
export function restoreMain({ BrowserWindow }, bounds) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  main.setBounds(bounds);
}

/**
 * @brief 把主进程保存报告的处理（ipcMain.handle('mori:save-issue')）包一层，先等 ms 毫秒再保存；
 *        Electron 没有公开取回处理函数的接口，这里用 ipcMain 内部的 _invokeHandlers。换不了时返回 false。
 */
export function delayIssueSave({ ipcMain }, ms) {
  const handlers = ipcMain._invokeHandlers;
  const original = handlers?.get('mori:save-issue');
  if (!original) return false;
  globalThis.__m2SaveIssue = original;
  handlers.set('mori:save-issue', async (event, ...args) => {
    await new Promise((done) => setTimeout(done, ms));
    return original(event, ...args);
  });
  return true;
}

/** @brief 恢复原来的保存报告处理。 */
export function restoreIssueSave({ ipcMain }) {
  if (globalThis.__m2SaveIssue) ipcMain._invokeHandlers.set('mori:save-issue', globalThis.__m2SaveIssue);
  delete globalThis.__m2SaveIssue;
}

/** @brief 每 100 毫秒在主进程里求一次 fn，直到为真或超时。 */
export async function pollMain(app, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.evaluate(fn)) return true;
    await sleep(100);
  }
  return false;
}
