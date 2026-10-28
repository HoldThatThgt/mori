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
2. 新建一个分组（例如 GLM 在前、DeepSeek 在后），设为新会话的默认范围；新会话输入框下面一行的范围按钮显示“<分组> · <当前模型>”。
3. 在没有授权公网的新项目里发消息：输入框上方出现拒绝启动卡；“Allow public for this project…”带你到 Project access，确认后可以发送。
   （2026-10-26 改，负责人走查 M3：网络区域删掉，新项目里直接可以发送，没有这张卡。）
4. 输入框下面一行的范围菜单（往上打开）：分组、提供商、模型三节；选一个提供商或模型后下一条消息由它回答；重新打开会话后范围不变。
5. 把首选的 key 删掉、加一个错的（例如 `sk-invalid`）：下一条消息出现“Switched model: … · API key rejected”，没有错误卡；把对的 key 加回来、删掉错的，再发一条，回到首选。
6. 在一个要连续读好几个文件的回复进行中做第 5 条：出现“The new model redoes this reply.”，之前的工具卡还在。
7. 生成中输入框下面一行的范围和 Effort 按钮都不可用；Esc 或停止按钮能停在“准备中”（消息回到输入框）。
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
   （2026-10-26 负责人推翻：“we do not need to separate local, intranet or public model”。网络区域与按项目授权整个删掉，
   proposal §12 第 2 行改为“否”，见 [walkthrough-1026/WP-05.md](walkthrough-1026/WP-05.md)。）
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

### 后续：术语表的设置页与 v0 连接表单的状态表（2026-10-21，分支 `v1-glossary-settings`）

上面留作后续的两项。分支 `v1-glossary-settings` 基于 `app-v0` 的 `2e67197`，只改文档，不改代码和界面文字。
文字都照代码抄（`components/settings/*.tsx`、`SettingsPage.tsx`、`FirstRunForm.tsx`、`ModelMenu.tsx`、`ThinkingMenu.tsx`、
`BlockedCard.tsx`、`UnavailableCard.tsx`、`App.tsx`，`state/settings.ts`、`state/actionLog.ts`、`state/actions.ts`、`state/model.ts`，
`shared/models.ts` 的 `API_TYPE_LABELS`、`COMPAT_LABELS`、`COMPAT_HINTS`、`REASON_TEXTS`，`kernel/modelConfig.ts` 的连带改动），
再与 [screens/](screens/) 的四张状态表对过。

改了什么（[v0/ui-strings.md](../v0/ui-strings.md)）：

1. 术语表：去掉“连接 / 连接与模型”一行；加 v1 的提供商、key、分组、选择范围、网络区域、项目授权、验证（探针）七行；
   “默认”改为 Defaults 一节和下拉里的“None”（v1 没有“Set as default”和模型行上的“Default”）；“模型”改为“Models”
   （设置页的分节、提供商卡里的一块、范围菜单和 Defaults 下拉的一节），注明 v0 顶栏的“Model: <id>”不再有；
   “设置”去掉“Go to settings”，注明打开 Settings → Models 的按钮叫“Open settings”（范围菜单里是“Manage models”）；
   “测试连接”注明“Test connection”和“Test”各用在哪里。
2. 按屏的固定说法：新加“首次启动”一节（读取中与读取失败、“Connect a model”和说明、迁移失败、字段和两种占位文字、
   选了 Public 的说明、按钮、探针状态、测试成功后的“Open folder…”）；“设置”一节按 v1 的 设置 → Models 重写：
   页头和分节、迁移说明、区域未确认、Defaults、Providers、提供商表单、接口类型、兼容选项（六个标签和各自的说明）、
   Keys、模型行、档案摘要、模型表单、Groups、Project access、确认框、字段错误、测试结果、保存方式、范围菜单。
   去掉了 v0 的“Connections and models”“Add connection”“Edit connection · <name>”“Set as default”、key 的四种提示
   （“Kept encrypted on this computer after you save”等）、“Saved, but the configuration has an error: …”、
   模型行的“Default effort: High”“Doesn’t support thinking”、模型菜单的“Model: <id>”“<id> (deleted)”
   “No models available”“… the default model from Settings.”。思考强度菜单一行与代码一致，没改。
   “会话”一节：首次启动一行改为指向新的一节（v1 没有 v0 测试成功后的标题“Connected”）；错误卡去掉“Go to settings”；
   加“模型层的卡片”（No model available 卡、拒绝启动卡的文字和按钮）与“候选的原因”（`REASON_TEXTS` 的每一种原因）两行。
3. 操作记录：按 `actionLog.ts`（加上 `settings.ts` 的“Open Settings → Models”、`actions.ts` 的“Open settings”）现在写的重写，
   原来的“设置”一行拆成“设置”“首次启动、设置 → Models”“测试连接”“顶栏”四行。v0 的“Save connection”
   “Set default model: …”“Switch model for this session: …”不再有，现在是“Save first-run provider …”“Add provider …”
   “Set defaults … · …”“Set model range …”等；“Test connection”后面带 `<provider>/<id>`；删除确认框先算连带改动的那次不记。
   “其他”一行去掉“Go to settings”和“Open settings”（后者移到“设置”一行）。
4. “实现时要一起改的地方”是 english-ui 当时的清单，没有重写，只在提到 `ConnectionForm.tsx`、`ModelForm.tsx` 和
   连接表单宽度的两处注明 v1 已删掉它们。

