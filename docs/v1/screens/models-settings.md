# 设置 → Models

依据：规格 §4（配置、删除的连带改动、改地址、配置读不出、迁移）、§7（档案与探针）、§8.3（key 的记录）、
§9.1、§9.3、§9.4、§9.5；[一键拉取模型构建规格](../../specs/model-discovery.md)（下称“拉取规格”）§5（命令与结果）、
§6.1–§6.5（Add provider 表单、清单、列表错误、Add a model ID、卡上的 Fetch models）、§7.2（档案的报告值）、§8（模型行的提示）、
§11（临时默认值）。
不加前缀的“规格”指[统一模型提供商构建规格](../../specs/model-providers.md)。
取代 [v0 settings.md](../../v0/screens/settings.md) 的“Connections and models”分节；AGENTS.md 分节不变（2026-10-26 改：AGENTS.md 挪到 Customize，见 [customize-agents-md.md](customize-agents-md.md)）。
界面文字为英文（规格 §0），写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

2026-10-24 补（规格 §7.7“思考关不掉的模型”，负责人选定方案 B）：档案摘要加“Thinking: Can’t be turned off”（第 2 步的说明只存在
`model-profiles.json` 里，`ProfileView` 不带，设置页不显示）；模型表单（Edit）的
Default effort for new sessions 对这类模型不列 Off、存着的 Off 显示为 Minimal；三处测试对勾了 Supports thinking 的模型带 `medium`；
补丁之前留下的“Couldn’t verify: <原文>”（服务回的 400）点一次 Verify 重新测，不自动重跑；回复停在探针输出上限、只有思考时显示为出错。
改动的行都标了“2026-10-24 补”。

2026-10-26 改（负责人走查 M1、M6、M7、M8，[WP-02](../walkthrough-1026/WP-02.md)）：模型行只留模型 id、说明一行（窗口、最大输出、模型族、
支持思考、“Thinking can’t be turned off”）、“Use”的提示和一行状态；状态只在第一次验证进行中、或模型因为 tool calling 没验证通过
而不能用时显示，失败时带“Verify again”。Verify、Long-input test…、Cancel test…、行上的 Test、整个档案摘要（Tool calling、
Handoff tier、Context、Reasoning field、Cancel）、截断告警和两种需要同意的探针的确认框都删掉；探针第 0–7 步照旧自动跑，选择器、
编译与 TaskBoard 照旧读档案（长输入与取消探针在后台进程里的代码由 WP-04 删除；2026-10-26 已删，见下面“需要你同意的探针”）。服务没报告的值只在仍等于 Mori 的默认值时标
“(default)”（清单里是“Default”），悬停说明；兼容选项上面加一行说明，“Endpoint doesn’t support strict mode for tool parameters”
一项删掉（存着的照样读得出），提供商卡上的“Compatibility options”只对 OpenAI-compatible 显示；测试连接总是发出（规格 §8.3 的
2026-10-26 补）。改动的行都标了“2026-10-26 改”。

2026-10-26 改（负责人走查 M5，原话“use drag to order model, not arrow button”，[WP-03](../walkthrough-1026/WP-03.md)）：Keys、
Models 与分组成员的上移、下移按钮删掉，换成每行左端的拖动柄：用鼠标拖，或焦点在柄上时按上、下方向键移一格；一次放下只保存一次
（规格 §9.1“拖动排序”、§9.5）。状态表见下面新的一节“拖动排序”；改动的行标了“2026-10-26 改（M5）”。

2026-10-26 改（负责人走查 M3“we do not need to separate local, intranet or public model”，[WP-05](../walkthrough-1026/WP-05.md)）：
网络区域与按项目授权删掉。“区域未确认”与“Project access”两节、Defaults 的“Allowed zones for all projects”、提供商卡的“Network zone”、
Add provider 与 Edit 的 Network zone 单选、“区域的建议值”、从拒绝启动卡的“Confirm zone”“Allow <zone> for this project”进入的两种方式
都删掉；`models.get` 不再有 `zoneSuggestions`、`projects`。还写着 `zone`、`allowedZones`、`projectZones` 的配置按“配置读不出”显示
（不写兼容代码，删掉这几个字段后点 Retry）。项目的 `.mori/models.json` 有错时只在会话的拒绝启动卡上显示（原来 Project access 里也有）。

2026-10-26 补（负责人走查回答 1，[WP-15](../walkthrough-1026/WP-15.md)，拉取规格 §4.4）：服务没报告的窗口、最大输出、是否支持思考，
pi 按地址认得这个服务并且有这个 id 时取 pi 自带的模型表（例如 `api.z.ai` 的 glm-5.3 取 pi 的 Z.AI 条目）。清单里这些值旁边写
“From pi”，模型行写“(from pi)”，悬停说明写出 pi 的提供商名；仍是 Mori 默认值的模型行另有三条 pi 的提示和 Use。改动的行都标了
“2026-10-26 补（WP-15）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `models.get` / `models.reload` 的结果 | `config`（key 只有 `{ ref, label }`）、`profiles`、`keyStatus`（每个有记录的 key：`{ state, until }`）、`thinkingDefaults`（每个模型在 pi 设置 `modelThinkingLevels` 里的新会话强度，没设时为 null）、`migration`（迁移说明或 null）、`loadError`（配置读不出时的路径与原文）、`reserved`（保留 id） |
| `models.*` 写命令的结果 | `error: string \| null`；`models.saveProvider` 另给 `providerId`（新建时收 `models`：清单里勾选的行，拉取规格 §5.4），`models.addKey` 另给 `ref`；`models.addModels`（`{ providerId, models }`，拉取规格 §5.4）只有 `error` |
| `models.discover` 的结果（拉取规格 §5.2） | `DiscoverResult`：`error`（命令本身失败）、`cancelled`、`server`（`{ kind: ServerKind, version }`，没拿到列表时为 null）、`api`、`baseUrl`（建议的 Base URL）、`name`、`anthropicShape`、`listError`（`{ kind: 'rejected' \| 'unreachable' \| 'no_list' \| 'invalid', detail }` 或 null）、`models`（`DiscoveredModel[]`，列表顺序：`id`、`contextWindow`、`maxTokens`、`reasoning`、`image`、`family`、`chat`、`reported`、`hints`、`unusable`、`added`）、`truncated`、`notListed`。只在表单状态里，表单关闭就丢掉，不缓存（拉取规格 §9） |
| `models.discoverCancel` 的结果 | `{ error }`；被取消的那次 `models.discover` 返回 `cancelled: true`（拉取规格 §5.3） |
| `mori.profiles`（全局信封） | 全部 `ProfileView`，以及 `running: { ref, step, of }[]`（正在跑的探针）。`ProfileView.reported`：`{ contextWindow, maxTokens, reasoning, image }`（各项为 number / boolean 或 null），档案没有 `meta` 时整个为 null；Ollama 只读到训练窗口时 `contextWindow` 为 null（训练窗口不记作报告，拉取规格 §7.2）。`ProfileView.reasoning.off_refused`（2026-10-24 补，规格 §7.2、§7.7）：第 2 步关闭思考被 400 或 422 拒绝、开思考（`medium`）有正文时为 true，这时 `can_disable` 为 false；补丁之前的档案（没有 `auto.offRefused`）读作 false，不重新探测。`ProfileView` 不带第 1、2 步与回传检查各自的结果（只有由它们得出的 `reasoning` 各值，以及出错时的 `status`、`error`）；规格 §7.7 写明第 2 步的说明（含“Thinking can’t be turned off: <原文>”）只存在 `model-profiles.json` 第 2 步的结果里，`ProfileView` 不带 |
| `mori.key_status`（全局信封） | 全部有记录的 key：`ref → { state: 'rate_limited' \| 'auth' \| 'quota', until }`；key 的记录变化时发出 |
| `connection.test` 的结果 | `{ providerId, modelId, keyRef? }` 的测试结果：成功（首字时间、总时间、是否有思考内容、回复开头）、失败（原文）、已取消。（2026-10-24 补，规格 §7.7、§12：测的模型勾了 Supports thinking 时请求带思考 `medium`，否则不带思考参数；命令与结果的字段不变）（2026-10-26 补，规格 §8.3：测试不看提供商、模型与 key 的不可用记录，总是发出，结果是服务这一次的回答） |
| `config.get` 的结果 | `configError`（配置读不出，§4.1）、`settingsError`（pi 的 `settings.json` 读不出，沿用 v0）、`defaultThinkingLevel`（pi 设置的默认思考强度；模型表单 Edit 里没设过强度的模型显示它，拉取规格 §5.4） |
| `shared/models.ts` | `SERVER_KIND_LABELS`（Detected 一行的种类名，拉取规格 §3.3） |
| 你的操作 | 打开分节、打开表单、填 Base URL 和 API key、Fetch models、勾选清单的行、改值、Add a model ID、Use、确认框、勾选 |

写命令成功后界面重新调 `models.get`，按它的结果显示（临时，走查时可以改）；两次之间档案与 key 记录由
`mori.profiles`、`mori.key_status` 更新。`models.discover`、`models.discoverCancel` 不是写命令：不进写入队列，不重新调 `models.get`
（拉取规格 §5.1）。

## 外框与进入方式

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开设置页 | 你点了侧栏“Settings” | 左侧分节“Models”（取代“Connections and models”）与“UI issues”（2026-10-26 改：“AGENTS.md”挪到 Customize）；落在 Models | 切换分节 |
| 迁移后第一次启动 | 后台进程这次启动迁移成功（§4.5）；`models.get` 的 `migration` 不为 null | 启动后直接打开 设置 → Models，顶部是迁移说明 | 同下 |
| 从拒绝启动卡的“Open settings”进入 | 你点了它（§4.6） | 设置 → Models，停在顶部 | 同下 |
| 从 No model available 卡的“Open settings”进入 | 你点了它（§9.3） | 设置 → Models，滚到第一个被排除候选的提供商卡；原因是 `auth`、`quota` 时焦点在它的 Keys（第一行） | 同下 |
| 从“Manage models”进入 | 你点了范围菜单底部这一项（§9.2） | 设置 → Models，停在顶部 | — |
| 读取中 | `models.get` 还没返回 | “Loading…”（临时，走查时可以改），各节不显示 | — |
| 读取失败 | `models.get` 返回 `error` | 原文 | 重新打开设置页 |
| 配置读不出 | `models.get` 的 `loadError` 不为 null（`model-config.json` 存在但不是合法 JSON 或校验失败，§4.1；2026-10-26 起还写着 `zone`、`allowedZones`、`projectZones` 的旧文件也是这样，原文是“Unrecognized key”并指出位置） | 只显示这条错误：“Couldn’t read model settings: <路径>: <原文>”（拒绝启动卡 `config_invalid` 写“Model settings can’t be read: …”）和“Retry”；其他各节都不显示 | Retry（`models.reload`；修好文件后结果里 `loadError` 为 null 时显示完整的分节） |
| pi 设置读不出 | `config.get` 的 `settingsError` | 分节上方原文（带文件路径），同 v0 | 修好文件后重新打开设置页 |

从上到下的顺序：迁移说明 → Defaults → Providers → Groups（§9.1；2026-10-26 改：区域未确认与 Project access 删掉）。
各节标题就是这几个英文名（Defaults、Providers、Groups）。

## 保存方式（§9.1）

- 立即保存：Defaults 的默认范围、Groups 的每次改动、Keys 的加删与拖动排序、模型的拖动排序（2026-10-26 改（M5），
  原来是上移下移；一次放下、一次方向键各保存一次，见“拖动排序”）、Dismiss、模型行提示的“Use”（拉取规格 §8）。
  改了就发对应的写命令，没有 Save 按钮。
- 按按钮保存：Add provider 表单与卡上清单的 Add 按钮（“Add N models”，拉取规格 §6.1、§6.5）；Edit provider、模型表单（只有 Edit）
  的“Save”（以及 Keys 的 Add key 内联表单，它的“Save”就是这一次加 key）。
- Fetch models 不保存：只读服务的模型列表，结果只在表单里；点 Add 之前不写任何文件，表单关闭就丢掉（拉取规格 §5.1、§9）。
- 立即保存成功时没有额外提示（临时，走查时可以改）；失败时在控件旁显示原文，控件回到保存前的值。

