// 设置页的 UI issues（docs/specs/memory.md §10.8，沿用 M7 工作回顾的界面问题部分，docs/v0/screens/review.md）：
// 主进程读出的 F8 报告、选中的报告、已处理与"Hide resolved"（本机 localStorage 的 mori.review，与已归档相同；
// 只用 ui-issues/ 开头的键）、导出与打开文件夹的结果。报告只读不改，全部经主进程，后台进程退出后照常可用。

import { create } from 'zustand';
import type { IssueItem, IssueRecord } from '../../../shared/issueRecords';
import { recordAction } from './actionLog';
import { mainError } from './bridge';
import { guardLeave } from './leaveGuard';
import { showSettingsSection, useSettings } from './settings';
import { useApp } from './store';

/** 本机存放已处理标记和"Hide resolved"的键（沿用 M7） */
const STORAGE_KEY = 'mori.review';
/** 已处理标记的键前缀：报告所在的文件夹（M7 另有 feedback/ 开头的键，不再使用） */
const HANDLED_PREFIX = 'ui-issues/';
/** 报告里没有填写的一节（main/feedback.ts written 写的同一串） */
const EMPTY_FIELD = '(left blank)';

/**
 * @brief 工具行下面的一行结果：导出成功（file 是导出文件的完整路径，count 是导出的条数，即列出的），
 *        或导出、打开文件夹失败（text 是显示的文字，含原文）。
 */
export type IssuesNotice = { kind: 'exported'; file: string; count: number } | { kind: 'error'; text: string };

/** @brief UI issues 的状态。 */
interface IssuesState {
  /** 读到的报告（从新到旧）；第一次读完之前为 null */
  records: IssueItem[] | null;
  /** 正在读 */
  loading: boolean;
  /** 读取失败的原文 */
  error: string | null;
  /** 选中的报告（文件名）；没有选中时为 null */
  selected: string | null;
  /** 从"View in Settings"过来、要滚到看得见的地方的报告（文件名）；列表滚过去后清掉，平常为 null */
  reveal: string | null;
  /** 已处理的报告："ui-issues/<文件名>"（本机保存） */
  handled: string[];
  /** Hide resolved（本机保存） */
  hideHandled: boolean;
  /** 工具行下面的结果 */
  notice: IssuesNotice | null;
}

/** @brief 读出本机保存的已处理标记（只取 ui-issues/ 开头的）和开关；读不出来时记录错误并当作没有。 */
function loadStored(): Pick<IssuesState, 'handled' | 'hideHandled'> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const handled = Array.isArray(value.handled)
      ? value.handled.filter((item): item is string => typeof item === 'string' && item.startsWith(HANDLED_PREFIX))
      : [];
    return { handled, hideHandled: value.hideHandled === true };
  } catch (error) {
    console.error(`[renderer] cannot read the UI issue marks: ${(error as Error).message}`);
    return { handled: [], hideHandled: false };
  }
}

/** @brief 写回已处理标记和开关。 */
function saveStored(state: Pick<IssuesState, 'handled' | 'hideHandled'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ handled: state.handled, hideHandled: state.hideHandled }));
  } catch (error) {
    console.error(`[renderer] cannot save the UI issue marks: ${(error as Error).message}`);
  }
}

/** @brief UI issues 的状态（报告、选中、已处理、工具行下面的结果）。 */
export const useUiIssues = create<IssuesState>(() => ({
  records: null, loading: false, error: null, selected: null, reveal: null, notice: null, ...loadStored(),
}));

/** @brief 已处理标记的键：报告所在的文件夹加文件名。 */
function handledKey(name: string): string {
  return `${HANDLED_PREFIX}${name}`;
}

/** @brief 一份报告是否已处理。 */
export function isHandled(state: IssuesState, name: string): boolean {
  return state.handled.includes(handledKey(name));
}

/** @brief 列出的报告："Hide resolved"开着时不含已处理的。 */
export function visibleIssues(state: IssuesState): IssueItem[] {
  const all = state.records ?? [];
  return state.hideHandled ? all.filter((item) => !isHandled(state, item.name)) : all;
}

/** @brief 未处理的条数。 */
export function unhandledCount(state: IssuesState): number {
  return (state.records ?? []).filter((item) => !isHandled(state, item.name)).length;
}

/** @brief 选中、而且还在读到的报告里的那一份（右栏显示它的详情）；没有时为 null。 */
export function selectedIssue(state: IssuesState): IssueItem | null {
  const name = state.selected;
  return (name && state.records?.find((item) => item.name === name)) || null;
}

/** @brief 完整路径里的文件名（"View in Settings"按文件名选中刚保存的报告）。 */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * @brief 报告的时间文字：主进程读出的报告标题里的本地时间 YYYY-MM-DD HH:mm:ss。
 * @param full 为真时是详情里的完整时间；否则是列表里的"10-20 14:03"，不是今年的带年份"2025-10-20 14:03"
 */
export function recordTime(record: IssueRecord, full: boolean): string {
  if (full) return record.time;
  const thisYear = record.time.startsWith(`${new Date().getFullYear()}-`);
  return record.time.slice(thisYear ? 5 : 0, 16);
}

/** @brief 报告的摘要："What went wrong"；没有填写时用"What you expected"。 */
export function issueTitle(record: IssueRecord): string {
  return record.what === EMPTY_FIELD ? record.expect : record.what;
}

