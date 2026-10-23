// 设置页的"UI issues"一节（docs/specs/memory.md §10.8，沿用 M7 工作回顾的界面问题部分，docs/v0/screens/review.md
// "页面"）：标题带未处理的条数；工具行（Hide resolved、Export as Markdown…、Open folder）和它下面的结果；
// 读取中 / 读取失败 / 空 / 都已隐藏；每份报告一行摘要的列表，↑ ↓ 在行之间移动焦点，Enter 或点击在右栏打开详情
// （UiIssuesDetail）。报告只读不改。重新读取时上一次的列表留着（滚动位置不丢），标题旁显示"Loading…"，
// 读完之前不能导出。

import { useLayoutEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { IssueItem, IssueRecord } from '../../../shared/issueRecords';
import {
  exportListed, isHandled, issueTitle, loadIssues, openReportsFolder, recordTime, selectIssue, setHideHandled,
  showExported, unhandledCount, useUiIssues, visibleIssues,
} from '../state/uiIssues';
import { Icon } from '../icons';
import { moveMenuFocus } from './menu';

/**
 * 列表的滚动位置（设置页内容区 .settings-body 的 scrollTop）：只在这次运行的内存里，换到别的分节或离开设置页
 * 再回来时恢复
 */
let scrollTop = 0;

/** @brief 标题"UI issues"，带未处理的条数（为 0 时不显示数字）；重新读取时旁边显示"Loading…"。 */
function Heading() {
  const count = useUiIssues(unhandledCount);
  const rereading = useUiIssues((state) => state.loading && state.records !== null);
  return (
    <div className="issues-head">
      <h2 aria-label={`UI issues, ${count} unresolved`}>
        UI issues
        {count > 0 && <span className="issues-count" data-testid="issues-count">{count}</span>}
      </h2>
      {rereading && <span className="issues-reading" role="status" data-testid="issues-loading">Loading…</span>}
    </div>
  );
}

/**
 * @brief 工具行："Hide resolved"开关、"Export as Markdown…"（没有列出的报告、或正在读取时不可用）、
 *        "Open folder"。
 */
function Toolbar({ listed }: { listed: number }) {
  const hideHandled = useUiIssues((state) => state.hideHandled);
  const loading = useUiIssues((state) => state.loading);
  return (
    <div className="issues-toolbar">
      <button type="button" className="issues-switch" role="switch" aria-checked={hideHandled}
        data-testid="issues-hide-handled" onClick={() => setHideHandled(!hideHandled)}>
        <span className="tools-switch" aria-hidden="true"><span className="tools-switch-knob" /></span>Hide resolved
      </button>
      <button type="button" className="button" data-testid="issues-export" disabled={listed === 0 || loading}
        onClick={() => void exportListed()}>Export as Markdown…</button>
      <button type="button" className="button" data-testid="issues-open-folder"
        onClick={() => void openReportsFolder()}><Icon name="folder" />Open folder</button>
    </div>
  );
}

/** @brief 工具行下面的一行：已导出（路径和"Show in Explorer"），或导出、打开文件夹失败的原文。 */
function Notice() {
  const notice = useUiIssues((state) => state.notice);
  if (!notice) return null;
  if (notice.kind === 'error') {
    return <p className="issues-notice form-message error" role="alert" data-testid="issues-notice">{notice.text}</p>;
  }
  return (
    <p className="issues-notice form-message ok" role="status" data-testid="issues-notice">
      Exported {notice.count} {notice.count === 1 ? 'record' : 'records'} to {notice.file}
      <button type="button" className="text-link" onClick={() => void showExported(notice.file)}>
        Show in Explorer</button>
    </p>
  );
}

/** @brief 已处理的标签"Resolved"。 */
function HandledTag({ handled }: { handled: boolean }) {
  return handled ? <span className="issues-tag done" data-testid="issues-row-handled">Resolved</span> : null;
}

/** @brief 一份报告的一行摘要："What went wrong"（没有填写时用"What you expected"）、时间、没有截图时标"No screenshot"。 */
function IssueSummary({ record, handled }: { record: IssueRecord; handled: boolean }) {
  return (
    <>
      <span className="issues-row-title">{issueTitle(record)}</span>
      <span className="issues-row-meta">
        <span className="issues-row-time">{recordTime(record, false)}</span>
        {!record.shot && <span className="issues-tag">No screenshot</span>}
        <HandledTag handled={handled} />
      </span>
    </>
  );
}

/** @brief 一行摘要：报告，或读不出来的报告（文件名和原文）。 */
function Summary({ item, handled }: { item: IssueItem; handled: boolean }) {
  if (item.status === 'ok') return <IssueSummary record={item} handled={handled} />;
  return (
    <>
      <span className="issues-row-title broken">Couldn’t read the record {item.name}</span>
      <span className="issues-row-error">{item.error}</span>
      {handled && <span className="issues-row-meta"><HandledTag handled /></span>}
    </>
  );
}

/** @brief 列表里的一行；已处理的变淡并标"Resolved"，选中的高亮。 */
function Row({ item }: { item: IssueItem }) {
  const selected = useUiIssues((state) => state.selected === item.name);
  const handled = useUiIssues((state) => isHandled(state, item.name));
  return (
    <button type="button" className={`issues-row${handled ? ' handled' : ''}`} data-testid="issues-row"
      data-name={item.name} data-handled={String(handled)} aria-pressed={selected}
      onClick={() => selectIssue(item.name)}>
      <Summary item={item} handled={handled} />
    </button>
  );
}

/**
 * @brief 进入这一节时恢复上次的滚动位置（设置页的内容区滚动）；从"View in Settings"过来时，把刚记下的那一行滚到
 *        看得见的地方（只滚一次，平常进入、重新读取时不动你的滚动位置）。
 * @param count 列出的条数（刚记下的那一行要等读完才在列表里）
 */
function useListScroll(element: React.RefObject<HTMLDivElement | null>, count: number): void {
  const reveal = useUiIssues((state) => state.reveal);
  useLayoutEffect(() => {
    const body = element.current?.closest<HTMLElement>('.settings-body');
    if (!body) return;
    body.scrollTop = scrollTop;
    const onScroll = () => {
      scrollTop = body.scrollTop;
    };
    body.addEventListener('scroll', onScroll);
    return () => body.removeEventListener('scroll', onScroll);
  }, [element]);
  useLayoutEffect(() => {
    if (!reveal || !element.current) return;
    const row = element.current.querySelector(`[data-testid="issues-row"][data-name="${CSS.escape(reveal)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    useUiIssues.setState({ reveal: null });
  }, [reveal, count, element]);
}

/** @brief "Hide resolved"开着、报告都已处理。 */
function AllHidden({ count }: { count: number }) {
  return (
    <div className="issues-hidden">
      <p className="issues-state" data-testid="issues-all-hidden">
        No unresolved records · {count} resolved {count === 1 ? 'record' : 'records'} hidden</p>
      <button type="button" className="text-link" onClick={() => setHideHandled(false)}>Show resolved</button>
    </div>
  );
}

/** @brief 列表区：读取失败、读取中、空、都已隐藏、列表。 */
function IssuesContent({ listed }: { listed: IssueItem[] }) {
  const loaded = useUiIssues((state) => state.records !== null);
  const error = useUiIssues((state) => state.error);
  const total = useUiIssues((state) => state.records?.length ?? 0);
  const element = useRef<HTMLDivElement>(null);
  useListScroll(element, listed.length);
  return (
    <div ref={element} className="issues-content">
      {error && (
        <p className="form-message error" role="alert" data-testid="issues-error">{error}
          <button type="button" className="text-link" onClick={() => void loadIssues()}>Retry</button></p>
      )}
      {!loaded && !error && <p className="issues-state" role="status" data-testid="issues-loading">Loading…</p>}
      {loaded && total === 0 && (
        <p className="issues-state" data-testid="issues-empty">No UI issues yet. Press F8 to report one.</p>
      )}
      {loaded && total > 0 && listed.length === 0 && <AllHidden count={total} />}
      {listed.length > 0 && (
        <ul className="issues-list" data-testid="issues-list" aria-label="UI issues" onKeyDown={moveMenuFocus}>
          {listed.map((item) => <li key={item.name}><Row item={item} /></li>)}
        </ul>
      )}
    </div>
  );
}

/** @brief 设置页的"UI issues"一节（设置页的内容区，右栏的详情由 App.tsx 挂 UiIssuesDetail）。 */
export function UiIssuesPage() {
  const listed = useUiIssues(useShallow(visibleIssues));
  return (
    <div className="settings-section issues-section" data-section="issues" data-testid="issues-page">
      <Heading />
      <Toolbar listed={listed.length} />
      <Notice />
      <IssuesContent listed={listed} />
    </div>
  );
}
