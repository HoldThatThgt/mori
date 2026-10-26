# 设置页（Settings，M6）

依据：方案 5.12、第 6 节"模型"；pi 1.3.0 的行为见 [../m6-checks.md](../m6-checks.md)"开工前查的 pi 1.3.0 行为"。
连接表单的字段和测试连接的状态沿用 [connection.md](connection.md)（M1），这里只写 M6 改了什么、多了什么。

## 外框

照 Claude 桌面版：设置页左边是分节列表，右边是这一节的内容；顶部"Back to app"。

| 分节 | 内容 |
| --- | --- |
| Connections and models（v1：见 docs/specs/model-providers.md §9.1：由 Models 分节取代） | 连接列表、每个连接下的模型、默认模型、每个模型是否支持思考和新会话默认的思考强度 |
| AGENTS.md（v1：见 docs/specs/memory.md §10.3：另写每个文件的 token 数与超过 500 的警告，见下"AGENTS.md"） | 用户级 AGENTS.md 编辑器；当前会话的项目加载了哪些文件（2026-10-26 改：负责人走查 M4，整节挪到 Customize 的最后一节 Instructions，提醒线改为 2,000（M15）；状态表见 [../../v1/screens/customize-agents-md.md](../../v1/screens/customize-agents-md.md)，设置页不再有这一节） |

- 打开设置页时落在"Connections and models"；"Go to settings"（错误卡）落在出错会话所用模型的连接上，打开"Edit connection"，焦点在 API key。
  （v1：见 docs/specs/model-providers.md §9.1、§9.3：落在 Models；"Go to settings"删除，说明卡的"Open settings"滚到提供商卡、焦点在 Keys。）
- 分节列表可以用 Tab 和 ↑ ↓ 切换；当前分节高亮（`aria-current`）。
- （v1：见 docs/specs/memory.md §10.8：在"AGENTS.md"下面加第三节"UI issues"，内容是 M7 工作回顾的 UI issues，文字不变，在这一节时右栏可以打开；
  打开设置页仍落在 Models，F8 的"View in Settings"直接进"UI issues"并选中那一份。状态表见 [../../v1/screens/settings-issues.md](../../v1/screens/settings-issues.md)。）
  （2026-10-26 改：AGENTS.md 挪走后设置页只有 Models、UI issues 两节，"UI issues" 在 Models 下面。）

## 连接与模型

> v1：见 docs/specs/model-providers.md §4.1、§9.1：整节由设置 → Models 取代（提供商、多个 key、模型、分组、默认范围、区域与项目授权），配置写 Mori 的 `model-config.json`，不再写 pi 的 `models.json` 和 `defaultProvider` / `defaultModel`；provider id 由名称生成（§4.1）；状态表见 [../../v1/screens/models-settings.md](../../v1/screens/models-settings.md)。

pi 的 `models.json` 里一个 provider 就是一个"连接"（服务地址、接口类型、兼容选项、key），它下面可以有多个模型。
Mori 的连接用 provider id `mori-endpoint`（`models.json` 里还没有 Mori 的连接时，M0 起沿用），之后的连接用
`mori-endpoint-<毫秒时间戳>`；删掉的 id 不再用（理由见 [../defaults.md](../defaults.md)）。
key 按 provider id 加密保存（`credentials.json`，M0 的做法不变）。默认模型写 pi 设置的 `defaultProvider` / `defaultModel`。

### 列表

> v1：见 docs/specs/model-providers.md §9.1（Providers）、§4.1（配置读不出）、§4.5（迁移后 `mori-endpoint*` 以外的 provider 也迁入）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `config.get` 还没返回 | "Loading…" | — |
| 读取失败 | `config.get` 报错，或返回的 `modelsError`（pi `modelRuntime.getError()`，例如 `models.json` 写坏了） | 原文和"Fix the file, then reopen Settings." | 修好文件后重新打开设置页 |
| 设置读不出 | `config.get` 返回的 `settingsError`（pi `SettingsManager` 读 `settings.json` 的错误，例如手工改坏了；pi 这时按空设置处理） | 列表上方原文（带文件路径），与 `modelsError` 同一处、同一句"Fix the file, then reopen Settings."；列表照常显示，没有"Default"标记，思考强度是 pi 的默认值 | 修好文件后重新打开设置页 |
| `models.json` 里有 `//` 注释 | 手工加的注释（pi 读 `models.json` 时允许 `//` 注释和多余的逗号，Mori 读法相同） | 列表照常显示；保存连接、保存模型、删除模型时"Couldn’t save: " / "Couldn’t delete the model: "+ 原文（`<路径> contains // comments that saving would remove; remove them or edit the file by hand`），文件不改，key 不改 | 删掉注释后再保存；或用编辑器手工改 |
| 列表 | `config.get` 的 `connections` | 每个连接一张卡：名称、"<服务地址> · <接口类型>"、key 状态（"Key saved (encrypted)" / "No key"）；卡里每个模型一行：模型 ID、"Context window: 128,000 · Supports thinking · Default effort: High"（不支持思考时最后一段是"Doesn’t support thinking"）；默认模型标"Default" | Edit connection、Add model；每个模型：Set as default（不是默认时）、Test、Edit、Delete… |
| 没有模型 | `connections` 为空（只在 `models.json` 被手工改空时出现；首次启动走 connection.md 的首次启动页） | "No models yet" | Add connection |
| 有不是 Mori 写的 provider | `models.json` 里 `mori-endpoint*` 以外的 provider | 不列出（pi 照样能用它们，输入框下的模型菜单也列出 pi 能用的全部模型，见 [models.md](models.md)） | — |

