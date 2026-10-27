// Rewind 与 Undo（docs/specs/file-system.md §5.5–§5.11，后台进程第 9 件事“工作区”）：回到你的一条消息之前。
// 整个作业排在这个工作路径的快照队列里（snapshots.ts 的 inQueue）：在它之前排着的结束快照先把记录写完，
// 计划才看得到这次运行的 run、changes 记录。恢复代码：检查、保险快照 P、文件集合 F 与两种冲突（changed、overlap）、
// 先删再恢复（git restore --source --worktree，只改工作区，不碰你的 index；不用 git clean）、恢复后快照 Q（这次恢复的
// 文件不记给任何人）、写 mori.rewind，再在 rewind/<条目 id>/ 下建 P、Q 的 ref。恢复对话用 pi 的 navigateTree（同一个
// 会话文件，后面的轮次成为分支），成功后在新的当前分支末尾再记一条 mori.pick，然后才写 mori.rewind。
// Undo 从保险快照恢复那次恢复改了的文件，那次恢复过对话的回到原来的叶子。正在 Rewind 的会话记在 active 里，
// sessions.ts 据此拒绝 session.prompt。文件集合、冲突与 token 的纯函数在 timeline.ts；所有 git 调用经 git.ts
// （内部仓库的方式）；不监视、不轮询。

import type { Stats } from 'node:fs';
import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { SessionEntry, SessionManager, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { KernelEvent, QuoteRef } from '../shared/protocol';
import { ReceiptEntrySchema, TEAM_ENTRY_TYPES } from '../shared/team';
import {
  REWIND_LIST_LIMIT, RewindRecordSchema, WORKSPACE_ENTRY_TYPES,
  type ConflictChoice, type RewindConflict, type RewindRecord, type RewindResult, type RunRecord,
} from '../shared/workspace';
import { findGit, gitError, type GitResult } from './git';
import { contentText } from './modelContext';
import { insideDir } from './pathGate';
import {
  inQueue, keepRefs, PRUNED_TEXT, refsKept, snapshotGit, snapshotRepo, snapshotState, takeSnapshot,
} from './snapshots';
import {
  conflictsOf, conflictToken, fileSet, lastSnapshotOf, nulList, overlapFiles, parseRawNumstat, roundsFrom,
  splitRestore, turnEntries, turnNumbers, type TurnEntry,
} from './timeline';
import { readStatus } from './workspace';

// ---- 对外的接口 ----

/** @brief sessions.ts 给的会话接口（§5.5–§5.10）：一个打开的用户会话。 */
export interface RewindSession {
  /** 用户会话 id（pi 的 session id，内部仓库里 ref 的那一段） */
  sessionId: string;
  /** 工作路径 */
  cwd: string;
  /** 会话的 SessionManager：读当前分支与全部条目、写 mori.rewind */
  sessionManager: SessionManager;
  /** pi 的 AgentSession.navigateTree，不带 summarize（不发模型请求，§5.8） */
  navigateTree(targetId: string): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>;
  /** §5.5：有 Agent 在运行、排队或有待判断的消息（TeamState.busy；没有 Team 时为对话在运行或准备中） */
  busy(): boolean;
  /** BoardView.requests 里 status 为 open 的需求编号 */
  openRequests(): number[];
  /** modelSession.recordPick：在当前叶子之后把现在的选择范围再记一条 mori.pick（§5.8） */
  recordPick(): void;
  /** 这条消息的 mori.ref 引用；没有为 null */
  refsOf(entryId: string): QuoteRef[] | null;
  /** 在这个会话的信封上发事件 */
  emit(event: KernelEvent): void;
}

/** @brief rewind 命令的参数（§5.11）。 */
export interface RewindInput {
  /** 你的一条消息 M 的条目 id */
  entryId: string;
  /** 恢复代码 */
  code: boolean;
  /** 恢复对话 */
  conversation: boolean;
  /** 上一次结果是冲突时带回的选择；token 原样带回 */
  conflictChoice?: ConflictChoice;
}

/** @brief rewind.undo 命令的参数（§5.9）。 */
export interface UndoInput {
  /** 要撤销的 mori.rewind 的条目 id */
  undoId: string;
  /** 上一次结果是冲突时带回的选择 */
  conflictChoice?: ConflictChoice;
}

// ---- 原文与常量 ----

/** @brief 命令失败的原文（§5.5–§5.11、fs-rewind.md）。 */
const TEXTS = Object.freeze({
  stillRunning: 'This session is still running. Stop it first.',
  alreadyRewinding: 'This session is already rewinding.',
  nothingChosen: 'Choose code, conversation or both to restore.',
  notInConversation: 'This message isn’t in the conversation.',
  noCodeSnapshot: 'This message has no code snapshot.',
  paused: 'Snapshots are paused for this folder, so code can’t be restored.',
  gitRequired: 'Git is required to track changes and rewind.',
  noUndo: 'This rewind can no longer be undone.',
  noReply: 'This message has no reply to rewind.',
  cantReturn: 'Mori can’t return to where it was before the rewind.',
  cancelled: 'An extension cancelled moving the conversation.',
  outside: 'the path is outside the working directory',
  folderInWay: 'A folder is in the way.',
  fileInWay: 'A file is in the way.',
});

/** @brief 保险快照没拍成（§5.6 第 2 步）、恢复后快照没拍成时的开头。 */
const SNAPSHOT_FAILED = 'Couldn’t take a snapshot: ';

/** @brief 代码已恢复、对话没能恢复时 warning 的开头（§5.8、§5.9 第 5 步）。 */
const CONVERSATION_FAILED = 'Couldn’t restore the conversation: ';

/** @brief 快照里不恢复的条目：嵌套仓库（gitlink）与符号链接（§4.2）。 */
const SKIPPED_MODES: ReadonlySet<string> = new Set(['160000', '120000']);

/** @brief 内部仓库里被结束的 git 进程可能留下的锁（§4.1），refs/ 下的 *.lock 另外找。 */
const LOCK_FILES = ['index.lock', 'packed-refs.lock'];

// ---- 状态 ----

/** 正在 Rewind / Undo 的用户会话（§5.10） */
const active = new Set<string>();

/**
 * @brief 这个会话是否正在 Rewind / Undo（§5.10）：sessions.ts 据此拒绝 session.prompt。
 * @param sessionId 用户会话 id
 */
export function rewinding(sessionId: string): boolean {
  return active.has(sessionId);
}

// ---- 小工具 ----

/** @brief 一个没能恢复或删掉的文件。 */
interface FailedFile {
  /** 相对工作路径，/ 分隔 */
  path: string;
  /** git 或文件系统的原文 */
  error: string;
}

/** @brief 异常的原文。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 几条说明合成 warning；都没有时为 null。 */
function joinWarnings(warnings: readonly (string | null)[]): string | null {
  const kept = warnings.filter((warning): warning is string => warning !== null);
  return kept.length > 0 ? kept.join('\n') : null;
}

/** @brief 路径列表写成 --pathspec-from-file=- --pathspec-file-nul 的 stdin。 */
function nulInput(paths: readonly string[]): Buffer {
  return Buffer.from(paths.map((path) => `${path}\0`).join(''), 'utf8');
}

/**
 * @brief 一条自定义条目按 schema 读出数据；不是这种条目时为 null，不合法时记日志并跳过（§12）。
 * @param item 会话条目
 * @param customType 自定义条目的种类
 * @param schema 数据的 zod schema
 */
function customData<T>(item: SessionEntry, customType: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } }): T | null {
  if (item.type !== 'custom' || item.customType !== customType) return null;
  const parsed = schema.safeParse(item.data);
  if (parsed.success) return parsed.data;
  console.error(`[kernel] malformed ${customType} entry ${item.id} skipped`);
  return null;
}

