# Task mode 开关（模型菜单）与 `/task`

依据：TaskBoard 规格（[parallel-agents-taskboard.md](../../specs/parallel-agents-taskboard.md)，下称“规格”）§5.1（模式、回到 off 的条件、`/task` 的识别、模式提示）、
§5.3（协作模式下一条消息的走法）、§12.11（协作模式下的模型按钮）、§13.1（Task mode 开关）、§13.10（进程桥）、§13.11（模式提示）、§15（命令名与界面名）。
命令 2026-10-26 由 `/team` 改为 `/task`（负责人走查 M21，没有别名）；同一天加了对话流里的模式提示（M13，下面“对话流里的模式提示”）。
补充 [model-menu.md](model-menu.md) 的模型按钮与菜单、[v0 chat.md](../../v0/screens/chat.md) 的输入框。消息发出之后的待判断、排队区与停止见 [team-stop.md](team-stop.md)；
回执与进展摘要见 [team-stream.md](team-stream.md)；拒绝启动与 `Turn off task mode` 见 [team-blocked.md](team-blocked.md)。
标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

2026-10-26 负责人走查（[walkthrough-1026-checks.md](../walkthrough-1026-checks.md) M10 “no standalone TeamMode button, put it in
model-selection panel”、M21 “team mode should be task mode”，WP-09）：开关从顶栏移进模型菜单，界面叫 Task mode；顶栏的开关（`Team: Off` /
`Team: On` / `Team: Until done`）和不宽于 600px 时的状态点都去掉了。命令改为 `/task`、发给模型的文字改为 task mode 在 WP-10。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo.team`（`session.create`、`session.open`、`session.recheckAgents` 的结果；界面重新载入后接上会话的 `LiveSnapshot.team`） | `TeamState`：`mode`（`off` / `once` / `always`）、`holders`（`dialog`、`create`、`close` 的角色名）、`roles`、`busy` |
| `mori.team_state` 事件 | 同上；模式在后台进程里改变时发出（Task mode 一行、`/task`、`once` 自动回到 `off`、带 `team: 'once'` 的发送） |
| `mori.team_mode` 事件 | `{ mode }`：与同一时刻写下的 `mori.team` 条目对应（§13.10），对话流里加一行模式提示 |
| `ModelState.pickLocked`（`mori.model_state`） | 对话会话在协作模式下为真；模型菜单的上半部分按它显示（model-menu.md）。模式改变时对话会话正在运行的，这次运行结束后才变（§5.1），所以回复进行中打开或关掉时它会晚一点跟上 |
| `session.setTeam { sessionId, mode: 'on' \| 'off' }` 的结果 | `TeamState`，或 `error` |
| `session.prompt` 加 `team: 'once'` | `/task <文字>` 发出的消息（结果不变） |
| 会话文件的 `mori.team` 条目 | 每条在对话流里是一行模式提示（§13.11，重新打开时）；后台进程重新打开会话时取最后一条作为 `mode`，开关只看 `SessionInfo.team` |
| 界面的准备状态 | 会话是否已打开、后台进程通道是否接上、后台进程是否退出（v0 chat.md“后台正在启动”“后台进程退出”） |
| 你的操作 | 在模型菜单里点 Task mode 一行（或焦点在它上面时按 Enter、Space）；在输入框里输入 `/task on`、`/task off`、`/task <文字>`、`/task` 后按 Enter |

`<create role>` 取 `TeamState.holders.create`；基座（`mori`）显示为 `Mori`（规格 §1、§5.3），其他角色显示角色名原文。

## Task mode 一行

位置：输入框下面一行的模型按钮打开的菜单（model-menu.md）里，范围的几节和菜单的说明之下、“Manage models”之上（§13.1）。菜单往上打开，
这一行离按钮最近的是“Manage models”，其次是 `See background tasks`（会话的 TaskBoard 有需求或协作模式打开时，§13.13.1），再次就是它（Claude 的模型菜单里 Fast mode 一行的位置）。`pickLocked` 时菜单只有说明
`Task mode picks the model for each agent`、这一行、`See background tasks` 和“Manage models”（§12.11）。分屏时每一栏的模型菜单各有一行，作用于这一栏的会话。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关闭 | `TeamState.mode` 为 `off`（新会话、没有 `mori.team` 条目的会话都是） | `role="menuitemcheckbox"`，`aria-checked="false"`，文字 `Task mode`，右边的开关关着（灰色）；没有第二行 | 点击、Enter、Space：`session.setTeam { mode: 'on' }` → 一直打开 |
| 一直打开 | `mode` 为 `always` | `aria-checked="true"`，开关开着（强调色）；第二行小字 `Messages go to <create role> first`（也是读屏的描述） | 点击：`session.setTeam { mode: 'off' }` → 关闭，或不能回到 `off` 时变为做完为止（下表） |
| 做完为止 | `mode` 为 `once` | `aria-checked="true"`，开关开着；第二行 `Until done · Ends when open requests are done`（临时，走查时可以改） | 点击：`session.setTeam { mode: 'on' }` → 一直打开 |
| 点了之后 | 你的操作 | 不弹确认框（§13.1）；菜单不关，焦点留在这一行（临时，走查时可以改）；范围的几节随 `pickLocked` 换成说明或换回来（model-menu.md） | ↑ ↓ 在可用的项之间移动；Esc 关菜单，焦点回到模型按钮 |
| 回复进行中 | 对话在回复或准备中 | 菜单照常能打开：范围的项不可用（`disabled`，↑ ↓ 跳过），菜单的说明换成 `Can’t switch models until the response finishes`；这一行照常可用（§13.1） | 点击；只影响之后发出的消息，正在进行的回合按它开始时的模式跑完（§5.1） |
| 只有后台在运行 | `TeamState.busy`，对话空闲 | 同一般：范围的项可用，这一行可用 | 点击 |
| 界面没准备好 | 会话还在打开（“Starting…”）、后台进程通道没接上、后台进程已退出 | 模型按钮不可用（`aria-disabled`，悬停的最后一行是原因，model-menu.md），菜单打不开、开着的关上，所以不能切换；第一次打开中、打开失败时没有模型按钮 | — |
| 切换中 | 你点了这一行，`session.setTeam` 还没返回 | 这一行保持原来的样子、不可用：`aria-disabled="true"`、`data-pending="true"`，点击、Enter、Space 不起作用；焦点留在这一行，↑ ↓ 照常（不用真正的 `disabled`：焦点会掉到 body，菜单里的键盘就不起作用了，同模型按钮切换中的 `data-pending`）（临时，走查时可以改） | 返回后再按 Space 或点击 |
| 已切换 | `session.setTeam` 返回 `TeamState`，或随后的 `mori.team_state` | 这一行的 `aria-checked`、`data-mode`、第二行，模型按钮的文字和 `data-team-mode` 按新的 `mode`；对话流里加一行模式提示（下面“对话流里的模式提示”）；菜单的上半部分随 `mori.model_state` 的 `pickLocked` 换 | — |
| 切换失败 | `session.setTeam` 返回 `error` | 这一行回到原来的模式；一行 `Couldn’t change task mode: <原文>`（`role="alert"`）：菜单开着时在这一行下面，菜单关着时（例如 `/task on` 失败）从输入框下面一行往上弹出、右边对齐模型按钮（同 model-menu.md 的“切换失败”）；下次切换或 10 秒后消失（临时，走查时可以改） | 再点 |
| 角色文件有错 | `ModelState.blocked.kind` 为 `agents_invalid` | 这一行不可用（先改角色文件，Check again，team-blocked.md）；菜单其余照常 | — |

### 点击之后模式怎么变

| 点之前 | 条件 | 点之后 | 来源 |
| --- | --- | --- | --- |
| `off` | — | `always` | `session.setTeam { mode: 'on' }` 的结果 |
| `always` | 满足回到 off 的条件：没有未关闭的需求、待判断队列为空、立项没有在判断的消息（§5.1） | `off` | `session.setTeam { mode: 'off' }` 的结果 |
| `always` | 三项中任何一项不满足 | `once`（这些需求照常做完；要停下按 `Stop agents`，见 team-stop.md） | 同上 |
| `once` | — | `always` | `session.setTeam { mode: 'on' }` 的结果 |
| `always` 或 `once`，对话会话被拒绝启动（`ModelState.blocked` 不为 null） | 不看回到 off 的条件 | `off`；未关闭需求的非终态 task 变为 `stopped`，进展摘要显示 `Stopped`（§5.1；拒绝启动卡上的 `Turn off task mode` 同样，见 team-blocked.md） | `session.setTeam { mode: 'off' }` 的结果，随后的 `mori.board` |

## 模型按钮上的模式

不打开菜单也看得出模式（§12.11，负责人走查 M10 的推荐选项“Text on the button”）。按钮的其余样子（位置、宽度、▾、不可用、窄栏）见 model-menu.md 与 v0 models.md。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关闭 | `mode` 为 `off` | 范围按钮原来的样子（“<范围名> · <当前模型 id>”等，model-menu.md）；`data-team-mode="off"` | 打开菜单 |
| 打开 | `mode` 为 `always` 或 `once` | “Task mode · <当前模型 id>”和 ▾（没有当前模型时只有“Task mode”）；读屏名“Model: Task mode, <模型 id>”；悬停第一行是按钮文字，第二行 `Task mode picks the model for each agent`（界面没准备好时第三行是原因）；`data-team-mode` 为模式，`pickLocked` 时另有 `data-locked="true"` | 打开菜单 |
| 打开、回复进行中 | 同上 | 模型 id 是这一段正在用的；段内换模型时跟着换（`mori.model_state`） | 打开菜单 |
| 窄栏 | 这一行放不下 | 同范围按钮：最长 200px，先截模型 id、再截“Task mode”，全文在悬停的第一行和读屏名里（v0 models.md“窄栏”） | — |

## 不经这一行的变化

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `/task <文字>` 进入做完为止 | 模式为 `off` 时发出带 `team: 'once'` 的消息；`mori.team_state` | 模型按钮变为“Task mode · <模型 id>”，`data-team-mode="once"`；菜单里这一行 `aria-checked="true"`、第二行 `Until done · Ends when open requests are done`；对话流里你的消息之前一行 `Task mode on until done`；模式为 `always`、`once` 时不变 | — |
| 做完为止自动结束 | 满足回到 off 条件的那个对话回合结束时（§5.1、§5.3 第 6 步），`mori.team_state` 的 `mode` 为 `off` | 模型按钮回到范围按钮的样子，`data-team-mode="off"`；对话流末尾一行 `Task mode off` | — |
| 重新打开会话 | `session.open` 的 `SessionInfo.team.mode`（最后一条 `mori.team` 条目，没有条目时 `off`） | 按它显示，例如关闭前是一直打开，重新打开仍是“Task mode · …”、`data-team-mode="always"` | — |
| 界面重新载入（Ctrl+R） | `LiveSnapshot.team` | 同上；后台进程里的模式不变 | — |
| `Check again` 通过 | `session.recheckAgents` 返回的 `SessionInfo.team` | 按新的 `TeamState`（第二行里的 `<create role>` 按新的持有者） | — |

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
| `/task on`（不区分大小写，前后可以有空白） | 你的操作 | 不发消息：发 `session.setTeam { mode: 'on' }`，输入框的文字清空；模型按钮与菜单里的这一行按结果变化（上表）；排队区没有变化，对话流不加你的消息，模式变了时加一行模式提示（见“对话流里的模式提示”） | — |
| `/task off`（同上） | 你的操作 | 不发消息：发 `session.setTeam { mode: 'off' }`，输入框的文字清空；结果是 `off` 或 `once`（上表“点击之后模式怎么变”）；排队区没有变化，对话流不加你的消息，模式变了时加一行模式提示（见“对话流里的模式提示”） | — |
| `/task <文字>`（`/task ` 后面有非空白的文字） | 你的操作 | 去掉 `/task ` 前缀，以 `session.prompt { team: 'once' }` 发出（引用芯片照常拼进消息）；对话流里你的消息不带 `/task `；之后照协作模式的走法（team-stop.md）；模式为 `off` 时变为做完为止（上表） | — |
| 只有 `/task`（后面没有文字或只有空白） | 你的操作 | 不发送，输入框不变（文字、芯片都在） | 继续编辑 |
| 生成中输入 `/task on`、`/task off` | 对话在回复或准备中 | 同上：不进排队区，不插话，Enter 和 Ctrl+Enter 都按命令处理 | — |
| 生成中输入 `/task <文字>` | 同上 | 按你按的键记下 Enter（排队）或 Ctrl+Enter（插话），消息进待判断队列（分开时）或照常排队、插话（合并会话），见 team-stop.md | — |
| 被拒绝启动时输入 `/task on`、`/task off` | `ModelState.blocked` 不为 null（发送不可用） | `/task on`、`/task off` 不发消息，照样执行（§5.1：被拒绝启动时 `/task off` 直接回到 `off`）；`/task <文字>` 与其他消息一样不发送、草稿不丢 | — |
| 界面没准备好 | 同上表 | 与普通发送一样不可用（Enter 不起作用） | 打字 |
| 切换失败 | `session.setTeam` 返回 `error` | 菜单关着，所以那一行从输入框下面一行往上弹出（上表“切换失败”） | — |
| F8 的操作记录 | `session.setTeam` | “最近的操作”记 `Task mode on` / `Task mode off`；带 `team: 'once'` 的发送记 `Send (task mode): <摘要>`（摘要同 v0 发送的前 40 个字，§13.10） | — |

## 反例

- `/tasks …`、`/taskboard` 不是 `/task`：照普通的“/”命令处理；`/team …` 也不是命令（2026-10-26 起）。
- `/task on`、`/task off`、只有 `/task` 都不会作为消息发给模型，也不出现在对话流或排队区里（模式改变的提示行是另一回事，见上）。
- 发出的 `/task <文字>` 不展开同名的提示词模板（TB-05）。
- 运行中关掉 Task mode，这次运行的工具、工作卡与附加段不变；这一行和模型按钮立即显示新的模式。
- 关掉 Task mode 不撤销任何需求；有未关闭的需求时这一行仍开着、第二行是 `Until done · …`，模型按钮仍是“Task mode · …”。
- 顶栏没有协作开关；也没有只显示状态点的窄样子。
- 回复进行中打开菜单不能换范围（项不可用），只能切 Task mode。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：点了这一行菜单不关、焦点留在这一行；切换中这一行保持原样、不可用（`aria-disabled`，焦点不掉）；
`once` 的第二行 `Until done · Ends when open requests are done`；`off` 没有第二行（不写“Turn on task mode”）；
切换失败那一行 `Couldn’t change task mode: <原文>` 的位置（菜单开着时在这一行下面，关着时在输入框下面一行上方）与消失时机；
模型按钮“Task mode · <模型 id>”跟着 `TeamState.mode`（不等 `pickLocked`）、没有当前模型时只有“Task mode”；读屏名“Model: Task mode, <模型 id>”；
界面没准备好时显示最后知道的模式；
`/task on`、`/task off` 只清空文字、保留输入框里的引用芯片（规格写“清空输入框”，芯片是你加的引用，清掉会丢失；走查时可以改为一起清空）；
生成中的 `/task on`、`/task off` 按 Enter 与 Ctrl+Enter 都当作命令；被拒绝启动时 `/task on`、`/task off` 照样执行；模式提示的三句话、它们不合并、`/task <文字>` 时放在你的消息之前（2026-10-26，WP-10）。

## 需要规格回答

- **`agents_invalid` 时能不能切换**：§13.1 写切换中、`agents_invalid` 时这一行不可用；但 §4.4 说拒绝启动时会话“不注册 `mori-team`”，
  而 §6.3 说第一次进入协作模式时注册 TaskBoard 工具。被 `agents_invalid` 拒绝启动的会话用 `/task on` 切到 `always` 之后 `Check again` 怎样处理，规格没说。
- （2026-10-26 已解决）原来的“TB-03 与总在顶栏的开关”：开关进了模型菜单，m1–m6 的回放里模型按钮一直是 `data-team-mode="off"`、没有“Task mode”。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| Task mode 一行 | 每一栏模型菜单（`data-testid="model-menu"`）里 `[data-testid="team-switch"]`（§13.1），`role="menuitemcheckbox"`，`aria-checked`（`once`、`always` 为 `true`），`data-mode` 为 `off` / `once` / `always`，切换中 `aria-disabled="true"`、`data-pending="true"`（`agents_invalid` 时是 `disabled`）；第二行 `data-testid="team-hint"`（本表定，临时） |
| 模型按钮上的模式 | `data-testid="model-button"` 的 `data-team-mode`（`off` / `once` / `always`），`pickLocked` 时 `data-locked="true"`（model-menu.md） |
| 切换失败 | `data-testid="team-error"`（本表定，临时） |
| 模式提示 | 对话流里 `[data-testid="notice"][data-kind="team-mode"]`，`data-mode` 为 `always` / `once` / `off`；外面一层 `data-item="team-mode"` |
