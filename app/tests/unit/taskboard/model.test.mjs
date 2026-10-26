// 模型层的平行 Agent 接口（docs/specs/parallel-agents-taskboard.md §12、§8.3 最后一条、§14.4）的单元测试：
// 选择器第 3 步的 requires 与 same_family、候选来源与协作模式下的锁定、task 会话中途换模型的重来、上下文规则、
// 工作卡在换模型重发时的位置、每次尝试的请求改写、调度类别与留出的槽位、继续会话时窗口估算加上工作卡。
// 模型层与 pi 会话是替身（synthetic），模型池的端点是替身 fetch（synthetic），key 都是测试用的假值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock, loadKernelModule } from '../load.mjs';

const selector = await loadKernelModule('src/kernel/selector.ts');
const context = await loadKernelModule('src/kernel/modelContext.ts');
const { ModelSession, PICK_LOCKED_MESSAGE } = await loadKernelModule('src/kernel/modelSession.ts');
const { createModelPool } = await loadKernelModule('src/kernel/modelPool.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');
const { ModelLayer } = await loadKernelModule('src/kernel/modelLayer.ts');
const mp = await loadKernelModule('src/kernel/modelProfiles.ts');
const mc = await loadKernelModule('src/kernel/modelConfig.ts');

const TOOL_CALLING = [{ kind: 'tool_calling' }];

/** 全部满足的档案能力（synthetic）。 */
function caps(over = {}) {
  return { tier: 'A', protocolWrite: 'verified', structuredOutput: 'verified', vision: 'unverified',
    effectiveWindow: 131072, probing: false, ...over };
}

/** 选择器输入：默认全部存在、tool_calling 已验证、可用。 */
function input(candidates, over = {}) {
  const { tools = {}, capsOf = {}, families = {}, ...rest } = over;
  return {
    candidates, exists: () => true,
    toolCalling: (ref) => tools[ref] ?? 'verified', availability: () => ({ available: true }),
    capabilities: (ref) => caps(capsOf[ref]), familyOf: (ref) => families[ref] ?? ref, now: 1_000_000, ...rest,
  };
}

// ---- TB-38 选择器第 3 步：requires ----

test('TB-38 each requirement is judged on the profile: verified, tier, vision, effective window', () => {
  const judge = selector.requirementExclusion;
  assert.equal(judge({ kind: 'tool_calling' }, caps({ protocolWrite: 'failed' })), null);
  assert.equal(judge({ kind: 'protocol_write', min: 'C' }, caps({ tier: 'C' })), null);
  assert.deepEqual(judge({ kind: 'protocol_write', min: 'B' }, caps({ tier: 'C' })),
    { reason: 'requires_unmet', detail: 'handoff tier C is below B' });
  assert.equal(judge({ kind: 'protocol_write', min: 'B' }, caps({ tier: 'B' })), null);
  assert.equal(judge({ kind: 'protocol_write', min: 'B' }, caps({ tier: 'A' })), null);
  assert.deepEqual(judge({ kind: 'protocol_write', min: 'B' }, caps({ tier: null, protocolWrite: 'unverified' })),
    { reason: 'requires_unmet', detail: 'protocol_write not verified' });
  assert.deepEqual(judge({ kind: 'protocol_write', min: 'C' }, caps({ tier: null, protocolWrite: 'failed' })),
    { reason: 'requires_unmet', detail: 'protocol_write failed verification' });
  assert.deepEqual(judge({ kind: 'structured_output' }, caps({ structuredOutput: 'unverified' })),
    { reason: 'requires_unmet', detail: 'structured_output not verified' });
  assert.equal(judge({ kind: 'vision' }, caps({ vision: 'unverified' })), null);
  assert.deepEqual(judge({ kind: 'vision' }, caps({ vision: 'failed' })),
    { reason: 'requires_unmet', detail: 'vision not declared in your model settings' });
  assert.equal(judge({ kind: 'context', tokens: 65536 }, caps({ effectiveWindow: 65536 })), null);
  assert.deepEqual(judge({ kind: 'context', tokens: 65536 }, caps({ effectiveWindow: 32768 })),
    { reason: 'requires_unmet', detail: 'effective window 32768 < 65536' });
});

test('TB-38 a model being probed is excluded as probing (recovers); requires_unmet does not recover', () => {
  const judge = selector.requirementExclusion;
  const probing = caps({ tier: null, protocolWrite: 'unverified', structuredOutput: 'unverified', probing: true });
  assert.deepEqual(judge({ kind: 'protocol_write', min: 'C' }, probing), { reason: 'probing', detail: 'verifying…' });
  assert.deepEqual(judge({ kind: 'protocol_write', min: 'B' }, probing), { reason: 'probing', detail: 'verifying…' });
  assert.deepEqual(judge({ kind: 'structured_output' }, probing), { reason: 'probing', detail: 'verifying…' });
  // 验证失败的能力在重新探测期间按旧结果，不算 probing
  assert.equal(judge({ kind: 'structured_output' }, { ...probing, structuredOutput: 'failed' }).reason,
    'requires_unmet');
  const requires = [{ kind: 'structured_output' }];
  const waiting = selector.select(input(['p/a'], { requires, capsOf: { 'p/a': probing } }));
  assert.equal(waiting.model, null);
  assert.equal(selector.canRecover(waiting.excluded), true);
  const unmet = selector.select(input(['p/a'], { requires, capsOf: { 'p/a': { structuredOutput: 'failed' } } }));
  assert.deepEqual(unmet.excluded.map((item) => item.reason), ['requires_unmet']);
  assert.equal(selector.canRecover(unmet.excluded), false);
  const clock = fakeClock();
  assert.equal(selector.exhaustionWait({ excluded: unmet.excluded, availability: () => ({ available: true }),
    waitStartedAt: clock.now(), now: clock.now(), timings: MODEL_TIMINGS }), null);
});

