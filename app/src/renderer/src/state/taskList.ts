// 右栏 Background tasks 的列表与文字（docs/specs/parallel-agents-taskboard.md §13.13、§15；docs/v1/screens/team-tasks.md）：
// 页签出现的条件、Running / Finished 两节、阶段行按钮的计数、task 卡的第二行、View transcript 的按钮、交接的头一行
// （结果与去向）、依赖与消息的一行、会话视图的标题与模型一行，以及把实例会话的条目画成只读的对话流。都是纯函数。

import {
  durationText, PROGRAM_HANDOFF_LINES, roleLabel, taskPhaseText, type BoardView, type HandoffDetail,
  type HandoffOutcome, type HandoffRoute, type RequestView, type SessionOf, type TaskDetail, type TaskStatus,
  type TaskView, type TeamHolders, type TeamMode,
} from '../../../shared/team';
import type { SessionEntry } from '../../../shared/protocol';
import { transcriptFromEntries } from './history';
import type { Transcript } from './model';

/** @brief 列表里的一个 task 与它所属的需求。 */
export interface ListedTask {
  /** task 的视图 */
  task: TaskView;
  /** 所属需求的视图 */
  request: RequestView;
}

/** @brief 拼文字要用的：整块 TaskBoard 视图、权限的持有者、会话的工作目录（同进展摘要）。 */
export interface TaskContext {
  /** TaskBoard 视图 */
  view: BoardView;
  /** 权限的持有者 */
  holders: TeamHolders;
  /** 会话的工作目录（当前在做什么里的路径） */
  cwd: string;
}

/** 没结束的 task：在 Running 一节（§13.13.2）；其余（含 stopped）在 Finished */
const RUNNING: readonly TaskStatus[] = ['pending', 'active', 'waiting_user'];

/** 交接结果的英文（§15） */
const OUTCOME_TEXT: Readonly<Record<HandoffOutcome, string>> = Object.freeze({
  continue: 'Continue', dead_end: 'Dead end', blocked: 'Blocked', need_user: 'Needs your decision', done: 'Done',
  pass: 'Pass', fail: 'Fail', close_done: 'Closed as done', close_failed: 'Closed as failed',
});

/** @brief 右栏有没有 Changes / Background tasks 两个页签（§13.13.1）：TaskBoard 上有需求，或协作模式不是 off。 */
export function tasksShown(board: BoardView, mode: TeamMode): boolean {
  return board.requests.length > 0 || mode !== 'off';
}

/** @brief TaskBoard 上的全部 task，按需求、按编号。 */
export function listedTasks(board: BoardView): ListedTask[] {
  return board.requests.flatMap((request) => request.tasks.map((task) => ({ task, request })));
}

/** @brief task 编号里的数字（T12 → 12）。 */
const taskNo = (item: ListedTask): number => Number(item.task.id.slice(1));

/** @brief task 有没有结束：没结束的在 Running。 */
export function isRunning(task: Pick<TaskView, 'status'>): boolean {
  return RUNNING.includes(task.status);
}

/**
 * @brief 两节（§13.13.2）：Running 按编号从小到大，Finished 按编号从大到小。
 * @param board TaskBoard 视图
 */
export function taskSections(board: BoardView): { running: ListedTask[]; finished: ListedTask[] } {
  const all = listedTasks(board);
  return {
    running: all.filter((item) => isRunning(item.task)).sort((a, b) => taskNo(a) - taskNo(b)),
    finished: all.filter((item) => !isRunning(item.task)).sort((a, b) => taskNo(b) - taskNo(a)),
  };
}

/**
 * @brief 阶段行右端按钮的文字（§13.13.1）：有没结束的 task 时 n running tasks，否则 n tasks finished（全部 task 数）；
 *        TaskBoard 上没有 task 时为 null（不显示按钮）。
 */
export function tasksButtonText(board: BoardView): string | null {
  const all = listedTasks(board);
  if (all.length === 0) return null;
  const running = all.filter((item) => isRunning(item.task)).length;
  if (running > 0) return running === 1 ? '1 running task' : `${running} running tasks`;
  return all.length === 1 ? '1 task finished' : `${all.length} tasks finished`;
}

/** @brief task 当前在做什么：进展摘要那一行的文字，模型提示接在后面（§13.3）。 */
export function doingText(task: TaskView, context: TaskContext): string {
  const doing = taskPhaseText(task, context.view, context.holders, context.cwd);
  return task.modelNote ? `${doing} · ${task.modelNote}` : doing;
}

/**
 * @brief task 卡第二行的各段（§13.13.2）：`Request 1` · 角色（持有者，为空时指派）· 当前在做什么 · 时长。
 * @param now 此刻（ms）：没结束的 task 的时长到此刻
 */
export function cardParts(item: ListedTask, context: TaskContext,
  now: number): { request: string; role: string; doing: string; duration: string } {
  const { task } = item;
  return {
    request: `Request ${item.request.no}`, role: roleLabel(task.holder ?? task.assignee),
    doing: doingText(task, context), duration: durationText((task.closedAt ?? now) - task.createdAt),
  };
}

