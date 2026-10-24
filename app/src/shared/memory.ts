// 提示词分层与记忆的进程桥协议（docs/specs/memory.md §1、§3、§6、§8、§9.1、§10）：种类与层、条目与修订的形状、
// token 估算与预算、memory.* / enhance.* 命令的 zod schema 与结果、两个全局事件，以及界面与后台进程共用的文字
// （依据行、工具卡标题、修订的计数、增强状态行、新会话提示）。文件的读写只在后台进程里（kernel/memory*.ts）。

import { z } from 'zod';
import { PickSchema, THINKING_LEVELS, type ModelPick, type ThinkingLevel } from './models';

// ---- 种类、层、来源（§1） ----

/** @brief 四种条目（§1）。 */
export const MEMORY_KINDS = ['fact', 'taste', 'strategy', 'review'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** @brief 两层：用户级与本项目。 */
export const MEMORY_LAYERS = ['user', 'project'] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

/** @brief 增强任务（§9），顺序就是一天里跑的顺序。 */
export const ENHANCE_TASKS = ['taste', 'strategy', 'review'] as const;
export type EnhanceTask = (typeof ENHANCE_TASKS)[number];

/** @brief 条目的来源：你说的、它学的（proposal §4）。 */
export type EntrySource = 'user' | 'learned';

/** @brief 写入的一方（detail 的 created/modified、修订的 by，§3.2、§3.3）。 */
export type MemoryBy = 'You' | 'Mori' | 'Enhancement' | 'Rollback';

/** @brief memory 工具的调用方（§7.2）：主 Agent、立项 Agent，或某个增强任务。 */
export type MemoryCaller = { kind: 'agent' } | { kind: 'enhance'; task: EnhanceTask };

/** @brief 种类在界面、索引标题、修订小标题里的名字（§1、§3.1）。 */
export const KIND_LABEL: Readonly<Record<MemoryKind, string>> = Object.freeze({
  fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW',
});

/** @brief 每种的索引文件名（§3）。 */
export const KIND_INDEX_FILE: Readonly<Record<MemoryKind, string>> = Object.freeze({
  fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md',
});

/** @brief 每种在 system prompt 里的分节名（pi 的自定义段，§5.2），也是写入的顺序。 */
export const KIND_SECTION: Readonly<Record<MemoryKind, string>> = Object.freeze({
  fact: 'facts', taste: 'taste', strategy: 'strategy', review: 'review',
});

/** @brief 分节写入的顺序（§5.2）：taste、strategy、review、facts。 */
export const SECTION_ORDER: readonly MemoryKind[] = ['taste', 'strategy', 'review', 'fact'];

/** @brief 层在界面分段按钮上的名字（§10.1）。 */
export const LAYER_LABEL: Readonly<Record<MemoryLayer, string>> = Object.freeze({ user: 'User', project: 'Project' });

/** @brief 层在句子里的写法（工具结果、修订标题，§7.4）。 */
export const LAYER_PROSE: Readonly<Record<MemoryLayer, string>> = Object.freeze({
  user: 'user level', project: 'this project',
});

// ---- 上限与临时默认值（§6.3、§12） ----

/** @brief 每种的上限：用户级与本项目两份加起来（proposal §5.2）。 */
export const MEMORY_LIMIT = 500;

/** @brief 规格 §12 的数值（临时默认值，登记在 docs/v1/defaults.md）。 */
export const MEMORY_DEFAULTS = Object.freeze({
  /** abstract 最长（一行） */
  abstractMax: 200,
  /** detail 最长 */
  detailMax: 4000,
  /** 修订说明最长 */
  noteMax: 600,
  /** 依据原话最长 */
  quoteMax: 600,
  /** 一次调用最多几项依据 */
  evidenceMax: 10,
  /** 修订 Notes 最长 */
  notesMax: 4000,
  /** 修订列表每次最多 */
  revisionsMax: 200,
  /** 找不到条目时列出的候选最多 */
  candidatesMax: 10,
  /** memory 工具修订标题里 abstract 的前几个字符 */
  titleAbstractMax: 60,
  /** 没有会话名时取第一条用户消息的前几个字符 */
  sessionTitleMax: 60,
  /** slug 最长 */
  slugMax: 48,
  /** 每天的时刻（也是日界） */
  dailyTime: '04:00',
});

// ---- token 估算（§6.3） ----

/** 中日韩字符的码点范围（§6.3 列出的）：CJK 标点、平假名、片假名、扩展 A、统一表意文字、韩文音节、全角形式 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f], [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef],
];

/** @brief 这个字符算中日韩字符（§6.3）。 */
function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * @brief 规格 §6.3 的估算：中日韩字符每个 1；其余字符数（按码点）÷ 4 向上取整；两部分相加。
 * @param text 文字
 */
export function estimateMemoryTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjk(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** @brief 一层一种进 prompt 的行（每行 `- <abstract>`，`\n` 连接，§5.2）。 */
export function sectionLines(abstracts: readonly string[]): string {
  return abstracts.map((abstract) => `- ${abstract}`).join('\n');
}

/** @brief 一层一种的用量（§6.3）：没有条目时为 0。 */
export function layerUsage(abstracts: readonly string[]): number {
  return abstracts.length === 0 ? 0 : estimateMemoryTokens(sectionLines(abstracts));
}

/** @brief 一种的用量（§6.3）：两层分别估算再相加。 */
export interface MemoryUsage {
  /** user + project */
  used: number;
  /** 上限（500） */
  limit: number;
  /** 用户级这一种的用量 */
  user: number;
  /** 本项目这一种的用量；看用户级时为 0 */
  project: number;
}

// ---- 日期与计数的文字（§3.2、§10） ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @brief `YYYY-MM-DD` → `Oct 22`（不随系统语言变）。 */
export function monthDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  return `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}`;
}

/** @brief 毫秒时刻 → 本地 `Oct 22 04:00`。 */
export function monthDayTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** @brief 毫秒时刻 → 本地日历日期 `YYYY-MM-DD`（依据的 at，§7.3）。 */
export function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @brief token 数的写法（§10.4）：不到 1000 写 `<n> tokens`（1 时单数），1000 起写 `<n>k tokens`。 */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return n === 1 ? '1 token' : `${n} tokens`;
}

