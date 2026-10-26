// Customize › Agents 的进程桥（docs/specs/customize-agents.md §4、§5）与界面文字（§6、§7；状态表
// docs/v1/screens/customize-agents.md）：roles.get、roles.save、roles.delete 的命令与结果，agent 的样子，
// 以及行与展开里的固定说法（职责、模型的一句话、Model needs 的白话、Tools、Other settings）。

import { z } from 'zod';
import type { ModelPick } from './models';
import { SEATS, type Seat, type TeamHolders } from './team';

/** @brief 角色文件 subscribe 的一项（平行 Agent 规格 §9.5）：时刻与过滤。 */
export interface AgentSubscription {
  /** 时刻；v1 只有 request_closed */
  moment: 'request_closed';
  /** ruled_out 过滤：需求有（true）或没有（false）已排除的方案；没写时为 null */
  ruledOut: boolean | null;
  /** outcome 过滤：只在这些结局时命中；没写时为 null */
  outcome: ('done' | 'failed' | 'cancelled')[] | null;
}

/** @brief 一个候选模型与静态检查的结果（§4.2）。 */
export interface RoleCandidate {
  /** 模型全名 <provider>/<model> */
  ref: string;
  /** 选择器第 1、3 步的界面文字（REASON_TEXTS）；通过时为 null（界面写 Ready） */
  reason: string | null;
}

/** @brief 一个 agent：基座 mori，或 .mori/agents 里的一个文件（§4.1）。 */
export interface AgentView {
  /** 名字；有问题的文件：frontmatter 的 name 是字符串时用它，否则是文件名去掉 .md */
  name: string;
  /** 相对项目根的路径，例如 .mori/agents/reviewer.md；基座为 null */
  file: string | null;
  /** 绝对路径；基座为 null */
  path: string | null;
  /** 一句话说明；有问题的文件里不是字符串时为空串 */
  description: string;
  /** 正文（界面上叫 Prompt） */
  body: string;
  /** 持有的职责，按 SEATS 的顺序；基座是没人认领的那几项 */
  seats: Seat[];
  /** 写了的工具；null 为与基座相同 */
  tools: string[] | null;
  /** 写了的模型范围（按顺序）；null 为用会话的范围 */
  models: string[] | null;
  /** requires 里 tool_calling 以外的项，原文，去重 */
  needs: string[];
  /** 写了 differ_from: author */
  differFromAuthor: boolean;
  /** 订阅 */
  subscribe: AgentSubscription[];
  /** 会按顺序用的模型与能不能用（§4.2）；有问题的文件为空 */
  candidates: RoleCandidate[];
  /** 这个文件的问题（问题行冒号后面的文字，含跨文件的）；不为空时只有 name、file、path、problems 有意义 */
  problems: string[];
  /** 文件头里有 # 注释（编辑保存会去掉，§5.3） */
  headerComments: boolean;
}

/** @brief 表单可选的一个模型范围（顺序与文字同模型菜单）。 */
export interface RoleRange {
  /** 范围的名字：分组 id、提供商 id 或 <provider>/<model> */
  pick: ModelPick;
  /** 种类：分组、提供商、模型 */
  kind: 'group' | 'provider' | 'model';
  /** 菜单里的文字：分组 id、提供商名称、模型 id */
  label: string;
}

/** @brief roles.get 的内容（§4.1）。 */
export interface RolesInfo {
  /** 项目根（跟随的会话的工作目录） */
  cwd: string;
  /** <cwd>\.mori\agents 的绝对路径（目录不存在也给出） */
  dir: string;
  /** 会话的模型范围；没有时为 null */
  pick: ModelPick | null;
  /** 三项职责的持有者：合格的文件认领的，其余是 mori */
  holders: TeamHolders;
  /** 全部问题行（<file>: …）；不为空时新会话会按 agents_invalid 拒绝启动 */
  problems: string[];
  /** 第一个是基座 mori，后面是文件，按文件名 */
  agents: AgentView[];
  /** 表单可选的模型范围 */
  ranges: RoleRange[];
  /** 表单可选的 pi 工具 */
  piTools: string[];
  /** 新会话会用的默认工具（基座与 Same as Mori） */
  baseTools: string[];
}

/** @brief 表单的六个字段（§5.1）。 */
export interface AgentDraft {
  /** 名字 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 认领的职责 */
  seats: Seat[];
  /** 写的工具；null 为 Same as Mori（不写这个字段） */
  tools: string[] | null;
  /** 写的模型范围；null 为用会话的范围（不写这个字段） */
  models: string[] | null;
  /** 正文 */
  body: string;
}

/** @brief roles.get 的结果：目录读不出时 info 为 null、error 为原文（§4.3）。 */
export interface RolesGetResult {
  /** 读到的内容 */
  info: RolesInfo | null;
  /** 失败的原文；成功为 null */
  error: string | null;
}

/** @brief roles.save 的结果：不写文件时 info、file 为 null，error 为问题（每条一行，§5.2）。 */
export interface RolesSaveResult {
  /** 保存后重新读到的内容 */
  info: RolesInfo | null;
  /** 写出的文件（相对项目根） */
  file: string | null;
  /** 不写的原因；成功为 null */
  error: string | null;
}

/** @brief roles.delete 的结果。 */
export interface RolesDeleteResult {
  /** 删除后重新读到的内容 */
  info: RolesInfo | null;
  /** 失败的原文；成功为 null */
  error: string | null;
}

const sessionId = z.string().min(1);

