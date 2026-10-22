// 探针（docs/specs/model-providers.md §7.3、§7.4）：第 0–9 步的请求与判定。
// 依赖全部注入（pi 的 streamSimple、模型池给的 fetch、读服务端接口的 GET、时长与 signal），所以可以用替身做单元测试；
// 档案的派生（能力三态、等级）在 modelProfiles.ts；第 5–7 步三种写法的请求改写与标签解析在 forcedWrite.ts（与强制填写共用）。

import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Api, AssistantMessage, AssistantMessageEvent, Context, FetchFunction, Message, Model, SimpleStreamOptions, Tool,
  ToolCall,
} from '@earendil-works/pi-ai';
import type { ApiType, ProbeStepResult, ReasoningField, ServerKind, ThinkingLevel } from '../shared/models';
import { forcedToolChoice, parseTagged, withJsonSchema, withStrictTools } from './forcedWrite';
import type { AutoResults, AutoSteps, CancelResult, LongInputResult } from './modelProfiles';
import type { ModelTimings } from './modelTimings';
import type { ModelRef, SchedClass } from './modelTypes';

// ---- §7.3 的提示原文与工具 ----

/** @brief 各步的提示原文（§7.3）。 */
export const PROBE_PROMPTS = Object.freeze({
  /** 第 1、2 步 */
  ready: 'Reply with the single word: ready.',
  /** 第 3 步 */
  weather: 'Use the tool to get the weather for Paris for the next 3 days.',
  /** 第 4 步的工具结果 */
  weatherResult: 'Paris: 21°C, sunny for 3 days.',
  /** 第 4 步的问题 */
  temperature: 'What temperature did the tool report?',
  /** 第 5 步 */
  outcome: 'Call submit_outcome with outcome banana.',
  /** 第 6 步 */
  json: 'Reply with JSON whose outcome is banana.',
  /** 第 7 步 */
  tagged: 'Answer in exactly this format: <summary>one sentence</summary><outcome>ok or fail</outcome>. '
    + 'Question: is 2 + 2 equal to 4?',
  /** 第 8 步的问题 */
  passphrase: 'What is the passphrase?',
  /** 第 9 步 */
  count: 'Count from 1 to 400, one number per line.',
});

/** @brief 第 5、6、7 步的取值列表。 */
const OUTCOMES = ['ok', 'fail'];

/** @brief 第 5 步工具与第 6 步 schema 共用的 { outcome: "ok" | "fail" }（严格模式要求列全 required、不许多余字段）。 */
export const OUTCOME_SCHEMA = Object.freeze({
  type: 'object',
  properties: { outcome: { type: 'string', enum: OUTCOMES } },
  required: ['outcome'],
  additionalProperties: false,
});

/** @brief 第 6 步 JSON schema 的名字。 */
const OUTCOME_SCHEMA_NAME = 'outcome';

/** @brief 第 3 步的工具 get_weather({ city: string, days: integer })。 */
export const WEATHER_TOOL: Tool = {
  name: 'get_weather',
  description: 'Get the weather forecast for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' }, days: { type: 'integer' } },
    required: ['city', 'days'],
  } as unknown as Tool['parameters'],
};

/** @brief 第 5 步的工具 submit_outcome({ outcome: "ok" | "fail" })。 */
export const OUTCOME_TOOL: Tool = {
  name: 'submit_outcome',
  description: 'Submit the outcome.',
  parameters: OUTCOME_SCHEMA as unknown as Tool['parameters'],
};

/** @brief 自动探针的步数（第 0–7 步）。 */
const AUTO_STEPS = 8;

/** @brief pi 估算 token 的方式：每 4 个字符算 1 个 token（pi 的 estimateTokens）。 */
const CHARS_PER_TOKEN = 4;

/** @brief pi 表示“不限时”的 timeoutMs（§8.4）。 */
const NO_TIMEOUT_MS = 2147483647;

/** @brief 有内容的事件：正文、思考、工具调用的开始或增量（§7.3、§11.2）。 */
const CONTENT_EVENTS = new Set<AssistantMessageEvent['type']>([
  'text_start', 'text_delta', 'thinking_start', 'thinking_delta', 'toolcall_start', 'toolcall_delta',
]);

/** @brief 有服务端进行中请求数可读的服务（第 9 步）。 */
const METRIC_KINDS: ReadonlySet<ServerKind> = new Set(['vllm', 'sglang', 'llamacpp']);

// ---- 依赖与输入 ----

/** @brief streamSimple 返回的事件流：异步迭代事件，结束后 result() 给出最终的助手消息。 */
export interface ProbeStream extends AsyncIterable<AssistantMessageEvent> {
  /** @brief 最终的助手消息 */
  result(): Promise<AssistantMessage>;
}

/** @brief 探针向模型池要 fetch 时给出的内容（对应 ModelPool.createFetch 的选项）。 */
export interface ProbeFetchRequest {
  /** 模型 <provider>/<model> */
  ref: ModelRef;
  /** 调度类别：探针为 background（§8.2） */
  cls: Extract<SchedClass, 'background'>;
  /** 这组探针的 signal：取消探针、删除模型时出队、不再重试 */
  signal: AbortSignal;
  /** 这次尝试的控制器的 signal：首个内容超时时触发，分类 timeout */
  attemptSignal: AbortSignal;
  /** @brief 每次真正发出（含换 key、原地重试）时回调，首个内容的时限从这里起算（§7.4） */
  onSent(): void;
}

