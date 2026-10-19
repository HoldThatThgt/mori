// 转发前精简 pi 事件：message_update 每个增量都带着完整消息，原样经 MessagePort 传输量会随回复长度平方增长。

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ForwardedEvent, SlimMessageUpdate } from '../shared/protocol';

/** @brief 把 message_update 精简为类型、序号和增量，其余事件原样返回。 */
export function slimEvent(event: AgentSessionEvent): ForwardedEvent {
  if (event.type !== 'message_update') return event;
  const source = event.assistantMessageEvent;
  const update: SlimMessageUpdate['update'] = { type: source.type };
  if ('contentIndex' in source) update.contentIndex = source.contentIndex;
  if ('delta' in source) update.delta = source.delta;
  if (source.type === 'toolcall_start' || source.type === 'toolcall_delta') {
    const block = source.partial.content[source.contentIndex];
    if (block?.type === 'toolCall') update.toolName = block.name;
  }
  if (source.type === 'toolcall_end') update.toolName = source.toolCall.name;
  if (source.type === 'done') update.reason = source.reason;
  if (source.type === 'error') {
    update.reason = source.reason;
    update.errorMessage = source.error.errorMessage;
  }
  return { type: 'message_update', update };
}
