// 用真实 git 的单元测试共用的 git 可执行文件：Git for Windows 真正的 git（<安装目录>\mingw64\bin\git.exe），没有时退回
// PATH 里的 git。cmd\git.exe 只是启动器，每次调用多一个进程；PowerShell 的 PATH 里通常只有它，Git Bash 的 PATH 里真正的 git 在前，
// 两种 shell 里跑 test:fs-unit 的进程数与耗时因此不同。场景测试（快照、运行记录、Rewind）测的是 Mori 的逻辑，和用哪个 git 无关，
// 一律用真正的 git；测启动器本身（FS-02 结束进程树、FS-01 本机找 git）的用例另用 git-helpers.mjs 的 realGitPath。

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Git for Windows 默认装在这里 */
const INSTALL = 'C:\\Program Files\\Git';

/** @brief 是不是一个存在的文件。 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @brief Git for Windows 可能的安装目录：默认位置，再加 PATH 里有 git.exe 的目录往上推的（<安装目录>\cmd、
 *        <安装目录>\mingw64\bin 等；装在别处时，例如负责人机器上的 D:\Git，2026-10-27 合并时补）。
 */
function installRoots() {
  const dirs = (process.env.PATH ?? '').split(';').filter((dir) => dir && isFile(win32.join(dir, 'git.exe')));
  return [INSTALL, ...dirs.flatMap((dir) => [win32.dirname(dir), win32.dirname(win32.dirname(dir))])];
}

/** 测试用的 git：真正的 git.exe 的绝对路径；都找不到时为 'git'（按 PATH 找） */
export const REAL_GIT = installRoots().flatMap((root) => ['mingw64', 'clangarm64', 'mingw32']
  .map((dir) => win32.join(root, dir, 'bin', 'git.exe'))).find(isFile) ?? 'git';

/** @brief 交给 configureGit 的候选：只有 REAL_GIT（按 PATH 找时为空，由被测代码照常找）。 */
export function realGitCandidates() {
  return REAL_GIT === 'git' ? [] : [REAL_GIT];
}
