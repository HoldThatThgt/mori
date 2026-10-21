// 后台进程入口（utilityProcess）：接收主进程转交的 MessagePort，校验并分发命令，广播事件，按要求有序退出。

import type { MessagePortMain } from 'electron';
import { CommandSchema, type EventEnvelope, type GlobalEventEnvelope, type KernelMessage } from '../shared/protocol';
import { handleCommand } from './commands';
import { onStoreKeyResult } from './credentials';
import { closeSharedServers, startSharedServers } from './mcpShare';
import { startModelLayer } from './modelLayer';
import { loadPi } from './pi';
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

/** @brief 把事件（会话事件，或 sessionId 为 null 的全局事件）广播给所有已连接的页面。 */
function emit(envelope: EventEnvelope | GlobalEventEnvelope): void {
  for (const port of ports) post(port, envelope);
}

/**
 * @brief 主进程送来 userData 与全部 key 后启动模型层（读配置或迁移、编译到 pi、建模型池，§4、§8）。
 *        启动失败时记录；之后的模型层命令都按失败回复。
 * @param userData Electron 的 userData 目录
 * @param keys 解密后的全部 key：ref → 明文
 */
async function startModels(userData: string, keys: Record<string, string>): Promise<void> {
  try {
    const pi = await loadPi();
    await startModelLayer({ userData, agentDir: pi.getAgentDir(), keys,
      emitGlobal: (event) => emit({ kind: 'event', sessionId: null, event }) });
  } catch (error) {
    console.error(`[kernel] model layer did not start: ${(error as Error).message}`);
  }
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

/**
 * @brief 接入一个页面的通道。通道关闭（界面重新加载，例如 Ctrl+R）时会话照常运行：照 Claude 桌面版，会话不因窗口而停；
 *        重新加载后的界面经 session.list / session.open 接上它们（docs/v0/screens/sessions.md）。
 */
function attachPort(port: MessagePortMain): void {
  ports.add(port);
  port.on('message', (message) => void handleRequest(port, message.data));
  port.on('close', () => ports.delete(port));
  port.start();
}

/** @brief 主进程发给后台进程的消息。 */
type MainToKernel =
  | { type: 'port' }
  | { type: 'start'; userData: string; keys: Record<string, string> }
  | { type: 'store-key-result'; id: number; error: string | null }
  | { type: 'shutdown' };

process.parentPort.on('message', (event) => {
  const message = event.data as MainToKernel;
  if (message?.type === 'port' && event.ports[0]) attachPort(event.ports[0]);
  if (message?.type === 'start') {
    void startModels(message.userData, message.keys);
    // 照 Claude 桌面版，启动时就起用户级启用的 stdio MCP 服务（docs/v0/m6-mcp-shared.md），在后台连接、不挡住命令。
    // 主进程把后台进程放进作业对象之后才发 key（kernel-process.ts），这之后起的服务进程都在作业里。
    void startSharedServers();
  }
  if (message?.type === 'store-key-result') onStoreKeyResult(message.id, message.error);
  if (message?.type === 'shutdown') {
    // 先停止并释放所有会话，再关掉共享的 MCP 服务（照 pi 的做法结束进程树），然后通知主进程；
    // 主进程随后结束整个进程树，清掉命令留下的子进程（pi #9129）。
    void shutdownSessions()
      .catch((error: unknown) => console.error(`[kernel] releasing the sessions failed: ${String(error)}`))
      .then(() => closeSharedServers())
      .finally(() => process.parentPort.postMessage({ type: 'shutdown-done' }));
  }
});

console.log(`[kernel] started, agentDir=${process.env.PI_CODING_AGENT_DIR ?? '(default)'}`);
