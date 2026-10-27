// worktree 与 Initialize git 的界面状态（docs/specs/file-system.md §11，状态表 docs/v1/screens/fs-worktree.md）：
// 输入框下一行权限按钮后面的 Worktree 开关与 Initialize git…（§11.4）、建 worktree 中（§11.5.6）与第一条消息的文件引用
// 换进 worktree（§11.5.5）、归档与删除时的 worktree（§11.9.2、§11.9.5）、设置页 Storage 的 Worktrees（§11.10）、
// Initialize git 确认框（§11.11）。worktrees.list / worktrees.cleanUp 只在你操作时发，不在后台扫、不轮询（§11.9.1）。
// 发第一条消息（带 worktree: true 的 session.prompt）的流程在 actions.ts 的 send，归档与删除在 projects.ts。

import { create } from 'zustand';
import type { QuoteRef, SavedSession } from '../../../shared/protocol';
import {
  refsInto, worktreeOf, type WorkspaceCommandResults, type WorktreeCleanUp, type WorktreeItem,
} from '../../../shared/workspace';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import type { Transcript } from './model';
import { endWorktreeStage, startWorktreeStage, WORKTREE_STAGE_TEXT } from './transcript';
import { updateTab, useApp, type Tab } from './store';

/** worktrees.list 的结果 */
type ListResult = WorkspaceCommandResults['worktrees.list'];
/** worktrees.cleanUp 的结果 */
type CleanUpResult = WorkspaceCommandResults['worktrees.cleanUp'];

/** @brief 按界面里的标识找会话。 */
function tabOf(key: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => tab.key === key);
}

// ---- 输入框下一行：Worktree 开关与 Initialize git…（§11.4） ----

/** @brief 权限按钮后面那一项：toggle 为 Worktree 开关，init-git 为 Initialize git…。 */
export type WorktreeChoice = 'toggle' | 'init-git';

/** @brief 还没有你的消息（同右键菜单的 isUnsaved），对话流里也没有你的消息或先显示的消息。 */
function noMessagesYet(tab: Tab): boolean {
  const { transcript } = tab;
  return !(transcript.firstUserText ?? tab.preview) && !transcript.items.some((item) => item.kind === 'user');
}

/**
 * @brief 输入框下一行显示 Worktree 开关、Initialize git… 还是都不显示（§11.4 的表，fs-worktree.md）。
 *        都要求：会话已打开（不在 Starting…）、还没有你的消息、不在发送中或运行中、SessionInfo.worktree 为 null、
 *        不在建 worktree 中；然后按这个会话最近一次的 git 状态：git 是 ok、有仓库且有提交、没有错误时为开关；
 *        git 是 ok、不是 git 仓库、没有错误时为 Initialize git…；其余（还没收到状态、没有提交、读状态出错、
 *        没装 git 或版本太低）为 null。
 */
export function worktreeChoice(tab: Tab): WorktreeChoice | null {
  if (tab.phase !== 'ready' || tab.sessionId === null || tab.worktree !== null || tab.creatingWorktree) return null;
  if (tab.transcript.sending || tab.transcript.running || !noMessagesYet(tab)) return null;
  const status = tab.workspace;
  if (status?.git.state !== 'ok' || status.error !== null) return null;
  if (status.repo === null) return 'init-git';
  return status.repo.hasCommit ? 'toggle' : null;
}

/** @brief 这次发送要不要带 worktree: true（§11.5.1）：开关打开，而且开关这时显示着（只对第一条消息有效）。 */
export function worktreeWanted(tab: Tab): boolean {
  return tab.worktreeOn && worktreeChoice(tab) === 'toggle';
}

/**
 * @brief 点 Worktree 开关（或 Space / Enter）：只改这个标签在界面里的状态，不发命令（§11.4）；操作记录
 *        Turn on worktree / Turn off worktree。开关没显示时不动。
 */
