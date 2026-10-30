// Customize › Built-in tools 的开关（docs/v0/screens/tools.md"内置工具"，负责人走查 M12、回答 3）：pi 的 8 个内置工具在
// 新会话里默认启用与否，存为用户级 <agentDir>/settings.json 的 defaultTools（方案第 6 节第 1 件"读写配置"）。
// pi 1.3.0 选默认工具的规则没有导出，这里照写（core/settings-manager.js 75–99 mergeDefaultTools、resolveDefaultTools，
// 1060 getDefaultTools 只认字符串），单元测试逐条对照 pi 真实的 SettingsManager。
// pi 没有写 defaultTools 的方法；这里在 pi 自己的文件锁里读改写这一项（FileSettingsStorage.withLock，pi 每个 setter 的保存
// 用的同一把锁，见 docs/v0/defaults.md"写 defaultTools 用 pi 的文件锁"），别的字段原样保留。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentSession, ToolInfo } from '@earendil-works/pi-coding-agent';
import { isMcpTool } from './mcpConfig';
import { piPackageDir } from './mcpShare';
import { loadPi } from './pi';
import { PI_DEFAULT_TOOLS, PI_TOOL_NAMES } from './roles';

/**
 * @brief 只读会话按装没装加上的搜索工具与它们要的程序（file-system-permissions.md §8.11）。2026-10-29 起 Mori 随程序带这两个
 *        程序、放在后台进程的 PATH 最前面（U76，main/kernel-process.ts），所以总找得到。
 */
const SEARCH_PROGRAMS: ReadonlyArray<readonly [string, string]> = [['grep', 'rg.exe'], ['find', 'fd.exe']];

/** @brief pi 1.3.0 里 FileSettingsStorage 所在的文件（相对 pi 的包目录；它没有从包的入口导出）。 */
const PI_SETTINGS_FILE = 'dist/core/settings-manager.js';

/**
 * @brief pi 的 FileSettingsStorage：withLock 在 settings.json 的文件锁里交出现在的原文（没有文件时为 undefined），
 *        回调返回新原文时写回。
 */
interface SettingsStorage {
  withLock(scope: 'global' | 'project', fn: (current: string | undefined) => string | undefined): void;
}

/** @brief FileSettingsStorage 的构造：cwd 定项目设置的位置，agentDir 定用户级设置的位置。 */
type StorageClass = new (cwd: string, agentDir: string) => SettingsStorage;

/** @brief 是不是 pi 的 +名字 / -名字 写法（pi isToolModifier）。 */
function isModifier(entry: unknown): entry is string {
  return typeof entry === 'string' && (entry.startsWith('+') || entry.startsWith('-'));
}

/** @brief 按顺序把 +名字 加上、-名字 去掉（pi applyToolModifiers）；别的条目跳过。 */
function applyModifiers(base: readonly string[], entries: readonly string[]): string[] {
  const tools = [...base];
  for (const entry of entries) {
    if (!isModifier(entry)) continue;
    const name = entry.slice(1);
    const index = tools.indexOf(name);
    if (entry.startsWith('+') && index === -1 && name) tools.push(name);
    else if (entry.startsWith('-') && index !== -1) tools.splice(index, 1);
  }
  return tools;
}

/**
 * @brief 一份 defaultTools 选出的工具（pi getDefaultTools 加上 SDK 的 `?? DEFAULT_TOOL_NAMES`）：没写时是 pi 的默认；
 *        不是数组时按空列表；只认字符串；有普通工具名时它们代替默认，之后按顺序做 +名字 / -名字。
 * @param value 设置里的 defaultTools（未经检查）
 */
export function selectedTools(value: unknown): string[] {
  if (value === undefined) return [...PI_DEFAULT_TOOLS];
  const entries = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const plain = entries.filter((entry) => !isModifier(entry));
  return applyModifiers(plain.length > 0 || entries.length === 0 ? plain : PI_DEFAULT_TOOLS, entries);
}

/**
 * @brief 用户级与项目设置的 defaultTools 合并后的样子（pi mergeDefaultTools）：项目没写时是用户级的；两边都是数组、
 *        项目的全是 +名字 / -名字 时接在用户级后面；否则项目的代替用户级的。
 */
export function mergedTools(user: unknown, project: unknown): unknown {
  if (project === undefined) return user;
  if (!Array.isArray(user) || !Array.isArray(project) || !project.every(isModifier)) return project;
  return [...user, ...project];
}

/** @brief 一个 pi 内置工具在新会话里的默认。 */
export interface ToolDefault {
  /** 新会话默认启用（用户级与项目设置合并后的） */
  enabled: boolean;
  /** 项目设置改了它：与只按用户级设置时不同 */
  byProject: boolean;
  /**
   * 用户级的开关开着新会话里也没有它（同 pi 合并用户级、项目与内存里的设置）：例如没有 bash 时 Mori 在内存里放的 -bash。
   * 与开关现在的样子无关（U77：状态跟着显示出来的开关，这一项决定开着时写不写 Available in new sessions）
   */
  heldOff: boolean;
}

