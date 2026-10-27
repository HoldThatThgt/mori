// 合成测试端点（synthetic）的收尾检查部分：只用于测试，回复按下面的规则合成，不是真实模型的行为。
// 规则来自 docs/specs/finish-check.md §14.1（§0 第 12、15 条）；server.mjs 先认探针与 pi 的压缩请求，再按本文件
// （finishReply），然后才是脚本模式（scripts.mjs）、增强脚本（enhance.mjs）与关键词（replies.mjs）。
// 不放进 scenarios/：scripts.mjs 在顶层 await 里载入那里的每个文件，那里的文件 import scripts.mjs 会互相等待（退出码 13）；
// 本文件 import scripts.mjs，scripts.mjs 不 import 本文件。
//
// 认出检查请求（checkPlan，只认、不回答）：scripts.mjs sessionOf 的 check 与 checks（规则见 scripts.mjs 开头）。
//   - check：去掉末尾只有工作卡的 user 消息之后，最后一条是 user 消息、去掉首部空白后以 CHECK_LINE_HEAD 开头
//     （不用相等：换模型的说明可能接在末尾，server.mjs 的 MORI_NOTE）。只在中间引用这句话的消息、工作卡本身都不算。
//   - checks：起点（最后一次投递：最后一条既不是检查那一行、也不是只有工作卡的 user 消息）之后检查那一行的条数，
//     含末尾那一行。文件系统实现时末尾的提醒（"[Mori] The user was away" 开头）同样跳过，见 scripts.mjs 开头。
// 判断顺序（finishReply；server.mjs 在压缩请求之后、脚本模式之前调它）：
//   1. fc 场景：起点那条消息里有 "fc-scenario:<名字>"、且请求的 tools 里有 finish 时，这次运行的每个请求（含检查请求）
//      都由 FC_SCENARIOS[名字] 回答。只认 tools 里有 finish 的请求（用户会话：关闭模式与协作模式的对话、合并会话），
//      因为分开时你的原文也会进立项实例的投递（"[Mori] New user message: …"）；那里照旧按 tb-scenario 脚本或关键词。
//   2. 其余的检查请求：默认只回一个 finish 调用（参数 {}）、不写字，脚本模式与关键词模式都一样（现有场景不用逐个改）。
//   3. 都不是时为 null：server.mjs 接着按脚本模式、增强脚本、关键词回答。
//   加思考的钩子在 server.mjs，照旧作用于这里的回复：-replay 开着思考时（conversationPlan）、-alwaysthink、-nooff
//   （handleChat）。-replay 的 finish 调用不带思考时，之后开着思考的请求会被端点按 400 拒绝，所以不能去掉。
// fc 场景的步骤：FC_SCENARIOS[名字][n] 是步骤列表（steps.mjs 的构造函数，格式同 scripts.mjs 开头），n 为起点之后检查那一行
//   的条数；取第 m 个回复步骤，m 为最近一行检查之后（n 为 0 时起点之后）的助手消息数（单独一项的 wait、fail 不占步骤，
//   修饰紧随其后的回复步骤；最后一项是修饰时修饰一个空回复）。fail 的错误体为 "Synthetic HTTP <状态码> from script <名字>"；
//   失败的请求没有助手消息，下一次请求仍是同一个 m。找不到场景或步骤时回 NO_STEP_TEXT，并在 stderr 记一行
//   "no script step"（同 scripts.mjs）。
// 日志：fc 场景回答的请求，日志行的 scenario 记场景名（scripts.mjs logFields 的 fc）；每行都记 check 与 checks。
// 场景名写在你的消息里；程序投递到用户会话开始的运行，由脚本里的发送方把 "fc-scenario:<名字>" 写进 agent_message 的正文。

import { isCheckLine, sessionOf, stepAt, stepReply, toolName } from './scripts.mjs';
import { call, fail, say, think, together, wait } from './steps.mjs';

/** finish 工具的名字（同 src/shared/finishCheck.ts 的 FINISH_TOOL，FC-26 比对） */
export const FINISH_TOOL = 'finish';
/** 起点那条消息里选 fc 场景的标记 */
const FC_SCENARIO = /fc-scenario:([\w-]+)/;
/** fc-slow 检查那次请求第一个分块前等多久（停止、排队、插话用） */
export const FC_SLOW_MS = 8000;
/** fc-a-think 两次回复的思考 */
export const FC_THOUGHTS = {
  reply: 'Synthetic reasoning before the reply.',
  check: 'Synthetic reasoning before confirming the reply.',
};

/** @brief 只调 finish、参数为 {}（确认）。 */
const confirm = () => call(FINISH_TOOL, {});
/** fc-cap 每次检查之后：干活，结果回来后再说一句 */
const busy = [call('bash', { command: 'echo fc-cap' }), say('Still working.')];

/**
 * 收尾检查的场景（收尾检查规格 §14.1 的表）：名字 → { <起点之后检查那一行的条数 n>: [步骤…] }；
 * 第 m 个回复步骤回答最近一行检查之后的第 m 次请求
 */
