// 文件系统规格（docs/specs/file-system.md §19.1、§19.2）的 App 套件 fs-app-question：ask_user_question 与提问卡
// （file-system-permissions.md §10）。真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，
// synthetic：关键词模式、脚本 fs-team、增强脚本、项目扩展），逐条验收这些编号在 App 层的通过条件：
//   FS-83 哪些会话有它（请求的 tools、切换模式、重新打开旧版本存下的会话、工具页来源）、FS-84 免批准、FS-86 提问卡
//   （排版、Recommended、Other、Submit、键盘）、FS-87 结果原文与工具卡（实时与重新打开）、FS-88 停止与关闭、
//   FS-89 卡的排序与提示（{n} more、Needs input、Waiting for your answer、任务栏闪烁）、FS-90 转给立项（分开时）。
// 你不在时的那一种结果（FS-87）与投递里的 “not the user's choice”（FS-90）要很短的计时，在 fs-app-away.mjs 里测。
// 依据：file-system-permissions.md §10、§9.9，file-system.md §12、§14，屏幕表 docs/v1/screens/fs-question.md。
// 用法（在 app/ 下，先构建）：node tests/ui/fs-app-question.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/fs-app-question(-packaged).json（--only 时 fs-partial-app-question…，不计入覆盖检查），截图与
// app.log 在 test-results/fs-app-question/。端口：合成端点 5008，记录代理 5009（fs-helpers FS_PORTS.question）。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商（fs-helpers seedFsUserData）；临时目录 ROOT 下的
// 项目：plain（关键词模式）、order（信任；在提问卡、批准卡旁边发扩展询问的项目扩展，另有停止中经 ctx.executeTool 调用
// ask_user_question 的工具 fs_ext_nested，FS-88）、merged（合并会话）、split（SPLIT_ROLES 加一个订阅 request_closed 的
// watcher）、fs83-enh（增强）。启动后先 away.set { timeout: 'never' }（§19.4），窗口焦点由测试给出（fs-away-helpers
// installFocus，只用来看任务栏闪烁）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_CARD_OPEN, sessionOf } from '../fake-endpoint/scripts.mjs';
import {
  answerCard, brief, cardOf, cardsSince, closeFsApp, fsArgs, fsProject, fsRecorder, fsRoot, fsUserData, gateEvents,
  liveInfo, openFsSession, paneSel, poll, reloadFsUi, reopenFs, runSuite, same, seedFsUserData, sendFs, sleep,
  startFsApp, startFsEndpoint, teamMessage, toolCardsOf, waitToolCard, waitToolResult,
} from './fs-helpers.mjs';
import {
  ANSWERS_MISMATCH, ASK_DECLINED, ASK_STOPPED, DECLINED_STATUS, EXT_TITLES, FORWARD_LEAD, ORDER_TITLES,
  WAITING_ANSWER, answerExtCard, answeredText, askCardOf, askCardsSince, blurWindow, eventsOfType, extCardOf,
  fileRowStatus, flashesSince, focusWindow, forwardText, installFocus, kindRequests, openExt, openWith,
  pressInComposer, questionGone, resultEntries, rowStatusOf, sessionRequests, stageTextOf, tryBridge, waitAskCard,
  waitEvent, waitExtCard, waitQuiet, watchAskCards, writeAskExtension,
} from './fs-away-helpers.mjs';
import { chatItems, enhanceRequests, quietScript, seedSession, waitSettled, writeScript }
  from './mem-enhance-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { toolRows } from './m6-tools-helpers.mjs';
import {
  SPLIT_ROLES, bridge, clickTeamSwitch, contentText, paneState, showTab, teamSwitch, waitTeamIdle, writeRoles,
} from './tb-helpers.mjs';

const args = fsArgs('question');
const { record, finish } = fsRecorder(args);

/** 临时目录：各个项目都在它下面（synthetic） */
const ROOT = fsRoot('mori-fs-question-');
/** 增强脚本文件（FAKE_ENHANCE_SCRIPT，synthetic） */
const SCRIPT = join(ROOT, 'enhance-script.json');
/** 增强的项目名（增强请求的第一行写项目路径，按它认） */
const ENH = 'fs83-enh';
/** 分开时订阅 request_closed 的角色（FS-83：订阅实例的请求里没有 ask_user_question） */
const WATCHER = { name: 'watcher', description: 'Keeps notes when a request closes', subscribe: ['request_closed'] };
/** ASK_PRESETS 的两个问题（tests/fake-endpoint/away.mjs，§14 的例子） */
const DB_Q = 'Which database should I use?';
const PARTS_Q = 'Which parts?';
/** 提问工具 */
const ASK = 'ask_user_question';
/** 实时记下的提问工具卡（FS-87：重新打开会话后比较） */
const LIVE = [];
/** 转给立项的问题与答复的固定开头（boardText forwardedAnswerText）：投递给立项时前面多了 "[Mori] New user message: " */
const FORWARDED_BARE = "Answer to the dialog agent's question (ask_user_question):";

// ---------- 准备 ----------

/** @brief 启动 App（away never）、装上窗口焦点的替身与提问卡的记录。 */
async function startQuestionApp(ctx) {
  await startFsApp(ctx);
  await installFocus(ctx);
  await watchAskCards(ctx);
}

/** @brief 合成端点、项目、数据目录（synthetic test setup），启动 App。 */
async function setup(ctx) {
  writeScript(SCRIPT, {});
  ctx.p = Object.fromEntries(['plain', 'order', 'merged', 'split', ENH].map((name) => [name, fsProject(ROOT, name)]));
  writeAskExtension(ctx.p.order, { order: true });
  writeRoles(ctx.p.split, [...SPLIT_ROLES, WATCHER]);
  ctx.ep = await startFsEndpoint('question', { FAKE_ENHANCE_SCRIPT: SCRIPT });
  seedFsUserData(ctx, { trusted: [ctx.p.order] });
  await startQuestionApp(ctx);
}

/** @brief 提问卡里某个问题的某一项（label 为 null 时是 Other）的 input。 */
const optionInput = (tab, index, label) => `${paneSel(tab)} [data-testid="ask-card"] [data-testid="ask-question"]`
  + `[data-index="${index}"] ${label === null ? '[data-testid="ask-other"]'
    : `[data-testid="ask-option"][data-label="${label}"]`} input`;

/** @brief 点提问卡上的一项。 */
const pick = (ctx, who, index, label) => ctx.page.locator(optionInput(who.tab, index, label)).click();

/** @brief 一个问题此刻选中的：{ selected, other（Other 勾没勾）, input（Other 输入框或 null） }。 */
function checkedOf(card, index) {
  const question = card?.questions[index];
  return { selected: question?.options.filter((option) => option.checked).map((option) => option.label) ?? [],
    other: question?.other.checked ?? null, input: question?.input ?? null };
}

