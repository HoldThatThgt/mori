// 文件系统第 2 步的界面状态（docs/specs/file-system.md §3.5、§4.6、§5.1–§5.11，状态表 docs/v1/screens/fs-changes.md、
// fs-rewind.md；验收 §19.2 FS-10、FS-12、FS-13、FS-15、FS-18、FS-19、FS-23、FS-24 的单元层补充）：
// state/workspace.ts（右栏 Changes、git 状态、This session 的归组、顶栏 +N −M、一个文件的 diff）、state/rewind.ts（按钮、
// 菜单、需求还开着、Undo、通知、进行中与冲突的文字、发命令与动作记录）、model.ts 与 sessionRefs.ts 共用的轮编号、
// transcript.ts 的 mori.turn_changes / mori.rewind / mori.snapshot_stage、history.ts 重新打开时载入这些条目、
// actions.ts 后台进程退出时清掉 Rewind 状态、projects.ts 正在 Rewind 时拒绝归档与删除、删除后发 snapshots.drop。
// 会话、条目、事件与命令结果都是测试手写的（synthetic）；后台进程与主进程由 renderer-load.mjs 的替身代替。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge, loadRendererModules } from './renderer-load.mjs';

const STATE = 'src/renderer/src/state';
const R = await loadRendererModules({
  workspace: `${STATE}/workspace.ts`,
  rewind: `${STATE}/rewind.ts`,
  model: `${STATE}/model.ts`,
  transcript: `${STATE}/transcript.ts`,
  history: `${STATE}/history.ts`,
  sessionRefs: `${STATE}/sessionRefs.ts`,
  store: `${STATE}/store.ts`,
  actions: `${STATE}/actions.ts`,
  actionLog: `${STATE}/actionLog.ts`,
  quoteText: `${STATE}/quoteText.ts`,
  projects: `${STATE}/projects.ts`,
});
const W = R.workspace;
const RW = R.rewind;
const M = R.model;
const S = R.store;

const CWD = 'C:\\w\\proj';
const NOW = 1_000_000;
const SESSION = 'pi-session-1';
const WAKE_TEXT = '[Mori] Request 1 closed. Tell the user.';
const PRUNED = 'Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.';

// ---- synthetic 的数据 ----

/** 快照照常、没有说明 */
const SNAPSHOTS_ON = Object.freeze({ state: 'on', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [],
  nestedTotal: 0 });
/** 工作路径就是仓库根 */
const REPO = Object.freeze({ toplevel: CWD, commonDir: `${CWD}\\.git`, gitDir: `${CWD}\\.git`, isWorktree: false,
  hasCommit: true });
/** main 分支、没有上游 */
const MAIN = Object.freeze({ head: 'main', oid: '0123456789abcdef', upstream: null, ahead: null, behind: null });

/** @brief 一份 git 状态（WorkspaceStatus）；fields 覆盖默认值。 */
function status(fields = {}) {
  return { cwd: CWD, git: { state: 'ok', version: '2.55.0' }, repo: REPO, branch: MAIN, files: [], total: 0,
    truncated: false, error: null, snapshots: SNAPSHOTS_ON, at: NOW, ...fields };
}

/** @brief 快照状态；fields 覆盖默认值。 */
const snaps = (fields) => ({ ...SNAPSHOTS_ON, ...fields });
/** @brief git 状态里的一个文件。 */
const sfile = (path, group, code, from = null) => ({ path, from, group, code });
/** @brief 一段改动里的一个文件。 */
const cf = (path, fileStatus, added, removed) => ({ path, status: fileStatus, added, removed });

/** 对话本身（基座） */
const SELF = Object.freeze({ role: 'mori', task: null, self: true });
/** @brief 一个实例。 */
const agent = (role, task = null) => ({ role, task, self: false });

/** @brief changes 记录；fields 覆盖默认值（total 默认等于 files 的条数）。 */
function changes(round, files, fields = {}) {
  return { v: 1, kind: 'changes', round, base: `base-${round}`, head: `head-${round}`, files, total: files.length,
    agents: [SELF], overlap: false, at: NOW, ...fields };
}

/** @brief run 记录。 */
const run = (round) => ({ v: 1, kind: 'run', round, start: `start-${round}`, end: `end-${round}`, at: NOW });

/** @brief 当前分支上的 mori.turn_changes 列表：条目 id 依次 tc1、tc2…。 */
const turnChanges = (...records) => records.map((record, index) => ({ entryId: `tc${index + 1}`, record }));

/** @brief mori.rewind 的记录；fields 覆盖默认值（默认是恢复了代码的 Rewind，P、Q 都在）。 */
function rewindRecord(fields = {}) {
  return { v: 1, kind: 'rewind', target: 'u1', turn: 1, code: true, conversation: false, from: null, safety: 'p-oid',
    post: 'q-oid', restored: ['a.ts'], deleted: [], skipped: [], failed: [],
    counts: { restored: 1, deleted: 0, skipped: 0, failed: 0 }, at: NOW, ...fields };
}

let itemSeq = 0;
/** @brief 对话流里你的一条消息。 */
const user = (entryId, text = `Message ${entryId}`, fields = {}) => ({ kind: 'user', key: `k${++itemSeq}`, text,
  refs: null, entryId, time: null, ...fields });
/** @brief 一条助手回复。 */
const reply = (entryId = null, blocks = [{ type: 'text', text: 'Done.' }]) => ({ kind: 'assistant',
  key: `k${++itemSeq}`, blocks, streaming: false, entryId, time: null });
/** @brief 一条程序投递（mori.wake 指向的消息）。 */
const wake = (entryId) => ({ kind: 'wake', key: `k${++itemSeq}`, wakeKind: 'request_closed', entryId, time: null });
/** @brief 一行回执。 */
const receipt = (kind, request) => ({ kind: 'receipt', key: `k${++itemSeq}`,
  receipt: { kind, request, title: `Request ${request}`, quote: null, at: NOW } });
/** @brief 一条 Rewind 通知。 */
const notice = (entryId, record, warning = null) => ({ kind: 'rewind', key: `k${++itemSeq}`, entryId, record,
  warning });

/** @brief 对话流；extra 覆盖其余字段。 */
const transcriptOf = (items, records = [], extra = {}) => ({ ...M.emptyTranscript, items, turnChanges: records,
  ...extra });

/** @brief 一个打开的会话（git 是 ok、有 pi 会话 id）；fields 覆盖默认值。 */
function tabOf(transcript = M.emptyTranscript, fields = {}) {
  return S.newTab(CWD, { sessionId: SESSION, phase: 'ready', workspace: status(), transcript, ...fields });
}

/** @brief TaskBoard 视图里的一个需求。 */
function request(no, requestStatus) {
  return { no, title: `Request ${no}`, status: requestStatus, state: requestStatus === 'open' ? 'running' : 'done',
    createdAt: NOW, closedAt: null, conclusion: null, ruledOut: [], question: null, tasks: [] };
}

/** @brief 一条会话条目（pi 的 SessionEntry）：消息。 */
const messageEntry = (id, role, content) => ({ type: 'message', id, parentId: null, timestamp: '2026-10-27T00:00:00Z',
  message: { role, content, timestamp: NOW } });
/** @brief 一条会话条目：自定义条目。 */
const customEntry = (id, customType, data) => ({ type: 'custom', id, parentId: null,
  timestamp: '2026-10-27T00:00:00Z', customType, data });
/** @brief 助手回复的内容。 */
const said = (text) => [{ type: 'text', text }];

/**
 * @brief 运行 fn，截下这期间 console.error 的每一行：fn 同步时直接返回这些行，返回 Promise 时等它完成后给出
 *        （返回 Promise）。
 */
function quietErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  let result;
  try {
    result = fn();
  } catch (error) {
    console.error = original;
    throw error;
  }
  if (typeof result?.then !== 'function') {
    console.error = original;
    return lines;
  }
  return result.then(() => lines).finally(() => { console.error = original; });
}

// ---- git 状态与右栏的正文（§3.5、§5.1、§5.2） ----

test('FS-13 statusAllowed: workspace.status is sent only when the kernel is ready and the session is open', () => {
  const open = tabOf();
  assert.equal(W.statusAllowed(open, 'ready'), true);
  for (const kernel of ['connecting', 'exited', 'reloading']) assert.equal(W.statusAllowed(open, kernel), false);
  assert.equal(W.statusAllowed({ ...open, sessionId: null }, 'ready'), false);
  assert.equal(W.statusAllowed({ ...open, phase: 'opening' }, 'ready'), false);
  assert.equal(W.statusAllowed({ ...open, phase: 'failed' }, 'ready'), false);
});

test('FS-13 withStatus keeps the newer read: an older at does not replace it, the same at (resent) does', () => {
  const first = W.withStatus(tabOf(M.emptyTranscript, { workspace: null }), status({ at: 200 }));
  assert.equal(first.workspace.at, 200);
  const older = status({ at: 100, files: [sfile('late.ts', 'unstaged', 'M')], total: 1 });
  assert.equal(W.withStatus(first, older), first);
  const resent = status({ at: 200, snapshots: snaps({ error: 'disk full' }) });
  assert.equal(W.withStatus(first, resent).workspace.snapshots.error, 'disk full');
  assert.equal(W.withStatus(first, status({ at: 300 })).workspace.at, 300);
});

test('FS-13 changesBody gives each kind with its exact text; missing and old have no This session', () => {
  assert.deepEqual(W.changesBody(null), { kind: 'loading', text: 'Loading…', session: true });
  assert.deepEqual(W.changesBody(status({ git: { state: 'missing' }, repo: null, branch: null })),
    { kind: 'missing', text: 'Git is required to track changes and rewind.', session: false });
  assert.deepEqual(W.changesBody(status({ git: { state: 'old', version: '2.31.0' }, repo: null, branch: null })),
    { kind: 'old', text: 'Git 2.32 or newer is required to track changes and rewind (found 2.31.0).',
      session: false });
  const dubious = 'detected dubious ownership in repository at \'C:/w/proj\'';
  assert.deepEqual(W.changesBody(status({ repo: null, branch: null, error: dubious })),
    { kind: 'error', text: `Couldn’t read git status: ${dubious}`, session: true });
  assert.deepEqual(W.changesBody(status({ repo: null, branch: null })),
    { kind: 'not-repo', text: 'Not a git repository', session: true });
  const repo = status();
  assert.deepEqual(W.changesBody(repo), { kind: 'repo', status: repo, session: true });
  // 仓库认出来了、git status 失败：仍是 git 仓库，错误行由 gitStatusView 画在分支行的位置
  assert.equal(W.changesBody(status({ error: 'bad object HEAD' })).kind, 'repo');
  assert.equal(W.GIT_REQUIRED_TEXT, 'Git is required to track changes and rewind.');
  assert.equal(W.NOT_A_REPO_TEXT, 'Not a git repository');
  assert.equal(W.STATUS_LOADING_TEXT, 'Loading…');
});

