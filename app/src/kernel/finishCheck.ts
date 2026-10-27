// 收尾检查的规则与文字（docs/specs/finish-check.md §4、§5、§6、§7、§8.3）：一次运行要结束时 mori-memory 加一行检查、
// 让模型再看一眼 TASTE 与 REVIEW，模型调 finish 确认、接着干活或重写回复。这里只有纯函数与常量，不读写文件；
// pi 只 import type（AGENTS.md 工作约定第 7 条），finishTool 返回的是普通对象。给模型看的文字是英文（§7）。

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { FINISH_CHECK_TYPE, FINISH_TOOL } from '../shared/finishCheck';
import type { ContentBlockLike, SessionEntryLike } from './sessionReader';

/** @brief 一次运行最多检查几次（proposal §12 第 3 条，负责人定的）。 */
export const FINISH_CHECK_CAP = 3;

/** @brief 用户会话里 sessions.ts 与 mori-memory 共用的、给窗口估算用的状态（§9.3）；一个用户会话一份。 */
export interface FinishCheckLink {
  /** 检查那次请求的检查块的 token 估算；那次请求的 context 处理器跑过之后、或这次运行 agent_settled 之后为 0 */
  pendingTokens: number;
}

/** @brief 检查那一行与检查块点名的分节（§6.3）：这次运行 system prompt 里有内容的 taste、review。 */
export type CheckKind = 'taste' | 'review';

// ---- 模型看到的文字（§7） ----

/** @brief 检查那一行的第一、二、四行（§7.1）；第三行按 kinds 选。只给模型看（不显示的 custom_message），撇号照原样。 */
const CHECK_HEAD = "[Mori] This is Mori's end-of-turn check, not a message from the user. "
  + 'It is about your reply just before it.';
/** 检查那一行的第二行，只给模型看，撇号照原样。 */
const CHECK_TOOLS = "If you said you would do something and haven't done it, or a tool call you meant to make was "
  + "never sent, do it now with your tools. Don't retry calls that were rejected or denied.";
/** 检查那一行的第四行，只给模型看，撇号照原样。 */
const CHECK_REPLY = 'Anything you write now is shown to the user as your reply. If that reply is final, including a '
  + "question that waits for the user's answer, only call finish. To change it, write the new reply, then call finish.";

/**
 * @brief finish 的说明（§7.3）：第一行 Customize 页显示，展开时显示全文，所以撇号用 ’（docs/v0/ui-strings.md；同 subagent
 *        的说明，U30；docs/v1/walkthrough-1026-checks.md 的 U49）。
 */
const FINISH_DESCRIPTION = 'Confirm that your last reply is your final reply.\n'
  + 'Call this only when Mori’s end-of-turn check asks for it. Write your reply as normal text first: finish takes '
  + 'no arguments, and anything passed to it is rejected.';

/** @brief finish 的结果（§4.1、§0 第 3 条）。 */
export const FINISH_RESULT = 'Confirmed.';

/**
 * @brief 检查那一行（§7.1）：四行以 \n 分隔；第三行按 kinds 点名检查块里有的分节，kinds 为空时整行去掉。
 * @param kinds 这次运行有内容的分节，按 taste、review 的顺序
 */
export function checkLine(kinds: readonly CheckKind[]): string {
  const names = kinds.map((kind) => `<${kind}>`);
  const against = names.length === 0 ? [] : [`Otherwise check that reply against ${names.join(' and ')} below.`];
  return [CHECK_HEAD, CHECK_TOOLS, ...against, CHECK_REPLY].join('\n');
}

/**
 * @brief 检查块（§7.2）：与 system prompt 里那两段同一写法 `<名字>\n内容\n</名字>`，两段之间一个 \n。
 * @param sections 这次运行的 taste、review 分节内容（memorySections 的值，没有时为 null）
 * @return 检查块；两段都为 null 时为 null
 */
