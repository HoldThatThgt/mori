// memory 工具（docs/specs/memory.md §7）：一个会话一个定义，两种调用方各一份说明与 JSON Schema（附录 A.2、A.3），
// prepareArguments 做与 TaskBoard 工具相同的键名归一（boardTools.ts）。执行时先查项目目录（§3）与字段（§7.4），
// 再在调用方能改的范围里匹配条目（memoryRules.ts），补全依据（§7.3：agent 记下用户会话的位置与原话；增强任务的依据
// 按这次运行的范围核对），最后交给记忆模块写入（memory.ts）。结果是一行英文，details 给界面（MemoryToolDetails）；
// 写法或规则的错误加第二行 Correct form（附录 A.4，同 TaskBoard 工具的 errorText）。

import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  KIND_LABEL, LAYER_PROSE, MEMORY_DEFAULTS, MEMORY_KINDS, MEMORY_LAYERS, localDate,
  type MemoryCaller, type MemoryKind, type MemoryLayer, type MemoryToolDetails, type MemoryWriteResult,
  type StoredEvidence,
} from '../shared/memory';
import { argOf } from '../shared/team';
import type { JsonSchema } from './handoffForm';
import { ENTRY_GONE, candidates, forget, projectDir, save, update, type MemoryActor, type RunHandle } from './memory';
import {
  USER_RULES_REFUSAL, matchEntry, matchScope, toolFieldError, writeRefusal, type Candidate,
} from './memoryRules';
import { correctForm, toolDescription } from './memoryText';
import { loadPi } from './pi';
import { MEMORY_TOOL } from './teamHost';

/** @brief agent 调用方记下的位置（§7.3）：用户会话的文件、说这句话的那条你的消息、写入时侧栏的会话名。 */
export interface MemoryPosition {
  /** 用户会话文件的绝对路径（pi getSessionFile() 原样）；没有时为 null */
  session: string | null;
  /** 用户会话当前分支上最后一条 role: user 的消息条目 id；分开时的立项实例为 null */
  entry: string | null;
  /** 写入时侧栏的会话名（§12 的会话名规则） */
  title: string;
}

/** @brief 一次增强运行的依据范围（§9.7）：第一条消息列出的会话、实例会话与反馈。 */
export interface EvidenceScope {
  /** 列出的会话：文件的绝对路径与存下的会话名（第一条消息列出的名字） */
  sessions: readonly { file: string; title: string }[];
  /**
   * 列出的 TaskBoard 目录 sessions/ 下的实例会话：目录列举得到的绝对路径与存下的会话名
   * （已拼好的 `<会话名> · <实例文件名>`，§7.3）
   */
  instanceFiles: readonly { file: string; title: string }[];
  /** 列出的反馈：文件名（不含目录）与它的 createdAt（ISO） */
  feedback: readonly { name: string; createdAt: string }[];
}

/** @brief 一个会话的 memory 工具的上下文（会话建立时定下，§7.6）。 */
export interface MemoryToolContext {
  /** 会话的工作目录 */
  cwd: string;
  /** 调用方 */
  caller: MemoryCaller;
  /** 增强运行（写入并进这次运行的修订，§9.8）；普通会话为 null */
  run: RunHandle | null;
  /**
   * @brief agent 调用方：工具执行时的位置（用户会话文件与它当前分支上最后一条 role: user 的条目 id，§7.3）；
   *        用户会话已不在时抛错（按写入失败报告）。
   */
  position: () => MemoryPosition;
  /** enhance 调用方：这次运行的依据范围（§9.7）；agent 调用方为 null */
  scope: EvidenceScope | null;
}

/** @brief 一次调用的结果：成功的一行与 details，或拒绝的原因（usage 为真时加 Correct form）。 */
type Reply =
  | { ok: true; text: string; details: MemoryToolDetails }
  | { ok: false; reason: string; usage: boolean };

/** @brief 归一、校验后的参数。 */
type Args = Record<string, unknown>;