/** @brief 一个 View transcript 按钮：读哪一条、文字、读屏名。 */
export interface TranscriptButton {
  /** 读哪一条会话 */
  of: SessionOf;
  /** 按钮文字 */
  label: string;
  /** 读屏名 */
  aria: string;
}

/** @brief task 上每个有会话的角色一个 View transcript（§13.13.2）：只有一个角色时不带角色名。 */
export function transcriptButtons(task: TaskView): TranscriptButton[] {
  const one = task.sessionRoles.length === 1;
  return task.sessionRoles.map((role) => ({
    of: { kind: 'task', task: task.id, role }, label: one ? 'View transcript' : `View transcript (${roleLabel(role)})`,
    aria: `View transcript for ${roleLabel(role)} on ${task.id}`,
  }));
}

/** @brief 需求的结案会话的 View transcript (closing)（§13.13.3）。 */
export function closeButton(request: number, holders: TeamHolders): TranscriptButton {
  return { of: { kind: 'close', request }, label: 'View transcript (closing)',
    aria: `View transcript for ${roleLabel(holders.close)} on Request ${request}` };
}

/** @brief 交接的去向（§15）：→ <role>、→ <close role> (closing)、→ <create role> (planning)、→ Done、→ Failed。 */
export function routeText(route: HandoffRoute, holders: TeamHolders): string {
  switch (route.kind) {
    case 'role': return `→ ${roleLabel(route.role)}`;
    case 'close': return `→ ${roleLabel(holders.close)} (closing)`;
    case 'create': return `→ ${roleLabel(holders.create)} (planning)`;
    case 'end': return route.status === 'done' ? '→ Done' : '→ Failed';
  }
}

/** @brief 一棒的头一行（§13.13.3）：`#2 Mori · no handoff → planner (closing)`。 */
export function handoffHead(handoff: HandoffDetail, holders: TeamHolders): string {
  const result = handoff.outcome !== null ? OUTCOME_TEXT[handoff.outcome]
    : PROGRAM_HANDOFF_LINES[handoff.reason ?? 'no_handoff'];
  return `#${handoff.n} ${roleLabel(handoff.role)} · ${result} ${routeText(handoff.routedTo, holders)}`;
}

/** @brief 一条证据（§13.13.3）：`✓ #3 Run npm test` / `✗ #4 …`。 */
export function evidenceLine(item: HandoffDetail['evidence'][number]): string {
  return `${item.ok ? '✓' : '✗'} ${item.tag} ${item.title}`;
}

/** @brief 依赖的一行（§13.13.3）：`T2 <title> · <状态>`，状态同卡片的当前在做什么。 */
export function dependencyLine(dep: TaskDetail['dependsOn'][number], context: TaskContext): string {
  const found = listedTasks(context.view).find((item) => item.task.id === dep.id)?.task;
  const state = found ? doingText(found, context) : dep.status;
  return `${dep.id} ${dep.title} · ${state}`;
}

/** @brief 两位数。 */
const two = (value: number): string => String(value).padStart(2, '0');

/** @brief 一条留给 task 的消息的头一行（§13.13.3）：`<from> · hh:mm`（本地时间）。 */
export function messageHead(message: TaskDetail['messages'][number]): string {
  const at = new Date(message.at);
  return `${roleLabel(message.from)} · ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * @brief 会话视图的标题（§13.13.4）：`<role> · T1 <title>`，结案会话 `<close role> · Request 1 (closing)`。
 * @param title task 的标题（task 实例会话时）
 */
export function transcriptTitle(of: SessionOf, holders: TeamHolders, title: string): string {
  return of.kind === 'task' ? `${roleLabel(of.role)} · ${of.task} ${title}`
    : `${roleLabel(holders.close)} · Request ${of.request} (closing)`;
}

/** @brief 会话的模型一行（§13.13.4）：最后一条助手消息实际用的模型，`Model <provider>/<model>`；没有时为 null。 */
export function modelLine(entries: readonly SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== 'message') continue;
    const message = entry.message as { role?: string; provider?: string; model?: string };
    if (message.role === 'assistant' && message.provider && message.model) {
      return `Model ${message.provider}/${message.model}`;
    }
  }
  return null;
}

/** @brief 会话里还没有消息（实例刚开始，§13.13.4 的 No activity yet）。 */
export function noActivity(entries: readonly SessionEntry[]): boolean {
  return !entries.some((entry) => entry.type === 'message');
}

/**
 * @brief 把实例会话的条目画成只读的对话流（§13.13.4，复用对话流的条目）：程序的投递是用户一侧的气泡；实例在运行时
 *        还没有结果的工具调用为 Running…（不是 Interrupted）。
 * @param running 实例正在运行
 */
export function sessionTranscript(entries: SessionEntry[], running: boolean): Transcript {
  const state = transcriptFromEntries(entries);
  if (!running) return state;
  const tools = Object.fromEntries(Object.entries(state.tools).map(([id, tool]) => [id,
    tool.status === 'interrupted' ? { ...tool, status: 'running' as const } : tool]));
  return { ...state, tools };
}
