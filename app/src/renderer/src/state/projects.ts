// 项目与会话（docs/v0/screens/sessions.md）：pi 的会话列表、新建与打开会话（先问信任）、切换、改名、归档、删除，
// 接上界面重新加载前还开着的会话，以及后台进程重新载入后重新打开会话。每个操作对应后台进程的一条命令
// （删除另加主进程的"删除会话文件"，归档另在本机记下）。

import type { ExtensionNotice, OpenedSession, SavedSession, SessionInfo, TrustAnswer } from '../../../shared/protocol';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { saveArchived } from './archive';
import { dropDraft, savedDraft, savedDraftRefs } from './drafts';
import { attachLive, transcriptFromEntries, withTeamInfo } from './history';
import { guardLeave, leaveAllowed } from './leaveGuard';
import { emptyTranscript, pushItem, startIndexFor, type Transcript } from './model';
import { openInSplit, placeInSplit, showInFocused, withoutPane, type Side } from './split';
import {
  activeTab, modelStateOf, newTab, sameFile, shownKeys, tabByFile, updateTab, useApp, type AppState, type Tab,
} from './store';
import { trustFor } from './trust';

/** 重新载入后在对话流里说明哪些没有恢复（方案 5.8） */
const RELOADED_NOTE = 'Restarted · Queued messages, pending approvals, and “Allow for this session” choices '
  + 'weren’t restored';

/** @brief 读取 pi 的会话列表；已有列表时读取中仍显示旧的，失败时保留旧的并显示原文。 */
export async function loadSessions(): Promise<void> {
  useApp.setState((state) => ({ saved: { ...state.saved, error: null,
    status: state.saved.status === 'ready' ? 'ready' : 'loading' } }));
  try {
    const sessions = await request<SavedSession[]>({ type: 'session.list' });
    useApp.setState({ saved: { status: 'ready', sessions, error: null } });
  } catch (error) {
    const message = describe('session.list', error);
    useApp.setState((state) => ({ saved: { ...state.saved, status: 'failed', error: message } }));
  }
}

/**
 * @brief 把会话信息写进会话。批准设置以后台进程返回的为准（新建和重新打开的会话都是"Ask each time"）；
 *        协作状态与 TaskBoard 视图同样（平行 Agent 规格 §13.10），挂起的后台批准卡与待判断的消息接到对话流上。
 *        增强的提示（docs/specs/memory.md §9.9、§10.6）只在打开时取：后台进程只给新建的会话带上它（打开已有的为 null），
 *        会话已经打开后（Check again 等）不再取，Dismiss 过的不会回来；旧的录制里没有这一项时按没有。
 */
export function withInfo(tab: Tab, info: SessionInfo): Tab {
  return { ...tab, sessionId: info.sessionId, cwd: info.cwd, sessionFile: info.sessionFile, name: info.name,
    projectTrust: info.projectTrust, trustRemembered: info.trustRemembered, trustSaveError: info.trustSaveError,
    extensionErrors: info.extensionErrors, ...modelStateOf(info),
    contextUsage: info.contextUsage, approval: info.approval, team: info.team, board: info.board,
    memoryNotice: tab.phase === 'opening' ? info.memoryNotice ?? null : tab.memoryNotice,
    transcript: withTeamInfo(tab.transcript, info), phase: 'ready', error: null, interrupted: false };
}

/** @brief 新会话顶部增强提示的 Dismiss（docs/specs/memory.md §10.6）：这次打开里不再显示。 */
export function dismissMemoryNotice(key: string): void {
  recordAction('Dismiss memory notice');
  updateTab(key, (tab) => ({ ...tab, memoryNotice: null }));
}

/**
 * @brief 增强的提示只在这次打开里显示（docs/specs/memory.md §10.6）：会话不再显示在中栏的任一栏里（切到别的会话、
 *        分屏里这一栏换成别的会话或关掉）时清掉它，切回来不再显示。只是去设置页、记忆页（例如点了 View）不算切走。
 */
useApp.subscribe((state, previous) => {
  if (state.activeKey === previous.activeKey && state.split === previous.split) return;
  const shown = shownKeys(state);
  const hidden = shownKeys(previous).filter((key) => !shown.includes(key));
  const clear = (tab: Tab) => hidden.includes(tab.key) && tab.memoryNotice !== null;
  if (!state.tabs.some(clear)) return;
  useApp.setState((current) => ({ tabs: current.tabs.map((tab) => (clear(tab) ? { ...tab, memoryNotice: null }
    : tab)) }));
});

