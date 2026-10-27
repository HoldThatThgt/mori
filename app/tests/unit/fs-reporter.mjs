// node --test 的报告器：文件系统的单元层（docs/specs/file-system.md §19.1、§19.3），结果写进 test-results/fs-unit.json。
// 测试名以那份规格 §19.2 的编号开头（例如 "FS-42 …"）；覆盖检查（tests/spec-coverage.mjs --spec filesystem）按这个文件
// 算单元层。严格模式（reporter.mjs 开头，同 md-reporter.mjs）：跳过的、标为待办的测试都算失败，它们记为 ok: false 并带上
// 标记，node --test 的退出码为 1；套件自己的失败（describe 的函数或钩子抛错）也记一条。

import { createReporter } from './reporter.mjs';

/** @brief 文件系统的单元结果：test-results/fs-unit.json（严格模式）。 */
export default createReporter('fs-unit.json');
