// kernel/modelContext.ts 的单元测试：§6.1 重做（隐藏、说明、压缩）、§6.2 接手判断、§6.3 第 3 步重建的角色规则。
// 消息按 pi 的两种形状构造：AgentMessage（context 钩子、压缩钩子）与 pi-ai Message（流函数包装）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const ctx = await loadKernelModule('src/kernel/modelContext.ts');
const {
  applySwitchEntries, applyRebuildEntries, handoverCheck, handoverAction, stripForCompaction, hideUntilOf, redoNote,
  previousFileLists,
} = ctx;

/** 本地时间 hh:mm:ss（§5.3 的 until 部分）。 */
const hhmmss = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** §5.3 界面文字列（按规格原文写出，不从实现取，免得与别的测试进程争用同一个打包文件）。 */
const REASON_TEXTS = {
  rate_limited: (until) => (until === null ? 'rate limited' : `rate limited until ${hhmmss(until)}`),
  connection: (until) => (until === null ? 'can’t connect' : `can’t connect until ${hhmmss(until)}`),
  timeout: (until) => (until === null ? 'no response' : `no response; unavailable until ${hhmmss(until)}`),
  held: (until) => (until === null ? 'waiting to make sure it stopped'
    : `waiting to make sure it stopped, until ${hhmmss(until)}`),
  queue_timeout: (ms) => `waited ${Math.round(ms / 1000)} s for a free slot`,
  no_handover: (error) => (error === null ? 'conversation too long for this model'
    : `couldn’t rebuild the conversation: ${error}`),
};

const A = { provider: 'ds', api: 'openai-completions', model: 'chat' };
const B = { provider: 'glm', api: 'openai-completions', model: 'glm-4.6' };

/** 用户消息（原消息、插话、排队消息）。 */
const user = (timestamp, content = `u${timestamp}`) => ({ role: 'user', content, timestamp });

/** 助手消息；calls 为工具调用的 [id, name, path]。 */
function assistant(timestamp, { who = A, text = `a${timestamp}`, thinking = false, calls = [], stop } = {}) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking: 'hmm', thinkingSignature: 'reasoning_content' });
  if (text) content.push({ type: 'text', text });
  for (const [id, name, path] of calls) content.push({ type: 'toolCall', id, name, arguments: { path } });
  return { role: 'assistant', content, ...who, usage: {}, stopReason: stop ?? (calls.length ? 'toolUse' : 'stop'),
    timestamp };
}

/** 工具结果。 */
const toolResult = (timestamp, id = `t${timestamp}`, extra = {}) => ({
  role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false,
  timestamp, ...extra,
});

/** 换模型条目。 */
function entry(replyStartedAt, anchorAt, hideUntil, over = {}) {
  return { from: 'ds/chat', to: 'glm/glm-4.6', reason: 'auth', detail: 'API key rejected', replyStartedAt, anchorAt,
    hideUntil, ...over };
}

const NOTE = redoNote('ds/chat', 'API key rejected');

/** 上一段（100–130）+ 这段（200 起：anchor 201，助手 210，工具 220，插话 225，助手 230）。 */
function conversation() {
  return [
    user(100), assistant(110, { calls: [['c1', 'read', 'old.txt']] }), toolResult(120, 'c1'), assistant(130),
    user(201), assistant(210, { calls: [['c2', 'edit', 'a.txt']] }), toolResult(220, 'c2'), user(225, 'steer'),
    assistant(230, { calls: [['c3', 'read', 'b.txt']] }),
  ];
}

// ---- §6.1 重做 ----

test('MP-15 hides assistant messages and tool results of this reply, keeps user messages and earlier replies', () => {
  const out = applySwitchEntries(conversation(), [entry(200, 201, 230)]);
  assert.deepEqual(out.map((m) => [m.role, m.timestamp]), [
    ['user', 100], ['assistant', 110], ['toolResult', 120], ['assistant', 130], ['user', 201], ['user', 225],
  ]);
});

