// 回放界面测试的 Electron 入口：只开一个窗口载入回放页面，不启动后台进程。
// 环境变量：MORI_HARNESS_INDEX（构建好的 index.html）、MORI_HARNESS_DATA（独立的数据目录）。

const { app, BrowserWindow } = require('electron');

if (process.env.MORI_HARNESS_DATA) app.setPath('userData', process.env.MORI_HARNESS_DATA);

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  void window.loadFile(process.env.MORI_HARNESS_INDEX, { query: { fixture: 'readme' } });
});

app.on('window-all-closed', () => app.quit());
