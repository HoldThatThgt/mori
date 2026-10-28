// kernel/contextBreakdown.ts 的单元测试（docs/v0/screens/models.md"详情里的分项"，2026-10-26 WP-12）。
// 真实录制（tests/fixtures/m6/agents-md.json、mcp.json、plugin.json，DeepSeek 录的）里的 system 消息先用 pi-ai 的
// getCurrentSystemMessage 重放（同 sessions.ts），再按状态表分项；另有手写的 system 消息（synthetic）测记忆分节、
// 不分节的正文、后来的消息删分节和换工具、中日韩字符和几个边界，期望的数是手算的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { loadKernelModule } from './load.mjs';

const { contextBreakdown } = await loadKernelModule('src/kernel/contextBreakdown.ts');
const { estimateMemoryTokens } = await loadKernelModule('src/shared/memory.ts');
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** pi 默认的自动压缩留出的 token 数 */
const RESERVE = 16384;
/** 前五项（Messages 是用量减去它们） */
const FIXED = ['systemPrompt', 'systemTools', 'mcpTools', 'memoryFiles', 'skills'];

/**
 * @brief 一份录制里第一个会话的消息（按 message_end 的顺序）重放出的当前 system 消息，和最后一次 session.state 的用量。
 * @param name tests/fixtures 下的相对路径（不带 .json）
 */
function recorded(name) {
  const steps = JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')).steps;
  const ends = steps.filter((step) => step.envelope?.event?.type === 'message_end');
  const sessionId = ends[0].envelope.sessionId;
  const messages = ends.filter((step) => step.envelope.sessionId === sessionId)
    .map((step) => step.envelope.event.message);
  const usage = steps.filter((step) => step.result?.type === 'session.state').at(-1).result.value.contextUsage;
  return { system: getCurrentSystemMessage(messages), usage };
}

/**
 * 算进 System prompt 的分节（不是 AGENTS.md、记忆、技能的）。旧录制（m6/agents-md）里 pi 把 tools、rules、docs 分节；
 * 2026-10-28 在合并后的树上重录的 m6/plugin 只有 preamble、skills、cwd（Mori 的身份段自己带 <tools>、<rules>，
 * docs/specs/memory.md §4.1），所以按录制里有的算
 */
const PROMPT_SECTIONS = ['preamble', 'tools', 'rules', 'docs', 'cwd'];
/** @brief 录制的 system 消息里有的 System prompt 分节。 */
const promptSections = (system) => PROMPT_SECTIONS.filter((name) => typeof system.sections[name] === 'string');

/** @brief 几个分节按 Mori 的估算加起来。 */
const sectionTokens = (system, names) => names
  .reduce((sum, name) => sum + estimateMemoryTokens(system.sections[name]), 0);
/** @brief 一组工具说明（JSON）按 Mori 的估算加起来。 */
const toolTokens = (tools) => tools.reduce((sum, tool) => sum + estimateMemoryTokens(JSON.stringify(tool)), 0);
/** @brief 前五项加起来。 */
const fixedOf = (parts) => FIXED.reduce((sum, key) => sum + parts[key], 0);

test('WP-12 AGENTS.md (project_context) is Memory files; the other sections are System prompt; tools are System tools',
  () => {
    const { system, usage } = recorded('m6/agents-md');
    const parts = contextBreakdown({ system, mcpTools: new Set(), usage, reserve: RESERVE });
    assert.equal(parts.memoryFiles, sectionTokens(system, ['project_context']));
    assert.ok(parts.memoryFiles > 0);
    assert.equal(parts.systemPrompt, sectionTokens(system, ['preamble', 'tools', 'rules', 'docs', 'cwd']));
    assert.equal(parts.systemTools, toolTokens(system.toolsAdded));
    assert.deepEqual([parts.mcpTools, parts.skills], [0, 0]);
    assert.equal(parts.messages, Math.max(0, usage.tokens - fixedOf(parts)));
    assert.equal(parts.autocompactBuffer, RESERVE);
    assert.equal(parts.freeSpace, usage.contextWindow - usage.tokens - RESERVE);
  });

