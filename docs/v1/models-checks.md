# 模型层检查记录

依据：[统一模型提供商 Proposal](../proposals/model-providers.md) 第四版、[构建规格](../specs/model-providers.md)。
日期：2026-10-21。机器：Windows 11（10.0.28000），Node 24.19.0；Electron 44.9.0；pi 1.3.0。分支 `v1-model-providers`（基于 `app-v0` 的 `12f2326`，即 M7 合并之后）。

## 状态

按 AGENTS.md 的完成顺序（规格与状态表 → 真实会话录 fixture → 界面测试 → 实现 → 真实模型走一遍 → 你走查），只差你走查。已提交到 `v1-model-providers` 并合并进 `app-v0`（本地，没有推送）。
真实端点：DeepSeek（`deepseek-flash`，从 v0 迁移来，区域 Public）与 GLM（`GLM-5.3`，`api.z.ai` 的 Anthropic 接口，区域 Public），key 由你在 Mori 里保存；
脚本只复制加密的文件，不读 key；录下的 fixture 和结果文件里没有 key（32 个文件已扫描）。

结果一览（2026-10-21，开发构建与打包程序 `dist/win-unpacked/Mori.exe` 各跑一遍）：

| 层 | 开发构建 | 打包程序 |
| --- | --- | --- |
| 单元（`npm run test:unit`） | 373/373 | —（与构建无关） |
| App：`v1-models-app-settings` / `-switch` / `-session` | 140/140、78/78、113/113 | 140/140、78/78、113/113 |
| 回放（`v1-models-replay.mjs`，fixture 从真实会话录制） | 35/35 | —（回放不分构建） |
| 真实（MP-27，`v1-models-real.mjs`，DeepSeek + GLM） | 10/10 | 10/10 |
| 现有测试（MP-37，`v1-models-existing.mjs`） | 18 个套件一次连续跑全部通过 | 11 个 App 套件全部通过 |
| 覆盖检查（`spec-coverage.mjs`、`--packaged`，不带 `--allow-missing-real`） | 退出码 0 | 退出码 0 |

真实模型的表现（`v1-models-record.mjs`、`v1-models-real.mjs`）：

- 探针：DeepSeek 工具调用已验证；指定调用与 JSON schema 被它拒绝（400：“Thinking mode does not support this tool_choice”“This response_format type is unavailable”），文本标签通过，交接写入等级 C；推理字段 `reasoning_content`。
  GLM 工具调用已验证；指定调用没被执行，文本标签通过，等级 C；推理为接口原生，可以关闭思考，不需要回传推理。
- 段开始时换模型：DeepSeek 的 key 换成错的后，第一个请求得到真实的 401，对话流一行“Switched model: mori-endpoint/deepseek-flash → glm/GLM-5.3 · API key rejected”，没有错误卡。
- 段内换模型：DeepSeek 读了第一个文件后 key 失效，GLM 重做整个回复（逐个读 5 个文件再总结），提示加“The new model redoes this reply.”；DeepSeek 已做的部分仍在对话里显示，但没有发给 GLM。
- 回到首选：恢复 key、重新启动后，下一段回到 DeepSeek，之前的换模型提示仍在。

## 你走查时看什么

用你的数据目录打开（`node tests/ui/m0-real.mjs --user-data <目录> --setup`，或装好的新版）：

1. 设置 → Models：两个提供商的卡片、key 行（Saved、Test）、模型行的档案摘要（Tool calling Verified、Handoff tier C、Reasoning field）。
2. 新建一个分组（例如 GLM 在前、DeepSeek 在后），设为新会话的默认范围；新会话顶栏显示“<分组> · <当前模型>”。
3. 在没有授权公网的新项目里发消息：输入框上方出现拒绝启动卡；“Allow public for this project…”带你到 Project access，确认后可以发送。
4. 顶栏的范围菜单：分组、提供商、模型三节；选一个提供商或模型后下一条消息由它回答；重新打开会话后范围不变。
5. 把首选的 key 删掉、加一个错的（例如 `sk-invalid`）：下一条消息出现“Switched model: … · API key rejected”，没有错误卡；把对的 key 加回来、删掉错的，再发一条，回到首选。
6. 在一个要连续读好几个文件的回复进行中做第 5 条：出现“The new model redoes this reply.”，之前的工具卡还在。
7. 生成中顶栏的范围和思考按钮都不可用；Esc 或停止按钮能停在“准备中”（消息回到输入框）。
8. 按 F8 存一份报告：最近的操作里只有“Add key <提供商>”，没有 key。