test('FS-13 branchText writes every branch form: name, detached, No commits yet, ahead/behind, Up to date, gone',
  () => {
    const branch = (fields) => W.branchText({ ...MAIN, ...fields });
    assert.equal(branch({}), 'main');
    assert.equal(branch({ head: null, oid: 'abcdef0123456789' }), 'HEAD detached at abcdef0');
    assert.equal(branch({ oid: null }), 'main · No commits yet');
    const upstream = { upstream: 'origin/main' };
    assert.equal(branch({ ...upstream, ahead: 0, behind: 0 }), 'main · origin/main · Up to date');
    assert.equal(branch({ ...upstream, ahead: 1, behind: 0 }), 'main · origin/main · 1 ahead');
    assert.equal(branch({ ...upstream, ahead: 0, behind: 2 }), 'main · origin/main · 2 behind');
    assert.equal(branch({ ...upstream, ahead: 1, behind: 2 }), 'main · origin/main · 1 ahead, 2 behind');
    assert.equal(branch({ ...upstream, ahead: null, behind: null }), 'main · origin/main (gone)');
    assert.equal(branch({ ...upstream, oid: null, ahead: null, behind: null }),
      'main · No commits yet · origin/main (gone)');
  });

test('FS-13 gitStatusView groups Conflicts, Staged, Unstaged, Untracked in that order with counts', () => {
  const files = [sfile('a.ts', 'staged', 'M'), sfile('a.ts', 'unstaged', 'M'), sfile('build/', 'untracked', '?'),
    sfile('new.ts', 'staged', 'R', 'old.ts'), sfile('src/merge.ts', 'conflicted', 'U')];
  const view = W.gitStatusView(status({ files, total: files.length,
    branch: { ...MAIN, upstream: 'origin/main', ahead: 1, behind: 2 } }));
  assert.equal(view.branch, 'main · origin/main · 1 ahead, 2 behind');
  assert.equal(view.error, null);
  assert.deepEqual(view.groups.map((group) => [group.group, group.title, group.files.map((file) => file.path)]), [
    ['conflicted', 'Conflicts · 1', ['src/merge.ts']],
    ['staged', 'Staged · 2', ['a.ts', 'new.ts']],
    ['unstaged', 'Unstaged · 1', ['a.ts']],
    ['untracked', 'Untracked · 1', ['build/']],
  ]);
  assert.equal(view.empty, null);
  assert.equal(view.footer, null);
  const onlyUntracked = W.gitStatusView(status({ files: [sfile('x.txt', 'untracked', '?')], total: 1 }));
  assert.deepEqual(onlyUntracked.groups.map((group) => group.title), ['Untracked · 1']);
});

test('FS-13 gitStatusView texts: No uncommitted changes, Showing 500 of 1,234 files., Showing the first 500 files.',
  () => {
    const empty = W.gitStatusView(status());
    assert.deepEqual(empty,
      { branch: 'main', error: null, groups: [], empty: 'No uncommitted changes', footer: null });
    const many = Array.from({ length: 500 }, (_unused, index) => sfile(`f${index}.txt`, 'untracked', '?'));
    assert.equal(W.gitStatusView(status({ files: many, total: 1234 })).footer, 'Showing 500 of 1,234 files.');
    assert.equal(W.gitStatusView(status({ files: many, total: 500, truncated: true })).footer,
      'Showing the first 500 files.');
    assert.equal(W.gitStatusView(status({ files: many, total: 1234, truncated: true })).footer,
      'Showing the first 500 files.');
    assert.equal(W.gitStatusView(status({ files: many, total: 500 })).footer, null);
  });

test('FS-13 gitStatusView on a read failure shows only the error line where the branch line goes', () => {
  const view = W.gitStatusView(status({ error: 'bad object HEAD', branch: null }));
  assert.deepEqual(view, { branch: null, error: 'Couldn’t read git status: bad object HEAD', groups: [], empty: null,
    footer: null });
  assert.equal(W.statusErrorText('x'), 'Couldn’t read git status: x');
});

test('FS-13 status rows: rename label, status-letter hovers, and the reader path <toplevel>\\<path>', () => {
  assert.equal(W.statusFileLabel(sfile('src/new.ts', 'staged', 'R', 'src/old.ts')), 'src/old.ts → src/new.ts');
  assert.equal(W.statusFileLabel(sfile('src/a.ts', 'unstaged', 'M')), 'src/a.ts');
  assert.deepEqual({ ...W.STATUS_CODE_TITLES }, { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed',
    C: 'Copied', T: 'Type changed', U: 'Conflicted' });
  assert.equal(W.STATUS_CODE_TITLES['?'], undefined);
  const inRepo = status();
  assert.equal(W.statusFilePath(inRepo, sfile('src/a.ts', 'unstaged', 'M')), 'C:\\w\\proj\\src\\a.ts');
  assert.equal(W.statusFilePath(inRepo, sfile('build/out/', 'untracked', '?')), 'C:\\w\\proj\\build\\out');
  const rootSlash = status({ repo: { ...REPO, toplevel: 'C:\\w\\' } });
  assert.equal(W.statusFilePath(rootSlash, sfile('proj/a.ts', 'staged', 'A')), 'C:\\w\\proj\\a.ts');
  assert.equal(W.statusFilePath(status({ repo: null }), sfile('a.ts', 'staged', 'A')), null);
});

// ---- This session 顶部的说明（§5.3） ----

test('FS-12 snapshotNotes: paused and off reasons verbatim, Couldn’t take a snapshot, large files with a hover list',
  () => {
    assert.deepEqual(W.snapshotNotes(SNAPSHOTS_ON), []);
    const paused = 'Snapshots are paused for this folder: more than 20,000 new files would be added. '
      + 'Add generated folders to .gitignore to resume.';
    assert.deepEqual(W.snapshotNotes(snaps({ state: 'paused', reason: paused })),
      [{ kind: 'paused', text: paused, title: null }]);
    assert.deepEqual(W.snapshotNotes(snaps({ state: 'off', reason: 'Another app owns this snapshot folder.' })),
      [{ kind: 'off', text: 'Another app owns this snapshot folder.', title: null }]);
    assert.deepEqual(W.snapshotNotes(snaps({ error: '\'lib/\' does not have a commit checked out' })),
      [{ kind: 'error', text: 'Couldn’t take a snapshot: \'lib/\' does not have a commit checked out', title: null }]);
    assert.deepEqual(W.snapshotNotes(snaps({ skipped: ['big.bin'], skippedTotal: 1 })),
      [{ kind: 'skipped', text: '1 large file isn’t in snapshots (over 10 MB).', title: 'big.bin' }]);
    const twenty = Array.from({ length: 20 }, (_unused, index) => `media/clip${index}.mp4`);
    const many = W.snapshotNotes(snaps({ skipped: twenty, skippedTotal: 1234 }));
    assert.deepEqual(many, [{ kind: 'skipped', text: '1,234 large files aren’t in snapshots (over 10 MB).',
      title: twenty.join('\n') }]);
    const all = W.snapshotNotes(snaps({ state: 'paused', reason: paused, error: 'x', skipped: ['a'],
      skippedTotal: 2 }));
    assert.deepEqual(all.map((note) => note.kind), ['paused', 'error', 'skipped']);
    assert.equal(all[2].text, '2 large files aren’t in snapshots (over 10 MB).');
  });

test('FS-26 nestedNote lists the nested repositories and adds " and <n> more" past the listed ones', () => {
  assert.equal(W.nestedNote(SNAPSHOTS_ON), null);
  assert.equal(W.nestedNote(snaps({ nested: ['vendor/lib', 'tools/sub'], nestedTotal: 2 })),
    'Changes inside nested repositories aren’t tracked: vendor/lib, tools/sub');
  const twenty = Array.from({ length: 20 }, (_unused, index) => `repos/r${index}`);
  assert.equal(W.nestedNote(snaps({ nested: twenty, nestedTotal: 21 })),
    `Changes inside nested repositories aren’t tracked: ${twenty.join(', ')} and 1 more`);
});

// ---- 当前分支上的记录：自动打开、重读、顶栏（§5.1、§5.4） ----

test('FS-12 changesRecords and hasTurnChanges see only changes records (a run record alone does not open the panel)',
  () => {
    const onlyRun = tabOf(transcriptOf([user('u1')], turnChanges(run('u1'))));
    assert.deepEqual(W.changesRecords(onlyRun.transcript), []);
    assert.equal(W.hasTurnChanges(onlyRun), false);
    const first = changes('u1', [cf('a.ts', 'M', 1, 0)]);
    const second = changes('u1', [cf('b.ts', 'A', 2, 0)]);
    const both = tabOf(transcriptOf([user('u1')], turnChanges(run('u1'), first, second)));
    assert.deepEqual(W.changesRecords(both.transcript), [first, second]);
    assert.equal(W.hasTurnChanges(both), true);
  });

test('FS-12 fileChangeCount counts the changes records listing the open file (absolute or relative, any case)', () => {
  const records = turnChanges(changes('u1', [cf('src/App.ts', 'M', 1, 1), cf('README.md', 'M', 1, 0)]),
    run('u1'), changes('u2', [cf('src/app.ts', 'M', 2, 0)]), changes('u2', [cf('other.ts', 'A', 1, 0)]));
  const tab = tabOf(transcriptOf([user('u1'), user('u2')], records));
  assert.equal(W.fileChangeCount(tab, 'C:\\w\\proj\\src\\App.ts'), 2);
  assert.equal(W.fileChangeCount(tab, 'src/App.ts'), 2);
  assert.equal(W.fileChangeCount(tab, 'c:/w/proj/README.md'), 1);
  assert.equal(W.fileChangeCount(tab, 'missing.md'), 0);
});

test('FS-23 lineTotals sums added and removed over the changes records and skips binary (null) counts', () => {
  const records = turnChanges(run('u1'), changes('u1', [cf('a.ts', 'M', 3, 1), cf('logo.png', 'A', null, null)]),
    changes('u2', [cf('b.ts', 'A', 10, 0), cf('c.ts', 'D', 0, 7)]));
  assert.deepEqual(W.lineTotals(transcriptOf([], records)), { added: 13, removed: 8 });
  assert.deepEqual(W.lineTotals(M.emptyTranscript), { added: 0, removed: 0 });
});

