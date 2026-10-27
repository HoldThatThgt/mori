// 你不在（docs/specs/file-system-permissions.md §9；状态表 docs/v1/screens/fs-question.md）的界面状态：挂起的卡的截止时刻
// （mori.away_timer、LiveSnapshot.awayTimers）、卡上最后 20 秒的倒计时、一轮末尾的 "Decided while you were away"
// （mori.away_decision 的事件与会话条目）。界面不自己计时：卡什么时候结束由后台进程决定，这里只按 deadline 算剩下的秒数。
// 纯函数，由 transcript.ts、history.ts 与卡片、对话流调用。

import {
  AWAY_COUNTDOWN_MS, AWAY_DURATION_TEXT, type AwayDecision, type AwayTimer,
} from '../../../shared/workspace';
import { roleLabel } from '../../../shared/team';
import { pushItem, type Item, type Transcript } from './model';

/** @brief 带截止时刻的一张挂起的卡（批准卡、后台批准卡、扩展询问、提问卡）。 */
interface Timed {
  /** 请求 id：approval-<n>、<实例的 pi 会话 id>:approval-<n>、question-<n>、ask-<n> */
  requestId: string;
  /** 截止时刻（ms）；没在计时为 null */
  deadline: number | null;
}

/** @brief 把一张卡的截止时刻换掉；列表里没有这个请求时为 null。 */
function withDeadline<T extends Timed>(list: readonly T[], requestId: string, deadline: number | null): T[] | null {
  const index = list.findIndex((item) => item.requestId === requestId);
  if (index < 0) return null;
  return list.map((item, at) => (at === index ? { ...item, deadline } : item));
}

/**
 * @brief mori.away_timer：开始计时时记下截止时刻（ms），切回 Mori、计时清零时为 null（§9.3）。按 requestId 找
 *        对话的批准卡、后台批准卡、询问卡队列；不认识的 requestId 忽略（§9.2：卡已经结束，原样返回）。
 */
export function setAwayDeadline(state: Transcript, requestId: string, deadline: number | null): Transcript {
  const approvals = withDeadline(state.approvals, requestId, deadline);
  if (approvals) return { ...state, approvals };
  const teamApprovals = withDeadline(state.teamApprovals, requestId, deadline);
  if (teamApprovals) return { ...state, teamApprovals };
  const questions = withDeadline(state.questions, requestId, deadline);
  return questions ? { ...state, questions } : state;
}

/** @brief 界面重新载入后接上正在计时的卡（LiveSnapshot.awayTimers，§9.5）：卡要先接上。 */
export function withAwayTimers(state: Transcript, timers: readonly AwayTimer[]): Transcript {
  return timers.reduce((next, timer) => setAwayDeadline(next, timer.requestId, timer.deadline), state);
}

/** @brief mori.away_decision（实时的事件或会话条目）：记进对话流，这一轮末尾的那一块按它画（§9.7、§9.9）。 */
export function addAwayDecision(state: Transcript, decision: AwayDecision): Transcript {
  return pushItem(state, { kind: 'away', decision });
}

// ---- 卡上的倒计时（§9.9） ----

/** @brief 卡的种类：批准卡（对话的与后台的）、提问卡、扩展询问卡，倒计时一行各说各的。 */
export type AwayCardKind = 'approval' | 'ask' | 'extension';

/** 倒计时一行里到时会做的事（fs-question.md "倒计时"） */
const COUNTDOWN_ACTIONS: Readonly<Record<AwayCardKind, string>> = Object.freeze({
  approval: 'Denying', ask: 'Using the recommended options', extension: 'Cancelling',
});

/**
 * @brief 倒计时一行要显示的剩下秒数（向上取整，到时之后为 0，卡由后台进程的结束事件去掉）。
 * @return 没在计时（deadline 为 null），或剩下多于 AWAY_COUNTDOWN_MS 时为 null：不显示
 */
