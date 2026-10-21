// 角色（docs/specs/parallel-agents-taskboard.md §4、§6.3、§8.1、§9.5、§12.1）：读、校验 <project>/.mori/agents/*.md，
// 分配三项权限，补上基座 mori；按会话的种类算工具白名单，算交接单 next 与 task_create assignee 的枚举、候选的选择范围、
// 订阅是否命中。只有 loadRoles 读文件；其余都是纯函数。frontmatter 由调用方传入 pi 导出的 parseFrontmatter 解析
// （本模块不载入 pi），字段用 zod 严格校验。

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelPick } from '../shared/models';
import { READ_ONLY_TOOLS } from '../shared/protocol';
import {
  BASE_ROLE, BASE_ROLE_DESCRIPTION, NUMBER_LIKE_PATTERN, ROLE_NAME_PATTERN, SEATS, TEAM_TOOLS, TEXT_LIMITS, baseHolders,
  isTeamTool,
  type InstanceKind, type RequestStatus, type Seat, type TeamHolders, type TeamToolName,
} from '../shared/team';
import type { Requirement } from './modelTypes';

// ---- 取值 ----

/** @brief 角色文件所在的目录，相对项目根（§4.1）；只读这一层，不递归。问题行里的文件路径以它开头。 */
export const AGENTS_DIR = '.mori/agents';

/** @brief 角色文件的 tools 里可以写的 pi 工具名（§4.1）。 */
export const PI_TOOL_NAMES: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];

/** @brief 基座的白名单里代表全部 MCP 工具的写法（§4.2、§8.2：基座写 mcp__*）。 */
export const ALL_MCP_TOOLS = 'mcp__*';

export { BASE_ROLE_DESCRIPTION };

/** @brief 订阅的时刻（§9.5）：v1 只有 request_closed。 */
export const SUBSCRIBE_MOMENTS = ['request_closed'] as const;
export type SubscribeMoment = (typeof SUBSCRIBE_MOMENTS)[number];

/** @brief request_closed 的 outcome 过滤可以写的需求结局（§9.5）。 */
export const CLOSED_OUTCOMES = ['done', 'failed', 'cancelled'] as const;
export type ClosedOutcome = (typeof CLOSED_OUTCOMES)[number];

/** @brief MCP 工具的写法 mcp__<服务>__<工具> 或 mcp__<服务>__*（§4.1）；服务名按 pi 的命名空间写（- 换成 _）。 */
const MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_]+__(?:\*|[^\s*]+)$/;

/** @brief context>=N 的写法，N 是正整数（§4.1、§4.4）。 */
const CONTEXT_REQUIREMENT = /^context>=([1-9][0-9]*)$/;

/** @brief 立项持有者的会话多出的 TaskBoard 工具（§6.3 request_submit 至 reply_via_dialog 各行）。 */
const CREATE_TOOLS: readonly TeamToolName[] = [
  'request_submit', 'request_update', 'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog',
];

/** @brief 协作模式下对话会话的 TaskBoard 工具（§5.5）。 */
const DIALOG_TEAM_TOOLS: readonly TeamToolName[] = ['board_read', 'read_session', 'agent_message'];

/**
 * @brief 每种实例会话有的 TaskBoard 工具（§6.3 的“谁有”一列）；实例都在协作模式下建立，
 *        只有临时提问也会在关闭模式下建立，那时没有 TaskBoard 工具。
 */
const INSTANCE_TEAM_TOOLS: Readonly<Record<InstanceKind, readonly TeamToolName[]>> = Object.freeze({
  create: ['board_read', 'read_session', 'agent_message', ...CREATE_TOOLS],
  close: ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_close'],
  task: ['board_read', 'read_session', 'agent_message', 'task_handoff'],
  ask: ['board_read', 'read_session'],
  subscription: ['board_read', 'read_session', 'agent_message'],
});

// ---- 类型 ----

/** @brief 角色文件 subscribe 的一项（§9.5）：时刻与过滤，过滤之间只用“与”。 */
export interface Subscription {
  /** 时刻 */
  moment: SubscribeMoment;
  /** ruled_out 过滤：需求有（true）或没有（false）已排除的方案；没写时为 null */
  ruledOut: boolean | null;
  /** outcome 过滤：只在这些结局时命中；没写时为 null */
  outcome: ClosedOutcome[] | null;
}

