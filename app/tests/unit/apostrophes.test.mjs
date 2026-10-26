// 撇号检查（tests/apostrophes.mjs，由 tests/check.mjs 即 npm run check 对 app/src 调用）的单元测试：
// docs/v0/ui-strings.md 写法约定“撇号用排版符号 ’”。下面的源码片段都是测试手写的（synthetic），
// 每段的期望是有直撇号的行号（从 1 起）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_MARK, straightApostropheLines } from '../apostrophes.mjs';

/** @brief 把几行源码拼成一个文件的内容（CRLF，同仓库的工作区）。 */
const source = (...lines) => lines.join('\r\n');

test('apostrophe check: straight apostrophes in string and template literals are reported by line', () => {
  const text = source(
    'const a = "can\'t open";',
    "const b = 'can\\'t open';",
    'const c = `${who}\'s run ended`;',
    'const d = `don\'t ${x} and ${y} won\'t`;',
    'const e = `first line',
    'second\'s line`;',
    'const f = `${x}` + "Mori\'s memory";',
  );
  assert.deepEqual(straightApostropheLines('src/kernel/a.ts', text), [1, 2, 3, 4, 6, 7]);
});

test('apostrophe check: JSX text and JSX attribute strings are reported in .tsx files', () => {
  const text = source(
    'export const A = () => (',
    '  <p title="Mori\'s memory">',
    '    Don\'t save',
    '    <span aria-label="Close">x</span>',
    '  </p>',
    ');',
  );
  assert.deepEqual(straightApostropheLines('src/renderer/src/A.tsx', text), [2, 3]);
});

test('apostrophe check: typographic apostrophes, regexes, console calls, comments and quotes in code pass', () => {
  const text = source(
    "const a = 'can’t open: the user’s words';",
    "const r = /can't|didn't/;",
    'console.error(`[kernel] ${file} can\'t be read`);',
    "// don't: comments are not text",
    "/* the user's words */",
    'const s = "[data-x=\'a\']";',
    'const q = \'it must be "field: value" lines\';',
    'const p = "tasks\' work";',
  );
  assert.deepEqual(straightApostropheLines('src/kernel/b.ts', text), []);
});

test('apostrophe check: a comment with the keep mark skips only the statement, declaration, property or case after it',
  () => {
  const text = source(
    `/** @brief model-only text. ${KEEP_MARK}. */`,
    'export const A = "the user\'s words";',
    'export const B = "the user\'s words";',
    'const o = {',
    `  // ${KEEP_MARK}`,
    '  a: "user\'s",',
    '  b: "user\'s",',
    '};',
    `const c = 'x'; // ${KEEP_MARK}`,
    'const d = "user\'s";',
    'function f(kind) {',
    '  switch (kind) {',
    `    // ${KEEP_MARK}`,
    '    case 1: return `${kind} didn\'t decide`;',
    '    case 2: return `${kind} didn\'t decide`;',
    '  }',
    '}',
  );
  assert.deepEqual(straightApostropheLines('src/kernel/c.ts', text), [3, 7, 10, 15]);
});

test('apostrophe check: a marked function skips every literal in its body; a mark at the top of the file is not '
  + 'a mark for the whole file', () => {
  const text = source(
    `/** @brief work card lines. ${KEEP_MARK}. */`,
    'function card(role) {',
    '  const head = `${role}\'s card`;',
    '  return [head, "User\'s words:"];',
    '}',
    'function view() {',
    '  return "Couldn\'t load";',
    '}',
  );
  assert.deepEqual(straightApostropheLines('src/kernel/d.ts', text), [7]);
});
