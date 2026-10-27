// worktree 的会话接线（docs/specs/file-system.md §11.5、§11.6、§11.9.1、§11.9.4、§11.11，file-system-permissions.md §8.6；
// 验收 §19.2 FS-99、FS-100、FS-105、FS-109、FS-110 的单元部分，FS-68 的 §8.6 检查，负责人不在时定下的选择第 19 条）：
// kernel/worktreeSession.ts 的 startInWorktree（§11.5.2 会话一侧与 git 一侧的每个前提与原文（git 没装与低于 2.32 都算
// git 不可用）、重建的顺序与沿用的设置、startUser 或设回设置失败时回到原文件夹并同样沿用设置、startUser 两次都失败时
// 命令失败）、creatingWorktree 集合、ownedWorktree 与 keepWorktree、
// prepareWorktreeOpen、worktreeHost；kernel/sessionWorkspace.ts 第 3 步的 checkRestoredTools、refuseRestoredTools 与
// initGitEntry。会话与会话表操作是替身（synthetic，wts-helpers.mjs），git 是真实的 Git for Windows，仓库是临时目录里
// synthetic 的项目（基础仓库建一次，每个场景复制一份）。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFiles } from './git-helpers.mjs';
import {
  describeOf, forget, moriBranches, realGit, registered, scenario, startKit, workspaceEntry,
} from './wts-helpers.mjs';

const kit = await startKit();
const { wts: WT, sw: SW, ws: W, shared: S } = kit.K;
after(() => kit.cleanup());

/** mori.prompt_error 的开头（§11.5.7） */
const CREATE_FAILED = 'Couldn’t create the worktree: ';
/** §11.5.2、§11.5.3、§11.5.6、§11.9.4、§11.11 与 file-system-permissions.md §8.6 的原文（照抄规格） */
const TEXT = Object.freeze({
  hasMessages: 'This session already has messages.',
  stillRunning: 'This session is still running. Stop it first.',
  gitForCreate: 'Git is required to create a worktree.',
  notRepo: 'This folder isn’t a git repository.',
  noCommits: 'This repository has no commits yet.',
  coreWorktree: 'This repository sets core.worktree, so Mori can’t create a worktree here. '
    + 'Move it to the main worktree’s config.worktree first.',
  creating: 'The worktree is still being created.',
  gitForRestore: 'Git is required to restore this session’s worktree.',
  olderVersion: 'This session was saved by an older version of Mori and can’t be opened.',
  alreadyRepo: 'This folder is already a git repository.',
});
/** 不存在的工作路径（synthetic）：会话一侧的检查不过时 git 一步也不跑，跑了就会得到别的原因 */
const NOWHERE = 'C:\\mori-test\\wts\\nowhere';
/** pi 设置没写 defaultTools 时的默认工具（§8.6） */
const PI_DEFAULTS = ['read', 'bash', 'edit', 'write'];

// ---- 输入与期望（synthetic） ----

/** @brief 一个文件引用（synthetic）。 */
function fileRef(path) {
  return { quote: 'export const a = 1;',
    source: { kind: 'file', path, sha256: 'f'.repeat(64), startLine: 1, endLine: 1 } };
}

/** @brief 一个助手回复引用（synthetic）。 */
function messageRef() {
  return { quote: 'an earlier reply', source: { kind: 'message', sessionFile: null, entryId: 'e1', time: 1,
    scope: 'reply' } };
}

/** @brief 第一条消息的全文（synthetic）：count 段引用块在前，你写的字在后（§11.2 取名时跳过引用块）。 */
function quoted(count, own) {
  const blocks = Array.from({ length: count }, (_, i) => `Quoting part ${i + 1}:\n> synthetic quote ${i + 1}`);
  return [...blocks, own].join('\n\n');
}

/** @brief pi 的消息（synthetic）。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

/** @brief pi 的助手消息（synthetic，只有 hasMessages 看的几项）。 */
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2 };
}

/** @brief §11.5.7 的 mori.prompt_error 信封：消息撤回，文字与芯片回到输入框。 */
function failureEvent(sc, reason, input) {
  return { kind: 'event', sessionId: sc.entry.session.sessionId, event: { type: 'mori.prompt_error',
    message: `${CREATE_FAILED}${reason}`, text: input.text, refs: input.refs ?? null, running: false, queued: [] } };
}

/**
 * @brief 跑一次 startInWorktree：记下调用之后同步的那一刻会话是否已在 creatingWorktree 集合里，结束后是否已去掉。
 * @return { result, enteredAtOnce }（结束后仍在集合里时断言失败）
 */
async function run(sc, input) {
  const started = WT.startInWorktree(sc.entry, input, sc.deps);
  const enteredAtOnce = sc.creating();
  const result = await started;
  assert.equal(sc.creating(), false, 'the session id is still in the creatingWorktree set');
  return { result, enteredAtOnce };
}

/** @brief 没建成 worktree（§11.5.7 第一行）：会话没动、没有关闭与重建、发一条 prompt_error，结果是旧会话的信息。 */
function assertUntouched(sc, result, reason, input) {
  assert.deepEqual(sc.events, [failureEvent(sc, reason, input)]);
  assert.deepEqual(result, { accepted: true, held: false, session: describeOf(sc.entry) });
  assert.deepEqual(sc.log, [], 'nothing was closed, created, started or prompted');
  assert.equal(sc.entry.cwd, sc.cwd);
}

/** @brief 会话一侧的前提不过：git 一步也不跑（工作路径不存在，跑了就会是别的原因）。 */
async function refusedBeforeGit(options, input, reason) {
  const sc = scenario(kit, { cwd: NOWHERE, ...options });
  sc.cwd = NOWHERE;
  // 这些检查之间没有 await：startInWorktree 同步做完，集合在它返回之前已去掉（run 查）
  const { result } = await run(sc, input);
  assertUntouched(sc, result, reason, input);
  forget(kit, sc);
}

