// 对内容的反馈（docs/v0/screens/selection.md "反馈"）：哪个引用要反馈、表单放在哪；保存交给主进程，不发给模型。
// 开了增强的项目，反馈是这个项目每天增强的依据（docs/specs/memory.md §10.7）：表单打开时问后台进程这个项目开没开增强，
// 底部说明按它写。

import { create } from 'zustand';
import type { EnhanceInfo } from '../../../shared/memory';
import type { FileSource, MessageSource } from '../../../shared/protocol';
import { recordAction } from './actionLog';
import { describe, request as send } from './bridge';
import { useApp } from './store';

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

/** @brief 反馈表单的状态。 */
interface FeedbackFormState {
  /** 当前的反馈请求；没有时为 null */
  request: FeedbackRequest | null;
  /** 请求序号：每次打开换一个表单，写了一半的字不带到下一次；晚到的 enhance.get 结果按它丢掉 */
  seq: number;
  /**
   * 这个会话的项目开着增强（enhance.get 的结果，§10.7）；还没返回时为 null（说明留空）。会话没有项目、
   * 后台进程已退出、读取失败时为 false
   */
  enhanced: boolean | null;
}

/** @brief 当前的反馈请求、请求序号与这个项目开没开增强。 */
export const useFeedbackForm = create<FeedbackFormState>(() => ({ request: null, seq: 0, enhanced: null }));

/**
 * @brief 问后台进程这个会话的项目开没开增强（enhance.get，§10.7），结果记到第 seq 次打开的表单上（之后又打开了别的
 *        表单就丢掉）。会话没有项目、后台进程已退出时不问，按没开；读取失败（命令出错或结果带 error）同样按没开。
 */
async function readEnhanced(seq: number, cwd: string): Promise<void> {
  let enhanced = false;
  if (cwd && useApp.getState().kernel !== 'exited') {
    try {
      const info = await send<EnhanceInfo>({ type: 'enhance.get', cwd });
      if (info.error !== null) console.error(`[renderer] enhance.get returned an error: ${info.error}`);
      enhanced = info.error === null && info.enabled;
    } catch (error) {
      describe('enhance.get', error);
    }
  }
  if (useFeedbackForm.getState().seq === seq) useFeedbackForm.setState({ enhanced });
}

/**
 * @brief 打开反馈表单；range 为选区时一并高亮，表单关闭时清掉。已有一张在写的表单时不替换它（免得丢掉写了一半的字），
 *        焦点回到那张表单的输入框。打开时问这个项目开没开增强，返回之前说明留空。
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
  const seq = useFeedbackForm.getState().seq + 1;
  useFeedbackForm.setState({ request, seq, enhanced: null });
  const cwd = useApp.getState().tabs.find((tab) => tab.key === request.tabKey)?.cwd ?? '';
  void readEnhanced(seq, cwd);
}

/** @brief 关闭反馈表单，焦点还给打开前的元素。 */
export function closeFeedback(): void {
  const focus = useFeedbackForm.getState().request?.returnFocus;
  CSS.highlights.delete(QUOTE_HIGHLIGHT);
  useFeedbackForm.setState({ request: null });
  if (focus?.isConnected) focus.focus({ preventScroll: true });
}
