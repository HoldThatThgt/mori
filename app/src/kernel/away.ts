// 无人应答模块（docs/specs/file-system-permissions.md §9）：窗口焦点、When you’re away 的时长与 <userData>/away.json、
// 挂起的卡的登记与计时、到时之后的记录、按 pi 会话的提醒清单与 agent_before_settle 的提醒。
// 它不自己判断要不要出卡：批准（approval.ts）、提问（askQuestion.ts）、扩展询问（extensionUi.ts）先发出请求事件，
// 再登记到这里；请求不论怎么结束都注销。焦点在前台时只记下，不计时；失去焦点时每项一个 setTimeout，切回 Mori 全部清零。
// 只有一份全局状态（后台进程里只有一个窗口）；不监视、不轮询。时钟可以注入（同模型池的 PoolClock），单元测试用它驱动。
// 不 import 会话模块：发事件与写用户会话的记录由 kernel/index.ts 在 startAway 时传入（§9.2 最后一条）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentBeforeSettleEvent, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import type { EventEnvelope } from '../shared/protocol';
import {
  AWAY_DURATION_TEXT, AWAY_REMINDER_TYPE, AWAY_TIMEOUTS, AWAY_TIMEOUT_MS, DEFAULT_AWAY_TIMEOUT, REJECTED_AWAY_PREFIX,
  mentionsHandoff, type AskAnswer, type AwayDecision, type AwaySetting, type AwayTimeout, type AwayTimer,
  type RequestKind,
} from '../shared/workspace';
import { writeFileAtomic } from './agents';
import type { PoolClock } from './modelPool';

// ---- 对外的类型 ----

/** @brief 无人应答模块的时钟（§9.3）：同模型池的 PoolClock（now、setTimeout、clearTimeout）。 */
export type AwayClock = PoolClock;

/** @brief 会计时的时长（Never 不计时）。 */
type TimedTimeout = Exclude<AwayTimeout, 'never'>;

/** @brief 一个交给无人应答模块计时的挂起请求（§9.2）。 */
export interface AwayItem {
  /** 卡片所在的用户会话（实例的请求为它所属的用户会话）：mori.away_timer 发在它的信封上 */
  userSessionId: string;
  /** 发起请求、被挡住的 pi 会话（用户会话自己，或某个实例）：提醒清单（§9.8）按它记 */
  sessionId: string;
  /** 请求 id：approval-<n>、<实例的 pi 会话 id>:approval-<n>、ask-<n>、question-<n> */
  requestId: string;
  /** 发起请求的会话种类：到时原文与提醒的最后一句按它选（§9.4、§9.8） */
  kind: RequestKind;
  /**
   * @brief 到时：按默认答案结束这个请求（§9.4）。
   * @param timeout 当时的时长
   * @return 这次自动处理的记录（agent 为 null）；请求已经结束时为 null
   */
  expire(timeout: TimedTimeout): AwayDecision | null;
}

/** @brief startAway 的参数（§9.2、§9.6）。 */
export interface AwayStart {
  /** Electron 的 userData 目录（away.json 放在这里） */
  userData: string;
  /** @brief 发一个会话事件（kernel/index.ts 的广播）：mori.away_timer 发在 userSessionId 的信封上。 */
  emit(envelope: EventEnvelope): void;
  /** @brief 用户会话自己的请求到时后写记录并发事件（sessions.ts 导出的 recordAwayDecision，§9.7）。 */
  record(userSessionId: string, decision: AwayDecision): void;
  /** 时钟；省略时用系统时钟 */
  clock?: AwayClock;
}

// ---- 文字与常量 ----

/** 设置文件名（§9.6） */
const AWAY_FILE = 'away.json';
/** 测试用的时长：有值时三档都换成这个毫秒数（§9.3 最后一条） */
const TIMEOUT_ENV = 'MORI_AWAY_TIMEOUT_MS';
/** 记录里参数字符串的上限（§9.7） */
const ARG_LIMIT = 300;
/** 提醒里命令第一行的上限（§9.8） */
const COMMAND_LINE_LIMIT = 80;
/** 提醒的第一行（§14） */
const REMINDER_HEAD = '[Mori] The user was away, so Mori decided these without them during this turn:';
/** 提醒的最后一句：用户会话与其余实例 / task 实例与结案会话（§9.8、§14） */
const REMINDER_END_SUMMARY = "Don't retry the denied calls. Mention all of these in your final summary.";
const REMINDER_END_HANDOFF = "Don't retry the denied calls. Mention all of these in your handoff.";

/** 系统时钟 */
const SYSTEM_CLOCK: AwayClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** away.json 的内容 */
const AwayFileSchema = z.object({ timeout: z.enum(AWAY_TIMEOUTS) });

