// Customize › Built-in tools 的开关（docs/v0/screens/tools.md"内置工具"，负责人走查 M12、回答 3）：pi 的 8 个内置工具在
// 新会话里默认启用与否，存为用户级 <agentDir>/settings.json 的 defaultTools（方案第 6 节第 1 件"读写配置"）。
// pi 1.3.0 选默认工具的规则没有导出，这里照写（core/settings-manager.js 75–99 mergeDefaultTools、resolveDefaultTools，
// 1060 getDefaultTools 只认字符串），单元测试逐条对照 pi 真实的 SettingsManager。
// pi 没有写 defaultTools 的方法；这里在 pi 自己的文件锁里读改写这一项（FileSettingsStorage.withLock，pi 每个 setter 的保存
// 用的同一把锁，见 docs/v0/defaults.md"写 defaultTools 用 pi 的文件锁"），别的字段原样保留。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piPackageDir } from './mcpShare';
import { loadPi } from './pi';
import { PI_DEFAULT_TOOLS, PI_TOOL_NAMES } from './roles';

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
}

/**
 * @brief pi 的 8 个内置工具在新会话里默认启用与否（Customize 内置工具的开关）。
 * @param user 用户级 settings.json 的 defaultTools（文件里的值）
 * @param project 受信任项目的 .pi/settings.json 的 defaultTools；没有或不信任时为 undefined
 */
export function toolDefaults(user: unknown, project: unknown): Map<string, ToolDefault> {
  const own = selectedTools(user);
  const merged = selectedTools(mergedTools(user, project));
  return new Map(PI_TOOL_NAMES.map((name) => {
    const enabled = merged.includes(name);
    return [name, { enabled, byProject: enabled !== own.includes(name) }];
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
