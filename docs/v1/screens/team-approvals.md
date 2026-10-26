# 后台实例的批准卡

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§11.1（一个用户会话一份批准状态）、§11.2（免批准的工具）、
§11.3（后台实例的批准卡）、§11.4（停止）、§11.6（重新载入与重启）、§13.4、§13.6（侧栏状态）、§13.10。
补充 [v0 approval.md](../../v0/screens/approval.md)：卡片内容、三个选项、Alt+1/2/3、焦点规则、权限菜单与任务栏闪烁都沿用它，下面只写不同的地方。
与 english-ui 合并后（2026-10-21）v0 的文字按 [v0/ui-strings.md](../../v0/ui-strings.md) 的英文；下文引号里的中文是原来的叫法，界面上显示：
允许一次 = Allow once，本会话不再询问 = Allow “…” for this session，拒绝 = Deny，还有 N 张 = {n} more，等你批准 = Waiting for your approval /
Needs approval，本会话已允许 = Allowed for this session，每次询问 = Ask each time，全部允许 = Allow all，生成中 = Running。
标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.team_approval_request` 事件（用户会话的信封） | `{ requestId: '<实例 id>:<批准编号>', instance, role, task, taskTitle, toolCallId, toolName, args }`；没有 task 的实例 `task`、`taskTitle` 为 null |
| `mori.team_approval_end` 事件 | `{ requestId, decision, by, reason }`：允许或拒绝；由谁决定（你、本会话不再询问、切到全部允许、停止、会话结束）；拒绝理由 |
| `SessionInfo.teamApprovals`、`LiveSnapshot.teamApprovals` | 挂起的后台批准（`session.open`、界面重新载入后接上会话） |
| `mori.approval_request` / `mori.approval_end` | 对话 Agent 自己的批准（v0，不变） |
| `approval.answer { sessionId: 用户会话, requestId }` | 你在卡上的选择；后台进程按 `requestId` 交给那个实例（§11.3） |
| `approval.setMode`、`approval.forget` | 权限菜单（v0），作用于这个用户会话的全部 Agent（§11.1） |
| `LiveStatus.teamApproval` | 侧栏里没在中栏显示的会话（界面重新载入后还没点开的）是否有后台批准卡 |
| `mori.board` 的 `TaskView.phase` | `approval`：进展摘要这一行 `Waiting for your approval` |
| 主进程的窗口焦点 | 任务栏闪烁（v0） |
| 你的操作 | 卡上的选择、Esc、`Stop agents`、权限菜单 |

`<role>` 是事件里的 `role`，基座（`mori`）显示为 `Mori`；`T1`、`<task title>` 是 `task`、`taskTitle` 原文。

## 哪些调用出卡

| 情况 | 结果 |
| --- | --- |
| 实例调用 v0 要批准的工具（命令、`edit`、`write`、MCP 工具、扩展注册的工具），权限是“每次询问”，工具名不在“本会话已允许”里 | 出卡（下节） |
| v0 的四个读取类工具、TaskBoard 的 11 个工具（`board_read`、`read_session`、`agent_message`、`task_handoff`、`request_submit`、`request_update`、`request_cancel`、`task_create`、`task_edit`、`reply_via_dialog`、`request_close`） | 直接执行，从不出卡（§11.2），对话 Agent、合并会话里的立项也一样 |
| 工具名在这个用户会话的“本会话已允许”里（任何一个 Agent 的卡上允许过的） | 直接执行，不出卡（§11.1） |
| 权限是“全部允许” | 直接执行，不出卡（§11.3 最后一条） |

## 批准卡

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 后台实例要批准 | `mori.team_approval_request` | 停在用户会话那一栏的输入框上方（分屏时在这个会话所在的那一栏）；内容与 v0 的卡相同（按工具：修改、写入、运行命令、MCP、其他；路径在项目文件夹之外、不可见控制字符的警示同 v0，路径按用户会话的工作目录判断，实例与它相同）；卡头多一行归属 `<role> · T1 · <task title>`，没有 task 时 `<role>`（§11.3）；普通模式的通用 subagent 为 `<Role> · <description>`，例如 `Mori · Fix the retry loop`（[subagent 规格](../../specs/subagent.md) §7.4） | Alt+1 允许一次；Alt+2 本会话不再询问；Alt+3 拒绝（同 v0） |
| 卡片出现时 | 同上 | 不抢焦点，焦点留在输入框，在输入框里按 Enter 仍是发送、排队，不会批准（同 v0） | Tab 到卡上 |
| 几张卡同时挂着 | 对话自己的请求与各个实例的请求 | 一次显示一张；排序：对话 Agent 自己的卡在前，后台实例的卡在后，各按到达顺序（§11.3）；卡头“还有 N 张”计入全部挂着的卡；正在显示的卡不会被后到的卡替换，后到的对话卡排在其余后台卡之前（临时，走查时可以改） | 处理完当前这张，下一张接着出现 |
| 允许一次 | 你选了“允许一次”：`approval.answer`；随后 `mori.team_approval_end`（允许） | 卡片消失；焦点在卡上时回到输入框；进展摘要这一行从 `Waiting for your approval` 变为当前在做什么（随 `mori.board`） | — |
| 本会话不再询问 | 你选了 Alt+2：`approval.answer`；随后这个用户会话里**所有 Agent** 挂起的同名请求各自的 `mori.team_approval_end` / `mori.approval_end`（由“本会话不再询问”决定，§11.1） | 这张卡和其他 Agent 挂着的同名卡一起消失；之后任何 Agent 的同名调用都不再出卡；v0 的小字“之后本会话的所有命令都会直接执行”不变（“本会话”就是这个用户会话的全部 Agent）；权限菜单的“本会话已允许”列出它 | — |
| 拒绝 | Alt+3，或理由框里按 Enter；随后 `mori.team_approval_end`（拒绝） | 卡片消失；理由作为那个实例的工具结果回给它（v0 的固定写法 `Rejected by the user.` / `Rejected by the user. Reason: <理由>`） | — |
| 焦点在卡上按 Esc | 你的操作 | 没有浮层时等于拒绝这张卡（带理由框里的文字），同 v0 | — |
| 焦点不在卡上按 Esc、点停止 | 你的操作（§11.4） | 只停对话这一回合和为它判断的立项（team-stop.md）；后台实例的卡**不变**，继续挂着 | — |
| `Stop agents` | `session.stopTeam`；随后每张卡的 `mori.team_approval_end`（拒绝，由停止决定） | 全部批准卡（对话的和后台的）按拒绝处理并消失（§11.4） | — |
| 实例的请求因别的原因结束 | `mori.team_approval_end`（例如撤销需求停止了这个实例，§7.6） | 卡片消失 | — |
| 对话一轮结束 | 用户会话的 `agent_settled` | 后台的卡**不清掉**（§11.3） | 照常选择 |
| 切换会话、去设置页再回来 | — | 卡片还在（同 v0） | — |
| 界面重新载入（Ctrl+R） | `LiveSnapshot.teamApprovals` | 挂起的后台卡按到达顺序重新出现，归属行照旧（§11.6） | 照常选择 |
| App 重启、后台进程重新载入 | §11.6：挂起的批准作废 | 没有卡；对应的 task 显示 `Stopped (Mori restarted)`（team-stream.md） | — |

## 不在卡上的地方

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 工具卡 | 实例的 pi 事件不转给界面（§8.2） | 后台实例的调用在对话流里**没有**工具卡（v0 的“工具卡同时显示等你批准”不适用）；进展摘要这个 task 的一行显示 `Waiting for your approval`（`phase` 为 `approval`） | — |
| 阶段行 | 阶段行只反映对话自己的运行（v0、model-chat.md、team-stop.md） | 后台卡不改变阶段行：对话空闲时没有阶段行，对话在回复时显示它自己的阶段（本表的理解） | — |
| 任务栏闪烁 | `mori.team_approval_request`，且 Mori 窗口没有焦点（§11.3） | 任务栏上的 Mori 按钮闪烁；窗口获得焦点时停止（同 v0） | 切回 Mori |
| 侧栏会话状态 | 这个会话有挂起的后台卡（界面里的卡，或没点开的会话的 `LiveStatus.teamApproval`） | 会话行状态“等你批准”（沿用现有文字，`data-status="approval"`），优先于“生成中”（同 v0 的顺序）；左栏收起时“展开”按钮上的圆点同 v0 | 点会话切过去 |
| F8 报告 | 你按了 F8 | “当前界面”里“等你批准的数量”计入后台卡（§11.3）；“最近的操作”里你在后台卡上的选择照 v0 记录 | — |

## 权限菜单

沿用 v0 的菜单与“切换到全部允许？”确认框，改动如下（§11.1）：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单打开 | 你点了权限按钮 | 底部说明改为英文 `Applies to all agents in this session. New sessions start at Ask each time.`（取代 v0 的“只作用于这个会话，新会话从'每次询问'开始”）；其余同 v0 | 同 v0 |
| 切到全部允许时有挂起的卡 | 确认后 `approval.setMode`；随后对话与所有实例挂起的请求各自的结束事件（由“全部允许”决定） | 全部批准卡消失；之后任何 Agent 都不再出卡 | — |
| 新建的实例 | §11.1 | 从这个用户会话当前的权限与“本会话已允许”开始（例如已经全部允许时，新开的 task 实例不出卡） | — |
| 清除一项“本会话已允许” | `approval.forget` | 之后这个会话里任何 Agent 的同名调用又出卡 | — |

## 反例

- TaskBoard 工具从不出批准卡（TB-34）。
- 在输入框里按 Enter 不会批准后台卡。
- Esc 停止对话回复时，后台卡不被拒绝。
- 对话一轮结束不会清掉后台卡。
- 切到“全部允许”后，后台实例不再出卡；新会话（另一个用户会话）仍从“每次询问”开始。
- 后台卡的编号（`<实例 id>:<编号>`）不与对话自己的请求编号冲突。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：正在显示的卡不被后到的卡替换，后到的对话卡排在其余后台卡之前；后台卡不改变阶段行；
归属行写在卡头标题的上面一行，用次要文字色。

## 需要规格回答

- **对话卡与后台卡同时挂着时的显示**：§11.3 写“排在对话 Agent 自己的卡之后”。如果后台卡正在显示时对话自己的请求到了，照字面应该换成对话的卡，
  但卡在你眼前被换掉，按下的 Alt+1 可能落在另一张卡上。本表选择不替换正在显示的卡；协作模式下对话只有免批准的工具（§5.5），两者同时挂着的情况很少。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 批准卡 | `data-testid="approval-card"`（沿用 v0），`data-request` 为 `requestId`（后台卡是 `<实例 id>:<编号>`），`data-tool` 为工具名；后台卡另有 `data-agent`（`role`，基座为 `mori`）、`data-task`（task 编号，没有 task 时不带）（§11.3）、`data-subagent`（普通模式的 subagent 的 description，不是 subagent 时不带；subagent 规格 §7.4） |
| 归属行 | 卡里 `data-testid="approval-attribution"`（本表定，临时） |
| 卡上的选项、理由框、“还有 N 张” | 沿用 v0：`approval-allow`、`approval-allow-session`、`approval-reject`、`approval-reason`、`approval-more` |
| 侧栏状态 | `[data-testid="session-status"][data-status="approval"]`、`data-testid="rail-status"`（沿用 v0） |
| 权限菜单说明 | `data-testid="permission-menu"` 里的底部说明（沿用 v0 的菜单标识） |
