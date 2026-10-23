// 记忆页的右栏（docs/specs/memory.md §10.1、§10.2、§10.5）：选中的条目、修订，或新增条目的表单。
// 条目：标题与来历一行、Evidence（每项 Jump to source）、Details（Markdown，[[slug]] 是到别的条目的链接）、
// Linked from、History，以及 Edit、Delete…（确认框）、Move；保存、删除、移动失败时原因写在顶部（memory-error）。
// 右栏的宽度与会话的右栏共用（App.tsx 传进分隔线）。

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Components } from 'streamdown';
import { useShallow } from 'zustand/react/shallow';
import {
  evidenceLine, KIND_LABEL, LAYER_LABEL, monthDay, monthDayTime, type EntryDetail, type EntryRef, type MemoryGetResult,
  type RevisionRow, type StoredEvidence,
} from '../../../shared/memory';
import {
  closePanel, deleteEntry, evidenceKey, evidenceTitle, fixedJumpStatus, jumpToEvidence, moveEntry, openEntryRef,
  resolveLink, SECTION_LABEL, selectRevision, shownScope, SOURCE_LABEL, startEdit, useMemory, usePlace,
  useUnavailable,
} from '../state/memory';
import { SESSION_DELETED } from '../state/refActions';
import { useApp } from '../state/store';
import { Icon } from '../icons';
import { ConfirmDialog } from './ConfirmDialog';
import { LoadError, MemoryMarkdown, unavailableTitle } from './MemoryCommon';
import { MemoryForm } from './MemoryForm';
import { RevisionDetailView } from './MemoryRevisions';

// ---- 来历一行 ----

/** @brief created / modified（`YYYY-MM-DD · <谁>`）里的"谁"在句子里的写法：you、Mori、enhancement。 */
function byWhom(stamp: string): string {
  const who = stamp.split(' · ')[1]?.trim() ?? '';
  if (who === 'You') return 'you';
  return who === 'Enhancement' ? 'enhancement' : who;
}

/** @brief `<KIND> · <User|Project> · <You said|Learned> · Created <Mon D> by <…> · Modified <Mon D> by <…>`。 */
function metaLine(entry: EntryDetail): string {
  return `${KIND_LABEL[entry.kind]} · ${LAYER_LABEL[entry.layer]} · ${SOURCE_LABEL[entry.source]} · Created `
    + `${monthDay(entry.created)} by ${byWhom(entry.created)} · Modified ${monthDay(entry.modified)} by `
    + byWhom(entry.modified);
}

// ---- Evidence（§10.1、§10.2） ----

/**
 * @brief 一项依据：依据行（会话名用侧栏现在的名字）、Jump to source（检查中 Opening…）与跳转的结果。
 *        会话已删除（点之前就知道，或读会话文件时发现）、实例会话、后台进程退出时不可用。
 */
function EvidenceItem({ entry, evidence, index }: { entry: EntryDetail; evidence: StoredEvidence; index: number }) {
  const key = evidenceKey(entry.layer, entry.id, index);
  const title = useApp((state) => evidenceTitle(state, evidence));
  const fixed = useApp((state) => fixedJumpStatus(state, evidence));
  const jump = useMemory((state) => state.jumps[key]);
  const unavailable = useUnavailable();
  const checking = jump === 'checking';
  const note = jump && jump !== 'checking' ? jump : null;
  const gone = fixed ?? (note?.text === SESSION_DELETED ? SESSION_DELETED : null);
  const status = note?.text ?? fixed;
  const blocked = gone !== null || unavailable !== null;
  const hover = gone ?? unavailableTitle(unavailable);
  return (
    <li className="memory-evidence-item">
      <span className="memory-evidence-line">{evidenceLine(evidence, title)}</span>
      <span className="memory-jump">
        <button type="button" className="text-link" data-testid="memory-jump" disabled={blocked || checking}
          title={blocked ? hover : undefined} onClick={() => jumpToEvidence(key, evidence)}>
          {checking ? 'Opening…' : 'Jump to source'}</button>
        {status && (
          <span className={`memory-jump-status ${note?.tone ?? 'warn'}`} role="status"
            data-testid="memory-jump-status">{status}</span>
        )}
      </span>
    </li>
  );
}

