// 读取器的发请求部分（docs/specs/model-discovery.md §3、§4、§5.3、§7.1、§7.3、§9）：按 discoverRead.ts 的计划发 GET
// （和 Ollama 的 POST /api/show），每个请求限时、限量、不跟随重定向，服务原文里的 key 换成 ***；
// 合并同一个提供商同时进行的列表与种类判断，限制每个 origin 同时进行的请求。
// models.discover 命令同一时刻只有一次、可取消；探针第 0 步（单模型模式）与读版本共用这个读取器，但不被命令取消。
// 服务没报告的窗口、最大输出、是否支持思考按服务地址取 pi 自带的模型表（§4.4，2026-10-26；查表在 piCatalog.ts）。

import type { ApiType, DiscoverListError, DiscoverResult, DiscoveredModel, ServerKind } from '../shared/models';
import {
  LIST_MAX, PROBE_PATHS, afterIdOf, classifyList, dashscopeDetails, dashscopeModels, dedupeRows, finalizeModel,
  hasMore, isAnthropicShape, isTruncated, judgeListKind, judgeProbedKind, listHeaders, listPlan, listRows,
  llamacppDetail, lmstudioDetails, localaiDetails, mindieDetail, newApiMarked, ollamaDetail, pageUrl, parentWindows,
  parseJson, probesUnanswered, readRow, redactKey, requestHeaders, resultApi, rowId, sameDetail, sglangDetails,
  statusLine, targetName, tgiDetail, usesParentWindow, versionOf, versionRequest, type KindProbes, type ListAttempt,
  type RawResponse, type Row, type RowDetail,
} from './discoverRead';
import type { ServerMeta, ServerRead, VersionRead } from './modelProfiles';
import type { ModelTimings } from './modelTimings';
import { catalogEntry, loadCatalog } from './piCatalog';

// ---- 常量（§11，登记在 docs/v1/defaults.md “一键拉取模型”；请求的时限在 modelTimings.ts） ----

/** @brief 每个响应体最多读的字节数（§5.3、§11）：超过时列表请求为 invalid，详情请求为失败。 */
export const BODY_MAX_BYTES = 8 * 1024 * 1024;

/** @brief 服务原文最多保留的字数（§5.2 listError.detail、§11）。 */
export const DETAIL_MAX_CHARS = 2000;

/** @brief Anthropic 形状列表最多页数（§3.2、§11）。 */
export const ANTHROPIC_PAGES = 5;

/** @brief 百炼原生列表每页的条数（§4.2、§11）。 */
export const DASHSCOPE_PAGE_SIZE = 100;

/** @brief 百炼原生列表最多页数（§4.2、§11）。 */
export const DASHSCOPE_PAGES = 10;

/** @brief 对同一个 origin 同时进行的请求（§5.3、§11：命令、探针第 0 步、读版本合计，Ollama 的 /api/show 也在其中）。 */
export const ORIGIN_LIMIT = 4;

/** @brief Ollama /api/show 最多读的模型数（§4.2、§11）：超过的模型不读 /api/show。 */
export const OLLAMA_SHOW_MAX = 100;

// ---- 对外的类型 ----

/** @brief 读取器要读的服务（§3.1、§3.2、§5.1）。 */
export interface ReadTarget {
  /** 新提供商为 §3.1 整理后的 base；已有提供商为配置里的 baseUrl（不整理） */
  base: string;
  /** Anthropic 提示：新提供商按 §3.1；已有提供商为 api 是 anthropic-messages */
  anthropicHint: boolean;
  /** 已有提供商：列表地址按 §3.2“已有提供商”一行，不整理、不识别 */
  existing: boolean;
  /** key 的明文；没有 key 时为 null（不带认证头） */
  secret: string | null;
  /** 合并同时进行的读取用的键（§5.3：baseUrl + api + key 的 ref）；新提供商为 null，不合并 */
  shareKey: string | null;
}

/** @brief 一次 models.discover（§5.1）。 */
export interface DiscoverRequest extends ReadTarget {
  /** 结果的 api：你改过的 API type，或已有提供商配置里的；为 null 时按 Anthropic 提示（§3.4） */
  api: ApiType | null;
  /** 已有提供商配置里的模型 id（结果的 added、notListed）；新提供商为空 */
  configured: readonly string[];
}

/** @brief 读取器的参数。 */
export interface ReaderOptions {
  /** 每个请求的时限（§11） */
  timings: Pick<ModelTimings, 'discoverRequestTimeoutMs'>;
  /** 发请求；省略时为全局 fetch（单元测试传替身） */
  fetch?: typeof globalThis.fetch;
  /** 当前时刻（ms），用于日志的用时；省略时为 Date.now */
  now?: () => number;
}

// ---- 每个 origin 的并发（§5.3） ----

