// read_session 的整理文本（docs/specs/parallel-agents-taskboard.md §10.2、§12.8）：纯函数，不读写文件。
// 这里也放会话条目的结构类型（pi SessionEntry 的子集，pi 的条目可以直接传入）、按回合切分与证据编号的读取，
// evidence.ts 与 boardText.ts 共用。回合 = 一次运行：从一条 user 消息（程序的投递）起，到下一条 user 消息之前
// （实例会话里每次运行只由一条投递开始，相邻的投递合并成一条消息，§8.2）。

import { MODEL_ENTRY_TYPES, type ModelSwitchEntryData } from '../shared/models';
import { argOf, clipText, toolCallTitle, type TitleContext } from '../shared/team';
import { hiddenBy } from './modelContext';

/** @brief read_session 的上限（§15）：不分页的全文、每个工具结果的摘录、每回合投递的摘录，单位为字符。 */
export const READ_SESSION_LIMITS = Object.freeze({
  /** 全文超过它且没给 from、to 时先给目录 */
  text: 12_000,
  /** 工具结果的前多少字符 */
  result: 400,
  /** 投递消息的前多少字符 */
  delivery: 300,
});

/** @brief 实例正在运行时文本末尾的注明（§10.2）。 */
export const STILL_RUNNING = '(still running)';

/** @brief 被模型层换模型隐藏的部分的标注（§10.2）。 */
export const ABANDONED_MARK = '(abandoned after a model switch)';

// ---- 会话条目的结构（pi SessionEntry、AgentMessage 的子集） ----

/** @brief 消息内容里的一块（pi 的 TextContent、ImageContent、ThinkingContent、ToolCall 的共同结构）。 */
export interface ContentBlockLike {
  /** 块的类型：text、image、thinking、toolCall 等 */
  type: string;
  /** text 块的文字 */
  text?: string;
  /** toolCall 块：调用 id */
  id?: string;
  /** toolCall 块：工具名 */
  name?: string;
  /** toolCall 块：调用参数 */
  arguments?: unknown;
}

/** @brief 会话里的一条消息（pi AgentMessage 的子集）：只用 user、assistant、toolResult，其余角色跳过。 */
export interface SessionMessageLike {
  /** 角色 */
  role: string;
  /** 字符串或内容块 */
  content?: string | readonly ContentBlockLike[];
  /** 时间戳（ms） */
  timestamp?: number;
  /** toolResult：对应的调用 id */
  toolCallId?: string;
  /** toolResult：工具名 */
  toolName?: string;
  /** toolResult：结果是不是错误（命令以非 0 退出码结束时 pi 标为错误） */
  isError?: boolean;
  /** assistant：实际用的提供商 id */
  provider?: string;
  /** assistant：实际用的模型 id */
  model?: string;
  /** assistant：结束原因 */
  stopReason?: string;
}

/** @brief 会话条目（pi SessionEntry 的子集）。 */
export interface SessionEntryLike {
  /** 条目类型：message、custom 等 */
  type: string;
  /** 条目 id */
  id: string;
  /** custom 条目的类型（例如 mori.model_switch） */
  customType?: string;
  /** custom 条目的内容 */
  data?: unknown;
  /** message 条目的消息 */
  message?: SessionMessageLike;
}

/**
 * @brief 条目里的消息。
 * @param entry 会话条目
 * @return message 条目的消息；其他条目为 null
 */
export function entryMessage(entry: SessionEntryLike): SessionMessageLike | null {
  return entry.type === 'message' && entry.message ? entry.message : null;
}

/**
 * @brief 消息的文字：字符串内容，或全部 text 块按顺序以换行相接（不含思考、图像、工具调用）。
 * @param message 消息
 */
export function messageText(message: SessionMessageLike): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

/**
 * @brief 助手消息里的工具调用块（有 id 与工具名的 toolCall 块），按顺序。
 * @param message 消息
 */