[v0/screens/connection.md](../v0/screens/connection.md)：开头原来已有一句 v1 说明（只指向 first-run.md），改为写明 v1 已取代本文、
连接表单已删除、“Loading connections…”等文字界面上已经没有，指向 [screens/first-run.md](screens/first-run.md) 与
[screens/models-settings.md](screens/models-settings.md)；“读取中”“读取失败”两行加了 v1 的文字。没有删掉这个文件：
first-run.md 还沿用它的“首次启动之后：打开文件夹”一节，说明里也写了只有这一节仍然有效。

只改文档，没有跑测试。

我替你定的（走查时都可以改）：

1. 新加的七个术语，“Claude 桌面版的用词”一栏写“—”：这些说法是规格 §9.1 定的，这次没有逐个去 Claude 里找对应。
2. 首次启动的文字单独成一节，放在“设置”前面，不再放在“会话”一节里。
3. 确认框里后台进程写的连带改动各行，术语表只指向 models-settings.md“确认框的文字”，不抄第二份。
4. connection.md 加说明、不删。

看到了、没改的（不在这次的范围，或要你定）：

1. 换模型的一行“Switched model: A → B · rate limited”里，“ · ”后面的原因是小写，与术语表写法约定“ · 后面的片段首字母大写”
   不同（同一份原因文字也用在“ — ”“: ”后面和重做说明里）。术语表先照代码记下，标了待你确认。
2. 秒数前有空格：“waited 30 s for a free slot”（`REASON_TEXTS.queue_timeout`），“No response within 120 s”
   （`kernel/config.ts:122`、`kernel/probes.ts:292`）；术语表说毫秒和秒都不加空格（120ms、5s）。
3. 别处还写着 v0 的说法：`app/README.md:113`（设置页的“Connections and models”）、[v0/screens/f8.md](../v0/screens/f8.md)
   第 47 行（“连接表单只写“Save connection””）、[v0/screens/README.md](../v0/screens/README.md) 里 connection.md 那一行；
   代码注释 `renderer/src/styles/settings.css:3`、`:131` 也还提到“Connections and models”和已删掉的 key 提示。

## 思考关不掉的模型：实测（2026-10-24，分支 `claude/v1-reasoning-mandatory`）

为规格 §7.7（2026-10-24 补丁，负责人选定方案 B）在实现之前测的三项。做法：一个只在规划会话临时目录里的脚本（不进仓库），
用 pi-ai 1.3.0 的 `streamSimple` 照探针的写法发出（同样的提示、`get_weather` 工具、`{ outcome }` 的 JSON schema、最大输出 256 token），
模型按 Mori 编译的样子写（`openai-completions`、地址 `https://openrouter.ai/api/v1`、勾 Supports thinking；“有标记”即加 `thinkingLevelMap: { off: null }`）。
key 由脚本从你的 `openrouter.env` 读出、不打印；记录里只有状态、发出的 `reasoning` 字段和回复摘要。共 27 个请求，全是 HTTP 200 或预期的 400。

| 模型 | 请求 | 发出的 `reasoning` | 结果 |
| --- | --- | --- | --- |
| `recursive/flint-v1.0:free` | 第 1 步，`medium` | `{ effort: "medium" }` | 200，“ready” |
| 同上 | 第 2 步的关思考，没有标记 | `{ effort: "none" }` | 400 `{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_name":null}}}` |
| 同上 | 同一句，有标记、不传强度 | 不发 | 200，“ready”，有思考 |
| 同上 | 第 3、4、6 步，`medium` | `{ effort: "medium" }` | 都通过：`get_weather({ city: "Paris", days: 3 })`、回答含 21、`{"outcome":"ok"}` |
| 同上 | 第 7 步连发 3 次，`medium` | `{ effort: "medium" }` | 3 次都通过（输出 111–187 token） |
| 同上 | 第 3、4 步，有标记、不传强度 | 不发 | 都通过 |
| `liquid/lfm-2.5-2.6b:free` | 第 1 步，`medium` | `{ effort: "medium" }` | 200，“ready” |
| 同上 | 第 2 步的关思考，没有标记 | `{ effort: "none" }` | 400，原文同上 |
| 同上 | 同一句，有标记、不传强度 | 不发 | 200，“ready”，有思考 |
| 同上 | 第 3、4、6 步，`medium` | `{ effort: "medium" }` | 都通过（第 6 步 `{"outcome": "fail"}`，在枚举内） |
| 同上 | 第 7 步连发 3 次，`medium` | `{ effort: "medium" }` | 3 次都停在 256 token（`finish_reason: length`），只有约 900 字思考、没有正文：按 §7.7 的输出上限规则为出错 |
| 同上 | 第 3、4 步，有标记、不传强度 | 不发 | 都通过 |
| `openai/gpt-oss-20b`（列 `[high, medium, low]`） | `minimal`、`medium` | `{ effort: "minimal" }` / `"medium"` | 都是 200、正常回答 |
| `z-ai/glm-5.3-flash`（列 `[max, high, low]`） | `minimal`、`medium`、`low` | 各自的值 | 都是 200、正常回答（`medium` 时回复里没有思考内容） |

结论（已写进规格 §7.7 末尾）：

1. 探针用 `medium` 可行；最大输出维持 256，但必须有“停在输出上限、只有思考算出错”的规则（lfm 的第 7 步）。lfm 第 6 步通过，真实探测时得 B 级、不跑第 7 步。
2. 不传 `reasoning` 字段时 OpenRouter 按默认思考、正常回答：有标记的模型即使收到不带强度的请求（标记这道保险）也不会出错；按规格 §7.7 Mori 本来就不发这样的请求（测试连接、探针带 `medium`，换模型后重发收紧成 `minimal`）。
3. 强度不在模型的 `supported_efforts` 里时 OpenRouter 不拒绝：会话里 Off 提到的 `minimal` 能发。只测了 OpenRouter；Anthropic、百炼、MiniMax 的必须思考的模型没有测。

