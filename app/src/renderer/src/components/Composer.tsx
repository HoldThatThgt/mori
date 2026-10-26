// 输入框：文字框和它下面一行（docs/v0/screens/chat.md"输入框下面一行"：左端权限；右边选择范围、Effort、上下文用量圆环，
// 最右是发送 / 停止 / 排队）。空闲时发送；生成中可以停止、排队（Enter）或插话（Ctrl+Enter）。输入法组字时 Enter 只选词。
// M6：以 / 开头时输入框上方出"/"补全列表（SlashMenu.tsx），列表开着时 Enter 不发送。
// v1（docs/v1/screens/model-chat.md）：准备中（发了消息、pi 还没开始）可以停止，再发的按排队处理（不能插话），
// 显示在排队区；会话被拒绝启动时可以打字，但发送不可用（Enter 不发送，草稿不丢）。
// 平行 Agent（docs/v1/screens/team-switch.md、team-stop.md）：/team on、/team off 在生成中、被拒绝启动时也按命令处理；
// 排队区里有立项还没判断完的消息；后台有 Agent 在运行或排队时停止按钮旁有 Stop agents。

import { useEffect, useLayoutEffect, useRef } from 'react';
import { roleLabel } from '../../../shared/team';
import { send, stop, stopTeam, withdraw } from '../state/actions';
import { pendingPrompt } from '../state/model';
import { updateTab, type Tab } from '../state/store';
import { parseTeamCommand } from '../state/teamActions';
import { Icon, type IconName } from '../icons';
import { skillCommandText } from '../state/skillText';
import { firstMenuItem, moveMenuFocus } from './menu';
import { ModelMenu } from './ModelMenu';
import { PermissionMenu } from './PermissionMenu';
import { ComposerQuotes } from './QuoteChips';
import { useFocusFallback, useHiddenFallback, useRowMenu, useRowPlacement } from './rowMenu';
import { handleSlashKey, SlashMenu, useSlashMenu } from './SlashMenu';
import { ThinkingMenu } from './ThinkingMenu';
import { UsageRing } from './UsageRing';

/** 输入框最高（px），超过后在框内滚动 */
const MAX_INPUT_HEIGHT = 220;

/**
 * @brief 待判断、还没交给对话的消息（平行 Agent 规格 §5.3）：已作为准备中先显示在对话流里的那一条除外；
 *        withdrawable 为"Withdraw"能带回的条数（立项正在判断的那条不撤回）。
 */
function decidingRows(transcript: Tab['transcript']): { texts: string[]; withdrawable: number } {
  const { deciding } = transcript;
  if (!deciding) return { texts: [], withdrawable: 0 };
  const pending = pendingPrompt(transcript)?.text;
  const shownAt = pending === undefined ? -1 : deciding.queue.findIndex((message) => message.text === pending);
  const texts = deciding.queue.flatMap((message, at) => (at === shownAt ? [] : [message.text]));
  // 正在判断的是队首（立项空闲时取队首，§5.3 第 2 步）；它显示在排队区时不算可以撤回的。
  const judgedShown = deciding.since !== null && shownAt !== 0;
  return { texts, withdrawable: texts.length - (judgedShown ? 1 : 0) };
}

/**
 * @brief 排队区：pi 的排队与插话列表；"Withdraw"把它们全部放回输入框。准备中暂存的消息（后台进程还没交给 pi）也显示在
 *        这里，标 data-pending；暂存期间"Withdraw"不可用（停止会把它们一起放回输入框）。协作模式下另有立项还没判断完的
 *        消息，标 Waiting for <create role>（data-deciding）；只剩正在判断的那一条时"Withdraw"不可用（team-stop.md）。
 */
