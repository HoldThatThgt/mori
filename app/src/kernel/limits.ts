// 收窄（docs/specs/file-system-permissions.md §8.2–§8.4）：派 subagent 的 Agent 与程序只能收窄碰文件的工具，越界的调用在
// 路径闸第 2 步（§6.1）直接拒绝、不出卡。这里是纯函数（不读文件、不缓存、不载入 pi）：limits 参数的解析与校验、临时提问
// 继承的收窄、工作卡与 board_read 里的写法、按路径闸那一次分类检查一个调用。拒绝原文的开头取 shared/workspace.ts 的
// NARROWING_LEADS 与 RELAY_ONLY（界面靠它们认出程序拒绝）。路径与段名的比较同 pathGate.ts（§6.3）。

import { relative, resolve } from 'node:path';
import { NARROWING_LEADS, RELAY_ONLY, type NarrowingOwner } from '../shared/workspace';
import { insideDir, samePath, segmentKey, type ClassifiedCall, type GateTarget } from './pathGate';

/** @brief 一组收窄（§8.2）：只有 false 才存，不写表示不限；write 为 false 时没有 commands 与 writePaths。 */
export interface Limits {
  /**
   * false：不能改文件（含写 .work）；只读会话（readOnlySession，§8.11）的命令照常按路径闸第 3、4 步判断，对话会话
   * （TEAM_DIALOG_LIMITS）不能跑任何命令
   */
  write?: false;
  /** false：不能跑命令 */
  commands?: false;
  /** false：不能用 MCP 与扩展注册的、不是职责工具的工具 */
  mcp?: false;
  /** 可写的范围：相对工作路径、/ 分隔、末尾带 /，1–10 项；.work/ 总是可写 */
  writePaths?: string[];
}

/** @brief 不限（§8.3：task 没写 limits、关闭模式的主 Agent）。 */
export const NO_LIMITS: Limits = Object.freeze<Limits>({});

/** @brief 程序给立项、结案、订阅与临时提问的收窄（§8.3）。 */
export const PROGRAM_LIMITS: Limits = Object.freeze<Limits>({ write: false });

/** @brief 协作模式下对话会话与合并会话的收窄（§8.3）。 */
export const TEAM_DIALOG_LIMITS: Limits = Object.freeze<Limits>({ write: false, mcp: false });

/** @brief 一个会话受的收窄：谁的收窄决定拒绝原文的开头（§8.3、§8.4）。 */
export interface Narrowing {
  /** 谁的收窄：决定拒绝原文的开头（NARROWING_LEADS[owner]；dialog 为整句 RELAY_ONLY） */
  owner: NarrowingOwner;
  /** 这个会话受的收窄 */
  limits: Limits;
}

/**
 * @brief 只读会话（§8.11）：收窄的 write 为 false 且不是对话会话（dialog 的 TEAM_DIALOG_LIMITS 照旧拒绝全部命令）。
 *        只读会话没有 edit、write 工具，命令不被收窄拒绝（照 Claude Code 的只读 Agent，2026-10-28 负责人定）。
 * @param narrowing 这个会话的收窄；没有时为 null
 */
export function readOnlySession(narrowing: Narrowing | null): boolean {
  return narrowing !== null && narrowing.owner !== 'dialog' && narrowing.limits.write === false;
}

/** @brief write_paths 的一项不合格时的原因（§8.2 第 4 步、§14）。 */
function pathProblem(path: string, problem: string): { error: string } {
  return { error: `limits.write_paths: "${path}" ${problem}` };
}

/** @brief 一项按段比较用的写法（段名规则同 §6.3）。 */
function keysOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '').map(segmentKey);
}

/** @brief prefix 的段是 keys 的开头（含相等）。 */
function startsWith(keys: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= keys.length && prefix.every((key, index) => keys[index] === key);
}

/**
 * @brief 一项 write_paths（§8.2 第 4 步）：去掉首尾空白后按 win32 路径处理，合格的写成相对工作路径、/ 分隔、末尾带 /
 *        的形式（不检查是否存在）。
 * @return 归一后的项；不合格时为 §14 的原因
 */
