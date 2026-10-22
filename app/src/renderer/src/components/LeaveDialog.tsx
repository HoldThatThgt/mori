// 离开有未保存改动的页面时的确认框（docs/v0/screens/settings.md）：焦点先在"Keep editing"，Esc 等于"Keep editing"。

import { answerLeave, useLeave } from '../state/leaveGuard';
import { ConfirmDialog } from './ConfirmDialog';

/** @brief 有离开确认在等你回答时显示。 */
export function LeaveDialog() {
  const text = useLeave((state) => state.text);
  const open = useLeave((state) => state.proceed !== null);
  if (!open) return null;
  return (
    <ConfirmDialog title="Discard changes to AGENTS.md?" text={text} confirmLabel="Discard" cancelLabel="Keep editing"
      tone="warn" testId="leave-dialog" onConfirm={() => answerLeave(true)} onCancel={() => answerLeave(false)} />
  );
}
