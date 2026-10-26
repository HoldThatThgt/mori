// memory 工具的错误的单元测试（docs/specs/memory.md §7.4、MEM-12）：表里每一行的原文；写法或规则错误的第二行
// `Correct form: …` 等于附录 A.4 里这个调用方的写法（从规格原文读出），其余没有第二行；按 id 与按 abstract 匹配；
// 字段长度与 abstract 多行；agent 不能写用户级规则；enhance 不能改 user 条目、别的种类、别的层；enhance 的 move 只移
// Mori 记的条目、一端是这次的种类（2026-10-26，§6.9）；缺依据在执行时报（§7.1）。被拒绝时什么都不写。
// 工具按 pi 的顺序调用（prepareArguments → validateToolArguments → execute），不合 schema 的由 pi 拒绝、不进执行。
// 记忆目录在临时 userData 下，条目由记忆页写入或测试写好，会话文件是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PAGE, callTool, freshUserData, loadTextKernel, ok, snapshotDir, specBlock, specItem, writeSessionFile,
} from './text-helpers.mjs';

const K = await loadTextKernel();
const AGENT = { kind: 'agent' };
const AGENT_FORM = `Correct form: ${specItem('`agent`')}`;
const ENHANCE_FORM = `Correct form: ${specItem('`enhance:<task>`')}`;
const USER_RULES = 'TASTE, STRATEGY, and REVIEW are saved to this project; only you can change user-level entries on '
  + 'the Memory page.';
const POSITION = () => ({ session: 'C:\\synthetic\\user.jsonl', entry: 'u1', title: 'Synthetic session' });

/** @brief agent 调用方的工具。 */
function agentTool(cwd) {
  return K.tool.memoryTool({ cwd, caller: AGENT, run: null, scope: null, position: POSITION });
}

/**
 * @brief synthetic：一次增强运行（beginRun）、列出的会话文件，与这个任务的工具。
 * @param t node:test 的测试上下文
 * @param cwd 项目
 * @param task 任务
 */
async function enhanceTool(t, cwd, task = 'strategy') {
  const file = join(cwd, '..', 'sessions', 'listed.jsonl');
  writeSessionFile(file, cwd, [{ id: 'a1b2c3d4', role: 'user', text: 'tell me the plan first', timestamp:
    '2026-10-22T09:00:00.000Z' }]);
  const run = await K.memory.beginRun({ cwd, task, day: '2026-10-22', sessions: 1, feedback: 1 });
  t.after(() => K.memory.endRun(run, { status: 'done', tokens: 0, notes: null }).catch(() => undefined));
  const scope = { sessions: [{ file, title: 'Payment refactor' }], instanceFiles: [],
    feedback: [{ name: '2026-10-22-101500.json', createdAt: '2026-10-22T02:15:00.000Z' }] };
  const tool = K.tool.memoryTool({ cwd, caller: { kind: 'enhance', task }, run, scope, position: () => {
    throw new Error('an enhancement caller has no position');
  } });
  return { tool, file, run, evidence: [{ session: file, entry: 'a1b2c3d4' }] };
}

/** @brief 被拒绝：isError，第一行是原因，第二行是给出的 Correct form（没有时只有一行），记忆目录不变。 */
async function refused(memoryRoot, tool, args, reason, form) {
  const before = snapshotDir(memoryRoot);
  const result = await callTool(tool, args);
  assert.equal(result.isError, true, `${JSON.stringify(args)} is refused`);
  assert.equal(result.text, form ? `${reason}\n${form}` : reason);
  assert.equal(result.details, undefined);
  assert.deepEqual(snapshotDir(memoryRoot), before, 'nothing is written');
}

test('MEM-12 the Correct form lines are appendix A.4 word for word', () => {
  assert.equal(K.text.correctForm(AGENT), AGENT_FORM);
  assert.equal(K.text.correctForm({ kind: 'enhance', task: 'taste' }), ENHANCE_FORM);
  assert.ok(AGENT_FORM.startsWith('Correct form: memory {"action":"save"'));
});

