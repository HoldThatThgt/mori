# 角色文件的拒绝启动、协作模式下的模型按钮、右栏说明

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§4.3、§4.4（启动校验与 `Check again`）、§5.1（被拒绝启动时关掉协作模式）、
§12.1、§12.11（协作模式下的模型按钮）、§13.5、§13.9（拒绝启动卡）、§13.10、§13.12（右栏）；模型层规格 [model-providers.md](../../specs/model-providers.md) §4.6、§9.2、§9.3。
补充 [model-chat.md](model-chat.md) 的拒绝启动卡与 No model available 卡、[model-menu.md](model-menu.md) 的选择范围按钮、[v0 changes.md](../../v0/screens/changes.md) 的改动列表。
标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo` 与 `mori.model_state` 里的 `ModelState` | `blocked`：`kind` 加 `agents_invalid`（优先于模型层的其他原因）；`problems: string[]`：`agents_invalid` 时卡上逐条列出的问题（`shared/models.ts`）；`actions` 加 `check_agents`（§13.9）与 `turn_off_team`（协作模式下代替 `change_model`，§12.11；`shared/models.ts`）；`pickLocked: boolean`：对话会话在协作模式下为真（§12.11） |
| `session.recheckAgents { sessionId }` 的结果 | 新的 `SessionInfo`（`ModelState`、`TeamState` 按重新读的角色），或 `error` |
| `session.setTeam { sessionId, mode: 'off' }` 的结果 | `TeamState`（`Turn off task mode` 用它） |
| `mori.model_unavailable` | 说明卡（模型层，不变） |
| `TeamState` | `mode`、`busy`（`Check again` 只在会话空闲时可用） |
| `mori.board`、`SessionInfo.board` | TaskBoard 视图：进展摘要；右栏说明的依据（字段见“需要规格回答”） |
| pi 的工具结果 | 右栏改动列表（v0：对话流里成功的 `edit`、`write`） |
| 你的操作 | `Check again`、`Turn off task mode`、点模型按钮、打开右栏 |

## 角色文件有错：拒绝启动卡

会话新建或打开时校验 `<project>/.mori/agents/*.md`（只读这一层）；任何一项不通过，会话按 `agents_invalid` 拒绝启动（§4.4）。
卡在输入框上方，与模型层的拒绝启动卡同一位置、同一样子（model-chat.md）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 角色文件有错 | `ModelState.blocked.kind` 为 `agents_invalid` | 卡的标题 `Fix the agent files`；下面 `blocked.problems` 每项一行（下表的文字，`<file>` 是相对项目根的路径，例如 `.mori/agents/planner.md`）；只有一个按钮 `Check again`（`actions` 只有 `check_agents`）；没有候选行，没有 Open settings | Check again |
| 可以看、可以打字 | 同上 | 同 model-chat.md“被拒绝启动时”：历史照常显示；输入框可以打字；发送不可用（按 Enter 不发送，草稿不丢）；要发给模型的斜杠命令随发送一起不可用 | 打字；Check again |
| 模型层重新校验 | `mori.model_state`（改了范围、配置或档案变化、探针结束） | 卡仍是 `Fix the agent files`：`agents_invalid` 优先，直到 `Check again` 通过（§4.4） | Check again |
| 通过 | 结果的 `SessionInfo`：`blocked` 不再是 `agents_invalid` | 卡消失（模型层另有原因时换成那张卡，model-chat.md）；会话从文件重新打开：对话流照会话文件重画，内容不变；模型菜单里 Task mode 一行的第二行按新的立项持有者（team-switch.md）；之后可以发送 | 发送 |
| 仍有问题 | 结果的 `SessionInfo`：`blocked.kind` 仍为 `agents_invalid` | 卡上的问题换成重新读出的那一组 | 改文件后再 Check again |
| 出错 | 结果的 `error` 不为 null，或命令没有回应 | 卡不变；按钮上方一行原文（同卡上 Verify now 失败的显示），再点卡上的按钮时消失 | 再试 |
| 会话不空闲 | `TeamState.busy` 为真 | `Check again` 不可用（§4.4“只在会话空闲时可用”），悬停 `Available when nothing is running in this session`（临时，走查时可以改） | — |
| F8 的操作记录 | `session.recheckAgents` | “最近的操作”记 `Check agent files`（§13.10） | — |

- 改了角色文件，对已经打开的会话不生效：要点 `Check again`，或 App 重启后重新打开会话（§4.3）；在侧栏重新点开它不重新读。
- 校验的是文件内容，不是“能不能选到模型”：候选在运行时选不到模型按模型层处理（§4.4 最后一条）。

卡上每个问题的一行（§4.4，原文照写；`<原文>` 是 YAML 解析的错误原文）：

| 问题 | 卡上的一行 |
| --- | --- |
| frontmatter 读不出（YAML 错误、没有 frontmatter） | `<file>: can’t read the header: <原文>` |
| 未知字段 | `<file>: unknown field "<field>"` |
| 缺 `name` 或 `description`、取值不合格 | `<file>: <field> <原因>` |
| `name` 重复 | `<file>: name "<name>" is already used by <other file>` |
| `name` 为 `mori` | `<file>: name "<name>" is reserved for the base agent` |
| `name` 像编号 | `<file>: name "<name>" looks like a task or request number` |
| 权限值不在词表 | `<file>: unknown seat "<seat>"` |
| 权限已被另一个文件认领 | `<file>: seat "<seat>" is also claimed by <other file>` |
| 工具名不认识 | `<file>: unknown tool "<tool>"` |
| 写了 TaskBoard 的工具 | `<file>: "<tool>" is added by Mori; remove it` |
| `models` 引用的名字不在模型设置里 | `<file>: "<name>" is not in your model settings (models[<i>])` |
| `requires` 不在词表、`context>=N` 的 N 不是正整数 | `<file>: unknown requirement "<req>"` |
| `differ_from` 不是 `author` | `<file>: differ_from can only be "author"` |
| `subscribe` 的时刻或过滤不在词表 | `<file>: unknown moment "<moment>"` / `<file>: unknown filter "<filter>"` |

`name` 的三种问题在 §4.4 表里写在一行（`… is already used by <other file>` / `is reserved for the base agent` / `looks like a task or request number`），本表理解为同一个前缀 `<file>: name "<name>" ` 加三种结尾。

## 协作模式下被拒绝启动：Turn off task mode

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 协作模式下对话会话被拒绝启动 | `ModelState.blocked` 不为 null，`pickLocked` 为真（模式为 `once` 或 `always`）；`blocked.actions` 里是 `turn_off_team`、没有 `change_model` | model-chat.md 的拒绝启动卡（按 `blocked.kind` 的文字与候选行），但**没有** `Change model…`，在它的位置是 `Turn off task mode`（§12.11、§5.1）；按钮照 `blocked.actions` | Turn off task mode；卡上的其他操作 |
| 协作模式下的 No model available 卡 | `mori.model_unavailable`，`pickLocked` 为真（说明卡没有 `actions`，由界面按 `pickLocked` 加） | model-chat.md 的说明卡，`Open settings` 旁多一个 `Turn off task mode`（§12.11“说明卡……改为提供 `Turn off task mode`”） | Turn off task mode；Open settings |
| 点了 Turn off task mode（拒绝启动卡） | 你的操作：`session.setTeam { mode: 'off' }`；F8 记 `Task mode off` | 直接回到 `off`，不看回到 off 的条件（§5.1）：模型按钮回到范围按钮的样子（`data-team-mode="off"`）；未关闭需求的非终态 task 变为 `stopped`，进展摘要显示 `Stopped`，需求仍在 TaskBoard 上（下次进入协作模式时立项在工作卡里看到它们）；`pickLocked` 变为假，模型按钮恢复；后台进程重新做静态校验（§12.1），卡消失或换成关闭模式下的卡（这时有 `Change model…`） | — |
| 点了 Turn off task mode（说明卡） | 同上 | 会话没有被拒绝启动，按开关的规则：满足回到 off 的条件时 `off`，否则 `once`（team-switch.md；见“需要规格回答”） | — |
| 回到 off 之后 | `ModelState`（`pickLocked: false`） | 范围按钮显示的范围是你最后选的（协作模式不写 `mori.pick`，§12.11） | 改范围 |

## 协作模式下的模型按钮

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
2026-10-26 负责人走查 M10、M21（WP-09）起：按钮显示“Task mode · <模型 id>”、仍能打开菜单；按钮上的模式见 [team-switch.md](team-switch.md)“模型按钮上的模式”，菜单见 [model-menu.md](model-menu.md)“协作模式的菜单”。原来的“只显示模型 id、没有 ▾、打不开菜单、没有当前模型时 `No model`”都去掉了。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 锁定 | `ModelState.pickLocked` 为真 | 输入框下面一行原来范围按钮的位置（同样的最窄宽度和截短，v0 models.md“窄栏”）：“Task mode · <当前模型 id>”和 ▾，`data-locked="true"`；悬停第二行 `Task mode picks the model for each agent`；打开的菜单只有同一句说明、Task mode 一行、“Manage agents”（2026-10-26 加，依据负责人 2026-10-26 批准的 Customize › Agents 规格：customize-agents.md §6.6 与 §0“已定的”第 4 条“Manage agents 在模型菜单里一直显示”）和“Manage models”（§12.11） | 打开菜单；关掉 Task mode；Manage agents；Manage models |
| 锁定、没有当前模型 | `pickLocked` 为真，`current` 为 null（被拒绝启动） | 按钮文字“Task mode”（临时，走查时可以改），悬停同上 | 同上 |
| 锁定、准备中或生成中 | 同上 | 悬停仍是这两行（不加“Can’t switch models until the response finishes”，临时，走查时可以改）；菜单照常能打开 | 同上 |
| 段内换了模型 | `mori.model_state` | 按钮里的模型 id 换成新模型的 | — |
| 当前模型从哪来 | §12.1 | 协作模式下对话会话按对话持有者的 `models` 选（基座、没写 `models` 的角色按会话的范围），按钮显示的就是它选到的 | — |
| 解锁 | `pickLocked` 变为假（回到 `off`） | 恢复 model-menu.md 的样子（“<范围名> · <当前模型 id>”和 ▾），范围是你最后选的 | 打开菜单 |
| 思考强度按钮 | §12.11 | 不变：协作模式下照常可用（准备中、生成中不可用，同 model-menu.md），只作用于对话会话 | 打开菜单 |

## 右栏：后台改动的说明

“本会话的改动”只列对话流里的编辑与写入（v0 不变）；后台实例改的文件不在其中（§0、§13.12）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有实例改过文件、列表不空 | TaskBoard 上有实例、或普通模式的 subagent（[subagent 规格](../../specs/subagent.md) §7.6）做过成功的 `edit`、`write`（字段见“需要规格回答”）；对话流里也有编辑或写入 | 列表上方一行 `Changes made by other agents aren’t listed here.`；其下是 v0 的“只含编辑和写入，命令改动的文件不在此列。”和列表（两行的先后临时，走查时可以改） | 同 v0 |
| 有实例改过文件、列表为空 | 同上；对话流里没有编辑或写入 | 只显示 `Changes made by other agents aren’t listed here.`，**不显示**“本会话还没有改动” | 关闭 |
| 没有 TaskBoard，或实例没改过文件 | — | 与 v0 相同 | 同 v0 |
| 右栏自动打开 | v0：本会话第一次出现编辑或写入结果时（对话流的工具卡） | 后台实例改文件不会让右栏自动打开（它不在对话流里） | — |

## 反例

- `agents_invalid` 的卡上没有 `Open settings`、`Change model…`，只有 `Check again`。
- 被 `agents_invalid` 拒绝启动的会话按 Enter 不发送，草稿不丢。
- 协作模式下点模型按钮不打开菜单；拒绝启动卡上没有 `Change model…`。
- 协作模式不改你选的范围：回到 `off` 后范围按钮仍是协作模式之前的范围。
- 实例会话（立项、结案、task、临时提问、订阅）的拒绝启动与说明卡不出现在界面上（实例的事件不转给界面，§8.2）；它们的结果在进展摘要里（例如 `Mori: no model`）。
- 后台实例改的文件不出现在“本会话的改动”里。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：Check again 出错时按钮上方一行原文；会话不空闲时 `Check again` 的悬停；
`name` 三种问题的完整写法；`Turn off task mode` 在拒绝启动卡上占 `Change model…` 的位置、在说明卡上放在 `Open settings` 旁；
锁定的模型按钮“Task mode · <模型 id>”（2026-10-26 前只写模型 id、不带 ▾），没有当前模型时“Task mode”，锁定时悬停不随生成中改变；右栏两行说明的先后。

## 需要规格回答

规格 §4.4、§13.9、§16 没定、`shared/models.ts` 已经定下的：问题列在 `ModelBlocked.problems`；`Turn off task mode` 是动作 `turn_off_team`，由后台进程放进 `actions`
（§16 只列了 `check_agents`，规格应补上）。

1. **说明卡上的 `Turn off task mode` 是否直接回到 `off`**：§5.1 的“不看回到 off 的条件”只说对话会话被拒绝启动时；说明卡出现时会话没有被拒绝启动。
   本表按开关的规则（可能变为 `once`）；如果要直接回到 `off`，需要规格写明。
2. **右栏说明的依据**：§13.12 的条件是“TaskBoard 上有实例做过成功的 `edit`、`write`”，但 `BoardView`、`TaskView` 里没有这个信息（`authorFamilies` 不在视图里）。
   需要 `BoardView` 加一个字段（例如“有实例改过文件”的布尔值）。
3. **`agents_invalid` 而模式不是 `off`**：重新打开一个最后一条 `mori.team` 为 `always` 的会话、角色文件又有错时，`pickLocked` 是否为真、卡上是否也有 `Turn off task mode`，规格没说。
   本表按 §4.4、§13.9：`agents_invalid` 的卡上只有 `Check again`。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 拒绝启动卡 | `[data-testid="blocked-card"][data-kind="agents_invalid"]`（沿用 model-chat.md，`data-kind` 为 `blocked.kind`） |
| 卡上的问题 | 每行 `data-testid="agent-problem"`（本表定，临时） |
| Check again | 卡上 `data-action="check-agents"`（动作 `check_agents`，`_` 换成 `-`，同 model-chat.md 的写法） |
| Turn off task mode | 拒绝启动卡与说明卡上 `data-action="turn-off-team"`（动作 `turn_off_team`，同上） |
| 模型按钮 | `data-testid="model-button"`（沿用 v0），锁定时 `data-locked="true"`（本表定，临时；2026-10-26 起锁定时能打开菜单，不再 `aria-disabled`），`data-team-mode` 见 team-switch.md |
| 右栏说明 | `data-testid="team-changes-note"`（§13.12）；改动列表 `data-testid="changes"`（沿用 v0） |
