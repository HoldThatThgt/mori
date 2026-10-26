// MD-17 的单元层（docs/specs/model-discovery.md §8，2026-10-26 负责人走查回答 1，WP-15；docs/v1/screens/models-settings.md
// “Models 行”“模型行的提示”）：模型行数字后面的“(from pi)”与“(default)”、§8 表的八行提示（renderer 的
// settings/modelHints.ts，ModelRows.tsx 用）。档案对象是手写的（synthetic），只有 valueMarks、modelHints 读的几项：
// reported、catalog、reasoning.field。界面上的样子由回放（md-replay.mjs 的 md-glm-pi-card）与真实层（md-real.mjs glm-pi）查。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const { modelHints, piRowTitle, valueMarks } = await loadKernelModule(
  'src/renderer/src/components/settings/modelHints.ts');

/** 服务什么都没报告的第 0 步 */
const NOTHING = Object.freeze({ contextWindow: null, maxTokens: null, reasoning: null, image: null });
/** 取自 pi 的三项（同 pi 的 Z.AI 条目给 glm-5.3 的值） */
const PI = Object.freeze({ provider: 'Z.AI', contextWindow: 1000000, maxTokens: 131072, reasoning: true });

/** @brief 档案（synthetic）：reported、catalog 与推理字段。 */
const profile = (reported, catalog, field = 'native') => ({ reported, catalog, reasoning: { field } });
/** @brief 配置里的模型（synthetic）。 */
const model = (fields = {}) => ({ id: 'glm-5.3', family: '', contextWindow: 128000, maxTokens: 16384, reasoning: false,
  input: ['text'], ...fields });
/** @brief 加入时取了 pi 的值的模型。 */
const fromPi = (fields = {}) => model({ contextWindow: 1000000, maxTokens: 131072, reasoning: true, ...fields });

test('MD-17 §8 the model row writes "(from pi)" after each value equal to the profile\'s catalog value (window, max '
  + 'output, Supports thinking) and the hover names pi\'s provider', () => {
  assert.deepEqual(valueMarks(fromPi(), profile(NOTHING, PI)),
    { contextWindow: 'pi', maxTokens: 'pi', reasoning: true });
  assert.equal(piRowTitle('Z.AI'),
    'The server didn’t report this, so Mori used pi’s model list for Z.AI. Use Edit to set the real value.');
});

test('MD-17 §8 a value changed with Edit loses "(from pi)"; a value still Mori\'s default reads "(default)"; a value '
  + 'equal to both reads only "(from pi)"', () => {
  assert.deepEqual(valueMarks(fromPi({ contextWindow: 1048576, reasoning: false }), profile(NOTHING, PI)),
    { contextWindow: null, maxTokens: 'pi', reasoning: false });
  assert.deepEqual(valueMarks(model(), profile(NOTHING, PI)),
    { contextWindow: 'default', maxTokens: 'default', reasoning: false });
  const atDefault = { ...PI, contextWindow: 128000, maxTokens: null };
  assert.deepEqual(valueMarks(model(), profile(NOTHING, atDefault)),
    { contextWindow: 'pi', maxTokens: 'default', reasoning: false });
});

test('MD-17 §8 without a catalog the marks are as before: "(default)" only for unreported defaults, none for an old '
  + 'profile', () => {
  assert.deepEqual(valueMarks(model(), profile(NOTHING, null)),
    { contextWindow: 'default', maxTokens: 'default', reasoning: false });
  assert.deepEqual(valueMarks(model(), profile(null, null)),
    { contextWindow: null, maxTokens: null, reasoning: false });
  assert.deepEqual(valueMarks(model(), null), { contextWindow: null, maxTokens: null, reasoning: false });
});

test('MD-17 §8 the three hints from pi show while the configured values are still Mori\'s defaults, in the table\'s '
  + 'order, each with what Use saves', () => {
  const hints = modelHints('anthropic-messages', model(), profile(NOTHING, PI));
  assert.deepEqual(hints.map((hint) => [hint.kind, hint.text]), [
    ['pi-context', 'pi’s model list for Z.AI has a context window of 1,000,000.'],
    ['pi-reasoning', 'pi’s model list for Z.AI says this model supports thinking.'],
  ]);
  assert.deepEqual(hints[0].model, model({ contextWindow: 1000000 }));
  assert.deepEqual(hints[1].model, model({ reasoning: true }));
  // 窗口用了 pi 的值以后，仍是默认值的 Max output 小于新窗口：提示 pi 的输出上限
  const wider = modelHints('anthropic-messages', model({ contextWindow: 1000000 }), profile(NOTHING, PI));
  assert.deepEqual(wider.map((hint) => [hint.kind, hint.text]), [
    ['pi-max-output', 'pi’s model list for Z.AI has max output of 131,072.'],
    ['pi-reasoning', 'pi’s model list for Z.AI says this model supports thinking.'],
  ]);
  assert.deepEqual(wider[0].model, model({ contextWindow: 1000000, maxTokens: 131072 }));
});

test('MD-17 §8 values you set are never pushed back to pi\'s: no hint from pi once the window or max output is not '
  + 'the default, and none when the config already has pi\'s values', () => {
  assert.deepEqual(modelHints('anthropic-messages', model({ contextWindow: 1048576, maxTokens: 131072,
    reasoning: true }), profile(NOTHING, PI)), []);
  assert.deepEqual(modelHints('anthropic-messages', fromPi(), profile(NOTHING, PI)), []);
  // 窗口改小到 pi 的输出上限以下：pi 的输出上限不小于配置的窗口，不提示
  assert.deepEqual(modelHints('anthropic-messages', model({ contextWindow: 65536, maxTokens: 16384, reasoning: true }),
    profile(NOTHING, PI)), []);
});

test('MD-17 §8 "This model returned thinking content." does not show next to pi\'s thinking hint (one hint for one '
  + 'thing); it still shows without a catalog', () => {
  const seen = (catalog) => modelHints('openai-completions', model(), profile(NOTHING, catalog, 'reasoning_content'))
    .map((hint) => hint.kind);
  assert.deepEqual(seen({ ...PI, contextWindow: null, maxTokens: null }), ['pi-reasoning']);
  assert.deepEqual(seen(null), ['thinking-seen']);
});
