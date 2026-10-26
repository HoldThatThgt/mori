// shared/models.ts 的单元测试：§5.3 原因文字、§9.1 的英文标签、配置与项目配置的单字段校验、自定义条目的类型名、
// §9.5 命令的参数；MP-06 没有网络区域（2026-10-26，负责人走查 M3）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const models = await loadKernelModule('src/shared/models.ts');
const { REASON_TEXTS, formatClock, plainReasonText } = models;

/** 本地时间 09:05:07 的时刻（formatClock 按本地时间格式化）。 */
const NINE_OH_FIVE = new Date(2026, 9, 21, 9, 5, 7).getTime();
const AFTERNOON = new Date(2026, 9, 21, 23, 59, 0).getTime();

/** §4.1 的配置写法。 */
function sampleConfig() {
  return {
    version: 1,
    providers: [{
      id: 'deepseek-2', name: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
      compat: { maxTokensField: 'max_tokens' }, concurrency: 4,
      keys: [{ ref: 'deepseek-2#1', label: 'Key 1' }], nextKeyNumber: 2,
      models: [{ id: 'deepseek-chat', family: 'deepseek', contextWindow: 131072, maxTokens: 8192,
        reasoning: false, input: ['text'] }],
    }],
    groups: [{ id: 'cloud', members: ['deepseek-2/deepseek-chat', 'glm'] }],
    normalDefault: 'cloud',
  };
}

test('MP-01 formatClock gives local 24-hour hh:mm:ss with zero padding', () => {
  assert.equal(formatClock(NINE_OH_FIVE), '09:05:07');
  assert.equal(formatClock(AFTERNOON), '23:59:00');
});

test('MP-20 every reason code has exactly one UI text function', () => {
  const codes = [...models.EXCLUSION_REASONS, 'queue_timeout'].sort();
  assert.deepEqual(Object.keys(REASON_TEXTS).sort(), codes);
  for (const code of codes) assert.equal(typeof REASON_TEXTS[code], 'function', code);
  assert.ok(Object.isFrozen(REASON_TEXTS));
});

test('MP-20 availability reasons show the recovery time as hh:mm:ss', () => {
  assert.equal(REASON_TEXTS.rate_limited(NINE_OH_FIVE), 'rate limited until 09:05:07');
  assert.equal(REASON_TEXTS.connection(NINE_OH_FIVE), 'can’t connect until 09:05:07');
  assert.equal(REASON_TEXTS.timeout(NINE_OH_FIVE), 'no response; unavailable until 09:05:07');
  assert.equal(REASON_TEXTS.held(NINE_OH_FIVE), 'waiting to make sure it stopped, until 09:05:07');
});

test('MP-15 reason texts without the until part for the redo note', () => {
  assert.equal(REASON_TEXTS.rate_limited(null), 'rate limited');
  assert.equal(REASON_TEXTS.connection(null), 'can’t connect');
  assert.equal(REASON_TEXTS.timeout(null), 'no response');
  assert.equal(REASON_TEXTS.held(null), 'waiting to make sure it stopped');
});

test('MP-15 plain reason text drops until for the redo note and keeps other details', () => {
  assert.equal(plainReasonText('held', REASON_TEXTS.held(2_000_000)), 'waiting to make sure it stopped');
  assert.equal(plainReasonText('connection', REASON_TEXTS.connection(2_000_000)), 'can’t connect');
  assert.equal(plainReasonText('auth', 'API key rejected'), 'API key rejected');
});

test('MP-13 tried wraps the inner reason without until; earlier names the reply start', () => {
  assert.equal(REASON_TEXTS.tried(REASON_TEXTS.rate_limited(null)), 'failed earlier in this reply: rate limited');
  assert.equal(REASON_TEXTS.tried(REASON_TEXTS.auth()), 'failed earlier in this reply: API key rejected');
  assert.equal(REASON_TEXTS.earlier(), 'skipped at the start of this reply');
});

test('MP-06 no network zones: no zone reason codes, blocked-card actions or zone exports', () => {
  assert.equal(models.EXCLUSION_REASONS.some((code) => code.startsWith('zone')), false);
  assert.equal(Object.keys(REASON_TEXTS).some((code) => code.startsWith('zone')), false);
  assert.equal(models.BLOCKED_ACTIONS.some((action) => action.includes('zone')), false);
  for (const name of ['ZONES', 'ZoneSchema', 'DEFAULT_ZONES', 'suggestZone']) {
    assert.equal(models[name], undefined, name);
  }
});