export function checkBlock(sections: { taste: string | null; review: string | null }): string | null {
  const parts: string[] = [];
  if (sections.taste !== null) parts.push(`<taste>\n${sections.taste}\n</taste>`);
  if (sections.review !== null) parts.push(`<review>\n${sections.review}\n</review>`);
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * @brief finish 工具（§4.1）：没有参数（additionalProperties: false，没有 prepareArguments，多余字段由 pi 校验拒绝），
 *        不进 system prompt 的 <tools>、<rules>（没有 promptSnippet、promptGuidelines），默认启用，结果带 terminate。
 */
export function finishTool(): ToolDefinition {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  return {
    name: FINISH_TOOL,
    label: 'Finish',
    description: FINISH_DESCRIPTION,
    parameters: schema as unknown as ToolDefinition['parameters'],
    defaultActive: true,
    execute: async () => ({ content: [{ type: 'text', text: FINISH_RESULT }], details: {}, terminate: true }),
  };
}

// ---- 什么时候检查（§5.2、§5.3） ----

/** @brief 上下文里的一条消息（pi AgentMessage 的子集）：custom 消息带 customType，工具结果带 toolCallId 与 toolName。 */
export interface CheckMessage {
  /** 角色：user、assistant、toolResult、custom、compactionSummary 等 */
  role: string;
  /** custom 消息的种类 */
  customType?: string;
  /** 字符串或内容块 */
  content?: unknown;
  /** toolResult：对应的调用 id */
  toolCallId?: string;
  /** toolResult：工具名 */
  toolName?: string;
  /** toolResult：结果是不是错误 */
  isError?: boolean;
}

/** @brief 放行或检查的原因（§5.3，日志用）。 */
export type SettleReason = 'first' | 'confirmed' | 'no work' | 'limit' | 'work';

/** @brief settleDecision 的结果（§5.2）。 */
export interface SettleDecision {
  /** 为真时加检查那一行并接着跑；为假时放行 */
  check: boolean;
  /** 起点之后看得到的检查那一行的条数（不含这次要加的） */
  checks: number;
  /** 决定表里成立的那一行（§5.3） */
  reason: SettleReason;
}

/** @brief 是不是检查那一行（AgentMessage 形状：custom 消息，customType 为 mori.finish_check）。 */
function isCheckLine(message: CheckMessage): boolean {
  return message.role === 'custom' && message.customType === FINISH_CHECK_TYPE;
}

/** @brief 助手消息里的工具调用块；内容不是数组或块的形状读不出时当作没有（§5.1：处理器不抛错）。 */
function toolCalls(content: unknown): ContentBlockLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlockLike => typeof block === 'object' && block !== null
    && (block as ContentBlockLike).type === 'toolCall');
}

/** @brief 起点之后的计数（§5.2 第 2 步）。 */
interface CheckCount {
  /** 检查那一行的条数 */
  checks: number;
  /** 最近一行检查之后有 finish 以外的工具调用（干活） */
  worked: boolean;
  /** 最近一行检查之后单独的 finish 成功了（确认） */
  confirmed: boolean;
}

/**
 * @brief 从起点（最后一条 role 为 user 的消息；没有时从开头）往后数检查那一行、干活与确认（§5.2）。
 *        干活从助手消息里的工具调用块数，不从结果数：被拒绝、找不到、参数不合格、被截断判失败的调用都算（proposal §4）。
 * @param messages 这次运行的消息（处理器给的是 runMessages 从分支上取的，压缩收进摘要的也在）
 */
function countSinceStart(messages: readonly CheckMessage[]): CheckCount {
  const start = messages.findLastIndex((message) => message.role === 'user');
  const count: CheckCount = { checks: 0, worked: false, confirmed: false };
  // 检查之后单独调用的 finish 的调用 id（一条助手消息里只有它一个工具调用）
  let alone = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (isCheckLine(message)) {
      count.checks += 1;
      count.worked = false;
      count.confirmed = false;
      alone = new Set();
    } else if (message.role === 'assistant') {
      const calls = toolCalls(message.content);
      if (calls.some((block) => block.name !== FINISH_TOOL)) count.worked = true;
      const only = calls.length === 1 ? calls[0] : undefined;
      if (only?.name === FINISH_TOOL && typeof only.id === 'string') alone.add(only.id);
    } else if (message.role === 'toolResult' && message.toolName === FINISH_TOOL && message.isError !== true
      && message.toolCallId !== undefined && alone.has(message.toolCallId)) {
      count.confirmed = true;
    }
  }
  return count;
}

