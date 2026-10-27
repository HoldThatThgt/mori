// worktree.test.mjs 的测试工具（docs/specs/file-system.md §11、§19.1）：worktree 与 Initialize git 用真实 git
// （real-git.mjs 的 REAL_GIT，Git for Windows 真正的 git.exe），在 os.tmpdir() 下很短的临时目录里建 synthetic 的仓库。
// git.ts（找到的 git、按键排队）与 workspace.ts 各有一份模块状态，所以把它们与 shared/workspace.ts 打进同一个结果
// （esbuild 的 stdin 入口，选项同 tests/unit/load.mjs），按不同的查询串导入两份：一份用真实 git，另一份没有 git
// （候选为空，等于没装 git）。真实的那份经 configureGit 换上分派的 spawn：测试按自己的仓库登记规则（synthetic 的替身进程，
// 或改了参数再交给真的 git），没有规则的调用交给真的 spawn；每次调用的参数与工作目录都记下来。
// 准备数据、检查结果的 git 由测试自己跑（不经 Mori），带固定的身份与选项。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { build } from 'esbuild';
import { execFile, spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REAL_GIT, realGitCandidates } from './real-git.mjs';

/** app/ 目录 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 打包入口：git 的运行、工作区（worktree 与 Initialize git）与共享的路径规则放进同一个结果，共用一份状态 */
const ENTRY = [
  "export * as G from './src/kernel/git.ts';",
  "export * as W from './src/kernel/workspace.ts';",
  "export * as S from './src/shared/workspace.ts';",
].join('\n');

/** @brief 打包一次（写在 app/test-results/unit-bundles/ 下、按进程命名，进程结束时删掉），返回地址。 */
async function bundleUrl() {
  const outDir = join(appRoot, 'test-results', 'unit-bundles');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `tests_unit_filesystem_wtEntry.${process.pid}.mjs`);
  await build({
    stdin: { contents: ENTRY, resolveDir: appRoot, sourcefile: 'wt-entry.mjs', loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outfile,
    logLevel: 'silent',
  });
  process.once('exit', () => rmSync(outfile, { force: true }));
  return pathToFileURL(outfile).href;
}

/**
 * @brief 两份内核模块：real 用真实 git（候选只有 REAL_GIT，spawn 经分派），none 没有 git（候选为空）。
 *        real 的每次 git 调用（--version 除外）记进 calls；onGit(rule) 登记一条规则：rule(command, args, options)
 *        返回替身进程时用它，返回 null 时看下一条，都没有时交给真的 spawn。返回值是取消登记的函数。
 */
export async function loadKits() {
  const url = await bundleUrl();
  const [real, none] = await Promise.all([import(`${url}?kit=real`), import(`${url}?kit=none`)]);
  const calls = [];
  const rules = new Set();
  const spawn = (command, args, options) => {
    if (!(args.length === 1 && args[0] === '--version')) calls.push({ args: [...args], cwd: String(options.cwd) });
    for (const rule of rules) {
      const child = rule(command, args, options);
      if (child) return child;
    }
    return realSpawn(command, args, options);
  };
  real.G.configureGit({ candidates: realGitCandidates, spawn });
  none.G.configureGit({ candidates: () => [], exists: () => false });
  const onGit = (rule) => {
    rules.add(rule);
    return () => rules.delete(rule);
  };
  return { real, none, calls, onGit };
}

/**
 * @brief pi 的 SessionManager。按文件路径导入 dist/core/session-manager.js（同 snap-helpers.mjs）：包的入口会载入整个 pi，
 *        这个文件连同它用到的不到一秒，类是同一个。
 */
export async function loadSessionManager() {
  const file = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core',
    'session-manager.js');
  return (await import(pathToFileURL(file).href)).SessionManager;
}