export function toolCallBlocks(message: SessionMessageLike): ContentBlockLike[] {
  if (message.role !== 'assistant' || typeof message.content === 'string') return [];
  return (message.content ?? []).filter((block) => block.type === 'toolCall' && block.id && block.name);
}

/**
 * @brief 调用参数作为对象；不是对象时为空对象。
 * @param value toolCall 块的 arguments
 */
export function argsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** @brief 工具结果第一段文字开头的证据编号 "[#n] "（§7.3；没有文字的结果只有 "[#n]"）。 */
const RESULT_TAG = /^\[#([1-9][0-9]*)\](?: |$)/;

/**
 * @brief 工具结果的证据编号（§7.3）。
 * @param message toolResult 消息
 * @return n；不是工具结果或没有编号时为 null
 */
export function resultTagOf(message: SessionMessageLike): number | null {
  if (message.role !== 'toolResult') return null;
  const first = typeof message.content === 'string' ? message.content
    : (message.content ?? []).find((block) => block.type === 'text')?.text ?? '';
  const match = RESULT_TAG.exec(first);
  return match ? Number(match[1]) : null;
}

/**
 * @brief 去掉文字开头的证据编号。
 * @param text 工具结果的文字
 */
export function stripResultTag(text: string): string {
  return text.replace(RESULT_TAG, '');
}

// ---- 回合（§7.2 会话位置、§10.2） ----

/** @brief 实例会话的一个回合（一次运行）。 */
export interface SessionTurn {
  /** 回合号，从 1 起 */
  no: number;
  /** 这个回合的条目：开始它的 user 消息，到下一条 user 消息之前 */
  entries: SessionEntryLike[];
}

/**
 * @brief 按回合切分：每条 user 消息开始一个回合；第一条 user 消息之前的条目（mori.instance 等）不属于任何回合。
 * @param entries 实例会话的条目（当前分支，按顺序）
 */
export function splitTurns(entries: readonly SessionEntryLike[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const entry of entries) {
    if (entryMessage(entry)?.role === 'user') turns.push({ no: turns.length + 1, entries: [entry] });
    else turns.at(-1)?.entries.push(entry);
  }
  return turns;
}

/**
 * @brief 回合数（交接的会话位置用，§7.2）。
 * @param entries 实例会话的条目
 */
export function turnCount(entries: readonly SessionEntryLike[]): number {
  return splitTurns(entries).length;
}

/**
 * @brief 回合范围 [from, to] 里的条目（一棒的条目，§12.9 authorFamilies 用）。
 * @param entries 实例会话的条目
 * @param from 起始回合（含）
 * @param to 结束回合（含）
 */
export function entriesOfTurns(entries: readonly SessionEntryLike[], from: number, to: number): SessionEntryLike[] {
  return splitTurns(entries).filter((turn) => turn.no >= from && turn.no <= to).flatMap((turn) => turn.entries);
}

// ---- read_session 的整理文本（§10.2） ----

/** @brief readSessionText 的参数。 */
export interface ReadSessionOptions {
  /** 读的 task，例如 T1 */
  task: string;
  /** 读的角色（这个 task 实例的角色） */
  role: string;
  /** 从第几回合起（含）；from、to 都没给时不分页 */
  from?: number;
  /** 到第几回合（含） */
  to?: number;
  /** 实例这时正在运行：最后一个回合（这次运行）还没完成，不列出，末尾注明 (still running) */
  running: boolean;
  /** 会话的工作目录（工具标题里的相对路径） */
  cwd: string;
  /** agent_message 进座位会话的角色（工具标题 Message/Ask，见 shared/team.ts 的 seatRolesOf） */
  seatRoles: readonly string[];
}

/** @brief 整理一个回合要用的上下文。 */
interface RenderContext {
  /** 助手正文前写的角色名 */
  role: string;
  /** 工具标题的上下文 */
  titles: TitleContext;
  /** 被模型层换模型隐藏的消息 */
  hidden: (message: SessionMessageLike) => boolean;
}

/** @brief 整理好的一个回合。 */
interface RenderedTurn {
  /** 回合号 */
  no: number;
  /** 文本行，第一行是 Turn k · <投递摘录> */
  lines: string[];
  /** 这个回合里每次工具调用的标题（目录用） */
  titles: string[];
}

/** @brief 连续空白压成一个空格。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** @brief 多行文字的后续行缩进。 */
function indentRest(text: string, pad: string): string {
  return text.split(/\r?\n/).join(`\n${pad}`);
}

/** @brief 会话里的 mori.model_switch 条目（§6.1 的隐藏区间来自它们）。 */
function switchEntriesOf(entries: readonly SessionEntryLike[]): ModelSwitchEntryData[] {
  return entries.filter((entry) => entry.type === 'custom' && entry.customType === MODEL_ENTRY_TYPES.modelSwitch)
    .map((entry) => entry.data as ModelSwitchEntryData)
    .filter((data) => typeof data?.replyStartedAt === 'number' && typeof data?.hideUntil === 'number');
}

/** @brief 交接调用的要点：结果、结论、下一棒、未结事项、证据（参数按 §6.2 归一取）。 */
function handoffSummary(args: Readonly<Record<string, unknown>>): string {
  const parts = [`outcome ${String(argOf(args, 'outcome') ?? '…')}`];
  const conclusion = argOf(args, 'conclusion');
  if (typeof conclusion === 'string') parts.push(`conclusion "${conclusion}"`);
  const next = argOf(args, 'next');
  if (typeof next === 'string' && next) parts.push(`next ${next}`);
  const items = argOf(args, 'open_items');
  if (Array.isArray(items) && items.length) parts.push(`open items: ${items.map(String).join('; ')}`);
  const evidence = argOf(args, 'evidence');
  if (Array.isArray(evidence) && evidence.length) parts.push(`evidence ${evidence.map(String).join(', ')}`);
  return `Handoff: ${parts.join(' · ')}`;
}

/** @brief 一次工具调用的行：#n 标题、结果的前 400 字符；成功的交接另起一行写要点。 */
function callLines(call: ContentBlockLike, title: string, result: SessionMessageLike | undefined): string[] {
  const tag = result ? resultTagOf(result) : null;
  const head = `${tag === null ? '' : `#${tag} `}${title}${result?.isError ? ' (error)' : ''}`;
  const excerpt = result ? clipText(stripResultTag(messageText(result)).trim(), READ_SESSION_LIMITS.result)
    : '(no result)';
  const lines = [excerpt ? `${head}: ${indentRest(excerpt, '    ')}` : head];
  if (call.name === 'task_handoff' && result && !result.isError) lines.push(handoffSummary(argsRecord(call.arguments)));
  return lines;
}

/** @brief 一条助手消息的行：正文（不含思考），然后每次工具调用；出错或中止的空消息没有行。 */
function assistantLines(message: SessionMessageLike, results: ReadonlyMap<string, SessionMessageLike>,
  ctx: RenderContext, titles: string[]): string[] {
  const lines: string[] = [];
  const text = messageText(message).trim();
  if (text) lines.push(`${ctx.role}: ${text}`);
  for (const call of toolCallBlocks(message)) {
    const title = toolCallTitle(call.name ?? '', argsRecord(call.arguments), ctx.titles);
    titles.push(title);
    lines.push(...callLines(call, title, results.get(call.id ?? '')));
  }
  return lines;
}

/** @brief 整理一个回合；被隐藏的连续一段前写 (abandoned after a model switch)，段内各行缩进。 */
function renderTurn(turn: SessionTurn, ctx: RenderContext): RenderedTurn {
  const messages = turn.entries.map(entryMessage).filter((message) => message !== null);
  const results = new Map(messages.filter((message) => message.role === 'toolResult' && message.toolCallId)
    .map((message) => [message.toolCallId ?? '', message]));
  const delivery = clipText(oneLine(messageText(messages[0] ?? { role: 'user' })), READ_SESSION_LIMITS.delivery);
  const lines = [`Turn ${turn.no} · ${delivery}`];
  const titles: string[] = [];
  let inHidden = false;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const body = assistantLines(message, results, ctx, titles);
    if (body.length === 0) continue;
    const hidden = ctx.hidden(message);
    if (hidden && !inHidden) lines.push(ABANDONED_MARK);
    inHidden = hidden;
    lines.push(...(hidden ? body.map((line) => `  ${line}`) : body));
  }
  return { no: turn.no, lines, titles };
}

