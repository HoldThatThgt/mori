// 合成测试端点（synthetic）的脚本模式：只用于测试，回复按下面的脚本合成，不是真实模型的行为。
// 规则来自 docs/specs/parallel-agents-taskboard.md §17.1；server.mjs 先认探针、pi 的压缩请求与收尾检查（finish.mjs：
// fc-* 场景与检查请求的默认回应），再按本文件认脚本，都不是时才用关键词规则（replies.mjs）。
//
// 选脚本：请求里（system、developer、全部 user 消息，含工作卡）按消息顺序出现的第一个 "tb-scenario:<名字>"。
//   脚本模式下不用普通的关键词规则，也不用模型层的故障关键词（http-NNN、http-NNN-once、overflow-once、slow、
//   drop-after-first）：故障只来自脚本的 fail 步骤。照旧生效的：探针（先认）、pi 的压缩请求（回摘要）、
//   认证（FAKE_*_KEYS）、模型 id 的后缀（-nochoice、-noschema 见 handoff；-404、-hang、-stall、-replay 与
//   模型 fake-slow 同 server.mjs 开头），它们是测试显式写下的配置，不随文字传到别的会话。
// 认会话：键为（角色，种类，task）。
//   - 角色：system 里第一个 "MORI-ROLE-<名字>"（测试写进 .mori/agents/<名字>.md 的正文），没有时为 BASE_ROLE（基座）。
//   - 种类：system 里按 KIND_ORDER 的优先级找附录 A 各段固定的第一句（SEGMENT_SENTENCES；不要求在行首，<…> 只匹配
//     固定的部分）：close（结案段）、task（task 实例段）、subagent（普通模式的 subagent 段，docs/specs/subagent.md
//     §6.1、§14.1）、ask（临时提问段）、subscription（订阅段）、
//     merged-create（合并会话的立项段）、create（分开时的立项段）、team-dialog（协作模式的对话段）、
//     off-dialog（关闭模式的对话段）；都没有时为 DEFAULT_KIND（关闭模式的对话，与 v0 相同）。
//   - task：工作卡里 "You are <role> on T<n>" 一行的 T<n>；没有时为 null。
// 步骤无状态（每次只看这个请求）：
//   - 工作卡（WORK_CARD_OPEN 到 WORK_CARD_CLOSE 的一段）从 user 消息里去掉，去掉后为空的消息不算。
//   - 收尾检查那一行（去掉首部空白后以 CHECK_LINE_HEAD 开头的 user 消息，docs/specs/finish-check.md §14.1）同工作卡，
//     不算投递，所以 k 与 j 的算法不变。
//   - 投递 = 剩下的 user 消息（工具结果是 tool 角色，不算）；以 RESTART_PREFIX 开头的是 restart 投递，另外计数。
//   - 投递序号 k：最后一次投递是 restart 时为 "restart-<这是第几次 restart>"，否则为不是 restart 的投递数（从 1 起）。
//   - 第几步 j：最后一次投递之后的 assistant 消息数（从 0 起）。
// 脚本：SCENARIOS[名字] 是会话条目的列表 { role, kind, task?, match?, deliveries: { <k>: [步骤…] } }。按角色与种类取
//   第一个匹配的条目（条目写了 task 时 task 也要相同；写了 match 时最后一次投递里要有这段文字，同一次调用开出的几个
//   subagent 角色与种类相同，按各自提示里的关键词分开，subagent 规格 §14.1）；deliveries[k] 里第 j 个回复步骤回答这次请求。
// 步骤（用下面的构造函数写）：
//   - say(text)：只回文字（没有工具调用，这次运行就此结束）。
//   - think(text)：一段思考（reasoning_content，先于文字与调用流出）；与 say、call 用 together 合成一个回复。
//   - call(name, args)：调用一个工具。
//   - end()：回 END_TEXT 就结束，不交接。
//   - handoff(fields, { malformed })：交接单，按请求的形状输出（§7.5）：
//       A：tool_choice 指定了 tools 里的一个函数（task_handoff；强制关闭时 request_close），模型 id 没有 -nochoice：
//          调用它，参数为 fields；那个工具带 strict 时，schema 里有而 fields 里没有的字段填 null。
//       B：不是 A，response_format 为 json_schema，模型 id 没有 -noschema：正文是 fields 的 JSON（strict 时同样填 null）。
//       C：其余：正文是标签。tool_choice 指定 request_close、json_schema 的字段有 request 而没有 task、或最后一次投递里
//          有强制关闭的标签格式 CLOSE_REQUEST_TAGS 时，按强制关闭写 "<outcome>…</outcome><conclusion>…</conclusion>"；
//          结案会话写 "<conclusion>…</conclusion><outcome>…</outcome><next>…</next>"；其他会话写 task 实例的
//          conclusion、outcome、next、open_items、evidence 五个标签（列表每行一项；没有的字段标签为空）。
//       malformed 为真时输出在 outcome 的值之前截断的 JSON（A 的参数、B 的正文）或标签（C），程序用不了。
//   - together(...steps)：几个步骤合成一个回复（文字按顺序相接，调用按顺序，例如 [read, task_handoff] 一批）。
//   - wait(ms)：修饰，这个回复的第一个分块前多等 ms 毫秒。
//   - fail(status, { model, retryAfter })：修饰，这次请求以 status 返回 OpenAI 形状的错误；写了 model 时只在请求的模型 id
//     等于它时失败，否则不生效；写了 retryAfter 时响应带 Retry-After（秒）。失败的请求没有 assistant 消息
//     （pi 不把出错的回复发回给模型），下一次请求仍是同一个 j。
//   单独一项的 wait、fail 不占步骤，修饰紧随其后的回复步骤（最后一项是修饰时，修饰一个空回复）；也可以写进 together。
//   找不到条目或步骤（或空回复上的 fail 不生效）时回 NO_STEP_TEXT，并在 stderr 记一行错误。
// 模板：步骤里的字符串可以引用
//   {task}（会话的 task；没有时为最后一次投递里第一个 T<n>，例如结案收到的 "[Mori] T1 was handed to you"）、
//   {request}（工作卡里第一个 "request <n>"，没有时看最后一次投递；整个字符串就是 {request} 时换成数字）、
//   {tag:<工具>}（最近一次这个工具的结果开头 "[#n] " 里的 "#n"）、{lastResult:<工具>}（最近一次这个工具结果的全文）。
//   找不到时换成空字符串。
// 收尾检查（docs/specs/finish-check.md §14.1；fc-* 场景与检查请求的默认回应在 finish.mjs）：sessionOf 的结果另带
//   - check：去掉末尾只有工作卡的 user 消息之后，最后一条是检查那一行（这次是检查请求）；
//   - checks：起点（最后一次投递，即最后一条既不是检查那一行、也不是只有工作卡的 user 消息）之后检查那一行的条数。
//   文件系统实现时（file-system-permissions §9.8 你不在时的提醒）：以 "[Mori] The user was away" 开头的提醒同样跳过，
//   既不算投递、不当起点，也不挡在检查那一行后面（由文件系统的实现加上，收尾检查规格 §11）。
// 日志：server.mjs 给每个对话请求的 JSON 日志行另加 logFields 的字段：agent（角色）、kind、task、scenario（回答这次请求的
//   场景：finish.mjs 的 fc 场景回答时为它的名字，否则为 tb-scenario 的名字；都不是时为 null）、k、j、tools（请求里的
//   工具名）、toolChoice（指定的函数名或 tool_choice 字符串，没有时为 null）、format（response_format.type，没有时为
//   null）、calls（回复里调用的工具名）、check、checks（同上，收尾检查规格 §0 第 15 条）。
// App 测试要用的场景写在 scenarios/<套件>.mjs（导出 SCENARIOS，步骤用 steps.mjs 的构造函数），这里并入（subagent 规格的
// 场景在 scenarios/sa.mjs，名字以 "sa-" 开头）；
// 不是脚本模式的增强会话另有增强脚本（enhance.mjs，docs/specs/memory.md §14.1）；
// 下面 tb-selfcheck-* 三个由 selfcheck.mjs 使用。

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentText } from './replies.mjs';
import { END_TEXT, call, end, fail, handoff, say, think, together, wait } from './steps.mjs';