## 迁移说明

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有迁移说明 | `models.get` 的 `migration` 不为 null（`model-migration.json` 存在） | Models 顶部一块说明，文字见下 | Dismiss |
| 已关闭 | 你点了“Dismiss”，`models.dismissMigration` 返回无错误 | 说明消失；重启后也不再显示 | — |
| 关闭失败 | `models.dismissMigration` 返回 `error` | 说明仍在，下方原文 | 再点 Dismiss |
| 没有迁移说明 | `migration` 为 null | 不显示 | — |

说明的文字（都是临时，走查时可以改；按 `MigrationNotice` 的字段，没有内容的行不显示）：

| 字段 | 文字 |
| --- | --- |
| 标题 | “Imported your model settings from models.json” |
| `providers` | “Imported: <name>, <name>, …” |
| `providers` 中 `from` ≠ `id` 的 | 每个一行“Renamed provider <from> to <id>” |
| `dropped` | 每个一行“Dropped <subject>: <reason>”（`reason` 是后台进程写的英文原因） |
| `reenterKeys` | “Add the API key again for: <name>, …”（v0 用 `$` 环境变量写法的） |
| `keptCiphertext` | “Kept the saved key for: <name>, …; the key written in models.json was ignored.” |
| 按钮 | “Dismiss” |

## Defaults

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 默认范围 | `config.normalDefault` | 标签“Default model range for new sessions”；下拉，分三节，节名“Groups”“Providers”“Models”（同范围菜单）；项：分组写 id，提供商写名称，模型写“<provider name> · <model id>”（同 Groups 成员的写法）；当前值选中；为 null 时“None”，“None”是第一项 | 选一项或“None” |
| 保存 | 改了默认范围立即 `models.setDefaults`（`{ normalDefault }`；2026-10-26 改：“Allowed zones for all projects”删掉） | 保存中控件不可用；失败时原文，控件回到保存前的值；成功时没有额外提示 | — |
| 已有会话 | §5.1：已有会话的范围不随默认范围改变 | 不提示（规格没有提示文字） | — |

## Providers

### 提供商卡

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `config.providers`（按配置顺序） | 每个提供商一张卡：名称；“Base URL”、“API type”（三种显示名同表单）、“Concurrency per key”（2026-10-26 改：“Network zone”一行删掉）、“Compatibility options”（勾了的兼容选项的标签，逗号分隔，不带说明；没有时“None”；2026-10-26 改：只在 API type 为 OpenAI-compatible (Chat Completions) 时有这一行，同表单；配置里存着的 `supportsStrictMode` 没有标签，不列）；下面是 Keys 和 Models 两块。字段名都是临时，走查时可以改 | Edit；Delete…；Test connection；Fetch models（取代原来的“Add model”，见下“卡上的 Fetch models”）；节底部“Add provider”（临时，走查时可以改） |
| 没有提供商 | `config.providers` 为空（例如删掉了最后一个提供商） | “No providers yet. Add one to start a session.”（临时，走查时可以改） | Add provider |
| 测试中 | 你点了“Test connection”，`connection.test`（`{ providerId, modelId: 第一个模型 }`，不带 `keyRef`，用第一个可用的 key）还没返回 | 按钮变为“Testing…”（临时，走查时可以改），旁边“Cancel” | Cancel（`connection.testCancel`） |
| 测试结果 | `connection.test` 返回 | 卡内显示结果，文字见下“测试结果的文字”。没有 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限，`server` 不重试直接报告（§9.1） | 再次测试 |
| 失败后再测（2026-10-26 补，规格 §8.3） | 上一次测试失败（例如 401、404、连不上），什么都没改又点了“Test connection” | 照样发出请求，结果是服务这一次的回答（例如又是“Connection failed: 404 …”），不是因为上一次的失败记录而不发出的“Connection failed: Connection error.”；也不因上一次失败而等待。用第一个没有记录的 key，都有记录时用第一个 key；成功时清除用到的 key 的记录、提供商的 connection 与这个模型的 `not_found` | 再次测试 |
| 删除确认 | 你点了“Delete…” | 确认框，文字见下“确认框的文字”：列出连带改动（§4.1） | Delete；Cancel（焦点在 Cancel，Esc 等于 Cancel） |
| 已删除 | `models.deleteProvider` 返回无错误 | 卡消失；Groups、Defaults 按连带改动更新；范围指向被删名字的打开会话出现 `pick_missing` 拒绝启动卡（model-chat.md） | — |
| 删除失败 | 返回 `error`（例如编译出错回滚，§4.4 第 5 步） | 确认框里原文，不关闭；配置不变 | 再试；Cancel |

### 卡上的 Fetch models（拉取规格 §6.5）

给已有的提供商再拉一次模型列表，勾选新出现的模型加入。用已保存的 key，key 不回到界面。
卡上的清单和提供商表单、模型表单一样，同一时刻只开一张（同现在）：打开别的表单、离开设置页时它关闭；拉取还在进行时先发
`models.discoverCancel`（拉取规格 §6.1、§6.5）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 卡上的按钮 | 提供商卡，没有打开这张卡的清单 | “Fetch models”（卡上不再有“Add model”） | Fetch models |
| 拉取中 | 你点了卡上的“Fetch models”：`models.discover`（`{ target: { kind: 'provider', providerId } }`；用这个提供商第一个不在 `rate_limited`、`auth`、`quota` 记录里的 key，同 Test connection；地址与 `api` 用配置里的，不整理，拉取规格 §5.1）还没返回 | 按钮变为“Fetching models…”，不可用；旁边“Cancel”（同 Add provider 的拉取中，没有 Base URL、API key 两个框，拉取规格 §6.5） | Cancel（`models.discoverCancel`）；打开别的表单或离开设置页（先发 `models.discoverCancel`） |
| 已取消 | 返回 `cancelled: true`（你点了 Cancel，或另一处发起了新的一次发现，拉取规格 §5.3） | 卡回到原样；按钮旁“Fetch cancelled” | Fetch models |
| 命令出错 | 返回 `error` 不为 null（提供商不存在） | 卡里原文 | Fetch models |
| 拉取后 | 返回 `cancelled: false`、`error: null` | 卡里 Models 一块的末尾（同原来 Add model 表单的位置，临时，走查时可以改）打开：清单（见下“清单”）或列表错误（见下“列表错误”）；已在配置里的行（`added`）标“Added”，不能勾、不能改；`notListed` 不为空时清单下面一行“Not listed by the server: <id>, <id>”（这些模型不删除）；“Add a model ID”一行（见下，重复检查含这个提供商已有的全部模型）；底部同 Add provider（拉取规格 §6.1 第 8 项）：“Each model is verified with up to 13 short requests.”、Add 按钮（文字与可用条件见“清单”）、“Cancel”。没有 Name、API type、More settings；**不显示“Detected: …”一行**（拉取规格 §6.5） | 勾选、改值；Add a model ID；Add；Cancel（关闭清单，不写） |
| 清单开着时卡上的按钮 | 这张卡的清单或列表错误开着（拉取后到你关掉它或加入成功） | 卡上的“Fetch models”不可用（拉取规格 §6.5） | — |
| 再拉一次 | 你点了底部的“Cancel”关掉清单，再点卡上的“Fetch models” | 同“拉取中”：重新 `models.discover`，清单、勾选、改过的值和手填的行都不留 | 同拉取中 |
| 加入中 | 你点了 Add：`models.addModels`（`{ providerId, models: 勾选的行，按清单顺序 }`） | 按钮“Adding…”，不可用 | — |
| 已加入 | 返回无错误（一次编译、一次写入，拉取规格 §5.4） | 清单关闭；新模型按清单顺序加在 Models 行的末尾，各自自动开始探针（模型行的状态行“Verifying…”，2026-10-26 改）；卡上的 Fetch models 重新可用 | — |
| 加入失败 | 返回 `error`：任一 id 已在这个提供商里、或同一次里重复时整次拒绝，原文“<id> is already in <provider name>.”；或编译出错回滚 | 清单里原文；配置不变 | 修改后再 Add；Cancel |

### 提供商表单：Add provider（拉取规格 §6.1）

先填地址和 key，拉取后再预填其余字段。表单不再有“First key”“First model”两小节。
表单关闭（表单的 Cancel、打开别的表单、离开设置页）时，拉取还在进行就先发 `models.discoverCancel`（拉取规格 §6.1）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 开始 | 你点了“Add provider” | 标题“Add provider”（临时，走查时可以改）；只有 Base URL（占位“http://host:8000/v1”）、API key（密码框，占位“Optional”，可空）、“Fetch models”（在 API key 下面）、“Cancel”。Base URL 不是 http/https URL 时 Fetch models 不可用（改过 Base URL 后字段旁“Base URL must be an http or https URL.”） | 填写；Fetch models；Cancel（关闭表单，不写） |
| 拉取中 | 你点了“Fetch models”（第一次，或拉取后再点）：`models.discover`（`{ target: { kind: 'new', baseUrl: Base URL 框的值, api, keySecret: API key 框的值，空时为 null } }`；`api` 为你在这张表单里改过的 API type，没改过时为 null，拉取规格 §3.4、§6.1）还没返回 | 按钮变为“Fetching models…”，不可用；旁边“Cancel”；Base URL、API key 两个框只读；表单的“Cancel”（关闭表单）照样可用 | Cancel（`models.discoverCancel`）；表单的 Cancel、打开别的表单、离开设置页（都先发 `models.discoverCancel` 再关闭） |
| 已取消 | 返回 `cancelled: true`（你点了 Cancel，或另一处发起了新的一次发现，拉取规格 §5.3） | 回到开始；Fetch models 旁“Fetch cancelled”，显示到你再点 Fetch models 或改 Base URL、API key（临时，走查时可以改） | 同开始 |
| 命令出错 | 返回 `error` 不为 null（地址或 key 不合格，拉取规格 §5.1；例如 key 含不能放进请求头的字符时“API key contains characters that cannot be sent in a header”） | 停在开始；Fetch models 下方原文 | 修改后再 Fetch models |
| 拉取后 | 返回 `cancelled: false`、`error: null`，不论有没有拿到列表 | 从上到下：Base URL、API key（可以改，见下“改 Base URL 或 API key”）和它下面的“Fetch models”（再拉一次，见下“再拉一次”）；“Detected: …”一行（写法见下，`server` 为 null 时不显示）；Base URL 的替换与说明（见下“建议的 Base URL”）；Name（预填 `name`：主机名，非默认端口时加“:<端口>”）、API type（预填 `api`；三种显示名同 Edit）（2026-10-26 改：Network zone 删掉）——这两项和 More settings 里你在这张表单里改过的，保留你的值，不按这次结果预填；`listError` 为 null 时清单（见“清单”），否则列表错误（见“列表错误”）；“Add a model ID”一行（见“Add a model ID”）；“More settings”（收起，点开后是 Concurrency per key（默认 4，1–64）和兼容选项（只在 API type 为 OpenAI-compatible (Chat Completions) 时，同 Edit：一行说明和五个勾选框，2026-10-26 改））；底部“Each model is verified with up to 13 short requests.”、Add 按钮（文字与可用条件见“清单”）、“Cancel” | 改 Name、API type；勾选、改值；Add a model ID；More settings；Fetch models（再拉一次）；Add；Cancel（关闭表单，不写；key 不保存） |
| 建议的 Base URL | 结果的 `baseUrl` 与 Base URL 框的值不同：两边去掉首尾空白和结尾的 `/` 后比较（拉取规格 §6.1 第 3 项） | Base URL 框换成 `baseUrl`；`listError` 为 null（拿到了列表）时框下面一行“Updated to <url> so the model list loads.”；有列表错误时只换框，不写这一行。这次替换不算你改了 Base URL（不清掉清单） | — |
| 改 Base URL 或 API key | 拉取后你改了 Base URL 或 API key 框 | 清单、列表错误、手填的行都清掉；“Detected: …”、Base URL 的说明一起清掉；Name、API type、More settings、底部一起收起，回到开始。你改过的 Name、API type、More settings 的值留在表单里（收起时不显示），下次拉取后不覆盖；没改过的按下次的结果重新预填（拉取规格 §6.1） | Fetch models |
| 再拉一次 | 拉取后你点了 Base URL、API key 下面的“Fetch models” | 同“改 Base URL 或 API key”：清单、勾选、改过的行值、手填的行都清掉，从头来，进入“拉取中”；你改过的 Name、API type、More settings 照样保留；改过的 API type 作为 `target.api` 发出 | 同拉取中 |
| 改 API type | 拉取后你改了 API type | 清单、手填的行和勾选都不变（拉取规格 §6.1）；兼容选项随 API type 显示或隐藏（同现在）；这个值算“你改过的”：之后再拉取作为 `target.api` 发出，结果不覆盖它 | — |
| 字段错误 | 界面先按 §4.1 检查 | 字段旁英文错误，文字见下“字段错误的文字”；Name、Concurrency per key 有错误时 Add 不可用（同原来的 Save），清单行的错误见“清单” | 修改 |
| 加入中 | 你点了 Add：`models.saveProvider`（`{ id: null, provider: 表单的值, models: 勾选的行，按清单顺序, keySecret: API key 框的值（空时不带） }`） | 按钮“Adding…”，不可用 | — |
| 已加入 | 返回无错误（给 `providerId`，id 由 Name 生成，§4.1；一次编译、一次写入，拉取规格 §5.4） | 表单关闭；新提供商的卡在最后；勾选的模型按清单顺序是它的模型，各自自动开始探针（Models 行显示 Verifying…）；API key 存为它的第一个 key，标签“Key 1”（同现在） | — |
| 加入失败 | 返回 `error`（校验、编译出错回滚，§4.4 第 5 步） | 表单不关，表单里原文；配置不变；本次存下的 key 已被删除（§9.1） | 修改后再 Add |

