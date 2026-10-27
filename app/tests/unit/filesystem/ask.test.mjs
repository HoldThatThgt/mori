// kernel/askQuestion.ts 的单元测试（docs/specs/file-system-permissions.md §10.1–§10.6；file-system.md §12、§14 的原文、
// §19.2 FS-83、FS-84、FS-85、FS-87 的单元部分）：mori-question 注册的工具与说明、免批准（路径闸与收窄）、pi 的 schema
// 校验与执行时的校验（原文、第二行 Correct form、不出卡）、四种工具结果的原文与 isError、details、question.answer 的核对、
// 停止与关闭。pi 的校验用 @earendil-works/pi-ai 的 validateToolArguments（同 memory 工具的单元测试）；
// 工具调用与会话 id 都是手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';
import {
  DB_QUESTION, PARTS_QUESTION, asksOf, awayKit, eventsOf, gateOf, settle, tempDir, textOf,
} from './awayKit.mjs';

/** 校验错误的第二行（§14） */
const CORRECT_FORM = 'Correct form: ask_user_question {"questions":[{"question":"Which database should I use?",'
  + '"header":"Database","options":[{"label":"PostgreSQL","description":"Server database"},'
  + '{"label":"SQLite","description":"Single file"}],"multiSelect":false,"recommended":"PostgreSQL"}]}';
/** 拒绝回答与停止的原文（§12） */
const DECLINED = 'The user declined to answer your questions. Stop what you are doing and wait for the user to tell '
  + 'you how to proceed.';
const STOPPED = 'Not answered: the user stopped the run.';
/** question.answer 对不上问题时的原文（§10.5） */
const MISMATCH = 'Answers don’t match the questions.';

/** @brief 一个用户会话 U 的提问工具。 */
async function askSetup(t, onAnswered) {
  const kit = await awayKit(t);
  return { kit, ...asksOf(kit, 'U', onAnswered) };
}

/** @brief 一个问题，改几个字段（选项可以整组换掉）。 */
function question(over = {}) {
  return { ...structuredClone(DB_QUESTION), ...over };
}

/** @brief 按 pi 的顺序调用一次：validateToolArguments（不合 schema 时抛错，不进执行），再 execute。 */
async function viaPi(tool, args) {
  const valid = validateToolArguments({ name: tool.name, parameters: tool.parameters },
    { type: 'toolCall', id: 'c1', name: tool.name, arguments: args });
  return tool.execute('c1', valid, undefined);
}

// ---- FS-83 注册 ----

test('FS-83 mori-question registers ask_user_question, active by default, with the §14 description and parameters',
  async (t) => {
    const { kit, tool, tools } = await askSetup(t);
    assert.equal(kit.K.ask.QUESTION_EXTENSION, 'mori-question');
    assert.deepEqual([...tools.keys()], ['ask_user_question']);
    assert.equal(tool.defaultActive, true);
    assert.equal(tool.prepareArguments, undefined, 'no argument normalization (§10.2)');
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.equal(tool.description, 'Ask the user 1-4 questions, each with 2-4 options, and wait for the answers. '
      + "Use it when you need the user’s decision or preference to go on: a choice between approaches, a missing "
      + "requirement, or which of several things they meant. Don’t use it for what you can find out yourself, or to "
      + "ask permission to run a tool. The user can always type their own answer instead of picking an option, so "
      + "don’t add an \"Other\" option. Set recommended to the label of the option you would pick; if the user is "
      + "away and doesn’t answer in time, Mori uses it and tells you.");
    const questions = tool.parameters.properties.questions;
    assert.deepEqual(tool.parameters.required, ['questions']);
    assert.deepEqual([questions.minItems, questions.maxItems, questions.description],
      [1, 4, 'The questions, 1-4, shown together on one card in this order.']);
    const item = questions.items;
    assert.deepEqual(item.required.slice().sort(), ['header', 'multiSelect', 'options', 'question', 'recommended']);
    const props = item.properties;
    assert.equal(props.question.description, 'The full question, ending with a question mark.');
    assert.equal(props.header.description, 'A short tag for the question, at most 12 characters, e.g. Database.');
    assert.equal(props.header.maxLength, 12);
    assert.deepEqual([props.options.minItems, props.options.maxItems, props.options.description],
      [2, 4, '2-4 options.']);
    assert.deepEqual(props.options.items.required.slice().sort(), ['description', 'label']);
    assert.equal(props.options.items.properties.label.description, 'What the user picks, in a few words.');
    assert.equal(props.options.items.properties.description.description,
      'What this option means, or what happens if the user picks it.');
    assert.equal(props.multiSelect.description, 'true if the user may pick more than one option.');
    assert.equal(props.recommended.description, 'The label of the option you recommend; it must be one of the labels.');
  });

