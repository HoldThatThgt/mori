// 会话引用的预览对话框（docs/v0/screens/session-refs.md "预览与调整范围"）。照 Claude 桌面版：点输入框里的附加内容卡片，
// 打开一个对话框看全文。输入框里的芯片：后台进程再读一次原会话，按轮列出内容，两个下拉框调整范围，"Done"更新芯片；
// 发出的引用在原会话已删除或原文已变化时：只显示引用时存下的原文。内容就是发给模型的文字，不渲染 Markdown。

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QuoteRef, SessionContent } from '../../../shared/protocol';
import { describe, request } from '../state/bridge';
import { useOverlay } from '../state/overlays';
import { replaceDraftRef, sourceName, useRefPreview, type PreviewRequest } from '../state/refActions';
import {
  approxChars, charCount, defaultRange, locateRange, rangeText, sessionRef, sessionTurns, type RefTurn,
} from '../state/sessionRefs';
import { useApp } from '../state/store';

/** @brief 读到的原会话：轮次、引用的范围和说明。 */
interface Loaded {
  /** 读出的会话 */
  content: SessionContent;
  /** 已完成的轮次 */
  turns: RefTurn[];
  /** 打开时的范围（找不到原来的范围时是默认范围） */
  range: { from: number; to: number };
  /** 原会话的内容变了、范围已按现在的内容重新选 */
  moved: boolean;
}

/** @brief 对话框的状态：读取中、读到了、原会话已删除、读取失败、只看原文。 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; loaded: Loaded }
  | { kind: 'stored'; note: string };

/** 原会话不在了时 session.read 报的原文开头（kernel/sessions.ts readSession） */
const NOT_FOUND = 'Session file not found';

/** @brief 只看原文时顶部的说明。 */
function storedNote(reason: PreviewRequest['reason']): string {
  return reason === 'changed' ? 'Source changed · Showing the attached text'
    : 'Session deleted · Showing the attached text';
}

/** @brief 输入框里的芯片：读原会话、分轮、找回范围；只看原文的直接显示存下的内容。 */
function usePreviewData(request: PreviewRequest): Phase {
  const [phase, setPhase] = useState<Phase>(() => (request.mode === 'view'
    ? { kind: 'stored', note: storedNote(request.reason) } : { kind: 'loading' }));
  useEffect(() => {
    const source = request.ref.source;
    if (request.mode === 'view' || source.kind !== 'session') return;
    let live = true;
    readSource(source.sessionFile).then((content) => {
      const turns = sessionTurns(content.entries, content.cwd);
      const found = locateRange(turns, source);
      if (!live) return;
      if (turns.length === 0) {
        setPhase({ kind: 'stored', note: 'The session no longer has finished turns · Showing the attached text' });
      } else {
        setPhase({ kind: 'ready', loaded: { content, turns, range: found ?? defaultRange(turns), moved: !found } });
      }
    }, (error: unknown) => {
      const message = describe('session.read', error);
      if (live) setPhase({ kind: 'stored', note: message.includes(NOT_FOUND) ? storedNote('gone')
        : `Couldn’t read the session: ${message} · Showing the attached text` });
    });
    return () => { live = false; };
  }, [request]);
  return phase;
}

/** @brief 读原会话（session.read）。 */
function readSource(sessionFile: string): Promise<SessionContent> {
  return request<SessionContent>({ type: 'session.read', sessionFile });
}

/** @brief 一个选轮次的下拉框（选项是"Turn N"）。 */
function TurnSelect({ label, value, count, onChange }: {
  label: string; value: number; count: number; onChange: (value: number) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {Array.from({ length: count }, (_, index) => index + 1).map((number) => (
        <option key={number} value={number}>Turn {number}</option>
      ))}
    </select>
  );
}

