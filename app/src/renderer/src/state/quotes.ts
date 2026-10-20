// 引用芯片（docs/v0/screens/selection.md）：芯片上的来源、发给模型的引用块、从你的消息里认出引用块、
// 加进输入框、点芯片回到原位置（回复里的引用交给对话流，文件里的引用交给右栏的阅读器），以及点过之后的检查结果。

import { create } from 'zustand';
import type { FileSource, MessageSource, QuoteRef } from '../../../shared/protocol';
import { displayPath } from '../components/toolTitle';
import { recordAction } from './actionLog';
import type { Item, Transcript } from './model';
import { updateTab, useApp, type QuoteJump } from './store';

/** @brief 点芯片之后查出来的来源状态：原文已变化 / 文件已被删除或移动；没有问题时不记。 */
export type QuoteStatus = 'changed' | 'missing';

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

/** @brief 行范围的文字："第 3 行"或"第 3–5 行"。 */
function lineText(start: number, end: number): string {
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/** @brief 芯片上的来源："src/a.ts · 第 3–5 行"或"助手回复"。 */
export function refLabel(ref: QuoteRef, cwd: string): string {
  const { source } = ref;
  if (source.kind === 'message') return '助手回复';
  return `${displayPath(source.path, cwd)} · ${lineText(source.startLine, source.endLine)}`;
}

/** @brief 发给模型的一段引用块（格式是临时默认值，见 docs/v0/defaults.md）。 */
export function quoteBlock(ref: QuoteRef, cwd: string): string {
  const { source } = ref;
  const heading = source.kind === 'message' ? '引用你之前的回复：'
    : `引用 ${displayPath(source.path, cwd)} ${lineText(source.startLine, source.endLine)}：`;
  const lines = ref.quote.split(/\r?\n/).map((line) => (line ? `> ${line}` : '>'));
  return [heading, ...lines].join('\n');
}

/** @brief 发给模型的全文：每个芯片一段引用块，之后接你的文字，段之间空一行。 */
export function composePrompt(refs: QuoteRef[], text: string, cwd: string): string {
  return [...refs.map((ref) => quoteBlock(ref, cwd)), text.trim()].filter(Boolean).join('\n\n');
}

/** @brief 从你的消息里去掉按 refs 拼出的引用块，剩下你写的字；开头对不上时为 null（按原文显示）。 */
export function stripQuotes(text: string, refs: QuoteRef[], cwd: string): string | null {
  const prefix = refs.map((ref) => quoteBlock(ref, cwd)).join('\n\n');
  if (text === prefix) return '';
  return text.startsWith(`${prefix}\n\n`) ? text.slice(prefix.length + 2) : null;
}

/** @brief 把文字的第一行截到 max 个字（芯片上的摘要）。 */
export function excerpt(text: string, max = 60): string {
  const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const chars = [...first];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : first;
}

/** @brief 加一个引用芯片到会话的输入框；来源和原文都一样的不再加。 */
export function addQuote(tabKey: string, ref: QuoteRef): void {
  recordAction(ref.source.kind === 'file' ? '问 Mori（文件）' : '问 Mori（回复）');
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
 * @brief 文件引用现在在哪几行（docs/v0/screens/selection.md "回到原位置"）：内容哈希没变时就是原来的行；
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
function nextJump(ref: QuoteRef): QuoteJump {
  jumpNonce += 1;
  return { ref, nonce: jumpNonce };
}

/** @brief 在右栏打开文件阅读器；ref 为打开它的文件引用芯片（跳到引用的行），从路径或改动列表打开时为 null。 */
export function openFile(tabKey: string, path: string, ref: QuoteRef | null = null): void {
  recordAction(ref ? '点引用打开文件' : '打开文件');
  jumpNonce += 1;
  const jump = ref ? { ref, nonce: jumpNonce } : null;
  updateTab(tabKey, (tab) => ({ ...tab, rightOpen: true,
    rightView: { kind: 'file', path, jump, nonce: jumpNonce } }));
}

/** @brief 右栏回到改动列表。 */
export function showChanges(tabKey: string): void {
  updateTab(tabKey, (tab) => ({ ...tab, rightView: { kind: 'changes' } }));
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
 *        不在已载入范围时先载入到它所在的一轮，再交给对话流滚过去高亮；找不到时标"原文已变化"。
 */
export function jumpToQuote(tabKey: string, ref: QuoteRef): void {
  if (ref.source.kind === 'file') {
    openFile(tabKey, ref.source.path, ref);
    return;
  }
  recordAction('点引用回到回复');
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
