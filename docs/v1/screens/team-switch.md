# 协作开关与 `/task`

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§5.1（模式、回到 off 的条件、`/task` 的识别、模式提示）、
§5.3（协作模式下一条消息的走法）、§12.11（协作模式下的模型按钮）、§13.1（开关）、§13.10（进程桥）、§13.11（模式提示）、§15（窄栏宽度、命令名）。
命令 2026-10-26 由 `/team` 改为 `/task`（负责人走查 M21，没有别名）；同一天加了对话流里的模式提示（M13，下面“对话流里的模式提示”）。
补充 [v0 chat.md](../../v0/screens/chat.md) 的顶栏与输入框。消息发出之后的待判断、排队区与停止见 [team-stop.md](team-stop.md)；
回执与进展摘要见 [team-stream.md](team-stream.md)；模型按钮锁定与 `Turn off team mode` 见 [team-blocked.md](team-blocked.md)。
标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo.team`（`session.create`、`session.open`、`session.recheckAgents` 的结果；界面重新载入后接上会话的 `LiveSnapshot.team`） | `TeamState`：`mode`（`off` / `once` / `always`）、`holders`（`dialog`、`create`、`close` 的角色名）、`roles`、`busy` |
| `mori.team_state` 事件 | 同上；模式在后台进程里改变时发出（开关、`/task`、`once` 自动回到 `off`、带 `team: 'once'` 的发送） |
| `mori.team_mode` 事件 | `{ mode }`：与同一时刻写下的 `mori.team` 条目对应（§13.10），对话流里加一行模式提示 |
| `session.setTeam { sessionId, mode: 'on' \| 'off' }` 的结果 | `TeamState`，或 `error` |
| `session.prompt` 加 `team: 'once'` | `/task <文字>` 发出的消息（结果不变） |
| 会话文件的 `mori.team` 条目 | 每条在对话流里是一行模式提示（§13.11，重新打开时）；后台进程重新打开会话时取最后一条作为 `mode`，开关只看 `SessionInfo.team` |
| 界面的准备状态 | 会话是否已打开、后台进程通道是否接上、后台进程是否退出（v0 chat.md“后台正在启动”“后台进程退出”） |
| 你的操作 | 点开关；在输入框里输入 `/task on`、`/task off`、`/task <文字>`、`/task` 后按 Enter |

`<create role>` 取 `TeamState.holders.create`；基座（`mori`）显示为 `Mori`（规格 §1、§5.3），其他角色显示角色名原文。

## 协作开关

位置：顶栏右边一组的第一个，在右栏开关（“Toggle changes”）之前（§13.1；2026-10-22 composer-pickers 合入后顶栏只有会话名和这一组，
模型、思考强度、权限按钮在输入框下面一行；team-checks #7）。
分屏时每一栏各有一个，作用于这一栏的会话（与模型按钮相同）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关闭 | `TeamState.mode` 为 `off`（新会话、没有 `mori.team` 条目的会话都是） | `role="switch"`，`aria-checked="false"`，文字 `Team: Off`，悬停 `Turn on team mode` | 点击：`session.setTeam { mode: 'on' }` → 一直打开 |
| 一直打开 | `mode` 为 `always` | `aria-checked="true"`，文字 `Team: On`，悬停 `Messages go to <create role> first` | 点击：`session.setTeam { mode: 'off' }` → 关闭，或不能回到 `off` 时变为做完为止（下表） |
| 做完为止 | `mode` 为 `once` | `aria-checked="true"`，文字 `Team: Until done`，悬停 `Team mode ends when open requests are done` | 点击：`session.setTeam { mode: 'on' }` → 一直打开 |
| 界面没准备好 | 会话还在打开（“正在启动…”）、后台进程通道没接上、后台进程已退出 | 开关可见、不可用；文字按最后知道的 `mode`（还没打开过时 `Team: Off`） | — |
| 正在生成 | 对话在回复或准备中，或后台有 Agent 在运行（`TeamState.busy`） | 开关照常可用（§13.1“运行中可以点”） | 点击；只影响之后发出的消息，正在进行的回合按它开始时的模式跑完（§5.1） |
| 切换中 | 你点了开关，`session.setTeam` 还没返回 | 开关保持原来的文字、不可用（临时，走查时可以改） | — |
| 已切换 | `session.setTeam` 返回 `TeamState`，或随后的 `mori.team_state` | 文字、`aria-checked`、`data-mode` 按新的 `mode`；对话流里加一行模式提示（下面“对话流里的模式提示”）；模型按钮随 `mori.model_state` 的 `pickLocked` 锁定或恢复（team-blocked.md） | — |
| 切换失败 | `session.setTeam` 返回 `error` | 开关回到原来的模式；开关下方一行 `Couldn’t change team mode: <原文>`，下次点开关或 10 秒后消失（临时，走查时可以改，写法同 model-menu.md 的“切换失败”） | 再点 |
| 不需要确认 | — | 三种点击都不弹确认框（§13.1） | — |

### 点击之后模式怎么变

| 点之前 | 条件 | 点之后 | 来源 |
| --- | --- | --- | --- |
| `off` | — | `always` | `session.setTeam { mode: 'on' }` 的结果 |
| `always` | 满足回到 off 的条件：没有未关闭的需求、待判断队列为空、立项没有在判断的消息（§5.1） | `off` | `session.setTeam { mode: 'off' }` 的结果 |
| `always` | 三项中任何一项不满足 | `once`（这些需求照常做完；要停下按 `Stop team`，见 team-stop.md） | 同上 |
| `once` | — | `always` | `session.setTeam { mode: 'on' }` 的结果 |
| `always` 或 `once`，对话会话被拒绝启动（`ModelState.blocked` 不为 null） | 不看回到 off 的条件 | `off`；未关闭需求的非终态 task 变为 `stopped`，进展摘要显示 `Stopped`（§5.1；拒绝启动卡上的 `Turn off team mode` 同样，见 team-blocked.md） | `session.setTeam { mode: 'off' }` 的结果，随后的 `mori.board` |

### 不经开关的变化

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `/task <文字>` 进入做完为止 | 模式为 `off` 时发出带 `team: 'once'` 的消息；`mori.team_state` | 开关变为 `Team: Until done`；对话流里你的消息之前一行 `Task mode on until done`；模式为 `always`、`once` 时不变 | — |
| 做完为止自动结束 | 满足回到 off 条件的那个对话回合结束时（§5.1、§5.3 第 6 步），`mori.team_state` 的 `mode` 为 `off` | 开关变为 `Team: Off`；对话流末尾一行 `Task mode off` | — |
| 重新打开会话 | `session.open` 的 `SessionInfo.team.mode`（最后一条 `mori.team` 条目，没有条目时 `off`） | 开关按它显示，例如关闭前是 `Team: On`，重新打开仍是 `Team: On` | — |
| 界面重新载入（Ctrl+R） | `LiveSnapshot.team` | 同上；后台进程里的模式不变 | — |
| `Check again` 通过 | `session.recheckAgents` 返回的 `SessionInfo.team` | 按新的 `TeamState`（悬停里的 `<create role>` 按新的持有者） | — |

## 窄栏

会话面板不宽于 600px（§15）时开关只显示状态点。2026-10-22 composer-pickers 合入后顶栏只有“项目名 › 会话名”、开关、
右栏开关和分屏时的“Close pane”（v0 [chat.md](../../v0/screens/chat.md)“顶栏”）；阈值按会话名能用的宽度定（会话名很长、
项目名收到 40px）：开关在 App 里量到的宽是 `Team: Off` 66px、`Team: On` 66px、`Team: Until done` 105px、状态点 19px，
加上 8px 间距（≤ 400px 时 4px）。分屏一栏会话名 ≈ 栏宽 − 175px − 开关，单栏 ≈ 栏宽 − 153px − 开关（≤ 400px、≤ 320px 另算，
见 chat.md）。完整的 `Team: Until done` 在 601px 分屏还给会话名留约 315px，和 1280 宽分屏（约 510px）只有状态点时的 307px
差不多（App 里量到的，460px 258px、370px 193px、280px 173px，见 v0 chat.md“顶栏”）；再窄就让开关先让地方。这个阈值也是输入框下面一行发送组只剩图标的一档（v0 models.md“窄栏”）。
（合入前是 860px：那时顶栏还有模型、思考强度、权限按钮和上下文用量，每档刚过阈值时只剩约 8–25px。）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 窄栏 | 这一栏的宽度不大于 600px | 开关只显示一个状态点（约 19px 宽，§13.1），没有文字：`off` 为空心点，`always`、`once` 为实心点，打开时按钮用强调色（临时，走查时可以改）；读屏名称仍是完整文字 `Team: Off` / `Team: On` / `Team: Until done`，悬停同宽栏 | 同宽栏 |
| 宽栏 | 大于 600px | 完整文字，没有状态点（临时，走查时可以改） | — |
| 顶栏其余部分 | 同上 | 顶栏的样子按 v0 chat.md“顶栏”（项目名先收短到 40px 再截会话名、≤ 400px 两个图标按钮 28px、≤ 320px 不显示项目名），开关只是右边一组多一项；不溢出不裁切。合入前为放下状态点加的两处收紧（面包屑至少 105px、分屏窄栏的按钮间距 6px / 2px 与图标按钮 28px / 24px）已去掉 | 顶栏的按钮都照常可以点 |

## 对话流里的模式提示

每次模式改变，对话流里一行（§5.1、§13.11，2026-10-26，负责人走查 M13：原来什么都不显示，关掉之后你和模型都不知道）。照 Claude 的 `Fast mode on` / `Fast mode off`；写法同其他提示行（`notice`，居中的灰色小字，与 `Compacted session` 一样）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 一直打开 | `mori.team_mode { mode: 'always' }`，或会话文件里 `mode` 为 `always` 的 `mori.team` 条目 | 一行 `Task mode on` | — |
| 做完为止 | `mode: 'once'`（`/task <文字>`；关掉时还有未关闭的需求） | 一行 `Task mode on until done` | — |
| 关闭 | `mode: 'off'`（关掉开关、`/task off`、做完为止自动结束、被拒绝启动时关掉） | 一行 `Task mode off` | — |
| 位置：空闲时改 | 事件到达时 | 对话流末尾 | — |
| 位置：回复中改 | 后台进程等当前这条助手消息结束才写条目、发事件（§5.1） | 这条助手消息之后；同一轮回复之后的部分接在提示下面（提示不结束一轮，回复操作行照旧在这一轮最后） | — |
| 位置：`/task <文字>` 进入 | 条目在这条消息交给 pi 之前写下 | 准备中先显示的你的消息之前（实时与重新打开相同） | — |
| 连着两次改变 | 例如回复中关掉（先 `once`），这一回合结束回到 `off` | 两行都显示，不合并 | — |
| 重新打开 | 会话文件里的 `mori.team` 条目 | 与实时相同的位置与文字 | — |
| 没用过协作模式 | 没有 `mori.team` 条目 | 没有这一行（TB-03） | — |

## 输入框里的 `/task`

识别在界面里、对你输入的原文做：在引用芯片拼进消息之前，所以输入框里有引用芯片时也能用（§5.1）。
Mori 的 `/task` 优先于同名的 pi 提示词模板（技能是 `/skill:<name>`，不受影响）；`/task` 不列在“/”补全里（[v0 slash.md](../../v0/screens/slash.md)）。`/team` 不再是命令（没有别名）：`/team …` 照普通消息发出。

| 输入（按 Enter 时的原文） | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `/task on`（不区分大小写，前后可以有空白） | 你的操作 | 不发消息：发 `session.setTeam { mode: 'on' }`，输入框的文字清空；开关按结果变化（上表）；排队区没有变化，对话流不加你的消息，模式变了时加一行模式提示（见“对话流里的模式提示”） | — |
| `/task off`（同上） | 你的操作 | 不发消息：发 `session.setTeam { mode: 'off' }`，输入框的文字清空；结果是 `off` 或 `once`（上表“点击之后模式怎么变”）；排队区没有变化，对话流不加你的消息，模式变了时加一行模式提示（见“对话流里的模式提示”） | — |
| `/task <文字>`（`/task ` 后面有非空白的文字） | 你的操作 | 去掉 `/task ` 前缀，以 `session.prompt { team: 'once' }` 发出（引用芯片照常拼进消息）；对话流里你的消息不带 `/task `；之后照协作模式的走法（team-stop.md）；模式为 `off` 时开关变为 `Team: Until done` | — |
| 只有 `/task`（后面没有文字或只有空白） | 你的操作 | 不发送，输入框不变（文字、芯片都在） | 继续编辑 |
| 生成中输入 `/task on`、`/task off` | 对话在回复或准备中 | 同上：不进排队区，不插话，Enter 和 Ctrl+Enter 都按命令处理 | — |
| 生成中输入 `/task <文字>` | 同上 | 按你按的键记下 Enter（排队）或 Ctrl+Enter（插话），消息进待判断队列（分开时）或照常排队、插话（合并会话），见 team-stop.md | — |
| 被拒绝启动时输入 `/task on`、`/task off` | `ModelState.blocked` 不为 null（发送不可用） | `/task on`、`/task off` 不发消息，照样执行（§5.1：被拒绝启动时 `/task off` 直接回到 `off`）；`/task <文字>` 与其他消息一样不发送、草稿不丢 | — |
| 界面没准备好 | 同开关 | 与普通发送一样不可用（Enter 不起作用） | 打字 |
| F8 的操作记录 | `session.setTeam` | “最近的操作”记 `Team on` / `Team off`；带 `team: 'once'` 的发送记 `Send (team): <摘要>`（摘要同 v0 发送的前 40 个字，§13.10） | — |

## 反例

- `/tasks …`、`/taskboard` 不是 `/task`：照普通的“/”命令处理；`/team …` 也不是命令（2026-10-26 起）。
- `/task on`、`/task off`、只有 `/task` 都不会作为消息发给模型，也不出现在对话流或排队区里（模式改变的提示行是另一回事，见上）。
- 发出的 `/task <文字>` 不展开同名的提示词模板（TB-05）。
- 运行中关掉开关，这次运行的工具、工作卡与附加段不变；开关立即显示新的模式。
- 关掉开关不撤销任何需求；有未关闭的需求时开关显示 `Team: Until done`，不是 `Team: Off`。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：切换中开关保持原文字、不可用；切换失败的一行 `Couldn’t change team mode: <原文>` 及其消失时机；
窄栏（不宽于 600px）只显示状态点，`off` 空心、`always` 与 `once` 实心，宽栏不显示状态点；读屏名称用完整文字；界面没准备好时显示最后知道的模式；
`/task on`、`/task off` 只清空文字、保留输入框里的引用芯片（规格写“清空输入框”，芯片是你加的引用，清掉会丢失；走查时可以改为一起清空）；
生成中的 `/task on`、`/task off` 按 Enter 与 Ctrl+Enter 都当作命令；被拒绝启动时 `/task on`、`/task off` 照样执行；模式提示的三句话、它们不合并、`/task <文字>` 时放在你的消息之前（2026-10-26，WP-10）。

## 需要规格回答

- **`agents_invalid` 时开关是否可用**：§13.1 只说“界面没准备好时不可用”，所以本表让它可用；但 §4.4 说拒绝启动时会话“不注册 `mori-team`”，
  而 §6.3 说第一次进入协作模式时注册 TaskBoard 工具。被 `agents_invalid` 拒绝启动的会话能否切到 `always`、切了以后 `Check again` 怎样处理，规格没说。
- **TB-03 与 §13.1**：TB-03 要求 m1–m7 的回放“没有 Team 相关元素”，§13.1 的开关却总在顶栏。本表按 §13.1：开关总是显示（`Team: Off`）；
  TB-03 的“Team 相关元素”理解为回执、进展摘要、`Stop team`、批准卡归属、右栏说明这些只在用过协作模式时出现的元素。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 协作开关 | 每一栏里 `[data-testid="team-switch"]`（§13.1），`role="switch"`，`aria-checked`（`once`、`always` 为 `true`），`data-mode` 为 `off` / `once` / `always`；窄栏时同一个元素 |
| 切换失败 | `data-testid="team-error"`（本表定，临时） |
| 模式提示 | 对话流里 `[data-testid="notice"][data-kind="team-mode"]`，`data-mode` 为 `always` / `once` / `off`；外面一层 `data-item="team-mode"` |