test('TB-38 a role picks by its requires: tool_calling first, then each requirement in order', () => {
  const requires = [{ kind: 'tool_calling' }, { kind: 'context', tokens: 65536 }, { kind: 'protocol_write', min: 'B' }];
  const result = selector.select(input(['p/a', 'p/b', 'p/c', 'p/d'], {
    requires, tools: { 'p/a': 'unverified' },
    capsOf: { 'p/a': { effectiveWindow: 1 }, 'p/b': { effectiveWindow: 32768, tier: 'C' }, 'p/c': { tier: 'C' } },
  }));
  assert.equal(result.model, 'p/d');
  assert.deepEqual(result.excluded, [
    { ref: 'p/a', reason: 'unverified', detail: 'tool calling not verified yet' },
    { ref: 'p/b', reason: 'requires_unmet', detail: 'effective window 32768 < 65536' },
    { ref: 'p/c', reason: 'requires_unmet', detail: 'handoff tier C is below B' },
  ]);
});

test('TB-38 sessions without role requirements never consult the capabilities (same as before)', () => {
  const capabilities = () => { throw new Error('capabilities must not be read'); };
  assert.equal(selector.select(input(['p/a'], { capabilities })).model, 'p/a');
  assert.equal(selector.select(input(['p/a'], { capabilities, requires: TOOL_CALLING })).model, 'p/a');
  assert.equal(selector.selectStatic(input(['p/a'], { capabilities, requires: TOOL_CALLING })).model, 'p/a');
  assert.throws(() => selector.select(input(['p/a'], { capabilities: undefined, requires: [{ kind: 'vision' }] })),
    /without the model capabilities/);
});

test('TB-38 the static check reports verifying while a role requirement waits for a probe', () => {
  const probing = { protocolWrite: 'unverified', tier: null, probing: true };
  const { blocked, first } = selector.staticCheck({ ...input(['p/a']), configError: null, projectError: null,
    pick: 'p', candidates: ['p/a'], requires: [{ kind: 'protocol_write', min: 'C' }],
    capabilities: () => caps(probing) });
  assert.equal(first, null);
  assert.equal(blocked.kind, 'verifying');
  assert.equal(blocked.detail, 'p/a');
});

// ---- TB-38 same_family（§12.9） ----

test('TB-38 differ_from: author excludes the author families; an empty family is the model itself', () => {
  assert.equal(selector.familyKey('qwen', 'p/a'), 'qwen');
  assert.equal(selector.familyKey('', 'p/a'), 'p/a');
  const families = { 'p/a': 'qwen', 'p/b': 'qwen', 'q/c': 'q/c', 'q/d': 'glm' };
  const avoid = new Set(['qwen', 'q/c']);
  const result = selector.select(input(['p/a', 'p/b', 'q/c', 'q/d'], { families, avoidFamilies: avoid }));
  assert.equal(result.model, 'q/d');
  assert.deepEqual(result.excluded.map((item) => [item.ref, item.reason, item.detail]), [
    ['p/a', 'same_family', 'same model family as the author (qwen)'],
    ['p/b', 'same_family', 'same model family as the author (qwen)'],
    ['q/c', 'same_family', 'same model family as the author (q/c)'],
  ]);
  assert.equal(selector.canRecover(result.excluded), false);
  // 能力要求在模型族之前判断；没有要避开的族时不看族
  const unmet = selector.select(input(['p/a'], { families, avoidFamilies: avoid, requires: [{ kind: 'vision' }],
    capsOf: { 'p/a': { vision: 'failed' } } }));
  assert.equal(unmet.excluded[0].reason, 'requires_unmet');
  assert.equal(selector.select(input(['p/a'], { families, avoidFamilies: new Set() })).model, 'p/a');
});

// ---- TB-38 候选来源（§12.1） ----

/** 两个提供商、一个分组的配置（synthetic）。 */
function pickConfig() {
  const model = (id, family = '', contextWindow = 100_000) => ({ id, family, contextWindow, maxTokens: 100,
    reasoning: false, input: ['text'] });
  const provider = (id, models) => ({ id, name: id.toUpperCase(), api: 'openai-completions',
    baseUrl: `http://127.0.0.1:9000/${id}`, compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1,
    models });
  return { version: 1, providers: [provider('a', [model('m1', 'qwen', 1000), model('m2', 'qwen')]),
    provider('b', [model('m1', 'glm')])], groups: [{ id: 'all', members: ['a', 'b'] }], normalDefault: 'all' };
}

test('TB-38 a role\'s models expand in order without repeats; the ask intersection keeps the role order', () => {
  const config = pickConfig();
  assert.deepEqual(selector.expandPicks(config, ['b', 'all', 'a/m1']), { refs: ['b/m1', 'a/m1', 'a/m2'],
    missing: null });
  assert.deepEqual(selector.expandPicks(config, ['b', 'nope', 'a']), { refs: [], missing: 'nope' });
  assert.deepEqual(selector.expandPicks(config, ['all']), { refs: selector.expandPick(config, 'all'), missing: null });
  assert.deepEqual(selector.intersectCandidates(['b/m1', 'a/m2', 'a/m1'], ['a/m1', 'b/m1']), ['b/m1', 'a/m1']);
  assert.deepEqual(selector.intersectCandidates(['b/m1'], ['a/m1']), []);
});

test('TB-38 blocked cards: Change model for your range, Turn off task mode when locked, neither for a role', () => {
  const base = { ...input(['p/a'], { tools: { 'p/a': 'failed' } }), configError: null, projectError: null,
    pick: 'p', candidates: ['p/a'] };
  assert.deepEqual(selector.staticCheck(base).blocked.actions, ['change_model', 'open_settings']);
  assert.deepEqual(selector.staticCheck({ ...base, modelAction: 'turn_off_team' }).blocked.actions,
    ['turn_off_team', 'open_settings']);
  assert.deepEqual(selector.staticCheck({ ...base, modelAction: null }).blocked.actions, ['open_settings']);
  assert.deepEqual(selector.staticCheck({ ...base, pick: null, modelAction: 'turn_off_team' }).blocked.actions,
    ['turn_off_team', 'open_settings']);
  assert.deepEqual(selector.staticCheck({ ...base, candidates: null, modelAction: null }).blocked.actions,
    ['open_settings']);
});

