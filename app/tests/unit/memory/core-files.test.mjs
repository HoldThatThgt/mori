// kernel/memoryFiles.ts 与 kernel/memory.ts 的文件格式（docs/specs/memory.md §3、§6.2、§6.8，验收 MEM-06 的单元层）：
// 索引、detail、修订按 §3 写出并读回；英文的小标题与依据行；[[slug]]；`]` 与 `\` 的转义；手改的索引与 detail 不一致时
// 以 detail 为准；读不出来的文件列为一行原因；原子写；project.json 与编码冲突（记忆页的命令、memory 工具、enhance.* 都拒绝，
// 新会话的快照里没有另一个项目的条目）。条目、索引与修订文件由测试按规格的示例手写（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';
import {
  MORI, PAGE, detailText, freshUserData, loadMemoryKernel, monDay, ok, readOrNull, revisionIds, seedKind, seedProject,
  snapshotDir, todayKey,
} from './core-helpers.mjs';

const F = await loadKernelModule('src/kernel/memoryFiles.ts');
const R = await loadKernelModule('src/kernel/memoryRules.ts');
const S = await loadKernelModule('src/shared/memory.ts');
const K = await loadMemoryKernel();

// ---- 规格 §3.2、§3.3 的示例（逐字，synthetic） ----

const SPEC_EVIDENCE = [
  { at: '2026-10-22', session: 'C:\\Users\\me\\AppData\\Roaming\\Mori\\pi\\sessions\\--D--shop--\\…jsonl',
    entry: 'a1b2c3d4', title: 'Payment refactor', quote: '…' },
  { at: '2026-10-24', feedback: '2026-10-24-101500.json', quote: 'Tell me how you plan to change it first' },
];
const SPEC_DETAILS = 'Before a change that touches several modules, list in three to five lines which places change '
  + 'and in what order, and wait for a yes.\n\nDoesn’t apply when the user already gave detailed steps.';
const SPEC_HISTORY = 'Oct 25 · Enhancement: “multiple modules” narrowed to “more than three”: the Oct 24 session '
  + 'changed two modules directly without trouble.';
/** 规格 §3.2 的 detail 示例 */
const SPEC_DETAIL = [
  '---', 'kind: strategy', 'abstract: "Plan before changing more than three modules"', 'source: learned',
  'created: "2026-10-23 · Enhancement"', 'modified: "2026-10-25 · Enhancement"',
  `evidence: ${JSON.stringify(SPEC_EVIDENCE)}`, '---',
  '## Evidence', '- Oct 22 · Session “Payment refactor”: “…”',
  '- Oct 24 · Feedback: “Tell me how you plan to change it first”', '',
  '## Details', SPEC_DETAILS, '',
  '## Revisions', `- ${SPEC_HISTORY}`, '',
].join('\n');
const SPEC_SLUG = 'plan-before-changing-more-than-three-modules';

test('MEM-06 the §3.2 example detail parses and renders back byte for byte', () => {
  assert.ok(SPEC_DETAIL.includes('"session":"C:\\\\Users\\\\me\\\\AppData'), 'evidence is one line of JSON');
  const detail = F.parseDetail(SPEC_DETAIL, parseFrontmatter);
  assert.equal(detail.kind, 'strategy');
  assert.equal(detail.abstract, 'Plan before changing more than three modules');
  assert.equal(detail.source, 'learned');
  assert.equal(detail.created, '2026-10-23 · Enhancement');
  assert.equal(detail.modified, '2026-10-25 · Enhancement');
  assert.deepEqual(detail.evidence, SPEC_EVIDENCE);
  assert.equal(detail.details, SPEC_DETAILS);
  assert.deepEqual(detail.history, [SPEC_HISTORY]);
  assert.equal(F.renderDetail(detail), SPEC_DETAIL);
});

