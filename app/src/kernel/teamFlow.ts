// 分开时协作模式下一条你的消息怎么走（docs/specs/parallel-agents-taskboard.md §5.3、§5.4、§8.3、§11.4、§13.2、§13.3）：
// 对话与立项由不同角色持有时，每条消息先进“待判断”队列（先来先判断），交给立项会话判断（§8.4 的投递），判断完记下决定
// 与立项最后一段文字（对话的工作卡），再交给对话会话：对话空闲时以它开始回复，正在回复时照发送时的选择交给 pi，
// 在为另一条消息准备中时排在那条之后。回执在对话写下这条消息之后写，进展摘要的位置在对话回复它的那一段结束时写；
// 消息没写进对话就离开（停止、撤回、选不到模型、拒绝启动）时，两者在离开时写在对话流末尾（§13.2）。
// 合并会话（同一个角色持有对话与立项）不经待判断队列：消息照普通发送交给用户会话，判断在 mori-team 的 message_start 开始；
// 这里只记下交出的原文（handMerged），判断按原文记原话。
// 分开时提问卡的答复（docs/specs/file-system-permissions.md §10.7）由 forwardAnswer 直接排进立项的投递队列，不进待判断队列。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';
import {
  TEAM_ENTRY_TYPES, type DecidingMessage, type PromptBehavior, type ReceiptEntryData,
} from '../shared/team';
import type { KernelEvent } from '../shared/protocol';
import { judgmentDecision } from './board';
import { deliveryText, type DecisionNote } from './boardText';
import { piPackageDir } from './mcpShare';
import { loadPi } from './pi';
import { messageText, type SessionEntryLike, type SessionMessageLike } from './sessionReader';
import type { Team } from './team';
import type { HeldItem } from './teamHost';
import type { LaneRun, TeamDelivery } from './teamLanes';
import type { Board, Judgment } from './teamTypes';

/** @brief 立项判断你的消息时选不到模型（§12.5）：对话的工作卡写 couldn't decide: no model available。 */
export const NO_MODEL_REASON = 'no model available';

/** @brief pi 1.3.0 里 expandPromptTemplate 所在的文件（相对 pi 的包目录；它没有从包的入口导出，§5.3）。 */
const PI_TEMPLATES_FILE = 'dist/core/prompt-templates.js';

/** @brief pi 的 expandPromptTemplate：text 是某个提示词模板的调用时返回展开后的文字，否则原样返回。 */
export type ExpandTemplate = (text: string, templates: PromptTemplate[]) => string;

/** @brief 立项对一条你的消息的决定（对话工作卡的 For this message 一行，§8.3）。 */
export interface DecisionRecord {
  /** 你输入的原文 */
  text: string;
  /** 这条消息在对话会话里的时刻（写进对话会话时记下，按它在请求的上下文里认出这条消息）；还没写进时为 null */
  timestamp: number | null;
  /** 决定 */
  note: DecisionNote;
}

/** @brief 一次判断写下、还没写进用户会话的东西（回执与进展摘要的位置）。 */
interface HeldWrites {
  /** 这次判断写下的回执（§13.2） */
  receipts: ReceiptEntryData[];
  /** 这次判断登记的需求（mori.progress，§13.3） */
  registered: number[];
}

/** @brief 待判断、还没交给对话的一条你的消息。 */
interface PendingMessage extends HeldWrites {
  /** 消息与引用芯片 */
  item: HeldItem;
  /** 发送时的选择；空闲时发送为 null */
  behavior: PromptBehavior | null;
  /** 给立项的投递（在立项会话的投递队列里，或正在投递） */
  delivery: TeamDelivery;
  /** 开始判断的时刻（ms）；还没开始为 null */
  since: number | null;
  /** 对话空闲时发出的那条：对话的准备中在等它的判断（dialogStart 的 before），判断完调用它；其他为 null */
  release: (() => void) | null;
  /** 提示词模板展开后的文字（对话会话照 v0 展开，写进会话的是它）；不是模板时为 null */
  expanded: string | null;
}

/** @brief 判断完、交给了对话、还没写进对话会话的一条消息。 */
export interface HandedMessage extends HeldWrites {
  /** 你输入的原文 */
  text: string;
  /** pi 展开提示词模板之后的文字（对话会话里这条消息的文字）；不是模板时为 null */
  alt: string | null;
  /** 回执已经写下 */
  written: boolean;
  /** start：以它开始一次回复；held：排在对话准备中的那条之后；pi：交给了 pi 的排队或插话 */
  via: 'start' | 'held' | 'pi';
  /** 立项的决定 */
  decision: DecisionRecord;
}