/**
 * @brief 运行要结束时检查还是放行（§5.2、§5.3 的决定表，取第一条成立的）：没检查过 → 检查；检查之后单独的 finish 成功
 *        → 放行；检查之后没干活 → 放行；已检查 FINISH_CHECK_CAP 次 → 放行；其余（干了活，或 finish 与别的调用同一批）→ 检查。
 *        不另存状态，只看会话（proposal §13 第 19 条）。
 * @param messages 这次运行的消息（AgentMessage 的形状；处理器给的是 runMessages 从分支上取的）
 */
export function settleDecision(messages: readonly CheckMessage[]): SettleDecision {
  const { checks, worked, confirmed } = countSinceStart(messages);
  if (checks === 0) return { check: true, checks, reason: 'first' };
  if (confirmed) return { check: false, checks, reason: 'confirmed' };
  if (!worked) return { check: false, checks, reason: 'no work' };
  if (checks >= FINISH_CHECK_CAP) return { check: false, checks, reason: 'limit' };
  return { check: true, checks, reason: 'work' };
}

/**
 * @brief 当前分支上的消息，按 AgentMessage 的形状给 settleDecision（§5.2）：message 条目取它的消息，custom_message 条目
 *        （检查那一行、提醒）为 custom 消息；压缩条目与其余不进上下文的条目跳过，被 context_edit 去掉的消息跳过
 *        （§5.4 第 4 条）。压缩只改投影、不删分支上的条目，收进摘要的检查那一行与 finish 在这里仍数得到（§5.4 第 5 条）：
 *        按投影数时，每次回复后都压缩、留下的又不到一次检查那么长，每到边界都数不到上一次检查，运行停不下来。
 * @param branch 用户会话的当前分支（ctx.sessionManager.getBranch()）
 */
export function runMessages(branch: readonly BranchEntry[]): CheckMessage[] {
  const omitted = omittedIds(branch);
  const messages: CheckMessage[] = [];
  for (const entry of branch) {
    if (omitted.has(entry.id)) continue;
    if (entry.type === 'message' && entry.message) messages.push(entry.message);
    else if (entry.type === 'custom_message') messages.push({ role: 'custom', customType: entry.customType });
  }
  return messages;
}

// ---- 检查那次请求（§6） ----

/**
 * @brief 这次请求是不是检查那次请求（§6.1）：从末尾往前跳过别的 custom 消息（工作卡、提醒），遇到检查那一行返回它的下标，
 *        遇到别的角色（user、assistant、toolResult、摘要等）返回 -1。
 * @param messages context 钩子里的这次请求的消息（AgentMessage，已经模型层处理、可能已接上工作卡）
 */
export function checkRequestIndex(messages: readonly CheckMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isCheckLine(message)) return index;
    if (message.role !== 'custom') return -1;
  }
  return -1;
}

/**
 * @brief 把检查块接进检查那一行（§6.2）：返回新数组，index 处换成同一条 custom 消息，内容为 `${原文}\n\n${block}`
 *        （内容是块数组时在最后加一个 text 块）；其余消息原样，输入不改。index 小于 0 或 block 为 null 时原样返回输入。
 * @param messages 这次请求的消息
 * @param index checkRequestIndex 的结果
 * @param block 这次运行的检查块
 */
export function withCheckBlock<T extends CheckMessage>(messages: readonly T[], index: number,
  block: string | null): readonly T[] {
  if (index < 0 || block === null || index >= messages.length) return messages;
  const line = messages[index];
  const content = Array.isArray(line.content) ? [...line.content, { type: 'text', text: `\n\n${block}` }]
    : `${typeof line.content === 'string' ? line.content : ''}\n\n${block}`;
  const result = [...messages];
  result[index] = { ...line, content } as T;
  return result;
}

// ---- 检查那次请求出错（§8.3） ----

