// shared/roles.ts 的界面文字（docs/specs/customize-agents.md §6.2、§6.3、§7；状态表 docs/v1/screens/customize-agents.md）：
// 职责、模型的一句话、展开里 Models 的标题、Model needs 的白话与 handoff tier 的说明、Tools、Other settings。
// 纯函数，候选与原因是测试给出的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';

const roles = await loadKernelModule('src/shared/roles.ts');

const ready = (ref) => ({ ref, reason: null });
const blocked = (ref, reason) => ({ ref, reason });
/** @brief 一行的模型一句话：没写 models 的 agent，会话的范围是 strong。 */
const line = (candidates, models = null, pick = 'strong') => roles.modelLine({ candidates, models }, pick);

test('AG-02 the model line: every candidate ready names the first model id and how many more', () => {
  assert.deepEqual(line([ready('deepseek/deepseek-chat')]), { state: 'ready', text: 'Models: deepseek-chat' });
  assert.deepEqual(line([ready('deepseek/deepseek-chat'), ready('glm/glm-4.6'), ready('glm/glm-4.5')]),
    { state: 'ready', text: 'Models: deepseek-chat and 2 more' });
});

test('AG-02 the model line: some candidates blocked counts them, all blocked says no model can run it', () => {
  const some = [ready('a/x'), blocked('b/y', 'tool calling not verified yet'), blocked('b/z', 'verifying…')];
  assert.deepEqual(line(some), { state: 'some', text: '2 of 3 models can’t run' });
  const none = [blocked('a/x', 'handoff tier C is below B'), blocked('b/y', 'not in your model settings')];
  assert.deepEqual(line(none), { state: 'none', text: 'No model can run this agent' });
});

test('AG-02 the model line: "No model range picked" only without models and without a session range', () => {
  assert.deepEqual(line([], null, null), { state: 'empty', text: 'No model range picked' });
});

test('AG-02 the model line: a range that names no model is "No model can run this agent", not "No model range picked"',
  () => {
    assert.deepEqual(line([], null, 'gone'), { state: 'none', text: 'No model can run this agent' });
    assert.deepEqual(line([], ['empty-group'], null), { state: 'none', text: 'No model can run this agent' });
    assert.deepEqual(line([], ['empty-group'], 'strong'), { state: 'none', text: 'No model can run this agent' });
  });

test('AG-04 Add model range: Groups, Providers, then one Models · <provider name> per provider; empty ones left out',
  () => {
    const ranges = [{ pick: 'strong', kind: 'group', label: 'strong' },
      { pick: 'ds', kind: 'provider', label: 'DeepSeek' }, { pick: 'zg', kind: 'provider', label: 'GLM' },
      { pick: 'ds/glm-4.6', kind: 'model', label: 'glm-4.6' }, { pick: 'ds/deepseek-chat', kind: 'model',
        label: 'deepseek-chat' }, { pick: 'zg/glm-4.6', kind: 'model', label: 'glm-4.6' }];
    const shape = (groups) => groups.map((group) => [group.label, group.ranges.map((range) => range.pick)]);
    assert.deepEqual(shape(roles.rangeGroups(ranges)), [['Groups', ['strong']], ['Providers', ['ds', 'zg']],
      ['Models · DeepSeek', ['ds/glm-4.6', 'ds/deepseek-chat']], ['Models · GLM', ['zg/glm-4.6']]]);
    assert.deepEqual(shape(roles.rangeGroups(ranges.slice(1))), [['Providers', ['ds', 'zg']],
      ['Models · DeepSeek', ['ds/glm-4.6', 'ds/deepseek-chat']], ['Models · GLM', ['zg/glm-4.6']]]);
    const orphan = [{ pick: 'gone/x', kind: 'model', label: 'x' }];
    assert.deepEqual(shape(roles.rangeGroups(orphan)), [['Models · gone', ['gone/x']]]);
    assert.deepEqual(roles.rangeGroups([]), []);
  });

