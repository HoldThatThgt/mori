// 右栏 Changes 与顶栏 +N −M 的状态（docs/specs/file-system.md §3.5、§5.1–§5.4，状态表 docs/v1/screens/fs-changes.md）：
// 每个会话最近一次的 git 状态（workspace.status 的结果与 mori.workspace_status 事件）与界面要 git 状态的时机、
// This session 按轮的归组（只从当前分支上的 mori.turn_changes 算，不向后台进程要列表）、顶栏的行数、阅读器重读的依据、
// 一轮里一个文件的 diff（snapshots.diff），以及右栏各行的文字。不监视、不轮询：只在 §3.5 表里界面的几个时机发命令。

import { roleLabel } from '../../../shared/team';
import type {
  ChangedFile, ChangesRecord, RunAgent, SnapshotDiff, SnapshotState, StatusFile, WorkspaceStatus,
} from '../../../shared/workspace';
import { pathKey } from '../components/toolTitle';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { transcriptTurns, type Item, type Transcript } from './model';
import { stripQuotes } from './quoteText';
import { skillCommandText } from './skillText';
import { shownKeys, updateTab, useApp, type KernelStatus, type Tab } from './store';

// ---- git 状态与刷新时机（§3.5） ----

/**
 * @brief 界面现在能不能为这个会话发 workspace.status：后台进程连着、会话已经打开（有 pi 会话 id）、不在建 worktree 中
 *        （§11.5.6：这期间切到它、窗口回到前台也不发，git 状态由后台进程在建好后发）。
 *        界面发起的 workspace.status 都经这一处判断能不能发（§3.5 的时机表、§11.5.6）。
 */
export function statusAllowed(tab: Tab, kernel: KernelStatus): boolean {
  return kernel === 'ready' && tab.sessionId !== null && tab.phase === 'ready' && !tab.creatingWorktree;
}

/**
 * @brief 记下一次 git 状态（命令结果或 mori.workspace_status）：比已记下的读得早（at 更小）的不覆盖；
 *        快照状态变了时后台进程用同一次的 git 状态再发一次（at 相同），照样记下。
 */
export function withStatus(tab: Tab, status: WorkspaceStatus): Tab {
  if (tab.workspace && status.at < tab.workspace.at) return tab;
  return { ...tab, workspace: status };
}

/** @brief 发一次 workspace.status，结果记到会话上；失败只记日志（右栏保持上一次的内容）。 */
async function readStatus(key: string, sessionId: string): Promise<void> {
  try {
    const status = await request<WorkspaceStatus>({ type: 'workspace.status', sessionId });
    updateTab(key, (tab) => (tab.sessionId === sessionId ? withStatus(tab, status) : tab));
  } catch (error) {
    describe('workspace.status', error);
  }
}

/**
 * @brief 界面的刷新时机（§3.5、fs-changes.md "刷新"）：session.open / session.create 成功后、焦点会话改变后、
 *        窗口回到前台时（显示着的会话）、打开右栏时发 workspace.status；不能发时（statusAllowed）什么都不做。
 *        后台进程另外在工具执行完、一轮结束、Rewind 之后自己读，结果以 mori.workspace_status 到达。
 */
export async function requestStatus(key: string): Promise<void> {
  const state = useApp.getState();
  const tab = state.tabs.find((item) => item.key === key);
  if (!tab?.sessionId || !statusAllowed(tab, state.kernel)) return;
  await readStatus(key, tab.sessionId);
}

/**
 * @brief 右栏的 Refresh（只读 git 状态）：记进操作记录（Refresh changes），返回之前按钮转圈、不可点，
 *        内容保持上一次的；已经在刷新时不再发。
 */
export async function refreshChanges(key: string): Promise<void> {
  const state = useApp.getState();
  const tab = state.tabs.find((item) => item.key === key);
  if (!tab?.sessionId || tab.refreshing || !statusAllowed(tab, state.kernel)) return;
  recordAction('Refresh changes');
  updateTab(key, (current) => ({ ...current, refreshing: true }));
  try {
    await readStatus(key, tab.sessionId);
  } finally {
    updateTab(key, (current) => ({ ...current, refreshing: false }));
  }
}