/** @brief 增强任务的一项依据（模型给的，键名已归一；schema 保证是会话依据或反馈依据两种写法之一）。 */
interface RawEvidence {
  /** 会话文件（模型给的写法，按列出的路径核对） */
  session?: string;
  /** 那个会话文件里某一行的 id */
  entry?: string;
  /** 反馈文件名（不含目录） */
  feedback?: string;
  /** 原话（可选，原样保存） */
  quote?: string;
}

/** 三个动作（§7.1） */
const ACTIONS = ['save', 'update', 'forget'] as const;
/** 依据一项的键（§7.1） */
const EVIDENCE_KEYS = ['session', 'entry', 'feedback', 'quote'] as const;
/** 记忆模块返回的、原样交给模型的原因（§7.4：预算、项目目录被占用；运行已经结束） */
const PLAIN_ERRORS: readonly RegExp[] = [/^Over the \d+-token limit /, /^This project’s memory folder belongs to /,
  /^This enhancement run has already ended\.$/];
/** 匹配之后条目又被改了、记忆模块的 writeRefusal 拒绝时的原因（§7.4 的规则错误，带 Correct form） */
const RULE_ERRORS: readonly RegExp[] = [/^“.*” is an entry the user wrote; /, /^This run maintains this project’s /];

// ---- schema 与参数归一（§7.1） ----

/** @brief 字符串属性。 */
function str(): JsonSchema {
  return { type: 'string' };
}

/** @brief 枚举属性。 */
function oneOf(values: readonly string[]): JsonSchema {
  return { type: 'string', enum: [...values] };
}

/** @brief agent 调用方的参数（§7.1 第一张表）：只要求 action，其余必填字段与长度在执行时查。 */
function agentSchema(): JsonSchema {
  return { type: 'object', properties: { action: oneOf(ACTIONS), kind: oneOf(MEMORY_KINDS),
    layer: oneOf(MEMORY_LAYERS), entry: str(), abstract: str(), detail: str(), note: str(), quote: str() },
  required: ['action'] };
}

/**
 * @brief enhance 调用方的参数（§7.1）：没有 kind 与 layer；evidence 必填，1–10 项，每项 `{ session, entry, quote? }`
 *        或 `{ feedback, quote? }`（缺失、空数组、超过 10 项、写法不对都由 pi 的校验拒绝）。
 */
function enhanceSchema(): JsonSchema {
  const item = { anyOf: [
    { type: 'object', properties: { session: str(), entry: str(), quote: str() }, required: ['session', 'entry'] },
    { type: 'object', properties: { feedback: str(), quote: str() }, required: ['feedback'] },
  ] };
  return { type: 'object', properties: { action: oneOf(ACTIONS), entry: str(), abstract: str(), detail: str(),
    note: str(), evidence: { type: 'array', items: item, minItems: 1, maxItems: MEMORY_DEFAULTS.evidenceMax } },
  required: ['action', 'evidence'] };
}

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 按名字取出参数（键名不分大小写、不看 _ 与 -，同 TaskBoard 工具）；值为 null 的视为没写，别的键丢掉。 */
function pickArgs(raw: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = argOf(raw, name);
    if (value !== undefined && value !== null) out[name] = value;
  }
  return out;
}

/**
 * @brief prepareArguments（pi 在校验之前调用）：与 boardTools.ts 的 prepareToolArgs 同样的键名归一，
 *        evidence 的每一项也按它的四个键归一。
 * @param schema 这个调用方的参数 schema
 * @param raw 模型给的原始参数
 * @return 归一后的参数；原始参数不是对象时原样返回（由 pi 报错）
 */
function prepareArgs(schema: JsonSchema, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out = pickArgs(raw, Object.keys(schema.properties as Record<string, unknown>));
  if (Array.isArray(out.evidence)) {
    out.evidence = out.evidence.map((item: unknown) => (isRecord(item) ? pickArgs(item, EVIDENCE_KEYS) : item));
  }
  return out;
}

// ---- 结果（§7.4） ----

/** @brief 拒绝。 */
function refuse(reason: string, usage: boolean): Reply {
  return { ok: false, reason, usage };
}

/**
 * @brief 记忆模块写入失败时给模型的原因：规则错误带 Correct form，预算、项目目录、条目已不在、运行已结束原样，
 *        其余是写文件失败：`Couldn’t save the memory: <原文>`（§7.4）。
 */