test('TB-01 agents_invalid wins over every other reason and lists the problems with Check again', () => {
  const problems = ['.mori/agents/a.md: unknown field "foo"', '.mori/agents/b.md: unknown seat "boss"'];
  const { blocked, first } = selector.staticCheck({ ...input(['p/a']), configError: 'bad config', projectError: null,
    pick: 'p', candidates: ['p/a'], agentProblems: problems });
  assert.equal(first, null);
  assert.deepEqual(blocked, { kind: 'agents_invalid', detail: '', candidates: [], actions: ['check_agents'],
    verifyRefs: [], problems });
  assert.equal(selector.staticCheck({ ...input(['p/a']), configError: null, projectError: null, pick: 'p',
    candidates: ['p/a'], agentProblems: [] }).blocked, null);
});

test('TB-38 the model menu marks ranges whose models all miss the dialog holder\'s requires', () => {
  const config = pickConfig();
  const options = selector.pickOptions({ ...input([]), config, requires: [{ kind: 'context', tokens: 50_000 }],
    capabilities: (ref) => caps({ effectiveWindow: ref === 'a/m1' ? 1000 : 100_000 }) });
  const byPick = Object.fromEntries(options.map((option) => [option.pick, option]));
  assert.equal(byPick['a/m1'].excluded, true);
  assert.equal(byPick['a/m1'].reason, 'a/m1 — effective window 1000 < 50000');
  assert.equal(byPick.a.excluded, false);
});

// ---- 替身：模型层与 pi 会话（synthetic） ----

/** pi 的实际模型（synthetic）。 */
function physical(providerId, modelId) {
  return { provider: providerId, id: modelId, name: modelId, api: 'openai-completions', reasoning: false,
    input: ['text'], contextWindow: 100_000, maxTokens: 100 };
}

/** 一条助手消息。 */
function assistant(model, content, timestamp, extra = {}) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return { role: 'assistant', content, api: model.api ?? 'openai-completions', provider: model.provider,
    model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
    stopReason: 'stop', timestamp, ...extra };
}

/** 一条用户消息。 */
const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });

/** 工作卡（pi-ai 的形状：pi 把 custom 消息转成 user）。 */
const card = (timestamp) => user(`${context.WORK_CARD_OPEN}\nYou are executor on T1 (request 1).\n`
  + `${context.WORK_CARD_CLOSE}`, timestamp);

/** fakeLayer 的模型池：只建 fetch，发出时按 state.status[ref]（默认 200）记一次尝试并回答。 */
function fakePool(state) {
  return {
    createFetch(options) {
      state.fetches.push(options);
      return async () => {
        const status = state.status[options.ref] ?? 200;
        options.onSent?.();
        const cls = status === 429 ? 'rate_limited' : 'ok';
        options.onRecord?.({ ref: options.ref, keyRef: null, cls, status, retryAfterMs: null, hadOutput: false,
          sentAt: Date.now() });
        return new Response('{}', { status });
      };
    },
    markModel() {}, markProvider() {},
  };
}

/**
 * 模型层的替身：按 pickConfig 回答第 1–4 步；avail、tools、status 可以在测试里改。
 * 模型池只建 fetch：发出时按 status[ref]（默认 200）记一次尝试并回答。
 */
function fakeLayer(config = pickConfig()) {
  const listeners = new Set();
  const state = { avail: {}, tools: {}, capsOf: {}, status: {}, fetches: [], config };
  const lookup = (ref) => {
    const [providerId, modelId] = ref.split('/');
    const provider = config.providers.find((item) => item.id === providerId);
    const model = provider?.models.find((item) => item.id === modelId);
    return provider && model ? { provider, model } : null;
  };
  const capabilities = (ref) => caps({ effectiveWindow: lookup(ref)?.model.contextWindow ?? 0,
    ...state.capsOf[ref] });
  const familyOf = (ref) => selector.familyKey(lookup(ref)?.model.family ?? '', ref);
  const pool = fakePool(state);
  const runtime = { registerVirtualModel() {}, async refresh() {}, unregisterVirtualModel() {},
    getModel: (p, id) => physical(p, id), getPhysicalModel: (p, id) => (lookup(`${p}/${id}`) ? physical(p, id)
      : undefined) };
  const layer = {
    timings: { ...MODEL_TIMINGS, exhaustionMaxWaitMs: 0 },
    onModelsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify(change) { for (const listener of listeners) listener(change); },
    getConfig: () => config,
    async projectContext() {
      return { project: null, projectError: null };
    },
    expandPicksIn: (_project, picks) => selector.expandPicks(config, picks),
    staticBase: () => ({ configError: null, projectError: null, exists: (ref) => !!lookup(ref),
      toolCalling: (ref) => state.tools[ref] ?? 'verified', capabilities, familyOf }),
    exists: (ref) => !!lookup(ref),
    toolCallingOf: (ref) => state.tools[ref] ?? 'verified',
    availabilityOf: (ref) => state.avail[ref] ?? { available: true },
    capabilitiesOf: capabilities,
    familyOf,
    lookupModel: lookup,
    profileOf: () => null,
    getPool: () => pool,
    async checkVersions() {},
    getRuntime: () => runtime,
  };
  return { layer, state };
}

/** pi 会话的替身：自定义条目写进内存里的分支。 */
function fakeManager() {
  const entries = [];
  return {
    entries,
    getBranch: () => entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: 'custom', customType, data, id: `e${entries.length + 1}` });
      return `e${entries.length}`;
    },
    buildSessionContext: () => ({ messages: [] }),
  };
}

/** pi 的流函数替身：记下每次调用；经 options.fetch 发出，HTTP 错误时推 error，否则回一段正文。 */
function fakeStream(calls) {
  return (model, transcript, options) => {
    calls.push({ ref: `${model.provider}/${model.id}`, context: transcript, options });
    return (async function* stream() {
      const response = await options.fetch('http://127.0.0.1:9000/chat', { method: 'POST', body: '{}' });
      if (response.status >= 400) {
        yield { type: 'error', reason: 'error', error: assistant(model, [], Date.now(),
          { stopReason: 'error', errorMessage: `${response.status} status code` }) };
        return;
      }
      const message = assistant(model, [{ type: 'text', text: 'ok' }], Date.now());
      yield { type: 'start', partial: message };
      yield { type: 'text_start', contentIndex: 0, partial: message };
      yield { type: 'done', reason: 'stop', message };
    })();
  };
}

