// 工作回顾（方案 5.14，状态表见 docs/v0/screens/review.md）：主进程读出的两类记录、当前分节、各分节选中的记录、
// 已处理与"Hide resolved"（本机 localStorage，与已归档相同）、回到原位置的检查结果、导出与打开文件夹的结果。
// 记录只读不改；只有回到原位置要用后台进程（读会话、打开会话）。

import { create } from 'zustand';
import type { MessageSource, SessionContent, SessionEntry } from '../../../shared/protocol';
import {
  KIND_LABEL, type BrokenRecord, type FeedbackRecord, type IssueRecord, type ReviewKind, type ReviewRecords,
} from '../../../shared/review';
import { displayTitle, sessionTitle } from '../components/ChatPane';
import { recordAction } from './actionLog';
import { describe, mainError, request } from './bridge';
import { guardLeave } from './leaveGuard';
import { findSourceIndex, jumpToQuote } from './quotes';
import { sessionGone, showSession } from './refActions';
import { sameFile, tabByFile, useApp, type AppState } from './store';

/** 本机存放已处理标记和"Hide resolved"的键 */
const STORAGE_KEY = 'mori.review';
/** 原会话不在了时 session.read 报的原文开头（kernel/sessions.ts readSession） */
const NOT_FOUND = 'Session file not found';
/** 会话列表还没读好、原会话也没打开时，回到原位置打不开它的说明（按会话列表的状态） */
const LIST_NOT_READY: Record<AppState['saved']['status'], string> = {
  loading: 'Sessions are still loading. Try again in a moment.',
  failed: 'Couldn’t load sessions, so the original session can’t be opened.',
  ready: 'The original session isn’t in your session list.',
};

/** @brief 列表里的一条记录。 */
export type ReviewItem = FeedbackRecord | IssueRecord | BrokenRecord;

/** @brief 回到原位置的检查结果：正在检查 / 原文已变化 / 原会话已删除 / 打不开（text 是显示的原文或说明）。 */
export type JumpState = { kind: 'checking' } | { kind: 'changed' } | { kind: 'gone' } | { kind: 'error'; text: string };

/**
 * @brief 工具行下面的一行结果：导出成功（file 是导出文件的完整路径，count 是导出的条数，即这一节列出的），
 *        或导出、打开文件夹失败（text 是显示的文字，含原文）。
 */
export type ReviewNotice = { kind: 'exported'; file: string; count: number } | { kind: 'error'; text: string };

/** @brief 工作回顾的状态。 */
interface ReviewState {
  /** 读到的记录；第一次读完之前为 null */
  records: ReviewRecords | null;
  /** 正在读 */
  loading: boolean;
  /** 读取失败的原文 */
  error: string | null;
  /** 当前分节 */
  section: ReviewKind;
  /** 各分节选中的记录（文件名）；没有选中时为 null */
  selected: Record<ReviewKind, string | null>;
  /** 从"View in Review"过来、要滚到看得见的地方的记录（文件名）；列表滚过去后清掉，平常为 null */
  reveal: string | null;
  /** 已处理的记录："feedback/<文件名>" 或 "ui-issues/<文件名>"（本机保存） */
  handled: string[];
  /** Hide resolved（两个分节共用，本机保存） */
  hideHandled: boolean;
  /** 回到原位置的检查结果（按反馈的文件名），只在这次运行的内存里 */
  jumps: Record<string, JumpState>;
  /** 各分节工具行下面的结果 */
  notices: Record<ReviewKind, ReviewNotice | null>;
}

/** @brief 读出本机保存的已处理标记和开关；读不出来时记录错误并当作没有。 */
function loadStored(): Pick<ReviewState, 'handled' | 'hideHandled'> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const handled = Array.isArray(value.handled) ? value.handled.filter((item) => typeof item === 'string') : [];
    return { handled, hideHandled: value.hideHandled === true };
  } catch (error) {
    console.error(`[renderer] cannot read the review marks: ${(error as Error).message}`);
    return { handled: [], hideHandled: false };
  }
}