底部"Add connection"。

### 添加连接（与首次启动同一张表单）

> v1：见 docs/specs/model-providers.md §9.1（提供商表单，命令 `models.saveProvider`）。

字段：名称（Name）、服务地址（Base URL）、接口类型（API type）、API key、模型 ID（Model ID）、上下文长度（Context window）、
兼容选项（Compatibility options）（connection.md），M6 加两项：

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| 支持思考（"Supports thinking"） | `models.json` 模型条目的 `reasoning: true`（不勾时删掉这个字段） | 复选框，说明"pi sends thinking parameters only when this is checked. When it isn’t, the endpoint uses its own default (DeepSeek thinks by default, but you can’t control it)." |
| 新会话默认的思考强度（"Default effort for new sessions"） | pi 设置的 `modelThinkingLevels["<provider>/<模型 ID>"]` | 只在勾了"Supports thinking"时出现；下拉：Off、Minimal、Low、Medium、High（模型映射了 xhigh / max 时还有 Extra high、Max）；默认值是 pi 现在会用的（`modelThinkingLevels` → `defaultThinkingLevel` → Medium）。不勾"Supports thinking"时删掉这一项 |

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 填写 | 你点了"Add connection" | 标题"Add connection"，说明"Enter the base URL, API key, and model ID. When you save, the new connection is added at the end of the list."；空表单，key 框提示"Kept encrypted on this computer after you save" | 填写；Save；Cancel（回到列表） |
| 保存中 / 已保存 / 保存失败 / 配置有错误 | `connection.save`（`providerId: null`）的结果 | 同 connection.md；保存成功后回到列表，新连接在最后 | — |
| 默认模型 | 保存时还没有默认模型（或默认模型已经不在） | 新模型成为默认 | — |

### 编辑连接

> v1：见 docs/specs/model-providers.md §9.1、§4.1：改地址的 origin 删除全部 key 并确认；key 在 Keys 里单独加删（§9.1）；打开着的会话不换模型对象（§4.4 第 6 步、§4.7）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 编辑 | 你点了"Edit connection" | 标题"Edit connection · <名称>"；名称、服务地址、接口类型、API key、兼容选项（不含模型字段）；说明"All N models in this connection use this base URL and key"（只有 1 个时"1 model in this connection uses this base URL and key"）；key 框同 connection.md（已保存时"Saved and encrypted · Re-enter it if you change the base URL"） | Save、Test connection（测这个连接的第一个模型）、Cancel（保存过之后是"Back to list"） |
| 保存 | `endpoint.save` | 同 connection.md 的保存状态；改了服务地址的 origin 又没填 key 时"Couldn’t save: API key is required when the base URL changes"；写 `models.json` 失败时"Couldn’t save: "+ 原文，刚填的 key 撤回（`credentials.json` 恢复成原来的 key，添加连接时删掉），重启后不会和旧的服务地址配在一起 | — |
| 已经打开的会话 | 保存后后台进程把打开着的会话换成新的模型对象（m6-checks.md） | 回到列表时上方一行"Saved · Sessions already open use the new settings from their next message" | — |

### 添加模型 / 编辑模型

> v1：见 docs/specs/model-providers.md §9.1（模型表单：加 Max output、Family、Image input；命令 `models.saveModel`）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 添加 | 你在一个连接卡上点了"Add model" | 标题"Add model · <连接名>"；Model ID、Context window、Supports thinking、Default effort for new sessions；说明"Uses this connection’s base URL and key. You don’t need to enter the key again." | Save、Cancel |
| 编辑 | 你点了模型行的"Edit" | 标题"Edit model · <连接名>"，其余同上，模型 ID 只读（说明"To change the model ID, delete this model and add it again"） | Save、Cancel |
| 保存 | `model.save` | 回到列表，上方"Saved · Sessions already open use the new settings from their next message"；ID 已存在（添加时，界面先检查）"Couldn’t save: this connection already has a model with ID <ID>"；后台进程报错时"Couldn’t save: "+ 原文 | — |
| 已经打开的会话 | 同"编辑连接"：用这个模型的会话换成新的模型对象；不再支持思考时思考强度按 pi 收紧为"Off"（输入框下的 Effort 按钮随之变化） | 同上 | — |

