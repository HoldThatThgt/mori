// kernel/modelMigrate.ts 的单元测试：§4.5 迁移表的每一行与边界情况；runMigration 用临时目录与注入的加密、写文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from './load.mjs';

const mm = await loadKernelModule('src/kernel/modelMigrate.ts');
const mc = await loadKernelModule('src/kernel/modelConfig.ts');
const RESERVED = mc.reservedIds(['deepseek', 'openai']);
const NOW = 1_760_000_000_000;

/** 迁移一段 models.json 文本。 */
function migrate(text, extra = {}) {
  return mm.migrateV0Models({ text, source: 'C:/agent/models.json', credentialRefs: [], unreadableRefs: [],
    settings: {}, reserved: RESERVED, now: NOW, ...extra });
}

/** 迁移一个 models.json 对象。 */
function migrateFile(file, extra = {}) {
  return migrate(JSON.stringify(file), extra);
}

/** v0 的一个 Mori 连接。 */
function endpoint(extra = {}) {
  return { name: 'Endpoint', baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions',
    models: [{ id: 'fake-coder', contextWindow: 32000, reasoning: true }], ...extra };
}

test('MP-08 every provider migrates with its id, name, address and API type', () => {
  const result = migrateFile({ providers: {
    'mori-endpoint': endpoint(),
    'my-ollama': { baseUrl: 'http://gpu-box:11434/v1', api: 'openai-responses', models: [{ id: 'qwen3' }] },
  } });
  assert.equal(result.kind, 'migrated');
  const [first, second] = result.config.providers;
  assert.deepEqual(first, { id: 'mori-endpoint', name: 'Endpoint', api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8000/v1', zone: null, compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1,
    models: [{ id: 'fake-coder', family: '', contextWindow: 32000, maxTokens: 16384, reasoning: true,
      input: ['text'] }] });
  assert.equal(second.id, 'my-ollama');
  assert.equal(second.name, 'my-ollama', 'name falls back to the id');
  assert.equal(second.api, 'openai-responses');
  assert.deepEqual(result.config.groups, []);
  assert.deepEqual(result.config.allowedZones, ['local', 'intranet']);
  assert.deepEqual(result.config.projectZones, {});
  assert.deepEqual(result.notice.providers, [{ from: 'mori-endpoint', id: 'mori-endpoint', name: 'Endpoint' },
    { from: 'my-ollama', id: 'my-ollama', name: 'my-ollama' }]);
  assert.equal(result.notice.at, NOW);
  assert.equal(mc.parseModelConfig(result.config, { reserved: RESERVED }).ok, true);
});

test('MP-08 models.json is read the v0 way: BOM, // comments and trailing commas', () => {
  const text = '\uFEFF{\n  // my endpoint\n  "providers": {\n    "mori-endpoint": {\n'
    + '      "baseUrl": "http://127.0.0.1:8000/v1", // address\n      "api": "openai-completions",\n'
    + '      "name": "a // not a comment",\n      "models": [{ "id": "m1", }, ],\n    },\n  },\n}\n';
  const result = migrate(text);
  assert.equal(result.kind, 'migrated');
  assert.equal(result.config.providers[0].name, 'a // not a comment');
  assert.deepEqual(result.config.providers[0].models.map((m) => m.id), ['m1']);
});

test('MP-08 an unreadable models.json fails the migration', () => {
  const result = migrate('{ "providers": ');
  assert.equal(result.kind, 'failed');
  assert.match(result.error, /^Cannot parse C:\/agent\/models\.json: /);
  assert.equal(migrate('[1, 2]').kind, 'failed');
  assert.match(migrateFile({ providers: [endpoint()] }).error, /providers is not an object/);
});

test('MP-08 empty or missing providers count as first run', () => {
  assert.deepEqual(migrateFile({}), { kind: 'empty' });
  assert.deepEqual(migrateFile({ providers: {} }), { kind: 'empty' });
  assert.deepEqual(migrateFile({ providers: null }), { kind: 'empty' });
});

test('MP-08 no provider that can be migrated: no config, the notice becomes the migration error', () => {
  const result = migrateFile({ providers: {
    gem: endpoint({ api: 'google-generative-ai' }), empty: endpoint({ models: [] }),
  } });
  assert.equal(result.kind, 'failed');
  assert.equal(result.error, 'No provider in C:/agent/models.json could be migrated: '
    + 'gem: API type "google-generative-ai" is not supported; empty: no usable models');
});

