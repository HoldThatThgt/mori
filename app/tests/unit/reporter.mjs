// node --test 的报告器工厂：把每个测试的结果按 createRecorder 的格式写进 test-results/ 下的一个结果文件，
// 同时在终端逐条打印 PASS / FAIL。默认导出写 v1-unit.json（模型层，docs/specs/model-providers.md §14.3），
// 测试名以那份规格 §14.2 的编号开头（例如 "MP-05 group members expand in order"）；
// tb-reporter.mjs 用同一个工厂写 tb-unit.json（平行 Agent 与 TaskBoard，docs/specs/parallel-agents-taskboard.md §17.3）。
// 默认导出（v1-unit.json）从 2026-10-24 起用严格模式（负责人的规则：跳过的与标为 todo 的测试算失败；思考关不掉的模型，
// 模型层规格 §7.7、§14.3），同 md-reporter.mjs。
// 严格模式（md-reporter.mjs 与默认导出；一键拉取模型 docs/specs/model-discovery.md §13.3）：node --test 把跳过的（data.skip）与
// 标为 todo 的（data.todo）测试报成 test:pass（标为 todo 的失败报成不影响退出码的 test:fail），严格模式把它们记为失败：
// ok: false，detail 为 "skipped: <原因>" 或 "todo: <原因>"，并带上 skip: true 或 todo: true（spec-coverage.mjs 见到
// 这两个标记一律不算通过）；带这两个标记的套件（describe.skip 不报告它里面的测试）同样记一条。有这样的检查时
// 报告器把退出码设为 1。严格模式另把套件自己的失败记一条（describe 的函数抛错时它里面的测试一个也不报告，钩子失败时
// 同样记）；只因里面有测试失败而失败的套件（failureType 为 subtestsFailed）不记，那些测试各自已记。
// 不开严格模式的报告器照旧：跳过与 todo 的测试记为通过，套件不记。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** node --test 事件里的两个标记：字段名、记进 detail 的前缀 */
const FLAGS = [['skip', 'skipped'], ['todo', 'todo']];

/**
 * @brief 一个测试或套件带的跳过 / todo 标记。
 * @param data node --test 事件的 data（skip、todo 为原因文字或 true，没有标记时不存在）
 * @return { key: 'skip'|'todo', label: 'skipped'|'todo', reason }；没有标记时为 null
 */
function flagOf(data) {
  for (const [key, label] of FLAGS) {
    const value = data[key];
    if (value === undefined || value === false || value === null) continue;
    return { key, label, reason: typeof value === 'string' && value.trim() ? value.trim() : 'no reason given' };
  }
  return null;
}

/**
 * @brief 把一个 test:pass / test:fail 事件变成一条检查。
 * @param event node --test 的事件
 * @param strict 严格模式：带跳过 / todo 标记的测试与套件记为失败，套件自己的失败也记
 * @return { name, ok, detail, known, file, skip?, todo? }；不记的套件（没有标记，通过了或只因里面的测试失败）为 null
 */
function checkOf(event, strict) {
  const data = event.data;
  const flag = strict ? flagOf(data) : null;
  const ownFailure = strict && event.type === 'test:fail' && data.details?.error?.failureType !== 'subtestsFailed';
  if (data.details?.type === 'suite' && !flag && !ownFailure) return null;
  const error = String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? '');
  const file = data.file ?? '';
  if (flag) {
    const failed = event.type === 'test:fail' && error ? ` (it also failed: ${error.split('\n')[0]})` : '';
    return { name: data.name, ok: false, detail: `${flag.label}: ${flag.reason}${failed}`, known: false, file,
      [flag.key]: true };
  }
  const ok = event.type === 'test:pass';
  return { name: data.name, ok, detail: ok ? '' : error, known: false, file };
}

/**
 * @brief 生成一个报告器：只收测试，套件本身不记（严格模式下带跳过 / todo 标记的套件与自己失败的套件除外）。
 * @param resultFile test-results/ 下的结果文件名，例如 'v1-unit.json'
 * @param strict 严格模式（md-reporter.mjs 与默认导出）：跳过与 todo 的测试记为失败，见文件开头；默认 false
 * @return node --test 的报告器（异步生成器函数）
 */
export function createReporter(resultFile, strict = false) {
  return async function* reporter(source) {
    const checks = [];
    for await (const event of source) {
      if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
      const check = checkOf(event, strict);
      if (!check) continue;
      checks.push(check);
      yield `${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail.split('\n')[0]}` : ''}\n`;
    }
    mkdirSync(join(appRoot, 'test-results'), { recursive: true });
    writeFileSync(join(appRoot, 'test-results', resultFile),
      `${JSON.stringify({ target: 'unit', checks }, null, 2)}\n`);
    const failed = checks.filter((c) => !c.ok).length;
    const flagged = checks.filter((c) => c.skip || c.todo).length;
    if (flagged) process.exitCode = 1;
    yield `\n${checks.length - failed}/${checks.length} unit checks passed`
      + `${flagged ? ` (${flagged} skipped or todo, counted as failures)` : ''}\n`;
  };
}

/** @brief 模型层的单元结果：test-results/v1-unit.json（严格模式，2026-10-24 起）。 */
export default createReporter('v1-unit.json', true);
