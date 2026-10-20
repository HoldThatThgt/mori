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
2. 填正确的 key：测试连接成功，显示首个增量的耗时。
3. key 加密保存：`models.json` 里没有 `apiKey` 字段，`credentials.json` 里只有密文。
4. 改了服务地址（origin 变化）却没有重填 key：拒绝保存。
5. 打开临时文件夹，发"总结 README"：流式文字出现，读取工具卡从执行中变为完成，内容是 README 原文。
6. 让它回复一段代码：代码块由 shiki 高亮。
7. 让它编辑 README：文件被修改，工具卡里显示 diff。
8. 让它运行 bash 命令：确认是 Git Bash。
9. 让它运行 `env`：命令读得到 Mori 进程环境里的对照变量，读不到 key。
10. 2 秒超时的命令：确认 #9129（KNOWN）。
11. 同一后台进程里同时创建两个会话并同时发消息：两边都结束、事件交替出现、各自调用一次工具。
12. 全程采样 TCP 连接：只有到合成端点的回环连接。
13. 命令运行中关闭窗口：程序 10 秒内自行退出，不弹错误框，运行中的命令进程被结束。
14. 重新启动 Mori：不用重填 key，测试连接成功，key 输入框提示"已加密保存"。
15. 结束后台进程：界面提示"后台进程意外退出"，请求立即失败而不是一直等待，刷新页面后提示仍在。

最近一次结果见 `app/test-results/m0-smoke.json`（该目录不提交）。

## 代码审查后的修正

M0 写完后做了一轮三路审查（正确性、方案符合度、安全与打包），已修正：

- 关闭窗口时主进程报错弹框、退出时不结束命令进程；现在有序关闭后台进程并结束整个进程树。
- 后台进程退出后请求一直等待；现在立即失败，刷新页面后仍显示提示。
- 保存连接后已打开的会话仍用旧配置；现在整个后台进程共用一个 ModelRuntime，保存后 `refresh()`，并写入 pi 的默认模型。
- 明文 key 原样写进 `models.json`，以 `!` 开头会被 pi 当作命令执行；后来按你的决定，key 完全不进 `models.json`（见下一节）。
- 只改服务地址、不重填 key 时会把旧 key 发给新地址；现在 origin 变了就必须重新填写。
- 保存会覆盖 provider 里手写的 compat、headers 等字段；现在合并保留。
- 推理模型只输出思考时测试连接会误报失败；现在思考也算收到回复，并有 30 秒超时。
- 窗口没有导航限制；现在禁止跳转、新窗口、webview 和权限申请，只有 Mori 自己的页面能拿到后台进程通道。
- 打包后的程序会读取开发服务器地址变量；现在只有开发构建读取，也不再传给后台进程。
- 补上方案要求的 `AGENTS.md`、`docs/v0/defaults.md`、静态检查（禁用词、行宽）和 `bindExtensions()`。

## API key 的保存方式（2026-10-19 按你的决定修改）

Mori 是桌面 App，不再用环境变量传 key，也不支持 `$环境变量名` 写法：

- 你在连接表单里填 key，保存时由主进程用 Electron safeStorage 加密（Windows 上是 DPAPI，绑定当前用户），
  写进 `%APPDATA%\Mori\credentials.json`。系统加密不可用时直接报错，不退回明文。
- Mori 启动时解密，经进程通道交给后台进程，后台进程用 pi 的 `setRuntimeApiKey` 只放在内存里。
  pi 不会对这种 key 做 `$`、`!` 的语法解析，所以 key 里有什么字符都按原样使用。
- key 不进 `models.json`（保存时会去掉旧的 `apiKey` 字段），也不进任何进程的环境变量，
  所以模型运行的命令读不到它。冒烟测试第 3、9、14 项分别验证了加密保存、命令读不到、重启后可用。
- 界面不回显 key：输入框是密码框，保存后清空，只提示"已加密保存"。

## 真实端点走查（DeepSeek 公网端点，开发期替代内网端点）

2026-10-19 用打包后的 `Mori.exe` 跑 `app/tests/ui/m0-real.mjs`，两个模型的全部检查都通过。