/** @brief 一个角色：角色文件读出的，或基座 mori（§4.1、§4.2）。 */
export interface RoleDef {
  /** 角色名；基座为 mori */
  name: string;
  /** 一句话说明；基座为 BASE_ROLE_DESCRIPTION */
  description: string;
  /** 正文（职责说明），原样放进这个角色所有会话的 system prompt 附加段（§8.5）；基座和没有正文的文件为空字符串 */
  body: string;
  /** 角色文件相对项目根的路径，例如 .mori/agents/planner.md；基座为 null */
  file: string | null;
  /** 写了的工具（pi 工具名与 MCP 写法，去重，按写的顺序）；没写和基座为 null，表示与基座相同（§4.2） */
  tools: string[] | null;
  /** 有序候选：选择范围的名字（去重，按写的顺序）；没写和基座为 null，表示用会话的选择范围（§12.1） */
  models: ModelPick[] | null;
  /** 能力要求：第一项总是隐含的 tool_calling，其余按写的顺序去重（§4.1、§12.2） */
  requires: Requirement[];
  /** 这个角色持有的权限，按 SEATS 的顺序；基座是没人认领的那几项（§4.2） */
  seats: Seat[];
  /** 写了 differ_from: author（§12.9） */
  differFromAuthor: boolean;
  /** 订阅（§9.5）；没写时为空 */
  subscribe: Subscription[];
}

/** @brief 读角色文件的结果（§4.3、§4.4）。 */
export interface RoleLoad {
  /** 全部角色：角色文件按文件名的顺序，基座 mori 在最后；有问题时只有基座 */
  roles: RoleDef[];
  /** 三项权限的持有者；有问题时都是 mori */
  holders: TeamHolders;
  /** 拒绝启动卡上的问题（§4.4 表的写法 <file>: …），逐条；为空时校验通过 */
  problems: string[];
  /** 对话与立项由同一个角色持有（合并会话，§1、§5.3） */
  merged: boolean;
}

/** @brief 读角色文件要用的外部能力。 */
export interface RoleDeps {
  /**
   * @brief 名字是否在你的模型设置里（分组、提供商或 <provider>/<model>，统一模型提供商规格 §5.1、§10）。
   * @param name models 里写的名字
   */
  pickExists(name: string): boolean;
  /**
   * @brief pi 导出的 parseFrontmatter：YAML 错误时抛出；没有 frontmatter 时 frontmatter 为空对象。
   * @param content 文件全文
   */
  parseFrontmatter(content: string): { frontmatter: unknown; body: string };
}

/** @brief 一个角色文件的内容：读出的全文，或读不出时的错误原文。 */
export type RoleFileText =
  | {
    /** 相对项目根的路径，例如 .mori/agents/planner.md */
    file: string;
    /** 文件全文（UTF-8） */
    text: string;
  }
  | {
    /** 相对项目根的路径 */
    file: string;
    /** 读文件时的错误原文 */
    readError: string;
  };

/** @brief next 或 assignee 的枚举（§6.3）。 */
export interface RoleEnum {
  /** 枚举的取值：角色名（基座为 mori） */
  values: string[];
  /** schema 的说明：每项一行 <name>: <description>，持有权限的加注，例如 planner (create, close): … */
  description: string;
}

/** @brief 订阅判断要用的需求快照（§9.5）。 */
export interface ClosedRequest {
  /** 需求的状态 */
  status: RequestStatus;
  /** 已排除的方案（§6.1）：以 failed 关闭的 task 的关闭结论 */
  ruledOut: readonly string[];
}

// ---- 字段的校验（§4.1、§4.4） ----

/** @brief 问题行里显示的值：字符串原样，其余写成 JSON。 */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/** @brief 没写（YAML 的空值也算）时的原因，否则是类型不对的原因。 */
function requiredOr(field: string, wrongType: string) {
  return (issue: { input?: unknown }): string => (issue.input == null
    ? `${field} is required` : `${field} ${wrongType}`);
}