test('FS-83 the tools page shows Mori as the source of ask_user_question', async (t) => {
  const kit = await awayKit(t);
  const info = { name: 'ask_user_question', sourceInfo: { path: '<inline:mori-question>', origin: 'top-level',
    source: 'local' } };
  assert.deepEqual(kit.K.resources.toolSource(info), { source: 'other', sourceLabel: 'Mori' });
});

// ---- FS-84 免批准 ----

test('FS-84 ask_user_question needs no approval: mori.tool_gate is free, with or without limits or anyone to ask',
  async (t) => {
    const kit = await awayKit(t);
    const cwd = tempDir(t, 'mori-ask-cwd-');
    const { ApprovalPolicy } = kit.K.approval;
    const { PROGRAM_LIMITS, TEAM_DIALOG_LIMITS } = kit.K.limits;
    const cases = [
      ['ask each time', new ApprovalPolicy(), null],
      ['team dialog limits', new ApprovalPolicy(), { owner: 'dialog', limits: TEAM_DIALOG_LIMITS }],
      ['task limits', new ApprovalPolicy(), { owner: 'task', limits: { ...PROGRAM_LIMITS, mcp: false } }],
      ['nobody can approve', new ApprovalPolicy({ mode: 'full', canAsk: false }), null],
    ];
    for (const [name, policy, narrowing] of cases) {
      const sessionId = `S-${name.replace(/ /g, '-')}`;
      const gate = gateOf(kit, policy, { sessionId, cwd, narrowing });
      gate.gate.announce(`${sessionId}-c1`, 'ask_user_question', { questions: [DB_QUESTION] });
      const call = gate.call('ask_user_question', { questions: [DB_QUESTION] });
      assert.equal(await call.result, undefined, name);
      const events = kit.log.filter((item) => item.sessionId === sessionId).map((item) => item.event);
      assert.deepEqual(events, [{ type: 'mori.tool_gate', toolCallId: `${sessionId}-c1`,
        toolName: 'ask_user_question', gate: 'free' }], `${name}: no card, no correction`);
      assert.deepEqual(gate.gate.requests(), []);
    }
  });

// ---- FS-85 参数校验 ----

test('FS-85 pi rejects the call before it runs: 0 or 5 questions, 1 or 5 options, a 13-character header, '
  + 'no recommended', async (t) => {
  const { kit, tool } = await askSetup(t);
  const option = (n) => ({ label: `Option ${n}`, description: 'synthetic' });
  const { recommended, ...noRecommended } = question();
  assert.equal(recommended, 'PostgreSQL');
  const cases = [
    ['no questions', []],
    ['five questions', [1, 2, 3, 4, 5].map((n) => question({ question: `Question ${n}?` }))],
    ['one option', [question({ options: [option(1)], recommended: 'Option 1' })]],
    ['five options', [question({ options: [1, 2, 3, 4, 5].map(option), recommended: 'Option 1' })]],
    ['a 13-character header', [question({ header: 'Database tool' })]],
    ['no recommended', [noRecommended]],
  ];
  for (const [name, questions] of cases) {
    await assert.rejects(viaPi(tool, { questions }), /^Error: Validation failed for tool "ask_user_question":/, name);
  }
  assert.deepEqual(eventsOf(kit.log, 'mori.question_request'), [], 'no card');
  const twelve = { questions: [question({ header: 'Database DBs' })] };
  assert.deepEqual(validateToolArguments({ name: tool.name, parameters: tool.parameters },
    { type: 'toolCall', id: 'c2', name: tool.name, arguments: twelve }), twelve, 'a 12-character header passes');
});

