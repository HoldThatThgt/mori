# 设置 → Models

依据：规格 §4（配置、删除的连带改动、改地址、配置读不出、迁移、项目授权）、§7（档案与探针）、§8.3（key 的记录）、
§9.1、§9.3、§9.4、§9.5；[一键拉取模型构建规格](../../specs/model-discovery.md)（下称“拉取规格”）§5（命令与结果）、
§6.1–§6.5（Add provider 表单、清单、列表错误、Add a model ID、卡上的 Fetch models）、§7.2（档案的报告值）、§8（模型行的提示）、
§11（临时默认值）。
不加前缀的“规格”指[统一模型提供商构建规格](../../specs/model-providers.md)。
取代 [v0 settings.md](../../v0/screens/settings.md) 的“Connections and models”分节；AGENTS.md 分节不变。
界面文字为英文（规格 §0），写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `models.get` / `models.reload` 的结果 | `config`（key 只有 `{ ref, label }`）、`profiles`、`keyStatus`（每个有记录的 key：`{ state, until }`）、`thinkingDefaults`（每个模型在 pi 设置 `modelThinkingLevels` 里的新会话强度，没设时为 null）、`zoneSuggestions`（每个提供商的建议区域，§12）、`migration`（迁移说明或 null）、`projects`（`{ path, zones, projectZones, projectConfig }`）、`loadError`（配置读不出时的路径与原文）、`reserved`（保留 id） |
| `models.*` 写命令的结果 | `error: string \| null`；`models.saveProvider` 另给 `providerId`（新建时收 `models`：清单里勾选的行，拉取规格 §5.4），`models.addKey` 另给 `ref`；`models.addModels`（`{ providerId, models }`，拉取规格 §5.4）只有 `error` |
| `models.discover` 的结果（拉取规格 §5.2） | `DiscoverResult`：`error`（命令本身失败）、`cancelled`、`server`（`{ kind: ServerKind, version }`，没拿到列表时为 null）、`api`、`baseUrl`（建议的 Base URL）、`name`、`anthropicShape`、`listError`（`{ kind: 'rejected' \| 'unreachable' \| 'no_list' \| 'invalid', detail }` 或 null）、`models`（`DiscoveredModel[]`，列表顺序：`id`、`contextWindow`、`maxTokens`、`reasoning`、`image`、`family`、`chat`、`reported`、`hints`、`unusable`、`added`）、`truncated`、`notListed`。只在表单状态里，表单关闭就丢掉，不缓存（拉取规格 §9） |
| `models.discoverCancel` 的结果 | `{ error }`；被取消的那次 `models.discover` 返回 `cancelled: true`（拉取规格 §5.3） |
| `mori.profiles`（全局信封） | 全部 `ProfileView`，以及 `running: { ref, step, of }[]`（正在跑的探针）。`ProfileView.reported`：`{ contextWindow, maxTokens, reasoning, image }`（各项为 number / boolean 或 null），档案没有 `meta` 时整个为 null；Ollama 只读到训练窗口时 `contextWindow` 为 null（训练窗口不记作报告，拉取规格 §7.2） |
| `mori.key_status`（全局信封） | 全部有记录的 key：`ref → { state: 'rate_limited' \| 'auth' \| 'quota', until }`；key 的记录变化时发出 |
| `connection.test` 的结果 | `{ providerId, modelId, keyRef? }` 的测试结果：成功（首字时间、总时间、是否有思考内容、回复开头）、失败（原文）、已取消 |
| `config.get` 的结果 | `configError`（配置读不出，§4.1）、`settingsError`（pi 的 `settings.json` 读不出，沿用 v0）、`defaultThinkingLevel`（pi 设置的默认思考强度；模型表单 Edit 里没设过强度的模型显示它，拉取规格 §5.4） |
| `shared/models.ts` | `suggestZone`（按 Base URL 预选区域，§12；拉取规格 §3.4）、`SERVER_KIND_LABELS`（Detected 一行的种类名，拉取规格 §3.3） |
| 你的操作 | 打开分节、打开表单、填 Base URL 和 API key、Fetch models、勾选清单的行、改值、Add a model ID、Use、确认框、勾选 |

写命令成功后界面重新调 `models.get`，按它的结果显示（临时，走查时可以改）；两次之间档案与 key 记录由
`mori.profiles`、`mori.key_status` 更新。`models.discover`、`models.discoverCancel` 不是写命令：不进写入队列，不重新调 `models.get`
（拉取规格 §5.1）。

## 外框与进入方式

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开设置页 | 你点了侧栏“Settings” | 左侧分节“Models”（取代“Connections and models”）与“AGENTS.md”；落在 Models | 切换分节 |
| 迁移后第一次启动 | 后台进程这次启动迁移成功（§4.5）；`models.get` 的 `migration` 不为 null | 启动后直接打开 设置 → Models，顶部是迁移说明 | 同下 |
| 从拒绝启动卡的“Open settings”进入 | 你点了它（§4.6） | 设置 → Models，停在顶部 | 同下 |
| 从 No model available 卡的“Open settings”进入 | 你点了它（§9.3） | 设置 → Models，滚到第一个被排除候选的提供商卡；原因是 `auth`、`quota` 时焦点在它的 Keys（第一行） | 同下 |
| 从“Confirm zone”（拒绝启动卡）进入 | 你点了它（§4.6、§9.3） | 设置 → Models，滚到“区域未确认”那几行，焦点在 `blocked.zoneProviders` 第一个提供商那一行的“Confirm zone…” | Confirm zone… |
| 从“Allow <zone> for this project”进入 | 你点了拒绝启动卡上的这个操作（§4.6、§9.3） | 设置 → Models 的 Project access，焦点在这个会话的项目那一行（路径按 §4.1 规范化后比较） | 勾选区域 |
| 从“Manage models”进入 | 你点了顶栏菜单底部这一项（§9.2） | 设置 → Models，停在顶部 | — |
| 读取中 | `models.get` 还没返回 | “Loading…”（临时，走查时可以改），各节不显示 | — |
| 读取失败 | `models.get` 返回 `error` | 原文 | 重新打开设置页 |
| 配置读不出 | `models.get` 的 `loadError` 不为 null（`model-config.json` 存在但不是合法 JSON 或校验失败，§4.1） | 只显示这条错误：“Couldn’t read model settings: <路径>: <原文>”（拒绝启动卡 `config_invalid` 写“Model settings can’t be read: …”）和“Retry”；其他各节都不显示 | Retry（`models.reload`；修好文件后结果里 `loadError` 为 null 时显示完整的分节） |
| pi 设置读不出 | `config.get` 的 `settingsError` | 分节上方原文（带文件路径），同 v0 | 修好文件后重新打开设置页 |

