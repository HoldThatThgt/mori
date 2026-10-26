// subagent 工具卡要显示的文字（docs/v1/screens/subagent-card.md，规格 docs/specs/subagent.md §7.1、§7.2）：卡片的标题、
// 右边的状态、每个 subagent 一行的标签与状态、展开一行后的 Agent prompt 与 Response。纯函数：输入是对话流里这次调用的
// ToolCall（参数、状态、details），时刻由调用方给出。

import {
  endedCount, failureText, phaseEnded, streamingDescriptions, subagentArgRows, subagentTitle, toolUsesText,
  type SubagentRow, type SubagentTitleForm,
} from '../../../shared/subagent';
import { BASE_ROLE, roleLabel, toolCallTitle } from '../../../shared/team';
import type { ToolCall, ToolStatus } from '../state/model';

/** 卡片还没结束的几种状态（准备中、排队、执行中；等批准不会出现在 subagent 这个调用本身上） */
const ACTIVE: readonly ToolStatus[] = ['preparing', 'queued', 'awaiting', 'running'];

/** @brief 这次调用还没结束。 */
export function subagentActive(tool: ToolCall): boolean {
  return ACTIVE.includes(tool.status);
}

/** @brief 卡片上的一行（状态表“每个 subagent 一行”）。 */
export interface SubagentCardRow {
  /** 从 1 起的序号（data-index） */
  index: number;
  /** `<description>`[ · <Role>][ · Read-only][ · <k> tool uses] */
  label: string;
  /** 右边的状态文字；还没有进展时为空 */
  state: string;
  /** 状态的悬停文字（失败原因的全文）；没有时为 undefined */
  stateTitle: string | undefined;
  /** data-phase：SubagentRow.phase；卡片中断、停止时没结束的为 interrupted、stopped；还没有进展时为 pending */
  phase: string;
  /** 角色名（data-role） */
  role: string;
  /** Agent prompt 一段 */
  prompt: string;
  /** Response 一段；还没结束时为 null */
  response: string | null;
}

/** @brief 参数里 tasks 的项数（参数还在流入时为已收到的项数）；取不出时为 null（§7.1）。 */
function taskCount(tool: ToolCall): number | null {
  const rows = tool.args ? subagentArgRows(tool.args) : null;
  if (rows) return rows.length;
  const streaming = streamingDescriptions(tool.argsText).length;
  return streaming > 0 ? streaming : null;
}

/** @brief 标题的写法：进行中 running；结束而开过 subagent（有 details）ran，没开过 run（§7.1）。 */
function titleForm(tool: ToolCall): SubagentTitleForm {
  if (subagentActive(tool)) return 'running';
  return tool.subagent ? 'ran' : 'run';
}

/** @brief 卡片标题：Running 3 agents / Ran 3 agents / Run 3 agents（项数取 details，其次是参数，§7.1）。 */
export function subagentCardTitle(tool: ToolCall): string {
  return subagentTitle(titleForm(tool), tool.subagent?.agents.length ?? taskCount(tool));
}

