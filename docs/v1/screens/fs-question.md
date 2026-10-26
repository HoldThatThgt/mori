# 提问卡、你不在时的倒计时与 Decided while you were away

依据：文件系统构建规格（下称“规格”，两个文件：§0–§5、§11–§19 在 [file-system.md](../../specs/file-system.md)，§6–§10 在
[file-system-permissions.md](../../specs/file-system-permissions.md)）的 [§9](../../specs/file-system-permissions.md)（你不在）、[§10](../../specs/file-system-permissions.md)（`ask_user_question`），汇总的命令、事件与条目在 [§12](../../specs/file-system.md)；
proposal [file-system.md](../../proposals/file-system.md) §5.2、§6“提问卡”“一轮末尾”“设置”、§13 第 5、6 条。
补充 [v0 approval.md](../../v0/screens/approval.md)、[v0 extension-ui.md](../../v0/screens/extension-ui.md)、[team-approvals.md](team-approvals.md)：
卡片停靠的位置、不抢焦点、“{n} more”、任务栏闪烁沿用它们，下面只写新的与不同的地方。
界面文字照 [v0/ui-strings.md](../../v0/ui-strings.md)；标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.question_request` 事件（用户会话的信封） | `{ requestId: 'ask-<n>', toolCallId, questions: [{ question, header, options: [{ label, description }], multiSelect, recommended }], askedAt }` |
| `mori.question_end` 事件 | `{ requestId, toolCallId, by: 'user' \| 'declined' \| 'away' \| 'stop' \| 'closed', answers }` |
| `question.answer { sessionId, requestId, answers }` | 你在卡上提交（`answers` 每个问题 `{ selected, other }`），或按 Esc 拒绝回答（`answers: null`） |
| `LiveSnapshot.asks`、`LiveSnapshot.awayTimers` | 界面重新载入后接上：挂起的提问卡、正在计时的卡的截止时刻 |
| `mori.away_timer { requestId, deadline }` 事件 | 你不在、开始计时时的截止时刻（ms）；切回 Mori 时 `deadline: null` |
| `mori.away_decision` 事件 / 会话文件的同名条目 | 一条自动处理记录：`kind`（approval / question / extension）、`at`、`timeout`、`agent`（后台实例的角色与 task，自己的为 null）、`toolName`、`args`、`title`、`answers`、`result` |
| `mori.approval_end` / `mori.team_approval_end` 的 `by: 'away'` | 批准卡因为你不在被拒绝 |
| `away.get` / `away.set` | 设置页 When you’re away 的值 |
| 工具结果（`tool_execution_end`、会话文件） | `ask_user_question` 的结果原文与 `details.answers` |
| 你的操作 | 卡上的选择、Submit、Esc、停止、设置页的选择 |

## 提问卡

一次 `ask_user_question` 调用一张卡（[规格 §10.4](../../specs/file-system-permissions.md)）。停在这个会话那一栏的输入框上方；同一时刻有批准卡（对话的或后台的）时先显示批准卡；
提问卡和扩展询问卡按到达顺序一次显示一张。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 卡出现 | `mori.question_request` | 卡头是各问题的 `header` 标签（按顺序）；下面按参数的顺序列出每个问题：标签、问题原文、选项（单选用单选按钮，`multiSelect` 用勾选框；每项 `label` 一行、`description` 在下面用次要文字色），推荐项的 label 后面是 ` (Recommended)`；每个问题最后一项 `Other`；底部 `Submit`（还不可用） | 选项、Other、Tab 进卡 |
| 卡出现时的焦点 | 同上 | 不抢焦点，焦点留在输入框；在输入框里按 Enter 仍是发送、排队，不会提交（同批准卡） | Tab 到卡上 |
| 推荐项 | 问题的 `recommended` | 只加 ` (Recommended)`，不预先选中，不改选项的顺序 | — |
| 单选 | `multiSelect: false` | 选一项时同一问题里的其他项与 Other 取消 | 点选项；↑ ↓ 在组内移动，Space 选中 |
| 多选 | `multiSelect: true` | 勾选框，可以勾几项，Other 也可以同时勾 | 点、Space 勾选或取消 |
| 选了 Other | 你的操作 | Other 下面出现输入框，占位文字 `Type your answer`（临时，走查时可以改），焦点移到输入框 | 输入；输入框里 Enter：全部答完时等于 Submit，否则不做什么 |
| 全部答完 | 你的操作：每个问题选了选项，或 Other 里有非空文字 | `Submit` 可用 | Submit |
| 还没答完 | 你的操作 | `Submit` 不可用（`aria-disabled`），不提示哪一题没答 | — |
| 还有别的卡排在后面 | 这个会话收到的 `mori.question_request` / `mori.ui_request` 还没有对应的 `mori.question_end` / `mori.ui_end` | 卡头右边 `{n} more`（计入两种） | 处理完这张，下一张接着出现 |
| 提交 | 你点了 Submit：`question.answer`；随后 `mori.question_end { by: 'user' }` | 卡消失；焦点在卡上时回到输入框 | — |
| 拒绝回答 | 焦点在卡上、没有浮层时按 Esc：`question.answer { answers: null }`；随后 `mori.question_end { by: 'declined' }` | 卡消失；工具卡 `Denied · You declined to answer` | — |
| 停止 | Esc（焦点不在卡上）或停止按钮、`Stop team`；随后 `mori.question_end { by: 'stop' }` | 卡消失；工具卡 `Stopped` | — |
| 会话关闭 | 归档、删除、退出：`mori.question_end { by: 'closed' }` | 卡消失 | — |
| 你不在、到时 | `mori.question_end { by: 'away' }` | 卡消失；工具卡 `Done`，输出为“推荐项被用上”的原文；这一轮末尾的列表多出这些问题（下面） | — |
| 切换会话、去设置页再回来 | 你的操作 | 卡还在 | 照常作答 |
| 界面重新载入（Ctrl+R） | `LiveSnapshot.asks`、`LiveSnapshot.awayTimers` | 挂起的卡照原样出现（没提交的选择不保留）；正在计时的倒计时接着显示 | 照常作答 |
| App 重启、后台进程重新载入 | `session.open` 的结果没有 `live`（后台进程重启后挂起的提问作废，[规格 §10.6](../../specs/file-system-permissions.md)） | 没有卡 | — |

## 倒计时

只在你不在（Mori 窗口不在前台或最小化）时出现，界面按 `deadline` 显示剩下的秒数（最后 20 秒才每秒重画），卡什么时候结束由后台进程决定（[规格 §9.3、§9.9](../../specs/file-system-permissions.md)）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 在计时、剩下多于 20 秒 | `mori.away_timer` 的 `deadline` | 卡上没有变化 | 照常 |
| 剩下 20 秒以内：批准卡（对话自己的与后台实例的） | 同上 | 卡头下一行（警示色）`You’re away · Denying in 12s`，每秒刷新 | 照常选择 |
| 剩下 20 秒以内：提问卡 | 同上 | `You’re away · Using the recommended options in 12s` | 照常作答 |
| 剩下 20 秒以内：扩展询问卡 | 同上 | `You’re away · Cancelling in 12s`；扩展自己的 `This request expires in N seconds` 照旧另起一行 | 照常作答 |
| 你切回 Mori | `mori.away_timer { deadline: null }` | 倒计时那一行消失，卡接着等 | 照常 |
| 到时 | 批准卡：`mori.approval_end` / `mori.team_approval_end { by: 'away' }`；提问卡：`mori.question_end { by: 'away' }`；扩展询问卡：`mori.ui_end` | 卡消失；排在后面的卡（它们同时也在计时，多半同时结束）接着出现 | — |
| 批准卡到时的工具卡 | 工具结果为 `The user was away and didn't answer within …`（`DENIAL_PREFIXES` 里无人应答的开头，[规格 §12](../../specs/file-system.md)） | `Denied · No answer while you were away`（重新打开会话后同样）；后台实例的调用没有工具卡（team-approvals.md） | — |
| 设置为 Never | `away.get` / `away.set` 的 `timeout` 为 `never`（不会有 `mori.away_timer`） | 从不出现倒计时，卡一直等 | — |