test('MP-15 the note goes on the last steer at or before hideUntil, not a new message', () => {
  const out = applySwitchEntries(conversation(), [entry(200, 201, 230)]);
  assert.equal(out[4].content, 'u201');
  assert.equal(out[5].content, `steer\n\n${NOTE}`);
  assert.equal(out.filter((m) => m.role === 'user').length, 3);
});

test('MP-15 the note goes on the anchor when no steer came before hideUntil', () => {
  const messages = [...conversation().slice(0, 7), user(240, 'late steer')];
  const out = applySwitchEntries(messages, [entry(200, 201, 220)]);
  assert.equal(out.find((m) => m.timestamp === 201).content, `u201\n\n${NOTE}`);
  assert.equal(out.find((m) => m.timestamp === 240).content, 'late steer');
});

test('MP-15 the new model messages after hideUntil are not hidden', () => {
  const messages = [...conversation(), assistant(300, { who: B, calls: [['c4', 'read', 'c.txt']] }), toolResult(310)];
  const out = applySwitchEntries(messages, [entry(200, 201, 230)]);
  assert.deepEqual(out.slice(-2).map((m) => m.timestamp), [300, 310]);
});

test('MP-15 two switches in one reply: hidden ranges are unioned and only one note, from the last entry', () => {
  const messages = [...conversation(), assistant(300, { who: B }), toolResult(310), assistant(400)];
  const second = entry(200, 201, 310, { from: 'glm/glm-4.6', to: 'ds/chat', reason: 'rate_limited',
    detail: REASON_TEXTS.rate_limited(9_999_999) });
  const out = applySwitchEntries(messages, [entry(200, 201, 230), second]);
  assert.deepEqual(out.map((m) => m.timestamp), [100, 110, 120, 130, 201, 225, 400]);
  const notes = out.filter((m) => typeof m.content === 'string' && m.content.includes('[Mori]'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, `steer\n\n${redoNote('glm/glm-4.6', 'rate limited')}`);
});

test('MP-15 two switches applied to an already processed context: the old note is replaced, not kept', () => {
  const second = entry(200, 201, 310, { from: 'glm/glm-4.6', to: 'ds/chat', reason: 'rate_limited',
    detail: REASON_TEXTS.rate_limited(9_999_999) });
  const fresh = [...conversation(), assistant(300, { who: B }), toolResult(310)];
  const firstPass = applySwitchEntries(conversation(), [entry(200, 201, 230)]);
  const processed = [...firstPass, assistant(300, { who: B }), toolResult(310)];
  const out = applySwitchEntries(processed, [entry(200, 201, 230), second]);
  assert.deepEqual(out, applySwitchEntries(fresh, [entry(200, 201, 230), second]));
  const notes = out.filter((m) => typeof m.content === 'string' && m.content.includes('[Mori]'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, `steer\n\n${redoNote('glm/glm-4.6', 'rate limited')}`);
  const blocks = [user(201, [{ type: 'image', data: 'x', mimeType: 'image/png' }]), assistant(210), assistant(300)];
  const once = applySwitchEntries(blocks, [entry(200, 201, 210)]);
  const again = applySwitchEntries(once, [entry(200, 201, 210), entry(200, 201, 300, { from: 'glm/glm-4.6' })]);
  assert.deepEqual(again[0].content, [blocks[0].content[0], { type: 'text', text: redoNote('glm/glm-4.6',
    'API key rejected') }]);
});

test('MP-15 the note reason uses the UI text without the until part', () => {
  const out = applySwitchEntries(conversation(), [entry(200, 201, 230, { reason: 'held',
    detail: REASON_TEXTS.held(9_999_999) })]);
  assert.ok(out[5].content.endsWith('stopped partway through this reply (waiting to make sure it stopped). '
    + 'Its partial work is hidden from you. Files in the workspace may already have been changed; '
    + 'check before you redo anything.'));
});

test('MP-15 applying twice gives the same result and the input is not changed', () => {
  const messages = conversation();
  const before = JSON.stringify(messages);
  const once = applySwitchEntries(messages, [entry(200, 201, 230)]);
  const twice = applySwitchEntries(once, [entry(200, 201, 230)]);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(messages), before);
});

test('MP-15 no hidden process (hideUntil equals replyStartedAt): nothing removed, no note', () => {
  const messages = [user(100), assistant(110), user(201)];
  const out = applySwitchEntries(messages, [entry(200, 201, 200)]);
  assert.deepEqual(out, messages);
});

test('MP-15 note on array content: appended to the last text block, or a new text block after an image', () => {
  const textArray = [user(201, [{ type: 'text', text: 'look' }]), assistant(210)];
  const out = applySwitchEntries(textArray, [entry(200, 201, 210)]);
  assert.deepEqual(out[0].content, [{ type: 'text', text: `look\n\n${NOTE}` }]);
  const image = [user(201, [{ type: 'text', text: 'see' }, { type: 'image', data: 'x', mimeType: 'image/png' }])];
  const withImage = applySwitchEntries([...image, assistant(210)], [entry(200, 201, 210)]);
  assert.deepEqual(withImage[0].content.at(-1), { type: 'text', text: NOTE });
  assert.deepEqual(applySwitchEntries(withImage, [entry(200, 201, 210)]), withImage);
});

test('MP-15 queued message reply redone: the previous reply answer is still sent to the new model', () => {
  // 排队消息在 150 排进来（早于这段开始的 200）；上一段的回答 130–160 都早于 200。
  const messages = [user(100), assistant(130), toolResult(140), assistant(160), user(150, 'queued'),
    assistant(210), toolResult(220)];
  const out = applySwitchEntries(messages, [entry(200, 150, 220)]);
  assert.deepEqual(out.map((m) => m.timestamp), [100, 130, 140, 160, 150]);
  assert.equal(out[4].content, `queued\n\n${NOTE}`);
});

test('MP-15 queued during the previous reply tool calls: that reply kept whole, its steer gets no note', () => {
  // 上一段：100 用户，110 工具调用，115 插话（属于上一段），120 工具结果，130 回答；排队消息 112 排进来。
  const messages = [user(100), assistant(110, { calls: [['c1', 'read', 'x']] }), user(115, 'prev steer'),
    toolResult(120, 'c1'), assistant(130), user(112, 'queued'), assistant(210), toolResult(220)];
  const out = applySwitchEntries(messages, [entry(200, 112, 220)]);
  assert.deepEqual(out.map((m) => m.timestamp), [100, 110, 115, 120, 130, 112]);
  assert.equal(out[2].content, 'prev steer');
  assert.equal(out[5].content, `queued\n\n${NOTE}`);
});

test('MP-15 every reply with switches keeps its own note', () => {
  const messages = [user(101), assistant(110), assistant(150, { who: B }), user(201), assistant(210),
    assistant(250, { who: B })];
  const out = applySwitchEntries(messages, [entry(100, 101, 110), entry(200, 201, 210)]);
  assert.deepEqual(out.map((m) => m.timestamp), [101, 150, 201, 250]);
  assert.equal(out[0].content, `u101\n\n${NOTE}`);
  assert.equal(out[2].content, `u201\n\n${NOTE}`);
});

test('MP-15 other roles inside the hidden range are kept untouched', () => {
  const special = [
    { role: 'compactionSummary', summary: 's', tokensBefore: 10, timestamp: 205 },
    { role: 'branchSummary', summary: 'b', fromId: null, timestamp: 206 },
    { role: 'custom', customType: 'x', content: 'c', display: true, timestamp: 207 },
    { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false, truncated: false,
      timestamp: 208 },
  ];
  const out = applySwitchEntries([user(201), ...special, assistant(210)], [entry(200, 201, 210)]);
  assert.deepEqual(out.slice(1), special);
});

test('MP-15 works on pi-ai Message shape with a system message', () => {
  const system = { role: 'system', content: 'You are…', timestamp: 0 };
  const messages = [system, user(201), assistant(210), toolResult(220)];
  const out = applySwitchEntries(messages, [entry(200, 201, 220)]);
  assert.deepEqual(out, [system, { ...user(201), content: `u201\n\n${NOTE}` }]);
});

test('MP-15 hideUntil is the latest assistant or tool result time, or replyStartedAt when none is later', () => {
  assert.equal(hideUntilOf(conversation(), 200), 230);
  assert.equal(hideUntilOf([user(100), assistant(110), user(201)], 200), 200);
  assert.equal(hideUntilOf([], 200), 200);
  assert.equal(hideUntilOf([user(201), user(260)], 200), 200);
});

test('MP-15 compaction: hidden messages removed in place and paths seen only in hidden calls dropped', () => {
  const hiddenEdit = assistant(210, { calls: [['c2', 'edit', 'a.txt'], ['c3', 'read', 'shared.txt']] });
  const nested = toolResult(220, 'c2', { nestedCalls: { calls: [{ id: 'n', name: 'write', arguments: { path: 'n.txt' },
    status: 'ok' }], complete: true } });
  const summarize = [user(100), assistant(110, { calls: [['c1', 'read', 'shared.txt']] }), toolResult(120, 'c1'),
    user(201), hiddenEdit];
  const prefix = [nested, user(225)];
  const prep = {
    messagesToSummarize: summarize, turnPrefixMessages: prefix,
    fileOps: { read: new Set(['shared.txt', 'prior.txt']), written: new Set(['n.txt']), edited: new Set(['a.txt']) },
  };
  stripForCompaction(prep, [entry(200, 201, 230)]);
  assert.equal(prep.messagesToSummarize, summarize);
  assert.equal(prep.turnPrefixMessages, prefix);
  assert.deepEqual(summarize.map((m) => m.timestamp), [100, 110, 120, 201]);
  assert.deepEqual(prefix.map((m) => m.timestamp), [225]);
  assert.deepEqual([...prep.fileOps.read].sort(), ['prior.txt', 'shared.txt']);
  assert.deepEqual([...prep.fileOps.written], []);
  assert.deepEqual([...prep.fileOps.edited], []);
});

test('MP-15 compaction without switch entries leaves the preparation alone', () => {
  const summarize = [user(100), assistant(110, { calls: [['c1', 'edit', 'a.txt']] })];
  const prep = { messagesToSummarize: summarize, turnPrefixMessages: [], fileOps: { read: new Set(),
    written: new Set(), edited: new Set(['a.txt']) } };
  stripForCompaction(prep, []);
  assert.equal(summarize.length, 2);
  assert.deepEqual([...prep.fileOps.edited], ['a.txt']);
});

test('MP-15 hidden range is inclusive at both ends: replyStartedAt and hideUntil hidden, one ms later kept', () => {
  const messages = [user(199), assistant(200), toolResult(230), assistant(231, { who: B })];
  const out = applySwitchEntries(messages, [entry(200, 199, 230)]);
  assert.deepEqual(out.map((m) => m.timestamp), [199, 231]);
});

test('MP-15 a message queued before the switch belongs to the next reply: the note stays on this reply', () => {
  // 这段：anchor 201，插话 225；排队消息 226 在换模型（hideUntil 230）之前排进来，在新模型回答 300 之后才送达。
  const messages = [...conversation(), assistant(300, { who: B }), user(226, 'queued'), assistant(400, { who: B })];
  const out = applySwitchEntries(messages, [entry(200, 201, 230)]);
  assert.deepEqual(out.map((m) => m.timestamp), [100, 110, 120, 130, 201, 225, 300, 226, 400]);
  assert.equal(out[5].content, `steer\n\n${NOTE}`);
  assert.equal(out[7].content, 'queued');
  const noSteer = [user(201), assistant(210), assistant(300, { who: B }), user(215, 'queued')];
  const plain = applySwitchEntries(noSteer, [entry(200, 201, 210)]);
  assert.equal(plain[0].content, `u201\n\n${NOTE}`);
  assert.equal(plain[2].content, 'queued');
});

test('MP-15 second switch computed on the processed context: the note still covers the first hidden range', () => {
  // 第二次换模型时上下文已去掉 A 的过程，B 还没有输出，所以第二条的 hideUntil 等于 replyStartedAt。
  const second = entry(200, 201, 200, { from: 'glm/glm-4.6', to: 'ds/chat', reason: 'rate_limited',
    detail: REASON_TEXTS.rate_limited(9_999_999) });
  const out = applySwitchEntries(conversation(), [entry(200, 201, 230), second]);
  assert.deepEqual(out.map((m) => m.timestamp), [100, 110, 120, 130, 201, 225]);
  assert.equal(out[4].content, 'u201');
  assert.equal(out[5].content, `steer\n\n${redoNote('glm/glm-4.6', 'rate limited')}`);
});

test('MP-15 compaction: each file set is checked on its own (a kept read does not keep a hidden edit)', () => {
  const summarize = [user(100), assistant(110, { calls: [['c1', 'read', 'a.txt']] }), toolResult(120, 'c1'),
    user(201), assistant(210, { calls: [['c2', 'edit', 'a.txt'], ['c3', 'write', 'b.txt']] }), toolResult(220, 'c2')];
  const prep = { messagesToSummarize: summarize, turnPrefixMessages: [],
    fileOps: { read: new Set(['a.txt']), written: new Set(['b.txt']), edited: new Set(['a.txt']) } };
  stripForCompaction(prep, [entry(200, 201, 230)]);
  assert.deepEqual([...prep.fileOps.read], ['a.txt']);
  assert.deepEqual([...prep.fileOps.written], []);
  assert.deepEqual([...prep.fileOps.edited], []);
});

test('MP-15 compaction: paths from the previous compaction and non-file tools are kept', () => {
  const summarize = [user(201), assistant(210, { calls: [['c1', 'read', 'old.txt'], ['c2', 'edit', 'mod.txt'],
    ['c3', 'ls', 'dir']] }), toolResult(220, 'c1')];
  const prep = { messagesToSummarize: summarize, turnPrefixMessages: [],
    fileOps: { read: new Set(['old.txt', 'dir']), written: new Set(), edited: new Set(['mod.txt']) } };
  stripForCompaction(prep, [entry(200, 201, 230)], { readFiles: ['old.txt'], modifiedFiles: ['mod.txt'] });
  assert.deepEqual(summarize.map((m) => m.timestamp), [201]);
  assert.deepEqual([...prep.fileOps.read].sort(), ['dir', 'old.txt']);
  assert.deepEqual([...prep.fileOps.edited], ['mod.txt']);
});

test('MP-15 compaction: previous file lists come from the last pi-generated compaction entry', () => {
  const details = { readFiles: ['r.txt'], modifiedFiles: ['m.txt'] };
  const compaction = (over) => ({ type: 'compaction', summary: 's', ...over });
  assert.equal(previousFileLists([]), null);
  assert.equal(previousFileLists([{ type: 'message' }]), null);
  assert.deepEqual(previousFileLists([compaction({ details: { readFiles: ['x'] } }), { type: 'message' },
    compaction({ details })]), details);
  assert.equal(previousFileLists([compaction({ details }), compaction({ details, fromHook: true })]), null);
  assert.equal(previousFileLists([compaction({})]), null);
});

// ---- §6.3 第 3 步 重建 ----

/** 重建前的对话：思考、工具调用、工具结果、各种角色；重建条目 at = 500。 */
function beforeRebuild() {
  return [
    { role: 'compactionSummary', summary: 'earlier', tokensBefore: 9000, timestamp: 90 },
    user(100),
    assistant(110, { thinking: true, text: 'plan', calls: [['c1', 'read', 'x']] }),
    toolResult(120, 'c1'),
    assistant(130, { text: '', calls: [['c2', 'read', 'y']] }),
    toolResult(140, 'c2'),
    { role: 'bashExecution', command: 'ls', output: 'a', exitCode: 0, cancelled: false, truncated: false,
      timestamp: 150 },
    { role: 'custom', customType: 'x', content: 'c', display: true, timestamp: 160 },
    { role: 'branchSummary', summary: 'b', fromId: null, timestamp: 170 },
    assistant(180, { thinking: true, text: 'done' }),
    user(600),
    assistant(610, { thinking: true, who: B, calls: [['c3', 'read', 'z']] }),
    toolResult(620, 'c3'),
  ];
}

test('MP-21 rebuild drops tool results and thinking/tool-call blocks before at; other roles kept', () => {
  const out = applyRebuildEntries(beforeRebuild(), [{ model: 'glm/glm-4.6', at: 500, summary: true }]);
  assert.deepEqual(out.map((m) => [m.role, m.timestamp]), [
    ['compactionSummary', 90], ['user', 100], ['assistant', 110], ['bashExecution', 150], ['custom', 160],
    ['branchSummary', 170], ['assistant', 180], ['user', 600], ['assistant', 610], ['toolResult', 620],
  ]);
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'plan' }]);
  assert.deepEqual(out[6].content, [{ type: 'text', text: 'done' }]);
  assert.equal(out[8].content.length, 3);
});

