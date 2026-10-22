// 覆盖检查（docs/specs/model-providers.md §14.3）：读规格 §14.2 验收条目表的编号和每条的"层"，再读 test-results/ 里
// 各层的结果文件；每个编号在它列出的每一层都要有名字以这个编号开头、结果为通过的检查，任何一个缺少就失败。
// 同一编号同一层里有失败的检查（含标 known 的）也算没完成：通过的检查不能掩盖失败的那一条。
// 层由结果文件决定（§14.3）：
//   单元  test-results/v1-unit.json（node --test 的结果，tests/unit/reporter.mjs 写的）
//   App   test-results/v1-models-app*.json（含 v1-models-app-existing.json）
//   回放  test-results/v1-models-replay*.json（含 v1-models-replay-existing.json）
//   真实  test-results/v1-models-real.json
// 只认开发构建的结果；--packaged 时 App 与真实层改读带 -packaged 的结果文件（v1-models-app*-packaged.json、
// v1-models-real-packaged.json）。单元与回放不经过 Mori 的构建（单元直接导入打包后的内核模块，回放在 harness 里载入界面），
// 两种模式读同一份。
// --allow-missing-real：真实层的结果文件还不存在时把真实层记为 pending、不算失败（负责人走查之前用）；最终一遍不能带它。
// 用法（在 app/ 下）：node tests/spec-coverage.mjs [--packaged] [--allow-missing-real]
// 退出码：全部覆盖为 0，有缺口为 1，规格表或结果文件读不出为 2。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const specPath = resolve(appRoot, '../docs/specs/model-providers.md');
const resultsDir = join(appRoot, 'test-results');
const packaged = process.argv.includes('--packaged');
const allowMissingReal = process.argv.includes('--allow-missing-real');

/** 规格里的层名 → 内部名 */
const LAYER_NAMES = { 单元: 'unit', App: 'app', 回放: 'replay', 真实: 'real' };
/** 打印时各层的顺序与表头 */
const LAYERS = [['unit', 'Unit'], ['app', 'App'], ['replay', 'Replay'], ['real', 'Real']];

/**
 * @brief 读规格 §14.2 的验收条目表。
 * @return [{ id, title, layers: Set<'unit'|'app'|'replay'|'real'> }]，按表里的顺序
 */
function readSpecTable() {
  const text = readFileSync(specPath, 'utf8');
  const start = text.indexOf('### 14.2');
  if (start < 0) throw new Error(`${specPath}: section 14.2 not found`);
  const end = text.indexOf('\n### ', start + 1);
  const rows = text.slice(start, end < 0 ? undefined : end).split(/\r?\n/)
    .filter((line) => /^\|\s*MP-\d+\s*\|/.test(line));
  const items = rows.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell, i, all) => i > 0 && i < all.length - 1);
    const id = cells[0];
    const layerCell = cells.at(-1);
    const names = layerCell.split(/[、,，]/).map((name) => name.trim()).filter(Boolean);
    const unknown = names.filter((name) => !(name in LAYER_NAMES));
    if (unknown.length) throw new Error(`${id}: unknown layer ${unknown.join(', ')} in "${layerCell}"`);
    return { id, title: cells[1], layers: new Set(names.map((name) => LAYER_NAMES[name])) };
  });
  if (items.length === 0) throw new Error(`${specPath}: no MP rows in section 14.2`);
  const ids = items.map((item) => item.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length) throw new Error(`${specPath}: repeated ids ${repeated.join(', ')}`);
  return items;
}

/** @brief 结果文件名属于哪一层；不属于任何一层（或不是这次模式的文件）时为 null。 */
function layerOfFile(name) {
  if (!name.endsWith('.json')) return null;
  const isPackaged = name.endsWith('-packaged.json');
  if (name === 'v1-unit.json') return 'unit';
  if (/^v1-models-replay.*\.json$/.test(name) && !isPackaged) return 'replay';
  if (/^v1-models-app.*\.json$/.test(name)) return isPackaged === packaged ? 'app' : null;
  if (name === (packaged ? 'v1-models-real-packaged.json' : 'v1-models-real.json')) return 'real';
  return null;
}

/**
 * @brief 读各层的结果文件。
 * @return { files: [{ name, layer, checks, mtime }], problems: string[] }
 */
function readResults() {
  const files = [];
  const problems = [];
  const names = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
  for (const name of names.sort()) {
    const layer = layerOfFile(name);
    if (!layer) continue;
    const path = join(resultsDir, name);
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(data.checks)) throw new Error('no "checks" array');
      files.push({ name, layer, checks: data.checks, mtime: statSync(path).mtime });
    } catch (error) {
      problems.push(`${name}: cannot read (${error.message})`);
    }
  }
  return { files, problems };
}

