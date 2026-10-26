// 失败分类（docs/specs/model-providers.md §5.4）与不可用记录的生成和恢复（§8.3）。
// 全是纯函数：时刻与时长都由调用方以参数传入（§12），模型池（modelPool.ts）与会话接线共用。

import type { ModelProvider } from '../shared/models';
import type { ModelTimings } from './modelTimings';
import type { AvailabilityReason, FailureClass } from './modelTypes';

/** @brief 额度错误的关键词（§12），在 400/403/429 的响应体里不区分大小写地查找。 */
export const QUOTA_KEYWORDS: readonly string[] = Object.freeze(['insufficient_quota', 'quota', 'billing', 'balance']);

/** @brief 原地重试的 HTTP 状态（§5.4 server）。 */
export const SERVER_STATUSES: readonly number[] = Object.freeze([500, 502, 503, 504]);

/** @brief 状态码配上额度关键词才算额度错误的状态（§5.4 quota）。 */
const QUOTA_KEYWORD_STATUSES: readonly number[] = [400, 403, 429];

/**
 * @brief 收到响应头之前、表示网络错误的错误码（连接被拒、DNS、TLS、连接重置，§5.4 connection）。
 * Node 的 fetch 把它们放在 TypeError('fetch failed') 的 cause 链上。
 */
