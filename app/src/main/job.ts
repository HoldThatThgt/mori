// Windows 作业对象（Job Object）：后台进程，以及它启动的所有进程（命令、pi 留下的孤儿进程，如 #9129），都在同一个作业里。
// 作业设为"最后一个句柄关闭时结束全部进程"：Mori 正常退出、后台进程意外退出时由 Mori 结束作业；
// Mori 自己被强行结束时，系统关闭句柄，作业里的进程也随之结束。所以关闭 Mori 后不会留下任何进程。
// Node 与 Electron 没有作业对象的接口，经 koffi 直接调用 kernel32。

import * as koffi from 'koffi';

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的信息类别号 */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
/** x64 上 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的大小 */
const EXTENDED_LIMIT_SIZE = 144;
/** LimitFlags 在结构里的偏移（两个 LARGE_INTEGER 之后） */
const LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

const kernel32 = koffi.load('kernel32.dll');
const CreateJobObjectW = kernel32.func('void* __stdcall CreateJobObjectW(void*, void*)');
const SetInformationJobObject = kernel32.func('bool __stdcall SetInformationJobObject(void*, int, void*, uint32_t)');
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32_t, bool, uint32_t)');
const AssignProcessToJobObject = kernel32.func('bool __stdcall AssignProcessToJobObject(void*, void*)');
const TerminateJobObject = kernel32.func('bool __stdcall TerminateJobObject(void*, uint32_t)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

/** @brief 一个装着后台进程的作业。 */
export interface ProcessJob {
  /** 结束作业里的全部进程并释放作业；重复调用无害 */
  terminate(): void;
}

/** @brief 调用失败时带上 Windows 错误码报错。 */
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`${what} failed (Windows error ${GetLastError()})`);
}

/** @brief 新建"句柄关闭即结束全部进程"的作业。 */
function createKillOnCloseJob(): unknown {
  const job = CreateJobObjectW(null, null);
  check(job, 'CreateJobObjectW');
  const info = Buffer.alloc(EXTENDED_LIMIT_SIZE);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  const ok = SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length);
  if (!ok) CloseHandle(job);
  check(ok, 'SetInformationJobObject');
  return job;
}

/**
 * @brief 把进程放进一个新作业。之后它启动的进程都自动在这个作业里（不允许脱离）。
 *        要在这个进程启动任何子进程之前调用。
 */
export function putInJob(pid: number): ProcessJob {
  const job = createKillOnCloseJob();
  const handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
  try {
    check(handle, 'OpenProcess');
    check(AssignProcessToJobObject(job, handle), 'AssignProcessToJobObject');
  } catch (error) {
    CloseHandle(job);
    throw error;
  } finally {
    if (handle) CloseHandle(handle);
  }
  let open = true;
  return {
    terminate() {
      if (!open) return;
      open = false;
      if (!TerminateJobObject(job, 1)) {
        console.error(`[main] TerminateJobObject failed (Windows error ${GetLastError()})`);
      }
      CloseHandle(job);
    },
  };
}