## 你决定的（2026-10-21）

| 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- |
| proposal 里依赖平行 Agent 与 TaskBoard 的部分怎么办 | 现在只做模型层；依赖 TaskBoard 的部分写进 TaskBoard 规格，随它实现 | 规格 §0 的范围、§10 列出交给那份规格的规则 |
| 新界面的文字 | 英文 | 规格新增和改写的界面用英文；没改到的旧界面仍是中文 |
| 真实走查用哪些端点 | `D:\code` 下三个 env 文件对应的端点都可以用（DeepSeek、GLM、OpenRouter，都是公网） | 走查用 DeepSeek 与 GLM 两个真实提供商，加合成端点制造限流和故障；key 由你在 Mori 里保存，脚本不读 key |
| 模型管理的结构 | 分组 — 提供商 — 模型三层；分组可以有多个提供商，提供商可以在多个分组里；一个提供商可以有多个 key、多个模型；分组也可以只挑提供商下的某个模型 | proposal 第四版 §1、§4；规格 §4.1 |
| 谁来选模型 | 普通模式下你为主 Agent 选分组、提供商或模型，子 Agent 只能在你选的范围里选；协作模式下你不选，按 task 设置选 | proposal §5；规格 §5.1，子 Agent 与协作模式在 §10 |
| 分组与别名 | 分组取代第三版的别名 | proposal 第四版不再有别名 |
| 范围里按什么顺序选 | 按列出的顺序：分组里各项的顺序，再按提供商里的模型顺序 | 规格 §5.1 |
| 多个 key 怎么分 | 按顺序填：用第一个有空位的 key，被限流或被拒绝的 key 跳过，全部不可用才算提供商不可用 | 规格 §8 |
| 普通模式一次回复中途换模型 | 重做这次回复：中断的部分留在对话里，但不交给新模型 | proposal 7.3；规格 §5.6、§6.1 |

我替你定的（你说“按推荐的选，最后列出来”，走查时都可以改）：

1. 主 Agent 固定要求“工具调用已验证”：新加的模型要等后台探针通过（约半分钟）才能用。
2. 公网只能按项目授权，不能在“所有项目默认允许的区域”里勾选（proposal §12 第 2 条）。
3. 模型 id 建好后不能改（沿用 v0），要换就删掉再加。
4. 探针第 5、6 步服务端回 400 或 422 算“不支持”（判定为不通过），401、408、429、5xx、连接错误算“没验证成”。
5. 探针没跑完就关了 App 的模型，下次启动自动重新探测；加 key、删 key 后，没验证过的模型自动重新探测。
6. 编辑推理模型时，没设过的新会话默认强度显示为 Medium，只有你改了才写入（不悄悄钉死）。
7. 状态表里规格没给的界面小字（加载、空状态、按钮、对话框标题、校验文字）先按表里的英文写，标了“临时”。
8. 合并：先把本分支合并进 `app-v0`（`--no-ff`，本地，不推送）；`english-ui`、`composer-pickers` 之后合并 `app-v0` 时，要把顶栏的范围菜单搬进输入框下面那一行、把 thinking 的说法改成 Effort。
9. 另一个会话已把本分支 19:05 时的状态提交为 `90bacba`（它的 `v1-taskboard` 基于它），所以没有压成一个提交，之后的改动另起一个提交。

## 开工前查的 pi 行为（对照 pi 1.3.0 源码，并用脚本对合成端点实测）

脚本放在会话的临时目录，没有进仓库；每一条的结论写进了规格 §11.5。

