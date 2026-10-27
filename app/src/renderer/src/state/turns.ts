// 一轮回复：你的一条消息之后、下一条之前的全部助手回复（方案 5.11 的"轮"）。
// 照 Claude 桌面版，回复下的操作（"Copy"、"Attach message as context"、"Give feedback"）每轮一行，放在这一轮最后一条
// 有正文的助手回复下（见 replyTurns）。
// 2026-10-26 走查 M18：一轮里正文之间的思考块与工具卡是一个步骤组，正文跟在后面或这一轮结束时折成一行
// "{n} steps"（docs/v0/screens/chat.md"步骤组"）。

import type { MessageSource } from '../../../shared/protocol';
import type { Block, Item, MessageMark, ToolCall, ToolStatus } from './model';

type Assistant = Extract<Item, { kind: 'assistant' }>;

/** @brief 一轮回复。 */
export interface ReplyTurn {
  /** 这一轮全部正文的 Markdown 原文，段之间空一行（不含思考和工具卡） */
  text: string;
  /** 锚点：这一轮第一条有正文的助手回复 */
  anchor: MessageMark;
  /** 这一轮的助手回复（对话流里的 key），按顺序 */
  keys: string[];
}

/** @brief 一条助手回复的正文段。 */
function replyTexts(item: Assistant): string[] {
  return item.blocks.flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text.trim()] : []));
}

/** @brief 把一轮的助手回复归成 ReplyTurn。 */
function toTurn(replies: Assistant[]): ReplyTurn {
  const first = replies.find((item) => replyTexts(item).length > 0) ?? replies[0]!;
  return { text: replies.flatMap(replyTexts).join('\n\n'), anchor: { entryId: first.entryId, time: first.time },
    keys: replies.map((item) => item.key) };
}

/**
 * @brief 全部轮次，按回复操作行画在哪一项下面索引：这一轮最后一条有正文的助手回复（这一轮还没有有正文的回复时是最后一条
 *        助手回复；收尾检查规格 §10.1、§0 第 14 条：检查那次请求只有思考的一项不抢走回复正文下的操作行）；
 *        回复之后有进展摘要时是最后一块摘要（摘要挂在回复下面、回复操作之上，平行 Agent 规格 §13.3）。
 *        程序投递（wake 条目）与你的消息一样结束上一轮（§13.7）。
 */
export function replyTurns(items: Item[]): Map<string, ReplyTurn> {
  const turns = new Map<string, ReplyTurn>();
  let replies: Assistant[] = [];
  let anchor: string | null = null;
  let texted = false;
  const close = () => {
    if (replies.length > 0 && anchor) turns.set(anchor, toTurn(replies));
    replies = [];
    anchor = null;
    texted = false;
  };
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'wake') close();
    if (item.kind === 'assistant') {
      replies.push(item);
      const filled = replyTexts(item).length > 0;
      if (filled || !texted) anchor = item.key;
      texted ||= filled;
    }
    if (item.kind === 'progress' && replies.length > 0) anchor = item.key;
  }
  close();
  return turns;
}

/**
 * @brief 最后一轮是否已经结束：最后一项（不算回执、进展摘要与你不在时的自动处理记录这三种行）是你的消息或程序投递。
 *        分开时回执紧跟你的新消息（§13.2），它不让上一轮重新算作正在进行的一轮（那一轮的回复操作行照常显示）；
 *        自动处理记录同样不是一轮的边界（file-system-permissions.md §9.9）。
 */
export function lastTurnEnded(items: Item[]): boolean {
  const last = items.findLast((item) => item.kind !== 'receipt' && item.kind !== 'progress' && item.kind !== 'away');
  return last?.kind === 'user' || last?.kind === 'wake';
}

/** @brief 整轮回复作为引用来源。 */
export function turnSource(turn: ReplyTurn, sessionFile: string | null): MessageSource {
  return { kind: 'message', sessionFile, entryId: turn.anchor.entryId, time: turn.anchor.time, scope: 'reply' };
}

// ---- 步骤组（2026-10-26 走查 M18，docs/v0/screens/chat.md"步骤组"） ----

/** 还没结束的调用的状态：组里有这样的调用时不因后面有正文而折起 */
const OPEN_TOOLS: readonly ToolStatus[] = ['preparing', 'queued', 'awaiting', 'running'];

/** @brief 步骤组里的一块：哪条助手回复（对话流里的 key）的第几块。 */
export interface StepMember {
  /** 助手回复的 key */
  key: string;
  /** 块下标（同 pi 的 contentIndex） */
  index: number;
}

/** @brief 一个步骤组：同一轮里连续的思考块（有字的）与工具卡，至少有一张工具卡。 */
export interface StepGroup {
  /** 标识：组里最后一块的位置 `<回复 key>:<块下标>`（折起之后不再变；载入更早的消息把组接长时也不变） */
  id: string;
  /** 组里的块，按顺序 */
  members: StepMember[];
  /** 步数：思考块数加工具调用数（同 Claude 的 "{n} steps"） */
  steps: number;
  /** 状态为 Failed 的调用数 */
  failed: number;
  /** 自动折起：后面有正文且组里的调用都已结束，或这一轮已经结束 */
  folded: boolean;
}

/** @brief 组还在拼时的样子。 */
interface Draft {
  /** 组里的块 */
  members: StepMember[];
  /** 步数 */
  steps: number;
  /** 失败的调用数 */
  failed: number;
  /** 有工具卡 */
  tools: boolean;
  /** 有还没结束的调用 */
  open: boolean;
  /** 同一轮里后面有正文 */
  textAfter: boolean;
  /** 所在的一轮已经结束（后面有你的消息或程序投递） */
  ended: boolean;
}

