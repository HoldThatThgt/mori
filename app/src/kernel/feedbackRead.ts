// 增强任务读的反馈（docs/specs/memory.md §9.5 第 2 条）：<userData>/feedback/*.json（主进程 main/feedback.ts 写的，
// 形状为 shared/feedback.ts 的 StoredFeedbackSchema）。选出会话工作目录与项目完全相同、createdAt 落在这一天里、
// 晚于这个任务已经读过的最晚一条（feedbackSeen）的反馈，按 createdAt 排序。读不出来的文件跳过并记日志。

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StoredFeedbackSchema } from '../shared/feedback';
import type { ListedFeedback } from './memoryText';

/** @brief 反馈文件夹里的 JSON 文件名；文件夹还不存在（从没写过反馈）时为空，别的错误记日志后为空。 */
async function feedbackNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] cannot read the feedback folder ${dir}: ${(error as Error).message}`);
    }
    return [];
  }
}

/** @brief 读一份反馈；读不出来或形状不对时记日志并返回 null。 */
async function readFeedback(dir: string, name: string): Promise<ListedFeedback | null> {
  try {
    const parsed = StoredFeedbackSchema.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')));
    if (parsed.success) return { name, feedback: parsed.data };
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    console.error(`[kernel] feedback ${name} skipped: ${issues}`);
  } catch (error) {
    console.error(`[kernel] feedback ${name} skipped: ${(error as Error).message}`);
  }
  return null;
}

/**
 * @brief 一次增强运行要交给任务的反馈（§9.5 第 2 条）：`session.cwd` 与 `cwd` 完全相同、`createdAt` 在 [from, to) 里、
 *        晚于 `seenAfter`；按 `createdAt` 从早到晚（同一时刻按文件名）。
 * @param userData Mori 的数据目录（反馈在它的 `feedback/` 下）
 * @param cwd 项目的工作目录
 * @param from 日子 D 开始的时刻（ms）
 * @param to 日子 D 结束的时刻（ms，不含）
 * @param seenAfter 这个任务已经读过的反馈里最晚的 `createdAt`（ISO）；没有时为 null。不是时刻时抛错
 *        （否则会把所有反馈都当成读过，悄悄丢掉）
 */
export async function dayFeedback(userData: string, cwd: string, from: number, to: number,
  seenAfter: string | null): Promise<ListedFeedback[]> {
  const dir = join(userData, 'feedback');
  const seen = seenAfter === null ? null : Date.parse(seenAfter);
  if (Number.isNaN(seen)) throw new Error(`Invalid feedbackSeen: ${seenAfter}`);
  const listed: { item: ListedFeedback; at: number }[] = [];
  for (const name of await feedbackNames(dir)) {
    const item = await readFeedback(dir, name);
    if (!item || item.feedback.session.cwd !== cwd) continue;
    const at = Date.parse(item.feedback.createdAt);
    if (at < from || at >= to || (seen !== null && at <= seen)) continue;
    listed.push({ item, at });
  }
  return listed.sort((a, b) => a.at - b.at || a.item.name.localeCompare(b.item.name)).map(({ item }) => item);
}
