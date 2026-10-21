// 工作回顾的详情（右栏，docs/v0/screens/review.md "详情"、"回到原位置"）：选中的一条反馈、界面问题报告或读不出来的记录。
// 反馈：时间、来源、What you hoped for、Quoted text、Jump to source（只在点它时检查）；界面问题：时间、两段原文、
// 截图（点开浮层按原尺寸看）、可以展开的 Current view / Recent activity / Versions、Show in Explorer；读不出来的记录：
// 文件名、原文、Show in Explorer；都可以 Resolve 或 Reopen。
// 右栏的宽度与会话的右栏共用（App.tsx 传进分隔线）。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  KIND_LABEL, type BrokenRecord, type FeedbackRecord, type IssueRecord, type ReviewKind,
} from '../../../shared/review';
import { recordAction } from '../state/actionLog';
import { mainError } from '../state/bridge';
import { useOverlay } from '../state/overlays';
import { sessionGone } from '../state/refActions';
import {
  feedbackSessionFile, feedbackSessionName, isHandled, jumpBack, selectedRecord, selectRecord, setHandled, useReview,
  type JumpState, type ReviewItem,
} from '../state/review';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { feedbackScope, recordTime } from './reviewText';

/** @brief "Resolve" / "Reopen"。 */
function HandledButton({ section, name }: { section: ReviewKind; name: string }) {
  const handled = useReview((state) => isHandled(state, section, name));
  return (
    <button type="button" className="button" data-testid="detail-handled"
      onClick={() => setHandled(section, name, !handled)}>
      <Icon name="check" />{handled ? 'Reopen' : 'Resolve'}</button>
  );
}

/**
 * @brief 详情底部的按钮：界面问题和读不出来的记录有"Show in Explorer"（资源管理器里选中这个文件）；都有标已处理。
 * @param reveal 是否有"Show in Explorer"
 */
function RecordActions({ section, name, reveal }: { section: ReviewKind; name: string; reveal: boolean }) {
  const [error, setError] = useState<string | null>(null);
  async function showFile() {
    recordAction('Show record in Explorer');
    setError(null);
    try {
      await window.mori.showReviewRecord(section, name);
    } catch (failure) {
      setError(mainError('showReviewRecord', failure));
    }
  }
  return (
    <>
      {error && <p className="form-message error" role="alert">{error}</p>}
      <div className="review-detail-actions">
        {reveal && (
          <button type="button" className="button" data-testid="detail-show-file" onClick={() => void showFile()}>
            <Icon name="folder" />Show in Explorer</button>
        )}
        <HandledButton section={section} name={name} />
      </div>
    </>
  );
}

/** @brief 反馈的来源：会话名（侧栏现在的名字）、范围、工作目录。 */
function FeedbackSource({ record }: { record: FeedbackRecord }) {
  const name = useApp((state) => feedbackSessionName(state, record));
  const { source, session } = record.feedback;
  return (
    <dl className="review-detail-source" data-testid="detail-source">
      <dt>Session</dt><dd>{name}</dd>
      <dt>{source.kind === 'file' ? 'File' : 'Scope'}</dt>
      <dd title={source.kind === 'file' ? source.path : undefined}>{feedbackScope(record.feedback)}</dd>
      <dt>Working directory</dt><dd>{session.cwd || '(not recorded)'}</dd>
    </dl>
  );
}

/** @brief 回到原位置不可用或没有成功的说明；可以回去时为 null。 */
function jumpStatus(file: string | null, gone: boolean, exited: boolean, jump: JumpState | undefined): string | null {
  if (!file) return 'The session wasn’t saved, so there’s no source to jump to.';
  if (gone) return 'Session deleted';
  if (exited) return 'Mori’s background process crashed. Restart it to continue.';
  if (jump?.kind === 'changed') return 'This response is no longer in the session.';
  return jump?.kind === 'error' ? jump.text : null;
}

