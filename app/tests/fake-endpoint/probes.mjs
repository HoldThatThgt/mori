// 合成测试端点（synthetic）的探针部分：只用于测试，不是真实模型。
// 认出 docs/specs/model-providers.md §7.3 第 1–9 步的请求，一律按"能力全通过"回答；
// 模型 id 的后缀只关掉对应的探针能力（-notools、-nochoice、-noschema、-replay、-truncate），规则见 server.mjs 开头。

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
/** 第 8 步的约定：开头 "The passphrase is <暗号>."，结尾问 "What is the passphrase?" */
const PASSPHRASE_QUESTION = 'What is the passphrase?';
const PASSPHRASE = /passphrase is[:\s]*"?([A-Za-z0-9_-]+)/i;
const NO_PASSPHRASE = "I don't see a passphrase.";
/** 第 9 步的约定：提示以 "Count from 1 to <N>" 开头，回一个长输出 */
const COUNT = /^Count from 1 to (\d+)/i;
const COUNT_MAX = 400;
/** -truncate：估算的输入超过窗口的这个比例时静默丢掉开头（暗号随之丢失） */
const TRUNCATE_RATIO = 0.7;
const PROBE_THINKING = 'Synthetic reasoning for this probe.';

/** @brief 请求是否开了思考：pi 对 OpenAI 兼容端点开思考时带 reasoning_effort。 */
export function thinkingOn(body) {
  const effort = body.reasoning_effort;
  return typeof effort === 'string' && effort !== 'none';
}

/** @brief 认出探针第几步：看最后一条消息；不是探针时为 0（第 1、2 步都返回 1）。 */
export function probeStep(messages) {
  const last = messages[messages.length - 1];
  const text = contentText(last?.content).trim();
  if (last?.role === 'tool') return text.includes(WEATHER_RESULT) ? 4 : 0;
  if (last?.role !== 'user') return 0;
  const steps = [[PROMPTS.ready, 1], [PROMPTS.weather, 3], [PROMPTS.temperature, 4], [PROMPTS.outcome, 5],
    [PROMPTS.json, 6], [PASSPHRASE_QUESTION, 8]];
  for (const [prompt, step] of steps) if (text.includes(prompt)) return step;
  if (text.includes('<summary>') && text.includes('<outcome>')) return 7;
  return COUNT.test(text) ? 9 : 0;
}

/** @brief 第 8 步的回答：找到暗号就复述；-truncate 且输入超过窗口的 TRUNCATE_RATIO 时答不出。 */
function passphraseAnswer(messages, flags, window) {
  const tokens = Math.ceil(JSON.stringify(messages).length / 4);
  if (flags.has('truncate') && tokens > window * TRUNCATE_RATIO) return NO_PASSPHRASE;
  const all = messages.map((m) => contentText(m.content)).join('\n');
  return PASSPHRASE.exec(all)?.[1] ?? NO_PASSPHRASE;
}

/** @brief 第 9 步的长输出：从 1 数到 N（最多 COUNT_MAX），每行一个。 */
function countReply(messages) {
  const asked = COUNT.exec(contentText(messages[messages.length - 1]?.content).trim())?.[1];
  const n = Math.min(Number(asked ?? 1), COUNT_MAX);
  return Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
}

/** @brief 各步的回答（不含思考）。 */
function probeAnswer(step, body, flags, window) {
  const text = (value) => ({ text: value, toolCalls: [] });
  const call = (name, args) => ({ text: '', toolCalls: [{ name, args }] });
  const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
  const messages = body.messages ?? [];
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
  if (step === 7) return text('<summary>The sky is clear today.</summary><outcome>ok</outcome>');
  if (step === 8) return text(passphraseAnswer(messages, flags, window));
  return text(countReply(messages));
}

/**
 * @brief 探针的回复：开了思考时附一段 reasoning_content。
 * @param step 探针第几步（probeStep 的结果，大于 0）
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @param window 这个端点报告的窗口（max_model_len），-truncate 用
 */
export function probeReply(step, body, flags, window) {
  const reply = probeAnswer(step, body, flags, window);
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
