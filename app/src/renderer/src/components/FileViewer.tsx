// 文件阅读器（docs/v0/screens/changes.md "文件阅读器"）：只读，行号加语法高亮，用鼠标选字引用或反馈。
// 文件由主进程读（不监视文件）；当前分支上新的一段改动记录（mori.turn_changes 的 changes，不管是 edit、write、命令还是
// 后台 Agent 改的）列出这个文件时自动重新读一次（docs/specs/file-system.md §5.1），其余点"Reload file"。
// 照 Claude 桌面版：顶部有"Open in default app"；"← Changes"回到改动列表，× 关闭右栏。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { code } from '@streamdown/code';
import type { FileRead } from '../../../shared/files';
import { describe } from '../state/bridge';
import {
  locateFileQuote, refKey, setQuoteStatus, showChanges, splitLines, type QuoteStatus,
} from '../state/quotes';
import type { QuoteJump, RightView, Tab } from '../state/store';
import { Icon } from '../icons';
import { displayPath } from './toolTitle';

type FileView = Extract<RightView, { kind: 'file' }>;

/** 超过这个大小的文件不做语法高亮（临时默认值，见 docs/v0/defaults.md） */
const HIGHLIGHT_MAX = 200 * 1024;

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
  tab: Tab; read: Extract<FileRead, { status: 'ok' }>; target: Target | null;
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

/** @brief 阅读器顶部："← Changes"、路径、"Reload file"、"Open in default app"、关闭。 */
function ViewerHeader({ tab, path, missing, onReload, onClose }: {
  tab: Tab; path: string; missing: boolean; onReload: () => void; onClose: () => void;
}) {
  const [opened, setOpened] = useState<{ error: string | null; revealed: boolean } | null>(null);
  useEffect(() => setOpened(null), [path]);
  async function openExternal() {
    try {
      setOpened(await window.mori.openPath(path, tab.cwd));
    } catch (failure) {
      setOpened({ error: describe('openPath', failure), revealed: false });
    }
  }
  return (
    <>
      <div className="panel-header file-header">
        <button className="text-link back-link" onClick={() => showChanges(tab.key)}>
          <Icon name="back" />Changes</button>
        <span className="file-path" title={path} data-testid="file-path">{displayPath(path, tab.cwd)}</span>
        <button className="icon-button" onClick={onReload} aria-label="Reload file" title="Reload file">
          <Icon name="refresh" /></button>
        <button className="icon-button" onClick={() => void openExternal()} disabled={missing}
          aria-label="Open in default app" title="Open in default app"><Icon name="external" /></button>
        <button className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
      </div>
      {opened?.error && (
        <p className="form-message error panel-error" role="alert">
          Couldn’t open this file with the default app: {opened.error}</p>
      )}
      {opened?.revealed && (
        <p className="panel-note panel-error" role="status" data-testid="open-revealed">
          Opening this kind of file would run it, so it’s selected in File Explorer instead. Open it in an editor.</p>
      )}
    </>
  );
}

/**
 * @brief 文件阅读器。
 * @param version 当前分支上列出这个文件的 changes 记录条数（state/workspace.ts 的 fileChangeCount）：变了就重新读
 */
export function FileViewer({ tab, view, version, onClose }: {
  tab: Tab; view: FileView; version: number; onClose: () => void;
}) {
  const [reloads, setReloads] = useState(0);
  const read = useFileRead(view.path, tab.cwd, `${view.nonce}:${version}:${reloads}`);
  const target = useTarget(read, view.jump);
  return (
    <>
      <ViewerHeader tab={tab} path={read?.path ?? view.path} missing={read?.status === 'missing'}
        onReload={() => setReloads((count) => count + 1)} onClose={onClose} />
      <div className="panel-body file-body" data-testid="file-viewer">
        {read?.status === 'ok' ? <FileText tab={tab} read={read} target={target} /> : <FileState read={read} />}
      </div>
    </>
  );
}
