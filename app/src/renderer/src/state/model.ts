// 对话流的数据模型：由 pi 事件（transcript.ts）或会话记录（history.ts）归并而来，界面只读它。

import {
  REJECTED_BY_STOP, REJECTED_REASON_PREFIX, REJECTED_TEXT, type QuoteRef, type ToolGate, type UiRequest,
} from '../../../shared/protocol';
import {
  REASON_TEXTS, isUntilReason, plainReasonText, type CandidateExclusion, type ModelReason,
} from '../../../shared/models';
import type { ReceiptEntryData, TeamApprovalRequest, TeamDeciding, TeamMode, WakeKind } from '../../../shared/team';

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
  /**
   * 合并会话里这次立项工具调用写下的回执（平行 Agent 规格 §13.2），画在这张工具卡下面；没有时省略
   * （docs/v1/screens/team-stream.md "回执"）
   */
  receipts?: ReceiptEntryData[];
  /**
   * 这次调用所在的运行开始时的协作模式（平行 Agent 规格 §5.1、§13.8：agent_message 的 Message / Ask 按它定，
   * 模式之后改变不影响已经发生的调用）；没有记下时按 off
   */
  teamMode?: TeamMode;
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

/** @brief 换模型的一行（mori.model_switch 事件或会话文件里的同名条目，docs/v1/screens/model-chat.md）。 */
export interface ModelSwitchNotice {
  /** 原模型 <provider>/<model> */
  from: string;
  /** 新模型 <provider>/<model> */
  to: string;
  /** 原因代码 */
  reason: ModelReason;
  /** 原因的完整界面文字（带 until 部分） */
  detail: string;
  /** 有被隐藏的过程：加 "The new model redoes this reply." */
  hidden: boolean;
  /** 没能确认旧请求停下就换的：原因后加 " · couldn't confirm it stopped" */
  unconfirmed: boolean;
}

/** @brief 对话流中的一项。 */
export type Item =
  | ({
    kind: 'user'; key: string; text: string; refs: QuoteRef[] | null;
    /** 准备中（模型层 §11.4）：界面先显示的你的消息，pi 还没收到；pi 发出这条消息的 message_start 后清掉 */
    pending?: boolean;
  } & MessageMark)
  | ({ kind: 'assistant'; key: string; blocks: Block[]; streaming: boolean } & MessageMark)
  | { kind: 'compaction'; key: string }
  | { kind: 'stopped'; key: string }
  | {
    kind: 'error'; key: string; text: string; restore: string | null; live: boolean;
    /** 没发出去的消息带的引用芯片："放回输入框"时连芯片一起放回（restore 是含引用块的全文） */
    refs?: QuoteRef[];
  }
  | { kind: 'note'; key: string; text: string }
  | ({ kind: 'model-switch'; key: string } & ModelSwitchNotice)
  | {
    kind: 'rebuild'; key: string;
    /** 接手的模型 <provider>/<model> */
    model: string;
    /** 有压缩摘要；false 时只去掉了工具调用和思考 */
    summary: boolean;
  }
  | {
    kind: 'unavailable'; key: string;
    /** 每个候选及原因（No model available 卡） */
    candidates: CandidateExclusion[];
  }
  | { kind: 'notify'; key: string; text: string; level: 'info' | 'warning' | 'error' }
  /** 回执的一行（mori.receipt，平行 Agent 规格 §13.2） */
  | { kind: 'receipt'; key: string; receipt: ReceiptEntryData }
  /** 进展摘要的位置（mori.progress，§13.3）：内容取会话的 TaskBoard 视图里这个需求 */
  | {
    kind: 'progress'; key: string;
    /** 需求编号 */
    request: number;
  }
  /**
   * 程序投递到用户会话的消息（mori.wake，§5.6、§13.7）：不显示，只结束上一轮回复；
   * 条目 id 由它消费（mori.entry_id），所以不会记到你的消息上
   */
  | ({
    kind: 'wake'; key: string;
    /** 投递的种类 */
    wakeKind: WakeKind;
  } & MessageMark);

/** @brief 立项判断你的消息（mori.team_deciding，§5.3、§13.6）：阶段行与排队区。 */
export type DecidingState = TeamDeciding;

/** @brief 阶段行。tool 阶段的文字由界面按工具标题生成。 */
export interface Stage {
  /** 阶段种类 */
  kind: 'waiting' | 'thinking' | 'generating' | 'tool' | 'approval' | 'compacting';
  /** 阶段开始的时刻（ms），用于显示秒数 */
  since: number;
  /** tool：正在运行的工具 id */
  detail: string;
}

