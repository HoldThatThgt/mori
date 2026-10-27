// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-changes：git 状态、快照、右栏 Changes 与顶栏
// +N −M。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：关键词模式、
// 脚本 fs-git，scenarios/fs-git.mjs），逐条验收这些编号在 App 层的通过条件：
//   FS-05 刷新时机、FS-06 内部仓库、FS-08 上限与暂停的两种说明、FS-09 两轮的归属、FS-10 运行记录与开始快照的停止、
//   FS-11 一轮的改动记录、FS-12 This session、FS-13 git 状态界面、FS-14 命令和后台 Agent 改的都在、FS-20 保留与整理、
//   FS-22 退出与崩溃、FS-23 顶栏 +N −M、FS-26 嵌套 git 仓库的说明。
// 依据：file-system.md §3–§5、§12、§14、§17，状态表 docs/v1/screens/fs-changes.md、fs-rewind.md，
// docs/v1/fs-checks.md“负责人不在时定下的选择”。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-changes.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-changes(-packaged).json（--only 时 fs-partial-app-changes…，不计入覆盖检查），截图与 app.log
// 在 test-results/fs-app-changes/。端口：合成端点 5010，记录代理 5011（fs-helpers FS_PORTS.changes）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData），快照目录另建
// （MORI_SNAPSHOTS_DIR）；临时目录 ROOT 下的项目见 makeProjects（是不是 git 仓库按条目，git 仓库用真实 git 建）；
// 启动后先 away.set { timeout: 'never' }；跑工具的会话先切到 Full access（工作路径里的编辑、写入、命令不出卡）；
// Git for Windows 的启动器 cmd\git.exe 在时 MORI_GIT_PATH 指向它（FS-10 停止、关闭时要结束整棵 git 进程树）。
// 步骤有先后：后面的步骤用前面的会话与轮（同 fs-app-work），--only 时缺了前面的步骤会记成步骤失败。
// 最后一步另起一个 App，MORI_GIT_PATH 指向不存在的路径（§19.1 没装 git 的步骤，开发机装着 Git for Windows 也是 missing）。

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitMessage, gitStep, keywordSteps, writeManyFiles } from '../fake-endpoint/scenarios/fs-git.mjs';
import { killKernel } from './lib.mjs';
import {
  appLogLines, brief, closeFsApp, fsArgs, fsRecorder, fsRoot, fsUserData, kernelEvents, openFsSession, paneSel,
  paneState, poll, readText, reloadFsUi, reopenFs, runSuite, same, samePath, seedFsUserData, sendFs, sleep,
  startFsApp, startFsEndpoint, underPath, waitIdleFs,
} from './fs-helpers.mjs';
import {
  GIT_LAUNCHER, STATUS_ARGS, TEXT, backToChanges, branchChanges, brokenProject, canonical, changesOf, chooseRewind,
  clearComposer, clickLines, clickOpen, clickRefresh, closeRewindMenu, commit, commitExists, contentSize, deleteRefs,
  diffHasLines, ensureFull, expandTurnFile, fileInCommit, firstGitError, freshProject, git, gitProcesses, gitView,
  goneWithin, groupsProject, hasLauncherPair, headName, internalRepo, launcherEnv, lineSums, linesLabel, linesText,
  linesView, makeProject, manyProject, messageIdOf, nestProject, openRewindMenu, panelView, plantLocks,
  projectDirName, readsAfter, readsAt, refreshAndWait, refreshStates, refsUnder, rewindButtons, roundPaths, rowOf,
  runsOf, sendTurn, sessionView, setContentSize, setPanel, snapshotErrors, statusErrorText, toolEnds, turnOf,
  turnRecords, userMessages, viewerView, waitGroup, waitPaneReady, waitTurn, waitViewer, watchTools, windowFocusEvent,
  writeEmptyFiles,
} from './fs-git-helpers.mjs';
import { startDelete } from './m3-helpers.mjs';
import { sendMessage, showTab, waitTeamIdle } from './tb-helpers.mjs';
import { waitStageKind } from './v1-switch-helpers.mjs';

const args = fsArgs('changes');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic）；路径要短，内部仓库在快照目录下再加工作路径的编码 */
const ROOT = fsRoot('mori-fs-chg-');
/** 数一次刷新时机之前、之后各等的安静时间 */
const QUIET = 2500;
/** FS-13 “超过 500 条”的未跟踪文件数 */
const MANY_STATUS = 501;
/** FS-08 的大文件（比 10 MB 大，§19.2 用真实大小） */
const LARGE_BYTES = 11 * 1024 * 1024;
/** FS-08 的新文件数（比 20000 多一个，只数不加） */
const PAUSE_FILES = 20001;
/** FS-10 阶段行：一次开始快照要分两批加的文件数（多于每批 2000 条，§4.4 第 5 步） */
const STAGE_FILES = 2100;
/** FS-10 停止、关闭：让开始快照自己的 git add 跑十几秒的文件数（scenarios/fs-git.mjs 开头量过：两批约 15 秒） */
const BIG_FILES = 4000;
/** 第二句（FS-12 组标题只写第一行，悬停看全文） */
const T2_NOTE = 'The second line of turn two';

/** 各轮的消息（关键词模式，synthetic；写法见 scenarios/fs-git.mjs 开头） */
const MSG = Object.freeze({
  fs05: keywordSteps(gitStep.run('echo fs05 > fs05.txt'), gitStep.hold(4000, gitStep.say('FS-05 turn done'))),
  t1: gitStep.write('fs09.txt', 'one'),
  t2: keywordSteps(gitStep.edit('fs09.txt', 'one', 'two'), gitStep.write('fs09b.txt', 'b1\\nb2'),
    gitStep.say('Turn two done')),
  t3: gitStep.edit('fs09.txt', 'two', 'three'),
  bash: keywordSteps(gitStep.run('echo x > fs11-a.txt'), gitStep.remove('b.txt'), gitStep.run('echo m2 >> m.txt'),
    gitStep.binary('fs11.bin'), gitStep.say('Bash turn done')),
  many: gitStep.many('fs11-many', 501),
  auto1: gitStep.write('auto1.txt', 'a'),
  auto2: gitStep.write('auto2.txt', 'b'),
  o1: keywordSteps(gitStep.write('n.txt', 'one'), gitStep.hold(8000, gitStep.write('n.txt', 'zero')),
    gitStep.say('O1 done')),
  // 文件名排在 n.txt 前面：第一个会话的组里按第一次出现的先后是 n.txt、b-o2.txt，与按路径排的不同（FS-12）
  o2: keywordSteps(gitStep.write('b-o2.txt', 'two'), gitStep.say('O2 done')),
  outer: keywordSteps(gitStep.write('r1.txt', 'r'), gitStep.hold(8000, gitStep.write('r2.txt', 'r')),
    gitStep.say('Outer done')),
  inner: keywordSteps(gitStep.write('a1.txt', 'a'), gitStep.say('Inner done')),
  task1: gitMessage([['git-task', [gitStep.edit('notes.md', 'hello', 'hello from the task'),
    gitStep.run('echo made > from-task.txt')]]]),
  task2: gitMessage([['git-task', [gitStep.edit('notes.md', 'from the task', 'from task two'),
    gitStep.run('echo two > from-t2.txt')]]]),
  nest: keywordSteps(gitStep.write('top.txt', 'top'), gitStep.write('tools/other/inner.txt', 'inner'),
    gitStep.say('Nest done')),
  small: gitStep.write('small.txt', 'small'),
  paused: gitStep.write('paused.txt', 'p'),
  resumed: gitStep.write('resumed.txt', 'r'),
  p1: gitStep.write('p1.txt', 'one'),
  p2: gitStep.write('p2.txt', 'two'),
  q1: gitStep.write('q1.txt', 'q'),
  p3: gitStep.write('p3.txt', 'three'),
  run: keywordSteps(gitStep.write('run.txt', 'run'), gitStep.hold(6000, gitStep.say('Run done'))),
  stage: keywordSteps(gitStep.say('Stage done')),
  stopped: keywordSteps(gitStep.say('Stopped snapshot')),
  closed: keywordSteps(gitStep.say('Closed snapshot')),
  afterStop: gitStep.write('after-stop.txt', 'after'),
  exit: keywordSteps(gitStep.write('e1.txt', 'exit'), gitStep.hold(20000, gitStep.say('Late exit'))),
  kill: keywordSteps(gitStep.write('k1.txt', 'kill'), gitStep.hold(20000, gitStep.say('Late kill'))),
  restarted: gitStep.write('n1.txt', 'new'),
});
/** 第二轮的整条消息：第一行是关键词链，第二行只是说明（端点只看 steps: 那一行） */
const T2_TEXT = `${MSG.t2}\n${T2_NOTE}`;
/** @brief 排队、插话测试的长运行：先写 <name>.txt，再推迟 5 秒回一句。 */
const longRun = (name) => keywordSteps(gitStep.write(`${name}.txt`, name),
  gitStep.hold(5000, gitStep.say(`${name} first`)));

// ---------- 准备 ----------

/** @brief 测试项目（synthetic test setup），git 仓库用真实 git 建。 */
function makeProjects(root) {
  const plain = (name, files) => makeProject(root, name, { files });
  const repo = (name, files) => makeProject(root, name, { files, repo: true });
  return {
    fs05: repo('fs05'), plain: plain('plain'), git: repo('git', { 'b.txt': 'b1\nb2\n', 'm.txt': 'm1\n' }),
    auto: plain('auto'), overlap: plain('overlap', { 'n.txt': 'zero\n', 'app/keep.txt': 'keep\n' }),
    team: repo('team', { 'notes.md': 'hello\n' }), branch: repo('branch'), groups: groupsProject(root),
    many: manyProject(root, MANY_STATUS), broken: brokenProject(root), fresh: freshProject(root),
    nest: nestProject(root), pause: plain('pause'), prune: plain('prune'), snap: plain('snap'), exit: plain('exit'),
  };
}

/** @brief 启动 App（fs-helpers startFsApp：away never），装上工具执行完的记录。 */
async function startChangesApp(ctx) {
  await startFsApp(ctx);
  await watchTools(ctx);
}

/** @brief App 已经关掉之后用同一个数据目录（与 ctx.env）再启动；之后要重新打开会话（reopenFs）。 */
async function startAgain(ctx) {
  ctx.projectTabs = {};
  await startChangesApp(ctx);
}

/** @brief 有序关闭后用同一个数据目录（与 ctx.env）重新启动。 */
async function restartChangesApp(ctx) {
  await closeFsApp(ctx);
  await startAgain(ctx);
}