/** @brief pi 的 navigateTree 会再退一步的条目：user 消息与 custom_message（§5.8）。 */
function stepsBack(item: SessionEntry): boolean {
  return item.type === 'custom_message' || (item.type === 'message' && item.message.role === 'user');
}

// ---- 目标消息与协作模式的限制 ----

/** @brief Rewind 的目标消息 M 在当前分支上的情况。 */
interface Target {
  /** 当前分支（从根到叶子） */
  branch: SessionEntry[];
  /** M 在 branch 里的位置 */
  index: number;
  /** M */
  entry: SessionMessageEntry;
  /** M 与它之后你的消息的条目 id（F 与“之后有改动”按它们，§5.5、§5.6） */
  rounds: Set<string>;
  /** M 是当前分支上第几条你的消息（通知里的 turn <n>） */
  turn: number;
  /** 当前分支上的 mori.turn_changes */
  records: TurnEntry[];
}

/** @brief 分支上合格的 mori.turn_changes；不合格的记日志并跳过。 */
function branchRecords(branch: readonly SessionEntry[]): TurnEntry[] {
  return turnEntries(branch, (id) => {
    console.error(`[kernel] malformed ${WORKSPACE_ENTRY_TYPES.turnChanges} entry ${id} skipped`);
  });
}

/**
 * @brief 在当前分支上找你的消息 M；不在、不是你的消息时报 This message isn’t in the conversation.
 * @param manager 会话的 SessionManager
 * @param entryId M 的条目 id
 */
function targetOf(manager: SessionManager, entryId: string): Target {
  const branch = manager.getBranch();
  const rounds = roundsFrom(branch, entryId);
  const index = branch.findIndex((item) => item.id === entryId);
  const turn = turnNumbers(branch).get(entryId);
  if (rounds === null || turn === undefined) throw new Error(TEXTS.notInConversation);
  const records = branchRecords(branch);
  return { branch, index, entry: branch[index] as SessionMessageEntry, rounds, turn, records };
}

/**
 * @brief 需求还开着时的原文（§5.5）：一个、两个（1 and 3）、三个以上用 Oxford 逗号（1, 2, and 3，ui-strings.md 写法约定）。
 * @param numbers 还开着的需求编号，从小到大
 */
function requestsText(numbers: readonly number[]): string {
  if (numbers.length === 1) {
    return `Request ${numbers[0]} is still open. The conversation can’t go back to before it was registered.`;
  }
  const last = numbers[numbers.length - 1];
  const list = numbers.length === 2 ? `${numbers[0]} and ${last}` : `${numbers.slice(0, -1).join(', ')}, and ${last}`;
  return `Requests ${list} are still open. The conversation can’t go back to before they were registered.`;
}

/**
 * @brief 协作模式的限制（§5.5）：当前分支上 M 或 M 之后有 registered 回执、而那个需求仍是 open 时，不能恢复对话。
 * @param session 会话
 * @param target M
 */
function checkRequests(session: RewindSession, target: Target): void {
  const open = new Set(session.openRequests());
  if (open.size === 0) return;
  const blocking = new Set<number>();
  for (const item of target.branch.slice(target.index)) {
    const receipt = customData(item, TEAM_ENTRY_TYPES.receipt, ReceiptEntrySchema);
    if (receipt?.kind === 'registered' && open.has(receipt.request)) blocking.add(receipt.request);
  }
  if (blocking.size > 0) throw new Error(requestsText([...blocking].sort((a, b) => a - b)));
}

// ---- 内部仓库的 git 调用（都在 inQueue 的作业里） ----

/** @brief 调用成功：退出码 0，没有超时、没有被截断、起得来。 */
function succeeded(result: GitResult): boolean {
  return result.code === 0 && !result.timedOut && !result.truncated && result.error === null;
}

/** @brief 异常的错误码（ENOENT 等）；没有为 undefined。 */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * @brief 删内部仓库里的一个锁文件。
 * @param dir 内部仓库
 * @param name 相对内部仓库的文件名
 * @return 删掉了为 true；本来就不在、或删不掉（记日志）为 false
 */