export { END_TEXT, call, end, fail, handoff, say, think, together, wait };

/** 工作卡的第一行与最后一行（§8.3） */
export const WORK_CARD_OPEN = '<mori-work-card>';
export const WORK_CARD_CLOSE = '</mori-work-card>';
/** task 中途换模型后继续的投递的开头（§12.4） */
export const RESTART_PREFIX = '[Mori] The model changed';
/** 收尾检查那一行的开头（收尾检查规格 §7.1），同 src/shared/finishCheck.ts 的 CHECK_LINE_HEAD（FC-26 比对） */
export const CHECK_LINE_HEAD = "[Mori] This is Mori's end-of-turn check";
/** 共用段的第一句（附录 A），不用来认种类 */
export const SHARED_SENTENCE = "You are <role>, one of several agents that work together on Mori's TaskBoard.";
/** 附录 A 各段固定的第一句：种类 → 句子，<…> 由程序填写 */
export const SEGMENT_SENTENCES = {
  close: 'You close request <n>.',
  task: 'You work on one task of the TaskBoard.',
  subagent: 'You are a subagent: the main agent gave you one task and waits for your final reply.',
  ask: 'Another agent asked you one question.',
  subscription: 'You were woken by a moment you subscribed to.',
  'merged-create': 'You talk to the user and you decide what happens with every user message in task mode.',
  create: 'You decide what happens with every user message in task mode.',
  'team-dialog': 'You are the only agent that talks to the user, and in task mode you relay; '
    + 'you do not decide or do the work.',
  'off-dialog': 'You can ask another role one question with agent_message; it answers once and cannot change files.',
};
/** 认种类的优先级（§17.1） */
export const KIND_ORDER = ['close', 'task', 'subagent', 'ask', 'subscription', 'merged-create', 'create',
  'team-dialog', 'off-dialog'];
