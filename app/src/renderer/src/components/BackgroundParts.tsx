// Background tasks 的列表、task 的视图与实例的会话共用的部分（docs/specs/parallel-agents-taskboard.md §13.13）：
// Stop this task 与它失败的一行、View transcript 的按钮、task 卡的第二行、Back 那一行，以及“打开时读一次、之后变了
// 重新读，最多每秒一次”（§15）。

import { useEffect, useRef } from 'react';
import { canStopTask, type BoardView, type TaskView } from '../../../shared/team';
import { backTo, settleStop, showTasksAt, stopKey, stopTask, useStopState } from '../state/backgroundTasks';
import type { Tab, TasksBack } from '../state/store';
import { cardParts, listedTasks, transcriptButtons, type ListedTask, type TaskContext } from '../state/taskList';
import { Icon } from '../icons';

/** 重新读的最短间隔（§15，临时默认值，docs/v1/defaults.md），毫秒 */
const REREAD_MS = 1000;

/** @brief 拼文字要用的上下文（同进展摘要）。 */
export function taskContext(tab: Tab): TaskContext {
  return { view: tab.board, holders: tab.team.holders, cwd: tab.cwd };
}

/** @brief TaskBoard 视图里的一个 task 与它的需求；没有时为 null。 */
export function findListed(view: BoardView, id: string): ListedTask | null {
  return listedTasks(view).find((item) => item.task.id === id) ?? null;
}

/**
 * @brief 打开时读一次；key 变了时重新读，最多每秒一次（§15）。间隔里又变了只在间隔结束时读一次。
 * @param key 变了就要重新读的内容（TaskView 的 JSON 等）
 * @param read 读
 * @param enabled 为假时不再因 key 变化重新读（会话的运行结束后停在最后的样子）
 */
export function useThrottledRead(key: string, read: () => void, enabled = true): void {
  const state = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({ last: 0, timer: null });
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    const current = state.current;
    // 还没读过时总要读一次（last 为 0）；读过之后 enabled 为假就不再读
    if (current.timer !== null || (!enabled && current.last > 0)) return;
    const wait = Math.max(0, current.last + REREAD_MS - Date.now());
    current.timer = setTimeout(() => {
      current.timer = null;
      current.last = Date.now();
      latest.current();
    }, wait);
  }, [key, enabled]);
  useEffect(() => () => {
    if (state.current.timer !== null) clearTimeout(state.current.timer);
    state.current.timer = null;
  }, []);
}

/** @brief Stop this task（§13.13.7）：停止中不可用；这个 task 不再可以停时清掉停止中的状态。 */
export function StopTaskButton({ tab, task }: { tab: Tab; task: TaskView }) {
  const state = useStopState((all) => all[stopKey(tab.key, task.id)]);
  const stoppable = canStopTask(task);
  useEffect(() => {
    if (!stoppable) settleStop(tab.key, task.id);
  }, [stoppable, tab.key, task.id]);
  if (!stoppable) return null;
  return (
    <button type="button" className="icon-button bg-stop" data-action="stop-task" aria-label="Stop this task"
      title="Stop this task" disabled={state?.stopping === true} onClick={() => void stopTask(tab.key, task.id)}>
      <Icon name="stop" />
    </button>
  );
}

/** @brief 停止失败的一行（§13.13.7）：`Couldn’t stop T1: <原文>`。 */
export function StopError({ tab, task }: { tab: Tab; task: string }) {
  const error = useStopState((all) => all[stopKey(tab.key, task)]?.error ?? null);
  return error ? <div className="bg-error" role="alert">{`Couldn’t stop ${task}: ${error}`}</div> : null;
}

/** @brief 每个有会话的角色一个 View transcript（§13.13.2）。 */
export function TranscriptLinks({ tab, task, back }: { tab: Tab; task: TaskView; back: TasksBack }) {
  return (
    <>
      {transcriptButtons(task).map((button) => (
        <button key={button.label} type="button" className="text-link bg-link" data-action="view-transcript"
          data-role={button.of.kind === 'task' ? button.of.role : 'close'} aria-label={button.aria}
          onClick={() => showTasksAt(tab.key, { level: 'transcript', of: button.of, back })}>{button.label}</button>
      ))}
    </>
  );
}

/** @brief task 卡第二行（§13.13.2）：悬停 `Request 1` 显示需求标题。 */
export function TaskLine({ item, context, now }: { item: ListedTask; context: TaskContext; now: number }) {
  const parts = cardParts(item, context, now);
  return (
    <div className="bg-task-line">
      <span title={item.request.title}>{parts.request}</span>{` · ${parts.role} · ${parts.doing} · ${parts.duration}`}
    </div>
  );
}

/** @brief 顶部的 Back（§13.13.3、§13.13.4）。 */
export function BackRow({ tab, back }: { tab: Tab; back: TasksBack }) {
  return (
    <div className="bg-back-row">
      <button type="button" className="text-link back-link" data-action="back" onClick={() => backTo(tab.key, back)}>
        <Icon name="back" /><span className="back-text">Back</span></button>
    </div>
  );
}

/** @brief 读不到时的原文与 Retry。 */
export function ReadError({ text, detail, onRetry }: { text: string; detail: string | null; onRetry: () => void }) {
  return (
    <div className="bg-error bg-read-error" role="alert">
      <div>{text}</div>
      {detail && <pre className="bg-error-detail">{detail}</pre>}
      <button type="button" className="text-link" data-action="retry" onClick={onRetry}>Retry</button>
    </div>
  );
}
