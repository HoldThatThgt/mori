# 对话流里的协作：回执、进展摘要、不显示的投递

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§5.3 第 5、6 步、§5.6（程序投递到用户会话）、
§7.4（程序写的一棒）、§11.6（重新载入与重启）、§12.12（后台实例的模型提示）、§13.2（回执）、§13.3（进展摘要）、§13.7（不显示的投递与回合）、
§13.8（工具卡标题）、§13.10、§13.11（重新打开）。补充 [v0 chat.md](../../v0/screens/chat.md) 的对话流与 [v0 tool-cards.md](../../v0/screens/tool-cards.md)。
标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.receipt` 事件 | `{ kind: 'registered' \| 'added' \| 'cancelled', request, title, quote, at }`；与会话文件的同名条目同一时刻写入（§13.2） |
| 会话文件的 `mori.receipt` 条目 | 同上（重新打开时） |
| `mori.progress` 事件 / 条目 | `{ request, at }`：进展摘要的位置（§5.3 第 6 步、§13.3） |
| `mori.board` 事件 | `BoardView`（后台进程合并发送，最多每 250 毫秒一次）：每个需求的 `RequestView`（`no`、`title`、`status`、`state`、`createdAt`、`closedAt`、`conclusion`、`ruledOut`、`question`、`tasks`），每个 task 的 `TaskView`（`id`、`title`、`status`、`holder`、`phase`、`waitingFor`、`current`、`modelNote`、`chain`） |
| `SessionInfo.board`（`session.open`、`session.recheckAgents`）、`LiveSnapshot.board`（界面重新载入）、`board.get` 的结果 | 同 `BoardView`；重新打开时进展摘要的内容 |
| `TeamState.holders` | `<create role>`、`<close role>`；基座（`mori`）显示为 `Mori` |
| `mori.wake` 事件 | `{ text, kind }`（§13.7）：下一条文字与它相同的 role 为 user 的 `message_start` 是程序投递 |
| 会话文件的 `mori.wake` 条目 | `{ messageId, kind }`：它指向的用户消息是程序投递 |
| pi 的事件 | 同 v0（`message_start`、`message_end`、`tool_execution_*`、`agent_settled`）；合并会话里立项工具的调用照常是工具卡 |
| 界面的时钟 | 进展摘要的时长每秒更新 |

## 回执

立项实际写入 `request_submit`、`request_update`、`request_cancel` 时程序写一行回执（§13.2）；看不到回执就说明没记上。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 登记了需求 | `mori.receipt`，`kind: 'registered'` | 一行 `Request 1 registered · <title>` | — |
| 记下补充 | `kind: 'added'` | 一行 `Added to request 1: “<quote>”`；`quote` 超过 120 个字符时取前 120 个加 `…`（§15）；悬停看全文（临时，走查时可以改） | — |
| 撤销了需求 | `kind: 'cancelled'` | 一行 `Request 1 cancelled` | — |
| 立项没有写入 | 没有 `mori.receipt` | 没有回执（task 的建立、交接、关闭只在进展摘要里，§13.2 最后一条） | — |

回执在对话流里的位置（实时与重新打开相同，因为事件与条目同一时刻写，§13.2）：

| 情况 | 位置 |
| --- | --- |
| 分开时（对话与立项是不同角色），判断你的消息 | 紧跟在那条你的消息之后、对话的回复之前：对话会话写下这条消息（`message_end`）之后才写回执，所以消息还在排队区（排队、插话、`Waiting for <create role>`）时还没有回执 |
| 合并会话（对话与立项是同一条会话） | 在调用它的那张工具卡下面（同一条回复里，排在之后的工具卡之前）：实时是收到回执时正在执行的那个调用；重新打开时是回执条目之后第一个工具结果所属的调用（工具按顺序执行，§14.6 T-S6）（画法临时，走查时可以改）。2026-10-26 走查 M18 起这张卡所在的步骤组折起时卡不显示，回执照常显示，看起来就在组的摘要行"{n} steps"下面；展开后同上（[../../v0/screens/chat.md](../../v0/screens/chat.md)"步骤组"） |
| 程序唤醒的立项回合（只有 `request_update`） | 写入那一刻的对话流末尾（对话空闲时立即写；正在输出时在当前助手消息结束之后） |
| 立项已经写入、这条消息却没有进对话会话：停止、撤回、段开始时选不到模型、拒绝启动 | 离开时的对话流末尾（与 `mori.progress` 一起，§13.2） |

## 进展摘要

每个需求一块（§13.3）。只由程序用需求和 task 的标题、当前在做什么、每一棒的结论拼出来。

### 位置

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 还没有位置 | 需求已在 `BoardView` 里，还没有它的 `mori.progress` | 不显示这一块；只有回执（对话还在回复登记它的那条消息时是这样） | — |
| 分开时 | `mori.progress { request }`：对话回复这条消息的那一段结束时写（下一条你的消息的 `message_start` 之前，或 `agent_settled` 之后，§5.3 第 6 步） | 挂在登记它的那个回合里对话回复的下面、那一轮的回复操作（复制、引用、反馈）之上；你在对话回复中又排了一条消息时也挂在这条回复下面（TB-37） | 展开、折叠 |
| 合并会话 | 登记它的那一段结束时的 `mori.progress` | 同上 | 同上 |
| 程序唤醒的回合、撤回时 | 写入时的 `mori.progress` | 写入时的对话流末尾 | 同上 |
| 重新打开，`mori.progress` 缺了 | 后台进程打开会话时为 `board.json` 里有、会话里没有 `mori.progress` 的需求补写一条（§11.6，例如登记之后 App 退出） | 这一块在对话流末尾 | 同上 |

### 内容

默认折叠；点标题行（或焦点在它上面按 Enter、空格）展开、折叠，展开状态不跨重新打开（临时，走查时可以改）。
需求关闭后停在最终状态，仍可以展开。
（2026-10-26 加，规格 §13.13.1：task 行是按钮，打开右栏 Background tasks 里这个 task 的视图；标题行右端一个图标按钮 `Open Request 1 in Background tasks`
打开那里的列表并展开这个需求。文字与位置见 [team-tasks.md](team-tasks.md)“入口”。）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 折叠 | `RequestView` 与它的 `TaskView` | 标题行 `Request 1 · <title> · <需求状态> · <时长>`；下面每个未结束的 task（`status` 不是 `done`、`failed`、`cancelled`）一行 `T1 <title> · <role> · <当前在做什么>`；例：`Request 1 · Login page is blank · Running · 6 min`，`T1 Find and fix · reviewer · Run npm test` | 展开 |
| 展开 | 同上，加 `TaskView.chain`、`RequestView.ruledOut`、`RequestView.conclusion` | 标题行；全部 task（包括已结束的），每个 task 一行（同上），下面一行交接链（下节）；有已排除的方案时一节 `Ruled out`，每条一行；有结论时一行 `Conclusion: <conclusion>`（两处标签临时，走查时可以改） | 折叠 |
| 实时更新 | `mori.board` | 标题、状态、task 行、交接链随事件更新；时长每秒更新 | — |
| 需求关闭 | `RequestView.status` 为 `done` / `failed` / `cancelled`，`closedAt` 不为 null | 需求状态 `Done` / `Failed` / `Cancelled`；时长停在 `closedAt`；折叠时没有 task 行（都已结束），没有 `Running`；展开后有结论 | 展开、折叠 |
| 重新打开 | 位置来自 `mori.progress` 条目，内容来自 `SessionInfo.board`（§13.3） | 与关闭前一致；重启后非终态的 task 显示 `Stopped (Mori restarted)`（§11.6） | 同上 |

task 行里的 `<role>` 是 `TaskView.holder`（持有者的角色名，交到结案时为结案持有者；基座显示 `Mori`）；`holder` 为 null（`pending`、终态）时省略这一段，
写作 `T2 <title> · Waiting for T1`；`phase` 为 `with_close` 时也省略，因为状态文字已经写出结案角色（都是临时，走查时可以改；见“需要规格回答”）。
项目没有角色文件时（`TeamState.roles` 为空，每个 task 都是基座做的）一律省略这一段，写作 `T1 <title> · <当前在做什么>`（§13.3，2026-10-26，负责人走查 M13：到处写 `Mori` 时看起来像对话 Agent 自己在做）。

**需求状态**（`RequestView.state`，后台进程按 §13.3 的顺序取第一个；取值是 `shared/team.ts` 的 `REQUEST_STATES`，`data-state` 就是它）：

| `data-state` | 文字 | 什么时候（§13.3） |
| --- | --- | --- |
| `done` / `failed` / `cancelled` | `Done` / `Failed` / `Cancelled` | 需求是终态 |
| `needs_decision` | `Needs your decision` | 有 `asked` 为真的 `waiting_user` task，或需求级问题已问过你 |
| `waiting_create` | `Waiting for <create role>` | 有需求级问题或 `waiting_user` task 还没问你 |
| `stopped` | `Stopped` | 有 `stopped` 的 task 且没有运行中的 |
| `with_close` | `With <close role>` | task 都已结束、需求还开着 |
| `running` | `Running` | 其余 |

**时长**：`createdAt` 到现在（需求关闭后到 `closedAt`）：不到 1 分钟 `<1 min`，不到 1 小时 `6 min`（向下取整），之后 `1 h 12 min`（整小时写 `1 h 0 min`；取整与整小时的写法临时，走查时可以改）。

**当前在做什么**（`TaskView.phase`，`data-phase` 就是它的值）：

| `phase` | 文字 |
| --- | --- |
| `pending` | `Waiting for T1`（`waitingFor` 里每个 task，逗号分隔：`Waiting for T1, T3`；分隔写法临时，走查时可以改） |
| `queued` | `Queued`（超过同时运行的上限，§9.2） |
| `lock_wait` | `Waiting to change files (T2)`；`waitingFor` 里的那个 task 的 `status` 是 `stopped` 时 `Waiting to change files (T2, stopped)` |
| `starting` | `Starting`（实例已开始、还没调用工具） |
| `running` | `current` 的标题（下面的标题规则），例如 `Run npm test`、`Read src/a.ts` |
| `approval` | `Waiting for your approval`（这个实例有挂起的批准卡，team-approvals.md） |
| `waiting_user` | `Waiting for <create role>`（等你拿主意、还没问你） |
| `asked` | `Needs your decision`（已经问过你） |
| `with_close` | `With <close role>` |
| `stopped` | `Stopped` |
| `stopped_restart` | `Stopped (Mori restarted)` |
| `done` / `failed` / `cancelled` | `Done` / `Failed` / `Cancelled`（只在展开时出现） |

`modelNote` 不为 null 时加在这一行末尾：` · <modelNote>`，例如 ` · Switched model: A → B · rate limited`；实例的下一次运行开始时消失（§12.12）。

**`running` 的标题规则**（与 v0 工具卡相同的规则，§13.3：路径在会话工作目录之内写相对路径；命令只取第一行，超过 80 个字符截断加 `…`）。
进展摘要是新界面，动词用英文（english-ui 的词，`shared/team.ts` 的 `toolCallTitle`）；规格只给了 `Run`、`Read`，其余动词临时，走查时可以改：

| `current.toolName` | 文字 |
| --- | --- |
| `read` | `Read <path>` |
| `bash`、`powershell` | `Run <command>` |
| `edit` / `write` | `Edit <path>` / `Write <path>` |
| `grep` / `find` | `Search <pattern>` / `Find <pattern>` |
| `ls` | `List <path>`（没有 `path` 时 `List .`） |
| `mcp__<服务>__<工具>` | `<服务> · <工具>` |
| `task_handoff` | `Hand off T1`（这一行的 task） |
| `board_read`、`read_session`、`agent_message` | §13.8 的标题；`current.args` 里没有的部分写作 `…`（同 v0“参数还没写完”）：`Read …’s work on …`、`Message …`；`board_read` 没有参数时就是 `Read the board`，所以 `Read T1`、`Read request 1` 写不出来（见“需要规格回答”） |
| 其他 | 工具原名 |

### 交接链（展开时）

| 状态 | 来源 | 必须可见 |
| --- | --- | --- |
| 有交接 | `TaskView.chain` 的每一棒 `{ role, outcome, line }` | 一行 `executor: Fixed → reviewer: Failed, logout test fails → executor: Logout fixed too`：每棒 `<role>: <line>`；`line` 是结论的第一句（≤ 80 个字符，§15，后台进程截好）；结案会话那一棒的 `role` 是结案持有者的角色名；基座写 `Mori` |
| 程序写的一棒 | `outcome` 为 null，`role` 为 `mori`（§7.4） | `Mori: no handoff` / `Mori: error` / `Mori: no model` / `Mori: dependency failed` / `Mori: close didn’t decide`（`line` 按 `reason` 取 `shared/team.ts` 的 `PROGRAM_HANDOFF_LINES`：`no_handoff`、`error`、`no_model`、`dependency_failed`、`close_undecided`） |
| 没有角色文件 | `TeamState.roles` 为空 | 每棒只写 `<line>`，没有角色名：`Found the bug → Fixed and verified`、`src has only a.ts → no handoff`（§13.3，2026-10-26） |
| 还没有交接 | `chain` 为空 | 没有这一行 |

## 合并会话里立项工具的工具卡

合并会话里立项的调用是用户会话自己的调用，照常显示为工具卡，标题按 §13.8（[v0 tool-cards.md](../../v0/screens/tool-cards.md) 的标题对照表）；
它们免批准（§11.2），没有批准卡。分开时立项、结案、task 实例的调用不在对话流里（实例的 pi 事件不转给界面，§8.2），只在进展摘要里。

## 不显示的投递与回合

程序投递到用户会话的 `[Mori] …` 消息（§5.6：`request_closed`、`relay`、`ask_user`、`create_wake`）不是你的消息。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 投递开始 | `mori.wake { text, kind }`，随后文字相同的 role 为 user 的 `message_start` | 这条消息变成不显示的 `wake` 条目：没有气泡、没有引用芯片、不出现在排队区；它从不替换你待发的消息气泡，它的 `mori.entry_id` 由它消费（§13.7） | — |
| 投递之后的回复 | 同一次运行的助手消息 | `wake` 条目结束上一轮：上一轮最后一条回复下出现它的回复操作；投递之后的回复是新的一轮，有自己的回复操作行（§13.7） | 复制、引用、反馈（v0） |
| 投递时的阶段行与侧栏 | 用户会话的运行（v0 事件、模型层事件） | 同普通回复：阶段行、“停止”、侧栏“生成中” | 停止（Esc） |
| 投递在准备中被停止、选不到模型、拒绝启动 | `mori.model_unavailable` 或 `mori.prompt_error`，`text` 为 null，`queued` 不含它（§5.6） | 照常显示说明卡；没有文字回到输入框 | 同说明卡 |
| 重新打开 | 会话文件的 `mori.wake { messageId, kind }` | 它指向的用户消息变成同样的 `wake` 条目，同样结束上一轮 | — |

## 重新打开会话

`history.ts` 按会话文件的条目重画（§13.11），顺序与实时相同：

| 条目 | 显示 |
| --- | --- |
| `mori.receipt` | 回执行（位置见“回执”） |
| `mori.progress` | 进展摘要，内容用 `SessionInfo.board` |
| `mori.wake` | 它指向的用户消息变成不显示的 `wake` 条目，结束上一轮 |
| `mori.team` | 不显示 |

界面重新载入（Ctrl+R）后接上会话：后台进程里的实例照常运行；`LiveSnapshot.board` 给出进展摘要的内容，之后随 `mori.board` 更新（§11.6）。

## 反例

- `[Mori]` 开头的文字从不出现在你的消息气泡、输入框或排队区里；“撤回”、停止、错误卡的“把上一条消息放回输入框”都不会带回它。
- 后台进程把会话作为引用读出（`session.read`）时去掉 `mori.wake` 指向的用户消息（§13.11），引用预览里没有它。
- task 的建立、交接、关闭不出回执行。
- 分开时立项的工具调用、task 实例的工具调用不在对话流里出工具卡。
- 进展摘要的需求和 task 标题就是 `BoardView` 里的标题（立项写的），不由模型另外总结。
- 需求关闭后进展摘要不再显示 `Running`，时长不再走。
- 对话还在回复登记需求的那条消息时，只有回执，没有进展摘要（`mori.progress` 在这一段结束时才写）。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：回执原话的悬停看全文；合并会话里回执画在调用它的工具卡下面；进展摘要的展开方式与展开状态不跨重新打开；
展开后的 `Ruled out`、`Conclusion:` 标签；`holder` 为 null、`phase` 为 `with_close` 或没有角色文件时省略 task 行的角色段；`waitingFor` 逗号分隔；
时长向下取整、整小时写 `1 h 0 min`；进展摘要 `running` 的英文动词 `Edit`、`Write`、`Search`、`Find`、`List`；
`board_read`、`read_session`、`agent_message` 缺的参数写作 `…`。

## 需要规格回答

规格 §13.10 没定、`shared/team.ts` 已经定下的：`RequestView.state` 是代码 `REQUEST_STATES`（文字由界面按 `TeamState.holders` 写）；
`TaskView.holder` 在交到结案时为结案持有者的角色名；`chain` 的 `role` 在结案会话那一棒为结案持有者的角色名、程序写的为 `mori`，`line` 由后台进程截好，
程序写的一棒的 `line` 是 `PROGRAM_HANDOFF_LINES` 的文字。规格应补上这些。

- **`TaskView` 没有 `assignee`**：`pending` 的 task `holder` 为 null，进展摘要写不出指派给谁（`board_read` 的文本写了，§6.4）。本表省略角色段；要显示需要 `TaskView` 加 `assignee`。
- **交接链截断的位置**：v1/defaults.md 把“交接链每棒 ≤ 80 字符”的位置写在 `app/src/renderer/src/`，`shared/team.ts` 的 `HandoffLink.line` 说明是后台进程给出截好的第一句；
  defaults.md 的位置应改为 `shared/team.ts`（或内核）。
- **`current.args` 不够写 TaskBoard 工具的标题**：§13.10 的 `current.args` 只有 `path`、`command`、`pattern`，而 §13.8 的 `Read T1`、`Read <role>’s work on T1`、
  `Ask <role>` / `Message <role>` / `Message T1` 需要 `request`、`task`、`role`、`to`；read 的行范围也需要 `offset`、`limit`。需要 `current.args` 加这些字段，或由后台进程直接给出标题。
  TB-45 要求 task 行“等于那个实例会话最近一次工具调用的 §13.8 标题”，按现在的字段这几个工具做不到。
- **进展摘要的标题与 v0 工具卡的语言**：§13.3 说“与 v0 工具卡相同”，例子却是英文（`Run npm test`、`Read src/a.ts`），与 english-ui 合并前本分支的 v0 工具卡是中文（“运行 npm test”）。
  本表让进展摘要用英文动词、其余规则同 v0；合并后（2026-10-21）v0 工具卡也是英文，两者一致；
  TB-45 的“等于 §13.8 标题”按这个英文规则比较。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 回执 | `[data-testid="receipt"]`（§13.2），`data-kind`（`registered` / `added` / `cancelled`）、`data-request` |
| 进展摘要 | `[data-testid="progress"]`（§13.3），`data-request`、`data-state`（上表的代码）；标题行是按钮，`aria-expanded` |
| task 行 | `[data-testid="progress-task"]`（§13.3），`data-task`、`data-phase`（`TaskView.phase`） |
| 交接链、已排除的方案、结论 | `[data-testid="progress-chain"][data-task]`、`data-testid="progress-ruled-out"`、`data-testid="progress-conclusion"`（本表定，临时） |
| 合并会话里立项工具的卡 | `data-testid="tool-card"`（沿用 v0，按标题文字认出） |
