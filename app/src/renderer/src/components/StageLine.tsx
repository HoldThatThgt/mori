// 阶段行：全部由 pi 事件推出（见 docs/v0/screens/chat.md），本轮结束后隐藏。

import type { Transcript } from '../state/model';
import { seconds, useNow } from './ToolCard';
import { toolTitleText } from './toolTitle';

/**
 * @brief 阶段文字；没有阶段时为 null。有挂起的批准时总是"Waiting for your approval"，其次有挂起的扩展询问时
 *        "Waiting for your answer"，都不显示"Responding…"或工具的"<标题> Ns"。
 */
export function stageText(transcript: Transcript, cwd: string, now: number): string | null {
  const stage = transcript.stage;
  if (transcript.running && transcript.approvals.length > 0) return 'Waiting for your approval';
  // 扩展命令等不经过一轮运行的询问也要看得到。
  if (transcript.questions.length > 0) return 'Waiting for your answer';
  if (!transcript.running) return null;
  if (!stage) return null;
  const elapsed = seconds(Math.max(0, now - stage.since)).replace(/\.\d+s$/, 's');
  switch (stage.kind) {
    case 'waiting':
      return `Waiting for the model… ${elapsed}`;
    case 'thinking':
      return `Thinking… ${elapsed}`;
    case 'generating':
      return 'Responding…';
    case 'tool': {
      const tool = transcript.tools[stage.detail];
      return tool ? `${toolTitleText(tool, cwd)} ${elapsed}` : null;
    }
    case 'approval':
      return 'Waiting for your approval';
    case 'retry':
      return `Retrying ${stage.detail}`;
    case 'compacting':
      return 'Compacting session…';
  }
}

/** @brief 阶段行。 */
export function StageLine({ transcript, cwd }: { transcript: Transcript; cwd: string }) {
  const now = useNow(transcript.running && transcript.stage !== null);
  const text = stageText(transcript, cwd, now);
  if (!text) return null;
  return (
    <div className="stage-line" data-testid="stage" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="stage-text">{text}</span>
    </div>
  );
}