test('MEM-06 evidence lines are English, for sessions and feedback, with and without the quote', () => {
  const session = { at: '2026-10-22', session: 'C:\\s.jsonl', entry: 'e1', title: 'Payment refactor' };
  assert.equal(S.evidenceLine({ ...session, quote: 'Keep it short' }),
    'Oct 22 · Session “Payment refactor”: “Keep it short”');
  assert.equal(S.evidenceLine(session), 'Oct 22 · Session “Payment refactor”');
  assert.equal(S.evidenceLine({ at: '2026-10-24', feedback: 'f.json' }), 'Oct 24 · Feedback');
  assert.equal(S.evidenceLine({ at: '2026-10-24', feedback: 'f.json', quote: 'q' }), 'Oct 24 · Feedback: “q”');
  const text = F.renderDetail({ kind: 'fact', abstract: 'A', source: 'user', created: '2026-10-22 · Mori',
    modified: '2026-10-22 · Mori', evidence: [session, { at: '2026-10-24', feedback: 'f.json' }], details: '',
    history: [] });
  const body = text.slice(text.indexOf('\n---\n') + 5);
  assert.equal(body, '## Evidence\n- Oct 22 · Session “Payment refactor”\n- Oct 24 · Feedback\n\n## Details\n\n'
    + '## Revisions\n');
});

test('MEM-06 index files: one title per kind, one line per entry, `]` and `\\` escaped and read back', () => {
  const items = [{ abstract: 'Plan before changing more than three modules', slug: SPEC_SLUG },
    { abstract: '一行配置、一个错别字，直接改，不写计划', slug: 'strategy-20261023-k3f9' }];
  const spec = ['# STRATEGY', `- [${items[0].abstract}](entries/${SPEC_SLUG}.md)`,
    '- [一行配置、一个错别字，直接改，不写计划](entries/strategy-20261023-k3f9.md)', ''].join('\n');
  assert.equal(F.renderIndex('strategy', items), spec);
  assert.deepEqual(F.parseIndex(spec), items);
  const titles = { fact: '# Facts\n', taste: '# TASTE\n', strategy: '# STRATEGY\n', review: '# REVIEW\n' };
  for (const [kind, title] of Object.entries(titles)) assert.equal(F.renderIndex(kind, []), title, kind);
  const tricky = 'Keep a[0] ] here and C:\\tmp\\x';
  const line = F.renderIndex('taste', [{ abstract: tricky, slug: 't' }]).split('\n')[1];
  assert.equal(line, '- [Keep a[0\\] \\] here and C:\\\\tmp\\\\x](entries/t.md)');
  assert.deepEqual(F.parseIndex(`# TASTE\n${line}\n`), [{ abstract: tricky, slug: 't' }]);
  const loose = '# TASTE\nSome note\n- not a link\n* [star](entries/star.md)\n- [ok](entries/ok.md)\n';
  assert.deepEqual(F.parseIndex(loose), [{ abstract: 'ok', slug: 'ok' }], 'other lines are ignored');
});

test('MEM-06 Details run from the first ## Details to the last ## Revisions, keeping your own ## headings', () => {
  const details = 'Intro line.\n\n## Your own heading\nKept text.\n## Another\nAlso kept.';
  const text = detailText({ kind: 'taste', abstract: 'A', details,
    history: ['Oct 22 · You: Edited on the Memory page'] });
  const detail = F.parseDetail(text, parseFrontmatter);
  assert.equal(detail.details, details);
  assert.deepEqual(detail.history, ['Oct 22 · You: Edited on the Memory page']);
});

test('MEM-06 a detail that can’t be read gives a reason', () => {
  const cases = [
    'kind: taste\nabstract: "A"\nsource: user\n',
    '---\nabstract: "A"\nsource: user\n---\n',
    '---\nkind: taste\nsource: user\n---\n',
    '---\nkind: tastes\nabstract: "A"\nsource: user\n---\n',
    '---\nkind: taste\nabstract: "A"\nsource: someone\n---\n',
  ];
  for (const text of cases) {
    assert.throws(() => F.parseDetail(text, parseFrontmatter), (error) => error.message.length > 0, text);
  }
});

/** synthetic：规格 §3.3 示例的修订（after 是 §3.2 的 detail） */
function specRevision() {
  return {
    id: '20261024-040312-q7wk', time: '2026-10-24T04:03:12.000+08:00', by: 'Enhancement',
    title: 'STRATEGY enhancement · Oct 23', status: 'done', layers: ['project'], kinds: ['strategy'],
    counts: { added: 1, changed: 0, deleted: 0, moved: 0 }, rollbackOf: null, cwd: 'D:\\shop',
    run: { task: 'strategy', day: '2026-10-23', tokens: 38214, sessions: 2, feedback: 1 },
    changes: [{ action: 'added', kind: 'strategy', from: null, to: { layer: 'project', slug: SPEC_SLUG },
      evidence: 'Oct 22 · Session “Payment refactor”: “…”', before: '', after: SPEC_DETAIL }],
    notes: 'No conflicts.',
  };
}