从上到下的顺序：迁移说明 → 区域未确认 → Defaults → Providers → Groups → Project access（§9.1）。
各节标题就是这几个英文名（Defaults、Providers、Groups、Project access）。

## 保存方式（§9.1）

- 立即保存：Defaults 的两项、Groups 的每次改动、Project access 的勾选、Keys 的加删与上移下移、模型的上移下移、
  Confirm zone、Dismiss、模型行提示的“Use”（拉取规格 §8）。改了就发对应的写命令，没有 Save 按钮。
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

## 区域未确认

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有未确认的提供商 | `config.providers[].zone` 为 null（只有迁移来的提供商会这样，§4.1） | 迁移说明下方一句“Confirm the network zone of these providers. Sessions don’t use them until you do.”（临时，走查时可以改）；每个这样的提供商一行：“<name> · <address>”和“Confirm zone…” | Confirm zone… |
| 确认框 | 你点了这一行的“Confirm zone…”（拒绝启动卡上的 Confirm zone… 只是把你带到这里，§9.3） | 对话框标题“Confirm network zone”（临时，走查时可以改）；提供商名称与地址；Local / Intranet / Public 单选，预选 `zoneSuggestions[providerId]`；“Confirm”“Cancel” | 选一个区域；Confirm；Cancel 或 Esc（不写） |
| 确认中 | 你点了“Confirm”，`models.confirmZone` 还没返回 | 按钮不可用 | — |
| 已确认 | `models.confirmZone` 返回无错误 | 这一行消失（全部确认后整块消失）；提供商卡上显示所选区域；打开的会话重新做静态校验（`mori.model_state`，§9.5） | — |
| 确认失败 | 返回 `error` | 对话框里显示原文，不关闭 | 再试；Cancel |

## Defaults

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 默认范围 | `config.normalDefault` | 标签“Default model range for new sessions”；下拉，分三节，节名“Groups”“Providers”“Models”（同顶栏菜单）；项：分组写 id，提供商写名称，模型写“<provider name> · <model id>”（同 Groups 成员的写法）；当前值选中；为 null 时“None”，“None”是第一项 | 选一项或“None” |
| 允许的区域 | `config.allowedZones` | 标签“Allowed zones for all projects”；Local、Intranet 两个勾选框；说明“Public providers can only be allowed per project, below.” | 勾选、取消勾选 |
| 保存 | 改了上面任一项立即 `models.setDefaults`（`{ normalDefault, allowedZones }`） | 保存中控件不可用；失败时原文，控件回到保存前的值；成功时没有额外提示 | — |
| 已有会话 | §5.1：已有会话的范围不随默认范围改变 | 不提示（规格没有提示文字） | — |

## Providers