/** @brief 设置页正显示 UI issues 这一节。 */
function issuesShown(): boolean {
  return useApp.getState().view === 'settings' && useSettings.getState().section === 'issues';
}

/** @brief 选中的报告还在读到的报告里才保留。 */
function keptSelection(selected: string | null, records: IssueItem[]): string | null {
  return selected && records.some((item) => item.name === selected) ? selected : null;
}

/** @brief 读出报告（换到这一节、页面开着时保存了新报告、"Retry"时）。 */
export async function loadIssues(): Promise<void> {
  useUiIssues.setState({ loading: true, error: null });
  try {
    const records = await window.mori.listIssues();
    useUiIssues.setState((state) => ({ records, loading: false, selected: keptSelection(state.selected, records) }));
  } catch (error) {
    useUiIssues.setState({ loading: false, error: mainError('listIssues', error) });
  }
}

/** 上一次看时 UI issues 是否显示着 */
let wasShown = false;

/** @brief 换到 UI issues（进入设置页落在这一节，或在设置页里换到这一节）时重新读取。 */
function onShownChange(): void {
  const shown = issuesShown();
  if (shown && !wasShown) void loadIssues();
  wasShown = shown;
}

// settings.ts 先订阅（本模块 import 它），进入设置页时它先定下分节，这里看到的就是落到的那一节。
useApp.subscribe(onShownChange);
useSettings.subscribe(onShownChange);

/**
 * @brief 打开 设置 → UI issues；从 F8 的"View in Settings"过来时选中那一份并滚到看得见的地方。
 *        有未保存的改动时先问。
 * @param name 要选中的报告（文件名）
 */
export function openIssues(name?: string): void {
  guardLeave(() => {
    if (name) {
      recordAction('View in Settings');
      useUiIssues.setState({ selected: name, reveal: name });
    }
    if (issuesShown()) void loadIssues();
    else showSettingsSection('issues');
  });
}

/** @brief UI issues 开着时，保存了新的报告（F8 报告框）：重新读。 */
export function issuesChanged(): void {
  if (issuesShown()) void loadIssues();
}

/** @brief 选中一份报告（右栏显示详情）；name 为 null 时关闭详情。 */
export function selectIssue(name: string | null): void {
  if (name) recordAction('View record: UI issues');
  useUiIssues.setState({ selected: name });
}

/** @brief 标为已处理或未处理。 */
export function setHandled(name: string, done: boolean): void {
  recordAction(done ? 'Resolve' : 'Reopen');
  const key = handledKey(name);
  useUiIssues.setState((state) => {
    const handled = done ? [...state.handled.filter((item) => item !== key), key]
      : state.handled.filter((item) => item !== key);
    saveStored({ handled, hideHandled: state.hideHandled });
    return { handled };
  });
}

/** @brief 打开或关掉"Hide resolved"。 */
export function setHideHandled(hideHandled: boolean): void {
  recordAction(hideHandled ? 'Hide resolved' : 'Show resolved');
  useUiIssues.setState((state) => {
    saveStored({ handled: state.handled, hideHandled });
    return { hideHandled };
  });
}

/** @brief 记下工具行下面的结果。 */
function setNotice(notice: IssuesNotice | null): void {
  useUiIssues.setState({ notice });
}

/** @brief 导出列出的报告（弹保存对话框）；取消时什么都不变。 */
export async function exportListed(): Promise<void> {
  const state = useUiIssues.getState();
  const names = visibleIssues(state).map((item) => item.name);
  if (!names.length) return;
  recordAction('Export: UI issues');
  const handled = names.filter((name) => isHandled(state, name));
  try {
    const { file } = await window.mori.exportIssues({ names, handled });
    if (file) setNotice({ kind: 'exported', file, count: names.length });
  } catch (error) {
    setNotice({ kind: 'error', text: `Couldn’t export: ${mainError('exportIssues', error)}` });
  }
}

/** @brief 在资源管理器里选中刚导出的文件。 */
export async function showExported(file: string): Promise<void> {
  try {
    await window.mori.showExport(file);
  } catch (error) {
    setNotice({ kind: 'error', text: mainError('showExport', error) });
  }
}

/** @brief 在资源管理器里打开报告文件夹；打开了时清掉上一次打不开的原文（"Exported …"那一行留着）。 */
export async function openReportsFolder(): Promise<void> {
  recordAction('Open folder: UI issues');
  try {
    const { error } = await window.mori.openIssuesFolder();
    if (error) setNotice({ kind: 'error', text: `Couldn’t open the folder: ${error}` });
    else if (useUiIssues.getState().notice?.kind === 'error') setNotice(null);
  } catch (error) {
    setNotice({ kind: 'error', text: `Couldn’t open the folder: ${mainError('openIssuesFolder', error)}` });
  }
}

/** @brief 右栏是否显示 UI issues 的详情：在设置页的 UI issues 这一节，并且选中的报告还在读到的报告里。 */
export function useIssuesDetailOpen(): boolean {
  const settings = useApp((state) => state.view === 'settings');
  const section = useSettings((state) => state.section === 'issues');
  const selected = useUiIssues((state) => selectedIssue(state) !== null);
  return settings && section && selected;
}
