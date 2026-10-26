// 谁能改什么与 memory 工具的错误原文（docs/specs/memory.md §6.4、§7.1、§7.4、附录 A.4；验收 MEM-12 与 MEM-21 的权限部分，单元层）：
// memoryRules.ts 的字段检查、条目匹配（按 id 与按 abstract）、拒绝原文，memoryText.ts 的 Correct form；
// 记忆模块按同样的规则拒绝增强任务改你写的条目、别的种类、别的层，什么都不写。
// 依据的核对（会话、条目 id、反馈是否在这次运行的范围里）在 memoryTool.ts，不在这里。条目为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from '../load.mjs';
import {
  PAGE, enhancer, freshUserData, loadMemoryKernel, ok, seedKind, seedProject, snapshotDir,
} from './core-helpers.mjs';

const R = await loadKernelModule('src/kernel/memoryRules.ts');
const T = await loadKernelModule('src/kernel/memoryText.ts');
const F = await loadKernelModule('src/kernel/memoryFiles.ts');
const K = await loadMemoryKernel();

const AGENT = Object.freeze({ kind: 'agent' });
const STRATEGY_RUN = Object.freeze({ kind: 'enhance', task: 'strategy' });
/** 附录 A.4 的两行（逐字） */
const AGENT_FORM = 'Correct form: memory {"action":"save","kind":"fact","abstract":"<one line>","quote":"<the user\'s '
  + 'words>"}; update needs "entry", "note" and "quote"; forget needs "entry" and "note"';
const ENHANCE_FORM = 'Correct form: memory {"action":"update","entry":"<id>","note":"<why>","evidence":[{"session":'
  + '"<listed session file>","entry":"<line id>"}]}; save needs "abstract"; save, update and forget need "evidence"; '
  + 'move needs "entry", "kind" and "note"';
/** §7.4 的规则原文 */
const USER_RULES = 'TASTE, STRATEGY, and REVIEW are saved to this project; only you can change user-level entries on '
  + 'the Memory page.';
const OTHER_KIND = (kind) => `This run maintains this project’s ${kind} entries only.`;
const USER_ENTRY = (abstract) => `“${abstract}” is an entry the user wrote; it’s read-only for enhancement. `
  + 'Mention the conflict in your final reply.';
/** synthetic：增强运行的一项依据 */
const EVIDENCE = [{ session: 'C:\\work\\s.jsonl', entry: 'e1' }];

test('MEM-12 the Correct form lines are appendix A.4 word for word', () => {
  assert.equal(T.correctForm(AGENT), AGENT_FORM);
  for (const task of ['taste', 'strategy', 'review']) {
    assert.equal(T.correctForm({ kind: 'enhance', task }), ENHANCE_FORM);
  }
});

