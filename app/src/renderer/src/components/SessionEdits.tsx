// 会话行上的改名框与删除确认框（docs/v0/screens/sessions.md "重命名""归档与删除"）。

import { useLayoutEffect, useRef, useState } from 'react';
import { describe } from '../state/bridge';
import { useOverlay } from '../state/overlays';
import { deleteSession, renameSession } from '../state/projects';
import { ConfirmDialog } from './ConfirmDialog';
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

/** @brief 删除确认框（照 Claude 桌面版，永久删除）；删除中 Esc 和"Cancel"都不起作用。 */
export function DeleteDialog({ row, onClose }: { row: Row; onClose: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsaved = isUnsaved(row);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteSession({ tabKey: row.tab?.key, sessionFile: row.file });
      onClose(true);
    } catch (cause) {
      setError(`Couldn’t delete this session: ${describe('delete session', cause)}`);
      setBusy(false);
    }
  }
  const text = unsaved ? 'This session has no messages yet.'
    : 'This session will be permanently deleted. This can’t be undone.';
  return (
    <ConfirmDialog title={`Delete “${row.title}”?`} text={text} confirmLabel="Delete" tone="danger"
      testId="delete-dialog" busyText={busy ? 'Deleting…' : null} error={error}
      onConfirm={() => void confirm()} onCancel={() => onClose(false)} />
  );
}
