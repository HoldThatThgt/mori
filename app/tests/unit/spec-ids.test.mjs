// 2026-10-26 负责人的规则（AGENTS.md“不留未完成项，不做规格外的东西”）：每份构建规格验收表（tests/spec-coverage.mjs 的
// SPECS）里的每个编号，在它列出的每一层都要已经写好测试；测试里用到的编号都要在表里。这里只读测试的源码、不跑测试，所以
// 每次改动跑的 npm run test:unit 就会查到：规格加了条目却没写测试、测试用了表里没有的编号，都在这里失败。
// 测试是否通过由推送前的 spec-coverage 按结果文件查（AGENTS.md 测试分层第 3 条）。
// 一个编号算“有测试”：app/tests 下（录下的 fixtures/ 除外）某个 .mjs / .js / .jsx 文件里有一个字符串字面量以这个编号开头
// （测试名、record 的检查名；注释里提到的不算）。层按文件认：tests/unit/ 下为单元；tests/ui/ 下名字含 real 的为真实、
// 含 replay 的为回放、其余为 App；tests/ui/v1-models-existing.mjs 按预设把现有套件的结果记在编号下，算 App 与回放。
// 覆盖检查的单元测试（tests/unit/taskboard/spec-coverage.test.mjs）用编造的编号检查规则，不算。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS, parseSpecTable, specPathOf } from '../spec-coverage.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 用编造的编号检查覆盖规则的文件（相对 app/，/ 分隔），不算 */
const MADE_UP_IDS = new Set(['tests/unit/taskboard/spec-coverage.test.mjs']);

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
 * @brief 一个测试文件算哪几层（见文件开头）。
 * @param file 相对 app/ 的路径（/ 分隔）
 * @return 'unit' | 'app' | 'replay' | 'real' 的列表；不属于任何一层时为空
 */
function layersOfFile(file) {
  if (file.startsWith('tests/unit/')) return ['unit'];
  if (!file.startsWith('tests/ui/')) return [];
  const name = file.slice('tests/ui/'.length);
  if (name === 'v1-models-existing.mjs') return ['app', 'replay'];
  if (name.includes('real')) return ['real'];
  return name.includes('replay') ? ['replay'] : ['app'];
}

/**
 * @brief 测试源码里以这份规格的编号开头的字符串字面量。
 * @param spec SPECS 中的一项
 * @param files testFiles 的结果
 * @return Map<编号, { layers: Set<层>, files: Set<文件> }>
 */
function idsInTests(spec, files) {
  const pattern = new RegExp(`(?<=['"\`])${spec.prefix}-\\d+(?!\\d)`, 'g');
  const found = new Map();
  for (const file of files.filter((name) => !MADE_UP_IDS.has(name))) {
    for (const [id] of readFileSync(join(appRoot, file), 'utf8').matchAll(pattern)) {
      if (!found.has(id)) found.set(id, { layers: new Set(), files: new Set() });
      for (const layer of layersOfFile(file)) found.get(id).layers.add(layer);
      found.get(id).files.add(file);
    }
  }
  return found;
}

const files = testFiles();

for (const [name, spec] of Object.entries(SPECS)) {
  const items = () => parseSpecTable(spec, readFileSync(specPathOf(spec), 'utf8'));

  test(`spec ids (${name}): every ${spec.prefix} item in ${spec.path} §${spec.section} has a test for each listed layer`,
    () => {
      const found = idsInTests(spec, files);
      const gaps = items().flatMap((item) => [...item.layers].filter((layer) => !found.get(item.id)?.layers.has(layer))
        .map((layer) => `${item.id} ${layer}: no test is named with it (${item.title})`));
      assert.deepEqual(gaps, []);
    });

  test(`spec ids (${name}): every ${spec.prefix} id the tests use is an item in ${spec.path} §${spec.section}`, () => {
    const ids = new Set(items().map((item) => item.id));
    const extra = [...idsInTests(spec, files)].filter(([id]) => !ids.has(id))
      .map(([id, where]) => `${id} in ${[...where.files].join(', ')}`);
    assert.deepEqual(extra, []);
  });
}
