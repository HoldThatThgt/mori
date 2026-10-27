// away.test.mjs、ask.test.mjs、team-ask.test.mjs 共用的测试工具（docs/specs/file-system-permissions.md §9、§10）：
// 每个测试一份全新的内核模块（awayEntry.mjs 打包一次、每次重新导入，away.ts 的全局状态随之全新），startAway 用注入的时钟与
// 临时 userData；发出的事件（away.ts 的 mori.away_timer、批准扩展、提问、扩展询问）都按到达顺序记进同一个 log，
// 写记录的调用记进 records。批准扩展、提问工具、扩展询问用手写的 pi 接口（synthetic）驱动，不连模型、不起 Electron。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 环境变量：测试用的时长（§9.3 最后一条） */
const TIMEOUT_ENV = 'MORI_AWAY_TIMEOUT_MS';
/** app/ 目录 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 打包结果的地址（每个进程只打包一次） */
let bundled = null;
/** 已导入的次数：每次用不同的查询串，得到全新的模块状态 */
let imports = 0;

/**
 * @brief 打包 awayEntry.mjs（选项同 tests/unit/load.mjs 的 loadKernelModule：依赖包保持外部引用，结果写在
 *        app/test-results/unit-bundles/ 下、按进程命名）。只打包一次，进程结束时删掉；每个测试按不同的查询串导入，
 *        各得一份全新的模块状态（每次都重新打包要多花约 150 毫秒，§19.1 要求整组单元测试不超过 20 秒）。
 */
function bundleUrl() {
  bundled ??= (async () => {
    const outDir = join(appRoot, 'test-results', 'unit-bundles');
    mkdirSync(outDir, { recursive: true });
    const outfile = join(outDir, `tests_unit_filesystem_awayEntry.${process.pid}.mjs`);
    await build({ entryPoints: [join(appRoot, 'tests', 'unit', 'filesystem', 'awayEntry.mjs')], bundle: true,
      format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile, logLevel: 'silent' });
    process.once('exit', () => rmSync(outfile, { force: true }));
    return pathToFileURL(outfile).href;
  })();
  return bundled;
}

/** @brief 一份全新的打包模块（awayEntry.mjs 的各个命名空间）。 */
export async function freshKernel() {
  const url = await bundleUrl();
  imports += 1;
  return import(`${url}?fresh=${imports}`);
}

/** @brief 等微任务与已排好的回调跑完（批准的结果交还 pi 之后）。 */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @brief 注入的时钟（synthetic，§9.3：now、setTimeout、clearTimeout）：advance 按到期的先后调用回调。
 * @param start 起始时刻（ms）
 * @param options tick：每次调用 now() 之后时钟前进的毫秒数（默认 0）；用它查出“每项各读一次 now()”
 */