- **端点**：`https://api.deepseek.com`（与 pi 内置 DeepSeek provider 的地址相同），接口类型 OpenAI 兼容（chat completions）。
  用这个 key 调 `/models` 返回 `deepseek-flash` 和 `deepseek-v4-pro`（与 pi 目录里 DeepSeek 的两个模型一致），两个都测了；
  上下文长度填 1000000（pi 目录中的值，脚本结果里有记录）。
- **key 的处理（这次走查时）**：这次走查发生在上一节的修改之前，用的还是 `$变量名` 方式：
  env 文件在仓库外（变量名 `DEEPSEEK_NODE_KEYS`），走查脚本只把这一个变量载入 Mori 的进程环境，`models.json` 里只有 `$DEEPSEEK_NODE_KEYS`。
  事后扫描工作区、测试结果、临时数据目录和草稿，没有 key 原文。
- **改为加密保存之后**：已重跑，见下面"用加密保存的 key 重跑"。

| 检查 | deepseek-flash | deepseek-v4-pro |
| --- | --- | --- |
| 走查 2：测试连接 | 成功；首个增量（含思考）702 ms，共 1022 ms | 成功；首个增量（含思考）1097 ms，共 1749 ms |
| 走查 3：一次读取（原生工具调用） | 通过，3.4 秒：`bash`（`ls -la`）→ `bash`（`find` README）→ `read README.md`，均完成；思考 1 段 | 通过，6.0 秒：`bash`（`ls -la && find`）→ `read README.md`，均完成；思考 1 段 |
| 走查 3：回复是流式出现的 | 本轮采样到 5 种不同的回复长度 | 12 种 |
| 阶段文字（每 100 ms 采样，变化才记录） | 等待模型响应 → 生成中 → 准备调用 bash → 运行 bash → 等待模型响应 → 生成中 → 等待模型响应 → 生成中 | 等待模型响应 → 生成中 → 准备调用 bash → 运行 bash → 等待模型响应 → 生成中 → 准备调用 read → 等待模型响应 → 生成中 |
| 第二轮对话（请求里带上一轮的思考与工具结果） | 无错误，1.4 秒 | 无错误，0.8 秒 |
| 对外连接（近似检查） | 只有 `198.18.0.89:443` | 同左 |

采样有间隔，很短的阶段（例如"运行 read"）可能没被采到。原生工具调用的依据：工具卡只由 pi 的工具执行事件产生，
pi 也没有从正文里解析工具调用的机制，所以出现工具卡就说明模型返回了结构化的工具调用。

**兼容设置**：不需要手工设置，但实际生效的只有一部分。

- pi 发现服务地址里有 `deepseek.com` 时会自动检测出 DeepSeek 的兼容设置。
  Mori 的连接表单不写 `reasoning: true`，pi 因此按不支持思考的模型处理，这时真正改变请求的只有两项：不发 `store`、用 `max_tokens` 字段。
- `thinkingFormat: "deepseek"` 和"在助手消息里补空的 `reasoning_content`"都只在 `reasoning: true` 时才起作用，这次没有生效。
- 第二轮对话能带上上一轮的思考，是因为 pi 会把流式收到的 `reasoning_content` 原样放回历史消息，这与兼容设置和地址检测无关。
  这次只确认了第二轮没有报错，没有抓取请求内容。
- 自动检测出的设置只是 pi 内置 DeepSeek provider 的一部分：内置配置还有 `reasoning: true`、思考强度映射、strict 模式，
  `deepseek-flash` 支持图片输入；Mori 的配置是纯文本输入、默认最大输出 16384。
- 内网端点：如果它拒绝 `store` 或 `max_completion_tokens`，在 `models.json` 的 `compat` 里写
  `supportsStore: false` 或 `maxTokensField: "max_tokens"`（Mori 保存连接时会保留这些字段）。
  与思考有关的兼容设置要同时加 `reasoning: true` 才有意义。

**留意的几点**：

