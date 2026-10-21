// 工作回顾的中栏（方案 5.14，状态表见 docs/v0/screens/review.md "页面"）：顶部"Back to app"和标题；两个分节（各带
// 未处理的条数）；工具行（Hide resolved、Export as Markdown…、Open folder）和它下面的结果；读取中 / 读取失败 / 空 /
// 都已隐藏；每条记录一行摘要的列表，↑ ↓ 在行之间移动焦点，Enter 或点击在右栏打开详情（ReviewDetail）。记录只读不改。
// 重新读取时上一次的列表留着（滚动位置不丢），顶部标题旁显示"Loading…"，读完之前不能导出。

import { useLayoutEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  KIND_LABEL, REVIEW_KINDS, type FeedbackRecord, type IssueRecord, type ReviewKind,
} from '../../../shared/review';
import { showChat } from '../state/projects';
import { excerpt } from '../state/quoteText';
import {
  chooseSection, exportKind, feedbackSessionName, isHandled, loadReview, openKindFolder, recordsOf, selectRecord,
  setHideHandled, showExported, unhandledCount, useReview, visibleRecords, type ReviewItem,
} from '../state/review';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { moveMenuFocus } from './menu';
import { feedbackScope, issueTitle, recordTime } from './reviewText';

/** 这一节没有记录时的说明 */
const EMPTY_TEXT: Record<ReviewKind, string> = {
  feedback: 'No feedback yet. Select text in a response or the file viewer and click “Feedback”, '
    + 'or use “Give feedback” under a response.',
  issues: 'No UI issues yet. Press F8 to report one.',
};

/** 各分节列表的滚动位置：只在这次运行的内存里，离开工作回顾再回来时恢复 */
const scrollTops: Record<ReviewKind, number> = { feedback: 0, issues: 0 };