/** @brief 探针的依赖（§7.3）。 */
export interface ProbeDeps {
  /**
   * @brief pi 的 ModelRuntime.streamSimple，直接用实际模型（§11.6 K10）。
   * @param model 实际模型
   * @param context 上下文
   * @param options 选项（带模型池的 fetch、maxRetries: 0、不限时的 timeoutMs）
   */
  streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions): ProbeStream;
  /**
   * @brief 模型池给这个模型一次请求用的 fetch（§8.4，ModelPool.createFetch）。
   * @param request 模型、调度类别、取消与发出回调
   */
  fetchFor(request: ProbeFetchRequest): FetchFunction;
  /**
   * @brief 第 0 步与第 9 步的 GET（带这个提供商的认证由调用方处理）。
   * @param url 完整地址
   * @param signal 取消
   * @return 2xx 时的响应正文；连接失败或非 2xx 时为 null
   */
  getText(url: string, signal: AbortSignal): Promise<string | null>;
  /** @brief 当前时刻（ms），用于消息的时间戳 */
  now(): number;
  /** 时长与次数（§12） */
  timings: ModelTimings;
  /** 取消这组探针（新的一组开始、删除模型时） */
  signal: AbortSignal;
  /**
   * @brief 进度：开始跑某一步时回调（mori.profiles 的 running）。
   * @param step §7.3 的步号
   * @param of 这组共几步
   */
  onStep?(step: number, of: number): void;
  /** @brief 等待（第 9 步的 5 秒窗口）；省略时用计时器 */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** @brief 第 8 步的随机暗号；省略时随机生成 */
  randomWord?(): string;
}

/** @brief 要探测的模型。 */
export interface ProbeTarget {
  /** <provider>/<model> */
  ref: ModelRef;
  /** pi 里注册的实际模型（api、baseUrl、id、reasoning、compat） */
  model: Model<Api>;
}

/** @brief 一次探针请求的结果。 */
export interface ProbeReply {
  /** 结束的助手消息；出错、或收到内容即断开时为 null */
  message: AssistantMessage | null;
  /** 出错（连接、HTTP 错误、超时）时的原文；没有出错时为 null */
  error: string | null;
  /** 最后一次 HTTP 响应的状态；没有收到响应时为 null */
  status: number | null;
  /** 收到了有内容的事件 */
  content: boolean;
}

/** @brief 一次探针请求。 */
interface ProbeRequest {
  /** 发给的模型（第 4 步的“不带”用副本） */
  model: Model<Api>;
  /** 上下文 */
  context: Context;
  /** 思考强度 */
  thinking: ThinkingLevel;
  /** 最大输出；省略时为 §12 的探针最大输出 */
  maxTokens?: number;
  /** 指定调用的 tool_choice（第 5 步） */
  toolChoice?: unknown;
  /** 改写请求体（第 5 步严格模式、第 6 步 schema） */
  onPayload?: (payload: unknown) => unknown;
  /** 收到第一段内容就断开（第 9 步） */
  stopOnContent?: boolean;
}

/** @brief 一组探针共用的上下文。 */
interface Run {
  /** 依赖 */
  deps: ProbeDeps;
  /** 要探测的模型 */
  target: ProbeTarget;
}

/** @brief 这组探针被取消。 */
class ProbeCancelled extends Error {
  constructor() {
    super('Probe cancelled');
  }
}

// ---- 一次请求 ----

/** @brief 首个内容的时限：每次 onSent 重新计时，收到内容后停止；超时中止这次尝试。 */
function firstContentWatch(ms: number, attempt: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = {
    timedOut: false,
    arm: () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        watch.timedOut = true;
        attempt.abort();
      }, ms);
    },
    clear: () => clearTimeout(timer),
  };
  return watch;
}

/** @brief 一次请求的选项（§7.3：Mori 的 fetch、maxRetries: 0、不限时的 timeoutMs、最大输出）。 */
function requestOptions(run: Run, req: ProbeRequest, fetch: FetchFunction, signal: AbortSignal): SimpleStreamOptions {
  const { timings } = run.deps;
  const options: SimpleStreamOptions = {
    apiKey: timings.placeholderApiKey, fetch, signal, maxRetries: 0, timeoutMs: NO_TIMEOUT_MS,
    maxTokens: req.maxTokens ?? timings.probeMaxTokens,
  };
  // pi 的三种接口都把不传 reasoning 当作思考 off
  if (req.thinking !== 'off') options.reasoning = req.thinking;
  if (req.toolChoice !== undefined) options.toolChoice = req.toolChoice as SimpleStreamOptions['toolChoice'];
  if (req.onPayload) options.onPayload = req.onPayload;
  return options;
}

/**
 * @brief 读完事件流；第一个有内容的事件时回调一次。stop 为真时收到内容就停止读（调用方已中止这次尝试）。
 * @return 收到了有内容的事件
 */
async function drain(stream: ProbeStream, onContent: () => void, stop: boolean): Promise<boolean> {
  let content = false;
  for await (const event of stream) {
    if (content || !CONTENT_EVENTS.has(event.type)) continue;
    content = true;
    onContent();
    if (stop) break;
  }
  return content;
}