/** @brief name 不是字符串时的原因：YAML 把 name: 12 读成数字，按“像编号”说明。 */
function nameTypeError(issue: { input?: unknown }): string {
  const { input } = issue;
  if (typeof input === 'number' && NUMBER_LIKE_PATTERN.test(String(input))) {
    return `name "${input}" looks like a task or request number`;
  }
  return requiredOr('name', 'must be text')(issue);
}

/** @brief name：格式、不是 mori、不像编号（§4.1、§4.4）。 */
const NAME_SCHEMA = z.string({ error: nameTypeError })
  .regex(ROLE_NAME_PATTERN, {
    error: 'name must use lowercase letters, digits and - (at most 40, not starting with -)', abort: true,
  })
  .refine((name) => name !== BASE_ROLE,
    { error: (issue) => `name "${shown(issue.input)}" is reserved for the base agent` })
  .refine((name) => !NUMBER_LIKE_PATTERN.test(name),
    { error: (issue) => `name "${shown(issue.input)}" looks like a task or request number` });

/** @brief description：一句话，≤ 200 字符（§4.1、§15）。 */
const DESCRIPTION_SCHEMA = z.string({ error: requiredOr('description', 'must be text') })
  .trim()
  .min(1, { error: 'description must not be empty', abort: true })
  .refine((text) => [...text].length <= TEXT_LIMITS.roleDescription,
    { error: `description must be at most ${TEXT_LIMITS.roleDescription} characters` });

/**
 * @brief 一个列表字段：不是列表时 <field> must be a list；每项的问题由 problemsOf 给出。
 * @param field 字段名
 * @param problemsOf 一项的问题（问题行冒号后面的文字）；没有问题时为空
 */
function listSchema(field: string, problemsOf: (item: unknown, index: number) => string[]) {
  return z.array(z.unknown(), { error: `${field} must be a list` }).superRefine((items, ctx) => {
    items.forEach((item, index) => {
      for (const message of problemsOf(item, index)) ctx.addIssue({ code: 'custom', message, path: [index] });
    });
  });
}

/** @brief tools 的一项：pi 工具名或 MCP 写法；TaskBoard 工具由程序加，写了算错（§4.1）。 */
function toolProblems(item: unknown): string[] {
  if (typeof item === 'string' && isTeamTool(item)) return [`"${item}" is added by Mori; remove it`];
  if (typeof item === 'string' && (PI_TOOL_NAMES.includes(item) || MCP_TOOL_PATTERN.test(item))) return [];
  return [`unknown tool "${shown(item)}"`];
}

/** @brief seats 的一项（§4.1）。 */
function seatProblems(item: unknown): string[] {
  const known = typeof item === 'string' && (SEATS as readonly string[]).includes(item);
  return known ? [] : [`unknown seat "${shown(item)}"`];
}

/**
 * @brief 把 requires 的一项解析成能力要求（§4.1 的词表）。
 * @return 不在词表、context>=N 的 N 不是正整数时为 null
 */
function parseRequirement(item: unknown): Requirement | null {
  switch (item) {
    case 'tool_calling': return { kind: 'tool_calling' };
    case 'protocol_write': return { kind: 'protocol_write', min: 'C' };
    case 'protocol_write>=B': return { kind: 'protocol_write', min: 'B' };
    case 'structured_output': return { kind: 'structured_output' };
    case 'vision': return { kind: 'vision' };
  }
  const match = typeof item === 'string' ? CONTEXT_REQUIREMENT.exec(item) : null;
  const tokens = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(tokens) ? { kind: 'context', tokens } : null;
}

/** @brief requires 的一项（§4.4）。 */
function requirementProblems(item: unknown): string[] {
  return parseRequirement(item) === null ? [`unknown requirement "${shown(item)}"`] : [];
}

