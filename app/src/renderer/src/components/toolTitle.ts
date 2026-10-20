// 工具卡标题：用人话写出这次调用在做什么。对照表见 docs/v0/screens/tool-cards.md。

import type { ToolCall } from '../state/model';

/** 命令标题最多显示的字数 */
const COMMAND_MAX = 80;

/** @brief 标题的两部分：动词和对象（对象用等宽字体显示）。 */
export interface ToolTitle {
  /** 动词，例如"读取""运行" */
  verb: string;
  /** 对象，例如路径或命令；没有时为空串 */
  target: string;
  /** 补充，例如行范围 */
  suffix: string;
}

const verbs: Record<string, string> = {
  read: '读取', bash: '运行', powershell: '运行', edit: '修改', write: '写入', grep: '搜索', find: '查找', ls: '列目录',
};

/** @brief 在工作目录之内的路径显示为相对路径。 */
export function displayPath(path: string, cwd: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return normalized.slice(base.length + 1);
  return path;
}

/**
 * @brief 比较两个路径是否指同一个文件用的写法：去掉开头的 @、Git Bash 的 /c/... 换成 c:/...、相对路径接在工作目录后面、
 *        去掉 . 和 ..，统一斜杠、不分大小写（与主进程按 pi 规则解析的结果一致；~ 开头的不展开，界面拿不到用户目录）。
 */
export function pathKey(path: string, cwd: string): string {
  let normalized = path.trim().replace(/^@/, '').replace(/\\/g, '/');
  const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(\/.*)?$/i.exec(normalized);
  if (drive && !normalized.startsWith('//')) normalized = `${drive[1]}:${drive[2] ?? '/'}`;
  if (!/^[a-z]:\//i.test(normalized)) normalized = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized}`;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/').toLowerCase();
}

/** @brief 命令只取第一行并截断。 */
function commandLine(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0] ?? '';
  const cut = first.length > COMMAND_MAX ? `${first.slice(0, COMMAND_MAX)}…` : first;
  return lines.length > 1 && cut === first ? `${cut} …` : cut;
}

/** @brief 参数还没写完时，从已收到的 JSON 原文里尽量取出一个字段。 */
function partialField(argsText: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(argsText);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/** @brief 取一个字符串参数（完整参数优先，其次是还在流入的原文）。 */
function field(tool: ToolCall, name: string): string | null {
  const value = tool.args?.[name];
  if (typeof value === 'string') return value;
  return partialField(tool.argsText, name);
}

/** @brief read 的行范围后缀。 */
function lineRange(tool: ToolCall): string {
  const offset = Number(tool.args?.offset);
  const limit = Number(tool.args?.limit);
  if (!Number.isFinite(offset) || offset <= 0) return '';
  return Number.isFinite(limit) && limit > 0 ? ` · 第 ${offset}–${offset + limit - 1} 行` : ` · 从第 ${offset} 行`;
}

/** @brief 生成工具卡标题。 */
export function toolTitle(tool: ToolCall, cwd: string): ToolTitle {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.name);
  if (mcp) return { verb: `${mcp[1]} · ${mcp[2]}`, target: '', suffix: '' };
  const verb = verbs[tool.name];
  if (!verb) return { verb: tool.name, target: '', suffix: '' };
  if (tool.name === 'bash' || tool.name === 'powershell') {
    const command = field(tool, 'command');
    return { verb, target: command === null ? '…' : commandLine(command), suffix: '' };
  }
  if (tool.name === 'grep' || tool.name === 'find') return { verb, target: field(tool, 'pattern') ?? '…', suffix: '' };
  const path = field(tool, 'path');
  if (tool.name === 'ls') return { verb, target: path ? displayPath(path, cwd) : '.', suffix: '' };
  const target = path === null ? '…' : displayPath(path, cwd);
  return { verb, target, suffix: tool.name === 'read' ? lineRange(tool) : '' };
}

/** @brief 标题的纯文字形式（阶段行用）。 */
export function toolTitleText(tool: ToolCall, cwd: string): string {
  const title = toolTitle(tool, cwd);
  return [title.verb, title.target].filter(Boolean).join(' ') + title.suffix;
}