/** @brief 检查名是否以 id 开头（MP-1 不匹配 MP-10）。 */
const startsWithId = (name, id) => new RegExp(`^${id}(?!\\d)`).test(String(name));

/**
 * @brief 一个编号在一层的结论。
 * @return { state: 'ok'|'fail'|'missing'|'pending'|'n/a', passed, failed: [{ name, file }] }
 */
function cellOf(item, layer, files, realMissing) {
  if (!item.layers.has(layer)) return { state: 'n/a', passed: 0, failed: [] };
  const checks = files.filter((file) => file.layer === layer)
    .flatMap((file) => file.checks.map((check) => ({ ...check, file: file.name })))
    .filter((check) => startsWithId(check.name, item.id));
  const passed = checks.filter((check) => check.ok === true).length;
  const failed = checks.filter((check) => check.ok !== true).map((check) => ({ name: check.name, file: check.file,
    known: Boolean(check.known), detail: String(check.detail ?? '') }));
  if (layer === 'real' && realMissing && allowMissingReal) return { state: 'pending', passed, failed };
  if (failed.length) return { state: 'fail', passed, failed };
  return { state: passed > 0 ? 'ok' : 'missing', passed, failed };
}

/** @brief 单元格的文字。 */
function cellText(cell) {
  switch (cell.state) {
    case 'n/a': return '-';
    case 'ok': return `ok ${cell.passed}`;
    case 'missing': return 'MISSING';
    case 'pending': return 'pending';
    default: return `FAIL ${cell.failed.length}/${cell.passed + cell.failed.length}`;
  }
}

/** @brief 打印表格与缺口，返回有没有缺口。 */
function report(items, files, realMissing) {
  const width = [8, ...LAYERS.map(() => 12)];
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(width[i])).join(' ');
  console.log(line(['Id', ...LAYERS.map(([, title]) => title)]));
  const gaps = [];
  for (const item of items) {
    const cells = LAYERS.map(([layer]) => cellOf(item, layer, files, realMissing));
    console.log(line([item.id, ...cells.map(cellText)]));
    LAYERS.forEach(([layer, title], i) => {
      const cell = cells[i];
      if (cell.state === 'missing') gaps.push(`${item.id} ${title}: no passing check (${item.title})`);
      for (const failed of cell.state === 'fail' ? cell.failed : []) {
        gaps.push(`${item.id} ${title}: ${failed.known ? 'KNOWN ' : ''}FAIL "${failed.name}" in ${failed.file}`
          + `${failed.detail ? ` — ${failed.detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      }
    });
  }
  const strays = files.flatMap((file) => file.checks.filter((check) => !items.some((item) => startsWithId(check.name,
    item.id))).map((check) => `${file.name}: "${String(check.name).slice(0, 100)}"${check.ok ? '' : ' (FAIL)'}`));
  if (strays.length) {
    console.log(`\nChecks without an MP id (not counted, ${strays.length}):`);
    for (const stray of strays.slice(0, 20)) console.log(`  ${stray}`);
    if (strays.length > 20) console.log(`  … ${strays.length - 20} more`);
  }
  if (gaps.length) {
    console.log(`\nGaps (${gaps.length}):`);
    for (const gap of gaps) console.log(`  ${gap}`);
  }
  return gaps.length > 0;
}

let items;
let results;
try {
  items = readSpecTable();
  results = readResults();
} catch (error) {
  console.error(`spec-coverage: ${error.message}`);
  process.exit(2);
}
const { files, problems } = results;
const mode = packaged ? 'packaged build' : 'dev build';
console.log(`spec-coverage (${mode}): ${items.length} items from docs/specs/model-providers.md §14.2`);
for (const file of files) {
  console.log(`  ${file.layer.padEnd(6)} ${file.name} (${file.checks.length} checks, ${file.mtime.toISOString()})`);
}
for (const [layer, title] of LAYERS) {
  if (!files.some((file) => file.layer === layer)) console.log(`  ${layer.padEnd(6)} (no result file for ${title})`);
}
const realMissing = !files.some((file) => file.layer === 'real');
if (allowMissingReal) {
  console.log(realMissing ? '  --allow-missing-real: the real layer is pending (owner walkthrough not run yet)'
    : '  --allow-missing-real given, but the real result file exists: it is checked as usual');
}
console.log('');
const gaps = report(items, files, realMissing);
for (const problem of problems) console.error(`spec-coverage: ${problem}`);
if (problems.length) process.exit(2);
console.log(gaps ? '\nspec-coverage: FAILED' : '\nspec-coverage: every item is covered on every listed layer');
process.exitCode = gaps ? 1 : 0;
