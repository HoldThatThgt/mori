# 设置 → Models

依据：规格 §4（配置、删除的连带改动、改地址、配置读不出、迁移、项目授权）、§7（档案与探针）、§8.3（key 的记录）、
§9.1、§9.3、§9.4、§9.5。取代 [v0 settings.md](../../v0/screens/settings.md) 的“Connections and models”分节；AGENTS.md 分节不变。
界面文字为英文（规格 §0），写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `models.get` / `models.reload` 的结果 | `config`（key 只有 `{ ref, label }`）、`profiles`、`keyStatus`（每个有记录的 key：`{ state, until }`）、`zoneSuggestions`（每个提供商的建议区域，§12）、`migration`（迁移说明或 null）、`projects`（`{ path, zones, projectZones, projectConfig }`）、`loadError`（配置读不出时的路径与原文）、`reserved`（保留 id） |
| `models.*` 写命令的结果 | `error: string \| null`；`models.saveProvider` 另给 `providerId`，`models.addKey` 另给 `ref` |
| `mori.profiles`（全局信封） | 全部 `ProfileView`，以及 `running: { ref, step, of }[]`（正在跑的探针） |
| `mori.key_status`（全局信封） | 全部有记录的 key：`ref → { state: 'rate_limited' \| 'auth' \| 'quota', until }`；key 的记录变化时发出 |
| `connection.test` 的结果 | `{ providerId, modelId, keyRef? }` 的测试结果：成功（首字时间、总时间、是否有思考内容、回复开头）、失败（原文）、已取消 |
| `config.get` 的结果 | `configError`（配置读不出，§4.1）、`settingsError`（pi 的 `settings.json` 读不出，沿用 v0） |
| 你的操作 | 打开分节、打开表单、确认框、勾选 |

写命令成功后界面重新调 `models.get`，按它的结果显示（临时，走查时可以改）；两次之间档案与 key 记录由
`mori.profiles`、`mori.key_status` 更新。

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
  Confirm zone、Dismiss。改了就发对应的写命令，没有 Save 按钮。
- 按“Save”保存：提供商表单、模型表单（以及 Keys 的 Add key 内联表单，它的“Save”就是这一次加 key）。
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
| 列表 | `config.providers`（按配置顺序） | 每个提供商一张卡：名称；“Base URL”、“API type”（三种显示名同表单）、“Network zone”（Local / Intranet / Public；未确认时“Not confirmed”）、“Concurrency per key”、“Compatibility options”（勾了的兼容选项的英文说明，逗号分隔；没有时“None”）；下面是 Keys 和 Models 两块。字段名都是临时，走查时可以改 | Edit；Delete…；Test connection；Add model；节底部“Add provider”（临时，走查时可以改） |
| 没有提供商 | `config.providers` 为空（例如删掉了最后一个提供商） | “No providers yet. Add one to start a session.”（临时，走查时可以改） | Add provider |
| 测试中 | 你点了“Test connection”，`connection.test`（`{ providerId, modelId: 第一个模型 }`，不带 `keyRef`，用第一个可用的 key）还没返回 | 按钮变为“Testing…”（临时，走查时可以改），旁边“Cancel” | Cancel（`connection.testCancel`） |
| 测试结果 | `connection.test` 返回 | 卡内显示结果，文字见下“测试结果的文字”。没有 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限，`server` 不重试直接报告（§9.1） | 再次测试 |
| 删除确认 | 你点了“Delete…” | 确认框，文字见下“确认框的文字”：列出连带改动（§4.1） | Delete；Cancel（焦点在 Cancel，Esc 等于 Cancel） |
| 已删除 | `models.deleteProvider` 返回无错误 | 卡消失；Groups、Defaults 按连带改动更新；范围指向被删名字的打开会话出现 `pick_missing` 拒绝启动卡（model-chat.md） | — |
| 删除失败 | 返回 `error`（例如编译出错回滚，§4.4 第 5 步） | 确认框里原文，不关闭；配置不变 | 再试；Cancel |

