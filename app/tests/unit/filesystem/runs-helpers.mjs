// runs.test.mjs 的测试工具（docs/specs/file-system.md §4.4–§4.7、§19.1）：快照模块、git.ts、workspace.ts、rewind.ts、
// sessionWorkspace.ts 打进同一个文件（它们共用 git.ts 与 snapshots.ts 的全局状态，分开打包的话各有一份，快照目录、
// 找到的 git 与队列就对不上），用真实 git 在 os.tmpdir() 下的短临时目录里跑。mori-snapshots 由手写的 pi 接口驱动
// （synthetic：只有 on，emit 按注册顺序逐个 await 处理函数，同 pi 的 runner），会话用 pi 的内存 SessionManager，
// 改文件用 node:fs 做 bash 命令的效果（synthetic）。注入的 spawn 只包一层真实的 child_process.spawn：记下内部仓库的
// 并发与子命令的先后；测试可以用 replace 把某一次 git 换成替身。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleInMemory, freshUrl } from '../load.mjs';
import { REAL_GIT, realGitCandidates } from './real-git.mjs';

/** app/ 目录 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * pi 的 SessionManager：按文件路径导入 dist/core/session-manager.js（同 snap-helpers.mjs 与 FS-27 的写法）。包的入口会
 * 载入整个 pi，本机约 1.6 秒；这个文件连同它用到的约 0.6 秒。打包的内核模块在运行时不 import pi，类不会有两份
 */
const { SessionManager } = await import(pathToFileURL(join(appRoot, 'node_modules', '@earendil-works',
  'pi-coding-agent', 'dist', 'core', 'session-manager.js')).href);

/** 打包入口：几个模块合成一个文件（esbuild 的 stdin，不另写入口文件） */
const ENTRY = [
  "export * as snapshots from './src/kernel/snapshots.ts';",
  "export * as git from './src/kernel/git.ts';",
  "export * as workspace from './src/kernel/workspace.ts';",
  "export * as rewind from './src/kernel/rewind.ts';",
  "export * as sessionWorkspace from './src/kernel/sessionWorkspace.ts';",
  "export * as shared from './src/shared/workspace.ts';",
].join('\n');

/**
 * @brief 打包并导入（tests/unit/load.mjs 的 bundleInMemory：依赖包保持外部引用，打包结果在内存里、按进程命名）。
 * @return 各模块的命名空间
 */
async function loadRunsKernel() {
  const url = await bundleInMemory({ stdin: { contents: ENTRY, resolveDir: appRoot, sourcefile: 'runs-entry.mjs',
    loader: 'js' } }, 'tests_unit_filesystem_runs');
  return import(freshUrl(url));
}

/** @brief 打包好的内核模块：snapshots、git、workspace、rewind、sessionWorkspace、shared。 */
export const K = await loadRunsKernel();

/** 对话本身（没有 Team 时，sessionWorkspace.baseAgent） */
export const MORI = Object.freeze({ role: 'mori', task: null, self: true });

// ---- 注入的 spawn：内部仓库的并发与替身 ----

/**
 * @brief 注入的 spawn 记下的东西：每个内部仓库同时在跑的 git 进程数与最大值、按起来的先后记下的子命令（log：
 *        { repo, sub }）；replace(command, args, options) 返回一个进程时用它代替这次 git（synthetic 的替身），返回 null
 *        时照常起 git。
 */
export const spawns = { running: new Map(), peak: new Map(), log: [], replace: null };

/** @brief 内部仓库的调用的 --git-dir（小写）；不是内部仓库的调用为 null。 */
export function internalRepoOf(args) {
  const flag = args.find((arg) => typeof arg === 'string' && arg.startsWith('--git-dir='));
  return flag ? flag.slice('--git-dir='.length).toLowerCase() : null;
}

/** @brief 子命令：跳过以 - 开头的全局选项与 -c 的值后的第一个参数（同 git.ts 的日志写法）。 */
export function subcommandOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') i += 1;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return '';
}

/** @brief 包一层真实的 spawn（configureGit 注入）。 */
function watchedSpawn(command, args, options) {
  const child = spawns.replace?.(command, args, options) ?? nodeSpawn(command, args, options);
  const repo = internalRepoOf(args);
  if (repo !== null) {
    const now = (spawns.running.get(repo) ?? 0) + 1;
    spawns.running.set(repo, now);
    spawns.peak.set(repo, Math.max(spawns.peak.get(repo) ?? 0, now));
    spawns.log.push({ repo, sub: subcommandOf(args) });
    child.once('close', () => spawns.running.set(repo, (spawns.running.get(repo) ?? 1) - 1));
  }
  return child;
}

K.git.configureGit({ spawn: watchedSpawn, candidates: realGitCandidates });

