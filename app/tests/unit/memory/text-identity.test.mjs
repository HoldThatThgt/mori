// 身份与 harness 段的单元测试（docs/specs/memory.md §4、MEM-01）：memoryText.ts 渲染的 <tools>、<rules> 与 pi 1.3.0 的
// buildSystemPromptSections（按文件路径从 node_modules 载入）在同一组输入下逐字相同；输入照 pi 的实际形状：toolSnippets、
// toolGuidelines 含全部注册的内置工具（真实的 pi 工具定义），扩展工具的准则在 toolGuidelines.<名字> 里。
// 身份段在默认工具下 ≤ 500 token（§6.3 的估算）。mori-memory 的 before_agent_start 把它写成 customPrompt，覆盖 pi 读进来的
// SYSTEM.md（§4.3），所有种类的会话都这样（用户会话、立项、结案、task、临时提问、订阅、增强会话）。
// 扩展工具、SYSTEM.md 的内容都是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import {
  BUILTIN_TOOLS, DEFAULT_TOOLS, agentStart, fakePi, freshUserData, loadTextKernel, piPrompt, registeredPrompt,
  specBlock,
} from './text-helpers.mjs';

const K = await loadTextKernel();
const A1 = specBlock('### A.1');
const A11 = specBlock('### A.1.1');
const CWD = 'D:\\shop';

/** synthetic：一个带 promptSnippet 与 promptGuidelines 的扩展工具 */
const DEPLOY = { name: 'deploy_check', promptSnippet: 'Check a deployment\n(synthetic)',
  promptGuidelines: ['Run deploy_check before saying a deploy is done (synthetic).', '  '] };
/** synthetic：注册了、但这次没有声明的扩展工具 */
const IDLE = { name: 'idle_tool', promptSnippet: 'An idle tool (synthetic)',
  promptGuidelines: ['IDLE-GUIDELINE (synthetic)'] };

/**
 * @brief 一种输入：pi 的实际形状（全部注册的工具的说明与准则），声明的工具与隐藏的工具由用例给出。
 * @param selectedTools 这次启用的工具
 * @param hiddenTools 启用但不列出的工具
 * @param promptGuidelines 顶层准则
 */
function inputOf(selectedTools, hiddenTools = [], promptGuidelines = []) {
  return { selectedTools, hiddenTools, promptGuidelines, ...registeredPrompt(CWD, [DEPLOY, IDLE]) };
}

/** @brief Mori 的 <tools>、<rules> 与 pi 的逐字相同；身份段 = A.1 + pi 的两段；有 customPrompt 时 pi 只有 preamble 与 cwd。 */
function assertSameAsPi(input) {
  const pi = piPrompt.buildSystemPromptSections({ cwd: CWD, ...input });
  assert.equal(`<tools>\n${K.text.renderToolsSection(input)}\n</tools>`, pi.tools, 'the <tools> section');
  assert.equal(`<rules>\n${K.text.renderRulesSection(input)}\n</rules>`, pi.rules, 'the <rules> section');
  const identity = K.text.renderIdentity(input);
  assert.equal(identity, `${A1}\n\n${pi.tools}\n\n${pi.rules}`);
  const mine = piPrompt.buildSystemPromptSections({ cwd: CWD, ...input, customPrompt: identity });
  assert.deepEqual(Object.keys(mine), ['preamble', 'cwd'], 'no tools, rules or docs sections from pi');
  assert.equal(mine.preamble, identity);
  assert.doesNotMatch(identity, /operating inside pi|Pi documentation/, "no pi identity sentence or docs");
  return { pi, identity };
}

test('MEM-01 IDENTITY_TEXT is appendix A.1 word for word', () => {
  assert.equal(K.text.IDENTITY_TEXT, A1);
});

test('MEM-01 the handoff sentence (appendix A.1.1) ends the third line only when task_create, agent_message or '
  + 'subagent is among this run\'s tools', () => {
  assert.equal(K.text.HANDOFF_TEXT, A11);
  assert.ok(!A1.includes(A11) && !A1.includes('agent_message'), 'A.1 itself no longer has the sentence');
  const rest = "are worked on by agents that don't see <facts>: write the facts they need into";
  // 按有的工具拼（附录 A.1.1 的表）：一个工具时只有它那一部分；task_create 与 agent_message 时是 A.1.1 的原文
  const one = { task_create: `Tasks you create ${rest} the task description.`,
    agent_message: `Questions you send to other agents ${rest} the question.`,
    subagent: `Prompts you give subagents ${rest} the prompt.` };
  for (const [name, sentence] of Object.entries(one)) {
    const identity = K.text.renderIdentity(inputOf([...DEFAULT_TOOLS, name]));
    assert.ok(identity.startsWith(`${A1} ${sentence}\n\n<tools>\n`), `${name}: A.1, a space, its part, then <tools>`);
  }
  assert.ok(K.text.renderIdentity(inputOf(['read', 'task_create', 'agent_message'])).startsWith(`${A1} ${A11}\n`),
    'task_create and agent_message: the A.1.1 sentence word for word');
  for (const tools of [DEFAULT_TOOLS, ['read', 'board_read', 'read_session'], ['read', 'request_close']]) {
    const identity = K.text.renderIdentity(inputOf(tools));
    assert.ok(identity.startsWith(`${A1}\n\n<tools>\n`) && !identity.includes(A11), `${tools.join('+')}: no sentence`);
  }
});

