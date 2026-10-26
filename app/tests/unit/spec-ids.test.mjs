// 2026-10-26 负责人的规则（AGENTS.md“不留未完成项，不做规格外的东西”）的单元层检查：只读测试的源码与 package.json、
// 不跑测试，所以每次改动跑的 npm run test:unit 就会查到；测试是否通过由推送前的 spec-coverage 按结果文件查（测试分层第 3 条）。
// 对 tests/spec-coverage.mjs 的 SPECS 里的每份规格查三项：
//   1. 验收表的每个编号，在它列出的每一层都有测试写好；
//   2. 测试里用到的这份规格的编号都在表里；
//   3. 接好了：package.json 有脚本用写这份规格单元结果（files.unit）的报告器跑 unitGlob，有脚本跑这份规格的
//      spec-coverage，用到这份规格编号的 App、回放套件都在某个脚本里（真实层的脚本由负责人用数据目录跑，不查）。
// 一个编号算“有测试”：测试文件里有一个字面量（字符串、没有插值的模板字符串、模板字符串开头一段）以这个编号开头。
// 字面量从 TypeScript 的语法树里取，注释不在语法树里，所以注释里提到的编号不算。
// 层与覆盖检查认结果文件的办法一致：单元为 unitGlob 那个目录里的 *.test.mjs（不往下一层找）；tests/ui/ 下的脚本
// 按“脚本名.json”交给 spec-coverage.mjs 的 layerOfFile 归层（套件的结果文件与脚本同名），*-helpers.mjs 不算；
// v1-models-existing.mjs 按预设把现有套件的结果记在编号下，算 App 与回放。录制脚本、报告器、harness/ 都不算任何一层。
// 覆盖检查的单元测试（tests/unit/taskboard/spec-coverage.test.mjs）用编造的编号检查规则，不算。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SPECS, layerOfFile, parseSpecTable, specPathOf } from '../spec-coverage.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 用编造的编号检查覆盖规则的文件（相对 app/，/ 分隔），不算 */
const MADE_UP_IDS = new Set(['tests/unit/taskboard/spec-coverage.test.mjs']);
/** 按预设把现有套件的结果记在编号下的脚本，算 App 与回放 */
const EXISTING = 'tests/ui/v1-models-existing.mjs';
/** 算字面量的语法树节点 */
const LITERALS = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead]);

/**
 * @brief 要读的测试源码。
 * @param dir 从这个目录往下找（默认 app/tests）
 * @return 相对 app/ 的路径（/ 分隔）；fixtures/ 目录不读
 */
function testFiles(dir = join(appRoot, 'tests')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(path);
    return /\.(mjs|js|jsx)$/.test(entry.name) ? [relative(appRoot, path).replaceAll('\\', '/')] : [];
  });
}

/**
 * @brief 一个文件里全部字面量的文字（注释不在语法树里）。
 * @param file 相对 app/ 的路径
 * @return 字面量的值，按源码顺序
 */