/** @brief 每个 origin 同时进行的请求最多 limit 个；多出来的按先来先得排队，排队时可以取消（§5.3、§11）。 */
class OriginGate {
  /** origin → 正在进行的请求数（有人排队时总等于 limit） */
  private readonly active = new Map<string, number>();
  /** origin → 排队的请求（先来先得），每项是交给它位置的函数 */
  private readonly queues = new Map<string, (() => void)[]>();

  /** @param limit 每个 origin 同时进行的请求数 */
  constructor(private readonly limit: number) {}

  /**
   * @brief 等一个位置。
   * @param signal 排队时取消：从队里移出并以 signal.reason 拒绝
   * @return 释放位置的函数（只生效一次）
   */
  acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const active = this.active.get(origin) ?? 0;
    if (active < this.limit) {
      this.active.set(origin, active + 1);
      return Promise.resolve(this.releaser(origin));
    }
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(origin) ?? [];
      this.queues.set(origin, queue);
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(this.releaser(origin));
      };
      const onAbort = (): void => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0 && this.queues.get(origin) === queue) this.queues.delete(origin);
        reject(signal.reason);
      };
      queue.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** @brief 释放位置：有人排队时直接交给队首，否则计数减一。 */
  private releaser(origin: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(origin);
      const next = queue?.shift();
      if (queue?.length === 0) this.queues.delete(origin);
      if (next) {
        next();
        return;
      }
      const active = (this.active.get(origin) ?? 1) - 1;
      if (active > 0) this.active.set(origin, active);
      else this.active.delete(origin);
    };
  }
}

// ---- 合并同时进行的读取（§5.3，D10） ----

/** @brief 一次进行中的共享读取。 */
interface Shared<T> {
  /** 读取的结果 */
  promise: Promise<T>;
  /** 所有等它的调用都取消时才取消它 */
  controller: AbortController;
  /** 还在等的调用数 */
  waiters: number;
}

/**
 * @brief 同一个键同时进行的读取只做一次，后来的调用等同一个结果；每个调用取消时只是不再等，
 *        所有调用都取消了才取消读取（D10）；读完就丢，不缓存（§5.3、§9）。
 */
class SharedReads<T> {
  private readonly reads = new Map<string, Shared<T>>();

  /**
   * @brief 加入或开始一次读取。
   * @param key 共享的键；为 null 时不合并，直接用调用者的 signal 读
   * @param signal 调用者的取消
   * @param start 开始读取（用共享读取自己的 signal）
   */
  join(key: string | null, signal: AbortSignal, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (key === null) return start(signal);
    if (signal.aborted) return Promise.reject(signal.reason);
    let shared = this.reads.get(key);
    if (!shared) {
      const controller = new AbortController();
      const created: Shared<T> = { promise: start(controller.signal), controller, waiters: 0 };
      this.reads.set(key, created);
      created.promise.then(() => this.drop(key, created), () => this.drop(key, created));
      shared = created;
    }
    shared.waiters += 1;
    return this.wait(key, shared, signal);
  }

  /** @brief 读完或被取消后从表里去掉（不缓存）。 */
  private drop(key: string, shared: Shared<T>): void {
    if (this.reads.get(key) === shared) this.reads.delete(key);
  }

  /** @brief 等共享读取的结果；调用者取消时不再等，最后一个调用者取消时取消读取。 */
  private wait(key: string, shared: Shared<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        shared.waiters -= 1;
        if (shared.waiters === 0) {
          shared.controller.abort();
          this.drop(key, shared);
        }
        reject(signal.reason);
      };
      const settle = <V>(finish: (value: V) => void) => (value: V): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        finish(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(settle(resolve), settle(reject));
    });
  }
}

// ---- 发请求（§5.3、§9） ----

/** @brief 一次读取的上下文。 */
interface Ctx {
  /** 读的服务 */
  target: ReadTarget;
  /** 这次读取的取消 */
  signal: AbortSignal;
  /** 发请求 */
  http: Requester;
}

/** @brief 一次请求的内容。 */
interface SendInit {
  /** 请求头 */
  headers: Record<string, string>;
  /** POST 的 JSON 正文；GET 时省略 */
  body?: string;
}

/** @brief 一次请求的结果：收到的响应，或连接失败、超时的原文（§3.2 unreachable 的 detail，D4）。 */
type Sent = { response: RawResponse; failure: null } | { response: null; failure: string };

/**
 * @brief 列表以外的请求的用途：第 6 步（probe）只在连接失败、超时时记日志（它的非 2xx 是种类判断的正常输入）；
 *        版本请求（version，§3.3）与 §4.2 的详情请求（detail）每次失败都记一行（§4.2，D12）。
 *        llama.cpp 的 /props 既是版本请求又是详情请求，只发一次、失败只记一行。
 */
type Purpose = 'probe' | 'version' | 'detail';

