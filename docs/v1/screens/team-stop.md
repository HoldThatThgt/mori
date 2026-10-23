# 待判断的消息、阶段行与停止

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§5.3（协作模式下一条消息怎么走、待判断队列、撤回）、
§5.6（程序投递在停止时）、§9.4（停止原因）、§11.4（停止对话的回复与 `Stop team`）、§11.5（归档、删除与关闭）、§11.6、§13.6（阶段行与停止）、§13.10。
补充 [v0 chat.md](../../v0/screens/chat.md) 的排队区、输入框与停止，[model-chat.md](model-chat.md) 的准备中，[v0 sessions.md](../../v0/screens/sessions.md) 的状态与归档删除。
与 english-ui 合并后（2026-10-21）v0 的文字按 [v0/ui-strings.md](../../v0/ui-strings.md) 的英文；下文引号里的中文是原来的叫法，界面上显示：
停止 = Stop，发送 = Send，排队 = Queue / Queued，插话 = Steer，撤回 = Withdraw，已停止 = Stopped，
已停止 · 已经做出的修改不会自动撤销 = Stopped · Changes made so far stay as they are，生成中 = Running，正在生成 = Responding…。
标了“（临时，走查时可以改）”的是规格没给、本表定的。

本表的“分开时”指对话与立项由不同角色持有（例如 `chat` 与 `planner`）；“合并会话”指同一个角色持有两者（没有角色文件、只有 `executor.md` 时都是，§1）。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.team_deciding` 事件 | `{ role, since: number \| null, queue: { text, behavior }[] }`：`since` 为正在判断的那条开始判断的时刻（null 时没有在判断）；`queue` 是待判断、还没交给对话的消息，按发送顺序，**含正在判断的那条**（`shared/team.ts`）；`behavior` 是你发送时按的 Ctrl+Enter（`steer`）/ Enter（`followUp`），对话空闲时直接发出的为 null |
| `SessionInfo.deciding`、`LiveSnapshot.deciding` | 待判断的消息 `{ text, behavior }[]`（打开会话、界面重新载入后接上） |
| `TeamState`（`SessionInfo.team`、`mori.team_state`） | `mode`、`holders`（`<create role>`）、`busy`（任何 Agent 在运行或排队，或有待判断的消息） |
| `LiveStatus.teamBusy`、`LiveStatus.teamApproval` | 侧栏里没在中栏显示的会话的状态（§13.10）；`shared/protocol.ts` 把 `teamBusy` 定为“对话自己的运行之外还有 Agent 在运行或排队，或有待判断的消息”，对话自己的运行仍是 `running` |
| `mori.prompt_error` | 模型层的字段（`message`、`text`、`queued`、`running`）；协作模式下 `queued` 带回待判断的消息（§11.4） |
| `session.clearQueue` 的结果 | 加 `texts: string[]`：撤回的文字（协作模式下含待判断队列里还没开始判断的，§13.10） |
| `session.abort`、`session.stopTeam` | 停止对话的回复（不变）；停止这个用户会话的全部 Agent（结果 —） |
| pi 的 `queue_update`、`agent_start`、`agent_settled`、`message_start` | 同 v0 |
| `mori.board`、`mori.team_approval_end` | Stop team 之后的 task 状态与批准卡 |
| `session.close` 的结果 | 归档、删除前关闭会话；正在生成时被拒绝（§11.5） |
| 你的操作 | 发送（Enter / Ctrl+Enter）、撤回、Esc、停止、`Stop team`、右键菜单 |

`<create role>` 取 `TeamState.holders.create`（`mori.team_deciding.role` 相同），基座显示为 `Mori`。

## 协作模式下发一条消息（分开时）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 对话空闲时发出 | `session.prompt`；`mori.team_deciding`（`since` 不为 null） | 你的消息照模型层的准备中先显示在对话流里（待发，model-chat.md）；会话按“发送中”显示，侧栏“生成中”，“停止”可用；输入框下面一行的范围按钮与 Effort 按钮不可用（准备中）；阶段行 `<create role> is deciding… · 4s`（下节） | 停止（Esc）；继续发消息（进排队区，下一行） |
| 对话在回复或准备中时发出 | `session.prompt`（Enter 记为排队，Ctrl+Enter 记为插话）；`mori.team_deciding.queue` | 排队区里一行，种类写 `Waiting for <create role>`（取代“排队”“插话”的位置），后面是消息原文；多条按发送顺序 | 撤回 |
| 立项判断完，对话空闲 | `mori.team_deciding` 不再列它；随后模型层与 pi 的事件 | 对话以这条消息开始回复（准备中继续：阶段行换成模型层的等待，或不显示）；有回执时回执紧跟在这条消息之后（team-stream.md） | 停止 |
| 立项判断完，对话正在回复 | pi 的 `queue_update` | 排队区这一行的种类从 `Waiting for <create role>` 变为“排队”（Enter）或“插话”（Ctrl+Enter），之后同 v0；pi 送进这条消息时它进对话流，回执紧跟在它后面 | 撤回（同 v0） |
| 立项判断完，对话在为另一条消息准备中 | 模型层的暂存（§5.3 第 4 步） | 这一行变为准备中暂存的项（“排队”，`data-pending`，排在那条之后；Ctrl+Enter 也按排队，model-chat.md） | 暂存期间不能撤回（model-chat.md） |
| 立项在忙别的回合 | `mori.team_deciding`：`since` 为 null，`queue` 不为空（立项在跑程序唤醒的回合，§5.3 第 2 步“立项空闲时取队首”） | 消息仍在排队区标 `Waiting for <create role>`，或作为待发消息显示在对话流里（对话空闲时发出的）；阶段行 `<create role> is deciding…`，不带秒数（临时，走查时可以改） | 停止；撤回 |
| 合并会话 | 没有 `mori.team_deciding` | 同 v0 与模型层：空闲时准备中、回复中排队或插话；没有 `<create role> is deciding…`，没有 `Waiting for …` 的行（判断就在对话自己的回复里，§5.3） | 同 v0 |
| 以 `/` 开头的 pi 扩展命令 | 后台进程认出扩展命令（§5.3） | 照 v0 直接交给对话，不进待判断队列，没有 `Waiting for …` | 同 v0 |
| 提示词模板、技能命令 | §5.3 | 与普通消息一样先经立项：排队区、待发气泡里是你输入的原文（例如 `/review src/a.ts`） | 同上 |

## 阶段行

| 文字 | 开始于 | 结束于 |
| --- | --- | --- |
| `<create role> is deciding… · 4s` | 分开时、对话还没在运行（准备中）、`mori.team_deciding` 的 `since` 不为 null；秒数从 `since` 起算，每秒刷新（写法同 model-chat.md 的“<文字> · 12s”） | 下一个 `mori.team_deciding`（`since` 为 null）；模型层的等待开始（`mori.model_wait`、`mori.model_queue`）；pi 开始运行；停止 |
| 对话自己的阶段 | 对话在回复时（v0、model-chat.md） | 同 v0 |

- 这就是模型层准备中的阶段行，换了文字（§13.6），标识同为 `stage`。
- 对话在回复、立项同时在判断排队的消息时，阶段行显示对话自己的阶段，不显示 `is deciding`。
- 合并会话不显示（那就是对话自己的回复）。

## 排队区（协作模式）

排队区 = pi 的插话、排队消息 + 待判断队列里还没交给对话的消息，按发送顺序（§5.3）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有待判断的消息 | `mori.team_deciding.queue`（已作为待发消息显示在对话流里的那一条除外） | 每条一行：`Waiting for <create role>` 加原文 | 撤回 |
| 撤回 | 你点了“撤回”：`session.clearQueue`，结果的 `texts` | pi 排队区的消息和待判断队列里**还没开始判断**的消息撤回，按发送顺序（空行分隔）放回输入框、在已有草稿之前（同 v0）；**正在判断的那一条不撤回**，仍在排队区标 `Waiting for <create role>`；已经被立项写进需求的消息，它的回执与 `mori.progress` 写在对话流末尾（team-stream.md） | 编辑后再发 |
| 只剩正在判断的那一条 | `mori.team_deciding`：`queue` 只有它，`since` 不为 null | “撤回”不可用（没有可以撤回的，临时，走查时可以改） | — |
| 界面重新载入 | `LiveSnapshot.deciding` | 待判断的消息按发送顺序显示在排队区，标 `Waiting for <create role>`（重新载入后不区分哪一条曾作为待发消息显示在对话流里，临时，走查时可以改）；之后随 `mori.team_deciding` 更新 | 撤回 |
| 程序投递 | §5.6 | `[Mori]` 消息从不出现在排队区 | — |

## 停止对话的回复（Esc、停止按钮）

对话正在回复或在准备中时，在用户会话那一栏按 Esc（没有浮层、焦点不在批准卡上，v0 的 Esc 顺序）或点“停止”（§11.4）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 对话在为待判断的消息准备中（立项在判断它） | `session.abort`；`mori.prompt_error`（`message` 为 “Stopped before sending”，`text` 为这条消息，`queued` 为其余待判断的与 pi 排队的消息，`running: false`） | 同 model-chat.md“准备中按了停止”：你的消息从对话流撤回，排队区清空，文字按发送顺序（空行分隔）放回输入框；没有错误卡，不加“已停止” | 编辑后再发 |
| 对话正在回复 | `session.abort`；`agent_settled`；`mori.prompt_error.queued`（正在判断的、待判断的其余消息、pi 排队区的消息，§11.4） | v0 的“已停止 · 已经做出的修改不会自动撤销”；排队区清空；这些文字按发送顺序放回输入框（在已有草稿之前）；立项已经写入的，回执与 `mori.progress` 写在对话流末尾 | 编辑后再发 |
| 停止之后 | §11.4 | 不会因为一次判断结束而开始新的对话回复 | — |
| 后台照常 | `mori.board` | task 实例、结案、订阅照常运行，进展摘要照常更新；后台批准卡照常挂着（team-approvals.md）；`Stop team` 仍在（下节） | `Stop team` |
| 排着的程序投递 | §5.6、§11.4 | 停止后照常开始：例如需求关闭的汇报——对话流里出现一条新的回复，上面没有你的消息（不显示的投递，team-stream.md） | 再按 Esc 停止它 |
| 合并会话里停止了程序唤醒的立项回合 | §11.4 | 它不重新开始；唤醒它的 task 进展摘要仍是 `Waiting for <create role>` | — |
| 对话空闲、只有后台在运行 | `TeamState.busy`，对话没在运行 | Esc 什么都不停（同 v0“正在生成时才停止”）；输入框显示“发送”，旁边是 `Stop team` | 发送；`Stop team` |

## Stop team

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 显示 | `TeamState.busy` 为真，且不只是关闭模式下对话自己在回复（下面“需要规格回答”第 1 条） | 输入框的“停止”按钮旁一个按钮 `Stop team`，悬停 `Stop all agents in this session`（§11.4）；对话空闲时它在“发送”按钮旁（临时，走查时可以改）；输入框照常可以发送 | 点击 |
| 不显示 | `busy` 为假；或模式为 `off`、只有对话自己在回复 | 没有这个按钮（没有角色文件、没用过协作模式的会话与 v0 相同） | — |
| 点了 Stop team | 你的操作：`session.stopTeam`；F8 记 `Stop team` | 不确认（规格没有要求，临时，走查时可以改）；全部 Agent 停止：对话、立项、结案、task 实例、临时提问、订阅（§11.4） | — |
| 停止之后：批准卡 | `mori.team_approval_end` / `mori.approval_end`（拒绝，由停止决定） | 全部批准卡消失 | — |
| 停止之后：待判断的消息 | `mori.prompt_error.queued`（见“需要规格回答”第 2 条） | 待判断的消息和 pi 排队区的消息按发送顺序放回输入框，排队区清空；对话在准备中的那条待发消息撤回 | 编辑后再发 |
| 停止之后：task | `mori.board` | 运行中、排队中的 task，以及交给结案而结案正在处理或排队的 task，进展摘要显示 `Stopped`；需求状态 `Stopped`（team-stream.md） | — |
| 停止之后：对话流 | 对话在回复时：它的 `agent_settled`；对话空闲时：`session.stopTeam` 返回（你的操作） | 末尾一行 v0 的“已停止 · 已经做出的修改不会自动撤销”，只有一行（对话被停止时就是它那一行，临时，走查时可以改） | — |
| 停止之后：按钮与状态 | `mori.team_state`（`busy` 为假） | `Stop team` 消失；侧栏“生成中”消失 | — |
| 之后 | §11.4 | 不自动重新开始任何 task；需求仍开着；模式不变（`once` 仍是 `Team: Until done`）；你的下一条消息照常先到立项，它可以交回已停止的 task | 发消息 |

## 回到输入框的文字

都按发送顺序、空行分隔，放在已有草稿之前（同 v0）。

| 操作 | 回到输入框的 |
| --- | --- |
| Esc / 停止，对话在为待判断的消息准备中 | 这条消息、其余待判断的消息、pi 排队区的消息 |
| Esc / 停止，对话正在回复 | 正在判断的、其余待判断的、pi 排队区的消息 |
| 撤回 | pi 排队区的消息、待判断队列里还没开始判断的消息（正在判断的那条留下） |
| `Stop team` | 全部待判断的消息、pi 排队区的消息 |
| 程序投递（`[Mori]`）被停止、选不到模型 | 不回到输入框（`text` 为 null，§5.6） |

## 侧栏状态

| 文字 | 来源 | 消失于 |
| --- | --- | --- |
| 等你批准 | 对话自己的卡，或后台批准卡（team-approvals.md） | 卡都结束 |
| 生成中 | `TeamState.busy`（这个会话有任何 Agent 在运行或排队，或有待判断的消息）；没在中栏显示的会话用 `LiveStatus.running` 或 `LiveStatus.teamBusy`（§13.6） | `busy` 为假；后台进程退出 |

- 只有后台在运行（对话空闲）时会话行也是“生成中”（TB-54）。
- “有新结果”仍按 v0（对话的 `agent_settled`）。

## 归档、删除与关闭

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 正在生成 | `TeamState.busy`（或 `LiveStatus.teamBusy`）：任何 Agent 在运行、或有待判断的消息（§11.5） | 右键菜单里“归档”“删除”不可用，旁边小字“正在生成”（v0 文字）；只有后台在运行时也是这样 | 重命名；先 `Stop team` |
| 后台进程拒绝 | 仍有归档、删除送到（例如界面状态还没更新）：`session.close` 返回 `error` | v0 的“归档失败：<原文>”/“删除失败：<原文>”，会话不变 | 再试 |
| 删除 | 主进程删除会话文件之后，按会话文件第一行里的 id 一并永久删除 `<userData>/teams/<id>/`（§11.5） | 同 v0 的“已删除” | — |
| 归档 | §11.5 | 同 v0；`teams/<id>/` 不动，恢复后 TaskBoard、回执、进展摘要都在 | — |

## 反例

- Esc 不停后台：停止对话回复后 task 实例照常运行，后台批准卡不被拒绝。
- 停止对话回复后，立项判断完一条消息也不会开始新的回复。
- `Stop team` 之后合成端点没有新的请求，不自动重新开始任何 task（TB-35）。
- 正在判断的那条消息不随“撤回”回到输入框。
- 待判断的消息不显示为“排队”或“插话”，判断完才变。
- 只有后台在运行时，会话不能归档或删除。
- 没有角色文件、没用过协作模式的会话里，生成时没有 `Stop team`。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：立项在忙别的回合时阶段行不带秒数；只剩正在判断的消息时“撤回”不可用；
重新载入后待判断的消息都显示在排队区；对话空闲时 `Stop team` 在“发送”旁；`Stop team` 不确认；
`Stop team` 之后对话流只有一行“已停止”；`Stop team` 的显示条件（下面第 1 条）。

## 需要规格回答

1. **`Stop team` 什么时候显示**：§11.4 写“有任何**后台** Agent 在运行或排队时”，§13.10 的 `TeamState.busy` 却包括对话自己的运行，注释说停止按钮用它。
   照 `busy` 显示，关闭模式下每次普通回复都会出现 `Stop team`（没用过协作模式的会话也是，与 TB-03“与 v0 一致”冲突）；打开着的会话又没有字段知道后台是否在运行
   （临时提问实例、结案会话是否在跑都不在 `BoardView` 里）。`shared/protocol.ts` 的 `LiveStatus.teamBusy` 已经是“对话以外”的意思，但它只在会话列表的 `live` 里。
   本表用 `busy` 为真且不是“模式为 `off`、对话自己在回复”；建议 `TeamState` 也带一个与 `LiveStatus.teamBusy` 同义的字段，`Stop team` 按它显示。
2. **`Stop team` 时待判断的消息怎样回到输入框**：`session.stopTeam` 的结果是 —，§11.4 只说“回到输入框”。本表按 Esc 的做法理解为 `mori.prompt_error.queued`；
   也可以让 `session.stopTeam` 像 `session.clearQueue` 一样返回 `texts`。
3. **重新载入后的阶段行**：`LiveSnapshot.deciding` 只有 `{ text, behavior }[]`，没有 `since` 和哪一条正在判断，重新载入后到下一个 `mori.team_deciding` 之前
   阶段行写不出秒数，排队区也分不出正在判断的那一条（撤回时它不回来）。建议快照里也带 `mori.team_deciding` 的 `since`。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| Stop team | `data-testid="stop-team"`（§13.6） |
| 阶段行 | `data-testid="stage"`（沿用 v0）；立项判断时 `data-kind="deciding"`（本表定，临时；与 model-chat.md 的 `wait-model` 等并列） |
| 排队区 | `data-testid="queue"`（沿用 v0）；待判断的项带 `data-deciding="true"`（本表定，临时）；准备中暂存的项 `data-pending="true"`（model-chat.md） |
| 侧栏状态 | `[data-testid="session-status"]`，`data-status` 为 `running` / `approval`（沿用 v0） |
| 右键菜单 | `data-testid="session-menu"`（沿用 v0） |
