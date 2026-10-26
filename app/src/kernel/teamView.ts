// TaskBoard 的视图（docs/specs/parallel-agents-taskboard.md §13.3、§13.10）：board.json 加上调度与实例的运行状态，
// 投影成界面看的 BoardView（需求状态、task 的 phase、等待的 task、当前工具调用、模型提示、交接链），
// 以及 mori.board 的合并发送（最多每 250 毫秒一次，§15）。投影是纯函数。

import type {
  BoardView, HandoffDetail, RequestView, SessionOf, TaskDetail, TaskPhase, TaskView, TeamHolders, ToolCallBrief,
} from '../shared/team';
import { findRequest, findTask, requestState, ruledOut, tasksOf } from './board';
import { handoffLink } from './boardText';
import type { Board, BoardTask, Handoff, ScheduleWait } from './teamTypes';

/** @brief mori.board 合并发送的间隔（§13.3、§15），毫秒。 */
export const BOARD_EVENT_INTERVAL_MS = 250;

/** @brief 一个 task 的实例此刻的运行状态（持有它的角色的 task 实例）。 */
export interface TaskLive {
  /** 实例在运行：还没调用工具（starting）、在调用工具（running）、在等你批准（approval）；没在运行时为 null */
  phase: 'starting' | 'running' | 'approval' | null;
  /** 最近一次工具调用 */
  current: ToolCallBrief | null;
  /** 最近一条换模型或等待的提示（§12.12） */
  modelNote: string | null;
}

/** @brief 投影要用的运行状态。 */
export interface ViewInput {
  /** 三项权限的持有者（结案时的 holder 写结案持有者） */
  holders: TeamHolders;
  /** 调度的结果里交给了角色却没开始的 task（排队、等写入锁） */
  waiting: readonly ScheduleWait[];
  /** task 编号 → 它的实例的运行状态 */
  live: ReadonlyMap<string, TaskLive>;
  /** 有实例做过成功的 edit、write（§13.12） */
  teamEdited: boolean;
  /** 这条实例会话有没有：开着，或会话文件已写盘（TaskView.sessionRoles、RequestView.closeSession，§13.13） */
  hasSession: (of: SessionOf) => boolean;
}

/** @brief 还没完成的依赖。 */
function unfinishedDeps(board: Board, task: BoardTask): string[] {
  return task.dependsOn.filter((id) => findTask(board, id)?.status !== 'done');
}

/** @brief 交给了角色的 task 的 phase：在运行、排队、等写入锁，或刚交出去还在准备（starting）。 */
function activePhase(task: BoardTask, input: ViewInput): Pick<TaskView, 'phase' | 'waitingFor' | 'current'> {
  const live = input.live.get(task.id);
  if (live?.phase) {
    return { phase: live.phase, waitingFor: [], current: live.phase === 'running' ? live.current : null };
  }
  const wait = input.waiting.find((item) => item.task === task.id);
  if (wait?.phase === 'lock_wait') return { phase: 'lock_wait', waitingFor: [wait.lockHolder ?? ''], current: null };
  if (wait?.phase === 'queued') return { phase: 'queued', waitingFor: [], current: null };
  return { phase: 'starting', waitingFor: [], current: null };
}

/** @brief task 的 phase、等待的 task 与当前工具调用（§13.3 的 phase 文字）。 */
function phaseOf(board: Board, task: BoardTask, input: ViewInput): Pick<TaskView, 'phase' | 'waitingFor' | 'current'> {
  const simple = (phase: TaskPhase): Pick<TaskView, 'phase' | 'waitingFor' | 'current'> => ({
    phase, waitingFor: [], current: null,
  });
  switch (task.status) {
    case 'pending': return { phase: 'pending', waitingFor: unfinishedDeps(board, task), current: null };
    case 'active': return task.holder?.kind === 'close' ? simple('with_close') : activePhase(task, input);
    case 'waiting_user': return simple(task.asked ? 'asked' : 'waiting_user');
    case 'stopped': return simple(task.stopReason === 'restart' ? 'stopped_restart' : 'stopped');
    default: return simple(task.status);
  }
}

/** @brief task 的持有者：角色名，交到结案时为结案持有者；pending 与终态为 null。 */
function holderOf(task: BoardTask, holders: TeamHolders): string | null {
  if (task.holder === null || task.status === 'pending') return null;
  return task.holder.kind === 'role' ? task.holder.role : holders.close;
}

/** 结案会话写的一棒的 from 前缀（§6.1 Handoff.from） */
const CLOSE_PREFIX = 'close:';

/**
 * @brief 在这个 task 上有实例会话的角色（TaskView.sessionRoles）：按第一次接手的先后（每一棒的交出方与去向，再是
 *        持有者与指派），只留有会话的。
 */
function sessionRoles(task: BoardTask, input: ViewInput): string[] {
  const holder = task.holder?.kind === 'role' ? [task.holder.role] : [];
  const order = [...task.handoffs.flatMap((handoff) => [handoff.from,
    ...(handoff.routedTo.kind === 'role' ? [handoff.routedTo.role] : [])]), ...holder, task.assignee];
  return [...new Set(order)].filter((role) => !role.startsWith(CLOSE_PREFIX)
    && input.hasSession({ kind: 'task', task: task.id, role }));
}

/**
 * @brief 一个 task 的视图（§13.10）。
 * @param board TaskBoard
 * @param task task
 * @param input 运行状态
 */