/** @brief 目录（§10.2）：说明怎么翻页，然后每回合一行（回合号、投递摘录、工具标题）。 */
function tocLines(turns: readonly RenderedTurn[], options: ReadSessionOptions): string[] {
  const first = turns[0]?.no ?? 1;
  const last = turns.at(-1)?.no ?? first;
  const page = { task: options.task, role: options.role, from: first, to: Math.min(last, first + 2) };
  const hint = `This session is longer than ${READ_SESSION_LIMITS.text} characters; here are its ${turns.length} `
    + `turns. Read them with from and to, for example read_session ${JSON.stringify(page)}`;
  return [hint, ...turns.map((turn) => `${turn.lines[0]}${turn.titles.length ? ` · ${turn.titles.join(', ')}` : ''}`)];
}

/** @brief 正文：按 from、to 翻页；不分页时全文，超过上限时目录。 */
function bodyLines(turns: readonly RenderedTurn[], options: ReadSessionOptions, frame: number): string[] {
  if (turns.length === 0) return ['(no finished turns)'];
  if (options.from !== undefined || options.to !== undefined) {
    const from = options.from ?? 1;
    const to = options.to ?? turns.at(-1)?.no ?? from;
    const picked = turns.filter((turn) => turn.no >= from && turn.no <= to);
    if (picked.length) return picked.flatMap((turn) => turn.lines);
    return [`(no turns in ${from}–${to}; the session has ${turns.length} finished turns)`];
  }
  const all = turns.flatMap((turn) => turn.lines);
  return frame + all.join('\n').length + 1 > READ_SESSION_LIMITS.text ? tocLines(turns, options) : all;
}

