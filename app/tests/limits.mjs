// 长度检查（AGENTS.md 工程约束：每行不超过 120 字符，每文件不超过 2000 行，每函数不超过 50 行且不超过 5 个入参），
// 由 tests/check.mjs（npm run check）对 app/src 与 app/tests 的代码文件调用，单元测试在 tests/unit/limits.test.mjs。
// 行宽按码位数（一个汉字、一个 ’ 都算 1），不按字节；函数的行数是从函数开头（不含前面的注释）到结尾所占的行数；
// 函数指函数声明、函数表达式、箭头函数和方法（含构造函数、get/set），用 typescript 解析，.tsx/.jsx 按 TSX。
// 不查的目录：app/tests/fixtures（录下的数据）与生成的输出（node_modules、.tb-runs、test-results、out、dist）。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** @brief 上限：行宽（码位）、文件行数、函数行数、函数入参个数。 */
export const LIMITS = { line: 120, fileLines: 2000, functionLines: 50, params: 5 };

/** @brief 要查的代码文件。 */
const CODE = /\.(ts|tsx|mts|mjs|js|cjs|jsx|css|html)$/;
/** @brief 生成的输出：任何一层叫这些名字的目录都不查。 */
const GENERATED = new Set(['node_modules', '.tb-runs', 'test-results', 'out', 'dist']);
/** @brief 函数的语法节点种类。 */
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/**
 * @brief 列出 app/src 与 app/tests 下要查的代码文件（不含 tests/fixtures 与生成的输出）。
 * @param appRoot app 目录
 * @return 文件的绝对路径
 */
export function limitFiles(appRoot) {
  const skipped = join(appRoot, 'tests', 'fixtures');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return GENERATED.has(name) || path === skipped ? [] : walk(path);
    return CODE.test(name) ? [path] : [];
  });
  return [join(appRoot, 'src'), join(appRoot, 'tests')].flatMap(walk);
}

/** @brief 按扩展名选脚本种类；不是脚本（.css、.html）时为 null。 */
function scriptKind(file) {
  if (/\.(tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.m?ts$/.test(file)) return ts.ScriptKind.TS;
  return /\.(mjs|js|cjs)$/.test(file) ? ts.ScriptKind.JS : null;
}

/** @brief 函数在报告里的名字：自己的名字，或赋给的变量、属性的名字；都没有时为 "anonymous function"。 */
function functionName(node, source) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const name = node.name ?? node.parent?.name;
  return name ? `function ${name.getText(source)}` : 'anonymous function';
}

/**
 * @brief 查一个文件里每个函数的行数与入参个数。
 * @param file 文件路径（按扩展名选解析方式）
 * @param text 文件内容
 * @return [{ line, message }]，line 为函数开头的行号（从 1 起）
 */
function functionProblems(file, text) {
  const kind = scriptKind(file);
  if (kind === null) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const problems = [];
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const lines = source.getLineAndCharacterOfPosition(node.end).line + 2 - start;
      const name = functionName(node, source);
      if (lines > LIMITS.functionLines) {
        problems.push({ line: start, message: `${name} has ${lines} lines (limit ${LIMITS.functionLines})` });
      }
      if (node.parameters.length > LIMITS.params) {
        const count = node.parameters.length;
        problems.push({ line: start, message: `${name} has ${count} parameters (limit ${LIMITS.params})` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/**
 * @brief 查一个文件的行宽、行数和函数长度、入参个数。
 * @param file 文件路径
 * @param text 文件内容
 * @return [{ line, message }]，按出现的顺序；整个文件超长时 line 为 0
 */
export function limitProblems(file, text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const problems = [];
  if (lines.length > LIMITS.fileLines) {
    problems.push({ line: 0, message: `file has ${lines.length} lines (limit ${LIMITS.fileLines})` });
  }
  lines.forEach((line, index) => {
    if ([...line].length > LIMITS.line) {
      problems.push({ line: index + 1, message: `is longer than ${LIMITS.line} characters` });
    }
  });
  return [...problems, ...functionProblems(file, text)];
}
