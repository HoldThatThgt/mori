// 记忆规格（docs/specs/memory.md §14.2）增强部分的 App 套件 A：真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点的
// 增强脚本（tests/fake-endpoint/enhance.mjs，synthetic），在一个 App 里验收运行时操作得到的情形：
// MEM-17（开关与设置对话框、没有默认范围、读不出设置、关掉时停下正在跑的）、MEM-19（反馈的选取、关掉几天再打开、
// 只列同一工作目录且有对话的会话、增强会话自己不在里面）、MEM-20（看不见的会话）、MEM-21（写入的限制与依据）、
// MEM-22（一次运行一条修订）、MEM-23（端点出错、失败的运行写入的改动可以回滚、token）、MEM-25（Run now、状态行、进度）、
// MEM-26（新会话的提示）、MEM-27（反馈）、MEM-32（增强会话的模型、思考强度、调度类别 background）。
// 启动前就要写好的情形（补跑、定时器、两个项目同时到点、日子结束后再跑、运行中结束后台进程）在 mem-app-enhance-b.mjs。
// 用法（在 app/ 下，先构建）：node tests/ui/mem-app-enhance-a.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/mem-app-enhance-a(-packaged).json（--only 时 mem-partial-app-enhance-a…），截图与 App 日志在
// test-results/mem-app-enhance-a/。端口：合成端点 4730，记录代理 4731（看完整的请求体）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里写好提供商与模型档案（跳过探针）：me（fake-me 标了支持思考、
// fake-plain 没标）、mx（fake-x-404：合成端点对它的对话请求回 404）、mq（fake-mq，并发 1，调度类别用），分组
// g-plain-first（me/fake-plain、mq/fake-mq：第一个候选没标支持思考，Effort 用）；默认范围 me，pi 的默认思考强度 high。
// 每个步骤用自己的临时项目；会话文件、反馈文件、enhance.json、项目扩展、角色文件、读不出的项目模型配置由测试写好。
// 2026-10-26（docs/v0/screens/window.md"关掉窗口"，WP-20 记录"状态表各行的用例"）：增强运行中关掉窗口（藏进系统托盘），
// 这次运行照常跑完（hiddenRun，名字以 "window.md" 开头，不计入覆盖检查；托盘经 tray-helpers.mjs 在主进程里找到）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS_TEXT } from '../fake-endpoint/scenarios/models.mjs';
import {
  NOTE_OFF, NOTE_ON, TASKS, addDays, appendSession, backToApp, brief, chatItems, clickSwitch, dayOf, dayStart,
  enhanceGet, enhanceProgress, enhanceRequests, enhanceSeed, errorLine, ev, expectedStatus, feedbackNames,
  feedbackNotes, feedbackSection, fileTokens, headlessFiles, listedSessions, localDay, makeProject, mem, memArgs,
  memoryGet, memoryList, memProjectDir, memRecorder, monthDay, monthDayTime, nextBoundary, noticeOf,
  openMemoryProject, phaseBrief, quietScript, readEnhance, revisionView, runEnabled, runRevisions,
  same, say, seededEffortPicks, seedFeedback, seedSession, seedTeamDir, sleep, switchState, toolResultsOf, waitFor,
  waitSettled, waitStatus, watchFeedbackNote, watchSwitchPending, writeEnhance, writeScript,
} from './mem-enhance-helpers.mjs';
import { detailState } from './mem-page-helpers.mjs';
import {
  bridge, closeTbApp, contentText, kernelEvents, newSession, openSessionIn, paneSel, paneState, poll, seedTeamUserData,
  sendMessage, shot, showTab, startTbApp, startTbEndpoint, stopTbEndpoint, tbModel, tbProvider, tempUserData,
  userSession, waitTaskPhase, watchTaskPhases, writeRoles,
} from './tb-helpers.mjs';
import {
  clickTrayIcon, closeWindow, findTray, offScreen, onScreen, recordBalloons, waitWindow, windowState,
} from './tray-helpers.mjs';

const args = memArgs('enhance-a');
const { record, finish } = memRecorder(args);

/** 本套件的端口（§14.1 的 4700–4799 里分给它的 4730–4739）：合成端点与它前面的记录代理 */
const PORT = 4730;
const PROXY = 4731;
/** 临时目录：项目文件夹与增强脚本文件都在这里（synthetic） */
const ROOT = mkdtempSync(join(tmpdir(), 'mori-mem-enh-a-'));
const SCRIPT = join(ROOT, 'enhance-script.json');
/** 关着时的状态行（§10.4，临时） */
const OFF_TEXT = 'Off · Each day, three background runs review this project’s sessions and improve its TASTE, '
  + 'STRATEGY, and REVIEW';
/** 设置对话框 Effort 不可用时的悬停：第一个候选没标支持思考（§10.4）；没有选中范围或范围取不到候选（memory-enhance.md） */
const EFFORT_UNSUPPORTED = 'This model isn’t marked “Supports thinking”';
const EFFORT_NO_RANGE = 'Choose a model first.';
/** 后台进程退出时的悬停（§10.10） */
const WRITE_REFUSED = 'Enhancement runs can only change memory, with the memory tool.';
/** 项目文件夹（每个步骤自己的），名字也是增强脚本 "<kind>@<名字>" 键里认项目用的文字 */
const NAMES = ['s1-settings', 's2-reenable', 's3-nodefault', 's4-broken', 's5-noentry', 't1-turnoff', 'r1-runnow',
  'n1-notice',
  'n2-failnotice', 'f1-endpoint', 'hx-untrusted', 'hx-trusted', 'h3-badpick', 'h4-badroles', 'w1-evidence',
  'v1-onerun', 'o1-offdays', 'o1-offdays-other', 'mh-hold', 'mq-team', 'm1-sched', 'x1-refile', 'hw-hidden'];

// ---------- 小工具 ----------

/** @brief 今天（每天的时刻为 time 时，现在属于的日子）。 */
const todayOf = (time = '04:00') => dayOf(Date.now(), time);

/** @brief 发一句话，等这个会话回复完（多了一条回复，不在生成、不在发送）。 */
async function chatOnce(ctx, tab, text, timeout = 60000) {
  const before = (await paneState(ctx.page, tab))?.assistants.length ?? 0;
  await sendMessage(ctx, tab, text);
  const ok = await waitFor(async () => {
    const pane = await paneState(ctx.page, tab);
    return pane !== null && pane.assistants.length > before && !pane.running && !pane.sending;
  }, timeout);
  if (!ok) throw new Error(`no reply to "${text}" in ${tab}`);
}

/** @brief 记录代理收到的普通请求里，最后一条用户消息含 text 的那些（按收到的顺序）。 */
function requestsWith(ctx, text, since = 0) {
  return ctx.ep.proxy.captures.filter((item) => item.chat && item.body && item.t >= since).filter((item) => {
    const users = (item.body.messages ?? []).filter((m) => m.role === 'user');
    return contentText(users.at(-1)?.content).includes(text);
  });
}

/** @brief 请求里 system 消息的全文。 */
const systemOf = (body) => (body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer')
  .map((m) => contentText(m.content)).join('\n');

/** @brief 点 Run now，等这个项目有 count 个任务结束；返回这段时间的进度。 */
async function clickRunNow(ctx, cwd, count = 3, timeout = 120000) {
  const since = Date.now();
  await ctx.page.getByTestId('enhance-run').click();
  return waitSettled(ctx, cwd, since, count, timeout);
}

/** @brief 经进程桥发 enhance.run（测试准备，不是被测的界面操作），等这个项目有 count 个任务结束。 */
async function bridgeRun(ctx, cwd, count = 3, timeout = 120000) {
  const since = Date.now();
  const result = await bridge(ctx, { type: 'enhance.run', cwd });
  if (result.error) throw new Error(`enhance.run ${cwd}: ${result.error}`);
  return waitSettled(ctx, cwd, since, count, timeout);
}

/** @brief 经进程桥打开增强（测试准备）；返回 enhance.set 的结果。 */
async function bridgeEnable(ctx, cwd, patch = {}) {
  const result = await bridge(ctx, { type: 'enhance.set', cwd, enabled: true, ...patch });
  if (result.error) throw new Error(`enhance.set ${cwd}: ${result.error}`);
  return result;
}

/** @brief 打开设置对话框，按 change 改各项后 Save，等对话框关闭。 */
async function saveDialog(ctx, change) {
  await ctx.page.getByTestId('enhance-settings').click();
  const dialog = ctx.page.getByTestId('enhance-dialog');
  await dialog.waitFor({ timeout: 10000 });
  const model = dialog.getByTestId('enhance-model');
  await waitFor(() => model.isEnabled(), 10000, 200);
  if (change.pick) await model.selectOption(change.pick);
  if (change.effort) await dialog.getByTestId('enhance-effort').selectOption(change.effort);
  if (change.team !== undefined) await dialog.getByTestId('enhance-team').setChecked(change.team);
  if (change.time) await dialog.getByTestId('enhance-time').fill(change.time);
  await dialog.getByTestId('enhance-save').click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 一次运行的第一条消息（这个项目、这个种类最近一次运行的第一个请求）；没有时为 null。 */
function lastFirst(ctx, cwd, kind, since = 0) {
  return enhanceRequests(ctx.ep, { cwd, kind, since }).at(-1)?.first ?? null;
}

/** @brief 一个今天的合成会话（synthetic）：minutesAgo 分钟前开始的两问两答。 */
function todaySession(ctx, cwd, name, minutesAgo = 30) {
  const at = Date.now() - minutesAgo * 60000;
  return seedSession(ctx.userData, cwd, { name, items: chatItems([`Question one about ${name}`, 'Answer one.',
    `Question two about ${name}`, 'Answer two.'], at, 60000) });
}

// ---------- 准备 ----------

/** @brief synthetic 项目扩展：开始与关闭时往项目里的 ext-log.txt 记一行（会话目录与 id）；工具 ext_ask 经 ctx.ui 问一句。 */
function writeProbeExtension(project) {
  const source = [
    '// synthetic: written by tests/ui/mem-app-enhance-a.mjs (MEM-20); logs its sessions and asks through ctx.ui.',
    "import { appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const params = { type: 'object', properties: {}, additionalProperties: false };",
    'export default function (pi) {',
    '  const log = (ctx, what) => appendFileSync(join(ctx.cwd, \'ext-log.txt\'),',
    "    `${what} ${ctx.sessionManager.getSessionDir()} ${ctx.sessionManager.getSessionId()}\\n`);",
    "  pi.on('session_start', async (_event, ctx) => log(ctx, 'start'));",
    "  pi.on('session_shutdown', async (_event, ctx) => log(ctx, 'shutdown'));",
    "  pi.registerTool({ name: 'ext_ask', label: 'Ext ask', description: 'Asks one question.', parameters: params,",
    '    async execute(_id, _params, _signal, _onUpdate, ctx) {',
    "      const ok = await ctx.ui.confirm('Synthetic question', 'Asked during an enhancement run');",
    "      return { content: [{ type: 'text', text: 'confirm=' + ok }], details: {} };",
    '    } });',
    '}',
    '',
  ].join('\n');
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'probe.ts'), source);
}