test('FS-23 linesShown needs git ok and a non-zero total; linesLabel is singular for one added line', () => {
  const some = transcriptOf([user('u1')], turnChanges(changes('u1', [cf('a.ts', 'M', 1, 0)])));
  assert.equal(W.linesShown(tabOf(some)), true);
  assert.equal(W.linesShown(tabOf(some, { workspace: null })), false);
  assert.equal(W.linesShown(tabOf(some, { workspace: status({ git: { state: 'missing' }, repo: null }) })), false);
  assert.equal(W.linesShown(tabOf(some, { workspace: status({ git: { state: 'old', version: '2.31.0' } }) })), false);
  const binary = transcriptOf([user('u1')], turnChanges(changes('u1', [cf('a.png', 'A', null, null)])));
  assert.equal(W.linesShown(tabOf(binary)), false);
  const removedOnly = transcriptOf([user('u1')], turnChanges(changes('u1', [cf('a.ts', 'M', 0, 4)])));
  assert.equal(W.linesShown(tabOf(removedOnly)), true);
  assert.equal(W.linesShown(tabOf(M.emptyTranscript)), false);
  assert.equal(W.linesLabel({ added: 1, removed: 0 }), 'Changes in this session: 1 line added, 0 removed');
  assert.equal(W.linesLabel({ added: 12, removed: 1 }), 'Changes in this session: 12 lines added, 1 removed');
  assert.equal(W.linesLabel({ added: 0, removed: 3 }), 'Changes in this session: 0 lines added, 3 removed');
});

// ---- This session 的归组（§5.3） ----

/** @brief 组标题（同 SessionChanges.tsx：Turn <n> · <第一行>）。 */
const groupTitle = (group) => (group.turn === null ? group.title : `Turn ${group.turn} · ${group.title}`);

test('FS-12 turnGroups: one group per turn, newest first, Turn <n> · <first line>, [Mori] deliveries not counted',
  () => {
    const items = [user('u1', 'Fix the parser\nand add tests'), reply('a1'), wake('u2'), reply('a2'),
      user('u3', '  \n  Rename the module  \nthen run it'), reply('a3'), user('u4', 'Thanks')];
    const records = turnChanges(run('u1'), changes('u1', [cf('a.ts', 'M', 1, 1)]), run('u3'),
      changes('u3', [cf('b.ts', 'A', 2, 0)]), run('u4'));
    const groups = W.turnGroups(tabOf(transcriptOf(items, records)));
    assert.deepEqual(groups.map(groupTitle), ['Turn 2 · Rename the module', 'Turn 1 · Fix the parser']);
    assert.deepEqual(groups.map((group) => group.round), ['u3', 'u1']);
    assert.equal(groups[1].text, 'Fix the parser\nand add tests');
    assert.equal(groups[0].text, 'Rename the module  \nthen run it');
    assert.deepEqual(W.turnGroups(tabOf(transcriptOf(items, turnChanges(run('u1'))))), []);
    assert.equal(W.NO_CHANGES_TEXT, 'No changes yet.');
  });

test('FS-12 turnGroups merges a file over the segments: A/M/D from first and last appearance, created then deleted '
  + 'is D, line sums', () => {
  const first = changes('u1', [cf('a.ts', 'A', 5, 0), cf('b.ts', 'M', 2, 1), cf('c.ts', 'M', 1, 0),
    cf('gone.ts', 'A', 3, 0)]);
  const second = changes('u1', [cf('a.ts', 'M', 1, 1), cf('c.ts', 'D', 0, 1), cf('d.ts', 'D', 0, 4),
    cf('gone.ts', 'D', 0, 3)]);
  const [group] = W.turnGroups(tabOf(transcriptOf([user('u1')], turnChanges(run('u1'), first, second))));
  const rows = group.files.map((file) => [file.path, file.status, file.added, file.removed, file.binary]);
  assert.deepEqual(rows, [
    ['a.ts', 'A', 6, 1, false],
    ['b.ts', 'M', 2, 1, false],
    ['c.ts', 'D', 1, 1, false],
    ['gone.ts', 'D', 3, 3, false],
    ['d.ts', 'D', 0, 4, false],
  ]);
  assert.equal(group.overlap, false);
  assert.equal(group.truncated, false);
});

test('FS-12 turnGroups: Binary only when every segment is binary; Agent names only when not all self', () => {
  const holder = { role: 'Planner', task: null, self: true };
  const records = turnChanges(
    changes('u1', [cf('img.png', 'A', null, null), cf('data.bin', 'M', null, null), cf('x.ts', 'M', 1, 0),
      cf('y.ts', 'M', 1, 0)], { agents: [SELF] }),
    changes('u1', [cf('img.png', 'M', null, null), cf('data.bin', 'M', 2, 1), cf('y.ts', 'M', 1, 0),
      cf('z.ts', 'A', 4, 0)], { agents: [SELF, agent('Executor', 'T2')] }),
    changes('u1', [cf('z.ts', 'M', 1, 1)], { agents: [agent('Reviewer'), agent('Executor', 'T2')] }),
    changes('u2', [cf('w.ts', 'M', 1, 0)], { agents: [holder, agent('Executor', 'T1')] }));
  const groups = W.turnGroups(tabOf(transcriptOf([user('u1'), user('u2')], records)));
  const byPath = new Map(groups.flatMap((group) => group.files).map((file) => [file.path, file]));
  assert.deepEqual([byPath.get('img.png').binary, byPath.get('img.png').added, byPath.get('img.png').removed],
    [true, 0, 0]);
  assert.deepEqual([byPath.get('data.bin').binary, byPath.get('data.bin').added, byPath.get('data.bin').removed],
    [false, 2, 1]);
  assert.equal(byPath.get('x.ts').agents, null);
  assert.equal(byPath.get('y.ts').agents, 'Mori, Executor (T2)');
  assert.equal(byPath.get('z.ts').agents, 'Mori, Executor (T2), Reviewer');
  assert.equal(byPath.get('w.ts').agents, 'Planner, Executor (T1)');
  assert.equal(W.agentName(SELF), 'Mori');
  assert.equal(W.agentName(agent('Executor', 'T2')), 'Executor (T2)');
  assert.equal(W.agentName(agent('Reviewer')), 'Reviewer');
  assert.equal(W.agentName({ role: 'Executor', task: 'T1', self: true }), 'Executor');
});

test('FS-12 turnGroups notes per turn: overlap and too many files; the title drops quote blocks and writes skill '
  + 'calls back', () => {
  const ref = { quote: 'function parse() {}', source: { kind: 'file', path: `${CWD}\\src\\parse.ts`,
    sha256: '0'.repeat(64), startLine: 3, endLine: 3 } };
  const quoted = R.quoteText.composePrompt([ref], 'Explain this function\nin detail', CWD);
  const skill = '<skill name="review" location="C:\\skills\\review\\SKILL.md">\nReview carefully.\n</skill>'
    + '\n\nthe parser';
  const items = [user('u1', quoted, { refs: [ref] }), user('u2', skill), user('u3', 'Plain')];
  const records = turnChanges(changes('u1', [cf('a.ts', 'M', 1, 0)], { overlap: true }),
    changes('u1', [cf('b.ts', 'M', 1, 0)]), changes('u2', [cf('c.ts', 'M', 1, 0)], { total: 3 }),
    changes('u3', [cf('d.ts', 'M', 1, 0)]));
  const groups = W.turnGroups(tabOf(transcriptOf(items, records)));
  assert.deepEqual(groups.map((group) => [groupTitle(group), group.overlap, group.truncated]), [
    ['Turn 3 · Plain', false, false],
    ['Turn 2 · /skill:review the parser', false, true],
    ['Turn 1 · Explain this function', true, false],
  ]);
  assert.equal(groups[2].text, 'Explain this function\nin detail');
  assert.equal(W.TURN_OVERLAP_TEXT, 'Another session in this folder was running at the same time, so some of these '
    + 'changes may be theirs.');
  assert.equal(W.TURN_TRUNCATED_TEXT, 'Some files in this turn aren’t listed. Too many changed at once.');
});

/** 两轮都改了文件的当前分支：u1 改 a.ts（+2 −1），u2 新建 b.ts（+5） */
function twoTurnEntries() {
  return [messageEntry('u1', 'user', 'First'), messageEntry('a1', 'assistant', said('ok')),
    customEntry('tc1', 'mori.turn_changes', run('u1')),
    customEntry('tc2', 'mori.turn_changes', changes('u1', [cf('a.ts', 'M', 2, 1)])),
    messageEntry('u2', 'user', 'Second'), messageEntry('a2', 'assistant', said('ok')),
    customEntry('tc3', 'mori.turn_changes', run('u2')),
    customEntry('tc4', 'mori.turn_changes', changes('u2', [cf('b.ts', 'A', 5, 0)]))];
}

/** @brief 只恢复代码（Rewind 到 u2）之后重新打开：分支不变，mori.rewind 接在末尾。 */
const afterCodeRestore = () => tabOf(R.history.transcriptFromEntries([...twoTurnEntries(),
  customEntry('rw1', 'mori.rewind', rewindRecord({ target: 'u2', turn: 2 }))]));

/** @brief 恢复代码和对话（到 u2 之前）之后重新打开：新的当前分支只到 u1 的两条记录，接着 mori.rewind。 */
const afterConversationRestore = () => tabOf(R.history.transcriptFromEntries([...twoTurnEntries().slice(0, 4),
  customEntry('rw2', 'mori.rewind', rewindRecord({ target: 'u2', turn: 2, conversation: true, from: 'tc4' }))]));

test('FS-12 This session after a rewind: Restore code keeps the turns; restoring the conversation drops the turns '
  + 'that left the branch', () => {
  assert.deepEqual(W.turnGroups(afterCodeRestore()).map(groupTitle), ['Turn 2 · Second', 'Turn 1 · First']);
  assert.deepEqual(W.turnGroups(afterConversationRestore()).map(groupTitle), ['Turn 1 · First']);
  // 记录的轮不在对话流里时没有编号、排在最后（只写第一行，这里为空）
  const orphan = tabOf(transcriptOf([user('u1', 'First')], turnChanges(changes('gone', [cf('z.ts', 'M', 1, 0)]),
    changes('u1', [cf('a.ts', 'M', 1, 0)]))));
  assert.deepEqual(W.turnGroups(orphan).map((group) => [group.round, group.turn]), [['u1', 1], ['gone', null]]);
});

test('FS-23 +N −M stays the same after Restore code and is recounted from the new branch after restoring the '
  + 'conversation', () => {
  const before = tabOf(R.history.transcriptFromEntries(twoTurnEntries()));
  assert.deepEqual(W.lineTotals(before.transcript), { added: 7, removed: 1 });
  const kept = afterCodeRestore();
  assert.deepEqual(W.lineTotals(kept.transcript), { added: 7, removed: 1 });
  assert.equal(W.linesLabel(W.lineTotals(kept.transcript)), 'Changes in this session: 7 lines added, 1 removed');
  const recounted = afterConversationRestore();
  assert.deepEqual(W.lineTotals(recounted.transcript), { added: 2, removed: 1 });
  assert.equal(W.linesShown(recounted), true);
  assert.equal(W.linesLabel(W.lineTotals(recounted.transcript)), 'Changes in this session: 2 lines added, 1 removed');
  // 恢复到第一条消息之前：新的当前分支上没有 changes 记录，+N −M 不显示
  const empty = tabOf(R.history.transcriptFromEntries([customEntry('rw3', 'mori.rewind',
    rewindRecord({ target: 'u1', turn: 1, conversation: true, from: 'tc4' }))]));
  assert.deepEqual(W.lineTotals(empty.transcript), { added: 0, removed: 0 });
  assert.equal(W.linesShown(empty), false);
});

