# 会话面板（M1）

依据：方案 5.1（中栏）、5.4、5.6、5.8。工具卡见 [tool-cards.md](tool-cards.md)。

## 顶栏

| 项 | 来源 | 必须可见 |
| --- | --- | --- |
| 会话名 | 会话名（pi 的 `session_info`：`session.create` / `session.open` 返回的 `name`、`session_info_changed`，M3 起）；没有名字时第一条用户消息（pi 的 `message_start`，role=user）前 20 个字；都没有时"新会话"。规则与侧栏会话行相同（[sessions.md](sessions.md)），会话面板的读屏名称和 F8 报告里的"当前会话"也用它 | 省略号截断，不换行 |
| 项目名 | 会话的工作目录（`session.create` / `session.open` 的返回值）末级文件夹名 | 同上 |
| 模型 | 会话返回值里的 `model`（provider/id），显示 id | 没有可用模型时"没有可用模型"，并显示 pi 给出的说明 |
| 上下文用量 | `session.state` → pi `getContextUsage()`；在打开会话、`turn_end`、`compaction_end`、`agent_settled` 后刷新 | "上下文 12%"，悬停显示"约 15,360 / 128,000 token"；pi 返回未知（刚压缩完）时"上下文 —"并说明要等下一次回复 |
| 权限（M2） | 后台进程批准扩展的设置（`session.create` / `session.open` 返回值里的 `approval`，以及 `approval.*` 命令的结果） | "每次询问"或"全部允许"（警示色）；菜单见 [approval.md](approval.md) |
| 右栏开关 | 你的操作 | 按钮，显示右栏是否打开 |

思考强度在 M6。

## 对话流

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 空会话 | 新建的会话，还没有消息 | 项目名，以及"Enter 发送 · Shift+Enter 换行" | 输入 |
| 你的消息 | pi `message_start`（role=user），含插话和排队消息被送达时 | 右侧气泡，保留换行 | 选中文字 |
| 等待回复 | pi `message_start`（role=assistant）之后还没有任何增量 | 只有阶段行变化，对话流不出现空气泡 | — |
| 思考流入 | `thinking_start` / `thinking_delta` | "思考"折叠块，流入时展开，文字逐段出现 | 收起 |
| 正文开始 | 同一条回复出现 `text_start` / `toolcall_start`，或回复结束（`message_end`） | 之前的思考块自动折叠；正文按 Markdown 渲染（代码块高亮、表格、列表） | 再次展开思考 |
| 正文流入 | `text_delta` | 文字逐段出现，不打断你的输入、选区和滚动位置 | 选中文字 |
| 工具调用 | `toolcall_*`、`tool_execution_*` | 工具卡，按调用顺序排在这条回复里（见 tool-cards.md） | 展开、收起 |
| 已压缩 | `compaction_end`（有 result 且没有中止）；会话记录里的 compaction 条目 | 一行"已压缩较早的对话" | — |
| 已停止 | `agent_settled` 且 `aborted` 为真，或你按了停止之后本轮结束 | 一行"已停止 · 已经做出的修改不会自动撤销" | — |
| 你在底部 | 滚动位置离底部不超过 24px | 新内容出现时自动跟到底部 | — |
| 你不在底部、有新内容 | 你上滚后又有内容变化 | 右下方"有新内容 ↓"，不自动滚动 | 点它回到底部；自己滚到底部它也消失 |
| 更早的消息 | 打开（或重新载入）会话时超过 50 条（一条你的消息或一条助手回复算一条） | 先显示最近 50 条；滚到顶部时载入更早的 50 条，当前看到的内容不跳动 | 继续上滚 |

## 阶段行

只在本轮运行中显示，全部由 pi 事件推出；本轮结束（`agent_settled`）后隐藏。秒数每秒刷新，从该阶段开始计时。

| 文字 | 开始于 | 结束于 |
| --- | --- | --- |
| 等待模型响应 12s | `turn_start`（每次请求模型，包括工具执行之后再次请求） | 这次回复的第一个增量 |
| 思考中 5s | `thinking_start` / `thinking_delta` | 出现正文或工具调用增量 |
| 生成中 | `text_delta`；`toolcall_start` / `toolcall_delta`（模型在写工具参数） | 回复结束（`message_end`） |
| 运行 npm test 8s | `tool_execution_start`（文字与工具卡标题相同，见 tool-cards.md） | 该工具的 `tool_execution_end`；同时有别的工具在跑就显示那一个 |
| 等你批准 | `mori.tool_gate` 为 `ask` 的 `tool_execution_start`，或批准扩展的 `mori.approval_request`（M2）；有挂起的卡时优先显示它 | 你作出选择（`mori.approval_end`） |
| 重试 1/3 · 原因 | `auto_retry_start` | 下一次 `turn_start` 或 `auto_retry_end` |
| 正在压缩较早的对话 | `compaction_start` | `compaction_end` |
| （不显示） | `message_end` 之后、下一个事件之前；没有运行时 | — |

