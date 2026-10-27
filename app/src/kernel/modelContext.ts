// 跨模型上下文的规则（docs/specs/model-providers.md §6；docs/specs/parallel-agents-taskboard.md §8.3、§12.4、§12.6）：
// 纯函数。同一组函数既处理 pi 的 AgentMessage（context 钩子、压缩钩子），也处理 pi-ai 的 Message（流函数包装）：
// 重做与重建只认 user、assistant、toolResult 三种角色，compactionSummary、branchSummary、custom、bashExecution、system
// 原样保留（例外：重做把隐藏区间里收尾检查的检查那一行一起隐藏，docs/specs/finish-check.md §9.2）；
// task 会话中途换模型的重来（mori.task_restart）去掉它之前除 system 以外的全部消息。

import { CHECK_LINE_HEAD, FINISH_CHECK_TYPE, FINISH_TOOL } from '../shared/finishCheck';
import {
  plainReasonText, type ModelSwitchEntryData, type RebuildEntryData, type TaskRestartEntryData,
} from '../shared/models';

/** @brief 两种消息形状共有的部分：角色与时间戳（ms）。 */
export interface MessageLike {
  /** 角色 */
  role: string;
  /** 时间戳（ms）；pi 的消息都有 */
  timestamp?: number;
}

/** @brief 消息内容里的一块（text、image、thinking、toolCall 等）。 */
interface ContentBlock {
  /** 块的类型 */
  type: string;
  /** text 块的文字 */
  text?: string;
  /** toolCall 块的工具名 */
  name?: string;
  /** toolCall 块的参数 */
  arguments?: unknown;
}

/** @brief 有内容的消息（user、assistant、toolResult）。 */
interface ContentMessage extends MessageLike {
  /** 字符串或内容块 */
  content: string | ContentBlock[];
}

/** @brief 一个隐藏区间 [from, to]（§6.1）。 */
interface HiddenRange {
  /** 起点：replyStartedAt */
  from: number;
  /** 终点：hideUntil */
  to: number;
}

/**
 * @brief 重做说明（§6.1），加在这段 anchor 或最后一条插话的末尾。
 * @param from 原模型
 * @param reason 原因的界面文字（不带 until 部分）
 */
export function redoNote(from: string, reason: string): string {
  return `[Mori] The previous model (${from}) stopped partway through this reply (${reason}). `
    + 'Its partial work is hidden from you. Files in the workspace may already have been changed; '
    + 'check before you redo anything.';
}

/** @brief 消息的时间戳；没有时按 -Infinity（不落在任何区间里）。 */
function timeOf(message: MessageLike): number {
  return typeof message.timestamp === 'number' ? message.timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * @brief 换模型时的 hideUntil（§6.1）：上下文里助手消息和工具结果的最大时间戳；没有比 replyStartedAt 晚的时等于它。
 * @param messages 换模型时的上下文
 * @param replyStartedAt 这段开始的时刻（ms）
 */
export function hideUntilOf(messages: readonly MessageLike[], replyStartedAt: number): number {
  let hideUntil = replyStartedAt;
  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'toolResult') continue;
    hideUntil = Math.max(hideUntil, timeOf(message));
  }
  return hideUntil;
}

/**
 * @brief 这次请求是否跟在没有工具调用的助手消息之后（收尾检查规格 §9.2）：上下文里有最后一条助手消息，它没有 finish 以外的
 *        工具调用块，它之后也没有 finish 以外的工具结果。finish 不算干活：带着自己 finish 的回复同样完整。
 *        给了 since 时那条助手消息还要属于这一段（时间戳不早于段开始）：同一段里先隐藏过一次之后，处理过的上下文里
 *        最后一条助手消息可能是更早一次运行的回复，它不是这一段完整的回复（2026-10-27 实现时补，检查记录待负责人审）。
 *        为真时换模型不隐藏、不加重做说明（switchFrom 写 afterReply）。两种消息形状都适用。
 * @param messages 换模型时的上下文（末尾的工作卡已拿下）
 * @param since 这一段开始的时刻（ReplyState.startedAt，ms）；省略时不看助手消息属于哪一段
 */
