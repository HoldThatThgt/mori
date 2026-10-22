// TaskBoard 的 11 个工具（docs/specs/parallel-agents-taskboard.md §6.2、§6.3、§7.1、§7.5、§14.6 T-T1/T-P1/T-T5/T-F6）：
// 每个会话一组定义（JSON Schema 参数、给模型的说明、prepareArguments 归一），执行交给 Team（BoardToolExecutor）；
// 执行时的错误按 §6.2 写成两行（第一行原因，第二行正确的写法）。task 实例交接之后、强制填写的运行里，
// tool_call 处理器按 guardToolCall 拒绝其他调用并带 terminate（§7.1、§7.5）。这里只有定义与格式，不读写 TaskBoard。

import type { ToolCallEventResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  argOf, normalizeRequestNo, normalizeTaskId, TEAM_TOOLS, TEXT_LIMITS, type InstanceKind, type TeamToolName,
} from '../shared/team';
import {
  closeHandoffSchema, nextDescription, requestCloseSchema, taskHandoffSchema, type JsonSchema, type NextRole,
} from './handoffForm';
import type { RoleDef } from './roles';

/** @brief 工具所在会话的种类：对话（用户会话，合并会话时也是立项），或实例的种类。 */
export type ToolSessionKind = 'dialog' | InstanceKind;

/** @brief 定义一个会话的 TaskBoard 工具要用的信息（schema 的枚举与说明随会话而定）。 */
export interface ToolSessionInfo {
  /** 会话的种类 */
  kind: ToolSessionKind;
  /** 会话的角色（next 去掉它） */
  role: string;
  /** 全部角色（RoleLoad.roles，基座在最后） */
  roles: readonly RoleDef[];
  /** 对话与立项是同一条会话（合并会话） */
  merged: boolean;
  /** 这个会话在协作模式下建立（只影响 agent_message 的说明：关闭模式下只能问角色） */
  team: boolean;
}

/** @brief 一次工具调用的执行上下文。 */
export interface BoardToolCall {
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 这次运行的中止信号（停止时等待中的调用立即结束，§14.2） */
  signal: AbortSignal | undefined;
}

/** @brief Team 执行一个工具的结果。 */
export type BoardToolReply =
  /** 成功：给模型的文字 */
  | {
    ok: true;
    /** 工具结果的文字 */
    text: string;
    /** 结果带 terminate（task 实例的交接、强制填写的运行，§7.1、§7.5） */
    terminate?: boolean;
  }
  /** 被拒绝或失败 */
  | {
    ok: false;
    /** 原因：第一行（已经是两行的，例如证据不合格，原样） */
    reason: string;
    /** 在原因之后加第二行“正确的写法”（§6.2 执行时的错误）；停止、选不到模型等不是写法错误的为 false */
    usage: boolean;
    /** 结果带 terminate（强制填写的运行里交接被拒绝也结束运行，§7.5 第 1 步） */
    terminate?: boolean;
  };

/** @brief 执行 TaskBoard 工具的一方（team.ts）。 */
export interface BoardToolExecutor {
  /**
   * @brief 执行一次调用（参数已由 prepareArguments 归一、经 pi 按 schema 校验）。
   * @param name 工具名
   * @param args 参数
   * @param call toolCallId 与中止信号
   */
  run(name: TeamToolName, args: Record<string, unknown>, call: BoardToolCall): Promise<BoardToolReply>;
}

// ---- schema ----

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 字符串属性。 */
function text(description: string): JsonSchema {
  return { type: 'string', description };
}

/** @brief 整数属性。 */
function integer(description: string): JsonSchema {
  return { type: 'integer', description };
}

/**
 * @brief 这个会话交接单 next 的可选角色（§6.3）：全部角色（含 mori）去掉自己，带说明与权限。
 * @param roles 全部角色
 * @param self 这个会话的角色
 */
export function nextRoles(roles: readonly RoleDef[], self: string): NextRole[] {
  return roles.filter((role) => role.name !== self)
    .map((role) => ({ name: role.name, description: role.description, seats: role.seats }));
}

/** @brief assignee 属性：全部角色名（含 mori）的枚举，说明里每项 <name>: <description>（§6.3）。 */
function assigneeProperty(roles: readonly RoleDef[]): JsonSchema {
  const all = roles.map((role) => ({ name: role.name, description: role.description, seats: role.seats }));
  return { type: 'string', enum: all.map((role) => role.name),
    description: `The role that does the task. ${nextDescription(all)}` };
}

