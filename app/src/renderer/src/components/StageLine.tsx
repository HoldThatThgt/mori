// 阶段行：全部由 pi 事件推出（见 docs/v0/screens/chat.md），本轮结束后隐藏。

import type { Transcript } from '../state/model';
import { seconds, useNow } from './ToolCard';
import { toolTitleText } from './toolTitle';

/** @brief 阶段文字；没有阶段时为 null。 */
export function stageText(transcript: Transcript, cwd: string, now: number): string | null {
  const stage = transcript.stage;
  if (!stage || !transcript.running) return null;
  const elapsed = seconds(Math.max(0, now - stage.since)).replace(/\.\d+s$/, 's');
  switch (stage.kind) {
    case 'waiting':
      return `等待模型响应 ${elapsed}`;
    case 'thinking':
      return `思考中 ${elapsed}`;
    case 'generating':
      return '生成中';
    case 'tool': {
      const tool = transcript.tools[stage.detail];
      return tool ? `${toolTitleText(tool, cwd)} ${elapsed}` : null;
    }
    case 'approval':
      return '等你批准';
    case 'retry':
      return `重试 ${stage.detail}`;
    case 'compacting':
      return '正在压缩较早的对话';
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
