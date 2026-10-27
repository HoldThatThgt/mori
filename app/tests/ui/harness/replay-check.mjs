// 回放桥（replay.js）文件系统第 1、2 步那部分的无窗口自检（docs/specs/file-system.md §19.4），录制都是 synthetic 的：
// 第 1 步：旧录制补 allowedDirs、asks、awayTimers；away.get、away.set、question.answer 的应答与回放顺序；approval.forget
// 比较 dir。第 2 步：workspace.status 的合成结果与覆盖（页面参数 git、setWorkspace，录下的 mori.workspace_status 一起
// 盖上；录制里的 workspace.status 不算边界、录下的结果不用）、手写事件（inject、syntheticTurnChanges，条目 id 不重复）、
// snapshots.drop 的应答与回放顺序、会话信息的 worktree、没有
// teamEdited 的空 TaskBoard；这几项的检查名在 "harness:" 后面写所属的 FS 编号。
// 不开窗口、不用 Electron：tests/fake-endpoint/selfcheck.mjs 调用 replayChecks()，把结果记成 "harness:" 一组。

import {
  DIRECT_WRITES, OLD_GIT, QUERIES, answeredDirectly, createReplayBridge, syntheticTurnChanges, workspaceOption,
} from './replay.js';

/** synthetic 的会话文件夹与模型 */
const CWD = 'C:\\synthetic\\fs-replay';
const MODEL = 'mori-endpoint/replay-model';
/** synthetic：旧录制里的 session.create 结果（批准设置没有 allowedDirs，live 没有 asks、awayTimers） */
const CREATED = { sessionId: 's1', sessionFile: `${CWD}\\s1.jsonl`, cwd: CWD, model: MODEL,
  approval: { mode: 'ask', allowed: ['bash'] }, live: { running: false }, contextUsage: { contextWindow: 128000 } };
/** 录下的 approval.forget 的目录，与回放时答错的目录 */
const OUT_DIR = 'C:\\synthetic\\out';
const OTHER_DIR = 'C:\\synthetic\\other';
/** 录下的提问卡答复 */
const ANSWER = { type: 'question.answer', sessionId: 's1', requestId: 'q1',
  answers: [{ selected: ['PostgreSQL'], other: null }] };
const CREATE = { type: 'session.create', cwd: CWD };
const FORGET = { type: 'approval.forget', sessionId: 's1', dir: OUT_DIR };

/**
 * @brief synthetic 的录制：session.create、录制脚本经进程桥发的 away.set 10m、approval.forget（按目录，旧的结果没有
 *        allowedDirs）；answers 为真时最后再录一条 question.answer。
 */
function fixture(answers) {
  const steps = [
    { t: 0, command: CREATE },
    { t: 1, result: { type: 'session.create', value: CREATED } },
    { t: 2, command: { type: 'away.set', timeout: '10m' } },
    { t: 3, result: { type: 'away.set', value: { timeout: '10m', error: null } } },
    { t: 4, command: FORGET },
    { t: 5, result: { type: 'approval.forget', value: { mode: 'ask', allowed: ['bash'] } } },
  ];
  if (answers) steps.push({ t: 6, command: ANSWER }, { t: 7, result: { type: 'question.answer', value: null } });
  return { model: MODEL, endpoint: 'http://127.0.0.1:9/v1', steps };
}

/** @brief 一个回放桥（不等录制里的间隔）。 */
const bridgeOf = (answers) => createReplayBridge(fixture(answers), { speed: 1000, maxGap: 0 });