function writePath(raw: string, cwd: string): { path: string } | { error: string } {
  const text = raw.trim();
  if (/^([A-Za-z]:|[\\/~])/.test(text)) return pathProblem(text, 'must be relative to the working directory.');
  const target = resolve(cwd, text);
  if (!insideDir(cwd, target)) return pathProblem(text, 'is outside the working directory.');
  if (samePath(cwd, target)) return pathProblem(text, 'is the whole working directory; leave write_paths out.');
  return { path: `${relative(cwd, target).split(/[\\/]+/).join('/')}/` };
}

/** @brief 去重、去掉被另一项包含的项（有 src/ 时去掉 src/a/），保留先出现的写法与顺序。 */
function narrowestSet(paths: readonly string[]): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    const keys = keysOf(path);
    if (kept.some((known) => startsWith(keys, keysOf(known)))) continue;
    const remaining = kept.filter((known) => !startsWith(keysOf(known), keys));
    kept.splice(0, kept.length, ...remaining, path);
  }
  return kept;
}

/**
 * @brief 解析与校验 limits 参数（§8.2，task_create 与 agent_message 共用；参数已经 prepareArguments 与 pi 的 schema
 *        校验）：true 与不写相同，不存；write: false 时去掉 write_paths（已经包含在里面；commands: false 照留，只读会话的
 *        命令要它才拒绝，§8.11）；write_paths 按 writePath 归一、去重、去掉被包含的项。
 * @param raw 工具参数的 limits（{ write?, commands?, mcp?, write_paths? }）；没写时为 undefined
 * @param cwd 会话的工作路径
 * @return 收窄；不合格时 error 为工具结果的第一行
 */
export function parseLimits(raw: unknown, cwd: string): { limits: Limits } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { limits: {} };
  const input = raw as { write?: unknown; commands?: unknown; mcp?: unknown; write_paths?: unknown };
  const limits: Limits = {};
  if (input.write === false) limits.write = false;
  if (input.commands === false) limits.commands = false;
  if (input.mcp === false) limits.mcp = false;
  if (limits.write === undefined && Array.isArray(input.write_paths)) {
    const paths: string[] = [];
    for (const item of input.write_paths) {
      if (typeof item !== 'string') continue;
      const parsed = writePath(item, cwd);
      if ('error' in parsed) return parsed;
      paths.push(parsed.path);
    }
    if (paths.length > 0) limits.writePaths = narrowestSet(paths);
  }
  return { limits };
}

/**
 * @brief 临时提问实例的收窄（§8.3）：总是 { write: false }；发起方当时有 commands: false、mcp: false，或
 *        agent_message.limits 写了它们时加上（write: false 不含命令，§8.11，所以 commands 也要继承）。没有放宽的写法。
 * @param asker 发起方当时的收窄（Team.narrowingFor(发起方)?.limits ?? NO_LIMITS）
 * @param given 解析出的 agent_message.limits
 */
export function askLimits(asker: Limits, given: Limits): Limits {
  const limits: Limits = { write: false };
  if (asker.commands === false || given.commands === false) limits.commands = false;
  if (asker.mcp === false || given.mcp === false) limits.mcp = false;
  return limits;
}

/**
 * @brief 工作卡与 board_read 里的写法（§8.9、§14）：按 write、commands、write_paths、mcp 的顺序用 `; ` 连接。
 * @return 没有限制时为 null
 */
export function limitsText(limits: Limits): string | null {
  const parts: string[] = [];
  if (limits.write === false) parts.push('no file changes');
  if (limits.commands === false) parts.push('no commands');
  if (limits.writePaths && limits.writePaths.length > 0) {
    parts.push(`writes limited to ${limits.writePaths.join(', ')} and .work/`);
  }
  if (limits.mcp === false) parts.push('no MCP or extension tools');
  return parts.length > 0 ? parts.join('; ') : null;
}

/** @brief 改文件的工具名（§8.4 第 2 条：含参数里没有字符串 path、归为 other 的）。 */
function editsByName(toolName: string): boolean {
  return toolName === 'edit' || toolName === 'write';
}

