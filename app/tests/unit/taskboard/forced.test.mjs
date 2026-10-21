// kernel/forcedWrite.ts 与 kernel/handoffForm.ts 的单元测试（docs/specs/parallel-agents-taskboard.md §7.5、§7.6 强制关闭、
// §12.7、§14.4、§14.6 T-F1/T-F2）：严格 schema、三种表单、按写入等级改写一次尝试的选项、C 级标签说明、B/C 回复的解析，
// 以及与合成端点脚本模式（tests/fake-endpoint/scripts.mjs，synthetic）输出的交接单一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { loadKernelModule } from '../load.mjs';
import {
  CLOSE_REQUEST_TAGS, SEGMENT_SENTENCES, SHARED_SENTENCE, WORK_CARD_CLOSE, WORK_CARD_OPEN, scriptReply, sessionOf,
} from '../../fake-endpoint/scripts.mjs';

const forced = await loadKernelModule('src/kernel/forcedWrite.ts');
const hf = await loadKernelModule('src/kernel/handoffForm.ts');

const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const NEXT = [
  { name: 'reviewer', description: 'Reviews changes', seats: [] },
  { name: 'planner', description: 'Plans the work', seats: ['create', 'close'] },
  { name: 'mori', description: 'The base agent', seats: [] },
];
const TASK_TAGS = '<conclusion>…</conclusion><outcome>continue|dead_end|blocked|need_user|done|pass|fail</outcome>'
  + '<next>…</next><open_items>…</open_items><evidence>…</evidence>';

/** 探针一步的结果。 */
const step = (outcome) => ({ outcome, detail: null });
/** 档案的写入等级：level 与第 6 步（B）的结果。 */
function tierOf(level, b = level === 'B' ? 'pass' : 'fail') {
  return { level, a: step(level === 'A' ? 'pass' : 'fail'), b: step(b), c: step(level === 'C' ? 'pass' : 'not_run') };
}
/** 解析结果里的参数（失败时报出原因）。 */
function argsOf(result) {
  assert.ok('args' in result, `expected args, got ${JSON.stringify(result)}`);
  return result.args;
}

// ---- 请求体：三种接口里的工具定义 ----

/** 一个工具在某种接口请求体里的定义（pi 组装的形状）。 */
function toolIn(api, name, parameters = { type: 'object', properties: {} }) {
  if (api === 'openai-completions') return { type: 'function', function: { name, parameters, strict: false } };
  if (api === 'openai-responses') return { type: 'function', name, parameters, strict: false };
  return { name, input_schema: parameters };
}
/** 请求体里一个工具的 strict 与参数 schema。 */
function strictOf(api, tool) {
  if (api === 'openai-completions') return { strict: tool.function.strict, schema: tool.function.parameters };
  return { strict: tool.strict, schema: api === 'anthropic-messages' ? tool.input_schema : tool.parameters };
}

/**
 * 按流函数包装（modelSession.ts 的 shaped，§14.4）的做法把一次尝试的改写套到选项上：toolChoice 写进选项、
 * thinkingOff 时不传 reasoning、payload 接在原来的 onPayload 之后。
 */
function applied(shape, options = {}) {
  const next = { ...options };
  if (shape.toolChoice !== undefined) next.toolChoice = shape.toolChoice;
  if (shape.thinkingOff) next.reasoning = undefined;
  if (shape.payload) next.onPayload = forced.chainPayload(options.onPayload, shape.payload);
  return next;
}

// ---- forcedWrite.ts ----

test('TB-18 forcedWrite: withStrictTools swaps in the schema and adds strict on the named tool only', () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'],
    additionalProperties: false };
  for (const api of APIS) {
    const body = { model: 'm', tools: [toolIn(api, 'read'), toolIn(api, 'task_handoff')] };
    const before = JSON.stringify(body);
    const out = forced.withStrictTools(api, body, 'task_handoff', schema);
    assert.equal(JSON.stringify(body), before, `${api}: input is not changed`);
    assert.notEqual(strictOf(api, out.tools[0]).strict, true, `${api}: other tools keep their strict`);
    assert.deepEqual(strictOf(api, out.tools[0]).schema, { type: 'object', properties: {} });
    assert.deepEqual(strictOf(api, out.tools[1]), { strict: true, schema }, api);
    assert.equal(out.model, 'm');
  }
  const kept = forced.withStrictTools('openai-completions', { tools: [toolIn('openai-completions', 'x')] }, 'x');
  assert.deepEqual(kept.tools[0].function.parameters, { type: 'object', properties: {} }, 'no schema: not swapped');
});

