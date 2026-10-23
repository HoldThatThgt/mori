// 记忆单元测试（core-*.test.mjs）共用的工具（docs/specs/memory.md §14.1）：
// - 把记忆模块、记忆与增强的命令、增强调度与 memory 工具打包成一个模块：分开打包时每一包各有自己的写入队列与 userData，
//   startMemory 只作用于它那一包，所以要一起用的几个模块必须在同一包里；
// - 每个测试一个临时 userData，startMemory 交一个记下全局事件的发送函数；
// - 条目、索引、修订、project.json、enhance.json 由测试按规格 §3 的格式手写（synthetic）。
// 日期与 token 数在这里独立算出（不调用被测的代码），用来核对被测的结果。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from '../load.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 一起打包的内核模块：入口文件写在 test-results/ 下（不进仓库），相对它引用 src/ */
const COMBINED = [
  "export * from '../../src/kernel/memory';",
  "export { handleMemoryCommand } from '../../src/kernel/memoryCommands';",
  "export { startEnhance, enhanceInfo, setEnhance, runNow } from '../../src/kernel/enhance';",
  "export { memoryTool } from '../../src/kernel/memoryTool';",
];

/**
 * @brief 打包并导入记忆模块、记忆与增强的命令、增强调度、memory 工具（同一份模块状态）。
 * @return 合在一起的导出
 */
export async function loadMemoryKernel() {
  const rel = `test-results/unit-entries/mem-core-${process.pid}.ts`;
  const file = join(appRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${COMBINED.join('\n')}\n`);
  try {
    return await loadKernelModule(rel);
  } finally {
    rmSync(file, { force: true });
  }
}

/** 记忆页的写入方（§6.1） */
export const PAGE = Object.freeze({ by: 'You', caller: null, run: null });
/** 对话里的 memory 工具（agent 调用方） */
export const MORI = Object.freeze({ by: 'Mori', caller: Object.freeze({ kind: 'agent' }), run: null });
/** 回滚（memory.ts 一律记为 Rollback） */
export const ROLLBACK = Object.freeze({ by: 'Rollback', caller: null, run: null });

/** @brief 增强任务的写入方（带着这次运行的句柄）。 */
export function enhancer(task, run) {
  return { by: 'Enhancement', caller: { kind: 'enhance', task }, run };
}

/**
 * @brief 一个测试用的临时 userData：启动记忆模块，记下它发的全局事件；测试结束后删掉。
 * @param t node:test 的测试上下文
 * @param kernel loadMemoryKernel 的结果
 * @return userData、事件、一个本项目的工作目录（不需要存在）、两层的目录
 */
export function freshUserData(t, kernel) {
  const userData = mkdtempSync(join(tmpdir(), 'mori-mem-core-'));
  const events = [];
  kernel.startMemory(userData, (event) => events.push(event));
  t.after(() => rmSync(userData, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = join(userData, 'work', 'shop');
  return { userData, events, cwd, userBase: join(userData, 'memory', 'user'), memoryRoot: join(userData, 'memory') };
}

// ---- 独立算出的日期与 token 数 ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** @brief 今天的本地日期 YYYY-MM-DD（memory.ts 用写入时的本地日期）。 */
export function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** @brief YYYY-MM-DD → `Oct 22`（规格 §3.2 的 `<Mon D>`）。 */
export function monDay(key) {
  const [, month, day] = key.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

/** @brief n 个中日韩字符（每个算 1 token，§6.3）。 */
export function cjk(n, char = '字') {
  return char.repeat(n);
}

// ---- 手写的文件（synthetic） ----

/** 每种的索引文件名与标题（§3、§3.1） */
export const INDEX_FILE = Object.freeze({ fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md',
  review: 'REVIEW.md' });
export const KIND_NAME = Object.freeze({ fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' });

/**
 * @brief synthetic：按规格 §3.2 的版式手写的 detail 文件。
 * @param entry kind、abstract，可选 source、created、modified、evidence、details、history
 */
export function detailText(entry) {
  const { kind, abstract, source = 'user', created = '2026-10-20 · You', modified = created, evidence = [],
    details = '', history = [] } = entry;
  const front = ['---', `kind: ${kind}`, `abstract: ${JSON.stringify(abstract)}`, `source: ${source}`,
    `created: ${JSON.stringify(created)}`, `modified: ${JSON.stringify(modified)}`,
    `evidence: ${JSON.stringify(evidence)}`, '---'];
  const revisions = history.map((line) => `- ${line}`).join('\n');
  return `${front.join('\n')}\n## Evidence\n\n## Details\n${details}\n\n## Revisions\n${revisions}\n`;
}

/**
 * @brief synthetic：在一层里写好一种的条目与索引（索引整个重写，顺序同 entries）。
 * @param base 这一层的目录
 * @param kind 种类
 * @param entries [{ slug, abstract, …detailText 的可选字段 }]
 */
export function seedKind(base, kind, entries) {
  mkdirSync(join(base, 'entries'), { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(base, 'entries', `${entry.slug}.md`), detailText({ kind, ...entry }));
  }
  const lines = entries.map((entry) => `- [${entry.abstract}](entries/${entry.slug}.md)`);
  writeFileSync(join(base, INDEX_FILE[kind]), `${[`# ${KIND_NAME[kind]}`, ...lines].join('\n')}\n`);
}

/**
 * @brief synthetic：认领一个项目目录（写 project.json，§3），返回它的目录。
 * @param kernel loadMemoryKernel 的结果
 * @param cwd 工作目录
 */
export function seedProject(kernel, cwd) {
  const { dir } = kernel.projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  return dir;
}

/** @brief 一层的修订文件名（不含 .md），按名字排序。 */
export function revisionIds(base) {
  const dir = join(base, 'revisions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
}

/** @brief 读一个文件；不存在时为 null。 */
export function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** @brief 一层的全部文件与内容（相对路径 → 原文），用来核对“什么都没写”。 */
export function snapshotDir(dir) {
  const result = {};
  const walk = (at, rel) => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, key);
      else result[key] = readFileSync(path, 'utf8');
    }
  };
  walk(dir, '');
  return result;
}

/** @brief 写入成功：error 为 null，返回结果。 */
export function ok(result) {
  if (result.error !== null) throw new Error(`expected success, got: ${result.error}`);
  return result;
}