export function followsToolFreeReply(messages: readonly MessageLike[], since?: number): boolean {
  const last = messages.findLastIndex((message) => message.role === 'assistant');
  if (last < 0) return false;
  if (since !== undefined && timeOf(messages[last]) < since) return false;
  const content = (messages[last] as unknown as ContentMessage).content;
  if (Array.isArray(content) && content.some((block) => block.type === 'toolCall' && block.name !== FINISH_TOOL)) {
    return false;
  }
  return !messages.slice(last + 1).some((message) => message.role === 'toolResult'
    && (message as MessageLike & { toolName?: unknown }).toolName !== FINISH_TOOL);
}

/** @brief 条目的隐藏区间；hideUntil 不晚于 replyStartedAt 的条目没有要隐藏的。 */
function hiddenRanges(entries: readonly ModelSwitchEntryData[]): HiddenRange[] {
  return entries.filter((entry) => entry.hideUntil > entry.replyStartedAt)
    .map((entry) => ({ from: entry.replyStartedAt, to: entry.hideUntil }));
}

/**
 * @brief 是否是收尾检查的检查那一行：AgentMessage 里 customType 为 mori.finish_check 的 custom 消息；pi-ai Message 里
 *        （pi 把 custom 转成 user）全部文字以 CHECK_LINE_HEAD 开始的 user 消息（同 isWorkCard 的认法，收尾检查规格 §9.2）。
 * @param message 消息
 */
function isCheckLine(message: MessageLike): boolean {
  const custom = message as MessageLike & { customType?: unknown; content?: unknown };
  if (message.role === 'custom') return custom.customType === FINISH_CHECK_TYPE;
  if (message.role !== 'user') return false;
  return contentText(custom.content).trimStart().startsWith(CHECK_LINE_HEAD);
}

/**
 * @brief 消息是否被隐藏：时间戳落在任一区间（并集）里的助手消息与工具结果（§6.1），以及检查那一行（收尾检查规格 §9.2、
 *        §0 第 18 条：它关于紧挨着它的那段回复，回复被隐藏时留下它会让新模型盲确认）。
 * @param message 消息
 * @param ranges 隐藏区间
 */
function isHidden(message: MessageLike, ranges: readonly HiddenRange[]): boolean {
  const time = timeOf(message);
  if (!ranges.some((range) => time >= range.from && time <= range.to)) return false;
  return message.role === 'assistant' || message.role === 'toolResult' || isCheckLine(message);
}

/**
 * @brief 判断一个消息谓词：消息是否在 mori.model_switch 条目的隐藏区间里（§6.1），供包装与压缩钩子共用。
 * @param entries 会话里的全部 mori.model_switch 条目
 * @return 消息被隐藏时为真的谓词
 */
export function hiddenBy(entries: readonly ModelSwitchEntryData[]): (message: MessageLike) => boolean {
  const ranges = hiddenRanges(entries);
  return (message) => isHidden(message, ranges);
}

/** @brief 重做说明的开头与结尾（§6.1），用来认出已经加过的说明。 */
const NOTE_HEAD = '[Mori] The previous model (';
const NOTE_TAIL = 'check before you redo anything.';

/**
 * @brief 文字末尾已有重做说明时，说明之前的部分（还带着说明前面的空行）。
 * @param text 文字
 * @return 说明之前的部分；末尾没有说明时为 null
 */
function beforeNote(text: string): string | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(NOTE_TAIL)) return null;
  const head = trimmed.lastIndexOf(NOTE_HEAD);
  return head < 0 ? null : trimmed.slice(0, head);
}

/**
 * @brief 去掉用户消息末尾已有的重做说明（处理过的上下文再处理时用，§6.1 结果不变）。
 * @param message 消息
 * @return 去掉后的新消息；不是用户消息或没有说明时返回原对象
 */
