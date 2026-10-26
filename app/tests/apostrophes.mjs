// 撇号检查（docs/v0/ui-strings.md 写法约定：撇号用排版符号 ’，例如 Couldn’t、Mori’s、don’t），由 tests/check.mjs
// （npm run check）对 app/src 的每个 .ts/.tsx 调用，单元测试在 tests/unit/apostrophes.test.mjs。
// 查的：字符串、模板字符串各段与 JSX 文本（含 JSX 属性的字符串）里直撇号的缩写和所有格，即“字母'字母”（can't、
// user's，写成 \' 的也算），以及紧跟 ${…} 之后的 's（`${who}'s run`）。复数所有格（tasks' work）认不出，不查。
// 不查的：
//   - 正则字面量（规则说正则照原样）；注释不在语法树里；
//   - console.* 的参数：只写进日志；
//   - 前面的注释里写了 KEEP_MARK 的语句、声明、属性或 case（整段跳过）：只给模型看的文字（system prompt 的段、
//     工作卡、[Mori] 投递、增强会话，多是规格附录逐字的原文）和只写日志、抛出的错误原文。界面、工具卡与
//     Customize › Tools 里给人看的文字不加这个标记。

import ts from 'typescript';

/** @brief 写在注释里、让紧跟的语句或声明不查撇号的标记。 */
export const KEEP_MARK = '撇号照原样';

/** @brief 直撇号的缩写与所有格：前面是字母，或模板字符串里 ${…} 的右括号；后面是字母；中间可以有转义的反斜杠。 */
const STRAIGHT = /[A-Za-z}]\\?'[A-Za-z]/g;

/** @brief 字面量去掉两端定界符之后的正文：[开头偏移, 结尾偏移]，模板字符串的中段和末段留着开头的 }。 */
const BODY = new Map([
  [ts.SyntaxKind.StringLiteral, [1, -1]],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, [1, -1]],
  [ts.SyntaxKind.TemplateHead, [1, -2]],
  [ts.SyntaxKind.TemplateMiddle, [0, -2]],
  [ts.SyntaxKind.TemplateTail, [0, -1]],
  [ts.SyntaxKind.JsxText, [0, 0]],
]);

/**
 * @brief 节点前面的注释里是否写了 KEEP_MARK。文件节点不算：文件开头的注释同时也是第一个语句的注释，标记只管那个语句。
 * @param text 源码全文
 * @param node 语法树节点
 */
function marked(text, node) {
  if (ts.isSourceFile(node)) return false;
  const comments = ts.getLeadingCommentRanges(text, node.pos) ?? [];
  return comments.some((range) => text.slice(range.pos, range.end).includes(KEEP_MARK));
}

/**
 * @brief 节点是否为 console.* 的调用。
 * @param node 语法树节点
 */
function consoleCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console';
}

/**
 * @brief 列出一个 .ts/.tsx 文件里有直撇号的行。
 * @param file 文件路径（按扩展名认 TSX）
 * @param text 文件内容
 * @return 有直撇号的行号（从 1 起），升序、不重复
 */
export function straightApostropheLines(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const lines = new Set();
  const visit = (node) => {
    if (marked(text, node) || consoleCall(node)) return;
    const body = BODY.get(node.kind);
    if (body) {
      const start = node.getStart(source) + body[0];
      const raw = text.slice(start, node.end + body[1]);
      for (const match of raw.matchAll(STRAIGHT)) {
        lines.add(source.getLineAndCharacterOfPosition(start + match.index).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...lines].sort((a, b) => a - b);
}