| 项 | 规格编号 | 怎么查的 | 结果 |
| --- | --- | --- | --- |
| 虚拟模型 `route()` | K3 | 每个会话注册一个虚拟模型，跑带工具调用的回复、运行中插话、关掉再按文件重新打开 | 每次请求前调用；不带会话身份；插话后的请求原因是 `user`，工具循环是 `continuation`；助手消息记实际模型；重新打开时注册同一个 id 即恢复 |
| 流函数包装 | K2 | 替换 `session.agent.streamFunction`，每次请求轮换两个合成 key，包装里等 1 秒 | 每次助手请求调用一次，模型是路由后的实际模型；`apiKey`、`fetch` 选项被采用；等待不影响后续；pi 在运行开始时取流函数 |
| 自定义 fetch | K1 | 合成端点回 429 + `Retry-After: 7` | fetch 看得到状态和 `Retry-After`；pi 转成的报错文字里没有 `Retry-After`；OpenAI SDK 读到 `[DONE]` 后取消响应体 |
| 关掉 agent 级重试 | K6 | `applyOverrides({ retry: { enabled: false } })` | 429 只发一次，没有 `auto_retry_start`；`resourceLoader.reload()`、`settingsManager.reload()` 和带 `persist` 的设置会清掉覆盖 |
| `context` 事件 | K4 | 去掉工具调用和结果、加一条用户消息 | 只影响发出的请求，会话文件不变 |
| 压缩 | K5 | 会话模型是虚拟模型时 `session.compact()` | 先以 `direct` 调 `route()`；用会话的流函数发出（经包装），压缩请求的 `sessionId` 与会话 id 不同 |
| 中止 | K7 | 慢速流式回复中 `session.abort()` | fetch 的 signal 同一刻触发，服务端几十毫秒内看到连接关闭；已收到的部分保留 |
| 后台调用 | K8、K10 | `streamSimple` 带指定函数的 `tool_choice`、`onPayload` 加 `response_format` | 原样发出；工具的 `strict` 只在 `supportsStrictMode` 为真时发出；把虚拟模型交给 `streamSimple` 时调用方的 key 被丢掉 |
| 没有 key 的提供商 | K1 | `registerProvider` 不带 `apiKey` / 带占位 `apiKey` | 不带时 pi 不算“已配置”；带占位就算，SDK 发 `Authorization: Bearer <占位>`，由 Mori 的 fetch 改写 |
| 注册与刷新 | K9 | `registerProvider` 之后马上设 key | pi 自己发起的刷新不等待、会互相覆盖；注册后 `await runtime.refresh()` 就稳定 |
| 推理内容回传 | — | 目标模型 `requiresReasoningContentOnAssistantMessages`，历史里有别的模型的工具调用 | 别的模型的思考被丢掉，助手消息补 `reasoning_content: ""` |
| SDK 超时覆盖整个 fetch 调用 | K11 | 设置里 `timeoutMs` 1.5 秒，自定义 fetch 先睡 3 秒 | 报“Request timed out.”；包装传 `timeoutMs: 2147483647` 后成功 |
| 压缩前去掉被隐藏的过程 | K12 | `session_before_compact` 里就地删掉带工具调用的助手消息和对应结果，不返回结果 | 摘要请求里没有这些调用；`fileOps` 要一起清，否则摘要末尾仍列出读过的文件 |
| 排队消息先发 `message_start` 再路由 | K13 | 工具循环中排一条 followUp、一条 steer，扩展的 `message_start` 处理器等 300 毫秒 | 两种都先发 `message_start` 并等处理器结束，再调 `route()`；时间戳是排队的时刻；`agent_settled` 每次运行一次，`prompt()` 在运行前抛错时没有 |

## 交付了什么

- 文档：proposal 第四版、构建规格（经三轮评审）、`docs/v1/screens/` 四张状态表、`docs/v1/defaults.md`、本记录；app-v0、AGENTS.md、两份旧 proposal 加了注明。
- 后台进程（`app/src/kernel/`）：`modelConfig`、`modelMigrate`、`modelCompile`、`modelLayer`、`modelCommands`、`selector`、`modelContext`、`modelSession`、`modelPool`、`modelFailure`、`modelProfiles`、`probes`、`modelTimings`、`modelTypes`；
  改写 `pi.ts`、`config.ts`、`sessions.ts`、`commands.ts`、`credentials.ts`、`index.ts`；主进程按 `ref` 存 key。
- 进程桥：`shared/models.ts`（配置 schema、命令、事件、原因文字、区域建议），`shared/protocol.ts` 去掉 v0 的连接与模型命令。
- 界面：设置页 Models 分节（`components/settings/`）、英文的首次启动表单、顶栏的范围菜单、换模型与重建提示、阶段行、拒绝启动卡、没有可用模型卡、准备中；删掉 v0 的连接表单、`SETTINGS_HINT`、`modelNotice`。
- 测试：`tests/unit/`（单元）、扩展的合成端点（`tests/fake-endpoint/`）、三个 App 测试、回放与录制与真实走查脚本、`spec-coverage.mjs`、`v1-models-existing.mjs`；现有 m0–m7 的测试、回放夹具与真实脚本按规格 §14.4 改好。
- 依赖：`@earendil-works/pi-ai` 1.3.0（原本就随 pi 安装）、`esbuild` 0.25.12（原本就随 vite 安装），都锁精确版本、离线可用。

## 与规格不同、或需要你注意的地方