async function dropLock(dir: string, name: string): Promise<boolean> {
  try {
    await rm(join(dir, name));
    return true;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      console.error(`[kernel] rewind: couldn't remove ${name} in ${dir}: ${errorText(error)}`);
    }
    return false;
  }
}

/**
 * @brief 内部仓库被 Mori 结束的 git 进程留下的锁（§4.1）：删掉 index.lock、packed-refs.lock 与 refs/ 下的 *.lock，
 *        否则同一个作业里随后的恢复后快照与之后每张快照都失败（快照模块只在作业之间清它自己结束的进程留下的锁）。
 *        在这个工作路径的队列里做，没有别的进程在用这些锁。真的删掉了才写一行日志，列出删掉的文件。
 * @param dir 内部仓库
 */
async function dropLocks(dir: string): Promise<void> {
  let refLocks: string[] = [];
  try {
    refLocks = (await readdir(join(dir, 'refs'), { recursive: true }))
      .filter((name) => name.endsWith('.lock')).map((name) => join('refs', name));
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      console.error(`[kernel] rewind: couldn't list the refs of ${dir}: ${errorText(error)}`);
    }
  }
  const removed: string[] = [];
  for (const name of [...LOCK_FILES, ...refLocks]) {
    if (await dropLock(dir, name)) removed.push(name);
  }
  if (removed.length > 0) console.log(`[kernel] rewind: removed stale lock files in ${dir}: ${removed.join(', ')}`);
}

/**
 * @brief 内部仓库的一次调用（§3.3、§4.2，snapshots.ts 的 snapshotGit）：固定前缀、隔离配置、进程 cwd 为工作路径、
 *        每个进程 120 秒、stdout 16 MB；超时被结束时先删掉它留下的锁。
 * @param cwd 工作路径
 * @param args 子命令与参数（全局选项如 --literal-pathspecs 放在最前）
 * @param stdin 写进 stdin 的内容；没有时省略
 */
async function internalGit(cwd: string, args: string[], stdin?: Buffer): Promise<GitResult> {
  const result = await snapshotGit(cwd, args, stdin === undefined ? {} : { stdin });
  if (result.timedOut) await dropLocks(snapshotRepo(cwd));
  return result;
}

/** @brief 内部仓库的一次调用，返回 stdout；失败时记日志并以 git 的原文抛错。 */
async function gitOutput(cwd: string, args: string[]): Promise<Buffer> {
  const result = await internalGit(cwd, args);
  if (succeeded(result)) return result.stdout;
  const error = gitError(result);
  console.error(`[kernel] rewind: git ${args[0]} failed in ${cwd}: ${error}`);
  throw new Error(error);
}

/**
 * @brief 两张快照之间改动的文件（§5.6 第 3、4 步、§5.9 第 2、3 步）：git diff --no-renames --raw -z，
 *        去掉嵌套仓库与符号链接（§4.2，这两种不列、不恢复；timeline.ts 的 parseRawNumstat）。
 * @param cwd 工作路径
 * @param from 前一张快照的提交
 * @param to 后一张快照的提交
 * @return 相对工作路径的路径（/ 分隔），按路径排序
 */
async function changedPaths(cwd: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const output = await gitOutput(cwd, ['diff', '--no-renames', '--raw', '-z', from, to]);
  return parseRawNumstat(output).map((file) => file.path);
}

/**
 * @brief 一张快照里的全部条目与 mode（§5.7 第 1 步）：git ls-tree -r -z（在工作路径里跑，路径相对工作路径）。
 * @param cwd 工作路径
 * @param commit 快照的提交
 */
async function treeModes(cwd: string, commit: string): Promise<Map<string, string>> {
  const modes = new Map<string, string>();
  for (const item of nulList(await gitOutput(cwd, ['ls-tree', '-r', '-z', commit]))) {
    const tab = item.indexOf('\t');
    if (tab > 0) modes.set(item.slice(tab + 1), item.slice(0, item.indexOf(' ')));
  }
  return modes;
}

/**
 * @brief 保住 Rewind / Undo 用到的快照（§4.7、§5.7 第 5 步）：refs/mori/s/<会话 id>/rewind/<条目 id>/<提交>，
 *        经 snapshots.ts 的 keepRefs 一次写完。写不进时只记日志：记录已经写下，提交在下一次整理前仍在。
 * @param session 会话
 * @param entryId mori.rewind 的条目 id
 * @param commits P 与 Q（Q 没拍成为 null）
 */
async function keepSnapshots(session: RewindSession, entryId: string, commits: readonly (string | null)[]):
  Promise<void> {
  const unique = [...new Set(commits.filter((commit): commit is string => commit !== null))];
  if (unique.length === 0) return;
  const error = await keepRefs(session.cwd, session.sessionId, `rewind/${entryId}`, unique);
  if (error !== null) console.error(`[kernel] rewind: couldn't keep the snapshots of ${entryId}: ${error}`);
}

// ---- 计划与冲突（§5.6） ----

/** @brief 快照不是 paused、off 才能恢复代码（§5.6 第 1 步）。 */
function checkSnapshots(cwd: string): void {
  const state = snapshotState(cwd);
  if (state.state === 'paused') throw new Error(TEXTS.paused);
  if (state.state === 'off') throw new Error(state.reason ?? TEXTS.gitRequired);
}

/**
 * @brief 基准 B（§5.6 第 1 步）：当前分支上 round 为 M 的 run 记录的 start；它在 refs/mori/s/<会话 id>/<M>/ 下的 ref
 *        要还在（§4.7，否则 PRUNED_TEXT）。
 * @param session 会话
 * @param target M
 */
async function baseOf(session: RewindSession, target: Target): Promise<string> {
  const runs = target.records.map(({ record }) => record)
    .filter((record): record is RunRecord => record.kind === 'run' && record.round === target.entry.id);
  const run = runs[runs.length - 1];
  if (run === undefined) throw new Error(TEXTS.noCodeSnapshot);
  if (!(await refsKept(session.cwd, session.sessionId, run.round, [run.start]))) throw new Error(PRUNED_TEXT);
  return run.start;
}