function stripNote<T extends MessageLike>(message: T): T {
  if (message.role !== 'user') return message;
  const user = message as unknown as ContentMessage;
  if (typeof user.content === 'string') {
    const prefix = beforeNote(user.content);
    return prefix === null ? message : { ...message, content: prefix.replace(/\n\n$/, '') };
  }
  const blocks = [...user.content];
  const last = blocks[blocks.length - 1];
  const prefix = last && last.type === 'text' ? beforeNote(last.text ?? '') : null;
  if (prefix === null) return message;
  if (prefix === '') blocks.pop();
  else blocks[blocks.length - 1] = { ...last, text: prefix.replace(/\n\n$/, '') };
  return { ...message, content: blocks };
}

/**
 * @brief 在用户消息内容末尾加上说明，不新增消息；已有的说明先去掉，只留这一条。
 * @param message 用户消息
 * @param note 说明
 * @return 新的消息对象（原消息不改）
 */
function appendNote<T extends MessageLike>(message: T, note: string): T {
  const stripped = stripNote(message);
  const user = stripped as unknown as ContentMessage;
  if (typeof user.content === 'string') return { ...stripped, content: `${user.content}\n\n${note}` };
  const blocks = [...user.content];
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') blocks[blocks.length - 1] = { ...last, text: `${last.text ?? ''}\n\n${note}` };
  else blocks.push({ type: 'text', text: note });
  return { ...stripped, content: blocks };
}

/**
 * @brief 一段工作里要加说明的用户消息的位置：anchor，或它之后时间戳不晚于 hideUntil 的最后一条用户消息（这段的插话）。
 *   隐藏之后，anchor 之后留下的第一条助手消息已是新模型的（晚于 hideUntil）；这段的插话都在它之前送达，
 *   它之后的用户消息属于后面的段（例如在这段换模型之前就排进来的排队消息，时间戳也可能不晚于 hideUntil）。
 * @param messages 去掉隐藏消息之后的上下文
 * @param anchorAt anchor 的时间戳
 * @param hideUntil 这段的隐藏区间的终点
 * @return 位置；找不到 anchor 时为 -1
 */
function noteTarget(messages: readonly MessageLike[], anchorAt: number, hideUntil: number): number {
  let anchor = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user' && timeOf(message) === anchorAt) anchor = index;
  });
  if (anchor < 0) return -1;
  let target = anchor;
  for (let index = anchor + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'assistant') break;
    if (message.role === 'user' && timeOf(message) <= hideUntil) target = index;
  }
  return target;
}

/**
 * @brief 一段工作的说明：用这段最后一条不带 afterReply 的条目的 from、reason 与 anchorAt，加到隐藏区间并集的终点为止。
 */
interface ReplyNote {
  /** 这段最后一条不带 afterReply 的条目 */
  entry: ModelSwitchEntryData;
  /** 这段各条目 hideUntil 的最大值（区间并集的终点） */
  hideUntil: number;
}

/**
 * @brief 按段（replyStartedAt）分组，取每段有隐藏的说明：最后一条条目与区间并集的终点。
 *   段内第二次换模型时上下文已去掉第一次隐藏的过程，它的 hideUntil 可能早于前一条，所以终点取最大值。
 *   带 afterReply 的条目跳过（收尾检查规格 §9.2）：回复已经完整，没有要重做的；同一段里更早的隐藏仍用那条更早的条目的
 *   from 与原因。
 * @param entries 会话里的全部 mori.model_switch 条目，按写入顺序
 */
function notesPerReply(entries: readonly ModelSwitchEntryData[]): ReplyNote[] {
  const byReply = new Map<number, ReplyNote>();
  for (const entry of entries) {
    if (entry.afterReply === true) continue;
    const hideUntil = Math.max(entry.hideUntil, byReply.get(entry.replyStartedAt)?.hideUntil ?? entry.hideUntil);
    byReply.set(entry.replyStartedAt, { entry, hideUntil });
  }
  return [...byReply.values()].filter((note) => note.hideUntil > note.entry.replyStartedAt);
}

/**
 * @brief 重做（§6.1）：去掉时间戳在 [replyStartedAt, hideUntil] 并集里的助手消息、工具结果与检查那一行（收尾检查规格
 *   §9.2）；在每段有被隐藏过程的 anchor（或最后一条插话）末尾加重做说明，只留一条（取这段最后一条不带 afterReply 的条目）。
 *   已处理过的上下文里已有的说明先去掉再加，所以对已处理过的上下文结果不变。
 * @param messages 发给模型的上下文（AgentMessage 或 pi-ai Message）
 * @param entries 会话里的全部 mori.model_switch 条目，按写入顺序
 * @return 处理后的新数组；输入不改
 */
