// 后台进程的启动与有序退出。

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';

/** 等后台进程释放会话的上限，见 docs/v0/defaults.md */
const SHUTDOWN_TIMEOUT_MS = 3000;

/** @brief 后台进程退出时的回调；quitting 为 true 表示是有意退出。 */
export type KernelExitListener = (code: number, quitting: boolean) => void;

let kernel: UtilityProcess | null = null;
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

/** @brief 启动后台进程；pi 的离线开关与配置目录在它加载前通过环境变量设好。 */
export function startKernel(onExit: KernelExitListener): UtilityProcess {
  // 开发服务器地址只给主进程用，不传给后台进程及其命令。
  const { ELECTRON_RENDERER_URL: _rendererUrl, ...baseEnv } = process.env;
  const agentDir = join(app.getPath('userData'), 'pi');
  const child = utilityProcess.fork(join(__dirname, 'kernel.js'), [], {
    serviceName: 'Mori Kernel',
    stdio: 'pipe',
    env: { ...baseEnv, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: agentDir },
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.on('exit', (code) => {
    if (!quitting) console.error(`[main] kernel exited unexpectedly with code ${code}`);
    kernel = null;
    lastExitCode = code;
    onExit(code, quitting);
  });
  kernel = child;
  return child;
}

/** @brief 结束后台进程及其全部子进程（命令留下的进程也一起结束）。 */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => {
      if (error) console.error(`[main] taskkill failed for ${pid}: ${error.message}`);
      resolve();
    });
  });
}

/** @brief 有序退出：先让后台进程停止并释放会话，再结束整个进程树。 */
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
  await killTree(child.pid);
}
