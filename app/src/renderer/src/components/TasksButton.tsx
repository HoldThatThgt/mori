// 阶段行右端的按钮（docs/specs/parallel-agents-taskboard.md §13.13.1；Claude 输入框上方状态行里的那个）：TaskBoard 上有
// task 时显示，对话在不在回复都显示；有没结束的 task 时 `{n} running tasks`，否则 `{n} tasks finished`。点它打开右栏到
// Background tasks（停在上次看的那一层），已经在这一栏时关上右栏；窄窗口或分屏放不下时同右栏开关（浮在上层）。

import { recordAction } from '../state/actionLog';
import { updateTab, type Tab } from '../state/store';
import { tasksButtonText, tasksShown } from '../state/taskList';

/**
 * @brief 阶段行右端的按钮；TaskBoard 上没有 task 时不显示。
 * @param rightOpen 这一栏的右栏开着
 * @param onToggleRight 右栏开关（与顶栏的同一个：贴在右边时开关右栏，放不下时浮在上层）
 */
export function TasksButton({ tab, rightOpen, onToggleRight }: { tab: Tab; rightOpen: boolean;
  onToggleRight: () => void }) {
  const text = tasksButtonText(tab.board);
  if (text === null || !tasksShown(tab.board, tab.team.mode)) return null;
  const pressed = rightOpen && tab.rightTab === 'tasks';
  const click = () => {
    if (pressed) {
      onToggleRight();
      return;
    }
    recordAction('Open background tasks');
    updateTab(tab.key, (current) => ({ ...current, rightTab: 'tasks' }));
    if (!rightOpen) onToggleRight();
  };
  return (
    <button type="button" className="tasks-button" data-testid="tasks-button" aria-pressed={pressed}
      title="Show this session’s background tasks" onClick={click}>{text}</button>
  );
}