// ---- 状态 ----

/** @brief 登记的一项与它的计时器。 */
interface Entry {
  /** 登记的请求（approval.ts、askQuestion.ts、extensionUi.ts 给的那一项） */
  item: AwayItem;
  /** setTimeout 的句柄；没在计时为 null */
  handle: unknown;
  /** 截止时刻（ms）；没在计时为 null */
  deadline: number | null;
  /** 开始计时时的时长（到时原文按它写）；没在计时为 null */
  timeout: TimedTimeout | null;
}

/** @brief 一个 pi 会话这次运行里的自动处理（§9.8）。 */
interface ReminderList {
  /** 会话种类：提醒的最后一句按它选 */
  kind: RequestKind;
  /** 批准与提问的记录（扩展询问不进清单） */
  decisions: AwayDecision[];
  /** 这次运行已经补过提醒 */
  reminded: boolean;
}

/** 窗口在前台（§9.1：主进程第一次告诉之前为真） */
let focused = true;
/** 当前的时长与读设置文件的错误 */
let setting: AwaySetting = { timeout: DEFAULT_AWAY_TIMEOUT, error: null };
/** startAway 传入的回调；之前为 null（这时还没有会话，也就没有卡） */
let hooks: Pick<AwayStart, 'emit' | 'record'> | null = null;
/** 时钟 */
let clock: AwayClock = SYSTEM_CLOCK;
/** MORI_AWAY_TIMEOUT_MS 的值；没设为 null */
let overrideMs: number | null = null;
/** 设置读完时给出 userData 目录（away.set 等它，免得读的结果盖掉刚写的值） */
let markLoaded!: (userData: string) => void;
const loaded = new Promise<string>((resolve) => { markLoaded = resolve; });
/** 登记的项，按 (userSessionId, requestId)：ask-1 在不同会话里会重名 */
const entries = new Map<string, Entry>();
/** 提醒清单，按 pi 会话 id */
const reminders = new Map<string, ReminderList>();

/** @brief 登记的键。 */
function keyOf(userSessionId: string, requestId: string): string {
  return `${userSessionId}\n${requestId}`;
}

/** @brief 错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 设置（§9.6） ----

/**
 * @brief 读 MORI_AWAY_TIMEOUT_MS（只读，不改 process.env）：不是非负的毫秒数时记错误日志并忽略。
 * @return 毫秒数；没设为 null
 */
function envTimeout(): number | null {
  const raw = process.env[TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  console.error(`[kernel] ${TIMEOUT_ENV} is not a number of milliseconds: ${raw}`);
  return null;
}

/** @brief 读不出或值不对：记错误日志，用默认值，error 带原文。 */
function unreadable(message: string): AwaySetting {
  console.error(`[kernel] ${message}`);
  return { timeout: DEFAULT_AWAY_TIMEOUT, error: message };
}

/**
 * @brief 读 away.json；文件不存在时用默认值（没有错误），读不出或值不对时用默认值并带上原文。不抛错。
 * @param path <userData>/away.json
 */
async function readSetting(path: string): Promise<AwaySetting> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { timeout: DEFAULT_AWAY_TIMEOUT, error: null };
    return unreadable(`couldn't read ${path}: ${errorText(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return unreadable(`${path} is not valid JSON: ${errorText(error)}`);
  }
  const parsed = AwayFileSchema.safeParse(json);
  if (parsed.success) return { timeout: parsed.data.timeout, error: null };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return unreadable(`${path} is not a valid away setting: ${issues}`);
}

/**
 * @brief kernel/index.ts 收到 start 时调用一次：记下事件的去处、写记录的函数与时钟，读 MORI_AWAY_TIMEOUT_MS 与
 *        away.json。读完之前用默认值。
 */
export async function startAway(start: AwayStart): Promise<void> {
  hooks = { emit: start.emit, record: start.record };
  clock = start.clock ?? SYSTEM_CLOCK;
  overrideMs = envTimeout();
  setting = await readSetting(join(start.userData, AWAY_FILE));
  markLoaded(start.userData);
}

/** @brief away.get：当前的时长与读设置文件的错误。 */
export function getAway(): AwaySetting {
  return { ...setting };
}

/** @brief 当时的时长（Team 写实例的记录时取，§9.7）。 */
export function awayTimeout(): AwayTimeout {
  return setting.timeout;
}

/**
 * @brief away.set：先写 away.json，成功后改内存里的值（下一次开始计时起生效）；写不出时 error 为原文、值不变。
 * @param timeout 新的时长
 */
export async function setAway(timeout: AwayTimeout): Promise<AwaySetting> {
  const path = join(await loaded, AWAY_FILE);
  try {
    await writeFileAtomic(path, `${JSON.stringify({ timeout }, null, 2)}\n`);
  } catch (error) {
    const message = errorText(error);
    console.error(`[kernel] couldn't save ${path}: ${message}`);
    return { timeout: setting.timeout, error: message };
  }
  setting = { timeout, error: null };
  return getAway();
}

