# 右栏的 Background tasks：Running / Finished、task 的视图、实例的会话、停止一个 task

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§13.13（2026-10-26 加，负责人走查 M14），
以及它引用的 §6.1（TaskBoard 的数据）、§9.2（写入锁）、§9.4（停止后的程序动作）、§10.2（读会话的边界）、§11.4（停止）、§11.6（重新载入与重启）、
§13.3（进展摘要的文字）、§13.10（进程桥）、§13.12（右栏）、§14.5（会话文件）。
补充 [v0 changes.md](../../v0/screens/changes.md) 的右栏、[team-stream.md](team-stream.md) 的进展摘要、[team-stop.md](team-stop.md) 的停止、
[v0 chat.md](../../v0/screens/chat.md) 的阶段行、[model-menu.md](model-menu.md) 的模型菜单。
照 Claude 桌面版右栏的 Background tasks 与 Agent 两栏；Claude 有原句的地方用原句（[v0/ui-strings.md](../../v0/ui-strings.md) 术语表注明出处）。
负责人 2026-10-26 定：照 Claude 分 Running / Finished；四个入口都要；加单个 task 的停止；能打开 task 实例与结案的会话。
标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.board` 事件、`SessionInfo.board`、`LiveSnapshot.board`、`board.get` 的结果 | `BoardView`：每个需求的 `RequestView`（含 2026-10-26 加的 `closeSession`），每个 task 的 `TaskView`（含 `createdAt`、`closedAt`、`dependsOn`、`sessionRoles`）；两节、卡片、阶段行按钮的计数、停止按钮的有无 |
| `TeamState.mode`、`TeamState.holders` | 页签与模型菜单那一项出现的条件（模式不是 `off`）；`<close role>`；基座（`mori`）显示为 `Mori` |
| `board.readTask { sessionId, task }` 的结果 | `TaskDetail`（规格 §13.13.3）：说明全文、依赖与它们的状态、留给 task 的消息、每一棒的全部字段；`error` |
| `board.readSession { sessionId, of }` 的结果 | `entries`（这条实例会话的当前分支，pi 的 `SessionEntry`）、`running`；`error` |
| `session.stopTask { sessionId, task }` 的结果 | `error`（`T1 isn't running.` 等）；成功后的状态来自之后的 `mori.board` |
| 对话流的条目（`history.ts` 的 `transcriptFromEntries`） | 把 `entries` 画成对话流的条目：投递、助手正文、思考、工具卡、换模型的一行 |
| 界面的时钟 | 时长每秒更新；重新读的间隔（最多每秒一次） |
| 你的操作 | 点页签、阶段行按钮、进展摘要的链接、模型菜单那一项、卡片、`View transcript`、`Stop this task`、`Back`、`Retry` |

## 入口（规格 §13.13.1）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 会话没有需求、协作模式 `off` | `BoardView.requests` 为空，`TeamState.mode` 为 `off` | 右栏与现在完全相同：顶部 “This session’s changes”，没有页签；阶段行没有按钮；模型菜单里没有 `See background tasks`（TB-03） | — |
| 有需求，或协作模式打开 | `BoardView.requests` 不为空，或 `mode` 不是 `off` | 右栏顶部两个页签 `Changes`、`Background tasks`（`role="tablist"`，选中的 `aria-selected="true"`），这一行右端 `Expand` / `Collapse` 与 `Close panel`（v0 layout.md“右栏展开”），在列表、task 的视图、会话里都在顶部；“This session’s changes” 这一行不再显示，`Changes` 页签下的内容与现在相同，文件阅读器自己那一行只留 `← Changes` 与路径；模型菜单协作模式那一段的最后一项 `See background tasks` | 点页签切换（按会话记住，不跨重新打开；展开状态不变）；点菜单那一项：关上菜单，打开右栏到 `Background tasks`（回复进行中能打开菜单时同样可用） |
| TaskBoard 上有 task | `BoardView` 里有 `TaskView` | 阶段行右端一个按钮：有 `pending`、`active`、`waiting_user` 的 task 时 `1 running task` / `{n} running tasks`（n 是这几种的个数），否则 `1 task finished` / `{n} tasks finished`（n 是全部 task 数，含 `stopped`）；悬停 `Show this session’s background tasks`；对话在不在回复都显示，阶段文字在它左边 | 点它：右栏关着或在 `Changes` 时打开到 `Background tasks`（停在上次看的那一层）；已经在 `Background tasks` 时关上右栏 |
| 右栏开着且在 `Background tasks` | 你的操作 | 阶段行按钮 `aria-pressed="true"` | 同上 |
| 进展摘要（team-stream.md） | `mori.progress` 与 `BoardView` | 每个 task 行是按钮，悬停与读屏名 `Open T1 <title> in Background tasks`；标题行右端一个图标按钮，悬停与读屏名 `Open Request 1 in Background tasks`；标题行本身仍是展开、折叠 | 点 task 行：打开右栏到这个 task 的视图；点图标按钮：打开右栏到列表，滚到这个需求的第一个 task，这个需求的卡片短暂高亮（同引用跳转的高亮） |
| 窄窗口、分屏放不下 | 右栏现有规则 | 打开时右栏浮在上层（同右栏开关） | 同上 |

