// 模型菜单里的 Task mode 一行（docs/specs/parallel-agents-taskboard.md §13.1；docs/v1/screens/team-switch.md）：
// 2026-10-26 负责人走查 M10、M21 起取代顶栏的协作开关。role="menuitemcheckbox"，点击、Enter、Space 不需要确认：
// off → always，always → off（还不能回到 off 时 once），once → always；菜单不关，焦点留在这一行。切换中不可用但仍能
// 停焦点（aria-disabled，同模型按钮的 data-pending：变成真正的 disabled 时焦点会掉到 body，↑ ↓ 和 Space 都不再起作用）；
// 会话按 agents_invalid 拒绝启动时不可用（disabled）；回复进行中照常可用（只影响之后的消息）。切换失败的一行也在这里：
// 菜单开着时在这一行下面（TeamErrorNote），关着时从输入框下面一行往上弹出（TeamErrorLine，同换范围失败）。

import { useId, useRef } from 'react';
import { roleLabel, type TeamState } from '../../../shared/team';
import { toggleTeam, useTeamError, useTeamPending } from '../state/teamActions';
import type { Tab } from '../state/store';
import { useRowPlacement } from './rowMenu';

/** @brief 打开时这一行的第二行（§13.1）；关闭时没有。<create role> 取立项持有者，基座显示 Mori。 */
function switchHint(team: TeamState): string | null {
  switch (team.mode) {
    case 'off': return null;
    case 'always': return `Messages go to ${roleLabel(team.holders.create)} first`;
    case 'once': return 'Until done · Ends when open requests are done';
  }
}

/** @brief 切换失败那一行的文字（§13.1）。 */
function errorText(message: string): string {
  return `Couldn’t change task mode: ${message}`;
}

/**
 * @brief 模型菜单里的 Task mode 一行：名字和第二行在左，开关的样子在右（同 Customize 的开关，不另算控件）。
 *        切换中带 aria-disabled 与 data-pending、样子不变，点击、Enter、Space 不起作用，焦点留在这一行。
 */
export function TeamSwitch({ tab }: { tab: Tab }) {
  const pending = useTeamPending((state) => Boolean(state[tab.key]));
  const hintId = useId();
  const { mode } = tab.team;
  const hint = switchHint(tab.team);
  const invalid = tab.blocked?.kind === 'agents_invalid';
  return (
    <button role="menuitemcheckbox" aria-checked={mode !== 'off'} className="task-mode-item" data-testid="team-switch"
      data-mode={mode} aria-label="Task mode" aria-describedby={hint ? hintId : undefined}
      aria-disabled={pending || undefined} data-pending={pending ? 'true' : undefined} disabled={invalid}
      onClick={() => { if (!pending) toggleTeam(tab.key); }}>
      <span className="task-mode-text">
        <span>Task mode</span>
        {hint && <span id={hintId} className="task-mode-hint" data-testid="team-hint">{hint}</span>}
      </span>
      <span className="tools-switch" aria-hidden="true"><span className="tools-switch-knob" /></span>
    </button>
  );
}

/** @brief 菜单开着时切换失败的一行（role="alert"），在 Task mode 一行下面。 */
export function TeamErrorNote({ tab }: { tab: Tab }) {
  const message = useTeamError((state) => state[tab.key]);
  if (!message) return null;
  return <p className="menu-note team-error" role="alert" data-testid="team-error">{errorText(message)}</p>;
}

/**
 * @brief 菜单关着时切换失败的一行（role="alert"，例如 /task on 失败）：从输入框下面一行往上弹出、右边对齐模型按钮，
 *        放不下时挪进这一行（同换范围失败，ModelMenu.tsx PickError）。下次切换或 10 秒后消失（teamActions.ts）。
 * @param button 模型按钮
 */
export function TeamErrorLine({ tab, button }: { tab: Tab; button: React.RefObject<HTMLButtonElement | null> }) {
  const message = useTeamError((state) => state[tab.key]);
  const line = useRef<HTMLDivElement>(null);
  useRowPlacement(Boolean(message), button, line, 'anchor', message);
  if (!message) return null;
  return <div ref={line} className="pick-error" role="alert" data-testid="team-error">{errorText(message)}</div>;
}