export function toggleWorktree(key: string): void {
  const tab = tabOf(key);
  if (!tab || worktreeChoice(tab) !== 'toggle') return;
  const on = !tab.worktreeOn;
  recordAction(on ? 'Turn on worktree' : 'Turn off worktree');
  updateTab(key, (current) => ({ ...current, worktreeOn: on }));
}

// ---- 建 worktree 中（§11.5.5、§11.5.6） ----

/** 建 worktree 中不可用的按钮（Stop、输入框下一行的按钮、顶栏的协作开关）的悬停文字，同阶段行 */
export const CREATING_WORKTREE_TEXT = WORKTREE_STAGE_TEXT;

/** @brief 发出带 worktree: true 的 session.prompt：进入建 worktree 中，阶段行 Creating worktree…。 */
export function beginCreating(key: string): void {
  updateTab(key, (tab) => ({ ...tab, creatingWorktree: true,
    transcript: startWorktreeStage(tab.transcript, Date.now()) }));
}

/** @brief 带 worktree: true 的 session.prompt 返回或失败：不再建 worktree 中（已经不在时不动）。 */
export function endCreating(key: string): void {
  updateTab(key, (tab) => (tab.creatingWorktree ? { ...tab, creatingWorktree: false,
    transcript: endWorktreeStage(tab.transcript) } : tab));
}

/**
 * @brief 第一条消息的文件引用换进 worktree（§11.5.5）：先显示的那条消息还带着发出时的芯片（同一个数组）时，
 *        用 refsInto(refs, from, to) 换掉，免得 mori.entry_id 到之前按新的 cwd 重拼引用块对不上、露出原文。
 *        mori.entry_id 已经带来后台进程换过的 refs（不是同一个数组）时不再换。
 * @param sent 发出时的芯片（session.prompt 的 refs）
 * @param from 发出时标签的 cwd
 * @param to 结果里会话的 cwd
 */
export function withMovedRefs(transcript: Transcript, sent: readonly QuoteRef[], from: string,
  to: string): Transcript {
  if (sent.length === 0 || from === to) return transcript;
  const items = transcript.items.map((item) => (item.kind === 'user' && item.refs !== null && item.refs === sent
    ? { ...item, refs: refsInto(item.refs, from, to) } : item));
  return { ...transcript, items };
}

/**
 * @brief 放回输入框的第一条消息的芯片也换进 worktree（§11.5.5、§11.5.7 最后一行）：重建之后准备中失败（没有可用模型、
 *        不带 refs 的 mori.prompt_error）的事件比 session.prompt 的结果先到时，芯片按发出时的那份（原来的 cwd）放回输入框；
 *        结果换 cwd 时只换这些（与发出时是同一个对象，quotes.ts addQuote 原样放进）。事件带来的、后台进程已换过的芯片
 *        与之后你加的芯片不是同一个对象，不换（worktree 在主文件夹里面，refsInto 换两次会错）。没有要换的时返回原数组。
 * @param draft 输入框里现在的芯片
 * @param sent 发出时的芯片（session.prompt 的 refs）
 * @param from 发出时标签的 cwd
 * @param to 结果里会话的 cwd
 */
export function withMovedDraft(draft: QuoteRef[], sent: readonly QuoteRef[], from: string, to: string): QuoteRef[] {
  if (from === to || !draft.some((ref) => sent.includes(ref))) return draft;
  return draft.map((ref) => (sent.includes(ref) ? refsInto([ref], from, to)[0] : ref));
}

// ---- 归档（§11.9.2） ----

/** @brief 列出这个会话拥有的 worktree（worktrees.list { sessionFiles: [它] }）。 */
function listOwned(sessionFile: string): Promise<ListResult> {
  return request<ListResult>({ type: 'worktrees.list', sessionFiles: [sessionFile] });
}

/**
 * @brief 归档之前（会话还开着时）：会话是 worktree 里的会话（worktreeOf(cwd) 不为 null）就 worktrees.list，返回它拥有的
 *        worktree；不是 worktree 里的会话、没有拥有的、或列表失败（只记日志）时为 null。
 * @param cwd 会话的工作路径；不知道时为 null
 */