export function testClock(start = 1_000_000, options = {}) {
  const tick = options.tick ?? 0;
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now() {
      const value = now;
      now += tick;
      return value;
    },
    /** 当前时刻，不前进（测试自己读时用，不算 now() 的调用） */
    peek: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(handle) { timers.delete(handle); },
    /** 还在等的计时器个数 */
    pending: () => timers.size,
    /** 推进 ms 毫秒：途中到期的回调按到期时刻依次调用 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** @brief 临时目录（测试结束时删掉），返回真实路径（路径闸按真实路径比较）。 */
export function tempDir(t, prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @brief 一份全新的内核模块并启动 away.ts。
 * @param t node:test 的测试上下文
 * @param options userData（省略时新建临时目录）、envMs（MORI_AWAY_TIMEOUT_MS 的值，只在 startAway 时设，随后恢复）、
 *   tick（时钟每次 now() 之后前进的毫秒数）、beforeStart（startAway 之前对新模块做的事，参数为 K）
 * @return K（打包的各模块）、A（away.ts）、clock、log（{ sessionId, event }，按到达顺序）、records、userData
 */
export async function awayKit(t, options = {}) {
  const K = await freshKernel();
  const userData = options.userData ?? tempDir(t, 'mori-away-');
  const clock = testClock(undefined, { tick: options.tick });
  options.beforeStart?.(K);
  const log = [];
  const records = [];
  const saved = process.env[TIMEOUT_ENV];
  if (options.envMs === undefined) delete process.env[TIMEOUT_ENV];
  else process.env[TIMEOUT_ENV] = options.envMs;
  try {
    await K.away.startAway({ userData, clock,
      emit: (envelope) => log.push({ sessionId: envelope.sessionId, event: envelope.event }),
      record: (userSessionId, decision) => records.push({ userSessionId, decision }) });
  } finally {
    if (saved === undefined) delete process.env[TIMEOUT_ENV];
    else process.env[TIMEOUT_ENV] = saved;
  }
  return { K, A: K.away, clock, log, records, userData };
}

/** @brief log 里某种事件（可再按 requestId 过滤）。 */
export function eventsOf(log, type, requestId) {
  return log.filter((item) => item.event.type === type
    && (requestId === undefined || item.event.requestId === requestId));
}

/** @brief log 里某个事件第一次出现的位置。 */
export function indexOf(log, type, requestId) {
  return log.findIndex((item) => item.event.type === type
    && (requestId === undefined || item.event.requestId === requestId));
}

/**
 * @brief 一个会话的批准扩展（synthetic 的 pi：收下 tool_call 与 agent_before_settle 处理器）。
 * @param kit awayKit 的结果
 * @param policy 共用的批准状态（ApprovalPolicy）
 * @param options sessionId（pi 会话 id）、userSessionId（卡片所在的用户会话，默认同 sessionId）、kind（默认 user）、
 *   cwd、narrowing、handedOff；instance 为真时请求经 onRequest / onEnd 交出（实例），记进 log 的
 *   instance_request / instance_end
 */
export function gateOf(kit, policy, options) {
  const sessionId = options.sessionId;
  const userSessionId = options.userSessionId ?? sessionId;
  const output = { prefix: options.instance ? `${sessionId}:` : '', cwd: options.cwd, kind: options.kind ?? 'user',
    userSessionId, send: (event) => kit.log.push({ sessionId, event }),
    narrowing: () => options.narrowing ?? null };
  if (options.instance) {
    output.onRequest = (request) => kit.log.push({ sessionId: userSessionId,
      event: { ...request, type: 'instance_request' } });
    output.onEnd = (end) => kit.log.push({ sessionId: userSessionId, event: { ...end, type: 'instance_end' } });
  }
  if (options.handedOff) output.handedOff = options.handedOff;
  return driveGate(policy.gate(output), sessionId, options.cwd);
}

/**
 * @brief 驱动一个已经建好的批准扩展（synthetic 的 pi：收下它的 tool_call 与 agent_before_settle 处理器）。
 * @param gate ApprovalGate
 * @param sessionId 这个 pi 会话的 id（ctx.sessionManager.getSessionId()）
 * @param cwd 工作路径（ctx.cwd）
 */
export function driveGate(gate, sessionId, cwd) {
  const handlers = new Map();
  gate.extension()({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = (signal) => ({ cwd, signal, sessionManager: { getSessionId: () => sessionId } });
  let n = 0;
  return {
    gate, sessionId,
    /** 扩展注册的 pi 事件名，按注册顺序 */
    events: [...handlers.keys()],
    /** 一次工具调用；返回 pi 拿到的结果的 Promise 与 toolCallId */
    call(toolName, input = {}, signal = undefined) {
      n += 1;
      const toolCallId = `${sessionId}-c${n}`;
      const result = handlers.get('tool_call')({ type: 'tool_call', toolCallId, toolName, input }, ctx(signal));
      return { result, toolCallId };
    },
    /** agent_before_settle（§9.8）；entries 是前面的处理器累计的 */
    beforeSettle(outcome = 'completed', entries = []) {
      return handlers.get('agent_before_settle')({ type: 'agent_before_settle', entries, continue: false,
        context: { messages: [] }, outcome }, ctx(undefined));
    },
  };
}

/**
 * @brief 一个用户会话的提问工具（AskQuestions，synthetic 的 pi 只收下注册的工具）。
 * @param kit awayKit 的结果
 * @param sessionId 用户会话 id
 * @param onAnswered 有答案时的回调（Team 的 onAskAnswered）；省略时没有
 */
export function asksOf(kit, sessionId, onAnswered) {
  const asks = new kit.K.ask.AskQuestions({ sessionId, send: (event) => kit.log.push({ sessionId, event }),
    ...(onAnswered ? { onAnswered } : {}) });
  const tools = new Map();
  asks.extension()({ registerTool: (def) => tools.set(def.name, def) });
  const tool = tools.get('ask_user_question');
  let n = 0;
  return {
    asks, tool, tools,
    /** 一次 ask_user_question 调用（参数已经 pi 校验）；返回结果的 Promise 与 toolCallId */
    run(questions, signal = undefined) {
      n += 1;
      const toolCallId = `${sessionId}-q${n}`;
      return { result: tool.execute(toolCallId, { questions }, signal), toolCallId };
    },
  };
}

/** @brief 一个用户会话的扩展询问（ExtensionUi），打开好了（ready 之后才出卡）。 */
export function uiOf(kit, sessionId) {
  const ui = new kit.K.extensionUi.ExtensionUi((envelope) => kit.log.push({ sessionId: envelope.sessionId,
    event: envelope.event }));
  ui.attach(sessionId);
  ui.ready();
  return { ui, context: ui.context() };
}

/** 一个单选的问题（§14 的例子） */
export const DB_QUESTION = Object.freeze({ question: 'Which database should I use?', header: 'Database',
  options: [{ label: 'PostgreSQL', description: 'Server database' }, { label: 'SQLite', description: 'Single file' }],
  multiSelect: false, recommended: 'PostgreSQL' });

/** 一个多选的问题（§14 的例子） */
export const PARTS_QUESTION = Object.freeze({ question: 'Which parts?', header: 'Scope',
  options: [{ label: 'API', description: 'The server API' }, { label: 'CLI', description: 'The command line' },
    { label: 'Docs', description: 'The documentation' }],
  multiSelect: true, recommended: 'API' });

/** @brief 工具结果的文字。 */
export function textOf(result) {
  return result.content.map((part) => part.text).join('');
}