test('MP-08 invalid and reserved ids are rewritten by the §4.1 rule, clashes get -2, -3', () => {
  const result = migrateFile({ providers: {
    glm: endpoint(), 'GLM': endpoint(), 'glm!': endpoint(), deepseek: endpoint(), mori: endpoint(),
    'Deep Seek': endpoint(),
  } });
  assert.deepEqual(result.notice.providers.map((p) => [p.from, p.id]), [
    ['glm', 'glm'], ['GLM', 'glm-2'], ['glm!', 'glm-3'], ['deepseek', 'deepseek-2'], ['mori', 'mori-2'],
    ['Deep Seek', 'deep-seek'],
  ]);
  assert.equal(mc.parseModelConfig(result.config, { reserved: RESERVED }).ok, true);
});

test('MP-08 ids that stay valid claim their names before rewritten ones', () => {
  const result = migrateFile({ providers: { 'Local': endpoint(), local: endpoint() } });
  assert.deepEqual(result.notice.providers.map((p) => [p.from, p.id]), [['Local', 'local-2'], ['local', 'local']]);
});

test('MP-08 an id with no letters or digits is rewritten to provider, -2 on a clash, and listed', () => {
  const result = migrateFile({ providers: { '深度求索': endpoint({ apiKey: 'sk-x' }), '智谱': endpoint(),
    ok: endpoint() } });
  assert.deepEqual(result.notice.providers.map((p) => [p.from, p.id]),
    [['深度求索', 'provider'], ['智谱', 'provider-2'], ['ok', 'ok']]);
  assert.deepEqual(result.notice.dropped, []);
  assert.deepEqual(result.keysToEncrypt, [{ ref: 'provider', secret: 'sk-x' }], 'the old id cannot be a ref');
  assert.equal(mc.parseModelConfig(result.config, { reserved: RESERVED }).ok, true);
});

test('MP-08 providers with an unsupported API type are not migrated and are listed', () => {
  const result = migrateFile({ providers: {
    gem: endpoint({ api: 'google-generative-ai' }), none: endpoint({ api: undefined }), ok: endpoint(),
  } });
  assert.deepEqual(result.config.providers.map((p) => p.id), ['ok']);
  assert.deepEqual(result.notice.dropped, [
    { subject: 'gem', reason: 'API type "google-generative-ai" is not supported' },
    { subject: 'none', reason: 'API type null is not supported' },
  ]);
});

test('MP-08 a provider with a bad address is listed as dropped', () => {
  const result = migrateFile({ providers: { bad: endpoint({ baseUrl: 'ftp://x' }), ok: endpoint() } });
  assert.deepEqual(result.config.providers.map((p) => p.id), ['ok']);
  assert.equal(result.notice.dropped[0].subject, 'bad');
  assert.match(result.notice.dropped[0].reason, /baseUrl: Base URL must be an http or https URL/);
});

test('MP-08 compat keeps only the values v0 wrote when ticked; the rest is listed', () => {
  const result = migrateFile({ providers: { e: endpoint({ compat: {
    supportsStore: false, maxTokensField: 'max_tokens', supportsDeveloperRole: true, requiresToolResultName: true,
    thinkingFormat: 'qwen', supportsUsageInStreaming: false, supportsStrictMode: false,
  } }) } });
  assert.deepEqual(result.config.providers[0].compat, { supportsStore: false, maxTokensField: 'max_tokens',
    requiresToolResultName: true, supportsUsageInStreaming: false, supportsStrictMode: false });
  assert.deepEqual(result.notice.dropped, [
    { subject: 'e compat.supportsDeveloperRole', reason: 'value true is not supported' },
    { subject: 'e compat.thinkingFormat', reason: 'not a supported compat option' },
  ]);
});

test('MP-08 a saved ciphertext becomes Key 1 with the v0 id as ref', () => {
  const result = migrateFile({ providers: { 'mori-endpoint': endpoint(), other: endpoint() } },
    { credentialRefs: ['mori-endpoint', 'unrelated'] });
  assert.deepEqual(result.config.providers[0].keys, [{ ref: 'mori-endpoint', label: 'Key 1' }]);
  assert.equal(result.config.providers[0].nextKeyNumber, 1);
  assert.deepEqual(result.config.providers[1].keys, []);
  assert.deepEqual(result.keysToEncrypt, []);
});

test('MP-08 a key keeps the v0 id as ref even when the provider id is rewritten', () => {
  const result = migrateFile({ providers: { deepseek: endpoint() } }, { credentialRefs: ['deepseek'] });
  assert.equal(result.config.providers[0].id, 'deepseek-2');
  assert.deepEqual(result.config.providers[0].keys, [{ ref: 'deepseek', label: 'Key 1' }]);
  assert.equal(mc.nextKeyRef(result.config, 'deepseek-2').ref, 'deepseek-2#1');
});

