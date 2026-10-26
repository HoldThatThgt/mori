// mori-memory 里的收尾检查的单元测试（docs/specs/finish-check.md §4.2、§5.1、§6、§7.4、§9.3；FC-02、FC-05、FC-08、
// FC-09、FC-10 的单元部分、FC-22 的 mori-memory 部分）：真实的 memorySetup 与 memoryExtension 注册在扩展 API 的替身上
// （tests/unit/memory/text-helpers.mjs 的 fakePi，synthetic），记忆条目经记忆模块写进临时 userData（synthetic），
// system prompt 的分节用 pi 1.3.0 的 buildSystemPromptSections 渲染。边界事件、context 事件与上下文消息都是测试手写的
// （synthetic，形状照 pi 的 AgentBeforeSettleEvent、ContextEvent 与 AgentMessage）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOOLS, PAGE, agentStart, fakePi, freshUserData, loadTextKernel, ok, piPrompt, registeredPrompt,
} from '../memory/text-helpers.mjs';
import { loadKernelModule } from '../load.mjs';
import { assistant, call, customMsg, loadFinishKernel, say, toolResult, userMsg } from './kernel-helpers.mjs';

const K = await loadTextKernel();
const { core: C, shared: S } = await loadFinishKernel();
const CTX = { sessionManager: { getSessionId: () => 'fc-session' }, cwd: 'D:\\shop' };
const POSITION = () => ({ session: null, entry: null, title: 'Untitled session' });
const MAIN = () => K.assemble.userRunSeats('off', false);
const DIALOG = () => K.assemble.userRunSeats('always', false);
const CHECK_HANDLERS = ['agent_before_settle', 'context', 'agent_settled'];

/** synthetic：两层都有 taste 与 review，另有 strategy、fact（不进检查块） */
const BOTH = [['user', 'taste', 'U taste (synthetic)'], ['project', 'taste', 'P taste (synthetic)'],
  ['user', 'review', 'U review (synthetic)'], ['project', 'review', 'P review (synthetic)'],
  ['project', 'strategy', 'P strategy (synthetic)'], ['user', 'fact', 'U fact (synthetic)']];
/** synthetic：只有 review */
const REVIEW_ONLY = [['project', 'review', 'P review (synthetic)']];
/** synthetic：没有 taste、review */
const NEITHER = [['project', 'strategy', 'P strategy (synthetic)'], ['user', 'fact', 'U fact (synthetic)']];

/** @brief 记忆页写入条目（synthetic）。 */
async function remember(cwd, items) {
  for (const [layer, kind, abstract] of items) {
    ok(await K.memory.save(PAGE, { cwd, layer, kind, abstract, detail: '', evidence: [] }));
  }
}

/**
 * @brief 一个用户会话的 mori-memory（真实的 memorySetup 与 memoryExtension）在替身 API 上；pi 建会话时启用 defaultActive
 *        的扩展工具，这里显式加上。
 * @param t node:test 的测试上下文
 * @param options items：会话打开前写的记忆条目；seats：这次运行的身份；spec：会话的记忆设置（默认带一个新的 link）
 * @return 设置、API、link，以及按 pi 的形状发 before_agent_start、agent_before_settle、context、agent_settled 的函数
 */
async function checkSession(t, { items = BOTH, seats = MAIN, spec = undefined } = {}) {
  const { cwd } = freshUserData(t, K);
  await remember(cwd, items);
  const link = { pendingTokens: 0 };
  const setup = await K.ext.memorySetup({ cwd, kind: 'user', spec: spec ?? { enhance: null, check: link }, seats,
    position: POSITION });
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  api.setActiveTools([...api.getActiveTools(), ...api.tools.keys()]);
  const start = () => {
    const event = agentStart({ cwd, selectedTools: api.getActiveTools(),
      ...registeredPrompt(cwd, [...api.tools.values()]) });
    api.handlers.get('before_agent_start')(event);
    return { options: event.systemPromptOptions,
      rendered: piPrompt.buildSystemPromptSections(event.systemPromptOptions) };
  };
  const settle = (messages, over = {}) => api.handlers.get('agent_before_settle')({ type: 'agent_before_settle',
    entries: [], continue: false, outcome: 'completed', context: { contextEntries: [], contextMessages: messages,
      llmMessages: [], pendingMessages: [], canContinue: true }, ...over }, CTX);
  const context = (messages) => api.handlers.get('context')({ type: 'context', messages }, CTX);
  const settled = (aborted = false) => api.handlers.get('agent_settled')({ type: 'agent_settled', aborted }, CTX);
  return { cwd, setup, api, link, start, settle, context, settled };
}

