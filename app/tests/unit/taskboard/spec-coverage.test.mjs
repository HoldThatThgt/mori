// tests/spec-coverage.mjs 的单元测试（docs/specs/parallel-agents-taskboard.md §17.3、§17.4）：--spec taskboard 读 §17.2
// 的 TB 条目与层、tb- 结果文件按层归类（-packaged 只在 --packaged 时计入 App 与真实层、回放只认开发构建、
// tb-partial-*.json 不计入）、不属于任何编号的检查只在这份规格的结果文件里找；不加 --spec 时模型层的规则不变。
// 记忆规格（docs/specs/memory.md §14.3、§14.4）加的 --spec memory 同样检查：§14.2 的 MEM 条目与层、mem- 结果文件的归类。
// 一键拉取模型规格（docs/specs/model-discovery.md §13.3）加的 --spec discovery 同样检查：§13.2 的 MD 条目与层、md- 结果
// 文件的归类；另查带 skip / todo 标记的检查不算通过，以及严格模式的单元报告器（md-reporter.mjs 用的
// createReporter(…, true)）把跳过的与 todo 的测试写成带标记的失败、套件自己的失败也记一条，不开严格模式时照旧。
// 2026-10-24（模型层规格 §7.7、§14.3）：§14.2 加了 MP-38–MP-40；reporter.mjs 的默认导出（v1-unit.json）也是严格模式，
// 把它复制到临时目录（它按自己的位置找 test-results/，所以写不到真的 v1-unit.json）再让 node --test 用它来检查。
// §17.4 把覆盖检查算进 TB-46（现有功能不退步），所以检查名以 "TB-46 spec-coverage" 开头；TB-46 只列 App 与回放两层，
// 这些单元检查不计入覆盖表，由 node --test 的退出码把关。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SPECS, cellOf, flagOfCheck, layerOfFile, parseSpecTable, passes, specPathOf, startsWithId, strayChecks,
} from '../../spec-coverage.mjs';
import { createReporter } from '../reporter.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { model, taskboard, memory, discovery } = SPECS;

/** @brief 按 [文件名, 期望的层] 逐个比对。 */
function expectLayers(spec, packaged, cases) {
  for (const [name, layer] of cases) {
    assert.equal(layerOfFile(spec, name, packaged), layer, `${name} (${packaged ? 'packaged' : 'dev'})`);
  }
}

test('TB-46 spec-coverage reads every TB row of §17.2 with its layers', () => {
  const items = parseSpecTable(taskboard, readFileSync(specPathOf(taskboard), 'utf8'));
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 57 }, (_, i) => `TB-${String(i + 1).padStart(2, '0')}`));
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('TB-46'), ['app', 'replay']);
  assert.deepEqual(layersOf('TB-45'), ['real']);
  assert.deepEqual(layersOf('TB-04'), ['app', 'real', 'replay', 'unit']);
  assert.deepEqual(layersOf('TB-13'), ['unit']);
  assert.equal(items.find((item) => item.id === 'TB-46').title, '现有功能不退步');
});

test('TB-46 spec-coverage maps tb- result files to layers in the dev build', () => {
  expectLayers(taskboard, false, [
    ['tb-unit.json', 'unit'], ['tb-app-team.json', 'app'], ['tb-app-existing.json', 'app'],
    ['tb-replay.json', 'replay'], ['tb-replay-existing.json', 'replay'], ['tb-real.json', 'real'],
    ['tb-app-existing-packaged.json', null], ['tb-real-packaged.json', null], ['tb-replay-x-packaged.json', null],
    ['tb-partial-app-existing.json', null], ['tb-partial-replay-existing.json', null], ['tb-app-team.log', null],
    ['tb-existing', null], ['v1-unit.json', null], ['v1-models-app-existing.json', null], ['m1-app.json', null],
  ]);
});

test('TB-46 spec-coverage counts -packaged App and real files only with --packaged', () => {
  expectLayers(taskboard, true, [
    ['tb-unit.json', 'unit'], ['tb-app-existing-packaged.json', 'app'], ['tb-app-team-packaged.json', 'app'],
    ['tb-app-existing.json', null], ['tb-real-packaged.json', 'real'], ['tb-real.json', null],
    ['tb-replay-existing.json', 'replay'], ['tb-replay-x-packaged.json', null],
    ['tb-partial-app-existing-packaged.json', null], ['v1-models-app-existing-packaged.json', null],
  ]);
});

