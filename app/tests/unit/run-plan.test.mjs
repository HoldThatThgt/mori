// 三层测试的运行器（tests/ui/run-plan.mjs 的选择规则）与结果文件的戳（tests/ui/stamp.mjs）的单元测试：
// 负责人 2026-10-28 定的三层测试（AGENTS.md“测试分层”，docs/v1/test-strategy.md）。
// 候选项、脚本与临时文件都是测试手写的（synthetic）；importClosure 与 freshness 的“算数”一条用仓库里真的套件脚本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dropStale } from '../spec-coverage.mjs';
import { familiesOf, planAll, planPush } from '../ui/run-plan.mjs';
import {
  appRoot, buildHash, freshness, importClosure, layerOf, stampProblem, testsHash, treeHash,
} from '../ui/stamp.mjs';

/** @brief 一个候选项（默认是结果不算数、从没跑过的 App 套件）。 */
const candidate = (name, extra = {}) => ({ name, layer: layerOf(name), seconds: 60, fresh: false,
  reason: 'missing: never ran in full', at: null, ...extra });

/** @brief 在 test-results 下建一个临时目录（在 app/ 里，treeHash 按相对 app/ 的路径计入），测试结束时删掉。 */
function tempDir(t) {
  mkdirSync(join(appRoot, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(appRoot, 'test-results', 'run-plan-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('run plan: families come from the npm scripts, in order, without the aggregate, the base build or repeats', () => {
  const scripts = {
    'test:taskboard': 'npm run test:tb-unit && electron-vite build && node tests/ui/tb-build-base.mjs'
      + ' && node tests/ui/tb-app-roles.mjs && node tests/ui/tb-replay.mjs && node tests/ui/tb-app-roles.mjs'
      + ' && node tests/ui/v1-models-existing.mjs --id TB-46 && node tests/spec-coverage.mjs --spec taskboard',
    smoke: 'electron-vite build && node tests/ui/m0-smoke.mjs',
    'test:replay': 'node tests/ui/m1-replay.mjs',
  };
  const families = familiesOf(scripts);
  assert.deepEqual(families.get('taskboard'), ['tb-app-roles', 'tb-replay']);
  assert.deepEqual(families.get('v0'), ['m0-smoke', 'm1-replay']);
  assert.deepEqual(families.get('memory'), []);
});

test('run plan: push skips valid results, runs changed or failed suites first, then replays, then the oldest', () => {
  const plan = planPush([
    candidate('tb-app-roles', { at: '2026-10-27T10:00:00Z', reason: 'stale: build changed' }),
    candidate('tb-app-flow', { fresh: true, reason: null }),
    candidate('tb-app-ask', { at: '2026-10-26T10:00:00Z', reason: 'stale: build changed' }),
    candidate('tb-replay', { reason: 'stale: build changed', at: '2026-10-28T10:00:00Z' }),
    candidate('tb-app-stop', { reason: 'failed: 2 check(s) failed', at: '2026-10-28T11:00:00Z' }),
    candidate('tb-app-misc', { reason: 'stale: tests changed', at: '2026-10-28T12:00:00Z' }),
  ], 3600);
  assert.deepEqual(plan.run.map((c) => c.name), ['tb-app-stop', 'tb-app-misc', 'tb-replay', 'tb-app-ask',
    'tb-app-roles']);
  assert.deepEqual(plan.fresh.map((c) => c.name), ['tb-app-flow']);
  assert.deepEqual(plan.deferred, []);
  assert.equal(plan.seconds, 300);
});

test('run plan: push fills the budget, skips a suite that does not fit and still takes shorter ones after it', () => {
  const plan = planPush([
    candidate('a-app', { seconds: 500 }), candidate('b-app', { seconds: 700 }), candidate('c-app', { seconds: 200 }),
    candidate('d-app', { seconds: 400 }),
  ], 1080);
  assert.deepEqual(plan.run.map((c) => c.name), ['a-app', 'c-app']);
  assert.deepEqual(plan.deferred.map((c) => c.name), ['b-app', 'd-app']);
  assert.equal(plan.seconds, 700);
});

test('run plan: never-run suites go before ones that ran, and ties keep the family order', () => {
  const plan = planPush([candidate('a-app', { at: '2026-10-28T00:00:00Z', reason: 'stale: build changed' }),
    candidate('b-app'), candidate('c-app')], 3600);
  assert.deepEqual(plan.run.map((c) => c.name), ['b-app', 'c-app', 'a-app']);
});

test('run plan: publish runs only suites whose results do not count; --rerun runs all of them', () => {
  const list = [candidate('a-app', { fresh: true, reason: null }), candidate('b-replay'), candidate('c-app')];
  assert.deepEqual(planAll(list, false).run.map((c) => c.name), ['b-replay', 'c-app']);
  assert.deepEqual(planAll(list, false).fresh.map((c) => c.name), ['a-app']);
  assert.deepEqual(planAll(list, true).run.map((c) => c.name), ['a-app', 'b-replay', 'c-app']);
  assert.equal(planAll(list, false).seconds, 120);
});

test('stamp: layers by script name', () => {
  assert.deepEqual(['m1-replay', 'tb-real', 'fs-app-gate', 'm0-smoke'].map(layerOf), ['replay', 'real', 'app', 'app']);
});

test('stamp: the import closure follows relative imports inside tests/ and nothing outside it', () => {
  const closure = [...importClosure(join(appRoot, 'tests/ui/m2-replay.mjs'))]
    .map((file) => relative(appRoot, file).replace(/\\/g, '/'));
  const expected = ['tests/ui/m2-replay.mjs', 'tests/ui/harness-page.mjs', 'tests/ui/stamp.mjs', 'tests/ui/lib.mjs'];
  for (const file of expected) {
    assert.ok(closure.includes(file), `${file} in ${closure.join(', ')}`);
  }
  assert.ok(closure.every((file) => file.startsWith('tests/')), closure.join(', '));
  assert.ok(!closure.includes('tests/ui/m1-app.mjs'));
});

test('stamp: the tree hash changes with a file’s content and with its name', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'a.txt'), 'one');
  const first = treeHash([dir]);
  writeFileSync(join(dir, 'a.txt'), 'two!');
  const second = treeHash([dir]);
  assert.notEqual(second, first);
  rmSync(join(dir, 'a.txt'));
  writeFileSync(join(dir, 'b.txt'), 'two!');
  assert.notEqual(treeHash([dir]), second);
  assert.equal(treeHash([dir]), treeHash([join(dir, 'b.txt')]));
});

