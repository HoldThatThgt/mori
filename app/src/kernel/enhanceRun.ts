// 一次增强运行（docs/specs/memory.md §9.5–§9.8）：一个项目、一个任务、一天。
// 先选出这一天要读的会话（pi 的会话列表里项目文件夹与项目完全相同、片段里有对话、跑的时候没在生成的）与反馈，写第一条消息（附录 B）；
// 没有会话可列时跳过。否则先开始修订（beginRun），再经会话表建看不见的会话、发出第一条消息，按这个会话送来的事件判断
// 开始、结束与失败（不轮询，§9.6）；失败或被停止时先停下再等它空闲，然后关闭；关闭之后从会话文件累加 token，结束修订（endRun）。
// enhance.json 的读写都在增强调度（enhance.ts）里：这里只把结果交回去。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENHANCE_TASKS, type EnhanceLast, type EnhanceTask, type EntrySource, type RevisionCounts, type StoredEvidence,
} from '../shared/memory';
import type { ModelBlocked, ModelPick, ThinkingLevel } from '../shared/models';
import type { EventEnvelope } from '../shared/protocol';
import { projectFolder } from '../shared/workspace';
import {
  addDays, dayStart, physicalLines, sessionSlice, sessionTitle, sessionTokens, type DayKey, type PhysicalLine,
  type SliceInput,
} from './enhanceDays';
import { dayFeedback } from './feedbackRead';
import { beginRun, detailOf, endRun, list, projectDir, type RunHandle } from './memory';
import { firstMessage, type FirstMessageInput, type ListedFeedback, type ListedSession } from './memoryText';
import type { EvidenceScope } from './memoryTool';
import { loadPi } from './pi';
import { sessionGenerating, startHeadless, type HeadlessSession } from './sessions';

// ---- 对外的类型 ----

/** @brief 一次运行用的设置（enhance.json 的设置部分，§9.1）；增强开着且有选择范围时才有。 */
export interface EnhanceSettings {
  /** 选择范围（组、提供商或 `<provider>/<model>`） */
  pick: ModelPick;
  /** 思考强度（建好会话后 setThinkingLevel） */
  thinking: ThinkingLevel;
  /** 用协作模式跑（建好后进入 always） */
  team: boolean;
  /** 每天的时刻 `HH:MM`，也是日界（§9.2） */
  time: string;
  /** 打开增强的那天：片段从这天开始截（§9.5） */
  since: DayKey;
}

/** @brief 一个任务的状态（enhance.json 的 tasks.<task>，§9.1）。 */
export interface TaskState {
  /** 这个任务处理完的最后一天；从没打开过时为 null */
  doneThrough: DayKey | null;
  /** 会话文件 → 读到的最后一个条目 id */
  watermarks: Record<string, string>;
  /** 已经交给它的反馈里最晚的 createdAt（ISO）；没有时为 null */
  feedbackSeen: string | null;
  /** 正在跑的修订 id；没有时为 null */
  running: string | null;
  /** 上次结果 */
  last: EnhanceLast | null;
}

/** @brief runTask 的参数。 */
export interface RunInput {
  /** 项目文件夹（project.json 记的 cwd，file-system.md §11.7：不是 worktree 的工作路径；增强会话也在这里运行） */
  cwd: string;
  /** 任务（也是这次能改的种类） */
  task: EnhanceTask;
  /** 日子 D */
  day: DayKey;
  /** D 是开始这次运行时的今天（现在运行）：片段到现在为止 */
  today: boolean;
  /** 设置 */
  settings: EnhanceSettings;
  /** 这个任务开始时的状态（水位、feedbackSeen） */
  state: TaskState;
  /** Mori 的数据目录（反馈与 TaskBoard 目录在它下面） */
  userData: string;
  /** 现在（ms，增强调度注入的时钟） */
  now: () => number;
  /** 停止这次运行（关掉增强、后台进程退出）；abort 的 reason 是失败的原因原文 */
  signal: AbortSignal;
  /**
   * beginRun 之后、建会话之前调用：增强调度在 enhance.json 记下 running（§9.8）。没记下时抛出原因：
   * 这次不建会话，修订按失败定下（不留没人记着的 running 修订，§9.10）
   */
  onBegin: (revision: string) => Promise<void>;
}