test('MEM-01 default tools: <tools> and <rules> equal pi; grep, find, ls and powershell do not appear', () => {
  const input = inputOf(DEFAULT_TOOLS);
  assert.deepEqual(Object.keys(input.toolSnippets).filter((name) => BUILTIN_TOOLS.includes(name)).sort(),
    [...BUILTIN_TOOLS].sort(), 'the input has every registered built-in tool, declared or not');
  const { pi } = assertSameAsPi(input);
  for (const name of DEFAULT_TOOLS) assert.match(pi.tools, new RegExp(`^- ${name}: `, 'm'));
  for (const name of ['grep', 'find', 'ls', 'powershell', 'deploy_check', 'idle_tool']) {
    assert.doesNotMatch(pi.tools, new RegExp(`^- ${name}:`, 'm'), `${name} is not listed`);
    assert.ok(!pi.tools.includes(input.toolSnippets[name]), `${name}'s snippet is not in <tools>`);
  }
  for (const name of ['grep', 'find', 'ls']) {
    for (const rule of input.toolGuidelines[name] ?? []) assert.ok(!pi.rules.includes(rule));
  }
  assert.match(pi.rules, /^- Use bash for file operations like ls, rg, find$/m);
  assert.doesNotMatch(pi.rules, /IDLE-GUIDELINE|deploy_check/);
});

test('MEM-01 a declared extension tool with promptSnippet and promptGuidelines appears in both sections like pi',
  () => {
    const { pi } = assertSameAsPi(inputOf([...DEFAULT_TOOLS, 'deploy_check']));
    assert.match(pi.tools, /^- deploy_check: Check a deployment \(synthetic\)$/m, 'the snippet on one line');
    assert.match(pi.rules, /^- Run deploy_check before saying a deploy is done \(synthetic\)\.$/m);
  });

test('MEM-01 an extension tool registered but not declared does not appear', () => {
  const { pi } = assertSameAsPi(inputOf(DEFAULT_TOOLS));
  assert.ok(!pi.tools.includes('idle_tool') && !pi.rules.includes('IDLE-GUIDELINE'));
});

test('MEM-01 a declared tool in hiddenTools does not appear', () => {
  const { pi } = assertSameAsPi(inputOf([...DEFAULT_TOOLS, 'deploy_check', 'idle_tool'], ['deploy_check', 'edit']));
  assert.ok(!pi.tools.includes('deploy_check') && !pi.rules.includes('deploy_check'));
  assert.doesNotMatch(pi.tools, /^- edit:/m, 'a hidden built-in tool is not listed either');
  assert.match(pi.tools, /^- idle_tool: An idle tool \(synthetic\)$/m);
});

test('MEM-01 shell rule, four cases: only bash, only powershell, bash and powershell, bash with grep', () => {
  const cases = [
    [['read', 'bash'], 'Use bash for file operations like ls, rg, find'],
    [['read', 'powershell'], 'Use PowerShell for file operations like listing, searching, and finding files'],
    [['read', 'bash', 'powershell'], 'Use bash or PowerShell for file operations like listing, searching, and finding '
      + 'files'],
    [['read', 'bash', 'grep'], null],
  ];
  for (const [tools, rule] of cases) {
    const { pi } = assertSameAsPi(inputOf(tools));
    const first = pi.rules.split('\n')[1];
    if (rule) assert.equal(first, `- ${rule}`, tools.join('+'));
    else assert.doesNotMatch(pi.rules, /for file operations/, 'no shell rule when grep is declared');
  }
});

test('MEM-01 top-level promptGuidelines follow the tool guidelines, deduplicated like pi', () => {
  assertSameAsPi(inputOf(DEFAULT_TOOLS, [], ['Use write only for new files or complete rewrites.',
    'TOP-LEVEL (synthetic)', ' Be concise in your responses ']));
});

test('MEM-01 with the default tools the identity section is at most 500 tokens (estimateMemoryTokens)', () => {
  const identity = K.text.renderIdentity(inputOf(DEFAULT_TOOLS));
  const tokens = K.shared.estimateMemoryTokens(identity);
  assert.ok(tokens <= 500, `the identity section is ${tokens} tokens`);
});

/**
 * @brief 一个会话的 mori-memory（真实的 memorySetup 与 memoryExtension）注册在扩展 API 的替身上。
 * @param cwd 工作目录
 * @param kind 'user' 或实例的种类
 * @param enhance 增强会话的任务（synthetic 的运行句柄与依据范围）；普通会话为 null
 */
