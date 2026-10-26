// 普通模式的 subagent 工具里界面与后台进程共用的部分（docs/specs/subagent.md §3.3、§6.3、§7.1、§7.2、§9.1、§10）：
// 工具名、长度上限、实时进展与结果里的 SubagentDetails，以及卡片的标题、状态与每一行的固定文字。纯函数，不读写任何东西。

import { argOf, type ToolCallBrief } from './team';

/** @brief 工具名（§1）。 */
export const SUBAGENT_TOOL = 'subagent';

/** @brief 长度上限（§3.3、§6.3、§7.2，临时默认值登记在 docs/v1/defaults.md）。 */
export const SUBAGENT_LIMITS = Object.freeze({
  /** description 去掉空白后的最多字符数 */
  description: 80,
  /** prompt 的最多字符数 */
  prompt: 8000,
  /** 结果里每个 subagent 的回复最多字符数，超出的截掉并注明 */
  reply: 16000,
  /** 卡片一行里失败原因的最多字符数，超出的截断加 … */
  failure: 80,
});

/** @brief 实时进展（onUpdate）最多每这么多毫秒发一次（§9.1）。 */
export const SUBAGENT_UPDATE_MS = 250;

/** @brief 一个 subagent 的阶段（§9.1）。 */
export const SUBAGENT_PHASES = ['starting', 'running', 'approval', 'done', 'failed', 'stopped'] as const;
export type SubagentPhase = (typeof SUBAGENT_PHASES)[number];

/** @brief 一个 subagent 的状态（§9.1），卡片的一行与结果的一项都按它。 */
export interface SubagentRow {
  /** 参数里的 description（去掉前后空白） */
  description: string;
  /** 角色名，基座为 mori */
  role: string;
  /** 只读（read_only: true） */
  readOnly: boolean;
  /** 参数里的 prompt 原文 */
  prompt: string;
  /** 阶段 */
  phase: SubagentPhase;
  /** 这个 subagent 已开始的工具调用数 */
  toolUses: number;
  /** 最近一次工具调用（参数只给标题要用的，同 TaskView.current）；还没有时为 null */
  current: ToolCallBrief | null;
  /** 模型层的等待、换模型提示（§5.4）；没有时为 null */
  note: string | null;
  /** 最后一段回复（done）；其他阶段为 null */
  reply: string | null;
  /** 失败、停止的原因；其他阶段为 null */
  error: string | null;
}

/** @brief 实时进展与结果的 details（§9.1）。 */
export interface SubagentDetails {
  /** 每个 subagent 一项，按参数顺序 */
  agents: SubagentRow[];
}

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 一项的归一（§3.2）：认得的四个键，role 去空白转小写，read_only 的 "true"、"false" 转布尔；null 视为没写。 */
function normalizeTask(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const name of ['description', 'prompt', 'read_only', 'role']) {
    let value = argOf(item, name);
    if (value === undefined || value === null) continue;
    if (name === 'role' && typeof value === 'string') value = value.trim().toLowerCase();
    if (name === 'read_only' && typeof value === 'string' && /^\s*(true|false)\s*$/i.test(value)) {
      value = value.trim().toLowerCase() === 'true';
    }
    out[name] = value;
  }
  return out;
}

/**
 * @brief prepareArguments（§3.2）：键名不分大小写、不看 _ 与 -，schema 里没有的键丢掉；最外层直接写了一项、tasks 是一个对象时
 *        当作只有这一项。
 * @param raw 模型给的原始参数
 * @return 归一后的参数；原始参数不是对象时原样返回（由 pi 报错）
 */
export function normalizeSubagentArgs(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let tasks = argOf(raw, 'tasks');
  if (tasks === undefined || tasks === null) {
    const single = argOf(raw, 'description') !== undefined || argOf(raw, 'prompt') !== undefined;
    tasks = single ? [raw] : undefined;
  } else if (isRecord(tasks)) {
    tasks = [tasks];
  }
  if (tasks === undefined) return {};
  return { tasks: Array.isArray(tasks) ? tasks.map(normalizeTask) : tasks };
}

