// 最小批准扩展（方案第 6 节，后台进程第 3 件事"转达批准请求"）：用 inline extension 注册 tool_call 处理器，
// 在闭包里等界面的答复；拒绝时返回 { block: true, reason }，pi 把 reason 原样作为工具结果回给模型。
// 每个待批准请求都绑定 ctx.signal：pi 不会替处理器取消等待，中止时不放手 session.abort() 会一直等着。
// "Allow for this session"只是按工具名记录的集合，和权限一起只存在内存里，不做其他规则。状态表见 docs/v0/screens/approval.md。

import type {
  ExtensionContext, ExtensionFactory, ToolCallEvent, ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_APPROVAL, READ_ONLY_TOOLS, REJECTED_BY_STOP, REJECTED_REASON_PREFIX, REJECTED_TEXT,
  type ApprovalDecision, type ApprovalEndBy, type ApprovalMode, type ApprovalRequestInfo, type ApprovalState,
  type EventEnvelope, type KernelEvent, type ToolGate,
} from '../shared/protocol';

type Emit = (envelope: EventEnvelope) => void;

/** 停止时等被拒绝的调用在 pi 里结束的上限：先让 pi 记下拒绝，再中止（否则 pi 只记"Operation aborted"） */
const STOP_SETTLE_MS = 2000;

/** @brief 一个等你选择的请求。 */
interface Pending {
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 完整的调用参数（界面重新加载后接上时再交给界面） */
  args: Record<string, unknown>;
  /** 把答复交还给 pi */
  resolve: (result: ToolCallEventResult | undefined) => void;
  /** 解除对 ctx.signal 的监听 */
  release: () => void;
}

/** @brief 你拒绝时回给模型的工具结果原文。 */
export function rejectionText(reason: string | undefined): string {
  const text = reason?.trim();
  return text ? `${REJECTED_REASON_PREFIX}${text}` : REJECTED_TEXT;
}

/** @brief 一个会话的批准状态：权限、"Allow for this session"的工具名、挂起的请求。 */
export class ApprovalGate {
  /** 事件要带上的 pi 会话 id；会话建好后由 attach 记下 */
  private sessionId = '';
  /** 权限：每次询问 / 全部允许 */
  private mode: ApprovalMode = DEFAULT_APPROVAL.mode;
  /** "Allow for this session"记下的工具名 */
  private readonly allowed = new Set<string>(DEFAULT_APPROVAL.allowed);
  /** 等你选择的请求，按请求 id */
  private readonly pending = new Map<string, Pending>();
  /** rejectForStop 在等它们在 pi 里结束的调用：toolCallId → 通知 */
  private readonly endWaiters = new Map<string, () => void>();
  /** 已预告给界面、处理器还没判断的调用：toolCallId → 预告的处理方式 */
  private readonly announced = new Map<string, ToolGate>();
  /** 正在停止（rejectForStop 开始到 session.abort() 结束）：除只读工具外的调用一律按拒绝处理 */
  private stopping = false;
  /** 下一个请求 id 的序号 */
  private nextId = 1;

  /** @param emit 把事件发给界面 */
  constructor(private readonly emit: Emit) {}