/** @brief 修订的计数（§3.3）。 */
export interface RevisionCounts {
  /** 新增的条数 */
  added: number;
  /** 修改的条数 */
  changed: number;
  /** 删除的条数 */
  deleted: number;
  /** 在两层之间移动的条数 */
  moved: number;
}

/**
 * @brief 计数的写法（§10.1、§10.5）：`Added 1, changed 2`；计数为 0 的不写，都为 0 时 `No changes`。
 * @param counts 计数（可以没有 moved）
 */
export function countsText(counts: Partial<RevisionCounts>): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`added ${counts.added}`);
  if (counts.changed) parts.push(`changed ${counts.changed}`);
  if (counts.deleted) parts.push(`deleted ${counts.deleted}`);
  if (counts.moved) parts.push(`moved ${counts.moved}`);
  if (parts.length === 0) return 'No changes';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- 依据（§3.2、§7.3） ----

/** @brief detail 里存下的一项依据（§3.2）。 */
export interface StoredEvidence {
  /** 日期 `YYYY-MM-DD`（条目或反馈时刻的本地日期，或写入时的本地日期） */
  at: string;
  /** 会话文件的绝对路径（会话依据） */
  session?: string;
  /** 会话里的条目 id；分开时立项记的为 null */
  entry?: string | null;
  /** 会话名 */
  title?: string;
  /** 反馈文件名，不含目录（反馈依据） */
  feedback?: string;
  /** 原话 */
  quote?: string;
}

