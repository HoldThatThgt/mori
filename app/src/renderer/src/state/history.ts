// 把 pi 记录的当前分支（SessionManager.getBranch 的条目）转成对话流：你的消息、助手回复、工具结果、压缩处，
// 以及 Mori 写的引用来源（mori.ref 条目，记到它指向的你的消息上）、模型层的换模型与重建（mori.model_switch、
// mori.rebuild 条目，docs/v1/screens/model-chat.md）。系统消息、用量、选择范围（mori.pick）等记录不显示。
// 平行 Agent（docs/specs/parallel-agents-taskboard.md §13.11）：mori.receipt 是回执行，mori.progress 是进展摘要的位置
// （内容用会话信息里的 TaskBoard 视图），mori.wake 把它指向的用户消息变成不显示的 wake 条目，mori.team 不显示。

import { z } from 'zod';
import {
  QuoteRefSchema, REF_ENTRY_TYPE, type LiveSnapshot, type SessionEntry, type SessionInfo,
} from '../../../shared/protocol';
import { EXCLUSION_REASONS, MODEL_ENTRY_TYPES } from '../../../shared/models';
import {
  ProgressEntrySchema, ReceiptEntrySchema, TEAM_ENTRY_TYPES, TeamEntrySchema, WakeEntrySchema, type ReceiptKind,
  type TeamMode, type WakeKind,
} from '../../../shared/team';
import {
  blocksFromContent, contentText, emptyTranscript, messageTime, parseRejection, pushItem, resultPatch, type ToolCall,
  type Transcript,
} from './model';
import { attachReceipt, RECEIPT_TOOLS } from './teamEvents';

/** mori.ref 条目的内容（会话文件里读出来的，先校验） */
const RefDataSchema = z.object({ messageId: z.string(), refs: z.array(QuoteRefSchema) });

/** mori.model_switch 条目里界面用到的字段（会话文件里读出来的，先校验；unconfirmed 在较早的条目里可能没有） */
const SwitchDataSchema = z.object({
  from: z.string(), to: z.string(), reason: z.enum([...EXCLUSION_REASONS, 'queue_timeout']), detail: z.string(),
  unconfirmed: z.boolean().optional(), replyStartedAt: z.number(), hideUntil: z.number(),
});

/** mori.rebuild 条目里界面用到的字段 */
const RebuildDataSchema = z.object({ model: z.string(), summary: z.boolean() });

type Message = Record<string, unknown>;

/**
 * 你按停止后 pi 留在会话记录里的原文（命令工具的"Command aborted"、agent 循环的"Operation aborted"、
 * 请求被中止时的"This operation was aborted"）。实时运行时靠你按了停止来判断；从记录载入时只能看原文。
 * 这条文字匹配是临时默认值，见 docs/v0/defaults.md。
 */
const ABORTED_TOOL = /(^|\n)(Command aborted|Operation aborted)\s*$/;
const ABORTED_REPLY = /^(This operation was aborted|Request was aborted|Operation aborted)/;

/** @brief 加入一条助手回复及其工具调用；出错或被停止的回复后面跟一行说明（不带操作，它已经过去了）。 */
function addAssistant(state: Transcript, message: Message, entryId: string): Transcript {
  const { blocks, tools } = blocksFromContent(message.content);
  let next = pushItem(state, { kind: 'assistant', blocks, streaming: false, entryId, time: messageTime(message) });
  const all = { ...next.tools };
  for (const tool of tools) all[tool.id] = { ...tool, status: 'interrupted', teamMode: state.runTeamMode };
  next = { ...next, tools: all };
  const error = String(message.errorMessage ?? '');
  const stopped = message.stopReason === 'aborted' || (message.stopReason === 'error' && ABORTED_REPLY.test(error));
  if (stopped) return pushItem(next, { kind: 'stopped' });
  if (message.stopReason === 'error') next = pushItem(next, { kind: 'error', text: error, restore: null, live: false });
  return next;
}

/**
 * @brief 把工具结果合并到对应的工具调用。Mori 拒绝的固定写法（parseRejection）显示"已拒绝"，
 *        先于"已停止"的原文判断：你按停止时挂着的卡回给模型的也是拒绝。
 */
