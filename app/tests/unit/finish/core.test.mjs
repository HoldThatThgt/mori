// 收尾检查的纯函数与 finish 工具的单元测试（docs/specs/finish-check.md §4.1、§5.2–§5.4、§6.1、§6.2、§7、§8.3；
// FC-01、FC-06、FC-07、FC-09、FC-10 的单元部分、FC-19 的 followsCheck 部分）：kernel/finishCheck.ts 与
// shared/finishCheck.ts，经 esbuild 打包导入。给模型看的原文从规格读出逐字比较；pi 的 validateToolArguments 从
// @earendil-works/pi-ai 导入。上下文消息与会话条目都是测试手写的（synthetic，见 kernel-helpers.mjs）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';
import {
  CORE_SOURCE, assistant, call, customMsg, entryOf, loadFinishKernel, messageEntry, say, specBlock, specCheckHead,
  specThirdLines, summaryMsg, toolResult, userMsg,
} from './kernel-helpers.mjs';

const { core: C, shared: S } = await loadFinishKernel();
const RELAY_ONLY = 'Team mode is on: the dialog agent only relays; the work is done in tasks.';

/** @brief synthetic：检查那一行（AgentMessage 形状，内容是不点名分节的那种原文）。 */
const checkMsg = () => customMsg(S.FINISH_CHECK_TYPE, C.checkLine([]));
/** @brief synthetic：工作卡与你不在时的提醒（别的 custom 消息）。 */
const workCard = () => customMsg('mori.work_card', '<work_card>\nRequest 1 (synthetic)\n</work_card>');
const reminder = () => customMsg('mori.away_reminder', '[Mori] The user was away (synthetic).');

/** @brief settleDecision 的结果，三个字段一起比较。 */
function decide(messages) {
  const { check, checks, reason } = C.settleDecision(messages);
  return { check, checks, reason };
}

// ---- FC-01 finish 的定义 ----

test('FC-01 finishTool: name, label, the §7.3 description, parameters, no prepareArguments or prompt text', () => {
  const tool = C.finishTool();
  assert.equal(tool.name, 'finish');
  assert.equal(tool.name, S.FINISH_TOOL);
  assert.equal(tool.label, 'Finish');
  assert.equal(tool.description, specBlock('### 7.3'), 'the description is the §7.3 block word for word');
  assert.equal(tool.description.split('\n')[0], 'Confirm that your last reply is your final reply.');
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(tool.defaultActive, true);
  for (const key of ['prepareArguments', 'promptSnippet', 'promptGuidelines']) {
    assert.equal(key in tool, false, `no ${key}`);
  }
});

test('FC-01 execute returns Confirmed. with terminate true and touches nothing (no runtime import but shared)',
  async () => {
    const tool = C.finishTool();
    const result = await tool.execute('f1', {}, undefined, undefined, undefined);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Confirmed.' }], details: {}, terminate: true });
    assert.equal(C.FINISH_RESULT, 'Confirmed.');
    const again = await tool.execute('f2', {}, new AbortController().signal, () => undefined, {});
    assert.deepEqual(again, result, 'the same result every time, whatever the call');
    const imports = [...CORE_SOURCE.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)];
    assert.ok(imports.length > 0);
    const runtime = imports.filter((match) => match[1] === undefined).map((match) => match[2]);
    assert.deepEqual(runtime, ['../shared/finishCheck'],
      'kernel/finishCheck.ts imports pi only as types and no file-system module (§2)');
  });

test('FC-01 pi validateToolArguments: {} passes, any field is rejected with Validation failed for tool "finish"',
  () => {
    const tool = C.finishTool();
    const validate = (args) => validateToolArguments({ name: tool.name, parameters: tool.parameters },
      { type: 'toolCall', id: 'f1', name: tool.name, arguments: args });
    assert.deepEqual(validate({}), {});
    for (const args of [{ reply: 'x' }, { reply: 'Done.' }, { confirmed: true }]) {
      assert.throws(() => validate(args), (error) => error.message.startsWith('Validation failed for tool "finish"'),
        JSON.stringify(args));
    }
  });

// ---- FC-09 原文 ----