/**
 * @brief pi 的 8 个内置工具在新会话里默认启用与否（Customize 内置工具的开关）。
 * @param user 用户级 settings.json 的 defaultTools（文件里的值）
 * @param project 受信任项目的 .pi/settings.json 的 defaultTools；没有或不信任时为 undefined
 * @param memory Mori 只放在内存里的 defaultTools（shell.ts memoryDefaultTools）；没有时为 undefined
 */
export function toolDefaults(user: unknown, project: unknown, memory?: readonly string[]): Map<string, ToolDefault> {
  const own = selectedTools(user);
  const merged = selectedTools(mergedTools(user, project));
  return new Map(PI_TOOL_NAMES.map((name) => {
    const enabled = merged.includes(name);
    const withOn = selectedTools(mergedTools(mergedTools(switchedTools(user, name, true), project), memory));
    return [name, { enabled, byProject: enabled !== own.includes(name), heldOff: !withOn.includes(name) }];
  }));
}

/**
 * @brief 开或关一个工具之后要写的 defaultTools：在 value 选出的工具上加上或去掉 name，整份写成相对 pi 默认的差别
 *        （先 -名字，按 pi 默认的顺序；再 +名字，按选出的顺序）；与 pi 的默认相同时为 undefined（去掉这一项：
 *        pi 把空列表当作一个工具都没有）。
 * @param value 设置里现在的 defaultTools（未经检查）
 * @param name 工具名
 * @param enabled 新会话默认启用它
 */
export function switchedTools(value: unknown, name: string, enabled: boolean): string[] | undefined {
  const selected = [...new Set(selectedTools(value))];
  const next = enabled ? (selected.includes(name) ? selected : [...selected, name])
    : selected.filter((tool) => tool !== name);
  const removed = PI_DEFAULT_TOOLS.filter((tool) => !next.includes(tool)).map((tool) => `-${tool}`);
  const added = next.filter((tool) => !PI_DEFAULT_TOOLS.includes(tool)).map((tool) => `+${tool}`);
  const entries = [...removed, ...added];
  return entries.length > 0 ? entries : undefined;
}

/**
 * @brief 从会话文件重新打开的用户会话该启用的工具（tools.md"按了开关"：之后新建的会话，含重启后重新打开的会话，按现在的
 *        设置）。pi 1.3.0 打开有记录的会话时按记录恢复当时启用的工具（agent-session.js `_restoreToolsFromTranscript`），
 *        不看现在的 defaultTools：这里把内置工具换成现在的设置选出的（同 pi 建新会话时的选法，排在前面），别的工具照恢复的
 *        留着，最后加上 extra。和恢复的是同一组工具时为 null（不重设，顺序也不动）。
 * @param active 恢复后启用的工具（pi getActiveToolNames）
 * @param builtin 注册了的 pi 内置工具（isBuiltinTool，含 Mori 换掉的 bash、powershell）
 * @param defaults 现在的设置选出的默认工具（pi `getDefaultTools() ?? DEFAULT_TOOL_NAMES`）
 * @param extra 注册了、还没启用、该直接给模型的扩展工具
 */
export function reopenedTools(active: readonly string[], builtin: readonly string[], defaults: readonly string[],
  extra: readonly string[]): string[] | null {
  const isBuiltin = new Set(builtin);
  const next = [...new Set([...defaults.filter((name) => isBuiltin.has(name)),
    ...active.filter((name) => !isBuiltin.has(name)), ...extra])];
  const same = next.length === active.length && next.every((name) => active.includes(name));
  return same ? null : next;
}

/**
 * @brief pi 的内置工具：来源路径以 builtin: 开头（pi 的 MCP 扩展注册的 builtin:mcp 除外），或来源是 sdk——Mori 经
 *        customTools 换掉的 bash、powershell（workspace.ts shellTools），pi 给它们的路径是 <sdk:名字>（agent-session.js
 *        _refreshToolRegistry）。工具页的来源（resources.ts toolSource）与重新打开时换内置工具（refreshedTools）都用这一条
 *        （docs/v1/walkthrough-1026-checks.md 的 U77）。
 */
export function isBuiltinTool(tool: Pick<ToolInfo, 'sourceInfo'>): boolean {
  const { path, source } = tool.sourceInfo;
  return !isMcpTool(tool) && (path.startsWith('builtin:') || source === 'sdk');
}

/**
 * @brief 从会话文件重新打开的用户会话该启用的工具（reopenedTools，三样从 pi 会话读）：内置工具按 isBuiltinTool；扩展工具是
 *        注册了、不是内置工具、会直接给模型用（exposure 为 direct 或 model-only）、还没启用、没有标成默认不启用的。
 *        和恢复的是同一组工具时为 null。
 * @param session pi 按会话记录恢复了工具的会话
 * @param defaults 现在的设置选出的默认工具
 */