## 列表（规格 §13.13.2）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 还没有 task | `TaskView` 一个都没有（有需求还没拆、或协作模式刚打开） | `Background tasks appear here`（Claude 原句） | — |
| 有没结束的 task | `status` 为 `pending`、`active`、`waiting_user` | 一节 `Running`，这些 task 按编号从小到大 | — |
| 有结束或停下的 task | `status` 为 `done`、`failed`、`cancelled`、`stopped` | 一节 `Finished`，按编号从大到小（临时，走查时可以改）；节头可以折叠（`aria-expanded`，默认展开，不跨重新打开）；这一节的卡片文字用次要色 | 点节头折叠、展开 |
| 一节没有 task | — | 不显示这一节 | — |
| task 卡 | `TaskView` | 第一行 `T1 <title>`；第二行 `Request 1 · <role> · <当前在做什么> · <时长>`：`<role>` 为 `holder`，为空时为 `assignee`；当前在做什么与进展摘要这个 task 那一行相同（team-stream.md 的 phase 文字与标题规则，`modelNote` 接在后面）；时长从 `createdAt` 到现在或 `closedAt`；悬停 `Request 1` 一段显示需求标题 | 点卡片或 Enter、空格：打开 task 的视图 |
| task 有依赖 | `TaskView.dependsOn` | 第三行 `Depends on T1, T2` | — |
| task 有实例会话 | `sessionRoles` | 第三行每个角色一个 `View transcript`：一个角色时就写 `View transcript`，多个时 `View transcript (<role>)`；读屏名 `View transcript for <role> on T1` | 打开那条会话 |
| task 可以停止 | `status` 为 `active`、`holder` 是角色，`phase` 为 `starting`、`running`、`approval`、`queued`、`lock_wait` | 卡片右上角停止图标按钮，悬停与读屏名 `Stop this task`（Claude 原句） | 停止（下面“停止一个 task”） |
| 交回的 task | `stopped` 变为 `active` | 卡片回到 `Running` | — |
| 实时更新 | `mori.board` | 两节与卡片随事件更新；时长每秒更新 | — |

需求的结论、已排除的方案、需求级问题不在列表里（Claude 的两节没有需求这一层；负责人选了这种做法）：它们在进展摘要展开后与对话 Agent 的汇报里，
结案会话从 task 的视图打开。

