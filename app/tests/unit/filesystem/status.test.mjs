// 认仓库与 git 状态（docs/specs/file-system.md §3.2、§3.4、§3.5、§17；验收 §19.2 FS-01、FS-03、FS-04、FS-05 的单元层）：
// kernel/workspace.ts 的 repoInfo、readStatus、scheduleStatus、resendStatus、configureWorkspace，timeline.ts 的
// parsePorcelainV2，sessionWorkspace.ts 的 workspaceStatus（workspace.status 命令重找 git）与 configureSessionWorkspace
// （结果发给谁），snapshots.ts 的 mori-snapshots 与 rewind.ts 触发的读（§3.5“什么时候读”里后台进程发起的几行）。
// 这些模块与 git.ts 打进同一个包（git-helpers.mjs 的 loadKernelBundle），configureGit 才对它们生效。
// 真实的临时仓库（synthetic 的项目，真实的 Git for Windows）测认仓库、git status 的结果与一轮结束、Rewind、Undo 之后的读；
// 替身 git（synthetic，注入的 spawn）测 dubious ownership、500 条上限、输出上限、超时、排队、去抖与合并请求、
// 工具执行完的刷新；宿主与会话（synthetic）收下发出的事件。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quietly } from './gate-helpers.mjs';
import {
  FAKE_GIT, captureLogs, fakeSpawn, git, initRepo, isFile, loadKernelBundle, loadSessionManager, pause, porcelain,
  realGitPath, repoReply, setEnv, tempRoot, testHome, until, writeFiles,
} from './git-helpers.mjs';

const [K, SessionManager] = await Promise.all([loadKernelBundle({
  git: 'src/kernel/git.ts', ws: 'src/kernel/workspace.ts', tl: 'src/kernel/timeline.ts',
  snap: 'src/kernel/snapshots.ts', rw: 'src/kernel/rewind.ts', sess: 'src/kernel/sessionWorkspace.ts',
  shared: 'src/shared/workspace.ts', team: 'src/shared/team.ts',
}), loadSessionManager()]);
const { git: G, ws: W, tl: T, snap: N, rw: R, sess: SW, shared: S, team: TM } = K;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = tempRoot('mgs-');
const restoreEnv = setEnv({ MORI_GIT_PATH: undefined });
const restoreHome = testHome(tmp.root);
// 一轮结束、Rewind 的用例真的拍快照：快照目录在临时目录里，上限按 §19.1 注入很小的值
G.setSnapshotsDir(join(tmp.root, 's'));
N.configureSnapshots({ limits: { maxFileBytes: 1024, maxNewFiles: 20, batch: 5, keepTurns: 3 } });
after(() => {
  restoreHome();
  restoreEnv();
  tmp.remove();
});

/** 替身仓库的根（synthetic，不存在） */
const FAKE_ROOT = 'C:\\mori-test\\repo';
/** 宿主给的快照状态（synthetic） */
const SNAP_ON = { state: 'on', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [], nestedTotal: 0 };
/** 没有宿主或宿主出错时的快照状态（§3.5） */
const SNAP_OFF = { ...SNAP_ON, state: 'off' };
/** 对话本身（没有 Team 时，sessionWorkspace.baseAgent） */
const MORI = Object.freeze({ role: 'mori', task: null, self: true });
const H = 'a'.repeat(40);
const Z = '0'.repeat(40);

let fakeCwds = 0;
/** @brief 替身用的新工作路径（synthetic，不存在；每个用例一个，模块里的读状态按路径分开）。 */
function fakeCwd() {
  fakeCwds += 1;
  return `${FAKE_ROOT}\\c${fakeCwds}`;
}

/** G 现在用的是真实 git（'real'）还是替身；换依赖会让 G 重新找 git，已经是真实 git 时不重复换（少起 --version） */
let mode = null;

/** @brief 让 G 用本机真实的 git。 */
function useReal() {
  if (mode === 'real') return;
  G.configureGit({ spawn: nodeSpawn, candidates: () => [realGitPath()], exists: isFile });
  mode = 'real';
}

/** @brief 让 G 用替身（候选只有 FAKE_GIT，存在）。 */
function useFake(respond) {
  const fake = fakeSpawn(respond);
  G.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => true });
  mode = 'fake';
  return fake;
}

/**
 * @brief 接上一个宿主（synthetic）：users 是 { sessionId, cwd, fail? }，每个会话收下自己的事件。
 * @param users 打开的用户会话
 * @param snapshots 快照状态（函数，按 cwd）
 * @return { events: { 会话 id: 事件[] }, asked: usersAt 收到的路径 }
 */
function useHost(users, snapshots = () => SNAP_ON) {
  const events = Object.fromEntries(users.map((user) => [user.sessionId, []]));
  const asked = [];
  W.configureWorkspace({
    usersAt: (cwd) => {
      asked.push(cwd);
      return users.filter((user) => user.cwd === cwd).map((user) => ({ sessionId: user.sessionId,
        emit: (event) => {
          if (user.fail) throw new Error('boom');
          events[user.sessionId].push(event);
        } }));
    },
    snapshotState: snapshots,
  });
  return { events, asked };
}

/** 真实仓库的用例共用的宿主（synthetic）：并行的用例各在自己的工作路径上登记会话与快照状态，不互相换掉宿主 */
const realHost = { users: new Map(), snapshots: new Map() };

/** @brief 接上共用的宿主：没登记的工作路径没有会话、快照状态为 SNAP_ON。 */
function useRealHost() {
  W.configureWorkspace({
    usersAt: (cwd) => realHost.users.get(cwd) ?? [],
    snapshotState: (cwd) => (realHost.snapshots.get(cwd) ?? (() => SNAP_ON))(cwd),
  });
}

/** @brief 按路径、分组排序（git 的输出顺序不在断言里）。 */
function sorted(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path) || a.group.localeCompare(b.group));
}

/** @brief 一行 1 记录（synthetic）。 */
const one = (xy, path) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;

/** @brief 等几轮 I/O（让本不该起来的 git 调用有机会起来）。 */
async function turns(count = 5) {
  for (let i = 0; i < count; i += 1) await new Promise((done) => setImmediate(done));
}

/** @brief sessionWorkspace 的会话（synthetic 的 WorkspaceEntry，只有 workspaceStatus 与 usersAt 用到的字段）。 */
function sessionEntry(sessionId, cwd, kind = 'user', headless = false, emit = () => undefined) {
  return { session: { sessionId }, cwd, kind, headless, emit };
}

