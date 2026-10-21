// 确认对话框：盖住整个窗口；焦点先在"Cancel"，Tab 只在两个按钮之间切换，Esc 等于取消（进行中不能关）。
// 用于切到"Allow all"（approval.md）、删除会话（sessions.md）和离开有未保存改动的页面（settings.md）。

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';

/** @brief 对话框的内容与状态。 */
export interface ConfirmDialogProps {
  /** 标题 */
  title: string;
  /** 说明 */
  text: string;
  /** 确认按钮的文字 */
  confirmLabel: string;
  /** 取消按钮的文字；默认"Cancel" */
  cancelLabel?: string;
  /** 确认按钮的样式：warn 警示色（黄），danger 危险色（红） */
  tone: 'warn' | 'danger';
  /** 测试标识 */
  testId: string;
  /** 进行中时显示的文字；为 null 时不在进行中 */
  busyText?: string | null;
  /** 失败的原文；为 null 时没有 */
  error?: string | null;
  /** 点了确认 */
  onConfirm: () => void;
  /** 点了取消或按了 Esc */
  onCancel: () => void;
}

/** @brief 对话框里 Tab 只在可用的按钮之间切换。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.shiftKey ? -1 : 1;
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

/** @brief 确认对话框。 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { title, text, confirmLabel, cancelLabel = 'Cancel', tone, testId, busyText = null, error = null, onConfirm,
    onCancel } = props;
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  const busy = busyText !== null;
  useOverlay(true, () => {
    if (busy) return false;
    onCancel();
  });
  // 打开时、失败后（按钮重新可用）焦点回到"Cancel"。
  useEffect(() => {
    if (!busy) cancel.current?.focus();
  }, [busy, error]);
  // 会话面板是尺寸容器（container-type），fixed 定位会相对它，所以挂到 body 上。
  // 在遮罩上按下鼠标不让焦点离开对话框，按键不会落到后面的界面上。
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}
        data-testid={testId} onKeyDown={trapTab}>
        <h2 id={titleId}>{title}</h2>
        <p id={textId}>{text}</p>
        {busy && <p className="dialog-status" role="status">{busyText}</p>}
        {error && <p className="form-message error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className={`button ${tone}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
          <button ref={cancel} className="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