/** @brief git 一侧的前提不过（§11.5.2、§11.5.3 第 1 步）：原文、会话没动、仓库里没有 .mori 也没有 mori/ 分支。 */
async function refusedByGit(id, cwd, reason, repo = null) {
  const sc = scenario(kit, { id, cwd });
  sc.cwd = cwd;
  const input = { text: 'Start the parser work', refs: [fileRef(join(cwd, 'README.md'))] };
  const { result, enteredAtOnce } = await run(sc, input);
  assert.equal(enteredAtOnce, true, 'the id is in the set before the first await');
  assertUntouched(sc, result, reason, input);
  if (repo !== null) {
    assert.equal(existsSync(join(repo, '.mori')), false);
    assert.deepEqual(await moriBranches(repo), []);
  }
  forget(kit, sc);
}

/** @brief 已建好的 worktree 被撤掉了（§11.5.3 的清理）：文件夹、登记、mori/ 分支都没有。 */
async function assertRemoved(repo, path) {
  assert.equal(existsSync(path), false, `${path} is still there`);
  assert.equal((await registered(repo)).includes(path.toLowerCase()), false);
  assert.deepEqual(await moriBranches(repo), []);
}

/** @brief 场景里第 n 次 SessionManager.create 建在 Mori worktree 里：返回它的位置与 mori.worktree 的数据。 */
function placeOf(create) {
  const place = S.worktreeOf(create.cwd);
  assert.notEqual(place, null, `${create.cwd} is not in a Mori worktree`);
  return { place, owned: { path: place.path, branch: place.branch, mainFolder: place.mainFolder } };
}

// ---- 没装 git、git 太旧（换 git 的依赖，单独先跑） ----

test('FS-100 without git the first message fails with "Git is required to create a worktree."; FS-105 without git '
  + 'an existing worktree folder opens without a registration check and a missing one can’t be restored', async () => {
  const repo = kit.copyRepo('r-nogit');
  kit.useMissingGit();
  try {
    await refusedByGit('wts-nogit', repo, TEXT.gitForCreate);
    const loose = join(repo, '.mori', 'worktrees', 'loose-dddddd');
    mkdirSync(loose, { recursive: true });
    await WT.prepareWorktreeOpen(loose);
    await assert.rejects(WT.prepareWorktreeOpen(join(repo, '.mori', 'worktrees', 'gone-eeeeee')),
      { message: TEXT.gitForRestore });
    assert.equal(existsSync(loose), true);
  } finally {
    kit.useRealGit();
  }
});

test('FS-100 with git older than 2.32 the first message fails with "Git is required to create a worktree." after '
  + 'only git --version; FS-105 an existing worktree folder opens and a missing one can’t be restored', async () => {
  const repo = kit.copyRepo('r-oldgit');
  const fake = kit.useOldGit();
  try {
    await refusedByGit('wts-oldgit', repo, TEXT.gitForCreate);
    const loose = join(repo, '.mori', 'worktrees', 'loose-ffffff');
    mkdirSync(loose, { recursive: true });
    await WT.prepareWorktreeOpen(loose);
    await assert.rejects(WT.prepareWorktreeOpen(join(repo, '.mori', 'worktrees', 'gone-ffffff')),
      { message: TEXT.gitForRestore });
    // git 的状态是 old（§3.2 第 2 步）：找 git 只跑一次 --version，之后建、查登记、恢复都不再起 git
    assert.deepEqual(fake.calls.map((call) => call.args), [['--version']]);
    assert.equal(existsSync(join(repo, '.mori', 'worktrees', 'gone-ffffff')), false);
  } finally {
    kit.useRealGit();
  }
});

// ---- 会话一侧的前提（§11.5.2，git 一步也不跑） ----

test('FS-100 a session that already has messages, owns a worktree or was sent with a behavior is refused with '
  + '"This session already has messages." before any git step', async () => {
  const input = { text: 'Fix the parser', refs: [fileRef(join(NOWHERE, 'src', 'a.ts'))] };
  await refusedBeforeGit({ id: 'wts-user-msg', messages: [userMessage('earlier')] }, input, TEXT.hasMessages);
  await refusedBeforeGit({ id: 'wts-reply', messages: [assistantMessage('a reply')] }, { text: 'Next' },
    TEXT.hasMessages);
  const owns = { path: 'C:\\mori-test\\r\\.mori\\worktrees\\own-aaaaaa', branch: 'mori/own-aaaaaa',
    mainFolder: 'C:\\mori-test\\r' };
  await refusedBeforeGit({ id: 'wts-owns', old: { worktree: owns } }, input, TEXT.hasMessages);
  for (const behavior of ['steer', 'followUp']) {
    await refusedBeforeGit({ id: `wts-${behavior}` }, { ...input, behavior }, TEXT.hasMessages);
  }
});

test('FS-100 a busy session (running, preparing, streaming, Team busy) is refused with '
  + '"This session is still running. Stop it first."', async () => {
  const input = { text: 'Fix the parser' };
  const busy = [{ running: true }, { preparing: {} }, { streaming: true }, { teamMode: 'always', teamBusy: true }];
  for (const [i, old] of busy.entries()) {
    await refusedBeforeGit({ id: `wts-busy-${i}`, old }, input, TEXT.stillRunning);
  }
});

