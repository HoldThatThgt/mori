// 回复下的操作（docs/v0/screens/selection.md "回复下的操作"）：每轮最后一条助手回复下的"Copy"、
// "Attach message as context"、"Give feedback"。照 Claude 桌面版：最新一轮一直显示，较早的在悬停或键盘聚焦时显示；
// 复制后按钮短暂显示"Copied"。

import { useEffect, useState } from 'react';
import { recordAction } from '../state/actionLog';
import { describe } from '../state/bridge';
import { openFeedback } from '../state/feedbackForm';
import { addQuote } from '../state/quotes';
import { turnSource, type ReplyTurn } from '../state/turns';
import { Icon } from '../icons';
import { focusComposer } from './SelectionPopover';

/** "Copied"停留的毫秒数（阅读器的"Path copied to clipboard."也用它） */
export const COPIED_MS = 2000;

/** @brief 复制按钮：成功时短暂显示"Copied"，失败时旁边显示"Copy failed"。 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    recordAction('Copy response');
    try {
      await window.mori.copyText(text);
      setState('copied');
    } catch (error) {
      describe('copyText', error);
      setState('failed');
    }
  }
  const label = state === 'copied' ? 'Copied' : 'Copy';
  return (
    <>
      <button className="reply-action" aria-label={label} title={label} onClick={() => void copy()}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} />{state === 'copied' && <span>Copied</span>}
      </button>
      {state === 'failed' && <span className="reply-action-error" role="alert">Copy failed</span>}
    </>
  );
}

/** @brief 一轮回复下的操作行。latest 为真时一直显示（最新一轮）。 */
export function ReplyActions({ turn, tabKey, sessionFile, latest }: {
  turn: ReplyTurn; tabKey: string; sessionFile: string | null; latest: boolean;
}) {
  const ref = { quote: turn.text, source: turnSource(turn, sessionFile) };
  const quote = () => {
    addQuote(tabKey, ref);
    focusComposer(tabKey);
  };
  const feedback = (event: React.MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    openFeedback({ tabKey, ref, anchor: button.getBoundingClientRect(), returnFocus: button }, null);
  };
  return (
    <div className={`reply-actions${latest ? ' latest' : ''}`} data-testid="reply-actions" data-no-quote>
      <CopyButton text={turn.text} />
      <button className="reply-action" aria-label="Attach message as context" title="Attach message as context"
        onClick={quote}>
        <Icon name="quote" />
      </button>
      <button className="reply-action" aria-label="Give feedback" title="Give feedback" onClick={feedback}>
        <Icon name="feedback" />
      </button>
    </div>
  );
}