/** @brief decisionNote 的输入：这次判断与它所在运行的结局。 */
export interface JudgedRun {
  /** 结束的判断；判断没开始（投递没能开始运行）时为 null */
  judgment: Judgment | null;
  /** 立项选不到模型（§12.5） */
  unavailable: boolean;
  /** 运行以出错结束时的错误原文；没有时为 null */
  error: string | null;
  /** 立项最后一段文字 */
  lastText: string;
  /** 这次判断写下的回执 */
  receipts: readonly ReceiptEntryData[];
}

/**
 * @brief 对话工作卡上立项对这条消息的决定（§5.4、§8.3）：选不到模型、出错时为 couldn't decide（已经做出的写入照常有效）；
 *        否则是这次判断的决定（没做任何决定按“不需要协作”），带它登记、补充、撤销的需求和最后一段文字。
 * @param run 判断与运行的结局
 */
export function decisionNote(run: JudgedRun): DecisionNote {
  if (run.unavailable) return { kind: 'failed', reason: NO_MODEL_REASON };
  if (run.error !== null) return { kind: 'failed', reason: run.error };
  const requests = [...new Set([...(run.judgment?.registered ?? []), ...run.receipts.map((item) => item.request)])];
  const decision = run.judgment ? judgmentDecision(run.judgment) : 'reply';
  return { kind: 'decided', decision, requests, note: run.lastText };
}

/** @brief 技能命令 /skill:<name> 的名字；不是技能命令时为 null。 */
const skillName = (text: string): string | null => /^\/skill:(\S+)/.exec(text)?.[1] ?? null;

/**
 * @brief 对话会话里一条 role 为 user 的消息是交给它的哪一条（§5.3）：原文相同的那条；pi 照 v0 展开了提示词模板和技能命令，
 *        这时消息的文字不是原文：提示词模板比展开后的文字（alt），技能命令比 pi 展开出的 <skill name="<name>" 开头。
 *        别的文字（例如扩展用 sendUserMessage 发的）不算其中任何一条。
 * @param handed 交给了对话、还没写进的消息，按交出的顺序
 * @param text 对话会话里这条消息的文字
 * @return 下标；不是其中任何一条时为 -1
 */
export function matchHanded(handed: readonly Pick<HandedMessage, 'text' | 'alt'>[], text: string): number {
  const same = handed.findIndex((item) => item.text === text || item.alt === text);
  if (same >= 0) return same;
  return handed.findIndex((item) => {
    const name = skillName(item.text);
    return name !== null && text.startsWith(`<skill name="${name}"`);
  });
}

/**
 * @brief 这次请求上下文里最后一条你的消息上立项的决定（§8.3）：程序投递的 [Mori] 消息不算你的；按消息的时刻认出，
 *        还没记下时刻的按原文。最后一条不是判断过的消息时为 null（不往前找）。
 * @param decisions 记下的决定，按先后
 * @param messages 这次请求的上下文
 */
export function decisionFor(decisions: readonly DecisionRecord[],
  messages: readonly unknown[]): DecisionNote | null {
  const users = messages.map((item) => item as SessionMessageLike).filter((item) => item.role === 'user'
    && !messageText(item).startsWith('[Mori]'));
  const last = users.at(-1);
  if (last === undefined) return null;
  const byTime = last.timestamp === undefined ? undefined
    : decisions.findLast((item) => item.timestamp === last.timestamp);
  const text = messageText(last);
  return (byTime ?? decisions.findLast((item) => item.timestamp === null && item.text === text))?.note ?? null;
}

/**
 * @brief TaskBoard 上有、用户会话里没有 mori.progress 的需求（§11.6：例如登记之后 App 退出，重新打开时补写）。
 * @param board TaskBoard
 * @param entries 用户会话的条目
 */
export function missingProgress(board: Board, entries: readonly SessionEntryLike[]): number[] {
  const placed = new Set(entries.filter((entry) => entry.type === 'custom' && entry.customType
    === TEAM_ENTRY_TYPES.progress).map((entry) => (entry.data as { request?: unknown } | undefined)?.request));
  return board.requests.map((request) => request.no).filter((no) => !placed.has(no));
}