test('FS-100 a blocked session goes through promptEntry as now: no worktree, no prompt_error of its own', async () => {
  const refs = [fileRef(join(NOWHERE, 'src', 'a.ts'))];
  const sc = scenario(kit, { id: 'wts-blocked', cwd: NOWHERE, old: { blocked: true }, held: true,
    messages: [userMessage('earlier')] });
  const input = { text: 'Fix the parser', refs, behavior: 'steer', team: 'once' };
  const { result, enteredAtOnce } = await run(sc, input);
  assert.equal(enteredAtOnce, true);
  assert.deepEqual(sc.log, ['prompt:old']);
  assert.equal(sc.prompts[0].entry, sc.entry);
  assert.equal(sc.prompts[0].text, input.text);
  assert.deepEqual(sc.prompts[0].options, { behavior: 'steer', refs, team: 'once' });
  assert.equal(sc.prompts[0].creating, true);
  assert.deepEqual(sc.events, []);
  assert.deepEqual(result, { accepted: true, held: true, session: describeOf(sc.entry) });
  forget(kit, sc);
});

test('FS-100 creatingWorktree: other commands get "The worktree is still being created." from the first '
  + 'synchronous step until promptEntry hands over; the id is removed on every path', async () => {
  assert.equal(WT.WORKTREE_CREATING, TEXT.creating);
  let release;
  const pending = new Promise((done) => { release = done; });
  const sc = scenario(kit, { id: 'wts-hold', cwd: NOWHERE, old: { blocked: true }, promptResult: pending });
  const started = WT.startInWorktree(sc.entry, { text: 'Hold on' }, sc.deps);
  assert.throws(() => WT.refuseWhileCreating('wts-hold'), { message: TEXT.creating });
  assert.doesNotThrow(() => WT.refuseWhileCreating('wts-someone-else'));
  await new Promise((done) => setImmediate(done));
  assert.equal(sc.creating(), true, 'still creating while promptEntry has not handed over');
  release({ accepted: true, held: false });
  assert.equal((await started).held, false);
  assert.doesNotThrow(() => WT.refuseWhileCreating('wts-hold'));
  forget(kit, sc);
  const boom = new Error('synthetic: promptEntry threw');
  const failing = scenario(kit, { id: 'wts-throw', cwd: NOWHERE, old: { blocked: true }, promptFails: boom });
  // promptEntry 同步抛错：startInWorktree 在返回之前就收拾完，交出时 id 还在集合里，之后不在
  await assert.rejects(WT.startInWorktree(failing.entry, { text: 'Hold on' }, failing.deps), boom);
  assert.equal(failing.prompts[0].creating, true);
  assert.equal(failing.creating(), false);
  forget(kit, failing);
});

// ---- mori.worktree（§11.6，负责人不在时定下的选择第 19 条） ----

test('FS-99 keepWorktree: Check again on an unsaved worktree session writes the one mori.worktree into the new '
  + 'SessionManager, so the session still owns its worktree; ownedWorktree takes the last valid entry', () => {
  const owned = { path: 'C:\\mori-test\\k\\.mori\\worktrees\\keep-aaaaaa', branch: 'mori/keep-aaaaaa',
    mainFolder: 'C:\\mori-test\\k' };
  const manager = kit.SessionManager.create(owned.path, undefined, { id: 'wts-keep' });
  assert.equal(WT.keepWorktree(manager, owned), manager);
  assert.deepEqual(manager.getEntries().map((item) => [item.type, item.customType, item.data]),
    [['custom', 'mori.worktree', owned]]);
  assert.deepEqual(WT.ownedWorktree(manager), owned);
  assert.equal(existsSync(manager.getSessionFile()), false, 'nothing is written before the first message');
  const plain = kit.SessionManager.create('C:\\mori-test\\k', undefined, { id: 'wts-keep-none' });
  assert.equal(WT.keepWorktree(plain, null), plain);
  assert.deepEqual(plain.getEntries(), []);
  assert.equal(WT.ownedWorktree(plain), null);
  const newer = { ...owned, path: `${owned.path}x`, branch: `${owned.branch}x` };
  const mixed = kit.SessionManager.inMemory('C:\\mori-test\\k', { id: 'wts-keep-mixed' });
  mixed.appendCustomEntry('mori.worktree', owned);
  mixed.appendCustomEntry('mori.worktree', newer);
  const bad = mixed.appendCustomEntry('mori.worktree', { path: '', branch: 'mori/x' });
  assert.deepEqual(WT.ownedWorktree(mixed), newer);
  assert.ok(kit.logs.errors.includes(`[kernel] malformed mori.worktree entry ${bad} skipped`));
});

// ---- worktrees.list / cleanUp 要知道的开着的会话（§11.9.1） ----