test('MEM-12 the tool descriptions are appendix A.2 and A.3 (with <KIND>) word for word', () => {
  assert.equal(K.text.toolDescription(AGENT), specBlock('### A.2'));
  for (const [task, kind] of [['taste', 'TASTE'], ['strategy', 'STRATEGY'], ['review', 'REVIEW']]) {
    assert.equal(K.text.toolDescription({ kind: 'enhance', task }), specBlock('### A.3').replaceAll('<KIND>', kind));
  }
});

test('MEM-12 arguments that do not fit the schema are refused by pi before execution', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const { tool, evidence } = await enhanceTool(t, cwd);
  const before = snapshotDir(memoryRoot);
  const schemaFails = [
    [agentTool(cwd), { kind: 'fact', abstract: 'x', quote: 'q' }, 'no action'],
    [agentTool(cwd), { action: 'remember', kind: 'fact' }, 'unknown action'],
    [agentTool(cwd), { action: 'save', kind: 'rule', abstract: 'x', quote: 'q' }, 'unknown kind'],
    [agentTool(cwd), { action: 'move', entry: 'e', kind: 'taste', note: 'n' }, 'move is for enhancement only'],
    [agentTool(cwd), { action: 'save', kind: 'fact', abstract: 'x', quote: 'q', asked: 'yes' }, 'asked not a boolean'],
    [tool, { action: 'move', entry: 'e', kind: 'rule', note: 'n' }, 'unknown kind for a move'],
    [tool, { action: 'save', abstract: 'x', evidence: [] }, 'empty evidence'],
    [tool, { action: 'save', abstract: 'x', evidence: Array.from({ length: 11 }, () => evidence[0]) }, '11 items'],
    [tool, { action: 'save', abstract: 'x', evidence: [{ quote: 'only a quote' }] }, 'an item of neither shape'],
  ];
  for (const [def, args, label] of schemaFails) {
    await assert.rejects(callTool(def, args), /^Error: Validation failed for tool "memory":/, label);
  }
  assert.deepEqual(snapshotDir(memoryRoot), before);
  const ten = await callTool(tool, { action: 'save', abstract: 'Ten items are fine (synthetic)',
    evidence: Array.from({ length: 10 }, () => evidence[0]) });
  assert.equal(ten.isError, false, ten.text);
});

test('MEM-12 a missing required field: `<field> is required for <action>.` with the Correct form', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const agent = agentTool(cwd);
  await refused(memoryRoot, agent, { action: 'save', abstract: 'x', quote: 'q' }, 'kind is required for save.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'save', kind: 'fact', quote: 'q' }, 'abstract is required for save.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'save', kind: 'fact', abstract: 'x' }, 'quote is required for save.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'update', note: 'n', quote: 'q' }, 'entry is required for update.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'update', entry: 'e', quote: 'q' }, 'note is required for update.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'update', entry: 'e', note: 'n' }, 'quote is required for update.',
    AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'forget', note: 'n' }, 'entry is required for forget.', AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'forget', entry: 'e' }, 'note is required for forget.', AGENT_FORM);
  const { tool, evidence } = await enhanceTool(t, cwd);
  await refused(memoryRoot, tool, { action: 'save', evidence }, 'abstract is required for save.', ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'update', note: 'n', evidence }, 'entry is required for update.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'forget', entry: 'e', evidence }, 'note is required for forget.',
    ENHANCE_FORM);
  // 2026-10-26（§7.1）：evidence 不在 schema 的 required 里，save、update、forget 缺它时在执行时报；move 不要它
  await refused(memoryRoot, tool, { action: 'save', abstract: 'x' }, 'evidence is required for save.', ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'update', entry: 'e', note: 'n' }, 'evidence is required for update.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'forget', entry: 'e', note: 'n' }, 'evidence is required for forget.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'move', kind: 'taste', note: 'n' }, 'entry is required for move.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'move', entry: 'e', note: 'n' }, 'kind is required for move.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'move', entry: 'e', kind: 'taste' }, 'note is required for move.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'save', abstract: 'x', kind: 'fact', evidence }, 'kind is only for move.',
    ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'update', entry: 'e', note: 'n', kind: 'strategy', evidence },
    'kind is only for move.', ENHANCE_FORM);
});

