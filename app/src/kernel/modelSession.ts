// 会话接线（docs/specs/model-providers.md §5、§6、§11）：每个打开的会话一个 ModelSession。
// - 虚拟模型：会话新建或打开前在共享的 ModelRuntime 上注册 mori/<会话 id>，route() 决定每次请求用哪个实际模型（§11.1）；
// - 选择范围与静态校验：mori.pick 条目、ModelState.blocked，配置或档案变化时重新校验（§4.6、§5.1）；
// - 一段工作（ReplyState）：session.prompt 的准备中（选模型、§5.8 的等待、接手判断与重建，§11.4）、
//   排队消息开始新的一段（K13）、段内换模型（§5.6）；
// - 流函数包装：缓冲到第一个有内容的事件、首个内容时限、换模型、结果未知的等待、候选耗尽（§11.2、§5.7、§5.8）；
// - 内联扩展：context 钩子（§6.1、§6.3）、message_start（排队消息）、session_before_compact（§6.1 最后一条）。
// 平行 Agent 与 TaskBoard（docs/specs/parallel-agents-taskboard.md §12）在这里接上：候选来源（选择范围或角色的 models、
// requires、避开的模型族）、协作模式下锁定范围（pickLocked）、task 会话中途换模型从工作卡重来（mori.task_restart、
// takeRestart）、每次尝试的请求改写（shape）、候选耗尽的回调（onUnavailable）、调度类别、工作卡的长度与位置。
// 进程桥事件经构造时给的 emit 发出（会话信封由 sessions.ts 加上）。

import type {
  AgentSession, ExtensionFactory, ModelRoute, ModelRouteRequest, SessionManager,
} from '@earendil-works/pi-coding-agent';
import type {
  Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  MODEL_ENTRY_TYPES, MODEL_RESTART, REASON_TEXTS, THINKING_LEVELS, VIRTUAL_PROVIDER_ID, type ApiType,
  type CandidateExclusion, type ModelEvent, type ModelPick, type ModelState, type ModelSwitchEntryData,
  type PickOptions, type PickEntryData, type RebuildEntryData, type TaskRestartEntryData, type ThinkingLevel,
} from '../shared/models';
import { chainPayload, type PayloadChange } from './forcedWrite';
import { lastAssistantRef, resolveSessionPick, splitRef } from './modelConfig';
import {
  applyRebuildEntries, applyRestartEntries, applySwitchEntries, detachWorkCard, fitsWindow,
  forgetCompactionBeforeRestart, handoverAction, handoverCheck, hideUntilOf, previousFileLists, reattachWorkCard,
  stripForCompaction, type HandoverCheck, type HandoverTarget, type MessageLike,
} from './modelContext';
import type { ModelLayer, ModelsChange, ProjectContext } from './modelLayer';
import type {
  AttemptRecord, AvailabilityReason, CandidateSource, FailureClass, ModelRef, ReplyState, Requirement, SchedClass,
  SelectorInput, SelectorResult, TaskRestart, TriedReason, UnavailableInfo,
} from './modelTypes';
import { loadPi, type Pi } from './pi';
import { readRunningRequests } from './probes';
import {
  availabilityText, checkCurrent, exhaustionWait, intersectCandidates, pickOptions, select, staticCheck,
  type StaticCheckInput, type StaticCheckResult,
} from './selector';

/** @brief pi 的流函数（session.agent.streamFunction）。 */
type StreamFn = AgentSession['agent']['streamFunction'];
/** @brief pi 的会话消息。 */
type AgentMessage = AgentSession['messages'][number];
/** @brief pi-ai 模块（只提供 ESM，按需动态加载）。 */
type PiAi = typeof import('@earendil-works/pi-ai');
/** @brief mori.model_wait 事件。 */
type WaitEvent = Extract<ModelEvent, { type: 'mori.model_wait' }>;

/** @brief 没有候选时虚拟模型的窗口、最大输出（§11.1）。 */
const DEFAULT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
/** @brief pi 表示“不限时”的 timeoutMs（§8.4、K11）。 */
const NO_TIMEOUT_MS = 2_147_483_647;
/** @brief 虚拟模型的显示名。 */
const VIRTUAL_MODEL_NAME = 'Mori';

/** @brief 用户停止时合成的中止说明（§11.2 第 4 步）。 */
const ABORTED_MESSAGE = 'Request was aborted';
/** @brief 协作模式下对话会话 setPick 被拒绝的原文（平行 Agent 规格 §12.11，与模型按钮的悬停文字相同）。 */
export const PICK_LOCKED_MESSAGE = 'Team mode picks the model for each agent';
/** @brief 普通会话的候选来源：你在范围菜单里选的范围，只要求 tool_calling（统一模型提供商规格 §5.3 第 3 步）。 */
const PICK_SOURCE: CandidateSource = { kind: 'pick' };
/** @brief 能力要求总是隐含 tool_calling（平行 Agent 规格 §4.1）。 */
const TOOL_CALLING: readonly Requirement[] = [{ kind: 'tool_calling' }];

/** @brief 有内容的事件：正文、思考、工具调用的开始或增量（§11.2 第 2 步）。 */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  'text_start', 'text_delta', 'thinking_start', 'thinking_delta', 'toolcall_start', 'toolcall_delta',
]);
/** @brief 有内容之前出现就换模型的分类（§5.4）；收到响应头后、内容前中断的 partial 另按 connection 处理。 */
const SWITCH_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'rate_limited', 'auth', 'quota', 'not_found', 'connection', 'queue_timeout',
]);

let piAiModule: Promise<PiAi> | undefined;

/** @brief 动态加载 pi-ai（后台进程入口是 CJS，pi-ai 只提供 ESM）。 */
function loadPiAi(): Promise<PiAi> {
  piAiModule ??= import('@earendil-works/pi-ai');
  return piAiModule;
}

/** @brief 模型对象的全名 <provider>/<model>。 */
function refOf(model: { provider: string; id: string }): ModelRef {
  return `${model.provider}/${model.id}`;
}

/** @brief 中止时抛出的错误。 */
function abortError(): Error {
  const error = new Error(ABORTED_MESSAGE);
  error.name = 'AbortError';
  return error;
}

/**
 * @brief 可中止的等待。
 * @param ms 毫秒；不大于 0 时只让出一次
 * @param signal 中止时以 AbortError 拒绝
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @brief 等到 Date.now() 超过 at（之后写的条目与消息的时间戳都大于 at）。计时器按事件循环缓存的时钟算，到点时
 *        Date.now() 可能还没走过 at，所以到点后再看一次，没过就接着等。
 * @param at 毫秒时间戳
 * @param signal 中止时以 AbortError 拒绝
 */
async function waitPast(at: number, signal?: AbortSignal): Promise<void> {
  while (Date.now() <= at) await delay(at - Date.now() + 1, signal);
}

/** @brief 消息内容的纯文字（与 pi 排队区比较全文的写法相同）。 */
function messageText(message: { content?: unknown }): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('');
}

/**
 * @brief §5.8 的说明：没有可用模型，列出每个候选及原因。
 * @param excluded 每个候选及原因
 * @param compaction 压缩时选不到（“No model available for compaction”）
 */
export function exhaustionText(excluded: readonly CandidateExclusion[], compaction: boolean): string {
  const head = compaction ? 'No model available for compaction' : 'No model available';
  if (excluded.length === 0) return head;
  return `${head}: ${excluded.map((item) => `${item.ref} — ${item.detail}`).join('; ')}`;
}

/**
 * @brief 换模型后重发的思考强度（§11.2 第 2.3 步的 2026-10-24 补、§7.7“其他改动”）：会话的强度按新模型收紧
 *        （clampThinkingLevel，与 pi 路由时的收紧相同；没有 Off 的模型把 off 提到 minimal），收紧后是 off 才不传。
 * @param model 换到的实际模型
 * @param level 会话的思考强度
 * @param clamp pi-ai 的 clampThinkingLevel
 * @return 重发选项里的 reasoning；收紧后是 off 时为 undefined
 */
export function resendReasoning(model: Model<Api>, level: ThinkingLevel,
  clamp: PiAi['clampThinkingLevel']): SimpleStreamOptions['reasoning'] {
  const clamped = clamp(model, level);
  return clamped === 'off' ? undefined : clamped;
}

/** @brief pi 报“没有可压缩的”（对话太短或刚压缩过，§6.3 第 1 步跳过）。 */
function isNothingToCompact(message: string): boolean {
  return message.startsWith('Nothing to compact') || message.startsWith('Already compacted');
}

/** @brief 合成的助手消息（中止或耗尽时，§11.2 第 4、5 步）。 */
function syntheticMessage(model: Model<Api>, partial: AssistantMessage | null,
  failure: { stopReason: 'aborted' | 'error'; errorMessage: string }): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const base: AssistantMessage = partial ?? {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
    stopReason: 'error', timestamp: Date.now(),
  };
  return { ...base, stopReason: failure.stopReason, errorMessage: failure.errorMessage };
}

/** @brief 一次请求里随换模型变化的部分。 */
interface RequestState {
  /** 实际模型 */
  model: Model<Api>;
  /** 发给模型的上下文 */
  context: TranscriptContext;
  /** pi 给的选项 */
  options: SimpleStreamOptions | undefined;
  /** 实际模型的全名 */
  ref: ModelRef;
}

/** @brief 一次尝试（对一个模型调一次原函数）的结果。 */
interface AttemptResult {
  /** 事件已原样推进返回的事件流（有内容、或没有内容就正常结束） */
  delivered: boolean;
  /** 推进去的最后一个事件是 done 或 error */
  terminal: boolean;
  /** 没推进去的缓冲事件（delivered 为假时） */
  events: AssistantMessageEvent[];
  /** 模型池记下的最后一次尝试 */
  record: AttemptRecord | null;
  /** 首个内容时限到了，这次尝试被中止 */
  timedOut: boolean;
  /** 排队等槽位的时长（ms） */
  queueWaitMs: number;
}