/**
 * @brief 合成端点、项目、数据目录（synthetic test setup），记下项目仓库原有的 ref，启动 App。Git for Windows 的启动器在时
 *        MORI_GIT_PATH 指向它（launcherEnv）：Mori 找到的是启动器，FS-10 查内部仓库的调用直接起它旁边真正的 git。
 */
async function setup(ctx) {
  ctx.p = makeProjects(ROOT);
  ctx.userRefs = { git: git(ctx.p.git, 'for-each-ref'), team: git(ctx.p.team, 'for-each-ref') };
  ctx.ep = await startFsEndpoint('changes');
  seedFsUserData(ctx);
  ctx.env = launcherEnv();
  await startChangesApp(ctx);
}

/** @brief 读一个 JSON 文件；不在或读不出时为 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @brief 等这个会话的 +N −M 变成 want（{ added, removed }），最多 timeout；返回最后一次读到的 linesView。 */
async function waitLines(ctx, tab, want, timeout = 10000) {
  let view = null;
  await poll(async () => {
    view = await linesView(ctx, tab);
    return view?.added === want.added && view.removed === want.removed;
  }, timeout, 200);
  return view;
}

/** @brief 一轮的 changes 记录里的文件合在一起，按路径排（比较用）。 */
const roundFiles = (turn) => canonical(turn.changes.flatMap((item) => item.record.files)
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));

/** @brief 会话文件里有没有 changes 记录列出 path。 */
const listedIn = (file, path) => changesOf(file).some((item) => item.record.files.some((entry) => entry.path === path));

/** @brief 文件行上的 +<added> −<removed>（− 是 U+2212）。 */
const rowLines = (added, removed) => `+${added} −${removed}`;

/** @brief 等 This session 的说明里出现 kind 那一种（paused、skipped 等），最多 timeout；返回那一行或 null。 */
const waitNote = (ctx, kind, timeout = 15000) => poll(async () => (await sessionView(ctx))?.notes
  .find((note) => note.kind === kind) ?? null, timeout, 250);

/** @brief 页面里某个会话面板记下的阶段行（watchStages 的原始记录 { t, v: "<data-kind>|<文字>" }，含空的）。 */
const rawStages = (ctx, tab, since) => ctx.page.evaluate(({ key, from }) => (window.__stages?.[key] ?? [])
  .filter((item) => item.t >= from), { key: tab, from: since });

// ---------- FS-05：刷新时机 ----------

/** @brief 界面的刷新时机：打开会话、焦点会话改变、窗口回到前台，各读一次。 */
async function statusUi(ctx) {
  const t0 = Date.now();
  ctx.F = await openFsSession(ctx, ctx.p.fs05);
  const open = await readsAfter(ctx, ctx.p.fs05, t0, QUIET);
  record('FS-05 opening a new session (session.create succeeds) reads its git status once', open.length === 1,
    brief(open));
  ctx.P = await openFsSession(ctx, ctx.p.plain);
  await sleep(QUIET);
  const t1 = Date.now();
  await showTab(ctx, ctx.F.tab);
  const focus = await readsAfter(ctx, ctx.p.fs05, t1, QUIET);
  const left = await readsAt(ctx, ctx.p.plain, t1);
  record('FS-05 switching the focused session (its row in the sidebar) reads the newly focused session\'s git status '
    + 'once and not the one it left', focus.length === 1 && left.length === 0, brief({ focus, left }));
  const t2 = Date.now();
  await windowFocusEvent(ctx);
  const back = await readsAfter(ctx, ctx.p.fs05, t2, QUIET);
  record('FS-05 the window coming back to the front (a window focus event, synthetic) reads the shown session\'s git '
    + 'status once', back.length === 1, brief(back));
  await panelMoments(ctx, ctx.F);
}

/** @brief 打开右栏、点 Refresh 各读一次；关上右栏不读。 */
async function panelMoments(ctx, who) {
  const t0 = Date.now();
  await setPanel(ctx, who.tab, true);
  const opened = await readsAfter(ctx, ctx.p.fs05, t0, QUIET);
  const t1 = Date.now();
  await clickRefresh(ctx);
  const refreshed = await readsAfter(ctx, ctx.p.fs05, t1, QUIET);
  const t2 = Date.now();
  await setPanel(ctx, who.tab, false);
  const closed = await readsAfter(ctx, ctx.p.fs05, t2, QUIET);
  record('FS-05 opening the right panel reads the git status once', opened.length === 1, brief(opened));
  record('FS-05 Refresh reads the git status once (closing the panel reads nothing)', refreshed.length === 1
    && closed.length === 0, brief({ refreshed, closed }));
}

/** @brief 后台进程的刷新时机：改文件的工具执行完（去抖 500 毫秒）与一轮结束，各读一次。 */
async function statusRun(ctx) {
  const who = ctx.F;
  await ensureFull(ctx, who.tab);
  await sleep(QUIET);
  const since = Date.now();
  await sendFs(ctx, who, MSG.fs05);
  await sleep(QUIET);
  const end = (await toolEnds(ctx, since)).find((item) => item.sid === who.sessionId && item.tool === 'bash') ?? null;
  const settled = (await kernelEvents(ctx, who.sessionId, 'agent_settled', since))[0] ?? null;
  const before = end ? await readsAt(ctx, ctx.p.fs05, since, end.t) : [];
  const during = end && settled ? await readsAt(ctx, ctx.p.fs05, end.t, settled.t) : [];
  const after = settled ? await readsAt(ctx, ctx.p.fs05, settled.t, settled.t + 5000) : [];
  record('FS-05 a bash call that ends reads the git status once, about 500 ms after it ended (debounced), and nothing '
    + 'is read between sending and the tool end', Boolean(end) && before.length === 0 && during.length === 1
    && during[0].at - end.t >= 400, brief({ end, before, during }));
  // 结束快照做完、记录发出之后才读（at 是读完的时刻，记录事件在读之前发出）
  const records = await kernelEvents(ctx, who.sessionId, 'mori.turn_changes', since);
  const recorded = Math.max(...records.map((item) => item.t));
  record('FS-05 the end of a turn (agent_settled) reads the git status once, after its end snapshot (the read is done '
    + 'no earlier than the turn\'s mori.turn_changes arrived)', Boolean(settled) && after.length === 1
    && records.length > 0 && after[0].at >= recorded, brief({ settled, after, records: records.map((item) => ({
    t: item.t, kind: item.data?.record?.kind })) }));
}

/** @brief 同一个工作路径上两个打开的会话：一次读，两个会话各收到一个 mori.workspace_status。 */
async function statusShared(ctx) {
  const second = await openFsSession(ctx, ctx.p.fs05);
  await setPanel(ctx, second.tab, true);
  await sleep(QUIET);
  const since = Date.now();
  await clickRefresh(ctx);
  const reads = await readsAfter(ctx, ctx.p.fs05, since, QUIET);
  record('FS-05 both open sessions in the same folder receive each read (one mori.workspace_status on each envelope, '
    + 'the same at)', reads.length === 1 && reads[0].sids.length === 2 && reads[0].sids.includes(ctx.F.sessionId),
  brief(reads));
}

// ---------- FS-09、FS-06：两轮与内部仓库 ----------

/** @brief 两轮各写、改文件：每一轮的改动记在它自己的消息上；内部仓库的位置与归属。 */
async function twoTurns(ctx) {
  ctx.A = await openFsSession(ctx, ctx.p.git);
  const who = ctx.A;
  await ensureFull(ctx, who.tab);
  const first = await sendTurn(ctx, who, MSG.t1, ['fs09.txt']);
  const one = await waitLines(ctx, who.tab, { added: 1, removed: 0 });
  const second = await sendTurn(ctx, who, T2_TEXT, ['fs09.txt', 'fs09b.txt']);
  ctx.rounds = { m1: first.id, m2: second.id };
  const wantSecond = canonical([{ path: 'fs09.txt', status: 'M', added: 1, removed: 1 },
    { path: 'fs09b.txt', status: 'A', added: 2, removed: 0 }]);
  record('FS-09 two turns are attributed to their own messages: turn 1\'s record (round = the first message) lists '
    + 'fs09.txt A +1, turn 2\'s records (round = the second message) list fs09.txt M +1 −1 and fs09b.txt A +2',
  same(roundFiles(first), canonical([{ path: 'fs09.txt', status: 'A', added: 1, removed: 0 }]))
    && same(roundFiles(second), wantSecond) && same(roundPaths(who.sessionFile, first.id), ['fs09.txt']),
  brief({ first: roundFiles(first), second: roundFiles(second) }));
  await groupTitles(ctx, who, first.id, second.id);
  const two = await waitLines(ctx, who.tab, { added: 4, removed: 1 });
  record('FS-23 the accessible name of +N −M is singular for one added line ("Changes in this session: 1 line added, '
    + '0 removed") and plural otherwise ("4 lines added, 1 removed")', one?.label === linesLabel({ added: 1,
    removed: 0 }) && two?.label === linesLabel({ added: 4, removed: 1 }), brief({ one, two }));
  const repo = internalRepo(ctx, who.cwd);
  const owner = readJson(join(repo, 'mori.json'));
  record('FS-06 the internal repository is <MORI_SNAPSHOTS_DIR>\\<projectDirName(working path)> (the encoding of '
    + 'pi\'s session folders), outside the project, and its mori.json names the working path',
  existsSync(join(repo, 'HEAD')) && samePath(owner?.cwd, who.cwd) && !underPath(repo, who.cwd)
    && underPath(repo, ctx.snapshots), brief({ repo, owner }));
}

/** @brief 组的顺序与标题：新的在上，Turn <n> · <你那条消息的第一行>，悬停看全文。 */
async function groupTitles(ctx, who, m1, m2) {
  const view = await waitGroup(ctx, m2, ['fs09.txt', 'fs09b.txt']);
  const [top, below] = view?.turns ?? [];
  record('FS-12 This session has one group per turn, the newest on top, titled "Turn <n> · <first line of your '
    + 'message>" with the whole message on hover', top?.round === m2 && top.turn === 2
    && top.title === `Turn 2 · ${MSG.t2}` && top.hover === T2_TEXT && below?.round === m1 && below.turn === 1
    && below.title === `Turn 1 · ${MSG.t1}` && view.turns.length === 2, brief(view?.turns.map((turn) => ({
    round: turn.round, turn: turn.turn, title: turn.title, hover: turn.hover }))));
}

// ---------- FS-12：文件行、diff、阅读器 ----------