/** @brief 扩展在会话打开过程中发的通知：接在对话流后面（extension-ui.md）。 */
function withNotices(transcript: Transcript, notices: ExtensionNotice[]): Transcript {
  return notices.reduce((current, notice) => pushItem(current, { kind: 'notify', text: notice.message,
    level: notice.level }), transcript);
}

/** @brief 去掉还没点开的会话留下的状态（它打开了，或被关闭了）。 */
function withoutMark(marks: AppState['rowMarks'], file: string | null): AppState['rowMarks'] {
  if (!file || !(file in marks)) return marks;
  const { [file]: _mark, ...rest } = marks;
  return rest;
}

/** @brief 加入一个会话并切到它：side 为空时放进焦点所在的那一栏，否则在这一侧分屏打开（docs/v0/screens/split.md）。 */
function addTab(tab: Tab, side?: Side): void {
  useApp.setState((state) => {
    const next = { ...state, tabs: [...state.tabs, tab] };
    return { tabs: next.tabs, ...(side ? placeInSplit(next, tab.key, side) : showInFocused(next, tab.key)),
      view: 'chat' };
  });
}

/** @brief 打开失败：会话留在侧栏，状态"Error"，中栏显示原文；没有打开的 pi 会话（后台进程里没有它）。 */
function markFailed(key: string, what: string, error: unknown): void {
  const message = describe(what, error);
  updateTab(key, (current) => ({ ...current, sessionId: null, phase: 'failed', error: message }));
}

/** @brief 在文件夹里新建会话并切过去；需要时先问信任。 */
export async function createSessionIn(cwd: string): Promise<void> {
  const tab = newTab(cwd);
  addTab(tab);
  try {
    const trust = await trustFor(cwd);
    const info = await request<SessionInfo>({ type: 'session.create', cwd, trust });
    updateTab(tab.key, (current) => withInfo({ ...current,
      transcript: withNotices(current.transcript, info.extensionNotices) }, info));
    useApp.setState({ firstRun: false });
  } catch (error) {
    markFailed(tab.key, 'session.create', error);
  }
}

/** @brief 选文件夹并在其中新建会话。 */
export async function openFolder(): Promise<void> {
  if (!(await leaveAllowed())) return;
  const cwd = await window.mori.pickFolder();
  if (cwd) await createSessionIn(cwd);
}

/** @brief "New session"（Ctrl+N）：在当前会话所在的项目里新建；没有当前会话时等于"Open folder…"。 */
export async function newSession(): Promise<void> {
  if (!(await leaveAllowed())) return;
  recordAction('New session');
  const current = activeTab();
  if (current) await createSessionIn(current.cwd);
  else await openFolder();
}

/**
 * @brief 回到会话页：key 为左栏点的会话（已在某一栏的只切焦点，否则放进焦点所在的那一栏）；不传时回到原来的样子
 *        （设置页的"Back to app"，分屏也恢复）。显示出来的会话清掉"Unread"。
 */
export function showChat(key?: string): void {
  guardLeave(() => placeChat(key));
}

/** @brief showChat 的实际切换（已经确认可以离开）。 */
function placeChat(key?: string): void {
  recordAction(key ? 'Switch session' : 'Back to app');
  useApp.setState((state) => {
    const placed = key ? showInFocused(state, key) : { activeKey: state.activeKey, split: state.split };
    const shown: string[] = placed.split ?? (placed.activeKey ? [placed.activeKey] : []);
    return { view: 'chat', ...placed,
      tabs: state.tabs.map((tab) => (shown.includes(tab.key) && tab.unseen ? { ...tab, unseen: false } : tab)) };
  });
}

/**
 * @brief 打开会话列表里的一个会话；本次已经打开的直接切过去。需要时先问信任；界面重新加载前就在后台进程里开着的会话
 *        （列表带 live）不问信任，直接接上它这一刻的样子。side 为空时放进焦点所在的那一栏，否则在这一侧分屏打开。
 */
