// 预加载脚本：持有通往后台进程的 MessagePort，向页面暴露 window.mori。

import { contextBridge, ipcRenderer } from 'electron';
import type {
  Command, EventEnvelope, GlobalEventEnvelope, KernelMessage, RequestEnvelope,
} from '../shared/protocol';
import type { Feedback, SavedFeedback } from '../shared/feedback';
import type { FileRead } from '../shared/files';
import type { IssueReport, SavedIssue, WindowCapture } from '../shared/issues';
import type { ExportRequest, ExportResult, IssueItem } from '../shared/issueRecords';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let port: MessagePort | null = null;
let nextId = 1;
let exitCode: number | null = null;
const pending = new Map<number, Pending>();
const queued: RequestEnvelope[] = [];
/** 后台进程发来的事件：会话事件，或不属于某个会话的全局事件（sessionId 为 null，模型层 §9.5） */
type AnyEventEnvelope = EventEnvelope | GlobalEventEnvelope;
const eventListeners = new Set<(envelope: AnyEventEnvelope) => void>();
const exitListeners = new Set<(code: number) => void>();
const readyListeners = new Set<() => void>();

/** @brief 分发后台进程发来的回复与事件；会话事件与全局事件都交给事件订阅者，由订阅者按 sessionId 区分。 */
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
  const error = new Error(`Mori’s background process crashed (exit code ${code})`);
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  for (const listener of exitListeners) listener(code);
}

ipcRenderer.on('mori:port', (event) => {
  port?.close();
  port = event.ports[0] ?? null;
  if (!port) return;
  // 新通道（启动或重新载入后）：之前的退出状态作废。
  exitCode = null;
  port.onmessage = (message) => dispatch(message.data as KernelMessage);
  for (const request of queued.splice(0)) port.postMessage(request);
  for (const listener of readyListeners) listener();
});

ipcRenderer.on('mori:kernel-exit', (_event, code: number) => onKernelExit(code));

contextBridge.exposeInMainWorld('mori', {
  /** @brief 发送一条命令，返回后台进程的结果。 */
  request(command: Command): Promise<unknown> {
    if (exitCode !== null) {
      return Promise.reject(new Error(`Mori’s background process crashed (exit code ${exitCode})`));
    }
    return new Promise((resolve, reject) => {
      const request: RequestEnvelope = { kind: 'request', id: nextId++, command };
      pending.set(request.id, { resolve, reject });
      if (port) port.postMessage(request);
      else queued.push(request);
    });
  },
  /** @brief 订阅后台进程的事件（会话事件与 sessionId 为 null 的全局事件），返回取消订阅的函数。 */
  onEvent(listener: (envelope: AnyEventEnvelope) => void): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  /** @brief 订阅后台进程退出；已经退出时立即回调一次。 */
  onKernelExit(listener: (code: number) => void): () => void {
    exitListeners.add(listener);
    if (exitCode !== null) queueMicrotask(() => listener(exitCode ?? -1));
    return () => exitListeners.delete(listener);
  },
  /** @brief 订阅"通道已连上"（启动或重新载入后）；已经连上时立即回调一次。 */
  onKernelReady(listener: () => void): () => void {
    readyListeners.add(listener);
    if (port) queueMicrotask(listener);
    return () => readyListeners.delete(listener);
  },
  /** @brief 后台进程退出后重新启动它；新通道连上时触发 onKernelReady。 */
  restartKernel(): Promise<void> {
    return ipcRenderer.invoke('mori:restart-kernel');
  },
  /** @brief 打开系统的选择文件夹对话框。 */
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke('mori:pick-folder');
  },
  /** @brief 删除会话：永久删除会话文件；文件还不存在时 deleted 为 false，删不掉时 error 为原文。 */
  deleteSessionFile(file: string): Promise<{ deleted: boolean; error: string | null }> {
    return ipcRenderer.invoke('mori:delete-session', file);
  },
  /** @brief 窗口不在前台时让任务栏按钮闪烁，窗口获得焦点后停止（批准卡）。 */
  requestAttention(): Promise<void> {
    return ipcRenderer.invoke('mori:attention');
  },
  /** @brief F8：截下当前窗口。 */
  captureWindow(): Promise<WindowCapture> {
    return ipcRenderer.invoke('mori:capture-window');
  },
  /** @brief F8：保存一份界面问题报告，返回 Markdown 文件的路径。 */
  saveIssue(report: IssueReport): Promise<SavedIssue> {
    return ipcRenderer.invoke('mori:save-issue', report);
  },
  /** @brief F8：在资源管理器里选中已保存的报告。 */
  showIssueInFolder(file: string): Promise<void> {
    return ipcRenderer.invoke('mori:show-issue', file);
  },
  /** @brief 文件阅读器：按 pi 工具的规则（相对 cwd）解析路径，只读地读出文件。 */
  readFile(path: string, cwd: string): Promise<FileRead> {
    return ipcRenderer.invoke('mori:read-file', path, cwd);
  },
  /** @brief 用系统默认程序打开文件；失败时 error 为原文；会被运行的文件改为在资源管理器里选中（revealed）。 */
  openPath(path: string, cwd: string): Promise<{ error: string | null; revealed: boolean }> {
    return ipcRenderer.invoke('mori:open-path', path, cwd);
  },
  /** @brief 把文字写进系统剪贴板（回复下的"Copy"）。 */
  copyText(text: string): Promise<void> {
    return ipcRenderer.invoke('mori:copy-text', text);
  },
  /** @brief 保存一份对内容的反馈（开了增强的项目作为增强的依据），返回 JSON 文件的路径。 */
  saveFeedback(feedback: Feedback): Promise<SavedFeedback> {
    return ipcRenderer.invoke('mori:save-feedback', feedback);
  },
  /** @brief 设置页的 UI issues：读出界面问题报告（按保存时刻从新到旧）。 */
  listIssues(): Promise<IssueItem[]> {
    return ipcRenderer.invoke('mori:issues-list');
  },
  /** @brief UI issues：一份报告的截图（data URL）。 */
  issueShot(name: string): Promise<string> {
    return ipcRenderer.invoke('mori:issues-shot', name);
  },
  /** @brief UI issues：导出为 Markdown（弹保存对话框）；取消时 file 为 null。 */
  exportIssues(request: ExportRequest): Promise<ExportResult> {
    return ipcRenderer.invoke('mori:issues-export', request);
  },
  /** @brief UI issues：在资源管理器里选中刚导出的文件。 */
  showExport(file: string): Promise<void> {
    return ipcRenderer.invoke('mori:issues-show-export', file);
  },
  /** @brief UI issues：在资源管理器里选中一份报告（文件名）。 */
  showIssueRecord(name: string): Promise<void> {
    return ipcRenderer.invoke('mori:issues-show-record', name);
  },
  /** @brief UI issues：在资源管理器里打开报告文件夹；打不开时 error 为原文。 */
  openIssuesFolder(): Promise<{ error: string | null }> {
    return ipcRenderer.invoke('mori:issues-open-folder');
  },
});
