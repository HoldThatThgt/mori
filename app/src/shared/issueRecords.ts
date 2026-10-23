// 设置页的 UI issues（docs/specs/memory.md §10.8，原 M7 工作回顾的界面问题部分，docs/v0/screens/review.md）：
// 主进程读出的界面问题报告、导出请求与结果的形状。报告只读不改；读不出来的报告带原文交给界面，不丢掉。

import { z } from 'zod';

/** @brief 界面问题报告的文件名（不含扩展名）：保存时刻的本地时间，同一秒内再保存时加 -2、-3（main/feedback.ts）。 */
export const ISSUE_NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;

/** @brief 一份读出来的界面问题报告；各节是报告里的原文（去掉首尾空行）。 */
export interface IssueRecord {
  status: 'ok';
  /** 文件名（含 .md） */
  name: string;
  /** 报告标题里的本地时间 YYYY-MM-DD HH:mm:ss */
  time: string;
  /** "What went wrong"一节 */
  what: string;
  /** "What you expected"一节 */
  expect: string;
  /** 截图的文件名（含 .png）；没有截图时为 null */
  shot: string | null;
  /** 没有截图时的原文（报告里"Couldn’t capture a screenshot: …"去掉前缀后的原文，或截图链接不是报告的截图） */
  shotError: string | null;
  /** "Current view"一节 */
  view: string;
  /** "Recent activity"一节 */
  actions: string;
  /** "Versions"一节 */
  versions: string;
}

/** @brief 读不出来的报告。 */
export interface BrokenRecord {
  status: 'broken';
  /** 文件名 */
  name: string;
  /** 读不出来的原文 */
  error: string;
}

/** @brief 列表里的一份报告：读出来的，或读不出来的。mori:issues-list 的结果按文件名（保存时刻）从新到旧。 */
export type IssueItem = IssueRecord | BrokenRecord;

/** @brief 导出请求：按列表顺序的文件名、其中已处理的文件名。 */
export const ExportRequestSchema = z.object({
  /** 要导出的报告（文件名），顺序与列表相同 */
  names: z.array(z.string().min(1)).min(1),
  /** 其中已处理的 */
  handled: z.array(z.string()),
});
/** @brief 导出请求（mori:issues-export 的参数）。 */
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/** @brief 导出结果：写好的文件；取消时为 null。 */
export interface ExportResult {
  /** 导出文件的完整路径；你取消了保存对话框时为 null */
  file: string | null;
}