export function applySwitchEntries<T extends MessageLike>(
  messages: readonly T[], entries: readonly ModelSwitchEntryData[],
): T[] {
  const hidden = hiddenBy(entries);
  const result = messages.filter((message) => !hidden(message)).map((message) => stripNote(message));
  for (const { entry, hideUntil } of notesPerReply(entries)) {
    const index = noteTarget(result, entry.anchorAt, hideUntil);
    if (index < 0) continue;
    result[index] = appendNote(result[index], redoNote(entry.from, plainReasonText(entry.reason, entry.detail)));
  }
  return result;
}

/**
 * @brief 重建（§6.3 第 3 步）：时间戳早于最后一条 mori.rebuild 的 at 的消息里，工具结果去掉；助手消息去掉思考与工具调用块，
 *   变空就去掉；其他角色原样保留。对已处理过的上下文结果不变。
 * @param messages 发给模型的上下文（AgentMessage 或 pi-ai Message）
 * @param entries 会话里的全部 mori.rebuild 条目
 * @return 处理后的新数组；输入不改
 */
export function applyRebuildEntries<T extends MessageLike>(
  messages: readonly T[], entries: readonly RebuildEntryData[],
): T[] {
  if (entries.length === 0) return [...messages];
  const at = Math.max(...entries.map((entry) => entry.at));
  const result: T[] = [];
  for (const message of messages) {
    if (timeOf(message) >= at) result.push(message);
    else if (message.role === 'toolResult') continue;
    else if (message.role !== 'assistant') result.push(message);
    else {
      const assistant = message as unknown as ContentMessage;
      if (typeof assistant.content === 'string') {
        result.push(message);
        continue;
      }
      const kept = assistant.content.filter((block) => block.type !== 'thinking' && block.type !== 'toolCall');
      if (kept.length === 0) continue;
      result.push(kept.length === assistant.content.length ? message : { ...message, content: kept });
    }
  }
  return result;
}

// ---- task 会话中途换模型的重来（平行 Agent 规格 §12.4） ----

/**
 * @brief 消息是否在最后一条 mori.task_restart 之前：时间戳早于它的 at、且不是 system 消息
 *        （system 消息是 pi 的 system prompt 与工具清单，不是对话，照常发出）。
 * @param entries 会话里的全部 mori.task_restart 条目
 * @return 消息不再发给模型时为真的谓词；没有条目时总是假
 */
export function restartHiddenBy(entries: readonly TaskRestartEntryData[]): (message: MessageLike) => boolean {
  if (entries.length === 0) return () => false;
  const at = Math.max(...entries.map((entry) => entry.at));
  return (message) => message.role !== 'system' && timeOf(message) < at;
}

/**
 * @brief 重来（平行 Agent 规格 §12.4，与重做、重建并列）：有 mori.task_restart 时，时间戳早于最后一条的 at 的消息都不发给
 *   模型（工作卡与继续的消息是新的起点）；system 消息照常保留。会话文件不变，read_session 照常读得到前半段。
 *   对已处理过的上下文结果不变。
 * @param messages 发给模型的上下文（AgentMessage 或 pi-ai Message）
 * @param entries 会话里的全部 mori.task_restart 条目
 * @return 处理后的新数组；输入不改
 */
export function applyRestartEntries<T extends MessageLike>(
  messages: readonly T[], entries: readonly TaskRestartEntryData[],
): T[] {
  const hidden = restartHiddenBy(entries);
  return messages.filter((message) => !hidden(message));
}

// ---- 工作卡（平行 Agent 规格 §8.3） ----

/** @brief 工作卡 custom 消息的 customType（mori-team 的 context 钩子追加，不写进会话文件）。 */
export const WORK_CARD_TYPE = 'mori.work_card';
/** @brief 工作卡的第一行与最后一行。 */
export const WORK_CARD_OPEN = '<mori-work-card>';
export const WORK_CARD_CLOSE = '</mori-work-card>';