反例：回复结束到下一个事件之间不显示"生成中"；没有任何增量时不显示"生成中"。

## 排队区与输入框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 后台正在启动 | 会话还没打开、后台进程通道还没连上 | 输入框可以打字；按钮位置显示"正在启动…"，不能发送 | 输入 |
| 空闲 | 没有运行 | "发送"按钮（输入为空时不可用） | Enter 发送；Shift+Enter 换行；输入法组字时 Enter 只选词 |
| 生成中、输入框为空 | 本轮运行中（`agent_start` 到 `agent_settled`） | 同一位置显示"停止" | 点停止或按 Esc |
| 生成中、输入框有字 | 同上 | "停止"和"排队发送 ▾"，下拉里有"插话（Ctrl+Enter）" | Enter 排队；Ctrl+Enter 插话；停止 |
| 有排队或插话的消息 | pi `queue_update`（`followUp` 与 `steering` 两个列表） | 输入框上方排队区，逐条显示"排队"或"插话"和内容 | "撤回"：把排队区里的消息全部放回输入框（`clearQueue`） |
| 插话送达 | pi 在本轮工具全部执行完、下一次请求模型之前送出（`message_start` role=user，同时 `queue_update` 去掉它） | 排队区少一条，对话流出现这条消息 | — |
| 排队送达 | 本轮结束后 pi 依次送出 | 同上 | — |

停止（按钮或 Esc）的顺序：先 `clearQueue`，把排队消息放回输入框（放在已有草稿之前），再 `abort`。
M2 起，有挂起的批准卡时，后台进程在 `abort` 里先把它按拒绝处理（工具卡"已拒绝 · 你按了停止"），等 pi 记下拒绝后再停止。

Esc 的顺序：先关闭最上层的浮层、菜单或对话框（"排队发送"的下拉、权限菜单、切到"全部允许"的确认框、F8 报告框；
M3 起还有会话的右键菜单、改名框、删除确认框、信任询问，见 [sessions.md](sessions.md)）；
焦点在批准卡上时只拒绝这张卡（见 approval.md）；没有浮层、当前显示的是会话面板且正在生成时才停止。

## 错误

都显示原文。按原文决定附带的操作：原文里有 `401`、`unauthorized` 或 `api key`（不区分大小写）时附"去设置"
（这条文字匹配是临时默认值，登记在 defaults.md），其他错误附"把上一条消息放回输入框"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 发送时就失败 | `session.prompt` 里 pi 的 `prompt()` 抛错（例如 "No API key found for mori-endpoint"、"No model selected"），后台进程转成 `mori.prompt_error` | 错误卡：原文 | 去设置 / 把上一条消息放回输入框（放回的是刚才发出的那条） |
| 模型回复出错 | `message_end` 的 `stopReason` 为 `error`，且 `agent_end.willRetry` 为假、没有在重试 | 错误卡：`errorMessage` 原文 | 同上（放回最后一条你的消息） |
| 自动重试最终失败 | `auto_retry_end` 且 `success` 为假（你按停止导致的"Retry cancelled"不算） | 错误卡：`finalError` 原文 | 同上 |
| 压缩失败 | `compaction_end` 带 `errorMessage` | 错误卡：原文 | 把上一条消息放回输入框 |

## 后台进程退出

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 意外退出 | 主进程收到后台进程 `exit`（非有意关闭） | 每个打开的会话：横幅"Mori 的后台进程意外退出 · 刚才没完成的回复已中断"和"重新载入"；执行中的工具卡变为"已中断"；阶段行消失；输入框可以打字但不能发送；草稿保留 | 重新载入 |
| 重新载入中 | 你点了"重新载入"；主进程重启后台进程并重连通道 | "正在重新载入…" | — |
| 已重新载入 | 每个会话用 `session.open`（会话文件）重新打开，对话流按 pi 记录的当前分支重画 | 一行"已重新载入 · 排队消息、批准卡和'本会话已允许'不会恢复"；草稿仍在 | 继续对话 |
| 会话还没保存过 | 这个会话没有你的消息（本次运行里没发过，会话列表里也没有它的第一条消息），且会话文件不存在（M3 起；保存过的会话文件不在时显示"打开失败"，不换成空会话） | 在同一文件夹新建会话，一行"已重新载入 · 这个会话还没有消息，已重新打开" | 继续 |
| 重新载入失败 | 后台进程再次启动失败或 `session.open` 报错 | 错误原文和"重新载入" | 再试 |