test('MEM-12 a missing required field reads “<field> is required for <action>.”', () => {
  const agentCases = [
    [{ action: 'save', abstract: 'A', quote: 'q' }, 'kind is required for save.'],
    [{ action: 'save', kind: 'fact', quote: 'q' }, 'abstract is required for save.'],
    [{ action: 'save', kind: 'fact', abstract: 'A' }, 'quote is required for save.'],
    [{ action: 'update', note: 'n', quote: 'q' }, 'entry is required for update.'],
    [{ action: 'update', entry: 'e', quote: 'q' }, 'note is required for update.'],
    [{ action: 'update', entry: 'e', note: 'n' }, 'quote is required for update.'],
    [{ action: 'forget', note: 'n' }, 'entry is required for forget.'],
    [{ action: 'forget', entry: 'e' }, 'note is required for forget.'],
    [{ action: 'save', kind: 'fact', abstract: 'A', quote: 'q' }, null],
    [{ action: 'update', entry: 'e', note: 'n', quote: 'q' }, null],
    [{ action: 'forget', entry: 'e', note: 'n' }, null],
  ];
  for (const [args, error] of agentCases) assert.equal(R.toolFieldError(args, AGENT), error, JSON.stringify(args));
  const enhanceCases = [
    [{ action: 'save', evidence: EVIDENCE }, 'abstract is required for save.'],
    [{ action: 'update', note: 'n', evidence: EVIDENCE }, 'entry is required for update.'],
    [{ action: 'update', entry: 'e', evidence: EVIDENCE }, 'note is required for update.'],
    [{ action: 'forget', entry: 'e', evidence: EVIDENCE }, 'note is required for forget.'],
    [{ action: 'save', abstract: 'A', evidence: EVIDENCE }, null],
    [{ action: 'update', entry: 'e', note: 'Seen again', evidence: EVIDENCE }, null],
    [{ action: 'forget', entry: 'e', note: 'n', evidence: EVIDENCE }, null],
    // 2026-10-26（§7.1、§6.9）：依据在执行时查；move 要 entry、kind、note，不要依据；kind 只给 move
    [{ action: 'save', abstract: 'A' }, 'evidence is required for save.'],
    [{ action: 'update', entry: 'e', note: 'n' }, 'evidence is required for update.'],
    [{ action: 'forget', entry: 'e', note: 'n' }, 'evidence is required for forget.'],
    [{ action: 'move', kind: 'fact', note: 'n' }, 'entry is required for move.'],
    [{ action: 'move', entry: 'e', note: 'n' }, 'kind is required for move.'],
    [{ action: 'move', entry: 'e', kind: 'fact' }, 'note is required for move.'],
    [{ action: 'move', entry: 'e', kind: 'fact', note: 'x'.repeat(601) }, 'note must be 1–600 characters.'],
    [{ action: 'move', entry: 'e', kind: 'fact', note: 'n' }, null],
    [{ action: 'move', entry: 'e', kind: 'fact', note: 'n', evidence: EVIDENCE }, null],
    [{ action: 'save', abstract: 'A', kind: 'strategy', evidence: EVIDENCE }, 'kind is only for move.'],
    [{ action: 'forget', entry: 'e', note: 'n', kind: 'fact', evidence: EVIDENCE }, 'kind is only for move.'],
  ];
  for (const [args, error] of enhanceCases) {
    assert.equal(R.toolFieldError(args, STRATEGY_RUN), error, JSON.stringify(args));
  }
});

test('MEM-12 field lengths and a multi-line abstract', () => {
  const save = (over) => R.toolFieldError({ action: 'save', kind: 'fact', abstract: 'A', quote: 'q', ...over }, AGENT);
  assert.equal(save({ abstract: '' }), 'abstract must be 1–200 characters.');
  assert.equal(save({ abstract: '   ' }), 'abstract must be 1–200 characters.');
  assert.equal(save({ abstract: 'x'.repeat(201) }), 'abstract must be 1–200 characters.');
  assert.equal(save({ abstract: 'x'.repeat(200) }), null);
  assert.equal(save({ abstract: '😀'.repeat(200) }), null, 'characters, not UTF-16 units');
  assert.equal(save({ abstract: 'line one\nline two' }), 'abstract must be one line.');
  assert.equal(save({ abstract: 'line one\r\nline two' }), 'abstract must be one line.');
  assert.equal(save({ detail: 'x'.repeat(4001) }), 'detail must be at most 4000 characters.');
  assert.equal(save({ detail: 'x'.repeat(4000) }), null);
  assert.equal(save({ quote: 'x'.repeat(601) }), 'quote must be 1–600 characters.');
  assert.equal(save({ quote: 'x'.repeat(600) }), null);
  const update = (over) => R.toolFieldError({ action: 'update', entry: 'e', note: 'n', quote: 'q', ...over }, AGENT);
  assert.equal(update({ note: 'x'.repeat(601) }), 'note must be 1–600 characters.');
  assert.equal(update({ note: '' }), 'note must be 1–600 characters.');
  assert.equal(update({ detail: 'x'.repeat(4001) }), 'detail must be at most 4000 characters.');
  const quote = R.toolFieldError({ action: 'update', entry: 'e', note: 'n',
    evidence: [{ feedback: 'f.json', quote: 'x'.repeat(601) }] }, STRATEGY_RUN);
  assert.equal(quote, 'quote must be at most 600 characters.', 'an evidence quote is optional');
});

