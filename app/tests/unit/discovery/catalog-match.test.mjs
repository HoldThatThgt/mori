// MD-16（docs/specs/model-discovery.md §4.4，2026-10-26 负责人走查回答 1，WP-15）：按服务地址查 pi 自带的模型表。
// catalogEntry（kernel/piCatalog.ts）读的是安装的 pi-ai 1.3.0 的真实模型表（版本锁定，见 app/package.json），所以这里的
// 数字就是 pi 的条目：Z.AI 的 glm-5.3 为 1,000,000 / 131,072、支持思考；OpenRouter 的 z-ai/glm-5.3 为 1,048,576 /
// 943,718；Amazon Bedrock 的 us.zai.glm-5.3 为 1,000,000 / 128,000；Cloudflare Workers AI 的 @cf/zai-org/glm-5.3 为
// 1,048,576 / 1,048,576；opencode.ai 下 OpenCode Zen 与 OpenCode Go 的 glm-5.3 相同、minimax-m3 不同。
// 地址里的主机名 *.example.test 是保留的测试域名，不发请求（catalogEntry 不发请求）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const { catalogEntry } = await loadKernelModule('src/kernel/piCatalog.ts');

/** 负责人的 z.ai 提供商的地址（Anthropic 接口） */
const ZAI = 'https://api.z.ai/api/anthropic';
/** pi 的 Z.AI 条目给 glm-5.3 的值 */
const ZAI_GLM = { provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true };

test('MD-16 §4.4 z.ai\'s Anthropic address takes pi\'s Z.AI entry for glm-5.3 and glm-5.3-flash: same origin, the '
  + 'path and API type are not compared', () => {
  assert.deepEqual(catalogEntry(ZAI, 'glm-5.3'), ZAI_GLM);
  assert.deepEqual(catalogEntry('https://api.z.ai/api/coding/paas/v4', 'glm-5.3'), ZAI_GLM);
  assert.deepEqual(catalogEntry('https://api.z.ai', 'glm-5.3'), ZAI_GLM);
  assert.deepEqual(catalogEntry(ZAI, 'glm-5.3-flash'),
    { provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true });
});

test('MD-16 §4.4 an id pi has no entry for at that origin is not matched (glm-4.5, glm-5.3-flashx on z.ai)', () => {
  assert.equal(catalogEntry(ZAI, 'glm-4.5'), null);
  assert.equal(catalogEntry(ZAI, 'glm-5.3-flashx'), null);
});

test('MD-16 §4.4 another scheme or port is another origin, and ids are compared case-sensitively (GLM-5.3)', () => {
  assert.equal(catalogEntry('http://api.z.ai/api/anthropic', 'glm-5.3'), null);
  assert.equal(catalogEntry('https://api.z.ai:8443/api/anthropic', 'glm-5.3'), null);
  assert.equal(catalogEntry(ZAI, 'GLM-5.3'), null);
});

test('MD-16 §4.4 a host pi does not know takes nothing even with an id pi has elsewhere (self-hosted server, company '
  + 'gateway)', () => {
  for (const base of ['http://10.0.0.5:8000/v1', 'http://127.0.0.1:4862/v1', 'https://llm.example.test/v1']) {
    assert.equal(catalogEntry(base, 'glm-5.3'), null, base);
  }
});

test('MD-16 §4.4 an OpenRouter-style aggregator never takes Z.AI\'s entry: openrouter.ai has no bare glm-5.3, its '
  + 'z-ai/glm-5.3 is OpenRouter\'s own entry, and an aggregator pi does not know takes nothing', () => {
  assert.equal(catalogEntry('https://openrouter.ai/api/v1', 'glm-5.3'), null);
  const routed = catalogEntry('https://openrouter.ai/api/v1', 'z-ai/glm-5.3');
  assert.deepEqual(routed, { provider: 'OpenRouter', contextWindow: 1048576, maxTokens: 943718, reasoning: true });
  assert.notDeepEqual({ ...routed, provider: 'Z.AI' }, ZAI_GLM);
  assert.equal(catalogEntry('https://oneapi.example.test/v1', 'z-ai/glm-5.3'), null);
  assert.equal(catalogEntry('https://oneapi.example.test/v1', 'glm-5.3'), null);
});

test('MD-16 §4.4 the same model on Bedrock and Cloudflare addresses takes those services\' own entries, never '
  + 'Z.AI\'s; the bare id is not matched there', () => {
  const bedrock = 'https://bedrock-runtime.us-east-1.amazonaws.com';
  assert.deepEqual(catalogEntry(bedrock, 'us.zai.glm-5.3'),
    { provider: 'Amazon Bedrock', contextWindow: 1000000, maxTokens: 128000, reasoning: true });
  assert.equal(catalogEntry(bedrock, 'glm-5.3'), null);
  const cloudflare = 'https://api.cloudflare.com/client/v4/accounts/0123/ai/v1';
  assert.deepEqual(catalogEntry(cloudflare, '@cf/zai-org/glm-5.3'),
    { provider: 'Cloudflare Workers AI', contextWindow: 1048576, maxTokens: 1048576, reasoning: true });
  assert.equal(catalogEntry(cloudflare, 'glm-5.3'), null);
});

test('MD-16 §4.4 several pi entries for one id at one origin: taken when they agree (the first provider pi lists), '
  + 'none when they differ', () => {
  assert.deepEqual(catalogEntry('https://opencode.ai/zen/v1', 'glm-5.3'),
    { provider: 'OpenCode Zen', contextWindow: 1000000, maxTokens: 131072, reasoning: true });
  assert.equal(catalogEntry('https://opencode.ai/zen/v1', 'minimax-m3'), null);
});

test('MD-16 §4.4 an address that is not an http(s) URL matches nothing', () => {
  assert.equal(catalogEntry('', 'glm-5.3'), null);
  assert.equal(catalogEntry('ftp://api.z.ai/', 'glm-5.3'), null);
  assert.equal(catalogEntry('api.z.ai', 'glm-5.3'), null);
});