// ---- FS-03、FS-04、FS-05 真实仓库：认仓库、readStatus、一轮结束与 Rewind 之后的读 ----

/** 主检出（synthetic）：README.md 与 app/x.txt，一次提交；第一个用到它的用例建 */
let mainRepo = null;
function mainCheckout() {
  mainRepo ??= initRepo(join(tmp.root, 'main'), { 'README.md': 'r\n', 'app/x.txt': 'x\n' });
  return mainRepo;
}

/** 还没有提交的仓库（synthetic）；第一个用到它的用例建 */
let emptyRepo = null;
function noCommitRepo() {
  emptyRepo ??= initRepo(join(tmp.root, 'nocommit'));
  return emptyRepo;
}

/**
 * @brief 各种状态的真实仓库（synthetic）：c.txt 未合并、a.txt 暂存后又改、old.txt 改名为 "new name.txt"、
 *        app/b.txt 未暂存的修改、newdir/ 未跟踪。未合并不靠真的合并（少起几个 git）：照 git update-index 的
 *        --index-info 把 c.txt 的第 0 阶段换成第 1–3 阶段（合并冲突在 index 里就是这样，git status 报 UU）。
 * @return { root, head }
 */
async function statusRepo() {
  const root = await initRepo(join(tmp.root, 'st'), { 'README.md': 'r\n', 'a.txt': 'a\n', 'c.txt': 'base\n',
    'old.txt': 'old\n', 'app/b.txt': 'b\n' });
  writeFiles(root, { 'a.txt': 'staged\n' });
  await git(root, ['add', 'a.txt']);
  writeFiles(root, { 'a.txt': 'unstaged\n', 'app/b.txt': 'changed\n', 'newdir/x.txt': 'x\n' });
  await git(root, ['mv', 'old.txt', 'new name.txt']);
  const [head, blob] = (await git(root, ['rev-parse', 'HEAD', 'HEAD:c.txt'])).split(/\r?\n/);
  const stages = [`0 ${Z}\tc.txt`, ...[1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tc.txt`)];
  await git(root, ['update-index', '--index-info'], [0], `${stages.join('\n')}\n`);
  return { root, head };
}

/** statusRepo 的 git status（§3.5 的表） */
const STATUS_FILES = [
  { path: 'a.txt', from: null, group: 'staged', code: 'M' },
  { path: 'a.txt', from: null, group: 'unstaged', code: 'M' },
  { path: 'app/b.txt', from: null, group: 'unstaged', code: 'M' },
  { path: 'c.txt', from: null, group: 'conflicted', code: 'U' },
  { path: 'new name.txt', from: 'old.txt', group: 'staged', code: 'R' },
  { path: 'newdir/', from: null, group: 'untracked', code: '?' },
];

let repoOfStatus = null;
/** @brief statusRepo 只建一次。 */
function sharedStatusRepo() {
  repoOfStatus ??= statusRepo();
  return repoOfStatus;
}

/** @brief pi 的 user 消息（synthetic）。 */
function userMessage(text) {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** @brief pi 的 assistant 消息（synthetic 的模型字段）。 */
function assistantMessage(text) {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'synthetic', provider: 'synthetic', model: 'synthetic',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

/**
 * @brief 刷新时机的用户会话替身（synthetic）：pi 的内存 SessionManager，在快照模块里登记，mori-snapshots 注册在只记
 *        处理函数的 pi 上；在共用宿主上登记这个工作路径（收 mori.workspace_status 的载荷，并记下发出那一刻会话文件里
 *        已有的 mori.turn_changes 的种类；快照状态取快照模块的）；
 *        session 是给 rewind.ts 的 RewindSession（不忙、没有 open 的需求，只恢复代码时不导航）。
 * @param cwd 工作路径
 */
function openTurnUser(cwd) {
  const manager = SessionManager.inMemory(cwd);
  const sessionId = manager.getSessionId();
  const user = { sessionId, cwd, manager, events: [], statuses: [], kindsAtSend: [], handlers: new Map() };
  const emit = (event) => user.events.push(event);
  N.registerSnapshotUser({ sessionId, cwd, sessionManager: manager, emit, headless: false });
  N.snapshotExtension({ userSessionId: sessionId, self: true, headless: false, agent: () => MORI })({
    on: (name, handler) => user.handlers.set(name, [...(user.handlers.get(name) ?? []), handler]) });
  const status = (event) => {
    user.statuses.push(event.status);
    user.kindsAtSend.push(recordKinds(user));
  };
  realHost.users.set(cwd, [{ sessionId, emit: status }]);
  realHost.snapshots.set(cwd, (path) => N.snapshotState(path));
  user.session = { sessionId, cwd, sessionManager: manager, navigateTree: async () => ({ cancelled: true }),
    busy: () => false, openRequests: () => [], recordPick: () => undefined, refsOf: () => null, emit };
  return user;
}

/** @brief 依次 await 这个会话的 pi 上某个事件的处理函数（同 pi 的扩展执行）。 */
async function fireTurn(user, name, event = {}) {
  const ctx = { cwd: user.cwd, sessionManager: user.manager };
  for (const handler of user.handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
}

/** @brief 会话文件里 mori.turn_changes 记录的种类，按文件顺序。 */
function recordKinds(user) {
  return user.manager.getEntries().filter((entry) => entry.type === 'custom'
    && entry.customType === 'mori.turn_changes').map((entry) => entry.data.kind);
}

/**
 * @brief 等这个会话收到一次新读的 git 状态：读完的时刻晚于 after（只重发快照状态时读完的时刻不变，不算）。
 * @return 新读到的状态
 */
async function nextRead(user, after) {
  await until(() => user.statuses.some((status) => status.at > after), 15_000);
  return user.statuses.find((status) => status.at > after);
}

/** @brief FS-03 认仓库的真实仓库用例（并行）。 */
function repoInfoCases() {
  test('FS-03 repo root: toplevel, commonDir = gitDir = <root>\\.git, not a worktree, has a commit', async () => {
    useReal();
    const root = await mainCheckout();
    const dotGit = join(root, '.git');
    assert.deepEqual(await W.repoInfo(root), { repo: { toplevel: root, commonDir: dotGit, gitDir: dotGit,
      isWorktree: false, hasCommit: true }, error: null });
  });

  test('FS-03 a subfolder: toplevel is the repo root', async () => {
    useReal();
    const root = await mainCheckout();
    const { repo, error } = await W.repoInfo(join(root, 'app'));
    assert.equal(error, null);
    assert.deepEqual(repo, { toplevel: root, commonDir: join(root, '.git'), gitDir: join(root, '.git'),
      isWorktree: false, hasCommit: true });
  });

  test('FS-03 a linked worktree: isWorktree, commonDir is the main checkout\'s .git', async () => {
    useReal();
    const root = await mainCheckout();
    const wt = join(tmp.root, 'wt');
    await git(root, ['worktree', 'add', '--quiet', '-b', 'wt', wt]);
    assert.deepEqual(await W.repoInfo(wt), { repo: { toplevel: wt, commonDir: join(root, '.git'),
      gitDir: join(root, '.git', 'worktrees', 'wt'), isWorktree: true, hasCommit: true }, error: null });
  });

  test('FS-03 a repo without commits: hasCommit is false', async () => {
    useReal();
    const root = await noCommitRepo();
    assert.deepEqual(await W.repoInfo(root), { repo: { toplevel: root, commonDir: join(root, '.git'),
      gitDir: join(root, '.git'), isWorktree: false, hasCommit: false }, error: null });
  });
}

/** @brief 分支行的几种写法（真实仓库）：还没有提交、有上游没有 branch.ab、领先落后、detached。 */
async function branchForms() {
  useReal();
  useRealHost();
  const initial = await noCommitRepo();
  writeFiles(initial, { 'n.txt': 'n\n' });
  const first = await W.readStatus(initial);
  assert.deepEqual(first.branch, { head: 'main', oid: null, upstream: null, ahead: null, behind: null });
  assert.deepEqual({ files: first.files, hasCommit: first.repo.hasCommit },
    { files: [{ path: 'n.txt', from: null, group: 'untracked', code: '?' }], hasCommit: false });
  const up = join(tmp.root, 'up');
  mkdirSync(up);
  await git(up, ['init', '--quiet', '-b', 'main']);
  await git(up, ['commit', '--quiet', '--allow-empty', '-m', 'first']);
  await git(up, ['commit', '--quiet', '--allow-empty', '-m', 'second']);
  // 上游（远端 origin 的 main）写进仓库的配置（synthetic），远端的 ref 还没有
  appendFileSync(join(up, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/r.git\n'
    + '\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    + '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
  const head = await git(up, ['rev-parse', 'HEAD']);
  assert.deepEqual((await W.readStatus(up)).branch,
    { head: 'main', oid: head, upstream: 'origin/main', ahead: null, behind: null });
  await git(up, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1']);
  assert.deepEqual((await W.readStatus(up)).branch,
    { head: 'main', oid: head, upstream: 'origin/main', ahead: 1, behind: 0 });
  await git(up, ['checkout', '--quiet', '--detach']);
  assert.deepEqual((await W.readStatus(up)).branch,
    { head: null, oid: head, upstream: null, ahead: null, behind: null });
}

/** @brief FS-04 readStatus 的真实仓库用例（并行）。 */
function readStatusCases() {
  test('FS-04 readStatus on a real repo: staged+unstaged as two entries, a rename with from, a conflict, an '
    + 'untracked folder; branch head and oid; the snapshot state from the host', async () => {
    useReal();
    useRealHost();
    const { root, head } = await sharedStatusRepo();
    const before = Date.now();
    const status = await W.readStatus(root);
    assert.equal(status.cwd, root);
    assert.deepEqual(status.git.state, 'ok');
    assert.equal(status.repo.toplevel, root);
    assert.deepEqual(status.branch, { head: 'main', oid: head, upstream: null, ahead: null, behind: null });
    assert.deepEqual(sorted(status.files), STATUS_FILES);
    assert.deepEqual({ total: status.total, truncated: status.truncated, error: status.error },
      { total: 6, truncated: false, error: null });
    assert.deepEqual(status.snapshots, SNAP_ON);
    assert.ok(status.at >= before);
  });

  test('FS-04 readStatus from a subfolder: the whole repo, paths relative to the repo root', async () => {
    useReal();
    useRealHost();
    const { root } = await sharedStatusRepo();
    const cwd = join(root, 'app');
    const status = await W.readStatus(cwd);
    assert.equal(status.cwd, cwd);
    assert.equal(status.repo.toplevel, root);
    assert.deepEqual(sorted(status.files), STATUS_FILES);
  });

  test('FS-04 readStatus branch line forms: (initial) without commits, (detached), an upstream without '
    + 'branch.ab, ahead and behind', branchForms);
}

/**
 * @brief 一轮（真实快照）：before_agent_start 等开始快照做完、写下你的消息、agent_start、改文件、写下回复、
 *        agent_settled（结束快照排进队列，不等）。
 * @return 你的消息的条目 id
 */
async function runTurn(user) {
  await fireTurn(user, 'before_agent_start', { prompt: 'go', messageType: 'user', systemPrompt: '',
    systemPromptOptions: {} });
  const round = user.manager.appendMessage(userMessage('go'));
  await fireTurn(user, 'agent_start');
  writeFiles(user.cwd, { 'a.txt': 'two\n', 'b.txt': 'new\n' });
  user.manager.appendMessage(assistantMessage('Done.'));
  await fireTurn(user, 'agent_settled', { aborted: false });
  return round;
}

/**
 * @brief 一轮结束、恢复代码的 Rewind、它的 Undo 各读一次 git 状态（真实 git，§3.5“什么时候读”）。工作路径不是 git
 *        仓库（synthetic 的文件夹）：快照照拍，读 git 状态只跑一个 rev-parse，在整组并行时少起十几个 git 进程。
 */
async function readsAfterTurnRewindUndo() {
  useReal();
  useRealHost();
  const cwd = join(tmp.root, 'tt');
  writeFiles(cwd, { 'a.txt': 'one\n' });
  const user = openTurnUser(cwd);
  // 读了几次：收到的状态里不同的读完时刻（只重发快照状态时读完的时刻不变）
  const reads = () => new Set(user.statuses.map((status) => status.at)).size;
  const text = () => readFileSync(join(cwd, 'a.txt'), 'utf8');
  try {
    const settledAt = Date.now() - 1;
    const round = await runTurn(user);
    assert.equal(reads(), 0);
    const turnRead = await nextRead(user, settledAt);
    // 这次读的结果发出时，结束快照的两条记录已写进会话文件（读在结束快照做完之后）
    assert.deepEqual({ reads: reads(), repo: turnRead.repo, kinds: user.kindsAtSend[0] },
      { reads: 1, repo: null, kinds: ['changes', 'run'] });
    const done = await R.rewind(user.session, { entryId: round, code: true, conversation: false });
    assert.equal(done.kind, 'done');
    const rewindRead = await nextRead(user, turnRead.at);
    assert.deepEqual({ reads: reads(), a: text() }, { reads: 2, a: 'one\n' });
    const undone = await R.undoRewind(user.session, { undoId: done.entryId });
    assert.equal(undone.kind, 'done');
    await nextRead(user, rewindRead.at);
    assert.deepEqual({ reads: reads(), a: text() }, { reads: 3, a: 'two\n' });
    // 没有多出来的再读（合并的再读会紧接着上一次读完起来）
    await pause(150);
    assert.equal(reads(), 3);
  } finally {
    N.unregisterSnapshotUser(user.sessionId);
    realHost.users.delete(cwd);
  }
}

// 真实仓库的用例互不依赖（各用自己的仓库或只读共用的仓库，宿主是共用的 realHost），三组与组里的用例都并行跑以省时间；
// 准备数据的 git 是异步的，几个用例的 git 进程真的同时跑。截日志的用例（不是仓库、文件夹不存在）不放进来，免得截到
// 别的用例的日志
describe('FS-03 FS-04 FS-05 real git repos (independent groups and tests in parallel)', { concurrency: true }, () => {
  describe('FS-03 repoInfo on real repos', { concurrency: true }, repoInfoCases);
  describe('FS-04 readStatus on real repos', { concurrency: true }, readStatusCases);
  test('FS-05 real git: agent_settled reads the git status once, after the end snapshot wrote its records; a code '
    + 'Rewind and its Undo each read it once when done', readsAfterTurnRewindUndo);
});

// ---- FS-03 认仓库：不是仓库、文件夹不存在（截日志，不并行）与替身 git ----

test('FS-03 not a repo: repo null and error null, nothing logged', async () => {
  useReal();
  await G.findGit();
  const plain = join(tmp.root, 'plain');
  mkdirSync(plain);
  const { value, errors } = await quietly(() => W.repoInfo(plain));
  assert.deepEqual(value, { repo: null, error: null });
  assert.deepEqual(errors, []);
});

test('FS-03 a working folder that does not exist is an error, not "not a repo"', async () => {
  useReal();
  const gone = join(tmp.root, 'gone');
  const { value } = await quietly(() => W.repoInfo(gone));
  assert.deepEqual(value, { repo: null, error: `folder not found: ${gone}` });
});

test('FS-03 a synthetic git answering rev-parse with exit 128 and dubious ownership: an error with the original '
  + 'line without fatal:, not "not a repo"', async () => {
  const cwd = fakeCwd();
  const slash = cwd.replace(/\\/g, '/');
  const stderr = `fatal: detected dubious ownership in repository at '${slash}'\n'${slash}' is owned by:\n`
    + '\tBUILTIN/Administrators (S-1-5-32-544)\nbut the current user is:\n\tPC/user (S-1-5-21-1)\n'
    + `To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${slash}\n`;
  const fake = useFake(repoReply(FAKE_ROOT, (call) => (call.sub === 'rev-parse' ? { code: 128, stderr } : undefined)));
  const original = `detected dubious ownership in repository at '${slash}'`;
  const { value, errors } = await quietly(() => W.repoInfo(cwd));
  assert.deepEqual(value, { repo: null, error: original });
  assert.ok(errors.includes(`[kernel] git rev-parse failed in ${cwd}: ${original}`), errors.join('\n'));
  useHost([{ sessionId: 'A', cwd }]);
  const status = (await quietly(() => W.readStatus(cwd))).value;
  assert.deepEqual({ repo: status.repo, error: status.error, files: status.files, branch: status.branch },
    { repo: null, error: original, files: [], branch: null });
  assert.equal(fake.of('status').length, 0);
});

test('FS-03 exit 128 with "not a git repository" is not a repo; other failures are errors', async () => {
  const cases = [
    [{ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
      { repo: null, error: null }],
    [{ code: 128, stderr: 'fatal: unsafe repository\n' }, { repo: null, error: 'unsafe repository' }],
    [{ code: 1, stderr: 'fatal: not a git repository\n' }, { repo: null, error: 'not a git repository' }],
    [{ code: 0, stdout: 'C:/only/one/line\n' }, { repo: null, error: 'git rev-parse gave unexpected output' }],
  ];
  for (const [reply, expected] of cases) {
    useFake(repoReply(FAKE_ROOT, (call) => (call.args.includes('--show-toplevel') ? reply : undefined)));
    assert.deepEqual((await quietly(() => W.repoInfo(fakeCwd()))).value, expected, JSON.stringify(reply));
  }
});

// ---- FS-04 porcelain v2 的解析（timeline.ts，synthetic 的输出） ----

test('FS-04 1 lines: X not . is staged, Y not . is unstaged; staged and unstaged are two entries', () => {
  const out = porcelain([one('.M', 'src/a b.ts'), one('MM', 'both.txt'),
    `1 A. N... 000000 100644 100644 ${Z} ${H} added.txt`, `1 .D N... 100644 100644 000000 ${H} ${H} gone.txt`]);
  assert.deepEqual(T.parsePorcelainV2(out, 500).files, [
    { path: 'src/a b.ts', from: null, group: 'unstaged', code: 'M' },
    { path: 'both.txt', from: null, group: 'staged', code: 'M' },
    { path: 'both.txt', from: null, group: 'unstaged', code: 'M' },
    { path: 'added.txt', from: null, group: 'staged', code: 'A' },
    { path: 'gone.txt', from: null, group: 'unstaged', code: 'D' },
  ]);
});

test('FS-04 2 lines take the NUL-separated original path as from', () => {
  const out = porcelain([`2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts`, 'old name.ts',
    `2 RM N... 100644 100644 100644 ${H} ${H} R087 moved.txt`, 'orig.txt', one('.M', 'after.txt')]);
  const parsed = T.parsePorcelainV2(out, 500);
  assert.deepEqual(parsed.files, [
    { path: 'new name.ts', from: 'old name.ts', group: 'staged', code: 'R' },
    { path: 'moved.txt', from: 'orig.txt', group: 'staged', code: 'R' },
    { path: 'moved.txt', from: 'orig.txt', group: 'unstaged', code: 'M' },
    { path: 'after.txt', from: null, group: 'unstaged', code: 'M' },
  ]);
  assert.equal(parsed.total, 4);
});

test('FS-04 u lines are conflicted (U), ? lines untracked (folders end in /), other lines ignored', () => {
  const out = porcelain([`u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} con flict.txt`, '? dir/',
    '? caf\u00e9 \u4e2d.txt', '! ignored.txt', '# stash 2']);
  const parsed = T.parsePorcelainV2(out, 500);
  assert.deepEqual(parsed.files, [
    { path: 'con flict.txt', from: null, group: 'conflicted', code: 'U' },
    { path: 'dir/', from: null, group: 'untracked', code: '?' },
    { path: 'caf\u00e9 \u4e2d.txt', from: null, group: 'untracked', code: '?' },
  ]);
  assert.deepEqual({ total: parsed.total, truncated: parsed.truncated, branch: parsed.branch },
    { total: 3, truncated: false, branch: null });
});

test('FS-04 branch lines: (initial), (detached), an upstream without branch.ab, with branch.ab, none', () => {
  const parse = (records) => T.parsePorcelainV2(porcelain(records), 500).branch;
  assert.deepEqual(parse(['# branch.oid (initial)', '# branch.head main']),
    { head: 'main', oid: null, upstream: null, ahead: null, behind: null });
  assert.deepEqual(parse([`# branch.oid ${H}`, '# branch.head (detached)']),
    { head: null, oid: H, upstream: null, ahead: null, behind: null });
  assert.deepEqual(parse([`# branch.oid ${H}`, '# branch.head main', '# branch.upstream origin/main']),
    { head: 'main', oid: H, upstream: 'origin/main', ahead: null, behind: null });
  assert.deepEqual(parse([`# branch.oid ${H}`, '# branch.head feat/x', '# branch.upstream origin/feat/x',
    '# branch.ab +2 -13']), { head: 'feat/x', oid: H, upstream: 'origin/feat/x', ahead: 2, behind: 13 });
  assert.equal(parse([one('.M', 'a.txt')]), null);
  assert.deepEqual(T.parsePorcelainV2(Buffer.alloc(0), 500),
    { branch: null, files: [], total: 0, truncated: false });
});