/** @brief 要换模型的失败：原因与是否没能确认旧请求已停下（§5.6、§5.7）。 */
export interface SwitchFailure extends TriedReason {
  /** §5.7：没能确认旧请求已停下就换的 */
  unconfirmed: boolean;
}

/** @brief 段内换模型的结果：换到的模型；选不到时为 null，并给出全部候选的原因（说明卡已发出）。 */
export interface SwitchResult {
  /** 换到的模型；选不到时为 null */
  ref: ModelRef | null;
  /** 选不到时全部候选的排除原因 */
  excluded: CandidateExclusion[];
  /**
   * task 会话已有过程时换模型（平行 Agent 规格 §12.4）：已写 mori.model_switch 与 mori.task_restart，
   * 这次运行以 MODEL_RESTART 结束，在 ref 上重来；其余为 false
   */
  restart: boolean;
}

/** @brief 一次尝试的请求改写（平行 Agent 规格 §7.5、§12.7、§14.4），由 ModelSessionOptions.shape 给出。 */
export interface RequestShape {
  /** 指定调用的工具（A 级，forcedWrite.forcedToolChoice 的结果）；省略时不改 */
  toolChoice?: SimpleStreamOptions['toolChoice'];
  /** 请求体改写：接在 pi 原来的 onPayload（before_provider_request）之后，先调原来的（§14.6 T-F1）；省略时不改 */
  payload?: PayloadChange;
  /** 这次请求关闭思考（A 级，档案 reasoning.can_disable 为真时） */
  thinkingOff?: boolean;
}

/** @brief shape 收到的一次尝试：每次尝试（含换模型重发）都按这次实际用的模型重新问一次。 */
export interface ShapeAttempt {
  /** 这次尝试实际用的模型 */
  ref: ModelRef;
  /** 它的接口类型 */
  api: ApiType;
  /** 这次请求发出的上下文（末尾带工作卡） */
  context: TranscriptContext;
}

/** @brief 段开始时的选择（平行 Agent 规格 §12.4 继续的那一段）：先试 prefer，这一段里不选 exclude。 */
export interface SegmentChoice {
  /** 先试的模型（takeRestart().to）；它通不过时从第一个候选起选 */
  prefer?: ModelRef;
  /** 这一段里不选的模型（takeRestart().from），按它重来时的原因记进 tried */
  exclude?: readonly ModelRef[];
}

/** @brief session.prompt 准备中的结果（§11.4）。 */
export type PrepareResult =
  | { kind: 'ok' }
  | {
    kind: 'unavailable';
    /** 每个候选及原因（说明卡） */
    candidates: CandidateExclusion[];
  };

/** @brief 建立 ModelSession 的参数。 */
export interface ModelSessionOptions {
  /** 模型层 */
  layer: ModelLayer;
  /** pi 会话 id（虚拟模型的 id） */
  sessionId: string;
  /** 会话的工作文件夹（项目） */
  cwd: string;
  /** @brief 发会话事件（不带信封）。 */
  emit(event: ModelEvent): void;
  /** 候选来源（平行 Agent 规格 §12.1）；省略时为你在范围菜单里选的范围、只要求 tool_calling */
  source?: CandidateSource;
  /** 调度类别（平行 Agent 规格 §12.10），会话的请求与压缩请求都用它；省略时为 conversation */
  schedClass?: SchedClass;
  /** task：已有过程时中途换模型就结束本轮、在新模型上从工作卡重来（§12.4）；省略或 normal 时按重做（§5.6、§6.1） */
  kind?: 'normal' | 'task';
  /**
   * @brief task 会话重来后投递的继续消息（§12.4）：选新模型时的窗口判断把它算进去；省略时不算。
   * @param restart 这次重来（to 为正在判断的候选）
   */
  restartText?(restart: TaskRestart): string;
  /** @brief 每次请求加在上下文末尾的工作卡的 token 估算（§8.3、§12.6），算进接手判断与窗口判断；省略时为 0。 */
  extraContextTokens?(): number;
  /**
   * @brief 每次尝试的请求改写（强制填写交接单，§7.5、§12.7、§14.4）；返回 null 时不改。
   * @param attempt 这次尝试实际用的模型、接口与上下文
   */
  shape?(attempt: ShapeAttempt): RequestShape | null;
  /**
   * @brief 候选耗尽、§5.8 等完仍选不到时调用（§12.5），包括段开始时（prepare 返回 unavailable）；不解析错误文字。
   * @param info 每个候选及原因
   */
  onUnavailable?(info: UnavailableInfo): void;
}

/**
 * @brief 首个内容时限（§5.4 timeout）：从最近一次 onSent 起计时，每次 onSent 重新计时，有内容即停；
 *        换 key、原地重试的等待（onPause）暂停计时，排队、等待都不计入。
 */
export class FirstContentTimer {
  /** 时限到了 */
  fired = false;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * @param ms 时限
   * @param onFire 到时调用（中止这次尝试）
   */
  constructor(private readonly ms: number, private readonly onFire: () => void) {}

  /** @brief 一次真正发出：重新计时。 */
  restart(): void {
    if (this.stopped) return;
    this.clear();
    this.handle = setTimeout(() => {
      this.fired = true;
      this.onFire();
    }, this.ms);
  }

  /** @brief 换 key 或原地重试的等待：暂停计时，下一次 onSent 重新计时。 */
  pause(): void {
    this.clear();
  }

  /** @brief 有内容了或尝试结束：不再计时。 */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }
}

/** @brief 一次尝试里模型池回调的记录：最后一次尝试、排队时长。 */
class AttemptWatch {
  /** 模型池记下的最后一次尝试 */
  record: AttemptRecord | null = null;
  /** 排队的总时长（ms） */
  queueWaitMs = 0;
  private queuedAt: number | null = null;

  /** @brief 开始或结束排队。 */
  queue(active: boolean): void {
    if (active) this.queuedAt = Date.now();
    else if (this.queuedAt !== null) {
      this.queueWaitMs += Date.now() - this.queuedAt;
      this.queuedAt = null;
    }
  }
}

/** @brief 流函数包装用到的会话接线（ModelSession 实现）。 */
interface WrapperHost {
  /** pi 会话 id；请求的 sessionId 与它不同即压缩请求（§6.4、K5） */
  readonly sessionId: string;
  /** 模型层 */
  readonly layer: ModelLayer;
  /** pi-ai 模块 */
  readonly piAi: PiAi;
  /** 调度类别：会话请求与压缩请求都用它（平行 Agent 规格 §12.10） */
  readonly schedClass: SchedClass;
  /** @brief 发会话事件。 */
  emit(event: ModelEvent): void;
  /** @brief 这次尝试的请求改写（平行 Agent 规格 §12.7）；没有时为 null。 */
  shapeAttempt(attempt: ShapeAttempt): RequestShape | null;
  /** @brief 有没有正在进行的一段。 */
  hasReply(): boolean;
  /** @brief 会话的思考强度。 */
  thinkingLevel(): ThinkingLevel;
  /** @brief 段内换模型（§5.6）。 */
  switchFrom(from: ModelRef, failure: SwitchFailure, messages: readonly MessageLike[],
    signal?: AbortSignal): Promise<SwitchResult>;
  /** @brief 按 §6.1、§6.3 处理上下文。 */
  processMessages<T extends MessageLike>(messages: readonly T[]): T[];
  /** @brief 运行时里的实际模型。 */
  physical(ref: ModelRef): Model<Api>;
}

/** @brief 流函数包装（§11.2）：每个会话一个，原函数保留在里面调用。 */
class StreamWrapper {
  /**
   * @param host 会话接线
   * @param original pi 原来的流函数
   */
  constructor(private readonly host: WrapperHost, private readonly original: StreamFn) {}

