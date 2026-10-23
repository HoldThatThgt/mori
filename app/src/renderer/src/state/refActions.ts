// 会话引用的操作（docs/v0/screens/session-refs.md）：加进输入框（拖进输入框或菜单"Attach as context"）、
// 原会话现在的名字和是否已删除、点引用回到原会话、预览对话框的请求。内容的整理在 sessionRefs.ts。
// 另有按依据回到原位置（docs/specs/memory.md §10.2，M7 的 jumpBack 推广而来）：会话里的任一条目、没有记下条目的会话、
// 一份反馈的来源；跳转未完成时离开发起它的页面，跳转被取消。

import { create } from 'zustand';
import type { StoredFeedback } from '../../../shared/feedback';
import type {
  MessageSource, QuoteRef, SessionContent, SessionEntry, SessionSource,
} from '../../../shared/protocol';
import { displayTitle, sessionTitle } from '../components/ChatPane';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { openSaved, restoreSession, retryOpen, showChat } from './projects';
import { addQuote, findSourceIndex, jumpToQuote, nextJump, refKey, setQuoteStatus } from './quotes';
import { defaultRange, sessionRef, sessionTurns } from './sessionRefs';
import { focusComposer, focusPane } from './split';
import { sameFile, tabByFile, updateTab, useApp, type AppState, type PendingRef } from './store';

/** @brief 一次打开预览对话框的请求。 */
export interface PreviewRequest {
  /** 芯片所在的会话（界面里的标识） */
  tabKey: string;
  /** 引用 */
  ref: QuoteRef;
  /** edit：输入框里的芯片，可以调整范围；view：发出的引用，只看引用时的原文 */
  mode: 'edit' | 'view';
  /** 只看原文的原因：原会话已删除 / 原文已变化；edit 时为 null */
  reason: 'gone' | 'changed' | null;
  /** 关闭后焦点还给它 */
  returnFocus: HTMLElement | null;
}

/** @brief 当前开着的预览对话框；没有时为 null。 */
export const useRefPreview = create<{ request: PreviewRequest | null }>(() => ({ request: null }));

/** @brief 打开预览对话框。 */
export function openPreview(request: Omit<PreviewRequest, 'returnFocus'>): void {
  const focused = document.activeElement;
  useRefPreview.setState({ request: { ...request, returnFocus: focused instanceof HTMLElement ? focused : null } });
}

/**
 * @brief 原会话（会话引用的、工作回顾里反馈所在的）被删除了：会话列表读完了、里面没有它，本次也没有打开它。
 */
export function sessionGone(state: AppState, sessionFile: string): boolean {
  return state.saved.status === 'ready'
    && !state.saved.sessions.some((item) => sameFile(item.sessionFile, sessionFile))
    && !state.tabs.some((tab) => sameFile(tab.sessionFile, sessionFile));
}

/** @brief 原会话现在的名字（与侧栏同一规则）；找不到时用引用时的名字。 */
export function sourceName(state: AppState, source: SessionSource): string {
  const tab = state.tabs.find((item) => sameFile(item.sessionFile, source.sessionFile));
  if (tab) return sessionTitle(tab);
  const saved = state.saved.sessions.find((item) => sameFile(item.sessionFile, source.sessionFile));
  return saved ? displayTitle(saved.name, saved.firstMessage) : source.name;
}

let pendingSeq = 0;

/** @brief 改一个会话的"正在读取或没能加入的引用"。 */
function setPending(tabKey: string, fn: (items: PendingRef[]) => PendingRef[]): void {
  updateTab(tabKey, (tab) => ({ ...tab, refPending: fn(tab.refPending) }));
}

/** @brief 去掉一个正在读取或没能加入的引用（× 或读完）。 */
export function dropPending(tabKey: string, id: number): void {
  setPending(tabKey, (items) => items.filter((item) => item.id !== id));
}

/** @brief 这个引用还在等（没有被 × 取消）。 */
function stillPending(tabKey: string, id: number): boolean {
  return Boolean(useApp.getState().tabs.find((tab) => tab.key === tabKey)?.refPending.some((item) => item.id === id));
}

/** @brief 读完之后：有已完成的轮次时按默认范围加芯片，否则说明为什么没加。 */
function settleRead(tabKey: string, pending: PendingRef, content: SessionContent): void {
  const turns = sessionTurns(content.entries, content.cwd);
  if (turns.length === 0) {
    const problem = `“${pending.title}” has no finished turns yet, so there’s nothing to attach.`;
    setPending(tabKey, (items) => items.map((item) => (item.id === pending.id ? { ...item, problem } : item)));
    return;
  }
  dropPending(tabKey, pending.id);
  addQuote(tabKey, sessionRef(content, turns, defaultRange(turns), pending.title));
}