/** @brief synthetic：一条可以被匹配的条目。 */
function C(layer, kind, id, abstract, source = 'user') {
  return { layer, kind, id, abstract, source };
}

/** synthetic：两层的条目 */
const ALL = [
  C('user', 'fact', 'port', 'Port is 8080'), C('project', 'fact', 'port', 'Port is 8080'),
  C('project', 'taste', 'short', 'Keep answers short'), C('project', 'strategy', 'plan', 'Plan first', 'learned'),
  C('project', 'strategy', 'plan-2', 'Plan first', 'learned'),
  C('project', 'strategy', 'mine', 'Ask before big refactors'), C('user', 'taste', 'tone', 'Be direct'),
  C('user', 'strategy', 'small', 'Small steps', 'learned'), C('project', 'review', 'check', 'Run the tests'),
  C('project', 'fact', 'misc', 'check'),
];

/** @brief 按 §7.4 的规则匹配。 */
function match(caller, entry, layer) {
  const scope = R.matchScope(caller, ALL);
  return R.matchEntry(caller, entry, layer, scope.candidates, scope.others);
}

test('MEM-12 entries match by id first, then by the prompt text with spaces normalised', () => {
  assert.equal(match(AGENT, 'short').match.id, 'short');
  assert.equal(match(AGENT, '  Keep   answers\nshort ').match.id, 'short');
  assert.deepEqual(match(AGENT, 'check').match, ALL[8], 'an id beats an abstract that reads the same');
  assert.equal(match(AGENT, 'Run the tests').match.id, 'check');
  assert.deepEqual(match(AGENT, 'Port is 8080', 'user').match, ALL[0]);
  assert.deepEqual(match(AGENT, 'port', 'project').match, ALL[1]);
});

test('MEM-12 several matches, both layers, nothing found: the §7.4 texts', () => {
  assert.equal(match(AGENT, 'Plan first').error,
    '“Plan first” matches several entries: project/plan, project/plan-2. Pass the id and layer.');
  const both = '“Port is 8080” matches entries in both layers (user: port, this project: port). Pass layer.';
  assert.equal(match(AGENT, 'Port is 8080').error, both);
  assert.equal(match(AGENT, 'port').error, both.replace('“Port is 8080”', '“port”'));
  const changeable = 'user/port: Port is 8080; project/port: Port is 8080; project/short: Keep answers short; '
    + 'project/plan: Plan first; project/plan-2: Plan first; project/mine: Ask before big refactors; '
    + 'project/check: Run the tests; project/misc: check';
  assert.equal(match(AGENT, 'Nothing like it').error,
    `No entry matches “Nothing like it”. Entries you can change: ${changeable}`);
  const many = Array.from({ length: 12 }, (_, i) => C('project', 'fact', `f${i}`, `Fact ${i}`));
  const error = R.matchEntry(AGENT, 'zzz', undefined, many, []).error;
  const listed = error.slice(error.indexOf('change: ') + 'change: '.length).split('; ');
  assert.deepEqual(listed, many.slice(0, 10).map((item) => `project/${item.id}: ${item.abstract}`),
    'at most 10 entries are listed');
  assert.equal(R.matchEntry(AGENT, 'zzz', undefined, [], []).error,
    'No entry matches “zzz”. Entries you can change: (none)');
});