/** @brief 秒数文字（同 v0 工具卡）。 */
function secondsText(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(ms / 1000)}s`;
}

/** @brief 结束了的卡片的状态：有 details 时按每一行；没有时是被拒绝（Failed · <原因第一行>）或开始前被停止。 */
function endedStatus(tool: ToolCall): string {
  const rows = tool.subagent?.agents;
  if (!rows) {
    if (tool.status === 'stopped' || tool.status === 'rejected') return 'Stopped';
    const first = tool.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return tool.status === 'done' ? 'Done' : ['Failed', first].filter(Boolean).join(' · ');
  }
  if (rows.some((row) => row.phase === 'stopped')) return 'Stopped';
  if (rows.every((row) => row.phase === 'failed')) return 'Failed';
  const failed = rows.filter((row) => row.phase !== 'done').length;
  return ['Done', ...(failed > 0 ? [`${failed} failed`] : []),
    ...(tool.durationMs !== null ? [secondsText(tool.durationMs)] : [])].join(' · ');
}

/**
 * @brief 卡片右边的状态（§7.1）：Preparing… / Queued / <d> of <n> done · <秒数> / Done · … / Failed / Stopped / Interrupted。
 * @param tool 这次调用
 * @param now 此刻（ms）
 */
export function subagentStatus(tool: ToolCall, now: number): string {
  switch (tool.status) {
    case 'preparing': return 'Preparing…';
    case 'queued': return 'Queued';
    case 'awaiting':
    case 'running': {
      const rows = tool.subagent?.agents ?? [];
      const total = rows.length || (taskCount(tool) ?? 0);
      const elapsed = tool.startedAt === null ? '' : ` · ${secondsText(Math.max(0, now - tool.startedAt))}`;
      return `${endedCount(rows)} of ${total} done${elapsed}`;
    }
    case 'interrupted': return 'Interrupted';
    default: return endedStatus(tool);
  }
}

/** @brief 一行的标签：description，不是基座时 · <Role>，只读时 · Read-only，用过工具时 · <k> tool uses（§7.2）。 */
function rowLabel(row: Pick<SubagentRow, 'description' | 'role' | 'readOnly' | 'toolUses'>): string {
  return [row.description, ...(row.role === BASE_ROLE ? [] : [roleLabel(row.role)]),
    ...(row.readOnly ? ['Read-only'] : []), ...(row.toolUses > 0 ? [toolUsesText(row.toolUses)] : [])].join(' · ');
}

/** @brief 有 details 的一行的状态文字（§7.2 的表）。 */
function liveState(row: SubagentRow, cwd: string): { text: string; title: string | undefined } {
  switch (row.phase) {
    case 'approval': return { text: 'Waiting for your approval', title: undefined };
    case 'starting':
    case 'running': {
      if (row.note) return { text: row.note, title: undefined };
      if (!row.current) return { text: 'Starting', title: undefined };
      return { text: toolCallTitle(row.current.toolName, row.current.args, { cwd, seatRoles: [], task: null }),
        title: undefined };
    }
    case 'done': return { text: 'Done', title: undefined };
    case 'failed': return { text: `Failed · ${failureText(row.error ?? '')}`, title: `Failed · ${row.error ?? ''}` };
    case 'stopped': return { text: 'Stopped', title: undefined };
  }
}

/** @brief 结束了的一行的 Response：回复（空时 (no reply)），失败、停止时是原因；没结束时为 null。 */
function responseOf(row: SubagentRow): string | null {
  if (!phaseEnded(row.phase)) return null;
  return row.phase === 'done' ? row.reply || '(no reply)' : row.error ?? '';
}

/**
 * @brief 卡片的每一行（§7.2）：有 details 时按每个 subagent 的状态；没有时按参数画出（参数还在流入时按已收到的
 *        description），状态空着；卡片中断、停止时没结束的行为 Interrupted、Stopped。
 * @param tool 这次调用
 * @param cwd 工作目录（工具标题里的路径显示为相对路径）
 */
export function subagentRows(tool: ToolCall, cwd: string): SubagentCardRow[] {
  const cut = tool.status === 'interrupted' ? 'Interrupted' : tool.status === 'stopped' ? 'Stopped' : null;
  const rows = tool.subagent?.agents;
  if (rows) {
    return rows.map((row, i) => {
      const open = !phaseEnded(row.phase) && cut !== null;
      const state = open ? { text: cut, title: undefined } : liveState(row, cwd);
      return { index: i + 1, label: rowLabel(row), state: state.text, stateTitle: state.title,
        phase: open ? cut.toLowerCase() : row.phase, role: row.role, prompt: row.prompt, response: responseOf(row) };
    });
  }
  const args = tool.args ? subagentArgRows(tool.args) : null;
  const parsed = args ?? streamingDescriptions(tool.argsText).map((description) => ({ description, role: BASE_ROLE,
    readOnly: false, prompt: '' }));
  return parsed.map((row, i) => ({ index: i + 1, label: rowLabel({ ...row, toolUses: 0 }), state: cut ?? '',
    stateTitle: undefined, phase: cut?.toLowerCase() ?? 'pending', role: row.role, prompt: row.prompt,
    response: null }));
}
