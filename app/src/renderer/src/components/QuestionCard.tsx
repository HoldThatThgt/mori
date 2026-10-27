// 询问卡：扩展的询问（docs/v0/screens/extension-ui.md）与提问卡（ask_user_question，AskCard.tsx，
// docs/specs/file-system-permissions.md §10.4）排在一个队列里，按到达顺序一次显示一张，"{n} more" 计入两种；
// 有批准卡（对话的或后台实例的）时先显示批准卡（docs/v1/screens/fs-question.md "提问卡"）。
// 扩展询问卡：确认、选择、输入。停靠在输入框上方，不抢输入框的焦点，没有默认按钮，Enter 不会作答（输入框里的 Enter
// 除外）。焦点在卡上时 Esc：先关开着的浮层，没有浮层时确认等于"No"、选择和输入等于"Cancel"。你不在时最后 20 秒卡头下一行
// 显示 You’re away · Cancelling in 12s，扩展自己的超时一行照旧（§9.9、§10.9）。

import { useRef, useState } from 'react';
import { answerQuestion } from '../state/actions';
import type { PendingExtensionQuestion } from '../state/model';
import { closeTopOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { AwayCountdown, useFocusBack } from './ApprovalCard';
import { AskCard } from './AskCard';
import { useNow } from './ToolCard';

/** @brief 有超时的询问还剩几秒；没有超时时为 null。 */
function secondsLeft(question: PendingExtensionQuestion, now: number): number | null {
  if (!question.timeoutMs) return null;
  return Math.max(0, Math.ceil((question.askedAt + question.timeoutMs - now) / 1000));
}

/** @brief 询问卡上的按钮与输入框。 */
function QuestionActions({ question, send }: {
  question: PendingExtensionQuestion; send: (value: boolean | string | null) => void;
}) {
  const [text, setText] = useState('');
  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send(text);
  }
  if (question.method === 'confirm') {
    return (
      <div className="approval-actions">
        <button className="button" onClick={() => send(true)}>Yes</button>
        <button className="button" onClick={() => send(false)}>No</button>
      </div>
    );
  }
  return (
    <div className="approval-actions">
      {question.method === 'select' && (question.options ?? []).map((option) => (
        <button key={option} className="button" onClick={() => send(option)}>{option}</button>
      ))}
      {question.method === 'input' && <>
        <input className="approval-reason" aria-label={question.title} placeholder={question.placeholder ?? ''}
          value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onInputKeyDown} />
        <button className="button" onClick={() => send(text)}>Submit</button>
      </>}
      <button className="button" onClick={() => send(null)}>Cancel</button>
    </div>
  );
}

/** @brief 一张扩展询问卡。more 是排在后面的询问卡张数（扩展询问与提问卡都算）。 */
function Question({ tabKey, question, more }: { tabKey: string; question: PendingExtensionQuestion; more: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(Boolean(question.timeoutMs));
  const left = secondsLeft(question, now);
  useFocusBack(ref);
  const send = (value: boolean | string | null) => void answerQuestion(tabKey, question.requestId, value);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (closeTopOverlay()) return;
    send(question.method === 'confirm' ? false : null);
  }

  return (
    <div ref={ref} className="approval-card question-card" role="group"
      aria-label={`An extension needs your input: ${question.title}`} data-testid="ext-ui-card"
      data-request={question.requestId} data-method={question.method} onKeyDown={onKeyDown}>
      <div className="approval-head">
        <span className="approval-title">An extension needs your input</span>
        {more > 0 && <span className="approval-more" data-testid="approval-more">{more} more</span>}
      </div>
      <AwayCountdown kind="extension" deadline={question.deadline} />
      <div className="question-body">
        <p className="question-title">{question.title}</p>
        {question.message && <p className="question-message">{question.message}</p>}
        {left !== null && (
          <p className="question-timeout">
            {left === 1 ? 'This request expires in 1 second' : `This request expires in ${left} seconds`}
          </p>
        )}
      </div>
      <QuestionActions question={question} send={send} />
    </div>
  );
}

/**
 * @brief 一个会话的询问卡：有批准卡（对话的或后台实例的）时先显示批准卡；只显示队列最前面的一张（扩展询问或提问卡），
 *        处理完下一张接着出现。
 */
export function QuestionCard({ tab }: { tab: Tab }) {
  const { questions, approvals, teamApprovals } = tab.transcript;
  const front = questions[0];
  if (!front || approvals.length + teamApprovals.length > 0) return null;
  const more = questions.length - 1;
  if (front.kind === 'ask') return <AskCard key={front.requestId} tabKey={tab.key} ask={front} more={more} />;
  return <Question key={front.requestId} tabKey={tab.key} question={front} more={more} />;
}
