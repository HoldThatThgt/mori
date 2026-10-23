// AGENTS.md 的 token 数（kernel/agents.ts 的 readAgents，即 agents.get，docs/specs/memory.md §10.3）：每个文件按 pi 加载结果里的
// content（已去 BOM）单独估算；userTokens 是 agentDir 里生效的那个文件的；total = userTokens + loaded 各项之和。
// 会话表换成替身（synthetic）：焦点会话的 getAgentsFiles 用 pi 自己的 loadProjectContextFiles 给出，与真实会话加载的相同。
// AGENTS.md 的内容由测试手写（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent';
import { hooks, loadBundle, scenario } from './enhance-harness.mjs';

const { agents, shared } = await loadBundle({ agents: 'src/kernel/agents.ts', shared: 'src/shared/memory.ts' },
  ['sessions']);

/** 中日韩字符（§6.3 的范围：CJK 标点、假名、扩展 A、统一表意文字、韩文音节、全角形式） */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

/** @brief 独立算出的估算（§6.3）：中日韩字符每个 1，其余字符数 ÷ 4 向上取整。 */
function expectedTokens(text) {
  const cjk = [...text].filter((char) => CJK.test(char)).length;
  return cjk + Math.ceil(([...text].length - cjk) / 4);
}

/** @brief 写一个文件（目录不存在时先建）。 */
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** @brief 焦点会话（synthetic）：getAgentsFiles 用 pi 的 loadProjectContextFiles 给出。 */
function focusedSession(cwd, agentDir) {
  hooks().sessionContext = (id) => {
    assert.equal(id, 'synthetic-session');
    const agentsFiles = loadProjectContextFiles({ cwd, agentDir });
    return { session: { resourceLoader: { getAgentsFiles: () => ({ agentsFiles }) } } };
  };
}

test('MEM-16 agents.get gives userTokens and total for the user-level file; BOM not counted; no session → loaded null',
  async (t) => {
    const s = scenario(t);
    const text = 'Use tabs for indentation.\n回答用中文。\n';
    put(join(s.agentDir, 'AGENTS.md'), `﻿${text}`);
    const info = await agents.readAgents();
    assert.equal(info.effectivePath, join(s.agentDir, 'AGENTS.md'));
    assert.equal(info.loaded, null);
    assert.equal(info.userTokens, expectedTokens(text));
    assert.equal(info.userTokens, shared.estimateMemoryTokens(text));
    assert.equal(info.total, info.userTokens);
    assert.equal(info.content, `﻿${text}`, 'the editor still gets the file as it is');
  });

test('MEM-16 agents.get lists each loaded file with its tokens; total is the sum of all rows', async (t) => {
  const s = scenario(t);
  const cwd = s.project('shop');
  const user = 'Prefer short answers.';
  const parent = 'Monorepo rules: run the linter.\n'.repeat(3);
  const own = '﻿本项目使用 pnpm。Run tests with pnpm test.';
  put(join(s.agentDir, 'AGENTS.md'), user);
  put(join(dirname(cwd), 'AGENTS.md'), parent);
  put(join(cwd, 'AGENTS.md'), own);
  focusedSession(cwd, s.agentDir);
  const info = await agents.readAgents('synthetic-session');
  assert.deepEqual(info.loaded, [
    { path: join(dirname(cwd), 'AGENTS.md'), tokens: expectedTokens(parent) },
    { path: join(cwd, 'AGENTS.md'), tokens: expectedTokens(own.slice(1)) },
  ], 'the user-level file is not repeated in loaded; pi order; the BOM is not counted');
  assert.equal(info.userTokens, expectedTokens(user));
  assert.equal(info.total, info.userTokens + info.loaded[0].tokens + info.loaded[1].tokens);
});

test('MEM-16 the effective user-level file decides userTokens (CLAUDE.md when no AGENTS.md); none → 0; over 500',
  async (t) => {
    const s = scenario(t);
    const cwd = s.project('shop');
    const big = 'word '.repeat(420);
    put(join(cwd, 'AGENTS.md'), big);
    focusedSession(cwd, s.agentDir);
    const none = await agents.readAgents('synthetic-session');
    assert.equal(none.effectivePath, null);
    assert.equal(none.userTokens, 0);
    assert.equal(none.total, expectedTokens(big));
    assert.ok(none.total > 500, 'the total the page and Settings compare with 500');
    put(join(s.agentDir, 'CLAUDE.md'), 'Claude rules.');
    const claude = await agents.readAgents('synthetic-session');
    assert.equal(claude.effectivePath, join(s.agentDir, 'CLAUDE.md'));
    assert.equal(claude.userTokens, expectedTokens('Claude rules.'));
    assert.equal(claude.total, claude.userTokens + expectedTokens(big));
  });
