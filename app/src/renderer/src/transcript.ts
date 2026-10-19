// 把后台进程转发的事件归并成对话流。M0 的临时界面只用到其中一部分。

import type { ForwardedEvent } from '../../shared/protocol';

/** @brief 助手回复中的一段正文或思考。 */
export interface Block {
  /** 正文或思考 */
  type: 'text' | 'thinking';
  /** 已收到的文字 */
  text: string;
}

/** @brief 工具卡。 */
export interface ToolItem {
  kind: 'tool';
  /** pi 的 toolCallId */
  id: string;
  /** 工具名 */
  name: string;
  /** 调用参数 */
  args: unknown;
  /** 执行状态 */
  status: 'running' | 'done' | 'error';
  /** 输出文字 */
  output: string;
  /** 编辑工具返回的 unified diff */
  patch: string | null;
}

/** @brief 对话流中的一项。 */
export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: Block[] }
  | ToolItem
  | { kind: 'error'; id: string; text: string };

/** @brief 一个会话的对话流与运行状态。 */
export interface Transcript {
  /** 对话项 */
  items: Item[];
  /** 是否正在运行 */
  running: boolean;
  /** 阶段文字 */
  status: string;
}

export const emptyTranscript: Transcript = { items: [], running: false, status: '' };

let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

/** @brief 把工具结果的文字内容拼起来。 */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

/** @brief 取编辑工具结果里的 unified diff。 */
function resultPatch(result: unknown): string | null {
  const patch = (result as { details?: { patch?: unknown } })?.details?.patch;
  return typeof patch === 'string' && patch.length > 0 ? patch : null;
}

/** @brief 向最后一条助手回复的某一段追加增量。 */
function appendDelta(state: Transcript, type: Block['type'], index: number, delta: string): Transcript {
  const items = [...state.items];
  const last = items[items.length - 1];
  if (last?.kind !== 'assistant') return state;
  const blocks = [...last.blocks];
  const block = blocks[index] ?? { type, text: '' };
  blocks[index] = { ...block, text: block.text + delta };
  items[items.length - 1] = { ...last, blocks };
  return { ...state, items };
}

/** @brief 更新某个工具卡。 */
function updateTool(state: Transcript, id: string, patch: Partial<ToolItem>): Transcript {
  const items = state.items.map((item) => (item.kind === 'tool' && item.id === id ? { ...item, ...patch } : item));
  return { ...state, items };
}

/** @brief 追加一条错误；stop 为 true 时同时结束运行状态。 */
export function pushError(state: Transcript, text: string, stop = false): Transcript {
  const next = { ...state, items: [...state.items, { kind: 'error' as const, id: nextId('e'), text }] };
  return stop ? { ...next, running: false, status: '' } : next;
}

/** @brief 追加你发出的消息。 */
export function pushUser(state: Transcript, text: string): Transcript {
  const items = [...state.items, { kind: 'user' as const, id: nextId('u'), text }];
  return { ...state, running: true, status: '等待模型响应', items };
}

/** @brief 处理模型流式输出的事件。 */
function applyMessageEvent(state: Transcript, event: ForwardedEvent): Transcript {
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    const items = [...state.items, { kind: 'assistant' as const, id: nextId('a'), blocks: [] }];
    return { ...state, status: '生成中', items };
  }
  if (event.type === 'message_update') {
    const { type, contentIndex = 0, delta = '', toolName = '' } = event.update;
    if (type === 'text_delta') return appendDelta(state, 'text', contentIndex, delta);
    if (type === 'thinking_delta') return appendDelta(state, 'thinking', contentIndex, delta);
    if (type === 'toolcall_start') return { ...state, status: `准备调用 ${toolName}` };
    return state;
  }
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const { stopReason, errorMessage } = event.message;
    if (stopReason === 'error') return pushError(state, errorMessage ?? 'Model returned an error');
    if (stopReason === 'aborted') return pushError(state, '已停止 · 已经做出的修改不会自动撤销');
  }
  return state;
}

/** @brief 把一个事件归并进对话流。 */
export function applyEvent(state: Transcript, event: ForwardedEvent): Transcript {
  switch (event.type) {
    case 'turn_start':
      return { ...state, running: true, status: '等待模型响应' };
    case 'tool_execution_start': {
      const tool: ToolItem = { kind: 'tool', id: event.toolCallId, name: event.toolName, args: event.args,
        status: 'running', output: '', patch: null };
      return { ...state, status: `运行 ${event.toolName}`, items: [...state.items, tool] };
    }
    case 'tool_execution_end':
      return updateTool(state, event.toolCallId, { status: event.isError ? 'error' : 'done',
        output: resultText(event.result), patch: resultPatch(event.result) });
    case 'auto_retry_start':
      return { ...state, status: `重试 ${event.attempt}/${event.maxAttempts} · ${event.errorMessage}` };
    case 'agent_settled':
      return { ...state, running: false, status: '' };
    case 'mori.prompt_error':
      return pushError(state, event.message, true);
    default:
      return applyMessageEvent(state, event);
  }
}
