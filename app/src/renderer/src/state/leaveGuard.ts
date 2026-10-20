// 离开有未保存改动的页面之前先问你（docs/v0/screens/settings.md "离开时有未保存的改动"）：
// 编辑器有未保存的改动时登记一个检查；切换页面、会话或设置分节的入口都先经过这里，你选"放弃改动"才离开。
// 只在界面里：关闭 Mori 窗口时不问。

import { create } from 'zustand';

/** 登记的检查：有未保存的改动时返回确认框的说明，没有时返回 null */
type Guard = () => string | null;

/** @brief 等你回答的离开确认。 */
interface LeaveState {
  /** 你选"放弃改动"之后要做的事；没有在问时为 null */
  proceed: (() => void) | null;
  /** 你选"继续编辑"之后要做的事 */
  stay: (() => void) | null;
  /** 确认框的说明 */
  text: string;
}

export const useLeave = create<LeaveState>(() => ({ proceed: null, stay: null, text: '' }));

let guard: Guard | null = null;

/** @brief 登记（或用 null 取消）未保存改动的检查；同一时刻只有一个编辑器。 */
export function setLeaveGuard(next: Guard | null): void {
  guard = next;
}

/** @brief 离开之前：没有未保存的改动时立即执行 proceed（同步）；有时先问，你选"放弃改动"后再执行。 */
export function guardLeave(proceed: () => void): void {
  const text = guard?.() ?? null;
  if (!text) {
    proceed();
    return;
  }
  useLeave.setState({ proceed, stay: null, text });
}

/** @brief 异步入口用：可以离开时为 true（没有未保存的改动，或你选了"放弃改动"）。 */
export function leaveAllowed(): Promise<boolean> {
  const text = guard?.() ?? null;
  if (!text) return Promise.resolve(true);
  return new Promise((resolve) => {
    useLeave.setState({ proceed: () => resolve(true), stay: () => resolve(false), text });
  });
}

/** @brief 你在确认框里的选择：放弃改动时先取消检查（编辑器随页面离开而卸载），再离开。 */
export function answerLeave(discard: boolean): void {
  const { proceed, stay } = useLeave.getState();
  useLeave.setState({ proceed: null, stay: null, text: '' });
  if (discard) {
    guard = null;
    proceed?.();
  } else {
    stay?.();
  }
}
