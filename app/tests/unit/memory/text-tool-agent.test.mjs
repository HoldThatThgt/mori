// memory 工具（agent 调用方）的单元测试（docs/specs/memory.md §7、MEM-10）：主 Agent 记事实（默认本项目，layer user
// 写用户级）、记你明说的规则（本项目、source user）、update 改一条并追加修订行（learned 改后为 user）、forget 删一条；
// 依据是原话加上程序记下的位置：用户会话文件与当前分支上最后一条 role: user 的条目（说这句话的那条，不是前一条），
// 分开时的立项实例 entry 为 null；同一 abstract 的事实在两层各有一条时不给 layer 报 Pass layer.，给了只改那一条；
// 结果的 details 给界面。工具按 pi 的顺序调用：prepareArguments → pi 的 validateToolArguments → execute。
// 用户会话是 pi 内存里的 SessionManager（真实的 sessionPosition），记忆目录在临时 userData 下；内容都是 synthetic。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PAGE, callTool, freshUserData, loadTextKernel, localDay, ok, snapshotDir } from './text-helpers.mjs';

const K = await loadTextKernel();
const AGENT = { kind: 'agent' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monDay = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;

/** synthetic：pi 内存里的用户会话：你、Mori、你（第二条是说“记下来”的那条），返回会话与条目 id。 */
function userSession(cwd) {
  const manager = SessionManager.inMemory(cwd);
  const say = (role, text) => manager.appendMessage({ role, content: [{ type: 'text', text }], timestamp: Date.now(),
    ...(role === 'assistant' ? { provider: 'fake', model: 'm', api: 'openai-completions', stopReason: 'stop',
      usage: {} } : {}) });
  const first = say('user', 'Look at the payment code (synthetic)');
  say('assistant', 'Done (synthetic)');
  const second = say('user', 'the intranet model is now at 10.0.0.9, note it');
  const session = { sessionManager: manager, sessionFile: join(cwd, 'synthetic-user-session.jsonl'),
    sessionName: undefined };
  return { session, first, second, manager };
}

/** @brief agent 调用方的 memory 工具（真实的 memoryTool）；位置由 sessionPosition 从用户会话读。 */
function agentTool(cwd, session, exact = true) {
  return K.tool.memoryTool({ cwd, caller: AGENT, run: null, scope: null,
    position: () => K.ext.sessionPosition(session, exact) });
}

test('MEM-10 save records a fact in this project by default, with the quote and the message that said it',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const { session, second } = userSession(cwd);
    const result = await callTool(agentTool(cwd, session), { action: 'save', kind: 'fact',
      abstract: 'The intranet model is at 10.0.0.9', quote: 'the intranet model is now at 10.0.0.9, note it' });
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Saved to Facts (this project): The intranet model is at 10.0.0.9');
    const { revision, ...place } = result.details;
    assert.deepEqual(place, { kind: 'fact', layer: 'project', entry: 'the-intranet-model-is-at-10-0-0-9',
      action: 'save' });
    const rows = (await K.memory.revisions(cwd, 'project')).revisions;
    assert.deepEqual(rows.map((row) => [row.id, row.by, row.title]), [[revision, 'Mori',
      'Mori · Added Facts: The intranet model is at 10.0.0.9']]);
    const detail = await K.memory.detailOf(cwd, 'project', place.entry);
    assert.equal(detail.source, 'user');
    assert.equal(detail.created, `${localDay(Date.now())} · Mori`);
    assert.deepEqual(detail.evidence, [{ at: localDay(Date.now()), session: session.sessionFile, entry: second,
      title: 'Look at the payment code (synthetic)', quote: 'the intranet model is now at 10.0.0.9, note it' }],
    'the entry is the user message that said it (the last on the branch), not the earlier one');
  });

test('MEM-10 the recorded message is the last user message on the current branch', async (t) => {
  const { cwd } = freshUserData(t, K);
  const { session, first, manager } = userSession(cwd);
  manager.branch(first);
  const third = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'remember: deploys on Friday' }],
    timestamp: Date.now() });
  const result = await callTool(agentTool(cwd, session), { action: 'save', kind: 'fact', abstract: 'Deploys on Friday',
    quote: 'remember: deploys on Friday' });
  const detail = await K.memory.detailOf(cwd, 'project', result.details.entry);
  assert.equal(detail.evidence[0].entry, third, 'the message on the branch the tool call is on');
  session.sessionName = 'Renamed in the sidebar (synthetic)';
  const named = await callTool(agentTool(cwd, session), { action: 'save', kind: 'fact', abstract: 'Named',
    quote: 'q' });
  const title = (await K.memory.detailOf(cwd, 'project', named.details.entry)).evidence[0].title;
  assert.equal(title, 'Renamed in the sidebar (synthetic)', "the session's name at the time of writing");
});

test('MEM-10 layer user writes a user-level fact; a rule the user states is saved to this project as you said',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const { session } = userSession(cwd);
    const tool = agentTool(cwd, session);
    const fact = await callTool(tool, { action: 'save', kind: 'fact', layer: 'user', abstract: 'The user is in UTC+8',
      quote: 'I am in UTC+8' });
    assert.equal(fact.text, 'Saved to Facts (user level): The user is in UTC+8');
    assert.equal(fact.details.layer, 'user');
    assert.equal((await K.memory.detailOf(null, 'user', fact.details.entry)).source, 'user');
    for (const [kind, label] of [['taste', 'TASTE'], ['strategy', 'STRATEGY'], ['review', 'REVIEW']]) {
      const rule = await callTool(tool, { action: 'save', kind, abstract: `Rule for ${kind} (synthetic)`,
        quote: 'from now on, start every answer with the conclusion' });
      assert.equal(rule.text, `Saved to ${label} (this project): Rule for ${kind} (synthetic)`);
      const detail = await K.memory.detailOf(cwd, 'project', rule.details.entry);
      assert.deepEqual([detail.kind, detail.layer, detail.source], [kind, 'project', 'user']);
    }
  });

