// 按 key 的模型池（docs/specs/model-providers.md §8）：槽位、排队与优先级、不可用记录、发请求用的 fetch。
// key 的明文只放在这里的内存里，不写进日志、事件或记录（§4.1）。时刻与定时器可以注入，测试用假时钟（§12）。

import type { ApiType, KeyStatus, ModelProvider } from '../shared/models';
import {
  classifyResponse, classifyThrown, clearedByEndpointChange, earliestRecovery, failureEffect, isRecordActive,
  providerChange, type Classification, type UnavailableRecord,
} from './modelFailure';
import { MODEL_TIMINGS, type ModelTimings } from './modelTimings';
import type { AttemptRecord, Availability, AvailabilityReason, FailureClass, ModelRef, SchedClass } from './modelTypes';

/** @brief 交给模型池的一个 key：引用与明文（§4.1：明文只经进程通道交给后台进程）。 */
export interface PoolKeySecret {
  /** key 的引用，全局唯一 */
  ref: string;
  /** key 的明文 */
  secret: string;
}

/** @brief 模型池用的时钟与定时器；测试注入假时钟（§12）。 */
export interface PoolClock {
  /** 当前时刻（ms） */
  now(): number;
  /**
   * @brief 在 ms 毫秒后调用 callback。
   * @return 取消用的句柄
   */
  setTimeout(callback: () => void, ms: number): unknown;
  /** @brief 取消 setTimeout 返回的句柄。 */
  clearTimeout(handle: unknown): void;
}

/** @brief 建立模型池的选项；都可以省略。 */
export interface ModelPoolOptions {
  /** §12 的时长；省略时用 MODEL_TIMINGS */
  timings?: ModelTimings;
  /** 时钟与定时器；省略时用 Date.now 与全局定时器 */
  clock?: PoolClock;
  /** 真正发请求的 fetch；省略时每次调用全局的 fetch */
  fetch?: typeof globalThis.fetch;
  /** 错误日志；省略时写 console.error。不会收到 key 的明文 */
  log?: (line: string) => void;
}

/** @brief 排队的开始与结束（mori.model_queue，§8.2、§9.5）。 */
export interface QueueNotice {
  /** 开始排队为 true，出队为 false */
  active: boolean;
  /** 提供商 id */
  provider: string;
  /** 提供商名称 */
  providerName: string;
}

/** @brief 原地重试前的等待（mori.model_retry，§5.5、§9.5）。 */
export interface RetryNotice {
  /** 第几次重试（从 1 起） */
  attempt: number;
  /** 共几次 */
  max: number;
  /** 这次失败的 HTTP 状态 */
  status: number;
  /** 等多久再发（ms） */
  delayMs: number;
}

/** @brief 给一次模型请求建 fetch 的选项（§8.4、§11.2）。 */
export interface PoolFetchOptions {
  /** 请求的模型 <provider>/<model> */
  ref: ModelRef;
  /** 模型的接口类型，决定认证头的写法 */
  api: ApiType;
  /** 发起请求的会话（或探针、测试连接）的标识，只用于日志 */
  sessionKey: string;
  /** 调度类别 */
  cls: SchedClass;
  /** 你按停止的 signal：触发时出队、不再重试，分类 aborted */
  signal?: AbortSignal;
  /** 这次尝试的控制器的 signal（首个内容超时）：触发时分类 timeout */
  attemptSignal?: AbortSignal;
  /** key 的 Test 与用它的 Test connection（§8.3）：只用这个 key、不看它的记录、不换 key */
  keyRef?: string;
  /** 5xx 是否原地重试；测试连接为 false（§9.1）。省略时为 true */
  serverRetries?: boolean;
  /** @brief 每一次真正发出时调用（含换 key、原地重试，§8.4 第 3 步）。 */
  onSent?(): void;
  /** @brief 决定换 key 或原地重试之后、下一次发出之前调用：取槽位与重试的等待不计入首个内容时限（§5.4）。 */
  onPause?(): void;
  /** @brief 每次尝试的结果（§8.4 第 5 步）；2xx 的响应体非正常结束时再记一次。 */
  onRecord?(record: AttemptRecord): void;
  /** @brief 原地重试的每次等待之前调用（§5.5）。 */
  onRetryWait?(notice: RetryNotice): void;
  /** @brief 开始排队与出队时调用（§8.2）。 */
  onQueue?(notice: QueueNotice): void;
}

/** @brief 模型此刻不可用时 fetch 立即抛出的错误（§8.2），带记录里最先恢复的原因。 */
export class ModelUnavailableError extends Error {
  /** 最先恢复的原因 */
  readonly reason: AvailabilityReason;
  /** 恢复时刻（ms）；不会自己恢复的为 null */
  readonly until: number | null;

  /**
   * @param ref 模型
   * @param reason 最先恢复的原因
   * @param until 恢复时刻
   */
  constructor(ref: ModelRef, reason: AvailabilityReason, until: number | null) {
    super(`${ref} is unavailable: ${reason}${until === null ? '' : ` until ${new Date(until).toISOString()}`}`);
    this.name = 'ModelUnavailableError';
    this.reason = reason;
    this.until = until;
  }
}

/** 无 key 的提供商在占用表里的键（§8.1）。 */
const PSEUDO_SLOT = '';
/**
 * 队列排序：conversation > decision > subagent > task > background，严格优先（§8.2，平行 Agent 规格 §12.10；
 * subagent 见 docs/specs/subagent.md §5.4：不在 CAPPED_CLASSES、QUEUE_TIMEOUT_CLASSES 里，用满并发、等到有槽位为止）。
 */
const CLASS_RANK: Readonly<Record<SchedClass, number>> = {
  conversation: 0, decision: 1, subagent: 2, task: 3, background: 4,
};
/** 排队超时（换模型）只对这两类生效；task、background 排队等槽位是常态，不超时（平行 Agent 规格 §12.10）。 */
const QUEUE_TIMEOUT_CLASSES: ReadonlySet<SchedClass> = new Set<SchedClass>(['conversation', 'decision']);
/**
 * 在一个 key 上最多占（并发上限 − reservedSlots）个槽位的类别，留出的给 conversation、decision：严格优先只排等待的顺序，
 * 不打断已经发出的请求（平行 Agent 规格 §12.10、§15）。
 */