/** @brief 对象 schema：properties 的顺序即 §6.3 的参数顺序。 */
function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: 'object', properties, required: [...required] };
}

/** @brief 只读与读会话两个工具的 schema。 */
function readSchemas(): Record<'board_read' | 'read_session', JsonSchema> {
  return {
    board_read: objectSchema({
      request: integer('Read one request in detail, e.g. 1.'),
      task: text('Read one task with all its handoffs, e.g. T1.'),
    }, []),
    read_session: objectSchema({
      task: text('The task, e.g. T1.'),
      role: text('Whose session on the task; defaults to the role of the latest handoff.'),
      from: integer('First turn to read (turns are numbered from 1).'),
      to: integer('Last turn to read.'),
    }, ['task']),
  };
}

/** @brief agent_message 的 schema（§6.3、§10.1）。 */
function messageSchema(): JsonSchema {
  return objectSchema({
    to: text('A role name, or a task such as T1 (the message stays on the task).'),
    text: text(`The message, at most ${TEXT_LIMITS.agentMessage} characters.`),
    wait: { type: 'boolean', description: 'Wait for the reply (a question to a role always waits).' },
    request: integer('Which request the message is about, when it goes to the role that closes requests.'),
  }, ['to', 'text']);
}

/** @brief 立项持有者的六个工具的 schema（§6.3）。 */
function createSchemas(roles: readonly RoleDef[]): Record<string, JsonSchema> {
  const quote = text("The user's exact words to record; defaults to the whole user message being decided.");
  return {
    request_submit: objectSchema({
      title: text(`One line, at most ${TEXT_LIMITS.requestTitle} characters.`),
      goal: text(`What the request must achieve, at most ${TEXT_LIMITS.goal} characters.`),
      acceptance: text(`How to tell it is done, at most ${TEXT_LIMITS.acceptance} characters.`), quote,
    }, ['title', 'goal']),
    request_update: objectSchema({ request: integer('The request number.'), quote }, ['request']),
    request_cancel: objectSchema({
      request: integer('The request number.'), reason: text('Why it is cancelled.'),
    }, ['request']),
    task_create: objectSchema({
      request: integer('The request the task belongs to.'),
      title: text(`One line, at most ${TEXT_LIMITS.taskTitle} characters.`),
      description: text(`What to do, at most ${TEXT_LIMITS.taskDescription} characters.`),
      assignee: assigneeProperty(roles),
      read_only: { type: 'boolean', description: 'true unless the task must run commands or change files.' },
      depends_on: { type: 'array', items: { type: 'string' },
        description: 'Tasks of the same request that must be done first, e.g. ["T1"].' },
    }, ['request', 'title', 'description', 'assignee', 'read_only']),
    task_edit: objectSchema({
      task: text('The task, e.g. T1.'), title: text('New title.'), description: text('New description.'),
      assignee: assigneeProperty(roles),
      depends_on: { type: 'array', items: { type: 'string' },
        description: 'New dependencies (only before it starts).' },
    }, ['task']),
    reply_via_dialog: objectSchema({
      note: text('In a turn woken by the program: what the dialog agent should tell the user, at most '
        + `${TEXT_LIMITS.note} characters.`),
    }, []),
  };
}

/**
 * @brief 一个工具在这个会话里的参数 schema（§6.3 的顺序；可选字段只是不在 required 里）。
 *        task_handoff 与 request_close 与强制填写共用 handoffForm.ts 的定义（结案会话的交接没有证据与未结事项）。
 * @param name 工具名
 * @param info 会话的种类、角色与全部角色
 */
export function toolSchema(name: TeamToolName, info: ToolSessionInfo): JsonSchema {
  switch (name) {
    case 'board_read':
    case 'read_session':
      return readSchemas()[name];
    case 'agent_message': return messageSchema();
    case 'task_handoff': {
      const next = nextRoles(info.roles, info.role);
      return info.kind === 'close' ? closeHandoffSchema(next) : taskHandoffSchema(next);
    }
    case 'request_close': return requestCloseSchema();
    default: return createSchemas(info.roles)[name] as JsonSchema;
  }
}

// ---- 给模型的说明 ----