test('MP-21 rebuild with summary keeps the compaction summary; an assistant message left empty is dropped', () => {
  const out = applyRebuildEntries(beforeRebuild(), [{ model: 'glm/glm-4.6', at: 500, summary: true }]);
  assert.equal(out[0].summary, 'earlier');
  assert.equal(out.some((m) => m.timestamp === 130), false);
});

test('MP-21 rebuild is idempotent, does not change its input, and uses the latest entry', () => {
  const messages = beforeRebuild();
  const before = JSON.stringify(messages);
  const entries = [{ model: 'ds/chat', at: 50, summary: false }, { model: 'glm/glm-4.6', at: 500, summary: false }];
  const once = applyRebuildEntries(messages, entries);
  assert.deepEqual(applyRebuildEntries(once, entries), once);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(applyRebuildEntries(messages, []), messages);
});

test('MP-21 rebuild on pi-ai Message shape (converted summary is a user message, system kept)', () => {
  const messages = [
    { role: 'system', content: 'sys', timestamp: 0 },
    { role: 'user', content: [{ type: 'text', text: '<summary>s</summary>' }], timestamp: 90 },
    assistant(110, { thinking: true, calls: [['c1', 'read', 'x']] }), toolResult(120, 'c1'),
  ];
  const out = applyRebuildEntries(messages, [{ model: 'glm/glm-4.6', at: 500, summary: true }]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant']);
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'a110' }]);
});