test('MEM-06 a revision file follows the §3.3 layout and reads back', () => {
  const text = F.renderRevision(specRevision());
  const expected = [
    '---', 'id: "20261024-040312-q7wk"', 'time: "2026-10-24T04:03:12.000+08:00"', 'by: "Enhancement"',
    'title: "STRATEGY enhancement · Oct 23"', 'status: "done"', 'layers: ["project"]', 'kinds: ["strategy"]',
    'counts: {"added":1,"changed":0,"deleted":0,"moved":0}', 'cwd: "D:\\\\shop"',
    'run: {"task":"strategy","day":"2026-10-23","tokens":38214,"sessions":2,"feedback":1}', 'rollbackOf: null', '---',
    `## Added · STRATEGY · ${SPEC_SLUG}`, 'Evidence: Oct 22 · Session “Payment refactor”: “…”', '',
    '~~~~before', '~~~~', '~~~~after', `${SPEC_DETAIL}`, '~~~~', '', '## Notes', 'No conflicts.', '',
  ].join('\n');
  assert.equal(text, expected);
  assert.deepEqual(F.parseRevision(text, parseFrontmatter), specRevision());
  const row = F.parseRevisionRow(text, parseFrontmatter);
  assert.deepEqual(Object.keys(row).sort(), ['by', 'counts', 'id', 'kinds', 'layers', 'rollbackOf', 'status', 'time',
    'title']);
});

test('MEM-06 a move section names both slugs and reads back as from one layer to the other', () => {
  const before = detailText({ kind: 'taste', abstract: 'A', source: 'learned' });
  const after = detailText({ kind: 'taste', abstract: 'A', history: ['Oct 22 · You: Moved to user level'] });
  const revision = { ...specRevision(), by: 'You', title: 'You · Moved to user level: A', layers: ['user', 'project'],
    kinds: ['taste'], counts: { added: 0, changed: 0, deleted: 0, moved: 1 }, run: null, notes: null,
    changes: [{ action: 'moved', kind: 'taste', from: { layer: 'project', slug: 'a' },
      to: { layer: 'user', slug: 'a-2' },
      note: 'Moved to user level', before, after }] };
  const text = F.renderRevision(revision);
  assert.ok(text.includes('\n## Moved to user level · TASTE · a → a-2\nNote: Moved to user level\n\n~~~~before\n'));
  assert.deepEqual(F.parseRevision(text, parseFrontmatter), revision);
  const back = { ...revision, changes: [{ ...revision.changes[0], from: { layer: 'user', slug: 'a' },
    to: { layer: 'project', slug: 'a' }, note: 'Moved to this project' }] };
  assert.ok(F.renderRevision(back).includes('\n## Moved to this project · TASTE · a → a\n'));
  assert.deepEqual(F.parseRevision(F.renderRevision(back), parseFrontmatter).changes, back.changes);
});

test('MEM-38 a section that moved an entry to another kind is `Changed · <from> → <to>` and reads back', () => {
  const before = detailText({ kind: 'fact', abstract: 'A', source: 'agent' });
  const after = detailText({ kind: 'taste', abstract: 'A', source: 'agent',
    history: ['Oct 22 · Enhancement: Moved from Facts to TASTE: how to talk'] });
  const revision = { ...specRevision(), kinds: ['fact', 'taste'], counts: { added: 0, changed: 1, deleted: 0, moved: 0 },
    changes: [{ action: 'changed', kind: 'taste', fromKind: 'fact', from: { layer: 'project', slug: 'a' },
      to: { layer: 'project', slug: 'a' }, note: 'Moved from Facts to TASTE: how to talk', before, after }] };
  const text = F.renderRevision(revision);
  assert.ok(text.includes('\n## Changed · Facts → TASTE · a\nNote: Moved from Facts to TASTE: how to talk\n\n'));
  assert.deepEqual(F.parseRevision(text, parseFrontmatter), revision);
  assert.equal(S.changeKindText(revision.changes[0]), 'Facts → TASTE');
  assert.equal(S.changeKindText({ kind: 'review' }), 'REVIEW');
  for (const head of ['## Added · Facts → TASTE · a', '## Changed · Facts → TASTES · a', '## Changed · Rules → TASTE · a',
    '## Moved to user level · Facts → TASTE · a → b']) {
    const bad = text.replace('## Changed · Facts → TASTE · a', head);
    assert.throws(() => F.parseRevision(bad, parseFrontmatter), /kind/, head);
  }
});