/**
 * @brief 订阅两个刷新时机（connectKernel 调一次）：焦点会话改变（点侧栏、分屏切换焦点）时为新的焦点会话发；
 *        窗口回到前台（window 的 focus）时为显示着的会话（分屏时两个）各发一次。窗口在后台时不发。
 */
export function connectWorkspace(): void {
  useApp.subscribe((state, previous) => {
    if (state.activeKey === previous.activeKey || state.activeKey === null) return;
    void requestStatus(state.activeKey);
  });
  window.addEventListener('focus', () => {
    const state = useApp.getState();
    if (state.view !== 'chat') return;
    for (const key of shownKeys(state)) void requestStatus(key);
  });
}

/** @brief git 是 ok（没装、版本太低、还没收到状态时为假）：没有 Rewind、+N −M（§5.4、§5.5）。 */
export function gitOk(tab: Tab): boolean {
  return tab.workspace?.git.state === 'ok';
}

// ---- 右栏的正文（§5.1、§5.2） ----

/** 没装 git 时右栏正文唯一的一行（§5.1） */
export const GIT_REQUIRED_TEXT = 'Git is required to track changes and rewind.';
/** 不是 git 仓库时上半部分的一行（下面是 Initialize git…，fs-worktree.md） */
export const NOT_A_REPO_TEXT = 'Not a git repository';
/** 还没有状态时上半部分的文字（fs-changes.md "右栏的外框"） */
export const STATUS_LOADING_TEXT = 'Loading…';

/**
 * @brief 右栏正文按 WorkspaceStatus 分的几种（fs-changes.md "上半部分：三种文件夹"）：还没有状态、没装 git、版本太低、
 *        认不出仓库、不是 git 仓库、git 仓库。session 为下半部分 This session 是否显示（没装 git、版本太低时没有）。
 */
export type ChangesBody =
  | { kind: 'loading'; text: string; session: true }
  | { kind: 'missing' | 'old'; text: string; session: false }
  | { kind: 'error'; text: string; session: true }
  | { kind: 'not-repo'; text: string; session: true }
  | { kind: 'repo'; status: WorkspaceStatus; session: true };

/** @brief 读 git 状态失败的一行（认不出仓库、git status 失败，§5.1、§5.2）。 */
export function statusErrorText(error: string): string {
  return `Couldn’t read git status: ${error}`;
}

/** @brief 右栏正文是哪一种；status 为这个会话最近一次的 git 状态（还没有为 null）。 */
export function changesBody(status: WorkspaceStatus | null): ChangesBody {
  if (!status) return { kind: 'loading', text: STATUS_LOADING_TEXT, session: true };
  if (status.git.state === 'missing') return { kind: 'missing', text: GIT_REQUIRED_TEXT, session: false };
  if (status.git.state === 'old') {
    const text = `Git 2.32 or newer is required to track changes and rewind (found ${status.git.version}).`;
    return { kind: 'old', text, session: false };
  }
  if (status.repo) return { kind: 'repo', status, session: true };
  if (status.error !== null) return { kind: 'error', text: statusErrorText(status.error), session: true };
  return { kind: 'not-repo', text: NOT_A_REPO_TEXT, session: true };
}

/** @brief git 状态里状态字母的悬停文字（§5.2）；未跟踪的不带字母。 */
export const STATUS_CODE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflicted',
});

/** @brief git 状态的一组（fs-changes.md "git 状态"）。 */
export interface StatusGroup {
  /** 分组（data-group） */
  group: StatusFile['group'];
  /** 组标题：Conflicts · <n>、Staged · <n>、Unstaged · <n>、Untracked · <n> */
  title: string;
  /** 这一组的文件，按 git 给的顺序 */
  files: StatusFile[];
}

/** @brief git 状态这一块要显示的（§5.2）。 */
export interface GitStatusView {
  /** 分支行；读失败（error 不为 null）或没有分支信息时为 null */
  branch: string | null;
  /** 读失败时分支行位置的一行；没有为 null */
  error: string | null;
  /** 分组，依次 Conflicts、Staged、Unstaged、Untracked，没有的组不在里面 */
  groups: StatusGroup[];
  /** 没有未提交的文件时分支行下面的 No uncommitted changes；有文件或读失败时为 null */
  empty: string | null;
  /** 列表下的说明：Showing 500 of <total> files. / Showing the first 500 files.；没有为 null */
  footer: string | null;
}

