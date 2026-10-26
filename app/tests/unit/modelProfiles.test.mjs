// kernel/modelProfiles.ts 的单元测试（规格 §7.1、§7.2、§7.4、§7.5）：档案键与指纹、版本变化、能力三态与等级、
// 重新验证期间按旧结果选择、model-profiles.json 的原子写与宽容读。
// 2026-10-24（§7.7，MP-38 单元层）：auto.offRefused 写出、读回后仍为真并编译出“没有 Off”的标记；没有这一项的旧档案
// 照读、off_refused 为假、不重新探测（PROBE_SUITE 不变）；reasoningOf 三种接口都给 off_refused，第 2 步被拒判为 fail
// 时 can_disable 为假。档案与配置都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from './load.mjs';

const P = await loadKernelModule('src/kernel/modelProfiles.ts');
const C = await loadKernelModule('src/kernel/modelCompile.ts');
const { MODEL_TIMINGS } = await loadKernelModule('src/kernel/modelTimings.ts');

/** 一步的结果。 */
const s = (outcome, detail = null) => ({ outcome, detail });
const pass = s('pass');
const fail = s('fail', 'judged');
const error = (detail = 'Connection error.') => s('error', detail);
const notRun = s('not_run');
const na = s('not_applicable');

/** 配置里的一个模型及其提供商字段。 */
function target(overrides = {}, model = {}) {
  return {
    baseUrl: 'http://127.0.0.1:4319/v1', api: 'openai-completions', compat: {},
    ...overrides,
    model: { id: 'fake-coder', family: '', contextWindow: 131072, maxTokens: 16384, reasoning: false,
      input: ['text'], ...model },
  };
}

/** 全部通过的第 0–7 步结果。 */
function autoResults(overrides = {}, steps = {}) {
  return {
    server: { kind: 'vllm', version: '0.10.1' }, reported: 65536, field: 'none',
    steps: { ready: pass, thinking: na, call: pass, result: pass, replay: na, a: pass, b: pass, c: notRun, ...steps },
    ...overrides,
  };
}

/** 一个档案。 */
function stored(t = target(), auto = autoResults(), now = 5000) {
  return P.buildProfile({ target: t, auto, previous: undefined, now });
}

// ---- 档案键与指纹（§7.1） ----

test('MP-12 profile key is baseUrl|api|model id|server version, unknown without a version', () => {
  assert.equal(P.profileKey(target(), '0.10.1'), 'http://127.0.0.1:4319/v1|openai-completions|fake-coder|0.10.1');
  assert.equal(P.profileKey(target(), null), 'http://127.0.0.1:4319/v1|openai-completions|fake-coder|unknown');
});

test('MP-12 fingerprint changes with window, max output, thinking, input, compat and version only', () => {
  const base = P.profileFingerprint(target(), '1');
  const variants = [
    target({}, { contextWindow: 65536 }), target({}, { maxTokens: 8192 }), target({}, { reasoning: true }),
    target({}, { input: ['text', 'image'] }), target({ compat: { supportsStore: false } }),
    target({ baseUrl: 'http://127.0.0.1:4320/v1' }), target({ api: 'openai-responses' }),
    target({}, { id: 'other' }),
  ];
  for (const variant of variants) assert.notEqual(P.profileFingerprint(variant, '1'), base);
  assert.notEqual(P.profileFingerprint(target(), '2'), base);
  assert.equal(P.profileFingerprint(target({}, { family: 'qwen' }), '1'), base, 'family is not in the fingerprint');
  const ab = P.profileFingerprint(target({ compat: { supportsStore: false, maxTokensField: 'max_tokens' } }), '1');
  const ba = P.profileFingerprint(target({ compat: { maxTokensField: 'max_tokens', supportsStore: false } }), '1');
  assert.equal(ab, ba, 'compat key order does not matter');
});

test('MP-12 a model is probed when it has no profile or its fingerprint changed', () => {
  const profile = stored();
  assert.equal(P.needsProbe(target(), undefined), true);
  assert.equal(P.needsProbe(target(), profile), false);
  assert.equal(P.needsProbe(target({}, { contextWindow: 32768 }), profile), true);
  assert.equal(P.needsProbe(target({ compat: { requiresToolResultName: true } }), profile), true);
});

/**
 * 读版本的结果（model-discovery.md §7.3，VersionRead）：默认是读到了 vLLM 0.10.1；拿不到列表时为 NOT_READ。
 */
const versionRead = (overrides = {}) => ({ listed: true, kind: 'vllm', version: '0.10.1', versionRead: true,
  ...overrides });
