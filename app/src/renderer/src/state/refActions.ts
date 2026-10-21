// 会话引用的操作（docs/v0/screens/session-refs.md）：加进输入框（拖进输入框或菜单"引用到当前会话"）、
// 原会话现在的名字和是否已删除、点引用回到原会话、预览对话框的请求。内容的整理在 sessionRefs.ts。

import { create } from 'zustand';
import type { QuoteRef, SessionContent, SessionSource } from '../../../shared/protocol';
import { displayTitle, sessionTitle } from '../components/ChatPane';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { openSaved, restoreSession, retryOpen, showChat } from './projects';
import { addQuote, nextJump, refKey, setQuoteStatus } from './quotes';
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
    const problem = `'${pending.title}'还没有完成的一轮，没有可引用的内容`;
    setPending(tabKey, (items) => items.map((item) => (item.id === pending.id ? { ...item, problem } : item)));
    return;
  }
  dropPending(tabKey, pending.id);
  addQuote(tabKey, sessionRef(content, turns, defaultRange(turns), pending.title));
}

/**
 * @brief 把一个会话引用进某一栏的输入框（拖进输入框、菜单"引用到当前会话"，两条路径相同）：后台进程读出它已完成的轮次，
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
  recordAction('引用会话');
  pendingSeq += 1;
  const pending: PendingRef = { id: pendingSeq, sessionFile, title, problem: null };
  setPending(tabKey, (items) => [...items.filter((item) => !sameFile(item.sessionFile, sessionFile)), pending]);
  try {
    const content = await request<SessionContent>({ type: 'session.read', sessionFile });
    if (stillPending(tabKey, pending.id)) settleRead(tabKey, pending, content);
  } catch (error) {
    const problem = `读取会话'${title}'失败：${describe('session.read', error)}`;
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
 *        滚到第一轮、高亮引用的几轮；找不到那几轮时标"原文已变化"并显示引用时的原文。
 */
export async function jumpToSession(tabKey: string, ref: QuoteRef): Promise<void> {
  const source = ref.source;
  if (source.kind !== 'session') return;
  recordAction('点引用回到原会话');
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