test('MEM-12 field lengths and a multi-line abstract', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const agent = agentTool(cwd);
  const save = (over) => ({ action: 'save', kind: 'fact', abstract: 'A fact', quote: 'q', ...over });
  await refused(memoryRoot, agent, save({ abstract: 'a'.repeat(201) }), 'abstract must be 1–200 characters.',
    AGENT_FORM);
  await refused(memoryRoot, agent, save({ abstract: '   ' }), 'abstract must be 1–200 characters.', AGENT_FORM);
  await refused(memoryRoot, agent, save({ quote: 'q'.repeat(601) }), 'quote must be 1–600 characters.', AGENT_FORM);
  await refused(memoryRoot, agent, save({ detail: 'd'.repeat(4001) }), 'detail must be at most 4000 characters.',
    AGENT_FORM);
  await refused(memoryRoot, agent, save({ abstract: 'Two\nlines' }), 'abstract must be one line.', AGENT_FORM);
  await refused(memoryRoot, agent, { action: 'update', entry: 'e', note: 'n'.repeat(601), quote: 'q' },
    'note must be 1–600 characters.', AGENT_FORM);
  const { tool, evidence } = await enhanceTool(t, cwd);
  await refused(memoryRoot, tool, { action: 'save', abstract: 'x', evidence: [{ ...evidence[0], quote:
    'q'.repeat(601) }] }, 'quote must be at most 600 characters.', ENHANCE_FORM);
  for (const [field, max] of [['abstract', 200], ['detail', 4000], ['quote', 600]]) {
    const result = await callTool(agent, save({ [field]: 'x'.repeat(max) }));
    assert.equal(result.isError, false, `${field} of exactly ${max} characters is accepted: ${result.text}`);
  }
});

test('MEM-12 the budget refusal is the §6.3 text with no Correct form', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  for (let i = 0; i < 2; i += 1) {
    ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: '规'.repeat(200), detail: '',
      evidence: [] }));
  }
  await refused(memoryRoot, agentTool(cwd), { action: 'save', kind: 'strategy', abstract: '则'.repeat(99), quote: 'q' },
    'Over the 500-token limit for STRATEGY: user 0 + this project 501 = 501. Merge or delete entries first.', null);
});

test('MEM-12 matching by id or by the abstract (spaces collapsed); not found lists at most 10', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const ids = [];
  for (let i = 1; i <= 12; i += 1) {
    ids.push(ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: `Fact number ${i}`,
      detail: '', evidence: [] })).id);
  }
  const agent = agentTool(cwd);
  const byId = await callTool(agent, { action: 'update', entry: ids[2], note: 'n', quote: 'q' });
  assert.equal(byId.text, 'Updated Facts (this project): Fact number 3');
  const byText = await callTool(agent, { action: 'update', entry: ' Fact   number\t4 ', note: 'n', quote: 'q' });
  assert.equal(byText.text, 'Updated Facts (this project): Fact number 4');
  assert.equal(byText.details.entry, ids[3]);
  const listed = ids.slice(0, 10).map((id, i) => `project/${id}: Fact number ${i + 1}`).join('; ');
  await refused(memoryRoot, agent, { action: 'forget', entry: 'Fact number 99', note: 'n' },
    `No entry matches “Fact number 99”. Entries you can change: ${listed}`, AGENT_FORM);
});

test('MEM-12 one text matching several entries in a layer asks for the id and layer', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const fact = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'Same line',
    detail: '', evidence: [] }));
  const taste = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'Same line',
    detail: '', evidence: [] }));
  await refused(memoryRoot, agentTool(cwd), { action: 'forget', entry: 'Same line', note: 'n' },
    `“Same line” matches several entries: project/${fact.id}, project/${taste.id}. Pass the id and layer.`,
    AGENT_FORM);
});

