// 协作的事件归并进对话流（docs/specs/parallel-agents-taskboard.md §5.3、§5.6、§11.3、§13.2、§13.3、§13.6、§13.7、
// §13.11；状态表 docs/v1/screens/team-stream.md、team-stop.md、team-approvals.md、team-switch.md）：模式改变的提示、
// 回执、进展摘要的位置、不显示的程序投递、待判断的消息、后台实例的批准卡。纯函数，由 transcript.ts 调用；
// 协作状态与 TaskBoard 视图记在会话上（actions.ts）。

import type { ForwardedEvent } from '../../../shared/protocol';
import type { DecidingMessage, ReceiptEntryData, ReceiptKind, TeamMode } from '../../../shared/team';
import {
  addPendingPrompt, pendingPrompt, pushItem, setPendingQueued, type DecidingState, type Item, type Transcript,
} from './model';

type EventOf<T extends ForwardedEvent['type']> = Extract<ForwardedEvent, { type: T }>;

/** @brief 协作的事件（protocol.ts 的 TeamEvent）。 */
export type TeamTranscriptEvent = EventOf<'mori.team_state' | 'mori.team_mode' | 'mori.board' | 'mori.receipt'
  | 'mori.progress' | 'mori.wake' | 'mori.team_deciding' | 'mori.team_approval_request' | 'mori.team_approval_end'>;

/**
 * @brief 模式改变的一行提示（mori.team_mode 事件与重新打开时的 mori.team 条目，§13.11）：接在对话流末尾；末尾是准备中
 *        先显示的你的消息时放在它之前（后台进程在把这条消息交给 pi 之前写条目，重新打开时提示就在这条消息之前）。
 * @param mode 新的模式
 */
export function addModeNotice(state: Transcript, mode: TeamMode): Transcript {
  const next = pushItem(state, { kind: 'team-mode', mode });
  const last = state.items.at(-1);
  if (last?.kind !== 'user' || !last.pending) return next;
  const notice = next.items[next.items.length - 1] as Item;
  return { ...next, items: [...state.items.slice(0, -1), notice, last] };
}

/** @brief 写这种回执的立项工具（合并会话里回执画在这次调用的工具卡下面，team-stream.md "回执"）。 */
export const RECEIPT_TOOLS: Readonly<Record<ReceiptKind, string>> = Object.freeze({
  registered: 'request_submit', added: 'request_update', cancelled: 'request_cancel',
});

/** @brief 把回执记到一次工具调用上（合并会话）；没有这次调用时原样返回。 */
export function attachReceipt(state: Transcript, toolCallId: string, receipt: ReceiptEntryData): Transcript {
  const tool = state.tools[toolCallId];
  if (!tool) return state;
  const receipts = [...tool.receipts ?? [], receipt];
  return { ...state, tools: { ...state.tools, [toolCallId]: { ...tool, receipts } } };
}

/**
 * @brief 实时：最后一条助手回复里正在执行的、写这种回执的立项工具调用（合并会话里回执在工具执行时写）；
 *        分开时对话会话没有立项的工具，所以没有。
 */
function runningReceiptTool(state: Transcript, kind: ReceiptKind): string | null {
  const last = state.items.findLast((item) => item.kind === 'assistant');
  if (last?.kind !== 'assistant') return null;
  const ids = last.blocks.flatMap((block) => (block.type === 'tool' ? [block.id] : []));
  return ids.findLast((id) => state.tools[id]?.status === 'running' && state.tools[id]?.name === RECEIPT_TOOLS[kind])
    ?? null;
}

/**
 * @brief mori.receipt：合并会话里画在正在执行的那次立项调用下面；其余（分开时紧跟你的消息、程序唤醒的回合、撤回时）
 *        后台进程已经在对的时刻写，所以接在对话流末尾（§13.2）。
 */
function applyReceipt(state: Transcript, event: EventOf<'mori.receipt'>): Transcript {
  const { type: _type, ...receipt } = event;
  const tool = runningReceiptTool(state, receipt.kind);
  return tool ? attachReceipt(state, tool, receipt) : pushItem(state, { kind: 'receipt', receipt });
}

/**
 * @brief mori.wake：记下这条程序投递，等同样文字的 message_start（§13.7）。投递在对话空闲时才开始（§5.6），
 *        这时进入“发送中”，准备中照常可以停止（team-stream.md "投递时的阶段行与侧栏"）。
 */
function applyWake(state: Transcript, event: EventOf<'mori.wake'>): Transcript {
  const wakes = [...state.wakes, { text: event.text, kind: event.kind }];
  return { ...state, wakes, sending: state.running ? state.sending : true };
}

