// 探针（docs/specs/model-providers.md §7.3、§7.4）：第 0–7 步的请求与判定；思考关不掉的模型的判定、各步的强度与
// 输出上限规则见 §7.7。2026-10-26（负责人走查 M7）：需要你同意的第 8 步（长输入）、第 9 步（取消）删掉。
// 2026-10-31（§7.8）：请求合并成两段四轮——必需一段 E1–E4（第 0 步与 E1、E2 同时）、后台一段 B1–B4（含图片探针 B3），
// 同一轮的请求同时发出；必需一段过了就经 onEssentials 先存档案，再跑后台一段。首个内容的时限按模型学，由依赖给出与记录。
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
import { toolCallingOf, type AutoResults, type AutoSteps, type ServerRead } from './modelProfiles';
import type { ModelTimings } from './modelTimings';
import type { ModelRef, SchedClass } from './modelTypes';

// ---- §7.3、§7.8 的提示原文与工具 ----

/** @brief 各步的提示原文（§7.3；2026-10-31 起不再发第 1、2 步的“ready”，§7.8）。 */
export const PROBE_PROMPTS = Object.freeze({
  /** E1、E2（原第 3 步） */
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
  /** B3 图片探针（§7.8） */
  image: 'What color is this image? Answer with one word.',
});

/** @brief B3 的图片：一张 16×16 的纯红色 PNG（§7.8、§12），base64。 */
export const PROBE_IMAGE = Object.freeze({
  data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
});

/** @brief B3 通过时正文里要有的颜色（不分大小写）。 */
const IMAGE_COLOR = /red/i;

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

/** @brief 两段探针的轮数（§7.8）：进度（mori.profiles 的 running）里的“共几轮”，step 为轮次 1–4。 */
export const PROBE_ROUNDS = 4;

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
   * @brief 进度：开始跑某一轮时回调（mori.profiles 的 running，§7.8）。
   * @param step 轮次 1–4
   * @param of 共几轮（PROBE_ROUNDS）
   */
  onStep?(step: number, of: number): void;
  /** @brief 这次请求的首个内容时限（ms）：按模型学的，还没有记录时为上限（§7.8）。 */
  firstTokenLimitMs(): number;
  /**
   * @brief 收到首个内容（§7.8）。
   * @param ms 从这次尝试真正发出到首个内容的用时
   */
  onFirstToken?(ms: number): void;
  /**
   * @brief 首个内容超时（§7.8）。
   * @param limitMs 这次用的时限
   */
  onFirstTokenTimeout?(limitMs: number): void;
  /**
   * @brief 必需一段结束、tool calling 验证通过、要接着跑后台一段之前：存下必需一段的档案（§7.8）。
   * @param auto phase 为 essentials 的结果，后台各步为 not_run
   */
  onEssentials?(auto: AutoResults): Promise<void>;
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

/**
 * @brief 首个内容的时限：每次 onSent 重新计时，收到内容后停止；超时中止这次尝试。sentAt 记最后一次真正发出的时刻，
 *        首个内容的用时从它算起（§7.8）。
 */