test('TB-46 spec-coverage keeps the model layer rules when --spec is not given', () => {
  expectLayers(model, false, [
    ['v1-unit.json', 'unit'], ['v1-models-app-existing.json', 'app'], ['v1-models-app-settings.json', 'app'],
    ['v1-models-replay.json', 'replay'], ['v1-models-replay-existing.json', 'replay'],
    ['v1-models-real.json', 'real'], ['v1-models-real-packaged.json', null],
    ['v1-models-app-existing-packaged.json', null], ['v1-models-existing-partial-app.json', null],
    ['tb-unit.json', null], ['tb-app-existing.json', null], ['tb-real.json', null],
  ]);
  expectLayers(model, true, [
    ['v1-models-app-existing-packaged.json', 'app'], ['v1-models-app-existing.json', null],
    ['v1-models-real-packaged.json', 'real'], ['v1-models-real.json', null], ['v1-unit.json', 'unit'],
    ['v1-models-replay.json', 'replay'], ['tb-app-existing-packaged.json', null],
  ]);
  const items = parseSpecTable(model, readFileSync(specPathOf(model), 'utf8'));
  // 2026-10-24（model-providers.md §7.7）：§14.2 加了 MP-38–MP-40；2026-10-26（§8.3 的补，WP-02）加了 MP-41
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 41 }, (_, i) => `MP-${String(i + 1).padStart(2, '0')}`));
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('MP-37'), ['app', 'replay']);
  assert.deepEqual(layersOf('MP-38'), ['app', 'unit']);
  assert.deepEqual(layersOf('MP-39'), ['app', 'unit']);
  assert.deepEqual(layersOf('MP-40'), ['real']);
  assert.deepEqual(layersOf('MP-41'), ['unit']);
});

test('TB-46 spec-coverage reads every MEM row of memory §14.2 with its layers', () => {
  const items = parseSpecTable(memory, readFileSync(specPathOf(memory), 'utf8'));
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 38 }, (_, i) => `MEM-${String(i + 1).padStart(2, '0')}`), 'MEM-38 was added on 2026-10-26');
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('MEM-10'), ['app', 'real', 'replay', 'unit']);
  assert.deepEqual(layersOf('MEM-12'), ['unit']);
  assert.deepEqual(layersOf('MEM-38'), ['app', 'unit']);
  assert.deepEqual(layersOf('MEM-34'), ['real']);
  assert.deepEqual(layersOf('MEM-35'), ['app', 'replay']);
  assert.equal(items.find((item) => item.id === 'MEM-35').title, '现有功能不退步');
});

test('TB-46 spec-coverage maps mem- result files to layers (partial files never count)', () => {
  expectLayers(memory, false, [
    ['mem-unit.json', 'unit'], ['mem-app-prompt.json', 'app'], ['mem-app-existing.json', 'app'],
    ['mem-replay.json', 'replay'], ['mem-replay-existing.json', 'replay'], ['mem-real.json', 'real'],
    ['mem-app-existing-packaged.json', null], ['mem-real-packaged.json', null],
    ['mem-partial-existing-app.json', null], ['mem-partial-app-prompt.json', null], ['mem-app-prompt.log', null],
    ['tb-unit.json', null], ['v1-models-app-existing.json', null],
  ]);
  expectLayers(memory, true, [
    ['mem-app-existing-packaged.json', 'app'], ['mem-app-existing.json', null], ['mem-real-packaged.json', 'real'],
    ['mem-unit.json', 'unit'], ['mem-replay.json', 'replay'], ['mem-partial-existing-app-packaged.json', null],
  ]);
});

test('TB-46 spec-coverage reads every MD row of model-discovery §13.2 with its layers', () => {
  const items = parseSpecTable(discovery, readFileSync(specPathOf(discovery), 'utf8'));
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 15 }, (_, i) => `MD-${String(i + 1).padStart(2, '0')}`));
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('MD-01'), ['unit']);
  assert.deepEqual(layersOf('MD-06'), ['app', 'unit']);
  assert.deepEqual(layersOf('MD-07'), ['app', 'replay']);
  assert.deepEqual(layersOf('MD-08'), ['app']);
  assert.deepEqual(layersOf('MD-12'), ['app', 'unit']);
  assert.deepEqual(layersOf('MD-14'), ['real']);
  assert.deepEqual(layersOf('MD-15'), ['app', 'replay']);
  assert.equal(items.find((item) => item.id === 'MD-15').title, '现有功能不退步');
});

