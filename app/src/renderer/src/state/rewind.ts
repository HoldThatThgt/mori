// 消息上的 Rewind（docs/specs/file-system.md §5.5–§5.11，状态表 docs/v1/screens/fs-rewind.md）：按钮能不能点、菜单的四种情况、
// 协作模式下还开着的需求、rewind 与 rewind.undo 的调用和冲突的来回（token 原样带回）、完成后的对话流与输入框、
// 通知与 Undo 的提供、进行中与错误行，以及菜单、对话框、通知的文字。全部只从当前分支的对话流（mori.turn_changes、
// mori.rewind、mori.receipt）、会话的 TaskBoard 视图、git 状态与协作状态算。

import type { Command } from '../../../shared/protocol';
import type { ReceiptEntryData } from '../../../shared/team';
import type { ConflictChoice, RewindConflict, RewindRecord, RewindResult } from '../../../shared/workspace';
import { putBackQuoted } from './actions';
import { recordAction } from './actionLog';
import { describe, request } from './bridge';
import { transcriptFromEntries } from './history';
import { startIndexFor, type Item, type Transcript } from './model';
import { skillCommandText } from './skillText';
import {
  IDLE_REWIND, updateTab, useApp, type RewindConflicts, type RewindRequest, type RewindUi, type Tab,
} from './store';
import { addRewindNotice } from './transcript';
import { gitOk } from './workspace';

// ---- 按钮与菜单（§5.5） ----

/** @brief 菜单里能选的三项。 */
export type RewindChoice = 'code-conversation' | 'conversation' | 'code';

/** @brief 菜单的一行：三个选项、不可选的 No code restore、Never mind（id 同界面测试标识 rewind-<id>）。 */
export type RewindItemId = RewindChoice | 'no-code' | 'cancel';

/** @brief 菜单各行的文字（照 Claude Code 的 checkpointing，不做 Summarize）。 */
export const REWIND_LABELS: Readonly<Record<RewindItemId, string>> = Object.freeze({
  'code-conversation': 'Restore code and conversation',
  conversation: 'Restore conversation',
  code: 'Restore code',
  'no-code': 'No code restore',
  cancel: 'Never mind',
});

/** 会话忙时按钮与 Undo 的悬停（同会话菜单的原因） */
export const STILL_RUNNING = 'Still running';
/** 按钮平时的悬停（fs-rewind.md 定的临时文字） */
export const REWIND_TITLE = 'Rewind to before this message';

/** @brief 菜单的一行。 */
export interface RewindMenuItem {
  /** 哪一行 */
  id: RewindItemId;
  /** 文字 */
  label: string;
  /** 不可选：No code restore 总是；需求还开着时两个恢复对话的选项 */
  disabled: boolean;
}

/** @brief 一条消息的菜单（fs-rewind.md "菜单"）。 */
export interface RewindMenu {
  /** 各行，按显示的顺序，最后一行是 Never mind */
  items: RewindMenuItem[];
  /** 需求还开着时菜单下面的说明（data-requests 为编号）；没有为 null */
  blocked: { requests: number[]; text: string } | null;
}

/**
 * @brief 会话忙（§5.5）：有 Agent 在运行、排队或有待判断的消息（TeamState.busy；没有 Team 时对话在运行或准备中），
 *        或正在 Rewind / Undo（§5.10）。忙时 Rewind 与 Undo 不可点，悬停 Still running。
 */
export function rewindBusy(tab: Tab): boolean {
  const { transcript, team } = tab;
  return team.busy || team.background || transcript.running || transcript.sending || transcript.deciding !== null
    || tab.rewind.progress !== null;
}

/**
 * @brief 你的一条消息上的 Rewind（fs-rewind.md "消息上的 Rewind"）：git 是 ok、拿到了条目 id、会话开着时才有；
 *        程序投递（wake 条目）、准备中先显示的消息、还没拿到条目 id 的消息没有。
 * @return 没有按钮时为 null；disabled 为会话忙（aria-disabled，悬停 title）
 */