test('MP-08 a plaintext apiKey is handed over for encryption under the provider id', () => {
  const result = migrateFile({ providers: { e: endpoint({ apiKey: 'sk-plain' }) } });
  assert.deepEqual(result.keysToEncrypt, [{ ref: 'e', secret: 'sk-plain' }]);
  assert.deepEqual(result.config.providers[0].keys, [{ ref: 'e', label: 'Key 1' }]);
  assert.ok(!JSON.stringify(result.config).includes('sk-plain'));
  assert.ok(!JSON.stringify(result.notice).includes('sk-plain'));
});

test('MP-08 the ciphertext wins over a plaintext apiKey, and the notice says so', () => {
  const result = migrateFile({ providers: { e: endpoint({ apiKey: 'sk-plain' }) } }, { credentialRefs: ['e'] });
  assert.deepEqual(result.keysToEncrypt, []);
  assert.deepEqual(result.config.providers[0].keys, [{ ref: 'e', label: 'Key 1' }]);
  assert.deepEqual(result.notice.keptCiphertext, ['e']);
});

test('MP-08 a $ENV apiKey is not migrated and is listed as needing a key again', () => {
  const result = migrateFile({ providers: { 'My Env': endpoint({ apiKey: '$OPENAI_API_KEY' }) } });
  assert.deepEqual(result.config.providers[0].keys, []);
  assert.deepEqual(result.keysToEncrypt, []);
  assert.deepEqual(result.notice.reenterKeys, ['my-env']);
  assert.deepEqual(result.notice.keptCiphertext, []);
});

test('MP-08 a plaintext key of an id that cannot be a ref is stored under the new id', () => {
  const result = migrateFile({ providers: { 'My Box': endpoint({ apiKey: 'sk-1' }) } });
  assert.equal(result.config.providers[0].id, 'my-box');
  assert.deepEqual(result.keysToEncrypt, [{ ref: 'my-box', secret: 'sk-1' }]);
  assert.deepEqual(result.config.providers[0].keys, [{ ref: 'my-box', label: 'Key 1' }]);
});

test('MP-08 model defaults: pi window and output, half the window when output is not smaller', () => {
  const result = migrateFile({ providers: { e: endpoint({ models: [
    { id: 'plain' },
    { id: 'big-out', contextWindow: 8000, maxTokens: 8000 },
    { id: 'given', contextWindow: 65536, maxTokens: 4096, reasoning: true, input: ['text', 'image'] },
    { id: 'no-max', contextWindow: 10000 },
  ] }) } });
  assert.deepEqual(result.config.providers[0].models, [
    { id: 'plain', family: '', contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ['text'] },
    { id: 'big-out', family: '', contextWindow: 8000, maxTokens: 4000, reasoning: false, input: ['text'] },
    { id: 'given', family: '', contextWindow: 65536, maxTokens: 4096, reasoning: true, input: ['text', 'image'] },
    { id: 'no-max', family: '', contextWindow: 10000, maxTokens: 5000, reasoning: false, input: ['text'] },
  ]);
  assert.deepEqual(result.notice.dropped, []);
});

test('MP-08 invalid models are dropped and listed; a provider with none left is not migrated', () => {
  const result = migrateFile({ providers: {
    e: endpoint({ models: [{ id: 'ok' }, { id: 'has space' }, { contextWindow: 100 }, { id: 'ok' },
      { id: 'neg', contextWindow: -5 }, { id: 'pic', input: ['image'] }, 'junk'] }),
    empty: endpoint({ models: [{ id: '' }] }),
    nomodels: endpoint({ models: undefined }),
  } });
  assert.deepEqual(result.config.providers.map((p) => p.id), ['e']);
  assert.deepEqual(result.config.providers[0].models.map((m) => m.id), ['ok']);
  const subjects = result.notice.dropped.map((d) => d.subject);
  assert.deepEqual(subjects, ['e/has space', 'e/#3', 'e/ok', 'e/neg', 'e/pic', 'e/#7', 'empty/', 'empty',
    'nomodels']);
  assert.equal(result.notice.dropped.find((d) => d.subject === 'e/ok').reason, 'duplicate model id');
  assert.equal(result.notice.dropped.find((d) => d.subject === 'empty').reason, 'no usable models');
});

