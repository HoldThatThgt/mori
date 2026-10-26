// 长度检查（tests/limits.mjs，由 tests/check.mjs 即 npm run check 对 app/src 与 app/tests 调用）的单元测试：
// AGENTS.md 工程约束“每行不超过 120 字符，每文件不超过 2000 行，每函数不超过 50 行且不超过 5 个入参”。
// 下面的源码片段与临时目录都是测试手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { LIMITS, limitFiles, limitProblems } from '../limits.mjs';

/** @brief 把几行源码拼成一个文件的内容（CRLF，同仓库的工作区）。 */
const source = (lines) => `${lines.join('\r\n')}\r\n`;

/** @brief 一个从第 1 行开始、共 lines 行的函数声明（函数体是 lines - 2 行语句）。 */
const functionOf = (name, lines) => [`function ${name}() {`,
  ...Array.from({ length: lines - 2 }, (_, index) => `  const v${index} = ${index};`), '}'];

/** @brief 只取报告的行号与说明，便于比较。 */
const report = (file, lines) => limitProblems(file, source(lines)).map(({ line, message }) => `${line} ${message}`);

/** @brief 建一个临时目录，测试结束时删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('length check: a line of 120 characters passes and a line of 121 fails, counted in code points', () => {
  assert.equal(LIMITS.line, 120);
  const ascii = `const a = '${'x'.repeat(120 - 13)}';`;
  assert.equal(ascii.length, 120);
  const wide = `// ${'汉'.repeat(117)}`;
  assert.equal([...wide].length, 120);
  assert.ok(Buffer.byteLength(wide) > 120);
  assert.deepEqual(report('src/kernel/a.ts', [ascii, wide]), []);
  assert.deepEqual(report('tests/ui/b.mjs', [ascii, `${ascii}x`, `${wide}’`]),
    ['2 is longer than 120 characters', '3 is longer than 120 characters']);
});

test('length check: a function of 50 lines passes and one of 51 fails; declarations, arrows and methods count', () => {
  assert.deepEqual(report('src/kernel/a.ts', functionOf('fifty', 50)), []);
  assert.deepEqual(report('src/kernel/a.ts', functionOf('fiftyOne', 51)),
    ['1 function fiftyOne has 51 lines (limit 50)']);
  const body = functionOf('x', 51).slice(1, -1);
  assert.deepEqual(report('tests/ui/a.mjs', ['const arrow = () => {', ...body, '};']),
    ['1 function arrow has 51 lines (limit 50)']);
  assert.deepEqual(report('tests/ui/a.mjs', ['class A {', '  method() {', ...body, '  }', '}']),
    ['2 function method has 51 lines (limit 50)']);
  assert.deepEqual(report('tests/ui/a.mjs', ['test(\'name\', () => {', ...body, '});']),
    ['1 anonymous function has 51 lines (limit 50)']);
});

test('length check: the lines of a function run from its first line to its last; a comment above it is not counted',
  () => {
    const lines = ['/**', ' * @brief synthetic.', ' */', ...functionOf('documented', 50)];
    assert.deepEqual(report('src/kernel/a.ts', lines), []);
    const outer = ['function outer() {', ...functionOf('inner', 49).map((line) => `  ${line}`), '}'];
    assert.deepEqual(report('src/kernel/a.ts', outer), ['1 function outer has 51 lines (limit 50)']);
  });

test('length check: 5 parameters pass and 6 fail for functions, arrows, methods and TSX components', () => {
  assert.equal(LIMITS.params, 5);
  assert.deepEqual(report('src/kernel/a.ts', ['function five(a, b, c, d, e) {}',
    'const rest = (a, b, c, d, ...more) => more;', 'function grouped(a, b, c, d, { e, f, g } = {}) {}']), []);
  assert.deepEqual(report('tests/unit/a.test.mjs', ['function six(a, b, c, d, e, f) {}',
    'const arrow = (a, b, c, d, e, f) => a;', 'const o = { method(a, b, c, d, e, f) {} };']),
  ['1 function six has 6 parameters (limit 5)', '2 function arrow has 6 parameters (limit 5)',
    '3 function method has 6 parameters (limit 5)']);
  assert.deepEqual(report('src/renderer/src/A.tsx', [
    'export const A = (a: number, b: number, c: number, d: number, e: number, f: number) => <p>{a}</p>;']),
  ['1 function A has 6 parameters (limit 5)']);
});

test('length check: a file of 2000 lines passes and one of 2001 fails; .css and .html are checked for lines only',
  () => {
  assert.equal(LIMITS.fileLines, 2000);
  const lines = (count) => Array.from({ length: count }, (_, index) => `.c${index} { color: red; }`);
  assert.deepEqual(report('src/renderer/src/a.css', lines(2000)), []);
  assert.deepEqual(report('src/renderer/src/a.css', lines(2001)), ['0 file has 2001 lines (limit 2000)']);
  assert.deepEqual(report('src/renderer/index.html', [`<p>${'x'.repeat(118)}</p>`]),
    ['1 is longer than 120 characters']);
});

test('length check: the files checked are the code files under src and tests, without tests/fixtures and output',
  (t) => {
  const appRoot = tempDir(t);
  const files = ['src/main/index.ts', 'src/renderer/src/App.tsx', 'src/renderer/src/app.css', 'src/renderer/index.html',
    'tests/check.mjs', 'tests/ui/harness/main.cjs', 'tests/ui/harness/main.jsx', 'tests/ui/harness/replay.js',
    'tests/fixtures/m1/run.mjs', 'tests/fixtures/m1/session.json', 'tests/node_modules/x/index.js',
    'tests/.tb-runs/a/main.js', 'tests/test-results/a.js', 'src/out/main.js', 'tests/dist/a.js', 'tests/README.md',
    'tests/pi-package/package.json', 'electron.vite.config.ts'];
  for (const file of files) {
    mkdirSync(join(appRoot, file, '..'), { recursive: true });
    writeFileSync(join(appRoot, file), `const long = '${'x'.repeat(200)}';\n`);
  }
  const listed = limitFiles(appRoot).map((file) => relative(appRoot, file).split(sep).join('/')).sort();
  assert.deepEqual(listed, ['src/main/index.ts', 'src/renderer/index.html', 'src/renderer/src/App.tsx',
    'src/renderer/src/app.css', 'tests/check.mjs', 'tests/ui/harness/main.cjs', 'tests/ui/harness/main.jsx',
    'tests/ui/harness/replay.js']);
});