/** @brief 是不是 YAML 的映射（普通对象）。 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief outcome 过滤：done、failed、cancelled 的子集，写成列表（§9.5）。 */
function readOutcome(value: unknown): { outcome: ClosedOutcome[]; problems: string[] } {
  if (!Array.isArray(value)) return { outcome: [], problems: [`unknown filter "outcome: ${shown(value)}"`] };
  const known = (item: unknown): item is ClosedOutcome => (CLOSED_OUTCOMES as readonly unknown[]).includes(item);
  const problems = value.filter((item) => !known(item)).map((item) => `unknown filter "outcome: ${shown(item)}"`);
  return { outcome: [...new Set(value.filter(known))], problems };
}

/** @brief request_closed 的过滤（§9.5）：没写或空值时不过滤。 */
function readFilters(moment: SubscribeMoment, filters: unknown): { sub: Subscription; problems: string[] } {
  const sub: Subscription = { moment, ruledOut: null, outcome: null };
  if (filters == null) return { sub, problems: [] };
  if (!isMapping(filters)) return { sub, problems: [`unknown filter "${shown(filters)}"`] };
  const problems: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'ruled_out' && typeof value === 'boolean') sub.ruledOut = value;
    else if (key === 'ruled_out') problems.push(`unknown filter "ruled_out: ${shown(value)}"`);
    else if (key === 'outcome') {
      const read = readOutcome(value);
      sub.outcome = read.outcome;
      problems.push(...read.problems);
    } else problems.push(`unknown filter "${key}"`);
  }
  return { sub, problems };
}

/** @brief subscribe 的一项：时刻名，或 { 时刻名: { 过滤 } }（§9.5）。 */
function readSubscriptions(item: unknown): { subs: Subscription[]; problems: string[] } {
  const known = (name: unknown): name is SubscribeMoment => (SUBSCRIBE_MOMENTS as readonly unknown[]).includes(name);
  if (known(item)) return { subs: [{ moment: item, ruledOut: null, outcome: null }], problems: [] };
  if (!isMapping(item) || Object.keys(item).length === 0) {
    return { subs: [], problems: [`unknown moment "${shown(item)}"`] };
  }
  const subs: Subscription[] = [];
  const problems: string[] = [];
  for (const [moment, filters] of Object.entries(item)) {
    if (!known(moment)) {
      problems.push(`unknown moment "${moment}"`);
      continue;
    }
    const read = readFilters(moment, filters);
    subs.push(read.sub);
    problems.push(...read.problems);
  }
  return { subs, problems };
}

/** @brief seats 字段（跨文件检查也用它取一个文件认领的权限）。 */
const SEATS_SCHEMA = listSchema('seats', seatProblems);

/**
 * @brief 角色文件 frontmatter 的严格 schema（§4.1）：未知字段报错；各项的错误文字就是问题行冒号后面的部分（§4.4）。
 * @param pickExists 名字是否在你的模型设置里
 */
function roleFileSchema(pickExists: (name: string) => boolean) {
  const models = listSchema('models', (item, index) => (typeof item === 'string' && pickExists(item)
    ? [] : [`"${shown(item)}" is not in your model settings (models[${index}])`]))
    .refine((items) => items.length > 0, { error: 'models must name at least one model range' });
  return z.strictObject({
    name: NAME_SCHEMA,
    description: DESCRIPTION_SCHEMA,
    tools: listSchema('tools', toolProblems).optional(),
    models: models.optional(),
    requires: listSchema('requires', requirementProblems).optional(),
    seats: SEATS_SCHEMA.optional(),
    differ_from: z.literal('author', { error: 'differ_from can only be "author"' }).optional(),
    subscribe: listSchema('subscribe', (item) => readSubscriptions(item).problems).optional(),
  });
}

type RoleFields = z.infer<ReturnType<typeof roleFileSchema>>;

// ---- 读一个文件 ----

/** @brief 错误原文的第一行（YAML 的错误后面跟着代码片段，卡上一条只写一行），去掉末尾的冒号。 */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split(/\r?\n/).find((line) => line.trim()) ?? message).trim().replace(/:$/, '');
}