/** @brief 合成端点、项目、扩展与角色文件、数据目录（synthetic test setup），启动 App。 */
async function setup(ctx) {
  writeScript(SCRIPT, {});
  ctx.p = Object.fromEntries(NAMES.map((name) => [name, makeProject(ROOT, name)]));
  writeProbeExtension(ctx.p['hx-untrusted']);
  writeProbeExtension(ctx.p['hx-trusted']);
  mkdirSync(join(ctx.p['h4-badroles'], '.mori', 'agents'), { recursive: true });
  writeFileSync(join(ctx.p['h4-badroles'], '.mori', 'agents', 'bad.md'),
    '---\nname: bad\ndescription: A synthetic role with an unknown tool\ntools: [read, hammer]\n---\nbody\n');
  writeRoles(ctx.p['mq-team'], [
    { name: 'chat', description: 'Talks with the user and relays', seats: ['dialog'] },
    { name: 'planner', description: 'Plans each request and closes it', seats: ['create', 'close'] },
    { name: 'executor', description: 'Reads files and changes code for a task', models: ['mq/fake-mq'] }]);
  // MEM-21 的会话在 App 启动前写好（界面的会话列表在启动时读；Jump to source 按它判断会话还在不在）
  ctx.w1seed = todaySession(ctx, ctx.p['w1-evidence'], 'Evidence', 90);
  ctx.ep = await startTbEndpoint(PORT, PROXY, { FAKE_ENHANCE_SCRIPT: SCRIPT });
  const providers = [
    tbProvider('me', PROXY, [tbModel('fake-me', { reasoning: true }), tbModel('fake-plain')]),
    tbProvider('mx', PROXY, [tbModel('fake-x-404')]),
    tbProvider('mq', PROXY, [tbModel('fake-mq', { reasoning: true })], { concurrency: 1 }),
  ];
  const groups = [{ id: 'g-plain-first', members: ['me/fake-plain', 'mq/fake-mq'] }];
  ctx.effortPicks = seededEffortPicks(providers, groups);
  seedTeamUserData(ctx.userData, { providers, groups, normalDefault: 'me',
    piSettings: { defaultThinkingLevel: 'high' }, trusted: [ctx.p['hx-trusted']] });
  await startTbApp(ctx);
  await watchTaskPhases(ctx);
}

// ---------- MEM-17：开关与设置对话框 ----------

/** @brief 打开开关：默认范围、第一个候选的默认强度、04:00、since 为今天；状态行“还没跑过”。 */
async function settingsEnable(ctx) {
  const cwd = ctx.p['s1-settings'];
  ctx.s1 = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, ctx.s1);
  const off = await waitStatus(ctx, OFF_TEXT, 10000);
  const offSwitch = await switchState(ctx);
  record('MEM-25 status line, off: "Off · Each day, three background runs review this project’s sessions and '
    + 'improve its TASTE, STRATEGY, and REVIEW"; the switch is off and Run now is disabled',
  off === OFF_TEXT && offSwitch.checked === 'false' && !(await runEnabled(ctx)), brief([off, offSwitch]));
  await watchSwitchPending(ctx);
  await clickSwitch(ctx, true);
  const pending = await ctx.page.evaluate(() => window.__enhancePending);
  record('MEM-17 while the switch is being turned on (enhance.set not back yet) it keeps its old state (aria-checked '
    + 'false) and is unavailable (disabled)', pending?.checked === 'false' && pending.disabled === true,
  brief(pending));
  const file = readEnhance(ctx.userData, cwd);
  const today = todayOf();
  record('MEM-17 turning the switch on writes enhance.json with the default range (me), the first candidate’s '
    + 'default effort (pi default high), team off, 04:00, since = today and every doneThrough = the day before',
  file?.enabled === true && file.pick === 'me' && file.thinking === 'high' && file.team === false
    && file.time === '04:00' && file.since === today
    && TASKS.every((task) => file.tasks[task].doneThrough === addDays(today, -1)), brief(file));
  const on = await waitStatus(ctx, (text) => text.startsWith('On'), 10000);
  const want = `On · Next run ${monthDayTime(nextBoundary(Date.now(), '04:00'))}`;
  record('MEM-25 status line, on and never run: "On · Next run <Mon D> 04:00"; the switch is on',
    on === want && (await switchState(ctx)).checked === 'true', brief({ on, want }));
}

/** @brief 打开设置对话框，等 Model range 可用（模型设置读到）；返回对话框与四项。 */
async function openEnhanceDialog(ctx) {
  await ctx.page.getByTestId('enhance-settings').click();
  const dialog = ctx.page.getByTestId('enhance-dialog');
  await dialog.waitFor({ timeout: 10000 });
  const [model, effort, team, time] = ['enhance-model', 'enhance-effort', 'enhance-team', 'enhance-time']
    .map((id) => dialog.getByTestId(id));
  await waitFor(() => model.isEnabled(), 10000, 200);
  return { dialog, model, effort, team, time };
}

/** @brief 按 Cancel 关掉设置对话框。 */
async function cancelDialog(c) {
  await c.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await c.dialog.waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 对话框里选 pick（省略时不选），读 Effort 此刻的样子：{ pick（下拉的值）, disabled, title, value }。 */
async function effortWith(c, pick) {
  if (pick !== undefined) await c.model.selectOption(pick);
  return { pick: await c.model.inputValue(), disabled: await c.effort.isDisabled(),
    title: await c.effort.getAttribute('title'), value: await c.effort.inputValue() };
}

/**
 * @brief Effort 按所选范围的 effortPicks（§10.4）：第一个候选标了支持思考的范围（提供商、模型）可用、没有悬停；
 *        没标的（模型、提供商、分组）不可用、悬停 This model isn’t marked “Supports thinking”、保持原来的值。
 */
async function dialogEffort(c) {
  const read = async (picks) => {
    const out = {};
    for (const pick of picks) out[pick] = await effortWith(c, pick);
    return out;
  };
  const on = await read(['me', 'mq', 'me/fake-me']);
  const off = await read(['me/fake-plain', 'mx', 'g-plain-first']);
  const picked = (states) => Object.entries(states).every(([pick, state]) => state.pick === pick);
  record('MEM-17 a range whose first candidate is marked "Supports thinking" (effortPicks true) leaves Effort usable '
    + 'with no hover: provider me (first candidate fake-me, though fake-plain is not marked), provider mq, me/fake-me',
  picked(on) && Object.values(on).every((s) => !s.disabled && s.title === null), brief(on));
  record('MEM-17 a range whose first candidate is not marked "Supports thinking" (effortPicks false) disables Effort '
    + 'with the hover "This model isn’t marked “Supports thinking”" and keeps its value (high): me/fake-plain, '
    + 'provider mx (fake-x-404), group g-plain-first (first candidate me/fake-plain, though mq/fake-mq is marked)',
  picked(off) && Object.values(off).every((s) => s.disabled && s.title === EFFORT_UNSUPPORTED && s.value === 'high'),
  brief(off));
}

/** @brief 设置对话框：effortPicks、初值、Effort 按范围可不可用、清空时间、Save 写进 enhance.json。 */
async function settingsDialog(ctx) {
  const cwd = ctx.p['s1-settings'];
  const info = await enhanceGet(ctx, cwd);
  record('MEM-17 enhance.get carries effortPicks: every group, provider and <provider>/<model> of the seeded model '
    + 'settings, true exactly when the range\'s first candidate is marked "Supports thinking" (g-plain-first false, '
    + 'me true, mx false, mq true, me/fake-me true, me/fake-plain false, mx/fake-x-404 false, mq/fake-mq true)',
  same(info.effortPicks, ctx.effortPicks), brief({ got: info.effortPicks, want: ctx.effortPicks }));
  const c = await openEnhanceDialog(ctx);
  const { dialog, model, effort, team, time } = c;
  const initial = { model: await model.inputValue(), effort: await effort.inputValue(), team: await team.isChecked(),
    time: await time.inputValue() };
  record('MEM-17 the settings dialog opens with the current values: Model range me, Effort high, team off, 04:00',
    same(initial, { model: 'me', effort: 'high', team: false, time: '04:00' }), brief(initial));
  await dialogEffort(c);
  await model.selectOption('me/fake-me');
  await effort.selectOption('low');
  await team.setChecked(true);
  await time.fill('');
  const raw = readFileSync(join(memProjectDir(ctx.userData, cwd), 'enhance.json'), 'utf8');
  await dialog.getByTestId('enhance-save').click();
  await sleep(800);
  const alert = await dialog.getByRole('alert').allTextContents();
  const unchanged = readFileSync(join(memProjectDir(ctx.userData, cwd), 'enhance.json'), 'utf8') === raw;
  record('MEM-17 clearing Daily time and pressing Save shows "Choose a time." and sends nothing (enhance.json is '
    + 'unchanged, the dialog stays open)', alert.includes('Choose a time.') && unchanged && await dialog.isVisible(),
  brief({ alert, unchanged }));
  await time.fill('05:30');
  await dialog.getByTestId('enhance-save').click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  const file = readEnhance(ctx.userData, cwd);
  record('MEM-17 Save writes the four settings into enhance.json (pick me/fake-me, thinking low, team true, time '
    + '05:30) and closes the dialog', file?.pick === 'me/fake-me' && file.thinking === 'low' && file.team === true
    && file.time === '05:30' && file.enabled === true, brief(file));
  const status = await waitStatus(ctx, (text) => text.includes('05:30'), 10000);
  record('MEM-17 after saving a new time the status line\'s next run is at that time',
    status === `On · Next run ${monthDayTime(nextBoundary(Date.now(), '05:30'))}`, status);
}

/** @brief 关掉再打开：设置保留，since 为再次打开那天（s1 现场关开；s2 预先写一个几天前打开过、关着的 enhance.json）。 */
async function settingsReenable(ctx) {
  const s1 = ctx.p['s1-settings'];
  await clickSwitch(ctx, false);
  const offFile = readEnhance(ctx.userData, s1);
  const offText = await waitStatus(ctx, OFF_TEXT, 10000);
  await clickSwitch(ctx, true);
  const onFile = readEnhance(ctx.userData, s1);
  record('MEM-17 turning off keeps pick/thinking/team/time (status line back to Off); turning on again keeps them',
    offFile?.enabled === false && offText === OFF_TEXT && onFile?.enabled === true && onFile.pick === 'me/fake-me'
    && onFile.thinking === 'low' && onFile.team === true && onFile.time === '05:30', brief({ offFile, onFile }));
  const s2 = ctx.p['s2-reenable'];
  const today = todayOf('06:15');
  // synthetic：五天前打开过、之后关掉的设置
  writeEnhance(ctx.userData, s2, enhanceSeed({ enabled: false, pick: 'me/fake-plain', thinking: 'minimal', team: true,
    time: '06:15', since: addDays(today, -5), doneThrough: addDays(today, -6) }));
  ctx.s2 = await openSessionIn(ctx, s2);
  await openMemoryProject(ctx, ctx.s2);
  await clickSwitch(ctx, true);
  const file = readEnhance(ctx.userData, s2);
  record('MEM-17 turning on again after days off keeps pick/thinking/team/time and sets since to the day it is '
    + 'turned on again (doneThrough moves up to the day before; the days it was off are not caught up)',
  file?.enabled === true && file.pick === 'me/fake-plain' && file.thinking === 'minimal' && file.team === true
    && file.time === '06:15' && file.since === today
    && TASKS.every((task) => file.tasks[task].doneThrough === addDays(today, -1)), brief(file));
}

/** @brief 没有默认范围：开关能打开，状态行提示选模型，Run now 不可用，enhance.run 不排。 */
async function settingsNoDefault(ctx) {
  const cwd = ctx.p['s3-nodefault'];
  const tab = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, tab);
  await bridge(ctx, { type: 'models.setDefaults', normalDefault: null });
  try {
    await clickSwitch(ctx, true);
    const status = await waitStatus(ctx, 'On · Choose a model in enhancement settings', 10000);
    const since = Date.now();
    const run = await bridge(ctx, { type: 'enhance.run', cwd });
    await sleep(1500);
    const events = await enhanceProgress(ctx, { cwd, since });
    const file = readEnhance(ctx.userData, cwd);
    record('MEM-17 with no default range the switch still turns on (pick null) and the status line reads "On · '
      + 'Choose a model in enhancement settings"; Run now is disabled and enhance.run queues nothing',
    status === 'On · Choose a model in enhancement settings' && file?.enabled === true && file.pick === null
      && !(await runEnabled(ctx)) && run.error === 'Choose a model in enhancement settings' && events.length === 0,
    brief({ status, run, events, pick: file?.pick }));
    record('MEM-25 status line, on without a model: "On · Choose a model in enhancement settings"',
      status === 'On · Choose a model in enhancement settings', status);
    await noRangeDialog(ctx);
  } finally {
    await bridge(ctx, { type: 'models.setDefaults', normalDefault: 'me' });
  }
}