/** 都没有时的种类：关闭模式的对话 */
export const DEFAULT_KIND = 'dialog';
/** 没有 MORI-ROLE 标记时的角色：基座 */
export const BASE_ROLE = 'mori';
/** 强制关闭的 C 级标签格式里固定的一段（§7.5）；最后一次投递里有它时 handoff 按强制关闭输出 */
export const CLOSE_REQUEST_TAGS = '<outcome>done|failed</outcome>';
/** 找不到步骤时的回复 */
export const NO_STEP_TEXT = 'The synthetic script has no step for this request.';

const SCENARIO = /tb-scenario:([\w-]+)/;
const ROLE_MARK = /MORI-ROLE-([a-z0-9][a-z0-9-]*)/;
const CARD_TASK = /You are [a-z0-9][a-z0-9-]* on (T\d+)\b/;
const ANY_TASK = /\bT\d+\b/;
const REQUEST_NO = /\b[Rr]equest (\d+)\b/;
const RESULT_TAG = /^\s*\[#(\d+)\] /;
const TEMPLATE = /\{(task|request|tag:[\w-]+|lastResult:[\w-]+)\}/g;
const SYSTEM_ROLES = new Set(['system', 'developer']);
/** C 级标签：表单 → 标签的顺序（§7.5） */
const TAG_FIELDS = {
  task: ['conclusion', 'outcome', 'next', 'open_items', 'evidence'],
  close: ['conclusion', 'outcome', 'next'],
  request_close: ['outcome', 'conclusion'],
};

/** @brief 句子里固定的部分转成正则：<…> 匹配任意文字。 */
function sentencePattern(sentence) {
  const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/<[^>]+>/g, '.+?'));
}

const KIND_PATTERNS = KIND_ORDER.map((kind) => [kind, sentencePattern(SEGMENT_SENTENCES[kind])]);
const textOf = (message) => contentText(message?.content);

// ---------- 场景 ----------

const TASK_FIELDS = { task: '{task}', conclusion: 'README.md was read', outcome: 'done', evidence: ['{tag:read}'] };
const CLOSE_FIELDS = { task: '{task}', conclusion: 'Fixed and verified', outcome: 'close_done' };
const REQUEST_FIELDS = { request: '{request}', outcome: 'done', conclusion: 'The login page works again' };

