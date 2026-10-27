// tests/spec-coverage.mjs 的单元测试（docs/specs/parallel-agents-taskboard.md §17.3、§17.4）：--spec taskboard 读 §17.2
// 的 TB 条目与层、tb- 结果文件按层归类（-packaged 只在 --packaged 时计入 App 与真实层、回放只认开发构建、
// tb-partial-*.json 不计入）、不属于任何编号的检查只在这份规格的结果文件里找；不加 --spec 时模型层的规则不变。
// 记忆规格（docs/specs/memory.md §14.3、§14.4）加的 --spec memory 同样检查：§14.2 的 MEM 条目与层、mem- 结果文件的归类。
// 一键拉取模型规格（docs/specs/model-discovery.md §13.3）加的 --spec discovery 同样检查：§13.2 的 MD 条目与层、md- 结果
// 文件的归类；另查带 skip / todo 标记的检查不算通过，以及严格模式的单元报告器（md-reporter.mjs 用的
// createReporter(…, true)）把跳过的与 todo 的测试写成带标记的失败、套件自己的失败也记一条，不开严格模式时照旧。
// 2026-10-24（模型层规格 §7.7、§14.3）：§14.2 加了 MP-38–MP-40；reporter.mjs 的默认导出（v1-unit.json）也是严格模式，
// 把它复制到临时目录（它按自己的位置找 test-results/，所以写不到真的 v1-unit.json）再让 node --test 用它来检查。
// 文件系统规格（docs/specs/file-system.md §19.3、§19.4）加的 --spec filesystem 同样检查：§19.2 的 FS 条目与层、fs- 结果
// 文件的归类（fs-partial-*.json 不计入），fs- 文件不归其他四份规格、其他规格的文件也不归它；规格名不认识时的提示列出
// 五份规格；fs-reporter.mjs（fs-unit.json）是严格模式。直接运行 --spec filesystem 的检查在临时目录里用 synthetic 的结果
// 文件跑，不读真的 test-results/。
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
const { model, taskboard, memory, discovery, filesystem } = SPECS;

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
  // 2026-10-24（model-providers.md §7.7）：§14.2 加了 MP-38–MP-40
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 40 }, (_, i) => `MP-${String(i + 1).padStart(2, '0')}`));
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('MP-37'), ['app', 'replay']);
  assert.deepEqual(layersOf('MP-38'), ['app', 'unit']);
  assert.deepEqual(layersOf('MP-39'), ['app', 'unit']);
  assert.deepEqual(layersOf('MP-40'), ['real']);
});

test('TB-46 spec-coverage reads every MEM row of memory §14.2 with its layers', () => {
  const items = parseSpecTable(memory, readFileSync(specPathOf(memory), 'utf8'));
  assert.deepEqual(items.map((item) => item.id),
    Array.from({ length: 37 }, (_, i) => `MEM-${String(i + 1).padStart(2, '0')}`));
  const layersOf = (id) => [...items.find((item) => item.id === id).layers].sort();
  assert.deepEqual(layersOf('MEM-10'), ['app', 'real', 'replay', 'unit']);
  assert.deepEqual(layersOf('MEM-12'), ['unit']);
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
  for (const spec of [model, taskboard, memory, filesystem]) {
    expectLayers(spec, false, [['md-unit.json', null], ['md-app-existing.json', null],
      ['md-replay-existing.json', null], ['md-real.json', null]]);
  }
});

/** @brief FS 编号：fsIds(1, 115) → ['FS-01', 'FS-115']。 */
const fsIds = (...numbers) => numbers.map((n) => `FS-${String(n).padStart(2, '0')}`);

/**
 * file-system.md §19.2 每个 FS 条目的层（2026-10-27 的规格），按层的组合（排序后用 + 连起来）分组、组内按表里的顺序；
 * 规格改了哪一条的层，这里跟着改
 */
const FS_LAYER_GROUPS = {
  unit: fsIds(1, 2, 3, 4, 7, 27, 28, 29, 30, 31, 32, 33, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 56, 58, 63,
    64, 85, 91, 92, 94, 95, 96, 97, 108),
  'app+unit': fsIds(5, 6, 8, 9, 11, 16, 17, 20, 24, 26, 34, 35, 39, 57, 61, 62, 70, 71, 72, 73, 74, 75, 76, 81, 83, 84,
    87, 90, 100, 102, 106, 109, 111),
  app: fsIds(10, 12, 14, 15, 18, 19, 22, 25, 37, 38, 53, 59, 60, 65, 66, 68, 69, 77, 79, 80, 86, 88, 89, 98, 99, 101,
    103, 104, 105, 107, 110, 112),
  'app+replay': fsIds(13, 23, 36, 115),
  real: fsIds(21, 40, 55, 67, 82, 93, 113, 114),
  'app+real+replay+unit': fsIds(54),
  'app+replay+unit': fsIds(78),
};

