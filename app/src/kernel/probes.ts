// 探针（docs/specs/model-providers.md §7.3、§7.4）：第 0–7 步的请求与判定；思考关不掉的模型的判定、各步的强度与
// 输出上限规则见 §7.7。2026-10-26（负责人走查 M7）：需要你同意的第 8 步（长输入）、第 9 步（取消）删掉。
// 依赖全部注入（pi 的 streamSimple、模型池给的 fetch、第 0 步的读取器、时长与 signal），
// 所以可以用替身做单元测试；第 0 步改为调用读取器的单模型模式（docs/specs/model-discovery.md §7.1），种类、版本与
// 报告值的读法在 discoverRead.ts、modelDiscover.ts；档案的派生（能力三态、等级）在 modelProfiles.ts；
// 第 5–7 步三种写法的请求改写与标签解析在 forcedWrite.ts（与强制填写共用）。

import type {
  Api, AssistantMessage, AssistantMessageEvent, Context, FetchFunction, Message, Model, SimpleStreamOptions, Tool,
  ToolCall,
} from '@earendil-works/pi-ai';
import type { ApiType, ProbeStepResult, ReasoningField, ThinkingLevel } from '../shared/models';
import { forcedToolChoice, parseTagged, withJsonSchema, withStrictTools } from './forcedWrite';
import type { AutoResults, AutoSteps, ServerRead } from './modelProfiles';
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

/** @brief 自动探针的步数（第 0–7 步）：进度（mori.profiles 的 running）里的“共几步”。 */
export const AUTO_STEPS = 8;

/** @brief §7.7、§12：思考关不掉的模型在探针里代替 off 的强度（同第 1 步与回传检查）。 */
export const REFUSED_OFF_LEVEL: ThinkingLevel = 'medium';

/** @brief §7.7：回复停在探针输出上限、只有思考时这一步（出错）的说明。 */
export const OUTPUT_LIMIT_TEXT = 'Stopped at the probe output limit before answering';

/** @brief §7.7：第 2 步关闭思考被拒时说明的开头，后接服务的错误原文；只存在档案里，界面不显示。 */
export const OFF_REFUSED_PREFIX = 'Thinking can’t be turned off: ';

/** @brief pi 表示“不限时”的 timeoutMs（§8.4）。 */
const NO_TIMEOUT_MS = 2147483647;

/** @brief 有内容的事件：正文、思考、工具调用的开始或增量（§7.3、§11.2）。 */
const CONTENT_EVENTS = new Set<AssistantMessageEvent['type']>([
  'text_start', 'text_delta', 'thinking_start', 'thinking_delta', 'toolcall_start', 'toolcall_delta',
]);

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
   * @brief 第 0 步（model-discovery.md §7.1）：读取器的单模型模式读服务种类、版本、报告的窗口与 meta。
   *        地址、key（§5.1 对已有提供商的选法）与每个请求的时限（§11 的发现时限，不是探针步时限）由调用方处理；
   *        拿不到列表时种类按 §3.3 第 6 步能判断的判断，判断不了为 unknown，报告值各项为 null。
   * @param signal 这组探针的 signal：只随它停止，不被 models.discover 或 models.discoverCancel 取消（§5.3）
   */
  readServer(signal: AbortSignal): Promise<ServerRead>;
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
}

/** @brief 要探测的模型。 */
export interface ProbeTarget {
  /** <provider>/<model> */
  ref: ModelRef;
  /** pi 里注册的实际模型（api、baseUrl、id、reasoning、compat；§7.7 的“没有 Off”标记 thinkingLevelMap） */
  model: Model<Api>;
}

