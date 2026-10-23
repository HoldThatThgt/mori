// 读取器的规则（docs/specs/model-discovery.md §3、§4）：纯函数，modelDiscover.ts 按它们发请求、读响应。
// 整理地址与列表地址（§3.1、§3.2）、列表响应的判定（§3.2、§5.3、§9）、认出服务种类与版本（§3.3）、API type 与名称（§3.4）、
// 读一行（§4.1）、按种类合并详情（§4.2）、默认值与最后的检查（§4.3）。只依赖 shared/models.ts；单元测试直接喂录下的响应体。

import {
  UNREPORTED_CONTEXT_WINDOW, unreportedMaxTokens, type ApiType, type DiscoverHint, type DiscoverListError,
  type DiscoveredModel, type ServerKind,
} from '../shared/models';

// ---- 常量（§11，登记在 docs/v1/defaults.md “一键拉取模型”） ----

/** @brief 列表最多条数（§3.2、§11）：超过时只取前面的，结果 truncated 为真；翻页凑够这个条数就停。 */
export const LIST_MAX = 1000;

/** @brief 列表地址最多试的次数（§3.2、§11）。 */
export const LIST_ATTEMPTS = 3;

/** @brief 有 Anthropic 提示时第 ① 个列表请求的 anthropic-version 头（§3.2、§11，D2）。 */
export const ANTHROPIC_VERSION = '2023-06-01';

/** @brief Anthropic 形状列表每页的条数（§3.2 ① 的 limit；§11 “每页 1000”）。 */
const ANTHROPIC_PAGE_LIMIT = 1000;

/** @brief Anthropic 自己的主机（§3.1 第 4 步、§3.2、§3.3 第 2 步）。 */
const ANTHROPIC_HOST = 'api.anthropic.com';

/** @brief §3.1 第 3 步去掉的端点后缀：按这个顺序比较，只去一次。 */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/embeddings', '/models'];

/** @brief §3.2 没有 Anthropic 提示时，base 的路径以 /v<数字> 结尾就不试 ②。 */
const VERSION_SUFFIX = /\/v\d+$/;

/** @brief 列表响应体超过上限时 invalid 的 detail（§5.3、D5）。 */
export const LIST_TOO_LARGE = 'The model list is larger than 8 MB.';

// ---- 类型 ----

/** @brief 列表或详情响应里的一行（一个对象）；不是对象的行当作没有字段的行（D9）。 */
export type Row = Record<string, unknown>;

/** @brief §3.1 整理后的地址。 */
export interface NormalizedBase {
  /** 整理后的 base */
  base: string;
  /** Anthropic 提示：路径里有一段等于 anthropic（不分大小写），或主机是 api.anthropic.com */
  anthropicHint: boolean;
}

/** @brief 列表地址计划的输入（§3.2）；modelDiscover.ts 的 ReadTarget 满足它。 */
export interface PlanTarget {
  /** 新提供商为 §3.1 整理后的 base；已有提供商为配置里的 baseUrl */
  base: string;
  /** Anthropic 提示（已有提供商：api 是 anthropic-messages） */
  anthropicHint: boolean;
  /** 已有提供商：按 §3.2“已有提供商”一行 */
  existing: boolean;
}

/** @brief 一次列表请求（§3.2 表中的 ①②③）。 */
export interface ListAttempt {
  /** 请求的地址 */
  url: string;
  /** 地址里 /models 之前的部分：§4.2 的 <base>（GPUStack 的 with_meta、LocalAI 的 capabilities，D11） */
  prefix: string;
  /** 这次成功时结果的 baseUrl：没有提示时 ② 为 <base>/v1，其余为 base（§3.2“列表地址只用来读”） */
  suggestedBase: string;
  /** 带 Anthropic 的认证头（有提示时的 ①）；否则只带 Authorization: Bearer */
  anthropic: boolean;
}

/** @brief 收到的一个响应（modelDiscover.ts 读完响应体后给出；原样，key 在放进结果与日志时才换成 ***，§9）。 */
export interface RawResponse {
  /** HTTP 状态 */
  status: number;
  /** 状态行的文字（D3） */
  statusText: string;
  /** 响应头（§3.3 第 1 步看 X-New-Api-Version） */
  headers: Headers;
  /** 3xx 的 Location；没有时为 null */
  location: string | null;
  /** 响应体；超过 §11 的上限时为 null（3xx 不读，为空字符串） */
  text: string | null;
}

/** @brief 一次列表请求的判定（§3.2）。 */
export type ListOutcome =
  /** 拿到了模型列表：body 为解析后的 JSON */
  | { kind: 'list'; body: unknown }
  /** 这次没拿到：rejected 即停，no_list、invalid 试下一个（D5） */
  | { kind: 'failed'; error: DiscoverListError };

/** @brief §3.3 第 1–5 步要看的列表信息。 */
export interface ListFacts {
  /** 列表响应头有 X-New-Api-Version，或对象有 success: true */
  newApi: boolean;
  /** base 的主机名（小写） */
  host: string;
  /** 去重后的列表行 */
  rows: readonly Row[];
}

/**
 * @brief §3.3 第 6 步各个 GET 的 JSON，按路径（PROBE_PATHS）：非 2xx、超过上限或不是 JSON 时为 null；
 *        没有得到回答（连接失败、超时）时为 undefined（§7.3 读版本按拿不到列表处理）。
 */
export type KindProbes = ReadonlyMap<string, unknown>;

/** @brief 读一行时与种类相关的上下文（§4.1）。 */
export interface RowContext {
  /** 服务种类：litellm 的布尔假按没报告，qianfan 再看 max_tokens */
  kind: ServerKind;
  /** 列表是 Anthropic 形状：再看 max_tokens */
  anthropicShape: boolean;
}

/** @brief §4.1 读出的一行：服务报告的值，没报告为 null（reasoning、image 明确报告“没有”为 false）。 */
export interface RowValues {
  /** 窗口 */
  contextWindow: number | null;
  /** 输出上限（已排除不小于窗口的值） */
  maxTokens: number | null;
  /** 支持思考 */
  reasoning: boolean | null;
  /** 图片输入 */
  image: boolean | null;
  /** 模型族 */
  family: string | null;
  /** 是不是聊天模型 */
  chat: boolean | null;
  /** 服务明确报告没有工具支持（no_tools 提示） */
  noTools: boolean;
}