test('FS-104 worktreeHost: every open session’s working path, instances owned by their user session’s file; '
  + 'only an open user session that isn’t headless owns a worktree; read fresh on every call', async () => {
  const W1 = 'C:\\mori-test\\h\\.mori\\worktrees\\host-aaaaaa';
  const owned = { path: W1, branch: 'mori/host-aaaaaa', mainFolder: 'C:\\mori-test\\h' };
  const row = (id, sessionFile, cwd, kind, extra = {}) => ({ session: { sessionId: id, sessionFile }, cwd, kind,
    owner: null, headless: false, worktree: null, ...extra });
  // 实例 i1 也带着 worktree：ownedBy 只认用户会话（kind 为 user），不认实例
  const entries = [
    row('u1', 'C:\\s\\u1.jsonl', W1, 'user', { worktree: owned }),
    row('i1', 'C:\\s\\i1.jsonl', W1, 'task', { owner: 'u1', worktree: owned }),
    row('h1', 'C:\\s\\h1.jsonl', 'C:\\mori-test\\h', 'user', { headless: true, worktree: owned }),
    row('u2', undefined, 'C:\\mori-test\\h', 'user'),
    row('i2', 'C:\\s\\i2.jsonl', 'C:\\mori-test\\h', 'ask', { owner: 'gone' }),
  ];
  const host = WT.worktreeHost(() => entries);
  assert.deepEqual(host.openCwds(), [
    { sessionFile: 'C:\\s\\u1.jsonl', cwd: W1, owner: null },
    { sessionFile: 'C:\\s\\i1.jsonl', cwd: W1, owner: 'C:\\s\\u1.jsonl' },
    { sessionFile: 'C:\\s\\h1.jsonl', cwd: 'C:\\mori-test\\h', owner: null },
    { sessionFile: null, cwd: 'C:\\mori-test\\h', owner: null },
    { sessionFile: 'C:\\s\\i2.jsonl', cwd: 'C:\\mori-test\\h', owner: null },
  ]);
  assert.deepEqual(host.ownedBy('C:\\s\\u1.jsonl'), owned);
  assert.equal(host.ownedBy('C:\\s\\i1.jsonl'), null);
  assert.equal(host.ownedBy('C:\\s\\h1.jsonl'), null);
  assert.equal(host.ownedBy('C:\\s\\nobody.jsonl'), null);
  // 拥有它的会话与它的实例不算占用；别的会话开在它的子文件夹里才算（listWorktrees 用这里的结果）
  const listed = await W.listWorktrees(['C:\\s\\u1.jsonl'], host);
  assert.deepEqual(listed, { git: true, items: [{ ...owned, sessionFile: 'C:\\s\\u1.jsonl', exists: false,
    changes: null, inUse: false }] });
  entries.push(row('u3', 'C:\\s\\u3.jsonl', `${W1}\\src`, 'user'));
  assert.equal(host.openCwds().length, 6);
  assert.equal((await W.listWorktrees(['C:\\s\\u1.jsonl'], host)).items[0].inUse, true);
});

// ---- 重新打开时的工具（file-system-permissions.md §8.6） ----

test('FS-68 checkRestoredTools: a restored set missing a pi default tool is refused with the older-version text; '
  + 'extension tools are not required; the defaults come from the settings', () => {
  assert.equal(SW.OLDER_VERSION, TEXT.olderVersion);
  const old = ['read', 'board_read', 'read_session', 'agent_message'];
  assert.throws(() => SW.checkRestoredTools(old, PI_DEFAULTS), { message: TEXT.olderVersion });
  assert.ok(kit.logs.errors.includes('[kernel] the restored tools lack bash, edit, write; the session is not opened'));
  assert.doesNotThrow(() => SW.checkRestoredTools(PI_DEFAULTS, PI_DEFAULTS));
  assert.doesNotThrow(() => SW.checkRestoredTools([...PI_DEFAULTS, 'memory', 'ask_user_question', 'board_read',
    'mcp__files__list'], PI_DEFAULTS));
  assert.doesNotThrow(() => SW.checkRestoredTools(['bash', 'read'], ['read', 'bash']));
  assert.throws(() => SW.checkRestoredTools(['read', 'edit', 'write'], ['read', 'bash']),
    { message: TEXT.olderVersion });
});

test('FS-68 refuseRestoredTools disposes the pi session before refusing and leaves a good one alone', () => {
  const sessionOf = (active) => ({ disposed: 0, getActiveToolNames: () => active, dispose() { this.disposed += 1; } });
  const refused = sessionOf(['read']);
  assert.throws(() => SW.refuseRestoredTools(refused, PI_DEFAULTS), { message: TEXT.olderVersion });
  assert.equal(refused.disposed, 1);
  const good = sessionOf([...PI_DEFAULTS, 'memory']);
  assert.doesNotThrow(() => SW.refuseRestoredTools(good, PI_DEFAULTS));
  assert.equal(good.disposed, 0);
});

// ---- 真实 git 的场景（各用自己的仓库，四组一起并行，最后跑） ----

describe('FS real-git scenarios', { concurrency: true }, () => {
  describe('FS-100 git-side preconditions', { concurrency: true }, () => {
    test('FS-100 a folder that isn’t a git repository: "This folder isn’t a git repository."', (t) => notARepo(t));
    test('FS-100 a repository without commits: "This repository has no commits yet."', (t) => noCommits(t));
    test('FS-100 repoInfo’s error is the reason as it is (an unreadable .git/config)', (t) => badConfig(t));
    test('FS-100 a subfolder with only untracked files: "The folder tools isn’t committed yet, so a worktree can’t '
      + 'start there. Commit it first."', (t) => untrackedSubfolder(t));
    test('FS-100 a repository that sets core.worktree is refused with the §11.5.3 text', (t) => coreWorktreeSet(t));
  });
  describe('FS-99 FS-100 FS-110 rebuilding the session', { concurrency: true }, () => {
    test('FS-99 the session is rebuilt in the new worktree: same id, mori.worktree right after create, same emit, '
      + 'trust and ApprovalPolicy, settings in order, refs moved, git status read, the result session',
    (t) => movesIntoWorktree(t));
    test('FS-110 a session working in a worktree gets a sibling worktree cut from that worktree’s HEAD, without '
      + 'its uncommitted files, and the same main folder', (t) => siblingWorktree(t));
    test('FS-100 a startUser that throws in the worktree: the worktree and its branch are removed, the session is '
      + 'rebuilt in the original folder by the same id with the same ApprovalPolicy, carries the settings over and '
      + 'emits the prompt_error', (t) => startUserThrows(t));
    test('FS-100 carrying the settings over fails in the worktree: that rebuilt session is closed, the worktree is '
      + 'removed and the session is rebuilt in the original folder, where the pick is set again',
    (t) => carryOverFails(t));
    test('FS-100 startUser throws in the worktree and again in the original folder: the worktree is gone, there is '
      + 'no prompt_error and startInWorktree rejects (the command fails)', (t) => startUserThrowsTwice(t));
  });
  describe('FS-105 prepareWorktreeOpen', { concurrency: true }, () => {
    test('FS-105 a missing worktree is restored from its branch once, even for two sessions opened at the same '
      + 'time; a present, registered one opens as it is', (t) => restoresOnce(t));
    test('FS-105 when the branch is gone both opens fail with the §11.9.4 text', (t) => branchGone(t));
    test('FS-105 a worktree folder that exists but isn’t registered with git refuses to open and is left alone',
      (t) => unregisteredFolder(t));
    test('FS-105 a registration that can’t be read opens normally; a cwd outside a Mori worktree is left to the '
      + 'caller', (t) => unreadableRegistration(t));
  });
  describe('FS-109 initGitEntry', { concurrency: true }, () => {
    test('FS-109 a busy session (running, preparing, streaming, Team busy) is refused with "This session is still '
      + 'running. Stop it first." and the git status is still read', (t) => initRefusesBusy(t));
    test('FS-109 the folder is initialized and the git status is read after the success and after a failure',
      (t) => initReadsStatus(t));
    test('FS-109 initGitEntry only takes user sessions', (t) => initUserOnly(t));
  });
});

