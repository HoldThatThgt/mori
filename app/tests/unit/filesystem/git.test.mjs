// 找 git 与运行 git（docs/specs/file-system.md §3.2、§3.3、§17；验收 §19.2 FS-01、FS-02）：kernel/git.ts。
// 大部分用例注入替身（synthetic）：configureGit 的 candidates、exists 与 spawn（§3.2 第 1 步、§19.1）；
// 另有几条用真实的 Git for Windows：找到本机的 git、隔离的配置真的只读 <快照目录>\gitconfig、
// 停止与超时结束整棵进程树（cmd\git.exe 是启动器，真正干活的 git 是它的子进程，§3.3；add -A 由一个睡着的
// clean 过滤器拖住，过滤器是 git 的孙进程）。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { quietly } from './gate-helpers.mjs';
import {
  FAKE_GIT, FAKE_VERSION, FIVE_C, ISOLATED_CONFIG, PROGRAM_FILES_GIT, captureLogs, fakeSpawn, isFile, pause,
  realGitPath, setEnv, tempRoot, testHome, until, writeFiles,
} from './git-helpers.mjs';

const G = await loadKernelModule('src/kernel/git.ts');

const tmp = tempRoot('mfg-');
// 这些用例假定没有 MORI_GIT_PATH（只有专门的用例设它）；测试用的全局配置不读你自己的
const restoreEnv = setEnv({ MORI_GIT_PATH: undefined });
const restoreHome = testHome(tmp.root);
after(() => {
  restoreHome();
  restoreEnv();
  tmp.remove();
});

const EMPTY = Buffer.alloc(0);
let folders = 0;

