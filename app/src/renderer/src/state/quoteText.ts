// 引用的文字（纯函数，不碰界面状态）：芯片上的来源、发给模型的引用块与全文、从你的消息里认出引用块，
// 以及会话引用的轮次范围和字数（docs/v0/screens/selection.md、session-refs.md）。
// 录制 fixture 的脚本（tests/ui/m5-record.mjs）把这个文件和 sessionRefs.ts 打包后直接用，拼出的全文与界面完全一样。

import type { QuoteRef } from '../../../shared/protocol';
import { displayPath } from '../components/toolTitle';

/** @brief 行范围的文字："line 3"或"lines 3–5"。 */
export function lineText(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** @brief 轮次范围的文字："turn 3"或"turns 3–5"。 */
export function turnsText(from: number, to: number): string {
  return from === to ? `turn ${from}` : `turns ${from}–${to}`;
}

/** @brief 字数（按字符数）。 */
export function charCount(text: string): number {
  return [...text].length;
}

/** @brief "~X characters"（正好 1 时 "~1 character"）：1,000 以上取整到百，以下取整到十，100 以下照实。 */
export function approxChars(count: number): string {
  const rounded = count >= 1000 ? Math.round(count / 100) * 100 : count >= 100 ? Math.round(count / 10) * 10 : count;
  return rounded === 1 ? '~1 character' : `~${rounded.toLocaleString('en-US')} characters`;
}

/** @brief 会话引用的芯片文字："Context · 会话名 · turns 3–8 · ~3,200 characters"。 */
export function sessionRefLabel(ref: QuoteRef, name: string): string {
  const { source } = ref;
  if (source.kind !== 'session') return '';
  return `Context · ${name} · ${turnsText(source.fromTurn, source.toTurn)} · ${approxChars(charCount(ref.quote))}`;
}

/**
 * @brief 芯片上的来源："src/a.ts · lines 3–5"、"Response"，或会话引用的"Context · 会话名 · turns 3–8 · ~3,200 characters"
 *        （会话名用引用时的；界面上显示原会话现在的名字时由调用方传 name）。
 */
export function refLabel(ref: QuoteRef, cwd: string, name?: string): string {
  const { source } = ref;
  if (source.kind === 'message') return 'Response';
  if (source.kind === 'session') return sessionRefLabel(ref, name ?? source.name);
  return `${displayPath(source.path, cwd)} · ${lineText(source.startLine, source.endLine)}`;
}

/** @brief 引用块的第一行。 */
function blockHeading(ref: QuoteRef, cwd: string): string {
  const { source } = ref;
  if (source.kind === 'message') return 'Quoting your earlier reply:';
  if (source.kind === 'session') {
    return `Quoting session “${source.name}”, ${turnsText(source.fromTurn, source.toTurn)}:`;
  }
  return `Quoting ${displayPath(source.path, cwd)}, ${lineText(source.startLine, source.endLine)}:`;
}

/** @brief 发给模型的一段引用块（格式是临时默认值，见 docs/v0/defaults.md）。 */
export function quoteBlock(ref: QuoteRef, cwd: string): string {
  const lines = ref.quote.split(/\r?\n/).map((line) => (line ? `> ${line}` : '>'));
  return [blockHeading(ref, cwd), ...lines].join('\n');
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
