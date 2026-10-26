// 合成测试端点（synthetic）的探针部分：只用于测试，不是真实模型。
// 认出 docs/specs/model-providers.md §7.3 第 1–7 步的请求，一律按"能力全通过"回答；
// 模型 id 的后缀只关掉对应的探针能力（-notools、-nochoice、-noschema、-replay），规则见 server.mjs 开头；
// -alwaysthink 给每个回复加思考，在 server.mjs 里处理（探针的回复也一样）。
// 2026-10-24（§7.7、§14.1）：
//   - "开了思考"（thinkingOn）：请求带 reasoning_effort 或 reasoning.effort（pi 的 OpenRouter 写法），且不是 "none"；
//     requestedEffort 给出请求里的强度原值（日志的 "effort" 字段）。
//   - -nooff（对所有请求，判定在这里，回 400 在 server.mjs）：请求里带明确的"关闭思考"（explicitThinkingOff 的三种写法）
//     时回 400，响应体逐字节为 NOOFF_ERROR_BODY（2026-10-24 在 OpenRouter 上录下的原文）。
//   - -thinklong（只对探针）：开了思考时回一段超过 256 token 的思考（THINKLONG_THINKING），没有正文，
//     finish_reason 为 "length"（回复的 finishReason）；没开思考时照常回答。
// 2026-10-26 补（synthetic，models-settings.md“Models 行”的出错写法）：
//   - -toollong（只对探针第 3、4 步）：不论开没开思考都同 -thinklong 那样回，tool calling 因出错没有验证。
//   - -offlong、-offsilent（与 -nooff 一起用）：-nooff 拒绝了一次带“关闭思考”的第 1、2 步提示之后，这个模型下一次开着思考的
//     第 1、2 步提示（第 2 步的 medium）：-offlong 同 -thinklong；-offsilent 只回一段思考、正常结束（afterRefusedOff）。
// 2026-10-26（负责人走查 M7）：探针第 8、9 步删掉，第 8 步的暗号、第 9 步的长输出与 -truncate 随之删掉。

import { contentText } from './replies.mjs';

/** §7.3 第 1–6 步提示的原文（第 1、2 步同一句） */
const PROMPTS = {
  ready: 'Reply with the single word: ready.',
  weather: 'Use the tool to get the weather for Paris for the next 3 days.',
  temperature: 'What temperature did the tool report?',
  outcome: 'Call submit_outcome with outcome banana.',
  json: 'Reply with JSON whose outcome is banana.',
};
/** 第 4 步的工具结果 */
const WEATHER_RESULT = 'Paris: 21°C, sunny for 3 days.';
const PROBE_THINKING = 'Synthetic reasoning for this probe.';

/** -nooff 拒绝"关闭思考"时的 HTTP 状态（§14.1，2026-10-24） */
export const NOOFF_STATUS = 400;
/** -nooff 拒绝时响应体里的 message 原文（OpenRouter，2026-10-24 实测） */
export const NOOFF_MESSAGE = 'Reasoning is mandatory for this endpoint and cannot be disabled.';
/** -nooff 拒绝时的响应体，逐字节照 2026-10-24 在 OpenRouter 上录下的原文发出（§14.1） */
export const NOOFF_ERROR_BODY = `{"error":{"message":"${NOOFF_MESSAGE}","code":400,`
  + '"metadata":{"provider_name":null}}}';
/** -thinklong 的思考：远超 256 token（按每 token 约 4 个字符，超过 1100 字），只有思考没有正文（§7.7 输出上限） */
export const THINKLONG_THINKING = ('Synthetic long reasoning for this probe: it keeps weighing the question and '
  + 'never reaches an answer. ').repeat(18);
/** -thinklong 的回复以这个 finish_reason 结束（输出上限） */
export const THINKLONG_FINISH = 'length';
/** -thinklong 的思考每个分块的字数（大一些，避免几百个分块拖慢探针） */
const THINKLONG_PIECE = 64;

/**
 * @brief 请求里的思考强度原值（§14.1 日志的 "effort" 字段）：reasoning_effort ?? reasoning.effort ?? null。
 * @param body 对话请求体
 * @return 强度原值（通常是字符串，例如 "medium"、"minimal"、"none"）；都没有时为 null
 */
export function requestedEffort(body) {
  return body.reasoning_effort ?? body.reasoning?.effort ?? null;
}

/**
 * @brief 请求是否开了思考（§14.1，2026-10-24）：带 reasoning_effort 或 reasoning.effort（pi 的 OpenRouter 写法），
 *        且不是 "none"。
 * @param body 对话请求体
 */
export function thinkingOn(body) {
  const effort = requestedEffort(body);
  return typeof effort === 'string' && effort !== 'none';
}

/**
 * @brief 请求里是否带明确的"关闭思考"（§7.7、§14.1）：reasoning.effort 为 "none"（OpenRouter）、
 *        reasoning.enabled 为 false（Together）或 thinking.type 为 "disabled"（DeepSeek、z.ai、Anthropic）。
 *        不带思考参数不算。
 * @param body 对话请求体
 */
export function explicitThinkingOff(body) {
  return body.reasoning?.effort === 'none' || body.reasoning?.enabled === false
    || body.thinking?.type === 'disabled';
}