/** 建一个接好替身的 ModelSession：新会话，范围为 normalDefault（all）。 */
async function modelSession(layer, options = {}) {
  const events = [];
  const calls = [];
  const model = await ModelSession.create({ layer, sessionId: 's1', cwd: 'D:\\p', emit: (event) => events.push(event),
    ...options });
  const manager = fakeManager();
  await model.loadPick(manager, true);
  const piSession = { sessionManager: manager, messages: [], thinkingLevel: 'off', compacted: 0,
    settingsManager: { applyOverrides() {} }, agent: { streamFunction: fakeStream(calls) }, abortCompaction() {},
    async compact() { this.compacted += 1; throw new Error('Nothing to compact'); } };
  model.attach(piSession);
  return { model, manager, piSession, events, calls };
}

/** 会话里一种自定义条目的数据。 */
const entriesOf = (manager, type) => manager.entries.filter((entry) => entry.customType === type)
  .map((entry) => entry.data);

/** 静默 console.error（候选耗尽、不排除的模型会记一条错误）。 */
function quiet(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
}

// ---- TB-38 候选来源与协作模式下的锁定（§12.1、§12.11） ----

test('TB-38 a role session picks from its own models and requires; candidateRefs gives them in order', async () => {
  const { layer, state } = fakeLayer();
  state.capsOf['b/m1'] = { tier: 'C' };
  const { model } = await modelSession(layer, { source: { kind: 'role', role: 'reviewer', models: ['b', 'a'],
    requires: [{ kind: 'tool_calling' }, { kind: 'protocol_write', min: 'B' }] }, schedClass: 'task' });
  assert.deepEqual(model.candidateRefs(), ['b/m1', 'a/m1', 'a/m2']);
  assert.equal(model.state().current, 'a/m1');
  assert.equal(model.state().pick, 'all');
  assert.equal(model.state().pickLocked, false);
  const missing = await modelSession(layer, { source: { kind: 'role', role: 'x', models: ['b', 'gone'],
    requires: TOOL_CALLING } });
  assert.equal(missing.model.state().blocked.kind, 'pick_missing');
  assert.equal(missing.model.state().blocked.detail, 'gone');
  assert.deepEqual(missing.model.state().blocked.actions, ['open_settings']);
  const rangeOnly = await modelSession(layer, { source: { kind: 'role', role: 'y', models: null,
    requires: TOOL_CALLING } });
  assert.deepEqual(rangeOnly.model.candidateRefs(), ['a/m1', 'a/m2', 'b/m1']);
});

test('TB-38 an off-mode ask only keeps the dialog session\'s candidates, in the asked role\'s order', async () => {
  const { layer } = fakeLayer();
  const dialog = await modelSession(layer);
  const { model } = await modelSession(layer, { source: { kind: 'role', role: 'memory', models: ['b', 'a/m2'],
    requires: TOOL_CALLING, within: () => ['a/m2', 'b/m1'] } });
  assert.deepEqual(model.candidateRefs(), ['b/m1', 'a/m2']);
  const none = await modelSession(layer, { source: { kind: 'role', role: 'memory', models: ['b'],
    requires: TOOL_CALLING, within: () => ['a/m1'] } });
  assert.deepEqual(none.model.candidateRefs(), []);
  assert.equal(none.model.state().blocked.kind, 'no_candidate');
  assert.deepEqual(dialog.model.candidateRefs(), ['a/m1', 'a/m2', 'b/m1']);
});

test('TB-38 team mode locks the dialog range: setPick rejected, no menu, range unchanged after off', async () => {
  const { layer, state } = fakeLayer();
  const { model, manager, events } = await modelSession(layer);
  const picks = entriesOf(manager, 'mori.pick').length;
  const locked = await model.setTeamLock(true, { kind: 'role', role: 'chat', models: ['b'], requires: TOOL_CALLING });
  assert.equal(locked.pickLocked, true);
  assert.equal(locked.current, 'b/m1');
  assert.equal(events.at(-1).type, 'mori.model_state');
  assert.equal(events.at(-1).pickLocked, true);
  await assert.rejects(model.setPick('a'), { message: PICK_LOCKED_MESSAGE });
  assert.deepEqual(await model.pickOptions(), { error: null, options: [] });
  state.tools['b/m1'] = 'failed';
  const blocked = await model.setTeamLock(true, { kind: 'role', role: 'chat', models: ['b'], requires: TOOL_CALLING });
  assert.deepEqual(blocked.blocked.actions, ['turn_off_team', 'open_settings']);
  const off = await model.setTeamLock(false, { kind: 'pick' });
  assert.equal(off.pickLocked, false);
  assert.equal(off.pick, 'all');
  assert.equal(off.current, 'a/m1');
  assert.equal(off.blocked, null);
  assert.equal(entriesOf(manager, 'mori.pick').length, picks, 'team mode writes no mori.pick');
  assert.ok((await model.pickOptions()).options.length > 0);
});

test('TB-38 the reviewer session avoids the author families, recomputed at every selection', async (t) => {
  quiet(t);
  const { layer } = fakeLayer();
  let families = new Set();
  const { model } = await modelSession(layer, { source: { kind: 'role', role: 'reviewer', models: ['all'],
    requires: TOOL_CALLING, avoidFamilies: () => families }, schedClass: 'task' });
  const signal = new AbortController().signal;
  assert.deepEqual(await model.prepare('[Mori] go', signal), { kind: 'ok' });
  assert.equal(model.state().current, 'a/m1');
  model.endReply();
  families = new Set(['qwen']);
  await model.prepare('[Mori] T1 is back with you.', signal);
  assert.equal(model.state().current, 'b/m1');
  model.endReply();
  families = new Set(['qwen', 'glm']);
  const unavailable = [];
  const blocked = await modelSession(layer, { source: { kind: 'role', role: 'reviewer', models: ['all'],
    requires: TOOL_CALLING, avoidFamilies: () => families }, onUnavailable: (info) => unavailable.push(info) });
  const result = await blocked.model.prepare('[Mori] go', signal);
  assert.equal(result.kind, 'unavailable');
  assert.deepEqual(result.candidates.map((item) => item.reason), ['same_family', 'same_family', 'same_family']);
  assert.deepEqual(unavailable, [{ candidates: result.candidates, firstRequest: true }]);
});