/** @brief 内容的纯文字：字符串，或各 text 块相接（rewind.ts 取你的消息的正文也用它，文件系统规格 §5.8）。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: ContentBlock) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

/**
 * @brief 是否是工作卡消息：AgentMessage 里 customType 为 mori.work_card 的 custom 消息；pi-ai Message 里（pi 把 custom
 *        转成 user）全部文字就是一张卡（去掉首尾空白后以 WORK_CARD_OPEN 开始、以 WORK_CARD_CLOSE 结束）的 user 消息。
 * @param message 消息
 */
export function isWorkCard(message: MessageLike): boolean {
  const custom = message as MessageLike & { customType?: unknown; content?: unknown };
  if (message.role === 'custom') return custom.customType === WORK_CARD_TYPE;
  if (message.role !== 'user') return false;
  const text = contentText(custom.content).trim();
  return text.startsWith(WORK_CARD_OPEN) && text.endsWith(WORK_CARD_CLOSE);
}

/** @brief 从上下文末尾拿下的工作卡（流函数包装换模型重发时，§8.3）。 */
export interface DetachedWorkCard<T> {
  /** 去掉末尾工作卡之后的上下文 */
  messages: T[];
  /** 拿下的那张卡；末尾没有卡时为 null */
  card: T | null;
}

/**
 * @brief 去掉上下文末尾的工作卡（§8.3：先去掉卡片再做模型层的处理，然后重新追加，卡片总在最后）。
 * @param messages 这次请求的上下文
 */
export function detachWorkCard<T extends MessageLike>(messages: readonly T[]): DetachedWorkCard<T> {
  const last = messages[messages.length - 1];
  if (!last || !isWorkCard(last)) return { messages: [...messages], card: null };
  return { messages: messages.slice(0, -1), card: last };
}

/**
 * @brief 把 detachWorkCard 拿下的卡接回处理后的上下文末尾。
 * @param processed 模型层处理后的上下文
 * @param card 拿下的卡；没有时原样返回
 */
export function reattachWorkCard<T extends MessageLike>(processed: readonly T[], card: T | null): T[] {
  return card === null ? [...processed] : [...processed, card];
}

// ---- 接手判断（§6.2） ----

/** @brief 一条助手消息记的模型身份（两种消息形状都有）。 */
export interface ModelIdentity {
  /** 提供商 id */
  provider: string;
  /** 接口类型 */
  api: string;
  /** 模型 id */
  model: string;
}

/** @brief 接手判断要用的目标模型 B。 */
export interface HandoverTarget extends ModelIdentity {
  /** 档案的 reasoning.replay（§7.2） */
  replay: 'required' | 'not_required' | 'unknown';
  /** 有效窗口（token，§7.2 context.effective） */
  effectiveWindow: number;
  /** 最大输出（token） */
  maxTokens: number;
}

/** @brief 接手判断的输入。 */
export interface HandoverInput<T extends MessageLike> {
  /** 按 §6.1、§6.3 处理后的上下文 */
  messages: readonly T[];
  /** 要用的模型 B */
  target: HandoverTarget;
  /**
   * @brief 估算一条消息的 token 数（pi 的 estimateTokens）。
   * @param message 消息
   */
  estimateTokens(message: T): number;
  /** 不在 messages 里、每次请求都会加上的 token 数：工作卡的估算（平行 Agent 规格 §8.3、§12.6）；省略时为 0 */
  extraTokens?: number;
}

/** @brief 接手判断的结果（§6.2）。 */
export interface HandoverCheck {
  /** B 与上下文里最后一条有效助手消息的模型不同；相同或没有助手消息时其余两项都为真 */
  differs: boolean;
  /** 推理字段条件满足（B 不要求回传推理，或上下文里没有别的模型产生的带工具调用的助手消息） */
  reasoningOk: boolean;
  /** 窗口条件满足：估算 token 数加 B 的 maxTokens 不超过 B 的有效窗口 */
  fitsWindow: boolean;
  /** 估算的上下文 token 数 */
  tokens: number;
}

