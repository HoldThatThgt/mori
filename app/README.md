# Mori App

Windows 桌面 App。方案见 [../docs/app-v0.md](../docs/app-v0.md)，检查记录见 [../docs/v0/](../docs/v0/)
（[M0](../docs/v0/m0-checks.md)、[M1](../docs/v0/m1-checks.md)），每屏的状态表见 [../docs/v0/screens/](../docs/v0/screens/)。
当前处于 M1：三栏界面、首次启动连接表单、对话流与工具卡、阶段行、停止/排队/插话、错误与后台进程退出提示。

## 准备

需要 Node ≥ 22.19。本机访问不了 `registry.npmjs.org`，`.npmrc` 已改用 npmmirror。
Electron 二进制同样从镜像下载，安装依赖前先设环境变量：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

第一次运行 Electron 时，如果二进制还没下载，会按 `ELECTRON_MIRROR` 自动下载。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式启动 |
| `npm run build` | 构建到 `out/` |
| `npm run typecheck` | 类型检查 |
| `npm run check` | 类型检查 + 静态检查（禁用词、行宽）；`dist` 前会自动运行 |
| `npm run dist` | 构建 NSIS 安装包到 `dist/` |
| `npm run dist:dir` | 构建免安装目录 `dist/win-unpacked/` |
| `npm run fake-endpoint` | 启动合成端点 `http://127.0.0.1:4319/v1`（模型 `fake-coder`，只用于测试） |
| `npm run smoke` | 构建后用合成端点跑 M0 冒烟测试；测打包结果用 `node tests/ui/m0-smoke.mjs --exe dist/win-unpacked/Mori.exe` |
| `npm run test:replay` | M1 界面测试：在 Electron 里载入界面，回放 `tests/fixtures/m1/` 里从真实会话录下的事件 |
| `npm run test:app` | M1 整机测试：真正的 Mori 对合成端点；测打包结果加 `--exe dist/win-unpacked/Mori.exe` |
| `node tests/ui/m1-real.mjs --source <走查数据目录> [--exe …]` | M1 真实端点走查（走查 1–10）；脚本只复制加密的 key，不读取它 |
| `node tests/ui/m1-record.mjs --source <走查数据目录>` | 从真实会话重新录制 `tests/fixtures/m1/` |
| `npx electron tests/prechecks/esm-utility/main.cjs` | 预检：utilityProcess 能否运行 ESM 入口 |
| `node tests/ui/m0-real.mjs --user-data <目录> [--setup]` | 真实端点走查（M0 走查 2–3）；`--setup` 先打开 Mori 让你填连接，脚本不接触 key |

## 数据位置

- pi 的配置与会话：`%APPDATA%\Mori\pi`（`models.json`、`sessions/` 等，格式与 pi 命令行相同）。
- 测试时用环境变量 `MORI_USER_DATA` 指向临时目录，不会碰到日常使用的数据。

## 连接真实端点

在"连接"里填服务地址、API key 和模型 ID。key 由 Mori 用系统加密（DPAPI）保存在 `%APPDATA%\Mori\credentials.json`，
不写进 `models.json`，也不进环境变量；启动时解密后只交给 pi 放在内存里，模型运行的命令读不到它。