/** @brief 一次探针请求的结果。 */
export interface ProbeReply {
  /**
   * 结束的助手消息；出错时为 null。§7.7：停在输出上限、只有思考时保留消息（error 为
   * OUTPUT_LIMIT_TEXT），推理字段名仍可从中读出
   */
  message: AssistantMessage | null;
  /** 出错（连接、HTTP 错误、超时、§7.7 的输出上限）时的原文；没有出错时为 null */
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
  /** 指定调用的 tool_choice（第 5 步） */
  toolChoice?: unknown;
  /** 改写请求体（第 5 步严格模式、第 6 步 schema） */
  onPayload?: (payload: unknown) => unknown;
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
    maxTokens: timings.probeMaxTokens,
  };
  // pi 的三种接口都把不传 reasoning 当作思考 off
  if (req.thinking !== 'off') options.reasoning = req.thinking;
  if (req.toolChoice !== undefined) options.toolChoice = req.toolChoice as SimpleStreamOptions['toolChoice'];
  if (req.onPayload) options.onPayload = req.onPayload;
  return options;
}

/**
 * @brief 读完事件流；第一个有内容的事件时回调一次。
 * @return 收到了有内容的事件
 */
async function drain(stream: ProbeStream, onContent: () => void): Promise<boolean> {
  let content = false;
  for await (const event of stream) {
    if (content || !CONTENT_EVENTS.has(event.type)) continue;
    content = true;
    onContent();
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
    content = await drain(stream, () => watch.clear());
    return finish(run, { message: await stream.result(), error: null, status, content }, watch.timedOut);
  } catch (error) {
    if (deps.signal.aborted) throw new ProbeCancelled();
    return finish(run, { message: null, error: (error as Error).message, status, content }, watch.timedOut);
  } finally {
    watch.clear();
  }
}

/**
 * @brief 整理一次请求的结果：取消时抛出；超时与出错的消息写成 error；§7.7：停在输出上限、只有思考的回复也写成
 *        error（保留消息；status 仍是 HTTP 状态，所以不算被拒）。
 */
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
  // §7.7 输出上限：对第 1–7 步都按出错处理，不判为不通过
  if (stoppedAtLimit(message)) return { ...reply, error: OUTPUT_LIMIT_TEXT };
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