/** @brief 一次运行的结果，增强调度据此改 enhance.json（§9.5 第 3 条、§9.8）。 */
export type RunOutcome =
  | {
    /** 没有会话可列：没有修订、没建会话 */
    status: 'skipped';
  }
  | {
    /** 正常结束：修订定为 done */
    status: 'done';
    /** 这次运行的修订 id */
    revision: string;
    /** 修订的计数 */
    counts: RevisionCounts;
    /** 增强会话与它的实例会话的 token 数 */
    tokens: number;
    /** 每个列出的会话的新水位：片段的最后一个条目 */
    watermarks: Record<string, string>;
    /** 交给它的反馈里最晚的 createdAt；没有反馈时为 null */
    feedbackSeen: string | null;
  }
  | {
    /** 失败（含被停止）：修订定为 failed，或还没开始修订 */
    status: 'failed';
    /** 失败的原因原文 */
    error: string;
    /** 这次运行的修订 id；还没开始修订就失败时为 null */
    revision: string | null;
    /** 修订的计数；没有修订或 endRun 没写成时为 null */
    counts: RevisionCounts | null;
    /** token 数 */
    tokens: number;
    /** endRun 没写成：enhance.json 的 running 留着，下次启动或这个任务下一次运行之前按 §9.10 把修订定为 failed */
    keepRunning: boolean;
  };

// ---- 文字 ----

/** 监听收到 mori.model_unavailable 时的原因（§9.6） */
const NO_MODEL_AVAILABLE = 'No model available';
/** 关闭模式下结束时第一条消息之后没有助手消息（§9.6 的失败条件；原文是本文件定的） */
const NO_REPLY = 'The run ended without a reply.';
/** 结束时检查的事件（§9.6） */
const END_EVENTS: ReadonlySet<string> = new Set([
  'agent_settled', 'mori.prompt_done', 'mori.prompt_error', 'mori.model_unavailable', 'mori.team_state',
]);

/** @brief 错误的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 停止的原因（abort 时给的原文）。 */
function stopReason(signal: AbortSignal): string {
  return String(signal.reason);
}

// ---- 文件 ----

/** @brief 目录里的 .jsonl 文件名，按名字排序；目录不存在时为空，别的错误记日志后为空。 */
async function jsonlNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] reading ${dir} failed: ${errorText(error)}`);
    }
    return [];
  }
}

/** @brief 是目录；不存在时为假，别的错误记日志后为假。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] reading ${path} failed: ${errorText(error)}`);
    }
    return false;
  }
}