export function refreshedTools(session: Pick<AgentSession, 'getActiveToolNames' | 'getAllTools' | 'getToolDefinition'>,
  defaults: readonly string[]): string[] | null {
  const active = session.getActiveToolNames();
  const tools = session.getAllTools();
  const builtin = tools.filter(isBuiltinTool).map((tool) => tool.name);
  const extra = tools.filter((tool) => !builtin.includes(tool.name)
    && (tool.exposure === 'direct' || tool.exposure === 'model-only') && !active.includes(tool.name)
    && session.getToolDefinition(tool.name)?.defaultActive !== false).map((tool) => tool.name);
  return reopenedTools(active, builtin, defaults, extra);
}

/**
 * @brief 设置文件的原文改了 defaultTools 之后的原文（两个空格缩进，同 pi 的写法）：只改这一项，别的字段与键的顺序不变。
 *        原文不是 JSON 对象时报错（带文件路径），不写。
 * @param current 现在的原文；没有文件时为 undefined
 * @param file 文件路径（只用于报错）
 */
export function rewrittenSettings(current: string | undefined, file: string, name: string, enabled: boolean): string {
  let settings: unknown = {};
  try {
    if (current) settings = JSON.parse(current.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${file}: not a JSON object`);
  }
  const record = settings as Record<string, unknown>;
  const next = switchedTools(record.defaultTools, name, enabled);
  if (next === undefined) delete record.defaultTools;
  else record.defaultTools = next;
  return JSON.stringify(record, null, 2);
}

/** @brief 按 pi 1.3.0 包里的文件路径载入 FileSettingsStorage（同 mcpShare.ts 载入 pi 的内部文件）；找不到时报错。 */
async function loadStorage(): Promise<StorageClass> {
  const dir = piPackageDir(await loadPi());
  const url = pathToFileURL(join(dir, PI_SETTINGS_FILE)).href;
  const module = await import(/* @vite-ignore */ url) as { FileSettingsStorage?: unknown };
  if (typeof module.FileSettingsStorage !== 'function') throw new Error(`FileSettingsStorage is missing in ${dir}`);
  return module.FileSettingsStorage as StorageClass;
}

/**
 * @brief 在 pi 的文件锁里改用户级 settings.json 的 defaultTools（rewrittenSettings）：pi 自己的保存在同一把锁里重新读文件、
 *        只合并它改过的字段，所以两边同时写也都不丢。拿不到锁、文件不是 JSON 对象时报错。
 * @param agentDir pi 的配置目录
 * @param name pi 的内置工具名
 * @param enabled 新会话默认启用它
 */
export async function writeDefaultTool(agentDir: string, name: string, enabled: boolean): Promise<void> {
  const Storage = await loadStorage();
  const file = join(agentDir, 'settings.json');
  new Storage(agentDir, agentDir).withLock('global', (current) => rewrittenSettings(current, file, name, enabled));
}

/**
 * @brief PATH 里的目录，照 libuv search_path（pi 按名字起 rg、fd 时 Windows 上这样找）：按 ; 分项；一项以 " 或 ' 开头时
 *        先跳到下一个同样的引号（没有就到末尾）再找 ;；空项跳过；去掉开头的一个引号和结尾的一个 " 或 '（开头没有引号、
 *        两头引号不同也去）；不去空格。不照搬 libuv 先找当前目录、补 .com 的做法（§8.11 只看 binDir 与 PATH）。
 * @param pathText PATH 环境变量
 * @return 目录，按 PATH 里的顺序；去掉引号后为空的项不算
 */
function pathDirs(pathText: string): string[] {
  const dirs: string[] = [];
  for (let start = 0; start < pathText.length;) {
    const first = pathText[start];
    const close = first === '"' || first === "'" ? pathText.indexOf(first, start + 1) : start;
    const semicolon = close < 0 ? -1 : pathText.indexOf(';', close);
    const end = semicolon < 0 ? pathText.length : semicolon;
    const dir = pathText.slice(start, end).replace(/^["']/, '').replace(/["']$/, '');
    if (dir !== '') dirs.push(dir);
    start = end + 1;
  }
  return dirs;
}

/**
 * @brief 装了程序的搜索工具（file-system-permissions.md §8.11）：rg.exe（fd.exe）在 binDir 或 PATH 的某个目录里时为
 *        grep（find）。同 pi getToolPath 先找 <agentDir>\bin、再找 PATH，但只看文件在不在：不起进程、不缓存。
 *        后台进程的 PATH 最前面总是 Mori 带的这两个程序（U76），所以在 Mori 里总是两样都有；检查照旧留着。
 *        PATH 照 libuv search_path 分项（pathDirs；审查后补：装在带 ; 的文件夹里时 main/kernelPath.ts 给这一项加引号）。
 * @param binDir pi 的 <agentDir>\bin
 * @param pathText PATH 环境变量（分项见 pathDirs）
 * @param exists 文件在不在（单元测试注入；默认 existsSync）
 * @return 按 grep、find 的顺序
 */
export function installedSearchTools(binDir: string, pathText: string,
  exists: (path: string) => boolean = existsSync): string[] {
  const dirs = [binDir, ...pathDirs(pathText)];
  return SEARCH_PROGRAMS.filter(([, program]) => dirs.some((dir) => exists(join(dir, program)))).map(([tool]) => tool);
}