test('MP-21 rebuild keeps messages at or after at untouched; messages without a timestamp are processed', () => {
  const late = assistant(500, { thinking: true, calls: [['c', 'read', 'x']] });
  const noTime = { role: 'toolResult', toolCallId: 'n', toolName: 'read', content: [], isError: false };
  const out = applyRebuildEntries([noTime, late, toolResult(500, 'c')], [{ model: 'glm/glm-4.6', at: 500,
    summary: false }]);
  assert.deepEqual(out, [late, toolResult(500, 'c')]);
  assert.equal(out[0], late);
});

// ---- §6.2 接手判断 ----

const estimate = () => 100;

/** 目标模型 B。 */
const target = (over = {}) => ({ ...B, replay: 'required', effectiveWindow: 10_000, maxTokens: 1_000, ...over });

test('MP-21 same model as the last valid assistant message: no handover check', () => {
  const messages = [user(1), assistant(2, { who: B, calls: [['c', 'read', 'x']] }), toolResult(3)];
  const check = handoverCheck({ messages, target: target({ effectiveWindow: 10 }), estimateTokens: estimate });
  assert.deepEqual(check, { differs: false, reasoningOk: true, fitsWindow: true, tokens: 300 });
  assert.equal(handoverCheck({ messages: [user(1)], target: target(), estimateTokens: estimate }).differs, false);
});