### 提供商卡

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `config.providers`（按配置顺序） | 每个提供商一张卡：名称；“Base URL”、“API type”（三种显示名同表单）、“Network zone”（Local / Intranet / Public；未确认时“Not confirmed”）、“Concurrency per key”、“Compatibility options”（勾了的兼容选项的标签，逗号分隔，不带说明；没有时“None”）；下面是 Keys 和 Models 两块。字段名都是临时，走查时可以改 | Edit；Delete…；Test connection；Fetch models（取代原来的“Add model”，见下“卡上的 Fetch models”）；节底部“Add provider”（临时，走查时可以改） |
| 没有提供商 | `config.providers` 为空（例如删掉了最后一个提供商） | “No providers yet. Add one to start a session.”（临时，走查时可以改） | Add provider |
| 测试中 | 你点了“Test connection”，`connection.test`（`{ providerId, modelId: 第一个模型 }`，不带 `keyRef`，用第一个可用的 key）还没返回 | 按钮变为“Testing…”（临时，走查时可以改），旁边“Cancel” | Cancel（`connection.testCancel`） |
| 测试结果 | `connection.test` 返回 | 卡内显示结果，文字见下“测试结果的文字”。没有 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限，`server` 不重试直接报告（§9.1） | 再次测试 |
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
| 拉取后 | 返回 `cancelled: false`、`error: null` | 卡里 Models 一块的末尾（同原来 Add model 表单的位置，临时，走查时可以改）打开：清单（见下“清单”）或列表错误（见下“列表错误”）；已在配置里的行（`added`）标“Added”，不能勾、不能改；`notListed` 不为空时清单下面一行“Not listed by the server: <id>, <id>”（这些模型不删除）；“Add a model ID”一行（见下，重复检查含这个提供商已有的全部模型）；底部同 Add provider（拉取规格 §6.1 第 8 项）：“Each model is verified with up to 13 short requests.”、Add 按钮（文字与可用条件见“清单”）、“Cancel”。没有 Name、API type、Network zone、More settings；**不显示“Detected: …”一行**（拉取规格 §6.5） | 勾选、改值；Add a model ID；Add；Cancel（关闭清单，不写） |
| 清单开着时卡上的按钮 | 这张卡的清单或列表错误开着（拉取后到你关掉它或加入成功） | 卡上的“Fetch models”不可用（拉取规格 §6.5） | — |
| 再拉一次 | 你点了底部的“Cancel”关掉清单，再点卡上的“Fetch models” | 同“拉取中”：重新 `models.discover`，清单、勾选、改过的值和手填的行都不留 | 同拉取中 |
| 加入中 | 你点了 Add：`models.addModels`（`{ providerId, models: 勾选的行，按清单顺序 }`） | 按钮“Adding…”，不可用 | — |
| 已加入 | 返回无错误（一次编译、一次写入，拉取规格 §5.4） | 清单关闭；新模型按清单顺序加在 Models 行的末尾，各自自动开始探针（Tool calling “Verifying…”）；卡上的 Fetch models 重新可用 | — |
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
| 拉取后 | 返回 `cancelled: false`、`error: null`，不论有没有拿到列表 | 从上到下：Base URL、API key（可以改，见下“改 Base URL 或 API key”）和它下面的“Fetch models”（再拉一次，见下“再拉一次”）；“Detected: …”一行（写法见下，`server` 为 null 时不显示）；Base URL 的替换与说明（见下“建议的 Base URL”）；Name（预填 `name`：主机名，非默认端口时加“:<端口>”）、API type（预填 `api`；三种显示名同 Edit）、Network zone（见下“区域的建议值”）——这三项和 More settings 里你在这张表单里改过的，保留你的值，不按这次结果预填；`listError` 为 null 时清单（见“清单”），否则列表错误（见“列表错误”）；“Add a model ID”一行（见“Add a model ID”）；“More settings”（收起，点开后是 Concurrency per key（默认 4，1–64）和兼容选项（只在 API type 为 OpenAI-compatible (Chat Completions) 时，六个勾选框，同 Edit））；底部“Each model is verified with up to 13 short requests.”、Add 按钮（文字与可用条件见“清单”）、“Cancel” | 改 Name、API type、Network zone；勾选、改值；Add a model ID；More settings；Fetch models（再拉一次）；Add；Cancel（关闭表单，不写；key 不保存） |
| 建议的 Base URL | 结果的 `baseUrl` 与 Base URL 框的值不同：两边去掉首尾空白和结尾的 `/` 后比较（拉取规格 §6.1 第 3 项） | Base URL 框换成 `baseUrl`；`listError` 为 null（拿到了列表）时框下面一行“Updated to <url> so the model list loads.”；有列表错误时只换框，不写这一行。这次替换不算你改了 Base URL（不清掉清单） | — |
| 改 Base URL 或 API key | 拉取后你改了 Base URL 或 API key 框 | 清单、列表错误、手填的行都清掉；“Detected: …”、Base URL 的说明一起清掉；Name、API type、Network zone、More settings、底部一起收起，回到开始。你改过的 Name、API type、Network zone、More settings 的值留在表单里（收起时不显示），下次拉取后不覆盖；没改过的按下次的结果重新预填（拉取规格 §6.1） | Fetch models |
| 再拉一次 | 拉取后你点了 Base URL、API key 下面的“Fetch models” | 同“改 Base URL 或 API key”：清单、勾选、改过的行值、手填的行都清掉，从头来，进入“拉取中”；你改过的 Name、API type、Network zone、More settings 照样保留；改过的 API type 作为 `target.api` 发出 | 同拉取中 |
| 改 API type | 拉取后你改了 API type | 清单、手填的行和勾选都不变（拉取规格 §6.1）；兼容选项随 API type 显示或隐藏（同现在）；这个值算“你改过的”：之后再拉取作为 `target.api` 发出，结果不覆盖它 | — |
| 区域的建议值 | §12 的规则（`shared/models.ts` 的 `suggestZone`），按 Base URL 框里的地址算（拉取后可能已换成建议的地址） | 拉取后预选建议值；你在这张表单里改过区域之后，再拉取也不覆盖（拉取规格 §6.1） | 改选 |
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
| Edit | 你点了卡上的“Edit” | 标题“Edit provider · <name>”（临时，走查时可以改）；字段 Name、Base URL、API type（“OpenAI-compatible (Chat Completions)”、“OpenAI Responses”、“Anthropic Messages”）、Network zone（Local / Intranet / Public，是当前值，不自动改）、Concurrency per key（1–64）、兼容选项（只在 API type 为 `openai-completions` 时，六个勾选框，每个是 §9.1 的标签加下面一行说明，沿用 english-ui）；没有 key 和模型字段 | Save；Cancel |
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
| 改窗口 | 你改了一行的 Context window，没改过这一行的 Max output | Max output 随窗口按拉取规格 §4.3 变：服务报告了输出上限、且它小于新窗口时用报告的值；否则为 16384 与新窗口一半中较小的，并标“Not reported” | — |
| 勾选的行有错误 | 勾选的行里有字段错误 | Add 不可用（没勾的行有错误不影响 Add） | 修改或取消勾选 |
| Add 按钮 | 勾选数 N（含勾上的手填行和被过滤框藏起来的勾选行） | N 为 1 时“Add 1 model”，N 大于 1 时“Add N models”；N 为 0 时“Add models”，不可用。首次启动表单的底部不同，见 first-run.md | Add |

清单的行：

| 列 | 内容 |
| --- | --- |
| 勾选框 | 读屏名“Add <id>”；`added`、`unusable` 的行不可用 |
| Model ID | 服务的 id，原样，不能改 |
| Context window | 数字框，值为 `contextWindow`，不写千分位；`reported.contextWindow` 为假时旁边“Not reported” |
| Max output | 数字框，值为 `maxTokens`，不写千分位；`reported.maxTokens` 为假、或按 §4.3 重新取了默认值时旁边“Not reported” |
| Supports thinking | 勾选框，值为 `reasoning` |
| Image input | 勾选框，值为 `image` |
| Family | 不显示；加入时按 `family` 原样保存，之后在 Edit 里改 |

“Not reported”只说明服务有没有报告这一项：你改了值也留着；Max output 因拉取规格 §4.3 退回默认值时也写（拉取规格 §6.2）。
行里输入框的读屏名“<列名> for <id>”（例如“Context window for deepseek-chat”）（临时，走查时可以改）。

行上的标记与提示（每个一行小字）：

| 条件 | 文字 | 对这一行的影响 |
| --- | --- | --- |
| `chat` 为假 | “Not a chat model” | 默认不勾，可以勾 |
| `added` 为真（只在卡上的清单） | “Added” | 不能勾、不能改 |
| `unusable` 不为 null | “Can’t add this model: <原因>”，原因为“the ID contains spaces”或“the ID is empty”（拉取规格 §4.3） | 不能勾 |
| 手填的行 | “Entered by you” | 见“Add a model ID” |
| `hints` 含 `no_tools` | “The server doesn’t list tool support for this model.” | 只是提示，工具调用照旧由探针判定 |
| `hints` 含 `trained_window` | “Trained context window. Ollama may use a smaller one; run the long-input test after adding.” | 只是提示 |

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