/**
 * @brief 发一次探针请求，经模型池的 background 类别；发出后 §12 的时长内没有第一个有内容的事件就中止，按出错处理。
 * @throws ProbeCancelled 这组探针被取消
 */
async function send(run: Run, req: ProbeRequest): Promise<ProbeReply> {
  const { deps } = run;
  if (deps.signal.aborted) throw new ProbeCancelled();
  const attempt = new AbortController();
  const watch = firstContentWatch(deps.timings.probeStepTimeoutMs, attempt);
  let status: number | null = null;
  const poolFetch = deps.fetchFor({ ref: run.target.ref, cls: 'background', signal: deps.signal,
    attemptSignal: attempt.signal, onSent: watch.arm });
  const fetch = (async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    const response = await poolFetch(input, init);
    status = response.status;
    return response;
  }) as FetchFunction;
  const signal = AbortSignal.any([deps.signal, attempt.signal]);
  let content = false;
  try {
    const stream = deps.streamSimple(req.model, req.context, requestOptions(run, req, fetch, signal));
    content = await drain(stream, () => {
      watch.clear();
      if (req.stopOnContent) attempt.abort();
    }, req.stopOnContent === true);
    const message = req.stopOnContent && content ? null : await stream.result();
    return finish(run, { message, error: null, status, content }, watch.timedOut);
  } catch (error) {
    if (deps.signal.aborted) throw new ProbeCancelled();
    return finish(run, { message: null, error: (error as Error).message, status, content }, watch.timedOut);
  } finally {
    watch.clear();
  }
}

/** @brief 整理一次请求的结果：取消时抛出；超时与出错的消息写成 error。 */
function finish(run: Run, reply: ProbeReply, timedOut: boolean): ProbeReply {
  if (run.deps.signal.aborted) throw new ProbeCancelled();
  const seconds = run.deps.timings.probeStepTimeoutMs / 1000;
  if (timedOut && !reply.content) {
    return { ...reply, message: null, error: `No response within ${seconds} s` };
  }
  const message = reply.message;
  if (message && (message.stopReason === 'error' || message.stopReason === 'aborted')) {
    return { ...reply, message: null, error: message.errorMessage ?? `Request ended with ${message.stopReason}` };
  }
  return reply;
}

// ---- 消息与判定的小工具 ----

/** @brief 一条用户消息。 */
function user(run: Run, text: string): Message {
  return { role: 'user', content: text, timestamp: run.deps.now() };
}

