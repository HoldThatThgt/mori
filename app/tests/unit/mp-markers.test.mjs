// 思考关不掉的模型（docs/specs/model-providers.md §7.7、§14.2 MP-38、§14.3）的一项附加检查：负责人的规则“不留未完成项”，
// 以新编号命名一项检查，这次工作新加的行里不能有推迟实现的标记。查法同 MD-15 的 tests/md-markers.mjs（新加的行 =
// HEAD 与 origin/app-v0 的 merge-base 到工作区的 git diff 里新增的行，加上没跟踪的文件；只看 app/src 与 app/tests，
// 不看 app/tests/fixtures/），这里用 --id MP-38 跑它，退出码为 0 才算通过，失败时把命中的行写进断言的说明。
// 测试名里的标记（原来五个，2026-10-26 加了六个中文说法）用 \u 转义写出：md-markers.mjs 读的是源码里的行，直接写出来这一行就会被它自己认出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** md-markers.mjs 查的标记（测试名用），见文件开头 */
const MARKER_NAMES = ['T\u004FDO', 'FIX\u004DE', 'not impl\u0065mented', 'l\u0061ter', '\u5f85\u5b9e\u73b0',
  '\u7559\u5230\u540e\u7eed', '\u4ee5\u540e\u518d\u505a', '\u4ea4\u7ed9\u4e0b\u4e00\u4e2a\u5305',
  '\u4ea4\u7ed9\u540e\u9762\u7684\u5305', '\u6682\u4e0d\u5b9e\u73b0', '\u5360\u4f4d\u5b9e\u73b0'];

test(`MP-38 no deferral markers (${MARKER_NAMES.join(', ')}) in the lines this work adds under app/src and app/tests`,
  () => {
    const run = spawnSync(process.execPath, [join(appRoot, 'tests', 'md-markers.mjs'), '--id', 'MP-38'],
      { cwd: appRoot, encoding: 'utf8', maxBuffer: 1 << 26 });
    const lines = run.stdout.split(/\r?\n/).filter(Boolean);
    const hits = lines.filter((line) => /^app\/\S+:\d+: /.test(line));
    const verdict = lines.filter((line) => /^(PASS|FAIL)\b/.test(line));
    const report = [`node tests/md-markers.mjs --id MP-38 exited ${run.status}`, ...verdict, ...hits,
      run.stderr.trim()].filter(Boolean).join('\n');
    assert.equal(run.status, 0, report);
    assert.deepEqual(hits, [], report);
    assert.match(verdict.at(-1) ?? '', /^PASS MP-38 md-markers: no deferral markers in /, report);
  });