/** 分组的顺序与标题 */
const GROUP_TITLES: ReadonlyArray<[StatusFile['group'], string]> = [
  ['conflicted', 'Conflicts'], ['staged', 'Staged'], ['unstaged', 'Unstaged'], ['untracked', 'Untracked'],
];

/** @brief 领先、落后（§5.2）：1 ahead、2 behind、1 ahead, 2 behind，都为 0 时 Up to date。 */
function aheadBehind(ahead: number, behind: number): string {
  if (ahead > 0 && behind > 0) return `${ahead} ahead, ${behind} behind`;
  if (ahead > 0) return `${ahead} ahead`;
  return behind > 0 ? `${behind} behind` : 'Up to date';
}

/**
 * @brief 分支行（§5.2）：分支名；detached 时 HEAD detached at <oid 前 7 位>；还没有提交时加 · No commits yet；
 *        有上游时加 · <upstream> · <领先、落后>，上游已不在（ahead 为 null）时 · <upstream> (gone)。
 */
export function branchText(branch: NonNullable<WorkspaceStatus['branch']>): string {
  const parts = [branch.head ?? `HEAD detached at ${(branch.oid ?? '').slice(0, 7)}`];
  if (branch.oid === null) parts.push('No commits yet');
  if (branch.upstream !== null) {
    parts.push(branch.ahead === null ? `${branch.upstream} (gone)`
      : `${branch.upstream} · ${aheadBehind(branch.ahead, branch.behind ?? 0)}`);
  }
  return parts.join(' · ');
}

/** @brief git 状态这一块（status 是 git 仓库的状态，changesBody 为 repo 时）。 */
export function gitStatusView(status: WorkspaceStatus): GitStatusView {
  if (status.error !== null) {
    return { branch: null, error: statusErrorText(status.error), groups: [], empty: null, footer: null };
  }
  const groups = GROUP_TITLES.flatMap(([group, title]) => {
    const files = status.files.filter((file) => file.group === group);
    return files.length > 0 ? [{ group, title: `${title} · ${files.length}`, files }] : [];
  });
  const footer = status.truncated ? `Showing the first ${status.files.length} files.`
    : status.total > status.files.length
      ? `Showing ${status.files.length} of ${status.total.toLocaleString('en-US')} files.` : null;
  return { branch: status.branch ? branchText(status.branch) : null, error: null, groups,
    empty: status.files.length === 0 ? 'No uncommitted changes' : null, footer };
}

/** @brief git 状态的一行显示的路径：重命名、复制时 <from> → <path>。 */
export function statusFileLabel(file: StatusFile): string {
  return file.from === null ? file.path : `${file.from} → ${file.path}`;
}

/**
 * @brief 点 git 状态的一行时在阅读器里打开的路径：<toplevel>\<path>（相对仓库根，§5.2；未跟踪目录去掉结尾的 /）；
 *        没有仓库信息时为 null。
 */