  /** @brief 包装后的流函数。 */
  stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const out = this.host.piAi.createAssistantMessageEventStream();
    const request: RequestState = { model, context, options, ref: refOf(model) };
    const run = options?.sessionId === this.host.sessionId ? this.runReply(request, out)
      : this.runCompaction(request, out);
    void run.catch((error: unknown) => this.fail(request, out, error));
    return out;
  }

  /** @brief 压缩请求（§11.2 第 1 步）：经模型池、执行首个内容时限，事件原样返回；超时记 timeout，不换模型。 */
  private async runCompaction(request: RequestState, out: AssistantMessageEventStream): Promise<void> {
    const result = await this.attempt(request, out, false);
    if (result.delivered) this.finish(request, result, out);
    else this.passthrough(request, result, out);
    this.markDropped(request, result);
    if (!result.timedOut) return;
    const { layer } = this.host;
    layer.getPool().markModel(request.ref, 'timeout', Date.now() + layer.timings.timeoutCooldownMs);
  }

  /** @brief 会话请求（§11.2 第 2 步）：每次尝试失败且要换模型时换到下一个候选，回到第 2 步。 */
  private async runReply(request: RequestState, out: AssistantMessageEventStream): Promise<void> {
    let current = request;
    for (;;) {
      const baseline = await this.runningRequests(current.ref, current.options?.signal, true);
      const result = await this.attempt(current, out, true);
      if (result.delivered) {
        this.finish(current, result, out);
        return;
      }
      const next = await this.afterFailure(current, result, baseline, out);
      if (!next) return;
      current = next;
    }
  }

  /**
   * @brief 在有内容之前失败之后（§11.2 第 3–6 步）：停止 → 合成 aborted；要换模型 → 换；其他原样推进。
   * @return 换到的下一个请求；已经结束时为 null
   */
  private async afterFailure(request: RequestState, result: AttemptResult, baseline: number | null,
    out: AssistantMessageEventStream): Promise<RequestState | null> {
    const signal = request.options?.signal;
    if (signal?.aborted) {
      this.pushAborted(request, result, out);
      return null;
    }
    this.markDropped(request, result);
    const failure = this.host.hasReply() ? await this.failureOf(request, result, baseline) : null;
    if (!failure) {
      this.passthrough(request, result, out);
      return null;
    }
    const switched = await this.host.switchFrom(request.ref, failure, request.context.messages, signal);
    if (switched.restart) {
      // task 会话已有过程：结束这次运行，后台进程读 takeRestart() 在新模型上继续（平行 Agent 规格 §12.4）
      this.pushError(request, out, MODEL_RESTART);
      return null;
    }
    if (switched.ref === null) {
      this.pushError(request, out, exhaustionText(switched.excluded, false));
      return null;
    }
    return this.retarget(request, switched.ref);
  }

  /**
   * @brief 一次尝试：给原函数 Mori 的 fetch、maxRetries 0、不限时的 timeoutMs 与组合的 signal，
   *        缓冲事件直到第一个有内容的事件（buffer 为假时不缓冲，压缩请求用）。
   */
  private async attempt(request: RequestState, out: AssistantMessageEventStream,
    buffer: boolean): Promise<AttemptResult> {
    const controller = new AbortController();
    const timer = new FirstContentTimer(this.host.layer.timings.firstContentTimeoutMs, () => controller.abort());
    const watch = new AttemptWatch();
    const result: AttemptResult = { delivered: false, terminal: false, events: [], record: null, timedOut: false,
      queueWaitMs: 0 };
    try {
      const options = this.attemptOptions(request, controller, timer, watch);
      const stream = await this.original(request.model, request.context, options);
      await this.consume(stream, out, buffer, timer, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[kernel] ${this.host.sessionId}: request to ${request.ref} failed: ${message}`);
      result.events.push({ type: 'error', reason: 'error',
        error: syntheticMessage(request.model, null, { stopReason: 'error', errorMessage: message }) });
    } finally {
      timer.stop();
      result.record = watch.record;
      result.timedOut = timer.fired;
      result.queueWaitMs = watch.queueWaitMs;
    }
    return result;
  }

  /** @brief 读原函数的事件：第一个有内容的事件（或 done，或不缓冲时第一个事件）起原样推进返回的事件流。 */
  private async consume(stream: AsyncIterable<AssistantMessageEvent>, out: AssistantMessageEventStream,
    buffer: boolean, timer: FirstContentTimer, result: AttemptResult): Promise<void> {
    for await (const event of stream) {
      const content = CONTENT_EVENTS.has(event.type);
      if (content) timer.stop();
      if (!result.delivered) {
        result.events.push(event);
        if (!content && event.type !== 'done' && buffer) continue;
        result.delivered = true;
        for (const item of result.events) out.push(item);
        result.events = [];
      } else {
        out.push(event);
      }
      result.terminal = event.type === 'done' || event.type === 'error';
    }
  }

  /**
   * @brief 这次尝试的选项（§11.2、§8.4）：Mori 的 fetch（会话的调度类别）、不重试、不限时，再按 shape 改写
   *        （平行 Agent 规格 §12.7、§14.4）。
   */
  private attemptOptions(request: RequestState, controller: AbortController, timer: FirstContentTimer,
    watch: AttemptWatch): SimpleStreamOptions {
    const { layer } = this.host;
    const user = request.options?.signal;
    const api = (layer.lookupModel(request.ref)?.provider.api ?? request.model.api) as ApiType;
    const fetch = layer.getPool().createFetch({
      ref: request.ref, api, sessionKey: this.host.sessionId, cls: this.host.schedClass, signal: user,
      attemptSignal: controller.signal,
      onSent: () => timer.restart(),
      onPause: () => timer.pause(),
      onRecord: (record) => {
        watch.record = record;
      },
      onRetryWait: (notice) => this.host.emit({ type: 'mori.model_retry', ...notice }),
      onQueue: (notice) => {
        watch.queue(notice.active);
        this.host.emit({ type: 'mori.model_queue', ...notice });
      },
    });
    const signal = user ? AbortSignal.any([user, controller.signal]) : controller.signal;
    return this.shaped(request, api, { ...request.options, fetch, maxRetries: 0, timeoutMs: NO_TIMEOUT_MS, signal });
  }

  /**
   * @brief 按 shape 改写这次尝试（平行 Agent 规格 §7.5、§14.4）：每次尝试按这次实际用的模型问一次，所以换了模型之后
   *        就按新模型的等级；请求体改写接在 pi 原来的 onPayload 之后（先调原来的）。压缩请求不改。
   * @param request 这次请求
   * @param api 实际模型的接口类型
   * @param options 已加上 Mori 选项的这次尝试的选项
   */
  private shaped(request: RequestState, api: ApiType, options: SimpleStreamOptions): SimpleStreamOptions {
    if (request.options?.sessionId !== this.host.sessionId) return options;
    const shape = this.host.shapeAttempt({ ref: request.ref, api, context: request.context });
    if (!shape) return options;
    const next: SimpleStreamOptions = { ...options };
    if (shape.toolChoice !== undefined) next.toolChoice = shape.toolChoice;
    if (shape.thinkingOff) next.reasoning = undefined;
    if (shape.payload) next.onPayload = chainPayload(request.options?.onPayload, shape.payload);
    return next;
  }

  /**
   * @brief 收到响应头之后、第一个有内容的事件之前连接中断（partial，且没有推进内容）：
   *        提供商记 connection 一段时间（§5.4、§12）。只有包装知道有没有内容，所以由这里写记录。
   */
  private markDropped(request: RequestState, result: AttemptResult): void {
    const parts = splitRef(request.ref);
    if (!parts || result.delivered || result.timedOut || result.record?.cls !== 'partial') return;
    const { layer } = this.host;
    layer.getPool().markProvider(parts.providerId, 'connection', Date.now() + layer.timings.connectionCooldownMs);
  }

  /**
   * @brief 这次失败要不要换模型、原因是什么（§5.4、§5.7）。
   * @return 要换时的原因；不换（server 重试用完、request、partial 等）为 null
   */
  private async failureOf(request: RequestState, result: AttemptResult,
    baseline: number | null): Promise<SwitchFailure | null> {
    if (result.timedOut) return this.timeoutFailure(request, baseline);
    const record = result.record;
    if (!record) return null;
    if (record.cls === 'partial') {
      const availability = this.host.layer.availabilityOf(request.ref);
      const until = availability.available ? null : availability.until;
      return { reason: 'connection', detail: REASON_TEXTS.connection(until), unconfirmed: false };
    }
    const unavailableHeld = record.cls === 'timeout' && record.sentAt === null;
    if (!SWITCH_CLASSES.has(record.cls) && !unavailableHeld) return null;
    if (record.cls === 'queue_timeout') {
      return { reason: 'queue_timeout', detail: REASON_TEXTS.queue_timeout(result.queueWaitMs), unconfirmed: false };
    }
    const availability = this.host.layer.availabilityOf(request.ref);
    if (!availability.available) {
      return { reason: availability.reason, detail: availabilityText(availability.reason, availability.until),
        unconfirmed: false };
    }
    const reason = record.cls as AvailabilityReason;
    return { reason, detail: availabilityText(reason, null), unconfirmed: false };
  }

  /**
   * @brief 发出后超时（§5.7）：cancel_verified 为真时记 timeout 立即换；为假时进入 held、读指标确认停下；
   *        unknown 时进入 held、等满再换（注明没能确认）。等待中你按停止即中止。
   */
  private async timeoutFailure(request: RequestState, baseline: number | null): Promise<SwitchFailure> {
    const { layer } = this.host;
    const pool = layer.getPool();
    const cancel = layer.profileOf(request.ref)?.cancel_verified ?? 'unknown';
    const now = Date.now();
    if (cancel === true) {
      pool.markModel(request.ref, 'timeout', now + layer.timings.timeoutCooldownMs);
      return { reason: 'timeout', detail: REASON_TEXTS.timeout(null), unconfirmed: false };
    }
    const until = now + layer.timings.heldMs;
    pool.markModel(request.ref, 'held', until);
    const confirmed = await this.waitHeld(request.ref, until, cancel === false ? baseline : null,
      request.options?.signal);
    if (confirmed) pool.clearModelRecord(request.ref);
    return { reason: 'timeout', detail: REASON_TEXTS.timeout(null), unconfirmed: !confirmed };
  }

  /**
   * @brief 等旧请求停下（§5.7）：有基线时每隔 §12 的间隔读一次服务端正在跑的请求数，回到基线或更低即确认；
   *        没有基线时等满 held 的时长。阶段行经 mori.model_wait（kind: held）显示。
   * @return 确认已停下
   */
  private async waitHeld(ref: ModelRef, until: number, baseline: number | null,
    signal: AbortSignal | undefined): Promise<boolean> {
    const wait = { kind: 'held' as const, model: ref };
    this.host.emit({ type: 'mori.model_wait', active: true, ...wait, reason: 'held', detail: REASON_TEXTS.held(until),
      until });
    try {
      if (baseline === null) {
        await delay(until - Date.now(), signal);
        return false;
      }
      while (Date.now() < until) {
        await delay(Math.min(this.host.layer.timings.heldPollMs, until - Date.now()), signal);
        const count = await this.runningRequests(ref, signal, false);
        if (count !== null && count <= baseline) return true;
      }
      return false;
    } finally {
      this.host.emit({ type: 'mori.model_wait', active: false, ...wait, reason: null, detail: '', until: null });
    }
  }

  /**
   * @brief 读服务端正在跑的请求数（§5.7 的基线与确认，探针第 9 步的指标）。
   * @param onlyUnverified 只对 cancel_verified 为 false 的模型读（发每次尝试之前的基线）
   * @return 读不到、或不需要读时为 null
   */
  private async runningRequests(ref: ModelRef, signal: AbortSignal | undefined,
    onlyUnverified: boolean): Promise<number | null> {
    const { layer } = this.host;
    const profile = layer.profileOf(ref);
    const found = layer.lookupModel(ref);
    if (!profile || !found || (onlyUnverified && profile.cancel_verified !== false)) return null;
    try {
      return await readRunningRequests({ getText: (url, getSignal) => layer.serverGet(ref, url, getSignal) },
        found.provider.baseUrl, profile.server.kind, signal ?? new AbortController().signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      console.error(`[kernel] cannot read the running requests of ${ref}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * @brief 换到新模型后的请求（§11.2 第 3 步）：§6 处理后的上下文，思考强度改为会话的强度按新模型收紧后的值
   *        （§7.7，resendReasoning；收紧后是 off 才不传）。
   *        末尾的工作卡先拿下、处理之后接回，卡片总在最后（平行 Agent 规格 §8.3）。
   */
  private retarget(request: RequestState, ref: ModelRef): RequestState {
    const model = this.host.physical(ref);
    const detached = detachWorkCard(request.context.messages);
    const messages = reattachWorkCard(this.host.processMessages(detached.messages), detached.card);
    const reasoning = resendReasoning(model, this.host.thinkingLevel(), this.host.piAi.clampThinkingLevel);
    const options: SimpleStreamOptions = { ...request.options, reasoning };
    return { model, context: { ...request.context, messages }, options, ref };
  }

  /** @brief 原样推进原函数的事件；没有结束事件时补一个错误，免得 pi 一直等。 */
  private passthrough(request: RequestState, result: AttemptResult, out: AssistantMessageEventStream): void {
    for (const event of result.events) out.push(event);
    const last = result.events[result.events.length - 1];
    if (last?.type !== 'done' && last?.type !== 'error') {
      this.pushError(request, out, 'The request ended without a response');
    }
  }

  /** @brief 已推进的事件没有以 done 或 error 结束时补一个错误。 */
  private finish(request: RequestState, result: AttemptResult, out: AssistantMessageEventStream): void {
    if (result.delivered && !result.terminal) this.pushError(request, out, 'The request ended without a response');
  }

  /** @brief 你按了停止（§11.2 第 4 步）：推一个 aborted 错误事件。 */
  private pushAborted(request: RequestState, result: AttemptResult | null, out: AssistantMessageEventStream): void {
    const start = result?.events.find((event) => event.type === 'start');
    const partial = start?.type === 'start' ? start.partial : null;
    out.push({ type: 'error', reason: 'aborted',
      error: syntheticMessage(request.model, partial, { stopReason: 'aborted', errorMessage: ABORTED_MESSAGE }) });
  }

  /** @brief 推一个错误事件（§11.2 第 5 步）。 */
  private pushError(request: RequestState, out: AssistantMessageEventStream, message: string): void {
    out.push({ type: 'error', reason: 'error',
      error: syntheticMessage(request.model, null, { stopReason: 'error', errorMessage: message }) });
  }

  /** @brief 包装自己出错（含等待中按了停止）：按停止或错误结束这次请求。 */
  private fail(request: RequestState, out: AssistantMessageEventStream, error: unknown): void {
    if (request.options?.signal?.aborted) {
      this.pushAborted(request, null, out);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] ${this.host.sessionId}: model layer request failed: ${message}`);
    this.pushError(request, out, message);
  }
}

/** @brief 一个会话的模型层接线（§5、§6、§11）。 */
export class ModelSession implements WrapperHost {
  /** pi 会话 id */
  readonly sessionId: string;
  /** 工作文件夹 */
  readonly cwd: string;
  /** 模型层 */
  readonly layer: ModelLayer;
  /** pi-ai 模块 */
  piAi!: PiAi;
  /** 调度类别（平行 Agent 规格 §12.10） */
  readonly schedClass: SchedClass;
  private pi!: Pi;
  private readonly emitEvent: (event: ModelEvent) => void;
  private readonly options: ModelSessionOptions;
  private manager: SessionManager | null = null;
  private session: AgentSession | null = null;
  private pick: ModelPick | null = null;
  private source: CandidateSource;
  private locked = false;
  private agentProblems: string[] = [];
  private project: ProjectContext | null = null;
  private candidates: readonly ModelRef[] = [];
  /** 取交集时去掉的候选（不在 within 里，平行 Agent 规格 §12.1），按角色的顺序 */
  private outside: readonly ModelRef[] = [];
  private check: StaticCheckResult = { blocked: null, first: null };
  private reply: ReplyState | null = null;
  private pendingSegment: number | null = null;
  private followUps: string[] = [];
  private restart: TaskRestart | null = null;
  private lastRestart: TaskRestart | null = null;
  private readonly removedRefs = new Set<ModelRef>();
  private readonly wakers = new Set<() => void>();
  private suppress = 0;
  private unsubscribe: (() => void) | null = null;
  private registered = false;
  private staticRun: Promise<void> = Promise.resolve();

  private constructor(options: ModelSessionOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.layer = options.layer;
    this.options = options;
    this.source = options.source ?? PICK_SOURCE;
    this.schedClass = options.schedClass ?? 'conversation';
    this.emitEvent = (event) => options.emit(event);
  }

  /**
   * @brief 建立会话接线：加载 pi 与 pi-ai，订阅模型层的变化，登记项目（Project access）。
   * @param options 模型层、会话 id、工作文件夹与 emit；角色会话另有候选来源、调度类别、种类与平行 Agent 的回调
   */
  static async create(options: ModelSessionOptions): Promise<ModelSession> {
    const self = new ModelSession(options);
    [self.pi, self.piAi] = await Promise.all([loadPi(), loadPiAi()]);
    self.unsubscribe = options.layer.onModelsChanged((change) => self.onModelsChanged(change));
    options.layer.registerProject(options.cwd);
    return self;
  }

  // ---- 选择范围与静态校验（§4.6、§5.1、§9.5） ----

  /**
   * @brief 读出会话的选择范围（§5.1）：有 mori.pick 时以最后一条为准；新会话记下 normalDefault；
   *        v0 的旧会话按最后一条助手消息或 normalDefault 并记下。然后做静态校验，并在后台检查候选的服务版本（§7.1）。
   * @param manager 会话的 SessionManager（createAgentSession 之前）
   * @param isNew 新建的会话
   */
  async loadPick(manager: SessionManager, isNew: boolean): Promise<void> {
    this.manager = manager;
    const recorded = this.recordedPick();
    const config = this.layer.getConfig();
    if (config) {
      const resolved = resolveSessionPick({ config, isNew, recordedPick: isNew ? null : recorded,
        lastAssistantRef: isNew ? null : lastAssistantRef(manager.buildSessionContext().messages) });
      this.pick = resolved.pick;
      if (resolved.record && resolved.pick !== null) this.writeEntry(MODEL_ENTRY_TYPES.pick, { pick: resolved.pick });
    } else {
      this.pick = recorded;
    }
    await this.refreshStatic();
    this.checkVersions();
  }

  /** @brief 会话文件里最后一条 mori.pick 的范围；没有时为 null。 */
  private recordedPick(): ModelPick | null {
    const entries = this.customEntries<PickEntryData>(MODEL_ENTRY_TYPES.pick);
    const last = entries[entries.length - 1];
    return typeof last?.pick === 'string' ? last.pick : null;
  }

  /** @brief 重新做静态校验（排队执行，最后一次为准）。 */
  private refreshStatic(): Promise<void> {
    const run = this.staticRun.then(() => this.computeStatic());
    this.staticRun = run.catch(() => undefined);
    return run;
  }

  /** @brief 读项目配置、按候选来源展开、按 §4.6 做静态校验（角色会话另按 requires 与要避开的模型族）。 */
  private async computeStatic(): Promise<void> {
    const project = await this.layer.projectContext(this.cwd);
    const { pick, candidates } = this.sourceCandidates(project);
    this.project = project;
    this.candidates = candidates ?? [];
    this.check = staticCheck({ ...this.layer.staticBase(project), pick, candidates, removedRefs: this.removedRefs,
      requires: this.requires(), avoidFamilies: this.avoidFamilies(), modelAction: this.modelAction(),
      agentProblems: this.agentProblems });
  }

  /**
   * @brief 按候选来源展开（平行 Agent 规格 §12.1）：你选的范围；角色的 models 依次展开、去重（没写时用会话的范围），
   *        within 给出时只留在它里面也有的、顺序按角色。
   * @return pick：静态校验的范围（null 为 no_pick；candidates 为 null 时是不存在的那个范围）；candidates：展开后的候选
   */
  private sourceCandidates(project: ProjectContext): Pick<StaticCheckInput, 'pick' | 'candidates'> {
    const source = this.source;
    const picks = source.kind === 'role' && source.models !== null ? source.models
      : this.pick === null ? null : [this.pick];
    if (picks === null || picks.length === 0) return { pick: null, candidates: null };
    const expanded = this.layer.expandPicksIn(project, picks);
    if (expanded.missing !== null) return { pick: expanded.missing, candidates: null };
    const within = source.kind === 'role' ? source.within?.() ?? null : null;
    if (within === null) return { pick: picks[0], candidates: expanded.refs };
    const kept = intersectCandidates(expanded.refs, within);
    this.outside = expanded.refs.filter((ref) => !kept.includes(ref));
    return { pick: picks[0], candidates: kept };
  }

  /** @brief 这个会话的能力要求：tool_calling ∪ 角色（或对话持有者）的 requires（平行 Agent 规格 §12.1）。 */
  private requires(): readonly Requirement[] {
    return this.source.requires ?? TOOL_CALLING;
  }

  /** @brief 这一刻要避开的模型族（differ_from: author，平行 Agent 规格 §12.9）；没有时为 undefined。 */
  private avoidFamilies(): ReadonlySet<string> | undefined {
    return this.source.kind === 'role' ? this.source.avoidFamilies?.() : undefined;
  }

  /**
   * @brief 拒绝启动卡上换模型的操作（平行 Agent 规格 §12.11）：你选范围的会话为 Change model；协作模式下的对话会话
   *        为 Turn off team mode；角色会话（实例）不提供。
   */
  private modelAction(): StaticCheckInput['modelAction'] {
    if (this.locked) return 'turn_off_team';
    return this.source.kind === 'pick' ? 'change_model' : null;
  }

  /** @brief 在后台检查候选的服务版本（§7.1，不挡打开）。 */
  private checkVersions(): void {
    void this.layer.checkVersions(this.candidates).catch((error: unknown) => {
      console.error(`[kernel] ${this.sessionId}: version check failed: ${(error as Error).message}`);
    });
  }

  /** @brief 模型层的配置、档案或 key 记录变了：叫醒等待中的选择，重新做静态校验并发 mori.model_state。 */
  private onModelsChanged(change: ModelsChange): void {
    for (const wake of [...this.wakers]) wake();
    if (change.kind === 'keys') return;
    if (change.kind === 'config' && this.reply) for (const ref of change.removedRefs) this.removedRefs.add(ref);
    this.refreshStatic().then(() => this.emitState(), (error: unknown) => {
      console.error(`[kernel] ${this.sessionId}: static check failed: ${(error as Error).message}`);
    });
  }

  /** @brief 会话被拒绝启动（§4.6）：发送不可用。 */
  isBlocked(): boolean {
    return this.check.blocked !== null;
  }

  /** @brief 会话的模型状态（§9.5）：当前模型 = 本段正在用的，没有段时是静态校验后的第一个候选。 */
  state(): ModelState {
    const current = this.reply?.current ?? this.check.first;
    const physical = current === null ? undefined : this.physicalOrUndefined(current);
    const level = this.thinkingLevel();
    return {
      pick: this.pick, current, blocked: this.check.blocked,
      thinkingLevel: physical ? this.piAi.clampThinkingLevel(physical, level) : level,
      thinkingLevels: physical ? this.piAi.getSupportedThinkingLevels(physical) : ['off'],
      reasoning: physical?.reasoning ?? false,
      // 只有协作模式下的对话会话锁定范围（平行 Agent 规格 §12.11，setTeamLock）；关闭模式下你可以选范围。
      pickLocked: this.locked,
    };
  }

  /** @brief 发 mori.model_state。 */
  emitState(): void {
    this.emit({ type: 'mori.model_state', ...this.state() });
  }

  /**
   * @brief 换选择范围（§5.10）：写一条 mori.pick，重新做静态校验，发 mori.model_state；调用方先确认会话空闲。
   *        协作模式下锁定时拒绝（平行 Agent 规格 §12.11），协作模式不写 mori.pick。
   * @param pick 选择范围
   */
  async setPick(pick: ModelPick): Promise<ModelState> {
    if (this.locked) throw new Error(PICK_LOCKED_MESSAGE);
    this.writeEntry(MODEL_ENTRY_TYPES.pick, { pick });
    this.pick = pick;
    await this.refreshStatic();
    this.checkVersions();
    this.emitState();
    return this.state();
  }

  /**
   * @brief 恢复对话、Undo 回到原来的分支之后由 rewind.ts 调用（文件系统规格 §5.8、§5.9）：在当前叶子之后把现在的
   *        选择范围再记一条 mori.pick（同 loadPick 的写法），重新打开会话时按当前分支最后一条读出的范围不变。
   *        协作模式下锁定时范围仍是你最后选的，照样记；还没有范围（no_pick）时没有可记的，不写。
   */
  recordPick(): void {
    if (this.pick !== null) this.writeEntry(MODEL_ENTRY_TYPES.pick, { pick: this.pick });
  }

  /**
   * @brief 范围菜单的各项（§9.2、§9.5 session.pickOptions），按这个会话的项目与能力要求做静态校验；
   *        协作模式下锁定时为空（平行 Agent 规格 §12.11）。
   */
  async pickOptions(): Promise<PickOptions> {
    const config = this.layer.getConfig();
    if (!config || this.locked) return { error: null, options: [] };
    const project = await this.layer.projectContext(this.cwd);
    const base = this.layer.staticBase(project);
    return { error: null, options: pickOptions({ config, projectGroups: project.project?.groups,
      exists: base.exists, zoneOf: base.zoneOf, allowedZones: base.allowedZones, toolCalling: base.toolCalling,
      requires: this.requires(), capabilities: base.capabilities, familyOf: base.familyOf }) };
  }

  // ---- 平行 Agent 与 TaskBoard 的接口（平行 Agent 规格 §4.4、§12.1、§12.4、§12.11） ----

  /**
   * @brief 协作模式改变时由 Team 调用（§12.1、§12.11）：换候选来源，设 pickLocked（对话会话在协作模式下为真），
   *        重新做静态校验并发 mori.model_state。范围仍是你最后选的（不写 mori.pick）。在对话会话空闲时调用：
   *        模式改变时它正在运行的，在这次运行结束后调用（正在进行的回合按它开始时的模式跑完，§5.1）。
   * @param locked 锁定范围
   * @param source 这个模式下的候选来源：协作模式下为对话持有者的 role 来源，关闭模式下为 pick 来源（带对话持有者的 requires）
   */
  async setTeamLock(locked: boolean, source: CandidateSource): Promise<ModelState> {
    this.locked = locked;
    this.source = source;
    await this.refreshStatic();
    this.checkVersions();
    this.emitState();
    return this.state();
  }

  /**
   * @brief 角色文件的问题（§4.4）：不为空时按 agents_invalid 拒绝启动、优先于其他原因，之后每次静态校验都保留它，
   *        直到传入空列表（Check again 通过）；重新做静态校验并发 mori.model_state。
   * @param problems 卡上逐条列出的问题；空列表表示没有问题
   */
  async setAgentProblems(problems: readonly string[]): Promise<ModelState> {
    this.agentProblems = [...problems];
    await this.refreshStatic();
    this.emitState();
    return this.state();
  }

  /** @brief 静态校验后展开的候选（§12.1：关闭模式下临时提问的 within 用对话会话的这一组），按顺序。 */
  candidateRefs(): readonly ModelRef[] {
    return [...this.candidates];
  }

  /**
   * @brief 取交集时去掉的候选（§12.1：关闭模式下临时提问只留对话会话也有的），按角色的顺序；
   *        交集为空时提问失败的工具结果逐个列出它们。没有 within 时为空。
   */
  outsideRefs(): readonly ModelRef[] {
    return [...this.outside];
  }

  /**
   * @brief 取出并清掉这个 task 会话上一次运行要求的重来（§12.4）：后台进程在 agent_settled 时读，不解析错误文字。
   * @return 重来的原模型、新模型与原因；没有时为 null
   */
  takeRestart(): TaskRestart | null {
    const restart = this.restart;
    this.restart = null;
    return restart;
  }

  // ---- 虚拟模型（§11.1） ----

  /**
   * @brief 注册会话的虚拟模型 mori/<会话 id>（全部七档思考强度；窗口、最大输出、输入取静态校验后的第一个候选），
   *        并等运行时刷新（K9）。
   * @return 交给 createAgentSession 的虚拟模型
   */
  async register(): Promise<Model<Api>> {
    const runtime = this.layer.getRuntime();
    const first = this.check.first ?? this.candidates[0] ?? null;
    const found = first === null ? null : this.layer.lookupModel(first);
    runtime.registerVirtualModel({
      provider: VIRTUAL_PROVIDER_ID, id: this.sessionId, name: VIRTUAL_MODEL_NAME, thinkingLevels: THINKING_LEVELS,
      contextWindow: found?.model.contextWindow ?? DEFAULT_WINDOW,
      maxTokens: found?.model.maxTokens ?? DEFAULT_MAX_TOKENS,
      input: found ? [...found.model.input] : ['text'],
      route: (request) => this.route(request),
    });
    this.registered = true;
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel(VIRTUAL_PROVIDER_ID, this.sessionId);
    if (!model) throw new Error(`The session model ${VIRTUAL_PROVIDER_ID}/${this.sessionId} was not registered`);
    return model;
  }

  /**
   * @brief 新会话的思考强度（§11.1）：第一个候选的 modelThinkingLevels → defaultThinkingLevel → medium。
   * @param settings 会话的 SettingsManager
   */
  newSessionThinking(settings: AgentSession['settingsManager']): ThinkingLevel {
    const first = this.check.first ?? this.candidates[0] ?? null;
    const split = first === null ? null : splitRef(first);
    const perModel = split ? settings.getModelThinkingLevel(split.providerId, split.modelId) : undefined;
    return perModel ?? settings.getDefaultThinkingLevel() ?? 'medium';
  }

  /**
   * @brief 会话创建后、第一次运行前装上流函数包装（K2），并关掉 pi 的 agent 级自动重试（K6）。
   * @param session pi 会话
   */
  attach(session: AgentSession): void {
    this.session = session;
    const wrapper = new StreamWrapper(this, session.agent.streamFunction);
    session.agent.streamFunction = (model, context, options) => wrapper.stream(model, context, options);
    this.disableRetry();
  }

  /** @brief 关掉 pi 的 agent 级自动重试（§5.5）：每次调 prompt、steer、followUp、compact 之前执行。 */
  disableRetry(): void {
    this.session?.settingsManager.applyOverrides({ retry: { enabled: false } });
  }

  /** @brief 会话关闭：取消订阅，注销虚拟模型并刷新运行时。 */
  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const wake of [...this.wakers]) wake();
    if (!this.registered) return;
    this.registered = false;
    const runtime = this.layer.getRuntime();
    try {
      runtime.unregisterVirtualModel(VIRTUAL_PROVIDER_ID, this.sessionId);
      await runtime.refresh({ allowNetwork: false });
    } catch (error) {
      console.error(`[kernel] cannot unregister the session model of ${this.sessionId}: ${(error as Error).message}`);
    }
  }

  // ---- 内联扩展（§6.1、§6.3、§11.3、§11.4、K12、K13） ----

  /**
   * @brief 交给 DefaultResourceLoader 的内联扩展：context 钩子、排队消息的 message_start、压缩前去掉被隐藏的过程
   *        与重来之前的消息（平行 Agent 规格 §12.4）。
   */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.on('context', (event) => ({ messages: this.processMessages(event.messages) }));
      pi.on('message_start', (event) => this.onMessageStart(event.message));
      pi.on('session_before_compact', (event) => {
        const restarts = this.restartEntries();
        stripForCompaction(event.preparation, this.switchEntries(), previousFileLists(event.branchEntries), restarts);
        forgetCompactionBeforeRestart(event.preparation, event.branchEntries, restarts);
      });
    };
  }

  /**
   * @brief 运行中 role 为 user 的 message_start（K13）：这段还没有 anchor 时它就是 anchor；
   *        与一条经 followUp 交给 pi 的文字相同（匹配一次即消费）时，记下待开始的新段。
   */
  private onMessageStart(message: AgentMessage): void {
    if (message.role !== 'user') return;
    const reply = this.reply;
    if (!reply) return;
    if (reply.anchorAt === null) {
      reply.anchorAt = message.timestamp;
      return;
    }
    const index = this.followUps.indexOf(messageText(message));
    if (index < 0) return;
    this.followUps.splice(index, 1);
    this.pendingSegment = message.timestamp;
  }

  /**
   * @brief 按 §6.1、§6.3 与重来（平行 Agent 规格 §12.4）处理发给模型的上下文（context 钩子与包装共用；对处理过的结果不变）。
   * @param messages AgentMessage 或 pi-ai Message
   * @param extra 还没写进会话的换模型条目（换模型时先按它判断接手）
   */
  processMessages<T extends MessageLike>(messages: readonly T[], extra?: ModelSwitchEntryData): T[] {
    const switches = extra ? [...this.switchEntries(), extra] : this.switchEntries();
    const restarted = applyRestartEntries(messages, this.restartEntries());
    return applyRebuildEntries(applySwitchEntries(restarted, switches), this.rebuildEntries());
  }

  /** @brief 会话当前分支上的一种自定义条目的数据，按写入顺序。 */
  private customEntries<T>(customType: string): T[] {
    const branch = this.session?.sessionManager.getBranch() ?? this.manager?.getBranch() ?? [];
    return branch.filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry as { data?: unknown }).data as T).filter((data) => data !== undefined && data !== null);
  }

  /** @brief 会话里的全部 mori.model_switch 条目。 */
  private switchEntries(): ModelSwitchEntryData[] {
    return this.customEntries<ModelSwitchEntryData>(MODEL_ENTRY_TYPES.modelSwitch);
  }

  /** @brief 会话里的全部 mori.rebuild 条目。 */
  private rebuildEntries(): RebuildEntryData[] {
    return this.customEntries<RebuildEntryData>(MODEL_ENTRY_TYPES.rebuild);
  }

  /** @brief 会话里的全部 mori.task_restart 条目（平行 Agent 规格 §12.4）。 */
  private restartEntries(): TaskRestartEntryData[] {
    return this.customEntries<TaskRestartEntryData>(MODEL_ENTRY_TYPES.taskRestart);
  }

  /** @brief 写一条自定义条目（pi 的 appendCustomEntry，§11.5）。 */
  private writeEntry(customType: string,
    data: PickEntryData | ModelSwitchEntryData | RebuildEntryData | TaskRestartEntryData): void {
    const manager = this.session?.sessionManager ?? this.manager;
    if (!manager) throw new Error(`Session ${this.sessionId} has no session manager`);
    manager.appendCustomEntry(customType, data);
  }

  // ---- 一段工作的开始与结束（§5.2、§11.4） ----

  /** @brief pi 开始运行（agent_start）：还没有段时（例如扩展发起的运行）建立一段。 */
  onAgentStart(): void {
    if (!this.reply) this.newReply(null);
  }

  /**
   * @brief 记下经 followUp 交给 pi 的一条文字（§11.4：排队消息开始新的一段）。
   * @param text pi 排队区里的全文（输入处理器、技能命令与提示词模板展开后），与 message_start 的文字比较
   */
  noteFollowUp(text: string): void {
    this.followUps.push(text);
  }

  /** @brief 一段结束（agent_settled，或 prompt() 结束时会话已不在运行）：清掉 ReplyState，发 mori.model_state。 */
  endReply(): void {
    if (!this.reply && this.pendingSegment === null) return;
    this.reply = null;
    this.pendingSegment = null;
    this.followUps = [];
    this.removedRefs.clear();
    this.emitState();
  }

  /** @brief 建立一段（startedAt 为此刻）。 */
  private newReply(anchorAt: number | null): ReplyState {
    this.reply = { startedAt: Date.now(), anchorAt, current: null, tried: new Map(), skipped: new Set() };
    return this.reply;
  }

  /** @brief 重建或压缩期间 pi 的压缩事件不转给界面（§6.3 第 1 步）。 */
  isSuppressed(eventType: string): boolean {
    return this.suppress > 0 && (eventType === 'compaction_start' || eventType === 'compaction_end');
  }

  /**
   * @brief 你发消息（或程序投递）时的准备中（§11.4 第 1–3 步）：建立 ReplyState，按 §5.3 选模型（§5.8 的等待在这里），
   *        做 §6.2 的接手判断、需要时 §6.3 重建。停止时以 AbortError 拒绝。选不到时另调 onUnavailable。
   * @param text 这条消息
   * @param signal 你按了停止
   * @param choice task 重来后继续的那一段（平行 Agent 规格 §12.4）：先试 prefer，这一段里不选 exclude；省略时从第一个候选起选
   */
  async prepare(text: string, signal: AbortSignal, choice: SegmentChoice = {}): Promise<PrepareResult> {
    const reply = this.newReply(null);
    this.excludeAtStart(reply, choice.exclude ?? []);
    const onAbort = (): void => this.session?.abortCompaction();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const excluded = await this.chooseAtStart(reply, text, signal, choice.prefer ?? null);
      if (!excluded) return { kind: 'ok' };
      this.notifyUnavailable(excluded, true);
      return { kind: 'unavailable', candidates: excluded };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @brief 这一段里不选的模型（§12.4：继续的那一段不选 from）：按它重来时的原因记进 tried。
   *        不是上一次重来的原模型时没有原因可记，记错误日志、不排除。
   */
  private excludeAtStart(reply: ReplyState, refs: readonly ModelRef[]): void {
    for (const ref of refs) {
      const restart = this.lastRestart;
      if (restart?.from === ref) reply.tried.set(ref, { reason: restart.reason, detail: restart.detail });
      else console.error(`[kernel] ${this.sessionId}: ${ref} is not the model of the last restart; not excluding it`);
    }
  }

  /**
   * @brief 段开始时选模型并做接手判断：接手不了的排除（no_handover）后重新选；有 prefer 时先试它（§12.4）。
   * @return 选到时为 null；选不到时为全部候选的原因
   */
  private async chooseAtStart(reply: ReplyState, text: string, signal: AbortSignal, prefer: ModelRef | null)
    : Promise<CandidateExclusion[] | null> {
    const refused = new Map<ModelRef, string>();
    for (;;) {
      const handover = (ref: ModelRef): { detail: string } | null => {
        const detail = refused.get(ref);
        return detail === undefined ? null : { detail };
      };
      const choose = (): SelectorResult => this.preferred(reply, prefer, handover)
        ?? select({ ...this.selectorInput(reply), handover });
      const result = await this.waitForModel(choose, reply, signal);
      if (result.model === null) return result.excluded;
      this.adopt(reply, result);
      const problem = await this.startHandover(result.model, text, signal);
      if (problem === null) return null;
      refused.set(result.model, problem);
      reply.current = null;
      reply.skipped = new Set();
    }
  }

  /**
   * @brief 先试的模型（§12.4：继续的那一段从新模型开始，不从第一个候选起）：它在这个会话的候选里、通过第 1–5 步与
   *        接手判断时选它。
   * @return 选中它的结果；没有 prefer 或它通不过时为 null（从第一个候选起选）
   */
  private preferred(reply: ReplyState, prefer: ModelRef | null,
    handover: (ref: ModelRef) => { detail: string } | null): SelectorResult | null {
    if (prefer === null || !this.candidates.includes(prefer)) return null;
    const result = select({ ...this.selectorInput(reply), candidates: [prefer], handover });
    return result.model === null ? null : { model: prefer, excluded: [] };
  }

  /**
   * @brief 段开始时的接手判断（§6.2 第一条）：任一条件不满足就重建，重建后窗口仍放不下就排除。
   * @return 能接手为 null；不能时为 no_handover 的界面文字
   */
  private async startHandover(ref: ModelRef, text: string, signal: AbortSignal): Promise<string | null> {
    const check = this.checkHandover(ref, this.startMessages(text));
    if (!check || handoverAction(check, 'start') === 'ok') return null;
    const failure = await this.rebuild(ref, signal);
    if (failure !== null) return REASON_TEXTS.no_handover(failure);
    const after = this.checkHandover(ref, this.startMessages(text));
    return after && handoverAction(after, 'rebuilt') === 'exclude' ? REASON_TEXTS.no_handover(null) : null;
  }

  /** @brief 段开始时的上下文：会话消息按 §6 处理，加上这条还没送进 pi 的消息。 */
  private startMessages(text: string): MessageLike[] {
    const messages: MessageLike[] = this.processMessages<MessageLike>(this.session?.messages ?? []);
    messages.push({ role: 'user', content: text, timestamp: Date.now() } as MessageLike);
    return messages;
  }

  /**
   * @brief 重建（§6.3）：调 pi 的 compact（由 B 生成摘要，压缩事件不转给界面，阶段行显示 Rebuilding），
   *        对话太短或刚压缩过时跳过；然后写 mori.rebuild 条目并发 mori.model_rebuild。
   * @return 成功为 null；压缩失败时为原文
   */
  private async rebuild(ref: ModelRef, signal: AbortSignal): Promise<string | null> {
    const session = this.session;
    if (!session) return null;
    this.emitWait({ active: true, kind: 'rebuild', model: ref, reason: null, detail: '', until: null });
    this.suppress += 1;
    let summary = true;
    try {
      this.disableRetry();
      await session.compact();
    } catch (error) {
      if (signal.aborted) throw abortError();
      const message = error instanceof Error ? error.message : String(error);
      if (!isNothingToCompact(message)) {
        console.error(`[kernel] ${this.sessionId}: rebuilding for ${ref} failed: ${message}`);
        return message;
      }
      summary = false;
    } finally {
      this.suppress -= 1;
      this.emitWait({ active: false, kind: 'rebuild', model: ref, reason: null, detail: '', until: null });
    }
    this.writeRebuild(ref, summary);
    return null;
  }

  /** @brief 写 mori.rebuild 条目、发 mori.model_rebuild（§6.3 第 2 步）。 */
  private writeRebuild(model: ModelRef, summary: boolean): void {
    const at = Date.now();
    this.writeEntry(MODEL_ENTRY_TYPES.rebuild, { model, at, summary });
    this.emit({ type: 'mori.model_rebuild', model, summary, at });
  }

  /** @brief 段开始时选定：current、跳过的候选，发 mori.model_state。 */
  private adopt(reply: ReplyState, result: SelectorResult): void {
    reply.current = result.model;
    reply.skipped = new Set(result.excluded.map((item) => item.ref));
    this.emitState();
  }

  // ---- route()（§11.1） ----

  /** @brief 虚拟模型的路由：每次请求前 pi 调用（不论原因）；思考强度返回 request.thinkingLevel。 */
  async route(request: ModelRouteRequest): Promise<ModelRoute> {
    const ref = request.reason === 'direct' ? this.routeDirect() : await this.routeTurn(request);
    return { model: this.physical(ref), thinkingLevel: request.thinkingLevel };
  }

  /**
   * @brief direct（压缩等，§6.4）：返回 ReplyState.current；没有段时按 §5.3 选，选不到不等待，
   *        抛出“No model available for compaction”（§5.8）。
   */
  private routeDirect(): ModelRef {
    const current = this.reply?.current ?? null;
    if (current !== null && this.layer.exists(current)) return current;
    const result = select(this.selectorInput());
    if (result.model !== null) return result.model;
    throw new Error(exhaustionText(result.excluded, true));
  }

  /**
   * @brief 回合里的请求：有待开始的新段先开始它；段内 current 仍在配置里且可用就继续用它，否则在 route() 里换模型；
   *        段刚开始（current 为空）时从第一个候选起选。
   */
  private async routeTurn(request: ModelRouteRequest): Promise<ModelRef> {
    if (this.pendingSegment !== null) {
      this.newReply(this.pendingSegment);
      this.pendingSegment = null;
    }
    const reply = this.reply ?? this.newReply(null);
    if (reply.current === null) return this.selectSegment(reply, request.messages, request.signal);
    const exclusion = checkCurrent(this.selectorInput(reply), reply.current);
    if (!exclusion) return reply.current;
    const failure: SwitchFailure = { reason: exclusion.reason, detail: exclusion.detail, unconfirmed: false };
    const switched = await this.switchFrom(reply.current, failure, request.messages, request.signal);
    // task 会话已有过程：路由失败让 pi 以这段错误文字结束这次运行（平行 Agent 规格 §12.4）
    if (switched.restart) throw new Error(MODEL_RESTART);
    if (switched.ref === null) throw new Error(exhaustionText(switched.excluded, false));
    return switched.ref;
  }

  /**
   * @brief 段开始（排队消息开始的新段）时选模型：从第一个候选起，做段内的接手判断（§6.2 第二条）；
   *        选不到时按 §5.8 等待，等不到发说明卡并抛出。
   */
  private async selectSegment(reply: ReplyState, messages: readonly MessageLike[],
    signal?: AbortSignal): Promise<ModelRef> {
    const strips = new Set<ModelRef>();
    const processed = this.processMessages(detachWorkCard(messages).messages);
    const handover = this.inReplyHandover(processed, strips);
    const result = await this.waitForModel(() => select({ ...this.selectorInput(reply), handover }), reply, signal);
    if (result.model === null) {
      this.reportUnavailable(result.excluded);
      throw new Error(exhaustionText(result.excluded, false));
    }
    this.adopt(reply, result);
    if (strips.has(result.model)) this.writeRebuild(result.model, false);
    return result.model;
  }

  /**
   * @brief 段内换模型（§5.6 第 2–4 步）：失败的模型记进 tried，在排在它之后的候选里选（做段内接手判断），
   *        写 mori.model_switch 条目、发事件，等 Date.now() 超过 hideUntil；选不到时按 §5.8 等待，等不到发说明卡。
   *        task 会话这一段已有助手消息或工具结果时改为重来（平行 Agent 规格 §12.4，restartFrom）。
   * @param from 失败的模型
   * @param failure 原因
   * @param messages 这次请求的上下文（算 hideUntil、做接手判断；末尾的工作卡不算进去，长度另按 extraContextTokens）
   * @param signal 你按了停止
   */
  async switchFrom(from: ModelRef, failure: SwitchFailure, messages: readonly MessageLike[],
    signal?: AbortSignal): Promise<SwitchResult> {
    const reply = this.reply ?? this.newReply(null);
    reply.tried.set(from, { reason: failure.reason, detail: failure.detail });
    const base = detachWorkCard(messages).messages;
    const entry: ModelSwitchEntryData = { from, to: '', reason: failure.reason, detail: failure.detail,
      unconfirmed: failure.unconfirmed, replyStartedAt: reply.startedAt, anchorAt: this.anchorOf(reply, base),
      hideUntil: hideUntilOf(base, reply.startedAt) };
    if (this.options.kind === 'task' && entry.hideUntil > entry.replyStartedAt) {
      return this.restartFrom(reply, entry, signal);
    }
    const strips = new Set<ModelRef>();
    const handover = this.inReplyHandover(this.processMessages(base, entry), strips);
    const result = await this.waitForModel(() => select({ ...this.selectorInput(reply), handover }), reply, signal);
    if (result.model === null) {
      this.reportUnavailable(result.excluded);
      return { ref: null, excluded: result.excluded, restart: false };
    }
    this.recordSwitch({ ...entry, to: result.model });
    if (strips.has(result.model)) this.writeRebuild(result.model, false);
    reply.current = result.model;
    this.emitState();
    await waitPast(entry.hideUntil, signal);
    return { ref: result.model, excluded: [], restart: false };
  }

  /**
   * @brief task 会话已有过程时换模型（平行 Agent 规格 §12.4）：新模型的窗口判断按重来之后的上下文（继续的消息 + 工作卡）算；
   *        选定后写 mori.model_switch（与普通模式相同），等 Date.now() 超过 hideUntil 再写 mori.task_restart（at 之前的
   *        消息都不再发给模型），记下 restart，由调用方以 MODEL_RESTART 结束这次运行。选不到时同普通模式。
   * @param reply 这一段（from 已记进 tried）
   * @param entry 这次换模型的条目（to 还没定）
   * @param signal 你按了停止
   */
  private async restartFrom(reply: ReplyState, entry: ModelSwitchEntryData,
    signal?: AbortSignal): Promise<SwitchResult> {
    const { from, reason, detail } = entry;
    const handover = (ref: ModelRef): { detail: string } | null => (this.restartFits({ from, to: ref, reason, detail })
      ? null : { detail: REASON_TEXTS.no_handover(null) });
    const result = await this.waitForModel(() => select({ ...this.selectorInput(reply), handover }), reply, signal);
    if (result.model === null) {
      this.reportUnavailable(result.excluded);
      return { ref: null, excluded: result.excluded, restart: false };
    }
    this.recordSwitch({ ...entry, to: result.model });
    await waitPast(entry.hideUntil, signal);
    const restart: TaskRestart = { from, to: result.model, reason, detail };
    this.writeEntry(MODEL_ENTRY_TYPES.taskRestart, { at: Date.now(), ...restart });
    this.restart = restart;
    this.lastRestart = restart;
    reply.current = result.model;
    this.emitState();
    return { ref: result.model, excluded: [], restart: true };
  }

  /**
   * @brief 重来之后的上下文放得进这个模型的窗口（§12.4）：继续的消息（restartText）与工作卡（extraContextTokens）的
   *        估算加最大输出不超过有效窗口；模型不在配置里时不在这里排除（第 1 步已排除）。
   * @param restart 这次重来（to 为正在判断的候选）
   */
  private restartFits(restart: TaskRestart): boolean {
    const target = this.handoverTarget(restart.to);
    if (!target) return true;
    const text = this.options.restartText?.(restart);
    const message = { role: 'user', content: text ?? '', timestamp: Date.now() } as unknown as AgentMessage;
    const tokens = (text === undefined ? 0 : this.pi.estimateTokens(message)) + this.extraTokens();
    return fitsWindow(tokens, target);
  }

  /**
   * @brief 这段 anchor 的时间戳：message_start 记下的；还没有时取上下文里 startedAt 之后的第一条用户消息（§11.4），
   *        再没有时为 startedAt。
   */
  private anchorOf(reply: ReplyState, messages: readonly MessageLike[]): number {
    if (reply.anchorAt !== null) return reply.anchorAt;
    const first = messages.find((message) => message.role === 'user' && typeof message.timestamp === 'number'
      && message.timestamp >= reply.startedAt);
    return first?.timestamp ?? reply.startedAt;
  }

  /** @brief 写 mori.model_switch 条目并发同名事件（§5.6 第 3 步、§6.1）。 */
  private recordSwitch(entry: ModelSwitchEntryData): void {
    this.writeEntry(MODEL_ENTRY_TYPES.modelSwitch, entry);
    this.emit({ type: 'mori.model_switch', from: entry.from, to: entry.to, reason: entry.reason, detail: entry.detail,
      hidden: entry.hideUntil > entry.replyStartedAt, unconfirmed: entry.unconfirmed, at: Date.now() });
  }

  // ---- 接手判断（§6.2） ----

  /** @brief 接手判断的目标模型：档案的 replay 与有效窗口，配置的最大输出。 */
  private handoverTarget(ref: ModelRef): HandoverTarget | null {
    const found = this.layer.lookupModel(ref);
    if (!found) return null;
    const profile = this.layer.profileOf(ref);
    return { provider: found.provider.id, api: found.provider.api, model: found.model.id,
      replay: profile?.reasoning.replay ?? 'unknown', effectiveWindow: profile?.context.effective
        ?? found.model.contextWindow, maxTokens: found.model.maxTokens };
  }

  /**
   * @brief 在处理后的上下文上做接手判断；窗口估算加上工作卡（平行 Agent 规格 §12.6）。模型不在配置里时为 null。
   * @param messages 处理后的上下文（不含工作卡）
   */
  private checkHandover(ref: ModelRef, messages: readonly MessageLike[]): HandoverCheck | null {
    const target = this.handoverTarget(ref);
    if (!target) return null;
    return handoverCheck({ messages, target, extraTokens: this.extraTokens(),
      estimateTokens: (message) => this.pi.estimateTokens(message as AgentMessage) });
  }

  /** @brief 每次请求加在上下文末尾的工作卡的 token 估算（§8.3、§12.6）；没有工作卡的会话为 0。 */
  private extraTokens(): number {
    return this.options.extraContextTokens?.() ?? 0;
  }

  /**
   * @brief 段内的接手判断（§6.2 第二条），给选择器第 6 步用：窗口放不下排除；只有推理字段不满足时记进 strips
   *        （选中它后只做 §6.3 第 2–3 步）。
   */
  private inReplyHandover(messages: readonly MessageLike[],
    strips: Set<ModelRef>): (ref: ModelRef) => { detail: string } | null {
    return (ref) => {
      const check = this.checkHandover(ref, messages);
      if (!check) return null;
      const action = handoverAction(check, 'in_reply');
      if (action === 'exclude') return { detail: REASON_TEXTS.no_handover(null) };
      if (action === 'strip') strips.add(ref);
      return null;
    };
  }

  // ---- 选择与等待（§5.3、§5.8） ----

  /**
   * @brief 选择器的输入：候选、第 1–4 步的查询（第 3 步含这个会话的能力要求与这一刻要避开的模型族）、项目允许的区域、
   *        这段（可以没有）。
   */
  private selectorInput(reply?: ReplyState): SelectorInput {
    const { layer } = this;
    return {
      candidates: this.candidates, exists: (ref) => layer.exists(ref), removedRefs: this.removedRefs,
      zoneOf: (ref) => layer.zoneOf(ref), allowedZones: this.project?.allowedZones ?? [],
      toolCalling: (ref) => layer.toolCallingOf(ref), requires: this.requires(),
      capabilities: (ref) => layer.capabilitiesOf(ref), avoidFamilies: this.avoidFamilies(),
      familyOf: (ref) => layer.familyOf(ref), availability: (ref) => layer.availabilityOf(ref), reply,
      now: Date.now(),
    };
  }

  /**
   * @brief 选不到模型时先等（§5.8）：阶段行显示最先恢复的那个候选的原因，在最早的恢复时刻、探针结束时、
   *        或每隔 §12 的间隔重新选，最长等 §12 的时长；只剩不会恢复的原因时不等。
   * @param choose 做一次选择
   * @param reply 这段（判断 tried、earlier）
   * @param signal 你按了停止（以 AbortError 拒绝）
   */
  private async waitForModel(choose: () => SelectorResult, reply: ReplyState,
    signal?: AbortSignal): Promise<SelectorResult> {
    const startedAt = Date.now();
    let result = choose();
    let waiting = false;
    try {
      while (result.model === null) {
        const wait = exhaustionWait({ excluded: result.excluded, availability: (ref) => this.layer.availabilityOf(ref),
          waitStartedAt: startedAt, now: Date.now(), timings: this.layer.timings,
          scope: { reply, candidates: this.candidates } });
        if (!wait) break;
        waiting = true;
        this.emitWait({ active: true, kind: 'model', model: null, reason: wait.first.reason, detail: wait.first.detail,
          until: wait.recoverAt });
        await this.sleepUntil(wait.recheckAt, signal);
        result = choose();
      }
    } finally {
      if (waiting) this.emitWait({ active: false, kind: 'model', model: null, reason: null, detail: '', until: null });
    }
    return result;
  }

  /** @brief 等到某个时刻；模型层有变化（探针结束、key 记录变化）时提前醒来；你按停止时以 AbortError 拒绝。 */
  private sleepUntil(at: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        signal?.removeEventListener('abort', onAbort);
      };
      const wake = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(wake, Math.max(0, at - Date.now()));
      this.wakers.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---- 小工具 ----

  /** @brief 有没有正在进行的一段。 */
  hasReply(): boolean {
    return this.reply !== null;
  }

  /** @brief 这次尝试的请求改写（平行 Agent 规格 §12.7）：问 ModelSessionOptions.shape；没有时为 null。 */
  shapeAttempt(attempt: ShapeAttempt): RequestShape | null {
    return this.options.shape?.(attempt) ?? null;
  }

  /** @brief 会话的思考强度（虚拟模型有全部七档，pi 不收紧；按实际模型收紧在每次请求时）。 */
  thinkingLevel(): ThinkingLevel {
    return (this.session?.thinkingLevel ?? 'medium') as ThinkingLevel;
  }

  /** @brief 运行时里的实际模型；不在时抛错。 */
  physical(ref: ModelRef): Model<Api> {
    const model = this.physicalOrUndefined(ref);
    if (!model) throw new Error(`${ref} is not in your model settings`);
    return model;
  }

  /** @brief 运行时里的实际模型；不在时为 undefined。 */
  private physicalOrUndefined(ref: ModelRef): Model<Api> | undefined {
    const split = splitRef(ref);
    return split ? this.layer.getRuntime().getPhysicalModel(split.providerId, split.modelId) : undefined;
  }

  /** @brief 发会话事件。 */
  emit(event: ModelEvent): void {
    this.emitEvent(event);
  }

  /** @brief 发 mori.model_wait。 */
  private emitWait(wait: Omit<WaitEvent, 'type'>): void {
    this.emit({ type: 'mori.model_wait', ...wait });
  }

  /**
   * @brief 发 mori.model_unavailable（§5.8）。
   * @param candidates 每个候选及原因
   * @param firstRequest 段开始时就选不到（消息没发出）
   * @param text 撤回的消息
   * @param queued 准备中又发的、一起撤回的消息
   */
  emitUnavailable(candidates: CandidateExclusion[], firstRequest: boolean, text: string | null = null,
    queued: string[] = []): void {
    this.emit({ type: 'mori.model_unavailable', candidates, firstRequest, text, queued });
  }

  /**
   * @brief 段内（route 开始的新段、换模型）候选耗尽、等完仍选不到：发说明卡，并调 onUnavailable（平行 Agent 规格 §12.5）。
   * @param candidates 每个候选及原因
   */
  private reportUnavailable(candidates: CandidateExclusion[]): void {
    this.emitUnavailable(candidates, false);
    this.notifyUnavailable(candidates, false);
  }

  /**
   * @brief 记错误日志并调 onUnavailable（平行 Agent 规格 §12.5，不解析错误文字）。
   * @param candidates 每个候选及原因
   * @param firstRequest 段开始时就选不到
   */
  private notifyUnavailable(candidates: CandidateExclusion[], firstRequest: boolean): void {
    const who = this.source.kind === 'role' ? `${this.sessionId} (${this.source.role})` : this.sessionId;
    console.error(`[kernel] ${who}: ${exhaustionText(candidates, false)}`);
    this.options.onUnavailable?.({ candidates, firstRequest });
  }
}
