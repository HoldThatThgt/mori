# 首次启动

依据：规格 §4.5（迁移与迁移失败）、§4.1（配置读不出）、§7.4（首次启动保存后跑探针）、§9.1“首次启动表单”、§9.4、§9.5、§12。
取代 [v0 connection.md](../../v0/screens/connection.md) 的连接表单与首次启动；“首次启动之后：打开文件夹”沿用 v0。
表单改为英文（规格 §9.1），写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `config.get` 的结果 | `firstRun`（`model-config.json` 不存在，且没有迁移成）、`migrationError`（迁移失败的原文）、`configError`（配置存在但读不出） |
| `models.firstRun` 的结果 | `{ providerId, error }`：一次写入提供商、模型、key 和 `normalDefault` |
| `connection.test` 的结果 | `{ providerId, modelId }` 的测试结果（成功 / 失败 / 已取消） |
| `mori.profiles` | 这个模型的档案与 `running`：探针状态 |
| 你的操作 | 填写、选区域、Test connection、Verify again、Open folder… |

## 进入与不进入

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 启动后 `config.get` 还没返回 | 整窗“Loading…”（临时，走查时可以改），不显示表单 | — |
| 读取失败 | `config.get` 报错 | “Couldn’t load model settings: <原文>” | 重新打开 App |
| 首次启动 | `config.get` 的 `firstRun` 为真 | 整窗只有首次启动表单：标题“Connect a model”，说明“Enter the base URL, API key, and model ID, then test the connection.”（都是临时，走查时可以改） | 填写；Test connection |
| 迁移失败 | `firstRun` 为真且 `migrationError` 不为 null（`models.json` 读不出、或明文 key 加密失败，§4.5） | 表单上方“Couldn’t import your previous model settings: <原文>”（临时，走查时可以改）；表单为空（各字段的默认值） | 同首次启动 |
| 已有配置 | `firstRun` 为假、`configError` 为 null | 不显示表单，进入三栏布局（迁移刚成功时直接打开 设置 → Models，见 models-settings.md） | — |
| 配置读不出 | `configError` 不为 null | 不显示表单，进入三栏布局；会话一律按 `config_invalid` 拒绝启动（model-chat.md）；设置 → Models 只显示这条错误 | — |

## 表单字段

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| Name | 提供商 `name`；提供商 `id` 由它生成（§4.1） | 必填 |
| Base URL | `baseUrl` | 必填，http 或 https URL |
| API type | `api` | “OpenAI-compatible (Chat Completions)”（默认）、“OpenAI Responses”、“Anthropic Messages”（§9.1） |
| Network zone | `zone` | 必选；Local / Intranet / Public，按 §12 的规则由 Base URL 预选建议值；你还没手动选过时随 Base URL 变，选过之后不再自动改（同提供商表单，临时，走查时可以改） |
| API key | 主进程加密保存，`keys: [{ ref: <id>#1, label: "Key 1" }]` | 可空（空时请求不带认证头，§8.4）；密码框；占位文字：没保存过时“Optional”，保存过时“Saved. Leave empty to keep it.”（都是临时，走查时可以改）；不回填明文 |
| Model ID | `models[0].id` | 必填，不含空白 |
| Context window | `contextWindow` | 正整数；默认 128000（§9.1） |
| Max output | `maxTokens` | 正整数，小于窗口；默认 16384 与窗口一半中较小的（§9.1、§12），你没改过时随窗口变 |
| Supports thinking | `reasoning` | 勾选框 |
| Compatibility options | `compat` 的六个字段 | 只在 API type 为 `openai-completions` 时显示；每个勾选框是 §9.1 的标签，下面一行小字说明（沿用 english-ui，临时，走查时可以改） |