test('TB-18 forcedWrite: chainPayload calls the original onPayload first (T-F1)', async () => {
  const order = [];
  const original = async (payload, model) => {
    order.push(`original:${model.id}`);
    return { ...payload, fromPi: true };
  };
  const chained = forced.chainPayload(original, (payload) => {
    order.push('change');
    return { ...payload, changed: true };
  });
  assert.deepEqual(await chained({ a: 1 }, { id: 'm' }), { a: 1, fromPi: true, changed: true });
  assert.deepEqual(order, ['original:m', 'change']);
  const keep = forced.chainPayload(async () => undefined, (payload) => ({ ...payload, changed: true }));
  assert.deepEqual(await keep({ a: 1 }, { id: 'm' }), { a: 1, changed: true }, 'undefined keeps the payload');
  const alone = forced.chainPayload(undefined, (payload) => ({ ...payload, changed: true }));
  assert.deepEqual(await alone({ a: 1 }, { id: 'm' }), { a: 1, changed: true });
});

test('TB-18 forcedWrite: tagContent reads the first closed tag, trimmed', () => {
  assert.equal(forced.tagContent('x <outcome> done </outcome> <outcome>fail</outcome>', 'outcome'), 'done');
  assert.equal(forced.tagContent('<next></next>', 'next'), '');
  assert.equal(forced.tagContent('<evidence>#1\n#2</evidence>', 'evidence'), '#1\n#2');
  assert.equal(forced.tagContent('<outcome>done', 'outcome'), null, 'not closed');
  assert.equal(forced.tagContent('no tags', 'outcome'), null);
});

// ---- 严格 schema 与三种表单 ----

test('TB-18 strictSchema: every key required, optional fields nullable, no extra keys, nested too', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'string', enum: ['x', 'y'] },
      c: { type: 'array', items: { type: 'object', properties: { d: { type: 'integer' } }, required: [] } },
      e: { description: 'no type' },
    },
    required: ['a'],
  };
  const before = JSON.stringify(schema);
  const strict = hf.strictSchema(schema);
  assert.equal(JSON.stringify(schema), before, 'input is not changed');
  assert.deepEqual(strict.required, ['a', 'b', 'c', 'e']);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.properties.a, { type: 'string' });
  assert.deepEqual(strict.properties.b, { type: ['string', 'null'], enum: ['x', 'y', null] });
  assert.deepEqual(strict.properties.c.type, ['array', 'null']);
  assert.deepEqual(strict.properties.c.items, { type: 'object', properties: { d: { type: ['integer', 'null'] } },
    required: ['d'], additionalProperties: false });
  assert.deepEqual(strict.properties.e, { anyOf: [{ description: 'no type' }, { type: 'null' }] });
});

test('TB-18 task instance form: strict task_handoff with this session\'s next enum and role descriptions', () => {
  const form = hf.taskForm('T1', NEXT);
  assert.equal(form.tool, 'task_handoff');
  assert.equal(form.task, 'T1');
  const { schema } = form;
  assert.deepEqual(Object.keys(schema.properties), ['task', 'conclusion', 'outcome', 'next', 'open_items', 'evidence']);
  assert.deepEqual(schema.required, ['task', 'conclusion', 'outcome', 'next', 'open_items', 'evidence']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.task.type, ['string', 'null']);
  assert.equal(schema.properties.conclusion.type, 'string');
  assert.deepEqual(schema.properties.outcome.enum, ['continue', 'dead_end', 'blocked', 'need_user', 'done', 'pass',
    'fail']);
  assert.deepEqual(schema.properties.next.enum, ['reviewer', 'planner', 'mori', null]);
  assert.match(schema.properties.next.description,
    /reviewer: Reviews changes; planner \(create, close\): Plans the work; mori: The base agent/);
  assert.deepEqual(schema.properties.evidence.type, ['array', 'null']);
  assert.deepEqual(schema.properties.open_items.items, { type: 'string' });
  const loose = hf.taskHandoffSchema(NEXT);
  assert.deepEqual(loose.required, ['conclusion', 'outcome'], 'the tool schema keeps task, next and lists optional');
  const alone = hf.taskForm('T1', []);
  assert.ok(!('next' in alone.schema.properties), 'only the base role: no next');
  assert.ok(!alone.schema.required.includes('next'));
});

