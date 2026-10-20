// 对话流的数据模型：由 pi 事件（transcript.ts）或会话记录（history.ts）归并而来，界面只读它。

import {
  REJECTED_BY_STOP, REJECTED_REASON_PREFIX, REJECTED_TEXT, type QuoteRef, type ToolGate, type UiRequest,
} from '../../../shared/protocol';

/** @brief 工具卡状态，含义见 docs/v0/screens/tool-cards.md。 */
export type ToolStatus =
  | 'preparing' | 'queued' | 'awaiting' | 'running' | 'done' | 'failed' | 'rejected' | 'stopped' | 'interrupted';

/** @brief 一次工具调用。 */
export interface ToolCall {
  /** pi 的 toolCallId */
  id: string;
  /** 工具名 */
  name: string;
  /** 流式收到的参数原文（参数写完前用来猜标题） */
  argsText: string;
  /** 完整的调用参数；还没写完时为 null */
  args: Record<string, unknown> | null;
  /** 状态 */
  status: ToolStatus;
  /** 输出文字（执行中为实时输出） */
  output: string;
  /** 编辑工具返回的 unified diff */
  patch: string | null;
  /** 实时运行时开始执行的时刻（ms）；从会话记录载入时为 null */
  startedAt: number | null;
  /** 实时运行时的耗时（ms）；从会话记录载入时为 null */
  durationMs: number | null;
  /** 已拒绝时工具卡上显示的理由：你写的理由，或"你按了停止"；没写理由时为 null */
  reason: string | null;
  /** 自动放行的原因：本会话已允许 / 全部允许；你在卡上允许的、只读工具和会话记录里的为 null */
  allowedBy: 'session' | 'all' | null;
  /** 后台进程说这次调用会怎样处理（mori.tool_gate）；还没收到或从会话记录载入时为 null */
  gate: ToolGate | null;
}

/** @brief 一个等你选择的批准请求（mori.approval_request）。 */
export interface PendingApproval {
  /** 请求 id，approval.answer 用它答复 */
  requestId: string;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 完整的调用参数 */
  args: Record<string, unknown>;
}

/** @brief 一个等你回答的扩展询问（mori.ui_request，超时从它的 askedAt 算起）。 */
export type PendingQuestion = UiRequest;

/** @brief 助手回复里的一段：正文、思考或一次工具调用；下标与 pi 的 contentIndex 一致。 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; streaming: boolean }
  | { type: 'tool'; id: string };

/** @brief 一条你的消息或助手回复在会话记录里的位置：条目 id（mori.entry_id 补发或会话记录）和消息时间。 */
export interface MessageMark {
  /** 条目 id；还没写进会话时为 null */
  entryId: string | null;
  /** pi 消息的 timestamp（ms）；没有时为 null */
  time: number | null;
}

/** @brief 对话流中的一项。 */
export type Item =
  | ({ kind: 'user'; key: string; text: string; refs: QuoteRef[] | null } & MessageMark)
  | ({ kind: 'assistant'; key: string; blocks: Block[]; streaming: boolean } & MessageMark)
  | { kind: 'compaction'; key: string }
  | { kind: 'stopped'; key: string }
  | {
    kind: 'error'; key: string; text: string; restore: string | null; live: boolean;
    /** 没发出去的消息带的引用芯片："放回输入框"时连芯片一起放回（restore 是含引用块的全文） */
    refs?: QuoteRef[];
  }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'notify'; key: string; text: string; level: 'info' | 'warning' | 'error' };

/** @brief 阶段行。tool 阶段的文字由界面按工具标题生成。 */
export interface Stage {
  /** 阶段种类 */
  kind: 'waiting' | 'thinking' | 'generating' | 'tool' | 'approval' | 'retry' | 'compacting';
  /** 阶段开始的时刻（ms），用于显示秒数 */
  since: number;
  /** tool：正在运行的工具 id；retry：重试说明 */
  detail: string;
}