/** @brief "Jump to source"和它的结果：正在检查时"Opening…"；原会话没有保存、已删除、后台进程已退出时不可用。 */
function JumpBack({ record }: { record: FeedbackRecord }) {
  const file = feedbackSessionFile(record);
  const listedGone = useApp((state) => file !== null && sessionGone(state, file));
  const exited = useApp((state) => state.kernel === 'exited');
  const jump = useReview((state) => state.jumps[record.name]);
  const gone = listedGone || jump?.kind === 'gone';
  const checking = jump?.kind === 'checking';
  const status = jumpStatus(file, gone, exited, jump);
  const blocked = !file || gone || exited;
  return (
    <div className="review-jump">
      <button type="button" className="button" data-testid="detail-jump" disabled={blocked || checking}
        title={blocked ? status ?? undefined : undefined} onClick={() => void jumpBack(record)}>
        <Icon name="back" />{checking ? 'Opening…' : 'Jump to source'}</button>
      {status && (
        <p className={`form-message ${jump?.kind === 'error' ? 'error' : 'review-warn'}`} role="status"
          data-testid="detail-jump-status">{status}</p>
      )}
    </div>
  );
}

/** @brief 反馈的详情。 */
function FeedbackDetail({ record }: { record: FeedbackRecord }) {
  const { feedback } = record;
  return (
    <>
      <p className="review-detail-time" data-testid="detail-time">{recordTime(record, true)}</p>
      <FeedbackSource record={record} />
      <h3 className="review-detail-label">What you hoped for</h3>
      <p className="review-detail-text" data-testid="detail-expected">{feedback.expected}</p>
      <h3 className="review-detail-label">Quoted text</h3>
      <blockquote className="review-detail-quote" data-testid="detail-quote" tabIndex={0} aria-label="Quoted text">
        {feedback.quote}</blockquote>
      <JumpBack record={record} />
      <RecordActions section="feedback" name={record.name} reveal={false} />
    </>
  );
}

/** @brief 截图的读取结果：读取中（都为 null）、data URL，或读不出来的原文。 */
interface ShotState {
  /** 截图的 data URL */
  url: string | null;
  /** 读不出来的原文 */
  error: string | null;
}

/** @brief 让主进程读一份报告的截图。 */
function useShot(shot: string): ShotState {
  const [state, setState] = useState<ShotState>({ url: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ url: null, error: null });
    window.mori.reviewShot(shot).then(
      (url) => live && setState({ url, error: null }),
      (failure) => live && setState({ url: null, error: mainError('reviewShot', failure) }),
    );
    return () => {
      live = false;
    };
  }, [shot]);
  return state;
}

/** @brief 截图浮层：按原尺寸显示，大于窗口时缩到窗口内；Esc、"Close"或点截图外面关闭。 */
function ShotViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useOverlay(true, onClose);
  useEffect(() => close.current?.focus(), []);
  const outside = (target: EventTarget) => !(target as Element).closest('img, button');
  // 浮层挂到 body 上（右栏在窄窗口下是定位容器）；在截图外面按下鼠标不让焦点离开浮层，松开时关闭。
  return createPortal(
    <div className="shot-backdrop" onMouseDown={(event) => outside(event.target) && event.preventDefault()}
      onClick={(event) => outside(event.target) && onClose()}>
      <div className="shot-viewer" role="dialog" aria-modal="true" aria-label="Screenshot" data-testid="shot-viewer"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          event.preventDefault();
          close.current?.focus();
        }}>
        <img src={url} alt="Screenshot of the window when this was reported" />
        <button ref={close} type="button" className="button" onClick={onClose}>Close</button>
      </div>
    </div>,
    document.body,
  );
}

/** @brief 报告的截图：读取中、读不出来的原文，或按右栏宽度缩小的截图（点它或 Enter 放大）。 */
function Shot({ shot }: { shot: string }) {
  const { url, error } = useShot(shot);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const closeViewer = () => {
    setOpen(false);
    button.current?.focus();
  };
  if (error) {
    return <p className="form-message error" data-testid="detail-shot-error">Couldn’t load the screenshot: {error}</p>;
  }
  if (!url) {
    return <p className="review-detail-loading" role="status" data-testid="detail-shot-loading">Loading screenshot…</p>;
  }
  return (
    <>
      <button ref={button} type="button" className="review-shot" aria-label="View full screenshot"
        onClick={() => setOpen(true)}>
        <img src={url} alt="Screenshot of the window when this was reported" data-testid="detail-shot" />
      </button>
      {open && <ShotViewer url={url} onClose={closeViewer} />}
    </>
  );
}

