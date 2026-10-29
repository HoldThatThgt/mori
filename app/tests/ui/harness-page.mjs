// 回放页面（tests/ui/harness）的构建，所有回放套件与快速集共用一份（docs/v1/test-strategy.md §3.4）。
// 原来每个回放套件各自用 vite 把同样的输入建进自己的 test-results/harness-*，一遍回归建十几次、每次约 14 秒。
// 现在按输入（stamp.mjs 的 HARNESS_INPUTS：src/renderer、src/shared、harness、fixture、package-lock.json）的哈希建在
// test-results/harness-page/<哈希前 16 位>/，输入不变就直接用。先建到临时目录再改名，两个进程同时建同一份时后到的丢掉
// 自己的那份；建新的一份之后删掉别的哈希目录（还有进程在用时删不掉，跳过）。

import react from '@vitejs/plugin-react';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { build } from 'vite';
import { appRoot, HARNESS_INPUTS, treeHash } from './stamp.mjs';

/** 回放页面的源码目录 */
export const harnessDir = join(appRoot, 'tests/ui/harness');
/** 各份构建的上一级目录 */
const pagesDir = join(appRoot, 'test-results', 'harness-page');
/** 这次的输入对应的构建目录（模块载入时按输入算好；套件在这之后不改输入） */
export const harnessOut = join(pagesDir, treeHash(HARNESS_INPUTS).slice(0, 16));

/** @brief 删掉别的哈希目录（旧的输入建的）；这次输入的临时目录（别的进程正在建）不动；删不掉时跳过。 */
function removeOtherPages() {
  for (const name of readdirSync(pagesDir)) {
    const path = join(pagesDir, name);
    if (name.startsWith(basename(harnessOut))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      console.error(`[harness-page] cannot remove ${path}: ${error.message}`);
    }
  }
}

/**
 * @brief 保证这次输入的回放页面已经建好（没有时建一份）。
 * @return harnessOut（里面有 index.html 与 assets/）
 */
export async function ensureHarness() {
  if (existsSync(join(harnessOut, 'index.html'))) return harnessOut;
  mkdirSync(pagesDir, { recursive: true });
  const temp = `${harnessOut}.tmp-${process.pid}`;
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir: temp, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
  if (existsSync(join(harnessOut, 'index.html'))) rmSync(temp, { recursive: true, force: true });
  else renameSync(temp, harnessOut);
  removeOtherPages();
  return harnessOut;
}

// 直接运行时只建页面（快速集与 run.mjs 在起回放之前调用一次）
if (process.argv[1] && resolve(import.meta.filename) === resolve(process.argv[1])) {
  console.log(`harness page ready: ${await ensureHarness()}`);
}