另外更正 [discovery-checks.md](discovery-checks.md) 第 170 行的说法：OpenRouter 列出工具的 17 个免费模型里只有 2 个要求思考（上面两个），不是全部；探针第 1 步（`medium`）没有被拒，被拒的是关闭思考的第 2、3、5、6、7 步。

## 思考关不掉的模型：实现与检查（2026-10-24，分支 `claude/v1-reasoning-mandatory-impl-640e42`）

按规格 §7.7 与它链接的 2026-10-24 补实现（基于 `claude/v1-reasoning-mandatory` 的 `b885773`，即 `app-v0` 的 `ab57183` 加文档；
之后合并了 `origin/app-v0` 的 `31597b7`，只带进 composer-pickers 两处测试的时序修正）。提交：`0f791cf` 实现，`a0fb11c` 测试，
`17134f6` 真实层的共用建目录，`8881767` 合并 `app-v0`，`b38f0fe` `m1-replay` 的时序修正，以及记这一节的提交。没有推送、没有合并。

### 你给这次工作定的规则（2026-10-24，原话转述）

1. **什么都不推后**：§7.7 的每一条和 MP-38、MP-39、MP-40 在它列的每一层都实现并通过；不留 TODO、“以后再做”“未实现”的说明、
   桩，也不留跳过的、todo 的、已知失败的测试。用测试守住：`node tests/spec-coverage.mjs --spec model` 要通过（含 MP-40）；
   跳过的与 todo 的测试算失败；加一项以新编号开头的检查，在这次新加或改动的文件里查 TODO / FIXME / “not implemented” / “later”。
2. **§7.7 没写的不做**：不读 `reasoning.mandatory` 等列表里的标记，不按模型名判断，不加配置项，不在被拒后换个强度重发，
   不迁移、不自动重新探测旧档案；每条新代码路径都指向规格的一节。规格有挡路的缺口、或与已合并的界面矛盾时，停下来带选项问你。
3. **真实层（MP-40）**：用 `HoldThatThgt` 目录下 `openrouter.env` 里的 key，经 `MP_REAL_OPENROUTER_KEY` 传入（§14.1），
   不打印、不写日志、不提交；免费模型每天有请求上限，真实运行要少。

做法按你一贯的偏好：先写契约（`shared/` 的类型、内核接口、文件归属），再用 Workflow 并行实现（四条互不相交的线，各带审查），
然后只读审查（五个角度，每条发现三位对抗核实），再写测试（五条线，各带审查），最后依次跑测试。

### 你在这次工作中定的（2026-10-24）

- **真实层的数据目录（选项 A，“用 env 里的 key 新建数据目录”）**：本机没有你的 Mori 数据目录（`C:\Users\56865` 下没有
  `model-config.json`，2026-10-21 跑 MP-27 用的目录与它的结果文件也不在了），MP-27 原来的 `--source` 方式跑不了。按你选的，
  `v1-models-real.mjs` 加了 key 方式：不给 `--source`，`MP_REAL_DEEPSEEK_KEY`、`MP_REAL_GLM_KEY`、`MP_REAL_OPENROUTER_KEY`
  （由运行它的进程从 `deepseek.env`、`glm.env`、`openrouter.env` 读出、不打印），只经界面建新的数据目录：首次启动表单接
  DeepSeek，Add provider 接 GLM 与 OpenRouter；建目录的步骤从 `md-real.mjs` 移到 `v1-real-helpers.mjs`，两边共用（MD-14 的
  名字、环境变量与地址覆盖不变，一次逐条比对的审查确认行为相同）；之后照原样跑 MP-27 与 MP-40。`--source` 方式不变。
  已写进规格 §14.1 的 2026-10-24 补。我另定的一点：OpenRouter 的 Add provider 就是 MP-40 那条“找不到时用
  `MP_REAL_OPENROUTER_KEY` 经 Add provider 加入”，在建目录时做、只勾 flint，lfm 再经卡上的 Fetch models 加入；
  建目录时不先加别的免费模型，免得同一天把免费模型多探测一遍。
- **MP-40 的 lfm 一条（选项 B，“现在就改 MP-40”）**：原来写 lfm“`tool_calling: verified`、等级 B”。两次真实运行都没过，
  原因都在服务或模型：第一次 OpenRouter 回 429（上游限流），第二次第 6 步把 256 token 全用在思考上，按 §7.7 的输出上限规则为
  出错，第 7 步不跑、等级为空。你定：lfm 在 `tool_calling: verified`、`off_refused: true`，且等级 B **或**第 6 步出错为
  “Stopped at the probe output limit before answering”（只能是出错，不能是不通过）时通过；理由是 lfm 在 `medium` 下第 6 步的
  思考长度不定，在 256 的上限上两样都可能，这一条要验证的是必须思考的模型变得可用；探针上限不调，不为它另加一次真实运行
  （只在覆盖检查需要新的结果文件时才跑）。已改规格 §14.2 的 MP-40 一行（2026-10-24 负责人改）与 `v1-models-real.mjs` 的检查
  （`lfmTierOk`，只认这两种结果）。原来的结果文件里是按旧条件记的失败，覆盖检查读不到新条件下的结果，所以照你的条件又跑了一次（第三次，结果见下）。