export function QueueArea({ tab }: { tab: Tab }) {
  const { steering, followUp, pendingQueue, deciding } = tab.transcript;
  const waiting = decidingRows(tab.transcript);
  if (steering.length + followUp.length + pendingQueue.length + waiting.texts.length === 0) return null;
  const waitKind = `Waiting for ${roleLabel(deciding?.role ?? tab.team.holders.create)}`;
  // 技能命令在 pi 的队列里已经是展开后的正文，显示时写回"/skill:名字 参数"（slash.md）。
  const rows = [...steering.map((text) => ({ kind: 'Steer', text, pending: false, deciding: false })),
    ...followUp.map((text) => ({ kind: 'Queued', text, pending: false, deciding: false })),
    ...pendingQueue.map((text) => ({ kind: 'Queued', text, pending: true, deciding: false })),
    ...waiting.texts.map((text) => ({ kind: waitKind, text, pending: false, deciding: true }))]
    .map((row) => ({ ...row, text: skillCommandText(row.text) }));
  const withdrawable = steering.length + followUp.length + waiting.withdrawable > 0;
  return (
    <div className="queue-area" data-testid="queue">
      <ul>
        {rows.map((row, index) => (
          <li key={index} data-pending={row.pending ? 'true' : undefined}
            data-deciding={row.deciding ? 'true' : undefined}>
            <span className="queue-kind">{row.kind}</span><span className="queue-text">{row.text}</span>
          </li>
        ))}
      </ul>
      {pendingQueue.length === 0 && withdrawable && (
        <button className="text-link" onClick={() => void withdraw(tab.key)}>Withdraw</button>
      )}
    </div>
  );
}

/** @brief 发送组里的一个按钮。 */
interface RowButtonProps {
  /** 这一栏会话（界面里的标识） */
  tabKey: string;
  /** 类名（send-button、stop-button、queue-button） */
  className: string;
  /** 名字（读屏名；会话面板宽于 600px 时也是按钮上的字，Stop agents 宽于 760px 时才是） */
  label: string;
  /** 悬停说明 */
  title: string;
  /** 图标（宽于 600px 时"Queue"不显示图标，chat.css） */
  icon: IconName;
  /** 不可用（disabled，不在 Tab 路径上） */
  disabled?: boolean;
  /** 界面测试用的标识（data-testid） */
  testId?: string;
  /** 点了它 */
  onClick: () => void;
}

/**
 * @brief "Send"、"Stop"和准备中只有一个按钮的"Queue"：会话面板 ≤ 600px 时只有图标（chat.css），名字在 aria-label 和
 *        悬停说明里。按钮随状态消失（本轮结束时的"Stop"、清空草稿时的"Queue"、发出时的"Send"）而焦点在它上面时，
 *        焦点回到文字框。
 */
function RowButton({ tabKey, className, label, title, icon, disabled, testId, onClick }: RowButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  useFocusFallback(button, tabKey);
  return (
    <button ref={button} className={`button ${className}`} aria-label={label} title={title} disabled={disabled}
      data-testid={testId} onClick={onClick}>
      <Icon name={icon} className={`${icon}-icon`} /><span className="send-text">{label}</span>
    </button>
  );
}

/**
 * @brief 生成中且有字时的"Queue ▾"：主按钮排队，▾"More send options"的菜单里是"Steer"；会话面板 ≤ 400px（有 Stop agents
 *        时 ≤ 520px）时主按钮收起（chat.css），菜单里多出排队的那一项；≤ 340px 有 Stop agents 时整组收起（Enter、Ctrl+Enter 照样用），
 *        开着的菜单随之关上。菜单往上打开、右边对齐 ▾，打开时焦点在第一项，点外面、Tab 移出时关闭，Esc 回到 ▾。
 */