test('MEM-12 agent: both layers match without layer; user-level rules are refused (save, update, forget)',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const user = ok(await K.memory.save(PAGE, { cwd, layer: 'user', kind: 'fact', abstract: 'Twice', detail: '',
      evidence: [] }));
    const project = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'Twice',
      detail: '', evidence: [] }));
    const rule = ok(await K.memory.save(PAGE, { cwd, layer: 'user', kind: 'taste', abstract: 'Conclusion first',
      detail: '', evidence: [] }));
    const agent = agentTool(cwd);
    await refused(memoryRoot, agent, { action: 'forget', entry: 'Twice', note: 'n' },
      `“Twice” matches entries in both layers (user: ${user.id}, this project: ${project.id}). Pass layer.`,
      AGENT_FORM);
    for (const kind of ['taste', 'strategy', 'review']) {
      await refused(memoryRoot, agent, { action: 'save', kind, layer: 'user', abstract: 'x', quote: 'q' }, USER_RULES,
        AGENT_FORM);
    }
    await refused(memoryRoot, agent, { action: 'update', entry: 'Conclusion first', note: 'n', quote: 'q' }, USER_RULES,
      AGENT_FORM);
    await refused(memoryRoot, agent, { action: 'forget', entry: rule.id, note: 'n' }, USER_RULES, AGENT_FORM);
    await refused(memoryRoot, agent, { action: 'forget', entry: rule.id, layer: 'user', note: 'n' }, USER_RULES,
      AGENT_FORM);
  });

test('MEM-12 enhance: an entry the user wrote is read-only; other kinds and layers are refused', async (t) => {
  const { cwd, memoryRoot } = freshUserData(t, K);
  const mine = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy',
    abstract: 'Ask before big refactors', detail: '', evidence: [] }));
  const taste = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'Be brief',
    detail: '', evidence: [] }));
  ok(await K.memory.save(PAGE, { cwd, layer: 'user', kind: 'strategy', abstract: 'User level plan', detail: '',
    evidence: [] }));
  const { tool, evidence } = await enhanceTool(t, cwd);
  const readOnly = '“Ask before big refactors” is an entry the user wrote; it’s read-only for enhancement. Mention the '
    + 'conflict in your final reply.';
  await refused(memoryRoot, tool, { action: 'update', entry: mine.id, note: 'n', evidence }, readOnly, ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'forget', entry: 'Ask before big refactors', note: 'n', evidence },
    readOnly, ENHANCE_FORM);
  const other = 'This run maintains this project’s STRATEGY entries only.';
  await refused(memoryRoot, tool, { action: 'update', entry: taste.id, note: 'n', evidence }, other, ENHANCE_FORM);
  await refused(memoryRoot, tool, { action: 'forget', entry: 'User level plan', note: 'n', evidence }, other,
    ENHANCE_FORM);
  ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'A project fact', detail: '',
    evidence: [] }));
  const fact = await callTool(tool, { action: 'forget', entry: 'A project fact', note: 'n', evidence });
  assert.match(fact.text, /^No entry matches “A project fact”\. /, 'facts are not in the material: not found (§7.4)');
  const missing = await callTool(tool, { action: 'update', entry: 'nothing like it', note: 'n', evidence });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^No entry matches “nothing like it”\. Entries you can change: /);
  assert.ok(!missing.text.split('\n')[0].includes(mine.id), 'entries the user wrote are not offered to enhancement');
  assert.equal(missing.text.split('\n')[1], ENHANCE_FORM);
});

/** @brief synthetic：Mori 主动记下的一条（agent 调用方没给 asked），返回它的 id。 */
async function agentSaved(cwd, kind, abstract) {
  const result = await callTool(agentTool(cwd), { action: 'save', kind, abstract, quote: 'q (synthetic)' });
  assert.equal(result.isError, false, result.text);
  return result.details.entry;
}

