// 从真实的 App 对合成端点录制收尾检查回放用的 fixture（tests/fixtures/finish/*.json；docs/specs/finish-check.md §14.1
// 回放一行：FC-11、FC-12、FC-13、FC-23 用的全部 fixture 都由本脚本录下，source 为 synthetic，同记忆规格 §14.1 的做法，
// 所以 npm run test:finish 在负责人走查之前就能过；fc-real.mjs 的真实录制另名 fc-*-real.json，本脚本不碰它们）。
// 做法同 mem-record.mjs：页面里的录制器（fc-real-helpers.mjs installRecorder）直接通过 window.mori（与界面相同的进程桥）
// 发命令，命令的写法与界面发出的相同（state/projects.ts 的 trust.check 后 session.create、输入框发出的 session.prompt、
// 权限菜单 Full access 的 approval.setMode、侧栏打开会话的 session.open），记下命令、结果和后台进程转发的全部事件及其时间。
// 准备（synthetic test setup）：model-config.json 只有一个本机区域的提供商 FC（fake-coder），默认范围 fc/fake-coder，档案直接
// 给出已验证（tb-helpers.mjs seedTeamUserData，跳过探针）。回复全部来自合成端点的收尾检查场景（tests/fake-endpoint/finish.mjs
// 的 FC_SCENARIOS，§14.1 的表）：你的消息里写 "fc-scenario:<名字>"，这次运行的每个请求（含检查请求）都由那个场景回答。
//   fc-a（FC-11、FC-23）：回复 Done.，检查之后只调 finish；之后 Mori 重启、打开同一个会话（{ restart: true } 之后的一段）。
//   fc-a-text（FC-11）：检查之后在同一条消息里写 The reply stands. 再调 finish。
//   fc-early（FC-11）：回复里就调了 finish（检查之前），照样检查一次，再调 finish。
//   fc-b（FC-12）：Full access 之后，回复 I'll run the tests.；检查之后调 bash、再回复 The tests passed.；第二次检查确认；
//     之后重启、打开同一个会话。
//   fc-c（FC-13）：回复 Draft answer.；检查之后重写为 Conclusion first: rewritten answer.，不调 finish，不再检查。
//   fc-a-think（FC-23）：两次回复都先有一段思考（检查那条消息只有思考与 finish）；之后重启、打开同一个会话。
// 录完先核对场景要的东西真的发生了（check）：合成端点的日志行（这个场景的请求、哪几个是检查请求、checks 的值）、录下的事件
// （一个 agent_settled、每次检查多一个 agent_start、finish 的调用数、回复的文字、思考）与会话文件（检查那一行的条数，
// display 为 false）。不符合时不写进 fixtures，写到 test-results/fc-record/<名字>.rejected.json，退出码 1。
// 用法（在 app/ 下，out/ 是当前的构建；MORI_APP_DIR 可指向别的构建）：
//   node tests/ui/fc-record.mjs [--only fc-a,fc-b] [--out <目录>]
// --out 只用来检查本脚本自己。端口：4970（合成端点；§0 第 13 条的 4950–4979 里 fc-app-check 用 4950–4959、
// fc-app-team 用 4960–4969，本脚本用 4970，fc-real.mjs 的转发代理用 4975）。

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, sleep } from './lib.mjs';
import { readJsonl, seedTeamUserData, tbModel, tbProvider, tempUserData } from './tb-helpers.mjs';
import { baseOf, startEndpoint, stopEndpoint } from './v1-switch-helpers.mjs';
import {
  commonProblems, failuresOf, FINISH_TOOL, installRecorder, isCheckEntry, need, recDriver, saveFixture, sessionEvents,
  textOf, valuesOf,
} from './fc-real-helpers.mjs';