test('FC-09 checkLine: the four variants equal the §7.1 block and table word for word', () => {
  const lines = specBlock('### 7.1').split('\n');
  assert.equal(lines.length, 4);
  const rows = specThirdLines();
  assert.deepEqual(rows.map((row) => row.kinds), [['taste', 'review'], ['taste'], ['review'], []]);
  assert.equal(rows[0].third, lines[2], 'the block shows the taste-and-review variant');
  for (const { kinds, third } of rows) {
    const expected = [lines[0], lines[1], ...(third === null ? [] : [third]), lines[3]].join('\n');
    assert.equal(C.checkLine(kinds), expected, JSON.stringify(kinds));
  }
  assert.equal(C.checkLine([]).split('\n').length, 3, 'no kinds: the third line is left out');
});

test('FC-09 CHECK_LINE_HEAD is the §7.1 value and starts every variant', () => {
  assert.equal(S.CHECK_LINE_HEAD, specCheckHead());
  assert.ok(specBlock('### 7.1').startsWith(S.CHECK_LINE_HEAD));
  for (const kinds of [['taste', 'review'], ['taste'], ['review'], []]) {
    assert.ok(C.checkLine(kinds).startsWith(S.CHECK_LINE_HEAD), JSON.stringify(kinds));
  }
});

test('FC-09 checkBlock: both sections, TASTE only, REVIEW only, and null; the §7.2 form', () => {
  const taste = '- Conclusion first (synthetic)\n- Keep it short (synthetic)';
  const review = '- Run the tests before saying done (synthetic)';
  assert.equal(C.checkBlock({ taste, review }), `<taste>\n${taste}\n</taste>\n<review>\n${review}\n</review>`);
  assert.equal(C.checkBlock({ taste, review: null }), `<taste>\n${taste}\n</taste>`);
  assert.equal(C.checkBlock({ taste: null, review }), `<review>\n${review}\n</review>`);
  assert.equal(C.checkBlock({ taste: null, review: null }), null);
});

// ---- FC-06 决定表 ----

test('FC-06 decision table row 1: no check line after the start -> check (first), checks 0', () => {
  const first = { check: true, checks: 0, reason: 'first' };
  assert.deepEqual(decide([userMsg('hi'), assistant([say('Hello.')])]), first);
  assert.deepEqual(decide([userMsg('fix it'), assistant([call('b1')]), toolResult('b1'), assistant([say('Done.')])]),
    first, 'work before any check does not matter');
  assert.deepEqual(decide([]), first, 'an empty context');
});

test('FC-06 decision table row 2: a lone finish after the check that succeeded -> release (confirmed)', () => {
  const messages = [userMsg('hi'), assistant([say('Hello.')]), checkMsg(), assistant([call('f1', 'finish')]),
    toolResult('f1', 'finish', false, 'Confirmed.')];
  assert.deepEqual(decide(messages), { check: false, checks: 1, reason: 'confirmed' });
  const withText = [userMsg('hi'), assistant([say('Hello.')]), checkMsg(),
    assistant([say('The reply stands.'), call('f1', 'finish')]), toolResult('f1', 'finish', false, 'Confirmed.')];
  assert.deepEqual(decide(withText), { check: false, checks: 1, reason: 'confirmed' },
    'text and finish in one message: still one tool call, a confirmation (fc-a-text)');
});

test('FC-06 decision table row 3: text only, nothing at all, or text after a failed finish -> release (no work)',
  () => {
    const noWork = { check: false, checks: 1, reason: 'no work' };
    const head = () => [userMsg('hi'), assistant([say('Draft answer.')]), checkMsg()];
    assert.deepEqual(decide([...head(), assistant([say('Conclusion first: rewritten answer.')])]), noWork,
      'rewritten (c)');
    assert.deepEqual(decide([...head(), assistant([])]), noWork, 'wrote nothing');
    assert.deepEqual(decide([...head(), assistant([{ type: 'thinking', thinking: 'ok' }])]), noWork, 'only thinking');
    assert.deepEqual(decide(head()), noWork, 'nothing after the check line');
    const failed = [...head(), assistant([call('f1', 'finish', { reply: 'Done.' })]),
      toolResult('f1', 'finish', true, 'Validation failed for tool "finish":\n  - reply: unexpected property'),
      assistant([say('Final reply.')])];
    assert.deepEqual(decide(failed), noWork, 'finish failed, then text (fc-bad-args)');
  });