test('TB-46 spec-coverage reads every FS row of file-system §19.2 with its layers', () => {
  const items = parseSpecTable(filesystem, readFileSync(specPathOf(filesystem), 'utf8'));
  assert.deepEqual(items.map((item) => item.id), fsIds(...Array.from({ length: 115 }, (_, i) => i + 1)));
  // §19.4：每个条目连同它的层都要查，所以整张表按层的组合分组后逐条比对，不只抽查几行
  const groups = {};
  for (const item of items) (groups[[...item.layers].sort().join('+')] ??= []).push(item.id);
  assert.deepEqual(groups, FS_LAYER_GROUPS);
  assert.deepEqual([groups.unit.length, groups['app+unit'].length, groups.app.length], [36, 33, 32]);
  assert.equal(items.find((item) => item.id === 'FS-115').title, '现有功能不退步');
  // FS-1 不匹配 FS-10 起的编号，FS-100 起的三位编号照样认出
  assert.equal(startsWithId('FS-100 worktree failure', 'FS-10'), false);
  assert.equal(startsWithId('FS-100 worktree failure', 'FS-100'), true);
});

test('TB-46 spec-coverage maps fs- result files to layers (partial files never count)', () => {
  const appSuites = ['changes', 'rewind', 'gate', 'work', 'team', 'away', 'question', 'worktree']
    .map((name) => [`fs-app-${name}.json`, 'app']);
  expectLayers(filesystem, false, [
    ['fs-unit.json', 'unit'], ...appSuites, ['fs-app-existing.json', 'app'], ['fs-replay.json', 'replay'],
    ['fs-replay-existing.json', 'replay'], ['fs-real.json', 'real'], ['fs-app-existing-packaged.json', null],
    ['fs-app-gate-packaged.json', null], ['fs-real-packaged.json', null], ['fs-replay-x-packaged.json', null],
    ['fs-partial-existing-app.json', null], ['fs-partial-existing-replay.json', null],
    ['fs-partial-existing-app-packaged.json', null], ['fs-app-gate.log', null], ['fs-existing', null],
  ]);
  expectLayers(filesystem, true, [
    ['fs-app-existing-packaged.json', 'app'], ['fs-app-gate-packaged.json', 'app'], ['fs-app-existing.json', null],
    ['fs-real-packaged.json', 'real'], ['fs-real.json', null], ['fs-unit.json', 'unit'], ['fs-replay.json', 'replay'],
    ['fs-replay-existing.json', 'replay'], ['fs-partial-existing-app-packaged.json', null],
  ]);
});

test('TB-46 spec-coverage keeps fs- files out of the other specs and their files out of filesystem', () => {
  const fsFiles = ['fs-unit.json', 'fs-app-existing.json', 'fs-replay-existing.json', 'fs-real.json',
    'fs-app-gate.json', 'fs-replay.json'];
  for (const spec of [model, taskboard, memory, discovery]) {
    for (const packaged of [false, true]) {
      expectLayers(spec, packaged, [...fsFiles, 'fs-app-existing-packaged.json', 'fs-real-packaged.json']
        .map((name) => [name, null]));
    }
  }
  const others = ['v1-unit.json', 'v1-models-app-existing.json', 'v1-models-replay-existing.json',
    'v1-models-real.json', 'tb-unit.json', 'tb-app-existing.json', 'tb-replay-existing.json', 'tb-real.json',
    'mem-unit.json', 'mem-app-existing.json', 'mem-replay-existing.json', 'mem-real.json', 'md-unit.json',
    'md-app-existing.json', 'md-replay-existing.json', 'md-real.json', 'md-partial-existing-app.json', 'm1-app.json',
    'm2-replay.json'];
  for (const packaged of [false, true]) {
    expectLayers(filesystem, packaged, [...others, 'md-app-existing-packaged.json', 'md-real-packaged.json',
      'mem-app-existing-packaged.json', 'tb-real-packaged.json'].map((name) => [name, null]));
  }
});

