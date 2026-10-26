# 会话面板（M1）

依据：方案 5.1（中栏）、5.4、5.6、5.8。工具卡见 [tool-cards.md](tool-cards.md)。

> v1：见 docs/specs/model-providers.md §9.3：模型层的提示、阶段行、说明卡与拒绝启动卡见 [../../v1/screens/model-chat.md](../../v1/screens/model-chat.md)；下面注明了被取代的行。

## 顶栏

2026-10-21 起顶栏只有会话名（"项目名 › 会话名"）和这一栏的按钮；模型、思考强度（Effort）、权限和上下文用量移到
输入框下面一行（见下"输入框下面一行"，方案第 11 节 2026-10-21 的决定），让分屏时的会话名有地方显示（原来 460px 的一栏里只剩约 2 个字母）。
右边一组从左到右是协作开关（TaskBoard，2026-10-22 合入）、右栏开关、分屏时的"Close pane"。

| 项 | 来源 | 必须可见 |
| --- | --- | --- |
| 会话名 | 会话名（pi 的 `session_info`：`session.create` / `session.open` 返回的 `name`、`session_info_changed`，M3 起）；没有名字时第一条用户消息（pi 的 `message_start`，role=user）前 20 个字；都没有时"New session"。规则与侧栏会话行相同（[sessions.md](sessions.md)），会话面板的读屏名称和 F8 报告里的"Current session"也用它 | 省略号截断，不换行；放不下时先收短项目名（见下表） |
| 项目名 | 会话的工作目录（`session.create` / `session.open` 的返回值）末级文件夹名；悬停显示完整路径 | 最长 160px，省略号截断 |
| 协作开关（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.1） | `SessionInfo.team`、`mori.team_state` | 右边一组的第一个，在右栏开关之前：`Team: Off` / `Team: On` / `Team: Until done`（最宽约 105px）；会话面板 ≤ 600px 时只显示状态点（约 19px），读屏名和悬停仍是完整文字；会话还在打开、后台进程没接上时不可用（不在 Tab 路径上）；见 ../../v1/screens/team-switch.md |
| 右栏开关 | 你的操作 | 图标按钮，按下状态表示右栏是否打开；读屏名"Toggle changes"，悬停"This session’s changes" |
| 关闭这一栏（M5） | 只在分屏时 | 图标按钮 ×，读屏名"Close pane"，悬停"Close pane (doesn’t stop the response)"（[split.md](split.md)） |

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 一般 | 会话面板宽于 600px | "项目名 › 会话名"、完整文字的协作开关、右栏开关，分屏时"Close pane"；会话名放不下时项目名先收短（最窄 40px），之后才截会话名 | 点、右键、拖会话名（M3、M5）；切换协作模式；开关右栏；关闭这一栏 |
| 较窄 | ≤ 600px | 协作开关只显示状态点；其余同上 | 同上 |
| 窄 | ≤ 400px | 顶栏的内边距和间距收小，两个图标按钮 28px 宽；按钮间距只有 4px，键盘焦点环离按钮 1px（全局是 2px，同输入框下面一行 ≤ 460px 的一档） | 同上 |
| 很窄 | ≤ 320px | 不显示项目名和 ›，只有会话名 | 同上 |

会话名能用的宽度（会话名很长、项目名收到 40px、协作开关是最宽的"Team: Until done"；在 App 里量的）：单栏 930px 约 665px；
分屏 601px 约 315px（还是完整文字的开关）；分屏 510px（1280 宽窗口）307px、460px 258px、370px（800 宽窗口）193px、
280px 173px；800 宽窗口右栏打开时中栏 300px 223px（后几种开关只有状态点）。600px 的档位就是按这个定的：
宽于 600px 时完整文字的开关也给会话名留下约 315px，和 1280 宽分屏里只有状态点时（307px）差不多
（[../composer-pickers.md](../composer-pickers.md)"TaskBoard 合入之后"）。改名框（M3）在同一位置，至少 120px。

M6 起的模型菜单（v1 起是选择范围）、思考强度和上下文用量见 [models.md](models.md)；输入框的"/"补全见 [slash.md](slash.md)。

