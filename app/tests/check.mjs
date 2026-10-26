// 静态检查（docs/app-v0.md 第 8 节、proposal 工程约束与 docs/v0/ui-strings.md）：
//   - src/ 中不能出现"示例""演示""mock"；
//   - src/ 每行不超过 120 个字符；
//   - 界面文字只用英文：.ts/.tsx 的字符串、模板字符串各段、正则字面量与 JSX 文本，以及去掉注释后的 .html、.css，
//     不能有中文（中日韩统一表意文字含扩展 A、中日韩符号和标点、半角及全角形式，平假名和片假名也算）。注释可以写中文。
//   - 撇号用排版符号 ’：.ts/.tsx 的字符串、模板字符串各段与 JSX 文本里不能有直撇号的缩写和所有格（can't、user's）；
//     只给模型看的文字、日志与错误原文用注释标出后不查，规则与例外见 tests/apostrophes.mjs。
// 发现问题时逐条列出并以退出码 1 结束。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { straightApostropheLines } from './apostrophes.mjs';

const root = resolve(import.meta.dirname, '..');
const banned = /示例|演示|mock/i;
const chinese = /[　-ヿ㐀-䶿一-鿿＀-￯]/;
const maxLength = 120;
const problems = [];

/** @brief .ts/.tsx 中要检查的字面量；注释是 trivia，不在 AST 节点里。 */
const literalKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/** @brief 递归列出目录下的源文件。 */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|html)$/.test(name) ? [path] : [];
  });
}

/** @brief 把文字换成等长的空格，保留换行，行号与列不变。 */
function blank(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

/** @brief 只留下 .ts/.tsx 的字面量，其余（代码与注释）换成空格；AST 按源码顺序遍历，字面量互不嵌套。 */
function literalsOnly(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  let kept = '';
  let at = 0;
  const visit = (node) => {
    if (literalKinds.has(node.kind)) {
      const start = node.getStart(source);
      kept += blank(text.slice(at, start)) + text.slice(start, node.end);
      at = node.end;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return kept + blank(text.slice(at));
}

/** @brief 返回要查中文的文字：.ts/.tsx 只留字面量，.html 与 .css 去掉注释。 */
function textToCheck(file, text) {
  if (/\.tsx?$/.test(file)) return literalsOnly(file, text);
  const comment = file.endsWith('.html') ? /<!--[\s\S]*?-->/g : /\/\*[\s\S]*?\*\//g;
  return text.replace(comment, blank);
}

for (const file of sourceFiles(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const checked = textToCheck(file, text).split(/\r?\n/);
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${relative(root, file)}:${index + 1}`;
    const snippet = line.trim().slice(0, 80);
    if (banned.test(line)) problems.push(`${where} contains a banned word: ${snippet}`);
    if ([...line].length > maxLength) problems.push(`${where} is longer than ${maxLength} characters`);
    if (chinese.test(checked[index])) problems.push(`${where} contains Chinese text: ${snippet}`);
  });
  if (!/\.tsx?$/.test(file)) continue;
  const lines = text.split(/\r?\n/);
  for (const line of straightApostropheLines(file, text)) {
    const snippet = lines[line - 1].trim().slice(0, 80);
    problems.push(`${relative(root, file)}:${line} has a straight apostrophe in text (use ’): ${snippet}`);
  }
}

for (const problem of problems) console.error(problem);
console.log(problems.length ? `check failed: ${problems.length} problem(s)` : 'check passed');
process.exitCode = problems.length ? 1 : 0;
