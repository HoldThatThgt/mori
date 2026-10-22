// 一次运行的开始与结束（docs/specs/parallel-agents-taskboard.md §5.4、§7.4、§7.5、§7.6、§9.4、§10.1、§12.4、§12.5）：
// 运行开始时记下程序要看的东西（结案手上的 task、立项这次判断）；运行结束时按 §9.4 的表依次判断：
// 0 停止原因 → 1 交接 → 2 终态 → 3 换模型重来 → 4 出错、候选耗尽 → 5 没交接（强制填写），以及结案、立项、临时提问、
// 订阅各自的结束。不靠 agent_settled.aborted 和最后一条助手消息的 stopReason 猜（§9.4）。

import { plainReasonText } from '../shared/models';
import { TEAM_ENTRY_TYPES, roleLabel } from '../shared/team';
import {
  clearCloseRetry, closeNoModelQuestion, closeRunOutcome, closeUndecidedQuestion, findRequest, findTask, isTaskEnded,
  markAsked, markCloseRetry, markStopped, notClosedQuestion, recordProgramHandoff, requestsWithoutTasks,
  setRequestQuestion, startJudgment, tasksOf, unfinishedTasks, clearRequestQuestion,
} from './board';
import { deliveryText, type FillTarget } from './boardText';
import { nextRoles } from './boardTools';
import { authorFamilies } from './evidence';
import {
  closeForm, parseForm, requestCloseForm, taskForm, type HandoffForm, type WriteMode,
} from './handoffForm';
import { exhaustionText } from './modelSession';
import type { TaskRestart, UnavailableInfo } from './modelTypes';
import { entriesOfTurns, turnCount } from './sessionReader';
import type { Team } from './team';
import type { StopReason } from './teamHost';
import { newRun, type ForcedFill, type Lane, type LaneRun, type TeamDelivery } from './teamLanes';
import { executeCloseHandoff, executeRequestClose, executeTaskHandoff, nextRoleNames } from './teamTools';
import type { SessionSpan } from './teamTypes';

/** @brief 等回复的发送方在停止时收到的文字（§10.1、§11.4）。 */
export const STOPPED_BY_USER = 'Stopped by the user.';

/** @brief 投递没能开始运行、也不是停止或选不到模型时（prompt() 抛错等）当作的错误。 */
export const NOT_STARTED = 'The run could not start.';

/** @brief 实例没交接、强制填写也没填出来、最后也没有文字时程序写的一棒的结论（§7.4 第 1 行）。 */
export const NO_TEXT = 'The run ended without a handoff or any text.';

// ---- 运行开始 ----

/**
 * @brief 一次运行开始（agent_start）：记下开始它的投递与这次运行的模式；清掉模型提示（§12.12）；结案会话记下手上的 task、
 *        清掉需求级问题（§7.6）；立项会话与合并会话被程序唤醒时开始一次程序唤醒的判断，用户消息的投递开始一次判断（§5.4）。
 * @param team 协作
 * @param lane 会话
 */
export function runStarted(team: Team, lane: Lane): void {
  const user = lane === team.user;
  const start = user ? team.nextUserRun : { mode: team.mode, allowed: null };
  const run = newRun(start.mode, lane.busy ? lane.inflight : []);
  run.allowed = start.allowed;
  lane.run = run;
  lane.started = true;
  lane.current = null;
  lane.modelNote = null;
  if (user) {
    lane.sentThisTurn = 0;
    team.nextUserRun = { mode: team.mode, allowed: null };
    const command = team.flow.takeCommand();
    run.command = lane.busy ? null : command;
    team.flow.userRunStarted();
  }
  if (lane.kind === 'close') closeRunStart(team, lane, run);
  const userText = run.batch.find((item) => item.user)?.meta.userText;
  if (lane.kind === 'create' && userText !== undefined) startUserJudgment(team, lane, userText);
  else if (isProgramCreateTurn(team, lane, run)) run.judgment = startJudgment(false, team.merged);
  team.emitBoard();
  team.emitState();
}

/** @brief 结案会话的运行开始：这次运行开始前就交给它的 task；需求级问题在结案下一次运行开始时清掉（§7.6）。 */
function closeRunStart(team: Team, lane: Lane, run: LaneRun): void {
  const request = lane.request ?? 0;
  run.heldAtStart = closeHeld(team, request);
  if (findRequest(team.board, request)?.question) {
    team.write((board) => ({ board: clearRequestQuestion(board, request), error: null }));
  }
}