/** @brief 解析 frontmatter（§4.1）：YAML 错误、没有 frontmatter、不是 field: value 的映射都算读不出。 */
function readHeader(text: string, parse: RoleDeps['parseFrontmatter']):
  { fields: Record<string, unknown>; body: string } | { problem: string } {
  let parsed: { frontmatter: unknown; body: string };
  try {
    parsed = parse(text);
  } catch (error) {
    return { problem: `can't read the header: ${firstLine(error)}` };
  }
  if (!isMapping(parsed.frontmatter)) return { problem: 'can\'t read the header: it must be "field: value" lines' };
  if (Object.keys(parsed.frontmatter).length === 0) {
    return { problem: "can't read the header: no header between --- lines" };
  }
  return { fields: parsed.frontmatter, body: parsed.body };
}

/** @brief zod 的错误转成问题行冒号后面的文字：未知字段每个一行，其余就是 schema 里写好的文字。 */
function issueLines(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => (issue.code === 'unrecognized_keys'
    ? issue.keys.map((key) => `unknown field "${key}"`) : [issue.message]));
}

/** @brief requires 加上隐含的 tool_calling，按写的顺序去重（§4.1）。 */
function requirementsOf(items: readonly unknown[]): Requirement[] {
  const all: Requirement[] = [{ kind: 'tool_calling' }];
  for (const item of items) {
    const requirement = parseRequirement(item);
    if (requirement && !all.some((known) => JSON.stringify(known) === JSON.stringify(requirement))) {
      all.push(requirement);
    }
  }
  return all;
}

/** @brief 校验通过的字段转成 RoleDef。 */
function toRole(file: string, fields: RoleFields, body: string): RoleDef {
  const seats = fields.seats ?? [];
  return {
    name: fields.name,
    description: fields.description,
    body,
    file,
    tools: fields.tools ? [...new Set(fields.tools as string[])] : null,
    models: fields.models ? [...new Set(fields.models as string[])] : null,
    requires: requirementsOf(fields.requires ?? []),
    seats: SEATS.filter((seat) => seats.includes(seat)),
    differFromAuthor: fields.differ_from === 'author',
    subscribe: (fields.subscribe ?? []).flatMap((item) => readSubscriptions(item).subs),
  };
}

/** @brief 一个文件的校验结果：自己的问题、frontmatter 的字段（跨文件检查用）、通过时的角色。 */
interface FileCheck {
  /** 这个文件自己的问题（问题行冒号后面的文字） */
  problems: string[];
  /** frontmatter 的字段；读不出 frontmatter 时为 null，这个文件不参与跨文件检查 */
  fields: Record<string, unknown> | null;
  /** 校验通过时的角色；有问题时为 null */
  role: RoleDef | null;
}

/** @brief 校验一个角色文件（§4.4 中只看这个文件就能判断的各行）。 */
function checkFile(entry: RoleFileText, deps: RoleDeps): FileCheck {
  if ('readError' in entry) {
    return { problems: [`can't read the header: ${entry.readError}`], fields: null, role: null };
  }
  const header = readHeader(entry.text, deps.parseFrontmatter);
  if ('problem' in header) return { problems: [header.problem], fields: null, role: null };
  const parsed = roleFileSchema(deps.pickExists).safeParse(header.fields);
  if (!parsed.success) return { problems: issueLines(parsed.error.issues), fields: header.fields, role: null };
  return { problems: [], fields: header.fields, role: toRole(entry.file, parsed.data, header.body) };
}

/**
 * @brief 跨文件的检查（§4.4）：name 重复、权限被另一个文件认领。先读到的文件占有，后面的文件报问题；
 *        这个文件的 name 或 seats 本身不合格时不参与（它自己已经报了问题）。
 * @param file 这个文件
 * @param fields 这个文件的 frontmatter
 * @param names 已经用掉的名字 → 文件
 * @param claims 已经被认领的权限 → 文件
 */
function crossProblems(file: string, fields: Record<string, unknown>, names: Map<string, string>,
  claims: Map<Seat, string>): string[] {
  const problems: string[] = [];
  const name = NAME_SCHEMA.safeParse(fields.name);
  if (name.success) {
    const other = names.get(name.data);
    if (other) problems.push(`name "${name.data}" is already used by ${other}`);
    else names.set(name.data, file);
  }
  const seats = SEATS_SCHEMA.safeParse(fields.seats);
  for (const seat of SEATS.filter((item) => seats.success && seats.data.includes(item))) {
    const other = claims.get(seat);
    if (other) problems.push(`seat "${seat}" is also claimed by ${other}`);
    else claims.set(seat, file);
  }
  return problems;
}

