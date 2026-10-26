// 右栏 Background tasks 的操作（docs/specs/parallel-agents-taskboard.md §13.13；docs/v1/screens/team-tasks.md）：
// 从入口打开到某一层、切页签、回到上一层、Finished 的折叠、读 task 的详情与实例会话（两个只读命令），以及停止一个 task
// （session.stopTask：停止中按钮不可用，失败的原文显示在卡片下面）。操作记录照 §13.13.6。

import { create } from 'zustand';
import type { TeamCommandResults } from '../../../shared/protocol';
import { roleLabel, type SessionOf } from '../../../shared/team';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { updateTab, useApp, type RightTab, type TasksAt, type TasksBack } from './store';

/** @brief 操作记录里打开一条会话的写法（§13.13.6）：`View transcript: T1 · <role>` / `View transcript: Request 1 · closing`。 */
function transcriptAction(of: SessionOf): string {
  return of.kind === 'task' ? `View transcript: ${of.task} · ${roleLabel(of.role)}`
    : `View transcript: Request ${of.request} · closing`;
}

/** @brief 进入某一层时的操作记录（task 的视图、会话；列表不另记）。 */
function recordLevel(at: TasksAt): void {
  if (at.level === 'task') recordAction(`Open ${at.task} in Background tasks`);
  if (at.level === 'transcript') recordAction(transcriptAction(at.of));
}

/**
 * @brief 从入口（进展摘要的链接、模型菜单）打开右栏到 Background tasks 的某一层；at 为 null 时停在上次看的那一层。
 *        右栏浮在上层时（窄窗口、分屏放不下）由 App 按 opened 浮出。
 */
export function openTasks(tabKey: string, at: TasksAt | null): void {
  recordAction('Open background tasks');
  if (at) recordLevel(at);
  updateTab(tabKey, (tab) => ({ ...tab, rightOpen: true, rightTab: 'tasks',
    tasks: { ...tab.tasks, at: at ?? tab.tasks.at, opened: tab.tasks.opened + 1 } }));
}

/** @brief 点页签（§13.13.1）：切到 Changes 或 Background tasks（停在上次看的那一层）。 */
export function showRightTab(tabKey: string, which: RightTab): void {
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  if (!tab || tab.rightTab === which) return;
  if (which === 'tasks') recordAction('Open background tasks');
  updateTab(tabKey, (current) => ({ ...current, rightTab: which }));
}

/** @brief 在这一栏里换一层（点卡片、依赖、View transcript）。 */
export function showTasksAt(tabKey: string, at: TasksAt): void {
  recordLevel(at);
  updateTab(tabKey, (tab) => ({ ...tab, tasks: { ...tab.tasks, at } }));
}

/** @brief Back：回到列表或打开会话的那个 task 的视图（不另记操作）。 */
export function backTo(tabKey: string, back: TasksBack): void {
  const at: TasksAt = back.level === 'list' ? { level: 'list', highlight: null } : back;
  updateTab(tabKey, (tab) => ({ ...tab, tasks: { ...tab.tasks, at } }));
}

/** @brief Finished 一节的折叠与展开（§13.13.2，不跨重新打开）。 */
export function setFinishedOpen(tabKey: string, open: boolean): void {
  updateTab(tabKey, (tab) => ({ ...tab, tasks: { ...tab.tasks, finishedOpen: open } }));
}

/** @brief board.readTask（只读，不记操作）。 */
export function readTask(sessionId: string, task: string): Promise<TeamCommandResults['board.readTask']> {
  return request<TeamCommandResults['board.readTask']>({ type: 'board.readTask', sessionId, task });
}

/** @brief board.readSession（只读，不记操作）。 */
export function readSession(sessionId: string, of: SessionOf): Promise<TeamCommandResults['board.readSession']> {
  return request<TeamCommandResults['board.readSession']>({ type: 'board.readSession', sessionId, of });
}

/** @brief 一个 task 的停止状态：stopping 为真时按钮不可用；error 为失败的原文（§13.13.7）。 */
export interface StopState {
  /** 停止的命令还没返回，或返回了而 mori.board 里它还可以停 */
  stopping: boolean;
  /** 失败的原文；没有时为 null */
  error: string | null;
}

/** @brief 每个（会话，task）的停止状态，键为 `<界面里的标识>|<task>`。 */
export const useStopState = create<Record<string, StopState>>(() => ({}));

/** @brief 停止状态的键。 */
export const stopKey = (tabKey: string, task: string): string => `${tabKey}|${task}`;

/**
 * @brief Stop this task（§13.13.7）：不确认；发 session.stopTask，按钮不可用直到 mori.board 里它不再可以停（由卡片按
 *        TaskView 清掉）；失败时卡片下面一行 Couldn’t stop T1: <原文>。
 */
export async function stopTask(tabKey: string, task: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  if (!tab?.sessionId) return;
  const key = stopKey(tabKey, task);
  useStopState.setState({ [key]: { stopping: true, error: null } });
  let error: string | null;
  try {
    error = (await request<TeamCommandResults['session.stopTask']>({ type: 'session.stopTask',
      sessionId: tab.sessionId, task })).error;
  } catch (thrown) {
    error = describe('session.stopTask', thrown);
  }
  useStopState.setState({ [key]: { stopping: error === null, error } });
}

/** @brief 这个 task 不再可以停（停下了或交给了下一方）：清掉停止中的状态，失败的原文留着。 */
export function settleStop(tabKey: string, task: string): void {
  const key = stopKey(tabKey, task);
  const state = useStopState.getState()[key];
  if (state?.stopping) useStopState.setState({ [key]: { stopping: false, error: state.error } });
}
