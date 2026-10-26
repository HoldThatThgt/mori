// 覆盖检查：读一份构建规格验收条目表的编号和每条的"层"，再读 test-results/ 里各层的结果文件；每个编号在它列出的
// 每一层都要有名字以这个编号开头、结果为通过的检查，任何一个缺少就失败。
// 同一编号同一层里有失败的检查（含标 known 的）也算没完成：通过的检查不能掩盖失败的那一条。
// 带 skip 或 todo 标记的检查不论 ok 是什么都算失败（tests/unit/reporter.mjs 的严格模式写这两个标记，md-reporter.mjs
// 用它；负责人为一键拉取模型规格 §13.3“不留未完成项”定的规则：跳过的与 todo 的测试不算通过）。
// 其他规格的结果文件里没有这两个标记，结论不变。
// --spec 选规格（默认 model）：
//   model      docs/specs/model-providers.md §14.2（§14.3），编号 MP-n
//   taskboard  docs/specs/parallel-agents-taskboard.md §17.2（§17.3），编号 TB-n
//   memory     docs/specs/memory.md §14.2（§14.3），编号 MEM-n
//   discovery  docs/specs/model-discovery.md §13.2（§13.3），编号 MD-n
// 层由结果文件决定（模型层 §14.3，TaskBoard §17.3，记忆 §14.3，一键拉取模型 §13.3）：
//   层    model                                       taskboard                           memory
//   单元  v1-unit.json（tests/unit/reporter.mjs）      tb-unit.json（tb-reporter.mjs）     mem-unit.json（mem-reporter.mjs）
//   App   v1-models-app*.json（含 -existing）         tb-app*.json（含 -existing）        mem-app*.json（含 -existing）
//   回放  v1-models-replay*.json（含 -existing）      tb-replay*.json（含 -existing）     mem-replay*.json（含 -existing）
//   真实  v1-models-real.json                         tb-real.json                        mem-real.json
//   discovery：单元 md-unit.json（md-reporter.mjs，严格模式），App md-app*.json（含 -existing），
//   回放 md-replay*.json（含 -existing），真实 md-real.json。
// TaskBoard 的 tb-partial-*.json、记忆的 mem-partial-*.json、一键拉取模型的 md-partial-*.json（--only 只跑一部分时写的）
// 不计入任何层。
// 只认开发构建的结果；--packaged 时 App 与真实层改读带 -packaged 的结果文件（v1-models-app*-packaged.json、
// v1-models-real-packaged.json；tb-app*-packaged.json、tb-real-packaged.json；mem-app*-packaged.json、
// mem-real-packaged.json；md-app*-packaged.json、md-real-packaged.json）。单元与回放不经过 Mori 的构建
// （单元直接导入打包后的内核模块，回放在 harness 里载入界面），两种模式读同一份；带 -packaged 的回放结果不计入。
// 不以这份规格的编号开头的检查只列出、不计入；它们只在这份规格的结果文件里找。以这份规格的前缀开头、编号却不在验收表里的
// 检查算缺口（2026-10-26 负责人的规则“不做规格没写的东西”，AGENTS.md）：规格没写的东西不该有测试，编号写错的测试也不算数。
// --allow-missing-real：真实层的结果文件还不存在时把真实层记为 pending、不算失败（负责人走查之前用）；最终一遍不能带它。
// 用法（在 app/ 下）：
//   node tests/spec-coverage.mjs [--spec model|taskboard|memory|discovery] [--packaged] [--allow-missing-real]
// 退出码：全部覆盖为 0，有缺口为 1，规格名不认识、规格表或结果文件读不出为 2。
// 下面的函数导出给 tests/unit/taskboard/spec-coverage.test.mjs 检查；直接运行时才做检查。
// 记忆规格的 --spec memory 在这台机器上带 --allow-missing-real 运行（真实层由负责人用数据目录跑，记忆规格 §0 第 4 条）。
// 一键拉取模型的 --spec discovery 同样（npm run test:discovery 的最后一步）；真实层 MD-14 由负责人用数据目录跑
// md-real.mjs，最终一遍不带 --allow-missing-real（规格 §13.3）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const resultsDir = join(appRoot, 'test-results');