/** @brief signal 取消时以 signal.reason 拒绝（替身 fetch 不理会 signal 时也能按时限停下）。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * @brief 以流读响应体，最多 BODY_MAX_BYTES 字节（§5.3）；signal 取消时停止读取并以 signal.reason 拒绝。
 * @return 正文；超过上限时为 null
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string | null> {
  if (body === null) return '';
  signal.throwIfAborted();
  const reader = body.getReader();
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** @brief 读响应（§5.3、§9）：3xx 不读响应体；正文超过 BODY_MAX_BYTES 时 text 为 null。 */
async function receive(response: Response, signal: AbortSignal): Promise<RawResponse> {
  const redirect = response.status >= 300 && response.status < 400;
  if (redirect) await response.body?.cancel().catch(() => undefined);
  const text = redirect ? '' : await readCapped(response.body, signal);
  return { status: response.status, statusText: response.statusText, headers: response.headers,
    location: response.headers.get('location'), text };
}

/** @brief 连接错误的原文（D4）：cause 的 message（同时试几个地址时为各个地址的 message），否则错误本身的 message。 */
function connectionError(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (cause.message !== '') return cause.message;
    const inner = (cause as { errors?: unknown }).errors;
    const messages = Array.isArray(inner) ? inner.map((item) => (item as Error)?.message).filter(Boolean) : [];
    if (messages.length > 0) return messages.join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * @brief 放进结果与日志的服务原文（§5.1、§5.2、§9、§11）：key 换成 ***，再截到 DETAIL_MAX_CHARS 个字。
 *        只处理原文；列表的 JSON 按收到的解析，不先换 key（换了会改坏字段名）。
 * @param secret key 的明文；没有时为 null
 */
function serverText(text: string, secret: string | null): string {
  const redacted = redactKey(text, secret);
  if (redacted.length <= DETAIL_MAX_CHARS) return redacted;
  return Array.from(redacted.slice(0, DETAIL_MAX_CHARS * 2)).slice(0, DETAIL_MAX_CHARS).join('');
}

/** @brief 是不是 2xx。 */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** @brief 发请求：每个 origin 限并发、每个请求限时、限量，不跟随重定向（§5.3、§9）。 */
class Requester {
  private readonly gate = new OriginGate(ORIGIN_LIMIT);

  /**
   * @param fetchFn 发请求
   * @param timeoutMs 每个请求的时限：从拿到位置、发出到读完响应体（D6）
   */
  constructor(private readonly fetchFn: typeof globalThis.fetch, private readonly timeoutMs: number) {}

  /**
   * @brief 发一个请求并读完响应体。
   * @return 响应，或连接失败、超时的原文；调用者取消时以 signal.reason 拒绝
   */
  async send(ctx: Ctx, url: string, init: SendInit): Promise<Sent> {
    const release = await this.gate.acquire(new URL(url).origin, ctx.signal);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout.signal]);
    try {
      const method = init.body === undefined ? 'GET' : 'POST';
      const response = await abortable(this.fetchFn(url, { method, headers: init.headers, body: init.body,
        redirect: 'manual', signal }), signal);
      return { response: await receive(response, signal), failure: null };
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (timeout.signal.aborted) return { response: null, failure: `Timed out after ${this.timeoutMs / 1000}s` };
      return { response: null, failure: serverText(connectionError(error), ctx.target.secret) };
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /**
   * @brief 列表以外的请求（§3.3 第 6 步、版本请求、§4.2 详情，认证头按 D1），解析 JSON。
   * @param body POST 的 JSON 正文（Ollama 的 /api/show）；GET 时省略
   * @return JSON；连接失败、超时、非 2xx、超过上限、不是 JSON 时为 null（按 Purpose 记一行日志，key 已隐去）；
   *         只有第 6 步（probe）连接失败、超时时为 undefined（没有得到回答，§7.3 读版本据此不算种类变了）
   */
  async json(ctx: Ctx, url: string, purpose: Purpose, body?: string): Promise<unknown> {
    const headers = requestHeaders(ctx.target.secret);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const sent = await this.send(ctx, url, { headers, body });
    const where = redactKey(url, ctx.target.secret);
    if (sent.response === null) {
      console.error(`[kernel] discover ${purpose} request ${where} failed: ${sent.failure}`);
      return purpose === 'probe' ? undefined : null;
    }
    const { status, text } = sent.response;
    const parsed = isOk(status) && text !== null ? parseJson(text) : undefined;
    if (parsed === undefined && purpose !== 'probe') {
      const problem = !isOk(status) ? serverText(statusLine(sent.response), ctx.target.secret)
        : text === null ? 'response larger than 8 MB' : 'not JSON';
      console.error(`[kernel] discover ${purpose} request ${where} failed: ${problem}`);
    }
    return parsed ?? null;
  }
}

// ---- 列表与种类判断（§3.2、§3.3；同一个提供商同时进行的只做一次，§5.3） ----

/** @brief 拿到的模型列表。 */
interface Listed {
  /** 成功的那次列表请求 */
  attempt: ListAttempt;
  /** 去重后的全部行（列表顺序；结果只取前 LIST_MAX 条） */
  rows: Row[];
  /** 列表是 Anthropic 形状 */
  anthropicShape: boolean;
  /** 超过 LIST_MAX 条 */
  truncated: boolean;
}

/** @brief 列表请求与种类判断的结果（§5.3 合并的部分，D10）。 */
interface ListRead {
  /** 拿到的列表；拿不到时为 null */
  listed: Listed | null;
  /** 拿不到列表的原因（detail 已换掉 key、截到 DETAIL_MAX_CHARS）；拿到时为 null */
  error: DiscoverListError | null;
  /** §3.3 的种类；拿不到列表时为 unknown */
  kind: ServerKind;
  /** §3.3 第 6 步的响应；没发时为 null */
  probes: KindProbes | null;
}

/** @brief 拿不到列表的结果：detail 是服务原文，换掉 key 并截短（§5.2、§9）。 */
function noList(ctx: Ctx, error: DiscoverListError): ListRead {
  const detail = serverText(error.detail, ctx.target.secret);
  return { listed: null, error: { kind: error.kind, detail }, kind: 'unknown', probes: null };
}

/** @brief 读列表与种类判断（§3.2、§3.3）：按计划依次试；401、403、连接失败、超时即停；最后一次的失败为原因（D5）。 */
async function readList(ctx: Ctx): Promise<ListRead> {
  let failure: DiscoverListError = { kind: 'no_list', detail: '' };
  for (const attempt of listPlan(ctx.target)) {
    const sent = await ctx.http.send(ctx, attempt.url, { headers: listHeaders(attempt, ctx.target.secret) });
    if (sent.response === null) return noList(ctx, { kind: 'unreachable', detail: sent.failure });
    const outcome = classifyList(sent.response);
    if (outcome.kind === 'list') return listed(ctx, attempt, sent.response, outcome.body);
    failure = outcome.error;
    if (failure.kind === 'rejected') break;
  }
  return noList(ctx, failure);
}

/** @brief 翻页后的行。 */
interface Paged {
  /** 各页的行（未去重） */
  rows: Row[];
  /** 最后读到的一页 has_more（或 hasMore）仍为真 */
  more: boolean;
}

/**
 * @brief Anthropic 形状的翻页（§3.2，D8）：has_more（或 hasMore）为真时带 after_id 再取，最多 ANTHROPIC_PAGES 页，
 *        凑够 LIST_MAX 条就停。后面的一页失败时只用已读到的页并记一行日志。
 * @param first 第一页的 JSON
 */
async function readPages(ctx: Ctx, attempt: ListAttempt, first: unknown): Promise<Paged> {
  let page = first;
  let rows = listRows(first) ?? [];
  for (let count = 1; count < ANTHROPIC_PAGES && hasMore(page); count += 1) {
    if (dedupeRows(rows).length >= LIST_MAX) break;
    const url = pageUrl(attempt.url, afterIdOf(page));
    const sent = await ctx.http.send(ctx, url, { headers: listHeaders(attempt, ctx.target.secret) });
    const outcome = sent.response === null ? null : classifyList(sent.response);
    if (outcome?.kind !== 'list') {
      const reason = sent.response === null ? sent.failure
        : (outcome?.kind === 'failed' && outcome.error.detail) || statusLine(sent.response);
      const where = redactKey(url, ctx.target.secret);
      console.error(`[kernel] discover page ${where} failed: ${JSON.stringify(serverText(reason, ctx.target.secret))}`);
      return { rows, more: false };
    }
    page = outcome.body;
    rows = rows.concat(listRows(page) ?? []);
  }
  return { rows, more: hasMore(page) };
}

/** @brief §3.3 第 6 步：并行 GET <origin> 下的 PROBE_PATHS；没有得到回答的路径值为 undefined（§7.3）。 */
async function readProbes(ctx: Ctx): Promise<KindProbes> {
  const origin = new URL(ctx.target.base).origin;
  const paths = Object.values(PROBE_PATHS);
  const bodies = await Promise.all(paths.map((path) => ctx.http.json(ctx, `${origin}${path}`, 'probe')));
  return new Map(paths.map((path, index) => [path, bodies[index]]));
}

/** @brief 拿到列表之后（§3.2、§3.3）：翻页、去重，按第 1–5 步判断种类，都不成立时发第 6 步的请求。 */
async function listed(ctx: Ctx, attempt: ListAttempt, response: RawResponse, body: unknown): Promise<ListRead> {
  const paged = await readPages(ctx, attempt, body);
  const rows = dedupeRows(paged.rows);
  const host = new URL(ctx.target.base).hostname;
  let kind = judgeListKind({ newApi: newApiMarked(response.headers, body), host, rows });
  let probes: KindProbes | null = null;
  if (kind === null) {
    probes = await readProbes(ctx);
    kind = judgeProbedKind(probes, rows);
  }
  const truncated = isTruncated(rows.length, paged.more);
  return { listed: { attempt, rows, anthropicShape: isAnthropicShape(body), truncated }, error: null, kind, probes };
}

// ---- 版本与详情（§3.3、§4.2） ----

/**
 * @brief 这次读取里 <origin> 下某个路径的 JSON：第 6 步已有的直接用，不再请求（§3.3、§7.3）；没有时请求并留给这次读取的后面用。
 * @param bodies 这次读取已有的响应（按路径）
 */
async function pathBody(ctx: Ctx, bodies: Map<string, unknown>, path: string, purpose: Purpose): Promise<unknown> {
  if (!bodies.has(path)) {
    bodies.set(path, await ctx.http.json(ctx, `${new URL(ctx.target.base).origin}${path}`, purpose));
  }
  return bodies.get(path);
}

/**
 * @brief 服务版本（§3.3）：这个种类有版本请求时读它（第 6 步发过的不再发）。
 * @return 没有版本请求、请求失败或没有版本字段时为 null
 */
async function readVersion(ctx: Ctx, kind: ServerKind, bodies: Map<string, unknown>): Promise<string | null> {
  const request = versionRequest(kind);
  return request === null ? null : versionOf(kind, await pathBody(ctx, bodies, request.path, 'version'));
}

/** @brief 要读详情的范围。 */
interface DetailScope {
  /** 列表与种类 */
  read: ListRead & { listed: Listed };
  /** 要读详情的行：命令为前 LIST_MAX 条，单模型模式为这个模型（和它的 parent） */
  rows: readonly Row[];
  /** 这次读取已有的响应（第 6 步） */
  bodies: Map<string, unknown>;
  /** 单模型模式的模型 id；命令为 null */
  single: string | null;
}

/** @brief 详情读完后的行与每行的详情。 */
interface DetailSet {
  /** 行：GPUStack 换成 with_meta 的列表，其他种类同 DetailScope.rows */
  rows: readonly Row[];
  /** 模型 id → 详情 */
  details: ReadonlyMap<string, RowDetail>;
}

/** @brief Ollama（§4.2）：GET /api/tags、/api/ps，前 OLLAMA_SHOW_MAX 个模型各 POST 一次 /api/show。 */
async function ollamaDetails(ctx: Ctx, rows: readonly Row[]): Promise<Map<string, RowDetail>> {
  const origin = new URL(ctx.target.base).origin;
  const ids = rows.map(rowId);
  const [tags, ps, ...shows] = await Promise.all([
    ctx.http.json(ctx, `${origin}/api/tags`, 'detail'),
    ctx.http.json(ctx, `${origin}/api/ps`, 'detail'),
    ...ids.slice(0, OLLAMA_SHOW_MAX).map((id) => ctx.http.json(ctx, `${origin}/api/show`, 'detail',
      JSON.stringify({ model: id }))),
  ]);
  return new Map(ids.map((id, index) => [id, ollamaDetail(id, { tags, ps, show: shows[index] ?? null })]));
}

/**
 * @brief 放进详情地址的 id（§4.2）：encodeURIComponent 对含单独代理项的 id 会抛错，这时只算这个模型的详情请求失败，
 *        记一行日志，不让整次发现或探针第 0 步失败。
 * @return 编码后的 id；编码失败时为 null
 */
function encodedId(ctx: Ctx, id: string): string | null {
  try {
    return encodeURIComponent(id);
  } catch (error) {
    const which = redactKey(JSON.stringify(id), ctx.target.secret);
    console.error(`[kernel] discover detail request for ${which} failed: ${(error as Error).message}`);
    return null;
  }
}

/** @brief MindIE（§4.2，D15）：每个模型 GET <origin>/v2/models/<id>/config；id 编码失败的只用列表本身。 */
async function mindieDetails(ctx: Ctx, rows: readonly Row[]): Promise<Map<string, RowDetail>> {
  const origin = new URL(ctx.target.base).origin;
  const ids = rows.map(rowId);
  const configs = await Promise.all(ids.map((id) => {
    const encoded = encodedId(ctx, id);
    return encoded === null ? null : ctx.http.json(ctx, `${origin}/v2/models/${encoded}/config`, 'detail');
  }));
  return new Map(ids.map((id, index) => [id, mindieDetail(configs[index])]));
}

/**
 * @brief 详情请求并按形状取值（§4.2）：请求失败时 json 已记日志；回了 JSON 但不是要的形状时同样只用列表本身，记一行日志。
 * @param pick 从 JSON 取值；不是这个形状时为 null
 * @param expected 日志里写的原因
 */
async function shapedDetail<T>(ctx: Ctx, url: string, pick: (body: unknown) => T | null,
  expected: string): Promise<T | null> {
  const body = await ctx.http.json(ctx, url, 'detail');
  const value = body === null ? null : pick(body);
  if (body !== null && value === null) {
    console.error(`[kernel] discover detail request ${redactKey(url, ctx.target.secret)} failed: ${expected}`);
  }
  return value;
}

/**
 * @brief 百炼（§4.2）：原生列表 <origin>/api/v1/models 翻页，直到取完、DASHSCOPE_PAGES 页或凑够 LIST_MAX 条；
 *        单模型模式用 ?model=<id>，不翻页（§7.1，D14）；id 编码失败时只用列表本身（§4.2）。一页失败时只用已读到的页。
 */
async function dashscopeRead(ctx: Ctx, single: string | null): Promise<Map<string, RowDetail>> {
  const origin = new URL(ctx.target.base).origin;
  if (single !== null) {
    const encoded = encodedId(ctx, single);
    if (encoded === null) return dashscopeDetails([]);
    const url = `${origin}/api/v1/models?model=${encoded}`;
    return dashscopeDetails(await shapedDetail(ctx, url, dashscopeModels, 'no output.models') ?? []);
  }
  const models: Row[] = [];
  for (let page = 1; page <= DASHSCOPE_PAGES && models.length < LIST_MAX; page += 1) {
    const url = `${origin}/api/v1/models?page_no=${page}&page_size=${DASHSCOPE_PAGE_SIZE}`;
    const batch = await shapedDetail(ctx, url, dashscopeModels, 'no output.models');
    if (batch === null) break;
    models.push(...batch);
    if (batch.length < DASHSCOPE_PAGE_SIZE) break;
  }
  return dashscopeDetails(models);
}

/** @brief GPUStack（§4.2，D11）：成功的列表地址加 with_meta=true 再读，代替原来的列表；失败时用原来的。 */
async function gpustackRows(ctx: Ctx, scope: DetailScope): Promise<readonly Row[]> {
  const url = new URL(scope.read.listed.attempt.url);
  url.searchParams.set('with_meta', 'true');
  const rows = await shapedDetail(ctx, url.href, listRows, 'not a model list');
  return rows === null ? scope.rows : dedupeRows(rows);
}

/** @brief 按种类读详情（§4.2）；失败的详情请求只用列表本身（记一行日志），不算发现失败。 */
async function readDetails(ctx: Ctx, scope: DetailScope): Promise<DetailSet> {
  const { rows, bodies } = scope;
  const origin = new URL(ctx.target.base).origin;
  switch (scope.read.kind) {
    case 'sglang':
      return { rows, details: sglangDetails(rows, await ctx.http.json(ctx, `${origin}/model_info`, 'detail')) };
    case 'llamacpp':
      return { rows, details: sameDetail(rows, llamacppDetail(await pathBody(ctx, bodies, PROBE_PATHS.llamacpp,
        'detail'))) };
    case 'ollama':
      return { rows, details: await ollamaDetails(ctx, rows) };
    case 'lmstudio':
      return { rows, details: lmstudioDetails(rows, await pathBody(ctx, bodies, PROBE_PATHS.lmstudio, 'detail')) };
    case 'gpustack':
      return { rows: await gpustackRows(ctx, scope), details: new Map() };
    case 'mindie':
      return { rows, details: await mindieDetails(ctx, rows) };
    case 'tgi':
      return { rows, details: sameDetail(rows, tgiDetail(await pathBody(ctx, bodies, PROBE_PATHS.tgi, 'detail'))) };
    case 'localai': {
      const url = `${scope.read.listed.attempt.prefix}/models/capabilities`;
      return { rows, details: localaiDetails(await shapedDetail(ctx, url, listRows, 'not a model list') ?? []) };
    }
    case 'dashscope':
      return { rows, details: await dashscopeRead(ctx, scope.single) };
    default:
      return { rows, details: new Map() };
  }
}

/**
 * @brief 发现的模型（§4.1、§4.3、§4.4、§5.2）：每行合并详情后读，LoRA 行用 parent 的窗口，服务没报告的项取 pi 自带的
 *        模型表（按 base 的 origin 与这一行的 id），再补默认值。
 * @param base 读的服务的地址（ReadTarget.base）
 * @param configured 已有提供商配置里的模型 id（added）
 */
function buildModels(read: ListRead & { listed: Listed }, set: DetailSet, base: string,
  configured: readonly string[]): DiscoveredModel[] {
  const ctx = { kind: read.kind, anthropicShape: read.listed.anthropicShape };
  const rows = set.rows.slice(0, LIST_MAX);
  const catalogs = rows.map((row) => catalogEntry(base, rowId(row)));
  const values = parentWindows(read.kind, rows, rows.map((row, index) => readRow(row, ctx,
    set.details.get(rowId(row)), catalogs[index]?.contextWindow ?? null)));
  return rows.map((row, index) => finalizeModel(rowId(row), values[index], {
    trained: set.details.get(rowId(row))?.trained === true, added: configured.includes(rowId(row)),
    catalog: catalogs[index],
  }));
}

// ---- 结果 ----

/** @brief 拿不到列表或模型不在列表里时的 meta（§7.1：各项为 null）。 */
const NO_META: ServerMeta = Object.freeze({ maxTokens: null, reasoning: null, image: null });

/**
 * @brief 单模型模式的结果（§7.1、§7.2）：训练窗口不记作报告；没有这个模型时 reported 与 meta 各项为 null。
 * @param model 这个模型；不在列表里或拿不到列表时为 null
 */
function serverRead(kind: ServerKind, version: string | null, model: DiscoveredModel | null): ServerRead {
  if (model === null) return { kind, version, reported: null, meta: NO_META };
  const trained = model.hints.includes('trained_window');
  return {
    kind, version,
    reported: model.reported.contextWindow && !trained ? model.contextWindow : null,
    meta: { maxTokens: model.reported.maxTokens ? model.maxTokens : null,
      reasoning: model.reported.reasoning ? model.reasoning : null, image: model.reported.image ? model.image : null },
  };
}

/** @brief 命令结果的公共部分（§5.2）：还没有列表时的样子。 */
function emptyResult(request: DiscoverRequest): DiscoverResult {
  return {
    error: null, cancelled: false, server: null, api: resultApi(request.api, request.anthropicHint),
    baseUrl: request.base, name: targetName(request.base), anthropicShape: false, listError: null, models: [],
    truncated: false, notListed: [],
  };
}

/**
 * @brief 命令本身失败时的结果（§5.2 error：地址或 key 不合格、提供商不存在）。
 * @param error 原文
 */
export function discoverFailure(error: string): DiscoverResult {
  return {
    error, cancelled: false, server: null, api: 'openai-completions', baseUrl: '', name: '', anthropicShape: false,
    listError: null, models: [], truncated: false, notListed: [],
  };
}

/** @brief 发现结束的日志（§5.3，D12）：discover <host> kind=<种类> models=<条数> ms=<用时>；失败另记 listError（key 已隐去）。 */
function logEnd(request: DiscoverRequest, result: DiscoverResult, ms: number): void {
  const host = targetName(request.base);
  const kind = result.server?.kind ?? 'none';
  console.log(`[kernel] discover ${host} kind=${kind} models=${result.models.length} ms=${ms}`);
  if (result.listError) {
    const { kind: errorKind, detail } = result.listError;
    console.error(`[kernel] discover ${host} listError=${errorKind} ${JSON.stringify(detail)}`);
  }
}

/**
 * @brief 命令以外拿不到列表时记一行（探针第 0 步、读版本；异常分支记日志，AGENTS.md）。命令的由 logEnd 记，
 *        所以不放在 readList 里，免得重复。detail 已换掉 key、截短（noList）。
 * @param mode 日志里写的读取方式：probe step 0 或 version read
 */
function logListError(target: ReadTarget, mode: string, error: DiscoverListError | null): void {
  const kind = error?.kind ?? 'no_list';
  const detail = JSON.stringify(error?.detail ?? '');
  console.error(`[kernel] discover ${targetName(target.base)} ${mode} listError=${kind} ${detail}`);
}

/** @brief 读版本按拿不到列表处理时的结果（§7.3：档案不变）。 */
const VERSION_NOT_READ: VersionRead = Object.freeze({
  listed: false, kind: 'unknown', version: null, versionRead: false,
});

// ---- 读取器 ----

/**
 * @brief 读取器（§5.3）：models.discover 命令（同一时刻一次、可取消）、探针第 0 步的单模型模式、读版本共用；
 *        合并同一个提供商同时进行的列表与种类判断，限制每个 origin 同时进行的请求。
 */
export class DiscoverReader {
  private readonly http: Requester;
  private readonly lists = new SharedReads<ListRead>();
  private readonly probeReads = new SharedReads<KindProbes>();
  private readonly now: () => number;
  /** 正在进行的 models.discover；没有时为 null */
  private running: AbortController | null = null;

  /** @param options 时限、fetch、时钟 */
  constructor(options: ReaderOptions) {
    const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.http = new Requester(fetchFn, options.timings.discoverRequestTimeoutMs);
    this.now = options.now ?? Date.now;
  }

  /**
   * @brief models.discover（§5.1–§5.3）：新的一次取消正在进行的那次（被取消的返回 cancelled: true）。
   * @param request 要读的服务与结果需要的配置信息
   */
  async command(request: DiscoverRequest): Promise<DiscoverResult> {
    const host = targetName(request.base);
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const started = this.now();
    try {
      const result = await this.discover(request, controller.signal);
      controller.signal.throwIfAborted();
      logEnd(request, result, this.now() - started);
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[kernel] discover ${host} cancelled ms=${this.now() - started}`);
        return { ...emptyResult(request), cancelled: true };
      }
      const message = redactKey(error instanceof Error ? error.message : String(error), request.secret);
      console.error(`[kernel] discover ${host} failed: ${message}`);
      return discoverFailure(message);
    } finally {
      if (this.running === controller) this.running = null;
    }
  }

  /** @brief models.discoverCancel（§5.3）：取消正在进行的那次 models.discover；没有在进行的时什么也不做。 */
  cancelCommand(): void {
    this.running?.abort();
  }

  /**
   * @brief 探针第 0 步的单模型模式（§7.1）：不占命令的位置、不被它取消，只随 signal 停止。
   *        详情只读这个模型；拿不到列表时按 §3.3 第 6 步能判断的判断种类，reported 与 meta 各项为 null。
   * @param target 已有提供商
   * @param modelId 这个模型的 id
   * @param signal 这组探针的 signal
   */
  async single(target: ReadTarget, modelId: string, signal: AbortSignal): Promise<ServerRead> {
    const ctx: Ctx = { target, signal, http: this.http };
    const read = await this.readShared(ctx);
    if (read.listed === null) {
      logListError(target, 'probe step 0', read.error);
      return this.unlisted(ctx);
    }
    const scoped = { ...read, listed: read.listed };
    const bodies = new Map(read.probes);
    const version = await readVersion(ctx, read.kind, bodies);
    const row = read.listed.rows.find((item) => rowId(item) === modelId);
    if (!row) return serverRead(read.kind, version, null);
    // §4.1：vLLM、SGLang 的 LoRA 行要 parent 那一行的窗口；其他种类详情只对这个模型（§7.1）
    const parent = usesParentWindow(read.kind) && typeof row.parent === 'string'
      ? read.listed.rows.find((item) => rowId(item) === row.parent) : undefined;
    const rows = parent ? [row, parent] : [row];
    const set = await readDetails(ctx, { read: scoped, rows, bodies, single: modelId });
    const ids = new Set(rows.map(rowId));
    await loadCatalog();
    const models = buildModels(scoped, { ...set, rows: set.rows.filter((item) => ids.has(rowId(item))) },
      target.base, []);
    return serverRead(read.kind, version, models.find((model) => model.id === modelId) ?? null);
  }

  /**
   * @brief 读版本（§7.3）：列表请求、§3.3 的种类判断与版本请求（第 6 步发过的不再发），不发 §4.2 的详情请求。
   *        第 6 步有能决定种类的请求连接失败或超时、种类因此判断为 unknown 时按拿不到列表处理（档案不变，proposal §10
   *        第 5 条“读失败不算变化”，probesUnanswered）；404 等 HTTP 回答照样是判断种类的依据。
   * @param target 已有提供商
   * @param signal 取消
   */
  async version(target: ReadTarget, signal: AbortSignal): Promise<VersionRead> {
    const ctx: Ctx = { target, signal, http: this.http };
    const read = await this.readShared(ctx);
    if (read.listed === null) {
      logListError(target, 'version read', read.error);
      return VERSION_NOT_READ;
    }
    if (read.kind === 'unknown' && read.probes !== null && probesUnanswered(read.probes, read.listed.rows)) {
      console.error(`[kernel] discover ${targetName(target.base)} version read: kind unknown after unanswered `
        + 'probe requests; profiles unchanged');
      return VERSION_NOT_READ;
    }
    const version = await readVersion(ctx, read.kind, new Map(read.probes));
    const versionRead = versionRequest(read.kind) !== null && version !== null;
    return { listed: true, kind: read.kind, version, versionRead };
  }

  /** @brief 列表与种类判断，同一个 shareKey 同时进行的只做一次（§5.3，D10）。 */
  private readShared(ctx: Ctx): Promise<ListRead> {
    return this.lists.join(ctx.target.shareKey, ctx.signal, (signal) => readList({ ...ctx, signal }));
  }

  /** @brief 单模型模式拿不到列表（§7.1）：第 6 步的判断，同一个 shareKey 同时进行的只做一次（D10）。 */
  private async unlisted(ctx: Ctx): Promise<ServerRead> {
    const probes = await this.probeReads.join(ctx.target.shareKey, ctx.signal,
      (signal) => readProbes({ ...ctx, signal }));
    const kind = judgeProbedKind(probes, []);
    return serverRead(kind, await readVersion(ctx, kind, new Map(probes)), null);
  }

  /** @brief 一次命令（§5.1、§5.2）：列表与种类、版本、§4.2 的详情，组成结果。 */
  private async discover(request: DiscoverRequest, signal: AbortSignal): Promise<DiscoverResult> {
    const ctx: Ctx = { target: request, signal, http: this.http };
    const read = await this.readShared(ctx);
    const empty = emptyResult(request);
    if (read.listed === null) return { ...empty, listError: read.error };
    const scoped = { ...read, listed: read.listed };
    const bodies = new Map(read.probes);
    const version = await readVersion(ctx, read.kind, bodies);
    const rows = read.listed.rows.slice(0, LIST_MAX);
    const set = await readDetails(ctx, { read: scoped, rows, bodies, single: null });
    const listedIds = new Set(read.listed.rows.map(rowId));
    await loadCatalog();
    return {
      ...empty, server: { kind: read.kind, version }, baseUrl: read.listed.attempt.suggestedBase,
      anthropicShape: read.listed.anthropicShape, models: buildModels(scoped, set, request.base, request.configured),
      truncated: read.listed.truncated, notListed: request.configured.filter((id) => !listedIds.has(id)),
    };
  }
}
