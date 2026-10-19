// 把 pi 记录的当前分支（SessionManager.getBranch 的条目）转成对话流：你的消息、助手回复、工具结果、压缩处。
// 系统消息、用量、模型切换等记录不显示。

import type { SessionEntry } from '../../../shared/protocol';
import { blocksFromContent, contentText, emptyTranscript, pushItem, resultPatch, type Transcript } from './model';

type Message = Record<string, unknown>;

/**
 * 你按停止后 pi 留在会话记录里的原文（命令工具的"Command aborted"、agent 循环的"Operation aborted"、
 * 请求被中止时的"This operation was aborted"）。实时运行时靠你按了停止来判断；从记录载入时只能看原文。
 * 这条文字匹配是临时默认值，见 docs/v0/defaults.md。
 */
const ABORTED_TOOL = /(^|\n)(Command aborted|Operation aborted)\s*$/;
const ABORTED_REPLY = /^(This operation was aborted|Request was aborted|Operation aborted)/;

/** @brief 加入一条助手回复及其工具调用；出错或被停止的回复后面跟一行说明（不带操作，它已经过去了）。 */
function addAssistant(state: Transcript, message: Message): Transcript {
  const { blocks, tools } = blocksFromContent(message.content);
  let next = pushItem(state, { kind: 'assistant', blocks, streaming: false });
  const all = { ...next.tools };
  for (const tool of tools) all[tool.id] = { ...tool, status: 'interrupted' };
  next = { ...next, tools: all };
  const error = String(message.errorMessage ?? '');
  const stopped = message.stopReason === 'aborted' || (message.stopReason === 'error' && ABORTED_REPLY.test(error));
  if (stopped) return pushItem(next, { kind: 'stopped' });
  if (message.stopReason === 'error') next = pushItem(next, { kind: 'error', text: error, restore: null, live: false });
  return next;
}

/** @brief 把工具结果合并到对应的工具调用。 */
function addToolResult(state: Transcript, message: Message): Transcript {
  const id = String(message.toolCallId);
  const tool = state.tools[id];
  if (!tool) return state;
  const output = contentText(message.content);
  const failed = ABORTED_TOOL.test(output) ? 'stopped' as const : 'failed' as const;
  const status = message.isError ? failed : 'done' as const;
  const done = { ...tool, status, output, patch: resultPatch(message) };
  return { ...state, tools: { ...state.tools, [id]: done } };
}

/** @brief 一条会话记录。 */
function addEntry(state: Transcript, entry: SessionEntry): Transcript {
  if (entry.type === 'compaction') return pushItem(state, { kind: 'compaction' });
  if (entry.type !== 'message') return state;
  const message = entry.message as unknown as Message;
  if (message.role === 'user') {
    const text = contentText(message.content);
    const next = pushItem(state, { kind: 'user', text });
    return { ...next, lastUserText: text, firstUserText: state.firstUserText ?? text };
  }
  if (message.role === 'assistant') return addAssistant(state, message);
  if (message.role === 'toolResult') return addToolResult(state, message);
  return state;
}

/** @brief 由会话记录重建对话流。没有结果的工具调用保持"已中断"。 */
export function transcriptFromEntries(entries: SessionEntry[]): Transcript {
  return entries.reduce(addEntry, emptyTranscript);
}
