// 输入框与按钮区：空闲时发送；生成中可以停止、排队（Enter）或插话（Ctrl+Enter）。输入法组字时 Enter 只选词。
// M6：以 / 开头时输入框上方出"/"补全列表（SlashMenu.tsx），列表开着时 Enter 不发送。
// v1（docs/v1/screens/model-chat.md）：准备中（发了消息、pi 还没开始）可以停止，再发的按排队处理（不能插话），
// 显示在排队区；会话被拒绝启动时可以打字，但发送不可用（Enter 不发送，草稿不丢）。

import { useLayoutEffect, useRef, useState } from 'react';
import { send, stop, withdraw } from '../state/actions';
import { useOverlay } from '../state/overlays';
import { updateTab, type Tab } from '../state/store';
import { Icon } from '../icons';
import { skillCommandText } from '../state/skillText';
import { ComposerQuotes } from './QuoteChips';
import { handleSlashKey, SlashMenu, useSlashMenu } from './SlashMenu';

/** 输入框最高（px），超过后在框内滚动 */
const MAX_INPUT_HEIGHT = 220;

/**
 * @brief 排队区：pi 的排队与插话列表；"撤回"把它们全部放回输入框。准备中暂存的消息（后台进程还没交给 pi）也显示在这里，
 *        标 data-pending；暂存期间"撤回"不可用（停止会把它们一起放回输入框）。
 */
export function QueueArea({ tab }: { tab: Tab }) {
  const { steering, followUp, pendingQueue } = tab.transcript;
  if (steering.length + followUp.length + pendingQueue.length === 0) return null;
  // 技能命令在 pi 的队列里已经是展开后的正文，显示时写回"/skill:名字 参数"（slash.md）。
  const rows = [...steering.map((text) => ({ kind: '插话', text, pending: false })),
    ...followUp.map((text) => ({ kind: '排队', text, pending: false })),
    ...pendingQueue.map((text) => ({ kind: '排队', text, pending: true }))]
    .map((row) => ({ ...row, text: skillCommandText(row.text) }));
  return (
    <div className="queue-area" data-testid="queue">
      <ul>
        {rows.map((row, index) => (
          <li key={index} data-pending={row.pending ? 'true' : undefined}>
            <span className="queue-kind">{row.kind}</span><span className="queue-text">{row.text}</span>
          </li>
        ))}
      </ul>
      {pendingQueue.length === 0 && <button className="text-link" onClick={() => void withdraw(tab.key)}>撤回</button>}
    </div>
  );
}

/** @brief 生成中且有字时的"排队发送 ▾"，下拉里是"插话"；准备中不能插话，只有"排队发送"。 */
function QueueButton({ tabKey, steer, disabled }: { tabKey: string; steer: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const queue = <button className="button" disabled={disabled} onClick={() => void send(tabKey, 'followUp')}
    title="本轮结束后发出（Enter）">排队发送</button>;
  if (!steer) return queue;
  return (
    <div className="split-button">
      {queue}
      <button className="button split-toggle" aria-label="更多发送方式" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen(!open)}><Icon name="down" /></button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); void send(tabKey, 'steer'); }}>
            插话<span className="menu-hint">Ctrl+Enter</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * @brief 输入框。
 * @param notReady 不能发送时按钮位置显示的文字（"正在启动…"等）；能发送时为 null
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
    if (notReady || !hasText || tab.blocked) return;
    // 准备中（sending、还没 running）再发的由 send 按排队处理，Ctrl+Enter 也是（§11.4）。
    if (busy) void send(tab.key, event.ctrlKey && running ? 'steer' : 'followUp');
    else void send(tab.key);
  }

  return (
    <div className="composer" data-testid="composer" data-drop="composer" data-tab={tab.key}>
      {slash.open && <SlashMenu menu={slash} />}
      <ComposerQuotes tab={tab} />
      <textarea ref={input} value={tab.draft} rows={2} aria-label="给 Mori 的消息" autoFocus {...slash.inputProps}
        placeholder={placeholderText(running, sending)}
        onChange={(event) => {
          const draft = event.target.value;
          updateTab(tab.key, (t) => ({ ...t, draft }));
          slash.track(event.target);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={onKeyDown} />
      <ComposerButtons tab={tab} notReady={notReady} hasText={hasText} />
    </div>
  );
}

/** @brief 输入框的提示：空闲、生成中、准备中（不能插话）。 */
function placeholderText(running: boolean, sending: boolean): string {
  if (running) return 'Enter 排队 · Ctrl+Enter 插话 · Shift+Enter 换行';
  return sending ? 'Enter to queue · Shift+Enter for a new line' : 'Enter 发送 · Shift+Enter 换行';
}

/**
 * @brief 输入框下方的按钮区：不能发送时的说明；生成中与准备中的"排队发送"和"停止"；空闲时的"发送"。
 *        会话被拒绝启动时发送不可用（原因由输入框上方的拒绝启动卡说明）。
 */
function ComposerButtons({ tab, notReady, hasText }: { tab: Tab; notReady: string | null; hasText: boolean }) {
  const { running, sending } = tab.transcript;
  const busy = running || sending;
  const blocked = tab.blocked !== null;
  return (
    <div className="composer-bottom">
      <span className="composer-spacer" />
      {notReady && <span className="composer-wait" data-testid="not-ready">{notReady}</span>}
      {!notReady && busy && hasText && <QueueButton tabKey={tab.key} steer={running} disabled={blocked} />}
      {!notReady && busy && (
        <button className="button stop-button" onClick={() => void stop(tab.key)} title="停止（Esc）">
          <Icon name="stop" />停止
        </button>
      )}
      {!notReady && !busy && (
        <button className="button primary send-button" disabled={!hasText || blocked}
          onClick={() => void send(tab.key)}>
          <Icon name="arrow" />发送
        </button>
      )}
    </div>
  );
}
