# Mori App

Windows 桌面 App。方案见 [../docs/app-v0.md](../docs/app-v0.md)，检查记录见 [../docs/v0/](../docs/v0/)
（[M0](../docs/v0/m0-checks.md)、[M1](../docs/v0/m1-checks.md)、[M2](../docs/v0/m2-checks.md)），
每屏的状态表见 [../docs/v0/screens/](../docs/v0/screens/)。
M1：三栏界面、首次启动连接表单、对话流与工具卡、阶段行、停止/排队/插话、错误与后台进程退出提示。
M2：批准卡与权限菜单、任务栏闪烁、F8 报告界面问题。
M3：左栏的项目 → 会话树、新建 / 打开 / 改名 / 归档 / 删除会话、右键菜单、会话状态、按会话保存草稿、项目信任询问、
扩展的询问；界面重新加载后接上还在运行的会话（[检查记录](../docs/v0/m3-checks.md)）。
M4：右栏的改动列表与只读文件阅读器、选区的"Attach as context"（问 Mori：引用芯片、回到原位置）与"Feedback"、
回复下的"Copy" / "Attach message as context" / "Give feedback"
（[检查记录](../docs/v0/m4-checks.md)）。
M5：左右分屏（拖会话到中栏、右键菜单、焦点所在的一栏、分屏中线）与会话引用（拖会话进输入框、按轮预览与调整范围、
发出后跳回原会话）（[检查记录](../docs/v0/m5-checks.md)）。
M6：设置页（多个连接与模型、默认模型、思考强度（Effort）、用户级 AGENTS.md）、输入框下面一行按会话换模型和思考强度（2026-10-21 前在顶栏）、
工具页（Customize：内置工具、技能、MCP、插件）、输入框的"/"补全（[检查记录](../docs/v0/m6-checks.md)）。
M7：工作回顾页（Review："Feedback"和"UI issues"两个列表、右栏详情与截图、标已处理（"Resolve"）与
"Hide resolved"、回到原位置、"Export as Markdown…"）与一键导出安装包（仓库根目录的 `build-installer.cmd`，见下）；
工作回顾页已由记忆页替换、不再走查，一键导出安装包只差负责人走查（[检查记录](../docs/v0/m7-checks.md)）。
英文界面（`english-ui` 分支）：界面和 Mori 写出的文字（F8 报告、导出、操作记录、引用块）全部改为英文，有对应处照 Claude 桌面版的
用词（[术语表](../docs/v0/ui-strings.md)）；安装包只带英文界面；只差负责人走查（[检查记录](../docs/v0/english-ui-checks.md)）。
输入框下面一行（`composer-pickers` 分支）：模型（选择范围）、Effort、只有文字的权限按钮和上下文用量圆环从顶栏移到文字框下面那一行，
顶栏只留会话名、协作开关和这一栏的按钮；只差负责人走查，以及认可有意跳过的 fixture 录制一步
（[检查记录](../docs/v0/composer-pickers-checks.md)）。
当前处于提示词分层与记忆（[规格](../docs/specs/memory.md)）：system prompt 的身份段与四个记忆分节、memory 工具、
记忆页（"Memory"，替换工作回顾）、每个项目的增强任务；反馈作为开了增强的项目的增强依据，F8 界面问题挪到设置页的"UI issues"
（[检查记录](../docs/v1/memory-checks.md)）。

## 准备

需要 Node ≥ 22.19。本机访问不了 `registry.npmjs.org`，`.npmrc` 已改用 npmmirror。
Electron 二进制同样从镜像下载，安装依赖前先设环境变量：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

第一次运行 Electron 时，如果二进制还没下载，会按 `ELECTRON_MIRROR` 自动下载。

### 随程序带的 rg.exe、fd.exe

`vendor/bin/` 里是 pi 的 `grep`、`find` 工具要的 ripgrep（`rg.exe`）与 fd（`fd.exe`），`vendor/licenses/` 是它们的许可
（2026-10-29，U76）。安装包把它们放进 `resources\bin`、`resources\licenses`（`electron-builder.yml` 的 `extraResources`），
主进程启动后台进程时把这个 `bin`（开发与测试的构建用 `vendor\bin`）放在 PATH 最前面。版本、下载地址、SHA-256 与换版本的步骤
见 [vendor/README.md](vendor/README.md)。`tests/ui/tb-build.mjs` 建的单独构建（`.tb-runs/<名字>`）也带一份 `vendor\bin`。

### 一键导出安装包

在资源管理器里双击仓库根目录的 [`build-installer.cmd`](../build-installer.cmd) 即可，只需装好 Node。它检查
Node ≥ 22.19，设好 Electron 与 electron-builder 工具（NSIS、7zip 等）的 npmmirror 镜像，在 `app/` 下运行 `npm ci`
（严格按 `package-lock.json` 安装）和 `npm run dist`，把 `dist/` 里的 `Mori Setup <版本>.exe` 复制到仓库根目录的
`release/`（同名的旧文件被替换；`release/` 不进 git），最后在资源管理器中打开它。
输出只用英文。哪一步失败就停在哪一步，写明是第几步和怎么处理（如 `[3/5] npm run dist failed.`），退出码是该步的编号；
窗口一直留着，按任意键关闭。打出的安装包只带英文的安装和卸载界面（`electron-builder.yml` 的 `installerLanguages`）。
`npm ci` 会重建 `app/node_modules`，运行前先关掉开发中的 Mori、正在跑的测试和占用该目录的编辑器。
自动化时加 `--no-open`（不打开资源管理器）和 `--no-pause`（结束时不等待按键）：