/**
 * @brief 把一个会话引用进某一栏的输入框（拖进输入框、菜单"Attach as context"，两条路径相同）：后台进程读出它已完成的轮次，
 *        按默认范围加一个芯片；焦点到这一栏的输入框。同一个会话已经引用过时不再加。
 */
export async function referenceSession(tabKey: string, sessionFile: string, title: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  if (!tab || sameFile(tab.sessionFile, sessionFile)) return;
  focusPane(tabKey);
  focusComposer(tabKey);
  const taken = tab.draftRefs.some((ref) => ref.source.kind === 'session'
    && sameFile(ref.source.sessionFile, sessionFile));
  if (taken || tab.refPending.some((item) => sameFile(item.sessionFile, sessionFile) && !item.problem)) return;
  recordAction('Attach session as context');
  pendingSeq += 1;
  const pending: PendingRef = { id: pendingSeq, sessionFile, title, problem: null };
  setPending(tabKey, (items) => [...items.filter((item) => !sameFile(item.sessionFile, sessionFile)), pending]);
  try {
    const content = await request<SessionContent>({ type: 'session.read', sessionFile });
    if (stillPending(tabKey, pending.id)) settleRead(tabKey, pending, content);
  } catch (error) {
    const problem = `Couldn’t attach “${title}” as context: ${describe('session.read', error)}`;
    if (stillPending(tabKey, pending.id)) {
      setPending(tabKey, (items) => items.map((item) => (item.id === pending.id ? { ...item, problem } : item)));
    }
  }
}

/** @brief 用调整过范围的引用换掉输入框里原来的芯片。 */
export function replaceDraftRef(tabKey: string, old: QuoteRef, next: QuoteRef): void {
  updateTab(tabKey, (tab) => ({ ...tab,
    draftRefs: tab.draftRefs.map((item) => (refKey(item) === refKey(old) ? next : item)) }));
}

/** @brief 原会话里引用的那几轮在对话流里的各项：从第一轮你的消息到最后一轮的末尾；找不到第一轮时为 null。 */
function rangeKeys(tabKey: string, source: SessionSource): { from: number; keys: string[] } | null {
  const items = useApp.getState().tabs.find((tab) => tab.key === tabKey)?.transcript.items ?? [];
  const isUser = (item: (typeof items)[number], id: string) => item.kind === 'user' && item.entryId === id;
  const from = items.findIndex((item) => isUser(item, source.fromEntryId));
  if (from < 0) return null;
  const last = Math.max(from, items.findIndex((item) => isUser(item, source.toEntryId)));
  const next = items.findIndex((item, index) => index > last && item.kind === 'user');
  return { from, keys: items.slice(from, next < 0 ? items.length : next).map((item) => item.key) };
}

/** @brief 等这个会话打开完（就绪或打开失败）；返回就绪时它在界面里的标识，否则为 null。 */
function whenOpened(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const tab = useApp.getState().tabs.find((item) => item.key === key);
      if (tab?.phase === 'opening') return false;
      resolve(tab?.phase === 'ready' ? key : null);
      return true;
    };
    if (check()) return;
    const stop = useApp.subscribe(() => {
      if (check()) stop();
    });
  });
}

/**
 * @brief 打开原会话（会话引用的、工作回顾里反馈所在的），与在侧栏点它相同（已归档的先恢复，打开失败的重试，
 *        正在打开的等它打开完）；返回它在界面里的标识，打开失败或会话列表里没有它时为 null（会话横幅显示原文）。
 */
export async function showSession(sessionFile: string): Promise<string | null> {
  const open = tabByFile(sessionFile);
  if (open) {
    if (open.phase === 'failed') retryOpen(open.key);
    showChat(open.key);
    return whenOpened(open.key);
  }
  const state = useApp.getState();
  const saved = state.saved.sessions.find((item) => sameFile(item.sessionFile, sessionFile));
  if (!saved) return null;
  if (state.archived.includes(saved.sessionFile)) restoreSession(saved, false);
  await openSaved(saved);
  const tab = tabByFile(sessionFile);
  return tab ? whenOpened(tab.key) : null;
}

/**
 * @brief 点发出的会话引用回到原会话：原会话已删除时只看引用时的原文；否则打开它（与在侧栏点它相同），
 *        滚到第一轮、高亮引用的几轮；找不到那几轮时标"Source changed"并显示引用时的原文。
 */