1. 模型 id 建好后不能改（沿用 v0）；要换 id 就删掉再加。
2. 编辑一个没设过新会话默认强度的推理模型时，表单显示“Medium”，但只有你改了强度或“支持思考”时才写入 pi 设置（不悄悄钉死）。
3. 换了模型的那一条助手消息上，pi 记的思考强度仍是路由时为原模型收紧的值（pi 的已知限制，规格 §11.2）。
4. 准备中重新载入界面后，准备中又发的消息显示在排队区里，撤回时可能留在那里（只影响显示）。
5. 首次启动表单在 v1 里不能沿用已存的 key：真实走查 m1-real 的走查 1 改为“空 key 测试失败 → 指向已存的密文 → Verify now”。
6. 测试用固定端口：同一台机器上另一个会话同时跑 m0–m7 或 v1 的测试会互相占端口；这次的最终结果都是在没有别的测试运行时跑的。
7. 现有套件的两处不稳定已找到原因并改好（只改测试）：`m5-app` 点会话行后 App 下一帧把焦点放进输入框，测试紧接着在另一行按 Shift+F10，两者赛跑
   （M7 的旧构建在负载下同样会失败），改为用 m3 的 `openMenuOn`（先等两帧）；`m7-replay` 的 `selectLines` 在阅读器语法高亮重绘之前选字，选区末端被重绘挪回，
   改为等高亮完成再选。改后 `m5-app` 负载下连跑 5 次、`m7-replay` 连跑 8 次都通过。
8. 实测中补进规格的三条：第 5、6 步服务端回 400 或 422 算判定为不通过（DeepSeek 拒绝指定调用和 JSON schema 时等级才能定为 C）；
   探针没跑完就关了 App 的模型，下次启动自动重新探测；加 key、删 key 也算修改提供商，没验证过的模型重新探测。
9. 界面文字（2026-10-21，与 english-ui 合并）：v1 的界面文字改按英文界面的术语表 [v0/ui-strings.md](../v0/ui-strings.md)，
   不再逐字照规格 §9 原来给的英文；规格 §9 与 [screens/](screens/) 已同步成代码里的文字，行为不变。主要改动：Address → Base URL、
   Model id → Model ID、New-session thinking level → Default effort for new sessions、Compatibility → Compatibility options；
   测试结果“Connected · First token Nms · Total Nms · Includes thinking · Response: …”、失败“Connection failed: …”；
   顶栏悬停“Can’t switch models until the response finishes”、菜单“Applies to this session only. …”与“Manage models”；
   不支持思考的说明用 english-ui 的句子（Settings → Models）；阶段行“Retrying (n/m) · …”；换模型提示“… redoes this response.”；
   只跳页的按钮去掉“…”（拒绝启动卡的“Allow <zone> for this project”“Confirm zone”），会弹确认的加“…”（Delete…、最后一个 key 的 Remove…）；
   字段错误改为带句号的整句；撇号一律用 ’。当时还留着规格原来写法的兼容选项说明（`COMPAT_LABELS`）和后台进程写出的原文
   （原因文字、“This session can’t start: no model fits”等），已在下面“界面文字跟着术语表”一节改好。

## 测试中发现并已修正的问题

- 测试发现的 6 个：两次换模型时说明重复；从未验证过的模型在探测中没显示 verifying；溢出恢复后仍显示错误卡；模型按钮最宽 200px（应为 160px）；删除确认框的文字；加 key 后不重新探测（规格 §7.4 补充了这一条）。
- 代码评审（5 个角度、每条再由独立的核实者反驳）确认的 25 个，包括：429 带 `Retry-After: 0` 时无限重发；写认证头出错时槽位泄漏；保存改地址的提供商时旧 key 可能发往新地址（另加了“key 只发往它的提供商地址”的保护）；迁移时解不开的密文被丢掉；准备中排队的消息在几种情况下丢失；设置页落点用了旧数据等。全部改好并各有单元测试。

## 界面文字跟着术语表（2026-10-21，分支 `v1-string-polish`）

v1 合并进 `app-v0`（`6a57fd4`）后还有四处界面文字与术语表 [v0/ui-strings.md](../v0/ui-strings.md) 不一致（上面第 9 条末尾）。
这次只改文字，不改行为；分支 `v1-string-polish` 基于 `6a57fd4`。

改了什么：

1. 撇号用 ’：`shared/models.ts` 的原因文字（“can’t connect”“couldn’t rebuild the conversation: …”）、
   `BLOCKED_PROMPT_MESSAGE`（“This session can’t start: no model fits”），`kernel/modelCommands.ts` 的
   “Model settings can’t be read: …”。重做说明里的原因文字是同一份，发给模型的说明也跟着变。`STOPPED_BEFORE_SENDING` 没有撇号，不用改。
