// 证据（docs/specs/parallel-agents-taskboard.md §7.3、§12.9）：纯函数。
// 编号：task 实例会话里每个工具结果的第一段文字前加 "[#n] "（n 在这个实例会话里从 1 递增，重新打开时从已有的最大编号继续）；
// 引用：#3、3、[#3] 都认；核对：每个编号必须是这个实例会话里一次已经结束的工具调用；
// 作者判定：这个实例在这个 task 上有过成功的 edit 或 write 调用时不能给自己写 pass；
// authorFamilies：一棒里产生成功的 edit、write 调用的模型族（§12.9）。读取编号与条目结构见 sessionReader.ts。

import { toolCallTitle, type HandoffOutcome, type TitleContext } from '../shared/team';
import {
  argsRecord, entryMessage, resultTagOf, toolCallBlocks, type ContentBlockLike, type SessionEntryLike,
  type SessionMessageLike,
} from './sessionReader';

/** @brief 证据不合格时列出的最近编号个数（§15）。 */
export const EVIDENCE_RECENT = 5;

/** @brief 算作“改过代码”的工具（§7.3：只看 edit、write，用命令改的文件认不出）。 */
export const AUTHOR_TOOLS: readonly string[] = Object.freeze(['edit', 'write']);

/** @brief 交接记下的一条证据（§6.1 Handoff.evidence）。 */
export interface EvidenceRecord {
  /** 编号，写作 #3 */
  tag: string;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 工具调用的标题（§13.8，shared/team.ts 的 toolCallTitle） */
  title: string;
  /** 结果不是错误（isError 为假） */
  ok: boolean;
}

/** @brief 核对证据的结果。 */
export interface EvidenceCheck {
  /** 合格的证据，按引用的顺序 */
  ok: EvidenceRecord[];
  /** 不合格的编号（不是这个实例会话里已经结束的工具调用），按引用的顺序 */
  bad: string[];
  /** 这个实例会话里最近的 5 个编号（被拒绝时列给模型看） */
  recent: EvidenceRecord[];
}

/** @brief 改过代码的那次调用（§7.3 的拒绝文字用）。 */
export interface AuthorMark {
  /** 编号，写作 #4；那次结果没有编号时为空字符串 */
  tag: string;
  /** 工具调用的标题，例如 Edit src/a.ts */
  title: string;
}

/** @brief 一次已经结束的工具调用（有工具结果）。 */
interface FinishedCall {
  /** 证据编号；没有时为 null */
  tag: number | null;
  /** pi 的 toolCallId */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** 调用参数 */
  args: Record<string, unknown>;
  /** 结果不是错误 */
  ok: boolean;
  /** 发出这次调用的助手消息；找不到时为 null */
  assistant: SessionMessageLike | null;
}

/**
 * @brief 编号的写法 #n。
 * @param n 编号
 */
export function tagLabel(n: number): string {
  return `#${n}`;
}

/**
 * @brief 给工具结果加证据编号（§7.3）：第一段文字前加 "[#n] "，其他内容块不变；没有文字时在最前面加一段 "[#n]"。
 *        pi 的 tool_result 钩子返回时另外保留 details 与 structuredContent（§14.6 T-T4）。
 * @param content 工具结果的内容块
 * @param n 编号
 * @return 新的内容块数组；输入不改
 */
export function tagResult<T extends ContentBlockLike>(content: readonly T[],
  n: number): (T | { type: 'text'; text: string })[] {
  const index = content.findIndex((block) => block.type === 'text');
  if (index < 0) return [{ type: 'text', text: `[#${n}]` }, ...content];
  return content.map((block, i) => (i === index ? { ...block, text: `[#${n}] ${block.text ?? ''}` } : block));
}

/**
 * @brief 下一个证据编号：会话里已有的最大编号加 1，没有时为 1（重新打开时继续编号，§7.3）。
 * @param entries 实例会话的条目
 */
