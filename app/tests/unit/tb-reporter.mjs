// node --test 的报告器：平行 Agent 与 TaskBoard 的单元层（docs/specs/parallel-agents-taskboard.md §17.1、§17.3），
// 结果写进 test-results/tb-unit.json。测试名以那份规格 §17.2 的编号开头（例如 "TB-46 spec-coverage …"）。
// 2026-10-26 起用严格模式（AGENTS.md“不留未完成项，不做规格外的东西”：跳过的与标为待办的测试算失败），同 reporter.mjs。

import { createReporter } from './reporter.mjs';

/** @brief 平行 Agent 与 TaskBoard 的单元结果：test-results/tb-unit.json（严格模式）。 */
export default createReporter('tb-unit.json');