// ---- 权限与基座（§4.2） ----

/** @brief 基座 mori：没有正文，工具与候选同 v0，没有额外的能力要求（§4.2）。 */
function baseRole(seats: Seat[]): RoleDef {
  return {
    name: BASE_ROLE, description: BASE_ROLE_DESCRIPTION, body: '', file: null, tools: null, models: null,
    requires: [{ kind: 'tool_calling' }], seats, differFromAuthor: false, subscribe: [],
  };
}

/** @brief 只有基座：没有角色文件，或校验不通过时会话照“只有基座”建立（§4.4）。 */
function baseOnly(problems: string[]): RoleLoad {
  return { roles: [baseRole([...SEATS])], holders: baseHolders(), problems, merged: true };
}

/** @brief 每项权限的持有者：认领它的角色，没人认领的由基座持有（§4.2）。 */
function assemble(fileRoles: RoleDef[]): RoleLoad {
  const holders = baseHolders();
  for (const role of fileRoles) for (const seat of role.seats) holders[seat] = role.name;
  const base = baseRole(SEATS.filter((seat) => holders[seat] === BASE_ROLE));
  return { roles: [...fileRoles, base], holders, problems: [], merged: holders.dialog === holders.create };
}

/**
 * @brief 校验已经读出的角色文件、分配权限（§4.1、§4.2、§4.4）。纯函数。
 * @param files 角色文件，按读的顺序（loadRoles 按文件名排序）；先读到的文件占有重复的名字与权限
 * @param deps 模型设置里的名字、pi 的 parseFrontmatter
 * @return 有任何问题时 problems 逐条列出（<file>: …），roles 只有基座、三项权限都是 mori
 */
export function parseRoleFiles(files: readonly RoleFileText[], deps: RoleDeps): RoleLoad {
  const problems: string[] = [];
  const fileRoles: RoleDef[] = [];
  const names = new Map<string, string>();
  const claims = new Map<Seat, string>();
  for (const entry of files) {
    const check = checkFile(entry, deps);
    const cross = check.fields ? crossProblems(entry.file, check.fields, names, claims) : [];
    problems.push(...[...check.problems, ...cross].map((problem) => `${entry.file}: ${problem}`));
    if (check.role) fileRoles.push(check.role);
  }
  return problems.length ? baseOnly(problems) : assemble(fileRoles);
}

