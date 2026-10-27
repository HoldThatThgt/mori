// Rewind 与 Undo 的单元测试（docs/specs/file-system.md §5.5–§5.11，验收 §19.2 FS-16、FS-17、FS-24 的单元层，
// 以及 FS-18、FS-19、FS-20、FS-25 在单元层能测的部分；负责人不在时定下的选择见 docs/v1/fs-checks.md #4–#6、#9–#11）。
// 真实 git、临时目录里 synthetic 的项目、注入的小上限（§19.1）；用户会话是替身（rewind-helpers.mjs）：内存里的 pi
// SessionManager，记录由真实的快照（mori-snapshots 注册在假 pi 上）写下；少数撤销用例的 mori.rewind、S6 那一轮的
// mori.turn_changes 是手写的（synthetic，标明；S6 的提交仍是真实快照）。用真实 git 的几个场景在开头同时开始（各用自己的
// 工作路径与会话，快照队列按工作路径分开），
// 测试再逐条断言；只在内存里移动对话、只检查拒绝的用例不拍快照，直接在测试里做。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAD_OPTION_ERROR, SMALL_LIMITS, assistantMessage, beforeNext, beginTurn, commitExists, content, contents,
  customEntries, deleteRef, drop, endTurn, failNextAdd, initUserRepo, internalRefs, keepRoundRefs, loadRewind, lockFile,
  names, openUser, piNavigate, present, project, put, repoState, settle, setupRewind, sh, shapes, snapshotNow, start,
  tempRoot, turn,
} from './rewind-helpers.mjs';

const K = await loadRewind();
const temp = tempRoot('mrw-');
setupRewind(K, join(temp.root, 's'));

/** 用过的工作路径：结束时先等它们的 git 状态读完（Rewind 之后的刷新还在跑），再删临时目录 */
const usedCwds = new Set();
after(async () => {
  await Promise.all([...usedCwds].map((cwd) => K.workspace.readStatus(cwd)));
  await temp.remove();
});

const TURN = 'mori.turn_changes';
const REWIND = 'mori.rewind';

/** @brief 规格里的原文（§5.5–§5.11、§4.7，fs-checks.md #4–#6、#9）。 */
const TEXT = Object.freeze({
  stillRunning: 'This session is still running. Stop it first.',
  already: 'This session is already rewinding.',
  rewindingPrompt: 'This session is rewinding. Send your message when it’s done.',
  nothing: 'Choose code, conversation or both to restore.',
  notIn: 'This message isn’t in the conversation.',
  noCode: 'This message has no code snapshot.',
  noUndo: 'This rewind can no longer be undone.',
  noReply: 'This message has no reply to rewind.',
  cancelled: 'An extension cancelled moving the conversation.',
  fileInWay: 'A file is in the way.',
  folderInWay: 'A folder is in the way.',
  pruned: 'Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.',
  snapshotFailed: 'Couldn’t take a snapshot: ',
  paused: 'Snapshots are paused for this folder, so code can’t be restored.',
  conversationFailed: 'Couldn’t restore the conversation: ',
  cantReturn: 'Mori can’t return to where it was before the rewind.',
});

/** @brief 一个场景的工作路径（记进 usedCwds）。 */
function folder(name, files) {
  const cwd = project(temp.root, name, files);
  usedCwds.add(cwd);
  return cwd;
}

/** @brief 只恢复代码的参数。 */
function codeOnly(entryId, conflictChoice) {
  return { entryId, code: true, conversation: false, ...(conflictChoice ? { conflictChoice } : {}) };
}

/** @brief 只恢复对话的参数。 */
function talkOnly(entryId) {
  return { entryId, code: false, conversation: true };
}