export async function ownedWorktree(sessionFile: string | null, cwd: string | null): Promise<WorktreeItem | null> {
  if (!sessionFile || cwd === null || !worktreeOf(cwd)) return null;
  try {
    return (await listOwned(sessionFile)).items[0] ?? null;
  } catch (error) {
    describe('worktrees.list', error);
    return null;
  }
}

/** @brief 一项清理结果记进日志（归档时的结果不显示，§11.9.2）。 */
function logCleanUp(result: WorktreeCleanUp): void {
  if (result.error !== null) {
    console.error(`[renderer] worktrees.cleanUp of ${result.path} failed: ${result.error}`);
    return;
  }
  const outcome = result.removed ? 'removed' : `kept (${result.reason ?? 'unknown'})`;
  console.info(`[renderer] worktrees.cleanUp of ${result.path}: ${outcome}`);
}

/**
 * @brief 归档之后（会话已关闭、记进已归档列表）：worktrees.cleanUp { paths: [它], force: false }。干净就删掉、分支留着；
 *        有改动、正被别的会话用着、删除失败都留着，等设置页清理。结果不显示，只记日志。
 */
export async function tidyArchived(item: WorktreeItem): Promise<void> {
  try {
    const { results } = await request<CleanUpResult>({ type: 'worktrees.cleanUp', paths: [item.path], force: false });
    for (const result of results) logCleanUp(result);
  } catch (error) {
    describe('worktrees.cleanUp', error);
  }
}

// ---- 删除（§11.9.5） ----

/** @brief 删除确认框里 worktree 那一句的种类（data-kind）。 */
export type DeleteNoteKind = 'clean' | 'changes' | 'unknown' | 'in-use' | 'no-git';

/** @brief 删除确认框里 worktree 的那一句（data-testid="delete-worktree-note"）。 */
export interface DeleteNote {
  /** 种类 */
  kind: DeleteNoteKind;
  /** 原文（fs-worktree.md "归档、恢复、删除"） */
  text: string;
}

/** @brief 删除一个会话时它的 worktree 怎样处理（确认框打开时由 planDelete 给出，点 Delete 时交给 deleteSession）。 */
export interface DeletePlan {
  /** 确认框说明后面多出的一句；没有拥有的 worktree、或它已经不在时为 null（同现在，不加句子） */
  note: DeleteNote | null;
  /** 点 Delete 时要删的 worktree 根（worktrees.cleanUp { paths: [它], force: true }）；不删 worktree 时为 null */
  remove: string | null;
}

/** @brief 不涉及 worktree 的删除（不是 worktree 里的会话、没有拥有的 worktree）。 */
export const NO_WORKTREE_PLAN: DeletePlan = Object.freeze({ note: null, remove: null });

/** 确认框正在读 worktree 时说明后面的一行（这期间 Delete 不可用） */
export const CHECKING_WORKTREE_TEXT = 'Checking its worktree…';

/** @brief 确认框打开时要不要先读 worktree（会话是 worktree 里的会话，worktreeOf(cwd) 不为 null）。 */
export function checksWorktree(cwd: string): boolean {
  return worktreeOf(cwd) !== null;
}

/** @brief 删除确认框里的一句（fs-worktree.md）。 */
function deleteNoteText(kind: DeleteNoteKind, name: string, branch: string): string {
  const kept = `The branch ${branch} is kept.`;
  switch (kind) {
    case 'clean': return `Its worktree “${name}” will also be deleted. ${kept}`;
    case 'changes': return `Its worktree “${name}” and the uncommitted changes in it will also be deleted. ${kept}`;
    case 'unknown': return `Its worktree “${name}” will also be deleted, with any uncommitted changes in it. ${kept}`;
    case 'in-use': return `Its worktree “${name}” is kept because another open session uses it.`;
    case 'no-git': return `Its worktree “${name}” is kept because Git is required to delete it.`;
  }
}