/**
 * @brief 执行时校验不过的一次调用，按 pi 的顺序走（先 validateToolArguments，再 execute）：pi 的 schema 放行它，模型拿到的
 *        是 §14 的原文——isError、第一行原因、第二行 Correct form；不出卡、不登记计时
 *        （调用方先让窗口失焦：登记了的话会立即计时，发 mori.away_timer）。
 */
async function refused(setup, questions, reason, name) {
  const before = setup.kit.log.length;
  const result = await viaPi(setup.tool, { questions });
  assert.equal(result.isError, true, name);
  assert.equal(textOf(result), `${reason}\n${CORRECT_FORM}`, name);
  assert.deepEqual(setup.kit.log.slice(before), [], `${name}: no card, no mori.away_timer`);
  assert.deepEqual(setup.asks.requests(), [], name);
  assert.deepEqual(setup.kit.A.awayTimers('U'), [], `${name}: nothing timing`);
  assert.equal(setup.kit.clock.pending(), 0, `${name}: no timer`);
}

test('FS-85 run-time checks fail the whole call with the §14 text and Correct form, and show no card', async (t) => {
  const setup = await askSetup(t);
  setup.kit.A.setFocus(false);
  const options = (...labels) => labels.map((label) => ({ label, description: 'synthetic' }));
  await refused(setup, [question(), question({ question: 'Which parts?', recommended: 'MySQL' })],
    'Question 2: recommended "MySQL" is not one of its option labels: PostgreSQL, SQLite.', 'recommended');
  await refused(setup, [question({ options: options('API', 'api'), recommended: 'API' })],
    'Question 1: option labels must be different.', 'same labels, any case');
  await refused(setup, [question({ options: options('Yes', 'other'), recommended: 'Yes' })],
    'Question 1: don’t add an "Other" option; the user can always type their own answer.', 'Other as a label');
  await refused(setup, [question(), question({ question: '  Which database should I use?  ' })],
    'Each question must be different.', 'the same question twice');
  await refused(setup, [question({ header: '' })], 'Question 1: header must be 1-12 characters.', 'empty header');
  await refused(setup, [question({ question: 'q'.repeat(501) })], 'Question 1: question must be 1-500 characters.',
    'a 501-character question');
  await refused(setup, [question({ question: '' })], 'Question 1: question must be 1-500 characters.',
    'an empty question');
  await refused(setup, [question({ options: options('l'.repeat(61), 'SQLite'), recommended: 'SQLite' })],
    'Question 1: option label must be 1-60 characters.', 'a 61-character label');
  await refused(setup, [question({ options: [{ label: 'A', description: 'd'.repeat(301) },
    { label: 'B', description: '' }], recommended: 'A' })],
  'Question 1: option description must be at most 300 characters.', 'a 301-character description');
});

test('FS-85 the first question that fails is the one reported; values at the limits are accepted', async (t) => {
  const setup = await askSetup(t);
  setup.kit.A.setFocus(false);
  await refused(setup, [question({ recommended: 'MySQL' }), question({ question: 'Which parts?', header: '' })],
    'Question 1: recommended "MySQL" is not one of its option labels: PostgreSQL, SQLite.', 'question 1 first');
  const edge = question({ question: `${'q'.repeat(499)}?`, header: 'Twelve chars',
    options: [{ label: 'l'.repeat(60), description: 'd'.repeat(300) }, { label: 'SQLite', description: '' }],
    recommended: ` ${'l'.repeat(60)} ` });
  setup.run([edge]);
  await settle();
  const [card] = eventsOf(setup.kit.log, 'mori.question_request');
  assert.ok(card, 'recommended is compared without the surrounding spaces: the card is shown');
});

// ---- FS-87 结果原文 ----