“Detected: …”一行只在 Add provider 与首次启动表单，卡上的清单没有这一行（拉取规格 §6.5）。
API type 不随这一行变：列表是 Anthropic 形状只改这一行的写法，API type 只按地址或你的选择（拉取规格 §3.4）。
写法（拉取规格 §3.3、§6.1）：

| 情形 | 文字 |
| --- | --- |
| `server` 为 null（没拿到列表） | 不显示 |
| `server.kind` 不是 `unknown` | “Detected: <种类名> <版本>”，种类名取 `SERVER_KIND_LABELS`（vLLM、SGLang、llama.cpp、Ollama、LM Studio、Xinference、GPUStack、MindIE、TGI、LMDeploy、LocalAI、TensorRT-LLM、LiteLLM、New API、One API、DeepSeek、Moonshot AI、Alibaba Cloud Model Studio、Baidu Qianfan、OpenRouter、Anthropic）；`version` 为 null 时只写种类名 |
| `server.kind` 为 `unknown`，`anthropicShape` 为假 | “Detected: OpenAI-compatible server” |
| `server.kind` 为 `unknown`，`anthropicShape` 为真 | “Detected: Anthropic-compatible server” |

### 提供商表单：Edit

Edit 不变：没有 Fetch models、没有清单（拉取规格 §6.1）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Edit | 你点了卡上的“Edit” | 标题“Edit provider · <name>”（临时，走查时可以改）；字段 Name、Base URL、API type（“OpenAI-compatible (Chat Completions)”、“OpenAI Responses”、“Anthropic Messages”）、Concurrency per key（1–64；2026-10-26 改：Network zone 删掉）、兼容选项（只在 API type 为 `openai-completions` 时，每个勾选框是 §9.1 的标签加下面一行说明，沿用 english-ui；2026-10-26 改（负责人走查 M1）：图例“Compatibility options”下面先一行说明“Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this server rejects requests.”（临时，走查时可以改）；勾选框只剩五个，“Endpoint doesn’t support strict mode for tool parameters”删掉（pi 1.3.0 默认就不发 strict，勾不勾都一样）；配置里存着的 `supportsStrictMode: false` 照样读得出，界面不显示，保存时原样保留）；没有 key 和模型字段 | Save；Cancel |
| 字段错误 | 界面先按 §4.1 检查 | 字段旁英文错误，文字见下“字段错误的文字”；有错误时 Save 不可用 | 修改 |
| 改地址的确认 | Base URL 的 origin（协议、主机、端口）变了、提供商有 N 个 key（N ≥ 1），你点了 Save | 确认框，文字见下 | 确认（保存并删除全部 key）；Cancel（不保存，表单留着） |
| 保存中 | `models.saveProvider`（`{ id, provider }`，不带 `models`）还没返回 | 按钮不可用 | — |
| 已保存 | 返回无错误 | 表单关闭；改了地址、接口或兼容选项时 key 与提供商的不可用记录清除（§8.3） | — |
| 保存失败 | 返回 `error`（校验、编译出错回滚，§4.4 第 5 步） | 表单里原文；配置不变 | 修改后再保存 |

### 清单（拉取规格 §6.2）

Add provider 表单、卡上的 Fetch models、首次启动表单（[first-run.md](first-run.md)）共用同一个清单；三处只有清单外面的部分不同。
清单只在表单里，点 Add 之前不写任何文件。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有列表 | `DiscoverResult.models`（列表顺序），`listError` 为 null | 标题“Models (N)”，N 为列表条数（`models` 的条数，不含手填的行，不随过滤变）；右边“Select all”“Clear selection”；每个模型一行（见下“清单的行”），默认勾选见下“默认勾选” | 勾选、取消勾选；改值；Select all；Clear selection |
| 列表为空 | `models` 为空、`listError` 为 null | 标题“Models (0)”，下面一句“The server didn’t list any models.”，再下面是 Add a model ID（拉取规格 §6.2）；手填的行加在这一句下面、Add a model ID 上面，这一句留着；标题行的 Select all、Clear selection 同“有列表”（临时，走查时可以改） | Add a model ID |
| 截断 | `truncated` 为真（列表超过 1,000 条，拉取规格 §11） | 标题下一行“Showing the first 1,000 models.” | — |
| 行多 | 清单的行数（含手填的行）超过 20（拉取规格 §6.2、§11） | 标题下一个过滤框，占位“Filter models” | 输入：按 id 子串过滤显示的行，不分大小写；不改勾选，被藏起来的勾选行照样算进 Add 的 N、照样加入 |
| Select all | 你点了“Select all” | 显示着的、能勾的行（不是 `added`、不是 `unusable`，没被过滤框藏起来）全部勾上；藏起来的行不变 | — |
| Clear selection | 你点了“Clear selection” | 显示着的、能勾的行全部取消勾选；藏起来的行不变 | — |
| 改值 | 你改了一行的 Context window、Max output、Supports thinking 或 Image input | 按模型表单的检查：字段旁英文错误（文字见“字段错误的文字”：窗口不是正整数、Max output 不是正整数或不小于窗口） | 修改 |
| 改窗口 | 你改了一行的 Context window，没改过这一行的 Max output | Max output 随窗口按拉取规格 §4.3 变：服务报告了输出上限、且它小于新窗口时用报告的值；否则为 16384 与新窗口一半中较小的，这时它是默认值，标“Default”（2026-10-26 改，原来是“Not reported”；见下“清单的行”）。（2026-10-26 补（WP-15）：服务没报告、取自 pi 的输出上限小于新窗口时用它，标“From pi”，排在报告值之后、默认值之前） | — |
| 勾选的行有错误 | 勾选的行里有字段错误 | Add 不可用（没勾的行有错误不影响 Add） | 修改或取消勾选 |
| Add 按钮 | 勾选数 N（含勾上的手填行和被过滤框藏起来的勾选行） | N 为 1 时“Add 1 model”，N 大于 1 时“Add N models”；N 为 0 时“Add models”，不可用。首次启动表单的底部不同，见 first-run.md | Add |

清单的行：

| 列 | 内容 |
| --- | --- |
| 勾选框 | 读屏名“Add <id>”；`added`、`unusable` 的行不可用 |
| Model ID | 服务的 id，原样，不能改 |
| Context window | 数字框，值为 `contextWindow`，不写千分位；`reported.contextWindow` 为假、且框里的值仍是 128000 时旁边“Default”（2026-10-26 改） |
| Max output | 数字框，值为 `maxTokens`，不写千分位；`reported.maxTokens` 为假（或按 §4.3 重新取了默认值）、且框里的值等于 16384 与这一行窗口一半中较小的时旁边“Default”（2026-10-26 改） |
| Supports thinking | 勾选框，值为 `reasoning` |
| Image input | 勾选框，值为 `image` |
| Family | 不显示；加入时按 `family` 原样保存，之后在 Edit 里改 |
| From pi（2026-10-26 补（WP-15）） | `catalog`（拉取规格 §4.4、§5.2）里为真的项：Context window、Max output 框里的值仍等于取来的值时、Supports thinking 仍勾着时，旁边“From pi”（同一格里不再写“Default”）；悬停说明“The server didn’t report this, so Mori used pi’s model list for <provider>. Change it if you know the real value.”（<provider> 为 `catalog.provider`，例如 Z.AI；临时，走查时可以改）。改成别的值就不写，改回又写。Image input 不取 pi 的值，没有这个标记 |

“Default”（2026-10-26 改，负责人走查 M6；原来是“Not reported”，只说明服务有没有报告、你改了值也留着）：服务没报告这一项、
而框里的值仍是 Mori 的默认值时才写，说明这个数是 Mori 猜的；悬停说明“The server didn’t report this, so Mori used a default. Change it
if you know the real value.”（临时，走查时可以改）。你改成别的值就不写，改回默认值又写；Max output 因拉取规格 §4.3 退回默认值时也写
（拉取规格 §6.2）。窗口改了而 Max output 没跟着变（你改过它）时，按新窗口算它是不是默认值。
行里输入框的读屏名“<列名> for <id>”（例如“Context window for deepseek-chat”）（临时，走查时可以改）。

行上的标记与提示（每个一行小字）：

| 条件 | 文字 | 对这一行的影响 |
| --- | --- | --- |
| `chat` 为假 | “Not a chat model” | 默认不勾，可以勾 |
| `added` 为真（只在卡上的清单） | “Added” | 不能勾、不能改 |
| `unusable` 不为 null | “Can’t add this model: <原因>”，原因为“the ID contains spaces”或“the ID is empty”（拉取规格 §4.3） | 不能勾 |
| 手填的行 | “Entered by you” | 见“Add a model ID” |
| `hints` 含 `no_tools` | “The server doesn’t list tool support for this model.” | 只是提示，工具调用照旧由探针判定 |
| `hints` 含 `trained_window` | “Trained context window. Ollama may use a smaller one.”（2026-10-26 改：原来后面还有“; run the long-input test after adding”，长输入测试的按钮删掉了） | 只是提示 |

默认勾选（拉取规格 §6.2；proposal §12 第 4 条）：

| 行 | 默认 |
| --- | --- |
| `added` 或 `unusable` | 不勾（也不能勾） |
| `chat` 为真 | 勾上 |
| `chat` 为假 | 不勾 |
| `chat` 为 null | 列表里能加入的行（不是 `added`、不是 `unusable`）只有这一行时勾上；否则不勾 |
| 手填的行 | 勾上 |

### 列表错误（拉取规格 §6.3）

`listError` 不为 null 时，清单的位置换成一句（`detail` 最多 2000 字，key 已换成 `***`）：

| `listError.kind` | 文字 |
| --- | --- |
| `rejected` | “The server rejected the API key: <detail>” |
| `unreachable` | “Couldn’t reach <主机>: <detail>”（<主机> 为 Base URL 的主机，非默认端口时带“:<端口>”，临时，走查时可以改；`detail` 为连接错误或“Timed out after 15s”） |
| `no_list` | “This server doesn’t list its models.” |
| `invalid` | “Couldn’t read the model list: <detail>”（例如“The model list is larger than 8 MB.”、“Redirected to <location>”） |

