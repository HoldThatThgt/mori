// node --test 的报告器：收尾检查的单元层（docs/specs/finish-check.md §14.1、§14.3），结果写进 test-results/fc-unit.json。
// 测试名以那份规格 §14.2 的编号开头（例如 "FC-06 decision table: …"）；覆盖检查按这个文件算单元层。
// 严格模式（reporter.mjs 开头），同 md-reporter.mjs：跳过的、标为待办的测试都算失败，
// 它们记为 ok: false 并带上标记，node --test 的退出码为 1；套件自己的失败（describe 的函数或钩子抛错）也记一条。

import { createReporter } from './reporter.mjs';

/** @brief 收尾检查的单元结果：test-results/fc-unit.json（严格模式）。 */
export default createReporter('fc-unit.json', true);