test('FS-04 the cap keeps the first <limit> entries and total counts all; STATUS_FILE_LIMIT is 500', () => {
  assert.equal(S.STATUS_FILE_LIMIT, 500);
  const small = T.parsePorcelainV2(porcelain([one('MM', 'a.txt'), '? b.txt', '? c.txt', '? d.txt']), 3);
  assert.deepEqual(small.files.map((file) => `${file.group}:${file.path}`),
    ['staged:a.txt', 'unstaged:a.txt', 'untracked:b.txt']);
  assert.deepEqual({ total: small.total, truncated: small.truncated }, { total: 5, truncated: false });
  const names = Array.from({ length: 501 }, (_, i) => `? f${String(i).padStart(3, '0')}.txt`);
  const big = T.parsePorcelainV2(porcelain(names), S.STATUS_FILE_LIMIT);
  assert.deepEqual({ files: big.files.length, last: big.files.at(-1).path, total: big.total },
    { files: 500, last: 'f499.txt', total: 501 });
});

test('FS-04 output cut off by the cap is parsed up to the last whole entry: truncated, total = parsed', () => {
  const whole = porcelain([`# branch.oid ${H}`, '# branch.head main', '? a.txt', one('.M', 'b.txt')]);
  const cut = Buffer.concat([whole, Buffer.from('? c.t')]);
  assert.deepEqual(T.parsePorcelainV2(cut, 500), { branch: { head: 'main', oid: H, upstream: null, ahead: null,
    behind: null }, files: [{ path: 'a.txt', from: null, group: 'untracked', code: '?' },
    { path: 'b.txt', from: null, group: 'unstaged', code: 'M' }], total: 2, truncated: true });
  // 2 行的原路径被截掉：这一条整条不算
  const rename = Buffer.from(`? a.txt\0${`2 R. N... 100644 100644 100644 ${H} ${H} R100 new.txt`}\0old.t`);
  const parsed = T.parsePorcelainV2(rename, 500);
  assert.deepEqual({ files: parsed.files.map((file) => file.path), total: parsed.total, truncated: parsed.truncated },
    { files: ['a.txt'], total: 1, truncated: true });
});

