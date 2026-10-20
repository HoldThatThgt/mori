// 读出当前选区能不能引用、引用什么（docs/v0/screens/selection.md "选区浮层"）：
// 起止都在 pi 的同一条助手回复里（data-quote-source="message"），或都在文件阅读器的内容里（data-quote-source="file"）。

import type { FeedbackRef } from '../state/feedbackForm';
import { useApp } from '../state/store';

/** @brief 一个能引用的选区。 */
export interface SelectionPick {
  /** 选区所在的会话（界面里的标识） */
  tabKey: string;
  /** 原文和来源 */
  ref: FeedbackRef;
  /** 选区（浮层定位、反馈时保持高亮） */
  range: Range;
}

/** @brief 节点所在的元素。 */
function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

/**
 * @brief 起止所在的同一个引用来源元素；不在同一个里、或一端落在界面文字上（工具卡标题、"思考"、按钮，
 *        标了 data-no-quote）时为 null。
 */
function sourceOf(range: Range): HTMLElement | null {
  const ends = [elementOf(range.startContainer), elementOf(range.endContainer)];
  if (ends.some((element) => element?.closest('[data-no-quote]'))) return null;
  const [start, end] = ends.map((element) => element?.closest<HTMLElement>('[data-quote-source]') ?? null);
  return start && start === end ? start : null;
}

/** @brief 回复里的选区：原文是选中的文字（与复制出来的一样），来源是这条助手回复。 */
function messagePick(element: HTMLElement, range: Range, text: string): SelectionPick | null {
  const tabKey = element.closest<HTMLElement>('[data-testid="chat-pane"]')?.dataset.tab;
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  const item = tab?.transcript.items.find((current) => current.key === element.dataset.itemKey);
  const quote = text.trim();
  if (!tab || item?.kind !== 'assistant' || !quote) return null;
  const source = { kind: 'message' as const, sessionFile: tab.sessionFile, entryId: item.entryId, time: item.time,
    scope: 'selection' as const };
  return { tabKey: tab.key, ref: { quote, source }, range };
}

/** @brief 一行的开头或结尾。 */
function lineEdge(line: HTMLElement | undefined, atEnd: boolean) {
  return line ? { line, column: atEnd ? (line.textContent ?? '').length : 0 } : null;
}

/**
 * @brief 选区一端在阅读器里落在哪一行、这一行的第几个字。落在两行之间（端点是装行的元素本身）时按它的下标取
 *        后一行的开头或前一行的结尾；落在内容以外（例如拖到了短文件下面的空白）时取第一行开头或最后一行结尾。
 */
function linePoint(source: HTMLElement, node: Node, offset: number, atEnd: boolean) {
  const lines = [...source.querySelectorAll<HTMLElement>('[data-line]')];
  const line = elementOf(node)?.closest<HTMLElement>('[data-line]');
  if (!line) {
    const between = node instanceof HTMLElement && node.children[0]?.matches('[data-line]');
    if (between) return atEnd ? lineEdge(node.children[offset - 1] as HTMLElement, true)
      : lineEdge(node.children[offset] as HTMLElement, false);
    return lineEdge(atEnd ? lines.at(-1) : lines[0], atEnd);
  }
  const before = document.createRange();
  before.setStart(line, 0);
  before.setEnd(node, offset);
  return { line, column: before.toString().length };
}

/** @brief 阅读器里的选区：原文按行从文件内容里取（行号不算），来源是路径、内容哈希和行范围。 */
function filePick(element: HTMLElement, range: Range): SelectionPick | null {
  const { tab: tabKey, path, sha } = element.dataset;
  const start = linePoint(element, range.startContainer, range.startOffset, false);
  let end = linePoint(element, range.endContainer, range.endOffset, true);
  if (!tabKey || !path || sha === undefined || !start || !end) return null;
  let endLine = Number(end.line.dataset.line);
  const startLine = Number(start.line.dataset.line);
  // 三击选中一整行时，选区止于下一行行首：算到上一行为止（下一行是空行时分不出来，照选区算进去）。
  if (end.column === 0 && endLine > startLine && end.line.textContent) {
    const previous = element.querySelector<HTMLElement>(`[data-line="${endLine - 1}"]`);
    if (previous) end = { line: previous, column: (previous.textContent ?? '').length };
    endLine -= 1;
  }
  const texts: string[] = [];
  for (let number = startLine; number <= endLine; number += 1) {
    const text = element.querySelector(`[data-line="${number}"]`)?.textContent ?? '';
    const from = number === startLine ? start.column : 0;
    texts.push(number === endLine ? text.slice(from, end.column) : text.slice(from));
  }
  const quote = texts.join('\n');
  if (!quote.trim()) return null;
  return { tabKey, ref: { quote, source: { kind: 'file', path, sha256: sha, startLine, endLine } }, range };
}

/** @brief 当前选区能引用时返回它，否则为 null。 */
export function readSelection(): SelectionPick | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const element = sourceOf(range);
  if (!element) return null;
  if (element.dataset.quoteSource === 'message') return messagePick(element, range, selection.toString());
  if (element.dataset.quoteSource === 'file') return filePick(element, range);
  return null;
}
