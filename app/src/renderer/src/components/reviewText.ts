// 工作回顾的文字（docs/v0/screens/review.md "一行摘要"、"详情"）：记录的时间（列表里的短格式、详情里的完整格式）、
// 反馈的范围（Selection in response / Whole response / 文件和行范围）、界面问题的摘要。纯函数，不碰界面状态。

import type { Feedback } from '../../../shared/feedback';
import type { FeedbackRecord, IssueRecord } from '../../../shared/review';
import { lineText } from '../state/quoteText';
import { displayPath } from './toolTitle';

/** 报告里没有填写的一节（main/feedback.ts written 写的同一串） */
const EMPTY_FIELD = '(left blank)';

/**
 * @brief 记录的时间文字：主进程读出时给的本地时间 YYYY-MM-DD HH:mm:ss（反馈按保存时刻换算，报告是标题里的时间）。
 * @param full 为真时是详情里的完整时间；否则是列表里的"10-20 14:03"，不是今年的带年份"2025-10-20 14:03"
 */
export function recordTime(record: FeedbackRecord | IssueRecord, full: boolean): string {
  if (full) return record.time;
  const thisYear = record.time.startsWith(`${new Date().getFullYear()}-`);
  return record.time.slice(thisYear ? 5 : 0, 16);
}

/**
 * @brief 反馈的范围："Selection in response" / "Whole response" / "<相对路径> · lines a–b"（同引用芯片；
 *        不在工作目录里的显示完整路径）。
 */
export function feedbackScope(feedback: Feedback): string {
  const { source, session } = feedback;
  if (source.kind === 'message') return source.scope === 'selection' ? 'Selection in response' : 'Whole response';
  return `${displayPath(source.path, session.cwd)} · ${lineText(source.startLine, source.endLine)}`;
}

/** @brief 界面问题的摘要："What went wrong"；没有填写时用"What you expected"。 */
export function issueTitle(record: IssueRecord): string {
  return record.what === EMPTY_FIELD ? record.expect : record.what;
}