### 提供商表单（新建 / Edit）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 新建 | 你点了“Add provider” | 标题“Add provider”（临时，走查时可以改）；字段 Name、Base URL、API type（“OpenAI-compatible (Chat Completions)”、“OpenAI Responses”、“Anthropic Messages”，默认第一项）、Network zone（Local / Intranet / Public，预选建议值，见下）、Concurrency per key（默认 4，1–64）、兼容选项（只在 API type 为 `openai-completions` 时，六个勾选框，文字用 §9.1 的英文说明）；另有第一个 key（Label 默认“Key 1”、Secret 密码框，可空）和第一个模型（同模型表单的字段） | Save；Cancel |
| Edit | 你点了卡上的“Edit” | 标题“Edit provider · <name>”（临时，走查时可以改）；同上，不含 key 和模型字段；Network zone 是当前值，不自动改 | Save；Cancel |
| 区域的建议值 | §12 的规则，按 Base URL 算 | 新建时：你还没手动选过区域，Base URL 一改预选就跟着改；你选过之后不再自动改（临时，走查时可以改） | 改选 |
| 字段错误 | 界面先按 §4.1 检查 | 字段旁英文错误，文字见下“字段错误的文字”；有错误时 Save 不可用 | 修改 |
| 改地址的确认 | Edit 时 Base URL 的 origin（协议、主机、端口）变了、提供商有 N 个 key（N ≥ 1），你点了 Save | 确认框，文字见下 | 确认（保存并删除全部 key）；Cancel（不保存，表单留着） |
| 保存中 | `models.saveProvider` 还没返回 | 按钮不可用 | — |
| 已保存 | 返回无错误（新建时给 `providerId`，id 由 Name 生成，§4.1） | 表单关闭；新提供商的卡在最后；它的模型自动开始探针（Models 行显示 Verifying…）；改了地址、接口或兼容选项时 key 与提供商的不可用记录清除（§8.3） | — |
| 保存失败 | 返回 `error`（校验、编译出错回滚，§4.4 第 5 步） | 表单里原文；配置不变；新建时本次存下的 key 已被删除（§9.1） | 修改后再保存 |

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
| 模型行 | `config.providers[].models`（按顺序，就是范围里的顺序） | 模型 id；“Context window: <窗口>”、“Max output: <最大输出>”、“Family: <模型族>”（为空时不显示）、“Supports thinking”（勾了时显示）；数字按千分位写（临时，走查时可以改） | Verify；Long-input test…；Cancel test…（只对 `server.kind` 为 `vllm`、`sglang`、`llamacpp` 的）；上移；下移；Edit；Delete…；Test |
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

### 需要你同意的探针

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 长输入确认 | 你点了“Long-input test…” | 确认框，文字见下（写明大约多少 token：有效窗口的 50% + 90%，§7.4） | Run test（`models.verify`，`tests: 'long_input'`）；Cancel |
| 取消探针确认 | 你点了“Cancel test…” | 确认框，文字见下 | Run test（`tests: 'cancel'`）；Cancel |
| 运行中 | `mori.profiles` 的 `running` 有这个 ref | 同“重新验证中” | — |
| 结果 | 探针结束后的 `mori.profiles` | Context 更新（截断时告警）；Cancel 更新为 Verified / Not verified / Unknown | — |

### 模型表单（新建 / Edit）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 新建 | 你在提供商卡上点了“Add model”（临时，走查时可以改） | 标题“Add model · <provider name>”（临时，走查时可以改）；字段 Model ID、Context window（默认 128000，临时，走查时可以改）、Max output（默认 16384 与窗口一半中较小的，你没改过时随窗口变）、Family（可空）、Supports thinking、Image input、Default effort for new sessions（只在勾了 Supports thinking 时，写 pi 设置的 `modelThinkingLevels`；选项 Off / Minimal / Low / Medium / High / Extra high / Max，默认 Medium，临时，走查时可以改） | Save；Cancel |
| Edit | 你点了行的“Edit” | 标题“Edit model · <provider name>”（临时，走查时可以改）；同上，Model ID 只读 | Save；Cancel |
| 字段错误 | 界面先查：id 为空或含空白、同一提供商内重复、窗口不是正整数、Max output 不是正整数或不小于窗口 | 字段旁英文错误（见下“字段错误的文字”），Save 不可用 | 修改 |
| 保存 | `models.saveModel`（`{ providerId, model, adding, thinkingLevel? }`） | 成功：表单关闭，行更新，自动开始探针（新模型、或指纹变了时）；失败：表单里原文 | — |

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

能与 `shared/models.ts` 的 zod 文字一致的用同一句；其余是临时，走查时可以改。

| 字段 | 文字 |
| --- | --- |
| Name 为空 | “Name is required.” |
| Base URL 不是 http/https URL | “Base URL must be an http or https URL.” |
| Concurrency per key 不在 1–64 | “Use a whole number from 1 to 64.” |
| Model ID 为空或含空白 | “Model ID must be non-empty and contain no spaces.” |
| Model ID 在提供商内重复 | “Model IDs must be unique within a provider.” |
| Context window 不是正整数 | “Context window must be a whole number above 0.” |
| Max output 不是正整数 | “Max output must be a whole number above 0.” |
| Max output 不小于窗口 | “Max output must be smaller than the context window.” |
| key 的 Label 为空 | “Label is required.” |
| key 的 Secret 为空 | Save 不可用，不出文字 |

## 写命令的共同规则

- 每个写命令保存后后台进程编译（§4.4）、对打开的会话重新做静态校验并发 `mori.model_state`、需要时发起探针（§7.4）；
  界面随后重新 `models.get`。
- 编译出错时保存失败、配置文件不改，错误原文显示在发起这次保存的地方（§4.4 第 5 步）。
- 界面的操作记录（F8 的“最近的操作”）对 `models.*` 只记类型和 id，例如“Add key <providerId>”，不含 `secret`、`keySecret`（§9.4）。

## 反例

