// node --test 的报告器：提示词分层与记忆的单元层（docs/specs/memory.md §14.1、§14.3），结果写进 test-results/mem-unit.json。
// 测试名以那份规格 §14.2 的编号开头（例如 "MEM-07 exactly 500 tokens is allowed …"）；覆盖检查按这个文件算单元层。

import { createReporter } from './reporter.mjs';

/** @brief 提示词分层与记忆的单元结果：test-results/mem-unit.json。 */
export default createReporter('mem-unit.json');
