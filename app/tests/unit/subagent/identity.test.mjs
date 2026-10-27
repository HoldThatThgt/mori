// 身份段里交出去的活那一句（docs/specs/subagent.md §6.4；记忆规格 §4.1 第 1 条、附录 A.1.1）的单元测试：按这次运行启用的
// 工具拼，task_create 与 agent_message 时与原来的 HANDOFF_TEXT 逐字相同；默认工具下身份段 ≤ 2000 token（2026-10-27 文件系统
// 合并后记忆规格 §4 的上限，原为 500），普通模式（默认工具加 subagent）的实际 token 数打印出来写进检查记录。工具清单照 pi 的
// 实际形状（text-helpers.mjs）。身份段按 Ask each time（renderIdentity 的 'ask'），那一句接在最后一行末尾。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOOLS, loadTextKernel, registeredPrompt, specBlock } from '../memory/text-helpers.mjs';
import { loadKernelModule } from '../load.mjs';

const K = await loadTextKernel();
const S = await loadKernelModule('src/kernel/subagent.ts');
const A1 = specBlock('### A.1');
const CWD = 'D:\\shop';
/** subagent 工具的定义（§6.1）：<tools> 里的一行；没有准则 */
const SUBAGENT = S.subagentTool({ roles: [] });

/** @brief 一种输入：pi 的实际形状，这次启用 selectedTools。 */
function inputOf(selectedTools) {
  return { selectedTools, hiddenTools: [], promptGuidelines: [], ...registeredPrompt(CWD, [SUBAGENT]) };
}

/** @brief 身份段最后一行（The sections after …）末尾的那一句；没有时为 null。 */
function handoffOf(tools) {
  const head = K.text.renderIdentity(inputOf(tools), 'ask').split('\n\n<tools>\n')[0];
  return head === A1 ? null : head.slice(A1.length + 1);
}

const AGENTS = "are worked on by agents that don't see <facts>: write the facts they need into";

test('SA-10 the sentence lists only the handoff tools of this run, in §6.4 order', () => {
  assert.equal(handoffOf([...DEFAULT_TOOLS, 'subagent']), `Prompts you give subagents ${AGENTS} the prompt.`);
  assert.equal(handoffOf([...DEFAULT_TOOLS, 'agent_message', 'subagent']),
    `Questions you send to other agents and prompts you give subagents ${AGENTS} the question or the prompt.`);
  assert.equal(handoffOf(['read', 'task_create', 'agent_message']),
    `Tasks you create and questions you send to other agents ${AGENTS} the task description or the question.`);
  assert.equal(handoffOf(['read', 'task_create', 'agent_message']), K.text.HANDOFF_TEXT,
    'Task mode keeps the WP-11 text word for word');
  assert.equal(handoffOf(['read', 'task_create']), `Tasks you create ${AGENTS} the task description.`);
  assert.equal(handoffOf(['read', 'agent_message']), `Questions you send to other agents ${AGENTS} the question.`);
  assert.equal(handoffOf(['read', 'task_create', 'agent_message', 'subagent']), 'Tasks you create, questions you '
    + `send to other agents and prompts you give subagents ${AGENTS} the task description, the question or the `
    + 'prompt.');
  assert.equal(handoffOf(DEFAULT_TOOLS), null, 'none of them: no sentence');
});

test('SA-10 normal mode (default tools with subagent on) keeps the identity section within 2000 tokens; the '
  + 'guidance is in the tool description, not a guideline', () => {
  const plain = K.shared.estimateMemoryTokens(K.text.renderIdentity(inputOf(DEFAULT_TOOLS), 'ask'));
  const normal = K.shared.estimateMemoryTokens(K.text.renderIdentity(inputOf([...DEFAULT_TOOLS, 'subagent']), 'ask'));
  console.log(`[sa-unit] identity tokens: default ${plain}, normal mode ${normal}`);
  assert.ok(plain <= 2000, `default tools: ${plain} tokens`);
  assert.ok(normal <= 2000, `normal mode with subagent: ${normal} tokens`);
  assert.ok(normal > plain, 'the normal-mode identity lists subagent');
  assert.equal(SUBAGENT.promptGuidelines, undefined, 'no guideline in <rules>');
  for (const words of ['when the user asks for subagents or parallel agents', 'to split work into independent parts',
    'write each prompt so it stands alone']) {
    assert.ok(SUBAGENT.description.includes(words), `the description carries "${words}"`);
  }
});