test('TB-01 agents_invalid stays through the model layer\'s re-checks until the problems are cleared', async () => {
  const { layer } = fakeLayer();
  const { model } = await modelSession(layer);
  const state = await model.setAgentProblems(['.mori/agents/a.md: unknown field "x"']);
  assert.equal(state.blocked.kind, 'agents_invalid');
  assert.deepEqual(state.blocked.problems, ['.mori/agents/a.md: unknown field "x"']);
  assert.equal(model.isBlocked(), true);
  layer.notify({ kind: 'config', removedRefs: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(model.state().blocked.kind, 'agents_invalid');
  assert.equal((await model.setAgentProblems([])).blocked, null);
});

// ---- TB-39 task 会话中途换模型（§12.4） ----

/** 一段已有过程的上下文：用户消息、a/m1 的工具调用与结果，时间戳在 base 之后。 */
function processContext(base) {
  const a = physical('a', 'm1');
  return [
    { role: 'system', content: 'system prompt', timestamp: 1 },
    user('[Mori] You are executor on T1 (request 1). Start work.', base + 1),
    assistant(a, [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }], base + 5),
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: '[#1] x' }],
      isError: false, timestamp: base + 6 },
  ];
}

/** 一个 task 实例的 ModelSession（executor，候选 all）。 */
function taskSession(layer, options = {}) {
  return modelSession(layer, { kind: 'task', schedClass: 'task',
    source: { kind: 'role', role: 'executor', models: ['all'], requires: TOOL_CALLING },
    restartText: (restart) => `[Mori] The model changed (${restart.from} → ${restart.to}). Continue T1.`,
    ...options });
}

test('TB-39 with partial work the run ends with MODEL_RESTART and writes mori.model_switch and mori.task_restart',
  async () => {
    const { layer, state } = fakeLayer();
    const { model, manager } = await taskSession(layer);
    const signal = new AbortController().signal;
    await model.prepare('[Mori] You are executor on T1 (request 1). Start work.', signal);
    const base = Date.now();
    const messages = processContext(base);
    state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
    await assert.rejects(model.route({ reason: 'continuation', messages, thinkingLevel: 'off', signal }),
      { message: 'MODEL_RESTART' });
    const [switched] = entriesOf(manager, 'mori.model_switch');
    assert.equal(switched.from, 'a/m1');
    assert.equal(switched.to, 'a/m2');
    assert.equal(switched.hideUntil, base + 6);
    const [restart] = entriesOf(manager, 'mori.task_restart');
    assert.deepEqual({ ...restart, at: 0 }, { at: 0, from: 'a/m1', to: 'a/m2', reason: 'rate_limited',
      detail: 'rate limited' });
    assert.ok(restart.at > base + 6, 'the restart point is after every message of the first half');
    assert.deepEqual(model.takeRestart(), { from: 'a/m1', to: 'a/m2', reason: 'rate_limited', detail: 'rate limited' });
    assert.equal(model.takeRestart(), null);
    const later = Date.now() + 1;
    const next = [...messages, user('[Mori] The model changed (a/m1 → a/m2). Continue T1.', later), card(later + 1)];
    assert.deepEqual(model.processMessages(next).map((message) => message.role), ['system', 'user', 'user']);
    assert.deepEqual(model.processMessages(next).slice(1), next.slice(-2));
  });

test('TB-39 the continuing run starts on the new model, not on the first candidate, and never picks the old one',
  async () => {
    const { layer, state } = fakeLayer();
    const { model } = await taskSession(layer);
    const signal = new AbortController().signal;
    await model.prepare('[Mori] Start work.', signal);
    state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
    await assert.rejects(model.route({ reason: 'continuation', messages: processContext(Date.now()),
      thinkingLevel: 'off', signal }), { message: 'MODEL_RESTART' });
    const restart = model.takeRestart();
    model.endReply();
    delete state.avail['a/m1'];
    await model.prepare('[Mori] The model changed.', signal, { prefer: restart.to, exclude: [restart.from] });
    assert.equal(model.state().current, 'a/m2');
    model.endReply();
    state.avail['a/m2'] = { available: false, reason: 'connection', until: null };
    await model.prepare('[Mori] The model changed.', signal, { prefer: restart.to, exclude: [restart.from] });
    assert.equal(model.state().current, 'b/m1', 'a/m1 stays excluded in this segment');
  });

test('TB-39 the new model\'s window is judged on the restarted context (work card + continuation)', async () => {
  const config = pickConfig();
  config.providers[0].models[1].contextWindow = 300;
  const { layer, state } = fakeLayer(config);
  const { model } = await taskSession(layer, { extraContextTokens: () => 250 });
  const signal = new AbortController().signal;
  await model.prepare('[Mori] Start work.', signal);
  state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
  await assert.rejects(model.route({ reason: 'continuation', messages: processContext(Date.now()),
    thinkingLevel: 'off', signal }), { message: 'MODEL_RESTART' });
  assert.equal(model.takeRestart().to, 'b/m1', 'a/m2 (300 tokens) cannot hold the card, the continuation and 100');
});

test('TB-39 a first request that fails is retargeted in place (no restart), with the work card still last',
  async () => {
    const { layer, state } = fakeLayer();
    const shapes = [];
    const { model, manager, piSession, calls } = await taskSession(layer, {
      shape: (attempt) => { shapes.push(attempt.ref); return null; } });
    const signal = new AbortController().signal;
    await model.prepare('[Mori] Start work.', signal);
    state.status['a/m1'] = 429;
    const base = Date.now();
    const sent = [user('[Mori] Start work.', base), card(base + 1)];
    const out = piSession.agent.streamFunction(physical('a', 'm1'), { systemPrompt: '', messages: sent },
      { sessionId: 's1', signal });
    const message = await out.result();
    assert.equal(message.stopReason, 'stop');
    assert.deepEqual(calls.map((call) => call.ref), ['a/m1', 'a/m2']);
    assert.deepEqual(calls[1].context.messages, sent);
    assert.deepEqual(shapes, ['a/m1', 'a/m2']);
    assert.equal(model.takeRestart(), null);
    assert.equal(entriesOf(manager, 'mori.task_restart').length, 0);
    assert.equal(entriesOf(manager, 'mori.model_switch').length, 1);
  });