/** @brief 会话文件的物理行（§9.5）；文件不存在时为空，读不出来时记日志后为空。 */
async function fileLines(file: string): Promise<PhysicalLine[]> {
  try {
    return physicalLines(await readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] reading ${file} failed: ${errorText(error)}`);
    }
    return [];
  }
}

// ---- 这一天的会话与反馈（§9.5） ----

/** @brief 列出的一个会话，加上运行成功后它的新水位。 */
interface DaySession extends ListedSession {
  /** 片段的最后一个条目 id（§9.8 推进水位） */
  lastEntry: string;
}

/** @brief pi 会话列表里的一项（SessionManager.listAll 的 SessionInfo 用到的部分）。 */
interface ListedInfo {
  /** 会话文件的绝对路径 */
  path: string;
  /** 会话 id（TaskBoard 目录名） */
  id: string;
  /** pi 的会话名 */
  name?: string;
}

/**
 * @brief 一个会话这一天的片段（§9.5 第 1、4 条）：按物理行读文件，取片段与会话名，有 TaskBoard 目录时带上它。
 * @return 不列出（没有片段、片段里没有对话、读不出来）时为 null
 */
async function daySession(info: ListedInfo, slice: SliceInput, userData: string): Promise<DaySession | null> {
  let text: string;
  try {
    text = await readFile(info.path, 'utf8');
  } catch (error) {
    console.error(`[kernel] session ${info.path} skipped by enhancement: ${errorText(error)}`);
    return null;
  }
  const lines = physicalLines(text, info.path);
  const part = sessionSlice(lines, slice);
  if (!part) return null;
  const teamDir = join(userData, 'teams', info.id);
  return { title: sessionTitle(lines, info.name ?? null), file: info.path, fromLine: part.fromLine,
    toLine: part.toLine, afterEntry: part.afterEntry, fromTime: part.fromTime,
    teamDir: (await isDirectory(teamDir)) ? teamDir : null, lastEntry: part.lastEntry };
}

/**
 * @brief 这一天要读的会话（§9.5 第 1 条）：pi 的会话列表（只扫 <agentDir>/sessions）里项目文件夹与项目完全相同、
 *        这时没在生成的会话，片段里有 user 或 assistant 消息的才列；按片段开始的时刻排列。
 *        项目文件夹是 projectFolder(info.cwd)（file-system.md §11.7）：主文件夹和它的 Mori worktree 里的会话都读。
 * @param input 这次运行
 * @param dayEnd D 结束的时刻（D 是今天时为现在）
 */
async function listDaySessions(input: RunInput, dayEnd: number): Promise<DaySession[]> {
  const pi = await loadPi();
  const sinceStart = dayStart(input.settings.since, input.settings.time);
  const listed: DaySession[] = [];
  for (const info of await pi.SessionManager.listAll()) {
    if (projectFolder(info.cwd) !== input.cwd || sessionGenerating(info.path)) continue;
    const watermark = input.state.watermarks[info.path] ?? null;
    const item = await daySession(info, { watermark, sinceStart, dayEnd }, input.userData);
    if (item) listed.push(item);
  }
  return listed.sort((a, b) => a.fromTime - b.fromTime);
}

/**
 * @brief 依据范围里的实例会话文件（§7.3、§9.7）：列出的 TaskBoard 目录 `sessions/` 下的文件，会话名为
 *        `<会话名> · <实例文件名>`，路径是目录列举得到的原样。
 */
async function instanceFiles(sessions: readonly DaySession[]): Promise<EvidenceScope['instanceFiles']> {
  const files: { file: string; title: string }[] = [];
  for (const session of sessions) {
    if (session.teamDir === null) continue;
    const dir = join(session.teamDir, 'sessions');
    for (const name of await jsonlNames(dir)) {
      files.push({ file: join(dir, name), title: `${session.title} · ${name}` });
    }
  }
  return files;
}

/** @brief 第一条消息里的现有条目（附录 B）。 */
type CurrentEntries = Pick<FirstMessageInput, 'userEntries' | 'projectEntries' | 'agentFacts' | 'details' | 'used'>;

/**
 * @brief 本项目 Mori 记的事实（附录 B 的 `Facts added by Mori:`，§6.9）：读得出来的、source agent 的，按索引顺序。
 * @throws Error 读记忆出错（原因原文）
 */
async function agentFacts(cwd: string): Promise<CurrentEntries['agentFacts']> {
  const facts = await list(cwd, 'project', 'fact');
  if (facts.error !== null) throw new Error(facts.error);
  return facts.entries.filter((entry) => entry.source === 'agent').map(({ id, abstract }) => ({ id, abstract }));
}

/**
 * @brief 现有条目（附录 B）：用户级与本项目三种（读得出来的，按索引顺序）、本项目 Mori 记的事实、本项目这一种的 detail、
 *        这一种的用量（§6.3）。
 * @throws Error 读记忆出错（原因原文）
 */
async function currentEntries(cwd: string, task: EnhanceTask): Promise<CurrentEntries> {
  const userEntries = { taste: [], strategy: [], review: [] } as Record<EnhanceTask, string[]>;
  const projectEntries = { taste: [], strategy: [], review: [] } as
    Record<EnhanceTask, { id: string; abstract: string; source: EntrySource }[]>;
  let used = 0;
  for (const kind of ENHANCE_TASKS) {
    const user = await list(null, 'user', kind);
    const project = await list(cwd, 'project', kind);
    const error = user.error ?? project.error;
    if (error !== null) throw new Error(error);
    userEntries[kind] = user.entries.map((entry) => entry.abstract);
    projectEntries[kind] = project.entries.map(({ id, abstract, source }) => ({ id, abstract, source }));
    if (kind === task) used = project.usage.used;
  }
  const details: { id: string; source: EntrySource; details: string; evidence: StoredEvidence[] }[] = [];
  for (const { id } of projectEntries[task]) {
    const detail = await detailOf(cwd, 'project', id);
    if (detail) details.push({ id, source: detail.source, details: detail.details, evidence: detail.evidence });
  }
  return { userEntries, projectEntries, agentFacts: await agentFacts(cwd), details, used };
}

/** @brief 一次运行的材料：列出的会话与反馈、依据范围、第一条消息。 */
interface Material {
  /** 列出的会话 */
  sessions: DaySession[];
  /** 列出的反馈 */
  feedback: ListedFeedback[];
  /** 依据的范围（§9.7） */
  scope: EvidenceScope;
  /** 第一条消息（附录 B） */
  message: string;
}

/**
 * @brief 选会话与反馈、读现有条目、写第一条消息（§9.5、附录 B）。
 * @return 没有会话可列时为 null（这次跳过，不读反馈与条目）
 * @throws Error 读记忆或反馈出错
 */
async function gather(input: RunInput): Promise<Material | null> {
  const start = dayStart(input.day, input.settings.time);
  const end = dayStart(addDays(input.day, 1), input.settings.time);
  const dayEnd = input.today ? Math.min(end, input.now()) : end;
  const sessions = await listDaySessions(input, dayEnd);
  if (sessions.length === 0) return null;
  const feedback = await dayFeedback(input.userData, input.cwd, start, end, input.state.feedbackSeen);
  const entries = await currentEntries(input.cwd, input.task);
  const scope: EvidenceScope = { sessions: sessions.map(({ file, title }) => ({ file, title })),
    instanceFiles: await instanceFiles(sessions),
    feedback: feedback.map(({ name, feedback: item }) => ({ name, createdAt: item.createdAt })) };
  const message = firstMessage({ task: input.task, cwd: input.cwd, day: input.day, dayStart: start, dayEnd, sessions,
    feedback, ...entries });
  return { sessions, feedback, scope, message };
}

// ---- 看不见的会话的开始、结束与失败（§9.6） ----

/**
 * @brief 按看不见的会话送来的事件判断开始、结束与失败（§9.6，不轮询）：第一次看到会话在准备、运行或 Team 忙，
 *        或收到 mori.prompt_error、mori.model_unavailable，就算开始；开始之后每收到 END_EVENTS 里的事件看会话是否空闲
 *        （会话空闲并且 Team 不忙），空闲即结束。失败事件与停止信号立即给出原因。
 */
class RunWatcher {
  /** 看不见的会话；发出第一条消息之前为 null（这之前的事件不看） */
  private session: HeadlessSession | null = null;
  /** 已经开始 */
  private started = false;
  /** 结果已经定下 */
  private settled = false;
  /** 停下之后等会话空闲的回调 */
  private waiters: (() => void)[] = [];
  /** 定下结果 */
  private resolve: (error: string | null) => void = () => undefined;
  /** 结果：正常结束为 null，失败或停止为原因 */
  readonly outcome: Promise<string | null>;
  /** 结果是正常结束（会话已空闲） */
  ended = false;

  /** @param signal 停止信号：abort 时以它的原因失败 */
  constructor(signal: AbortSignal) {
    this.outcome = new Promise((resolve) => { this.resolve = resolve; });
    signal.addEventListener('abort', () => this.settle(stopReason(signal), false), { once: true });
  }

  /** @brief 发出第一条消息前交来会话；之后才看事件。 */
  attach(session: HeadlessSession): void {
    this.session = session;
  }

  /** @brief 发出之后马上看一次是否已经开始（准备中在发出时就开始了）。 */
  check(): void {
    if (this.session && !this.started) this.started = this.session.started();
  }

  /** @brief 交给 startHeadless 的事件监听：会话的每个信封。 */
  onEvent(envelope: EventEnvelope): void {
    const session = this.session;
    if (!session) return;
    const event = envelope.event;
    if (event.type === 'mori.prompt_error') this.fail(event.message);
    if (event.type === 'mori.model_unavailable') this.fail(NO_MODEL_AVAILABLE);
    this.check();
    if (!END_EVENTS.has(event.type) || !session.idle()) return;
    for (const wake of this.waiters.splice(0)) wake();
    if (this.started) this.settle(null, true);
  }

  /** @brief 等会话空闲（停下之后、关闭之前，§9.6“监听看到结束条件后关闭会话”）。 */
  idle(): Promise<void> {
    if (!this.session || this.session.idle()) return Promise.resolve();
    return new Promise((wake) => this.waiters.push(wake));
  }

  /** @brief 失败事件：也算开始。 */
  private fail(reason: string): void {
    this.started = true;
    this.settle(reason, false);
  }

  /** @brief 定下结果（只定一次）。 */
  private settle(error: string | null, ended: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.ended = ended;
    this.resolve(error);
  }
}

/**
 * @brief 拒绝启动的原因（§9.6“原因取 blocked 的种类与说明”）：`<种类>: <说明>`，说明依次为 detail、
 *        角色文件的问题、每个候选与排除原因；都没有时只有种类。
 */
function blockedReason(blocked: ModelBlocked): string {
  const parts = [blocked.detail, ...blocked.problems,
    ...blocked.candidates.map((candidate) => `${candidate.ref}: ${candidate.detail || candidate.reason}`)]
    .filter((part) => part !== '');
  return parts.length > 0 ? `${blocked.kind}: ${parts.join('; ')}` : blocked.kind;
}

/**
 * @brief 正常结束时的失败条件（§9.6）：用户会话最后一条助手消息的 stopReason 为 error 或 aborted（原因取 errorMessage），
 *        关闭模式下第一条消息之后没有助手消息。
 * @return 原因；没有失败时为 null
 */
function endError(session: HeadlessSession, team: boolean): string | null {
  const last = session.lastAssistant();
  if (last && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
    return last.errorMessage ?? `The reply ended with “${last.stopReason}”.`;
  }
  if (!team && !session.hasAssistantAfterFirst()) return NO_REPLY;
  return null;
}

/** @brief 停下会话（abort，有 Team 时再 stopTeam）；出错只记日志。 */
async function stopQuietly(session: HeadlessSession): Promise<void> {
  try {
    await session.stop();
  } catch (error) {
    console.error(`[kernel] stopping enhancement session ${session.sessionId} failed: ${errorText(error)}`);
  }
}

/** @brief 关闭会话（也释放它的 Team）；出错只记日志。 */
async function closeQuietly(session: HeadlessSession): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    console.error(`[kernel] closing enhancement session ${session.sessionId} failed: ${errorText(error)}`);
  }
}

/** @brief 看不见的会话这次的结果。 */
interface DriveResult {
  /** 失败的原因；成功为 null */
  error: string | null;
  /** 增强会话的文件；没建成时为 null */
  sessionFile: string | null;
  /** 增强会话的 TaskBoard 目录；没建成时为 null */
  teamDir: string | null;
}

/**
 * @brief 建好会话之后（§9.6）：查拒绝启动、发出第一条消息、等结束或失败；失败与停止时先停下、等它空闲。
 * @return 失败的原因；成功为 null
 */
async function converse(input: RunInput, material: Material, session: HeadlessSession,
  watcher: RunWatcher): Promise<string | null> {
  const blocked = session.blocked();
  if (blocked) return blockedReason(blocked);
  if (input.signal.aborted) return stopReason(input.signal);
  watcher.attach(session);
  session.send(material.message);
  watcher.check();
  const failure = await watcher.outcome;
  const error = failure ?? endError(session, input.settings.team);
  if (!watcher.ended) {
    await stopQuietly(session);
    await watcher.idle();
  }
  return error;
}

/**
 * @brief 建看不见的会话（§9.6）、跑完这一次（converse），最后关闭。会话的操作出意外的错时算失败，先停下再关闭。
 * @param input 这次运行
 * @param material 材料与第一条消息
 * @param handle beginRun 的句柄（SessionSetup.memory.run）
 */
async function drive(input: RunInput, material: Material, handle: RunHandle): Promise<DriveResult> {
  // beginRun 期间已被停止：不再建会话
  if (input.signal.aborted) return { error: stopReason(input.signal), sessionFile: null, teamDir: null };
  const watcher = new RunWatcher(input.signal);
  let session: HeadlessSession;
  try {
    session = await startHeadless({ cwd: input.cwd, dir: join(projectDir(input.cwd).dir, 'sessions'),
      task: input.task, run: handle, scope: material.scope, pick: input.settings.pick,
      thinking: input.settings.thinking, team: input.settings.team, onEvent: (envelope) => watcher.onEvent(envelope) });
  } catch (error) {
    return { error: errorText(error), sessionFile: null, teamDir: null };
  }
  let error: string | null;
  try {
    error = await converse(input, material, session, watcher);
  } catch (failure) {
    error = errorText(failure);
    await stopQuietly(session);
  }
  await closeQuietly(session);
  return { error, sessionFile: session.sessionFile, teamDir: session.teamDir };
}

// ---- 结束：token、Notes、修订（§9.6、§9.8） ----

/**
 * @brief 关闭之后的 token 数（§9.6）：增强会话的文件与它 TaskBoard 目录 `sessions/` 下每个实例会话文件，
 *        按物理行读出、按 pi getSessionStats 的算法累加 input + output；文件不存在时算 0。
 */
async function runTokens(sessionFile: string | null, teamDir: string | null): Promise<number> {
  const instances = teamDir === null ? []
    : (await jsonlNames(join(teamDir, 'sessions'))).map((name) => join(teamDir, 'sessions', name));
  let total = 0;
  for (const file of [...(sessionFile === null ? [] : [sessionFile]), ...instances]) {
    total += sessionTokens(await fileLines(file));
  }
  return total;
}

/** @brief 助手消息的正文（text 块用换行连接）；不是助手消息时为 null。 */
function assistantText(entry: Record<string, unknown> | null): string | null {
  const message = entry?.type === 'message' ? entry.message as Record<string, unknown> | null : null;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null;
  return message.content.filter((block): block is { type: 'text'; text: string } =>
    block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

/**
 * @brief 增强会话本身最后一条助手消息的正文（§9.8 的 Notes；协作模式下也取增强会话本身的）。
 * @param sessionFile 增强会话的文件；没建会话时为 null
 * @return 没建会话、没有助手消息或最后一条的正文为空时为 null
 */
async function lastReply(sessionFile: string | null): Promise<string | null> {
  if (sessionFile === null) return null;
  const lines = await fileLines(sessionFile);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = assistantText(lines[index].entry);
    if (text !== null) return text.trim() || null;
  }
  return null;
}

/** @brief 交给它的反馈里最晚的 createdAt；没有反馈时为 null。 */
function latestFeedback(feedback: readonly ListedFeedback[]): string | null {
  let latest: string | null = null;
  for (const { feedback: item } of feedback) {
    if (latest === null || Date.parse(item.createdAt) > Date.parse(latest)) latest = item.createdAt;
  }
  return latest;
}

/** @brief 还没开始修订就失败的结果。 */
function failedBefore(input: RunInput, error: string): RunOutcome {
  console.error(`[kernel] the ${input.task} enhancement of ${input.day} in ${input.cwd} failed: ${error}`);
  return { status: 'failed', error, revision: null, counts: null, tokens: 0, keepRunning: false };
}

/**
 * @brief 结束修订（§9.8）：token 从文件累加，Notes 为增强会话最后一条回复（失败的运行同样：冲突与该进 AGENTS.md 的建议
 *        不丢；原因另记在 last.error 与进度事件里），没建会话或没有回复时为失败原因；endRun 定下状态；
 *        成功时交回每个会话的新水位与最晚的反馈时刻。
 */
async function finish(input: RunInput, material: Material, handle: RunHandle, run: DriveResult): Promise<RunOutcome> {
  if (run.error !== null) {
    console.error(`[kernel] the ${input.task} enhancement of ${input.day} in ${input.cwd} failed: ${run.error}`);
  }
  const tokens = await runTokens(run.sessionFile, run.teamDir);
  const notes = (await lastReply(run.sessionFile)) ?? run.error;
  let counts: RevisionCounts;
  try {
    ({ counts } = await endRun(handle, { status: run.error === null ? 'done' : 'failed', tokens, notes }));
  } catch (error) {
    // endRun 已记错误日志；修订仍是 running，enhance.json 的 running 留着：下次启动或这个任务下一次运行之前
    // 按 §9.10 收尾（enhance.ts 的 closeStale）
    return { status: 'failed', error: errorText(error), revision: handle.id, counts: null, tokens, keepRunning: true };
  }
  if (run.error !== null) {
    return { status: 'failed', error: run.error, revision: handle.id, counts, tokens, keepRunning: false };
  }
  const watermarks = Object.fromEntries(material.sessions.map((session) => [session.file, session.lastEntry]));
  return { status: 'done', revision: handle.id, counts, tokens, watermarks,
    feedbackSeen: latestFeedback(material.feedback) };
}

/**
 * @brief 跑一次增强（§9.5–§9.8）：选材料；没有会话时跳过；否则 beginRun（建会话之前）、记下 running（没记下时不建会话，
 *        按失败结束修订）、建看不见的会话并发出、等结束、关闭、累加 token、endRun。从不抛错：失败都在结果里。
 * @param input 项目、任务、日子、设置、任务状态、时钟、停止信号
 */
export async function runTask(input: RunInput): Promise<RunOutcome> {
  let material: Material | null;
  try {
    material = await gather(input);
  } catch (error) {
    return failedBefore(input, errorText(error));
  }
  if (material === null) return { status: 'skipped' };
  if (input.signal.aborted) return failedBefore(input, stopReason(input.signal));
  let handle: RunHandle;
  try {
    handle = await beginRun({ cwd: input.cwd, task: input.task, day: input.day, sessions: material.sessions.length,
      feedback: material.feedback.length });
  } catch (error) {
    return failedBefore(input, errorText(error));
  }
  try {
    await input.onBegin(handle.id);
  } catch (error) {
    // enhance.json 没记下这条修订：崩溃时 §9.10 找不到它，所以不建会话，现在就按失败定下（onBegin 已记日志）
    return finish(input, material, handle, { error: errorText(error), sessionFile: null, teamDir: null });
  }
  return finish(input, material, handle, await drive(input, material, handle));
}