export const FC_SCENARIOS = {
  // a：检查后只调 finish
  'fc-a': { 0: [say('Done.')], 1: [confirm()] },
  // a，开着思考：两次回复都先有一段思考
  'fc-a-think': { 0: [together(think(FC_THOUGHTS.reply), say('Done.'))],
    1: [together(think(FC_THOUGHTS.check), confirm())] },
  // a，确认时另写一句话（同一条消息）
  'fc-a-text': { 0: [say('Done.')], 1: [together(say('The reply stands.'), confirm())] },
  // b：说了要做却停了；检查后干活、再回复，第二次检查确认
  'fc-b': { 0: [say("I'll run the tests.")], 1: [call('bash', { command: 'echo fc-b' }), say('The tests passed.')],
    2: [confirm()] },
  // c：检查后重写，不调 finish，不再检查
  'fc-c': { 0: [say('Draft answer.')], 1: [say('Conclusion first: rewritten answer.')] },
  // 上限：每次检查之后都干活，第 3 次检查之后照样干活，第 4 个边界放行
  'fc-cap': { 0: [say('Working.')], 1: busy, 2: busy, 3: busy },
  // finish 与 bash 同一条消息：不算确认，再检查一次
  'fc-mixed': { 0: [say('Done.')],
    1: [together(confirm(), call('bash', { command: 'echo fc-mixed' })), say('Done again.')], 2: [confirm()] },
  // finish 带参数（校验失败），之后只写字，不再检查
  'fc-bad-args': { 0: [say('Done.')], 1: [call(FINISH_TOOL, { reply: 'Done.' }), say('Final reply.')] },
  // 检查之前就调了 finish：照样检查一次
  'fc-early': { 0: [together(say('Done.'), confirm())], 1: [confirm()] },
  // 检查那次请求等 8 秒再确认
  'fc-slow': { 0: [say('Done.')], 1: [together(wait(FC_SLOW_MS), confirm())] },
  // 检查那次请求出错（模型层不重试、不换模型的错误）
  'fc-fail': { 0: [say('Done.')], 1: [fail(400)] },
  // 第一个请求就出错
  'fc-fail-first': { 0: [fail(400)] },
  // 检查那次请求 404（模型不可用；会话的范围只有这一个模型时候选耗尽）
  'fc-404': { 0: [say('Done.')], 1: [fail(404)] },
  // 检查之后干了活，结果回来后的那次请求出错
  'fc-work-fail': { 0: [say('Done.')], 1: [call('bash', { command: 'echo fc' }), fail(400)] },
};

/**
 * @brief 认出检查请求（只认、不回答，规则见文件开头）；记录代理与测试按它给请求标 check。
 * @param body OpenAI 形状的对话请求体
 * @return { check（这次是检查请求）, checks（起点之后检查那一行的条数） }
 */
export function checkPlan(body) {
  const { check, checks } = sessionOf(body.messages ?? []);
  return { check, checks };
}

/**
 * @brief 回答这次请求的 fc 场景名：起点那条消息（最后一次投递）里有 "fc-scenario:<名字>"，且请求的 tools 里有 finish。
 * @param body 请求体
 * @param info scripts.mjs sessionOf 的结果
 * @return 场景名；不归 fc 场景回答时为 null
 */
export function fcScenarioOf(body, info) {
  const name = FC_SCENARIO.exec(info.last ?? '')?.[1];
  if (name === undefined) return null;
  return (body.tools ?? []).some((tool) => toolName(tool) === FINISH_TOOL) ? name : null;
}

/** @brief 下标 index 之后的助手消息数。 */
const assistantsAfter = (messages, index) => messages.slice(index + 1).filter((m) => m.role === 'assistant').length;

/**
 * @brief fc 场景的回复：按起点之后检查那一行的条数 n 选步骤列表，按最近一行检查之后的助手消息数 m 取步骤。
 * @param name 场景名
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @param info scripts.mjs sessionOf 的结果
 */
function scenarioReply(name, body, flags, info) {
  const messages = body.messages ?? [];
  const n = info.checks;
  const m = n === 0 ? info.j : assistantsAfter(messages, messages.findLastIndex(isCheckLine));
  const steps = FC_SCENARIOS[name]?.[n];
  return stepReply(steps ? stepAt(steps, m) : null, body, flags, info, { scenario: name, checks: n, step: m });
}

/**
 * @brief 收尾检查的回复（判断顺序见文件开头）：fc 场景回答它运行里的每个请求；其余的检查请求只回一个 finish 调用。
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @param info scripts.mjs sessionOf 的结果
 * @return { failure: { status, body, headers } } 或 { reply: { text, toolCalls, thinking?, delayMs } }；
 *         不归这里回答时为 null
 */
export function finishReply(body, flags, info) {
  const name = fcScenarioOf(body, info);
  if (name !== null) return scenarioReply(name, body, flags, info);
  if (!info.check) return null;
  return { reply: { text: '', toolCalls: [{ name: FINISH_TOOL, args: {} }], delayMs: 0 } };
}