/** @brief 文件行的各部分，点开 diff（snapshots.diff 交给 Diff.tsx）。 */
async function fileRows(ctx) {
  const { m2 } = ctx.rounds;
  const view = await waitGroup(ctx, m2, ['fs09.txt', 'fs09b.txt']);
  const turn = turnOf(view, m2);
  const edited = rowOf(turn, 'fs09.txt');
  const written = rowOf(turn, 'fs09b.txt');
  record('FS-12 a file row has the status letter with its hover (M Modified, A Added), the path relative to the '
    + 'working path, "+<added> −<removed>", no Agent when only the dialog itself changed it, and Open',
  edited?.letter === 'M' && edited.letterTitle === 'Modified'
    && edited.lines === rowLines(1, 1) && edited.agents === null && edited.open && written?.letter === 'A'
    && written.letterTitle === 'Added' && written.lines === rowLines(2, 0) && written.open
    && same(turn.files.map((file) => file.path), ['fs09.txt', 'fs09b.txt']), brief(turn));
  const added = await expandTurnFile(ctx, m2, 'fs09b.txt');
  const changed = await expandTurnFile(ctx, m2, 'fs09.txt');
  record('FS-12 clicking a file row loads its diff for the turn (snapshots.diff) and Diff.tsx shows git\'s patch as '
    + 'whole lines: the new file\'s added lines b1 and b2; the edited file\'s removed line one and added line two',
  added?.state === 'shown' && added.error === null && diffHasLines(added, 'add', ['b1', 'b2'])
    && changed?.state === 'shown' && changed.error === null && diffHasLines(changed, 'del', ['one'])
    && diffHasLines(changed, 'add', ['two']), brief({ added: added?.lines, changed: changed?.lines,
    errors: [added?.error, changed?.error] }));
}

/** @brief 阅读器在新的一段记到打开的文件时重读；别处改的不重读。 */
async function viewerReload(ctx) {
  const who = ctx.A;
  await clickOpen(ctx, ctx.rounds.m2, 'fs09.txt');
  const before = await waitViewer(ctx);
  const third = await sendTurn(ctx, who, MSG.t3, ['fs09.txt']);
  ctx.rounds.m3 = third.id;
  const reloaded = await poll(async () => {
    const view = await viewerView(ctx);
    return view?.lines[0] === 'three' ? view : null;
  }, 10000, 200);
  record('FS-12 the open file viewer reloads by itself when a new segment of this session lists that file (fs09.txt '
    + 'shows "three" after turn 3 edited it, without Reload file)', before?.lines[0] === 'two' && Boolean(reloaded),
  brief({ before, after: reloaded ?? await viewerView(ctx) }));
  writeFileSync(join(who.cwd, 'fs09.txt'), 'changed outside\n');
  await sleep(QUIET);
  const outside = await viewerView(ctx);
  // 复原：后面的 Rewind 不因这个文件在最近一张快照之后变了而出冲突
  writeFileSync(join(who.cwd, 'fs09.txt'), 'three\n');
  record('FS-12 a change made elsewhere (the test writes the open file) does not reload the viewer', outside?.lines[0]
    === 'three', brief(outside));
  await backToChanges(ctx);
}

/** @brief 只恢复代码：+N −M 与 This session 都不变；恢复对话：按新的当前分支重算，丢掉的轮不再列出。 */
async function restoreKeeps(ctx) {
  const who = ctx.A;
  const { m3 } = ctx.rounds;
  const before = await linesView(ctx, who.tab);
  await openRewindMenu(ctx, who.tab, m3);
  const t0 = Date.now();
  const code = await chooseRewind(ctx, who.tab, 'rewind-code');
  const reads = await readsAfter(ctx, who.cwd, t0, QUIET);
  record('FS-05 a Rewind that restored code reads the git status once when it is done', code?.notices.at(-1)?.code
    === 'true' && reads.length === 1, brief(reads));
  const kept = await linesView(ctx, who.tab);
  const view = await sessionView(ctx);
  record('FS-23 Restore code (code only) leaves +N −M unchanged (+5 −2)', code?.notices.at(-1)?.code === 'true'
    && code.notices.at(-1).conversation === 'false' && before?.added === 5 && before.removed === 2
    && kept?.added === 5 && kept.removed === 2, brief({ code, before, kept }));
  record('FS-12 after Restore code the turns stay listed in This session (Turn 3 is still there) and the file is back '
    + 'to its content before turn 3', Boolean(turnOf(view, m3)) && readText(join(who.cwd, 'fs09.txt')) === 'two\n',
  brief(view?.turns.map((turn) => turn.title)));
  await openRewindMenu(ctx, who.tab, m3);
  const conversation = await chooseRewind(ctx, who.tab, 'rewind-conversation');
  const recomputed = await waitLines(ctx, who.tab, { added: 4, removed: 1 });
  const after = await sessionView(ctx);
  const sums = lineSums(branchChanges(who.sessionFile));
  record('FS-23 after Restore conversation +N −M is recomputed from the new current branch (+4 −1: turn 3\'s lines no '
    + 'longer count)', conversation?.notices.at(-1)?.conversation === 'true' && recomputed?.added === 4
    && recomputed.removed === 1 && same(sums, { added: 4, removed: 1 }), brief({ conversation, recomputed, sums }));
  record('FS-12 after Restore conversation the dropped turn is no longer listed (only Turn 2 and Turn 1 remain)',
    same(after?.turns.map((turn) => turn.round), [ctx.rounds.m2, ctx.rounds.m1]), brief(after?.turns.map((turn) =>
      turn.title)));
  await clearComposer(ctx, who.tab);
}

// ---------- FS-11、FS-14：命令改的、二进制、很多个文件 ----------

/** @brief bash 写、删、追加与二进制：记录与 This session 都列出，说明行里没有 v0 的两句。 */
async function bashChanges(ctx) {
  const who = ctx.A;
  const paths = ['b.txt', 'fs11-a.txt', 'fs11.bin', 'm.txt'];
  const turn = await sendTurn(ctx, who, MSG.bash, paths);
  ctx.rounds.m4 = turn.id;
  const files = roundFiles(turn);
  record('FS-11 files changed by bash commands are recorded: echo x > fs11-a.txt (A +1), rm b.txt (D −2), echo m2 >> '
    + 'm.txt (M +1); the binary file written by printf has null line counts', same(files, canonical([
    { path: 'b.txt', status: 'D', added: 0, removed: 2 }, { path: 'fs11-a.txt', status: 'A', added: 1, removed: 0 },
    { path: 'fs11.bin', status: 'A', added: null, removed: null },
    { path: 'm.txt', status: 'M', added: 1, removed: 0 }])),
  brief(files));
  const view = await waitGroup(ctx, turn.id, paths);
  const group = turnOf(view, turn.id);
  const row = (path) => rowOf(group, path);
  record('FS-14 This session lists the files the dialog agent changed with bash like edits and writes: D without Open '
    + '"+0 −2", A "+1 −0", M "+1 −0", the binary file "Binary"; after the conversation restore this is Turn 3',
  group?.turn === 3 && row('b.txt')?.status === 'D' && !row('b.txt').open && row('b.txt').lines === rowLines(0, 2)
    && row('fs11-a.txt')?.lines === rowLines(1, 0) && row('m.txt')?.status === 'M'
    && row('fs11.bin')?.lines === 'Binary' && row('fs11.bin').status === 'A', brief(group));
  const panel = await panelView(ctx);
  record('FS-14 the panel has neither "Only edits and writes are listed…" nor "Changes made by team tasks aren’t '
    + 'listed here."', Boolean(panel) && !panel.text.includes(TEXT.v0Note) && !panel.text.includes(TEXT.teamNote),
  brief(panel?.text, 300));
  const binary = await expandTurnFile(ctx, turn.id, 'fs11.bin');
  const deleted = await expandTurnFile(ctx, turn.id, 'b.txt');
  record('FS-12 a binary file\'s diff reads "Binary file · No preview"; a deleted file\'s diff shows its removed '
    + 'lines b1 and b2', binary?.state === 'binary' && binary.note === TEXT.binary && deleted?.state === 'shown'
    && diffHasLines(deleted, 'del', ['b1', 'b2']), brief({ binary, deleted: deleted?.lines }));
}

/** @brief 一段改 501 个文件：记录列 500 个、total 501；组下面说明没列全。 */
async function manyFiles(ctx) {
  const who = ctx.A;
  const turn = await sendTurn(ctx, who, MSG.many, ['fs11-many/f00000.txt'], { timeout: 120000 });
  const records = turn.changes.map((item) => item.record);
  record('FS-11 a segment that changes 501 files records 500 of them and total 501', records.length === 1
    && records[0].files.length === 500 && records[0].total === 501, brief(records.map((item) => ({
    files: item.files.length, total: item.total }))));
  const view = await waitGroup(ctx, turn.id, ['fs11-many/f00000.txt'], 30000);
  const group = turnOf(view, turn.id);
  record('FS-12 a turn whose record lists fewer files than its total has "Some files in this turn aren’t listed. Too '
    + 'many changed at once." below its 500 rows', group?.truncated === TEXT.truncated && group.files.length === 500,
  brief({ truncated: group?.truncated, rows: group?.files.length }));
}

/** @brief 实时收到的 mori.turn_changes 与会话文件里的条目相同。 */
async function eventsEqual(ctx) {
  const who = ctx.A;
  const events = await kernelEvents(ctx, who.sessionId, 'mori.turn_changes', 0);
  const entries = new Map(turnRecords(who.sessionFile).map((item) => [item.id, item.record]));
  const odd = events.filter((item) => !same(canonical(entries.get(item.data.entryId) ?? null),
    canonical(item.data.record)));
  record('FS-11 each mori.turn_changes event equals the session-file entry it was written as (same entry id, same '
    + 'record), one event per entry', events.length > 0 && events.length === entries.size && odd.length === 0,
  brief({ events: events.length, entries: entries.size, odd: odd.slice(0, 2) }));
}

// ---------- FS-23：顶栏 +N −M ----------

/** @brief +N −M 的数字、位置、窄栏、点它，以及没有改动的会话。 */
async function indicator(ctx) {
  const who = ctx.A;
  await setPanel(ctx, who.tab, true);
  const narrow = await linesView(ctx, who.tab);
  const rows = await sessionView(ctx);
  await setPanel(ctx, who.tab, false);
  const wide = await linesView(ctx, who.tab);
  const sums = lineSums(branchChanges(who.sessionFile));
  const shown = lineSums([{ files: (rows?.turns ?? []).flatMap((turn) => turn.files) }]);
  record('FS-23 +N −M equals the sums of added and removed over the changes records on the current branch (binary '
    + 'not counted), which are also the sums of This session\'s rows', wide?.added === sums.added
    && wide.removed === sums.removed && same(shown, sums) && wide.text === linesText(sums)
    && wide.label === linesLabel(sums), brief({ wide, sums, shown }));
  record('FS-23 +N −M sits just left of Toggle changes, whose hover text is Changes (accessible name Toggle changes)',
    Boolean(wide?.beforeToggle) && wide.toggleTitle === 'Changes' && wide.toggleLabel === 'Toggle changes',
    brief(wide));
  record('FS-23 +N −M is not shown while its pane is 600 px wide or narrower (right panel open at the default window '
    + 'size) and is shown when the pane is wider', Boolean(narrow?.present) && !narrow.shown && narrow.paneWidth <= 600
    && Boolean(wide?.shown) && wide.paneWidth > 600, brief({ narrow, wide }));
  await indicatorClicks(ctx, who);
  const zero = await linesView(ctx, ctx.P.tab);
  record('FS-23 +N −M is not shown for a session without changes', zero !== null && !zero.present, brief(zero));
}