/**
 * @brief 文件集合 F 与 overlap 的来源（§5.6 第 3、4 步）：M 起各段记录的文件之并；total 多于 files 的记录用 git 补全，
 *        补全的文件在 overlap 记录里时同样算 overlap。Undo 重算那次 Rewind 的 F 时同样用它（§5.9 第 2 步）。
 * @param cwd 工作路径
 * @param records 分支上的 mori.turn_changes
 * @param rounds M 与它之后你的消息的条目 id
 */
async function filesOf(cwd: string, records: readonly TurnEntry[], rounds: ReadonlySet<string>):
  Promise<{ files: Set<string>; overlap: Set<string> }> {
  const { files, incomplete } = fileSet(records, rounds);
  const overlap = overlapFiles(records, rounds);
  for (const record of incomplete) {
    for (const path of await changedPaths(cwd, record.base, record.head)) {
      files.add(path);
      if (record.overlap) overlap.add(path);
    }
  }
  return { files, overlap };
}

/**
 * @brief Rewind 的冲突（§5.6 第 4 步）：changed = F 里在这个会话最近一张快照 L 之后又变了的（L 到 P 的改动）；
 *        overlap = F 里出现在 overlap 记录里的；两种都是时记 changed。按路径排序。
 * @param session 会话
 * @param plan F 与 overlap 的来源
 * @param safety 保险快照 P
 */
async function rewindConflicts(session: RewindSession, plan: { files: Set<string>; overlap: Set<string> },
  safety: string): Promise<RewindConflict[]> {
  const last = lastSnapshotOf(session.sessionManager.getEntries());
  const changed = last === null || plan.files.size === 0 ? [] : await changedPaths(session.cwd, last, safety);
  return conflictsOf(plan.files, new Set(changed), plan.overlap);
}

// ---- 恢复（§5.7、§5.9 第 4 步） ----

/** @brief 恢复的结果：恢复的、删掉的、失败的文件（全部，写记录时再截）。 */
interface RestoredFiles {
  /** 写回来源快照内容的文件（相对工作路径） */
  restored: string[];
  /** 来源快照里没有、被删掉的文件 */
  deleted: string[];
  /** 恢复或删除失败的文件与原文 */
  failed: FailedFile[];
}

/**
 * @brief 删掉来源快照里没有的文件（§5.7 第 2 步）：逐个 fs.rm，不递归；已经不在的跳过；留下的空目录不删。
 * @param cwd 工作路径
 * @param paths 要删的文件（相对工作路径）
 * @param failed 失败的记进这里
 * @return 删掉的文件
 */
async function removeFiles(cwd: string, paths: readonly string[], failed: FailedFile[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const path of paths) {
    const target = resolve(cwd, path);
    if (!insideDir(cwd, target) || relative(cwd, target) === '') {
      failed.push({ path, error: TEXTS.outside });
      continue;
    }
    try {
      await rm(target);
      deleted.push(path);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      console.error(`[kernel] rewind: couldn't delete ${path} in ${cwd}: ${errorText(error)}`);
      failed.push({ path, error: errorText(error) });
    }
  }
  return deleted;
}

/** @brief lstat 一个路径（不跟随符号链接与 junction）；不在时为 null，其他错误照抛。 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** @brief 目录里是不是只有目录（递归；文件、符号链接、junction 都不算目录）。 */
async function onlyFolders(dir: string): Promise<boolean> {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (!item.isDirectory() || !(await onlyFolders(join(dir, item.name)))) return false;
  }
  return true;
}

/** @brief 自下而上删掉只剩空目录的目录（逐个 rmdir，不递归删；这期间有了文件时 rmdir 失败照抛）。 */
async function removeFolders(dir: string): Promise<void> {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) await removeFolders(join(dir, item.name));
  }
  await rmdir(dir);
}

/**
 * @brief 恢复一个文件时挡路的东西（§5.7 第 2、3 步“没有记下的文件一律不动”）：git restore 会整个删掉挡在文件位置上的目录、
 *        删掉挡在上级位置上的文件，所以先看。上级里有存在而不是真目录的（文件、符号链接、junction）→ A file is in the way.；
 *        文件位置上是目录时只删其中的空目录（例如记录里文件改成目录、目录里记下的文件刚删掉，留下空目录），
 *        还有别的东西 → A folder is in the way.
 * @param cwd 工作路径
 * @param path 要恢复的文件（相对工作路径）
 * @param dirs 已经看过是真目录的上级（绝对路径），跨文件复用
 * @return 挡路时的原文；不挡路为 null
 */
async function blockerOf(cwd: string, path: string, dirs: Set<string>): Promise<string | null> {
  const target = resolve(cwd, path);
  const inside = relative(cwd, target);
  if (!insideDir(cwd, target) || inside === '') return TEXTS.outside;
  const parts = inside.split(sep);
  for (let i = 1; i < parts.length; i += 1) {
    const parent = join(cwd, ...parts.slice(0, i));
    if (dirs.has(parent)) continue;
    const stats = await lstatOrNull(parent);
    if (stats === null) return null;
    if (!stats.isDirectory()) return TEXTS.fileInWay;
    dirs.add(parent);
  }
  const stats = await lstatOrNull(target);
  if (stats === null || !stats.isDirectory()) return null;
  if (!(await onlyFolders(target))) return TEXTS.folderInWay;
  await removeFolders(target);
  return null;
}

/**
 * @brief 交给 git restore 之前去掉挡路的文件（§5.7 第 2、3 步）：挡路的不恢复、记进 failed 并记日志，
 *        批量与逐个再试都只用剩下的。
 * @param cwd 工作路径
 * @param paths 来源快照里有的文件
 * @param failed 挡路的记进这里
 * @return 可以交给 git restore 的文件
 */