// ---- git 一侧的前提（§11.5.2、§11.5.3 第 1 步） ----

/** @brief 不是 git 仓库的文件夹。 */
async function notARepo() {
  const plain = join(kit.root, 'plain-a');
  mkdirSync(plain);
  writeFileSync(join(plain, 'README.md'), 'plain\n');
  await refusedByGit('wts-plain', plain, TEXT.notRepo);
}

/** @brief 还没有提交的仓库。 */
async function noCommits() {
  const empty = join(kit.root, 'empty-a');
  mkdirSync(empty);
  await realGit(empty, ['init', '--quiet', '-b', 'main']);
  await refusedByGit('wts-empty', empty, TEXT.noCommits, empty);
}

/** @brief repoInfo 出错（.git/config 读不出）：原因是 git 的原文（gitError 去掉 fatal: ）。 */
async function badConfig() {
  const repo = kit.copyRepo('r-badcfg');
  writeFileSync(join(repo, '.git', 'config'), 'garbage line\n');
  await refusedByGit('wts-badcfg', repo, 'bad config line 1 in file .git/config');
}

/** @brief 工作路径是只有未跟踪文件的子文件夹：仓库的登记与分支不变。 */
async function untrackedSubfolder() {
  const repo = kit.copyRepo('r-untracked');
  const tools = join(repo, 'tools');
  writeFiles(tools, { 'run.ps1': 'Write-Output synthetic\n' });
  await refusedByGit('wts-untracked', tools,
    'The folder tools isn’t committed yet, so a worktree can’t start there. Commit it first.', repo);
  assert.deepEqual(await registered(repo), [repo.toLowerCase()]);
}

/** @brief 共用配置设了 core.worktree。 */
async function coreWorktreeSet() {
  const repo = kit.copyRepo('r-coreworktree');
  await realGit(repo, ['config', 'core.worktree', repo]);
  await refusedByGit('wts-coreworktree', repo, TEXT.coreWorktree, repo);
}

// ---- 建好之后重建会话（§11.5.4、§11.5.5）与重建失败（§11.5.7） ----

/** @brief FS-99：在仓库根的会话，设置全都与新会话的默认不同（四项都按顺序设回）。 */
async function movesIntoWorktree() {
  const repo = kit.copyRepo('r-move');
  const sc = scenario(kit, { id: 'wts-move', cwd: repo, held: true,
    old: { pick: 'synthetic/model-a', thinking: 'high', name: 'Parser fix', teamMode: 'always' },
    defaults: { pick: 'synthetic/default', thinking: 'medium', teamMode: 'off' } });
  const inside = fileRef(join(repo, 'src', 'a.ts'));
  const outside = fileRef('C:\\mori-test\\elsewhere\\b.ts');
  const message = messageRef();
  const input = { text: quoted(3, 'Fix the parser bug'), refs: [inside, outside, message], team: 'once' };
  const { result, enteredAtOnce } = await run(sc, input);
  assert.equal(enteredAtOnce, true);
  assert.equal(sc.creates.length, 1);
  const [create] = sc.creates;
  const { place, owned } = placeOf(create);
  const cwd = create.cwd;
  assert.match(place.name, /^fix-the-parser-bug-[0-9a-f]{6}$/);
  assert.deepEqual([cwd, place.path, place.mainFolder], [join(repo, '.mori', 'worktrees', place.name), cwd, repo]);
  assertCreate(create, 'wts-move', owned);
  assertStart(sc, sc.starts[0], cwd, create.manager);
  assert.deepEqual(sc.log, ['close:old', `create:${cwd}`, `start1:${cwd}`, 'start1.setPick:synthetic/model-a',
    'start1.setThinkingLevel:high', 'start1.emitState', 'start1.setSessionName:Parser fix', 'start1.setMode:on',
    'prompt:start1']);
  assert.equal(sc.closed[0], sc.entry);
  assert.deepEqual(sc.creatingSeen, [['close', true]]);
  const [next] = sc.built;
  assert.deepEqual([next.session.sessionId, next.worktree], ['wts-move', owned]);
  const moved = { ...inside, source: { ...inside.source, path: join(cwd, 'src', 'a.ts') } };
  assertPrompted(sc, next, input, { behavior: undefined, refs: [moved, outside, message], team: 'once' });
  assert.deepEqual(result, { accepted: true, held: true, session: describeOf(next) });
  assert.deepEqual(result.session.worktree, owned);
  await assertStatusRead(cwd, place.branch);
  assert.equal(readFileSync(join(cwd, '.work', '.gitignore'), 'utf8'), '*\n');
  forget(kit, sc);
}