/** @brief 只算一次的异步准备（几个测试共用同一份 synthetic 的仓库与结果）。 */
export function once(fn) {
  let promise = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

// ---- 路径与临时目录 ----

/** @brief 路径比较用的写法：分隔符统一为 \，去掉末尾的分隔符，小写（git 输出的是 / 分隔）。 */
export function pathKey(path) {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** @brief inner 是 outer 本身或在它里面（按 pathKey）。 */
export function within(outer, inner) {
  const base = pathKey(outer);
  const key = pathKey(inner);
  return key === base || key.startsWith(`${base}\\`);
}

/**
 * @brief 测试文件的根目录（os.tmpdir() 下，名字很短：worktree 路径再接 .mori\worktrees\<名字>，长路径的用例另算）。
 * @param prefix 目录名前缀
 */
export function tempRoot(prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  return { root, remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/**
 * @brief 写文件（synthetic 的内容），需要时建上级目录。
 * @param base 目录
 * @param files { 相对路径（/ 分隔）: 内容 }
 */
export function put(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** @brief 文件的文字；不在时为 null。 */
export function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * @brief 设几个环境变量（值为 undefined 时删掉），返回恢复函数。Windows 的 process.env 不分大小写，按给的名字存取。
 * @param vars { 名字: 值 }
 */
export function setEnv(vars) {
  const saved = Object.keys(vars).map((name) => [name, Object.hasOwn(process.env, name), process.env[name]]);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, had, value] of saved.reverse()) {
      if (had) process.env[name] = value;
      else delete process.env[name];
    }
  };
}

/**
 * @brief 测试用的主目录：HOME、USERPROFILE 指到 dir（Mori 对你的仓库的 git 调用继承它，读到这里的全局配置），
 *        不读你自己的全局配置。git init 的模板目录指到一个空目录：不复制 hooks 下的示例脚本（本机上杀毒软件
 *        扫这些脚本，一次 git init 要一两秒）；不起后台的自动维护（Initialize git 的 commit 之后脱离出去的进程
 *        会在清理临时目录时还开着文件）。两样都与被测的行为无关。
 * @param dir 主目录（不存在时建）
 * @param identity 写不写 user.name、user.email（另有默认分支 main、空的模板目录、core.autocrlf=false）
 * @return 恢复环境变量的函数
 */
export function useHome(dir, identity) {
  const templates = join(dir, 'templates');
  mkdirSync(templates, { recursive: true });
  const user = identity ? '[user]\n\tname = Mori Test\n\temail = test@localhost\n' : '';
  const init = `[init]\n\tdefaultBranch = main\n\ttemplateDir = ${templates.replace(/\\/g, '/')}\n`;
  const quiet = '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n';
  writeFileSync(join(dir, '.gitconfig'), `${user}${init}${quiet}[core]\n\tautocrlf = false\n`);
  return setEnv({ HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: undefined });
}

// ---- 测试自己的 git（准备与检查；不经 Mori） ----

/**
 * 准备与检查用的固定 -c：不转换换行、允许长路径、固定的身份、不签名、默认分支 main；不起后台的自动维护（commit 之后
 * 脱离出去的 git maintenance 会在 cpSync 复制基础仓库时还在动 .git）
 */
const SETUP_ARGS = [
  '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'user.name=Mori Test',
  '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
];

/** @brief 去掉 GIT_* 的环境副本（同 git.ts 的做法），加 LC_ALL=C（git 的原文与 Mori 读到的一样）。 */
function cleanEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('GIT_') && upper !== 'LC_ALL') env[name] = value;
  }
  env.LC_ALL = 'C';
  return env;
}

/**
 * @brief 跑一次 git（准备与检查，不经 shell）；异步，不挡住同时在跑的别的用例。
 * @param cwd 工作目录
 * @param args 参数
 * @param allowFail 失败时返回结果而不抛错
 * @param plain 不带固定的 -c（检查仓库自己的配置是否够用，例如 config.worktree 里的 core.longpaths）
 * @return { code, stdout, stderr }（文字）
 */
