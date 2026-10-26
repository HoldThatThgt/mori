// 拒绝启动卡（docs/v1/screens/model-chat.md "拒绝启动卡"，规格 §4.6）：会话的静态校验没通过时显示在输入框上方，
// 文字按 blocked.kind，按钮只按 blocked.actions 出现（顺序同状态表）；blocked 变为 null 时卡消失、发送恢复。
// 角色文件有错（agents_invalid，docs/specs/parallel-agents-taskboard.md §4.4、§13.9）时逐条列出问题，操作 Check again。

import { useState } from 'react';
import type { BlockedAction, ModelBlocked } from '../../../shared/models';
import { checkAgents, openRangeMenu, turnOffTeam, verifyNow } from '../state/modelActions';
import { openModelsSettings } from '../state/settings';
import type { Tab } from '../state/store';
import { CandidateList } from './UnavailableCard';

/** 会话不空闲时 Check again 的悬停说明（临时，docs/v1/screens/team-blocked.md） */
const CHECK_BUSY_TITLE = 'Available when nothing is running in this session';

/** 按钮的顺序（同状态表） */
const ACTION_ORDER: readonly BlockedAction[] = [
  'check_agents', 'verify', 'change_model', 'turn_off_team', 'open_settings',
];

/** @brief 卡片的主文字与第二行（没有时为 null）。 */
function cardText(blocked: ModelBlocked, pick: string | null): { title: string; note: string | null } {
  switch (blocked.kind) {
    case 'verifying': {
      // 第一个正在验证的候选；后台进程把它也写在 detail 里。
      const probing = blocked.candidates.find((candidate) => candidate.reason === 'probing')?.ref ?? blocked.detail;
      return { title: `Verifying ${probing}…`, note: null };
    }
    case 'no_candidate':
      return { title: 'This session can’t start: no model fits.', note: null };
    case 'no_pick':
      return { title: 'No default model range; pick one.', note: null };
    case 'pick_missing':
      return { title: `${blocked.detail || pick || ''} is not in your model settings.`,
        note: 'Used by this session’s model range.' };
    case 'project_config':
      return { title: `.mori/models.json: ${blocked.detail}`, note: null };
    case 'config_invalid':
      return { title: `Model settings can’t be read: ${blocked.detail}`, note: null };
    case 'agents_invalid':
      return { title: 'Fix the agent files', note: null };
  }
}

/** @brief 一个操作按钮的文字。 */
function actionLabel(action: BlockedAction): string {
  switch (action) {
    case 'verify': return 'Verify now';
    case 'change_model': return 'Change model…';
    case 'open_settings': return 'Open settings';
    case 'check_agents': return 'Check again';
    case 'turn_off_team': return 'Turn off team mode';
  }
}

/**
 * @brief 点了一个操作：Verify now 探测还没验证的候选；Change model 打开这一栏的范围菜单；
 *        Open settings 打开 设置 → Models 的顶部；Check again 重新读角色文件；Turn off team mode 关掉协作模式。
 * @return Verify now、Check again、Turn off team mode 失败时的原文；其余为 null
 */
async function runAction(action: BlockedAction, blocked: ModelBlocked, tab: Tab): Promise<string | null> {
  switch (action) {
    case 'verify': return verifyNow(blocked.verifyRefs);
    case 'change_model': openRangeMenu(tab.key); return null;
    case 'open_settings': openModelsSettings(); return null;
    case 'check_agents': return checkAgents(tab.key);
    case 'turn_off_team': return turnOffTeam(tab.key);
  }
}

/** @brief 拒绝启动卡；会话可以发送时不显示。 */
export function BlockedCard({ tab }: { tab: Tab }) {
  const blocked = tab.blocked;
  if (!blocked) return null;
  // 卡片换了一种拒绝原因（或消失后再出现）时重新挂载，清掉上一次 Verify now 的错误。
  return <BlockedCardBody key={`${blocked.kind}:${blocked.detail}`} tab={tab} blocked={blocked} />;
}

/** @brief 拒绝启动卡的内容；Verify now 的错误（problem）只属于当前这一种拒绝原因。 */
function BlockedCardBody({ tab, blocked }: { tab: Tab; blocked: ModelBlocked }) {
  const [problem, setProblem] = useState<string | null>(null);
  const { title, note } = cardText(blocked, tab.pick);
  // Check again 只在会话空闲时可用（§4.4）：对话没在回复或准备中，后台也没有 Agent 在运行或排队。
  const busy = tab.transcript.running || tab.transcript.sending || tab.team.background;
  const actions = ACTION_ORDER.filter((action) => blocked.actions.includes(action));
  // verifying 只写第一个正在验证的候选，不列其他候选（状态表）。
  const candidates = blocked.kind === 'verifying' ? [] : blocked.candidates;
  return (
    <div className="model-card blocked-card" role="status" data-testid="blocked-card" data-kind={blocked.kind}>
      <div className="model-card-title">{title}</div>
      {note && <div className="model-card-note">{note}</div>}
      <CandidateList candidates={candidates} />
      {blocked.kind === 'agents_invalid' && (
        <ul className="candidate-list">
          {blocked.problems.map((line, index) => <li key={index} data-testid="agent-problem">{line}</li>)}
        </ul>
      )}
      {problem && <div className="model-card-problem" role="alert">{problem}</div>}
      {actions.length > 0 && (
        <div className="model-card-actions">
          {actions.map((action) => {
            const unavailable = action === 'check_agents' && busy;
            return (
              <button key={action} className="button compact" data-action={action.replaceAll('_', '-')}
                disabled={unavailable} title={unavailable ? CHECK_BUSY_TITLE : undefined}
                onClick={() => { setProblem(null); void runAction(action, blocked, tab).then(setProblem); }}>
                {actionLabel(action)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