/** 场景表：名字 → 会话条目的列表（格式见文件开头） */
export const SCENARIOS = {
  // task 实例读一个文件，再带证据交接；第 2、3 次投递是强制填写与格式重试，restart 之后不交接就结束
  'tb-selfcheck-task': [{
    role: 'executor',
    kind: 'task',
    deliveries: {
      1: [fail(503, { model: 'fake-down' }), call('read', { path: 'README.md' }), call('task_handoff', TASK_FIELDS)],
      2: [handoff(TASK_FIELDS)],
      3: [handoff(TASK_FIELDS, { malformed: true })],
      'restart-1': [end()],
    },
  }],
  // 立项登记一个需求、建一个 task，再回一句话
  'tb-selfcheck-create': [{
    role: 'planner',
    kind: 'create',
    deliveries: {
      1: [
        call('request_submit', { title: 'Fix the login page', goal: 'The login page renders again' }),
        call('task_create', { request: '{request}', title: 'Find and fix', assignee: 'executor', read_only: false,
          description: 'Find why the login page is blank and fix it' }),
        together(wait(300), say('Registered request {request}: {lastResult:request_submit}')),
      ],
    },
  }],
  // 结案关闭交来的 task 并关闭需求；第 2 次投递是结案的强制填写，第 3 次是强制关闭
  'tb-selfcheck-close': [{
    role: 'planner',
    kind: 'close',
    deliveries: {
      1: [call('task_handoff', CLOSE_FIELDS), call('request_close', REQUEST_FIELDS),
        say('Request {request} is closed.')],
      2: [handoff(CLOSE_FIELDS)],
      3: [handoff(REQUEST_FIELDS)],
    },
  }],
};

/**
 * 各套件的场景文件所在的目录：每个文件导出 SCENARIOS（名字以 "tb-<套件>-" 开头；记忆规格 §14.1 的协作模式增强
 * 在 mem.mjs，名字以 "mem-" 开头），在这里并入上面的场景表
 */
const SCENARIO_DIR = join(import.meta.dirname, 'scenarios');
const scenarioFiles = existsSync(SCENARIO_DIR)
  ? readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.mjs')).sort() : [];
for (const file of scenarioFiles) {
  const module = await import(pathToFileURL(join(SCENARIO_DIR, file)).href);
  for (const [name, entries] of Object.entries(module.SCENARIOS ?? {})) {
    if (SCENARIOS[name]) throw new Error(`Scenario ${name} in ${file} is already defined`);
    SCENARIOS[name] = entries;
  }
}

// ---------- 认会话与位置 ----------

/** @brief 去掉文字里的工作卡；没有工作卡时原样返回。 */
export function stripWorkCard(text) {
  const start = text.indexOf(WORK_CARD_OPEN);
  if (start < 0) return text;
  const close = text.indexOf(WORK_CARD_CLOSE, start);
  const stop = close < 0 ? text.length : close + WORK_CARD_CLOSE.length;
  return `${text.slice(0, start)}${text.slice(stop)}`.trim();
}

/** @brief 是否只有工作卡的 user 消息。 */
const isCardOnly = (m) => m.role === 'user' && textOf(m).includes(WORK_CARD_OPEN) && stripWorkCard(textOf(m)) === '';

/** @brief 去掉只有工作卡的 user 消息（关键词规则算"最后一条消息"时跳过工作卡）。 */
export function withoutWorkCards(messages) {
  return messages.filter((m) => !isCardOnly(m));
}

/**
 * @brief 是不是收尾检查那一行：去掉首部空白后以 CHECK_LINE_HEAD 开头的 user 消息（不要求相等：换模型的说明可能接在
 *        末尾）；只在中间引用了这句话的消息不算。
 */
export const isCheckLine = (m) => m.role === 'user' && textOf(m).trimStart().startsWith(CHECK_LINE_HEAD);

/** @brief 去掉末尾只有工作卡的 user 消息之后，最后一条是不是检查那一行（这次是检查请求）。 */
function endsWithCheckLine(messages) {
  const last = messages.findLast((m) => !isCardOnly(m));
  return last !== undefined && isCheckLine(last);
}

/** @brief 请求里第一个 tb-scenario 的名字（system、developer、user 消息，按消息顺序）；没有时为 null。 */
export function scenarioOf(messages) {
  for (const m of messages) {
    if (!SYSTEM_ROLES.has(m.role) && m.role !== 'user') continue;
    const match = SCENARIO.exec(textOf(m));
    if (match) return match[1];
  }
  return null;
}

