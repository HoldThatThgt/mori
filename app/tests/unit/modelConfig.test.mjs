// kernel/modelConfig.ts 的单元测试：§4.1 跨字段校验、id 生成、key 编号、删除的连带改动、改地址删 key；
// §4.3 项目配置与允许的区域；§5.1 范围展开与旧会话的选择范围；§12 区域建议（规则的测试在 shared-models）；配置文件的读写。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKernelModule } from './load.mjs';

const mc = await loadKernelModule('src/kernel/modelConfig.ts');
const RESERVED = mc.reservedIds(['deepseek', 'openai']);

/** 一个模型。 */
function model(id, extra = {}) {
  return { id, family: '', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'], ...extra };
}

/** 一个提供商。 */
function provider(id, models, extra = {}) {
  return { id, name: id.toUpperCase(), api: 'openai-completions', baseUrl: `https://${id}.example.com/v1`,
    zone: 'public', compat: {}, concurrency: 4, keys: [], nextKeyNumber: 1, models: models.map((m) => model(m)),
    ...extra };
}

/** 三个提供商、两个分组的配置。 */
function baseConfig() {
  return {
    version: 1,
    providers: [
      provider('ds', ['chat', 'reasoner'], { keys: [{ ref: 'ds#1', label: 'Key 1' }, { ref: 'ds#2', label: 'Key 2' }],
        nextKeyNumber: 3 }),
      provider('glm', ['glm-4.6', 'glm-4.5', 'glm-air']),
      provider('local', ['qwen'], { zone: 'local', baseUrl: 'http://127.0.0.1:8000/v1' }),
    ],
    groups: [
      { id: 'cloud', members: ['ds/chat', 'glm'] },
      { id: 'mixed', members: ['local', 'ds', 'glm/glm-air'] },
    ],
    normalDefault: 'cloud',
    allowedZones: ['local', 'intranet'],
    projectZones: { 'd:/work/tool': ['public'] },
  };
}

/** 校验并返回 "<位置>" 列表。 */
function issuePaths(config, options = {}) {
  const parsed = mc.parseModelConfig(config, { reserved: RESERVED, ...options });
  return parsed.ok ? [] : parsed.issues.map((issue) => issue.path.join('.'));
}

test('MP-01 a valid config passes cross-field validation', () => {
  assert.deepEqual(mc.parseModelConfig(baseConfig(), { reserved: RESERVED }), { ok: true, config: baseConfig() });
});

test('MP-01 reserved ids include mori and the pi built-in providers', () => {
  assert.deepEqual(mc.reservedIds(['deepseek', 'mori', 'openai']), ['mori', 'deepseek', 'openai']);
});

test('MP-01 duplicate provider ids, group/provider name clash and reserved ids are located', () => {
  const config = baseConfig();
  config.providers.push(provider('glm', ['x']));
  config.groups.push({ id: 'ds', members: ['glm'] });
  config.groups.push({ id: 'mori', members: ['glm'] });
  config.providers.push(provider('deepseek', ['x']));
  const paths = issuePaths(config);
  assert.ok(paths.includes('providers.3.id'), paths.join());
  assert.ok(paths.includes('providers.4.id'), paths.join());
  assert.ok(paths.includes('groups.2.id'), paths.join());
  assert.ok(paths.includes('groups.3.id'), paths.join());
  const parsed = mc.parseModelConfig(config, { reserved: RESERVED });
  const text = mc.formatIssues(parsed.issues);
  assert.match(text, /providers\.3\.id: glm is already used by a provider or group/);
  assert.match(text, /groups\.2\.id: ds is already used by a provider or group/);
  assert.match(text, /groups\.3\.id: mori is reserved/);
  assert.match(text, /providers\.4\.id: deepseek is reserved/);
});

test('MP-01 duplicate group ids are located', () => {
  const config = baseConfig();
  config.groups.push({ id: 'cloud', members: ['glm'] });
  assert.deepEqual(issuePaths(config), ['groups.2.id']);
});

test('MP-01 key refs must be globally unique', () => {
  const config = baseConfig();
  config.providers[1].keys = [{ ref: 'ds#1', label: 'Copy' }];
  assert.deepEqual(issuePaths(config), ['providers.1.keys.0.ref']);
});

test('MP-01 references to missing names in groups and normalDefault are located and named', () => {
  const config = baseConfig();
  config.groups[0].members = ['ds/nope', 'gone'];
  config.normalDefault = 'ghost';
  const parsed = mc.parseModelConfig(config, { reserved: RESERVED });
  assert.deepEqual(parsed.issues.map((i) => i.path.join('.')), ['groups.0.members.0', 'groups.0.members.1',
    'normalDefault']);
  assert.equal(parsed.issues[0].message, 'ds/nope is not in your model settings (member of group cloud)');
  assert.equal(parsed.issues[2].message, 'ghost is not in your model settings (default model range)');
});

test('MP-01 normalDefault may name a group, a provider or a model, or be null', () => {
  for (const pick of ['cloud', 'glm', 'glm/glm-4.5', null]) {
    const config = { ...baseConfig(), normalDefault: pick };
    assert.deepEqual(issuePaths(config), [], String(pick));
  }
  assert.deepEqual(issuePaths({ ...baseConfig(), normalDefault: 'glm/missing' }), ['normalDefault']);
});

test('MP-01 nextKeyNumber must not go back against the previous config', () => {
  const previous = baseConfig();
  const config = baseConfig();
  config.providers[0].keys = [];
  config.providers[0].nextKeyNumber = 2;
  assert.deepEqual(issuePaths(config, { previous }), ['providers.0.nextKeyNumber']);
  const message = mc.parseModelConfig(config, { reserved: RESERVED, previous }).issues[0].message;
  assert.equal(message, 'nextKeyNumber must not go back (was 3)');
  config.providers[0].nextKeyNumber = 3;
  assert.deepEqual(issuePaths(config, { previous }), []);
});

test('MP-01 nextKeyNumber must be above the numbers its keys already use', () => {
  const config = baseConfig();
  config.providers[0].nextKeyNumber = 2;
  assert.deepEqual(issuePaths(config), ['providers.0.nextKeyNumber']);
});

test('MP-01 schema errors (unknown fields, maxTokens, public in allowedZones) come back located', () => {
  const config = baseConfig();
  config.extra = true;
  config.providers[1].models[0].maxTokens = 131072;
  config.allowedZones = ['local', 'public'];
  const paths = issuePaths(config);
  assert.ok(paths.includes(''), paths.join());
  assert.ok(paths.includes('providers.1.models.0.maxTokens'), paths.join());
  assert.ok(paths.includes('allowedZones.1'), paths.join());
});

test('MP-01 cross-field allowedZones check rejects public even without the schema', () => {
  const config = { ...baseConfig(), allowedZones: ['local', 'public'] };
  const issues = mc.validateConfig(config, { reserved: RESERVED });
  assert.deepEqual(issues, [{ path: ['allowedZones', 1], message: 'public can only be allowed per project' }]);
});

test('MP-01 id from a name: lowercase, non-alphanumerics to -, trimmed, truncated to 40', () => {
  assert.equal(mc.generateId('DeepSeek', []), 'deepseek');
  assert.equal(mc.generateId('  My GPU box (v2)! ', []), 'my-gpu-box--v2');
  assert.equal(mc.generateId('--Zhipu.GLM--', []), 'zhipu-glm');
  const long = mc.generateId('A'.repeat(50), []);
  assert.equal(long, 'a'.repeat(40));
  assert.match(long, /^[a-z0-9][a-z0-9-]{0,39}$/);
});

test('MP-01 id from a name adds -2, -3 on clashes with existing or reserved ids', () => {
  const taken = mc.takenIds(baseConfig(), RESERVED);
  assert.equal(mc.generateId('GLM', taken), 'glm-2');
  assert.equal(mc.generateId('Cloud', taken), 'cloud-2');
  assert.equal(mc.generateId('DeepSeek', taken), 'deepseek-2');
  assert.equal(mc.generateId('Mori', taken), 'mori-2');
  assert.equal(mc.generateId('glm', [...taken, 'glm-2']), 'glm-3');
});

test('MP-01 id with a suffix still fits in 40 characters', () => {
  const base = 'b'.repeat(40);
  const id = mc.generateId('B'.repeat(45), [base]);
  assert.equal(id, `${'b'.repeat(38)}-2`);
  assert.equal(id.length, 40);
});

test('MP-01 a name without letters or digits gives provider, with -2 on a clash', () => {
  assert.equal(mc.generateId('深度求索', []), 'provider');
  assert.equal(mc.generateId('---', []), 'provider');
  assert.equal(mc.generateId('深度求索', ['provider']), 'provider-2');
  assert.equal(mc.generateId('智谱', ['provider', 'provider-2']), 'provider-3');
});

test('MP-01 new key refs use nextKeyNumber and never reuse a deleted number', () => {
  const config = baseConfig();
  assert.deepEqual(mc.nextKeyRef(config, 'ds'), { ref: 'ds#3', nextKeyNumber: 4 });
  config.providers[0].keys = [{ ref: 'ds#1', label: 'Key 1' }];
  assert.deepEqual(mc.nextKeyRef(config, 'ds'), { ref: 'ds#3', nextKeyNumber: 4 });
  assert.deepEqual(mc.nextKeyRef(config, 'glm'), { ref: 'glm#1', nextKeyNumber: 2 });
});

test('MP-01 new key refs skip a ref another key already uses', () => {
  const config = baseConfig();
  config.providers[2].keys = [{ ref: 'glm#1', label: 'Migrated' }];
  assert.deepEqual(mc.nextKeyRef(config, 'glm'), { ref: 'glm#2', nextKeyNumber: 3 });
  assert.throws(() => mc.nextKeyRef(config, 'nope'), /nope is not in your model settings/);
});

test('MP-05 pick classification: group, provider, model, missing', () => {
  const config = baseConfig();
  assert.equal(mc.resolvePick(config, 'cloud').kind, 'group');
  assert.equal(mc.resolvePick(config, 'glm').kind, 'provider');
  const target = mc.resolvePick(config, 'glm/glm-4.6');
  assert.equal(target.kind, 'model');
  assert.equal(target.modelId, 'glm-4.6');
  assert.equal(mc.resolvePick(config, 'glm/nope').kind, 'missing');
  assert.equal(mc.resolvePick(config, 'nope/glm-4.6').kind, 'missing');
  assert.equal(mc.resolvePick(config, 'nothing').kind, 'missing');
});

test('MP-05 the provider is everything before the first slash', () => {
  const config = baseConfig();
  config.providers[1].models.push(model('org/model-x'));
  assert.deepEqual(mc.splitRef('glm/org/model-x'), { providerId: 'glm', modelId: 'org/model-x' });
  assert.equal(mc.resolvePick(config, 'glm/org/model-x').kind, 'model');
  assert.equal(mc.splitRef('glm'), null);
  assert.equal(mc.modelExists(config, 'glm'), false);
  assert.equal(mc.modelExists(config, 'glm/org/model-x'), true);
});

test('MP-05 group members expand in listed order, provider members to their models in order', () => {
  const config = baseConfig();
  assert.deepEqual(mc.expandPick(config, 'cloud', null), ['ds/chat', 'glm/glm-4.6', 'glm/glm-4.5', 'glm/glm-air']);
  assert.deepEqual(mc.expandPick(config, 'mixed', null), ['local/qwen', 'ds/chat', 'ds/reasoner', 'glm/glm-air']);
});

test('MP-05 a provider pick expands to its models in order; a model pick is itself', () => {
  const config = baseConfig();
  assert.deepEqual(mc.expandPick(config, 'glm', null), ['glm/glm-4.6', 'glm/glm-4.5', 'glm/glm-air']);
  assert.deepEqual(mc.expandPick(config, 'glm/glm-4.5', null), ['glm/glm-4.5']);
  assert.deepEqual(mc.expandPick(config, 'ghost', null), []);
});

test('MP-05 duplicates keep the first occurrence', () => {
  const config = baseConfig();
  config.groups.push({ id: 'dup', members: ['glm/glm-air', 'glm', 'ds/chat', 'ds'] });
  assert.deepEqual(mc.expandPick(config, 'dup', null),
    ['glm/glm-air', 'glm/glm-4.6', 'glm/glm-4.5', 'ds/chat', 'ds/reasoner']);
});

test('MP-05 project narrowing keeps the user group order, provider models in provider order', () => {
  const config = baseConfig();
  const project = { groups: { mixed: ['glm/glm-air', 'ds/reasoner', 'ds/chat'] } };
  assert.deepEqual(mc.expandPick(config, 'mixed', project), ['ds/chat', 'ds/reasoner', 'glm/glm-air']);
  const partial = { groups: { cloud: ['glm/glm-air', 'glm/glm-4.6'] } };
  assert.deepEqual(mc.expandPick(config, 'cloud', partial), ['glm/glm-4.6', 'glm/glm-air']);
  const whole = { groups: { cloud: ['glm'] } };
  assert.deepEqual(mc.expandPick(config, 'cloud', whole), ['glm/glm-4.6', 'glm/glm-4.5', 'glm/glm-air']);
});

test('MP-05 project narrowing only touches the named group and not provider or model picks', () => {
  const config = baseConfig();
  const project = { groups: { cloud: ['ds/chat'] } };
  assert.deepEqual(mc.expandPick(config, 'mixed', project), ['local/qwen', 'ds/chat', 'ds/reasoner', 'glm/glm-air']);
  assert.deepEqual(mc.expandPick(config, 'glm', project), ['glm/glm-4.6', 'glm/glm-4.5', 'glm/glm-air']);
  assert.deepEqual(mc.expandPick(config, 'cloud', project), ['ds/chat']);
});

test('MP-07 project file: absent is fine, the §4.3 shape parses', () => {
  const config = baseConfig();
  assert.deepEqual(mc.parseProjectModels(null, config), { ok: true, file: null });
  const text = JSON.stringify({ allowedZones: ['local'], groups: { cloud: ['glm/glm-4.6'] } });
  assert.deepEqual(mc.parseProjectModels(text, config),
    { ok: true, file: { allowedZones: ['local'], groups: { cloud: ['glm/glm-4.6'] } } });
  assert.equal(mc.parseProjectModels('\uFEFF{}', config).ok, true);
});

test('MP-07 project file rejections give the reason or the validation text', () => {
  const config = baseConfig();
  const cases = [
    ['bad JSON', '{ "allowedZones": [', /JSON/],
    ['unknown field', '{"providers": []}', /providers/],
    ['empty list', '{"groups": {"cloud": []}}', /groups\.cloud: A group needs at least one member/],
    ['missing group', '{"groups": {"nope": ["glm"]}}', /^nope is not in your model settings$/],
    ['item not in the group', '{"groups": {"cloud": ["local"]}}', /^local is not a member of group cloud$/],
    ['model of a provider that is not a member', '{"groups": {"cloud": ["ds/reasoner"]}}',
      /^ds\/reasoner is not a member of group cloud$/],
    ['missing model of a member provider', '{"groups": {"cloud": ["glm/nope"]}}',
      /^glm\/nope is not a member of group cloud$/],
    ['unknown zone', '{"allowedZones": ["moon"]}', /allowedZones/],
  ];
  for (const [name, text, pattern] of cases) {
    const result = mc.parseProjectModels(text, config);
    assert.equal(result.ok, false, name);
    assert.match(result.error, pattern, name);
  }
});

test('MP-07 project file items may be group members or models under a provider member', () => {
  const config = baseConfig();
  const text = JSON.stringify({ groups: { cloud: ['ds/chat', 'glm/glm-4.5'], mixed: ['local', 'ds/reasoner'] } });
  assert.equal(mc.parseProjectModels(text, config).ok, true);
});

test('MP-07 readProjectModels reads .mori/models.json, treats a missing file as none', async () => {
  const config = baseConfig();
  const dir = mkdtempSync(join(tmpdir(), 'mori-project-'));
  assert.deepEqual(await mc.readProjectModels(dir, config), { ok: true, file: null });
  mkdirSync(join(dir, '.mori'));
  writeFileSync(join(dir, '.mori', 'models.json'), '{"allowedZones": ["local"], "extra": 1}');
  const result = await mc.readProjectModels(dir, config);
  assert.equal(result.ok, false);
  assert.match(result.error, /extra/);
  mkdirSync(join(dir, 'sub', '.mori', 'models.json'), { recursive: true });
  const unreadable = await mc.readProjectModels(join(dir, 'sub'), config);
  assert.equal(unreadable.ok, false, 'a folder in place of the file cannot be read');
});

test('MP-06 project paths normalize to all lowercase, / separators and no trailing slash', () => {
  assert.equal(mc.normalizeProjectPath('D:\\work\\tool\\'), 'd:/work/tool');
  assert.equal(mc.normalizeProjectPath('D:\\Work\\Tool'), 'd:/work/tool');
  assert.equal(mc.normalizeProjectPath('d:/work/tool'), 'd:/work/tool');
  assert.equal(mc.normalizeProjectPath('D:/WORK//Tool/./x/..'), 'd:/work/tool');
  assert.equal(mc.normalizeProjectPath('/home/Me/Proj/'), '/home/me/proj');
  assert.equal(mc.normalizeProjectPath('/'), '/');
});

test('MP-06 allowed zones: user zones plus the local grant, narrowed by the project file', () => {
  const config = baseConfig();
  assert.deepEqual(mc.projectAllowedZones(config, 'D:\\work\\tool', null), ['local', 'intranet', 'public']);
  assert.deepEqual(mc.projectAllowedZones(config, 'D:\\WORK\\Tool\\', null), ['local', 'intranet', 'public'],
    'case and separators differ, same project');
  assert.deepEqual(mc.projectAllowedZones(config, 'd:/work/other', null), ['local', 'intranet']);
  assert.deepEqual(mc.projectAllowedZones(config, 'D:/work/tool/', { allowedZones: ['local', 'public'] }),
    ['local', 'public']);
  assert.deepEqual(mc.projectAllowedZones(config, 'd:/work/tool', { allowedZones: [] }), []);
});

test('MP-06 the project file cannot widen the zones', () => {
  const config = baseConfig();
  assert.deepEqual(mc.projectAllowedZones(config, 'd:/elsewhere', { allowedZones: ['local', 'public'] }), ['local']);
  const narrow = { ...config, allowedZones: [] };
  assert.deepEqual(mc.projectAllowedZones(narrow, 'd:/elsewhere', { allowedZones: ['intranet'] }), []);
  assert.deepEqual(mc.projectAllowedZones(config, 'd:/elsewhere', {}), ['local', 'intranet']);
});

test('MP-06 zone of a model is its provider zone, null when unconfirmed or missing', () => {
  const config = baseConfig();
  config.providers[1].zone = null;
  assert.equal(mc.zoneOfRef(config, 'local/qwen'), 'local');
  assert.equal(mc.zoneOfRef(config, 'glm/glm-4.6'), null);
  assert.equal(mc.zoneOfRef(config, 'nope/x'), null);
});

test('MP-08 zone suggestions: every provider gets the shared §12 suggestion for its address', () => {
  assert.deepEqual(mc.zoneSuggestions(baseConfig()), { ds: 'public', glm: 'public', local: 'local' });
});

test('MP-30 deleting a provider removes its keys, its group members and its models from groups', () => {
  const result = mc.deleteProvider(baseConfig(), 'ds');
  assert.deepEqual(result.config.providers.map((p) => p.id), ['glm', 'local']);
  assert.deepEqual(result.config.groups, [{ id: 'cloud', members: ['glm'] }, { id: 'mixed', members: ['local',
    'glm/glm-air'] }]);
  assert.deepEqual(result.removedKeyRefs, ['ds#1', 'ds#2']);
  assert.deepEqual(result.removedRefs, ['ds/chat', 'ds/reasoner']);
  assert.equal(result.config.normalDefault, 'cloud');
  assert.deepEqual(result.consequences, [
    'Its models are deleted: chat, reasoner.',
    'Its saved keys are deleted: Key 1, Key 2.',
    'Removed from group cloud: ds/chat.',
    'Removed from group mixed: ds.',
  ]);
});

test('MP-30 groups left empty are deleted, and normalDefault pointing at them becomes null', () => {
  const config = baseConfig();
  config.groups = [{ id: 'only-glm', members: ['glm', 'glm/glm-4.5'] }, { id: 'cloud', members: ['ds/chat', 'glm'] }];
  config.normalDefault = 'only-glm';
  const result = mc.deleteProvider(config, 'glm');
  assert.deepEqual(result.config.groups, [{ id: 'cloud', members: ['ds/chat'] }]);
  assert.equal(result.config.normalDefault, null);
  assert.deepEqual(result.consequences, [
    'Its models are deleted: glm-4.6, glm-4.5, glm-air.',
    'Group only-glm has no members left and is deleted.',
    'Removed from group cloud: glm.',
    'The default model range (only-glm) is set to None.',
  ]);
  assert.deepEqual(mc.parseModelConfig(result.config, { reserved: RESERVED }).ok, true);
});

test('MP-30 normalDefault pointing at the deleted provider or one of its models becomes null', () => {
  for (const pick of ['glm', 'glm/glm-4.5']) {
    const result = mc.deleteProvider({ ...baseConfig(), normalDefault: pick }, 'glm');
    assert.equal(result.config.normalDefault, null, pick);
    assert.ok(result.consequences.includes(`The default model range (${pick}) is set to None.`), pick);
  }
});

test('MP-30 deleting a model removes it from groups; provider members keep the rest', () => {
  const config = { ...baseConfig(), normalDefault: 'ds/chat' };
  const result = mc.deleteModel(config, 'ds', 'chat');
  assert.deepEqual(result.config.providers[0].models.map((m) => m.id), ['reasoner']);
  assert.deepEqual(result.config.providers[0].keys.length, 2);
  assert.deepEqual(result.config.groups, [{ id: 'cloud', members: ['glm'] }, baseConfig().groups[1]]);
  assert.equal(result.config.normalDefault, null);
  assert.deepEqual(result.removedKeyRefs, []);
  assert.deepEqual(result.removedRefs, ['ds/chat']);
  assert.deepEqual(result.consequences, ['Removed from group cloud: ds/chat.',
    'The default model range (ds/chat) is set to None.']);
});

test('MP-30 deleting a model with no references lists no consequences', () => {
  const result = mc.deleteModel(baseConfig(), 'glm', 'glm-4.5');
  assert.deepEqual(result.consequences, []);
  assert.deepEqual(result.config.groups, baseConfig().groups);
  assert.throws(() => mc.deleteModel(baseConfig(), 'glm', 'nope'), /glm\/nope is not in your model settings/);
});

test('MP-30 deleting the last model deletes the provider and its keys too', () => {
  const config = baseConfig();
  config.providers[2].keys = [{ ref: 'local#1', label: 'Key 1' }];
  config.providers[2].nextKeyNumber = 2;
  config.normalDefault = 'local';
  const result = mc.deleteModel(config, 'local', 'qwen');
  assert.deepEqual(result.config.providers.map((p) => p.id), ['ds', 'glm']);
  assert.deepEqual(result.removedKeyRefs, ['local#1']);
  assert.deepEqual(result.removedRefs, ['local/qwen']);
  assert.deepEqual(result.config.groups[1], { id: 'mixed', members: ['ds', 'glm/glm-air'] });
  assert.equal(result.config.normalDefault, null);
  assert.deepEqual(result.consequences, [
    'This is the last model of LOCAL; the provider and its keys are deleted too.',
    'Removed from group mixed: local.',
    'The default model range (local) is set to None.',
  ]);
});

test('MP-30 deleting a group nulls normalDefault pointing at it and warns about sessions', () => {
  const result = mc.deleteGroup(baseConfig(), 'cloud');
  assert.deepEqual(result.config.groups.map((g) => g.id), ['mixed']);
  assert.equal(result.config.normalDefault, null);
  assert.deepEqual(result.consequences, ['Sessions using this group will need a new model range.',
    'The default model range (cloud) is set to None.']);
  const other = mc.deleteGroup(baseConfig(), 'mixed');
  assert.equal(other.config.normalDefault, 'cloud');
  assert.deepEqual(other.consequences, ['Sessions using this group will need a new model range.']);
  assert.throws(() => mc.deleteGroup(baseConfig(), 'nope'), /nope is not in your model settings/);
});

test('MP-30 an open session whose pick was deleted resolves to missing', () => {
  const after = mc.deleteProvider(baseConfig(), 'glm').config;
  assert.equal(mc.resolvePick(after, 'glm').kind, 'missing');
  assert.equal(mc.resolvePick(after, 'glm/glm-4.6').kind, 'missing');
  assert.equal(mc.resolvePick(mc.deleteGroup(baseConfig(), 'cloud').config, 'cloud').kind, 'missing');
});

test('MP-01 changing the base URL origin removes the keys; nextKeyNumber stays', () => {
  const ds = baseConfig().providers[0];
  const changed = mc.applyAddressChange(ds, 'https://other.example.com/v1');
  assert.equal(changed.originChanged, true);
  assert.deepEqual(changed.provider.keys, []);
  assert.equal(changed.provider.nextKeyNumber, 3);
  assert.equal(changed.provider.baseUrl, 'https://other.example.com/v1');
  assert.deepEqual(changed.removedKeyRefs, ['ds#1', 'ds#2']);
  assert.equal(changed.consequence,
    'Changing the base URL removes this provider’s 2 saved keys. Add them again after saving.');
  const one = mc.applyAddressChange({ ...ds, keys: [ds.keys[0]] }, 'http://ds.example.com/v1');
  assert.equal(one.consequence,
    'Changing the base URL removes this provider’s saved key. Add it again after saving.');
});

test('MP-01 port or protocol changes count as an origin change; a path change does not', () => {
  const ds = baseConfig().providers[0];
  assert.equal(mc.applyAddressChange(ds, 'https://ds.example.com:8443/v1').originChanged, true);
  assert.equal(mc.applyAddressChange(ds, 'http://ds.example.com/v1').originChanged, true);
  const same = mc.applyAddressChange(ds, 'https://DS.example.com/api/v2');
  assert.equal(same.originChanged, false);
  assert.equal(same.provider.keys.length, 2);
  assert.equal(same.consequence, null);
  assert.deepEqual(same.removedKeyRefs, []);
  const keyless = mc.applyAddressChange({ ...ds, keys: [] }, 'https://x.example.com');
  assert.equal(keyless.originChanged, true);
  assert.equal(keyless.consequence, null);
});

test('MP-23 a new session takes normalDefault, recorded when not null', () => {
  const config = baseConfig();
  assert.deepEqual(mc.resolveSessionPick({ config, isNew: true, recordedPick: null, lastAssistantRef: null }),
    { pick: 'cloud', record: true });
  assert.deepEqual(mc.resolveSessionPick({ config: { ...config, normalDefault: null }, isNew: true,
    recordedPick: null, lastAssistantRef: null }), { pick: null, record: false });
});

test('MP-23 an opened session keeps its last mori.pick even after the default changed', () => {
  const config = { ...baseConfig(), normalDefault: 'glm' };
  assert.deepEqual(mc.resolveSessionPick({ config, isNew: false, recordedPick: 'mixed',
    lastAssistantRef: 'glm/glm-4.6' }), { pick: 'mixed', record: false });
});

test('MP-23 a v0 session uses its last assistant model when it is in the config, else normalDefault', () => {
  const config = baseConfig();
  assert.deepEqual(mc.resolveSessionPick({ config, isNew: false, recordedPick: null,
    lastAssistantRef: 'glm/glm-4.5' }), { pick: 'glm/glm-4.5', record: true });
  assert.deepEqual(mc.resolveSessionPick({ config, isNew: false, recordedPick: null,
    lastAssistantRef: 'mori-endpoint/old' }), { pick: 'cloud', record: true });
  assert.deepEqual(mc.resolveSessionPick({ config: { ...config, normalDefault: null }, isNew: false,
    recordedPick: null, lastAssistantRef: null }), { pick: null, record: false });
});

test('MP-23 the last assistant message gives the provider/model ref', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', provider: 'glm', model: 'glm-4.6' },
    { role: 'toolResult' },
    { role: 'assistant', provider: 'ds', model: 'chat' },
    { role: 'user', content: 'again' },
  ];
  assert.equal(mc.lastAssistantRef(messages), 'ds/chat');
  assert.equal(mc.lastAssistantRef([{ role: 'user' }]), null);
});