/** @brief 点 +N −M：右栏关着时打开到 Changes；右栏开着阅读器时切回 Changes（窗口放宽，这一栏宽于 600 px）。 */
async function indicatorClicks(ctx, who) {
  const t0 = Date.now();
  await clickLines(ctx, who.tab);
  const opened = await poll(() => panelView(ctx), 5000, 150);
  const reads = await readsAfter(ctx, who.cwd, t0, QUIET);
  record('FS-23 clicking +N −M opens the right panel at Changes (and reads the git status once, the panel-open '
    + 'moment)', opened?.view === 'changes' && reads.length === 1, brief({ view: opened?.view, reads }));
  const size = await contentSize(ctx);
  await setContentSize(ctx, [1600, size[1]]);
  await clickOpen(ctx, ctx.rounds.m2, 'fs09b.txt');
  await waitViewer(ctx);
  const lines = await linesView(ctx, who.tab);
  if (lines?.shown) await clickLines(ctx, who.tab);
  const back = await poll(async () => (await panelView(ctx))?.view === 'changes', 5000, 150);
  await setContentSize(ctx, size);
  record('FS-23 with the file viewer open in the right panel, clicking +N −M switches the panel back to Changes',
    Boolean(lines?.shown) && Boolean(back), brief({ lines, back }));
}

// ---------- FS-11、FS-12：重新打开、自动打开 ----------

/** @brief 界面重新载入、从侧栏重新打开会话：This session 与之前相同（来自会话文件的当前分支）。 */
async function reopenSame(ctx) {
  const who = ctx.A;
  await setPanel(ctx, who.tab, true);
  const before = await sessionView(ctx);
  await reloadFsUi(ctx);
  await watchTools(ctx);
  await reopenFs(ctx, who);
  await setPanel(ctx, who.tab, true);
  const after = await poll(async () => {
    const view = await sessionView(ctx);
    return view?.turns.length === before?.turns.length ? view : null;
  }, 15000, 250);
  record('FS-11 after the page reloads and the session is opened again, This session is the same as before (the '
    + 'records come from the session file\'s current branch)', Boolean(before?.turns.length)
    && same(canonical(before.turns), canonical(after?.turns ?? null)), brief({
    before: before?.turns.map((turn) => turn.title), after: after?.turns.map((turn) => turn.title) }));
}

/** @brief 第一次收到 changes 记录时右栏自动打开到 Changes；手动关过之后不再自动打开。 */
async function autoOpen(ctx) {
  const who = await openFsSession(ctx, ctx.p.auto);
  await ensureFull(ctx, who.tab);
  const empty = await linesView(ctx, who.tab);
  const closed = (await panelView(ctx)) === null;
  await sendTurn(ctx, who, MSG.auto1, ['auto1.txt']);
  const opened = await poll(async () => {
    const view = await sessionView(ctx);
    return view?.turns.length ? view : null;
  }, 10000, 200);
  record('FS-12 the right panel opens by itself at Changes on the session\'s first mori.turn_changes (changes), '
    + 'listing the file', closed && !empty?.present && Boolean(rowOf(opened?.turns[0], 'auto1.txt')),
  brief({ closed, opened }));
  await setPanel(ctx, who.tab, false);
  await sendTurn(ctx, who, MSG.auto2, ['auto2.txt']);
  await sleep(1500);
  const still = await panelView(ctx);
  record('FS-12 once you closed the panel by hand, the next record does not open it again', still === null,
    brief(still?.view));
  await setPanel(ctx, who.tab, true);
  const panel = await panelView(ctx);
  const both = await waitGroup(ctx, messageIdOf(who.sessionFile, MSG.auto2), ['auto2.txt']);
  await setPanel(ctx, who.tab, false);
  record('FS-12 opened by hand, This session of a folder that is not a git repository (Not a git repository above '
    + 'it) lists both turns', panel?.notRepo === TEXT.notRepo && both?.turns.length === 2, brief(panel?.text, 300));
}

// ---------- FS-11、FS-12：同时运行（overlap）与没有差别 ----------

/** @brief 同一文件夹的两个会话同时运行：两边的记录都 overlap，组下有说明；改了又改回的文件没有差别。 */
async function overlapSessions(ctx) {
  const one = await openFsSession(ctx, ctx.p.overlap);
  await ensureFull(ctx, one.tab);
  const two = await openFsSession(ctx, ctx.p.overlap);
  await ensureFull(ctx, two.tab);
  ctx.O1 = one;
  await sendFs(ctx, one, MSG.o1, { wait: false });
  if (!(await poll(() => readText(join(ctx.p.overlap, 'n.txt')) === 'one\n', 30000, 100))) {
    throw new Error('the first session did not write n.txt');
  }
  await sendFs(ctx, two, MSG.o2);
  await waitIdleFs(ctx, one.tab, 60000);
  const first = await waitTurn(one.sessionFile, MSG.o1, ['n.txt', 'b-o2.txt']);
  const second = await waitTurn(two.sessionFile, MSG.o2, ['b-o2.txt']);
  const hasOverlap = (turn, path) => Boolean(turn?.changes.some((item) => item.record.overlap
    && item.record.files.some((file) => file.path === path)));
  const nTimes = first?.changes.filter((item) => item.record.files.some((file) => file.path === 'n.txt')).length ?? 0;
  record('FS-11 two sessions in the same folder running at the same time both record overlap: true for the segment '
    + 'they share (b-o2.txt in both sessions\' records)', hasOverlap(first, 'b-o2.txt')
    && hasOverlap(second, 'b-o2.txt') && nTimes >= 2,
  brief({ first: first?.changes.map((item) => item.record), second: second?.changes }));
  await overlapViews(ctx, one, two, first, second);
}

/** @brief 两个会话的 This session：重叠的说明；文件行按第一次出现的先后；n.txt 改了又改回，diff 为没有差别。 */
async function overlapViews(ctx, one, two, first, second) {
  await showTab(ctx, one.tab);
  const view = await waitGroup(ctx, first.id, ['n.txt', 'b-o2.txt']);
  const group = turnOf(view, first.id);
  record('FS-12 a group lists its files in the order they first appeared in the turn, not by path: n.txt (first '
    + 'segment) above b-o2.txt (written by the other session in the second segment)',
  same(group?.files.map((file) => file.path), ['n.txt', 'b-o2.txt']), brief(group?.files.map((file) => file.path)));
  const same0 = await expandTurnFile(ctx, first.id, 'n.txt');
  await showTab(ctx, two.tab);
  const other = turnOf(await waitGroup(ctx, second.id, ['b-o2.txt']), second.id);
  record('FS-12 a turn with an overlapping record has "Another session in this folder was running at the same time, '
    + 'so some of these changes may be theirs." under its title, in both sessions', group?.overlap === TEXT.overlap
    && other?.overlap === TEXT.overlap, brief({ group, other }));
  record('FS-12 a file changed and changed back within the turn (n.txt one, then zero again) is listed (M, +2 −2) and '
    + 'its diff reads "No net changes in this turn."', rowOf(group, 'n.txt')?.status === 'M'
    && rowOf(group, 'n.txt').lines === rowLines(2, 2) && same0?.state === 'empty' && same0.note === TEXT.noNet,
  brief({ row: rowOf(group, 'n.txt'), diff: same0 }));
}

/** @brief 在 <R> 与 <R>/app 开的两个会话同时运行：两边的记录都 overlap（嵌套的工作路径）。 */
async function nestedOverlap(ctx) {
  const outer = ctx.O1;
  const inner = await openFsSession(ctx, join(ctx.p.overlap, 'app'));
  await ensureFull(ctx, inner.tab);
  await sendFs(ctx, outer, MSG.outer, { wait: false });
  if (!(await poll(() => existsSync(join(ctx.p.overlap, 'r1.txt')), 30000, 100))) {
    throw new Error('the outer session did not write r1.txt');
  }
  await sendFs(ctx, inner, MSG.inner);
  await waitIdleFs(ctx, outer.tab, 60000);
  const top = await waitTurn(outer.sessionFile, MSG.outer, ['r1.txt', 'r2.txt']);
  const sub = await waitTurn(inner.sessionFile, MSG.inner, ['a1.txt']);
  const topOverlap = top?.changes.some((item) => item.record.overlap
    && item.record.files.some((file) => file.path === 'app/a1.txt'));
  record('FS-11 sessions opened in <R> and in <R>/app running at the same time both record overlap: true (the <R> '
    + 'session\'s record also lists app/a1.txt)', Boolean(topOverlap) && Boolean(sub?.changes.length)
    && sub.changes.every((item) => item.record.overlap), brief({ top: top?.changes, sub: sub?.changes }));
}

// ---------- FS-14：协作模式下 task 改的文件 ----------

/**
 * @brief 协作模式（/team，合并会话）的一条消息：等整个协作空闲，返回这个 task（T<n>）改的文件所在的 changes 记录
 *        { round, records }；等不到时为 null。
 */