const only = arg('only')?.split(',').filter(Boolean);
const outDir = arg('out') ? resolve(arg('out')) : join(appRoot, 'tests/fixtures/finish');
const rejectedDir = join(appRoot, 'test-results/fc-record');
/** 合成端点的端口 */
const PORT = 4970;
/** 提供商与默认范围（synthetic test setup） */
const PROVIDER = 'fc';
const MODEL = `${PROVIDER}/fake-coder`;
/** 等一件事的时限 */
const WAIT_MS = 120000;

/**
 * 录制的场景：name 是合成端点的场景名（也是 fixture 名），text 是你的消息，fullAccess 为真时先切到 Full access，reopen 为真时
 * 录完重启、打开同一个会话。want 是核对用的（§14.1 的表）：requests（这个场景的请求依次是不是检查请求）、checks（检查请求
 * 日志的 checks）、finish（finish 的调用数）、texts（助手消息的非空文字，按顺序）、tools（finish 以外的工具）、thinking
 * （带思考的助手消息数）。
 */
const SCENARIOS = [
  { name: 'fc-a', covers: 'FC-11, FC-23', reopen: true, text: 'fc-scenario:fc-a Is the build green?',
    description: 'Off mode: the reply is "Done.", the finish check follows in the same run and the model only calls '
      + 'finish. Mori restarts and the same session is opened again.',
    want: { requests: [false, true], checks: [1], finish: 1, texts: ['Done.'] } },
  { name: 'fc-a-text', covers: 'FC-11', text: 'fc-scenario:fc-a-text Is the build green?',
    description: 'Off mode: the reply is "Done."; answering the check the model writes "The reply stands." and calls '
      + 'finish in the same message, so that sentence is the final reply.',
    want: { requests: [false, true], checks: [1], finish: 1, texts: ['Done.', 'The reply stands.'] } },
  { name: 'fc-early', covers: 'FC-11', text: 'fc-scenario:fc-early Is the build green?',
    description: 'Off mode: the reply "Done." already calls finish (before any check); the check still follows once '
      + 'and the model calls finish again.',
    want: { requests: [false, true], checks: [1], finish: 2, texts: ['Done.'] } },
  { name: 'fc-b', covers: 'FC-12', fullAccess: true, reopen: true, text: 'fc-scenario:fc-b Please run the tests.',
    description: 'Full access: the reply says "I\'ll run the tests." without a tool call; after the check the model '
      + 'runs bash and replies "The tests passed."; the second check is confirmed with finish. Mori restarts and the '
      + 'same session is opened again.',
    want: { requests: [false, true, false, true], checks: [1, 2], finish: 1,
      texts: ['I\'ll run the tests.', 'The tests passed.'], tools: ['bash'] } },
  { name: 'fc-c', covers: 'FC-13', text: 'fc-scenario:fc-c What should I do first?',
    description: 'Off mode: the reply is "Draft answer."; answering the check the model rewrites it as "Conclusion '
      + 'first: rewritten answer." without calling finish, and the run ends without a second check.',
    want: { requests: [false, true], checks: [1], finish: 0, texts: ['Draft answer.',
      'Conclusion first: rewritten answer.'] } },
  { name: 'fc-a-think', covers: 'FC-23', reopen: true, text: 'fc-scenario:fc-a-think Is the build green?',
    description: 'Off mode: the reply has a thinking part and "Done."; the check request is answered with a thinking '
      + 'part and finish only. Mori restarts and the same session is opened again.',
    want: { requests: [false, true], checks: [1], finish: 1, texts: ['Done.'], thinking: 2 } },
];

// ---------- 核对（在 node 里） ----------

/** @brief 重启前（before）或重启后（after）的步骤；没有重启时 before 是全部。 */
function partOf(steps, part) {
  const at = steps.findIndex((s) => s.restart);
  if (at < 0) return part === 'before' ? steps : [];
  return part === 'before' ? steps.slice(0, at) : steps.slice(at + 1);
}

/** @brief 一条助手消息里有没有非空的思考块。 */
const hasThinking = (message) => (message.content ?? []).some((part) => part.type === 'thinking'
  && part.thinking?.trim());