/** @brief system 文字里的会话种类（按 KIND_ORDER 的优先级）。 */
export function kindOf(systemText) {
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(systemText))?.[0] ?? DEFAULT_KIND;
}

/** @brief 投递列表：{ index（在 messages 里的位置）, text（去掉工作卡）, restart }；检查那一行同工作卡，不算投递。 */
function deliveriesOf(messages) {
  const out = [];
  messages.forEach((m, index) => {
    if (m.role !== 'user' || isCheckLine(m)) return;
    const text = stripWorkCard(textOf(m));
    if (text.trim() === '') return;
    out.push({ index, text, restart: text.trimStart().startsWith(RESTART_PREFIX) });
  });
  return out;
}

/** @brief 投递序号 k：最后一次是 restart 时为 "restart-<n>"，否则为不是 restart 的投递数。 */
function positionOf(deliveries) {
  const last = deliveries.at(-1);
  if (!last) return 0;
  if (last.restart) return `restart-${deliveries.filter((d) => d.restart).length}`;
  return deliveries.filter((d) => !d.restart).length;
}

/** @brief 最近的工作卡那一段；没有时为空字符串。 */
function workCardOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i].role === 'user' ? textOf(messages[i]) : '';
    const start = text.indexOf(WORK_CARD_OPEN);
    if (start >= 0) return text.slice(start);
  }
  return '';
}

/**
 * @brief 认出这次请求的会话与步骤位置（§17.1），所有对话请求都算（日志用）。
 * @return { scenario, role, kind, task, k, j, last（最后一次投递的文字或 null）, check（这次是检查请求）,
 *         checks（最后一次投递之后检查那一行的条数）, ctx（模板用的 { messages, task, request }） }
 */
export function sessionOf(messages) {
  const system = messages.filter((m) => SYSTEM_ROLES.has(m.role)).map(textOf).join('\n');
  const card = workCardOf(messages);
  const deliveries = deliveriesOf(messages);
  const last = deliveries.at(-1) ?? null;
  const after = last ? messages.slice(last.index + 1) : messages;
  const task = CARD_TASK.exec(card)?.[1] ?? null;
  const requestNo = REQUEST_NO.exec(card)?.[1] ?? REQUEST_NO.exec(last?.text ?? '')?.[1];
  const ctx = { messages, task: task ?? ANY_TASK.exec(last?.text ?? '')?.[0] ?? null,
    request: requestNo === undefined ? null : Number(requestNo) };
  return {
    scenario: scenarioOf(messages),
    role: ROLE_MARK.exec(system)?.[1] ?? BASE_ROLE,
    kind: kindOf(system),
    task,
    k: positionOf(deliveries),
    j: after.filter((m) => m.role === 'assistant').length,
    last: last?.text ?? null,
    check: endsWithCheckLine(messages),
    checks: after.filter(isCheckLine).length,
    ctx,
  };
}

/** @brief tool_choice 指定的函数名；没有指定函数时为 null。 */
function choiceName(choice) {
  if (!choice || typeof choice !== 'object') return null;
  return choice.function?.name ?? choice.name ?? null;
}

/** @brief 工具定义的名字（OpenAI 形状 { function: { name } } 或 { name }）。 */
export const toolName = (tool) => tool.function?.name ?? tool.name;

/**
 * @brief 每个对话请求日志行另加的字段。
 * @param body 请求体
 * @param info sessionOf 的结果
 * @param calls 回复里调用的工具名
 * @param fc 回答这次请求的 fc 场景名（finish.mjs 的 fcScenarioOf）；没有时为 null，scenario 记 tb-scenario 的名字
 */
export function logFields(body, info, calls, fc = null) {
  const choice = typeof body.tool_choice === 'string' ? body.tool_choice : choiceName(body.tool_choice);
  return { agent: info.role, kind: info.kind, task: info.task, scenario: fc ?? info.scenario, k: info.k, j: info.j,
    tools: (body.tools ?? []).map(toolName), toolChoice: choice, format: body.response_format?.type ?? null, calls,
    check: info.check, checks: info.checks };
}

