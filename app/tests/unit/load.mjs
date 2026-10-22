// 单元测试的加载工具：用 esbuild 把一个内核模块（TypeScript）打包成 ESM 文件放进 test-results/unit-bundles/，再导入。
// 依赖包（zod、pi 等）保持外部引用，从 app/node_modules 解析，所以打包结果写在 app 目录下而不是 data: URL（规格 §14.1）。

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/**
 * @brief 打包并导入一个内核模块。node --test 让每个测试文件在自己的进程里并行运行，几个文件可能同时打包同一个模块，
 *        所以打包结果按进程分开命名（否则一个进程可能导入另一个进程正在重写、还是空的文件），导入后删掉。
 * @param modulePath 相对 app/ 的源文件路径，例如 'src/kernel/selector.ts'
 * @return 模块的导出
 */
export async function loadKernelModule(modulePath) {
  mkdirSync(outDir, { recursive: true });
  const name = modulePath.replace(/[\\/]/g, '_').replace(/\.tsx?$/, '');
  const outfile = join(outDir, `${name}.${process.pid}.mjs`);
  await build({
    entryPoints: [join(appRoot, modulePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    outfile,
    logLevel: 'silent',
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
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
