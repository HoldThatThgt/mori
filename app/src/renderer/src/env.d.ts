// window.mori 的类型，与 preload 暴露的接口一致。

import type { Command, EventEnvelope, GlobalEventEnvelope } from '../../shared/protocol';
import type { Feedback, SavedFeedback } from '../../shared/feedback';
import type { FileRead } from '../../shared/files';
import type { IssueReport, SavedIssue, WindowCapture } from '../../shared/issues';
import type { ExportRequest, ExportResult, ReviewKind, ReviewRecords } from '../../shared/review';

declare global {
  interface Window {
    mori: {
      request<T = unknown>(command: Command): Promise<T>;
      /** 会话事件，以及 sessionId 为 null 的全局事件（模型层 §9.5） */
      onEvent(listener: (envelope: EventEnvelope | GlobalEventEnvelope) => void): () => void;
      onKernelExit(listener: (code: number) => void): () => void;
      onKernelReady(listener: () => void): () => void;
      restartKernel(): Promise<void>;
      pickFolder(): Promise<string | null>;
      /** 删除会话：永久删除会话文件；文件还不存在时 deleted 为 false，删不掉时 error 为原文 */
      deleteSessionFile(file: string): Promise<{ deleted: boolean; error: string | null }>;
      /** 窗口不在前台时让任务栏按钮闪烁，窗口获得焦点后停止（批准卡） */
      requestAttention(): Promise<void>;
      /** F8：截下当前窗口 */
      captureWindow(): Promise<WindowCapture>;
      /** F8：保存一份界面问题报告 */
      saveIssue(report: IssueReport): Promise<SavedIssue>;
      /** F8：在资源管理器里选中已保存的报告 */
      showIssueInFolder(file: string): Promise<void>;
      /** 文件阅读器：按 pi 工具的规则（相对 cwd）解析路径，只读地读出文件 */
      readFile(path: string, cwd: string): Promise<FileRead>;
      /** 用系统默认程序打开文件；失败时 error 为原文；会被运行的文件改为在资源管理器里选中（revealed） */
      openPath(path: string, cwd: string): Promise<{ error: string | null; revealed: boolean }>;
      /** 把文字写进系统剪贴板（回复下的"Copy"） */
      copyText(text: string): Promise<void>;
      /** 保存一份对内容的反馈（只记录，不发给模型） */
      saveFeedback(feedback: Feedback): Promise<SavedFeedback>;
      /** 工作回顾：读出对内容的反馈和界面问题报告 */
      listReview(): Promise<ReviewRecords>;
      /** 工作回顾：一份报告的截图（data URL） */
      reviewShot(name: string): Promise<string>;
      /** 工作回顾：导出为 Markdown（弹保存对话框）；取消时 file 为 null */
      exportReview(request: ExportRequest): Promise<ExportResult>;
      /** 工作回顾：在资源管理器里选中刚导出的文件 */
      showExport(file: string): Promise<void>;
      /** 工作回顾：在资源管理器里选中一份记录（文件名） */
      showReviewRecord(kind: ReviewKind, name: string): Promise<void>;
      /** 工作回顾：在资源管理器里打开一类记录的文件夹；打不开时 error 为原文 */
      openReviewFolder(kind: ReviewKind): Promise<{ error: string | null }>;
    };
  }
}

export {};
