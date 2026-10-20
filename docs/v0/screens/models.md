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
| 有模型 | `model` | 按钮显示模型 ID 和 ▾；悬停显示"<连接名> · <模型 ID>" | 打开菜单 |
| 没有可用模型 | `model` 为 null | "没有可用模型"和 pi 的说明（M1 起） | 打开菜单选一个 |
| 菜单 | 你点了按钮 | 照 Claude 桌面版的模型菜单：按连接分组列出模型，当前的打勾；默认模型后面标"默认"；底部说明"只作用于这个会话；新会话用设置里的默认模型"；最后一项"管理模型…"打开设置页的"连接与模型" | ↑ ↓、Enter 选择；Esc 关闭；点外面关闭 |
| 切换中 | 你选了一个模型，`session.setModel` 还没返回 | 按钮显示新模型、不可用 | — |
| 已切换 | `session.setModel` 返回 | 按钮显示新模型；思考强度按返回值更新（pi 换模型时按 `modelThinkingLevels` → `defaultThinkingLevel` → 原来的强度重新定） | 下一条消息由新模型回复 |
| 切换失败 | `session.setModel` 报错（例如 `No API key for …`） | 对话流里一张错误卡，原文；按钮回到原来的模型 | — |
| 生成中 | 本轮运行中 | 按钮不可用，悬停"生成中不能切换模型" | 停止后再切 |
| 模型已删除 | `model` 不在菜单列表里（在设置里删掉了） | 按钮显示"<ID>（已删除）"；会话仍用打开时的设置，直到你换一个 | 打开菜单换一个 |

## 思考强度

文字：off 关、minimal 最低、low 低、medium 中、high 高、xhigh 很高、max 最高。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 支持思考 | `reasoning` 为真 | 按钮"思考：高 ▾" | 打开菜单 |
| 不支持思考 | `reasoning` 为假 | 按钮"思考：不可选"，样式变淡但可以点开；菜单里的强度都不可用，说明"这个模型没有标'支持思考'：pi 不发送思考参数，由端点自己决定（DeepSeek 默认会思考，但不能控制）。在 设置 → 连接与模型 里编辑这个模型、勾选'支持思考'后可以选。" | 打开菜单看说明；"打开设置" |
| 菜单 | 你点了按钮 | `thinkingLevels` 里的强度，当前的打勾；底部说明"只作用于这个会话；新会话的默认在设置里按模型设定" | ↑ ↓、Enter；Esc |
| 切换中 / 已切换 / 失败 | `session.setThinking` | 同模型 | — |
| 生成中 | 本轮运行中 | 按钮不可用，悬停"生成中不能切换思考强度" | — |
| 重新打开的会话 | pi 按会话记录里最后一条 `thinking_level_change` 恢复 | 显示恢复后的强度 | — |

## 反例

- 模型没标支持思考时，思考强度的选项都不可用（不是只藏起来），并说明原因。
- 顶栏切换模型或思考强度不改设置里的默认（pi 不 persist）；新会话仍用默认模型和它的默认强度。
- 顶栏切到"关"之后，下一次回复没有思考内容（DeepSeek 实测：pi 发 `thinking: disabled`）。

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