/** @brief 写回已处理标记和开关。 */
function saveStored(state: Pick<ReviewState, 'handled' | 'hideHandled'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ handled: state.handled, hideHandled: state.hideHandled }));
  } catch (error) {
    console.error(`[renderer] cannot save the review marks: ${(error as Error).message}`);
  }
}

/** @brief 工作回顾的状态（记录、分节、选中、已处理、回到原位置的结果、工具行下面的结果）。 */
export const useReview = create<ReviewState>(() => ({
  records: null, loading: false, error: null, section: 'feedback', selected: { feedback: null, issues: null },
  reveal: null, jumps: {}, notices: { feedback: null, issues: null }, ...loadStored(),
}));

/** @brief 已处理标记的键：记录所在的文件夹加文件名。 */
function handledKey(kind: ReviewKind, name: string): string {
  return `${kind === 'feedback' ? 'feedback' : 'ui-issues'}/${name}`;
}

/** @brief 一条记录是否已处理。 */
export function isHandled(state: ReviewState, kind: ReviewKind, name: string): boolean {
  return state.handled.includes(handledKey(kind, name));
}

/** @brief 一个分节的全部记录。 */
export function recordsOf(state: ReviewState, kind: ReviewKind): ReviewItem[] {
  return state.records?.[kind] ?? [];
}

/** @brief 一个分节列出的记录："Hide resolved"开着时不含已处理的。 */
export function visibleRecords(state: ReviewState, kind: ReviewKind): ReviewItem[] {
  const all = recordsOf(state, kind);
  return state.hideHandled ? all.filter((item) => !isHandled(state, kind, item.name)) : all;
}

/** @brief 一个分节未处理的条数。 */
export function unhandledCount(state: ReviewState, kind: ReviewKind): number {
  return recordsOf(state, kind).filter((item) => !isHandled(state, kind, item.name)).length;
}

/** @brief 当前分节选中、而且还在读到的记录里的那一条（右栏显示它的详情）；没有时为 null。 */
export function selectedRecord(state: ReviewState): ReviewItem | null {
  const name = state.selected[state.section];
  return (name && recordsOf(state, state.section).find((item) => item.name === name)) || null;
}

/** @brief 完整路径里的文件名（"View in Review"按文件名选中刚保存的记录）。 */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** @brief 选中的记录还在读到的记录里才保留。 */
function keptSelection(state: ReviewState, records: ReviewRecords): Record<ReviewKind, string | null> {
  const keep = (kind: ReviewKind) => {
    const name = state.selected[kind];
    return name && records[kind].some((item) => item.name === name) ? name : null;
  };
  return { feedback: keep('feedback'), issues: keep('issues') };
}

/** @brief 读出两类记录（打开工作回顾、保存了新报告、"Retry"时）。 */
export async function loadReview(): Promise<void> {
  useReview.setState({ loading: true, error: null });
  try {
    const records = await window.mori.listReview();
    useReview.setState((state) => ({ records, loading: false, selected: keptSelection(state, records) }));
  } catch (error) {
    useReview.setState({ loading: false, error: mainError('listReview', error) });
  }
}

/**
 * @brief 打开工作回顾；从"View in Review"过来时切到那一节、选中那一条并滚到看得见的地方。
 *        从有未保存改动的设置页过来时先问。
 * @param section 要显示的分节；不给时保持上次的
 * @param name 要选中的记录（文件名）
 */
export function openReview(section?: ReviewKind, name?: string): void {
  guardLeave(() => {
    recordAction(name ? 'View in Review' : 'Open Review');
    useReview.setState((state) => ({ section: section ?? state.section, reveal: name ?? null,
      selected: section && name ? { ...state.selected, [section]: name } : state.selected }));
    useApp.setState({ view: 'review' });
    void loadReview();
  });
}