/** @brief 助手消息的正文。 */
export function replyText(message: AssistantMessage | null): string {
  if (!message) return '';
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** @brief 助手消息里有思考内容。 */
export function hasThinking(message: AssistantMessage | null): boolean {
  return !!message?.content.some((block) => block.type === 'thinking'
    && (block.thinking.trim() !== '' || block.redacted === true));
}

/** @brief 助手消息里第一个叫 name 的工具调用。 */
function toolCall(message: AssistantMessage | null, name: string): ToolCall | undefined {
  return message?.content.find((block): block is ToolCall => block.type === 'toolCall' && block.name === name);
}

/** @brief 一步的结果。 */
function step(outcome: ProbeStepResult['outcome'], detail: string | null = null): ProbeStepResult {
  return { outcome, detail };
}

/** @brief 出错时为 error 结果，否则交给 judge 判定。 */
function judged(reply: ProbeReply, judge: (message: AssistantMessage | null) => ProbeStepResult): ProbeStepResult {
  return reply.error !== null ? step('error', reply.error) : judge(reply.message);
}

/** @brief 第 1 步：有正文即通过。 */
export function judgeReady(reply: ProbeReply): ProbeStepResult {
  return judged(reply, (message) => (replyText(message).trim() !== '' ? step('pass')
    : step('fail', 'The reply has no text')));
}

/** @brief 第 2 步（思考 off 的那次）：没有思考内容即能关掉思考。 */
export function judgeThinkingOff(reply: ProbeReply): ProbeStepResult {
  return judged(reply, (message) => (hasThinking(message)
    ? step('fail', 'The reply has thinking content with thinking off') : step('pass')));
}

/** @brief 第 3 步：调用了 get_weather，city 是字符串，days 是整数（不是字符串）。 */
export function judgeWeatherCall(reply: ProbeReply): ProbeStepResult {
  return judged(reply, (message) => {
    const call = toolCall(message, WEATHER_TOOL.name);
    if (!call) return step('fail', 'The model did not call get_weather');
    const { city, days } = call.arguments;
    if (typeof city !== 'string') return step('fail', 'get_weather: city is not a string');
    if (typeof days !== 'number' || !Number.isInteger(days)) return step('fail', 'get_weather: days is not an integer');
    return step('pass');
  });
}

/** @brief 第 4 步：回答含 21。 */
export function judgeTemperature(reply: ProbeReply): ProbeStepResult {
  return judged(reply, (message) => (replyText(message).includes('21') ? step('pass')
    : step('fail', 'The answer does not contain the reported temperature 21')));
}

/**
 * @brief 第 5、6 步：服务端回 400 或 422（拒绝指定调用或 JSON schema 这个功能）算判定为不通过，原文记在说明里；
 *        连接错误、其他 4xx（认证、超时、限流）、5xx、超时仍是出错（§7.3）。其余交给 judge 判定。
 */
function judgedFeature(reply: ProbeReply,
  judge: (message: AssistantMessage | null) => ProbeStepResult): ProbeStepResult {
  return rejected(reply) ? step('fail', reply.error) : judged(reply, judge);
}

/** @brief 第 5 步：调用了 submit_outcome 且 outcome 在枚举内；服务端拒绝指定调用（4xx）为不通过。 */
export function judgeOutcomeCall(reply: ProbeReply): ProbeStepResult {
  return judgedFeature(reply, (message) => {
    const call = toolCall(message, OUTCOME_TOOL.name);
    if (!call) return step('fail', 'The model did not call submit_outcome');
    const outcome = call.arguments.outcome;
    return typeof outcome === 'string' && OUTCOMES.includes(outcome) ? step('pass')
      : step('fail', `submit_outcome: outcome ${JSON.stringify(outcome)} is not ok or fail`);
  });
}

/** @brief 第 6 步：正文是合法 JSON 且 outcome 在枚举内；服务端拒绝 JSON schema（4xx）为不通过。 */
export function judgeJsonOutcome(reply: ProbeReply): ProbeStepResult {
  return judgedFeature(reply, (message) => {
    let data: unknown;
    try {
      data = JSON.parse(replyText(message).trim());
    } catch {
      return step('fail', 'The reply is not valid JSON');
    }
    const outcome = (data as { outcome?: unknown } | null)?.outcome;
    return typeof outcome === 'string' && OUTCOMES.includes(outcome) ? step('pass')
      : step('fail', `outcome ${JSON.stringify(outcome)} is not ok or fail`);
  });
}

/** @brief 第 7 步：每次都能解析、取值都在列表内为通过。 */
export function judgeTagged(replies: readonly ProbeReply[]): ProbeStepResult {
  const failed = replies.find((reply) => reply.error !== null);
  if (failed) return step('error', failed.error);
  return replies.every((reply) => parseTagged(replyText(reply.message), OUTCOMES)) ? step('pass')
    : step('fail', 'A reply did not follow the <summary>/<outcome> format');
}

/** 服务端拒绝这个请求本身的状态（参数或功能不被接受）；401、403、408、429 等是认证或可用性问题，仍算出错（§7.3） */
const REJECTED_STATUSES: readonly number[] = [400, 422];

/** @brief 请求被服务端拒绝（400、422）。 */
function rejected(reply: ProbeReply): boolean {
  return reply.error !== null && reply.status !== null && REJECTED_STATUSES.includes(reply.status);
}

/**
 * @brief 第 4 步的回传检查：“不带”被拒（4xx）而“带上”通过为 required（fail），都通过为 not_required（pass）。
 * @param withThinking 原样发出的那次
 * @param without 去掉思考块、副本上关掉回传后发出的那次
 */
export function judgeReplay(withThinking: ProbeReply, without: ProbeReply): ProbeStepResult {
  const withPass = judgeTemperature(withThinking).outcome === 'pass';
  if (withPass && judgeTemperature(without).outcome === 'pass') return step('pass');
  if (withPass && rejected(without)) return step('fail', without.error);
  const failed = [withThinking, without].find((reply) => reply.error !== null && !rejected(reply));
  if (failed) return step('error', failed.error);
  return step('not_run', 'The replay check was inconclusive');
}

/**
 * @brief 推理字段名（openai-completions）：pi-ai 把字段名记在思考块的 thinkingSignature 里；
 *        有 reasoning_details 时被覆盖成 JSON，这时按 reasoning_content；没有思考内容为 none。
 * @param messages 第 1、2、4 步返回的助手消息
 */
export function reasoningFieldOf(messages: readonly (AssistantMessage | null)[]): ReasoningField {
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (block.type !== 'thinking' || block.thinking.trim() === '') continue;
      const signature = block.thinkingSignature;
      if (signature === 'reasoning_content' || signature === 'reasoning' || signature === 'reasoning_text') {
        return signature;
      }
      return 'reasoning_content';
    }
  }
  return 'none';
}

// ---- 第 0 步：服务种类、版本与报告的窗口 ----

/** @brief 第 0 步读到的服务信息。 */
export interface ServerInfo {
  /** 服务种类 */
  kind: ServerKind;
  /** 服务版本；取不到时为 null */
  version: string | null;
  /** 服务报告的窗口；没有时为 null */
  reported: number | null;
}

/** @brief 第 0 步四个 GET 的 JSON（取不到或不是 JSON 时为 null）。 */
export interface ServerBodies {
  /** <baseUrl>/models */
  models: unknown;
  /** <origin>/version（vLLM） */
  version: unknown;
  /** <origin>/api/version（Ollama） */
  apiVersion: unknown;
  /** <origin>/props（llama.cpp） */
  props: unknown;
}

/** @brief 对象里字符串的 version 字段。 */
function versionField(body: unknown): string | null {
  const value = (body as { version?: unknown } | null)?.version;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** @brief 正整数，否则 null。 */
function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** @brief llama.cpp /props 的 n_ctx（顶层或 default_generation_settings 里）。 */
function propsWindow(props: unknown): number | null {
  const body = props as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } } | null;
  return positiveInt(body?.n_ctx) ?? positiveInt(body?.default_generation_settings?.n_ctx);
}

/**
 * @brief 第 0 步的判定：SGLang 看 /models 里 owned_by: sglang，vLLM 看 /version，Ollama 看 /api/version，
 *        llama.cpp 看 /props；报告的窗口取 /models 里本模型的 max_model_len，或 /props 的 n_ctx。
 */