async function clearPaths(cwd: string, paths: readonly string[], failed: FailedFile[]): Promise<string[]> {
  const clear: string[] = [];
  const dirs = new Set<string>();
  for (const path of paths) {
    let error: string | null;
    try {
      error = await blockerOf(cwd, path, dirs);
    } catch (caught) {
      error = errorText(caught);
    }
    if (error === null) {
      clear.push(path);
      continue;
    }
    console.error(`[kernel] rewind: not restoring ${path} in ${cwd}: ${error}`);
    failed.push({ path, error });
  }
  return clear;
}

/**
 * @brief 从来源快照恢复文件（§5.7 第 3 步）：git --literal-pathspecs restore --source --worktree，路径经 stdin 传；
 *        整批失败（例如一个文件被别的程序锁着）时逐个再试，失败的记进 failed。
 * @param cwd 工作路径
 * @param source 来源快照的提交
 * @param paths 来源快照里有的文件
 * @param failed 失败的记进这里
 * @return 恢复了的文件
 */
async function checkoutFiles(cwd: string, source: string, paths: readonly string[], failed: FailedFile[]):
  Promise<string[]> {
  if (paths.length === 0) return [];
  const restore = ['--literal-pathspecs', 'restore', `--source=${source}`, '--worktree'];
  const batch = await internalGit(cwd, [...restore, '--pathspec-from-file=-', '--pathspec-file-nul'], nulInput(paths));
  if (succeeded(batch)) return [...paths];
  console.error(`[kernel] rewind: restoring ${paths.length} files in ${cwd} failed (${gitError(batch)}); `
    + 'retrying one by one');
  const restored: string[] = [];
  for (const path of paths) {
    const one = await internalGit(cwd, [...restore, '--', path]);
    if (succeeded(one)) restored.push(path);
    else failed.push({ path, error: gitError(one) });
  }
  return restored;
}

/**
 * @brief 把恢复集合恢复到来源快照（§5.7 第 1–3 步）：来源里没有的先删，再恢复来源里有的（Windows 不分大小写，
 *        先恢复再删会删掉刚恢复的文件）；来源里是嵌套仓库、符号链接的不动；有东西挡路的不恢复（clearPaths）。
 *        没有记下的文件一律不碰。
 * @param cwd 工作路径
 * @param source 来源快照（B，或 Undo 时的 safety）
 * @param paths 恢复集合 R
 */
async function restoreFiles(cwd: string, source: string, paths: readonly string[]): Promise<RestoredFiles> {
  const failed: FailedFile[] = [];
  if (paths.length === 0) return { restored: [], deleted: [], failed };
  const modes = await treeModes(cwd, source);
  const kept = paths.filter((path) => !SKIPPED_MODES.has(modes.get(path) ?? ''));
  const { restore, remove } = splitRestore(kept, new Set(modes.keys()));
  const deleted = await removeFiles(cwd, remove, failed);
  const restored = await checkoutFiles(cwd, source, await clearPaths(cwd, restore, failed), failed);
  return { restored, deleted, failed };
}

/** @brief 一次恢复代码的计划：来源、集合、冲突与保险快照。 */
interface CodePlan {
  /** 来源快照：B（Rewind）或那次 Rewind 的 safety（Undo） */
  source: string;
  /** 文件集合：F（Rewind）或 U（Undo） */
  files: ReadonlySet<string>;
  /** 全部冲突，按路径排序 */
  conflicts: RewindConflict[];
  /** 这次的保险快照：P（Rewind）或 P'（Undo） */
  safety: string;
}

/** @brief 一次恢复代码做完的结果。 */
interface CodeOutcome extends RestoredFiles {
  /** 固定为 code：恢复了代码 */
  kind: 'code';
  /** 保险快照 */
  safety: string;
  /** 恢复后快照；没拍成为 null */
  post: string | null;
  /** 选了 Skip these files 时跳过的冲突文件（全部） */
  skipped: string[];
  /** 恢复后快照没拍成的说明；拍成为 null */
  warning: string | null;
}

/** @brief rewind 返回冲突时的结果。 */
type ConflictsResult = Extract<RewindResult, { kind: 'conflicts' }>;

/** @brief 保险快照（§5.6 第 2 步、§5.9 第 1 步）：在这个作业里拍一张；没拍成时命令失败，什么都不改。 */
async function safetySnapshot(cwd: string): Promise<string> {
  const result = await takeSnapshot(cwd, null);
  if ('oid' in result) return result.oid;
  console.error(`[kernel] rewind: the safety snapshot failed in ${cwd}: ${result.error}`);
  throw new Error(`${SNAPSHOT_FAILED}${result.error}`);
}

/**
 * @brief 冲突的处理与恢复（§5.6 第 5、6 步、§5.7 第 1–4 步）：有冲突而没带选择、或 token 不同时返回冲突（什么都不改）；
 *        否则恢复集合 R = 集合（overwrite）或去掉冲突（skip），恢复后再拍 Q（R 不记给任何人）。
 * @param cwd 工作路径
 * @param plan 计划
 * @param choice 带回的冲突选择
 */
async function applyCode(cwd: string, plan: CodePlan, choice: ConflictChoice | undefined):
  Promise<CodeOutcome | ConflictsResult> {
  const token = conflictToken(plan.conflicts);
  if (plan.conflicts.length > 0 && choice?.token !== token) {
    return { kind: 'conflicts', conflicts: plan.conflicts.slice(0, REWIND_LIST_LIMIT), total: plan.conflicts.length,
      token };
  }
  const skipped = plan.conflicts.length > 0 && choice?.action === 'skip' ? plan.conflicts.map((item) => item.path) : [];
  const skip = new Set(skipped);
  const restoring = [...plan.files].filter((path) => !skip.has(path)).sort();
  const files = await restoreFiles(cwd, plan.source, restoring);
  const post = await takeSnapshot(cwd, new Set(restoring));
  if ('oid' in post) return { kind: 'code', safety: plan.safety, post: post.oid, skipped, warning: null, ...files };
  console.error(`[kernel] rewind: the snapshot after restoring failed in ${cwd}: ${post.error}`);
  return { kind: 'code', safety: plan.safety, post: null, skipped, warning: `${SNAPSHOT_FAILED}${post.error}`,
    ...files };
}

