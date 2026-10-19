// 把后台进程转发的 pi 事件归并成对话流。纯函数：时间由调用方传入，界面测试用录制的事件回放同一条路径。
// 每个状态的来源见 docs/v0/screens/chat.md 与 tool-cards.md。

import type { ForwardedEvent, SlimMessageUpdate } from '../../../shared/protocol';
import {
  blocksFromContent, contentText, newTool, pushItem, resultPatch,
  type Block, type Item, type Stage, type ToolCall, type Transcript,
} from './model';

type Assistant = Extract<Item, { kind: 'assistant' }>;
type EventOf<T extends ForwardedEvent['type']> = Extract<ForwardedEvent, { type: T }>;

/** @brief 设置阶段；同种阶段保留原来的开始时间。 */
function setStage(state: Transcript, kind: Stage['kind'], now: number, detail = ''): Transcript {
  if (state.stage?.kind === kind && state.stage.detail === detail) return state;
  return { ...state, stage: { kind, since: now, detail } };
}

/** @brief 更新最后一条助手回复；没有时原样返回。 */
function updateLastAssistant(state: Transcript, fn: (item: Assistant) => Assistant): Transcript {
  const index = state.items.findLastIndex((item) => item.kind === 'assistant');
  if (index < 0) return state;
  const items = [...state.items];
  items[index] = fn(items[index] as Assistant);
  return { ...state, items };
}

/** @brief 更新一次工具调用；还没有时先创建。 */
function updateTool(state: Transcript, id: string, name: string, fn: (tool: ToolCall) => ToolCall): Transcript {
  const tool = state.tools[id] ?? newTool(id, name);
  return { ...state, tools: { ...state.tools, [id]: fn(tool) } };
}

/** @brief 正文或工具调用开始后，之前的思考自动收起。 */
function collapseThinking(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.type === 'thinking' && block.streaming ? { ...block, streaming: false } : block));
}

/** @brief 把增量写进助手回复的第 index 段。 */
function writeBlock(item: Assistant, index: number, block: Block): Assistant {
  const blocks = block.type === 'thinking' ? [...item.blocks] : collapseThinking(item.blocks);
  while (blocks.length < index) blocks.push({ type: 'text', text: '' });
  blocks[index] = block;
  return { ...item, blocks };
}

/** @brief 处理思考、正文的增量。 */
function applyTextUpdate(state: Transcript, update: SlimMessageUpdate['update'], now: number): Transcript {
  const index = update.contentIndex ?? 0;
  const thinking = update.type.startsWith('thinking');
  const next = updateLastAssistant(state, (item) => {
    const current = item.blocks[index];
    const text = (current && current.type !== 'tool' ? current.text : '') + (update.delta ?? '');
    const block: Block = thinking ? { type: 'thinking', text, streaming: update.type !== 'thinking_end' }
      : { type: 'text', text };
    return writeBlock(item, index, block);
  });
  return setStage(next, thinking ? 'thinking' : 'generating', now);
}

/** @brief 处理工具调用参数的增量：卡片进入"准备中"。 */
function applyToolCallUpdate(state: Transcript, update: SlimMessageUpdate['update'], now: number): Transcript {
  const id = update.toolCallId;
  if (!id) return state;
  const index = update.contentIndex ?? 0;
  let next = updateLastAssistant(state, (item) => writeBlock(item, index, { type: 'tool', id }));
  next = updateTool(next, id, update.toolName ?? '', (tool) => ({
    ...tool,
    name: update.toolName ?? tool.name,
    argsText: update.type === 'toolcall_delta' ? tool.argsText + (update.delta ?? '') : tool.argsText,
    args: update.args ?? tool.args,
  }));
  return setStage(next, 'generating', now);
}

/** @brief 处理 message_update。 */
function applyUpdate(state: Transcript, event: SlimMessageUpdate, now: number): Transcript {
  const { update } = event;
  if (update.type.startsWith('toolcall_')) return applyToolCallUpdate(state, update, now);
  if (update.type.startsWith('text_') || update.type.startsWith('thinking_')) {
    return applyTextUpdate(state, update, now);
  }
  return state;
}

/** @brief 助手回复结束：以 pi 给出的完整内容为准，思考收起，记下错误等 agent_end 决定是否显示。 */
function applyAssistantEnd(state: Transcript, message: Record<string, unknown>): Transcript {
  const { blocks, tools } = blocksFromContent(message.content);
  let next = updateLastAssistant(state, (item) => ({ ...item, blocks, streaming: false }));
  for (const tool of tools) {
    next = updateTool(next, tool.id, tool.name, (current) => ({ ...current, args: tool.args,
      argsText: tool.argsText }));
  }
  if (message.stopReason === 'error') {
    next = { ...next, pendingError: String(message.errorMessage ?? 'The model returned an error') };
  }
  return { ...next, stage: null };
}

/** @brief 处理消息开始与结束。用户消息（含插话、排队送达的）只在 pi 发出 message_start 时进入对话流。 */
function applyMessage(state: Transcript, event: EventOf<'message_start' | 'message_end'>): Transcript {
  const message = event.message as unknown as Record<string, unknown>;
  if (event.type === 'message_start' && message.role === 'user') {
    const text = contentText(message.content);
    const next = pushItem(state, { kind: 'user', text });
    return { ...next, lastUserText: text, firstUserText: state.firstUserText ?? text };
  }
  if (event.type === 'message_start' && message.role === 'assistant') {
    return pushItem(state, { kind: 'assistant', blocks: [], streaming: true });
  }
  if (event.type === 'message_end' && message.role === 'assistant') return applyAssistantEnd(state, message);
  return state;
}