test('TB-39 a failure after partial work inside the stream wrapper ends the run with MODEL_RESTART', async () => {
  const { layer, state } = fakeLayer();
  const { model, piSession, calls } = await taskSession(layer);
  const signal = new AbortController().signal;
  await model.prepare('[Mori] Start work.', signal);
  state.status['a/m1'] = 429;
  const base = Date.now();
  const out = piSession.agent.streamFunction(physical('a', 'm1'),
    { systemPrompt: '', messages: [...processContext(base), card(base + 7)] }, { sessionId: 's1', signal });
  const message = await out.result();
  assert.equal(message.stopReason, 'error');
  assert.equal(message.errorMessage, 'MODEL_RESTART');
  assert.equal(calls.length, 1, 'nothing more is sent in this run');
  assert.equal(model.takeRestart().to, 'a/m2');
});

test('TB-39 dialog, create, close and ask sessions keep the normal redo on a mid-run switch', async () => {
  const { layer, state } = fakeLayer();
  const { model, manager } = await modelSession(layer, { schedClass: 'decision',
    source: { kind: 'role', role: 'planner', models: ['all'], requires: TOOL_CALLING } });
  const signal = new AbortController().signal;
  await model.prepare('[Mori] decide', signal);
  state.avail['a/m1'] = { available: false, reason: 'rate_limited', until: null };
  const route = await model.route({ reason: 'continuation', messages: processContext(Date.now()),
    thinkingLevel: 'off', signal });
  assert.equal(`${route.model.provider}/${route.model.id}`, 'a/m2');
  assert.equal(model.takeRestart(), null);
  assert.equal(entriesOf(manager, 'mori.task_restart').length, 0);
});

test('TB-39 the restart rule hides every non-system message before the last restart point', () => {
  const restarts = [{ at: 50, from: 'a/m1', to: 'a/m2', reason: 'rate_limited', detail: 'rate limited' },
    { at: 100, from: 'a/m2', to: 'b/m1', reason: 'connection', detail: "can't connect" }];
  const messages = [
    { role: 'system', content: 'prompt', timestamp: 1 },
    user('first half', 10),
    { role: 'compactionSummary', summary: 'old', timestamp: 60 },
    { role: 'custom', customType: 'x', content: 'old note', timestamp: 70 },
    assistant(physical('a', 'm2'), [{ type: 'text', text: 'partial' }], 90),
    user('[Mori] The model changed', 101),
    card(102),
  ];
  const kept = context.applyRestartEntries(messages, restarts);
  assert.deepEqual(kept, [messages[0], messages[5], messages[6]]);
  assert.deepEqual(context.applyRestartEntries(kept, restarts), kept);
  assert.deepEqual(context.applyRestartEntries(messages, []), messages);
});

test('TB-39 compaction never summarizes the first half or carries an older summary across the restart', () => {
  const restarts = [{ at: 100, from: 'a/m1', to: 'a/m2', reason: 'rate_limited', detail: 'rate limited' }];
  const before = assistant(physical('a', 'm1'), [{ type: 'toolCall', id: 'c1', name: 'edit',
    arguments: { path: 'old.ts' } }], 50);
  const after = assistant(physical('a', 'm2'), [{ type: 'toolCall', id: 'c2', name: 'read',
    arguments: { path: 'new.ts' } }], 150);
  const prep = { messagesToSummarize: [user('go', 40), before, user('[Mori] The model changed', 120), after],
    turnPrefixMessages: [], previousSummary: 'first half summary',
    fileOps: { read: new Set(['new.ts', 'prev.ts']), written: new Set(), edited: new Set(['old.ts']) } };
  const entries = [{ type: 'compaction', timestamp: new Date(80).toISOString(),
    details: { readFiles: ['prev.ts'], modifiedFiles: [] } }];
  context.stripForCompaction(prep, [], context.previousFileLists(entries), restarts);
  context.forgetCompactionBeforeRestart(prep, entries, restarts);
  assert.deepEqual(prep.messagesToSummarize.map((message) => message.timestamp), [120, 150]);
  assert.equal(prep.previousSummary, undefined);
  assert.deepEqual([...prep.fileOps.read], ['new.ts']);
  assert.deepEqual([...prep.fileOps.edited], []);
  const fresh = { messagesToSummarize: [after], turnPrefixMessages: [], previousSummary: 'second half',
    fileOps: { read: new Set(['new.ts']), written: new Set(), edited: new Set() } };
  context.forgetCompactionBeforeRestart(fresh, [{ type: 'compaction', timestamp: new Date(130).toISOString() }],
    restarts);
  assert.equal(fresh.previousSummary, 'second half', 'a compaction after the restart point is kept');
});

// ---- TB-30 工作卡在换模型重发时仍在最后（§8.3） ----

test('TB-30 the work card is detached before model-layer processing and put back last', () => {
  const custom = { role: 'custom', customType: context.WORK_CARD_TYPE, content: 'x', display: false, timestamp: 9 };
  const asUser = card(9);
  assert.equal(context.isWorkCard(custom), true);
  assert.equal(context.isWorkCard(asUser), true);
  assert.equal(context.isWorkCard(user('see <mori-work-card> above', 9)), false);
  assert.equal(context.isWorkCard({ role: 'custom', customType: 'other', content: 'x', timestamp: 9 }), false);
  for (const last of [custom, asUser]) {
    const detached = context.detachWorkCard([user('a', 1), last]);
    assert.deepEqual(detached.messages, [user('a', 1)]);
    assert.equal(detached.card, last);
    assert.deepEqual(context.reattachWorkCard([user('b', 2)], detached.card), [user('b', 2), last]);
  }
  const plain = context.detachWorkCard([user('a', 1)]);
  assert.equal(plain.card, null);
  assert.deepEqual(context.reattachWorkCard(plain.messages, plain.card), [user('a', 1)]);
});

// ---- TB-18 每次尝试的请求改写（§7.5、§12.7、§14.4） ----

