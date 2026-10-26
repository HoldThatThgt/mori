// 文件阅读器（docs/v0/screens/changes.md "文件阅读器"）：只读，行号加语法高亮，用鼠标选字引用或反馈。
// 文件由主进程读（不监视文件）；本会话对同一个文件的编辑或写入完成后自动重新读一次，其余点"Reload file"。
// 照 Claude 桌面版：顶部有"Open in default app"；"← Changes"回到改动列表，× 关闭右栏。2026-10-26 走查起又照 Claude 的
// 文件面板：Markdown 文件默认显示渲染后的预览，"View source" / "Preview"切换（M24）；点标题里的路径复制完整路径（M25）；
// "Expand" / "Collapse"（M23）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { code } from '@streamdown/code';
import type { FileRead } from '../../../shared/files';
import { recordAction } from '../state/actionLog';
import { describe } from '../state/bridge';
import {
  locateFileQuote, refKey, setQuoteStatus, showChanges, splitLines, type QuoteStatus,
} from '../state/quotes';
import type { QuoteJump, RightView, Tab } from '../state/store';
import { Icon } from '../icons';
import { Markdown } from './Markdown';
import { PanelExpand } from './PanelExpand';
import { COPIED_MS } from './ReplyActions';
import { previewLines } from './selectionSource';
import { displayPath } from './toolTitle';

type FileView = Extract<RightView, { kind: 'file' }>;
type OkRead = Extract<FileRead, { status: 'ok' }>;
/** @brief 阅读器显示什么：渲染后的 Markdown，或源码（行号加内容）。 */
type ViewMode = 'preview' | 'source';

/** 超过这个大小的文件不做语法高亮，Markdown 也不预览（临时默认值，见 docs/v0/defaults.md） */
const HIGHLIGHT_MAX = 200 * 1024;
/** 能预览的 Markdown 文件（照 Claude 桌面版的文件面板） */
const MARKDOWN = /\.(md|mdx|markdown)$/i;

/** @brief 读文件；路径或 key 变化时重新读。读取中为 null（换了文件就不再显示上一次读到的内容）。 */
function useFileRead(path: string, cwd: string, key: string): FileRead | null {
  const id = `${path}\n${cwd}\n${key}`;
  const [state, setState] = useState<{ id: string; read: FileRead } | null>(null);
  useEffect(() => {
    let live = true;
    window.mori.readFile(path, cwd).then((read) => live && setState({ id, read }), (error: unknown) => {
      if (live) setState({ id, read: { status: 'error', path, message: describe('readFile', error) } });
    });
    return () => {
      live = false;
    };
  }, [id, path, cwd]);
  return state?.id === id ? state.read : null;
}

/** @brief 按扩展名取语法高亮的语言；认不出时为 null（不高亮）。 */
function languageOf(path: string): BundledLanguage | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return extension && code.supportsLanguage(extension as BundledLanguage) ? extension as BundledLanguage : null;
}

/** @brief 语法高亮的结果（按行的词）；不高亮或还没算好时为 null。 */
function useTokens(read: FileRead | null): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    setTokens(null);
    const language = read?.status === 'ok' && read.size <= HIGHLIGHT_MAX ? languageOf(read.path) : null;
    if (read?.status !== 'ok' || !language) return;
    let live = true;
    const options = { code: read.text.replace(/\r\n/g, '\n'), language, themes: code.getThemes() };
    const ready = code.highlight(options, (result) => live && setTokens(result.tokens));
    if (ready) setTokens(ready.tokens);
    return () => {
      live = false;
    };
  }, [read]);
  return tokens;
}

/** @brief 跳到引用的结果：高亮的行，以及原文已变化时引用时的原文。 */
interface Target {
  /** 高亮的行；原文已变化时是原来的行 */
  lines: { start: number; end: number };
  /** 原文已变化时引用时的原文；没变时为 null */
  changed: string | null;
}

