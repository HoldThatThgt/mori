// 合成端点（tests/fake-endpoint/）收尾检查部分的单元测试（docs/specs/finish-check.md §14.1、§14.2 FC-26）：
// 认出检查请求（checkPlan）、检查请求的默认回应、fc 场景只在请求的 tools 有 finish 时生效、fc-* 场景的步骤、
// 检查那一行不算投递（sessionOf 的 k、j）、日志的 check 与 checks，以及 CHECK_LINE_HEAD 与 src/shared/finishCheck.ts 相同。
// 只 import scripts.mjs 与 finish.mjs，不 import server.mjs（它在载入时就开始监听）；server.mjs 的判断顺序、加思考的钩子
// （-replay、-alwaysthink、-nooff）与日志行另起一份端点子进程发请求核对（同 selfcheck.mjs 的做法）。
// fc 场景的走法由替身驱动（synthetic）：按 pi 的规则接工具结果（一批全带 terminate 才停），运行要结束时用内核的
// settleDecision 决定加不加检查那一行。请求体、消息与工具结果都是测试手写的（synthetic）。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';
import * as scripts from '../../fake-endpoint/scripts.mjs';
import * as finish from '../../fake-endpoint/finish.mjs';

const shared = await loadKernelModule('src/shared/finishCheck.ts');
const kernel = await loadKernelModule('src/kernel/finishCheck.ts');
const appRoot = resolve(import.meta.dirname, '..', '..', '..');
const SERVER = join(appRoot, 'tests', 'fake-endpoint', 'server.mjs');
const SPEC = join(appRoot, '..', 'docs', 'specs', 'finish-check.md');

// ---- 请求体（OpenAI 形状，synthetic） ----

const SYSTEM = { role: 'system', content: 'You are Mori (synthetic).' };
const LINE = kernel.checkLine(['taste', 'review']);
const BLOCK = kernel.checkBlock({ taste: '- Lead with the conclusion.',
  review: '- Run the tests before saying done.' });
const CARD = `${scripts.WORK_CARD_OPEN}\nYou are chat in team mode (synthetic).\n${scripts.WORK_CARD_CLOSE}`;
/** @brief 一个工具定义。 */
const fn = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });
const TOOLS = ['read', 'bash', 'finish'].map(fn);
const NO_FINISH = ['read', 'bash'].map(fn);
const user = (content) => ({ role: 'user', content });
const said = (text) => ({ role: 'assistant', content: text });
const called = (id, name, args = {}) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, text) => ({ role: 'tool', tool_call_id: id, content: text });
/** @brief 对话请求体：system 在前。 */
const bodyOf = (messages, tools = TOOLS, extra = {}) => ({ model: 'fake-coder', stream: true,
  messages: [SYSTEM, ...messages], tools, ...extra });
/** @brief finishReply 按 sessionOf 的结果回答（同 server.mjs 的 conversationPlan）。 */
const replyOf = (body, flags = new Set()) => finish.finishReply(body, flags, scripts.sessionOf(body.messages));
/** 检查请求的默认回应 */
const DEFAULT_REPLY = { reply: { text: '', toolCalls: [{ name: 'finish', args: {} }], delayMs: 0 } };

test('FC-26 CHECK_LINE_HEAD and FINISH_TOOL equal src/shared/finishCheck.ts; every check line starts with it', () => {
  assert.equal(scripts.CHECK_LINE_HEAD, shared.CHECK_LINE_HEAD);
  assert.equal(finish.FINISH_TOOL, shared.FINISH_TOOL);
  for (const kinds of [['taste', 'review'], ['taste'], ['review'], []]) {
    assert.ok(kernel.checkLine(kinds).startsWith(scripts.CHECK_LINE_HEAD), kinds.join());
  }
});