function writeFailure(error: string): Reply {
  if (error === USER_RULES_REFUSAL || RULE_ERRORS.some((rule) => rule.test(error))) return refuse(error, true);
  if (error === ENTRY_GONE || PLAIN_ERRORS.some((rule) => rule.test(error))) return refuse(error, false);
  return refuse(`Couldn’t save the memory: ${error}`, false);
}

/** @brief 成功的一行与给界面的 details。 */
function done(text: string, result: MemoryWriteResult, place: Omit<MemoryToolDetails, 'revision'>): Reply {
  return { ok: true, text, details: { revision: result.revision ?? '', ...place } };
}

/** @brief `<KIND> (<this project|user level>)`（§7.4）。 */
function placeText(kind: MemoryKind, layer: MemoryLayer): string {
  return `${KIND_LABEL[kind]} (${LAYER_PROSE[layer]})`;
}

/** @brief 写入的一方：对话里的 memory 工具为 Mori，增强任务为 Enhancement（§3.2）。 */
function actorOf(ctx: MemoryToolContext): MemoryActor {
  return { by: ctx.caller.kind === 'agent' ? 'Mori' : 'Enhancement', caller: ctx.caller, run: ctx.run };
}

/** @brief 可选的文字参数。 */
function textArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---- 依据（§7.3） ----

/** @brief 路径按 `/`、`\` 与大小写不敏感比较（§7.3）。 */
function samePath(a: string, b: string): boolean {
  const form = (path: string) => path.replaceAll('\\', '/').toLowerCase();
  return form(a) === form(b);
}

/**
 * @brief 时刻的本地日历日期（§7.3 的 at）。
 * @param time 条目的 timestamp 或反馈的 createdAt
 * @param where 出处（错误原文用）
 * @throws 读不出时刻时（工具按写入失败报告并记错误日志，不另编一个日期）
 */
function dayOfTime(time: unknown, where: string): string {
  const ms = typeof time === 'string' ? Date.parse(time) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`${where} has no valid time: ${String(time)}`);
  return localDate(ms);
}

/**
 * @brief 会话文件里 id 为 entry 的那一行（pi 的 parseSessionEntries，不写文件）。读不出文件时抛错
 *        （工具按写入失败报告并记错误日志）。
 * @return 那一行；没有这一行时为 null
 */
async function sessionLine(file: string, entry: string): Promise<{ timestamp?: unknown } | null> {
  const pi = await loadPi();
  const lines = pi.parseSessionEntries(await readFile(file, 'utf8')) as { id?: unknown; timestamp?: unknown }[];
  return lines.find((line) => line.id === entry) ?? null;
}

/** @brief 原话（可选，原样保存）。 */
function quoteOf(item: RawEvidence): Pick<StoredEvidence, 'quote'> {
  return item.quote !== undefined ? { quote: item.quote } : {};
}

/**
 * @brief 核对一项会话依据（§7.3）：会话是列出的会话或实例会话之一，条目是那个文件里某一行的 id；
 *        存下列出的路径与会话名，at 取那个条目时刻的本地日期。
 */
async function sessionEvidence(scope: EvidenceScope,
  item: RawEvidence): Promise<{ evidence: StoredEvidence } | { error: string }> {
  const listed = [...scope.sessions, ...scope.instanceFiles].find((each) => samePath(each.file, item.session ?? ''));
  if (!listed) return { error: 'session not listed' };
  const entry = item.entry ?? '';
  const line = await sessionLine(listed.file, entry);
  if (!line) return { error: `entry ${entry} not in ${listed.file}` };
  return { evidence: { at: dayOfTime(line.timestamp, `Entry ${entry} in ${listed.file}`), session: listed.file,
    entry, title: listed.title, ...quoteOf(item) } };
}

/** @brief 核对一项反馈依据（§7.3）：必须是列出的反馈文件名之一；at 取它 createdAt 的本地日期。 */
function feedbackEvidence(scope: EvidenceScope, item: RawEvidence): { evidence: StoredEvidence } | { error: string } {
  const listed = scope.feedback.find((each) => each.name === item.feedback);
  if (!listed) return { error: 'feedback not listed' };
  return { evidence: { at: dayOfTime(listed.createdAt, `Feedback ${listed.name}`), feedback: listed.name,
    ...quoteOf(item) } };
}