// ---- 对话（§5.8、§5.9 第 5 步） ----

/** @brief 移动对话的结果：成功时带移动前的叶子与回到输入框的文字。 */
type Moved = { ok: true; from: string | null; editorText: string | null } | { ok: false; error: string };

/** @brief 在新的当前分支末尾再记一条 mori.pick（§5.8）；记不下只记日志，Rewind 照样算完成。 */
function recordPick(session: RewindSession): void {
  try {
    session.recordPick();
  } catch (error) {
    console.error(`[kernel] rewind: couldn't record the model pick in ${session.sessionId}: ${errorText(error)}`);
  }
}

/**
 * @brief 调 pi 的 navigateTree（不带 summarize）；扩展取消或 pi 抛错时给出原文。
 * @param session 会话
 * @param targetId 目标条目
 */
async function navigate(session: RewindSession, targetId: string):
  Promise<{ ok: true; editorText: string | undefined } | { ok: false; error: string }> {
  try {
    const result = await session.navigateTree(targetId);
    if (result.cancelled) return { ok: false, error: TEXTS.cancelled };
    return { ok: true, editorText: result.editorText };
  } catch (error) {
    console.error(`[kernel] rewind: navigateTree failed in ${session.sessionId}: ${errorText(error)}`);
    return { ok: false, error: errorText(error) };
  }
}

/**
 * @brief 恢复对话的目标（§5.8）：平时传 M；M 恰是当前叶子时 pi 什么都不做，改传 M 的父条目，
 *        父条目是 user 消息、custom_message（pi 会再退一步）或没有父条目时为 null（This message has no reply to rewind.）。
 * @param manager 会话的 SessionManager
 * @param entry M
 */
function conversationGoal(manager: SessionManager, entry: SessionMessageEntry): string | null {
  if (manager.getLeafId() !== entry.id) return entry.id;
  const parent = entry.parentId === null ? undefined : manager.getEntry(entry.parentId);
  if (parent === undefined || stepsBack(parent)) return null;
  return parent.id;
}

/**
 * @brief 恢复对话（§5.8）：navigateTree 到 M 之前，成功后再记一条 mori.pick；editorText 为 M 的正文
 *        （导航到父条目时 pi 不给，自己取：字符串原样，数组取 text 块拼接）。
 * @param session 会话
 * @param target M
 */
async function moveConversation(session: RewindSession, target: Target): Promise<Moved> {
  const from = session.sessionManager.getLeafId();
  const goal = conversationGoal(session.sessionManager, target.entry);
  if (goal === null) return { ok: false, error: TEXTS.noReply };
  const result = await navigate(session, goal);
  if (!result.ok) return result;
  recordPick(session);
  const text = result.editorText ?? contentText((target.entry.message as { content?: unknown }).content);
  return { ok: true, from, editorText: text };
}

/**
 * @brief Undo 时回到 Rewind 之前的叶子（§5.9 第 5 步）：from 是 user 消息、custom_message 或已不在时不导航
 *        （Mori can’t return to where it was before the rewind.）；成功后再记一条 mori.pick。Undo 不给 editorText。
 * @param session 会话
 * @param from 那次 Rewind 记下的叶子
 */
async function returnConversation(session: RewindSession, from: string): Promise<Moved> {
  const entry = session.sessionManager.getEntry(from);
  if (entry === undefined || stepsBack(entry)) return { ok: false, error: TEXTS.cantReturn };
  const leaf = session.sessionManager.getLeafId();
  const result = await navigate(session, from);
  if (!result.ok) return result;
  recordPick(session);
  return { ok: true, from: leaf, editorText: null };
}

// ---- 记录与结果（§5.9、§5.11） ----

/** @brief 写一条 mori.rewind 要的各部分。 */
interface RecordParts {
  /** rewind 或 undo */
  kind: RewindRecord['kind'];
  /** rewind：M；undo：撤销的那条 mori.rewind */
  target: string;
  /** rewind：M 是第几轮；undo 为 null */
  turn: number | null;
  /** 对话怎样了；没有恢复对话为 null */
  moved: Moved | null;
  /** 恢复代码的结果；只恢复对话为 null */
  code: CodeOutcome | null;
}

/** @brief mori.rewind 的内容：各列表最多 REWIND_LIST_LIMIT 条，另记总数。 */
function makeRecord(parts: RecordParts): RewindRecord {
  const code = parts.code;
  const moved = parts.moved !== null && parts.moved.ok ? parts.moved : null;
  const restored = code?.restored ?? [];
  const deleted = code?.deleted ?? [];
  const skipped = code?.skipped ?? [];
  const failed = code?.failed ?? [];
  return {
    v: 1, kind: parts.kind, target: parts.target, turn: parts.turn, code: code !== null,
    conversation: moved !== null, from: moved?.from ?? null, safety: code?.safety ?? null, post: code?.post ?? null,
    restored: restored.slice(0, REWIND_LIST_LIMIT), deleted: deleted.slice(0, REWIND_LIST_LIMIT),
    skipped: skipped.slice(0, REWIND_LIST_LIMIT), failed: failed.slice(0, REWIND_LIST_LIMIT),
    counts: { restored: restored.length, deleted: deleted.length, skipped: skipped.length, failed: failed.length },
    at: Date.now(),
  };
}