/** @brief pi 渲染的 <taste>、<review> 两段按 §7.2 接起来；都没有时为 null。 */
function renderedBlock(rendered) {
  const parts = [rendered.taste, rendered.review].filter((part) => part !== undefined);
  return parts.length === 0 ? null : parts.join('\n');
}

/** @brief 检查块（连同前面的空行）的 token 估算：字符数 ÷ 4 向上取整（§6.3、§12），独立算出。 */
function tokensOf(block) {
  return block === null ? 0 : Math.ceil(`\n\n${block}`.length / 4);
}

/** @brief 一次运行的上下文：你的消息与一段文字回复（synthetic）。 */
const replied = () => [userMsg('fix the login page'), assistant([say('Fixed the login page.')])];
/** @brief synthetic：检查那一行（AgentMessage 形状）。 */
const checkMsg = (content) => customMsg(S.FINISH_CHECK_TYPE, content);
/** @brief synthetic：工作卡。 */
const workCard = () => customMsg('mori.work_card', '<work_card>\nRequest 1 (synthetic)\n</work_card>');

// ---- FC-02 哪些会话有 finish（mori-memory 部分；实例见 extension-instances.test.mjs） ----

test('FC-02 a user session keeps its link: memorySetup copies it, finish and the three handlers are registered',
  async (t) => {
    for (const seats of [MAIN, DIALOG, () => K.assemble.userRunSeats('always', true)]) {
      const session = await checkSession(t, { seats });
      assert.equal(session.setup.check, session.link, 'the same object the session table holds');
      const finish = session.api.tools.get('finish');
      assert.ok(finish, 'finish is registered');
      assert.deepEqual({ ...finish, execute: undefined }, { ...C.finishTool(), execute: undefined });
      for (const name of ['before_agent_start', ...CHECK_HANDLERS, 'tool_call']) {
        assert.ok(session.api.handlers.has(name), `${name} handler`);
      }
      assert.ok(session.api.tools.has('memory'), 'memory is still registered');
    }
  });

test('FC-02 an enhancement session (check null, as startUser gives it) has no finish and no check handlers',
  async (t) => {
    const enhance = { task: 'review', run: { id: 'r1', cwd: 'D:\\shop', task: 'review', day: '2026-10-27' },
      scope: { sessions: [], instanceFiles: [], feedback: [] } };
    const session = await checkSession(t, { spec: { enhance, check: null } });
    assert.equal(session.setup.check, null);
    assert.equal(session.setup.enhancement, true);
    assert.ok(!session.api.tools.has('finish'));
    for (const name of CHECK_HANDLERS) assert.ok(!session.api.handlers.has(name), `no ${name} handler`);
    assert.ok(session.api.handlers.has('before_agent_start') && session.api.handlers.has('tool_call'));
    assert.ok(session.api.tools.has('memory'), 'the enhancement caller keeps memory');
  });

// ---- FC-05 system prompt 不变 ----

test('FC-05 the identity <tools> and <rules> are the same with finish registered and enabled: no snippet',
  async (t) => {
    const withCheck = await checkSession(t);
    assert.deepEqual(withCheck.api.getActiveTools(), [...DEFAULT_TOOLS, 'memory', 'finish'],
      'the request tools have finish');
    const without = await checkSession(t, { spec: { enhance: null } });
    assert.deepEqual(without.api.getActiveTools(), [...DEFAULT_TOOLS, 'memory']);
    const mine = withCheck.start().options.customPrompt;
    assert.equal(mine, without.start().options.customPrompt, 'the identity section is the same word for word');
    const input = { selectedTools: withCheck.api.getActiveTools(), hiddenTools: [], promptGuidelines: [],
      ...registeredPrompt(withCheck.cwd, [...withCheck.api.tools.values()]) };
    assert.equal(input.toolSnippets.finish, undefined, 'finish has no snippet');
    assert.equal(input.toolGuidelines.finish, undefined, 'finish has no guidelines');
    const pi = piPrompt.buildSystemPromptSections({ cwd: withCheck.cwd, ...input });
    assert.equal(`<tools>\n${K.text.renderToolsSection(input)}\n</tools>`, pi.tools, 'the same <tools> as pi');
    assert.equal(`<rules>\n${K.text.renderRulesSection(input)}\n</rules>`, pi.rules, 'the same <rules> as pi');
    assert.ok(!pi.tools.includes('finish') && !pi.rules.includes('finish'));
    assert.ok(mine.includes(pi.tools) && mine.includes(pi.rules));
  });