test('FC-26 checkPlan recognizes a trailing check line, one followed by a work card and one with a switch note', () => {
  const base = [user('Fix the login page'), said('Done.')];
  const cases = {
    'check line': [...base, user(LINE)],
    'check line with the check block': [...base, user(`${LINE}\n\n${BLOCK}`)],
    'content parts': [...base, user([{ type: 'text', text: LINE }, { type: 'text', text: `\n\n${BLOCK}` }])],
    'leading whitespace': [...base, user(`\n  ${LINE}`)],
    'followed by a work card': [...base, user(LINE), user(CARD)],
    'model switch note at the end': [...base, user(`${LINE}\n\n[Mori] The previous model stopped (synthetic).`)],
  };
  for (const [name, messages] of Object.entries(cases)) {
    assert.deepEqual(finish.checkPlan(bodyOf(messages)), { check: true, checks: 1 }, name);
  }
});

test('FC-26 checkPlan does not take a quoted check line, a work card or a tool result for a check request', () => {
  const quoted = user(`Why did I see "${LINE}"?`);
  assert.deepEqual(finish.checkPlan(bodyOf([quoted])), { check: false, checks: 0 }, 'quoted');
  assert.deepEqual(finish.checkPlan(bodyOf([quoted, said('Because.'), user(CARD)])), { check: false, checks: 0 },
    'quoted, then a work card');
  assert.deepEqual(finish.checkPlan(bodyOf([user(CARD)])), { check: false, checks: 0 }, 'only a work card');
  const worked = [user('Fix it'), said('Done.'), user(LINE), called('c1', 'bash', { command: 'ls' }),
    result('c1', 'a')];
  assert.deepEqual(finish.checkPlan(bodyOf(worked)), { check: false, checks: 1 }, 'tool result after the check');
  assert.deepEqual(finish.checkPlan({ model: 'fake-coder' }), { check: false, checks: 0 }, 'no messages');
});

test('FC-26 checks counts the check lines after the start (the last delivery), including the last one', () => {
  const second = [user('Fix it'), said("I'll run the tests."), user(LINE), called('c1', 'bash', { command: 'ls' }),
    result('c1', 'ok'), said('The tests passed.'), user(LINE), user(CARD)];
  assert.deepEqual(finish.checkPlan(bodyOf(second)), { check: true, checks: 2 });
  // 上一次运行留下的检查那一行（检查时停止）在你的新消息之前：不算
  const stale = [user('Fix it'), said('Done.'), user(LINE), user('Next question'), said('Answer.'), user(LINE)];
  assert.deepEqual(finish.checkPlan(bodyOf(stale)), { check: true, checks: 1 });
  const fresh = [user('Fix it'), said('Done.'), user(LINE), called('c1', 'finish'), result('c1', 'Confirmed.'),
    user('Next question')];
  assert.deepEqual(finish.checkPlan(bodyOf(fresh)), { check: false, checks: 0 });
});

test('FC-26 sessionOf does not count a check line as a delivery, so k and j are unchanged', () => {
  const position = (messages) => {
    const info = scripts.sessionOf([SYSTEM, ...messages]);
    return { k: info.k, j: info.j, last: info.last };
  };
  const reply = [user('tb-scenario:tb-selfcheck-create Fix it'), said('Registered.')];
  assert.deepEqual(position([...reply, user(LINE), user(CARD)]), position(reply));
  assert.deepEqual(position([...reply, user(LINE)]), { k: 1, j: 1, last: 'tb-scenario:tb-selfcheck-create Fix it' });
  const next = [user('a'), said('Done.'), user(LINE), called('c1', 'finish'), result('c1', 'Confirmed.'), user('b')];
  assert.deepEqual(position(next), { k: 2, j: 0, last: 'b' });
  const info = scripts.sessionOf([SYSTEM, ...reply, user(LINE)]);
  assert.deepEqual([info.check, info.checks], [true, 1]);
});

test('FC-26 logFields adds check and checks and names the fc scenario that answers the request', () => {
  const body = bodyOf([user('fc-scenario:fc-a Fix it'), said('Done.'), user(LINE)]);
  const info = scripts.sessionOf(body.messages);
  const fc = finish.fcScenarioOf(body, info);
  assert.equal(fc, 'fc-a');
  const fields = scripts.logFields(body, info, ['finish'], fc);
  assert.deepEqual([fields.scenario, fields.check, fields.checks, fields.calls, fields.tools],
    ['fc-a', true, 1, ['finish'], ['read', 'bash', 'finish']]);
  const plain = bodyOf([user('tb-scenario:tb-selfcheck-create Fix it')]);
  const plainFields = scripts.logFields(plain, scripts.sessionOf(plain.messages), []);
  assert.deepEqual([plainFields.scenario, plainFields.check, plainFields.checks], ['tb-selfcheck-create', false, 0]);
});