/** @brief 消息记的模型身份；不是助手消息时为 null。 */
function identityOf(message: MessageLike): ModelIdentity | null {
  if (message.role !== 'assistant') return null;
  const assistant = message as unknown as Partial<ModelIdentity>;
  return {
    provider: String(assistant.provider ?? ''), api: String(assistant.api ?? ''), model: String(assistant.model ?? ''),
  };
}

/** @brief 两个模型是否不同：提供商、接口、模型 id 有一个不同。 */
function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.provider === b.provider && a.api === b.api && a.model === b.model;
}

/** @brief 最后一条有效助手消息（不是出错或中止的）的模型。 */
function lastValidModel(messages: readonly MessageLike[]): ModelIdentity | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as MessageLike & { stopReason?: string };
    if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    return identityOf(message);
  }
  return null;
}

/** @brief 上下文里有没有别的模型产生的、带工具调用的助手消息。 */
function hasForeignToolCalls(messages: readonly MessageLike[], target: ModelIdentity): boolean {
  return messages.some((message) => {
    const identity = identityOf(message);
    if (!identity || sameModel(identity, target)) return false;
    const content = (message as unknown as ContentMessage).content;
    return Array.isArray(content) && content.some((block) => block.type === 'toolCall');
  });
}

/**
 * @brief 窗口条件（§6.2）：估算的上下文 token 数加 B 的最大输出不超过 B 的有效窗口。
 * @param tokens 估算的上下文 token 数
 * @param target 要用的模型 B
 */
export function fitsWindow(tokens: number, target: Pick<HandoverTarget, 'maxTokens' | 'effectiveWindow'>): boolean {
  return tokens + target.maxTokens <= target.effectiveWindow;
}

/**
 * @brief 接手判断（§6.2）：B 与最后一条有效助手消息的模型不同时，检查推理字段与窗口两个条件；工具调用格式总是满足。
 *        估算的 token 数含 extraTokens（工作卡，平行 Agent 规格 §12.6）。
 * @param input 上下文、目标模型、token 估算函数与额外的 token 数
 */
export function handoverCheck<T extends MessageLike>(input: HandoverInput<T>): HandoverCheck {
  const tokens = input.messages.reduce((sum, message) => sum + input.estimateTokens(message), input.extraTokens ?? 0);
  const last = lastValidModel(input.messages);
  if (last === null || sameModel(last, input.target)) {
    return { differs: false, reasoningOk: true, fitsWindow: true, tokens };
  }
  const reasoningOk = input.target.replay !== 'required' || !hasForeignToolCalls(input.messages, input.target);
  return { differs: true, reasoningOk, fitsWindow: fitsWindow(tokens, input.target), tokens };
}

/** @brief 接手判断发生的时机（§6.2）：段开始、段开始重建之后、段内。 */
export type HandoverPhase = 'start' | 'rebuilt' | 'in_reply';

/** @brief 接手判断之后要做的事：直接接手、重建（§6.3）、只做 §6.3 第 2–3 步（不压缩）、排除 B（no_handover）。 */
export type HandoverAction = 'ok' | 'rebuild' | 'strip' | 'exclude';

/**
 * @brief 按时机决定接手判断之后要做的事（§6.2 两条）。
 *   段开始：任一条件不满足就重建；重建后窗口仍不够就排除。段内：窗口不够就排除；只有推理字段不满足时只去掉、不压缩。
 * @param check 接手判断的结果
 * @param phase 时机
 */
export function handoverAction(check: HandoverCheck, phase: HandoverPhase): HandoverAction {
  if (phase === 'start') return check.reasoningOk && check.fitsWindow ? 'ok' : 'rebuild';
  if (!check.fitsWindow) return 'exclude';
  if (phase === 'in_reply' && !check.reasoningOk) return 'strip';
  return 'ok';
}

// ---- 压缩（§6.1 最后一条） ----

/** @brief 压缩前 pi 算好的文件操作（三个集合）。 */
export interface FileOpsLike {
  /** 读过的路径 */
  read: Set<string>;
  /** 写过的路径 */
  written: Set<string>;
  /** 改过的路径 */
  edited: Set<string>;
}

