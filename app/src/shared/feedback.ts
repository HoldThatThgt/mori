// 对内容的反馈（方案 5.10，状态表见 docs/v0/screens/selection.md "反馈"）：界面交给主进程保存的形状。
// 只记录，不发给模型；保存在主进程里完成，后台进程退出时也能记录。M7 的工作回顾读同一个文件夹。

import { z } from 'zod';
import { FileSourceSchema, MessageSourceSchema } from './protocol';

/** @brief 一份反馈。 */
export const FeedbackSchema = z.object({
  /** 你写的"希望得到什么结果" */
  expected: z.string().trim().min(1),
  /** 引用的原文 */
  quote: z.string().min(1),
  /** 锚点：回复里的选区或整轮回复，或文件里的选区 */
  source: z.discriminatedUnion('kind', [MessageSourceSchema, FileSourceSchema]),
  /** 反馈时所在的会话 */
  session: z.object({
    /** 会话文件 */
    file: z.string().nullable(),
    /** 工作目录 */
    cwd: z.string(),
    /** 会话名（与侧栏同一规则） */
    title: z.string(),
  }),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/** @brief 保存结果。 */
export interface SavedFeedback {
  /** JSON 文件的完整路径 */
  file: string;
}