/** @brief tmp 下一个新的目录（synthetic）。 */
function freshDir(name = 'd') {
  folders += 1;
  const dir = join(tmp.root, `${name}${folders}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @brief 先回答 --version（2.55），其余交给 respond。 */
function withVersion(respond = () => undefined) {
  return (call) => (call.args[0] === '--version' ? { stdout: FAKE_VERSION } : respond(call));
}

/**
 * @brief 让 G 用替身：候选只有 candidates（都存在），spawn 是 fakeSpawn(respond)。
 * @return fakeSpawn 的结果
 */
function useStandIn(respond, candidates = [FAKE_GIT]) {
  const fake = fakeSpawn(respond);
  G.configureGit({ spawn: fake.spawn, candidates: () => candidates, exists: () => true });
  return fake;
}

/**
 * @brief 让 G 用本机真实的 git（默认 Program Files 的启动器或 PATH 里的），spawn 是真的 node 的 spawn。
 * @return 收下每个真实子进程的数组
 */
function useRealGit(path = realGitPath()) {
  const spawned = [];
  const spawn = (...args) => {
    const child = nodeSpawn(...args);
    spawned.push(child);
    return child;
  };
  G.configureGit({ spawn, candidates: () => [path], exists: isFile });
  return spawned;
}

/** @brief 一次用户仓库方式的调用（10 秒，16 MB）。 */
function userRun(cwd, args, extra = {}) {
  return G.runGit({ args, cwd, key: cwd, timeoutMs: G.GIT_TIMEOUTS.quick, maxOutput: G.GIT_OUTPUT.other, ...extra });
}

/** @brief 名字以 GIT_ 开头的变量（不分大小写），排序。 */
function gitKeys(env) {
  return Object.keys(env).filter((name) => name.toUpperCase().startsWith('GIT_')).sort();
}

// ---- FS-01 找 git ----

test('FS-01 before any search gitState() is missing; the default candidates are PATH folders, then Program Files',
  async () => {
    const F = await loadKernelModule('src/kernel/git.ts');
    assert.deepEqual(F.gitState(), { state: 'missing' });
    const checked = [];
    const fake = fakeSpawn(withVersion());
    const restore = setEnv({ PATH: 'C:\\mori-p1;relative\\dir;"C:\\mori p2";;C:\\mori-p3' });
    try {
      F.configureGit({ spawn: fake.spawn, exists: (path) => checked.push(path) && path === PROGRAM_FILES_GIT });
      const { value } = await quietly(() => F.findGit());
      assert.deepEqual(value, { state: 'ok', version: '2.55.0' });
      // 相对的目录不算，引号去掉，空段跳过；PATH 里的都在 Program Files 之前。找到的是启动器 cmd\git.exe 时
      // 再看它旁边真正的 git（内部仓库的调用用，§3.3），按架构依次看
      const real = ['mingw64', 'clangarm64', 'mingw32'].map((dir) => `C:\\Program Files\\Git\\${dir}\\bin\\git.exe`);
      assert.deepEqual(checked,
        ['C:\\mori-p1\\git.exe', 'C:\\mori p2\\git.exe', 'C:\\mori-p3\\git.exe', PROGRAM_FILES_GIT, ...real]);
      assert.equal(fake.calls[0].path, PROGRAM_FILES_GIT);
      F.configureGit({ exists: (path) => path === 'C:\\mori p2\\git.exe' || path === PROGRAM_FILES_GIT });
      await quietly(() => F.findGit());
      assert.equal(fake.calls[1].path, 'C:\\mori p2\\git.exe');
    } finally {
      restore();
    }
  });

test('FS-01 the first existing candidate is used: --version runs on it in its folder and ok is logged', async () => {
  const first = 'C:\\mori-test\\one\\git.exe';
  const fake = useStandIn(withVersion(), [first, 'C:\\mori-test\\two\\git.exe']);
  const { value, logs, errors } = await quietly(() => G.findGit());
  assert.deepEqual(value, { state: 'ok', version: '2.55.0' });
  assert.deepEqual(G.gitState(), value);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.deepEqual({ path: call.path, args: call.args, cwd: call.options.cwd },
    { path: first, args: ['--version'], cwd: 'C:\\mori-test\\one' });
  assert.deepEqual(logs, [`[kernel] git: using ${first} (2.55.0)`]);
  assert.deepEqual(errors, []);
});

test('FS-01 no candidate exists: missing, no process started, the reason logged', async () => {
  const fake = fakeSpawn(withVersion());
  G.configureGit({ spawn: fake.spawn, candidates: () => ['C:\\a\\git.exe', PROGRAM_FILES_GIT], exists: () => false });
  const { value, errors } = await quietly(() => G.findGit());
  assert.deepEqual(value, { state: 'missing' });
  assert.deepEqual(G.gitState(), { state: 'missing' });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(errors, ['[kernel] git: git.exe was not found']);
  const run = await quietly(() => userRun(tmp.root, ['status']));
  assert.equal(run.value.error, 'Git was not found.');
  assert.equal(fake.calls.length, 0);
});

test('FS-01 a failing --version is missing with the failure logged (exit code, unexpected output, no start)',
  async () => {
    const cases = [
      [{ code: 1, stderr: 'error: cannot run the helper\n' }, '--version failed: cannot run the helper'],
      [{ code: 0, stdout: 'hello\n' }, '--version gave unexpected output: hello'],
      [{ throws: new Error('spawn EACCES') }, '--version failed: spawn EACCES'],
    ];
    for (const [reply, reason] of cases) {
      useStandIn((call) => reply);
      const { value, errors } = await quietly(() => G.findGit());
      assert.deepEqual(value, { state: 'missing' });
      assert.equal(errors.at(-1), `[kernel] git: ${FAKE_GIT} ${reason}`);
    }
  });

test('FS-01 a --version that takes longer than 5 s is missing', async (t) => {
  const fake = useStandIn(() => ({ hold: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = captureLogs();
  try {
    const search = G.findGit();
    assert.equal(fake.calls.length, 1);
    t.mock.timers.tick(4999);
    assert.equal(fake.calls[0].kills, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(await search, { state: 'missing' });
    assert.deepEqual(logs.errors, [
      '[kernel] git --version timed out after 5000 ms in C:\\mori-test\\fake',
      `[kernel] git: ${FAKE_GIT} --version failed: git took too long and was stopped`,
    ]);
  } finally {
    logs.restore();
  }
});

test('FS-01 2.31 is old, 2.32 is ok (minor compared as a number); runGit while old says why', async () => {
  const versions = [
    ['git version 2.31.1.windows.1\n', { state: 'old', version: '2.31.1' }],
    ['git version 2.9.5\n', { state: 'old', version: '2.9.5' }],
    ['git version 2.32.0.windows.2\n', { state: 'ok', version: '2.32.0' }],
    ['git version 3.0.0\n', { state: 'ok', version: '3.0.0' }],
  ];
  for (const [stdout, state] of versions) {
    useStandIn(() => ({ stdout }));
    const { value, errors } = await quietly(() => G.findGit());
    assert.deepEqual(value, state);
    assert.deepEqual(G.gitState(), state);
    if (state.state === 'old') {
      assert.deepEqual(errors, [`[kernel] git: ${FAKE_GIT} is ${state.version}; 2.32 or newer is required`]);
    }
  }
  const fake = useStandIn(() => ({ stdout: 'git version 2.31.1.windows.1\n' }));
  const { value } = await quietly(() => userRun(tmp.root, ['status']));
  assert.equal(value.error, 'Git 2.32 or newer is required (found 2.31.1).');
  assert.deepEqual(fake.calls.map((call) => call.args), [['--version']]);
});

test('FS-01 MORI_GIT_PATH set: only that path is tried; when it is missing the state is missing', async () => {
  const only = 'C:\\mori-test\\only\\git.exe';
  const checked = [];
  let listed = 0;
  let present = false;
  const fake = fakeSpawn(withVersion());
  const restore = setEnv({ MORI_GIT_PATH: only });
  try {
    G.configureGit({ spawn: fake.spawn, candidates: () => { listed += 1; return [PROGRAM_FILES_GIT]; },
      exists: (path) => { checked.push(path); return present; } });
    const missing = await quietly(() => G.findGit());
    assert.deepEqual(missing.value, { state: 'missing' });
    assert.deepEqual(missing.errors, [`[kernel] git: MORI_GIT_PATH points to a missing file: ${only}`]);
    present = true;
    const found = await quietly(() => G.findGit(true));
    assert.deepEqual(found.value, { state: 'ok', version: '2.55.0' });
    assert.deepEqual(checked, [only, only]);
    assert.equal(listed, 0);
    assert.deepEqual(fake.calls.map((call) => call.path), [only]);
  } finally {
    restore();
  }
});

test('FS-01 missing, then a workspace.status-style findGit(true) finds a git placed afterwards', async () => {
  let placed = false;
  let checks = 0;
  const fake = fakeSpawn(withVersion());
  G.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT],
    exists: () => { checks += 1; return placed; } });
  assert.deepEqual((await quietly(() => G.findGit())).value, { state: 'missing' });
  placed = true;
  // 别处（不带 force）不重找
  assert.deepEqual(await G.findGit(), { state: 'missing' });
  assert.equal((await quietly(() => userRun(tmp.root, ['status']))).value.error, 'Git was not found.');
  assert.equal(checks, 1);
  assert.deepEqual((await quietly(() => G.findGit(true))).value, { state: 'ok', version: '2.55.0' });
  assert.equal(checks, 2);
  assert.equal(fake.calls.length, 1);
});

test('FS-01 once ok it is never searched again, not even with force; concurrent searches share one', async () => {
  let checks = 0;
  let listed = 0;
  const fake = fakeSpawn(withVersion());
  G.configureGit({ spawn: fake.spawn, candidates: () => { listed += 1; return [FAKE_GIT]; },
    exists: () => { checks += 1; return true; } });
  const first = G.findGit();
  assert.equal(G.findGit(true), first);
  await quietly(() => first);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await G.findGit(true), { state: 'ok', version: '2.55.0' });
  await userRun(tmp.root, ['status']);
  assert.deepEqual({ checks, listed, versions: fake.calls.filter((call) => call.args[0] === '--version').length },
    { checks: 1, listed: 1, versions: 1 });
});

test('FS-01 real machine: with MORI_GIT_PATH unset Git for Windows 2.32 or newer is found', async () => {
  const F = await loadKernelModule('src/kernel/git.ts');
  const { value, logs } = await quietly(() => F.findGit());
  assert.equal(value.state, 'ok');
  const [major, minor] = value.version.split('.').map(Number);
  assert.ok(major > 2 || (major === 2 && minor >= 32), `found ${value.version}`);
  // 找到的是启动器 cmd\git.exe 时（PowerShell 的 PATH 里通常是它）行尾另写内部仓库用的真正的 git
  assert.match(logs[0], /^\[kernel\] git: using .*git\.exe \(\d+\.\d+(\.\d+)?\)(; internal repos use .*git\.exe)?$/);
});

test('FS-01 real machine: MORI_GIT_PATH to a missing file is missing although git is installed; '
  + 'after it points to a real git only findGit(true) finds it', async () => {
  const F = await loadKernelModule('src/kernel/git.ts');
  const restore = setEnv({ MORI_GIT_PATH: join(tmp.root, 'no-git', 'git.exe') });
  try {
    assert.deepEqual((await quietly(() => F.findGit())).value, { state: 'missing' });
    process.env.MORI_GIT_PATH = realGitPath();
    assert.deepEqual(await F.findGit(), { state: 'missing' });
    assert.equal((await quietly(() => F.findGit(true))).value.state, 'ok');
  } finally {
    restore();
  }
});

// ---- FS-02 运行 git：环境、固定选项、隔离配置 ----

test('FS-02 the child env has no GIT_* (GIT_DIR, GIT_INDEX_FILE, Git_Work_Tree set in the parent), LC_ALL=C, '
  + 'GIT_TERMINAL_PROMPT=0; process.env is unchanged', async () => {
  const restore = setEnv({ GIT_DIR: 'C:\\elsewhere\\.git', GIT_INDEX_FILE: 'C:\\elsewhere\\index',
    Git_Work_Tree: 'C:\\elsewhere', LC_ALL: 'en_US.UTF-8', MORI_TEST_KEEP: 'kept' });
  try {
    const before = { ...process.env };
    const fake = useStandIn(withVersion());
    await quietly(() => userRun(tmp.root, ['status']));
    G.setSnapshotsDir(join(tmp.root, 'snap-env'));
    await G.runGit({ args: ['init'], cwd: tmp.root, key: 'env', isolated: true, timeoutMs: 1000, maxOutput: 1000 });
    assert.deepEqual({ ...process.env }, before);
    assert.equal(fake.calls.length, 3);
    // --version、用户仓库的调用只有 GIT_TERMINAL_PROMPT；内部仓库的调用另有隔离配置的两个
    const isolated = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'];
    assert.deepEqual(fake.calls.map((call) => gitKeys(call.options.env)),
      [['GIT_TERMINAL_PROMPT'], ['GIT_TERMINAL_PROMPT'], isolated]);
    for (const call of fake.calls) {
      const env = call.options.env;
      assert.notEqual(env, process.env);
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase() === 'LC_ALL'), ['LC_ALL']);
      assert.equal(env.LC_ALL, 'C');
      assert.equal(env.MORI_TEST_KEEP, 'kept');
    }
  } finally {
    restore();
  }
});

test('FS-02 internalArgs is --git-dir, --work-tree and the five -c, in that order', () => {
  assert.deepEqual(G.internalArgs('C:\\snap\\r', 'C:\\work dir'),
    ['--git-dir=C:\\snap\\r', '--work-tree=C:\\work dir', ...FIVE_C]);
});

test('FS-02 an internal call carries the fixed prefix, GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL; '
  + '<snapshots>\\gitconfig is written when missing', async () => {
  const snap = join(tmp.root, 'snap-a', 'snapshots');
  const work = freshDir('w');
  const gitDir = join(snap, 'repo');
  G.setSnapshotsDir(snap);
  assert.equal(G.snapshotsDir(), snap);
  const fake = useStandIn(withVersion());
  const result = await G.runGit({ args: [...G.internalArgs(gitDir, work), 'add', '-A'], cwd: work, key: gitDir,
    isolated: true, timeoutMs: G.GIT_TIMEOUTS.snapshot, maxOutput: G.GIT_OUTPUT.other });
  assert.equal(result.code, 0);
  const call = fake.calls.at(-1);
  assert.deepEqual(call.args, [`--git-dir=${gitDir}`, `--work-tree=${work}`, ...FIVE_C, 'add', '-A']);
  assert.deepEqual(gitKeys(call.options.env), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
  assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(call.options.env.GIT_CONFIG_GLOBAL, win32.join(snap, 'gitconfig'));
  assert.equal(readFileSync(join(snap, 'gitconfig'), 'utf8'), ISOLATED_CONFIG);
});

test('FS-02 an existing <snapshots>\\gitconfig is not overwritten', async () => {
  const snap = freshDir('snap');
  writeFileSync(join(snap, 'gitconfig'), '[user]\n\tname = kept\n');
  G.setSnapshotsDir(snap);
  useStandIn(withVersion());
  const result = await G.runGit({ args: ['init'], cwd: snap, key: snap, isolated: true, timeoutMs: 1000,
    maxOutput: 1000 });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(join(snap, 'gitconfig'), 'utf8'), '[user]\n\tname = kept\n');
});

test('FS-02 with the Git for Windows launcher cmd\\git.exe, internal calls start the real git next to it; '
  + 'user-repo calls keep the launcher; other git paths are used as they are', async () => {
  G.setSnapshotsDir(freshDir('snap'));
  const work = freshDir('w');
  const launcher = 'C:\\mori-gfw\\cmd\\git.exe';
  const cases = [
    [launcher, ['C:\\mori-gfw\\mingw64\\bin\\git.exe'], 'C:\\mori-gfw\\mingw64\\bin\\git.exe'],
    [launcher, ['C:\\mori-gfw\\clangarm64\\bin\\git.exe'], 'C:\\mori-gfw\\clangarm64\\bin\\git.exe'],
    [launcher, [], launcher],
    ['C:\\mori-gfw\\mingw64\\bin\\git.exe', [], 'C:\\mori-gfw\\mingw64\\bin\\git.exe'],
  ];
  for (const [found, present, internal] of cases) {
    const fake = fakeSpawn(withVersion());
    const exists = (path) => path === found || present.includes(path);
    G.configureGit({ spawn: fake.spawn, candidates: () => [found], exists });
    const { logs } = await quietly(async () => {
      await G.runGit({ args: ['write-tree'], cwd: work, key: 'k', isolated: true, timeoutMs: 1000, maxOutput: 1000 });
      await userRun(work, ['status']);
    });
    assert.deepEqual(fake.calls.map((call) => call.path), [found, internal, found], JSON.stringify(present));
    const also = internal === found ? '' : `; internal repos use ${internal}`;
    assert.ok(logs.includes(`[kernel] git: using ${found} (2.55.0)${also}`), logs.join('\n'));
  }
});

test('FS-02 a user-repo call has no -c, no GIT_CONFIG_* and does not write the gitconfig', async () => {
  const snap = join(tmp.root, 'snap-user');
  G.setSnapshotsDir(snap);
  const fake = useStandIn(withVersion());
  const cwd = freshDir('u');
  await userRun(cwd, ['status', '--porcelain=v2']);
  const call = fake.calls.at(-1);
  assert.deepEqual(call.args, ['status', '--porcelain=v2']);
  assert.deepEqual(gitKeys(call.options.env), ['GIT_TERMINAL_PROMPT']);
  assert.equal(existsSync(join(snap, 'gitconfig')), false);
});

test('FS-02 an internal call before the snapshots folder is set is refused without starting git', async () => {
  const F = await loadKernelModule('src/kernel/git.ts');
  assert.throws(() => F.snapshotsDir(), { message: 'The snapshots folder is not set.' });
  const fake = fakeSpawn(withVersion());
  F.configureGit({ spawn: fake.spawn, candidates: () => [FAKE_GIT], exists: () => true });
  const { value, errors } = await quietly(() => F.runGit({ args: ['init'], cwd: tmp.root, key: 'k', isolated: true,
    timeoutMs: 1000, maxOutput: 1000 }));
  assert.equal(value.code, null);
  assert.equal(value.error, 'The snapshots folder is not set.');
  assert.deepEqual(fake.calls.map((call) => call.args), [['--version']]);
  assert.deepEqual(errors, ['[kernel] git: the snapshots folder is not set; internal-repo call refused']);
});

/**
 * @brief 快照目录设成 snap 时跑一次内部仓库的调用（替身 git），查：git 没起来（只有 --version）、code 为 null、
 *        error 正是日志 `[kernel] git: couldn't write <snap>\gitconfig: <原因>` 里的原因。
 * @param snap 写不出 gitconfig 的快照目录
 */
async function assertConfigRefused(snap) {
  G.setSnapshotsDir(snap);
  const fake = useStandIn(withVersion());
  const { value, errors } = await quietly(() => G.runGit({ args: ['init'], cwd: tmp.root, key: 'k',
    isolated: true, timeoutMs: 1000, maxOutput: 1000 }));
  assert.deepEqual(fake.calls.map((call) => call.args), [['--version']], `snapshots folder ${snap}`);
  assert.equal(value.code, null);
  assert.equal(typeof value.error, 'string');
  const head = `[kernel] git: couldn't write ${win32.join(snap, 'gitconfig')}: `;
  assert.ok(errors.includes(head + value.error), `${value.error}\n${errors.join('\n')}`);
}

test('FS-02 when <snapshots>\\gitconfig cannot be written (the snapshots folder is under a file) the internal call '
  + 'fails with the logged reason and git does not start', async () => {
  const blocker = join(freshDir('blk'), 'file');
  writeFileSync(blocker, 'x');
  await assertConfigRefused(join(blocker, 'snapshots'));
});

test('FS-02 when <snapshots>\\gitconfig cannot be written (the snapshots folder is itself a file) the internal call '
  + 'fails with the logged reason and git does not start', async () => {
  const blocker = join(freshDir('blk'), 'file');
  writeFileSync(blocker, 'x');
  await assertConfigRefused(blocker);
});

test('FS-02 no shell: arguments as given, windowsHide, cwd; stdin is piped and ended only when given', async () => {
  const fake = useStandIn(withVersion());
  const cwd = freshDir('s');
  const args = ['add', '--', 'a b.txt', 'say "hi".txt', 'caf\u00e9 \u4e2d.txt'];
  await userRun(cwd, args);
  const plain = fake.calls.at(-1);
  assert.deepEqual(plain.args, args);
  assert.equal(plain.options.shell, undefined);
  assert.deepEqual({ cwd: plain.options.cwd, windowsHide: plain.options.windowsHide, stdio: plain.options.stdio },
    { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const input = Buffer.from('a b.txt\0c.txt\0');
  await userRun(cwd, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: input });
  const piped = fake.calls.at(-1);
  assert.deepEqual(piped.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(Buffer.concat(piped.stdin), input);
  assert.equal(piped.stdinEnded, true);
});

test('FS-02 the timeouts and output caps are the §17 values', () => {
  assert.deepEqual({ ...G.GIT_TIMEOUTS }, { version: 5000, quick: 10000, snapshot: 120000, prune: 300000 });
  assert.deepEqual({ ...G.GIT_OUTPUT }, { status: 4 * 1024 * 1024, other: 16 * 1024 * 1024, stderr: 64 * 1024 });
});

// ---- FS-02 超时、上限、结束 ----

test('FS-02 a timeout ends the process, marks timedOut and logs the line with the subcommand', async () => {
  const fake = useStandIn(withVersion(() => ({ hold: true })));
  const cwd = freshDir('t');
  const user = await quietly(() => userRun(cwd, ['status'], { timeoutMs: 30 }));
  assert.deepEqual(user.value, { code: null, stdout: EMPTY, stderr: '', timedOut: true, truncated: false,
    error: null });
  assert.equal(fake.calls.at(-1).kills, 1);
  assert.deepEqual(user.errors, [`[kernel] git status timed out after 30 ms in ${cwd}`]);
  assert.equal(G.gitError(user.value), 'git took too long and was stopped');
  // 内部仓库的调用：日志里的子命令跳过 --git-dir、--work-tree 与 -c
  G.setSnapshotsDir(join(tmp.root, 'snap-t'));
  const internal = await quietly(() => G.runGit({ args: [...G.internalArgs(join(cwd, 'r'), cwd), 'add', '-A'], cwd,
    key: join(cwd, 'r'), isolated: true, timeoutMs: 30, maxOutput: 1000 }));
  assert.equal(internal.value.timedOut, true);
  assert.deepEqual(internal.errors, [`[kernel] git add timed out after 30 ms in ${cwd}`]);
});

test('FS-02 stdout over the cap ends the process once, keeps the first maxOutput bytes and logs', async () => {
  const fake = useStandIn(withVersion(() => ({ hold: true })));
  const cwd = freshDir('o');
  const logs = captureLogs();
  try {
    const running = userRun(cwd, ['log'], { maxOutput: 4 });
    await until(() => fake.calls.length === 2);
    const call = fake.calls[1];
    call.child.stdout.emit('data', Buffer.from('abcdefghij'));
    call.child.stdout.emit('data', Buffer.from('klm'));
    const result = await running;
    assert.deepEqual(result, { code: null, stdout: Buffer.from('abcd'), stderr: '', timedOut: false, truncated: true,
      error: null });
    assert.equal(call.kills, 1);
    assert.deepEqual(logs.errors, [`[kernel] git log output exceeded 4 bytes in ${cwd}`]);
    assert.equal(G.gitError(result), 'git printed more output than Mori reads');
  } finally {
    logs.restore();
  }
  useStandIn(withVersion(() => ({ stdout: 'abcd' })));
  const exact = await userRun(cwd, ['log'], { maxOutput: 4 });
  assert.deepEqual({ code: exact.code, out: exact.stdout.toString(), truncated: exact.truncated },
    { code: 0, out: 'abcd', truncated: false });
});

test('FS-02 stderr keeps only the first 64 KB', async () => {
  useStandIn(withVersion(() => ({ code: 1, stderr: 'x'.repeat(70_000) })));
  const result = await userRun(tmp.root, ['status']);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.length, 64 * 1024);
});

test('FS-02 a stand-in that never emits close ends at the timeout with timedOut after the 2 s grace', async (t) => {
  const fake = useStandIn(withVersion(() => ({ hold: true, ignoreKill: true })));
  await G.findGit();
  const cwd = freshDir('n');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = captureLogs();
  try {
    let result = null;
    void userRun(cwd, ['status'], { timeoutMs: 50 }).then((value) => { result = value; });
    await until(() => fake.calls.length === 2);
    t.mock.timers.tick(50);
    assert.equal(fake.calls[1].kills, 1);
    t.mock.timers.tick(1999);
    await new Promise((done) => setImmediate(done));
    assert.equal(result, null);
    t.mock.timers.tick(1);
    await until(() => result !== null);
    assert.deepEqual(result, { code: null, stdout: EMPTY, stderr: '', timedOut: true, truncated: false, error: null });
    assert.deepEqual(logs.errors, [`[kernel] git status timed out after 50 ms in ${cwd}`,
      `[kernel] git status in ${cwd}: its output stayed open after it was stopped`]);
  } finally {
    logs.restore();
  }
});

test('FS-02 a process that cannot start gives the error text (spawn throws, missing folder, not a folder)',
  async () => {
    const cwd = freshDir('e');
    const missing = join(cwd, 'gone');
    const file = join(cwd, 'file.txt');
    writeFileSync(file, 'x');
    const enoent = Object.assign(new Error(`spawn ${FAKE_GIT} ENOENT`), { code: 'ENOENT' });
    const cases = [
      [cwd, { throws: new Error('spawn EACCES') }, 'spawn EACCES', `[kernel] git status couldn't start in ${cwd}: `
        + 'spawn EACCES'],
      [missing, { error: enoent }, `folder not found: ${missing}`,
        `[kernel] git status failed in ${missing}: folder not found: ${missing}`],
      [file, { error: enoent }, `not a folder: ${file}`,
        `[kernel] git status failed in ${file}: not a folder: ${file}`],
      [cwd, { error: enoent }, enoent.message, `[kernel] git status failed in ${cwd}: ${enoent.message}`],
    ];
    for (const [where, reply, text, line] of cases) {
      useStandIn(withVersion(() => reply));
      const { value, errors } = await quietly(() => userRun(where, ['status']));
      assert.deepEqual(value, { code: null, stdout: EMPTY, stderr: '', timedOut: false, truncated: false,
        error: text });
      assert.equal(G.gitError(value), text);
      assert.deepEqual(errors, [line]);
    }
  });

test('FS-02 gitError: the first non-empty stderr line without fatal: / error:, else a sentence', () => {
  const base = { code: 128, stdout: EMPTY, stderr: '', timedOut: false, truncated: false, error: null };
  const cases = [
    [{ stderr: '\n  \nfatal: not a git repository (or any of the parent directories): .git\nmore\n' },
      'not a git repository (or any of the parent directories): .git'],
    [{ stderr: 'error: pathspec \'x\' did not match\r\n' }, 'pathspec \'x\' did not match'],
    [{ stderr: 'warning: something\nfatal: second line\n' }, 'warning: something'],
    [{ code: 3 }, 'git exited with code 3'],
    [{ code: null, truncated: true }, 'git printed more output than Mori reads'],
    [{ timedOut: true, stderr: 'fatal: x\n' }, 'git took too long and was stopped'],
    [{ error: 'spawn EACCES', stderr: 'fatal: x\n' }, 'spawn EACCES'],
  ];
  for (const [patch, text] of cases) assert.equal(G.gitError({ ...base, ...patch }), text);
});

// ---- FS-02 排队与中止 ----

test('FS-02 two calls with the same key do not overlap (key case and slashes ignored); different keys run in '
  + 'parallel', async () => {
  const fake = useStandIn(withVersion((call) => (call.args[1] === 'B' ? { stdout: 'b' } : { hold: true })));
  const cwd = freshDir('q');
  const run = (name, key) => G.runGit({ args: ['log', name], cwd, key, timeoutMs: 5000, maxOutput: 1000 });
  const a = run('A', 'C:\\Mori\\Repo');
  const b = run('B', 'c:/mori/repo');
  const c = run('C', 'C:\\Mori\\Other');
  await until(() => fake.calls.length === 3);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(fake.calls.map((call) => call.args[1] ?? call.args[0]), ['--version', 'A', 'C']);
  fake.calls[1].finish({ stdout: 'a' });
  assert.equal((await b).stdout.toString(), 'b');
  assert.equal((await a).stdout.toString(), 'a');
  assert.deepEqual(fake.calls.map((call) => call.args[1] ?? call.args[0]), ['--version', 'A', 'C', 'B']);
  fake.calls[2].finish({ stdout: 'c' });
  assert.equal((await c).stdout.toString(), 'c');
});

test('FS-02 GitRun.signal already aborted: no process is started and the error is stopped', async () => {
  const fake = useStandIn(withVersion());
  await G.findGit();
  const result = await userRun(tmp.root, ['status'], { signal: AbortSignal.abort() });
  assert.deepEqual(result, { code: null, stdout: EMPTY, stderr: '', timedOut: false, truncated: false,
    error: 'stopped' });
  assert.equal(fake.calls.length, 1);
});

test('FS-02 GitRun.signal aborted while running: the process is ended and the error is stopped', async () => {
  const fake = useStandIn(withVersion(() => ({ hold: true, killCode: 1 })));
  const controller = new AbortController();
  const running = userRun(tmp.root, ['add', '-A'], { signal: controller.signal });
  await until(() => fake.calls.length === 2);
  controller.abort();
  const result = await running;
  assert.equal(fake.calls[1].kills, 1);
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, error: result.error },
    { code: null, timedOut: false, error: 'stopped' });
});

test('FS-02 GitRun.signal aborted while queued behind the same key: it never starts', async () => {
  const fake = useStandIn(withVersion(() => ({ hold: true })));
  const controller = new AbortController();
  const first = userRun(tmp.root, ['log', 'first']);
  const second = userRun(tmp.root, ['log', 'second'], { signal: controller.signal });
  await until(() => fake.calls.length === 2);
  controller.abort();
  fake.calls[1].finish({ stdout: 'one' });
  assert.equal((await first).stdout.toString(), 'one');
  assert.equal((await second).error, 'stopped');
  assert.equal(fake.calls.length, 2);
});

// ---- FS-02 真实 git：隔离的配置与结束整棵进程树 ----

test('FS-02 real git: an internal call reads only <snapshots>\\gitconfig (no system or user config); '
  + 'a user call reads the user config', async () => {
  useRealGit();
  const snap = join(tmp.root, 'snap-real');
  G.setSnapshotsDir(snap);
  const cwd = freshDir('cfg');
  const listing = (isolated) => G.runGit({ args: ['config', '--list', '--show-scope'], cwd, key: cwd, isolated,
    timeoutMs: G.GIT_TIMEOUTS.quick, maxOutput: G.GIT_OUTPUT.other });
  const inner = await quietly(() => listing(true));
  assert.equal(inner.value.code, 0, inner.value.stderr);
  const lines = inner.value.stdout.toString('utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, ['global\tsafe.directory=*']);
  const user = await listing(false);
  assert.equal(user.code, 0, user.stderr);
  assert.ok(user.stdout.toString('utf8').split('\n').includes('global\tuser.name=Mori Test'));
});

/**
 * @brief 一个进程与它的全部后代（Win32_Process 经 Windows PowerShell 查全部进程，约 1 秒；异步，查的时候 runGit
 *        照常收输出）。
 * @param root 根进程的 pid
 * @return [{ pid, parent, name }]，根在最前
 */
function processTree(root) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object '
    + '{ "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';
  return new Promise((resolveTree, rejectTree) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          rejectTree(new Error(`powershell failed: ${error.message} ${stderr}`));
          return;
        }
        const all = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [pid, parent, ...name] = line.trim().split(' ');
          return { pid: Number(pid), parent: Number(parent), name: name.join(' ') };
        });
        resolveTree(descendants(all, root));
      });
  });
}