后面一句“You can still add model IDs below.”。Add provider 表单里 Name、API type、Network zone 照样预填；可以用“Add a model ID”手填模型后 Add。
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
| 加入清单 | 你点了“Add to list” | 清单末尾多一行（列表错误时列在错误那两句下面，见“列表错误”）：勾上，标“Entered by you”；Context window 128000、Max output 16384（默认值，拉取规格 §11），两个都标“Not reported”；Supports thinking、Image input 不勾；Model ID 不能改；输入框清空（临时，走查时可以改）。可以加多个 | 同清单的行：改值、取消勾选 |

规格没有删除手填行的操作：不要的取消勾选。

### Keys

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有 key | `config.providers[].keys`（按顺序，就是使用顺序） | 标题“Keys”；每行：标签、“Saved”、当前记录（按 `keyStatus[ref]`：“Rate limited until hh:mm:ss” / “Rejected” / “Quota exhausted”，没有记录时不显示）；明文从不显示，也不能改 | 上移、下移（第一行没有上移、最后一行没有下移；按钮读屏名称“Move up”“Move down”）；Test；Remove（只剩一个 key 时是“Remove…”） |
| 记录变化 | `mori.key_status`；`rate_limited` 到了 `until` 后下一次 `mori.key_status` 或 `models.get` 不再带它 | 记录随之出现、变化或消失 | — |
| 没有 key | `keys` 为空 | “Requests are sent without an API key.” | Add key |
| Add key | 你点了“Add key” | 一行内联表单：Label（默认“Key <n>”，n 为 `nextKeyNumber`）、Secret（密码框）、“Save”“Cancel” | Save；Cancel |
| 已满 8 个 | `keys` 有 8 个 | Add key 不可用，旁边“A provider can have at most 8 keys.”（临时，走查时可以改） | — |
| 保存 key | `models.addKey` 返回 `ref` | 新行加在末尾，显示“Saved”；内联表单关闭 | — |
| 保存 key 失败 | 返回 `error` | 行内原文，Secret 保留在框里 | 修改；Cancel |
| Test 中 | 你点了某行的“Test”：`connection.test`（`{ providerId, modelId: 第一个模型, keyRef }`），不看这个 key 的记录直接发出 | 这一行下方“Testing…”与“Cancel” | Cancel |
| Test 结果 | `connection.test` 返回 | 结果显示在这一行下面，文字同提供商的 Test connection；成功时这一行的记录消失（§8.3），打开的会话重新做静态校验 | — |
| 移动 | `models.moveKey`（`delta: -1 \| 1`），立即保存 | 新顺序；失败时原文 | — |
| Remove（不是最后一个） | 你点了“Remove” | 不确认，直接 `models.removeKey`；行消失 | — |
| Remove 最后一个 | 你点了最后一个 key 的“Remove…” | 确认框，文字见下 | Remove；Cancel |
| Remove 失败 | `models.removeKey` 返回 `error` | 原文，行留着 | — |

### Models 行与档案摘要

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 模型行 | `config.providers[].models`（按顺序，就是范围里的顺序） | 模型 id；“Context window: <窗口>”、“Max output: <最大输出>”、“Family: <模型族>”（为空时不显示）、“Supports thinking”（勾了时显示）；数字按千分位写（临时，走查时可以改）；没报告的标记与不一致的提示见下两行 | Verify；Long-input test…；Cancel test…（只对 `server.kind` 为 `vllm`、`sglang`、`llamacpp` 的；改认为 `localai`、`tensorrt` 的不再显示，拉取规格 §7.2）；上移；下移；Edit；Delete…；Test；Use（有提示时） |
| 没报告 | `profiles[ref].reported` 不为 null，其中 `contextWindow` 或 `maxTokens` 为 null（拉取规格 §8） | 窗口写“Context window: 128,000 (not reported)”；Max output 同样在数字后加“ (not reported)”。数字是配置的值 | — |
| Ollama 只有训练窗口 | Ollama 的模型，`/api/ps` 和 Modelfile 的 `num_ctx` 都没有，只读到训练窗口：档案里 `reported.contextWindow`（`context.reported`）为 null（拉取规格 §7.2） | 窗口照“没报告”写“(not reported)”，数字是配置的值（清单里加入时是训练窗口）；不出“Server reports a context window of <N>.”，不提议把窗口改回训练窗口 | — |
| 不一致的提示 | `profiles[ref].reported` 与配置，条件见下“模型行的提示” | 每条一行小字和“Use”，在模型行说明下面、档案摘要上面（临时，走查时可以改） | Use |
| 档案没有报告值 | `reported` 为 null（旧档案没有 `meta`，或还没有档案） | 不显示“(not reported)”；“模型行的提示”只可能显示“This model returned thinking content.”那一条 | — |
| Use 保存中 | 你点了某条提示的“Use”：`models.saveModel`（`{ providerId, model: 按下表改过的模型 }`，不带 `thinkingLevel`，拉取规格 §5.4、§8） | 这个 Use 不可用（同立即保存） | — |
| Use 成功 | 返回无错误 | 行按新值显示，这条提示消失；指纹变了，自动重新探测（Tool calling “Re-verifying…”，§7.4） | — |
| Use 失败 | 返回 `error` | 这一行里原文；配置不变 | 再点 Use |
| 档案摘要 | `profiles[ref]`（`mori.profiles` 更新） | Tool calling：Verified / Not verified / Failed / Verifying… / Re-verifying…；Handoff tier：A / B / C / —；Context：有效窗口；Reasoning field：`reasoning_content` / `reasoning` / `reasoning_text` / `none` / `native`；Cancel：Verified（`true`）/ Not verified（`false`）/ Unknown（`unknown`） | — |
| 从未验证、探测中 | `running` 里有这个 ref，且档案从没完成过（`probedAt` 为 null 或 `status` 为 `probing`） | Tool calling “Verifying…” | — |
| 重新验证中 | `running` 里有这个 ref，且档案完成过（指纹或服务版本变了、你点了 Verify、需要同意的探针，§7.4） | Tool calling “Re-verifying…”，其余仍显示旧结果，结果出来后替换；选择仍按旧结果 | — |
| 探针出错 | `profile.status` 为 `error` | “Couldn’t verify: <原文>” | Verify |
| 静默截断 | `context.truncation` 为 `silent` | Context 显示降下后的有效窗口，告警“Silently truncates long input” | — |
| Verify | 你点了“Verify”：`models.verify`（`{ refs: [这个模型], tests: 'auto' }`，第 0–7 步） | 进入 Verifying… / Re-verifying… | — |
| 测试 | 你点了行的“Test”：`connection.test`（`{ providerId, modelId }`，用第一个可用的 key） | 结果写在这一行下面，文字同提供商的 Test connection；测试中“Testing…”与“Cancel” | Cancel |
| 移动 | `models.moveModel`，立即保存 | 新顺序；分组展开顺序随之变 | — |
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