export const NETWORK_ERROR_CODES: readonly string[] = Object.freeze([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ETIMEDOUT', 'EHOSTUNREACH',
  'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** @brief TLS 类错误码的前缀（ERR_TLS_*、ERR_SSL_*），与上表一样按网络错误处理。 */
const TLS_CODE_PREFIXES: readonly string[] = ['ERR_TLS_', 'ERR_SSL_'];

/** @brief 只读的响应头：Headers 或任何有 get 方法的对象。 */
export interface HeaderReader {
  /**
   * @brief 取一个响应头（名字不区分大小写）。
   * @param name 头名
   * @return 值；没有时为 null
   */
  get(name: string): string | null;
}

/** @brief 一次尝试的分类结果。 */
export interface Classification {
  /** 失败分类；成功为 ok */
  cls: FailureClass;
  /** Retry-After（秒数、HTTP 日期或 retry-after-ms）换算出的等待（ms）；没有或写法不认识时为 null */
  retryAfterMs: number | null;
}

/** @brief 分类响应所需的输入（§8.4 第 3 步：4xx、5xx 的响应体已经读出，最多 64 KB）。 */
export interface ResponseFacts {
  /** HTTP 状态 */
  status: number;
  /** 响应头 */
  headers: HeaderReader;
  /** 响应体文字；2xx 不读，传空字符串 */
  body: string;
  /** 当前时刻（ms），用于 HTTP 日期写法的 Retry-After */
  now: number;
}

/** @brief 分类一次抛错（没有拿到可分类的响应）所需的输入。 */
export interface ThrownFacts {
  /** fetch 或读响应体时抛出的错误 */
  error: unknown;
  /** 你按了停止（会话的 signal 已触发，§8.4） */
  userAborted: boolean;
  /** 这次尝试的控制器已触发：首个内容超时（§5.4 timeout、§11.2） */
  attemptAborted: boolean;
  /** 已经收到响应头 */
  afterHeaders: boolean;
}

/** @brief 一条不可用记录（§8.3）。 */
export interface UnavailableRecord {
  /** 状态 */
  state: AvailabilityReason;
  /** 恢复时刻（ms）；不会自己恢复的（auth、quota、not_found）为 null */
  until: number | null;
}

/** @brief 一次失败对不可用记录的影响：记在 key、提供商还是模型上（§5.4 处理列、§8.3）。 */
export interface FailureEffect {
  /** 记录的对象；没有 key 的提供商的 key 级记录记在它的“无 key”上（§8.3） */
  scope: 'key' | 'provider' | 'model';
  /** 要写的记录 */
  record: UnavailableRecord;
}

/** @brief 只由数字组成（可带小数）的头值。 */
const NUMERIC = /^\d+(\.\d+)?$/;

/** @brief HTTP 日期以星期名开头（IMF-fixdate、RFC 850、asctime 三种写法）；不这样开头的不按日期解析。 */
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? /;

/**
 * @brief 解析 Retry-After 的三种写法（§5.4）：retry-after-ms（毫秒）优先，其次 Retry-After 的秒数或 HTTP 日期。
 * @param headers 响应头
 * @param now 当前时刻（ms）；HTTP 日期早于它时得到 0
 * @return 等待的毫秒数；都没有或写法不认识时为 null
 */
export function parseRetryAfter(headers: HeaderReader, now: number): number | null {
  const ms = headers.get('retry-after-ms')?.trim();
  if (ms && NUMERIC.test(ms)) return Math.round(Number(ms));
  const value = headers.get('retry-after')?.trim();
  if (!value) return null;
  if (NUMERIC.test(value)) return Math.round(Number(value) * 1000);
  const date = HTTP_DATE.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * @brief 响应体是否含额度关键词（§12，不区分大小写）。
 * @param body 响应体文字
 */
export function hasQuotaKeyword(body: string): boolean {
  const lower = body.toLowerCase();
  return QUOTA_KEYWORDS.some((word) => lower.includes(word));
}

/**
 * @brief 按 §5.4 的表分类一个 HTTP 响应。
 *
 * 2xx 与其他 400 以下的状态为 ok；500、502、503、504 以外的 5xx 规格没有列出，按 request 处理（不换、以错误结束）。
 * @param facts 状态、响应头、响应体与当前时刻
 * @return 分类与 Retry-After
 */
export function classifyResponse(facts: ResponseFacts): Classification {
  const { status } = facts;
  const retryAfterMs = parseRetryAfter(facts.headers, facts.now);
  if (status < 400) return { cls: 'ok', retryAfterMs };
  if (status === 402 || (QUOTA_KEYWORD_STATUSES.includes(status) && hasQuotaKeyword(facts.body))) {
    return { cls: 'quota', retryAfterMs };
  }
  if (status === 429) return { cls: 'rate_limited', retryAfterMs };
  if (status === 401 || status === 403) return { cls: 'auth', retryAfterMs };
  if (status === 404) return { cls: 'not_found', retryAfterMs };
  if (SERVER_STATUSES.includes(status)) return { cls: 'server', retryAfterMs };
  return { cls: 'request', retryAfterMs };
}

/** @brief 取错误自己的 code，没有时为 null。 */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * @brief 判断收到响应头之前的错误是不是网络错误（连接被拒、DNS、TLS、连接重置）。
 *
 * 沿 cause 链查找错误码；Node fetch 的 TypeError('fetch failed') 本身就表示网络错误。
 * @param error fetch 抛出的错误
 */
export function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const code = errorCode(current);
    if (code && (NETWORK_ERROR_CODES.includes(code) || TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)))) {
      return true;
    }
    if (current instanceof TypeError && current.message === 'fetch failed') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * @brief 分类一次没有可分类响应的尝试（§5.4、§8.4）。
 *
 * 你按了停止优先于尝试超时；收到响应头后的中断记 partial（不换模型）；
 * 收到响应头之前不是网络错误的抛错（例如地址写法错误）规格没有列出，按 request 处理。
 * @param facts 错误与两个 signal 的状态
 * @return 分类；retryAfterMs 总为 null
 */
export function classifyThrown(facts: ThrownFacts): Classification {
  if (facts.userAborted) return { cls: 'aborted', retryAfterMs: null };
  if (facts.attemptAborted) return { cls: 'timeout', retryAfterMs: null };
  if (facts.afterHeaders) return { cls: 'partial', retryAfterMs: null };
  return { cls: isNetworkError(facts.error) ? 'connection' : 'request', retryAfterMs: null };
}

/**
 * @brief 一次失败要写的不可用记录（§5.4 处理列、§8.3、§12）。
 *
 * timeout 的记录由流函数包装写（会话请求为 held，§5.7；压缩请求为 timeout，§6.4）；其余分类不写记录。
 * @param classification 分类与 Retry-After
 * @param now 当前时刻（ms）
 * @param timings §12 的时长
 * @return 记录；不写时为 null
 */
export function failureEffect(classification: Classification, now: number,
  timings: ModelTimings): FailureEffect | null {
  switch (classification.cls) {
    case 'rate_limited': {
      // Retry-After 为 0（含已过去的 HTTP 日期）按没写处理：记录要真的挡住这个 key，否则换 key 会立刻回到它
      const after = classification.retryAfterMs;
      const wait = after !== null && after > 0 ? after : timings.rateLimitCooldownMs;
      return { scope: 'key', record: { state: 'rate_limited', until: now + wait } };
    }
    case 'auth':
    case 'quota':
      return { scope: 'key', record: { state: classification.cls, until: null } };
    case 'not_found':
      return { scope: 'model', record: { state: 'not_found', until: null } };
    case 'connection':
      return { scope: 'provider', record: { state: 'connection', until: now + timings.connectionCooldownMs } };
    default:
      return null;
  }
}

/**
 * @brief 记录此刻是否仍然有效（§8.3：带时刻的记录到时刻即恢复）。
 * @param record 记录；没有时为 null
 * @param now 当前时刻（ms）
 */
export function isRecordActive(record: UnavailableRecord | null | undefined, now: number): boolean {
  return !!record && (record.until === null || record.until > now);
}

/**
 * @brief 从几条有效记录中取最先恢复的一条（§8.2：以记录里最先恢复的原因失败）；不会自己恢复的排在最后，同时恢复的保留先给出的。
 * @param records 有效的记录，按给出的顺序
 * @return 最先恢复的记录；没有时为 null
 */
export function earliestRecovery(records: readonly UnavailableRecord[]): UnavailableRecord | null {
  let best: UnavailableRecord | null = null;
  for (const record of records) {
    const until = record.until ?? Infinity;
    if (!best || until < (best.until ?? Infinity)) best = record;
  }
  return best;
}

/** @brief 提供商配置的一次改变里与不可用记录有关的部分（§8.3 恢复列）。 */
export interface ProviderChange {
  /** 地址、接口或兼容选项改变：清除 key 的 auth、quota，提供商的 connection，全部模型的 not_found */
  endpoint: boolean;
  /** 配置改变了的模型 id（含新出现的）：清除它们的 not_found */
  changedModels: string[];
}

/** @brief 按键名排序后序列化，比较两个 JSON 值是否相同。 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    const entries = Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

/**
 * @brief 比较提供商的新旧配置，给出要清除哪些记录（§8.3）。
 *
 * 只改名称、并发上限、区域或模型列表的顺序不清除；key 的增删由模型池按 key 处理。
 * @param previous 旧配置
 * @param next 新配置
 */
export function providerChange(previous: ModelProvider, next: ModelProvider): ProviderChange {
  const endpoint = previous.baseUrl !== next.baseUrl || previous.api !== next.api
    || stableJson(previous.compat) !== stableJson(next.compat);
  const changedModels = next.models.filter((model) => {
    const before = previous.models.find((old) => old.id === model.id);
    return !before || stableJson(before) !== stableJson(model);
  }).map((model) => model.id);
  return { endpoint, changedModels };
}

/**
 * @brief 地址、接口或兼容选项改变时，这种记录是否清除（§8.3）。
 * @param state 记录的状态
 */
export function clearedByEndpointChange(state: AvailabilityReason): boolean {
  return state === 'auth' || state === 'quota' || state === 'connection' || state === 'not_found';
}