test('MEM-12 the agent can’t change user-level rules; it may change user-level facts', () => {
  assert.equal(match(AGENT, 'Be direct').error, USER_RULES);
  assert.equal(match(AGENT, 'tone').error, USER_RULES);
  for (const kind of ['taste', 'strategy', 'review']) {
    assert.equal(R.writeRefusal(AGENT, { layer: 'user', kind, source: null }), USER_RULES, kind);
    assert.equal(R.writeRefusal(AGENT, { layer: 'project', kind, source: null }), null, kind);
  }
  assert.equal(R.writeRefusal(AGENT, { layer: 'user', kind: 'fact', source: 'user' }), null);
  assert.equal(R.writeRefusal(AGENT, { layer: 'project', kind: 'fact', source: 'learned' }), null);
  assert.equal(R.writeRefusal(null, { layer: 'user', kind: 'taste', source: 'learned' }), null, 'the Memory page');
});

test('MEM-12 enhancement can’t change entries the user wrote, other kinds or other layers', () => {
  const found = match(STRATEGY_RUN, 'Ask before big refactors');
  assert.equal(found.match.id, 'mine', 'a user entry of this kind is found…');
  assert.equal(R.writeRefusal(STRATEGY_RUN, found.match), USER_ENTRY('Ask before big refactors'), '…and refused');
  assert.equal(match(STRATEGY_RUN, 'Keep answers short').error, OTHER_KIND('STRATEGY'));
  assert.equal(match(STRATEGY_RUN, 'Small steps').error, OTHER_KIND('STRATEGY'), 'the user level');
  assert.equal(match(STRATEGY_RUN, 'Be direct').error, OTHER_KIND('STRATEGY'));
  assert.equal(match(STRATEGY_RUN, 'Port is 8080').error,
    'No entry matches “Port is 8080”. Entries you can change: project/plan: Plan first; project/plan-2: Plan first',
    'facts are not in this run’s material, and entries the user wrote are not offered');
  assert.equal(match({ kind: 'enhance', task: 'taste' }, 'Plan first').error, OTHER_KIND('TASTE'));
  assert.equal(match({ kind: 'enhance', task: 'review' }, 'check').match.id, 'check');
});

test('MEM-12 the budget and project folder rows use the §6.3 and §3 texts', () => {
  // 用户级 `- ` + 1598 个字符 = 400；本项目 `- ` + 398 个 = 100，合计 500 允许；402 个 = 101，合计 501 拒绝
  assert.equal(R.budgetError('strategy', 'project', ['x'.repeat(1598)], ['x'.repeat(398)], []), null);
  assert.equal(R.budgetError('strategy', 'project', ['x'.repeat(1598)], ['x'.repeat(402)], []),
    'Over the 500-token limit for STRATEGY: user 400 + this project 101 = 501. Merge or delete entries first.');
  assert.equal(F.projectOwnerError('D:\\a\\b', 'D:\\a-b'), 'This project’s memory folder belongs to D:\\a-b.');
});

test('MEM-21 the rule: enhancement writes only this project’s learned entries of its own kind', () => {
  for (const task of ['taste', 'strategy', 'review']) {
    const caller = { kind: 'enhance', task };
    assert.equal(R.writeRefusal(caller, { layer: 'project', kind: task, source: null }), null, `${task} save`);
    assert.equal(R.writeRefusal(caller, { layer: 'project', kind: task, source: 'learned' }), null, task);
    assert.equal(R.writeRefusal(caller, { layer: 'project', kind: task, source: 'user', abstract: 'Mine' }),
      USER_ENTRY('Mine'));
    for (const kind of ['fact', 'taste', 'strategy', 'review'].filter((each) => each !== task)) {
      assert.equal(R.writeRefusal(caller, { layer: 'project', kind, source: 'learned' }),
        OTHER_KIND(task.toUpperCase()));
    }
    assert.equal(R.writeRefusal(caller, { layer: 'user', kind: task, source: 'learned' }),
      OTHER_KIND(task.toUpperCase()));
    assert.equal(R.writeRefusal(caller, { layer: 'project', kind: task, source: 'agent' }), null,
      `${task}: an entry added by Mori can be changed (2026-10-26)`);
  }
});

