// 工作区模块（docs/specs/file-system.md §2，后台进程第 9 件事“工作区”）。这里是 .work 的部分
// （docs/specs/file-system-permissions.md §7.10、§7.11）：Agent 的草稿、过程脚本与临时文件放在 <工作路径>\.work，
// 路径闸放行命令或写进 .work 的 write / edit 之前建它（不递归 mkdir，不覆盖你改过的 .gitignore，每次都检查、不缓存）；
// bash 与 PowerShell 工具经 customTools 换成同样的定义加上 spawnHook，在 env 的副本里把 TEMP、TMP、TMPDIR 指到
// .work\tmp 并去掉 CDPATH。从不改 process.env（所有会话共用一个后台进程）。不监视、不轮询。

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { BashSpawnContext, SettingsManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WORK_DENIAL_PREFIX } from '../shared/workspace';
import type { Pi } from './pi';

/** @brief 工作路径里 Agent 的草稿与临时文件夹的名字（§7）。 */
export const WORK_DIR = '.work';

/** @brief .work 下放命令临时文件的子文件夹。 */
const TMP_DIR = 'tmp';

/** @brief .work/.gitignore 的内容：忽略整个 .work（含 .gitignore 自己，§7.10）。 */
const WORK_IGNORE = '*\n';

/** @brief spawnHook 设成 workTmp 的变量（§7.11）。 */
const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const;

/** @brief spawnHook 去掉、不设新值的变量（§7.11）。 */
const DROPPED_VARS = ['CDPATH'];

/** @brief 每条命令的临时目录：<cwd>\.work\tmp（§7.11）。 */
export function workTmp(cwd: string): string {
  return win32.join(cwd, WORK_DIR, TMP_DIR);
}

/** @brief commandScan 认得的变量值（§7.2）：TEMP、TMP、TMPDIR → workTmp(cwd)，与 spawnHook 设的值相同。 */
export function workVars(cwd: string): Record<(typeof TEMP_VARS)[number], string> {
  const tmp = workTmp(cwd);
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

/**
 * @brief spawnHook（§7.11）：env 的副本里去掉 TEMP、TMP、TMPDIR 的各种大小写写法（Windows 上 env 名字不分大小写，
 *        同名不同写法时 Node 只用排序后第一个），再设成 workTmp(context.cwd)；同时去掉 CDPATH 的各种大小写写法
 *        （不设新值）；command、cwd 不变，传进来的 env 不改。
 * @param context pi 的 bash / PowerShell 工具在 spawn 之前给出的命令、工作路径（ctx.cwd）与环境
 */
export function workEnv(context: BashSpawnContext): BashSpawnContext {
  const replaced = new Set<string>([...TEMP_VARS, ...DROPPED_VARS]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(context.env)) {
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  }
  return { ...context, env: { ...env, ...workVars(context.cwd) } };
}

/** @brief ensureWork 的结果：失败时 reason 为 §7.10 的原因（或 Node 的错误原文）。 */
export type WorkResult = { ok: true } | { ok: false; reason: string };

/** @brief 系统错误的 code；不是系统错误时为 undefined。 */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * @brief 建一层文件夹（不递归）；已经有了时 stat（链接到文件夹的算文件夹）。
 * @param path 文件夹
 * @param notFolder 已有的不是文件夹时的原因
 * @return 成功为 null；不是文件夹或 stat 失败时为原因；mkdir 的其他错误照原样抛出
 */
async function ensureFolder(path: string, notFolder: string): Promise<string | null> {
  try {
    await mkdir(path);
    return null;
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }
  try {
    return (await stat(path)).isDirectory() ? null : notFolder;
  } catch (error) {
    return (error as Error).message;
  }
}

/** @brief 只在没有时写 .work/.gitignore（wx）：你改过的不覆盖。 */
async function writeIgnore(work: string): Promise<void> {
  try {
    await writeFile(win32.join(work, '.gitignore'), WORK_IGNORE, { flag: 'wx' });
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }
}

/**
 * @brief 建 .work（§7.10）：mkdir .work、只在没有时写 .gitignore、mkdir .work\tmp。都不递归：工作路径本身不在
 *        （第一步的 mkdir 报 ENOENT）时什么都不建、返回成功，不会把被删掉的 worktree 重新建出来。每次放行都调用，
 *        不缓存“已经建过”。失败时记 `[kernel] couldn't prepare .work in <cwd>: <原因>`。
 * @param cwd 工作路径（ctx.cwd）
 * @return 成功；失败时 reason 为 '.work is a file, not a folder'、'.work/tmp is a file, not a folder' 或 Node 的错误原文
 */
export async function ensureWork(cwd: string): Promise<WorkResult> {
  const work = win32.join(cwd, WORK_DIR);
  let reason: string | null;
  try {
    try {
      reason = await ensureFolder(work, '.work is a file, not a folder');
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return { ok: true };
      throw error;
    }
    if (reason === null) {
      await writeIgnore(work);
      reason = await ensureFolder(win32.join(work, TMP_DIR), '.work/tmp is a file, not a folder');
    }
  } catch (error) {
    reason = (error as Error).message;
  }
  if (reason === null) return { ok: true };
  console.error(`[kernel] couldn't prepare .work in ${cwd}: ${reason}`);
  return { ok: false, reason };
}

/**
 * @brief .work 建不起来时回给模型的拒绝原文（§14），开头是 DENIAL_PREFIXES 里的 WORK_DENIAL_PREFIX。
 * @param reason ensureWork 给出的原因
 */
export function workDenialText(reason: string): string {
  return `${WORK_DENIAL_PREFIX} (${reason}), so this call didn't run. Tell the user.`;
}

/**
 * @brief 换掉 pi 内置的 bash、powershell（§7.11，createAgentSession 的 customTools）：同样的定义加上 spawnHook: workEnv，
 *        defaultActive 为 false（启用与否只按名字，与内置工具相同）。bash 照 pi 建内置工具时的做法带上设置里的
 *        shellCommandPrefix 与 shellPath，powershell 不带别的选项。
 * @param pi pi 模块
 * @param cwd 会话的工作路径
 * @param settings 这个会话的 pi 设置
 */
export function shellTools(pi: Pi, cwd: string, settings: SettingsManager): ToolDefinition[] {
  const bash = pi.createBashToolDefinition(cwd, { commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(), spawnHook: workEnv });
  const powershell = pi.createPowerShellToolDefinition(cwd, { spawnHook: workEnv });
  // pi 的定义带具体的参数与 details 类型；customTools 的元素类型是不带类型参数的 ToolDefinition，渲染回调的参数逆变，要显式转
  return [{ ...bash, defaultActive: false }, { ...powershell, defaultActive: false }] as ToolDefinition[];
}
