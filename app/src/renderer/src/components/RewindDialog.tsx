// Rewind 与 Undo 的冲突对话框（docs/specs/file-system.md §5.6，状态表 docs/v1/screens/fs-rewind.md "冲突"）：rewind /
// rewind.undo 返回 conflicts 时打开。标题 Restore these files anyway?、说明（Rewind 与 Undo 各一句）、冲突列表（路径与原因，
// 最多 200 条，多的末行 and {n} more）、按钮 Overwrite / Skip these files / Cancel。焦点默认在 Cancel，Tab 只在对话框里循环，
// Esc 等于 Cancel；第二次调用进行中三个按钮不可用、点的那个写 Restoring…（Undo 时 Undoing…），冲突又变了时换成新的列表。
// 盖住整个窗口（挂到 body 上），关掉后焦点回到打开前的元素。

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import {
  cancelConflicts, CONFLICT_REASONS, CONFLICTS_TITLE, conflictsDescription, conflictsMore, conflictsPendingText,
  resolveConflicts,
} from '../state/rewind';
import type { RewindConflicts } from '../state/store';
import '../styles/rewind.css';

/** @brief 对话框里 Tab 只在可用的按钮之间循环；按钮都不可用时焦点留在对话框上。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.shiftKey ? -1 : 1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

/** @brief 打开期间记下打开前有焦点的元素，关掉（卸载）时还给它（它已不在页面上时不动）。 */
function useRestoreFocus(): void {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
}

/**
 * @brief 焦点：打开时、冲突列表换了之后在 Cancel 上；第二次调用进行中（按钮都不可用）时在对话框本身上，
 *        Tab 与 Esc 仍由对话框接住。
 */
function useDialogFocus(conflicts: RewindConflicts, dialog: React.RefObject<HTMLDivElement | null>,
  cancel: React.RefObject<HTMLButtonElement | null>): void {
  useEffect(() => {
    if (conflicts.pending) dialog.current?.focus();
    else cancel.current?.focus();
  }, [conflicts.pending, conflicts.token, dialog, cancel]);
}

/** @brief 冲突列表：每行路径与原因；total 多于列出的条数时末行 and {n} more。 */
function ConflictList({ conflicts }: { conflicts: RewindConflicts }) {
  const more = conflictsMore(conflicts);
  return (
    <ul className="rewind-conflict-list">
      {conflicts.conflicts.map((conflict) => (
        <li key={conflict.path} className="rewind-conflict" data-testid="rewind-conflict" data-path={conflict.path}
          data-reason={conflict.reason}>
          <span className="rewind-conflict-path">{conflict.path}</span>
          <span className="rewind-conflict-reason">{CONFLICT_REASONS[conflict.reason]}</span>
        </li>
      ))}
      {more && <li className="rewind-conflict more">{more}</li>}
    </ul>
  );
}

/**
 * @brief 冲突对话框。
 * @param tabKey 会话的 key
 * @param conflicts 这个会话的冲突（tab.rewind.conflicts）
 */
export function RewindDialog({ tabKey, conflicts }: { tabKey: string; conflicts: RewindConflicts }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  const { kind } = conflicts.request;
  const pending = conflicts.pending;
  useRestoreFocus();
  useDialogFocus(conflicts, dialog, cancel);
  useOverlay(true, () => {
    if (pending) return false;
    cancelConflicts(tabKey);
  });
  const label = (action: 'overwrite' | 'skip', text: string) => (pending === action
    ? conflictsPendingText(kind) : text);
  // 在遮罩上按下鼠标不让焦点离开对话框，按键不会落到后面的界面上（同 ConfirmDialog）
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div ref={dialog} className="dialog rewind-dialog" role="alertdialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={titleId} aria-describedby={textId} data-testid="rewind-conflicts" data-kind={kind}
        onKeyDown={trapTab}>
        <h2 id={titleId}>{CONFLICTS_TITLE}</h2>
        <p id={textId}>{conflictsDescription(kind)}</p>
        <ConflictList conflicts={conflicts} />
        <div className="dialog-actions">
          <button className="button warn" data-testid="rewind-overwrite" disabled={pending !== null}
            onClick={() => void resolveConflicts(tabKey, 'overwrite')}>{label('overwrite', 'Overwrite')}</button>
          <button className="button" data-testid="rewind-skip" disabled={pending !== null}
            onClick={() => void resolveConflicts(tabKey, 'skip')}>{label('skip', 'Skip these files')}</button>
          <button ref={cancel} className="button" data-testid="rewind-conflict-cancel" disabled={pending !== null}
            onClick={() => cancelConflicts(tabKey)}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