export function judgeServer(bodies: ServerBodies, modelId: string): ServerInfo {
  const data = (bodies.models as { data?: unknown } | null)?.data;
  const entries = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const entry = entries.find((item) => item?.id === modelId);
  const reported = positiveInt(entry?.max_model_len) ?? propsWindow(bodies.props);
  if (entries.some((item) => item?.owned_by === 'sglang')) {
    return { kind: 'sglang', version: versionField(bodies.version), reported };
  }
  if (versionField(bodies.version)) return { kind: 'vllm', version: versionField(bodies.version), reported };
  if (versionField(bodies.apiVersion)) return { kind: 'ollama', version: versionField(bodies.apiVersion), reported };
  if (bodies.props !== null && typeof bodies.props === 'object') {
    const build = (bodies.props as { build_info?: unknown }).build_info;
    return { kind: 'llamacpp', version: typeof build === 'string' && build !== '' ? build : null, reported };
  }
  return { kind: 'unknown', version: null, reported };
}

/** @brief GET；getText 抛错时记日志并当作取不到（null）。 */
async function safeGet(deps: Pick<ProbeDeps, 'getText'>, url: string, signal: AbortSignal): Promise<string | null> {
  try {
    return await deps.getText(url, signal);
  } catch (error) {
    if (!signal.aborted) console.error(`[kernel] probe GET ${url} failed: ${(error as Error).message}`);
    return null;
  }
}

/** @brief GET 并解析 JSON；取不到或不是 JSON 时为 null。 */
async function getJson(deps: ProbeDeps, url: string): Promise<unknown> {
  const text = await safeGet(deps, url, deps.signal);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @brief 去掉结尾的 /。 */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * @brief 第 0 步：GET <baseUrl>/models、<origin>/version、<origin>/api/version、<origin>/props，判定服务。
 *        也用于 §7.1 在启动和会话打开时读服务版本（version 为 null 即读失败，档案不变）。
 */
export async function detectServer(deps: ProbeDeps, baseUrl: string, modelId: string): Promise<ServerInfo> {
  const origin = new URL(baseUrl).origin;
  const [models, version, apiVersion, props] = await Promise.all([
    getJson(deps, `${trimSlash(baseUrl)}/models`), getJson(deps, `${origin}/version`),
    getJson(deps, `${origin}/api/version`), getJson(deps, `${origin}/props`),
  ]);
  return judgeServer({ models, version, apiVersion, props }, modelId);
}

// ---- 第 1–7 步 ----

/** @brief 第 3、4 步的上下文的开头：用户的要求与带 get_weather 调用的助手消息。 */
function weatherContext(run: Run, assistant?: AssistantMessage): Context {
  const messages: Message[] = [user(run, PROBE_PROMPTS.weather)];
  if (assistant) messages.push(assistant);
  return { messages, tools: [WEATHER_TOOL] };
}

/** @brief 第 4 步的上下文：第 3 步的调用加工具结果，再问工具报告的温度。 */
export function resultContext(run: { deps: Pick<ProbeDeps, 'now'> }, assistant: AssistantMessage): Context {
  const call = toolCall(assistant, WEATHER_TOOL.name);
  const now = run.deps.now();
  const messages: Message[] = [
    { role: 'user', content: PROBE_PROMPTS.weather, timestamp: now },
    assistant,
    { role: 'toolResult', toolCallId: call?.id ?? '', toolName: WEATHER_TOOL.name,
      content: [{ type: 'text', text: PROBE_PROMPTS.weatherResult }], isError: false, timestamp: now },
    { role: 'user', content: PROBE_PROMPTS.temperature, timestamp: now },
  ];
  return { messages, tools: [WEATHER_TOOL] };
}

/** @brief 去掉思考块的副本（第 4 步的“不带”）。 */
export function withoutThinking(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter((block) => block.type !== 'thinking') };
}

/** @brief 模型的副本，requiresReasoningContentOnAssistantMessages 设为 false（第 4 步的“不带”）。 */
export function withoutReplayCompat(model: Model<Api>): Model<Api> {
  const compat = { ...(model.compat as object | undefined), requiresReasoningContentOnAssistantMessages: false };
  return { ...model, compat } as Model<Api>;
}

/** @brief 第 1、2 步的结果与观察到思考内容的消息。 */
interface ReadyResults {
  /** 第 1 步 */
  ready: ProbeStepResult;
  /** 第 2 步 */
  thinking: ProbeStepResult;
  /** 用来找推理字段名的消息 */
  messages: (AssistantMessage | null)[];
}

/** @brief 第 1 步（reasoning 为 true 的模型思考 medium，否则 off）与第 2 步（只对 reasoning 为 true：off 与 medium）。 */
async function readySteps(run: Run): Promise<ReadyResults> {
  const { model } = run.target;
  const ask = (level: ThinkingLevel) => send(run, { model, context: { messages: [user(run, PROBE_PROMPTS.ready)] },
    thinking: level });
  run.deps.onStep?.(1, AUTO_STEPS);
  const first = await ask(model.reasoning ? 'medium' : 'off');
  if (!model.reasoning) {
    return { ready: judgeReady(first), thinking: step('not_applicable'), messages: [first.message] };
  }
  run.deps.onStep?.(2, AUTO_STEPS);
  const off = await ask('off');
  const medium = await ask('medium');
  return { ready: judgeReady(first), thinking: judgeThinkingOff(off),
    messages: [first.message, off.message, medium.message] };
}

