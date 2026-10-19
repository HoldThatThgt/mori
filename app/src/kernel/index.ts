// 后台进程入口（utilityProcess）：接收主进程转交的 MessagePort，校验并分发命令，广播事件，按要求有序退出。

import type { MessagePortMain } from 'electron';
import { CommandSchema, type EventEnvelope, type KernelMessage } from '../shared/protocol';
import { handleCommand } from './commands';
import { shutdownSessions } from './sessions';

const ports = new Set<MessagePortMain>();

/** @brief 发消息；无法结构化克隆的内容记录错误后丢弃，不影响 pi 的事件回调。 */
function post(port: MessagePortMain, message: KernelMessage): void {
  try {
    port.postMessage(message);
  } catch (error) {
    const what = message.kind === 'event' ? `event ${message.event.type}` : `response ${message.id}`;
    console.error(`[kernel] postMessage failed for ${what}: ${String(error)}`);
  }
}

/** @brief 把事件广播给所有已连接的页面。 */
function emit(envelope: EventEnvelope): void {
  for (const port of ports) post(port, envelope);
}

/** @brief 处理界面发来的一条请求并回复。 */
async function handleRequest(port: MessagePortMain, data: unknown): Promise<void> {
  const request = data as { kind?: string; id?: number; command?: unknown };
  if (request?.kind !== 'request' || typeof request.id !== 'number') {
    console.error('[kernel] dropped a malformed request');
    return;
  }
  const parsed = CommandSchema.safeParse(request.command);
  if (!parsed.success) {
    console.error(`[kernel] invalid command: ${parsed.error.message}`);
    post(port, { kind: 'response', id: request.id, ok: false, error: parsed.error.message });
    return;
  }
  try {
    const result = await handleCommand(parsed.data, emit);
    post(port, { kind: 'response', id: request.id, ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kernel] ${parsed.data.type} failed: ${message}`);
    post(port, { kind: 'response', id: request.id, ok: false, error: message });
  }
}

/** @brief 接入一个页面的通道。 */
function attachPort(port: MessagePortMain): void {
  ports.add(port);
  port.on('message', (message) => void handleRequest(port, message.data));
  port.on('close', () => ports.delete(port));
  port.start();
}

process.parentPort.on('message', (event) => {
  const type = (event.data as { type?: string })?.type;
  if (type === 'port' && event.ports[0]) attachPort(event.ports[0]);
  if (type === 'shutdown') {
    // 先停止并释放所有会话，再通知主进程；主进程随后结束整个进程树，清掉命令留下的子进程（pi #9129）。
    void shutdownSessions().finally(() => process.parentPort.postMessage({ type: 'shutdown-done' }));
  }
});

console.log(`[kernel] started, agentDir=${process.env.PI_CODING_AGENT_DIR ?? '(default)'}`);
