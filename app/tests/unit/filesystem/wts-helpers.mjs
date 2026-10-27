// worktree 会话接线的单元测试（worktree-session.test.mjs）共用的工具（docs/specs/file-system.md §11.5、§11.6、§11.9、
// §11.11、§19.1，file-system-permissions.md §8.6）：
// - 把 worktreeSession.ts、sessionWorkspace.ts、workspace.ts、git.ts 与 shared/workspace.ts 打成一个包（同一份模块状态：
//   creatingWorktree 集合、正在恢复的 worktree、git 的查找与排队、git 状态的读）；kernel/pi.ts 换成替身（synthetic）：
//   loadPi 交出这里的对象，它的 SessionManager.create 记下调用后交给 pi 1.3.0 真正的 SessionManager（只载入它所在的
//   模块文件，同 git-helpers.mjs；整个 pi 不载入）；
// - 真实的 git（real-git.mjs 的 REAL_GIT）：准备一个有提交的仓库（synthetic 的项目），每个场景用 fs.cpSync 复制一份，
//   不再起 git 重建；全局配置指到测试目录（git-helpers.mjs 的 testHome），pi 的 agentDir 也在测试目录里；
// - sessions.ts 的会话（Entry）与会话表操作（closeEntry、startUser、promptEntry、describe）是替身（synthetic），
//   调用按顺序记进这个场景的日志；git 状态的宿主（configureWorkspace）收下每次读到的状态，并叫醒在等它的测试
//   （事件驱动，不轮询：git 进程跑着时不占一个核）。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { build } from 'esbuild';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FAKE_GIT, captureLogs, fakeSpawn, isFile, setEnv, tempRoot, testHome, writeFiles,
} from './git-helpers.mjs';
import { REAL_GIT, realGitCandidates } from './real-git.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kernelDir = join(appRoot, 'src', 'kernel');
const outDir = join(appRoot, 'test-results', 'unit-bundles');

/** pi 1.3.0 的 SessionManager 所在的模块文件（版本锁定，同 git-helpers.mjs） */
const SESSION_MANAGER = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core',
  'session-manager.js');

/** 打进一个包的模块（同一份模块状态） */
const MODULES = {
  wts: 'src/kernel/worktreeSession.ts',
  sw: 'src/kernel/sessionWorkspace.ts',
  ws: 'src/kernel/workspace.ts',
  git: 'src/kernel/git.ts',
  shared: 'src/shared/workspace.ts',
};

/** kernel/pi.ts 的替身源码（synthetic）：loadPi 交出测试放在 globalThis.__moriWtsPi 的对象。 */
const PI_STUB = `// synthetic：kernel/pi.ts 的替身（worktreeSession.ts 只用 loadPi）
export function loadPi() {
  const pi = globalThis.__moriWtsPi;
  return pi ? Promise.resolve(pi) : Promise.reject(new Error('synthetic: this test has no pi'));
}
`;

/** 等一次 git 状态最多等多久（毫秒）：超过时测试以 no git status for <cwd> 失败 */
const STATUS_WAIT_MS = 15_000;

/** 低于 2.32 的 git（§3.2 第 2 步的 old）：替身 git --version 的输出（synthetic） */
const OLD_VERSION = 'git version 2.31.1.windows.1\n';

/** 测试提交用的身份与选项（只用于 synthetic 的仓库） */
const IDENTITY = ['-c', 'user.name=Mori Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false'];

/** 没有宿主时的快照状态（git 状态里带的那一项；这里不拍快照） */
export const SNAP_OFF = Object.freeze({
  state: 'off', reason: null, error: null, skipped: [], skippedTotal: 0, nested: [], nestedTotal: 0,
});

/** @brief esbuild 插件：内核里的 `./pi` 换成替身。 */
function piStubPlugin() {
  const kernel = kernelDir.toLowerCase();
  return {
    name: 'mori-synthetic-pi',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/pi$/ }, (args) => (resolve(args.resolveDir).toLowerCase() === kernel
        ? { path: 'pi', namespace: 'mori-synthetic' } : undefined));
      builder.onLoad({ filter: /.*/, namespace: 'mori-synthetic' }, () => ({
        contents: PI_STUB, loader: 'js', resolveDir: kernelDir,
      }));
    },
  };
}