/** @brief 一块在步骤组里算什么：一步（有字的思考、有工具卡的调用）、正文（有字的）；空块与没有工具卡的调用不算。 */
function blockRole(block: Block, tools: Record<string, ToolCall>): 'step' | 'text' | null {
  if (block.type === 'tool') return tools[block.id] ? 'step' : null;
  if (!block.text.trim()) return null;
  return block.type === 'thinking' ? 'step' : 'text';
}

/** @brief 把一块记进正在拼的组。 */
function addStep(draft: Draft, member: StepMember, block: Block, tools: Record<string, ToolCall>): void {
  draft.members.push(member);
  draft.steps += 1;
  if (block.type !== 'tool') return;
  const status = tools[block.id]!.status;
  draft.tools = true;
  if (status === 'failed') draft.failed += 1;
  if (OPEN_TOOLS.includes(status)) draft.open = true;
}

/** @brief 拼好的组变成 StepGroup。 */
function toGroup(draft: Draft, liveTurn: boolean): StepGroup {
  const last = draft.members.at(-1)!;
  const turnOver = draft.ended || !liveTurn;
  return { id: `${last.key}:${last.index}`, members: draft.members, steps: draft.steps, failed: draft.failed,
    folded: turnOver || (draft.textAfter && !draft.open) };
}

/**
 * @brief 对话流（已显示的部分）里的步骤组。有字的正文和任何不是助手回复的一项结束一组；你的消息与程序投递（wake）
 *        还结束一轮；只有思考块的一段不成组。
 * @param items 已显示的对话流（从 startIndex 起）
 * @param tools 工具调用
 * @param liveTurn 最后一轮在运行（本轮在运行或最后一条回复还在流入，且最后一项不是你的消息或程序投递）
 */
export function stepGroups(items: Item[], tools: Record<string, ToolCall>, liveTurn: boolean): StepGroup[] {
  const drafts: Draft[] = [];
  let turn: Draft[] = [];
  let run: Draft | null = null;
  const close = () => {
    if (run?.tools) {
      drafts.push(run);
      turn.push(run);
    }
    run = null;
  };
  for (const item of items) {
    if (item.kind !== 'assistant') {
      close();
      if (item.kind === 'user' || item.kind === 'wake') {
        for (const draft of turn) draft.ended = true;
        turn = [];
      }
      continue;
    }
    item.blocks.forEach((block, index) => {
      const role = blockRole(block, tools);
      if (role === 'text') {
        close();
        for (const draft of turn) draft.textAfter = true;
      } else if (role === 'step') {
        run ??= { members: [], steps: 0, failed: 0, tools: false, open: false, textAfter: false, ended: false };
        addStep(run, { key: item.key, index }, block, tools);
      }
    });
  }
  close();
  return drafts.map((draft) => toGroup(draft, liveTurn));
}

/**
 * @brief 摘要行的文字：Claude 的 "{count, plural, one {# step} other {# steps}}"（vAKAnIbJ4M，数字按 en-US 写千分位），
 *        有失败的调用时空一格接 Claude 的 "· {failedCount, plural, one {# failed} other {# failed}}"（HVw2b9gU1w）。
 */
export function stepsLabel(steps: number, failed: number): string {
  const count = `${steps.toLocaleString('en-US')} ${steps === 1 ? 'step' : 'steps'}`;
  return failed > 0 ? `${count} · ${failed.toLocaleString('en-US')} failed` : count;
}

/** @brief 步骤组的摘要行。 */
export interface StepRow {
  /** 组的标识 */
  id: string;
  /** 行的文字（stepsLabel） */
  label: string;
  /** 你点开了：组里的块都显示 */
  open: boolean;
}

/** @brief 一条助手回复里属于步骤组的块怎么画。 */
export interface ItemSteps {
  /** 块下标 → 这一块所在的组的标识；不在组里的块没有 */
  group: Record<number, string>;
  /** 收着的块（组折起、你没点开）的下标 */
  hidden: number[];
  /** 摘要行：块下标（行画在这一块前面，即组在已显示部分的第一块）→ 行 */
  rows: Record<number, StepRow>;
}

/**
 * @brief 按步骤组与你的展开、收起算出每条助手回复怎么画；只有含组里的块的回复才有。折起的组在第一块前面有摘要行；
 *        进行中的组没有。
 * @param groups stepGroups 的结果
 * @param opened 你点开（true）或收起（false）过的组；没点过的按折起
 */
export function itemSteps(groups: StepGroup[], opened: Record<string, boolean>): Map<string, ItemSteps> {
  const views = new Map<string, ItemSteps>();
  const viewOf = (key: string) => {
    const view = views.get(key) ?? { group: {}, hidden: [], rows: {} };
    views.set(key, view);
    return view;
  };
  for (const group of groups) {
    const open = opened[group.id] ?? false;
    group.members.forEach(({ key, index }, at) => {
      const view = viewOf(key);
      view.group[index] = group.id;
      if (!group.folded) return;
      if (!open) view.hidden.push(index);
      if (at === 0) view.rows[index] = { id: group.id, label: stepsLabel(group.steps, group.failed), open };
    });
  }
  return views;
}

/**
 * @brief 这几项里收着块的组（跳转高亮这几项之前要先展开的）：一条消息，或高亮的整轮、会话引用的几轮。
 * @param views itemSteps 的结果
 * @param keys 要高亮的项（对话流里的 key）；不是助手回复或没有组里的块的项没有组
 */
export function foldedIn(views: Map<string, ItemSteps>, keys: string[]): string[] {
  const ids = keys.flatMap((key) => {
    const view = views.get(key);
    return view ? view.hidden.map((index) => view.group[index]!) : [];
  });
  return [...new Set(ids)];
}