后面一句“You can still add model IDs below.”。Add provider 表单里 Name、API type 照样预填；可以用“Add a model ID”手填模型后 Add。
Add provider 表单的 Base URL 框照样可能换成整理后的地址，但不写“Updated to …”那一行（见 Add provider 的“建议的 Base URL”）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表错误 | `listError` 不为 null，还没手填 | 上表的一句和“You can still add model IDs below.”；下面是 Add a model ID；没有“Models (N)”标题、Select all、Clear selection、过滤框 | Add a model ID |
| 列表错误下手填的行 | 你用 Add a model ID 加了行（拉取规格 §6.3） | 手填的行列在错误那两句下面、Add a model ID 上面，样子同清单的行（勾选框、Model ID、Context window、Max output、Supports thinking、Image input，标“Entered by you”）；仍然没有“Models (N)”标题、Select all、Clear selection 和过滤框（行多也没有） | 勾选、取消勾选；改值；Add |

### Add a model ID（拉取规格 §6.4）

补列表里没有的模型；有列表、列表错误时都在，位置在清单（或列表错误）下面。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 一行 | 拉取后（Add provider 表单、卡上的清单、首次启动表单） | 标签“Add a model ID”；Model ID 输入框；“Add to list” | 输入；Add to list |
| id 错误 | 界面按规格 §4.1 检查 | 输入框旁“Model ID must be non-empty and contain no spaces.”；与清单里的任一行（含 Added、没勾的行）或这个提供商已有的模型重复时“Model IDs must be unique within a provider.”；有错误时 Add to list 不可用（错误在改过输入框后才显示，同现在的表单） | 修改 |
| 加入清单 | 你点了“Add to list” | 清单末尾多一行（列表错误时列在错误那两句下面，见“列表错误”）：勾上，标“Entered by you”；Context window 128000、Max output 16384（默认值，拉取规格 §11），两个都标“Default”（2026-10-26 改，原来是“Not reported”；改了值就不标，见“清单的行”）；Supports thinking、Image input 不勾；Model ID 不能改；输入框清空（临时，走查时可以改）。可以加多个。（2026-10-26 补（WP-15）：手填的行不查 pi 的模型表，没有“From pi”；加入后模型行按“模型行的提示”后三行提示 pi 的值，拉取规格 §6.4） | 同清单的行：改值、取消勾选 |

规格没有删除手填行的操作：不要的取消勾选。

### Keys

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有 key | `config.providers[].keys`（按顺序，就是使用顺序） | 标题“Keys”；每行：标签、“Saved”、当前记录（按 `keyStatus[ref]`：“Rate limited until hh:mm:ss” / “Rejected” / “Quota exhausted”，没有记录时不显示）；明文从不显示，也不能改；两个以上 key 时每行左端一个拖动柄（2026-10-26 改（M5），取代上移、下移，见“拖动排序”；名字是 key 的标签） | 拖动排序；Test；Remove（只剩一个 key 时是“Remove…”） |
| 记录变化 | `mori.key_status`；`rate_limited` 到了 `until` 后下一次 `mori.key_status` 或 `models.get` 不再带它 | 记录随之出现、变化或消失 | — |
| 没有 key | `keys` 为空 | “Requests are sent without an API key.” | Add key |
| Add key | 你点了“Add key” | 一行内联表单：Label（默认“Key <n>”，n 为 `nextKeyNumber`）、Secret（密码框）、“Save”“Cancel” | Save；Cancel |
| 已满 8 个 | `keys` 有 8 个 | Add key 不可用，旁边“A provider can have at most 8 keys.”（临时，走查时可以改） | — |
| 保存 key | `models.addKey` 返回 `ref` | 新行加在末尾，显示“Saved”；内联表单关闭 | — |
| 保存 key 失败 | 返回 `error` | 行内原文，Secret 保留在框里 | 修改；Cancel |
| Test 中 | 你点了某行的“Test”：`connection.test`（`{ providerId, modelId: 第一个模型, keyRef }`），不看这个 key 的记录直接发出 | 这一行下方“Testing…”与“Cancel” | Cancel |
| Test 结果 | `connection.test` 返回 | 结果显示在这一行下面，文字同提供商的 Test connection；成功时这一行的记录消失（§8.3），打开的会话重新做静态校验 | — |
| 移动（2026-10-26 改（M5）） | 一次放下或一次方向键：`models.moveKey`（`delta` 为移动的格数），立即保存，见“拖动排序” | 新顺序（就是使用顺序）；失败时回到原顺序，原文在 Keys 列表下面 | — |
| Remove（不是最后一个） | 你点了“Remove” | 不确认，直接 `models.removeKey`；行消失 | — |
| Remove 最后一个 | 你点了最后一个 key 的“Remove…” | 确认框，文字见下 | Remove；Cancel |
| Remove 失败 | `models.removeKey` 返回 `error` | 原文，行留着 | — |

### Models 行

2026-10-26 改（负责人走查 M7、M8，原话“Verify / Long-input test… / Test / Tool calling / Handoff tier — delete, keep connection test
& auto capability fill only”“Reasoning field: native / Cancel: Unknown — what is this?”）：原来的“Models 行与档案摘要”。档案摘要
（Tool calling、Handoff tier、Context、Reasoning field、Cancel）、截断告警、Verify、Long-input test…、Cancel test…、行上的 Test 都删掉；
测试连接留在提供商卡的“Test connection”和 Keys 每行的“Test”，能力自动填写留在 Fetch models 的清单与下面“Use”的提示。
探针第 0–7 步照旧在加入、改动、换 key、启动和版本变化后自动跑（§7.4），选择器、编译（回传推理内容、没有 Off）与 TaskBoard 的写入等级
照旧读档案，界面不再列出这些值。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 模型行 | `config.providers[].models`（按顺序，就是范围里的顺序） | 模型 id；说明一行“Context window: <窗口> · Max output: <最大输出> · Family: <模型族> · Supports thinking · Thinking can’t be turned off”（模型族为空、没勾 Supports thinking、档案的 `reasoning.off_refused` 不为真时那一段不显示）；数字按千分位写（临时，走查时可以改）；默认值的标记与不一致的提示见下两行（2026-10-26 补（WP-15）：取自 pi 的标记见“取自 pi”一行）；状态行只在下面“状态行”的情形有；两个以上模型时行左端一个拖动柄（2026-10-26 改（M5），取代上移、下移，见“拖动排序”；名字是模型 id；正在 Edit 的那一行换成模型表单，没有柄） | 拖动排序；Edit；Delete…；Use（有提示时）；Verify again（状态行是失败或出错时） |
| 默认值（2026-10-26 改，原来是“没报告”） | `profiles[ref].reported` 不为 null，并且：`contextWindow` 为 null、配置的窗口等于 128000；或 `maxTokens` 为 null、配置的 Max output 等于 16384 与配置窗口一半中较小的（`shared/models.ts` 的 `UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`，同清单与拉取规格 §11） | 这个数字后面“ (default)”，例如“Context window: 128,000 (default)”；悬停说明“The server didn’t report this, so Mori used a default. Use Edit to set the real value.”（临时，走查时可以改）。用 Edit 改成别的值后不再标，改回默认值又标；服务没报告、但值不是默认值的（你改过的、Ollama 的训练窗口）不标 | Edit |
| 取自 pi（2026-10-26 补（WP-15）） | `profiles[ref].catalog`（拉取规格 §7.2：按配置的地址与 id 查 pi 的模型表，只有服务没报告的项）有这一项，并且配置的值等于它：窗口、Max output 等于 `catalog` 的数；Supports thinking 为 `catalog.reasoning` 真且配置勾着 | 这个数字后面“ (from pi)”，例如“Context window: 1,000,000 (from pi)”；“Supports thinking”后面“ (from pi)”；悬停说明“The server didn’t report this; pi’s model list for <provider> has the same value. Use Edit to set the real value.”（<provider> 为 `catalog.provider`；临时，走查时可以改；2026-10-26 审查后改：原来是“…, so Mori used pi’s model list for <provider>. …”，但这里只看值相同，你手设的值恰好等于 pi 的也标，例如负责人手设的 131,072）。同时满足“(default)”的条件时只写“(from pi)”。用 Edit 改成别的值后不再标，改回又标 | Edit |
| Ollama 只有训练窗口 | Ollama 的模型，`/api/ps` 和 Modelfile 的 `num_ctx` 都没有，只读到训练窗口：档案里 `reported.contextWindow`（`context.reported`）为 null（拉取规格 §7.2） | 窗口是配置的值（清单里加入时是训练窗口，不是 Mori 的默认值），所以不标“(default)”（2026-10-26 改：原来写“(not reported)”）；不出“Server reports a context window of <N>.”，不提议把窗口改回训练窗口 | — |
| 不一致的提示 | `profiles[ref].reported` 与配置，条件见下“模型行的提示” | 每条一行小字和“Use”，在说明一行下面、状态行上面（临时，走查时可以改） | Use |
| 档案没有报告值 | `reported` 为 null（旧档案没有 `meta`，或还没有档案） | 不标“(default)”；“模型行的提示”只可能显示“This model returned thinking content.”那一条 | — |
| Use 保存中 | 你点了某条提示的“Use”：`models.saveModel`（`{ providerId, model: 按下表改过的模型 }`，不带 `thinkingLevel`，拉取规格 §5.4、§8） | 这个 Use 不可用（同立即保存） | — |
| Use 成功 | 返回无错误 | 行按新值显示，这条提示消失；指纹变了，自动重新探测（§7.4；tool calling 原来验证过时不显示状态行，见“重新验证中”） | — |
| Use 失败 | 返回 `error` | 这一行里原文；配置不变 | 再点 Use |
| 状态行（2026-10-26 改，取代档案摘要） | `profiles[ref]` 与 `running`（`mori.profiles` 更新）。只在模型不能用时有：tool calling 没验证通过（`tool_calling.state` 不是 `verified`），或从没完成过验证（没有档案、`probedAt` 为 null 或 `status` 为 `probing`）；选择器第 3 步正是按 tool calling 排除这样的模型（§5.3） | 说明一行与提示下面一行，写法见下四行。tool calling 已验证的模型没有这一行：重新验证中、其他步出错（例如第 1 步被拒、第 5–7 步停在输出上限）都不显示 | 见下 |
| 验证中 | `running` 里有这个 ref（或档案的 `status` 为 `probing`），模型不能用：第一次验证，或点了 Verify again | “Verifying…”（同原来 Tool calling 的写法） | — |
| 验证失败 | 不在探测，`tool_calling.state` 为 `failed`（第 3 或第 4 步判定为不通过） | “Tool calling failed verification: <detail>”（<detail> 是第 3、4 步里不通过的那一步的说明；写法同原来首次启动表单下方的那一句的前半，见 ui-strings“探针状态”）和“Verify again” | Verify again |
| 探针出错 | 不在探测，`tool_calling.state` 为 `unverified`（第 3 或第 4 步出错，`status` 为 `error`） | “Couldn’t verify: <原文>”（<原文> 是档案的 `error`：第一个出错的步的说明，规格 §7.2；见下“探针各步的说明显示在哪里”）和“Verify again” | Verify again |
| 没有档案、不在探测（2026-10-26 补，WP-02 评审） | `profiles[ref]` 没有（`profileView` 为 null）又不在 `running` 里：探针抛错、档案没建成、探针没能开始（后台进程都记了错误日志）。保存后、启动时探针都在界面读到档案之前开始，平常看不到这一态 | 同探针出错：“Couldn’t verify”（没有原文）和“Verify again”；行的 `data-probe` 为 `unverified`（原来一直写“Verifying…”、没有操作） | Verify again |
| Verify again | 你点了它：`models.verify`（`{ refs: [这个模型] }`，第 0–7 步；2026-10-26 改：去掉 `tests: 'auto'`，规格 §9.5） | 状态行变为“Verifying…”；命令本身出错时原文写在这一行里（同 Use 失败） | — |
| 重新验证中（2026-10-26 改） | `running` 里有这个 ref，档案完成过且 tool calling 已验证（指纹或服务版本变了，§7.4） | 不显示状态行；说明一行与提示按旧档案，结果出来后替换；选择仍按旧结果。行的 `data-probe` 为 `reverifying`（测试用） | — |
| 思考关不掉（2026-10-24 补，2026-10-26 改，规格 §7.7） | `profiles[ref].reasoning.off_refused` 为真：第 2 步关闭思考被 400 或 422 拒绝、开思考有正文 | 说明一行末尾“ · Thinking can’t be turned off”（原来是档案摘要的“Thinking: Can’t be turned off”；它解释了 Effort 菜单里为什么没有 Off）。第 2 步判为不通过、不算出错，所以不因此显示状态行；这一组第 2 步判出之后第 3、4、6、7 步用开思考（`medium`），tool calling 按这样跑的第 3、4 步判定。第 2 步的说明“Thinking can’t be turned off: <原文>”只存在 `model-profiles.json` 里，`ProfileView` 不带，设置页不显示（规格 §7.7） | — |
| 补丁之前验证失败的这类模型（2026-10-24 补，规格 §7.7） | 补丁之前探测过的思考关不掉的模型：当时第 2 步的关闭思考被 400 拒绝算出错（之后关闭思考的第 3 步等也被拒），`profile.status` 为 `error`，tool calling 没验证；旧档案没有 `auto.offRefused`，读作 false，不自动重新探测、不加迁移 | 状态行“Couldn’t verify: <原文>”（服务回的 400，第 2 步的原文，例如 OpenRouter 的“Reasoning is mandatory for this endpoint and cannot be disabled.”）和“Verify again”；说明一行没有“Thinking can’t be turned off”；不出别的提示 | Verify again：点一次即按 §7.7 重新测；开思考能答时状态行消失，说明一行多“ · Thinking can’t be turned off” |
| 停在探针输出上限（2026-10-24 补，2026-10-26 改，规格 §7.7） | 第 1–7 步任一步的回复因输出上限停下（`stopReason` 为 `length`），没有正文也没有工具调用、只有思考：这一步出错，说明“Stopped at the probe output limit before answering”；`profile.status` 为 `error` | 只是出错、不是不通过：是第 3、4 步时 tool calling 为 `unverified`，状态行“Couldn’t verify: Stopped at the probe output limit before answering”（它是第一个出错的步时）；是别的步时 tool calling 照样可以验证通过，模型能用，不显示状态行（2026-10-26 改：原来总写在档案摘要的“Couldn’t verify”里） | Verify again（只在有状态行时） |
| 关不掉、开思考也没答上（2026-10-24 补，规格 §7.7 第 2 步表第 4 行） | 第 2 步关闭思考被 400 或 422 拒绝，开思考（`medium`）出错或没有正文：这一步出错，`can_disable` 为 `unknown`，`off_refused` 不为真；`profile.status` 为 `error` | 这一组没判出 `off_refused`，第 3–7 步照原来关闭思考；关不掉的模型第 3 步多半也被拒，tool calling 没验证，状态行“Couldn’t verify: <说明>”：第 2 步是第一个出错的步，`medium` 出错时是它的说明（停在探针输出上限时就是“Stopped at the probe output limit before answering”），`medium` 没出错但没有正文时是 `off` 被拒的原文（服务的原文（以状态码开头，例如 “400 …”）或“422 …”）；说明一行没有“Thinking can’t be turned off”（tool calling 验证通过时不显示状态行） | Verify again |
| 移动（2026-10-26 改（M5）） | 一次放下或一次方向键：`models.moveModel`（`delta` 为移动的格数），立即保存，见“拖动排序” | 新顺序；分组展开顺序随之变；失败时回到原顺序，原文在 Models 列表下面 | — |
| 删除确认 | 你点了“Delete…” | 确认框，文字见下；是最后一个模型时写“This is the last model of <name>; the provider and its keys are deleted too.” | Delete；Cancel（焦点在 Cancel） |
| 已删除 | `models.deleteModel` 返回无错误 | 行（或整张卡）消失；正在用它的回复下一个请求换模型（model-chat.md，原因 `missing`）；它的探针出队 | — |
| 删除失败 | 返回 `error` | 确认框里原文，不关闭 | 再试；Cancel |