function QueueMenu({ tab, disabled }: { tab: Tab; disabled: boolean }) {
  const menu = useRowMenu(tab, disabled);
  const panel = useRef<HTMLDivElement>(null);
  useRowPlacement(menu.open, menu.button, panel, 'anchor');
  useHiddenFallback(menu.root, tab.key, tab.team.background, () => menu.setOpen(false));
  useEffect(() => {
    if (menu.open) firstMenuItem(panel.current)?.focus();
  }, [menu.open]);

  function choose(behavior: 'followUp' | 'steer') {
    // 焦点先回到 ▾：发出后草稿清空、这一组消失时焦点由 useFocusFallback 放回文字框
    menu.close();
    void send(tab.key, behavior);
  }

  return (
    <div className="split-button" ref={menu.root}>
      <button className="button queue-main" aria-label="Queue" title="Queue for later (Enter)" disabled={disabled}
        onClick={() => void send(tab.key, 'followUp')}>
        <Icon name="queue" className="queue-icon" /><span className="send-text">Queue</span>
      </button>
      <button ref={menu.button} className="button split-toggle" aria-label="More send options" aria-haspopup="menu"
        aria-expanded={menu.open} disabled={disabled} onClick={() => menu.setOpen(!menu.open)}>
        <Icon name="down" />
      </button>
      {menu.open && (
        <div ref={panel} className="menu send-menu" role="menu" aria-label="More send options"
          onKeyDown={moveMenuFocus}>
          <button role="menuitem" className="queue-later" aria-keyshortcuts="Enter" onClick={() => choose('followUp')}>
            Queue for later<span className="menu-hint" aria-hidden="true">Enter</span>
          </button>
          <button role="menuitem" aria-keyshortcuts="Control+Enter" onClick={() => choose('steer')}>
            Steer<span className="menu-hint" aria-hidden="true">Ctrl+Enter</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** @brief 原文是 /team on 或 /team off：生成中、被拒绝启动时也照样执行（team-switch.md "输入框里的 /team"）。 */
function isTeamSwitch(draft: string): boolean {
  return parseTeamCommand(draft).kind === 'switch';
}

/**
 * @brief 输入框。
 * @param notReady 不能发送时按钮位置显示的文字（"Starting…"等）；能发送时为 null
 */
export function Composer({ tab, notReady }: { tab: Tab; notReady: string | null }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const slash = useSlashMenu(tab, notReady, input);
  const { running, sending } = tab.transcript;
  // 只有引用芯片、没有字时也能发送（docs/v0/screens/selection.md）。
  const hasText = tab.draft.trim().length > 0 || tab.draftRefs.length > 0;
  const busy = running || sending;

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [tab.draft]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 输入法组字时 Enter 是选词：isComposing、keyCode 229 或我们记录的组字状态任一成立都不发送，也不动补全列表。
    const imeActive = event.nativeEvent.isComposing || event.keyCode === 229 || composing.current;
    if (handleSlashKey(slash, event, imeActive)) return;
    if (event.key !== 'Enter' || event.shiftKey || imeActive) return;
    event.preventDefault();
    if (notReady || !hasText) return;
    if (tab.blocked && !isTeamSwitch(tab.draft)) return;
    // 准备中（sending、还没 running）再发的由 send 按排队处理，Ctrl+Enter 也是（§11.4）；/team on、off 由 send 先认出。
    if (busy) void send(tab.key, event.ctrlKey && running ? 'steer' : 'followUp');
    else void send(tab.key);
  }

  return (
    <div className="composer" data-testid="composer" data-drop="composer" data-tab={tab.key}>
      {slash.open && <SlashMenu menu={slash} />}
      <ComposerQuotes tab={tab} />
      <textarea ref={input} value={tab.draft} rows={2} aria-label="Message Mori" autoFocus {...slash.inputProps}
        placeholder={placeholderText(running, sending)}
        onChange={(event) => {
          const draft = event.target.value;
          updateTab(tab.key, (t) => ({ ...t, draft }));
          slash.track(event.target);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={onKeyDown} />
      <ComposerRow tab={tab} notReady={notReady} hasText={hasText} />
    </div>
  );
}

/** @brief 输入框的提示：空闲、生成中、准备中（不能插话）。 */
function placeholderText(running: boolean, sending: boolean): string {
  if (running) return 'Enter to queue · Ctrl+Enter to steer · Shift+Enter for new line';
  return sending ? 'Enter to queue · Shift+Enter for new line' : 'Enter to send · Shift+Enter for new line';
}

/**
 * @brief Stop agents（平行 Agent 规格 §11.4、§13.6；2026-10-26 前叫 Stop team）：停止这个会话的全部 Agent，不确认；
 *        会话面板 ≤ 760px 时就只有
 *        图标（比"Stop"的 600px 早，带字时 601–708px 最挤会截模式名，chat.css）。
 */
function StopTeamButton({ tabKey }: { tabKey: string }) {
  return <RowButton tabKey={tabKey} className="stop-team-button" label="Stop agents" testId="stop-team"
    title="Stop all agents in this session" icon="stop" onClick={() => void stopTeam(tabKey)} />;
}

/**
 * @brief 发送组：不能发送时的说明（放不下时截短，悬停看全文）；生成中有字时"Queue ▾"、准备中有字时只有一个按钮的
 *        "Queue"（准备中不能插话），加上"Stop"；空闲时的"Send"；后台有 Agent 在运行或排队时，"Stop"或"Send"前的
 *        Stop agents。会话被拒绝启动时发送不可用（原因在输入框上方的拒绝启动卡里），/team on、/team off 除外。
 *        会话面板 ≤ 340px 时有 Stop agents 就收起排队的按钮（chat.css，models.md"窄栏"）。
 */
function SendGroup({ tab, notReady, hasText }: { tab: Tab; notReady: string | null; hasText: boolean }) {
  const { running, sending } = tab.transcript;
  const blocked = tab.blocked !== null && !isTeamSwitch(tab.draft);
  if (notReady) return <span className="composer-wait" data-testid="not-ready" title={notReady}>{notReady}</span>;
  // 各按钮带 key：发送组在"Stop"和"Send"之间换时不复用同一个按钮（复用时焦点会留在变得不可用的"Send"上、掉到 body）
  const team = tab.team.background && <StopTeamButton key="stop-team" tabKey={tab.key} />;
  if (!running && !sending) {
    return (
      <>
        {team}
        <RowButton key="send" tabKey={tab.key} className="primary send-button" label="Send" title="Send (Enter)"
          icon="arrow" disabled={!hasText || blocked} onClick={() => void send(tab.key)} />
      </>
    );
  }
  return (
    <>
      {hasText && running && <QueueMenu tab={tab} disabled={blocked} />}
      {hasText && !running && <RowButton key="queue" tabKey={tab.key} className="queue-button" label="Queue"
        title="Queue for later (Enter)" icon="queue" disabled={blocked}
        onClick={() => void send(tab.key, 'followUp')} />}
      {team}
      <RowButton key="stop" tabKey={tab.key} className="stop-button" label="Stop" title="Stop response (Esc)"
        icon="stop" onClick={() => void stop(tab.key)} />
    </>
  );
}

/**
 * @brief 文字框下面一行（docs/v0/screens/chat.md"输入框下面一行"、models.md）：左端权限；右边选择范围、Effort、
 *        上下文用量圆环，最右是发送组。各项都是这一行的直接子项（截短的先后靠 flex-shrink，它只在兄弟之间分宽度，
 *        chat.css）。选择范围、Effort 和圆环在第一次打开中、打开失败时不显示；Restart 之后重新打开中仍显示上一次的值
 *        （不可用，ModelState 没有清空）。没有当前模型时没有 Effort。Stop agents 出现、准备中的"Queue"因此藏起时
 *        焦点在它上面的回到文字框。
 */
function ComposerRow({ tab, notReady, hasText }: { tab: Tab; notReady: string | null; hasText: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  useHiddenFallback(row, tab.key, tab.team.background);
  const known = tab.pick !== null || tab.current !== null || tab.blocked !== null;
  const pickers = tab.phase !== 'failed' && (tab.phase !== 'opening' || known);
  return (
    <div className="composer-bottom" ref={row}>
      <PermissionMenu tab={tab} unavailable={notReady} />
      {pickers && <ModelMenu tab={tab} unavailable={notReady} />}
      {pickers && tab.current && <ThinkingMenu tab={tab} unavailable={notReady} />}
      {pickers && tab.contextUsage && <UsageRing tab={tab} usage={tab.contextUsage} />}
      <SendGroup tab={tab} notReady={notReady} hasText={hasText} />
    </div>
  );
}
