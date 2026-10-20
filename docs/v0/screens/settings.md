# 设置页（M6）

依据：方案 5.12、第 6 节"模型"；pi 1.3.0 的行为见 [../m6-checks.md](../m6-checks.md)"开工前查的 pi 1.3.0 行为"。
连接表单的字段和测试连接的状态沿用 [connection.md](connection.md)（M1），这里只写 M6 改了什么、多了什么。

## 外框

照 Claude 桌面版：设置页左边是分节列表，右边是这一节的内容；顶部"返回会话"。

| 分节 | 内容 |
| --- | --- |
| 连接与模型 | 连接列表、每个连接下的模型、默认模型、每个模型是否支持思考和新会话默认的思考强度 |
| AGENTS.md | 用户级 AGENTS.md 编辑器；当前会话的项目加载了哪些文件 |

- 打开设置页时落在"连接与模型"；"去设置"（错误卡）落在出错会话所用模型的连接上，打开"编辑连接"，焦点在 API key。
- 分节列表可以用 Tab 和 ↑ ↓ 切换；当前分节高亮（`aria-current`）。

## 连接与模型

pi 的 `models.json` 里一个 provider 就是一个"连接"（服务地址、接口类型、兼容选项、key），它下面可以有多个模型。
Mori 的连接用 provider id `mori-endpoint`、`mori-endpoint-2`、`mori-endpoint-3`……（第一个沿用 M0 起的 `mori-endpoint`）。
key 按 provider id 加密保存（`credentials.json`，M0 的做法不变）。默认模型写 pi 设置的 `defaultProvider` / `defaultModel`。

### 列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `config.get` 还没返回 | "正在读取…" | — |
| 读取失败 | `config.get` 报错，或返回的 `modelsError`（pi `modelRuntime.getError()`，例如 `models.json` 写坏了） | 原文 | 修好文件后重新打开设置页 |
| 列表 | `config.get` 的 `connections` | 每个连接一张卡：名称、服务地址、接口类型、key 状态（"key 已加密保存" / "没有 key"）；卡里每个模型一行：模型 ID、上下文长度、思考（"支持思考 · 新会话默认 高" 或 "不支持思考"）；默认模型标"默认" | 编辑连接、添加模型；每个模型：设为默认（不是默认时）、测试、编辑、删除 |
| 没有模型 | `connections` 为空（只在 `models.json` 被手工改空时出现；首次启动走 connection.md 的首次启动页） | "还没有模型" | 添加连接 |
| 有不是 Mori 写的 provider | `models.json` 里 `mori-endpoint*` 以外的 provider | 不列出（pi 照样能用它们，顶栏模型菜单也列出 pi 能用的全部模型，见 [models.md](models.md)） | — |

底部"添加连接"。

### 添加连接（与首次启动同一张表单）

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

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 编辑 | 你点了"编辑连接" | 名称、服务地址、接口类型、API key、兼容选项（不含模型字段）；说明"这个连接下的 N 个模型都用这里的地址和 key"；key 框同 connection.md（已保存时"已加密保存（不显示）；改了服务地址就要重新填写"） | 保存、测试（测这个连接的第一个模型）、取消 |
| 保存 | `endpoint.save` | 同 connection.md 的保存状态；改了服务地址的 origin 又没填 key 时"保存失败：API key is required when the service address changes" | — |
| 已经打开的会话 | 保存后后台进程把打开着的会话换成新的模型对象（m6-checks.md） | 列表上方一行"已保存 · 已经打开的会话下一条消息起用新的设置" | — |

### 添加模型 / 编辑模型

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 添加 | 你在一个连接卡上点了"添加模型" | 标题"添加模型 · <连接名>"；模型 ID、上下文长度、支持思考、新会话默认的思考强度；说明"用这个连接的地址和 key，不用再填 key" | 保存、取消 |
| 编辑 | 你点了模型行的"编辑" | 同上，模型 ID 只读（要换 ID 就删掉再添加） | 保存、取消 |
| 保存 | `model.save` | "已保存"；ID 已存在（添加时）"保存失败：这个连接下已经有模型 <ID>" | — |
| 已经打开的会话 | 同"编辑连接"：用这个模型的会话换成新的模型对象；不再支持思考时思考强度按 pi 收紧为"关"（顶栏随之变化） | 同上 | — |

### 默认、测试与删除

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 设为默认 | `model.setDefault`（pi `setDefaultModelAndProvider`） | "默认"标记移到这一行；说明"新会话用默认模型；已经打开的会话不变" | — |
| 测试中 / 成功 / 失败 / 已取消 | `connection.test`（带 `providerId`、`modelId`），同 connection.md | 结果写在这一行下面 | 取消 |
| 删除确认 | 你点了"删除" | 确认框"删除模型 <ID>？"；这是连接的最后一个模型时说明"连接 <名称> 也会删除，它的 key 一起删除" | 删除；取消（焦点在"取消"） |
| 不能删除 | 它是默认模型而还有别的模型；或它是唯一的模型 | "删除"不可用，悬停说明"默认模型不能删除，先把别的模型设为默认" / "至少要留一个模型" | — |
| 删除后 | `model.delete` | 这一行（或整张卡）消失；正在用它的会话：顶栏模型显示"<ID>（已删除）"，下一条消息仍用打开时的设置，见 [models.md](models.md) | — |

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
| 生效的文件 | `agents.get` 的 `effectivePath`（agentDir 里第一个存在的） | 是这个文件时"生效中：<路径>"；不是时（例如有 `AGENTS.override.md`）警示色"生效的是 <路径>，这里写的不会生效" | 用系统编辑器打开生效的那个文件 |
| 有未保存的改动 | 你改了编辑框 | "保存"可用，旁边"有未保存的改动" | 保存（Ctrl+S 也可以）；撤销改动（回到读到的内容） |
| 保存中 / 已保存 / 保存失败 | `agents.save` | "保存中…"、"已保存 · 新建的会话才会读到"、"保存失败："+ 原文（保留你写的字） | — |
| 离开时有未保存的改动 | 你点了"返回会话"、换到另一节、点了侧栏的会话 / 新会话 / 打开文件夹 / 工具、按 Ctrl+N、把会话拖到中栏 | 确认框"放弃对 AGENTS.md 的改动？"，说明"你改的内容还没有保存。"；按钮"放弃改动"和"继续编辑"，焦点在"继续编辑"，Esc 等于继续编辑 | 放弃改动（照常离开）；继续编辑（留在这里，焦点回到编辑框） |

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
| 设置页 | `data-testid="settings-page"`；分节按钮 `data-testid="settings-nav"` 里的 `button[data-section]`（`connections` / `agents`） |
| 连接卡 | `[data-testid="connection-card"][data-provider]`；模型行 `[data-testid="model-row"][data-model]`（`provider/id`），默认的带 `data-default="true"` |
| 表单 | 添加连接、编辑连接都是 `data-testid="connection-form"`（M1 的测试沿用）；添加 / 编辑模型 `data-testid="model-form"` |
| 结果文字 | 表单里 `data-testid="form-message"`（M1 沿用）；模型行里的测试结果 `data-testid="model-test"` |
| AGENTS.md | 编辑框 `data-testid="agents-editor"`；生效的文件 `data-testid="agents-effective"`；项目级列表 `data-testid="agents-loaded"` |
| 离开确认 | `data-testid="leave-dialog"` |