// ---- 一个文件的 diff（§5.3） ----

test('FS-12 turnDiffOf maps every snapshots.diff result to its state and note', () => {
  const diff = (fields) => W.turnDiffOf({ patch: null, binary: false, truncated: false, error: null, ...fields });
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual({ ...W.LOADING_DIFF }, { state: 'loading', patch: null, note: null });
  assert.deepEqual(diff({ patch }), { state: 'shown', patch, note: null });
  assert.deepEqual(diff({ binary: true }), { state: 'binary', patch: null, note: 'Binary file · No preview' });
  assert.deepEqual(diff({ patch: '' }), { state: 'empty', patch: null, note: 'No net changes in this turn.' });
  assert.deepEqual(diff({ patch, truncated: true }),
    { state: 'truncated', patch, note: 'The diff is too large to show in full.' });
  assert.deepEqual(diff({ error: PRUNED }), { state: 'pruned', patch: null, note: PRUNED });
  assert.deepEqual(diff({ error: 'bad revision \'base-u1\'' }),
    { state: 'error', patch: null, note: 'Couldn’t load the diff: bad revision \'base-u1\'' });
});

/** @brief 把仓库换成只有这些会话（后台进程就绪、在对话视图）。 */
function useTabs(...tabs) {
  S.useApp.setState({ kernel: 'ready', tabs, activeKey: tabs[0]?.key ?? null, split: null, view: 'chat' });
}

/** @brief 仓库里这个会话现在的样子。 */
const current = (key) => S.useApp.getState().tabs.find((tab) => tab.key === key);

/** @brief 一个可以从外面完成的 Promise。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** @brief 命令去掉值为 undefined 的字段（进程桥上不带它们），便于比较。 */
const plain = (command) => JSON.parse(JSON.stringify(command));

test('FS-12 loadTurnDiff sends snapshots.diff { sessionId, round, path }; a failure is Couldn’t load the diff',
  async () => {
    const tab = tabOf();
    useTabs(tab);
    bridge.reset(async () => ({ patch: '', binary: false, truncated: false, error: null }));
    assert.deepEqual(await W.loadTurnDiff(tab.key, 'u1', 'src/a.ts'),
      { state: 'empty', patch: null, note: 'No net changes in this turn.' });
    assert.deepEqual(bridge.commands, [{ type: 'snapshots.diff', sessionId: SESSION, round: 'u1', path: 'src/a.ts' }]);
    bridge.reset(async () => { throw new Error('The kernel stopped.'); });
    let result;
    const logs = await quietErrors(async () => { result = await W.loadTurnDiff(tab.key, 'u1', 'src/a.ts'); });
    assert.deepEqual(result, { state: 'error', patch: null, note: 'Couldn’t load the diff: The kernel stopped.' });
    assert.deepEqual(logs, ['[renderer] snapshots.diff failed: The kernel stopped.']);
    const closed = tabOf(M.emptyTranscript, { sessionId: null });
    useTabs(closed);
    bridge.reset();
    assert.equal(await W.loadTurnDiff(closed.key, 'u1', 'a.ts'), null);
    assert.deepEqual(bridge.commands, []);
  });

// ---- 消息上的 Rewind（§5.5） ----

test('FS-15 rewindButton: none for [Mori] deliveries, pending messages, no entry id, closed sessions, git not ok',
  () => {
    const tab = tabOf(transcriptOf([user('u1')]));
    assert.deepEqual(RW.rewindButton(tab, user('u1')), { disabled: false, title: 'Rewind to before this message' });
    assert.equal(RW.rewindButton(tab, wake('u2')), null);
    assert.equal(RW.rewindButton(tab, reply('a1')), null);
    assert.equal(RW.rewindButton(tab, user('u3', 'Sending', { pending: true })), null);
    assert.equal(RW.rewindButton(tab, user(null)), null);
    assert.equal(RW.rewindButton({ ...tab, sessionId: null }, user('u1')), null);
    // 第一份 git 状态到之前（fs-checks.md 第 8 条）、没装 git、git 太低：都没有 Rewind
    assert.equal(RW.rewindButton({ ...tab, workspace: null }, user('u1')), null);
    assert.equal(RW.rewindButton({ ...tab, workspace: status({ git: { state: 'missing' }, repo: null }) },
      user('u1')), null);
    assert.equal(RW.rewindButton({ ...tab, workspace: status({ git: { state: 'old', version: '2.31.0' } }) },
      user('u1')), null);
    assert.equal(RW.REWIND_TITLE, 'Rewind to before this message');
  });

test('FS-15 rewindButton is disabled with Still running while anything runs, including only background agents',
  () => {
    const base = tabOf(transcriptOf([user('u1')]));
    const busy = [
      { ...base, team: { ...base.team, busy: true } },
      { ...base, team: { ...base.team, background: true } },
      { ...base, transcript: { ...base.transcript, running: true } },
      { ...base, transcript: { ...base.transcript, sending: true } },
      { ...base, transcript: { ...base.transcript, deciding: { role: 'mori', since: NOW, queue: [
        { text: 'Next', behavior: null }] } } },
      { ...base, rewind: { progress: 'rewind', conflicts: null, error: null } },
      { ...base, rewind: { progress: 'undo', conflicts: null, error: null } },
    ];
    for (const tab of busy) {
      assert.deepEqual(RW.rewindButton(tab, user('u1')), { disabled: true, title: 'Still running' });
      assert.equal(RW.rewindBusy(tab), true);
    }
    assert.equal(RW.rewindBusy(base), false);
    assert.equal(RW.STILL_RUNNING, 'Still running');
  });

/** @brief 菜单各行：[id, 文字, 不可选]。 */
const menuRows = (menu) => menu.items.map((item) => [item.id, item.label, item.disabled]);

/** 菜单四种情况的会话：u1 有 run 与改动，u2 是排队的消息（没有 run，之后有改动），u3 有 run、之后没有改动 */
function menuTab() {
  const items = [user('u1'), reply('a1'), user('u2'), reply('a2'), user('u3'), reply('a3'), user('u4')];
  const records = turnChanges(run('u1'), changes('u1', [cf('a.ts', 'M', 1, 0)]),
    changes('u2', [cf('b.ts', 'M', 1, 0)]), run('u3'));
  return tabOf(transcriptOf(items, records));
}

test('FS-15 rewindMenu with a code restore and changes after: the three restores and Never mind', () => {
  const menu = RW.rewindMenu(menuTab(), 'u1');
  assert.deepEqual(menuRows(menu), [
    ['code-conversation', 'Restore code and conversation', false],
    ['conversation', 'Restore conversation', false],
    ['code', 'Restore code', false],
    ['cancel', 'Never mind', false],
  ]);
  assert.equal(menu.blocked, null);
});

test('FS-15 rewindMenu with a code restore and nothing changed after: Restore conversation and Never mind', () => {
  assert.deepEqual(menuRows(RW.rewindMenu(menuTab(), 'u3')), [
    ['conversation', 'Restore conversation', false],
    ['cancel', 'Never mind', false],
  ]);
});

test('FS-15 rewindMenu for a queued or steered message (no run record) with changes after: No code restore', () => {
  assert.deepEqual(menuRows(RW.rewindMenu(menuTab(), 'u2')), [
    ['conversation', 'Restore conversation', false],
    ['no-code', 'No code restore', true],
    ['cancel', 'Never mind', false],
  ]);
});

test('FS-15 rewindMenu with no code restore and nothing after: Restore conversation and Never mind', () => {
  assert.deepEqual(menuRows(RW.rewindMenu(menuTab(), 'u4')), [
    ['conversation', 'Restore conversation', false],
    ['cancel', 'Never mind', false],
  ]);
  assert.deepEqual({ ...RW.REWIND_LABELS }, { 'code-conversation': 'Restore code and conversation',
    conversation: 'Restore conversation', code: 'Restore code', 'no-code': 'No code restore', cancel: 'Never mind' });
});

test('FS-15 rewindMenu counts the changes records of your messages after M as changes after (M has none of its own)',
  () => {
    // u1、u2 各有 run 记录，只有 u2 那一轮改了文件；u0 是排队的消息（没有 run）
    const items = [user('u0'), user('u1'), reply('a1'), user('u2'), reply('a2')];
    const tab = tabOf(transcriptOf(items, turnChanges(run('u1'), run('u2'), changes('u2', [cf('a.ts', 'M', 1, 0)]))));
    assert.deepEqual(menuRows(RW.rewindMenu(tab, 'u1')), [
      ['code-conversation', 'Restore code and conversation', false],
      ['conversation', 'Restore conversation', false],
      ['code', 'Restore code', false],
      ['cancel', 'Never mind', false],
    ]);
    assert.deepEqual(menuRows(RW.rewindMenu(tab, 'u0')), [
      ['conversation', 'Restore conversation', false],
      ['no-code', 'No code restore', true],
      ['cancel', 'Never mind', false],
    ]);
    // 中间隔着一条 [Mori] 投递时，u3 那一轮的改动照样算 u1 之后
    const delivered = tabOf(transcriptOf([user('u1'), reply('a1'), wake('w1'), reply('a2'), user('u3')],
      turnChanges(run('u1'), changes('u3', [cf('b.ts', 'A', 2, 0)]))));
    assert.deepEqual(menuRows(RW.rewindMenu(delivered, 'u1')).map((row) => row[0]),
      ['code-conversation', 'conversation', 'code', 'cancel']);
  });

/** 需求的会话：u1 之后登记 1（开着），u2 之后在立项工具卡下登记 3（开着）、单独一行登记 2（已完成） */
function blockedTab() {
  const tool = { ...M.newTool('t1', 'request_submit'), status: 'done', receipts: [receipt('registered', 3).receipt] };
  const items = [user('u1'), reply('a1'), receipt('registered', 1), user('u2'),
    reply('a2', [{ type: 'tool', id: 't1' }]), receipt('registered', 2), receipt('added', 1), user('u3')];
  const records = turnChanges(run('u1'), changes('u1', [cf('a.ts', 'M', 1, 0)]), run('u2'),
    changes('u2', [cf('b.ts', 'M', 1, 0)]), run('u3'), changes('u3', [cf('c.ts', 'M', 1, 0)]));
  const transcript = transcriptOf(items, records, { tools: { t1: tool } });
  return tabOf(transcript, { board: { requests: [request(1, 'open'), request(2, 'done'), request(3, 'open')] } });
}

