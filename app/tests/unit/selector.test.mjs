// kernel/selector.ts 的单元测试：§5.1 展开、§5.3 选择器第 1–6 步与段内规则、§4.6 静态校验、§9.2 顶栏菜单各项、
// §5.8 候选耗尽。
// 时刻一律由假时钟给出（§12）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, loadKernelModule } from './load.mjs';

const selector = await loadKernelModule('src/kernel/selector.ts');
const {
  expandPick, select, selectStatic, staticCheck, checkCurrent, canRecover, exhaustionWait,
  RECOVERING_REASONS, providerOf, pickOptions,
} = selector;

/** 一个模型配置项。 */
function model(id) {
  return { id, family: '', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'] };
}

/** 一个提供商配置项。 */
function provider(id, zone, modelIds) {
  return {
    id, name: id.toUpperCase(), api: 'openai-completions', baseUrl: `http://${id}.test`, zone, compat: {},
    concurrency: 4, keys: [], nextKeyNumber: 1, models: modelIds.map(model),
  };
}

/** 三个提供商、两个分组的配置。 */
function config() {
  return {
    providers: [
      provider('local', 'local', ['qwen', 'llama', 'phi']),
      provider('glm', 'public', ['glm-4.6', 'glm-4.5']),
      provider('ds', 'public', ['chat', 'reasoner']),
    ],
    groups: [
      { id: 'cloud', members: ['ds/reasoner', 'glm', 'ds'] },
      { id: 'mixed', members: ['local', 'glm/glm-4.5', 'local/qwen'] },
    ],
  };
}

/**
 * 选择器输入：默认全部存在、区域 local 且允许、tool_calling 已验证、可用。
 * @param candidates 候选
 * @param over 覆盖的字段；zones / tools / avail 为按 ref 的表
 */
function input(candidates, over = {}) {
  const { zones = {}, tools = {}, avail = {}, missing = [], ...rest } = over;
  return {
    candidates,
    exists: (ref) => !missing.includes(ref),
    zoneOf: (ref) => (ref in zones ? zones[ref] : 'local'),
    allowedZones: ['local', 'intranet'],
    toolCalling: (ref) => tools[ref] ?? 'verified',
    availability: (ref) => avail[ref] ?? { available: true },
    now: 1_000_000,
    ...rest,
  };
}

/** 一段工作的状态。 */
function reply(current, { tried = [], skipped = [] } = {}) {
  return {
    startedAt: 900_000, anchorAt: 900_001, current,
    tried: new Map(tried.map(([ref, reason, detail]) => [ref, { reason, detail }])), skipped: new Set(skipped),
  };
}

/** 本地时间 hh:mm:ss（§5.3 的 until 部分）。 */
const hhmmss = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** §5.3 界面文字列（按规格原文写出，不从实现取，免得与别的测试进程争用同一个打包文件）。 */
const REASON_TEXTS = {
  rate_limited: (until) => (until === null ? 'rate limited' : `rate limited until ${hhmmss(until)}`),
  connection: (until) => (until === null ? "can't connect" : `can't connect until ${hhmmss(until)}`),
  timeout: (until) => (until === null ? 'no response' : `no response; unavailable until ${hhmmss(until)}`),
  held: (until) => (until === null ? 'waiting to make sure it stopped'
    : `waiting to make sure it stopped, until ${hhmmss(until)}`),
  queue_timeout: (ms) => `waited ${Math.round(ms / 1000)} s for a free slot`,
  no_handover: (error) => (error === null ? 'conversation too long for this model'
    : `couldn't rebuild the conversation: ${error}`),
};

/** §12 的候选耗尽时长。 */
const MODEL_TIMINGS = { exhaustionMaxWaitMs: 60_000, exhaustionRecheckMs: 5_000 };

const ABC = ['p/a', 'p/b', 'p/c'];

// ---- §5.1 展开 ----

test('MP-05 group members expand in listed order; provider member expands to its models in order', () => {
  assert.deepEqual(expandPick(config(), 'mixed'),
    ['local/qwen', 'local/llama', 'local/phi', 'glm/glm-4.5']);
});

test('MP-05 duplicates keep the first occurrence', () => {
  assert.deepEqual(expandPick(config(), 'cloud'), ['ds/reasoner', 'glm/glm-4.6', 'glm/glm-4.5', 'ds/chat']);
});

test('MP-05 provider pick expands to its models; model pick is itself', () => {
  assert.deepEqual(expandPick(config(), 'glm'), ['glm/glm-4.6', 'glm/glm-4.5']);
  assert.deepEqual(expandPick(config(), 'ds/chat'), ['ds/chat']);
});

test('MP-05 model ids may contain a slash: the provider is before the first slash', () => {
  const cfg = { providers: [provider('hf', 'local', ['org/name'])], groups: [] };
  assert.deepEqual(expandPick(cfg, 'hf/org/name'), ['hf/org/name']);
  assert.equal(providerOf('hf/org/name'), 'hf');
});

test('MP-30 a pick naming nothing in the config expands to null (pick_missing)', () => {
  assert.equal(expandPick(config(), 'gone'), null);
  assert.equal(expandPick(config(), 'glm/glm-9'), null);
  assert.equal(expandPick(config(), 'nope/x'), null);
});

test('MP-05 project config narrows a group to some members in the user group order', () => {
  assert.deepEqual(expandPick(config(), 'cloud', { cloud: ['ds', 'glm'] }),
    ['glm/glm-4.6', 'glm/glm-4.5', 'ds/chat', 'ds/reasoner']);
});

test('MP-05 project config narrows a provider member to models in the provider order', () => {
  assert.deepEqual(expandPick(config(), 'cloud', { cloud: ['glm/glm-4.5', 'ds/chat', 'glm/glm-4.6'] }),
    ['glm/glm-4.6', 'glm/glm-4.5', 'ds/chat']);
});

test('MP-05 project narrowing only applies to the named group', () => {
  assert.deepEqual(expandPick(config(), 'glm', { cloud: ['ds'] }), ['glm/glm-4.6', 'glm/glm-4.5']);
  assert.deepEqual(expandPick(config(), 'mixed', { cloud: ['ds'] }),
    ['local/qwen', 'local/llama', 'local/phi', 'glm/glm-4.5']);
});

// ---- §5.3 第 1–6 步 ----

test('MP-20 no reply: the first candidate passing steps 1-4 is chosen, earlier ones listed with reasons', () => {
  const clock = fakeClock();
  const until = clock.now() + 30_000;
  const result = select(input(ABC, { avail: { 'p/a': { available: false, reason: 'rate_limited', until } } }));
  assert.equal(result.model, 'p/b');
  assert.deepEqual(result.excluded,
    [{ ref: 'p/a', reason: 'rate_limited', detail: REASON_TEXTS.rate_limited(until) }]);
});

test('MP-30 step 1 missing, and the removed-during-reply text', () => {
  const result = select(input(ABC, { missing: ['p/a', 'p/b', 'p/c'], removedRefs: new Set(['p/b']) }));
  assert.equal(result.model, null);
  assert.deepEqual(result.excluded.map((item) => [item.reason, item.detail]), [
    ['missing', 'not in your model settings'],
    ['missing', 'removed from your model settings'],
    ['missing', 'not in your model settings'],
  ]);
});

test('MP-06 step 2: unconfirmed zone, then zone not allowed for the project', () => {
  const result = select(input(ABC, { zones: { 'p/a': null, 'p/b': 'public' } }));
  assert.equal(result.model, 'p/c');
  assert.deepEqual(result.excluded, [
    { ref: 'p/a', reason: 'zone_unconfirmed', detail: 'network zone not confirmed' },
    { ref: 'p/b', reason: 'zone_blocked', detail: 'zone public is not allowed for this project' },
  ]);
});

test('MP-06 a public provider passes once the project allows public', () => {
  const result = select(input(ABC, { zones: { 'p/a': 'public' }, allowedZones: ['local', 'public'] }));
  assert.equal(result.model, 'p/a');
});

test('MP-09 step 3: probing, unverified and failed tool calling are excluded with their texts', () => {
  const result = select(input(ABC, { tools: { 'p/a': 'probing', 'p/b': 'unverified', 'p/c': 'failed' } }));
  assert.equal(result.model, null);
  assert.deepEqual(result.excluded.map((item) => [item.reason, item.detail]), [
    ['probing', 'verifying…'], ['unverified', 'tool calling not verified yet'],
    ['failed', 'tool calling failed verification'],
  ]);
});

test('MP-29 step 4: each availability reason with its UI text', () => {
  const clock = fakeClock();
  const t = clock.advance(60_000);
  const refs = ['p/1', 'p/2', 'p/3', 'p/4', 'p/5', 'p/6', 'p/7'];
  const reasons = ['rate_limited', 'auth', 'quota', 'connection', 'not_found', 'timeout', 'held'];
  const untils = [t, null, null, t, null, t, t];
  const avail = Object.fromEntries(
    refs.map((ref, i) => [ref, { available: false, reason: reasons[i], until: untils[i] }]));
  const result = select(input(refs, { avail }));
  assert.equal(result.model, null);
  assert.deepEqual(result.excluded.map((item) => item.detail), [
    REASON_TEXTS.rate_limited(t), 'API key rejected', 'quota exhausted', REASON_TEXTS.connection(t),
    'model not found on the server', REASON_TEXTS.timeout(t), REASON_TEXTS.held(t),
  ]);
  assert.deepEqual(result.excluded.map((item) => item.reason), reasons);
});

test('MP-20 the first failing step is the reason, not a later step', () => {
  const result = select(input(['p/a'], {
    missing: ['p/a'], zones: { 'p/a': 'public' }, avail: { 'p/a': { available: false, reason: 'auth', until: null } },
  }));
  assert.equal(result.excluded[0].reason, 'missing');
  const second = select(input(['p/a'], {
    tools: { 'p/a': 'failed' }, avail: { 'p/a': { available: false, reason: 'auth', until: null } },
  }));
  assert.equal(second.excluded[0].reason, 'failed');
});

test('MP-13 in a reply the current model is kept while it passes steps 1-5', () => {
  const result = select(input(ABC, { reply: reply('p/b', { skipped: ['p/a'] }) }));
  assert.deepEqual(result, { model: 'p/b', excluded: [] });
});

test('MP-13 sticky: the preferred model recovering mid-reply is not chosen; the next after current is', () => {
  // 首选 a 在段开始时不可用（skipped），段内恢复；当前 b 失败（tried）→ 换到 c 而不是 a。
  const r = reply('p/b', { skipped: ['p/a'], tried: [['p/b', 'auth', 'API key rejected']] });
  const result = select(input(ABC, { reply: r }));
  assert.equal(result.model, 'p/c');
  assert.deepEqual(result.excluded, [
    { ref: 'p/a', reason: 'earlier', detail: 'skipped at the start of this reply' },
    { ref: 'p/b', reason: 'tried', detail: 'failed earlier in this reply: API key rejected' },
  ]);
});

test('MP-13 never back to a tried model in the same reply', () => {
  const r = reply('p/c', { tried: [['p/a', 'not_found', 'model not found on the server'],
    ['p/c', 'connection', REASON_TEXTS.connection(2_000_000)]] });
  const result = select(input(ABC, { reply: r }));
  assert.equal(result.model, null);
  assert.deepEqual(result.excluded.map((item) => item.reason), ['tried', 'earlier', 'tried']);
});

test('MP-13 tried texts drop the until part of the inner reason', () => {
  const r = reply('p/a', { tried: [['p/a', 'rate_limited', REASON_TEXTS.rate_limited(2_000_000)]] });
  const result = select(input(['p/a'], { reply: r }));
  assert.equal(result.excluded[0].detail, 'failed earlier in this reply: rate limited');
  const q = reply('p/a', { tried: [['p/a', 'queue_timeout', REASON_TEXTS.queue_timeout(60_000)]] });
  assert.equal(select(input(['p/a'], { reply: q })).excluded[0].detail,
    'failed earlier in this reply: waited 60 s for a free slot');
});

test('MP-13 candidates positioned before current count as earlier even if not in skipped', () => {
  const r = reply('p/b', { tried: [['p/b', 'timeout', REASON_TEXTS.timeout(null)]] });
  const result = select(input(ABC, { reply: r }));
  assert.equal(result.model, 'p/c');
  assert.equal(result.excluded[0].reason, 'earlier');
});

test('MP-13 a new reply (current null) starts again from the first candidate', () => {
  const result = select(input(ABC, { reply: reply(null) }));
  assert.equal(result.model, 'p/a');
});

test('MP-20 an unavailable earlier candidate reports the availability reason before earlier', () => {
  const r = reply('p/b', { skipped: ['p/a'], tried: [['p/b', 'auth', 'API key rejected']] });
  const avail = { 'p/a': { available: false, reason: 'rate_limited', until: 2_000_000 } };
  const result = select(input(ABC, { reply: r, avail }));
  assert.equal(result.excluded[0].reason, 'rate_limited');
});

test('MP-21 step 6 no_handover excludes only the candidate being switched to, then the next is tried', () => {
  const calls = [];
  const handover = (ref) => {
    calls.push(ref);
    return ref === 'p/b' ? { detail: REASON_TEXTS.no_handover(null) } : null;
  };
  const r = reply('p/a', { tried: [['p/a', 'auth', 'API key rejected']] });
  const result = select(input(ABC, { reply: r, handover }));
  assert.equal(result.model, 'p/c');
  assert.deepEqual(calls, ['p/b', 'p/c']);
  assert.deepEqual(result.excluded[1],
    { ref: 'p/b', reason: 'no_handover', detail: 'conversation too long for this model' });
});

test('MP-21 step 6 is not checked when keeping the current model', () => {
  let called = false;
  const handover = () => {
    called = true;
    return { detail: 'x' };
  };
  const result = select(input(ABC, { reply: reply('p/a'), handover }));
  assert.equal(result.model, 'p/a');
  assert.equal(called, false);
});

test('MP-21 handover is checked at the reply start too, and a rebuild error text is passed through', () => {
  const handover = (ref) => (ref === 'p/a' ? { detail: REASON_TEXTS.no_handover('boom') } : null);
  const result = select(input(ABC, { reply: reply(null), handover }));
  assert.equal(result.model, 'p/b');
  assert.equal(result.excluded[0].detail, "couldn't rebuild the conversation: boom");
});

test('MP-36 route() checks only steps 1 and 4 for the current model', () => {
  const base = input(['p/a'], { zones: { 'p/a': 'public' }, tools: { 'p/a': 'failed' } });
  assert.equal(checkCurrent(base, 'p/a'), null);
  const gone = input(['p/a'], { missing: ['p/a'], removedRefs: new Set(['p/a']) });
  assert.deepEqual(checkCurrent(gone, 'p/a'),
    { ref: 'p/a', reason: 'missing', detail: 'removed from your model settings' });
  const cooled = input(['p/a'], { avail: { 'p/a': { available: false, reason: 'rate_limited', until: 2_000_000 } } });
  assert.equal(checkCurrent(cooled, 'p/a').reason, 'rate_limited');
});

// ---- §4.6 静态校验 ----

/** 静态校验输入：默认配置读得出、项目配置有效、有范围。 */
function check(candidates, over = {}) {
  const base = input(candidates ?? [], over);
  return staticCheck({
    configError: null, projectError: null, pick: 'cloud', projectZones: null, ...base, candidates, ...over,
  });
}

test('MP-09 static check ignores availability (steps 1-3 only) and gives the first candidate', () => {
  const avail = { 'p/a': { available: false, reason: 'auth', until: null } };
  assert.deepEqual(check(ABC, { avail }), { blocked: null, first: 'p/a' });
  assert.equal(selectStatic(input(ABC, { tools: { 'p/a': 'unverified' } })).model, 'p/b');
});

test('MP-09 verifying when nothing passes and one excluded candidate is probing; no actions', () => {
  const { blocked } = check(ABC, { tools: { 'p/a': 'unverified', 'p/b': 'probing', 'p/c': 'probing' } });
  assert.equal(blocked.kind, 'verifying');
  assert.equal(blocked.detail, 'p/b');
  assert.deepEqual(blocked.actions, []);
  assert.equal(blocked.candidates.length, 3);
});

test('MP-09 no_candidate with Verify now only when an unverified candidate exists', () => {
  const { blocked } = check(ABC, { tools: { 'p/a': 'unverified', 'p/b': 'failed', 'p/c': 'unverified' } });
  assert.equal(blocked.kind, 'no_candidate');
  assert.deepEqual(blocked.actions, ['verify', 'change_model', 'open_settings']);
  assert.deepEqual(blocked.verifyRefs, ['p/a', 'p/c']);
  const failed = check(['p/a'], { tools: { 'p/a': 'failed' } }).blocked;
  assert.deepEqual(failed.actions, ['change_model', 'open_settings']);
  assert.deepEqual(failed.verifyRefs, []);
});

test('MP-09 Allow zone when a candidate is zone_blocked and the project config does not exclude it', () => {
  const { blocked } = check(['g/a', 'p/b'], { zones: { 'g/a': 'public' }, tools: { 'p/b': 'failed' } });
  assert.equal(blocked.kind, 'no_candidate');
  assert.equal(blocked.zone, 'public');
  assert.deepEqual(blocked.actions, ['allow_zone', 'change_model', 'open_settings']);
});

test('MP-06 no Allow zone when .mori/models.json excludes that zone', () => {
  const { blocked } = check(['g/a', 'i/b'], {
    zones: { 'g/a': 'public', 'i/b': 'intranet' }, allowedZones: ['local'], projectZones: ['local', 'intranet'],
  });
  assert.equal(blocked.zone, 'intranet');
  const none = check(['g/a'], { zones: { 'g/a': 'public' }, projectZones: ['local'] }).blocked;
  assert.equal(none.zone, null);
  assert.deepEqual(none.actions, ['change_model', 'open_settings']);
});

test('MP-09 Confirm zone lists each provider with an unconfirmed zone once', () => {
  const { blocked } = check(['m/a', 'm/b', 'n/c'], { zones: { 'm/a': null, 'm/b': null, 'n/c': null } });
  assert.deepEqual(blocked.zoneProviders, ['m', 'n']);
  assert.deepEqual(blocked.actions, ['confirm_zone', 'change_model', 'open_settings']);
});

test('MP-09 all three optional actions appear in table order', () => {
  const { blocked } = check(['m/a', 'g/b', 'p/c'], {
    zones: { 'm/a': null, 'g/b': 'public' }, tools: { 'p/c': 'unverified' },
  });
  assert.deepEqual(blocked.actions, ['verify', 'allow_zone', 'confirm_zone', 'change_model', 'open_settings']);
});

test('MP-09 no_pick when the session has no model range', () => {
  const { blocked, first } = check(null, { pick: null });
  assert.equal(first, null);
  assert.deepEqual(blocked, { kind: 'no_pick', detail: '', candidates: [], actions: ['change_model', 'open_settings'],
    verifyRefs: [], zone: null, zoneProviders: [] });
});

test('MP-30 pick_missing names the missing range', () => {
  const { blocked } = check(null, { pick: 'gone' });
  assert.equal(blocked.kind, 'pick_missing');
  assert.equal(blocked.detail, 'gone');
  assert.deepEqual(blocked.actions, ['change_model', 'open_settings']);
});

test('MP-07 project_config blocks with the reason and only Open settings', () => {
  const { blocked } = check(ABC, { projectError: 'groups.cloud: glm/x is not in group cloud' });
  assert.equal(blocked.kind, 'project_config');
  assert.equal(blocked.detail, 'groups.cloud: glm/x is not in group cloud');
  assert.deepEqual(blocked.actions, ['open_settings']);
});

test('MP-01 config_invalid wins over everything else', () => {
  const configError = 'C:/u/model-config.json: Unexpected token';
  const { blocked } = check(null, { pick: null, configError, projectError: 'x' });
  assert.equal(blocked.kind, 'config_invalid');
  assert.equal(blocked.detail, 'C:/u/model-config.json: Unexpected token');
  assert.deepEqual(blocked.actions, ['open_settings']);
});

// ---- §9.2 顶栏菜单各项（session.pickOptions） ----

/** 菜单各项的输入：区域取配置里提供商的区域，项目只允许 local、intranet。 */
function menuInput(over = {}) {
  const cfg = config();
  const zoneOfProvider = Object.fromEntries(cfg.providers.map((p) => [p.id, p.zone]));
  const { zones = {}, ...rest } = over;
  return {
    config: cfg,
    exists: () => true,
    zoneOf: (ref) => {
      const id = providerOf(ref);
      return id in zones ? zones[id] : zoneOfProvider[id];
    },
    allowedZones: ['local', 'intranet'],
    toolCalling: () => 'verified',
    ...rest,
  };
}

test('MP-23 menu lists groups, then providers, then models per provider, labelled id / name / model id', () => {
  const options = pickOptions(menuInput());
  assert.deepEqual(options.map((o) => [o.kind, o.pick, o.label]), [
    ['group', 'cloud', 'cloud'], ['group', 'mixed', 'mixed'],
    ['provider', 'local', 'LOCAL'], ['provider', 'glm', 'GLM'], ['provider', 'ds', 'DS'],
    ['model', 'local/qwen', 'qwen'], ['model', 'local/llama', 'llama'], ['model', 'local/phi', 'phi'],
    ['model', 'glm/glm-4.6', 'glm-4.6'], ['model', 'glm/glm-4.5', 'glm-4.5'],
    ['model', 'ds/chat', 'chat'], ['model', 'ds/reasoner', 'reasoner'],
  ]);
});

test('MP-23 each item shows the zones of its candidates in Local, Intranet, Public order', () => {
  const byPick = Object.fromEntries(pickOptions(menuInput()).map((o) => [o.pick, o.zones]));
  assert.deepEqual(byPick.mixed, ['local', 'public']);
  assert.deepEqual(byPick.cloud, ['public']);
  assert.deepEqual(byPick.local, ['local']);
  assert.deepEqual(byPick['ds/chat'], ['public']);
  const unconfirmed = Object.fromEntries(pickOptions(menuInput({ zones: { glm: null } })).map((o) => [o.pick, o]));
  assert.deepEqual(unconfirmed.glm.zones, [], 'an unconfirmed zone is not listed');
  assert.deepEqual(unconfirmed.mixed.zones, ['local']);
});

test('MP-23 items whose candidates all fail the static check are excluded with one line per candidate', () => {
  const byPick = Object.fromEntries(pickOptions(menuInput({ zones: { glm: null } })).map((o) => [o.pick, o]));
  assert.equal(byPick.mixed.excluded, false);
  assert.equal(byPick.mixed.reason, null);
  assert.equal(byPick.local.excluded, false);
  assert.equal(byPick.cloud.excluded, true);
  assert.equal(byPick.cloud.reason, [
    'ds/reasoner — zone public is not allowed for this project',
    'glm/glm-4.6 — network zone not confirmed',
    'glm/glm-4.5 — network zone not confirmed',
    'ds/chat — zone public is not allowed for this project',
  ].join('\n'));
  assert.equal(byPick['glm/glm-4.5'].reason, 'glm/glm-4.5 — network zone not confirmed');
  const tools = pickOptions(menuInput({ toolCalling: (ref) => (ref === 'local/qwen' ? 'unverified' : 'verified') }));
  const qwen = tools.find((o) => o.pick === 'local/qwen');
  assert.deepEqual([qwen.excluded, qwen.reason], [true, 'local/qwen — tool calling not verified yet']);
  assert.equal(tools.find((o) => o.pick === 'local').excluded, false, 'other local models still pass');
});

test('MP-23 the menu follows the project: allowed zones and .mori/models.json group narrowing', () => {
  const open = pickOptions(menuInput({ allowedZones: ['local', 'intranet', 'public'] }));
  assert.equal(open.every((o) => !o.excluded), true);
  const narrowed = pickOptions(menuInput({ projectGroups: { mixed: ['glm/glm-4.5'] } }));
  const mixed = narrowed.find((o) => o.pick === 'mixed');
  assert.deepEqual([mixed.zones, mixed.excluded], [['public'], true]);
});

// ---- §5.8 候选耗尽 ----

test('MP-20 recovering reasons are probing, rate_limited, connection, timeout and held', () => {
  assert.deepEqual([...RECOVERING_REASONS].sort(), ['connection', 'held', 'probing', 'rate_limited', 'timeout']);
  const never = ['missing', 'zone_unconfirmed', 'zone_blocked', 'unverified', 'failed', 'auth', 'quota', 'not_found',
    'tried', 'earlier', 'no_handover'];
  assert.equal(canRecover(never.map((reason) => ({ ref: 'p/a', reason, detail: '' }))), false);
  for (const reason of RECOVERING_REASONS) assert.equal(canRecover([{ ref: 'p/a', reason, detail: '' }]), true);
});

test('MP-20 in a reply, recovering candidates already tried or earlier do not count', () => {
  const current = reply('p/b', { tried: [['p/b', 'rate_limited', 'rate limited']] });
  const scope = { reply: current, candidates: ABC };
  const limited = (ref) => ({ ref, reason: 'rate_limited', detail: '' });
  const onlyOld = [limited('p/a'), limited('p/b'), { ref: 'p/c', reason: 'auth', detail: '' }];
  assert.equal(canRecover(onlyOld), true, 'without the reply every rate limit counts');
  assert.equal(canRecover(onlyOld, scope), false);
  const skipped = { reply: reply('p/c', { skipped: ['p/b'] }), candidates: ABC };
  assert.equal(canRecover([limited('p/b')], skipped), false, 'skipped at the reply start');
  const clock = fakeClock();
  const availability = (ref) => ({ available: false, reason: 'rate_limited', until: clock.now() + (ref === 'p/c'
    ? 30_000 : 1_000) });
  const args = { availability, waitStartedAt: clock.now(), now: clock.now(), timings: MODEL_TIMINGS, scope };
  assert.equal(exhaustionWait({ ...args, excluded: onlyOld }), null);
  const wait = exhaustionWait({ ...args, excluded: [limited('p/a'), limited('p/b'), limited('p/c')] });
  assert.equal(wait.first.ref, 'p/c', 'p/a and p/b recover sooner but are not chosen again in this reply');
  assert.equal(wait.recoverAt, clock.now() + 30_000);
});

test('MP-20 only non-recovering reasons: no wait', () => {
  const clock = fakeClock();
  const excluded = [{ ref: 'p/a', reason: 'auth', detail: '' }, { ref: 'p/b', reason: 'tried', detail: '' }];
  const wait = exhaustionWait({ excluded, availability: () => ({ available: true }), waitStartedAt: clock.now(),
    now: clock.now(), timings: MODEL_TIMINGS });
  assert.equal(wait, null);
});

test('MP-20 waits for the candidate recovering first and rechecks at that time or the interval', () => {
  const clock = fakeClock();
  const start = clock.now();
  const avail = {
    'p/a': { available: false, reason: 'rate_limited', until: start + 20_000 },
    'p/b': { available: false, reason: 'connection', until: start + 3_000 },
  };
  const excluded = [
    { ref: 'p/a', reason: 'rate_limited', detail: REASON_TEXTS.rate_limited(start + 20_000) },
    { ref: 'p/b', reason: 'connection', detail: REASON_TEXTS.connection(start + 3_000) },
  ];
  const args = { excluded, availability: (ref) => avail[ref], waitStartedAt: start, timings: MODEL_TIMINGS };
  const wait = exhaustionWait({ ...args, now: clock.now() });
  assert.equal(wait.first.ref, 'p/b');
  assert.equal(wait.recoverAt, start + 3_000);
  assert.equal(wait.recheckAt, start + 3_000);
  assert.equal(wait.deadline, start + MODEL_TIMINGS.exhaustionMaxWaitMs);
  const later = { ...args, availability: (ref) => avail[ref], excluded: [excluded[0]] };
  assert.equal(exhaustionWait({ ...later, now: clock.now() }).recheckAt, start + MODEL_TIMINGS.exhaustionRecheckMs);
});

test('MP-20 probing has no recovery time: recheck at the interval, first recovering candidate shown', () => {
  const clock = fakeClock();
  const excluded = [
    { ref: 'p/a', reason: 'failed', detail: '' }, { ref: 'p/b', reason: 'probing', detail: 'verifying…' },
  ];
  const wait = exhaustionWait({ excluded, availability: () => ({ available: true }), waitStartedAt: clock.now(),
    now: clock.now(), timings: MODEL_TIMINGS });
  assert.equal(wait.first.ref, 'p/b');
  assert.equal(wait.recoverAt, null);
  assert.equal(wait.recheckAt, clock.now() + MODEL_TIMINGS.exhaustionRecheckMs);
});

test('MP-20 the wait never passes the max wait and stops once it is reached', () => {
  const clock = fakeClock();
  const start = clock.now();
  const timings = { exhaustionMaxWaitMs: 10_000, exhaustionRecheckMs: 4_000 };
  const excluded = [{ ref: 'p/a', reason: 'held', detail: '' }];
  const availability = () => ({ available: false, reason: 'held', until: start + 120_000 });
  clock.advance(8_000);
  const wait = exhaustionWait({ excluded, availability, waitStartedAt: start, now: clock.now(), timings });
  assert.equal(wait.recheckAt, start + 10_000);
  clock.advance(2_000);
  assert.equal(exhaustionWait({ excluded, availability, waitStartedAt: start, now: clock.now(), timings }), null);
});

test('MP-20 a recovery time already past rechecks now', () => {
  const clock = fakeClock();
  const start = clock.now();
  const excluded = [{ ref: 'p/a', reason: 'timeout', detail: '' }];
  const availability = () => ({ available: false, reason: 'timeout', until: start + 1_000 });
  clock.advance(2_000);
  const wait = exhaustionWait({
    excluded, availability, waitStartedAt: start, now: clock.now(), timings: MODEL_TIMINGS,
  });
  assert.equal(wait.recheckAt, clock.now());
});