function addToolResult(state: Transcript, message: Message): Transcript {
  const id = String(message.toolCallId);
  const tool = state.tools[id];
  if (!tool) return state;
  const output = contentText(message.content);
  const rejected = message.isError ? parseRejection(output) : null;
  const failed = ABORTED_TOOL.test(output) ? 'stopped' as const : 'failed' as const;
  const status = rejected ? 'rejected' as const : message.isError ? failed : 'done' as const;
  const done = { ...tool, status, output, patch: resultPatch(message), reason: rejected?.reason ?? null };
  return { ...state, tools: { ...state.tools, [id]: done } };
}

/** @brief mori.ref 条目：把引用记到它指向的你的消息上；内容不对时记录错误、不显示引用。 */
function addRefs(state: Transcript, data: unknown): Transcript {
  const parsed = RefDataSchema.safeParse(data);
  if (!parsed.success) {
    console.error(`[renderer] ignored a malformed ${REF_ENTRY_TYPE} entry: ${parsed.error.message}`);
    return state;
  }
  const { messageId, refs } = parsed.data;
  return { ...state, items: state.items.map((item) => (item.kind === 'user' && item.entryId === messageId
    ? { ...item, refs } : item)) };
}

/**
 * @brief 换模型与重建的条目：显示成同实时运行时一样的一行；hideUntil 大于 replyStartedAt 即有被隐藏的过程（§6.1）。
 *        内容不对时记录错误、不显示。
 */
function addModelEntry(state: Transcript, customType: string, data: unknown): Transcript {
  if (customType === MODEL_ENTRY_TYPES.rebuild) {
    const parsed = RebuildDataSchema.safeParse(data);
    if (parsed.success) return pushItem(state, { kind: 'rebuild', ...parsed.data });
    console.error(`[renderer] ignored a malformed ${customType} entry: ${parsed.error.message}`);
    return state;
  }
  const parsed = SwitchDataSchema.safeParse(data);
  if (!parsed.success) {
    console.error(`[renderer] ignored a malformed ${customType} entry: ${parsed.error.message}`);
    return state;
  }
  const { from, to, reason, detail, unconfirmed, replyStartedAt, hideUntil } = parsed.data;
  return pushItem(state, { kind: 'model-switch', from, to, reason, detail, unconfirmed: unconfirmed ?? false,
    hidden: hideUntil > replyStartedAt });
}

/**
 * @brief 合并会话里回执记到哪次调用上：回执条目之后的第一条消息是这种立项工具的结果时，是它所属的调用
 *        （工具按顺序执行，回执在执行时写，§13.2）；否则为 null（回执是单独的一行）。
 * @param index 回执条目的下标
 */
function receiptTool(entries: SessionEntry[], index: number, kind: ReceiptKind): string | null {
  let next: SessionEntry | undefined;
  for (let at = index + 1; at < entries.length && !next; at += 1) {
    if (entries[at]?.type === 'message') next = entries[at];
  }
  const message = next?.type === 'message' ? next.message as unknown as Message : null;
  if (message?.role !== 'toolResult' || message.toolName !== RECEIPT_TOOLS[kind]) return null;
  return String(message.toolCallId);
}

/** @brief 校验一个协作条目的内容；不对时记录错误，返回 null。 */
function teamData<T>(schema: z.ZodType<T>, entry: Extract<SessionEntry, { type: 'custom' }>): T | null {
  const parsed = schema.safeParse(entry.data);
  if (parsed.success) return parsed.data;
  console.error(`[renderer] ignored a malformed ${entry.customType} entry: ${parsed.error.message}`);
  return null;
}

/** @brief mori.wake 条目：把它指向的用户消息变成不显示的 wake 条目（§13.7），“放回输入框”不会带回它。 */
function addWake(state: Transcript, messageId: string, kind: WakeKind): Transcript {
  const index = state.items.findIndex((item) => item.kind === 'user' && item.entryId === messageId);
  const item = state.items[index];
  if (item?.kind !== 'user') return state;
  const items = [...state.items];
  items[index] = { kind: 'wake', key: item.key, wakeKind: kind, entryId: item.entryId, time: item.time };
  return { ...state, items, lastUserText: state.lastUserText === item.text ? null : state.lastUserText };
}