```powershell
cmd /c build-installer.cmd --no-open --no-pause
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式启动 |
| `npm run build` | 构建到 `out/` |
| `npm run typecheck` | 类型检查 |
| `npm run check` | 类型检查 + 静态检查（禁用词、行宽；`src/` 的字符串、正则、JSX 文本和 .html / .css 里不能有中文，注释不查）；`dist` 前会自动运行 |
| `npm run dist` | 构建 NSIS 安装包到 `dist/` |
| `..\build-installer.cmd` | 一键导出：`npm ci` + `npm run dist`，安装包复制到仓库根目录的 `release/`（见"一键导出安装包"） |
| `npm run dist:dir` | 构建免安装目录 `dist/win-unpacked/` |
| `npm run fake-endpoint` | 启动合成端点 `http://127.0.0.1:4319/v1`（模型 `fake-coder`，只用于测试） |
| `npm run smoke` | 构建后用合成端点跑 M0 冒烟测试；测打包结果用 `node tests/ui/m0-smoke.mjs --exe dist/win-unpacked/Mori.exe` |
| `npm run test:replay` | M1 界面测试：在 Electron 里载入界面，回放 `tests/fixtures/m1/` 里从真实会话录下的事件 |
| `npm run test:app` | M1 整机测试：真正的 Mori 对合成端点；测打包结果加 `--exe dist/win-unpacked/Mori.exe` |
| `node tests/ui/m1-real.mjs --source <走查数据目录> [--exe …]` | M1 真实端点走查（走查 1–10）；脚本只复制加密的 key，不读取它 |
| `node tests/ui/m1-record.mjs --source <走查数据目录>` | 从真实会话重新录制 `tests/fixtures/m1/` |
| `npm run test:m2-app` | M2 整机测试：真正的 Mori 对合成端点，批准卡、权限菜单、任务栏闪烁、F8；测打包结果加 `--exe …` |
| `node tests/ui/m2-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m2/`（批准相关的场景）；录下的不合要求时不写入，打印 FAIL |
| `npm run test:m2-replay` | M2 界面测试：回放 `tests/fixtures/m2/` |
| `node tests/ui/m2-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M2 真实端点走查（走查 1–8 与反例） |
| `npm run test:m3-app` | M3 整机测试：真正的 Mori 对合成端点，项目与会话树、键盘、改名、归档、删除、草稿、状态、项目信任、扩展的询问、界面重新加载；测打包结果加 `--exe …` |
| `node tests/ui/m3-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m3/`（项目、改名、删除、信任、后台生成、归档、界面重新加载后接上、扩展的询问） |
| `npm run test:m3-replay` | M3 界面测试：回放 `tests/fixtures/m3/` |
| `node tests/ui/m3-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M3 真实端点走查（走查 1–7、扩展的询问、界面重新加载与反例）；只删临时数据目录里的测试会话 |
| `npm run test:m4-app` | M4 整机测试：真正的 Mori 对合成端点，改动列表、文件阅读器、选区浮层、引用芯片与回到原位置、反馈、回复下的操作；测打包结果加 `--exe …` |
| `node tests/ui/m4-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m4/`（改两个文件、写入后删除、文件引用、重启后的引用、原文已变化、引用整轮回复、长回复） |
| `npm run test:m4-replay` | M4 界面测试：回放 `tests/fixtures/m4/`（带引用的消息连全文和 refs 一起核对） |
| `node tests/ui/m4-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M4 真实端点走查（走查 1–5 与反例） |
| `npm run test:m5-app` | M5 整机测试：真正的 Mori 对合成端点，分屏（菜单、拖放、焦点、Esc、F8、右栏、分屏中线、窄窗口、关闭一栏）与会话引用（拖放、菜单、键盘、预览、改范围、跳回、改名、重启、删除）；测打包结果加 `--exe …` |
| `node tests/ui/m5-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m5/`（两栏各自批准、只停一栏、引用第 3–5 轮、重启后的引用、引用正在生成的会话、超过 2 万字）；引用的全文用界面的代码算（esbuild 打包 `sessionRefs.ts`） |
| `npm run test:m5-replay` | M5 界面测试：回放 `tests/fixtures/m5/`（带会话引用的消息连全文和 refs 一起核对） |
| `node tests/ui/m5-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M5 真实端点走查（走查 1–6 与反例） |
| `npm run test:m6-app` | M6 整机测试：真正的 Mori 对合成端点，设置页（连接与多个模型、默认模型、思考强度、AGENTS.md、离开时先问）与输入框下面一行的模型和思考菜单（`m6-app-settings`）、工具页（内置工具、技能、MCP、插件，启停与 pi config 逐字比较）（`m6-app-tools`）、"/"补全与窄栏（`m6-app-slash`，各档的边界与拒绝启动在它启动的 `m6-app-bands`）、输入框下面一行的行为（圆环、生成中和切换中、菜单的位置和自动关、焦点，`m6-app-row`）、MCP 共享连接（`m6-app-mcp-shared`：每个服务一个进程、所有会话共用，运行目录、roots、并发、取消、崩溃重连、改配置、退出）；测打包结果分别加 `--exe …` |
| `npm run test:m6-replay` | M6 界面测试：回放 `tests/fixtures/m6/` 里从 DeepSeek 录下的 7 个场景 |
| `node tests/ui/m6-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M6 真实端点走查（走查 1–8 与反例） |
| `node tests/ui/m6-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m6/`（换模型、思考强度、AGENTS.md、项目技能、MCP、插件、"/"命令） |
| `node tests/ui/m6-pi-config.mjs [--check]` | 用 pi 自己的 `pi config` 组件录下启停的写法（`tests/fixtures/m6/pi-config-toggles.json`），M6 测试拿 Mori 的写入与它比较；`--check` 在 pi 升级时核对 |
| `node tests/ui/m6-mcp-cost.mjs [--servers N] [--exe …]` | 测量打开 1、5、10 个会话时 MCP 服务的进程数和内存（共享连接：每个服务始终 1 个进程） |
| `npm run test:mem-unit` | 记忆的单元测试（`node --test`，`tests/unit/memory/`） |
| `npm run test:memory` | 提示词分层与记忆的单元、App、回放测试和现有套件，最后检查规格 §14 的每一条都有通过的结果（工作回顾的 M7 套件已去掉，UI issues 与反馈的检查在这里） |
| `node tests/ui/mem-real.mjs --source <走查数据目录>` | 提示词分层与记忆的真实模型一层（DeepSeek 与 GLM，规格 §14.1）；脚本只复制加密的文件，不读 key |
| `npx electron tests/prechecks/esm-utility/main.cjs` | 预检：utilityProcess 能否运行 ESM 入口 |
| `npx electron tests/prechecks/job-object/main.cjs` | 预检：后台进程放进 Windows 作业对象后，它留下的孤儿进程能随作业一起结束 |
| `node tests/ui/m0-real.mjs --user-data <目录> [--setup]` | 真实端点走查（M0 走查 2–3）；`--setup` 先打开 Mori 让你填连接，脚本不接触 key |

## 数据位置

- pi 的配置与会话：`%APPDATA%\Mori\pi`（`models.json`、`sessions/`、`trust.json` 等，格式与 pi 命令行相同）。
  M6 起设置页和工具页直接读写这里的 `models.json`（连接与模型）、`settings.json`（默认模型、按模型的思考强度、技能 / 插件的启停，
  写法与 `pi config` 相同；停用项目自己的技能写项目的 `.pi/settings.json`）、`mcp.json`（MCP 服务）和 `AGENTS.md`（用户级）。
- 各会话的草稿（含引用芯片）、已归档的会话列表、栏宽和分屏比例、设置页"UI issues"的已处理标记和"Hide resolved"：
  Mori 窗口的本机存储（`localStorage`，在 `%APPDATA%\Mori` 下）。
  会话引用的来源（原会话、第几轮）写在发出它的会话文件里（pi 的自定义条目 `mori.ref`），原会话删除后引用时的原文仍在。
- 对内容的反馈：`%APPDATA%\Mori\feedback\*.json`，每份一个文件；开了增强的项目由增强任务作为依据读，没开的只保存。
  F8 报告在 `%APPDATA%\Mori\ui-issues\`，设置页的"UI issues"读这个文件夹（只读不改）。界面问题的报告和截图都在 `ui-issues` 里，
  交给别人时把这个文件夹打成 zip，或用"UI issues"的"Export as Markdown…"（只写一个 `.md`，截图链接指向原来的 PNG）。
  删除会话是永久的（照 Claude 桌面版）；想留着以后再看的会话用"Archive"（归档）。
- 记忆：`%APPDATA%\Mori\memory`（`user/` 用户级，`projects/--<编码后的工作目录>--/` 本项目：索引、`entries/` 条目、
  `revisions/` 修订记录、`enhance.json` 增强设置与水位、`sessions/` 增强任务的会话），只由 Mori 的记忆模块写，
  格式见[规格 §3](../docs/specs/memory.md)。不进仓库。
- 测试时用环境变量 `MORI_USER_DATA` 指向临时目录，不会碰到日常使用的数据。

## 连接真实端点

在首次启动的"Connect a model"或设置页的"Connections and models"里填服务地址、API key 和模型 ID。
key 由 Mori 用系统加密（DPAPI）保存在 `%APPDATA%\Mori\credentials.json`，不写进 `models.json`，也不进环境变量；
启动时解密后只交给 pi 放在内存里，模型运行的命令读不到它。