test('MP-21 errored or aborted assistant messages do not count as the last model', () => {
  const messages = [user(1), assistant(2, { who: B }), assistant(3, { who: A, stop: 'error' }),
    assistant(4, { who: A, stop: 'aborted' })];
  assert.equal(handoverCheck({ messages, target: target(), estimateTokens: estimate }).differs, false);
});

test('MP-21 a different provider, api or model id counts as a different model', () => {
  for (const who of [{ ...B, provider: 'x' }, { ...B, api: 'anthropic-messages' }, { ...B, model: 'glm-4.5' }]) {
    const messages = [user(1), assistant(2, { who })];
    assert.equal(handoverCheck({ messages, target: target(), estimateTokens: estimate }).differs, true);
  }
});

test('MP-21 replay required and another model made tool calls: reasoning condition fails', () => {
  const messages = [user(1), assistant(2, { calls: [['c', 'read', 'x']] }), toolResult(3), assistant(4)];
  const check = handoverCheck({ messages, target: target(), estimateTokens: estimate });
  assert.equal(check.reasoningOk, false);
  assert.equal(handoverAction(check, 'start'), 'rebuild');
  assert.equal(handoverAction(check, 'in_reply'), 'strip');
});

test('MP-21 reasoning condition holds when replay is not required or only B made tool calls', () => {
  const foreign = [user(1), assistant(2, { calls: [['c', 'read', 'x']] }), toolResult(3), assistant(4)];
  assert.equal(handoverCheck({ messages: foreign, target: target({ replay: 'not_required' }),
    estimateTokens: estimate }).reasoningOk, true);
  assert.equal(handoverCheck({ messages: foreign, target: target({ replay: 'unknown' }),
    estimateTokens: estimate }).reasoningOk, true);
  const own = [user(1), assistant(2, { who: B, calls: [['c', 'read', 'x']] }), toolResult(3), assistant(4)];
  assert.equal(handoverCheck({ messages: own, target: target(), estimateTokens: estimate }).reasoningOk, true);
  const textOnly = [user(1), assistant(2)];
  assert.equal(handoverCheck({ messages: textOnly, target: target(), estimateTokens: estimate }).reasoningOk, true);
});