test('TB-14 close session schema has no evidence; the close form fixes task to one id', () => {
  const loose = hf.closeHandoffSchema(NEXT);
  assert.deepEqual(Object.keys(loose.properties), ['task', 'conclusion', 'outcome', 'next']);
  assert.ok(!('evidence' in loose.properties) && !('open_items' in loose.properties));
  assert.deepEqual(loose.required, ['task', 'conclusion', 'outcome']);
  assert.deepEqual(loose.properties.outcome.enum, ['close_done', 'close_failed', 'continue', 'need_user']);
  const form = hf.closeForm('T2', NEXT);
  assert.deepEqual(form.schema.properties.task.enum, ['T2']);
  assert.equal(form.schema.properties.task.type, 'string');
  assert.ok(!('evidence' in form.schema.properties));
  assert.deepEqual(form.schema.properties.next.enum, ['reviewer', 'planner', 'mori', null]);
  assert.deepEqual(form.schema.required, ['task', 'conclusion', 'outcome', 'next']);
});

test('TB-18 forced request_close form fixes request to one number', () => {
  const form = hf.requestCloseForm(3);
  assert.equal(form.tool, 'request_close');
  assert.equal(form.request, 3);
  assert.deepEqual(form.schema.properties.request, { type: 'integer', description: 'The request number.',
    enum: [3] });
  assert.deepEqual(form.schema.properties.outcome.enum, ['done', 'failed']);
  assert.deepEqual(form.schema.required, ['request', 'outcome', 'conclusion']);
  assert.equal(form.schema.additionalProperties, false);
});

// ---- 写法与请求改写 ----

test('TB-18 write mode: A only when thinking can be turned off, else B when B passed, else C; no tier, no fill', () => {
  assert.equal(hf.writeModeOf(tierOf('A'), true), 'A');
  assert.equal(hf.writeModeOf(tierOf('A', 'pass'), false), 'B');
  assert.equal(hf.writeModeOf(tierOf('A', 'pass'), 'unknown'), 'B');
  assert.equal(hf.writeModeOf(tierOf('A', 'fail'), false), 'C');
  assert.equal(hf.writeModeOf(tierOf('A', 'not_applicable'), false), 'C', 'anthropic-messages has no B');
  assert.equal(hf.writeModeOf(tierOf('B'), false), 'B');
  assert.equal(hf.writeModeOf(tierOf('C'), true), 'C');
  assert.equal(hf.writeModeOf(tierOf(null), true), null);
  assert.equal(hf.writeModeOf(null, true), null);
  const form = hf.taskForm('T1', NEXT);
  assert.equal(hf.shapeFor(form, tierOf(null), true, 'openai-completions'), null, 'no tier: no forced fill');
  assert.equal(hf.shapeFor(form, null, 'unknown', 'openai-completions'), null);
});

test('TB-18 A: tool_choice for task_handoff, strict schema on that tool only, thinking off; pi\'s onPayload first',
  async () => {
    const form = hf.taskForm('T1', NEXT);
    for (const api of APIS) {
      const order = [];
      const original = async (payload) => {
        order.push('pi');
        return { ...payload, fromPi: true };
      };
      const options = { reasoning: 'high', maxTokens: 10, onPayload: original };
      const shape = hf.shapeFor(form, tierOf('A'), true, api);
      assert.equal(shape.mode, 'A');
      assert.equal(shape.thinkingOff, true);
      const out = applied(shape, options);
      assert.deepEqual(out.toolChoice, forced.forcedToolChoice(api, 'task_handoff'), api);
      assert.equal(out.reasoning, undefined, `${api}: thinking off`);
      assert.equal(out.maxTokens, 10);
      assert.equal(options.reasoning, 'high', 'input options are not changed');
      const payload = await out.onPayload({ tools: [toolIn(api, 'read'), toolIn(api, 'task_handoff')] }, { id: 'm' });
      assert.deepEqual(order, ['pi'], `${api}: the original onPayload runs`);
      assert.equal(payload.fromPi, true, `${api}: change applies to what pi returned`);
      assert.notEqual(strictOf(api, payload.tools[0]).strict, true);
      assert.deepEqual(strictOf(api, payload.tools[1]), { strict: true, schema: form.schema });
    }
  });