export function statusFilePath(status: WorkspaceStatus, file: StatusFile): string | null {
  if (!status.repo) return null;
  const relative = file.path.replace(/\/+$/, '').replace(/\//g, '\\');
  return `${status.repo.toplevel.replace(/[\\/]+$/, '')}\\${relative}`;
}

// ---- This session 顶部的说明（§5.3） ----

/** @brief This session 小标题下面的一行说明（data-kind：paused、off、error、skipped）。 */
export interface SnapshotNote {
  /** 种类 */
  kind: 'paused' | 'off' | 'error' | 'skipped';
  /** 文字 */
  text: string;
  /** 悬停文字（跳过的大文件列出前 20 个路径，一行一个）；没有为 null */
  title: string | null;
}

/** @brief 跳过的大文件那一行（§5.3）。 */
function skippedText(count: number): string {
  return count === 1 ? '1 large file isn’t in snapshots (over 10 MB).'
    : `${count.toLocaleString('en-US')} large files aren’t in snapshots (over 10 MB).`;
}

/**
 * @brief This session 小标题下面的说明（按 WorkspaceStatus.snapshots，§5.3）：paused、off 写原因原文；
 *        上一次快照失败写 Couldn’t take a snapshot: <原文>；有跳过的大文件时写个数，悬停列出路径。
 */
export function snapshotNotes(snapshots: SnapshotState): SnapshotNote[] {
  const notes: SnapshotNote[] = [];
  if (snapshots.state !== 'on' && snapshots.reason) {
    notes.push({ kind: snapshots.state, text: snapshots.reason, title: null });
  }
  if (snapshots.error) notes.push({ kind: 'error', text: `Couldn’t take a snapshot: ${snapshots.error}`, title: null });
  if (snapshots.skippedTotal > 0) {
    notes.push({ kind: 'skipped', text: skippedText(snapshots.skippedTotal), title: snapshots.skipped.join('\n') });
  }
  return notes;
}

/**
 * @brief This session 小标题上方嵌套仓库那一行（§5.3，FS-26）：列出 nested（相对工作路径，`, ` 隔开），
 *        nestedTotal 多于列出的个数时接 and <n> more；没有嵌套仓库时为 null。
 */
export function nestedNote(snapshots: SnapshotState): string | null {
  if (snapshots.nested.length === 0) return null;
  const more = snapshots.nestedTotal - snapshots.nested.length;
  return `Changes inside nested repositories aren’t tracked: ${snapshots.nested.join(', ')}`
    + (more > 0 ? ` and ${more} more` : '');
}

// ---- 当前分支上的记录：自动打开、阅读器重读、顶栏行数（§5.1、§5.4） ----

/** @brief 当前分支上的 changes 记录，按先后。 */
export function changesRecords(transcript: Transcript): ChangesRecord[] {
  return transcript.turnChanges.flatMap((item) => (item.record.kind === 'changes' ? [item.record] : []));
}

/**
 * @brief 当前分支上有没有 changes 记录：右栏的 rightOpen 为 null 时跟随它，所以这个会话第一次收到 changes 记录时右栏
 *        自动打开到 Changes，你手动开关过之后以你为准（§5.1）。
 */
export function hasTurnChanges(tab: Tab): boolean {
  return tab.transcript.turnChanges.some((item) => item.record.kind === 'changes');
}

/**
 * @brief 阅读器自动重读的依据（§5.1）：当前分支上列出这个文件的 changes 记录条数（路径按 pi 的规则比较，同 v0）；
 *        新的一段记到它就多一，阅读器重读一次。
 * @param path 阅读器打开的路径（工具参数里的原文或绝对路径）
 */
export function fileChangeCount(tab: Tab, path: string): number {
  const key = pathKey(path, tab.cwd);
  return changesRecords(tab.transcript)
    .filter((record) => record.files.some((file) => pathKey(file.path, tab.cwd) === key)).length;
}

/** @brief 顶栏的行数。 */
export interface LineTotals {
  /** 增加的行数之和 */
  added: number;
  /** 删除的行数之和 */
  removed: number;
}

/** @brief 当前分支上全部 changes 记录的 added、removed 之和，二进制（null）不计（§5.4）。 */
export function lineTotals(transcript: Transcript): LineTotals {
  let added = 0;
  let removed = 0;
  for (const record of changesRecords(transcript)) {
    for (const file of record.files) {
      added += file.added ?? 0;
      removed += file.removed ?? 0;
    }
  }
  return { added, removed };
}

/** @brief 顶栏显示 +N −M：git 是 ok、两者不都为 0（这一栏不宽于 600 px 时不显示由界面按宽度判断，§5.4）。 */
export function linesShown(tab: Tab): boolean {
  const totals = lineTotals(tab.transcript);
  return gitOk(tab) && (totals.added > 0 || totals.removed > 0);
}

/** @brief +N −M 的读屏名（§5.4）：Changes in this session: <N> lines added, <M> removed（N 为 1 时 1 line added）。 */
export function linesLabel(totals: LineTotals): string {
  const added = totals.added === 1 ? '1 line' : `${totals.added} lines`;
  return `Changes in this session: ${added} added, ${totals.removed} removed`;
}

// ---- This session 的归组（§5.3） ----

/** @brief 一轮里的一个文件（fs-changes.md "组里的一个文件"）。 */
export interface TurnFile {
  /** 相对工作路径，/ 分隔 */
  path: string;
  /** 这一轮第一次出现是 A 为开始前没有，最后一次是 D 为现在没有；都不是为 M，建了又删为 D */
  status: 'A' | 'M' | 'D';
  /** 各段增加行数之和（二进制的段不计） */
  added: number;
  /** 各段删除行数之和（二进制的段不计） */
  removed: number;
  /** 每一段都是二进制：行数写 Binary */
  binary: boolean;
  /** 别的 Agent 的名字（Mori, Executor (T2)），全是对话本身（self）时为 null */
  agents: string | null;
}

/** @brief This session 的一组：一轮（fs-changes.md "有改动"）。 */
export interface TurnGroup {
  /** 轮：你那条消息的条目 id（snapshots.diff 的 round、data-round） */
  round: string;
  /** Turn <n> 的 n（当前分支上第几条你的消息）；那条消息不在当前分支的对话流里时为 null */
  turn: number | null;
  /** 组标题里你那条消息的第一行（你写的字，带引用时去掉引用块） */
  title: string;
  /** 悬停看的全文 */
  text: string;
  /** 文件，按这一轮里第一次出现的先后 */
  files: TurnFile[];
  /** 有 overlap 的记录：组标题下一行 Another session in this folder was running at the same time, … */
  overlap: boolean;
  /** 有 total 多于 files 的记录：组下面一行 Some files in this turn aren’t listed. Too many changed at once. */
  truncated: boolean;
}

/** 组的两种说明（§5.3） */
export const TURN_OVERLAP_TEXT = 'Another session in this folder was running at the same time, so some of these '
  + 'changes may be theirs.';
export const TURN_TRUNCATED_TEXT = 'Some files in this turn aren’t listed. Too many changed at once.';
/** 当前分支上没有 changes 记录时 This session 的一行 */
export const NO_CHANGES_TEXT = 'No changes yet.';

/** @brief 一个文件在一轮里各段的累计。 */
interface FileSum {
  /** 相对 cwd 的路径（记录里的写法） */
  path: string;
  /** 这一轮里第一次出现时的状态（A 开头的算新增） */
  first: ChangedFile['status'];
  /** 这一轮里最后一次出现时的状态（D 结尾的算删除） */
  last: ChangedFile['status'];
  /** 各段增加的行数之和，二进制的段不计 */
  added: number;
  /** 各段删除的行数之和，二进制的段不计 */
  removed: number;
  /** 每一段都是二进制（写 Binary） */
  binary: boolean;
  /** 列出这个文件的各段记录的 Agent，按先后，未去重 */
  agents: RunAgent[];
}

/** @brief 把一段里的一项加进这个文件的累计。 */
function addSegment(sum: FileSum | undefined, file: ChangedFile, agents: RunAgent[]): FileSum {
  const binary = file.added === null || file.removed === null;
  if (!sum) {
    return { path: file.path, first: file.status, last: file.status, added: file.added ?? 0,
      removed: file.removed ?? 0, binary, agents: [...agents] };
  }
  return { ...sum, last: file.status, added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0),
    binary: sum.binary && binary, agents: [...sum.agents, ...agents] };
}