test('TB-46 spec-coverage maps md- result files to layers (partial files never count)', () => {
  expectLayers(discovery, false, [
    ['md-unit.json', 'unit'], ['md-app-form.json', 'app'], ['md-app-card.json', 'app'],
    ['md-app-firstrun.json', 'app'], ['md-app-existing.json', 'app'], ['md-replay.json', 'replay'],
    ['md-replay-existing.json', 'replay'], ['md-real.json', 'real'], ['md-app-existing-packaged.json', null],
    ['md-real-packaged.json', null], ['md-replay-x-packaged.json', null], ['md-partial-existing-app.json', null],
    ['md-partial-existing-replay.json', null], ['md-app-form.log', null], ['md-existing', null],
    ['mem-unit.json', null], ['tb-app-existing.json', null], ['v1-models-replay.json', null],
  ]);
  expectLayers(discovery, true, [
    ['md-app-existing-packaged.json', 'app'], ['md-app-existing.json', null], ['md-real-packaged.json', 'real'],
    ['md-real.json', null], ['md-unit.json', 'unit'], ['md-replay.json', 'replay'],
    ['md-partial-existing-app-packaged.json', null],
  ]);
  for (const spec of [model, taskboard, memory]) {
    expectLayers(spec, false, [['md-unit.json', null], ['md-app-existing.json', null],
      ['md-replay-existing.json', null], ['md-real.json', null]]);
  }
});

test('TB-46 spec-coverage never counts a check with a skip or todo flag as passing', () => {
  assert.equal(passes({ name: 'MD-01 a', ok: true }), true);
  assert.equal(passes({ name: 'MD-01 a', ok: false }), false);
  assert.equal(passes({ name: 'MD-01 a', ok: 'yes' }), false);
  assert.equal(passes({ name: 'MD-01 a', ok: true, skip: true }), false);
  assert.equal(passes({ name: 'MD-01 a', ok: true, todo: true }), false);
  assert.deepEqual([{ skip: true }, { todo: true }, { ok: true }].map(flagOfCheck), ['skipped', 'todo', null]);
  const item = { id: 'MD-01', title: 't', layers: new Set(['unit']) };
  const unit = (checks) => [{ name: 'md-unit.json', layer: 'unit', checks }];
  const ok = { name: 'MD-01 reads the base URL', ok: true, detail: '' };
  const skipped = { name: 'MD-01 skipped one', ok: false, detail: 'skipped: no reason given', skip: true };
  const cell = cellOf(item, 'unit', unit([ok, skipped]), false);
  assert.equal(cell.state, 'fail');
  assert.equal(cell.passed, 1);
  assert.deepEqual(cell.failed.map((failed) => [failed.name, failed.flag]), [['MD-01 skipped one', 'skipped']]);
  // 一个只带标记、ok 却为 true 的检查（不是严格模式的报告器写的）同样不算通过
  const lone = cellOf(item, 'unit', unit([{ name: 'MD-01 lone', ok: true, todo: true }]), false);
  assert.deepEqual([lone.state, lone.passed, lone.failed[0].flag], ['fail', 0, 'todo']);
  assert.equal(cellOf(item, 'unit', unit([ok]), false).state, 'ok');
  assert.deepEqual(strayChecks([item], unit([{ name: 'MD-99 x', ok: true, skip: true }])),
    ['md-unit.json: "MD-99 x" (FAIL)']);
});

/**
 * @brief 把一串事件交给 createReporter(file, strict) 生成的报告器，读回它写的结果文件（读完删除）。
 * @return { checks, output, exitCode }：exitCode 为报告器设的 process.exitCode（之后还原）
 */
async function runReporter(events, strict) {
  const file = `reporter-strict-check-${process.pid}.json`;
  for (const spec of Object.values(SPECS)) assert.equal(layerOfFile(spec, file, false), null);
  const before = process.exitCode;
  process.exitCode = undefined;
  let output = '';
  const source = (async function* stream() { yield* events; })();
  for await (const chunk of createReporter(file, strict)(source)) output += chunk;
  const exitCode = process.exitCode;
  process.exitCode = before;
  const path = join(appRoot, 'test-results', file);
  const { checks } = JSON.parse(readFileSync(path, 'utf8'));
  rmSync(path);
  return { checks, output, exitCode };
}