/**
 * @brief 依据的一行（§3.2 的 Evidence 一节、§3.3 的 Evidence: 行、§10.1 的详情）。
 * @param evidence 依据
 * @param title 会话名（界面先按侧栏现在的名字；没有时用存下的）
 */
export function evidenceLine(evidence: StoredEvidence, title?: string): string {
  const quote = evidence.quote ? `: “${evidence.quote}”` : '';
  if (evidence.feedback !== undefined) return `${monthDay(evidence.at)} · Feedback${quote}`;
  const name = title ?? evidence.title ?? 'Untitled session';
  return `${monthDay(evidence.at)} · Session “${name}”${quote}`;
}

// ---- 条目与修订（§3、§8） ----

/** @brief 列表里的一条（memory.list）。 */
export interface EntryRow {
  /** slug */
  id: string;
  /** 一行摘要（进 prompt 的那行） */
  abstract: string;
  /** 你说的或它学的 */
  source: EntrySource;
  /** `YYYY-MM-DD · <谁>` */
  created: string;
  /** `YYYY-MM-DD · <谁>` */
  modified: string;
}

/** @brief 读不出来的条目（§3）。 */
export interface BrokenEntry {
  /** 文件名（索引里的链接或 entries 下的文件名） */
  name: string;
  /** 原因 */
  error: string;
}

/** @brief 一条的 detail（memory.get）。 */
export interface EntryDetail extends EntryRow {
  /** 所属的种类 */
  kind: MemoryKind;
  /** 所在的层 */
  layer: MemoryLayer;
  /** `## Details` 的原文 */
  details: string;
  /** `## Evidence` 里的依据，按写入顺序 */
  evidence: StoredEvidence[];
  /** `## Revisions` 的每一行（不含 `- `） */
  history: string[];
  /** detail 文件的绝对路径 */
  file: string;
}

/** @brief 指向一条（反向链接）。 */
export interface EntryRef {
  /** 指过来的条目所在的层 */
  layer: MemoryLayer;
  /** 指过来的条目的种类 */
  kind: MemoryKind;
  /** 指过来的条目的 slug */
  id: string;
  /** 指过来的条目的一行摘要 */
  abstract: string;
}

/** @brief 修订的状态（§3.3）。 */
export type RevisionStatus = 'done' | 'failed' | 'running';

/** @brief 增强运行的信息（§3.3 的 run）。 */
export interface RevisionRun {
  /** 运行的增强任务 */
  task: EnhanceTask;
  /** 日子 D */
  day: string;
  /** token 数；运行中为 null */
  tokens: number | null;
  /** 列出的会话数 */
  sessions: number;
  /** 列出的反馈数 */
  feedback: number;
}

/** @brief 修订列表的一行（memory.revisions，§8）：只来自 frontmatter。 */
export interface RevisionRow {
  /** 修订 id（也是 revisions/ 下的文件名） */
  id: string;
  /** ISO 时刻，带时区 */
  time: string;
  /** 写入的一方 */
  by: MemoryBy;
  /** 列表里显示的标题 */
  title: string;
  /** 完成、失败，或增强运行还在进行 */
  status: RevisionStatus;
  /** 改到的层（移动时两层） */
  layers: MemoryLayer[];
  /** 改到的种类 */
  kinds: MemoryKind[];
  /** 各动作的改动数 */
  counts: RevisionCounts;
  /** 回滚的那一次的 id */
  rollbackOf: string | null;
}

/** @brief 修订里一处改动的动作。 */
export type RevisionAction = 'added' | 'changed' | 'deleted' | 'moved';

/** @brief 条目在某一层的位置。 */
export interface EntryPlace {
  /** 所在的层 */
  layer: MemoryLayer;
  /** 条目的 slug（entries/ 下的文件名） */
  slug: string;
}