test('MEM-12 enhance move: only entries added by Mori, one end is this run’s kind, not to the kind it is in',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const said = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'strategy', abstract: 'A rule you wrote',
      detail: '', evidence: [] }));
    ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'A fact you wrote', detail: '',
      evidence: [] }));
    const agentFact = await agentSaved(cwd, 'fact', 'A fact Mori added');
    const agentTaste = await agentSaved(cwd, 'taste', 'A taste Mori added');
    const agentStrategy = await agentSaved(cwd, 'strategy', 'A strategy Mori added');
    const { tool, evidence } = await enhanceTool(t, cwd, 'strategy');
    const learned = (await callTool(tool, { action: 'save', abstract: 'A learned strategy', evidence })).details.entry;
    const readOnly = '“A rule you wrote” is an entry the user wrote; it’s read-only for enhancement. Mention the '
      + 'conflict in your final reply.';
    await refused(memoryRoot, tool, { action: 'move', entry: said.id, kind: 'fact', note: 'n' }, readOnly,
      ENHANCE_FORM);
    const fact = await callTool(tool, { action: 'move', entry: 'A fact you wrote', kind: 'strategy', note: 'n' });
    assert.match(fact.text, /^No entry matches “A fact you wrote”\. /, 'facts you wrote are not in the material');
    await refused(memoryRoot, tool, { action: 'move', entry: learned, kind: 'fact', note: 'n' },
      '“A learned strategy” wasn’t added by Mori; only entries added by Mori can be moved.', ENHANCE_FORM);
    await refused(memoryRoot, tool, { action: 'move', entry: agentFact, kind: 'taste', note: 'n' },
      'This run maintains this project’s STRATEGY entries only.', ENHANCE_FORM);
    await refused(memoryRoot, tool, { action: 'move', entry: agentStrategy, kind: 'strategy', note: 'n' },
      '“A strategy Mori added” is already in STRATEGY.', ENHANCE_FORM);
    await refused(memoryRoot, tool, { action: 'update', entry: agentTaste, note: 'n', evidence },
      'This run maintains this project’s STRATEGY entries only.', ENHANCE_FORM);
    const moved = await callTool(tool, { action: 'move', entry: 'A fact Mori added', kind: 'strategy', note: 'n' });
    assert.equal(moved.text, 'Moved to STRATEGY (this project): A fact Mori added', 'matched by its abstract');
  });

test('MEM-12 evidence outside this run: `Evidence <n> isn’t from this run’s material: <reason>.` with no form',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const { tool, file, evidence } = await enhanceTool(t, cwd);
    const other = join(cwd, '..', 'sessions', 'other.jsonl');
    writeSessionFile(other, cwd, [{ id: 'ffff0000', role: 'user', text: 'x', timestamp: '2026-10-22T09:00:00.000Z' }]);
    const save = (items) => ({ action: 'save', abstract: 'A learned rule', evidence: items });
    await refused(memoryRoot, tool, save([{ session: other, entry: 'ffff0000' }]),
      'Evidence 1 isn’t from this run’s material: session not listed.', null);
    await refused(memoryRoot, tool, save([...evidence, { session: file, entry: 'zzzz9999' }]),
      `Evidence 2 isn’t from this run’s material: entry zzzz9999 not in ${file}.`, null);
    await refused(memoryRoot, tool, save([{ feedback: '2026-10-21-090000.json' }]),
      'Evidence 1 isn’t from this run’s material: feedback not listed.', null);
  });

test('MEM-12 a project folder that belongs to another working folder is refused with the §3 text', async (t) => {
  const { userData, memoryRoot } = freshUserData(t, K);
  const first = join(userData, 'work', 'a-b');
  const second = join(userData, 'work', 'a', 'b');
  assert.equal(K.memory.projectDir(first).dir, K.memory.projectDir(second).dir, 'the lossy encoding collides');
  ok(await K.memory.save(PAGE, { cwd: first, layer: 'project', kind: 'fact', abstract: 'Owned', detail: '',
    evidence: [] }));
  await refused(memoryRoot, agentTool(second), { action: 'save', kind: 'fact', abstract: 'x', quote: 'q' },
    `This project’s memory folder belongs to ${resolve(first)}.`, null);
});

test('MEM-12 a failed write: `Couldn’t save the memory: <reason>` with no form', async (t) => {
  const { cwd } = freshUserData(t, K);
  const { dir } = K.memory.projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) })}\n`);
  writeFileSync(join(dir, 'entries'), 'synthetic: a file where the entries folder should be\n');
  const result = await callTool(agentTool(cwd), { action: 'save', kind: 'fact', abstract: 'x', quote: 'q' });
  assert.equal(result.isError, true);
  assert.match(result.text, /^Couldn’t save the memory: \S/);
  assert.ok(!result.text.includes('\nCorrect form:'));
});