/** @brief 关闭模式下的 agent_message：只能问角色（§10.1）。 */
const ASK_DESCRIPTION = 'Ask another role one question. It answers once in a read-only session and cannot change '
  + 'files; its answer is the result of this call.';

/** @brief 协作模式下的 agent_message（§10.1）。 */
const TEAM_MESSAGE_DESCRIPTION = 'Send a message to a role, or leave it on a task (to: T1; whoever works on the task '
  + 'sees it next, nobody is woken). A message to a role goes to the session that holds its seat (create or close), '
  + 'or opens a one-time read-only question that is answered once. wait: true waits for the reply.';

/**
 * @brief agent_message 的说明：关闭模式下的临时提问实例没有它；对话会话的工具只注册一次，两种模式都用，
 *        所以对话的说明两种都写（§6.3、§10.1）。
 */
function messageDescription(info: ToolSessionInfo): string {
  if (info.kind === 'dialog') {
    return `${ASK_DESCRIPTION} In team mode: ${TEAM_MESSAGE_DESCRIPTION.charAt(0).toLowerCase()}`
      + TEAM_MESSAGE_DESCRIPTION.slice(1);
  }
  return info.team ? TEAM_MESSAGE_DESCRIPTION : ASK_DESCRIPTION;
}

/** @brief task_handoff 的说明：task 实例与结案会话不同（§6.3、§7.1）。 */
function handoffDescription(info: ToolSessionInfo): string {
  if (info.kind === 'close') {
    return 'Decide on a task that was handed to you: close_done when the handoffs and evidence show it is complete, '
      + 'close_failed with the reason, continue with next to reassign it, or need_user when the user must decide.';
  }
  return 'Hand off your part of the task when it is done, once per turn: a short conclusion, the outcome, the next '
    + 'role if someone should continue, open items, and evidence (numbers of your tool results, like #3).';
}

/** @brief 各工具给模型的说明（英文，§0）。 */
const DESCRIPTIONS: Readonly<Record<Exclude<TeamToolName, 'agent_message' | 'task_handoff'>, string>> = {
  board_read: 'Read the TaskBoard: without arguments the whole board; with request one request in detail; with task '
    + 'one task and all its handoffs. Read-only; it wakes nobody.',
  read_session: "Read a role's session on a task as plain text: each turn's delivery, replies, tool calls with their "
    + 'result numbers, and handoffs. Long sessions start with a table of contents; page with from and to.',
  request_submit: "Register a new request for the user's message: a one-line title, the goal and optionally the "
    + "acceptance. The user's words are recorded exactly; then split it with task_create.",
  request_update: "Record the user's supplement or constraint on a request in the user's exact words.",
  request_cancel: 'Cancel a request the user no longer wants: its agents stop and its open tasks are cancelled.',
  task_create: 'Create a task of a request for one role: title, what to do, assignee, read_only (true unless it must '
    + 'run commands or change files) and depends_on (tasks of the same request that must be done first).',
  task_edit: "Change a task's title, description, assignee or dependencies. A task that waits for a user decision or "
    + 'was stopped is handed back by task_edit.',
  reply_via_dialog: 'No collaboration needed: the dialog agent answers the user directly. In a turn woken by the '
    + 'program, note asks the dialog agent to tell the user something.',
  request_close: 'Close the request when all its tasks have ended: done or failed, with a conclusion of what it '
    + 'established.',
};

/**
 * @brief 工具给模型的说明。
 * @param name 工具名
 * @param info 会话的种类与模式
 */
export function toolDescription(name: TeamToolName, info: ToolSessionInfo): string {
  if (name === 'agent_message') return messageDescription(info);
  if (name === 'task_handoff') return handoffDescription(info);
  return DESCRIPTIONS[name];
}

/** @brief 工具页与工具卡的名字（工具页的“来源 Mori”由 resources.ts 显示）。 */
const LABELS: Readonly<Record<TeamToolName, string>> = {
  board_read: 'Read the board', read_session: 'Read a session', agent_message: 'Agent message',
  task_handoff: 'Hand off', request_submit: 'Register a request', request_update: 'Add to a request',
  request_cancel: 'Cancel a request', task_create: 'Create a task', task_edit: 'Edit a task',
  reply_via_dialog: 'Answer directly', request_close: 'Close a request',
};