模型行的提示（拉取规格 §8）：报告值、实测值和配置不一致时不自动改配置，你点了 Use 才改。N 按千分位写（同模型行）。

| 条件 | 文字 | Use 改什么 |
| --- | --- | --- |
| `reported.contextWindow` 不为 null 且不等于配置的窗口 | “Server reports a context window of <N>.” | 窗口改为 N；原来的 Max output 不小于 N 时改为 16384 与 N 一半中较小的 |
| `reported.maxTokens` 不为 null、不等于配置的值、小于配置的窗口 | “Server reports max output of <N>.” | Max output 改为 N |
| `reported.reasoning` 为真、配置没勾 Supports thinking | “The server says this model supports thinking.” | 勾上 Supports thinking |
| 接口为 `openai-completions`、档案的推理字段（`reasoning.field`）不是 `none`、配置没勾 Supports thinking、`reported.reasoning` 不为真 | “This model returned thinking content.” | 勾上 Supports thinking |
| `reported.image` 为真、配置没勾 Image input | “The server says this model accepts images.” | 勾上 Image input |
| （2026-10-26 补（WP-15））`catalog.contextWindow` 不为 null、不等于配置的窗口，并且配置的窗口仍是默认值 128000 | “pi’s model list for <provider> has a context window of <N>.” | 同第一行 |
| （2026-10-26 补（WP-15））`catalog.maxTokens` 不为 null、不等于配置的值、小于配置的窗口，并且配置的 Max output 仍是默认值（16384 与配置窗口一半中较小的） | “pi’s model list for <provider> has max output of <N>.” | Max output 改为 N |
| （2026-10-26 补（WP-15））`catalog.reasoning` 为真、配置没勾 Supports thinking | “pi’s model list for <provider> says this model supports thinking.” | 勾上 Supports thinking |

`reported` 为 null 时只可能显示第四行：它不看 `reported`，旧档案也显示。
（2026-10-26 补（WP-15），拉取规格 §8）后三行（<provider> 为 `catalog.provider`）只在配置的值仍是 Mori 的默认值时出现，你设过的值不提示
改成 pi 的；给清单里手填的行、2026-10-26 以前加入的模型用。`reported` 为 null 时 `catalog` 也是 null，这三行不出现。第四行另要求
`catalog.reasoning` 不为真：同一件事只提示一条。文字是本表定的（临时，走查时可以改）。
Ollama 只读到训练窗口的模型，`reported.contextWindow` 为 null，所以第一行不出现（训练窗口不是 Ollama 实际用的窗口，拉取规格 §7.2）。

探针各步的说明显示在哪里（2026-10-24 按当时的界面查；2026-10-26 改，`ModelRows.tsx`；第 2 步的那句由规格 §7.7 写明）：设置页只在状态行里显示
探针的说明，状态行只在 tool calling 没验证通过时有（见上）：第 3、4 步判为不通过时是“Tool calling failed verification: <这一步的说明>”，
有一步出错时是“Couldn’t verify: <原文>”（档案的 `error`：第一个出错的步的说明，规格 §7.2）。tool calling 验证通过的模型，其他步出错的
原文、判定为不通过的步的说明（第 5、6 步被拒的原文，以及第 2 步的“Thinking can’t be turned off: <原文>”）都不显示，只留在档案里。
所以规格 §7.7 的两句说明里：“Thinking can’t be turned off: <原文>”是不通过，只存在 `model-profiles.json` 第 2 步的结果里，
`ProfileView` 不带，界面不显示，设置页看到的是说明一行的“Thinking can’t be turned off”；“Stopped at the probe output limit before
answering”是出错，只在它让 tool calling 没验证通过、又是第一个出错的步时出现在状态行的“Couldn’t verify: …”里（第 2 步关闭思考被拒、
开思考停在输出上限时也是这一句，见“关不掉、开思考也没答上”）。

### 需要你同意的探针（2026-10-26 删掉）

负责人走查 M7：“Long-input test…”、“Cancel test…”与它们的确认框（“Run the long-input test on <model id>?”、“Run the cancel test on
<model id>?”，按钮“Run test”）从模型行删掉，界面上没有入口。后台进程里的探针第 8、9 步和 `models.verify` 的 `tests: 'long_input' | 'cancel'`
这一包先不动（没有界面调用它们），由 WP-04 连同规格 §7.3 第 8、9 步、§5.7 的三种超时处理一起删掉（规格 §7.4 的 2026-10-26 注）。
2026-10-26（[WP-04](../walkthrough-1026/WP-04.md)，负责人的决定 1）：已删掉。`models.verify` 不再带 `tests`，只跑第 0–7 步；档案没有 `context.truncation` 与 `cancel_verified`；这一屏没有变化（模型行本来就不列它们）。

### 模型表单（Edit）

模型表单只剩 Edit，没有新建模式；新模型从卡上的 Fetch models 加入（拉取规格 §5.4、§6.5）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Edit | 你点了行的“Edit” | 标题“Edit model · <provider name>”（临时，走查时可以改）；字段 Model ID（只读）、Context window、Max output（不随窗口变）、Family（可空，占位“Optional”）、Supports thinking、Image input、Default effort for new sessions（只在勾了 Supports thinking 时，写 pi 设置的 `modelThinkingLevels`；选项 Off / Minimal / Low / Medium / High / Extra high / Max） | Save；Cancel |
| 设过强度 | `thinkingDefaults` 里有这个模型的值 | Default effort for new sessions 显示它 | 改选 |
| 没设过强度 | `thinkingDefaults` 里这个模型为 null（例如从清单加入、之后没在 Edit 里设过的模型，拉取规格 §5.4） | Default effort for new sessions 显示 `config.get` 的 `defaultThinkingLevel`（新会话实际用的强度）；`defaultThinkingLevel` 也没有时显示 Medium（拉取规格 §5.4） | 改选 |
| 思考关不掉的模型（2026-10-24 补，规格 §7.7） | `profiles[<provider id>/<model id>].reasoning.off_refused` 为真（重新验证中按旧结果；没有档案、从未验证的探测中、为假时照旧有 Off） | Default effort for new sessions 的选项没有 Off：Minimal / Low / Medium / High / Extra high / Max。按上两行要显示的强度是 Off（设过 Off，或没设过而 `defaultThinkingLevel` 是 Off）时显示 Minimal（pi 对这个模型用的就是它）。存着的 Off 照存：你没改这一项时 Save 不带 `thinkingLevel`（同下“保存”） | 改选（改了才写，写你选的那一档） |
| 字段错误 | 界面先查：窗口不是正整数、Max output 不是正整数或不小于窗口 | 字段旁英文错误（见下“字段错误的文字”），Save 不可用 | 修改 |
| 保存 | `models.saveModel`（`{ providerId, model, thinkingLevel? }`，只改已有的模型；只有你在这张表单里改了 Default effort for new sessions 时才带 `thinkingLevel`，没改时不写 `modelThinkingLevels`，拉取规格 §5.4） | 成功：表单关闭，行更新，指纹变了时自动开始探针；失败（例如模型已不存在）：表单里原文 | — |

## Groups

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `config.groups` | 每个分组一行：id；有序的成员，提供商成员写“<name> · all models”，模型成员写“<name> · <model id>”；两个以上成员时每个成员左端一个拖动柄（2026-10-26 改（M5），取代上移、下移，见“拖动排序”；名字是成员的写法，读屏名与播报里“ · ”换成“, ”） | 成员的拖动排序、Remove；Add member；Delete…；节底部“New group” |
| 没有分组 | `groups` 为空 | “No groups. A group lists the models to try, in order.”（临时，走查时可以改）和“New group” | New group |
| New group | 你点了“New group” | 一行内联表单：“Group ID”输入框、成员选择（同 Add member，至少选一个）、“Create”“Cancel”（临时，走查时可以改）；id 合规且至少一个成员时 Create 可用 | Create（`models.saveGroup`，`creating: true`）；Cancel |
| id 错误 | 界面按 §4.1 查（与提供商、分组 id 共用名字空间，含 `reserved`） | “<id> is already used by a provider or group.” / “Use lowercase letters, digits, and hyphens.” / 保留 id 时“<id> is reserved.”（临时，走查时可以改） | 修改 |
| Add member | 你点了“Add member” | 每个提供商一节：第一项“<name> · all models”，其后是它的各个模型；已在分组里的项打勾、不可再选 | 选一项（立即保存） |
| 只剩一个成员 | 成员数为 1 | Remove 不可用，说明“A group needs at least one member; delete the group instead.” | — |
| 保存 | 每次加入、去掉、拖动排序（一次放下或一次方向键；2026-10-26 改（M5），原来是上移、下移）后立即 `models.saveGroup`（`{ id, members, creating: false }`，§9.1） | 成功时列表更新、打开的会话重新做静态校验；失败时原文，列表回到保存前 | — |
| 删除确认 | 你点了分组的“Delete…” | 确认框，文字见下（含“Sessions using this group will need a new model range.”） | Delete；Cancel |
| 已删除 | `models.deleteGroup` 返回无错误 | 行消失；范围指向它的打开会话出现 `pick_missing` 拒绝启动卡 | — |