export function taskView(board: Board, task: BoardTask, input: ViewInput): TaskView {
  return {
    id: task.id, title: task.title, status: task.status, assignee: task.assignee,
    holder: holderOf(task, input.holders), ...phaseOf(board, task, input),
    modelNote: input.live.get(task.id)?.modelNote ?? null,
    chain: task.handoffs.map(handoffLink), createdAt: task.createdAt, closedAt: task.closedAt,
    dependsOn: [...task.dependsOn], sessionRoles: sessionRoles(task, input),
  };
}

/**
 * @brief 整块 TaskBoard 的视图（§13.10）：每个需求的状态（§13.3 的顺序）、已排除的方案与它的全部 task。
 * @param board TaskBoard
 * @param input 运行状态
 */
export function boardView(board: Board, input: ViewInput): BoardView {
  const requests = board.requests.map((request): RequestView => ({
    no: request.no, title: request.title, status: request.status, state: requestState(board, request),
    createdAt: request.createdAt, closedAt: request.closedAt, conclusion: request.conclusion,
    ruledOut: ruledOut(board, request.no), question: request.question,
    tasks: tasksOf(board, request.no).map((task) => taskView(board, task, input)),
    closeSession: input.hasSession({ kind: 'close', request: request.no }),
  }));
  return { requests, teamEdited: input.teamEdited };
}

/** @brief 一个实例会话文件是这个 task 上哪个角色的；不是这个 task 的实例会话时为 null。 */
export type InstanceRoleOf = (task: string, file: string) => string | null;

/**
 * @brief task 视图里的一棒（§13.13.3）：交接的全部字段；结案写的一棒交出方为结案持有者，读结案会话。程序写的一棒交出方
 *        为 mori，有会话位置时（实例运行过）会话是那个实例的：按会话文件找它的角色。
 */
function handoffDetail(task: string, handoff: Handoff, roleOf: InstanceRoleOf): HandoffDetail {
  const byClose = handoff.from.startsWith(CLOSE_PREFIX);
  const role = byClose ? handoff.from.slice(CLOSE_PREFIX.length) : handoff.from;
  const sessionRole = handoff.session && handoff.reason !== null ? roleOf(task, handoff.session.file) ?? role : role;
  return {
    n: handoff.n, role, byClose, outcome: handoff.outcome, reason: handoff.reason, conclusion: handoff.conclusion,
    next: handoff.next, suggestedNext: handoff.suggestedNext, openItems: [...handoff.openItems],
    evidence: handoff.evidence.map((item) => ({ tag: item.tag, title: item.title, ok: item.ok })),
    routedTo: handoff.routedTo, at: handoff.at,
    session: handoff.session ? { role: sessionRole, turns: [...handoff.session.turns] } : null,
  };
}

/**
 * @brief 一个 task 的详情（board.readTask，§13.13.3）：说明全文、依赖与它们此刻的状态、留给它的消息、每一棒的全部字段。
 * @param board TaskBoard
 * @param id task 编号
 * @param roleOf 程序写的一棒的会话文件是哪个角色的
 * @return 没有这个 task 时为 null
 */
export function taskDetail(board: Board, id: string, roleOf: InstanceRoleOf): TaskDetail | null {
  const task = findTask(board, id);
  if (!task) return null;
  return {
    id: task.id, request: task.request, requestTitle: findRequest(board, task.request)?.title ?? '',
    title: task.title, description: task.description, readOnly: task.readOnly, assignee: task.assignee,
    dependsOn: task.dependsOn.map((dep) => {
      const found = findTask(board, dep);
      return { id: dep, title: found?.title ?? '', status: found?.status ?? 'pending' };
    }),
    status: task.status, messages: task.messages.map((item) => ({ ...item })),
    handoffs: task.handoffs.map((handoff) => handoffDetail(task.id, handoff, roleOf)),
  };
}

/**
 * @brief 一次写入里交给了另一方的 task（§12.12：它们的实例的 modelNote 清掉）：交接链变长（交接、兜底）、持有者变了，
 *        或从 waiting_user、stopped 交回。
 * @param before 写入前
 * @param after 写入后
 * @return task 编号
 */
export function handedOver(before: Board, after: Board): string[] {
  return after.tasks.filter((task) => {
    const old = findTask(before, task.id);
    if (!old || old === task) return false;
    const back = (old.status === 'waiting_user' || old.status === 'stopped')
      && (task.status === 'active' || task.status === 'pending');
    return back || old.handoffs.length !== task.handoffs.length
      || JSON.stringify(old.holder) !== JSON.stringify(task.holder);
  }).map((task) => task.id);
}

/** @brief TaskBoard 上有交接记下了改过代码的模型族（重新打开后 teamEdited 的来源，§13.12）。 */
export function boardEdited(board: Board): boolean {
  return board.tasks.some((task) => task.handoffs.some((handoff) => handoff.authorFamilies.length > 0));
}

/** @brief 合并发送：第一次立即发，之后每个间隔内最多一次，间隔内又有变化时在间隔结束时补发一次。 */
export class Throttle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /**
   * @param intervalMs 间隔（毫秒）
   * @param fire 发送
   */
  constructor(private readonly intervalMs: number, private readonly fire: () => void) {}

  /** @brief 有变化：可以发时立即发，否则在间隔结束时发。 */
  request(): void {
    if (this.timer !== null) {
      this.dirty = true;
      return;
    }
    this.fire();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.request();
    }, this.intervalMs);
  }

  /** @brief 不再发（会话关闭）。 */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }
}