/** @brief 工作回顾开着时，保存了新的记录（F8 报告框）：重新读。 */
export function reviewChanged(): void {
  if (useApp.getState().view === 'review') void loadReview();
}

/** @brief 切换分节。 */
export function chooseSection(section: ReviewKind): void {
  recordAction(`Review: ${KIND_LABEL[section]}`);
  useReview.setState({ section });
}

/** @brief 选中一条记录（右栏显示详情）；name 为 null 时关闭详情。 */
export function selectRecord(kind: ReviewKind, name: string | null): void {
  if (name) recordAction(`View record: ${KIND_LABEL[kind]}`);
  useReview.setState((state) => ({ selected: { ...state.selected, [kind]: name } }));
}

/** @brief 标为已处理或未处理。 */
export function setHandled(kind: ReviewKind, name: string, done: boolean): void {
  recordAction(done ? 'Resolve' : 'Reopen');
  const key = handledKey(kind, name);
  useReview.setState((state) => {
    const handled = done ? [...state.handled.filter((item) => item !== key), key]
      : state.handled.filter((item) => item !== key);
    saveStored({ handled, hideHandled: state.hideHandled });
    return { handled };
  });
}

/** @brief 打开或关掉"Hide resolved"。 */
export function setHideHandled(hideHandled: boolean): void {
  recordAction(hideHandled ? 'Hide resolved' : 'Show resolved');
  useReview.setState((state) => {
    saveStored({ handled: state.handled, hideHandled });
    return { hideHandled };
  });
}

/** @brief 反馈所在的会话文件：回复里的用锚点里的，文件里的用反馈时所在的会话。 */
export function feedbackSessionFile(record: FeedbackRecord): string | null {
  const { source, session } = record.feedback;
  return source.kind === 'message' ? source.sessionFile ?? session.file : session.file;
}

/** @brief 反馈所在会话现在的名字（与侧栏同一规则）；找不到时用记录里的名字。 */
export function feedbackSessionName(state: AppState, record: FeedbackRecord): string {
  const file = feedbackSessionFile(record);
  const tab = file ? state.tabs.find((item) => sameFile(item.sessionFile, file)) : undefined;
  if (tab) return sessionTitle(tab);
  const saved = file ? state.saved.sessions.find((item) => sameFile(item.sessionFile, file)) : undefined;
  return saved ? displayTitle(saved.name, saved.firstMessage) : record.feedback.session.title || 'Untitled session';
}

/** 点"Jump to source"的次数：检查期间你又点了别的"Jump to source"时，先点的那次检查完不再打开会话 */
let jumpSeq = 0;

/** @brief 记下一条反馈回到原位置的检查结果；null 为清掉。 */
function setJump(name: string, jump: JumpState | null): void {
  useReview.setState((state) => {
    const { [name]: _old, ...rest } = state.jumps;
    return { jumps: jump ? { ...rest, [name]: jump } : rest };
  });
}

/** @brief 会话记录里这一条是不是锚点指向的助手回复：先按条目 id，再按消息时间。 */
function isAnchor(entry: SessionEntry, source: MessageSource): boolean {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return false;
  return (source.entryId !== null && entry.id === source.entryId)
    || (source.time !== null && entry.message.timestamp === source.time);
}

/** @brief 那条回复还在不在：会话开着时看对话流，没开着时读会话文件（session.read）。 */
async function replyStatus(file: string, source: MessageSource): Promise<JumpState | null> {
  const tab = tabByFile(file);
  if (tab?.phase === 'ready') return findSourceIndex(tab.transcript.items, source) >= 0 ? null : { kind: 'changed' };
  try {
    const content = await request<SessionContent>({ type: 'session.read', sessionFile: file });
    return content.entries.some((entry) => isAnchor(entry, source)) ? null : { kind: 'changed' };
  } catch (error) {
    const text = describe('session.read', error);
    return text.includes(NOT_FOUND) ? { kind: 'gone' } : { kind: 'error', text };
  }
}