test('WP-12 tools whose source is builtin:mcp are MCP tools, the rest stay System tools', () => {
  const { system, usage } = recorded('m6/mcp');
  const mcp = system.toolsAdded.filter((tool) => tool.name.startsWith('mcp__'));
  assert.equal(mcp.length, 2);
  const parts = contextBreakdown({ system, mcpTools: new Set(mcp.map((tool) => tool.name)), usage, reserve: RESERVE });
  assert.equal(parts.mcpTools, toolTokens(mcp));
  assert.equal(parts.systemTools, toolTokens(system.toolsAdded.filter((tool) => !tool.name.startsWith('mcp__'))));
});

test('WP-12 the skills section is Skills, not System prompt', () => {
  const { system, usage } = recorded('m6/plugin');
  const parts = contextBreakdown({ system, mcpTools: new Set(), usage, reserve: RESERVE });
  assert.equal(parts.skills, sectionTokens(system, ['skills']));
  assert.ok(parts.skills > 0);
  assert.deepEqual(Object.keys(system.sections).sort(), [...promptSections(system), 'skills'].sort());
  assert.equal(parts.systemPrompt, sectionTokens(system, promptSections(system)));
});

/** 手写的两条 system 消息（synthetic）：第二条删掉 taste、加一段正文、换掉 grep 加一个 MCP 工具 */
const SYNTHETIC = [
  { role: 'system', content: '', timestamp: 1, sections: { preamble: 'You are Mori.', project_context: '规则：先读后写',
    taste: '- short answers', facts: '- 用户叫小林', skills: 'skill list here!', cwd: 'D:/code/x' },
  toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } },
    { name: 'grep', description: 'Search', parameters: { type: 'object' } }] },
  { role: 'user', content: 'hello', timestamp: 2 },
  { role: 'system', content: 'Extra instructions.', timestamp: 3, sections: { taste: null },
    toolsRemoved: [{ name: 'grep' }],
    toolsAdded: [{ name: 'mcp__s1__echo', description: 'Echo', parameters: { type: 'object' } }] },
];
const USAGE = { tokens: 1000, contextWindow: 128000, percent: 0.78125 };

test('WP-12 replayed prompt: a second message adds System prompt text and removes a section and a tool; CJK counts 1',
  () => {
    const system = getCurrentSystemMessage(SYNTHETIC);
    const parts = contextBreakdown({ system, mcpTools: new Set(['mcp__s1__echo']), usage: USAGE, reserve: RESERVE });
    // System prompt：preamble 13 字 → 4，cwd 9 字 → 3，后来的正文 19 字 → 5
    // Memory files：project_context 7 个中日韩字符 → 7，facts 5 个加 2 个其他字符 → 6（taste 已删）
    // Skills 16 字 → 4；read 的 JSON 74 字 → 19；mcp__s1__echo 的 JSON 76 字 → 19
    assert.deepEqual(parts, { systemPrompt: 12, systemTools: 19, mcpTools: 19, memoryFiles: 13, skills: 4,
      messages: 1000 - 67, autocompactBuffer: RESERVE, freeSpace: 128000 - 1000 - RESERVE });
  });

test('WP-12 no breakdown before any message or right after a compaction', () => {
  const system = getCurrentSystemMessage(SYNTHETIC);
  for (const tokens of [0, null]) {
    const usage = { tokens, contextWindow: 128000, percent: tokens === null ? null : 0 };
    assert.equal(contextBreakdown({ system, mcpTools: new Set(), usage, reserve: RESERVE }), null);
  }
});

test('WP-12 auto-compaction off: no Autocompact buffer, Free space is the window minus the usage', () => {
  const parts = contextBreakdown({ system: undefined, mcpTools: new Set(), usage: USAGE, reserve: null });
  assert.equal(parts.autocompactBuffer, null);
  assert.equal(parts.freeSpace, 128000 - 1000);
  // 对话里还没有 system 消息时前五项都是 0，用量都算 Messages
  assert.equal(fixedOf(parts), 0);
  assert.equal(parts.messages, 1000);
});

test('WP-12 Messages and Free space never go below 0', () => {
  const system = getCurrentSystemMessage(SYNTHETIC);
  const small = contextBreakdown({ system, mcpTools: new Set(), usage: { tokens: 40, contextWindow: 128000,
    percent: 0.03125 }, reserve: RESERVE });
  assert.equal(small.messages, 0);
  const full = contextBreakdown({ system, mcpTools: new Set(), usage: { tokens: 120000, contextWindow: 128000,
    percent: 93.75 }, reserve: RESERVE });
  assert.equal(full.freeSpace, 0);
  assert.equal(full.autocompactBuffer, RESERVE);
});