/** @brief 第 3、4 步与回传检查的结果。 */
interface ToolResults {
  /** 第 3 步 */
  call: ProbeStepResult;
  /** 第 4 步 */
  result: ProbeStepResult;
  /** 回传检查 */
  replay: ProbeStepResult;
  /** 用来找推理字段名的消息 */
  messages: (AssistantMessage | null)[];
}

/** @brief 第 3 步（思考 off）与第 4 步：第 3 步没通过时第 4 步不跑。 */
async function toolSteps(run: Run): Promise<ToolResults> {
  const { model } = run.target;
  run.deps.onStep?.(3, AUTO_STEPS);
  const first = await send(run, { model, context: weatherContext(run), thinking: 'off' });
  const call = judgeWeatherCall(first);
  run.deps.onStep?.(4, AUTO_STEPS);
  let result = step('not_run', 'Step 3 did not produce a valid call');
  if (call.outcome === 'pass' && first.message) {
    result = judgeTemperature(await send(run, { model, context: resultContext(run, first.message), thinking: 'off' }));
  }
  const check = model.api === 'openai-completions' && model.reasoning
    ? await replayCheck(run) : { replay: step('not_applicable'), messages: [] };
  return { call, result, replay: check.replay, messages: check.messages };
}

/**
 * @brief 第 4 步的回传检查：思考 medium 再跑一次第 3 步，保留返回的助手消息；“带上”原样发出，
 *        “不带”去掉思考块、在模型副本上关掉 requiresReasoningContentOnAssistantMessages 后发出。
 */
async function replayCheck(run: Run): Promise<{ replay: ProbeStepResult; messages: (AssistantMessage | null)[] }> {
  const { model } = run.target;
  const rerun = await send(run, { model, context: weatherContext(run), thinking: 'medium' });
  const call = judgeWeatherCall(rerun);
  if (call.outcome === 'error') return { replay: call, messages: [] };
  if (call.outcome !== 'pass' || !rerun.message) {
    return { replay: step('not_run', 'The thinking rerun of step 3 did not produce a valid call'), messages: [] };
  }
  const assistant = rerun.message;
  const withThinking = await send(run, { model, context: resultContext(run, assistant), thinking: 'medium' });
  const without = await send(run, { model: withoutReplayCompat(model),
    context: resultContext(run, withoutThinking(assistant)), thinking: 'medium' });
  return { replay: judgeReplay(withThinking, without), messages: [assistant, withThinking.message] };
}

/** @brief 第 5–7 步的结果。 */
interface TierResults {
  /** 第 5 步 */
  a: ProbeStepResult;
  /** 第 6 步 */
  b: ProbeStepResult;
  /** 第 7 步 */
  c: ProbeStepResult;
}

/**
 * @brief 第 5、6、7 步（思考 off）。第 7 步只在第 5 步判定不通过、且第 6 步判定不通过或不适用时跑；
 *        服务端对第 5、6 步回 4xx 也算判定为不通过（§7.3）。
 */
async function tierSteps(run: Run): Promise<TierResults> {
  const { model } = run.target;
  const api = model.api as ApiType;
  run.deps.onStep?.(5, AUTO_STEPS);
  const a = judgeOutcomeCall(await send(run, { model, thinking: 'off',
    context: { messages: [user(run, PROBE_PROMPTS.outcome)], tools: [OUTCOME_TOOL] },
    toolChoice: forcedToolChoice(api, OUTCOME_TOOL.name),
    onPayload: (payload) => withStrictTools(api, payload, OUTCOME_TOOL.name) }));
  run.deps.onStep?.(6, AUTO_STEPS);
  const b = api === 'anthropic-messages' ? step('not_applicable') : judgeJsonOutcome(await send(run, {
    model, thinking: 'off', context: { messages: [user(run, PROBE_PROMPTS.json)] },
    onPayload: (payload) => withJsonSchema(api, payload, OUTCOME_SCHEMA_NAME, OUTCOME_SCHEMA) }));
  run.deps.onStep?.(7, AUTO_STEPS);
  if (a.outcome !== 'fail' || (b.outcome !== 'fail' && b.outcome !== 'not_applicable')) {
    return { a, b, c: step('not_run') };
  }
  const replies: ProbeReply[] = [];
  for (let i = 0; i < run.deps.timings.tierCRepetitions; i += 1) {
    const reply = await send(run, { model, thinking: 'off', context: { messages: [user(run, PROBE_PROMPTS.tagged)] } });
    replies.push(reply);
    if (reply.error !== null || !parseTagged(replyText(reply.message), OUTCOMES)) break;
  }
  return { a, b, c: judgeTagged(replies) };
}

/**
 * @brief 自动探针第 0–7 步（§7.3、§7.4）。
 * @return 结果；这组探针被取消时为 null
 */