/** @brief 录下的事件对不对：一个 agent_settled、每次检查多一个 agent_start、finish 的调用数、文字、工具、思考。 */
function eventProblems(steps, id, want) {
  const settled = sessionEvents(steps, id, 'agent_settled').length;
  const starts = sessionEvents(steps, id, 'agent_start').length;
  const tools = sessionEvents(steps, id, 'tool_execution_end');
  const assistants = sessionEvents(steps, id, 'message_end').map((e) => e.message)
    .filter((m) => m.role === 'assistant');
  const texts = assistants.map((m) => textOf(m.content).trim()).filter(Boolean);
  const others = tools.filter((e) => e.toolName !== FINISH_TOOL);
  return [...need(settled === 1, `${settled} agent_settled`),
    ...need(starts === want.checks.length + 1, `${starts} agent_start for ${want.checks.length} check(s)`),
    ...need(tools.filter((e) => e.toolName === FINISH_TOOL).length === want.finish,
      `finish calls ${tools.filter((e) => e.toolName === FINISH_TOOL).length}`),
    ...need(JSON.stringify(texts) === JSON.stringify(want.texts), `texts ${JSON.stringify(texts)}`),
    ...need(JSON.stringify(others.map((e) => e.toolName)) === JSON.stringify(want.tools ?? [])
      && others.every((e) => !e.isError), `tools ${JSON.stringify(others.map((e) => [e.toolName, e.isError]))}`),
    ...need(want.thinking === undefined || assistants.filter(hasThinking).length === want.thinking,
      `${assistants.filter(hasThinking).length} assistant messages with thinking`)];
}

/** @brief 合成端点的日志行对不对：这个场景的请求依次是不是检查请求、检查请求的 checks。 */
function logProblems(logs, scenario) {
  const lines = logs.filter((line) => !line.probe && line.scenario === scenario.name);
  const kinds = lines.map((line) => Boolean(line.check));
  const checks = lines.filter((line) => line.check).map((line) => line.checks);
  return [...need(JSON.stringify(kinds) === JSON.stringify(scenario.want.requests),
    `requests ${JSON.stringify(kinds)}`),
    ...need(JSON.stringify(checks) === JSON.stringify(scenario.want.checks), `checks ${JSON.stringify(checks)}`)];
}

/** @brief 会话文件里检查那一行的条数（display 为 false）。 */
function fileProblems(file, want) {
  const lines = readJsonl(file).filter(isCheckEntry);
  return need(lines.length === want.checks.length && lines.every((entry) => entry.display === false),
    `session file check lines ${JSON.stringify(lines.map((entry) => entry.display))}`);
}

/** @brief 一个场景的全部核对；重启后的一段：打开会话成功、没有失败的命令。 */
function check(steps, ctx, scenario) {
  const before = partOf(steps, 'before');
  const after = partOf(steps, 'after');
  const session = valuesOf(before, 'session.create')[0];
  const opened = valuesOf(after, 'session.open')[0];
  return [...commonProblems(before), ...(session ? eventProblems(before, session.sessionId, scenario.want) : []),
    ...logProblems(ctx.logs, scenario), ...(session ? fileProblems(session.sessionFile, scenario.want) : []),
    ...need(!scenario.reopen || (after.length > 0 && failuresOf(after).length === 0
      && opened?.sessionFile === session?.sessionFile), `reopen: ${failuresOf(after).join('; ') || 'not opened'}`)];
}

// ---------- 执行 ----------

/** @brief 启动 Mori，装好录制器（offset：重启后接着重启前最后一步的时间往后算）。 */
async function startMori(state, offset = 0) {
  state.app = await launch({ userData: state.userData });
  state.page = await state.app.firstWindow();
  await state.page.waitForFunction(() => Boolean(window.mori));
  await state.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await state.page.evaluate(installRecorder, offset);
}

