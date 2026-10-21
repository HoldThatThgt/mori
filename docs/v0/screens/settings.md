# 设置页（M6）

依据：方案 5.12、第 6 节"模型"；pi 1.3.0 的行为见 [../m6-checks.md](../m6-checks.md)"开工前查的 pi 1.3.0 行为"。
连接表单的字段和测试连接的状态沿用 [connection.md](connection.md)（M1），这里只写 M6 改了什么、多了什么。

## 外框

照 Claude 桌面版：设置页左边是分节列表，右边是这一节的内容；顶部"返回会话"。

| 分节 | 内容 |
| --- | --- |
| 连接与模型（v1：见 docs/specs/model-providers.md §9.1：由 Models 分节取代） | 连接列表、每个连接下的模型、默认模型、每个模型是否支持思考和新会话默认的思考强度 |
| AGENTS.md | 用户级 AGENTS.md 编辑器；当前会话的项目加载了哪些文件 |

- 打开设置页时落在"连接与模型"；"去设置"（错误卡）落在出错会话所用模型的连接上，打开"编辑连接"，焦点在 API key。
  （v1：见 docs/specs/model-providers.md §9.1、§9.3：落在 Models；"去设置"删除，说明卡的"Open settings"滚到提供商卡、焦点在 Keys。）
- 分节列表可以用 Tab 和 ↑ ↓ 切换；当前分节高亮（`aria-current`）。

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
| 读取中 | `config.get` 还没返回 | "正在读取…" | — |
| 读取失败 | `config.get` 报错，或返回的 `modelsError`（pi `modelRuntime.getError()`，例如 `models.json` 写坏了） | 原文 | 修好文件后重新打开设置页 |
| 设置读不出 | `config.get` 返回的 `settingsError`（pi `SettingsManager` 读 `settings.json` 的错误，例如手工改坏了；pi 这时按空设置处理） | 列表上方原文（带文件路径），与 `modelsError` 同一处、同一句"修好文件后重新打开设置页。"；列表照常显示，没有"默认"标记，思考强度是 pi 的默认值 | 修好文件后重新打开设置页 |
| `models.json` 里有 `//` 注释 | 手工加的注释（pi 读 `models.json` 时允许 `//` 注释和多余的逗号，Mori 读法相同） | 列表照常显示；保存连接、保存模型、删除模型时"保存失败：" / "删除失败："+ 原文（`<路径> contains // comments that saving would remove; …`），文件不改，key 不改 | 删掉注释后再保存；或用编辑器手工改 |
| 列表 | `config.get` 的 `connections` | 每个连接一张卡：名称、服务地址、接口类型、key 状态（"key 已加密保存" / "没有 key"）；卡里每个模型一行：模型 ID、上下文长度、思考（"支持思考 · 新会话默认 高" 或 "不支持思考"）；默认模型标"默认" | 编辑连接、添加模型；每个模型：设为默认（不是默认时）、测试、编辑、删除 |
| 没有模型 | `connections` 为空（只在 `models.json` 被手工改空时出现；首次启动走 connection.md 的首次启动页） | "还没有模型" | 添加连接 |
| 有不是 Mori 写的 provider | `models.json` 里 `mori-endpoint*` 以外的 provider | 不列出（pi 照样能用它们，顶栏模型菜单也列出 pi 能用的全部模型，见 [models.md](models.md)） | — |

底部"添加连接"。

### 添加连接（与首次启动同一张表单）

> v1：见 docs/specs/model-providers.md §9.1（提供商表单，命令 `models.saveProvider`）。

字段：名称、服务地址、接口类型、API key、模型 ID、上下文长度、兼容选项（connection.md），M6 加两项：

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| 支持思考 | `models.json` 模型条目的 `reasoning: true`（不勾时删掉这个字段） | 复选框，说明"勾选后 pi 才会发送思考参数；不勾时端点按自己的默认处理（DeepSeek 默认会思考，但不能控制）" |
| 新会话默认的思考强度 | pi 设置的 `modelThinkingLevels["<provider>/<模型 ID>"]` | 只在勾了"支持思考"时出现；下拉：关、最低、低、中、高（模型映射了 xhigh / max 时还有很高、最高）；默认值是 pi 现在会用的（`modelThinkingLevels` → `defaultThinkingLevel` → 中）。不勾"支持思考"时删掉这一项 |

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 填写 | 你点了"添加连接" | 空表单，key 框提示"保存后由 Mori 加密存放在本机" | 填写；保存；取消（回到列表） |
| 保存中 / 已保存 / 保存失败 / 配置有错误 | `connection.save`（`providerId: null`）的结果 | 同 connection.md；保存成功后回到列表，新连接在最后 | — |
| 默认模型 | 保存时还没有默认模型（或默认模型已经不在） | 新模型成为默认 | — |