test('MEM-06 a detail added by Mori (source agent) parses and renders back', () => {
  const text = detailText({ kind: 'fact', abstract: 'Staging is PostgreSQL 15', source: 'agent',
    created: '2026-10-26 · Mori', modified: '2026-10-26 · Mori' });
  const detail = F.parseDetail(text, parseFrontmatter);
  assert.equal(detail.source, 'agent');
  const rendered = F.renderDetail(detail);
  assert.match(rendered, /^source: agent$/m);
  assert.deepEqual(F.parseDetail(rendered, parseFrontmatter), detail);
});

test('MEM-06 fences are one tilde longer than the longest tilde-only line and blocks read back exactly', () => {
  const fourAndSix = 'Before\n~~~~\nmiddle\n~~~~~~\nend\n';
  const revision = { ...specRevision(), changes: [{ action: 'changed', kind: 'strategy',
    from: { layer: 'project', slug: 's' }, to: { layer: 'project', slug: 's' }, before: fourAndSix,
    after: 'x\n~~~~~' }] };
  const text = F.renderRevision(revision);
  assert.ok(text.includes('\n~~~~~~~before\nBefore\n~~~~\nmiddle\n~~~~~~\nend\n\n~~~~~~~\n'), 'seven tildes');
  assert.ok(text.includes('\n~~~~~~after\nx\n~~~~~\n~~~~~~\n'), 'six tildes');
  const parsed = F.parseRevision(text, parseFrontmatter);
  assert.equal(parsed.changes[0].before, fourAndSix);
  assert.equal(parsed.changes[0].after, 'x\n~~~~~');
  assert.equal(parsed.notes, 'No conflicts.');
});

test('MEM-06 slugs: lower-case ASCII words joined by -, at most 48, a fallback for no ASCII, suffixes when taken',
  () => {
  const none = () => false;
  const fixed = () => 'k3f9';
  assert.equal(F.makeSlug('Plan before changing more than three modules', 'strategy', '2026-10-23', none, fixed),
    SPEC_SLUG);
  assert.equal(F.makeSlug('Don’t use `any` in TS-code!', 'taste', '2026-10-23', none, fixed),
    'don-t-use-any-in-ts-code');
  assert.equal(F.makeSlug('用 npm test 验证', 'review', '2026-10-23', none, fixed), 'npm-test');
  const long = F.makeSlug(Array(7).fill('abcdefg').join(' '), 'fact', '2026-10-23', none, fixed);
  assert.equal(long, Array(6).fill('abcdefg').join('-'), 'cut to 48, then the trailing - goes');
  assert.ok(F.makeSlug('x'.repeat(80), 'fact', '2026-10-23', none, fixed).length <= 48);
  assert.equal(F.makeSlug('一行配置、一个错别字，直接改，不写计划', 'strategy', '2026-10-23', none, fixed),
    'strategy-20261023-k3f9');
  const taken = new Set(['plan-x', 'plan-x-2']);
  assert.equal(F.makeSlug('Plan x', 'strategy', '2026-10-23', (slug) => taken.has(slug), fixed), 'plan-x-3');
});

