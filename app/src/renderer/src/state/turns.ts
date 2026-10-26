// 一轮回复：你的一条消息之后、下一条之前的全部助手回复（方案 5.11 的"轮"）。
// 照 Claude 桌面版，回复下的操作（"Copy"、"Attach message as context"、"Give feedback"）每轮一行，放在这一轮最后一条
// 有正文的助手回复下（见 replyTurns）。

import type { MessageSource } from '../../../shared/protocol';
import type { Item, MessageMark } from './model';

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
 * @brief 最后一轮是否已经结束：最后一项（不算回执与进展摘要这两种协作的行）是你的消息或程序投递。分开时回执紧跟
 *        你的新消息（§13.2），它不让上一轮重新算作正在进行的一轮（那一轮的回复操作行照常显示）。
 */
export function lastTurnEnded(items: Item[]): boolean {
  const last = items.findLast((item) => item.kind !== 'receipt' && item.kind !== 'progress');
  return last?.kind === 'user' || last?.kind === 'wake';
}

/** @brief 整轮回复作为引用来源。 */
export function turnSource(turn: ReplyTurn, sessionFile: string | null): MessageSource {
  return { kind: 'message', sessionFile, entryId: turn.anchor.entryId, time: turn.anchor.time, scope: 'reply' };
}