### 编辑连接

> v1：见 docs/specs/model-providers.md §9.1、§4.1：改地址的 origin 删除全部 key 并确认；key 在 Keys 里单独加删（§9.1）；打开着的会话不换模型对象（§4.4 第 6 步、§4.7）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 编辑 | 你点了"编辑连接" | 名称、服务地址、接口类型、API key、兼容选项（不含模型字段）；说明"这个连接下的 N 个模型都用这里的地址和 key"；key 框同 connection.md（已保存时"已加密保存（不显示）；改了服务地址就要重新填写"） | 保存、测试（测这个连接的第一个模型）、取消 |
| 保存 | `endpoint.save` | 同 connection.md 的保存状态；改了服务地址的 origin 又没填 key 时"保存失败：API key is required when the service address changes"；写 `models.json` 失败时"保存失败："+ 原文，刚填的 key 撤回（`credentials.json` 恢复成原来的 key，添加连接时删掉），重启后不会和旧的服务地址配在一起 | — |
| 已经打开的会话 | 保存后后台进程把打开着的会话换成新的模型对象（m6-checks.md） | 列表上方一行"已保存 · 已经打开的会话下一条消息起用新的设置" | — |

### 添加模型 / 编辑模型

> v1：见 docs/specs/model-providers.md §9.1（模型表单：加 Max output、Family、Image input；命令 `models.saveModel`）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 添加 | 你在一个连接卡上点了"添加模型" | 标题"添加模型 · <连接名>"；模型 ID、上下文长度、支持思考、新会话默认的思考强度；说明"用这个连接的地址和 key，不用再填 key" | 保存、取消 |
| 编辑 | 你点了模型行的"编辑" | 同上，模型 ID 只读（要换 ID 就删掉再添加） | 保存、取消 |
| 保存 | `model.save` | "已保存"；ID 已存在（添加时，界面先检查）"保存失败：这个连接下已经有模型 <ID>"；后台进程报错时"保存失败："+ 原文 | — |
| 已经打开的会话 | 同"编辑连接"：用这个模型的会话换成新的模型对象；不再支持思考时思考强度按 pi 收紧为"关"（顶栏随之变化） | 同上 | — |

### 默认、测试与删除

> v1：见 docs/specs/model-providers.md §9.1（Defaults 的默认范围、模型行的 Test）、§4.1（删除的连带改动）、§4.6（`pick_missing`）；`model.setDefault`、`model.delete` 删除（§9.4）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 设为默认 | `model.setDefault`（pi `setDefaultModelAndProvider`） | "默认"标记移到这一行；说明"新会话用默认模型；已经打开的会话不变" | — |
| 测试中 / 成功 / 失败 / 已取消 | `connection.test`（带 `providerId`、`modelId`），同 connection.md | 结果写在这一行下面 | 取消 |
| 删除确认 | 你点了"删除" | 确认框"删除模型 <ID>？"；这是连接的最后一个模型时说明"连接 <名称> 也会删除，它的 key 一起删除" | 删除；取消（焦点在"取消"） |
| 不能删除 | 它是默认模型而还有别的模型；或它是唯一的模型 | "删除"不可用，悬停说明"默认模型不能删除，先把别的模型设为默认" / "至少要留一个模型" | — |
| 删除后 | `model.delete` | 这一行（或整张卡）消失；正在用它的会话：顶栏模型显示"<ID>（已删除）"，换一个模型再发；连接还在时下一条消息仍用打开时的设置，连接也删了时下一条消息失败（pi 的原文），见 [models.md](models.md) | — |

### 反例

- 模型没标"支持思考"时，表单里没有"新会话默认的思考强度"；顶栏的思考强度不可选（[models.md](models.md)）。
- "添加模型"不出现 key 框，保存不改 `credentials.json`。

## AGENTS.md