/** @brief 可以展开的一节原文（Current view、Recent activity、Versions）。 */
function MoreSection({ testId, summary, text }: { testId: string; summary: string; text: string }) {
  return (
    <details className="review-detail-more" data-testid={testId}>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  );
}

/** @brief 界面问题报告的详情。 */
function IssueDetail({ record }: { record: IssueRecord }) {
  return (
    <>
      <p className="review-detail-time" data-testid="detail-time">{recordTime(record, true)}</p>
      <h3 className="review-detail-label">What went wrong</h3>
      <p className="review-detail-text" data-testid="detail-what">{record.what}</p>
      <h3 className="review-detail-label">What you expected</h3>
      <p className="review-detail-text" data-testid="detail-expect">{record.expect}</p>
      <h3 className="review-detail-label">Screenshot</h3>
      {record.shot ? <Shot shot={record.shot} /> : (
        <p className="form-message error" data-testid="detail-shot-error">
          Couldn’t capture a screenshot: {record.shotError}</p>
      )}
      <MoreSection testId="detail-view" summary="Current view" text={record.view} />
      <MoreSection testId="detail-actions" summary="Recent activity" text={record.actions} />
      <MoreSection testId="detail-versions" summary="Versions" text={record.versions} />
      <RecordActions section="issues" name={record.name} reveal />
    </>
  );
}

/** @brief 读不出来的记录：文件名和原文、"Show in Explorer"（两类都有，好去改或删掉它）。 */
function BrokenDetail({ section, item }: { section: ReviewKind; item: BrokenRecord }) {
  return (
    <>
      <div className="review-detail-broken" data-testid="detail-broken">
        <p className="review-detail-text">Couldn’t read the record {item.name}</p>
        <pre>{item.error}</pre>
      </div>
      <RecordActions section={section} name={item.name} reveal />
    </>
  );
}

/** @brief 详情的内容。 */
function DetailContent({ section, item }: { section: ReviewKind; item: ReviewItem }) {
  if (item.status === 'broken') return <BrokenDetail section={section} item={item} />;
  return 'feedback' in item ? <FeedbackDetail record={item} /> : <IssueDetail record={item} />;
}

/** @brief 关闭详情，焦点回到列表里的那一行；那一行没有列出（"Hide resolved"开着时标了已处理）时回到这一节的按钮。 */
function closeDetail(section: ReviewKind, name: string): void {
  selectRecord(section, null);
  const row = document.querySelector<HTMLElement>(`[data-testid="review-row"][data-name="${CSS.escape(name)}"]`);
  (row ?? document.querySelector<HTMLElement>(`[data-testid="review-tab-${section}"]`))?.focus();
}

/**
 * @brief 工作回顾的右栏：当前分节选中的记录还在时显示（App.tsx 只在工作回顾页挂它）。
 * @param children 右栏的分隔线（宽度与会话的右栏共用）
 */
export function ReviewDetail({ children }: { children: React.ReactNode }) {
  const section = useReview((state) => state.section);
  const item = useReview(selectedRecord);
  if (!item) return null;
  return (
    <aside className="right-panel" data-testid="review-detail" aria-label="Review details">
      {children}
      <div className="panel-header">
        <Icon name={section === 'feedback' ? 'feedback' : 'flag'} />{KIND_LABEL[section]}
        <button type="button" className="icon-button" aria-label="Close details" title="Close details"
          onClick={() => closeDetail(section, item.name)}><Icon name="close" /></button>
      </div>
      <div className="panel-body review-detail-body" key={`${section}/${item.name}`}>
        <DetailContent section={section} item={item} />
      </div>
    </aside>
  );
}