`reported` 为 null 时只可能显示第四行：它不看 `reported`，旧档案也显示。
Ollama 只读到训练窗口的模型，`reported.contextWindow` 为 null，所以第一行不出现（训练窗口不是 Ollama 实际用的窗口，拉取规格 §7.2）。

### 需要你同意的探针

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 长输入确认 | 你点了“Long-input test…” | 确认框，文字见下（写明大约多少 token：有效窗口的 50% + 90%，§7.4） | Run test（`models.verify`，`tests: 'long_input'`）；Cancel |
| 取消探针确认 | 你点了“Cancel test…” | 确认框，文字见下 | Run test（`tests: 'cancel'`）；Cancel |
| 运行中 | `mori.profiles` 的 `running` 有这个 ref | 同“重新验证中” | — |
| 结果 | 探针结束后的 `mori.profiles` | Context 更新（截断时告警）；Cancel 更新为 Verified / Not verified / Unknown | — |

### 模型表单（Edit）

模型表单只剩 Edit，没有新建模式；新模型从卡上的 Fetch models 加入（拉取规格 §5.4、§6.5）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Edit | 你点了行的“Edit” | 标题“Edit model · <provider name>”（临时，走查时可以改）；字段 Model ID（只读）、Context window、Max output（不随窗口变）、Family（可空，占位“Optional”）、Supports thinking、Image input、Default effort for new sessions（只在勾了 Supports thinking 时，写 pi 设置的 `modelThinkingLevels`；选项 Off / Minimal / Low / Medium / High / Extra high / Max） | Save；Cancel |
| 设过强度 | `thinkingDefaults` 里有这个模型的值 | Default effort for new sessions 显示它 | 改选 |
| 没设过强度 | `thinkingDefaults` 里这个模型为 null（例如从清单加入、之后没在 Edit 里设过的模型，拉取规格 §5.4） | Default effort for new sessions 显示 `config.get` 的 `defaultThinkingLevel`（新会话实际用的强度）；`defaultThinkingLevel` 也没有时显示 Medium（拉取规格 §5.4） | 改选 |
| 字段错误 | 界面先查：窗口不是正整数、Max output 不是正整数或不小于窗口 | 字段旁英文错误（见下“字段错误的文字”），Save 不可用 | 修改 |
| 保存 | `models.saveModel`（`{ providerId, model, thinkingLevel? }`，只改已有的模型；只有你在这张表单里改了 Default effort for new sessions 时才带 `thinkingLevel`，没改时不写 `modelThinkingLevels`，拉取规格 §5.4） | 成功：表单关闭，行更新，指纹变了时自动开始探针；失败（例如模型已不存在）：表单里原文 | — |

## Groups

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `config.groups` | 每个分组一行：id；有序的成员，提供商成员写“<name> · all models”，模型成员写“<name> · <model id>” | 成员上移、下移、Remove；Add member；Delete…；节底部“New group” |
| 没有分组 | `groups` 为空 | “No groups. A group lists the models to try, in order.”（临时，走查时可以改）和“New group” | New group |
| New group | 你点了“New group” | 一行内联表单：“Group ID”输入框、成员选择（同 Add member，至少选一个）、“Create”“Cancel”（临时，走查时可以改）；id 合规且至少一个成员时 Create 可用 | Create（`models.saveGroup`，`creating: true`）；Cancel |
| id 错误 | 界面按 §4.1 查（与提供商、分组 id 共用名字空间，含 `reserved`） | “<id> is already used by a provider or group.” / “Use lowercase letters, digits, and hyphens.” / 保留 id 时“<id> is reserved.”（临时，走查时可以改） | 修改 |
| Add member | 你点了“Add member” | 每个提供商一节：第一项“<name> · all models”，其后是它的各个模型；已在分组里的项打勾、不可再选 | 选一项（立即保存） |
| 只剩一个成员 | 成员数为 1 | Remove 不可用，说明“A group needs at least one member; delete the group instead.” | — |
| 保存 | 每次加入、去掉、上移、下移后立即 `models.saveGroup`（`{ id, members, creating: false }`，§9.1） | 成功时列表更新、打开的会话重新做静态校验；失败时原文，列表回到保存前 | — |
| 删除确认 | 你点了分组的“Delete…” | 确认框，文字见下（含“Sessions using this group will need a new model range.”） | Delete；Cancel |
| 已删除 | `models.deleteGroup` 返回无错误 | 行消失；范围指向它的打开会话出现 `pick_missing` 拒绝启动卡 | — |

## Project access

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `models.get` 的 `projects`（侧栏里的项目） | 每行：项目路径；“Allowed: <区域，· 分隔>”（临时，走查时可以改），即 (`allowedZones` ∪ `zones`) 再与 `projectZones`（不为 null 时）取交集（§4.3）；每个不在 `allowedZones` 里的区域一个勾选框（Local / Intranet / Public），勾上表示 `zones` 里有它 | 勾选、取消勾选 |
| 没有项目 | `projects` 为空 | “No projects yet. Open a folder to add one.”（临时，走查时可以改） | — |
| 项目配置排除了这个区域 | `projectZones` 不为 null 且不含这个区域（§4.3） | 勾选框不可用，说明“.mori/models.json in this project doesn’t allow <zone>.” | — |
| 项目配置无效 | `projectConfig` 不为 null（这个项目 `.mori/models.json` 的错误原文） | 这一行显示“.mori/models.json: <原文>”（同拒绝启动卡 `project_config` 的文字）；勾选框照常可用（本机授权与项目配置分开存） | 勾选 |
| 勾 public 的确认 | 你勾了 Public | 确认框“Allow public providers for this project?”，正文“Code and files from <项目路径> may be sent to: <公网提供商名，逗号分隔>.”；“Allow”“Cancel” | Allow；Cancel（勾选框回到未勾，不写） |
| 勾 intranet / local、取消勾选 | 你点了勾选框 | 不确认，立即保存 | — |
| 保存 | `models.setProjectZones`（`{ path, zones }`） | 成功：勾选框与“Allowed”更新；这个项目的会话重新做静态校验，`zone_blocked` 的拒绝启动卡随之解除；失败：原文，勾选框回到原值 | — |

