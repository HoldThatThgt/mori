// 进程桥（docs/specs/memory.md §8，验收 MEM-30 的单元层）：memory.*、enhance.* 经 protocol.ts 的 CommandSchema 的参数校验，
// 命令处理（memoryCommands.ts）的结果形状；文字字段只是 z.string()、长度由后台进程按 §10.1 的句子查；
// `This entry no longer exists.`；两个全局事件里 mori.memory_changed 的形状（每次写入一次，beginRun、endRun 各一次）；
// §8 列出的命令的动作记录文字（actionLog.ts 的 describeCommand）。命令与工作目录为 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { PAGE, cjk, freshUserData, loadMemoryKernel, ok, readOrNull, snapshotDir } from './core-helpers.mjs';

const P = await loadKernelModule('src/shared/protocol.ts');
const A = await loadKernelModule('src/renderer/src/state/actionLog.ts');
const K = await loadMemoryKernel();

const SHOP = 'D:\\shop';
const REV = '20261024-040312-q7wk';

/** synthetic：每个命令合乎 §8 的写法 */
const VALID = [
  { type: 'memory.list', cwd: SHOP, layer: 'project', kind: 'taste' },
  { type: 'memory.list', cwd: null, layer: 'user', kind: 'fact' },
  { type: 'memory.get', cwd: null, layer: 'user', id: 'lead-with-the-conclusion' },
  { type: 'memory.save', cwd: SHOP, layer: 'project', kind: 'review', abstract: 'Run it', detail: '' },
  { type: 'memory.save', cwd: null, layer: 'user', kind: 'strategy', id: 'plan', abstract: 'Plan', detail: 'Why' },
  { type: 'memory.save', cwd: SHOP, layer: 'project', kind: 'fact', abstract: '', detail: 'x'.repeat(5000) },
  { type: 'memory.delete', cwd: SHOP, layer: 'project', id: 'plan' },
  { type: 'memory.move', cwd: SHOP, from: 'project', id: 'plan' },
  { type: 'memory.move', cwd: SHOP, from: 'user', id: 'plan' },
  { type: 'memory.revisions', cwd: null, layer: 'user' },
  { type: 'memory.revisions', cwd: SHOP, layer: 'project', id: REV },
  { type: 'memory.rollback', cwd: SHOP, layer: 'project', id: REV },
  { type: 'enhance.get', cwd: SHOP },
  { type: 'enhance.set', cwd: SHOP },
  { type: 'enhance.set', cwd: SHOP, enabled: false },
  { type: 'enhance.set', cwd: SHOP, pick: 'deepseek/deepseek-flash', thinking: 'medium', team: true, time: '04:00' },
  { type: 'enhance.set', cwd: SHOP, pick: 'cloud', thinking: 'max', time: '23:59' },
  { type: 'enhance.run', cwd: SHOP },
];

