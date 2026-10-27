// 阶段行：由 pi 事件推出（见 docs/v0/screens/chat.md），本轮结束后隐藏。模型层的等待（等模型、等它停下、重建、排队、
// 原地重试，docs/v1/screens/model-chat.md "阶段行"）进行时取代"Waiting for the model…"，准备中也显示。
// 协作（docs/v1/screens/team-stop.md "阶段行"）：分开时立项判断你刚发的消息、对话还没在运行时显示
// "<create role> is deciding… · 4s"；后台实例的批准卡不改变阶段行。
// 文件系统（docs/specs/file-system-permissions.md §9.9）：提问卡（ask_user_question）挂着时同扩展询问，Waiting for your answer。
// 运行开始的快照（docs/specs/file-system.md §4.5、§13）是模型层等待的一种（ModelStage kind snapshot，mori.snapshot_stage），
// 显示 Taking a snapshot… · <秒数>、data-kind="snapshot"，agent_start 时清掉（state/transcript.ts）。
// 建 worktree 中（docs/specs/file-system.md §11.5.6，ModelStage kind worktree）显示 Creating worktree…，不带秒数，
// data-kind="worktree"；session.prompt 返回时清掉，之后到的模型层等待照常取代它。

import { roleLabel } from '../../../shared/team';
import { pendingPrompt, type Transcript } from '../state/model';
import { seconds, useNow } from './ToolCard';
import { toolTitleText } from './toolTitle';

/** @brief 已经过的秒数，写作 "12s"。 */
function elapsedText(since: number, now: number): string {
  return seconds(Math.max(0, now - since)).replace(/\.\d+s$/, 's');
}

/** @brief 模型层的等待是否显示：本轮运行中或准备中（§9.3），且没有挂起的批准与询问（扩展询问、提问卡）。 */
function modelStageShown(transcript: Transcript): boolean {
  const busy = transcript.running || transcript.sending;
  return busy && transcript.modelStage !== null && transcript.approvals.length === 0
    && transcript.questions.length === 0;
}

/**
 * @brief 立项判断你刚发的消息时的阶段行（平行 Agent 规格 §13.6）：对话还没在运行、准备中先显示的那条在待判断队列里；
 *        秒数从开始判断起算，立项在忙别的回合（since 为 null）时不带秒数。不显示时为 null。
 */
function decidingText(transcript: Transcript, now: number): string | null {
  const { deciding } = transcript;
  const pending = pendingPrompt(transcript);
  if (transcript.running || !deciding || !pending) return null;
  if (!deciding.queue.some((message) => message.text === pending.text)) return null;
  const head = `${roleLabel(deciding.role)} is deciding…`;
  return deciding.since === null ? head : `${head} · ${elapsedText(deciding.since, now)}`;
}

/** @brief 模型层的等待是否带秒数：建 worktree 中（kind worktree）不带。 */
function timedStage(transcript: Transcript): boolean {
  return transcript.modelStage !== null && transcript.modelStage.kind !== 'worktree';
}

/**
 * @brief 阶段文字；没有阶段时为 null。有挂起的批准时总是"Waiting for your approval"，其次有挂起的扩展询问或提问卡时
 *        "Waiting for your answer"，都不显示"Responding…"或工具的"<标题> Ns"。模型层的等待写作"<文字> · 12s"，
 *        从这次等待开始计时；建 worktree 中只有"Creating worktree…"。
 * @param seatRoles 工具标题里 agent_message 的 Message / Ask（toolTitle）
 */
export function stageText(transcript: Transcript, cwd: string, now: number,
  seatRoles: readonly string[] = []): string | null {
  const stage = transcript.stage;
  if (transcript.running && transcript.approvals.length > 0) return 'Waiting for your approval';
  // 扩展命令等不经过一轮运行的询问也要看得到；提问卡同样（询问卡队列，state/asks.ts）。
  if (transcript.questions.length > 0) return 'Waiting for your answer';
  const model = transcript.modelStage;
  if (model && modelStageShown(transcript)) {
    return timedStage(transcript) ? `${model.text} · ${elapsedText(model.since, now)}` : model.text;
  }
  const deciding = decidingText(transcript, now);
  if (deciding) return deciding;
  if (!transcript.running) return null;
  if (!stage) return null;
  const elapsed = elapsedText(stage.since, now);
  switch (stage.kind) {
    case 'waiting':
      return `Waiting for the model… ${elapsed}`;
    case 'thinking':
      return `Thinking… ${elapsed}`;
    case 'generating':
      return 'Responding…';
    case 'tool': {
      const tool = transcript.tools[stage.detail];
      return tool ? `${toolTitleText(tool, cwd, seatRoles)} ${elapsed}` : null;
    }
    case 'approval':
      return 'Waiting for your approval';
    case 'compacting':
      return 'Compacting session…';
  }
}

/**
 * @brief 阶段行；模型层的等待带 data-kind（wait-model、held、rebuild、queue、retry，运行开始的快照为 snapshot，
 *        建 worktree 中为 worktree），立项判断时为 deciding。只有不带秒数的阶段时不按秒重画。
 */
export function StageLine({ transcript, cwd, seatRoles }: { transcript: Transcript; cwd: string;
  seatRoles: readonly string[] }) {
  const busy = transcript.running || transcript.sending;
  const now = useNow(busy && (transcript.stage !== null || timedStage(transcript)
    || transcript.deciding !== null));
  const text = stageText(transcript, cwd, now, seatRoles);
  if (!text) return null;
  const deciding = text === decidingText(transcript, now);
  const kind = modelStageShown(transcript) ? transcript.modelStage?.kind : deciding ? 'deciding' : undefined;
  return (
    <div className="stage-line" data-testid="stage" data-kind={kind} aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="stage-text">{text}</span>
    </div>
  );
}