/** @brief 请求失败时的原文；成功时为空串。 */
async function failure(bridge, command) {
  try {
    await bridge.request(command);
    return '';
  } catch (error) {
    return error.message;
  }
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** @brief 旧录制补的字段：批准设置的 allowedDirs、live 的 asks 与 awayTimers；录下的字段不变。 */
async function checkDefaults(out) {
  const { bridge } = bridgeOf(false);
  const created = await bridge.request(CREATE);
  out.push({ name: 'harness: an old session.create gets approval.allowedDirs [] and live.asks / live.awayTimers [] '
    + '(synthetic); recorded fields stay', ok: same(created.approval, { mode: 'ask', allowed: ['bash'],
    allowedDirs: [] }) && same(created.live.asks, []) && same(created.live.awayTimers, [])
    && created.live.running === false, detail: JSON.stringify({ approval: created.approval, live: created.live }) });
}

/** @brief away.get：默认 5m → 这一段录下的 away.set → 界面发的 away.set；away.set 不占回放顺序。 */
async function checkAway(out) {
  const { bridge, control } = bridgeOf(false);
  const before = await bridge.request({ type: 'away.get' });
  await bridge.request(CREATE);
  const recorded = await bridge.request({ type: 'away.get' });
  const set = await bridge.request({ type: 'away.set', timeout: 'never' });
  const after = await bridge.request({ type: 'away.get' });
  const { status } = control;
  out.push({ name: 'harness: away.get answers 5m by default, then the away.set recorded in the segment, then the '
    + "UI's away.set; away.set (recorded or sent) takes no place in replay order",
  ok: same(before, { timeout: '5m', error: null }) && same(recorded, { timeout: '10m', error: null })
    && same(set, { timeout: 'never', error: null }) && same(after, { timeout: 'never', error: null })
    && status.cursor === 1 && same(status.awaySets, ['never']) && status.errors.length === 0
    && QUERIES.includes('away.get') && DIRECT_WRITES.includes('away.set') && answeredDirectly('away.set')
    && !answeredDirectly('question.answer'),
  detail: JSON.stringify({ before, recorded, set, after, cursor: status.cursor, errors: status.errors }) });
}

/** @brief approval.forget 比较 toolName 与 dir：录下的是按目录忘掉时，别的目录或按工具名都不一致；旧结果补 allowedDirs。 */
async function checkForget(out) {
  const { bridge, control } = bridgeOf(false);
  await bridge.request(CREATE);
  const otherDir = await failure(bridge, { ...FORGET, dir: OTHER_DIR });
  const byTool = await failure(bridge, { type: 'approval.forget', sessionId: 's1', toolName: 'bash' });
  const cursor = control.status.cursor;
  const forgot = await bridge.request(FORGET);
  out.push({ name: 'harness: approval.forget compares toolName and dir (another dir or a tool name is a replay '
    + 'mismatch); its old result gets allowedDirs []', ok: otherDir.startsWith('replay mismatch')
    && byTool.startsWith('replay mismatch') && cursor === 1 && control.status.cursor === 2
    && same(forgot, { mode: 'ask', allowed: ['bash'], allowedDirs: [] }),
  detail: JSON.stringify({ otherDir, byTool, cursor, forgot }) });
}

/** @brief question.answer：录制里有它时占回放顺序（比较 requestId 与 answers），没有时直接应答 null 并记下。 */
async function checkAnswer(out) {
  const recorded = bridgeOf(true);
  await recorded.bridge.request(CREATE);
  await recorded.bridge.request(FORGET);
  const wrong = await failure(recorded.bridge, { ...ANSWER, answers: null });
  const answered = await recorded.bridge.request(ANSWER);
  const direct = bridgeOf(false);
  await direct.bridge.request(CREATE);
  const unrecorded = await direct.bridge.request(ANSWER);
  const [a, b] = [recorded.control.status, direct.control.status];
  out.push({ name: 'harness: question.answer takes a place in replay order when the recording has one (answers '
    + 'compared); otherwise it is answered null and logged in status.questionAnswers',
  ok: wrong.startsWith('replay mismatch') && answered === null && a.cursor === 3 && a.questionAnswers.length === 0
    && unrecorded === null && b.cursor === 1 && same(b.questionAnswers, [ANSWER]),
  detail: JSON.stringify({ wrong, answered, cursors: [a.cursor, b.cursor], logged: b.questionAnswers }) });
}

// ---------- 文件系统第 2 步（§19.4） ----------

/** synthetic：合成的 workspace.status 的快照状态（on，没有跳过的文件与嵌套仓库） */
const SNAPSHOTS_ON = { state: 'on', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [],
  nestedTotal: 0 };
/** 回放时界面发的 workspace.status */
const STATUS = { type: 'workspace.status', sessionId: 's1' };
/** 删除会话后界面发的 snapshots.drop */
const DROP = { type: 'snapshots.drop', sessionId: 's1', cwd: CWD };
/** synthetic：录下的 mori.workspace_status（git 仓库里的状态，git ok） */
const RECORDED_STATUS = { cwd: CWD, git: { state: 'ok', version: '2.55.0' },
  repo: { toplevel: CWD, commonDir: `${CWD}\\.git`, gitDir: `${CWD}\\.git`, isWorktree: false, hasCommit: true },
  branch: { head: 'main', oid: 'a'.repeat(40), upstream: null, ahead: null, behind: null }, files: [], total: 0,
  truncated: false, error: null, snapshots: SNAPSHOTS_ON, at: 1 };

/**
 * @brief synthetic 的录制：session.create（结果之后录下一条 mori.workspace_status）、真实 App 发的 workspace.status
 *        与它录下的结果（git 仓库里的状态，recordedStatus 为真时）、录制脚本经进程桥发的 snapshots.drop（recordedDrop
 *        为真时）、approval.forget；info 盖在会话信息上。
 */
function fixture2({ recordedDrop = false, recordedStatus = false, info = {} } = {}) {
  const steps = [
    { t: 0, command: CREATE },
    { t: 1, result: { type: 'session.create', value: { ...CREATED, ...info } } },
    { t: 2, envelope: { kind: 'event', sessionId: 's1',
      event: { type: 'mori.workspace_status', status: RECORDED_STATUS } } },
  ];
  if (recordedStatus) {
    steps.push({ t: 2, command: STATUS }, { t: 3, result: { type: 'workspace.status', value: RECORDED_STATUS } });
  }
  if (recordedDrop) steps.push({ t: 3, command: DROP }, { t: 4, result: { type: 'snapshots.drop', value: null } });
  steps.push({ t: 5, command: FORGET }, { t: 6, result: { type: 'approval.forget', value: CREATED.approval } });
  return { model: MODEL, endpoint: 'http://127.0.0.1:9/v1', steps };
}

/** @brief 第 2 步的回放桥（不等录制里的间隔）与它收到的事件。 */
function bridge2(options = {}, fixtureOptions = {}) {
  const made = createReplayBridge(fixture2(fixtureOptions), { speed: 1000, maxGap: 0, ...options });
  const events = [];
  made.bridge.onEvent((envelope) => events.push(envelope));
  return { ...made, events };
}

/** @brief 合成的结果是不是默认的形状：git ok、repo null、没有分支与文件、快照 on、cwd 为会话的工作路径。 */
const defaultStatus = (status) => status.git.state === 'ok' && status.repo === null && status.branch === null
  && same(status.files, []) && status.total === 0 && status.truncated === false && status.error === null
  && same(status.snapshots, SNAPSHOTS_ON) && status.cwd === CWD && typeof status.at === 'number';

/** @brief workspace.status：只读查询，合成结果（录下的结果、事件不影响它），at 单调增加，不占回放顺序。 */
async function checkStatus(out) {
  const { bridge, control } = bridge2();
  const before = await bridge.request(STATUS);
  await bridge.request(CREATE);
  const after = await bridge.request(STATUS);
  const { status } = control;
  out.push({ name: 'harness: FS-13 workspace.status is a query answered with the synthetic status (git ok, repo null, '
    + 'no branch or files, snapshots on, the session cwd) and takes no place in replay order',
  ok: defaultStatus(before) && defaultStatus(after) && after.at > before.at && QUERIES.includes('workspace.status')
    && answeredDirectly('workspace.status') && status.cursor === 1 && status.errors.length === 0
    && status.queries.filter((query) => query.type === 'workspace.status').length === 2,
  detail: JSON.stringify({ before, after, cursor: status.cursor, errors: status.errors }) });
}

/**
 * @brief 录制里有 workspace.status（真实 App 发的命令与录下的结果，fs-real 的录制都有）：它不算回放的边界，后面的
 *        approval.forget 照常在第 2 条回放；回放时的 workspace.status 仍是合成的，不用录下的结果（repo、branch）。
 */
async function checkRecordedStatus(out) {
  const { bridge, control } = bridge2({}, { recordedStatus: true });
  await bridge.request(CREATE);
  const between = await bridge.request(STATUS);
  const forgot = await bridge.request(FORGET);
  const after = await bridge.request(STATUS);
  const { status } = control;
  out.push({ name: 'harness: FS-13 a recording that contains workspace.status (command and recorded result) does not '
    + 'take a place in replay order (approval.forget still replays second) and the recorded result is ignored for '
    + 'the synthetic status', ok: defaultStatus(between) && defaultStatus(after) && status.cursor === 2
    && status.errors.length === 0 && same(forgot, { mode: 'ask', allowed: ['bash'], allowedDirs: [] })
    && !same(between.repo, RECORDED_STATUS.repo) && !same(after.branch, RECORDED_STATUS.branch),
  detail: JSON.stringify({ between, after, cursor: status.cursor, errors: status.errors }) });
}

/** @brief 页面参数 git（workspaceOption）：old 为 2.31.0、missing 为没装 git、ok 或不给时不覆盖、别的值报错。 */
async function checkOption(out) {
  const old = bridge2({ workspace: workspaceOption('old') });
  await old.bridge.request(CREATE);
  await old.control.status.playing;
  const status = await old.bridge.request(STATUS);
  const missing = bridge2({ workspace: workspaceOption('missing') });
  const gone = await missing.bridge.request(STATUS);
  let bad = '';
  try {
    workspaceOption('2.31');
  } catch (error) {
    bad = error.message;
  }
  const recorded = old.events.find((item) => item.event.type === 'mori.workspace_status')?.event.status;
  out.push({ name: 'harness: FS-13 ?git=old makes workspace.status git { state: old, version: 2.31.0 } (also over a '
    + 'recorded mori.workspace_status, whose other fields stay); ?git=missing gives missing; ok or no parameter does '
    + 'not override; another value throws', ok: same(status.git, OLD_GIT) && same(OLD_GIT, { state: 'old',
    version: '2.31.0' }) && same(gone.git, { state: 'missing' }) && workspaceOption(null) === null
    && workspaceOption('ok') === null && bad === 'Unknown git parameter 2.31' && same(recorded?.git, OLD_GIT)
    && same(recorded?.repo, RECORDED_STATUS.repo) && recorded?.at === RECORDED_STATUS.at,
  detail: JSON.stringify({ status: status.git, gone: gone.git, bad, recorded }) });
}

/** @brief setWorkspace：之后的 workspace.status 按覆盖回答，并给打开的会话发一条合成的 mori.workspace_status。 */
async function checkSetWorkspace(out) {
  const { bridge, control, events } = bridge2();
  await bridge.request(CREATE);
  await control.status.playing;
  const recorded = events.find((item) => item.event.type === 'mori.workspace_status')?.event.status;
  const sent = control.setWorkspace({ git: OLD_GIT });
  const pushed = events.at(-1);
  const after = await bridge.request(STATUS);
  const { status } = control;
  out.push({ name: 'harness: FS-13 setWorkspace({ git: old }) answers the following workspace.status with git old '
    + 'and emits one synthetic mori.workspace_status to each opened session (status.sessions, status.injected); '
    + 'without an override a recorded mori.workspace_status stays as recorded',
  ok: same(recorded, RECORDED_STATUS) && sent === 1
    && pushed?.sessionId === 's1' && pushed.event.type === 'mori.workspace_status'
    && same(pushed.event.status.git, OLD_GIT) && pushed.event.status.cwd === CWD && same(after.git, OLD_GIT)
    && after.at > pushed.event.status.at && same(control.workspace(), { git: OLD_GIT })
    && same(status.sessions, [{ sessionId: 's1', cwd: CWD, sessionFile: CREATED.sessionFile }])
    && status.injected.length === 1 && status.cursor === 1,
  detail: JSON.stringify({ recorded, sent, pushed, after: after.git, sessions: status.sessions }) });
}

/** @brief inject 与 syntheticTurnChanges：手写的 mori.turn_changes 发给指定的会话，记在 status.injected，不占顺序。 */
async function checkInject(out) {
  const { bridge, control, events } = bridge2();
  await bridge.request(CREATE);
  await control.status.playing;
  const files = [{ path: 'README.md', status: 'M', added: 2, removed: 1 }, { path: 'logo.png', status: 'A',
    added: null, removed: null }];
  const event = syntheticTurnChanges({ round: 'r1', files });
  const envelope = control.inject('s1', event);
  const { record } = event;
  // 界面按条目 id 去重：同一轮、同样多文件的第二段要有另一个条目 id
  const second = syntheticTurnChanges({ round: 'r1', files });
  out.push({ name: 'harness: FS-23 inject(sessionId, syntheticTurnChanges(...)) sends a synthetic mori.turn_changes '
    + 'changes record (round, files, total, agent Mori self, no overlap) to that session; it is logged in '
    + 'status.injected and takes no place in replay order; a second record for the same turn gets another entry id',
  ok: same(events.at(-1), envelope) && second.entryId !== event.entryId
    && same(envelope, { kind: 'event', sessionId: 's1', event }) && event.type === 'mori.turn_changes'
    && typeof event.entryId === 'string' && record.v === 1 && record.kind === 'changes' && record.round === 'r1'
    && same(record.files, files) && record.total === 2 && same(record.agents, [{ role: 'mori', task: null,
    self: true }]) && record.overlap === false && same(control.status.injected, [envelope])
    && control.status.cursor === 1 && control.status.errors.length === 0,
  detail: JSON.stringify({ envelope, injected: control.status.injected.length }) });
}

/** @brief snapshots.drop：直接应答 { error: null }，记在 status.drops；录制里有它时同样不占回放顺序。 */
async function checkDrop(out) {
  const sent = bridge2();
  await sent.bridge.request(CREATE);
  const dropped = await sent.bridge.request(DROP);
  const forgot = await sent.bridge.request(FORGET);
  const recorded = bridge2({}, { recordedDrop: true });
  await recorded.bridge.request(CREATE);
  const replayed = await recorded.bridge.request(FORGET);
  const [a, b] = [sent.control.status, recorded.control.status];
  out.push({ name: 'harness: FS-20 snapshots.drop is answered { error: null } directly and logged in status.drops; '
    + 'it takes no place in replay order, also when the recording has one (DIRECT_WRITES)',
  ok: same(dropped, { error: null }) && same(a.drops, [DROP]) && a.cursor === 2 && a.errors.length === 0
    && same(forgot, { mode: 'ask', allowed: ['bash'], allowedDirs: [] }) && DIRECT_WRITES.includes('snapshots.drop')
    && answeredDirectly('snapshots.drop') && b.cursor === 2 && b.errors.length === 0 && same(b.drops, [])
    && same(replayed, forgot), detail: JSON.stringify({ dropped, drops: a.drops, cursors: [a.cursor, b.cursor],
    errors: [...a.errors, ...b.errors] }) });
}

/** @brief 会话信息缺 worktree 时补 null（录下的照旧）；合成的空 TaskBoard 没有 teamEdited。 */
async function checkInfo(out) {
  const old = bridge2();
  const created = await old.bridge.request(CREATE);
  const board = await old.bridge.request({ type: 'board.get', sessionId: 's1' });
  const place = { path: `${CWD}\\.mori\\worktrees\\fix-1a2b3c`, branch: 'mori/fix-1a2b3c', mainFolder: CWD };
  const recorded = bridge2({}, { info: { worktree: place } });
  const kept = await recorded.bridge.request(CREATE);
  out.push({ name: 'harness: FS-115 an old session.create gets worktree null (synthetic) and a recorded worktree '
    + 'stays; the synthetic empty TaskBoard (session info and board.get) has no teamEdited',
  ok: created.worktree === null && same(kept.worktree, place) && same(created.board, { requests: [] })
    && same(board, { requests: [], error: null }),
  detail: JSON.stringify({ worktree: created.worktree, kept: kept.worktree, board, infoBoard: created.board }) });
}

/** @brief 全部检查（每项一个新的回放桥），结果为 [{ name, ok, detail }]。 */
export async function replayChecks() {
  const out = [];
  const checks = [checkDefaults, checkAway, checkForget, checkAnswer, checkStatus, checkRecordedStatus, checkOption,
    checkSetWorkspace, checkInject, checkDrop, checkInfo];
  for (const check of checks) await check(out);
  return out;
}