const NOT_READ = { listed: false, kind: 'unknown', version: null, versionRead: false };

test('MP-12 version change: a failed read keeps the profile; only a different version counts', () => {
  const profile = stored();
  assert.equal(P.versionChanged(profile, NOT_READ), false);
  assert.equal(P.versionChanged(profile, versionRead({ version: null, versionRead: false })), false,
    'a failed version request with the same kind keeps the profile');
  assert.equal(P.versionChanged(profile, versionRead()), false);
  assert.equal(P.versionChanged(profile, versionRead({ version: '0.11.0' })), true);
  assert.equal(P.versionChanged(undefined, versionRead({ version: '0.11.0' })), false);
  const unknown = stored(target(), autoResults({ server: { kind: 'unknown', version: 'unknown' } }));
  assert.equal(P.versionChanged(unknown, versionRead()), true, 'the kind changed from unknown to vllm');
});

// ---- 能力三态与等级（§7.2、§7.3、§7.5） ----

test('MP-10 tool_calling: both pass verified, a judged failure failed, an error or not run unverified', () => {
  assert.equal(P.toolCallingOf(pass, pass), 'verified');
  assert.equal(P.toolCallingOf(fail, notRun), 'failed');
  assert.equal(P.toolCallingOf(pass, fail), 'failed');
  assert.equal(P.toolCallingOf(error(), notRun), 'unverified');
  assert.equal(P.toolCallingOf(pass, error()), 'unverified');
});

test('MP-10 tier A, B, C, null and protocol_write from it', () => {
  assert.equal(P.tierOf(pass, fail, notRun), 'A');
  assert.equal(P.tierOf(fail, pass, notRun), 'B');
  assert.equal(P.tierOf(fail, fail, pass), 'C');
  assert.equal(P.tierOf(fail, fail, fail), null);
  assert.equal(P.protocolWriteOf(fail, pass, notRun), 'verified');
  assert.equal(P.protocolWriteOf(fail, fail, fail), 'failed');
  assert.equal(P.protocolWriteOf(error(), fail, notRun), 'unverified');
  assert.equal(P.protocolWriteOf(fail, error(), notRun), 'unverified');
  assert.equal(P.protocolWriteOf(fail, fail, error()), 'unverified');
});

test('MP-10 anthropic-messages: B is not applicable; A and C failing is tier null and protocol_write failed', () => {
  assert.equal(P.tierOf(fail, na, fail), null);
  assert.equal(P.protocolWriteOf(fail, na, fail), 'failed');
  assert.equal(P.tierOf(fail, na, pass), 'C');
  assert.equal(P.protocolWriteOf(fail, na, error()), 'unverified');
  assert.equal(P.structuredOutputOf('anthropic-messages', na), 'unverified');
});

test('MP-10 structured_output from step 6, vision from the configured input', () => {
  assert.equal(P.structuredOutputOf('openai-completions', pass), 'verified');
  assert.equal(P.structuredOutputOf('openai-responses', fail), 'failed');
  assert.equal(P.structuredOutputOf('openai-completions', error()), 'unverified');
  assert.equal(P.visionOf(target({}, { input: ['text', 'image'] }).model), 'unverified');
  assert.equal(P.visionOf(target().model), 'failed');
});

test('MP-10 reasoning: completions uses the observed field and steps 2 and 4; other APIs are native', () => {
  const auto = autoResults({ field: 'reasoning_content' }, { thinking: pass, replay: fail });
  assert.deepEqual(P.reasoningOf('openai-completions', auto),
    { field: 'reasoning_content', can_disable: true, replay: 'required', off_refused: false });
  const other = autoResults({ field: 'reasoning' }, { thinking: fail, replay: pass });
  assert.deepEqual(P.reasoningOf('openai-completions', other),
    { field: 'reasoning', can_disable: false, replay: 'not_required', off_refused: false });
  assert.deepEqual(P.reasoningOf('openai-completions', autoResults()),
    { field: 'none', can_disable: 'unknown', replay: 'unknown', off_refused: false });
  assert.deepEqual(P.reasoningOf('openai-responses', auto),
    { field: 'native', can_disable: true, replay: 'not_required', off_refused: false });
  assert.deepEqual(P.reasoningOf('anthropic-messages', null),
    { field: 'native', can_disable: 'unknown', replay: 'not_required', off_refused: false });
});