## 拖动排序（Models、Keys、分组的成员）

2026-10-26 新加（负责人走查 M5，规格 §9.1“拖动排序”、§9.5），取代三个列表的上移、下移按钮。一个“列表”是一张提供商卡里的 Models、
一张提供商卡里的 Keys，或一个分组的成员；行的“名字”：模型行是模型 id，key 行是 key 的标签，成员是成员的写法（读屏名与播报里
“ · ”换成“, ”，例如“Local A, all models”，ui-strings 写法约定）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可以排序 | 列表有两行以上 | 每行左端一个拖动柄（六个点的图标，淡色，悬停变深，鼠标是抓手）；读屏名“Reorder <名字>”，悬停“Drag or use the arrow keys to reorder”（都是 Claude 的说法）；没有上移、下移按钮 | 拖柄；焦点在柄上时按上、下方向键 |
| 只有一行 | 列表只有一行 | 没有柄（没有可排的） | — |
| 拖动中 | 你按住一行的柄开始拖 | 鼠标下是整行的影子；原来那一行变淡 | 移到同一列表别的行上；Esc 取消 |
| 放下的位置 | 鼠标在同一个列表的别的行上：上半边插在它前面，下半边插在它后面 | 那一行的上沿或下沿一条蓝线（临时，走查时可以改）；放下后顺序不变的位置（被拖的那一行、它上一行的下半边、下一行的上半边）没有线、不能放下 | 松开 |
| 不能放下的地方 | 鼠标在别的列表（别的提供商卡、Keys 与 Models 之间、别的分组）、正在 Edit 的模型表单或页面别处 | 没有线；鼠标显示不能放下 | 松开：什么都不变 |
| 放下 | 你在有线的位置松开 | 列表立即按新顺序显示，这个列表的柄不响应（保存中）。发一条命令：Models `models.moveModel`、Keys `models.moveKey`（`delta` = 新位置 − 原位置，例如把第三行拖到第一行是 -2），分组 `models.saveGroup`（新的成员顺序）；一次放下只发一条、只写一次配置 | — |
| 方向键 | 焦点在柄上，按上或下 | 这一行往前或往后移一格，同“放下”（`delta` 为 -1 或 1）；焦点留在这一行的柄上（行换了位置也是）；第一行按上、最后一行按下、保存中按都什么都不发 | 再按 |
| 保存成功 | 命令返回无错误 | 新顺序（重新读 `models.get`）：Models 的顺序就是范围里的顺序，分组展开顺序随之变；Keys 的顺序就是使用顺序；分组的成员顺序就是候选顺序，打开的会话重新做静态校验。读屏播报“<名字> was dropped at position <n> of <count>.”（Claude 的说法；屏幕上不显示） | — |
| 保存失败 | 命令返回 `error` | 列表回到原顺序；原文显示在这个列表下面（分组同它别的改动，在这一组下面），不在那一行里；不播报；方向键移动的，焦点留在这一行的柄上（它回到原位置；2026-10-26 复审补） | 再拖 |
| 取消 | 拖动中按 Esc，或在不能放下的地方松开 | 线与变淡都消失，什么都不发 | — |

反例：

- 不能把一行放进另一个列表；放下不会把一次移动分成几次保存（移三格是一条命令）。
- 没有“Move up”“Move down”按钮；方向键不需要先“拿起”（Claude 的完整键盘模式“按空格拿起、方向键移动、空格放下、Esc 放回”不做，
  一次按键就是一次移动和保存）。
- 提供商、分组本身不能拖（没有顺序可排，同原来）。

## 测试结果的文字（§9.1）

Test connection、Keys 的 Test 共用（2026-10-26 改：模型行没有 Test 了）：

| 情形 | 文字 |
| --- | --- |
| 测试中 | 按钮“Testing…”（临时，走查时可以改），旁边“Cancel” |
| 成功 | “Connected · First token Nms · Total Nms”，有思考内容时加“ · Includes thinking”，有正文时加“ · Response: <前 200 字>” |
| 失败 | “Connection failed: <原文>”（没有原文时“Connection failed: No response”）；命令本身出错时“Couldn’t test the connection: <原文>” |
| 已取消 | “Test cancelled”（临时，走查时可以改） |

（2026-10-24 补，规格 §7.7、§12）三处测试测的模型勾了 Supports thinking 时，请求带思考 `medium`（同探针第 1 步），否则不带思考参数；
这样第一次探测之前，思考关不掉的模型也不会因为“关闭思考”被 400 拒绝。界面没有新文字：结果仍是上表的写法，
勾了 Supports thinking 的模型成功时比原来更常带“ · Includes thinking”。

（2026-10-26 补，规格 §8.3）测试是你点的，总是发出：不看提供商的 connection、模型的 not_found、timeout、held 和 key 的记录，
上一次失败之后什么都不改再测，照样把请求发给服务、显示服务这一次的回答，也不因上一次失败而等。界面没有新文字。

## 确认框的文字

规格给定的句子照写；标题、按钮和连带改动每一条的写法是临时，走查时可以改。连带改动只列实际会发生的。
连带改动的各行只由后台进程（`kernel/modelConfig.ts` 的删除函数，`dryRun` 返回的 `consequences`）给出，界面照原文逐行显示；
下表写的就是这些原文。（2026-10-26 改：长输入探针、取消探针的两个确认框随按钮删掉，见“需要你同意的探针（2026-10-26 删掉）”。）

| 确认框 | 标题 | 正文与连带改动（§4.1） | 按钮 |
| --- | --- | --- | --- |
| 删除提供商 | “Delete provider <name>?” | 界面的说明“Its models and keys are deleted too.”；然后后台进程的各行：“Its models are deleted: <id>, <id>.”；有 key 时“Its saved keys are deleted: <label>, <label>.”；每个去掉了成员的分组一行“Removed from group <id>: <成员>, <成员>.”；每个因此变空的分组一行“Group <id> has no members left and is deleted.”；默认范围指向被删的名字时“The default model range (<名字>) is set to None.” | “Delete”“Cancel” |
| 删除模型 | “Delete model <id>?” | 是最后一个模型时先一行“This is the last model of <name>; the provider and its keys are deleted too.”；然后是分组与默认范围的各行，写法同上（没有“Its models are deleted …”“Its saved keys are deleted …”两行） | “Delete”“Cancel” |
| 删除分组 | “Delete group <id>?” | “Sessions using this group will need a new model range.”；默认范围指向它时“The default model range (<id>) is set to None.” | “Delete”“Cancel” |
| 改地址 | “Change the base URL?” | “Changing the base URL removes this provider’s N saved keys. Add them again after saving.”（只有 1 个 key 时“Changing the base URL removes this provider’s saved key. Add it again after saving.”） | “Save and remove keys”“Cancel” |
| 删最后一个 key | “Remove the last key?” | “Requests to <name> will be sent without an API key.” | “Remove”“Cancel” |

## 字段错误的文字

能与 `shared/models.ts` 的 zod 文字一致的用同一句；其余是临时，走查时可以改。清单的行与 Add a model ID 用同一组文字（拉取规格 §6.2、§6.4）。

| 字段 | 文字 |
| --- | --- |
| Name 为空 | “Name is required.” |
| Base URL 不是 http/https URL | “Base URL must be an http or https URL.” |
| Concurrency per key 不在 1–64 | “Use a whole number from 1 to 64.” |
| Model ID 为空或含空白（Add a model ID） | “Model ID must be non-empty and contain no spaces.” |
| Model ID 重复（Add a model ID：与清单里的任一行或这个提供商已有的模型重复） | “Model IDs must be unique within a provider.” |
| Context window 不是正整数（清单的行、模型表单） | “Context window must be a whole number above 0.” |
| Max output 不是正整数（清单的行、模型表单） | “Max output must be a whole number above 0.” |
| Max output 不小于窗口（清单的行、模型表单） | “Max output must be smaller than the context window.” |
| key 的 Label 为空 | “Label is required.” |
| key 的 Secret 为空 | Save 不可用，不出文字 |

## 写命令的共同规则

- 每个写命令保存后后台进程编译（§4.4）、对打开的会话重新做静态校验并发 `mori.model_state`、需要时发起探针（§7.4）；
  界面随后重新 `models.get`。
- 编译出错时保存失败、配置文件不改，错误原文显示在发起这次保存的地方（§4.4 第 5 步）。
- `models.saveProvider`（新建）与 `models.addModels` 一次命令一次编译、一次写入；`models` 的顺序就是加入后在提供商里的顺序，
  加入的每个模型都自动跑探针（拉取规格 §5.4）。
- `models.discover`、`models.discoverCancel` 不写配置、不进写入队列、不重新 `models.get`；后台进程同一时刻只做一次发现，
  新的一次取消正在进行的那次（拉取规格 §5.1、§5.3）。
- `models.saveModel` 没有 `adding`，只改已有的模型（`{ providerId, model, thinkingLevel? }`，模型不存在时 `error`）；
  加模型只有 `models.saveProvider`（新建）、`models.firstRun`、`models.addModels`（拉取规格 §5.4）。
- 界面的操作记录（F8 的“Recent activity”）对 `models.*` 只记类型和 id，例如“Add key <providerId>”，不含 `secret`、`keySecret`（§9.4）。
  拉取规格 §5.5：`models.discover` 记“Fetch models <主机>”（新提供商）或“Fetch models <providerId>”；`models.discoverCancel`
  记“Cancel fetch models”；`models.addModels` 记“Add models <providerId> · <条数>”。原来的“Add model <provider>/<id>”删掉（拉取规格 §5.4）。

## 反例

- key 的明文在任何地方都不显示、不回填、不能编辑；换 key = 加新的再删旧的。
- Add 之前 API key 只在表单和这次 `models.discover` 里：不存盘、不进模型池、不进日志和 F8；Cancel 关闭表单时不保存（拉取规格 §5.1、§9）。
- Fetch models 只发读取信息的请求，不发对话请求、不写配置；不轮询，只在你点 Fetch models 时拉（拉取规格 §0）。
- 服务没报告的值不查 pi 自带的模型目录、不按模型名猜：用默认值并标“(default)”（清单里“Default”），值改了就不再标（拉取规格 §0；2026-10-26 改）。
  （2026-10-26 补（WP-15），负责人走查回答 1：服务没报告的窗口、最大输出、是否支持思考按服务地址取 pi 的模型表，标“From pi”/
  “(from pi)”；仍不按模型名猜：pi 不认得的地址上同名的模型不取，别的地址上的同名条目不取，图片输入不取。）