export async function openSaved(saved: SavedSession, side?: Side): Promise<void> {
  if (!(await leaveAllowed())) return;
  const existing = tabByFile(saved.sessionFile);
  if (existing) {
    if (side) openInSplit(existing.key, side);
    else showChat(existing.key);
    return;
  }
  recordAction('Open session');
  useApp.setState((state) => ({ rowMarks: withoutMark(state.rowMarks, saved.sessionFile) }));
  const tab = newTab(saved.cwd, { sessionFile: saved.sessionFile, name: saved.name, preview: saved.firstMessage,
    activity: saved.modified, draft: savedDraft(saved.sessionFile), draftRefs: savedDraftRefs(saved.sessionFile) });
  addTab(tab, side);
  try {
    const trust = saved.live ? undefined : await trustFor(saved.cwd);
    await reopenFromFile(tab, saved.sessionFile, trust, null);
  } catch (error) {
    markFailed(tab.key, 'session.open', error);
  }
}

/** @brief 侧栏里的一个会话：本次打开过的（界面里的会话标识）和它的会话文件。 */
export interface SessionRef {
  /** 本次打开过的会话的标识；没打开过时为 undefined */
  tabKey?: string;
  /** 会话文件；还没打开完的新会话为 null */
  sessionFile: string | null;
}

/** @brief 改名；失败时抛错，由改名框显示原文。打开中的会话随后还会收到 pi 的 session_info_changed。 */
export async function renameSession(ref: SessionRef, name: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === ref.tabKey);
  const sessionFile = tab?.sessionFile ?? ref.sessionFile;
  const result = await request<{ name: string | null }>({ type: 'session.rename', name,
    sessionId: tab?.sessionId ?? undefined, sessionFile: sessionFile ?? undefined });
  if (tab) {
    updateTab(tab.key, (current) => ({ ...current, name: result.name }));
    return;
  }
  useApp.setState((state) => ({ saved: { ...state.saved, sessions: state.saved.sessions.map((session) =>
    (sameFile(session.sessionFile, sessionFile) ? { ...session, name: result.name } : session)) } }));
  void loadSessions();
}

/**
 * @brief 归档与删除之前：关闭后台进程里打开着的这个会话（正在生成时拒绝），从中栏去掉；返回会话文件。
 *        打开失败、后台进程退出后的会话没有 pi 会话（sessionId 已清掉），不用关闭；界面重新加载前开着的会话
 *        （列表带 live）按会话 id 关闭。关闭后它在列表里不再算开着（再点要重新打开、先问信任），留下的状态一起去掉。
 */
async function closeForRemoval(ref: SessionRef): Promise<string | null> {
  const state = useApp.getState();
  const tab = state.tabs.find((item) => item.key === ref.tabKey);
  const saved = state.saved.sessions.find((item) => sameFile(item.sessionFile, ref.sessionFile));
  // 后台还有 Agent 在运行或排队、或有待判断的消息时也算正在生成（平行 Agent 规格 §11.5）。
  if (tab && (tab.transcript.running || tab.transcript.sending || tab.team.background)) {
    throw new Error('This session is still running. Stop it first.');
  }
  if (tab?.phase === 'opening') throw new Error('This session is still opening.');
  const sessionId = tab ? tab.sessionId : saved?.live ? saved.sessionId : null;
  if (sessionId && state.kernel === 'ready') await request({ type: 'session.close', sessionId });
  const file = tab?.sessionFile ?? ref.sessionFile;
  useApp.setState((current) => ({
    tabs: current.tabs.filter((item) => item.key !== tab?.key),
    // 分屏中的会话：这一栏关闭，另一栏占满中栏（方案 5.3）。
    ...(tab ? withoutPane(current, tab.key) : {}),
    rowMarks: withoutMark(current.rowMarks, file),
    saved: { ...current.saved, sessions: current.saved.sessions.map((item) =>
      (sameFile(item.sessionFile, file) ? { ...item, live: null } : item)) },
  }));
  return file;
}

/** @brief 改已归档列表并记到本机。 */
function setArchived(fn: (files: string[]) => string[]): void {
  useApp.setState((state) => ({ archived: fn(state.archived) }));
  saveArchived(useApp.getState().archived);
}