/** @brief 没有范围（pick 为 null）时的对话框：Model range 没有选中项，Effort 不可用、悬停 Choose a model first.；选了范围后可用。 */
async function noRangeDialog(ctx) {
  const c = await openEnhanceDialog(ctx);
  const none = await effortWith(c);
  const chosen = await effortWith(c, 'me');
  await cancelDialog(c);
  record('MEM-17 with no range saved (pick null) the dialog\'s Model range has no selection and Effort is disabled '
    + 'with the hover "Choose a model first."; choosing a range (me, effortPicks true) makes it usable',
  none.pick === '' && none.disabled && none.title === EFFORT_NO_RANGE && chosen.pick === 'me' && !chosen.disabled
    && chosen.title === null, brief({ none, chosen }));
}

/**
 * @brief 项目的模型配置（.mori/models.json）读不出：每个范围都取不到候选，effortPicks 为空，对话框里选着范围 Effort
 *        也不可用、悬停 Choose a model first.；去掉这个文件后下一次 enhance.get 又与写好的模型设置相符。
 */
async function settingsNoEntry(ctx) {
  const cwd = ctx.p['s5-noentry'];
  writeEnhance(ctx.userData, cwd, enhanceSeed({ enabled: false, pick: 'me' })); // synthetic：关着、范围 me
  const tab = await openSessionIn(ctx, cwd);
  const broken = join(cwd, '.mori', 'models.json');
  mkdirSync(join(cwd, '.mori'), { recursive: true });
  writeFileSync(broken, '{ "groups": synthetic broken'); // synthetic：读不出来的项目模型配置
  try {
    await openMemoryProject(ctx, tab);
    const info = await enhanceGet(ctx, cwd);
    const c = await openEnhanceDialog(ctx);
    const saved = await effortWith(c);
    const other = await effortWith(c, 'me/fake-me');
    await cancelDialog(c);
    record('MEM-17 a range missing from effortPicks counts as no range: with the project\'s model settings unreadable '
      + 'no range has a candidate (effortPicks {}), and with me (then me/fake-me) selected Effort is disabled with '
      + 'the hover "Choose a model first."', same(info.effortPicks, {}) && [saved, other].every((s) => s.disabled
      && s.title === EFFORT_NO_RANGE) && saved.pick === 'me' && other.pick === 'me/fake-me',
    brief({ effortPicks: info.effortPicks, saved, other }));
  } finally {
    rmSync(broken, { force: true });
  }
  const after = await enhanceGet(ctx, cwd);
  record('MEM-17 effortPicks follows the project\'s model settings on each enhance.get: with the unreadable file '
    + 'removed it matches the seeded model settings again', same(after.effortPicks, ctx.effortPicks),
  brief(after.effortPicks));
}

/** @brief enhance.json 读不出：按关、enhance.get 带 error、状态行、开关与对话框失败的文字。 */
async function settingsBroken(ctx) {
  const cwd = ctx.p['s4-broken'];
  writeEnhance(ctx.userData, cwd, '{ "enabled": true, synthetic broken'); // synthetic：读不出来的 enhance.json
  const tab = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, tab);
  const info = await enhanceGet(ctx, cwd);
  const status = await waitStatus(ctx, /^Couldn’t read the enhancement settings: /, 10000);
  const sw = await switchState(ctx);
  record('MEM-17 an unreadable enhance.json counts as off: enhance.get carries the error, the switch shows off and '
    + 'the Memory page reads "Couldn’t read the enhancement settings: <reason>"', typeof info.error === 'string'
    && info.error.length > 0 && info.enabled === false && sw.checked === 'false'
    && status === `Couldn’t read the enhancement settings: ${info.error}`, brief({ info, status, sw }));
  record('MEM-25 status line, unreadable settings: "Couldn’t read the enhancement settings: <reason>"',
    status === expectedStatus(info), status);
  await ctx.page.getByTestId('enhance-switch').click();
  const error = await ctx.page.getByTestId('enhance-error').textContent({ timeout: 10000 }).catch(() => null);
  const after = await switchState(ctx);
  record('MEM-17 the switch failing shows "Couldn’t change enhancement: <reason>" below it and the switch goes back '
    + 'to off', error === `Couldn’t change enhancement: ${info.error}` && after.checked === 'false', brief({ error,
    after }));
  await ctx.page.getByTestId('enhance-settings').click();
  const dialog = ctx.page.getByTestId('enhance-dialog');
  await dialog.waitFor({ timeout: 10000 });
  await waitFor(() => dialog.getByTestId('enhance-save').isEnabled(), 10000, 200);
  await dialog.getByTestId('enhance-save').click();
  const failure = await poll(async () => (await dialog.getByRole('alert').allTextContents())
    .find((text) => text.startsWith('Couldn’t save the enhancement settings: ')), 10000);
  record('MEM-17 saving the dialog fails with "Couldn’t save the enhancement settings: <reason>" and the dialog stays '
    + 'open', failure === `Couldn’t save the enhancement settings: ${info.error}` && await dialog.isVisible(),
  failure ?? '');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
}

/** @brief MEM-17 步骤：开关、对话框、关掉再打开、没有默认范围、范围取不到候选、读不出设置。 */
async function settings(ctx) {
  await settingsEnable(ctx);
  await settingsDialog(ctx);
  await settingsReenable(ctx);
  await settingsNoDefault(ctx);
  await settingsNoEntry(ctx);
  await settingsBroken(ctx);
  await backToApp(ctx);
}

/** @brief MEM-17：关掉时排着的去掉、正在跑的停止并记失败（Enhancement was turned off）。 */
async function turnOff(ctx) {
  const cwd = ctx.p['t1-turnoff'];
  todaySession(ctx, cwd, 'Turn off');
  writeScript(SCRIPT, { ...quietScript('@t1-turnoff'), 'taste@t1-turnoff': [say('Holding the run.', 60000)] });
  const tab = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, tab);
  await clickSwitch(ctx, true);
  const since = Date.now();
  await ctx.page.getByTestId('enhance-run').click();
  const running = await waitStatus(ctx, 'Running TASTE enhancement… · 2 queued', 30000);
  record('MEM-25 status line, running: "Running TASTE enhancement… · 2 queued"; Run now is disabled while this '
    + 'project runs or has items queued', running === 'Running TASTE enhancement… · 2 queued'
    && !(await runEnabled(ctx)), running);
  await waitFor(async () => enhanceRequests(ctx.ep, { cwd, kind: 'taste', since }).length > 0, 20000);
  await clickSwitch(ctx, false);
  await waitFor(async () => (await enhanceProgress(ctx, { cwd, since })).some((e) => e.phase === 'failed'), 20000);
  await sleep(3000);
  const events = await enhanceProgress(ctx, { cwd, since });
  const failed = events.find((e) => e.phase === 'failed');
  const file = readEnhance(ctx.userData, cwd);
  const [revision] = await runRevisions(ctx, cwd, { task: 'taste' });
  const status = await waitStatus(ctx, OFF_TEXT, 10000);
  record('MEM-17 turning the switch off while TASTE runs stops it as failed ("Enhancement was turned off": the '
    + 'progress event, last.taste and its revision Failed) and drops the queued STRATEGY and REVIEW (they never '
    + 'run); the status line is back to Off', failed?.task === 'taste' && failed.error === 'Enhancement was turned off'
    && file?.tasks.taste.last?.status === 'failed' && file.tasks.taste.last.error === 'Enhancement was turned off'
    && file.tasks.strategy.last === null && file.tasks.review.last === null
    && !events.some((e) => e.phase === 'running' && e.task !== 'taste') && revision?.status === 'failed'
    && status === OFF_TEXT, brief({ events: phaseBrief(events), last: file?.tasks.taste.last, rev: revision?.status }));
  await backToApp(ctx);
}

// ---------- MEM-25、MEM-27、MEM-32：Run now、状态行、进度、反馈 ----------

