// 身份段里的权限句与 .work 一行（docs/specs/file-system-permissions.md §6.16、§7.12，原文见 file-system.md §14 与
// 记忆规格附录 A.1；验收 file-system.md §19.2 FS-39、FS-54 的单元层）：memoryText.ts 的 identityText 与规格逐字比较，
// 规格原文从 docs/specs/ 读出；ApprovalPolicy.promptMode 给出这次运行用哪一句；mori-memory 只在 before_agent_start 读
// 一次 promptMode（会话表的接线：permission: () => approval.promptMode()，用真实的 memorySetup 与 memoryExtension，
// 扩展 API 与 before_agent_start 事件是替身，synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStart, fakePi, freshUserData, loadTextKernel, registeredPrompt } from '../memory/text-helpers.mjs';
import { specText } from './gate-helpers.mjs';

const K = await loadTextKernel();
const T = K.text;
const { ApprovalPolicy } = K;

const FS = specText('file-system.md');
const MEMORY = specText('memory.md');

/** @brief 一段文字里某个标题之后的第一个 ```text 代码块。 */
function textBlock(spec, heading) {
  const at = spec.indexOf(`\n${heading}`);
  assert.ok(at >= 0, `no heading ${heading}`);
  const open = spec.indexOf('```text\n', at) + '```text\n'.length;
  return spec.slice(open, spec.indexOf('\n```', open));
}

/** file-system.md §14 一节 */
const SECTION_14 = FS.slice(FS.indexOf('\n## 14. '), FS.indexOf('\n## 15. '));

/**
 * @brief §14 原文表里以 start 开头的那段反引号原文（按英文开头找，同 tests/unit/memory/text-helpers.mjs 的 fsSpecQuote，
 *        只在 §14 一节里找）。
 * @param start 原文的开头
 */
function quote14(start) {
  const at = SECTION_14.indexOf(`\`${start}`);
  assert.ok(at >= 0, `no quoted text starting with "${start}" in §14`);
  const end = SECTION_14.indexOf('`', at + 1);
  assert.ok(end > at, `the quote starting with "${start}" is not closed`);
  return SECTION_14.slice(at + 1, end);
}

/** §14 的身份段第二行：Ask each time、Full access、没人能批；第三行（.work） */
const ASK_LINE = quote14('Tool calls other than reading');
const FULL_LINE = quote14('Reading, searching and MCP tools');
const NONE_LINE = quote14('Nobody can approve tool calls');
const WORK_LINE = quote14('Put scripts, drafts');

/** 记忆规格附录 A.1 的全文（Ask each time） */
const A1 = textBlock(MEMORY, '### A.1');
/** §14 的身份段全文（Ask each time） */
const FULL_14 = textBlock(SECTION_14, '## 14. ');

/** @brief identityText 的第 n 行（从 1 起）。 */
const lineOf = (permission, n) => T.identityText(permission).split('\n')[n - 1];

test('FS-39 identityText("ask") second line equals appendix A.1 and the §14 Ask each time row word for word', () => {
  assert.equal(lineOf('ask', 2), A1.split('\n')[1]);
  assert.equal(lineOf('ask', 2), ASK_LINE);
  assert.equal(lineOf('ask', 2), "Tool calls other than reading and searching may wait for the user's approval. "
    + "A denied call returns the user's reason as its result: follow it and don't repeat the call.");
});

test('FS-39 identityText("full") and identityText("none") second lines equal §14 word for word', () => {
  assert.equal(lineOf('full', 2), FULL_LINE);
  assert.equal(lineOf('none', 2), NONE_LINE);
  assert.notEqual(lineOf('full', 2), lineOf('ask', 2));
  assert.notEqual(lineOf('none', 2), lineOf('full', 2));
});

test('FS-39 the identity text has four lines; the first and fourth are the same in every mode; ask is A.1 in full',
  () => {
  for (const permission of ['ask', 'full', 'none']) {
    const lines = T.identityText(permission).split('\n');
    assert.equal(lines.length, 4, permission);
    assert.equal(lines[0], A1.split('\n')[0], permission);
    assert.equal(lines[3], A1.split('\n')[3], permission);
  }
  assert.equal(T.identityText('ask'), A1);
  assert.equal(T.identityText('ask'), FULL_14);
});

test('FS-39 renderIdentity starts with identityText of the permission it is given', () => {
  const input = { selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [] };
  for (const permission of ['ask', 'full', 'none']) {
    assert.ok(T.renderIdentity(input, permission).startsWith(`${T.identityText(permission)}\n\n<tools>\n`), permission);
  }
});