/** @brief 表单的字段；文字只写 z.string()，规则由后台进程按角色文件的校验查（§5.2）。 */
const AgentDraftSchema = z.object({
  name: z.string(),
  description: z.string(),
  seats: z.array(z.enum(SEATS)),
  tools: z.array(z.string()).nullable(),
  models: z.array(z.string()).nullable(),
  body: z.string(),
});

/** @brief Customize › Agents 的命令，由 protocol.ts 并进 CommandSchema（§4、§5）。 */
export const RoleCommandSchemas = [
  /** 跟随的会话所在项目的 agent */
  z.object({ type: z.literal('roles.get'), sessionId }),
  /** file 为 null 时新建 .mori/agents/<name>.md，否则改这个文件（文件名不变） */
  z.object({ type: z.literal('roles.save'), sessionId, file: z.string().min(1).nullable(), agent: AgentDraftSchema }),
  /** 删除这个文件；name 只用于操作记录 */
  z.object({ type: z.literal('roles.delete'), sessionId, file: z.string().min(1), name: z.string() }),
] as const;

// ---- 界面文字（§6、§7） ----

/** @brief 三项职责的界面文字（临时，§7）。 */
export const SEAT_TEXT: Readonly<Record<Seat, string>> = Object.freeze({
  dialog: 'Talks to you', create: 'Plans requests', close: 'Closes requests',
});

/** @brief 一行上的职责：按 SEATS 的顺序用 " · " 连起来；没有时为空串。 */
export function seatsText(seats: readonly Seat[]): string {
  return SEATS.filter((seat) => seats.includes(seat)).map((seat) => SEAT_TEXT[seat]).join(' · ');
}

/** @brief 模型的一句话的种类（状态表“模型的一句话”）。 */
export type ModelLineState = 'ready' | 'some' | 'none' | 'empty';

/**
 * @brief 一行上模型的一句话（§6.2）：全部 Ready 时第一个模型的 id（多于一个时加 and <n> more）；有不能用的时
 *        <k> of <n> models can’t run；全部不能用时 No model can run this agent；没有候选时 No model range picked。
 */
export function modelLine(candidates: readonly RoleCandidate[]): { state: ModelLineState; text: string } {
  if (candidates.length === 0) return { state: 'empty', text: 'No model range picked' };
  const blocked = candidates.filter((item) => item.reason !== null).length;
  if (blocked === candidates.length) return { state: 'none', text: 'No model can run this agent' };
  if (blocked > 0) return { state: 'some', text: `${blocked} of ${candidates.length} models can’t run` };
  const first = candidates[0].ref;
  const id = first.slice(first.indexOf('/') + 1);
  const more = candidates.length > 1 ? ` and ${candidates.length - 1} more` : '';
  return { state: 'ready', text: `Models: ${id}${more}` };
}

/** @brief 展开里 Models 一块的标题（§6.3）。 */
export function modelsHeading(models: readonly string[] | null, pick: ModelPick | null): string {
  if (models !== null) return 'Tries these in order:';
  return pick === null ? 'The session has no model range.' : `Same as the session’s model range (${pick})`;
}

/** @brief Model needs 里一项的白话（§6.3）；不在词表里的原样（有问题的文件不展开这一块）。 */
export function needText(need: string): string {
  switch (need) {
    case 'protocol_write': return 'Fills in handoff forms (verified)';
    case 'protocol_write>=B': return 'Handoff tier B or better';
    case 'structured_output': return 'Structured output (verified)';
    case 'vision': return 'Image input';
  }
  const context = /^context>=(\d+)$/.exec(need);
  return context ? `Context window of at least ${context[1]} tokens` : need;
}

/** @brief 有 protocol_write 一类的要求时，Model needs 下面加一行 handoff tier 的说明。 */
export function hasTierNeed(needs: readonly string[]): boolean {
  return needs.some((need) => need === 'protocol_write' || need === 'protocol_write>=B');
}

/** @brief handoff tier 的说明（§6.3）。 */
export const HANDOFF_TIER_NOTE = 'Handoff tier is how a model fills in the form it hands back at the end of a task: '
  + 'A, B, or C (weakest). Mori finds it when it checks the model.';

/** @brief 基座的白名单里代表全部 MCP 工具的写法。 */
const ALL_MCP = 'mcp__*';

/** @brief Tools 一块（§6.3）：写了的用 ", " 连起来（mcp__* 写作 all MCP tools）；没写的是 Same as Mori 和默认工具。 */
export function toolsText(tools: readonly string[] | null, baseTools: readonly string[]): string {
  if (tools === null) return `Same as Mori: ${[...baseTools, 'and all MCP tools'].join(', ')}`;
  return tools.map((tool) => (tool === ALL_MCP ? 'all MCP tools' : tool)).join(', ');
}

/** @brief 一项订阅的过滤（§6.3）：has / no ruled-out approaches、outcome: done, failed。 */
function filterText(sub: AgentSubscription): string {
  const parts: string[] = [];
  if (sub.ruledOut !== null) parts.push(sub.ruledOut ? 'has ruled-out approaches' : 'no ruled-out approaches');
  if (sub.outcome !== null) parts.push(`outcome: ${sub.outcome.join(', ')}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** @brief Other settings 一块的各行（§6.3）；都没有时为空。 */
export function otherSettings(agent: Pick<AgentView, 'differFromAuthor' | 'subscribe'>): string[] {
  const lines = agent.differFromAuthor ? ['Avoids the model family that changed the code'] : [];
  return [...lines, ...agent.subscribe.map((sub) => `Woken when a request closes${filterText(sub)}`)];
}