/**
 * synthetic：node 24 的 node --test 发给报告器的事件形状（在这台机器上用 skip、todo、describe.skip、describe.todo、
 * 函数抛错的 describe、钩子失败的 describe 与里面有测试失败的 describe 实际打印过 data 的字段后手写，node 24.19.0）：
 * 跳过与 todo 报成 test:pass，标为 todo 的失败报成 test:fail，带标记的套件同样带 skip / todo；套件自己失败时
 * details.error.failureType 为 testCodeFailure 或 hookFailed，只因里面的测试失败时为 subtestsFailed；
 * test:diagnostic 等别的事件不记。
 */
const FLAG_EVENTS = [
  { type: 'test:pass', data: { name: 'MD-01 plain', file: 'a.test.mjs', details: { type: 'test' } } },
  { type: 'test:pass', data: { name: 'MD-01 skipped', skip: true, details: { type: 'test' } } },
  { type: 'test:pass', data: { name: 'MD-02 skipped with a reason', skip: 'needs a server',
    details: { type: 'test' } } },
  { type: 'test:pass', data: { name: 'MD-03 marked todo', todo: true, details: { type: 'test' } } },
  { type: 'test:fail', data: { name: 'MD-03 failing todo', todo: 'shape', details: { type: 'test',
    error: { message: 'boom\nstack' } } } },
  { type: 'test:pass', data: { name: 'MD-04 skipped suite', skip: true, details: { type: 'suite' } } },
  { type: 'test:pass', data: { name: 'MD-04 suite', details: { type: 'suite' } } },
  { type: 'test:fail', data: { name: 'MD-05 failing', details: { type: 'test', error: { message: 'bad' } } } },
  { type: 'test:fail', data: { name: 'MD-05 suite', details: { type: 'suite',
    error: { failureType: 'subtestsFailed', message: '1 subtest failed', cause: '1 subtest failed' } } } },
  { type: 'test:fail', data: { name: 'MD-06 suite whose function throws', details: { type: 'suite',
    error: { failureType: 'testCodeFailure', message: 'body', cause: { message: 'body\nstack' } } } } },
  { type: 'test:diagnostic', data: { message: 'tests 7' } },
];

test('TB-46 spec-coverage: the strict unit reporter (md-reporter.mjs) fails skipped, todo and failed-suite checks',
  async () => {
    const { checks, output, exitCode } = await runReporter(FLAG_EVENTS, true);
    assert.deepEqual(checks.map(({ name, ok, detail, skip, todo }) => ({ name, ok, detail, skip, todo })), [
      { name: 'MD-01 plain', ok: true, detail: '', skip: undefined, todo: undefined },
      { name: 'MD-01 skipped', ok: false, detail: 'skipped: no reason given', skip: true, todo: undefined },
      { name: 'MD-02 skipped with a reason', ok: false, detail: 'skipped: needs a server', skip: true,
        todo: undefined },
      { name: 'MD-03 marked todo', ok: false, detail: 'todo: no reason given', skip: undefined, todo: true },
      { name: 'MD-03 failing todo', ok: false, detail: 'todo: shape (it also failed: boom)', skip: undefined,
        todo: true },
      { name: 'MD-04 skipped suite', ok: false, detail: 'skipped: no reason given', skip: true, todo: undefined },
      { name: 'MD-05 failing', ok: false, detail: 'bad', skip: undefined, todo: undefined },
      { name: 'MD-06 suite whose function throws', ok: false, detail: 'body\nstack', skip: undefined, todo: undefined },
    ]);
    assert.equal(checks.filter(passes).length, 1);
    assert.equal(exitCode, 1);
    assert.match(output, /^FAIL MD-01 skipped — skipped: no reason given$/m);
    assert.match(output, /^FAIL MD-06 suite whose function throws — body$/m);
    assert.match(output, /1\/8 unit checks passed \(5 skipped or todo, counted as failures\)/);
  });

