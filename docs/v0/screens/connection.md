# 连接表单与首次启动（M1）

依据：方案 5.2。同一个表单出现在三处：首次启动、"设置 → 连接"（Settings → Connections and models）、错误卡上的"Go to settings"。

> v1 已取代本文（docs/specs/model-providers.md §9.1、§9.3）：v0 的连接表单（`ConnectionForm.tsx`）已删除，本文的字段和状态表只是 v0 的记录，
> 里面的文字（"Loading connections…"、"Couldn’t load connections: …"、"Save"、"Saved" 等）界面上已经没有了。现在的状态表：
> 首次启动表单（加了网络区域，写 Mori 的 `model-config.json`，§4.1）见 [../../v1/screens/first-run.md](../../v1/screens/first-run.md)；
> "Settings → Connections and models"由 Settings → Models 取代，见 [../../v1/screens/models-settings.md](../../v1/screens/models-settings.md)；
> "Go to settings"删除（§9.3）。只有下面"首次启动之后：打开文件夹"一节仍然有效（first-run.md 沿用它）。界面文字见 [../ui-strings.md](../ui-strings.md)"首次启动""设置"。

## 字段

> v1：见 docs/specs/model-providers.md §9.1（首次启动表单的字段）、§4.1（写到 `model-config.json`）。

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| 名称（Name） | `models.json` 中 `mori-endpoint` 的 `name` | 必填 |
| 服务地址（Base URL） | `baseUrl` | 必填，必须是 URL |
| 接口类型（API type） | `api` | 默认"OpenAI-compatible (Chat Completions)"= `openai-completions`；另有 `openai-responses`（"OpenAI Responses"）、`anthropic-messages`（"Anthropic Messages"） |
| API key | Mori 加密保存（`credentials.json`），不写 `models.json` | 密码框；占位文字"Kept encrypted on this computer after you save"，已保存时"Saved and encrypted · Re-enter it if you change the base URL" |
| 模型 ID（Model ID） | `models[0].id` | 必填 |
| 上下文长度（Context window） | `models[0].contextWindow` | 正整数，默认 128000（临时默认值） |
| 兼容选项（Compatibility options） | `compat` 中对应字段 | 只在接口类型为 OpenAI 兼容时显示；勾选写入，取消勾选删除该字段；手写的其他 `compat` 字段保留。列表见 `docs/v0/defaults.md` |

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中（v1：见 v1/screens/first-run.md：整窗"Loading…"，不显示表单） | 启动后 `config.get` 尚未返回 | 表单不可编辑，"Loading connections…" | 无 |
| 读取失败（v1：见 v1/screens/first-run.md："Couldn’t load model settings: "加原文） | `config.get` 报错 | "Couldn’t load connections: "加错误原文 | 重新打开 App |
| 首次启动（v1：见 docs/specs/model-providers.md §9.1、§9.4 `firstRun`） | `config.get` 返回没有已保存的连接 | 整窗只有连接表单，标题"Connect a model"，一句说明"Enter the base URL, API key, and model ID, then test the connection." | 填写、"Save"、"Test connection" |
| 已保存的连接（v1：见 docs/specs/model-providers.md §9.1：已有配置时不显示这张表单） | `config.get` 返回已保存连接 | 表单回填（key 不回填，只在占位文字里提示"Saved and encrypted · Re-enter it if you change the base URL"） | 修改、"Save"、"Test connection" |
| 有未保存的修改 | 你改了任一字段 | "Save"可用 | "Save"；"Test connection"（会先保存） |
| 保存中 | 你点了"Save"或"Test connection" | 按钮不可用，"Saving…" | 无 |
| 已保存（v1：见 docs/specs/model-providers.md §9.4：`connection.save` 删除，改为 `models.firstRun`） | `connection.save` 返回无错误 | "Saved" | "Test connection" |
| 保存后 pi 报告配置错误（v1：见 docs/specs/model-providers.md §4.4 第 5 步、§9.4） | `connection.save` 返回 `error` | "Saved, but the configuration has an error: "+ 原文 | 修改后再保存 |
| 保存失败（v1：见 docs/specs/model-providers.md §9.4、§4.1 改地址删除 key） | `connection.save` 报错（例如改了服务地址却没填 key） | "Couldn’t save: "+ 原文（例如"Couldn’t save: API key is required when the base URL changes"） | 修改后再保存 |
| 测试中（v1：见 docs/specs/model-providers.md §9.1：不用 30 秒总时限） | 你点了"Test connection" | 按钮变为"Testing…"，旁边出现"Cancel" | "Cancel" |
| 测试已取消 | 你点了"Cancel"，`connection.test` 返回取消 | "Test cancelled" | 再次测试 |
| 测试成功（v1：见 docs/specs/model-providers.md §9.1：之后在表单下方显示探针状态） | `connection.test` 返回 `ok` | "Connected · First token Nms · Total Nms"（有思考内容时加" · Includes thinking"），再加" · Response: "和回复开头 | 首次启动时进入"Open folder…"（标题"Connected"） |
| 测试失败 | `connection.test` 返回 `error` | "Connection failed: "+ 错误原文（没有原文时"No response"） | 修改、再次测试 |

## 首次启动之后：打开文件夹

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 等你选文件夹 | 首次启动时测试成功；或已有连接但还没打开任何会话（M3 起侧栏有会话时说明改为"Pick a session on the left to continue, or open a folder to start a new session."，见 [sessions.md](sessions.md)） | "Open folder…"按钮和一句说明"Choose a project folder to start a session."（还没打开会话时标题"Open a folder"） | "Open folder…" |
| 选择中 | 系统对话框打开 | 系统对话框 | 选择或取消 |
| 正在打开 | 选好了文件夹，`session.create` 尚未返回 | "Opening <文件夹名>…" | 无 |
| 打开失败 | `session.create` 报错 | "Failed to open session: "+ 原文 | 再次打开 |
| 已打开 | `session.create` 返回 | 进入三栏布局，中栏是新会话的空状态 | 发第一条消息 |

（v1：见 docs/specs/model-providers.md §9.1：添加提供商改用设置 → Models 的提供商表单。）
M6 起可以有多个连接、每个连接下多个模型，"Add connection"用的就是这张表单（多了"Supports thinking"和"Default effort for new sessions"），
见 [settings.md](settings.md)。

## 作为"Settings → Connections and models"与"Go to settings"的落点

> v1：见 docs/specs/model-providers.md §9.1、§9.3：由设置 → Models 取代，"Go to settings"删除；保存后打开着的会话不再换模型对象，下一个请求起按新配置选择（§4.4 第 6 步）。

- 中栏换成设置页，顶部"Back to app"；返回时会话的滚动位置、草稿都在（会话面板没有卸载，只是隐藏）。
- 从错误卡"Go to settings"进入时，同一页面，焦点放在 API key 输入框。
- 保存后已打开的会话用新配置（M0：整个后台进程共用一个 ModelRuntime，保存后 `refresh()`；M6 查明打开着的会话仍拿着旧的模型对象，
  改为保存后把它们换成新的模型对象，见 [../m6-checks.md](../m6-checks.md)）。