/** @brief session_before_compact 的 preparation 里要改的部分。 */
export interface CompactionPreparationLike<T extends MessageLike> {
  /** 要摘要并丢弃的消息 */
  messagesToSummarize: T[];
  /** 拆开的那一轮的前半段 */
  turnPrefixMessages: T[];
  /** 从 messagesToSummarize 算出的文件操作 */
  fileOps: FileOpsLike;
  /** 上一次压缩的摘要，pi 把它并进这次的摘要；没有时省略 */
  previousSummary?: string;
}

/** @brief 一次工具调用：名字与参数（助手消息的 toolCall 块，或工具结果记下的嵌套调用）。 */
interface ToolCallLike {
  /** 工具名 */
  name?: unknown;
  /** 参数 */
  arguments?: unknown;
}

/** @brief pi 记文件操作的工具与它记进的集合（pi 压缩的 addFileOp：read、write、edit）。 */
const FILE_OP_TOOLS = new Map<unknown, keyof FileOpsLike>([['read', 'read'], ['write', 'written'], ['edit', 'edited']]);

/** @brief 一条消息里的工具调用：助手消息的工具调用块，工具结果记下的嵌套调用（与 pi 的 extractFileOpsFromMessage 同）。 */
function toolCallsOf(message: MessageLike): ToolCallLike[] {
  if (message.role === 'toolResult') {
    const nested = (message as MessageLike & { nestedCalls?: { calls?: ToolCallLike[] } }).nestedCalls;
    return nested?.calls ?? [];
  }
  if (message.role !== 'assistant') return [];
  const content = (message as unknown as ContentMessage).content;
  return Array.isArray(content) ? content.filter((block) => block.type === 'toolCall') as ToolCallLike[] : [];
}

/** @brief 一组消息的文件操作，按 pi 的规则分进三个集合。 */
function fileOpsOf(messages: readonly MessageLike[]): FileOpsLike {
  const ops: FileOpsLike = { read: new Set(), written: new Set(), edited: new Set() };
  for (const call of messages.flatMap((message) => toolCallsOf(message))) {
    const kind = FILE_OP_TOOLS.get(call.name);
    const path = (call.arguments as { path?: unknown } | undefined)?.path;
    if (kind && typeof path === 'string' && path) ops[kind].add(path);
  }
  return ops;
}

/** @brief 上一次压缩记下的文件列表（pi 压缩条目的 details；pi 把它们并进这次的 fileOps）。 */
export interface PreviousFileLists {
  /** 只读过的文件：pi 并进 read */
  readFiles?: unknown;
  /** 改过的文件：pi 并进 edited */
  modifiedFiles?: unknown;
}

/**
 * @brief 上一次压缩记下的文件列表：分支上最后一条压缩条目的 details（pi 压缩时把它并进这次的 fileOps）；
 *   扩展生成的压缩条目（fromHook）pi 不用，这里也不用。
 * @param entries 会话当前分支上的条目（session_before_compact 的 branchEntries）
 * @return 文件列表；没有时为 null
 */
export function previousFileLists(
  entries: readonly { type: string; fromHook?: boolean; details?: unknown }[],
): PreviousFileLists | null {
  const last = entries.findLast((entry) => entry.type === 'compaction');
  if (!last || last.fromHook || !last.details || typeof last.details !== 'object') return null;
  return last.details as PreviousFileLists;
}

/** @brief 把上一次压缩的文件列表照 pi 的做法并进 ops。 */
function addPrevious(ops: FileOpsLike, previous: PreviousFileLists | null): void {
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === 'string')
    : []);
  for (const path of list(previous?.readFiles)) ops.read.add(path);
  for (const path of list(previous?.modifiedFiles)) ops.edited.add(path);
}

/**
 * @brief 就地从数组里去掉被隐藏的消息。
 * @param messages 数组（就地修改）
 * @param hidden 隐藏谓词
 * @return 去掉的消息
 */