/** @brief 跑命令的工具名（§8.2：commands 与对话会话的 write 拒绝全部命令，按工具名认）。 */
function commandByName(toolName: string): boolean {
  return toolName === 'bash' || toolName === 'powershell';
}

/** @brief 拒绝原文里的目标（§8.4）：在工作路径里写相对路径（/ 分隔，工作路径本身写 .），在外面写绝对路径。 */
function targetText(target: string, cwd: string): string {
  if (!insideDir(cwd, target)) return target;
  return relative(cwd, target).split(/[\\/]+/).join('/') || '.';
}

/** @brief 第一个在 writePaths 外的写入目标（§8.4 第 6 条）：归为 work 的总在里面。 */
function firstOutside(targets: readonly GateTarget[], writePaths: readonly string[], cwd: string): string | null {
  const allowed = writePaths.map(keysOf);
  for (const target of targets) {
    if (target.cls === 'work' || target.real === null) continue;
    const inside = insideDir(cwd, target.real);
    const keys = inside ? keysOf(relative(cwd, target.real)) : null;
    if (keys === null || !allowed.some((prefix) => startsWith(keys, prefix))) return targetText(target.real, cwd);
  }
  return null;
}

/**
 * @brief write: false 越界时的规则文字（§8.4 第 2 条）：改文件为 no file changes；命令只在对话会话里越界（它的原文是整句
 *        RELAY_ONLY），只读会话（§8.11）的命令不在这里拒绝，照常按 commands、路径闸第 3、4 步判断（照 Claude Code，
 *        2026-10-28 负责人定）。
 * @param command 调用是命令（种类 command，或工具名是 bash、powershell）
 * @return 规则文字；只读会话里的命令为 null
 */
function writeRule(narrowing: Narrowing, command: boolean): string | null {
  if (!command) return 'no file changes';
  return readOnlySession(narrowing) ? null : 'no file changes or commands';
}

/**
 * @brief 按 §8.4 的表找出越界的规则文字（第一条命中的为准）。
 * @return 规则文字；不拒绝时为 null
 */
function brokenRule(narrowing: Narrowing, call: ClassifiedCall, cwd: string): string | null {
  const { limits } = narrowing;
  const { kind, toolName } = call;
  if (kind === 'read') return null;
  const command = kind === 'command' || commandByName(toolName);
  const write = limits.write === false && (command || kind === 'file' || editsByName(toolName))
    ? writeRule(narrowing, command) : null;
  if (write !== null) return write;
  if (limits.commands === false && command) return 'no commands';
  if (limits.mcp === false && kind === 'other' && !editsByName(toolName) && !command) {
    return 'no MCP or extension tools';
  }
  const paths = limits.writePaths ?? [];
  if (paths.length === 0 || !(kind === 'file' || kind === 'command' || editsByName(toolName))) return null;
  const list = `writes are limited to ${paths.join(', ')} and .work/`;
  const unknown = call.targets.some((target) => target.cls === 'unresolved' || target.cls === 'leaves'
    || target.cls === 'unanalyzed');
  if (unknown || (kind === 'other' && editsByName(toolName))) return `${list}, and Mori can’t tell where this writes`;
  const outside = firstOutside(call.targets, paths, cwd);
  return outside === null ? null : `${list}; ${outside} is outside them`;
}

/**
 * @brief 收窄检查（§8.4）：越界时返回拒绝原文 `<开头>: <规则文字>.`（dialog 为整句 RELAY_ONLY），否则 null。
 *        职责工具在路径闸第 1 步已经放行，到不了这里。
 * @param narrowing 这个会话的收窄
 * @param call 路径闸在第 2 步之前做的那一次分类（§6.1）
 * @param cwd 工作路径的真实路径（call.realCwd）
 */
export function checkLimits(narrowing: Narrowing, call: ClassifiedCall, cwd: string): string | null {
  const rule = brokenRule(narrowing, call, cwd);
  if (rule === null) return null;
  return narrowing.owner === 'dialog' ? RELAY_ONLY : `${NARROWING_LEADS[narrowing.owner]}: ${rule}.`;
}