export async function jumpToSession(tabKey: string, ref: QuoteRef): Promise<void> {
  const source = ref.source;
  if (source.kind !== 'session') return;
  recordAction('Jump to session from attached context');
  if (sessionGone(useApp.getState(), source.sessionFile)) {
    openPreview({ tabKey, ref, mode: 'view', reason: 'gone' });
    return;
  }
  const key = await showSession(source.sessionFile);
  if (!key) return;
  const found = rangeKeys(key, source);
  if (!found) {
    setQuoteStatus(refKey(ref), 'changed');
    openPreview({ tabKey, ref, mode: 'view', reason: 'changed' });
    return;
  }
  setQuoteStatus(refKey(ref), null);
  updateTab(key, (tab) => ({ ...tab, startIndex: Math.min(tab.startIndex, found.from),
    transcriptJump: { ...nextJump(ref), itemKey: found.keys[0]!, keys: found.keys } }));
}

// ---- 按依据回到原位置（docs/specs/memory.md §10.2） ----

/** 原会话不在了时 session.read 报的原文开头（kernel/sessions.ts readSession） */
const NOT_FOUND = 'Session file not found';

/** @brief 原会话已删除（§10.2，同 M7）。 */
export const SESSION_DELETED = 'Session deleted';

/** @brief 会话列表还没读好、原会话也没打开时打不开它的说明（按会话列表的状态，同 M7）。 */
const LIST_NOT_READY: Record<AppState['saved']['status'], string> = {
  loading: 'Sessions are still loading. Try again in a moment.',
  failed: 'Couldn’t load sessions, so the original session can’t be opened.',
  ready: 'The original session isn’t in your session list.',
};

/** 依据的条目不在当前分支上 */
const MESSAGE_GONE = 'This message is no longer in the session.';
/** 反馈引用的回复不在了（M7） */
const RESPONSE_GONE = 'This response is no longer in the session.';
/** 反馈所在的会话没有保存（M7） */
const NOT_SAVED = 'The session wasn’t saved, so there’s no source to jump to.';
/** 依据没有记下条目（分开时立项记的）：只打开会话 */
const NOT_RECORDED = 'Opened the session; the exact message wasn’t recorded.';

/** @brief 回到原位置之后的一行说明：warn 跳不过去，error 读取出错的原文，info 打开了但没有定位。 */
export interface JumpNote {
  /** 语气 */
  tone: 'warn' | 'error' | 'info';
  /** 文字 */
  text: string;
}

/** @brief 跳转的结果：null 为已经跳过去；cancelled 为发起跳转的页面已经离开（不切会话、不显示状态）；否则为说明。 */
export type JumpResult = JumpNote | null | 'cancelled';

/** @brief 路径统一成小写、正斜杠（Windows 路径比较，§7.3 同样不分大小写与斜杠）。 */
function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** @brief 文件所在的文件夹。 */
function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/**
 * @brief 会话文件是不是 TaskBoard 实例会话（<userData>/teams/<会话 id>/sessions/ 下，不进侧栏，§10.2）；
 *        agentDir 是 <userData>/pi。
 */
export function isTeamSessionFile(file: string, agentDir: string): boolean {
  const teams = `${pathKey(parentOf(agentDir))}/teams/`;
  const key = pathKey(file);
  return key.startsWith(teams) && key.slice(teams.length).includes('/sessions/');
}

/** @brief 打不开原会话时的说明（会话列表还没读好或读取失败，原会话也没打开），并记录错误日志。 */
function notListed(file: string): JumpNote {
  const status = useApp.getState().saved.status;
  console.error(`[renderer] cannot open the source session: ${file} (session list ${status})`);
  return { tone: 'error', text: LIST_NOT_READY[status] };
}

/** @brief session.read 的失败：原会话不在了，或其他原文。 */
function readFailure(error: unknown): JumpNote {
  const text = describe('session.read', error);
  return text.includes(NOT_FOUND) ? { tone: 'warn', text: SESSION_DELETED } : { tone: 'error', text };
}

/**
 * @brief 条目在对话流里落在哪条消息上（条目 id）：后台进程在完整的当前分支上找这个条目或它之上最近的一条你的消息或
 *        助手回复（session.read 带 anchor，§8；不受会话在生成、文件大小的影响）。不在当前分支时为 null。
 */