test('stamp: freshness says why a result does not count, and counts a passing result on the same tests and build',
  (t) => {
    const dir = tempDir(t);
    const write = (name, result) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(result));
    const stamp = { tests: testsHash(join(appRoot, 'tests/ui/m2-replay.mjs')), build: buildHash('m2-replay'),
      at: '2026-10-28T12:00:00Z' };
    const pass = { name: 'x', ok: true, known: false };
    write('m2-replay', { checks: [pass], stamp });
    write('m3-replay', { checks: [pass] });
    write('m4-replay', { checks: [pass, { name: 'y', ok: false, known: false }], stamp });
    write('m5-replay', { checks: [{ name: 'y', ok: false, known: true }], stamp });
    write('m6-replay', { checks: [pass],
      stamp: { ...stamp, tests: testsHash(join(appRoot, 'tests/ui/m6-replay.mjs')), build: 'other' } });
    write('m1-replay', { checks: [pass], stamp });
    const reason = (name) => freshness(name, { resultsDir: dir }).reason;
    assert.equal(reason('m2-replay'), null);
    assert.equal(freshness('m2-replay', { resultsDir: dir }).at, '2026-10-28T12:00:00Z');
    assert.equal(reason('md-replay'), 'missing: never ran in full');
    assert.equal(reason('m3-replay'), 'no stamp: ran before stamps were written');
    assert.equal(reason('m4-replay'), 'failed: 1 check(s) failed');
    assert.equal(reason('m5-replay'), 'no checks passed');
    assert.equal(reason('m6-replay'), 'stale: build changed');
    assert.equal(reason('m1-replay'), 'stale: tests changed');
  });

test('spec-coverage --fresh: stale App and replay result files are not counted; unit and real files are', () => {
  const stamp = { tests: testsHash(join(appRoot, 'tests/ui/m2-replay.mjs')), build: buildHash('m2-replay') };
  const file = (name, layer, fileStamp) => ({ name, layer, checks: [], stamp: fileStamp });
  const { files, stale } = dropStale([file('m2-replay.json', 'replay', stamp),
    file('m3-replay.json', 'replay', undefined), file('m4-replay.json', 'replay', { ...stamp, build: 'other' }),
    file('v1-unit.json', 'unit', undefined), file('tb-real.json', 'real', undefined)], stampProblem);
  assert.deepEqual(files.map((f) => f.name), ['m2-replay.json', 'v1-unit.json', 'tb-real.json']);
  assert.deepEqual(stale, [{ name: 'm3-replay.json', reason: 'no stamp: ran before stamps were written' },
    { name: 'm4-replay.json', reason: 'stale: tests changed' }]);
});