test('FC-06 decision table row 4: three check lines with work after the third -> release (limit)', () => {
  const messages = [userMsg('go'), assistant([say('Working.')])];
  for (let n = 1; n <= 3; n += 1) {
    messages.push(checkMsg(), assistant([call(`b${n}`)]), toolResult(`b${n}`), assistant([say('Still working.')]));
  }
  assert.deepEqual(decide(messages), { check: false, checks: 3, reason: 'limit' });
  assert.equal(C.FINISH_CHECK_CAP, 3);
});

test('FC-06 decision table row 5: work after the check (one or two checks) -> check (work)', () => {
  const messages = [userMsg('run the tests'), assistant([say("I'll run the tests.")]), checkMsg(),
    assistant([call('b1', 'bash', { command: 'echo fc-b' })]), toolResult('b1'), assistant([say('The tests passed.')])];
  assert.deepEqual(decide(messages), { check: true, checks: 1, reason: 'work' });
  messages.push(checkMsg(), assistant([call('b2')]), toolResult('b2'), assistant([say('Again.')]));
  assert.deepEqual(decide(messages), { check: true, checks: 2, reason: 'work' });
});

test('FC-06 finish and bash in one batch is not a confirmation -> check (work)', () => {
  const messages = [userMsg('hi'), assistant([say('Done.')]), checkMsg(),
    assistant([call('f1', 'finish'), call('b1')]), toolResult('f1', 'finish', false, 'Confirmed.'), toolResult('b1'),
    assistant([say('Done again.')])];
  assert.deepEqual(decide(messages), { check: true, checks: 1, reason: 'work' });
});

test('FC-06 rows are taken in order: confirmed before no work and limit, no work before limit', () => {
  const three = () => {
    const messages = [userMsg('go'), assistant([say('Working.')])];
    for (let n = 1; n <= 3; n += 1) messages.push(checkMsg(), assistant([call(`b${n}`)]), toolResult(`b${n}`));
    return messages;
  };
  assert.deepEqual(decide([...three(), assistant([say('Still working.')])]),
    { check: false, checks: 3, reason: 'limit' }, 'work after the third check line: limit');
  assert.deepEqual(decide([...three(), assistant([call('f9', 'finish')]), toolResult('f9', 'finish')]),
    { check: false, checks: 3, reason: 'confirmed' }, 'work, then a lone finish after the third check: confirmed');
  const quiet = [userMsg('go'), assistant([say('Working.')]), checkMsg(), assistant([call('b1')]), toolResult('b1'),
    checkMsg(), assistant([call('b2')]), toolResult('b2'), checkMsg(), assistant([say('Same reply.')])];
  assert.deepEqual(decide(quiet), { check: false, checks: 3, reason: 'no work' },
    'no work after the third check line: no work comes before limit');
  const workThenFinish = [userMsg('go'), assistant([say('Plan.')]), checkMsg(), assistant([call('b1')]),
    toolResult('b1'), assistant([call('f1', 'finish')]), toolResult('f1', 'finish')];
  assert.deepEqual(decide(workThenFinish), { check: false, checks: 1, reason: 'confirmed' },
    'a lone finish after work in the same check: row 2 comes before row 5');
});

test('FC-06 checks is the number of check lines after the start', () => {
  for (const count of [0, 1, 2, 3, 4]) {
    const messages = [checkMsg(), userMsg('again'), assistant([say('Reply.')])];
    for (let n = 0; n < count; n += 1) messages.push(checkMsg(), assistant([call(`b${n}`)]), toolResult(`b${n}`));
    assert.equal(C.settleDecision(messages).checks, count, `${count} check lines (one before the start)`);
  }
});

// ---- FC-07 边界 ----