/**
 * @brief 提示词模板展开后的文字（§5.3：投递给立项时附上 Expanded from /<name>: 一段）。
 * @param text 你输入的原文
 * @param templates 用户会话加载了的提示词模板
 * @param expand pi 的 expandPromptTemplate
 * @return 模板名与展开后的文字；不是模板的调用时为 null（技能命令 pi 没有导出展开，立项只看到原文）
 */
export function templateExpansion(text: string, templates: readonly PromptTemplate[],
  expand: ExpandTemplate): { name: string; text: string } | null {
  const name = /^\/(\S+)/.exec(text)?.[1];
  if (name === undefined || !templates.some((template) => template.name === name)) return null;
  const expanded = expand(text, [...templates]);
  return expanded === text ? null : { name, text: expanded };
}

/**
 * @brief 按 pi 1.3.0 包里的文件路径载入 expandPromptTemplate（同 app-v0 §6 的 MCP 做法，mcpShare.ts）；找不到时报错。
 */
export async function loadTemplateExpander(): Promise<ExpandTemplate> {
  const dir = piPackageDir(await loadPi());
  const url = pathToFileURL(join(dir, PI_TEMPLATES_FILE)).href;
  const module = await import(/* @vite-ignore */ url) as { expandPromptTemplate?: unknown };
  if (typeof module.expandPromptTemplate !== 'function') {
    throw new Error(`expandPromptTemplate is missing in ${dir}`);
  }
  return module.expandPromptTemplate as ExpandTemplate;
}

/** @brief 分开时一个用户会话的待判断队列、交给对话的消息与决定（Team 持有一份）。 */
export class UserFlow {
  /** 待判断、还没交给对话的消息，按发送顺序（正在判断的那条总在最前） */
  private pending: PendingMessage[] = [];
  /** 交给了对话、还没写进对话会话的消息，按交出的顺序 */
  private handed: HandedMessage[] = [];
  /** 对话正在回复的那条（这一段，§5.3 第 6 步）；没有时为 null */
  private current: HandedMessage | null = null;
  /** 立项对每条消息的决定（对话的工作卡） */
  private readonly decisions: DecisionRecord[] = [];
  /** 协作模式下照 v0 直接交给对话的扩展命令（它用 sendUserMessage 开始的运行写 No decision，§5.3）；没有时为 null */
  private command: string | null = null;
  /** 合并会话：交给用户会话、还没写进的你的消息（原文与提示词模板展开后的文字），按交出的顺序 */
  private merged: Pick<HandedMessage, 'text' | 'alt'>[] = [];
  /** pi 的 expandPromptTemplate（prepare 之后） */
  private expand: ExpandTemplate | null = null;

  /** @param team 这个用户会话的协作 */
  constructor(private readonly team: Team) {}

  /** @brief 用户会话打开时载入提示词模板的展开（§5.3）。 */
  async prepare(): Promise<void> {
    this.expand = await loadTemplateExpander();
  }

  /** @brief “待判断”队列（mori.team_deciding 的 queue、SessionInfo.deciding）。 */
  deciding(): DecidingMessage[] {
    return this.pending.map((item) => ({ text: item.item.text, behavior: item.behavior }));
  }

  /** @brief 正在判断的那条开始判断的时刻；没有在判断时为 null。 */
  since(): number | null {
    return this.pending.find((item) => item.since !== null)?.since ?? null;
  }

  /**
   * @brief 一条你的消息（§5.3 第 1、2 步）：排进待判断队列与立项会话的投递队列；对话空闲时进入准备中等它的判断
   *        （这条消息照模型层规格 §9.3 先显示在对话流里），否则在排队区等。
   * @param item 消息与引用芯片
   * @param behavior 回复中发送时的选择
   */
  prompt(item: HeldItem, behavior: PromptBehavior | undefined): void {
    const team = this.team;
    const templates = team.userSession?.session.promptTemplates ?? [];
    const expanded = this.expand ? templateExpansion(item.text, templates, this.expand) : null;
    const text = deliveryText('create_user_message', { text: item.text, expanded });
    const delivery: TeamDelivery = { user: true, text, cause: { kind: 'user_message' }, at: Date.now(),
      meta: { userText: item.text } };
    const pending: PendingMessage = { item, behavior: behavior ?? null, delivery, since: null, receipts: [],
      registered: [], release: null, expanded: expanded?.text ?? null };
    this.pending.push(pending);
    if (team.userIdle()) this.startFor(pending);
    // 先排进立项的投递队列：立项空闲时它立即开始判断，发出的第一个 mori.team_deciding 就带开始判断的时刻
    // （阶段行一出现就是“is deciding… · Ns”，§13.6）；立项在忙别的回合时 since 为 null
    team.enqueue(team.createLane(), delivery);
    team.emitDeciding();
  }

