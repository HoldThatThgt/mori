// 把 pi 记录的当前分支（SessionManager.getBranch 的条目）转成对话流：你的消息、助手回复、工具结果、压缩处。
// 系统消息、用量、模型切换等记录不显示。

import type { SessionEntry } from '../../../shared/protocol';
import { blocksFromContent, contentText, emptyTranscript, pushItem, resultPatch, type Transcript } from './model';

type Message = Record<string, unknown>;

/** @brief 加入一条助手回复及其工具调用；出错或被停止的回复后面跟一行说明（不带操作，它已经过去了）。 */
function addAssistant(state: Transcript, message: Message): Transcript {
  const { blocks, tools } = blocksFromContent(message.content);
  let next = pushItem(state, { kind: 'assistant', blocks, streaming: false });
  const all = { ...next.tools };
  for (const tool of tools) all[tool.id] = { ...tool, status: 'interrupted' };
  next = { ...next, tools: all };
  if (message.stopReason === 'error') {
    next = pushItem(next, { kind: 'error', text: String(message.errorMessage ?? ''), restore: null, live: false });
  }
  if (message.stopReason === 'aborted') next = pushItem(next, { kind: 'stopped' });
  return next;
}

/** @brief 把工具结果合并到对应的工具调用。 */
function addToolResult(state: Transcript, message: Message): Transcript {
  const id = String(message.toolCallId);
  const tool = state.tools[id];
  if (!tool) return state;
  const done = { ...tool, status: message.isError ? 'failed' as const : 'done' as const,
    output: contentText(message.content), patch: resultPatch(message) };
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