test('MEM-06 revision ids are local YYYYMMDD-HHmmss-xxxx and times carry the zone', () => {
  const at = new Date(2026, 9, 24, 4, 3, 12);
  assert.equal(F.revisionId(at, () => 'q7wk'), '20261024-040312-q7wk');
  const offset = -at.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:`
    + `${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  assert.equal(F.localIso(at), `2026-10-24T04:03:12.000${zone}`);
  assert.equal(Date.parse(F.localIso(at)), at.getTime());
});

test('MEM-06 project folders use pi’s session folder encoding; case and subfolders are other projects', () => {
  const formula = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  for (const cwd of ['D:\\shop', 'D:\\a-b', 'C:\\Users\\me\\code\\api']) {
    assert.equal(F.projectDirName(cwd), formula(cwd));
  }
  if (process.platform === 'win32') assert.equal(F.projectDirName('D:\\shop'), '--D--shop--');
  assert.notEqual(F.projectDirName('D:\\Shop'), F.projectDirName('D:\\shop'));
  assert.notEqual(F.projectDirName('D:\\shop\\api'), F.projectDirName('D:\\shop'));
  assert.equal(F.projectDirName('D:\\a-b'), F.projectDirName('D:\\a\\b'), 'the encoding loses information');
  assert.equal(F.projectOwnerError(resolve('D:\\a\\b'), resolve('D:\\a-b')),
    `This project’s memory folder belongs to ${resolve('D:\\a-b')}.`);
  assert.equal(F.projectOwnerError(resolve('D:\\a-b'), resolve('D:\\a-b')), null);
  assert.equal(F.projectOwnerError(resolve('D:\\a-b'), null), null);
});

// ---- 记忆模块写出的文件（memory.ts） ----

test('MEM-06 a Memory page save writes the index, the detail and the revision, and they read back', async (t) => {
  const { userBase, events } = freshUserData(t, K);
  const day = todayKey();
  const saved = ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'taste', abstract: 'Lead with the conclusion',
    detail: 'Then the details.\n\nNot for one-line answers.', evidence: [] }));
  assert.equal(saved.id, 'lead-with-the-conclusion');
  assert.equal(readFileSync(join(userBase, 'TASTE.md'), 'utf8'),
    '# TASTE\n- [Lead with the conclusion](entries/lead-with-the-conclusion.md)\n');
  const file = join(userBase, 'entries', 'lead-with-the-conclusion.md');
  const text = readFileSync(file, 'utf8');
  assert.equal(text, ['---', 'kind: taste', 'abstract: "Lead with the conclusion"', 'source: user',
    `created: "${day} · You"`, `modified: "${day} · You"`, 'evidence: []', '---', '## Evidence', '', '## Details',
    'Then the details.', '', 'Not for one-line answers.', '', '## Revisions', ''].join('\n'));
  const ids = revisionIds(userBase);
  assert.deepEqual(ids, [saved.revision]);
  assert.match(saved.revision, /^\d{8}-\d{6}-[0-9a-z]{4}$/);
  const revisionText = readFileSync(join(userBase, 'revisions', `${ids[0]}.md`), 'utf8');
  const revision = F.parseRevision(revisionText, parseFrontmatter);
  assert.equal(revision.title, 'You · Added TASTE: Lead with the conclusion');
  assert.deepEqual(revision.changes, [{ action: 'added', kind: 'taste', from: null,
    to: { layer: 'user', slug: 'lead-with-the-conclusion' }, before: '', after: text }]);
  const listed = await K.list(null, 'user', 'taste');
  assert.deepEqual(listed.entries, [{ id: 'lead-with-the-conclusion', abstract: 'Lead with the conclusion',
    source: 'user', created: `${day} · You`, modified: `${day} · You` }]);
  const got = await K.get(null, 'user', 'lead-with-the-conclusion');
  assert.equal(got.entry.details, 'Then the details.\n\nNot for one-line answers.');
  assert.equal(got.entry.file, file);
  assert.deepEqual(events, [{ type: 'mori.memory_changed', cwd: null, layers: ['user'], kinds: ['taste'],
    revision: saved.revision }]);
});

test('MEM-06 the first write to a project folder records project.json with the working folder', async (t) => {
  const { cwd } = freshUserData(t, K);
  const saved = ok(await K.save(MORI, { cwd, layer: 'project', kind: 'fact', abstract: 'Intranet model is at 10.0.0.9',
    detail: '',
    evidence: [{ at: '2026-10-22', session: 'C:\\s.jsonl', entry: 'e1', title: 'Setup', quote: 'note it' }] }));
  const { dir } = K.projectDir(cwd);
  assert.equal(dir.endsWith(F.projectDirName(cwd)), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')), { cwd: resolve(cwd) });
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'),
    `# Facts\n- [Intranet model is at 10.0.0.9](entries/${saved.id}.md)\n`);
  const entry = (await K.get(cwd, 'project', saved.id)).entry;
  assert.deepEqual(entry.evidence, [{ at: '2026-10-22', session: 'C:\\s.jsonl', entry: 'e1', title: 'Setup',
    quote: 'note it' }]);
  const detail = readFileSync(entry.file, 'utf8');
  assert.ok(detail.includes('\n## Evidence\n- Oct 22 · Session “Setup”: “note it”\n\n## Details\n'));
  const revision = (await K.revision(cwd, 'project', saved.revision)).revision;
  assert.equal(revision.cwd, cwd);
  assert.equal(revision.changes[0].evidence, 'Oct 22 · Session “Setup”: “note it”');
});

