// 离开有未保存改动的页面时的确认框（docs/v0/screens/settings.md）：焦点先在"Keep editing"，Esc 等于"Keep editing"。
// 标题与说明取自登记的检查（设置页 AGENTS.md、记忆页的条目表单，docs/specs/memory.md §10.1）。

import { answerLeave, useLeave } from '../state/leaveGuard';
import { ConfirmDialog } from './ConfirmDialog';

/** @brief 有离开确认在等你回答时显示。 */
export function LeaveDialog() {
  const title = useLeave((state) => state.title);
  const text = useLeave((state) => state.text);
  const open = useLeave((state) => state.proceed !== null);
  if (!open) return null;
  return (
    <ConfirmDialog title={title} text={text} confirmLabel="Discard" cancelLabel="Keep editing"
      tone="warn" testId="leave-dialog" onConfirm={() => answerLeave(true)} onCancel={() => answerLeave(false)} />
  );
}
