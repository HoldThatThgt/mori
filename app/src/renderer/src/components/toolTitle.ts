// 工具卡标题：用人话写出这次调用在做什么。对照表见 docs/v0/screens/tool-cards.md；TaskBoard 的工具见平行 Agent 规格 §13.8；
// memory 工具见 docs/specs/memory.md §7.5；ask_user_question 见 docs/specs/file-system-permissions.md §10.6
// （Ask · <各问题的 header>）。

import { memoryToolTitle } from '../../../shared/memory';
import { SUBAGENT_TOOL } from '../../../shared/subagent';
import { isTeamTool, toolCallTitle } from '../../../shared/team';
import { ASK_TOOL } from '../../../shared/workspace';
import type { ToolCall } from '../state/model';
import { subagentCardTitle } from './subagentView';

/** memory 工具的名字（docs/specs/memory.md §7.1）；Customize 的内置工具一节也用它认出 memory 那一行 */
export const MEMORY_TOOL = 'memory';

/** 命令标题最多显示的字数 */
const COMMAND_MAX = 80;

/** @brief 标题的两部分：动词和对象（对象用等宽字体显示）。 */
export interface ToolTitle {
  /** 动词，例如"Read""Run" */
  verb: string;
  /** 对象，例如路径或命令；没有时为空串 */
  target: string;
  /** 补充，例如行范围 */
  suffix: string;
}

const verbs: Record<string, string> = {
  read: 'Read', bash: 'Run', powershell: 'Run', edit: 'Edit', write: 'Write', grep: 'Search', find: 'Find', ls: 'List',
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

/** @brief JSON 字符串里的转义还原；原文不完整（还在流入）时按原样。 */
function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/** @brief 参数还没写完时，从已收到的 JSON 原文里尽量取出一个字段。 */
function partialField(argsText: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(argsText);
  return match?.[1] ? unescapeJson(match[1]) : null;
}

/** @brief 取一个字符串参数（完整参数优先，其次是还在流入的原文）。 */
function field(tool: ToolCall, name: string): string | null {
  const value = tool.args?.[name];
  if (typeof value === 'string') return value;
  return partialField(tool.argsText, name);
}

/** @brief read 的行范围后缀：" · lines a–b"或" · from line a"。 */
function lineRange(tool: ToolCall): string {
  const offset = Number(tool.args?.offset);
  const limit = Number(tool.args?.limit);
  if (!Number.isFinite(offset) || offset <= 0) return '';
  return Number.isFinite(limit) && limit > 0 ? ` · lines ${offset}–${offset + limit - 1}` : ` · from line ${offset}`;
}

/**
 * @brief memory 工具的标题（docs/specs/memory.md §7.5）：`Save to <KIND>` · abstract、`Update memory` · 条目、
 *        `Delete from memory` · 条目（shared/memory.ts memoryToolTitle）。参数还没写完时从已收到的原文里取，
 *        对象还没收到时写作 …。
 */
function memoryTitle(tool: ToolCall): ToolTitle {
  const args = tool.args ?? { action: field(tool, 'action'), kind: field(tool, 'kind'),
    abstract: field(tool, 'abstract'), entry: field(tool, 'entry') };
  const title = memoryToolTitle(args);
  return { verb: title.verb, target: title.target || (tool.args ? '' : '…'), suffix: '' };
}

/** 参数原文里已经写完的 header 字段（ask_user_question 的参数还没写完时取标题用） */
const HEADER_FIELD = /"header"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * @brief ask_user_question 的标题：Ask · <各问题的 header，用 , 连接>（例如 Ask · Database, Scope）。参数还没写完时
 *        从已收到的原文里取写完的 header，一个都还没有时写作 Ask · …。
 */
function askTitle(tool: ToolCall): ToolTitle {
  const questions = tool.args?.questions;
  const headers = Array.isArray(questions)
    ? questions.flatMap((item) => {
      const header = (item as { header?: unknown } | null)?.header;
      return typeof header === 'string' ? [header] : [];
    })
    : [...tool.argsText.matchAll(HEADER_FIELD)].map((match) => unescapeJson(match[1] ?? ''));
  return { verb: `Ask · ${headers.length > 0 ? headers.join(', ') : '…'}`, target: '', suffix: '' };
}

/**
 * @brief 生成工具卡标题。TaskBoard 的工具（合并会话里立项的调用、对话的 board_read 等）用平行 Agent 规格 §13.8 的
 *        英文标题（shared/team.ts toolCallTitle），参数还没写完时缺的部分写作 …。
 * @param seatRoles agent_message 发给这些角色时是 Message <role>（进座位会话），其余是 Ask <role>（seatRolesOf）
 */
export function toolTitle(tool: ToolCall, cwd: string, seatRoles: readonly string[] = []): ToolTitle {
  if (isTeamTool(tool.name)) {
    return { verb: toolCallTitle(tool.name, tool.args ?? {}, { cwd, seatRoles, task: null }), target: '', suffix: '' };
  }
  if (tool.name === MEMORY_TOOL) return memoryTitle(tool);
  // subagent：Running 3 agents / Ran 3 agents（docs/specs/subagent.md §7.1；阶段行是 Running 3 agents 12s）
  if (tool.name === SUBAGENT_TOOL) return { verb: subagentCardTitle(tool), target: '', suffix: '' };
  if (tool.name === ASK_TOOL) return askTitle(tool);
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

/** @brief 标题的纯文字形式（阶段行、会话引用里的"[Tool] …"行用）；seatRoles 同 toolTitle。 */
export function toolTitleText(tool: ToolCall, cwd: string, seatRoles: readonly string[] = []): string {
  const title = toolTitle(tool, cwd, seatRoles);
  return [title.verb, title.target].filter(Boolean).join(' ') + title.suffix;
}