// ---- FC-08 处理器 ----

test('FC-08 outcome error or aborted: the handler returns undefined, logs nothing, leaves pendingTokens', async (t) => {
  const session = await checkSession(t);
  session.start();
  const log = t.mock.method(console, 'log', () => undefined);
  for (const outcome of ['error', 'aborted']) {
    assert.equal(session.settle(replied(), { outcome }), undefined, outcome);
  }
  assert.equal(log.mock.callCount(), 0);
  assert.equal(session.link.pendingTokens, 0);
});

test('FC-08 a check keeps event.entries, then appends the check line; continue true; no details', async (t) => {
  const session = await checkSession(t);
  session.start();
  t.mock.method(console, 'log', () => undefined);
  const before = { type: 'custom_message', customType: 'other.extension', content: 'x (synthetic)', display: false };
  const result = session.settle(replied(), { entries: [before] });
  assert.deepEqual(Object.keys(result).sort(), ['continue', 'entries']);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0], before, "the earlier handler's entry stays first, unchanged");
  const line = result.entries[1];
  assert.deepEqual(line, { type: 'custom_message', customType: 'mori.finish_check',
    content: C.checkLine(['taste', 'review']), display: false });
  assert.equal(line.customType, S.FINISH_CHECK_TYPE);
  assert.equal('details' in line, false, 'no details');
});

test('FC-08 the line uses the kinds recorded when the run started; the next run follows the new mode', async (t) => {
  let mode = 'off';
  const session = await checkSession(t, { seats: () => K.assemble.userRunSeats(mode, false) });
  t.mock.method(console, 'log', () => undefined);
  const off = session.start().rendered;
  mode = 'always';
  const first = session.settle(replied()).entries.at(-1).content;
  assert.equal(first, C.checkLine(['taste', 'review']), 'the mode changed during the run: this run keeps both');
  const request = [...replied(), checkMsg(first)];
  assert.equal(session.context(request).messages.at(-1).content, `${first}\n\n${renderedBlock(off)}`);
  session.settled();
  const team = session.start().rendered;
  assert.equal(team.review, undefined, 'the dialog seat has no review');
  const next = session.settle(replied()).entries.at(-1).content;
  assert.equal(next, C.checkLine(['taste']), 'the next run follows the mode');
  assert.equal(session.context([...replied(), checkMsg(next)]).messages.at(-1).content,
    `${next}\n\n${team.taste}`);
});

test('FC-08 pendingTokens at the check equals the run blockTokens (the block with its blank line, chars / 4 up)',
  async (t) => {
    const session = await checkSession(t);
    const { rendered } = session.start();
    t.mock.method(console, 'log', () => undefined);
    session.settle(replied());
    const block = renderedBlock(rendered);
    assert.equal(session.link.pendingTokens, tokensOf(block));
    assert.ok(session.link.pendingTokens > 0);
    const sections = { taste: '- T (synthetic)', strategy: '- S (synthetic)', review: null, facts: '- F (synthetic)' };
    assert.deepEqual(K.ext.checkRunOf(sections), { kinds: ['taste'], block: '<taste>\n- T (synthetic)\n</taste>',
      blockTokens: tokensOf('<taste>\n- T (synthetic)\n</taste>') }, 'strategy and facts are not in the block');
    assert.deepEqual(K.ext.checkRunOf({ taste: null, strategy: '- S', review: null, facts: null }),
      { kinds: [], block: null, blockTokens: 0 });
  });

