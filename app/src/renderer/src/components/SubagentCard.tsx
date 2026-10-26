// subagent 工具卡（docs/v1/screens/subagent-card.md，规格 docs/specs/subagent.md §7）：标题照 Claude 桌面版
// （Running 3 agents、Ran 3 agents），每个 subagent 一行，点一行看 Agent prompt 与 Response。执行中自动展开，
// 这次调用结束时自动收起一次；没有 v0 工具卡的 Input、Output 两段。文字由 subagentView.ts 给出。

import { memo, useEffect, useRef, useState } from 'react';
import type { ToolCall } from '../state/model';
import { subagentActive, subagentCardTitle, subagentRows, subagentStatus, type SubagentCardRow } from './subagentView';
import { useNow } from './ToolCard';

/** @brief 一个 subagent 一行；点它展开 Agent prompt 与 Response。 */
function SubagentRowView({ row }: { row: SubagentCardRow }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={`subagent-row phase-${row.phase}`} data-testid="subagent-row" data-index={row.index}
      data-phase={row.phase} data-role={row.role} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary data-no-quote>
        <span className="subagent-label" data-testid="subagent-label">{row.label}</span>
        <span className="subagent-state" data-testid="subagent-state" title={row.stateTitle}>{row.state}</span>
      </summary>
      {open && (
        <div className="subagent-body">
          <div className="tool-section-label">Agent prompt</div>
          <pre className="tool-pre" data-testid="subagent-prompt">{row.prompt}</pre>
          {row.response !== null && (
            <><div className="tool-section-label">Response</div>
              <pre className="tool-pre" data-testid="subagent-response">{row.response}</pre></>
          )}
        </div>
      )}
    </details>
  );
}

/**
 * @brief subagent 的工具卡：执行中展开（看得到每一行），结束时收起一次，之后你可以再展开；重新打开会话时是收起的。
 * @param tool 这次调用
 * @param cwd 工作目录
 */
export const SubagentCard = memo(function SubagentCard({ tool, cwd }: { tool: ToolCall; cwd: string }) {
  const active = subagentActive(tool);
  const now = useNow(tool.status === 'running');
  const [open, setOpen] = useState(active);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active !== wasActive.current) setOpen(active);
    wasActive.current = active;
  }, [active]);
  return (
    <details className={`tool-card subagent-card status-${tool.status}`} data-testid="tool-card" data-tool="subagent"
      data-status={tool.status} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary data-no-quote>
        <span className="tool-title"><span className="tool-verb">{subagentCardTitle(tool)}</span></span>
        <span className="tool-status" data-testid="tool-status">{subagentStatus(tool, now)}</span>
      </summary>
      {open && (
        <div className="subagent-rows">
          {subagentRows(tool, cwd).map((row) => <SubagentRowView key={row.index} row={row} />)}
        </div>
      )}
    </details>
  );
});