- DeepSeek 服务端默认开启思考，所以仍然收到了思考内容，但"思考强度"无法从 Mori 控制。M6 设置页需要决定是否提供这个选项。
- 用 `$变量名` 保存 key 时，这个环境变量会被 pi 的命令工具继承，模型运行的每条命令都能读到它。
  这个问题已经随"API key 的保存方式"一节的修改消除：key 不再进任何环境变量。
- `api.deepseek.com` 在本机解析为 `198.18.0.89`。198.18.0.0/15 通常是代理软件的虚拟地址，
  所以这次网络检查只能说明 Mori 只连了这个端点对应的地址，看不到代理之后的真实去向。

## 用加密保存的 key 重跑（2026-10-19）

你在 `m0-real.mjs --setup` 打开的打包版 Mori 里填了 DeepSeek 的连接（`deepseek-flash`），key 由 Mori 加密保存；
随后脚本用同一个测试数据目录（`%TEMP%\mori-real-data`）走查，脚本本身不接触 key。全部通过：

| 检查 | 结果 |
| --- | --- |
| `models.json` 里没有 key | 通过（没有 `apiKey` 字段；`credentials.json` 只有 `mori-endpoint` 一项密文） |
| 走查 2：测试连接（不重填 key） | 成功；首个增量（含思考）947 ms，共 1305 ms |
| 走查 3：一次读取（原生工具调用） | 通过，3.4 秒：`bash`（`ls -la; find README`）→ `read README.md`，均完成；思考 1 段 |
| 走查 3：回复是流式出现的 | 采样到 6 种不同的回复长度 |
| 第二轮对话 | 无错误，0.85 秒 |
| 对外连接（近似检查） | 只有 `198.18.0.89:443` |

**发现的问题与修正**：你第一次点"测试连接"时看到"No default model configured"。
测试数据目录里连接、默认模型和加密的 key 都已保存，所以那次是在"保存"完成之前点了"测试连接"；
这条错误也写得含糊，把"还没保存"和"找不到模型"混在一起。已修正：

- 还没保存过连接时，"测试连接"按钮不可用；冒烟测试新增了这一项。
- 后台进程分开报告"No connection saved yet; save the connection first"和"Model … not found in models.json"。

修正后重新打包，冒烟测试与这次真实端点走查又各跑了一遍，全部通过（首个增量 909 ms，走查 3 用时 4.0 秒）。

测试数据目录里有你填的连接和加密的 key（只能由你的 Windows 账户解密）和走查留下的会话记录；不再需要时可以直接删除。

## M0 走查项的状态

| 走查项 | 状态 |
| --- | --- |
| 1. 外网机器构建安装包，内网机器离线安装并启动 | 安装包已构建（`app/dist/Mori Setup 0.0.1.exe`，未提交）。**负责人决定推迟到 M7 完成之后**（2026-10-20 由 M6 之后改为 M7 之后）（内网机器目前无法从这台设备访问） |
| 2. 填入真实端点，"测试连接"成功 | **通过**（DeepSeek 公网端点作为开发期替代，两个模型） |
| 3. "总结 README"：看到流式文字和一次读取 | **通过**（同上；流式输出与原生工具调用都已确认） |
| 4. 资源监视器"网络"页只出现配置端点的地址 | 近似检查已通过。**负责人决定推迟到 M7 完成之后**（2026-10-20 由 M6 之后改为 M7 之后），在内网机器上做正式检查 |
| 反例：端点不支持工具调用时先停下来商量 | DeepSeek 端点支持原生工具调用；内网端点未测，M7 之后复查 |

## 之后可以做的

1. 以后要再跑一次走查 2–3（例如换模型），在 `app/` 下运行

   ```powershell
   node tests/ui/m0-real.mjs --user-data $env:TEMP\mori-real-data --setup --exe dist\win-unpacked\Mori.exe
   node tests/ui/m0-real.mjs --user-data $env:TEMP\mori-real-data --exe dist\win-unpacked\Mori.exe
   ```

   第一条会打开 Mori：填服务地址、key、模型 ID，先保存再测试，然后关闭窗口；第二条自动走查。
   已经填过的数据目录可以跳过第一条。
2. 内网机器可用时（M7 之后），在内网机器上做走查 1 和 4，再用同样的方式对内网端点跑一次走查 2–3。