test('MP-11 context: effective is the smaller of declared and reported; silent truncation lowers it', () => {
  const model = target({}, { contextWindow: 131072 }).model;
  assert.deepEqual(P.contextOf(model, 65536, null),
    { declared: 131072, reported: 65536, effective: 65536, truncation: 'unknown' });
  assert.deepEqual(P.contextOf(model, null, null),
    { declared: 131072, reported: null, effective: 131072, truncation: 'unknown' });
  const none = { step: pass, truncation: 'none', limit: null };
  assert.equal(P.contextOf(model, 65536, none).effective, 65536);
  assert.equal(P.contextOf(model, 65536, none).truncation, 'none');
  const silent = { step: pass, truncation: 'silent', limit: 32768 };
  assert.deepEqual(P.contextOf(model, 65536, silent),
    { declared: 131072, reported: 65536, effective: 32768, truncation: 'silent' });
  assert.equal(P.contextOf(model, 65536, { ...silent, limit: 0 }).effective, 0);
});

test('MP-11 cancel_verified comes from step 9 and is unknown until it runs', () => {
  assert.equal(P.cancelVerifiedOf(null), 'unknown');
  assert.equal(P.cancelVerifiedOf({ step: pass, verified: true }), true);
  assert.equal(P.cancelVerifiedOf({ step: pass, verified: false }), false);
});

test('MP-10 status is error with the first error text when a step had no result', () => {
  assert.deepEqual(P.statusOf(stored()), { status: 'ready', error: null });
  const broken = stored(target(), autoResults({}, { call: error('500 Internal Server Error'), result: notRun,
    a: error('later') }));
  assert.deepEqual(P.statusOf(broken), { status: 'error', error: '500 Internal Server Error' });
  const cancelError = P.withCancel(stored(), { step: error('503'), verified: 'unknown' }, 6000);
  assert.deepEqual(P.statusOf(cancelError), { status: 'error', error: '503' });
});

test('MP-10 profile view for a stored profile', () => {
  const t = target({}, { input: ['text', 'image'] });
  const view = P.profileView(t, stored(t), false);
  assert.equal(view.status, 'ready');
  assert.deepEqual(view.server, { kind: 'vllm', version: '0.10.1' });
  assert.deepEqual(view.tool_calling, { state: 'verified', call: pass, result: pass });
  assert.deepEqual(view.tier, { level: 'A', a: pass, b: pass, c: notRun });
  assert.equal(view.protocol_write, 'verified');
  assert.equal(view.structured_output, 'verified');
  assert.equal(view.vision, 'unverified');
  assert.deepEqual(view.reasoning, { field: 'none', can_disable: 'unknown', replay: 'unknown', off_refused: false });
  assert.deepEqual(view.context, { declared: 131072, reported: 65536, effective: 65536, truncation: 'unknown' });
  assert.equal(view.cancel_verified, 'unknown');
  assert.equal(view.probedAt, 5000);
  assert.equal(view.suite, P.PROBE_SUITE);
});

// ---- 重新验证（§7.4） ----

test('MP-12 never-verified model is probing while running and unverified otherwise', () => {
  assert.equal(P.toolCallingState(undefined, true), 'probing');
  assert.equal(P.toolCallingState(undefined, false), 'unverified');
  const view = P.profileView(target({ api: 'anthropic-messages' }), undefined, true);
  assert.equal(view.status, 'probing');
  assert.equal(view.tool_calling.state, 'unverified');
  assert.equal(view.tier.b.outcome, 'not_applicable');
  assert.equal(view.probedAt, null);
  assert.equal(P.profileView(target(), undefined, false), null);
});

test('MP-09 a profile left unverified by an error counts as never verified: probing while running', () => {
  const errored = stored(target(), autoResults({}, { call: error(), result: notRun, a: notRun, b: notRun }));
  assert.equal(P.toolCallingOf(errored.auto.steps.call, errored.auto.steps.result), 'unverified');
  assert.equal(P.toolCallingState(errored, true), 'probing');
  assert.equal(P.toolCallingState(errored, false), 'unverified');
  assert.equal(P.profileView(target(), errored, true).tool_calling.state, 'unverified');
});

test('MP-12 while re-verifying, the old results stay in use for selection and display', () => {
  const verified = stored();
  assert.equal(P.toolCallingState(verified, true), 'verified');
  const failed = stored(target(), autoResults({}, { call: fail, result: notRun }));
  assert.equal(P.toolCallingState(failed, true), 'failed');
  assert.equal(P.profileView(target(), verified, true).status, 'ready');
  assert.equal(P.profileView(target({}, { contextWindow: 65536 }), verified, true).tool_calling.state, 'verified');
});

