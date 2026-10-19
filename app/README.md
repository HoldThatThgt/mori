# Mori App

Windows 桌面 App。方案见 [../docs/app-v0.md](../docs/app-v0.md)，M0 的检查记录见 [../docs/v0/m0-checks.md](../docs/v0/m0-checks.md)。
当前处于 M0：Electron 外壳、pi 后台进程、进程桥和离线安装包，界面是一个临时的最简对话窗口，M1 会替换它。

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
| `npm run smoke` | 构建后用合成端点跑冒烟测试；测打包结果用 `node tests/ui/m0-smoke.mjs --exe dist/win-unpacked/Mori.exe` |
| `npx electron tests/prechecks/esm-utility/main.cjs` | 预检：utilityProcess 能否运行 ESM 入口 |

## 数据位置

- pi 的配置与会话：`%APPDATA%\Mori\pi`（`models.json`、`sessions/` 等，格式与 pi 命令行相同）。
- 测试时用环境变量 `MORI_USER_DATA` 指向临时目录，不会碰到日常使用的数据。

## 连接真实端点

在"连接"里填服务地址、模型 ID 和 API key。API key 可以填 key 本身（明文保存在 `models.json`），
也可以填 `$环境变量名`，由 pi 在请求时读取。