  /**
   * @brief 协作模式分开时把提问卡的“问题 + 你的答复”当成你的一条消息交给立项（docs/specs/file-system-permissions.md
   *        §10.7）：建一条与用户消息同样的投递，只排进立项会话的投递队列。不进待判断队列：排队区不显示、停止对话时
   *        不回到输入框、判断完不交给对话（judgmentEnded、judgmentStopped 找不到它就返回，对话已经拿到答复了）；
   *        立项写下的回执照 holdReceipt 找不到待判断消息时的做法写在对话流末尾。Stop team 时照常丢弃并记日志。
   * @param text 问题与答复（boardText.forwardedAnswerText）
   */
  forwardAnswer(text: string): void {
    const team = this.team;
    const delivery: TeamDelivery = { user: true, text: deliveryText('create_user_message', { text, expanded: null }),
      cause: { kind: 'user_message' }, at: Date.now(), meta: { userText: text } };
    team.enqueue(team.createLane(), delivery);
  }

  /** @brief 对话空闲时为这条消息开始回复：准备中先等立项的判断（before），停止时立即结束等待。 */
  private startFor(pending: PendingMessage): void {
    const team = this.team;
    let release: () => void = () => undefined;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.release = release;
    const before = (signal: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      void decided.then(resolve);
    });
    team.user.busy = true;
    void team.host.dialogStart(team.userId, pending.item, before).finally(() => {
      if (pending.release === release) pending.release = null;
      team.userReplyDone();
    });
  }

  /** @brief 立项开始投递这一批（§5.3 第 2 步）：其中有用户消息时它开始判断（阶段行的计时）。 */
  judgingStarted(batch: readonly TeamDelivery[]): void {
    const pending = this.pending.find((item) => batch.includes(item.delivery));
    if (!pending) return;
    pending.since = Date.now();
    this.team.emitDeciding();
  }

  /**
   * @brief 立项判断你的消息时写下的回执（§13.2）：等对话写下这条消息之后再写；这条消息已经离开（停止、撤回）时
   *        现在写在对话流末尾。
   * @param run 立项的这次运行
   * @param receipt 回执
   */
  holdReceipt(run: LaneRun, receipt: ReceiptEntryData): void {
    const pending = this.pending.find((item) => run.batch.includes(item.delivery));
    if (!pending) {
      this.leave([{ receipts: [receipt], registered: receipt.kind === 'registered' ? [receipt.request] : [] }]);
      return;
    }
    pending.receipts.push(receipt);
    if (receipt.kind === 'registered') pending.registered.push(receipt.request);
  }

  /** @brief 取出这次运行判断的那条（从待判断队列里去掉）；已经离开时为 undefined。 */
  private take(batch: readonly TeamDelivery[]): PendingMessage | undefined {
    const index = this.pending.findIndex((item) => batch.includes(item.delivery));
    return index < 0 ? undefined : this.pending.splice(index, 1)[0];
  }

  /**
   * @brief 立项的回合结束（没被停止，§5.3 第 3、4 步）：记下决定与最后一段文字，把这条消息交给对话。
   * @param run 立项的这次运行（没能开始运行时也有）
   */
  judgmentEnded(run: LaneRun): void {
    const pending = this.take(run.batch);
    if (!pending) return;
    const note = decisionNote({ judgment: run.ended, unavailable: run.unavailable !== null, error: run.error,
      lastText: run.lastText, receipts: pending.receipts });
    if (note.kind === 'failed') console.log(`[kernel] ${this.team.userId}: couldn't decide (${note.reason})`);
    const decision: DecisionRecord = { text: pending.item.text, timestamp: null, note };
    this.decisions.push(decision);
    const handed: HandedMessage = { text: pending.item.text, alt: pending.expanded, receipts: pending.receipts,
      registered: pending.registered, written: false, via: 'start', decision };
    this.handed.push(handed);
    this.handTo(pending, handed);
    this.team.emitDeciding();
  }

  /**
   * @brief 交给对话（§5.3 第 4 步）：为它准备中的那次回复接着做；对话空闲时以它开始回复；正在回复时照发送时的选择交给 pi；
   *        在为另一条消息准备中时排在那条之后（那次回复开始时作为 followUp 交给 pi）。
   */
  private handTo(pending: PendingMessage, handed: HandedMessage): void {
    const team = this.team;
    if (pending.release) {
      pending.release();
      return;
    }
    const status = team.host.status(team.userId);
    // 对话会话本身没有在运行或准备中（包括上一次运行 agent_settled 之后、Team 还没处理完它的结束或上一次回复的
    // dialogStart 还没兑现的那一会儿）：由 Team 开始并跟踪这次回复；交给 dialogQueue 会由会话表开始一次 Team 不知道的回复。
    if (team.userIdle() || !(status?.running || status?.preparing)) {
      team.user.busy = true;
      void team.host.dialogStart(team.userId, pending.item).finally(() => team.userReplyDone());
      return;
    }
    handed.via = status.preparing ? 'held' : 'pi';
    team.host.dialogQueue(team.userId, pending.item, status.preparing ? 'followUp' : pending.behavior ?? 'followUp');
  }

  /** @brief 立项的这次判断被停止（§9.4 第 0 行：不交给对话）：这条消息还在待判断队列里时它离开。 */
  judgmentStopped(run: LaneRun): void {
    const pending = this.take(run.batch);
    if (!pending) return;
    pending.release = null;
    this.leave([pending]);
    this.team.emitDeciding();
  }

  /** @brief 用户会话的一次运行开始：排在准备中的消息已经交给 pi（sessions.ts releaseHeld）。 */
  userRunStarted(): void {
    for (const item of this.handed) if (item.via === 'held') item.via = 'pi';
  }

  /**
   * @brief 用户会话里 role 为 user、不是程序投递的消息开始（§5.3 第 5、6 步）：上一段结束；认出这是交给它的哪一条，
   *        记下它的时刻（对话的工作卡按它认出这条消息），它成为这一段。
   * @param message pi 的消息
   */
  messageStart(message: unknown): void {
    this.segmentEnd();
    const msg = message as SessionMessageLike;
    const index = matchHanded(this.handed, messageText(msg));
    if (index < 0) return;
    const [handed] = this.handed.splice(index, 1);
    if (!handed) return;
    handed.decision.timestamp = msg.timestamp ?? null;
    this.current = handed;
  }

  /** @brief 这一段的那条消息写进了对话会话：在它 message_end 之后的微任务里写回执（§13.2、§14.6 T-S6）。 */
  messageEnd(): void {
    const current = this.current;
    if (!current || current.written) return;
    current.written = true;
    queueMicrotask(() => this.writeReceipts(current.receipts));
  }

  /**
   * @brief 对话回复这条消息的那一段结束（§5.3 第 6 步：下一条用户消息的 message_start，或 agent_settled）：
   *        这条消息登记了新需求的，写 mori.progress。
   */
  segmentEnd(): void {
    const current = this.current;
    this.current = null;
    if (!current) return;
    if (!current.written) {
      current.written = true;
      this.writeReceipts(current.receipts);
    }
    const manager = this.team.userSession?.session.sessionManager;
    for (const request of current.registered) {
      manager?.appendCustomEntry(TEAM_ENTRY_TYPES.progress, { request });
      this.team.host.emitUser(this.team.userId, { type: 'mori.progress', request, at: Date.now() });
    }
  }

  /** @brief 写回执条目并发事件（实时与重新打开的顺序相同）。 */
  private writeReceipts(receipts: readonly ReceiptEntryData[]): void {
    const manager = this.team.userSession?.session.sessionManager;
    for (const receipt of receipts) {
      manager?.appendCustomEntry(TEAM_ENTRY_TYPES.receipt, receipt);
      this.team.host.emitUser(this.team.userId, { type: 'mori.receipt', ...receipt });
    }
  }

  /**
   * @brief 用户会话空闲了：交给对话却没写进对话会话的消息已经离开（准备中被停止、段开始时选不到模型、拒绝启动、
   *        停止时被拿回），回执和 mori.progress 写在对话流末尾（§13.2）。
   */
  userIdle(): void {
    const left = this.handed;
    this.handed = [];
    this.merged = [];
    this.leave(left);
  }

  /**
   * @brief 合并会话：一条你的消息交给用户会话（§5.3），记下原文（pi 照 v0 展开提示词模板时也记下展开后的文字），
   *        它的 message_start 据此认出这条消息、判断你输入的原文（§5.4 默认的原话）。
   * @param text 你输入的原文
   */
  handMerged(text: string): void {
    const templates = this.team.userSession?.session.promptTemplates ?? [];
    const alt = this.expand ? templateExpansion(text, templates, this.expand)?.text ?? null : null;
    this.merged.push({ text, alt });
  }

  /**
   * @brief 合并会话里一条 role 为 user 的消息是交给它的哪一条（matchHanded）：取出它，返回你输入的原文。
   * @param text 用户会话里这条消息的文字
   * @return 原文；不是交给它的任何一条（例如扩展用 sendUserMessage 发的）时为 null
   */
  takeMerged(text: string): string | null {
    const index = matchHanded(this.merged, text);
    return index < 0 ? null : this.merged.splice(index, 1)[0]?.text ?? null;
  }

  /** @brief 离开的消息：回执与进展摘要的位置写在对话流末尾（对话正在输出时在当前助手消息之后，team.writeUserEntry）。 */
  private leave(messages: readonly HeldWrites[]): void {
    for (const message of messages) {
      for (const receipt of message.receipts) {
        this.team.writeUserEntry(TEAM_ENTRY_TYPES.receipt, receipt, { type: 'mori.receipt', ...receipt });
      }
      for (const request of message.registered) {
        const event: KernelEvent = { type: 'mori.progress', request, at: Date.now() };
        this.team.writeUserEntry(TEAM_ENTRY_TYPES.progress, { request }, event);
      }
    }
  }

  /**
   * @brief 撤回（session.clearQueue，§5.3）：撤回立项还没开始判断的消息（不含对话正在为它准备中的那条）；交给了 pi 排队
   *        或插话、被 pi 的撤回拿回的消息离开（§13.2）。
   * @return 撤回的消息原文，按发送顺序
   */
  withdraw(): string[] {
    const out = this.pending.filter((item) => item.since === null && item.release === null);
    this.pending = this.pending.filter((item) => !out.includes(item));
    this.dropDeliveries(out);
    const gone = this.handed.filter((item) => item.via === 'pi');
    this.handed = this.handed.filter((item) => item.via !== 'pi');
    this.leave(gone);
    if (out.length) this.team.emitDeciding();
    return out.map((item) => item.item.text);
  }

  /**
   * @brief Esc 或 Stop team（§11.4）：待判断队列里的消息全部离开；stop 停下正在判断的立项（与别的 Agent），之后
   *        已经写下的回执与进展摘要的位置写在对话流末尾。对话正在为它准备中的那条由会话表随准备中一起撤回。
   * @param stop 停止；judging 为真时有一条正在判断
   * @return 回到输入框的消息原文，按发送顺序
   */
  async withdrawAll(stop: (judging: boolean) => Promise<void>): Promise<string[]> {
    const all = this.pending;
    this.pending = [];
    const starting = all.filter((item) => item.release !== null);
    for (const item of all) item.release = null;
    this.dropDeliveries(all);
    this.team.emitDeciding();
    await stop(all.some((item) => item.since !== null));
    this.leave(all);
    return all.filter((item) => !starting.includes(item)).map((item) => item.item.text);
  }

  /** @brief 从立项会话的投递队列里去掉这些消息的投递。 */
  private dropDeliveries(messages: readonly PendingMessage[]): void {
    const lane = this.team.createLane();
    const drop = new Set(messages.map((item) => item.delivery));
    lane.queue = lane.queue.filter((item) => !drop.has(item));
  }

  /** @brief 对话工作卡上这次请求“这条消息”的决定（§8.3）；没有时为 null。 */
  decisionFor(messages: readonly unknown[]): DecisionNote | null {
    return decisionFor(this.decisions, messages);
  }

  /** @brief 协作模式下照 v0 直接交给对话的扩展命令（§5.3）。 */
  noteCommand(name: string): void {
    this.command = name;
  }

  /** @brief 取出记下的扩展命令（用户会话一次运行开始时取，取后清掉）；没有时为 null。 */
  takeCommand(): string | null {
    const command = this.command;
    this.command = null;
    return command;
  }

  /** @brief 用户会话关闭（会话表只在没有待判断的消息时关闭，§11.5）：清掉状态。 */
  close(): void {
    this.pending = [];
    this.handed = [];
    this.merged = [];
    this.current = null;
  }
}