- **到此为止，lfm 一条记为未验证（“到此为止，记为未验证”）**：第三次的第 6 步又被 OpenRouter 上游限流（429）之后，你定不再跑
  真实层、不再改 MP-40 的写法，把 lfm 那一条记为未验证（外部限流）。另两个选项你没有选：把 lfm 换成便宜的付费模型
  `openai/gpt-oss-20b`；以后再试 lfm。之后照下面“以后要补跑时”的命令补。

### 我替你定的（走查时都可以改）

1. **契约**：`modelCompile.ts` 的查档案改为一个 `ProfileLookup`，一次给出 `{ replayRequired, offRefused }`（原来的
   `ReplayLookup` 只给回传一项）；`modelProfiles.ts` 的 `compileFlagsOf` 给编译和 `storeProbe` 的比较共用。
   `probes.ts` 的第 8、9 步多一个参数 `offRefused`（档案里存的），`runAutoProbes` 不看档案、按本组第 2 步。
2. **输出上限的回复保留消息**：停在输出上限、只有思考的回复记为出错，但消息不丢（推理字段名仍能从它读出）；HTTP 状态仍是
   200，所以不算“被拒”（第 5、6 步、回传检查只认 400、422），第 8 步不记 `silent`。
3. **第 5 步不适用时不发请求**；第 7 步的条件“第 5 步不通过或不适用、且第 6 步不通过或不适用”对所有模型都按这个写。
4. **Edit 表单的 noOff** 由 `ModelEditor.tsx` 按 `mori.profiles` 里这个模型的档案算出、传给 `fields.tsx` 的 `ModelFields`
   （§13 只列了 `fields.tsx`；`ModelEditor.tsx` 是持有模型 ref 的那个组件，只加了一行）。
5. **Effort 菜单的说明**另起一行，加了一条 CSS（`.switch-menu .menu-note + .menu-note`）去掉第二条说明上面的分隔线和留白，
   让它是“底部说明下面另起一行”，不像另一节（model-menu.md 的临时细节）。
6. **回放**：之前录下的 `enhance.get` 结果和 `enhance.set` 结果里的 `info` 没有 `noOffPicks`，回放桥补成 `[]`
   （`harness/replay.js` 的 `withNoOffPicks`，synthetic，同 `M6_INFO` 的做法）；fixture 不重录，`effortPicks` 不变。
7. **守住规则 1 的两处测试改动**：模型层单元报告器（`v1-unit.json`）改为严格模式（跳过的与 todo 的测试记为失败，同
   `md-reporter.mjs`）；`tests/md-markers.mjs` 加 `--id`（默认 MD-15），新的单元测试 `tests/unit/mp-markers.test.mjs`
   以 “MP-38 no deferral markers …” 跑 `node tests/md-markers.mjs --id MP-38`，查这次新加的行。
8. **Effort 按钮的位置**：规格与状态表写“输入框下面一行”，composer-pickers 之后它在输入框里的那一行（`Composer.tsx`
   渲染 `ThinkingMenu`）；是同一个组件，行为（菜单项、说明）与位置无关，所以没有当作矛盾来问。

### 实现了什么（每条都指向规格的一节）

- 第 2 步按 §7.7 的判定表判（`judgeThinkingStep`）：关思考被 400 或 422 拒绝、`medium` 有正文为不通过、`off_refused`，说明
  “Thinking can’t be turned off: <原文>”只存在 `model-profiles.json`（真实运行里是
  `400: {"message":"Reasoning is mandatory for this endpoint and cannot be disabled.",…}`）；`medium` 出错用它的说明，
  没有正文用 `off` 的原文，都是出错。档案存 `auto.offRefused`（schema 可选，旧档案读作 false、不重新探测，`PROBE_SUITE` 不变）。
- 第 1–7 步与回传检查都在去掉“没有 Off”标记的模型副本上发；本组判出 `off_refused` 时第 3、4、6、7 步用 `medium`、第 5 步
  不适用；第 8、9 步用编译后的模型、按档案选强度；输出上限规则对第 1–9 步。
- 编译：`off_refused` 的模型带 `thinkingLevelMap: { off: null }`（写在模型上，三种接口都写，不在 `compat`）；`off_refused`
  或回传变了时重新注册这个提供商，变回 false 时标记随之去掉。
- 测试连接：勾了 Supports thinking 的模型带 `medium`。§11.2 换模型后重发：会话强度按新模型 `clampThinkingLevel`。
- 界面：档案摘要 “Thinking: Can’t be turned off”（Reasoning field 之后、Cancel 之前）；Effort 菜单没有 Off、底部
  “This model can’t turn thinking off.”（会话是 Off 时按钮已由 pi 收紧成 Minimal）；Edit 的 Default effort 与增强设置的
  Effort 不列 Off、存着的 Off 显示 Minimal 照存（后者按 `enhance.get` 的新字段 `noOffPicks`）。

### 结果

| 层 | 结果 |
| --- | --- |
| `npm run check`、构建 | 通过 |
| 单元：`test:unit`（严格） / `test:mem-unit` / `test:tb-unit` / `test:md-unit` | 418 / 222 / 335 / 197，全部通过；MP-38 27 项、MP-39 19 项 |
| 合成端点自检（`tests/fake-endpoint/selfcheck.mjs`） | 192 / 192（新加 33 项：`-nooff` 的三种关思考写法与原文逐字节、`/openrouter.ai/v1` 前缀、`effort` 日志、`thinkingOn`、`-thinklong`、`-nooff` 的判断顺序） |
| App：`v1-models-app-nooff.mjs`（新，MP-38、MP-39 的 App 层，加进 `test:v1-models`） | 32 / 32（开发构建） |
| 打包程序（测试分层第 4 条，只做冒烟：没改打包配置、主进程与 preload） | `npm run dist:dir` 通过；`m0-smoke --exe` 18 项通过、1 项 KNOWN（pi #9129）；`v1-models-app-nooff --exe` 32 / 32 |
| 现有套件：`v1-models-existing.mjs --id MD-15`（m0–m6、`v1-models-app-*`、`tb-app-*`、`mem-app-*` 的 App，全部回放，单元，标记检查） | 3634 项通过、1 项 KNOWN（pi #9129），各套件都是退出码 0；`md-app-form` 82、`md-app-card` 68、`md-app-firstrun` 114、`md-replay` 69 |
| 只读审查（五个角度、每条三位对抗核实） | 两条发现都被驳倒（都早于这次的改动，见下面“一并查到的”） |
| 真实层（key 方式，三次） | MP-27 三次都全部通过；MP-40 除 lfm 那一条外三次都通过（每次 22 / 23），lfm 见下 |

