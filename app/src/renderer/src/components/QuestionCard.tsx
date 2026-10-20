// 扩展的询问卡（docs/v0/screens/extension-ui.md）：确认、选择、输入。停靠在输入框上方，排在批准卡之后；
// 不抢输入框的焦点，没有默认按钮，Enter 不会作答（输入框里的 Enter 除外）。焦点在卡上时 Esc：先关开着的浮层，
// 没有浮层时确认等于"否"、选择和输入等于取消。

import { useRef, useState } from 'react';
import { answerQuestion } from '../state/actions';
import type { PendingQuestion } from '../state/model';
import { closeTopOverlay } from '../state/overlays';
import type { Tab } from '../state/store';
import { useFocusBack } from './ApprovalCard';
import { useNow } from './ToolCard';

/** @brief 有超时的询问还剩几秒；没有超时时为 null。 */
function secondsLeft(question: PendingQuestion, now: number): number | null {
  if (!question.timeoutMs) return null;
  return Math.max(0, Math.ceil((question.askedAt + question.timeoutMs - now) / 1000));
}

/** @brief 询问卡上的按钮与输入框。 */
function QuestionActions({ question, send }: {
  question: PendingQuestion; send: (value: boolean | string | null) => void;
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
        <button className="button" onClick={() => send(true)}>是</button>
        <button className="button" onClick={() => send(false)}>否</button>
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
        <button className="button" onClick={() => send(text)}>确定</button>
      </>}
      <button className="button" onClick={() => send(null)}>取消</button>
    </div>
  );
}

/** @brief 一张询问卡。more 是排在后面的个数。 */
function Question({ tabKey, question, more }: { tabKey: string; question: PendingQuestion; more: number }) {
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
    <div ref={ref} className="approval-card question-card" role="group" aria-label={`扩展的询问：${question.title}`}
      data-testid="ext-ui-card" data-request={question.requestId} data-method={question.method} onKeyDown={onKeyDown}>
      <div className="approval-head">
        <span className="approval-title">扩展的询问</span>
        {more > 0 && <span className="approval-more">还有 {more} 个</span>}
      </div>
      <div className="question-body">
        <p className="question-title">{question.title}</p>
        {question.message && <p className="question-message">{question.message}</p>}
        {left !== null && <p className="question-timeout">{left} 秒后自动取消</p>}
      </div>
      <QuestionActions question={question} send={send} />
    </div>
  );
}

/** @brief 一个会话的扩展询问：有批准卡时先显示批准卡；只显示最前面的询问，处理完下一个接着出现。 */
export function QuestionCard({ tab }: { tab: Tab }) {
  const { questions, approvals } = tab.transcript;
  const front = questions[0];
  if (!front || approvals.length > 0) return null;
  return <Question key={front.requestId} tabKey={tab.key} question={front} more={questions.length - 1} />;
}