async function memoryApi(cwd, kind, enhance = null) {
  const spec = { enhance: enhance && { task: enhance, run: { id: 'r1', cwd, task: enhance, day: '2026-10-22' },
    scope: { sessions: [], instanceFiles: [], feedback: [] } } };
  const seats = kind === 'user' ? () => K.assemble.userRunSeats(null, false) : () => K.assemble.instanceSeats(kind);
  const setup = await K.ext.memorySetup({ cwd, kind, spec, seats, position: () => ({ session: null, entry: null,
    title: 'Untitled session' }) });
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  if (api.tools.has('memory')) api.setActiveTools([...api.getActiveTools(), 'memory']);
  return api;
}

test('MEM-01 every kind of session gets the identity as customPrompt, replacing SYSTEM.md; selectedTools untouched',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const kinds = [['user', null], ['create', null], ['close', null], ['task', null], ['ask', null],
      ['subscription', null], ['user', 'strategy'], ['task', 'review']];
    for (const [kind, enhance] of kinds) {
      const api = await memoryApi(cwd, kind, enhance);
      const registered = registeredPrompt(cwd, [...api.tools.values()]);
      const event = agentStart({ cwd, customPrompt: 'MORI-SYSTEM-MD (synthetic)', selectedTools: ['read'],
        ...registered });
      api.handlers.get('before_agent_start')(event);
      const options = event.systemPromptOptions;
      const label = `${kind}${enhance ? ` (${enhance} enhancement)` : ''}`;
      assert.equal(options.customPrompt, K.text.renderIdentity({ selectedTools: api.getActiveTools(),
        hiddenTools: [], promptGuidelines: [], ...registered }), label);
      assert.ok(options.customPrompt.startsWith(`${A1}\n\n<tools>\n`), label);
      assert.match(options.customPrompt, /^- bash: /m, `${label}: the tools are pi.getActiveTools(), not the copy`);
      assert.deepEqual(options.selectedTools, ['read'], `${label}: the event's selectedTools are not changed`);
      const sections = piPrompt.buildSystemPromptSections(options);
      assert.ok(!Object.values(sections).join('\n').includes('MORI-SYSTEM-MD'), `${label}: SYSTEM.md is not used`);
    }
  });

/**
 * @brief pi 的资源加载器读 SYSTEM.md（真实的 DefaultResourceLoader；项目受信任），交给 mori-memory 覆盖。
 * @return 加载器读到的 customPrompt、来源路径（sessions.ts 按它记日志），和覆盖后 system prompt 的各段
 */
async function systemMdRun(cwd, agentDir) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [] });
  await loader.reload({ resolveProjectTrust: async () => true });
  const api = fakePi();
  const setup = await K.ext.memorySetup({ cwd, kind: 'user', spec: { enhance: null },
    seats: () => K.assemble.userRunSeats(null, false), position: () => ({ session: null, entry: null, title: '' }) });
  K.ext.memoryExtension(setup)(api);
  const event = agentStart({ cwd, customPrompt: loader.getSystemPrompt(), ...registeredPrompt(cwd) });
  const loaded = event.systemPromptOptions.customPrompt;
  api.handlers.get('before_agent_start')(event);
  return { loaded, source: loader.getSystemPromptSource()?.path ?? null,
    sections: piPrompt.buildSystemPromptSections(event.systemPromptOptions) };
}

test('MEM-01 a trusted project .pi/SYSTEM.md and a user-level SYSTEM.md are read by pi but not used', async (t) => {
  const { userData } = freshUserData(t, K);
  const agentDir = join(userData, 'pi');
  const cwd = mkdtempSync(join(tmpdir(), 'mori-sysmd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'SYSTEM.md'), 'MORI-USER-SYSTEM-MD (synthetic)\n');
  writeFileSync(join(cwd, '.pi', 'SYSTEM.md'), 'MORI-PROJECT-SYSTEM-MD (synthetic)\n');
  const project = await systemMdRun(cwd, agentDir);
  assert.match(project.loaded, /MORI-PROJECT-SYSTEM-MD/, 'pi put the project SYSTEM.md into customPrompt');
  assert.equal(project.source?.toLowerCase(), join(cwd, '.pi', 'SYSTEM.md').toLowerCase(),
    'the source path the kernel logs (`SYSTEM.md is not used: <path>`)');
  assert.ok(project.sections.preamble.startsWith(A1));
  assert.ok(!Object.values(project.sections).join('\n').includes('SYSTEM-MD'));
  rmSync(join(cwd, '.pi', 'SYSTEM.md'));
  const user = await systemMdRun(cwd, agentDir);
  assert.match(user.loaded, /MORI-USER-SYSTEM-MD/, 'pi put the user-level SYSTEM.md into customPrompt');
  assert.equal(user.source?.toLowerCase(), join(agentDir, 'SYSTEM.md').toLowerCase());
  assert.ok(user.sections.preamble.startsWith(A1));
  assert.ok(!Object.values(user.sections).join('\n').includes('SYSTEM-MD'));
});