/** @brief 这个需求里此刻交给结案的 task（active，持有者是结案）。 */
function closeHeld(team: Team, request: number): string[] {
  return tasksOf(team.board, request).filter((task) => task.status === 'active' && task.holder?.kind === 'close')
    .map((task) => task.id);
}

/** @brief 程序唤醒的立项回合：分开时立项会话里只有程序投递的运行；合并会话里 create_wake 投递开始的运行（§5.4、§5.6）。 */
function isProgramCreateTurn(team: Team, lane: Lane, run: LaneRun): boolean {
  if (run.batch.length === 0 || run.mode === 'off') return false;
  if (lane.kind === 'create') return !run.batch.some((item) => item.user);
  return lane === team.user && run.batch.some((item) => item.meta.wake === 'create_wake');
}

/**
 * @brief 开始一次判断用户消息（§5.3、§5.4）：合并会话里每条你的消息（mori-team 的 message_start）；
 *        分开时立项会话里用户消息的投递。上一次判断先结束。
 * @param team 协作
 * @param lane 立项会话（合并会话时为用户会话）
 * @param text 你输入的原文
 */
export function startUserJudgment(team: Team, lane: Lane, text: string): void {
  const run = lane.run;
  if (!run) return;
  if (run.judgment) endJudgment(team, lane, run);
  run.judgment = startJudgment(true, lane === team.user);
  run.judgedText = text;
}

/**
 * @brief 一次判断结束（§5.4 最后一条、§5.3 第 6 步）：这次登记的需求还没有 task 时在立项会话里投递一次提醒
 *        （运行被停止时不投递，§9.4 第 0 行）；合并会话里判断用户消息登记了需求的，写 mori.progress
 *        （进展摘要挂在这一段的回复下面；被停止时同样在这一段结束时写，§13.2、§13.3）。
 * @param team 协作
 * @param lane 立项会话（合并会话时为用户会话）
 * @param run 这次运行
 * @param stopped 这次运行被停止
 */
export function endJudgment(team: Team, lane: Lane, run: LaneRun, stopped = false): void {
  const judgment = run.judgment;
  run.judgment = null;
  if (!judgment) return;
  run.ended = judgment;
  const remind = stopped ? [] : requestsWithoutTasks(team.board, judgment.registered);
  for (const request of remind) {
    team.enqueueCreate(team.delivery('create_no_tasks', { request }, { kind: 'no_tasks', request }));
  }
  if (lane !== team.user || !judgment.user) return;
  const manager = team.userSession?.session.sessionManager;
  for (const request of judgment.registered) {
    const at = Date.now();
    manager?.appendCustomEntry(TEAM_ENTRY_TYPES.progress, { request });
    team.host.emitUser(team.userId, { type: 'mori.progress', request, at });
  }
}

// ---- 运行结束（§9.4） ----

/**
 * @brief 投递没能开始运行时当作的一次运行：段开始时选不到模型、被停止，或没能开始（当作出错）。
 *        结案会话照样记下这次投递之前就交给它的 task，没处理的按 §7.4 最后一行强制填写、交给立项。
 */
function notStartedRun(team: Team, lane: Lane, stop: StopReason | null): LaneRun {
  const run = newRun(team.mode, lane.inflight);
  run.unavailable = lane.startUnavailable;
  if (run.unavailable === null && stop === null) run.error = NOT_STARTED;
  if (lane.kind === 'close') run.heldAtStart = closeHeld(team, lane.request ?? 0);
  return run;
}

/**
 * @brief 一次运行结束（agent_settled，或投递没能开始运行）：等回复的发送方拿到结果，然后按 §9.4 的表处理。
 * @param team 协作
 * @param lane 会话
 */
export async function runEnded(team: Team, lane: Lane): Promise<void> {
  const stop = lane.stop ?? team.host.status(lane.id)?.stop ?? null;
  const run = lane.run ?? notStartedRun(team, lane, stop);
  lane.run = null;
  lane.current = null;
  lane.stop = null;
  const restart = lane.kind === 'task' ? team.host.entry(lane.id)?.model.takeRestart() ?? null : null;
  // 被停止时分开的立项会话的判断由 teamFlow 的 judgmentStopped 处理；合并会话只写进展摘要（§13.3）
  if (run.judgment && (!stop || lane === team.user)) endJudgment(team, lane, run, stop !== null);
  settleWaiters(run, stop);
  if (stop) stoppedRun(team, lane, run, stop);
  else await finishedRun(team, lane, run, restart);
  if (lane === team.user) await userRunEnded(team);
  team.emitBoard();
  team.emitState();
}

