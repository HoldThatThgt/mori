// 后台进程的启动与有序退出。后台进程放在一个作业对象里（见 job.ts）：它和它启动的所有进程（包括父进程已经不在的孤儿进程）
// 在 Mori 退出、后台进程意外退出、Mori 被强行结束时都会被结束，关闭 Mori 后不留下任何进程。
// 启动时把 userData 的位置、快照目录和解密后的 key（ref → 明文）交给后台进程；之后按它的请求按 ref 加密保存或删除 key
// （credentials.ts）。迁移 v0 的 models.json 时，里面手写的明文 key 也经同一个请求加密保存（docs/specs/model-providers.md §4.5）。

import { join, resolve } from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { deleteKey, loadKeys, storeKey } from './credentials';
import { putInJob, type ProcessJob } from './job';

/** 等后台进程释放会话的上限，见 docs/v0/defaults.md */
const SHUTDOWN_TIMEOUT_MS = 3000;

/** @brief 后台进程退出时的回调；quitting 为 true 表示是有意退出。 */
export type KernelExitListener = (code: number, quitting: boolean) => void;

let kernel: UtilityProcess | null = null;
let kernelJob: ProcessJob | null = null;
let quitting = false;
let lastExitCode: number | null = null;

/** @brief 当前运行中的后台进程。 */
export function currentKernel(): UtilityProcess | null {
  return kernel;
}

/** @brief 上一次退出时的退出码；从未退出过时为 null。 */
export function lastKernelExitCode(): number | null {
  return lastExitCode;
}

/** @brief pi 的配置目录（PI_CODING_AGENT_DIR）：`<userData>/pi`。 */
export function piAgentDir(): string {
  return join(app.getPath('userData'), 'pi');
}

/**
 * @brief 快照目录（docs/specs/file-system.md §4.1）：环境变量 MORI_SNAPSHOTS_DIR 有值时用它（测试用，照 MORI_USER_DATA
 *        的写法），否则 %LOCALAPPDATA%\Mori\snapshots（不进 %APPDATA% 的漫游配置，也不在 OneDrive 里）。
 *        Windows 总设 LOCALAPPDATA；没有时用它在 Windows 上的默认位置 <home>\AppData\Local，记一行日志。
 */
function snapshotsDir(): string {
  if (process.env.MORI_SNAPSHOTS_DIR) return resolve(process.env.MORI_SNAPSHOTS_DIR);
  const local = process.env.LOCALAPPDATA;
  if (local) return join(local, 'Mori', 'snapshots');
  const dir = join(app.getPath('home'), 'AppData', 'Local', 'Mori', 'snapshots');
  console.error(`[main] LOCALAPPDATA is not set; snapshots are kept in ${dir}`);
  return dir;
}

/** @brief 启动后台进程；pi 的离线开关与配置目录在它加载前通过环境变量设好。 */
export function startKernel(onExit: KernelExitListener): UtilityProcess {
  // 开发服务器地址只给主进程用，不传给后台进程及其命令。
  const { ELECTRON_RENDERER_URL: _rendererUrl, ...baseEnv } = process.env;
  const agentDir = piAgentDir();
  const child = utilityProcess.fork(join(__dirname, 'kernel.js'), [], {
    serviceName: 'Mori Kernel',
    stdio: 'pipe',
    env: { ...baseEnv, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: agentDir },
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  let job: ProcessJob | null = null;
  // 先放进作业再给 key：后台进程拿到 key 之前不会执行任何命令，所以它启动的进程都在作业里。
  child.once('spawn', () => {
    job = jobFor(child);
    kernelJob = job;
    child.postMessage({ type: 'start', userData: app.getPath('userData'), keys: loadStoredKeys(),
      snapshotsDir: snapshotsDir() });
  });
  child.on('exit', (code) => {
    if (!quitting) console.error(`[main] kernel exited unexpectedly with code ${code}`);
    // 后台进程不在了：结束它的作业，正在运行的命令（刚才没完成的回复）也一起结束。
    job?.terminate();
    if (kernelJob === job) kernelJob = null;
    kernel = null;
    lastExitCode = code;
    onExit(code, quitting);
  });
  child.on('message', (message: KernelToMain) => handleKernelMessage(child, message));
  kernel = child;
  return child;
}

/** @brief 把刚启动的后台进程放进作业；失败时记录错误（这时退出后可能留下命令进程）。 */
function jobFor(child: UtilityProcess): ProcessJob | null {
  try {
    return putInJob(child.pid ?? 0);
  } catch (error) {
    console.error(`[main] cannot put the kernel in a job object: ${(error as Error).message}`);
    return null;
  }
}

/** @brief 后台进程发给主进程的消息。store-key 按 key 的 ref 保存明文；key 为 null 时删除这个 ref 已保存的密文。 */
type KernelToMain =
  | { type: 'shutdown-done' }
  | { type: 'store-key'; id: number; ref: string; key: string | null };

/** @brief 读取并解密已保存的 key；失败时记录错误，后台进程按"没有 key"启动。 */
function loadStoredKeys(): Record<string, string> {
  try {
    return loadKeys();
  } catch (error) {
    console.error(`[main] cannot load stored keys: ${(error as Error).message}`);
    return {};
  }
}

/** @brief 处理后台进程的请求：目前只有"按 ref 加密保存 key"和"按 ref 删除 key"。 */
function handleKernelMessage(child: UtilityProcess, message: KernelToMain): void {
  if (message?.type !== 'store-key') return;
  let error: string | null = null;
  try {
    if (message.key === null) deleteKey(message.ref);
    else storeKey(message.ref, message.key);
  } catch (cause) {
    error = (cause as Error).message;
    const action = message.key === null ? 'delete' : 'store';
    console.error(`[main] cannot ${action} the key ${message.ref}: ${error}`);
  }
  child.postMessage({ type: 'store-key-result', id: message.id, error });
}

/** @brief 有序退出：先让后台进程停止并释放会话，再结束它的作业（后台进程和它启动的所有进程）。 */
export async function shutdownKernel(): Promise<void> {
  const child = kernel;
  quitting = true;
  if (!child?.pid) return;
  const released = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.error('[main] kernel did not finish shutdown in time');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    child.on('message', (message: { type?: string }) => {
      if (message?.type !== 'shutdown-done') return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.postMessage({ type: 'shutdown' });
  await released;
  kernelJob?.terminate();
}
