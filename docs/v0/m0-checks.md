# M0 预检与走查记录

日期：2026-10-19。机器：Windows 11（10.0.26300），Node 24.19.0；Electron 44.9.0（内置 Node 24.22.0）；pi 1.3.0。
代码在 `app/`，冒烟测试是 `app/tests/ui/m0-smoke.mjs`，预检脚本在 `app/tests/prechecks/`。

## 依赖与镜像

- 本机无法与 `registry.npmjs.org` 建立 TLS 连接，`registry.npmmirror.com` 可用。
  `app/.npmrc` 改用 npmmirror，并锁定精确版本（`save-exact`）。
- Electron 二进制：开发时用环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 下载；
  打包时由 `electron-builder.yml` 的 `electronDownload.mirror` 指向同一镜像。
- electron-builder 的 NSIS 与 7zip 工具从 GitHub 下载，本机可以访问。
- 锁定的版本：electron 44.9.0、electron-vite 5.0.0、vite 7.3.7、@vitejs/plugin-react 5.2.0、electron-builder 26.17.0、
  @earendil-works/pi-coding-agent 1.3.0、react 19.3.1、zod 4.6.7、zustand 5.0.15、streamdown 2.7.1、
  @streamdown/code 2.0.0、shiki 4.5.0、@pierre/diffs 1.5.2、virtua 0.53.5、typescript 5.9.3、
  playwright-core 1.64.1（只用于测试，不下载浏览器）。
  TypeScript 没有用 npm 上标为 latest 的 7.0（原生重写版，太新），用 5.9.3。

## 预检结果

| 检查 | 结果 | 依据 |
| --- | --- | --- |
| ESM 入口能否在 utilityProcess 运行 | 能。`.mjs` 入口里静态 import pi 正常，报告 Node 24.22.0、pi 1.3.0 | `tests/prechecks/esm-utility/` |
| 当前实现的入口形式 | 后台进程入口构建为 CJS，在第一次用到时动态 `import()` pi；两种写法都可行 | `out/main/kernel.js` |
| asar 是否需要手工解包 | 不需要。electron-builder 自动把 pi-tui 的 `.node` 预编译文件和 quickjs-wasi 的 `quickjs.wasm` 放进 `app.asar.unpacked`（177 个文件，4.0 MB），打包后冒烟测试通过 | `dist/win-unpacked/resources` |
| 一个后台进程能否同时跑两个 pi 会话 | 能。两个会话同时生成，增量交替一百多次，各自完成一次读取；不需要每个会话一个进程 | 冒烟测试"同一后台进程并发两个会话" |
| pi 选用的 shell | `C:\Program Files\Git` 下的 Git Bash 5.3.15（MINGW64），没有设置 `shellPath` | 冒烟测试"pi 使用 Git Bash" |
| pi #9361（加载扩展时 shellPath 被忽略、落到 WSL bash） | 本机没有 WSL（`System32\bash.exe` 不存在），无法复现。公司机器如果装了 WSL，需要复查 | `wsl --status` |
| pi #9129（命令超时后留下孤儿进程） | **复现**。`sleep 30 \| cat` 设 2 秒超时：工具卡显示失败，但 `sleep.exe` 继续运行到自己结束。冒烟测试把它标为 KNOWN | 冒烟测试"命令超时后没有遗留 sleep 进程" |
| 界面依赖能否离线工作（方案第 3 节要求在 M0 确认） | 能。streamdown + @streamdown/code（shiki 用 JS 正则引擎，不需要 wasm）离线高亮代码块；@pierre/diffs 离线渲染编辑 diff（含 shiki 着色）；zustand 管理对话流，virtua 渲染列表。构建产物里没有 CDN 资源地址 | 冒烟测试"代码块由 shiki 高亮""编辑工具显示 diff"；`out/renderer` 扫描 |
| 对外网络连接 | 近似检查通过：每 0.3 秒用 netstat 采样 Mori 进程树的 TCP 连接，采到了到合成端点的回环连接（证明采样有效），没有任何对外连接。存在时间不足 0.3 秒的连接和 DNS 查询不在检查范围内 | `tests/ui/net-watch.mjs` |
| 打包体积 | 免安装目录约 475 MB（Electron 运行时约 369 MB，`app.asar` 约 107 MB）；NSIS 安装包 141 MB；未签名 | `dist/` |

关于 #9129：这是 pi 的问题。按 v0 的原则（pi 没有的先不补），运行中的超时不在 Mori 里绕过。
但退出 Mori 时，主进程会先让后台进程停止并释放所有会话，再结束整个进程树，所以命令留下的进程不会比 Mori 活得更久。
运行中超时留下的进程是否也要由 Mori 清理，需要你决定。