test('FS-18 open requests registered at or after the message block both conversation restores; Restore code stays',
  () => {
    const tab = blockedTab();
    const first = RW.rewindMenu(tab, 'u1');
    assert.deepEqual(menuRows(first), [
      ['code-conversation', 'Restore code and conversation', true],
      ['conversation', 'Restore conversation', true],
      ['code', 'Restore code', false],
      ['cancel', 'Never mind', false],
    ]);
    assert.deepEqual(first.blocked, { requests: [1, 3], text: 'Requests 1 and 3 are still open. The conversation '
      + 'can’t go back to before they were registered.' });
    assert.deepEqual(RW.rewindMenu(tab, 'u2').blocked, { requests: [3], text: 'Request 3 is still open. The '
      + 'conversation can’t go back to before it was registered.' });
    const last = RW.rewindMenu(tab, 'u3');
    assert.equal(last.blocked, null);
    assert.ok(last.items.every((item) => !item.disabled));
    const noCode = { ...tab, transcript: { ...tab.transcript, turnChanges: turnChanges(changes('u1', [
      cf('a.ts', 'M', 1, 0)])) } };
    assert.deepEqual(menuRows(RW.rewindMenu(noCode, 'u1')), [
      ['conversation', 'Restore conversation', true],
      ['no-code', 'No code restore', true],
      ['cancel', 'Never mind', false],
    ]);
  });

test('FS-18 blockedText for one, two and three open requests (Oxford comma for three or more)', () => {
  assert.equal(RW.blockedText([4]),
    'Request 4 is still open. The conversation can’t go back to before it was registered.');
  assert.equal(RW.blockedText([1, 3]),
    'Requests 1 and 3 are still open. The conversation can’t go back to before they were registered.');
  assert.equal(RW.blockedText([1, 2, 3]),
    'Requests 1, 2, and 3 are still open. The conversation can’t go back to before they were registered.');
  assert.equal(RW.blockedText([2, 5, 7, 9]),
    'Requests 2, 5, 7, and 9 are still open. The conversation can’t go back to before they were registered.');
});

// ---- 通知与 Undo（§5.9） ----

/** @brief 末尾是一条恢复了代码的 Rewind 通知的会话；after 是通知之后的项。 */
function undoTab(record = rewindRecord(), after = [], fields = {}) {
  const item = notice('rw1', record);
  return { tab: tabOf(transcriptOf([user('u1'), reply('a1'), item, ...after]), fields), item };
}

test('FS-19 undoOffer: offered on the last code rewind with both snapshots; disabled with Still running while busy',
  () => {
    const { tab, item } = undoTab();
    assert.deepEqual(RW.undoOffer(tab, item), { disabled: false, title: null });
    const both = undoTab(rewindRecord({ conversation: true, from: 'a1' }));
    assert.deepEqual(RW.undoOffer(both.tab, both.item), { disabled: false, title: null });
    const busy = { ...tab, team: { ...tab.team, background: true } };
    assert.deepEqual(RW.undoOffer(busy, item), { disabled: true, title: 'Still running' });
    const undoing = { ...tab, rewind: { progress: 'undo', conflicts: null, error: null } };
    assert.deepEqual(RW.undoOffer(undoing, item), { disabled: true, title: 'Still running' });
    assert.equal(RW.undoOffer(tab, user('u1')), null);
  });

test('FS-19 undoOffer: none for conversation-only rewinds, a missing safety or post snapshot, undo records, git not '
  + 'ok, a closed session', () => {
  const none = (record, fields) => {
    const { tab, item } = undoTab(record, [], fields);
    return RW.undoOffer(tab, item);
  };
  assert.equal(none(rewindRecord({ code: false, conversation: true, safety: null, post: null })), null);
  assert.equal(none(rewindRecord({ safety: null })), null);
  // 恢复后快照 Q 没拍成（fs-checks.md 第 5 条）：照样有记录、post 为 null，没有 Undo
  assert.equal(none(rewindRecord({ post: null })), null);
  assert.equal(none(rewindRecord({ kind: 'undo', target: 'rw0', turn: null })), null);
  assert.equal(none(rewindRecord(), { workspace: null }), null);
  assert.equal(none(rewindRecord(), { workspace: status({ git: { state: 'missing' }, repo: null }) }), null);
  assert.equal(none(rewindRecord(), { sessionId: null }), null);
});

test('FS-19 undoOffer: none after another rewind, after its undo, or after any user, [Mori] or assistant item; other '
  + 'rows keep it', () => {
  const newer = notice('rw2', rewindRecord({ target: 'u1' }));
  const first = undoTab(rewindRecord(), [newer]);
  assert.equal(RW.undoOffer(first.tab, first.item), null);
  assert.deepEqual(RW.undoOffer(first.tab, newer), { disabled: false, title: null });
  const undone = notice('rw3', rewindRecord({ kind: 'undo', target: 'rw1', turn: null }));
  const withUndo = undoTab(rewindRecord(), [undone]);
  assert.equal(RW.undoOffer(withUndo.tab, withUndo.item), null);
  assert.equal(RW.undoOffer(withUndo.tab, undone), null);
  for (const next of [user('u9'), wake('u9'), reply('a9')]) {
    const { tab, item } = undoTab(rewindRecord(), [next]);
    assert.equal(RW.undoOffer(tab, item), null, next.kind);
  }
  const kept = undoTab(rewindRecord(), [receipt('registered', 1), { kind: 'note', key: 'note-1', text: 'Restarted' }]);
  assert.deepEqual(RW.undoOffer(kept.tab, kept.item), { disabled: false, title: null });
});

test('FS-19 rewindNotice texts for the three restores and Rewind undone, with Skipped and Couldn’t restore counts',
  () => {
    const text = (fields) => RW.rewindNotice(rewindRecord({ turn: 3, ...fields }));
    assert.deepEqual(text({ conversation: true }),
      { text: 'Restored code and conversation to before turn 3', skipped: null, failed: null });
    assert.deepEqual(text({}), { text: 'Restored code to before turn 3', skipped: null, failed: null });
    assert.deepEqual(text({ code: false, conversation: true, safety: null, post: null }),
      { text: 'Restored conversation to before turn 3', skipped: null, failed: null });
    assert.deepEqual(text({ kind: 'undo', turn: null, target: 'rw1' }),
      { text: 'Rewind undone', skipped: null, failed: null });
    const one = text({ counts: { restored: 1, deleted: 0, skipped: 1, failed: 1 } });
    assert.deepEqual([one.skipped, one.failed], ['Skipped 1 file', 'Couldn’t restore 1 file']);
    const many = text({ counts: { restored: 0, deleted: 0, skipped: 1234, failed: 2 } });
    assert.deepEqual([many.skipped, many.failed], ['Skipped 1,234 files', 'Couldn’t restore 2 files']);
    const undoSkipped = text({ kind: 'undo', turn: null, counts: { restored: 0, deleted: 0, skipped: 2, failed: 0 } });
    assert.deepEqual(undoSkipped, { text: 'Rewind undone', skipped: 'Skipped 2 files', failed: null });
  });

test('FS-24 progressText and the conflict dialog texts', () => {
  assert.equal(RW.progressText('rewind'), 'Rewinding…');
  assert.equal(RW.progressText('undo'), 'Undoing…');
  assert.equal(RW.CONFLICTS_TITLE, 'Restore these files anyway?');
  assert.equal(RW.conflictsDescription('rewind'), 'These files changed after this session’s last snapshot, or while '
    + 'another session was running in this folder. Restoring them discards those changes.');
  assert.equal(RW.conflictsDescription('undo'),
    'These files changed after the rewind. Undoing it discards those changes.');
  assert.deepEqual({ ...RW.CONFLICT_REASONS },
    { changed: 'Changed since the last snapshot', overlap: 'Another session was running' });
  assert.equal(RW.conflictsPendingText('rewind'), 'Restoring…');
  assert.equal(RW.conflictsPendingText('undo'), 'Undoing…');
});

test('FS-24 conflictsMore writes "and {n} more" only when total is larger than the listed conflicts', () => {
  const listed = Array.from({ length: 200 }, (_unused, index) => ({ path: `f${index}.ts`, reason: 'changed' }));
  const dialog = (conflicts, total) => ({ request: { kind: 'rewind', entryId: 'u1', code: true, conversation: false },
    conflicts, total, token: '0123456789abcdef', pending: null });
  assert.equal(RW.conflictsMore(dialog(listed, 1500)), 'and 1,300 more');
  assert.equal(RW.conflictsMore(dialog(listed, 201)), 'and 1 more');
  assert.equal(RW.conflictsMore(dialog(listed, 200)), null);
  assert.equal(RW.conflictsMore(dialog(listed.slice(0, 3), 3)), null);
});

// ---- 轮编号（§5.3）：右栏、Rewind 通知与会话引用共用 ----

/** 当前分支：一条投递在任何你的消息之前，u2 是程序投递（mori.wake 指向它），u3 之后是你的第二条消息 */
function deliveryEntries() {
  return [
    messageEntry('u0', 'user', '[Mori] Request 9 closed. Tell the user.'),
    customEntry('w0', 'mori.wake', { messageId: 'u0', kind: 'request_closed' }),
    messageEntry('a0', 'assistant', said('Request 9 is done.')),
    messageEntry('u1', 'user', 'First question'), messageEntry('a1', 'assistant', said('Answer one')),
    messageEntry('u2', 'user', WAKE_TEXT), customEntry('w2', 'mori.wake', { messageId: 'u2', kind: 'request_closed' }),
    messageEntry('a2', 'assistant', said('Request 1 is closed.')),
    messageEntry('u3', 'user', 'Second question'), messageEntry('a3', 'assistant', said('Answer two')),
  ];
}