/**
 * @brief -nooff 模型拒绝的请求（§14.1，对所有请求，探针与否都一样）：带明确的"关闭思考"；
 *        这时回 NOOFF_STATUS，响应体为 NOOFF_ERROR_BODY。
 * @param body 对话请求体
 * @param flags 模型 id 的后缀集合
 */
export function noOffRejected(body, flags) {
  return flags.has('nooff') && explicitThinkingOff(body);
}

/** @brief 认出探针第几步：看最后一条消息；不是探针时为 0（第 1、2 步都返回 1）。 */
export function probeStep(messages) {
  const last = messages[messages.length - 1];
  const text = contentText(last?.content).trim();
  if (last?.role === 'tool') return text.includes(WEATHER_RESULT) ? 4 : 0;
  if (last?.role !== 'user') return 0;
  const steps = [[PROMPTS.ready, 1], [PROMPTS.weather, 3], [PROMPTS.temperature, 4], [PROMPTS.outcome, 5],
    [PROMPTS.json, 6]];
  for (const [prompt, step] of steps) if (text.includes(prompt)) return step;
  return text.includes('<summary>') && text.includes('<outcome>') ? 7 : 0;
}

/** @brief 各步的回答（不含思考）。 */
function probeAnswer(step, body, flags) {
  const text = (value) => ({ text: value, toolCalls: [] });
  const call = (name, args) => ({ text: '', toolCalls: [{ name, args }] });
  const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
  if (step === 1) return text('ready');
  if (step === 3) {
    if (flags.has('notools') || !tools.includes('get_weather')) return text('It is probably sunny in Paris.');
    return call('get_weather', { city: 'Paris', days: 3 });
  }
  if (step === 4) return text('The tool reported 21°C and sunny weather.');
  if (step === 5) {
    if (flags.has('nochoice') || !tools.includes('submit_outcome')) return text('banana');
    return call('submit_outcome', { outcome: 'ok' });
  }
  if (step === 6) {
    const schema = body.response_format?.type === 'json_schema' && !flags.has('noschema');
    return text(JSON.stringify({ outcome: schema ? 'ok' : 'banana' }));
  }
  return text('<summary>The sky is clear today.</summary><outcome>ok</outcome>');
}

/** @brief 只有一段超过 256 token 的思考、以输出上限结束的回复（-thinklong、-toollong、-offlong）。 */
const longThinking = () => ({ thinking: THINKLONG_THINKING, text: '', toolCalls: [], finishReason: THINKLONG_FINISH,
  thinkingPiece: THINKLONG_PIECE });

/**
 * @brief -offlong、-offsilent（2026-10-26 补，synthetic；models-settings.md“关不掉、开思考也没答上”，规格 §7.7 第 2 步表
 *        第 4 行）：-nooff 拒绝了这个模型一次带“关闭思考”的第 1、2 步提示之后，它下一次开着思考的第 1、2 步提示（第 2 步的
 *        medium）的回复。-offlong 只回超过 256 token 的思考、以 length 结束（第 2 步出错，“Stopped at the probe output
 *        limit before answering”）；-offsilent 只回一段思考、正常结束（没有正文，第 2 步用 off 被拒的原文出错）。
 *        server.mjs 记下被拒的模型，只用一次。
 * @param flags 模型 id 的后缀集合
 * @return 回复；两个后缀都没有时为 null（照常回答）
 */
export function afterRefusedOff(flags) {
  if (flags.has('offlong')) return longThinking();
  if (flags.has('offsilent')) return { thinking: PROBE_THINKING, text: '', toolCalls: [] };
  return null;
}

/**
 * @brief 探针的回复：开了思考时附一段 reasoning_content；-thinklong 开了思考时只回一段很长的思考，以输出上限结束（§7.7）；
 *        -toollong（2026-10-26 补，synthetic）第 3、4 步不论开没开思考都这样回（tool calling 因出错没有验证，
 *        models-settings.md“停在探针输出上限”的第 3、4 步那一支）。
 * @param step 探针第几步（probeStep 的结果，大于 0）
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @return { text, toolCalls, thinking?（思考）, finishReason?（没有时按有没有工具调用为 tool_calls 或 stop）,
 *         thinkingPiece?（思考每个分块的字数，没有时为 4） }
 */
export function probeReply(step, body, flags) {
  if (flags.has('thinklong') && thinkingOn(body)) return longThinking();
  if (flags.has('toollong') && (step === 3 || step === 4)) return longThinking();
  const reply = probeAnswer(step, body, flags);
  if (thinkingOn(body)) reply.thinking = PROBE_THINKING;
  return reply;
}

/**
 * @brief -replay 模型拒绝的请求：有带工具调用、却没有 reasoning_content 的助手消息，
 *        并且这次请求开了思考，或那个调用是本端点开着思考时发出的。
 * @param reasonedCalls 本端点带思考发出的工具调用 id
 */
export function replayRejected(body, flags, reasonedCalls) {
  if (!flags.has('replay')) return false;
  const thinking = thinkingOn(body);
  return (body.messages ?? []).some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0
    && m.reasoning_content === undefined && (thinking || m.tool_calls.some((c) => reasonedCalls.has(c.id))));
}