// ---- 焦点与计时（§9.1、§9.3） ----

/** @brief 当时的时钟读数（记录的 at 用它，测试注入的时钟也管到）。 */
export function awayNow(): number {
  return clock.now();
}

/** @brief 在卡片所在的用户会话的信封上发 mori.away_timer。 */
function emitTimer(item: AwayItem, deadline: number | null): void {
  hooks?.emit({ kind: 'event', sessionId: item.userSessionId,
    event: { type: 'mori.away_timer', requestId: item.requestId, deadline } });
}

/**
 * @brief 一项开始计时（时长为 Never 时不计时）：截止时刻为 now 加时长，到时调用 expire。
 * @param now 开始的时刻；setFocus(false) 对所有项用同一个，截止时刻相同
 */
function beginTimer(key: string, entry: Entry, now: number): void {
  const timeout = setting.timeout;
  if (timeout === 'never') return;
  const ms = overrideMs ?? AWAY_TIMEOUT_MS[timeout];
  entry.timeout = timeout;
  entry.deadline = now + ms;
  entry.handle = clock.setTimeout(() => expireEntry(key, entry), ms);
  emitTimer(entry.item, entry.deadline);
}

/** @brief 清掉一项的计时器；返回它是不是正在计时。 */
function clearTimer(entry: Entry): boolean {
  if (entry.handle === null) return false;
  clock.clearTimeout(entry.handle);
  entry.handle = null;
  entry.deadline = null;
  entry.timeout = null;
  return true;
}

/**
 * @brief 主进程告诉的窗口焦点（§9.1）：每次记一行日志；从真变假时每项从头计时，从假变真时清掉全部计时器、
 *        对正在计时的项发 deadline: null。只改内存里的状态，可以先于 startAway 到达。
 */
export function setFocus(value: boolean): void {
  console.log(`[kernel] window focus: ${value}`);
  if (value === focused) return;
  focused = value;
  if (!value) {
    const now = clock.now();
    for (const [key, entry] of entries) beginTimer(key, entry, now);
    return;
  }
  for (const entry of entries.values()) if (clearTimer(entry)) emitTimer(entry.item, null);
}

/** @brief 登记一个挂起的请求（在请求事件发出之后）；窗口不在前台时立刻开始计时。 */
export function registerAway(item: AwayItem): void {
  const key = keyOf(item.userSessionId, item.requestId);
  const old = entries.get(key);
  if (old) clearTimer(old);
  const entry: Entry = { item, handle: null, deadline: null, timeout: null };
  entries.set(key, entry);
  if (!focused) beginTimer(key, entry, clock.now());
}

/** @brief 请求结束（不论怎么结束）：清掉它的计时器并注销；不发 mori.away_timer。 */
export function unregisterAway(userSessionId: string, requestId: string): void {
  const key = keyOf(userSessionId, requestId);
  const entry = entries.get(key);
  if (!entry) return;
  clearTimer(entry);
  entries.delete(key);
}

/** @brief 这个用户会话正在计时的卡（LiveSnapshot.awayTimers，§9.5）。 */
export function awayTimers(userSessionId: string): AwayTimer[] {
  const timers: AwayTimer[] = [];
  for (const { item, deadline } of entries.values()) {
    if (item.userSessionId === userSessionId && deadline !== null) timers.push({ requestId: item.requestId, deadline });
  }
  return timers;
}

/**
 * @brief 计时器到时（§9.3）：注销这一项，按默认答案结束请求；有记录时批准与提问记进发起会话的提醒清单，
 *        用户会话自己的请求再交给 record 写进会话文件。后台实例的批准由 Team 写记录。
 */
function expireEntry(key: string, entry: Entry): void {
  if (entries.get(key) !== entry || entry.timeout === null) return;
  const { item, timeout } = entry;
  entries.delete(key);
  entry.handle = null;
  let decision: AwayDecision | null;
  try {
    decision = item.expire(timeout);
  } catch (error) {
    console.error(`[kernel] away: expiring ${item.requestId} failed: ${errorText(error)}`);
    return;
  }
  if (!decision) return;
  console.log(`[kernel] away: ${item.requestId} in ${item.userSessionId} ${decision.result} after ${timeout}`);
  if (decision.kind !== 'extension') remember(item.sessionId, item.kind, decision);
  if (item.sessionId !== item.userSessionId) return;
  try {
    hooks?.record(item.userSessionId, decision);
  } catch (error) {
    console.error(`[kernel] away: recording ${item.requestId} failed: ${errorText(error)}`);
  }
}