/** @brief 修订里的一处改动（§3.3、§8）：Added 只有 to，Deleted 只有 from，Changed 两者相同，移动两者不同。 */
export interface RevisionChange {
  /** 这处改动的动作 */
  action: RevisionAction;
  /** 改到的条目的种类 */
  kind: MemoryKind;
  /** 改动前的位置；新增时为 null */
  from: EntryPlace | null;
  /** 改动后的位置；删除时为 null */
  to: EntryPlace | null;
  /** `Evidence:` 行的原文 */
  evidence?: string;
  /** `Note:` 行的原文 */
  note?: string;
  /** 改动前整个 detail 文件；不存在时为空串 */
  before: string;
  /** 改动后整个 detail 文件；不存在时为空串 */
  after: string;
}

/** @brief 一次修订的全文（memory.revisions 带 id）。 */
export interface RevisionDetail extends RevisionRow {
  /** 每处改动，按正文里的顺序 */
  changes: RevisionChange[];
  /** `## Notes`（增强运行）；没有时为 null */
  notes: string | null;
  /** 增强运行的信息；别的修订为 null */
  run: RevisionRun | null;
  /** 改到本项目时的工作目录 */
  cwd: string | null;
}

// ---- 增强（§9.1） ----

/** @brief 一个任务的上次结果（enhance.json tasks.<task>.last）。 */
export interface EnhanceLast {
  /** 日子 D */
  day: string;
  /** ISO 时刻 */
  at: string;
  /** 完成、失败或没有可读的内容而跳过 */
  status: 'done' | 'failed' | 'skipped';
  /** 失败的原因 */
  error: string | null;
  /** 修订 id；跳过时为 null */
  revision: string | null;
  /** 这次运行用掉的 token 数 */
  tokens: number;
  /** 改动数；跳过时为 null */
  counts: Omit<RevisionCounts, 'moved'> | null;
}

/** @brief 待显示的新会话提示（§9.1 notice，也是 SessionInfo.memoryNotice）。 */
export interface MemoryNotice {
  /** 修订 id，按时间先后 */
  revisions: string[];
  /** 每种改动的条数（added + changed + deleted） */
  counts: Record<EnhanceTask, number>;
  /** 这些修订的日子里最早的一天 */
  from: string;
  /** 最晚的一天 */
  to: string;
}

/** @brief enhance.get 的结果（§8）。 */
export interface EnhanceInfo {
  /** 工作目录 */
  cwd: string;
  /** 打开每天的增强 */
  enabled: boolean;
  /** 选择范围；设置里没有默认范围时为 null */
  pick: ModelPick | null;
  /** 增强运行的思考强度 */
  thinking: ThinkingLevel;
  /** 增强运行用平行 Agent */
  team: boolean;
  /** `HH:MM` */
  time: string;
  /** 打开的那天；从没打开过为 null */
  since: string | null;
  /** 三个任务的上次结果 */
  last: Record<EnhanceTask, EnhanceLast | null>;
  /** 正在跑的那一项（这个项目的）；没有时为 null */
  running: { task: EnhanceTask; day: string } | null;
  /** 这个项目在队列里排着的项数（不含正在跑的） */
  queued: number;
  /** 下一次到点的时刻（ms）；关着时为 null */
  next: number | null;
  /** 待显示的新会话提示（§8、§9.1 notice）；没有时为 null */
  notice: MemoryNotice | null;
  /**
   * 设置对话框的 Effort 用（§10.4）：模型配置里每个选择范围（分组、提供商、`<provider>/<model>`）按 §9.1 的规则取到的
   * 第一个候选是否标了 Supports thinking；取不到候选的范围不出现
   */
  effortPicks: Record<ModelPick, boolean>;
  /**
   * 设置对话框的 Effort 用（§10.4 的 2026-10-24 注，model-providers.md §7.7）：按同样取法取到的第一个候选的档案
   * reasoning.off_refused 为真的那些选择范围；那个候选没有档案时按假，取不到候选的范围也不在里面
   */
  noOffPicks: ModelPick[];
  /** 读设置出错、项目目录被占用时的原因；否则为 null */
  error: string | null;
}