test('TB-18 B: response_format json_schema with the strict form; tools and thinking unchanged', async () => {
  const form = hf.taskForm('T1', NEXT);
  const tools = [toolIn('openai-completions', 'read'), toolIn('openai-completions', 'task_handoff')];
  for (const [label, tier, canDisable] of [['B', tierOf('B'), false], ['A, cannot turn thinking off',
    tierOf('A', 'pass'), false]]) {
    const shape = hf.shapeFor(form, tier, canDisable, 'openai-completions');
    assert.equal(shape.mode, 'B', label);
    assert.equal(shape.thinkingOff, undefined);
    const out = applied(shape, { reasoning: 'medium', onPayload: async (p) => ({ ...p, fromPi: true }) });
    assert.equal(out.reasoning, 'medium', `${label}: thinking unchanged`);
    assert.equal(out.toolChoice, undefined);
    const payload = await out.onPayload({ tools }, { id: 'm' });
    assert.equal(payload.fromPi, true);
    assert.deepEqual(payload.tools, tools, `${label}: tools unchanged`);
    assert.deepEqual(payload.response_format, { type: 'json_schema',
      json_schema: { name: 'task_handoff', schema: form.schema, strict: true } });
  }
  const responses = applied(hf.shapeFor(form, tierOf('B'), false, 'openai-responses'));
  const body = await responses.onPayload({ text: { verbosity: 'low' } }, { id: 'm' });
  assert.deepEqual(body.text, { verbosity: 'low', format: { type: 'json_schema', name: 'task_handoff',
    schema: form.schema, strict: true } });
});

test('TB-18 C: the request is unchanged (also A that cannot turn thinking off and failed B)', () => {
  const form = hf.taskForm('T1', NEXT);
  const onPayload = async (p) => p;
  for (const [tier, canDisable] of [[tierOf('C'), true], [tierOf('A', 'fail'), false]]) {
    const shape = hf.shapeFor(form, tier, canDisable, 'openai-completions');
    assert.deepEqual(shape, { mode: 'C' }, 'no toolChoice, payload or thinkingOff');
    const options = { reasoning: 'low', onPayload };
    const out = applied(shape, options);
    assert.deepEqual(out, options);
    assert.equal(out.onPayload, onPayload, 'onPayload is not wrapped');
  }
});

test('TB-18 the shaping follows the model of each attempt (a switch uses the new model\'s tier)', () => {
  const form = hf.taskForm('T1', NEXT);
  const first = hf.shapeFor(form, tierOf('C'), false, 'openai-completions');
  const switched = hf.shapeFor(form, tierOf('A'), true, 'openai-completions');
  assert.equal(first.toolChoice, undefined);
  assert.deepEqual(switched.toolChoice, { type: 'function', function: { name: 'task_handoff' } });
  const close = hf.shapeFor(hf.requestCloseForm(1), tierOf('A'), true, 'openai-completions');
  assert.deepEqual(close.toolChoice, { type: 'function', function: { name: 'request_close' } });
});

// ---- 用 pi-ai 真实的组装（openai-completions），替身 fetch 截下请求体 ----