test('FC-26 the default reply to a check request is one finish call with {} and no text, in every mode', () => {
  const cases = {
    keywords: [user('plain'), said('Text.'), user(LINE)],
    'tb-scenario script': [user('tb-scenario:tb-selfcheck-create Fix it'), said('Registered.'), user(LINE), user(CARD)],
    'second check': [user('plain'), said('Text.'), user(LINE), called('c1', 'bash'), result('c1', 'ok'),
      said('Again.'), user(LINE)],
  };
  for (const [name, messages] of Object.entries(cases)) {
    assert.deepEqual(replyOf(bodyOf(messages)), DEFAULT_REPLY, name);
  }
  // 不是检查请求、也没有 fc 场景：不归 finish.mjs 回答（接着按脚本、增强脚本、关键词）
  assert.equal(replyOf(bodyOf([user('plain')])), null);
  assert.equal(replyOf(bodyOf([user('plain'), said('Text.'), user(LINE), called('c1', 'bash'), result('c1', 'ok')])),
    null);
});

test('FC-26 fc-check-wait:<ms> in the start message delays the default reply to a check request by that much', () => {
  const waited = replyOf(bodyOf([user('fc-check-wait:3000 Fix it'), said('Text.'), user(LINE), user(CARD)]));
  assert.deepEqual(waited, { reply: { ...DEFAULT_REPLY.reply, delayMs: 3000 } });
  // 不是检查请求时不归 finish.mjs 回答；标记只在起点那条消息里算
  assert.equal(replyOf(bodyOf([user('fc-check-wait:3000 Fix it')])), null);
  const nextRun = replyOf(bodyOf([user('fc-check-wait:3000 Fix it'), said('Text.'), user(LINE), called('c1', 'finish'),
    result('c1', 'Confirmed.'), user('plain'), said('Text.'), user(LINE)]));
  assert.deepEqual(nextRun, DEFAULT_REPLY);
});

test('FC-26 fc-scenario applies only when the request tools include finish and the start message names it', () => {
  const start = [user('fc-scenario:fc-c Write a draft')];
  assert.equal(replyOf(bodyOf(start)).reply.text, 'Draft answer.');
  assert.equal(replyOf(bodyOf(start, NO_FINISH)), null, 'tools without finish');
  // 分开时立项实例收到你的原文（tools 里没有 finish）：照旧按脚本或关键词
  const create = bodyOf([user('[Mori] New user message: fc-scenario:fc-a Fix it')], [fn('request_submit')]);
  assert.equal(finish.fcScenarioOf(create, scripts.sessionOf(create.messages)), null);
  assert.equal(replyOf(create), null);
  // 场景名只在更早的一次运行里：这次运行不归它
  const earlier = bodyOf([user('fc-scenario:fc-a Fix it'), said('Done.'), user(LINE), called('c1', 'finish'),
    result('c1', 'Confirmed.'), user('plain question')]);
  assert.equal(finish.fcScenarioOf(earlier, scripts.sessionOf(earlier.messages)), null);
  assert.equal(replyOf(earlier), null);
});

test('FC-26 in a scenario run the check request is answered by the scenario, not by the default reply', () => {
  const plan = replyOf(bodyOf([user('fc-scenario:fc-a-text Fix it'), said('Done.'), user(LINE), user(CARD)]));
  assert.deepEqual(plan, { reply: { text: 'The reply stands.', toolCalls: [{ name: 'finish', args: {} }],
    delayMs: 0 } });
  const fail = replyOf(bodyOf([user('fc-scenario:fc-fail Fix it'), said('Done.'), user(LINE)]));
  assert.equal(fail.failure.status, 400);
  assert.equal(fail.failure.body.error.message, 'Synthetic HTTP 400 from script fc-fail');
});