test('FS-04 readStatus runs git status and both rev-parse calls with the §3.4/§3.5 arguments', async () => {
  const fake = useFake(repoReply(FAKE_ROOT));
  useHost([]);
  const cwd = fakeCwd();
  await W.readStatus(cwd);
  const [status] = fake.of('status');
  assert.deepEqual(status.args, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']);
  assert.deepEqual({ cwd: status.options.cwd, revParse: fake.of('rev-parse').map((call) => call.args) }, {
    cwd,
    revParse: [['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']],
  });
});

test('FS-04 user-repo calls queue on the repo root: a read in <R> waits while the git status of a read in '
  + '<R>\\app runs', async () => {
  const root = fakeCwd();
  const sub = `${root}\\app`;
  let held = false;
  const fake = useFake(repoReply(root, (call) => {
    if (call.sub !== 'status' || held) return undefined;
    held = true;
    return { hold: true };
  }));
  useHost([]);
  const first = W.readStatus(sub);
  await until(() => fake.of('status').length === 1);
  const second = W.readStatus(root);
  await turns();
  // 第二个读在仓库根里：它的调用都排在第一个读的 git status 之后（键是仓库根，不是各自的工作路径）
  assert.deepEqual(fake.calls.filter((call) => call.options.cwd === root), []);
  fake.of('status')[0].finish({ stdout: porcelain(['# branch.head main', '? a.txt']) });
  const [inSub, inRoot] = await Promise.all([first, second]);
  assert.deepEqual(fake.of('status').map((call) => call.options.cwd), [sub, root]);
  assert.deepEqual([inSub.repo.toplevel, inRoot.repo.toplevel, inSub.files[0].path], [root, root, 'a.txt']);
});

// ---- FS-04 readStatus（替身：上限、截断、超时、失败） ----

test('FS-04 readStatus with 501 files lists 500 and total 501', async () => {
  const names = Array.from({ length: 501 }, (_, i) => `? f${String(i).padStart(3, '0')}.txt`);
  useFake(repoReply(FAKE_ROOT, (call) => (call.sub === 'status'
    ? { stdout: porcelain([`# branch.oid ${H}`, '# branch.head main', ...names]) } : undefined)));
  useHost([]);
  const status = await W.readStatus(fakeCwd());
  assert.deepEqual({ files: status.files.length, total: status.total, truncated: status.truncated,
    error: status.error }, { files: 500, total: 501, truncated: false, error: null });
});

test('FS-04 readStatus with more than 4 MB of output: whole entries only, truncated, total = parsed, logged',
  async () => {
    // 长名字（约 1 KB 一条）：几千条就超过 4 MB，造数据与解析都快
    const long = 'x'.repeat(1000);
    const names = Array.from({ length: 4300 }, (_, i) => `? f${String(i).padStart(6, '0')}${long}.txt`);
    const out = porcelain([`# branch.oid ${H}`, '# branch.head main', ...names]);
    assert.ok(out.length > 4 * 1024 * 1024);
    const kept = out.subarray(0, 4 * 1024 * 1024);
    const whole = kept.subarray(0, kept.lastIndexOf(0) + 1).toString('latin1').split('\0').length - 1 - 2;
    const fake = useFake(repoReply(FAKE_ROOT, (call) => (call.sub === 'status' ? { stdout: out } : undefined)));
    useHost([]);
    const cwd = fakeCwd();
    const { value, errors } = await quietly(() => W.readStatus(cwd));
    assert.deepEqual({ files: value.files.length, first: value.files[0].path, total: value.total,
      truncated: value.truncated, error: value.error, head: value.branch.head },
    { files: 500, first: `f000000${long}.txt`, total: whole, truncated: true, error: null, head: 'main' });
    assert.ok(whole < names.length);
    assert.equal(fake.of('status')[0].kills, 1);
    assert.deepEqual(errors, [`[kernel] git status output exceeded ${4 * 1024 * 1024} bytes in ${cwd}`]);
  });

test('FS-04 a git status that takes longer than 10 s is an error: no files, no branch', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT, (call) => (call.sub === 'status' ? { hold: true } : undefined)));
  await G.findGit();
  useHost([]);
  const cwd = fakeCwd();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = captureLogs();
  try {
    const reading = W.readStatus(cwd);
    await until(() => fake.of('status').length === 1);
    t.mock.timers.tick(9999);
    assert.equal(fake.of('status')[0].kills, 0);
    t.mock.timers.tick(1);
    const status = await reading;
    assert.deepEqual({ error: status.error, files: status.files, branch: status.branch, total: status.total,
      truncated: status.truncated, toplevel: status.repo.toplevel },
    { error: 'git took too long and was stopped', files: [], branch: null, total: 0, truncated: false,
      toplevel: FAKE_ROOT });
    assert.deepEqual(logs.errors, [`[kernel] git status timed out after 10000 ms in ${cwd}`,
      `[kernel] git status failed in ${cwd}: git took too long and was stopped`]);
  } finally {
    logs.restore();
  }
});

