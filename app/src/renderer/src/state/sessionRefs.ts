// 会话引用的内容（docs/v0/screens/session-refs.md）：把后台进程读出的会话条目（pi 的当前分支）分成轮，
// 只取你和助手的正文，工具调用压成一行标题，不含思考；默认范围、字数，以及芯片和引用块上的文字。
// 内容只从会话记录生成，不从屏幕上取字，所以里面没有按钮等界面文字。纯函数，录制脚本（tests/ui/m5-record.mjs）也用它。

import { z } from 'zod';
import {
  QuoteRefSchema, REF_ENTRY_TYPE, type QuoteRef, type SessionContent, type SessionEntry, type SessionSource,
} from '../../../shared/protocol';
import { displayPath, toolTitleText } from '../components/toolTitle';
import { blocksFromContent, contentText } from './model';
import { charCount, lineText, stripQuotes, turnsText } from './quoteText';
import { skillCommandText } from './skillText';

export { approxChars, charCount } from './quoteText';

/** 全部内容超过这么多字时，默认只引用最近几轮（临时默认值，见 docs/v0/defaults.md） */
export const REF_FULL_LIMIT = 20_000;
/** 内容太长时默认引用的轮数（临时默认值） */
export const REF_RECENT_TURNS = 5;

/** mori.ref 条目的内容（会话文件里读出来的，先校验） */
const RefDataSchema = z.object({ messageId: z.string(), refs: z.array(QuoteRefSchema) });

/** @brief 会话里的一轮：你的一条消息，加上它之后、下一条你的消息之前的全部回复。 */
export interface RefTurn {
  /** 第几轮（从 1 起） */
  number: number;
  /** 这一轮你的消息的条目 id */
  entryId: string;
  /** 这一轮引用的内容（不带"Turn N"标题） */
  text: string;
}

/** @brief 你的消息里一个引用压成的一行（不把被引用的全文再嵌一层）。 */
function refMarker(ref: QuoteRef, cwd: string): string {
  const { source } = ref;
  if (source.kind === 'message') return '[Quote] an earlier assistant reply';
  if (source.kind === 'session') {
    return `[Quote] session “${source.name}”, ${turnsText(source.fromTurn, source.toTurn)}`;
  }
  return `[Quote] ${displayPath(source.path, cwd)}, ${lineText(source.startLine, source.endLine)}`;
}

/** @brief 你的消息的几行：你写的字（带引用时去掉引用块），每个引用一行标记。 */
function userLines(text: string, refs: QuoteRef[] | undefined, cwd: string): string[] {
  const own = skillCommandText(refs?.length ? stripQuotes(text, refs, cwd) ?? text : text);
  return [`User: ${own.trim()}`.trimEnd(), ...(refs ?? []).map((ref) => refMarker(ref, cwd))];
}

/** @brief 一条助手回复的几行：正文段，工具调用一行标题；思考不取。 */
function assistantLines(content: unknown, cwd: string): string[] {
  const { blocks, tools } = blocksFromContent(content);
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) lines.push(`Assistant: ${block.text.trim()}`);
    const tool = block.type === 'tool' ? tools.find((item) => item.id === block.id) : undefined;
    if (tool) lines.push(`[Tool] ${toolTitleText(tool, cwd)}`);
  }
  return lines;
}

/** @brief 分支里 mori.ref 条目记下的引用，按你的消息的条目 id。 */
function refsByMessage(entries: SessionEntry[]): Map<string, QuoteRef[]> {
  const byMessage = new Map<string, QuoteRef[]>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== REF_ENTRY_TYPE) continue;
    const parsed = RefDataSchema.safeParse(entry.data);
    if (parsed.success) byMessage.set(parsed.data.messageId, parsed.data.refs);
    else console.error(`[renderer] ignored a malformed ${REF_ENTRY_TYPE} entry: ${parsed.error.message}`);
  }
  return byMessage;
}

/**
 * @brief 把会话当前分支的条目分成轮。只看你的消息和助手回复：工具结果、压缩摘要、扩展的消息都不取；
 *        第一条你的消息之前的回复不算在任何一轮里。
 */
export function sessionTurns(entries: SessionEntry[], cwd: string): RefTurn[] {
  const refs = refsByMessage(entries);
  const turns: Array<{ entryId: string; lines: string[] }> = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message as unknown as { role?: string; content?: unknown };
    if (message.role === 'user') {
      turns.push({ entryId: entry.id, lines: userLines(contentText(message.content), refs.get(entry.id), cwd) });
    } else if (message.role === 'assistant') {
      turns.at(-1)?.lines.push(...assistantLines(message.content, cwd));
    }
  }
  return turns.map((turn, index) => ({ number: index + 1, entryId: turn.entryId, text: turn.lines.join('\n') }));
}

/** @brief 第 from 到 to 轮的内容：每轮一段，以"Turn N"开头，段之间空一行。 */
export function rangeText(turns: RefTurn[], from: number, to: number): string {
  return turns.slice(from - 1, to).map((turn) => `Turn ${turn.number}\n${turn.text}`).join('\n\n');
}

/** @brief 默认范围：全部；全部超过 REF_FULL_LIMIT 字时最近 REF_RECENT_TURNS 轮。 */
export function defaultRange(turns: RefTurn[]): { from: number; to: number } {
  const to = turns.length;
  const tooLong = charCount(rangeText(turns, 1, to)) > REF_FULL_LIMIT;
  return { from: tooLong ? Math.max(1, to - REF_RECENT_TURNS + 1) : 1, to };
}

/** @brief 引用第 from 到 to 轮的芯片内容和来源。name 为这时显示的会话名。 */
export function sessionRef(content: SessionContent, turns: RefTurn[], range: { from: number; to: number },
  name: string): QuoteRef {
  const source: SessionSource = { kind: 'session', sessionFile: content.sessionFile, name, fromTurn: range.from,
    toTurn: range.to, fromEntryId: turns[range.from - 1]!.entryId, toEntryId: turns[range.to - 1]!.entryId };
  return { quote: rangeText(turns, range.from, range.to), source };
}

/** @brief 按条目 id 在现在的轮次里找回引用的范围；任一端找不到时为 null（原会话的内容变了）。 */
export function locateRange(turns: RefTurn[], source: SessionSource): { from: number; to: number } | null {
  const from = turns.findIndex((turn) => turn.entryId === source.fromEntryId) + 1;
  const to = turns.findIndex((turn) => turn.entryId === source.toEntryId) + 1;
  return from > 0 && to >= from ? { from, to } : null;
}