export function rewindButton(tab: Tab, item: Item): { disabled: boolean; title: string } | null {
  if (item.kind !== 'user' || item.pending || item.entryId === null || !tab.sessionId || !gitOk(tab)) return null;
  const disabled = rewindBusy(tab);
  return { disabled, title: disabled ? STILL_RUNNING : REWIND_TITLE };
}

/** @brief 从第 index 项起（含）对话流里的回执：单独一行的、画在立项工具卡下面的（合并会话）。 */
function receiptsFrom(transcript: Transcript, index: number): ReceiptEntryData[] {
  const receipts: ReceiptEntryData[] = [];
  for (const item of transcript.items.slice(index)) {
    if (item.kind === 'receipt') receipts.push(item.receipt);
    if (item.kind !== 'assistant') continue;
    for (const block of item.blocks) {
      if (block.type === 'tool') receipts.push(...transcript.tools[block.id]?.receipts ?? []);
    }
  }
  return receipts;
}

/**
 * @brief 协作模式的限制（§5.5）：当前分支上这条消息或之后登记（mori.receipt kind registered）、现在仍是 open 的需求编号，
 *        从小到大。
 * @param index 这条消息在对话流里的下标
 */
function openRequestsFrom(tab: Tab, index: number): number[] {
  const open = new Set(tab.board.requests.filter((item) => item.status === 'open').map((item) => item.no));
  const registered = receiptsFrom(tab.transcript, index)
    .filter((receipt) => receipt.kind === 'registered' && open.has(receipt.request)).map((receipt) => receipt.request);
  return [...new Set(registered)].sort((a, b) => a - b);
}

/**
 * @brief 需求还开着时菜单下面的一行（§5.5）：Request <n> is still open. …；几个时 Requests 1 and 3 are still open. …
 *        （三个及以上 Requests 1, 2, and 3 …）
 */
export function blockedText(requests: readonly number[]): string {
  if (requests.length === 1) {
    return `Request ${requests[0]} is still open. The conversation can’t go back to before it was registered.`;
  }
  // 两个时 1 and 3；三个及以上用牛津逗号 1, 2, and 3（docs/v0/ui-strings.md），与内核的拒绝原文一致
  const last = requests.at(-1);
  const list = requests.length === 2
    ? `${requests[0]} and ${last}`
    : `${requests.slice(0, -1).join(', ')}, and ${last}`;
  return `Requests ${list} are still open. The conversation can’t go back to before they were registered.`;
}

/**
 * @brief 一条你的消息 M 的菜单（§5.5 的表）：“有 code restore”= 当前分支上有 round 为 M 的 run 记录；“之后有改动”=
 *        当前分支上有 round 为 M 或 M 之后你的消息的 changes 记录。没有 code restore、之后有改动时多一行不可选的
 *        No code restore；之后没有改动时不显示两个恢复代码的选项。需求还开着时两个恢复对话的选项不可选，Restore code 照常。
 * @param entryId M 的条目 id
 */
export function rewindMenu(tab: Tab, entryId: string): RewindMenu {
  const { items, turnChanges } = tab.transcript;
  const index = items.findIndex((item) => item.kind === 'user' && item.entryId === entryId);
  const rounds = new Set(index < 0 ? [] : items.slice(index)
    .flatMap((item) => (item.kind === 'user' && item.entryId !== null ? [item.entryId] : [])));
  const code = turnChanges.some((item) => item.record.kind === 'run' && item.record.round === entryId);
  const after = turnChanges.some((item) => item.record.kind === 'changes' && rounds.has(item.record.round));
  const requests = index < 0 ? [] : openRequestsFrom(tab, index);
  const blocked = requests.length > 0;
  const row = (id: RewindItemId, disabled = false): RewindMenuItem => ({ id, label: REWIND_LABELS[id], disabled });
  const choices = code && after ? [row('code-conversation', blocked), row('conversation', blocked), row('code')]
    : [row('conversation', blocked), ...(after ? [row('no-code', true)] : [])];
  return { items: [...choices, row('cancel')], blocked: blocked ? { requests, text: blockedText(requests) } : null };
}