## 测试结果的文字（§9.1）

Test connection、Keys 的 Test、模型行的 Test 共用：

| 情形 | 文字 |
| --- | --- |
| 测试中 | 按钮“Testing…”（临时，走查时可以改），旁边“Cancel” |
| 成功 | “Connected · First token Nms · Total Nms”，有思考内容时加“ · Includes thinking”，有正文时加“ · Response: <前 200 字>” |
| 失败 | “Connection failed: <原文>”（没有原文时“Connection failed: No response”）；命令本身出错时“Couldn’t test the connection: <原文>” |
| 已取消 | “Test cancelled”（临时，走查时可以改） |

## 确认框的文字

规格给定的句子照写；标题、按钮和连带改动每一条的写法是临时，走查时可以改。连带改动只列实际会发生的。
连带改动的各行只由后台进程（`kernel/modelConfig.ts` 的删除函数，`dryRun` 返回的 `consequences`）给出，界面照原文逐行显示；
下表写的就是这些原文。

| 确认框 | 标题 | 正文与连带改动（§4.1） | 按钮 |
| --- | --- | --- | --- |
| 删除提供商 | “Delete provider <name>?” | 界面的说明“Its models and keys are deleted too.”；然后后台进程的各行：“Its models are deleted: <id>, <id>.”；有 key 时“Its saved keys are deleted: <label>, <label>.”；每个去掉了成员的分组一行“Removed from group <id>: <成员>, <成员>.”；每个因此变空的分组一行“Group <id> has no members left and is deleted.”；默认范围指向被删的名字时“The default model range (<名字>) is set to None.” | “Delete”“Cancel” |
| 删除模型 | “Delete model <id>?” | 是最后一个模型时先一行“This is the last model of <name>; the provider and its keys are deleted too.”；然后是分组与默认范围的各行，写法同上（没有“Its models are deleted …”“Its saved keys are deleted …”两行） | “Delete”“Cancel” |
| 删除分组 | “Delete group <id>?” | “Sessions using this group will need a new model range.”；默认范围指向它时“The default model range (<id>) is set to None.” | “Delete”“Cancel” |
| 改地址 | “Change the base URL?” | “Changing the base URL removes this provider’s N saved keys. Add them again after saving.”（只有 1 个 key 时“Changing the base URL removes this provider’s saved key. Add it again after saving.”） | “Save and remove keys”“Cancel” |
| 删最后一个 key | “Remove the last key?” | “Requests to <name> will be sent without an API key.” | “Remove”“Cancel” |
| 长输入探针 | “Run the long-input test on <model id>?” | “Sends two requests of about <50%> and <90%> tokens (about <合计> tokens in all) to check whether long input is silently truncated.” | “Run test”“Cancel” |
| 取消探针 | “Run the cancel test on <model id>?” | “Sends one request for a long reply, disconnects after the first output, and reads the server’s metrics to see whether the request stopped.” | “Run test”“Cancel” |

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
- Fetch models 只发读取信息的请求，不发对话请求、不写配置、不按项目区域过滤；不轮询，只在你点 Fetch models 时拉（拉取规格 §0）。
- 服务没报告的值不查 pi 自带的模型目录、不按模型名猜：用默认值并标“Not reported”（拉取规格 §0）。
- 清单里服务列出了工具支持不等于 Verified；工具调用只看探针（拉取规格 §4.1）。
- 改 API type 不清掉清单；只有改 Base URL、API key 或再点 Fetch models 才清掉。
- 拉取中 Base URL、API key 不能改；表单关闭时不留着一次还在进行的拉取（先发 `models.discoverCancel`）。
- 再拉一次不覆盖你在这张表单里改过的 Name、API type、Network zone、More settings。
- API type 不跟着列表的形状变：没有 Anthropic 提示的地址拿到 Anthropic 形状的列表，只改“Detected: …”的写法（拉取规格 §3.4）。
- 卡上的清单不显示“Detected: …”；清单开着时卡上的 Fetch models 不可用。
- Ollama 只读到训练窗口的模型，模型行不提议把窗口改成训练窗口（拉取规格 §7.2）。
- “Not listed by the server”的模型不自动删除。
- 报告值与配置不一致时不自动改配置，你点了 Use 才改（拉取规格 §8）。
- 清单不设新会话的思考强度：勾了 Supports thinking 的模型新会话按 pi 设置的 `defaultThinkingLevel`，之后在 Edit 里设（拉取规格 §5.4）。
- Edit 里没设过强度的模型不显示与新会话实际强度不同的值，也不因为你点了 Save 就写下强度：只在你改了 Default effort for new sessions 时写。
- 提供商卡上没有“Add model”，模型表单没有新建；Edit provider 没有 Fetch models、没有清单。
- 卡上的 Fetch models 用已保存的 key，key 不回到界面。
- “Allowed zones for all projects”里没有 Public。
- 勾 public 时取消确认框，不写配置。
- 只改提供商名称、并发上限、区域或模型列表，不清除 key 与提供商的记录（§8.3）。
- 配置读不出时不显示首次启动表单，也不显示 Models 的其他分节，文件不被覆盖。
- 探针、Test connection、key 的 Test、Fetch models 不按项目区域过滤；区域未确认的提供商也可以测试、探测和拉取（§4.3；拉取规格 §0）。
- 改了默认范围，已有会话的范围不变。
- Defaults、Groups、Project access、Keys、上移下移、模型行提示的 Use 没有 Save 按钮。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中“Loading…”；立即保存成功不提示；迁移说明各行的写法；
区域未确认的说明句与“<name> · <address>”、卡上的“Not confirmed”、Confirm 对话框标题；Defaults 下拉的节名与项的写法；
提供商卡的字段名；“Add provider”与三种空状态；表单标题；
测试中“Testing…”、已取消“Test cancelled”；各确认框的标题、按钮与连带改动的写法；字段错误的文字；
满 8 个 key 的说明；保留 id 的错误；New group 的内联表单（id 加至少一个成员再 Create）；Project access 的“Allowed: …”；
项目配置无效时勾选框照常可用；思考强度选项的英文名；写命令成功后重新 `models.get`。