test('MP-08 the pi default model becomes the default range, following rewritten ids', () => {
  const file = { providers: { deepseek: endpoint(), e: endpoint() } };
  const renamed = migrateFile(file, { settings: { defaultProvider: 'deepseek', defaultModel: 'fake-coder' } });
  assert.equal(renamed.config.normalDefault, 'deepseek-2/fake-coder');
  const kept = migrateFile(file, { settings: { defaultProvider: 'e', defaultModel: 'fake-coder' } });
  assert.equal(kept.config.normalDefault, 'e/fake-coder');
  const missing = migrateFile(file, { settings: { defaultProvider: 'e', defaultModel: 'gone' } });
  assert.equal(missing.config.normalDefault, null);
  assert.equal(migrateFile(file).config.normalDefault, null);
});

test('MP-08 a default on a provider that was not migrated is null', () => {
  const result = migrateFile({ providers: { gem: endpoint({ api: 'google' }), e: endpoint() } },
    { settings: { defaultProvider: 'gem', defaultModel: 'fake-coder' } });
  assert.equal(result.config.normalDefault, null);
});

test('MP-08 modelThinkingLevels are copied to the rewritten keys; the old keys stay', () => {
  const settings = { modelThinkingLevels: { 'deepseek/fake-coder': 'high', 'deepseek/other': 'low', 'e/fake-coder':
    'off' } };
  const result = migrateFile({ providers: { deepseek: endpoint(), e: endpoint() } }, { settings });
  assert.deepEqual(result.thinkingCopies, [{ from: 'deepseek/fake-coder', to: 'deepseek-2/fake-coder' }]);
  assert.deepEqual(migrateFile({ providers: { e: endpoint() } }, { settings }).thinkingCopies, []);
});

test('MP-08 migrated providers have an unconfirmed zone; suggestions follow §12', () => {
  const result = migrateFile({ providers: { a: endpoint(), b: endpoint({ baseUrl: 'https://api.deepseek.com' }) } });
  assert.deepEqual(result.config.providers.map((p) => p.zone), [null, null]);
  assert.deepEqual(mc.zoneSuggestions(result.config), { a: 'local', b: 'public' });
});

test('MP-08 other provider fields are not carried over', () => {
  const result = migrateFile({ providers: { e: endpoint({ headers: { 'X-A': '1' }, authHeader: true }) } });
  assert.deepEqual(Object.keys(result.config.providers[0]).sort(),
    ['api', 'baseUrl', 'compat', 'concurrency', 'id', 'keys', 'models', 'name', 'nextKeyNumber', 'zone']);
});

/** 一个迁移用的临时 userData 与 agentDir。 */
function scratch(modelsText) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-migrate-'));
  const modelsPath = join(dir, 'agent', 'models.json');
  if (modelsText !== null) {
    mkdirSync(join(dir, 'agent'));
    writeFileSync(modelsPath, modelsText);
  }
  const encrypted = [];
  const io = {
    modelsPath,
    configPath: join(dir, 'model-config.json'),
    noticePath: join(dir, 'model-migration.json'),
    data: { credentialRefs: [], unreadableRefs: [], settings: {}, reserved: RESERVED, now: NOW },
    encryptKey: async (ref, secret) => { encrypted.push({ ref, secret }); },
  };
  return { dir, io, encrypted };
}

test('MP-08 runMigration writes the config and the notice and encrypts plaintext keys', async () => {
  const { io, encrypted } = scratch(JSON.stringify({ providers: { e: endpoint({ apiKey: 'sk-x' }) } }));
  const run = await mm.runMigration(io);
  assert.equal(run.kind, 'migrated');
  assert.equal(run.noticeError, null);
  assert.deepEqual(encrypted, [{ ref: 'e', secret: 'sk-x' }]);
  const config = JSON.parse(readFileSync(io.configPath, 'utf8'));
  assert.deepEqual(config, run.config);
  assert.deepEqual(JSON.parse(readFileSync(io.noticePath, 'utf8')), run.notice);
  assert.ok(!readFileSync(io.configPath, 'utf8').includes('sk-x'));
  assert.ok(!readFileSync(io.noticePath, 'utf8').includes('sk-x'));
  assert.deepEqual(await mc.readModelConfig(io.configPath, RESERVED), { kind: 'ok', config });
});

test('MP-08 runMigration runs only once: later changes to models.json have no effect', async () => {
  const { io } = scratch(JSON.stringify({ providers: { e: endpoint() } }));
  await mm.runMigration(io);
  const before = readFileSync(io.configPath, 'utf8');
  writeFileSync(io.modelsPath, JSON.stringify({ providers: { e: endpoint(), f: endpoint() } }));
  assert.deepEqual(await mm.runMigration(io), { kind: 'skipped' });
  assert.equal(readFileSync(io.configPath, 'utf8'), before);
});