export async function runAutoProbes(target: ProbeTarget, deps: ProbeDeps): Promise<AutoResults | null> {
  const run: Run = { deps, target };
  try {
    deps.onStep?.(0, AUTO_STEPS);
    const server = await detectServer(deps, target.model.baseUrl, target.model.id);
    if (deps.signal.aborted) return null;
    const ready = await readySteps(run);
    const tools = await toolSteps(run);
    const tiers = await tierSteps(run);
    const steps: AutoSteps = { ready: ready.ready, thinking: ready.thinking, call: tools.call, result: tools.result,
      replay: tools.replay, ...tiers };
    const field = target.model.api === 'openai-completions'
      ? reasoningFieldOf([...ready.messages, ...tools.messages]) : 'native';
    return { server: { kind: server.kind, version: server.version ?? 'unknown' }, reported: server.reported,
      steps, field };
  } catch (error) {
    if (error instanceof ProbeCancelled || deps.signal.aborted) return null;
    throw error;
  }
}

// ---- 第 8 步：长输入 ----

/** @brief 随机暗号用的词。 */
const PASSPHRASE_WORDS = ['amber', 'cobalt', 'juniper', 'lantern', 'meadow', 'quartz', 'saffron', 'tundra'];

/** @brief 随机暗号：一个词加四位数字。 */
function randomPassphrase(): string {
  return `${PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)]}${randomInt(1000, 10000)}`;
}

/** @brief 填充用的一行（不含暗号相关的字）。 */
const FILLER_LINE = 'This line is filler text for a long-input test; it carries no information.\n';

/**
 * @brief 第 8 步的提示：“The passphrase is <暗号>.”，接着填充到约 tokens 个 token（按 pi 的每 4 个字符 1 个 token 估算），
 *        最后问“What is the passphrase?”。
 */
export function longInputPrompt(word: string, tokens: number): string {
  const head = `The passphrase is ${word}.\n\n`;
  const tail = `\n${PROBE_PROMPTS.passphrase}`;
  const room = Math.max(0, tokens * CHARS_PER_TOKEN - head.length - tail.length);
  const filler = FILLER_LINE.repeat(Math.ceil(room / FILLER_LINE.length)).slice(0, room);
  return `${head}${filler}${tail}`;
}

/** @brief 第 8 步各长度：有效窗口乘 §12 的比例。 */
export function longInputLengths(effective: number, timings: ModelTimings): number[] {
  return timings.longInputFractions.map((fraction) => Math.floor(effective * fraction));
}

/** @brief 确认框写的大约 token 数（§7.4：按有效窗口的 50% + 90% 估算）。 */
export function longInputTokenEstimate(effective: number, timings: ModelTimings): number {
  return longInputLengths(effective, timings).reduce((sum, tokens) => sum + tokens, 0);
}

/** @brief 第 8 步一个长度的结果：答对、报错（HTTP 错误）、不报错但答不出（静默截断）、出错没有结果。 */
export interface LongInputTrial {
  /** 这个长度（token） */
  tokens: number;
  /** 结果 */
  outcome: 'pass' | 'rejected' | 'silent' | 'error';
  /** 出错或报错的原文 */
  detail: string | null;
}

/** @brief 第 8 步一个长度的判定。 */
export function judgeLongInputTrial(reply: ProbeReply, word: string, tokens: number): LongInputTrial {
  if (reply.error !== null) {
    const outcome = reply.status !== null && reply.status >= 400 ? 'rejected' : 'error';
    return { tokens, outcome, detail: reply.error };
  }
  const answered = replyText(reply.message).toLowerCase().includes(word.toLowerCase());
  return { tokens, outcome: answered ? 'pass' : 'silent', detail: null };
}

/**
 * @brief 第 8 步的判定：有静默截断时 truncation 为 silent，effective 降到它之前通过的长度（都没通过为 0）；
 *        否则有长度出错没有结果时保持原值；否则（答对或报错）truncation 为 none、effective 不变。
 * @param trials 按长度从小到大
 */
export function judgeLongInput(trials: readonly LongInputTrial[]): LongInputResult {
  const silent = trials.findIndex((trial) => trial.outcome === 'silent');
  if (silent >= 0) {
    const passed = trials.slice(0, silent).filter((trial) => trial.outcome === 'pass');
    const limit = passed.length > 0 ? passed[passed.length - 1].tokens : 0;
    return { step: step('pass', 'Silently truncates long input'), truncation: 'silent', limit };
  }
  const failed = trials.find((trial) => trial.outcome === 'error');
  if (failed) return { step: step('error', failed.detail), truncation: null, limit: null };
  return { step: step('pass'), truncation: 'none', limit: null };
}

/**
 * @brief 长输入探针（第 8 步，需要你同意，§7.4）：按有效窗口的 50%、90% 各发一次（思考 off）。
 * @param effective 档案当前的有效窗口
 * @return 结果；被取消时为 null
 */
export async function runLongInputProbe(target: ProbeTarget, effective: number,
  deps: ProbeDeps): Promise<LongInputResult | null> {
  const run: Run = { deps, target };
  const word = deps.randomWord?.() ?? randomPassphrase();
  try {
    deps.onStep?.(8, 1);
    const trials: LongInputTrial[] = [];
    for (const tokens of longInputLengths(effective, deps.timings)) {
      const reply = await send(run, { model: target.model, thinking: 'off',
        context: { messages: [user(run, longInputPrompt(word, tokens))] } });
      trials.push(judgeLongInputTrial(reply, word, tokens));
    }
    return judgeLongInput(trials);
  } catch (error) {
    if (error instanceof ProbeCancelled || deps.signal.aborted) return null;
    throw error;
  }
}