/** @brief FS-110：在 worktree 里另开的会话（不拥有它）再开 worktree，旧会话没有记下的设置。 */
async function siblingWorktree() {
  const repo = kit.copyRepo('r-nest');
  const first = join(repo, '.mori', 'worktrees', 'first-aaaaaa');
  await realGit(repo, ['worktree', 'add', '--quiet', '-b', 'mori/first-aaaaaa', first]);
  writeFiles(first, { 'src/c.ts': 'export const c = 4;\n' });
  await realGit(first, ['add', '-A']);
  await realGit(first, ['commit', '--quiet', '-m', 'second']);
  writeFiles(first, { 'draft.txt': 'not committed\n' });
  const head = await realGit(first, ['rev-parse', 'HEAD']);
  // 旧会话没有范围、没改名、协作关着：新会话的默认范围不同也不设（§11.5.4 第 4 步，只设记下的）
  const sc = scenario(kit, { id: 'wts-nest', cwd: first, defaults: { pick: 'synthetic/default' } });
  const ref = fileRef(join(first, 'src', 'c.ts'));
  const input = { text: quoted(1, 'Try another approach'), refs: [ref] };
  const { result } = await run(sc, input);
  const { place, owned } = placeOf(sc.creates[0]);
  const cwd = sc.creates[0].cwd;
  assert.equal(dirname(place.path), join(repo, '.mori', 'worktrees'));
  assert.match(place.name, /^try-another-approach-[0-9a-f]{6}$/);
  assert.deepEqual(owned, { path: cwd, branch: place.branch, mainFolder: repo });
  assertCreate(sc.creates[0], 'wts-nest', owned);
  assert.deepEqual(sc.log, ['close:old', `create:${cwd}`, `start1:${cwd}`, 'prompt:start1']);
  const moved = { ...ref, source: { ...ref.source, path: join(cwd, 'src', 'c.ts') } };
  assertPrompted(sc, sc.built[0], input, { behavior: undefined, refs: [moved], team: undefined });
  assert.deepEqual(result.session, describeOf(sc.built[0]));
  assert.deepEqual(sc.built[0].worktree, owned);
  assert.equal(existsSync(join(cwd, 'src', 'c.ts')), true);
  assert.equal(existsSync(join(cwd, 'draft.txt')), false);
  assert.equal((await assertStatusRead(cwd, place.branch)).branch.oid, head);
  forget(kit, sc);
}

/** @brief FS-100：子文件夹里的会话，startUser 在 worktree 里抛错；只有思考强度与新会话的默认不同。 */
async function startUserThrows() {
  const repo = kit.copyRepo('r-back');
  const cwd = join(repo, 'app');
  const boom = new Error('synthetic: a required extension did not load');
  const same = { pick: 'synthetic/default', name: 'Kept name', teamMode: 'always' };
  const sc = scenario(kit, { id: 'wts-back', cwd, old: { ...same, thinking: 'high' },
    defaults: { ...same, thinking: 'medium' }, startFails: (_args, n) => (n === 1 ? boom : null) });
  const input = { text: quoted(1, 'Refactor main'), refs: [fileRef(join(cwd, 'main.ts'))] };
  const { result } = await run(sc, input);
  const [inTree, back] = sc.creates;
  const { place, owned } = placeOf(inTree);
  assert.deepEqual([inTree.cwd, place.mainFolder], [join(place.path, 'app'), cwd]);
  assertCreate(inTree, 'wts-back', owned);
  assertCreate(back, 'wts-back', null);
  assert.equal(back.cwd, cwd);
  assert.equal(sc.starts.length, 2);
  assertStart(sc, sc.starts[0], inTree.cwd, inTree.manager);
  assertStart(sc, sc.starts[1], cwd, back.manager);
  // 原文件夹里的重建同样沿用设置（§11.5.7 第二行）：只设回与默认不同的思考强度；范围、会话名与协作模式相同，
  // 不再设（§11.5.4 第 4 步）
  assert.deepEqual(sc.log, ['close:old', `create:${inTree.cwd}`, `start1:${inTree.cwd}`, `create:${cwd}`,
    `start2:${cwd}`, 'start2.setThinkingLevel:high', 'start2.emitState']);
  assert.equal(sc.built[0].session.thinkingLevel, 'high');
  // 引用不换：芯片回到原文件夹的输入框
  assert.deepEqual(sc.events, [failureEvent(sc, boom.message, input)]);
  assert.deepEqual(result, { accepted: true, held: false, session: describeOf(sc.built[0]) });
  assert.deepEqual([result.session.cwd, result.session.worktree], [cwd, null]);
  assert.deepEqual(sc.prompts, []);
  await assertRemoved(repo, place.path);
  assert.ok(kit.logs.errors.includes(
    `[kernel] wts-back couldn't start in the worktree ${place.path}: ${boom.message}`));
  forget(kit, sc);
}

/** @brief FS-100：worktree 里设回范围失败（§11.5.4 第 4 步也是重建），原文件夹里的重建设回范围成功。 */
async function carryOverFails() {
  const repo = kit.copyRepo('r-carry');
  const sc = scenario(kit, { id: 'wts-carry', cwd: repo, old: { pick: 'synthetic/model-b', teamMode: null },
    defaults: { pick: 'synthetic/default', teamMode: null }, failPick: (_args, n) => n === 1 });
  const input = { text: 'Rename the module', refs: [fileRef(join(repo, 'src', 'b.ts'))] };
  const { result, enteredAtOnce } = await run(sc, input);
  assert.equal(enteredAtOnce, true);
  const [inTree, back] = sc.creates;
  const { place } = placeOf(inTree);
  assertCreate(back, 'wts-carry', null);
  assertStart(sc, sc.starts[1], repo, back.manager);
  // 设回设置失败：先关掉刚在 worktree 里建的会话，再撤 worktree、回到原文件夹，那里同样设回范围（§11.5.7 第二行）
  assert.deepEqual(sc.log, ['close:old', `create:${inTree.cwd}`, `start1:${inTree.cwd}`,
    'start1.setPick:synthetic/model-b', 'close:start1', `create:${repo}`, `start2:${repo}`,
    'start2.setPick:synthetic/model-b']);
  assert.deepEqual(sc.closed, [sc.entry, sc.built[0]]);
  const reason = 'synthetic: the model layer refused the pick';
  assert.deepEqual(sc.events, [failureEvent(sc, reason, input)]);
  assert.deepEqual(result, { accepted: true, held: false, session: describeOf(sc.built[1]) });
  assert.equal(sc.built[1].model.state().pick, 'synthetic/model-b');
  assert.deepEqual(sc.prompts, []);
  await assertRemoved(repo, place.path);
  assert.ok(kit.logs.errors.includes(`[kernel] wts-carry: carrying the settings over failed: ${reason}`));
  forget(kit, sc);
}