/** @brief 焦点所在的元素：{ testid（自己或最近的带 data-testid 的上级）, index（问题）, label（选项；Other 为 Other） }。 */
function focused(ctx) {
  return ctx.page.evaluate(() => {
    const el = document.activeElement;
    const option = el?.closest('[data-testid="ask-option"]');
    return { testid: el?.dataset?.testid ?? el?.closest('[data-testid]')?.dataset.testid ?? null,
      index: el?.closest('[data-testid="ask-question"]')?.dataset.index ?? null,
      label: option?.dataset.label ?? (el?.closest('[data-testid="ask-other"]') ? 'Other' : null),
      checked: typeof el?.checked === 'boolean' ? el.checked : null,
      composer: el?.matches?.('.composer textarea') ?? false };
  });
}

/** @brief 点 picks 里的各项（[问题, label]）再点 Submit，等这张卡的 mori.question_end。 */
async function submitCard(ctx, who, picks) {
  const card = await askCardOf(ctx, who.tab);
  if (!card) throw new Error(`no question card in ${who.tab} to submit`);
  for (const [index, label] of picks) await pick(ctx, who, index, label);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="ask-submit"]`).click();
  return waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === card.request,
    { since: who.since, timeout: 10000 });
}

/** @brief 焦点放到提问卡上按 Esc（拒绝回答），等这张卡的 mori.question_end 与运行结束。 */
async function declineCard(ctx, who) {
  const card = await askCardOf(ctx, who.tab);
  if (!card) throw new Error(`no question card in ${who.tab} to decline`);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="ask-card"] input`).first().focus();
  await ctx.page.keyboard.press('Escape');
  const end = await waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === card.request,
    { since: who.since, timeout: 10000 });
  await waitQuiet(ctx, who.tab);
  return end;
}

/** @brief 这次调用（mori.question_end 的 toolCallId）在会话文件里的工具结果。 */
const resultOf = (who, end) => resultEntries(who.sessionFile).find((item) => item.id === end?.toolCallId) ?? null;

/** @brief 请求里有没有提问工具。 */
const hasAsk = (request) => request.tools.includes(ASK);

// ---------- FS-86、FS-84、FS-83：提问卡的排版与组合（plain 项目） ----------

/** @brief 一个选项应有的样子（askCardOf 的写法）。 */
const optionView = (label, desc, type, recommended) => ({ label, first: label, recommended,
  recText: recommended ? ' (Recommended)' : null, desc, type, checked: false });

/** @brief db-parts 那张卡刚出现时的样子符合 fs-question.md “卡出现”。 */
function layoutOk(card) {
  const [db, parts] = card?.questions ?? [];
  return same(card?.headers, ['Database', 'Scope']) && card.submitDisabled && card.more === null
    && card.questions.length === 2 && db.multi === false && db.header === 'Database' && db.text === DB_Q
    && same(db.options, [optionView('PostgreSQL', 'Server database', 'radio', true),
      optionView('SQLite', 'Single file', 'radio', false)])
    && same(db.other, { type: 'radio', checked: false, text: 'Other' }) && db.input === null
    && same(db.order, ['PostgreSQL', 'SQLite', 'Other']) && same(parts.order, ['API', 'CLI', 'Web', 'Other'])
    && parts.multi === true && parts.header === 'Scope' && parts.text === PARTS_Q
    && same(parts.options, [optionView('API', 'The HTTP API', 'checkbox', true),
      optionView('CLI', 'The command line', 'checkbox', false), optionView('Web', 'The web page', 'checkbox', false)])
    && same(parts.other, { type: 'checkbox', checked: false, text: 'Other' }) && parts.input === null;
}

/** @brief 卡刚出现：排版、一次调用一张卡、不抢焦点；免批准（FS-84）；请求的 tools 里有它（FS-83 关闭模式）。 */
async function layoutChecks(ctx, who) {
  const focus = await focused(ctx);
  const cards = await askCardsSince(ctx, who.since, who.tab);
  record('FS-86 one call shows one card with its questions in order: header tags Database and Scope, each question\'s '
    + 'text, radio buttons for the single choice and check boxes for multiSelect, label and description of every '
    + 'option, " (Recommended)" after the recommended label only, nothing preselected, Other last in each question, '
    + 'Submit not available (aria-disabled)', layoutOk(who.card) && cards.length === 1,
  brief({ card: who.card, cards }));
  record('FS-86 the card does not take the focus: it stays in the input box', focus.composer, brief(focus));
  const gates = (await gateEvents(ctx, who.sessionId, who.since)).filter((item) => item.toolName === ASK);
  const approvals = await cardsSince(ctx, who.since);
  record('FS-84 in Ask each time ask_user_question needs no approval: no approval card, mori.tool_gate is free',
    same(gates.map((item) => item.gate), ['free']) && approvals.length === 0, brief({ gates, approvals }));
  const request = sessionRequests(ctx, who.marker, who.since)[0];
  record('FS-83 the main agent in off mode has ask_user_question in its request tools', Boolean(request)
    && hasAsk(request), brief(request?.tools));
  const tool = await waitToolCard(ctx, who.tab, 'Ask · Database, Scope', (card) => card.statusText === WAITING_ANSWER,
    5000);
  record(`FS-87 the tool card of a question that waits for its card reads "${WAITING_ANSWER}" (§10.6, live)`,
    tool !== null, brief(tool ?? await toolCardsOf(ctx, who.tab)));
}

/** @brief 输入框里按 Enter 是发送、排队，不提交卡。 */
async function enterInComposer(ctx, who) {
  const since = Date.now();
  const box = ctx.page.locator(`${paneSel(who.tab)} .composer textarea`);
  await box.fill('plain fs86 queued');
  await box.press('Enter');
  await sleep(1500);
  const card = await askCardOf(ctx, who.tab);
  const ends = await eventsOfType(ctx, who.sessionId, 'mori.question_end', since);
  const pane = await paneState(ctx.page, who.tab);
  record('FS-86 Enter in the input box sends (queues) the message and does not submit the card: the text left the '
    + 'input box, the card is still there, no mori.question_end', card?.request === who.request && ends.length === 0
    && pane.draft === '', brief({ card: card?.request, ends, draft: pane.draft, queue: pane.queue }));
}

/** @brief 单选：选一项取消另一项；选 Other 取消选项、出现输入框、焦点到输入框；没答完时输入框里 Enter 不做什么。 */
async function singleChoice(ctx, who) {
  await pick(ctx, who, 0, 'PostgreSQL');
  await pick(ctx, who, 0, 'SQLite');
  const single = await askCardOf(ctx, who.tab);
  await pick(ctx, who, 0, null);
  const other = await askCardOf(ctx, who.tab);
  const focus = await focused(ctx);
  record('FS-86 single choice: picking SQLite clears PostgreSQL; picking Other clears SQLite and shows an input with '
    + 'the placeholder "Type your answer" that gets the focus', same(checkedOf(single, 0), { selected: ['SQLite'],
    other: false, input: null }) && same(checkedOf(other, 0), { selected: [], other: true, input: { value: '',
    placeholder: 'Type your answer' } }) && focus.testid === 'ask-other-input' && focus.index === '0',
  brief({ single: checkedOf(single, 0), other: checkedOf(other, 0), focus }));
  const since = Date.now();
  await ctx.page.keyboard.type('Maria');
  await ctx.page.keyboard.press('Enter');
  await sleep(800);
  const waiting = await askCardOf(ctx, who.tab);
  const ends = await eventsOfType(ctx, who.sessionId, 'mori.question_end', since);
  record('FS-86 while a question is unanswered Submit is not available and Enter in an Other input does nothing',
    waiting?.request === who.request && waiting.submitDisabled && ends.length === 0, brief({ waiting, ends }));
}