const CAPPED_CLASSES: ReadonlySet<SchedClass> = new Set<SchedClass>(['task', 'background']);
/** 换 key 的分类（§5.5）。 */
const KEY_CLASSES: readonly FailureClass[] = ['rate_limited', 'auth', 'quota'];

/** 拿到的槽位：哪个提供商、哪个 key（null 为无 key）。 */
interface Lease {
  /** 槽位所属的提供商 id */
  providerId: string;
  /** 用的 key 的引用；null 为无 key 的提供商（占 PSEUDO_SLOT） */
  keyRef: string | null;
  /** 这把 key 的明文，用来写认证头；无 key 时为 null */
  secret: string | null;
  /** 槽位是否已交还；release 只在为 false 时减占用，防止重复释放 */
  released: boolean;
  /** 这个槽位由 task、background 类别占用（另计在 cappedInFlight 里） */
  capped: boolean;
  /** 取槽位时提供商的配置代数；结果回来时代数变了，说明配置改过、记录清过，这次的结果不再写记录 */
  generation: number;
}

/** 一次 fetch 调用的上下文。 */
interface CallContext {
  /** 调用方给的选项（模型、调度类别、你按停止的 signal、尝试的 signal、指定的 key 等） */
  options: PoolFetchOptions;
  /** 从 options.ref 取出的提供商 id */
  providerId: string;
  /** pi 在 RequestInit 里给的 signal；单独触发时按你按停止处理，区别于 options.signal（你按停止） */
  initSignal: AbortSignal | undefined;
  /** 这次调用里得到 rate_limited、auth、quota 而换掉的 key：之后不再选它们，换 key 最多每个 key 一次（§5.5） */
  rotated: Set<string>;
}

/** 排队中的请求。 */
interface Waiter {
  /** 排队的调用 */
  ctx: CallContext;
  /** 入队时刻（ms）：同类别内先到先得，也是排队超时的起点 */
  enqueuedAt: number;
  /** 入队序号：类别和入队时刻都相同时决定先后 */
  seq: number;
  /** @brief 分到槽位时交出租约。 */
  resolve(lease: Lease): void;
  /** @brief 排队超时、中止、提供商被删除或不可用时拒绝。 */
  reject(error: unknown): void;
}

/** 一个提供商在池里的状态。 */
interface ProviderState {
  /** 提供商的配置；被删除或还未配置时为 null（不发放槽位） */
  config: ModelProvider | null;
  /** 这个提供商的 key 引用与明文，按配置顺序；空表示无 key 的提供商 */
  keys: PoolKeySecret[];
  /** 无 key 时那个槽位的不可用记录（有 key 时各 key 的记录在 keyRecords 里） */
  pseudo: UnavailableRecord | null;
  /** 整个提供商的不可用记录（连接失败等 scope 为 provider 的失败），挡住所有 key */
  connection: UnavailableRecord | null;
  /** 各槽位正在进行的请求数：键为 key 引用，无 key 时为 PSEUDO_SLOT（''）；为 0 时删除 */
  inFlight: Map<string, number>;
  /** 其中 task、background 类别的请求数，键同 inFlight；为 0 时删除 */
  cappedInFlight: Map<string, number>;
  /** 等槽位的请求，按 compareWaiters 的顺序出队 */
  queue: Waiter[];
  /** 配置代数：配置改变清除记录（改地址、接口、兼容选项、模型配置，删除提供商）时加 1 */
  generation: number;
}

/** 整理过的请求：认证头之外的部分在每次重发时不变。 */
interface PreparedRequest {
  /** 请求地址 */
  url: string;
  /** 调用方的 RequestInit（带上方法），每次发出时在此基础上换认证头 */
  init: RequestInit;
  /** 合并后的请求头（不含认证头） */
  headers: Headers;
  /** 请求体 */
  body: RequestInit['body'];
  /** 请求体为空或字符串时为 true：可以换 key 重发或原地重试；否则只发一次就把响应交还 */
  resendable: boolean;
}

/** 一次发出得到的、交还或继续处理的响应。 */
interface Sent {
  /** 交给调用方（或决定重发时丢弃）的响应 */
  response: Response;
  /** 这次响应的失败分类，决定换 key、原地重试或交还 */
  classification: Classification;
}

/** 写给调用方的一条记录里随尝试变化的部分。 */
type RecordFields = Omit<AttemptRecord, 'ref' | 'hadOutput'> & { hadOutput?: boolean };

/** @brief 取 <provider>/<model> 的提供商 id（第一个 / 之前）。 */
function providerOf(ref: ModelRef): string {
  const slash = ref.indexOf('/');
  return slash < 0 ? ref : ref.slice(0, slash);
}

/** @brief 取 signal 的中止原因作为抛出的错误；没有时用 AbortError。 */
function abortError(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError');
}

/** @brief 地址的 origin；写法不对时为 null。 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** @brief 什么也不做，用于吞掉取消流时的拒绝。 */
function ignore(): void {
  // 取消已结束的流会拒绝，无需处理
}

/**
 * @brief 改写认证头（§8.4 第 2 步）：OpenAI 两种接口写 Bearer，Anthropic 写 x-api-key，没有 key 时两个都删掉。
 * @param base 原请求头（含 pi 的占位 key）
 * @param api 接口类型
 * @param secret key 的明文；没有 key 的提供商为 null
 * @return 新的请求头
 */
export function authHeaders(base: Headers, api: ApiType, secret: string | null): Headers {
  const headers = new Headers(base);
  headers.delete('authorization');
  headers.delete('x-api-key');
  if (secret === null) return headers;
  if (api === 'anthropic-messages') headers.set('x-api-key', secret);
  else headers.set('authorization', `Bearer ${secret}`);
  return headers;
}