test('MP-12 a new probe keeps step 8/9 results only while the profile key (server version) is the same', () => {
  const first = P.withCancel(P.withLongInput(stored(), { step: pass, truncation: 'silent', limit: 1000 }, 6000),
    { step: pass, verified: true }, 7000);
  assert.equal(first.probedAt, 7000);
  const same = P.buildProfile({ target: target(), auto: autoResults(), previous: first, now: 8000 });
  assert.deepEqual(same.longInput, first.longInput);
  assert.deepEqual(same.cancel, first.cancel);
  const newer = P.buildProfile({ target: target(), now: 9000, previous: first,
    auto: autoResults({ server: { kind: 'vllm', version: '0.11.0' } }) });
  assert.equal(newer.longInput, null);
  assert.equal(newer.cancel, null);
  assert.equal(newer.key, 'http://127.0.0.1:4319/v1|openai-completions|fake-coder|0.11.0');
  assert.equal(P.needsProbe(target(), newer), false);
});

test('MP-11 a long-input error keeps the earlier truncation result', () => {
  const silent = P.withLongInput(stored(), { step: pass, truncation: 'silent', limit: 1000 }, 6000);
  const errored = P.withLongInput(silent, { step: error('Connection error.'), truncation: null, limit: null }, 7000);
  assert.equal(errored.longInput.truncation, 'silent');
  assert.equal(errored.longInput.limit, 1000);
  assert.deepEqual(P.statusOf(errored), { status: 'error', error: 'Connection error.' });
  const fresh = P.withLongInput(stored(), { step: error('x'), truncation: null, limit: null }, 7000);
  assert.equal(P.contextOf(target().model, 65536, fresh.longInput).truncation, 'unknown');
});

// ---- model-profiles.json ----

/** 临时目录里的档案文件路径。 */
function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'mori-profiles-')), 'model-profiles.json');
}

test('MP-12 store round trip writes atomically and leaves no temporary file', async () => {
  const path = tempPath();
  await P.writeProfiles(path, [stored()]);
  assert.deepEqual(readdirSync(join(path, '..')), ['model-profiles.json']);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(data.version, 1);
  assert.deepEqual(await P.readProfiles(path), [stored()]);
});

test('MP-12 tolerant load: missing file, bad JSON, wrong shape and invalid entries', async () => {
  assert.deepEqual(await P.readProfiles(tempPath()), []);
  const bad = tempPath();
  writeFileSync(bad, '{ not json');
  assert.deepEqual(await P.readProfiles(bad), []);
  const shape = tempPath();
  writeFileSync(shape, JSON.stringify({ version: 1, profiles: {} }));
  assert.deepEqual(await P.readProfiles(shape), []);
  const mixed = tempPath();
  writeFileSync(mixed, JSON.stringify({ version: 1, profiles: [{ key: 'broken' }, stored()] }));
  assert.deepEqual(await P.readProfiles(mixed), [stored()]);
});

/** 一个 ProfileBook：ref → 配置里的目标。 */
function book(path, targets) {
  return new P.ProfileBook({ path, resolve: (ref) => targets[ref] ?? null });
}

test('MP-12 ProfileBook saves one profile per server model, replacing older versions, and reloads it', async () => {
  const path = tempPath();
  const targets = { 'local/fake-coder': target(), 'copy/fake-coder': target() };
  const profiles = book(path, targets);
  await profiles.load();
  await profiles.save(stored());
  const upgraded = P.buildProfile({ target: target(), previous: profiles.lookup(target()), now: 9000,
    auto: autoResults({ server: { kind: 'vllm', version: '0.11.0' } }) });
  await profiles.save(upgraded);
  const again = book(path, targets);
  await again.load();
  assert.equal(again.lookupRef('local/fake-coder').key, upgraded.key);
  assert.equal(again.lookupRef('copy/fake-coder').key, upgraded.key, 'two providers on one server share a profile');
  assert.equal((await P.readProfiles(path)).length, 1);
});

