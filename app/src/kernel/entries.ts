// 补充条目 id 与引用来源（方案第 6 节第 4 件、"引用来源用 pi 的自定义条目写进会话文件"）。
// pi 先把 message_end 发给订阅者，紧接着在同一段同步代码里把这个消息对象写进会话（agent-session.js _handleAgentEvent），
// 所以在 message_end 之后的微任务里就能按对象找到它的条目；带引用的你的消息随后写一条 mori.ref 条目（不进模型上下文）。
// 状态见 docs/v0/screens/selection.md。

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { REF_ENTRY_TYPE, type EventEnvelope, type QuoteRef, type RefEntryData } from '../shared/protocol';

type Emit = (envelope: EventEnvelope) => void;
type AgentMessage = Extract<AgentSessionEvent, { type: 'message_end' }>['message'];

/** @brief 发出了、pi 还没记下的带引用的消息（按发出的顺序）。 */
interface Pending {
  /** 发给 pi 的全文 */
  text: string;
  /** 引用 */
  refs: QuoteRef[];
}

/** @brief 一个会话里等着写成 mori.ref 条目的引用。按全文对上 pi 记下的你的消息（pi 的排队区也按全文对）。 */
export class PendingRefs {
  private items: Pending[] = [];

  /** @brief 记下一条带引用的消息；返回它，发送失败时用来去掉。 */
  add(text: string, refs: QuoteRef[]): Pending {
    const item = { text, refs };
    this.items.push(item);
    return item;
  }

  /** @brief 去掉一条（发送失败、没有送达）。 */
  drop(item: Pending): void {
    this.items = this.items.filter((current) => current !== item);
  }

  /** @brief 撤回的排队消息：去掉它们的引用（文字放回输入框，芯片不恢复）。 */
  dropTexts(texts: string[]): void {
    for (const text of texts) {
      const index = this.items.findIndex((item) => item.text === text);
      if (index >= 0) this.items.splice(index, 1);
    }
  }

  /** @brief 取走与这段全文对应的引用；没有时为 null。 */
  take(text: string): QuoteRef[] | null {
    const index = this.items.findIndex((item) => item.text === text);
    if (index < 0) return null;
    const [item] = this.items.splice(index, 1);
    return item?.refs ?? null;
  }

  /** @brief 还在等的那一条（判断发送后是否送达）。 */
  has(item: Pending): boolean {
    return this.items.includes(item);
  }
}

/** @brief 你的消息的纯文字（与 pi 排队区比较全文的写法相同）。 */
function userText(message: AgentMessage): string {
  if (message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** @brief 按消息对象找到它的条目 id：先看叶子（刚写入的通常就是它），再沿当前分支往回找。 */
function findEntryId(session: AgentSession, message: AgentMessage): string | null {
  const manager = session.sessionManager;
  const leaf = manager.getLeafEntry();
  if (leaf?.type === 'message' && leaf.message === message) return leaf.id;
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const item = branch[index];
    if (item?.type === 'message' && item.message === message) return item.id;
  }
  return null;
}

/** @brief 把引用写成 mori.ref 条目；写不进时记录错误并返回 null（消息照常，只是没有引用来源）。 */
function saveRefs(session: AgentSession, messageId: string, refs: QuoteRef[]): QuoteRef[] | null {
  try {
    const data: RefEntryData = { messageId, refs };
    session.sessionManager.appendCustomEntry(REF_ENTRY_TYPE, data);
    return refs;
  } catch (error) {
    console.error(`[kernel] cannot save quote refs for ${messageId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * @brief message_end 之后调用：pi 写入会话后补发条目 id；你的消息带了引用时先写 mori.ref 条目。
 *        只处理你的消息和助手回复（工具结果、扩展的消息界面不用锚点）。
 */
export function supplementEntry(session: AgentSession, sessionId: string, pending: PendingRefs, message: AgentMessage,
  emit: Emit): void {
  if (message.role !== 'user' && message.role !== 'assistant') return;
  const role = message.role;
  // 微任务里抛出的错不会回到 pi，没有接住就会结束整个后台进程：出错时只记日志，这条消息没有锚点。
  queueMicrotask(() => {
    try {
      const entryId = findEntryId(session, message);
      if (!entryId) {
        console.error(`[kernel] no session entry found for a ${role} message in ${sessionId}`);
        return;
      }
      const wanted = role === 'user' ? pending.take(userText(message)) : null;
      const refs = wanted ? saveRefs(session, entryId, wanted) : null;
      emit({ kind: 'event', sessionId,
        event: { type: 'mori.entry_id', role, entryId, time: message.timestamp, refs } });
    } catch (error) {
      console.error(`[kernel] cannot supplement the entry id in ${sessionId}: ${(error as Error).message}`);
    }
  });
}