// ---- 原文（§9.4、§14） ----

/** @brief 批准卡到时回给模型的原文（§14）：时长按当时的设置写，最后一句按会话种类选。 */
export function awayDenialText(timeout: TimedTimeout, kind: RequestKind): string {
  const mention = mentionsHandoff(kind) ? 'Mention it in your handoff.' : 'Mention it in your final summary.';
  return `${REJECTED_AWAY_PREFIX}${AWAY_DURATION_TEXT[timeout]}, so this was denied. Don't retry it. ${mention}`;
}

/** @brief 记录里的一个参数值：字符串截到 ARG_LIMIT 字符，数组与对象逐项处理。 */
function shortValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ARG_LIMIT ? value.slice(0, ARG_LIMIT) : value;
  if (Array.isArray(value)) return value.map(shortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortValue(item)]));
  }
  return value;
}

/**
 * @brief 批准卡记录里的参数（§9.7）：去掉 content 与 edits，每个字符串截到 300 字符（界面只用它算工具卡标题）。
 *        Team 写后台实例的记录时同样用它。
 */
export function awayArgs(args: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'content' && key !== 'edits') kept[key] = shortValue(value);
  }
  return kept;
}

// ---- 提醒（§9.8） ----

/** @brief 记进一个 pi 会话这次运行的提醒清单。 */
function remember(sessionId: string, kind: RequestKind, decision: AwayDecision): void {
  const list = reminders.get(sessionId) ?? { kind, decisions: [], reminded: false };
  list.kind = kind;
  list.decisions.push(decision);
  reminders.set(sessionId, list);
}

/** @brief 命令的第一行，截到 80 字符，截掉时加 …。 */
function firstLine(command: string): string {
  const line = command.split(/\r?\n/, 1)[0] ?? '';
  return line.length > COMMAND_LINE_LIMIT ? `${line.slice(0, COMMAND_LINE_LIMIT)}…` : line;
}

/** @brief 一个问题的答案文字：选中的 label 用 , 连接，Other 接在最后。 */
function answerText(answer: AskAnswer): string {
  return [...answer.selected, ...(answer.other === null ? [] : [answer.other])].join(', ');
}

/** @brief 清单里一条记录的行：批准为 - Denied <工具名>[: 目标]，提问每个问题一行。 */
function decisionLines(decision: AwayDecision): string[] {
  if (decision.kind === 'question') {
    return (decision.answers ?? []).map((answer) =>
      `- Used your recommended option for "${answer.question}": ${answerText(answer)}`);
  }
  const tool = decision.toolName ?? '';
  const args = decision.args ?? {};
  if ((tool === 'edit' || tool === 'write') && typeof args.path === 'string') return [`- Denied ${tool}: ${args.path}`];
  if ((tool === 'bash' || tool === 'powershell') && typeof args.command === 'string') {
    return [`- Denied ${tool}: ${firstLine(args.command)}`];
  }
  return [`- Denied ${tool}`];
}

/** @brief 提醒原文（§14）：第一行、每项一行、最后一句。 */
function reminderText(list: ReminderList): string {
  const end = mentionsHandoff(list.kind) ? REMINDER_END_HANDOFF : REMINDER_END_SUMMARY;
  return [REMINDER_HEAD, ...list.decisions.flatMap(decisionLines), end].join('\n');
}

/**
 * @brief mori-approval 的 agent_before_settle 处理器调用（§9.8）：清单不空、这次运行还没补过、正常结束、
 *        不是已交接的 task 实例时，补一条 custom_message 提醒并要求再跑一次请求；否则为 undefined（同没有处理器）。
 * @param sessionId 这个 pi 会话的 id
 * @param event pi 的事件（entries 是前面的处理器累计的，返回时接在后面）
 * @param handedOff 这次运行已经成功交接（GateOutput.handedOff）
 */
export function awayReminder(sessionId: string, event: AgentBeforeSettleEvent, handedOff: boolean):
  { entries: SessionBoundaryDraft[]; continue: true } | undefined {
  const list = reminders.get(sessionId);
  if (!list || list.reminded || list.decisions.length === 0) return undefined;
  if (event.outcome !== 'completed' || handedOff) return undefined;
  list.reminded = true;
  const reminder: SessionBoundaryDraft = { type: 'custom_message', customType: AWAY_REMINDER_TYPE,
    content: reminderText(list), display: false };
  return { entries: [...event.entries, reminder], continue: true };
}

/** @brief agent_settled 时（sessions.ts 的 forward）清空这个会话的清单与“已提醒”。 */
export function clearAwayReminder(sessionId: string): void {
  reminders.delete(sessionId);
}