test('MEM-06 a hand-edited index that disagrees with the detail follows the detail and is rewritten', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  seedKind(userBase, 'taste', [{ slug: 'a', abstract: 'Old text in the index' }]);
  writeFileSync(join(userBase, 'entries', 'a.md'), detailText({ kind: 'taste', abstract: 'Text in the detail' }));
  assert.deepEqual((await K.list(null, 'user', 'taste')).entries.map((row) => row.abstract), ['Text in the detail']);
  assert.deepEqual((await K.abstracts(cwd)).user.taste, ['Text in the detail']);
  ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'taste', abstract: 'B', detail: '', evidence: [] }));
  assert.equal(readFileSync(join(userBase, 'TASTE.md'), 'utf8'),
    '# TASTE\n- [Text in the detail](entries/a.md)\n- [B](entries/b.md)\n');
});

test('MEM-06 entries that can’t be read are listed with a reason and stay out of the prompt', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  seedKind(userBase, 'taste', [{ slug: 'good', abstract: 'Good' }, { slug: 'plain', abstract: 'Plain' },
    { slug: 'wrong-kind', abstract: 'Wrong kind' }]);
  writeFileSync(join(userBase, 'entries', 'plain.md'), 'Just text, no frontmatter.\n');
  writeFileSync(join(userBase, 'entries', 'wrong-kind.md'), detailText({ kind: 'fact', abstract: 'Wrong kind' }));
  writeFileSync(join(userBase, 'TASTE.md'),
    `${readFileSync(join(userBase, 'TASTE.md'), 'utf8')}- [Gone](entries/gone.md)\n`);
  const listed = await K.list(null, 'user', 'taste');
  assert.equal(listed.error, null);
  assert.deepEqual(listed.entries.map((row) => row.id), ['good']);
  assert.deepEqual(listed.broken.map((item) => item.name), ['plain.md', 'wrong-kind.md', 'gone.md']);
  for (const item of listed.broken) assert.ok(item.error.length > 0, item.name);
  assert.deepEqual((await K.abstracts(cwd)).user.taste, ['Good']);
  assert.equal(listed.usage.used, S.estimateMemoryTokens('- Good'), 'unreadable entries don’t count');
});

test('MEM-06 [[slug]] links: backlinks resolve in the same layer first, then the other, sorted by kind', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  const project = seedProject(K, cwd);
  assert.deepEqual(R.backlinkSlugs('See [[x]], [[ y ]] and [[x]] again; not [[a\nb]]'), ['x', 'y']);
  seedKind(project, 'taste', [{ slug: 'target', abstract: 'Target' }]);
  seedKind(project, 'strategy', [{ slug: 'p-ref', abstract: 'Plan ref', details: 'Use [[target]] first.' }]);
  seedKind(userBase, 'fact', [{ slug: 'u-ref', abstract: 'User ref', details: 'See [[target]] and [[missing]].' }]);
  const refs = (await K.get(cwd, 'project', 'target')).backlinks;
  assert.deepEqual(refs, [{ layer: 'user', kind: 'fact', id: 'u-ref', abstract: 'User ref' },
    { layer: 'project', kind: 'strategy', id: 'p-ref', abstract: 'Plan ref' }]);
  seedKind(userBase, 'review', [{ slug: 'target', abstract: 'User target' }]);
  assert.deepEqual((await K.get(cwd, 'project', 'target')).backlinks.map((ref) => ref.id), ['p-ref'],
    'the user-level link now resolves to the user-level entry');
  assert.deepEqual((await K.get(cwd, 'user', 'target')).backlinks.map((ref) => ref.id), ['u-ref']);
});

/** @brief 记忆目录下所有 .tmp 文件或目录。 */
function tempLeftovers(root) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.tmp')) found.push(join(dir, entry.name));
      else if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}

test('MEM-06 writes go to a temporary file first, so a failed write leaves the old file intact', async (t) => {
  const { cwd, userBase, memoryRoot } = freshUserData(t, K);
  ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'taste', abstract: 'One', detail: '', evidence: [] }));
  ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'review', abstract: 'Run it', detail: '', evidence: [] }));
  assert.deepEqual(tempLeftovers(memoryRoot), []);
  const index = readFileSync(join(userBase, 'TASTE.md'), 'utf8');
  const revisions = revisionIds(userBase);
  mkdirSync(join(userBase, 'TASTE.md.tmp'));
  const failed = await K.save(PAGE, { cwd: null, layer: 'user', kind: 'taste', abstract: 'Two', detail: '',
    evidence: [] });
  assert.notEqual(failed.error, null);
  assert.equal(failed.revision, null);
  assert.equal(readFileSync(join(userBase, 'TASTE.md'), 'utf8'), index, 'the index was not touched');
  assert.deepEqual(revisionIds(userBase), revisions, 'no revision for a failed write');
});