/** @brief 整理 fetch 的参数；请求体是字符串（或没有）时才能重发（§5.5）。 */
function prepareRequest(input: string | URL | Request, init: RequestInit | undefined): PreparedRequest {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const body = init?.body ?? request?.body ?? undefined;
  const method = init?.method ?? request?.method;
  const url = request ? request.url : String(input);
  return { url, init: { ...init, method }, headers, body, resendable: body === undefined || body === null
    || typeof body === 'string' };
}

/**
 * @brief 读错误响应的响应体，最多 max 字节（§8.4 第 3 步、§12）；超出的部分取消不读。
 * @param response 4xx、5xx 响应
 * @param max 最多读的字节数
 */
async function readLimited(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    size += chunk.value.byteLength;
  }
  if (size >= max) await reader.cancel().catch(ignore);
  const bytes = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - offset));
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** @brief 占用表里一个槽位减 1，为 0 时删除。 */
function decrement(counts: Map<string, number>, slot: string): void {
  const used = (counts.get(slot) ?? 1) - 1;
  if (used > 0) counts.set(slot, used);
  else counts.delete(slot);
}

/** @brief 队列顺序：（类别，入队时刻），同时入队的按先后。 */
function compareWaiters(a: Waiter, b: Waiter): number {
  return CLASS_RANK[a.ctx.options.cls] - CLASS_RANK[b.ctx.options.cls] || a.enqueuedAt - b.enqueuedAt || a.seq - b.seq;
}

/** @brief 默认时钟：Date.now 与全局定时器。 */
const SYSTEM_CLOCK: PoolClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** @brief 按 key 的模型池（§8）。同一个后台进程只建一个，所有会话、探针、测试连接共用。 */
export class ModelPool {
  private readonly timings: ModelTimings;
  private readonly clock: PoolClock;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: (line: string) => void;
  private readonly providers = new Map<string, ProviderState>();
  private readonly keyRecords = new Map<string, UnavailableRecord>();
  private readonly modelRecords = new Map<ModelRef, UnavailableRecord>();
  private readonly listeners = new Set<(status: Record<string, KeyStatus>) => void>();
  private lastKeyStatus = '{}';
  private seq = 0;

  /** @param options 时长、时钟、fetch 与日志；都可以省略 */
  constructor(options: ModelPoolOptions = {}) {
    this.timings = options.timings ?? MODEL_TIMINGS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.log = options.log ?? ((line) => console.error(`[kernel] model pool: ${line}`));
  }

  /**
   * @brief 用新的配置更新提供商（§8.2 最后一条、§8.3 恢复列）：地址、接口或兼容选项改变时清除相应记录，
   * 改了配置的模型清除 not_found，删掉的提供商连同它的记录一起去掉；之后按新的并发上限分配槽位。
   * @param providers 配置里的全部提供商
   */
  setProviders(providers: readonly ModelProvider[]): void {
    const ids = new Set(providers.map((provider) => provider.id));
    for (const [id, state] of this.providers) if (state.config && !ids.has(id)) this.dropProvider(id, state);
    for (const provider of providers) this.applyProvider(provider);
    this.emitKeyStatus();
    for (const id of this.providers.keys()) this.pump(id);
  }

  /**
   * @brief 设置一个提供商的 key（按使用顺序，含明文）。删掉的 key 的记录一起删除（§8.3：删除重加即清除）；
   * 从没有 key 到有 key 时清除“无 key”的 auth、quota；新加的 key 立即可用（§8.2）。
   * @param providerId 提供商 id
   * @param keys 全部 key，顺序就是使用顺序；空数组表示没有 key
   */
  setKeys(providerId: string, keys: readonly PoolKeySecret[]): void {
    const state = this.state(providerId);
    const next = new Set(keys.map((key) => key.ref));
    for (const key of state.keys) if (!next.has(key.ref)) this.keyRecords.delete(key.ref);
    if (state.keys.length === 0 && keys.length > 0 && state.pseudo && state.pseudo.state !== 'rate_limited') {
      state.pseudo = null;
    }
    state.keys = keys.map((key) => ({ ref: key.ref, secret: key.secret }));
    this.emitKeyStatus();
    this.pump(providerId);
  }

  /**
   * @brief 模型此刻是否可用（§8.3），供选择器第 4 步使用；不可用时给出记录里最先恢复的原因。
   * @param ref <provider>/<model>
   */
  availability(ref: ModelRef): Availability {
    const now = this.clock.now();
    const state = this.providers.get(providerOf(ref));
    const blockers: UnavailableRecord[] = [];
    if (state?.connection && isRecordActive(state.connection, now)) blockers.push(state.connection);
    const model = this.modelRecords.get(ref);
    if (model && isRecordActive(model, now)) blockers.push(model);
    const keys = state ? this.keysBlocker(state, now) : null;
    if (keys) blockers.push(keys);
    const first = earliestRecovery(blockers);
    return first ? { available: false, reason: first.state, until: first.until } : { available: true };
  }

  /** @brief 全部有效的 key 记录（mori.key_status、models.get 的 keyStatus）；没有 key 的提供商的“无 key”不在其中。 */
  keyStatus(): Record<string, KeyStatus> {
    const now = this.clock.now();
    const status: Record<string, KeyStatus> = {};
    for (const [ref, record] of this.keyRecords) {
      if (!isRecordActive(record, now)) continue;
      status[ref] = { state: record.state as KeyStatus['state'], until: record.until };
    }
    return status;
  }

