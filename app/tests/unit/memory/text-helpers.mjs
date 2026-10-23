// 记忆单元测试 text-*.test.mjs 共用的工具（docs/specs/memory.md §14.1：身份段与 pi 的逐字比较、分节、分发、
// memory 工具（替身会话，synthetic）、mori-memory 的钩子、第一条消息）：
// - 把 memoryText、memoryAssemble、memoryExtension、memoryTool 与记忆模块打包成一个模块（同一份模块状态：
//   startMemory 设好的目录就是 memory 工具与 mori-memory 读写的目录）；
// - pi 的 buildSystemPromptSections 与内置工具的定义按文件路径从 node_modules 载入（pi 没有从包入口导出它们）；
// - 扩展 API 的替身（synthetic）：同一个事件可以有几个处理器，按注册顺序调用（同 pi 的 ExtensionRunner）；
// - 会话文件、记忆文件由测试按 pi 与规格 §3 的格式手写（synthetic）；
// - 规格附录的原文从 docs/specs/memory.md 读出，测试按它逐字比较。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { loadKernelModule } from '../load.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const piDist = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');

/** 一起打包的内核模块：入口写在 test-results/ 下（不进仓库），相对它引用 src/；每个模块一个命名空间 */
const COMBINED = [
  "export * as text from '../../src/kernel/memoryText';",
  "export * as assemble from '../../src/kernel/memoryAssemble';",
  "export * as ext from '../../src/kernel/memoryExtension';",
  "export * as tool from '../../src/kernel/memoryTool';",
  "export * as memory from '../../src/kernel/memory';",
  "export * as shared from '../../src/shared/memory';",
  "export * as days from '../../src/kernel/enhanceDays';",
  "export { ApprovalPolicy } from '../../src/kernel/approval';",
];

/**
 * @brief 打包并导入被测的几个内核模块（同一份记忆模块状态）。
 * @return { text, assemble, ext, tool, memory, shared, days, ApprovalPolicy }
 */