## task 的视图（规格 §13.13.3）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开、读取中 | `board.readTask` 还没返回 | 顶部 `Back`；标题与第二行先用 `TaskView` 显示；下面 `Loading…` | `Back` |
| 读到了 | `TaskDetail` | `Back`；`T1 <title>`（只读的 task 后面 `· Read-only`）；第二行同卡片；再一行 `Request 1 · <request title>`；`sessionRoles` 每个角色一个 `View transcript`；`Prompt` 与说明全文（Markdown） | `Back` 回到列表（滚动位置不变）；`View transcript` |
| 结案会话已建立 | `RequestView.closeSession` | `View transcript (closing)`（读屏名 `View transcript for <close role> on Request 1`） | 打开结案会话 |
| 可以停止 | 同列表 | 标题右边 `Stop this task` | 停止 |
| 有依赖 | `dependsOn` | `Depends on`，每个依赖一行 `T2 <title> · <状态>`（状态同卡片的当前在做什么，已结束时为 `Done` / `Failed` / `Cancelled`） | 点一行：打开那个 task 的视图（`Back` 仍回到列表） |
| 有留给 task 的消息 | `messages` | `Messages`，按时间，每条一行 `<from> · hh:mm`，下面是全文按 Markdown（表格照常；WP-13 合入后 mermaid 同对话流）；`<from>` 是角色名（基座 `Mori`） | — |
| 有交接 | `handoffs` | `Handoffs`，按先后，每一棒：头一行 `#<n> <role> · <结果> → <去向>`（下表）；结论全文（Markdown）；有时 `Open items` 每条一行、`Evidence` 每条一行 `✓ #3 Run npm test` / `✗ #4 …`、`Suggested next: <role>`；有会话位置时、或结案会话写的一棒 `View transcript`（结案的交接不记会话位置） | `View transcript`：打开这个角色在这个 task 上的会话；结案写的一棒打开结案会话 |
| 程序写的一棒 | `outcome` 为 null，`role` 为 `mori` | 头一行的结果写 `PROGRAM_HANDOFF_LINES` 的文字：`#2 Mori · no handoff → <close role> (closing)` | — |
| task 在运行 | 这个 task 的 `TaskView` 在 `mori.board` 里变了 | 重新读 `board.readTask`，最多每秒一次；第二行随 `mori.board` 实时更新 | — |
| 读不到 | `error` | `Couldn’t load T1: <原文>` | `Retry`、`Back` |

**交接的结果与去向**（规格 §15，临时，走查时可以改）：

| `outcome` | 文字 | `routedTo` | 文字 |
| --- | --- | --- | --- |
| `continue` | `Continue` | `{ kind: 'role', role }` | `→ <role>` |
| `dead_end` | `Dead end` | `{ kind: 'close' }` | `→ <close role> (closing)` |
| `blocked` | `Blocked` | `{ kind: 'create' }` | `→ <create role> (planning)` |
| `need_user` | `Needs your decision` | `{ kind: 'end', status: 'done' }` | `→ Done` |
| `done` / `pass` / `fail` | `Done` / `Pass` / `Fail` | `{ kind: 'end', status: 'failed' }` | `→ Failed` |
| `close_done` / `close_failed` | `Closed as done` / `Closed as failed` | | |

## 实例的会话（规格 §13.13.4）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `board.readSession` 还没返回 | 顶部 `Back`；标题 `<role> · T1 <title>`，结案会话 `<close role> · Request 1 (closing)`；下面 `Loading…` | `Back` |
| 还没有条目 | `entries` 里没有消息 | `No activity yet`（Claude 原句） | `Back` |
| 读到了 | `entries` | 第一行 `Model <provider>/<model>`（最后一条助手消息的 `provider`、`model`）；然后照对话流画：投递（`[Mori] …`）是用户一侧的气泡，助手正文按 Markdown，思考折叠为 `Thought process`，工具卡照 v0（展开看 Input / Output，证据编号 `[#n]` 在输出原文里），换模型的一行照 model-chat.md；一轮结束后的步骤折叠同对话流（WP-14 合入后） | 展开工具卡、思考；复制代码；`Back` |
| 实例在运行 | `running` 为真 | 还没有结果的工具调用显示 `Running…`（不是 `Interrupted`）；最后一行是这个 task 卡片的当前在做什么；这个 task 的 `TaskView` 变了时重新读，最多每秒一次，读到新内容时你在底部就跟随 | 同上 |
| 运行结束 | `running` 变为假 | 停在最后的样子，不再重新读 | 同上 |
| 读不出 | `error` | `Failed to read session transcript`（Claude 原句），下一行原文 | `Retry`、`Back` |

这里没有：输入框、回复下的操作（复制整条、引用、反馈）、批准卡、选区浮层（不能把这里的文字作为引用）、拖到输入框。

