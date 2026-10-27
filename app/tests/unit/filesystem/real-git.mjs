// 用真实 git 的单元测试共用的 git 可执行文件：Git for Windows 真正的 git（<安装目录>\mingw64\bin\git.exe），找法同 kernel/git.ts：
// PATH 里第一个 git.exe，然后 C:\Program Files\Git\cmd\git.exe；找到的是启动器 cmd\git.exe 时换成它旁边真正的 git。
// cmd\git.exe 只是启动器，每次调用多一个进程；PowerShell 的 PATH 里通常只有它，Git Bash 的 PATH 里真正的 git 在前，
// 两种 shell 里跑 test:fs-unit 的进程数与耗时因此不同。场景测试（快照、运行记录、Rewind）测的是 Mori 的逻辑，和用哪个 git 无关，
// 一律用真正的 git；测启动器本身（FS-02 结束进程树、FS-01 本机找 git）的用例另用 git-helpers.mjs 的 realGitPath。
// Git 不装在 Program Files 时（例如装在 D:\Git）也要找得到：候选为空等于没装 git，用到真实 git 的用例全部失败。

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Git for Windows 默认的启动器 */
const PROGRAM_FILES_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
/** 启动器（<安装目录>\cmd\git.exe）与它启动的真正的 git（按安装的架构找），同 kernel/git.ts */
const LAUNCHER = /[\\/]cmd[\\/]git\.exe$/i;
const REAL_GITS = ['mingw64\\bin\\git.exe', 'clangarm64\\bin\\git.exe', 'mingw32\\bin\\git.exe'];

/** @brief 是不是一个存在的文件。 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** @brief 找到的 git：PATH 里每个绝对目录下的 git.exe，然后 Program Files 的启动器；都没有时为 null。 */
function foundGit() {
  const dirs = (process.env.PATH ?? '').split(win32.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && win32.isAbsolute(dir));
  return [...dirs.map((dir) => win32.join(dir, 'git.exe')), PROGRAM_FILES_GIT].find(isFile) ?? null;
}

/** @brief 启动器换成它旁边真正的 git（没有时仍用启动器）；不是启动器的原样。 */
function realOf(path) {
  if (!LAUNCHER.test(path)) return path;
  const root = win32.dirname(win32.dirname(path));
  return REAL_GITS.map((name) => win32.join(root, name)).find(isFile) ?? path;
}

/** 测试用的 git：真正的 git.exe 的绝对路径；本机找不到 git 时为 'git'（按 PATH 找，用到它的用例会报错说明） */
const found = foundGit();
export const REAL_GIT = found === null ? 'git' : realOf(found);

/** @brief 交给 configureGit 的候选：只有 REAL_GIT（找不到 git 时为空，等于没装 git）。 */
export function realGitCandidates() {
  return REAL_GIT === 'git' ? [] : [REAL_GIT];
}
