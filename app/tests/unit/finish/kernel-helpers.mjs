// 收尾检查单元测试 core.test.mjs、extension*.test.mjs 共用的工具（docs/specs/finish-check.md §14.1）：
// - 把 kernel/finishCheck.ts 与 shared/finishCheck.ts 打包成一个模块（loadFinishKernel）；
// - 规格原文从 docs/specs/finish-check.md 读出（§7.1 的块与表、§7.3 的块、CHECK_LINE_HEAD），测试按它逐字比较；
// - 上下文消息（pi AgentMessage 的形状）与会话条目（pi SessionEntry 的形状）的构造函数：都是测试手写的（synthetic）。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from '../load.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 一起打包的模块：入口写在 test-results/ 下（不进仓库），相对它引用 src/ */
const COMBINED = [
  "export * as core from '../../src/kernel/finishCheck';",
  "export * as shared from '../../src/shared/finishCheck';",
];

/**
 * @brief 打包并导入 kernel/finishCheck.ts 与 shared/finishCheck.ts。
 * @return { core, shared }
 */
export async function loadFinishKernel() {
  const rel = `test-results/unit-entries/fc-kernel-${process.pid}.ts`;
  const file = join(appRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${COMBINED.join('\n')}\n`);
  try {
    return await loadKernelModule(rel);
  } finally {
    rmSync(file, { force: true });
  }
}

/** @brief kernel/finishCheck.ts 的源码（检查它只 import type pi，§2）。 */
export const CORE_SOURCE = readFileSync(join(appRoot, 'src', 'kernel', 'finishCheck.ts'), 'utf8');

// ---- 规格原文（docs/specs/finish-check.md） ----

const SPEC = readFileSync(join(appRoot, '..', 'docs', 'specs', 'finish-check.md'), 'utf8').replace(/\r\n/g, '\n');

/**
 * @brief 规格里一节的正文：从标题行到下一个同级或更高级的标题。
 * @param heading 标题行的开头，例如 '### 7.1'
 */
export function specSection(heading) {
  const at = SPEC.indexOf(`\n${heading}`);
  if (at < 0) throw new Error(`no heading ${heading} in the spec`);
  const level = /^#+/.exec(heading)[0].length;
  const rest = SPEC.slice(at + 1);
  const next = rest.slice(1).search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * @brief 规格里某个标题之后的第一个 ```text 代码块的原文（§7.1 检查那一行、§7.3 finish 的说明）。
 * @param heading 标题行的开头
 */
export function specBlock(heading) {
  const section = specSection(heading);
  const open = section.indexOf('```text\n');
  if (open < 0) throw new Error(`no text block under ${heading}`);
  const start = open + '```text\n'.length;
  return section.slice(start, section.indexOf('\n```', start));
}

/**
 * @brief §7.1 的表：每种 kinds 的第三行；“没有这一行”的那种为 null。
 * @return [{ kinds, third }]
 */
export function specThirdLines() {
  const rows = [...specSection('### 7.1').matchAll(/^\| `(\[[^`]*\])` \| (.+) \|$/gm)];
  if (rows.length === 0) throw new Error('no kinds table in §7.1');
  return rows.map(([, kinds, cell]) => {
    const quoted = /^`([^`]+)`$/.exec(cell.trim());
    return { kinds: JSON.parse(kinds.replaceAll("'", '"')), third: quoted ? quoted[1] : null };
  });
}

/** @brief §7.1 写的 CHECK_LINE_HEAD（检查那一行第一行的开头）。 */
export function specCheckHead() {
  const match = /`CHECK_LINE_HEAD` = [^`]*`([^`]+)`/.exec(specSection('### 7.1'));
  if (!match) throw new Error('no CHECK_LINE_HEAD in §7.1');
  return match[1];
}

// ---- 上下文消息（synthetic，pi AgentMessage 的形状） ----

let clock = 1_000;
/** @brief 递增的时间戳，消息按构造顺序排列。 */
const tick = () => (clock += 1);

/** @brief synthetic：一条 role 为 user 的消息（你的消息、排队、插话、程序投递）。 */
export function userMsg(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: tick() };
}

/** @brief 文字块。 */
export function say(text) {
  return { type: 'text', text };
}

/** @brief 工具调用块。 */
export function call(id, name = 'bash', args = {}) {
  return { type: 'toolCall', id, name, arguments: args };
}

/**
 * @brief synthetic：一条助手消息；有工具调用时 stopReason 为 toolUse，否则 stop。
 * @param blocks 内容块
 * @param stopReason 指定的结束原因（例如 length、error）
 */
export function assistant(blocks, stopReason = undefined) {
  const reason = stopReason ?? (blocks.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop');
  return { role: 'assistant', content: blocks, stopReason: reason, provider: 'fake', model: 'fake-model',
    api: 'openai-completions', usage: {}, timestamp: tick() };
}

/** @brief synthetic：一条工具结果。 */
export function toolResult(id, name = 'bash', isError = false, text = 'ok') {
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError,
    timestamp: tick() };
}

/**
 * @brief synthetic：一条 custom 消息（pi 投影会话里的 custom_message 条目的形状）。
 * @param customType 种类：mori.finish_check、mori.work_card、mori.away_reminder 等
 * @param content 内容
 */
export function customMsg(customType, content) {
  return { role: 'custom', customType, content, display: false, timestamp: tick() };
}

/** @brief synthetic：压缩摘要（压缩之后上下文从它开始，你的消息在摘要里）。 */
export function summaryMsg() {
  return { role: 'compactionSummary', summary: 'Earlier conversation (synthetic).', tokensBefore: 9000,
    timestamp: tick() };
}

// ---- 会话条目（synthetic，pi SessionEntry 的形状） ----

let entryNo = 0;

/**
 * @brief synthetic：一条会话条目。
 * @param type 条目类型
 * @param fields 其余字段
 */
export function entryOf(type, fields = {}) {
  entryNo += 1;
  return { type, id: `e${entryNo}`, parentId: entryNo > 1 ? `e${entryNo - 1}` : null,
    timestamp: '2026-10-27T01:00:00.000Z', ...fields };
}

/** @brief synthetic：message 条目。 */
export function messageEntry(message) {
  return entryOf('message', { message });
}
