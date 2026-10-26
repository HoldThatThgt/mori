// 预检：utilityProcess 能否直接运行 ESM 入口（.mjs），并在其中静态 import pi。
// 用法：npx electron tests/prechecks/esm-utility/main.cjs
const { app, utilityProcess } = require('electron');
const { join } = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');

// 数据放到临时目录，不在 %APPDATA% 下留下 Electron 目录。
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mori-esm-precheck-')));

app.whenReady().then(() => {
  const child = utilityProcess.fork(join(__dirname, 'child.mjs'), [], {
    stdio: 'inherit',
    env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
  });
  const timer = setTimeout(() => { console.log('RESULT timeout'); app.exit(1); }, 30000);
  child.on('message', (message) => {
    console.log(`RESULT ${JSON.stringify(message)}`);
    clearTimeout(timer);
    app.exit(0);
  });
  child.on('exit', (code) => { console.log(`child exited ${code}`); });
});