## 对话流

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 空会话 | 新建的会话，还没有消息 | 项目名，以及"Enter to send · Shift+Enter for new line" | 输入 |
| 你的消息（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.7：程序投递的 `[Mori]` 消息不显示为你的消息；§5.3：分开时先显示为待发、立项判断后才交给对话，见 ../../v1/screens/team-stop.md） | pi `message_start`（role=user），含插话和排队消息被送达时 | 右侧气泡，保留换行；带引用时引用显示在气泡上方（M4，见 [selection.md](selection.md)） | 点引用回到原位置 |
| 等待回复 | pi `message_start`（role=assistant）之后还没有任何增量 | 只有阶段行变化，对话流不出现空气泡 | — |
| 思考流入 | `thinking_start` / `thinking_delta` | 思考折叠块，流入时标题"Thinking…"、展开，文字逐段出现；完成后标题"Thought process" | 收起 |
| 正文开始 | 同一条回复出现 `text_start` / `toolcall_start`，或回复结束（`message_end`） | 之前的思考块自动折叠；正文按 Markdown 渲染（代码块高亮、表格、列表；2026-10-26 走查 M16 起 mermaid 代码块画成图，见下面"图"） | 再次展开思考 |
| 正文流入 | `text_delta` | 文字逐段出现，不打断你的输入、选区和滚动位置 | 选中文字（M4 起出"Attach as context / Feedback"浮层，见 selection.md） |
| 一轮结束（M4）（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.7：不显示的 `wake` 条目也结束上一轮；§13.3：进展摘要挂在这一轮的回复操作之上） | 本轮不在生成、这一轮有正文 | 这一轮最后一条助手回复下三个图标按钮："Copy"、"Attach message as context"、"Give feedback"（见 selection.md） | Tab、Enter |
| 工具调用 | `toolcall_*`、`tool_execution_*` | 工具卡，按调用顺序排在这条回复里（见 tool-cards.md） | 展开、收起 |
| 已压缩（v1：见 docs/specs/model-providers.md §6.3 第 1 步：重建时的压缩不转给界面，不显示这一行） | `compaction_end`（有 result 且没有中止）；会话记录里的 compaction 条目 | 一行"Compacted session" | — |
| 已停止（v1：见 docs/specs/model-providers.md §9.3、MP-17：在排队、等模型、等它停下时按停止也显示这一行；准备中按停止撤回消息，§11.4） | `agent_settled` 且 `aborted` 为真，或你按了停止之后本轮结束（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.4：按 `Stop team` 也显示这一行） | 一行"Stopped · Changes made so far stay as they are" | — |
| 你在底部 | 滚动位置离底部不超过 24px | 新内容出现时自动跟到底部 | — |
| 你不在底部、有新内容 | 你上滚后又有内容变化 | 右下方"Jump to latest ↓"，不自动滚动 | 点它回到底部；自己滚到底部它也消失 |
| 更早的消息 | 打开（或重新载入）会话时超过 50 条（一条你的消息或一条助手回复算一条） | 先显示最近 50 条，顶部一行"Scroll up to load earlier messages"；滚到顶部时载入更早的 50 条，当前看到的内容不跳动 | 继续上滚 |

（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.2、§13.3：对话流里另有回执行与进展摘要，见 ../../v1/screens/team-stream.md）

### 图（mermaid，2026-10-26 走查 M16）