// ---- 命令（§8） ----

const cwd = z.string().min(1).nullable();
const layer = z.enum(MEMORY_LAYERS);
const kind = z.enum(MEMORY_KINDS);
const entryId = z.string().min(1);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** @brief 记忆与增强的命令，由 protocol.ts 并进 CommandSchema。文字字段只写 z.string()，长度由后台进程查（§8）。 */
export const MemoryCommandSchemas = [
  /** 一层一种的列表与用量 */
  z.object({ type: z.literal('memory.list'), cwd, layer, kind }),
  /** 一条的 detail、改过它的修订、反向链接 */
  z.object({ type: z.literal('memory.get'), cwd, layer, id: entryId }),
  /** 记忆页新增（没有 id）或修改（有 id） */
  z.object({ type: z.literal('memory.save'), cwd, layer, kind, id: entryId.optional(), abstract: z.string(),
    detail: z.string() }),
  z.object({ type: z.literal('memory.delete'), cwd, layer, id: entryId }),
  /** from 为 project：提升到用户级；为 user：放回本项目 */
  z.object({ type: z.literal('memory.move'), cwd, from: layer, id: entryId }),
  /** 没有 id：列表；有：一次修订的全文 */
  z.object({ type: z.literal('memory.revisions'), cwd, layer, id: entryId.optional() }),
  z.object({ type: z.literal('memory.rollback'), cwd, layer, id: entryId }),
  z.object({ type: z.literal('enhance.get'), cwd: z.string().min(1) }),
  z.object({ type: z.literal('enhance.set'), cwd: z.string().min(1), enabled: z.boolean().optional(),
    pick: PickSchema.optional(), thinking: z.enum(THINKING_LEVELS).optional(), team: z.boolean().optional(),
    time: z.string().regex(TIME, 'Not a time').optional() }),
  z.object({ type: z.literal('enhance.run'), cwd: z.string().min(1) }),
] as const;
export type MemoryCommand = z.infer<(typeof MemoryCommandSchemas)[number]>;

/** @brief 结果都带的字段：失败的原因（只有原因，不带动词前缀，§8）；成功为 null。 */
export interface MemoryResult {
  /** 失败的原因；成功为 null */
  error: string | null;
}

/** @brief memory.list 的结果。 */
export interface MemoryListResult extends MemoryResult {
  /** 索引里的条目，按索引顺序 */
  entries: EntryRow[];
  /** 这一种的用量 */
  usage: MemoryUsage;
  /** 读不出来的条目 */
  broken: BrokenEntry[];
  /** 这一层改到这一种的最近一次修订 */
  last: RevisionRow | null;
}

/** @brief memory.get 的结果。 */
export interface MemoryGetResult extends MemoryResult {
  /** 这一条；不存在时为 null */
  entry: EntryDetail | null;
  /** 改过它的修订，时间倒序 */
  revisions: RevisionRow[];
  /** 用 [[slug]] 指向它的条目 */
  backlinks: EntryRef[];
}

/** @brief 写入类命令的结果。 */
export interface MemoryWriteResult extends MemoryResult {
  /** 这次写下的修订 id；失败时为 null */
  revision: string | null;
  /** 新增、移动后条目的 id；别的命令为 null */
  id: string | null;
}

/** @brief memory.revisions 的结果：没有 id 时 revisions，有时 revision。 */
export type MemoryRevisionsResult = MemoryResult & ({ revisions: RevisionRow[] } | { revision: RevisionDetail | null });

/** @brief 每个命令的结果类型。 */
export interface MemoryCommandResults {
  'memory.list': MemoryListResult;
  'memory.get': MemoryGetResult;
  'memory.save': MemoryWriteResult;
  'memory.delete': MemoryWriteResult;
  'memory.move': MemoryWriteResult;
  'memory.revisions': MemoryRevisionsResult;
  'memory.rollback': MemoryWriteResult;
  'enhance.get': EnhanceInfo;
  'enhance.set': MemoryResult & { info: EnhanceInfo };
  'enhance.run': MemoryResult;
}