## 停止一个 task（规格 §13.13.7）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可以停止 | 见列表“task 可以停止” | 卡片与 task 视图的 `Stop this task` | 点它（不确认，Claude 也不确认） |
| 停止中 | 你点了，`mori.board` 里这个 task 还可以停 | 按钮不可用 | — |
| 停下了 | `mori.board`：`status` 为 `stopped`（`stopReason: 'user'`） | 卡片移到 `Finished`，当前在做什么为 `Stopped`；进展摘要这一行同样 `Stopped`；它挂起的批准卡消失；输入框旁的停止全部 Agent 按别的 Agent 是否还在运行显示（team-stop.md） | 打开 task 的视图、会话 |
| 停不了 | `session.stopTask` 的 `error` | 卡片下面一行 `Couldn’t stop T1: <原文>`（例如交接正好在停止之前写入：`T1 isn't running.`） | — |
| 写 task 停下后 | 写入锁仍归它（§9.2） | 等锁的另一个写 task 显示 `Waiting to change files (T1, stopped)` | — |
| 交回 | 你的下一条消息，立项 `task_edit` | 卡片回到 `Running`，继续原来那个角色的会话 | — |

## 协作模式关闭、重新打开、重启、删除（规格 §13.13.5）

| 状态 | 来源 | 必须可见 |
| --- | --- | --- |
| 协作模式关掉之后 | `mode` 为 `off`，`requests` 不为空 | 页签、阶段行按钮、模型菜单那一项、列表照常；task 的视图与会话照常能打开；停止照常（还在运行的 task） |
| 重新打开会话、界面重新载入 | `SessionInfo.board` / `LiveSnapshot.board`；两个只读命令 | 与之前相同；右栏回到 `Changes`（右栏的视图不跨重新打开） |
| App 重启之后 | `board.json`；会话从文件读 | 非终态的 task 显示 `Stopped (Mori restarted)`（§11.6），在 `Finished`；会话照常能打开 |
| 删除会话 | 主进程删除 `teams/<id>`（§11.5） | 这一栏随会话没有了 |

## 反例

- 这一栏里没有改派、留消息、批准的按钮；停止全部 Agent 仍在输入框旁（§11.4）；没有 Claude 的 `Clear finished tasks`。
- 打开 task 的视图或会话之后，`board.json` 与会话文件不变，端点没有新的请求，没有任何投递。
- 停止一个 task 不写回执、不投递消息、不改模式，不影响别的 task 和对话的回复；不会自己再开始。
- 不列分开时的立项会话、临时提问、订阅的会话；`board.readSession` 的 `of` 只有 `task`、`close`。
- 没有需求、协作模式 `off` 的会话里看不到页签、阶段行按钮和模型菜单那一项（与 v0 相同）。
- 没有 `/tasks`。
- 卡片里的需求和 task 标题就是 `BoardView` 里的标题（立项写的），消息、结论是原文，不由模型另外总结。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：`Finished` 按编号从大到小；依赖一行的状态文字；读取中的 `Loading…`；
会话读到新内容时在底部就跟随；重新打开后右栏回到 `Changes`；停止中按钮不可用；进展摘要标题行的链接用引用跳转的高亮；
有页签时 `Expand` / `Collapse`、`Close panel` 只在页签那一行（文件阅读器那一行不重复，WP-13 合入后加）。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 页签 | `[data-testid="right-tab"]`，`data-tab`（`changes` / `tasks`），`aria-selected` |
| 阶段行按钮 | `[data-testid="tasks-button"]`，`aria-pressed` |
| 模型菜单那一项 | `[data-action="see-background-tasks"]` |
| 列表、两节 | `[data-testid="bg-tasks"]`；`[data-testid="bg-section"]`，`data-section`（`running` / `finished`），`Finished` 的节头 `aria-expanded` |
| task 卡 | `[data-testid="bg-task"]`，`data-task`、`data-phase` |
| task 的视图 | `[data-testid="bg-task-view"]`，`data-task` |
| 消息、交接 | `[data-testid="bg-message"]`；`[data-testid="bg-handoff"]`，`data-n` |
| 实例的会话 | `[data-testid="bg-transcript"]`，`data-kind`（`task` / `close`）、`data-running` |
| `View transcript` | `[data-action="view-transcript"]`，`data-role`（结案会话为 `close`） |
| `Stop this task` | `[data-action="stop-task"]`（卡片与 task 视图上的都是） |
| 进展摘要里的链接 | `[data-action="open-in-tasks"]`（task 行另带 `data-task`，标题行的按钮带 `data-request`） |
| `Back`、`Retry` | `[data-action="back"]`、`[data-action="retry"]` |