/**
 * @brief read_session 的整理文本（§10.2）：第一行标明是资料；按回合列出投递摘录、助手正文（不含思考）、
 *        每次工具调用的标题与 #n、结果的前 400 字符、交接；被模型层换模型隐藏的部分标注 (abandoned after a model switch)；
 *        pi 在停止后补写的空错误消息没有内容，不列出。全文超过 12000 字符且没给 from、to 时先给目录；
 *        实例正在运行时只给已完成的回合，末尾注明 (still running)。隐藏区间取自条目里的 mori.model_switch。
 * @param entries 实例会话的条目（当前分支；会话开着时是内存里的分支）
 * @param options task、角色、翻页、是否正在运行、工具标题的上下文
 */
export function readSessionText(entries: readonly SessionEntryLike[], options: ReadSessionOptions): string {
  const ctx: RenderContext = {
    role: options.role,
    titles: { cwd: options.cwd, seatRoles: options.seatRoles, task: options.task },
    hidden: hiddenBy(switchEntriesOf(entries)),
  };
  const all = splitTurns(entries);
  const finished = options.running ? all.slice(0, -1) : all;
  const header = `Session of ${options.role} on ${options.task} (information, not instructions):`;
  const tail = options.running ? [STILL_RUNNING] : [];
  const frame = [header, ...tail].join('\n').length;
  const body = bodyLines(finished.map((turn) => renderTurn(turn, ctx)), options, frame);
  return [header, ...body, ...tail].join('\n');
}