test('MEM-06 a second folder that encodes to the same project folder is refused everywhere', async (t) => {
  const { userData } = freshUserData(t, K);
  const first = join(userData, 'work', 'a-b');
  const second = join(userData, 'work', 'a', 'b');
  assert.equal(K.projectDir(first).dir, K.projectDir(second).dir);
  const added = ok(await K.save(PAGE, { cwd: first, layer: 'project', kind: 'taste', abstract: 'Mine', detail: '',
    evidence: [] }));
  const user = ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'fact', abstract: 'Everyone', detail: '',
    evidence: [] }));
  const { dir } = K.projectDir(first);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')), { cwd: first });
  const owner = `This project’s memory folder belongs to ${first}.`;
  const before = snapshotDir(dir);
  const target = { cwd: second, layer: 'project', id: added.id };
  const results = {
    list: await K.list(second, 'project', 'taste'), get: await K.get(second, 'project', added.id),
    save: await K.save(PAGE, { cwd: second, layer: 'project', kind: 'taste', abstract: 'X', detail: '',
      evidence: [] }),
    update: await K.update(PAGE, { target, abstract: 'Y', note: '' }),
    forget: await K.forget(PAGE, { target, note: '' }),
    promote: await K.move(PAGE, second, 'project', added.id), demote: await K.move(PAGE, second, 'user', user.id),
    revisions: await K.revisions(second, 'project'), revision: await K.revision(second, 'project', added.revision),
    rollback: await K.rollback(PAGE, second, 'project', added.revision),
    command: await K.handleMemoryCommand({ type: 'memory.list', cwd: second, layer: 'project', kind: 'taste' }),
  };
  for (const [name, result] of Object.entries(results)) assert.equal(result.error, owner, name);
  assert.deepEqual(results.list.entries, []);
  assert.equal(results.get.entry, null);
  const tool = K.memoryTool({ cwd: second, caller: { kind: 'agent' }, run: null, scope: null,
    position: () => ({ session: null, entry: null, title: 'Chat' }) });
  const call = await tool.execute('call-1', { action: 'save', kind: 'fact', abstract: 'X', quote: 'note it' });
  assert.equal(call.isError, true);
  assert.deepEqual(call.content, [{ type: 'text', text: owner }]);
  const snapshot = await K.abstracts(second);
  assert.deepEqual(snapshot.project, { fact: [], taste: [], strategy: [], review: [] });
  assert.deepEqual(snapshot.user.fact, ['Everyone'], 'the user level still goes into the prompt');
  assert.deepEqual((await K.abstracts(first)).project.taste, ['Mine']);
  await K.startEnhance({ userData, emitGlobal: () => undefined,
    clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined } });
  const info = await K.enhanceInfo(second);
  assert.equal(info.error, owner);
  assert.equal(info.enabled, false);
  assert.equal((await K.setEnhance(second, { enabled: true })).error, owner);
  assert.equal((await K.setEnhance(second, { time: '05:00' })).error, owner);
  assert.equal((await K.runNow(second)).error, owner);
  assert.equal(readOrNull(join(dir, 'enhance.json')), null, 'enhance.json was not written');
  assert.deepEqual(snapshotDir(dir), before, 'nothing in the project folder changed');
});

test('MEM-06 hand-written files with CRLF, a BOM and plain YAML values still read', async (t) => {
  const { cwd, userBase } = freshUserData(t, K);
  mkdirSync(join(userBase, 'entries'), { recursive: true });
  // synthetic：你在编辑器里手写的条目：Windows 换行、BOM、不加引号的 YAML 值，没有 evidence 与 created
  const hand = '\uFEFF---\r\nkind: review\r\nabstract: Compare the output with the request item by item\r\n'
    + 'source: user\r\n---\r\n## Details\r\nRun it first.\r\n\r\n## Revisions\r\n- Oct 20 · You: typed by hand\r\n';
  writeFileSync(join(userBase, 'entries', 'by-hand.md'), hand);
  writeFileSync(join(userBase, 'REVIEW.md'), '# REVIEW\r\n- [Compare the output](entries/by-hand.md)\r\n');
  const { entry } = await K.get(null, 'user', 'by-hand');
  assert.deepEqual([entry.abstract, entry.details, entry.history, entry.evidence],
    ['Compare the output with the request item by item', 'Run it first.', ['Oct 20 · You: typed by hand'], []]);
  assert.deepEqual((await K.abstracts(cwd)).user.review, ['Compare the output with the request item by item']);
});