/** @brief 等反馈表单打开（点最新一轮回复下的 Give feedback）。 */
async function openFeedback(ctx, tab) {
  await showTab(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="reply-actions"]`).last()
    .locator('button[aria-label="Give feedback"]').click();
  await ctx.page.getByTestId('feedback-form').waitFor({ timeout: 10000 });
}

/** @brief 没开增强时反馈的说明；打开增强，对话框选 me/fake-me 与 low；开着时说明一开始就是开着的那一段，保存后 Saved。 */
async function feedbackFlow(ctx, r) {
  await openFeedback(ctx, r.tab);
  const off = await poll(async () => (await ctx.page.getByTestId('feedback-note').textContent()) || null, 10000);
  record('MEM-27 the feedback note with enhancement off is the whole "not on" paragraph (both sentences)',
    off === NOTE_OFF, off ?? '');
  await ctx.page.keyboard.press('Escape');
  await ctx.page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 10000 });
  await openMemoryProject(ctx, r.tab);
  await clickSwitch(ctx, true);
  await saveDialog(ctx, { pick: 'me/fake-me', effort: 'low' });
  await backToApp(ctx);
  await watchFeedbackNote(ctx);
  await openFeedback(ctx, r.tab);
  await poll(async () => (await ctx.page.getByTestId('feedback-note').textContent()) || null, 10000);
  const notes = (await feedbackNotes(ctx)).filter((text) => text !== '');
  record('MEM-27 with enhancement on the note is the "evidence" paragraph from the start (never the "not on" one '
    + 'first)', notes.length > 0 && notes.every((text) => text === NOTE_ON), brief(notes));
  const before = feedbackNames(ctx.userData);
  await ctx.page.getByTestId('feedback-input').fill('Answer in one line');
  await ctx.page.getByTestId('feedback-form').getByRole('button', { name: 'Save', exact: true }).click();
  const saved = ctx.page.getByTestId('feedback-saved');
  await saved.waitFor({ timeout: 10000 });
  const view = await saved.evaluate((el) => ({ text: el.textContent, links: el.querySelectorAll('a, button').length }));
  record('MEM-27 after saving the form shows "Saved" with no link (no "View in Review")',
    view.text === 'Saved' && view.links === 0, brief(view));
  r.feedback = await poll(() => feedbackNames(ctx.userData).find((name) => !before.includes(name)), 5000);
  await ctx.page.getByTestId('feedback-form').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 测试准备（synthetic）：同一天的另外三种来源的反馈，加上别的项目的与前一天的（都不该列出）。 */
function seedOtherFeedback(ctx, r) {
  const now = Date.now();
  const base = { cwd: r.cwd, sessionFile: r.file, title: 'R1 session', expected: 'Shorter please', quote: 'Answer.' };
  const sha = '0'.repeat(64);
  r.extra = [
    seedFeedback(ctx.userData, { ...base, name: 'synthetic-a-null-entry.json', createdAt: now - 150000,
      source: { kind: 'message', sessionFile: r.file, entryId: null, time: null, scope: 'selection' } }),
    seedFeedback(ctx.userData, { ...base, name: 'synthetic-b-unsaved.json', createdAt: now - 140000, sessionFile: null,
      title: 'Draft chat', source: { kind: 'message', sessionFile: null, entryId: null, time: null, scope: 'reply' } }),
    seedFeedback(ctx.userData, { ...base, name: 'synthetic-c-file.json', createdAt: now - 130000,
      source: { kind: 'file', path: join(r.cwd, 'src', 'a.ts'), sha256: sha, startLine: 2, endLine: 3 } }),
  ];
  seedFeedback(ctx.userData, { ...base, name: 'synthetic-d-other-project.json', createdAt: now - 120000,
    cwd: ctx.p['t1-turnoff'],
    source: { kind: 'message', sessionFile: null, entryId: null, time: null, scope: 'reply' } });
  seedFeedback(ctx.userData, { ...base, name: 'synthetic-e-yesterday.json',
    createdAt: dayStart(todayOf(), '04:00') - 3600000,
    source: { kind: 'message', sessionFile: null, entryId: null, time: null, scope: 'reply' } });
}

/** @brief 第一条消息里反馈的四种来源的写法（附录 B），按 createdAt 排；UI 存的那条在最后。 */
function expectedFeedbackLines(ctx, r) {
  const ui = JSON.parse(readFileSync(join(ctx.userData, 'feedback', r.feedback), 'utf8'));
  const [nullEntry, unsaved, file] = r.extra;
  const line = (f, where) => `- ${f.name} · hoped for: “${f.expected}” · about: “${f.quote}” ${where}`;
  return [line(nullEntry, `in ${r.file}`), line(unsaved, 'in the unsaved session “Draft chat”'),
    line(file, `in ${join(r.cwd, 'src', 'a.ts')} lines 2–3`),
    line({ ...ui, name: r.feedback }, `in ${ui.session.file} (entry ${ui.source.entryId})`)];
}

/** @brief Run now 的进度、状态行与 Run now 不可用（运行中）。 */
async function runNowProgress(ctx, r) {
  writeScript(SCRIPT, { ...quietScript('@r1-runnow'), 'taste@r1-runnow': [
    { ...mem({ action: 'save', abstract: 'Answer in one line first', detail: 'From the feedback.',
      evidence: [{ feedback: r.feedback, quote: 'Answer in one line' }] }), wait: 3000 },
    say('Taste run finished.')] });
  await openMemoryProject(ctx, r.tab);
  const since = Date.now();
  await ctx.page.getByTestId('enhance-run').click();
  const running = await waitStatus(ctx, /^Running TASTE enhancement…/, 20000);
  const blocked = !(await runEnabled(ctx));
  const events = await waitSettled(ctx, r.cwd, since, 3);
  const today = todayOf();
  const want = ['queued taste', 'queued strategy', 'queued review', 'running taste', 'done taste', 'running strategy',
    'done strategy', 'running review', 'done review'].map((item) => `${item} ${today}`);
  record('MEM-25 Run now queues today\'s three tasks and the progress events go queued ×3, then running → done for '
    + 'TASTE, STRATEGY, REVIEW in that order (day = today); the status line shows "Running TASTE enhancement…" and Run '
    + 'now is disabled meanwhile', same(phaseBrief(events), want) && running.startsWith('Running TASTE enhancement…')
    && blocked, brief({ events: phaseBrief(events), running, blocked }));
  const info = await enhanceGet(ctx, r.cwd);
  const status = await waitStatus(ctx, (text) => text.startsWith('On · Last run'), 10000);
  record('MEM-25 status line after a successful run: "On · Last run <Mon D> <hh:mm> · TASTE: added 1 · <n> tokens · '
    + 'Next run <Mon D> <hh:mm>" (§10.4)', status === expectedStatus(info) && status.includes(' · TASTE: added 1 · ')
    && info.last.taste?.tokens > 0, brief({ status, want: expectedStatus(info) }));
  r.since = since;
}

/** @brief 第一条消息里的反馈、依据与 Evidence、模型与思考强度、token。 */
async function runNowChecks(ctx, r) {
  const first = lastFirst(ctx, r.cwd, 'taste', r.since);
  const section = first ? feedbackSection(first) : null;
  const expected = expectedFeedbackLines(ctx, r);
  record('MEM-27 that day\'s feedback appears in the first message in the four source forms (reply with entry id, '
    + 'reply without one, unsaved session, file selection), in createdAt order', same(section, expected),
  brief({ section, expected }));
  record('MEM-19 feedback is picked by cwd and createdAt: another project\'s feedback and the previous day\'s are not '
    + 'listed', section !== null && !section.some((line) => /synthetic-[de]-/.test(line)), brief(section));
  const list = await memoryList(ctx, r.cwd, 'taste');
  const row = list.entries.find((entry) => entry.abstract === 'Answer in one line first');
  const detail = row ? (await memoryGet(ctx, r.cwd, row.id)).entry : null;
  const created = JSON.parse(readFileSync(join(ctx.userData, 'feedback', r.feedback), 'utf8')).createdAt;
  const evidence = detail?.evidence?.[0];
  record('MEM-27 feedback works as evidence: the save citing it passes the check and the entry\'s evidence is that '
    + 'feedback with at = the local date of its createdAt', row?.source === 'learned'
    && evidence?.feedback === r.feedback
    && evidence.at === localDay(Date.parse(created)), brief({ row, evidence, created }));
  await ctx.page.getByTestId('memory-section-taste').click();
  await ctx.page.locator(`[data-testid="memory-row"][data-id="${row?.id}"]`).click();
  const line = await ctx.page.getByTestId('memory-evidence').textContent({ timeout: 10000 }).catch(() => '');
  record('MEM-27 the entry\'s Evidence on the Memory page reads "<Mon D> · Feedback: “Answer in one line”"',
    line.includes(`${monthDay(localDay(Date.parse(created)))} · Feedback: “Answer in one line”`), line);
  const requests = enhanceRequests(ctx.ep, { cwd: r.cwd, since: r.since });
  record('MEM-32 every enhancement request goes to the model chosen in the settings (fake-me) with the chosen effort '
    + '(reasoning_effort low)', requests.length >= 3
    && requests.every((q) => q.model === 'fake-me' && q.effort === 'low'),
  brief(requests.map((q) => [q.kind, q.model, q.effort])));
  const [revision] = await runRevisions(ctx, r.cwd, { task: 'taste' });
  const files = headlessFiles(ctx.userData, r.cwd).filter((f) => contentText(f.entries.find((e) => e.type === 'message'
    && e.message?.role === 'user')?.message?.content).startsWith("You are running Mori's daily TASTE"));
  const tokens = files.length === 1 ? fileTokens(files[0].entries) : null;
  record('MEM-23 run.tokens (and last.tokens) is the input + output summed from the enhancement session file',
    tokens !== null && tokens > 0 && revision?.run?.tokens === tokens
    && readEnhance(ctx.userData, r.cwd)?.tasks.taste.last?.tokens === tokens, brief({ tokens, run: revision?.run }));
}

/** @brief 同一条反馈不交给同一个任务两次：再聊一句、再 Run now，第一条消息的反馈为 (none)，会话从水位之后读。 */
async function runNowAgain(ctx, r) {
  const mark = readEnhance(ctx.userData, r.cwd)?.tasks.taste.watermarks[r.file];
  await backToApp(ctx);
  await chatOnce(ctx, r.tab, 'plain second message from r1');
  writeScript(SCRIPT, quietScript('@r1-runnow'));
  await openMemoryProject(ctx, r.tab);
  const since = Date.now();
  await clickRunNow(ctx, r.cwd);
  const first = lastFirst(ctx, r.cwd, 'taste', since);
  const [listed] = first ? listedSessions(first) : [];
  record('MEM-27 the same feedback is not given to the same task twice: the next TASTE run lists "(none)" under '
    + 'Feedback from this day', same(first ? feedbackSection(first) : null, ['(none)']), brief(first ? feedbackSection(
    first) : null));
  record('MEM-19 the next run of the same day reads only what was added after the watermark ("after entry <id>")',
    listed?.file === r.file && listed.start === `after entry ${mark}` && typeof mark === 'string',
    brief({ listed, mark }));
}

/** @brief MEM-25、MEM-27、MEM-32 步骤（项目 r1-runnow）。 */
async function runNow(ctx) {
  const r = { cwd: ctx.p['r1-runnow'] };
  r.tab = await openSessionIn(ctx, r.cwd);
  await chatOnce(ctx, r.tab, 'plain hello from r1');
  r.file = (await userSession(ctx, r.tab)).sessionFile;
  await feedbackFlow(ctx, r);
  seedOtherFeedback(ctx, r);
  await runNowProgress(ctx, r);
  await runNowChecks(ctx, r);
  await runNowAgain(ctx, r);
  await backToApp(ctx);
}

// ---------- MEM-26：新会话的提示 ----------

/** @brief 改了东西的运行之后第一个新会话有提示、View 打开最近那次修订；Dismiss、第二个新会话、打开已有会话都没有。 */
async function noticeFirst(ctx, n) {
  const notice = readEnhance(ctx.userData, n.cwd)?.notice;
  const rows = await runRevisions(ctx, n.cwd);
  const taste = rows.find((row) => row.run.task === 'taste');
  const strategy = rows.find((row) => row.run.task === 'strategy');
  const today = todayOf();
  record('MEM-26 after a run that changed TASTE and STRATEGY, enhance.json holds the notice (both revisions in time '
    + 'order, counts TASTE 1 and STRATEGY 1, from = to = the day)', same(notice, { revisions: [taste?.id,
    strategy?.id], counts: { taste: 1, strategy: 1, review: 0 }, from: today, to: today }), brief(notice));
  await backToApp(ctx);
  await showTab(ctx, n.tab0);
  n.tabA = await newSession(ctx);
  const banner = await noticeOf(ctx, n.tabA);
  const text = `Enhancement updated this project’s memory from the ${monthDay(today)} sessions: TASTE 1, STRATEGY 1.`;
  record('MEM-26 the first new session in the project shows the banner "Enhancement updated this project’s memory '
    + 'from the <Mon D> sessions: TASTE 1, STRATEGY 1." (only non-zero kinds) with View and Dismiss, and the notice is '
    + 'cleared from enhance.json', banner?.text === text && banner.view && banner.dismiss
    && readEnhance(ctx.userData, n.cwd)?.notice === null, brief(banner));
  await ctx.page.locator(`${paneSel(n.tabA)} [data-testid="memory-notice-view"]`).click();
  await ctx.page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  await waitFor(async () => (await revisionView(ctx)).title !== null, 10000);
  const view = await revisionView(ctx);
  record('MEM-26 View opens Memory → Project → Revisions with the latest revision of the notice selected and open',
    view.scope === 'true' && view.section === 'true' && view.selected === strategy?.id
    && view.title === `STRATEGY enhancement · ${monthDay(today)}`, brief(view));
  await backToApp(ctx);
  await showTab(ctx, n.tabA);
  await ctx.page.locator(`${paneSel(n.tabA)} [data-testid="memory-notice"] [data-action="dismiss"]`).click();
  const dismissed = await noticeOf(ctx, n.tabA);
  n.tabB = await newSession(ctx);
  const second = await noticeOf(ctx, n.tabB);
  await showTab(ctx, n.tab0);
  const existing = await noticeOf(ctx, n.tab0);
  await showTab(ctx, n.tabA);
  const back = await noticeOf(ctx, n.tabA);
  record('MEM-26 Dismiss removes the banner (also after switching away and back); the second new session and an '
    + 'existing session have no banner', dismissed === null && second === null && existing === null && back === null,
  brief({ dismissed, second, existing, back }));
}

/** @brief 没改动的运行之后新会话没有提示；有改动的运行之后的提示，切到别的会话再回来不再显示。 */
async function noticeLater(ctx, n) {
  appendSession(n.seed, chatItems(['One more question', 'One more answer.'], Date.now() - 60000, 1000));
  writeScript(SCRIPT, quietScript('@n1-notice'));
  await openMemoryProject(ctx, n.tab0);
  await clickRunNow(ctx, n.cwd);
  await backToApp(ctx);
  await showTab(ctx, n.tab0);
  const quietTab = await newSession(ctx);
  const quiet = await noticeOf(ctx, quietTab);
  record('MEM-26 a run without changes leaves no notice: the next new session has no banner',
    quiet === null && readEnhance(ctx.userData, n.cwd)?.notice === null, brief(quiet));
  const items = appendSession(n.seed, chatItems(['Another question', 'Another answer.'], Date.now() - 30000, 1000));
  writeScript(SCRIPT, { ...quietScript('@n1-notice'), 'taste@n1-notice': [mem({ action: 'save',
    abstract: 'Notice taste two', evidence: [ev(n.seed.file, items[0].id)] }), say('Saved one.')] });
  await openMemoryProject(ctx, n.tab0);
  await clickRunNow(ctx, n.cwd);
  await backToApp(ctx);
  await showTab(ctx, n.tab0);
  const fresh = await newSession(ctx);
  const shown = await noticeOf(ctx, fresh);
  await showTab(ctx, n.tab0);
  await showTab(ctx, fresh);
  const again = await noticeOf(ctx, fresh);
  record('MEM-26 a banner that was not dismissed is gone after switching to another session and back',
    shown?.text.endsWith('sessions: TASTE 1.') && again === null, brief({ shown, again }));
}

/** @brief MEM-26 步骤（项目 n1-notice）：先开好一个会话，再打开增强、Run now。 */
async function notice(ctx) {
  const n = { cwd: ctx.p['n1-notice'] };
  n.seed = todaySession(ctx, n.cwd, 'Notice');
  n.tab0 = await openSessionIn(ctx, n.cwd);
  await openMemoryProject(ctx, n.tab0);
  await clickSwitch(ctx, true);
  writeScript(SCRIPT, { ...quietScript('@n1-notice'),
    'taste@n1-notice': [mem({ action: 'save', abstract: 'Notice taste one', evidence: [ev(n.seed.file,
      n.seed.entries[0].id)] }), say('Saved TASTE.')],
    'strategy@n1-notice': [mem({ action: 'save', abstract: 'Notice strategy one', evidence: [ev(n.seed.file,
      n.seed.entries[2].id)] }), say('Saved STRATEGY.')] });
  await clickRunNow(ctx, n.cwd);
  await noticeFirst(ctx, n);
  await noticeLater(ctx, n);
}

/** @brief MEM-26、MEM-23：写入之后端点出错（fail 400）的运行同样有提示，View 打开那次失败的修订；它可以回滚。 */
async function failNotice(ctx) {
  const cwd = ctx.p['n2-failnotice'];
  const seed = todaySession(ctx, cwd, 'Fail notice');
  const tab0 = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, tab0);
  await clickSwitch(ctx, true);
  writeScript(SCRIPT, { ...quietScript('@n2-failnotice'), 'taste@n2-failnotice': [mem({ action: 'save',
    abstract: 'Failed run taste', evidence: [ev(seed.file, seed.entries[0].id)] }), { fail: 400 }] });
  const events = await clickRunNow(ctx, cwd);
  const failed = events.find((e) => e.phase === 'failed');
  const [revision] = await runRevisions(ctx, cwd, { task: 'taste' });
  const info = await enhanceGet(ctx, cwd);
  const status = await waitStatus(ctx, /^On · Last run failed \(TASTE\): /, 10000);
  record('MEM-23 an endpoint error after a write fails the run: last.taste failed with the reason, the status line '
    + 'reads "On · Last run failed (TASTE): <reason> · Next run …", the revision is Failed with the change kept',
  failed?.task === 'taste' && info.last.taste?.status === 'failed' && info.last.taste.error === failed.error
    && status === expectedStatus(info) && revision?.status === 'failed' && revision.counts.added === 1,
  brief({ failed, status, rev: revision && [revision.status, revision.counts] }));
  await backToApp(ctx);
  await showTab(ctx, tab0);
  const tab = await newSession(ctx);
  const banner = await noticeOf(ctx, tab);
  await ctx.page.locator(`${paneSel(tab)} [data-testid="memory-notice-view"]`).click();
  await ctx.page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  await waitFor(async () => (await revisionView(ctx)).title !== null, 10000);
  const view = await revisionView(ctx);
  record('MEM-26 a failed run that wrote changes still leaves a notice: the banner reads "…from the <Mon D> sessions: '
    + 'TASTE 1." and View opens that failed revision (marked Failed)', banner?.text === 'Enhancement updated this '
    + `project’s memory from the ${monthDay(todayOf())} sessions: TASTE 1.` && view.selected === revision?.id
    && view.tags.includes('Failed'), brief({ banner, view }));
  await ctx.page.getByTestId('revision-rollback').click();
  const gone = await waitFor(async () => (await memoryList(ctx, cwd, 'taste')).entries.length === 0, 15000);
  record('MEM-23 the changes a failed run wrote can be rolled back ("Roll back this revision" on the failed revision '
    + 'removes the entry)', gone, '');
  await backToApp(ctx);
}

// ---------- MEM-23：端点出错（-404）、水位不动、重跑同一天 ----------

/** @brief 设置选 mx/fake-x-404：三个任务都失败；水位、doneThrough 不动；改回模型后同一天重跑成功。 */
async function endpoint(ctx) {
  const cwd = ctx.p['f1-endpoint'];
  todaySession(ctx, cwd, 'Endpoint');
  writeScript(SCRIPT, quietScript('@f1-endpoint'));
  const tab = await openSessionIn(ctx, cwd);
  await openMemoryProject(ctx, tab);
  await clickSwitch(ctx, true);
  const before = readEnhance(ctx.userData, cwd);
  await saveDialog(ctx, { pick: 'mx/fake-x-404' });
  const events = await clickRunNow(ctx, cwd);
  const file = readEnhance(ctx.userData, cwd);
  const info = await enhanceGet(ctx, cwd);
  const status = await waitStatus(ctx, /^On · Last run failed \(TASTE, STRATEGY, REVIEW\): /, 10000);
  const revisions = await runRevisions(ctx, cwd);
  const unmoved = TASKS.every((task) => same(file?.tasks[task].watermarks, {})
    && file.tasks[task].doneThrough === before.tasks[task].doneThrough && file.tasks[task].last?.status === 'failed'
    && file.tasks[task].last.error);
  record('MEM-23 an endpoint error (the model answers 404) fails each task: last records failed with the reason, '
    + 'watermarks and doneThrough stay, and the status line reads "On · Last run failed (TASTE, STRATEGY, REVIEW): '
    + '<reason> · Next run …"', unmoved && events.filter((e) => e.phase === 'failed').length === 3
    && status === expectedStatus(info), brief({ status, events: phaseBrief(events), last: file?.tasks.taste.last }));
  record('MEM-20 a run fails when the endpoint errors (each revision Failed with No changes) and the watermarks do '
    + 'not move', unmoved && revisions.length === 3 && revisions.every((r) => r.status === 'failed'
    && r.counts.added + r.counts.changed + r.counts.deleted === 0),
  brief(revisions.map((r) => [r.run.task, r.status])));
  await saveDialog(ctx, { pick: 'me' });
  const again = await clickRunNow(ctx, cwd);
  const day = todayOf();
  record('MEM-23 the next run retries the same day: after choosing a working model, Run now runs day <today> again '
    + 'and all three tasks finish', again.filter((e) => e.phase === 'done' && e.day === day).length === 3,
  brief(phaseBrief(again)));
  await backToApp(ctx);
}

// ---------- MEM-20：看不见的会话 ----------

/** @brief 信任的项目：命令不出批准卡就执行、write/edit 被拒绝、扩展的询问不出卡、会话在 memory 目录、跑完关闭。 */
async function headlessTrusted(ctx) {
  const cwd = ctx.p['hx-trusted'];
  todaySession(ctx, cwd, 'Headless');
  writeScript(SCRIPT, { ...quietScript('@hx-trusted'), 'taste@hx-trusted': [
    { call: 'bash', args: { command: 'echo enhance-bash-ok' } },
    { call: 'write', args: { path: 'notes.txt', content: 'written by an enhancement run\n' } },
    { call: 'edit', args: { path: 'README.md', edits: [{ oldText: '# hx-trusted', newText: '# edited' }] } },
    { call: 'ext_ask', args: {} }, say('Headless done.')] });
  await bridgeEnable(ctx, cwd);
  const since = Date.now();
  await bridgeRun(ctx, cwd);
  const files = headlessFiles(ctx.userData, cwd);
  const taste = files.find((f) => toolResultsOf(f.entries).length > 0);
  const results = toolResultsOf(taste?.entries ?? []);
  const byTool = Object.fromEntries(results.map((r) => [r.tool, r]));
  record('MEM-20 the enhancement session file is in memory/projects/<key>/sessions (one per run, three runs)',
    files.length === 3 && files.every((f) => f.file.startsWith(join(memProjectDir(ctx.userData, cwd), 'sessions'))),
    brief(files.map((f) => f.file)));
  record('MEM-20 commands run without an approval card (bash returns its output; no approval card in the window)',
    byTool.bash && !byTool.bash.isError && byTool.bash.text.includes('enhance-bash-ok')
    && (await ctx.page.locator('[data-testid="approval-card"]').count()) === 0, brief(byTool.bash));
  record('MEM-20 write and edit are refused with "Enhancement runs can only change memory, with the memory tool." and '
    + 'the files stay as they were', byTool.write?.isError && byTool.write.text === WRITE_REFUSED
    && byTool.edit?.isError
    && byTool.edit.text === WRITE_REFUSED && !existsSync(join(cwd, 'notes.txt'))
    && readFileSync(join(cwd, 'README.md'), 'utf8').startsWith('# hx-trusted'), brief([byTool.write, byTool.edit]));
  record('MEM-20 an extension asking through ctx.ui gets the default answer without a card (confirm=false, no '
    + 'extension question card in the window)', byTool.ext_ask?.text === 'confirm=false'
    && (await ctx.page.locator('[data-testid="ext-ui-card"]').count()) === 0, brief(byTool.ext_ask));
  const ids = files.map((f) => f.id);
  const events = (await kernelEvents(ctx, null, null, since)).filter((e) => ids.includes(e.sid));
  const list = await bridge(ctx, { type: 'session.list' });
  const listText = JSON.stringify(list);
  const listed = listText.includes('memory\\\\projects') || listText.includes('memory/projects');
  const rows = await ctx.page.locator('.session-item[data-file*="\\\\memory\\\\projects\\\\"]').count();
  record('MEM-20 the window gets none of its events, and neither the sidebar nor session.list has it',
    events.length === 0 && !listed && rows === 0, brief({ events: events.length, listed, rows }));
  const log = existsSync(join(cwd, 'ext-log.txt')) ? readFileSync(join(cwd, 'ext-log.txt'), 'utf8') : '';
  const dir = join(memProjectDir(ctx.userData, cwd), 'sessions');
  record('MEM-20 each run\'s session is closed when the run ends (the trusted project\'s extension logs start and '
    + 'shutdown for all three enhancement sessions)', ids.every((id) => log.includes(`start ${dir} ${id}`)
    && log.includes(`shutdown ${dir} ${id}`)), brief(log));
}

/** @brief 没有信任决定的项目：不出信任框、项目扩展不加载（请求里没有 ext_ask，扩展没有记日志）。 */
async function headlessUntrusted(ctx) {
  const cwd = ctx.p['hx-untrusted'];
  todaySession(ctx, cwd, 'Untrusted');
  writeScript(SCRIPT, quietScript('@hx-untrusted'));
  await bridgeEnable(ctx, cwd);
  const since = Date.now();
  let dialogSeen = false;
  const watch = setInterval(() => {
    ctx.page.getByTestId('trust-dialog').count().then((n) => { dialogSeen ||= n > 0; }, () => {});
  }, 200);
  const events = await bridgeRun(ctx, cwd).finally(() => clearInterval(watch));
  const requests = enhanceRequests(ctx.ep, { cwd, since });
  record('MEM-20 a project with no trust decision asks nothing (no trust dialog) and its project extension is not '
    + 'loaded (no ext_ask tool in the requests, no extension log), and the run still finishes',
  !dialogSeen && requests.length >= 3 && requests.every((q) => !q.tools.includes('ext_ask'))
    && !existsSync(join(cwd, 'ext-log.txt')) && events.filter((e) => e.phase === 'done').length === 3,
  brief({ dialogSeen, tools: requests[0]?.tools, events: phaseBrief(events) }));
}

/** @brief 选择范围不存在、角色文件有问题（team 关着）时这次运行失败、水位不动。 */
async function headlessFailures(ctx) {
  const bad = ctx.p['h3-badpick'];
  todaySession(ctx, bad, 'Bad pick');
  // synthetic：pick 指向不存在的范围
  writeEnhance(ctx.userData, bad, enhanceSeed({ pick: 'nope/none', since: todayOf(),
    doneThrough: addDays(todayOf(), -1) }));
  const pick = await bridgeRun(ctx, bad);
  const pickFile = readEnhance(ctx.userData, bad);
  record('MEM-20 a pick that names no model range fails the run (each task failed with a reason) and the '
    + 'watermarks do not move', pick.filter((e) => e.phase === 'failed' && e.error).length === 3
    && TASKS.every((task) => same(pickFile?.tasks[task].watermarks, {})), brief(phaseBrief(pick)));
  const refused = await runRevisions(ctx, bad);
  const reason = pick.find((e) => e.phase === 'failed')?.error;
  record('MEM-20 a run refused before it starts still leaves its revision (§9.8): Failed, No changes, Notes = the '
    + 'reason', refused.length === 3 && refused.every((r) => r.status === 'failed' && r.changes.length === 0
    && r.notes === reason), brief(refused.map((r) => [r.run.task, r.status, r.notes])));
  const roles = ctx.p['h4-badroles'];
  todaySession(ctx, roles, 'Bad roles');
  writeScript(SCRIPT, quietScript('@h4-badroles'));
  await bridgeEnable(ctx, roles);
  const invalid = await bridgeRun(ctx, roles);
  const rolesFile = readEnhance(ctx.userData, roles);
  record('MEM-20 with team off, invalid role files still fail the run (reason starts with agents_invalid) and the '
    + 'watermarks do not move', invalid.filter((e) => e.phase === 'failed' && e.error?.startsWith('agents_invalid'))
    .length === 3 && TASKS.every((task) => same(rolesFile?.tasks[task].watermarks, {})), brief(phaseBrief(invalid)));
}

/** @brief MEM-20 步骤。 */
async function headless(ctx) {
  await headlessTrusted(ctx);
  await headlessUntrusted(ctx);
  await headlessFailures(ctx);
}

// ---------- MEM-21：增强写入的限制与依据 ----------

/** @brief 第一次运行：模型给的路径大小写与斜杠不同、实例会话的条目作依据。 */
async function evidenceFirstRun(ctx, w) {
  const odd = w.seed.file.replaceAll('\\', '/').toUpperCase();
  writeScript(SCRIPT, { ...quietScript('@w1-evidence'), 'taste@w1-evidence': [
    mem({ action: 'save', abstract: 'Learned taste one', detail: 'First version.', evidence: [ev(odd,
      w.seed.entries[0].id, 'Please keep answers short')] }),
    mem({ action: 'save', abstract: 'Learned taste from a task', evidence: [ev(w.team.file, w.team.entry)] }),
    say('Run one done.')] });
  await openMemoryProject(ctx, w.tab);
  await clickRunNow(ctx, w.cwd);
  const list = await memoryList(ctx, w.cwd, 'taste');
  const one = list.entries.find((e) => e.abstract === 'Learned taste one');
  const task = list.entries.find((e) => e.abstract === 'Learned taste from a task');
  const oneDetail = one ? (await memoryGet(ctx, w.cwd, one.id)).entry : null;
  const taskDetail = task ? (await memoryGet(ctx, w.cwd, task.id)).entry : null;
  record('MEM-21 a session path given with other case and slashes is accepted and the listed path is stored',
    one?.source === 'learned' && oneDetail?.evidence?.[0]?.session === w.seed.file
    && oneDetail.evidence[0].entry === w.seed.entries[0].id, brief(oneDetail?.evidence));
  record('MEM-21 an entry of a TaskBoard instance session file (in the listed team folder) is accepted as evidence',
    task?.source === 'learned' && taskDetail?.evidence?.[0]?.session === w.team.file, brief(taskDetail?.evidence));
  w.one = one;
}

/** @brief 第二次运行：update 后仍为 learned；改 user 条目、别的种类、缺依据、依据不在范围都被拒绝且什么都没写。 */
async function evidenceSecondRun(ctx, w) {
  const items = appendSession(w.seed, chatItems(['Shorter still, please', 'Sure.'], Date.now() - 30000, 1000));
  const good = [ev(w.seed.file, items[0].id)];
  writeScript(SCRIPT, { ...quietScript('@w1-evidence'), 'taste@w1-evidence': [
    mem({ action: 'update', entry: 'Learned taste one', abstract: 'Learned taste one, refined', note: 'Refined',
      evidence: good }),
    mem({ action: 'update', entry: 'User taste rule', note: 'Try', evidence: good }),
    mem({ action: 'update', entry: 'User strategy rule', note: 'Try', evidence: good }),
    mem({ action: 'save', abstract: 'No evidence at all' }),
    mem({ action: 'save', abstract: 'Bad session', evidence: [ev('C:\\nowhere\\x.jsonl', items[0].id)] }),
    mem({ action: 'save', abstract: 'Bad entry', evidence: [ev(w.seed.file, 'zzzz0000')] }),
    mem({ action: 'save', abstract: 'Bad feedback', evidence: [{ feedback: 'nope.json' }] }),
    say('Run two done.')] });
  await clickRunNow(ctx, w.cwd);
  const file = headlessFiles(ctx.userData, w.cwd).find((f) => toolResultsOf(f.entries).length >= 7);
  const results = toolResultsOf(file?.entries ?? []).map((r) => r.text.split('\n')[0]);
  const want = ['Updated TASTE (this project): Learned taste one, refined',
    '“User taste rule” is an entry the user wrote; it’s read-only for enhancement. Mention the conflict in your final '
    + 'reply.', 'This run maintains this project’s TASTE entries only.', 'evidence is required for save.',
    'Evidence 1 isn’t from this run’s material: session not listed.',
    `Evidence 1 isn’t from this run’s material: entry zzzz0000 not in ${w.seed.file}.`,
    'Evidence 1 isn’t from this run’s material: feedback not listed.'];
  const list = await memoryList(ctx, w.cwd, 'taste');
  const one = list.entries.find((e) => e.id === w.one?.id);
  record('MEM-21 update of this project\'s learned TASTE entry works and it stays learned',
    results[0] === want[0] && one?.abstract === 'Learned taste one, refined' && one.source === 'learned', brief(one));
  record('MEM-21 changing an entry the user wrote and an entry of another kind is refused with the §7.4 texts',
    same(results.slice(1, 3), want.slice(1, 3)), brief(results.slice(1, 3)));
  record('MEM-21 missing evidence (“evidence is required for save.”, 2026-10-26), a session not listed, an entry id '
    + 'not in the file and feedback not listed are all refused, and nothing was written',
  same(results.slice(3, 7), want.slice(3, 7))
    && !list.entries.some((e) => /^(No evidence|Bad )/.test(e.abstract)) && list.entries.length === 3,
  brief({ results: results.slice(3, 7), entries: list.entries.map((e) => e.abstract) }));
}

/** @brief Jump to source 打开依据里存下的（列出的）那个会话。 */
async function evidenceJump(ctx, w) {
  await ctx.page.getByTestId('memory-section-taste').click();
  await ctx.page.locator(`[data-testid="memory-row"][data-id="${w.one?.id}"]`).click();
  await ctx.page.getByTestId('memory-jump').first().click();
  const opened = await waitFor(() => ctx.page.evaluate((file) => document.querySelector('.session-item.active')
    ?.getAttribute('data-file') === file, w.seed.file), 20000);
  record('MEM-21 Jump to source on that evidence opens the listed session (the stored path)', opened,
    await ctx.page.evaluate(() => document.querySelector('.session-item.active')?.getAttribute('data-file')));
}

/**
 * @brief MEM-21 步骤（项目 w1-evidence：启动前写好的合成会话，这里给它加上 TaskBoard 目录；你写的 TASTE 与 STRATEGY 各一条）。
 */
async function evidence(ctx) {
  const w = { cwd: ctx.p['w1-evidence'] };
  w.seed = ctx.w1seed;
  w.team = seedTeamDir(ctx.userData, w.seed, Date.now() - 20 * 60000);
  w.tab = await openSessionIn(ctx, w.cwd);
  for (const [kind, abstract] of [['taste', 'User taste rule'], ['strategy', 'User strategy rule']]) {
    const saved = await bridge(ctx, { type: 'memory.save', cwd: w.cwd, layer: 'project', kind, abstract, detail: '' });
    if (saved.error) throw new Error(`memory.save: ${saved.error}`);
  }
  await openMemoryProject(ctx, w.tab);
  await clickSwitch(ctx, true);
  await evidenceFirstRun(ctx, w);
  await evidenceSecondRun(ctx, w);
  await evidenceJump(ctx, w);
  await backToApp(ctx);
}

// ---------- MEM-22：一次运行一条修订 ----------

/** @brief 一次运行里多次写入：一条修订、同一条目一节、先加后删的不出现、Notes、没改动也有修订。 */
async function oneRevisionRun(ctx, v) {
  const e = [ev(v.seed.file, v.seed.entries[0].id)];
  writeScript(SCRIPT, { ...quietScript('@v1-onerun'), 'taste@v1-onerun': [
    mem({ action: 'save', abstract: 'Taste A: answer first', evidence: e }),
    mem({ action: 'save', abstract: 'Taste B: short lists', evidence: e }),
    mem({ action: 'update', entry: 'Taste A: answer first', abstract: 'Taste A: answer first, then details',
      note: 'n1', evidence: e }),
    mem({ action: 'update', entry: 'Taste A: answer first, then details', detail: 'More detail.', note: 'n2',
      evidence: e }),
    mem({ action: 'save', abstract: 'Taste C: temporary', evidence: e }),
    mem({ action: 'forget', entry: 'Taste C: temporary', note: 'Not needed', evidence: e }),
    say('Summary for MEM-22: two entries.')] });
  await openMemoryProject(ctx, v.tab);
  await clickSwitch(ctx, true);
  await clickRunNow(ctx, v.cwd);
  const taste = await runRevisions(ctx, v.cwd, { task: 'taste' });
  const strategy = await runRevisions(ctx, v.cwd, { task: 'strategy' });
  const rev = taste[0];
  const actions = rev?.changes.map((c) => `${c.action} ${c.to?.slug ?? c.from?.slug}`) ?? [];
  const a = rev?.changes.find((c) => c.after.includes('Taste A: answer first, then details'));
  record('MEM-22 all writes of one run are in one revision; an entry changed twice in the run has one section '
    + '(before = empty, after = the final file) and counts it once; an entry added then deleted does not appear',
  taste.length === 1 && rev.changes.length === 2 && same(rev.counts, { added: 2, changed: 0, deleted: 0, moved: 0 })
    && a?.before === '' && a.after.includes('More detail.') && !actions.some((x) => x.includes('temporary')),
  brief({ actions, counts: rev?.counts }));
  record('MEM-22 Notes is the run\'s last reply', rev?.notes === 'Summary for MEM-22: two entries.', rev?.notes ?? '');
  record('MEM-22 a run without changes still has its revision (STRATEGY, done, No changes)', strategy.length === 1
    && strategy[0].status === 'done' && strategy[0].changes.length === 0, brief(strategy.map((r) => r.counts)));
  v.revision = rev;
}

/** @brief 之后的新会话用新版；Roll back this revision 恢复整次。 */
async function oneRevisionAfter(ctx, v) {
  await backToApp(ctx);
  await showTab(ctx, v.tab);
  const tab = await newSession(ctx);
  const since = Date.now();
  await chatOnce(ctx, tab, 'plain check the taste section');
  const [request] = requestsWith(ctx, 'plain check the taste section', since);
  const system = request ? systemOf(request.body) : '';
  record('MEM-22 a new session after the run uses the new entries (its first request\'s system has both TASTE lines)',
    system.includes('- Taste A: answer first, then details') && system.includes('- Taste B: short lists'),
    brief(system.slice(system.indexOf('<taste>'), system.indexOf('<taste>') + 200)));
  await openMemoryProject(ctx, v.tab);
  await ctx.page.getByTestId('memory-section-revisions').click();
  await ctx.page.locator(`[data-testid="revision-row"][data-id="${v.revision?.id}"]`).click();
  await ctx.page.getByTestId('revision-rollback').click();
  const empty = await waitFor(async () => (await memoryList(ctx, v.cwd, 'taste')).entries.length === 0, 15000);
  record('MEM-22 Roll back this revision undoes the whole run (both entries are gone)', empty, '');
  await backToApp(ctx);
}

/** @brief MEM-22 步骤（项目 v1-onerun）。 */
async function oneRevision(ctx) {
  const v = { cwd: ctx.p['v1-onerun'] };
  v.seed = todaySession(ctx, v.cwd, 'One run');
  v.tab = await openSessionIn(ctx, v.cwd);
  await oneRevisionRun(ctx, v);
  await oneRevisionAfter(ctx, v);
}

// ---------- MEM-19：关掉几天再打开、只列同一工作目录且有对话的会话 ----------

/** @brief 测试准备（synthetic）：同一个会话里三天前与今天的对话；没有对话的会话；子文件夹与大小写不同的工作目录。 */
function offDaysSeeds(ctx, cwd) {
  const today = todayOf();
  const old = addDays(today, -3);
  const oldAt = Date.parse(`${old}T12:00:00`);
  const seed = seedSession(ctx.userData, cwd, { name: 'Off days', items: chatItems(['Old question', 'Old answer.'],
    oldAt, 60000) });
  const fresh = appendSession(seed, chatItems(['New question', 'New answer.'], Date.now() - 10 * 60000, 60000));
  seedSession(ctx.userData, cwd, { name: 'Only notes',
    items: [{ kind: 'custom', text: 'note', at: Date.now() - 600000 }] });
  seedSession(ctx.userData, cwd, { name: 'Subfolder', headerCwd: join(cwd, 'src'),
    items: chatItems(['Sub question', 'Sub answer.'], Date.now() - 600000) });
  const upper = join(cwd, '..', ctx.p['o1-offdays'].split(/[\\/]/).pop().toUpperCase());
  seedSession(ctx.userData, cwd, { name: 'Other case', headerCwd: upper,
    items: chatItems(['Case question', 'Case answer.'], Date.now() - 600000) });
  seedSession(ctx.userData, ctx.p['o1-offdays-other'], { name: 'Other project',
    items: chatItems(['Other question', 'Other answer.'], Date.now() - 600000) });
  writeEnhance(ctx.userData, cwd, enhanceSeed({ enabled: false, since: addDays(today, -5),
    doneThrough: addDays(today, -6) }));
  return { seed, fresh };
}

/** @brief MEM-19 步骤（项目 o1-offdays）：关了五天再打开，片段从打开那天开始；只列这一个会话。 */
async function offDays(ctx) {
  const cwd = ctx.p['o1-offdays'];
  const { seed, fresh } = offDaysSeeds(ctx, cwd);
  writeScript(SCRIPT, quietScript('@o1-offdays'));
  await bridgeEnable(ctx, cwd);
  const since = Date.now();
  await bridgeRun(ctx, cwd);
  const first = lastFirst(ctx, cwd, 'taste', since);
  const listed = first ? listedSessions(first) : [];
  const want = { file: seed.file, from: fresh[0].line, to: fresh.at(-1).line,
    start: `from ${monthDayTime(fresh[0].at)}` };
  record('MEM-19 after being off for days and turned on again, the slice starts at the day it was turned on (the '
    + 'entries from three days ago are not in it: "lines <a>–<b> (from <time of the first new entry>)")',
  listed.length === 1 && same({ file: listed[0].file, from: listed[0].from, to: listed[0].to, start: listed[0].start },
    want) && readEnhance(ctx.userData, cwd)?.since === todayOf(), brief({ listed, want }));
  record('MEM-19 only sessions with exactly the same cwd and user or assistant messages in the slice are listed (not '
    + 'a session with only custom entries, a subfolder, a different letter case, or another project)',
  listed.length === 1, brief(listed.map((s) => s.title)));
}

// ---------- MEM-32：调度类别 background ----------

/** @brief 端点日志行属于哪一种请求（占住槽位的、对话、task、增强）。 */
function classOf(line) {
  if (line.scenario === 'tb-models-hold-order') return 'hold';
  if (line.scenario === 'tb-models-order-conv') return 'conversation';
  if (line.scenario === 'tb-models-order-task' && line.kind === 'task') return 'task';
  if (line.enhance) return 'enhancement';
  return `other:${line.scenario}/${line.kind}`;
}

/** @brief 开好会话：占住 mq 槽位的一个、之后对话的一个（都选 mq/fake-mq）、协作项目一个；增强项目打开增强、选 mq。 */
async function schedOpen(ctx) {
  const tabs = {};
  for (const key of ['hold', 'conv']) {
    tabs[key] = await openSessionIn(ctx, ctx.p['mh-hold']);
    const who = await userSession(ctx, tabs[key]);
    const result = await bridge(ctx, { type: 'session.setPick', sessionId: who.sessionId, pick: 'mq/fake-mq' });
    if (result.error) throw new Error(`session.setPick: ${result.error}`);
  }
  tabs.team = await openSessionIn(ctx, ctx.p['mq-team']);
  const cwd = ctx.p['m1-sched'];
  todaySession(ctx, cwd, 'Sched');
  writeScript(SCRIPT, quietScript('@m1-sched'));
  await bridgeEnable(ctx, cwd, { pick: 'mq/fake-mq', thinking: 'high' });
  return tabs;
}

/** @brief MEM-32 步骤：mq（并发 1）被占住 20 秒时依次排进增强、task、对话；放开后按 对话、task、增强 发出。 */
async function sched(ctx) {
  const tabs = await schedOpen(ctx);
  const cwd = ctx.p['m1-sched'];
  await sendMessage(ctx, tabs.hold, 'Hold the slot tb-scenario:tb-models-hold-order');
  const hold = await poll(() => ctx.ep.logs.find((l) => l.scenario === 'tb-models-hold-order'), 15000, 100);
  if (!hold) throw new Error('the hold request never reached the fake endpoint');
  const since = Date.now();
  const run = await bridge(ctx, { type: 'enhance.run', cwd });
  await waitFor(async () => (await enhanceProgress(ctx, { cwd, since })).some((e) => e.phase === 'running'),
    10000, 100);
  await sleep(2000);
  await sendMessage(ctx, tabs.team, 'Queue a task tb-scenario:tb-models-order-task', { team: true });
  const started = await waitTaskPhase(ctx, tabs.team, { task: 'T1', phase: 'starting' }, 15000);
  await sleep(700);
  await sendMessage(ctx, tabs.conv, 'Quick question tb-scenario:tb-models-order-conv');
  const queuedBy = Date.now();
  await waitSettled(ctx, cwd, since, 3, 150000);
  const after = ctx.ep.logs.filter((l) => l.model === 'fake-mq' && l.t > hold.t && !l.probe).map(classOf);
  const released = hold.t + MODELS_TEXT.holdOrderMs;
  const requests = enhanceRequests(ctx.ep, { cwd, since });
  record('MEM-32 the enhancement session runs in the scheduling class background: while a conversation holds mq '
    + '(concurrency 1), an enhancement request, then a task instance, then a conversation queue; when the slot frees '
    + 'the endpoint gets the conversation, then the task, then the enhancement (background ranks last, §8.2)',
  run.error === null && started !== null && queuedBy < released - 1000 && same(after.slice(0, 3),
    ['conversation', 'task', 'enhancement']), brief({ after: after.slice(0, 6), queuedBy: queuedBy - hold.t }));
  record('MEM-32 the enhancement requests go to the chosen model (fake-mq) with the chosen effort (high)',
    requests.length >= 3 && requests.every((q) => q.model === 'fake-mq' && q.effort === 'high'),
    brief(requests.map((q) => [q.kind, q.model, q.effort])));
}

// ---------- MEM-38：增强把 Mori 记的条目移到该在的种类（2026-10-26，§6.9） ----------

/** 主 Agent 主动记下的两条（不给 asked，合成端点按 call tool: memory 调用，synthetic）：放错了种类 */
const REFILE = {
  rule: { action: 'save', kind: 'fact', abstract: 'Answer with the conclusion first',
    quote: 'just give me the conclusion first' },
  fact: { action: 'save', kind: 'taste', abstract: 'The staging database is PostgreSQL 15',
    quote: 'staging runs PostgreSQL 15' },
};
/** 两条的 slug（§6.2） */
const REFILE_SLUG = { rule: 'answer-with-the-conclusion-first', fact: 'the-staging-database-is-postgresql-15' };
/**
 * TASTE 任务最后的回复，即这次修订的 Notes：一句话加一张 mermaid 图（synthetic，2026-10-26 补测：Notes 与对话流是同一个
 * Markdown 组件，mermaid 画成图，docs/v1/screens/memory-page.md"Revisions"的 Notes 一行）
 */
const REFILE_NOTES = ['Refiled two entries added by Mori.', '', '```mermaid', 'flowchart LR', '  Facts --> TASTE',
  '  TASTE --> Facts', '```'].join('\n');

