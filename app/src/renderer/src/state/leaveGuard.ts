// 离开有未保存改动的页面之前先问你（docs/v0/screens/settings.md "离开时有未保存的改动"）：
// 编辑器有未保存的改动时登记一个检查；切换页面、会话或设置分节的入口都先经过这里，你选"Discard"才离开。
// 只在界面里：关闭 Mori 窗口时不问。

import { create } from 'zustand';

/** @brief 编辑器有未保存的改动时登记的检查。 */
interface Guard {
  /** 确认框的说明 */
  text: string;
  /** 你选"Discard"时丢掉改动：编辑器回到读到的内容（离开没有发生时，例如取消了选文件夹，也不留下改动） */
  discard: () => void;
}

/** @brief 等你回答的离开确认。 */
interface LeaveState {
  /** 你选"Discard"之后要做的事；没有在问时为 null */
  proceed: (() => void) | null;
  /** 你选"Keep editing"之后要做的事 */
  stay: (() => void) | null;
  /** 确认框的说明 */
  text: string;
}

/** @brief 等你回答的离开确认，LeaveDialog 读取；没有在问时 proceed 为 null。 */
export const useLeave = create<LeaveState>(() => ({ proceed: null, stay: null, text: '' }));

let guard: Guard | null = null;

/** @brief 登记（或用 null 取消）未保存改动的检查；同一时刻只有一个编辑器。 */
export function setLeaveGuard(next: Guard | null): void {
  guard = next;
}

/** @brief 离开之前：没有未保存的改动时立即执行 proceed（同步）；有时先问，你选"Discard"后再执行。 */
export function guardLeave(proceed: () => void): void {
  if (!guard) {
    proceed();
    return;
  }
  useLeave.setState({ proceed, stay: null, text: guard.text });
}

/** @brief 异步入口用：可以离开时为 true（没有未保存的改动，或你选了"Discard"）。 */
export function leaveAllowed(): Promise<boolean> {
  if (!guard) return Promise.resolve(true);
  const { text } = guard;
  return new Promise((resolve) => {
    useLeave.setState({ proceed: () => resolve(true), stay: () => resolve(false), text });
  });
}

/**
 * @brief 你在确认框里的选择。放弃改动时先取消检查（同一次离开里后面的入口不再问）并丢掉改动，再离开；
 *        离开没有发生时（例如取消了选文件夹）编辑器已经回到读到的内容，不会留下没有检查的改动。
 */
export function answerLeave(discard: boolean): void {
  const { proceed, stay } = useLeave.getState();
  useLeave.setState({ proceed: null, stay: null, text: '' });
  if (!discard) {
    stay?.();
    return;
  }
  const dropped = guard;
  guard = null;
  dropped?.discard();
  proceed?.();
}
