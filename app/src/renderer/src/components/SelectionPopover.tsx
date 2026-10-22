// 选区浮层（docs/v0/screens/selection.md）：用鼠标在助手回复或文件阅读器里选中文字后，选区上方出现
// "Attach as context"和"Feedback"。照 Claude 桌面版：点了之后选区清除；"Attach as context"把引用芯片放进输入框、
// 焦点到输入框末尾。在根组件旁挂一次。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openFeedback, useFeedbackForm } from '../state/feedbackForm';
import { useOverlay } from '../state/overlays';
import { addQuote } from '../state/quotes';
import { readSelection, type SelectionPick } from './selectionSource';

/** 浮层离选区和窗口边缘的距离（px） */
const GAP = 8;
const MARGIN = 12;

/** @brief 选区所在的可滚动区域（对话流或阅读器）在视口里的范围；找不到时是整个窗口。 */
function paneRect(range: Range): { top: number; bottom: number } {
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const pane = element?.closest('.conversation, .file-scroll');
  return pane ? pane.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
}

/** @brief 浮层的位置：选区上方，放不下时下方；选区滚出它所在的区域时为 null（隐藏）。 */
function placement(range: Range, box: HTMLElement | null): { left: number; top: number } | null {
  const rect = range.getBoundingClientRect();
  const pane = paneRect(range);
  if (rect.width + rect.height === 0 || rect.bottom < pane.top || rect.top > pane.bottom) return null;
  const width = box?.offsetWidth ?? 0;
  const height = box?.offsetHeight ?? 0;
  const top = rect.top - height - GAP >= MARGIN ? rect.top - height - GAP : rect.bottom + GAP;
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
  return { left, top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)) };
}

/** @brief 把焦点放到会话输入框的末尾。 */
export function focusComposer(tabKey: string): void {
  const input = document.querySelector<HTMLTextAreaElement>(
    `[data-testid="chat-pane"][data-tab="${tabKey}"] .composer textarea`);
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** @brief 跟着选区：鼠标松开时读一次选区，选区清空时收起；滚动、窗口变化时重新定位。 */
function useSelectionPick() {
  const [pick, setPick] = useState<SelectionPick | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (box.current?.contains(event.target as Node)) return;
      // 等浏览器把这次点击的选区定下来再读（单击清空选区也在这之后）。
      setTimeout(() => setPick(readSelection()), 0);
    };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setPick(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);
  const place = useCallback(() => setPosition(pick ? placement(pick.range, box.current) : null), [pick]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    if (!pick) return;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [pick, place]);
  return { pick, setPick, box, position };
}

/** @brief 选区浮层；反馈表单开着时不出（先写完或关掉那一张）。 */
export function SelectionPopover() {
  const { pick, setPick, box, position } = useSelectionPick();
  const formOpen = useFeedbackForm((state) => state.request !== null);
  const dismiss = () => {
    window.getSelection()?.removeAllRanges();
    setPick(null);
  };
  useOverlay(pick !== null && !formOpen, dismiss, false);
  if (!pick || formOpen) return null;
  const ask = () => {
    addQuote(pick.tabKey, pick.ref);
    dismiss();
    focusComposer(pick.tabKey);
  };
  const feedback = () => {
    const rect = pick.range.getBoundingClientRect();
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openFeedback({ tabKey: pick.tabKey, ref: pick.ref, anchor: rect, returnFocus }, pick.range.cloneRange());
    dismiss();
  };
  return (
    <div ref={box} className="selection-popover" role="toolbar" aria-label="Selected text"
      data-testid="selection-popover"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999,
        visibility: position ? 'visible' : 'hidden' }}
      onMouseDown={(event) => event.preventDefault()}>
      <button onClick={ask}>Attach as context</button>
      <button onClick={feedback}>Feedback</button>
    </div>
  );
}