test('FC-08 the §7.4 log lines: finish check <n> (<reason>) at a check, finish check passed (<reason>) at a release',
  async (t) => {
    const session = await checkSession(t);
    session.start();
    const log = t.mock.method(console, 'log', () => undefined);
    const context = replied();
    const line = session.settle(context).entries.at(-1).content;
    context.push(checkMsg(line), assistant([call('b1')]), toolResult('b1'), assistant([say('Tests pass.')]));
    session.settle(context);
    context.push(checkMsg(line), assistant([call('f1', 'finish')]), toolResult('f1', 'finish', false, 'Confirmed.'));
    session.settle(context);
    session.settle([...replied(), checkMsg(line), assistant([say('Rewritten.')])]);
    const capped = replied();
    for (let n = 1; n <= 3; n += 1) capped.push(checkMsg(line), assistant([call(`c${n}`)]), toolResult(`c${n}`));
    session.settle(capped);
    session.settle(replied(), { outcome: 'error' });
    const lines = log.mock.calls.map((each) => each.arguments.join(' ')).filter((text) => text.includes('finish'));
    assert.deepEqual(lines, [
      '[kernel] fc-session: finish check 1 (first)',
      '[kernel] fc-session: finish check 2 (work)',
      '[kernel] fc-session: finish check passed (confirmed)',
      '[kernel] fc-session: finish check passed (no work)',
      '[kernel] fc-session: finish check passed (limit)',
    ]);
  });

test('FC-08 setup.check null or absent: no finish and no agent_before_settle, context or agent_settled handler',
  async (t) => {
    for (const spec of [{ enhance: null, check: null }, { enhance: null }]) {
      const session = await checkSession(t, { spec });
      assert.equal(session.setup.check, null, JSON.stringify(spec));
      assert.ok(!session.api.tools.has('finish'));
      for (const name of CHECK_HANDLERS) assert.ok(!session.api.handlers.has(name), `no ${name} handler`);
      assert.ok(session.api.handlers.has('before_agent_start'), 'the identity section is still written');
    }
  });

// ---- FC-09 检查块与 system prompt 的分节同一写法 ----

test('FC-09 the block equals the <taste> and <review> pi renders from the same snapshot; four variants', async (t) => {
  const variants = [
    ['both', BOTH, MAIN, ['taste', 'review']],
    ['TASTE only (dialog seat)', BOTH, DIALOG, ['taste']],
    ['REVIEW only', REVIEW_ONLY, MAIN, ['review']],
    ['neither', NEITHER, MAIN, []],
  ];
  t.mock.method(console, 'log', () => undefined);
  for (const [label, items, seats, kinds] of variants) {
    const session = await checkSession(t, { items, seats });
    const { options, rendered } = session.start();
    const block = renderedBlock(rendered);
    assert.equal(C.checkBlock({ taste: options.sections.taste ?? null, review: options.sections.review ?? null }),
      block, `${label}: checkBlock of the sections written for this run gives what pi renders`);
    const line = session.settle(replied()).entries.at(-1).content;
    assert.equal(line, C.checkLine(kinds), `${label}: the line names only the sections in the block`);
    const out = session.context([...replied(), checkMsg(line)]);
    if (kinds.length === 0) {
      assert.equal(block, null, label);
      assert.equal(out, undefined, `${label}: no block, the request is not changed`);
    } else {
      assert.equal(out.messages.at(-1).content, `${line}\n\n${block}`, label);
    }
  }
});

// ---- FC-10 检查那次请求（单元部分） ----

test('FC-10 the context handler attaches the block to the check line only; one message; the work card stays last',
  async (t) => {
    const session = await checkSession(t);
    const block = renderedBlock(session.start().rendered);
    t.mock.method(console, 'log', () => undefined);
    const line = session.settle(replied()).entries.at(-1).content;
    const check = checkMsg(line);
    const card = workCard();
    const request = [...replied(), check, card];
    const out = session.context(request).messages;
    assert.equal(out.length, request.length, 'no message is added: the block is in the check line itself');
    assert.deepEqual(out[2], { ...check, content: `${line}\n\n${block}` });
    assert.equal(out.at(-1), card, 'the work card is still the last message');
    assert.equal(out[0], request[0]);
    assert.equal(check.content, line, 'the message the handler got is not changed (the session entry stays plain)');
    const after = [...replied(), check, assistant([call('f1', 'finish')]), toolResult('f1', 'finish'), card];
    assert.equal(session.context(after), undefined, 'the request after finish: the line stays plain');
    assert.equal(session.context([...replied(), check, userMsg('next question')]), undefined,
      'your next message after it: the line stays plain');
  });

