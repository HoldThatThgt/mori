// 把后台进程转发的 pi 事件归并成对话流。纯函数：时间由调用方传入，界面测试用录制的事件回放同一条路径。
// 每个状态的来源见 docs/v0/screens/chat.md、tool-cards.md 与 approval.md；模型层的提示、阶段行、准备中与说明卡见
// docs/v1/screens/model-chat.md。

import type { ApprovalEndBy, ForwardedEvent, QuoteRef, SlimMessageUpdate, ToolGate } from '../../../shared/protocol';
import { BLOCKED_PROMPT_MESSAGE, STOPPED_BEFORE_SENDING, formatClock } from '../../../shared/models';
import {
  blocksFromContent, contentText, messageTime, newTool, parseRejection, pushItem, reasonText, resultPatch,
  type Block, type Item, type ModelStage, type Stage, type ToolCall, type Transcript,
} from './model';
import { skillCommandText } from './skillText';

type Assistant = Extract<Item, { kind: 'assistant' }>;
type User = Extract<Item, { kind: 'user' }>;
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

/** @brief 更新一次已有的工具调用；没有时原样返回（例如扩展里嵌套的调用没有工具卡）。 */
function patchTool(state: Transcript, id: string, fn: (tool: ToolCall) => ToolCall): Transcript {
  const tool = state.tools[id];
  return tool ? { ...state, tools: { ...state.tools, [id]: fn(tool) } } : state;
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

/** @brief 处理工具调用参数的增量：卡片进入"Preparing…"。 */
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

/** @brief 处理 message_update；有内容的事件结束模型层的等待（含原地重试的阶段行，§9.3）。 */
function applyUpdate(state: Transcript, event: SlimMessageUpdate, now: number): Transcript {
  const { update } = event;
  if (update.type.startsWith('toolcall_')) return applyToolCallUpdate({ ...state, modelStage: null }, update, now);
  if (update.type.startsWith('text_') || update.type.startsWith('thinking_')) {
    return applyTextUpdate({ ...state, modelStage: null }, update, now);
  }
  return state;
}

/**
 * @brief 助手回复结束：以 pi 给出的完整内容为准，思考收起，记下错误等 agent_end 决定是否显示。
 *        参数已经完整、pi 还没开始执行的调用从"Preparing…"变成"Queued"（一条回复里的调用按顺序执行）。
 */
function applyAssistantEnd(state: Transcript, message: Record<string, unknown>): Transcript {
  const { blocks, tools } = blocksFromContent(message.content);
  let next = updateLastAssistant(state, (item) => ({ ...item, blocks, streaming: false }));
  for (const tool of tools) {
    next = updateTool(next, tool.id, tool.name, (current) => ({ ...current, args: tool.args,
      argsText: tool.argsText, status: current.status === 'preparing' ? 'queued' : current.status }));
  }
  // 已显示 No model available 卡的那次回复，pi 的错误不再显示成错误卡（一次失败只显示一张卡，§9.3）。
  if (message.stopReason === 'error' && !state.unavailable) {
    next = { ...next, pendingError: String(message.errorMessage ?? 'The model returned an error') };
  }
  return { ...next, stage: null, modelStage: null };
}

/**
 * @brief pi 送进一条用户消息。准备中先显示的那条（pending）由它取代，文字以 pi 的为准（技能命令等已展开）；
 *        其余（插话、排队送达的）只在 pi 发出 message_start 时进入对话流。
 */
function applyUserStart(state: Transcript, message: Record<string, unknown>): Transcript {
  const text = contentText(message.content);
  const index = state.items.findIndex((item) => item.kind === 'user' && item.pending);
  let next: Transcript;
  if (index >= 0) {
    const items = [...state.items];
    const pending = items[index] as User;
    items[index] = { ...pending, text, pending: false, time: messageTime(message) };
    next = { ...state, items };
  } else {
    next = pushItem(state, { kind: 'user', text, refs: null, entryId: null, time: messageTime(message) });
  }
  return { ...next, lastUserText: text, firstUserText: state.firstUserText ?? text };
}

/** @brief 处理消息开始与结束。 */
function applyMessage(state: Transcript, event: EventOf<'message_start' | 'message_end'>): Transcript {
  const message = event.message as unknown as Record<string, unknown>;
  if (event.type === 'message_start' && message.role === 'user') return applyUserStart(state, message);
  if (event.type === 'message_start' && message.role === 'assistant') {
    return pushItem(state, { kind: 'assistant', blocks: [], streaming: true, entryId: null,
      time: messageTime(message) });
  }
  if (event.type === 'message_end' && message.role === 'assistant') return applyAssistantEnd(state, message);
  return state;
}

/**
 * @brief 补发的条目 id（mori.entry_id）：记到同一角色、同一时间的那一项上（找不到时取这个角色最后一条还没有 id 的）；
 *        你的消息带着已写进会话的引用时一并记下。
 */
function applyEntryId(state: Transcript, event: EventOf<'mori.entry_id'>): Transcript {
  const matches = (item: Item) => (item.kind === 'user' || item.kind === 'assistant') && item.kind === event.role
    && item.entryId === null;
  let index = state.items.findLastIndex((item) => matches(item) && 'time' in item && item.time === event.time);
  if (index < 0) index = state.items.findLastIndex(matches);
  const item = state.items[index];
  if (!item || (item.kind !== 'user' && item.kind !== 'assistant')) return state;
  const items = [...state.items];
  items[index] = item.kind === 'user' ? { ...item, entryId: event.entryId, refs: event.refs ?? item.refs }
    : { ...item, entryId: event.entryId };
  return { ...state, items };
}

/** @brief 当前还在执行的工具（阶段行显示它）。 */
function runningToolStage(state: Transcript): Stage | null {
  const running = Object.values(state.tools).find((tool) => tool.status === 'running');
  return running ? { kind: 'tool', since: running.startedAt ?? 0, detail: running.id } : null;
}

/** @brief 一件事结束后的阶段：有挂起的批准时总是"Waiting for your approval"，否则是还在执行的工具，都没有时不显示。 */
function nextStage(state: Transcript, now: number): Stage | null {
  if (state.approvals.length === 0) return runningToolStage(state);
  return state.stage?.kind === 'approval' ? state.stage : { kind: 'approval', since: now, detail: '' };
}

/** @brief 自动放行的原因：Allowed for this session / Allow all；只读工具和要批准的调用没有。 */
function autoAllowed(gate: ToolGate | ApprovalEndBy | null): ToolCall['allowedBy'] {
  return gate === 'session' || gate === 'all' ? gate : null;
}

/** @brief 最后一条助手回复里是否已有这次调用的工具卡。 */
function hasToolBlock(state: Transcript, id: string): boolean {
  const last = state.items.findLast((item) => item.kind === 'assistant');
  return last?.kind === 'assistant' && last.blocks.some((block) => block.type === 'tool' && block.id === id);
}

/**
 * @brief 工具开始执行。mori.tool_gate 为 ask 的调用先"Waiting for your approval"（pi 先发这个事件、再调用批准处理器），
 *        其余的直接"Running…"，Allowed for this session / Allow all 的标出原因。
 */
function applyToolStart(state: Transcript, event: EventOf<'tool_execution_start'>, now: number): Transcript {
  const id = event.toolCallId;
  let next = state;
  if (!hasToolBlock(state, id)) {
    next = updateLastAssistant(state, (item) => ({ ...item, blocks: [...item.blocks, { type: 'tool', id }] }));
  }
  const ask = state.tools[id]?.gate === 'ask';
  next = updateTool(next, id, event.toolName, (tool) => ({
    ...tool, args: (event.args as Record<string, unknown>) ?? tool.args, status: ask ? 'awaiting' : 'running',
    startedAt: ask ? null : now, allowedBy: autoAllowed(tool.gate),
  }));
  if (ask || next.approvals.length > 0) return setStage(next, 'approval', now);
  return { ...next, stage: { kind: 'tool', since: now, detail: id } };
}

/**
 * @brief mori.tool_gate。tool_execution_start 之前收到的只记下来；之后再收到的是后台进程的更正：
 *        预告要批准、实际已不用批准（例如排队的嵌套调用轮到时，你已选了"Allow for this session"），
 *        还在"Waiting for your approval"且没有挂起请求的卡直接变"Running…"，标出放行原因。
 */
function applyToolGate(state: Transcript, event: EventOf<'mori.tool_gate'>, now: number): Transcript {
  const id = event.toolCallId;
  const tool = state.tools[id];
  const pending = state.approvals.some((item) => item.toolCallId === id);
  if (tool?.status !== 'awaiting' || pending || event.gate === 'ask') {
    return updateTool(state, id, event.toolName, (current) => ({ ...current, gate: event.gate }));
  }
  const next = patchTool(state, id, (current) => ({ ...current, gate: event.gate, status: 'running', startedAt: now,
    allowedBy: autoAllowed(event.gate) }));
  if (next.approvals.length > 0) return setStage(next, 'approval', now);
  return { ...next, stage: { kind: 'tool', since: now, detail: id } };
}

/** @brief 处理工具执行事件。已拒绝的调用之后的 tool_execution_end（isError）只记下输出，不改变状态。 */
function applyToolExecution(state: Transcript, event: EventOf<'tool_execution_start' | 'tool_execution_update'
  | 'tool_execution_end'>, now: number): Transcript {
  if (event.type === 'tool_execution_start') return applyToolStart(state, event, now);
  if (event.type === 'tool_execution_update') {
    return updateTool(state, event.toolCallId, event.toolName, (tool) => ({ ...tool,
      output: contentText((event.partialResult as { content?: unknown } | undefined)?.content) }));
  }
  const status = event.isError ? (state.stopRequested ? 'stopped' : 'failed') : 'done';
  const next = updateTool(state, event.toolCallId, event.toolName, (tool) => ({
    ...tool, status: tool.status === 'rejected' ? 'rejected' : status,
    output: contentText((event.result as { content?: unknown } | undefined)?.content),
    patch: resultPatch(event.result), durationMs: event.durationMs ?? (tool.startedAt ? now - tool.startedAt : null),
  }));
  return { ...next, stage: nextStage(next, now) };
}

/**
 * @brief 批准请求开始与结束。允许后从这一刻开始计时；你在卡上允许的不标原因，
 *        "Allow for this session"或切到"Allow all"顺带放行的标出原因。拒绝后等模型收到拒绝再回复。
 */
function applyApproval(state: Transcript, event: EventOf<'mori.approval_request' | 'mori.approval_end'>,
  now: number): Transcript {
  if (event.type === 'mori.approval_request') {
    if (state.approvals.some((item) => item.requestId === event.requestId)) return state;
    const { requestId, toolCallId, toolName, args } = event;
    const next = patchTool({ ...state, approvals: [...state.approvals, { requestId, toolCallId, toolName, args }] },
      toolCallId, (tool) => ({ ...tool, status: 'awaiting', startedAt: null }));
    return setStage(next, 'approval', now);
  }
  const approvals = state.approvals.filter((item) => item.requestId !== event.requestId);
  const next = patchTool({ ...state, approvals }, event.toolCallId, (tool) => (event.decision === 'allow'
    ? { ...tool, status: 'running', startedAt: now, allowedBy: autoAllowed(event.by) }
    : { ...tool, status: 'rejected', reason: parseRejection(event.reason ?? '')?.reason ?? null }));
  return { ...next, stage: nextStage(next, now) };
}

/**
 * @brief 把还没结束的工具调用（Preparing…、Queued、Waiting for your approval、Running…）标成 status（停止或中断时）；
 *        挂起的批准一并清掉。
 */
export function finishOpenTools(state: Transcript, status: 'stopped' | 'interrupted'): Transcript {
  const tools = { ...state.tools };
  for (const tool of Object.values(tools)) {
    if (['preparing', 'queued', 'awaiting', 'running'].includes(tool.status)) tools[tool.id] = { ...tool, status };
  }
  const items = state.items.map((item) => (item.kind === 'assistant' && item.streaming
    ? { ...item, streaming: false, blocks: collapseThinking(item.blocks) } : item));
  return { ...state, tools, items, approvals: [], questions: [] };
}

/**
 * @brief 本轮结束：清掉运行状态和挂起的批准；停止过就留一行"Stopped · …"，没执行的调用标"Stopped"或"Interrupted"。
 */
function applySettled(state: Transcript, aborted: boolean): Transcript {
  let next = state;
  if (aborted || state.stopRequested) next = pushItem(finishOpenTools(next, 'stopped'), { kind: 'stopped' });
  // 本轮正常结束时还没执行的调用（例如回复出错，pi 不执行其中的调用）：与从会话记录载入时一样显示"Interrupted"。
  else next = finishOpenTools(next, 'interrupted');
  return { ...next, running: false, sending: false, stage: null, stopRequested: false, modelStage: null,
    pendingQueue: [], unavailable: false, pendingError: null, approvals: [], questions: [] };
}

/**
 * @brief 扩展的询问开始与结束、扩展的通知（docs/v0/screens/extension-ui.md）；pi 的 prompt() 结束时，没有开始运行的提示
 *        （交给了扩展命令或输入处理器）清掉"刚发出"。
 */
function applyQuestion(state: Transcript,
  event: EventOf<'mori.ui_request' | 'mori.ui_end' | 'mori.notify' | 'mori.prompt_done'>): Transcript {
  if (event.type === 'mori.prompt_done') {
    // 没有开始运行就结束的提示（扩展命令等）：pi 没有记下它，准备中先显示的消息去掉（同 v0 不显示）。
    // 以后台进程报的运行状态为准：界面重新加载时按“生成中”接上的准备中会话，这里也回到空闲。
    return event.running ? state : { ...dropPending(state), running: false, stage: null };
  }
  if (event.type === 'mori.notify') return pushItem(state, { kind: 'notify', text: event.message, level: event.level });
  if (event.type === 'mori.ui_end') {
    return { ...state, questions: state.questions.filter((item) => item.requestId !== event.requestId) };
  }
  if (state.questions.some((item) => item.requestId === event.requestId)) return state;
  const { type: _type, ...request } = event;
  return { ...state, questions: [...state.questions, request] };
}

/**
 * @brief 追加一张错误卡；restore 是"Put your last message back in the message box"放回的内容。
 *        pi 记下的是展开后的文字：技能调用放回"/skill:名字 参数"，与气泡里显示的一致（docs/v0/screens/slash.md）。
 */
function pushError(state: Transcript, text: string, restore: string | null, refs?: QuoteRef[] | null): Transcript {
  const back = restore === null ? null : skillCommandText(restore);
  return pushItem(state, { kind: 'error', text, restore: back, live: true, ...(refs?.length ? { refs } : {}) });
}

// ---- 准备中（docs/specs/model-providers.md §11.4）与模型层的提示、等待（§9.3） ----


/** @brief 准备中先显示的那条你的消息；没有时为 undefined。 */
export function pendingPrompt(state: Transcript): User | undefined {
  return state.items.find((item): item is User => item.kind === 'user' && Boolean(item.pending));
}

/** @brief 你发了消息（空闲时）：消息先显示在对话流里，会话进入"发送中"（准备中，§11.4）。 */
export function addPendingPrompt(state: Transcript, text: string, refs: QuoteRef[]): Transcript {
  const next = pushItem(state, { kind: 'user', text, refs: refs.length > 0 ? refs : null, entryId: null, time: null,
    pending: true });
  return { ...next, sending: true };
}

/** @brief 准备中又发了一条（后台进程暂存）：显示在排队区；发送失败时 add 为假，把它去掉。 */
export function setPendingQueued(state: Transcript, text: string, add: boolean): Transcript {
  if (add) return { ...state, pendingQueue: [...state.pendingQueue, text] };
  const index = state.pendingQueue.lastIndexOf(text);
  return index < 0 ? state : { ...state, pendingQueue: state.pendingQueue.filter((_text, at) => at !== index) };
}

/**
 * @brief 准备中结束、pi 没有开始运行：撤回先显示的消息和暂存的消息，会话不再"发送中"，模型层的等待随之结束；
 *        准备中按的停止已经处理完（不会再有 agent_settled 来清掉它）。
 */
function dropPending(state: Transcript): Transcript {
  const items = state.items.filter((item) => !(item.kind === 'user' && item.pending));
  return { ...state, items, pendingQueue: [], modelStage: null, sending: false, stopRequested: false };
}

/**
 * @brief mori.prompt_error。准备中（有先显示的消息）：消息与暂存的消息撤回（文字由 actions.ts 放回输入框）；
 *        停止和拒绝启动不显示错误卡，pi 没开始就结束时显示原文的错误卡，不带"放回输入框"（文字已在输入框里）。
 *        没有先显示的消息时（先到的 mori.prompt_done 已撤回它：pi 的 prompt() 没有开始运行就结束，§11.4；
 *        或界面重新加载后按“发送中”接上的准备中会话），“Stopped before sending”只结束准备中，
 *        文字同样由 actions.ts 放回输入框，不显示错误卡。
 *        其余（插话、排队的提示失败等）同 v0：错误卡带"把上一条消息放回输入框"；运行状态以后台进程报的为准。
 */
function applyPromptError(state: Transcript, event: EventOf<'mori.prompt_error'>): Transcript {
  if (!pendingPrompt(state)) {
    // 没有先显示的消息时 dropPending 只清暂存区、发送中、模型层的等待与准备中按的停止（同撤回）。
    if (event.message === STOPPED_BEFORE_SENDING) return dropPending(state);
    return pushError({ ...state, sending: false, running: event.running, stage: event.running ? state.stage : null },
      event.message, event.text, event.refs);
  }
  const next = dropPending(state);
  if (event.message === STOPPED_BEFORE_SENDING || event.message === BLOCKED_PROMPT_MESSAGE) return next;
  return pushError(next, event.message, null);
}

/**
 * @brief 换模型、重建的一行与 No model available 卡。说明卡之后同一次失败的 pi 错误不再显示（unavailable）；
 *        段开始时就选不到（firstRequest）时撤回准备中的消息（文字由 actions.ts 放回输入框）。
 */
function applyModelNotice(state: Transcript,
  event: EventOf<'mori.model_switch' | 'mori.model_rebuild' | 'mori.model_unavailable'>): Transcript {
  if (event.type === 'mori.model_switch') {
    const { from, to, reason, detail, hidden } = event;
    return pushItem(state, { kind: 'model-switch', from, to, reason, detail, hidden,
      unconfirmed: event.unconfirmed ?? false });
  }
  if (event.type === 'mori.model_rebuild') {
    return pushItem(state, { kind: 'rebuild', model: event.model, summary: event.summary });
  }
  const card = { kind: 'unavailable' as const, candidates: [...event.candidates] };
  // 段开始时就选不到：消息没发出，pi 不会运行，也就没有要压下的 pi 错误；会话回到空闲（含重新加载后接上的准备中）。
  if (event.firstRequest) return pushItem({ ...dropPending(state), running: false, stage: null }, card);
  const next = pushItem(state, card);
  return { ...next, modelStage: null, pendingError: null, unavailable: true };
}

/** @brief 等模型、等它停下、重建的阶段行文字（§9.3）。 */
function waitText(event: EventOf<'mori.model_wait'>): string {
  const model = event.model ?? '';
  if (event.kind === 'rebuild') return `Rebuilding the conversation for ${model}…`;
  if (event.kind === 'held') {
    return `Waiting to make sure ${model} stopped${event.until === null ? '' : ` · until ${formatClock(event.until)}`}`;
  }
  const reason = event.reason ? reasonText(event.reason, event.detail, event.detail ? undefined : event.until) : '';
  return reason ? `Waiting for a model · ${reason}` : 'Waiting for a model';
}

/** @brief 开始（或更新）一种模型层的等待；同一种等待保留原来的开始时刻。 */
function startModelStage(state: Transcript, kind: ModelStage['kind'], text: string, now: number): Transcript {
  const since = state.modelStage?.kind === kind ? state.modelStage.since : now;
  return { ...state, modelStage: { kind, since, text } };
}

/** @brief 结束一种模型层的等待；阶段行正在显示别的等待时不动。 */
function endModelStage(state: Transcript, kind: ModelStage['kind']): Transcript {
  return state.modelStage?.kind === kind ? { ...state, modelStage: null } : state;
}

/** @brief mori.model_wait、mori.model_queue、mori.model_retry：阶段行（§9.3）。 */
function applyModelWait(state: Transcript,
  event: EventOf<'mori.model_wait' | 'mori.model_queue' | 'mori.model_retry'>, now: number): Transcript {
  if (event.type === 'mori.model_retry') {
    // 每次重试都是一次新的等待，从这一刻计时；下一个有内容的事件、下一次重试或回复结束时清掉。
    const text = `Retrying (${event.attempt}/${event.max}) · HTTP ${event.status}`;
    return { ...state, modelStage: { kind: 'retry', since: now, text } };
  }
  if (event.type === 'mori.model_queue') {
    return event.active ? startModelStage(state, 'queue', `Waiting for ${event.providerName}`, now)
      : endModelStage(state, 'queue');
  }
  const kind = event.kind === 'model' ? 'wait-model' : event.kind;
  return event.active ? startModelStage(state, kind, waitText(event), now) : endModelStage(state, kind);
}

/**
 * @brief pi 开始从上下文溢出恢复（compaction_start，reason 为 overflow）：pi 在 agent_end 之后才压缩并重试，
 *        agent_end 时显示的那张溢出错误卡（对话流最后一项）去掉，由 pi 的恢复处理（规格 §5.4 溢出一行）。
 *        恢复失败时 pi 会再发错误（重试的回复出错，或 compaction_end 带 errorMessage），照常显示。
 */
function withoutOverflowError(state: Transcript): Transcript {
  const last = state.items[state.items.length - 1];
  if (last?.kind !== 'error') return state;
  return { ...state, items: state.items.slice(0, -1) };
}

/** @brief 处理一轮的开始、结束和压缩。 */
function applyRun(state: Transcript, event: ForwardedEvent, now: number): Transcript {
  switch (event.type) {
    case 'agent_start':
      return { ...state, running: true, sending: false };
    case 'turn_start':
      return setStage(state, 'waiting', now);
    case 'agent_end': {
      // 你按了停止时，pi 会以"This operation was aborted"之类的错误结束这条回复，那不是错误。
      // pi 的自动重试对 Mori 的会话关闭（§5.5），重试只有模型池的一层，不再看 auto_retry_*。
      const show = state.pendingError && !state.stopRequested && !state.unavailable;
      const next = show ? pushError(state, state.pendingError ?? '', state.lastUserText) : state;
      return { ...next, pendingError: null };
    }
    case 'agent_settled':
      return applySettled(state, event.aborted);
    case 'compaction_start':
      return setStage(event.reason === 'overflow' ? withoutOverflowError(state) : state, 'compacting', now);
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
      // 准备中暂存的消息此时已作为排队消息交给 pi，改由 pi 的排队区显示。
      return { ...state, steering: [...event.steering], followUp: [...event.followUp], pendingQueue: [] };
    case 'mori.tool_gate':
      return applyToolGate(state, event, now);
    case 'mori.approval_request':
    case 'mori.approval_end':
      return applyApproval(state, event, now);
    case 'mori.prompt_error':
      return applyPromptError(state, event);
    case 'mori.entry_id':
      return applyEntryId(state, event);
    case 'mori.ui_request':
    case 'mori.ui_end':
    case 'mori.notify':
    case 'mori.prompt_done':
      return applyQuestion(state, event);
    case 'mori.model_switch':
    case 'mori.model_rebuild':
    case 'mori.model_unavailable':
      return applyModelNotice(state, event);
    case 'mori.model_wait':
    case 'mori.model_queue':
    case 'mori.model_retry':
      return applyModelWait(state, event, now);
    default:
      return applyRun(state, event, now);
  }
}