test('FS-04 a failing git status gives the stderr line as error, no files, no branch', async () => {
  useFake(repoReply(FAKE_ROOT, (call) => (call.sub === 'status'
    ? { code: 128, stdout: porcelain(['# branch.head main', '? a.txt']), stderr: 'fatal: index file corrupt\n' }
    : undefined)));
  useHost([]);
  const cwd = fakeCwd();
  const { value, errors } = await quietly(() => W.readStatus(cwd));
  assert.deepEqual({ error: value.error, files: value.files, branch: value.branch, total: value.total },
    { error: 'index file corrupt', files: [], branch: null, total: 0 });
  assert.deepEqual(errors, [`[kernel] git status failed in ${cwd}: index file corrupt`]);
});

test('FS-04 git missing or too old: no repo check and no git status run', async () => {
  const fake = fakeSpawn(() => ({ stdout: 'git version 2.31.0.windows.1\n' }));
  G.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => false });
  mode = 'fake';
  const { events } = useHost([{ sessionId: 'A', cwd: FAKE_ROOT }], () => SNAP_OFF);
  const missing = (await quietly(() => W.readStatus(FAKE_ROOT))).value;
  assert.deepEqual({ ...missing, at: 0 }, { cwd: FAKE_ROOT, git: { state: 'missing' }, repo: null, branch: null,
    files: [], total: 0, truncated: false, error: null, snapshots: SNAP_OFF, at: 0 });
  assert.ok(missing.at > 0);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(events.A, [{ type: 'mori.workspace_status', status: missing }]);
  G.configureGit({ exists: () => true });
  const old = (await quietly(() => W.readStatus(FAKE_ROOT))).value;
  assert.deepEqual({ git: old.git, repo: old.repo }, { git: { state: 'old', version: '2.31.0' }, repo: null });
  assert.deepEqual(fake.calls.map((call) => call.args), [['--version']]);
});