async function anchorOf(file: string, entryId: string): Promise<string | null> {
  const content = await request<SessionContent>({ type: 'session.read', sessionFile: file, anchor: entryId });
  return content.anchor ?? null;
}

/** @brief 在已打开的会话里滚到这条消息并高亮（同 M7 的时长）；对话流里没有它时返回说明。 */
function flashEntry(key: string, file: string, entryId: string, quote: string): JumpNote | null {
  const tab = useApp.getState().tabs.find((item) => item.key === key);
  const items = tab?.transcript.items ?? [];
  const index = items.findIndex((item) => (item.kind === 'user' || item.kind === 'assistant')
    && item.entryId === entryId);
  const item = items[index];
  if (!item) return { tone: 'warn', text: MESSAGE_GONE };
  const ref: QuoteRef = { quote: quote || entryId,
    source: { kind: 'message', sessionFile: file, entryId, time: null, scope: 'reply' } };
  updateTab(key, (current) => ({ ...current, startIndex: Math.min(current.startIndex, index),
    transcriptJump: { ...nextJump(ref), itemKey: item.key, keys: [item.key] } }));
  return null;
}

/**
 * @brief 按会话依据回到原位置（§10.2 第一、四行）：原会话已删除时不打开；有条目时先确认它在当前分支上，不在时留在原页面、
 *        说明"This message is no longer in the session."；然后打开原会话（与在侧栏点它相同），滚到含这个条目的那条消息
 *        并高亮。没有记下条目时只打开会话。检查期间离开了发起跳转的页面（stillHere 为假）时不再打开会话。
 * @param quote 依据的原话（只作高亮请求的标识）
 */
export async function jumpToEntry(file: string, entryId: string | null, quote: string,
  stillHere: () => boolean): Promise<JumpResult> {
  if (sessionGone(useApp.getState(), file)) return { tone: 'warn', text: SESSION_DELETED };
  let anchor: string | null = null;
  if (entryId) {
    try {
      anchor = await anchorOf(file, entryId);
    } catch (error) {
      return stillHere() ? readFailure(error) : 'cancelled';
    }
    if (!stillHere()) return 'cancelled';
    if (!anchor) return { tone: 'warn', text: MESSAGE_GONE };
  }
  if (!stillHere()) return 'cancelled';
  const key = await showSession(file);
  if (!key) return stillHere() ? notListed(file) : 'cancelled';
  return anchor ? flashEntry(key, file, anchor, quote) : { tone: 'info', text: NOT_RECORDED };
}

/** @brief 会话记录里这一条是不是锚点指向的助手回复：先按条目 id，再按消息时间（M7）。 */
function isAnchor(entry: SessionEntry, source: MessageSource): boolean {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return false;
  return (source.entryId !== null && entry.id === source.entryId)
    || (source.time !== null && entry.message.timestamp === source.time);
}

/** @brief 反馈引用的那条回复还在不在（M7）：会话开着时看对话流，没开着时读会话文件（session.read）。 */
async function replyStatus(file: string, source: MessageSource): Promise<JumpNote | null> {
  const tab = tabByFile(file);
  if (tab?.phase === 'ready') {
    return findSourceIndex(tab.transcript.items, source) >= 0 ? null : { tone: 'warn', text: RESPONSE_GONE };
  }
  try {
    const content = await request<SessionContent>({ type: 'session.read', sessionFile: file });
    return content.entries.some((entry) => isAnchor(entry, source)) ? null : { tone: 'warn', text: RESPONSE_GONE };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * @brief 按反馈依据回到反馈的来源（§10.2 第三行，M7 的回复、选区、文件三种跳法）：会话没有保存或已删除时不打开；
 *        回复里的先确认那条回复还在；然后打开原会话，交给 M4 的点芯片回到原位置（文件里的在右栏打开阅读器）。
 */
export async function jumpToFeedback(feedback: StoredFeedback, stillHere: () => boolean): Promise<JumpResult> {
  const { source, session, quote } = feedback;
  const file = source.kind === 'message' ? source.sessionFile ?? session.file : session.file;
  if (!file) return { tone: 'warn', text: NOT_SAVED };
  if (sessionGone(useApp.getState(), file)) return { tone: 'warn', text: SESSION_DELETED };
  if (source.kind === 'message') {
    const problem = await replyStatus(file, source);
    if (!stillHere()) return 'cancelled';
    if (problem) return problem;
  }
  if (!stillHere()) return 'cancelled';
  const key = await showSession(file);
  if (!key) return stillHere() ? notListed(file) : 'cancelled';
  jumpToQuote(key, { quote, source });
  return null;
}