async function teamTurn(ctx, who, text, task, paths) {
  await sendFs(ctx, who, text, { team: true, wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the team session did not become idle');
  return poll(() => {
    const records = changesOf(who.sessionFile).map((item) => item.record)
      .filter((record) => record.agents.some((agent) => agent.task === task));
    const listed = new Set(records.flatMap((record) => record.files.map((file) => file.path)));
    return records.length && paths.every((path) => listed.has(path)) ? { round: records[0].round, records } : null;
  }, 30000, 250);
}

/** @brief task 用 edit 和 bash 改文件：记进用户会话、标出 Agent；中间有 [Mori] 投递时轮的编号仍按你的消息。 */
async function teamTasks(ctx) {
  const who = await openFsSession(ctx, ctx.p.team);
  await ensureFull(ctx, who.tab);
  const t0 = Date.now();
  const first = await teamTurn(ctx, who, MSG.task1, 'T1', ['notes.md', 'from-task.txt']);
  const second = await teamTurn(ctx, who, MSG.task2, 'T2', ['notes.md', 'from-t2.txt']);
  const messages = userMessages(who.sessionFile);
  const own = (round) => messages.find((item) => item.id === round && !item.wake) ?? null;
  const agent = (found, task) => Boolean(found?.records.some((record) => record.agents.some((item) =>
    item.role === 'mori' && item.task === task && item.self === false)));
  record('FS-11 in team mode the files a task changed (edit and bash) are recorded in the user session under your '
    + 'message, with agents { role: mori, task: T1, self: false }', Boolean(own(first?.round)) && agent(first, 'T1')
    && agent(second, 'T2'), brief({ first, second }));
  await setPanel(ctx, who.tab, true);
  const view = await waitGroup(ctx, second?.round, ['notes.md', 'from-t2.txt']);
  const group1 = turnOf(view, first?.round);
  const group2 = turnOf(view, second?.round);
  const marked = (group, task) => ['notes.md', group === group1 ? 'from-task.txt' : 'from-t2.txt']
    .every((path) => rowOf(group, path)?.agents?.includes(`Mori (${task})`));
  record('FS-14 This session lists the files a team task changed with edit and bash and names the agent '
    + '("Mori (T1)")', marked(group1, 'T1') && marked(group2, 'T2'), brief({ group1, group2 }));
  const panel = await panelView(ctx);
  record('FS-14 there is no "Changes made by team tasks aren’t listed here." and no "Only edits and writes are '
    + 'listed…"', Boolean(panel) && !panel.text.includes(TEXT.teamNote) && !panel.text.includes(TEXT.v0Note),
  brief(panel?.text, 300));
  const from = own(first?.round)?.index ?? Number.MAX_SAFE_INTEGER;
  const wakes = messages.filter((item) => item.wake && item.index > from
    && item.index < (own(second?.round)?.index ?? -1));
  record('FS-12 with [Mori] deliveries between your two messages the groups are still Turn 1 and Turn 2 (deliveries '
    + 'are not your turns)', wakes.length > 0 && group1?.turn === 1 && group2?.turn === 2,
  brief({ wakes: wakes.length, turns: view?.turns.map((turn) => turn.title) }));
  await teamRuns(ctx, who, t0, messages);
}

/**
 * @brief 协作模式下的运行记录与阶段行（FS-10）：[Mori] 投递开始的运行不写 run；Taking a snapshot… 只属于用户会话自己的
 *        运行（mori.snapshot_stage { active: true } 与它的 agent_start 一样多），实例（task）的运行不发、不改阶段行。
 */
async function teamRuns(ctx, who, t0, messages) {
  const wakeIds = new Set(messages.filter((item) => item.wake).map((item) => item.id));
  const ownIds = new Set(messages.filter((item) => !item.wake).map((item) => item.id));
  const runs = runsOf(who.sessionFile);
  record('FS-10 runs started by [Mori] deliveries write no run record (every run record of the team session belongs '
    + 'to one of your messages)', wakeIds.size > 0 && runs.length > 0
    && runs.every((item) => ownIds.has(item.record.round) && !wakeIds.has(item.record.round)),
  brief({ wakes: [...wakeIds], rounds: runs.map((item) => item.record.round) }));
  const starts = await kernelEvents(ctx, who.sessionId, 'agent_start', t0);
  const stageOn = (await kernelEvents(ctx, who.sessionId, 'mori.snapshot_stage', t0))
    .filter((item) => item.data?.active === true);
  const elsewhere = (await kernelEvents(ctx, null, 'mori.snapshot_stage', t0)).filter((item) => item.sid
    !== who.sessionId);
  const shown = (await rawStages(ctx, who.tab, t0)).filter((item) => item.v.startsWith('snapshot|'));
  record('FS-10 the runs of team instances do not change the stage line: Taking a snapshot… is sent only for the '
    + 'user session\'s own runs (one mori.snapshot_stage active per agent_start of that session, none on any other '
    + 'envelope) and is shown at most once per such run', starts.length > 0 && stageOn.length === starts.length
    && elsewhere.length === 0 && shown.length <= starts.length,
  brief({ starts: starts.length, stageOn: stageOn.length, elsewhere: elsewhere.length, shown: shown.length }));
}

// ---------- FS-13：git 状态界面 ----------

/** @brief 不是 git 仓库的文件夹：Not a git repository，下面照常有 This session；右栏的外框。 */
async function folderStates(ctx) {
  const plain = await openFsSession(ctx, ctx.p.plain);
  await setPanel(ctx, plain.tab, true);
  const view = await poll(async () => {
    const panel = await panelView(ctx);
    return panel?.notRepo ? panel : null;
  }, 10000, 200);
  const session = await sessionView(ctx);
  record('FS-13 a folder that is not a git repository shows "Not a git repository" in the top part and still has '
    + 'This session', view?.notRepo === TEXT.notRepo && view.session && !view.gitStatus && view.required === null,
  brief(view));
  record('FS-13 the panel is titled Changes with Refresh (hover and name "Refresh") and Close panel in its title bar',
    view?.title === 'Changes' && view.refresh?.label === 'Refresh' && view.refresh.title === 'Refresh'
    && view.close, brief(view?.refresh));
  record('FS-12 a session without changes records shows "No changes yet." in This session',
    session?.empty === TEXT.noChanges && session.turns.length === 0, brief(session));
}

/** @brief FS-13 分支行的各种写法：[名字, 改仓库（synthetic）, 期望（字符串或之后再算的函数）]。 */
function branchSteps(project) {
  const head = headName(project);
  const upstream = (text) => `${head} · base · ${text}`;
  const behind = () => {
    git(project, 'checkout', '-q', 'base');
    commit(project, 'base one', '--allow-empty');
    commit(project, 'base two', '--allow-empty');
    git(project, 'checkout', '-q', head);
  };
  return [
    ['with an upstream that is level', () => {
      git(project, 'branch', 'base');
      git(project, 'branch', '-q', '-u', 'base');
    }, upstream('Up to date')],
    ['1 ahead', () => commit(project, 'ahead', '--allow-empty'), upstream('1 ahead')],
    ['1 ahead and 2 behind', behind, upstream('1 ahead, 2 behind')],
    ['2 behind', () => git(project, 'reset', '-q', '--hard', 'HEAD~1'), upstream('2 behind')],
    ['upstream gone', () => git(project, 'branch', '-q', '-D', 'base'), `${head} · base (gone)`],
    ['detached', () => git(project, 'checkout', '-q', '--detach'),
      () => `HEAD detached at ${git(project, 'rev-parse', 'HEAD').slice(0, 7)}`],
  ];
}

/** @brief git 仓库：分支行各写法、No uncommitted changes、Refresh 转圈。 */
async function branchLine(ctx) {
  const who = await openFsSession(ctx, ctx.p.branch);
  await setPanel(ctx, who.tab, true);
  const first = await poll(() => gitView(ctx), 10000, 200);
  const panel = await panelView(ctx);
  record('FS-13 a git repository shows the git status (branch line) above This session; with nothing to commit it '
    + 'says "No uncommitted changes"', first?.branch === headName(ctx.p.branch) && first.empty === TEXT.noUncommitted
    && first.groups.length === 0 && Boolean(panel?.session), brief({ first, panel }));
  const states = await refreshStates(ctx);
  record('FS-13 while Refresh reads, its button spins, is aria-disabled and named "Refreshing…" and the git status '
    + 'stays shown; then it is "Refresh" again', states.some((item) => item.busy === 'true'
    && item.label === 'Refreshing…' && item.disabled === 'true' && item.status) && states.at(-1)?.busy === null
    && states.at(-1).label === 'Refresh', brief(states));
  for (const [name, change, want] of branchSteps(ctx.p.branch)) {
    change();
    await refreshAndWait(ctx, ctx.p.branch);
    const view = await gitView(ctx);
    const expected = typeof want === 'function' ? want() : want;
    record(`FS-13 branch line, ${name}: "${expected}" (the whole text on hover)`, view?.branch === expected
      && view.branchTitle === expected, brief(view?.branch));
  }
  const fresh = await openFsSession(ctx, ctx.p.fresh);
  await setPanel(ctx, fresh.tab, true);
  const unborn = await poll(() => gitView(ctx), 10000, 200);
  record('FS-13 branch line of a repository without commits: "<branch> · No commits yet"', unborn?.branch
    === `${headName(ctx.p.fresh)} · No commits yet`, brief(unborn));
}

/** FS-13 四个分组的期望（groupsProject 的仓库）：[分组, 标题, [[code, 显示的路径, 字母, 字母的悬停]]] */
const GROUPS_WANT = [
  ['conflicted', 'Conflicts · 1', [['U', 'conflict.txt', 'U', 'Conflicted']]],
  ['staged', 'Staged · 3', [['R', 'b.txt → b2.txt', 'R', 'Renamed'], ['M', 'c.txt', 'M', 'Modified'],
    ['A', 'new.txt', 'A', 'Added']]],
  ['unstaged', 'Unstaged · 3', [['M', 'a.txt', 'M', 'Modified'], ['M', 'c.txt', 'M', 'Modified'],
    ['D', 'd.txt', 'D', 'Deleted']]],
  ['untracked', 'Untracked · 2', [['?', 'u.txt', '', null], ['?', 'ud/', '', null]]],
];

/** @brief 四个分组与各行；点一行在阅读器里打开 <toplevel>\<path>。 */
async function groupsView(ctx) {
  const who = await openFsSession(ctx, ctx.p.groups);
  await setPanel(ctx, who.tab, true);
  const view = await poll(async () => {
    const status = await gitView(ctx);
    return status?.groups.length ? status : null;
  }, 10000, 200);
  const shape = view?.groups.map((group) => [group.group, group.title, group.files.map((file) => [file.code,
    file.label, file.letter, file.letterTitle])]);
  record('FS-13 the git status lists Conflicts, Staged, Unstaged and Untracked in that order with "<name> · <n>" '
    + 'titles; rows have the status letter (hover Conflicted, Renamed, Modified, Added, Deleted; none for untracked) '
    + 'and the path relative to the repository root, a rename as "<from> → <path>", a file staged and changed again '
    + 'in both groups', same(shape, GROUPS_WANT), brief(shape));
  const open = async (group, path) => {
    await ctx.page.locator(`[data-testid="right-panel"] [data-testid="git-group"][data-group="${group}"] `
      + `[data-testid="git-file"][data-path=${JSON.stringify(path)}]`).click();
    const opened = await waitViewer(ctx);
    await backToChanges(ctx);
    await ctx.page.locator('[data-testid="right-panel"] [data-testid="git-status"]').waitFor({ timeout: 5000 });
    return opened;
  };
  const added = await open('staged', 'new.txt');
  const gone = await open('unstaged', 'd.txt');
  const folder = await open('untracked', 'ud/');
  record('FS-13 clicking a git status row opens <toplevel>\\<path> in the file viewer (no git diff): a staged file '
    + 'shows its text, a deleted one "File not found", an untracked folder "Preview unavailable · This is a folder"',
  samePath(added?.fullPath, join(ctx.p.groups, 'new.txt')) && added.lines[0] === 'new'
    && gone?.state === 'File not found' && folder?.state === 'Preview unavailable · This is a folder',
  brief({ added, gone, folder }));
}

/** @brief 超过 500 条的说明；git status 读失败时的原文。 */
async function manyAndBroken(ctx) {
  const many = await openFsSession(ctx, ctx.p.many);
  await setPanel(ctx, many.tab, true);
  const view = await poll(async () => {
    const status = await gitView(ctx);
    return status?.footer ? status : null;
  }, 10000, 200);
  const rows = view?.groups.reduce((count, group) => count + group.files.length, 0) ?? 0;
  record('FS-13 with more than 500 uncommitted files the list has 500 rows and "Showing 500 of 501 files." below it',
    view?.footer === 'Showing 500 of 501 files.' && rows === 500, brief({ footer: view?.footer, rows }));
  const broken = await openFsSession(ctx, ctx.p.broken);
  await setPanel(ctx, broken.tab, true);
  const want = statusErrorText(firstGitError(ctx.p.broken, STATUS_ARGS));
  const failed = await poll(async () => {
    const status = await gitView(ctx);
    return status?.error ? status : null;
  }, 10000, 200);
  record('FS-13 when git status fails (a corrupt index, synthetic) the git status block shows "Couldn’t read git '
    + 'status: <git\'s first line>" where the branch line was', failed?.error === want && failed.branch === null
    && failed.groups.length === 0, brief({ want, failed }));
}

// ---------- FS-26：嵌套 git 仓库 ----------

/** @brief 子模块与独立的嵌套仓库：This session 上方一行说明；它们里面的改动不记、不列。 */
async function nestedRepos(ctx) {
  const who = await openFsSession(ctx, ctx.p.nest);
  await ensureFull(ctx, who.tab);
  const turn = await sendTurn(ctx, who, MSG.nest, ['top.txt']);
  const view = await poll(async () => {
    const session = await sessionView(ctx);
    return session?.nested && turnOf(session, turn.id) ? session : null;
  }, 15000, 250);
  record('FS-26 with a submodule (libs/sub) and an independent repository with a commit (tools/other) in the working '
    + 'path, This session has "Changes inside nested repositories aren’t tracked: libs/sub, tools/other" above its '
    + 'title', view?.nested === `${TEXT.nestedLead}libs/sub, tools/other` && view.nestedAbove, brief(view?.nested));
  const listed = roundPaths(who.sessionFile, turn.id);
  const group = turnOf(view, turn.id);
  record('FS-26 a file changed inside a nested repository (tools/other/inner.txt) is neither recorded nor listed, the '
    + 'one outside (top.txt) is', existsSync(join(ctx.p.nest, 'tools', 'other', 'inner.txt'))
    && listed.includes('top.txt') && !listed.some((path) => path.startsWith('tools/other'))
    && Boolean(rowOf(group, 'top.txt')) && !group.files.some((file) => file.path.startsWith('tools/other')),
  brief({ listed, rows: group?.files.map((file) => file.path) }));
}

// ---------- FS-08：大文件与暂停的说明 ----------

/** @brief 11 MB 的未跟踪文件跳过；20,001 个新文件时暂停；加 .gitignore 后恢复。 */
async function snapshotNotes(ctx) {
  const who = await openFsSession(ctx, ctx.p.pause);
  await ensureFull(ctx, who.tab);
  writeFileSync(join(ctx.p.pause, 'large.bin'), Buffer.alloc(LARGE_BYTES, 0x61));
  const small = await sendTurn(ctx, who, MSG.small, ['small.txt']);
  const skipped = await waitNote(ctx, 'skipped');
  const lists = (path) => listedIn(who.sessionFile, path);
  record('FS-08 an untracked 11 MB file stays out of the snapshots: This session says "1 large file isn’t in '
    + 'snapshots (over 10 MB)." with its path on hover, and no record lists it', skipped?.text === TEXT.skippedOne
    && skipped.title === 'large.bin' && !lists('large.bin'), brief(skipped));
  record('FS-12 the large-file note (data-kind skipped) is a line below the This session title',
    Boolean(skipped?.below), brief(skipped));
  writeEmptyFiles(join(ctx.p.pause, 'gen'), PAUSE_FILES);
  const runs = runsOf(who.sessionFile).length;
  await sendFs(ctx, who, MSG.paused, { timeout: 120000 });
  const paused = await waitNote(ctx, 'paused', 30000);
  record('FS-08 with 20,001 new files the folder\'s snapshots pause: This session shows "Snapshots are paused for '
    + 'this folder: more than 20,000 new files would be added. Add generated folders to .gitignore to resume." and the '
    + 'turn gets no run record', paused?.text === TEXT.paused && runsOf(who.sessionFile).length === runs,
  brief(paused));
  const pausedView = await sessionView(ctx);
  record('FS-12 while snapshots are paused This session shows the paused reason (data-kind paused) as a line below its '
    + 'title and still lists the turns recorded before (Turn 1, small.txt)', paused?.text === TEXT.paused
    && paused.below && Boolean(rowOf(turnOf(pausedView, small.id), 'small.txt')), brief(pausedView));
  await resumeSnapshots(ctx, who);
}

/** @brief 加 .gitignore 之后下一个快照点恢复：暂停的说明没了，这一轮记下，暂停期间写的文件不记。 */
async function resumeSnapshots(ctx, who) {
  const lists = (path) => listedIn(who.sessionFile, path);
  writeFileSync(join(ctx.p.pause, '.gitignore'), 'gen/\n');
  await sendTurn(ctx, who, MSG.resumed, ['resumed.txt'], { timeout: 120000 });
  const view = await sessionView(ctx);
  record('FS-08 after gen/ goes into .gitignore the next snapshot point resumes: the paused note is gone, the turn is '
    + 'recorded and the file written while paused (paused.txt) is not', Boolean(view)
    && !view.notes.some((note) => note.kind === 'paused') && !lists('paused.txt'), brief(view?.notes));
  // 大的测试准备用完就删（这个项目之后不再跑）
  rmSync(join(ctx.p.pause, 'gen'), { recursive: true, force: true });
  rmSync(join(ctx.p.pause, 'large.bin'), { force: true });
}

// ---------- FS-20：保留与整理 ----------

/** @brief 用 git update-ref -d 删掉一轮的 ref：它的 diff 与 Rewind 都报整理的原文。 */
async function pruned(ctx) {
  const one = await openFsSession(ctx, ctx.p.prune);
  await ensureFull(ctx, one.tab);
  const m1 = (await sendTurn(ctx, one, MSG.p1, ['p1.txt'])).id;
  const m2 = (await sendTurn(ctx, one, MSG.p2, ['p2.txt'])).id;
  const removed = deleteRefs(ctx, one.cwd, `refs/mori/s/${one.sessionId}/${m1}/`);
  await waitGroup(ctx, m1, ['p1.txt']);
  const diff = await expandTurnFile(ctx, m1, 'p1.txt');
  record('FS-20 after a turn\'s refs are removed from the internal repository (git update-ref -d, a pruning made by '
    + 'hand) its diff in This session reads "Mori keeps snapshots for the last 100 turns of a session. This turn’s '
    + 'snapshots were removed."', removed.length > 0 && diff?.state === 'pruned' && diff.note === TEXT.pruned,
  brief({ removed, diff }));
  await openRewindMenu(ctx, one.tab, m1);
  const rewind = await chooseRewind(ctx, one.tab, 'rewind-code');
  record('FS-20 Rewind to that turn (Restore code) fails with "Couldn’t rewind: <the pruning text>" and changes '
    + 'nothing', rewind?.error === `Couldn’t rewind: ${TEXT.pruned}` && existsSync(join(ctx.p.prune, 'p1.txt'))
    && existsSync(join(ctx.p.prune, 'p2.txt')), brief(rewind));
  await dropSessions(ctx, one, m2);
}

/** @brief 删除会话（会话菜单 → Delete… → Delete），等确认框关掉。 */
async function deleteSessionUi(ctx, who) {
  const dialog = await startDelete(ctx.page, who.sessionFile);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
}

/** @brief 删除会话后它的 ref 没了；prune 后别的会话照样能 Rewind；最后一个会话删掉后整个内部仓库没了。 */
async function dropSessions(ctx, one, m2) {
  const repo = internalRepo(ctx, one.cwd);
  const two = await openFsSession(ctx, ctx.p.prune);
  await ensureFull(ctx, two.tab);
  await sendTurn(ctx, two, MSG.q1, ['q1.txt']);
  const before = refsUnder(ctx, one.cwd, `refs/mori/s/${two.sessionId}/`);
  await deleteSessionUi(ctx, two);
  const gone = await poll(() => refsUnder(ctx, one.cwd, `refs/mori/s/${two.sessionId}/`).length === 0, 15000, 300);
  record('FS-20 deleting a session removes its refs from the internal repository (snapshots.drop); the repository '
    + 'stays while another session of the folder has refs', before.length > 0 && Boolean(gone)
    && existsSync(join(repo, 'HEAD')), brief({ before }));
  await openRewindMenu(ctx, one.tab, m2);
  const restored = await chooseRewind(ctx, one.tab, 'rewind-code');
  record('FS-20 after git prune the other session\'s snapshots still rewind: Restore code to before its turn 2 '
    + 'removes p2.txt and keeps p1.txt', Boolean(restored?.notices.at(-1)?.text?.startsWith('Restored code to before '
    + 'turn 2')) && !existsSync(join(ctx.p.prune, 'p2.txt')) && existsSync(join(ctx.p.prune, 'p1.txt')),
  brief(restored));
  await deleteSessionUi(ctx, one);
  const removed = await poll(() => !existsSync(repo), 15000, 300);
  record('FS-20 deleting the folder\'s last session (no other open session there) deletes the whole internal '
    + 'repository folder', Boolean(removed), repo);
  const three = await openFsSession(ctx, ctx.p.prune);
  await ensureFull(ctx, three.tab);
  const turn = await sendTurn(ctx, three, MSG.p3, ['p3.txt']);
  const run = turn.runs[0].record;
  const view = await waitGroup(ctx, turn.id, ['p3.txt']);
  record('FS-20 a new session there in the same background process starts the internal repository afresh: the run '
    + 'record\'s start and end are commits that exist in it (git cat-file -e) and This session lists p3.txt',
  commitExists(ctx, three.cwd, run.start) && commitExists(ctx, three.cwd, run.end) && Boolean(view), brief(run));
}

// ---------- FS-06：项目自己的仓库 ----------

/** @brief 不是仓库的项目里没有新的 .git；项目自己的仓库没有多任何 ref。 */
async function userRepos(ctx) {
  const plainFolders = ['plain', 'auto', 'overlap', 'pause', 'prune'].map((name) => ctx.p[name]);
  const made = plainFolders.filter((dir) => existsSync(join(dir, '.git')));
  record('FS-06 snapshots never create a .git in a project that is not a git repository (plain, auto, overlap, pause, '
    + 'prune after their turns)', made.length === 0, brief(made));
  const now = { git: git(ctx.p.git, 'for-each-ref'), team: git(ctx.p.team, 'for-each-ref') };
  record('FS-06 the projects\' own repositories have exactly the refs they had before Mori ran in them (git '
    + 'for-each-ref unchanged, nothing under refs/mori)', same(now, ctx.userRefs) && !now.git.includes('refs/mori'),
  brief({ before: ctx.userRefs, now }));
}

// ---------- FS-10：运行记录、排队与插话、开始快照 ----------

/** @brief 你的消息开始的运行写一条 run；运行中开始快照在 run/ 下有 ref，写下 run 后换到轮下；菜单有 code restore。 */
async function runRecords(ctx) {
  const who = await openFsSession(ctx, ctx.p.snap);
  await ensureFull(ctx, who.tab);
  ctx.X = who;
  await sendFs(ctx, who, MSG.run, { wait: false });
  if (!(await poll(() => readText(join(who.cwd, 'run.txt')) === 'run\n', 30000, 100))) throw new Error('no run.txt');
  const during = refsUnder(ctx, who.cwd, `refs/mori/s/${who.sessionId}/run/`);
  await waitIdleFs(ctx, who.tab, 60000);
  const turn = await waitTurn(who.sessionFile, MSG.run, ['run.txt']);
  const run = turn?.runs[0]?.record ?? null;
  const after = refsUnder(ctx, who.cwd, `refs/mori/s/${who.sessionId}/run/`);
  const round = refsUnder(ctx, who.cwd, `refs/mori/s/${who.sessionId}/${turn?.id}/`);
  record('FS-10 a turn started by your message writes one run record: round is that message, start is the snapshot '
    + 'before the run (no run.txt yet) and end the one after it, both commits in the internal repository',
  turn?.runs.length === 1 && commitExists(ctx, who.cwd, run.start) && commitExists(ctx, who.cwd, run.end)
    && !fileInCommit(ctx, who.cwd, run.start, 'run.txt') && fileInCommit(ctx, who.cwd, run.end, 'run.txt'),
  brief(run));
  record('FS-10 while the run is going its start snapshot is kept by a ref under refs/mori/s/<session>/run/; after '
    + 'the run record is written that ref is gone and the turn has refs under refs/mori/s/<session>/<round>/',
  during.length === 1 && during[0].endsWith(`/${run?.start}`) && after.length === 0
    && round.some((ref) => ref.endsWith(`/${run?.start}`)) && round.some((ref) => ref.endsWith(`/${run?.end}`)),
  brief({ during, after, round }));
  const menu = await openRewindMenu(ctx, who.tab, turn.id);
  await closeRewindMenu(ctx);
  record('FS-10 that message has a code restore: its Rewind menu offers Restore code and conversation, Restore '
    + 'conversation, Restore code, Never mind', same(menu.items.map((item) => item.id), ['rewind-code-conversation',
    'rewind-conversation', 'rewind-code', 'rewind-cancel']), brief(menu));
}

/** @brief 运行中排队（Enter）、插话（Ctrl+Enter）的消息没有自己的 run；那次运行的改动都归起始消息。 */
async function queuedNoRun(ctx) {
  const who = ctx.X;
  for (const [name, key] of [['queued', 'Enter'], ['steered', 'Control+Enter']]) {
    await sendFs(ctx, who, longRun(name), { wait: false });
    if (!(await poll(() => existsSync(join(who.cwd, `${name}.txt`)), 30000, 100))) throw new Error(`no ${name}.txt`);
    await sendMessage(ctx, who.tab, gitStep.write(`${name}-2.txt`, 'two'), { key });
    await waitIdleFs(ctx, who.tab, 60000);
    const turn = await waitTurn(who.sessionFile, longRun(name), [`${name}.txt`, `${name}-2.txt`]);
    const followId = messageIdOf(who.sessionFile, `${name}-2.txt`);
    record(`FS-10 a message sent with ${key} while the run is going (${name}) gets no run record of its own; the `
      + 'run\'s changes, its file too, go to the message that started the run', Boolean(turn) && Boolean(followId)
      && !runsOf(who.sessionFile).some((item) => item.record.round === followId), brief({ turn: turn?.id, followId }));
  }
}

/** @brief 阶段行的文字是 Taking a snapshot… · <秒数>（§13，秒数可带一位小数）。 */
const snapshotStageText = (text) => typeof text === 'string' && text.startsWith(`${TEXT.stage} · `)
  && /^\d+(\.\d+)?s$/.test(text.slice(TEXT.stage.length + 3));

/** @brief 开始快照期间阶段行为 Taking a snapshot… · <秒数>（data-kind="snapshot"），agent_start 之后换掉。 */
async function snapshotStage(ctx) {
  const who = ctx.X;
  writeManyFiles(join(who.cwd, 'stage'), STAGE_FILES);
  const since = Date.now();
  await sendMessage(ctx, who.tab, MSG.stage);
  const shown = await waitStageKind(ctx.page, who.tab, 'snapshot', 15000);
  const text = shown ? (await ctx.page.locator(`${paneSel(who.tab)} [data-testid="stage"]`).textContent())?.trim()
    : null;
  await waitIdleFs(ctx, who.tab, 120000);
  const start = (await kernelEvents(ctx, who.sessionId, 'agent_start', since))[0] ?? null;
  const stages = await rawStages(ctx, who.tab, since);
  const snaps = stages.filter((item) => item.v.startsWith('snapshot|'));
  const cleared = Boolean(start) && stages.some((item) => item.t >= start.t && !item.v.startsWith('snapshot|'));
  record('FS-10 while the run-start snapshot is being taken the stage line reads "Taking a snapshot… · <seconds>" '
    + '(data-kind="snapshot")', shown && snapshotStageText(text), brief(text));
  record('FS-10 the snapshot stage is replaced at agent_start (no snapshot stage after the run started)',
    snaps.length > 0 && Boolean(start) && snaps.every((item) => item.t <= start.t) && cleared,
    brief({ start: start?.t, stages }));
  // 用完就删（2100 个文件）：先等这一轮的 run 记录（结束快照做完），删掉就发生在没有运行时，是不记给任何人的一段
  if (!(await waitTurn(who.sessionFile, MSG.stage, [], 60000))) throw new Error('no run record for the stage turn');
  rmSync(join(who.cwd, 'stage'), { recursive: true, force: true });
}

/** 停止、退出之后内部仓库的 git 进程全都不在的时限：一批 git add 要 6–10 秒 */
const GIT_GONE_MS = 2000;

/** 内部仓库的调用直接起的真正的 git（找到的是启动器时，§3.3、fs-checks.md 负责人不在时的选择 #13） */
const REAL_GIT_COMMAND = /mingw64\\bin\\git\.exe/i;

/**
 * @brief 等开始快照自己的 git add 在跑（命令行里有 add 的、内部仓库的 git 进程），最多 timeout；返回它们或 null。
 */
const waitGitAdd = (ctx, fragment, timeout = 20000) => poll(() => {
  const found = gitProcesses(fragment).filter((item) => / add /.test(item.command));
  return found.length > 0 ? found : null;
}, timeout, 200);

/** @brief 这次 App 用的是 Git for Windows 的启动器（setup 里 launcherEnv 设了 MORI_GIT_PATH）。 */
const usesLauncher = (ctx) => ctx.env?.MORI_GIT_PATH === GIT_LAUNCHER;

/**
 * @brief 开始快照做完之前按停止：整棵 git 进程树（启动器与真正的 git）立刻被结束，这次没有 run、没有结束快照；
 *        下一次照常。
 */
async function stopSnapshot(ctx) {
  const who = ctx.X;
  const fragment = projectDirName(who.cwd);
  writeManyFiles(join(who.cwd, 'big'), BIG_FILES);
  const runs = runsOf(who.sessionFile).length;
  await sendMessage(ctx, who.tab, MSG.stopped);
  const staged = await waitStageKind(ctx.page, who.tab, 'snapshot', 15000);
  const running = await waitGitAdd(ctx, fragment) ?? [];
  const stopAt = Date.now();
  await ctx.page.locator(`${paneSel(who.tab)} .stop-button`).click();
  const goneMs = await goneWithin(running.map((item) => item.pid), stopAt, GIT_GONE_MS);
  const left = gitProcesses(fragment);
  await waitIdleFs(ctx, who.tab, 30000);
  await sleep(QUIET);
  const records = await kernelEvents(ctx, who.sessionId, 'mori.turn_changes', stopAt);
  const direct = running.length > 0 && !hasLauncherPair(running)
    && running.every((item) => REAL_GIT_COMMAND.test(item.command));
  record('FS-10 Stop while the run-start snapshot is being taken ends the snapshot\'s git process tree right away: '
    + `with ${GIT_LAUNCHER} found, the internal repository's git add runs as the real git next to it (no launcher `
    + `process), it is gone within ${GIT_GONE_MS} ms and no git process of the internal repository is left `
    + '(one git add batch takes 6–10 s)', staged && usesLauncher(ctx) && direct && goneMs !== null
    && left.length === 0, brief({ goneMs, running, left, launcher: usesLauncher(ctx) }));
  record('FS-10 that run writes no run record and takes no end snapshot (no mori.turn_changes afterwards)',
    runsOf(who.sessionFile).length === runs && records.length === 0, brief({ records }));
  rmSync(join(who.cwd, 'big'), { recursive: true, force: true });
  const turn = await sendTurn(ctx, who, MSG.afterStop, ['after-stop.txt'], { timeout: 120000 });
  record('FS-10 the next run is snapshotted as usual (run record, the file listed) and no index.lock is left in the '
    + 'internal repository', turn.runs.length === 1 && !existsSync(join(internalRepo(ctx, who.cwd), 'index.lock')),
  brief(turn.runs));
}

/** 主进程等后台进程释放会话的上限（src/main/kernel-process.ts SHUTDOWN_TIMEOUT_MS）与到时记的那一行 */
const SHUTDOWN_CAP_MS = 3000;
const SHUTDOWN_LATE = 'kernel did not finish shutdown in time';

/**
 * @brief 开始快照做完之前退出 Mori（release 先通知快照模块）：git 进程立刻被结束，不等它跑完。主进程在有序退出之后
 *        （最晚 3 秒的上限到时）用作业对象结束后台进程的整棵进程树，所以“git 进程最后不在”证明不了什么；要看的是退出没有
 *        等到上限：没有 kernel did not finish shutdown in time 一行，git 进程在上限之前就不在了，整个退出不到 3 秒。
 */
async function closeSnapshot(ctx) {
  const who = ctx.X;
  const fragment = projectDirName(who.cwd);
  writeManyFiles(join(who.cwd, 'big2'), BIG_FILES);
  const runs = runsOf(who.sessionFile).length;
  await sendMessage(ctx, who.tab, MSG.closed);
  const staged = await waitStageKind(ctx.page, who.tab, 'snapshot', 15000);
  const running = await waitGitAdd(ctx, fragment) ?? [];
  const t0 = Date.now();
  const watching = goneWithin(running.map((item) => item.pid), t0, GIT_GONE_MS);
  await closeFsApp(ctx);
  const closeMs = Date.now() - t0;
  const goneMs = await watching;
  await sleep(500);
  const late = appLogLines(ctx, SHUTDOWN_LATE, t0);
  const left = gitProcesses(fragment);
  record('FS-10 quitting Mori while the run-start snapshot is being taken (release tells the snapshot module first) '
    + `ends that git process tree instead of waiting for it: gone within ${GIT_GONE_MS} ms, no "${SHUTDOWN_LATE}" `
    + `line, the quit takes less than the ${SHUTDOWN_CAP_MS} ms cap, no git process of the internal repository is `
    + 'left and no run record is written', staged && running.length > 0 && goneMs !== null && late.length === 0
    && closeMs < SHUTDOWN_CAP_MS && left.length === 0 && runsOf(who.sessionFile).length === runs,
  brief({ closeMs, goneMs, late, running, left }));
  rmSync(join(who.cwd, 'big2'), { recursive: true, force: true });
  await startAgain(ctx);
}

// ---------- FS-22：退出与崩溃 ----------

/** @brief 运行中有序退出：被中止的运行的结束快照做完、记录写下。 */
async function orderedExit(ctx) {
  const who = await openFsSession(ctx, ctx.p.exit);
  await ensureFull(ctx, who.tab);
  ctx.E = who;
  await sendFs(ctx, who, MSG.exit, { wait: false });
  if (!(await poll(() => readText(join(who.cwd, 'e1.txt')) === 'exit\n', 30000, 100))) throw new Error('no e1.txt');
  await sleep(1000);
  await closeFsApp(ctx);
  const id = messageIdOf(who.sessionFile, MSG.exit);
  const runs = runsOf(who.sessionFile).filter((item) => item.record.round === id);
  const listed = roundPaths(who.sessionFile, id);
  record('FS-22 an ordered exit during a run finishes the aborted run\'s end snapshot and writes its records (the run '
    + 'record with an end snapshot, a changes record listing e1.txt)', Boolean(id) && runs.length === 1
    && runs[0].record.end !== null && listed.includes('e1.txt'), brief({ id, runs, listed }));
  await startAgain(ctx);
}

/** @brief 结束后台进程（lib.mjs killKernel），放进陈旧的锁（synthetic），点这个会话面板上的 Restart。 */
async function killAndRestart(ctx, who) {
  const repo = internalRepo(ctx, who.cwd);
  killKernel(ctx.app);
  const exit = ctx.page.locator(`${paneSel(who.tab)} [data-testid="kernel-exit"]`);
  await exit.waitFor({ timeout: 15000 });
  const locks = plantLocks(repo);
  await exit.getByRole('button', { name: 'Restart' }).click();
  await ctx.page.locator('[data-testid="kernel-exit"]').first().waitFor({ state: 'detached', timeout: 30000 });
  // 新的后台进程连上后界面重新打开各个会话（Restarting… 之后才就绪）
  await sleep(1500);
  await waitPaneReady(ctx, who.tab);
  return locks;
}

/** @brief 强行结束后台进程后重启：没写的记录不存在、陈旧的锁被清掉、没有报错、新的运行照常拍快照。 */
async function killedKernel(ctx) {
  const who = ctx.E;
  await reopenFs(ctx, who);
  await ensureFull(ctx, who.tab);
  await sendFs(ctx, who, MSG.kill, { wait: false });
  if (!(await poll(() => readText(join(who.cwd, 'k1.txt')) === 'kill\n', 30000, 100))) throw new Error('no k1.txt');
  await sleep(1000);
  const since = Date.now();
  const locks = await killAndRestart(ctx, who);
  const killed = messageIdOf(who.sessionFile, MSG.kill);
  const lists = (path) => listedIn(who.sessionFile, path);
  record('FS-22 after the background process is killed mid-run and restarted, the record that was never written is '
    + 'absent (no run record for that message, no record lists k1.txt)', Boolean(killed)
    && !runsOf(who.sessionFile).some((item) => item.record.round === killed) && !lists('k1.txt'), brief({ killed }));
  await ensureFull(ctx, who.tab);
  const turn = await sendTurn(ctx, who, MSG.restarted, ['n1.txt']);
  await setPanel(ctx, who.tab, true);
  const view = await waitGroup(ctx, turn.id, ['n1.txt']);
  const pane = await paneState(ctx.page, who.tab);
  const failures = snapshotErrors(ctx, who.cwd, since);
  const errorNote = (note) => note.kind === 'error' || note.text?.startsWith(TEXT.stalePrefix);
  record('FS-22 the first run after the restart is snapshotted as usual without errors: run and changes records for '
    + 'n1.txt (k1.txt still not listed), no "Couldn’t take a snapshot" note, no error card, no blocked session, no '
    + 'snapshot or internal-repository git error in the log (removing the stale locks is the only snapshots line '
    + 'expected)', turn.runs.length === 1 && !lists('k1.txt') && Boolean(view) && !view.notes.some(errorNote)
    && pane?.errors.length === 0 && pane.blocked === null && failures.length === 0,
  brief({ notes: view?.notes, errors: pane?.errors, failures }));
  record('FS-22 the stale locks left in the internal repository (index.lock, packed-refs.lock, refs\\mori\\'
    + 'synthetic.lock; synthetic) are removed before its first job', locks.every((lock) => !existsSync(lock)),
  brief(locks.filter((lock) => existsSync(lock))));
}

// ---------- FS-13、FS-23：没装 git ----------

/** @brief 另起一个 App（MORI_GIT_PATH 指向不存在的路径）：右栏只有一行说明，没有 +N −M 与 Rewind。 */
async function noGit(ctx) {
  ctx.env = { MORI_GIT_PATH: join(ROOT, 'no-git', 'git.exe') };
  await restartChangesApp(ctx);
  const who = ctx.A;
  await reopenFs(ctx, who);
  await setPanel(ctx, who.tab, true);
  const panel = await poll(async () => {
    const view = await panelView(ctx);
    return view?.required ? view : null;
  }, 15000, 200);
  const lines = await linesView(ctx, who.tab);
  const rewinds = await rewindButtons(ctx, who.tab);
  const users = (await paneState(ctx.page, who.tab))?.users.length ?? 0;
  record('FS-13 without git (MORI_GIT_PATH pointing at a missing file) the panel body is only "Git is required to '
    + 'track changes and rewind." (data-state="missing"): no This session, no git status; Refresh is there',
  panel?.required?.state === 'missing' && panel.required.text === TEXT.gitRequired && !panel.session
    && !panel.gitStatus && panel.refresh?.label === 'Refresh', brief(panel));
  record('FS-13 without git there is no +N −M and no Rewind on the session\'s messages', Boolean(lines)
    && !lines.present && rewinds === 0 && users > 0, brief({ lines, rewinds, users }));
  record('FS-23 without git +N −M is not shown although the current branch has changes records',
    Boolean(lines) && !lines.present && branchChanges(who.sessionFile).length > 0, brief(lines));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败）；有先后，见文件开头 */
const steps = {
  statusUi: [statusUi, ['FS-05']],
  statusRun: [statusRun, ['FS-05']],
  statusShared: [statusShared, ['FS-05']],
  twoTurns: [twoTurns, ['FS-09', 'FS-12', 'FS-23', 'FS-06']],
  fileRows: [fileRows, ['FS-12']],
  viewerReload: [viewerReload, ['FS-12']],
  restoreKeeps: [restoreKeeps, ['FS-05', 'FS-12', 'FS-23']],
  bashChanges: [bashChanges, ['FS-11', 'FS-12', 'FS-14']],
  manyFiles: [manyFiles, ['FS-11', 'FS-12']],
  eventsEqual: [eventsEqual, ['FS-11']],
  indicator: [indicator, ['FS-23']],
  reopenSame: [reopenSame, ['FS-11']],
  autoOpen: [autoOpen, ['FS-12']],
  overlapSessions: [overlapSessions, ['FS-11', 'FS-12']],
  nestedOverlap: [nestedOverlap, ['FS-11']],
  teamTasks: [teamTasks, ['FS-10', 'FS-11', 'FS-12', 'FS-14']],
  folderStates: [folderStates, ['FS-12', 'FS-13']],
  branchLine: [branchLine, ['FS-13']],
  groupsView: [groupsView, ['FS-13']],
  manyAndBroken: [manyAndBroken, ['FS-13']],
  nestedRepos: [nestedRepos, ['FS-26']],
  snapshotNotes: [snapshotNotes, ['FS-08', 'FS-12']],
  pruned: [pruned, ['FS-20']],
  userRepos: [userRepos, ['FS-06']],
  runRecords: [runRecords, ['FS-10']],
  queuedNoRun: [queuedNoRun, ['FS-10']],
  snapshotStage: [snapshotStage, ['FS-10']],
  stopSnapshot: [stopSnapshot, ['FS-10']],
  // 下面四步各重新启动一次 App（closeSnapshot、orderedExit 有序退出，killedKernel 只结束后台进程，noGit 另起一个）
  closeSnapshot: [closeSnapshot, ['FS-10']],
  orderedExit: [orderedExit, ['FS-22']],
  killedKernel: [killedKernel, ['FS-22']],
  noGit: [noGit, ['FS-13', 'FS-23']],
};

const ctx = { ...fsUserData('mori-fs-chg-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-changes] data in ${ctx.userData}, snapshots in ${ctx.snapshots}, projects in ${ROOT}`);
finish();
