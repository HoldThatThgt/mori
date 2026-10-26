// node --test 的报告器：普通模式的 subagent 工具的单元层（docs/specs/subagent.md §14.1），结果写进 test-results/sa-unit.json。
// 测试名以那份规格 §14.3 的编号开头（例如 "SA-03 an empty tasks list is refused …"）；覆盖检查按这个文件算单元层。
// 严格模式（AGENTS.md“不留未完成项，不做规格外的东西”：跳过的与标为待办的测试算失败），同 reporter.mjs。

import { createReporter } from './reporter.mjs';

/** @brief subagent 的单元结果：test-results/sa-unit.json（严格模式）。 */
export default createReporter('sa-unit.json');