  /**
   * @brief 订阅 key 记录的变化（设上、清除、到时刻恢复）。
   * @param listener 收到变化后的全部记录
   * @return 取消订阅
   */
  onKeyStatus(listener: (status: Record<string, KeyStatus>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @brief 清除一个 key 的 rate_limited、auth、quota（key 的 Test 或 Test connection 成功时，§8.3）。
   * @param providerId 提供商 id
   * @param keyRef key 的引用；null 为没有 key 的提供商的“无 key”
   */
  clearKeyRecord(providerId: string, keyRef: string | null): void {
    if (keyRef === null) this.state(providerId).pseudo = null;
    else this.keyRecords.delete(keyRef);
    this.emitKeyStatus();
    this.pump(providerId);
  }

  /**
   * @brief 记下发出后超时的模型（§5.7）：timeout 或 held，到时刻恢复。记录由调用方按档案的 cancel_verified 算出。
   * @param ref <provider>/<model>
   * @param state timeout 或 held
   * @param until 恢复时刻（ms）
   */
  markModel(ref: ModelRef, state: 'timeout' | 'held', until: number): void {
    this.modelRecords.set(ref, { state, until });
    this.pump(providerOf(ref));
  }

  /**
   * @brief 记下提供商级的不可用（§8.3）：包装判断出收到响应头之后、第一个有内容的事件之前连接中断时，
   *        把提供商记为 connection，到时刻恢复（§5.4）。
   * @param providerId 提供商 id
   * @param state 目前只有 connection
   * @param until 恢复时刻（ms）
   */
  markProvider(providerId: string, state: 'connection', until: number): void {
    this.state(providerId).connection = { state, until };
    this.emitKeyStatus();
    this.pump(providerId);
  }

  /**
   * @brief 清除一个模型的记录（例如 held 期间读指标确认旧请求已停）。
   * @param ref <provider>/<model>
   */
  clearModelRecord(ref: ModelRef): void {
    this.modelRecords.delete(ref);
    this.pump(providerOf(ref));
  }

  /**
   * @brief 一个提供商此刻占用的槽位数（全部 key 合计）。
   * @param providerId 提供商 id
   */
  inFlight(providerId: string): number {
    let total = 0;
    for (const used of this.providers.get(providerId)?.inFlight.values() ?? []) total += used;
    return total;
  }

  /**
   * @brief 一个提供商队列里的请求数。
   * @param providerId 提供商 id
   */
  queued(providerId: string): number {
    return this.providers.get(providerId)?.queue.length ?? 0;
  }

  /**
   * @brief 给一次模型请求建 fetch（§8.4），经 pi-ai 的 fetch 选项传入。
   * @param options 模型、接口、类别、两个 signal 与回调
   */
  createFetch(options: PoolFetchOptions): typeof globalThis.fetch {
    const poolFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const ctx: CallContext = { options, providerId: providerOf(options.ref), initSignal: init?.signal ?? undefined,
        rotated: new Set() };
      return this.run(ctx, prepareRequest(input, init));
    };
    return poolFetch as typeof globalThis.fetch;
  }

  // ---- 发请求（§8.4） ----

  /** @brief 一次 fetch 调用的全过程：取槽位、发出、换 key 或原地重试，交还最后一次的响应。 */
  private async run(ctx: CallContext, request: PreparedRequest): Promise<Response> {
    let retries = 0;
    for (;;) {
      const lease = await this.acquire(ctx);
      const sent = await this.sendOnce(ctx, request, lease);
      if (lease.keyRef !== null && KEY_CLASSES.includes(sent.classification.cls)) ctx.rotated.add(lease.keyRef);
      const step = this.nextStep(ctx, request, sent, retries);
      if (step === 'return') return sent.response;
      ctx.options.onPause?.();
      if (step === 'retry') {
        await this.retryWait(ctx, sent.response.status, retries);
        retries += 1;
      } else {
        this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) key ${lease.keyRef} got `
          + `${sent.classification.cls}; sending with the next key`);
      }
    }
  }

  /**
   * @brief 一次尝试之后：换 key（§5.5）、原地重试，或把响应交还。
   *        只换到这次调用还没换掉的、此刻可用的 key；没有时交还，由包装换模型（§5.6）。
   */
  private nextStep(ctx: CallContext, request: PreparedRequest, sent: Sent, retries: number): 'return' | 'rotate'
    | 'retry' {
    const { cls } = sent.classification;
    if (!request.resendable) return 'return';
    if (KEY_CLASSES.includes(cls) && ctx.options.keyRef === undefined
      && this.hasUsableKey(ctx.providerId, ctx.rotated)) {
      return 'rotate';
    }
    const max = this.timings.serverRetryDelaysMs.length;
    if (cls === 'server' && ctx.options.serverRetries !== false && retries < max) return 'retry';
    return 'return';
  }

  /** @brief 原地重试前发 onRetryWait，再等 §12 的间隔；等待中按停止即中止。 */
  private async retryWait(ctx: CallContext, status: number, retries: number): Promise<void> {
    const delays = this.timings.serverRetryDelaysMs;
    const delayMs = delays[retries];
    ctx.options.onRetryWait?.({ attempt: retries + 1, max: delays.length, status, delayMs });
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) HTTP ${status}; retry ${retries + 1}/${delays.length} `
      + `in ${delayMs} ms`);
    await new Promise<void>((resolve, reject) => {
      const signals = this.signalsOf(ctx);
      const onAbort = (): void => {
        this.clock.clearTimeout(timer);
        signals.forEach((signal) => signal.removeEventListener('abort', onAbort));
        reject(this.abortFailure(ctx));
      };
      const timer = this.clock.setTimeout(() => {
        signals.forEach((signal) => signal.removeEventListener('abort', onAbort));
        resolve();
      }, delayMs);
      signals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
      if (this.abortKind(ctx)) onAbort();
    });
  }

  /** @brief 发出一次（§8.4 第 2–4 步）：改写认证头、发出、读错误响应体并分类，或包装 2xx 的响应体。 */
  private async sendOnce(ctx: CallContext, request: PreparedRequest, lease: Lease): Promise<Sent> {
    const { headers, signal } = this.beginSend(ctx, request, lease);
    const sentAt = this.clock.now();
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, { ...request.init, headers, body: request.body, signal });
    } catch (error) {
      throw this.thrownFailure(ctx, lease, { error, sentAt, afterHeaders: false });
    }
    if (response.status >= 400) return this.readFailure(ctx, response, lease, sentAt);
    const classification = classifyResponse({ status: response.status, headers: response.headers, body: '',
      now: this.clock.now() });
    this.record(ctx, { keyRef: lease.keyRef, cls: 'ok', status: response.status,
      retryAfterMs: classification.retryAfterMs, sentAt });
    return { response: this.wrapBody(ctx, response, lease, sentAt), classification };
  }

  /**
   * @brief 发出前的准备：确认 key 只发往它所属提供商的地址（§4.1），写认证头、合并 signal、调用 onSent。
   *        任何一步失败都释放槽位、记 request（没有发出）再抛出，槽位不会泄漏。
   */
  private beginSend(ctx: CallContext, request: PreparedRequest, lease: Lease): { headers: Headers;
    signal: AbortSignal | undefined; } {
    if (lease.secret !== null && this.wrongOrigin(ctx.providerId, request.url)) {
      this.notSent(ctx, lease, `${originOf(request.url) ?? 'an invalid URL'} is not the saved base URL of `
        + `${ctx.providerId}`);
      throw new Error(`The base URL of ${ctx.providerId} changed; the request was not sent`);
    }
    let headers: Headers;
    try {
      headers = authHeaders(request.headers, ctx.options.api, lease.secret);
    } catch {
      // Headers 的错误原文可能带着整个头值（即 key 的明文），不记录、不转交
      this.notSent(ctx, lease, `key ${lease.keyRef} cannot be written into a header`);
      throw new Error(`The API key ${lease.keyRef} contains characters that cannot be sent in a header`);
    }
    try {
      const signals = this.signalsOf(ctx);
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
      ctx.options.onSent?.();
      return { headers, signal };
    } catch (error) {
      this.notSent(ctx, lease, `cannot start the request: ${String(error)}`);
      throw error;
    }
  }

  /** @brief 请求的 origin 与 key 所属提供商当前保存的地址不同（保存改地址的过程中，§4.1）；写法不对也算不同。 */
  private wrongOrigin(providerId: string, url: string): boolean {
    const base = this.providers.get(providerId)?.config?.baseUrl;
    const origin = originOf(url);
    return base === undefined || origin === null || origin !== originOf(base);
  }

  /** @brief 拿到槽位后没有发出：释放槽位、记 request、写日志（不含 key 的明文）。 */
  private notSent(ctx: CallContext, lease: Lease, reason: string): void {
    this.release(lease);
    this.record(ctx, { keyRef: lease.keyRef, cls: 'request', status: null, retryAfterMs: null, sentAt: null });
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) not sent: ${reason}`);
  }

  /** @brief 4xx、5xx：先读响应体（最多 64 KB），分类、写不可用记录后再释放槽位，最后用同样的状态、头和文字造一个响应。 */
  private async readFailure(ctx: CallContext, response: Response, lease: Lease, sentAt: number): Promise<Sent> {
    let text = '';
    try {
      text = await readLimited(response, this.timings.errorBodyMaxBytes);
    } catch (error) {
      if (this.abortKind(ctx)) throw this.thrownFailure(ctx, lease, { error, sentAt, afterHeaders: true });
      this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) cannot read the HTTP ${response.status} body: `
        + `${String(error)}`);
    }
    const classification = classifyResponse({ status: response.status, headers: response.headers, body: text,
      now: this.clock.now() });
    this.applyEffect(ctx, lease, classification);
    this.release(lease);
    this.record(ctx, { keyRef: lease.keyRef, cls: classification.cls, status: response.status,
      retryAfterMs: classification.retryAfterMs, sentAt });
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) key ${lease.keyRef} HTTP ${response.status} `
      + `(${classification.cls})`);
    const rebuilt = new Response(text, { status: response.status, statusText: response.statusText,
      headers: response.headers });
    return { response: rebuilt, classification };
  }

  /** @brief 2xx：把响应体包一层，读到结尾、被取消、出错或请求被中止时释放槽位（§8.1、§8.4 第 4 步）。 */
  private wrapBody(ctx: CallContext, response: Response, lease: Lease, sentAt: number): Response {
    if (!response.body) {
      this.release(lease);
      return response;
    }
    const reader = response.body.getReader();
    const signals = this.signalsOf(ctx);
    let ended = false;
    let delivered = false;
    const end = (failure: { error: unknown } | null): void => {
      if (ended) return;
      ended = true;
      signals.forEach((signal) => signal.removeEventListener('abort', onAbort));
      this.release(lease);
      if (failure) this.bodyFailure(ctx, lease, { error: failure.error, sentAt, delivered });
    };
    const onAbort = (): void => end({ error: null });
    signals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            end(null);
            controller.close();
          } else {
            delivered = true;
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          end({ error });
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        end(null);
        await reader.cancel(reason).catch(ignore);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /** @brief 2xx 的响应体非正常结束：按停止、尝试超时或中断（partial）再记一次。 */
  private bodyFailure(ctx: CallContext, lease: Lease, facts: { error: unknown; sentAt: number; delivered: boolean })
    : void {
    const kind = this.abortKind(ctx);
    const { cls } = classifyThrown({ error: facts.error, userAborted: kind === 'user',
      attemptAborted: kind === 'attempt', afterHeaders: true });
    if (cls !== 'aborted') {
      this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) response body ended early (${cls}): `
        + `${String(facts.error)}`);
    }
    this.record(ctx, { keyRef: lease.keyRef, cls, status: null, retryAfterMs: null, sentAt: facts.sentAt,
      hadOutput: facts.delivered });
  }

  /** @brief 没有拿到可分类响应的尝试：分类、写记录（connection 记在提供商上）、释放槽位，返回要抛出的错误。 */
  private thrownFailure(ctx: CallContext, lease: Lease,
    facts: { error: unknown; sentAt: number; afterHeaders: boolean }): unknown {
    const kind = this.abortKind(ctx);
    const classification = classifyThrown({ error: facts.error, userAborted: kind === 'user',
      attemptAborted: kind === 'attempt', afterHeaders: facts.afterHeaders });
    this.applyEffect(ctx, lease, classification);
    this.release(lease);
    this.record(ctx, { keyRef: lease.keyRef, cls: classification.cls, status: null, retryAfterMs: null,
      sentAt: facts.sentAt });
    if (classification.cls !== 'aborted') {
      this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) request failed (${classification.cls}): `
        + `${String(facts.error)}`);
    }
    return facts.error;
  }

  // ---- 槽位与排队（§8.1、§8.2） ----

  /** @brief 取槽位与 key：不可用时立即失败，有空槽位就占上，否则排队。 */
  private acquire(ctx: CallContext): Promise<Lease> {
    if (this.abortKind(ctx)) return Promise.reject(this.abortFailure(ctx));
    const { keyRef, ref } = ctx.options;
    if (keyRef === undefined) {
      const availability = this.callAvailability(ctx);
      if (!availability.available) return Promise.reject(this.unavailableFailure(ctx, availability));
    } else if (!this.state(ctx.providerId).keys.some((key) => key.ref === keyRef)) {
      this.record(ctx, { keyRef, cls: 'request', status: null, retryAfterMs: null, sentAt: null });
      this.log(`${ref} (${ctx.options.sessionKey}) key ${keyRef} is not saved`);
      return Promise.reject(new Error(`Key ${keyRef} is not saved for ${ctx.providerId}`));
    }
    const lease = this.tryTake(ctx.providerId, { forced: keyRef, exclude: ctx.rotated, cls: ctx.options.cls });
    return lease ? Promise.resolve(lease) : this.enqueue(ctx);
  }

  /**
   * @brief 排队（§8.2）：conversation、decision 到时限即 queue_timeout，task、background 不限；按停止只让这个请求出队。
   */
  private enqueue(ctx: CallContext): Promise<Lease> {
    const state = this.state(ctx.providerId);
    const notice = (active: boolean): void => ctx.options.onQueue?.({ active, provider: ctx.providerId,
      providerName: state.config?.name ?? ctx.providerId });
    return new Promise<Lease>((resolve, reject) => {
      const signals = this.signalsOf(ctx);
      let timer: unknown;
      const finish = (): void => {
        signals.forEach((signal) => signal.removeEventListener('abort', onAbort));
        if (timer !== undefined) this.clock.clearTimeout(timer);
        state.queue = state.queue.filter((item) => item !== waiter);
        notice(false);
      };
      const waiter: Waiter = {
        ctx, enqueuedAt: this.clock.now(), seq: this.seq++,
        resolve: (lease) => { finish(); resolve(lease); },
        reject: (error) => { finish(); reject(error); },
      };
      const onAbort = (): void => waiter.reject(this.abortFailure(ctx));
      signals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
      if (QUEUE_TIMEOUT_CLASSES.has(ctx.options.cls)) {
        timer = this.clock.setTimeout(() => waiter.reject(this.queueTimeoutFailure(ctx, waiter.enqueuedAt)),
          this.timings.queueTimeoutMs);
      }
      state.queue.push(waiter);
      notice(true);
    });
  }

  /**
   * @brief 按（类别，入队时刻）给排队的请求分配槽位；排队中模型变得不可用的请求立即失败（§8.2）。
   * 没有指定 key 的请求用的是同一组 key，前面的拿不到时后面的也拿不到，所以严格优先自然成立；留出的槽位只有
   * conversation、decision 能用，它们本来就排在 task、background 前面。
   */
  private pump(providerId: string): void {
    const state = this.providers.get(providerId);
    if (!state || state.queue.length === 0) return;
    for (const waiter of [...state.queue].sort(compareWaiters)) {
      const { keyRef } = waiter.ctx.options;
      if (keyRef === undefined) {
        const availability = this.callAvailability(waiter.ctx);
        if (!availability.available) {
          waiter.reject(this.unavailableFailure(waiter.ctx, availability));
          continue;
        }
      }
      const lease = this.tryTake(providerId, { forced: keyRef, exclude: waiter.ctx.rotated,
        cls: waiter.ctx.options.cls });
      if (lease) waiter.resolve(lease);
    }
  }

  /**
   * @brief 按 key 的顺序取第一个可用且有空槽位的 key（§8.2）；指定了 key 时只看它、不看它的记录。
   *        task、background 类别在一个 key 上最多占（并发上限 − reservedSlots）个、至少 1 个（平行 Agent 规格 §12.10）。
   * @param providerId 提供商 id
   * @param want forced：指定的 key（key 的 Test），没有时为 undefined；exclude：这次调用里已经换掉的 key，不再选（§5.5）；
   *        cls：调度类别
   */
  private tryTake(providerId: string,
    want: { forced: string | undefined; exclude: ReadonlySet<string>; cls: SchedClass }): Lease | null {
    const state = this.providers.get(providerId);
    if (!state?.config) return null;
    const now = this.clock.now();
    const candidates: (string | null)[] = want.forced !== undefined ? [want.forced]
      : this.slotKeys(state).filter((keyRef) => !(keyRef !== null && want.exclude.has(keyRef))
        && !isRecordActive(this.keyRecordOf(state, keyRef), now));
    const capped = CAPPED_CLASSES.has(want.cls);
    for (const keyRef of candidates) {
      const slot = keyRef ?? PSEUDO_SLOT;
      if (!this.slotFree(state, slot, capped)) continue;
      const secret = keyRef === null ? null : state.keys.find((key) => key.ref === keyRef)?.secret;
      if (secret === undefined) continue;
      state.inFlight.set(slot, (state.inFlight.get(slot) ?? 0) + 1);
      if (capped) state.cappedInFlight.set(slot, (state.cappedInFlight.get(slot) ?? 0) + 1);
      return { providerId, keyRef, secret, released: false, capped, generation: state.generation };
    }
    return null;
  }

  /**
   * @brief 一个槽位此刻能否再接一个请求：没到并发上限；task、background 另外不超过（并发上限 − reservedSlots）、至少 1 个。
   * @param state 提供商的状态（config 不为 null）
   * @param slot key 引用或 PSEUDO_SLOT
   * @param capped 请求是 task、background 类别
   */
  private slotFree(state: ProviderState, slot: string, capped: boolean): boolean {
    const limit = state.config?.concurrency ?? 0;
    if ((state.inFlight.get(slot) ?? 0) >= limit) return false;
    if (!capped) return true;
    return (state.cappedInFlight.get(slot) ?? 0) < Math.max(1, limit - this.timings.reservedSlots);
  }

  /**
   * @brief 这次调用此刻能否发出：模型的可用性，再去掉这次调用里已经换掉的 key（§5.5）。
   *        没换过 key 时就是 availability；换过而剩下的 key 都有有效记录时，以其中最先恢复的原因不可用。
   */
  private callAvailability(ctx: CallContext): Availability {
    const availability = this.availability(ctx.options.ref);
    if (!availability.available || ctx.rotated.size === 0) return availability;
    const now = this.clock.now();
    const rest = this.state(ctx.providerId).keys.filter((key) => !ctx.rotated.has(key.ref))
      .map((key) => this.keyRecords.get(key.ref) ?? null);
    const active = rest.filter((record): record is UnavailableRecord => isRecordActive(record, now));
    const first = active.length === rest.length ? earliestRecovery(active) : null;
    return first ? { available: false, reason: first.state, until: first.until } : availability;
  }

  /** @brief 释放槽位（只释放一次），然后给排队的请求分配。 */
  private release(lease: Lease): void {
    if (lease.released) return;
    lease.released = true;
    const state = this.providers.get(lease.providerId);
    if (!state) return;
    const slot = lease.keyRef ?? PSEUDO_SLOT;
    decrement(state.inFlight, slot);
    if (lease.capped) decrement(state.cappedInFlight, slot);
    this.pump(lease.providerId);
  }

  // ---- 不可用记录（§8.3） ----

  /**
   * @brief 按分类写记录：key 级的记在用的 key（或“无 key”）上，connection 记在提供商上，not_found 记在模型上；
   * 之后排队中因此不可用的请求立即失败（§8.2）。请求发出后配置改过（代数变了）、或用的 key 已删掉时，
   * 结果只记给调用方，不写记录：新的地址或 key 还没试过。
   */
  private applyEffect(ctx: CallContext, lease: Lease, classification: Classification): void {
    const now = this.clock.now();
    const effect = failureEffect(classification, now, this.timings);
    if (!effect) return;
    const state = this.state(ctx.providerId);
    if (lease.generation !== state.generation || !state.config) {
      this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) ignored a stale ${classification.cls} result: `
        + 'config changed');
      return;
    }
    const { keyRef } = lease;
    if (effect.scope === 'key' && keyRef !== null && !state.keys.some((key) => key.ref === keyRef)) return;
    if (effect.scope === 'key' && keyRef === null && state.keys.length > 0) return;
    if (effect.scope === 'provider') state.connection = effect.record;
    else if (effect.scope === 'model') this.modelRecords.set(ctx.options.ref, effect.record);
    else if (keyRef === null) state.pseudo = effect.record;
    else this.keyRecords.set(keyRef, effect.record);
    if (effect.scope === 'key') this.scheduleRecovery(ctx.providerId, effect.record);
    this.emitKeyStatus();
    this.pump(ctx.providerId);
  }

  /**
   * @brief 在 key 记录的恢复时刻通知订阅者并分配排队请求；定时器早到时（定时器与 now() 的毫秒取整不同）再等一次。
   *        被替换或删除的记录仍带着自己的恢复时刻，到时刻后同样停止。
   */
  private scheduleRecovery(providerId: string, record: UnavailableRecord): void {
    if (record.until === null) return;
    const until = record.until;
    this.clock.setTimeout(() => {
      if (isRecordActive(record, this.clock.now())) {
        this.scheduleRecovery(providerId, record);
        return;
      }
      this.emitKeyStatus();
      this.pump(providerId);
    }, Math.max(1, until - this.clock.now()));
  }

  /** @brief 全部 key 都有有效记录时，给出其中最先恢复的一条；没有 key 的提供商看它的“无 key”。 */
  private keysBlocker(state: ProviderState, now: number): UnavailableRecord | null {
    const records = this.slotKeys(state).map((keyRef) => this.keyRecordOf(state, keyRef));
    const active = records.filter((record): record is UnavailableRecord => isRecordActive(record, now));
    return active.length === records.length ? earliestRecovery(active) : null;
  }

  /**
   * @brief 是否还有这次调用没换掉、也不在 rate_limited、auth、quota 里的 key（换 key 的前提，§5.5）；
   *        没有 key 的提供商没有可换的。
   * @param providerId 提供商 id
   * @param exclude 这次调用里已经换掉的 key
   */
  private hasUsableKey(providerId: string, exclude: ReadonlySet<string>): boolean {
    const state = this.state(providerId);
    const now = this.clock.now();
    return state.keys.some((key) => !exclude.has(key.ref) && !isRecordActive(this.keyRecords.get(key.ref), now));
  }

  /** @brief 一个提供商的 key 按顺序；没有 key 时是唯一的“无 key”（null）。 */
  private slotKeys(state: ProviderState): (string | null)[] {
    return state.keys.length > 0 ? state.keys.map((key) => key.ref) : [null];
  }

  /** @brief 一个 key（或“无 key”）的记录。 */
  private keyRecordOf(state: ProviderState, keyRef: string | null): UnavailableRecord | null {
    return keyRef === null ? state.pseudo : this.keyRecords.get(keyRef) ?? null;
  }

  /** @brief 配置更新一个提供商：地址、接口、兼容选项改变时清除相应记录，改了配置的模型清除 not_found（§8.3）。 */
  private applyProvider(next: ModelProvider): void {
    const state = this.state(next.id);
    const previous = state.config;
    state.config = next;
    if (!previous) return;
    const change = providerChange(previous, next);
    if (change.endpoint) this.clearEndpointRecords(next.id, state);
    if (change.changedModels.length > 0) state.generation += 1;
    for (const modelId of change.changedModels) {
      const ref = `${next.id}/${modelId}`;
      if (this.modelRecords.get(ref)?.state === 'not_found') this.modelRecords.delete(ref);
    }
  }

  /** @brief 地址、接口或兼容选项改变：清除 key 与“无 key”的 auth、quota，提供商的 connection，模型的 not_found。 */
  private clearEndpointRecords(providerId: string, state: ProviderState): void {
    state.generation += 1;
    const refs = new Set([...state.keys.map((key) => key.ref), ...(state.config?.keys ?? []).map((key) => key.ref)]);
    for (const ref of refs) {
      const record = this.keyRecords.get(ref);
      if (record && clearedByEndpointChange(record.state)) this.keyRecords.delete(ref);
    }
    if (state.pseudo && clearedByEndpointChange(state.pseudo.state)) state.pseudo = null;
    state.connection = null;
    for (const [ref, record] of this.modelRecords) {
      if (providerOf(ref) === providerId && clearedByEndpointChange(record.state)) this.modelRecords.delete(ref);
    }
  }

  /**
   * @brief 配置里删掉的提供商：去掉它的 key 与全部记录；排队中的请求立即失败、不发出（§4.7、§8.2），
   *        由包装看到模型已不在配置里而按 missing 换模型。
   */
  private dropProvider(providerId: string, state: ProviderState): void {
    for (const key of state.keys) this.keyRecords.delete(key.ref);
    for (const ref of [...this.modelRecords.keys()]) if (providerOf(ref) === providerId) this.modelRecords.delete(ref);
    state.config = null;
    state.keys = [];
    state.pseudo = null;
    state.connection = null;
    state.generation += 1;
    for (const waiter of [...state.queue]) waiter.reject(this.removedFailure(waiter.ctx));
  }

  /** @brief key 的记录变了就通知订阅者（内容相同时不重复通知）。 */
  private emitKeyStatus(): void {
    const status = this.keyStatus();
    const json = JSON.stringify(status);
    if (json === this.lastKeyStatus) return;
    this.lastKeyStatus = json;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.log(`key status listener failed: ${String(error)}`);
      }
    }
  }

  // ---- 小工具 ----

  /** @brief 取或建一个提供商的状态。 */
  private state(providerId: string): ProviderState {
    let state = this.providers.get(providerId);
    if (!state) {
      state = { config: null, keys: [], pseudo: null, connection: null, inFlight: new Map(), cappedInFlight: new Map(),
        queue: [], generation: 0 };
      this.providers.set(providerId, state);
    }
    return state;
  }

  /** @brief 这次调用要听的 signal：pi 给的、你按停止的、这次尝试的。 */
  private signalsOf(ctx: CallContext): AbortSignal[] {
    return [ctx.initSignal, ctx.options.signal, ctx.options.attemptSignal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
  }

  /** @brief 哪个 signal 触发了：你按停止优先；pi 给的 signal 单独触发也按停止处理。 */
  private abortKind(ctx: CallContext): 'user' | 'attempt' | null {
    if (ctx.options.signal?.aborted) return 'user';
    if (ctx.options.attemptSignal?.aborted) return 'attempt';
    if (ctx.initSignal?.aborted) return 'user';
    return null;
  }

  /** @brief 还没发出就被中止：记 aborted 或 timeout，返回 AbortError。 */
  private abortFailure(ctx: CallContext): unknown {
    const kind = this.abortKind(ctx) ?? 'user';
    this.record(ctx, { keyRef: null, cls: kind === 'user' ? 'aborted' : 'timeout', status: null, retryAfterMs: null,
      sentAt: null });
    const signal = kind === 'attempt' ? ctx.options.attemptSignal : ctx.options.signal ?? ctx.initSignal;
    return abortError(signal);
  }

  /** @brief 模型不可用、不发出（§8.2）：按最先恢复的原因记录（held 记为 timeout）并返回错误。 */
  private unavailableFailure(ctx: CallContext, availability: Availability & { available: false }): Error {
    const cls: FailureClass = availability.reason === 'held' ? 'timeout' : availability.reason;
    this.record(ctx, { keyRef: null, cls, status: null, retryAfterMs: null, sentAt: null });
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) not sent: unavailable (${availability.reason})`);
    return new ModelUnavailableError(ctx.options.ref, availability.reason, availability.until);
  }

  /** @brief conversation、decision 排队超时（§8.2）：记 queue_timeout，请求没有发出。 */
  private queueTimeoutFailure(ctx: CallContext, enqueuedAt: number): Error {
    const waited = this.clock.now() - enqueuedAt;
    this.record(ctx, { keyRef: null, cls: 'queue_timeout', status: null, retryAfterMs: null, sentAt: null });
    const name = this.providers.get(ctx.providerId)?.config?.name ?? ctx.providerId;
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) waited ${waited} ms for a free slot on ${name}`);
    return new Error(`Waited ${Math.round(waited / 1000)} s for a free slot on ${name}`);
  }

  /** @brief 排队中提供商被删除（§4.7）：请求没有发出，记 request，返回错误。 */
  private removedFailure(ctx: CallContext): Error {
    this.record(ctx, { keyRef: null, cls: 'request', status: null, retryAfterMs: null, sentAt: null });
    this.log(`${ctx.options.ref} (${ctx.options.sessionKey}) not sent: ${ctx.providerId} was removed from settings`);
    return new Error(`${ctx.options.ref} was removed from your model settings`);
  }

  /** @brief 把一次尝试记给调用方（§8.4 第 5 步）。 */
  private record(ctx: CallContext, fields: RecordFields): void {
    try {
      ctx.options.onRecord?.({ ref: ctx.options.ref, hadOutput: false, ...fields });
    } catch (error) {
      this.log(`attempt record listener failed: ${String(error)}`);
    }
  }
}

/**
 * @brief 建立模型池。
 * @param options 时长、时钟、fetch 与日志；都可以省略
 */
export function createModelPool(options: ModelPoolOptions = {}): ModelPool {
  return new ModelPool(options);
}
