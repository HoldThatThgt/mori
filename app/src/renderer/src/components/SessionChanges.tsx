// 右栏 Changes 的下半部分 This session（docs/specs/file-system.md §5.3，状态表 docs/v1/screens/fs-changes.md "This session"、
// "一个文件的 diff"）：只从当前分支上的 mori.turn_changes 归组（state/workspace.ts 的 turnGroups），不向后台进程要列表。
// 小标题上方是嵌套仓库那一行，下面是快照的说明（暂停、不可用、上一次失败、跳过的大文件）；每个有记录的轮一组，新的轮在上，
// 组标题 Turn <n> · <你那条消息的第一行>（悬停看全文），重叠的说明在组标题下、没列全的说明在组下面。文件行：状态字母、路径、
// 别的 Agent（次要文字色）、+<added> −<removed> 或 Binary、Open（删掉的没有）；点行展开、收起这一轮这个文件的 diff
// （snapshots.diff，只留下这个文件那一段交给 Diff.tsx），已经展开的 diff 不自动重读，失败时收起再展开重试。

import { useMemo, useRef, useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { SnapshotState } from '../../../shared/workspace';
import { describe } from '../state/bridge';
import { openFile } from '../state/quotes';
import type { Tab } from '../state/store';
import {
  LOADING_DIFF, loadTurnDiff, nestedNote, NO_CHANGES_TEXT, snapshotNotes, TURN_OVERLAP_TEXT, TURN_TRUNCATED_TEXT,
  turnGroups, type TurnDiff, type TurnFile, type TurnGroup,
} from '../state/workspace';
import { Diff, singleFileDiff } from './Diff';

/** 文件行状态字母的悬停文字（§5.3） */
const TURN_STATUS_TITLES: Readonly<Record<TurnFile['status'], string>> = Object.freeze({
  A: 'Added', M: 'Modified', D: 'Deleted',
});

/** 点开的 diff 要显示的，和交给 Diff.tsx 的那一个文件 */
interface ShownTurnDiff {
  /** 状态与说明；取不出这个文件的那一段时换成失败 */
  diff: TurnDiff;
  /** 这个文件的那一段；没有 patch 或取不出时为 null */
  file: FileDiffMetadata | null;
}

/**
 * @brief 从这一轮的 git diff 原文里只留下这个文件那一段（路径作 pathspec 也按目录前缀匹配：同一轮里文件夹 out 换成
 *        文件 out 时，点 out 会拿到 out 与 out/x 两段）。取不出恰好一段时换成失败的说明，收起再展开重试（§5.3）。
 */
function narrowTurnDiff(diff: TurnDiff, path: string): ShownTurnDiff {
  if (!diff.patch) return { diff, file: null };
  try {
    return { diff, file: singleFileDiff(diff.patch, path) };
  } catch (error) {
    const note = `Couldn’t load the diff: ${describe(`diff of ${path}`, error)}`;
    return { diff: { state: 'error', patch: null, note }, file: null };
  }
}

/** @brief 点开的 diff：读取中 Loading…；有 patch 时交给 Diff.tsx；二进制、没有差别、太大、整理、失败各有一行说明。 */
function TurnDiffView({ diff: loaded, path }: { diff: TurnDiff; path: string }) {
  const { diff, file } = useMemo(() => narrowTurnDiff(loaded, path), [loaded, path]);
  return (
    <div className="turn-diff" data-testid="turn-diff" data-state={diff.state}>
      {diff.state === 'loading' && <p className="changes-line muted">Loading…</p>}
      {file && <div className="change-diff"><Diff patch={file} /></div>}
      {diff.note && <p className={`changes-line${diff.state === 'error' ? ' error' : ' muted'}`}>{diff.note}</p>}
    </div>
  );
}

/**
 * @brief 一个文件这一轮的 diff 的展开状态：点了先显示 Loading…，结果到了再换；收起后晚到的结果不再显示。
 * @return diff 为 null 时收起
 */
function useTurnDiff(tabKey: string, round: string, path: string) {
  const [diff, setDiff] = useState<TurnDiff | null>(null);
  const request = useRef(0);
  const toggle = async () => {
    request.current += 1;
    if (diff) {
      setDiff(null);
      return;
    }
    const mine = request.current;
    setDiff(LOADING_DIFF);
    const loaded = await loadTurnDiff(tabKey, round, path);
    if (request.current === mine) setDiff(loaded);
  };
  return { diff, toggle };
}

/** @brief 文件行上的行数：+<added> −<removed>（− 是 U+2212，加减各用新增色、删除色）；每一段都是二进制时 Binary。 */
function LineCounts({ file }: { file: TurnFile }) {
  if (file.binary) return <span className="turn-file-lines">Binary</span>;
  return (
    <span className="turn-file-lines">
      <span className="lines-added">+{file.added}</span> <span className="lines-removed">−{file.removed}</span>
    </span>
  );
}

/** @brief 组里的一个文件：点行展开、收起 diff；Open 在阅读器里打开现在的文件（状态为 D 时没有）。 */
function TurnFileRow({ tabKey, round, file }: { tabKey: string; round: string; file: TurnFile }) {
  const { diff, toggle } = useTurnDiff(tabKey, round, file.path);
  return (
    <li>
      <div className="turn-file" data-testid="turn-file" data-path={file.path} data-status={file.status}
        data-added={file.added} data-removed={file.removed}>
        <button className="change-row turn-file-toggle" aria-expanded={diff !== null} onClick={() => void toggle()}>
          <span className="status-letter" data-code={file.status} title={TURN_STATUS_TITLES[file.status]}>
            {file.status}</span>
          <span className="change-row-path" title={file.path}>{file.path}</span>
          {file.agents && <span className="turn-file-agents" data-testid="turn-file-agents">{file.agents}</span>}
          <LineCounts file={file} />
        </button>
        {file.status !== 'D' && (
          <button className="text-link turn-file-open" data-testid="turn-file-open" aria-label={`Open ${file.path}`}
            onClick={() => openFile(tabKey, file.path)}>Open</button>
        )}
      </div>
      {diff && <TurnDiffView diff={diff} path={file.path} />}
    </li>
  );
}

/** @brief 一轮：组标题 Turn <n> · <第一行>（那条消息不在对话流里时只有第一行），两种说明，文件按第一次出现的先后。 */
function TurnChangesGroup({ tabKey, group }: { tabKey: string; group: TurnGroup }) {
  const title = group.turn === null ? group.title : `Turn ${group.turn} · ${group.title}`;
  return (
    <div className="turn-changes" data-testid="turn-changes" data-round={group.round}
      data-turn={group.turn ?? undefined}>
      <div className="changes-subtitle turn-title" title={group.text || undefined}>{title}</div>
      {group.overlap && <p className="changes-line note" data-testid="turn-overlap">{TURN_OVERLAP_TEXT}</p>}
      <ul className="change-rows">
        {group.files.map((file) => <TurnFileRow key={file.path} tabKey={tabKey} round={group.round} file={file} />)}
      </ul>
      {group.truncated && <p className="changes-line note" data-testid="turn-truncated">{TURN_TRUNCATED_TEXT}</p>}
    </div>
  );
}

/** @brief 小标题下面的快照说明（data-kind：paused、off、error、skipped；跳过的大文件悬停列出路径）。 */
function SnapshotNotes({ snapshots }: { snapshots: SnapshotState }) {
  return (
    <>
      {snapshotNotes(snapshots).map((note) => (
        <p key={note.kind} className={`changes-line note${note.kind === 'error' ? ' error' : ''}`}
          data-testid="snapshots-note" data-kind={note.kind} title={note.title ?? undefined}>{note.text}</p>
      ))}
    </>
  );
}

/**
 * @brief This session（git 仓库、不是 git 仓库、认不出仓库、还没有状态时都有）。快照的说明按这个会话最近一次的
 *        WorkspaceStatus.snapshots；还没收到状态时没有说明，记录照常列出。
 */
export function SessionChanges({ tab }: { tab: Tab }) {
  const { items, turnChanges } = tab.transcript;
  // 只在对话流或记录变了时重新归组（流式输出时对话流的每一段都会变，归组本身是一遍线性扫描）。
  const groups = useMemo(() => turnGroups(tab), [items, turnChanges, tab.cwd]);
  const snapshots = tab.workspace?.snapshots ?? null;
  const nested = snapshots ? nestedNote(snapshots) : null;
  return (
    <section className="session-changes" data-testid="session-changes" aria-label="This session">
      {nested && <p className="changes-line note" data-testid="nested-repos-note">{nested}</p>}
      <h3 className="session-changes-title">This session</h3>
      {snapshots && <SnapshotNotes snapshots={snapshots} />}
      {groups.length === 0 ? <p className="changes-line muted" data-testid="session-changes-empty">{NO_CHANGES_TEXT}</p>
        : groups.map((group) => <TurnChangesGroup key={group.round} tabKey={tab.key} group={group} />)}
    </section>
  );
}