test('FS-87 the card request: ask-<n> per session, the questions in order, askedAt', async (t) => {
  const setup = await askSetup(t);
  const before = Date.now();
  const call = setup.run([DB_QUESTION, PARTS_QUESTION]);
  await settle();
  const [card] = eventsOf(setup.kit.log, 'mori.question_request');
  assert.equal(card.sessionId, 'U');
  assert.deepEqual({ ...card.event, askedAt: 0 }, { type: 'mori.question_request', requestId: 'ask-1',
    toolCallId: call.toolCallId, questions: [DB_QUESTION, PARTS_QUESTION], askedAt: 0 });
  assert.ok(card.event.askedAt >= before);
  const { type, ...payload } = card.event;
  assert.equal(type, 'mori.question_request');
  assert.deepEqual(setup.asks.requests(), [payload], 'LiveSnapshot.asks');
  setup.asks.answer('ask-1', [{ selected: ['SQLite'], other: null }, { selected: ['Docs'], other: null }]);
  await call.result;
  setup.run([DB_QUESTION]);
  await settle();
  assert.deepEqual(eventsOf(setup.kit.log, 'mori.question_request').map((item) => item.event.requestId),
    ['ask-1', 'ask-2']);
});

test('FS-87 the four tool results match §14 word for word; declined and stopped are errors, the others are not',
  async (t) => {
    const setup = await askSetup(t);
    const submitted = setup.run([DB_QUESTION, PARTS_QUESTION]);
    await settle();
    setup.asks.answer('ask-1', [{ selected: ['PostgreSQL'], other: null }, { selected: ['API', 'CLI'], other: null }]);
    const user = await submitted.result;
    assert.equal(textOf(user), 'User has answered your questions: "Which database should I use?"="PostgreSQL", '
      + '"Which parts?"="API, CLI". You can now continue with the user’s answers in mind.');
    assert.notEqual(user.isError, true);
    const away = setup.run([DB_QUESTION]);
    await settle();
    setup.kit.A.setFocus(false);
    setup.kit.clock.advance(300_000);
    const auto = await away.result;
    assert.equal(textOf(auto), "The user was away and didn’t answer within 5 minutes, so your recommended options "
      + 'were used: "Which database should I use?"="PostgreSQL". Continue with them, and mention this in your final '
      + 'summary.');
    assert.notEqual(auto.isError, true);
    setup.kit.A.setFocus(true);
    const declined = setup.run([DB_QUESTION]);
    await settle();
    setup.asks.answer('ask-3', null);
    const no = await declined.result;
    assert.deepEqual([textOf(no), no.isError, no.details], [DECLINED, true, { answers: null, by: 'declined' }]);
    const stopped = setup.run([DB_QUESTION]);
    await settle();
    setup.asks.beginStop();
    setup.asks.endStop();
    const stop = await stopped.result;
    assert.deepEqual([textOf(stop), stop.isError, stop.details], [STOPPED, true, { answers: null, by: 'stop' }]);
    const closed = setup.run([DB_QUESTION]);
    await settle();
    setup.asks.close();
    const close = await closed.result;
    assert.deepEqual([textOf(close), close.isError, close.details], [STOPPED, true, { answers: null, by: 'closed' }]);
    assert.deepEqual(eventsOf(setup.kit.log, 'mori.question_end').map((item) => item.event.by),
      ['user', 'away', 'declined', 'stop', 'closed']);
  });

test('FS-87 details.answers follow the card: labels in option order, the Other text last, auto false', async (t) => {
  const setup = await askSetup(t);
  const call = setup.run([DB_QUESTION, PARTS_QUESTION]);
  await settle();
  setup.asks.answer('ask-1', [{ selected: [], other: 'MariaDB' }, { selected: ['CLI', 'API'], other: 'tests' }]);
  const result = await call.result;
  const answers = [
    { question: 'Which database should I use?', header: 'Database', selected: [], other: 'MariaDB', auto: false },
    { question: 'Which parts?', header: 'Scope', selected: ['API', 'CLI'], other: 'tests', auto: false },
  ];
  assert.deepEqual(result.details, { answers, by: 'user' });
  assert.equal(textOf(result), 'User has answered your questions: "Which database should I use?"="MariaDB", '
    + '"Which parts?"="API, CLI, tests". You can now continue with the user’s answers in mind.');
  const [end] = eventsOf(setup.kit.log, 'mori.question_end');
  assert.deepEqual(end.event, { type: 'mori.question_end', requestId: 'ask-1', toolCallId: call.toolCallId,
    by: 'user', answers });
});