test('MP-21 window: estimated tokens plus B maxTokens over the effective window fails', () => {
  const messages = [user(1), assistant(2)];
  const fits = handoverCheck({ messages, target: target({ effectiveWindow: 1_200 }), estimateTokens: estimate });
  assert.equal(fits.fitsWindow, true);
  assert.equal(fits.tokens, 200);
  const over = handoverCheck({ messages, target: target({ effectiveWindow: 1_199 }), estimateTokens: estimate });
  assert.equal(over.fitsWindow, false);
  assert.equal(handoverAction(over, 'start'), 'rebuild');
  assert.equal(handoverAction(over, 'rebuilt'), 'exclude');
  assert.equal(handoverAction(over, 'in_reply'), 'exclude');
});

test('MP-21 estimateTokens is called once per message of the processed context', () => {
  const seen = [];
  const messages = [user(1), assistant(2)];
  handoverCheck({ messages, target: target(), estimateTokens: (m) => { seen.push(m.timestamp); return 1; } });
  assert.deepEqual(seen, [1, 2]);
});

test('MP-21 after a rebuild the reasoning condition holds and only the window decides', () => {
  const rebuilt = applyRebuildEntries(
    [user(1), assistant(2, { thinking: true, calls: [['c', 'read', 'x']] }), toolResult(3), assistant(4)],
    [{ model: 'glm/glm-4.6', at: 10, summary: false }]);
  const check = handoverCheck({ messages: rebuilt, target: target(), estimateTokens: estimate });
  assert.equal(check.reasoningOk, true);
  assert.equal(handoverAction(check, 'rebuilt'), 'ok');
  assert.equal(handoverAction({ ...check, fitsWindow: true }, 'start'), 'ok');
});

test('MP-21 in reply: both conditions failing excludes B; after a rebuild only the window decides', () => {
  const both = { differs: true, reasoningOk: false, fitsWindow: false, tokens: 1 };
  assert.equal(handoverAction(both, 'in_reply'), 'exclude');
  assert.equal(handoverAction(both, 'start'), 'rebuild');
  assert.equal(handoverAction({ ...both, fitsWindow: true }, 'rebuilt'), 'ok');
  assert.equal(handoverAction({ differs: false, reasoningOk: true, fitsWindow: true, tokens: 1 }, 'in_reply'), 'ok');
});
