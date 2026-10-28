// 文件系统规格（docs/specs/file-system.md §19.2 的 FS-57、FS-59–FS-62、FS-65、FS-66、FS-68；续篇
// file-system-permissions.md §8）的 App 套件 tests/ui/fs-app-team.mjs 用的帮助：
// - 收窄的原文（§8.3 的开头与 §8.4 的规则文字，测试独立抄一份）与按标记找工具调用的结果（用户会话、实例会话、增强会话）；
// - 实例会话（mori.instance 条目）、端点日志里一个会话的请求时段、记录代理收到的请求按种类分的工具；
// - 测试准备（synthetic test setup）：增强的 enhance.json 与今天的会话（同 mem-app-team.mjs 的做法）、FS-68 / FS-65 的
//   合成会话文件（从这次套件里真实存下的会话文件抄出前几行，再改 system 消息声明的工具）。
// 只读磁盘与记录，不改 Mori 的源码。

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FS_MODEL, FS_PROVIDER, poll, readJsonl, toolCallsIn, toolResultsIn } from './fs-helpers.mjs';
import { piSessionDir, writeEnhance } from './mem-enhance-helpers.mjs';
import { contentText, customOf, instanceFiles, messagesOf, scenarioLines, scenarioRequests } from './tb-helpers.mjs';

// ---------- 规格里的文字（file-system-permissions.md §8.3、§8.4，独立抄一份） ----------

/** 收窄的拒绝原文的开头（§8.3 的表；对话会话为整句 RELAY_ONLY） */
export const LEADS = Object.freeze({ task: 'Not allowed for this task', ask: 'Not allowed for this question',
  create: 'Not allowed while deciding requests', close: 'Not allowed while closing a request',
  subscription: 'Not allowed in a subscription' });
/**
 * §8.4 表的规则文字（第 2–4 条）；readOnly 是只读会话里不是只读命令的命令（2026-10-28 负责人定，
 * file-system-permissions.md §8.11）
 */
export const RULE = Object.freeze({ write: 'no file changes or commands', commands: 'no commands',
  mcp: 'no MCP or extension tools', readOnly: 'only read-only commands' });
/** @brief 收窄的拒绝原文：<开头>: <规则文字>.（§8.4）。 */
export const narrowed = (owner, rule) => `${LEADS[owner]}: ${rule}.`;

/** 合成 MCP 服务（fs-helpers writeMcpServer）的工具 */
export const ECHO = 'mcp__srv__echo';
export const MCP_TOOLS = Object.freeze(['mcp__srv__add', 'mcp__srv__echo']);
/** pi 设置的默认工具（没设 defaultTools 时，file-system-permissions.md §8.6） */
export const PI_DEFAULTS = Object.freeze(['bash', 'edit', 'read', 'write']);
/**
 * @brief 测试进程的 PATH 上有没有这个程序（App 继承这个进程的 PATH；file-system-permissions.md §8.11 先找
 *        <agentDir>\bin，再找 PATH 的每一项）。
 */
export const onPath = (program) => (process.env.PATH ?? '').split(';')
  .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).some((dir) => dir !== '' && existsSync(join(dir, program)));
/**
 * 只读会话碰文件的工具，排好序：read 加 pi 的默认工具去掉 edit、write，再加装了程序的搜索工具（PATH 上有 rg.exe 时
 * grep，有 fd.exe 时 find；测试的数据目录的 <agentDir>\bin 是空的；§8.11）
 */
export const READ_ONLY_DEFAULTS = Object.freeze([...new Set(['bash', 'read', ...(onPath('rg.exe') ? ['grep'] : []),
  ...(onPath('fd.exe') ? ['find'] : [])])].sort());
/** TaskBoard 的工具（shared/team.ts TEAM_TOOLS，独立抄一份） */
export const TEAM_TOOLS = Object.freeze(['board_read', 'read_session', 'agent_message', 'task_handoff',
  'request_submit', 'request_update', 'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog',
  'request_close']);
