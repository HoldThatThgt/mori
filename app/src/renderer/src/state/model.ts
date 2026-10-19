// 对话流的数据模型：由 pi 事件（transcript.ts）或会话记录（history.ts）归并而来，界面只读它。

/** @brief 工具卡状态，含义见 docs/v0/screens/tool-cards.md。 */
export type ToolStatus =
  | 'preparing' | 'awaiting' | 'running' | 'done' | 'failed' | 'rejected' | 'stopped' | 'interrupted';

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
  /** 已拒绝时你写的理由（M2） */
  reason: string | null;
  /** 自动放行的原因（M2）：本会话已允许 / 全部允许 */
  allowedBy: 'session' | 'all' | null;
}

/** @brief 助手回复里的一段：正文、思考或一次工具调用；下标与 pi 的 contentIndex 一致。 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; streaming: boolean }
  | { type: 'tool'; id: string };

/** @brief 对话流中的一项。 */
export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; blocks: Block[]; streaming: boolean }
  | { kind: 'compaction'; key: string }
  | { kind: 'stopped'; key: string }
  | { kind: 'error'; key: string; text: string; restore: string | null; live: boolean }
  | { kind: 'note'; key: string; text: string };

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
  items: [], tools: {}, running: false, sending: false, stage: null, steering: [], followUp: [],
  stopRequested: false, retrying: false, pendingError: null, lastUserText: null, firstUserText: null, seq: 0,
};

/** @brief 追加一项并分配 key。 */
export function pushItem(state: Transcript, item: DistributiveOmit<Item, 'key'>): Transcript {
  const seq = state.seq + 1;
  return { ...state, seq, items: [...state.items, { ...item, key: `i${seq}` } as Item] };
}

/** @brief 新建一次工具调用。 */
export function newTool(id: string, name: string): ToolCall {
  return { id, name, argsText: '', args: null, status: 'preparing', output: '', patch: null, startedAt: null,
    durationMs: null, reason: null, allowedBy: null };
}

/** @brief 对联合类型逐个成员做 Omit。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