/**
 * @brief 各规格的覆盖检查参数。
 *        path 相对仓库根目录；section 为验收条目表所在小节的编号；row 认出条目行；prefix 为编号前缀（用于提示）；
 *        strayLabel 为不计入的检查的说明；files 为各层结果文件的名字（unit、real 为全名与不带 .json 的名字，
 *        app、replay 为前缀，partial 为不计入任何层的前缀，没有时为 null）；unitGlob 为单元测试文件（相对 app/，
 *        只认 "<目录>*.test.mjs"，不往下一层找），package.json 里用写 files.unit 的报告器跑它的脚本写的是同一串
 *        （tests/unit/spec-ids.test.mjs 查这一点，并按它认单元层的测试）。
 */
export const SPECS = {
  model: {
    path: 'docs/specs/model-providers.md',
    section: '14.2',
    row: /^\|\s*MP-\d+\s*\|/,
    prefix: 'MP',
    strayLabel: 'an MP id',
    unitGlob: 'tests/unit/*.test.mjs',
    files: { unit: 'v1-unit.json', app: 'v1-models-app', replay: 'v1-models-replay', real: 'v1-models-real',
      partial: null },
  },
  taskboard: {
    path: 'docs/specs/parallel-agents-taskboard.md',
    section: '17.2',
    row: /^\|\s*TB-\d+\s*\|/,
    prefix: 'TB',
    strayLabel: 'a TB id',
    unitGlob: 'tests/unit/taskboard/*.test.mjs',
    files: { unit: 'tb-unit.json', app: 'tb-app', replay: 'tb-replay', real: 'tb-real', partial: 'tb-partial-' },
  },
  memory: {
    path: 'docs/specs/memory.md',
    section: '14.2',
    row: /^\|\s*MEM-\d+\s*\|/,
    prefix: 'MEM',
    strayLabel: 'a MEM id',
    unitGlob: 'tests/unit/memory/*.test.mjs',
    files: { unit: 'mem-unit.json', app: 'mem-app', replay: 'mem-replay', real: 'mem-real', partial: 'mem-partial-' },
  },
  discovery: {
    path: 'docs/specs/model-discovery.md',
    section: '13.2',
    row: /^\|\s*MD-\d+\s*\|/,
    prefix: 'MD',
    strayLabel: 'an MD id',
    unitGlob: 'tests/unit/discovery/*.test.mjs',
    files: { unit: 'md-unit.json', app: 'md-app', replay: 'md-replay', real: 'md-real', partial: 'md-partial-' },
  },
};

/** @brief 规格名的列表文字："model, taskboard, memory or discovery"（规格名不认识时的提示）。 */
export function specNames() {
  const names = Object.keys(SPECS);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
}

/** 规格里的层名 → 内部名 */
const LAYER_NAMES = { 单元: 'unit', App: 'app', 回放: 'replay', 真实: 'real' };
/** 打印时各层的顺序与表头 */
const LAYERS = [['unit', 'Unit'], ['app', 'App'], ['replay', 'Replay'], ['real', 'Real']];

/** @brief 规格文件的绝对路径。 */
export const specPathOf = (spec) => resolve(appRoot, '..', spec.path);

/**
 * @brief 读一份规格的验收条目表（只认表格行，单元格按 "|" 分开，层在最后一列）。
 * @param spec SPECS 中的一项
 * @param text 规格全文
 * @return [{ id, title, layers: Set<'unit'|'app'|'replay'|'real'> }]，按表里的顺序
 */
export function parseSpecTable(spec, text) {
  const specPath = specPathOf(spec);
  const start = text.indexOf(`### ${spec.section}`);
  if (start < 0) throw new Error(`${specPath}: section ${spec.section} not found`);
  const end = text.indexOf('\n### ', start + 1);
  const rows = text.slice(start, end < 0 ? undefined : end).split(/\r?\n/).filter((line) => spec.row.test(line));
  const items = rows.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell, i, all) => i > 0 && i < all.length - 1);
    const id = cells[0];
    const layerCell = cells.at(-1);
    const names = layerCell.split(/[、,，]/).map((name) => name.trim()).filter(Boolean);
    const unknown = names.filter((name) => !(name in LAYER_NAMES));
    if (unknown.length) throw new Error(`${id}: unknown layer ${unknown.join(', ')} in "${layerCell}"`);
    return { id, title: cells[1], layers: new Set(names.map((name) => LAYER_NAMES[name])) };
  });
  if (items.length === 0) throw new Error(`${specPath}: no ${spec.prefix} rows in section ${spec.section}`);
  const ids = items.map((item) => item.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length) throw new Error(`${specPath}: repeated ids ${repeated.join(', ')}`);
  return items;
}

