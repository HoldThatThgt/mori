// 强制填写交接单（docs/specs/parallel-agents-taskboard.md §7.5、§7.6 强制关闭、§12.7、§14.4）：
// 三种表单（task 实例的交接、结案的交接、强制关闭需求）的 schema 与严格版本，按这次请求实际用的模型的写入等级
// 改写一次尝试的选项（A 指定调用、B 结构化输出、C 不改），C 级的标签说明，以及 B、C 回复的解析。
// 纯函数：请求体的改写在 forcedWrite.ts，套用在 modelSession.ts 的流函数包装里；表单的去向、重试与兜底由调用方
// （team.ts）按 §7.4、§7.5 处理。

import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ApiType, ProfileView } from '../shared/models';
import { TEXT_LIMITS, normalizeRequestNo, normalizeTaskId } from '../shared/team';
import type { HandoffOutcome, Seat } from '../shared/team';
import { forcedToolChoice, tagContent, withJsonSchema, withStrictTools } from './forcedWrite';
import type { PayloadChange } from './forcedWrite';

/** @brief JSON schema（只用到 type、properties、required、items、enum、description、additionalProperties）。 */
export type JsonSchema = Record<string, unknown>;

/** @brief task 实例交接的 outcome（§6.3），按 schema 与 C 级标签的顺序。 */
export const TASK_OUTCOMES: readonly HandoffOutcome[] = [
  'continue', 'dead_end', 'blocked', 'need_user', 'done', 'pass', 'fail',
];

/** @brief 结案会话交接的 outcome（§6.3）：continue 要写 next（改派），need_user 交给立项。 */
export const CLOSE_OUTCOMES: readonly HandoffOutcome[] = ['close_done', 'close_failed', 'continue', 'need_user'];

/** @brief request_close 的 outcome（§6.3）。 */
export const REQUEST_CLOSE_OUTCOMES: readonly string[] = ['done', 'failed'];

/** @brief next 的一个可选角色（§6.3：全部角色名含 mori，去掉这个会话自己）。 */
export interface NextRole {
  /** 角色名（next 枚举的值） */
  name: string;
  /** 角色说明（frontmatter 的 description；基座由调用方给出） */
  description: string;
  /** 它持有的权限；非空时在说明里加注，例如 planner (create, close) */
  seats: readonly Seat[];
}

/** @brief 表单的种类：task 实例的交接、结案会话的交接、强制关闭需求（§7.5）。 */
export type FormKind = 'task' | 'close' | 'request_close';

/** @brief 一次强制填写要填的表单。 */
export interface HandoffForm {
  /** 种类 */
  kind: FormKind;
  /** 对应的工具：task_handoff；强制关闭为 request_close */
  tool: 'task_handoff' | 'request_close';
  /** 要交接的 task（task 实例的 task、结案要决定的 task）；强制关闭为 null */
  task: string | null;
  /** 强制关闭的需求编号；其余为 null */
  request: number | null;
  /** 这个会话可以写的 next；强制关闭、只有基座一个角色时为空 */
  next: readonly NextRole[];
  /** outcome 的取值 */
  outcomes: readonly string[];
  /** 严格版本的参数 schema：A 换给这个工具，B 作为 json_schema */
  schema: JsonSchema;
}

/** @brief 写法：A 指定调用、B 结构化输出、C 标签（统一模型提供商规格 §7.5）。 */
export type WriteMode = 'A' | 'B' | 'C';

/**
 * @brief 一次尝试的请求改写（§7.5 第 2 步、§14.4），字段与 modelSession.ts 的 RequestShape 相同，可以直接作为
 *        ModelSessionOptions.shape 的结果：流函数包装把 toolChoice 写进选项、thinkingOff 时不传 reasoning、
 *        payload 接在 pi 原来的 onPayload 之后（先调原来的）。
 */
