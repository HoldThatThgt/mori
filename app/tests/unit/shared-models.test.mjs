// shared/models.ts 的单元测试：§5.3 原因文字、§9.1 的英文标签、配置与项目配置的单字段校验、自定义条目的类型名、
// §12 区域建议、§9.5 命令的参数。

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
      zone: 'public', compat: { maxTokensField: 'max_tokens' }, concurrency: 4,
      keys: [{ ref: 'deepseek-2#1', label: 'Key 1' }], nextKeyNumber: 2,
      models: [{ id: 'deepseek-chat', family: 'deepseek', contextWindow: 131072, maxTokens: 8192,
        reasoning: false, input: ['text'] }],
    }],
    groups: [{ id: 'cloud', members: ['deepseek-2/deepseek-chat', 'glm'] }],
    normalDefault: 'cloud',
    allowedZones: ['local', 'intranet'],
    projectZones: { 'd:/work/tool': ['public'] },
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

test('MP-06 zone reasons name the blocked zone', () => {
  assert.equal(REASON_TEXTS.zone_blocked('public'), 'zone public is not allowed for this project');
  assert.equal(REASON_TEXTS.zone_blocked('intranet'), 'zone intranet is not allowed for this project');
  assert.equal(REASON_TEXTS.zone_unconfirmed(), 'network zone not confirmed');
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

test('MP-01 compat and API type labels cover every config value with the §9.1 English text', () => {
  assert.deepEqual(Object.keys(models.COMPAT_LABELS).sort(), Object.keys(models.CompatSchema.shape).sort());
  assert.deepEqual(Object.keys(models.COMPAT_HINTS).sort(), Object.keys(models.CompatSchema.shape).sort());
  assert.deepEqual(Object.entries(models.COMPAT_LABELS), [
    ['supportsDeveloperRole', 'Endpoint doesn’t support the developer role'],
    ['supportsStore', 'Endpoint doesn’t accept the store field'],
    ['maxTokensField', 'Endpoint needs max_tokens instead of max_completion_tokens'],
    ['supportsUsageInStreaming', 'Endpoint doesn’t report usage while streaming'],
    ['supportsStrictMode', 'Endpoint doesn’t support strict mode for tool parameters'],
    ['requiresToolResultName', 'Tool results must include the tool name'],
  ]);
  assert.deepEqual(Object.entries(models.COMPAT_HINTS), [
    ['supportsDeveloperRole', 'Sends the system prompt with the system role instead'],
    ['supportsStore', 'Leaves store out of requests'],
    ['maxTokensField', 'Older endpoints don’t recognize max_completion_tokens'],
    ['supportsUsageInStreaming', 'Doesn’t send stream_options, so the context usage shown will be inaccurate'],
    ['supportsStrictMode', 'Leaves strict out of tool definitions'],
    ['requiresToolResultName', 'Some endpoints require a name field on tool result messages'],
  ]);
  assert.deepEqual(Object.keys(models.API_TYPE_LABELS), [...models.API_TYPES]);
  assert.equal(models.API_TYPE_LABELS['openai-completions'], 'OpenAI-compatible (Chat Completions)');
  assert.equal(models.API_TYPE_LABELS['openai-responses'], 'OpenAI Responses');
  assert.equal(models.API_TYPE_LABELS['anthropic-messages'], 'Anthropic Messages');
});

test('MP-01 compat options carry only field and value, one per compat field; text lives in COMPAT_LABELS/HINTS', () => {
  assert.deepEqual(models.COMPAT_OPTIONS.map((option) => option.field).sort(),
    Object.keys(models.CompatSchema.shape).sort());
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

test('MP-01 config schema accepts the §4.1 example', () => {
  assert.equal(models.ModelConfigSchema.safeParse(sampleConfig()).success, true);
});

test('MP-01 config schema rejects single-field violations and points at the location', () => {
  const cases = [
    ['unknown top-level field', (c) => { c.extra = 1; }, []],
    ['unknown provider field', (c) => { c.providers[0].apiKey = 'x'; }, ['providers', 0]],
    ['maxTokens not below window', (c) => { c.providers[0].models[0].maxTokens = 131072; },
      ['providers', 0, 'models', 0, 'maxTokens']],
    ['public in allowedZones', (c) => { c.allowedZones = ['local', 'public']; }, ['allowedZones', 1]],
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
    ['non-normalized project path', (c) => { c.projectZones = { 'D:\\work': ['public'] }; }, ['projectZones']],
    ['project path not all lowercase', (c) => { c.projectZones = { 'd:/Work/Tool': ['public'] }; }, ['projectZones']],
    ['project path with a trailing slash', (c) => { c.projectZones = { 'd:/work/': ['public'] }; }, ['projectZones']],
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
  assert.equal(schema.safeParse({ allowedZones: ['local'], groups: { cloud: ['glm/glm-4.6'] } }).success, true);
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ allowedZones: ['local'], providers: [] }).success, false, 'unknown field');
  assert.equal(schema.safeParse({ groups: { cloud: [] } }).success, false, 'empty group list');
  assert.equal(schema.safeParse({ groups: { cloud: ['glm', 'glm'] } }).success, false, 'repeated member');
  assert.equal(schema.safeParse({ allowedZones: ['moon'] }).success, false, 'unknown zone');
});

test('MP-15 session custom entry types', () => {
  assert.deepEqual({ ...models.MODEL_ENTRY_TYPES },
    { pick: 'mori.pick', modelSwitch: 'mori.model_switch', rebuild: 'mori.rebuild' });
});

test('MP-08 zone suggestion: loopback is local', () => {
  for (const url of ['http://127.0.0.1:8000/v1', 'http://127.5.6.7/', 'http://127.1/', 'http://[::1]:11434',
    'http://localhost:1234', 'http://LOCALHOST./v1', 'http://[::ffff:127.0.0.1]:8000/v1']) {
    assert.equal(models.suggestZone(url), 'local', url);
  }
});

test('MP-08 zone suggestion: private ranges, link-local, fc00::/7, fe80::/10, .local and dotless hosts are intranet',
  () => {
    for (const url of ['http://10.1.2.3/v1', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.10:8000',
      'http://169.254.10.1/', 'http://[fd12:3456::1]:8000/v1', 'http://[fc00::1]/', 'http://[fe80::1]/',
      'http://[febf::1]/', 'http://[::ffff:192.168.1.10]/', 'http://[::ffff:a01:203]/', 'http://gpu-box.local/v1',
      'http://gpu-box:8000/v1']) {
      assert.equal(models.suggestZone(url), 'intranet', url);
    }
  });

test('MP-08 zone suggestion: everything else is public', () => {
  for (const url of ['https://api.deepseek.com', 'http://172.32.0.1/', 'http://172.15.0.1/', 'http://11.0.0.1/',
    'http://[2001:db8::1]/', 'http://[fec0::1]/', 'http://[::ffff:8.8.8.8]/', 'http://[::2]/', 'not a url']) {
    assert.equal(models.suggestZone(url), 'public', url);
  }
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