function removeInPlace<T extends MessageLike>(messages: T[], hidden: (message: MessageLike) => boolean): T[] {
  const removed = messages.filter((message) => hidden(message));
  const kept = messages.filter((message) => !hidden(message));
  messages.splice(0, messages.length, ...kept);
  return removed;
}

/**
 * @brief 压缩也不能把被隐藏的过程带给新模型（§6.1、§11.6 K12）：就地从 messagesToSummarize 与 turnPrefixMessages
 *   去掉被隐藏的助手消息、工具结果与检查那一行（收尾检查规格 §9.2），以及重来之前的消息（平行 Agent 规格 §12.4，与 applyRestartEntries 同一条规则），
 *   并从 fileOps 的三个集合里去掉只在去掉的工具调用里出现过的路径：
 *   每个集合分别看，留下的消息或上一次压缩的文件列表也给这个集合带来这个路径时保留。
 * @param preparation session_before_compact 的 preparation（就地修改）
 * @param entries 会话里的全部 mori.model_switch 条目
 * @param previous 上一次压缩（pi 生成的）记下的文件列表；没有时为 null
 * @param restarts 会话里的全部 mori.task_restart 条目；省略时没有
 */
export function stripForCompaction<T extends MessageLike>(
  preparation: CompactionPreparationLike<T>, entries: readonly ModelSwitchEntryData[],
  previous: PreviousFileLists | null = null, restarts: readonly TaskRestartEntryData[] = [],
): void {
  const switched = hiddenBy(entries);
  const restarted = restartHiddenBy(restarts);
  const hidden = (message: MessageLike): boolean => switched(message) || restarted(message);
  const removed = [
    ...removeInPlace(preparation.messagesToSummarize, hidden),
    ...removeInPlace(preparation.turnPrefixMessages, hidden),
  ];
  if (removed.length === 0) return;
  const hiddenOps = fileOpsOf(removed);
  const keptOps = fileOpsOf([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
  addPrevious(keptOps, previous);
  for (const kind of ['read', 'written', 'edited'] as const) {
    for (const path of hiddenOps[kind]) if (!keptOps[kind].has(path)) preparation.fileOps[kind].delete(path);
  }
}

/** @brief 分支上的一个条目：压缩条目带写入时刻（ISO 字符串）、是否由扩展生成与 details。 */
export interface BranchEntryLike {
  /** 条目类型 */
  type: string;
  /** 写入时刻（pi 的 ISO 字符串） */
  timestamp?: string;
  /** 扩展生成的压缩 */
  fromHook?: boolean;
  /** 压缩条目的 details（pi 生成的记着文件列表） */
  details?: unknown;
}

/**
 * @brief 上一次压缩早于最后一次重来时（平行 Agent 规格 §12.4）：它的摘要与文件列表是重来之前的过程，这次压缩不再并入。
 *   就地清掉 previousSummary，并从 fileOps 去掉只由它的文件列表带来的路径（留下的消息也带来这个路径时保留）。
 *   在 stripForCompaction 之后调用。
 * @param preparation session_before_compact 的 preparation（就地修改）
 * @param entries 会话当前分支上的条目（session_before_compact 的 branchEntries）
 * @param restarts 会话里的全部 mori.task_restart 条目
 */
export function forgetCompactionBeforeRestart<T extends MessageLike>(
  preparation: CompactionPreparationLike<T>, entries: readonly BranchEntryLike[],
  restarts: readonly TaskRestartEntryData[],
): void {
  const last = entries.findLast((entry) => entry.type === 'compaction');
  if (!last || restarts.length === 0) return;
  const at = Math.max(...restarts.map((entry) => entry.at));
  const compactedAt = typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : Number.NaN;
  if (!(compactedAt < at)) return;
  preparation.previousSummary = undefined;
  const previous = previousFileLists(entries);
  if (!previous) return;
  const kept = fileOpsOf([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
  const stale: FileOpsLike = { read: new Set(), written: new Set(), edited: new Set() };
  addPrevious(stale, previous);
  for (const kind of ['read', 'edited'] as const) {
    for (const path of stale[kind]) if (!kept[kind].has(path)) preparation.fileOps[kind].delete(path);
  }
}