test('MEM-38 the move rule: only entries added by Mori, in this project, with this run’s kind at one end', () => {
  const run = { kind: 'enhance', task: 'taste' };
  const move = (over) => R.writeRefusal(run, { layer: 'project', kind: 'fact', source: 'agent', abstract: 'A',
    ...over });
  assert.equal(move({ toKind: 'taste' }), null, 'into TASTE');
  assert.equal(move({ kind: 'taste', toKind: 'fact' }), null, 'out of TASTE into Facts');
  assert.equal(move({ kind: 'taste', toKind: 'review' }), null, 'out of TASTE into REVIEW');
  assert.equal(move({ toKind: 'strategy' }), OTHER_KIND('TASTE'), 'neither end is TASTE');
  assert.equal(move({ toKind: 'taste', layer: 'user' }), OTHER_KIND('TASTE'), 'the user level');
  assert.equal(move({ toKind: 'taste', source: 'user' }), USER_ENTRY('A'));
  assert.equal(move({ toKind: 'taste', source: 'learned' }),
    '“A” wasn’t added by Mori; only entries added by Mori can be moved.');
  assert.equal(move({ kind: 'taste', toKind: 'taste' }), '“A” is already in TASTE.');
  assert.equal(R.writeRefusal(run, { layer: 'project', kind: 'fact', source: 'agent' }), OTHER_KIND('TASTE'),
    'without a move a fact added by Mori is still another kind');
});

test('MEM-10 the source after a write: the page makes you said; asked makes you said; otherwise added by Mori, '
  + 'except that Mori never takes an entry you said away; enhancement keeps it (new ones are learned)', () => {
  const run = { kind: 'enhance', task: 'review' };
  assert.equal(R.sourceAfter(null, false, 'learned'), 'user');
  assert.equal(R.sourceAfter(null, false, null), 'user');
  assert.equal(R.sourceAfter(AGENT, true, null), 'user');
  assert.equal(R.sourceAfter(AGENT, false, null), 'agent');
  assert.equal(R.sourceAfter(AGENT, true, 'learned'), 'user');
  assert.equal(R.sourceAfter(AGENT, false, 'learned'), 'agent');
  assert.equal(R.sourceAfter(AGENT, false, 'agent'), 'agent');
  assert.equal(R.sourceAfter(AGENT, false, 'user'), 'user');
  assert.equal(R.sourceAfter(run, false, null), 'learned');
  assert.equal(R.sourceAfter(run, false, 'agent'), 'agent');
  assert.equal(R.sourceAfter(run, false, 'learned'), 'learned');
});

test('MEM-38 the enhancement scope adds this project’s entries added by Mori of every kind', () => {
  const all = [...ALL, C('project', 'fact', 'mori-fact', 'Conclusion first', 'agent'),
    C('user', 'taste', 'mori-user', 'User level by Mori', 'agent')];
  const scope = R.matchScope({ kind: 'enhance', task: 'taste' }, all);
  assert.deepEqual(scope.candidates.map((item) => item.id), ['short', 'mori-fact'],
    'this project’s TASTE entries and this project’s entries added by Mori');
  assert.ok(scope.others.some((item) => item.id === 'mori-user'), 'the user level stays outside');
  const found = R.matchEntry({ kind: 'enhance', task: 'taste' }, 'Conclusion first', undefined, scope.candidates,
    scope.others);
  assert.equal(found.match.id, 'mori-fact');
  const none = R.matchEntry({ kind: 'enhance', task: 'taste' }, 'zzz', undefined, scope.candidates, scope.others);
  assert.equal(none.error, 'No entry matches “zzz”. Entries you can change: project/mori-fact: Conclusion first',
    'entries the user wrote are not offered; the fact added by Mori is');
});