/**
 * @brief 等过滤器的进程树起来（里面有 sh.exe）再返回它；最多等 20 秒。
 * @param root 起的 git 进程的 pid
 */
async function fullTree(root) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const tree = await processTree(root);
    if (tree.some((item) => item.name.toLowerCase() === 'sh.exe') || Date.now() > deadline) return tree;
  }
}

/**
 * @brief 结束命令行里带 marker 的 sh 进程（这个用例的过滤器）：超时恰好落在 git 起过滤器的半途时，起来的 sh 不在
 *        taskkill /T 列出的树里，没人结束它（与 Mori 无关：内部仓库从不跑过滤器）；测试自己收拾，不留进程、不占临时目录。
 * @param marker 过滤器命令行里的 started 文件路径
 */
function killStrays(marker) {
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'sh.exe\'" | ForEach-Object '
    + '{ "$($_.ProcessId) $($_.CommandLine)" }';
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        const pids = error ? [] : stdout.split(/\r?\n/).filter((line) => line.includes(marker))
          .map((line) => Number(line.trim().split(' ')[0]));
        for (const pid of pids) {
          try {
            process.kill(pid);
          } catch {
            // 已经结束了
          }
        }
        done(pids.length);
      });
  });
}

/** @brief 从进程表里取出 root 与它的后代（按层）。 */
function descendants(all, root) {
  const tree = all.filter((item) => item.pid === root);
  for (let at = 0; at < tree.length; at += 1) {
    const parent = tree[at].pid;
    tree.push(...all.filter((item) => item.parent === parent && !tree.some((known) => known.pid === item.pid)));
  }
  return tree;
}