/** @brief §4.2 合并进一行的详情；详情的值优先于列表行里同名的值。 */
export interface RowDetail {
  /**
   * 合并进行、再按 §4.1 读的字段（LocalAI 的 capabilities 等、Ollama 的 capabilities 与 details、LM Studio 的 type、
   * 百炼的 inference_metadata.request_modality）
   */
  fields?: Row;
  /** 直接取用的值，优先于 §4.1 读到的 */
  values?: Partial<RowValues>;
  /** 行里没有窗口时用的窗口（llama.cpp /props 的 default_generation_settings.n_ctx） */
  fallbackWindow?: number;
  /** values.contextWindow 是 Ollama 的训练窗口（trained_window 提示，§7.2 不记作报告） */
  trained?: boolean;
}

/** @brief §4.2 Ollama 的三种详情响应。 */
export interface OllamaBodies {
  /** GET /api/tags */
  tags: unknown;
  /** GET /api/ps */
  ps: unknown;
  /** 这个模型的 POST /api/show；没有读（超过 §11 的上限）或失败时为 null */
  show: unknown;
}

/** @brief 发现的一个模型除读到的值以外的标记（§5.2）。 */
export interface ModelFlags {
  /** 窗口是 Ollama 的训练窗口 */
  trained: boolean;
  /** 只对已有提供商：这个 id 已在配置里 */
  added: boolean;
}

// ---- 通用的取值 ----

/** @brief 是不是对象（不含数组与 null）。 */
function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 当作一行：不是对象的当作没有字段的行（D9）。 */
export function asRow(value: unknown): Row {
  return isRecord(value) ? value : {};
}

/**
 * @brief 按路径取值，路径用 . 分层（§4.1）。
 * @param path 例如 top_provider.context_length
 * @return 中途不是对象或没有这个字段时为 undefined
 */
