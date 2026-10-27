# subagent 的工具卡

依据：[普通模式的 subagent 工具规格](../../specs/subagent.md)（下称“规格”）§7、§8、§9。补充 [v0 tool-cards.md](../../v0/screens/tool-cards.md)
（工具卡的位置、v0 的状态来源）与 [team-stream.md](team-stream.md)（工具标题的规则 `toolCallTitle`）。
用词照 Claude 桌面版（`Running agent`、`Running {count} agents`、`Ran agent`、`Ran {count} agents`、`{count} tool uses`、`Agent prompt`、`{done} of {total} agents done`）。
标了“（临时，走查时可以改）”的是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| pi 的 `toolcall_start`、`toolcall_delta`、`message_end` | 这次调用的参数（还在流入时从已收到的 JSON 里取 `tasks` 的项数与每项的 `description`） |
| pi 的 `tool_execution_start` | 开始执行（v0：自动放行，`subagent` 免批准） |
| pi 的 `tool_execution_update` 的 `partialResult.details` | `SubagentDetails`（规格 §9.1）：每个 subagent 的 `description`、`role`、`readOnly`、`prompt`、`phase`、`toolUses`、`current`、`note`、`reply`、`error`；最多每 250 毫秒一次 |
| pi 的 `tool_execution_end` | `isError` 与最终的 `details`；被拒绝的调用没有 `details`，输出是两行错误（规格 §3.3） |
| `LiveSnapshot.runningTools[].partial` | 界面重新载入时这次调用最后一次的 `partialResult`（规格 §9.2） |
| 会话文件里这次调用的工具结果 | `details`（重新打开时）；没有结果时只有参数 |
| `TeamState.holders`、角色名 | 行里的 `<Role>`：`roleLabel`，基座 `mori` 显示为 `Mori`（基座的行不写） |
| `mori.team_approval_request` / `mori.team_approval_end`（`subagent` 字段）、`LiveSnapshot.teamApprovals` | 通用 subagent 的批准卡（规格 §7.4，卡片本身见 [team-approvals.md](team-approvals.md)）；这一行的 `phase: 'approval'` |
| 你停止这次回复、后台进程退出 | v0 的已停止、已中断（tool-cards.md） |
| 界面的时钟 | 执行中的秒数每秒更新 |

## 卡片

`n` = 参数里 `tasks` 的项数；`d` = `details` 里 `phase` 为 `done`、`failed`、`stopped` 的行数。1 个时标题用单数（`Running agent`、`Ran agent`、`Run agent`）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 准备中 | `toolcall_start`、`toolcall_delta` | 标题 `Running <n> agents`（项数还取不出时 `Running agents`），状态 `Preparing…`；已经解析出的项各一行，状态空着 | 展开、收起 |
| 等待执行 | 这条回复已结束，pi 还没开始执行它（前面的调用还没完，v0） | `Running <n> agents` · `Queued`；每项一行（来自参数） | 同上 |
| 执行中 | `tool_execution_start` 之后，`tool_execution_update` | `Running <n> agents` · `<d> of <n> done · <秒数>`（例如 `1 of 3 done · 12s`）；卡片自动展开，每个 subagent 一行（见下表） | 收起；点一行展开它 |
| 结束 | `tool_execution_end`，`isError` 为假 | `Ran <n> agents` · `Done · <耗时>`；有失败或停止的行时 `Done · <k> failed · <耗时>`（停止的也算进 `<k>`，临时，走查时可以改）；结束时自动收起一次 | 展开看每一行 |
| 全部失败 | `tool_execution_end`，`isError` 为真，`details` 里每一行都是 `failed` 或 `stopped`（你没按停止） | `Ran <n> agents` · `Failed`；自动收起一次 | 同上 |
| 被拒绝（没开 subagent） | `tool_execution_end`，`isError` 为真，没有 `details` | `Run <n> agents` · `Failed · <错误第一行>`（例如 `Failed · Only mori runs here; leave role out.`）；按参数画出各行，状态空着 | 展开看行（只有 `Agent prompt`） |
| 已停止 | 你停止了这次回复（Esc 或停止按钮） | 至少开过一个时 `Ran <n> agents`，否则 `Run <n> agents`；状态 `Stopped`；还没结束的行变为 `Stopped` | 展开看行 |
| 已中断 | 后台进程退出时还没结束；或重新打开时这次调用没有结果 | `Running` 的标题改为 `Ran`/`Run`（按有没有 `details`）；状态 `Interrupted`；没结束的行 `Interrupted` | 展开看行 |
| 重新打开（已结束） | 会话文件里的工具结果与 `details` | 与结束时相同（收起；耗时不显示，同 v0） | 展开看行 |
| 界面重新载入（执行中） | `LiveSnapshot.runningTools[].partial` | 与重新载入前相同的各行，之后照常更新；秒数从 `runningTools[].startedAt` 算 | 同执行中 |

