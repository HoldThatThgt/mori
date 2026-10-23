// 合成测试端点（synthetic）的增强脚本：只用于测试，回复按测试写好的脚本文件合成，不是真实模型的行为。
// 规则来自 docs/specs/memory.md §14.1；server.mjs 先认探针、pi 的压缩请求与脚本模式（scripts.mjs），再按本文件认增强会话，
// 都不是时才用关键词规则（replies.mjs）。
//
// 认出增强会话：请求里没有 "tb-scenario:" 时，最后一条不只有工作卡的用户消息以附录 B 的第一句
//   "You are running Mori's daily <KIND> enhancement" 开头（KIND 为 TASTE、STRATEGY、REVIEW），从中读出 <KIND>。
//   只认增强会话自己的第一条消息：协作模式下立项的投递以 "[Mori] New user message:" 开头，task 实例的投递是
//   "[Mori] You are <role> on T1…"，都不认。
// 脚本文件：环境变量 FAKE_ENHANCE_SCRIPT 指向一个 JSON 文件，每次请求时重新读（测试在两次运行之间改写它）：
//   { "<kind>": [step, …] }，<kind> 为小写的 taste、strategy、review；步骤为 { "say": "…" } 或
//   { "call": "<工具名>", "args": {…} }（同一步里两者都写时先说再调用）。另可加 "wait": <毫秒>（本端点的约定，规格没有写）：
//   这一步的第一个分块前多等这么久，测运行中的增强（记忆页在运行中保存、Running 标记、串行）。
//   第几步 = 那条用户消息之后的助手消息数（从 0 起）；步骤用完时回复 "Done."。
//   会话路径与条目 id 由测试写进 args（测试自己写的会话文件，知道它们）。
//   没有这个环境变量、文件不存在、或文件里没有这种 <kind> 时，按普通关键词模式回答；文件不是合法的 JSON 时抛错（端点回 400）。
//   另有两条本端点的约定（规格没有写，tests/ui/mem-app-enhance-*.mjs 用）：
//   - 键可以写成 "<kind>@<文字>[@<文字>…]"：第一条消息的第一行（含项目 cwd 与 "Day: <Mon D, YYYY>"）含有每一段文字时
//     才用它；几个键都合用时取段数最多的（同样多时取文件里靠前的），都不合用时再看 "<kind>"。同时有几个项目、几天的运行时，
//     各自用自己的步骤。
//   - 步骤 { "fail": <状态码> }：这一次请求立即以该状态码返回 OpenAI 形状的错误（"Synthetic HTTP <状态码> from the
//     enhancement script"，不看 "wait"）；测写入之后端点出错的增强运行（失败但已写入改动）。
// 日志：每个对话请求的 JSON 日志行另加 "enhance"：认出的增强会话的 <kind>（小写），不是增强会话时为 null
//   （有没有脚本都记）。
// 端点出错与运行中的增强用已有的办法（§14.1）：增强设置选模型 id 带 -404、-hang 后缀的模型（server.mjs 开头），
//   以及脚本模式的 fail、wait。

import { existsSync, readFileSync } from 'node:fs';
import { contentText } from './replies.mjs';
import { withoutWorkCards } from './scripts.mjs';

/** 附录 B 第一句的开头：读出 <KIND> */
const FIRST_LINE = /^You are running Mori's daily (TASTE|STRATEGY|REVIEW) enhancement/;
/** 步骤用完时的回复 */
export const ENHANCE_DONE = 'Done.';

/**
 * @brief 认出增强会话：最后一条不只有工作卡的用户消息以附录 B 的第一句开头时，返回它在 messages 里的位置、种类与第一行。
 * @param messages 请求的消息（含只有工作卡的消息，这里自己去掉）
 * @return { kind（小写）, index（那条用户消息在 messages 里的位置）, firstLine（那条消息的第一行） }；
 *         不是增强会话时为 null
 */
function enhanceStart(messages) {
  const kept = withoutWorkCards(messages);
  const last = kept.findLast((m) => m.role === 'user');
  const text = last ? contentText(last.content) : '';
  const match = FIRST_LINE.exec(text);
  return match ? { kind: match[1].toLowerCase(), index: messages.indexOf(last), firstLine: text.split('\n')[0] }
    : null;
}

/**
 * @brief 日志用的增强种类：请求里没有 tb-scenario 时按 enhanceStart 认；脚本模式的请求一律为 null。
 * @param messages 请求的消息
 * @param scenario scripts.mjs sessionOf 的 scenario
 * @return 小写的种类或 null
 */
export function enhanceKindOf(messages, scenario) {
  return scenario === null ? enhanceStart(messages)?.kind ?? null : null;
}

/** @brief 读脚本文件；没有环境变量或文件不存在时为 null，不是合法的 JSON 时抛错。 */
function readScript() {
  const file = process.env.FAKE_ENHANCE_SCRIPT;
  if (!file || !existsSync(file)) return null;
  const script = JSON.parse(readFileSync(file, 'utf8'));
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    throw new Error(`FAKE_ENHANCE_SCRIPT ${file} must hold a JSON object`);
  }
  return script;
}

/**
 * @brief 这次运行用的步骤（规则见文件开头）："<kind>@<文字>…" 的键在第一行含有每一段文字时合用，取段数最多的；
 *        都不合用时为 "<kind>" 的步骤。
 * @param script 脚本文件的内容
 * @param start enhanceStart 的结果
 * @return 步骤数组；没有时为 undefined
 */
function stepsFor(script, start) {
  let best = null;
  for (const [key, steps] of Object.entries(script)) {
    const [kind, ...parts] = key.split('@');
    if (kind !== start.kind || parts.length === 0 || !parts.every((part) => start.firstLine.includes(part))) continue;
    if (!best || parts.length > best.parts) best = { parts: parts.length, steps };
  }
  return best ? best.steps : script[start.kind];
}

/** @brief 一个步骤的回复：文字与零到一个工具调用，"wait" 修饰第一个分块前的等待；"fail" 时为这次请求的错误。 */
function renderStep(step) {
  if (Number.isInteger(step?.fail)) {
    const message = `Synthetic HTTP ${step.fail} from the enhancement script`;
    return { failure: { status: step.fail, body: { error: { message, type: 'synthetic_error' } } } };
  }
  const text = typeof step?.say === 'string' ? step.say : '';
  const toolCalls = typeof step?.call === 'string' ? [{ name: step.call, args: step.args ?? {} }] : [];
  if (text === '' && toolCalls.length === 0) throw new Error(`Bad enhancement step: ${JSON.stringify(step)}`);
  return { reply: { text, toolCalls, delayMs: Number(step.wait ?? 0) } };
}

/**
 * @brief 增强会话的脚本回复（规则见文件开头）。
 * @param messages 请求的消息
 * @param scenario scripts.mjs sessionOf 的 scenario（不为 null 时不认增强会话）
 * @return { reply: { text, toolCalls, delayMs } } 或 { failure: { status, body } }（"fail" 步骤）；不是增强会话、
 *         没有脚本或脚本里没有这种时为 null（按关键词回答）
 */
export function enhanceReply(messages, scenario) {
  if (scenario !== null) return null;
  const start = enhanceStart(messages);
  if (!start) return null;
  const script = readScript();
  const steps = script ? stepsFor(script, start) : undefined;
  if (!Array.isArray(steps)) return null;
  const j = messages.slice(start.index + 1).filter((m) => m.role === 'assistant').length;
  if (j >= steps.length) return { reply: { text: ENHANCE_DONE, toolCalls: [], delayMs: 0 } };
  return renderStep(steps[j]);
}