export function fieldAt(row: Row, path: string): unknown {
  let value: unknown = row;
  for (const part of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

/** @brief 正整数（§4.1：包括只含数字的字符串），否则 null。 */
export function positiveInt(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** @brief 非空字符串，否则 null。 */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** @brief 路径上的数组里的字符串，转成小写（§4.1“数组比较不分大小写”）；不是数组时为 null。 */
function wordsAt(row: Row, path: string): string[] | null {
  const value = fieldAt(row, path);
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
}

/** @brief 数组含 words 中的任何一个（words 为小写）。 */
function hasWord(values: readonly string[] | null, words: readonly string[]): boolean {
  return values !== null && words.some((word) => values.includes(word));
}

/**
 * @brief 路径上的布尔值（§4.1）：litellm 的假一律按没报告（LiteLLM 把不知道的填成 false）。
 * @return 真、假，或没报告（null）
 */
function boolAt(row: Row, path: string, ctx: RowContext): boolean | null {
  const value = fieldAt(row, path);
  if (value === true) return true;
  return value === false && ctx.kind !== 'litellm' ? false : null;
}

/** @brief 行的 id：不是字符串的 id 当作空字符串（D9）。 */
export function rowId(row: Row): string {
  return typeof row.id === 'string' ? row.id : '';
}

/** @brief 解析 JSON；不是 JSON 时为 undefined。 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @brief 去掉结尾的 /。 */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * @brief 把服务原文里的 key 换成 ***（§5.1、§9）。
 * @param secret key 的明文；没有 key 时原样返回
 */
export function redactKey(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('***') : text;
}

// ---- §3.1 整理地址、§3.4 API type 与名称 ----

/** @brief 路径里有一段等于 anthropic（不分大小写，§3.1 第 4 步）。 */
function anthropicSegment(path: string): number {
  return path.split('/').findIndex((segment) => segment.toLowerCase() === 'anthropic');
}

/**
 * @brief 整理新提供商的 Base URL（§3.1）：去掉首尾空白、query 与 hash、结尾的 /，去掉一次端点后缀；
 *        有 Anthropic 提示时再去掉结尾的 /v1。
 * @param raw 你填的地址
 * @return 整理后的地址；不是 http 或 https URL 时为 null（命令的 error 为“Base URL must be an http or https URL.”）
 */
export function normalizeBaseUrl(raw: string): NormalizedBase | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.search = '';
  url.hash = '';
  let path = trimSlashes(url.pathname);
  const suffix = ENDPOINT_SUFFIXES.find((end) => path.endsWith(end));
  if (suffix) path = path.slice(0, -suffix.length);
  const anthropicHint = anthropicSegment(path) >= 0 || url.hostname === ANTHROPIC_HOST;
  if (anthropicHint && path.endsWith('/v1')) path = path.slice(0, -'/v1'.length);
  url.pathname = path;
  return { base: trimSlashes(url.href), anthropicHint };
}

/**
 * @brief 结果的 api（§3.4）：你改过的 API type（或已有提供商配置里的）；否则有 Anthropic 提示为 anthropic-messages，
 *        没有为 openai-completions。列表的形状不改它。
 * @param api 你改过的，没改过为 null
 */
export function resultApi(api: ApiType | null, anthropicHint: boolean): ApiType {
  return api ?? (anthropicHint ? 'anthropic-messages' : 'openai-completions');
}

/** @brief 建议的名称（§3.4）：base 的主机名，端口不是协议默认端口时加 :<端口>。 */
export function targetName(base: string): string {
  return new URL(base).host;
}

// ---- §3.2 列表请求 ----

/**
 * @brief Anthropic 前缀（§3.2）：base 的路径里 anthropic 那一段之前的部分。
 * @return 主机是 api.anthropic.com 或路径里没有这一段时为 null（只试 ①）
 */
export function anthropicPrefix(base: string): string | null {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  const index = anthropicSegment(url.pathname);
  if (url.hostname === ANTHROPIC_HOST || index < 0) return null;
  url.pathname = url.pathname.split('/').slice(0, index).join('/');
  return trimSlashes(url.href);
}

/**
 * @brief 有 Anthropic 提示时的列表请求（§3.2）：①<base>/v1/models?limit=1000，② 前缀 + /models，③ 前缀 + /v1/models。
 * @param base 去掉结尾 / 的 base（拼地址用）
 * @param suggested 结果的 baseUrl：原样的 base（§3.2“列表地址只用来读”）
 */
function anthropicPlan(base: string, suggested: string): ListAttempt[] {
  const first: ListAttempt = { url: `${base}/v1/models?limit=${ANTHROPIC_PAGE_LIMIT}`, prefix: `${base}/v1`,
    suggestedBase: suggested, anthropic: true };
  const prefix = anthropicPrefix(base);
  if (prefix === null) return [first];
  return [first,
    { url: `${prefix}/models`, prefix, suggestedBase: suggested, anthropic: false },
    { url: `${prefix}/v1/models`, prefix: `${prefix}/v1`, suggestedBase: suggested, anthropic: false }];
}

/**
 * @brief 列表地址的计划（§3.2）：按顺序试，拿到模型列表就停，最多 LIST_ATTEMPTS 次。
 *        没有提示：① <base>/models，② 只对新提供商、base 的路径不以 /v<数字> 结尾时 <base>/v1/models；
 *        有提示（新提供商按 §3.1，已有提供商为 anthropic-messages）：见 anthropicPlan。
 *        结果的 baseUrl 除 ② 以外是原样的 base（已有提供商不整理地址，§3.1；拼地址时才去掉结尾的 /）。
 */
export function listPlan(target: PlanTarget): ListAttempt[] {
  const base = trimSlashes(target.base);
  if (target.anthropicHint) return anthropicPlan(base, target.base).slice(0, LIST_ATTEMPTS);
  const attempts: ListAttempt[] = [{ url: `${base}/models`, prefix: base, suggestedBase: target.base,
    anthropic: false }];
  if (!target.existing && !VERSION_SUFFIX.test(new URL(base).pathname)) {
    attempts.push({ url: `${base}/v1/models`, prefix: `${base}/v1`, suggestedBase: `${base}/v1`, anthropic: false });
  }
  return attempts.slice(0, LIST_ATTEMPTS);
}

/**
 * @brief 列表请求的认证头（§3.2，D2）：有提示时的 ① 总带 anthropic-version，有 key 时加 x-api-key 与
 *        Authorization: Bearer；其余有 key 时只带 Authorization: Bearer。没有 key 时不带认证头。
 * @param secret key 的明文；没有时为 null
 */
export function listHeaders(attempt: ListAttempt, secret: string | null): Record<string, string> {
  const auth: Record<string, string> = secret ? { authorization: `Bearer ${secret}` } : {};
  if (!attempt.anthropic) return auth;
  return { 'anthropic-version': ANTHROPIC_VERSION, ...(secret ? { 'x-api-key': secret } : {}), ...auth };
}

/**
 * @brief 列表以外的请求（§3.3 第 6 步、§4.2 详情、版本请求）的认证头（D1）：有 key 时 Authorization: Bearer。
 * @param secret key 的明文；没有时为 null
 */
export function requestHeaders(secret: string | null): Record<string, string> {
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

/** @brief 状态行（D3）：HTTP <status> <statusText>，去掉首尾空白。 */
export function statusLine(response: Pick<RawResponse, 'status' | 'statusText'>): string {
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

/** @brief rejected、invalid 的 detail（§5.2）：服务的原文；没有原文（或超过上限没读）时为状态行（D3）。 */
function bodyDetail(response: RawResponse): string {
  const text = response.text?.trim();
  return text ? text : statusLine(response);
}

/** @brief 这次没拿到列表的判定。 */
function failed(kind: DiscoverListError['kind'], detail: string): ListOutcome {
  return { kind: 'failed', error: { kind, detail } };
}

/**
 * @brief 判定一次列表请求（§3.2、§5.3、§9，D5）：2xx、JSON、是数组或对象的 data 是数组为模型列表；
 *        3xx 为 invalid（Redirected to <location>）；401、403 为 rejected；404、405 为 no_list；
 *        响应体超过上限为 invalid（LIST_TOO_LARGE）；其他 4xx、5xx、不是 JSON、没有数组为 invalid。
 */
export function classifyList(response: RawResponse): ListOutcome {
  const { status } = response;
  if (status >= 300 && status < 400) {
    return failed('invalid', response.location ? `Redirected to ${response.location}` : statusLine(response));
  }
  if (status === 401 || status === 403) return failed('rejected', bodyDetail(response));
  if (status === 404 || status === 405) return failed('no_list', '');
  if (response.text === null) return failed('invalid', LIST_TOO_LARGE);
  if (status < 200 || status >= 300) return failed('invalid', bodyDetail(response));
  const body = parseJson(response.text);
  return listRows(body) === null ? failed('invalid', bodyDetail(response)) : { kind: 'list', body };
}

/**
 * @brief 列表的行（§3.2）：body 是数组，或对象的 data 是数组；不是对象的行当作没有字段的行（D9）。
 * @return 不是模型列表时为 null
 */
export function listRows(body: unknown): Row[] | null {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : null;
  return rows === null ? null : rows.map(asRow);
}

/** @brief 列表是 Anthropic 形状（§3.2、§5.2：对象有 has_more）。 */
export function isAnthropicShape(body: unknown): boolean {
  return isRecord(body) && 'has_more' in body;
}

/** @brief Anthropic 形状的列表还有下一页（§3.2：has_more 为真）。 */
export function hasMore(body: unknown): boolean {
  return isRecord(body) && body.has_more === true;
}

/** @brief 下一页的 after_id（D8）：body 的 last_id 是字符串时用它，否则用这一页最后一行的 id。 */
export function afterIdOf(body: unknown): string {
  const lastId = isRecord(body) ? body.last_id : undefined;
  if (typeof lastId === 'string') return lastId;
  const rows = listRows(body) ?? [];
  return rows.length > 0 ? rowId(rows[rows.length - 1]) : '';
}

/** @brief 下一页的地址（§3.2、D8）：在成功的那次列表地址上设 after_id。 */
export function pageUrl(url: string, afterId: string): string {
  const next = new URL(url);
  next.searchParams.set('after_id', afterId);
  return next.href;
}

/** @brief 同一个 id 只保留第一次出现的（§3.2，D9）。 */
export function dedupeRows(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = rowId(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * @brief 列表是否超过 §11 的条数（§3.2、§5.2 truncated）：去重后超过 LIST_MAX，或凑够 LIST_MAX 停下翻页时还有下一页。
 * @param count 去重后的条数
 * @param more 最后读到的一页 has_more 仍为真
 */
export function isTruncated(count: number, more: boolean): boolean {
  return count > LIST_MAX || (more && count >= LIST_MAX);
}

// ---- §3.3 服务种类与版本 ----

/** @brief §3.3 第 1 步：列表响应头有 X-New-Api-Version，或对象有 success: true。 */
export function newApiMarked(headers: Headers, body: unknown): boolean {
  return headers.has('x-new-api-version') || (isRecord(body) && body.success === true);
}

/** @brief §3.3 第 2 步：按主机认出的种类（精确匹配的部分）。 */
const HOST_KINDS: ReadonlyMap<string, ServerKind> = new Map([
  ['api.deepseek.com', 'deepseek'], ['api.moonshot.cn', 'moonshot'], ['api.moonshot.ai', 'moonshot'],
  ['api.kimi.com', 'moonshot'], ['dashscope.aliyuncs.com', 'dashscope'], ['dashscope-intl.aliyuncs.com', 'dashscope'],
  ['qianfan.baidubce.com', 'qianfan'], ['openrouter.ai', 'openrouter'], [ANTHROPIC_HOST, 'anthropic'],
]);

/** @brief §3.3 第 2 步：以这些结尾的主机是百炼。 */
const DASHSCOPE_SUFFIXES = ['.dashscope.aliyuncs.com', '.maas.aliyuncs.com'];

/** @brief §3.3 第 3 步：第一行的 owned_by 对应的种类。 */
const OWNER_KINDS: ReadonlyMap<string, ServerKind> = new Map([
  ['vllm', 'vllm'], ['sglang', 'sglang'], ['llamacpp', 'llamacpp'], ['lmdeploy', 'lmdeploy'],
  ['xinference', 'xinference'], ['tensorrt_llm', 'tensorrt'], ['MindIE Server', 'mindie'], ['gpustack', 'gpustack'],
]);

/** @brief §3.3 第 4 步：LiteLLM 列表行固定的 created。 */
const LITELLM_CREATED = 1677610602;

/** @brief §3.3 第 5 步：One API 列表行固定的 created。 */
const ONEAPI_CREATED = 1626777600;

/** @brief §3.3 第 2 步：按主机认出的种类；认不出时为 null。 */
function hostKind(host: string): ServerKind | null {
  const exact = HOST_KINDS.get(host);
  if (exact) return exact;
  return DASHSCOPE_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? 'dashscope' : null;
}

/**
 * @brief §3.3 第 1–5 步：第一条成立的就是种类。第 3 步看第一行，第 4、5 步要列表不为空（D7）。
 * @return 都不成立时为 null（发第 6 步的请求）
 */
export function judgeListKind(facts: ListFacts): ServerKind | null {
  if (facts.newApi) return 'newapi';
  const byHost = hostKind(facts.host);
  if (byHost) return byHost;
  const { rows } = facts;
  const owner = rows[0]?.owned_by;
  const byOwner = typeof owner === 'string' ? OWNER_KINDS.get(owner) : undefined;
  if (byOwner) return byOwner;
  if (rows.length === 0) return null;
  if (rows.every((row) => row.created === LITELLM_CREATED)) return 'litellm';
  if (rows.every((row) => row.created === ONEAPI_CREATED && 'permission' in row)) return 'oneapi';
  return null;
}

/** @brief §3.3 第 6 步并行 GET 的路径（<origin> 之后），按判断顺序。 */
export const PROBE_PATHS = Object.freeze({
  localai: '/.well-known/localai.json',
  ollama: '/api/version',
  llamacpp: '/props',
  lmstudio: '/api/v1/models',
  tgi: '/info',
});

/** @brief 对象里非空字符串的 version 字段。 */
function versionField(body: unknown): string | null {
  return isRecord(body) ? nonEmpty(body.version) : null;
}

/** @brief LM Studio：/api/v1/models 的 models 是数组，其中的项有 key（§3.3 第 6 步；空数组也算，没下载模型的 LM Studio）。 */
function lmstudioListed(body: unknown): boolean {
  const models = isRecord(body) ? body.models : undefined;
  return Array.isArray(models) && models.every((item) => isRecord(item) && 'key' in item);
}

/** @brief ollama 对列表的条件（§3.3 第 6 步，D7）：第一行有 owned_by 和 created。 */
function ollamaRows(rows: readonly Row[]): boolean {
  const first = rows[0];
  return first !== undefined && 'owned_by' in first && 'created' in first;
}

/**
 * @brief §3.3 第 6、7 步：localai（/.well-known/localai.json 是带 version 的 JSON）、ollama（/api/version 有 version，
 *        且第一行有 owned_by 和 created，D7）、llamacpp（/props 有 build_info）、lmstudio、tgi（/info 的 router 是
 *        text-generation-router）；都不是为 unknown。拿不到列表时 rows 为空（§7.1）。
 * @param probes 第 6 步的响应
 * @param rows 去重后的列表行
 */
export function judgeProbedKind(probes: KindProbes, rows: readonly Row[]): ServerKind {
  if (versionField(probes.get(PROBE_PATHS.localai)) !== null) return 'localai';
  if (versionField(probes.get(PROBE_PATHS.ollama)) !== null && ollamaRows(rows)) return 'ollama';
  if (nonEmpty(asRow(probes.get(PROBE_PATHS.llamacpp)).build_info) !== null) return 'llamacpp';
  if (lmstudioListed(probes.get(PROBE_PATHS.lmstudio))) return 'lmstudio';
  if (asRow(probes.get(PROBE_PATHS.tgi)).router === 'text-generation-router') return 'tgi';
  return 'unknown';
}

/**
 * @brief 第 6 步有能决定种类的请求没有得到回答（连接失败、超时）：种类为 unknown 时就是“种类因此判断为 unknown”，
 *        读版本按拿不到列表处理（§7.3）。/api/version 只在第一行有 owned_by 和 created 时才能决定种类（ollama 的条件）；
 *        404 等 HTTP 回答不算。
 * @param probes 第 6 步的响应（没有得到回答的为 undefined）
 * @param rows 去重后的列表行
 */
export function probesUnanswered(probes: KindProbes, rows: readonly Row[]): boolean {
  return Object.values(PROBE_PATHS).some((path) => probes.has(path) && probes.get(path) === undefined
    && (path !== PROBE_PATHS.ollama || ollamaRows(rows)));
}

/** @brief 一个种类的版本请求（§3.3 服务版本，沿用模型层规格 §7.1 的读法）。 */
export interface VersionRequest {
  /** <origin> 之后的路径；/api/version、/props 与第 6 步的同一个，第 6 步发过时不再发（§7.3） */
  path: string;
  /** 版本所在的字段 */
  field: string;
}

/** @brief 有版本请求的种类（§3.3）：vllm、sglang 读 /version，ollama 读 /api/version，llamacpp 读 /props 的 build_info。 */
const VERSION_REQUESTS: ReadonlyMap<ServerKind, VersionRequest> = new Map([
  ['vllm', { path: '/version', field: 'version' }],
  ['sglang', { path: '/version', field: 'version' }],
  ['ollama', { path: PROBE_PATHS.ollama, field: 'version' }],
  ['llamacpp', { path: PROBE_PATHS.llamacpp, field: 'build_info' }],
]);

/**
 * @brief 这个种类的版本请求（§3.3）。
 * @return 没有版本请求的种类为 null（版本为 null，档案键里写 unknown）
 */
export function versionRequest(kind: ServerKind): VersionRequest | null {
  return VERSION_REQUESTS.get(kind) ?? null;
}

/**
 * @brief 从版本请求的响应读版本（§3.3）。
 * @param body 版本请求的 JSON；取不到时为 null
 * @return 没有版本请求、或没有版本字段时为 null
 */
export function versionOf(kind: ServerKind, body: unknown): string | null {
  const request = versionRequest(kind);
  return request === null ? null : nonEmpty(asRow(body)[request.field]);
}

// ---- §4.1 读一行 ----

/**
 * @brief contextWindow 的路径，依次（正整数）。三个 meta.* 在 context_length 之前（§4.1 规格更正，2026-10-23）：
 *        它们只出现在 llama.cpp 与 GPUStack with_meta 的行里，是实际在用的窗口；llama.cpp router 的 context_length 是训练窗口。
 */
const WINDOW_PATHS = [
  'max_model_len', 'context_window', 'meta.max_model_len', 'meta.n_ctx', 'meta.max_total_tokens', 'context_length',
  'max_context_length', 'context_size', 'max_input_tokens', 'top_provider.context_length', 'metadata.context_length',
];

/** @brief maxTokens 的路径，依次（正整数）；列表是 Anthropic 形状或种类是 qianfan 时再看 max_tokens。 */
const MAX_TOKEN_PATHS = ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens'];

/** @brief reasoning：布尔真为报告支持，布尔假为明确没有。 */
const REASONING_BOOLS = ['supports_reasoning', 'capabilities.reasoning', 'capabilities.thinking.supported'];
/** @brief reasoning：对象存在为报告支持。 */
const REASONING_OBJECTS = ['effort', 'reasoning'];
/** @brief reasoning：数组含 reasoning 或 thinking 为报告支持。 */
const REASONING_ARRAYS = ['capabilities', 'features', 'supported_parameters', 'model_ability', 'tags', 'metadata.tags'];
/** @brief reasoning：数组存在但不含这两个词为明确没有。 */
const REASONING_NO_ARRAYS = ['capabilities', 'model_ability', 'supported_parameters'];
/** @brief reasoning：数组里表示支持思考的词。 */
const REASONING_WORDS = ['reasoning', 'thinking'];

/** @brief image：数组含 image 为报告支持，存在但不含为明确没有。 */
const IMAGE_MODALITIES = ['input_modalities', 'architecture.input_modalities', 'inference_metadata.request_modality'];
/** @brief image：布尔真为报告支持，布尔假为明确没有。 */
const IMAGE_BOOLS = [
  'supports_image_in', 'supportsImageInput', 'capabilities.vision', 'capabilities.image_input.supported',
];
/** @brief image：数组含 vision 或 vlm 为报告支持。 */
const IMAGE_ARRAYS = ['capabilities', 'model_ability', 'tags', 'metadata.tags'];
/** @brief image：数组存在但不含 vision 为明确没有。 */
const IMAGE_NO_ARRAYS = ['capabilities', 'model_ability'];

/** @brief family 的路径，依次（字符串）。 */
const FAMILY_PATHS = ['details.family', 'model_family'];

/** @brief chat：type 为这些时是聊天模型（model 不看，其他字符串为假）。 */
const CHAT_TYPES = new Set(['chat', 'llm', 'vlm', 'language', 'code']);
/** @brief chat：mode 为这些时是聊天模型（其他为假）。 */
const CHAT_MODES = new Set(['chat', 'responses', 'completion']);
/** @brief chat：数组 capabilities 含这些时为真。 */
const CHAT_CAPABILITIES = ['completion', 'chat'];
/** @brief chat：存在但不含 text 时为假。 */
const OUTPUT_MODALITIES = ['output_modalities', 'architecture.output_modalities'];
/** @brief chat：supported_endpoint_types 含这些时为真，否则为假（New API）。 */
const CHAT_ENDPOINTS = ['openai', 'openai-response', 'anthropic'];

/** @brief no_tools：布尔假为明确没有。 */
const TOOL_BOOLS = ['capabilities.function_calling', 'supports_function_calling', 'capabilities.trained_for_tool_use'];
/** @brief no_tools：数组存在但不含 tools 为明确没有。 */
const TOOL_ARRAYS = ['capabilities', 'model_ability', 'supported_parameters'];

/** @brief 第一个正整数；都不是时为 null。 */
function firstPositive(values: readonly unknown[]): number | null {
  for (const value of values) {
    const number = positiveInt(value);
    if (number !== null) return number;
  }
  return null;
}

/**
 * @brief maxTokens（§4.1）：依次找第一个正整数，不小于窗口的不算报告。
 * @param window 这一行的窗口（报告值或默认值）
 * @param override 详情的值（§4.2，优先）
 */
function readMaxTokens(row: Row, ctx: RowContext, window: number, override: number | null | undefined): number | null {
  const paths = ctx.anthropicShape || ctx.kind === 'qianfan' ? [...MAX_TOKEN_PATHS, 'max_tokens'] : MAX_TOKEN_PATHS;
  for (const value of [override, ...paths.map((path) => fieldAt(row, path))]) {
    const number = positiveInt(value);
    if (number !== null && number < window) return number;
  }
  return null;
}

/** @brief reasoning（§4.1）：先看报告支持的各项，再看明确报告“没有”的各项；都没有为 null。 */
function readReasoning(row: Row, ctx: RowContext): boolean | null {
  const bools = REASONING_BOOLS.map((path) => boolAt(row, path, ctx));
  if (bools.includes(true) || REASONING_OBJECTS.some((path) => isRecord(fieldAt(row, path)))
    || REASONING_ARRAYS.some((path) => hasWord(wordsAt(row, path), REASONING_WORDS))) return true;
  if (bools.includes(false) || REASONING_NO_ARRAYS.some((path) => wordsAt(row, path) !== null)) return false;
  return null;
}

/** @brief image（§4.1）：先看报告支持的各项，再看明确报告“没有”的各项；都没有为 null。 */
function readImage(row: Row, ctx: RowContext): boolean | null {
  const bools = IMAGE_BOOLS.map((path) => boolAt(row, path, ctx));
  if (IMAGE_MODALITIES.some((path) => hasWord(wordsAt(row, path), ['image'])) || bools.includes(true)
    || IMAGE_ARRAYS.some((path) => hasWord(wordsAt(row, path), ['vision', 'vlm'])) || row.type === 'vlm') return true;
  if (bools.includes(false) || IMAGE_MODALITIES.some((path) => wordsAt(row, path) !== null)
    || IMAGE_NO_ARRAYS.some((path) => wordsAt(row, path) !== null)) return false;
  return null;
}

/** @brief family（§4.1）：第一个非空字符串；没有为 null。 */
function readFamily(row: Row): string | null {
  for (const path of FAMILY_PATHS) {
    const family = nonEmpty(fieldAt(row, path));
    if (family !== null) return family;
  }
  return null;
}

/** @brief chat 的 model_type（§4.1）：LLM 为真，但 model_ability 存在且不含 chat 时为假；其他为假。 */
function modelTypeChat(row: Row, modelType: string): boolean {
  const ability = wordsAt(row, 'model_ability');
  return modelType === 'LLM' && (ability === null || ability.includes('chat'));
}

/**
 * @brief chat（§4.1）：按表的顺序，第一个能下结论的；都不能为 null。capabilities.completion_chat 在 type 之前
 *        （§4.1 规格更正，2026-10-23：Mistral 的行同时有 type: "base"）。
 */
function readChat(row: Row, ctx: RowContext): boolean | null {
  const completionChat = boolAt(row, 'capabilities.completion_chat', ctx);
  if (completionChat !== null) return completionChat;
  const { type, mode, model_type: modelType } = row;
  if (typeof type === 'string' && type !== 'model') return CHAT_TYPES.has(type);
  if (typeof mode === 'string') return CHAT_MODES.has(mode);
  if (typeof modelType === 'string') return modelTypeChat(row, modelType);
  const capabilities = wordsAt(row, 'capabilities');
  if (capabilities !== null && capabilities.length > 0) return hasWord(capabilities, CHAT_CAPABILITIES);
  const outputs = OUTPUT_MODALITIES.map((path) => wordsAt(row, path));
  if (outputs.some((words) => words !== null && !words.includes('text'))) return false;
  const endpoints = wordsAt(row, 'supported_endpoint_types');
  return endpoints === null ? null : hasWord(endpoints, CHAT_ENDPOINTS);
}

/** @brief no_tools（§4.1，只记“没有”）：有一项报告支持时没有提示；否则有一项明确没有时为真。 */
function readNoTools(row: Row, ctx: RowContext): boolean {
  const bools = TOOL_BOOLS.map((path) => boolAt(row, path, ctx));
  const arrays = TOOL_ARRAYS.map((path) => wordsAt(row, path)).filter((words) => words !== null);
  if (bools.includes(true) || arrays.some((words) => words.includes('tools'))) return false;
  return bools.includes(false) || arrays.length > 0;
}

/**
 * @brief 读一行（§4.1）：每个字段按表从左到右找第一个有效值；§4.2 的详情先合并进来，详情的值优先。
 * @param row 列表的一行
 * @param ctx 种类与列表形状
 * @param detail 这一行的详情；没有时为空
 */
export function readRow(row: Row, ctx: RowContext, detail: RowDetail = {}): RowValues {
  const fields = { ...row, ...detail.fields };
  const values = detail.values ?? {};
  const contextWindow = firstPositive([values.contextWindow, ...WINDOW_PATHS.map((path) => fieldAt(fields, path)),
    detail.fallbackWindow]);
  const window = contextWindow ?? UNREPORTED_CONTEXT_WINDOW;
  return {
    contextWindow,
    maxTokens: readMaxTokens(fields, ctx, window, values.maxTokens),
    reasoning: values.reasoning ?? readReasoning(fields, ctx),
    image: values.image ?? readImage(fields, ctx),
    family: values.family ?? readFamily(fields),
    chat: values.chat ?? readChat(fields, ctx),
    noTools: values.noTools ?? readNoTools(fields, ctx),
  };
}

/** @brief 这个种类的 LoRA 行用 parent 那一行的窗口（§4.1：只有 vLLM、SGLang）。 */
export function usesParentWindow(kind: ServerKind): boolean {
  return kind === 'vllm' || kind === 'sglang';
}

/**
 * @brief vLLM、SGLang 的 LoRA 行（§4.1）：parent 不为 null 且没有窗口时用 parent 那一行的窗口。
 * @param rows 列表行
 * @param values 与 rows 一一对应的读取结果
 * @return 新的读取结果；其他种类原样返回
 */
export function parentWindows(kind: ServerKind, rows: readonly Row[], values: readonly RowValues[]): RowValues[] {
  if (!usesParentWindow(kind)) return [...values];
  const windows = new Map(rows.map((row, index) => [rowId(row), values[index].contextWindow]));
  return values.map((value, index) => {
    const parent = rows[index].parent;
    if (value.contextWindow !== null || typeof parent !== 'string') return value;
    return { ...value, contextWindow: windows.get(parent) ?? null };
  });
}

// ---- §4.2 按种类合并详情 ----

/** @brief 每一行都合并同一份详情（llama.cpp 的 /props、TGI 的 /info）。 */
export function sameDetail(rows: readonly Row[], detail: RowDetail): Map<string, RowDetail> {
  return new Map(rows.map((row) => [rowId(row), detail]));
}

/**
 * @brief SGLang 的 /model_info（§4.2），只合并进 parent 为 null 的行：reasoning_parser 不为 null → reasoning 真，
 *        为 null → 明确没有；has_image_understanding → image；tool_call_parser 为 null → no_tools；is_generation 为假 → chat 假。
 * @param info /model_info 的 JSON；失败时为 null
 */
export function sglangDetails(rows: readonly Row[], info: unknown): Map<string, RowDetail> {
  if (!isRecord(info)) return new Map();
  const values: Partial<RowValues> = {};
  if (info.reasoning_parser !== undefined) values.reasoning = info.reasoning_parser !== null;
  if (typeof info.has_image_understanding === 'boolean') values.image = info.has_image_understanding;
  if (info.tool_call_parser === null) values.noTools = true;
  if (info.is_generation === false) values.chat = false;
  return sameDetail(rows.filter((row) => row.parent === null || row.parent === undefined), { values });
}

/**
 * @brief llama.cpp 的 /props（§4.2）：行里没有窗口时取 default_generation_settings.n_ctx（大于 0 才算）；
 *        modalities.vision → image。
 * @param props /props 的 JSON；失败时为 null
 */
export function llamacppDetail(props: unknown): RowDetail {
  const body = asRow(props);
  const vision = fieldAt(body, 'modalities.vision');
  const window = positiveInt(fieldAt(body, 'default_generation_settings.n_ctx'));
  return { ...(window === null ? {} : { fallbackWindow: window }),
    values: typeof vision === 'boolean' ? { image: vision } : {} };
}

/** @brief Ollama /api/tags、/api/ps 的 models 里名字为 name 的那一项；没有时为空对象。 */
function ollamaModel(body: unknown, name: string): Row {
  const models = asRow(body).models;
  return Array.isArray(models) ? asRow(models.find((item) => asRow(item).name === name)) : {};
}

/** @brief /api/show 的 parameters（Modelfile 参数，每行“名字 值”）里的 num_ctx。 */
function modelfileWindow(parameters: unknown): number | null {
  if (typeof parameters !== 'string') return null;
  return positiveInt(/^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters)?.[1]);
}

/** @brief /api/show 的 model_info["<general.architecture>.context_length"]（训练窗口）。 */
function showTrainedWindow(show: Row): number | null {
  const info = asRow(show.model_info);
  const architecture = nonEmpty(info['general.architecture']);
  return architecture === null ? null : positiveInt(info[`${architecture}.context_length`]);
}

/**
 * @brief Ollama 的一个模型（§4.2）：按名字对上 /api/tags（没有 capabilities 时用 /api/show）的 capabilities 与
 *        details.family，合并进行再按 §4.1 读；窗口依次取 /api/ps 的 context_length、/api/show parameters 的 num_ctx、
 *        /api/tags 的 details.context_length 或 /api/show 的训练窗口，用到最后一种时 trained 为真。
 * @param id 模型 id（Ollama 的名字）
 */
export function ollamaDetail(id: string, bodies: OllamaBodies): RowDetail {
  const tag = ollamaModel(bodies.tags, id);
  const show = asRow(bodies.show);
  const capabilities = Array.isArray(tag.capabilities) ? tag.capabilities : show.capabilities;
  const family = nonEmpty(fieldAt(tag, 'details.family')) ?? nonEmpty(fieldAt(show, 'details.family'));
  const fields: Row = {};
  if (Array.isArray(capabilities)) fields.capabilities = capabilities;
  if (family !== null) fields.details = { family };
  const current = positiveInt(ollamaModel(bodies.ps, id).context_length) ?? modelfileWindow(show.parameters);
  const trained = positiveInt(fieldAt(tag, 'details.context_length')) ?? showTrainedWindow(show);
  const contextWindow = current ?? trained;
  const values: Partial<RowValues> = contextWindow === null ? {} : { contextWindow };
  return { fields, values, trained: current === null && trained !== null };
}

/** @brief LM Studio 一个模型的已加载实例。 */
function loadedInstances(model: Row): Row[] {
  return Array.isArray(model.loaded_instances) ? model.loaded_instances.map(asRow) : [];
}

/**
 * @brief LM Studio 的一个模型（§4.2）：按 key 或 loaded_instances[].id 对上；窗口依次取
 *        loaded_instances[0].config.context_length、max_context_length；capabilities.vision → image；
 *        capabilities.reasoning 存在 → reasoning 真；capabilities.trained_for_tool_use 为假 → no_tools；type → chat。
 * @param body 第 6 步的 /api/v1/models
 * @return 对不上时为 undefined
 */
export function lmstudioDetail(body: unknown, id: string): RowDetail | undefined {
  const models = asRow(body).models;
  if (!Array.isArray(models)) return undefined;
  const model = models.map(asRow).find((item) => item.key === id || loadedInstances(item).some((it) => it.id === id));
  if (!model) return undefined;
  const values: Partial<RowValues> = {};
  const window = positiveInt(fieldAt(loadedInstances(model)[0] ?? {}, 'config.context_length'))
    ?? positiveInt(model.max_context_length);
  if (window !== null) values.contextWindow = window;
  const vision = fieldAt(model, 'capabilities.vision');
  if (typeof vision === 'boolean') values.image = vision;
  const reasoning = fieldAt(model, 'capabilities.reasoning');
  if (reasoning !== undefined && reasoning !== null) values.reasoning = true;
  if (fieldAt(model, 'capabilities.trained_for_tool_use') === false) values.noTools = true;
  return { fields: typeof model.type === 'string' ? { type: model.type } : {}, values };
}

/** @brief LM Studio 的全部行（§4.2）。 */
export function lmstudioDetails(rows: readonly Row[], body: unknown): Map<string, RowDetail> {
  const details = new Map<string, RowDetail>();
  for (const row of rows) {
    const detail = lmstudioDetail(body, rowId(row));
    if (detail) details.set(rowId(row), detail);
  }
  return details;
}

/** @brief MindIE 的 /v2/models/<id>/config（§4.2）：max_seq_len → 窗口。 */
export function mindieDetail(config: unknown): RowDetail {
  const window = positiveInt(asRow(config).max_seq_len);
  return window === null ? {} : { values: { contextWindow: window } };
}

/** @brief TGI 的 /info（§4.2）：max_total_tokens → 窗口（列表只有一行）。 */
export function tgiDetail(info: unknown): RowDetail {
  const window = positiveInt(asRow(info).max_total_tokens);
  return window === null ? {} : { values: { contextWindow: window } };
}

/** @brief LocalAI /models/capabilities 合并进行的字段（§4.2）。 */
const LOCALAI_FIELDS = ['capabilities', 'input_modalities', 'output_modalities', 'context_size'];

/**
 * @brief LocalAI 的 <base>/models/capabilities（§4.2）：按 id 对上，capabilities、input_modalities、output_modalities、
 *        context_size 合并进行再按 §4.1 读；同一个 id 只取第一次出现的。
 * @param items 响应里的各项（listRows 读出：数组，或对象的 data 是数组）；请求失败时为空
 */
export function localaiDetails(items: readonly Row[]): Map<string, RowDetail> {
  const details = new Map<string, RowDetail>();
  for (const item of items) {
    const fields = Object.fromEntries(LOCALAI_FIELDS.filter((name) => name in item).map((name) => [name, item[name]]));
    if (!details.has(rowId(item))) details.set(rowId(item), { fields });
  }
  return details;
}

/**
 * @brief 百炼原生列表一页的模型（§4.2：output.models）。
 * @return 不是这个形状时为 null
 */
export function dashscopeModels(body: unknown): Row[] | null {
  const models = fieldAt(asRow(body), 'output.models');
  return Array.isArray(models) ? models.map(asRow) : null;
}

/**
 * @brief 百炼的一个模型（§4.2）：model_info.context_window → 窗口；model_info.max_output_tokens → 输出；
 *        capabilities 含 Reasoning → reasoning；capabilities 含 VU 或 inference_metadata.request_modality 含 Image →
 *        image；features 存在但不含 function-calling → no_tools；capabilities 含 TG → chat 真，不含为假。
 *        inference_metadata.request_modality 原样合并进行，按 §4.1 读（不含 Image 时明确报告没有图片）；
 *        capabilities、features、model_info 不原样合并（§4.2 规格更正，2026-10-23）。
 */
export function dashscopeDetail(model: Row): RowDetail {
  const capabilities = wordsAt(model, 'capabilities');
  const features = wordsAt(model, 'features');
  const values: Partial<RowValues> = {};
  const window = positiveInt(fieldAt(model, 'model_info.context_window'));
  const maxTokens = positiveInt(fieldAt(model, 'model_info.max_output_tokens'));
  if (window !== null) values.contextWindow = window;
  if (maxTokens !== null) values.maxTokens = maxTokens;
  if (hasWord(capabilities, ['reasoning'])) values.reasoning = true;
  if (hasWord(capabilities, ['vu']) || hasWord(wordsAt(model, 'inference_metadata.request_modality'), ['image'])) {
    values.image = true;
  }
  if (features !== null && !features.includes('function-calling')) values.noTools = true;
  if (capabilities !== null) values.chat = capabilities.includes('tg');
  const modality = fieldAt(model, 'inference_metadata.request_modality');
  return { fields: modality === undefined ? {} : { inference_metadata: { request_modality: modality } }, values };
}

/** @brief 百炼的全部模型按 model 对上（§4.2）；同一个 model 只取第一次出现的。 */
export function dashscopeDetails(models: readonly Row[]): Map<string, RowDetail> {
  const details = new Map<string, RowDetail>();
  for (const model of models) {
    if (typeof model.model === 'string' && !details.has(model.model)) details.set(model.model, dashscopeDetail(model));
  }
  return details;
}

// ---- §4.3 能不能用、最后的检查 ----

/**
 * @brief 不能加入的原因（§4.3，模型层规格 §4.1：id 非空、不含空白）。
 * @return 能加入为 null
 */
export function unusableReason(id: string): string | null {
  if (id === '') return 'the ID is empty';
  return /\s/.test(id) ? 'the ID contains spaces' : null;
}

/**
 * @brief 发现的一个模型（§4.1 的默认值、§4.3、§5.2）：没报告的窗口为 128000；输出上限不小于窗口时按没报告，
 *        取 16384 与窗口一半中较小的；reasoning、image 没报告时不勾；family 没报告时为空字符串。
 * @param id 列表里的 id，原样
 * @param values §4.1 读到的值
 */
export function finalizeModel(id: string, values: RowValues, flags: ModelFlags): DiscoveredModel {
  const contextWindow = values.contextWindow ?? UNREPORTED_CONTEXT_WINDOW;
  const maxTokens = values.maxTokens !== null && values.maxTokens < contextWindow ? values.maxTokens : null;
  const hints: DiscoverHint[] = [];
  if (values.noTools) hints.push('no_tools');
  if (flags.trained) hints.push('trained_window');
  return {
    id,
    contextWindow,
    maxTokens: maxTokens ?? unreportedMaxTokens(contextWindow),
    reasoning: values.reasoning === true,
    image: values.image === true,
    family: values.family ?? '',
    chat: values.chat,
    reported: { contextWindow: values.contextWindow !== null, maxTokens: maxTokens !== null,
      reasoning: values.reasoning !== null, image: values.image !== null, family: values.family !== null },
    hints,
    unusable: unusableReason(id),
    added: flags.added,
  };
}