/**
 * @brief worktrees.list 的结果换成删除的做法：没有这一项或文件夹已经不在时不加句子、不删；别的开着的会话在用、
 *        没装 git 时留着它（只删会话）；有改动、干净、读不出（changes 为 null）时一起删掉。
 */
function planFor(git: boolean, item: WorktreeItem | null): DeletePlan {
  if (!item?.exists) return NO_WORKTREE_PLAN;
  const name = worktreeOf(item.path)?.name ?? item.path;
  const kind: DeleteNoteKind = item.inUse ? 'in-use' : !git ? 'no-git'
    : item.changes === null ? 'unknown' : item.changes ? 'changes' : 'clean';
  const remove = kind === 'in-use' || kind === 'no-git' ? null : item.path;
  return { note: { kind, text: deleteNoteText(kind, name, item.branch) }, remove };
}

/**
 * @brief 删除确认框打开时（§11.9.5 第 1 步）：会话是 worktree 里的会话就 worktrees.list { sessionFiles: [它] }，返回确认框
 *        要加的一句与点 Delete 时要删的 worktree。列表失败时按“读不出”那一句（名字、分支取 worktreeOf(cwd)），点 Delete
 *        时按有拥有的 worktree 删（worktrees.cleanUp { paths: [worktreeOf(cwd).path], force: true }）。不是 worktree 里的
 *        会话、还没有会话文件时为 NO_WORKTREE_PLAN，不发命令。返回之前确认框写 CHECKING_WORKTREE_TEXT、Delete 不可用。
 * @param sessionFile 会话文件（Row.file）
 * @param cwd 会话的工作路径（Row.cwd）
 */
export async function planDelete(sessionFile: string | null, cwd: string): Promise<DeletePlan> {
  const place = worktreeOf(cwd);
  if (!place || !sessionFile) return NO_WORKTREE_PLAN;
  try {
    const listed = await listOwned(sessionFile);
    return planFor(listed.git, listed.items[0] ?? null);
  } catch (error) {
    describe('worktrees.list', error);
    return { note: { kind: 'unknown', text: deleteNoteText('unknown', place.name, place.branch) },
      remove: place.path };
  }
}

/**
 * @brief 删除时删掉会话拥有的 worktree（§11.9.5 第 2 步，会话已关闭之后）：worktrees.cleanUp { paths: [它], force: true }。
 *        结果有 error 时抛出它的原文（确认框显示 Couldn’t delete this session: <原文>，会话文件还在）；in_use、missing
 *        不算失败（照常删会话）。命令失败时抛出原样的错误。
 */
export async function removeWorktree(path: string): Promise<void> {
  const { results } = await request<CleanUpResult>({ type: 'worktrees.cleanUp', paths: [path], force: true });
  for (const result of results) logCleanUp(result);
  const failed = results.find((result) => result.error !== null);
  if (failed?.error) throw new Error(failed.error);
}

// ---- 设置页 Storage → Worktrees（§11.10） ----

/** @brief Worktrees 一行的状态（行上的说明）。 */
export type StorageMark = 'changes' | 'clean' | 'in-use' | 'unknown';

/** @brief Worktrees 的一行：已归档会话拥有的、文件夹还在的 worktree（data-testid="worktree-item"，data-path）。 */
export interface StorageItem {
  /** worktree 根（data-path） */
  path: string;
  /** 拥有它的会话文件 */
  sessionFile: string;
  /** 会话名（会话列表里的 name）；行上的会话名按 displayTitle(name, firstMessage) */
  name: string | null;
  /** 会话列表里的第一条你的消息 */
  firstMessage: string | null;
  /** 分支 mori/<名字> */
  branch: string;
  /** 在用（不删、不算进 N）/ 有改动 / 干净 / 读不出有没有改动 */
  mark: StorageMark;
}

