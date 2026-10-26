// 找 Git Bash（docs/app-v0.md 第 6 节"Shell"，负责人走查 M28）：pi 自己只看设置里的 shellPath、Program Files 下的 Git 和
// PATH 上的 bash.exe；Git for Windows 装在别处、PATH 上只有 <Git>\cmd 时它找不到。后台进程每次启动查一次，照 Claude Code
// 的做法从 git.exe 的位置和 Git for Windows 的注册表找 bash.exe。找到的路径只放进内存里的 pi 设置（applyOverrides），
// 不写 settings.json；哪里都没有 bash 时同样只在内存里让新会话用 powershell 代替 bash。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import type { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Pi } from './pi';

/**
 * @brief 这次启动查到的 bash。
 *        configured：用户级 pi 设置里写了 shellPath（shellPath 为它），Mori 不动；
 *        pi：pi 自己的查找能找到（shellPath 为它找到的），Mori 不动；
 *        git：pi 找不到、Mori 找到的 Git Bash（shellPath 为 <Git>\bin\bash.exe，from 为途径：PATH 上的 git.exe 或注册表）；
 *        none：哪里都没有 bash。
 */
export type ShellLookup =
  | { kind: 'configured' | 'pi'; shellPath: string }
  | { kind: 'git'; shellPath: string; from: 'git.exe' | 'registry' }
  | { kind: 'none' };

/** @brief 找 bash 用到的外部查询（单元测试换成替身）。 */
export interface ShellProbe {
  /** 用户级 pi 设置里的 shellPath；没有时为 undefined */
  configured: () => string | undefined;
  /** pi 自己的查找（getShellConfig 不带参数）找到的 bash；找不到时为 null */
  piShell: () => string | null;
  /** `where git.exe` 列出的全部路径，按顺序；没有时为空 */
  gitOnPath: () => Promise<string[]>;
  /** Git for Windows 注册表里的 InstallPath，先 HKLM 后 HKCU；没有的不列 */
  registryRoots: () => Promise<string[]>;
  /** 文件是否存在 */
  exists: (path: string) => boolean;
}

/** 哪里都没有 bash 时新会话的默认工具：去掉 bash、加上 powershell（pi 的 +name / -name 写法，方案第 6 节） */
export const NO_BASH_TOOLS: readonly string[] = ['-bash', '+powershell'];

/** Git for Windows 注册表里记安装目录的键，先找本机的再找当前用户的 */
const REGISTRY_KEYS = ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows'];

/**
 * @brief git.exe 所在的 Git for Windows 目录：`<Git>\cmd\git.exe`、`<Git>\bin\git.exe`、`<Git>\mingw64\bin\git.exe`。
 * @param gitExe `where git.exe` 列出的一个路径
 * @return Git 的目录；git.exe 不在这几处（例如包管理器的 shim）时为 null
 */
export function gitRoot(gitExe: string): string | null {
  const dir = win32.dirname(gitExe);
  const leaf = win32.basename(dir).toLowerCase();
  const parent = win32.dirname(dir);
  if (leaf === 'cmd') return parent;
  if (leaf !== 'bin') return null;
  return win32.basename(parent).toLowerCase() === 'mingw64' ? win32.dirname(parent) : parent;
}

/**
 * @brief 按顺序找 bash：设置里的 shellPath → pi 自己的查找 → PATH 上每个 git.exe 推出的 `<Git>\bin\bash.exe`
 *        → 注册表 InstallPath 下的 `bin\bash.exe`。前一步找到就不再往下查。
 * @param probe 外部查询
 */
export async function resolveShell(probe: ShellProbe): Promise<ShellLookup> {
  const configured = probe.configured();
  if (configured) return { kind: 'configured', shellPath: configured };
  const piShell = probe.piShell();
  if (piShell) return { kind: 'pi', shellPath: piShell };
  for (const git of await probe.gitOnPath()) {
    const root = gitRoot(git);
    const bash = root === null ? null : win32.join(root, 'bin', 'bash.exe');
    if (bash && probe.exists(bash)) return { kind: 'git', shellPath: bash, from: 'git.exe' };
  }
  for (const root of await probe.registryRoots()) {
    const bash = win32.join(root, 'bin', 'bash.exe');
    if (probe.exists(bash)) return { kind: 'git', shellPath: bash, from: 'registry' };
  }
  return { kind: 'none' };
}