export interface FormShape {
  /** 这次实际用的写法（A 不能关思考时已退到 B 或 C） */
  mode: WriteMode;
  /** A：指定调用表单的工具（forcedToolChoice 的结果）；B、C 没有 */
  toolChoice?: SimpleStreamOptions['toolChoice'];
  /** A：只给表单的工具换严格 schema 并加 strict；B：加 json_schema；C 没有（请求不改） */
  payload?: PayloadChange;
  /** A：这次请求关闭思考 */
  thinkingOff?: boolean;
}

/** @brief B、C 回复的解析结果：工具参数（键名同 schema，没填的不出现），或不能用的原因（重试投递里用）。 */
export type FormResult = { args: Record<string, unknown> } | { error: string };

// ---- schema ----

/**
 * @brief next 的说明（§6.3）：每项写成 <name>: <description>，持有权限的加注，例如 planner (create, close): …。
 * @param next 可选的角色
 */
export function nextDescription(next: readonly NextRole[]): string {
  return next.map((role) => {
    const label = role.seats.length ? `${role.name} (${role.seats.join(', ')})` : role.name;
    return `${label}: ${role.description}`;
  }).join('; ');
}

/** @brief next 属性；没有可选的角色时为 null（只有基座一个角色时 task 实例没有 next，§6.3）。 */
function nextProperty(next: readonly NextRole[], lead: string): JsonSchema | null {
  if (next.length === 0) return null;
  return { type: 'string', enum: next.map((role) => role.name), description: `${lead} ${nextDescription(next)}` };
}

/** @brief conclusion 属性（§7.2）。 */
function conclusionProperty(max: number, extra: string): JsonSchema {
  return { type: 'string', description: `A few sentences, at most ${max} characters.${extra}` };
}

/**
 * @brief task 实例的 task_handoff 参数 schema（§6.3 的顺序：task?、conclusion、outcome、next?、open_items?、evidence?）。
 * @param next 这个会话可以写的 next；为空时没有 next
 */
export function taskHandoffSchema(next: readonly NextRole[]): JsonSchema {
  const nextProp = nextProperty(next, 'The role that should continue.');
  return {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task you hand off, e.g. T1; defaults to your task.' },
      conclusion: conclusionProperty(TEXT_LIMITS.handoffConclusion, ' For need_user, the question for the user.'),
      outcome: { type: 'string', enum: [...TASK_OUTCOMES] },
      ...(nextProp ? { next: nextProp } : {}),
      open_items: { type: 'array', items: { type: 'string' },
        description: `Open items, at most ${TEXT_LIMITS.openItems}.` },
      evidence: { type: 'array', items: { type: 'string' },
        description: 'Numbers of the tool results that back your conclusion, e.g. #3.' },
    },
    required: ['conclusion', 'outcome'],
  };
}

/**
 * @brief 结案会话的 task_handoff 参数 schema（§6.3：task、conclusion、outcome、next?；没有证据与未结事项）。
 * @param next 这个会话可以写的 next（改派的角色）；为空时没有 next
 */
export function closeHandoffSchema(next: readonly NextRole[]): JsonSchema {
  const nextProp = nextProperty(next, 'With continue: the role to reassign to.');
  return {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task you decide, e.g. T1.' },
      conclusion: conclusionProperty(TEXT_LIMITS.handoffConclusion, ''),
      outcome: { type: 'string', enum: [...CLOSE_OUTCOMES] },
      ...(nextProp ? { next: nextProp } : {}),
    },
    required: ['task', 'conclusion', 'outcome'],
  };
}

/** @brief request_close 的参数 schema（§6.3：request、outcome、conclusion）。 */
export function requestCloseSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      request: { type: 'integer', description: 'The request number.' },
      outcome: { type: 'string', enum: [...REQUEST_CLOSE_OUTCOMES] },
      conclusion: conclusionProperty(TEXT_LIMITS.requestConclusion, ''),
    },
    required: ['request', 'outcome', 'conclusion'],
  };
}

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief schema 的 type 是否含有 name。 */
function hasType(schema: JsonSchema, name: string): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(name) : schema.type === name;
}