test('MP-12 ProfileBook: toolCallingFor and views follow the re-verifying rule', async () => {
  const targets = { 'local/fake-coder': target(), 'local/new': target({}, { id: 'new' }) };
  const profiles = book(tempPath(), targets);
  await profiles.save(stored());
  profiles.setRunning('local/fake-coder', 3, 8);
  profiles.setRunning('local/new', 1, 8);
  assert.equal(profiles.toolCallingFor('local/fake-coder'), 'verified');
  assert.equal(profiles.toolCallingFor('local/new'), 'probing');
  assert.equal(profiles.toolCallingFor('gone/model'), 'unverified');
  assert.deepEqual(profiles.running(), [{ ref: 'local/fake-coder', step: 3, of: 8 },
    { ref: 'local/new', step: 1, of: 8 }]);
  const views = profiles.views(['local/fake-coder', 'local/new', 'gone/model']);
  assert.deepEqual(Object.keys(views), ['local/fake-coder', 'local/new']);
  assert.equal(views['local/new'].status, 'probing');
  profiles.clearRunning('local/new');
  assert.equal(profiles.toolCallingFor('local/new'), 'unverified');
  assert.deepEqual(Object.keys(profiles.views(['local/new'])), []);
});

test('MP-12 a changed address is a different server model: no profile, probing while running', async () => {
  const profiles = book(tempPath(), { 'local/fake-coder': target({ baseUrl: 'http://127.0.0.1:5000/v1' }) });
  await profiles.save(stored());
  assert.equal(profiles.lookupRef('local/fake-coder'), undefined);
  profiles.setRunning('local/fake-coder', 0, 8);
  assert.equal(profiles.toolCallingFor('local/fake-coder'), 'probing');
});

// ---- 思考关不掉的模型：档案里的 offRefused（§7.7，MP-38） ----

const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const NOOFF_REF = 'or/fake-coder-nooff';
/** 第 2 步被拒时存下的说明（synthetic，按 §7.7 的写法与 OpenRouter 的原文）：只存在档案里 */
const REFUSED_DETAIL = 'Thinking can’t be turned off: 400 Reasoning is mandatory for this endpoint and cannot be '
  + 'disabled.';

/** 勾了 Supports thinking 的模型（接口 api，OpenRouter 前缀的地址，synthetic）。 */
function thinkingTarget(api) {
  return target({ api, baseUrl: 'http://127.0.0.1:4319/openrouter.ai/v1' },
    { id: 'fake-coder-nooff', reasoning: true });
}

/**
 * 第 2 步判出 off_refused 的第 0–7 步结果（synthetic，按 §7.7）：第 2 步 fail 并带被拒的说明，第 5 步不适用，
 * 第 6 步通过（anthropic-messages 不适用，第 7 步通过）。
 */
function refusedAuto(api) {
  const anthropic = api === 'anthropic-messages';
  return autoResults({ field: api === 'openai-completions' ? 'reasoning_content' : 'native', offRefused: true },
    { thinking: s('fail', REFUSED_DETAIL), replay: pass, a: na, b: anthropic ? na : pass,
      c: anthropic ? pass : notRun });
}

/** 只有 t 这个模型的配置（提供商 or，没有 key，synthetic）。 */
function configOf(t) {
  const provider = { id: 'or', name: 'OpenRouter', api: t.api, baseUrl: t.baseUrl, compat: t.compat,
    concurrency: 4, keys: [], nextKeyNumber: 1, models: [t.model] };
  return { version: 1, providers: [provider], groups: [], normalDefault: NOOFF_REF };
}

/** 照 modelLayer.ts 的 profileLookup：按 ProfileBook 里这个模型的档案给编译项（compileFlagsOf）。 */
function lookupIn(profiles) {
  return (provider, model) => P.compileFlagsOf(provider.api,
    profiles.lookup({ baseUrl: provider.baseUrl, api: provider.api, model, compat: provider.compat })?.auto);
}

/** 按档案文件 path 重新读档案（同后台进程重新启动），把 t 的配置编译成 pi 的注册内容，返回这个模型的那一项。 */
async function compiledFrom(path, t) {
  const profiles = book(path, { [NOOFF_REF]: t });
  await profiles.load();
  return C.compileInputs(configOf(t), lookupIn(profiles), MODEL_TIMINGS.placeholderApiKey).get('or').models[0];
}

