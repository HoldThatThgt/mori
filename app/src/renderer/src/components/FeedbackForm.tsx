// 反馈表单（docs/v0/screens/selection.md "反馈"）：只问"What result were you hoping for?"，不发给模型。
// 主进程把它存成 <userData>/feedback/<时间>.json；保存失败时保留写好的字。在根组件旁挂一次。
// 开了增强的项目，反馈是这个项目每天增强的依据，底部说明随之不同（docs/specs/memory.md §10.7）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeFeedback, useFeedbackForm, type FeedbackRequest } from '../state/feedbackForm';
import { useOverlay } from '../state/overlays';
import { useApp } from '../state/store';
import { mainError } from '../state/bridge';
import { sessionTitle } from './ChatPane';

/** "Saved"停留的毫秒数 */
const SAVED_MS = 3000;
const GAP = 8;
const MARGIN = 12;

/** 这个会话的项目开着增强时的底部说明（§10.7） */
const NOTE_ENHANCED = 'Saved as evidence for this project’s daily enhancement. '
  + 'To have Mori act on it now, use “Attach as context” instead.';
/** 没开增强、会话没有项目、后台进程退出或读不出增强设置时的底部说明（§10.7、§10.10） */
const NOTE_SAVED_ONLY = 'This project doesn’t have enhancement on, so feedback is only saved. '
  + 'To have Mori act on it, use “Attach as context” instead.';

/** @brief 表单的位置：锚点下方，放不下时上方，夹在窗口里。 */
function placement(anchor: FeedbackRequest['anchor'], box: HTMLElement): { left: number; top: number } {
  const height = box.offsetHeight;
  const width = box.offsetWidth;
  const below = anchor.bottom + GAP;
  const top = below + height <= window.innerHeight - MARGIN ? below : anchor.top - height - GAP;
  return { left: Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)) };
}

/** @brief 保存这份反馈；失败时抛错。 */
async function save(request: FeedbackRequest, expected: string): Promise<void> {
  const tab = useApp.getState().tabs.find((item) => item.key === request.tabKey);
  const session = { file: tab?.sessionFile ?? null, cwd: tab?.cwd ?? '', title: tab ? sessionTitle(tab) : '' };
  await window.mori.saveFeedback({ expected: expected.trim(), quote: request.ref.quote, source: request.ref.source,
    session });
}

/**
 * @brief 底部说明（data-testid="feedback-note"）：enhance.get 返回之前留空、先占好这一行的高度（下面不可见的一份
 *        较长的说明撑开同一格），不先显示另一种说法；后台进程退出时按没开增强写（§10.10）。
 */
function Note() {
  const enhanced = useFeedbackForm((state) => state.enhanced);
  const exited = useApp((state) => state.kernel === 'exited');
  const text = exited ? NOTE_SAVED_ONLY : enhanced === null ? null : enhanced ? NOTE_ENHANCED : NOTE_SAVED_ONLY;
  return (
    <div style={{ display: 'grid' }}>
      <p className="feedback-note" data-testid="feedback-note" style={{ gridArea: '1 / 1' }}>{text}</p>
      {text === null && (
        <p className="feedback-note" aria-hidden="true" style={{ gridArea: '1 / 1', visibility: 'hidden' }}>
          {NOTE_SAVED_ONLY}</p>
      )}
    </div>
  );
}

/** @brief 表单里写字的部分：引用的原文、输入框、说明、错误、按钮。 */
function Editing({ quote, saving, error, onSubmit }: {
  quote: string; saving: boolean; error: string | null; onSubmit: (expected: string) => void;
}) {
  const [expected, setExpected] = useState('');
  return (
    <>
      <blockquote className="feedback-quote">{quote}</blockquote>
      <label className="feedback-label">What result were you hoping for?
        <textarea rows={3} value={expected} autoFocus disabled={saving} data-testid="feedback-input"
          onChange={(event) => setExpected(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !event.ctrlKey) return;
            event.preventDefault();
            if (expected.trim()) onSubmit(expected);
          }} />
      </label>
      <Note />
      {error && <p className="form-message error" role="alert" data-testid="feedback-error">
        Couldn’t save your feedback: {error}</p>}
      <div className="feedback-actions">
        <button className="button" disabled={saving} onClick={closeFeedback}>Cancel</button>
        <button className="button primary" disabled={!expected.trim() || saving}
          onClick={() => onSubmit(expected)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  );
}

/** @brief 一次反馈的表单：写字 → "Saving…" → "Saved"（约 3 秒后关闭）；保存失败回到写字，字还在。 */
function Form({ request }: { request: FeedbackRequest }) {
  const [phase, setPhase] = useState<'editing' | 'saving' | 'saved'>('editing');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useOverlay(true, () => (phase === 'saving' ? false : closeFeedback()));
  useLayoutEffect(() => {
    if (box.current) setPosition(placement(request.anchor, box.current));
  }, [request, phase]);
  useEffect(() => {
    if (phase !== 'saved') return;
    const timer = setTimeout(closeFeedback, SAVED_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  async function submit(expected: string) {
    if (phase !== 'editing') return;
    setPhase('saving');
    setError(null);
    try {
      await save(request, expected);
      setPhase('saved');
    } catch (failure) {
      setError(mainError('saveFeedback', failure));
      setPhase('editing');
    }
  }
  return (
    <div ref={box} className="feedback-form" role="dialog" aria-label="Feedback" data-testid="feedback-form"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}>
      {phase === 'saved'
        ? <p className="feedback-saved" role="status" data-testid="feedback-saved">Saved</p>
        : <Editing quote={request.ref.quote} saving={phase === 'saving'} error={error}
          onSubmit={(expected) => void submit(expected)} />}
    </div>
  );
}

/** @brief 反馈表单：有反馈请求时显示；每次打开换一个表单。 */
export function FeedbackForm() {
  const { request, seq } = useFeedbackForm();
  if (!request) return null;
  return <Form key={seq} request={request} />;
}
