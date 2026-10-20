// 输入框与按钮区：空闲时发送；生成中可以停止、排队（Enter）或插话（Ctrl+Enter）。输入法组字时 Enter 只选词。

import { useLayoutEffect, useRef, useState } from 'react';
import { send, stop, withdraw } from '../state/actions';
import { useOverlay } from '../state/overlays';
import { updateTab, type Tab } from '../state/store';
import { Icon } from '../icons';
import { ComposerQuotes } from './QuoteChips';

/** 输入框最高（px），超过后在框内滚动 */
const MAX_INPUT_HEIGHT = 220;

/** @brief 排队区：pi 的排队与插话列表；"撤回"把它们全部放回输入框。 */
export function QueueArea({ tab }: { tab: Tab }) {
  const { steering, followUp } = tab.transcript;
  if (steering.length + followUp.length === 0) return null;
  const rows = [...steering.map((text) => ({ kind: '插话', text })), ...followUp.map((text) => ({ kind: '排队', text }))];
  return (
    <div className="queue-area" data-testid="queue">
      <ul>
        {rows.map((row, index) => (
          <li key={index}>
            <span className="queue-kind">{row.kind}</span><span className="queue-text">{row.text}</span>
          </li>
        ))}
      </ul>
      <button className="text-link" onClick={() => void withdraw(tab.key)}>撤回</button>
    </div>
  );
}

/** @brief 生成中且有字时的"排队发送 ▾"，下拉里是"插话"。 */
function QueueButton({ tabKey }: { tabKey: string }) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  return (
    <div className="split-button">
      <button className="button" onClick={() => void send(tabKey, 'followUp')} title="本轮结束后发出（Enter）">排队发送</button>
      <button className="button split-toggle" aria-label="更多发送方式" aria-expanded={open}
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
  const { running, sending } = tab.transcript;
  // 只有引用芯片、没有字时也能发送（docs/v0/screens/selection.md）。
  const hasText = tab.draft.trim().length > 0 || tab.draftRefs.length > 0;

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [tab.draft]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 输入法组字时 Enter 是选词：isComposing、keyCode 229 或我们记录的组字状态任一成立都不发送。
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
    event.preventDefault();
    if (notReady || !hasText) return;
    if (running) void send(tab.key, event.ctrlKey ? 'steer' : 'followUp');
    else if (!sending) void send(tab.key);
  }

  return (
    <div className="composer" data-testid="composer" data-drop="composer" data-tab={tab.key}>
      <ComposerQuotes tab={tab} />
      <textarea ref={input} value={tab.draft} rows={2} aria-label="给 Mori 的消息" autoFocus
        placeholder={running ? 'Enter 排队 · Ctrl+Enter 插话 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}
        onChange={(event) => { const draft = event.target.value; updateTab(tab.key, (t) => ({ ...t, draft })); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={onKeyDown} />
      <ComposerButtons tab={tab} notReady={notReady} hasText={hasText} />
    </div>
  );
}

/** @brief 输入框下方的按钮区：不能发送时的说明；生成中的"排队发送"和"停止"；空闲时的"发送"。 */
function ComposerButtons({ tab, notReady, hasText }: { tab: Tab; notReady: string | null; hasText: boolean }) {
  const { running, sending } = tab.transcript;
  return (
    <div className="composer-bottom">
      <span className="composer-spacer" />
      {notReady && <span className="composer-wait" data-testid="not-ready">{notReady}</span>}
      {!notReady && running && hasText && <QueueButton tabKey={tab.key} />}
      {!notReady && running && (
        <button className="button stop-button" onClick={() => void stop(tab.key)} title="停止（Esc）">
          <Icon name="stop" />停止
        </button>
      )}
      {!notReady && !running && (
        <button className="button primary send-button" disabled={!hasText || sending}
          onClick={() => void send(tab.key)}>
          <Icon name="arrow" />发送
        </button>
      )}
    </div>
  );
}