test('FS-39 promptMode: ask by default, full after switching, none when nobody can approve', () => {
  const policy = new ApprovalPolicy();
  assert.equal(policy.promptMode(), 'ask');
  policy.setMode('full');
  assert.equal(policy.promptMode(), 'full');
  policy.setMode('ask');
  assert.equal(policy.promptMode(), 'ask');
  const enhancement = new ApprovalPolicy({ mode: 'full', canAsk: false });
  assert.equal(enhancement.promptMode(), 'none');
  assert.equal(new ApprovalPolicy({ mode: 'ask', canAsk: false }).promptMode(), 'none');
});

/**
 * @brief 一个用户会话的 mori-memory，身份段的模式取自 policy.promptMode()（同 sessions.ts createEntry 的接线），
 *        记下 promptMode 被读了几次。
 * @return { api（扩展 API 的替身）, reads（读的次数）, run（一次运行开始：返回事件）}
 */
async function wiredMemory(cwd, policy) {
  let reads = 0;
  const setup = await K.ext.memorySetup({ cwd, kind: 'user', spec: { enhance: null },
    seats: () => K.assemble.userRunSeats(null, false), position: () => ({ session: null, entry: null, title: '' }),
    permission: () => {
      reads += 1;
      return policy.promptMode();
    } });
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  const run = () => {
    const event = agentStart({ cwd, ...registeredPrompt(cwd, [...api.tools.values()]) });
    api.handlers.get('before_agent_start')(event);
    return event;
  };
  return { api, reads: () => reads, run };
}

/** @brief 一次运行的 customPrompt 里身份段的第二行。 */
const secondLine = (event) => event.systemPromptOptions.customPrompt.split('\n')[1];

/**
 * @brief 运行中途 mori-memory 可能收到的事件（synthetic）：除 before_agent_start 外每个注册的处理器都调一遍。
 *        tool_call 用读、工作路径里的写入与命令三种；没列出的事件名给只有 type 的事件。
 * @return 调过的事件名
 */
function midRunEvents(memory, cwd) {
  const ctx = { cwd, signal: undefined };
  const toolCalls = [['read', { path: 'a.txt' }], ['write', { path: 'a.txt', content: 'x' }],
    ['bash', { command: 'npm test' }]].map(([toolName, input], index) =>
    ({ type: 'tool_call', toolCallId: `mid-${index}`, toolName, input }));
  const called = [];
  for (const [name, handler] of memory.api.handlers) {
    if (name === 'before_agent_start') continue;
    for (const event of name === 'tool_call' ? toolCalls : [{ type: name }]) handler(event, ctx);
    called.push(name);
  }
  return called;
}

test('FS-39 the next run after switching to Full access uses the Full access line; a switch mid-run changes nothing',
  async (t) => {
  const { cwd } = freshUserData(t, K);
  const policy = new ApprovalPolicy();
  const memory = await wiredMemory(cwd, policy);
  const first = memory.run();
  assert.equal(secondLine(first), ASK_LINE);
  assert.equal(memory.reads(), 1, 'the mode is read once, when the run starts');
  policy.setMode('full');
  assert.ok(midRunEvents(memory, cwd).includes('tool_call'), 'the tool_call handler was driven');
  assert.equal(memory.reads(), 1, 'no handler but before_agent_start reads the mode: a mid-run switch changes nothing');
  const next = memory.run();
  assert.equal(secondLine(next), FULL_LINE);
  assert.equal(memory.reads(), 2);
  policy.setMode('ask');
  assert.equal(secondLine(memory.run()), ASK_LINE, 'back to Ask each time');
});

test('FS-39 an enhancement session (Full access, nobody can approve) gets the nobody-can-approve line', async (t) => {
  const { cwd } = freshUserData(t, K);
  // 增强会话的批准状态照 sessions.ts userApproval：Full access 且 canAsk 为假
  const memory = await wiredMemory(cwd, new ApprovalPolicy({ mode: 'full', canAsk: false }));
  const event = memory.run();
  assert.equal(secondLine(event), NONE_LINE);
  assert.ok(event.systemPromptOptions.customPrompt.startsWith(`${T.identityText('none')}\n\n<tools>\n`));
});

test('FS-54 identityText third line (.work) equals §14 word for word in ask, full and none', () => {
  assert.equal(WORK_LINE, 'Put scripts, drafts, and temporary files you need along the way in .work/ in the working '
    + "directory. Git ignores it, and edit and write calls there never wait for the user's approval. Commands run "
    + 'with TEMP, TMP, and TMPDIR set to .work/tmp; use them instead of /tmp.');
  for (const permission of ['ask', 'full', 'none']) assert.equal(lineOf(permission, 3), WORK_LINE, permission);
  assert.equal(A1.split('\n')[2], WORK_LINE, 'appendix A.1 has the same line');
});
