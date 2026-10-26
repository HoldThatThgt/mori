// 引用芯片（docs/v0/screens/selection.md）：芯片上的来源、发给模型的引用块、从你的消息里认出引用块、
// 加进输入框、点芯片回到原位置（回复里的引用交给对话流，文件里的引用交给右栏的阅读器），以及点过之后的检查结果。

import { create } from 'zustand';
import type { FileSource, MessageSource, QuoteRef } from '../../../shared/protocol';
import { recordAction } from './actionLog';
import type { Item, Transcript } from './model';
import { jumpToSession } from './refActions';
import { updateTab, useApp, type QuoteJump } from './store';

// 引用的文字在 quoteText.ts（纯函数，录制脚本也用它）。
export { composePrompt, excerpt, quoteBlock, refLabel, stripQuotes } from './quoteText';

/**
 * @brief 来源的状态："Source changed" / "File not found"（点芯片之后查出来的，记在这里）/ "Session deleted"
 *        （会话引用，按会话列表算出来，不记在这里）；没有问题时不记。
 */
export type QuoteStatus = 'changed' | 'missing' | 'gone';

/** @brief 点过的芯片的检查结果（按 refKey），只在这次运行的内存里。 */
export const useQuoteStatus = create<Record<string, QuoteStatus>>(() => ({}));

/** @brief 记下或清掉一个芯片的检查结果。 */
export function setQuoteStatus(key: string, status: QuoteStatus | null): void {
  useQuoteStatus.setState((state) => {
    if ((state[key] ?? null) === status) return state;
    const { [key]: _old, ...rest } = state;
    return status ? { ...rest, [key]: status } : rest;
  }, true);
}

/** @brief 芯片的标识：来源加原文（判重、记检查结果）。 */
export function refKey(ref: QuoteRef): string {
  return JSON.stringify([ref.source, ref.quote]);
}

/** @brief 加一个引用芯片到会话的输入框；来源和原文都一样的不再加。 */
export function addQuote(tabKey: string, ref: QuoteRef): void {
  // 会话引用在开始读原会话时已经记过（refActions.ts referenceSession）。
  if (ref.source.kind !== 'session') {
    recordAction(ref.source.kind === 'file' ? 'Attach as context (file)' : 'Attach as context (response)');
  }
  updateTab(tabKey, (tab) => (tab.draftRefs.some((item) => refKey(item) === refKey(ref)) ? tab
    : { ...tab, draftRefs: [...tab.draftRefs, ref] }));
}

/** @brief 从输入框去掉一个引用芯片。 */
export function removeQuote(tabKey: string, ref: QuoteRef): void {
  updateTab(tabKey, (tab) => ({ ...tab, draftRefs: tab.draftRefs.filter((item) => refKey(item) !== refKey(ref)) }));
}

/** @brief 对话流里这个来源指向的那条助手回复的下标：先按条目 id，再按消息时间；找不到时为 -1。 */
export function findSourceIndex(items: Item[], source: MessageSource): number {
  return items.findIndex((item) => item.kind === 'assistant'
    && ((source.entryId !== null && item.entryId === source.entryId)
      || (source.time !== null && item.time === source.time)));
}

/** 在文件里找原文时最多看几处（防止很短的原文在大文件里出现太多次） */
const SEARCH_MAX = 1000;

/** @brief 文件内容按行拆开（换行统一成 \n；最后的换行不算多一行）。 */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** @brief 第 line 行（从 1 起）开头在内容里的位置。 */
function lineOffset(content: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = content.indexOf('\n', offset);
    if (next < 0) return offset;
    offset = next + 1;
  }
  return offset;
}

/**
 * @brief 文件引用现在在哪几行（docs/v0/screens/selection.md "Jump to source"）：内容哈希没变时就是原来的行；
 *        变了时在文件里找原文，取离原来的行最近的一处；找不到（原文已变化）时为 null。
 */