/** @brief 两个分节的切换按钮，各带未处理的条数（为 0 时不显示数字）；当前分节按下。 */
function SectionSwitch({ section }: { section: ReviewKind }) {
  const counts = useReview(useShallow((state) => REVIEW_KINDS.map((kind) => unhandledCount(state, kind))));
  return (
    <div className="review-tabs" role="group" aria-label="Sections">
      {REVIEW_KINDS.map((kind, index) => (
        <button key={kind} type="button" data-testid={`review-tab-${kind}`} aria-pressed={kind === section}
          aria-label={`${KIND_LABEL[kind]}, ${counts[index]} unresolved`}
          onClick={() => kind !== section && chooseSection(kind)}>
          {KIND_LABEL[kind]}
          {counts[index] > 0 && <span className="review-count" data-testid="review-count">{counts[index]}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * @brief 工具行："Hide resolved"开关（两个分节共用）、"Export as Markdown…"（这一节没有列出的记录、或正在读取时
 *        不可用）、"Open folder"。
 */
function Toolbar({ section, listed }: { section: ReviewKind; listed: number }) {
  const hideHandled = useReview((state) => state.hideHandled);
  const loading = useReview((state) => state.loading);
  return (
    <div className="review-toolbar">
      <button type="button" className="review-switch" role="switch" aria-checked={hideHandled}
        data-testid="review-hide-handled" onClick={() => setHideHandled(!hideHandled)}>
        <span className="tools-switch" aria-hidden="true"><span className="tools-switch-knob" /></span>Hide resolved
      </button>
      <button type="button" className="button" data-testid="review-export" disabled={listed === 0 || loading}
        onClick={() => void exportKind(section)}>Export as Markdown…</button>
      <button type="button" className="button" data-testid="review-open-folder"
        onClick={() => void openKindFolder(section)}><Icon name="folder" />Open folder</button>
    </div>
  );
}

/** @brief 工具行下面的一行：已导出（路径和"Show in Explorer"），或导出、打开文件夹失败的原文。 */
function Notice({ section }: { section: ReviewKind }) {
  const notice = useReview((state) => state.notices[section]);
  if (!notice) return null;
  if (notice.kind === 'error') {
    return <p className="review-notice form-message error" role="alert" data-testid="review-notice">{notice.text}</p>;
  }
  return (
    <p className="review-notice form-message ok" role="status" data-testid="review-notice">
      Exported {notice.count} {notice.count === 1 ? 'record' : 'records'} to {notice.file}
      <button type="button" className="text-link" onClick={() => void showExported(section, notice.file)}>
        Show in Explorer</button>
    </p>
  );
}

/** @brief 已处理的标签"Resolved"。 */
function HandledTag({ handled }: { handled: boolean }) {
  return handled ? <span className="review-tag done" data-testid="review-row-handled">Resolved</span> : null;
}

/** @brief 反馈的一行摘要：你的期望、原文的第一行、来源和时间。会话名用侧栏现在的名字。 */
function FeedbackSummary({ record, handled }: { record: FeedbackRecord; handled: boolean }) {
  const name = useApp((state) => feedbackSessionName(state, record));
  const { feedback } = record;
  const source = feedback.source.kind === 'message' ? `${name} · ${feedbackScope(feedback)}` : feedbackScope(feedback);
  return (
    <>
      <span className="review-row-title">{feedback.expected}</span>
      <span className="review-row-quote">{excerpt(feedback.quote, 200)}</span>
      <span className="review-row-meta">
        <span className="review-row-source" title={source}>{source}</span>
        <span className="review-row-time">{recordTime(record, false)}</span>
        <HandledTag handled={handled} />
      </span>
    </>
  );
}

/** @brief 界面问题的一行摘要："What went wrong"（没有填写时用"What you expected"）、时间、没有截图时标"No screenshot"。 */
function IssueSummary({ record, handled }: { record: IssueRecord; handled: boolean }) {
  return (
    <>
      <span className="review-row-title">{issueTitle(record)}</span>
      <span className="review-row-meta">
        <span className="review-row-time">{recordTime(record, false)}</span>
        {!record.shot && <span className="review-tag">No screenshot</span>}
        <HandledTag handled={handled} />
      </span>
    </>
  );
}

/** @brief 一行摘要：反馈、界面问题，或读不出来的记录（文件名和原文）。 */
function Summary({ item, handled }: { item: ReviewItem; handled: boolean }) {
  if (item.status === 'ok') {
    return 'feedback' in item ? <FeedbackSummary record={item} handled={handled} />
      : <IssueSummary record={item} handled={handled} />;
  }
  return (
    <>
      <span className="review-row-title broken">Couldn’t read the record {item.name}</span>
      <span className="review-row-error">{item.error}</span>
      {handled && <span className="review-row-meta"><HandledTag handled /></span>}
    </>
  );
}

/** @brief 列表里的一行；已处理的变淡并标"Resolved"，选中的高亮。 */
function Row({ section, item }: { section: ReviewKind; item: ReviewItem }) {
  const selected = useReview((state) => state.selected[section] === item.name);
  const handled = useReview((state) => isHandled(state, section, item.name));
  return (
    <button type="button" className={`review-row${handled ? ' handled' : ''}`} data-testid="review-row"
      data-name={item.name} data-handled={String(handled)} aria-pressed={selected}
      onClick={() => selectRecord(section, item.name)}>
      <Summary item={item} handled={handled} />
    </button>
  );
}

/**
 * @brief 进入一节时恢复这一节的滚动位置；从"View in Review"过来时，把刚记下的那一行滚到看得见的地方（只滚一次，
 *        平常进入一节、重新读取时不动你的滚动位置）。
 * @param count 列出的条数（刚记下的那一行要等读完才在列表里）
 */
function useListScroll(section: ReviewKind, element: React.RefObject<HTMLDivElement | null>, count: number): void {
  const reveal = useReview((state) => state.reveal);
  useLayoutEffect(() => {
    if (element.current) element.current.scrollTop = scrollTops[section];
  }, [section, element]);
  useLayoutEffect(() => {
    if (!reveal || !element.current) return;
    const row = element.current.querySelector(`[data-testid="review-row"][data-name="${CSS.escape(reveal)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    useReview.setState({ reveal: null });
  }, [reveal, count, element]);
}

/** @brief "Hide resolved"开着、这一节的记录都已处理。 */
function AllHidden({ count }: { count: number }) {
  return (
    <div className="review-hidden">
      <p className="review-state" data-testid="review-all-hidden">
        No unresolved records · {count} resolved {count === 1 ? 'record' : 'records'} hidden</p>
      <button type="button" className="text-link" onClick={() => setHideHandled(false)}>Show resolved</button>
    </div>
  );
}

/** @brief 一节的内容：读取失败、读取中、空、都已隐藏、列表。滚动位置分节各自记住。 */
function SectionContent({ section, listed }: { section: ReviewKind; listed: ReviewItem[] }) {
  const loaded = useReview((state) => state.records !== null);
  const error = useReview((state) => state.error);
  const total = useReview((state) => recordsOf(state, section).length);
  const element = useRef<HTMLDivElement>(null);
  useListScroll(section, element, listed.length);
  return (
    <div ref={element} className="review-content" onScroll={(event) => {
      scrollTops[section] = event.currentTarget.scrollTop;
    }}>
      {error && (
        <p className="form-message error" role="alert" data-testid="review-error">{error}
          <button type="button" className="text-link" onClick={() => void loadReview()}>Retry</button></p>
      )}
      {!loaded && !error && <p className="review-state" role="status" data-testid="review-loading">Loading…</p>}
      {loaded && total === 0 && <p className="review-state" data-testid="review-empty">{EMPTY_TEXT[section]}</p>}
      {loaded && total > 0 && listed.length === 0 && <AllHidden count={total} />}
      {listed.length > 0 && (
        <ul className="review-list" data-testid="review-list" aria-label={KIND_LABEL[section]}
          onKeyDown={moveMenuFocus}>
          {listed.map((item) => <li key={item.name}><Row section={section} item={item} /></li>)}
        </ul>
      )}
    </div>
  );
}

/** @brief 工作回顾页（中栏）。重新读取时（已经有列表）标题旁显示"Loading…"。 */
export function ReviewPage() {
  const section = useReview((state) => state.section);
  const listed = useReview(useShallow((state) => visibleRecords(state, section)));
  const rereading = useReview((state) => state.loading && state.records !== null);
  return (
    <section className="review-page" data-testid="review-page">
      <header className="topbar">
        <button type="button" className="button" onClick={() => showChat()}><Icon name="back" />Back to app</button>
        <span className="chat-title">Review</span>
        {rereading && <span className="review-reading" role="status" data-testid="review-loading">Loading…</span>}
      </header>
      <div className="review-controls">
        <SectionSwitch section={section} />
        <Toolbar section={section} listed={listed.length} />
      </div>
      <Notice section={section} />
      <SectionContent key={section} section={section} listed={listed} />
    </section>
  );
}
