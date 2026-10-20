// 回复下的操作（docs/v0/screens/selection.md "回复下的操作"）：每轮最后一条助手回复下的复制、引用到输入框、反馈这条回复。
// 照 Claude 桌面版：最新一轮一直显示，较早的在悬停或键盘聚焦时显示；复制后按钮短暂显示"已复制"。

import { useEffect, useState } from 'react';
import { recordAction } from '../state/actionLog';
import { describe } from '../state/bridge';
import { openFeedback } from '../state/feedbackForm';
import { addQuote } from '../state/quotes';
import { turnSource, type ReplyTurn } from '../state/turns';
import { Icon } from '../icons';
import { focusComposer } from './SelectionPopover';

/** "已复制"停留的毫秒数 */
const COPIED_MS = 2000;

/** @brief 复制按钮：成功时短暂显示"已复制"，失败时旁边显示"复制失败"。 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    recordAction('复制回复');
    try {
      await window.mori.copyText(text);
      setState('copied');
    } catch (error) {
      describe('copyText', error);
      setState('failed');
    }
  }
  const label = state === 'copied' ? '已复制' : '复制';
  return (
    <>
      <button className="reply-action" aria-label={label} title={label} onClick={() => void copy()}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} />{state === 'copied' && <span>已复制</span>}
      </button>
      {state === 'failed' && <span className="reply-action-error" role="alert">复制失败</span>}
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
      <button className="reply-action" aria-label="引用到输入框" title="引用到输入框" onClick={quote}>
        <Icon name="quote" />
      </button>
      <button className="reply-action" aria-label="反馈这条回复" title="反馈这条回复" onClick={feedback}>
        <Icon name="feedback" />
      </button>
    </div>
  );
}