/** @brief 对话里让主 Agent 主动记两条（放错了种类），打开增强，TASTE 任务把两条各自移走（一进一出），Run now。 */
async function refileRun(ctx, x) {
  x.tab = await openSessionIn(ctx, x.cwd);
  for (const args of [REFILE.rule, REFILE.fact]) await chatOnce(ctx, x.tab, `call tool: memory ${JSON.stringify(args)}`);
  writeScript(SCRIPT, { ...quietScript('@x1-refile'), 'taste@x1-refile': [
    mem({ action: 'move', entry: REFILE_SLUG.rule, kind: 'taste', note: 'How to talk, not a fact' }),
    mem({ action: 'move', entry: REFILE.fact.abstract, kind: 'fact', note: 'A fact, not a taste' }),
    say(REFILE_NOTES)] });
  await openMemoryProject(ctx, x.tab);
  await clickSwitch(ctx, true);
  await clickRunNow(ctx, x.cwd);
  x.revision = (await runRevisions(ctx, x.cwd, { task: 'taste' }))[0] ?? null;
}

/** @brief 盘上与修订：两条都换了种类、仍是 Mori 记的；Revisions 行；修订一节 Changed、种类两端、kinds 含两种。 */
async function refileFiles(ctx, x) {
  const [facts, tastes] = [await memoryList(ctx, x.cwd, 'fact'), await memoryList(ctx, x.cwd, 'taste')];
  const rule = (await memoryGet(ctx, x.cwd, REFILE_SLUG.rule)).entry;
  const fact = (await memoryGet(ctx, x.cwd, REFILE_SLUG.fact)).entry;
  const day = monthDay(todayOf());
  record('MEM-38 the TASTE run moved the rule added by Mori from Facts into TASTE and the fact added by Mori from '
    + 'TASTE to Facts: same ids, still added by Mori, each one out of its old index and in the new one, with a '
    + '“Moved from <KIND> to <KIND>: <note>” Revisions line', rule?.kind === 'taste' && fact?.kind === 'fact'
    && rule.source === 'agent' && fact.source === 'agent'
    && same(tastes.entries.map((e) => e.id), [REFILE_SLUG.rule]) && same(facts.entries.map((e) => e.id),
      [REFILE_SLUG.fact])
    && rule.history.at(-1) === `${day} · Enhancement: Moved from Facts to TASTE: How to talk, not a fact`
    && fact.history.at(-1) === `${day} · Enhancement: Moved from TASTE to Facts: A fact, not a taste`,
  brief({ rule: rule && [rule.kind, rule.source, rule.history], fact: fact && [fact.kind, fact.source] }));
  const changes = x.revision?.changes.map((c) => [c.action, c.fromKind, c.kind, c.to?.slug]) ?? [];
  record('MEM-38 the run has one revision with two Changed sections from one kind to the other, kinds fact and '
    + 'taste, counts changed 2', same(changes, [['changed', 'fact', 'taste', REFILE_SLUG.rule],
    ['changed', 'taste', 'fact', REFILE_SLUG.fact]]) && same(x.revision.kinds, ['fact', 'taste'])
    && same(x.revision.counts, { added: 0, changed: 2, deleted: 0, moved: 0 }), brief({ changes, rev: x.revision
    && { kinds: x.revision.kinds, counts: x.revision.counts } }));
}