回复里语言写 `mermaid` 的代码块画成图。照 Claude 桌面版：代码块还没写完时显示代码，写完才画；画不出来时显示代码，
不另给错误说明。同一个渲染也用在记忆页的 Details、修订的 Notes 和右栏的 Markdown 预览（[changes.md](changes.md)）。
mermaid 在第一次遇到图时才载入（打包在程序里，不联网）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 代码块还在写 | 这段正文正在生成，这个 ```mermaid 代码块还没有结束的 ``` | 普通代码块（高亮、"Copy code"），与其他语言的代码块相同。这段正文还在生成时，其中的代码块（任何语言）"Copy code"都不可用，写完恢复（Streamdown 在生成中的做法，2026-10-26 起 Mori 告诉它哪一段在生成） | 等它写完 |
| 正在画 | 代码块写完了（或回复已经结束、会话从记录里载入）；mermaid 还在载入或在画 | 一个空的框（与图同样的边框，至少 96px 高），读屏名"Mermaid diagram"，`aria-busy="true"` | — |
| 图 | 画好了 | 图（SVG，画在 shadow DOM 里，不受界面样式影响），居中，宽于这一栏时按比例缩小；颜色取界面的 token；读屏名"Mermaid diagram"（Claude 的原词，`role="img"`）。图里的字不能选中引用（同工具卡的 diff） | 回复下的"Copy"复制的仍是 Markdown 原文 |
| 画不出来 | 语法错误、不支持的图、超过上限（2 万字、400 条边），或 mermaid 载入失败 | 普通代码块（高亮、"Copy code"），不显示错误原文；控制台记一条日志 | "Copy code" |
| 停在代码块中间 | 你按了停止或出错，代码块没有结束 | 这段正文不再生成，按写完处理：画得出来就画（只有已经写出来的部分），画不出来显示代码 | — |

## 阶段行

只在本轮运行中显示，全部由 pi 事件推出；本轮结束（`agent_settled`）后隐藏。秒数每秒刷新，从该阶段开始计时。
（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.6：分开时立项判断你的消息、对话还没在运行时显示 `<create role> is deciding… · 4s`，见 ../../v1/screens/team-stop.md）
（v1：见 docs/specs/model-providers.md §9.3：另有模型层的阶段行——等模型、等它停下、排队、重试、重建，由 `mori.model_*` 事件推出，准备中也显示。）

| 文字 | 开始于 | 结束于 |
| --- | --- | --- |
| Waiting for the model… 12s | `turn_start`（每次请求模型，包括工具执行之后再次请求） | 这次回复的第一个增量 |
| Thinking… 5s | `thinking_start` / `thinking_delta` | 出现正文或工具调用增量 |
| Responding… | `text_delta`；`toolcall_start` / `toolcall_delta`（模型在写工具参数） | 回复结束（`message_end`） |
| Run npm test 8s | `tool_execution_start`（文字与工具卡标题相同，见 tool-cards.md） | 该工具的 `tool_execution_end`；同时有别的工具在跑就显示那一个 |
| Waiting for your approval | `mori.tool_gate` 为 `ask` 的 `tool_execution_start`，或批准扩展的 `mori.approval_request`（M2）；有挂起的卡时优先显示它 | 你作出选择（`mori.approval_end`） |
| Retrying (1/3) · <原因>（v1：见 docs/specs/model-providers.md §5.5、§9.3：pi 的自动重试关闭，改为 `mori.model_retry` 的"Retrying (n/m) · HTTP 503"） | `auto_retry_start` | 下一次 `turn_start` 或 `auto_retry_end` |
| Compacting session…（v1：见 docs/specs/model-providers.md §6.3：重建时改为"Rebuilding the conversation for <B>…"） | `compaction_start` | `compaction_end` |
| （不显示） | `message_end` 之后、下一个事件之前；没有运行时 | — |

反例：回复结束到下一个事件之间不显示"Responding…"；没有任何增量时不显示"Responding…"。

## 排队区与输入框

对话流下面的输入区从上到下：后台进程的横幅（见"后台进程退出"）、阶段行、批准卡（M2）或扩展的询问卡（M3）、排队区、输入框。
输入框里从上到下：引用芯片（M4）、文字框、文字框下面一行。批准卡、询问卡和"/"列表（M6）都在输入框上方；
这一行的菜单往上打开时盖在它们上面，不挤动它们（[models.md](models.md)"菜单的位置与键盘"）。

### 输入框下面一行

照装在本机的 Claude 桌面版 prompt box 下面那一行（2026-10-21 起；原来这一行只有发送和停止）：左边模式选择，
右边一组是模型、单独的 Effort、用量圆环，再往右是发送（这个顺序是负责人定的）。从左到右：