关于 streamdown 的样式：它用 Tailwind 类名上色，本项目没有 Tailwind。M0 用一条 CSS 规则读取它写在行内的颜色变量；
M1 移植 demo 视觉时，需要决定是引入 Tailwind，还是继续为它写少量对应样式。

## 冒烟测试覆盖的内容

脚本启动合成端点（`tests/fake-endpoint/server.mjs`，明确标为 synthetic，只用于验证管线），
再通过真实界面驱动 Mori。开发构建和打包后的 `Mori.exe` 都通过了全部检查（#9129 为 KNOWN）。
每次运行都用独立的临时数据目录，不碰 `%APPDATA%\Mori`。

1. 填错 key：测试连接显示错误原文 `401: {"message":"Incorrect API key provided",...}`。
2. key 写成 `$MORI_SMOKE_KEY`（pi 自带的环境变量写法）：测试连接成功。
3. 填 key 本身：测试连接成功，显示首字耗时。
4. 打开临时文件夹，发"总结 README"：流式文字出现，读取工具卡从执行中变为完成，内容是 README 原文。
5. 让它回复一段代码：代码块由 shiki 高亮。
6. 让它编辑 README：文件被修改，工具卡里显示 diff。
7. 让它运行 bash 命令：确认是 Git Bash。
8. 2 秒超时的命令：确认 #9129（KNOWN）。
9. 同一后台进程里同时创建两个会话并同时发消息：两边都结束、事件交替出现、各自调用一次工具。
10. 全程采样 TCP 连接：只有到合成端点的回环连接。
11. 命令运行中关闭窗口：程序 10 秒内自行退出，不弹错误框，运行中的命令进程被结束。
12. 结束后台进程：界面提示"后台进程意外退出"，请求立即失败而不是一直等待，刷新页面后提示仍在。

最近一次结果见 `app/test-results/m0-smoke.json`（该目录不提交）。

## 代码审查后的修正

M0 写完后做了一轮三路审查（正确性、方案符合度、安全与打包），已修正：

- 关闭窗口时主进程报错弹框、退出时不结束命令进程；现在有序关闭后台进程并结束整个进程树。
- 后台进程退出后请求一直等待；现在立即失败，刷新页面后仍显示提示。
- 保存连接后已打开的会话仍用旧配置；现在整个后台进程共用一个 ModelRuntime，保存后 `refresh()`，并写入 pi 的默认模型。
- 明文 key 原样写进 `models.json`，以 `!` 开头会被 pi 当作命令执行；现在按 pi 的语法转义，只有纯粹的 `$变量` 才当作引用。
- 只改服务地址、不重填 key 时会把旧 key 发给新地址；现在 origin 变了就必须重新填写。
- 保存会覆盖 provider 里手写的 compat、headers 等字段；现在合并保留。
- 推理模型只输出思考时测试连接会误报失败；现在思考也算收到回复，并有 30 秒超时。
- 窗口没有导航限制；现在禁止跳转、新窗口、webview 和权限申请，只有 Mori 自己的页面能拿到后台进程通道。
- 打包后的程序会读取开发服务器地址变量；现在只有开发构建读取，也不再传给后台进程。
- 补上方案要求的 `AGENTS.md`、`docs/v0/defaults.md`、静态检查（禁用词、行宽）和 `bindExtensions()`。

## M0 走查项的状态

| 走查项 | 状态 |
| --- | --- |
| 1. 外网机器构建安装包，内网机器离线安装并启动 | 安装包已构建（`app/dist/Mori Setup 0.0.1.exe`，未提交）；**内网安装待你验证** |
| 2. 填入真实端点，"测试连接"成功 | 合成端点已通过；**真实端点待你提供** |
| 3. "总结 README"：看到流式文字和一次读取 | 合成端点已通过；**真实模型待验证** |
| 4. 资源监视器"网络"页只出现配置端点的地址 | 近似检查已通过；**正式检查待你在目标机器上做** |
| 反例：端点不支持工具调用时先停下来商量 | 待真实端点 |

## 需要你提供

1. 第一个端点的服务地址（例如 `http://host:8000/v1`）和模型 ID。
2. API key：直接填在表单里（明文写入 `%APPDATA%\Mori\pi\models.json`），
   或者先设一个环境变量，在表单里写 `$变量名`。
3. 上下文长度（不填默认 128000）。