/** @brief 等这次运行回复的发送方（agent_message wait）：停止、出错、选不到模型时为失败，否则为最后一段文字。 */
function settleWaiters(run: LaneRun, stop: StopReason | null): void {
  for (const item of run.batch) {
    const waiter = item.meta.waiter;
    if (!waiter) continue;
    item.meta.waiter = undefined;
    if (stop) waiter.settle(STOPPED_BY_USER, true);
    else if (run.unavailable) waiter.settle(exhaustionText(run.unavailable.candidates, false), true);
    else if (run.error) waiter.settle(run.error, true);
    else waiter.settle(run.lastText || 'It ended without a reply.', false);
  }
}

/**
 * @brief §9.4 第 0 行：这个会话记着停止原因，这次运行结束后的程序动作一律不做；已经成功的交接照记，
 *        task 按原因处理（user → stopped；cancel 已是 cancelled）；临时提问的发送方以 Stopped by the user. 结束。
 */
function stoppedRun(team: Team, lane: Lane, run: LaneRun, stop: StopReason): void {
  console.log(`[kernel] ${lane.id}: the run was stopped (${stop})`);
  const stopTasks = (ids: readonly string[]): void => {
    const live = ids.filter((id) => {
      const task = findTask(team.board, id);
      return task !== undefined && !isTaskEnded(task);
    });
    if (live.length) team.write((board) => ({ board: markStopped(board, live, 'user'), error: null }));
  };
  if (lane.kind === 'task' && stop === 'user' && lane.task) stopTasks([lane.task]);
  if (lane.kind === 'close' && stop === 'user') {
    stopTasks(run.heldAtStart.filter((id) => findTask(team.board, id)?.holder?.kind === 'close'));
  }
  if (lane.kind === 'ask') {
    lane.asker?.settle(STOPPED_BY_USER, true);
    lane.asker = null;
  }
  if (lane.kind === 'create' && run.batch.some((item) => item.user)) team.flow.judgmentStopped(run);
}

/** @brief 没被停止的运行按会话的种类结束。 */
async function finishedRun(team: Team, lane: Lane, run: LaneRun, restart: TaskRestart | null): Promise<void> {
  switch (lane.kind) {
    case 'task': return taskRunEnded(team, lane, run, restart);
    case 'close': return closeRunEnded(team, lane, run);
    case 'create': return createRunEnded(team, run);
    case 'ask': return askRunEnded(team, lane, run);
    case 'user':
      if (isProgramCreateTurn(team, lane, run)) programTurnFallback(team, run, true);
      return;
    case 'subscription': return;
  }
}

/**
 * @brief 用户会话的运行结束：对话回复那条消息的那一段结束（§5.3 第 6 步）；写挂起的条目；模式在运行中改过时现在改
 *        模型层的锁定（§5.1、§12.11）。
 */
async function userRunEnded(team: Team): Promise<void> {
  team.flow.segmentEnd();
  team.flushEntries();
  if (team.pendingLock) await team.applyLock();
}

// ---- task 实例（§7.4、§9.4、§12.4） ----

/** @brief task 仍由这个实例持有。 */
function stillHolds(team: Team, lane: Lane): boolean {
  const task = lane.task === null ? undefined : findTask(team.board, lane.task);
  return task?.status === 'active' && task.holder?.kind === 'role' && task.holder.role === lane.role;
}