/** @brief .mori/agents 里的 *.md 文件名（不递归），按文件名排序；目录不存在时为空。 */
async function roleFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries.filter((entry) => !entry.isDirectory() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name);
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    console.error(`[kernel] cannot list ${AGENTS_DIR}: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * @brief 读、校验项目的角色文件 <cwd>/.mori/agents/*.md（只读这一层），分配权限（§4.3、§4.4）。
 *        用户会话新建或打开、Check again 时调用；结果在这个用户会话里不变。
 * @param cwd 项目根（用户会话的工作目录）
 * @param deps 模型设置里的名字、pi 的 parseFrontmatter
 * @return 角色、持有者、问题（为空时校验通过）、是否合并会话
 */
export async function loadRoles(cwd: string, deps: RoleDeps): Promise<RoleLoad> {
  const dir = join(cwd, '.mori', 'agents');
  const files: RoleFileText[] = [];
  for (const name of await roleFileNames(dir)) {
    const file = `${AGENTS_DIR}/${name}`;
    try {
      files.push({ file, text: await readFile(join(dir, name), 'utf8') });
    } catch (error) {
      console.error(`[kernel] cannot read ${file}: ${(error as Error).message}`);
      files.push({ file, readError: firstLine(error) });
    }
  }
  const load = parseRoleFiles(files, deps);
  if (load.problems.length) console.error(`[kernel] agent files are invalid:\n  ${load.problems.join('\n  ')}`);
  return load;
}

// ---- 工具（§5.2、§5.5、§8.1、§8.2） ----

/** @brief 按 TEAM_TOOLS 的顺序（§6.3 表的顺序）排列 TaskBoard 工具。 */
function inToolOrder(names: readonly TeamToolName[]): TeamToolName[] {
  return TEAM_TOOLS.filter((name) => names.includes(name));
}

/**
 * @brief 名字为 name 的角色（基座为 mori）。
 * @param roles RoleLoad.roles
 * @param name 角色名
 * @return 不是现在的角色时为 null（例如 board.json 里的角色文件已经删掉，§11.6）
 */
export function findRole(roles: readonly RoleDef[], name: string): RoleDef | null {
  return roles.find((role) => role.name === name) ?? null;
}

/**
 * @brief “角色的工具”（§8.1）：写了 tools 的就是它们（含 MCP 写法）；没写的与基座相同：pi 设置里的默认工具加 mcp__*（§4.2）。
 * @param role 角色
 * @param baseDefaults pi 设置的默认工具（settings.getDefaultTools()，没有设时 read、bash、edit、write）
 */
export function roleTools(role: RoleDef, baseDefaults: readonly string[]): string[] {
  return [...new Set(role.tools ?? [...baseDefaults, ALL_MCP_TOOLS])];
}

/**
 * @brief “角色工具中的读取类”（§8.1）：角色的工具与 READ_ONLY_TOOLS 的交集，不含 MCP 工具；
 *        没写 tools 的取默认工具与它的交集（默认设置下只有 read）。
 * @param role 角色
 * @param baseDefaults pi 设置的默认工具
 */
export function readClassTools(role: RoleDef, baseDefaults: readonly string[]): string[] {
  return [...new Set((role.tools ?? baseDefaults).filter((name) => READ_ONLY_TOOLS.includes(name)))];
}

/**
 * @brief 实例会话建立时的 pi 工具白名单（§8.1、§8.2）= 这个种类的工具 + 它有的 TaskBoard 工具（§6.3）。
 *        task 实例用角色的工具（含 MCP 写法，没写 tools 时 mcp__*），只读的 task 只留读取类；立项、结案、临时提问、
 *        订阅只用读取类。条目可以带 *（pi 白名单的写法）。
 * @param role 实例的角色
 * @param kind 实例会话的种类
 * @param readOnly task 是只读的（只对 task 实例有意义）
 * @param baseDefaults pi 设置的默认工具
 * @param team 在协作模式下建立（只对临时提问有意义：关闭模式下的临时提问没有 TaskBoard 工具）
 */
export function toolAllowlist(role: RoleDef, kind: InstanceKind, readOnly: boolean, baseDefaults: readonly string[],
  team: boolean): string[] {
  const own = kind === 'task' && !readOnly ? roleTools(role, baseDefaults) : readClassTools(role, baseDefaults);
  const board = kind === 'ask' && !team ? [] : inToolOrder(INSTANCE_TEAM_TOOLS[kind]);
  return [...own, ...board];
}

/**
 * @brief 对话会话这次运行开始前要启用的工具（§5.2、§5.5、§8.1）。协作模式下：对话持有者的读取类 + board_read、
 *        read_session、agent_message，合并会话再加立项的工具；关闭模式下对话持有者写了 tools：它的工具，
 *        有别的角色时加 agent_message。
 * @param load 角色、持有者、是否合并会话
 * @param team 这次运行在协作模式下
 * @param baseDefaults pi 设置的默认工具
 * @return 工具条目（可以带 *，按已注册的工具名用 matchesToolEntries 展开）；关闭模式下对话持有者没写 tools 时为 null：
 *         不重新设置（照 v0），只在有别的角色时另外启用 agent_message（见 hasOtherRoles）
 */
export function dialogTools(load: Pick<RoleLoad, 'roles' | 'holders' | 'merged'>, team: boolean,
  baseDefaults: readonly string[]): string[] | null {
  const role = findRole(load.roles, load.holders.dialog);
  if (!role) throw new Error(`the dialog holder ${load.holders.dialog} is not among the roles`);
  if (!team) {
    if (role.tools === null) return null;
    return [...new Set(role.tools), ...(hasOtherRoles(load.roles) ? ['agent_message'] : [])];
  }
  const board = load.merged ? INSTANCE_TEAM_TOOLS.create : DIALOG_TEAM_TOOLS;
  return [...readClassTools(role, baseDefaults), ...inToolOrder(board)];
}

/**
 * @brief 项目里有对话持有者以外的角色（§5.2）：这时关闭模式下的对话多一个 agent_message。基座也是角色，
 *        所以只有一个 chat.md 认领对话时也算有（可以问基座）；没有角色文件时没有。
 * @param roles RoleLoad.roles
 */
export function hasOtherRoles(roles: readonly RoleDef[]): boolean {
  return roles.length > 1;
}

/**
 * @brief 工具名是否在条目里（条目是工具名，或带 * 的写法，* 匹配任意字符，同 pi 的白名单）。
 *        §5.5 拒绝对话角色 tools 之外的调用、把带 * 的条目展开成 setActiveToolsByName 的名字时用。
 * @param entries 工具条目
 * @param name 工具名
 */
export function matchesToolEntries(entries: readonly string[], name: string): boolean {
  return entries.some((entry) => {
    if (!entry.includes('*')) return entry === name;
    const source = entry.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${source}$`).test(name);
  });
}