  /** @brief 会话建好后记下它的 id（事件要带上）。 */
  attach(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** @brief 当前的批准设置。 */
  state(): ApprovalState {
    return { mode: this.mode, allowed: [...this.allowed] };
  }

  /** @brief 这个工具现在会怎样处理。 */
  private gateFor(toolName: string): ToolGate {
    if (READ_ONLY_TOOLS.includes(toolName)) return 'free';
    if (this.mode === 'all') return 'all';
    return this.allowed.has(toolName) ? 'session' : 'ask';
  }

  /**
   * @brief pi 的 tool_execution_start 转发给界面之前调用：发出 mori.tool_gate，并记下预告的处理方式，
   *        处理器后来判断不同时据此发更正。
   */
  announce(toolCallId: string, toolName: string): void {
    const gate = this.gateFor(toolName);
    this.announced.set(toolCallId, gate);
    this.send({ type: 'mori.tool_gate', toolCallId, toolName, gate });
  }

  /** @brief 交给 DefaultResourceLoader 的 inline extension；每个会话一个。 */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.on('tool_call', (event, ctx) => this.onToolCall(event, ctx));
    };
  }

  /**
   * @brief pi 在执行工具前调用：要批准时挂起，等你在界面上选择；停止中的调用直接按拒绝处理。
   *        预告过要批准、现在已不用批准时（例如排队的嵌套调用在你选了"Allow for this session"之后才轮到），
   *        再发一次 mori.tool_gate 更正。
   */
  private onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
    const { toolCallId, toolName } = event;
    const announced = this.announced.get(toolCallId);
    this.announced.delete(toolCallId);
    const gate = this.gateFor(toolName);
    // 停止中：pi 拿到前一个调用的拒绝后会立刻放行排在后面的嵌套调用，它们不再出卡，也不执行。
    if (this.stopping && gate !== 'free') return Promise.resolve({ block: true, reason: REJECTED_BY_STOP });
    if (gate !== 'ask') {
      if (announced === 'ask') this.send({ type: 'mori.tool_gate', toolCallId, toolName, gate });
      return Promise.resolve(undefined);
    }
    // 在处理器开始时读取：之后的重试或续跑会换成新的 signal。
    return this.request(event, ctx.signal);
  }

  /** @brief 发出批准请求并挂起，直到你选择、切换权限或停止；signal 中止时按拒绝处理。 */
  private request(event: ToolCallEvent, signal: AbortSignal | undefined): Promise<ToolCallEventResult | undefined> {
    if (signal?.aborted) return Promise.resolve({ block: true, reason: REJECTED_BY_STOP });
    const requestId = `approval-${this.nextId++}`;
    return new Promise((resolve) => {
      const onAbort = () => this.finish(requestId, 'reject', 'closed', REJECTED_BY_STOP);
      signal?.addEventListener('abort', onAbort, { once: true });
      const release = () => signal?.removeEventListener('abort', onAbort);
      // 参数取 event.input：先加载的扩展可能改过它，执行的是改过之后的参数。
      const args = { ...(event.input as Record<string, unknown>) };
      this.pending.set(requestId, { toolCallId: event.toolCallId, toolName: event.toolName, args, resolve, release });
      this.send({ type: 'mori.approval_request', requestId, toolCallId: event.toolCallId, toolName: event.toolName,
        args });
    });
  }

  /**
   * @brief 结束一个请求：把结果交还给 pi，并告诉界面。
   * @param reason 拒绝时回给模型的原文；允许时忽略
   * @return 请求还挂着并已结束时为真
   */
  private finish(requestId: string, decision: 'allow' | 'reject', by: ApprovalEndBy, reason: string | null): boolean {
    const item = this.pending.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    item.release();
    const text = decision === 'reject' ? (reason ?? REJECTED_TEXT) : null;
    item.resolve(text === null ? undefined : { block: true, reason: text });
    this.send({ type: 'mori.approval_end', requestId, toolCallId: item.toolCallId, decision, by, reason: text });
    return true;
  }

  /** @brief 你在批准卡上的选择。请求已经结束（例如你刚按了停止）时报错，界面那张卡已经收到结束事件。 */
  answer(requestId: string, decision: ApprovalDecision, reason?: string): ApprovalState {
    const item = this.pending.get(requestId);
    if (!item) throw new Error(`Approval request ${requestId} is no longer pending`);
    if (decision === 'reject') {
      this.finish(requestId, 'reject', 'user', rejectionText(reason));
      return this.state();
    }
    if (decision === 'allowSession') this.allowed.add(item.toolName);
    this.finish(requestId, 'allow', 'user', null);
    if (decision === 'allowSession') {
      for (const [id, other] of [...this.pending]) {
        if (other.toolName === item.toolName) this.finish(id, 'allow', 'session', null);
      }
    }
    return this.state();
  }

  /** @brief 切换权限；切到"Allow all"时挂起的请求按允许处理（方案 5.7）。 */
  setMode(mode: ApprovalMode): ApprovalState {
    this.mode = mode;
    if (mode === 'all') for (const id of [...this.pending.keys()]) this.finish(id, 'allow', 'all', null);
    return this.state();
  }

  /** @brief 从"Allowed for this session"里清除一个工具名。 */
  forget(toolName: string): ApprovalState {
    this.allowed.delete(toolName);
    return this.state();
  }

  /**
   * @brief 停止前：进入停止状态，挂起的请求按拒绝处理，并等这些调用在 pi 里结束（最多 STOP_SETTLE_MS）。
   *        pi 在处理器返回后先看 signal：先中止的话，它只记下"Operation aborted"，拒绝的原文就丢了。
   *        停止状态由 endStop 在 session.abort() 结束后解除。
   */
  async rejectForStop(): Promise<void> {
    // 先进入停止状态再交还拒绝：等待的这段时间里，排在后面的调用到了处理器也不会出卡或执行。
    this.stopping = true;
    const ids = [...this.pending.entries()].map(([id, item]) => ({ id, toolCallId: item.toolCallId }));
    if (ids.length === 0) return;
    const ended = ids.map(({ toolCallId }) => new Promise<void>((done) => this.endWaiters.set(toolCallId, done)));
    for (const { id } of ids) this.finish(id, 'reject', 'stop', REJECTED_BY_STOP);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((done) => { timer = setTimeout(done, STOP_SETTLE_MS); });
    await Promise.race([Promise.all(ended), timeout]);
    clearTimeout(timer);
    for (const { toolCallId } of ids) this.endWaiters.delete(toolCallId);
  }

  /** @brief session.abort() 结束后调用：解除停止状态，之后的调用照常判断。 */
  endStop(): void {
    this.stopping = false;
  }

  /** @brief pi 的 tool_execution_end 经过时调用：rejectForStop 可能在等它；这次调用的预告不再需要。 */
  noteToolEnd(toolCallId: string): void {
    this.announced.delete(toolCallId);
    this.endWaiters.get(toolCallId)?.();
  }

  /** @brief 挂起的批准请求，按提出的顺序（界面重新加载后接上会话时用）。 */
  requests(): ApprovalRequestInfo[] {
    return [...this.pending.entries()].map(([requestId, item]) => ({ requestId, toolCallId: item.toolCallId,
      toolName: item.toolName, args: item.args }));
  }

  /** @brief 会话释放前：挂起的请求按拒绝处理，pi 不会卡在等待上。 */
  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'reject', 'closed', REJECTED_BY_STOP);
  }

  /** @brief 发一个本会话的事件。 */
  private send(event: KernelEvent): void {
    this.emit({ kind: 'event', sessionId: this.sessionId, event });
  }
}