/** @brief 进上下文的条目种类：其余（custom、model_change、label 等）在 followsCheck 里跳过。 */
const CONTEXT_ENTRY_TYPES = new Set(['message', 'custom_message', 'compaction', 'branch_summary']);

/** @brief 当前分支上的一条条目（pi SessionEntry 的子集）。 */
type BranchEntry = SessionEntryLike & {
  /** custom_message 条目的种类 */
  customType?: string;
  /** context_edit 条目改的那一条的 id */
  targetId?: string;
  /** context_edit 条目的新内容；null 表示把那一条从上下文里去掉 */
  replacement?: unknown;
};

/**
 * @brief pi 用 context_edit（replacement 为 null）从上下文里去掉的条目 id：可恢复的截断与溢出出错后，pi 去掉那次回复、
 *        压缩，再在同一次运行里重试（§3 第 12 条）；去掉的那条仍在分支上。
 * @param branch 当前分支
 */
function omittedIds(branch: readonly BranchEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type === 'context_edit' && entry.replacement === null && entry.targetId) ids.add(entry.targetId);
  }
  return ids;
}

/**
 * @brief 出错的这次请求跟着的检查那一行在分支上的下标（§8.3）：从分支末尾往前，跳过不进上下文的条目、被 context_edit
 *        去掉的消息（检查那次请求被截断或溢出后重试，前一次回复已去掉，重试仍是检查那次请求，§1）、末尾一条出错的助手消息
 *        （message_end 先发给监听者、后写盘，它可能已在也可能还不在分支上）、别的 custom_message（提醒）、
 *        system 消息与压缩条目（检查那一行与出错的消息之间可能有，§3 第 18 条）；遇到检查那一行返回它的下标，遇到别的为 -1。
 * @param branch 用户会话的当前分支
 */
export function checkLineIndex(branch: readonly BranchEntry[]): number {
  const omitted = omittedIds(branch);
  let skippedError = false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!CONTEXT_ENTRY_TYPES.has(entry.type) || entry.type === 'compaction' || omitted.has(entry.id)) continue;
    if (entry.type === 'custom_message') {
      if (entry.customType === FINISH_CHECK_TYPE) return index;
      continue;
    }
    if (entry.type !== 'message') return -1;
    const message = entry.message;
    if (message?.role === 'system') continue;
    if (!skippedError && message?.role === 'assistant' && message.stopReason === 'error') {
      skippedError = true;
      continue;
    }
    return -1;
  }
  return -1;
}

/**
 * @brief 出错的这次请求是不是检查那次请求（§8.3），即 checkLineIndex 找得到检查那一行。
 * @param branch 用户会话的当前分支
 */
export function followsCheck(branch: readonly BranchEntry[]): boolean {
  return checkLineIndex(branch) >= 0;
}

/**
 * @brief 助手消息的文字，去掉首尾空白：字符串内容，或全部 text 块按顺序以换行相接（同 sessionReader 的 messageText；
 *        这个文件只 import 类型，§2）。
 * @param content 消息内容
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((block): block is ContentBlockLike => (block as ContentBlockLike)?.type === 'text')
    .map((block) => block.text ?? '').join('\n').trim();
}

/**
 * @brief 检查那一行之前、这次运行里最后一段非空文字（§8.3）：从 index 往前走到最近一条 user 消息为止，跳过被 context_edit
 *        去掉的消息；没有时为 null。检查那次请求出错时 Team 的 lastText 取它：被截断后去掉的那次回复已在它的 message_end
 *        改过 lastText，不能留着。
 * @param branch 用户会话的当前分支
 * @param index checkLineIndex 的结果
 */
export function textBeforeCheck(branch: readonly BranchEntry[], index: number): string | null {
  const omitted = omittedIds(branch);
  for (let at = index - 1; at >= 0; at -= 1) {
    const entry = branch[at];
    if (entry.type !== 'message' || !entry.message || omitted.has(entry.id)) continue;
    if (entry.message.role === 'user') return null;
    if (entry.message.role !== 'assistant') continue;
    const text = textOf(entry.message.content);
    if (text) return text;
  }
  return null;
}
