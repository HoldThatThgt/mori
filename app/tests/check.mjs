// 静态检查（docs/app-v0.md 第 8 节与 proposal 工程约束）：
//   - src/ 中不能出现"示例""演示""mock"；
//   - src/ 每行不超过 120 个字符。
// 发现问题时逐条列出并以退出码 1 结束。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const banned = /示例|演示|mock/i;
const maxLength = 120;
const problems = [];

/** @brief 递归列出目录下的源文件。 */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|html)$/.test(name) ? [path] : [];
  });
}

for (const file of sourceFiles(join(root, 'src'))) {
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const where = `${relative(root, file)}:${index + 1}`;
    if (banned.test(line)) problems.push(`${where} contains a banned word: ${line.trim().slice(0, 80)}`);
    if ([...line].length > maxLength) problems.push(`${where} is longer than ${maxLength} characters`);
  });
}

for (const problem of problems) console.error(problem);
console.log(problems.length ? `check failed: ${problems.length} problem(s)` : 'check passed');
process.exitCode = problems.length ? 1 : 0;
