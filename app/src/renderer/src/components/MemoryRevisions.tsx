// 记忆页的 Revisions 节（docs/specs/memory.md §10.5）：列表（时间倒序，标题、时间、改动数、Running / Failed / Rollback 标记）
// 与右栏的一次修订：标题、时间、谁；增强运行的日子、会话数、反馈数、token；每处改动一块（动作、种类、abstract、依据或说明、
// 改动前后两份 detail 文件的对照，用 M4 的 diff 组件同样的设置）；Notes（Markdown）；Roll back this revision（一键，不确认）。

import { MultiFileDiff } from '@pierre/diffs/react';
import { useShallow } from 'zustand/react/shallow';
import {
  changeKindText, countsText, formatTokens, monthDay, monthDayTime, type RevisionAction, type RevisionChange,
  type RevisionDetail, type RevisionRow, type RevisionRun,
} from '../../../shared/memory';
import { rollbackRevision, selectRevision, useMemory, useUnavailable } from '../state/memory';
import { moveMenuFocus } from './menu';
import { LoadError, MemoryMarkdown, unavailableTitle } from './MemoryCommon';

/** 改动前后的对照：上下合并、长行折行（同 Diff.tsx，M4） */
const DIFF_OPTIONS = { diffStyle: 'unified', overflow: 'wrap' } as const;

/** 每处改动的动作在小标题里的写法 */
const ACTION_LABEL: Readonly<Record<RevisionAction, string>> = {
  added: 'Added', changed: 'Changed', deleted: 'Deleted', moved: 'Moved',
};

/** @brief 修订的时间 `<Mon D> <hh:mm>`（本地时间）。 */
function revisionTime(row: RevisionRow): string {
  return monthDayTime(Date.parse(row.time));
}

/** @brief 列表的一行：标题、时间、改动数、状态标记。 */
function RevisionButton({ row }: { row: RevisionRow }) {
  const selected = useMemory((state) => state.panel.kind === 'revision' && state.panel.id === row.id);
  const unavailable = useUnavailable();
  return (
    <button type="button" className="memory-row" data-testid="revision-row" data-id={row.id} aria-pressed={selected}
      disabled={unavailable !== null} title={unavailableTitle(unavailable)} onClick={() => selectRevision(row.id)}>
      <span className="memory-row-title">{row.title}</span>
      <span className="memory-row-meta">
        <span>{revisionTime(row)}</span>
        <span>{countsText(row.counts)}</span>
        {row.status === 'running' && <span className="memory-tag">Running</span>}
        {row.status === 'failed' && <span className="memory-tag failed">Failed</span>}
        {(row.rollbackOf !== null || row.by === 'Rollback') && <span className="memory-tag">Rollback</span>}
      </span>
    </button>
  );
}

/** @brief Revisions 节的列表：读取失败、读取中、没有修订、时间倒序的修订（↑ ↓ 在行之间移动）。 */
export function RevisionList() {
  const { revisions, loadError } = useMemory(useShallow((state) => ({ revisions: state.revisions,
    loadError: state.loadError })));
  if (loadError) return <LoadError text={loadError} />;
  if (!revisions) return <p className="memory-state" role="status">Loading…</p>;
  if (revisions.length === 0) return <p className="memory-state">No revisions yet.</p>;
  return (
    <ul className="memory-rows" aria-label="Revisions" onKeyDown={moveMenuFocus}>
      {revisions.map((row) => <li key={row.id}><RevisionButton row={row} /></li>)}
    </ul>
  );
}