/** @brief task 实例的运行结束：§9.4 第 1–5 行。 */
async function taskRunEnded(team: Team, lane: Lane, run: LaneRun, restart: TaskRestart | null): Promise<void> {
  if (run.handedOff) return;
  const task = lane.task === null ? undefined : findTask(team.board, lane.task);
  if (!task || isTaskEnded(task) || !stillHolds(team, lane)) return;
  if (restart) {
    team.enqueueSolo(lane, team.delivery('model_restart', { from: restart.from, to: restart.to,
      reason: restartReason(restart), task: task.id, role: lane.role },
    { kind: 'task_restart', task: task.id, role: lane.role },
    { choice: { prefer: restart.to, exclude: [restart.from] } }));
    return;
  }
  if (run.unavailable) return programHandoff(team, lane, 'no_model', exhaustionText(run.unavailable.candidates, false));
  if (run.error) return programHandoff(team, lane, 'error', run.error);
  if (run.forced) return forcedEnded(team, lane, run);
  startForced(team, lane, { kind: 'task', task: task.id }, run.lastText);
}

/** @brief 换模型重来的原因文字（不带 until 部分，§12.4 的投递）。 */
function restartReason(restart: TaskRestart): string {
  return plainReasonText(restart.reason, restart.detail);
}

/** @brief 这一棒在实例会话里的位置与改过代码的模型族（§7.2、§12.9）；task 没运行过时位置为 null。 */
export function batonOf(team: Team, lane: Lane): { session: SessionSpan | null; families: string[] } {
  const entries = team.branchOf(lane);
  const current = turnCount(entries);
  if (current === 0 || lane.file === null) return { session: null, families: [] };
  const from = Math.min(lane.batonStart ?? current, current);
  const families = authorFamilies(entriesOfTurns(entries, from, current), (ref) => team.familyOf(ref));
  return { session: { file: lane.file, turns: [from, current] }, families };
}

/**
 * @brief 程序写一棒交给结案（§7.4 第 1–3 行）：结论是最后一段文字、错误原文或候选被排除的原因。
 * @param reason no_handoff、error、no_model
 * @param conclusion 结论（超过 600 字符由 board.ts 截断）
 */
function programHandoff(team: Team, lane: Lane, reason: 'no_handoff' | 'error' | 'no_model', conclusion: string): void {
  const task = lane.task ?? '';
  const baton = batonOf(team, lane);
  const result = team.write((board) => recordProgramHandoff(board, { task, reason, conclusion: conclusion || NO_TEXT,
    holder: { kind: 'role', role: lane.role }, session: baton.session, authorFamilies: baton.families }, Date.now()));
  if (result.error) console.error(`[kernel] ${lane.id}: the program handoff of ${task} was refused: ${result.error}`);
  else console.log(`[kernel] ${lane.id}: ${task} handed to close (${reason})`);
  lane.batonStart = null;
}

// ---- 强制填写（§7.5） ----

/** @brief 这次强制填写的表单。 */
function formFor(team: Team, lane: Lane, target: FillTarget): HandoffForm {
  if (target.kind === 'request') return requestCloseForm(target.request);
  const next = nextRoles(team.roles, lane.role);
  return target.kind === 'close' ? closeForm(target.task, next) : taskForm(target.task, next);
}

/** @brief 强制填写的投递（§7.5 第 1 步；格式重试为第 3 步），单独占一次运行。 */
function forcedDelivery(team: Team, lane: Lane, forced: ForcedFill, mode: WriteMode,
  error: string | null): TeamDelivery {
  const form = { tier: mode, next: nextRoleNames(forced.form) };
  const text = error === null ? deliveryText('forced_fill', { target: forced.target, form })
    : deliveryText('format_retry', { target: forced.target, error, form });
  const target = forced.target;
  const cause = target.kind === 'request' ? { kind: 'close_all_ended' as const, request: target.request }
    : target.kind === 'task' ? { kind: 'forced_task' as const, task: target.task, role: lane.role }
      : { kind: 'close_task' as const, task: target.task };
  return { user: false, text, cause, at: Date.now(), meta: { forced } };
}

/**
 * @brief 开始强制填写（§7.4 no_handoff、close_undecided，§7.6 强制关闭）：按实例此刻的模型的写入等级写明怎么填；
 *        没有等级（protocol_write 未验证）时不强制填写，直接兜底。
 * @param target task 实例的交接、结案的交接或强制关闭
 * @param lastText 没交接的那次运行的最后一段文字（兜底的结论）
 */
function startForced(team: Team, lane: Lane, target: FillTarget, lastText: string): void {
  const mode = team.expectedMode(lane);
  if (mode === null) return fillFailed(team, lane, target, lastText);
  const forced: ForcedFill = { form: formFor(team, lane, target), target, attempt: 1, fallbackText: lastText };
  team.enqueueSolo(lane, forcedDelivery(team, lane, forced, mode, null));
}