/** @brief FS-100：startUser 在 worktree 里抛错，在原文件夹里又抛错（两次都失败，§11.5.7 第三行）。 */
async function startUserThrowsTwice() {
  const repo = kit.copyRepo('r-twice');
  const fails = [null, new Error('synthetic: start in the worktree failed'),
    new Error('synthetic: folder rebuild failed')];
  const sc = scenario(kit, { id: 'wts-twice', cwd: repo, startFails: (_args, n) => fails[n] });
  const started = WT.startInWorktree(sc.entry, { text: 'Rename the module' }, sc.deps);
  assert.equal(sc.creating(), true);
  await assert.rejects(started, { message: fails[2].message });
  assert.equal(sc.creating(), false);
  const [inTree, back] = sc.creates;
  const { place, owned } = placeOf(inTree);
  assertCreate(inTree, 'wts-twice', owned);
  assertCreate(back, 'wts-twice', null);
  assertStart(sc, sc.starts[0], inTree.cwd, inTree.manager);
  assertStart(sc, sc.starts[1], repo, back.manager);
  assert.deepEqual(sc.log, ['close:old', `create:${inTree.cwd}`, `start1:${inTree.cwd}`, `create:${repo}`,
    `start2:${repo}`]);
  // 后台进程里没有这个会话了：旧的已关，两次都没建出来；不发 prompt_error，命令失败由界面处理
  assert.deepEqual(sc.closed, [sc.entry]);
  assert.deepEqual(sc.built, []);
  assert.deepEqual(sc.events, []);
  assert.deepEqual(sc.prompts, []);
  await assertRemoved(repo, place.path);
  assert.ok(kit.logs.errors.includes(`[kernel] wts-twice couldn't start in the worktree ${place.path}: `
    + fails[1].message));
  assert.ok(kit.logs.errors.includes(`[kernel] wts-twice couldn't be rebuilt in ${repo}: ${fails[2].message}`));
  forget(kit, sc);
}

/**
 * @brief 一次 SessionManager.create（§11.5.4 第 2 步）：(新 cwd, undefined, { id: 原 id })，会话 id 不变、会话文件在 pi 的
 *        --<新 cwd 编码>-- 目录下、还没写盘；条目只有紧接着写的那一条 mori.worktree（owned 为 null 时一条也没有）。
 */