export function locateFileQuote(text: string, sha256: string, source: FileSource,
  quote: string): { start: number; end: number } | null {
  const content = text.replace(/\r\n/g, '\n');
  if (sha256 === source.sha256) {
    const count = splitLines(content).length;
    return { start: Math.min(source.startLine, count), end: Math.min(source.endLine, count) };
  }
  const target = quote.replace(/\r\n/g, '\n');
  const origin = lineOffset(content, source.startLine);
  let best = -1;
  let found = content.indexOf(target);
  for (let seen = 0; found >= 0 && seen < SEARCH_MAX; seen += 1) {
    if (best < 0 || Math.abs(found - origin) < Math.abs(best - origin)) best = found;
    found = content.indexOf(target, found + 1);
  }
  if (best < 0) return null;
  const start = content.slice(0, best).split('\n').length;
  return { start, end: start + target.split('\n').length - 1 };
}

let jumpNonce = 0;

/** @brief 新的跳转请求。 */
export function nextJump(ref: QuoteRef): QuoteJump {
  jumpNonce += 1;
  return { ref, nonce: jumpNonce };
}

/** @brief 在右栏打开文件阅读器；ref 为打开它的文件引用芯片（跳到引用的行），从路径或改动列表打开时为 null。 */
export function openFile(tabKey: string, path: string, ref: QuoteRef | null = null): void {
  recordAction(ref ? 'Open file from attached context' : 'Open file');
  jumpNonce += 1;
  const jump = ref ? { ref, nonce: jumpNonce } : null;
  // 文件阅读器属于 Changes 一栏（平行 Agent 规格 §13.13.1）
  updateTab(tabKey, (tab) => ({ ...tab, rightOpen: true, rightTab: 'changes',
    rightView: { kind: 'file', path, jump, nonce: jumpNonce } }));
}

/** @brief 右栏回到改动列表。 */
export function showChanges(tabKey: string): void {
  updateTab(tabKey, (tab) => ({ ...tab, rightView: { kind: 'changes' } }));
}

/** @brief 右栏的"Expand" / "Collapse"（docs/v0/screens/layout.md"右栏展开"）。 */
export function setRightExpanded(tabKey: string, expanded: boolean): void {
  recordAction(expanded ? 'Expand right panel' : 'Collapse right panel');
  updateTab(tabKey, (tab) => ({ ...tab, rightExpanded: expanded }));
}

/**
 * @brief "Attach as context"之后：这个会话的右栏展开着时收回，让芯片和输入框看得见（它们在藏起的中栏里，
 *        docs/v0/screens/layout.md"右栏展开"）。
 * @return 是否收回了（收回时输入框要等这一次重画之后才能拿到焦点）
 */
export function collapseForComposer(tabKey: string): boolean {
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  if (!tab?.rightExpanded) return false;
  setRightExpanded(tabKey, false);
  return true;
}

/** @brief 这条助手回复所在一轮的开头（你的消息）的下标：载入时从这里开始，让这一轮完整可见。 */
function turnStart(transcript: Transcript, index: number): number {
  for (let current = index; current >= 0; current -= 1) {
    if (transcript.items[current]?.kind === 'user') return current;
  }
  return 0;
}

/**
 * @brief 点芯片回到原位置。文件里的引用在右栏打开阅读器（阅读器检查原文）；回复里的引用找到那条回复，
 *        不在已载入范围时先载入到它所在的一轮，再交给对话流滚过去高亮；找不到时标"Source changed"。
 */
export function jumpToQuote(tabKey: string, ref: QuoteRef): void {
  if (ref.source.kind === 'file') {
    openFile(tabKey, ref.source.path, ref);
    return;
  }
  if (ref.source.kind === 'session') {
    void jumpToSession(tabKey, ref);
    return;
  }
  recordAction('Jump to response from attached context');
  const tab = useApp.getState().tabs.find((item) => item.key === tabKey);
  if (!tab) return;
  const index = findSourceIndex(tab.transcript.items, ref.source);
  const item = tab.transcript.items[index];
  if (!item) {
    setQuoteStatus(refKey(ref), 'changed');
    return;
  }
  setQuoteStatus(refKey(ref), null);
  const start = Math.min(tab.startIndex, turnStart(tab.transcript, index));
  updateTab(tabKey, (current) => ({ ...current, startIndex: start,
    transcriptJump: { ...nextJump(ref), itemKey: item.key } }));
}