/** @brief 进程还在不在（signal 0 只查不发）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** @brief 等条件成立（真实时间，每 5 毫秒查一次）。 */
async function waitFor(condition, limitMs) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > limitMs) throw new Error(`condition not met within ${limitMs} ms`);
    await pause(5);
  }
}

/**
 * @brief 让 add -A 一直跑下去的 clean 过滤器（synthetic）：工作路径的 .gitattributes 让每个文件都过它；它写出 started 文件
 *        （测试据此知道整棵树都起来了）后在 sh 自己里空转，不起别的进程。git 经 sh 起它，进程树是 git.exe → sh.exe，
 *        started 一出现树就是全的。不起子进程：机器忙时停止或超时可能落在 sh 起子进程的半途，taskkill /T 列进程树时
 *        子进程还没起来，之后起来的没人结束、拿着输出管道（MSYS 的 sleep 还会因 exec 换掉父进程而找不到；与 Mori 无关：
 *        内部仓库从不跑过滤器）。
 * @param started 过滤器起来时写出的文件
 * @return 放在子命令之前的 -c 选项
 */
function slowFilter(started) {
  const file = started.replace(/\\/g, '/');
  return ['-c', `filter.slow.clean=echo started > '${file}'; end=$((SECONDS+30)); `
    + 'while [ $SECONDS -lt $end ]; do :; done'];
}