/** 用 pi-ai 的 openai-completions 组装一次请求并截下请求体（一律回 400）。 */
async function capturedBody(options, tools) {
  const mod = await import('@earendil-works/pi-ai/api/openai-completions');
  let body = null;
  const fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('{"error":{"message":"captured"}}', { status: 400,
      headers: { 'content-type': 'application/json' } });
  };
  const model = { id: 'fake-coder', name: 'fake-coder', api: 'openai-completions', provider: 'local',
    baseUrl: 'http://127.0.0.1:4319/v1', input: ['text'], reasoning: true, contextWindow: 131072, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = { messages: [{ role: 'user', content: 'Hand off T1 now.', timestamp: 1 }], tools };
  const stream = mod.streamSimple(model, normalizeContext(context), { apiKey: 'x', fetch, maxRetries: 0, ...options });
  for await (const _event of stream) { /* 读完 */ }
  return body;
}

test('TB-18 pi-ai request with A: tool_choice, strict only on task_handoff with the strict schema, no reasoning; '
  + 'with B: response_format (T-F1, T-F2)', async () => {
  const form = hf.taskForm('T1', NEXT);
  const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    { name: 'task_handoff', description: 'Hand off', parameters: hf.taskHandoffSchema(NEXT) }];
  const plain = await capturedBody({ reasoning: 'medium' }, tools);
  assert.equal(plain.reasoning_effort, 'medium', 'the unshaped request carries the thinking parameter');
  const a = await capturedBody(applied(hf.shapeFor(form, tierOf('A'), true, 'openai-completions'),
    { reasoning: 'medium' }), tools);
  assert.deepEqual(a.tool_choice, { type: 'function', function: { name: 'task_handoff' } });
  assert.equal(a.reasoning_effort, undefined);
  assert.notEqual(a.tools[0].function.strict, true);
  assert.equal(a.tools[1].function.strict, true);
  assert.deepEqual(a.tools[1].function.parameters, form.schema);
  const b = await capturedBody(applied(hf.shapeFor(form, tierOf('B'), false, 'openai-completions'),
    { reasoning: 'medium' }), tools);
  assert.equal(b.response_format.type, 'json_schema');
  assert.deepEqual(b.response_format.json_schema.schema, form.schema);
  assert.equal(b.tools.length, 2);
  assert.notEqual(b.tools[1].function.strict, true);
  assert.equal(b.reasoning_effort, 'medium');
  assert.equal(b.tool_choice, undefined);
});

// ---- 投递里写明怎么填 ----

test('TB-18 format hints: C lists the tags, the allowed values and the next roles; A and B say how to answer', () => {
  const task = hf.formatHint(hf.taskForm('T1', NEXT), 'C');
  assert.ok(task.startsWith(`Reply with exactly these tags: ${TASK_TAGS}`), task);
  assert.match(task, /open_items and evidence take one item per line and can be empty\./);
  assert.match(task, /next is one of: reviewer: Reviews changes; planner \(create, close\): Plans the work; mori: /);
  const alone = hf.formatHint(hf.taskForm('T1', []), 'C');
  assert.ok(!alone.includes('<next>') && !alone.includes('next is one of'), 'only the base role: no next');
  const close = hf.formatHint(hf.closeForm('T2', NEXT), 'C');
  assert.ok(close.startsWith('Reply with exactly these tags: <conclusion>…</conclusion>'
    + '<outcome>close_done|close_failed|continue|need_user</outcome><next>…</next>'), close);
  assert.match(close, /Fill next only for continue; it is one of: reviewer: /);
  const request = hf.formatHint(hf.requestCloseForm(1), 'C');
  assert.equal(request, 'Reply with exactly these tags: <outcome>done|failed</outcome><conclusion>…</conclusion>');
  assert.ok(request.includes(CLOSE_REQUEST_TAGS), 'the synthetic endpoint recognises a forced request_close');
  assert.equal(hf.formatHint(hf.taskForm('T1', NEXT), 'A'), 'Call task_handoff for T1 now.');
  assert.equal(hf.formatHint(hf.requestCloseForm(1), 'A'), 'Call request_close for request 1 now.');
  assert.match(hf.formatHint(hf.closeForm('T2', NEXT), 'B'),
    /^Reply with only a JSON object .*task_handoff for T2.*null/);
});

// ---- 解析 B、C 的回复 ----