export function awaySecondsLeft(deadline: number | null, now: number): number | null {
  if (deadline === null || deadline - now > AWAY_COUNTDOWN_MS) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * @brief 离倒计时一行出现还有多少毫秒：剩下多于 20 秒时卡片只设一个到这一刻的 setTimeout，进入最后 20 秒才每秒重画（§9.9）。
 * @return 没在计时时为 null；已经在最后 20 秒里为 0
 */
export function awayCountdownDelay(deadline: number | null, now: number): number | null {
  return deadline === null ? null : Math.max(0, deadline - AWAY_COUNTDOWN_MS - now);
}

/** @brief 倒计时一行：You’re away · Denying in 12s（批准卡）、… Using the recommended options in 12s、… Cancelling in 12s。 */
export function awayCountdownText(kind: AwayCardKind, seconds: number): string {
  return `You’re away · ${COUNTDOWN_ACTIONS[kind]} in ${seconds}s`;
}

// ---- 一轮末尾：Decided while you were away（§9.9） ----

/** @brief 一轮末尾的那一块。 */
export interface AwayBlock {
  /** 这一轮的记录，按处理的时刻先后 */
  decisions: AwayDecision[];
  /**
   * 说明行：记录的时长都相同时 You didn’t answer within <时长>, so Mori decided these.，不同时
   * You didn’t answer in time, so Mori decided these.
   */
  note: string;
}

/** @brief 一轮的记录归成一块。 */
function blockOf(decisions: AwayDecision[]): AwayBlock {
  const sorted = [...decisions].sort((a, b) => a.at - b.at);
  const timeouts = new Set(sorted.map((decision) => decision.timeout));
  const [only] = timeouts;
  const within = timeouts.size === 1 && only ? `within ${AWAY_DURATION_TEXT[only]}` : 'in time';
  return { decisions: sorted, note: `You didn’t answer ${within}, so Mori decided these.` };
}

/**
 * @brief 按轮归组的 "Decided while you were away"：一轮是你的一条消息到下一条之间，程序投递（wake 条目）不另起一轮
 *        （proposal §4）。键是这一块画在哪一项后面：这一轮最后一项（不算不显示的 wake；记录本身是最后一项时就是它），
 *        对话流在这一项（和它的回复操作行）之后画这一块；这一轮还在进行时，新的记录让它跟着移到最后。
 * @return 有记录的轮；没有记录的轮不在里面
 */
export function awayBlocks(items: readonly Item[]): Map<string, AwayBlock> {
  const blocks = new Map<string, AwayBlock>();
  let decisions: AwayDecision[] = [];
  let anchor: string | null = null;
  const close = () => {
    if (decisions.length > 0 && anchor) blocks.set(anchor, blockOf(decisions));
    decisions = [];
    anchor = null;
  };
  for (const item of items) {
    if (item.kind === 'user') close();
    if (item.kind === 'away') decisions.push(item.decision);
    if (item.kind !== 'wake') anchor = item.key;
  }
  close();
  return blocks;
}

/** @brief 块里的一行（fs-question.md "一轮末尾" 的每一行）。 */
export interface AwayRow {
  /** 行的 key：请求 id；提问卡每个问题一行，接 :<问题下标> */
  key: string;
  /** 这一行的记录（data-kind 为 decision.kind，data-request 为 decision.requestId） */
  decision: AwayDecision;
  /** 行的开头：Denied / Recommended / Cancelled */
  result: string;
  /** 后台实例的归属 <role> · T1（没有 task 时 <role>，基座写 Mori）；用户会话自己的为 null */
  owner: string | null;
  /**
   * 提问：<header>: <label>；扩展询问：Extension: <title>；批准为 null，界面按 decision.toolName、decision.args
   * 画工具卡标题（同 toolTitle）
   */
  text: string | null;
  /** 右边的时间 HH:MM（本地时间） */
  time: string;
}

/** 行的开头 */
const RESULT_TEXT: Readonly<Record<AwayDecision['result'], string>> = Object.freeze({
  denied: 'Denied', recommended: 'Recommended', cancelled: 'Cancelled',
});

/** @brief 本地时间 HH:MM。 */
function hourMinute(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** @brief 一条记录的几行：提问卡每个问题一行，其余一行。 */
function rowsOf(decision: AwayDecision): AwayRow[] {
  const { agent } = decision;
  const owner = agent ? [roleLabel(agent.role), agent.task].filter(Boolean).join(' · ') : null;
  const base = { decision, result: RESULT_TEXT[decision.result], owner, time: hourMinute(decision.at) };
  if (decision.kind === 'question') {
    return (decision.answers ?? []).map((answer, index) => {
      const labels = answer.other === null ? answer.selected : [...answer.selected, answer.other];
      return { ...base, key: `${decision.requestId}:${index}`, text: `${answer.header}: ${labels.join(', ')}` };
    });
  }
  const text = decision.kind === 'extension' ? `Extension: ${decision.title ?? ''}` : null;
  return [{ ...base, key: decision.requestId, text }];
}

/** @brief 一块里的全部行，按记录的顺序。 */
export function awayRows(block: AwayBlock): AwayRow[] {
  return block.decisions.flatMap(rowsOf);
}