## 一轮末尾：Decided while you were away

由程序按记录生成，不靠模型（proposal §6）。“一轮”是你的一条消息到下一条消息之间，程序投递不另起一轮。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 这一轮没有记录 | 这一轮没有 `mori.away_decision` | 没有这一块 | — |
| 这一轮有记录 | `mori.away_decision`（实时的事件；重新打开时的会话条目） | 这一轮最后（在这一轮最后一条回复与回复操作之后）一块：标题 `Decided while you were away`；一行说明 `You didn’t answer within <时长>, so Mori decided these.`（`<时长>` 按这一轮记录的 `timeout` 写 `60 seconds` / `5 minutes` / `10 minutes`；这一轮的记录时长不同时写 `You didn’t answer in time, so Mori decided these.`）；下面每条记录一行（下表），按时间先后 | — |
| 这一轮还在进行 | 新的 `mori.away_decision` | 这一块跟着长，始终在这一轮的最后 | — |
| 重新打开会话、界面重新载入 | 会话文件里的 `mori.away_decision` 条目 | 与实时相同 | — |

每一行：

| 记录 | 行的写法 |
| --- | --- |
| 批准，用户会话自己的 Agent | `Denied` · 工具卡标题（`Run <命令>`、`Edit <路径>`、`<服务> · <工具>` 等，同 toolTitle），右边时间 `HH:MM` |
| 批准，后台实例 | 开头加归属 `<role> · T1`（没有 task 时 `<role>`，基座写 `Mori`），其余同上 |
| 提问 | 每个问题一行：`Recommended` · `<header>: <label>`，右边时间 |
| 扩展询问 | `Cancelled` · `Extension: <title>`，右边时间 |

读屏名：整块 `Decided while you were away`，每行把 “ · ” 换成逗号（ui-strings.md 的规则）。