test('TB-18 C tags parse into task_handoff arguments (§7.5)', () => {
  const form = hf.taskForm('T1', NEXT);
  const full = '<conclusion>Fixed the login page</conclusion><outcome>done</outcome><next>reviewer</next>'
    + '<open_items>Check logout\n\n  Add a test </open_items><evidence>#3\n[#4]\n5</evidence>';
  assert.deepEqual(argsOf(hf.parseForm(form, 'C', full)), { task: 'T1', conclusion: 'Fixed the login page',
    outcome: 'done', next: 'reviewer', open_items: ['Check logout', 'Add a test'], evidence: ['#3', '[#4]', '5'] });
  const sparse = 'Here it is: <conclusion> x </conclusion>\n<outcome> fail </outcome><next></next>'
    + '<open_items></open_items><evidence></evidence> thanks';
  assert.deepEqual(argsOf(hf.parseForm(form, 'C', sparse)), { task: 'T1', conclusion: 'x', outcome: 'fail' });
  const err = (text) => hf.parseForm(form, 'C', text).error;
  assert.equal(err('<conclusion>x</conclusion>'), 'outcome is required');
  assert.equal(err('<conclusion>x</conclusion><outcome></outcome>'), 'outcome is required');
  assert.equal(err('<conclusion>x</conclusion><outcome>'), 'outcome is required', 'malformed: cut before outcome');
  assert.match(err('<conclusion>x</conclusion><outcome>Done</outcome>'),
    /^outcome "Done" is not one of: continue, dead_end, blocked, need_user, done, pass, fail$/);
  assert.match(err('<conclusion>x</conclusion><outcome>close_done</outcome>'), /is not one of/);
  assert.equal(err('<conclusion>x</conclusion><outcome>done</outcome><next>writer</next>'),
    'next "writer" is not one of: reviewer, planner, mori');
  assert.equal(err('<outcome>done</outcome>'), 'conclusion is required');
  assert.equal(err('<conclusion> </conclusion><outcome>done</outcome>'), 'conclusion is empty');
  assert.equal(err(`<conclusion>${'a'.repeat(601)}</conclusion><outcome>done</outcome>`),
    'conclusion is longer than 600 characters');
  const many = Array.from({ length: 11 }, (_, i) => `item ${i}`).join('\n');
  assert.equal(err(`<conclusion>x</conclusion><outcome>done</outcome><open_items>${many}</open_items>`),
    'open_items has more than 10 items');
  assert.equal(err(`<conclusion>x</conclusion><outcome>done</outcome><open_items>${'b'.repeat(201)}</open_items>`),
    'an open item is longer than 200 characters');
  const alone = hf.taskForm('T1', []);
  assert.equal(hf.parseForm(alone, 'C', '<conclusion>x</conclusion><outcome>done</outcome><next>mori</next>').error,
    'next "mori" is not one of: none');
});

test('TB-18 close and forced request_close C tags parse per §7.5', () => {
  const close = hf.closeForm('T2', NEXT);
  assert.deepEqual(argsOf(hf.parseForm(close, 'C',
    '<conclusion>Verified</conclusion><outcome>close_done</outcome><next></next>')),
  { task: 'T2', conclusion: 'Verified', outcome: 'close_done' });
  assert.deepEqual(argsOf(hf.parseForm(close, 'C',
    '<conclusion>Try again</conclusion><outcome>continue</outcome><next>reviewer</next>')),
  { task: 'T2', conclusion: 'Try again', outcome: 'continue', next: 'reviewer' });
  // continue 没写 next 由 task_handoff 执行时拒绝（§6.3），解析只管表单
  assert.deepEqual(argsOf(hf.parseForm(close, 'C', '<conclusion>c</conclusion><outcome>continue</outcome>')),
    { task: 'T2', conclusion: 'c', outcome: 'continue' });
  assert.match(hf.parseForm(close, 'C', '<conclusion>c</conclusion><outcome>done</outcome>').error,
    /^outcome "done" is not one of: close_done, close_failed, continue, need_user$/);
  assert.ok(!('evidence' in argsOf(hf.parseForm(close, 'C',
    '<conclusion>c</conclusion><outcome>need_user</outcome><evidence>#1</evidence>'))), 'no evidence for close');
  const request = hf.requestCloseForm(1);
  assert.deepEqual(argsOf(hf.parseForm(request, 'C', '<outcome>failed</outcome><conclusion>No fix</conclusion>')),
    { request: 1, conclusion: 'No fix', outcome: 'failed' });
  assert.match(hf.parseForm(request, 'C', '<outcome>close_done</outcome><conclusion>c</conclusion>').error,
    /^outcome "close_done" is not one of: done, failed$/);
  const long = 'c'.repeat(1000);
  assert.equal(argsOf(hf.parseForm(request, 'C', `<outcome>done</outcome><conclusion>${long}</conclusion>`))
    .conclusion, long, 'the request conclusion allows 1200 characters');
  assert.equal(hf.parseForm(request, 'C', `<outcome>done</outcome><conclusion>${'c'.repeat(1201)}</conclusion>`)
    .error, 'conclusion is longer than 1200 characters');
});