/** @brief Evidence 一块：每项一行；没有时 No evidence recorded.。 */
function Evidence({ entry }: { entry: EntryDetail }) {
  return (
    <section className="memory-block" data-testid="memory-evidence">
      <h3 className="memory-label">Evidence</h3>
      {entry.evidence.length === 0 ? <p className="memory-muted">No evidence recorded.</p> : (
        <ul className="memory-evidence">
          {entry.evidence.map((item, index) => (
            <EvidenceItem key={index} entry={entry} evidence={item} index={index} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Details 与 [[slug]] ----

/** 正文里到别的条目的链接 */
const LINK = /\[\[([^\]\n]+)\]\]/g;
/** 改写后的链接地址前缀（页内地址，渲染时认出它） */
const LINK_PREFIX = '#mori-entry-';

/** @brief 正文里 [[slug]] 指向的条目（打开详情时读，不缓存）；还没读到的不在结果里，找不到的为 null。 */
function useLinks(entry: EntryDetail, cwd: string | null): Record<string, EntryRef | null> {
  const key = useMemo(() => [...new Set([...entry.details.matchAll(LINK)].map((match) => match[1]!.trim()))]
    .join('\n'), [entry.details]);
  const [links, setLinks] = useState<Record<string, EntryRef | null>>({});
  useEffect(() => {
    let live = true;
    setLinks({});
    const slugs = key ? key.split('\n') : [];
    void Promise.all(slugs.map(async (slug) => [slug, await resolveLink(slug, entry.layer, cwd)] as const))
      .then((pairs) => live && setLinks(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [key, entry.layer, cwd]);
  return links;
}

/** @brief Markdown 里链接文字要转义的字符。 */
function escapeText(text: string): string {
  return text.replace(/[\\[\]*_`]/g, '\\$&');
}

/**
 * @brief 链接的渲染：[[slug]] 找到时是按钮（在详情里打开那一条），找不到或还没读到时显示原文、不可点；别的链接照常。
 * @param unavailable 后台进程不可用的原因（useUnavailable）；可用时为 null
 */
function linkComponents(links: Record<string, EntryRef | null>, unavailable: string | null): Components {
  return {
    a: ({ href, children }) => {
      const target = typeof href === 'string' ? href : '';
      if (!target.startsWith(LINK_PREFIX)) return <a href={target}>{children}</a>;
      const slug = decodeURIComponent(target.slice(LINK_PREFIX.length));
      const ref = links[slug];
      if (!ref) return <span className="memory-link-missing">{`[[${slug}]]`}</span>;
      return (
        <button type="button" className="text-link memory-link" disabled={unavailable !== null}
          title={unavailableTitle(unavailable)} onClick={() => openEntryRef(ref)}>{children}</button>
      );
    },
  };
}

/** @brief Details：Markdown 渲染；[[slug]] 找到时是链接（点了在详情里打开那一条），找不到时显示原文、不可点。 */
function Details({ entry }: { entry: EntryDetail }) {
  const cwd = useMemory((state) => state.cwd);
  const unavailable = useUnavailable();
  const links = useLinks(entry, cwd);
  const text = entry.details.replace(LINK, (_whole, slug: string) => {
    const ref = links[slug.trim()];
    const label = ref ? ref.abstract : `[[${slug}]]`;
    return `[${escapeText(label)}](${LINK_PREFIX}${encodeURIComponent(slug.trim())})`;
  });
  const components = useMemo(() => linkComponents(links, unavailable), [links, unavailable]);
  return (
    <section className="memory-block">
      <h3 className="memory-label">Details</h3>
      <div className="memory-details">
        {entry.details.trim() && <MemoryMarkdown text={text} components={components} />}
      </div>
    </section>
  );
}

// ---- Linked from、History ----

/** @brief Linked from：正文里链接到这一条的条目，每条一行 `<KIND> · <abstract>`（没有时不显示这一块）。 */
function Backlinks({ refs }: { refs: EntryRef[] }) {
  const unavailable = useUnavailable();
  if (refs.length === 0) return null;
  return (
    <section className="memory-block" data-testid="memory-backlinks">
      <h3 className="memory-label">Linked from</h3>
      <ul className="memory-links">
        {refs.map((ref) => (
          <li key={`${ref.layer}/${ref.id}`}>
            <button type="button" className="text-link" disabled={unavailable !== null}
              title={unavailableTitle(unavailable)} onClick={() => openEntryRef(ref)}>
              {KIND_LABEL[ref.kind]} · {ref.abstract}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * @brief History：detail 的 `## Revisions` 每一行，加改过它的修订（标题与时间，点了切到 Revisions 选中那一次）；
 *        两者都没有时不显示这一块。
 */
function History({ lines, revisions }: { lines: string[]; revisions: RevisionRow[] }) {
  const unavailable = useUnavailable();
  if (lines.length === 0 && revisions.length === 0) return null;
  return (
    <section className="memory-block" data-testid="memory-history">
      <h3 className="memory-label">History</h3>
      {lines.length > 0 && (
        <ul className="memory-history-lines">{lines.map((line, at) => <li key={at}>{line}</li>)}</ul>
      )}
      {revisions.length > 0 && (
        <ul className="memory-links">
          {revisions.map((row) => (
            <li key={row.id}>
              <button type="button" className="text-link" disabled={unavailable !== null}
                title={unavailableTitle(unavailable)} onClick={() => selectRevision(row.id)}>{row.title}</button>
              <span className="memory-muted"> · {monthDayTime(Date.parse(row.time))}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- 操作 ----

/**
 * @brief Edit、Delete…（确认框，进行中 Deleting…）、Move to user level / Move to this project。
 *        后台进程退出时确认框关闭（Delete… 不可用，§10.10），重新连上后不自己再打开。
 */
function EntryActions({ entry }: { entry: EntryDetail }) {
  const { scope, cwd } = usePlace();
  const busy = useMemory((state) => state.busy);
  const unavailable = useUnavailable();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (unavailable !== null && busy !== 'delete') setConfirming(false);
  }, [unavailable, busy]);
  const blocked = busy !== null || unavailable !== null;
  const title = unavailableTitle(unavailable);
  const canMove = scope === 'project' || cwd !== null;
  async function remove() {
    await deleteEntry();
    setConfirming(false);
  }
  return (
    <div className="memory-actions">
      <button type="button" className="button" data-testid="memory-edit" disabled={blocked} title={title}
        onClick={startEdit}>Edit</button>
      <button type="button" className="button" data-testid="memory-delete" disabled={blocked} title={title}
        onClick={() => setConfirming(true)}><Icon name="trash" />Delete…</button>
      {canMove && (
        <button type="button" className="button" data-testid="memory-move" disabled={blocked} title={title}
          onClick={() => void moveEntry()}>
          {scope === 'project' ? 'Move to user level' : 'Move to this project'}</button>
      )}
      {confirming && (
        <ConfirmDialog title={`Delete “${entry.abstract}”?`} text="You can roll it back from Revisions."
          confirmLabel="Delete" tone="danger" testId="memory-delete-dialog"
          busyText={busy === 'delete' ? 'Deleting…' : null} onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)} />
      )}
    </div>
  );
}

/** @brief 一条条目的详情。 */
function EntryView({ result, entry }: { result: MemoryGetResult; entry: EntryDetail }) {
  return (
    <div className="memory-entry">
      <h2 className="memory-detail-title">{entry.abstract}</h2>
      <p className="memory-detail-meta">{metaLine(entry)}</p>
      <Evidence entry={entry} />
      <Details entry={entry} />
      <Backlinks refs={result.backlinks} />
      <History lines={entry.history} revisions={result.revisions} />
      <EntryActions entry={entry} />
    </div>
  );
}

/** @brief 右栏的条目：写入失败的原因在顶部；读取失败、读取中、编辑表单或详情。 */
function EntryPanel() {
  const { result, detailError, editing, actionError } = useMemory(useShallow((state) => ({
    result: state.entry, detailError: state.detailError, editing: state.editing, actionError: state.actionError })));
  const entry = result?.entry ?? null;
  return (
    <>
      {actionError && <p className="form-message error" role="alert" data-testid="memory-error">{actionError}</p>}
      {detailError ? <LoadError text={detailError} />
        : !result || !entry ? <p className="memory-state" role="status">Loading…</p>
          : editing ? <MemoryForm initial={{ abstract: entry.abstract, details: entry.details }} />
            : <EntryView result={result} entry={entry} />}
    </>
  );
}

/** @brief 新增条目的表单（右栏）：保存失败的原因在顶部。 */
function NewPanel() {
  const actionError = useMemory((state) => state.actionError);
  return (
    <>
      {actionError && <p className="form-message error" role="alert" data-testid="memory-error">{actionError}</p>}
      <MemoryForm initial={null} />
    </>
  );
}

/**
 * @brief 记忆页的右栏：右栏有内容时显示（App.tsx 只在记忆页挂它）。
 * @param children 右栏的分隔线（宽度与会话的右栏共用）
 */
export function MemoryDetail({ children }: { children: ReactNode }) {
  const panel = useMemory((state) => state.panel);
  const section = useMemory((state) => state.section);
  const layer = useMemory(shownScope);
  if (panel.kind === 'none') return null;
  const label = panel.kind === 'revision' ? SECTION_LABEL.revisions : SECTION_LABEL[section];
  const bodyKey = panel.kind === 'new' ? `new/${layer}/${section}` : `${panel.kind}/${layer}/${panel.id}`;
  return (
    <aside className="right-panel" data-testid="memory-detail" aria-label="Memory details">
      {children}
      <div className="panel-header">
        <Icon name="memory" />{label}
        <button type="button" className="icon-button" aria-label="Close details" title="Close details"
          onClick={closePanel}><Icon name="close" /></button>
      </div>
      <div className="panel-body memory-detail-body" key={bodyKey}>
        {panel.kind === 'revision' ? <RevisionDetailView /> : panel.kind === 'new' ? <NewPanel /> : <EntryPanel />}
      </div>
    </aside>
  );
}