// ---- 临时目录 ----

/**
 * @brief 测试的根目录（短：<tmp>\mr-xxxxxx，内部仓库的路径 = 快照目录 + projectDirName(cwd) 也短）：快照目录在 <根>\s。
 * @return { root, snaps, folder(name, under?), remove() }
 */
export function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mr-'));
  const snaps = join(root, 's');
  const folders = [];
  K.git.setSnapshotsDir(snaps);
  return {
    root, snaps,
    /** @brief 一个新的工作路径（默认在根下，under 给出时在它下面）。 */
    folder(name, under = root) {
      const path = join(under, name);
      mkdirSync(path, { recursive: true });
      folders.push(path);
      return path;
    },
    /**
     * @brief 删掉根目录：先等每个工作路径的快照队列（空作业，不跑 git）。结束快照之后的 git 状态读在队列外跑，到这时
     *        早已起来，它的 rev-parse 还在工作路径里时 Windows 删不掉那个目录，rmSync 的重试（最多约 5 秒）等它退出；
     *        仍删不掉时才等一次各工作路径的 git 状态读再删（平时不多起 git 进程）。
     */
    async remove() {
      await Promise.all(folders.map((cwd) => K.snapshots.inQueue(cwd, async () => undefined)));
      const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
      try {
        rmSync(root, options);
      } catch (error) {
        console.error(`[test] couldn't remove ${root} at once (${error.code}); waiting for the status reads`);
        await Promise.all(folders.map((cwd) => K.workspace.readStatus(cwd)));
        rmSync(root, options);
      }
    },
  };
}

/** @brief 写一个文件（上级目录不在就建）。 */
export function put(cwd, path, content) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

/** @brief 子进程的环境：去掉 GIT_ 开头的变量（同 git.ts 的 gitEnv，测试自己的 git 调用不受父进程影响）。 */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}

/**
 * @brief 跑一次真实的 git（测试自己检查用；异步，不挡住同时在跑的别的测试），返回 stdout 文字；失败时 reject。
 * @param cwd 进程的工作目录
 * @param args 参数
 */
export function git(cwd, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(REAL_GIT, args, { cwd, encoding: 'utf8', env: cleanEnv(), windowsHide: true }, (error, stdout) => {
      if (error) rejectRun(error);
      else resolveRun(stdout);
    });
  });
}

/** @brief 在一个文件夹里建一个有一个提交的独立仓库（嵌套仓库，synthetic 的身份）。 */
export async function nestedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '--quiet']);
  writeFileSync(join(dir, 'inner.txt'), 'inner\n');
  await commitAll(dir, 'first');
}

/** @brief 在一个仓库里提交全部改动（synthetic 的身份）。 */
export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', message]);
}

/** @brief 这个工作路径的内部仓库目录（snapshots.ts 的 snapshotRepo）。 */
export function repoOf(cwd) {
  return K.snapshots.snapshotRepo(cwd);
}

/** @brief 内部仓库里一个前缀下的 ref 名；内部仓库还不在时为空。 */
export async function refsUnder(cwd, prefix) {
  try {
    const text = await git(cwd, [`--git-dir=${repoOf(cwd)}`, 'for-each-ref', '--format=%(refname)', prefix]);
    return text.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** @brief 内部仓库里一张快照中一个文件的内容。 */
export function snapshotFile(cwd, oid, path) {
  return git(cwd, [`--git-dir=${repoOf(cwd)}`, 'show', `${oid}:${path}`]);
}

/** @brief 内部仓库里一个 ref 指向的提交；没有这个 ref 时为 null。 */
export async function refTarget(cwd, ref) {
  try {
    return (await git(cwd, [`--git-dir=${repoOf(cwd)}`, 'rev-parse', '--verify', '--quiet', ref])).trim();
  } catch {
    return null;
  }
}

/**
 * @brief 等这个工作路径的快照队列做到此刻排着的最后一个作业（在它后面排一个空作业，不跑 git），再等一轮回调。
 * @param cwd 工作路径
 */
export async function flush(cwd) {
  await K.snapshots.inQueue(cwd, async () => undefined);
  await new Promise((resolveTick) => setImmediate(resolveTick));
}

/** @brief 一个可以从外面兑现的 promise。 */
export function deferred() {
  let resolveIt = () => undefined;
  const promise = new Promise((resolveNow) => {
    resolveIt = resolveNow;
  });
  return { promise, resolve: resolveIt };
}

// ---- 会话与手写的 pi ----

/** @brief 一条用户消息（pi 的 UserMessage 形状）。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

/** @brief 一条助手回复（synthetic 的提供商与模型）。 */
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], provider: 'synthetic', model: 'synthetic',
    api: 'openai-completions', usage: {}, stopReason: 'stop', timestamp: Date.now() };
}