/** @brief 原会话打不开（会话列表还没读好或读取失败，原会话也没打开）：记录错误日志，详情里说明。 */
function sessionNotListed(record: FeedbackRecord, file: string): void {
  const status = useApp.getState().saved.status;
  console.error(`[renderer] cannot open the session of feedback ${record.name}: ${file} (session list ${status})`);
  setJump(record.name, { kind: 'error', text: LIST_NOT_READY[status] });
}

/**
 * @brief 回到原位置：原会话已删除时不打开；回复里的先确认那条回复还在，不在时留在工作回顾、说明
 *        "This response is no longer in the session."；否则打开原会话（与在侧栏点它相同），交给 M4 的点芯片回到原位置
 *        滚过去高亮（文件里的在右栏打开阅读器）。检查期间你离开了工作回顾或点了别的"Jump to source"时，检查完只记下结果，
 *        不再打开会话。
 */
export async function jumpBack(record: FeedbackRecord): Promise<void> {
  const file = feedbackSessionFile(record);
  if (!file) return;
  recordAction('Jump to source from Review');
  const seq = ++jumpSeq;
  setJump(record.name, null);
  const { source, quote } = record.feedback;
  if (sessionGone(useApp.getState(), file)) {
    setJump(record.name, { kind: 'gone' });
    return;
  }
  if (source.kind === 'message') {
    setJump(record.name, { kind: 'checking' });
    const problem = await replyStatus(file, source);
    setJump(record.name, problem);
    if (problem || seq !== jumpSeq || useApp.getState().view !== 'review') return;
  }
  const key = await showSession(file);
  if (key) jumpToQuote(key, { quote, source });
  else if (useApp.getState().view === 'review') sessionNotListed(record, file);
}

/** @brief 记下一个分节工具行下面的结果。 */
function setNotice(kind: ReviewKind, notice: ReviewNotice | null): void {
  useReview.setState((state) => ({ notices: { ...state.notices, [kind]: notice } }));
}

/** @brief 导出这一节列出的记录（弹保存对话框）；取消时什么都不变。 */
export async function exportKind(kind: ReviewKind): Promise<void> {
  const state = useReview.getState();
  const names = visibleRecords(state, kind).map((item) => item.name);
  if (!names.length) return;
  recordAction(`Export: ${KIND_LABEL[kind]}`);
  const handled = names.filter((name) => isHandled(state, kind, name));
  try {
    const { file } = await window.mori.exportReview({ kind, names, handled });
    if (file) setNotice(kind, { kind: 'exported', file, count: names.length });
  } catch (error) {
    setNotice(kind, { kind: 'error', text: `Couldn’t export: ${mainError('exportReview', error)}` });
  }
}

/** @brief 在资源管理器里选中刚导出的文件。 */
export async function showExported(kind: ReviewKind, file: string): Promise<void> {
  try {
    await window.mori.showExport(file);
  } catch (error) {
    setNotice(kind, { kind: 'error', text: mainError('showExport', error) });
  }
}

/** @brief 在资源管理器里打开这一节的文件夹；打开了时清掉上一次打不开的原文（"Exported …"那一行留着）。 */
export async function openKindFolder(kind: ReviewKind): Promise<void> {
  recordAction(`Open folder: ${KIND_LABEL[kind]}`);
  try {
    const { error } = await window.mori.openReviewFolder(kind);
    if (error) setNotice(kind, { kind: 'error', text: `Couldn’t open the folder: ${error}` });
    else if (useReview.getState().notices[kind]?.kind === 'error') setNotice(kind, null);
  } catch (error) {
    setNotice(kind, { kind: 'error', text: `Couldn’t open the folder: ${mainError('openReviewFolder', error)}` });
  }
}
