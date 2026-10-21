// 对内容的反馈（docs/v0/screens/selection.md "反馈"）：哪个引用要反馈、表单放在哪；保存交给主进程，只记录、不发给模型。

import { create } from 'zustand';
import type { FileSource, MessageSource } from '../../../shared/protocol';
import { recordAction } from './actionLog';

/** 反馈时保持选区高亮用的 CSS 高亮名（表单里的输入框拿走焦点后，原来的选区就看不见了） */
export const QUOTE_HIGHLIGHT = 'mori-quote';

/** @brief 能反馈的引用：回复或文件里的（会话引用不能反馈）。 */
export interface FeedbackRef {
  /** 原文 */
  quote: string;
  /** 来源 */
  source: MessageSource | FileSource;
}

/** @brief 一次反馈请求。 */
export interface FeedbackRequest {
  /** 所在的会话（界面里的标识） */
  tabKey: string;
  /** 引用的原文和来源 */
  ref: FeedbackRef;
  /** 表单放在这个矩形附近（选区或按钮） */
  anchor: { left: number; top: number; bottom: number };
  /** 打开前有焦点的元素，关闭后还给它 */
  returnFocus: HTMLElement | null;
}

/** @brief 当前的反馈请求（没有时为 null）和请求序号（每次打开换一个表单，写了一半的字不带到下一次）。 */
export const useFeedbackForm = create<{ request: FeedbackRequest | null; seq: number }>(() => ({ request: null,
  seq: 0 }));

/**
 * @brief 打开反馈表单；range 为选区时一并高亮，表单关闭时清掉。已有一张在写的表单时不替换它（免得丢掉写了一半的字），
 *        焦点回到那张表单的输入框。
 */
export function openFeedback(request: FeedbackRequest, range: Range | null): void {
  const editing = document.querySelector<HTMLTextAreaElement>('[data-testid="feedback-input"]');
  if (useFeedbackForm.getState().request && editing) {
    editing.focus();
    return;
  }
  const { source } = request.ref;
  recordAction(source.kind === 'message' && source.scope === 'reply' ? 'Give feedback on response'
    : 'Give feedback on selection');
  CSS.highlights.delete(QUOTE_HIGHLIGHT);
  if (range) CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(range));
  useFeedbackForm.setState((state) => ({ request, seq: state.seq + 1 }));
}

/** @brief 关闭反馈表单，焦点还给打开前的元素。 */
export function closeFeedback(): void {
  const focus = useFeedbackForm.getState().request?.returnFocus;
  CSS.highlights.delete(QUOTE_HIGHLIGHT);
  useFeedbackForm.setState({ request: null });
  if (focus?.isConnected) focus.focus({ preventScroll: true });
}