test('FC-07 refused, denied, not found, invalid and truncated calls all count as work', () => {
  const failures = [
    ['refused by mori-team', [call('x1', 'bash')], toolResult('x1', 'bash', true, RELAY_ONLY)],
    ['denied in the approval gate', [call('x1', 'bash')], toolResult('x1', 'bash', true, 'Denied by the user.')],
    ['not found', [call('x1', 'deploy')], toolResult('x1', 'deploy', true, 'Tool deploy not found')],
    ['invalid arguments', [call('x1', 'read', { nope: 1 })],
      toolResult('x1', 'read', true, 'Validation failed for tool "read":\n  - path: required')],
  ];
  for (const [label, blocks, result] of failures) {
    const messages = [userMsg('hi'), assistant([say('I will.')]), checkMsg(), assistant(blocks), result,
      assistant([say('Tried.')])];
    assert.deepEqual(decide(messages), { check: true, checks: 1, reason: 'work' }, label);
  }
  const truncated = [userMsg('hi'), assistant([say('I will.')]), checkMsg(),
    assistant([say('Writing'), call('x1', 'write', { path: 'a.md' })], 'length'),
    toolResult('x1', 'write', true, 'Tool call was truncated (synthetic)'), assistant([say('Done.')])];
  assert.deepEqual(decide(truncated), { check: true, checks: 1, reason: 'work' }, "stopReason 'length'");
});

test('FC-07 a finish before the check is not a confirmation; a failed finish is neither work nor confirmation',
  () => {
    const early = [userMsg('hi'), assistant([say('Done.'), call('f0', 'finish')]), toolResult('f0', 'finish')];
    assert.deepEqual(decide(early), { check: true, checks: 0, reason: 'first' }, 'fc-early: checked once anyway');
    assert.deepEqual(decide([...early, checkMsg(), assistant([say('Still done.')])]),
      { check: false, checks: 1, reason: 'no work' }, 'the early finish does not confirm the check after it');
    assert.deepEqual(decide([...early, checkMsg(), assistant([call('f1', 'finish')]), toolResult('f1', 'finish')]),
      { check: false, checks: 1, reason: 'confirmed' }, 'fc-early: the finish after the check confirms');
    const fixed = [userMsg('hi'), assistant([say('Done.')]), checkMsg(),
      assistant([call('f1', 'finish', { reply: 'Done.' })]), toolResult('f1', 'finish', true, 'Validation failed'),
      assistant([say('Final reply.'), call('f2', 'finish')]), toolResult('f2', 'finish', false, 'Confirmed.')];
    assert.deepEqual(decide(fixed), { check: false, checks: 1, reason: 'confirmed' }, 'called right the second time');
    const wrongResult = [userMsg('hi'), assistant([say('Done.')]), checkMsg(), assistant([call('f1', 'finish')]),
      toolResult('f2', 'finish')];
    assert.deepEqual(decide(wrongResult), { check: false, checks: 1, reason: 'no work' },
      'a finish result for another call id does not confirm');
  });

test('FC-07 a queued or steered user message is a new start; only what follows it counts', () => {
  const before = [userMsg('first'), assistant([say('Answer one.')]), checkMsg(), assistant([call('b1')]),
    toolResult('b1'), assistant([say('Answer one, done.')])];
  assert.deepEqual(decide([...before, userMsg('queued (synthetic)'), assistant([say('Answer two.')])]),
    { check: true, checks: 0, reason: 'first' });
  const afterCheck = [userMsg('first'), assistant([say('Answer one.')]), checkMsg(), assistant([call('f1', 'finish')]),
    toolResult('f1', 'finish'), userMsg('queued while checking'), assistant([say('Answer two.')]), checkMsg(),
    assistant([call('f2', 'finish')]), toolResult('f2', 'finish')];
  assert.deepEqual(decide(afterCheck), { check: false, checks: 1, reason: 'confirmed' },
    'the check of the previous message is not counted');
});

test('FC-07 a check line left by the previous run sits before your new message and does not count', () => {
  const messages = [userMsg('first'), assistant([say('Answer.')]), checkMsg(), userMsg('next'),
    assistant([say('Next answer.')])];
  assert.deepEqual(decide(messages), { check: true, checks: 0, reason: 'first' });
});