/** @brief 强制填写已经有了结果：交接成功、结案已决定这个 task、需求已关闭（或它们已经不需要了）。 */
function forcedDone(team: Team, lane: Lane, run: LaneRun, target: FillTarget): boolean {
  if (target.kind === 'request') return findRequest(team.board, target.request)?.status !== 'open';
  if (target.kind === 'task') return run.handedOff !== null || !stillHolds(team, lane);
  const task = findTask(team.board, target.task);
  return run.decided.includes(target.task) || !(task?.status === 'active' && task.holder?.kind === 'close');
}

/** @brief B、C 的回复解析出的参数，按工具的校验执行（§7.5 第 2 步的表）；返回不能用的原因，成功时为 null。 */
async function applyForm(team: Team, lane: Lane, run: LaneRun, mode: 'B' | 'C'): Promise<string | null> {
  const forced = run.forced as ForcedFill;
  const parsed = parseForm(forced.form, mode, run.lastText);
  if ('error' in parsed) return parsed.error;
  const target = forced.target;
  const reply = target.kind === 'request' ? executeRequestClose(team, lane, parsed.args)
    : target.kind === 'task' ? await executeTaskHandoff(team, lane, parsed.args, true)
      : executeCloseHandoff(team, lane, parsed.args);
  return reply.ok ? null : reply.reason;
}

/**
 * @brief 强制填写的运行结束（§7.5 第 2、3 步）：A 级看模型有没有成功调用表单工具；B、C 级解析回复正文（模型调了工具也算）；
 *        不能用时再投递一次格式重试（最多 1 次），仍失败按 §7.4 兜底。实际的模型没有等级时直接兜底。
 */
async function forcedEnded(team: Team, lane: Lane, run: LaneRun): Promise<void> {
  const forced = run.forced as ForcedFill;
  if (forcedDone(team, lane, run, forced.target)) return;
  let error = run.formError ?? run.error;
  if (error === null) {
    if (run.formMode === null) {
      if (run.assistants > 0) return fillFailed(team, lane, forced.target, forced.fallbackText);
      error = 'there was no reply';
    } else if (run.formMode === 'A') {
      error = `the reply did not call ${forced.form.tool}`;
    } else {
      error = await applyForm(team, lane, run, run.formMode);
      if (error === null) return;
    }
  }
  const mode = forced.attempt === 1 ? team.expectedMode(lane) : null;
  if (mode === null) return fillFailed(team, lane, forced.target, forced.fallbackText);
  console.log(`[kernel] ${lane.id}: the forced handoff could not be used (${error}); retrying once`);
  team.enqueueSolo(lane, forcedDelivery(team, lane, { ...forced, attempt: 2 }, mode, error));
}

/**
 * @brief 强制填写填不出来（或不强制填写）时的兜底（§7.4、§7.6）：task 实例交给结案（no_handoff，结论为最后一段文字）；
 *        结案没决定的 task 交给立项（close_undecided）；没关闭的需求写下需求级问题、唤醒立项。
 */
function fillFailed(team: Team, lane: Lane, target: FillTarget, lastText: string): void {
  if (target.kind === 'request') {
    console.log(`[kernel] ${lane.id}: request ${target.request} was not closed; asking ${team.holders.create}`);
    team.write((board) => ({ board: setRequestQuestion(board, target.request,
      notClosedQuestion(target.request, team.holders.close)), error: null }));
    return;
  }
  if (target.kind === 'task') return programHandoff(team, lane, 'no_handoff', lastText);
  const result = team.write((board) => recordProgramHandoff(board, { task: target.task, reason: 'close_undecided',
    conclusion: closeUndecidedQuestion(team.holders.close, target.task), holder: { kind: 'close' }, session: null,
    authorFamilies: [] }, Date.now()));
  if (result.error) console.error(`[kernel] ${lane.id}: close_undecided for ${target.task} refused: ${result.error}`);
}

// ---- 结案会话（§7.4 最后一行、§7.6、§12.5） ----

