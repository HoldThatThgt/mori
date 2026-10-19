// 预检：把 utilityProcess 放进 Windows 作业对象（KILL_ON_JOB_CLOSE），确认它留下的孤儿进程（父进程已被结束的 sleep，
// 与 pi #9129 同样的情形）能随作业一起结束。koffi 在 Electron 主进程里能否加载也在这里确认。
// 用法（在 app/ 下）：npx electron tests/prechecks/job-object/main.cjs
// Electron 主进程的输出在 Windows 上可能来不及写出，设 JOB_PRECHECK_OUT=<文件> 时结果同时写到文件。

const { app, utilityProcess } = require('electron');
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const koffi = require('koffi');

app.setPath('userData', mkdtempSync(join(tmpdir(), 'mori-job-precheck-')));
const out = process.env.JOB_PRECHECK_OUT;
const log = (...parts) => {
  const line = parts.join(' ');
  console.log(line);
  if (out) appendFileSync(out, `${line}\n`);
};
setTimeout(() => { log('RESULT timeout'); app.exit(1); }, 30000);

const kernel32 = koffi.load('kernel32.dll');
const CreateJobObjectW = kernel32.func('void* __stdcall CreateJobObjectW(void*, void*)');
const SetInformationJobObject = kernel32.func('bool __stdcall SetInformationJobObject(void*, int, void*, uint32_t)');
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32_t, bool, uint32_t)');
const AssignProcessToJobObject = kernel32.func('bool __stdcall AssignProcessToJobObject(void*, void*)');
const TerminateJobObject = kernel32.func('bool __stdcall TerminateJobObject(void*, uint32_t)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)');

const sleeps = () => execFileSync('tasklist', ['/FI', 'IMAGENAME eq sleep.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  .split('\n').filter((line) => line.toLowerCase().includes('sleep.exe')).length;

app.whenReady().then(async () => {
  const job = CreateJobObjectW(null, null);
  const info = Buffer.alloc(144);
  info.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  log('set limit', SetInformationJobObject(job, 9, info, info.length));
  const child = utilityProcess.fork(join(__dirname, 'child.cjs'));
  await new Promise((resolve) => child.once('spawn', resolve));
  const handle = OpenProcess(0x0101, false, child.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
  log('assign', AssignProcessToJobObject(job, handle), 'pid', child.pid);
  CloseHandle(handle);
  log('child says', JSON.stringify(await new Promise((resolve) => child.once('message', resolve))));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const orphaned = sleeps();
  log('terminate', TerminateJobObject(job, 1));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const left = sleeps();
  log(`RESULT orphaned sleep.exe before terminate: ${orphaned}; after: ${left}`);
  CloseHandle(job);
  app.exit(orphaned > 0 && left === 0 ? 0 : 1);
});