test('FC-07 no user message (after a compaction): count from the beginning, the cap too', () => {
  assert.deepEqual(decide([summaryMsg(), assistant([say('Answer.')])]), { check: true, checks: 0, reason: 'first' });
  assert.deepEqual(decide([summaryMsg(), assistant([say('Answer.')]), checkMsg(), assistant([call('f1', 'finish')]),
    toolResult('f1', 'finish')]), { check: false, checks: 1, reason: 'confirmed' });
  const lost = [summaryMsg(), checkMsg(), assistant([call('b1')]), toolResult('b1'), assistant([say('Done.')])];
  assert.deepEqual(decide(lost), { check: true, checks: 1, reason: 'work' },
    'an older check line in the summary is lost');
});

test('FC-07 reminders, compaction summaries and other non-user messages neither count nor move the start', () => {
  const withReminder = [userMsg('hi'), assistant([say('Done.')]), checkMsg(), reminder(),
    assistant([call('f1', 'finish')]), toolResult('f1', 'finish')];
  assert.deepEqual(decide(withReminder), { check: false, checks: 1, reason: 'confirmed' });
  const others = [userMsg('hi'), assistant([say('Done.')]), summaryMsg(), checkMsg(), workCard(),
    { role: 'branchSummary', summary: 'Other branch (synthetic)', fromId: 'e1', timestamp: 1 },
    { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, timestamp: 2 },
    assistant([say('Same reply.')])];
  assert.deepEqual(decide(others), { check: false, checks: 1, reason: 'no work' });
  const thirdParty = [userMsg('hi'), assistant([say('Done.')]), checkMsg(), assistant([call('f1', 'finish')]),
    toolResult('f1', 'finish'), customMsg('other.extension', 'Wake up (synthetic)'), assistant([say('Woke up.')])];
  assert.deepEqual(decide(thirdParty), { check: false, checks: 1, reason: 'confirmed' },
    'a run started by a third-party custom message counts on from the user message before it (§0 decision 1)');
});

test('FC-07 unreadable message shapes are not tool calls and never throw', () => {
  const odd = [userMsg('hi'), { role: 'assistant', content: 'plain string reply' }, checkMsg(),
    { role: 'assistant' }, { role: 'assistant', content: [null, 7, { type: 'toolCall', id: 'f1', name: 'finish' }] },
    { role: 'toolResult', toolCallId: 'f1', toolName: 'finish' }];
  assert.deepEqual(decide(odd), { check: false, checks: 1, reason: 'confirmed' });
  assert.deepEqual(decide([userMsg('hi'), checkMsg(), { role: 'assistant', content: { type: 'toolCall' } }]),
    { check: false, checks: 1, reason: 'no work' });
});

// ---- FC-10 检查那次请求（单元部分） ----

test('FC-10 checkRequestIndex finds the check line at the end, also before reminders and the work card', () => {
  const head = [userMsg('hi'), assistant([say('Done.')])];
  const cases = [
    ['check line', [checkMsg()]],
    ['check line, work card', [checkMsg(), workCard()]],
    ['check line, reminder', [checkMsg(), reminder()]],
    ['check line, reminder, work card', [checkMsg(), reminder(), workCard()]],
  ];
  for (const [label, tail] of cases) {
    assert.equal(C.checkRequestIndex([...head, ...tail]), head.length, label);
  }
});

test('FC-10 checkRequestIndex is -1 after a tool result, your new message, an assistant message or nothing', () => {
  const cases = [
    ['tool result', [userMsg('hi'), assistant([say('Done.')]), checkMsg(), assistant([call('b1')]),
      toolResult('b1'), workCard()]],
    ['your new message after an old check line', [userMsg('hi'), assistant([say('Done.')]), checkMsg(),
      userMsg('next')]],
    ['an assistant message', [userMsg('hi'), checkMsg(), assistant([say('Again.')])]],
    ['only a work card', [userMsg('hi'), assistant([say('Done.')]), workCard()]],
    ['empty', []],
  ];
  for (const [label, messages] of cases) assert.equal(C.checkRequestIndex(messages), -1, label);
});