/**
 * @brief 协作写的条目（§13.11）；内容不对时记录错误、不显示。mori.team 不显示（不经这里）。
 * @param index 这条在 entries 里的下标（回执找它之后的工具结果）
 */
function addTeamEntry(state: Transcript, entry: Extract<SessionEntry, { type: 'custom' }>, entries: SessionEntry[],
  index: number): Transcript {
  if (entry.customType === TEAM_ENTRY_TYPES.wake) {
    const wake = teamData(WakeEntrySchema, entry);
    return wake ? addWake(state, wake.messageId, wake.kind) : state;
  }
  if (entry.customType === TEAM_ENTRY_TYPES.progress) {
    const progress = teamData(ProgressEntrySchema, entry);
    return progress ? pushItem(state, { kind: 'progress', request: progress.request }) : state;
  }
  const receipt = teamData(ReceiptEntrySchema, entry);
  if (!receipt) return state;
  const tool = receiptTool(entries, index, receipt.kind);
  if (tool && state.tools[tool]) return attachReceipt(state, tool, receipt);
  return pushItem(state, { kind: 'receipt', receipt });
}

/** @brief 是不是界面要显示的协作条目（mori.receipt、mori.progress、mori.wake）。 */
function isTeamEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: 'custom' }> {
  return entry.type === 'custom' && (entry.customType === TEAM_ENTRY_TYPES.receipt
    || entry.customType === TEAM_ENTRY_TYPES.progress || entry.customType === TEAM_ENTRY_TYPES.wake);
}

/**
 * @brief 一条会话记录。
 * @param index 这条在 entries 里的下标（回执找它所属的调用）
 */
function addEntry(state: Transcript, entry: SessionEntry, entries: SessionEntry[], index: number): Transcript {
  if (entry.type === 'compaction') return pushItem(state, { kind: 'compaction' });
  if (entry.type === 'custom' && entry.customType === REF_ENTRY_TYPE) return addRefs(state, entry.data);
  if (entry.type === 'custom' && (entry.customType === MODEL_ENTRY_TYPES.modelSwitch
    || entry.customType === MODEL_ENTRY_TYPES.rebuild)) {
    return addModelEntry(state, entry.customType, entry.data);
  }
  if (isTeamEntry(entry)) return addTeamEntry(state, entry, entries, index);
  if (entry.type !== 'message') return state;
  const message = entry.message as unknown as Message;
  if (message.role === 'user') {
    const text = contentText(message.content);
    const next = pushItem(state, { kind: 'user', text, refs: null, entryId: entry.id, time: messageTime(message) });
    return { ...next, lastUserText: text, firstUserText: state.firstUserText ?? text };
  }
  if (message.role === 'assistant') return addAssistant(state, message, entry.id);
  if (message.role === 'toolResult') return addToolResult(state, message);
  return state;
}

/** @brief mori.team 条目里的模式；不是这种条目或内容不对时为 null（内容不对时记录错误）。 */
function teamModeOf(entry: SessionEntry): TeamMode | null {
  if (entry.type !== 'custom' || entry.customType !== TEAM_ENTRY_TYPES.team) return null;
  return teamData(TeamEntrySchema, entry)?.mode ?? null;
}

/**
 * @brief 由会话记录重建对话流。没有结果的工具调用保持"已中断"。
 *        每次运行从一条用户消息开始，按那时最后一条 mori.team 的模式记下运行的模式（工具卡的 Message / Ask，§13.8）。
 */
export function transcriptFromEntries(entries: SessionEntry[]): Transcript {
  let latest: TeamMode = 'off';
  return entries.reduce((state, entry, index) => {
    latest = teamModeOf(entry) ?? latest;
    const user = entry.type === 'message' && (entry.message as unknown as Message).role === 'user';
    return addEntry(user ? { ...state, runTeamMode: latest } : state, entry, entries, index);
  }, emptyTranscript);
}

/**
 * @brief 会话信息里协作的部分接到对话流上（§11.6、§13.10）：挂起的后台批准卡（按到达顺序）、待判断的消息与正在判断的
 *        那条开始的时刻（与 mori.team_deciding 相同）。
 */