/** 停止与超时的用例共用的工作路径（synthetic）；第一个用到它的用例建 */
let slowWork = null;

/** @brief 共用的工作路径：几个小文件与让它们都过 slowFilter 的 .gitattributes。 */
function slowWorkTree() {
  if (slowWork !== null) return slowWork;
  slowWork = join(freshDir('tk'), 'w');
  writeFiles(slowWork, { '.gitattributes': '* filter=slow\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'sub/c.txt': 'c\n' });
  return slowWork;
}

/**
 * @brief 真实 git 的内部仓库（synthetic）：工作路径是共用的 slowWorkTree()，内部仓库与快照目录每次新建；
 *        用 Program Files 的启动器 cmd\git.exe 跑（真正干活的 git 是它的子进程）。
 *        slowAdd(extra) 是带 slowFilter 的 add -A（日志里的子命令仍是 add），过滤器起来时写出 started。
 */
async function slowAddRepo() {
  const work = slowWorkTree();
  const base = freshDir('tk');
  const gitDir = join(base, 'r');
  const started = join(base, 'started');
  const spawned = useRealGit(PROGRAM_FILES_GIT);
  G.setSnapshotsDir(join(base, 'snap'));
  const internal = (args, extra = {}) => G.runGit({ args: [...G.internalArgs(gitDir, work), ...args], cwd: work,
    key: gitDir, isolated: true, timeoutMs: G.GIT_TIMEOUTS.snapshot, maxOutput: G.GIT_OUTPUT.other, ...extra });
  const init = await quietly(() => internal(['init', '--quiet']));
  assert.equal(init.value.code, 0, init.value.stderr);
  const slowAdd = (extra) => internal([...slowFilter(started), 'add', '-A'], extra);
  return { work, gitDir, slowAdd, spawned, started, lock: join(gitDir, 'index.lock') };
}

test('FS-02 real git: stopping a running internal "add -A" ends the whole process tree (index.lock removable)',
  async () => {
    const repo = await slowAddRepo();
    const controller = new AbortController();
    const logs = captureLogs();
    let result;
    let took;
    let tree;
    try {
      const running = repo.slowAdd({ signal: controller.signal });
      await waitFor(() => existsSync(repo.started) && existsSync(repo.lock), 10_000);
      tree = await fullTree(repo.spawned.at(-1).pid);
      const stoppedAt = Date.now();
      controller.abort();
      result = await running;
      took = Date.now() - stoppedAt;
    } finally {
      logs.restore();
      await killStrays(repo.started.replace(/\\/g, '/'));
    }
    // 内部仓库的调用直接起启动器旁边真正的 git（§3.3），它与过滤器都在跑（这个检查本身看得见进程树）
    const names = tree.map((item) => item.name.toLowerCase());
    assert.deepEqual([names[0], names.includes('sh.exe')], ['git.exe', true], JSON.stringify(tree));
    assert.match(repo.spawned.at(-1).spawnfile, /[\\/]mingw64[\\/]bin[\\/]git\.exe$/i);
    assert.deepEqual({ code: result.code, error: result.error }, { code: null, error: 'stopped' });
    // 进程是被结束的，不是等过滤器睡完（30 秒）；'close' 在 2 秒的宽限之前就来了（没有 "its output stayed open"）。
    // 不卡紧时间：整组并行时 taskkill 自己就可能要一两秒
    assert.ok(took < 10_000, `took ${took} ms`);
    assert.ok(!logs.errors.some((line) => line.includes('its output stayed open')), logs.errors.join('\n'));
    assert.deepEqual(tree.filter((item) => alive(item.pid)), []);
    rmSync(repo.lock);
    assert.equal(existsSync(repo.lock), false);
  });

/** 超时的真实 git 调用（两个用例共用一次：一个查进程树与日志，一个查退出码）；第一个用到它的用例跑 */
let timedOutAdd = null;

/**
 * 超时（毫秒）：要长到过滤器的 sh 起来之后才到时，否则 taskkill /T 列树时 sh 还没起来、之后没人结束它（见 slowFilter）；
 * 整组并行时 git 起过滤器也要一两秒
 */
const SLOW_TIMEOUT_MS = 6_000;

/**
 * @brief 共用的超时调用：在新的内部仓库里跑一直不结束的 add -A，SLOW_TIMEOUT_MS 超时。
 * @return { repo, result, took, errors }
 */
function timedOutRun() {
  timedOutAdd ??= (async () => {
    const repo = await slowAddRepo();
    const logs = captureLogs();
    try {
      const started = Date.now();
      const result = await repo.slowAdd({ timeoutMs: SLOW_TIMEOUT_MS });
      return { repo, result, took: Date.now() - started, errors: logs.errors };
    } finally {
      logs.restore();
      await killStrays(repo.started.replace(/\\/g, '/'));
    }
  })();
  return timedOutAdd;
}

test('FS-02 real git: a timed-out internal "add -A" ends the whole process tree and logs the timeout',
  async () => {
    const { repo, result, took, errors } = await timedOutRun();
    assert.deepEqual({ timedOut: result.timedOut, truncated: result.truncated, error: result.error },
      { timedOut: true, truncated: false, error: null });
    // 进程树的直接检查（Win32_Process）在上面停止的用例里做，结束的路径相同（killTree）。这里不查 2 秒的宽限：
    // 整组并行很慢时超时可能落在 git 起过滤器的半途，之后起来的 sh 不在 taskkill /T 列出的树里，管道由它拿着，
    // 宽限到时照样给出结果（§17）。不卡紧时间（整组并行时 taskkill 自己就可能要一两秒），只要远早于过滤器转完（30 秒）。
    // 整组并行时偶尔多一行 taskkill 的退出码 255（树里有进程在它动手前已经退出），不影响结果，这里不查它
    assert.ok(took < SLOW_TIMEOUT_MS + 10_000, `took ${took} ms`);
    assert.equal(errors[0], `[kernel] git add timed out after ${SLOW_TIMEOUT_MS} ms in ${repo.work}`);
    assert.equal(alive(repo.spawned.at(-1).pid), false);
    // git 是被结束的：过滤器起来过（它在 git 拿到 index.lock 之后才起）时锁一定还在、没写完；没有进程再拿着它。
    // 整组并行很慢时 400 毫秒内 git 可能还没走到过滤器，这时只查锁（如果有）能删掉
    if (existsSync(repo.started)) assert.equal(existsSync(repo.lock), true);
    if (existsSync(repo.lock)) rmSync(repo.lock);
    assert.equal(existsSync(repo.lock), false);
  });

test('FS-02 real git: a git process Mori ended at the timeout reports code null, as GitResult.code documents',
  async () => {
    // git.ts 的 GitResult.code：“被结束、起不来时为 null”；taskkill /F 让进程以退出码 1 结束，这不是 git 的退出码
    const { result } = await timedOutRun();
    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
  });