export async function loadTextKernel() {
  const rel = `test-results/unit-entries/mem-text-${process.pid}.ts`;
  const file = join(appRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${COMBINED.join('\n')}\n`);
  try {
    return await loadKernelModule(rel);
  } finally {
    rmSync(file, { force: true });
  }
}

/** @brief pi 1.3.0 的 dist/core/system-prompt.js（buildSystemPromptSections 等，按文件路径载入）。 */
export const piPrompt = await import(pathToFileURL(join(piDist, 'core', 'system-prompt.js')).href);
/** @brief pi 1.3.0 的 dist/core/tools/index.js（createAllToolDefinitions：会话注册的全部内置工具）。 */
export const piTools = await import(pathToFileURL(join(piDist, 'core', 'tools', 'index.js')).href);

/** pi 的全部内置工具（agent-session.js 用 createAllToolDefinitions 注册它们） */
export const BUILTIN_TOOLS = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
/** pi 默认启用的工具 */
export const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];

/** @brief pi agent-session.js _normalizePromptSnippet：压成一行，空的不要。 */
function normalizeSnippet(text) {
  if (!text) return undefined;
  const line = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > 0 ? line : undefined;
}

/** @brief pi agent-session.js _normalizePromptGuidelines：去掉首尾空白、去重。 */
function normalizeGuidelines(list) {
  return [...new Set((list ?? []).map((item) => item.trim()).filter((item) => item.length > 0))];
}

/**
 * @brief 照 pi 的实际形状给出 toolSnippets、toolGuidelines（agent-session.js 1272-1296、2871-2882）：全部注册的工具
 *        （内置的八个，加上扩展注册的），不论是否声明；扩展工具的 promptGuidelines 在 toolGuidelines.<名字> 里。
 * @param cwd 工作目录（内置工具的定义要它）
 * @param extensionTools 扩展注册的工具定义（synthetic）
 */
export function registeredPrompt(cwd, extensionTools = []) {
  const definitions = [...Object.values(piTools.createAllToolDefinitions(cwd, { read: {}, bash: {} })),
    ...extensionTools];
  const toolSnippets = {};
  const toolGuidelines = {};
  for (const definition of definitions) {
    const snippet = normalizeSnippet(definition.promptSnippet);
    if (snippet) toolSnippets[definition.name] = snippet;
    const guidelines = normalizeGuidelines(definition.promptGuidelines);
    if (guidelines.length > 0) toolGuidelines[definition.name] = guidelines;
  }
  return { toolSnippets, toolGuidelines };
}

/**
 * @brief 扩展 API 的替身（synthetic）：记下注册的工具；同一事件的处理器按注册顺序调用，tool_call 第一个拒绝即返回
 *        （同 pi 的 ExtensionRunner）；启用的工具由测试设（pi 建会话时启用 defaultActive 的工具，这里由测试显式加上）。
 *        handlers 与 TaskBoard 测试的替身一样按事件名给出一个可调用的函数（teamHarness.mjs 的 beginRun 用它）。
 * @param base 基座的工具（getAllTools 里注册的内置工具，也是一开始启用的）
 */
export function fakePi(base = DEFAULT_TOOLS) {
  const tools = new Map();
  const lists = new Map();
  const handlers = new Map();
  let active = [...base];
  const dispatch = (name) => (event, ctx) => {
    let out;
    for (const handler of lists.get(name)) {
      const result = handler(event, ctx);
      if (name === 'tool_call' && result?.block) return result;
      if (result !== undefined) out = result;
    }
    return out;
  };
  return {
    tools, handlers,
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (name, handler) => {
      if (!lists.has(name)) {
        lists.set(name, []);
        handlers.set(name, dispatch(name));
      }
      lists.get(name).push(handler);
    },
    getAllTools: () => [...base, ...tools.keys()].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
  };
}

/**
 * @brief before_agent_start 的事件（synthetic）：选项照 pi 的形状（normalizeBuildSystemPromptOptions），
 *        selectedTools 是 pi 在所有处理器之前拷的那一份（§4.2：不随 mori-team 的 setActiveTools 更新）。
 * @param over 选项的字段（cwd、selectedTools、toolSnippets、customPrompt、sections …）
 */
export function agentStart(over = {}) {
  return { type: 'before_agent_start', prompt: 'hi', systemPromptOptions:
    piPrompt.normalizeBuildSystemPromptOptions({ cwd: 'D:\\shop', ...over }) };
}

/**
 * @brief 一个测试用的临时 userData：启动记忆模块，记下它发的全局事件；测试结束后删掉。
 * @param t node:test 的测试上下文
 * @param K loadTextKernel 的结果
 * @return userData、事件、记忆目录、一个本项目的工作目录（已建好）
 */
export function freshUserData(t, K) {
  const userData = mkdtempSync(join(tmpdir(), 'mori-mem-text-'));
  const events = [];
  K.memory.startMemory(userData, (event) => events.push(event));
  t.after(() => rmSync(userData, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = join(userData, 'work', 'shop');
  mkdirSync(cwd, { recursive: true });
  return { userData, events, memoryRoot: join(userData, 'memory'), cwd };
}

/**
 * @brief memory 工具的一次调用，按 pi 的顺序：prepareArguments、pi 的 validateToolArguments（不合 schema 时抛出
 *        `Validation failed for tool "memory"…`，不进执行）、execute。
 * @param def memoryTool 的定义
 * @param args 模型给的参数
 * @return 结果的文字、isError、details
 */
export async function callTool(def, args) {
  const prepared = def.prepareArguments(args);
  const valid = validateToolArguments({ name: def.name, parameters: def.parameters },
    { type: 'toolCall', id: 'c1', name: def.name, arguments: prepared });
  const result = await def.execute('c1', valid, undefined, undefined, {});
  return { text: result.content.map((part) => part.text).join(''), isError: result.isError === true,
    details: result.details };
}

/** 记忆页的写入方（§6.1），测试用它预先写好条目 */
export const PAGE = Object.freeze({ by: 'You', caller: null, run: null });

/** @brief 写入成功：error 为 null，返回结果。 */
export function ok(result) {
  if (result.error !== null) throw new Error(`expected success, got: ${result.error}`);
  return result;
}

/**
 * @brief synthetic：按 pi 的格式手写一个会话文件（第 1 行是头，之后每行一个消息条目），返回每个条目。
 * @param file 会话文件的路径
 * @param cwd 会话的工作目录
 * @param lines [{ id, role, text, timestamp }]，timestamp 为 ISO 时刻
 */
export function writeSessionFile(file, cwd, lines) {
  mkdirSync(dirname(file), { recursive: true });
  const header = { type: 'session', version: 3, id: 'synthetic-session', timestamp: lines[0]?.timestamp, cwd };
  let parentId = null;
  const entries = lines.map((line) => {
    const entry = { type: 'message', id: line.id, parentId, timestamp: line.timestamp, message: { role: line.role,
      content: [{ type: 'text', text: line.text }], timestamp: Date.parse(line.timestamp) } };
    parentId = line.id;
    return entry;
  });
  writeFileSync(file, `${[header, ...entries].map((item) => JSON.stringify(item)).join('\n')}\n`);
  return entries;
}

/** @brief 一个目录下的全部文件与内容（相对路径 → 原文），用来核对“什么都没写”。 */
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

/** @brief 时刻（ms 或 ISO）的本地日历日期 YYYY-MM-DD，独立算出（不调用被测的代码）。 */
export function localDay(time) {
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- 规格原文（docs/specs/memory.md） ----

const SPEC = readFileSync(join(appRoot, '..', 'docs', 'specs', 'memory.md'), 'utf8').replace(/\r\n/g, '\n');

/**
 * @brief 规格里某个标题之后的第一个 ```text 代码块的原文（附录 A、附录 B）。
 * @param heading 标题行的开头，例如 '### A.1'
 */
export function specBlock(heading) {
  const at = SPEC.indexOf(`\n${heading}`);
  if (at < 0) throw new Error(`no heading ${heading} in the spec`);
  const open = SPEC.indexOf('```text\n', at) + '```text\n'.length;
  return SPEC.slice(open, SPEC.indexOf('\n```', open));
}

/**
 * @brief 规格里形如 ``- <label>：`<原文>` `` 的一行里的原文（附录 A.4 的 Correct form、附录 B 的任务段）。
 * @param label 行首的标签（含反引号时照写），例如 'TASTE' 或 '`agent`'
 */
export function specItem(label) {
  const line = SPEC.split('\n').find((each) => each.startsWith(`- ${label}：\``));
  if (!line) throw new Error(`no item ${label} in the spec`);
  return line.slice(`- ${label}：\``.length, line.lastIndexOf('`'));
}