test('TB-18 shape is applied on every attempt by the model actually used, after pi\'s own onPayload', async () => {
  const { layer, state } = fakeLayer();
  const { model, piSession, calls } = await taskSession(layer, {
    shape: ({ ref, api }) => ({ toolChoice: { type: 'function', function: { name: 'task_handoff' } },
      payload: (payload) => ({ ...payload, shapedFor: `${ref} ${api}` }), thinkingOff: ref === 'a/m2' }),
  });
  const signal = new AbortController().signal;
  piSession.thinkingLevel = 'medium';
  await model.prepare('[Mori] Hand off T1 now.', signal);
  state.status['a/m1'] = 429;
  const out = piSession.agent.streamFunction(physical('a', 'm1'),
    { systemPrompt: '', messages: [user('[Mori] Hand off T1 now.', Date.now())] },
    { sessionId: 's1', signal, reasoning: 'medium', onPayload: (payload) => ({ ...payload, pi: true }) });
  await out.result();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.options.toolChoice, { type: 'function', function: { name: 'task_handoff' } });
  }
  assert.equal(calls[0].options.reasoning, 'medium');
  assert.equal(calls[1].options.reasoning, undefined, 'a/m2 turns thinking off for this request');
  await piSession.agent.streamFunction(physical('a', 'm2'), { systemPrompt: '', messages: [user('sum', 1)] },
    { sessionId: 'compaction', signal }).result();
  assert.equal(calls[2].options.toolChoice, undefined, 'compaction requests are not shaped');
  assert.deepEqual(await calls[0].options.onPayload({ a: 1 }, physical('a', 'm1')),
    { a: 1, pi: true, shapedFor: 'a/m1 openai-completions' });
  assert.deepEqual(await calls[1].options.onPayload({ a: 1 }, physical('a', 'm2')),
    { a: 1, pi: true, shapedFor: 'a/m2 openai-completions' });
});

// ---- TB-41 调度类别（§12.10） ----

test('TB-41 a session\'s requests and its compaction requests use its scheduling class', async () => {
  const { layer, state } = fakeLayer();
  const { model, piSession } = await taskSession(layer);
  const signal = new AbortController().signal;
  await model.prepare('[Mori] go', signal);
  await piSession.agent.streamFunction(physical('a', 'm1'), { systemPrompt: '', messages: [user('go', 1)] },
    { sessionId: 's1', signal }).result();
  await piSession.agent.streamFunction(physical('a', 'm1'), { systemPrompt: '', messages: [user('sum', 1)] },
    { sessionId: 'compaction', signal }).result();
  assert.deepEqual(state.fetches.map((options) => options.cls), ['task', 'task']);
  const dialog = await modelSession(layer);
  await dialog.model.prepare('hi', signal);
  await dialog.piSession.agent.streamFunction(physical('a', 'm1'), { systemPrompt: '', messages: [user('hi', 1)] },
    { sessionId: 's1', signal }).result();
  assert.equal(state.fetches.at(-1).cls, 'conversation');
});

/** 模型池的假时钟加假定时器：advance 按时刻顺序触发到期的定时器。 */
function fakeTimers() {
  const clock = fakeClock(1_000_000);
  const timers = new Map();
  let nextId = 0;
  const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    now: clock.now, flush,
    setTimeout(callback, ms) { nextId += 1; timers.set(nextId, { at: clock.now() + ms, callback }); return nextId; },
    clearTimeout(handle) { timers.delete(handle); },
    async advance(ms) {
      const target = clock.now() + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock.set(Math.max(clock.now(), due[1].at));
        due[1].callback();
        await flush();
      }
      clock.set(target);
      await flush();
    },
  };
}

/** 一个提供商 p（concurrency 由参数给出、一个 key）的模型池；端点的回答一直不结束，直到 release。 */
function poolSetup(concurrency) {
  const timers = fakeTimers();
  const open = [];
  const sent = [];
  const fetch = (_url, init) => new Promise((resolve) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    open.push(() => controller.close());
    sent.push(JSON.parse(init.body).who);
    resolve(new Response(body, { status: 200 }));
  });
  const pool = createModelPool({ timings: MODEL_TIMINGS, clock: timers, fetch, log: () => {} });
  pool.setProviders([{ id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/p',
    compat: {}, concurrency, keys: [{ ref: 'p#1', label: 'Key 1' }], nextKeyNumber: 2,
    models: [{ id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }] }]);
  pool.setKeys('p', [{ ref: 'p#1', secret: 'secret-p1' }]);
  /** 发一个请求：who 写进请求体，cls 为调度类别。 */
  const send = (who, cls, queue = []) => pool.createFetch({ ref: 'p/m1', api: 'openai-completions', sessionKey: who,
    cls, onQueue: (notice) => queue.push(notice.active) })('http://127.0.0.1:9000/p',
    { method: 'POST', body: JSON.stringify({ who }) });
  /** 结束第 index 个还开着的回答，并读完它（放开槽位）。 */
  const release = async (index, responses) => {
    open[index]();
    await responses[index].text();
    await timers.flush();
  };
  return { pool, timers, sent, send, release };
}

test('TB-41 waiting requests go strictly conversation > decision > task > background', async () => {
  const { pool, timers, sent, send, release } = poolSetup(1);
  const responses = [await send('holder', 'conversation')];
  const pending = [['bg', 'background'], ['task', 'task'], ['decision', 'decision'], ['chat', 'conversation']]
    .map(([who, cls]) => send(who, cls));
  await timers.flush();
  assert.equal(pool.queued('p'), 4);
  for (let i = 0; i < 4; i += 1) {
    await release(i, responses);
    responses.push(await pending[[3, 2, 1, 0][i]]);
  }
  assert.deepEqual(sent, ['holder', 'chat', 'decision', 'task', 'bg']);
});

test('TB-41 a queued decision request times out after 60 s; task and background requests never do', async () => {
  const { pool, timers, send } = poolSetup(1);
  await send('holder', 'task');
  const decision = send('planner', 'decision');
  const outcome = assert.rejects(decision, /Waited 60 s for a free slot on P/);
  const task = send('t2', 'task');
  const background = send('probe', 'background');
  await timers.advance(60_000);
  await outcome;
  await timers.advance(10 * 60_000);
  assert.equal(pool.queued('p'), 2);
  let settled = false;
  void Promise.race([task, background]).then(() => { settled = true; });
  await timers.flush();
  assert.equal(settled, false);
});

