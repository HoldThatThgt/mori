// 路径闸单元测试（docs/specs/file-system-permissions.md §6–§8）共用的帮助函数：临时项目目录（synthetic）、
// 计数的文件系统探针、截下日志、假的 pi（只收下 on 注册的处理器）与假的 ctx、记下事件的 GateOutput。
// 规格原文从 docs/specs/ 读出，测试与规格逐字比较。

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const specsDir = join(appRoot, '..', 'docs', 'specs');

/** 你拒绝时的原文（§6.15，不变） */
export const REJECTED_TEXT = 'Rejected by the user.';
/** 你按了停止时的原文（§6.1、§6.15） */
export const STOP_TEXT = 'Rejected: the user stopped the run.';
/** 没人能批时拒绝原文的开头（§6.15、§14） */
export const NOBODY_HEAD = 'Denied by Mori: nobody can approve tool calls in this run, and this call ';
/** 对 scope 不是 inside 的请求答 allowSession 的原文（§6.8） */
export const SESSION_NOT_INSIDE =
  'Allow for this session doesn’t apply to writes outside the working directory or to protected paths.';
/** 对没有 allowDirs 的请求答 allowDir 的原文（§6.9） */
export const NO_FOLDER = 'This request can’t be allowed by folder.';

/**
 * @brief 没人能批时的拒绝原文（§6.15）。
 * @param why 按目标的理由拼好的 <why>
 */
export function nobodyText(why) {
  return `${NOBODY_HEAD}${why}. Don't retry it.`;
}

/**
 * @brief 读一份规格（docs/specs/<name>），换行统一为 \n。
 * @param name 文件名，例如 'file-system.md'
 */
export function specText(name) {
  return readFileSync(join(specsDir, name), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * @brief 临时项目（synthetic）：<root>\proj 是工作路径，<root> 下的其他目录是工作路径外。root 取真实路径
 *        （os.tmpdir() 可能是 8.3 短名），词法路径与真实路径一致。
 * @param prefix 临时目录名的前缀
 */
export function tempProject(prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const cwd = join(root, 'proj');
  mkdirSync(cwd);
  return { root, cwd, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @brief 计数的文件系统探针（FS-29）：记下每次 lstat、realpath 的路径，交给 node:fs 的同步版。
 * @param override 可选：对某个路径改写行为（返回 undefined 时照常），用来注入错误
 */
export function countingProbe(override = () => undefined) {
  const calls = [];
  const probe = {
    lstat(path) {
      calls.push(['lstat', path]);
      return override('lstat', path) ?? lstatSync(path);
    },
    realpath(path) {
      calls.push(['realpath', path]);
      return override('realpath', path) ?? realpathSync.native(path);
    },
  };
  return { probe, calls };
}

/**
 * @brief 运行 fn 时截下 console.error 与 console.log（被测代码记的日志），结束后恢复。
 * @param fn 同步或异步的函数
 * @return { value, errors, logs }
 */
export async function quietly(fn) {
  const errors = [];
  const logs = [];
  const error = console.error;
  const log = console.log;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    const value = await fn();
    return { value, errors, logs };
  } finally {
    console.error = error;
    console.log = log;
  }
}

/** @brief 同步版的 quietly。 */
export function quietlySync(fn) {
  const errors = [];
  const logs = [];
  const error = console.error;
  const log = console.log;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { value: fn(), errors, logs };
  } finally {
    console.error = error;
    console.log = log;
  }
}

/** @brief 等微任务与一轮 I/O 跑完。 */
export const settle = () => new Promise((done) => setImmediate(done));

/**
 * @brief 一个会话的批准扩展（synthetic 的 pi：只收下 on 注册的处理器；synthetic 的 ctx：cwd、signal、sessionManager）。
 * @param policy 共用的 ApprovalPolicy
 * @param options cwd（必需）；instance：实例的 pi 会话 id（省略为对话会话）；kind、userSessionId、narrowing
 */
export function fakeSession(policy, options) {
  const { cwd, instance, kind = instance ? 'task' : 'user', userSessionId = 'U', narrowing } = options;
  const sent = [];
  const requests = [];
  const ends = [];
  const output = { prefix: instance ? `${instance}:` : '', send: (event) => sent.push(event), cwd, kind,
    userSessionId, ...(narrowing ? { narrowing } : {}) };
  if (instance) {
    output.onRequest = (request) => requests.push(request);
    output.onEnd = (end) => ends.push(end);
  }
  const gate = policy.gate(output);
  const handlers = {};
  gate.extension()({ on: (name, fn) => { handlers[name] = fn; } });
  const sessionId = instance ?? userSessionId;
  const ctx = { cwd, signal: undefined, sessionManager: { getSessionId: () => sessionId } };
  let next = 0;
  /** 这个会话发出的批准请求（对话会话在自己的信封上，实例交给 Team） */
  const asked = () => (instance ? requests : sent.filter((event) => event.type === 'mori.approval_request'));
  /** 结束事件（对话会话为 mori.approval_end，实例为 onEnd） */
  const ended = () => (instance ? ends : sent.filter((event) => event.type === 'mori.approval_end'));
  /**
   * @brief 一次工具调用：先预告（announce 可关），再交给 tool_call 处理器。
   * @return { id, result（pi 拿到的结果的 Promise）, gates（这个调用的 mori.tool_gate 值）, request（发出的请求或 undefined） }
   */
  const run = (toolName, input = {}, { announce = true, ctxOverride = {} } = {}) => {
    next += 1;
    const id = `${sessionId}-c${next}`;
    if (announce) gate.announce(id, toolName, input);
    const result = handlers.tool_call({ toolCallId: id, toolName, input }, { ...ctx, ...ctxOverride });
    const gates = sent.filter((event) => event.type === 'mori.tool_gate' && event.toolCallId === id)
      .map((event) => event.gate);
    const request = asked().find((item) => item.toolCallId === id);
    return { id, result, gates, request };
  };
  return { gate, handlers, sent, requests, ends, asked, ended, run, ctx };
}
