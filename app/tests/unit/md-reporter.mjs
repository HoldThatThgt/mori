// node --test 的报告器：一键拉取模型的单元层（docs/specs/model-discovery.md §13.1、§13.3），结果写进 test-results/md-unit.json。
// 测试名以那份规格 §13.2 的编号开头（例如 "MD-01 …"）；覆盖检查按这个文件算单元层。
// 严格模式（reporter.mjs 开头，2026-10-26 起每个报告器都用）：负责人要求这份规格的结果里跳过的、标为待办的测试都算失败，
// 它们记为 ok: false 并带上标记，node --test 的退出码为 1；套件自己的失败（describe 的函数或钩子抛错）也记一条。

import { createReporter } from './reporter.mjs';

/** @brief 一键拉取模型的单元结果：test-results/md-unit.json（严格模式）。 */
export default createReporter('md-unit.json');