/** 立项持有者多出的 TaskBoard 工具（平行 Agent 规格 §6.3） */
const CREATE_ONLY = ['request_submit', 'request_update', 'request_cancel', 'task_create', 'task_edit',
  'reply_via_dialog'];
/** 每种实例与用户会话在协作模式下的职责工具（§8.6 的表、平行 Agent 规格 §6.3，独立抄一份） */
export const DUTY = Object.freeze({
  create: ['board_read', 'read_session', 'agent_message', ...CREATE_ONLY],
  close: ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_close'],
  task: ['board_read', 'read_session', 'agent_message', 'task_handoff'],
  ask: ['board_read', 'read_session'],
  subscription: ['board_read', 'read_session', 'agent_message'],
  dialog: ['board_read', 'read_session', 'agent_message'],
  merged: ['board_read', 'read_session', 'agent_message', ...CREATE_ONLY],
});

/** @brief 调合成 MCP 服务 echo 的一步（关键词的单步写法）。 */
export const echoStep = (text) => `call tool: ${ECHO} ${JSON.stringify({ text })}`;
/** @brief 去掉 task 实例工具结果开头的证据编号 "[#n] "（平行 Agent 规格 §7.3）。 */
export const untag = (text) => String(text ?? '').replace(/^\s*\[#\d+\] /, '');
/** @brief 排好序的副本。 */
export const sorted = (list) => [...list].sort();

// ---------- 工具调用与结果 ----------

/**
 * @brief 一个会话文件里参数含 marker 的工具调用与它们的结果（按调用的顺序）：[{ file, id, tool, args, isError, text }]；
 *        还没有结果的调用 isError 与 text 为 null。text 去掉了证据编号。
 */
export function callResults(file, marker) {
  const results = toolResultsIn(file);
  return toolCallsIn(file).filter((call) => JSON.stringify(call.args).includes(marker)).map((call) => {
    const result = results.find((item) => item.id === call.id) ?? null;
    return { file, id: call.id, tool: call.name, args: call.args, isError: result ? result.isError : null,
      text: result ? untag(result.text) : null };
  });
}

/** @brief 几个会话文件里工具名为 tool、参数含 marker 的第一个调用的结果（callResults）；没有时为 null。 */
export function firstCall(files, tool, marker) {
  for (const file of files) {
    const found = callResults(file, marker).filter((item) => item.tool === tool);
    if (found.length > 0) return found[0];
  }
  return null;
}

/**
 * @brief 会话文件里按顺序重放 system 消息的 toolsAdded / toolsRemoved（pi 恢复启用的工具的规则，file-system-permissions.md
 *        §8.6）得到的声明的工具名（排好序）；没有 system 消息时为 []。
 */
export function declaredTools(file) {
  const tools = new Set();
  for (const entry of readJsonl(file)) {
    if (entry.type !== 'message' || entry.message?.role !== 'system') continue;
    for (const tool of entry.message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of entry.message.toolsAdded ?? []) tools.add(tool.name);
  }
  return sorted([...tools]);
}

/** @brief 结果的简写（检查的 detail）。 */
export const resultBrief = (result) => (result ? { tool: result.tool, isError: result.isError,
  text: result.text?.slice(0, 160) ?? null } : null);

/** @brief 一个结果是被拒绝的（isError）且原文就是 text。 */
export const refusedWith = (result, text) => result?.isError === true && result.text === text;
/** @brief 一个结果执行成功（有结果、不是错误）。 */
export const ranOk = (result) => result?.isError === false;

// ---------- 实例会话 ----------

/**
 * @brief 这个用户会话（或增强会话）的实例会话：instanceFiles 的每项加上 mori.instance 条目（{ kind, role, task }）与
 *        全部 user 消息的文字（firstUser 为第一条）。
 */
export function instancesOf(ctx, sessionId) {
  return instanceFiles(ctx, sessionId).map((item) => {
    const users = messagesOf(item.entries, 'user').map((message) => contentText(message.content));
    return { ...item, meta: customOf(item.entries, 'mori.instance')[0] ?? {}, users, firstUser: users[0] ?? '' };
  });
}

/** @brief 实例里第一个 kind 种类、（给了时）任一 user 消息含 marker 的；没有时为 null。 */
export function instanceOf(list, kind, marker = null) {
  return list.find((item) => item.meta.kind === kind
    && (marker === null || item.users.some((text) => text.includes(marker)))) ?? null;
}

/** @brief 这个用户会话与它全部实例的会话文件（找调用用）。 */
export const teamFiles = (ctx, who) => [who.sessionFile, ...instanceFiles(ctx, who.sessionId).map((item) => item.file)];

// ---------- 端点日志与请求 ----------

/**
 * @brief 端点日志里脚本 scenario 的某个会话（where：agent、kind、task、since）的请求时段：{ count, first, last }
 *        （收到请求的时刻；没有请求时 first、last 为 null）。
 */
export function spanOf(ep, scenario, where) {
  const lines = scenarioLines(ep, scenario, where);
  return { count: lines.length, first: lines[0]?.t ?? null, last: lines.at(-1)?.t ?? null };
}

/**
 * @brief 记录代理收到的脚本 scenario 的请求（since 之后），按会话的种类（scripts.mjs 认出的 kind）分：
 *        { <kind>: [{ t, task（工作卡里的 T<n> 或 null）, tools（排好序）, users（全部 user 消息的文字，用 \n 连接） }] }。
 */
export function toolsByKind(ep, scenario, since = 0) {
  const out = {};
  for (const request of scenarioRequests(ep, scenario, { since })) {
    const users = request.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).join('\n');
    (out[request.info.kind] ??= []).push({ t: request.t, task: request.info.task ?? null, tools: sorted(request.tools),
      users });
  }
  return out;
}

/** @brief 工具名里碰文件的部分：pi 的内置工具与 MCP 工具（排好序）。 */
export const fileTools = (tools) => sorted(tools.filter((name) => ['read', 'bash', 'edit', 'write', 'grep', 'find',
  'ls', 'powershell'].includes(name) || name.startsWith('mcp__')));
/** @brief 工具名里的 TaskBoard 工具（排好序）。 */
export const boardTools = (tools) => sorted(tools.filter((name) => TEAM_TOOLS.includes(name)));

// ---------- 增强（synthetic test setup，同 mem-app-team.mjs 的做法） ----------

/** @brief 两位数。 */
const pad = (n) => String(n).padStart(2, '0');
/** @brief 本地日期 YYYY-MM-DD。 */
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * @brief 现在的日子与时刻（记忆规格 §9.2）：每天的时刻取现在之前两小时的 HH:MM，今天 = 那一刻的本地日期，下一次到点
 *        约 22 小时后（套件跑完之前定时器不会到）。
 */
export function dayClock(now = Date.now()) {
  const shifted = new Date(now - 2 * 3600000);
  const yesterday = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() - 1, 12);
  return { now, time: `${pad(shifted.getHours())}:${pad(shifted.getMinutes())}`, today: localDay(shifted),
    yesterday: localDay(yesterday) };
}