test('FS-12 turnNumbers skips messages a mori.wake points to; sessionTurns uses the same Turn numbers and keeps the '
  + 'delivery lines in the turn before', () => {
  const entries = deliveryEntries();
  assert.deepEqual([...M.turnNumbers(entries)], [['u1', 1], ['u3', 2]]);
  const turns = R.sessionRefs.sessionTurns(entries, CWD);
  assert.deepEqual(turns, [
    { number: 1, entryId: 'u1', text: ['User: First question', 'Assistant: Answer one', `User: ${WAKE_TEXT}`,
      'Assistant: Request 1 is closed.'].join('\n') },
    { number: 2, entryId: 'u3', text: 'User: Second question\nAssistant: Answer two' },
  ]);
  const malformed = [...entries, customEntry('w9', 'mori.wake', { messageId: '' })];
  let numbers;
  const logs = quietErrors(() => { numbers = M.turnNumbers(malformed); });
  assert.deepEqual([...numbers], [['u1', 1], ['u3', 2]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[renderer\] ignored a malformed mori\.wake entry: /);
});

/** @brief 依次归并一组事件。 */
const play = (state, events, now = NOW) => events.reduce((next, event) => R.transcript.applyEvent(next, event, now),
  state);
/** @brief 你的一条消息开始（message_start）与它补发的条目 id。 */
const userEvents = (entryId, text, time) => [
  { type: 'message_start', message: { role: 'user', content: text, timestamp: time } },
  { type: 'mori.entry_id', role: 'user', entryId, time, refs: null },
];

test('FS-12 transcriptTurns on the reopened and the live transcript gives the turnNumbers numbering', () => {
  const entries = deliveryEntries();
  const reopened = R.history.transcriptFromEntries(entries);
  assert.deepEqual([...M.transcriptTurns(reopened.items)], [...M.turnNumbers(entries)]);
  const live = play(M.emptyTranscript, [
    ...userEvents('u1', 'First question', 1), { type: 'mori.wake', text: WAKE_TEXT, kind: 'request_closed' },
    ...userEvents('u2', WAKE_TEXT, 2), ...userEvents('u3', 'Second question', 3)]);
  assert.deepEqual(live.items.map((item) => item.kind), ['user', 'wake', 'user']);
  assert.deepEqual([...M.transcriptTurns(live.items)], [['u1', 1], ['u3', 2]]);
  const pending = M.addPendingPrompt(live, 'Third question', []);
  assert.deepEqual([...M.transcriptTurns(pending.items)], [['u1', 1], ['u3', 2]]);
  // 还没拿到条目 id 的消息不在表里，但照样占一个编号
  const gap = [user('u1'), user(null), user('u3')];
  assert.deepEqual([...M.transcriptTurns(gap)], [['u1', 1], ['u3', 3]]);
});

// ---- 事件与重新打开（§4.5、§4.6、§5.9） ----

test('FS-12 applyEvent records mori.turn_changes once per entry id, in order; a run record is kept too', () => {
  const first = run('u1');
  const second = changes('u1', [cf('a.ts', 'M', 1, 0)]);
  const state = play(M.emptyTranscript, [
    { type: 'mori.turn_changes', entryId: 'tc1', record: first },
    { type: 'mori.turn_changes', entryId: 'tc2', record: second },
    { type: 'mori.turn_changes', entryId: 'tc2', record: second },
  ]);
  assert.deepEqual(state.turnChanges, [{ entryId: 'tc1', record: first }, { entryId: 'tc2', record: second }]);
  assert.deepEqual(state.items, []);
});

test('FS-19 applyEvent adds the mori.rewind notice at the end; a warning for the same entry only updates it', () => {
  const record = rewindRecord({ conversation: false });
  const start = transcriptOf([user('u1'), reply('a1')]);
  const added = play(start, [{ type: 'mori.rewind', entryId: 'rw1', record }]);
  const last = added.items.at(-1);
  assert.deepEqual({ ...last, key: null }, { kind: 'rewind', key: null, entryId: 'rw1', record, warning: null });
  assert.equal(play(added, [{ type: 'mori.rewind', entryId: 'rw1', record }]).items.length, added.items.length);
  const warning = 'Couldn’t restore the conversation: This message has no reply to rewind.';
  const warned = R.transcript.addRewindNotice(added, 'rw1', record, warning);
  assert.equal(warned.items.length, added.items.length);
  assert.equal(warned.items.at(-1).warning, warning);
  assert.equal(warned.items.at(-1).key, last.key);
  assert.equal(R.transcript.addRewindNotice(warned, 'rw1', record, null), warned);
});

test('FS-10 mori.snapshot_stage shows Taking a snapshot… from its start until it ends or agent_start', () => {
  const started = R.transcript.applyEvent(M.emptyTranscript, { type: 'mori.snapshot_stage', active: true }, 1000);
  assert.deepEqual(started.modelStage, { kind: 'snapshot', since: 1000, text: 'Taking a snapshot…' });
  const again = R.transcript.applyEvent(started, { type: 'mori.snapshot_stage', active: true }, 4000);
  assert.equal(again.modelStage.since, 1000);
  assert.equal(R.transcript.applyEvent(again, { type: 'mori.snapshot_stage', active: false }, 5000).modelStage, null);
  const running = R.transcript.applyEvent({ ...started, sending: true }, { type: 'agent_start' }, 2000);
  assert.equal(running.modelStage, null);
  assert.equal(running.running, true);
  const waiting = { ...M.emptyTranscript, modelStage: { kind: 'wait-model', since: 10, text: 'Waiting for a model' } };
  const other = R.transcript.applyEvent(waiting, { type: 'mori.snapshot_stage', active: false }, 20);
  assert.deepEqual(other.modelStage, waiting.modelStage);
});

test('FS-12 history loads mori.turn_changes and mori.rewind on reopen like the live events; malformed entries are '
  + 'skipped', () => {
  const runU1 = run('u1');
  const changesU1 = changes('u1', [cf('a.ts', 'M', 2, 0)]);
  const record = rewindRecord();
  const entries = [messageEntry('u1', 'user', 'Edit a.ts'), messageEntry('a1', 'assistant', said('Edited.')),
    customEntry('tc1', 'mori.turn_changes', runU1), customEntry('tc2', 'mori.turn_changes', changesU1),
    customEntry('tc3', 'mori.turn_changes', { v: 2, kind: 'run', round: 'u1' }),
    customEntry('rw1', 'mori.rewind', record), customEntry('rw2', 'mori.rewind', { v: 1, kind: 'redo' })];
  let reopened;
  const logs = quietErrors(() => { reopened = R.history.transcriptFromEntries(entries); });
  assert.deepEqual(reopened.turnChanges, [{ entryId: 'tc1', record: runU1 }, { entryId: 'tc2', record: changesU1 }]);
  assert.deepEqual(reopened.items.map((item) => item.kind), ['user', 'assistant', 'rewind']);
  const item = reopened.items.at(-1);
  assert.deepEqual([item.entryId, item.record, item.warning], ['rw1', record, null]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^\[renderer\] ignored a malformed mori\.turn_changes entry: /);
  assert.match(logs[1], /^\[renderer\] ignored a malformed mori\.rewind entry: /);
  const live = play(R.history.transcriptFromEntries(entries.slice(0, 2)), [
    { type: 'mori.turn_changes', entryId: 'tc1', record: runU1 },
    { type: 'mori.turn_changes', entryId: 'tc2', record: changesU1 },
    { type: 'mori.rewind', entryId: 'rw1', record }]);
  assert.deepEqual(live.turnChanges, reopened.turnChanges);
  assert.deepEqual({ ...live.items.at(-1), key: null }, { ...item, key: null });
  const tab = tabOf(reopened);
  assert.deepEqual(RW.undoOffer(tab, item), { disabled: false, title: null });
  assert.deepEqual(menuRows(RW.rewindMenu(tab, 'u1')).map((row) => row[0]),
    ['code-conversation', 'conversation', 'code', 'cancel']);
});

// ---- 发命令与动作记录（§3.5、§5.6–§5.11，FS-24） ----

let markSeq = 0;
/** @brief 在动作记录里放一个记号，返回读出记号之后各条的函数。 */
function actionsAfterMark() {
  const mark = `test mark ${++markSeq}`;
  R.actionLog.recordAction(mark);
  return () => {
    const texts = R.actionLog.recentActions().map((action) => action.text);
    return texts.slice(texts.lastIndexOf(mark) + 1);
  };
}

test('FS-24 the step-2 commands are not recorded as commands (the actions are recorded by what you did)', () => {
  const commands = [{ type: 'workspace.status', sessionId: SESSION },
    { type: 'snapshots.diff', sessionId: SESSION, round: 'u1', path: 'a.ts' },
    { type: 'snapshots.drop', sessionId: SESSION, cwd: CWD },
    { type: 'rewind', sessionId: SESSION, entryId: 'u1', code: true, conversation: true },
    { type: 'rewind.undo', sessionId: SESSION, undoId: 'rw1' }];
  for (const command of commands) assert.equal(R.actionLog.describeCommand(command), null, command.type);
});

test('FS-24 Refresh records Refresh changes, spins until workspace.status returns and ignores a second click',
  async () => {
    const tab = tabOf(M.emptyTranscript, { workspace: status({ at: 100 }) });
    useTabs(tab);
    const reply1 = deferred();
    bridge.reset(() => reply1.promise);
    const actions = actionsAfterMark();
    const pending = W.refreshChanges(tab.key);
    assert.equal(current(tab.key).refreshing, true);
    await W.refreshChanges(tab.key);
    assert.deepEqual(bridge.commands, [{ type: 'workspace.status', sessionId: SESSION }]);
    assert.equal(current(tab.key).workspace.at, 100);
    reply1.resolve(status({ at: 200, files: [sfile('a.ts', 'unstaged', 'M')], total: 1 }));
    await pending;
    assert.equal(current(tab.key).refreshing, false);
    assert.equal(current(tab.key).workspace.at, 200);
    assert.deepEqual(actions(), ['Refresh changes']);
    bridge.reset(async () => { throw new Error('git crashed'); });
    const logs = await quietErrors(() => W.refreshChanges(tab.key));
    assert.deepEqual(logs, ['[renderer] workspace.status failed: git crashed']);
    assert.equal(current(tab.key).refreshing, false);
    assert.equal(current(tab.key).workspace.at, 200);
  });

test('FS-13 requestStatus and Refresh send nothing while the kernel or the session is not ready', async () => {
  const opening = tabOf(M.emptyTranscript, { phase: 'opening' });
  useTabs(opening);
  bridge.reset(async () => status());
  await W.requestStatus(opening.key);
  await W.refreshChanges(opening.key);
  S.useApp.setState({ kernel: 'reloading', tabs: [tabOf()] });
  const reloading = S.useApp.getState().tabs[0];
  await W.requestStatus(reloading.key);
  assert.deepEqual(bridge.commands, []);
  useTabs(tabOf(M.emptyTranscript, { workspace: null }));
  const ready = S.useApp.getState().tabs[0];
  await W.requestStatus(ready.key);
  assert.deepEqual(bridge.commands, [{ type: 'workspace.status', sessionId: SESSION }]);
  assert.equal(current(ready.key).workspace.at, NOW);
});

test('FS-24 a menu choice records Rewind: <item> and sends rewind; Rewinding… while it runs; Never mind only records',
  async () => {
    const tab = menuTab();
    useTabs(tab);
    const answer = deferred();
    bridge.reset(() => answer.promise);
    const actions = actionsAfterMark();
    const pending = RW.rewindTo(tab.key, 'u1', 'code');
    assert.deepEqual(current(tab.key).rewind, { progress: 'rewind', conflicts: null, error: null });
    assert.equal(RW.rewindButton(current(tab.key), tab.transcript.items[0]).disabled, true);
    // 进行中再选菜单里的一项：什么都不发、不记
    await RW.rewindTo(tab.key, 'u3', 'conversation');
    await RW.rewindTo(tab.key, 'u1', 'code-conversation');
    assert.equal(bridge.commands.length, 1);
    const record = rewindRecord();
    answer.resolve({ kind: 'done', entryId: 'rw1', record, editorText: null, refs: null, entries: null,
      warning: null });
    await pending;
    assert.deepEqual(bridge.commands.map(plain),
      [{ type: 'rewind', sessionId: SESSION, entryId: 'u1', code: true, conversation: false }]);
    const after = current(tab.key);
    assert.deepEqual(after.rewind, { progress: null, conflicts: null, error: null });
    assert.deepEqual([after.transcript.items.at(-1).kind, after.transcript.items.at(-1).entryId], ['rewind', 'rw1']);
    assert.equal(after.draft, '');
    RW.neverMind();
    assert.deepEqual(actions(), ['Rewind: Restore code', 'Rewind: Never mind']);
  });

test('FS-24 conflicts: Overwrite and Skip these files resend with the token; Cancel closes; each is recorded',
  async () => {
    const tab = menuTab();
    useTabs(tab);
    const conflicts = [{ path: 'a.ts', reason: 'changed' }, { path: 'b.ts', reason: 'overlap' }];
    const results = [{ kind: 'conflicts', conflicts, total: 2, token: 'token-one' },
      { kind: 'conflicts', conflicts: conflicts.slice(0, 1), total: 1, token: 'token-two' }];
    const second = deferred();
    bridge.reset(async () => results.shift() ?? second.promise);
    const actions = actionsAfterMark();
    await RW.rewindTo(tab.key, 'u1', 'code-conversation');
    const request1 = { kind: 'rewind', entryId: 'u1', code: true, conversation: true };
    assert.deepEqual(current(tab.key).rewind, { progress: null, error: null,
      conflicts: { request: request1, conflicts, total: 2, token: 'token-one', pending: null } });
    await RW.resolveConflicts(tab.key, 'overwrite');
    assert.equal(current(tab.key).rewind.conflicts.token, 'token-two');
    const pending = RW.resolveConflicts(tab.key, 'skip');
    assert.equal(current(tab.key).rewind.conflicts.pending, 'skip');
    assert.equal(current(tab.key).rewind.progress, 'rewind');
    // 第二次调用进行中三个按钮都不可用：再点 Overwrite、Cancel 什么都不做（不发、不记、对话框不关）
    await RW.resolveConflicts(tab.key, 'overwrite');
    RW.cancelConflicts(tab.key);
    assert.deepEqual([current(tab.key).rewind.conflicts?.pending, current(tab.key).rewind.conflicts?.token],
      ['skip', 'token-two']);
    assert.equal(bridge.commands.length, 3);
    second.resolve({ kind: 'done', entryId: 'rw1', record: rewindRecord({ conversation: false }), editorText: null,
      refs: null, entries: null, warning: null });
    await pending;
    const sent = bridge.commands.map(plain).map((command) => command.conflictChoice ?? null);
    assert.deepEqual(sent,
      [null, { action: 'overwrite', token: 'token-one' }, { action: 'skip', token: 'token-two' }]);
    assert.equal(current(tab.key).rewind.conflicts, null);
    assert.deepEqual(actions(), ['Rewind: Restore code and conversation', 'Rewind conflicts: Overwrite',
      'Rewind conflicts: Skip these files']);
  });

test('FS-24 Cancel in the conflict dialog records Rewind conflicts: Cancel and changes nothing', async () => {
  const tab = menuTab();
  useTabs(tab);
  bridge.reset(async () => ({ kind: 'conflicts', conflicts: [{ path: 'a.ts', reason: 'changed' }], total: 1,
    token: 'token-one' }));
  const actions = actionsAfterMark();
  await RW.rewindTo(tab.key, 'u1', 'code');
  RW.cancelConflicts(tab.key);
  assert.deepEqual(current(tab.key).rewind, { progress: null, conflicts: null, error: null });
  assert.equal(current(tab.key).transcript, tab.transcript);
  assert.equal(bridge.commands.length, 1);
  assert.deepEqual(actions(), ['Rewind: Restore code', 'Rewind conflicts: Cancel']);
});

test('FS-24 Undo records Undo rewind and sends rewind.undo; a disabled choice or a busy session sends nothing',
  async () => {
    const { tab } = undoTab();
    useTabs(tab);
    const answer = deferred();
    bridge.reset(() => answer.promise);
    const actions = actionsAfterMark();
    const pending = RW.undoRewind(tab.key, 'rw1');
    assert.equal(current(tab.key).rewind.progress, 'undo');
    // Undo 进行中再点 Undo、再选 Restore conversation（u1 平时可选）：什么都不发
    await RW.undoRewind(tab.key, 'rw1');
    await RW.rewindTo(tab.key, 'u1', 'conversation');
    assert.equal(bridge.commands.length, 1);
    answer.resolve({ kind: 'done', entryId: 'rw9', editorText: null, refs: null, entries: null, warning: null,
      record: rewindRecord({ kind: 'undo', target: 'rw1', turn: null }) });
    await pending;
    assert.deepEqual(bridge.commands.map(plain), [{ type: 'rewind.undo', sessionId: SESSION, undoId: 'rw1' }]);
    const items = current(tab.key).transcript.items;
    assert.equal(RW.rewindNotice(items.at(-1).record).text, 'Rewind undone');
    await RW.undoRewind(tab.key, 'rw1');
    const blocked = blockedTab();
    useTabs(blocked);
    await RW.rewindTo(blocked.key, 'u1', 'conversation');
    const menu = menuTab();
    useTabs(menu);
    await RW.rewindTo(menu.key, 'u2', 'code');
    await RW.rewindTo(menu.key, 'u3', 'code-conversation');
    const busy = { ...menu, team: { ...menu.team, mode: 'always', busy: true, background: true } };
    useTabs(busy);
    await RW.rewindTo(busy.key, 'u1', 'code');
    assert.equal(bridge.commands.length, 1);
    assert.deepEqual(actions(), ['Undo rewind']);
  });

test('FS-18 a done result with entries rebuilds the transcript, adds the notice and puts the text back before the '
  + 'draft', async () => {
  const tab = { ...menuTab(), draft: 'my draft' };
  useTabs(tab);
  const record = rewindRecord({ target: 'u2', turn: 2, conversation: true, from: 'a3' });
  const entries = [messageEntry('u1', 'user', 'Message u1'), messageEntry('a1', 'assistant', said('Done.')),
    customEntry('tc1', 'mori.turn_changes', run('u1')),
    customEntry('tc2', 'mori.turn_changes', changes('u1', [cf('a.ts', 'M', 1, 0)])),
    customEntry('rw1', 'mori.rewind', record)];
  const warning = 'Couldn’t restore the conversation: An extension cancelled moving the conversation.';
  bridge.reset(async () => ({ kind: 'done', entryId: 'rw1', record, editorText: 'Message u2', refs: null, entries,
    warning }));
  await RW.rewindTo(tab.key, 'u2', 'conversation');
  const after = current(tab.key);
  assert.deepEqual(after.transcript.items.map((item) => item.kind), ['user', 'assistant', 'rewind']);
  assert.equal(after.transcript.items.at(-1).warning, warning);
  assert.equal(after.transcript.turnChanges.length, 2);
  assert.equal(after.draft, 'Message u2\n\nmy draft');
  assert.deepEqual(W.turnGroups(after).map(groupTitle), ['Turn 1 · Message u1']);
  assert.deepEqual(plain(bridge.commands[0]),
    { type: 'rewind', sessionId: SESSION, entryId: 'u2', code: false, conversation: true });
});

/** @brief 恢复对话到 u4 之前的 done 结果：新的当前分支到 a3 为止，接着 mori.rewind。 */
function conversationDone(editorText, refs) {
  const record = rewindRecord({ target: 'u4', turn: 4, code: false, conversation: true, safety: null, post: null,
    from: 'a3', restored: [], counts: { restored: 0, deleted: 0, skipped: 0, failed: 0 } });
  const entries = [messageEntry('u3', 'user', 'Message u3'), messageEntry('a3', 'assistant', said('Done.')),
    customEntry('rw1', 'mori.rewind', record)];
  return { kind: 'done', entryId: 'rw1', record, editorText, refs, entries, warning: null };
}

test('FS-18 restoring the conversation puts the quote chips back and the text without quote blocks before the '
  + 'draft; a skill call goes back as /skill:<name> <args>', async () => {
  const ref = { quote: 'function parse() {}', source: { kind: 'file', path: `${CWD}\\src\\parse.ts`,
    sha256: '0'.repeat(64), startLine: 3, endLine: 3 } };
  const skill = '<skill name="review" location="C:\\skills\\review\\SKILL.md">\nReview carefully.\n</skill>'
    + '\n\nthe parser';
  const cases = [
    { editorText: R.quoteText.composePrompt([ref], 'Explain this', CWD), refs: [ref],
      draft: 'Explain this\n\nmine', chips: [ref] },
    { editorText: skill, refs: null, draft: '/skill:review the parser\n\nmine', chips: [] },
  ];
  for (const item of cases) {
    const tab = { ...menuTab(), draft: 'mine' };
    useTabs(tab);
    bridge.reset(async () => conversationDone(item.editorText, item.refs));
    await RW.rewindTo(tab.key, 'u4', 'conversation');
    const after = current(tab.key);
    assert.equal(after.draft, item.draft);
    assert.deepEqual(after.draftRefs, item.chips);
    assert.deepEqual(after.transcript.items.map((entry) => entry.kind), ['user', 'assistant', 'rewind']);
    assert.equal(RW.rewindNotice(after.transcript.items.at(-1).record).text,
      'Restored conversation to before turn 4');
  }
});

test('FS-24 Undo conflicts resend rewind.undo with the token; the pending button and the progress read Undoing…',
  async () => {
    const { tab } = undoTab();
    useTabs(tab);
    const conflicts = [{ path: 'a.ts', reason: 'changed' }];
    const results = [{ kind: 'conflicts', conflicts, total: 1, token: 'token-undo' }];
    const done = deferred();
    bridge.reset(async () => results.shift() ?? done.promise);
    const actions = actionsAfterMark();
    await RW.undoRewind(tab.key, 'rw1');
    const dialog = current(tab.key).rewind;
    assert.deepEqual(dialog, { progress: null, error: null, conflicts: { request: { kind: 'undo', undoId: 'rw1' },
      conflicts, total: 1, token: 'token-undo', pending: null } });
    assert.equal(RW.conflictsDescription(dialog.conflicts.request.kind),
      'These files changed after the rewind. Undoing it discards those changes.');
    const pending = RW.resolveConflicts(tab.key, 'skip');
    const during = current(tab.key).rewind;
    assert.deepEqual([during.progress, during.conflicts.pending], ['undo', 'skip']);
    assert.equal(RW.conflictsPendingText(during.conflicts.request.kind), 'Undoing…');
    assert.equal(RW.progressText(during.progress), 'Undoing…');
    done.resolve({ kind: 'done', entryId: 'rw9', record: rewindRecord({ kind: 'undo', target: 'rw1', turn: null }),
      editorText: null, refs: null, entries: null, warning: null });
    await pending;
    const undo = { type: 'rewind.undo', sessionId: SESSION, undoId: 'rw1' };
    assert.deepEqual(bridge.commands.map(plain),
      [undo, { ...undo, conflictChoice: { action: 'skip', token: 'token-undo' } }]);
    const after = current(tab.key);
    assert.deepEqual(after.rewind, { progress: null, conflicts: null, error: null });
    assert.equal(RW.rewindNotice(after.transcript.items.at(-1).record).text, 'Rewind undone');
    assert.deepEqual(actions(), ['Undo rewind', 'Rewind conflicts: Skip these files']);
  });

/** @brief 条目的 [kind, entryId]（比较两份对话流时不看界面的 key）。 */
const itemIds = (items) => items.map((item) => [item.kind, item.entryId ?? null]);

test('FS-19 an Undo that returned to the original branch rebuilds the transcript and keeps the draft; one that '
  + 'could not shows the warning on Rewind undone', async () => {
  const original = rewindRecord({ target: 'u2', turn: 2, conversation: true, from: 'a2' });
  const { tab } = undoTab(original);
  useTabs({ ...tab, draft: 'mine' });
  const undone = rewindRecord({ kind: 'undo', target: 'rw1', turn: null, conversation: true, from: 'rw1' });
  const entries = [...twoTurnEntries(), customEntry('rw9', 'mori.rewind', undone)];
  bridge.reset(async () => ({ kind: 'done', entryId: 'rw9', record: undone, editorText: null, refs: null, entries,
    warning: null }));
  await RW.undoRewind(tab.key, 'rw1');
  const back = current(tab.key);
  assert.deepEqual([back.draft, back.draftRefs], ['mine', []]);
  assert.deepEqual(itemIds(back.transcript.items), itemIds(R.history.transcriptFromEntries(entries).items));
  assert.deepEqual([back.transcript.items.at(-1).record.kind, back.transcript.items.at(-1).warning], ['undo', null]);
  assert.deepEqual(W.lineTotals(back.transcript), { added: 7, removed: 1 });
  // 对话回不去（Mori can’t return to where it was before the rewind.）：代码已回去，分支不变，警告在通知下一行
  useTabs({ ...tab, draft: 'mine' });
  const warning = 'Couldn’t restore the conversation: Mori can’t return to where it was before the rewind.';
  const codeOnly = rewindRecord({ kind: 'undo', target: 'rw1', turn: null });
  bridge.reset(async () => ({ kind: 'done', entryId: 'rw9', record: codeOnly, editorText: null, refs: null,
    entries: null, warning }));
  await RW.undoRewind(tab.key, 'rw1');
  const stayed = current(tab.key);
  assert.equal(stayed.draft, 'mine');
  assert.deepEqual(itemIds(stayed.transcript.items), [...itemIds(tab.transcript.items), ['rewind', 'rw9']]);
  assert.equal(stayed.transcript.items.at(-1).warning, warning);
  assert.equal(RW.rewindNotice(stayed.transcript.items.at(-1).record).text, 'Rewind undone');
});

test('FS-24 a kernel exit removes Rewinding…, the conflict dialog, the error line and the Refresh spinner', () => {
  const dialog = { request: { kind: 'rewind', entryId: 'u1', code: true, conversation: false },
    conflicts: [{ path: 'a.ts', reason: 'changed' }], total: 1, token: 'token-one', pending: 'skip' };
  const rewinding = { ...menuTab(), refreshing: true, rewind: { progress: 'rewind', conflicts: dialog, error: null } };
  const failed = { ...menuTab(), rewind: { progress: null, conflicts: null,
    error: { kind: 'undo', text: 'Couldn’t undo: This rewind can no longer be undone.' } } };
  useTabs(rewinding, failed);
  R.actions.handleKernelExit();
  assert.equal(S.useApp.getState().kernel, 'exited');
  for (const key of [rewinding.key, failed.key]) {
    const after = current(key);
    assert.deepEqual(after.rewind, { progress: null, conflicts: null, error: null });
    assert.equal(after.refreshing, false);
    assert.equal(RW.rewindButton(after, after.transcript.items[0]), null);
  }
  useTabs(menuTab());
});

/** @brief 侧栏里一个打开着的会话（有会话文件）。 */
const sessionRef = (tab) => ({ tabKey: tab.key, sessionFile: tab.sessionFile });

/** @brief 后台进程替身：session.close 与 snapshots.drop 照常，session.list 为空。 */
const removalHandler = async (command) => {
  if (command.type === 'session.list') return [];
  if (command.type === 'snapshots.drop') return { error: null };
  return undefined;
};

/** @brief 等已经排进去的异步步骤做完（loadSessions 与 snapshots.drop 不被等待）。 */
const settle = () => new Promise((done) => { setImmediate(done); });

test('FS-24 archiving or deleting a session that is rewinding is refused with This session is already rewinding.',
  async () => {
    for (const progress of ['rewind', 'undo']) {
      const tab = tabOf(M.emptyTranscript, { sessionFile: 'C:\\s\\one.jsonl',
        rewind: { progress, conflicts: null, error: null } });
      useTabs(tab);
      bridge.reset(removalHandler);
      for (const remove of [R.projects.archiveSession, R.projects.deleteSession]) {
        await assert.rejects(remove(sessionRef(tab)), { message: 'This session is already rewinding.' });
      }
      await settle();
      assert.deepEqual(bridge.commands, [], progress);
      assert.deepEqual(bridge.deletedFiles, []);
      assert.ok(current(tab.key), 'the session stays open');
    }
  });

test('FS-20 deleting a session sends snapshots.drop { sessionId, cwd } after the file is deleted; a failed delete '
  + 'and archiving do not', async () => {
  const file = 'C:\\s\\one.jsonl';
  const deleted = tabOf(M.emptyTranscript, { sessionFile: file });
  useTabs(deleted);
  bridge.reset(removalHandler);
  await R.projects.deleteSession(sessionRef(deleted));
  await settle();
  assert.deepEqual(bridge.deletedFiles, [file]);
  assert.deepEqual(plain(bridge.commands[0]), { type: 'session.close', sessionId: SESSION });
  assert.deepEqual(plain(bridge.commands.at(-1)), { type: 'snapshots.drop', sessionId: SESSION, cwd: CWD });
  assert.equal(current(deleted.key), undefined);
  const locked = tabOf(M.emptyTranscript, { sessionFile: file });
  useTabs(locked);
  bridge.reset(removalHandler);
  bridge.deleteFile = async () => ({ deleted: false, error: 'EBUSY: resource busy or locked' });
  await assert.rejects(R.projects.deleteSession(sessionRef(locked)), { message: 'EBUSY: resource busy or locked' });
  await settle();
  assert.deepEqual(bridge.deletedFiles, [file]);
  assert.ok(!bridge.commands.some((command) => command.type === 'snapshots.drop'));
  const archived = tabOf(M.emptyTranscript, { sessionFile: file });
  useTabs(archived);
  bridge.reset(removalHandler);
  await R.projects.archiveSession(sessionRef(archived));
  await settle();
  assert.deepEqual(bridge.commands.map((command) => command.type), ['session.close', 'session.list']);
});

test('FS-24 a refused rewind shows Couldn’t rewind: <message>; a refused undo shows Couldn’t undo: <message>',
  async () => {
    const tab = menuTab();
    useTabs(tab);
    bridge.reset(async () => { throw new Error('This session is already rewinding.'); });
    const logs = await quietErrors(() => RW.rewindTo(tab.key, 'u1', 'code'));
    assert.deepEqual(logs, ['[renderer] rewind failed: This session is already rewinding.']);
    assert.deepEqual(current(tab.key).rewind, { progress: null, conflicts: null,
      error: { kind: 'rewind', text: 'Couldn’t rewind: This session is already rewinding.' } });
    const { tab: undoable } = undoTab();
    useTabs(undoable);
    bridge.reset(async () => { throw new Error('This rewind can no longer be undone.'); });
    await quietErrors(() => RW.undoRewind(undoable.key, 'rw1'));
    assert.deepEqual(current(undoable.key).rewind.error,
      { kind: 'undo', text: 'Couldn’t undo: This rewind can no longer be undone.' });
    useTabs(menuTab());
    const exiting = S.useApp.getState().tabs[0];
    bridge.reset(async () => {
      S.useApp.setState({ kernel: 'exited' });
      throw new Error('The kernel exited.');
    });
    await quietErrors(() => RW.rewindTo(exiting.key, 'u1', 'code'));
    assert.deepEqual(current(exiting.key).rewind, { progress: null, conflicts: null, error: null });
  });

test('FS-23 handleEvent stores mori.workspace_status on the tab and a new changes record updates the totals', () => {
  const tab = tabOf(transcriptOf([user('u1')]), { workspace: status({ at: 100 }) });
  useTabs(tab);
  const envelope = (event) => ({ sessionId: SESSION, event });
  R.actions.handleEvent(envelope({ type: 'mori.workspace_status', status: status({ at: 300 }) }));
  assert.equal(current(tab.key).workspace.at, 300);
  R.actions.handleEvent(envelope({ type: 'mori.workspace_status', status: status({ at: 200 }) }));
  assert.equal(current(tab.key).workspace.at, 300);
  assert.equal(W.hasTurnChanges(current(tab.key)), false);
  R.actions.handleEvent(envelope({ type: 'mori.turn_changes', entryId: 'tc1',
    record: changes('u1', [cf('a.ts', 'M', 4, 2)]) }));
  assert.equal(W.hasTurnChanges(current(tab.key)), true);
  assert.deepEqual(W.lineTotals(current(tab.key).transcript), { added: 4, removed: 2 });
  assert.equal(W.linesShown(current(tab.key)), true);
});

test('FS-24 the error line goes away on the next rewind and on sending; a prompt refused while rewinding shows the '
  + 'kernel text', async () => {
  const failed = { progress: null, conflicts: null,
    error: { kind: 'rewind', text: 'Couldn’t rewind: This session is already rewinding.' } };
  const tab = { ...menuTab(), rewind: failed };
  useTabs(tab);
  const answer = deferred();
  bridge.reset(() => answer.promise);
  const pending = RW.rewindTo(tab.key, 'u1', 'code');
  assert.deepEqual(current(tab.key).rewind, { progress: 'rewind', conflicts: null, error: null });
  answer.resolve({ kind: 'conflicts', conflicts: [{ path: 'a.ts', reason: 'changed' }], total: 1, token: 't' });
  await pending;
  const refused = 'This session is rewinding. Send your message when it’s done.';
  const sending = { ...menuTab(), rewind: failed, draft: 'Next step' };
  useTabs(sending);
  bridge.reset(async () => { throw new Error(refused); });
  const logs = await quietErrors(() => R.actions.send(sending.key));
  assert.deepEqual(logs, [`[renderer] session.prompt failed: ${refused}`]);
  const after = current(sending.key);
  assert.equal(after.rewind.error, null);
  const last = after.transcript.items.at(-1);
  assert.deepEqual([last.kind, last.text, last.restore], ['error', refused, 'Next step']);
  assert.deepEqual(bridge.commands.map(plain), [{ type: 'session.prompt', sessionId: SESSION, text: 'Next step' }]);
});