// ---- 事件（§8，全局：信封的 sessionId 为 null） ----

/** @brief 记忆写入之后（proposal 的 memory.changed）。 */
export interface MemoryChangedEvent {
  type: 'mori.memory_changed';
  /** 改到本项目时的工作目录；只改用户级时为 null */
  cwd: string | null;
  /** 改到的层 */
  layers: MemoryLayer[];
  /** 改到的种类 */
  kinds: MemoryKind[];
  /** 修订 id */
  revision: string;
}

/** @brief 增强任务的进度（proposal 的 enhance.progress）。 */
export interface EnhanceProgressEvent {
  type: 'mori.enhance_progress';
  /** 项目的工作目录 */
  cwd: string;
  /** 增强任务 */
  task: EnhanceTask;
  /** 日子 D */
  day: string;
  /** 这一项现在的阶段 */
  phase: 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  /** 失败的原因 */
  error?: string;
  /** 这次运行的修订 id */
  revision?: string;
}

/** @brief 记忆与增强的全局事件。 */
export type MemoryGlobalEvent = MemoryChangedEvent | EnhanceProgressEvent;

// ---- memory 工具的结果与工具卡（§7.4、§7.5） ----

/** @brief memory 工具结果的 details（界面据此显示 View in Memory）。 */
export interface MemoryToolDetails {
  /** 修订 id */
  revision: string;
  /** 条目的种类 */
  kind: MemoryKind;
  /** 条目所在的层 */
  layer: MemoryLayer;
  /** 条目 id（slug） */
  entry: string;
  /** 动作 */
  action: 'save' | 'update' | 'forget';
}

/** @brief 工具卡标题的两部分（与 toolTitle.ts 的 ToolTitle 同形）。 */
export interface MemoryToolTitle {
  /** 工具卡的动词 */
  verb: string;
  /** 工具卡的对象 */
  target: string;
}

/**
 * @brief memory 工具调用的标题（§7.5），也用于阶段行与会话引用的 [Tool] 行。参数不全时按动作给出动词。
 * @param args 调用的参数（模型给的原样）
 */