/** @brief 数量与单数：`1 session`、`2 sessions`。 */
function plural(count: number, one: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${one}s`;
}

/** @brief 增强运行一行：`Day <Mon D> · <n> sessions · <m> feedback · <k> tokens`（运行中还没有 token 数时不写）。 */
function runLine(run: RevisionRun): string {
  const tokens = run.tokens === null ? '' : ` · ${formatTokens(run.tokens)}`;
  return `Day ${monthDay(run.day)} · ${plural(run.sessions, 'session')} · ${run.feedback} feedback${tokens}`;
}

/** @brief detail 文件 frontmatter 里的 abstract（JSON 字符串或原文）；读不出来时为 null。 */
function abstractIn(file: string): string | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file)?.[1];
  const line = head && /^abstract:[ \t]*(.*)$/m.exec(head)?.[1]?.trim();
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'string' ? value : line;
  } catch {
    return line;
  }
}

/** @brief 一处改动的条目名：改动后（删除时为改动前）的 abstract；读不出来时用 slug。 */
function changeAbstract(change: RevisionChange): string {
  const file = change.after || change.before;
  return abstractIn(file) ?? change.to?.slug ?? change.from?.slug ?? '';
}

/**
 * @brief 一处改动：`<Added|Changed|Deleted|Moved> · <KIND> · <abstract>`（移到另一种时 `Changed · <原> → <目标> · …`，
 *        §6.9）、依据（`Evidence: …`）或说明（`Note: …`，内核读出的原文不带这两个前缀）、前后两份 detail 文件的对照；
 *        点小标题展开、收起（同 M4 的卡片），默认展开。
 */
function ChangeBlock({ change }: { change: RevisionChange }) {
  const from = change.from?.slug ?? change.to?.slug ?? 'entry';
  const to = change.to?.slug ?? from;
  return (
    <details className="memory-change" open>
      <summary className="memory-change-title">
        {ACTION_LABEL[change.action]} · {changeKindText(change)} · {changeAbstract(change)}</summary>
      {change.evidence && <p className="memory-change-note">Evidence: {change.evidence}</p>}
      {change.note && <p className="memory-change-note">Note: {change.note}</p>}
      <div className="memory-diff">
        <MultiFileDiff oldFile={{ name: `${from}.md`, contents: change.before }}
          newFile={{ name: `${to}.md`, contents: change.after }} options={DIFF_OPTIONS} disableWorkerPool />
      </div>
    </details>
  );
}

/** @brief 一次修订的内容；回滚失败的原因在按钮旁边。 */
function RevisionBody({ revision }: { revision: RevisionDetail }) {
  const { busy, actionError } = useMemory(useShallow((state) => ({ busy: state.busy,
    actionError: state.actionError })));
  const unavailable = useUnavailable();
  const blocked = revision.status === 'running' || revision.changes.length === 0 || busy !== null
    || unavailable !== null;
  return (
    <>
      <h2 className="memory-detail-title">{revision.title}</h2>
      <p className="memory-detail-meta">{revisionTime(revision)} · {revision.by}</p>
      {revision.run && <p className="memory-detail-meta">{runLine(revision.run)}</p>}
      {revision.changes.map((change, index) => <ChangeBlock key={index} change={change} />)}
      {revision.notes !== null && (
        <section className="memory-block">
          <h3 className="memory-label">Notes</h3>
          <div className="memory-details"><MemoryMarkdown text={revision.notes} /></div>
        </section>
      )}
      <div className="memory-actions">
        <button type="button" className="button" data-testid="revision-rollback" disabled={blocked}
          title={unavailableTitle(unavailable)} onClick={() => void rollbackRevision()}>Roll back this revision</button>
        {actionError && <p className="form-message error" role="alert" data-testid="memory-error">{actionError}</p>}
      </div>
    </>
  );
}

/** @brief 右栏的一次修订：读取失败、读取中或内容。 */
export function RevisionDetailView() {
  const { revision, detailError } = useMemory(useShallow((state) => ({ revision: state.revision,
    detailError: state.detailError })));
  return (
    <div className="memory-revision" data-testid="revision-detail">
      {detailError ? <LoadError text={detailError} />
        : revision ? <RevisionBody revision={revision} /> : <p className="memory-state" role="status">Loading…</p>}
    </div>
  );
}