/** @brief 按轮列出内容；范围外的变淡。打开时滚到范围的第一轮。 */
function TurnList({ turns, from, to }: { turns: RefTurn[]; from: number; to: number }) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // 只在打开时滚一次，之后改范围不跳动。
    list.current?.querySelector(`[data-turn="${from}"]`)?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <div className="ref-turns" ref={list}>
      {turns.map((turn) => {
        const included = turn.number >= from && turn.number <= to;
        return (
          <section key={turn.entryId} className={`ref-turn${included ? '' : ' excluded'}`} data-testid="ref-turn"
            data-turn={turn.number} data-included={included}>
            <h3>Turn {turn.number} · {approxChars(charCount(turn.text))}{!included && <span> · Not attached</span>}</h3>
            <pre>{turn.text}</pre>
          </section>
        );
      })}
    </div>
  );
}

/** @brief 读到原会话之后：范围、总字数、按轮列出，"Done"按新范围更新芯片。 */
function RangeEditor({ request: open, loaded, onClose }: { request: PreviewRequest; loaded: Loaded;
  onClose: () => void }) {
  const [range, setRange] = useState(loaded.range);
  const name = useApp((state) => (open.ref.source.kind === 'session' ? sourceName(state, open.ref.source) : ''));
  const count = loaded.turns.length;
  const total = charCount(rangeText(loaded.turns, range.from, range.to));
  const confirm = () => {
    replaceDraftRef(open.tabKey, open.ref, sessionRef(loaded.content, loaded.turns, range, name));
    onClose();
  };
  return (
    <>
      {loaded.content.unfinished && <p className="ref-note">{count === 1
        ? 'This session is still running. Only 1 finished turn is listed.'
        : `This session is still running. Only the ${count} finished turns are listed.`}</p>}
      {loaded.moved && (
        <p className="ref-note">The session changed since you attached it, so the range was reset to the default.</p>
      )}
      <div className="ref-range">
        <span>From</span>
        <TurnSelect label="From turn" value={range.from} count={count}
          onChange={(from) => setRange({ from, to: Math.max(from, range.to) })} />
        <span>to</span>
        <TurnSelect label="To turn" value={range.to} count={count}
          onChange={(to) => setRange({ from: Math.min(range.from, to), to })} />
        <span className="ref-total" data-testid="ref-total">{approxChars(total)}</span>
      </div>
      <TurnList turns={loaded.turns} from={range.from} to={range.to} />
      <div className="dialog-actions">
        <button className="button primary" onClick={confirm}>Done</button>
        <button className="button" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}

/** @brief 只看引用时存下的原文。 */
function StoredText({ refValue, note, onClose }: { refValue: QuoteRef; note: string; onClose: () => void }) {
  return (
    <>
      <p className="ref-note" role="status">{note}</p>
      <div className="ref-turns"><pre className="ref-stored">{refValue.quote}</pre></div>
      <div className="dialog-actions"><button className="button" onClick={onClose}>Close</button></div>
    </>
  );
}

/** @brief 对话框里 Tab 只在可聚焦的控件之间循环。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('select, button:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

/** @brief 一次打开的对话框。 */
function PreviewDialog({ open }: { open: PreviewRequest }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const phase = usePreviewData(open);
  const name = useApp((state) => (open.ref.source.kind === 'session' ? sourceName(state, open.ref.source) : ''));
  const close = () => {
    useRefPreview.setState({ request: null });
    requestAnimationFrame(() => open.returnFocus?.focus());
  };
  useOverlay(true, close);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('select, .dialog-actions button')?.focus();
  }, [phase.kind]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div ref={box} className="dialog ref-preview" role="dialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="ref-preview" onKeyDown={trapTab}>
        <h2 id={titleId}>Context · {name}</h2>
        {phase.kind === 'loading' && <p className="ref-note" role="status">Loading…</p>}
        {phase.kind === 'ready' && <RangeEditor request={open} loaded={phase.loaded} onClose={close} />}
        {phase.kind === 'stored' && <StoredText refValue={open.ref} note={phase.note} onClose={close} />}
        {phase.kind === 'loading' && (
          <div className="dialog-actions"><button className="button" onClick={close}>Cancel</button></div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** @brief 当前开着的预览对话框（每次打开换一个，范围不带到下一次）。 */
export function RefPreview() {
  const open = useRefPreview((state) => state.request);
  return open ? <PreviewDialog key={JSON.stringify([open.ref.source, open.mode])} open={open} /> : null;
}