/**
 * @brief 结果文件名属于哪一层。
 * @param spec SPECS 中的一项
 * @param name test-results/ 下的文件名
 * @param packaged 是否在检查打包构建（--packaged）
 * @return 'unit'|'app'|'replay'|'real'；不属于任何一层（或不是这次模式的文件）时为 null
 */
export function layerOfFile(spec, name, packaged) {
  const files = spec.files;
  if (!name.endsWith('.json')) return null;
  if (files.partial && name.startsWith(files.partial)) return null;
  const isPackaged = name.endsWith('-packaged.json');
  if (name === files.unit) return 'unit';
  if (name.startsWith(files.replay) && !isPackaged) return 'replay';
  if (name.startsWith(files.app)) return isPackaged === packaged ? 'app' : null;
  if (name === `${files.real}${packaged ? '-packaged' : ''}.json`) return 'real';
  return null;
}

/**
 * @brief 读各层的结果文件。
 * @return { files: [{ name, layer, checks, mtime }], problems: string[] }
 */
function readResults(spec, packaged) {
  const files = [];
  const problems = [];
  const names = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
  for (const name of names.sort()) {
    const layer = layerOfFile(spec, name, packaged);
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
export const startsWithId = (name, id) => new RegExp(`^${id}(?!\\d)`).test(String(name));

/** @brief 检查带的跳过 / todo 标记（严格模式的单元报告器写的 skip、todo）：'skipped'、'todo'，没有时为 null。 */
export const flagOfCheck = (check) => (check.skip ? 'skipped' : check.todo ? 'todo' : null);

/** @brief 一条检查是否算通过：ok 为 true，并且没有跳过 / todo 标记。 */
export const passes = (check) => check.ok === true && !flagOfCheck(check);

/**
 * @brief 一个编号在一层的结论。
 * @param item parseSpecTable 的一项
 * @param layer 'unit'|'app'|'replay'|'real'
 * @param files readResults 读到的结果文件（{ name, layer, checks }）
 * @param pending 真实层没有结果文件且带了 --allow-missing-real
 * @return { state: 'ok'|'fail'|'missing'|'pending'|'n/a', passed, failed: [{ name, file, known, flag, detail }] }；
 *         flag 为 flagOfCheck 的结果（带跳过 / todo 标记的检查算失败）
 */
export function cellOf(item, layer, files, pending) {
  if (!item.layers.has(layer)) return { state: 'n/a', passed: 0, failed: [] };
  const checks = files.filter((file) => file.layer === layer)
    .flatMap((file) => file.checks.map((check) => ({ ...check, file: file.name })))
    .filter((check) => startsWithId(check.name, item.id));
  const passed = checks.filter(passes).length;
  const failed = checks.filter((check) => !passes(check)).map((check) => ({ name: check.name, file: check.file,
    known: Boolean(check.known), flag: flagOfCheck(check), detail: String(check.detail ?? '') }));
  if (layer === 'real' && pending) return { state: 'pending', passed, failed };
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

/** @brief 检查名开头的这份规格的编号（"TB-12 …" 为 "TB-12"）；不以这个前缀的编号开头时为 null。 */
export const idOfCheck = (spec, check) => new RegExp(`^${spec.prefix}-\\d+`).exec(String(check.name))?.[0] ?? null;

/** @brief 列出一条检查的文字：文件名、检查名（截到 100 字符），不算通过的（见 passes）带 (FAIL)。 */
const checkLine = (file, check) =>
  `${file.name}: "${String(check.name).slice(0, 100)}"${passes(check) ? '' : ' (FAIL)'}`;

/**
 * @brief 这份规格的结果文件里不以这份规格的编号开头的检查（只列出、不计入）。
 * @return 每条一行文字（checkLine）
 */
export function strayChecks(spec, files) {
  return files.flatMap((file) => file.checks.filter((check) => idOfCheck(spec, check) === null)
    .map((check) => checkLine(file, check)));
}

/**
 * @brief 名字以这份规格的编号开头、编号却不在验收表里的检查：算缺口（见文件开头，不做规格没写的东西）。
 * @return 每条一行文字（checkLine）
 */
export function unknownIdChecks(spec, items, files) {
  const ids = new Set(items.map((item) => item.id));
  const unknown = (check) => {
    const id = idOfCheck(spec, check);
    return id !== null && !ids.has(id);
  };
  return files.flatMap((file) => file.checks.filter(unknown).map((check) => checkLine(file, check)));
}

/** @brief 打印表格与缺口，返回有没有缺口。 */
function report(spec, items, files, pending) {
  const width = [8, ...LAYERS.map(() => 12)];
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(width[i])).join(' ');
  console.log(line(['Id', ...LAYERS.map(([, title]) => title)]));
  const gaps = [];
  for (const item of items) {
    const cells = LAYERS.map(([layer]) => cellOf(item, layer, files, pending));
    console.log(line([item.id, ...cells.map(cellText)]));
    LAYERS.forEach(([, title], i) => {
      const cell = cells[i];
      if (cell.state === 'missing') gaps.push(`${item.id} ${title}: no passing check (${item.title})`);
      for (const failed of cell.state === 'fail' ? cell.failed : []) {
        const flag = failed.flag ? ` (${failed.flag})` : '';
        gaps.push(`${item.id} ${title}: ${failed.known ? 'KNOWN ' : ''}FAIL${flag} "${failed.name}" in ${failed.file}`
          + `${failed.detail ? ` — ${failed.detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      }
    });
  }
  for (const line of unknownIdChecks(spec, items, files)) gaps.push(`${line}: not an id in §${spec.section}`);
  const strays = strayChecks(spec, files);
  if (strays.length) {
    console.log(`\nChecks without ${spec.strayLabel} (not counted, ${strays.length}):`);
    for (const stray of strays.slice(0, 20)) console.log(`  ${stray}`);
    if (strays.length > 20) console.log(`  … ${strays.length - 20} more`);
  }
  if (gaps.length) {
    console.log(`\nGaps (${gaps.length}):`);
    for (const gap of gaps) console.log(`  ${gap}`);
  }
  return gaps.length > 0;
}

/** @brief 打印读到的结果文件与真实层的说明；返回真实层是否记为 pending。 */
function printSources(spec, items, files, options) {
  const mode = options.packaged ? 'packaged build' : 'dev build';
  console.log(`spec-coverage (${mode}): ${items.length} items from ${spec.path} §${spec.section}`);
  for (const file of files) {
    console.log(`  ${file.layer.padEnd(6)} ${file.name} (${file.checks.length} checks, ${file.mtime.toISOString()})`);
  }
  for (const [layer, title] of LAYERS) {
    if (!files.some((file) => file.layer === layer)) console.log(`  ${layer.padEnd(6)} (no result file for ${title})`);
  }
  const realMissing = !files.some((file) => file.layer === 'real');
  if (options.allowMissingReal) {
    console.log(realMissing ? '  --allow-missing-real: the real layer is pending (owner walkthrough not run yet)'
      : '  --allow-missing-real given, but the real result file exists: it is checked as usual');
  }
  console.log('');
  return realMissing && options.allowMissingReal;
}

/** @brief 解析命令行、读规格与结果、打印并设置退出码。 */
function main(argv) {
  const specIndex = argv.indexOf('--spec');
  const specName = specIndex > 0 ? argv[specIndex + 1] : 'model';
  const options = { packaged: argv.includes('--packaged'), allowMissingReal: argv.includes('--allow-missing-real') };
  const spec = Object.hasOwn(SPECS, specName) ? SPECS[specName] : null;
  let items;
  let results;
  try {
    if (!spec) throw new Error(`unknown --spec "${specName}" (expected ${specNames()})`);
    items = parseSpecTable(spec, readFileSync(specPathOf(spec), 'utf8'));
    results = readResults(spec, options.packaged);
  } catch (error) {
    console.error(`spec-coverage: ${error.message}`);
    process.exit(2);
  }
  const { files, problems } = results;
  const pending = printSources(spec, items, files, options);
  const gaps = report(spec, items, files, pending);
  for (const problem of problems) console.error(`spec-coverage: ${problem}`);
  if (problems.length) process.exit(2);
  console.log(gaps ? '\nspec-coverage: FAILED' : '\nspec-coverage: every item is covered on every listed layer');
  process.exitCode = gaps ? 1 : 0;
}

if (import.meta.main) main(process.argv);