function literalsOf(file) {
  const text = readFileSync(join(appRoot, file), 'utf8');
  const kind = file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found = [];
  const visit = (node) => {
    if (LITERALS.has(node.kind)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * @brief 这份规格的单元测试目录（unitGlob 去掉 "*.test.mjs"）。
 * @return 例如 'tests/unit/taskboard/'；unitGlob 不是 "<目录>*.test.mjs" 的样子时抛错
 */
function unitDirOf(spec) {
  const match = /^(tests\/unit\/(?:[\w-]+\/)?)\*\.test\.mjs$/.exec(spec.unitGlob ?? '');
  if (!match) throw new Error(`${spec.prefix}: unitGlob must look like "tests/unit/<dir>/*.test.mjs"`);
  return match[1];
}

/**
 * @brief 一个测试文件在这份规格里算哪几层（见文件开头）。
 * @param spec SPECS 中的一项
 * @param file 相对 app/ 的路径（/ 分隔）
 * @return 'unit' | 'app' | 'replay' | 'real' 的列表；不属于这份规格的任何一层时为空
 */
function layersOf(spec, file) {
  const unitDir = unitDirOf(spec);
  const rest = file.startsWith(unitDir) ? file.slice(unitDir.length) : '';
  if (/^[^/]+\.test\.mjs$/.test(rest)) return ['unit'];
  if (file === EXISTING) return ['app', 'replay'];
  const ui = /^tests\/ui\/([^/]+)\.mjs$/.exec(file);
  if (!ui || ui[1].endsWith('-helpers')) return [];
  const layer = layerOfFile(spec, `${ui[1]}.json`, false);
  return layer && layer !== 'unit' ? [layer] : [];
}

/**
 * @brief 测试里以这份规格的编号开头的字面量。
 * @param spec SPECS 中的一项
 * @param literals Map<文件, 字面量列表>
 * @return Map<编号, { layers: Set<层>, files: Set<文件> }>
 */
function idsInTests(spec, literals) {
  const pattern = new RegExp(`^${spec.prefix}-\\d+(?!\\d)`);
  const found = new Map();
  for (const [file, texts] of literals) {
    if (MADE_UP_IDS.has(file)) continue;
    for (const id of texts.map((text) => pattern.exec(text)?.[0]).filter(Boolean)) {
      if (!found.has(id)) found.set(id, { layers: new Set(), files: new Set() });
      for (const layer of layersOf(spec, file)) found.get(id).layers.add(layer);
      found.get(id).files.add(file);
    }
  }
  return found;
}

/**
 * @brief 一份规格没接好的地方（见文件开头第 3 项）。
 * @param name SPECS 里的名字（spec-coverage 的 --spec；model 也可以不带 --spec）
 * @param spec SPECS 中的一项
 * @param found idsInTests 的结果
 * @return 每处一行文字
 */
function wiringGaps(name, spec, found) {
  const scripts = Object.values(JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).scripts);
  const writesUnit = (reporter) => readFileSync(join(appRoot, reporter), 'utf8')
    .includes(`createReporter('${spec.files.unit}')`);
  const gaps = [];
  const runs = (script) => [...script.matchAll(/--test-reporter=\.\/(tests\/unit\/[\w-]+\.mjs) "([^"]+)"/g)];
  const unitRun = scripts.some((script) => runs(script)
    .some(([, reporter, glob]) => glob === spec.unitGlob && writesUnit(reporter)));
  if (!unitRun) gaps.push(`no npm script runs "${spec.unitGlob}" with a reporter writing ${spec.files.unit}`);
  const coverageRun = scripts.some((script) => [...script.matchAll(/tests\/spec-coverage\.mjs(?: --spec ([\w-]+))?/g)]
    .some(([, named]) => (named ?? 'model') === name));
  if (!coverageRun) gaps.push(`no npm script runs tests/spec-coverage.mjs --spec ${name}`);
  const suites = new Set([...found.values()].flatMap((where) => [...where.files]));
  for (const file of [...suites].sort()) {
    const counted = layersOf(spec, file).some((layer) => layer === 'app' || layer === 'replay');
    if (counted && !scripts.some((script) => script.includes(`node ${file}`))) {
      gaps.push(`${file} names ${spec.prefix} ids but no npm script runs it`);
    }
  }
  return gaps;
}

const literals = new Map(testFiles().map((file) => [file, literalsOf(file)]));

for (const [name, spec] of Object.entries(SPECS)) {
  const items = () => parseSpecTable(spec, readFileSync(specPathOf(spec), 'utf8'));
  const where = `${spec.path} §${spec.section}`;

  test(`spec ids (${name}): every ${spec.prefix} item in ${where} has a test for each listed layer`, () => {
    const found = idsInTests(spec, literals);
    const gaps = items().flatMap((item) => [...item.layers].filter((layer) => !found.get(item.id)?.layers.has(layer))
      .map((layer) => `${item.id} ${layer}: no test is named with it (${item.title})`));
    assert.deepEqual(gaps, []);
  });

  test(`spec ids (${name}): every ${spec.prefix} id the tests use is an item in ${where}`, () => {
    const ids = new Set(items().map((item) => item.id));
    const extra = [...idsInTests(spec, literals)].filter(([id]) => !ids.has(id))
      .map(([id, place]) => `${id} in ${[...place.files].join(', ')}`);
    assert.deepEqual(extra, []);
  });

  test(`spec ids (${name}): npm scripts run its unit tests, its spec-coverage and every App and replay suite it names`,
    () => {
      assert.deepEqual(wiringGaps(name, spec, idsInTests(spec, literals)), []);
    });
}