export function withTeamInfo(state: Transcript, info: SessionInfo): Transcript {
  const deciding = info.deciding.queue.length > 0 ? { ...info.deciding, queue: [...info.deciding.queue] } : null;
  return { ...state, teamApprovals: [...info.teamApprovals], deciding };
}

/** @brief 最后一条助手回复里还没有结果的调用：正在执行的标"执行中"（从开始执行的时刻计时），其余"等待执行"。 */
function resumeTools(state: Transcript, running: LiveSnapshot['runningTools']): Transcript {
  const last = state.items.findLast((item) => item.kind === 'assistant');
  if (last?.kind !== 'assistant') return state;
  const tools = { ...state.tools };
  for (const block of last.blocks) {
    const tool = block.type === 'tool' ? tools[block.id] : undefined;
    if (tool?.status !== 'interrupted') continue;
    const started = running.find((item) => item.toolCallId === tool.id)?.startedAt ?? null;
    tools[tool.id] = { ...tool, status: started === null ? 'queued' : 'running', startedAt: started };
  }
  return { ...state, tools };
}

/** @brief 正在生成、还没写进会话文件的助手回复：作为流入中的回复接在后面，之后的增量照常写进它。 */
function resumeStreaming(state: Transcript, message: unknown): Transcript {
  const { blocks, tools } = blocksFromContent((message as { content?: unknown } | null)?.content);
  const next = pushItem(state, { kind: 'assistant', blocks, streaming: true, entryId: null,
    time: messageTime(message) });
  const all: Record<string, ToolCall> = { ...next.tools };
  for (const tool of tools) all[tool.id] = { ...tool, status: 'preparing', teamMode: state.runTeamMode };
  return { ...next, tools: all };
}

/** @brief 接上时没有工具在执行、也不在等批准：按正在生成的回复里已有的内容定阶段（还没有内容时是等待模型）。 */
function streamStage(streaming: unknown): 'generating' | 'thinking' | 'waiting' {
  const parts = (streaming as { content?: Array<{ type?: string }> } | null)?.content ?? [];
  if (parts.some((part) => part.type === 'text' || part.type === 'toolCall')) return 'generating';
  return parts.some((part) => part.type === 'thinking') ? 'thinking' : 'waiting';
}

/** @brief 在生成时的部分：运行状态、正在执行的工具、正在生成的回复、阶段行。 */
function resumeRun(state: Transcript, live: LiveSnapshot, now: number): Transcript {
  let next: Transcript = resumeTools({ ...state, running: true }, live.runningTools);
  if (live.streaming) next = resumeStreaming(next, live.streaming);
  const tools = { ...next.tools };
  for (const request of live.approvals) {
    const tool = tools[request.toolCallId];
    if (tool) tools[request.toolCallId] = { ...tool, status: 'awaiting', startedAt: null };
  }
  const running = Object.values(tools).find((tool) => tool.status === 'running');
  const stage = live.approvals.length > 0 ? { kind: 'approval' as const, since: now, detail: '' }
    : running ? { kind: 'tool' as const, since: running.startedAt ?? now, detail: running.id }
      : { kind: streamStage(live.streaming), since: now, detail: '' };
  return { ...next, tools, stage };
}

/**
 * @brief 接上后台进程里还开着的会话（界面重新加载后）：会话记录重建的对话流，加上这一刻的样子——在生成时的回复、
 *        工具和阶段，以及（不论是否在生成）挂起的批准请求和扩展询问、排队区。之后的事件照常归并。
 *        准备中（§11.4，pi 还没开始运行）按“发送中”接上：停止走准备中的撤回，准备中结束的事件会清掉它，
 *        pi 开始运行时 agent_start 照常进入生成中。
 */
export function attachLive(state: Transcript, live: LiveSnapshot, now: number): Transcript {
  const next = live.preparing ? { ...state, sending: true } : live.running ? resumeRun(state, live, now) : state;
  return { ...next, approvals: [...live.approvals], questions: [...live.questions], steering: [...live.steering],
    followUp: [...live.followUp] };
}