export function nextTag(entries: readonly SessionEntryLike[]): number {
  let max = 0;
  for (const entry of entries) {
    const message = entryMessage(entry);
    if (message?.role === 'toolResult') max = Math.max(max, resultTagOf(message) ?? 0);
  }
  return max + 1;
}

/** @brief 引用的三种写法：#3、3、[#3]（§7.3）。 */
const EVIDENCE_REF = /^(?:#([1-9][0-9]*)|([1-9][0-9]*)|\[#([1-9][0-9]*)\])$/;

/** @brief 一项引用的编号；不是编号时为 null。 */
function evidenceNumber(item: unknown): number | null {
  if (typeof item === 'number') return Number.isSafeInteger(item) && item > 0 ? item : null;
  if (typeof item !== 'string') return null;
  const match = EVIDENCE_REF.exec(item.trim());
  const digits = match?.[1] ?? match?.[2] ?? match?.[3];
  return digits === undefined ? null : Number(digits);
}

/**
 * @brief 解析 evidence 列表（§7.3：#3、3、[#3] 都认）。
 * @param list task_handoff 的 evidence（或 C 级标签里每行一项）
 * @return tags：归一成 #n 的编号，去重、按出现顺序；invalid：不是编号写法的项（原样转成字符串）
 */
export function parseEvidence(list: readonly unknown[]): { tags: string[]; invalid: string[] } {
  const tags: string[] = [];
  const invalid: string[] = [];
  for (const item of list) {
    const n = evidenceNumber(item);
    if (n === null) invalid.push(String(item));
    else if (!tags.includes(tagLabel(n))) tags.push(tagLabel(n));
  }
  return { tags, invalid };
}

/** @brief 会话里每次已经结束的工具调用，按工具结果的顺序。 */
function finishedCalls(entries: readonly SessionEntryLike[]): FinishedCall[] {
  const calls = new Map<string, { block: ContentBlockLike; assistant: SessionMessageLike }>();
  const out: FinishedCall[] = [];
  for (const entry of entries) {
    const message = entryMessage(entry);
    if (!message) continue;
    for (const block of toolCallBlocks(message)) calls.set(block.id ?? '', { block, assistant: message });
    if (message.role !== 'toolResult' || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    out.push({
      tag: resultTagOf(message),
      toolCallId: message.toolCallId,
      toolName: message.toolName ?? call?.block.name ?? '',
      args: argsRecord(call?.block.arguments),
      ok: message.isError !== true,
      assistant: call?.assistant ?? null,
    });
  }
  return out;
}

/**
 * @brief 实例会话里带编号的、已经结束的工具调用，按编号的先后。
 * @param entries 实例会话的条目
 * @param context 工具标题的上下文（工作目录、座位角色、这个实例的 task）
 */
export function taggedResults(entries: readonly SessionEntryLike[], context: TitleContext): EvidenceRecord[] {
  return finishedCalls(entries).filter((call) => call.tag !== null).map((call) => ({
    tag: tagLabel(call.tag ?? 0),
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    title: toolCallTitle(call.toolName, call.args, context),
    ok: call.ok,
  }));
}

/**
 * @brief 核对证据（§7.3）：每个编号必须是这个实例会话里一次已经结束的工具调用；合格的记下 { tag, toolCallId, toolName,
 *        title, ok }，ok = 结果不是错误。
 * @param entries 实例会话的条目
 * @param tags parseEvidence 归一后的编号
 * @param context 工具标题的上下文
 */
export function verifyEvidence(entries: readonly SessionEntryLike[], tags: readonly string[],
  context: TitleContext): EvidenceCheck {
  const records = taggedResults(entries, context);
  const byTag = new Map(records.map((record) => [record.tag, record]));
  const ok: EvidenceRecord[] = [];
  const bad: string[] = [];
  for (const tag of tags) {
    const record = byTag.get(tag);
    if (record) ok.push(record);
    else bad.push(tag);
  }
  return { ok, bad, recent: records.slice(-EVIDENCE_RECENT) };
}

/**
 * @brief 证据记录的简写：#3 Run npm test ✓（工作卡、board_read、拒绝文字用）。
 * @param record 证据记录
 */
export function evidenceText(record: Pick<EvidenceRecord, 'tag' | 'title' | 'ok'>): string {
  return `${record.tag} ${record.title} ${record.ok ? '✓' : '✗'}`;
}

/**
 * @brief 证据不合格时 task_handoff 的错误（§6.2 两行格式：第一行原因，第二行正确的写法）：列出不合格的编号与最近 5 个编号和标题。
 * @param bad 不合格的编号或写法
 * @param recent 最近的编号（verifyEvidence 的 recent）
 */
export function evidenceRejection(bad: readonly string[], recent: readonly EvidenceRecord[]): string {
  const verb = bad.length === 1 ? 'is not a finished tool call' : 'are not finished tool calls';
  const first = `evidence: ${bad.join(', ')} ${verb} in your session.`;
  const second = recent.length ? `Cite the numbers of your own tool results; recent ones: ${recent.map(evidenceText)
    .join(', ')}.` : 'Cite the numbers of your own tool results; you have none yet.';
  return `${first}\n${second}`;
}

/**
 * @brief 改过代码的判定（§7.3）：这个实例会话里第一次成功的 edit 或 write 调用。实例会话按（task，角色）一条，
 *        所以就是“这个实例在这个 task 上”。
 * @param entries 实例会话的条目
 * @param context 工具标题的上下文
 * @return 那次调用的编号与标题；没有时为 null
 */
export function authorCheck(entries: readonly SessionEntryLike[], context: TitleContext): AuthorMark | null {
  const call = finishedCalls(entries).find((item) => item.ok && AUTHOR_TOOLS.includes(item.toolName));
  if (!call) return null;
  return { tag: call.tag === null ? '' : tagLabel(call.tag), title: toolCallTitle(call.toolName, call.args, context) };
}

/**
 * @brief 改过代码的实例写 pass 被拒绝的文字（§7.3）：You changed files on T1 (#4 Edit src/a.ts); another role must verify.
 * @param task task 编号
 * @param author authorCheck 的结果
 */
export function passRejection(task: string, author: AuthorMark): string {
  const call = `${author.tag ? `${author.tag} ` : ''}${author.title}`;
  return `You changed files on ${task} (${call}); another role must verify.`;
}

/**
 * @brief 结果与证据的规则（§7.3）：改过代码的实例不能写 pass；done、pass 至少要有 1 个 ok 为真的证据。
 * @param outcome 交接的结果
 * @param records 合格的证据（verifyEvidence 的 ok）
 * @param author authorCheck 的结果
 * @param task task 编号
 * @return 拒绝的原因（一行）；没有违反时为 null
 */
export function outcomeEvidenceError(outcome: HandoffOutcome, records: readonly EvidenceRecord[],
  author: AuthorMark | null, task: string): string | null {
  if (outcome === 'pass' && author) return passRejection(task, author);
  if ((outcome === 'done' || outcome === 'pass') && !records.some((record) => record.ok)) {
    return `${outcome} needs evidence: the number of a tool result that shows it works.`;
  }
  return null;
}

/**
 * @brief 一棒里产生成功的 edit、write 调用的模型族（§12.9）：助手消息记着实际的 provider 与 model，
 *        模型族为空时用 <provider>/<model> 本身；去重，按出现的先后。
 * @param entries 这一棒的条目（sessionReader.ts 的 entriesOfTurns 按交接的回合范围切出）
 * @param familyOf 模型 <provider>/<model> 的族；没有族时返回 null 或空字符串
 */
export function authorFamilies(entries: readonly SessionEntryLike[],
  familyOf: (ref: string) => string | null): string[] {
  const families: string[] = [];
  for (const call of finishedCalls(entries)) {
    if (!call.ok || !AUTHOR_TOOLS.includes(call.toolName) || !call.assistant) continue;
    const ref = `${call.assistant.provider ?? ''}/${call.assistant.model ?? ''}`;
    const family = familyOf(ref) || ref;
    if (!families.includes(family)) families.push(family);
  }
  return families;
}
