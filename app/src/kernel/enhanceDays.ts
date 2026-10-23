// 增强任务的日子、会话片段与 token 数（docs/specs/memory.md §9.1–§9.3、§9.5、§9.6、§12）：纯函数，不读写文件，
// 现在的时刻都由参数给出（单元测试用注入的时钟）。
// 日子按这个项目的每日时刻划分，用本地时间（§9.2，夏令时照本地时间算，不另处理）。
// 会话文件按物理行读：原文 split('\n')，行号从 1 开始（与 pi read 工具的 offset 相同），第 1 行是头；
// 空行和解析不了的行算进行号，但不当作条目（pi parseSessionEntries 跳过的就是这些行）。
// token 数按 pi getSessionStats 的累加规则照写（pi 1.3.0 dist/core/agent-session.js:3416-3470，没有导出，升级 pi 时复查）。

import { ENHANCE_TASKS, localDate, MEMORY_DEFAULTS, type EnhanceTask } from '../shared/memory';

/** @brief 日子 `YYYY-MM-DD`（§1），按这个项目的每日时刻划分（§9.2）。 */
export type DayKey = string;

/** 每日时刻的写法 `HH:MM`（24 小时制） */
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
/** 日子的写法 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 没有会话名、也没有用户消息时的会话名（与 shared/memory.ts evidenceLine 的写法相同） */
const UNTITLED = 'Untitled session';

// ---- 日子（§9.2、§9.3） ----

/** @brief `HH:MM` → [时, 分]；写法不对时抛错。 */
function parseTime(time: string): [number, number] {
  const match = TIME_PATTERN.exec(time);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new Error(`Invalid time of day: ${time}`);
  return [hours, minutes];
}