function firstContentWatch(ms: number, attempt: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = {
    timedOut: false,
    sentAt: null as number | null,
    arm: () => {
      clearTimeout(timer);
      watch.sentAt = Date.now();
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
 * @brief 发一次探针请求，经模型池的 background 类别；发出后按模型学的时限（§7.8）内没有第一个有内容的事件就中止，
 *        按出错处理。收到首个内容、超时都告诉依赖（记进这个模型的时限）。
 * @throws ProbeCancelled 这组探针被取消
 */
async function send(run: Run, req: ProbeRequest): Promise<ProbeReply> {
  const { deps } = run;
  if (deps.signal.aborted) throw new ProbeCancelled();
  const attempt = new AbortController();
  const limitMs = deps.firstTokenLimitMs();
  const watch = firstContentWatch(limitMs, attempt);
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
  const onContent = () => {
    watch.clear();
    if (watch.sentAt !== null) deps.onFirstToken?.(Date.now() - watch.sentAt);
  };
  try {
    const stream = deps.streamSimple(req.model, req.context, requestOptions(run, req, fetch, signal));
    content = await drain(stream, onContent);
    return finish(run, { message: await stream.result(), error: null, status, content }, watch.timedOut, limitMs);
  } catch (error) {
    if (deps.signal.aborted) throw new ProbeCancelled();
    return finish(run, { message: null, error: (error as Error).message, status, content }, watch.timedOut, limitMs);
  } finally {
    watch.clear();
  }
}

/**
 * @brief 整理一次请求的结果：取消时抛出；超时与出错的消息写成 error（超时另告诉依赖）；§7.7：停在输出上限、只有
 *        思考的回复也写成 error（保留消息；status 仍是 HTTP 状态，所以不算被拒）。
 * @param limitMs 这次用的首个内容时限
 */
function finish(run: Run, reply: ProbeReply, timedOut: boolean, limitMs: number): ProbeReply {
  if (run.deps.signal.aborted) throw new ProbeCancelled();
  if (timedOut && !reply.content) {
    run.deps.onFirstTokenTimeout?.(limitMs);
    return { ...reply, message: null, error: `No response within ${limitMs / 1000} s` };
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

/** @brief 有回答（§7.8）：没有出错，有正文或工具调用。 */
export function answered(reply: ProbeReply): boolean {
  return reply.error === null && (replyText(reply.message).trim() !== ''
    || !!reply.message?.content.some((block) => block.type === 'toolCall'));
}

/**
 * @brief ready（§7.8）：这几个请求都有回答为通过；有一个出错为出错，说明取出错的最后一个（E1、E2 都出错时取 E2 的）；
 *        其余为不通过。
 * @param replies 按顺序的 E1、E2（判出 off_refused 时只有 E2）
 */
export function judgeReady(replies: readonly ProbeReply[]): ProbeStepResult {
  if (replies.every(answered)) return step('pass');
  const failed = [...replies].reverse().find((reply) => reply.error !== null);
  return failed ? step('error', failed.error) : step('fail', 'The reply has no text or tool call');
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
 * @brief 第 2 步（§7.7 的判定表，两次一起判）：off 没被拒时按 judgeThinkingOff；off 被拒（400、422）而 medium 有回答
 *        （正文或工具调用，§7.8：E1、E2 是工具调用的提示）为不通过、off_refused，说明为 OFF_REFUSED_PREFIX 加 off 的原文；
 *        medium 出错时用 medium 的说明出错；medium 没出错但没有回答时用 off 的原文出错。
 * @param off 思考 off 的那次（E1）
 * @param medium 思考 medium 的那次（E2）
 */
export function judgeThinkingStep(off: ProbeReply, medium: ProbeReply): ThinkingJudgement {
  if (!rejected(off)) return { step: judgeThinkingOff(off), offRefused: false };
  if (medium.error !== null) return { step: step('error', medium.error), offRefused: false };
  if (!answered(medium)) return { step: step('error', off.error), offRefused: false };
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

/**
 * @brief B3 图片探针（§7.8）：服务回 400 或 422（不收图片）为不通过、原文记在说明里；其他错误为出错；正文含 red 为通过；
 *        其余为不通过。
 */
export function judgeImage(reply: ProbeReply): ProbeStepResult {
  return judgedFeature(reply, (message) => (IMAGE_COLOR.test(replyText(message)) ? step('pass')
    : step('fail', 'The answer does not name the color of the image')));
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

// ---- 两段四轮（§7.8） ----

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

/** @brief §7.7：本组 B2、B3、B4（原第 6、7 步）的思考强度：判出 off_refused 为 medium，否则 off。 */
export function probeThinking(offRefused: boolean): ThinkingLevel {
  return offRefused ? REFUSED_OFF_LEVEL : 'off';
}

/** @brief 模型的副本，input 设为 ["text","image"]（B3：不设时 pi-ai 把图片换成占位文字，§7.8）；不改原模型。 */
export function withImageInput(model: Model<Api>): Model<Api> {
  return { ...model, input: ['text', 'image'] };
}

/** @brief 第 1 轮的结果（§7.8）。 */
interface FirstRound {
  /** 第 0 步 */
  server: ServerRead;
  /** E1：get_weather，思考 off */
  off: ProbeReply;
  /** E2：同一提示，思考 medium；reasoning 为 false 的模型为 null */
  medium: ProbeReply | null;
}

/** @brief 第 2 轮接着的“底”（§7.8）。 */
interface Base {
  /** 底的助手消息（带 get_weather 调用） */
  message: AssistantMessage;
  /** 底的思考强度 */
  thinking: ThinkingLevel;
  /** 底是 E2 */
  medium: boolean;
}

/** @brief 第 2 轮的结果（§7.8）。 */
interface SecondRound {
  /** E3；没有底时为 null */
  result: ProbeReply | null;
  /** E4；不发时为 null */
  without: ProbeReply | null;
}

/** @brief 第 1 轮（§7.8）：第 0 步、E1、E2 同时开始。 */
async function firstRound(run: Run): Promise<FirstRound> {
  const { deps, target } = run;
  const ask = (thinking: ThinkingLevel) => send(run, { model: target.model, context: weatherContext(run), thinking });
  deps.onStep?.(1, PROBE_ROUNDS);
  const [server, off, medium] = await Promise.all([deps.readServer(deps.signal), ask('off'),
    target.model.reasoning ? ask('medium') : Promise.resolve(null)]);
  return { server, off, medium };
}

/** @brief 底（§7.8）：E2 的工具调用按原第 3 步判定为通过时是 E2；否则 E1 的通过时是 E1；都不是时没有。 */
function baseOf(first: FirstRound): Base | null {
  const passed = (reply: ProbeReply | null): reply is ProbeReply & { message: AssistantMessage } =>
    reply !== null && reply.message !== null && judgeWeatherCall(reply).outcome === 'pass';
  if (passed(first.medium)) return { message: first.medium.message, thinking: 'medium', medium: true };
  if (passed(first.off)) return { message: first.off.message, thinking: 'off', medium: false };
  return null;
}

/**
 * @brief 第 2 轮（§7.8）：有底时 E3（原第 4 步：接着底的消息，带思考块）与 E4（回传检查的“不带”，只对
 *        openai-completions 且底是 E2）同时发出。
 */
async function secondRound(run: Run, base: Base | null): Promise<SecondRound> {
  if (!base) return { result: null, without: null };
  const { model } = run.target;
  run.deps.onStep?.(2, PROBE_ROUNDS);
  const withReplay = base.medium && model.api === 'openai-completions';
  const [result, without] = await Promise.all([
    send(run, { model, context: resultContext(run, base.message), thinking: base.thinking }),
    withReplay ? send(run, { model: withoutReplayCompat(model), context: resultContext(run,
      withoutThinking(base.message)), thinking: 'medium' }) : Promise.resolve(null)]);
  return { result, without };
}

/**
 * @brief replay（§7.8 的判定表）：E3、E4 都发了按原回传检查判；openai-completions 且 reasoning 为 true 而底不是 E2 时，
 *        E2 出错为出错，否则 not_run；其他模型 not_applicable。
 */
function replayStep(run: Run, first: FirstRound, second: SecondRound): ProbeStepResult {
  const { model } = run.target;
  if (model.api !== 'openai-completions' || !model.reasoning) return step('not_applicable');
  if (second.result && second.without) return judgeReplay(second.result, second.without);
  if (first.medium && first.medium.error !== null) return step('error', first.medium.error);
  return step('not_run', 'The thinking request did not produce a valid call');
}

/** @brief 必需一段的各步（§7.8 的判定表），后台各步为 not_run。 */
function essentialSteps(run: Run, first: FirstRound, second: SecondRound, thinking: ThinkingJudgement): AutoSteps {
  const { off, medium } = first;
  const asked = thinking.offRefused && medium ? [medium] : medium ? [off, medium] : [off];
  return {
    ready: judgeReady(asked),
    thinking: thinking.step,
    call: judgeWeatherCall(thinking.offRefused && medium ? medium : off),
    result: second.result ? judgeTemperature(second.result)
      : step('not_run', 'No request produced a valid get_weather call'),
    replay: replayStep(run, first, second),
    a: step('not_run'), b: step('not_run'), c: step('not_run'), image: step('not_run'),
  };
}

/** @brief 必需一段（§7.8）：两轮，得出 phase 为 essentials 的结果。 */
async function essentialRounds(run: Run): Promise<AutoResults> {
  const first = await firstRound(run);
  const thinking = first.medium ? judgeThinkingStep(first.off, first.medium)
    : { step: step('not_applicable'), offRefused: false };
  const second = await secondRound(run, baseOf(first));
  const { server } = first;
  const field = run.target.model.api === 'openai-completions'
    ? reasoningFieldOf([first.off.message, first.medium?.message ?? null, second.result?.message ?? null]) : 'native';
  return { server: { kind: server.kind, version: server.version ?? 'unknown' }, reported: server.reported,
    meta: server.meta, steps: essentialSteps(run, first, second, thinking), field, offRefused: thinking.offRefused,
    phase: 'essentials' };
}

/** @brief B1（原第 5 步）：指定调用 submit_outcome 加严格模式，思考 off（A 级要关闭思考，平行 Agent 规格 §7.5）。 */
async function outcomeStep(run: Run): Promise<ProbeStepResult> {
  const { model } = run.target;
  const api = model.api as ApiType;
  return judgeOutcomeCall(await send(run, { model, thinking: 'off',
    context: { messages: [user(run, PROBE_PROMPTS.outcome)], tools: [OUTCOME_TOOL] },
    toolChoice: forcedToolChoice(api, OUTCOME_TOOL.name),
    onPayload: (payload) => withStrictTools(api, payload, OUTCOME_TOOL.name) }));
}

/** @brief B2（原第 6 步）：严格的 JSON schema 输出。 */
async function jsonStep(run: Run, thinking: ThinkingLevel): Promise<ProbeStepResult> {
  const { model } = run.target;
  const api = model.api as ApiType;
  return judgeJsonOutcome(await send(run, { model, thinking, context: { messages: [user(run, PROBE_PROMPTS.json)] },
    onPayload: (payload) => withJsonSchema(api, payload, OUTCOME_SCHEMA_NAME, OUTCOME_SCHEMA) }));
}

/** @brief B3（§7.8）：一张纯红色的图片，发给 input 有 image 的副本。 */
async function imageStep(run: Run, thinking: ThinkingLevel): Promise<ProbeStepResult> {
  const message: Message = { role: 'user', timestamp: run.deps.now(), content: [
    { type: 'text', text: PROBE_PROMPTS.image },
    { type: 'image', data: PROBE_IMAGE.data, mimeType: PROBE_IMAGE.mimeType }] };
  return judgeImage(await send(run, { model: withImageInput(run.target.model), thinking,
    context: { messages: [message] } }));
}

/** @brief B4（原第 7 步）：文本标签，一次接一次最多 §12 的次数，出错或解析不了就停。 */
async function taggedStep(run: Run, thinking: ThinkingLevel): Promise<ProbeStepResult> {
  const replies: ProbeReply[] = [];
  for (let i = 0; i < run.deps.timings.tierCRepetitions; i += 1) {
    const reply = await send(run, { model: run.target.model, thinking,
      context: { messages: [user(run, PROBE_PROMPTS.tagged)] } });
    replies.push(reply);
    if (reply.error !== null || !parseTagged(replyText(reply.message), OUTCOMES)) break;
  }
  return judgeTagged(replies);
}

/** @brief B4 的条件用：判定为不通过或不适用（§7.3、§7.7）。 */
function failedOrNotApplicable(result: ProbeStepResult): boolean {
  return result.outcome === 'fail' || result.outcome === 'not_applicable';
}

/**
 * @brief 后台一段（§7.8）：B1、B2、B3 同时发出；本组判出 off_refused 时 B1 不适用、不发，anthropic-messages 不发 B2；
 *        B4 只在 B1、B2 都判定不通过或不适用时跑。服务端对 B1、B2、B3 回 400、422 也算判定为不通过（§7.3）。
 * @param offRefused 本组（或存下的必需一段）判出 off_refused
 */
async function backgroundRounds(run: Run, offRefused: boolean): Promise<Pick<AutoSteps, 'a' | 'b' | 'c' | 'image'>> {
  const thinking = probeThinking(offRefused);
  run.deps.onStep?.(3, PROBE_ROUNDS);
  const [a, b, image] = await Promise.all([
    offRefused ? step('not_applicable') : outcomeStep(run),
    run.target.model.api === 'anthropic-messages' ? step('not_applicable') : jsonStep(run, thinking),
    imageStep(run, thinking)]);
  if (!failedOrNotApplicable(a) || !failedOrNotApplicable(b)) return { a, b, c: step('not_run'), image };
  run.deps.onStep?.(4, PROBE_ROUNDS);
  return { a, b, c: await taggedStep(run, thinking), image };
}

/** @brief 后台一段的结果写进 base，phase 为 all。 */
async function withBackground(run: Run, base: AutoResults): Promise<AutoResults> {
  const tiers = await backgroundRounds(run, base.offRefused === true);
  return { ...base, steps: { ...base.steps, ...tiers }, phase: 'all' };
}

/** @brief 一组探针的上下文：全部请求发给没有“没有 Off”标记的副本（§7.7：标记过的模型点 Verify 时第 2 步仍然重新测）。 */
function runOf(target: ProbeTarget, deps: ProbeDeps): Run {
  return { deps, target: { ref: target.ref, model: withoutNoOffMarker(target.model) } };
}

/** @brief 跑 body；这组探针被取消时为 null，其他异常照抛。 */
async function cancellable(deps: ProbeDeps, body: () => Promise<AutoResults>): Promise<AutoResults | null> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ProbeCancelled || deps.signal.aborted) return null;
    throw error;
  }
}

/**
 * @brief 两段探针（§7.3、§7.4、§7.8）。必需一段：第 0 步（经读取器，model-discovery.md §7.1，不计入短请求）与 E1–E4；
 *        tool calling 验证通过时先经 onEssentials 存下，再跑后台一段；没通过时不跑后台一段（后台各步为 not_run）。
 *        结果总带 meta（§7.2）与 offRefused（§7.7）。
 * @return phase 为 all 的结果；这组探针被取消时为 null
 */
export async function runAutoProbes(target: ProbeTarget, deps: ProbeDeps): Promise<AutoResults | null> {
  const run = runOf(target, deps);
  return cancellable(deps, async () => {
    const essentials = await essentialRounds(run);
    const tools = toolCallingOf(essentials.steps.call, essentials.steps.result);
    if (tools !== 'verified') return { ...essentials, phase: 'all' };
    await deps.onEssentials?.(essentials);
    return withBackground(run, essentials);
  });
}

/**
 * @brief 只跑后台一段（§7.8：只有后台各步出错时的自动重试、启动时 phase 为 essentials 的档案），结果写进 base。
 * @param base 存下的结果；后台的强度按它的 offRefused
 * @return phase 为 all 的结果；这组探针被取消时为 null
 */
export async function runBackgroundProbes(target: ProbeTarget, deps: ProbeDeps,
  base: AutoResults): Promise<AutoResults | null> {
  const run = runOf(target, deps);
  return cancellable(deps, () => withBackground(run, base));
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