/** @brief 多选：几项与 Other 可以同时选；只有空白的 Other 不算答了；单选再选一项取消 Other。 */
async function multiChoice(ctx, who) {
  for (const label of ['API', 'CLI', null]) await pick(ctx, who, 1, label);
  const multi = await askCardOf(ctx, who.tab);
  record('FS-86 multi-select: API and CLI stay checked together with Other; with every question answered Submit '
    + 'becomes available', same(checkedOf(multi, 1).selected, ['API', 'CLI']) && checkedOf(multi, 1).other === true
    && !multi.submitDisabled, brief(checkedOf(multi, 1)));
  await pick(ctx, who, 1, 'API');
  await pick(ctx, who, 1, 'CLI');
  const blank = await askCardOf(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="ask-question"][data-index="1"] `
    + '[data-testid="ask-other-input"]').fill('Docs');
  const typed = await askCardOf(ctx, who.tab);
  record('FS-86 an Other with no text is no answer (Submit not available); text in it is an answer (Submit available)',
    blank?.submitDisabled === true && typed?.submitDisabled === false, brief({ blank: checkedOf(blank, 1),
      typed: checkedOf(typed, 1) }));
  await pick(ctx, who, 0, 'SQLite');
  const back = await askCardOf(ctx, who.tab);
  record('FS-86 picking an option of the single-choice question again clears its Other and removes the input',
    same(checkedOf(back, 0), { selected: ['SQLite'], other: false, input: null }), brief(checkedOf(back, 0)));
}

/** @brief 点 Submit：question.answer，按卡上的选择结束。 */
async function mouseSubmit(ctx, who) {
  const end = await submitCard(ctx, who, []);
  const want = [{ question: DB_Q, header: 'Database', selected: ['SQLite'], other: null, auto: false },
    { question: PARTS_Q, header: 'Scope', selected: [], other: 'Docs', auto: false }];
  await waitQuiet(ctx, who.tab);
  const result = resultOf(who, end);
  record('FS-86 Submit sends the choices on the card: mori.question_end { by: "user" } with SQLite and the Other text '
    + 'Docs, and the tool result has them', end?.by === 'user' && same(end.answers, want)
    && result?.text === answeredText([[DB_Q, 'SQLite'], [PARTS_Q, 'Docs']]), brief({ end, result }));
}

/** @brief FS-86 用鼠标的整个流程（一个关闭模式的会话）。 */
async function cardLayout(ctx) {
  const who = await openWith(ctx, ctx.p.plain, 'ask user: db-parts\nmarker fs86-card',
    { kind: 'ask', marker: 'fs86-card' });
  await layoutChecks(ctx, who);
  await enterInComposer(ctx, who);
  await singleChoice(ctx, who);
  await multiChoice(ctx, who);
  await mouseSubmit(ctx, who);
}

// ---------- FS-86、FS-87：键盘与提交的结果 ----------

/** @brief 从输入框 Shift+Tab 走进卡里（最多 8 下）；进去了为真。 */
async function tabIntoCard(ctx, who) {
  await ctx.page.locator(`${paneSel(who.tab)} .composer textarea`).focus();
  for (let i = 0; i < 8; i += 1) {
    await ctx.page.keyboard.press('Shift+Tab');
    const inCard = await ctx.page.evaluate((selector) => Boolean(document.activeElement?.closest(selector)),
      `${paneSel(who.tab)} [data-testid="ask-card"]`);
    if (inCard) return true;
  }
  return false;
}

/** @brief 键盘：↑ ↓ 在组内移动不选中、Space 选中或勾选、Tab 到下一组、Other 的输入框、Submit，输入框里 Enter 提交。 */
async function keyPath(ctx, who) {
  const key = (name) => ctx.page.keyboard.press(name);
  const entered = await tabIntoCard(ctx, who);
  await ctx.page.locator(optionInput(who.tab, 0, 'PostgreSQL')).focus();
  await key('ArrowDown');
  const moved = await focused(ctx);
  await key('Space');
  const chosen = checkedOf(await askCardOf(ctx, who.tab), 0);
  await key('Tab');
  const group = await focused(ctx);
  for (const name of ['Space', 'ArrowDown', 'Space', 'ArrowDown', 'ArrowDown', 'Space']) await key(name);
  const other = await focused(ctx);
  await ctx.page.keyboard.type('Docs');
  await key('Tab');
  const submit = await focused(ctx);
  await key('Shift+Tab');
  const input = await focused(ctx);
  await key('Enter');
  return { entered, moved, chosen, group, other, submit, input };
}

/** @brief FS-86 键盘路径与 FS-87 提交的结果原文。 */
async function keyboard(ctx) {
  const who = await openWith(ctx, ctx.p.plain, 'ask user: db-parts\nmarker fs86-keys',
    { kind: 'ask', marker: 'fs86-keys' });
  const path = await keyPath(ctx, who);
  const end = await waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === who.request,
    { since: who.since, timeout: 10000 });
  const after = await focused(ctx);
  record('FS-86 the keyboard path works: Shift+Tab from the input box reaches the card; ↓ moves within a question '
    + 'without picking, Space picks or checks, Tab goes to the next question, Space on Other moves the focus to its '
    + 'input, Tab reaches Submit, Enter in the Other input submits when everything is answered, and the focus goes '
    + 'back to the input box', path.entered && path.moved.index === '0' && path.moved.label === 'SQLite'
    && path.moved.checked === false && same(path.chosen.selected, ['SQLite']) && path.group.index === '1'
    && path.group.label === 'API' && path.other.testid === 'ask-other-input' && path.other.index === '1'
    && path.submit.testid === 'ask-submit' && path.input.testid === 'ask-other-input' && end?.by === 'user'
    && after.composer, brief({ path, end: end?.by, after }));
  await waitQuiet(ctx, who.tab);
  const want = [{ question: DB_Q, header: 'Database', selected: ['SQLite'], other: null, auto: false },
    { question: PARTS_Q, header: 'Scope', selected: ['API', 'CLI'], other: 'Docs', auto: false }];
  const result = resultOf(who, end);
  const card = await waitToolCard(ctx, who.tab, 'Ask · Database, Scope', (item) => item.status === 'done', 10000);
  record('FS-87 the submitted result is word for word §14 ("User has answered your questions: "…"="SQLite", "…"="API, '
    + 'CLI, Docs". You can now continue with the user’s answers in mind."), is not isError, details.answers matches '
    + 'the card and by is user; the tool card reads Done', same(end?.answers, want) && result?.text
    === answeredText([[DB_Q, 'SQLite'], [PARTS_Q, 'API, CLI, Docs']]) && !result.isError
    && same(result.details?.answers, want) && result.details?.by === 'user' && card?.statusText?.startsWith('Done'),
  brief({ result, card }));
  LIVE.push({ who, title: 'Ask · Database, Scope', status: 'done', statusText: card?.statusText ?? null });
}

// ---------- FS-87：拒绝回答与命令失败 ----------

/** 对不上问题的几种答复（question.answer 失败） */
const BAD_ANSWERS = [
  ['two answers for one question', [{ selected: ['PostgreSQL'], other: null }, { selected: ['SQLite'], other: null }]],
  ['a label that is not an option', [{ selected: ['MySQL'], other: null }]],
  ['two labels for a single choice', [{ selected: ['PostgreSQL', 'SQLite'], other: null }]],
  ['a blank Other', [{ selected: [], other: '   ' }]],
];

/**
 * @brief FS-89：只有一张提问卡挂着（没有扩展询问、没有批准卡）时侧栏行 Needs input、阶段行 Waiting for your answer；
 *        界面重新载入后还没点开这个会话时侧栏行按 LiveStatus.question 也是 Needs input；再点开，卡照原样出现。
 */
async function questionHints(ctx, who) {
  await showTab(ctx, who.tab);
  const view = { row: await rowStatusOf(ctx, who.tab), stage: await stageTextOf(ctx, who.tab),
    ext: await extCardOf(ctx, who.tab), approval: await cardOf(ctx, who.tab) };
  record('FS-89 with only a question card waiting (no extension prompt, no approval card) the sidebar row reads '
    + `"Needs input" and the stage line "${WAITING_ANSWER}"`, view.row?.status === 'question'
    && view.row.text === 'Needs input' && view.stage === WAITING_ANSWER && view.ext === null && view.approval === null,
  brief(view));
  await reloadFsUi(ctx);
  await watchAskCards(ctx);
  const saved = await poll(async () => {
    const now = await fileRowStatus(ctx, who.sessionFile);
    return now?.status === 'question' ? now : null;
  }, 10000, 200) ?? await fileRowStatus(ctx, who.sessionFile);
  record('FS-89 after the window reloads, the row of a session with a waiting question card that is not opened yet '
    + 'reads "Needs input" (LiveStatus.question)', saved?.status === 'question' && saved.text === 'Needs input'
    && saved.opened === false, brief(saved));
  await reopenFs(ctx, who);
  if (!(await waitAskCard(ctx, who.tab, { timeout: 15000 }))) throw new Error('the question card did not come back');
}

/**
 * @brief FS-87：question.answer 的失败、Esc 拒绝回答的结果与工具卡、结束之后再答；FS-89 只有提问卡时的提示；
 *        FS-86 键盘路径里的 Esc。
 */
async function decline(ctx) {
  const who = await openWith(ctx, ctx.p.plain, 'ask user: db\nmarker fs87-decline',
    { kind: 'ask', marker: 'fs87-decline' });
  await questionHints(ctx, who);
  const command = (answers) => ({ type: 'question.answer', sessionId: who.sessionId, requestId: who.request, answers });
  const errors = [];
  for (const [what, answers] of BAD_ANSWERS) errors.push([what, (await tryBridge(ctx, command(answers))).error]);
  const still = await askCardOf(ctx, who.tab);
  record(`FS-87 question.answer fails with "${ANSWERS_MISMATCH}" for the wrong number of answers, a label that is not `
    + 'an option, two labels for a single choice and a blank Other, and the card keeps waiting',
  errors.every(([, error]) => error === ANSWERS_MISMATCH) && still?.request === who.request, brief(errors));
  const end = await declineCard(ctx, who);
  const after = { card: await askCardOf(ctx, who.tab), focus: await focused(ctx) };
  record('FS-86 Esc with the focus on the card (keyboard path) declines it: the card goes away, mori.question_end '
    + '{ by: "declined" } and the focus returns to the input box', end?.by === 'declined' && after.card === null
    && after.focus.composer, brief({ by: end?.by ?? null, ...after }));
  const result = resultOf(who, end);
  const card = await waitToolCard(ctx, who.tab, 'Ask · Database', (item) => item.status === 'rejected', 10000);
  record('FS-87 Esc on the card declines: mori.question_end { by: "declined" }, the tool result is ASK_DECLINED_TEXT '
    + `word for word and isError with details.answers null, and the tool card reads "${DECLINED_STATUS}"`,
  end?.by === 'declined' && end.answers === null && result?.text === ASK_DECLINED && result.isError
    && result.details?.answers === null && card?.statusText === DECLINED_STATUS, brief({ end, result, card }));
  const late = await tryBridge(ctx, command([{ selected: ['PostgreSQL'], other: null }]));
  record('FS-87 question.answer after the request ended fails with "Question <id> is no longer pending"',
    late.error === questionGone(who.request), brief(late));
  LIVE.push({ who, title: 'Ask · Database', status: 'rejected', statusText: card?.statusText ?? null });
}

// ---------- FS-88：停止 ----------

/** @brief FS-88、FS-87：卡挂着时 Esc 停止：卡消失，pi 记下停止的原文，工具卡 Stopped。 */
async function stopCard(ctx) {
  const who = await openWith(ctx, ctx.p.plain, 'ask user: db\nmarker fs88-stop', { kind: 'ask', marker: 'fs88-stop' });
  await pressInComposer(ctx, who.tab, 'Escape');
  const end = await waitEvent(ctx, who.sessionId, 'mori.question_end', (item) => item.requestId === who.request,
    { since: who.since, timeout: 10000 });
  await waitQuiet(ctx, who.tab);
  await sleep(1500);
  const results = resultEntries(who.sessionFile).filter((item) => item.tool === ASK);
  const tools = (await toolCardsOf(ctx, who.tab)).filter((card) => card.title.startsWith('Ask ·'));
  const pending = await askCardOf(ctx, who.tab);
  record('FS-88 Esc while the card waits (focus in the input box): the card goes away, mori.question_end { by: '
    + '"stop" }, pi records "Not answered: the user stopped the run." (isError, not "Operation aborted") as the tool '
    + 'result, and the tool card reads Stopped', end?.by === 'stop' && pending === null
    && results[0]?.text === ASK_STOPPED && results[0].isError && tools[0]?.status === 'stopped'
    && tools[0].statusText === 'Stopped', brief({ end, results, tools }));
  record('FS-87 the stopped result is ASK_STOPPED_TEXT word for word, isError, and details is { answers: null, by: '
    + '"stop" }', results[0]?.text === ASK_STOPPED && results[0].isError
    && same(results[0].details, { answers: null, by: 'stop' }), brief(results[0] ?? null));
  LIVE.push({ who, title: 'Ask · Database', status: 'stopped', statusText: 'Stopped' });
}

/** @brief fs_ext_nested 的结果里那次嵌套调用的 { isError, text, details }；没有或读不出时为 null。 */
function nestedOf(text) {
  const match = /nested=(\{.*\})$/s.exec(text ?? '');
  try {
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * @brief FS-88：停止中新到的提问调用不出卡。pi 的顺序执行在运行中止后不再执行同一条回复里后面的调用，所以用 order 项目的
 *        fs_ext_nested（synthetic）：它的确认卡挂着时按 Esc，确认被取消，它接着经 ctx.executeTool 调用
 *        ask_user_question（自己的 signal）；session.abort() 等这个工具返回，所以这次调用一定落在停止中。
 */
async function nestedStop(ctx) {
  const who = await openExt(ctx, ctx.p.order, 'call tool: fs_ext_nested\nmarker fs88-nested');
  if (who.card.title !== EXT_TITLES.nested) throw new Error(`unexpected extension card: ${JSON.stringify(who.card)}`);
  const since = Date.now();
  await pressInComposer(ctx, who.tab, 'Escape');
  const result = await waitToolResult(who.sessionFile, (item) => item.tool === 'fs_ext_nested', 15000);
  await waitQuiet(ctx, who.tab);
  const nested = nestedOf(result?.text);
  const cards = await askCardsSince(ctx, since, who.tab);
  const asked = await eventsOfType(ctx, who.sessionId, 'mori.question_request', since);
  record('FS-88 an ask_user_question call made while stopping (nested in an extension tool whose prompt was cancelled '
    + 'by Esc) shows no card and no mori.question_request, and returns "Not answered: the user stopped the run." '
    + '(isError, details { answers: null, by: "stop" })', nested?.isError === true && nested.text === ASK_STOPPED
    && same(nested.details, { answers: null, by: 'stop' }) && cards.length === 0 && asked.length === 0,
  brief({ result: result?.text ?? null, cards, asked: asked.map((item) => item.requestId) }));
}

/** @brief FS-88、FS-87：停止的两种情况。 */
async function stopping(ctx) {
  await stopCard(ctx);
  await nestedStop(ctx);
}

// ---------- FS-89：卡的排序与提示（order 项目） ----------

/** @brief 有批准卡时先显示批准卡，跟着它来的扩展询问排在后面；答完批准卡后询问卡出现。 */
async function approvalFirst(ctx) {
  const who = await openWith(ctx, ctx.p.order, 'run: echo fs89-approval');
  const waiting = await poll(async () => ((await liveInfo(ctx, who.sessionFile))?.live?.questions ?? []).length > 0,
    10000, 200);
  const view = { approval: await cardOf(ctx, who.tab), ext: await extCardOf(ctx, who.tab),
    stage: await stageTextOf(ctx, who.tab) };
  record('FS-89 while an approval card waits it is shown first: the extension prompt that came with it waits behind '
    + '(no extension card) and the stage line reads "Waiting for your approval"', Boolean(waiting)
    && view.approval?.tool === 'bash' && view.ext === null && view.stage === 'Waiting for your approval', brief(view));
  await answerCard(ctx, who.tab, 'deny');
  const next = await waitExtCard(ctx, who.tab, { timeout: 10000 });
  record('FS-89 once the approval card is answered the extension card that waited comes up', next?.title
    === ORDER_TITLES.approval, brief(next));
  await answerExtCard(ctx, who.tab, 'No');
  await waitQuiet(ctx, who.tab);
}

/** @brief 扩展询问先到：它先显示、卡头 1 more（计入提问卡）；侧栏 Needs input、阶段行 Waiting for your answer。 */
async function extBeforeAsk(ctx) {
  const who = await openWith(ctx, ctx.p.order, 'ask user: four\nmarker fs89-before',
    { kind: 'extension', marker: 'fs89-before' });
  const asked = await poll(async () => ((await liveInfo(ctx, who.sessionFile))?.live?.asks ?? []).length === 1,
    10000, 200);
  const front = await extCardOf(ctx, who.tab);
  const behind = await askCardOf(ctx, who.tab);
  const row = await rowStatusOf(ctx, who.tab);
  const stage = await stageTextOf(ctx, who.tab);
  record('FS-89 question and extension cards show in arrival order: the extension prompt that came first is shown and '
    + 'its header says "1 more" (the question card waiting behind counts)', Boolean(asked)
    && front?.title === ORDER_TITLES.before && front.more === '1 more' && behind === null, brief({ front, behind }));
  record(`FS-89 while a question card waits the sidebar row reads "Needs input" and the stage line "${WAITING_ANSWER}"`,
    row?.status === 'question' && row.text === 'Needs input' && stage === WAITING_ANSWER, brief({ row, stage }));
  await answerExtCard(ctx, who.tab, 'No');
  const next = await waitAskCard(ctx, who.tab, { timeout: 10000 });
  record('FS-89 answering it brings up the question card (four questions), with no "{n} more" left',
    next?.questions.length === 4 && next.more === null, brief(next && { request: next.request, more: next.more }));
  await declineCard(ctx, who);
}

/** @brief 提问卡先到：扩展询问来了排在后面，提问卡卡头 1 more；提交后扩展询问卡出现。 */
async function askBeforeExt(ctx) {
  const who = await openWith(ctx, ctx.p.order, 'ask user: parts\nmarker fs89-after',
    { kind: 'ask', marker: 'fs89-after' });
  const shown = await poll(async () => {
    const card = await askCardOf(ctx, who.tab);
    return card?.more ? card : null;
  }, 10000, 150);
  const ext = await extCardOf(ctx, who.tab);
  record('FS-89 an extension prompt that comes while a question card is shown waits behind it: the question card '
    + 'stays and its header says "1 more"', shown?.request === who.request && shown.more === '1 more' && ext === null,
  brief({ more: shown?.more, ext }));
  await submitCard(ctx, who, [[0, 'API']]);
  const next = await waitExtCard(ctx, who.tab, { timeout: 10000 });
  record('FS-89 after submitting the question card the extension card comes up', next?.title === ORDER_TITLES.after,
    brief(next));
  await answerExtCard(ctx, who.tab, 'No');
  await waitQuiet(ctx, who.tab);
}

/** @brief 窗口不在前台：提问卡让任务栏闪烁，扩展询问不闪；拿回焦点时停止闪烁。 */
async function flash(ctx) {
  let flashed = false;
  let extFlashes = [];
  await blurWindow(ctx);
  try {
    const since = Date.now();
    const who = await openWith(ctx, ctx.p.order, 'ask user: db\nmarker fs89-flash',
      { kind: 'ask', marker: 'fs89-flash' });
    flashed = Boolean(await poll(async () => (await flashesSince(ctx, since)).includes(true), 5000, 150));
    await declineCard(ctx, who);
    // 扩展的工具先要批准（批准卡照旧闪烁）：只看点了 Allow once 之后、扩展询问卡出现时有没有闪烁
    const ext = await openExt(ctx, ctx.p.order, 'call tool: fs_ext_confirm');
    await sleep(1500);
    extFlashes = await flashesSince(ctx, ext.allowedAt);
    await answerExtCard(ctx, ext.tab, 'No');
    await waitQuiet(ctx, ext.tab);
  } finally {
    const back = Date.now();
    await focusWindow(ctx);
    const stopped = await poll(async () => (await flashesSince(ctx, back)).includes(false), 3000, 150);
    record('FS-89 a question card while the window is not in front flashes the taskbar button (flashFrame(true)), and '
      + 'focusing the window stops it (flashFrame(false))', flashed && Boolean(stopped), brief({ flashed, stopped }));
  }
  record('FS-89 an extension prompt while the window is not in front does not flash the taskbar (unchanged)',
    !extFlashes.includes(true), brief(extFlashes));
}

/** @brief FS-89 的排序与提示。 */
async function orderCards(ctx) {
  await approvalFirst(ctx);
  await extBeforeAsk(ctx);
  await askBeforeExt(ctx);
  await flash(ctx);
}

// ---------- FS-89、FS-84、FS-90、FS-83：合并会话（merged 项目） ----------

/** @brief 让这个会话回到关闭模式：协作开关不是 off 时点它（Until done 点一下是 On，再点一下是 Off）。 */
async function teamOff(ctx, who) {
  await showTab(ctx, who.tab);
  for (let i = 0; i < 2 && (await teamSwitch(ctx, who.tab)).mode !== 'off'; i += 1) {
    await clickTeamSwitch(ctx, who.tab);
  }
  if ((await teamSwitch(ctx, who.tab)).mode !== 'off') throw new Error(`team mode of ${who.tab} did not turn off`);
}

/** @brief 合并会话：后台批准卡先于提问卡；免批准；不转给立项。 */
async function mergedCards(ctx, who) {
  const since = Date.now();
  await sendFs(ctx, who, teamMessage([['fs-create', 'ask user: db']]), { team: true, wait: false });
  const asked = await poll(async () => ((await liveInfo(ctx, who.sessionFile))?.live?.asks ?? [])[0] ?? null,
    30000, 200);
  const view = { approval: await cardOf(ctx, who.tab), ask: await askCardOf(ctx, who.tab) };
  record('FS-89 a background approval card is shown before a question card of the same session: the question waits '
    + 'behind it (no question card while the approval card is up)', Boolean(asked) && view.approval?.agent === 'mori'
    && view.ask === null, brief(view));
  await answerCard(ctx, who.tab, 'deny');
  const card = await waitAskCard(ctx, who.tab, { timeout: 10000 });
  const gates = (await gateEvents(ctx, who.sessionId, since)).filter((item) => item.toolName === ASK);
  const approvals = (await cardsSince(ctx, since)).filter((item) => item.tool === ASK);
  record('FS-84 the merged session in team mode (narrowed: no file changes, no MCP) can still ask: the card comes up, '
    + 'no approval card for it, mori.tool_gate is free', card !== null && same(gates.map((item) => item.gate),
    ['free']) && approvals.length === 0, brief({ gates, approvals }));
  const end = await submitCard(ctx, who, [[0, 'PostgreSQL']]);
  await sleep(4000);
  const forwarded = sessionRequests(ctx, null, since).filter((item) => item.users
    .some((text) => text.includes(FORWARD_LEAD)));
  record('FS-90 a merged session does not forward the answer (the dialog is the create agent): no "[Mori] New user '
    + 'message: Answer to the dialog agent\'s question …" delivery', end?.by === 'user' && forwarded.length === 0,
  brief({ end: end?.by, forwarded: forwarded.length }));
}

/**
 * @brief FS-83：合并会话的请求有它，task、结案实例的没有；回到关闭模式后仍有。实例的请求不一定带你的原话，
 *        所以按时间认（这段时间只有这个会话在跑）。
 */
async function mergedTools(ctx, who) {
  const all = kindRequests(ctx, null, { since: who.since });
  const of = (kind) => all.filter((item) => item.info.kind === kind);
  record('FS-83 the merged session\'s requests in team mode have ask_user_question; its task and close instances\' '
    + 'requests do not', of('merged-create').length > 0 && of('merged-create').every(hasAsk) && of('task').length > 0
    && !of('task').some(hasAsk) && of('close').length > 0 && !of('close').some(hasAsk),
  brief(all.map((item) => [item.info.kind, hasAsk(item)])));
  await teamOff(ctx, who);
  const since = Date.now();
  await sendFs(ctx, who, teamMessage([['fs-off', 'say: Off reply fs83m.']]));
  await waitQuiet(ctx, who.tab);
  const off = kindRequests(ctx, who.marker, { since }).filter((item) => item.users
    .some((text) => text.includes('Off reply fs83m.')));
  record('FS-83 after switching the merged session back to off mode its requests still have ask_user_question',
    off.length > 0 && off.every(hasAsk) && off.every((item) => item.info.kind !== 'merged-create'),
  brief(off.map((item) => [item.info.kind, hasAsk(item)])));
}

/** @brief 合并会话的整个流程。 */
async function mergedSession(ctx) {
  const who = await openWith(ctx, ctx.p.merged, teamMessage([['fs-call', 'write file: ../fs89-bg.md']]),
    { team: true, marker: 'fs89-bg.md', timeout: 90000 });
  if (!who.card.agent) throw new Error('the first card of the merged session is not a background card');
  await mergedCards(ctx, who);
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the merged session did not become idle');
  await mergedTools(ctx, who);
}

// ---------- FS-90、FS-84、FS-83：分开时（split 项目） ----------

/** @brief 立项（planner 的 create）收到的、最后一次投递以转给立项的开头起头的请求。 */
const forwardOf = (ctx, marker, since) => kindRequests(ctx, marker, { kind: 'create', role: 'planner', since })
  .find((item) => item.info.last?.startsWith(FORWARD_LEAD)) ?? null;

/** @brief 分开时答完：立项收到 §14 的投递、照用户消息判断；排队区没有；判断完不交给对话。 */
async function forwardChecks(ctx, who) {
  const since = Date.now();
  const end = await submitCard(ctx, who, [[0, 'SQLite']]);
  const want = forwardText([`"${DB_Q}"="SQLite"`]);
  const forward = await poll(() => forwardOf(ctx, who.marker, since), 30000, 200);
  const pane = await paneState(ctx.page, who.tab);
  const info = await liveInfo(ctx, who.sessionFile);
  record('FS-90 split: after you answer, the create agent (planner) gets the §14 delivery "[Mori] New user message: '
    + 'Answer to the dialog agent\'s question (ask_user_question): "…"="SQLite"" + "Make exactly one decision for it." '
    + 'as a user-message delivery of its create session', end?.by === 'user' && forward?.info.last === want
    && forward.info.kind === 'create', brief({ got: forward?.info.last ?? null, k: forward?.info.k }));
  const inQueue = (text) => (text ?? '').includes("Answer to the dialog agent's question");
  record('FS-90 the forwarded answer is not in the queue area and not among the messages waiting for a judgment',
    !pane.queue.some(inQueue) && !(info?.deciding?.queue ?? []).some((item) => inQueue(item.text)),
  brief({ queue: pane.queue, deciding: info?.deciding }));
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the split session did not become idle');
  // 交给对话时是不带 "[Mori] New user message: " 的原话（判断完的用户消息照原样交给对话）；对话自己的工具结果是
  // "User has answered your questions: …"，不会混
  const handed = kindRequests(ctx, who.marker, { kind: 'team-dialog', since })
    .filter((item) => item.users.some((text) => text.includes(FORWARDED_BARE)));
  record('FS-90 after the judgment the forwarded answer is not handed to the dialog: no team-dialog request carries it',
    handed.length === 0, brief(handed.map((item) => item.info.last)));
}

/**
 * @brief FS-83：分开时对话的请求有它，立项、task、结案、订阅的没有。订阅实例的请求里没有你的原话，所以按时间认
 *        （这段时间只有这个会话在跑）。
 */
function splitKinds(ctx, who) {
  const all = kindRequests(ctx, null, { since: who.since });
  const of = (kind) => all.filter((item) => item.info.kind === kind);
  const without = ['create', 'task', 'close', 'subscription'];
  record('FS-83 split team mode: the dialog\'s (team-dialog) requests have ask_user_question; the create, task, close '
    + 'and subscription instances\' requests do not', of('team-dialog').length > 0 && of('team-dialog').every(hasAsk)
    && without.every((kind) => of(kind).length > 0 && !of(kind).some(hasAsk)),
  brief(all.map((item) => [item.info.role, item.info.kind, hasAsk(item)])));
}

/** @brief FS-83：切到关闭模式、再切回协作模式后对话的请求仍有它。 */
async function splitSwitch(ctx, who) {
  await teamOff(ctx, who);
  const offSince = Date.now();
  await sendFs(ctx, who, teamMessage([['fs-off', 'say: Off reply fs83s.']]));
  await waitQuiet(ctx, who.tab);
  const off = kindRequests(ctx, who.marker, { kind: 'off-dialog', since: offSince });
  const teamSince = Date.now();
  await sendFs(ctx, who, teamMessage([['fs-dialog', 'say: Chat again fs83s.']]), { team: true, wait: false });
  if (!(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('the split session did not become idle');
  const team = kindRequests(ctx, who.marker, { kind: 'team-dialog', since: teamSince });
  record('FS-83 after switching to off mode and back to team mode the dialog\'s requests still have ask_user_question',
    off.length > 0 && off.every(hasAsk) && team.length > 0 && team.every(hasAsk),
  brief({ off: off.map(hasAsk), team: team.map(hasAsk) }));
}

/** @brief 分开时的整个流程：对话 Agent 提问（免批准）、转给立项、各种会话的 tools、切换模式。 */
async function splitForward(ctx) {
  const who = await openWith(ctx, ctx.p.split, teamMessage([['fs-call', 'say: Task fs83.'],
    ['fs-dialog', 'ask user: db']]), { kind: 'ask', team: true, marker: 'Task fs83.', timeout: 90000 });
  const gates = (await gateEvents(ctx, who.sessionId, who.since)).filter((item) => item.toolName === ASK);
  const approvals = (await cardsSince(ctx, who.since)).filter((item) => item.tool === ASK);
  record('FS-84 the dialog agent in split team mode (narrowed to relaying) asks without an approval card: '
    + 'mori.tool_gate is free', same(gates.map((item) => item.gate), ['free']) && approvals.length === 0,
  brief({ gates, approvals }));
  await forwardChecks(ctx, who);
  splitKinds(ctx, who);
  await splitSwitch(ctx, who);
}

/** @brief 记录代理的规则（synthetic）：marker 这个会话里对话拿到工具结果后的请求、立项收到转来的答复的请求各推迟 8 秒。 */
function holdRule(marker) {
  return ({ body }) => {
    const messages = body?.messages ?? [];
    if (!messages.some((m) => m.role === 'user' && contentText(m.content).includes(marker))) return null;
    const tail = messages.filter((m) => !(m.role === 'user' && contentText(m.content).trimStart()
      .startsWith(WORK_CARD_OPEN)));
    const forwarded = sessionOf(messages).last?.startsWith(FORWARD_LEAD) ?? false;
    return tail.at(-1)?.role === 'tool' || forwarded ? { delayMs: 8000 } : null;
  };
}

/** @brief FS-90：转来的答复还在判断、对话还在回复时按 Esc：它不回到输入框。 */
async function splitStop(ctx) {
  const marker = 'fs90-stop';
  ctx.ep.proxy.rule = holdRule(marker);
  let who = null;
  try {
    who = await openWith(ctx, ctx.p.split, teamMessage([['fs-dialog', 'ask user: parts'], ['fs-note', marker]]),
      { kind: 'ask', team: true, marker, timeout: 90000 });
    const since = Date.now();
    await submitCard(ctx, who, [[0, 'API']]);
    const forward = await poll(() => forwardOf(ctx, marker, since), 20000, 200);
    if (!forward) throw new Error('the answer was not forwarded to the planner');
    await pressInComposer(ctx, who.tab, 'Escape');
    await sleep(3000);
    const pane = await paneState(ctx.page, who.tab);
    const errors = await eventsOfType(ctx, who.sessionId, 'mori.prompt_error', since);
    const carried = errors.filter((item) => [item.text, ...(item.queued ?? [])].some((text) => (text ?? '')
      .includes('Answer to the dialog agent')));
    record('FS-90 stopping the dialog (Esc) while the forwarded answer is being judged does not put it back into the '
      + 'input box (the input box stays empty and no mori.prompt_error carries it)', pane.draft === ''
      && carried.length === 0, brief({ draft: pane.draft, errors }));
  } finally {
    ctx.ep.proxy.rule = null;
  }
  if (who && !(await waitTeamIdle(ctx, who, { timeout: 120000 }))) throw new Error('fs90-stop did not become idle');
}

/** @brief FS-90、FS-83：关闭模式（有别的角色）不转；关闭模式的对话有它，临时提问的实例没有。 */
async function splitOff(ctx) {
  const who = await openWith(ctx, ctx.p.split, teamMessage([['fs-off', 'ask user: db'], ['fs-note', 'fs90-off']]),
    { kind: 'ask', marker: 'fs90-off' });
  const since = Date.now();
  const end = await submitCard(ctx, who, [[0, 'PostgreSQL']]);
  await waitQuiet(ctx, who.tab);
  await sleep(4000);
  const forwarded = kindRequests(ctx, null, { kind: 'create', since })
    .filter((item) => item.info.last?.startsWith(FORWARD_LEAD));
  record('FS-90 in off mode the answer is not forwarded: no create request carries it', end?.by === 'user'
    && forwarded.length === 0, brief(forwarded.map((item) => item.info.last)));
  await sendFs(ctx, who, teamMessage([['fs-off',
    'call tool: agent_message {"to":"planner","text":"Why fs83? tb-scenario:fs-team"}']]));
  await waitQuiet(ctx, who.tab, 90000);
  const dialog = kindRequests(ctx, 'fs90-off', { kind: 'off-dialog' });
  const ask = kindRequests(ctx, 'Why fs83?', { kind: 'ask' });
  record('FS-83 off mode with other roles: the dialog\'s (off-dialog) requests have ask_user_question, the temporary '
    + 'question instance\'s (ask) requests do not', dialog.length > 0 && dialog.every(hasAsk) && ask.length > 0
    && !ask.some(hasAsk), brief({ dialog: dialog.map(hasAsk), ask: ask.map(hasAsk) }));
}

// ---------- FS-83：增强会话与工具页 ----------

/** @brief FS-83：增强会话的请求里没有它。 */
async function enhancement(ctx) {
  const cwd = ctx.p[ENH];
  seedSession(ctx.userData, cwd, { name: 'FS-83 session', items: chatItems(['Question about fs83', 'Answer one.',
    'Another question', 'Answer two.'], Date.now() - 30 * 60000) });
  writeScript(SCRIPT, quietScript());
  const set = await bridge(ctx, { type: 'enhance.set', cwd, enabled: true });
  if (set?.error) throw new Error(`enhance.set: ${set.error}`);
  const since = Date.now();
  const run = await bridge(ctx, { type: 'enhance.run', cwd });
  if (run?.error) throw new Error(`enhance.run: ${run.error}`);
  await waitSettled(ctx, cwd, since, 3);
  const requests = enhanceRequests(ctx.ep, { since }).filter((item) => item.first.includes(ENH));
  record('FS-83 the enhancement session (not a user session) has no ask_user_question in its requests',
    requests.length >= 3 && !requests.some((item) => item.tools.includes(ASK)),
  brief(requests.map((item) => [item.kind, item.tools.includes(ASK)])));
}

/** @brief FS-83：工具页（Customize → Built-in tools）里 ask_user_question 的来源是 Mori。 */
async function toolsPage(ctx) {
  const who = await openFsSession(ctx, ctx.p.plain);
  await sendFs(ctx, who, 'plain fs83 tools page');
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  const ask = rows.find((row) => row.name === ASK);
  await ctx.page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' }).first().click();
  await ctx.page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 10000 });
  record('FS-83 the tools page lists ask_user_question with the source Mori, enabled', ask?.tag === 'Mori'
    && ask.active === 'true', brief(ask ?? rows.map((row) => row.name)));
}

// ---------- 重新启动之后：FS-88 关闭、FS-87 重新打开、FS-83 旧版本存下的会话 ----------

/**
 * @brief 测试准备（synthetic）：把会话文件里 system 消息声明的工具（toolsAdded）去掉 ask_user_question，模仿旧版本存下的
 *        会话（那时还没有这个工具，声明的工具含全部 pi 默认工具）。
 * @return { removed（去掉的个数）, declared（剩下声明的工具名）, mentions（文件里还有没有这个名字） }
 */
function stripAskTool(file) {
  let removed = 0;
  const declared = new Set();
  const lines = readFileSync(file, 'utf8').split('\n').map((line) => {
    if (!line.trim()) return line;
    const entry = JSON.parse(line);
    const message = entry.type === 'message' ? entry.message : null;
    if (message?.role !== 'system' || !Array.isArray(message.toolsAdded)) return line;
    const kept = message.toolsAdded.filter((tool) => tool.name !== ASK);
    removed += message.toolsAdded.length - kept.length;
    message.toolsAdded = kept;
    for (const tool of kept) declared.add(tool.name);
    return JSON.stringify(entry);
  });
  writeFileSync(file, lines.join('\n'));
  return { removed, declared: [...declared].sort(), mentions: lines.join('\n').includes(ASK) };
}

/** @brief FS-88：退出 App 时卡还挂着：重启后卡不在，pi 记下停止的原文，工具卡 Stopped。 */
async function closedCard(ctx, who) {
  const result = resultEntries(who.sessionFile).find((item) => item.tool === ASK);
  await reopenFs(ctx, who);
  const card = await waitToolCard(ctx, who.tab, 'Ask · Database', () => true, 15000);
  const pending = await askCardOf(ctx, who.tab);
  record('FS-88 closing the session (quitting Mori) while the card waits ends it like a stop: after the restart the '
    + 'card is gone, pi recorded "Not answered: the user stopped the run." (isError) and the tool card reads Stopped',
  result?.text === ASK_STOPPED && result.isError && card?.status === 'stopped' && pending === null,
  brief({ result, card, pending }));
}

/** @brief FS-87：重新打开会话后提问的工具卡与实时一样（Done、Denied · You declined to answer、Stopped）。 */
async function reopenedCards(ctx) {
  const rows = [];
  for (const item of LIVE) {
    await reopenFs(ctx, item.who);
    const card = (await toolCardsOf(ctx, item.who.tab)).find((tool) => tool.title === item.title) ?? null;
    const ok = card?.status === item.status && (item.status === 'done' ? card.statusText.startsWith('Done')
      : card.statusText === item.statusText);
    rows.push({ title: item.title, want: item.status, got: card?.status ?? null, text: card?.statusText ?? null, ok });
  }
  record('FS-87 after reopening the sessions the question tool cards read the same as live: Done (submitted), '
    + `"${DECLINED_STATUS}" (declined), Stopped (stopped)`, rows.length === 3 && rows.every((row) => row.ok),
  brief(rows));
}

/** @brief FS-83：旧版本存下的会话重新打开后，请求里又有 ask_user_question。 */
async function oldSession(ctx, old, edited) {
  await reopenFs(ctx, old);
  const since = Date.now();
  await sendFs(ctx, old, 'plain fs83-old again');
  const request = sessionRequests(ctx, 'plain fs83-old again', since)[0];
  record('FS-83 reopening a session saved by an older version (synthetic: ask_user_question taken out of its declared '
    + 'tools, which still hold read, bash, edit and write) gives its requests ask_user_question again',
  edited.removed > 0 && ['bash', 'edit', 'read', 'write'].every((name) => edited.declared.includes(name))
    && Boolean(request) && hasAsk(request), brief({ edited, tools: request?.tools }));
}

/** @brief 退出 App（一张提问卡还挂着），改旧会话的文件，重新启动，做重新打开后的检查。 */
async function restartChecks(ctx) {
  const closing = await openWith(ctx, ctx.p.plain, 'ask user: db\nmarker fs88-close', { kind: 'ask',
    marker: 'fs88-close' });
  const old = await openFsSession(ctx, ctx.p.plain);
  await sendFs(ctx, old, 'plain fs83-old session');
  await waitQuiet(ctx, old.tab);
  await closeFsApp(ctx);
  ctx.projectTabs = {};
  const edited = stripAskTool(old.sessionFile);
  await startQuestionApp(ctx);
  await closedCard(ctx, closing);
  await reopenedCards(ctx);
  await oldSession(ctx, old, edited);
}

// ---------- 主流程 ----------

/** 步骤与它验收的编号（步骤没跑完时，每个编号记一条失败） */
const steps = {
  card: [cardLayout, ['FS-86', 'FS-84', 'FS-83', 'FS-87']],
  keyboard: [keyboard, ['FS-86', 'FS-87']],
  decline: [decline, ['FS-87', 'FS-89', 'FS-86']],
  stop: [stopping, ['FS-88', 'FS-87']],
  order: [orderCards, ['FS-89']],
  merged: [mergedSession, ['FS-89', 'FS-84', 'FS-90', 'FS-83']],
  split: [splitForward, ['FS-90', 'FS-84', 'FS-83']],
  splitStop: [splitStop, ['FS-90']],
  splitOff: [splitOff, ['FS-90', 'FS-83']],
  enhancement: [enhancement, ['FS-83']],
  tools: [toolsPage, ['FS-83']],
  // 重新启动 App：放在最后
  restart: [restartChecks, ['FS-88', 'FS-87', 'FS-83']],
};

const ctx = { ...fsUserData('mori-fs-question-data-'), exePath: args.exePath, pageErrors: [], args, record };
await runSuite(ctx, setup, steps);
console.log(`[fs-app-question] data in ${ctx.userData}, projects in ${ROOT}`);
finish();