| 项 | 来源 | 必须可见 |
| --- | --- | --- |
| 权限（M2） | 后台进程批准扩展的设置（`session.create` / `session.open` 返回值里的 `approval`，以及 `approval.*` 命令的结果） | 在左端；只有文字（照 Claude 的模式选择，没有图标）："Ask each time ▾"或"Allow all ▾"（警示色）；窄时模式名截断，全名在悬停说明和读屏名里；菜单见 [approval.md](approval.md) |
| 选择范围（v1） | `ModelState`（`pick`、`current`）、`session.pickOptions` | 右边一组的第一项；"<范围名> · <当前模型 id>"（范围是模型时只有 id，没有范围时"No model range"）；不能启动时的说明在输入框上方的拒绝启动卡里（[../../v1/screens/model-chat.md](../../v1/screens/model-chat.md)）；见 [models.md](models.md)（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11：`pickLocked` 为真时只显示正在用的模型、不能打开菜单，悬停 `Team mode picks the model for each agent`，见 ../../v1/screens/team-blocked.md） |
| 思考强度（M6） | 见 [models.md](models.md) | 紧挨在选择范围右边；"Effort: High ▾"；当前模型没标支持思考时"Effort: Unavailable ▾"；没有当前模型时不显示 |
| 上下文用量 | `session.state` → pi `getContextUsage()`；在打开会话、`turn_end`、`compaction_end`、`agent_settled` 后刷新 | Effort 右边的小圆环，点开看详情；各状态的悬停说明和读屏名见 [models.md](models.md)"上下文用量（圆环）" |
| 发送、停止、排队 | 下表 | 在右端，同一位置；会话面板 ≤ 600px 时只显示图标（[models.md](models.md)"窄栏"）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.4、§13.6：`Stop team` 是这一行的又一项，在"Stop"或"Send"前面，会话面板 ≤ 760px 时就只显示图标，读屏名"Stop team"；会话面板 ≤ 340px 时有它就收起排队的按钮，见 [models.md](models.md)"窄栏""最窄"） |