test('AG-06 ticking a tool keeps entries the form has no box for (mcp__github__*), after the boxes in their order',
  () => {
    const options = ['read', 'bash', 'grep', roles.ALL_MCP_TOOLS];
    assert.equal(roles.ALL_MCP_TOOLS, 'mcp__*');
    assert.deepEqual(roles.toolsToggled(['read', 'mcp__github__*'], options, 'grep', true),
      ['read', 'grep', 'mcp__github__*']);
    assert.deepEqual(roles.toolsToggled(['mcp__fs__read_file', 'grep', 'read'], options, 'read', false),
      ['grep', 'mcp__fs__read_file']);
    assert.deepEqual(roles.toolsToggled(['grep'], options, roles.ALL_MCP_TOOLS, true), ['grep', 'mcp__*']);
    assert.deepEqual(roles.toolsToggled([], options, 'bash', true), ['bash']);
  });

test('AG-09 jobs are written with Claude-style words, joined by " · ", in seat order', () => {
  assert.equal(roles.seatsText(['dialog', 'create', 'close']), 'Talks to you · Plans requests · Closes requests');
  assert.equal(roles.seatsText(['close', 'create']), 'Plans requests · Closes requests');
  assert.equal(roles.seatsText([]), '');
});

test('AG-09 the Models heading: the session’s range, no range, or the agent’s own list', () => {
  assert.equal(roles.modelsHeading(null, 'strong'), 'Same as the session’s model range (strong)');
  assert.equal(roles.modelsHeading(null, null), 'The session has no model range.');
  assert.equal(roles.modelsHeading(['fast', 'glm/glm-4.6'], 'strong'), 'Tries these in order:');
});

test('AG-09 model needs in plain English, and the handoff tier note only for protocol_write needs', () => {
  assert.equal(roles.needText('protocol_write'), 'Fills in handoff forms (verified)');
  assert.equal(roles.needText('protocol_write>=B'), 'Handoff tier B or better');
  assert.equal(roles.needText('structured_output'), 'Structured output (verified)');
  assert.equal(roles.needText('vision'), 'Image input');
  assert.equal(roles.needText('context>=65536'), 'Context window of at least 65536 tokens');
  assert.equal(roles.hasTierNeed(['vision', 'protocol_write>=B']), true);
  assert.equal(roles.hasTierNeed(['protocol_write']), true);
  assert.equal(roles.hasTierNeed(['vision', 'context>=1000']), false);
  assert.equal(roles.HANDOFF_TIER_NOTE, 'Handoff tier is how a model fills in the form it hands back at the end of '
    + 'a task: A, B, or C (weakest). Mori finds it when it checks the model.');
});

test('AG-09 tools: written ones joined, mcp__* as all MCP tools; unwritten ones are Mori’s defaults', () => {
  assert.equal(roles.toolsText(['read', 'grep', 'bash'], ['read', 'bash', 'edit', 'write']), 'read, grep, bash');
  assert.equal(roles.toolsText(['read', 'mcp__*'], []), 'read, all MCP tools');
  assert.equal(roles.toolsText(null, ['read', 'bash', 'edit', 'write']),
    'Same as Mori: read, bash, edit, write, and all MCP tools');
  assert.equal(roles.toolsText(null, ['read', 'bash', 'edit', 'write', 'ls']),
    'Same as Mori: read, bash, edit, write, ls, and all MCP tools');
});

test('AG-09 other settings: differ_from and each subscription with its filters', () => {
  assert.deepEqual(roles.otherSettings({ differFromAuthor: false, subscribe: [] }), []);
  assert.deepEqual(roles.otherSettings({ differFromAuthor: true, subscribe: [
    { moment: 'request_closed', ruledOut: null, outcome: null },
    { moment: 'request_closed', ruledOut: true, outcome: ['done', 'failed'] },
    { moment: 'request_closed', ruledOut: false, outcome: null },
  ] }), [
    'Avoids the model family that changed the code',
    'Woken when a request closes',
    'Woken when a request closes (has ruled-out approaches, outcome: done, failed)',
    'Woken when a request closes (no ruled-out approaches)',
  ]);
});
