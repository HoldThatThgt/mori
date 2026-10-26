// 正在生成的会话数（docs/v0/screens/window.md"正在生成的会话"）：界面状态每次变化时按侧栏会话行的规则数一遍
// （sessionRows.ts 的 busyCount），数变了才告诉主进程；托盘菜单的"Exit"按它决定先不先问。页面加载时先报一次。

import { busyCount } from '../components/sessionRows';
import { useApp } from './store';

/** @brief 订阅界面状态，把正在生成的会话数报告给主进程（只在数变了时发）。 */
export function reportBusySessions(): void {
  let reported = -1;
  const report = (): void => {
    const { tabs, saved } = useApp.getState();
    const count = busyCount(tabs, saved.sessions);
    if (count === reported) return;
    reported = count;
    window.mori.setBusySessions(count);
  };
  report();
  useApp.subscribe(report);
}