/** @brief 记忆页：TASTE 里那一行标 Added by Mori；Revisions 里这次运行的两块写 Changed · <原> → <目标> · <abstract>。 */
async function refilePage(ctx, x) {
  await ctx.page.getByTestId('memory-section-taste').click();
  const row = ctx.page.locator(`[data-testid="memory-row"][data-id="${REFILE_SLUG.rule}"]`);
  await row.waitFor({ timeout: 10000 });
  const tag = await row.locator('.memory-tag').textContent();
  // 换到 Revisions 之后这一行就不在页面上了，先读它的 data-source
  const source = await row.getAttribute('data-source');
  await ctx.page.getByTestId('memory-section-revisions').click();
  await ctx.page.locator(`[data-testid="revision-row"][data-id="${x.revision?.id}"]`).click();
  await ctx.page.getByTestId('revision-detail').locator('.memory-change-title').first().waitFor({ timeout: 10000 });
  const titles = await ctx.page.getByTestId('revision-detail').locator('.memory-change-title').allTextContents();
  record('MEM-38 on the Memory page the moved rule is in TASTE marked “Added by Mori”, and the run’s revision shows '
    + '“Changed · Facts → TASTE · <abstract>” and “Changed · TASTE → Facts · <abstract>”',
  tag === 'Added by Mori' && source === 'agent'
    && same(titles.map((text) => text.trim()), [`Changed · Facts → TASTE · ${REFILE.rule.abstract}`,
      `Changed · TASTE → Facts · ${REFILE.fact.abstract}`]), brief({ tag, source, titles }));
  await refileDiffs(ctx);
  const notes = await notesDiagram(ctx);
  record('MEM-14 the revision’s Notes (the run’s last reply) is rendered by the same Markdown component as the chat: '
    + 'its ```mermaid block is drawn as a diagram (shadow DOM SVG, “Mermaid diagram”), not shown as code',
  notes?.svg && notes.label === 'Mermaid diagram' && notes.code === 0 && notes.text.includes('TASTE')
    && notes.prose.startsWith('Refiled two entries added by Mori.'), brief(notes));
}