test('MP-06 no network zones: the config, the provider form and the project file reject the zone fields', () => {
  const config = sampleConfig();
  config.providers[0].zone = 'public';
  config.allowedZones = ['local', 'intranet'];
  config.projectZones = {};
  const result = models.ModelConfigSchema.safeParse(config);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map((issue) => [issue.code, issue.path, issue.keys]), [
    ['unrecognized_keys', ['providers', 0], ['zone']],
    ['unrecognized_keys', [], ['allowedZones', 'projectZones']],
  ]);
  const form = { name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', compat: {}, concurrency: 4 };
  assert.equal(models.ProviderFormSchema.safeParse(form).success, true);
  assert.equal(models.ProviderFormSchema.safeParse({ ...form, zone: 'local' }).success, false, 'zone in the form');
  assert.equal(models.ProjectModelsFileSchema.safeParse({ allowedZones: ['local'] }).success, false, 'project file');
});

test('MP-29 auth, quota and not_found texts', () => {
  assert.equal(REASON_TEXTS.auth(), 'API key rejected');
  assert.equal(REASON_TEXTS.quota(), 'quota exhausted');
  assert.equal(REASON_TEXTS.not_found(), 'model not found on the server');
});

test('MP-30 missing text, and the removed-during-reply variant', () => {
  assert.equal(REASON_TEXTS.missing(), 'not in your model settings');
  assert.equal(REASON_TEXTS.missing(false), 'not in your model settings');
  assert.equal(REASON_TEXTS.missing(true), 'removed from your model settings');
});

test('MP-10 tool-calling profile reasons', () => {
  assert.equal(REASON_TEXTS.probing(), 'verifying…');
  assert.equal(REASON_TEXTS.unverified(), 'tool calling not verified yet');
  assert.equal(REASON_TEXTS.failed(), 'tool calling failed verification');
});

test('MP-21 no_handover texts: window too small, or rebuild failed with the original text', () => {
  assert.equal(REASON_TEXTS.no_handover(null), 'conversation too long for this model');
  assert.equal(REASON_TEXTS.no_handover('HTTP 500 boom'), 'couldn’t rebuild the conversation: HTTP 500 boom');
});

test('MP-19 queue_timeout text states the waited seconds', () => {
  assert.equal(REASON_TEXTS.queue_timeout(60_000), 'waited 60 s for a free slot');
  assert.equal(REASON_TEXTS.queue_timeout(1_500), 'waited 2 s for a free slot');
});

/** 有勾选框的兼容字段：CompatSchema 的字段去掉 supportsStrictMode（2026-10-26 负责人走查 M1，§9.1 的 2026-10-26 注） */
const SHOWN_COMPAT = Object.keys(models.CompatSchema.shape).filter((field) => field !== 'supportsStrictMode').sort();

test('MP-01 compat and API type labels cover every compat field that has a box with the §9.1 English text', () => {
  assert.deepEqual(Object.keys(models.COMPAT_LABELS).sort(), SHOWN_COMPAT);
  assert.deepEqual(Object.keys(models.COMPAT_HINTS).sort(), SHOWN_COMPAT);
  assert.deepEqual(Object.entries(models.COMPAT_LABELS), [
    ['supportsDeveloperRole', 'Endpoint doesn’t support the developer role'],
    ['supportsStore', 'Endpoint doesn’t accept the store field'],
    ['maxTokensField', 'Endpoint needs max_tokens instead of max_completion_tokens'],
    ['supportsUsageInStreaming', 'Endpoint doesn’t report usage while streaming'],
    ['requiresToolResultName', 'Tool results must include the tool name'],
  ]);
  assert.deepEqual(Object.entries(models.COMPAT_HINTS), [
    ['supportsDeveloperRole', 'Sends the system prompt with the system role instead'],
    ['supportsStore', 'Leaves store out of requests'],
    ['maxTokensField', 'Older endpoints don’t recognize max_completion_tokens'],
    ['supportsUsageInStreaming', 'Doesn’t send stream_options, so the context usage shown will be inaccurate'],
    ['requiresToolResultName', 'Some endpoints require a name field on tool result messages'],
  ]);
  assert.deepEqual(Object.keys(models.API_TYPE_LABELS), [...models.API_TYPES]);
  assert.equal(models.API_TYPE_LABELS['openai-completions'], 'OpenAI-compatible (Chat Completions)');
  assert.equal(models.API_TYPE_LABELS['openai-responses'], 'OpenAI Responses');
  assert.equal(models.API_TYPE_LABELS['anthropic-messages'], 'Anthropic Messages');
});

test('MP-01 compat options carry only field and value, one per compat field with a box; text lives in '
  + 'COMPAT_LABELS/HINTS', () => {
  assert.deepEqual(models.COMPAT_OPTIONS.map((option) => option.field).sort(), SHOWN_COMPAT);
  for (const option of models.COMPAT_OPTIONS) {
    assert.deepEqual(Object.keys(option).sort(), ['field', 'id', 'value']);
    assert.equal(models.CompatSchema.shape[option.field].safeParse(option.value).success, true);
  }
});

test('MP-01 protocol no longer exports the v0 connection form schemas', async () => {
  const protocol = await loadKernelModule('src/shared/protocol.ts');
  for (const name of ['EndpointSchema', 'ModelFormSchema', 'ConnectionSchema']) assert.equal(name in protocol, false);
  assert.deepEqual(protocol.COMPAT_OPTIONS, models.COMPAT_OPTIONS);
});