/** @brief 可选字段的严格写法：类型加 null（有 enum 时 enum 也加 null）；没有 type 时用 anyOf。 */
function nullable(schema: JsonSchema): JsonSchema {
  if (schema.type === undefined) return { anyOf: [schema, { type: 'null' }] };
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const out: JsonSchema = { ...schema, type: types.includes('null') ? types : [...types, 'null'] };
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
  return out;
}

/**
 * @brief 严格版本的 schema（§7.5）：对象的全部字段都列在 required 里，原来可选的字段类型加 null（null 视为没填），
 *        additionalProperties: false；嵌套的对象（属性里、数组元素里）同样处理。
 * @param schema 原来的 schema
 * @return 新的 schema（不改入参）
 */
export function strictSchema(schema: JsonSchema): JsonSchema {
  if (hasType(schema, 'object') && isRecord(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
      const strict = strictSchema(value as JsonSchema);
      return [key, required.has(key) ? strict : nullable(strict)];
    }));
    return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (hasType(schema, 'array') && isRecord(schema.items)) {
    return { ...schema, items: strictSchema(schema.items) };
  }
  return { ...schema };
}

/** @brief 把对象 schema 的一个属性换成只有一个值的枚举（结案的 task、强制关闭的 request，§7.5）。 */
function fixProperty(schema: JsonSchema, key: string, value: string | number): JsonSchema {
  const properties = schema.properties as Record<string, JsonSchema>;
  return { ...schema, properties: { ...properties, [key]: { ...properties[key], enum: [value] } } };
}

// ---- 三种表单 ----

/**
 * @brief task 实例的强制填写（§7.4 no_handoff）：交接单的严格版本，next 为这个会话的枚举。
 * @param task 这个实例的 task，例如 T1
 * @param next 这个会话可以写的 next
 */
export function taskForm(task: string, next: readonly NextRole[]): HandoffForm {
  return { kind: 'task', tool: 'task_handoff', task, request: null, next, outcomes: TASK_OUTCOMES,
    schema: strictSchema(taskHandoffSchema(next)) };
}

/**
 * @brief 结案会话对一个 task 的强制填写（§7.4 close_undecided）：task 换成只有这个 task 的枚举。
 * @param task 交给它而它没有处理的 task
 * @param next 结案会话可以写的 next（改派的角色）
 */
export function closeForm(task: string, next: readonly NextRole[]): HandoffForm {
  return { kind: 'close', tool: 'task_handoff', task, request: null, next, outcomes: CLOSE_OUTCOMES,
    schema: strictSchema(fixProperty(closeHandoffSchema(next), 'task', task)) };
}

/**
 * @brief 强制关闭需求（§7.5 第 4 步、§7.6）：request_close 的严格版本，request 换成只有这个需求的枚举。
 * @param request 需求编号
 */
export function requestCloseForm(request: number): HandoffForm {
  return { kind: 'request_close', tool: 'request_close', task: null, request, next: [],
    outcomes: REQUEST_CLOSE_OUTCOMES, schema: strictSchema(fixProperty(requestCloseSchema(), 'request', request)) };
}

// ---- 按写入等级改写请求 ----

/**
 * @brief 这次请求的写法（§7.5 第 2 步的表）：A 只在档案 reasoning.can_disable 为真时用，否则档案里 B 的检查
 *        通过时按 B、不然按 C；B、C 照用；没有等级（protocol_write 未验证）为 null，不强制填写。
 * @param tier 这次请求的模型档案的写入等级与各级结果；没有档案时为 null
 * @param canDisable 档案的 reasoning.can_disable
 */
