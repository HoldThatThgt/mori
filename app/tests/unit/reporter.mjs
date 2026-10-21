// node --test 的报告器工厂：把每个测试的结果按 createRecorder 的格式写进 test-results/ 下的一个结果文件，
// 同时在终端逐条打印 PASS / FAIL。默认导出写 v1-unit.json（模型层，docs/specs/model-providers.md §14.3），
// 测试名以那份规格 §14.2 的编号开头（例如 "MP-05 group members expand in order"）；
// tb-reporter.mjs 用同一个工厂写 tb-unit.json（平行 Agent 与 TaskBoard，docs/specs/parallel-agents-taskboard.md §17.3）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @brief 生成一个报告器：只收叶子测试（没有子测试的那一层），套件本身不记。
 * @param resultFile test-results/ 下的结果文件名，例如 'v1-unit.json'
 * @return node --test 的报告器（异步生成器函数）
 */
export function createReporter(resultFile) {
  return async function* reporter(source) {
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
    writeFileSync(join(appRoot, 'test-results', resultFile),
      `${JSON.stringify({ target: 'unit', checks }, null, 2)}\n`);
    const failed = checks.filter((c) => !c.ok).length;
    yield `\n${checks.length - failed}/${checks.length} unit checks passed\n`;
  };
}

/** @brief 模型层的单元结果：test-results/v1-unit.json。 */
export default createReporter('v1-unit.json');
