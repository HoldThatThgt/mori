// 2026-10-26 负责人的规则（AGENTS.md“不留未完成项，不做规格外的东西”）的单元层检查：只读测试的源码与 package.json、
// 不跑测试，所以每次改动跑的 npm run test:unit 就会查到；测试是否通过由推送前的 spec-coverage 按结果文件查（测试分层第 3 条）。
// 对 tests/spec-coverage.mjs 的 SPECS 里的每份规格查四项：
//   1. 验收表的每个编号，在它列出的每一层都有测试写好；
//   2. 测试里用到的这份规格的编号都在表里；
//   3. 以编号命名的测试不是空的：test()/it() 没有函数或函数体是空的、record(…, true) 写死通过，都算没写；
//   4. 接好了：package.json 有 node --test 命令用写这份规格单元结果（files.unit）的报告器跑一个 "tests/unit/<目录>*.test.mjs"，
//      有命令跑这份规格的 spec-coverage，用到这份规格编号的 App、回放套件都有命令整套跑（不带 --only、--exe 等改结果文件名的参数），
//      v1-models-existing.mjs 里用到的编号都有命令跑它的预设（--id <编号>；不带 --id 时为脚本的默认编号）。
//      真实层的脚本由负责人用数据目录跑，不查。
// 一个编号算“有测试”：测试文件里有一个会成为检查名的字面量（字符串、没有插值的模板字符串、模板字符串开头一段）以这个编号开头。
// 字面量从 TypeScript 的语法树里取，注释不在语法树里；传给 Playwright 输入与定位（fill、type、press、locator、getBy…）的、
// 传给 describe/suite 的（报告器不记套件）、对象属性值里的数组（步骤表、ids 列表，只在出错时记）不算。
// 层与覆盖检查认结果文件的办法一致：单元为上面那条 node --test 命令的目录里的 *.test.mjs（不往下一层找）；tests/ui/ 下的脚本
// 按“脚本名.json”交给 spec-coverage.mjs 的 layerOfFile 归层（套件的结果文件与脚本同名），*-helpers.mjs 不算；真实层的驱动
// 拆成的模块 <真实层文件名>-*.mjs（例如 fs-real-perm.mjs，检查记进 fs-real.json）算真实层；
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
/** 传给这些调用的文字不会成为检查名：Playwright 的输入与定位，node:test 的套件 */
const NOT_A_NAME = /^(fill|type|press|pressSequentially|locator|getBy[A-Za-z]+|describe|suite)$/;
/** 带这些参数的命令不写（或不按脚本名写）覆盖检查认的结果文件 */
const NOT_FULL_RUN = ['--only', '--exe', '--app-file', '--replay-file'];

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

/** @brief 调用的名字：foo(…) 为 foo，a.b.foo(…) 为 foo。 */
const calleeName = (call) => (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
  : ts.isIdentifier(call.expression) ? call.expression.text : '');

/**
 * @brief 字面量会不会成为检查名（见文件开头）。
 * @param node 字面量节点（语法树带 parent）
 */
function namesCheck(node) {
  let at = node.kind === ts.SyntaxKind.TemplateHead ? node.parent : node;
  while (ts.isBinaryExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const parent = at.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(at)) return !NOT_A_NAME.test(calleeName(parent));
  return !(ts.isArrayLiteralExpression(parent) && ts.isPropertyAssignment(parent.parent));
}

/**
 * @brief 一个调用是不是空的测试：test()/it()（含 .only）没有函数或函数体是空的，或 record(名字, true …) 写死通过。
 * @param call 调用节点
 * @return 是空的测试时为它的名字（第一个参数的字面量文字），否则为 null
 */
function placeholderName(call) {
  const [first, second] = call.arguments;
  if (!first || !LITERALS.has(first.kind) && first.kind !== ts.SyntaxKind.TemplateExpression) return null;
  const name = first.kind === ts.SyntaxKind.TemplateExpression ? first.head.text : first.text;
  const callee = calleeName(call);
  if (callee === 'record') return second?.kind === ts.SyntaxKind.TrueKeyword ? name : null;
  if (callee !== 'test' && callee !== 'it' && !/^(test|it)\.only$/.test(call.expression.getText())) return null;
  const body = call.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))?.body;
  return !body || ts.isBlock(body) && body.statements.length === 0 ? name : null;
}