/**
 * @brief 增强任务的依据（§7.3）：每一项按这次运行的范围核对，有一项不合格时整次调用被拒绝（不写任何东西）。
 *        带 session 与 entry 的是会话依据（schema 的第一种写法），其余是反馈依据（第二种写法）。
 * @param ctx 工具的上下文
 * @param items 模型给的依据（schema 已保证 1–10 项、每项的写法）
 */
async function enhanceEvidence(ctx: MemoryToolContext,
  items: readonly RawEvidence[]): Promise<{ items: StoredEvidence[] } | { error: string }> {
  if (!ctx.scope) throw new Error('This enhancement run has no evidence scope');
  const out: StoredEvidence[] = [];
  for (const [index, item] of items.entries()) {
    const fromSession = item.session !== undefined && item.entry !== undefined;
    const checked = fromSession ? await sessionEvidence(ctx.scope, item) : feedbackEvidence(ctx.scope, item);
    if ('error' in checked) return { error: `Evidence ${index + 1} isn’t from this run’s material: ${checked.error}.` };
    out.push(checked.evidence);
  }
  return { items: out };
}

/**
 * @brief 这次调用带的依据：增强任务按范围核对；agent 的 save、update 是你的原话加上程序记下的位置（§7.3），
 *        forget 没有依据。
 */
async function evidenceOf(ctx: MemoryToolContext,
  args: Args): Promise<{ items: StoredEvidence[] } | { error: string }> {
  if (ctx.caller.kind === 'enhance') return enhanceEvidence(ctx, args.evidence as RawEvidence[]);
  if (args.action === 'forget') return { items: [] };
  const position = ctx.position();
  const session = position.session !== null ? { session: position.session } : {};
  return { items: [{ at: localDate(Date.now()), ...session, entry: position.entry, title: position.title,
    quote: args.quote as string }] };
}

// ---- 执行（§7.4） ----

/**
 * @brief save：种类与层（agent 默认本项目；增强固定为这个任务的种类与本项目），谁能改什么（§6.4），依据，写入。
 *        note 只属于 update、forget（§7.1），新增不带修订说明（§3.2：新增不加 Revisions 行）。
 * @param ctx 工具的上下文
 * @param args 参数（字段已查过）
 */
async function saveEntry(ctx: MemoryToolContext, args: Args): Promise<Reply> {
  const kind = ctx.caller.kind === 'agent' ? (args.kind as MemoryKind) : ctx.caller.task;
  const layer = ctx.caller.kind === 'agent' ? (args.layer as MemoryLayer | undefined) ?? 'project' : 'project';
  const refusal = writeRefusal(ctx.caller, { layer, kind, source: null });
  if (refusal) return refuse(refusal, true);
  const evidence = await evidenceOf(ctx, args);
  if ('error' in evidence) return refuse(evidence.error, false);
  const abstract = (args.abstract as string).trim();
  const result = await save(actorOf(ctx), { cwd: ctx.cwd, layer, kind, abstract, detail: textArg(args.detail) ?? '',
    evidence: evidence.items });
  if (result.error !== null) return writeFailure(result.error);
  return done(`Saved to ${placeText(kind, layer)}: ${abstract}`, result,
    { kind, layer, entry: result.id ?? '', action: 'save' });
}

/**
 * @brief update、forget 要改的条目（§7.4 的条目匹配）：先在调用方能改的范围里找，再在范围之外找；
 *        匹配到的条目再按谁能改什么检查（增强改你写的条目在这里被拒绝）。
 */
async function locateEntry(ctx: MemoryToolContext, args: Args): Promise<{ match: Candidate } | { error: string }> {
  const scope = matchScope(ctx.caller, await candidates(ctx.cwd));
  const layer = ctx.caller.kind === 'agent' ? (args.layer as MemoryLayer | undefined) : undefined;
  const found = matchEntry(ctx.caller, args.entry as string, layer, scope.candidates, scope.others);
  if ('error' in found) return found;
  const { match } = found;
  const refusal = writeRefusal(ctx.caller, { layer: match.layer, kind: match.kind, source: match.source,
    abstract: match.abstract });
  return refusal ? { error: refusal } : found;
}