/**
 * @brief 写下 mori.rewind（恢复对话时在新的叶子之后）、发同名事件，再建 P、Q 的 ref（条目 id 这时才有，§5.7 第 5 步），
 *        返回 done 的结果：warning 合并恢复后快照没拍成与对话没能恢复两种说明，entries 在恢复了对话时为新的当前分支。
 * @param session 会话
 * @param parts 记录的各部分
 * @param result 回到输入框的文字与 M 的引用（没有恢复对话时都为 null）
 */
async function finish(session: RewindSession, parts: RecordParts,
  result: { editorText: string | null; refs: QuoteRef[] | null }): Promise<RewindResult> {
  const record = makeRecord(parts);
  const entryId = session.sessionManager.appendCustomEntry(WORKSPACE_ENTRY_TYPES.rewind, record);
  session.emit({ type: 'mori.rewind', entryId, record });
  if (parts.code !== null) await keepSnapshots(session, entryId, [parts.code.safety, parts.code.post]);
  const moved = parts.moved;
  const warning = joinWarnings([parts.code?.warning ?? null,
    moved !== null && !moved.ok ? `${CONVERSATION_FAILED}${moved.error}` : null]);
  const entries = record.conversation ? session.sessionManager.getBranch() : null;
  return { kind: 'done', entryId, record, editorText: result.editorText, refs: result.refs, entries, warning };
}

/** @brief Rewind、Undo 改了文件之后照 §3.5 刷新 git 状态（结果发给这个工作路径上的用户会话）。 */
function refreshStatus(cwd: string): void {
  readStatus(cwd).catch((error: unknown) => {
    console.error(`[kernel] rewind: couldn't refresh the git status of ${cwd}: ${errorText(error)}`);
  });
}

// ---- Rewind 与 Undo ----

/**
 * @brief Rewind / Undo 的外层（§5.5、§5.10）：正在 Rewind 时拒绝（This session is already rewinding.）、会话忙时拒绝，
 *        从开始到返回把会话记在 active 里；git 要是 ok。
 * @param session 会话
 * @param work 检查之后要做的事
 */
async function whileRewinding(session: RewindSession, work: () => Promise<RewindResult>): Promise<RewindResult> {
  if (active.has(session.sessionId)) throw new Error(TEXTS.alreadyRewinding);
  if (session.busy()) throw new Error(TEXTS.stillRunning);
  active.add(session.sessionId);
  try {
    if ((await findGit()).state !== 'ok') throw new Error(TEXTS.gitRequired);
    return await work();
  } finally {
    active.delete(session.sessionId);
  }
}

/**
 * @brief Rewind 在队列里的作业（§5.6–§5.9）：找 M、协作模式的限制；只恢复对话时导航后写记录；恢复代码时
 *        检查、P、F 与冲突、恢复与 Q，然后（要的话）恢复对话、写记录与 ref。M 的引用在导航之前取：
 *        之后它的 mori.ref 条目就不在当前分支上了。
 * @param session 会话
 * @param input 命令参数
 */
async function rewindJob(session: RewindSession, input: RewindInput): Promise<RewindResult> {
  const target = targetOf(session.sessionManager, input.entryId);
  if (input.conversation) checkRequests(session, target);
  const parts = { kind: 'rewind' as const, target: target.entry.id, turn: target.turn };
  const refs = input.conversation ? session.refsOf(target.entry.id) : null;
  if (!input.code) {
    const moved = await moveConversation(session, target);
    if (!moved.ok) throw new Error(moved.error);
    return finish(session, { ...parts, moved, code: null }, { editorText: moved.editorText, refs });
  }
  checkSnapshots(session.cwd);
  const base = await baseOf(session, target);
  const safety = await safetySnapshot(session.cwd);
  const plan = await filesOf(session.cwd, target.records, target.rounds);
  const conflicts = await rewindConflicts(session, plan, safety);
  const code = await applyCode(session.cwd, { source: base, files: plan.files, conflicts, safety },
    input.conflictChoice);
  if (code.kind === 'conflicts') return code;
  const moved = input.conversation ? await moveConversation(session, target) : null;
  const done = moved !== null && moved.ok ? moved : null;
  return finish(session, { ...parts, moved, code }, { editorText: done?.editorText ?? null, refs: done ? refs : null });
}

/**
 * @brief Rewind（§5.5–§5.11）：回到你的一条消息 M 之前，恢复代码、对话或两者；有冲突时返回冲突，带着 token 相同的
 *        选择再调一次才恢复。不能做时命令失败，原文见 §5.11。
 * @param session 会话
 * @param input 命令参数
 */
export async function rewind(session: RewindSession, input: RewindInput): Promise<RewindResult> {
  return whileRewinding(session, async () => {
    if (!input.code && !input.conversation) throw new Error(TEXTS.nothingChosen);
    const result = await inQueue(session.cwd, () => rewindJob(session, input), session.sessionId);
    if (input.code && result.kind === 'done') refreshStatus(session.cwd);
    return result;
  });
}

/** @brief 能撤销的那次 Rewind。 */
interface UndoTarget {
  /** 它的 mori.rewind 条目 id */
  entryId: string;
  /** 它的保险快照 P */
  safety: string;
  /** 它的恢复后快照 Q */
  post: string;
  /** 它恢复对话前的叶子；没有恢复对话为 null */
  from: string | null;
  /** 它的记录：U 按其中那次恢复的集合收窄（§5.9 第 2 步） */
  record: RewindRecord;
}

/**
 * @brief 找能撤销的 Rewind（§5.9）：当前分支上的 kind rewind、code 为真、P 与 Q 都在的记录，是当前分支上最后一条
 *        mori.rewind，它之后当前分支上没有消息条目，会话文件里没有 undo 指向它；否则 This rewind can no longer be undone.
 * @param manager 会话的 SessionManager
 * @param undoId 那条 mori.rewind 的条目 id
 */