// ---- 执行时的错误：两行（§6.2） ----

/** @brief task 实例交接的正确写法。 */
const TASK_HANDOFF_USAGE = 'task_handoff {"conclusion":"<what you found or did>","outcome":"done",'
  + '"evidence":["#3"]} (outcome: continue, dead_end, blocked, need_user, done, pass or fail)';
/** @brief 结案会话交接的正确写法。 */
const CLOSE_HANDOFF_USAGE = 'task_handoff {"task":"T1","conclusion":"<what it established>","outcome":"close_done"} '
  + '(outcome: close_done, close_failed, continue with next, or need_user)';

/** @brief 各工具的正确写法（错误的第二行）。 */
const USAGES: Readonly<Record<Exclude<TeamToolName, 'task_handoff'>, string>> = {
  board_read: 'board_read {} for the whole board, {"request":1} for a request, {"task":"T1"} for a task',
  read_session: 'read_session {"task":"T1","role":"executor"}; page with "from" and "to" (turn numbers)',
  agent_message: 'agent_message {"to":"<role>","text":"<message>"} or {"to":"T1","text":"<note for the task>"}',
  request_submit: 'request_submit {"title":"<one line>","goal":"<what it must achieve>"}',
  request_update: 'request_update {"request":1} records this user message; add "quote" for other exact words',
  request_cancel: 'request_cancel {"request":1,"reason":"<why>"}',
  task_create: 'task_create {"request":1,"title":"<one line>","description":"<what to do>","assignee":"<role>",'
    + '"read_only":true}',
  task_edit: 'task_edit {"task":"T1"} hands it back; add "title", "description", "assignee" or "depends_on" to change '
    + 'them',
  reply_via_dialog: 'reply_via_dialog {} when no collaboration is needed',
  request_close: 'request_close {"request":1,"outcome":"done","conclusion":"<what it established>"}',
};

/**
 * @brief 一个工具在这个会话里的正确写法（§6.2 执行时错误的第二行）。
 * @param name 工具名
 * @param kind 会话的种类（task_handoff 在结案会话里写法不同）
 */
export function toolUsage(name: TeamToolName, kind: ToolSessionKind): string {
  if (name === 'task_handoff') return `Correct form: ${kind === 'close' ? CLOSE_HANDOFF_USAGE : TASK_HANDOFF_USAGE}`;
  return `Correct form: ${USAGES[name]}`;
}

/**
 * @brief 执行时错误的文字（§6.2）：第一行原因，第二行正确的写法；原因已经是两行（例如证据不合格）或不是写法错误时原样。
 * @param name 工具名
 * @param kind 会话的种类
 * @param reply 被拒绝的结果
 */
export function errorText(name: TeamToolName, kind: ToolSessionKind,
  reply: Extract<BoardToolReply, { ok: false }>): string {
  return reply.usage ? `${reply.reason}\n${toolUsage(name, kind)}` : reply.reason;
}

// ---- 参数归一（§6.2、§14.6 T-P1） ----

/** @brief 一个参数值按它的名字归一：task 编号、需求编号、依赖、证据与整数。 */
function normalizeValue(name: string, schema: JsonSchema, value: unknown): unknown {
  if (name === 'task') return normalizeTaskId(value) ?? value;
  if (name === 'request') return normalizeRequestNo(value) ?? value;
  if (name === 'depends_on' && Array.isArray(value)) return value.map((item) => normalizeTaskId(item) ?? item);
  if (name === 'evidence' && Array.isArray(value)) {
    return value.map((item) => (typeof item === 'number' && Number.isSafeInteger(item) ? `#${item}` : item));
  }
  if (schema.type === 'integer' && typeof value === 'string' && /^\s*[0-9]+\s*$/.test(value)) return Number(value);
  return value;
}

/**
 * @brief prepareArguments（pi 在参数校验之前调用，§14.6 T-P1）：键名不分大小写、不看 _ 与 -，task_id、taskId 也算 task；
 *        task 编号写作 T3、t3、3 都认，需求编号写作 1、"1"、R1、request 1 都认；证据写成整数时改为 #n；
 *        值为 null 的视为没写；schema 里没有的键丢掉。枚举值不做同义词映射（不合格的由 pi 的校验报错）。
 * @param schema 工具的参数 schema
 * @param raw 模型给的原始参数
 * @return 归一后的参数；原始参数不是对象时原样返回（由 pi 报错）
 */