/**
 * @brief 页面里：修订详情里 Notes 一块的第一张 mermaid 图：读屏名、shadow DOM 里有没有 SVG、图里的字，Notes 里还剩几个
 *        mermaid 代码块和 Notes 的文字；没有图时为 null。
 */
function notesDiagramState() {
  const block = [...document.querySelectorAll('[data-testid="revision-detail"] .memory-block')]
    .find((item) => item.querySelector('.memory-label')?.textContent.trim() === 'Notes');
  const host = block?.querySelector('[data-testid="mermaid-diagram"]');
  return host ? { label: host.getAttribute('aria-label'), svg: Boolean(host.shadowRoot?.querySelector('svg')),
    text: host.shadowRoot?.textContent ?? '', prose: block.querySelector('.memory-details')?.textContent ?? '',
    code: block.querySelectorAll('[data-streamdown="code-block"][data-language="mermaid"]').length } : null;
}

/** @brief 等修订详情 Notes 里的 mermaid 图画好（最多 20 秒），返回 notesDiagramState 的结果。 */
async function notesDiagram(ctx) {
  return await poll(async () => {
    const state = await ctx.page.evaluate(notesDiagramState);
    return state?.svg ? state : null;
  }, 20000, 200) ?? ctx.page.evaluate(notesDiagramState);
}