/** @brief `YYYY-MM-DD` → [年, 月, 日]；写法不对时抛错。 */
function parseDay(day: DayKey): [number, number, number] {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`Invalid day: ${day}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @brief 日历上前后挪几天（按日历日期算，与时区、夏令时无关）。
 * @param day 日子
 * @param n 天数，可以为负
 */
export function addDays(day: DayKey, n: number): DayKey {
  const [year, month, date] = parseDay(day);
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

/**
 * @brief 日子 D 开始的时刻（ms）：本地时间 D 的 `time`（§9.2）。D 结束的时刻就是 D+1 开始的时刻。
 * @param day 日子 D
 * @param time 这个项目的每日时刻 `HH:MM`
 */
export function dayStart(day: DayKey, time: string): number {
  const [year, month, date] = parseDay(day);
  const [hours, minutes] = parseTime(time);
  return new Date(year, month - 1, date, hours, minutes).getTime();
}

/**
 * @brief 时刻属于的日子（§9.2）：t 属于 D，当 D 的 `time` ≤ t < D+1 的 `time`（本地时间）。
 *        例：`04:00` 时 10-23 03:00 属于 10-22。“今天” = 现在属于的日子。
 * @param ms 时刻（ms）
 * @param time 这个项目的每日时刻 `HH:MM`
 */
export function dayOf(ms: number, time: string): DayKey {
  const calendar = localDate(ms);
  return ms < dayStart(calendar, time) ? addDays(calendar, -1) : calendar;
}

/**
 * @brief 一个任务该跑的日子（§9.3）：`doneThrough` 之后、今天之前的每一天，`since` 之前的不跑；从早到晚。
 *        失败的日子之后这一轮不跑（§9.4）由队列决定，不在这里。
 * @param doneThrough 这个任务处理完的最后一天；没有时从 `since` 起
 * @param since 打开增强的那天
 * @param today 今天
 */
export function dueDays(doneThrough: DayKey | null, since: DayKey, today: DayKey): DayKey[] {
  parseDay(since);
  parseDay(today);
  const next = doneThrough === null ? since : addDays(doneThrough, 1);
  const days: DayKey[] = [];
  for (let day = next < since ? since : next; day < today; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * @brief 现在之后的下一个每日时刻（ms，严格晚于现在），定时器设在这里（§9.3）。
 * @param now 现在（ms）
 * @param time 这个项目的每日时刻 `HH:MM`
 */
export function nextBoundary(now: number, time: string): number {
  const calendar = localDate(now);
  const boundary = dayStart(calendar, time);
  return boundary > now ? boundary : dayStart(addDays(calendar, 1), time);
}

/** @brief 改每日时刻时要调整的值（§9.1）。 */
export interface RetimeInput {
  /** 打开增强的那天 */
  since: DayKey;
  /** 三个任务各自处理完的最后一天 */
  doneThrough: Record<EnhanceTask, DayKey>;
  /** 新的每日时刻 `HH:MM` */
  newTime: string;
  /** 现在（ms） */
  now: number;
}

/**
 * @brief 改了每日时刻（§9.1、§12）：按新的时刻重新算今天；每个任务的 `doneThrough` 晚于新的今天的前一天时改为它，
 *        `since` 晚于新的今天时改为新的今天。之前读过的部分由水位与 `feedbackSeen` 跳过，不在这里处理。
 * @param input 现有的值、新的时刻与现在
 */
export function retime(input: RetimeInput): { since: DayKey; doneThrough: Record<EnhanceTask, DayKey> } {
  const today = dayOf(input.now, input.newTime);
  const latest = addDays(today, -1);
  const doneThrough = Object.fromEntries(ENHANCE_TASKS.map((task) => {
    const day = input.doneThrough[task];
    return [task, day > latest ? latest : day];
  })) as Record<EnhanceTask, DayKey>;
  return { since: input.since > today ? today : input.since, doneThrough };
}

// ---- 会话文件的物理行（§9.5） ----

/** @brief 会话文件的一个物理行。 */
export interface PhysicalLine {
  /** 行号，从 1 开始；第 1 行是头 */
  line: number;
  /** 这一行的 JSON 对象；空行、解析不了的行、不是对象的行为 null */
  entry: Record<string, unknown> | null;
}

/** @brief 是 JSON 对象（不是数组、null 或别的值）时返回它，否则 null。 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** @brief 解析一行；解析不了或不是对象时记日志并返回 null（空行不记）。 */
function parseLine(raw: string, line: number, file: string | undefined): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  const where = file ? ` in ${file}` : '';
  try {
    const entry = record(JSON.parse(raw));
    if (!entry) console.error(`[kernel] session line ${line}${where} skipped: not a JSON object`);
    return entry;
  } catch (error) {
    console.error(`[kernel] session line ${line}${where} skipped: ${(error as Error).message}`);
    return null;
  }
}

/**
 * @brief 按物理行读会话文件的原文（§9.5）：`split('\n')`，每行单独 `JSON.parse`；空行与解析不了的行算进行号，条目为 null。
 * @param text 文件原文
 * @param file 文件路径，只用于日志
 */
export function physicalLines(text: string, file?: string): PhysicalLine[] {
  return text.split('\n').map((raw, index) => ({ line: index + 1, entry: parseLine(raw, index + 1, file) }));
}

// ---- 一天的片段（§9.5） ----

/** @brief 列出的会话这一天要读的片段（§9.5 第 1、4 条）。 */
export interface Slice {
  /** 起点条目所在的物理行 */
  fromLine: number;
  /** 终点条目所在的物理行 */
  toLine: number;
  /** 起点由水位决定（起点就是水位条目之后的第一个条目）时为水位条目的 id，否则 null（第一条消息写起点的时间，附录 B） */
  afterEntry: string | null;
  /** 起点条目的时间（ms） */
  fromTime: number;
  /** 终点条目的 id：运行成功后这个任务在这个会话的新水位（§9.8） */
  lastEntry: string;
  /** 片段里有 user 或 assistant 消息；sessionSlice 只返回有的片段，所以总为 true */
  hasChat: boolean;
}

/** @brief 片段的输入。 */
export interface SliceInput {
  /** 这个任务在这个会话的水位（读到的最后一个条目 id）；没有时为 null */
  watermark: string | null;
  /** `since` 那天开始的时刻（ms，dayStart(since, time)） */
  sinceStart: number;
  /** 日子 D 结束的时刻（ms）；D 是今天时为现在 */
  dayEnd: number;
}

/** @brief 片段里的一个条目。 */
interface SliceEntry {
  /** 物理行号 */
  line: number;
  /** 条目 id */
  id: string;
  /** 条目的 timestamp（ms）；没有或解析不了时为 NaN */
  time: number;
  /** 条目原文 */
  entry: Record<string, unknown>;
}

/** @brief 会话的条目（不含头）：有字符串 id、类型不是 session 的对象，按文件顺序。 */
function sessionEntries(lines: readonly PhysicalLine[]): SliceEntry[] {
  const entries: SliceEntry[] = [];
  for (const { line, entry } of lines) {
    if (!entry || entry.type === 'session' || typeof entry.id !== 'string') continue;
    const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    entries.push({ line, id: entry.id, time, entry });
  }
  return entries;
}

/** @brief 条目里的消息；不是 message 条目时为 null。 */
function messageOf(entry: Record<string, unknown> | null): Record<string, unknown> | null {
  return entry?.type === 'message' ? record(entry.message) : null;
}

/** @brief 条目是 user 或 assistant 消息（§9.5：只看这两种消息，Mori 写的 mori.pick 等条目不算）。 */
function isChat(entry: Record<string, unknown>): boolean {
  const role = messageOf(entry)?.role;
  return role === 'user' || role === 'assistant';
}

/**
 * @brief 一个会话这一天的片段与是否列出（§9.5 第 1 条）。
 *        起点：水位条目之后的第一个条目，与第一个 timestamp 不早于 `since` 那天开始的条目，两者中较晚的一个；
 *        没有水位、或水位条目在文件里找不到时取后者。终点：从起点往后，遇到 timestamp 不早于 `dayEnd` 的条目之前的最后一个条目
 *        （没有 timestamp 的条目不截断）。片段里没有 user 或 assistant 消息时不列出。
 * @param lines 会话文件的物理行
 * @param input 水位、`since` 那天开始的时刻、D 结束的时刻
 * @return 片段；没有条目或不列出时为 null
 */
export function sessionSlice(lines: readonly PhysicalLine[], input: SliceInput): Slice | null {
  const entries = sessionEntries(lines);
  const first = entries.findIndex((item) => item.time >= input.sinceStart);
  if (first < 0) return null;
  const mark = input.watermark === null ? -1 : entries.findIndex((item) => item.id === input.watermark);
  const byMark = mark >= 0 && mark + 1 >= first;
  const start = byMark ? mark + 1 : first;
  let end = start - 1;
  for (let index = start; index < entries.length && !(entries[index].time >= input.dayEnd); index += 1) end = index;
  if (end < start) return null;
  const part = entries.slice(start, end + 1);
  if (!part.some((item) => isChat(item.entry))) return null;
  const last = part[part.length - 1];
  return { fromLine: part[0].line, toLine: last.line, afterEntry: byMark ? input.watermark : null,
    fromTime: part[0].time, lastEntry: last.id, hasChat: true };
}

// ---- token 数（§9.6） ----

/** @brief 有限数原样返回，否则 0。 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** @brief 一份 usage 的 input + output；没有 usage 时为 0。 */
function usageTokens(usage: unknown): number {
  const value = record(usage);
  return value ? count(value.input) + count(value.output) : 0;
}

/** @brief 一个条目计入的 token（getSessionStats 循环里的分支，agent-session.js:3423-3451）。 */
function entryTokens(entry: Record<string, unknown>): number {
  if (entry.type === 'usage') return usageTokens(entry.usage);
  if (entry.type === 'branch_summary' || entry.type === 'compaction') return usageTokens(entry.usage);
  const message = messageOf(entry);
  if (message?.role === 'toolResult' || message?.role === 'assistant') return usageTokens(message.usage);
  return 0;
}

/**
 * @brief 一个会话文件的 token 数（§9.6）：按 pi getSessionStats 的算法累加 `input + output`：
 *        `assistant`、`toolResult` 消息的 `usage`，`usage` 条目，带 `usage` 的 `compaction`、`branch_summary` 条目。
 *        与 pi 一样遍历全部条目（含已被压缩、其他分支的），不计头；读不出来的行已在 physicalLines 跳过。
 * @param lines 会话文件的物理行
 */
export function sessionTokens(lines: readonly PhysicalLine[]): number {
  let total = 0;
  for (const { entry } of lines) {
    if (entry && entry.type !== 'session') total += entryTokens(entry);
  }
  return total;
}

// ---- 会话名（§12） ----

/** @brief 消息的文字（同 pi session-manager.js:469 extractTextContent：字符串，或 text 块用空格连接）。 */
function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(record).filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block?.text as string).join(' ');
}

/**
 * @brief 会话名（§12）：pi 的会话名；没有时第一条有文字的用户消息的前 60 个字符（空白压成一个空格，写进一行）；
 *        都没有时 `Untitled session`。
 * @param lines 会话文件的物理行
 * @param name pi 的会话名（SessionManager.listAll 的 name）；没有时为 null
 */
export function sessionTitle(lines: readonly PhysicalLine[], name: string | null): string {
  if (name?.trim()) return name.trim();
  for (const { entry } of lines) {
    const message = messageOf(entry);
    if (message?.role !== 'user') continue;
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    if (text) return [...text].slice(0, MEMORY_DEFAULTS.sessionTitleMax).join('');
  }
  return UNTITLED;
}
