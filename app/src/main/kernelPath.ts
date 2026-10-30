// 后台进程的 PATH（docs/v0/screens/tools.md“grep、find”，docs/v1/walkthrough-1026-checks.md 的 U76）：主进程启动后台进程时
// 把 Mori 带的 rg.exe、fd.exe 所在的文件夹放在最前面，pi 的 grep、find 和模型跑的命令都先找到这一份。
// 不 import electron（单元测试 tests/unit/kernelPath.test.mjs 直接打包它）；文件夹的位置由 kernel-process.ts 定。

/** Windows 的 PATH 分隔符 */
const SEPARATOR = ';';

/**
 * @brief env 的副本，PATH 的最前面加上 dir。Windows 的环境变量不分大小写，展开的副本只留原来的一种写法（常见 Path）：
 *        改每个不分大小写等于 PATH 的键的值，键的写法不变，不另建第二个 PATH；一个都没有时新建 PATH。原来的值为空时只有 dir。
 *        dir 里有 ; 时（安装时可以选这样的文件夹）加上双引号，不被拆成两项：pi 起程序用的 libuv 认带引号的项
 *        （审查后补；Git Bash 与 PowerShell 不认，见 docs/v0/defaults.md“把搜索程序放进 PATH 的方式”）。
 * @param env 环境变量（不改它）
 * @param dir 放在最前面的文件夹
 * @return 新的副本，键的顺序不变
 */
export function withBinOnPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
  const entry = dir.includes(SEPARATOR) ? `"${dir}"` : dir;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of keys.length > 0 ? keys : ['PATH']) {
    const old = env[key];
    next[key] = old ? `${entry}${SEPARATOR}${old}` : entry;
  }
  return next;
}