test('MP-08 runMigration with no models.json or no providers writes nothing (first run)', async () => {
  const missing = scratch(null);
  assert.deepEqual(await mm.runMigration(missing.io), { kind: 'empty' });
  assert.equal(existsSync(missing.io.configPath), false);
  const empty = scratch('{ "providers": {} }');
  assert.deepEqual(await mm.runMigration(empty.io), { kind: 'empty' });
  assert.equal(existsSync(empty.io.configPath), false);
  assert.equal(existsSync(empty.io.noticePath), false);
});

test('MP-08 runMigration with no provider that can be migrated writes nothing and reports why', async () => {
  const { io } = scratch(JSON.stringify({ providers: { gem: endpoint({ api: 'google' }) } }));
  const run = await mm.runMigration(io);
  assert.equal(run.kind, 'failed');
  assert.match(run.error, /^No provider in .*models\.json could be migrated: gem: API type "google" is not supported$/);
  assert.equal(existsSync(io.configPath), false);
  assert.equal(existsSync(io.noticePath), false);
});

test('MP-08 a failed key encryption fails the migration and writes no config', async () => {
  const { io } = scratch(JSON.stringify({ providers: { e: endpoint({ apiKey: 'sk-x' }) } }));
  io.encryptKey = async () => { throw new Error('safeStorage unavailable'); };
  const run = await mm.runMigration(io);
  assert.deepEqual(run, { kind: 'failed', error: 'Cannot save the API key e: safeStorage unavailable' });
  assert.equal(existsSync(io.configPath), false);
  assert.equal(existsSync(io.noticePath), false);
});

test('MP-08 an unreadable models.json fails the migration and writes no config', async () => {
  const { io } = scratch('{ broken');
  const run = await mm.runMigration(io);
  assert.equal(run.kind, 'failed');
  assert.match(run.error, /^Cannot parse /);
  assert.equal(existsSync(io.configPath), false);
});

test('MP-08 a failed config write fails the migration; a failed notice write is reported only', async () => {
  const failing = scratch(JSON.stringify({ providers: { e: endpoint() } }));
  failing.io.writeJson = async () => { throw new Error('disk full'); };
  assert.deepEqual(await mm.runMigration(failing.io), { kind: 'failed', error: 'disk full' });
  const notice = scratch(JSON.stringify({ providers: { e: endpoint() } }));
  const writes = [];
  notice.io.writeJson = async (path, value) => {
    if (path === notice.io.noticePath) throw new Error('denied');
    writes.push(path);
    writeFileSync(path, JSON.stringify(value));
  };
  const run = await mm.runMigration(notice.io);
  assert.equal(run.kind, 'migrated');
  assert.equal(run.noticeError, `Cannot write ${notice.io.noticePath}: denied`);
  assert.deepEqual(writes, [notice.io.configPath]);
});

test('MP-08 a ciphertext that could not be decrypted still migrates as Key 1 and is listed for re-entry', () => {
  const result = migrateFile({ providers: { e: endpoint(), f: endpoint() } },
    { credentialRefs: ['e', 'f'], unreadableRefs: ['f'] });
  assert.deepEqual(result.config.providers.map((p) => p.keys), [[{ ref: 'e', label: 'Key 1' }],
    [{ ref: 'f', label: 'Key 1' }]]);
  assert.deepEqual(result.keysToEncrypt, []);
  assert.deepEqual(result.notice.reenterKeys, ['f']);
});

test('MP-26 a models.json syntax error near a plaintext key does not quote the key', async () => {
  const texts = ['{ "providers": { "e": { "apiKey": sk-proj-SECRET123 } } }',
    "{ 'providers': { 'e': { 'apiKey': 'sk-proj-SECRET123' } } }"];
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    for (const text of texts) {
      const result = migrate(text);
      assert.equal(result.kind, 'failed');
      assert.match(result.error, /^Cannot parse C:\/agent\/models\.json: not valid JSON/);
      assert.ok(!/SECRET|sk-proj/.test(result.error), result.error);
      const run = await mm.runMigration(scratch(text).io);
      assert.equal(run.kind, 'failed');
      assert.ok(!/SECRET|sk-proj/.test(run.error), run.error);
    }
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !/SECRET|sk-proj/.test(line)), logged.join('\n'));
});