/** @brief Storage 分节 Worktrees 一块的状态（fs-worktree.md "设置页：Storage → Worktrees"）。 */
export interface StorageView {
  /** 还没进过这一节 / 读取中（Loading…）/ 读到了 / 读取失败（problem 与 Retry） */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** worktrees.list 的 git；为假时只显示 Git is required to clean up worktrees.，不显示列表和按钮 */
  git: boolean;
  /** exists 的项，按 worktrees.list 的顺序 */
  items: StorageItem[];
  /** 读取失败的一行 Couldn’t load worktrees: <原文>；没有为 null */
  problem: string | null;
  /** 上一次清理逐项失败的各行 Couldn’t delete <branch>: <原文>（列表下面）；进入这一节时清掉 */
  failures: string[];
  /** worktrees.cleanUp 还没返回（确认框的 Clean up 写 Cleaning up…、两个按钮不可用、Esc 不起作用） */
  cleaning: boolean;
}

/** @brief Storage 分节 Worktrees 一块的状态（只在界面里）。 */
export const useStorage = create<StorageView>(() => ({
  status: 'idle', git: true, items: [], problem: null, failures: [], cleaning: false,
}));

/** 没装 git 时 Worktrees 一块唯一的一行 */
export const STORAGE_GIT_REQUIRED_TEXT = 'Git is required to clean up worktrees.';
/** 没有留下的 worktree 时的一行 */
export const STORAGE_EMPTY_TEXT = 'No worktrees are left from archived sessions.';

/** @brief 行上的说明；读不出有没有改动时为 null（不写）。 */
export function storageMarkText(mark: StorageMark): string | null {
  switch (mark) {
    case 'in-use': return 'In use by an open session';
    case 'changes': return 'Uncommitted changes';
    case 'clean': return 'No uncommitted changes';
    case 'unknown': return null;
  }
}

/** @brief Clean up worktrees… 会删的项（不在用的）；为空时按钮不可用。 */
export function cleanableItems(items: readonly StorageItem[]): StorageItem[] {
  return items.filter((item) => item.mark !== 'in-use');
}

/** @brief 确认框的标题：Clean up N worktrees?（1 个时 Clean up 1 worktree?，N 不算在用的）。 */
export function cleanUpTitle(count: number): string {
  return count === 1 ? 'Clean up 1 worktree?' : `Clean up ${count} worktrees?`;
}

/** @brief 已归档、工作路径在 Mori worktree 里的会话（交给 worktrees.list 的）。 */
function archivedWorktreeSessions(): SavedSession[] {
  const { archived, saved } = useApp.getState();
  return saved.sessions.filter((session) => archived.includes(session.sessionFile) && worktreeOf(session.cwd));
}

/** @brief worktrees.list 的结果换成 Worktrees 的行：只列 exists 的。 */
function storageItems(items: readonly WorktreeItem[], sessions: readonly SavedSession[]): StorageItem[] {
  return items.filter((item) => item.exists).map((item) => {
    const session = sessions.find((entry) => entry.sessionFile === item.sessionFile);
    const mark: StorageMark = item.inUse ? 'in-use'
      : item.changes === null ? 'unknown' : item.changes ? 'changes' : 'clean';
    return { path: item.path, sessionFile: item.sessionFile, name: session?.name ?? null,
      firstMessage: session?.firstMessage ?? null, branch: item.branch, mark };
  });
}

/** 每次读取的序号：只有最后一次的结果生效 */
let storageGen = 0;

/**
 * @brief 读 Worktrees（worktrees.list，已归档列表里 worktreeOf(cwd) 不为 null 的会话文件）。进入这一节（你的操作）时
 *        调一次（keep 为假：先显示 Loading…、清掉上次清理的失败行）；清理之后再调一次（keep 为真：读取中保留列表与失败行）。
 *        不轮询。失败时 Couldn’t load worktrees: <原文> 和 Retry（Retry 再调它）。
 */