/** @brief 一次跳转在读到的内容里的结果：高亮的行（原文已变化时是原来的行）和芯片的检查结果。 */
function locate(read: FileRead, ref: QuoteJump['ref']): { target: Target | null; status: QuoteStatus | null } {
  if (ref.source.kind !== 'file') return { target: null, status: null };
  if (read.status !== 'ok') return { target: null, status: read.status === 'missing' ? 'missing' : null };
  const found = locateFileQuote(read.text, read.sha256, ref.source, ref.quote);
  if (found) return { target: { lines: found, changed: null }, status: null };
  const lines = { start: ref.source.startLine, end: ref.source.endLine };
  return { target: { lines, changed: ref.quote }, status: 'changed' };
}

/**
 * @brief 打开它的引用芯片：这次跳转之后读到的第一份内容里找原文（在渲染时就算出来，不会先画上一次的高亮），
 *        并记下芯片的检查结果；之后重新读取（换了一份内容）时高亮清掉（docs/v0/screens/changes.md "跳到引用"）。
 */
function useTarget(read: FileRead | null, jump: QuoteJump | null): Target | null {
  const first = useRef<{ nonce: number; read: FileRead } | null>(null);
  if (read && jump && first.current?.nonce !== jump.nonce) first.current = { nonce: jump.nonce, read };
  const active = Boolean(read && jump && first.current?.read === read);
  const result = useMemo(() => (active && read && jump ? locate(read, jump.ref) : null), [active, read, jump]);
  useEffect(() => {
    if (result && jump) setQuoteStatus(refKey(jump.ref), result.status);
  }, [result, jump]);
  return result?.target ?? null;
}

/** @brief 一行的内容：有高亮时按词着色，否则原文。 */
function lineContent(line: string, tokens: ThemedToken[] | undefined) {
  if (!tokens) return line;
  return tokens.map((token, index) => (
    <span key={index} style={{ color: token.htmlStyle?.color ?? token.color }}>{token.content}</span>
  ));
}

/** @brief 文本内容：行号（不进选区）加每一行；跳到引用时高亮那几行并滚过去。 */
function FileText({ tab, read, target }: {
  tab: Tab; read: OkRead; target: Target | null;
}) {
  const content = useRef<HTMLDivElement>(null);
  const tokens = useTokens(read);
  const lines = useMemo(() => splitLines(read.text), [read]);
  const rows = useMemo(() => lines.map((line, index) => (
    <div key={index} className="file-line" data-line={index + 1}>{lineContent(line, tokens?.[index])}</div>
  )), [lines, tokens]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    for (const row of element.querySelectorAll('.file-line.target')) row.classList.remove('target');
    if (!target) return;
    for (let line = target.lines.start; line <= target.lines.end; line += 1) {
      element.querySelector(`[data-line="${line}"]`)?.classList.add('target');
    }
    element.querySelector(`[data-line="${target.lines.start}"]`)?.scrollIntoView({ block: 'center' });
  }, [target, rows]);
  return (
    <>
      {target?.changed && (
        <div className="banner file-changed" data-testid="quote-changed">
          <span>Source changed · Attached text:</span>
          <pre className="file-changed-quote">{target.changed}</pre>
        </div>
      )}
      <div className="file-scroll" data-quote-source="file" data-tab={tab.key} data-path={read.path}
        data-sha={read.sha256}>
        <div ref={content} className="file-content" data-testid="file-content">{rows}</div>
      </div>
    </>
  );
}

/** @brief 读不出内容时的说明（docs/v0/screens/changes.md 的各个状态）。 */
function FileState({ read }: { read: FileRead | null }) {
  if (!read) return <p className="muted file-state">Loading…</p>;
  switch (read.status) {
    case 'missing':
      return <div className="file-state" data-testid="file-state"><p>File not found</p>
        <p className="muted file-path-full">{read.path}</p></div>;
    case 'binary':
      return <p className="file-state" data-testid="file-state">Preview unavailable · Binary file</p>;
    case 'large':
      return <p className="file-state" data-testid="file-state">
        Preview unavailable · File is larger than 1 MB ({(read.size / 1024 / 1024).toFixed(1)} MB)</p>;
    case 'directory':
      return <p className="file-state" data-testid="file-state">Preview unavailable · This is a folder</p>;
    case 'error':
      return <p className="file-state form-message error" data-testid="file-state">
        Couldn’t read this file: {read.message}</p>;
    default:
      return null;
  }
}

