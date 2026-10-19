// 预检用的子进程（utilityProcess）：启动一个 bash，bash 再启动 sleep；随后自己结束 bash，让 sleep 成为孤儿（类似 pi #9129）。
const { spawn, execFileSync } = require('node:child_process');

const bash = spawn('C:/Program Files/Git/bin/bash.exe', ['-c', 'sleep 120 | cat'], { stdio: 'ignore' });
bash.on('error', (error) => process.parentPort.postMessage({ error: error.message }));
setTimeout(() => {
  try {
    execFileSync('taskkill', ['/PID', String(bash.pid), '/F']);
  } catch (error) {
    process.parentPort.postMessage({ error: `taskkill: ${error.message}` });
  }
  process.parentPort.postMessage({ bash: bash.pid });
}, 1500);
setInterval(() => {}, 1000);
