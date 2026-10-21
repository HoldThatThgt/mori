// tests/spec-coverage.mjs 的单元测试（docs/specs/parallel-agents-taskboard.md §17.3、§17.4）：--spec taskboard 读 §17.2
// 的 TB 条目与层、tb- 结果文件按层归类（-packaged 只在 --packaged 时计入 App 与真实层、回放只认开发构建、
// tb-partial-*.json 不计入）、不属于任何编号的检查只在这份规格的结果文件里找；不加 --spec 时模型层的规则不变。
// §17.4 把覆盖检查算进 TB-46（现有功能不退步），所以检查名以 "TB-46 spec-coverage" 开头；TB-46 只列 App 与回放两层，
// 这些单元检查不计入覆盖表，由 node --test 的退出码把关。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPECS, layerOfFile, parseSpecTable, specPathOf, startsWithId, strayChecks,
} from '../../spec-coverage.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { model, taskboard } = SPECS;

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
  assert.equal(items.length, 37);
  assert.deepEqual([...items.find((item) => item.id === 'MP-37').layers].sort(), ['app', 'replay']);
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
  assert.match(run.stderr, /unknown --spec "board" \(expected model or taskboard\)/);
  assert.equal(run.stdout, '');
});
