// window.mori 的类型，与 preload 暴露的接口一致。

import type { Command, EventEnvelope } from '../../shared/protocol';
import type { IssueReport, SavedIssue, WindowCapture } from '../../shared/issues';

declare global {
  interface Window {
    mori: {
      request<T = unknown>(command: Command): Promise<T>;
      onEvent(listener: (envelope: EventEnvelope) => void): () => void;
      onKernelExit(listener: (code: number) => void): () => void;
      onKernelReady(listener: () => void): () => void;
      restartKernel(): Promise<void>;
      pickFolder(): Promise<string | null>;
      /** 窗口不在前台时让任务栏按钮闪烁，窗口获得焦点后停止（批准卡） */
      requestAttention(): Promise<void>;
      /** F8：截下当前窗口 */
      captureWindow(): Promise<WindowCapture>;
      /** F8：保存一份界面问题报告 */
      saveIssue(report: IssueReport): Promise<SavedIssue>;
      /** F8：在资源管理器里选中已保存的报告 */
      showIssueInFolder(file: string): Promise<void>;
    };
  }
}

export {};