export function memoryToolTitle(args: unknown): MemoryToolTitle {
  const input = (args ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  if (input.action === 'update') return { verb: 'Update memory', target: text(input.entry) };
  if (input.action === 'forget') return { verb: 'Delete from memory', target: text(input.entry) };
  const kindName = MEMORY_KINDS.includes(input.kind as MemoryKind) ? KIND_LABEL[input.kind as MemoryKind] : 'memory';
  return { verb: `Save to ${kindName}`, target: text(input.abstract) };
}

/** @brief 工具结果的 details 是不是 memory 的（旧会话、别的工具都不是）。 */
export function isMemoryToolDetails(value: unknown): value is MemoryToolDetails {
  const details = value as Partial<MemoryToolDetails> | null;
  return Boolean(details) && typeof details?.revision === 'string' && typeof details.entry === 'string'
    && MEMORY_KINDS.includes(details.kind as MemoryKind) && MEMORY_LAYERS.includes(details.layer as MemoryLayer);
}

// ---- 新会话的提示（§10.6） ----

/**
 * @brief 横幅的文字：`Enhancement updated this project’s memory from the Oct 22 sessions: STRATEGY 2, TASTE 1.`
 *        （日子不同时 `from the Oct 22–Oct 23 sessions`；只列不为 0 的种类）。
 */
export function memoryNoticeText(notice: MemoryNotice): string {
  const days = notice.from === notice.to ? monthDay(notice.from)
    : `${monthDay(notice.from)}–${monthDay(notice.to)}`;
  const kinds = ENHANCE_TASKS.filter((task) => notice.counts[task] > 0)
    .map((task) => `${KIND_LABEL[task]} ${notice.counts[task]}`);
  return `Enhancement updated this project’s memory from the ${days} sessions: ${kinds.join(', ')}.`;
}

// ---- 增强状态行（§10.4） ----

/** @brief 关着时的说明（临时，§10.4）。 */
export const ENHANCE_OFF_TEXT = 'Off · Each day, three background runs review this project’s sessions and improve '
  + 'its TASTE, STRATEGY, and REVIEW';

/** @brief 没有模型时的状态行（§10.4、§9.1、§9.9）。 */
export const ENHANCE_NO_MODEL_TEXT = 'On · Choose a model in enhancement settings';

/** @brief 下次到点的一段。 */
function nextPart(info: EnhanceInfo): string {
  return info.next === null ? '' : ` · Next run ${monthDayTime(info.next)}`;
}

/** @brief 失败的那一行（§10.4）；没有失败的任务时为 null。 */
function failedLine(info: EnhanceInfo): string | null {
  const failed = ENHANCE_TASKS.filter((task) => info.last[task]?.status === 'failed');
  if (failed.length === 0) return null;
  const latest = [...failed].sort((a, b) => (info.last[b]?.at ?? '').localeCompare(info.last[a]?.at ?? ''))[0];
  const kinds = failed.map((task) => KIND_LABEL[task]).join(', ');
  return `On · Last run failed (${kinds}): ${info.last[latest]?.error ?? 'Unknown error'}${nextPart(info)}`;
}

/** @brief 上次成功或全部跳过的那一行（§10.4）；还没跑过时为 null。 */
function lastLine(info: EnhanceInfo): string | null {
  const lasts = ENHANCE_TASKS.map((task) => [task, info.last[task]] as const)
    .filter((pair): pair is readonly [EnhanceTask, EnhanceLast] => pair[1] !== null);
  if (lasts.length === 0) return null;
  const day = lasts.map(([, last]) => last.day).sort().at(-1)!;
  const ofDay = lasts.filter(([, last]) => last.day === day);
  const at = ofDay.map(([, last]) => Date.parse(last.at)).sort((a, b) => a - b).at(-1)!;
  const head = `On · Last run ${monthDayTime(at)}`;
  if (ofDay.every(([, last]) => last.status === 'skipped')) {
    return `${head} · No finished sessions to read${nextPart(info)}`;
  }
  const changed = ofDay.filter(([, last]) => last.status === 'done' && last.counts
    && countsText(last.counts) !== 'No changes')
    .map(([task, last]) => `${KIND_LABEL[task]}: ${countsText(last.counts!).toLowerCase()}`);
  const tokens = ofDay.reduce((sum, [, last]) => sum + last.tokens, 0);
  const changes = changed.length > 0 ? changed.join('; ') : 'No changes';
  return `${head} · ${changes} · ${formatTokens(tokens)}${nextPart(info)}`;
}

/**
 * @brief 增强状态行（§10.4 的表，按顺序取第一个符合的）。读不出设置的那一行由界面加前缀，这里也给出。
 * @param info enhance.get 的结果
 */
export function enhanceStatusText(info: EnhanceInfo): string {
  if (info.error !== null) return `Couldn’t read the enhancement settings: ${info.error}`;
  if (!info.enabled) return ENHANCE_OFF_TEXT;
  if (info.pick === null) return ENHANCE_NO_MODEL_TEXT;
  if (info.running) {
    const queued = info.queued > 0 ? ` · ${info.queued} queued` : '';
    return `Running ${KIND_LABEL[info.running.task]} enhancement…${queued}`;
  }
  if (info.queued > 0) return `On · ${info.queued} queued · Waiting for another project’s enhancement`;
  return failedLine(info) ?? lastLine(info) ?? `On${nextPart(info)}`;
}