/**
 * @brief 读一个文件：会成为检查名的字面量与空的测试（注释不在语法树里）。
 * @param file 相对 app/ 的路径
 * @return { names: string[], placeholders: string[] }：placeholders 为 "<名字> (<文件>:<行>)"
 */
function scan(file) {
  const text = readFileSync(join(appRoot, file), 'utf8');
  const kind = file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const result = { names: [], placeholders: [] };
  const visit = (node) => {
    if (LITERALS.has(node.kind) && (file === EXISTING || namesCheck(node))) result.names.push(node.text);
    const empty = ts.isCallExpression(node) ? placeholderName(node) : null;
    if (empty !== null) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      result.placeholders.push(`${empty} (${file}:${line})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

/** package.json 的每条命令（脚本按 && 分开），拆成词，去掉词两头的双引号 */
const commands = Object.values(JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).scripts)
  .flatMap((script) => script.split('&&'))
  .map((part) => part.trim().split(/\s+/).map((word) => word.replace(/^"|"$/g, '')));

/**
 * @brief 命令里一个参数的值（"--flag value" 或 "--flag=value"）。
 * @return 值；没有这个参数时为 null
 */
function optionOf(words, flag) {
  const at = words.indexOf(flag);
  if (at >= 0) return words[at + 1] ?? null;
  return words.find((word) => word.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
}

/** @brief 这条命令是不是整套跑 file（node <file>，不带改结果文件的参数）。 */
const runsFully = (words, file) => words[0] === 'node' && words[1] === file
  && !words.some((word) => NOT_FULL_RUN.includes(word.split('=')[0]));

/** v1-models-existing.mjs 不带 --id 时跑的预设 */
const EXISTING_DEFAULT = /arg\('id'\) \?\? '([A-Z]+-\d+)'/.exec(readFileSync(join(appRoot, EXISTING), 'utf8'))?.[1];

/**
 * @brief 这份规格的单元测试目录：package.json 里用写 files.unit 的报告器跑的 node --test 命令里的
 *        "tests/unit/<目录>*.test.mjs"（模型层是 tests/unit/ 本身）。
 * @return 例如 'tests/unit/taskboard/'；没有这样的命令时为 null
 */
function unitDirOf(spec) {
  for (const words of commands.filter((w) => w[0] === 'node' && w.includes('--test'))) {
    const reporter = optionOf(words, '--test-reporter')?.replace(/^\.\//, '');
    const writes = reporter && readFileSync(join(appRoot, reporter), 'utf8')
      .includes(`createReporter('${spec.files.unit}')`);
    if (!writes) continue;
    const glob = words.map((word) => /^(tests\/unit\/(?:[\w-]+\/)?)\*\.test\.mjs$/.exec(word)).find(Boolean);
    if (glob) return glob[1];
  }
  return null;
}

/**
 * @brief 一个测试文件在这份规格里算哪几层（见文件开头）。
 * @param spec SPECS 中的一项
 * @param unitDir unitDirOf 的结果
 * @param file 相对 app/ 的路径（/ 分隔）
 * @return 'unit' | 'app' | 'replay' | 'real' 的列表；不属于这份规格的任何一层时为空
 */
function layersOf(spec, unitDir, file) {
  if (unitDir && file.startsWith(unitDir) && /^[^/]+\.test\.mjs$/.test(file.slice(unitDir.length))) return ['unit'];
  if (file === EXISTING) return ['app', 'replay'];
  const ui = /^tests\/ui\/([^/]+)\.mjs$/.exec(file);
  if (!ui || ui[1].endsWith('-helpers')) return [];
  // 真实层的驱动拆成几个模块（fs-real-perm.mjs 等，由 fs-real.mjs 调用，检查都记进 fs-real.json）时，这些模块也算真实层
  if (ui[1].startsWith(`${spec.files.real}-`)) return ['real'];
  const layer = layerOfFile(spec, `${ui[1]}.json`, false);
  return layer && layer !== 'unit' ? [layer] : [];
}

/**
 * @brief 测试里以这份规格的编号开头的检查名。
 * @param spec SPECS 中的一项
 * @param unitDir unitDirOf 的结果
 * @param scans Map<文件, scan 的结果>
 * @return Map<编号, { layers: Set<层>, files: Set<文件> }>
 */
function idsInTests(spec, unitDir, scans) {
  const pattern = new RegExp(`^${spec.prefix}-\\d+(?!\\d)`);
  const found = new Map();
  for (const [file, { names }] of scans) {
    if (MADE_UP_IDS.has(file)) continue;
    for (const id of names.map((name) => pattern.exec(name)?.[0]).filter(Boolean)) {
      if (!found.has(id)) found.set(id, { layers: new Set(), files: new Set() });
      for (const layer of layersOf(spec, unitDir, file)) found.get(id).layers.add(layer);
      found.get(id).files.add(file);
    }
  }
  return found;
}

/**
 * @brief 一份规格没接好的地方（见文件开头第 4 项）。
 * @param name SPECS 里的名字（spec-coverage 的 --spec；model 也可以不带 --spec）
 * @param spec SPECS 中的一项
 * @param unitDir unitDirOf 的结果
 * @param found idsInTests 的结果
 * @return 每处一行文字
 */
function wiringGaps(name, spec, unitDir, found) {
  const gaps = [];
  if (!unitDir) gaps.push(`no node --test command runs tests/unit/<dir>*.test.mjs writing ${spec.files.unit}`);
  const coverage = commands.some((words) => runsFully(words, 'tests/spec-coverage.mjs')
    && (optionOf(words, '--spec') ?? 'model') === name);
  if (!coverage) gaps.push(`no npm script runs tests/spec-coverage.mjs --spec ${name}`);
  for (const [id, where] of [...found].filter(([, place]) => place.files.has(EXISTING))) {
    if (!commands.some((words) => runsFully(words, EXISTING) && (optionOf(words, '--id') ?? EXISTING_DEFAULT) === id)) {
      gaps.push(`no npm script runs ${EXISTING} --id ${id}`);
    }
  }
  const suites = new Set([...found.values()].flatMap((place) => [...place.files]));
  for (const file of [...suites].sort()) {
    const counted = layersOf(spec, unitDir, file).some((layer) => layer === 'app' || layer === 'replay');
    if (counted && file !== EXISTING && !commands.some((words) => runsFully(words, file))) {
      gaps.push(`${file} names ${spec.prefix} ids but no npm script runs it in full`);
    }
  }
  return gaps;
}

const scans = new Map(testFiles().map((file) => [file, scan(file)]));

for (const [name, spec] of Object.entries(SPECS)) {
  const items = () => parseSpecTable(spec, readFileSync(specPathOf(spec), 'utf8'));
  const where = `${spec.path} §${spec.section}`;
  const unitDir = unitDirOf(spec);

  test(`spec ids (${name}): every ${spec.prefix} item in ${where} has a test for each listed layer`, () => {
    const found = idsInTests(spec, unitDir, scans);
    const gaps = items().flatMap((item) => [...item.layers].filter((layer) => !found.get(item.id)?.layers.has(layer))
      .map((layer) => `${item.id} ${layer}: no test is named with it (${item.title})`));
    assert.deepEqual(gaps, []);
  });

  test(`spec ids (${name}): every ${spec.prefix} id the tests use is an item in ${where}`, () => {
    const ids = new Set(items().map((item) => item.id));
    const extra = [...idsInTests(spec, unitDir, scans)].filter(([id]) => !ids.has(id))
      .map(([id, place]) => `${id} in ${[...place.files].join(', ')}`);
    assert.deepEqual(extra, []);
  });

  test(`spec ids (${name}): no test named with a ${spec.prefix} id is empty or always passes`, () => {
    const pattern = new RegExp(`^${spec.prefix}-\\d+(?!\\d)`);
    const empty = [...scans].filter(([file]) => !MADE_UP_IDS.has(file))
      .flatMap(([, { placeholders }]) => placeholders.filter((entry) => pattern.test(entry)));
    assert.deepEqual(empty, []);
  });

  test(`spec ids (${name}): npm scripts run its unit tests, its spec-coverage and every App and replay suite it names`,
    () => {
      assert.deepEqual(wiringGaps(name, spec, unitDir, idsInTests(spec, unitDir, scans)), []);
    });
}