- 卡片没有 v0 的 `Input`、`Output` 两段，也没有自动放行的标签（`subagent` 这个调用本身免批准，不标 “Allowed for this session”；通用 subagent 自己的调用照权限模式，见下表“等你批准”）。
- 阶段行（v0）：执行中 `Running <n> agents <秒数>`；有 subagent 等你批准时 `Waiting for your approval`。
- 一轮结束后它随其他步骤折进 `<n> steps`（WP-14），展开那一行时它是收起的。
- 标识：卡片 `data-testid="tool-card"`（同 v0）加 `data-tool="subagent"`；每一行 `data-testid="subagent-row"`、`data-index`（从 1 起）、`data-phase`、`data-role`。

## 每个 subagent 一行

一行：`<description>`，不是基座时 ` · <Role>`，`readOnly` 时 ` · Read-only`，`toolUses` ≥ 1 时 ` · <k> tool uses`（`1 tool use`）；右边是这一行的状态。

| 这一行的状态 | 来源（`SubagentRow`） | 必须可见（右边的文字） | 可做的操作 |
| --- | --- | --- | --- |
| 开始了、还没调用工具 | `phase: 'starting'`，`note` 为空 | `Starting` | 点开看 `Agent prompt` |
| 在等模型的槽位 | `phase` 为 `starting` 或 `running`，`note` 有值 | `note` 的文字，例如 `Waiting for DeepSeek`、`Switched model: A → B · rate limited`（同 TaskBoard 规格 §12.12 的写法） | 同上 |
| 等你批准 | `phase: 'approval'`（通用 subagent 的调用在等批准卡） | `Waiting for your approval` | 在输入框上方的批准卡上回答（卡头 `<Role> · <description>`） |
| 执行中 | `phase: 'running'`，`current` 有值 | 最近一次工具调用的标题（`toolCallTitle`），例如 `Read src/capture.py`、`List src`、`Run npm test`、`Edit src/a.ts` | 点开看 `Agent prompt` |
| 正常结束 | `phase: 'done'` | `Done` | 点开看 `Agent prompt` 与 `Response` |
| 失败 | `phase: 'failed'` | `Failed · <error>`，`error` 超过 80 字符时截断加 `…`，悬停看全文 | 点开看 `Agent prompt` 与 `Response`（失败原因） |
| 被停止 | `phase: 'stopped'` | `Stopped` | 点开看 `Agent prompt` 与 `Response`（`Stopped by the user.`） |
| 中断 | 卡片已中断，这一行没结束 | `Interrupted` | 点开看 `Agent prompt` |

- 点一行展开（再点收起），展开后两段：`Agent prompt` 与 `prompt` 原文；结束了的行再有 `Response` 与 `reply`（失败、停止时是 `error`）。文字保留换行，可以选中引用
  （引用来源同工具卡的输出）。
- 反例：执行中的行不显示 `Done`；基座的行不写 ` · Mori`；没调用过工具的行不写 `0 tool uses`；结束后卡片标题不再是 `Running`；只读 subagent 的行从不显示 `Waiting for your approval`。

## 右栏

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 通用 subagent 改过文件 | 这一轮的 `mori.turn_changes`（subagent 实例的运行同样拍快照，`runAgent` 为 `{ role, task: null, self: false }`；file-system.md §4.5、§5.3） | Changes › This session 里这一轮列出它改的文件（`data-testid="turn-file"`），文件行上的 Agent（`turn-file-agents`）写它的角色名，基座写 `Mori`；没有 `team-changes-note` 那句说明 | 同 fs-changes.md 的文件行 |
| 只读 subagent，或没有 Agent 改过文件 | 这一轮没有它的 changes | 与 fs-changes.md 的 This session 相同：只读 subagent 不改文件，不出现 | — |

（2026-10-27 注：文件系统合并后这一节改写：原来两行是 `BoardView.teamEdited` 为真时列表上方的 `Changes made by other agents aren’t listed here.`（`team-changes-note`）与为假时同 v0；右栏换成 Changes › This session（[fs-changes.md](fs-changes.md)），`teamEdited` 与那句说明都去掉了，见 docs/v1/walkthrough-1026-checks.md U57。只读 subagent 的工具同通用的、按收窄 `{ write: false }` 拒绝改文件与命令（U51），所以它的行同样从不显示 `Waiting for your approval`。）