test('MEM-21 an enhancement run changes only this project’s learned entries of its kind; refusals write nothing',
  async (t) => {
    const { cwd, userBase, memoryRoot } = freshUserData(t, K);
    const dir = seedProject(K, cwd);
    seedKind(dir, 'strategy', [{ slug: 'l1', abstract: 'Learned plan', source: 'learned',
      created: '2026-10-20 · Enhancement' }, { slug: 'u1', abstract: 'User plan' }]);
    seedKind(dir, 'taste', [{ slug: 't1', abstract: 'Learned taste', source: 'learned' }]);
    seedKind(userBase, 'strategy', [{ slug: 'us1', abstract: 'User-level plan', source: 'learned' }]);
    const run = await K.beginRun({ cwd, task: 'strategy', day: '2026-10-23', sessions: 1, feedback: 1 });
    const enh = enhancer('strategy', run);
    const evidence = [{ at: '2026-10-23', feedback: 'a.json', quote: 'q' }];
    const added = ok(await K.save(enh, { cwd, layer: 'project', kind: 'strategy', abstract: 'New plan rule',
      detail: '', evidence }));
    assert.equal((await K.get(cwd, 'project', added.id)).entry.source, 'learned');
    const l1 = { cwd, layer: 'project', kind: 'strategy', id: 'l1' };
    ok(await K.update(enh, { target: l1, detail: 'Narrowed', note: 'Seen twice', evidence }));
    const entry = (await K.get(cwd, 'project', 'l1')).entry;
    assert.deepEqual([entry.source, entry.modified], ['learned', '2026-10-23 · Enhancement'], 'still learned');
    const before = snapshotDir(memoryRoot);
    const u1 = { cwd, layer: 'project', id: 'u1' };
    const refusals = [
      [await K.update(enh, { target: u1, detail: 'x', note: 'n', evidence }), USER_ENTRY('User plan')],
      [await K.forget(enh, { target: u1, note: 'n', evidence }), USER_ENTRY('User plan')],
      [await K.update(enh, { target: { cwd, layer: 'project', id: 't1' }, detail: 'x', note: 'n', evidence }),
        OTHER_KIND('STRATEGY')],
      [await K.forget(enh, { target: { cwd, layer: 'project', id: 't1' }, note: 'n', evidence }),
        OTHER_KIND('STRATEGY')],
      [await K.update(enh, { target: { cwd, layer: 'user', id: 'us1' }, detail: 'x', note: 'n', evidence }),
        OTHER_KIND('STRATEGY')],
      [await K.save(enh, { cwd, layer: 'user', kind: 'strategy', abstract: 'Up', detail: '', evidence }),
        OTHER_KIND('STRATEGY')],
      [await K.save(enh, { cwd, layer: 'project', kind: 'taste', abstract: 'Other', detail: '', evidence }),
        OTHER_KIND('STRATEGY')],
    ];
    for (const [result, error] of refusals) {
      assert.equal(result.error, error);
      assert.equal(result.revision, null);
    }
    assert.deepEqual(snapshotDir(memoryRoot), before, 'refused calls wrote nothing');
    ok(await K.forget(enh, { target: l1, note: 'Contradicted', evidence }));
    await K.endRun(run, { status: 'done', tokens: 0, notes: null });
    const revision = (await K.revision(cwd, 'project', run.id)).revision;
    assert.deepEqual(revision.changes.map((change) => [change.action, (change.to ?? change.from).slug]),
      [['added', added.id], ['deleted', 'l1']]);
    assert.deepEqual((await K.list(cwd, 'project', 'strategy')).entries.map((row) => [row.id, row.source]),
      [['u1', 'user'], [added.id, 'learned']]);
    ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: added.id }, detail: 'Mine', note: '' }));
    assert.equal((await K.get(cwd, 'project', added.id)).entry.source, 'user', 'the page makes it You said');
  });