- 取自 pi 的值不当作服务报告的：不出“Server reports …”，不改有效窗口；pi 的提示不覆盖你设过的值（只在仍是默认值时出现）。
- 清单里服务列出了工具支持不等于 Verified；工具调用只看探针（拉取规格 §4.1）。
- 改 API type 不清掉清单；只有改 Base URL、API key 或再点 Fetch models 才清掉。
- 拉取中 Base URL、API key 不能改；表单关闭时不留着一次还在进行的拉取（先发 `models.discoverCancel`）。
- 再拉一次不覆盖你在这张表单里改过的 Name、API type、More settings。
- API type 不跟着列表的形状变：没有 Anthropic 提示的地址拿到 Anthropic 形状的列表，只改“Detected: …”的写法（拉取规格 §3.4）。
- 卡上的清单不显示“Detected: …”；清单开着时卡上的 Fetch models 不可用。
- Ollama 只读到训练窗口的模型，模型行不提议把窗口改成训练窗口（拉取规格 §7.2）。
- “Not listed by the server”的模型不自动删除。
- 报告值与配置不一致时不自动改配置，你点了 Use 才改（拉取规格 §8）。
- 清单不设新会话的思考强度：勾了 Supports thinking 的模型新会话按 pi 设置的 `defaultThinkingLevel`，之后在 Edit 里设（拉取规格 §5.4）。
- Edit 里没设过强度的模型不显示与新会话实际强度不同的值，也不因为你点了 Save 就写下强度：只在你改了 Default effort for new sessions 时写。
- 提供商卡上没有“Add model”，模型表单没有新建；Edit provider 没有 Fetch models、没有清单。
- 卡上的 Fetch models 用已保存的 key，key 不回到界面。
- 没有网络区域：设置页没有区域、项目授权与区域的建议，任何提供商在任何项目里都能用（2026-10-26，负责人走查 M3）。
- 只改提供商名称、并发上限或模型列表，不清除 key 与提供商的记录（§8.3）。
- 配置读不出时不显示首次启动表单，也不显示 Models 的其他分节，文件不被覆盖。
- 改了默认范围，已有会话的范围不变。
- Defaults、Groups、Keys、拖动排序（2026-10-26 改（M5），原来是上移下移）、模型行提示的 Use 没有 Save 按钮。
- Keys、Models、分组成员没有上移、下移按钮；拖动不能把一行放进别的列表，一次放下不分几次保存（2026-10-26，负责人走查 M5）。
- 模型行不列档案的各项（Tool calling、Handoff tier、Context、Reasoning field、Cancel），也没有 Verify、Long-input test…、Cancel test…、Test；
  tool calling 验证通过的模型没有状态行，其他步出错的原文不显示（2026-10-26，负责人走查 M7、M8）。选择、编译与 TaskBoard 照旧读档案。
- 兼容选项不因 Fetch models 或探针自动勾上（拉取规格 §0 第 6 条）；表单里的说明只告诉你常见服务 Mori 已经按地址调整。
- 测试连接（含 key 的 Test）不因为上一次失败留下的不可用记录而不发出、也不等（§8.3，2026-10-26）。

思考关不掉的模型（2026-10-24 补，规格 §7.7）：

- 只按探针第 2 步认出：清单、模型行的提示都不读服务列表里的标记（OpenRouter 的 `reasoning.mandatory`、Anthropic 的
  `capabilities.thinking.types.disabled.supported`），不按模型名判断，清单不因此改 Supports thinking 的默认值。
- 第 2 步关闭思考被拒、开思考有正文时不算出错：这类模型重新验证后不显示“Couldn’t verify”，模型行不显示第 2 步的原文
  （开思考也没答上时是出错，见“关不掉、开思考也没答上”）。
- 补丁之前留下的“Couldn’t verify: <原文>”（服务回的 400）不自动重新探测、不迁移、不另加提示，等你点状态行的 Verify again（2026-10-26 改，原来是行上的 Verify）。
- `off_refused` 为假的模型（包括关闭思考时照样思考的 `can_disable: false`）说明一行没有“Thinking can’t be turned off”，Edit 里照旧列 Off；
  不写“Thinking can be turned off”。
- Edit 里显示成 Minimal 的 Off 不被改写成 Minimal：只在你改了 Default effort for new sessions 时写。
- 测试连接与探针被拒后不换个强度重发；测试连接的结果没有新文字。
- 不按地址或接口加提示，也不要你取消勾选 Supports thinking：Mori 发给有标记的模型的每个请求都带强度（探针第 1–7 步按本组第 2 步、
  用 `medium`；测试连接 `medium`；会话经虚拟模型路由的请求、压缩与重建、换模型后重发由 pi 收紧，Off 变成 `minimal`；
  TaskBoard 的 A 级只在 `can_disable` 为真时用），所以在哪个地址上 pi 都不会写“关闭思考”（规格 §7.7）。
  唯一的已知限制是会话里的 Minimal 没有探针测过、只在 OpenRouter 上实测过（规格 §7.7 末尾、proposal §10），设置页不为它加提示。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中“Loading…”；立即保存成功不提示；迁移说明各行的写法；
Defaults 下拉的节名与项的写法；
提供商卡的字段名；“Add provider”与三种空状态；表单标题；
测试中“Testing…”、已取消“Test cancelled”；各确认框的标题、按钮与连带改动的写法；字段错误的文字；
满 8 个 key 的说明；保留 id 的错误；New group 的内联表单（id 加至少一个成员再 Create）；
思考强度选项的英文名；写命令成功后重新 `models.get`。

一键拉取模型（拉取规格 §6、§8）另定的：
Add provider 表单的“Fetch cancelled”显示到你再点 Fetch models 或改 Base URL、API key，卡上的显示到你再点 Fetch models；
拉取命令出错的原文在 Fetch models 下方；卡上的清单在 Models 一块的末尾（原来 Add model 表单的位置）；
卡上的清单与提供商表单、模型表单同一时刻只开一张（同现在），打开别的就关掉它；
建议的 Base URL 换进框里不算你改了 Base URL（不清掉清单）；
列表为空时手填的行加在“The server didn’t list any models.”下面、这一句留着，标题行的 Select all、Clear selection 照样有；
清单行里输入框的读屏名“<列名> for <id>”；列表错误 `unreachable` 的“<主机>”是 Base URL 的主机，非默认端口时带端口；
Add a model ID 加入后输入框清空；模型行的提示在模型行说明下面、档案摘要上面（2026-10-26 改：状态行上面）；Use 失败的原文在这一行里；
表单与卡上清单底部关闭用的 Cancel 的标识 `data-action="close-form"`。

实现时定的（2026-10-23，都是临时，走查时可以改；见 [discovery-checks.md](../discovery-checks.md) 的 A16–A19、A22、A23）：
Add provider 里改 Base URL 或 API key 时，拉取命令出错的原文与上次保存失败的原文一起清掉；卡上的“Fetch cancelled”与拉取命令出错的原文
留到你再点这张卡的 Fetch models；在清单的过滤框和 Add a model ID 的输入框里按 Enter 什么也不做（不会按下“Add N models”）；
清单是一张表，表头就是 §6.2 的列名（Model ID、Context window、Max output、Supports thinking、Image input），放在最高 440px、
表头固定的滚动框里；Can’t add this model 的行只有勾选框不可用，Added 的行全部不可用；Add provider 的 Fetch models 不是主按钮；
拉取中 `fetch-status` 没有文字（按钮已写“Fetching models…”）；加入中（Adding…）Base URL、API key 只读，Fetch models 不可用；
关掉卡上正在拉取的清单时，卡上的按钮旁显示“Fetch cancelled”。

思考关不掉的模型（规格 §7.7）另定的（2026-10-24，都是临时，走查时可以改）：
“Thinking: Can’t be turned off”在档案摘要里放在 Reasoning field 后面、Cancel 前面，写法同其他项（标签“Thinking”，值“Can’t be turned off”）；
补丁之前的“Couldn’t verify: <原文>”（服务回的 400）行不加任何提示；Edit 表单开着时 `mori.profiles` 更新了 `off_refused`，
Default effort for new sessions 的选项随之变（显示的 Off 换成 Minimal，或 Off 回到选项里）。
（2026-10-26 改：档案摘要删掉，“Thinking can’t be turned off”接在说明一行的最后。）

负责人走查 M1、M6、M7、M8 另定的（2026-10-26，WP-02，都是临时，走查时可以改）：
模型行“(default)”的悬停说明“The server didn’t report this, so Mori used a default. Use Edit to set the real value.”，清单“Default”的悬停说明
“The server didn’t report this, so Mori used a default. Change it if you know the real value.”；“Thinking can’t be turned off”放在说明一行最后；
状态行放在提示下面，“Verifying…”用说明一行的颜色，失败与出错用错误的颜色，“Verify again”是紧跟在文字后面的小按钮；
tool calling 验证通过、其他步出错的模型不显示状态行；“Tool calling failed verification: <detail>”只用原来首次启动那一句的前半（不带
“Mori needs tool calling for the main agent; …”）；兼容选项图例下面一行说明“Mori already adjusts requests for well-known services such as
DeepSeek. Check an option only if this server rejects requests.”（提供商表单、首次启动表单共用）；存着的 `supportsStrictMode` 在卡上不列；
卡上的“Compatibility options”按表单里的顺序列（不按配置里键的先后）；状态行没有说明时：判定失败的那一步没有说明写“Tool calling failed
verification”（不带冒号），出错的档案没有原文写“Couldn’t verify”（这两条 2026-10-26 补登记，模型层屏的覆盖审查）。

负责人走查回答 1 另定的（2026-10-26，WP-15，都是临时，走查时可以改）：清单里取自 pi 的值旁边写“From pi”（与“Default”同样的小字），
模型行写“ (from pi)”；悬停说明清单为“The server didn’t report this, so Mori used pi’s model list for <provider>.
Change it if you know the real value.”，模型行为“The server didn’t report this; pi’s model list for <provider> has the same value.
Use Edit to set the real value.”（2026-10-26 审查后改，见“取自 pi”一行）；Supports thinking 也标（清单在勾选框旁边，模型行接在
“Supports thinking”后面），Image input 不标（不取 pi 的值）；模型行三条 pi 的提示的文字（见“模型行的提示”），排在服务的五条后面；
<provider> 用 pi 的提供商显示名（`Z.AI`、`OpenRouter` 等），Claude 桌面版没有对应。

负责人走查 M5 另定的（2026-10-26，WP-03，都是临时，走查时可以改；登记在 [v1/defaults.md](../defaults.md)“拖动排序”）：
三个列表都改拖动（诊断的推荐）；柄在行的左端，只有一行时没有；读屏名、悬停与播报用 Claude 的“Reorder {name}”“Drag or use the arrow keys
to reorder”“{name} was dropped at position {position} of {count}.”；方向键一次移一格就保存（不做 Claude 的“拿起、移动、放下”键盘模式），
焦点留在移动的那一行的柄上；鼠标在一行的上半边插在前面、下半边插在后面，线是那一行上沿或下沿 2px 的强调色；被拖的行变淡（不透明度 0.45），
拖着的影子是整行；保存中柄不响应（不设 `disabled`，只设 `aria-disabled`，焦点不丢），这时柄半透明（0.5）、鼠标是默认的；柄是六个点的图标、
淡色（`--color-faint`），悬停变深（`--color-text`）并有一块 `--color-hover` 的底（2026-10-26 补登记，模型层屏的覆盖审查）；
Models、Keys 移动失败的原文在列表下面（原来在那一行里）；行的按钮靠右，左边是柄与行的文字（Keys 的“Saved”和记录紧跟在标签后面，
原来分散在一行里）。

## 需要规格回答

已回答：

- （已回答）提供商表单与首次启动表单要对还没保存的 Base URL 预选建议区域，界面从哪里拿到这个建议：
  `suggestZone` 在 `shared/models.ts`（后台进程的 `zoneSuggestions` 与界面的表单共用），拉取规格 §3.4 写明界面按它预选。
  （2026-10-26 改，负责人走查 M3：网络区域删掉，没有建议区域。）

- （已回答：拉取规格 §6.1）**拉取中的表单**：拉取中 Base URL、API key 只读，表单自己的 Cancel 照样可用；表单关闭（Cancel、打开别的表单、
  离开设置页）时先发 `models.discoverCancel`。见“提供商表单：Add provider”的“拉取中”。
- （已回答：拉取规格 §3.4、§6.1、§6.5）**再拉一次与 `target.api`**：拉取后 Fetch models 留在 API key 下面，再点或改 Base URL、key 都从头来
  （清单和手填的行清掉）；Name、API type、More settings 里你改过的保留、不被下次结果覆盖，没改过的重新预填（2026-10-26：没有 Network zone）；
  改过的 API type 作为 `target.api` 发出；改 API type 不清掉清单。卡上的清单开着时卡上的 Fetch models 不可用，关掉清单再点就是再拉一次。
  见“拉取后”“改 Base URL 或 API key”“再拉一次”“改 API type”与卡上的“清单开着时卡上的按钮”“再拉一次”。
- （已回答：拉取规格 §6.1 第 3 项）**Base URL 的说明**：两边去掉首尾空白和结尾的 `/` 后比较，不同时换掉框；只在拿到列表时写
  “Updated to <url> so the model list loads.”，列表错误时只换框。见“建议的 Base URL”。
