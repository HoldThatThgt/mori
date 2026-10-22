// 分屏（docs/v0/screens/split.md）：中栏最多左右两栏，当前会话（activeKey）就是焦点所在的那一栏。
// 会话在哪一栏只是界面状态：打开过的会话一直开在后台进程里，关闭一栏不发任何命令，生成照常进行。

import { recordAction } from './actionLog';
import { guardLeave } from './leaveGuard';
import { hasOverlay } from './overlays';
import { shownKeys, useApp, type AppState } from './store';

/** @brief 分屏的哪一侧。 */
export type Side = 'left' | 'right';

/** @brief 让一个会话显示出来时的状态改动：清掉它的"Unread"。 */
function seen(state: AppState, key: string): Pick<AppState, 'tabs'> {
  return { tabs: state.tabs.map((tab) => (tab.key === key && tab.unseen ? { ...tab, unseen: false } : tab)) };
}

/**
 * @brief 把一个会话放进焦点所在的那一栏（侧栏点会话、新建、打开文件夹、跳回引用的原会话）：
 *        已在某一栏的只把焦点切过去；分屏时换掉焦点所在的那一栏，单栏时换成它。
 */
export function showInFocused(state: AppState, key: string): Pick<AppState, 'activeKey' | 'split'> {
  const { split, activeKey } = state;
  if (!split || split.includes(key)) return { activeKey: key, split };
  const index = activeKey && split.includes(activeKey) ? split.indexOf(activeKey) : 1;
  const next: [string, string] = index === 0 ? [key, split[1]] : [split[0], key];
  return { activeKey: key, split: next };
}

/**
 * @brief 在某一侧分屏打开一个会话（拖到中栏、菜单"Open in split view"）：已在某一栏的只切焦点；中栏没有会话时单栏打开；
 *        单栏时与原来的会话并排；分屏时换掉这一侧那一栏。打开的那一栏得到焦点。
 */
export function placeInSplit(state: AppState, key: string, side: Side): Pick<AppState, 'activeKey' | 'split'> {
  const shown = shownKeys(state);
  if (shown.includes(key)) return { activeKey: key, split: state.split };
  const current = state.activeKey && state.tabs.some((tab) => tab.key === state.activeKey) ? state.activeKey : null;
  if (!current) return { activeKey: key, split: null };
  if (!state.split) return { activeKey: key, split: side === 'left' ? [key, current] : [current, key] };
  return { activeKey: key, split: side === 'left' ? [key, state.split[1]] : [state.split[0], key] };
}

/** @brief 在某一侧分屏打开一个已在界面里的会话。 */
export function openInSplit(key: string, side: Side): void {
  guardLeave(() => {
    recordAction(`Open in split view on the ${side}`);
    useApp.setState((state) => ({ ...placeInSplit(state, key, side), ...seen(state, key), view: 'chat' }));
  });
}

/** @brief 焦点切到某一栏（你在这一栏里按下鼠标或焦点进入它）；它不在中栏或已有焦点时不变。 */
export function focusPane(key: string): void {
  const state = useApp.getState();
  if (state.activeKey === key || !shownKeys(state).includes(key)) return;
  useApp.setState({ activeKey: key, ...seen(state, key) });
}

/** @brief 关闭分屏里的一栏：回到单栏，另一栏得到焦点；关掉的会话照常开在后台，不发任何命令。 */
export function closePane(key: string): void {
  const { split } = useApp.getState();
  if (!split?.includes(key)) return;
  recordAction('Close pane');
  const other = split[0] === key ? split[1] : split[0];
  useApp.setState({ split: null, activeKey: other });
}

/**
 * @brief 会话从界面里去掉（归档、删除）之后中栏的样子：它在分屏里时这一栏关闭，另一栏得到焦点；
 *        它是单栏里的会话时中栏没有会话。
 */
export function withoutPane(state: AppState, key: string): Pick<AppState, 'activeKey' | 'split'> {
  if (state.split?.includes(key)) {
    return { split: null, activeKey: state.split[0] === key ? state.split[1] : state.split[0] };
  }
  return { split: state.split, activeKey: state.activeKey === key ? null : state.activeKey };
}

/** 等刚关掉的菜单从浮层栈里退出最多等几帧（菜单关闭后它的登记要到下一次提交之后才去掉） */
const FOCUS_RETRY_FRAMES = 5;

/**
 * @brief 把焦点放进某一栏的输入框（不传时是焦点所在的那一栏）。还有浮层开着时（例如刚弹出的询问框）不动焦点：
 *        先等几帧让刚关掉的菜单退出浮层栈，仍有浮层就放弃。
 */
export function focusComposer(key?: string, frames = FOCUS_RETRY_FRAMES): void {
  requestAnimationFrame(() => {
    if (hasOverlay()) {
      if (frames > 0) focusComposer(key, frames - 1);
      return;
    }
    const slot = key ? `.pane-slot[data-tab="${CSS.escape(key)}"]` : '.pane-slot[data-focused="true"]';
    document.querySelector<HTMLElement>(`${slot}:not([hidden]) .composer textarea`)?.focus();
  });
}
