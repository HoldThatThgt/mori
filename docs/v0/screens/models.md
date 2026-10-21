# 顶栏的模型与思考强度（M6）

依据：方案 5.1（顶栏：会话名、模型、思考强度、权限……）、5.12；pi 行为见 [../m6-checks.md](../m6-checks.md)。
补充 [chat.md](chat.md) 的"顶栏"表：模型从只显示变成可以切换，并加上思考强度。分屏时每一栏各有一组（[split.md](split.md)）。

## 来源

| 来源 | 内容 |
| --- | --- |
| `session.create` / `session.open` 的结果 | `model`（provider/id）、`thinkingLevel`、`thinkingLevels`（这个模型可选的强度，pi `getAvailableThinkingLevels()`）、`reasoning`（模型标了支持思考，pi `supportsThinking()`） |
| `session.setModel` / `session.setThinking` 的结果，和后台进程的 `mori.model_state` 事件 | 同上四项；`mori.model_state` 在你改了这个会话、或在设置里改了它用的模型（换成新的模型对象之后）时发出 |
| pi 的 `thinking_level_changed` 事件 | 新的强度（例如换模型后 pi 改了强度） |
| `config.get` 的 `models` | 模型菜单的列表：pi 现在能用的全部模型（`modelRuntime.getAvailableSnapshot()`，有 key 的），按连接分组，带连接名 |

## 模型

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开中 | 会话还没打开 | 不显示（M3 起） | — |
| 有模型 | `model` | 按钮显示模型 ID 和 ▾；悬停显示"<连接名> · <模型 ID>"，读屏名"Model: <模型 ID>" | 打开菜单 |
| 没有可用模型 | `model` 为 null | "No models available"和 pi 的说明（M1 起） | 打开菜单选一个 |
| 菜单 | 你点了按钮 | 照 Claude 桌面版的模型菜单：按连接分组列出模型，当前的打勾；默认模型后面标"Default"；底部说明"Applies to this session only. New sessions use the default model from Settings."；最后一项"Manage models"打开设置页的"Connections and models" | ↑ ↓、Enter 选择；Esc 关闭；点外面关闭 |
| 切换中 | 你选了一个模型，`session.setModel` 还没返回 | 按钮显示新模型、不可用 | — |
| 已切换 | `session.setModel` 返回 | 按钮显示新模型；思考强度按返回值更新（pi 换模型时按 `modelThinkingLevels` → `defaultThinkingLevel` → 原来的强度重新定） | 下一条消息由新模型回复 |
| 切换失败 | `session.setModel` 报错（例如 `No API key for …`） | 对话流里一张错误卡，原文；按钮回到原来的模型 | — |
| 生成中 | 本轮运行中 | 按钮不可用，悬停"Can’t switch models until the response finishes" | 停止后再切 |
| 模型已删除 | `model` 不在菜单列表里（在设置里删掉了；`models.json` 读不出时不算） | 按钮显示"<ID> (deleted)"，悬停说明也标" (deleted)"。连接里还有别的模型时，会话仍用打开时的设置；连接也删除了时，pi 找不到这个连接，下一条消息失败（错误卡显示 pi 的原文，实测 `No API key found for mori-endpoint-<数字>. Use /login …`；原文里有 API key 字样，错误卡也附"Go to settings"，这个连接已经不在，设置页落在连接列表上） | 打开菜单换一个 |

## 思考强度

思考强度在界面上叫"Effort"（按钮"Effort: <强度>"，菜单的读屏名"Effort"）。
各档的文字：off "Off"、minimal "Minimal"、low "Low"、medium "Medium"、high "High"、xhigh "Extra high"、max "Max"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 没有可用模型 | `model` 为 null | 不显示思考按钮 | — |
| 支持思考 | `reasoning` 为真 | 按钮"Effort: High ▾"，悬停"Set the effort level for this session" | 打开菜单 |
| 不支持思考 | `reasoning` 为假 | 按钮"Effort: Unavailable ▾"，样式变淡但可以点开，悬停"This model isn’t marked “Supports thinking”"；菜单里的强度都不可用，说明"This model isn’t marked “Supports thinking”, so pi doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Connections and models and check “Supports thinking”." | 打开菜单看说明；"Open settings" |
| 菜单 | 你点了按钮 | `thinkingLevels` 里的强度，当前的打勾；底部说明"Applies to this session only. Set each model’s default for new sessions in Settings." | ↑ ↓、Enter；Esc |
| 切换中 / 已切换 / 失败 | `session.setThinking` | 同模型 | — |
| 生成中 | 本轮运行中 | 按钮不可用，悬停"Can’t change effort until the response finishes" | — |
| 重新打开的会话 | pi 按会话记录里最后一条 `thinking_level_change` 恢复 | 显示恢复后的强度 | — |

## 窄栏

模型和思考按钮在任何宽度都显示、可以点，按会话面板的宽度分步收紧（单栏、分屏相同；最窄的两种是分屏每栏 280px、
800 宽窗口右栏打开时中栏 300px）。收起的文字都在按钮的读屏名称里（"Model: <ID> (deleted)"、"Effort: High"），
模型按钮的悬停说明是"<连接名> · <ID> (deleted)"。阈值按最宽的英文量（Segoe UI 12px）："Effort: Unavailable ▾"、"Ask each time"、"Context 100%"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 宽 | 会话面板宽于 760px | 模型按钮（最长 160px）、"Effort: High ▾"、带盾牌图标的权限按钮 | 打开菜单 |
| 稍窄 | ≤ 760px | 权限按钮去掉盾牌图标 | 同上 |
| 较窄 | ≤ 720px | 模型按钮最长 120px | 同上 |
| 不显示项目名 | ≤ 660px（分屏时每栏 ≤ 690px） | 顶栏不显示项目名和 › | 同上 |
| 窄 | ≤ 600px | 思考按钮只显示强度："High ▾"、"Unavailable ▾"；两个菜单贴着会话面板右边打开，不伸出面板（按钮可能贴着窗口或右栏；右边的权限菜单也一样）。≤ 500px 时也不显示上下文用量 | 同上 |
| 很窄 | ≤ 400px | 两个按钮去掉 ▾，间距收小；权限按钮只显示盾牌图标（"Allow all" 仍用警示色），模式名在读屏名"Permission mode: Ask each time"里 | 同上 |
| 放不下 | 按钮区比顶栏剩下的地方宽 | 模型按钮收短（省略号），最窄 40px：先截模型 ID，" (deleted)"最后截；会话名至少留 36px | 同上 |

## 反例

- 模型没标支持思考时，思考强度的选项都不可用（不是只藏起来），并说明原因。
- 顶栏切换模型或思考强度不改设置里的默认（pi 不 persist）；新会话仍用默认模型和它的默认强度。
- 顶栏切到"Off"之后，下一次回复没有思考内容（DeepSeek 实测：pi 发 `thinking: disabled`）。

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 模型菜单 | 一个按钮显示当前模型，点开是列表、当前项打勾、可以从菜单进入管理；只作用于当前会话 |
| 思考强度 | 与模型分开的一个按钮（方案 5.1 把它们列为顶栏的两项），菜单形式同上 |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 模型按钮 | 每一栏里 `data-testid="model-button"`；菜单 `data-testid="model-menu"`，项 `role="menuitemradio"`，`data-model` 为 provider/id |
| 思考按钮 | `data-testid="thinking-button"`（`data-level` 为当前强度，不支持思考时 `data-reasoning="false"`）；菜单 `data-testid="thinking-menu"`，项 `role="menuitemradio"`，`data-level` |
