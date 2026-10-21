// node --test 的报告器：平行 Agent 与 TaskBoard 的单元层（docs/specs/parallel-agents-taskboard.md §17.1、§17.3），
// 结果写进 test-results/tb-unit.json。测试名以那份规格 §17.2 的编号开头（例如 "TB-46 spec-coverage …"）。

import { createReporter } from './reporter.mjs';

/** @brief 平行 Agent 与 TaskBoard 的单元结果：test-results/tb-unit.json。 */
export default createReporter('tb-unit.json');