// ---- FS-01 workspace.status 重找 git（sessionWorkspace.workspaceStatus） ----

test('FS-01 git missing: readStatus and the debounced read do not search again; workspace.status does and finds '
  + 'a git placed afterwards', async (t) => {
  let placed = false;
  const fake = fakeSpawn(repoReply(FAKE_ROOT));
  G.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => placed });
  mode = 'fake';
  const cwd = fakeCwd();
  const { events } = useHost([{ sessionId: 'A', cwd }]);
  const entry = sessionEntry('A', cwd);
  assert.deepEqual((await quietly(() => SW.workspaceStatus(entry))).value.git, { state: 'missing' });
  placed = true;
  assert.deepEqual((await W.readStatus(cwd)).git, { state: 'missing' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  W.scheduleStatus(cwd);
  t.mock.timers.tick(W.STATUS_DEBOUNCE_MS);
  await until(() => events.A.length === 3);
  t.mock.timers.reset();
  assert.deepEqual(events.A.map((event) => event.status.git.state), ['missing', 'missing', 'missing']);
  assert.equal(fake.calls.length, 0);
  const found = (await quietly(() => SW.workspaceStatus(entry))).value;
  assert.deepEqual({ git: found.git, toplevel: found.repo.toplevel, statusRuns: fake.of('status').length },
    { git: { state: 'ok', version: '2.55.0' }, toplevel: FAKE_ROOT, statusRuns: 1 });
  assert.deepEqual(events.A.at(-1), { type: 'mori.workspace_status', status: found });
});

test('FS-01 git too old: only workspace.status searches again and finds a newer git; once ok it is not searched '
  + 'again', async () => {
  let version = '2.31.1';
  const fake = fakeSpawn((call) => (call.args[0] === '--version'
    ? { stdout: `git version ${version}.windows.1\n` } : repoReply(FAKE_ROOT)(call)));
  G.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => true });
  mode = 'fake';
  const cwd = fakeCwd();
  useHost([{ sessionId: 'A', cwd }]);
  const entry = sessionEntry('A', cwd);
  const versions = () => fake.calls.filter((call) => call.args[0] === '--version').length;
  assert.deepEqual((await quietly(() => SW.workspaceStatus(entry))).value.git, { state: 'old', version: '2.31.1' });
  version = '2.55.0';
  assert.deepEqual((await W.readStatus(cwd)).git, { state: 'old', version: '2.31.1' });
  assert.deepEqual({ versions: versions(), calls: fake.calls.length }, { versions: 1, calls: 1 });
  const found = (await quietly(() => SW.workspaceStatus(entry))).value;
  assert.deepEqual({ git: found.git, statusRuns: fake.of('status').length, versions: versions() },
    { git: { state: 'ok', version: '2.55.0' }, statusRuns: 1, versions: 2 });
  await SW.workspaceStatus(entry);
  assert.equal(versions(), 2);
});