/** @brief 一个会话的对话流与运行状态。 */
export interface Transcript {
  /** 对话项 */
  items: Item[];
  /** 工具调用，按 id */
  tools: Record<string, ToolCall>;
  /** 本轮运行中（agent_start 到 agent_settled） */
  running: boolean;
  /** 刚发出、还没收到 agent_start 或失败 */
  sending: boolean;
  /** 阶段行；为 null 时不显示 */
  stage: Stage | null;
  /** pi 排队区：插话 */
  steering: string[];
  /** pi 排队区：排队 */
  followUp: string[];
  /** 挂起的批准请求，按到达顺序；批准卡显示第一张 */
  approvals: PendingApproval[];
  /** 挂起的扩展询问，按到达顺序；询问卡显示第一个（docs/v0/screens/extension-ui.md） */
  questions: PendingQuestion[];
  /** 你按了停止，本轮还没结束 */
  stopRequested: boolean;
  /** 正在自动重试 */
  retrying: boolean;
  /** 模型回复出错，等 agent_end 决定是否显示 */
  pendingError: string | null;
  /** 最后一条你的消息（"把上一条消息放回输入框"） */
  lastUserText: string | null;
  /** 第一条你的消息（会话名） */
  firstUserText: string | null;
  /** 生成 key 用的序号 */
  seq: number;
}

export const emptyTranscript: Transcript = {
  items: [], tools: {}, running: false, sending: false, stage: null, steering: [], followUp: [], approvals: [],
  questions: [], stopRequested: false, retrying: false, pendingError: null, lastUserText: null, firstUserText: null,
  seq: 0,
};

/** 对话流每次载入的消息数（一条你的消息或一条助手回复算一条），见方案 5.4 */
export const PAGE_SIZE = 50;

/** @brief 让对话流先显示最近 count 条消息，返回起始下标。 */
export function startIndexFor(transcript: Transcript, count = PAGE_SIZE): number {
  let seen = 0;
  for (let index = transcript.items.length - 1; index >= 0; index -= 1) {
    const kind = transcript.items[index]?.kind;
    if (kind === 'user' || kind === 'assistant') seen += 1;
    if (seen > count) return index + 1;
  }
  return 0;
}

/** @brief 追加一项并分配 key。 */
export function pushItem(state: Transcript, item: DistributiveOmit<Item, 'key'>): Transcript {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { ...item, key: `i${seq}` } as Item] };
}

/** @brief 新建一次工具调用。 */
export function newTool(id: string, name: string): ToolCall {
  return { id, name, argsText: '', args: null, status: 'preparing', output: '', patch: null, startedAt: null,
    durationMs: null, reason: null, allowedBy: null, gate: null };
}

/** 卡还挂着时你按了停止：工具卡上显示的理由 */
const STOPPED_REASON = '你按了停止';

/**
 * @brief 认出 Mori 拒绝时回给模型的工具结果（固定写法见 protocol.ts 的 REJECTED_*）。
 * @return 不是拒绝时为 null；是拒绝时 reason 为工具卡上显示的理由（没写理由时为 null）
 */
export function parseRejection(text: string): { reason: string | null } | null {
  if (text === REJECTED_BY_STOP) return { reason: STOPPED_REASON };
  if (text.startsWith(REJECTED_REASON_PREFIX)) return { reason: text.slice(REJECTED_REASON_PREFIX.length) };
  if (text === REJECTED_TEXT) return { reason: null };
  return null;
}

/** @brief 对联合类型逐个成员做 Omit。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** @brief pi 消息的时间（timestamp，ms）；没有时为 null。 */
export function messageTime(message: unknown): number | null {
  const time = (message as { timestamp?: unknown } | null)?.timestamp;
  return typeof time === 'number' ? time : null;
}

/** @brief 把消息内容（字符串或分段数组）转成纯文本。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n');
}

/** @brief 取编辑工具结果里的 unified diff。 */
export function resultPatch(result: unknown): string | null {
  const patch = (result as { details?: { patch?: unknown } } | undefined)?.details?.patch;
  return typeof patch === 'string' && patch.length > 0 ? patch : null;
}

/** @brief 把 pi 助手消息的最终内容转成段落；思考一律收起。 */
export function blocksFromContent(content: unknown): { blocks: Block[]; tools: ToolCall[] } {
  const blocks: Block[] = [];
  const tools: ToolCall[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text') blocks.push({ type: 'text', text: String(part.text ?? '') });
    else if (part?.type === 'thinking') {
      blocks.push({ type: 'thinking', text: String(part.thinking ?? ''), streaming: false });
    }
    else if (part?.type === 'toolCall') {
      blocks.push({ type: 'tool', id: String(part.id) });
      tools.push({ ...newTool(String(part.id), String(part.name)), args: part.arguments ?? {},
        argsText: JSON.stringify(part.arguments ?? {}) });
    } else blocks.push({ type: 'text', text: '' });
  }
  return { blocks, tools };
}