### 默认、测试与删除

> v1：见 docs/specs/model-providers.md §9.1（Defaults 的默认范围、模型行的 Test）、§4.1（删除的连带改动）、§4.6（`pick_missing`）；`model.setDefault`、`model.delete` 删除（§9.4）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 设为默认 | `model.setDefault`（pi `setDefaultModelAndProvider`） | "Default"标记移到这一行；列表上方"<ID> set as default · New sessions use it; sessions already open keep their model" | — |
| 测试中 / 成功 / 失败 / 已取消 | `connection.test`（带 `providerId`、`modelId`），同 connection.md | 测试中按钮是"Testing…"；结果写在这一行下面 | Cancel |
| 删除确认 | 你点了"Delete…" | 确认框"Delete model <ID>?"，说明"This deletes the model from the connection <名称>."；这是连接的最后一个模型时说明"This also deletes the connection <名称> and its key." | Delete；Cancel（焦点在"Cancel"） |
| 不能删除 | 它是默认模型而还有别的模型；或它是唯一的模型 | "Delete…"不可用，悬停说明"Can’t delete the default model. Set another model as default first." / "Keep at least one model" | — |
| 删除后 | `model.delete` | 列表上方"Deleted model <ID>"（连接一起删掉时"Deleted model <ID> and connection <名称>"）；这一行（或整张卡）消失；正在用它的会话：输入框下的模型按钮显示"<ID> (deleted)"，换一个模型再发；连接还在时下一条消息仍用打开时的设置，连接也删了时下一条消息失败（pi 的原文），见 [models.md](models.md)（v1：不再出现，见 [../../v1/screens/model-chat.md](../../v1/screens/model-chat.md)"拒绝启动卡"） | — |

### 反例

- 模型没标"Supports thinking"时，表单里没有"Default effort for new sessions"；输入框下的 Effort 按钮不可选（[models.md](models.md)）。
- "Add model"不出现 key 框，保存不改 `credentials.json`。

## AGENTS.md

> 2026-10-26 改（负责人走查 M4、M15）：这一节整个挪到 Customize（最后一节 `Instructions`，跟随 Customize 的会话，不等 `tools.get`），合计的提醒线由 500 改为 2,000；原来这里的状态表（用户级、项目级、离开确认、反例）连同 v1 加的 token 数一起搬到 [../../v1/screens/customize-agents-md.md](../../v1/screens/customize-agents-md.md)，在那里维护。设置页不再有会先问的编辑器。

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 设置页的结构 | 左边分节列表、右边内容，顶部返回 |
| 有未保存的改动时离开 | 先问，默认按钮是留下（2026-10-26：AGENTS.md 挪到 Customize 后，设置页里没有会先问的编辑器） |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 设置页 | `data-testid="settings-page"`；分节按钮 `data-testid="settings-nav"` 里的 `button[data-section]`（`connections` / `agents`；2026-10-26 改：`agents` 挪到 Customize 的 `tools-nav`；v1：见 docs/specs/model-providers.md §9.1，`connections` 改为 `models`；docs/specs/memory.md §10.8，另有 `issues`） |
| 连接卡（v1：见 docs/specs/model-providers.md §9.1，改为 `provider-card`，见 v1/screens/models-settings.md） | `[data-testid="connection-card"][data-provider]`；模型行 `[data-testid="model-row"][data-model]`（`provider/id`），默认的带 `data-default="true"`；行里的"Edit""Delete…"带 `data-action`（`edit`、`delete`），卡上的带 `edit-connection`、`add-model`，底部"Add connection"带 `add-connection` |
| 表单（v1：见 docs/specs/model-providers.md §9.1：提供商表单改为 `provider-form`，`connection-form` 只留给首次启动表单） | 添加连接、编辑连接都是 `data-testid="connection-form"`（M1 的测试沿用）；添加 / 编辑模型 `data-testid="model-form"` |
| 结果文字 | 表单里 `data-testid="form-message"`（M1 沿用）；模型行里的测试结果 `data-testid="model-test"`（2026-10-26 起 v1 的模型行没有 Test，`model-test` 删掉，见 v1/screens/models-settings.md） |
| AGENTS.md | 2026-10-26 挪到 Customize，见 [../../v1/screens/customize-agents-md.md](../../v1/screens/customize-agents-md.md)"界面测试用的标识" |
| 离开确认 | `data-testid="leave-dialog"`（Customize 的 Instructions 与记忆页的表单用） |