export function prepareToolArgs(schema: JsonSchema, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const value = argOf(raw, name);
    if (value === undefined || value === null) continue;
    out[name] = normalizeValue(name, property, value);
  }
  return out;
}

// ---- 工具定义 ----

/** @brief pi 的工具结果。 */
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;

/** @brief 把 Team 的结果写成 pi 的工具结果（错误的 isError 为真，§6.2）。 */
function toolResult(name: TeamToolName, kind: ToolSessionKind, reply: BoardToolReply): ToolResult {
  const content = [{ type: 'text' as const, text: reply.ok ? reply.text : errorText(name, kind, reply) }];
  const result: ToolResult = { content, details: { tool: name, ok: reply.ok } };
  if (!reply.ok) result.isError = true;
  if (reply.terminate) result.terminate = true;
  return result;
}

/**
 * @brief 一个 TaskBoard 工具的定义（JSON Schema 参数，§14.6 T-T1）。用户会话里注册为 defaultActive: false，
 *        由 Team 在每次运行开始前按模式启用（§6.3、§14.1）；实例会话由白名单启用。
 * @param name 工具名
 * @param info 会话的种类、角色与全部角色
 * @param executor 执行的一方
 * @param defaultActive 注册时是否启用
 */
export function boardTool(name: TeamToolName, info: ToolSessionInfo, executor: BoardToolExecutor,
  defaultActive: boolean): ToolDefinition {
  const schema = toolSchema(name, info);
  return {
    name,
    label: LABELS[name],
    description: toolDescription(name, info),
    parameters: schema as unknown as ToolDefinition['parameters'],
    prepareArguments: (raw: unknown) => prepareToolArgs(schema, raw) as never,
    defaultActive,
    execute: async (toolCallId, params, signal) => {
      let reply: BoardToolReply;
      try {
        reply = await executor.run(name, params as Record<string, unknown>, { toolCallId, signal });
      } catch (error) {
        console.error(`[kernel] ${name} failed: ${(error as Error).message}`);
        reply = { ok: false, reason: `${name} failed: ${(error as Error).message}`, usage: false };
      }
      return toolResult(name, info.kind, reply);
    },
  };
}

/**
 * @brief 一个会话的 TaskBoard 工具定义，按 §6.3 的顺序（names 里不是 TaskBoard 工具的名字忽略）。
 * @param names 这个会话有的工具名（roles.ts toolAllowlist 的结果，或用户会话的那一组）
 * @param info 会话的种类、角色与全部角色
 * @param executor 执行的一方
 * @param defaultActive 注册时是否启用
 */
export function boardTools(names: readonly string[], info: ToolSessionInfo, executor: BoardToolExecutor,
  defaultActive: boolean): ToolDefinition[] {
  return TEAM_TOOLS.filter((name) => names.includes(name)).map((name) => boardTool(name, info, executor,
    defaultActive));
}

// ---- 交接之后、强制填写的运行里的拒绝（§7.1、§7.5，tool_call 处理器） ----

/** @brief tool_call 处理器判断要用的这次运行的状态。 */
export interface CallGuard {
  /** task 实例这次运行里已经成功交接的 task；没有时为 null */
  handedOff: string | null;
  /** 强制填写的运行里唯一可用的工具（task_handoff，强制关闭为 request_close）；不是强制运行时为 null */
  forcedTool: string | null;
}

/**
 * @brief 交接之后与强制填写的运行里的拒绝（在批准之前，§14.3）：task 实例交接之后这次运行里的每个调用都被拒绝；
 *        强制填写的运行里表单工具之外的调用都被拒绝；两者都带 terminate，这一批之后运行结束（§14.6 T-F6）。
 * @param guard 这次运行的状态
 * @param toolName 被调用的工具
 * @return 拒绝；可以执行时为 undefined
 */
export function guardToolCall(guard: CallGuard, toolName: string): ToolCallEventResult | undefined {
  if (guard.handedOff !== null) {
    return { block: true, reason: `You handed off ${guard.handedOff}; stop here.`, terminate: true };
  }
  if (guard.forcedTool !== null && toolName !== guard.forcedTool) {
    return { block: true, reason: `Only ${guard.forcedTool} works in this turn; call it now.`, terminate: true };
  }
  return undefined;
}