/**
 * @brief update 与 forget：匹配条目、依据、写入。update 的新 abstract、新 detail 可选，依据追加（增强可以只带依据与说明）。
 * @param ctx 工具的上下文
 * @param args 参数（字段已查过）
 */
async function changeEntry(ctx: MemoryToolContext, args: Args): Promise<Reply> {
  const found = await locateEntry(ctx, args);
  if ('error' in found) return refuse(found.error, true);
  const { match } = found;
  const evidence = await evidenceOf(ctx, args);
  if ('error' in evidence) return refuse(evidence.error, false);
  const target = { cwd: ctx.cwd, layer: match.layer, kind: match.kind, id: match.id };
  const place = { kind: match.kind, layer: match.layer, entry: match.id };
  const note = args.note as string;
  if (args.action === 'forget') {
    const result = await forget(actorOf(ctx), { target, note, evidence: evidence.items });
    if (result.error !== null) return writeFailure(result.error);
    return done(`Deleted from ${placeText(match.kind, match.layer)}: ${match.abstract}`, result,
      { ...place, action: 'forget' });
  }
  const abstract = textArg(args.abstract)?.trim();
  const detail = textArg(args.detail);
  const result = await update(actorOf(ctx), { target, note, evidence: evidence.items,
    ...(abstract !== undefined ? { abstract } : {}), ...(detail !== undefined ? { detail } : {}) });
  if (result.error !== null) return writeFailure(result.error);
  return done(`Updated ${placeText(match.kind, match.layer)}: ${abstract ?? match.abstract}`, result,
    { ...place, action: 'update' });
}

/**
 * @brief 执行一次调用（§7.4）：项目目录被占用时不读不写（§3），再查字段，然后按动作写入；
 *        读写时的意外错误按写入失败报告并记错误日志。
 */
async function runMemory(ctx: MemoryToolContext, args: Args): Promise<Reply> {
  try {
    const owner = projectDir(ctx.cwd).error;
    if (owner) return refuse(owner, false);
    const field = toolFieldError(args, ctx.caller);
    if (field) return refuse(field, true);
    return args.action === 'save' ? await saveEntry(ctx, args) : await changeEntry(ctx, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] the memory tool failed in ${ctx.cwd}: ${message}`);
    return refuse(`Couldn’t save the memory: ${message}`, false);
  }
}

/** @brief pi 的工具结果。 */
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;

/** @brief 把结果写成 pi 的工具结果：错误的 isError 为真，写法或规则错误加第二行 Correct form（§7.4）。 */
function toolResult(caller: MemoryCaller, reply: Reply): ToolResult {
  if (reply.ok) return { content: [{ type: 'text', text: reply.text }], details: reply.details };
  const text = reply.usage ? `${reply.reason}\n${correctForm(caller)}` : reply.reason;
  return { content: [{ type: 'text', text }], details: undefined, isError: true };
}

/**
 * @brief 一个会话的 memory 工具（§7.1）：名字 memory，JSON Schema 参数，说明全在 description 里（没有 promptSnippet、
 *        promptGuidelines），注册即启用（§7.6：用户会话没有白名单时 pi 照常启用，实例会话由白名单决定）。
 * @param ctx 这个会话的调用方、工作目录、增强运行与位置
 */
export function memoryTool(ctx: MemoryToolContext): ToolDefinition {
  const schema = ctx.caller.kind === 'agent' ? agentSchema() : enhanceSchema();
  return {
    name: MEMORY_TOOL,
    label: 'Memory',
    description: toolDescription(ctx.caller),
    parameters: schema as unknown as ToolDefinition['parameters'],
    prepareArguments: (raw: unknown) => prepareArgs(schema, raw) as never,
    defaultActive: true,
    execute: async (_toolCallId, params) => toolResult(ctx.caller, await runMemory(ctx, params as Args)),
  };
}