/**
 * @brief 一个会话（synthetic 的 pi 接口与内存 SessionManager）：用户会话在快照模块里登记，实例（options.owner）不登记，
 *        它的段写进 owner 的 SessionManager（§4.6）。
 */
export class RunSession {
  /**
   * @param cwd 工作路径
   * @param options owner：实例所属的用户会话（RunSession；实例的扩展工厂由 factory 给出）；factory(session)：换掉扩展工厂
   *        （默认是用户会话自己的 snapshotExtension，标出的 Agent 为 MORI）；register：用户会话要不要登记（默认登记）
   */
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.sm = SessionManager.inMemory(cwd);
    this.id = this.sm.getSessionId();
    this.owner = options.owner ?? null;
    this.events = [];
    this.handlers = new Map();
    const factory = options.factory?.(this) ?? K.snapshots.snapshotExtension({ userSessionId: this.id, self: true,
      headless: false, agent: () => MORI });
    factory({ on: (name, handler) => this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]) });
    if (this.owner === null && options.register !== false) this.register();
  }

  /** @brief 在快照模块里登记（§4.6）：事件记进 events。 */
  register() {
    K.snapshots.registerSnapshotUser({ sessionId: this.id, cwd: this.cwd, sessionManager: this.sm,
      emit: (event) => this.events.push(event), headless: false });
  }

  /** @brief 处理函数收到的 ctx：工作路径与这个会话自己的 SessionManager。 */
  ctx() {
    return { cwd: this.cwd, sessionManager: this.sm };
  }

  /** @brief 按注册顺序逐个 await 这个事件的处理函数（同 pi 的 runner）。 */
  async emit(name, event) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, this.ctx());
  }

  /** @brief before_agent_start（等开始快照）与 agent_start；messageType 为 user 或 custom。 */
  async begin(messageType = 'user') {
    await this.startSnapshot(messageType);
    await this.emit('agent_start', { type: 'agent_start' });
  }

  /** @brief 只发 before_agent_start（停止测试用：返回处理函数的 promise）。 */
  startSnapshot(messageType = 'user') {
    const event = messageType === 'user'
      ? { type: 'before_agent_start', messageType, prompt: '', systemPrompt: '', systemPromptOptions: {} }
      : { type: 'before_agent_start', messageType, systemPrompt: '', systemPromptOptions: {},
        message: { role: 'custom', customType: 'synthetic', content: 'go', display: false, timestamp: Date.now() } };
    return this.emit('before_agent_start', event);
  }

  /** @brief 工具执行完（toolName 为 read 时不排 git 状态的去抖读）。 */
  tool(toolName = 'read') {
    return this.emit('tool_execution_end', { type: 'tool_execution_end', toolCallId: 'call-1', toolName, result: {},
      isError: false });
  }

  /** @brief agent_settled：排结束快照，不等。 */
  end() {
    return this.emit('agent_settled', { type: 'agent_settled', aborted: false });
  }

  /** @brief 你的消息（pi 在 before_agent_start 之后写下）。 */
  say(text) {
    return this.sm.appendMessage(userMessage(text));
  }

  /** @brief 助手的回复。 */
  reply(text) {
    return this.sm.appendMessage(assistantMessage(text));
  }

  /** @brief 程序投递的 [Mori] 消息与指向它的 mori.wake（Team 在 message_end 之后写）。 */
  deliver(text) {
    const messageId = this.sm.appendMessage(userMessage(`[Mori] ${text}`));
    this.sm.appendCustomEntry('mori.wake', { messageId, kind: 'relay' });
    return messageId;
  }

  /** @brief 扩展的 custom 消息条目（sendMessage(…, { triggerTurn })）。 */
  customMessage(text) {
    return this.sm.appendCustomMessageEntry('synthetic', text, false);
  }

  /** @brief 会话文件里的 mori.turn_changes 条目。 */
  turnEntries() {
    return this.sm.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === 'mori.turn_changes');
  }

  /** @brief 会话文件里的 mori.turn_changes 记录（按种类过滤）。 */
  records(kind) {
    return this.turnEntries().map((entry) => entry.data).filter((record) => kind === undefined || record.kind === kind);
  }

  /** @brief 一次完整的运行：开始快照、你的消息、改文件、结束快照，等队列做完。 */
  async run(text, change) {
    await this.begin('user');
    const round = this.say(text);
    await change?.();
    await this.tool('read');
    this.reply(`done: ${text}`);
    await this.end();
    await flush(this.cwd);
    return round;
  }

  /** @brief 在快照模块里注销。 */
  close() {
    if (this.owner === null) K.snapshots.unregisterSnapshotUser(this.id);
  }
}