test('FS-05 workspace.status for a session that is not a user session fails with Unknown session <id>', async () => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await assert.rejects(SW.workspaceStatus(sessionEntry('T1', fakeCwd(), 'task')), { message: 'Unknown session T1' });
  assert.equal(fake.calls.length, 0);
});

// ---- FS-05 刷新时机（单元层）：去抖、合并请求、发给谁 ----

test('FS-05 five tool ends within 500 ms read the status once, 500 ms after the last', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  const cwd = fakeCwd();
  const { events } = useHost([{ sessionId: 'A', cwd }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 5; i += 1) {
    W.scheduleStatus(cwd);
    t.mock.timers.tick(100);
  }
  t.mock.timers.tick(399);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.calls.length, 1);
  t.mock.timers.tick(1);
  await until(() => events.A.length === 1);
  t.mock.timers.tick(5000);
  await new Promise((done) => setImmediate(done));
  const counts = { status: fake.of('status').length, revParse: fake.of('rev-parse').length, events: events.A.length };
  assert.deepEqual(counts, { status: 1, revParse: 2, events: 1 });
  assert.equal(W.STATUS_DEBOUNCE_MS, 500);
});

test('FS-05 each working folder has its own debounce', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  const [left, right] = [fakeCwd(), fakeCwd()];
  const { events } = useHost([{ sessionId: 'L', cwd: left }, { sessionId: 'R', cwd: right }]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  W.scheduleStatus(left);
  t.mock.timers.tick(300);
  W.scheduleStatus(right);
  t.mock.timers.tick(200);
  await until(() => events.L.length === 1);
  assert.equal(events.R.length, 0);
  t.mock.timers.tick(300);
  await until(() => events.R.length === 1);
  assert.deepEqual(fake.of('status').map((call) => call.options.cwd), [left, right]);
});

test('FS-05 a request during a read gives exactly one more read, started after the first ends; its result is newer',
  async () => {
    let reads = 0;
    const fake = useFake(repoReply(FAKE_ROOT, (call) => {
      if (call.sub !== 'status') return undefined;
      reads += 1;
      return reads === 1 ? { hold: true } : { stdout: porcelain(['# branch.head main', '? second.txt']) };
    }));
    const cwd = fakeCwd();
    const { events } = useHost([{ sessionId: 'A', cwd }]);
    const first = W.readStatus(cwd);
    await until(() => fake.of('status').length === 1);
    const asked = Date.now();
    const again = [W.readStatus(cwd), W.readStatus(cwd), W.readStatus(cwd)];
    assert.ok(again.every((promise) => promise === again[0]));
    assert.notEqual(again[0], first);
    // 同一时刻只读一个：第一次读还在跑时，再读的认仓库（rev-parse）还没开始
    await turns();
    assert.equal(fake.of('rev-parse').length, 2);
    fake.of('status')[0].finish({ stdout: porcelain(['# branch.head main', '? first.txt']) });
    const [one1, two] = [await first, await again[0]];
    await new Promise((done) => setImmediate(done));
    assert.deepEqual([one1.files[0].path, two.files[0].path], ['first.txt', 'second.txt']);
    assert.deepEqual({ status: fake.of('status').length, revParse: fake.of('rev-parse').length },
      { status: 2, revParse: 4 });
    assert.ok(fake.of('status')[1].at >= asked);
    assert.ok(two.at >= asked && two.at >= one1.at);
    assert.deepEqual(events.A.map((event) => event.status), [one1, two]);
  });

test('FS-05 every open user session at the cwd gets mori.workspace_status; one at another cwd does not; '
  + 'a failing emit does not stop the others', async () => {
  useFake(repoReply(FAKE_ROOT));
  const cwd = fakeCwd();
  const { events, asked } = useHost([{ sessionId: 'A', cwd }, { sessionId: 'X', cwd, fail: true },
    { sessionId: 'B', cwd }, { sessionId: 'C', cwd: fakeCwd() }]);
  const { value, errors } = await quietly(() => W.readStatus(cwd));
  for (const id of ['A', 'B']) assert.deepEqual(events[id], [{ type: 'mori.workspace_status', status: value }]);
  assert.deepEqual(events.C, []);
  assert.ok(asked.every((path) => path === cwd));
  assert.deepEqual(errors, ['[kernel] sending the git status to X failed: boom']);
});

test('FS-05 configureSessionWorkspace: only the open user sessions at this cwd get mori.workspace_status, each in '
  + 'its own envelope (no task instance, no headless session, none elsewhere); the table is read at each send',
async () => {
  useFake(repoReply(FAKE_ROOT));
  const cwd = fakeCwd();
  const got = [];
  const entry = (sessionId, kind, at, headless = false) => sessionEntry(sessionId, at, kind, headless,
    (envelope) => got.push(envelope));
  const entries = [entry('A', 'user', cwd), entry('T', 'task', cwd), entry('Q', 'close', cwd),
    entry('H', 'user', cwd, true), entry('E', 'user', fakeCwd()), entry('B', 'user', cwd)];
  SW.configureSessionWorkspace(() => entries);
  const envelopes = (ids, status) => ids.map((sessionId) => ({ kind: 'event', sessionId,
    event: { type: 'mori.workspace_status', status } }));
  const status = await W.readStatus(cwd);
  assert.deepEqual(got, envelopes(['A', 'B'], status));
  assert.deepEqual(status.snapshots, N.snapshotState(cwd));
  entries.push(entry('C', 'user', cwd));
  got.length = 0;
  const next = await W.readStatus(cwd);
  assert.deepEqual(got, envelopes(['A', 'B', 'C'], next));
});

