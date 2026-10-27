// 会话行上的改名框与删除确认框（docs/v0/screens/sessions.md "重命名""归档与删除"）。
// 删除 worktree 里的会话（docs/specs/file-system.md §11.9.5，状态表 docs/v1/screens/fs-worktree.md "归档、恢复、删除"）：
// 确认框打开时先读它拥有的 worktree（worktrees.list），返回之前说明后面一行 Checking its worktree…、Delete 不可用
// （aria-disabled）；返回后按结果加一句（干净、有改动、读不出、别的会话在用、没装 git），点 Delete 时一起删掉。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describe } from '../state/bridge';
import { useOverlay } from '../state/overlays';
import { deleteSession, renameSession } from '../state/projects';
import {
  CHECKING_WORKTREE_TEXT, checksWorktree, NO_WORKTREE_PLAN, planDelete, type DeletePlan,
} from '../state/worktrees';
import { WorktreeDialog } from './InitGitDialog';
import { useOutsideClose } from './menu';
import { isUnsaved, type Row } from './sessionRows';

/**
 * @brief 改名的状态与保存：commit 保存（名字没变或为空时不写），finish 结束编辑；失败后 error 为原文。
 * @param onDone 结束编辑时调用；keepFocus 为真时焦点回到会话行
 */
function useRename(row: Row, input: React.RefObject<HTMLInputElement | null>,
  onDone: (keepFocus: boolean) => void) {
  const [value, setValue] = useState(row.editName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(false);

  function finish(keepFocus: boolean) {
    finished.current = true;
    onDone(keepFocus);
  }

  async function commit(keepFocus: boolean) {
    if (saving || finished.current) return;
    const name = value.replace(/\s+/g, ' ').trim();
    if (!name || name === row.editName) {
      finish(keepFocus);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await renameSession({ tabKey: row.tab?.key, sessionFile: row.file }, name);
      finish(keepFocus);
    } catch (cause) {
      setError(describe('session.rename', cause));
      setSaving(false);
      input.current?.focus();
    }
  }

  return { value, setValue, saving, error, commit, finish };
}

/**
 * @brief 改名框：Enter 保存，Esc 取消（不停止生成）；在框外按下鼠标或按 Tab 等于保存，改名失败之后等于放弃。
 *        输入法组字时 Enter 只选词。窗口失去焦点、F8 报告框、信任询问都不结束编辑。
 */
export function RenameInput({ row, onDone }: { row: Row; onDone: (keepFocus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { value, setValue, saving, error, commit, finish } = useRename(row, input, onDone);
  const leave = () => (error ? finish(false) : void commit(false));
  useOverlay(true, () => (saving ? false : finish(true)));
  useOutsideClose(true, box, leave);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab') leave();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void commit(true);
  }

  return (
    <div ref={box} className="session-rename">
      <input ref={input} value={value} readOnly={saving} aria-label="Session name" data-testid="rename-input"
        onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} />
      {error && (
        <p className="rename-error" role="alert" data-testid="rename-error">Couldn’t rename this session: {error}</p>
      )}
    </div>
  );
}

/**
 * @brief 删除时会话的 worktree 怎样处理（file-system.md §11.9.5 第 1 步）：worktree 里的会话在确认框打开时
 *        worktrees.list 一次（planDelete 不会失败，列表失败时给“读不出”那一句），返回之前为 null；不是 worktree 里的
 *        会话直接是 NO_WORKTREE_PLAN，不发命令。
 */
function useDeletePlan(row: Row): DeletePlan | null {
  const checks = checksWorktree(row.cwd);
  const [plan, setPlan] = useState<DeletePlan | null>(checks ? null : NO_WORKTREE_PLAN);
  useEffect(() => {
    if (!checks) return;
    let live = true;
    void planDelete(row.file, row.cwd).then((next) => {
      if (live) setPlan(next);
    });
    return () => {
      live = false;
    };
  }, [checks, row.file, row.cwd]);
  return plan;
}

/**
 * @brief 确认框说明后面关于 worktree 的一行：读取中 Checking its worktree…，读到后按结果的一句；没有时不画。
 *        两种都是同一个 role="status" 的元素，从读取中换成那一句时读屏会读出来（焦点留在 Cancel 上）。
 */
function WorktreeNote({ plan }: { plan: DeletePlan | null }) {
  if (plan === null) return <p className="dialog-note" role="status">{CHECKING_WORKTREE_TEXT}</p>;
  if (!plan.note) return null;
  return (
    <p className="dialog-note" role="status" data-testid="delete-worktree-note" data-kind={plan.note.kind}>
      {plan.note.text}</p>
  );
}

/**
 * @brief 删除确认框（照 Claude 桌面版，永久删除）；删除中 Esc 和"Cancel"都不起作用。worktree 里的会话在读到它的
 *        worktree 之前 Delete 不可用；删 worktree 失败时显示原文、会话文件还在，可以再点 Delete 重试。
 */
export function DeleteDialog({ row, onClose }: { row: Row; onClose: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = useDeletePlan(row);
  const unsaved = isUnsaved(row);
  async function confirm() {
    if (plan === null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSession({ tabKey: row.tab?.key, sessionFile: row.file }, plan);
      onClose(true);
    } catch (cause) {
      setError(`Couldn’t delete this session: ${describe('delete session', cause)}`);
      setBusy(false);
    }
  }
  const text = unsaved ? 'This session has no messages yet.'
    : 'This session will be permanently deleted. This can’t be undone.';
  // 没有 worktree 的一句时不传（外框不加说明下面那一块，读屏的说明只有 text）
  const note = plan === null || plan.note ? <WorktreeNote plan={plan} /> : null;
  return (
    <WorktreeDialog title={`Delete “${row.title}”?`} text={text} confirmLabel="Delete" tone="danger"
      testId="delete-dialog" busy={busy} busyText="Deleting…" blocked={plan === null} error={error}
      onConfirm={() => void confirm()} onCancel={() => onClose(false)}>
      {note}
    </WorktreeDialog>
  );
}