2. 兼容选项用 english-ui 的标签，每个勾选框下面加一行小字说明（新的 `COMPAT_HINTS`），提供商表单与首次启动表单共用
   `CompatChecks`；提供商卡上的“Compatibility options”只列标签。标签：“Endpoint doesn’t support the developer role”
   “Endpoint doesn’t accept the store field”“Endpoint needs max_tokens instead of max_completion_tokens”
   “Endpoint doesn’t report usage while streaming”“Endpoint doesn’t support strict mode for tool parameters”
   “Tool results must include the tool name”；说明见规格 §9.1。
3. 没有“连接”这个说法了：启动时读取中“Loading connections…”改成“Loading…”，读取失败“Couldn’t load connections: …”
   改成“Couldn’t load model settings: …”；F8 报告的 Page 跟着改（“Loading…”“Couldn’t load model settings”）。
4. 地址统一叫 base URL：改地址的确认文字由 `shared/models.ts` 的 `addressChangeText` 给出，后台进程
   （`applyAddressChange` 的 `consequence`）与提供商表单共用，原来后台进程写的“Changing the address …”不再有；
   zod 的“Base URL must be an http or https URL”（迁移说明、配置错误里看得到），模型池的
   “The base URL of <id> changed; the request was not sent”。

文档：规格 §4.6、§5.3、§5.7、§6.3、§9.1、MP-18 的文字，[screens/first-run.md](screens/first-run.md)、
[screens/models-settings.md](screens/models-settings.md)、[screens/model-chat.md](screens/model-chat.md)，
[defaults.md](defaults.md)（新增“兼容选项的标签与说明”一行），[v0/defaults.md](../v0/defaults.md) 的兼容选项行，
[v0/screens/f8.md](../v0/screens/f8.md) 与 [v0/ui-strings.md](../v0/ui-strings.md) 里 F8 的 Page 取值。

测试（开发构建，另外两个会话错开固定端口跑的）：

| 检查 | 结果 |
| --- | --- |
| `npm run check`（类型检查 + 静态检查） | 通过 |
| `npm run test:unit` | 373/373 |
| `npx electron-vite build` | 通过 |
| `v1-models-app-settings` / `-session` / `-switch` | 141/141（新增一条：Add provider 表单的六个兼容选项各有标签和说明，换成别的 API type 时隐藏）、113/113、78/78 |
| `v1-models-replay` | 35/35 |
| `m0-smoke` | 18/19，退出码 0；没通过的是已知的 pi #9129（命令超时后留下 sleep 进程，标 known），`6a57fd4` 合并时同样 |
| `m1-app` | 37/37 |
| `spec-coverage.mjs`（不带 `--allow-missing-real`） | 退出码 0 |

覆盖检查里的真实层（`v1-models-real.json` 10/10）和现有测试的两份结果（`v1-models-app-existing.json` 11/11、
`v1-models-replay-existing.json` 7/7）没有重跑，用的是 `6a57fd4` 合并时在主检出跑出的文件：这几个脚本不检查改过的文字。
打包程序这次没有重跑。

我替你定的（走查时都可以改）：

1. 读取失败写“Couldn’t load model settings: …”：`config.get` 出错多半是模型层没能启动；读取中只写“Loading…”（术语表的写法）。
2. 只加每个选项下面的说明，没有加回 english-ui 选项上方那句
   “Check an option only if the endpoint really needs it. Otherwise pi works it out automatically.”：v1 里没有核实 pi 都能自动判断。
3. 提供商卡上的“Compatibility options”只列标签，不带说明（一行放得下）。
4. 同一类的后台进程文字一起改成 base URL（上面第 4 条的 zod 与模型池两处），不只是改地址的确认文字。

没改的：v0 连接表单的状态表 [v0/screens/connection.md](../v0/screens/connection.md)（v1 已删掉那个表单）仍写“Loading connections…”；
术语表里 v0 设置页的几行（“Connections and models”“Add connection”等）还没按 v1 的 Settings → Models 改，留作后续。

## 未验证

- 内网 vLLM、SGLang、llama.cpp、Ollama：只用合成端点模拟过它们的版本接口、指标、截断和取消；真实的 429 `Retry-After`、5xx、长输入截断没有在真实端点上触发过。
- 需要你同意的两个探针（长输入、取消）只在合成端点上跑过。