## 工具卡、阶段行、侧栏、任务栏

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `ask_user_question` 的工具卡 | pi 的工具事件；`mori.question_request` / `mori.question_end` 的 `by`；重新打开时会话文件里的工具结果（拒绝回答、停止按原文认出，[规格 §10.6](../../specs/file-system-permissions.md)；认法列在 [规格 §12](../../specs/file-system.md) 的 `DENIAL_PREFIXES`） | 标题 `Ask · <各问题的 header，用 , 连接>`（例如 `Ask · Database, Scope`）；卡挂着时状态 `Waiting for your answer`；结束后 `Done`（提交、按推荐项）、`Denied · You declined to answer`、`Stopped`（停止、会话关闭）；展开后 Input 为参数，Output 为工具结果原文 | 展开 |
| 阶段行 | 有还没结束的 `mori.question_request` 或 `mori.ui_request`，没有批准卡 | `Waiting for your answer`（沿用扩展询问） | — |
| 侧栏会话行 | 同上（没点开的会话按 `LiveStatus.question`） | `Needs input`（沿用） | 点会话切过去 |
| 任务栏 | `mori.question_request`，且窗口没有焦点 | 任务栏上的 Mori 按钮闪烁；窗口获得焦点时停止（同批准卡）。扩展询问卡不闪（不变） | 切回 Mori |

## 设置页：General → When you’re away

设置页新增一节 `General`（排在 `UI issues` 之后，[规格 §17](../../specs/file-system.md) 的临时默认值），只放这一项（[规格 §9.6](../../specs/file-system-permissions.md)）；值存在 `<userData>/away.json`。
Clean up worktrees 在另一节 `Storage`，见 [fs-worktree.md](fs-worktree.md)；两节都有。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开这一节 | `away.get` | 一行 `When you’re away`，右边下拉，四项 `60 seconds`、`5 minutes`、`10 minutes`、`Never`，选中当前值（默认 `5 minutes`）；下面说明 `When a permission request or question is waiting and Mori isn’t the active window, Mori answers it after this long: it denies permission requests, uses the recommended option for questions, and cancels extension prompts. The agent is told, and the turn lists what was decided.` | 选一项 |
| 读不出设置文件 | `away.get` 的 `error` | 下拉显示 `5 minutes`；下面一行 `Couldn’t read the setting: <原文>` | 选一项（写好文件） |
| 选了一项 | `away.set`，成功 | 下拉显示新的值；之后开始的计时按它 | — |
| 保存失败 | `away.set` 的 `error` | 下拉回到原来的值；下面一行 `Couldn’t save: <原文>` | 再选一次 |

## 反例

- 窗口在前台时，卡片超过设置的时长也不会被自动处理，也不显示倒计时。
- 焦点在分屏的另一栏、或在设置页，不算你不在。
- 切回 Mori 再切走，计时从头开始，不接着上次剩下的。
- 在输入框里按 Enter 不会提交提问卡；推荐项不会被预先选中。
- 提问卡到时不会用你没提交的选择。
- 后台实例的提问不存在：task、临时提问、订阅、立项（分开时）、结案没有 `ask_user_question`。
- 提醒 Agent 的那段隐藏提示不显示在对话流里。
- “Decided while you were away” 不进 Export as Markdown，也不进会话引用。
- 协作模式分开时转给立项的那条“问题 + 答复”不出现在排队区，停止时也不回到输入框。

## 本表定下的界面细节

都是临时，走查时可以改：Other 输入框的占位文字 `Type your answer`；倒计时一行用警示色、放在卡头下一行；“Decided while you were away” 的说明行
（`You didn’t answer within <时长>, so Mori decided these.` / `You didn’t answer in time, so Mori decided these.`）、每行开头的 `Denied` / `Recommended` / `Cancelled` 和右边的时间 `HH:MM`；
设置项下面的说明文字与两种出错的一行（`Couldn’t read the setting: …`、`Couldn’t save: …`）；
还没答完时 Submit 只是不可用，不提示是哪一题。

## 需要规格回答

- 无。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 提问卡 | `data-testid="ask-card"`，`data-request` 为 `requestId`（`ask-<n>`） |
| 一个问题 | 卡里 `data-testid="ask-question"`，`data-index`（从 0 起），`data-multi`（`true` / `false`） |
| 选项 | `data-testid="ask-option"`，`data-label` 为 label 原文；推荐项另有 `data-recommended="true"`，后面的字 `data-testid="ask-recommended"` |
| Other 与它的输入框 | `data-testid="ask-other"`、`data-testid="ask-other-input"` |
| Submit | `data-testid="ask-submit"` |
| 倒计时一行（三种卡共用） | `data-testid="away-countdown"`，`data-deadline` 为截止时刻（ms） |
| 一轮末尾的那一块 | `data-testid="away-block"`；每行 `data-testid="away-row"`，`data-kind`（approval / question / extension），`data-request` |
| 设置项 | `data-testid="away-timeout"`（下拉），`data-section="general"`（分节按钮） |
| 沿用 | 批准卡 `approval-card`、扩展询问卡 `ext-ui-card`、“{n} more” `approval-more`、侧栏 `session-status` 同 v0 |