/**
 * @brief 一个 Agent 的名字（fs-changes.md "文件行上的 Agent"）：对话本身写持有对话的角色名（基座 mori 写 Mori），
 *        实例写 <角色名> (<task>)，没有 task 时只写角色名。
 */
export function agentName(agent: RunAgent): string {
  const role = roleLabel(agent.role);
  return agent.self || agent.task === null ? role : `${role} (${agent.task})`;
}

/** @brief 文件行上的 Agent：全是 self 时为 null，否则去重后用 `, ` 隔开。 */
function agentsText(agents: readonly RunAgent[]): string | null {
  if (agents.every((agent) => agent.self)) return null;
  return [...new Set(agents.map(agentName))].join(', ');
}

/** @brief 累计换成文件行。 */
function turnFile(sum: FileSum): TurnFile {
  const status = sum.last === 'D' ? 'D' : sum.first === 'A' ? 'A' : 'M';
  return { path: sum.path, status, added: sum.added, removed: sum.removed, binary: sum.binary,
    agents: agentsText(sum.agents) };
}

/** @brief 你那条消息的组标题与悬停全文：带引用时去掉引用块，技能调用写回 /skill:名字 参数。 */
function messageTitle(item: Extract<Item, { kind: 'user' }> | undefined, cwd: string): { title: string; text: string } {
  if (!item) return { title: '', text: '' };
  const own = item.refs?.length ? stripQuotes(item.text, item.refs, cwd) ?? item.text : item.text;
  const text = skillCommandText(own).trim() || item.text.trim();
  return { title: text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '', text };
}