export function writeModeOf(tier: ProfileView['tier'] | null, canDisable: boolean | 'unknown'): WriteMode | null {
  const level = tier?.level ?? null;
  if (tier === null || level === null) return null;
  if (level !== 'A' || canDisable === true) return level;
  return tier.b.outcome === 'pass' ? 'B' : 'C';
}

/**
 * @brief 一次尝试的改写（§7.5 第 2 步、§12.7）：按这次请求实际用的模型的档案取写法，所以换了模型就按新模型的等级。
 *        A 指定调用表单的工具、只给它换严格 schema 并加 strict、关闭思考（pi 不传 reasoning 即思考 off）；
 *        B 加 response_format json_schema（严格版本的表单），tools 与思考不动；C 请求不改。
 *        调用方只把它套用在强制运行的第一个请求上（这个请求换模型重发的各次尝试照样套用）。
 * @param form 要填的表单
 * @param tier 这次请求的模型档案的写入等级与各级结果；没有档案时为 null
 * @param canDisable 档案的 reasoning.can_disable
 * @param api 这次请求的接口类型
 * @return 改写；没有等级时为 null（不强制填写，按 §7.4 兜底）
 */
export function shapeFor(form: HandoffForm, tier: ProfileView['tier'] | null, canDisable: boolean | 'unknown',
  api: ApiType): FormShape | null {
  const mode = writeModeOf(tier, canDisable);
  if (mode === null) return null;
  if (mode === 'C') return { mode };
  if (mode === 'B') return { mode, payload: (payload) => withJsonSchema(api, payload, form.tool, form.schema) };
  return {
    mode,
    toolChoice: forcedToolChoice(api, form.tool) as SimpleStreamOptions['toolChoice'],
    payload: (payload) => withStrictTools(api, payload, form.tool, form.schema),
    thinkingOff: true,
  };
}

// ---- 投递里写明怎么填 ----

/** @brief C 级的标签格式（§7.5）：没有可选的 next 时不列 next。 */
function tagFormat(form: HandoffForm): string {
  const outcome = `<outcome>${form.outcomes.join('|')}</outcome>`;
  const next = form.next.length ? '<next>…</next>' : '';
  if (form.kind === 'request_close') return `${outcome}<conclusion>…</conclusion>`;
  if (form.kind === 'close') return `<conclusion>…</conclusion>${outcome}${next}`;
  return `<conclusion>…</conclusion>${outcome}${next}<open_items>…</open_items><evidence>…</evidence>`;
}

/** @brief C 级标签之后的说明：列表每行一项、next 只在 continue 时填，以及这个会话可以写的 next。 */
function tagNotes(form: HandoffForm): string[] {
  const notes: string[] = [];
  if (form.kind === 'task') notes.push('open_items and evidence take one item per line and can be empty.');
  if (form.next.length === 0) return notes;
  const roles = nextDescription(form.next);
  notes.push(form.kind === 'close' ? `Fill next only for continue; it is one of: ${roles}.`
    : `next is one of: ${roles}. Leave it empty if no one should continue.`);
  return notes;
}

/**
 * @brief 强制填写的投递里“这一次要怎么填”的一段（§7.5 第 1 步），由投递文字（boardText）接在固定的句子之后；
 *        格式重试（第 3 步）用同样的写法，再附一次。C 级写明标签格式、可选的值和这个会话可以写的 next。
 * @param form 要填的表单
 * @param mode 这次的写法（shapeFor 的 mode）
 */
export function formatHint(form: HandoffForm, mode: WriteMode): string {
  const target = form.kind === 'request_close' ? `for request ${form.request}` : `for ${form.task}`;
  if (mode === 'A') return `Call ${form.tool} ${target} now.`;
  if (mode === 'B') {
    return `Reply with only a JSON object with the fields of ${form.tool} ${target}; use null for a field you leave `
      + 'empty.';
  }
  return [`Reply with exactly these tags: ${tagFormat(form)}`, ...tagNotes(form)].join('\n');
}

// ---- 解析 B、C 的回复 ----