/** @brief 参数里的一项在卡片上用到的部分（§7.2；参数还不完整时缺的为默认值）。 */
export interface SubagentArgRow {
  /** 卡上的标题（去掉前后空白） */
  description: string;
  /** 角色名；没写时为 mori */
  role: string;
  /** 只读 */
  readOnly: boolean;
  /** 提示原文 */
  prompt: string;
}

/**
 * @brief 卡片按参数画出的各行（§7.1：重新打开时没有结果、执行之前）：按 normalizeSubagentArgs 认出的 tasks；
 *        tasks 认不出时为 null。
 * @param args 这次调用的参数（会话记录里是模型给的原样）
 */
export function subagentArgRows(args: unknown): SubagentArgRow[] | null {
  const tasks = (normalizeSubagentArgs(args) as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return null;
  return tasks.map((task) => {
    const item = (isRecord(task) ? task : {}) as Record<string, unknown>;
    return { description: typeof item.description === 'string' ? item.description.trim() : '',
      role: typeof item.role === 'string' && item.role ? item.role : 'mori', readOnly: item.read_only === true,
      prompt: typeof item.prompt === 'string' ? item.prompt : '' };
  });
}

/**
 * @brief 参数还在流入时（只有 JSON 原文）已经收到的各项的 description（§7.1、状态表“准备中”）：按出现的顺序。
 * @param argsText 已收到的参数原文
 */
export function streamingDescriptions(argsText: string): string[] {
  return [...argsText.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => {
    try {
      return (JSON.parse(`"${match[1]}"`) as string).trim();
    } catch {
      return match[1] ?? '';
    }
  });
}

/** @brief 是不是 SubagentDetails（界面读进展、会话文件里的结果时用）。 */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
  const agents = (value as { agents?: unknown } | null)?.agents;
  return Array.isArray(agents) && agents.every((row) => typeof row === 'object' && row !== null
    && typeof (row as SubagentRow).description === 'string'
    && (SUBAGENT_PHASES as readonly string[]).includes((row as SubagentRow).phase));
}

/** @brief 这个阶段已经结束（done、failed、stopped）。 */
export function phaseEnded(phase: SubagentPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'stopped';
}

/** @brief 已结束的个数（含失败与停止，§7.1 的 d）。 */
export function endedCount(rows: readonly SubagentRow[]): number {
  return rows.filter((row) => phaseEnded(row.phase)).length;
}

/** @brief 进展文字 `<d> of <n> done`（照 Claude 的 {done} of {total} agents done，§7.1、§9.1）。 */
export function progressText(rows: readonly SubagentRow[]): string {
  return `${endedCount(rows)} of ${rows.length} done`;
}

/** @brief 卡片标题的三种写法：进行中、开过之后结束、没开就结束（§7.1）。 */
export type SubagentTitleForm = 'running' | 'ran' | 'run';

/**
 * @brief 卡片标题（§7.1）：Running agent / Running 3 agents / Ran … / Run …；进行中且项数还取不出时 Running agents。
 * @param form 写法
 * @param n 参数里 tasks 的项数；取不出时为 null
 */
export function subagentTitle(form: SubagentTitleForm, n: number | null): string {
  const verb = form === 'running' ? 'Running' : form === 'ran' ? 'Ran' : 'Run';
  if (n === null) return `${verb} agents`;
  return n === 1 ? `${verb} agent` : `${verb} ${n} agents`;
}

/** @brief 工具调用次数（照 Claude 的复数：1 tool use、12 tool uses，§6.3、§7.2）。 */
export function toolUsesText(count: number): string {
  return count === 1 ? '1 tool use' : `${count} tool uses`;
}

/**
 * @brief 卡片一行里的失败原因：超过 80 字符截断加 …（§7.2；悬停看全文由界面做）。
 * @param error 原因全文
 */
export function failureText(error: string): string {
  const chars = [...error];
  return chars.length > SUBAGENT_LIMITS.failure ? `${chars.slice(0, SUBAGENT_LIMITS.failure).join('')}…` : error;
}
