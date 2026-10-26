// kernel/roleFiles.ts 的单元测试（docs/specs/customize-agents.md §5.1–§5.3）：写出的文件全文（字段顺序、JSON 写法、
// 正文）、用 pi 的 parseFrontmatter 读回与要写的一致、文件名与路径的检查、编辑时保留的字段、文件头的注释。
// 纯函数；描述、正文等都是测试写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

const files = await loadKernelModule('src/kernel/roleFiles.ts');

/** @brief 表单的字段（synthetic）。 */
const header = (extra = {}) => ({ name: 'reviewer', description: 'Reviews the change and runs the tests',
  tools: ['read', 'grep', 'bash'], models: ['deepseek/deepseek-chat', 'fast'], seats: ['close'], ...extra });

test('AG-04 the written file: fields in order, description as JSON, one-line lists, a blank line, the body', () => {
  const text = files.roleFileText(header(), '\n\nReview the diff.\nRun the tests.\n\n');
  assert.equal(text, [
    '---',
    'name: reviewer',
    'description: "Reviews the change and runs the tests"',
    'tools: [read, grep, bash]',
    'models: [deepseek/deepseek-chat, fast]',
    'seats: [close]',
    '---',
    '',
    'Review the diff.',
    'Run the tests.',
    '',
  ].join('\n'));
});

test('AG-04 fields that are not set are not written, and an empty body leaves no body section', () => {
  const text = files.roleFileText({ name: 'executor', description: 'Does tasks', tools: null, models: null, seats: [] },
    '  \n');
  assert.equal(text, '---\nname: executor\ndescription: "Does tasks"\n---\n');
});

test('AG-04 list items with other characters are JSON strings; CRLF in the body becomes LF', () => {
  const text = files.roleFileText(header({ tools: ['read', 'mcp__*', 'mcp__fs__read_file'], models: ['my group'] }),
    'one\r\ntwo');
  assert.match(text, /^tools: \[read, "mcp__\*", mcp__fs__read_file\]$/m);
  assert.match(text, /^models: \["my group"\]$/m);
  assert.ok(text.endsWith('\none\ntwo\n'));
  assert.ok(!text.includes('\r'));
});

test('AG-04 reading the file back with pi’s parseFrontmatter gives exactly the fields and body written', () => {
  const tricky = 'Checks: "quotes", # hashes, colons: and \\ backslashes — and unicode ✓';
  const kept = { requires: ['protocol_write>=B', 'context>=65536'], differ_from: 'author',
    subscribe: [{ request_closed: { ruled_out: true, outcome: ['done', 'failed'] } }, 'request_closed'] };
  const written = header({ description: tricky, seats: ['create', 'close'], ...kept });
  const parsed = parseFrontmatter(files.roleFileText(written, 'Body line 1\n\n  indented line 3'));
  assert.deepEqual(parsed.frontmatter, {
    name: 'reviewer', description: tricky, tools: ['read', 'grep', 'bash'], models: ['deepseek/deepseek-chat', 'fast'],
    requires: ['protocol_write>=B', 'context>=65536'], seats: ['create', 'close'], differ_from: 'author',
    subscribe: kept.subscribe,
  });
  assert.equal(parsed.body, 'Body line 1\n\n  indented line 3');
});

test('AG-04 kept fields are written between models and seats, in the spec’s order', () => {
  const text = files.roleFileText(header({ requires: ['vision'], differ_from: 'author',
    subscribe: ['request_closed'] }), '');
  const keys = text.split('\n').filter((line) => /^[a-z_]+:/.test(line)).map((line) => line.split(':')[0]);
  assert.deepEqual(keys, ['name', 'description', 'tools', 'models', 'requires', 'seats', 'differ_from', 'subscribe']);
  assert.match(text, /^subscribe: \["request_closed"\]$/m);
});

test('AG-05 only a .md file directly in .mori/agents is an agent file; absolute paths and .. are refused', () => {
  assert.equal(files.agentFileName('.mori/agents/reviewer.md'), 'reviewer.md');
  assert.equal(files.agentFileName('.mori/agents/Rev-1.MD'), 'Rev-1.MD');
  for (const bad of ['.mori/agents/../x.md', '../.mori/agents/x.md', 'C:\\x\\.mori\\agents\\x.md',
    '/x/.mori/agents/x.md', '.mori/agents/sub/x.md', '.mori/agents/x.txt', '.mori/agents/.md', '.mori\\agents\\x.md',
    '.mori/agents/..', 'x.md', '']) {
    assert.equal(files.agentFileName(bad), null, bad);
  }
  assert.equal(files.newAgentFile('reviewer'), '.mori/agents/reviewer.md');
});

test('AG-06 editing keeps requires, differ_from and subscribe from the file as they are, and nothing else', () => {
  const frontmatter = { name: 'reviewer', description: 'x', tools: ['read'], requires: ['vision'],
    differ_from: 'author', subscribe: ['request_closed'], seats: ['close'] };
  assert.deepEqual(files.keptFields(frontmatter),
    { requires: ['vision'], differ_from: 'author', subscribe: ['request_closed'] });
  assert.deepEqual(files.keptFields({ name: 'a', description: 'b' }), {});
  assert.deepEqual(files.keptFields(null), {});
});

test('AG-06 header comments are found only between the --- lines', () => {
  assert.equal(files.hasHeaderComments('---\nname: a\n# who reviews\ndescription: b\n---\nbody'), true);
  assert.equal(files.hasHeaderComments('---\nname: a  # inline\ndescription: b\n---\n'), true);
  const quoted = '---\nname: a\ndescription: "b # not a comment"\n---\n# heading in body';
  assert.equal(files.hasHeaderComments(quoted), false);
  assert.equal(files.hasHeaderComments('---\r\nname: a\r\n  # indented\r\ndescription: b\r\n---\r\n'), true);
  assert.equal(files.hasHeaderComments('no header # here'), false);
});