/**
 * @brief memory-page.md“每处改动”（2026-10-26 补，WP-11 的状态表各行的用例）：移动的两块对照里 `kind:` 一行不同（前后两份
 *        detail 文件），`## Revisions` 多一行 `Moved from <KIND> to <KIND>: <note>`。对照画在 shadow DOM 里、异步渲染，
 *        读法同 mem-page-helpers revisionPanel（detailState 的 revision）。
 */
async function refileDiffs(ctx) {
  const moved = (change) => change.diff.includes('Moved from ');
  const rev = await poll(async () => {
    const value = (await detailState(ctx.page))?.revision;
    return value?.changes.length === 2 && value.changes.every(moved) ? value : null;
  }, 10000, 200) ?? (await detailState(ctx.page))?.revision;
  const [first, second] = rev?.changes ?? [];
  const has = (change, texts) => texts.every((text) => change?.diff.includes(text));
  record('MEM-38 the run’s revision on the Memory page compares the two files of each move: the kind: line differs '
    + '(kind: fact and kind: taste) and the entry’s Revisions gains “Moved from Facts to TASTE: How to talk, not a '
    + 'fact” / “Moved from TASTE to Facts: A fact, not a taste”',
  has(first, ['kind: fact', 'kind: taste', 'Moved from Facts to TASTE: How to talk, not a fact'])
    && has(second, ['kind: taste', 'kind: fact', 'Moved from TASTE to Facts: A fact, not a taste']),
  brief(rev?.changes.map((change) => ({ title: change.title, diff: change.diff.slice(0, 600) }))));
}

/** @brief Roll back this revision：两条回到原来的种类，文件与运行前逐字相同。 */
async function refileRollback(ctx, x) {
  await ctx.page.getByTestId('revision-rollback').click();
  const back = await waitFor(async () => (await memoryGet(ctx, x.cwd, REFILE_SLUG.rule)).entry?.kind === 'fact'
    && (await memoryGet(ctx, x.cwd, REFILE_SLUG.fact)).entry?.kind === 'taste', 15000);
  const files = x.revision?.changes.map((c) => readFileSync(join(memProjectDir(ctx.userData, x.cwd), 'entries',
    `${c.to.slug}.md`), 'utf8') === c.before) ?? [];
  record('MEM-38 Roll back this revision puts both entries back in their kinds with the files exactly as before the run',
    back && files.length === 2 && files.every(Boolean), brief({ back, files }));
}

/** @brief MEM-38 步骤（项目 x1-refile）。 */
async function refile(ctx) {
  const x = { cwd: ctx.p['x1-refile'] };
  await refileRun(ctx, x);
  await refileFiles(ctx, x);
  await refilePage(ctx, x);
  await refileRollback(ctx, x);
  await backToApp(ctx);
}

// ---------- window.md"关掉窗口"：增强任务不停 ----------

/**
 * @brief 增强运行中关掉窗口（docs/v0/screens/window.md"关掉窗口"：增强任务不停，后台进程不关）：关窗口那一刻 TASTE 还在跑，
 *        窗口藏进托盘，这次运行照常跑完（今天的三个任务 done，没有记成 "Mori closed during the run"）；点托盘图标回到
 *        窗口。窗口藏着时页面不跑 requestAnimationFrame，这段时间只经进程桥（page.evaluate）、磁盘和主进程读状态。
 *        TASTE 那一次的回复等 4 秒，测试在这期间关掉窗口（项目 hw-hidden，synthetic）。
 */
async function hiddenRun(ctx) {
  const cwd = ctx.p['hw-hidden'];
  todaySession(ctx, cwd, 'Hidden');
  writeScript(SCRIPT, { ...quietScript('@hw-hidden'),
    'taste@hw-hidden': [say('Taste run finished while the window was hidden.', 4000)] });
  await bridgeEnable(ctx, cwd);
  const since = Date.now();
  const run = await bridge(ctx, { type: 'enhance.run', cwd });
  if (run.error) throw new Error(`enhance.run ${cwd}: ${run.error}`);
  const running = await poll(async () => (await enhanceGet(ctx, cwd)).running?.task === 'taste', 20000, 100);
  await recordBalloons(ctx.app);
  await closeWindow(ctx.app);
  const hidden = await waitWindow(ctx.app, offScreen, 5000);
  const atClose = (await enhanceGet(ctx, cwd)).running?.task ?? null;
  const events = await waitSettled(ctx, cwd, since, 3, 60000);
  const whileDone = await windowState(ctx.app);
  const lasts = TASKS.map((task) => readEnhance(ctx.userData, cwd)?.tasks[task].last ?? null);
  await findTray(ctx.app);
  await clickTrayIcon(ctx.app);
  const shown = await waitWindow(ctx.app, onScreen, 5000);
  const today = todayOf();
  record('window.md closing the window during an enhancement run hides it to the tray and the run goes on: today\'s '
    + 'TASTE, STRATEGY and REVIEW all end done (none recorded as "Mori closed during the run") while the window stays '
    + 'hidden; clicking the tray icon shows the window again', Boolean(running) && hidden.ok && atClose === 'taste'
    && lasts.every((last) => last?.status === 'done' && last.day === today && !last.error)
    && phaseBrief(events).filter((line) => line.startsWith('done ')).length === 3 && Boolean(whileDone)
    && offScreen(whileDone) && shown.ok, brief({ running, hidden: hidden.state, atClose,
    events: phaseBrief(events), lasts, whileDone, shown: shown.state }));
}

// ---------- 收尾 ----------

/** @brief MEM-19：本套件里每次增强运行列出的会话文件都在 <userData>\pi\sessions 下（增强会话自己从不在里面）。 */
function neverSelf(ctx) {
  const firsts = [...new Set(enhanceRequests(ctx.ep).map((q) => q.first))];
  const files = firsts.flatMap((first) => listedSessions(first).map((s) => s.file));
  const root = join(ctx.userData, 'pi', 'sessions');
  record('MEM-19 an enhancement session is never listed by a later run: every session file listed in this suite\'s '
    + 'first messages is under <userData>\\pi\\sessions', files.length > 0 && files.every((f) => f.startsWith(root)),
  brief({ runs: firsts.length, outside: files.filter((f) => !f.startsWith(root)) }));
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  settings: [settings, ['MEM-17', 'MEM-25']],
  turnOff: [turnOff, ['MEM-17', 'MEM-25']],
  runNow: [runNow, ['MEM-25', 'MEM-27', 'MEM-32', 'MEM-19', 'MEM-23']],
  notice: [notice, ['MEM-26']],
  failNotice: [failNotice, ['MEM-26', 'MEM-23']],
  endpoint: [endpoint, ['MEM-23', 'MEM-20']],
  headless: [headless, ['MEM-20']],
  evidence: [evidence, ['MEM-21']],
  oneRevision: [oneRevision, ['MEM-22']],
  offDays: [offDays, ['MEM-19']],
  sched: [sched, ['MEM-32']],
  refile: [refile, ['MEM-38', 'MEM-14']],
  hiddenRun: [hiddenRun, ['window.md']],
};

const ctx = { userData: tempUserData('mori-mem-enh-a-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, [step, ids]] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[mem-app-enhance-a] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      for (const id of ids) record(`${id} step ${name} ran to the end`, false, errorLine(error));
      await shot(ctx, args, `${name}-error`);
      await backToApp(ctx).catch(() => {});
    }
  }
  if (!args.only) neverSelf(ctx);
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[mem-app-enhance-a] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