test('TB-46 spec-coverage never counts a skipped or todo FS check as passing', () => {
  const item = { id: 'FS-42', title: 't', layers: new Set(['unit']) };
  const unit = (checks) => [{ name: 'fs-unit.json', layer: 'unit', checks }];
  const ok = { name: 'FS-42 B1 splits on &&', ok: true, detail: '' };
  const skipped = { name: 'FS-42 B2 skipped', ok: false, detail: 'skipped: no reason given', skip: true };
  const todo = { name: 'FS-42 B3 marked todo', ok: true, todo: true };
  assert.equal(cellOf(item, 'unit', unit([ok]), false).state, 'ok');
  const cell = cellOf(item, 'unit', unit([ok, skipped, todo]), false);
  assert.deepEqual([cell.state, cell.passed], ['fail', 1]);
  assert.deepEqual(cell.failed.map((failed) => [failed.name, failed.flag]),
    [['FS-42 B2 skipped', 'skipped'], ['FS-42 B3 marked todo', 'todo']]);
  // 编号相近的别的条目（FS-420）不算在 FS-42 名下
  assert.equal(cellOf(item, 'unit', unit([{ name: 'FS-420 other', ok: true }]), false).state, 'missing');
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
  assert.match(run.stderr,
    /unknown --spec "board" \(expected model, taskboard, memory, discovery or filesystem\)/);
  assert.equal(run.stdout, '');
});

/** synthetic：--spec filesystem 读的结果文件（临时目录的 app/test-results/ 下），文件名 → checks */
const FS_RESULT_FILES = {
  'fs-unit.json': [{ name: 'FS-01 synthetic pass', ok: true, detail: '' },
    { name: 'FS-999 synthetic stray', ok: true, detail: '' }],
  // --only 只跑一部分时写的文件：里面通过的 FS-115 不填回放层
  'fs-partial-existing-replay.json': [{ name: 'FS-115 synthetic partial run', ok: true, detail: '' }],
  // 别的规格的结果文件：名字以 FS 编号开头的检查同样不算
  'md-replay-existing.json': [{ name: 'FS-115 synthetic check in an md- file', ok: true, detail: '' }],
  'md-unit.json': [{ name: 'FS-02 synthetic check in an md- file', ok: true, detail: '' }],
};

/**
 * @brief 在临时目录搭出仓库的样子：照抄 app/tests/spec-coverage.mjs 与 docs/specs/file-system.md，app/test-results/
 *        只放 FS_RESULT_FILES。覆盖检查按自己的位置找规格与结果，读不到真的 test-results/（那里的文件可能正被写）。
 * @return 临时目录里 app/ 的路径（测试结束时删掉整个临时目录）
 */