/** @brief §5.6 第 5 步的 token：按路径排序的全部冲突（原因与路径）的 SHA-1 前 16 位。 */
function tokenOf(conflicts) {
  const sorted = [...conflicts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = sorted.map((item) => `${item.reason}\t${item.path}`).join('\0');
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** @brief 同一种原因的几条冲突。 */
function listed(reason, ...paths) {
  return paths.map((path) => ({ path, reason }));
}

/** @brief 冲突的结果。 */
function conflictsResult(conflicts) {
  return { kind: 'conflicts', conflicts, total: conflicts.length, token: tokenOf(conflicts) };
}

/** @brief 这次 Rewind 的 ref 前缀（§4.7）。 */
function rewindRefs(user, entryId) {
  return `refs/mori/s/${user.sessionId}/rewind/${entryId}/`;
}

/** @brief 会话里的 changes 记录（全部条目）。 */
function changesOf(user) {
  return customEntries(user, TURN).map((entry) => entry.data).filter((record) => record.kind === 'changes');
}

/** @brief 记录里的文件路径。 */
function pathsOf(record) {
  return record.files.map((file) => file.path);
}

// ---- S1：一轮；另一个会话 B 在 Rewind 与 Undo 时运行，两次恢复中途它各写下一个文件；Rewind 时一个文件被锁住 ----

const S1_FILES = ['b.txt', 'c.txt', 'new.txt', 'locked.txt', 'own.txt', 'only-b.txt', 'b-during.txt', 'b-undo.txt'];

/**
 * @brief 在 Rewind 的第一个 git restore 之前：B 写下 b-during.txt（P→Q 之间别的会话的改动），用独占句柄锁住
 *        locked.txt；恢复后快照 Q 的 git add 之前放开（独占句柄连读也挡住，不放开 Q 就拍不成）。
 * @return 放开锁的函数（Rewind 返回后再调一次，防止钩子没触发时留着句柄）
 */
function lockDuringRestore(cwd) {
  let unlock = () => undefined;
  beforeNext(cwd, 'restore', () => {
    put(cwd, 'b-during.txt', 'during\n');
    unlock = lockFile(join(cwd, 'locked.txt'));
    beforeNext(cwd, 'add', () => {
      unlock();
    });
  });
  return () => unlock();
}

/**
 * @brief S1：A 的一轮改 b.txt、删 c.txt、建 new.txt、改 locked.txt；B 开始运行、独自写 only-b.txt，A Rewind，再 Undo
 *        （B 一直在运行：P→Q 这一段记给它）。
 */
async function restoreScenario() {
  const cwd = folder('r1', { 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'locked.txt': 'l0\n' });
  const a = openUser(K, cwd);
  const b = openUser(K, cwd);
  const m1 = await turn(K, a, 'Change the files', () => {
    put(cwd, 'b.txt', 'b1\n');
    drop(cwd, 'c.txt');
    put(cwd, 'new.txt', 'n1\n');
    put(cwd, 'locked.txt', 'l1\n');
  });
  put(cwd, 'own.txt', 'mine\n');
  const aRecordsBefore = customEntries(a, TURN).length;
  await beginTurn(b, 'Other work');
  put(cwd, 'only-b.txt', 'B-only\n');
  const unlock = lockDuringRestore(cwd);
  const result = await K.rewind.rewind(a.session, codeOnly(m1));
  unlock();
  const restored = { files: contents(cwd, S1_FILES), aRecords: customEntries(a, TURN).length };
  const refs = await internalRefs(K, cwd, rewindRefs(a, result.entryId));
  const commits = await Promise.all([result.record.safety, result.record.post].map((oid) => commitExists(K, cwd, oid)));
  const undos = await undoSteps(cwd, a, result);
  const run = customEntries(a, TURN).map((entry) => entry.data).find((record) => record.kind === 'run');
  await deleteRef(K, cwd, `refs/mori/s/${a.sessionId}/${m1}/${run.start}`);
  const pruned = await settle(K.rewind.rewind(a.session, codeOnly(m1)));
  return { a, b, m1, aRecordsBefore, result, restored, refs, commits, ...undos, pruned };
}

/**
 * @brief S1 的 Undo：撤销那次真实的 Rewind（记录的列表都列全，不重算 F）；Undo 的第一个 git restore 之前 B 写下
 *        b-undo.txt（P′→Q′ 之间别的会话的改动）。之后这次 Rewind 与这次 Undo 都没有 Undo。
 */
async function undoSteps(cwd, a, result) {
  beforeNext(cwd, 'restore', () => {
    put(cwd, 'b-undo.txt', 'undo\n');
  });
  const undo = await K.rewind.undoRewind(a.session, { undoId: result.entryId });
  const undone = { files: contents(cwd, S1_FILES) };
  const again = await settle(K.rewind.undoRewind(a.session, { undoId: result.entryId }));
  const ofUndo = await settle(K.rewind.undoRewind(a.session, { undoId: undo.entryId }));
  return { undo, undone, again, ofUndo };
}

/**
 * @brief 手写的 mori.rewind（synthetic）：一次真实记录的副本，restored、skipped 只留前几个，总数（counts）不变，
 *        像列表被 REWIND_LIST_LIMIT 截断了一样。
 * @param record 真实的记录
 * @param keep { restored, skipped }：各留几个
 */
function cutRecord(record, keep) {
  return { ...record, restored: record.restored.slice(0, keep.restored), skipped: record.skipped.slice(0, keep.skipped),
    at: Date.now() };
}

// ---- S2：changed 冲突、Cancel、Skip these files、列表被截断的记录的 Undo ----

const XYZ = ['x.txt', 'y.txt', 'z.txt'];

/**
 * @brief S2 的 Undo：撤销这次 Rewind 的一条只截了 restored 的副本（skipped 列全，synthetic），它的 from 是一条
 *        custom_message（Mori 回不去，§5.9 第 5 步）；之后那次真实的 Rewind 后面跟着别的 mori.rewind，没有 Undo。
 */
async function cutUndo(cwd, a, skipped) {
  const note = a.manager.appendCustomMessageEntry('synthetic.note', 'Note', true);
  const copy = { ...cutRecord(skipped.record, { restored: 0, skipped: 1 }), conversation: true, from: note };
  const cut = await K.rewind.undoRewind(a.session, { undoId: a.manager.appendCustomEntry(REWIND, copy) });
  const afterCut = { files: contents(cwd, XYZ), navigations: [...a.navigations], picks: a.picks };
  const followed = await settle(K.rewind.undoRewind(a.session, { undoId: skipped.entryId }));
  return { cut, afterCut, followed };
}

/**
 * @brief S2：编辑器里改过 y.txt；第一次得到冲突（Cancel：不再调用），然后 Skip these files；再撤销这次 Rewind 的
 *        一条 restored 与 skipped 都没列全的副本（得到冲突），最后撤销一条只有 restored 没列全的副本（cutUndo）。
 */
async function conflictScenario() {
  const cwd = folder('c1', { 'x.txt': 'x0\n', 'y.txt': 'y0\n', 'z.txt': 'z0\n' });
  const a = openUser(K, cwd);
  const m1 = await turn(K, a, 'Change three files', () => XYZ.forEach((path) => put(cwd, path, `${path[0]}1\n`)));
  put(cwd, 'y.txt', 'y-editor\n');
  const first = await K.rewind.rewind(a.session, codeOnly(m1));
  const afterFirst = {
    files: contents(cwd, XYZ), rewinds: customEntries(a, REWIND).length,
    refs: await internalRefs(K, cwd, `refs/mori/s/${a.sessionId}/rewind/`),
  };
  const skipped = await K.rewind.rewind(a.session, codeOnly(m1, { action: 'skip', token: first.token }));
  const afterSkip = contents(cwd, XYZ);
  const unsureId = a.manager.appendCustomEntry(REWIND, cutRecord(skipped.record, { restored: 0, skipped: 0 }));
  const unsure = await K.rewind.undoRewind(a.session, { undoId: unsureId });
  const afterUnsure = contents(cwd, XYZ);
  return { first, afterFirst, skipped, afterSkip, unsure, afterUnsure, ...(await cutUndo(cwd, a, skipped)) };
}

// ---- S3：同时运行的另一个用户会话（Overwrite、保险快照失败、Undo 的冲突）、嵌套文件夹里的会话（恢复后快照失败） ----

const AB = ['a1.txt', 'b1.txt'];

/**
 * @brief Restore code and conversation，带着 token 选 Overwrite，而扩展取消了移动对话（§5.8：代码照样恢复、照样写记录）；
 *        M1 有引用，结果里也不带。
 * @return { done: Rewind 的结果, doneView: 写之前的叶子、导航与 recordPick 的次数 }
 */
async function cancelledBoth(a, m1, choice) {
  a.refs.set(m1, QUOTE);
  a.navigate = () => ({ cancelled: true });
  const leafBefore = a.manager.getLeafId();
  const both = { entryId: m1, code: true, conversation: true, conflictChoice: choice };
  const done = await K.rewind.rewind(a.session, both);
  a.navigate = null;
  return { done, doneView: { leafBefore, navigations: [...a.navigations], picks: a.picks } };
}

/** @brief S3a 的后半：保险快照失败；Overwrite（同时恢复对话，被扩展取消）；之后你改了 a1.txt，Undo 得到冲突。 */
async function overwriteSteps(cwd, a, m1, first) {
  const choice = { action: 'overwrite', token: first.token };
  failNextAdd(cwd);
  const safetyFailed = await settle(K.rewind.rewind(a.session, codeOnly(m1, choice)));
  const afterSafety = { files: contents(cwd, AB), rewinds: customEntries(a, REWIND).length };
  const { done, doneView } = await cancelledBoth(a, m1, choice);
  const afterDone = contents(cwd, AB);
  put(cwd, 'a1.txt', 'a-late\n');
  const undo = await K.rewind.undoRewind(a.session, { undoId: done.entryId });
  return { safetyFailed, afterSafety, done, doneView, afterDone, undo, afterUndo: contents(cwd, AB) };
}

/**
 * @brief S3a：A 与 B 在同一工作路径上同时运行；A Rewind 到 M1 之前得到 overlap 冲突，保险快照失败一次，再 Overwrite，
 *        最后 Undo 得到冲突。
 */
async function concurrentScenario() {
  const cwd = folder('o1', { 'a1.txt': 'orig\n', 'b1.txt': 'orig\n' });
  const a = openUser(K, cwd);
  const b = openUser(K, cwd);
  const m1 = await beginTurn(a, 'A works');
  await beginTurn(b, 'B works');
  put(cwd, 'a1.txt', 'A1\n');
  put(cwd, 'b1.txt', 'B1\n');
  await endTurn(K, b);
  await endTurn(K, a);
  const first = await K.rewind.rewind(a.session, codeOnly(m1));
  const files = contents(cwd, AB);
  return { a, m1, records: changesOf(a), first, files, ...(await overwriteSteps(cwd, a, m1, first)) };
}

const NESTED = ['a2.txt', 'app/c2.txt', 'app/keep.txt'];

/** @brief S3b 的后半：带着 token 选 Overwrite，恢复后快照 Q 失败；记下结果、ref 与 Undo。 */
async function postFailedSteps(cwd, a, m1, conflicts) {
  beforeNext(cwd, 'restore', () => {
    failNextAdd(cwd);
  });
  const postFailed = await K.rewind.rewind(a.session, codeOnly(m1, { action: 'overwrite', token: conflicts.token }));
  const afterPost = contents(cwd, NESTED);
  const postRefs = await internalRefs(K, cwd, rewindRefs(a, postFailed.entryId));
  const undoPostFailed = await settle(K.rewind.undoRewind(a.session, { undoId: postFailed.entryId }));
  return { postFailed, afterPost, postRefs, undoPostFailed };
}

/**
 * @brief S3b：A 在 <R>，C 在 <R>\app，两次运行重叠；A Rewind 到 M1 之前得到 overlap 冲突；你在编辑器里改了 a2.txt 后
 *        带旧 token 选 Overwrite，得到新的冲突（过时的 token）；再带新 token 选 Overwrite，这时恢复后快照失败。
 */
async function nestedScenario() {
  const cwd = folder('n1', { 'a2.txt': 'orig\n', 'app/keep.txt': 'keep\n' });
  const inner = join(cwd, 'app');
  usedCwds.add(inner);
  const a = openUser(K, cwd);
  const c = openUser(K, inner);
  const m1 = await beginTurn(a, 'A works');
  await beginTurn(c, 'C works in app');
  put(cwd, 'a2.txt', 'A2\n');
  put(inner, 'c2.txt', 'C2\n');
  await endTurn(K, c);
  await endTurn(K, a);
  const first = await K.rewind.rewind(a.session, codeOnly(m1));
  const files = contents(cwd, NESTED);
  put(cwd, 'a2.txt', 'A2-editor\n');
  const stale = await K.rewind.rewind(a.session, codeOnly(m1, { action: 'overwrite', token: first.token }));
  const afterStale = { files: contents(cwd, NESTED), rewinds: customEntries(a, REWIND).length };
  const post = await postFailedSteps(cwd, a, m1, stale);
  return { a, records: changesOf(a), first, files, stale, afterStale, ...post };
}

// ---- S4：挡路的文件与目录、只差大小写的改名、恢复代码与对话、Undo 回到原来的分支、只恢复对话 ----

const QUOTE = Object.freeze([{ synthetic: true, label: 'notes.md' }]);
const S4_FILES = ['README.md', 'Readme.md', 'c.txt', 'dir', 'b.txt/inner.txt', 'f.txt', 'g.txt'];

/**
 * @brief S4 的两轮：M1 删 README.md、dir/a.txt、b.txt，把 c.txt 换成只有空目录的目录，改 f.txt；
 *        M2 建 Readme.md 与 g.txt。之后你在 Mori 外把空的 dir 换成文件、在 b.txt 的位置建了有文件的目录（没有记下）。
 */
async function reshapeTurns(cwd, a) {
  const m1 = await turn(K, a, 'Reshape the files', () => {
    drop(cwd, 'README.md');
    drop(cwd, 'dir/a.txt');
    drop(cwd, 'b.txt');
    drop(cwd, 'c.txt');
    mkdirSync(join(cwd, 'c.txt', 'x', 'y'), { recursive: true });
    put(cwd, 'f.txt', 'f1\n');
  });
  const m2 = await turn(K, a, 'Add Readme.md and g.txt', () => {
    put(cwd, 'Readme.md', 'readme2\n');
    put(cwd, 'g.txt', 'g1\n');
  });
  drop(cwd, 'dir');
  put(cwd, 'dir', 'blocker\n');
  put(cwd, 'b.txt/inner.txt', 'inner\n');
  return { m1, m2 };
}

/** @brief 此刻的样子：根目录的名字（磁盘上的大小写）、几个文件的内容、分支与 recordPick 的次数。 */
function reshapeState(cwd, a) {
  return { names: names(cwd), files: contents(cwd, S4_FILES), c: present(cwd, 'c.txt'),
    branch: a.manager.getBranch(), picks: a.picks };
}

/** @brief S4：Restore code and conversation 到 M1 之前（没有冲突），Undo，再只恢复对话到 M2 之前。 */
async function reshapeScenario() {
  const files = { 'README.md': 'readme0\n', 'dir/a.txt': 'da0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'f.txt': 'f0\n' };
  const cwd = folder('w1', files);
  const a = openUser(K, cwd);
  const first = a.manager.appendCustomEntry('synthetic.start', {});
  const { m1, m2 } = await reshapeTurns(cwd, a);
  a.refs.set(m1, QUOTE);
  a.pick = 'B';
  const leafBefore = a.manager.getLeafId();
  const both = await K.rewind.rewind(a.session, { entryId: m1, code: true, conversation: true });
  const afterBoth = reshapeState(cwd, a);
  const undo = await K.rewind.undoRewind(a.session, { undoId: both.entryId });
  const afterUndo = reshapeState(cwd, a);
  const talk = await K.rewind.rewind(a.session, talkOnly(m2));
  const afterTalk = reshapeState(cwd, a);
  const talkUndo = await settle(K.rewind.undoRewind(a.session, { undoId: talk.entryId }));
  return { a, first, m1, m2, leafBefore, both, afterBoth, undo, afterUndo, talk, afterTalk, talkUndo };
}

// ---- S5：快照暂停；S6：记录列出的文件少于总数 ----

/**
 * @brief S5：新文件比注入的上限（§19.1，20 个）多一个，快照暂停（§4.4 第 3 步）；恢复代码被拒绝，只恢复对话照样可以
 *        （§5.8 最后一条）。
 */
async function pausedScenario() {
  const count = SMALL_LIMITS.maxNewFiles + 1;
  const cwd = folder('p1', Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.txt`, `${i}\n`])));
  const a = openUser(K, cwd);
  const m1 = await turn(K, a, 'Work in a big folder', () => put(cwd, 'f0.txt', 'changed\n'));
  const state = K.snapshots.snapshotState(cwd).state;
  const code = await settle(K.rewind.rewind(a.session, codeOnly(m1)));
  const kept = content(cwd, 'f0.txt');
  const talk = await K.rewind.rewind(a.session, talkOnly(m1));
  return { a, m1, state, code, kept, talk };
}

/** @brief 手写的 run 记录（synthetic，提交是真实快照）。 */
function runRecord(round, ends) {
  return { v: 1, kind: 'run', round, start: ends.start, end: ends.end, at: Date.now() };
}

/**
 * @brief 手写的 changes 记录（synthetic，提交是真实快照）：只列出 listed，total 多于它（像被 CHANGES_FILE_LIMIT 截断了
 *        一样），overlap 为真。
 */
function cutChanges(round, ends, listed, total) {
  return { v: 1, kind: 'changes', round, base: ends.start, head: ends.end, files: listed, total,
    agents: [{ role: 'mori', task: null, self: true }], overlap: true, at: Date.now() };
}

const TWO = ['a.txt', 'b.txt'];

/**
 * @brief S6 的一轮：改 a.txt 与 b.txt（开始、结束是 snapshotNow 拍的真实快照），记录是手写的：changes 只列出 a.txt、
 *        total 为 2、overlap 为真；run 记录与它的 ref 照快照模块写。
 * @return 你的消息的条目 id
 */
async function handwrittenTurn(cwd, a) {
  const ends = { start: await snapshotNow(K, cwd) };
  put(cwd, 'a.txt', 'a1\n');
  put(cwd, 'b.txt', 'b1\n');
  ends.end = await snapshotNow(K, cwd);
  const m1 = say(a, 'Change two files');
  reply(a);
  const listed = [{ path: 'a.txt', status: 'M', added: 1, removed: 1 }];
  a.manager.appendCustomEntry(TURN, cutChanges(m1, ends, listed, 2));
  a.manager.appendCustomEntry(TURN, runRecord(m1, ends));
  await keepRoundRefs(K, a, m1, [ends.start, ends.end]);
  return m1;
}

/**
 * @brief S6（在你的 git 仓库里，staged.txt 有暂存的改动）：handwrittenTurn 的一轮；Rewind 用 git 补全 F（§5.6 第 3 步），
 *        补全的 b.txt 同样算 overlap；带着 token 选 Overwrite 恢复两个文件；前后读你的仓库的状态。
 */
async function completionScenario() {
  const cwd = folder('t1', { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'staged.txt': 's0\n' });
  await initUserRepo(cwd);
  put(cwd, 'staged.txt', 's1\n');
  await sh(cwd, ['add', 'staged.txt']);
  const repoBefore = await repoState(cwd);
  const a = openUser(K, cwd);
  const m1 = await handwrittenTurn(cwd, a);
  const first = await K.rewind.rewind(a.session, codeOnly(m1));
  const afterFirst = { files: contents(cwd, TWO), rewinds: customEntries(a, REWIND).length };
  const done = await K.rewind.rewind(a.session, codeOnly(m1, { action: 'overwrite', token: first.token }));
  return { first, afterFirst, done, afterDone: contents(cwd, TWO), repoBefore, repoAfter: await repoState(cwd),
    staged: content(cwd, 'staged.txt') };
}

// ---- 同时开始全部用真实 git 的场景（各自的工作路径） ----

const s1 = start(restoreScenario);
const s2 = start(conflictScenario);
const s3a = start(concurrentScenario);
const s3b = start(nestedScenario);
const s4 = start(reshapeScenario);
const s5 = start(pausedScenario);
const s6 = start(completionScenario);

// ---- FS-16 计划与冲突 ----

test('FS-16 the file set is the union of the rounds from M on: rewinding to M1 takes back M2 too', async () => {
  const { both } = await s4;
  assert.deepEqual(both.record.restored, ['README.md', 'c.txt', 'f.txt']);
  assert.deepEqual(both.record.deleted, ['Readme.md', 'g.txt']);
});

test('FS-16 a file only another session changed is not in the file set and stays as it is', async () => {
  const { result, restored, undone } = await s1;
  const { record } = result;
  const touched = [...record.restored, ...record.deleted, ...record.failed.map((item) => item.path)];
  assert.deepEqual(touched.sort(), ['b.txt', 'c.txt', 'locked.txt', 'new.txt']);
  assert.deepEqual([restored.files['only-b.txt'], undone.files['only-b.txt']], ['B-only\n', 'B-only\n']);
});

test('FS-16 a file you edited after the latest snapshot is a changed conflict; nothing is restored', async () => {
  const { first, afterFirst } = await s2;
  assert.deepEqual(first, conflictsResult([{ path: 'y.txt', reason: 'changed' }]));
  assert.deepEqual(afterFirst.files, { 'x.txt': 'x1\n', 'y.txt': 'y-editor\n', 'z.txt': 'z1\n' });
});

test('FS-16 Cancel sends nothing: after the conflicts there is no mori.rewind and no rewind ref', async () => {
  const { afterFirst } = await s2;
  assert.equal(afterFirst.rewinds, 0);
  assert.deepEqual(afterFirst.refs, []);
});

test('FS-16 a stale token (the conflicts changed in between) returns the conflicts again and restores nothing; '
  + 'a file that is both changed and overlap is listed as changed', async () => {
  const { first, stale, afterStale } = await s3b;
  const conflicts = [{ path: 'a2.txt', reason: 'changed' }, { path: 'app/c2.txt', reason: 'overlap' }];
  assert.deepEqual(stale, conflictsResult(conflicts));
  assert.notEqual(stale.token, first.token);
  const files = { 'a2.txt': 'A2-editor\n', 'app/c2.txt': 'C2\n', 'app/keep.txt': 'keep\n' };
  assert.deepEqual(afterStale, { files, rewinds: 0 });
});

test('FS-16 Skip these files restores the rest and leaves the conflicted files as they are', async () => {
  const { skipped, afterSkip } = await s2;
  assert.equal(skipped.kind, 'done');
  assert.deepEqual(skipped.record.restored, ['x.txt', 'z.txt']);
  assert.deepEqual(skipped.record.skipped, ['y.txt']);
  assert.deepEqual(skipped.record.counts, { restored: 2, deleted: 0, skipped: 1, failed: 0 });
  assert.deepEqual(afterSkip, { 'x.txt': 'x0\n', 'y.txt': 'y-editor\n', 'z.txt': 'z0\n' });
  assert.deepEqual([skipped.entries, skipped.editorText, skipped.refs, skipped.warning], [null, null, null, null]);
});

test('FS-16 Overwrite with the same token restores every file, the conflicted ones too', async () => {
  const { done, afterDone } = await s3a;
  assert.equal(done.kind, 'done');
  assert.deepEqual([done.record.restored, done.record.skipped], [AB, []]);
  assert.deepEqual(afterDone, { 'a1.txt': 'orig\n', 'b1.txt': 'orig\n' });
});

test('FS-16 files changed while another user session ran at the same time are overlap conflicts', async () => {
  const { records, first, files } = await s3a;
  assert.deepEqual(records.map((record) => [pathsOf(record), record.overlap]), [[['a1.txt', 'b1.txt'], true]]);
  assert.deepEqual(records[0].agents, [{ role: 'mori', task: null, self: true }]);
  assert.deepEqual(first, conflictsResult(listed('overlap', 'a1.txt', 'b1.txt')));
  assert.deepEqual(files, { 'a1.txt': 'A1\n', 'b1.txt': 'B1\n' });
});

test('FS-16 files changed while a session in <R>/app ran are overlap conflicts when rewinding in <R>', async () => {
  const { records, first, files } = await s3b;
  assert.deepEqual(records.map((record) => [pathsOf(record), record.overlap]), [[['a2.txt', 'app/c2.txt'], true]]);
  const conflicts = [{ path: 'a2.txt', reason: 'overlap' }, { path: 'app/c2.txt', reason: 'overlap' }];
  assert.deepEqual(first, conflictsResult(conflicts));
  assert.deepEqual(files, { 'a2.txt': 'A2\n', 'app/c2.txt': 'C2\n', 'app/keep.txt': 'keep\n' });
});

test('FS-16 a record listing fewer files than its total is completed with git; the added files keep its overlap '
  + 'and are restored', async () => {
  const { first, afterFirst, done, afterDone } = await s6;
  assert.deepEqual(first, conflictsResult(listed('overlap', 'a.txt', 'b.txt')));
  assert.deepEqual(afterFirst, { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, rewinds: 0 });
  assert.equal(done.kind, 'done');
  assert.deepEqual([done.record.restored, done.record.deleted, done.record.skipped], [TWO, [], []]);
  assert.deepEqual(afterDone, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
});

test('FS-16 restoring code while snapshots are paused: '
  + '"Snapshots are paused for this folder, so code can’t be restored."', async () => {
  const { state, code, kept } = await s5;
  assert.equal(state, 'paused');
  assert.deepEqual(code, { ok: false, error: TEXT.paused });
  assert.equal(kept, 'changed\n');
});

// ---- FS-17 恢复代码 ----

test('FS-17 modified and deleted files go back to before M; files created after M are deleted', async () => {
  const { restored } = await s1;
  const files = ['b.txt', 'c.txt', 'new.txt'].map((path) => restored.files[path]);
  assert.deepEqual(files, ['b0\n', 'c0\n', null]);
});

test('FS-17 a new file of yours that nobody recorded is untouched (no git clean)', async () => {
  const { restored } = await s1;
  assert.equal(restored.files['own.txt'], 'mine\n');
});

test('FS-17 your repository index (with a staged change), HEAD and branch stay the same through a rewind', async () => {
  const { repoBefore, repoAfter, done, afterDone, staged } = await s6;
  assert.equal(done.kind, 'done');
  assert.deepEqual(afterDone, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
  assert.equal(repoBefore.branch, 'refs/heads/main');
  assert.equal(repoBefore.staged, 'M\tstaged.txt');
  assert.deepEqual(repoAfter, repoBefore);
  assert.equal(staged, 's1\n');
});

test('FS-17 a locked file is not restored and is listed in failed; the others are restored', async () => {
  const { result, restored } = await s1;
  assert.deepEqual(result.record.restored, ['b.txt', 'c.txt']);
  assert.deepEqual(result.record.deleted, ['new.txt']);
  assert.deepEqual(result.record.failed.map((item) => item.path), ['locked.txt']);
  assert.equal(typeof result.record.failed[0].error, 'string');
  assert.notEqual(result.record.failed[0].error, '');
  assert.deepEqual(result.record.counts, { restored: 2, deleted: 1, skipped: 0, failed: 1 });
  assert.equal(restored.files['locked.txt'], 'l1\n');
});

test('FS-17 P and Q are commits in the internal repository, kept by refs under rewind/<entry id>/', async () => {
  const { a, result, refs, commits } = await s1;
  const { safety, post } = result.record;
  assert.match(safety, /^[0-9a-f]{40,64}$/);
  assert.match(post, /^[0-9a-f]{40,64}$/);
  assert.notEqual(safety, post);
  const prefix = rewindRefs(a, result.entryId);
  assert.deepEqual(refs, [`${prefix}${safety}`, `${prefix}${post}`].sort());
  assert.deepEqual(commits, [true, true]);
});

test('FS-17 the files restored between P and Q are recorded for no session', async () => {
  const { a, b, aRecordsBefore, restored, result } = await s1;
  assert.equal(restored.aRecords, aRecordsBefore);
  const restoring = ['b.txt', 'c.txt', 'locked.txt', 'new.txt'];
  const atQ = [...changesOf(a), ...changesOf(b)].filter((record) => record.head === result.record.post);
  assert.deepEqual(atQ.flatMap(pathsOf).filter((path) => restoring.includes(path)), []);
});

test('FS-17 a file another session in the same folder wrote between P and Q is recorded for that session', async () => {
  const { a, b, result, restored } = await s1;
  const segment = changesOf(b).filter((record) => record.head === result.record.post);
  assert.equal(segment.length, 1);
  assert.deepEqual(segment[0].files, [{ path: 'b-during.txt', status: 'A', added: 1, removed: 0 }]);
  assert.deepEqual([segment[0].base, segment[0].overlap], [result.record.safety, false]);
  assert.deepEqual(changesOf(a).filter((record) => record.head === result.record.post), []);
  assert.equal(restored.files['b-during.txt'], 'during\n');
});

test('FS-17 the result and the mori.rewind entry of a code-only rewind', async () => {
  const { a, m1, result } = await s1;
  const { record } = result;
  assert.deepEqual({ ...result, record: undefined }, {
    kind: 'done', entryId: result.entryId, record: undefined, editorText: null, refs: null, entries: null,
    warning: null,
  });
  assert.deepEqual({ v: record.v, kind: record.kind, target: record.target, turn: record.turn, code: record.code,
    conversation: record.conversation, from: record.from }, {
    v: 1, kind: 'rewind', target: m1, turn: 1, code: true, conversation: false, from: null,
  });
  const entry = customEntries(a, REWIND).find((item) => item.id === result.entryId);
  assert.deepEqual(entry.data, record);
  assert.ok(a.events.some((event) => event.type === 'mori.rewind' && event.entryId === result.entryId));
  assert.deepEqual([a.navigations, a.picks], [[], 0]);
});

test('FS-17 a case-only rename across rounds (README.md deleted, Readme.md created) is deleted first, then restored',
  async () => {
    const { afterBoth } = await s4;
    assert.ok(afterBoth.names.includes('README.md'));
    assert.ok(!afterBoth.names.includes('Readme.md'));
    assert.equal(afterBoth.files['README.md'], 'readme0\n');
  });

test('FS-17 a parent folder that is now a file: "A file is in the way." and that file is left alone', async () => {
  const { both, afterBoth } = await s4;
  assert.deepEqual(both.record.failed.find((item) => item.path === 'dir/a.txt'),
    { path: 'dir/a.txt', error: TEXT.fileInWay });
  assert.equal(afterBoth.files.dir, 'blocker\n');
});

test('FS-17 the file path is now a folder with an unrecorded file: "A folder is in the way." and nothing is deleted',
  async () => {
    const { both, afterBoth } = await s4;
    const failed = both.record.failed.find((item) => item.path === 'b.txt');
    assert.deepEqual(failed, { path: 'b.txt', error: TEXT.folderInWay });
    assert.equal(afterBoth.files['b.txt/inner.txt'], 'inner\n');
  });

test('FS-17 a folder holding only empty folders is removed and the file is restored', async () => {
  const { both, afterBoth } = await s4;
  assert.deepEqual(both.record.failed.map((item) => item.path), ['b.txt', 'dir/a.txt']);
  assert.ok(both.record.restored.includes('c.txt'));
  assert.equal(afterBoth.files['c.txt'], 'c0\n');
});

test('FS-17 a failed safety snapshot changes nothing; the error text is "Couldn’t take a snapshot: <git text>"',
  async () => {
    const { safetyFailed, afterSafety } = await s3a;
    assert.deepEqual(safetyFailed, { ok: false, error: `${TEXT.snapshotFailed}${BAD_OPTION_ERROR}` });
    assert.deepEqual(afterSafety, { files: { 'a1.txt': 'A1\n', 'b1.txt': 'B1\n' }, rewinds: 0 });
  });

// ---- FS-18 恢复对话（单元层能测的部分）与 FS-25 ----

test('FS-18 Restore code and conversation: navigateTree goes to M, M’s text and refs come back', async () => {
  const { a, m1, leafBefore, both, afterBoth } = await s4;
  assert.equal(both.kind, 'done');
  assert.deepEqual(a.navigations.slice(0, 1), [m1]);
  assert.deepEqual([both.editorText, both.refs, both.warning], ['Reshape the files', QUOTE, null]);
  assert.deepEqual({ code: both.record.code, conversation: both.record.conversation, from: both.record.from,
    turn: both.record.turn }, { code: true, conversation: true, from: leafBefore, turn: 1 });
  assert.deepEqual(both.entries, afterBoth.branch);
  assert.deepEqual([afterBoth.files['f.txt'], afterBoth.files['g.txt']], ['f0\n', null]);
});

test('FS-25 mori.pick is recorded again at the end of the new branch, right before mori.rewind', async () => {
  const { a, first, both } = await s4;
  assert.deepEqual(shapes(both.entries), ['synthetic.start', 'mori.pick', 'mori.rewind']);
  const pick = both.entries[1];
  assert.deepEqual([pick.parentId, pick.data], [first, { pick: 'B' }]);
  assert.equal(both.entries[2].id, both.entryId);
  assert.ok(a.events.some((event) => event.type === 'mori.rewind' && event.entryId === both.entryId));
});

test('FS-19 Undo after Restore code and conversation puts the files back and returns to the old branch', async () => {
  const { a, m2, leafBefore, both, undo, afterUndo } = await s4;
  assert.equal(undo.kind, 'done');
  assert.deepEqual(a.navigations.slice(1, 2), [leafBefore]);
  assert.deepEqual([afterUndo.files['f.txt'], afterUndo.files['g.txt']], ['f1\n', 'g1\n']);
  assert.ok(afterUndo.branch.some((entry) => entry.id === m2));
  assert.deepEqual({ kind: undo.record.kind, target: undo.record.target, turn: undo.record.turn,
    conversation: undo.record.conversation, from: undo.record.from, editorText: undo.editorText }, {
    kind: 'undo', target: both.entryId, turn: null, conversation: true, from: both.entryId, editorText: null,
  });
  assert.deepEqual(undo.entries, afterUndo.branch);
});

test('FS-25 Undo also records mori.pick again before its mori.rewind entry', async () => {
  const { leafBefore, undo, afterUndo, afterBoth } = await s4;
  const tail = afterUndo.branch.slice(-2);
  assert.deepEqual(shapes(tail), ['mori.pick', 'mori.rewind']);
  assert.deepEqual([tail[0].parentId, tail[1].id], [leafBefore, undo.entryId]);
  assert.deepEqual([afterBoth.picks, afterUndo.picks], [1, 2]);
});

test('FS-19 Undo of the case-only rename also deletes first, then restores (Readme.md back, README.md gone)',
  async () => {
    const { afterUndo } = await s4;
    assert.ok(afterUndo.names.includes('Readme.md'));
    assert.ok(!afterUndo.names.includes('README.md'));
    assert.equal(afterUndo.files['Readme.md'], 'readme2\n');
    assert.equal(afterUndo.c, false);
    assert.deepEqual([afterUndo.files.dir, afterUndo.files['b.txt/inner.txt']], ['blocker\n', 'inner\n']);
  });

test('FS-19 a conversation-only rewind changes no files and has no Undo', async () => {
  const { m2, talk, afterUndo, afterTalk, talkUndo } = await s4;
  assert.equal(talk.kind, 'done');
  assert.deepEqual({ code: talk.record.code, conversation: talk.record.conversation, safety: talk.record.safety,
    post: talk.record.post, target: talk.record.target }, { code: false, conversation: true, safety: null, post: null,
    target: m2 });
  assert.equal(talk.editorText, 'Add Readme.md and g.txt');
  assert.deepEqual([afterTalk.files, afterTalk.picks], [afterUndo.files, 3]);
  assert.deepEqual(talkUndo, { ok: false, error: TEXT.noUndo });
});

test('FS-18 Restore code and conversation when an extension cancels moving the conversation: code restored, warning, '
  + 'no pick', async () => {
  const { a, m1, done, doneView, afterDone } = await s3a;
  assert.equal(done.kind, 'done');
  assert.equal(done.warning, `${TEXT.conversationFailed}${TEXT.cancelled}`);
  assert.deepEqual([done.record.code, done.record.conversation, done.record.from],
    [true, false, null]);
  assert.deepEqual([done.entries, done.editorText, done.refs], [null, null, null]);
  assert.deepEqual(afterDone, { 'a1.txt': 'orig\n', 'b1.txt': 'orig\n' });
  assert.deepEqual([doneView.navigations, doneView.picks], [[m1], 0]);
  const entry = customEntries(a, REWIND).find((item) => item.id === done.entryId);
  assert.deepEqual([entry.parentId, entry.data], [doneView.leafBefore, done.record]);
});

test('FS-18 restoring only the conversation needs no snapshot: it works while snapshots are paused', async () => {
  const { a, m1, talk } = await s5;
  assert.equal(talk.kind, 'done');
  assert.deepEqual([talk.record.code, talk.record.conversation, talk.record.safety, talk.record.post],
    [false, true, null, null]);
  assert.equal(talk.editorText, 'Work in a big folder');
  assert.deepEqual([a.navigations, a.picks], [[m1], 1]);
});

test('FS-18 recordPick is called after each move of the conversation; a code-only rewind never calls it', async () => {
  const { afterTalk } = await s4;
  assert.equal(afterTalk.picks, 3);
  const { a: coder } = await s1;
  assert.equal(coder.picks, 0);
});

/** 只在内存里移动对话、只检查拒绝的用例共用的工作路径（不拍快照） */
const talkCwd = folder('m1', { 'keep.txt': 'keep\n' });

/** @brief 写下你的一条消息（content 可以是数组）。 */
function say(user, body) {
  return user.manager.appendMessage({ role: 'user', content: body, timestamp: Date.now() });
}

/** @brief 写下一条回复。 */
function reply(user) {
  return user.manager.appendMessage(assistantMessage('Reply.'));
}

/** @brief 写一条回执（synthetic，平行 Agent 规格 §13.2 的 mori.receipt）。 */
function receipt(user, request, kind = 'registered') {
  user.manager.appendCustomEntry('mori.receipt', { kind, request, title: `Request ${request}`, quote: null, at: 1 });
}

test('FS-18 navigateTree is called with M when M is not the leaf; the leaf moves to M’s parent', async () => {
  const a = openUser(K, talkCwd);
  say(a, 'First');
  const r1 = reply(a);
  const m = say(a, 'Second');
  const oldLeaf = reply(a);
  a.refs.set(m, QUOTE);
  const result = await K.rewind.rewind(a.session, talkOnly(m));
  assert.deepEqual(a.navigations, [m]);
  assert.deepEqual([result.editorText, result.refs], ['Second', QUOTE]);
  assert.deepEqual(shapes(result.entries), ['user', 'assistant', 'mori.pick', 'mori.rewind']);
  assert.equal(result.entries[2].parentId, r1);
  assert.deepEqual({ turn: result.record.turn, from: result.record.from, safety: result.record.safety },
    { turn: 2, from: oldLeaf, safety: null });
  assert.equal(a.picks, 1);
});

test('FS-18 rewinding the conversation to the first message leaves no message on the branch', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Only');
  reply(a);
  const result = await K.rewind.rewind(a.session, talkOnly(m));
  assert.deepEqual(shapes(result.entries), ['mori.pick', 'mori.rewind']);
  assert.equal(result.entries[0].parentId, null);
});

test('FS-18 M is the leaf and its parent is a reply: navigate to the parent, editorText is M’s text', async () => {
  const a = openUser(K, talkCwd);
  say(a, 'First');
  const parent = reply(a);
  const m = say(a, [{ type: 'text', text: 'Hello ' }, { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'text', text: 'world' }]);
  const result = await K.rewind.rewind(a.session, talkOnly(m));
  assert.deepEqual(a.navigations, [parent]);
  assert.equal(result.editorText, 'Hello world');
  assert.deepEqual(shapes(result.entries), ['user', 'assistant', 'mori.pick', 'mori.rewind']);
  assert.equal(result.record.from, m);
});

test('FS-18 M is the leaf and its parent is your message, a custom_message or nothing: no reply to rewind',
  async () => {
  const cases = [
    (a) => say(a, 'Before'),
    (a) => {
      say(a, 'Before');
      reply(a);
      a.manager.appendCustomMessageEntry('synthetic.note', 'Note', true);
    },
    () => undefined,
  ];
  for (const build of cases) {
    const a = openUser(K, talkCwd);
    build(a);
    const m = say(a, 'Leaf');
    assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: TEXT.noReply });
    assert.deepEqual([a.navigations, a.picks, customEntries(a, REWIND)], [[], 0, []]);
  }
});

test('FS-18 open requests registered at or after M block the conversation (one, two, three with Oxford comma)',
  async () => {
    const a = openUser(K, talkCwd);
    say(a, 'Before');
    receipt(a, 5);
    const m = say(a, 'Register things');
    [1, 2, 3, 4].forEach((n) => receipt(a, n));
    receipt(a, 6, 'added');
    reply(a);
    const one = 'Request 2 is still open. The conversation can’t go back to before it was registered.';
    const tries = [[[1, 2, 3, 5, 6], 'Requests 1, 2, and 3 are still open. '
      + 'The conversation can’t go back to before they were registered.'],
    [[3, 1], 'Requests 1 and 3 are still open. The conversation can’t go back to before they were registered.'],
    [[2], one]];
    for (const [open, text] of tries) {
      a.requests = open;
      assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: text });
    }
    const both = { entryId: m, code: true, conversation: true };
    assert.deepEqual(await settle(K.rewind.rewind(a.session, both)), { ok: false, error: one });
    assert.deepEqual([a.navigations, customEntries(a, REWIND)], [[], []]);
  });

test('FS-18 requests not open, registered before M or only added do not block; Restore code is not blocked',
  async () => {
    const a = openUser(K, talkCwd);
    say(a, 'Before');
    receipt(a, 5);
    const m = say(a, 'Register things');
    receipt(a, 4);
    receipt(a, 6, 'added');
    reply(a);
    a.requests = [5, 6];
    a.navigate = () => ({ cancelled: true });
    assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: TEXT.cancelled });
    receipt(a, 7);
    a.requests = [7];
    assert.deepEqual(await settle(K.rewind.rewind(a.session, codeOnly(m))), { ok: false, error: TEXT.noCode });
  });

test('FS-18 neither code nor conversation: "Choose code, conversation or both to restore."', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  const result = await settle(K.rewind.rewind(a.session, { entryId: m, code: false, conversation: false }));
  assert.deepEqual(result, { ok: false, error: TEXT.nothing });
  assert.equal(K.rewind.rewinding(a.sessionId), false);
});

test('FS-18 an extension cancelling navigateTree: "An extension cancelled moving the conversation."', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  const leaf = reply(a);
  a.navigate = () => ({ cancelled: true });
  assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: TEXT.cancelled });
  assert.deepEqual([a.manager.getLeafId(), a.picks, customEntries(a, REWIND)], [leaf, 0, []]);
});

test('FS-18 navigateTree throwing: the command fails with pi’s text and nothing is written', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  const busyText = 'Wait for the current response to finish before navigating the session tree.';
  a.navigate = () => {
    throw new Error(busyText);
  };
  assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: busyText });
  assert.deepEqual([a.picks, customEntries(a, REWIND)], [0, []]);
});

test('FS-18 a message not on the branch, a reply or a [Mori] delivery: "This message isn’t in the conversation."',
  async () => {
    const a = openUser(K, talkCwd);
    say(a, 'Hello');
    const answer = reply(a);
    const delivered = say(a, '[Mori] synthetic delivery');
    a.manager.appendCustomEntry('mori.wake', { messageId: delivered, kind: 'relay' });
    reply(a);
    for (const entryId of ['missing-entry', answer, delivered]) {
      assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(entryId))), { ok: false, error: TEXT.notIn });
    }
  });

test('FS-18 restoring code for a message without a run record: "This message has no code snapshot."', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  assert.deepEqual(await settle(K.rewind.rewind(a.session, codeOnly(m))), { ok: false, error: TEXT.noCode });
});

// ---- FS-19 Undo（单元层的补充） ----

test('FS-19 Undo of a complete record puts back what the rewind restored and leaves alone what another session '
  + 'changed between P and Q', async () => {
  const { result, undo, undone } = await s1;
  assert.equal(undo.kind, 'done');
  const record = undo.record;
  assert.deepEqual([record.restored, record.deleted, record.skipped, record.failed],
    [['b.txt', 'new.txt'], ['c.txt'], [], []]);
  const files = ['b.txt', 'c.txt', 'new.txt', 'own.txt', 'locked.txt', 'only-b.txt', 'b-during.txt']
    .map((path) => undone.files[path]);
  assert.deepEqual(files, ['b1\n', null, 'n1\n', 'mine\n', 'l1\n', 'B-only\n', 'during\n']);
  assert.deepEqual({ kind: record.kind, target: record.target, conversation: record.conversation, from: record.from },
    { kind: 'undo', target: result.entryId, conversation: false, from: null });
  assert.deepEqual([undo.entries, undo.editorText, undo.refs, undo.warning], [null, null, null, null]);
});

test('FS-19 the files an Undo restores between P′ and Q′ are recorded for no session; another session’s file '
  + 'written there is recorded for it', async () => {
  const { a, b, undo, undone } = await s1;
  const atQ = changesOf(b).filter((record) => record.head === undo.record.post);
  assert.equal(atQ.length, 1);
  assert.deepEqual(atQ[0].files, [{ path: 'b-undo.txt', status: 'A', added: 1, removed: 0 }]);
  assert.deepEqual([atQ[0].base, atQ[0].overlap], [undo.record.safety, false]);
  assert.deepEqual(changesOf(a).filter((record) => record.head === undo.record.post), []);
  assert.equal(undone.files['b-undo.txt'], 'undo\n');
});

test('FS-19 a record whose restored list is cut short (skipped listed in full): Undo recomputes F and restores '
  + 'without asking', async () => {
  const { skipped, cut, afterCut } = await s2;
  assert.deepEqual([skipped.record.restored, skipped.record.skipped], [['x.txt', 'z.txt'], ['y.txt']]);
  assert.equal(cut.kind, 'done');
  assert.deepEqual([cut.record.kind, cut.record.restored, cut.record.deleted, cut.record.skipped, cut.record.failed],
    ['undo', ['x.txt', 'z.txt'], [], [], []]);
  assert.deepEqual(afterCut.files, { 'x.txt': 'x1\n', 'y.txt': 'y-editor\n', 'z.txt': 'z1\n' });
});

test('FS-19 Undo whose from is a custom_message: the code comes back, the conversation does not move, with a warning',
  async () => {
    const { cut, afterCut } = await s2;
    assert.equal(cut.warning, `${TEXT.conversationFailed}${TEXT.cantReturn}`);
    assert.deepEqual([cut.record.conversation, cut.record.from, cut.entries, cut.editorText, cut.refs],
      [false, null, null, null, null]);
    assert.deepEqual([afterCut.navigations, afterCut.picks], [[], 0]);
  });

test('FS-19 a record whose skipped list is also cut short: the unsure files are asked as overlap conflicts',
  async () => {
    const { unsure, afterUnsure, afterSkip } = await s2;
    assert.deepEqual(unsure, conflictsResult(listed('overlap', 'x.txt', 'z.txt')));
    assert.deepEqual(afterUnsure, afterSkip);
  });

test('FS-19 no Undo after an Undo (no Redo), of an undo record, or for a rewind followed by another rewind',
  async () => {
    const { again, ofUndo } = await s1;
    const { followed } = await s2;
    for (const result of [again, ofUndo, followed]) assert.deepEqual(result, { ok: false, error: TEXT.noUndo });
  });

test('FS-19 Undo lists a file you changed after the rewind as a changed conflict and changes nothing', async () => {
  const { undo, afterUndo } = await s3a;
  assert.deepEqual(undo, conflictsResult([{ path: 'a1.txt', reason: 'changed' }]));
  assert.deepEqual(afterUndo, { 'a1.txt': 'a-late\n', 'b1.txt': 'orig\n' });
});

test('FS-19 a failed snapshot Q after restoring: the record is written with post null, a warning, and no Undo',
  async () => {
    const { a, postFailed, postRefs, undoPostFailed } = await s3b;
    assert.equal(postFailed.kind, 'done');
    assert.equal(postFailed.record.post, null);
    assert.match(postFailed.record.safety, /^[0-9a-f]{40,64}$/);
    assert.equal(postFailed.warning, `${TEXT.snapshotFailed}${BAD_OPTION_ERROR}`);
    assert.deepEqual([postFailed.record.restored, postFailed.record.deleted], [['a2.txt'], ['app/c2.txt']]);
    assert.deepEqual(postRefs, [`${rewindRefs(a, postFailed.entryId)}${postFailed.record.safety}`]);
    assert.deepEqual(undoPostFailed, { ok: false, error: TEXT.noUndo });
  });

/** @brief 手写的一条恢复了代码的 mori.rewind（synthetic，提交是假的：这些用例在检查快照之前就被拒绝）。 */
function syntheticRewind(target, extra = {}) {
  return {
    v: 1, kind: 'rewind', target, turn: 1, code: true, conversation: false, from: null, safety: 'a'.repeat(40),
    post: 'b'.repeat(40), restored: ['keep.txt'], deleted: [], skipped: [], failed: [],
    counts: { restored: 1, deleted: 0, skipped: 0, failed: 0 }, at: 1, ...extra,
  };
}

/** @brief 一个会话：一条你的消息、一条回复，再一条手写的 mori.rewind（synthetic）；返回会话、消息与记录的 id。 */
function sessionWithRewind(extra) {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  return { a, m, id: a.manager.appendCustomEntry(REWIND, syntheticRewind(m, extra)) };
}

test('FS-19 no Undo once a message entry follows the rewind (yours or a [Mori] delivery)', async () => {
  const mine = sessionWithRewind();
  say(mine.a, 'Next');
  const first = await settle(K.rewind.undoRewind(mine.a.session, { undoId: mine.id }));
  assert.deepEqual(first, { ok: false, error: TEXT.noUndo });
  const delivered = sessionWithRewind();
  const wake = say(delivered.a, '[Mori] synthetic delivery');
  delivered.a.manager.appendCustomEntry('mori.wake', { messageId: wake, kind: 'relay' });
  const result = await settle(K.rewind.undoRewind(delivered.a.session, { undoId: delivered.id }));
  assert.deepEqual(result, { ok: false, error: TEXT.noUndo });
});

test('FS-19 no Undo for a superseded, already undone, conversation-only, post-less or undo record', async () => {
  const replaced = sessionWithRewind();
  replaced.a.manager.appendCustomEntry(REWIND, syntheticRewind(replaced.m));
  const undone = sessionWithRewind();
  undone.a.manager.appendCustomEntry(REWIND, syntheticRewind(undone.id, { kind: 'undo', turn: null }));
  // 那条 undo 记录不在当前分支上（叶子回到被撤销的记录）：只靠“会话文件里有 undo 指向它”拒绝
  undone.a.manager.branch(undone.id);
  const cases = [replaced, undone, sessionWithRewind({ code: false, safety: null, post: null, restored: [],
    counts: { restored: 0, deleted: 0, skipped: 0, failed: 0 } }), sessionWithRewind({ post: null }),
  sessionWithRewind({ kind: 'undo', turn: null })];
  for (const { a, id } of cases) {
    assert.deepEqual(await settle(K.rewind.undoRewind(a.session, { undoId: id })), { ok: false, error: TEXT.noUndo });
  }
});

test('FS-19 no Undo for an entry that is not a mori.rewind or not on the current branch', async () => {
  const { a, m, id } = sessionWithRewind();
  a.manager.branch(m);
  reply(a);
  for (const undoId of [m, id, 'missing-entry']) {
    assert.deepEqual(await settle(K.rewind.undoRewind(a.session, { undoId })), { ok: false, error: TEXT.noUndo });
  }
});

test('FS-20 rewinding code to a turn whose refs were removed gives the pruned text', async () => {
  const { pruned } = await s1;
  assert.deepEqual(pruned, { ok: false, error: TEXT.pruned });
});

// ---- FS-24 进行中 ----

/** @brief 开始一次只恢复对话的 Rewind，navigateTree 停住直到 release()。 */
function heldRewind() {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  let release = () => undefined;
  let entered = () => undefined;
  const navigating = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  a.navigate = async (targetId) => {
    entered();
    await gate;
    return piNavigate(a.manager, targetId);
  };
  const running = K.rewind.rewind(a.session, talkOnly(m));
  return { a, m, running, navigating, release };
}

test('FS-24 while a rewind runs the session is rewinding: prompt, close and a second rewind or Undo are refused',
  async () => {
    const held = heldRewind();
    const { a, m } = held;
    assert.equal(K.rewind.rewinding(a.sessionId), true);
    await held.navigating;
    assert.throws(() => K.sw.refuseWhileRewinding(a.sessionId), { message: TEXT.rewindingPrompt });
    assert.throws(() => K.sw.refuseCloseWhileRewinding(a.sessionId), { message: TEXT.already });
    assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: TEXT.already });
    assert.deepEqual(await settle(K.rewind.undoRewind(a.session, { undoId: m })), { ok: false, error: TEXT.already });
    held.release();
    assert.equal((await held.running).kind, 'done');
    assert.equal(K.rewind.rewinding(a.sessionId), false);
    assert.doesNotThrow(() => K.sw.refuseWhileRewinding(a.sessionId));
    assert.doesNotThrow(() => K.sw.refuseCloseWhileRewinding(a.sessionId));
  });

test('FS-24 another session is not refused while one session rewinds', async () => {
  const held = heldRewind();
  const other = openUser(K, talkCwd);
  await held.navigating;
  assert.equal(K.rewind.rewinding(other.sessionId), false);
  assert.doesNotThrow(() => K.sw.refuseWhileRewinding(other.sessionId));
  held.release();
  await held.running;
});

test('FS-24 a busy session is refused: "This session is still running. Stop it first."', async () => {
  const a = openUser(K, talkCwd);
  const m = say(a, 'Hello');
  reply(a);
  a.busy = true;
  assert.deepEqual(await settle(K.rewind.rewind(a.session, talkOnly(m))), { ok: false, error: TEXT.stillRunning });
  const undo = await settle(K.rewind.undoRewind(a.session, { undoId: m }));
  assert.deepEqual(undo, { ok: false, error: TEXT.stillRunning });
  assert.equal(K.rewind.rewinding(a.sessionId), false);
  assert.deepEqual(a.navigations, []);
});
