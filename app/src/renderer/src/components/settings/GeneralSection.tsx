// 设置页的 General（docs/specs/file-system-permissions.md §9.6，状态表 docs/v1/screens/fs-question.md "设置页"）：只有一行
// When you’re away，右边下拉四项（60 seconds / 5 minutes / 10 minutes / Never），下面是说明；值由后台进程存在
// <userData>/away.json（away.get / away.set，state/settings.ts）。读不出时下拉显示 5 minutes，下面一行 Couldn’t read the
// setting: <原文>；保存失败时下拉回到原来的值，下面一行 Couldn’t save: <原文>。

import { useEffect, useId } from 'react';
import {
  AWAY_DURATION_TEXT, AWAY_TIMEOUTS, DEFAULT_AWAY_TIMEOUT, type AwayTimeout,
} from '../../../../shared/workspace';
import { loadAway, setAwayTimeout, useSettings } from '../../state/settings';
import '../../styles/models-settings.css';

/** @brief 下拉里每一项的文字。 */
function timeoutText(timeout: AwayTimeout): string {
  return timeout === 'never' ? 'Never' : AWAY_DURATION_TEXT[timeout];
}

/** 下拉下面的说明（fs-question.md "设置页"） */
const AWAY_NOTE = 'When a permission request or question is waiting and Mori isn’t the active window, Mori answers it '
  + 'after this long: it denies permission requests, uses the recommended option for questions, and cancels '
  + 'extension prompts. The agent is told, and the turn lists what was decided.';

/** @brief General 一节：每次换到这一节时读一次设置；选一项立即保存（保存中再选不发命令）。 */
export function GeneralSection() {
  const away = useSettings((state) => state.away);
  const id = useId();
  const noteId = useId();
  useEffect(() => {
    void loadAway();
  }, []);
  return (
    <div className="settings-section" data-section="general">
      <h2>General</h2>
      <div className="mf-grid">
        <div className="mf-row">
          <label htmlFor={id}>When you’re away</label>
          <select id={id} data-testid="away-timeout" value={away.timeout ?? DEFAULT_AWAY_TIMEOUT}
            aria-describedby={noteId} onChange={(event) => void setAwayTimeout(event.target.value as AwayTimeout)}>
            {AWAY_TIMEOUTS.map((timeout) => <option key={timeout} value={timeout}>{timeoutText(timeout)}</option>)}
          </select>
        </div>
        <p id={noteId} className="field-hint">{AWAY_NOTE}</p>
        {away.problem && <p className="form-message error" role="alert">{away.problem}</p>}
      </div>
    </div>
  );
}