test('TB-18 B JSON parses: null means not filled, the fixed task and request are checked, non-JSON is rejected',
  () => {
    const task = hf.taskForm('T1', NEXT);
    const json = JSON.stringify({ task: null, conclusion: 'c', outcome: 'pass', next: null, open_items: null,
      evidence: ['#2', 3] });
    assert.deepEqual(argsOf(hf.parseForm(task, 'B', ` ${json}\n`)), { task: 'T1', conclusion: 'c', outcome: 'pass',
      evidence: ['#2', '3'] });
    assert.equal(argsOf(hf.parseForm(task, 'B', '{"task":"t1","conclusion":"c","outcome":"fail"}')).task, 't1');
    assert.equal(hf.parseForm(task, 'B', 'not json').error, 'the reply is not valid JSON');
    assert.equal(hf.parseForm(task, 'B', '{"conclusion":"c",').error, 'the reply is not valid JSON');
    assert.equal(hf.parseForm(task, 'B', '[1]').error, 'the reply is not a JSON object');
    assert.equal(hf.parseForm(task, 'B', '{"conclusion":3,"outcome":"done"}').error, 'conclusion must be a string');
    assert.equal(hf.parseForm(task, 'B', '{"conclusion":"c","outcome":"done","evidence":"#1"}').error,
      'evidence must be a list of tool result numbers');
    const close = hf.closeForm('T2', NEXT);
    assert.equal(hf.parseForm(close, 'B', '{"task":"T3","conclusion":"c","outcome":"close_done"}').error,
      'task must be T2');
    assert.equal(argsOf(hf.parseForm(close, 'B', '{"task":"t2","conclusion":"c","outcome":"close_done"}')).task,
      'T2');
    const request = hf.requestCloseForm(1);
    assert.equal(hf.parseForm(request, 'B', '{"request":2,"outcome":"done","conclusion":"c"}').error,
      'request must be 1');
    assert.deepEqual(argsOf(hf.parseForm(request, 'B', '{"request":1,"outcome":"done","conclusion":"c"}')),
      { request: 1, conclusion: 'c', outcome: 'done' });
  });

// ---- 与合成端点脚本模式的交接单一致（synthetic） ----

const sys = (...lines) => ({ role: 'system', content: lines.join('\n') });
const user = (content) => ({ role: 'user', content });
const said = (content) => ({ role: 'assistant', content });
/** 附录 A 句子里的 <…> 填上一个值（<n> 为 1，其余为 planner）。 */
const sample = (sentence) => sentence.replace(/<[^>]+>/g, (slot) => (slot === '<n>' ? '1' : 'planner'));
const card = (...lines) => user([WORK_CARD_OPEN, ...lines, WORK_CARD_CLOSE].join('\n'));
const TASK_SYSTEM = sys('You fix code. MORI-ROLE-executor', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.task);
const TASK_CARD = card('You are executor on T1 (request 1).', '- "Fix it tb-scenario:tb-selfcheck-task"');
const READ_DONE = [
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_r1', type: 'function',
    function: { name: 'read', arguments: '{"path":"README.md"}' } }] },
  { role: 'tool', tool_call_id: 'call_r1', content: '[#1] # Smoke project' },
];
const CLOSE_SYSTEM = sys('MORI-ROLE-planner tb-scenario:tb-selfcheck-close', sample(SHARED_SENTENCE),
  sample(SEGMENT_SENTENCES.close));