test('FS-87 question.answer fails on a wrong count, an unknown label, two picks for one choice or a blank Other; '
  + 'an ended request is no longer pending', async (t) => {
  const setup = await askSetup(t);
  const call = setup.run([DB_QUESTION, PARTS_QUESTION]);
  await settle();
  const parts = { selected: ['API'], other: null };
  const bad = [
    ['one answer for two questions', [{ selected: ['SQLite'], other: null }]],
    ['three answers', [{ selected: ['SQLite'], other: null }, parts, parts]],
    ['a label that is not an option', [{ selected: ['MySQL'], other: null }, parts]],
    ['two picks for a single choice', [{ selected: ['PostgreSQL', 'SQLite'], other: null }, parts]],
    ['a pick and Other for a single choice', [{ selected: ['SQLite'], other: 'MySQL' }, parts]],
    ['a blank Other', [{ selected: [], other: '   ' }, parts]],
    ['nothing picked in a multi-select', [{ selected: ['SQLite'], other: null }, { selected: [], other: null }]],
    ['an Other over 2000 characters', [{ selected: ['SQLite'], other: null },
      { selected: [], other: 'x'.repeat(2001) }]],
  ];
  for (const [name, answers] of bad) {
    assert.throws(() => setup.asks.answer('ask-1', answers), { message: MISMATCH }, name);
  }
  assert.equal(setup.asks.requests().length, 1, 'the card still waits after a failed answer');
  setup.asks.answer('ask-1', [{ selected: ['SQLite'], other: null }, { selected: [], other: 'x'.repeat(2000) }]);
  assert.equal((await call.result).details.by, 'user');
  assert.throws(() => setup.asks.answer('ask-1', null), { message: 'Question ask-1 is no longer pending' });
  assert.throws(() => setup.asks.answer('ask-9', null), { message: 'Question ask-9 is no longer pending' });
});

test('FS-87 while stopping and after closing a call returns the stop text at once, without a card', async (t) => {
  const setup = await askSetup(t);
  setup.asks.beginStop();
  const during = await setup.run([DB_QUESTION]).result;
  assert.deepEqual([textOf(during), during.isError, during.details.by], [STOPPED, true, 'stop']);
  assert.deepEqual(eventsOf(setup.kit.log, 'mori.question_request'), []);
  setup.asks.endStop();
  const after = setup.run([DB_QUESTION]);
  await settle();
  assert.equal(eventsOf(setup.kit.log, 'mori.question_request').length, 1, 'a card again after endStop');
  const controller = new AbortController();
  controller.abort();
  const aborted = await setup.run([DB_QUESTION], controller.signal).result;
  assert.deepEqual([textOf(aborted), aborted.isError, aborted.details.by], [STOPPED, true, 'closed']);
  setup.asks.close();
  assert.equal((await after.result).details.by, 'closed');
  const late = await setup.run([DB_QUESTION]).result;
  assert.deepEqual([textOf(late), late.isError, late.details.by], [STOPPED, true, 'closed']);
  assert.equal(eventsOf(setup.kit.log, 'mori.question_request').length, 1, 'no card after closing');
});

// ---- FS-90 有答案时交给 Team（提问一侧） ----

test('FS-90 the answer is handed on only when the user or the timeout answered', async (t) => {
  const handed = [];
  const setup = await askSetup(t, (questions, answers) => handed.push({ questions, answers }));
  const ends = [
    ['user', (id) => setup.asks.answer(id, [{ selected: ['SQLite'], other: null }])],
    ['declined', (id) => setup.asks.answer(id, null)],
    ['away', () => {
      setup.kit.A.setFocus(false);
      setup.kit.clock.advance(300_000);
      setup.kit.A.setFocus(true);
    }],
    ['stop', () => {
      setup.asks.beginStop();
      setup.asks.endStop();
    }],
  ];
  for (const [index, [by, end]] of ends.entries()) {
    const call = setup.run([DB_QUESTION]);
    await settle();
    end(`ask-${index + 1}`);
    assert.equal((await call.result).details.by, by);
  }
  assert.deepEqual(handed.map((item) => item.answers[0].selected), [['SQLite'], ['PostgreSQL']]);
  assert.deepEqual(handed.map((item) => item.answers[0].auto), [false, true]);
  assert.deepEqual(handed[0].questions, [DB_QUESTION]);
});
