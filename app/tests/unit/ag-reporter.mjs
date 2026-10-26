// node --test 的报告器：Customize › Agents 的单元层（docs/specs/customize-agents.md §9.1、§9.3），
// 结果写进 test-results/ag-unit.json。测试名以那份规格 §9.2 的编号开头（例如 "AG-05 …"）。严格模式：跳过的与
// 标为待办的测试算失败（AGENTS.md“不留未完成项，不做规格外的东西”），同 reporter.mjs。

import { createReporter } from './reporter.mjs';

/** @brief Customize › Agents 的单元结果：test-results/ag-unit.json（严格模式）。 */
export default createReporter('ag-unit.json');