// ---- fc-* 场景的走法（替身 pi，synthetic） ----

/** @brief 替身工具结果：finish 不带参数时成功并带 terminate，带参数时校验失败；其余工具成功。 */
function toolResult(call) {
  const bad = call.name === 'finish' && Object.keys(call.arguments).length > 0;
  const text = call.name !== 'finish' ? 'fc output (synthetic)'
    : bad ? 'Validation failed for tool "finish": must NOT have additional properties' : 'Confirmed.';
  return { role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: bad,
    content: [{ type: 'text', text }], terminate: call.name === 'finish' && !bad };
}

/** @brief AgentMessage → OpenAI 形状（同 pi 的 convertToLlm 与 openai-completions 的大意）。 */
function toOpenAi(m) {
  if (m.role === 'user' || m.role === 'custom') return user(m.content);
  if (m.role === 'toolResult') return result(m.toolCallId, m.content[0].text);
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const calls = m.content.filter((b) => b.type === 'toolCall').map((b) => ({ id: b.id, type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.arguments) } }));
  return { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

/** @brief 一次请求的简写："check <n>: " 加文字与调用，或 "HTTP <状态码>"。 */
function brief(info, plan) {
  const head = info.check ? `check ${info.checks}: ` : '';
  if (plan.failure) return `${head}HTTP ${plan.failure.status}`;
  return head + [plan.reply.text, ...plan.reply.toolCalls.map((c) => `call ${c.name}`)].filter(Boolean).join(' + ');
}

/**
 * @brief 替身 pi 跑一次 fc 场景的运行：每次请求按 finishReply 回答；有工具调用时接上结果，一批全带 terminate 才停；
 *        运行要结束时按内核的 settleDecision 加检查那一行或放行；请求出错时运行以出错结束。
 * @return { briefs, plans, end（放行的 reason 或 'error'） }
 */
function drive(name) {
  const history = [{ role: 'user', content: `fc-scenario:${name} Fix the login page` }];
  const briefs = [];
  const plans = [];
  for (let round = 0; round < 20; round += 1) {
    const body = bodyOf(history.map(toOpenAi));
    const info = scripts.sessionOf(body.messages);
    const plan = finish.finishReply(body, new Set(), info);
    assert.ok(plan, `${name}: request ${round} is answered by the scenario`);
    briefs.push(brief(info, plan));
    plans.push(plan);
    if (plan.failure) return { briefs, plans, end: 'error' };
    const calls = plan.reply.toolCalls.map((c, i) => ({ type: 'toolCall', id: `call_${round}_${i}`, name: c.name,
      arguments: c.args }));
    history.push({ role: 'assistant', content: [{ type: 'text', text: plan.reply.text }, ...calls] });
    const results = calls.map(toolResult);
    history.push(...results);
    if (calls.length > 0 && !results.every((r) => r.terminate)) continue;
    const decision = kernel.settleDecision(history);
    if (!decision.check) return { briefs, plans, end: decision.reason };
    history.push({ role: 'custom', customType: shared.FINISH_CHECK_TYPE, content: kernel.checkLine(['taste']),
      display: false });
  }
  return assert.fail(`${name}: the run did not end`);
}

/** 每个场景的请求（简写）与运行怎样结束（§14.1 的表） */
const RUNS = {
  'fc-a': [['Done.', 'check 1: call finish'], 'confirmed'],
  'fc-a-think': [['Done.', 'check 1: call finish'], 'confirmed'],
  'fc-a-text': [['Done.', 'check 1: The reply stands. + call finish'], 'confirmed'],
  'fc-b': [["I'll run the tests.", 'check 1: call bash', 'The tests passed.', 'check 2: call finish'], 'confirmed'],
  'fc-c': [['Draft answer.', 'check 1: Conclusion first: rewritten answer.'], 'no work'],
  'fc-cap': [['Working.', 'check 1: call bash', 'Still working.', 'check 2: call bash', 'Still working.',
    'check 3: call bash', 'Still working.'], 'limit'],
  'fc-mixed': [['Done.', 'check 1: call finish + call bash', 'Done again.', 'check 2: call finish'], 'confirmed'],
  'fc-bad-args': [['Done.', 'check 1: call finish', 'Final reply.'], 'no work'],
  'fc-early': [['Done. + call finish', 'check 1: call finish'], 'confirmed'],
  'fc-slow': [['Done.', 'check 1: call finish'], 'confirmed'],
  'fc-fail': [['Done.', 'check 1: HTTP 400'], 'error'],
  'fc-fail-first': [['HTTP 400'], 'error'],
  'fc-404': [['Done.', 'check 1: HTTP 404'], 'error'],
  'fc-work-fail': [['Done.', 'check 1: call bash', 'HTTP 400'], 'error'],
  'fc-away-once': [['call write', 'First summary fs78b.', 'check 1: call write', 'Second summary fs78b.',
    'check 2: call finish'], 'confirmed'],
};

test('FC-26 every fc-* scenario of the spec table runs its steps per check count and replies after the check', () => {
  const table = /^\s*\|\s*`(fc-[\w-]+)`\s*\|/gm;
  const named = [...readFileSync(SPEC, 'utf8').matchAll(table)].map((match) => match[1]);
  assert.deepEqual(Object.keys(finish.FC_SCENARIOS).sort(), [...new Set(named)].sort());
  assert.deepEqual(Object.keys(RUNS).sort(), Object.keys(finish.FC_SCENARIOS).sort());
  for (const [name, [briefs, end]] of Object.entries(RUNS)) {
    const run = drive(name);
    assert.deepEqual(run.briefs, briefs, name);
    assert.equal(run.end, end, name);
  }
});

test('FC-26 fc-* step details: thinking, the slow wait, the tool arguments and the failure bodies', () => {
  const think = drive('fc-a-think').plans.map((plan) => plan.reply.thinking);
  assert.deepEqual(think, [finish.FC_THOUGHTS.reply, finish.FC_THOUGHTS.check]);
  assert.deepEqual(drive('fc-a').plans.map((plan) => plan.reply.thinking), [undefined, undefined]);
  assert.deepEqual(drive('fc-slow').plans.map((plan) => plan.reply.delayMs), [0, finish.FC_SLOW_MS]);
  assert.equal(finish.FC_SLOW_MS, 8000);
  const argsOf = (name, index) => drive(name).plans[index].reply.toolCalls.map((c) => [c.name, c.args]);
  assert.deepEqual(argsOf('fc-bad-args', 1), [['finish', { reply: 'Done.' }]]);
  assert.deepEqual(argsOf('fc-b', 1), [['bash', { command: 'echo fc-b' }]]);
  assert.deepEqual(argsOf('fc-work-fail', 1), [['bash', { command: 'echo fc' }]]);
  assert.deepEqual(argsOf('fc-mixed', 1).map(([name]) => name), ['finish', 'bash']);
  assert.deepEqual(argsOf('fc-early', 0), [['finish', {}]]);
  assert.deepEqual(argsOf('fc-away-once', 0), [['write', { path: '../fs78-b1.md', content: 'fs78b one\n' }]]);
  assert.deepEqual(argsOf('fc-away-once', 2), [['write', { path: '../fs78-b2.md', content: 'fs78b two\n' }]]);
  assert.deepEqual(drive('fc-away-once').plans.map((plan) => plan.reply.delayMs), [0, 4000, 0, 0, 0]);
  for (const name of ['fc-fail', 'fc-fail-first', 'fc-404', 'fc-work-fail']) {
    const failure = drive(name).plans.at(-1).failure;
    assert.equal(failure.body.error.message, `Synthetic HTTP ${failure.status} from script ${name}`, name);
  }
});

test('FC-26 a scenario without a step for the request answers NO_STEP_TEXT and logs "no script step"', (t) => {
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(String(line)));
  const unknown = replyOf(bodyOf([user('fc-scenario:fc-nosuch Fix it')]));
  assert.equal(unknown.reply.text, scripts.NO_STEP_TEXT);
  const beyond = replyOf(bodyOf([user('fc-scenario:fc-a Fix it'), said('Done.'), user(LINE), said('More.'),
    user(LINE)]));
  assert.equal(beyond.reply.text, scripts.NO_STEP_TEXT);
  assert.ok(errors.some((line) => line.includes('no script step') && line.includes('fc-nosuch')), errors.join('\n'));
  assert.ok(errors.some((line) => line.includes('no script step') && line.includes('"checks":2')), errors.join('\n'));
});