/** @brief 打包并导入 MODULES（一个包，共用模块状态；kernel/pi.ts 换成替身）。 */
async function loadBundle() {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `wts-bundle.${process.pid}.mjs`);
  const contents = Object.entries(MODULES)
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(`./${path}`)};`).join('\n');
  await build({
    stdin: { contents, resolveDir: appRoot, sourcefile: 'wts-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile,
    logLevel: 'silent', plugins: [piStubPlugin()],
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** @brief 帮助函数自己跑 git 时的环境：process.env 去掉 GIT_*（HOME 已由 testHome 指到测试目录）。 */
function plainEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  return env;
}

/**
 * @brief 准备数据或核对结果时跑一次真实 git（不经被测代码）。
 * @param cwd 目录
 * @param args 参数（前面自动加上测试身份）
 * @return stdout（去掉末尾换行）；失败时抛错
 */
export function realGit(cwd, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(REAL_GIT, [...IDENTITY, ...args], { cwd, env: plainEnv(), encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) rejectRun(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || error.message}`));
        else resolveRun(stdout.replace(/\r?\n$/, ''));
      });
  });
}

/** @brief 仓库里登记的 worktree 根（git worktree list --porcelain 的 worktree 行，反斜杠、小写）。 */
export async function registered(repo) {
  const out = await realGit(repo, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim().replace(/\//g, '\\').toLowerCase());
}

/** @brief 仓库里 mori/ 开头的分支。 */
export async function moriBranches(repo) {
  const out = await realGit(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/mori/']);
  return out.split('\n').filter(Boolean);
}

/**
 * @brief 整个测试文件的环境：临时目录、隔离的全局 git 配置与 pi 的 agentDir、真实 git、git 状态的宿主、截下日志、
 *        一个有提交的基础仓库（README.md、src/a.ts、src/b.ts、app/main.ts）。
 * @return { K, SessionManager, root, agentDir, copyRepo, statuses, statusesOf, waitStatus, logs, useMissingGit,
 *           useOldGit, useRealGit, scenarios, cleanup }
 */
export async function startKit() {
  const tmp = tempRoot('mwts-');
  const agentDir = join(tmp.root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const restoreEnv = setEnv({ MORI_GIT_PATH: undefined, PI_CODING_AGENT_DIR: agentDir });
  const restoreHome = testHome(tmp.root);
  const base = join(tmp.root, 'base');
  // 打包、载入 SessionManager 与建基础仓库同时做
  const [K, { SessionManager }] = await Promise.all([loadBundle(), import(pathToFileURL(SESSION_MANAGER).href),
    baseRepo(base)]);
  const logs = captureLogs();
  const kit = { K, SessionManager, root: tmp.root, agentDir, logs, scenarios: new Map(), statuses: [], waiters: [] };
  globalThis.__moriWtsPi = { SessionManager: recordingManager(kit) };
  K.ws.configureWorkspace({
    usersAt: (cwd) => [{ sessionId: `status:${cwd}`, emit: (event) => receiveStatus(kit, event.status) }],
    snapshotState: () => SNAP_OFF,
  });
  useGits(kit);
  kit.copyRepo = (name) => {
    const dir = join(tmp.root, name);
    cpSync(base, dir, { recursive: true });
    return dir;
  };
  kit.statusesOf = (cwd) => kit.statuses.filter((status) => status.cwd === cwd);
  kit.waitStatus = (cwd, count = 1) => waitStatus(kit, cwd, count);
  kit.cleanup = () => {
    delete globalThis.__moriWtsPi;
    logs.restore();
    restoreHome();
    restoreEnv();
    tmp.remove();
  };
  return kit;
}

/**
 * @brief 换 git 的依赖：useRealGit（真的 spawn 与 REAL_GIT，默认）、useMissingGit（没有候选）、useOldGit（替身 git，
 *        --version 报 2.31，其余调用以退出码 1 结束；返回 fakeSpawn 的结果，calls 是全部调用）。
 */
function useGits(kit) {
  const { configureGit } = kit.K.git;
  kit.useRealGit = () => configureGit({ spawn: nodeSpawn, candidates: realGitCandidates, exists: isFile });
  kit.useMissingGit = () => configureGit({ candidates: () => [], exists: () => false });
  kit.useOldGit = () => {
    const fake = fakeSpawn((call) => (call.args[0] === '--version' ? { stdout: OLD_VERSION }
      : { code: 1, stderr: 'fatal: unexpected call to the synthetic git\n' }));
    configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => true });
    return fake;
  };
  kit.useRealGit();
}

/** @brief git 状态的宿主收下一次状态：记下，再叫醒条件已满足的等待。 */
function receiveStatus(kit, status) {
  kit.statuses.push(status);
  kit.waiters = kit.waiters.filter((waiter) => !waiter.check());
}

/**
 * @brief 等这个工作路径收到 count 次 git 状态（由 receiveStatus 叫醒，不轮询）；STATUS_WAIT_MS 内没收到时失败。
 * @return 这个工作路径收到的全部状态
 */
function waitStatus(kit, cwd, count) {
  return new Promise((resolveWait, rejectWait) => {
    const waiter = {
      check() {
        const got = kit.statusesOf(cwd);
        if (got.length < count) return false;
        clearTimeout(timer);
        resolveWait(got);
        return true;
      },
    };
    const timer = setTimeout(() => {
      kit.waiters = kit.waiters.filter((item) => item !== waiter);
      rejectWait(new Error(`no git status for ${cwd} within ${STATUS_WAIT_MS} ms (wanted ${count})`));
    }, STATUS_WAIT_MS);
    if (!waiter.check()) kit.waiters.push(waiter);
  });
}

/** @brief 基础仓库（synthetic 的项目）：README.md、src/a.ts、src/b.ts、app/main.ts，提交一次。 */
async function baseRepo(base) {
  writeFiles(base, { 'README.md': 'base\n', 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n',
    'app/main.ts': 'export const main = 3;\n' });
  await realGit(base, ['init', '--quiet', '-b', 'main']);
  await realGit(base, ['add', '-A']);
  await realGit(base, ['commit', '--quiet', '-m', 'base']);
}

/**
 * @brief pi.SessionManager 的替身：create 记进按会话 id 登记的场景（kit.scenarios），再交给真正的 SessionManager.create
 *        （agentDir 在测试目录里，会话目录按 pi 的规则建）。
 */
function recordingManager(kit) {
  return {
    create(cwd, sessionDir, options) {
      const manager = kit.SessionManager.create(cwd, sessionDir, options);
      const sc = kit.scenarios.get(options?.id);
      if (sc) {
        sc.log.push(`create:${cwd}`);
        sc.creates.push({ cwd, sessionDir, options, manager, argCount: arguments.length });
      }
      return manager;
    },
  };
}

// ---- 会话替身（synthetic） ----

/** @brief pi 会话的替身：WorktreeSessionEntry 与 BusyEntry 用到的几项，设置的调用记进日志。 */
function sessionOf(id, manager, settings, log, label) {
  return {
    sessionId: id,
    sessionManager: manager,
    sessionFile: manager.getSessionFile(),
    thinkingLevel: settings.thinking ?? 'medium',
    sessionName: settings.name,
    isStreaming: settings.streaming ?? false,
    setThinkingLevel(level) {
      log.push(`${label}.setThinkingLevel:${level}`);
      this.thinkingLevel = level;
    },
    setSessionName(name) {
      log.push(`${label}.setSessionName:${name}`);
      this.sessionName = name;
    },
  };
}

/** @brief 模型层会话接线的替身：拒绝启动、选择范围、发模型状态。failPick 为真时 setPick 抛错。 */
function modelOf(settings, log, label, failPick) {
  let pick = settings.pick ?? null;
  return {
    isBlocked: () => settings.blocked ?? false,
    state: () => ({ pick }),
    async setPick(next) {
      log.push(`${label}.setPick:${next}`);
      if (failPick) throw new Error('synthetic: the model layer refused the pick');
      pick = next;
      return { pick };
    },
    emitState() {
      log.push(`${label}.emitState`);
    },
    recordPick() {
      log.push(`${label}.recordPick`);
    },
  };
}

/** @brief Team 的替身：模式、忙、setMode（记进日志）。teamMode 为 null 时没有 Team。 */
function teamOf(settings, log, label) {
  if (settings.teamMode === null) return null;
  return {
    mode: settings.teamMode ?? 'off',
    busy: () => settings.teamBusy ?? false,
    openRequests: () => [],
    async setMode(next) {
      log.push(`${label}.setMode:${next}`);
      this.mode = next === 'on' ? 'always' : next;
      return { mode: this.mode };
    },
  };
}

/** @brief 一个会话替身（sessions.ts 的 Entry 里这些测试用到的部分）。 */
function entryOf(sc, fields) {
  const { id, label, cwd, manager, settings, failPick } = fields;
  return {
    label, kind: 'user', owner: null, headless: false,
    session: sessionOf(id, manager, settings, sc.log, label),
    cwd,
    model: modelOf(settings, sc.log, label, failPick),
    team: teamOf(settings, sc.log, label),
    running: settings.running ?? false,
    preparing: settings.preparing ?? null,
    trust: fields.trust,
    approval: fields.approval,
    worktree: fields.worktree,
    emit: fields.emit,
  };
}

/**
 * @brief 一个场景（synthetic）：旧会话与 sessions.ts 传给 startInWorktree 的会话表操作。
 * @param kit startKit 的结果
 * @param options id（pi 会话 id，场景之间不同）、cwd、old（旧会话的设置：thinking、name、pick、teamMode、blocked、
 *        running、preparing、streaming、teamBusy、worktree）、defaults（startUser 建出的会话的默认设置）、
 *        startFails(args, n)（第 n 次 startUser 要抛的 Error，或 null）、failPick(args, n)（这次建出的会话 setPick 抛错）、
 *        held（promptEntry 结果里的 held）、promptResult（promptEntry 原样返回的结果，可以是还没结束的 Promise）、
 *        promptFails（promptEntry 同步抛的 Error）、messages（旧会话里先写的消息，pi 的 AgentMessage）
 * @return { entry, deps, log, events, starts, closed, prompts, built, creates, trust, approval, creatingSeen,
 *           creating() }
 */
export function scenario(kit, options) {
  const { id, cwd } = options;
  const sc = { log: [], events: [], starts: [], closed: [], prompts: [], built: [], creates: [], creatingSeen: [] };
  sc.trust = { synthetic: 'trust decision' };
  sc.approval = { synthetic: 'approval policy' };
  const manager = kit.SessionManager.inMemory(cwd, { id });
  manager.appendCustomEntry('mori.pick', { pick: options.old?.pick ?? null });
  for (const message of options.messages ?? []) manager.appendMessage(message);
  const emit = (envelope) => sc.events.push(envelope);
  sc.entry = entryOf(sc, { id, label: 'old', cwd, manager, settings: options.old ?? {}, trust: sc.trust,
    approval: sc.approval, worktree: options.old?.worktree ?? null, emit });
  sc.creating = () => creatingNow(kit, id);
  sc.deps = depsOf(kit, sc, options);
  kit.scenarios.set(id, sc);
  return sc;
}

/** @brief 此刻这个会话 id 在不在 creatingWorktree 集合里（refuseWhileCreating 抛 WORKTREE_CREATING）。 */
export function creatingNow(kit, id) {
  try {
    kit.K.wts.refuseWhileCreating(id);
    return false;
  } catch (error) {
    if (error.message !== kit.K.wts.WORKTREE_CREATING) throw error;
    return true;
  }
}

/** @brief 场景的会话表操作（WorktreeStartDeps 的替身）。 */
function depsOf(kit, sc, options) {
  return {
    async closeEntry(entry) {
      sc.log.push(`close:${entry.label}`);
      sc.creatingSeen.push(['close', sc.creating()]);
      sc.closed.push(entry);
    },
    async startUser(args) {
      const n = sc.starts.length + 1;
      sc.starts.push(args);
      sc.log.push(`start${n}:${args.cwd}`);
      const error = options.startFails?.(args, n) ?? null;
      if (error) throw error;
      const next = entryOf(sc, { id: args.sessionManager.getSessionId(), label: `start${n}`, cwd: args.cwd,
        manager: args.sessionManager, settings: options.defaults ?? {}, failPick: options.failPick?.(args, n),
        trust: args.decision, approval: args.approval, worktree: kit.K.wts.ownedWorktree(args.sessionManager),
        emit: args.emit });
      sc.built.push(next);
      return next;
    },
    promptEntry(entry, text, promptOptions) {
      sc.log.push(`prompt:${entry.label}`);
      sc.prompts.push({ entry, text, options: promptOptions, creating: sc.creating() });
      if (options.promptFails) throw options.promptFails;
      return options.promptResult ?? { accepted: true, held: options.held ?? false };
    },
    describe: describeOf,
  };
}

/** @brief describe 的替身（synthetic 的 SessionInfo：认得出是哪一个会话）。 */
export function describeOf(entry) {
  return { synthetic: 'session info', label: entry.label, sessionId: entry.session.sessionId, cwd: entry.cwd,
    worktree: entry.worktree };
}

/** @brief 场景的会话 id 从登记里去掉（场景结束时）。 */
export function forget(kit, sc) {
  kit.scenarios.delete(sc.entry.session.sessionId);
}

/**
 * @brief 一个 WorkspaceEntry 的替身（initGitEntry 用）：settings 同 scenario 的 old。
 * @param id 会话 id
 * @param cwd 工作路径
 * @param settings running、preparing、streaming、teamMode、teamBusy；kind 省略为 user
 */
export function workspaceEntry(id, cwd, settings = {}) {
  const log = [];
  return {
    kind: settings.kind ?? 'user', headless: false, cwd, running: settings.running ?? false,
    preparing: settings.preparing ?? null,
    session: { sessionId: id, isStreaming: settings.streaming ?? false },
    team: teamOf({ teamMode: settings.teamMode ?? null, teamBusy: settings.teamBusy }, log, id),
    model: { recordPick() {} },
    emit: () => undefined,
  };
}