// ---- 调用与冲突（§5.6–§5.11） ----

/** @brief 改写一个会话的 Rewind 状态。 */
function setRewind(key: string, fn: (state: RewindUi) => RewindUi): void {
  updateTab(key, (tab) => ({ ...tab, rewind: fn(tab.rewind) }));
}

/** @brief 这个会话。 */
function tabOf(key: string): Tab | undefined {
  return useApp.getState().tabs.find((tab) => tab.key === key);
}

/**
 * @brief rewind / rewind.undo 做完（§5.8、§5.9）：恢复了对话时按结果的 entries 重建对话流（新的当前分支，This session 与
 *        +N −M 随之重算）；通知接在 mori.rewind 的位置并记下 warning；恢复对话时这条消息的文字放回输入框、放在已有草稿之前，
 *        引用芯片放回芯片（putBackQuoted；技能调用放回 /skill:名字 参数）。Undo 的 editorText 为 null，输入框不变。
 */
function applyDone(key: string, result: Extract<RewindResult, { kind: 'done' }>): void {
  updateTab(key, (tab) => {
    const base = result.entries ? transcriptFromEntries(result.entries) : tab.transcript;
    const transcript = addRewindNotice(base, result.entryId, result.record, result.warning);
    const startIndex = result.entries ? startIndexFor(transcript) : tab.startIndex;
    return { ...tab, transcript, startIndex, rewind: IDLE_REWIND };
  });
  if (result.editorText !== null) putBackQuoted(key, skillCommandText(result.editorText), result.refs ?? []);
}

/** @brief 这一次要发的命令。 */
function rewindCommand(sessionId: string, rewind: RewindRequest, choice: ConflictChoice | undefined): Command {
  if (rewind.kind === 'undo') return { type: 'rewind.undo', sessionId, undoId: rewind.undoId, conflictChoice: choice };
  return { type: 'rewind', sessionId, entryId: rewind.entryId, code: rewind.code, conversation: rewind.conversation,
    conflictChoice: choice };
}

/**
 * @brief 发一次 rewind / rewind.undo（§5.10、§5.11）：返回之前进行中（Rewinding… / Undoing…，冲突对话框里点的按钮写
 *        Restoring… / Undoing…）；返回 conflicts 时打开（或换掉）冲突对话框；done 时见 applyDone；失败时对话流末尾一行
 *        Couldn’t rewind: <原文> / Couldn’t undo: <原文>，冲突对话框关掉。后台进程退出时不显示错误行（换成崩溃提示）。
 * @param choice 冲突对话框里的选择（带回上一次结果的 token）；第一次调用不带
 */
async function runRewind(key: string, rewind: RewindRequest, choice?: ConflictChoice): Promise<void> {
  const sessionId = tabOf(key)?.sessionId;
  if (!sessionId) return;
  const command = rewindCommand(sessionId, rewind, choice);
  setRewind(key, (state) => ({ progress: rewind.kind, error: null,
    conflicts: state.conflicts && choice ? { ...state.conflicts, pending: choice.action } : null }));
  try {
    const result = await request<RewindResult>(command);
    if (result.kind === 'done') {
      applyDone(key, result);
      return;
    }
    const conflicts: RewindConflicts = { request: rewind, conflicts: result.conflicts, total: result.total,
      token: result.token, pending: null };
    setRewind(key, () => ({ progress: null, error: null, conflicts }));
  } catch (error) {
    const message = describe(command.type, error);
    if (useApp.getState().kernel !== 'ready') {
      setRewind(key, () => IDLE_REWIND);
      return;
    }
    const text = `${rewind.kind === 'rewind' ? 'Couldn’t rewind' : 'Couldn’t undo'}: ${message}`;
    setRewind(key, () => ({ progress: null, conflicts: null, error: { kind: rewind.kind, text } }));
  }
}