export async function loadStorage(keep = false): Promise<void> {
  storageGen += 1;
  const generation = storageGen;
  if (!keep) useStorage.setState({ status: 'loading', items: [], problem: null, failures: [] });
  const sessions = archivedWorktreeSessions();
  try {
    const listed = await request<ListResult>({ type: 'worktrees.list',
      sessionFiles: sessions.map((session) => session.sessionFile) });
    if (generation !== storageGen) return;
    const items = storageItems(listed.items, sessions);
    useStorage.setState({ status: 'ready', git: listed.git, problem: null, items });
  } catch (error) {
    const reason = describe('worktrees.list', error);
    if (generation !== storageGen) return;
    useStorage.setState({ status: 'failed', problem: `Couldn’t load worktrees: ${reason}` });
  }
}

/** @brief 一项删失败的行。 */
function failureText(branch: string, reason: string): string {
  return `Couldn’t delete ${branch}: ${reason}`;
}

/**
 * @brief 确认框里点了 Clean up（§11.10 第 3 步）：worktrees.cleanUp { paths: 不在用的各项, force: true }；操作记录
 *        Clean up worktrees。逐项有 error 的记成 Couldn’t delete <branch>: <原文>；命令本身失败时每一项都记这条原文。
 *        返回之前 cleaning 为真；之后再读一次列表。清理中或没有可删的项时不发。确认框在它返回后关掉。
 */
export async function cleanUpStorage(): Promise<void> {
  const state = useStorage.getState();
  const targets = cleanableItems(state.items);
  if (state.cleaning || targets.length === 0) return;
  recordAction('Clean up worktrees');
  useStorage.setState({ cleaning: true, failures: [] });
  let failures: string[];
  try {
    const { results } = await request<CleanUpResult>({ type: 'worktrees.cleanUp',
      paths: targets.map((item) => item.path), force: true });
    for (const result of results) logCleanUp(result);
    failures = results.flatMap((result) => (result.error === null ? []
      : [failureText(targets.find((item) => item.path === result.path)?.branch ?? result.path, result.error)]));
  } catch (error) {
    const reason = describe('worktrees.cleanUp', error);
    failures = targets.map((item) => failureText(item.branch, reason));
  }
  useStorage.setState({ cleaning: false, failures });
  await loadStorage(true);
}

// ---- Initialize git 确认框（§11.11） ----

/**
 * @brief 点输入框下一行或右栏 Not a git repository 下的 Initialize git…：打开这个会话的确认框（两处是同一个，Tab.initGit）。
 *        已经开着时不动。
 */
export function openInitGit(key: string): void {
  updateTab(key, (tab) => (tab.initGit ? tab : { ...tab, initGit: { busy: false, error: null } }));
}

/** @brief Cancel 或 Esc：关掉确认框；进行中（Initializing…）时不关，返回 false。 */
export function closeInitGit(key: string): boolean {
  if (tabOf(key)?.initGit?.busy) return false;
  updateTab(key, (tab) => (tab.initGit ? { ...tab, initGit: null } : tab));
  return true;
}

/**
 * @brief 确认框里点 Initialize git：workspace.initGit { sessionId }（操作记录 Initialize git）。返回之前 busy（按钮
 *        Initializing…）；成功时关掉确认框（输入框下一行与右栏随后由后台进程发的 mori.workspace_status 换过来）；失败时
 *        对话框里 Couldn’t initialize git: <原因>、按钮恢复可用，可以再点重试。确认框已经关掉（后台进程退出时）不再打开。
 */
export async function confirmInitGit(key: string): Promise<void> {
  const tab = tabOf(key);
  if (!tab?.sessionId || !tab.initGit || tab.initGit.busy) return;
  const sessionId = tab.sessionId;
  updateTab(key, (current) => ({ ...current, initGit: { busy: true, error: null } }));
  try {
    await request<WorkspaceCommandResults['workspace.initGit']>({ type: 'workspace.initGit', sessionId });
    updateTab(key, (current) => ({ ...current, initGit: null }));
  } catch (error) {
    const text = `Couldn’t initialize git: ${describe('workspace.initGit', error)}`;
    updateTab(key, (current) => (current.initGit ? { ...current, initGit: { busy: false, error: text } } : current));
  }
}