/** @brief 结案会话的运行结束：没处理的 task 强制填写，全部结束却没关闭的需求强制关闭；选不到模型时交给立项。 */
async function closeRunEnded(team: Team, lane: Lane, run: LaneRun): Promise<void> {
  const request = lane.request ?? 0;
  if (run.unavailable) {
    closeNoModel(team, lane, run);
    return endCloseRetry(team, run, request);
  }
  if (run.forced) return forcedEnded(team, lane, run);
  const outcome = closeRunOutcome(team.board, { request, heldAtStart: run.heldAtStart, decided: run.decided,
    wokenForEnd: run.wokenForEnd, createPending: team.closeAskPending(request) });
  endCloseRetry(team, run, request);
  for (const task of outcome.undecided) startForced(team, lane, { kind: 'close', task }, run.lastText);
  if (outcome.forceClose) startForced(team, lane, { kind: 'request', request }, run.lastText);
}

/**
 * @brief §5.4 兜底表第 3 行的再唤醒只免一次“给立项发过消息”的检查（§7.6“那次不再看这一条”）：
 *        为“全部已结束”或“没有 task”被唤醒的回合（不是强制填写）结束之后清掉 closeRetry。
 */
function endCloseRetry(team: Team, run: LaneRun, request: number): void {
  if (run.forced || !run.wokenForEnd || !findRequest(team.board, request)?.closeRetry) return;
  team.write((board) => ({ board: clearCloseRetry(board, request), error: null }));
}

/**
 * @brief 结案选不到模型（§12.5）：交给它的 task 交给立项（need_user，问题为 <close role> can't run: no model available）；
 *        为“全部已结束”或“没有 task”被唤醒、需求仍开着且没有未结束的 task 时，这句话作为需求级问题交给立项（§7.6）。
 */
function closeNoModel(team: Team, lane: Lane, run: LaneRun): void {
  const request = lane.request ?? 0;
  const question = closeNoModelQuestion(team.holders.close);
  for (const task of closeHeld(team, request)) {
    const result = team.write((board) => recordProgramHandoff(board, { task, reason: 'no_model',
      conclusion: question, holder: { kind: 'close' }, session: null, authorFamilies: [] }, Date.now()));
    if (result.error) console.error(`[kernel] ${lane.id}: no_model for ${task} refused: ${result.error}`);
  }
  const open = findRequest(team.board, request)?.status === 'open';
  if (!run.wokenForEnd || !open || unfinishedTasks(team.board, request).length) return;
  console.log(`[kernel] ${lane.id}: request ${request} was not closed (no model); asking ${team.holders.create}`);
  team.write((board) => ({ board: setRequestQuestion(board, request, question), error: null }));
}

// ---- 立项会话（§5.4 程序唤醒回合的兜底、§12.5） ----

/**
 * @brief 分开时立项会话的运行结束。判断你的消息的回合（投递没能开始运行时也是）：记下决定，把消息交给对话
 *        （teamFlow.ts，§5.3 第 3、4 步）；程序唤醒的回合按 §5.4 兜底。
 */
function createRunEnded(team: Team, run: LaneRun): void {
  if (run.batch.some((item) => item.user)) return team.flow.judgmentEnded(run);
  programTurnFallback(team, run, false);
}

/** @brief 这次运行开始之后建的、还没结束的 task（“新的未结束的 task”，§5.4）。 */
function hasNewOpenTasks(team: Team, run: LaneRun, request: number): boolean {
  return unfinishedTasks(team.board, request).some((task) => task.createdAt >= run.startedAt);
}

/**
 * @brief 程序唤醒的立项回合的兜底（§5.4 的表，回合正常结束或出错时）：等你拿主意的 task、需求级问题没处理、也没转告你的，
 *        分开时唤醒对话问你（ask_user），合并会话里这个回合的回复就算问过你；结案请它建 task 而它没建的，再唤醒结案一次；
 *        提醒过“没有 task”的需求仍没有 task 的，唤醒结案。立项选不到模型时唤醒对话转告你（§12.5）。
 * @param merged 合并会话
 */