- key 的明文在任何地方都不显示、不回填、不能编辑；换 key = 加新的再删旧的。
- “Allowed zones for all projects”里没有 Public。
- 勾 public 时取消确认框，不写配置。
- 只改提供商名称、并发上限、区域或模型列表，不清除 key 与提供商的记录（§8.3）。
- 配置读不出时不显示首次启动表单，也不显示 Models 的其他分节，文件不被覆盖。
- 探针、Test connection、key 的 Test 不按项目区域过滤；区域未确认的提供商也可以测试和探测（§4.3）。
- 改了默认范围，已有会话的范围不变。
- Defaults、Groups、Project access、Keys、上移下移没有 Save 按钮。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中“Loading…”；立即保存成功不提示；迁移说明各行的写法；
区域未确认的说明句与“<name> · <address>”、卡上的“Not confirmed”、Confirm 对话框标题；Defaults 下拉的节名与项的写法；
提供商卡的字段名；“Add provider”“Add model”与三种空状态；表单标题；区域建议值在新建时随 Base URL 变、手动选过后不再变；
测试中“Testing…”、已取消“Test cancelled”；各确认框的标题、按钮与连带改动的写法；字段错误的文字；
满 8 个 key 的说明；保留 id 的错误；New group 的内联表单（id 加至少一个成员再 Create）；Project access 的“Allowed: …”；
项目配置无效时勾选框照常可用；模型表单 Context window 默认 128000、思考强度选项的英文名；写命令成功后重新 `models.get`。

## 需要规格回答

- 提供商表单与首次启动表单要对**还没保存**的 Base URL 预选建议区域，但 `models.get` 的 `zoneSuggestions` 只按已保存的提供商 id 给出，
  §12 的规则在 `kernel/modelConfig.ts`（界面不能 import 内核）。界面从哪里拿到这个建议，规格没说。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | 设置页 `data-testid="settings-page"`；分节按钮 `[data-testid="settings-nav"] button[data-section="models"]`（取代 `connections`） |
| 读取中 | `data-testid="models-loading"` |
| 配置读不出 | `data-testid="models-load-error"`，“Retry” `data-action="reload"` |
| 迁移说明 | `data-testid="migration-notice"`，“Dismiss” `data-action="dismiss"` |
| 区域未确认 | 每行 `[data-testid="zone-unconfirmed"][data-provider]`，按钮 `data-action="confirm-zone"`；确认框 `data-testid="zone-dialog"`，单选 `input[name="zone"][value]` |
| Defaults | 下拉 `data-testid="default-pick"`；勾选框 `[data-testid="allowed-zone"][data-zone]` |
| 提供商卡 | `[data-testid="provider-card"][data-provider]`，区域 `data-testid="provider-zone"`（`data-zone`，未确认时 `unconfirmed`）；卡上按钮 `data-action`：`edit-provider`、`delete-provider`、`test-provider`、`add-model`、`add-key`；节底部 `add-provider`；空状态 `data-testid="providers-empty"`；测试结果 `data-testid="test-result"` |
| 测试中的取消 | 三处测试都用 `data-action="test-cancel"` |
| 提供商表单 | `data-testid="provider-form"`；区域单选 `input[name="zone"][value]`；结果文字 `data-testid="form-message"`；字段错误 `[data-testid="field-error"][data-field]` |
| Keys | 行 `[data-testid="key-row"][data-ref]`，记录 `data-testid="key-state"`（`data-state` 为 `rate_limited` / `auth` / `quota`）；按钮 `data-action`：`key-up`、`key-down`、`key-test`、`key-remove`；内联表单 `data-testid="key-form"`；没有 key 的说明 `data-testid="no-keys"`；行下的测试结果 `data-testid="key-test"` |
| Models 行 | `[data-testid="model-row"][data-model]`（`provider/id`，沿用 v0）；档案摘要 `data-testid="profile"`，各项 `data-field`（`tool_calling`、`tier`、`context`、`reasoning`、`cancel`）与 `data-value`；截断告警 `data-testid="truncation-warning"`；探针出错 `data-testid="probe-error"`；按钮 `data-action`：`verify`、`long-input`、`cancel-test`、`up`、`down`、`edit`、`delete`、`test`；测试结果 `data-testid="model-test"`（沿用 v0） |
| 模型表单 | `data-testid="model-form"`（沿用 v0）；字段错误同提供商表单 |
| 确认框 | 删除、改地址、删最后一个 key、需要同意的探针都是 `data-testid="confirm-dialog"`，`data-kind`：`delete-provider`、`delete-model`、`delete-group`、`address-change`、`last-key`、`long-input`、`cancel-test`；连带改动列表 `data-testid="cascade"` |
| Groups | 行 `[data-testid="group-row"][data-group]`；成员 `[data-testid="group-member"][data-member]`；成员选择 `data-testid="member-picker"`，项 `data-member`、已选的带 `aria-checked="true"`；`New group` `data-action="new-group"`，内联表单 `data-testid="group-form"`，id 错误 `data-testid="group-error"`；空状态 `data-testid="groups-empty"` |
| Project access | 行 `[data-testid="project-row"][data-path]`；勾选框 `[data-testid="project-zone"][data-zone]`；项目配置错误 `data-testid="project-config-error"`；公网确认 `data-testid="public-dialog"`；空状态 `data-testid="projects-empty"` |