// ---------- 模板 ----------

/** @brief 最近一次某工具的结果全文；没有时为 null（按 assistant 消息里的调用 id 认出工具名）。 */
function lastResultOf(messages, tool) {
  const names = new Map();
  let found = null;
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) names.set(c.id, c.function?.name);
    if (m.role === 'tool' && names.get(m.tool_call_id) === tool) found = textOf(m);
  }
  return found;
}

/** @brief 一个模板名的值；没有时为 null。 */
function templateValue(name, ctx) {
  if (name === 'task') return ctx.task;
  if (name === 'request') return ctx.request;
  const [kind, tool] = name.split(':');
  const result = lastResultOf(ctx.messages, tool);
  if (kind === 'lastResult') return result;
  const tag = RESULT_TAG.exec(result ?? '');
  return tag ? `#${tag[1]}` : null;
}

/** @brief 把值里的字符串按模板填好（数组、对象逐项）；整个字符串就是 {request} 时换成数字。 */
function fill(value, ctx) {
  if (typeof value === 'string') {
    if (value === '{request}' && ctx.request !== null) return ctx.request;
    return value.replace(TEMPLATE, (_, name) => String(templateValue(name, ctx) ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, ctx)]));
  }
  return value;
}

// ---------- 交接单的三种写法 ----------

/** @brief 这个请求按哪一级输出：{ tier: 'A', tool } | { tier: 'B', schema } | { tier: 'C' }（遵守 -nochoice、-noschema）。 */
function tierOf(body, flags) {
  const name = choiceName(body.tool_choice);
  const tool = name ? (body.tools ?? []).find((t) => toolName(t) === name) : undefined;
  if (tool && !flags.has('nochoice')) return { tier: 'A', tool };
  const format = body.response_format;
  if (format?.type === 'json_schema' && !flags.has('noschema')) return { tier: 'B', schema: format.json_schema ?? {} };
  return { tier: 'C' };
}

/** @brief 标签的表单：强制关闭、结案或 task 实例（规则见文件开头）。 */
function formOf(body, info) {
  const props = body.response_format?.json_schema?.schema?.properties ?? {};
  const closing = choiceName(body.tool_choice) === 'request_close' || ('request' in props && !('task' in props))
    || (info.last ?? '').includes(CLOSE_REQUEST_TAGS);
  if (closing) return 'request_close';
  return info.kind === 'close' ? 'close' : 'task';
}

/** @brief 严格 schema 的输出：schema 里有而 fields 里没有的字段填 null；不是 strict 时原样返回。 */
function strictFill(fields, schema, strict) {
  if (strict !== true) return fields;
  const out = {};
  for (const key of Object.keys(schema?.properties ?? {})) out[key] = key in fields ? fields[key] : null;
  return { ...out, ...fields };
}

/** @brief 在 outcome 的值之前截断的 JSON。 */
function truncatedJson(fields) {
  const { outcome: _outcome, ...rest } = fields;
  const head = JSON.stringify(rest).slice(0, -1);
  return `${head}${head.length > 1 ? ',' : ''}"outcome":`;
}

/** @brief C 级标签；malformed 时在 outcome 的值之前截断。 */
function tagText(fields, form, malformed) {
  const names = TAG_FIELDS[form];
  const tags = names.map((name) => {
    const value = fields[name];
    return `<${name}>${Array.isArray(value) ? value.join('\n') : value ?? ''}</${name}>`;
  });
  if (!malformed) return tags.join('');
  return `${tags.slice(0, names.indexOf('outcome')).join('')}<outcome>`;
}

/**
 * @brief 交接单按请求的形状输出。
 * @param item { fields（已填好模板）, malformed }
 * @return { call: { name, args, argsText? } } 或 { text }
 */
function handoffOutput(item, body, flags, info) {
  const { fields, malformed } = item;
  const shape = tierOf(body, flags);
  if (shape.tier === 'A') {
    const fn = shape.tool.function ?? shape.tool;
    if (malformed) return { call: { name: toolName(shape.tool), args: {}, argsText: truncatedJson(fields) } };
    return { call: { name: toolName(shape.tool), args: strictFill(fields, fn.parameters, fn.strict) } };
  }
  if (shape.tier === 'B') {
    const json = malformed ? truncatedJson(fields) : JSON.stringify(strictFill(fields, shape.schema.schema,
      shape.schema.strict));
    return { text: json };
  }
  return { text: tagText(fields, formOf(body, info), malformed) };
}