function programTurnFallback(team: Team, run: LaneRun, merged: boolean): void {
  const causes = run.batch.map((item) => item.cause);
  const tasks = causes.flatMap((cause) => (cause.kind === 'need_user' ? [cause.task] : []));
  const requests = causes.flatMap((cause) => (cause.kind === 'question' ? [cause.request] : []));
  if (!merged && run.unavailable) {
    const reason = exhaustionText(run.unavailable.candidates, false);
    team.enqueueUser(team.delivery('create_unavailable', { createRole: team.holders.create, reason },
      { kind: 'ask_user', tasks, requests }), 'ask_user');
  } else {
    askUserAbout(team, run, merged, { tasks, requests });
  }
  for (const request of run.batch.flatMap((item) => (item.meta.closeAsk === undefined ? [] : [item.meta.closeAsk]))) {
    if (findRequest(team.board, request)?.status !== 'open' || hasNewOpenTasks(team, run, request)) continue;
    team.write((board) => ({ board: markCloseRetry(board, request), error: null }));
    team.enqueue(team.closeLane(request), team.delivery('close_no_new_tasks', { request,
      createRole: team.holders.create }, { kind: 'close_all_ended', request }));
  }
  for (const request of causes.flatMap((cause) => (cause.kind === 'no_tasks' ? [cause.request] : []))) {
    if (findRequest(team.board, request)?.status !== 'open' || tasksOf(team.board, request).length) continue;
    team.enqueue(team.closeLane(request), team.delivery('close_no_tasks', { request },
      { kind: 'no_tasks', request }));
  }
}

/** @brief 还没处理、也没问过你的 task 与需求级问题：分开时请对话问你，合并会话里标为已问过（§5.4 兜底表第 1、2 行）。 */
function askUserAbout(team: Team, run: LaneRun, merged: boolean,
  woken: { tasks: string[]; requests: number[] }): void {
  const tasks = woken.tasks.filter((id) => {
    const task = findTask(team.board, id);
    return task?.status === 'waiting_user' && !task.asked;
  });
  const requests = woken.requests.filter((no) => {
    const request = findRequest(team.board, no);
    return request?.status === 'open' && request.question !== null && !request.asked
      && !hasNewOpenTasks(team, run, no) && !run.messagedClose.includes(no);
  });
  if (!tasks.length && !requests.length) return;
  team.write((board) => ({ board: markAsked(board, { tasks, requests }, true), error: null }));
  if (merged || run.relayed) return;
  for (const id of tasks) {
    const question = findTask(team.board, id)?.question ?? '';
    team.enqueueUser(team.delivery('ask_user', { subject: id, question }, { kind: 'ask_user', tasks: [id],
      requests: [] }, { asked: { tasks: [id], requests: [] } }), 'ask_user');
  }
  for (const no of requests) {
    const question = findRequest(team.board, no)?.question ?? '';
    team.enqueueUser(team.delivery('ask_user', { subject: `Request ${no}`, question }, { kind: 'ask_user', tasks: [],
      requests: [no] }, { asked: { tasks: [], requests: [no] } }), 'ask_user');
  }
}

// ---- 临时提问（§10.1、§12.5） ----

/** @brief 不在对话范围里、取交集时去掉的候选的排除原因（§12.1）。 */
const OUTSIDE_RANGE_TEXT = 'not in the range you chose for the dialog';

/**
 * @brief 临时提问的失败文字：选不到模型（§12.1、§12.5：No model in your range fits <role>: 加每个候选的排除原因）。
 * @param role 被问的角色
 * @param info 候选及原因
 * @param outside 取交集时去掉的候选（不在对话的范围里），每个也列出原因
 */
export function askUnavailableText(role: string, info: UnavailableInfo, outside: readonly string[] = []): string {
  const reasons = [...info.candidates.map((item) => `${item.ref} — ${item.detail}`),
    ...outside.map((ref) => `${ref} — ${OUTSIDE_RANGE_TEXT}`)].join('; ');
  return `No model in your range fits ${roleLabel(role)}: ${reasons || `none of its models is ${OUTSIDE_RANGE_TEXT}`}`;
}

/** @brief 临时提问的运行结束：最后一段文字就是回答，交给等待的发送方；出错、选不到模型时发送方的工具结果报错（§9.4）。 */
function askRunEnded(team: Team, lane: Lane, run: LaneRun): void {
  const asker = lane.asker;
  lane.asker = null;
  if (!asker) return;
  const outside = team.host.entry(lane.id)?.model.outsideRefs() ?? [];
  if (run.unavailable) asker.settle(askUnavailableText(lane.role, run.unavailable, outside), true);
  else if (run.error) asker.settle(run.error, true);
  else asker.settle(run.lastText || `${roleLabel(lane.role)} ended without an answer.`, false);
}