一键拉取模型（拉取规格 §6、§8）另定的：
Add provider 表单的“Fetch cancelled”显示到你再点 Fetch models 或改 Base URL、API key，卡上的显示到你再点 Fetch models；
拉取命令出错的原文在 Fetch models 下方；卡上的清单在 Models 一块的末尾（原来 Add model 表单的位置）；
卡上的清单与提供商表单、模型表单同一时刻只开一张（同现在），打开别的就关掉它；
建议的 Base URL 换进框里不算你改了 Base URL（不清掉清单）；
列表为空时手填的行加在“The server didn’t list any models.”下面、这一句留着，标题行的 Select all、Clear selection 照样有；
清单行里输入框的读屏名“<列名> for <id>”；列表错误 `unreachable` 的“<主机>”是 Base URL 的主机，非默认端口时带端口；
Add a model ID 加入后输入框清空；模型行的提示在模型行说明下面、档案摘要上面；Use 失败的原文在这一行里；
表单与卡上清单底部关闭用的 Cancel 的标识 `data-action="close-form"`。

实现时定的（2026-10-23，都是临时，走查时可以改；见 [discovery-checks.md](../discovery-checks.md) 的 A16–A19）：
Add provider 里改 Base URL 或 API key 时，拉取命令出错的原文与上次保存失败的原文一起清掉；卡上的“Fetch cancelled”与拉取命令出错的原文
留到你再点这张卡的 Fetch models；在清单的过滤框和 Add a model ID 的输入框里按 Enter 什么也不做（不会按下“Add N models”）；
清单是一张表，表头就是 §6.2 的列名（Model ID、Context window、Max output、Supports thinking、Image input），放在最高 440px、
表头固定的滚动框里；Can’t add this model 的行只有勾选框不可用，Added 的行全部不可用；Add provider 的 Fetch models 不是主按钮；
拉取中 `fetch-status` 没有文字（按钮已写“Fetching models…”）；加入中（Adding…）Base URL、API key 只读，Fetch models 不可用；
关掉卡上正在拉取的清单时，卡上的按钮旁显示“Fetch cancelled”。

## 需要规格回答

已回答：

- （已回答）提供商表单与首次启动表单要对还没保存的 Base URL 预选建议区域，界面从哪里拿到这个建议：
  `suggestZone` 在 `shared/models.ts`（后台进程的 `zoneSuggestions` 与界面的表单共用），拉取规格 §3.4 写明界面按它预选。

- （已回答：拉取规格 §6.1）**拉取中的表单**：拉取中 Base URL、API key 只读，表单自己的 Cancel 照样可用；表单关闭（Cancel、打开别的表单、
  离开设置页）时先发 `models.discoverCancel`。见“提供商表单：Add provider”的“拉取中”。
- （已回答：拉取规格 §3.4、§6.1、§6.5）**再拉一次与 `target.api`**：拉取后 Fetch models 留在 API key 下面，再点或改 Base URL、key 都从头来
  （清单和手填的行清掉）；Name、API type、Network zone、More settings 里你改过的保留、不被下次结果覆盖，没改过的重新预填；
  改过的 API type 作为 `target.api` 发出；改 API type 不清掉清单。卡上的清单开着时卡上的 Fetch models 不可用，关掉清单再点就是再拉一次。
  见“拉取后”“改 Base URL 或 API key”“再拉一次”“改 API type”与卡上的“清单开着时卡上的按钮”“再拉一次”。
- （已回答：拉取规格 §6.1 第 3 项）**Base URL 的说明**：两边去掉首尾空白和结尾的 `/` 后比较，不同时换掉框；只在拿到列表时写
  “Updated to <url> so the model list loads.”，列表错误时只换框。见“建议的 Base URL”。
- （已回答：拉取规格 §6.2）**清单里改了值之后的 Not reported**：照标，你改了值也留着；Max output 因 §4.3 退回默认值时也写。
- （已回答：拉取规格 §6.2）**过滤**：Select all、Clear selection 只作用于显示着的、能勾的行；过滤不分大小写；被藏起来的勾选行照样加入；
  “超过 20 行”算手填的行。
- （已回答：拉取规格 §6.5）**卡上的清单显示不显示“Detected: …”**：不显示。
- （已回答：拉取规格 §6.3）**列表错误时手填的行放在哪里**：列在错误那句下面，样子同清单的行；没有“Models (N)”标题、Select all、
  Clear selection 和过滤框。见“列表错误”。
- （已回答：拉取规格 §6.2）**列表为空**：“Models (0)”，下面一句“The server didn’t list any models.”，再下面是 Add a model ID。
- （已回答：拉取规格 §5.4）**Edit 里没设过的思考强度**：显示 `config.get` 的 `defaultThinkingLevel`（没有时 Medium），只在你改了时写入；
  `models.saveModel` 去掉 `adding`，模型表单没有新建模式。见“模型表单（Edit）”。