// ---- pi 组装的请求（pi-ai 1.3.0 的 openai-completions，synthetic 的会话） ----

/** @brief 一条结束的助手消息（pi 的 AssistantMessage 形状）。 */
function piAssistant(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'local',
    model: 'fake-coder', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 };
}

/** @brief pi-ai 真实组装的请求体：经 onPayload 截下，替身 fetch 回一段最短的 SSE（synthetic）。 */
async function piBody(messages) {
  let captured = null;
  const model = { id: 'fake-coder', name: 'fake-coder', api: 'openai-completions', provider: 'local',
    baseUrl: 'http://127.0.0.1:9/v1', input: ['text'], reasoning: false, contextWindow: 131072, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const tool = kernel.finishTool();
  const context = { systemPrompt: 'You are Mori (synthetic).', messages,
    tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }] };
  const chunk = (delta, reason = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk',
    created: 1, model: 'fake-coder', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  const sse = `${chunk({ role: 'assistant', content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`;
  const stream = completionsStream(model, normalizeContext(context), { apiKey: 'none', maxRetries: 0,
    onPayload: (params) => { captured = params; },
    fetch: async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  await stream.result();
  return captured;
}

test('FC-26 checkPlan recognizes a check request that pi assembles (check block, then a work card)', async () => {
  const custom = (customType, content, timestamp) => ({ role: 'custom', customType, content, display: false,
    timestamp });
  const agent = [
    { role: 'user', content: [{ type: 'text', text: 'Fix the login page' }], timestamp: 1 },
    piAssistant('Done.'),
    custom(shared.FINISH_CHECK_TYPE, LINE, 3),
    custom('mori.work_card', CARD, 4),
  ];
  const withBlock = kernel.withCheckBlock(agent, kernel.checkRequestIndex(agent), BLOCK);
  const body = await piBody(convertToLlm(withBlock));
  assert.ok(body, 'pi assembled a request');
  assert.deepEqual(finish.checkPlan(body), { check: true, checks: 1 });
  const info = scripts.sessionOf(body.messages);
  assert.deepEqual([info.k, info.j], [1, 1]);
  assert.deepEqual(replyOf(body), DEFAULT_REPLY);
});

// ---- server.mjs（子进程）：判断顺序、加思考的钩子与日志行 ----

/** @brief 取一个空闲端口。 */
function freePort() {
  return new Promise((done) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @brief 起一份端点（去掉 FAKE_* 环境变量，分块之间不等），等启动行出现。
 * @return { port, lines（stdout 的行）, errors（stderr 的文字）, kill }
 */
async function startEndpoint() {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FAKE_')));
  const child = spawn(process.execPath, [SERVER], { env: { ...env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const errors = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    const parts = (buffer + data).split('\n');
    buffer = parts.pop();
    lines.push(...parts);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => errors.push(data));
  const ep = { port, lines, errors, kill: () => child.kill() };
  for (let i = 0; i < 100 && !lines.some((line) => line.includes('synthetic endpoint on')); i += 1) await sleep(50);
  if (!lines.some((line) => line.includes('synthetic endpoint on'))) {
    ep.kill();
    throw new Error('the synthetic endpoint did not start');
  }
  return ep;
}

/** @brief 端点的对话请求日志行（JSON，带 roles 字段）。 */
const chatLogs = (ep) => ep.lines.filter((line) => line.startsWith('{') && line.includes('"roles"')).map(JSON.parse);

/** @brief 发一个对话请求，读完 SSE；返回 { status, text, reasoning, calls, log（这次请求的日志行） }。 */
async function chat(ep, body) {
  const before = chatLogs(ep).length;
  const res = await fetch(`http://127.0.0.1:${ep.port}/v1/chat/completions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await res.text();
  const out = { status: res.status, text: '', reasoning: '', calls: [] };
  for (const event of res.ok ? raw.split('\n\n') : []) {
    const data = event.replace(/^data: /, '').trim();
    if (data === '' || data === '[DONE]') continue;
    for (const choice of JSON.parse(data).choices ?? []) {
      out.text += choice.delta?.content ?? '';
      out.reasoning += choice.delta?.reasoning_content ?? '';
      for (const call of choice.delta?.tool_calls ?? []) {
        out.calls[call.index] ??= { name: call.function?.name, args: '' };
        out.calls[call.index].args += call.function?.arguments ?? '';
      }
    }
  }
  for (let i = 0; i < 40 && chatLogs(ep).length <= before; i += 1) await sleep(50);
  out.log = chatLogs(ep)[before];
  return out;
}

/** 下面两个用例共用的一份端点：第一次用到时起，这个文件的用例跑完后关掉 */
let endpointRun = null;
/** @brief 共用的端点（startEndpoint 的结果）。 */
const endpoint = () => (endpointRun ??= startEndpoint());
after(() => endpointRun?.then((ep) => ep.kill(), () => {}));

test('FC-26 the endpoint answers check requests after summaries and before scripts, keeps thinking, logs check',
  async () => {
    const ep = await endpoint();
    const finishCall = [{ name: 'finish', args: '{}' }];
    const normal = await chat(ep, bodyOf([user('plain')]));
    assert.ok(normal.text.length > 0 && normal.calls.length === 0, JSON.stringify(normal));
    assert.deepEqual([normal.log.check, normal.log.checks], [false, 0]);
    const check = await chat(ep, bodyOf([user('plain'), said('Text.'), user(LINE), user(CARD)]));
    assert.deepEqual([check.status, check.text, check.reasoning, check.calls], [200, '', '', finishCall]);
    assert.deepEqual([check.log.check, check.log.checks, check.log.calls, check.log.scenario], [true, 1, ['finish'],
      null]);
    const script = await chat(ep, bodyOf([user('tb-scenario:tb-selfcheck-create Fix it'), said('Registered.'),
      user(LINE)]));
    assert.deepEqual([script.text, script.calls, script.log.scenario], ['', finishCall, 'tb-selfcheck-create']);
    const summary = await chat(ep, { model: 'fake-coder', stream: true, messages: [{ role: 'system',
      content: 'You are a context summarization assistant. (synthetic)' }, user(LINE)] });
    assert.ok(summary.text.includes('Synthetic summary') && summary.calls.length === 0, JSON.stringify(summary));
    const scenario = await chat(ep, bodyOf([user('fc-scenario:fc-a-text Fix it'), said('Done.'), user(LINE)]));
    assert.deepEqual([scenario.text, scenario.calls, scenario.log.scenario, scenario.log.check],
      ['The reply stands.', finishCall, 'fc-a-text', true]);
    const failed = await chat(ep, bodyOf([user('fc-scenario:fc-fail Fix it'), said('Done.'), user(LINE)]));
    assert.deepEqual([failed.status, failed.log.status, failed.log.scenario, failed.log.check], [400, 400, 'fc-fail',
      true]);
  });

test('FC-26 the default reply keeps the thinking of -replay (thinking on), -alwaysthink and -nooff models',
  async () => {
    const ep = await endpoint();
    const messages = [user('plain'), said('Text.'), user(LINE)];
    const cases = [['fake-coder-replay', { reasoning_effort: 'medium' }], ['fake-coder-alwaysthink', {}],
      ['fake-coder-nooff', {}]];
    for (const [model, extra] of cases) {
      const out = await chat(ep, bodyOf(messages, TOOLS, { model, ...extra }));
      assert.equal(out.status, 200, model);
      assert.ok(out.reasoning.length > 0, `${model} answers the check with thinking`);
      assert.deepEqual([out.text, out.calls, out.log.check], ['', [{ name: 'finish', args: '{}' }], true], model);
    }
    const plain = await chat(ep, bodyOf(messages, TOOLS, { model: 'fake-coder-replay' }));
    assert.deepEqual([plain.reasoning, plain.calls.map((c) => c.name)], ['', ['finish']], 'replay with thinking off');
  });