真实层看到的（DeepSeek `deepseek-flash`、GLM `GLM-5.3`、OpenRouter 的两个免费模型；数据目录只经界面建出）：

- MP-27：两个模型的探针合理（DeepSeek 的种类按地址认作 `deepseek`）；正常对话；段开始与段内各换一次模型（真实的 401）；
  恢复 key、重新启动后回到首选。
- flint：档案 `ready`、`tool_calling: verified`、等级 B（第 5 步不适用、第 6 步通过）、`off_refused: true`，模型行有
  “Thinking: Can’t be turned off”；Test 成功（“Connected · … · Includes thinking”）；DeepSeek 上设成 Off 的会话把范围换到
  flint 后按钮是 “Effort: Minimal”、菜单没有 Off、有那句说明，发一条消息由 flint 正常回答，没有错误卡。
- lfm（MP-40 要求 `tool_calling: verified`、等级 B）：第一次探针被 OpenRouter 回 429
  “liquid/lfm-2.5-2.6b:free is temporarily rate-limited upstream”（服务那边，探针按 §7.3 记为出错）；第二次第 1–5 步与回传
  检查都如预期（`tool_calling: verified`、`off_refused: true`），第 6 步（JSON schema，`medium`）把 256 token 全用在思考上，
  按 §7.7 的输出上限规则为出错，“Stopped at the probe output limit before answering”，第 7 步因此不跑，等级为 null。
  规划时的实测里它第 6 步通过过一次，所以这是模型在 256 的上限上的不确定，不是 Mori 的问题；你因此改了 MP-40（见上面“你在这次工作中定的”）。
  第三次（按改过的条件）：第 1–5 步与回传检查同上，第 6 步又被 OpenRouter 回 429（`model_rate_limit_exceeded`，
  `limit_source: upstream_provider_shared_pool`，提供方 Liquid，`Retry-After: 1`），探针按 §7.3 记为出错（429 不算不通过），
  不是改过的条件接受的两种结果之一，所以这一条仍没通过。三次里 lfm 两次被服务限流（第一次在探针里、第三次在第 6 步），
  一次第 6 步停在输出上限。你定到此为止、记为未验证（见“未验证”）。
- key 没有出现在任何地方：结果文件、日志、截图之前的窗口文字、三次用过的数据目录（加密的 `credentials.json` 都已删）与这次
  会话的临时目录共 461,428 个文件，以及仓库里 787 个文件和这个分支的全部提交，都查过，没有命中。

### 测试中发现并已修正的问题

1. **真实层的预检**（一次只读审查，跑真实层之前）：`v1-real-helpers.mjs` 的 `profileProblems` 只认一键拉取之前的五种服务，
   DeepSeek 的档案种类 `deepseek` 会让 MP-27 每次都失败；改为认 `SERVER_KINDS` 的全部种类。另几处加固：准备与启动出错时
   照样写结果、删掉 `credentials.json`；lfm 没加成时不再连带跳过 flint 的检查；测试连接一出错就读到“Couldn’t test …”。
2. **现有套件的时序**：第一次完整回归里 `m2-app`、`m5-app`、`m6-app-slash`、`m1-replay` 各有一条失败（都是输入框下面一行的
   焦点与布局）。逐个重跑：`m2-app` 通过；`m5-app`、`m6-app-slash` 的失败正是 `app-v0` 后来修的两处时序（量到发送中、分屏的
   延后聚焦），合并 `31597b7` 带进来；`m1-replay` 的 “reload：…开着的权限菜单关上” 在这台机器上每次都失败，把这个分支改过的
   界面文件和回放桥换回 `31597b7` 的版本也一样失败（两次），所以不是这次带来的：菜单在按钮变得不可用之后的 effect 里关上，
   测试在那之前就数了。只改测试（先等菜单关上再数，最多 3 秒），之后 3 次都 94 / 94，完整回归里也通过。

### 一并查到的（没有改，供你参考）

- 探针结束保存档案时，写 `model-profiles.json` 失败会跳过重新编译，而内存里的档案已经是新的（设置页显示 “Can’t be turned off”、
  Effort 菜单仍有 Off）。这个先存后编译的次序在这次之前就有（回传推理那一项同样），写失败要重试多次之后才会发生，§7.7 没有
  写写失败时怎么办，所以没改。
- `memory-enhance.md` 的 Effort 一行和 `MemoryEnhance.tsx` 第 19 行的注释还写“同顶栏”（composer-pickers 之前的说法）；这次
  只改了这个分支自己的笔误“菜单菜单”。

### 合并到 app-v0（2026-10-24）