test('FC-10 the block is the snapshot taken when the session opened, not entries added on the Memory page afterwards',
  async (t) => {
    const session = await checkSession(t);
    await remember(session.cwd, [['project', 'taste', 'ADDED AFTER OPEN (synthetic)'],
      ['project', 'review', 'ADDED REVIEW (synthetic)']]);
    const block = renderedBlock(session.start().rendered);
    t.mock.method(console, 'log', () => undefined);
    const line = session.settle(replied()).entries.at(-1).content;
    const content = session.context([...replied(), checkMsg(line)]).messages.at(-1).content;
    assert.equal(content, `${line}\n\n${block}`);
    assert.doesNotMatch(content, /ADDED/);
  });

// ---- FC-22 窗口估算（mori-memory 部分） ----

test('FC-22 pendingTokens: blockTokens after a check, 0 after the next context handler and after agent_settled',
  async (t) => {
    const session = await checkSession(t);
    const expected = tokensOf(renderedBlock(session.start().rendered));
    t.mock.method(console, 'log', () => undefined);
    assert.equal(session.link.pendingTokens, 0, 'before any check');
    const context = replied();
    const line = session.settle(context).entries.at(-1).content;
    assert.equal(session.link.pendingTokens, expected, 'after the check, before the context handler');
    context.push(checkMsg(line));
    session.context(context);
    assert.equal(session.link.pendingTokens, 0, 'the check request has the block in its messages');
    context.push(assistant([call('b1')]), toolResult('b1'), assistant([say('Done.')]));
    session.settle(context);
    assert.equal(session.link.pendingTokens, expected, 'the second check');
    session.settled(true);
    assert.equal(session.link.pendingTokens, 0, 'agent_settled before the check request reached the context hook');
    context.push(checkMsg(line), assistant([call('f1', 'finish')]), toolResult('f1', 'finish'));
    assert.equal(session.settle(context), undefined, 'a release');
    assert.equal(session.link.pendingTokens, 0, 'a release leaves it at 0');
    session.link.pendingTokens = 99;
    session.context([...replied()]);
    assert.equal(session.link.pendingTokens, 0, 'any request clears it before the request goes out');
  });

test('FC-22 a run without TASTE and REVIEW sets pendingTokens 0 at its check', async (t) => {
  const session = await checkSession(t, { items: NEITHER });
  session.start();
  t.mock.method(console, 'log', () => undefined);
  session.link.pendingTokens = 5;
  assert.equal(session.settle(replied()).continue, true);
  assert.equal(session.link.pendingTokens, 0);
});

test('FC-22 extraContextTokens of a user session: card + blockTokens after a check, card after context and settled',
  async (t) => {
    const { userCheckWiring } = await loadKernelModule('src/kernel/sessions.ts');
    const CARD = 20;
    const wiring = userCheckWiring(false, () => CARD);
    assert.deepEqual(wiring.check, { pendingTokens: 0 }, 'a user session gets a link');
    const session = await checkSession(t, { spec: { enhance: null, check: wiring.check } });
    assert.equal(session.setup.check, wiring.check, 'mori-memory holds the same object the estimate reads');
    const block = tokensOf(renderedBlock(session.start().rendered));
    assert.ok(block > 0);
    t.mock.method(console, 'log', () => undefined);
    assert.equal(wiring.extraContextTokens(), CARD, 'before any check: the work card only');
    const context = replied();
    const line = session.settle(context).entries.at(-1).content;
    assert.equal(wiring.extraContextTokens(), CARD + block, 'after the check, before the context handler');
    session.context([...context, checkMsg(line)]);
    assert.equal(wiring.extraContextTokens(), CARD, 'the check request carries the block in its messages');
    context.push(checkMsg(line), assistant([call('b1')]), toolResult('b1'), assistant([say('Done.')]));
    session.settle(context);
    assert.equal(wiring.extraContextTokens(), CARD + block, 'the second check');
    session.settled(true);
    assert.equal(wiring.extraContextTokens(), CARD, 'agent_settled clears it before the next run prepares');
    const enhance = userCheckWiring(true, () => CARD);
    assert.equal(enhance.check, null, 'the enhancement session has no link');
    assert.equal(enhance.extraContextTokens(), CARD, 'and its estimate is the work card only');
  });
