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
M6：设置页（多个连接与模型、默认模型、思考强度（Effort）、用户级 AGENTS.md）、顶栏按会话换模型和思考强度、
工具页（Customize：内置工具、技能、MCP、插件）、输入框的"/"补全（[检查记录](../docs/v0/m6-checks.md)）。
当前处于 M7：工作回顾页（Review："Feedback"和"UI issues"两个列表、右栏详情与截图、标已处理（"Resolve"）与
"Hide resolved"、回到原位置、"Export as Markdown…"）与一键导出安装包（仓库根目录的 `build-installer.cmd`，见下）；
只差负责人走查（[检查记录](../docs/v0/m7-checks.md)）。
英文界面（`english-ui` 分支）：界面和 Mori 写出的文字（F8 报告、导出、操作记录、引用块）全部改为英文，有对应处照 Claude 桌面版的
用词（[术语表](../docs/v0/ui-strings.md)）；安装包只带英文界面；只差负责人走查（[检查记录](../docs/v0/english-ui-checks.md)）。

## 准备

需要 Node ≥ 22.19。本机访问不了 `registry.npmjs.org`，`.npmrc` 已改用 npmmirror。
Electron 二进制同样从镜像下载，安装依赖前先设环境变量：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

第一次运行 Electron 时，如果二进制还没下载，会按 `ELECTRON_MIRROR` 自动下载。

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
| `npm run test:m6-app` | M6 整机测试：真正的 Mori 对合成端点，设置页（连接与多个模型、默认模型、思考强度、AGENTS.md、离开时先问）与顶栏的模型和思考菜单（`m6-app-settings`）、工具页（内置工具、技能、MCP、插件，启停与 pi config 逐字比较）（`m6-app-tools`）、"/"补全与窄栏（`m6-app-slash`）、MCP 共享连接（`m6-app-mcp-shared`：每个服务一个进程、所有会话共用，运行目录、roots、并发、取消、崩溃重连、改配置、退出）；测打包结果分别加 `--exe …` |
| `npm run test:m6-replay` | M6 界面测试：回放 `tests/fixtures/m6/` 里从 DeepSeek 录下的 7 个场景 |
| `node tests/ui/m6-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M6 真实端点走查（走查 1–8 与反例） |
| `node tests/ui/m6-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m6/`（换模型、思考强度、AGENTS.md、项目技能、MCP、插件、"/"命令） |
| `node tests/ui/m6-pi-config.mjs [--check]` | 用 pi 自己的 `pi config` 组件录下启停的写法（`tests/fixtures/m6/pi-config-toggles.json`），M6 测试拿 Mori 的写入与它比较；`--check` 在 pi 升级时核对 |
| `node tests/ui/m6-mcp-cost.mjs [--servers N] [--exe …]` | 测量打开 1、5、10 个会话时 MCP 服务的进程数和内存（共享连接：每个服务始终 1 个进程） |
| `npm run test:m7-app` | M7 整机测试：真正的 Mori 对合成端点，工作回顾（入口、两个分节、一行摘要、读不出来的记录、右栏详情与放大截图、标已处理与"Hide resolved"、回到原位置的各种结果、导出为 Markdown、打开文件夹，反馈表单和 F8 报告框里的"View in Review"）；测打包结果加 `--exe …` |
| `node tests/ui/m7-record.mjs --source <走查数据目录> [--only …]` | 从真实会话录制 `tests/fixtures/m7/`（反馈这条回复、回复里的一句、阅读器里的两行和一份 F8 报告，重启后读记录和截图、回到原位置；回复不在了，其中指向会话里不存在的回复的那份反馈是 synthetic）；除了命令和事件，还录主进程读到的记录、截图、保存反馈和报告的结果；录下的不合要求时不写入，打印 FAIL |
| `npm run test:m7-replay` | M7 界面测试：回放 `tests/fixtures/m7/`，重启前后分两段（重启前在界面里写下反馈和 F8 报告，交给主进程的反馈与录制时逐字核对；重启后工作回顾的一行摘要、详情和截图，回到原位置的命令与高亮，回复不在了不发 `session.open`）；导出、打开文件夹没有录过，只核对界面交出去的记录名 |
| `node tests/ui/m7-real.mjs --source <走查数据目录> [--exe …] [--only …]` | M7 真实端点走查（走查 1–4 与反例）：在界面里写下反馈和 F8 报告，重启后都在工作回顾里、各自回到原位置，标已处理与"Hide resolved"（重启后还在），两类导出为 Markdown（保存对话框换成临时目录）；反例：在侧栏删掉的会话是"Session deleted"，回复不在了（指向会话里不存在的回复的那份反馈是 synthetic），导出不复制截图，工作回顾里的操作不发消息给模型；只删临时数据目录里的测试会话 |
| `npx electron tests/prechecks/esm-utility/main.cjs` | 预检：utilityProcess 能否运行 ESM 入口 |
| `npx electron tests/prechecks/job-object/main.cjs` | 预检：后台进程放进 Windows 作业对象后，它留下的孤儿进程能随作业一起结束 |
| `node tests/ui/m0-real.mjs --user-data <目录> [--setup]` | 真实端点走查（M0 走查 2–3）；`--setup` 先打开 Mori 让你填连接，脚本不接触 key |

## 数据位置

- pi 的配置与会话：`%APPDATA%\Mori\pi`（`models.json`、`sessions/`、`trust.json` 等，格式与 pi 命令行相同）。
  M6 起设置页和工具页直接读写这里的 `models.json`（连接与模型）、`settings.json`（默认模型、按模型的思考强度、技能 / 插件的启停，
  写法与 `pi config` 相同；停用项目自己的技能写项目的 `.pi/settings.json`）、`mcp.json`（MCP 服务）和 `AGENTS.md`（用户级）。
- 各会话的草稿（含引用芯片）、已归档的会话列表、栏宽和分屏比例、工作回顾的已处理标记和"Hide resolved"：
  Mori 窗口的本机存储（`localStorage`，在 `%APPDATA%\Mori` 下）。
  会话引用的来源（原会话、第几轮）写在发出它的会话文件里（pi 的自定义条目 `mori.ref`），原会话删除后引用时的原文仍在。
- 对内容的反馈：`%APPDATA%\Mori\feedback\*.json`，每份一个文件，只记录、不发给模型；F8 报告在 `%APPDATA%\Mori\ui-issues\`。
  M7 起工作回顾读这两个文件夹（只读不改）。界面问题的报告和截图都在 `ui-issues` 里，交给别人时把这个文件夹打成 zip，
  或用工作回顾的"Export as Markdown…"（只写一个 `.md`，截图链接指向原来的 PNG）。
  删除会话是永久的（照 Claude 桌面版）；想留着以后再看的会话用"Archive"（归档）。
- 测试时用环境变量 `MORI_USER_DATA` 指向临时目录，不会碰到日常使用的数据。

## 连接真实端点

在首次启动的"Connect a model"或设置页的"Connections and models"里填服务地址、API key 和模型 ID。
key 由 Mori 用系统加密（DPAPI）保存在 `%APPDATA%\Mori\credentials.json`，不写进 `models.json`，也不进环境变量；
启动时解密后只交给 pi 放在内存里，模型运行的命令读不到它。