function fsCoverageApp(t) {
  const root = mkdtempSync(join(tmpdir(), 'mori-fs-coverage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  for (const dir of [join(app, 'tests'), join(app, 'test-results'), join(root, 'docs', 'specs')]) {
    mkdirSync(dir, { recursive: true });
  }
  copyFileSync(join(appRoot, 'tests', 'spec-coverage.mjs'), join(app, 'tests', 'spec-coverage.mjs'));
  copyFileSync(specPathOf(filesystem), join(root, 'docs', 'specs', 'file-system.md'));
  for (const [name, checks] of Object.entries(FS_RESULT_FILES)) {
    writeFileSync(join(app, 'test-results', name), JSON.stringify({ checks }));
  }
  return app;
}

/** @brief 在 fsCoverageApp 搭的目录里跑 --spec filesystem（再加 extra 参数）。 */
function runFsCoverage(app, extra) {
  return spawnSync(process.execPath, [join(app, 'tests', 'spec-coverage.mjs'), '--spec', 'filesystem', ...extra],
    { cwd: app, encoding: 'utf8' });
}

test('TB-46 spec-coverage --spec filesystem prints every FS row and counts only fs- result files', (t) => {
  const app = fsCoverageApp(t);
  const run = runFsCoverage(app, ['--allow-missing-real']);
  // 有缺口为 1；2 才是规格表或结果文件读不出
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
  assert.match(run.stdout, /^spec-coverage \(dev build\): 115 items from docs\/specs\/file-system\.md §19\.2$/m);
  assert.equal((run.stdout.match(/^FS-\d+ /gm) ?? []).length, 115);
  assert.match(run.stdout, /^ {2}unit {3}fs-unit\.json \(2 checks, /m);
  // fs-partial-*.json 与 md- 的文件都不读：回放层没有结果文件
  assert.match(run.stdout, /^ {2}replay \(no result file for Replay\)$/m);
  assert.doesNotMatch(run.stdout, /fs-partial-|md-unit|md-replay/);
  assert.match(run.stdout, /^FS-01 +ok 1 +- +- +- *$/m);
  assert.match(run.stdout, /^FS-02 +MISSING +- +- +- *$/m);
  assert.match(run.stdout, /^FS-115 +- +MISSING +MISSING +- *$/m);
  // --allow-missing-real：没有 fs-real.json 时真实层记 pending、不算缺口
  assert.match(run.stdout, /^ {2}--allow-missing-real: the real layer is pending \(owner walkthrough not run yet\)$/m);
  assert.match(run.stdout, /^FS-21 +- +- +- +pending *$/m);
  assert.match(run.stdout, /^FS-54 +MISSING +MISSING +MISSING +pending *$/m);
  assert.doesNotMatch(run.stdout, /^ {2}FS-\d+ Real: /m);
  assert.match(run.stdout,
    /\nChecks without an FS id \(not counted, 1\):\n {2}fs-unit\.json: "FS-999 synthetic stray"\n/);
  // 缺口：单元层 71 条里只有 FS-01 有结果，App 层 71 条、回放层 6 条都没有
  assert.match(run.stdout, /\nGaps \(147\):\n/);
  assert.match(run.stdout, /\nspec-coverage: FAILED\n$/);
});

test('TB-46 spec-coverage --spec filesystem without --allow-missing-real counts the real layer as missing', (t) => {
  const run = runFsCoverage(fsCoverageApp(t), []);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^FS-21 +- +- +- +MISSING *$/m);
  assert.match(run.stdout, /^FS-54 +MISSING +MISSING +MISSING +MISSING *$/m);
  assert.match(run.stdout, /^ {2}FS-114 Real: no passing check \(/m);
  // 真实层的 9 条（8 条只列真实层，另有 FS-54）也是缺口
  assert.match(run.stdout, /\nGaps \(156\):\n/);
  assert.doesNotMatch(run.stdout, /--allow-missing-real/);
});

/** synthetic：文件系统单元层的测试文件：一个通过、一个跳过、一个标为 todo、一个函数抛错的套件 */
const FLAGGED_FS_TESTS = `import { describe, test } from 'node:test';
test('FS-01 synthetic pass', () => {});
test('FS-01 synthetic skipped', { skip: 'synthetic' }, () => {});
test('FS-01 synthetic todo', { todo: true }, () => {});
describe('FS-02 synthetic suite whose function throws', () => { throw new Error('synthetic suite failure'); });
`;

test('TB-46 spec-coverage: the filesystem unit reporter (fs-reporter.mjs, fs-unit.json) is strict', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mori-fs-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  // 报告器按自己的位置找 test-results/：两份都复制到临时目录，写不到真的 fs-unit.json
  for (const name of ['reporter.mjs', 'fs-reporter.mjs']) {
    copyFileSync(join(appRoot, 'tests', 'unit', name), join(root, 'tests', 'unit', name));
  }
  writeFileSync(join(root, 'flagged.test.mjs'), FLAGGED_FS_TESTS);
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const reporter = pathToFileURL(join(root, 'tests', 'unit', 'fs-reporter.mjs')).href;
  const run = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, join(root, 'flagged.test.mjs')],
    { cwd: root, encoding: 'utf8', env });
  const { checks } = JSON.parse(readFileSync(join(root, 'test-results', 'fs-unit.json'), 'utf8'));
  const byName = new Map(checks.map((check) => [check.name, check]));
  assert.deepEqual([...byName.keys()].sort(), ['FS-01 synthetic pass', 'FS-01 synthetic skipped',
    'FS-01 synthetic todo', 'FS-02 synthetic suite whose function throws']);
  const flags = (name) => {
    const { ok, skip, todo } = byName.get(name);
    return [ok, skip, todo];
  };
  assert.deepEqual(flags('FS-01 synthetic pass'), [true, undefined, undefined]);
  assert.deepEqual(flags('FS-01 synthetic skipped'), [false, true, undefined]);
  assert.equal(byName.get('FS-01 synthetic skipped').detail, 'skipped: synthetic');
  assert.deepEqual(flags('FS-01 synthetic todo'), [false, undefined, true]);
  assert.deepEqual(flags('FS-02 synthetic suite whose function throws'), [false, undefined, undefined]);
  assert.match(byName.get('FS-02 synthetic suite whose function throws').detail, /synthetic suite failure/);
  assert.equal(checks.filter(passes).length, 1);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /1\/4 unit checks passed \(2 skipped or todo, counted as failures\)/);
});