test('TB-41 four task instances on a concurrency-4 key leave a slot: the dialog request does not queue', async () => {
  const { pool, timers, sent, send, release } = poolSetup(4);
  const responses = [];
  for (const who of ['t1', 't2', 't3']) responses.push(await send(who, 'task'));
  const fourth = send('t4', 'task');
  await timers.flush();
  assert.deepEqual(sent, ['t1', 't2', 't3']);
  assert.equal(pool.queued('p'), 1);
  const queue = [];
  responses.push(await send('chat', 'conversation', queue));
  assert.deepEqual(queue, [], 'the conversation request takes the reserved slot without queueing');
  assert.equal(pool.inFlight('p'), 4);
  await release(0, responses);
  responses.push(await fourth);
  assert.deepEqual(sent, ['t1', 't2', 't3', 'chat', 't4']);
  await timers.advance(10 * 60_000);
  assert.equal(pool.inFlight('p'), 4);
});

test('TB-41 background requests share the cap; at concurrency 1 nothing is reserved', async () => {
  const four = poolSetup(4);
  await four.send('t1', 'task');
  await four.send('t2', 'task');
  await four.send('probe', 'background');
  void four.send('probe2', 'background');
  await four.timers.flush();
  assert.deepEqual(four.sent, ['t1', 't2', 'probe']);
  await four.send('planner', 'decision');
  assert.deepEqual(four.sent, ['t1', 't2', 'probe', 'planner']);
  const one = poolSetup(1);
  await one.send('t1', 'task');
  assert.deepEqual(one.sent, ['t1']);
  assert.equal(one.pool.queued('p'), 0);
});

// ---- TB-47 继续已有会话时模型变了（§12.6） ----

test('TB-47 the work card counts toward the handover window: too long for the first model, rebuilt, excluded',
  async () => {
    const { layer } = fakeLayer();
    const resumed = [user('fix it', 1), assistant(physical('b', 'm1'), [{ type: 'text', text: 'done' }], 2)];
    const plain = await modelSession(layer, { source: { kind: 'role', role: 'executor', models: ['a'],
      requires: TOOL_CALLING }, schedClass: 'task' });
    plain.piSession.messages = resumed;
    await plain.model.prepare('[Mori] T1 is back with you.', new AbortController().signal);
    assert.equal(plain.model.state().current, 'a/m1', 'without the card the context fits a/m1');
    assert.equal(plain.piSession.compacted, 0);
    const carded = await modelSession(layer, { source: { kind: 'role', role: 'executor', models: ['a'],
      requires: TOOL_CALLING }, schedClass: 'task', extraContextTokens: () => 950 });
    carded.piSession.messages = resumed;
    await carded.model.prepare('[Mori] T1 is back with you.', new AbortController().signal);
    assert.equal(carded.piSession.compacted, 1, 'the segment start rebuilds for a/m1 first');
    assert.deepEqual(entriesOf(carded.manager, 'mori.rebuild').map((entry) => [entry.model, entry.summary]),
      [['a/m1', false]]);
    assert.equal(carded.model.state().current, 'a/m2', 'still too long after the rebuild: a/m1 is excluded');
  });

test('TB-47 handoverCheck adds the work card estimate to the window and to the reported tokens', () => {
  const target = { provider: 'a', api: 'openai-completions', model: 'm1', replay: 'unknown', effectiveWindow: 1000,
    maxTokens: 100 };
  const messages = [user('x', 1), assistant({ provider: 'b', id: 'm1' }, [{ type: 'text', text: 'y' }], 2)];
  const base = context.handoverCheck({ messages, target, estimateTokens: () => 10 });
  assert.deepEqual(base, { differs: true, reasoningOk: true, fitsWindow: true, tokens: 20 });
  const withCard = context.handoverCheck({ messages, target, estimateTokens: () => 10, extraTokens: 881 });
  assert.deepEqual(withCard, { differs: true, reasoningOk: true, fitsWindow: false, tokens: 901 });
  assert.equal(context.handoverAction(withCard, 'start'), 'rebuild');
  assert.equal(context.handoverAction(withCard, 'rebuilt'), 'exclude');
  assert.equal(context.fitsWindow(900, target), true);
  assert.equal(context.fitsWindow(901, target), false);
});

// ---- TB-38 模型层的档案能力与模型族（§12.2、§12.9） ----

test('TB-38 the model layer reads capabilities from the profile, or from the settings without one', async () => {
  const config = pickConfig();
  config.providers[0].models[1].input = ['text', 'image'];
  const dir = mkdtempSync(join(tmpdir(), 'mori-tb-layer-'));
  const provider = config.providers[0];
  const target = { baseUrl: provider.baseUrl, api: provider.api, model: provider.models[0], compat: provider.compat };
  const pass = { outcome: 'pass', detail: null };
  const fail = { outcome: 'fail', detail: 'no' };
  const auto = { server: { kind: 'unknown', version: 'unknown' }, reported: 800, field: 'none',
    steps: { ready: pass, thinking: { outcome: 'not_applicable', detail: null }, call: pass, result: pass,
      replay: { outcome: 'not_applicable', detail: null }, a: fail, b: fail, c: pass } };
  const stored = mp.buildProfile({ target, auto, now: 5 });
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(dir, 'agent', 'models.json') };
  writeFileSync(paths.config, JSON.stringify(config));
  writeFileSync(paths.profiles, JSON.stringify({ version: 1, profiles: [stored] }));
  const runtime = { registerProvider() {}, unregisterProvider() {}, async refresh() {}, getModel() {},
    getProviders: () => [] };
  const layer = new ModelLayer(runtime, mc.reservedIds([]), paths, () => {});
  await layer.load({}, [], null);
  assert.deepEqual(layer.capabilitiesOf('a/m1'), { tier: 'C', protocolWrite: 'verified',
    structuredOutput: 'failed', vision: 'failed', effectiveWindow: 800, probing: false });
  assert.deepEqual(layer.capabilitiesOf('a/m2'), { tier: null, protocolWrite: 'unverified',
    structuredOutput: 'unverified', vision: 'unverified', effectiveWindow: 100_000, probing: false });
  assert.equal(layer.familyOf('a/m2'), 'qwen');
  assert.equal(layer.familyOf('gone/x'), 'gone/x');
  const project = await layer.projectContext(dir);
  assert.deepEqual(layer.expandPicksIn(project, ['b', 'a/m2', 'b/m1']), { refs: ['b/m1', 'a/m2'], missing: null });
  const base = layer.staticBase(project);
  assert.equal(base.familyOf('b/m1'), 'glm');
  assert.equal(base.capabilities('a/m1').tier, 'C');
});
