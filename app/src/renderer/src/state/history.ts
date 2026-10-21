// 把 pi 记录的当前分支（SessionManager.getBranch 的条目）转成对话流：你的消息、助手回复、工具结果、压缩处，
// 以及 Mori 写的引用来源（mori.ref 条目，记到它指向的你的消息上）。系统消息、用量、模型切换等记录不显示。

import { z } from 'zod';
import { QuoteRefSchema, REF_ENTRY_TYPE, type LiveSnapshot, type SessionEntry } from '../../../shared/protocol';
import {
  blocksFromContent, contentText, emptyTranscript, messageTime, parseRejection, pushItem, resultPatch, type ToolCall,
  type Transcript,
} from './model';

/** mori.ref 条目的内容（会话文件里读出来的，先校验） */
const RefDataSchema = z.object({ messageId: z.string(), refs: z.array(QuoteRefSchema) });

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
  for (const tool of tools) all[tool.id] = { ...tool, status: 'interrupted' };
  next = { ...next, tools: all };
  const error = String(message.errorMessage ?? '');
  const stopped = message.stopReason === 'aborted' || (message.stopReason === 'error' && ABORTED_REPLY.test(error));
  if (stopped) return pushItem(next, { kind: 'stopped' });
  if (message.stopReason === 'error') next = pushItem(next, { kind: 'error', text: error, restore: null, live: false });
  return next;
}

/**
 * @brief 把工具结果合并到对应的工具调用。Mori 拒绝的固定写法（parseRejection）显示"Denied"，
 *        先于"Stopped"的原文判断：你按停止时挂着的卡回给模型的也是拒绝。
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

/** @brief 一条会话记录。 */
function addEntry(state: Transcript, entry: SessionEntry): Transcript {
  if (entry.type === 'compaction') return pushItem(state, { kind: 'compaction' });
  if (entry.type === 'custom' && entry.customType === REF_ENTRY_TYPE) return addRefs(state, entry.data);
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

/** @brief 由会话记录重建对话流。没有结果的工具调用保持"Interrupted"。 */
export function transcriptFromEntries(entries: SessionEntry[]): Transcript {
  return entries.reduce(addEntry, emptyTranscript);
}

/** @brief 最后一条助手回复里还没有结果的调用：正在执行的标"Running…"（从开始执行的时刻计时），其余"Queued"。 */
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
  for (const tool of tools) all[tool.id] = { ...tool, status: 'preparing' };
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
 */
export function attachLive(state: Transcript, live: LiveSnapshot, now: number): Transcript {
  const next = live.running ? resumeRun(state, live, now) : state;
  return { ...next, approvals: [...live.approvals], questions: [...live.questions], steering: [...live.steering],
    followUp: [...live.followUp] };
}