const CLOSE_CARD = card('You are planner, closing request 1.');

/** 合成端点对这个请求的回复（脚本模式）。 */
function endpointReply(body) {
  const { reply } = scriptReply(body, new Set(), sessionOf(body.messages));
  assert.ok(reply, 'the script answers');
  return reply;
}

test('TB-18 the synthetic endpoint\'s A, B and C handoffs agree with the forms', () => {
  const form = hf.taskForm('T1', NEXT);
  const forcedHint = (mode) => user(`[Mori] Your turn ended without task_handoff. Hand off T1 now.\n${
    hf.formatHint(form, mode)}`);
  const messages = (mode) => [TASK_SYSTEM, user('[Mori] Start T1.'), ...READ_DONE, said('I read it.'),
    forcedHint(mode), TASK_CARD];
  const expected = { task: 'T1', conclusion: 'README.md was read', outcome: 'done', evidence: ['#1'] };
  const c = endpointReply({ messages: messages('C') });
  assert.deepEqual(argsOf(hf.parseForm(form, 'C', c.text)), expected, c.text);
  const format = { type: 'json_schema', json_schema: { name: form.tool, schema: form.schema, strict: true } };
  const b = endpointReply({ messages: messages('B'), response_format: format });
  assert.deepEqual(argsOf(hf.parseForm(form, 'B', b.text)), expected, b.text);
  const tool = { type: 'function', function: { name: 'task_handoff', parameters: form.schema, strict: true } };
  const a = endpointReply({ messages: messages('A'), tools: [tool], tool_choice: forced.forcedToolChoice(
    'openai-completions', 'task_handoff') });
  assert.equal(a.toolCalls[0].name, 'task_handoff');
  assert.deepEqual(Object.keys(a.toolCalls[0].args).sort(), Object.keys(form.schema.properties).sort(),
    'strict: every field of the schema is present');
  assert.deepEqual(argsOf(hf.checkForm(form, a.toolCalls[0].args)), expected);
  const retry = [...messages('C').slice(0, -1), said('<outcome>'),
    user(`[Mori] Your handoff could not be used: outcome is required. Hand off T1 now.\n${hf.formatHint(form, 'C')}`),
    TASK_CARD];
  assert.equal(hf.parseForm(form, 'C', endpointReply({ messages: retry }).text).error, 'outcome is required');
  assert.equal(hf.parseForm(form, 'B', endpointReply({ messages: retry, response_format: format }).text).error,
    'the reply is not valid JSON');
});

test('TB-18 the synthetic endpoint\'s close and forced request_close tags agree with the forms', () => {
  const close = hf.closeForm('T1', NEXT);
  const closeHint = user(`[Mori] T1 was handed to you and you didn't decide. Hand it off now.\n${
    hf.formatHint(close, 'C')}`);
  const base = [CLOSE_SYSTEM, user('[Mori] T1 was handed to you: done.'), said('Looking.'), closeHint];
  const decided = endpointReply({ messages: [...base, CLOSE_CARD] });
  assert.deepEqual(argsOf(hf.parseForm(close, 'C', decided.text)),
    { task: 'T1', conclusion: 'Fixed and verified', outcome: 'close_done' }, decided.text);
  const request = hf.requestCloseForm(1);
  const closeNow = (mode) => user('[Mori] All tasks of request 1 have ended and it is still open. Close it now with '
    + `request_close.\n${hf.formatHint(request, mode)}`);
  const tags = endpointReply({ messages: [...base, said('Done.'), closeNow('C'), CLOSE_CARD] });
  const expected = { request: 1, conclusion: 'The login page works again', outcome: 'done' };
  assert.deepEqual(argsOf(hf.parseForm(request, 'C', tags.text)), expected, tags.text);
  const format = { type: 'json_schema', json_schema: { name: request.tool, schema: request.schema, strict: true } };
  const json = endpointReply({ messages: [...base, said('Done.'), closeNow('B'), CLOSE_CARD],
    response_format: format });
  assert.deepEqual(argsOf(hf.parseForm(request, 'B', json.text)), expected, json.text);
});