/** @brief §7.7 输出上限：回复因输出上限停下（stopReason 为 length），没有正文也没有工具调用、只有思考。 */
export function stoppedAtLimit(message: AssistantMessage | null): boolean {
  if (!message || message.stopReason !== 'length') return false;
  if (replyText(message).trim() !== '' || message.content.some((block) => block.type === 'toolCall')) return false;
  return hasThinking(message);
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

/** @brief 第 2 步（思考 off 的那次）：没有思考内容即能关掉思考（§7.7 判定表的前两行，off 的其他错误为出错）。 */
export function judgeThinkingOff(reply: ProbeReply): ProbeStepResult {
  return judged(reply, (message) => (hasThinking(message)
    ? step('fail', 'The reply has thinking content with thinking off') : step('pass')));
}

/** @brief 第 2 步的判定（§7.7）。 */
export interface ThinkingJudgement {
  /** 第 2 步的结果 */
  step: ProbeStepResult;
  /** off 被服务以 400 或 422 拒绝、medium 有正文（档案的 off_refused） */
  offRefused: boolean;
}

/**
 * @brief 第 2 步（§7.7 的判定表，两次一起判）：off 没被拒时按 judgeThinkingOff；off 被拒（400、422）而 medium 有正文
 *        为不通过、off_refused，说明为 OFF_REFUSED_PREFIX 加 off 的原文；medium 出错时用 medium 的说明出错；
 *        medium 没出错但没有正文时用 off 的原文出错。
 * @param off 思考 off 的那次
 * @param medium 思考 medium 的那次
 */
export function judgeThinkingStep(off: ProbeReply, medium: ProbeReply): ThinkingJudgement {
  if (!rejected(off)) return { step: judgeThinkingOff(off), offRefused: false };
  if (medium.error !== null) return { step: step('error', medium.error), offRefused: false };
  if (replyText(medium.message).trim() === '') return { step: step('error', off.error), offRefused: false };
  return { step: step('fail', `${OFF_REFUSED_PREFIX}${off.error}`), offRefused: true };
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

/**
 * @brief §7.7：去掉“没有 Off”标记（thinkingLevelMap.off 为 null）的模型副本，第 1–7 步都在它上面发；
 *        thinkingLevelMap 的其他键保留，去掉后为空时不带这一项；不改原模型。
 */
export function withoutNoOffMarker(model: Model<Api>): Model<Api> {
  const { thinkingLevelMap, ...rest } = model;
  if (thinkingLevelMap?.off !== null) return { ...model };
  const levels = { ...thinkingLevelMap };
  delete levels.off;
  return Object.keys(levels).length > 0 ? { ...rest, thinkingLevelMap: levels } : rest;
}

/** @brief §7.7：本组第 3、4、6、7 步的思考强度：判出 off_refused 为 medium，否则 off。 */
export function probeThinking(offRefused: boolean): ThinkingLevel {
  return offRefused ? REFUSED_OFF_LEVEL : 'off';
}

/** @brief 第 1、2 步的结果与观察到思考内容的消息。 */
interface ReadyResults {
  /** 第 1 步 */
  ready: ProbeStepResult;
  /** 第 2 步 */
  thinking: ProbeStepResult;
  /** 第 2 步判出 off_refused（§7.7）；reasoning 为 false 的模型为 false */
  offRefused: boolean;
  /** 用来找推理字段名的消息 */
  messages: (AssistantMessage | null)[];
}

/**
 * @brief 第 1 步（reasoning 为 true 的模型思考 medium，否则 off）与第 2 步（只对 reasoning 为 true：off 与 medium，
 *        按 §7.7 的判定表一起判）。
 */
async function readySteps(run: Run): Promise<ReadyResults> {
  const { model } = run.target;
  const ask = (level: ThinkingLevel) => send(run, { model, context: { messages: [user(run, PROBE_PROMPTS.ready)] },
    thinking: level });
  run.deps.onStep?.(1, AUTO_STEPS);
  const first = await ask(model.reasoning ? 'medium' : 'off');
  if (!model.reasoning) {
    return { ready: judgeReady(first), thinking: step('not_applicable'), offRefused: false, messages: [first.message] };
  }
  run.deps.onStep?.(2, AUTO_STEPS);
  const off = await ask('off');
  const medium = await ask('medium');
  const thinking = judgeThinkingStep(off, medium);
  return { ready: judgeReady(first), thinking: thinking.step, offRefused: thinking.offRefused,
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

/**
 * @brief 第 3 步与第 4 步：第 3 步没通过时第 4 步不跑。
 * @param thinking 第 3、4 步的思考强度：按本组第 2 步的 probeThinking（§7.7），回传检查不受它影响
 */
async function toolSteps(run: Run, thinking: ThinkingLevel): Promise<ToolResults> {
  const { model } = run.target;
  run.deps.onStep?.(3, AUTO_STEPS);
  const first = await send(run, { model, context: weatherContext(run), thinking });
  const call = judgeWeatherCall(first);
  run.deps.onStep?.(4, AUTO_STEPS);
  let result = step('not_run', 'Step 3 did not produce a valid call');
  if (call.outcome === 'pass' && first.message) {
    result = judgeTemperature(await send(run, { model, context: resultContext(run, first.message), thinking }));
  }
  const check = model.api === 'openai-completions' && model.reasoning
    ? await replayCheck(run) : { replay: step('not_applicable'), messages: [] };
  return { call, result, replay: check.replay, messages: check.messages };
}

/**
 * @brief 第 4 步的回传检查：思考 medium 再跑一次第 3 步，保留返回的助手消息；“带上”原样发出，
 *        “不带”去掉思考块、在模型副本上关掉 requiresReasoningContentOnAssistantMessages 后发出。
 *        §7.7：run.target.model 已是没有“没有 Off”标记的副本，强度不变。
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

/** @brief 第 7 步的条件用：判定为不通过或不适用（§7.3、§7.7）。 */
function failedOrNotApplicable(result: ProbeStepResult): boolean {
  return result.outcome === 'fail' || result.outcome === 'not_applicable';
}

/**
 * @brief 第 5、6、7 步。第 5 步思考 off；本组第 2 步判出 off_refused 时第 5 步不适用、不发，第 6、7 步用 medium，
 *        否则第 6、7 步也是 off（§7.7）。第 7 步只在第 5 步判定不通过或不适用、且第 6 步判定不通过或不适用时跑
 *        （§7.7，对所有模型）；服务端对第 5、6 步回 4xx 也算判定为不通过（§7.3）。
 * @param offRefused 本组第 2 步判出 off_refused
 */
async function tierSteps(run: Run, offRefused: boolean): Promise<TierResults> {
  const { model } = run.target;
  const api = model.api as ApiType;
  const thinking = probeThinking(offRefused);
  run.deps.onStep?.(5, AUTO_STEPS);
  // §7.7：A 级要关闭思考（平行 Agent 规格 §7.5），关不掉的模型不适用
  const a = offRefused ? step('not_applicable') : judgeOutcomeCall(await send(run, { model, thinking: 'off',
    context: { messages: [user(run, PROBE_PROMPTS.outcome)], tools: [OUTCOME_TOOL] },
    toolChoice: forcedToolChoice(api, OUTCOME_TOOL.name),
    onPayload: (payload) => withStrictTools(api, payload, OUTCOME_TOOL.name) }));
  run.deps.onStep?.(6, AUTO_STEPS);
  const b = api === 'anthropic-messages' ? step('not_applicable') : judgeJsonOutcome(await send(run, {
    model, thinking, context: { messages: [user(run, PROBE_PROMPTS.json)] },
    onPayload: (payload) => withJsonSchema(api, payload, OUTCOME_SCHEMA_NAME, OUTCOME_SCHEMA) }));
  run.deps.onStep?.(7, AUTO_STEPS);
  if (!failedOrNotApplicable(a) || !failedOrNotApplicable(b)) return { a, b, c: step('not_run') };
  const replies: ProbeReply[] = [];
  for (let i = 0; i < run.deps.timings.tierCRepetitions; i += 1) {
    const reply = await send(run, { model, thinking, context: { messages: [user(run, PROBE_PROMPTS.tagged)] } });
    replies.push(reply);
    if (reply.error !== null || !parseTagged(replyText(reply.message), OUTCOMES)) break;
  }
  return { a, b, c: judgeTagged(replies) };
}

/**
 * @brief 自动探针第 0–7 步（§7.3、§7.4）。第 0 步经读取器（model-discovery.md §7.1），不计入短请求；
 *        结果总带 meta（§7.2）与 offRefused（§7.7）。第 1–7 步与回传检查都在没有“没有 Off”标记的副本上发，
 *        第 3–7 步的强度按本组第 2 步，不看档案（§7.7）。
 * @return 结果；这组探针被取消时为 null
 */
export async function runAutoProbes(target: ProbeTarget, deps: ProbeDeps): Promise<AutoResults | null> {
  // §7.7：已经标记过的模型点 Verify 时第 2 步仍然重新测
  const run: Run = { deps, target: { ref: target.ref, model: withoutNoOffMarker(target.model) } };
  try {
    deps.onStep?.(0, AUTO_STEPS);
    const server = await deps.readServer(deps.signal);
    if (deps.signal.aborted) return null;
    const ready = await readySteps(run);
    const tools = await toolSteps(run, probeThinking(ready.offRefused));
    const tiers = await tierSteps(run, ready.offRefused);
    const steps: AutoSteps = { ready: ready.ready, thinking: ready.thinking, call: tools.call, result: tools.result,
      replay: tools.replay, ...tiers };
    const field = target.model.api === 'openai-completions'
      ? reasoningFieldOf([...ready.messages, ...tools.messages]) : 'native';
    return { server: { kind: server.kind, version: server.version ?? 'unknown' }, reported: server.reported,
      meta: server.meta, steps, field, offRefused: ready.offRefused };
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