/**
 * @brief role 为 user 的 message_start 是不是程序投递：文字与收到过的 mori.wake 相同时变成不显示的 wake 条目，
 *        结束上一轮回复；“把上一条消息放回输入框”不会带回它（lastUserText 清空）。
 * @param time 这条消息的时间（mori.entry_id 按它把条目 id 记到 wake 条目上）
 * @return 不是程序投递时为 null
 */
export function takeWake(state: Transcript, text: string, time: number | null): Transcript | null {
  const index = state.wakes.findIndex((wake) => wake.text === text);
  const wake = state.wakes[index];
  if (!wake) return null;
  const wakes = state.wakes.filter((_wake, at) => at !== index);
  const next = pushItem({ ...state, wakes }, { kind: 'wake', wakeKind: wake.kind, entryId: null, time });
  return { ...next, lastUserText: null };
}

/**
 * @brief 程序投递在准备中被停止、段开始时选不到模型（mori.prompt_error、mori.model_unavailable 的 text 为 null，只在这时
 *        为 null，§5.6）：它不会再有 message_start，去掉记下的投递里最早的那条（投递一次一条，正在准备的就是它）。
 */
export function dropFailedWake(state: Transcript, text: string | null): Transcript {
  return text === null && state.wakes.length > 0 ? { ...state, wakes: state.wakes.slice(1) } : state;
}

/** @brief 待判断队列里少了的消息（按发送顺序，同样的文字按个数算）。 */
function removedTexts(before: DecidingMessage[], after: DecidingMessage[]): string[] {
  const left = after.map((message) => message.text);
  return before.flatMap((message) => {
    const at = left.indexOf(message.text);
    if (at < 0) return [message.text];
    left.splice(at, 1);
    return [];
  });
}

/**
 * @brief 立项判断完、交给对话的一条消息（§5.3 第 4 步）：先显示的那条照常等 pi 收到；对话空闲时它开始一次回复，
 *        先显示在对话流里（准备中）；对话在为另一条准备中时排在它之后（暂存）；对话正在回复时由 pi 的排队区显示。
 */
function handOff(state: Transcript, text: string): Transcript {
  if (pendingPrompt(state)?.text === text) return state;
  if (!state.running && !state.sending) return addPendingPrompt(state, text, []);
  return state.running ? state : setPendingQueued(state, text, true);
}

/**
 * @brief mori.team_deciding：阶段行与排队区（§13.6）。队列里少了的消息是判断完交给了对话；你正在撤回、停止时
 *        （decidingHold）少了的是回到了输入框，不再显示。
 */
function applyDeciding(state: Transcript, event: EventOf<'mori.team_deciding'>): Transcript {
  const deciding: DecidingState | null = event.queue.length > 0
    ? { role: event.role, since: event.since, queue: [...event.queue] } : null;
  const removed = state.decidingHold ? [] : removedTexts(state.deciding?.queue ?? [], event.queue);
  return removed.reduce(handOff, { ...state, deciding });
}

/** @brief 后台实例的批准请求开始与结束（§11.3）：对话一轮结束不清掉它们，只由结束事件去掉。 */
function applyTeamApproval(state: Transcript,
  event: EventOf<'mori.team_approval_request' | 'mori.team_approval_end'>): Transcript {
  if (event.type === 'mori.team_approval_end') {
    return { ...state, teamApprovals: state.teamApprovals.filter((item) => item.requestId !== event.requestId) };
  }
  if (state.teamApprovals.some((item) => item.requestId === event.requestId)) return state;
  const { type: _type, ...request } = event;
  return { ...state, teamApprovals: [...state.teamApprovals, request] };
}

/** @brief 把一个协作的事件归并进对话流；协作状态与 TaskBoard 视图不在对话流里（actions.ts 记到会话上）。 */
export function applyTeamEvent(state: Transcript, event: TeamTranscriptEvent): Transcript {
  switch (event.type) {
    case 'mori.team_mode': return addModeNotice(state, event.mode);
    case 'mori.receipt': return applyReceipt(state, event);
    case 'mori.progress': return pushItem(state, { kind: 'progress', request: event.request });
    case 'mori.wake': return applyWake(state, event);
    case 'mori.team_deciding': return applyDeciding(state, event);
    case 'mori.team_approval_request':
    case 'mori.team_approval_end': return applyTeamApproval(state, event);
    case 'mori.team_state':
    case 'mori.board': return state;
  }
}