/**
 * @brief 选了菜单里的一项（Restore code and conversation、Restore conversation、Restore code）：记进操作记录
 *        （Rewind: <菜单项>），发 rewind。会话忙、这一项现在不可选或不在菜单里时什么都不做。
 * @param entryId 你那条消息的条目 id
 */
export async function rewindTo(key: string, entryId: string, choice: RewindChoice): Promise<void> {
  const tab = tabOf(key);
  if (!tab?.sessionId || rewindBusy(tab)) return;
  if (rewindMenu(tab, entryId).items.find((item) => item.id === choice)?.disabled !== false) return;
  recordAction(`Rewind: ${REWIND_LABELS[choice]}`);
  await runRewind(key, { kind: 'rewind', entryId, code: choice !== 'conversation', conversation: choice !== 'code' });
}

/** @brief 菜单的 Never mind（或 Esc）：只记进操作记录（Rewind: Never mind），什么都不改。 */
export function neverMind(): void {
  recordAction(`Rewind: ${REWIND_LABELS.cancel}`);
}

/**
 * @brief 冲突对话框的 Overwrite / Skip these files：记进操作记录（Rewind conflicts: …），带着上一次结果的 token 再发同一个
 *        命令。第二次调用进行中、没有对话框时什么都不做；冲突又变了时对话框换成新的列表（不关闭）。
 */
export async function resolveConflicts(key: string, action: ConflictChoice['action']): Promise<void> {
  const conflicts = tabOf(key)?.rewind.conflicts;
  if (!conflicts || conflicts.pending) return;
  recordAction(`Rewind conflicts: ${action === 'overwrite' ? 'Overwrite' : 'Skip these files'}`);
  await runRewind(key, conflicts.request, { action, token: conflicts.token });
}

/** @brief 冲突对话框的 Cancel（或 Esc）：记进操作记录（Rewind conflicts: Cancel），关掉对话框，什么都不改。 */
export function cancelConflicts(key: string): void {
  const conflicts = tabOf(key)?.rewind.conflicts;
  if (!conflicts || conflicts.pending) return;
  recordAction('Rewind conflicts: Cancel');
  setRewind(key, (state) => ({ ...state, conflicts: null }));
}

/**
 * @brief 通知里的 Undo：记进操作记录（Undo rewind），发 rewind.undo { undoId }。会话忙或这条通知现在不提供 Undo 时什么都不做。
 * @param undoId 那条 mori.rewind 的条目 id
 */
export async function undoRewind(key: string, undoId: string): Promise<void> {
  const tab = tabOf(key);
  const item = tab?.transcript.items.find((other) => other.kind === 'rewind' && other.entryId === undoId);
  if (!tab || !item || undoOffer(tab, item)?.disabled !== false) return;
  recordAction('Undo rewind');
  await runRewind(key, { kind: 'undo', undoId });
}

// ---- 通知与 Undo（§5.9） ----

/**
 * @brief 一条通知上的 Undo（§5.9、§17）：kind 为 rewind、恢复过代码、保险快照与恢复后快照都在的记录，是当前分支上
 *        最后一条 mori.rewind，没有 undo 指向它，它之后还没有消息条目（你的、程序投递的、助手的回复，与后台进程
 *        undoTargetOf 的规则一致），git 是 ok。只恢复对话的、恢复后快照没拍成的没有 Undo，Undo 之后没有 Redo。
 * @return 不提供时为 null；disabled 为会话忙（悬停 title）
 */