/**
 * @brief 从 `reg query <键> /v InstallPath` 的输出读出 InstallPath。
 * @return 安装目录；输出里没有这个值时为 null
 */
export function parseInstallPath(output: string): string | null {
  return /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output)?.[1] ?? null;
}

/**
 * @brief 把查到的结果放进一份 pi 设置（只在内存里，pi 的 save 只写改过的字段，不会写进 settings.json）：
 *        Mori 找到的 Git Bash 作为 shellPath；没有 bash 时 defaultTools 为 NO_BASH_TOOLS。
 *        这份设置（用户级或受信任项目的）已有 shellPath 时什么都不放。pi 的 reload、save 会丢掉内存里的覆盖，
 *        所以资源加载器 reload 之后要再放一次（sessions.ts loadResources）。
 * @param settings pi 的设置
 * @param found 这次启动查到的结果
 */
export function applyShell(settings: Pick<SettingsManager, 'getShellPath' | 'applyOverrides'>,
  found: ShellLookup): void {
  if (settings.getShellPath()) return;
  if (found.kind === 'git') settings.applyOverrides({ shellPath: found.shellPath });
  else if (found.kind === 'none') settings.applyOverrides({ defaultTools: [...NO_BASH_TOOLS] });
}

/** @brief 记进日志的一行（英文）：查到了什么、从哪里查到的。 */
export function describeShell(found: ShellLookup): string {
  switch (found.kind) {
    case 'configured': return `shell: pi settings set shellPath ${found.shellPath}`;
    case 'pi': return `shell: pi finds bash at ${found.shellPath}`;
    case 'git': {
      const from = found.from === 'git.exe' ? 'from git.exe on PATH' : 'from the Git for Windows registry key';
      return `shell: Git Bash ${found.shellPath} (${from}), set as shellPath in memory`;
    }
    case 'none':
      return 'shell: no bash found (pi lookup, git.exe on PATH, Git for Windows registry); new sessions use powershell';
  }
}

/**
 * @brief 运行 System32 下的一个命令（不依赖 PATH，同 pi 调 taskkill 的做法），返回标准输出。
 *        退出码不为 0（where 没找到、reg 没有这个键）时为 null；起不来或超时时记错误后为 null。
 * @param exe System32 下的文件名
 * @param args 参数
 */
function runSystem(exe: string, args: string[]): Promise<string | null> {
  const path = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
  return new Promise((resolve) => {
    execFile(path, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve(stdout);
      if (typeof error.code !== 'number') console.error(`[kernel] ${exe} ${args.join(' ')} failed: ${error.message}`);
      resolve(null);
    });
  });
}

/** @brief Git for Windows 注册表里的安装目录，先 HKLM 后 HKCU。 */
async function registryRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const key of REGISTRY_KEYS) {
    const output = await runSystem('reg.exe', ['query', key, '/v', 'InstallPath']);
    const root = output === null ? null : parseInstallPath(output);
    if (root) roots.push(root);
  }
  return roots;
}

/**
 * @brief 真实的外部查询。用户级设置直接用 pi 的 SettingsManager 读（不经 createSettingsManager：那里要等这次查找）；
 *        pi 的查找找不到时抛"No bash shell found"，这是要补的情形，不记错误。
 */
function systemProbe(pi: Pi): ShellProbe {
  return {
    configured: () => pi.SettingsManager.create(pi.getAgentDir(), pi.getAgentDir()).getShellPath(),
    piShell: () => {
      try {
        return pi.getShellConfig().shell;
      } catch {
        return null;
      }
    },
    gitOnPath: async () => (await runSystem('where.exe', ['git.exe']) ?? '').split(/\r?\n/).filter(Boolean),
    registryRoots,
    exists: existsSync,
  };
}

let lookup: Promise<ShellLookup> | undefined;

/**
 * @brief 这次启动查到的 bash：第一次调用时查（后台进程启动时就调一次，index.ts），之后复用；查到后记一行日志，
 *        没有 bash 时记为错误。
 */
export function findShell(pi: Pi): Promise<ShellLookup> {
  lookup ??= resolveShell(systemProbe(pi)).then((found) => {
    if (found.kind === 'none') console.error(`[kernel] ${describeShell(found)}`);
    else console.log(`[kernel] ${describeShell(found)}`);
    return found;
  });
  return lookup;
}
