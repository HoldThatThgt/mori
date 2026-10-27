// 界面状态模块（app/src/renderer/src/state/*.ts）的单元测试加载工具（docs/specs/file-system.md §19.1 的单元层）：
// 几个模块合成一个入口、用 esbuild 打成一个 ESM 文件再导入，所以它们共用同一个 zustand 仓库（useApp）。
// 与 tests/unit/load.mjs 的区别：渲染进程的模块图里有组件（.css 换成空模块）和载入时就碰浏览器的代码
// （state/memory.ts 在载入时调 window.mori.onEvent，state/archive.ts 读 localStorage），所以导入前装上替身：
// window.mori 的 request 记下每条命令并交给测试设的处理函数，localStorage 是内存里的一张表。替身是 synthetic。

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** @brief 主进程"删除会话文件"替身的默认结果：删掉了。 */
const deletedOk = async () => ({ deleted: true, error: null });

/**
 * @brief 测试与替身之间的桥：commands 是界面发出的命令（按先后），handler 决定每条命令的结果
 *        （返回值或抛错，可以是 async）。默认的处理函数拒绝一切，测试按需要换掉。
 *        主进程的"删除会话文件"（window.mori.deleteSessionFile）记进 deletedFiles，结果由 deleteFile 给。
 */
export const bridge = {
  /** 界面经 window.mori.request 发出的命令 */
  commands: [],
  /** 处理一条命令；返回结果或抛错 */
  handler: async (command) => {
    throw new Error(`no handler for ${command.type}`);
  },
  /** 界面要主进程删除的会话文件（按先后） */
  deletedFiles: [],
  /** 删除一个会话文件的结果（{ deleted, error }）；默认删掉了 */
  deleteFile: deletedOk,
  /** 清空记下的命令与文件，换上新的处理函数，删除文件的结果回到默认 */
  reset(handler) {
    this.commands.length = 0;
    this.deletedFiles.length = 0;
    this.deleteFile = deletedOk;
    this.handler = handler ?? (async (command) => {
      throw new Error(`no handler for ${command.type}`);
    });
  },
};

/** @brief 内存里的 localStorage（synthetic）。 */
function memoryStorage() {
  const table = new Map();
  return {
    getItem: (key) => (table.has(key) ? table.get(key) : null),
    setItem: (key, value) => { table.set(key, String(value)); },
    removeItem: (key) => { table.delete(key); },
    clear: () => { table.clear(); },
    key: (index) => [...table.keys()][index] ?? null,
    get length() { return table.size; },
  };
}

/** @brief 装上浏览器的替身（只装一次）：window.mori（含删除会话文件）、window 的事件订阅、localStorage。 */
function installBrowserStubs() {
  if (globalThis.window?.mori) return;
  const noop = () => () => {};
  globalThis.window = {
    mori: {
      request: async (command) => {
        bridge.commands.push(command);
        return bridge.handler(command);
      },
      onEvent: noop, onKernelExit: noop, onKernelReady: noop,
      deleteSessionFile: async (file) => {
        bridge.deletedFiles.push(file);
        return bridge.deleteFile(file);
      },
    },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  globalThis.localStorage = memoryStorage();
}

/**
 * @brief 把几个界面模块打成一个包并导入：入口按名字逐个 `export * as <名字> from '<路径>'`。
 *        node --test 让每个测试文件在自己的进程里并行运行，所以打包结果按进程命名，导入后删掉（同 load.mjs）。
 * @param modules 名字 → 相对 app/ 的源文件路径，例如 { workspace: 'src/renderer/src/state/workspace.ts' }
 * @return 名字 → 那个模块的导出
 */
export async function loadRendererModules(modules) {
  installBrowserStubs();
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `renderer-state.${process.pid}.mjs`);
  const contents = Object.entries(modules)
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(`./${path}`)};`).join('\n');
  await build({
    stdin: { contents, resolveDir: appRoot, sourcefile: 'renderer-entry.mjs', loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    loader: { '.css': 'empty' },
    outfile,
    logLevel: 'silent',
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}