/**
 * @brief 模型层的等待（docs/v1/screens/model-chat.md "阶段行"）：等模型、等它停下、重建、排队、原地重试。
 *        进行时取代 v0 的"等待模型响应"，在准备中也显示。
 */
export interface ModelStage {
  /** 种类，同阶段行的 data-kind */
  kind: 'wait-model' | 'held' | 'rebuild' | 'queue' | 'retry';
  /** 这次等待开始的时刻（ms），用于显示已经等了多少秒 */
  since: number;
  /** 阶段行文字（不含秒数） */
  text: string;
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
  /** 模型层的等待；没有时为 null */
  modelStage: ModelStage | null;
  /** 准备中又发的消息（后台进程暂存，pi 开始后作为排队消息交给 pi），按发送顺序 */
  pendingQueue: string[];
  /** 本轮已显示 No model available 卡：同一次失败的 pi 错误不再显示错误卡 */
  unavailable: boolean;
  /** 模型回复出错，等 agent_end 决定是否显示 */
  pendingError: string | null;
  /** 最后一条你的消息（"把上一条消息放回输入框"） */
  lastUserText: string | null;
  /** 第一条你的消息（会话名） */
  firstUserText: string | null;
  /** 生成 key 用的序号 */
  seq: number;
  /**
   * 后台实例挂起的批准请求（mori.team_approval_request，§11.3），按到达顺序；对话一轮结束不清掉，
   * 由 mori.team_approval_end 去掉
   */
  teamApprovals: TeamApprovalRequest[];
  /** 立项判断你的消息；没有待判断的消息时为 null */
  deciding: DecidingState | null;
  /** 收到 mori.wake、还没等到同样文字的 message_start 的程序投递，按到达顺序（§13.7） */
  wakes: { text: string; kind: WakeKind }[];
  /**
   * 你正在撤回、停止或 Stop team（命令还没返回）：这期间待判断队列里少了的消息是被拿回输入框，
   * 不是交给了对话（applyDeciding 不把它们显示成待发或暂存的消息）
   */
  decidingHold: boolean;
  /** 当前（或会话记录里这一段）运行开始时的协作模式，新的工具调用记下它（ToolCall.teamMode）；没有时按 off */
  runTeamMode?: TeamMode;
}

export const emptyTranscript: Transcript = {
  items: [], tools: {}, running: false, sending: false, stage: null, steering: [], followUp: [], approvals: [],
  questions: [], stopRequested: false, modelStage: null, pendingQueue: [], unavailable: false, pendingError: null,
  lastUserText: null, firstUserText: null, seq: 0, teamApprovals: [], deciding: null, wakes: [],
  decidingHold: false,
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

/** @brief 准备中先显示的那条你的消息；没有时为 undefined。 */
export function pendingPrompt(state: Transcript): Extract<Item, { kind: 'user' }> | undefined {
  return state.items.find((item): item is Extract<Item, { kind: 'user' }> => item.kind === 'user'
    && Boolean(item.pending));
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

/**
 * @brief 原因的界面文字（§5.3）：detail 就是完整文字；until 不为 undefined 时带 until 的四种原因按它重新写出
 *        （null 得到不带 until 部分的文字，换模型提示用）。detail 为空时退回原因代码。
 */
export function reasonText(reason: ModelReason, detail: string, until?: number | null): string {
  if (until === null) return plainReasonText(reason, detail) || reason;
  if (until !== undefined && isUntilReason(reason)) return REASON_TEXTS[reason](until);
  return detail || reason;
}

/** @brief 换模型提示的文字："Switched model: A → B · <原因>"，原因不带 until 部分。 */
export function switchText(notice: ModelSwitchNotice): string {
  const confirm = notice.unconfirmed ? " · couldn't confirm it stopped" : '';
  const redo = notice.hidden ? ' The new model redoes this reply.' : '';
  return `Switched model: ${notice.from} → ${notice.to} · ${reasonText(notice.reason, notice.detail, null)}${confirm}`
    + redo;
}

/** @brief 重建提示的文字（§6.3 第 4 步）。 */
export function rebuildText(model: string, summary: boolean): string {
  const kept = summary ? 'summary + recent turns' : 'recent turns without tool calls';
  return `Rebuilt the conversation for ${model}: ${kept}`;
}

/** @brief 说明卡、拒绝启动卡、菜单悬停里候选的一行："<provider>/<model> — <原因>"。 */
export function candidateLine(candidate: CandidateExclusion): string {
  return `${candidate.ref} — ${reasonText(candidate.reason, candidate.detail)}`;
}