// ---------- 回复 ----------

/** @brief 这个会话、这次投递的步骤列表；没有时为 null。 */
function stepsOf(info) {
  const entries = SCENARIOS[info.scenario] ?? [];
  const entry = entries.find((e) => e.role === info.role && e.kind === info.kind && (!e.task || e.task === info.task)
    && (!e.match || (info.last ?? '').includes(e.match)));
  return entry?.deliveries[info.k] ?? null;
}

/** @brief 第 j 个回复步骤，带上它前面单独一项的修饰；没有时为 null（finish.mjs 的 fc 场景同样按它取步骤）。 */
export function stepAt(steps, j) {
  let pending = together();
  let index = 0;
  for (const s of steps) {
    if (s.items.length === 0) {
      pending = together(pending, s);
      continue;
    }
    if (index === j) return together(pending, s);
    index += 1;
    pending = together();
  }
  return index === j && (pending.waitMs > 0 || pending.fails.length > 0) ? pending : null;
}

/** @brief 一个回复步骤的文字与调用。 */
function renderStep(s, body, flags, info) {
  const texts = [];
  const thoughts = [];
  const toolCalls = [];
  for (const item of s.items) {
    if (item.say !== undefined) texts.push(fill(item.say, info.ctx));
    else if (item.think !== undefined) thoughts.push(fill(item.think, info.ctx));
    else if (item.call) toolCalls.push({ name: item.call.name, args: fill(item.call.args, info.ctx) });
    else {
      const out = handoffOutput({ ...item.handoff, fields: fill(item.handoff.fields, info.ctx) }, body, flags, info);
      if (out.call) toolCalls.push(out.call);
      else texts.push(out.text);
    }
  }
  return { text: texts.join('\n'), toolCalls, ...(thoughts.length ? { thinking: thoughts.join('\n') } : {}) };
}

/**
 * @brief 一个回复步骤的回复（脚本模式与 finish.mjs 的 fc 场景共用）：fail 修饰对这个模型生效时为错误，错误体为
 *        "Synthetic HTTP <状态码> from script <where.scenario>"；没有步骤或回复为空时回 NO_STEP_TEXT，并在 stderr 记一行
 *        "no script step"。
 * @param s 回复步骤（stepAt 的结果）；没有时为 null
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @param info sessionOf 的结果（模板与交接单用）
 * @param where 报告用的位置 { scenario, … }
 * @return { failure: { status, body, headers } } 或 { reply: { text, toolCalls, thinking?, delayMs } }
 */
export function stepReply(s, body, flags, info, where) {
  const failure = s?.fails.find((f) => f.model === null || f.model === body.model);
  if (failure) {
    const message = `Synthetic HTTP ${failure.status} from script ${where.scenario}`;
    const headers = failure.retryAfter == null ? undefined : { 'Retry-After': String(failure.retryAfter) };
    return { failure: { status: failure.status, body: { error: { message, type: 'synthetic_error' } }, headers } };
  }
  const reply = s ? renderStep(s, body, flags, info) : { text: '', toolCalls: [] };
  if (reply.text === '' && reply.toolCalls.length === 0) {
    console.error(`[fake-endpoint] no script step for ${JSON.stringify(where)}`);
    reply.text = NO_STEP_TEXT;
  }
  return { reply: { ...reply, delayMs: s?.waitMs ?? 0 } };
}

/**
 * @brief 脚本模式的回复。
 * @param body 请求体
 * @param flags 模型 id 的后缀集合
 * @param info sessionOf 的结果（scenario 不为 null）
 * @return { failure: { status, body } } 或 { reply: { text, toolCalls, delayMs } }
 */
export function scriptReply(body, flags, info) {
  const steps = stepsOf(info);
  const where = { scenario: info.scenario, agent: info.role, kind: info.kind, task: info.task, k: info.k, j: info.j };
  return stepReply(steps ? stepAt(steps, info.j) : null, body, flags, info, where);
}