test('MP-01 an unreadable config is reported with its path and is not overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mori-config-'));
  const path = join(dir, 'model-config.json');
  assert.deepEqual(await mc.readModelConfig(path, RESERVED), { kind: 'missing' });
  writeFileSync(path, '{ not json');
  const broken = await mc.readModelConfig(path, RESERVED);
  assert.equal(broken.kind, 'invalid');
  assert.ok(broken.error.startsWith(`${path}: `), broken.error);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
  const config = baseConfig();
  config.groups.push({ id: 'glm', members: ['ds'] });
  writeFileSync(path, JSON.stringify(config));
  const invalid = await mc.readModelConfig(path, RESERVED);
  assert.equal(invalid.kind, 'invalid');
  assert.match(invalid.error, /groups\.2\.id: glm is already used by a provider or group/);
});

test('MP-01 saving validates first and writes atomically without leaving temp files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mori-config-'));
  const path = join(dir, 'nested', 'model-config.json');
  await mc.saveModelConfig(path, baseConfig(), { reserved: RESERVED });
  assert.deepEqual(await mc.readModelConfig(path, RESERVED), { kind: 'ok', config: baseConfig() });
  const backwards = baseConfig();
  backwards.providers[0].keys = [];
  backwards.providers[0].nextKeyNumber = 1;
  await assert.rejects(mc.saveModelConfig(path, backwards, { reserved: RESERVED, previous: baseConfig() }),
    /providers\.0\.nextKeyNumber: nextKeyNumber must not go back/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), baseConfig());
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['model-config.json']);
});

test('MP-01 a model-config.json held open by another reader for a moment is still replaced (the rename is retried)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mori-config-'));
    const path = join(dir, 'model-config.json');
    await mc.saveModelConfig(path, baseConfig(), { reserved: RESERVED });
    // Windows 上目标文件开着时改名替换失败（EPERM）；别的程序 100 毫秒后关掉它，写出照样完成。
    const fd = openSync(path, 'r');
    setTimeout(() => closeSync(fd), 100);
    const moved = baseConfig();
    moved.providers[0].keys.reverse();
    await mc.saveModelConfig(path, moved, { reserved: RESERVED, previous: baseConfig() });
    assert.deepEqual(await mc.readModelConfig(path, RESERVED), { kind: 'ok', config: moved });
    assert.deepEqual(readdirSync(dir), ['model-config.json'], 'no temporary file is left behind');
  });