// ---- next 与 assignee 的枚举（§6.3） ----

/** @brief 说明里的一行：<name>: <description>，持有权限的加注，例如 planner (create, close): …（§6.3）。 */
function roleLine(role: RoleDef): string {
  const seats = role.seats.length ? ` (${role.seats.join(', ')})` : '';
  return `${role.name}${seats}: ${role.description}`;
}

/** @brief 角色列表转成枚举。 */
function toEnum(roles: readonly RoleDef[]): RoleEnum {
  return { values: roles.map((role) => role.name), description: roles.map(roleLine).join('\n') };
}

/**
 * @brief 这个会话的 task_handoff 的 next 枚举（§6.3）：全部角色名（含 mori）去掉自己。
 * @param roles RoleLoad.roles
 * @param self 这个会话的角色名
 * @return 去掉自己后没有角色（只有基座一个角色）时为 null：这个会话的交接单没有 next
 */
export function nextEnum(roles: readonly RoleDef[], self: string): RoleEnum | null {
  const others = roles.filter((role) => role.name !== self);
  return others.length ? toEnum(others) : null;
}

/**
 * @brief task_create、task_edit 的 assignee 枚举（§6.3）：全部角色名（含 mori）。
 * @param roles RoleLoad.roles
 */
export function assigneeEnum(roles: readonly RoleDef[]): RoleEnum {
  return toEnum(roles);
}

// ---- 候选与订阅（§12.1、§9.5） ----

/**
 * @brief 角色会话的候选来源（§12.1）：角色的 models；基座、没写 models 的角色用会话的选择范围（你最后选的）。
 *        多个范围由模型层依次展开、去重。关闭模式下的对话会话直接用顶栏的范围，不用它；
 *        关闭模式下的临时提问在展开之后再与对话的候选取交集（模型层做）。
 * @param role 会话的角色
 * @param sessionPick 用户会话的选择范围；没有时为 null
 * @return 有序的选择范围，去重；没写 models 而会话没有选择范围时为空
 */
export function roleCandidates(role: RoleDef, sessionPick: ModelPick | null): ModelPick[] {
  if (role.models) return [...new Set(role.models)];
  return sessionPick === null ? [] : [sessionPick];
}

/**
 * @brief 需求关闭或撤销时，这个角色的订阅是否命中（§9.5）：任何一项命中即可，一项里的过滤都要满足。
 * @param role 订阅者
 * @param request 刚关闭的需求
 * @return 需求还开着时为 false
 */
export function subscriptionMatches(role: RoleDef, request: ClosedRequest): boolean {
  if (request.status === 'open') return false;
  const hasRuledOut = request.ruledOut.length > 0;
  return role.subscribe.some((sub) => sub.moment === 'request_closed'
    && (sub.ruledOut === null || sub.ruledOut === hasRuledOut)
    && (sub.outcome === null || (sub.outcome as readonly string[]).includes(request.status)));
}