test('FC-10 withCheckBlock: a new message at index with the block after a blank line; input unchanged', () => {
  const line = C.checkLine(['taste']);
  const check = customMsg(S.FINISH_CHECK_TYPE, line);
  const card = workCard();
  const messages = [userMsg('hi'), assistant([say('Done.')]), check, card];
  const block = '<taste>\n- Conclusion first (synthetic)\n</taste>';
  const out = C.withCheckBlock(messages, 2, block);
  assert.notEqual(out, messages);
  assert.equal(out.length, 4);
  assert.deepEqual(out[2], { ...check, content: `${line}\n\n${block}` });
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  assert.equal(out[3], card, 'the work card stays last, the same message');
  assert.equal(check.content, line, 'the input message is not changed');
  assert.equal(messages[2], check);
});

test('FC-10 withCheckBlock: block-array content gets one text block; no index or no block returns the input', () => {
  const check = customMsg(S.FINISH_CHECK_TYPE, [{ type: 'text', text: 'line (synthetic)' }]);
  const out = C.withCheckBlock([check], 0, '<review>\n- R\n</review>');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'line (synthetic)' },
    { type: 'text', text: '\n\n<review>\n- R\n</review>' }]);
  assert.equal(check.content.length, 1);
  const messages = [userMsg('hi'), checkMsg()];
  assert.equal(C.withCheckBlock(messages, -1, '<taste>\n- T\n</taste>'), messages);
  assert.equal(C.withCheckBlock(messages, 1, null), messages);
});

// ---- FC-19 followsCheck ----

const checkEntry = () => entryOf('custom_message', { customType: S.FINISH_CHECK_TYPE, content: C.checkLine([]),
  display: false });
const reminderEntry = () => entryOf('custom_message', { customType: 'mori.away_reminder', content: 'x',
  display: false });
const errorEntry = (text = '') => messageEntry(assistant(text ? [say(text)] : [], 'error'));
const systemEntry = () => messageEntry({ role: 'system', content: 'Tools changed (synthetic).', timestamp: 1 });
const compactionEntry = () => entryOf('compaction', { summary: 'Summary (synthetic).', firstKeptEntryId: null,
  tokensBefore: 9000 });

test('FC-19 followsCheck is true right after the check line, past reminders, system patches and compactions', () => {
  const cases = [
    ['[check line]', [checkEntry()]],
    ['[check line, reminder]', [checkEntry(), reminderEntry()]],
    ['[check line, error]', [checkEntry(), errorEntry('Half a sen')]],
    ['[check line, system, error]', [checkEntry(), systemEntry(), errorEntry()]],
    ['[check line, compaction, error]', [checkEntry(), compactionEntry(), errorEntry()]],
    ['entries outside the context in between', [checkEntry(), entryOf('custom', { customType: 'mori.model_switch',
      data: {} }), entryOf('model_change', { provider: 'p', modelId: 'm' }), entryOf('thinking_level_change',
      { thinkingLevel: 'low' }), entryOf('label', { targetId: 'e1', label: 'x' }), entryOf('session_info',
      { name: 'x' }), errorEntry()]],
  ];
  const before = [messageEntry(userMsg('hi')), messageEntry(assistant([say('Done.')]))];
  for (const [label, tail] of cases) assert.equal(C.followsCheck([...before, ...tail]), true, label);
});

test('FC-19 followsCheck is false after a tool result, your message, a branch summary or nothing', () => {
  const cases = [
    ['[tool result, compaction, error]', [checkEntry(), messageEntry(assistant([call('b1')])),
      messageEntry(toolResult('b1')), compactionEntry(), errorEntry()]],
    ['your message', [messageEntry(userMsg('hi'))]],
    ['your message, error (the first request failed)', [messageEntry(userMsg('hi')), errorEntry()]],
    ['an old check line, your message, error', [checkEntry(), messageEntry(userMsg('next')), errorEntry()]],
    ['an assistant reply', [checkEntry(), messageEntry(assistant([say('Done.')]))]],
    ['a branch summary', [checkEntry(), entryOf('branch_summary', { summary: 'x', fromId: 'e1' }), errorEntry()]],
    ['empty', []],
  ];
  for (const [label, branch] of cases) assert.equal(C.followsCheck(branch), false, label);
});
