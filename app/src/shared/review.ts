// 工作回顾（方案 5.14，状态表见 docs/v0/screens/review.md）：主进程读出的两类记录、导出请求与结果的形状。
// 记录只读不改；读不出来的记录带原文交给界面，不丢掉。

import { z } from 'zod';
import type { Feedback } from './feedback';

/** @brief 两类记录：对内容的反馈（feedback/）、界面问题（ui-issues/）。 */
export const REVIEW_KINDS = ['feedback', 'issues'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** @brief 两类记录的显示名（分节按钮、详情标题、导出文件的标题和默认文件名）。 */
export const KIND_LABEL: Record<ReviewKind, string> = { feedback: '对内容的反馈', issues: '界面问题' };

/** @brief 界面问题报告的文件名（不含扩展名）：保存时刻的本地时间，同一秒内再保存时加 -2、-3（main/feedback.ts）。 */
export const ISSUE_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;

/** @brief 一份读出来的反馈。 */
export interface FeedbackRecord {
  status: 'ok';
  /** 文件名（含 .json） */
  name: string;
  /** 保存时刻（ISO，UTC）；列表按它从新到旧 */
  createdAt: string;
  /** 保存时刻的本地时间 YYYY-MM-DD HH:mm:ss（主进程按 createdAt 换算） */
  time: string;
  /** 反馈内容 */
  feedback: Feedback;
}

/** @brief 一份读出来的界面问题报告；各节是报告里的原文（去掉首尾空行）。 */
export interface IssueRecord {
  status: 'ok';
  /** 文件名（含 .md） */
  name: string;
  /** 报告标题里的本地时间 YYYY-MM-DD HH:mm:ss */
  time: string;
  /** 哪里不对 */
  what: string;
  /** 你期望什么 */
  expect: string;
  /** 截图的文件名（含 .png）；没有截图时为 null */
  shot: string | null;
  /** 没有截图时的原文（报告里的"截图失败：…"，或截图链接不是报告的截图） */
  shotError: string | null;
  /** 当前界面 */
  view: string;
  /** 最近的操作 */
  actions: string;
  /** 版本 */
  versions: string;
}

/** @brief 读不出来的记录。 */
export interface BrokenRecord {
  status: 'broken';
  /** 文件名 */
  name: string;
  /** 读不出来的原文 */
  error: string;
}

/** @brief mori:review-list 的结果：两类记录，反馈按保存时刻、报告按文件名，从新到旧。 */
export interface ReviewRecords {
  /** 对内容的反馈 */
  feedback: (FeedbackRecord | BrokenRecord)[];
  /** 界面问题 */
  issues: (IssueRecord | BrokenRecord)[];
}

/** @brief 导出请求：哪一类、按列表顺序的文件名、其中已处理的文件名。 */
export const ExportRequestSchema = z.object({
  /** 哪一类记录 */
  kind: z.enum(REVIEW_KINDS),
  /** 要导出的记录（文件名），顺序与列表相同 */
  names: z.array(z.string().min(1)).min(1),
  /** 其中已处理的 */
  handled: z.array(z.string()),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/** @brief 导出结果：写好的文件；取消时为 null。 */
export interface ExportResult {
  /** 导出文件的完整路径；你取消了保存对话框时为 null */
  file: string | null;
}