test('FS-05 resendStatus re-sends the last git status with the new snapshot state without running git; '
  + 'before the first read it does nothing', async () => {
  const fake = useFake(repoReply(FAKE_ROOT));
  const cwd = fakeCwd();
  let snapshots = SNAP_ON;
  const { events } = useHost([{ sessionId: 'A', cwd }], () => snapshots);
  W.resendStatus(cwd);
  assert.deepEqual({ events: events.A.length, calls: fake.calls.length }, { events: 0, calls: 0 });
  const read = await W.readStatus(cwd);
  const calls = fake.calls.length;
  snapshots = { ...SNAP_ON, state: 'paused', reason: 'Snapshots are paused.' };
  W.resendStatus(cwd);
  assert.equal(fake.calls.length, calls);
  assert.deepEqual(events.A.at(-1), { type: 'mori.workspace_status', status: { ...read, snapshots } });
  assert.equal(events.A.length, 2);
});

test('FS-05 a host whose snapshotState throws gives snapshots off and a log line', async () => {
  useFake(repoReply(FAKE_ROOT));
  const cwd = fakeCwd();
  useHost([], () => {
    throw new Error('boom');
  });
  const { value, errors } = await quietly(() => W.readStatus(cwd));
  assert.deepEqual(value.snapshots, SNAP_OFF);
  assert.deepEqual(errors, [`[kernel] reading the snapshot state of ${cwd} failed: boom`]);
});

// ---- FS-05 后台进程发起的读：mori-snapshots 的 tool_execution_end 与 agent_settled（替身 git） ----

/**
 * @brief mori-snapshots 注册在一个只记处理函数的 pi 上（synthetic，同 pi 的 runner 按注册顺序逐个 await）。
 * @param source snapshotExtension 的参数里 agent 以外的部分（userSessionId、self、headless）
 * @return { handlers, fire(name, event, cwd), tool(toolName, cwd) }
 */
function snapshotPi(source) {
  const handlers = new Map();
  N.snapshotExtension({ agent: () => MORI, ...source })({
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) });
  const sessionManager = { getSessionId: () => `pi-${source.userSessionId}`, getLeafId: () => null };
  const fire = async (name, event, cwd) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, { cwd, sessionManager });
  };
  const tool = (toolName, cwd) => fire('tool_execution_end', { toolCallId: 'call-1', toolName, result: {},
    isError: false }, cwd);
  return { handlers, fire, tool };
}

/** 改文件的工具（§3.5：duty、read 之外的）：edit、write、命令、MCP 工具与扩展工具（synthetic 的名字） */
const CHANGING_TOOLS = ['edit', 'write', 'bash', 'powershell', 'mcp__docs__search', 'synthetic_extension_tool'];

test('FS-05 five bash tool ends within 500 ms reach mori-snapshots and read the status once', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  const cwd = fakeCwd();
  const { events } = useHost([{ sessionId: 'U', cwd }]);
  const pi = snapshotPi({ userSessionId: 'U', self: true, headless: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 5; i += 1) {
    await pi.tool('bash', cwd);
    t.mock.timers.tick(100);
  }
  t.mock.timers.tick(399);
  await turns();
  assert.equal(fake.of('status').length, 0);
  t.mock.timers.tick(1);
  await until(() => events.U.length === 1);
  t.mock.timers.tick(5000);
  await turns();
  assert.deepEqual({ status: fake.of('status').length, events: events.U.length }, { status: 1, events: 1 });
});

test('FS-05 tool ends of edit, write, bash, powershell, an MCP tool and an extension tool each read once, '
  + '500 ms after', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  useHost([]);
  const pi = snapshotPi({ userSessionId: 'U', self: true, headless: false });
  const cwds = CHANGING_TOOLS.map(() => fakeCwd());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [i, name] of CHANGING_TOOLS.entries()) await pi.tool(name, cwds[i]);
  t.mock.timers.tick(499);
  await turns();
  assert.equal(fake.of('status').length, 0);
  t.mock.timers.tick(1);
  await until(() => fake.of('status').length === CHANGING_TOOLS.length);
  t.mock.timers.tick(5000);
  await turns();
  assert.deepEqual(fake.of('status').map((call) => call.options.cwd).sort(), [...cwds].sort());
});

test('FS-05 tool ends of read, grep, find, ls, ask_user_question, memory and the TaskBoard tools never read the '
  + 'status', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  useHost([]);
  const pi = snapshotPi({ userSessionId: 'U', self: true, headless: false });
  const cwd = fakeCwd();
  const quiet = ['read', 'grep', 'find', 'ls', 'ask_user_question', 'memory', ...TM.TEAM_TOOLS];
  assert.equal(TM.TEAM_TOOLS.length, 11);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const name of quiet) await pi.tool(name, cwd);
  t.mock.timers.tick(5000);
  await turns();
  assert.deepEqual(fake.calls.map((call) => call.args), [['--version']]);
});

test('FS-05 tool ends of an instance and of a headless enhancement session also read the status; the headless '
  + 'one has no other handler', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  useHost([]);
  const instance = snapshotPi({ userSessionId: 'U', self: false, headless: false });
  const headless = snapshotPi({ userSessionId: 'E', self: true, headless: true });
  assert.deepEqual([...headless.handlers.keys()], ['tool_execution_end']);
  const [a, b] = [fakeCwd(), fakeCwd()];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await instance.tool('edit', a);
  await headless.tool('write', b);
  t.mock.timers.tick(500);
  await until(() => fake.of('status').length === 2);
  assert.deepEqual(fake.of('status').map((call) => call.options.cwd).sort(), [a, b].sort());
});

test('FS-05 agent_settled of the user session\'s own run without an end snapshot reads at once (no debounce); an '
  + 'instance\'s agent_settled does not read', async (t) => {
  const fake = useFake(repoReply(FAKE_ROOT));
  await G.findGit();
  useHost([]);
  // 没在快照模块里登记的会话（synthetic）：没有开始快照，也就没有结束快照
  const own = snapshotPi({ userSessionId: 'unregistered-user', self: true, headless: false });
  const instance = snapshotPi({ userSessionId: 'unregistered-owner', self: false, headless: false });
  const [a, b] = [fakeCwd(), fakeCwd()];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await instance.fire('agent_settled', { aborted: false }, b);
  await own.fire('agent_settled', { aborted: false }, a);
  await until(() => fake.of('status').length === 1);
  await turns();
  assert.deepEqual(fake.of('status').map((call) => call.options.cwd), [a]);
});

test('FS-05 kernel/git.ts, workspace.ts and snapshots.ts use no fs.watch, watchFile or setInterval', () => {
  for (const file of ['git.ts', 'workspace.ts', 'snapshots.ts']) {
    const text = readFileSync(join(appRoot, 'src', 'kernel', file), 'utf8');
    assert.doesNotMatch(text, /fs\.watch|\bwatch\(|watchFile|setInterval/, file);
  }
});