/** @brief 当前还在执行的工具（阶段行显示它）。 */
function runningToolStage(state: Transcript): Stage | null {
  const running = Object.values(state.tools).find((tool) => tool.status === 'running');
  return running ? { kind: 'tool', since: running.startedAt ?? 0, detail: running.id } : null;
}

/** @brief 处理工具执行事件。 */
function applyToolExecution(state: Transcript, event: EventOf<'tool_execution_start' | 'tool_execution_update'
  | 'tool_execution_end'>, now: number): Transcript {
  if (event.type === 'tool_execution_start') {
    let next = state;
    if (!state.tools[event.toolCallId]) {
      const block = { type: 'tool' as const, id: event.toolCallId };
      next = updateLastAssistant(state, (item) => ({ ...item, blocks: [...item.blocks, block] }));
    }
    next = updateTool(next, event.toolCallId, event.toolName, (tool) => ({
      ...tool, args: (event.args as Record<string, unknown>) ?? tool.args, status: 'running', startedAt: now,
    }));
    return { ...next, stage: { kind: 'tool', since: now, detail: event.toolCallId } };
  }
  if (event.type === 'tool_execution_update') {
    return updateTool(state, event.toolCallId, event.toolName, (tool) => ({ ...tool,
      output: contentText((event.partialResult as { content?: unknown } | undefined)?.content) }));
  }
  const status = event.isError ? (state.stopRequested ? 'stopped' : 'failed') : 'done';
  const next = updateTool(state, event.toolCallId, event.toolName, (tool) => ({
    ...tool, status, output: contentText((event.result as { content?: unknown } | undefined)?.content),
    patch: resultPatch(event.result), durationMs: event.durationMs ?? (tool.startedAt ? now - tool.startedAt : null),
  }));
  return { ...next, stage: runningToolStage(next) };
}

/** @brief 把还没结束的工具调用标成 status（停止或中断时）。 */
export function finishOpenTools(state: Transcript, status: 'stopped' | 'interrupted'): Transcript {
  const tools = { ...state.tools };
  for (const tool of Object.values(tools)) {
    if (['preparing', 'awaiting', 'running'].includes(tool.status)) tools[tool.id] = { ...tool, status };
  }
  const items = state.items.map((item) => (item.kind === 'assistant' && item.streaming
    ? { ...item, streaming: false, blocks: collapseThinking(item.blocks) } : item));
  return { ...state, tools, items };
}

/** @brief 本轮结束：清掉运行状态；停止过就留一行"已停止"。 */
function applySettled(state: Transcript, aborted: boolean): Transcript {
  let next = state;
  if (aborted || state.stopRequested) next = pushItem(finishOpenTools(next, 'stopped'), { kind: 'stopped' });
  return { ...next, running: false, sending: false, stage: null, stopRequested: false, retrying: false,
    pendingError: null };
}

/** @brief 追加一张错误卡；restore 是"放回输入框"的内容。 */
function pushError(state: Transcript, text: string, restore: string | null): Transcript {
  return pushItem(state, { kind: 'error', text, restore, live: true });
}

/** @brief 处理一轮的开始、结束、重试和压缩。 */
function applyRun(state: Transcript, event: ForwardedEvent, now: number): Transcript {
  switch (event.type) {
    case 'agent_start':
      return { ...state, running: true, sending: false };
    case 'turn_start':
      return setStage(state, 'waiting', now);
    case 'agent_end': {
      // 你按了停止时，pi 会以"This operation was aborted"之类的错误结束这条回复，那不是错误。
      const show = state.pendingError && !event.willRetry && !state.retrying && !state.stopRequested;
      const next = show ? pushError(state, state.pendingError ?? '', state.lastUserText) : state;
      return { ...next, pendingError: null };
    }
    case 'agent_settled':
      return applySettled(state, event.aborted);
    case 'auto_retry_start':
      return { ...setStage(state, 'retry', now, `${event.attempt}/${event.maxAttempts} · ${event.errorMessage}`),
        retrying: true };
    case 'auto_retry_end': {
      const next = { ...state, retrying: false };
      if (event.success || state.stopRequested) return next;
      return pushError(next, event.finalError ?? 'Retry failed', state.lastUserText);
    }
    case 'compaction_start':
      return setStage(state, 'compacting', now);
    case 'compaction_end': {
      let next: Transcript = { ...state, stage: null };
      if (event.result && !event.aborted) next = pushItem(next, { kind: 'compaction' });
      if (event.errorMessage) next = pushError(next, event.errorMessage, state.lastUserText);
      return next;
    }
    default:
      return state;
  }
}

/** @brief 把一个事件归并进对话流。 */
export function applyEvent(state: Transcript, event: ForwardedEvent, now: number): Transcript {
  switch (event.type) {
    case 'message_start':
    case 'message_end':
      return applyMessage(state, event);
    case 'message_update':
      return applyUpdate(state, event, now);
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return applyToolExecution(state, event, now);
    case 'queue_update':
      return { ...state, steering: [...event.steering], followUp: [...event.followUp] };
    case 'mori.prompt_error':
      return pushError({ ...state, sending: false }, event.message, event.text);
    default:
      return applyRun(state, event, now);
  }
}