/** @brief Markdown 预览：与对话流同样渲染；选区按元素的源码行引用（selectionSource.ts previewPick）。 */
function FilePreview({ tab, read }: { tab: Tab; read: OkRead }) {
  const text = useMemo(() => read.text.replace(/\r\n/g, '\n'), [read]);
  const register = useCallback((element: HTMLDivElement | null) => {
    if (element) previewLines.set(element, splitLines(text));
  }, [text]);
  return (
    <div ref={register} className="file-scroll file-preview" data-quote-source="preview" data-tab={tab.key}
      data-path={read.path} data-sha={read.sha256} data-testid="file-preview">
      <Markdown text={text} preview />
    </div>
  );
}

/**
 * @brief 这一次打开用哪一种视图（changes.md"显示 Markdown 预览"）：能预览的 Markdown 默认是预览，从引用芯片或
 *        "Jump to source"打开（view.jump）时是源码；你切换过之后以你为准，重新读取时不变，直到下一次打开（view.nonce 变）。
 *        不能预览（不是 Markdown、超过 HIGHLIGHT_MAX、读不出内容、读取中）时为 null。
 */
function useViewMode(view: FileView, read: FileRead | null): [ViewMode | null, (mode: ViewMode) => void] {
  const [chosen, setChosen] = useState<{ nonce: number; mode: ViewMode } | null>(null);
  const previewable = read?.status === 'ok' && MARKDOWN.test(read.path) && read.size <= HIGHLIGHT_MAX;
  const opened: ViewMode = view.jump ? 'source' : 'preview';
  const mode = !previewable ? null : chosen?.nonce === view.nonce ? chosen.mode : opened;
  return [mode, (next) => setChosen({ nonce: view.nonce, mode: next })];
}

/** @brief 系统编辑器打开的结果：失败的原文，或改为在资源管理器里选中；换文件时清掉。 */
interface Opened {
  /** 失败的原文；没有失败时为 null */
  error: string | null;
  /** 会被运行的文件改为在资源管理器里选中了 */
  revealed: boolean;
}

/** @brief "Open in default app"。 */
function useOpenExternal(path: string, cwd: string) {
  const [opened, setOpened] = useState<Opened | null>(null);
  useEffect(() => setOpened(null), [path]);
  async function open() {
    try {
      setOpened(await window.mori.openPath(path, cwd));
    } catch (failure) {
      setOpened({ error: describe('openPath', failure), revealed: false });
    }
  }
  return { opened, open };
}

/** @brief 复制路径的结果：'copied' 停留 COPIED_MS 后回到 'idle'；'failed' 留到下一次复制或换文件。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** @brief 点标题里的路径：把完整路径写进剪贴板（主进程的 mori:copy-text）。 */
function useCopyPath(path: string) {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => setState('idle'), [path]);
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    recordAction('Copy path');
    try {
      await window.mori.copyText(path);
      setState('copied');
    } catch (error) {
      describe('copyText', error);
      setState('failed');
    }
  }
  return { state, copy };
}

/** @brief 顶部下方的一行：系统编辑器打开失败、改为在资源管理器里选中、复制了路径、复制失败。 */
function HeaderNotes({ opened, copy }: { opened: Opened | null; copy: CopyState }) {
  return (
    <>
      {opened?.error && (
        <p className="form-message error panel-error" role="alert">
          Couldn’t open this file with the default app: {opened.error}</p>
      )}
      {opened?.revealed && (
        <p className="panel-note panel-error" role="status" data-testid="open-revealed">
          Opening this kind of file would run it, so it’s selected in File Explorer instead. Open it in an editor.</p>
      )}
      {copy === 'copied' && (
        <p className="panel-note panel-status" role="status" data-testid="path-copied">Path copied to clipboard.</p>
      )}
      {copy === 'failed' && (
        <p className="form-message error panel-status" role="alert" data-testid="path-copy-failed">Copy failed</p>
      )}
    </>
  );
}