/** @brief 重启：记下重启前的步骤，退出，再启动。 */
async function restartMori(state, note) {
  const steps = await state.page.evaluate(() => window.__fcRec.steps);
  const last = steps.at(-1)?.t ?? 0;
  state.kept.push(...steps, { t: last, note: `Restart: ${note}` }, { t: last, restart: true });
  await state.app.close();
  await startMori(state, last);
}

/** @brief 录一个场景：新建会话（需要时 Full access）、发消息、等运行结束；需要时重启并打开同一个会话。 */
async function drive(d, state, ctx, scenario) {
  await d.start();
  const session = await d.create(ctx.cwd);
  if (scenario.fullAccess) await d.cmd({ type: 'approval.setMode', sessionId: session.sessionId, mode: 'full' });
  await d.say(session, scenario.text);
  if (!scenario.reopen) return;
  await restartMori(state, 'Quit and start again (no configuration change)');
  await d.start();
  await d.cmd({ type: 'trust.check', cwd: ctx.cwd });
  await d.cmd({ type: 'session.open', sessionFile: session.sessionFile });
}

/** @brief 一个场景的准备：项目、数据目录（模型配置与档案，synthetic）、合成端点。 */
async function prepare() {
  const made = prepareProject('mori-fc-record-');
  const userData = tempUserData('mori-fc-record-data-');
  seedTeamUserData(userData, { providers: [tbProvider(PROVIDER, PORT, [tbModel('fake-coder')], { name: 'FC' })],
    normalDefault: MODEL });
  const ctx = { cwd: made.project, root: made.root, userData, logs: [], notes: ['Setup (synthetic test setup, '
    + 'docs/specs/finish-check.md §14.1): model-config.json has one local provider FC (fake-coder) on the synthetic '
    + `endpoint ${baseOf(PORT)}, default range ${MODEL}, profiles given as verified; every reply comes from the `
    + 'finish-check scenario named in the message (tests/fake-endpoint/finish.mjs FC_SCENARIOS)'] };
  ctx.endpoint = await startEndpoint(PORT, {}, ctx.logs);
  return ctx;
}

/** @brief 录一个场景：准备、录制、核对，写出 fixture（不符合时写到 rejected）。 */
async function recordScenario(scenario) {
  const ctx = await prepare();
  const state = { userData: ctx.userData, app: null, page: null, kept: [] };
  let steps = [];
  let problems;
  try {
    await startMori(state);
    await state.page.evaluate(() => window.__fcRec.begin());
    await drive(recDriver(state, WAIT_MS), state, ctx, scenario);
    await sleep(800);
    steps = [...state.kept, ...(await state.page.evaluate(() => window.__fcRec.steps))];
    problems = check(steps, ctx, scenario);
  } catch (error) {
    steps = [...state.kept, ...(await state.page?.evaluate(() => window.__fcRec.steps).catch(() => []) ?? [])];
    problems = [`flow: ${oneLine(error?.stack ?? error, 600)}`];
  } finally {
    await state.app?.close().catch(() => {});
    await stopEndpoint(ctx.endpoint);
    for (const dir of [ctx.userData, ctx.root]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
  saveFixture({ source: 'synthetic', note: 'Recorded from the real App against the synthetic endpoint by '
    + 'tests/ui/fc-record.mjs (docs/specs/finish-check.md §14.1); do not edit by hand.', name: scenario.name,
  description: scenario.description, covers: scenario.covers, endpoint: baseOf(PORT), model: MODEL, notes: ctx.notes,
  recordedAt: new Date().toISOString(), steps }, problems, { outDir, rejectedDir });
}

const unknown = (only ?? []).filter((name) => !SCENARIOS.some((s) => s.name === name));
if (unknown.length) {
  console.error(`[fc-record] unknown scenario(s): ${unknown.join(', ')}`);
  process.exit(1);
}
for (const scenario of SCENARIOS) {
  if (only && !only.includes(scenario.name)) continue;
  await recordScenario(scenario);
}
