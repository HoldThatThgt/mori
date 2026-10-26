// 托盘的悬停说明与右键菜单（docs/v0/screens/window.md"运行中""托盘菜单"）。Electron 的 Tray 没有读取接口，
// 界面测试启动开发构建时用 -r 在 Mori 的主脚本之前载入这个文件（Electron 自带的 default_app 认 -r，Playwright 自己的
// loader 也是这样载入的），把 Tray.prototype 的 setToolTip、setContextMenu 换成先记下参数和调用它的托盘、再调原方法的
// 版本；记下的放在 globalThis.__moriTrayHook，由 tray-helpers.mjs 的 trayHook 读出。
// 打包程序（--exe）不经 default_app，不认 -r，载不进来；那时 trayHook 读到的是"没有载入"。src/ 里没有给测试用的入口。

'use strict';

/** 记下的调用：toolTips 为 [{ tray, text }]，menus 为 [{ tray, menu }]，按调用的顺序；换不了时 error 是原因 */
const calls = { toolTips: [], menus: [], error: null };
globalThis.__moriTrayHook = calls;

/**
 * @brief 把 Tray.prototype[name] 换成先把 { tray: this, [key]: 参数 } 记进 list、再调原方法的版本。
 * @param Tray electron 的 Tray 类
 * @param name 方法名
 * @param list 记录的数组
 * @param key 参数在记录里的名字
 */
function wrap(Tray, name, list, key) {
  const original = Tray.prototype[name];
  Object.defineProperty(Tray.prototype, name, { configurable: true, writable: true, value(arg) {
    list.push({ tray: this, [key]: arg });
    return original.call(this, arg);
  } });
}

// 换不了时不能让 Mori 起不来：记下原因（检查读到它就失败），照常启动
try {
  const { Tray } = require('electron');
  wrap(Tray, 'setToolTip', calls.toolTips, 'text');
  wrap(Tray, 'setContextMenu', calls.menus, 'menu');
} catch (error) {
  calls.error = String(error);
  console.error(`[tray-hook] cannot wrap Tray: ${calls.error}`);
}