这一行不换行，任何宽度都不超出输入框，圆环任何宽度都在；变窄时先去掉"Effort: "前缀、发送按钮的文字、▾，再收起"Queue"，
最后依次截短不能发送时的说明、选择范围按钮（先截模型 id，再截范围名）、模式名和 Effort 的强度，见 [models.md](models.md)"窄栏"。
各项都是这一行的直接子项（不包成组），高度至少 33px（不能发送、只有权限按钮和说明时也不变矮）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 后台正在启动 | 会话第一次打开、还没打开好，或后台进程通道还没连上 | 输入框可以打字；按钮位置显示"Starting…"，不能发送；这一行只有权限按钮（不可用），没有范围按钮、Effort 和圆环 | 输入 |
| 打开失败 | `session.create` / `session.open` 报错（`phase` 为 failed，见 [sessions.md](sessions.md)） | 横幅"Failed to open session: …"；按钮位置"Session didn’t open"；这一行只有权限按钮（不可用），没有范围按钮、Effort 和圆环 | 输入（草稿保留） |
| 空闲 | 没有运行（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.6：只有后台 Agent 在运行时对话仍算空闲，输入框照常可以发送，旁边有 `Stop team`） | "Send"按钮（输入为空时不可用）；权限、范围按钮、Effort、圆环可用 | Enter 发送；Shift+Enter 换行；输入法组字时 Enter 只选词 |
| 准备中（v1） | 你发了消息（`session.prompt`），pi 还没开始运行（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.3：分开时准备中先等立项判断这条消息，见 ../../v1/screens/team-stop.md） | 同一位置显示"Stop"（v1：准备中可以停止，消息撤回、文字回到输入框，[model-chat.md](../../v1/screens/model-chat.md)"准备中"）；输入框有字时左边是只有一个按钮的"Queue"（准备中不能插话；≤ 400px 也不收起）；占位文字"Enter to queue · Shift+Enter for new line"；范围按钮和 Effort 不可用（`aria-disabled`，仍能 Tab 到，原因见 models.md），权限和圆环可用；开着的范围、Effort 菜单关闭 | "Stop"或 Esc；Enter 排队（Ctrl+Enter 也是排队） |
| 生成中、输入框为空 | 本轮运行中（`agent_start` 到 `agent_settled`） | 同一位置显示"Stop"（悬停"Stop response (Esc)"；协作模式：见 docs/specs/parallel-agents-taskboard.md §11.4、§13.6：后台有 Agent 在运行或排队时旁边另有 `Stop team`）；范围按钮和 Effort 不可用（悬停和读屏的描述说明原因），权限和圆环可用 | 点"Stop"或按 Esc |
| 生成中、输入框有字 | 同上 | "Stop"和"Queue ▾"（"Queue"悬停"Queue for later (Enter)"），下拉"More send options"里有"Steer"（快捷键提示 Ctrl+Enter）；输入框的占位文字"Enter to queue · Ctrl+Enter to steer · Shift+Enter for new line"；会话面板 ≤ 400px 时"Queue"收起，只留 ▾，菜单里是"Queue for later"和"Steer"，"Stop"不动（协作模式下有 `Stop team` 时 ≤ 520px 就收起"Queue"，≤ 340px 连 ▾ 也收起，见 models.md"窄栏"） | Enter 排队（Queue）；Ctrl+Enter 插话（Steer）；"Stop" |
| 拒绝启动（v1） | `ModelState.blocked` 不为 null | 输入框上方是拒绝启动卡；可以打字，"Send"不可用（Enter 不发送，草稿不丢）；范围按钮可用（卡上的"Change model…"打开它的菜单）；没有当前模型时没有 Effort | 打字；改范围；卡上的操作 |
| 有排队或插话的消息（v1：见 docs/specs/model-providers.md §11.4：准备中再发的消息由后台进程暂存，pi 开始后作为 followUp 交给 pi） | pi `queue_update`（`followUp` 与 `steering` 两个列表）（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.3：排队区还有待判断的消息，标 `Waiting for <create role>`；"Withdraw"同时撤回还没开始判断的，正在判断的那条不撤回） | 输入框上方排队区，逐条显示"Queued"或"Steer"和内容 | "Withdraw"：把排队区里的消息全部放回输入框（`clearQueue`） |
| 插话送达 | pi 在本轮工具全部执行完、下一次请求模型之前送出（`message_start` role=user，同时 `queue_update` 去掉它） | 排队区少一条，对话流出现这条消息 | — |
| 排队送达 | 本轮结束后 pi 依次送出 | 同上 | — |

停止（按钮或 Esc）的顺序：先 `clearQueue`，把排队消息放回输入框（放在已有草稿之前），再 `abort`。
（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.4：Esc 与停止只停对话这一回合和为它判断的立项，待判断的消息一起回到输入框，后台照常；`Stop team` 停这个会话的全部 Agent，见 ../../v1/screens/team-stop.md）
M2 起，有挂起的批准卡时，后台进程在 `abort` 里先把它按拒绝处理（工具卡"Denied · You pressed Stop"），等 pi 记下拒绝后再停止。

Esc 的顺序：先关闭最上层的浮层、菜单或对话框（"Queue"的下拉、输入框下面一行的权限菜单、范围菜单、Effort 菜单和
上下文用量的详情、切到"Allow all"的确认框、F8 报告框；
M3 起还有会话的右键菜单、改名框、删除确认框、信任询问，见 [sessions.md](sessions.md)；M4 起还有选区浮层和反馈表单，
见 [selection.md](selection.md)。选区浮层和上下文用量的详情不挡 Alt+数字和 Ctrl+N；焦点在圆环上时圆环的悬停提示也在这里，
Esc 先藏起它，只因鼠标停在圆环上显示的提示不算，见 [models.md](models.md)"上下文用量（圆环）"）；
焦点在批准卡上时只拒绝这张卡（见 approval.md）；没有浮层、当前显示的是会话面板且正在生成时才停止。
M5 起分屏时 Esc、Alt+数字、F8 都以焦点所在的一栏为准，见 [split.md](split.md)。

## 错误

都显示原文。按原文决定附带的操作：原文里有 `401`、`unauthorized` 或 `api key`（不区分大小写）时附"Go to settings"
（这条文字匹配是临时默认值，登记在 defaults.md），其他错误附"Put your last message back in the message box"。