/** @brief 字段长度（按字符计，同 TEXT_LIMITS）。 */
function charCount(text: string): number {
  return [...text].length;
}

/** @brief 必填的结论：字符串、去掉首尾空白后 1–max 字符。 */
function checkConclusion(value: unknown, max: number): string | { error: string } {
  if (value === undefined || value === null) return { error: 'conclusion is required' };
  if (typeof value !== 'string') return { error: 'conclusion must be a string' };
  const text = value.trim();
  if (text === '') return { error: 'conclusion is empty' };
  return charCount(text) > max ? { error: `conclusion is longer than ${max} characters` } : text;
}

/** @brief 枚举字段：去掉首尾空白后必须在取值内（不做同义词映射，§6.2）；没填为 null。 */
function checkChoice(name: string, value: unknown, values: readonly string[]): string | null | { error: string } {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return null;
  if (typeof text === 'string' && values.includes(text)) return text;
  const allowed = values.length ? values.join(', ') : 'none';
  return { error: `${name} ${JSON.stringify(value)} is not one of: ${allowed}` };
}

/** @brief 列表字段：字符串（证据也可以是整数）的列表，去掉空项；没填或为空为 null。 */
function checkList(name: string, value: unknown, numbers: boolean): string[] | null | { error: string } {
  if (value === undefined || value === null) return null;
  const ok = Array.isArray(value) && value.every((item) => typeof item === 'string'
    || (numbers && Number.isInteger(item)));
  if (!ok) return { error: `${name} must be a list of ${numbers ? 'tool result numbers' : 'strings'}` };
  const items = (value as unknown[]).map((item) => String(item).trim()).filter((item) => item !== '');
  return items.length ? items : null;
}

/** @brief 未结事项：≤ 10 条，每条 ≤ 200 字符（§7.2）。 */
function checkOpenItems(value: unknown): string[] | null | { error: string } {
  const items = checkList('open_items', value, false);
  if (items === null || !Array.isArray(items)) return items;
  if (items.length > TEXT_LIMITS.openItems) return { error: `open_items has more than ${TEXT_LIMITS.openItems} items` };
  const long = items.find((item) => charCount(item) > TEXT_LIMITS.openItem);
  return long === undefined ? items : { error: `an open item is longer than ${TEXT_LIMITS.openItem} characters` };
}

/** @brief 结案与强制关闭只能写这个 task 或需求（严格 schema 里是只有一个值的枚举）。 */
function checkFixed(form: HandoffForm, data: Record<string, unknown>): { error: string } | null {
  if (form.kind === 'close' && data.task !== undefined && data.task !== null
    && normalizeTaskId(data.task) !== form.task) {
    return { error: `task must be ${form.task}` };
  }
  if (form.kind === 'request_close' && data.request !== undefined && data.request !== null
    && normalizeRequestNo(data.request) !== form.request) {
    return { error: `request must be ${form.request}` };
  }
  return null;
}

/** @brief 已检查的字段写进参数；遇到错误返回它。 */
function collect(args: Record<string, unknown>, checks: [string, unknown][]): { error: string } | null {
  for (const [name, value] of checks) {
    if (isRecord(value) && typeof value.error === 'string') return { error: value.error };
    if (value !== null && value !== undefined) args[name] = value;
  }
  return null;
}

/**
 * @brief 按表单检查 B、C 读出的字段（§7.2、§6.3 的取值与长度；null 视为没填），得到工具参数。
 *        task 与 request 没写时用表单的；交接的其他规则（证据、持有者、continue 要 next 等）由工具执行时检查。
 * @param form 要填的表单
 * @param data 读出的字段（键名同 schema）
 */