- （已回答：拉取规格 §6.2）**清单里改了值之后的 Not reported**：照标，你改了值也留着；Max output 因 §4.3 退回默认值时也写。
  （2026-10-26 改，负责人走查 M6：“Not reported”改为“Default”，只在值仍是默认值时标，见“清单的行”。）
- （已回答：拉取规格 §6.2）**过滤**：Select all、Clear selection 只作用于显示着的、能勾的行；过滤不分大小写；被藏起来的勾选行照样加入；
  “超过 20 行”算手填的行。
- （已回答：拉取规格 §6.5）**卡上的清单显示不显示“Detected: …”**：不显示。
- （已回答：拉取规格 §6.3）**列表错误时手填的行放在哪里**：列在错误那句下面，样子同清单的行；没有“Models (N)”标题、Select all、
  Clear selection 和过滤框。见“列表错误”。
- （已回答：拉取规格 §6.2）**列表为空**：“Models (0)”，下面一句“The server didn’t list any models.”，再下面是 Add a model ID。
- （已回答：拉取规格 §5.4）**Edit 里没设过的思考强度**：显示 `config.get` 的 `defaultThinkingLevel`（没有时 Medium），只在你改了时写入；
  `models.saveModel` 去掉 `adding`，模型表单没有新建模式。见“模型表单（Edit）”。
- （已回答：规格 §7.7）**第 2 步的说明“Thinking can’t be turned off: <原文>”显示在哪里**：只存在 `model-profiles.json` 第 2 步的结果里，
  `ProfileView` 不带，界面不显示；设置页看到的是档案摘要的“Thinking: Can’t be turned off”（原来是本表定的，现在由规格写明；
  2026-10-26 改：档案摘要删掉，是说明一行最后的“Thinking can’t be turned off”）。
  见“思考关不掉”与“探针各步的说明显示在哪里”。
- （已回答：规格 §7.7）**z.ai、Together 地址**：不再是已知限制，Mori 发给有标记的模型的每个请求都带强度，pi 不会写“关闭思考”；
  原来“在那里取消勾选 Supports thinking”的说法删掉。见“反例”。
- （已回答：规格 §7.7）**关闭思考被拒、开思考也出错或没有正文时“Couldn’t verify”写什么**：`medium` 出错时用它的说明（含输出上限那一句），
  `medium` 没出错但没有正文时用 `off` 的原文。见“关不掉、开思考也没答上”。

待回答：没有。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | 设置页 `data-testid="settings-page"`；分节按钮 `[data-testid="settings-nav"] button[data-section="models"]`（取代 `connections`） |
| 读取中 | `data-testid="models-loading"` |
| 配置读不出 | `data-testid="models-load-error"`，“Retry” `data-action="reload"` |
| 迁移说明 | `data-testid="migration-notice"`，“Dismiss” `data-action="dismiss"` |
| Defaults | 下拉 `data-testid="default-pick"`（2026-10-26：勾选框 `allowed-zone` 删掉） |
| 提供商卡 | `[data-testid="provider-card"][data-provider]`（2026-10-26：`provider-zone` 删掉）；卡上按钮 `data-action`：`edit-provider`、`delete-provider`、`test-provider`、`fetch-models`（取代 `add-model`，卡上不再有 `add-model`）、`add-key`；节底部 `add-provider`；空状态 `data-testid="providers-empty"`；测试结果 `data-testid="test-result"`；“Compatibility options”的值 `data-testid="provider-compat"`（只对 OpenAI-compatible 的卡，2026-10-26） |
| 测试中的取消 | 两处测试（提供商卡、Keys 的行）和首次启动表单都用 `data-action="test-cancel"`（2026-10-26 改：模型行没有 Test 了） |
| 提供商表单 | `data-testid="provider-form"`（Add provider 与 Edit；2026-10-26：区域单选 `input[name="zone"]` 删掉）；结果文字 `data-testid="form-message"`（保存失败、拉取命令出错）；字段错误 `[data-testid="field-error"][data-field]`（`name`、`baseUrl`、`concurrency`）；兼容选项上面的说明 `data-testid="compat-hint"`（首次启动表单同，2026-10-26） |
| 拉取 | Fetch models 按钮 `data-action="fetch-models"`（提供商表单、提供商卡、首次启动表单 `data-testid="connection-form"` 三处同名；拉取中文字为“Fetching models…”、不可用）；拉取中的 Cancel `data-action="fetch-cancel"`；拉取的状态 `data-testid="fetch-status"`：拉取中 `data-state="fetching"`，取消后 `data-state="cancelled"`（“Fetch cancelled”）；拉取中 Base URL、API key 两个输入框（按标签“Base URL”“API key”找，同现在）带 `readonly`；表单与卡上清单底部关闭用的“Cancel” `data-action="close-form"`（与 `fetch-cancel` 区分），拉取中照样可用 |
| 拉取后（Add provider） | “Detected: …” `data-testid="detected-server"`，`data-kind` 为 `ServerKind`（例如 `vllm`、`ollama`、`unknown`）；Base URL 的说明 `data-testid="base-url-note"`；More settings 一块 `data-testid="more-settings"`（收起时只有“More settings”一行，点它展开）；探针代价的说明 `data-testid="probe-cost-note"`；Add 按钮 `data-action="add-models"`（卡上的清单同） |
| 清单 | `data-testid="checklist"`；Select all `data-action="select-all"`；Clear selection `data-action="clear-selection"`；过滤框 `data-testid="checklist-filter"`；截断说明 `data-testid="checklist-truncated"`；行 `[data-testid="discovered-row"][data-model="<id>"]`：`data-chat` 为 `true` / `false` / `unknown`（`chat` 为 null；手填的行也是 `unknown`），`added` 时 `data-added="true"`，`unusable` 时 `data-unusable="true"`；行的勾选框 `input[name="pick"]`；行里的输入框 `input[data-field]`：`contextWindow`、`maxTokens`、`reasoning`、`image`；行的字段错误 `[data-testid="field-error"][data-field]`（`contextWindow`、`maxTokens`）；默认值的标记“Default” `[data-testid="default-value"][data-field]`（`contextWindow`、`maxTokens`；2026-10-26 改，取代 `not-reported`）；取自 pi 的标记“From pi” `[data-testid="pi-value"][data-field]`（`contextWindow`、`maxTokens`、`reasoning`，悬停说明在 `title`；2026-10-26 补（WP-15））；标记 `[data-testid="row-tag"][data-kind]`：`not-chat`、`added`、`unusable`、`entered`；提示 `[data-testid="row-hint"][data-kind]`：`no_tools`、`trained_window` |
| 列表错误 | `data-testid="list-error"`，`data-kind`：`rejected`、`unreachable`、`no_list`、`invalid` |
| Add a model ID | 一行 `data-testid="manual-model"`；输入框 `input[data-field="id"]`；字段错误 `[data-testid="field-error"][data-field="id"]`；按钮 `data-action="add-to-list"` |
| 卡上的清单 | 清单、列表错误、Add a model ID、Add 按钮同上；Not listed 一行 `data-testid="not-listed"`；卡里没有 `detected-server`；清单开着时卡上的 `[data-action="fetch-models"]` 为 `disabled` |
| Keys | 行 `[data-testid="key-row"][data-ref]`，记录 `data-testid="key-state"`（`data-state` 为 `rate_limited` / `auth` / `quota`）；按钮 `data-action`：`key-test`、`key-remove`（2026-10-26 改（M5）：`key-up`、`key-down` 删掉，柄见“拖动排序”一行）；内联表单 `data-testid="key-form"`；没有 key 的说明 `data-testid="no-keys"`；行下的测试结果 `data-testid="key-test"` |
| Models 行（2026-10-26 改） | `[data-testid="model-row"][data-model]`（`provider/id`，沿用 v0），`data-probe` 为 tool calling 的验证状态：`verifying`（从没完成过验证、正在探测）、`reverifying`（验证过、正在重新探测）、`verified`、`unverified`（含没有档案又不在探测）、`failed`（取代原来档案摘要里 `data-field="tool_calling"` 的 `data-value`，取值相同）；说明一行 `.model-meta`；思考关不掉时说明一行里多 `[data-field="thinking_off"]`（“Thinking can’t be turned off”，`off_refused` 为假时没有）；状态行 `data-testid="probe-status"`，`data-state`：`verifying`、`failed`、`error`（取代 `probe-error`）；状态行里的“Verify again” `data-action="verify"`；按钮 `data-action`：`edit`、`delete`（2026-10-26 改（M5）：`up`、`down` 删掉，柄见“拖动排序”一行）。删掉的：`profile`、`truncation-warning`、`probe-error`、`model-test`，按钮 `long-input`、`cancel-test`、`test` 和常显的 `verify` |
| 模型行的提示 | 默认值的标记“(default)” `[data-testid="default-value"][data-field]`（`contextWindow`、`maxTokens`；2026-10-26 改，取代 `not-reported`），在 `model-row` 里；取自 pi 的标记“(from pi)” `[data-testid="pi-value"][data-field]`（`contextWindow`、`maxTokens`、`reasoning`，悬停说明在 `title`；2026-10-26 补（WP-15））；提示 `[data-testid="model-hint"][data-kind]`：`context`、`max-output`、`reasoning`、`thinking-seen`、`image`、`pi-context`、`pi-max-output`、`pi-reasoning`（依次是“模型行的提示”表的八行；后三种 2026-10-26 补（WP-15））；提示的 Use `data-action="use-reported"`（pi 的提示同） |
| 模型表单 | `data-testid="model-form"`（沿用 v0，只有 Edit）；字段错误同提供商表单（`contextWindow`、`maxTokens`）；Default effort for new sessions 的下拉按标签找（同现在，没有新标识），思考关不掉的模型里没有 `option[value="off"]`，存着的 Off 显示时下拉的值为 `minimal`（2026-10-24 补） |
| 确认框 | 删除、改地址、删最后一个 key 都是 `data-testid="confirm-dialog"`，`data-kind`：`delete-provider`、`delete-model`、`delete-group`、`address-change`、`last-key`（2026-10-26 改：`long-input`、`cancel-test` 随按钮删掉）；连带改动列表 `data-testid="cascade"` |
| Groups | 行 `[data-testid="group-row"][data-group]`；成员 `[data-testid="group-member"][data-member]`；成员选择 `data-testid="member-picker"`，项 `data-member`、已选的带 `aria-checked="true"`；`New group` `data-action="new-group"`，内联表单 `data-testid="group-form"`，id 错误 `data-testid="group-error"`；空状态 `data-testid="groups-empty"`（2026-10-26 改（M5）：成员的 `member-up`、`member-down` 删掉，柄见下一行） |
| 拖动排序（2026-10-26，M5） | 柄 `data-action="reorder"`（在 `key-row`、`model-row`、`group-member` 里，每行一个；列表只有一行时没有）；拖动中被拖的行带 `data-dragging="true"`，鼠标下能放下的那一行带 `data-drop`：`before`（线在上沿）或 `after`（线在下沿）；每个列表一个播报区 `[data-testid="reorder-status"][data-list]`（`role="status"`，屏幕上不显示），`data-list` 为 `models:<provider id>`、`keys:<provider id>`、`members:<group id>`，文字是最近一次移动的播报；Models、Keys 移动失败的原文是列表下面的 `.form-message.error`（`role="alert"`） |
| 删掉的（2026-10-26，负责人走查 M3） | 区域未确认的 `zone-unconfirmed`、`confirm-zone`、`zone-dialog`；Defaults 的 `allowed-zone`；卡上的 `provider-zone`；表单的 `input[name="zone"]`；Project access 一节 `project-access`、`project-row`、`project-zone`、`project-config-error`、`public-dialog`、`projects-empty`。MP-06 的 App 检查按这些标识查它们都不在 |

清单行与 Add a model ID 的 `data-field` 取自 `app/src/renderer/src/components/settings/fields.tsx`：`contextWindow`、`maxTokens`
是模型表单（Edit）字段错误（`FieldError`）的 `data-field`；`id` 沿用原来模型表单 Model ID 字段错误的名字，现在只在 Add a model ID 用
（Edit 的 Model ID 只读、不查）；`reasoning`、`image` 是 `ModelDraft` 里两个勾选框的键。
现在的模型表单只在字段错误上带 `data-field`，输入框本身没有；清单行和 Add a model ID 的输入框直接带它。