表单没有 Family、Image input、Concurrency per key、Default effort for new sessions（规格 §9.1 的字段列表里没有；建好后在设置 → Models 里改）。
字段错误的文字同 [models-settings.md](models-settings.md)“字段错误的文字”。

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 填写 | 你改了任一字段 | 字段错误时字段旁英文错误；有错误时 Test connection 不可用 | Test connection |
| 区域为 Public | 你在 Network zone 选了 Public（或预选为 Public） | 区域下方“Public providers must be allowed per project. You’ll be asked when you open a folder.” | 改选 |
| 保存中 | 你点了 Test connection，表单有改动（从没保存过也算有改动，临时，走查时可以改）：`models.firstRun`（`providerId` 第一次为 null，之后为上次返回的 id；API key 框为空时 `keySecret` 为 null，保留已存的 key） | 按钮“Saving…”（临时，走查时可以改），不可用 | — |
| 保存失败 | `models.firstRun` 返回 `error`（配置写失败时本次新存的 key 已删除） | “Couldn’t save: <原文>”（临时，走查时可以改）；不开始测试 | 修改后再试 |
| 测试中 | 保存成功后（或表单没改动时）`connection.test`（`{ providerId, modelId }`） | 按钮“Testing…”（临时，走查时可以改），旁边“Cancel”；没有 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限（120 秒），`server` 不重试 | Cancel（`connection.testCancel`） |
| 测试已取消 | `connection.test` 返回已取消 | “Test cancelled”（临时，走查时可以改） | 再次测试 |
| 测试失败 | `connection.test` 返回 `error` | “Connection failed: <原文>”（§9.1；没有原文时“Connection failed: No response”）；不出现 Open folder… | 修改，再 Test connection |
| 测试成功 | `connection.test` 返回成功 | “Connected · First token Nms · Total Nms”，有思考内容时加“ · Includes thinking”，有正文时加“ · Response: <前 200 字>”（§9.1）；“Open folder…”；表单下方探针状态（下表） | Open folder…；修改后再测 |
| 再次保存同一张表单 | 测试过之后你改了字段再点 Test connection | `models.firstRun` 带上次的 `providerId`：整体替换这个提供商和它唯一的模型，不新建第二个提供商（MP-33）；探针按新模型重新开始 | — |

## 探针状态（表单下方）

首次启动表单保存后后台进程对这个模型自动跑第 0–7 步（§7.4）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 验证中 | `mori.profiles` 的 `running` 有这个模型，或档案 `status` 为 `probing` | “Verifying tool calling…” | Open folder…（打开后会话按 `verifying` 拒绝启动，探针结束自动解除） |
| 已验证 | 档案 `tool_calling.state` 为 `verified` | “Tool calling verified” | Open folder… |
| 验证失败 | `tool_calling.state` 为 `failed`；`<detail>` 取第 3、4 步结果里判定不通过的那一步的 `detail` | “Tool calling failed verification: <detail>. Mori needs tool calling for the main agent; pick another model or check the server’s tool-call settings.” | 改表单（例如 Model ID）再 Test connection；Open folder…（打开后会话按 `no_candidate` 拒绝启动） |
| 探针出错 | 档案 `status` 为 `error` | “Couldn’t verify: <原文>”和“Verify again” | Verify again（`models.verify`，`refs: [这个模型]`，`tests: 'auto'`）；改表单再测 |

## 打开文件夹之后

沿用 [v0 connection.md](../../v0/screens/connection.md)“首次启动之后：打开文件夹”。新会话的范围是首次启动写下的
`normalDefault`（就是这个模型）。会话是否能发送看拒绝启动卡（model-chat.md）：

- 区域为 Public：项目还没授权，卡上有“Allow public for this project”，点了进 设置 → Models 的 Project access，
  焦点在这个项目，勾 Public 并确认后可以发送（MP-33）；
- 探针还在跑：`verifying`；探针判定失败：`no_candidate`。

## 反例

- 已经有配置（含迁移成功）时不显示首次启动表单；配置存在但读不出时也不显示。
- tool calling 判定失败后改 Model ID 再测，配置里仍只有一个提供商。
- 表单不回填 key 明文。
- 测试连接没有 v0 的 30 秒总时限，也不做原地重试。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中“Loading…”、读取失败“Couldn’t load model settings: ”；标题“Connect a model”与一句说明；
迁移失败的前缀“Couldn’t import your previous model settings: ”；API key 的两种占位文字；兼容选项的标签与说明沿用 english-ui；
从没保存过的表单点 Test connection 先保存；“Saving…”“Testing…”“Test cancelled”；保存失败的前缀“Couldn’t save: ”；
区域建议值随 Base URL 变、手动选过后不再变；Max output 没改过时随窗口变。

## 需要规格回答

- 表单要对还没保存的 Base URL 预选建议区域，界面从哪里拿到 §12 的建议（见 models-settings.md 同名一节）。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 表单 | `data-testid="connection-form"`（沿用 v0，`tests/ui/page.mjs` 用它）；区域单选 `input[name="zone"][value]`；Public 的说明 `data-testid="zone-public-note"`；字段错误 `[data-testid="field-error"][data-field]` |
| 读取中 | `data-testid="first-run-loading"` |
| 迁移失败 | `data-testid="migration-error"` |
| 结果文字 | `data-testid="form-message"`（沿用 v0） |
| 按钮 | “Test connection” `data-action="test"`；测试中的取消 `data-action="test-cancel"`（同 models-settings.md） |
| 探针状态 | `data-testid="probe-status"`，`data-state` 为 `verifying` / `verified` / `failed` / `error`；“Verify again” `data-action="verify"` |
| 打开文件夹 | `data-testid="open-folder"`（沿用 v0） |