你要求按 AGENTS.md 合并并推送（“merge claude/v1-reasoning-mandatory-impl-640e42 into app-v0 following AGENTS.md (suites
related to any conflicts plus the coverage checks), then push app-v0”）。合并前取了 `origin/app-v0`：仍是 `31597b7`，分支早已
合并过它，所以合并提交 `3e062c2` 没有冲突，合并后的树与分支的 `ceaaf6e` 完全相同（`git diff` 为空）；这一段记录再作为一次合并
带进 `app-v0`（同 `31597b7` 的做法）。按测试分层第 3 条，没有冲突时只跑覆盖检查（结果文件是分支上同一棵树跑出的）：
`--spec model` 只差 MP-40 的 lfm 一条；`--spec taskboard`、`--spec memory`、`--spec discovery`（都带 `--allow-missing-real`）的
缺口都是现有套件结果里记着的那次模型层覆盖检查的结论，同样只连着 lfm 这一条。这是你已经接受的（lfm 一条记为未验证，见“未验证”），
不挡推送；没有别的失败或新的缺口。之后推送 `app-v0`，核对本地 `app-v0` 与 `origin/app-v0` 一致；主检出里没有跟踪的 `eval/` 没有动。

## 思考关不掉的模型：换模型（2026-10-28，分支 `wt/mp40-models`）

你 2026-10-28 定：“MP-40 pick a different models”。原因：2026-10-28 第二阶段（`wt/fix-main`）三次 `v1-models-real` 里 flint、lfm
的探针都被 OpenRouter 回 429 `temporarily rate-limited upstream`（`limit_source: upstream_provider_shared_pool`，免费模型上游的
共享限流，不是额度），见 [walkthrough-1026/regression.md](walkthrough-1026/regression.md)“还开着的”第 1 条的注。换成付费的、
必须思考、有工具的模型，让 MP-40 能稳定通过；通过条件不变。改了规格 §7.7 末尾（2026-10-28 实测）、§14.1、§14.2 MP-40 与
开头的补丁说明；测试只改 `tests/ui/v1-models-real.mjs` 与 `tests/ui/v1-real-helpers.mjs`（`NO_OFF_MODELS` 的两个模型改名为
`main`、`limit`，相应的变量、注释与截图名）。`app/src` 没有改，模型看到的、做的都不变。

### 实测（选模型）

做法同 2026-10-24 的实测，另用 Mori 自己的探针整组发出：一个只在会话临时目录里的脚本（不进仓库）用 `tests/unit/load.mjs` 的
`loadKernelModule` 在内存里打包 `src/kernel/probes.ts`，调它的 `runAutoProbes`；`streamSimple` 是 pi-ai 1.3.0 的
（`@earendil-works/pi-ai/compat`），fetch 只把占位 key 换成 `openrouter.env` 里的 key（不打印）；模型照 Mori 编译的样子写
（`openai-completions`、`https://openrouter.ai/api/v1`、勾 Supports thinking、不带“没有 Off”标记），时长与次数照 `modelTimings.ts`
（最大输出 256、首个内容 120 秒、第 7 步 3 次）；第 0 步用替身（种类 unknown，不发请求）。每个模型另发一次测试连接的请求
（`medium`、512 token、“Reply with one short sentence.”，同 `config.ts`）和一次 `minimal` 的请求（会话里 Off 提到的强度）。
候选取自 2026-10-28 拉取的 OpenRouter 列表：`reasoning.mandatory` 为真、`supported_parameters` 有 `tools`、不是 `:free`、
不是 `:batch` 与 `~` 开头的别名，按价格从低到高。共 195 个请求，按列表价格与回复的 usage 算约 0.0066 美元。

| 模型 | 价格（美元 / 百万 token，输入、输出） | 组数 | 第 2 步 | 第 3、4 步与回传检查（输出 token） | 第 6 步 | 第 7 步 | 测试连接、`minimal` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `minimax/minimax-m3.1-flash` | 0.15、0.60 | 4 | 关闭思考每次都回 400 `Reasoning is mandatory for this endpoint and cannot be disabled.`，`medium` 有正文：`off_refused` | 都通过（22–68） | 4 次通过（B 级，6–10 token，没有思考内容） | 不跑 | 200、200 |
| `liquid/lfm-2.5-24b-a2b` | 0.05、0.70 | 4 | 同上 | 都通过（56–64） | 4 次都停在 256、只有 1077–1121 字思考：出错（输出上限） | 不跑 | 200、200 |
| `openai/gpt-oss-20b` | 0.018、0.09 | 3 | 同上 | 都通过（31–62） | 2 次通过（55、78 token），1 次停在 256：出错 | 不跑 | 200、200 |
| `openai/gpt-oss-120b` | 0.15、0.60 | 3 | 同上 | 都通过（16–64） | 3 次通过（81、124、240 token） | 不跑 | 200、200 |
| `z-ai/glm-5.3-flash` | 0.15、0.50 | 1 | 同上 | 通过，第 3 步与第 4 步各用满 256 token | 通过，用满 256 token | 不跑 | — |
| `stepfun/step-3.5-flash` | 0.10、0.30 | 1 | 同上 | 都通过（53–86） | 400 `Json mode is not supported for this model.`（SiliconFlow）：不通过 | 停在 256：出错 | 200、200 |
| `openai/gpt-oss-safeguard-20b` | 0.075、0.30 | 1 | 同上 | 第 3、4 步通过；回传检查 429 上游限流：出错 | 出错（Groq `Failed to validate JSON`） | 不跑 | — |
| `liquid/lfm-2.5-2.6b`（原来第二个模型的付费端点） | 0.35、0.50 | 1 | 每个请求都是 404 `0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy … Paid model training violation (account settings): 1 endpoint excluded` | — | — | — | 404 |
| `meta/muse-spark-1.3-contributor` | 0.10、0.20 | 1 | 同上，404 | — | — | — | — |
| `openai/gpt-5-nano` | 0.05、0.40 | 1 | 每个请求都是 403 `The request is prohibited due to a violation of provider Terms Of Service.` | — | — | — | 403 |