function undoTargetOf(manager: SessionManager, undoId: string): UndoTarget {
  const branch = manager.getBranch();
  const index = branch.findIndex((item) => item.id === undoId);
  const record = index < 0 ? null : customData(branch[index], WORKSPACE_ENTRY_TYPES.rewind, RewindRecordSchema);
  if (record === null || record.kind !== 'rewind' || !record.code || record.safety === null || record.post === null) {
    throw new Error(TEXTS.noUndo);
  }
  const followed = branch.slice(index + 1).some((item) => item.type === 'message'
    || (item.type === 'custom' && item.customType === WORKSPACE_ENTRY_TYPES.rewind));
  const undone = manager.getEntries().some((item) => {
    const other = customData(item, WORKSPACE_ENTRY_TYPES.rewind, RewindRecordSchema);
    return other?.kind === 'undo' && other.target === undoId;
  });
  if (followed || undone) throw new Error(TEXTS.noUndo);
  return { entryId: undoId, safety: record.safety, post: record.post, from: record.from, record };
}

/** @brief Undo 的集合（§5.9 第 2、3 步）。 */
interface UndoFiles {
  /** U：那次恢复实际改了的文件 */
  files: Set<string>;
  /** U 里说不准是不是那次恢复改的（记录的列表被截断时），作为 overlap 冲突问你 */
  unsure: Set<string>;
}

/** @brief 记录里这一种文件列全了（总数不多于列出的，REWIND_LIST_LIMIT）。 */
function listedAll(record: RewindRecord, key: 'restored' | 'deleted' | 'skipped' | 'failed'): boolean {
  return record.counts[key] <= record[key].length;
}

/**
 * @brief 重算那次 Rewind 的文件集合 F（§5.6 第 3 步）：用它当时的分支——恢复过对话的是到 from 的旧分支，
 *        只恢复代码的是到那条 mori.rewind 的分支——上 M 起的记录。
 * @param session 会话
 * @param undo 那次 Rewind
 * @return F；M 不在那条分支上（例如旧叶子已不在）时记日志并为 null
 */
async function rewindFiles(session: RewindSession, undo: UndoTarget): Promise<Set<string> | null> {
  const branch = session.sessionManager.getBranch(undo.from ?? undo.entryId);
  const rounds = roundsFrom(branch, undo.record.target);
  if (rounds === null) {
    console.error(`[kernel] rewind: message ${undo.record.target} of ${undo.entryId} isn't on its branch`);
    return null;
  }
  return (await filesOf(session.cwd, branchRecords(branch), rounds)).files;
}

/**
 * @brief Undo 的集合 U（§5.9 第 2 步）：safety 到 post 改了的文件与那次恢复的集合之交。这一段里同一工作路径上别的会话
 *        改的文件记给了它们（§5.7 第 4 步），Undo 不动。恢复的、删掉的都列全时，恢复集合就是这两个列表；有被截断的，
 *        重算那次的 F，去掉列出的跳过、失败的；跳过或失败的也被截断、或 F 重算不出时，不在恢复、删掉列表里的说不准，
 *        进 unsure（作为 overlap 问你，不悄悄恢复也不悄悄丢下）。
 * @param session 会话
 * @param undo 那次 Rewind
 */
async function undoFiles(session: RewindSession, undo: UndoTarget): Promise<UndoFiles> {
  const { record } = undo;
  const changed = await changedPaths(session.cwd, undo.safety, undo.post);
  const known = new Set([...record.restored, ...record.deleted]);
  const complete = listedAll(record, 'restored') && listedAll(record, 'deleted');
  const recomputed = complete ? new Set<string>() : await rewindFiles(session, undo);
  const others = recomputed ?? new Set(changed);
  const excluded = new Set([...record.skipped, ...record.failed.map((item) => item.path)]);
  const sure = recomputed !== null && listedAll(record, 'skipped') && listedAll(record, 'failed');
  const files = new Set<string>();
  const unsure = new Set<string>();
  for (const path of changed) {
    if (known.has(path)) {
      files.add(path);
    } else if (others.has(path) && !excluded.has(path)) {
      files.add(path);
      if (!sure) unsure.add(path);
    }
  }
  const left = changed.length - files.size;
  if (left > 0) console.log(`[kernel] rewind: undo of ${undo.entryId} leaves ${left} files of other sessions alone`);
  return { files, unsure };
}

/**
 * @brief Undo 在队列里的作业（§5.9）：P'、U、冲突（post 之后又变了的为 changed，说不准的为 overlap）、从 safety 恢复与 Q'，
 *        那次恢复过对话的回到原来的叶子，再写 kind undo 的记录与 ref。
 * @param session 会话
 * @param input 命令参数
 */
async function undoJob(session: RewindSession, input: UndoInput): Promise<RewindResult> {
  const undo = undoTargetOf(session.sessionManager, input.undoId);
  checkSnapshots(session.cwd);
  const safety = await safetySnapshot(session.cwd);
  const { files, unsure } = await undoFiles(session, undo);
  const changedSince = new Set(await changedPaths(session.cwd, undo.post, safety));
  const conflicts = conflictsOf(files, changedSince, unsure);
  const code = await applyCode(session.cwd, { source: undo.safety, files, conflicts, safety }, input.conflictChoice);
  if (code.kind === 'conflicts') return code;
  const moved = undo.from === null ? null : await returnConversation(session, undo.from);
  return finish(session, { kind: 'undo', target: undo.entryId, turn: null, moved, code },
    { editorText: null, refs: null });
}

/**
 * @brief Undo（§5.9）：撤销一次恢复了代码的 Rewind（恢复过对话的同时回到原来的分支）；结果同 rewind。
 *        能不能撤销由界面按 §5.9 显示，后台进程同样检查（This rewind can no longer be undone.）。
 * @param session 会话
 * @param input 命令参数
 */
export async function undoRewind(session: RewindSession, input: UndoInput): Promise<RewindResult> {
  return whileRewinding(session, async () => {
    const result = await inQueue(session.cwd, () => undoJob(session, input), session.sessionId);
    if (result.kind === 'done') refreshStatus(session.cwd);
    return result;
  });
}