export function git(cwd, args, allowFail = false, plain = false) {
  return new Promise((done, fail) => {
    const all = plain ? args : [...SETUP_ARGS, ...args];
    execFile(REAL_GIT, all, { cwd, env: cleanEnv(), encoding: 'utf8', windowsHide: true,
      maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const result = { code: error ? (error.code ?? 1) : 0, stdout, stderr };
      if (error && !allowFail) fail(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`));
      else done(result);
    });
  });
}

/** @brief git 的文字输出（去掉末尾的空白）。 */
export async function gitText(cwd, args) {
  return (await git(cwd, args)).stdout.trimEnd();
}

/**
 * @brief 新的仓库（git init --template= -b main：.git 里没有 info 目录、很小），写文件并提交一次。
 * @param dir 目录（不存在时建）
 * @param files 第一次提交的文件（put 的格式）
 */
export async function makeRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  put(dir, files);
  await git(dir, ['init', '--quiet', '--template=']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

/** @brief 目录下全部文件的 { 相对路径（/ 分隔）: 内容 }；目录不在时为空。 */
function filesUnder(dir, prefix = '') {
  if (!existsSync(dir)) return {};
  const found = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, filesUnder(join(dir, entry.name), rel));
    else found[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return found;
}

/**
 * @brief 仓库此刻的样子（FS-97、FS-111 的“什么都没改”），直接读 .git 里的文件（不起 git）：worktree 的登记目录
 *        （.git/worktrees 下的全部文件）、分支（refs/heads 下的散文件与 packed-refs）、共用配置与 info/exclude。
 * @param root 仓库根
 */
export function repoState(root) {
  const dotGit = join(root, '.git');
  return {
    worktrees: filesUnder(join(dotGit, 'worktrees')), branches: filesUnder(join(dotGit, 'refs', 'heads')),
    packed: readText(join(dotGit, 'packed-refs')), config: readText(join(dotGit, 'config')),
    exclude: readText(join(dotGit, 'info', 'exclude')),
  };
}

/** @brief git worktree list --porcelain 里登记的路径（pathKey 的写法）。 */
export async function registered(root) {
  const text = await gitText(root, ['worktree', 'list', '--porcelain']);
  return text.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => pathKey(line.slice(9)));
}

/**
 * @brief refs/heads/<branch> 指向的提交，直接读 .git 里的散文件或 packed-refs（不起 git；临时仓库里没有 gc）。
 * @return 提交；没有这个分支时为 null
 */
export function branchTip(root, branch) {
  const loose = readText(join(root, '.git', 'refs', 'heads', ...branch.split('/')));
  if (loose !== null) return loose.trim();
  const packed = (readText(join(root, '.git', 'packed-refs')) ?? '').split('\n')
    .find((line) => line.endsWith(` refs/heads/${branch}`));
  return packed === undefined ? null : packed.split(' ')[0];
}

/** @brief 直接写一个分支的散文件（不起 git）：refs/heads/<branch> 指向 oid。 */
export function makeBranch(root, branch, oid) {
  const file = join(root, '.git', 'refs', 'heads', ...branch.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${oid}\n`);
}

/**
 * @brief worktree 检出的分支，直接读它的 .git 文件指向的登记目录里的 HEAD（不起 git）。
 * @param path worktree 根
 * @return 分支名（mori/<名字>）；HEAD 不指向分支时为 HEAD 的原文
 */
export function checkedOut(path) {
  const admin = readText(join(path, '.git')).replace(/^gitdir: /, '').trim();
  const head = readText(join(admin, 'HEAD')).trim();
  return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head;
}

/**
 * @brief 测试自己的 git 建一个 worktree（不经 Mori，用来准备列表、清理、恢复的场景）：worktree add -b <branch> <path>。
 * @param root 仓库根
 * @param path worktree 的位置
 * @param branch 新分支
 */
export function addWorktree(root, path, branch) {
  return git(root, ['worktree', 'add', '--quiet', '-b', branch, path]);
}

// ---- 替身进程（synthetic） ----

/**
 * @brief 一个替身 git 进程（synthetic）：没有 pid（git.ts 结束它时只 child.kill()），下一轮 I/O 时发 stdout、stderr，
 *        再以 code 结束；hang 为真时一直不结束，直到 kill()（之后以 null 结束，同被结束的进程）。
 * @param script { stdout?: Buffer|string, stderr?: string, code?: number, hang?: boolean }
 */
export function standIn(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => undefined, end: () => undefined };
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  let closed = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    child.emit('close', code);
  };
  child.kill = () => {
    setImmediate(() => close(null));
    return true;
  };
  setImmediate(() => {
    if (script.stdout && script.stdout.length > 0) child.stdout.emit('data', Buffer.from(script.stdout));
    if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
    if (!script.hang) setImmediate(() => close(script.code ?? 0));
  });
  return child;
}

/**
 * @brief 交给真的 git 跑（同一份参数、目录与环境），在 Mori 看来它却一直没退出、到超时被结束（synthetic 的替身转发
 *        输出）：真的进程结束时不发 close，等 kill() 才以 null 结束；kill() 来得比真的进程结束早时等它结束再发，所以
 *        Mori 的清理总在 git 做完之后开始（不同步等，不挡住同时在跑的别的用例）。after(code) 在真的进程结束时调用
 *        （例如写下 locked）。
 * @param command git 的路径
 * @param args 参数
 * @param options spawn 的选项
 * @param after 真的 git 结束时调用；可省略
 */
export function finishThenHang(command, args, options, after = () => undefined) {
  const child = standIn({ hang: true });
  const real = realSpawn(command, args, options);
  real.stdout?.on('data', (chunk) => child.stdout.emit('data', chunk));
  real.stderr?.on('data', (chunk) => child.stderr.emit('data', chunk));
  let finished = false;
  let stop = null;
  const end = (code) => {
    if (finished) return;
    finished = true;
    after(code);
    stop?.();
  };
  real.once('close', end);
  real.once('error', () => end(null));
  const kill = child.kill;
  child.kill = () => {
    stop = kill;
    if (finished) kill();
    return true;
  };
  return child;
}

/** @brief 这次调用是不是 git worktree add（跳过 -c 与它的值）。 */
export function isWorktreeAdd(args) {
  const rest = args.filter((arg, i) => arg !== '-c' && args[i - 1] !== '-c');
  return rest[0] === 'worktree' && rest[1] === 'add';
}

/** @brief 记下的调用里工作目录在 dir 里面的，参数按先后。 */
export function callsIn(calls, dir) {
  return calls.filter((call) => within(dir, call.cwd)).map((call) => call.args);
}

// ---- 名字的后缀与会话文件 ----

/** @brief 总给同一个后缀的 rand（注入 worktreeName / createWorktree）。 */
export function fixed(suffix) {
  return () => suffix;
}

/** @brief 依次给出这些后缀的 rand，用完之后一直给最后一个；used() 是已经给了几次。 */
export function sequence(...suffixes) {
  let at = 0;
  const rand = () => suffixes[Math.min(at++, suffixes.length - 1)];
  rand.used = () => at;
  return rand;
}

/** 会话文件里条目的时间（synthetic） */
const STAMP = '2026-10-27T00:00:00.000Z';

/**
 * @brief 一个 synthetic 的会话文件（pi 的 JSONL 写法：每行一个条目，type 是第一个键）：会话头，然后 lines 里的条目。
 * @param file 会话文件
 * @param cwd 会话头里的 cwd
 * @param lines 条目（对象，按 pi 的字段；字符串原样写一行，例如坏行）
 */
export function writeSession(file, cwd, lines) {
  const header = { type: 'session', version: 3, id: 'synthetic-session', timestamp: STAMP, cwd };
  const text = [header, ...lines].map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text}\n`);
  return file;
}

/** @brief mori.worktree 条目（synthetic，pi 的自定义条目的字段顺序）。 */
export function worktreeLine(id, data) {
  return { type: 'custom', customType: 'mori.worktree', data, id, parentId: null, timestamp: STAMP };
}

/** @brief 一条你的消息的条目（synthetic）。 */
export function messageLine(id, text) {
  return {
    type: 'message', id, parentId: null, timestamp: STAMP,
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
  };
}

/**
 * @brief 截下 console.error 与 console.log（被测代码的日志），直到调 restore()。整个文件只装一次：并行的用例
 *        各自装卸会互相换掉。
 */
export function captureLogs() {
  const errors = [];
  const logs = [];
  const error = console.error;
  const log = console.log;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  return { errors, logs, restore: () => { console.error = error; console.log = log; } };
}