/**
 * @brief 测试准备（synthetic）：这个项目的 project.json 与 enhance.json（记忆规格 §9.1 的格式）：开着、pick 为本机
 *        提供商、思考 off、team 按参数；三个任务的 doneThrough 为昨天、since 为今天，所以 Run now 时有今天材料的任务都跑。
 */
export function seedEnhancement(userData, project, team) {
  const clock = dayClock();
  const task = () => ({ doneThrough: clock.yesterday, watermarks: {}, feedbackSeen: null, running: null, last: null });
  writeEnhance(userData, project, { enabled: true, pick: FS_PROVIDER, thinking: 'off', team, time: clock.time,
    since: clock.today, tasks: { taste: task(), strategy: task(), review: task() }, notice: null });
}

// ---------- 合成会话文件（FS-65、FS-68；synthetic test setup） ----------

/** @brief 8 位十六进制的条目 id（同 pi 的写法）。 */
const entryId = () => randomBytes(4).toString('hex');
/** 合成的用量（assistant 消息带它，pi getSessionStats 的写法） */
const USAGE = { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * @brief 一个真实会话文件第一条 user 消息之前的条目（会话头之后：mori.pick、model_change、system 消息等），和第一条
 *        system 消息声明的工具对象（按名字）。
 * @return { head（条目数组，不含会话头）, tools（Map<名字, 工具对象>） }；文件里没有 system 消息时抛错
 */
export function sessionPrelude(file) {
  const entries = readJsonl(file).slice(1);
  const firstUser = entries.findIndex((entry) => entry.type === 'message' && entry.message?.role === 'user');
  const head = entries.slice(0, firstUser < 0 ? entries.length : firstUser);
  const system = head.find((entry) => entry.type === 'message' && entry.message?.role === 'system');
  if (!system) throw new Error(`no system message before the first user message in ${file}`);
  return { head, tools: new Map((system.message.toolsAdded ?? []).map((tool) => [tool.name, tool])) };
}

/**
 * @brief 测试准备（synthetic）：从 sessionPrelude 抄出前几行，system 消息只声明 names 这几个工具（工具对象取自 tools，
 *        没有的写一个只有名字、说明与空参数的对象），后面接一问一答；写到 cwd 的 pi 会话目录，会话头的 cwd 是它。
 * @param userData 数据目录
 * @param cwd 会话的工作目录
 * @param prelude sessionPrelude 的结果（可以来自别的项目的会话：抄的条目与工作目录无关）
 * @param opts { names（声明的工具名）, label（会话名与问题里的标记） }
 * @return { file, id, text（会话文件的全文，核对没被改写用） }
 */
export function writeDeclaredSession(userData, cwd, prelude, opts) {
  const at = Date.now() - 120000;
  const id = randomUUID();
  const dir = piSessionDir(userData, cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date(at).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [{ type: 'session', version: 3, id, timestamp: new Date(at).toISOString(), cwd: resolve(cwd) }];
  let parent = null;
  const push = (entry) => {
    const own = entry.id ? entry : { ...entry, id: entryId() };
    lines.push({ ...own, parentId: parent });
    parent = own.id;
  };
  push({ type: 'session_info', timestamp: new Date(at).toISOString(), name: opts.label });
  for (const entry of prelude.head) push(declared(entry, prelude.tools, opts.names));
  const t = at + 1000;
  push({ type: 'message', timestamp: new Date(t).toISOString(), message: { role: 'user',
    content: [{ type: 'text', text: `${opts.label} question` }], timestamp: t } });
  push({ type: 'message', timestamp: new Date(t + 1000).toISOString(), message: { role: 'assistant',
    content: [{ type: 'text', text: `${opts.label} answer.` }], api: 'openai-completions', provider: FS_PROVIDER,
    model: FS_MODEL, usage: USAGE, stopReason: 'stop', timestamp: t + 1000 } });
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  writeFileSync(file, text);
  return { file, id, text };
}

/** @brief 一个抄来的条目：system 消息改成只声明 names（toolsRemoved 去掉），其余原样（id 换新的）。 */
function declared(entry, tools, names) {
  const copy = { ...entry, id: entryId() };
  if (entry.type !== 'message' || entry.message?.role !== 'system') return copy;
  const { toolsRemoved: _removed, ...message } = entry.message;
  const object = (name) => tools.get(name) ?? { name, description: `${name} (synthetic declaration)`,
    parameters: { type: 'object', properties: {} } };
  return { ...copy, message: { ...message, toolsAdded: names.map(object) } };
}

/** @brief 读一个文件的全文；不存在时为 null。 */
export const fileText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/** @brief 等 test(读到的值) 为真，最多 timeout；返回最后一次读到的值。 */
export async function settleOn(read, test, timeout = 15000) {
  let last = null;
  await poll(async () => {
    last = await read();
    return test(last);
  }, timeout, 200);
  return last;
}
