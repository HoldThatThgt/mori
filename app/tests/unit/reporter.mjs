// node --test 的报告器：把每个测试的结果按 createRecorder 的格式写进 test-results/v1-unit.json（规格 §14.3），
// 同时在终端逐条打印 PASS / FAIL。测试名要以规格 §14.2 的编号开头（例如 "MP-05 group members expand in order"）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @brief 只收叶子测试（没有子测试的那一层），套件本身不记。 */
export default async function* reporter(source) {
  const checks = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    if (data.details?.type === 'suite') continue;
    const ok = event.type === 'test:pass';
    const detail = ok ? '' : String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? '');
    checks.push({ name: data.name, ok, detail, known: false, file: data.file ?? '' });
    yield `${ok ? 'PASS' : 'FAIL'} ${data.name}${detail ? ` — ${detail.split('\n')[0]}` : ''}\n`;
  }
  mkdirSync(join(appRoot, 'test-results'), { recursive: true });
  writeFileSync(join(appRoot, 'test-results', 'v1-unit.json'),
    `${JSON.stringify({ target: 'unit', checks }, null, 2)}\n`);
  const failed = checks.filter((c) => !c.ok).length;
  yield `\n${checks.length - failed}/${checks.length} unit checks passed\n`;
}
