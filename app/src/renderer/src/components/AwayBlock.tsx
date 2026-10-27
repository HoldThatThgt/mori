// 一轮末尾的 "Decided while you were away"（docs/specs/file-system-permissions.md §9.9，状态表 docs/v1/screens/fs-question.md
// "一轮末尾"）：按 mori.away_decision（实时的事件、重新打开时的会话条目）由程序生成，不靠模型。标题、说明行
// （You didn’t answer within <时长>, so Mori decided these.），每条记录一行，按时间先后：批准 Denied · <工具卡标题>
// （后台实例的开头加 <role> · T1），提问每个问题一行 Recommended · <header>: <label>，扩展询问 Cancelled · Extension: <title>；
// 右边是时间 HH:MM。读屏名里 " · " 换成逗号。不进选区引用（data-no-quote），也不进导出与会话引用。

import type { AwayDecision } from '../../../shared/workspace';
import { awayRows, type AwayBlock as AwayBlockData, type AwayRow } from '../state/away';
import { newTool } from '../state/model';
import { toolTitleText } from './toolTitle';

/** @brief 批准记录的工具卡标题（同 toolTitle：Run <命令>、Edit <路径>、<服务> · <工具> 等），按记录里截短过的参数算。 */
function approvalTitle(decision: AwayDecision, cwd: string): string {
  const tool = { ...newTool(decision.toolCallId ?? decision.requestId, decision.toolName ?? ''),
    args: decision.args ?? {} };
  return toolTitleText(tool, cwd);
}

/** @brief 一行：归属（后台实例）· 结果 · 内容，右边时间。 */
function Row({ row, cwd }: { row: AwayRow; cwd: string }) {
  const text = row.text ?? approvalTitle(row.decision, cwd);
  const shown = [row.owner, row.result, text].filter((part): part is string => Boolean(part)).join(' · ');
  return (
    <li className="away-row" data-testid="away-row" data-kind={row.decision.kind}
      data-request={row.decision.requestId} aria-label={`${shown}, ${row.time}`.replaceAll(' · ', ', ')}>
      <span className="away-row-text" aria-hidden="true">{shown}</span>
      <span className="away-row-time" aria-hidden="true">{row.time}</span>
    </li>
  );
}

/** @brief 一轮末尾的那一块；block 由 away.ts 的 awayBlocks 按轮归好。 */
export function AwayBlock({ block, cwd }: { block: AwayBlockData; cwd: string }) {
  return (
    <div className="away-block" role="group" aria-label="Decided while you were away" data-testid="away-block"
      data-no-quote>
      <div className="away-block-title">Decided while you were away</div>
      <p className="away-block-note">{block.note}</p>
      <ul className="away-rows">
        {awayRows(block).map((row) => <Row key={row.key} row={row} cwd={cwd} />)}
      </ul>
    </div>
  );
}