test('TB-46 spec-coverage: reporters without strict mode keep recording skipped and todo tests as passes',
  async () => {
    const { checks, output, exitCode } = await runReporter(FLAG_EVENTS, false);
    assert.deepEqual(checks.map(({ name, ok, detail }) => [name, ok, detail]), [
      ['MD-01 plain', true, ''], ['MD-01 skipped', true, ''], ['MD-02 skipped with a reason', true, ''],
      ['MD-03 marked todo', true, ''], ['MD-03 failing todo', false, 'boom\nstack'], ['MD-05 failing', false, 'bad'],
    ]);
    assert.deepEqual(Object.keys(checks[1]), ['name', 'ok', 'detail', 'known', 'file']);
    assert.equal(exitCode, undefined);
    assert.match(output, /\n4\/6 unit checks passed\n$/);
  });

/** synthetic：一个通过、一个跳过、一个标为 todo 的测试文件 */
const FLAGGED_TESTS = `import { test } from 'node:test';
test('MP-01 synthetic pass', () => {});
test('MP-01 synthetic skipped', { skip: 'synthetic' }, () => {});
test('MP-01 synthetic todo', { todo: true }, () => {});
`;

test('TB-46 spec-coverage: the default unit reporter (reporter.mjs, v1-unit.json) is strict too', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mori-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  const copy = join(root, 'tests', 'unit', 'reporter.mjs');
  copyFileSync(join(appRoot, 'tests', 'unit', 'reporter.mjs'), copy);
  writeFileSync(join(root, 'flagged.test.mjs'), FLAGGED_TESTS);
  // 不带 NODE_TEST_CONTEXT：子进程是一次独立的 node --test，报告器在它自己的进程里跑
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--test', `--test-reporter=${pathToFileURL(copy).href}`,
    join(root, 'flagged.test.mjs')], { cwd: root, encoding: 'utf8', env });
  const { checks } = JSON.parse(readFileSync(join(root, 'test-results', 'v1-unit.json'), 'utf8'));
  assert.deepEqual(checks.map(({ name, ok, skip, todo }) => [name, ok, skip, todo]), [
    ['MP-01 synthetic pass', true, undefined, undefined],
    ['MP-01 synthetic skipped', false, true, undefined],
    ['MP-01 synthetic todo', false, undefined, true],
  ]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /1\/3 unit checks passed \(2 skipped or todo, counted as failures\)/);
});

test('TB-46 spec-coverage lists strays only from the files of the chosen spec', () => {
  const items = [{ id: 'TB-01' }, { id: 'TB-46' }];
  const files = [{ name: 'tb-unit.json', checks: [
    { name: 'TB-01 roles are checked', ok: true }, { name: 'TB-010 not an item', ok: true },
    { name: 'MP-01 model item', ok: false }, { name: 'TB-46 spec-coverage x', ok: true },
  ] }];
  assert.deepEqual(strayChecks(items, files),
    ['tb-unit.json: "TB-010 not an item"', 'tb-unit.json: "MP-01 model item" (FAIL)']);
  assert.equal(startsWithId('TB-46 test:unit', 'TB-46'), true);
  assert.equal(startsWithId('TB-460 x', 'TB-46'), false);
});

test('TB-46 spec-coverage reports a missing section, no rows, unknown layers and repeated ids', () => {
  const section = '### 17.2 验收条目\n\n| 编号 | 条目 | 通过条件 | 层 |\n| --- | --- | --- | --- |\n';
  assert.throws(() => parseSpecTable(taskboard, '## 17\n'), /section 17\.2 not found/);
  assert.throws(() => parseSpecTable(taskboard, `${section}| MP-01 | a | b | 单元 |\n`), /no TB rows in section 17\.2/);
  assert.throws(() => parseSpecTable(taskboard, `${section}| TB-01 | a | b | 单元、界面 |\n`),
    /TB-01: unknown layer 界面/);
  assert.throws(() => parseSpecTable(taskboard, `${section}| TB-01 | a | b | 单元 |\n| TB-01 | c | d | App |\n`),
    /repeated ids TB-01/);
  const rows = parseSpecTable(taskboard, `${section}| TB-01 | a | b | 单元 |\n\n### 17.3 x\n| TB-02 | c | d | App |\n`);
  assert.deepEqual(rows.map((row) => row.id), ['TB-01']);
});

test('TB-46 spec-coverage exits 2 for an unknown --spec', () => {
  const run = spawnSync(process.execPath, [join(appRoot, 'tests/spec-coverage.mjs'), '--spec', 'board'],
    { cwd: appRoot, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown --spec "board" \(expected model, taskboard, memory or discovery\)/);
  assert.equal(run.stdout, '');
});
