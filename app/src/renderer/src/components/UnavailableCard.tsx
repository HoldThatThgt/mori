// No model available 卡（docs/v1/screens/model-chat.md）：候选耗尽、没等到时对话流里的一张说明卡，
// 每个候选一行"<provider>/<model> — <原因>"；"Open settings"打开 设置 → Models，落在第一个被排除候选的提供商卡上。

import type { CandidateExclusion } from '../../../shared/models';
import { candidateLine } from '../state/model';
import { openModelsSettings } from '../state/settings';

/** @brief 说明卡与拒绝启动卡里的候选列表。 */
export function CandidateList({ candidates }: { candidates: CandidateExclusion[] }) {
  if (candidates.length === 0) return null;
  return (
    <ul className="candidate-list">
      {candidates.map((candidate) => (
        <li key={candidate.ref} data-testid="candidate" data-ref={candidate.ref} data-reason={candidate.reason}>
          {candidateLine(candidate)}
        </li>
      ))}
    </ul>
  );
}

/**
 * @brief "Open settings"：设置 → Models，滚到第一个被排除候选的提供商卡；原因是 auth、quota（key 的问题）时焦点在它的 Keys。
 */
function openFor(candidates: CandidateExclusion[]): void {
  const first = candidates[0];
  if (!first) {
    openModelsSettings();
    return;
  }
  const keyProblem = first.reason === 'auth' || first.reason === 'quota';
  const providerId = first.ref.slice(0, first.ref.indexOf('/'));
  openModelsSettings(keyProblem ? { providerId, focus: 'keys' } : { providerId });
}

/** @brief No model available 卡。 */
export function UnavailableCard({ candidates }: { candidates: CandidateExclusion[] }) {
  return (
    <div className="model-card unavailable-card" role="alert" data-testid="unavailable-card">
      <div className="model-card-title">No model available</div>
      <CandidateList candidates={candidates} />
      <div className="model-card-actions">
        <button className="button compact" data-action="open-settings" onClick={() => openFor(candidates)}>
          Open settings</button>
      </div>
    </div>
  );
}