/** @brief 归档（照 Claude 桌面版，不确认、可以恢复）：关闭会话，记进已归档列表；失败时抛错。 */
export async function archiveSession(ref: SessionRef): Promise<void> {
  recordAction('Archive session');
  const sessionFile = await closeForRemoval(ref);
  if (sessionFile) setArchived((files) => [...files.filter((file) => file !== sessionFile), sessionFile]);
  void loadSessions();
}

/** @brief 从已归档列表恢复；open 为真时同时打开它。 */
export function restoreSession(saved: SavedSession, open: boolean): void {
  recordAction('Unarchive session');
  setArchived((files) => files.filter((file) => file !== saved.sessionFile));
  if (open) void openSaved(saved);
}

/**
 * @brief 删除（照 Claude 桌面版，永久）：先关闭会话，再由主进程删除会话文件；失败时抛错，由确认框显示原文。
 *        关闭成功、删除文件失败时会话变回没打开的会话（再点会重新打开），文件还在。
 */
export async function deleteSession(ref: SessionRef): Promise<void> {
  recordAction('Delete session');
  const sessionFile = await closeForRemoval(ref);
  try {
    const result = sessionFile ? await window.mori.deleteSessionFile(sessionFile) : null;
    if (result?.error) throw new Error(result.error);
  } finally {
    void loadSessions();
  }
  dropDraft(sessionFile);
  setArchived((files) => files.filter((file) => file !== sessionFile));
  useApp.setState((current) => ({ saved: { ...current.saved,
    sessions: current.saved.sessions.filter((session) => !sameFile(session.sessionFile, sessionFile)) } }));
}

/** @brief 从会话文件打开，按 pi 记录的当前分支重画对话流；note 写在对话流末尾，为 null 时不写。 */
async function reopenFromFile(tab: Tab, sessionFile: string, trust: TrustAnswer | undefined,
  note: string | null): Promise<void> {
  const opened = await request<OpenedSession>({ type: 'session.open', sessionFile, trust });
  const restored = transcriptFromEntries(opened.entries);
  const history = withNotices(opened.live ? attachLive(restored, opened.live, Date.now()) : restored,
    opened.extensionNotices);
  const transcript = note ? pushItem(history, { kind: 'note', text: note }) : history;
  const startIndex = startIndexFor(transcript);
  updateTab(tab.key, (current) => withInfo({ ...current, transcript, startIndex }, opened));
}

/**
 * @brief 重新打开一个会话。保存过的（本次发过消息，或会话列表里有它的第一条消息）从会话文件打开，文件不在时打开失败、显示原文；
 *        还没保存过的先试会话文件，文件还不存在时在同一文件夹新建。note 为写在对话流末尾的说明（重新载入时），为 null 时不写。
 */
async function reopen(tab: Tab, note: { saved: string; unsaved: string } | null): Promise<void> {
  updateTab(tab.key, (current) => ({ ...current, sessionId: null, phase: 'opening', error: null }));
  try {
    const trust = await trustFor(tab.cwd);
    const saved = Boolean(tab.preview ?? tab.transcript.firstUserText);
    if (tab.sessionFile) {
      try {
        await reopenFromFile(tab, tab.sessionFile, trust, note?.saved ?? null);
        return;
      } catch (error) {
        if (saved || !String((error as Error).message).includes('Session file not found')) throw error;
      }
    }
    const info = await request<SessionInfo>({ type: 'session.create', cwd: tab.cwd, trust });
    const fresh = withNotices(emptyTranscript, info.extensionNotices);
    const transcript = note ? pushItem(fresh, { kind: 'note', text: note.unsaved }) : fresh;
    updateTab(tab.key, (current) => withInfo({ ...current, transcript, startIndex: 0 }, info));
  } catch (error) {
    markFailed(tab.key, 'reopen', error);
  }
}

/** @brief 后台进程重新载入后：重新读取会话列表，重新打开全部会话（信任沿用本次运行里的回答）。 */
export function reopenAll(): void {
  void loadSessions();
  const note = { saved: RELOADED_NOTE, unsaved: 'Restarted · This session had no messages yet and was reopened' };
  for (const tab of useApp.getState().tabs) void reopen(tab, note);
}

/** @brief 打开失败的会话：再点它时重试。 */
export function retryOpen(key: string): void {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  if (tab?.phase !== 'failed') return;
  recordAction('Retry opening session');
  void reopen(tab, null);
}