// ---- 第 9 步：断开后服务端是否停止 ----

/**
 * @brief Prometheus 文本里一个指标的值（各标签组相加）。
 * @return 没有这个指标时为 null
 */
export function prometheusValue(text: string, metric: string): number | null {
  let total: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^([^\s{]+)(\{[^}]*\})?\s+(\S+)/.exec(line.trim());
    if (!match || match[1] !== metric) continue;
    const value = Number(match[3]);
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * @brief 服务端正在跑的请求数：vLLM 的 vllm:num_requests_running、SGLang 的 sglang:num_running_reqs（/metrics），
 *        llama.cpp 的 /slots 里 is_processing 为真的槽位数。也用于 §5.7 发出前读基线。
 * @return 指标接口不响应、没有这个计数、或不是这三种服务时为 null
 */
export async function readRunningRequests(deps: Pick<ProbeDeps, 'getText'>, baseUrl: string, kind: ServerKind,
  signal: AbortSignal): Promise<number | null> {
  if (!METRIC_KINDS.has(kind)) return null;
  const origin = new URL(baseUrl).origin;
  if (kind === 'llamacpp') {
    const text = await safeGet(deps, `${origin}/slots`, signal);
    if (text === null) return null;
    try {
      const slots = JSON.parse(text) as unknown;
      if (!Array.isArray(slots) || !slots.some((slot) => typeof slot?.is_processing === 'boolean')) return null;
      return slots.filter((slot) => slot.is_processing === true).length;
    } catch {
      return null;
    }
  }
  const text = await safeGet(deps, `${origin}/metrics`, signal);
  if (text === null) return null;
  return prometheusValue(text, kind === 'vllm' ? 'vllm:num_requests_running' : 'sglang:num_running_reqs');
}

/**
 * @brief 第 9 步的判定：断开后请求数回到基线或更低为 true，仍高于基线为 false，读不到为 unknown。
 * @param after 等 §12 的时长后读到的请求数；读不到为 null
 */
export function judgeCancel(baseline: number, after: number | null): boolean | 'unknown' {
  if (after === null) return 'unknown';
  return after <= baseline;
}

/** @brief 默认的等待：被取消时抛出。 */
function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

/**
 * @brief 取消探针（第 9 步，需要你同意，§7.4）：只对 vLLM、SGLang、llama.cpp。先读基线，再发长输出请求，
 *        收到第一段输出后断开；等 §12 的时长后再读一次。
 * @param kind 档案里的服务种类
 * @return 结果；被取消时为 null
 */
export async function runCancelProbe(target: ProbeTarget, kind: ServerKind,
  deps: ProbeDeps): Promise<CancelResult | null> {
  if (!METRIC_KINDS.has(kind)) return { step: step('not_applicable'), verified: 'unknown' };
  const run: Run = { deps, target };
  const noMetric = { step: step('pass', 'The server reports no running-request count'), verified: 'unknown' as const };
  try {
    deps.onStep?.(9, 1);
    const baseline = await readRunningRequests(deps, target.model.baseUrl, kind, deps.signal);
    if (baseline === null) return noMetric;
    const reply = await send(run, { model: target.model, thinking: 'off', stopOnContent: true,
      maxTokens: deps.timings.probeCancelMaxTokens, context: { messages: [user(run, PROBE_PROMPTS.count)] } });
    if (!reply.content) {
      return { step: step('error', reply.error ?? 'No output before the request ended'), verified: 'unknown' };
    }
    await (deps.sleep ?? sleepFor)(deps.timings.cancelProbeWindowMs, deps.signal);
    const after = await readRunningRequests(deps, target.model.baseUrl, kind, deps.signal);
    if (after === null) return noMetric;
    return { step: step('pass'), verified: judgeCancel(baseline, after) };
  } catch (error) {
    if (error instanceof ProbeCancelled || deps.signal.aborted) return null;
    throw error;
  }
}

// ---- 同一个模型同时只跑一组探针（§7.4） ----

/** @brief 每个模型正在跑的那组探针的取消控制：新的一组开始时取消旧的。 */
export class ProbeRuns {
  private readonly controllers = new Map<ModelRef, AbortController>();

  /**
   * @brief 开始一组探针：取消这个模型正在跑的旧的一组。
   * @return 这组探针的 signal（交给 ProbeDeps.signal）
   */
  begin(ref: ModelRef): AbortSignal {
    this.controllers.get(ref)?.abort();
    const controller = new AbortController();
    this.controllers.set(ref, controller);
    return controller.signal;
  }

  /**
   * @brief 一组探针结束。
   * @param signal 这组的 signal
   * @return 它仍是这个模型当前的一组（没有被新的一组取代、没有被取消），结果可以保存
   */
  end(ref: ModelRef, signal: AbortSignal): boolean {
    const current = this.controllers.get(ref);
    if (current?.signal !== signal) return false;
    this.controllers.delete(ref);
    return !signal.aborted;
  }

  /** @brief 取消这个模型的探针（删除模型时）。 */
  cancel(ref: ModelRef): void {
    this.controllers.get(ref)?.abort();
    this.controllers.delete(ref);
  }

  /** @brief 这个模型有一组探针在跑。 */
  isRunning(ref: ModelRef): boolean {
    return this.controllers.has(ref);
  }
}