/** @brief "View source"（预览时）/ "Preview"（看源码时），照 Claude 的文件面板。 */
function ModeButton({ mode, onMode }: { mode: ViewMode; onMode: (mode: ViewMode) => void }) {
  const label = mode === 'preview' ? 'View source' : 'Preview';
  const choose = () => {
    recordAction(label);
    onMode(mode === 'preview' ? 'source' : 'preview');
  };
  return (
    <button className="icon-button" onClick={choose} aria-label={label} title={label} data-testid="viewer-mode">
      <Icon name={mode === 'preview' ? 'code' : 'eye'} /></button>
  );
}

/** @brief 阅读器顶部按钮做的事。 */
interface HeaderActions {
  /** "Reload file" */
  reload: () => void;
  /** "Close panel" */
  close: () => void;
  /** 切换预览和源码 */
  setMode: (mode: ViewMode) => void;
}

/**
 * @brief 阅读器顶部："← Changes"、路径（点它复制完整路径，读取中不可用）、Markdown 的"View source" / "Preview"、
 *        "Reload file"、"Open in default app"、"Expand" / "Collapse"、关闭。
 * @param path 主进程解析出的完整路径；读取中、读取失败时是工具参数里的原文
 * @param mode 当前视图；不能预览时为 null（没有切换按钮）
 */
function ViewerHeader({ tab, path, read, mode, actions }: {
  tab: Tab; path: string; read: FileRead | null; mode: ViewMode | null; actions: HeaderActions;
}) {
  const external = useOpenExternal(path, tab.cwd);
  const copy = useCopyPath(path);
  return (
    <>
      <div className="panel-header file-header">
        <button className="text-link back-link" onClick={() => showChanges(tab.key)} aria-label="Changes">
          <Icon name="back" /><span className="back-text">Changes</span></button>
        <button type="button" className="file-path" title={path} aria-label={`Copy path ${path}`}
          disabled={!read} onClick={() => void copy.copy()} data-testid="file-path">
          {displayPath(path, tab.cwd)}</button>
        {mode && <ModeButton mode={mode} onMode={actions.setMode} />}
        <button className="icon-button" onClick={actions.reload} aria-label="Reload file" title="Reload file">
          <Icon name="refresh" /></button>
        <button className="icon-button" onClick={() => void external.open()} disabled={read?.status === 'missing'}
          aria-label="Open in default app" title="Open in default app"><Icon name="external" /></button>
        <PanelExpand tab={tab} />
        <button className="icon-button" onClick={actions.close} aria-label="Close panel"><Icon name="close" /></button>
      </div>
      <HeaderNotes opened={external.opened} copy={copy.state} />
    </>
  );
}

/**
 * @brief 文件阅读器。
 * @param version 本会话对这个文件完成的编辑和写入次数：变了就重新读
 */
export function FileViewer({ tab, view, version, onClose }: {
  tab: Tab; view: FileView; version: number; onClose: () => void;
}) {
  const [reloads, setReloads] = useState(0);
  const read = useFileRead(view.path, tab.cwd, `${view.nonce}:${version}:${reloads}`);
  const target = useTarget(read, view.jump);
  const [mode, setMode] = useViewMode(view, read);
  const actions = { reload: () => setReloads((count) => count + 1), close: onClose, setMode };
  return (
    <>
      <ViewerHeader tab={tab} path={read?.path ?? view.path} read={read} mode={mode} actions={actions} />
      <div className="panel-body file-body" data-testid="file-viewer">
        {read?.status !== 'ok' ? <FileState read={read} />
          : mode === 'preview' ? <FilePreview tab={tab} read={read} />
            : <FileText tab={tab} read={read} target={target} />}
      </div>
    </>
  );
}