pi 每个目录只读第一个存在的 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`；先读 agentDir 的一个，
再从文件系统根到工作目录逐级读（m6-checks.md）。不受项目信任控制。

### 用户级

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `agents.get` 还没返回 | "正在读取…"，编辑框不可用 | — |
| 读取失败 | `agents.get` 报错 | 原文 | 重新打开这一节 |
| 文件不存在 | `agents.get` 的 `content` 为 null | 路径 `<agentDir>\AGENTS.md`；"还没有这个文件，保存后创建"；空编辑框 | 编辑、保存 |
| 已有文件 | `content` | 路径；编辑框里是文件内容 | 编辑 |
| 生效的是这个文件 | `agents.get` 的 `effectivePath`（agentDir 里第一个存在的）就是 `<agentDir>\AGENTS.md` | "生效中：<路径>" | 用系统编辑器打开它 |
| 被 AGENTS.override.md 盖住 | `effectivePath` 是 `AGENTS.override.md`（pi 的顺序里只有它排在 `AGENTS.md` 前面） | 警示色"生效的是 <路径>，这里写的不会生效" | 用系统编辑器打开它 |
| 现在生效的是 CLAUDE.md | 还没有 `AGENTS.md`，`effectivePath` 是 `CLAUDE.md` / `CLAUDE.MD`（排在 `AGENTS.md` 后面） | 警示色"现在生效的是 <路径>；保存后改读这里的 AGENTS.md，它不再加载"；保存后变成"生效中：<agentDir>\AGENTS.md" | 用系统编辑器打开它（可以先把内容抄过来） |
| 有未保存的改动 | 你改了编辑框 | "保存"可用，旁边"有未保存的改动" | 保存（Ctrl+S 也可以）；撤销改动（回到读到的内容） |
| 保存中 / 已保存 / 保存失败 | `agents.save` | "保存中…"、"已保存 · 新建的会话才会读到"、"保存失败："+ 原文（保留你写的字） | — |
| 离开时有未保存的改动 | 你点了"返回会话"、换到另一节、点了侧栏的会话 / 新会话 / 打开文件夹 / 工具、按 Ctrl+N（把会话拖到设置页上不能放下，见 [split.md](split.md)，所以不会离开） | 确认框"放弃对 AGENTS.md 的改动？"，说明"你改的内容还没有保存。"；按钮"放弃改动"和"继续编辑"，焦点在"继续编辑"，Esc 等于继续编辑 | 放弃改动（编辑框回到读到的内容，照常离开；离开没有发生时，例如取消了选文件夹，留在这里，没有未保存的改动）；继续编辑（留在这里，什么都不变：点的已归档会话不恢复，焦点回到编辑框） |

关闭 Mori 窗口时不问（交付说明列出）。

### 项目级（只列出）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有焦点会话 | `agents.get`（带焦点会话的 sessionId）的 `loaded`：这个会话的资源加载器实际加载的文件（`getAgentsFiles()`，去掉 agentDir 里的那个） | 标题"<项目名> 加载的文件"；每个文件一行完整路径；没有时"这个项目没有加载 AGENTS.md 或 CLAUDE.md"；说明"会话打开时读取；之后改了文件，新会话才会读到" | 每行"用系统编辑器打开"（主进程 `openPath`，M4 起的做法） |
| 没有打开的会话 | 没有焦点会话 | "打开一个会话后，这里列出它的项目加载了哪些文件。" | — |

### 反例

- 项目级的文件不能在 Mori 里编辑。
- 写进 AGENTS.md 的要求只对之后新建的会话生效，已经打开的会话不变（界面明说）。

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 设置页的结构 | 左边分节列表、右边内容，顶部返回 |
| 有未保存的改动时离开 | 先问，默认按钮是留下 |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 设置页 | `data-testid="settings-page"`；分节按钮 `data-testid="settings-nav"` 里的 `button[data-section]`（`connections` / `agents`；v1：见 docs/specs/model-providers.md §9.1，`connections` 改为 `models`） |
| 连接卡（v1：见 docs/specs/model-providers.md §9.1，改为 `provider-card`，见 v1/screens/models-settings.md） | `[data-testid="connection-card"][data-provider]`；模型行 `[data-testid="model-row"][data-model]`（`provider/id`），默认的带 `data-default="true"`；行里的"编辑""删除"带 `data-action`（`edit`、`delete`），卡上的带 `edit-connection`、`add-model`，底部"添加连接"带 `add-connection` |
| 表单（v1：见 docs/specs/model-providers.md §9.1：提供商表单改为 `provider-form`，`connection-form` 只留给首次启动表单） | 添加连接、编辑连接都是 `data-testid="connection-form"`（M1 的测试沿用）；添加 / 编辑模型 `data-testid="model-form"` |
| 结果文字 | 表单里 `data-testid="form-message"`（M1 沿用）；模型行里的测试结果 `data-testid="model-test"` |
| AGENTS.md | 编辑框 `data-testid="agents-editor"`；生效的文件 `data-testid="agents-effective"`；项目级列表 `data-testid="agents-loaded"` |
| 离开确认 | `data-testid="leave-dialog"` |