选的（推荐，临时默认值，登记在 [defaults.md](defaults.md)）：

1. **第一个（档案 `ready`、测试连接、原来是 Off 的会话）：`minimax/minimax-m3.1-flash`。** 任何一步出错档案就是 `error`
   （`modelProfiles.ts` 的 `statusOf`），所以要每一步的思考都离 256 远。它 4 组都 `ready`，各步最多 68 token。比它便宜的
   `gpt-oss-20b` 有 1/3 第 6 步停在上限，`gpt-oss-safeguard-20b`、`step-3.5-flash` 出错，`muse-spark-1.3-contributor`、
   `gpt-5-nano` 用不了；同价的 `gpt-oss-120b` 第 6 步到过 240 token。
2. **第二个（验证输出上限规则）：`liquid/lfm-2.5-24b-a2b`。** 4 组第 6 步都停在上限（规则每次都走到），第 3、4 步都通过；
   原来那个模型的付费端点 `liquid/lfm-2.5-2.6b` 被你的 OpenRouter 账户的数据设置排除（404），所以用同一系列的 24B。
   `gpt-oss-20b` 也满足通过条件（B 级或输出上限），但 3 组里只有 1 组走到输出上限。

### 结果

| 层 | 命令 | PASS / FAIL / KNOWN | 说明 |
| --- | --- | --- | --- |
| 构建 | `npx electron-vite build`（经共用的锁 `uirun.sh`） | 通过 | — |
| 真实层（key 方式，§14.1 选项 A，开发构建） | `node tests/ui/v1-models-real.mjs`（三个 key 由运行的进程从 `D:\code` 的 env 文件读进 `MP_REAL_DEEPSEEK_KEY`、`MP_REAL_GLM_KEY`、`MP_REAL_OPENROUTER_KEY`，不打印；经 `uirun.sh`；19:09–19:11） | 23 / 0 / 0 | 一次通过，没有重跑。MP-27 13 / 0；MP-40 10 / 0；`test-results/v1-models-real.json` 是这一次 |
| 检查与最小集 | `npm run check`；`npm run test:min`（经 `uirun.sh`） | 通过；单元 510、400、243、222、30、41、109、972 全部通过 | 只改了测试与文档 |

真实层看到的：

- 建目录时 Add provider 接 OpenRouter（“Detected: OpenRouter”，列表 456 个模型），过滤、只勾 `minimax/minimax-m3.1-flash`
  （列为 Supports thinking）、Add 1 model；之后卡上的 Fetch models 过滤、勾 `liquid/lfm-2.5-24b-a2b`、Add 1 model。
- `minimax/minimax-m3.1-flash`：档案 `ready`、`tool_calling: verified`、等级 B、推理字段 `reasoning_content`、`can_disable: false`、
  `replay: not_required`、`off_refused: true`、种类 `openrouter`；模型行说明一行末尾是 “Thinking can’t be turned off”。
  测试连接（经进程桥的 `connection.test`）成功，首字 536 ms、共 634 ms。
- `liquid/lfm-2.5-24b-a2b`：`tool_calling: verified`、`off_refused: true`，第 6 步出错为 “Stopped at the probe output limit before
  answering”，等级为空、档案 `error`（MP-40 接受的两种结果之一，同实测的 4 次）。
- 原来是 Off 的会话：DeepSeek `deepseek-flash` 上选 Off（“Effort: Off”），范围换到 `minimax/minimax-m3.1-flash` 后按钮是
  “Effort: Minimal”，菜单从 Minimal 起、没有 Off、有 “This model can’t turn thinking off.”；发一条消息，它回答
  “我是 MiniMax-M3.1-Flash 模型。”（停止原因 `stop`），没有换模型提示和错误卡；会话文件里记的强度仍是 `off`。
- 花费：这次运行前后读 OpenRouter 的 `GET /api/v1/key`（只看用量），差约 0.0017 美元（用量的数字有几十秒的延迟，同一时间
  别的会话也可能在用这个 key，只作估计）；加上选模型的实测约 0.0066 美元，这一包共约 0.01 美元。
- key 没有出现在结果文件、这次改的文件和实测脚本的目录里（按三个 key 的原文查，0 个文件；`sk-`、`Bearer`、`x-api-key`、
  `authorization` 在结果文件与改动里都是 0 处）；key 方式建的数据目录与复制出的目录里加密的 `credentials.json` 已由脚本删掉。

没有跑的（你 2026-10-28 定：只跑必要的）：`v1-models-existing.mjs` 的预设、整套的 App 套件与回放、`spec-coverage`
（这个工作树里只有 `v1-models-real.json` 一个界面结果文件，覆盖检查要等推送前的完整回归）；`app/src` 没有改，所以没跑 `test:quick`。

## 未验证

2026-10-26 注（[WP-04](walkthrough-1026/WP-04.md)，负责人走查 M7 决定 1）：探针第 8、9 步（长输入、取消）连同合成端点的
`/metrics`、`-truncate`、`-nocancel` 都删掉了，下面提到它们的三条（指标、截断与取消的模拟，需要你同意的两个探针，第 8、9 步按档案
选强度）不再适用，只作原来的记录；发出后超时现在总是等满 2 分钟再换（规格 §5.7），在真实的自建服务上没有验证，见 WP-04 的“没有验证的”。

