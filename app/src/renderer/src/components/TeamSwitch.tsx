// 顶栏的协作开关（docs/specs/parallel-agents-taskboard.md §13.1；docs/v1/screens/team-switch.md）：模型、思考强度、
// 权限按钮之前一个 role="switch" 的按钮，点击不需要确认：off → always，always → off（还不能回到 off 时 once），
// once → always。界面没准备好、会话按 agents_invalid 拒绝启动、切换中不可用；运行中可以点（只影响之后的消息）。
// 窄栏（这一栏不宽于 860px）只显示状态点（team.css），读屏名称和悬停仍是完整文字。

import { roleLabel, type TeamMode, type TeamState } from '../../../shared/team';
import { toggleTeam, useTeamError, useTeamPending } from '../state/teamActions';
import type { Tab } from '../state/store';

/** @brief 开关上的文字（§13.1）。 */
const SWITCH_TEXT: Readonly<Record<TeamMode, string>> = {
  off: 'Team: Off', always: 'Team: On', once: 'Team: Until done',
};

/** @brief 开关的悬停说明（§13.1）；<create role> 取立项持有者，基座显示 Mori。 */
function switchHint(team: TeamState): string {
  switch (team.mode) {
    case 'off': return 'Turn on team mode';
    case 'always': return `Messages go to ${roleLabel(team.holders.create)} first`;
    case 'once': return 'Team mode ends when open requests are done';
  }
}

/**
 * @brief 顶栏的协作开关与切换失败的一行。
 * @param disabled 界面没准备好（会话在打开、后台进程通道没接上或已退出）
 */
export function TeamSwitch({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const pending = useTeamPending((state) => Boolean(state[tab.key]));
  const error = useTeamError((state) => state[tab.key]);
  const { mode } = tab.team;
  const invalid = tab.blocked?.kind === 'agents_invalid';
  const text = SWITCH_TEXT[mode];
  return (
    <div className="team-switch-wrap">
      <button className="team-switch" role="switch" aria-checked={mode !== 'off'} data-testid="team-switch"
        data-mode={mode} aria-label={text} title={switchHint(tab.team)} disabled={disabled || invalid || pending}
        onClick={() => toggleTeam(tab.key)}>
        <span className="team-text">{text}</span>
        <span className="team-dot" aria-hidden="true" />
      </button>
      {error && <div className="team-error" role="alert" data-testid="team-error">
        Couldn’t change team mode: {error}</div>}
    </div>
  );
}