test('MEM-06 slugs: kept when the abstract changes, the same in both layers, a suffix when moving onto one',
  async (t) => {
    const { cwd } = freshUserData(t, K);
    const user = ok(await K.save(PAGE, { cwd, layer: 'user', kind: 'fact', abstract: 'Port is 8080', detail: '',
      evidence: [] }));
    const project = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'Port is 8080', detail: '',
      evidence: [] }));
    assert.deepEqual([user.id, project.id], ['port-is-8080', 'port-is-8080'], 'two layers may share a slug');
    const again = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'taste', abstract: 'Port is 8080!', detail: '',
      evidence: [] }));
    assert.equal(again.id, 'port-is-8080-2', 'one name per layer across the four kinds');
    ok(await K.update(PAGE, { target: { cwd, layer: 'project', id: project.id }, abstract: 'Port is 9090',
      note: '' }));
    assert.deepEqual((await K.list(cwd, 'project', 'fact')).entries.map((row) => [row.id, row.abstract]),
      [['port-is-8080', 'Port is 9090']], 'the id stays');
    const moved = ok(await K.move(PAGE, cwd, 'project', project.id));
    assert.equal(moved.id, 'port-is-8080-2', 'the user level already has port-is-8080');
    assert.deepEqual((await K.list(null, 'user', 'fact')).entries.map((row) => row.id), ['port-is-8080',
      'port-is-8080-2']);
  });

test('MEM-06 enhance.set claims the project folder too, and the memory module then refuses the other folder',
  async (t) => {
    const { userData } = freshUserData(t, K);
    const first = join(userData, 'work', 'x-y');
    const second = join(userData, 'work', 'x', 'y');
    await K.startEnhance({ userData, emitGlobal: () => undefined,
      clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined } });
    assert.equal((await K.setEnhance(first, { time: '05:00' })).error, null);
    const { dir } = K.projectDir(first);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')), { cwd: first });
    const owner = `This project’s memory folder belongs to ${first}.`;
    assert.equal((await K.save(PAGE, { cwd: second, layer: 'project', kind: 'fact', abstract: 'A', detail: '',
      evidence: [] })).error, owner);
    assert.equal((await K.enhanceInfo(second)).error, owner);
  });

test('MEM-06 created and modified name who wrote the entry: You, Mori or Enhancement', async (t) => {
  const { cwd } = freshUserData(t, K);
  const day = todayKey();
  const mori = ok(await K.save(MORI, { cwd, layer: 'project', kind: 'fact', abstract: 'Uses pnpm', detail: '',
    evidence: [{ at: day, session: 'C:\\s.jsonl', entry: 'e1', title: 'T', quote: 'we use pnpm' }] }));
  const page = ok(await K.save(PAGE, { cwd, layer: 'project', kind: 'fact', abstract: 'Node 22', detail: '',
    evidence: [] }));
  const entries = (await K.list(cwd, 'project', 'fact')).entries;
  assert.deepEqual(entries.map((row) => [row.id, row.created, row.modified]), [
    [mori.id, `${day} · Mori`, `${day} · Mori`], [page.id, `${day} · You`, `${day} · You`]]);
  ok(await K.update(MORI, { target: { cwd, layer: 'project', id: page.id }, detail: 'LTS', note: 'n',
    evidence: [{ at: day, session: 'C:\\s.jsonl', entry: 'e2', title: 'T', quote: 'q' }] }));
  const edited = (await K.get(cwd, 'project', page.id)).entry;
  assert.deepEqual([edited.created, edited.modified], [`${day} · You`, `${day} · Mori`]);
});

test('MEM-06 dates in the Revisions lines are written as Mon D', async (t) => {
  const { userBase } = freshUserData(t, K);
  const saved = ok(await K.save(PAGE, { cwd: null, layer: 'user', kind: 'fact', abstract: 'A', detail: '',
    evidence: [] }));
  ok(await K.update(PAGE, { target: { cwd: null, layer: 'user', id: saved.id }, detail: 'More', note: '' }));
  const text = readFileSync(join(userBase, 'entries', `${saved.id}.md`), 'utf8');
  assert.ok(text.endsWith(`\n## Revisions\n- ${monDay(todayKey())} · You: Edited on the Memory page\n`));
});
