// 右栏的 Background tasks（docs/specs/parallel-agents-taskboard.md §13.13；docs/v1/screens/team-tasks.md）：照 Claude 桌面版
// 右栏的 Background tasks 一栏，Running / Finished 两节列出 TaskBoard 上的 task；点卡片打开 task 的视图
// （BackgroundTask.tsx），View transcript 打开实例的会话（BackgroundTranscript.tsx）；可以停止的卡片有 Stop this task。
// 内容来自会话的 TaskBoard 视图（mori.board），时长每秒更新。

import { useEffect, useLayoutEffect, useRef } from 'react';
import { setFinishedOpen, showTasksAt } from '../state/backgroundTasks';
import type { Tab } from '../state/store';
import { isRunning, taskSections, type ListedTask, type TaskContext } from '../state/taskList';
import { Icon } from '../icons';
import { BackgroundTask } from './BackgroundTask';
import { StopError, StopTaskButton, TaskLine, TranscriptLinks, taskContext } from './BackgroundParts';
import { BackgroundTranscript } from './BackgroundTranscript';
import { flashElements } from './quoteHighlight';
import { useNow } from './ToolCard';

/** 每个会话列表的滚动位置（Back 回到列表时不变，§13.13.3） */
const listScroll = new Map<string, number>();

/** @brief 一张 task 卡：标题、第二行、依赖与 View transcript；可以停止时右上角的停止按钮。 */
function TaskCard({ tab, item, context, now }: { tab: Tab; item: ListedTask; context: TaskContext; now: number }) {
  const { task } = item;
  const links = task.dependsOn.length > 0 || task.sessionRoles.length > 0;
  return (
    <div className={`bg-task${isRunning(task) ? '' : ' finished'}`} data-testid="bg-task" data-task={task.id}
      data-phase={task.phase} data-request={item.request.no}>
      <button type="button" className="bg-task-open" onClick={() => showTasksAt(tab.key, { level: 'task',
        task: task.id })}>
        <span className="bg-task-title">{`${task.id} ${task.title}`}</span>
        <TaskLine item={item} context={context} now={now} />
      </button>
      <StopTaskButton tab={tab} task={task} />
      {links && (
        <div className="bg-task-links">
          {task.dependsOn.length > 0 && <span className="muted">{`Depends on ${task.dependsOn.join(', ')}`}</span>}
          <TranscriptLinks tab={tab} task={task} back={{ level: 'list' }} />
        </div>
      )}
      <StopError tab={tab} task={task.id} />
    </div>
  );
}

/** @brief 进展摘要标题行的链接打开时：滚到这个需求的第一个 task，让它们短暂高亮（同引用跳转的高亮）。 */
function useHighlight(tab: Tab, body: React.RefObject<HTMLDivElement | null>) {
  const at = tab.tasks.at;
  const nonce = at.level === 'list' ? at.highlight?.nonce ?? 0 : 0;
  useEffect(() => {
    if (at.level !== 'list' || !at.highlight || !body.current) return;
    const css = `[data-testid="bg-task"][data-request="${at.highlight.request}"]`;
    const cards = [...body.current.querySelectorAll(css)];
    cards[0]?.scrollIntoView({ block: 'nearest' });
    flashElements(cards);
  }, [nonce]);
}

/** @brief 列表（§13.13.2）：Running、Finished 两节；空的一节不显示；没有 task 时 Background tasks appear here。 */
function TaskList({ tab }: { tab: Tab }) {
  const body = useRef<HTMLDivElement>(null);
  const { running, finished } = taskSections(tab.board);
  const now = useNow(running.length > 0);
  const context = taskContext(tab);
  const open = tab.tasks.finishedOpen;
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = listScroll.get(tab.key) ?? 0;
  }, [tab.key]);
  useHighlight(tab, body);
  const card = (item: ListedTask) => <TaskCard key={item.task.id} tab={tab} item={item} context={context} now={now} />;
  return (
    <div className="panel-body bg-body" data-testid="bg-tasks" ref={body}
      onScroll={(event) => listScroll.set(tab.key, event.currentTarget.scrollTop)}>
      {running.length === 0 && finished.length === 0 && <p className="muted">Background tasks appear here</p>}
      {running.length > 0 && (
        <section className="bg-section" data-testid="bg-section" data-section="running">
          <h3 className="bg-section-head">Running</h3>
          {running.map(card)}
        </section>
      )}
      {finished.length > 0 && (
        <section className="bg-section" data-testid="bg-section" data-section="finished">
          <button type="button" className="bg-section-head" aria-expanded={open}
            onClick={() => setFinishedOpen(tab.key, !open)}>
            <Icon name={open ? 'down' : 'chevron'} />Finished</button>
          {open && finished.map(card)}
        </section>
      )}
    </div>
  );
}

/** @brief Background tasks 这一栏：按所在的一层显示列表、task 的视图或实例的会话。 */
export function BackgroundTasks({ tab }: { tab: Tab }) {
  const at = tab.tasks.at;
  if (at.level === 'task') return <BackgroundTask key={at.task} tab={tab} task={at.task} />;
  if (at.level === 'transcript') {
    return <BackgroundTranscript key={JSON.stringify(at.of)} tab={tab} of={at.of} back={at.back} />;
  }
  return <TaskList tab={tab} />;
}