- 内网 vLLM、SGLang、llama.cpp、Ollama：只用合成端点模拟过它们的版本接口、指标、截断和取消（2026-10-26：指标、截断、取消的模拟已删掉）；真实的 429 `Retry-After`、5xx、长输入截断没有在真实端点上触发过。
- 需要你同意的两个探针（长输入、取消）只在合成端点上跑过（2026-10-26：这两个探针已删掉）。
- 思考关不掉的模型（2026-10-24）：
  - 只在 OpenRouter 上实测过；Anthropic、百炼、MiniMax 等别的服务上必须思考的模型没有测（§7.7 末尾、proposal §10 的已知限制）。
  - 会话里 Off 提到的 Minimal 没有探针测过，只实测过它在 OpenRouter 上能发（flint 收到 Minimal 正常回答）。
  - z.ai、Together 的地址按规格不受影响（有标记的模型每个请求都带强度），没有在真实端点上测。
  - TaskBoard 实例、增强会话、压缩与重建经虚拟模型路由、由 pi 收紧强度：按代码与 pi 1.3.0 的源码核对过，只有对话请求在 App 层
    （`fake-coder-nooff`）与真实层（flint）实测过，这几种请求没有对有标记的模型单独跑。
  - 需要你同意的第 8、9 步按档案选强度只在单元层测过（替身的流），没有对合成端点或真实模型跑（2026-10-26：第 8、9 步已删掉）。
  - （2026-10-28 注：这一条已由换模型取代，MP-40 现在用 `minimax/minimax-m3.1-flash` 与 `liquid/lfm-2.5-24b-a2b`，2026-10-28 的
    真实运行全部通过，见上面“思考关不掉的模型：换模型”；下面是原来的记录。）
    **MP-40 的 lfm 一条（`liquid/lfm-2.5-2.6b:free`）未验证：外部限流**（你 2026-10-24 定：到此为止，记为未验证；MP-40 的写法
    不再改）。三次真实运行（key 方式，2026-10-24）：
    1. 探针被 OpenRouter 回 429：“liquid/lfm-2.5-2.6b:free is temporarily rate-limited upstream”。
    2. 第 1–5 步与回传检查如预期，第 6 步（JSON schema，`medium`）停在 256 token 的输出上限、只有思考，按 §7.7 为出错
       （“Stopped at the probe output limit before answering”）。这一次按改过的 MP-40 会通过，但它的结果文件是按旧的写法
       （“等级 B”）记的，覆盖检查读到的是失败。
    3. 按改过的写法：第 1–5 步与回传检查如预期（`tool_calling: verified`、`off_refused: true`），第 6 步被 OpenRouter 回 429：
       `code 429`、`provider_error_code: model_rate_limit_exceeded`、`limit_source: upstream_provider_shared_pool`、
       提供方 Liquid、`Retry-After: 1`、“Please retry shortly, or add your own key …”。探针按 §7.3 记为出错，等级为空，
       不是改过的写法接受的两种结果之一。
    三次里 MP-27 与 MP-40 的其余各条都通过（每次 22 / 23）；Mori 的行为都按规格（429 记为出错，停在输出上限记为出错）。
  - 所以现在 `node tests/spec-coverage.mjs --spec model` 只差这一条（MP-40 的真实层）。TaskBoard、记忆、一键拉取模型的覆盖检查
    （`--spec taskboard`、`--spec memory`、`--spec discovery`，都带 `--allow-missing-real`）也失败：它们读的现有套件结果
    （`tb-replay-existing.json`、`mem-replay-existing.json`、`md-replay-existing.json`）里记着那一次运行时模型层覆盖检查的结论
    （失败），要等 MP-40 有一次通过的真实结果、之后再跑一遍 `v1-models-existing.mjs --id MD-15` 才会变成通过。除此之外这几项
    覆盖检查没有别的缺口（第二遍完整回归 3634 项通过、1 项 KNOWN）。

以后要补跑时（在 `app/` 下，PowerShell；免费模型每天有请求上限，挑 OpenRouter 不忙的时候。2026-10-28 注：MP-40 换成两个付费模型，
不再受免费模型的上限与上游限流影响，一次运行约 0.002 美元；命令不变）：

```powershell
npx electron-vite build
# key 方式：三个 key 由你从 HoldThatThgt 下的 env 文件读出、设在这个进程里（不要打印）；不给 --source
$env:MP_REAL_DEEPSEEK_KEY = '<deepseek.env 的 DEEPSEEK_NODE_KEYS>'
$env:MP_REAL_GLM_KEY = '<glm.env 的 api_key_env>'
$env:MP_REAL_OPENROUTER_KEY = '<openrouter.env 的 OPEN_ROUTER_NODE_KEYS>'
node tests/ui/v1-models-real.mjs
Remove-Item Env:MP_REAL_DEEPSEEK_KEY, Env:MP_REAL_GLM_KEY, Env:MP_REAL_OPENROUTER_KEY
node tests/spec-coverage.mjs --spec model
# 上一条通过之后（约 95 分钟）：
node tests/ui/v1-models-existing.mjs --id MD-15
node tests/spec-coverage.mjs --spec model
node tests/spec-coverage.mjs --spec taskboard --allow-missing-real
node tests/spec-coverage.mjs --spec memory --allow-missing-real
node tests/spec-coverage.mjs --spec discovery --allow-missing-real
```

脚本一启动就把三个变量读进内存并从它自己的环境里删掉，之后启动的 Mori 拿不到；结果写到 `test-results/v1-models-real.json`，
key 方式建的数据目录在系统临时目录下（`mori-v1-real-keys-*`，用完删掉加密的 `credentials.json`）。
