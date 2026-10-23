// 设置页 UI issues 的详情（右栏，docs/specs/memory.md §10.8，沿用 docs/v0/screens/review.md "详情"）：
// 选中的界面问题报告或读不出来的报告。报告：时间、两段原文、截图（点开浮层按原尺寸看）、可以展开的
// Current view / Recent activity / Versions、Show in Explorer；读不出来的报告：文件名、原文、Show in Explorer；
// 都可以 Resolve 或 Reopen。右栏的宽度与会话的右栏共用（App.tsx 传进分隔线）。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrokenRecord, IssueItem, IssueRecord } from '../../../shared/issueRecords';
import { recordAction } from '../state/actionLog';
import { mainError } from '../state/bridge';
import { useOverlay } from '../state/overlays';
import { isHandled, recordTime, selectedIssue, selectIssue, setHandled, useUiIssues } from '../state/uiIssues';
import { Icon } from '../icons';

/** @brief "Resolve" / "Reopen"。 */
function HandledButton({ name }: { name: string }) {
  const handled = useUiIssues((state) => isHandled(state, name));
  return (
    <button type="button" className="button" data-testid="detail-handled" onClick={() => setHandled(name, !handled)}>
      <Icon name="check" />{handled ? 'Reopen' : 'Resolve'}</button>
  );
}

/** @brief 详情底部的按钮："Show in Explorer"（资源管理器里选中这个文件）和标已处理。 */
function RecordActions({ name }: { name: string }) {
  const [error, setError] = useState<string | null>(null);
  async function showFile() {
    recordAction('Show record in Explorer');
    setError(null);
    try {
      await window.mori.showIssueRecord(name);
    } catch (failure) {
      setError(mainError('showIssueRecord', failure));
    }
  }
  return (
    <>
      {error && <p className="form-message error" role="alert">{error}</p>}
      <div className="issues-detail-actions">
        <button type="button" className="button" data-testid="detail-show-file" onClick={() => void showFile()}>
          <Icon name="folder" />Show in Explorer</button>
        <HandledButton name={name} />
      </div>
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
    window.mori.issueShot(shot).then(
      (url) => live && setState({ url, error: null }),
      (failure) => live && setState({ url: null, error: mainError('issueShot', failure) }),
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
    return <p className="issues-detail-loading" role="status" data-testid="detail-shot-loading">Loading screenshot…</p>;
  }
  return (
    <>
      <button ref={button} type="button" className="issues-shot" aria-label="View full screenshot"
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
    <details className="issues-detail-more" data-testid={testId}>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  );
}

/** @brief 界面问题报告的详情。 */
function IssueDetail({ record }: { record: IssueRecord }) {
  return (
    <>
      <p className="issues-detail-time" data-testid="detail-time">{recordTime(record, true)}</p>
      <h3 className="issues-detail-label">What went wrong</h3>
      <p className="issues-detail-text" data-testid="detail-what">{record.what}</p>
      <h3 className="issues-detail-label">What you expected</h3>
      <p className="issues-detail-text" data-testid="detail-expect">{record.expect}</p>
      <h3 className="issues-detail-label">Screenshot</h3>
      {record.shot ? <Shot shot={record.shot} /> : (
        <p className="form-message error" data-testid="detail-shot-error">
          Couldn’t capture a screenshot: {record.shotError}</p>
      )}
      <MoreSection testId="detail-view" summary="Current view" text={record.view} />
      <MoreSection testId="detail-actions" summary="Recent activity" text={record.actions} />
      <MoreSection testId="detail-versions" summary="Versions" text={record.versions} />
      <RecordActions name={record.name} />
    </>
  );
}

/** @brief 读不出来的报告：文件名和原文、"Show in Explorer"（好去改或删掉它）。 */
function BrokenDetail({ item }: { item: BrokenRecord }) {
  return (
    <>
      <div className="issues-detail-broken" data-testid="detail-broken">
        <p className="issues-detail-text">Couldn’t read the record {item.name}</p>
        <pre>{item.error}</pre>
      </div>
      <RecordActions name={item.name} />
    </>
  );
}

/** @brief 详情的内容。 */
function DetailContent({ item }: { item: IssueItem }) {
  return item.status === 'broken' ? <BrokenDetail item={item} /> : <IssueDetail record={item} />;
}

/**
 * @brief 关闭详情，焦点回到列表里的那一行；那一行没有列出（"Hide resolved"开着时标了已处理）时回到设置页左边的
 *        "UI issues"按钮。
 */
function closeDetail(name: string): void {
  selectIssue(null);
  const row = document.querySelector<HTMLElement>(`[data-testid="issues-row"][data-name="${CSS.escape(name)}"]`);
  (row ?? document.querySelector<HTMLElement>('[data-testid="settings-nav"] [data-section="issues"]'))?.focus();
}

/**
 * @brief UI issues 的右栏：选中的报告还在时显示（App.tsx 只在设置页的 UI issues 这一节挂它，见 useIssuesDetailOpen）。
 * @param children 右栏的分隔线（宽度与会话的右栏共用）
 */
export function UiIssuesDetail({ children }: { children: React.ReactNode }) {
  const item = useUiIssues(selectedIssue);
  if (!item) return null;
  return (
    <aside className="right-panel" data-testid="issues-detail" aria-label="UI issue details">
      {children}
      <div className="panel-header">
        <Icon name="flag" />UI issues
        <button type="button" className="icon-button" aria-label="Close details" title="Close details"
          onClick={() => closeDetail(item.name)}><Icon name="close" /></button>
      </div>
      <div className="panel-body issues-detail-body" key={item.name}>
        <DetailContent item={item} />
      </div>
    </aside>
  );
}
