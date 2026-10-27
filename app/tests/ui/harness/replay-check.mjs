// 回放桥（replay.js）文件系统第 1 步那部分的无窗口自检（docs/specs/file-system.md §19.4），录制都是 synthetic 的：
// 旧录制补 allowedDirs、asks、awayTimers；away.get、away.set、question.answer 的应答与回放顺序；approval.forget 比较 dir。
// 不开窗口、不用 Electron：tests/fake-endpoint/selfcheck.mjs 调用 replayChecks()，把结果记成 "harness:" 一组。

import { DIRECT_WRITES, QUERIES, answeredDirectly, createReplayBridge } from './replay.js';

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

/** @brief 全部检查（每项一个新的回放桥），结果为 [{ name, ok, detail }]。 */
export async function replayChecks() {
  const out = [];
  for (const check of [checkDefaults, checkAway, checkForget, checkAnswer]) await check(out);
  return out;
}
