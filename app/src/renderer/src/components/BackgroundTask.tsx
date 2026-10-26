// Background tasks 里一个 task 的视图（docs/specs/parallel-agents-taskboard.md §13.13.3；docs/v1/screens/team-tasks.md
// “task 的视图”）：说明全文（Prompt）、依赖、留给 task 的消息全文与每一棒的完整交接，都来自 board.readTask；
// 第二行与停止按钮随 mori.board 实时更新，这个 task 的视图变了时重新读，最多每秒一次。

import { useCallback, useState } from 'react';
import { roleLabel, type TaskDetail } from '../../../shared/team';
import { commandSession, readTask, showTasksAt } from '../state/backgroundTasks';
import type { Tab } from '../state/store';
import {
  closeButton, dependencyLine, evidenceLine, handoffHead, messageHead, type TaskContext,
} from '../state/taskList';
import {
  BackRow, ReadError, StopError, StopTaskButton, TaskLine, TranscriptLinks, findListed, taskContext,
  useThrottledRead,
} from './BackgroundParts';
import { Markdown } from './Markdown';
import { useNow } from './ToolCard';

/** @brief 读 task 详情的状态。 */
type Read = { status: 'loading' } | { status: 'ready'; detail: TaskDetail } | { status: 'error'; error: string };

/**
 * @brief 一棒交接（§13.13.3）：头一行、结论全文、未结事项、证据、建议的下一棒、View transcript（有会话位置时；结案写的
 *        一棒总有，打开结案会话）。
 */
function Handoff({ tab, detail, handoff, context }: { tab: Tab; detail: TaskDetail;
  handoff: TaskDetail['handoffs'][number]; context: TaskContext }) {
  const task = detail.id;
  const open = () => {
    const of = handoff.byClose ? { kind: 'close' as const, request: detail.request }
      : { kind: 'task' as const, task, role: handoff.session?.role ?? handoff.role };
    showTasksAt(tab.key, { level: 'transcript', of, back: { level: 'task', task } });
  };
  return (
    <div className="bg-handoff" data-testid="bg-handoff" data-n={handoff.n}>
      <div className="bg-handoff-head">{handoffHead(handoff, context.holders)}</div>
      {handoff.conclusion.trim() && <Markdown text={handoff.conclusion} />}
      {handoff.openItems.length > 0 && <>
        <div className="bg-label">Open items</div>
        <ul className="bg-list">{handoff.openItems.map((item, index) => <li key={index}>{item}</li>)}</ul>
      </>}
      {handoff.evidence.length > 0 && <>
        <div className="bg-label">Evidence</div>
        {handoff.evidence.map((item) => <div key={item.tag} className="bg-line">{evidenceLine(item)}</div>)}
      </>}
      {handoff.suggestedNext && <div className="bg-line">{`Suggested next: ${roleLabel(handoff.suggestedNext)}`}</div>}
      {(handoff.session || handoff.byClose) && (
        <button type="button" className="text-link bg-link" data-action="view-transcript"
          data-role={handoff.byClose ? 'close' : handoff.session?.role ?? handoff.role} onClick={open}>
          View transcript</button>
      )}
    </div>
  );
}

/** @brief 读到的详情：Prompt、Depends on、Messages、Handoffs（§13.13.3 的顺序）。 */
function Detail({ tab, detail, context }: { tab: Tab; detail: TaskDetail; context: TaskContext }) {
  return (
    <>
      <section className="bg-part">
        <h4 className="bg-label">Prompt</h4>
        <Markdown text={detail.description} />
      </section>
      {detail.dependsOn.length > 0 && (
        <section className="bg-part">
          <h4 className="bg-label">Depends on</h4>
          {detail.dependsOn.map((dep) => (
            <button key={dep.id} type="button" className="text-link bg-dep" data-task={dep.id}
              onClick={() => showTasksAt(tab.key, { level: 'task', task: dep.id })}>
              {dependencyLine(dep, context)}</button>
          ))}
        </section>
      )}
      {detail.messages.length > 0 && (
        <section className="bg-part">
          <h4 className="bg-label">Messages</h4>
          {detail.messages.map((message, index) => (
            <div key={index} className="bg-message" data-testid="bg-message">
              <div className="muted">{messageHead(message)}</div>
              <Markdown text={message.text} />
            </div>
          ))}
        </section>
      )}
      {detail.handoffs.length > 0 && (
        <section className="bg-part">
          <h4 className="bg-label">Handoffs</h4>
          {detail.handoffs.map((handoff) => <Handoff key={handoff.n} tab={tab} detail={detail} handoff={handoff}
            context={context} />)}
        </section>
      )}
    </>
  );
}

/** @brief 一个 task 的视图。 */
export function BackgroundTask({ tab, task }: { tab: Tab; task: string }) {
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const listed = findListed(tab.board, task);
  const context = taskContext(tab);
  const now = useNow(listed?.task.closedAt === null);
  const load = useCallback(() => {
    const sessionId = commandSession(tab);
    if (sessionId === null) return;
    readTask(sessionId, task).then((result) => setRead(result.error === null
      ? { status: 'ready', detail: result.task } : { status: 'error', error: result.error }),
    (error: unknown) => setRead({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  }, [tab.sessionId, task]);
  // 会话重新打开（后台进程重启）之后也重新读
  useThrottledRead(JSON.stringify([tab.sessionId, listed?.task ?? null]), load);
  const detail = read.status === 'ready' ? read.detail : null;
  const readOnly = detail?.readOnly ?? false;
  return (
    <div className="panel-body bg-body" data-testid="bg-task-view" data-task={task}>
      <BackRow tab={tab} back={{ level: 'list' }} />
      <div className="bg-task-head">
        <h3 className="bg-task-title">{`${task} ${listed?.task.title ?? detail?.title ?? ''}${readOnly ? ' · Read-only'
          : ''}`}</h3>
        {listed && <StopTaskButton tab={tab} task={listed.task} />}
      </div>
      {listed && <TaskLine item={listed} context={context} now={now} />}
      <StopError tab={tab} task={task} />
      {listed && <div className="bg-line">{`Request ${listed.request.no} · ${listed.request.title}`}</div>}
      {listed && (
        <div className="bg-task-links">
          <TranscriptLinks tab={tab} task={listed.task} back={{ level: 'task', task }} />
          {listed.request.closeSession && <CloseLink tab={tab} task={task} request={listed.request.no} />}
        </div>
      )}
      {read.status === 'loading' && <p className="muted">Loading…</p>}
      {read.status === 'error' && <ReadError text={`Couldn’t load ${task}: ${read.error}`} detail={null}
        onRetry={load} />}
      {detail && <Detail tab={tab} detail={detail} context={context} />}
    </div>
  );
}

/** @brief 这个需求的结案会话（View transcript (closing)，§13.13.3）。 */
function CloseLink({ tab, task, request }: { tab: Tab; task: string; request: number }) {
  const button = closeButton(request, tab.team.holders);
  return (
    <button type="button" className="text-link bg-link" data-action="view-transcript" data-role="close"
      aria-label={button.aria} onClick={() => showTasksAt(tab.key, { level: 'transcript', of: button.of,
        back: { level: 'task', task } })}>{button.label}</button>
  );
}
