// 预加载脚本：持有通往后台进程的 MessagePort，向页面暴露 window.mori。

import { contextBridge, ipcRenderer } from 'electron';
import type { Command, EventEnvelope, KernelMessage, RequestEnvelope } from '../shared/protocol';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let port: MessagePort | null = null;
let nextId = 1;
let exitCode: number | null = null;
const pending = new Map<number, Pending>();
const queued: RequestEnvelope[] = [];
const eventListeners = new Set<(envelope: EventEnvelope) => void>();
const exitListeners = new Set<(code: number) => void>();

/** @brief 分发后台进程发来的回复与事件。 */
function dispatch(message: KernelMessage): void {
  if (message.kind === 'event') {
    for (const listener of eventListeners) listener(message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? 'Request failed'));
}

/** @brief 后台进程退出：所有未完成的请求立即失败，之后的请求也直接失败。 */
function onKernelExit(code: number): void {
  exitCode = code;
  port?.close();
  port = null;
  queued.length = 0;
  const error = new Error(`Mori kernel exited (code ${code})`);
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  for (const listener of exitListeners) listener(code);
}

ipcRenderer.on('mori:port', (event) => {
  port = event.ports[0] ?? null;
  if (!port) return;
  port.onmessage = (message) => dispatch(message.data as KernelMessage);
  for (const request of queued.splice(0)) port.postMessage(request);
});

ipcRenderer.on('mori:kernel-exit', (_event, code: number) => onKernelExit(code));

contextBridge.exposeInMainWorld('mori', {
  /** @brief 发送一条命令，返回后台进程的结果。 */
  request(command: Command): Promise<unknown> {
    if (exitCode !== null) return Promise.reject(new Error(`Mori kernel exited (code ${exitCode})`));
    return new Promise((resolve, reject) => {
      const request: RequestEnvelope = { kind: 'request', id: nextId++, command };
      pending.set(request.id, { resolve, reject });
      if (port) port.postMessage(request);
      else queued.push(request);
    });
  },
  /** @brief 订阅会话事件，返回取消订阅的函数。 */
  onEvent(listener: (envelope: EventEnvelope) => void): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  /** @brief 订阅后台进程退出；已经退出时立即回调一次。 */
  onKernelExit(listener: (code: number) => void): () => void {
    exitListeners.add(listener);
    if (exitCode !== null) queueMicrotask(() => listener(exitCode ?? -1));
    return () => exitListeners.delete(listener);
  },
  /** @brief 打开系统的选择文件夹对话框。 */
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke('mori:pick-folder');
  },
});