/** @brief 一轮的各条记录归成一组。 */
function turnGroup(round: string, records: readonly ChangesRecord[], turn: number | null,
  message: { title: string; text: string }): TurnGroup {
  const files = new Map<string, FileSum>();
  for (const record of records) {
    for (const file of record.files) files.set(file.path, addSegment(files.get(file.path), file, record.agents));
  }
  return { round, turn, title: message.title, text: message.text, files: [...files.values()].map(turnFile),
    overlap: records.some((record) => record.overlap),
    truncated: records.some((record) => record.total > record.files.length) };
}

/**
 * @brief This session 的各组（§5.3）：每个有 changes 记录的轮一组，新的轮在上（那条消息不在对话流里的排在最后）；
 *        组里的文件按第一次出现的先后合并各条记录。只从当前分支上的记录算：只恢复代码时那些轮照样列出，
 *        恢复对话后丢掉的轮随对话流一起不在了。
 */
export function turnGroups(tab: Tab): TurnGroup[] {
  const { items } = tab.transcript;
  const numbers = transcriptTurns(items);
  const byRound = new Map<string, ChangesRecord[]>();
  for (const record of changesRecords(tab.transcript)) {
    byRound.set(record.round, [...byRound.get(record.round) ?? [], record]);
  }
  const groups = [...byRound].map(([round, records]) => {
    const item = items.find((entry): entry is Extract<Item, { kind: 'user' }> => entry.kind === 'user'
      && entry.entryId === round);
    return turnGroup(round, records, numbers.get(round) ?? null, messageTitle(item, tab.cwd));
  });
  return groups.sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0));
}

// ---- 一轮里一个文件的 diff（§5.3） ----

/** @brief 点开的 diff 的状态（data-state）。 */
export type TurnDiffState = 'loading' | 'shown' | 'binary' | 'empty' | 'truncated' | 'pruned' | 'error';

/** @brief 一个文件这一轮的 diff 要显示的（fs-changes.md "一个文件的 diff"）。 */
export interface TurnDiff {
  /** 状态 */
  state: TurnDiffState;
  /** 交给 Diff.tsx 的 git diff 原文（shown、truncated）；其余为 null */
  patch: string | null;
  /** 一行说明：二进制、没有差别、太大、整理、失败的文字；shown、loading 为 null */
  note: string | null;
}

/** 读取中 */
export const LOADING_DIFF: TurnDiff = Object.freeze({ state: 'loading', patch: null, note: null });

/** 快照已被整理时后台进程给的原文的开头（§4.7：Mori keeps snapshots for the last 100 turns of a session. …） */
const PRUNED_PREFIX = 'Mori keeps snapshots for the last ';

/** @brief snapshots.diff 的结果换成要显示的。 */
export function turnDiffOf(diff: SnapshotDiff): TurnDiff {
  if (diff.error !== null) {
    return diff.error.startsWith(PRUNED_PREFIX) ? { state: 'pruned', patch: null, note: diff.error }
      : { state: 'error', patch: null, note: `Couldn’t load the diff: ${diff.error}` };
  }
  if (diff.binary) return { state: 'binary', patch: null, note: 'Binary file · No preview' };
  if (!diff.patch) return { state: 'empty', patch: null, note: 'No net changes in this turn.' };
  if (diff.truncated) return { state: 'truncated', patch: diff.patch, note: 'The diff is too large to show in full.' };
  return { state: 'shown', patch: diff.patch, note: null };
}

/**
 * @brief 点文件行展开它这一轮的 diff（snapshots.diff { sessionId, round, path }）；命令失败为 error。
 *        会话没有打开（没有 pi 会话 id）时为 null（不发命令）。
 */
export async function loadTurnDiff(key: string, round: string, path: string): Promise<TurnDiff | null> {
  const sessionId = useApp.getState().tabs.find((tab) => tab.key === key)?.sessionId;
  if (!sessionId) return null;
  try {
    return turnDiffOf(await request<SnapshotDiff>({ type: 'snapshots.diff', sessionId, round, path }));
  } catch (error) {
    return { state: 'error', patch: null, note: `Couldn’t load the diff: ${describe('snapshots.diff', error)}` };
  }
}