/** synthetic：不合 §8 的命令，以及为什么 */
const INVALID = [
  [{ type: 'memory.list', cwd: SHOP, layer: 'team', kind: 'taste' }, 'unknown layer'],
  [{ type: 'memory.list', cwd: SHOP, layer: 'project', kind: 'facts' }, 'the kind is fact'],
  [{ type: 'memory.list', cwd: '', layer: 'user', kind: 'fact' }, 'an empty cwd (null means the user level only)'],
  [{ type: 'memory.list', layer: 'user', kind: 'fact' }, 'cwd is required, null or a folder'],
  [{ type: 'memory.get', cwd: null, layer: 'user', id: '' }, 'an empty id'],
  [{ type: 'memory.get', cwd: null, layer: 'user' }, 'no id'],
  [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', detail: '' }, 'no abstract'],
  [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', abstract: 'A' }, 'no detail'],
  [{ type: 'memory.save', cwd: null, layer: 'user', abstract: 'A', detail: '' }, 'no kind'],
  [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', abstract: 3, detail: '' }, 'abstract is text'],
  [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', id: '', abstract: 'A', detail: '' }, 'empty id'],
  [{ type: 'memory.delete', cwd: null, layer: 'user' }, 'no id'],
  [{ type: 'memory.move', cwd: SHOP, from: 'both', id: 'a' }, 'from is a layer'],
  [{ type: 'memory.move', cwd: SHOP, id: 'a' }, 'no from'],
  [{ type: 'memory.revisions', cwd: null }, 'no layer'],
  [{ type: 'memory.rollback', cwd: null, layer: 'user' }, 'no id'],
  [{ type: 'enhance.get', cwd: null }, 'enhancement belongs to a project'],
  [{ type: 'enhance.get', cwd: '' }, 'an empty cwd'],
  [{ type: 'enhance.set', cwd: SHOP, time: '24:00' }, 'not a time'],
  [{ type: 'enhance.set', cwd: SHOP, time: '4:00' }, 'HH:MM'],
  [{ type: 'enhance.set', cwd: SHOP, time: '04:60' }, 'not a time'],
  [{ type: 'enhance.set', cwd: SHOP, time: '' }, 'an empty time'],
  [{ type: 'enhance.set', cwd: SHOP, enabled: 'yes' }, 'enabled is a boolean'],
  [{ type: 'enhance.set', cwd: SHOP, thinking: 'extreme' }, 'not one of pi’s seven levels'],
  [{ type: 'enhance.set', cwd: SHOP, team: 1 }, 'team is a boolean'],
  [{ type: 'enhance.set', cwd: SHOP, pick: 'Not A Range' }, 'not a model range'],
  [{ type: 'enhance.run', cwd: null }, 'enhancement belongs to a project'],
  [{ type: 'memory.forget', cwd: null, layer: 'user', id: 'a' }, 'the command is memory.delete'],
];

test('MEM-30 memory.* and enhance.* commands pass the bridge schema', () => {
  for (const command of VALID) {
    const parsed = P.CommandSchema.safeParse(command);
    assert.equal(parsed.success, true, `${JSON.stringify(command)}: ${parsed.error?.message ?? ''}`);
    assert.deepEqual(parsed.data, command);
  }
});

test('MEM-30 malformed memory.* and enhance.* commands are refused by the bridge schema', () => {
  for (const [command, why] of INVALID) {
    assert.equal(P.CommandSchema.safeParse(command).success, false, `${why}: ${JSON.stringify(command)}`);
  }
});

/** @brief 校验后交给命令处理（同 commands.ts）。 */
async function send(command) {
  const parsed = P.CommandSchema.parse(command);
  return K.handleMemoryCommand(parsed);
}

/** @brief 对象的键，排好序。 */
const keys = (value) => Object.keys(value).sort();
const ROW_KEYS = ['by', 'counts', 'id', 'kinds', 'layers', 'rollbackOf', 'status', 'time', 'title'];
const COUNT_KEYS = ['added', 'changed', 'deleted', 'moved'];
const ENTRY_ROW_KEYS = ['abstract', 'created', 'id', 'modified', 'source'];

test('MEM-30 the results of memory.* commands have the §8 shapes', async (t) => {
  const { cwd } = freshUserData(t, K);
  const saved = await send({ type: 'memory.save', cwd, layer: 'project', kind: 'taste',
    abstract: 'Lead with the conclusion', detail: 'Then details.' });
  assert.deepEqual(keys(saved), ['error', 'id', 'revision']);
  assert.equal(saved.error, null);
  assert.equal(saved.id, 'lead-with-the-conclusion');
  const listed = await send({ type: 'memory.list', cwd, layer: 'project', kind: 'taste' });
  assert.deepEqual(keys(listed), ['broken', 'entries', 'error', 'last', 'usage']);
  assert.deepEqual(keys(listed.usage), ['limit', 'project', 'used', 'user']);
  assert.deepEqual(keys(listed.entries[0]), ENTRY_ROW_KEYS);
  assert.deepEqual(keys(listed.last), ROW_KEYS);
  assert.deepEqual(keys(listed.last.counts), COUNT_KEYS);
  const got = await send({ type: 'memory.get', cwd, layer: 'project', id: saved.id });
  assert.deepEqual(keys(got), ['backlinks', 'entry', 'error', 'revisions']);
  assert.deepEqual(keys(got.entry),
    [...ENTRY_ROW_KEYS, 'details', 'evidence', 'file', 'history', 'kind', 'layer'].sort());
  assert.deepEqual(got.revisions.map(keys), [ROW_KEYS]);
  assert.deepEqual(await send({ type: 'memory.get', cwd, layer: 'project', id: 'nope' }),
    { entry: null, revisions: [], backlinks: [], error: null });
  const edited = await send({ type: 'memory.save', cwd, layer: 'project', kind: 'taste', id: saved.id,
    abstract: 'Lead with the answer', detail: 'Then details.' });
  assert.deepEqual([edited.error, edited.id], [null, saved.id]);
  const history = (await send({ type: 'memory.get', cwd, layer: 'project', id: saved.id })).revisions;
  assert.deepEqual(history.map((row) => row.id), [edited.revision, saved.revision],
    'revisions that changed it, newest first');
  const list = await send({ type: 'memory.revisions', cwd, layer: 'project' });
  assert.deepEqual(keys(list), ['error', 'revisions']);
  assert.deepEqual(list.revisions.map((row) => row.id), [edited.revision, saved.revision]);
  const one = await send({ type: 'memory.revisions', cwd, layer: 'project', id: edited.revision });
  assert.deepEqual(keys(one), ['error', 'revision']);
  assert.deepEqual(keys(one.revision), [...ROW_KEYS, 'changes', 'cwd', 'notes', 'run'].sort());
  assert.deepEqual(keys(one.revision.changes[0]), ['action', 'after', 'before', 'from', 'kind', 'note', 'to']);
  assert.deepEqual(await send({ type: 'memory.revisions', cwd, layer: 'project', id: REV }),
    { revision: null, error: null });
  const moved = await send({ type: 'memory.move', cwd, from: 'project', id: saved.id });
  assert.deepEqual([keys(moved), moved.error, moved.id], [['error', 'id', 'revision'], null, saved.id]);
  const back = await send({ type: 'memory.rollback', cwd, layer: 'user', id: moved.revision });
  assert.equal(back.error, null);
  assert.equal(typeof back.revision, 'string');
  const removed = await send({ type: 'memory.delete', cwd, layer: 'project', id: saved.id });
  assert.equal(removed.error, null);
  assert.equal(typeof removed.revision, 'string');
});

test('MEM-30 text fields are plain strings on the bridge; the kernel checks them with the §10.1 sentences',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const base = { type: 'memory.save', cwd, layer: 'project', kind: 'taste', detail: '' };
    const cases = [
      [{ ...base, abstract: '   ' }, 'Abstract is required.'],
      [{ ...base, abstract: 'x'.repeat(201) }, 'Abstract must be at most 200 characters.'],
      [{ ...base, abstract: 'A', detail: 'x'.repeat(4001) }, 'Details must be at most 4,000 characters.'],
    ];
    for (const [command, error] of cases) {
      assert.equal(P.CommandSchema.safeParse(command).success, true);
      const result = await send(command);
      assert.deepEqual([result.error, result.revision], [error, null]);
    }
    assert.deepEqual(snapshotDir(memoryRoot), {}, 'nothing was written');
    ok(await send({ ...base, abstract: cjk(200), detail: 'x'.repeat(4000) }));
    const saved = ok(await send({ ...base, abstract: 'Short' }));
    const edit = await send({ ...base, id: saved.id, abstract: 'x'.repeat(201) });
    assert.equal(edit.error, 'Abstract must be at most 200 characters.', 'edits are checked the same way');
  });

test('MEM-30 an entry that is gone reads “This entry no longer exists.”', async (t) => {
  const { cwd } = freshUserData(t, K);
  const gone = 'This entry no longer exists.';
  const results = [
    await send({ type: 'memory.save', cwd, layer: 'project', kind: 'fact', id: 'nope', abstract: 'A', detail: '' }),
    await send({ type: 'memory.delete', cwd, layer: 'project', id: 'nope' }),
    await send({ type: 'memory.move', cwd, from: 'project', id: 'nope' }),
    await send({ type: 'memory.move', cwd, from: 'user', id: 'nope' }),
    await send({ type: 'memory.delete', cwd: null, layer: 'user', id: '..' }),
  ];
  for (const result of results) assert.deepEqual([result.error, result.revision], [gone, null]);
  const userEntry = ok(await send({ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', abstract: 'U',
    detail: '' }));
  const homeless = await send({ type: 'memory.move', cwd: null, from: 'user', id: userEntry.id });
  assert.equal(typeof homeless.error, 'string', 'moving to this project needs a cwd');
  assert.equal(homeless.revision, null);
  assert.deepEqual((await send({ type: 'memory.list', cwd: null, layer: 'user', kind: 'fact' })).entries
    .map((row) => row.id), [userEntry.id]);
  const saved = ok(await send({ type: 'memory.save', cwd, layer: 'project', kind: 'fact', abstract: 'A', detail: '' }));
  ok(await send({ type: 'memory.delete', cwd, layer: 'project', id: saved.id }));
  assert.equal((await send({ type: 'memory.delete', cwd, layer: 'project', id: saved.id })).error, gone);
  assert.equal(K.ENTRY_GONE, gone);
});

test('MEM-30 the results of enhance.* commands have the §8 shapes', async (t) => {
  const { userData, cwd } = freshUserData(t, K);
  await K.startEnhance({ userData, emitGlobal: () => undefined,
    clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined } });
  const info = await send({ type: 'enhance.get', cwd });
  assert.deepEqual(keys(info), ['cwd', 'effortPicks', 'enabled', 'error', 'last', 'next', 'notice', 'pick', 'queued',
    'running', 'since', 'team', 'thinking', 'time']);
  assert.equal(typeof info.effortPicks, 'object', 'effortPicks is a map from model range to Supports thinking');
  assert.deepEqual(keys(info.last), ['review', 'strategy', 'taste']);
  assert.deepEqual([info.cwd, info.enabled, info.error, info.running, info.queued, info.next, info.notice],
    [cwd, false, null, null, 0, null, null], 'no enhance.json: off, never run');
  assert.deepEqual([info.time, info.team, info.since], ['04:00', false, null]);
  const set = await send({ type: 'enhance.set', cwd, time: '05:30', team: true });
  assert.deepEqual(keys(set), ['error', 'info']);
  assert.equal(set.error, null);
  assert.deepEqual([set.info.time, set.info.team, set.info.enabled], ['05:30', true, false]);
  const settings = JSON.parse(readOrNull(join(K.projectDir(cwd).dir, 'enhance.json')));
  assert.deepEqual([settings.time, settings.team, settings.enabled], ['05:30', true, false]);
  const run = await send({ type: 'enhance.run', cwd });
  assert.deepEqual(keys(run), ['error']);
  assert.equal(typeof run.error, 'string', 'enhancement is off, so nothing is queued');
});

test('MEM-30 every write sends one mori.memory_changed; beginRun and endRun send one each', async (t) => {
  const { cwd, events } = freshUserData(t, K);
  const changed = (over) => ({ type: 'mori.memory_changed', cwd, layers: ['project'], kinds: ['review'], ...over });
  const run = await K.beginRun({ cwd, task: 'review', day: '2026-10-23', sessions: 0, feedback: 0 });
  assert.deepEqual(events, [changed({ revision: run.id })]);
  await K.endRun(run, { status: 'done', tokens: 0, notes: 'Nothing to change.' });
  assert.deepEqual(events, [changed({ revision: run.id }), changed({ revision: run.id })], 'a run without changes too');
  events.splice(0);
  const saved = ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'fact', abstract: 'A', detail: '',
    evidence: [] }));
  assert.deepEqual(events, [changed({ cwd: null, layers: ['user'], kinds: ['fact'], revision: saved.revision })]);
  const moved = ok(await K.move(PAGE, cwd, 'user', saved.id));
  assert.deepEqual(events.at(-1), changed({ layers: ['user', 'project'], kinds: ['fact'], revision: moved.revision }));
  const count = events.length;
  assert.notEqual((await K.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: '', detail: '',
    evidence: [] })).error, null);
  assert.equal(events.length, count, 'a refused write sends nothing');
});