test('MEM-10 update changes one entry, appends evidence and a Revisions line; a learned entry becomes you said',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const run = await K.memory.beginRun({ cwd, task: 'strategy', day: '2026-10-22', sessions: 1, feedback: 0 });
    const learned = ok(await K.memory.save({ by: 'Enhancement', caller: { kind: 'enhance', task: 'strategy' }, run },
      { cwd, layer: 'project', kind: 'strategy', abstract: 'Plan before big changes', detail: 'Old detail.',
        evidence: [{ at: '2026-10-22', feedback: 'f.json' }] }));
    await K.memory.endRun(run, { status: 'done', tokens: 0, notes: null });
    assert.equal((await K.memory.detailOf(cwd, 'project', learned.id)).source, 'learned');
    const { session, second } = userSession(cwd);
    const result = await callTool(agentTool(cwd, session), { action: 'update', entry: '  Plan before   big changes ',
      abstract: 'Plan before changing more than three modules', detail: 'New detail.', note: 'the user narrowed it',
      quote: 'only for more than three modules' });
    assert.equal(result.text, 'Updated STRATEGY (this project): Plan before changing more than three modules');
    assert.deepEqual({ ...result.details, revision: undefined }, { revision: undefined, kind: 'strategy',
      layer: 'project', entry: learned.id, action: 'update' });
    const detail = await K.memory.detailOf(cwd, 'project', learned.id);
    assert.equal(detail.source, 'user', 'changed by the user: you said');
    assert.equal(detail.abstract, 'Plan before changing more than three modules');
    assert.equal(detail.details, 'New detail.');
    assert.equal(detail.history.at(-1), `${monDay(localDay(Date.now()))} · Mori: the user narrowed it`);
    assert.equal(detail.evidence.length, 2, 'evidence is appended');
    assert.equal(detail.evidence[1].entry, second);
  });

test('MEM-10 forget deletes one entry; the result points at the revision', async (t) => {
  const { cwd } = freshUserData(t, K);
  const { session } = userSession(cwd);
  const tool = agentTool(cwd, session);
  const saved = await callTool(tool, { action: 'save', kind: 'review', abstract: 'Run the tests before done',
    quote: 'always run the tests' });
  const gone = await callTool(tool, { action: 'forget', entry: saved.details.entry,
    note: 'the user changed their mind' });
  assert.equal(gone.text, 'Deleted from REVIEW (this project): Run the tests before done');
  assert.equal(gone.details.action, 'forget');
  assert.equal(await K.memory.detailOf(cwd, 'project', saved.details.entry), null);
  const revision = (await K.memory.revision(cwd, 'project', gone.details.revision)).revision;
  assert.equal(revision.title, 'Mori · Deleted REVIEW: Run the tests before done');
  assert.equal(revision.changes[0].note, 'the user changed their mind');
});

test('MEM-10 a split create instance records the user session file with entry null', async (t) => {
  const { cwd } = freshUserData(t, K);
  const { session } = userSession(cwd);
  const result = await callTool(agentTool(cwd, session, false), { action: 'save', kind: 'fact',
    abstract: 'Staging is on port 8443', quote: 'staging is on 8443' });
  const detail = await K.memory.detailOf(cwd, 'project', result.details.entry);
  assert.deepEqual(detail.evidence[0], { at: localDay(Date.now()), session: session.sessionFile, entry: null,
    title: 'Look at the payment code (synthetic)', quote: 'staging is on 8443' });
});

test('MEM-10 the same fact in both layers: update without layer asks for it; with layer only that one changes',
  async (t) => {
    const { cwd, memoryRoot } = freshUserData(t, K);
    const user = ok(await K.memory.save(PAGE, { cwd, layer: 'user', kind: 'fact', abstract: 'Node 22 is required',
      detail: '', evidence: [] }));
    const project = ok(await K.memory.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'Node 22 is required',
      detail: '', evidence: [] }));
    const { session } = userSession(cwd);
    const tool = agentTool(cwd, session);
    const before = snapshotDir(memoryRoot);
    const both = await callTool(tool, { action: 'update', entry: 'Node 22 is required', abstract: 'Node 24 is required',
      note: 'upgraded', quote: 'we are on node 24 now' });
    assert.equal(both.isError, true);
    assert.equal(both.text.split('\n')[0], `“Node 22 is required” matches entries in both layers (user: ${user.id}, `
      + `this project: ${project.id}). Pass layer.`);
    assert.deepEqual(snapshotDir(memoryRoot), before, 'neither entry changed');
    const one = await callTool(tool, { action: 'update', entry: 'Node 22 is required', layer: 'user',
      abstract: 'Node 24 is required', note: 'upgraded', quote: 'we are on node 24 now' });
    assert.equal(one.text, 'Updated Facts (user level): Node 24 is required');
    assert.equal((await K.memory.detailOf(null, 'user', user.id)).abstract, 'Node 24 is required');
    assert.equal((await K.memory.detailOf(cwd, 'project', project.id)).abstract, 'Node 22 is required');
  });

test('MEM-10 the tool is named memory, takes a JSON Schema and normalizes key names like the TaskBoard tools',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const { session } = userSession(cwd);
    const tool = agentTool(cwd, session);
    assert.equal(tool.name, 'memory');
    assert.deepEqual(tool.parameters.required, ['action']);
    const result = await callTool(tool, { Action: 'save', KIND: 'fact', Abstract: 'Key names', quote_: 'q',
      extra: 'dropped' });
    assert.equal(result.text, 'Saved to Facts (this project): Key names');
  });
