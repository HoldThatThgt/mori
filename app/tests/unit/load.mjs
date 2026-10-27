// 单元测试的加载工具：用 esbuild 把一个内核模块（TypeScript）打包成 ESM，再导入。
// 依赖包（zod、pi 等）保持外部引用，从 app/node_modules 解析，所以打包结果的地址在 app 目录下（test-results/unit-bundles/），
// 而不是 data: URL（规格 §14.1）。打包结果不写盘：经 node:module 的 registerHooks 从内存交给加载器（地址仍是那个目录下
// 按进程命名的文件，外部依赖照常从 app/node_modules 解析）。写盘再导入时杀毒软件要先扫一遍新写的脚本（本机几百 KB 的包
// 每个要多等几十到上百毫秒、多占一些 CPU），整组单元测试并行时这些开销会叠起来。

import { build } from 'esbuild';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** 内存里的打包结果：虚拟文件的地址（不带查询串）→ 源码；进程结束时随之没有 */
const sources = new Map();
/** 加载钩子是否已装上（每个进程装一次） */
let hooked = false;
/** 导入的次数：查询串里带上它，同一毫秒里导入两次也各得一份全新的模块状态 */
let imports = 0;

/** @brief 地址去掉查询串。 */
function plain(url) {
  const at = url.indexOf('?');
  return at < 0 ? url : url.slice(0, at);
}

/** @brief 装上加载钩子：内存里有的地址由它解析、交出源码，其余照常。 */
function hookOnce() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (sources.has(plain(specifier))) return { url: specifier, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = sources.get(plain(url));
      if (source === undefined) return nextLoad(url, context);
      return { format: 'module', source, shortCircuit: true };
    },
  });
}

/**
 * @brief 用 esbuild 打包（不写盘），把结果放进内存，返回它的地址（test-results/unit-bundles/<name>.<进程号>.mjs，文件不存在）。
 *        默认选项同原来的写法：bundle、esm、node22、依赖包外部引用；options 可以换掉或补上（stdin、loader、plugins）。
 *        同一个地址可以按不同的查询串导入多次，各得一份全新的模块状态（freshUrl）。
 * @param options esbuild 的选项（不含 outfile、write）
 * @param name 文件名（不含进程号与扩展名）
 * @return 地址（不带查询串）
 */
export async function bundleInMemory(options, name) {
  hookOnce();
  const outfile = join(outDir, `${name}.${process.pid}.mjs`);
  const result = await build({
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', logLevel: 'silent',
    ...options, outfile, write: false,
  });
  const url = pathToFileURL(outfile).href;
  sources.set(url, result.outputFiles[0].text);
  return url;
}

/** @brief 地址加上这次导入独有的查询串（全新的模块状态）。 */
export function freshUrl(url) {
  imports += 1;
  return `${url}?t=${Date.now()}-${imports}`;
}

/**
 * @brief 打包并导入一个内核模块。node --test 让每个测试文件在自己的进程里并行运行，打包结果在各自进程的内存里。
 * @param modulePath 相对 app/ 的源文件路径，例如 'src/kernel/selector.ts'
 * @return 模块的导出
 */
export async function loadKernelModule(modulePath) {
  const name = modulePath.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '');
  const url = await bundleInMemory({ entryPoints: [join(appRoot, modulePath)] }, name);
  return import(freshUrl(url));
}

/**
 * @brief 可控的假时钟：纯函数都以参数接收 now()（规格 §12），测试用它推进时间。
 * @param start 起始时刻（毫秒）
 */
export function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) { current += ms; return current; },
    set(ms) { current = ms; return current; },
  };
}