test('MEM-30 the action log texts of the §8 commands; read-only queries are not logged', () => {
  const cases = [
    [{ type: 'memory.save', cwd: SHOP, layer: 'project', kind: 'taste', abstract: 'A', detail: '' },
      'Save memory entry'],
    [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', abstract: 'A', detail: '' }, 'Save memory entry'],
    [{ type: 'memory.save', cwd: SHOP, layer: 'project', kind: 'taste', id: 'a', abstract: 'A', detail: '' },
      'Edit memory entry'],
    [{ type: 'memory.save', cwd: null, layer: 'user', kind: 'fact', id: 'a', abstract: 'A', detail: '' },
      'Edit memory entry'],
    [{ type: 'memory.delete', cwd: SHOP, layer: 'project', id: 'a' }, 'Delete memory entry'],
    [{ type: 'memory.move', cwd: SHOP, from: 'project', id: 'a' }, 'Move to user level'],
    [{ type: 'memory.move', cwd: SHOP, from: 'user', id: 'a' }, 'Move to this project'],
    [{ type: 'memory.rollback', cwd: SHOP, layer: 'project', id: REV }, 'Roll back revision'],
    [{ type: 'enhance.set', cwd: SHOP, enabled: true }, 'Turn on enhancement D:\\shop'],
    [{ type: 'enhance.set', cwd: SHOP, enabled: false }, 'Turn off enhancement D:\\shop'],
    [{ type: 'enhance.set', cwd: SHOP, pick: 'cloud', thinking: 'high', team: false, time: '04:00' },
      'Save enhancement settings D:\\shop'],
    // 设置对话框的 Model range 没有选中项时不带 pick（§10.4），仍是设置对话框的 Save
    [{ type: 'enhance.set', cwd: SHOP, thinking: 'medium', team: true, time: '05:30' },
      'Save enhancement settings D:\\shop'],
    // 不是只带 enabled 的，都按设置对话框的 Save 记
    [{ type: 'enhance.set', cwd: SHOP, enabled: true, time: '05:30' }, 'Save enhancement settings D:\\shop'],
    [{ type: 'enhance.run', cwd: SHOP }, 'Run enhancement now D:\\shop'],
    [{ type: 'memory.list', cwd: SHOP, layer: 'project', kind: 'taste' }, null],
    [{ type: 'memory.get', cwd: SHOP, layer: 'project', id: 'a' }, null],
    [{ type: 'memory.revisions', cwd: SHOP, layer: 'project' }, null],
    [{ type: 'memory.revisions', cwd: SHOP, layer: 'project', id: REV }, null],
    [{ type: 'memory.revisions', cwd: null, layer: 'user' }, null],
    [{ type: 'memory.list', cwd: null, layer: 'user', kind: 'fact' }, null],
    [{ type: 'enhance.get', cwd: SHOP }, null],
  ];
  for (const [command, text] of cases) {
    assert.equal(A.describeCommand(P.CommandSchema.parse(command)), text, JSON.stringify(command));
  }
});