test('MP-38 profiles: auto.offRefused true is written, read back still true, and compiles into the no-Off marker',
  async () => {
    for (const api of APIS) {
      const t = thinkingTarget(api);
      const profile = stored(t, refusedAuto(api));
      const path = tempPath();
      await P.writeProfiles(path, [profile]);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).profiles[0].auto.offRefused, true, `${api}: in the file`);
      const [read] = await P.readProfiles(path);
      assert.deepEqual(read, profile, api);
      assert.equal(read.auto.offRefused, true, `${api}: the schema keeps offRefused`);
      assert.deepEqual(P.compileFlagsOf(api, read.auto), { replayRequired: false, offRefused: true }, api);
      const view = P.profileView(t, read, false);
      assert.deepEqual([view.status, view.reasoning.off_refused, view.reasoning.can_disable], ['ready', true, false],
        `${api}: a refused step 2 is not an error`);
      assert.ok(!JSON.stringify(view).includes('Thinking can’t be turned off'),
        `${api}: the step 2 detail stays in the profile file, the view does not carry it`);
      assert.equal(P.needsProbe(t, read), false, api);
      const model = await compiledFrom(path, t);
      assert.deepEqual(model.thinkingLevelMap, { off: null }, `${api}: compiled into the marker`);
      assert.ok(!Object.hasOwn(model.compat ?? {}, 'thinkingLevelMap'), `${api}: not inside compat`);
    }
  });

test('MP-38 profiles: an old profile without offRefused reads, off_refused false, no re-probe, PROBE_SUITE unchanged',
  async () => {
    const t = thinkingTarget('openai-completions');
    const auto = autoResults({ field: 'reasoning_content' }, { thinking: pass, replay: pass });
    const old = structuredClone(stored(t, auto));
    delete old.auto.offRefused;
    assert.ok(!Object.hasOwn(old.auto, 'offRefused'), 'synthetic: a profile written before 2026-10-24');
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [old] }));
    const [read] = await P.readProfiles(path);
    assert.deepEqual(read, old, 'read as written: nothing is filled in or migrated');
    assert.ok(!Object.hasOwn(read.auto, 'offRefused'));
    assert.equal(P.needsProbe(t, read), false, 'not probed again');
    assert.equal(P.versionChanged(read, versionRead()), false);
    assert.equal(P.PROBE_SUITE, 1, 'the probe suite version is unchanged');
    assert.equal(read.suite, P.PROBE_SUITE);
    assert.deepEqual(P.reasoningOf(t.api, read.auto),
      { field: 'reasoning_content', can_disable: true, replay: 'not_required', off_refused: false });
    assert.deepEqual(P.compileFlagsOf(t.api, read.auto), { replayRequired: false, offRefused: false });
    const profiles = book(path, { [NOOFF_REF]: t });
    await profiles.load();
    assert.equal(profiles.views([NOOFF_REF])[NOOFF_REF].reasoning.off_refused, false);
    assert.equal(profiles.toolCallingFor(NOOFF_REF), 'verified');
    assert.ok(!Object.hasOwn(await compiledFrom(path, t), 'thinkingLevelMap'), 'compiled without the marker');
  });

test('MP-38 reasoningOf: off_refused for all three APIs; the refused step 2 is fail, so can_disable is false', () => {
  assert.deepEqual(P.reasoningOf('openai-completions', refusedAuto('openai-completions')),
    { field: 'reasoning_content', can_disable: false, replay: 'not_required', off_refused: true });
  for (const api of ['openai-responses', 'anthropic-messages']) {
    assert.deepEqual(P.reasoningOf(api, refusedAuto(api)),
      { field: 'native', can_disable: false, replay: 'not_required', off_refused: true }, api);
  }
  // probes.ts 每次都写 offRefused：能关闭的、思考关了仍有思考内容的都为 false
  const able = autoResults({ field: 'reasoning_content', offRefused: false }, { thinking: pass, replay: pass });
  const thinksAnyway = autoResults({ field: 'reasoning_content', offRefused: false }, { thinking: fail, replay: pass });
  for (const api of APIS) {
    assert.deepEqual([P.reasoningOf(api, able).can_disable, P.reasoningOf(api, able).off_refused], [true, false], api);
    assert.deepEqual([P.reasoningOf(api, thinksAnyway).can_disable, P.reasoningOf(api, thinksAnyway).off_refused],
      [false, false], api);
    assert.equal(P.reasoningOf(api, null).off_refused, false, `${api}: no profile`);
    assert.deepEqual(P.compileFlagsOf(api, refusedAuto(api)), { replayRequired: false, offRefused: true }, api);
    assert.deepEqual(P.compileFlagsOf(api, undefined), { replayRequired: false, offRefused: false }, api);
  }
  const replayToo = autoResults({ field: 'reasoning_content', offRefused: true },
    { thinking: s('fail', REFUSED_DETAIL), replay: fail });
  assert.deepEqual(P.compileFlagsOf('openai-completions', replayToo), { replayRequired: true, offRefused: true });
  assert.deepEqual(P.compileFlagsOf('anthropic-messages', replayToo), { replayRequired: false, offRefused: true });
});
