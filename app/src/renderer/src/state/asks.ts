// 提问卡（ask_user_question，docs/specs/file-system-permissions.md §10；状态表 docs/v1/screens/fs-question.md）的界面状态：
// 扩展询问与提问卡排成一个询问卡队列（按到达顺序，一次显示一张），以及卡上的选择换成 question.answer 的答复。纯函数，
// 由 transcript.ts（实时事件）、history.ts（界面重新载入后接上）与卡片调用；发命令在 actions.ts 的 answerAsk。

import type { Command, UiRequest } from '../../../shared/protocol';
import type { AskQuestion, AskRequest } from '../../../shared/workspace';
import type { PendingAsk, PendingExtensionQuestion, PendingQuestion } from './model';

/** @brief question.answer 里一个问题的答复：选中的 label（按选项的顺序）与 Other 里的文字（没填为 null）。 */
export type AskReply = NonNullable<Extract<Command, { type: 'question.answer' }>['answers']>[number];

/** @brief Other 输入框最多的字数：后台进程按去掉首尾空白后 1–2000 字符核对（§10.5）。 */
export const ASK_OTHER_MAX = 2000;

/** @brief 一个问题在卡上的选择（卡自己的草稿，提交前不发给后台进程，到时也不用它，§9.4）。 */
export interface AskChoice {
  /** 选中的 label；单选时至多一个 */
  selected: string[];
  /** 选了 Other 时输入框里的文字（可以还是空的）；没选 Other 时为 null */
  other: string | null;
}

/** @brief 扩展询问（mori.ui_request）进询问卡队列：还没在计时。 */
export function pendingExtension(request: UiRequest): PendingExtensionQuestion {
  return { ...request, kind: 'extension', deadline: null };
}

/** @brief 提问卡（mori.question_request）进询问卡队列：还没在计时。 */
export function pendingAsk(request: AskRequest): PendingAsk {
  return { ...request, kind: 'ask', deadline: null };
}

/**
 * @brief 界面重新载入后接上（LiveSnapshot.questions、LiveSnapshot.asks）：两种按提出的时刻排成一个队列，
 *        同一时刻的扩展询问在前（排序是稳定的）。两者的 askedAt 都是后台进程的时钟。
 */
export function liveQuestions(questions: readonly UiRequest[], asks: readonly AskRequest[]): PendingQuestion[] {
  const all: PendingQuestion[] = [...questions.map(pendingExtension), ...asks.map(pendingAsk)];
  return all.sort((a, b) => a.askedAt - b.askedAt);
}

/**
 * @brief 一个问题的答复：选中的 label 按选项的顺序，Other 去掉首尾空白（空白算没填）。单选时选项与 Other 合起来
 *        恰好一个，多选时至少一个（后台进程按同样的规则核对，§10.5）。
 * @return 还没答完（或 Other 超过 ASK_OTHER_MAX）时为 null
 */
function replyOf(question: AskQuestion, choice: AskChoice | undefined): AskReply | null {
  if (!choice) return null;
  const selected = question.options.map((option) => option.label).filter((label) => choice.selected.includes(label));
  const other = choice.other?.trim() || null;
  const count = selected.length + (other === null ? 0 : 1);
  if (count === 0 || (!question.multiSelect && count > 1)) return null;
  if (other !== null && other.length > ASK_OTHER_MAX) return null;
  return { selected, other };
}

/**
 * @brief 卡上的选择换成 question.answer 的 answers（按问题的顺序）；每个问题都答了（选了选项，或 Other 里有非空文字）
 *        才有结果，Submit 据此可用（§10.4）。
 * @param choices 每个问题的选择，与 questions 同序
 * @return 有问题没答完时为 null
 */
export function askReply(questions: readonly AskQuestion[], choices: readonly AskChoice[]): AskReply[] | null {
  const replies: AskReply[] = [];
  for (const [index, question] of questions.entries()) {
    const reply = replyOf(question, choices[index]);
    if (!reply) return null;
    replies.push(reply);
  }
  return replies;
}
