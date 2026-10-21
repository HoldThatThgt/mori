// 对话流里的协作（docs/specs/parallel-agents-taskboard.md §13.2、§13.3；docs/v1/screens/team-stream.md）：
// 回执的一行，与每个需求一块的进展摘要。摘要的位置来自 mori.progress，内容来自会话的 TaskBoard 视图（mori.board、
// 会话信息），文字都由 shared/team.ts 用需求和 task 的标题、当前在做什么、每一棒的结论拼出来；时长每秒更新。

import { useState } from 'react';
import {
  chainText, durationText, receiptText, requestStateText, roleLabel, taskPhaseText, type BoardView,
  type ReceiptEntryData, type RequestView, type TaskStatus, type TaskView, type TeamHolders,
} from '../../../shared/team';
import { useApp } from '../state/store';
import { useNow } from './ToolCard';

/** 已结束的 task：折叠时不列（§13.3） */
const ENDED: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

/** @brief 回执的一行（§13.2）；补充的原话截断时悬停看全文。 */
export function Receipt({ receipt }: { receipt: ReceiptEntryData }) {
  const full = receipt.kind === 'added' ? `Added to request ${receipt.request}: “${receipt.quote ?? ''}”` : undefined;
  return (
    <div className="receipt" data-testid="receipt" data-kind={receipt.kind} data-request={receipt.request} title={full}>
      {receiptText(receipt)}
    </div>
  );
}

/** @brief 进展摘要拼文字要用的：整块 TaskBoard 视图、权限的持有者、会话的工作目录。 */
interface ProgressContext {
  /** TaskBoard 视图 */
  view: BoardView;
  /** 权限的持有者（Waiting for <create role>、With <close role>） */
  holders: TeamHolders;
  /** 会话的工作目录（当前在做什么里的路径） */
  cwd: string;
}

/**
 * @brief task 的一行：`T1 <title> · <role> · <当前在做什么>[ · <模型提示>]`。持有者为空（pending、终态）或交到结案时
 *        省略角色段（结案的角色已写在状态里，team-stream.md）；展开时下面一行交接链。
 */
function TaskRow({ task, context, expanded }: { task: TaskView; context: ProgressContext; expanded: boolean }) {
  const role = task.holder !== null && task.phase !== 'with_close' ? ` · ${roleLabel(task.holder)}` : '';
  const doing = taskPhaseText(task, context.view, context.holders, context.cwd);
  const note = task.modelNote ? ` · ${task.modelNote}` : '';
  return (
    <>
      <div className="progress-task" data-testid="progress-task" data-task={task.id} data-phase={task.phase}>
        {`${task.id} ${task.title}${role} · ${doing}${note}`}
      </div>
      {expanded && task.chain.length > 0 && (
        <div className="progress-chain" data-testid="progress-chain" data-task={task.id}>{chainText(task.chain)}</div>
      )}
    </>
  );
}

/** @brief 一块进展摘要的内容：标题行（点它展开、折叠）、task 行；展开时另有已排除的方案与结论。 */
function ProgressBody({ request, context }: { request: RequestView; context: ProgressContext }) {
  const [open, setOpen] = useState(false);
  const now = useNow(request.closedAt === null);
  const elapsed = (request.closedAt ?? now) - request.createdAt;
  const title = `Request ${request.no} · ${request.title} · ${requestStateText(request.state, context.holders)}`
    + ` · ${durationText(elapsed)}`;
  const tasks = open ? request.tasks : request.tasks.filter((task) => !ENDED.includes(task.status));
  return (
    <div className="progress-summary" data-testid="progress" data-request={request.no} data-state={request.state}>
      <button className="progress-title" aria-expanded={open} onClick={() => setOpen(!open)}>{title}</button>
      {tasks.map((task) => <TaskRow key={task.id} task={task} context={context} expanded={open} />)}
      {open && request.ruledOut.length > 0 && (
        <div className="progress-ruled-out" data-testid="progress-ruled-out">
          <div className="progress-label">Ruled out</div>
          {request.ruledOut.map((line, index) => <div key={index} className="progress-line">{line}</div>)}
        </div>
      )}
      {open && request.conclusion && (
        <div className="progress-conclusion" data-testid="progress-conclusion">Conclusion: {request.conclusion}</div>
      )}
    </div>
  );
}

/** @brief 一个需求的进展摘要（mori.progress 的位置）；TaskBoard 视图里没有这个需求时不显示。 */
export function ProgressSummary({ request, tabKey }: { request: number; tabKey: string }) {
  const view = useApp((state) => state.tabs.find((tab) => tab.key === tabKey)?.board);
  const holders = useApp((state) => state.tabs.find((tab) => tab.key === tabKey)?.team.holders);
  const cwd = useApp((state) => state.tabs.find((tab) => tab.key === tabKey)?.cwd ?? '');
  const found = view?.requests.find((item) => item.no === request);
  if (!view || !holders || !found) return null;
  return <ProgressBody request={found} context={{ view, holders, cwd }} />;
}
