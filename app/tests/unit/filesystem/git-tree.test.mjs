// 停止与超时结束整棵进程树（docs/specs/file-system.md §3.3、§4.5、§17；验收 §19.2 FS-02 的真实 git 部分）：kernel/git.ts 的
// 内部仓库调用经 Git for Windows 起真正的 git，add -A 由一个长期运行的过滤器拖住（过滤器是 git 的子进程 sh.exe），
// Mori 停止或超时时结束整棵进程树。从 git.test.mjs 分出来：这几条要等真实的超时（6 秒）、查进程表（Windows PowerShell），
// 放在自己的文件里与别的测试文件同时跑，不拖长 git.test.mjs 里依次跑的用例（§19.1：整组单元测试不超过 20 秒）。
// 准备数据与环境同 git.test.mjs：临时目录、没有 MORI_GIT_PATH、测试用的主目录。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadKernelModule } from '../load.mjs';
import { quietly } from './gate-helpers.mjs';
import { captureLogs, isFile, pause, realGitPath, setEnv, tempRoot, testHome, writeFiles } from './git-helpers.mjs';

const G = await loadKernelModule('src/kernel/git.ts');

const tmp = tempRoot('mft-');
// 这些用例假定没有 MORI_GIT_PATH；测试用的全局配置不读你自己的
const restoreEnv = setEnv({ MORI_GIT_PATH: undefined });
const restoreHome = testHome(tmp.root);
after(() => {
  restoreHome();
  restoreEnv();
  tmp.remove();
});

let folders = 0;

/** @brief tmp 下一个新的目录（synthetic）。 */
function freshDir(name = 'd') {
  folders += 1;
  const dir = join(tmp.root, `${name}${folders}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @brief 让 G 用本机真实的 git（realGitPath），spawn 是真的 node 的 spawn。
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
 * @brief 结束这个用例的过滤器 sh（它在 started 文件里写下自己的 Windows 进程号，见 slowFilter）：超时恰好落在 git 起
 *        过滤器的半途时，起来的 sh 不在 taskkill /T 列出的树里，没人结束它（与 Mori 无关：内部仓库从不跑过滤器）；测试
 *        自己收拾，不留进程、不占临时目录。按进程号结束，不再起 Windows PowerShell 按命令行找（机器忙时一次要几秒）。
 * @param started 过滤器起来时写出的文件
 * @return 结束了几个（0 或 1）
 */
function killStrays(started) {
  const pid = Number(/^started (\d+)/.exec(existsSync(started) ? readFileSync(started, 'utf8') : '')?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    process.kill(pid);
    return 1;
  } catch {
    // 已经结束了
    return 0;
  }
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
 * @brief 让 add -A 一直跑下去的过滤器（synthetic）：工作路径的 .gitattributes 让每个文件都过它。它是长期运行的过滤器
 *        （filter.<驱动>.process）：git 起它、发完握手就等它回话，一直拿着 index.lock；它写出 started 文件（“started <它的
 *        Windows 进程号>”，用 MSYS 的 /proc/$$/winpid 与内建的 read、echo，测试据此知道整棵树都起来了，收拾时按进程号结束它）
 *        后在 sh 自己里读 git 发来的行，读不到换行时 read -t 等到 30 秒，不回话、不起别的进程。等待不占 CPU：
 *        原来空转的写法在整组并行时多占一个核十几秒，拖慢同时在跑的真实 git 用例。git 经 sh 起它，进程树是 git.exe → sh.exe，
 *        started 一出现树就是全的。不起子进程：机器忙时停止或超时可能落在 sh 起子进程的半途，taskkill /T 列进程树时
 *        子进程还没起来，之后起来的没人结束、拿着输出管道（MSYS 的 sleep 还会因 exec 换掉父进程而找不到；与 Mori 无关：
 *        内部仓库从不跑过滤器）。
 * @param started 过滤器起来时写出的文件
 * @return 放在子命令之前的 -c 选项
 */
function slowFilter(started) {
  const file = started.replace(/\\/g, '/');
  return ['-c', `filter.slow.process=read wp < /proc/$$/winpid; echo "started $wp" > '${file}'; `
    + 'while read -t 30 line; do :; done'];
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
 *        用本机的 git（realGitPath：Program Files 的启动器 cmd\git.exe，没有时 PATH 里第一个 git.exe，例如 D:\Git\cmd\git.exe）跑，
 *        内部仓库的调用起它旁边真正的 git。
 *        slowAdd(extra) 是带 slowFilter 的 add -A（日志里的子命令仍是 add），过滤器起来时写出 started。
 */
async function slowAddRepo() {
  const work = slowWorkTree();
  const base = freshDir('tk');
  const gitDir = join(base, 'r');
  const started = join(base, 'started');
  const spawned = useRealGit();
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
      killStrays(repo.started);
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
    // taskkill /F 结束的进程要等系统收完句柄才查不到：整组并行、机器忙时 sh.exe 在 'close' 之后还能查到几十毫秒，
    // 等它最多 2 秒（远早于过滤器转完的 30 秒，结束的仍是 Mori）
    await waitFor(() => !tree.some((item) => alive(item.pid)), 2_000).catch(() => undefined);
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
      killStrays(repo.started);
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