export function checkForm(form: HandoffForm, data: Record<string, unknown>): FormResult {
  const fixed = checkFixed(form, data);
  if (fixed) return fixed;
  const limit = form.kind === 'request_close' ? TEXT_LIMITS.requestConclusion : TEXT_LIMITS.handoffConclusion;
  const outcome = checkChoice('outcome', data.outcome, form.outcomes);
  const checks: [string, unknown][] = [
    form.kind === 'request_close' ? ['request', form.request] : ['task', checkTask(form, data.task)],
    ['conclusion', checkConclusion(data.conclusion, limit)],
    ['outcome', outcome === null ? { error: 'outcome is required' } : outcome],
  ];
  if (form.kind !== 'request_close') {
    checks.push(['next', checkChoice('next', data.next, form.next.map((role) => role.name))]);
  }
  if (form.kind === 'task') {
    checks.push(['open_items', checkOpenItems(data.open_items)]);
    checks.push(['evidence', checkList('evidence', data.evidence, true)]);
  }
  const args: Record<string, unknown> = {};
  return collect(args, checks) ?? { args };
}

/**
 * @brief task：task 实例写了就按 §6.2 归一后照用（T3、t3、3 都认；是否持有由工具检查），没写用表单的；结案总是表单的。
 */
function checkTask(form: HandoffForm, value: unknown): string | null | { error: string } {
  if (form.kind === 'close' || value === undefined || value === null) return form.task;
  const id = normalizeTaskId(value) ?? (typeof value === 'string' ? value.trim() : '');
  return id !== '' ? id : { error: 'task must be a task id like T1' };
}

/** @brief 标签里按 separator 分开的列表，去掉空项；空标签为 null。 */
function tagItems(text: string, name: string, separator: RegExp): string[] | null {
  const content = tagContent(text, name);
  if (content === null) return null;
  const items = content.split(separator).map((item) => item.trim()).filter((item) => item !== '');
  return items.length ? items : null;
}

/** @brief 未结事项：每行一项（§7.5）。 */
const LINE_SEPARATOR = /\r?\n/;
/**
 * @brief 证据的编号之间可以用任何分隔符（换行、逗号、顿号、空格等，§7.5，2026-10-26 M13）：字母、数字、_、#、[、] 之外的
 *        字符都算分隔；分出来不是编号的词照 §7.3 算不合格。
 */
const EVIDENCE_SEPARATOR = /[^A-Za-z0-9_#[\]]+/;

/** @brief C 级回复读出的字段（§7.5 的标签；没有的标签不出现）。 */
function tagFields(form: HandoffForm, text: string): Record<string, unknown> {
  const data: Record<string, unknown> = { conclusion: tagContent(text, 'conclusion'),
    outcome: tagContent(text, 'outcome') };
  if (form.kind !== 'request_close') data.next = tagContent(text, 'next');
  if (form.kind === 'task') {
    data.open_items = tagItems(text, 'open_items', LINE_SEPARATOR);
    data.evidence = tagItems(text, 'evidence', EVIDENCE_SEPARATOR);
  }
  return data;
}

/** @brief B 级回复正文的 JSON 对象。 */
function jsonFields(text: string): { data: Record<string, unknown> } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return { error: 'the reply is not valid JSON' };
  }
  return isRecord(data) ? { data } : { error: 'the reply is not a JSON object' };
}

/**
 * @brief 解析强制填写的回复（§7.5 第 2 步的表）：B 解析正文的 JSON，C 解析标签；再按 checkForm 检查。
 *        A 级是模型调用工具，由 pi 照常执行，不经这里。
 * @param form 要填的表单
 * @param mode 这次的写法（B 或 C）
 * @param text 助手回复的正文
 * @return 工具参数，或不能用的原因（§7.5 第 3 步的重试投递写 Your handoff could not be used: <原因>.）
 */
export function parseForm(form: HandoffForm, mode: 'B' | 'C', text: string): FormResult {
  if (mode === 'C') return checkForm(form, tagFields(form, text));
  const parsed = jsonFields(text);
  return 'error' in parsed ? parsed : checkForm(form, parsed.data);
}