test('MP-01 a saved compat with supportsStrictMode (no box since 2026-10-26) still loads', () => {
  assert.equal(models.CompatSchema.safeParse({ supportsStrictMode: false, supportsStore: false }).success, true);
  assert.equal(models.CompatSchema.safeParse({ supportsStrictMode: true }).success, false);
});

test('MP-01 config schema accepts the §4.1 example', () => {
  assert.equal(models.ModelConfigSchema.safeParse(sampleConfig()).success, true);
});

test('MP-01 config schema rejects single-field violations and points at the location', () => {
  const cases = [
    ['unknown top-level field', (c) => { c.extra = 1; }, []],
    ['unknown provider field', (c) => { c.providers[0].apiKey = 'x'; }, ['providers', 0]],
    ['maxTokens not below window', (c) => { c.providers[0].models[0].maxTokens = 131072; },
      ['providers', 0, 'models', 0, 'maxTokens']],
    ['nextKeyNumber below 1', (c) => { c.providers[0].nextKeyNumber = 0; }, ['providers', 0, 'nextKeyNumber']],
    ['key ref with a space', (c) => { c.providers[0].keys[0].ref = 'a b'; }, ['providers', 0, 'keys', 0, 'ref']],
    ['provider id uppercase', (c) => { c.providers[0].id = 'DeepSeek'; }, ['providers', 0, 'id']],
    ['provider id longer than 40', (c) => { c.providers[0].id = 'a'.repeat(41); }, ['providers', 0, 'id']],
    ['concurrency above 64', (c) => { c.providers[0].concurrency = 65; }, ['providers', 0, 'concurrency']],
    ['nine keys', (c) => {
      c.providers[0].keys = Array.from({ length: 9 }, (_, i) => ({ ref: `k${i}`, label: `Key ${i}` }));
    }, ['providers', 0, 'keys']],
    ['empty group', (c) => { c.groups[0].members = []; }, ['groups', 0, 'members']],
    ['repeated group member', (c) => { c.groups[0].members = ['glm', 'glm']; }, ['groups', 0, 'members']],
    ['duplicate model id', (c) => { c.providers[0].models.push({ ...c.providers[0].models[0] }); },
      ['providers', 0, 'models']],
  ];
  for (const [name, mutate, path] of cases) {
    const config = sampleConfig();
    mutate(config);
    const result = models.ModelConfigSchema.safeParse(config);
    assert.equal(result.success, false, name);
    const paths = result.error.issues.map((issue) => issue.path.slice(0, path.length));
    assert.ok(paths.some((p) => JSON.stringify(p) === JSON.stringify(path)), `${name}: ${JSON.stringify(paths)}`);
  }
});

test('MP-07 project config schema accepts the §4.3 example and rejects bad shapes', () => {
  const schema = models.ProjectModelsFileSchema;
  assert.equal(schema.safeParse({ groups: { cloud: ['glm/glm-4.6'] } }).success, true);
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ groups: {}, providers: [] }).success, false, 'unknown field');
  assert.equal(schema.safeParse({ groups: { cloud: [] } }).success, false, 'empty group list');
  assert.equal(schema.safeParse({ groups: { cloud: ['glm', 'glm'] } }).success, false, 'repeated member');
});

test('MP-15 session custom entry types', () => {
  assert.deepEqual({ ...models.MODEL_ENTRY_TYPES },
    { pick: 'mori.pick', modelSwitch: 'mori.model_switch', rebuild: 'mori.rebuild',
      taskRestart: 'mori.task_restart' });
});

/** 按 ModelCommandSchemas 里 type 对应的那个 schema 校验一条命令。 */
function parseCommand(command) {
  const schema = models.ModelCommandSchemas.find((item) => item.shape.type.value === command.type);
  return schema.safeParse(command);
}

test('MP-30 delete commands take dryRun so the dialog can list the consequences first', () => {
  const commands = [{ type: 'models.deleteProvider', id: 'glm' },
    { type: 'models.deleteModel', providerId: 'glm', modelId: 'glm-4.6' }, { type: 'models.deleteGroup', id: 'cloud' }];
  for (const command of commands) {
    assert.equal(parseCommand({ ...command, dryRun: true }).success, true, command.type);
    assert.equal(parseCommand({ ...command, dryRun: false }).success, true, command.type);
    assert.equal(parseCommand(command).success, false, `${command.type} without dryRun`);
  }
});

test('MP-23 session.pickOptions takes only the session id', () => {
  assert.equal(parseCommand({ type: 'session.pickOptions', sessionId: 's1' }).success, true);
  assert.equal(parseCommand({ type: 'session.pickOptions', sessionId: '' }).success, false);
  assert.equal(parseCommand({ type: 'session.pickOptions' }).success, false);
});