> v1：见 docs/specs/model-providers.md §9.3："Go to settings"和 `SETTINGS_HINT` 删除，认证类错误由模型层换 key、换模型或给出"No model available"说明卡；一次失败只显示一张卡；`server` 重试用完、`request`、`partial` 仍是这里的错误卡。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 发送时就失败（v1：见 docs/specs/model-providers.md §4.6、§5.8、§11.4：拒绝启动与段开始时等不到模型时撤回消息、文字放回输入框） | `session.prompt` 里 pi 的 `prompt()` 抛错（例如 "No API key found for mori-endpoint"、"No model selected"），后台进程转成 `mori.prompt_error` | 错误卡：原文 | "Go to settings" / "Put your last message back in the message box"（放回的是刚才发出的那条）（v1：见 docs/specs/model-providers.md §9.3："Go to settings"删除） |
| 模型回复出错（v1：见 docs/specs/model-providers.md §5.4、§9.3：能换 key 或换模型的失败不出错误卡；发了 `mori.model_unavailable` 的不出错误卡） | `message_end` 的 `stopReason` 为 `error`，且 `agent_end.willRetry` 为假、没有在重试 | 错误卡：`errorMessage` 原文 | 同上（放回最后一条你的消息） |
| 自动重试最终失败（v1：见 docs/specs/model-providers.md §5.5：pi 的自动重试关闭，不再出现；5xx 重试用完走"模型回复出错"） | `auto_retry_end` 且 `success` 为假（你按停止导致的"Retry cancelled"不算） | 错误卡：`finalError` 原文 | 同上 |
| 压缩失败（v1：见 docs/specs/model-providers.md §6.3：重建时的压缩失败不出这张卡；§5.8：压缩时没有可用模型时原文为"No model available for compaction: …"） | `compaction_end` 带 `errorMessage` | 错误卡：原文 | "Put your last message back in the message box" |

## 后台进程退出

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 意外退出 | 主进程收到后台进程 `exit`（非有意关闭） | 每个打开的会话：横幅"Mori’s background process crashed · Unfinished responses were interrupted"和"Restart"；执行中的工具卡变为"Interrupted"；阶段行消失；输入框可以打字但不能发送（按钮位置显示"Mori’s background process crashed"，放不下时截断、悬停看全文）；输入框下面一行的权限、范围按钮、Effort 按钮不可用（权限、Effort 悬停的第二行，范围按钮悬停的第三行，和读屏的描述也是"Mori’s background process crashed"；范围按钮的描述前面还有提供商名；2026-10-26 改，负责人走查 M3：原来是"提供商和区域"，网络区域删掉），开着的菜单关闭（圆环详情不关），圆环保留最后一次的用量；草稿保留 | "Restart" |
| 重新载入中 | 你点了"Restart"；主进程重启后台进程并重连通道 | "Restarting…"（横幅和按钮位置）；输入框下面一行同"意外退出" | — |
| Restart 之后重新打开中 | 后台进程连上后每个会话重新 `session.open`（`phase` 又变成 opening） | 按钮位置"Starting…"；输入框下面一行仍显示上一次的范围按钮、Effort（不可用）和圆环（最后一次的用量），不像第一次打开那样藏起；焦点在这一行时留在原来的按钮上 | — |
| 已重新载入 | 每个会话用 `session.open`（会话文件）重新打开，对话流按 pi 记录的当前分支重画 | 一行"Restarted · Queued messages, pending approvals, and “Allow for this session” choices weren’t restored"；草稿仍在 | 继续对话 |
| 会话还没保存过 | 这个会话没有你的消息（本次运行里没发过，会话列表里也没有它的第一条消息），且会话文件不存在（M3 起；保存过的会话文件不在时显示"Failed to open session: …"，不换成空会话） | 在同一文件夹新建会话，一行"Restarted · This session had no messages yet and was reopened" | 继续 |
| 重新载入失败 | 后台进程再次启动失败或 `session.open` 报错 | 错误原文和"Restart" | 再试 |