function assertCreate(create, id, owned) {
  assert.equal(create.argCount, 3);
  assert.equal(create.sessionDir, undefined);
  assert.deepEqual(create.options, { id });
  const manager = create.manager;
  assert.equal(manager.getSessionId(), id);
  assert.equal(manager.getCwd(), create.cwd);
  const encoded = `--${create.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  assert.equal(dirname(manager.getSessionFile()), join(kit.agentDir, 'sessions', encoded));
  assert.equal(existsSync(manager.getSessionFile()), false);
  const entries = manager.getEntries().map((item) => ({ type: item.type, customType: item.customType,
    data: item.data }));
  assert.deepEqual(entries, owned === null ? [] : [{ type: 'custom', customType: 'mori.worktree', data: owned }]);
}

/** @brief 一次 startUser 的参数（§11.5.4 第 3 步）：新 cwd、刚建的 SessionManager、原 emit、原信任结果、同一个 ApprovalPolicy。 */
function assertStart(sc, args, cwd, manager) {
  assert.deepEqual(Object.keys(args).sort(), ['approval', 'cwd', 'decision', 'emit', 'sessionManager']);
  assert.equal(args.cwd, cwd);
  assert.equal(args.sessionManager, manager);
  assert.equal(args.emit, sc.entry.emit);
  assert.equal(args.decision, sc.trust);
  assert.equal(args.approval, sc.approval);
}

/**
 * @brief 重建后的会话收到这条消息（§11.5.5）：全文不变、不带 worktree、refs 换过路径，交出时 id 仍在 creatingWorktree
 *        集合里；没有 prompt_error。
 */
function assertPrompted(sc, next, input, options) {
  assert.equal(sc.prompts.length, 1);
  assert.equal(sc.prompts[0].entry, next);
  assert.equal(sc.prompts[0].text, input.text);
  assert.deepEqual(sc.prompts[0].options, options);
  assert.equal(sc.prompts[0].creating, true);
  assert.deepEqual(sc.events, []);
}

/** @brief 为新的工作路径读的 git 状态（§11.5.4 第 5 步）：git 登记的 worktree，检出着 mori/<名字>；返回这次的状态。 */
async function assertStatusRead(cwd, branch) {
  const [status] = await kit.waitStatus(cwd);
  assert.equal(status.git.state, 'ok');
  assert.equal(status.repo.isWorktree, true);
  assert.equal(status.repo.toplevel.toLowerCase(), cwd.toLowerCase());
  assert.equal(status.branch.head, branch);
  return status;
}

// ---- 打开 worktree 不在的会话（§11.9.4） ----

/** @brief 同一个 worktree 里的两个会话（根与子文件夹）同时打开：只恢复一次；之后再打开不恢复。 */
async function restoresOnce() {
  const repo = kit.copyRepo('r-restore');
  // 归档清理之后的样子：分支是 Mori 建 worktree 时建的，那时已设好 extensions.worktreeConfig（§11.5.3 第 2 步）
  await realGit(repo, ['config', 'extensions.worktreeConfig', 'true']);
  await realGit(repo, ['branch', 'mori/restore-aaaaaa']);
  const path = join(repo, '.mori', 'worktrees', 'restore-aaaaaa');
  await Promise.all([WT.prepareWorktreeOpen(path), WT.prepareWorktreeOpen(join(path, 'src'))]);
  assert.equal(existsSync(join(path, 'src', 'a.ts')), true);
  assert.equal(readFileSync(join(path, '.work', '.gitignore'), 'utf8'), '*\n');
  const restoredLine = `[kernel] restored the worktree ${path} from mori/restore-aaaaaa`;
  assert.equal(kit.logs.logs.filter((line) => line === restoredLine).length, 1);
  assert.equal((await registered(repo)).filter((item) => item === path.toLowerCase()).length, 1);
  await WT.prepareWorktreeOpen(path);
  assert.equal(kit.logs.logs.filter((line) => line === restoredLine).length, 1);
}

/** @brief 分支不在：两次同时的打开都按 §11.9.4 的原文失败，什么都没检出。 */
async function branchGone() {
  const repo = kit.copyRepo('r-nobranch');
  const path = join(repo, '.mori', 'worktrees', 'nobranch-aaaaaa');
  const text = 'The branch mori/nobranch-aaaaaa no longer exists, so this session’s worktree can’t be restored.';
  const results = await Promise.allSettled([WT.prepareWorktreeOpen(path), WT.prepareWorktreeOpen(path)]);
  assert.deepEqual(results.map((item) => [item.status, item.reason?.message]),
    [['rejected', text], ['rejected', text]]);
  assert.equal(existsSync(path), false);
}

/** @brief 文件夹在、登记里没有：打开失败，原文照 §11.9.4，文件夹不删。 */
async function unregisteredFolder() {
  const repo = kit.copyRepo('r-stray');
  const path = join(repo, '.mori', 'worktrees', 'stray-bbbbbb');
  writeFiles(path, { 'notes.txt': 'maybe uncommitted work\n' });
  const text = `The worktree folder ${path} exists but isn’t registered with git. `
    + 'Move or delete it, then open this session again.';
  assert.equal(W.unregisteredText(path), text);
  await assert.rejects(WT.prepareWorktreeOpen(join(path, 'src')), { message: text });
  assert.equal(readFileSync(join(path, 'notes.txt'), 'utf8'), 'maybe uncommitted work\n');
}

/** @brief 读不出登记（R 不是仓库）时照常打开；不在 Mori worktree 里的 cwd 什么都不做（由调用方报不在）。 */
async function unreadableRegistration() {
  const plain = join(kit.root, 'plain-open');
  const loose = join(plain, '.mori', 'worktrees', 'loose-cccccc');
  mkdirSync(loose, { recursive: true });
  await WT.prepareWorktreeOpen(loose);
  assert.ok(kit.logs.errors.some((line) => line.startsWith(`[kernel] couldn't read the worktrees of ${plain}: `)));
  await WT.prepareWorktreeOpen(join(NOWHERE, 'src'));
  await WT.prepareWorktreeOpen(join(NOWHERE, '.mori', 'worktrees', 'Not-A-Name'));
}

// ---- Initialize git（§11.11） ----

/** @brief 会话忙（四种）时拒绝，不做 git init，git 状态照样读一次。 */
async function initRefusesBusy() {
  const busy = [{ running: true }, { preparing: {} }, { streaming: true }, { teamMode: 'always', teamBusy: true }];
  await Promise.all(busy.map(async (settings, i) => {
    const cwd = join(kit.root, `init-busy-${i}`);
    mkdirSync(cwd);
    await assert.rejects(SW.initGitEntry(workspaceEntry(`wts-init-busy-${i}`, cwd, settings)),
      { message: TEXT.stillRunning });
    const [status] = await kit.waitStatus(cwd);
    assert.equal(status.repo, null);
    assert.equal(existsSync(join(cwd, '.git')), false);
  }));
}

/** @brief 成功之后读一次 git 状态（已有提交）；再点一次按“已经是仓库”失败，之后也读一次。 */
async function initReadsStatus() {
  const cwd = join(kit.root, 'init-ok');
  writeFiles(cwd, { 'notes.txt': 'first\n' });
  assert.deepEqual(await SW.initGitEntry(workspaceEntry('wts-init-ok', cwd)), { initialized: true });
  const [first] = await kit.waitStatus(cwd, 1);
  assert.equal(first.repo.hasCommit, true);
  await assert.rejects(SW.initGitEntry(workspaceEntry('wts-init-ok', cwd)), { message: TEXT.alreadyRepo });
  const statuses = await kit.waitStatus(cwd, 2);
  assert.equal(statuses[1].repo.hasCommit, true);
}

/** @brief 实例不是界面上的会话：同 requireEntry 报 Unknown session，什么都不做。 */
async function initUserOnly() {
  const cwd = join(kit.root, 'init-task');
  mkdirSync(cwd);
  await assert.rejects(SW.initGitEntry(workspaceEntry('wts-init-task', cwd, { kind: 'task' })),
    { message: 'Unknown session wts-init-task' });
  assert.equal(existsSync(join(cwd, '.git')), false);
  rmSync(cwd, { recursive: true, force: true });
}