待回答：没有。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | 设置页 `data-testid="settings-page"`；分节按钮 `[data-testid="settings-nav"] button[data-section="models"]`（取代 `connections`） |
| 读取中 | `data-testid="models-loading"` |
| 配置读不出 | `data-testid="models-load-error"`，“Retry” `data-action="reload"` |
| 迁移说明 | `data-testid="migration-notice"`，“Dismiss” `data-action="dismiss"` |
| 区域未确认 | 每行 `[data-testid="zone-unconfirmed"][data-provider]`，按钮 `data-action="confirm-zone"`；确认框 `data-testid="zone-dialog"`，单选 `input[name="zone"][value]` |
| Defaults | 下拉 `data-testid="default-pick"`；勾选框 `[data-testid="allowed-zone"][data-zone]` |
| 提供商卡 | `[data-testid="provider-card"][data-provider]`，区域 `data-testid="provider-zone"`（`data-zone`，未确认时 `unconfirmed`）；卡上按钮 `data-action`：`edit-provider`、`delete-provider`、`test-provider`、`fetch-models`（取代 `add-model`，卡上不再有 `add-model`）、`add-key`；节底部 `add-provider`；空状态 `data-testid="providers-empty"`；测试结果 `data-testid="test-result"` |
| 测试中的取消 | 三处测试都用 `data-action="test-cancel"` |
| 提供商表单 | `data-testid="provider-form"`（Add provider 与 Edit）；区域单选 `input[name="zone"][value]`；结果文字 `data-testid="form-message"`（保存失败、拉取命令出错）；字段错误 `[data-testid="field-error"][data-field]`（`name`、`baseUrl`、`concurrency`、`zone`） |
| 拉取 | Fetch models 按钮 `data-action="fetch-models"`（提供商表单、提供商卡、首次启动表单 `data-testid="connection-form"` 三处同名；拉取中文字为“Fetching models…”、不可用）；拉取中的 Cancel `data-action="fetch-cancel"`；拉取的状态 `data-testid="fetch-status"`：拉取中 `data-state="fetching"`，取消后 `data-state="cancelled"`（“Fetch cancelled”）；拉取中 Base URL、API key 两个输入框（按标签“Base URL”“API key”找，同现在）带 `readonly`；表单与卡上清单底部关闭用的“Cancel” `data-action="close-form"`（与 `fetch-cancel` 区分），拉取中照样可用 |
| 拉取后（Add provider） | “Detected: …” `data-testid="detected-server"`，`data-kind` 为 `ServerKind`（例如 `vllm`、`ollama`、`unknown`）；Base URL 的说明 `data-testid="base-url-note"`；More settings 一块 `data-testid="more-settings"`（收起时只有“More settings”一行，点它展开）；探针代价的说明 `data-testid="probe-cost-note"`；Add 按钮 `data-action="add-models"`（卡上的清单同） |
| 清单 | `data-testid="checklist"`；Select all `data-action="select-all"`；Clear selection `data-action="clear-selection"`；过滤框 `data-testid="checklist-filter"`；截断说明 `data-testid="checklist-truncated"`；行 `[data-testid="discovered-row"][data-model="<id>"]`：`data-chat` 为 `true` / `false` / `unknown`（`chat` 为 null；手填的行也是 `unknown`），`added` 时 `data-added="true"`，`unusable` 时 `data-unusable="true"`；行的勾选框 `input[name="pick"]`；行里的输入框 `input[data-field]`：`contextWindow`、`maxTokens`、`reasoning`、`image`；行的字段错误 `[data-testid="field-error"][data-field]`（`contextWindow`、`maxTokens`）；Not reported `[data-testid="not-reported"][data-field]`（`contextWindow`、`maxTokens`）；标记 `[data-testid="row-tag"][data-kind]`：`not-chat`、`added`、`unusable`、`entered`；提示 `[data-testid="row-hint"][data-kind]`：`no_tools`、`trained_window` |
| 列表错误 | `data-testid="list-error"`，`data-kind`：`rejected`、`unreachable`、`no_list`、`invalid` |
| Add a model ID | 一行 `data-testid="manual-model"`；输入框 `input[data-field="id"]`；字段错误 `[data-testid="field-error"][data-field="id"]`；按钮 `data-action="add-to-list"` |
| 卡上的清单 | 清单、列表错误、Add a model ID、Add 按钮同上；Not listed 一行 `data-testid="not-listed"`；卡里没有 `detected-server`；清单开着时卡上的 `[data-action="fetch-models"]` 为 `disabled` |
| Keys | 行 `[data-testid="key-row"][data-ref]`，记录 `data-testid="key-state"`（`data-state` 为 `rate_limited` / `auth` / `quota`）；按钮 `data-action`：`key-up`、`key-down`、`key-test`、`key-remove`；内联表单 `data-testid="key-form"`；没有 key 的说明 `data-testid="no-keys"`；行下的测试结果 `data-testid="key-test"` |
| Models 行 | `[data-testid="model-row"][data-model]`（`provider/id`，沿用 v0）；档案摘要 `data-testid="profile"`，各项 `data-field`（`tool_calling`、`tier`、`context`、`reasoning`、`cancel`）与 `data-value`；截断告警 `data-testid="truncation-warning"`；探针出错 `data-testid="probe-error"`；按钮 `data-action`：`verify`、`long-input`、`cancel-test`、`up`、`down`、`edit`、`delete`、`test`；测试结果 `data-testid="model-test"`（沿用 v0） |
| 模型行的提示 | 没报告 `[data-testid="not-reported"][data-field]`（`contextWindow`、`maxTokens`），在 `model-row` 里；提示 `[data-testid="model-hint"][data-kind]`：`context`、`max-output`、`reasoning`、`thinking-seen`、`image`（依次是“模型行的提示”表的五行）；提示的 Use `data-action="use-reported"` |
| 模型表单 | `data-testid="model-form"`（沿用 v0，只有 Edit）；字段错误同提供商表单（`contextWindow`、`maxTokens`） |
| 确认框 | 删除、改地址、删最后一个 key、需要同意的探针都是 `data-testid="confirm-dialog"`，`data-kind`：`delete-provider`、`delete-model`、`delete-group`、`address-change`、`last-key`、`long-input`、`cancel-test`；连带改动列表 `data-testid="cascade"` |
| Groups | 行 `[data-testid="group-row"][data-group]`；成员 `[data-testid="group-member"][data-member]`；成员选择 `data-testid="member-picker"`，项 `data-member`、已选的带 `aria-checked="true"`；`New group` `data-action="new-group"`，内联表单 `data-testid="group-form"`，id 错误 `data-testid="group-error"`；空状态 `data-testid="groups-empty"` |
| Project access | 行 `[data-testid="project-row"][data-path]`；勾选框 `[data-testid="project-zone"][data-zone]`；项目配置错误 `data-testid="project-config-error"`；公网确认 `data-testid="public-dialog"`；空状态 `data-testid="projects-empty"` |

清单行与 Add a model ID 的 `data-field` 取自 `app/src/renderer/src/components/settings/fields.tsx`：`id`、`contextWindow`、`maxTokens`
是现在模型表单字段错误（`FieldError`）的 `data-field`；`reasoning`、`image` 是 `ModelDraft` 里两个勾选框的键。
现在的模型表单只在字段错误上带 `data-field`，输入框本身没有；清单行和 Add a model ID 的输入框直接带它。