export function undoOffer(tab: Tab, item: Item): { disabled: boolean; title: string | null } | null {
  if (item.kind !== 'rewind' || item.record.kind !== 'rewind' || !item.record.code) return null;
  if (item.record.safety === null || item.record.post === null) return null;
  if (!tab.sessionId || !gitOk(tab)) return null;
  const { items } = tab.transcript;
  const index = items.findIndex((other) => other.key === item.key);
  if (index < 0 || index !== items.findLastIndex((other) => other.kind === 'rewind')) return null;
  if (items.some((other) => other.kind === 'rewind' && other.record.kind === 'undo'
    && other.record.target === item.entryId)) return null;
  if (items.slice(index + 1).some((other) => other.kind === 'user' || other.kind === 'wake'
    || other.kind === 'assistant')) return null;
  const disabled = rewindBusy(tab);
  return { disabled, title: disabled ? STILL_RUNNING : null };
}

/** @brief n 个文件：1 个时 1 file。 */
function filesText(count: number): string {
  return count === 1 ? '1 file' : `${count.toLocaleString('en-US')} files`;
}

/** @brief 一条通知要显示的文字（fs-rewind.md "完成"、"Undo"）。 */
export interface RewindNoticeText {
  /** 第一段：Restored code and conversation to before turn <n> 等，Undo 的为 Rewind undone */
  text: string;
  /** 有跳过的文件时可以展开的一段 Skipped <n> files（展开列出 record.skipped）；没有为 null */
  skipped: string | null;
  /** 有没恢复成的文件时可以展开的一段 Couldn’t restore <n> files（展开列出 record.failed）；没有为 null */
  failed: string | null;
}

/**
 * @brief 通知的文字（§5.9）：<n> 是记录的 turn；只恢复对话的写 Restored conversation to before turn <n>（没有 Undo）。
 *        Undo 按钮（undoOffer）接在第一段后面，跳过、失败的两段再接在后面，都用 " · " 隔开；对话没恢复时的 warning
 *        （Item.warning）在下一行。
 */
export function rewindNotice(record: RewindRecord): RewindNoticeText {
  const before = record.turn === null ? '' : ` to before turn ${record.turn}`;
  const text = record.kind === 'undo' ? 'Rewind undone'
    : record.code && record.conversation ? `Restored code and conversation${before}`
      : record.code ? `Restored code${before}` : `Restored conversation${before}`;
  return { text,
    skipped: record.counts.skipped > 0 ? `Skipped ${filesText(record.counts.skipped)}` : null,
    failed: record.counts.failed > 0 ? `Couldn’t restore ${filesText(record.counts.failed)}` : null };
}

/** @brief 进行中对话流末尾的一行（§5.10）。 */
export function progressText(kind: 'rewind' | 'undo'): string {
  return kind === 'rewind' ? 'Rewinding…' : 'Undoing…';
}

// ---- 冲突对话框的文字（fs-rewind.md "冲突"） ----

/** 对话框的标题 */
export const CONFLICTS_TITLE = 'Restore these files anyway?';

/** @brief 对话框的说明：Rewind 与 Undo 各一句。 */
export function conflictsDescription(kind: RewindRequest['kind']): string {
  return kind === 'rewind'
    ? 'These files changed after this session’s last snapshot, or while another session was running in this folder. '
      + 'Restoring them discards those changes.'
    : 'These files changed after the rewind. Undoing it discards those changes.';
}

/** @brief 冲突的原因：changed 最近一张快照之后又变了，overlap 同时运行时改的。 */
export const CONFLICT_REASONS: Readonly<Record<RewindConflict['reason'], string>> = Object.freeze({
  changed: 'Changed since the last snapshot',
  overlap: 'Another session was running',
});

/** @brief 列表的末行：total 多于列出的条数时 and {n} more；没有为 null。 */
export function conflictsMore(conflicts: RewindConflicts): string | null {
  const more = conflicts.total - conflicts.conflicts.length;
  return more > 0 ? `and ${more.toLocaleString('en-US')} more` : null;
}

/** @brief 第二次调用进行中点的那个按钮的文字：Rewind 时 Restoring…，Undo 时 Undoing…。 */
export function conflictsPendingText(kind: RewindRequest['kind']): string {
  return kind === 'rewind' ? 'Restoring…' : 'Undoing…';
}
