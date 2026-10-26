# 记忆页的增强：开关、状态行、Run now 与设置

依据：提示词分层与记忆构建规格（[memory.md](../../specs/memory.md)，下称“规格”）§10.4（增强一块）、§9.1（设置与开关）、§9.3–§9.4（什么时候跑、队列）、
§9.6（失败的原因）、§9.8–§9.10（结果、你看到什么、中途退出）、§8（命令、进度事件、动作记录）、§10.10（后台进程退出时）；proposal §10.5。
2026-10-24 补：设置对话框的 `Effort` 对思考关不掉的模型不列 Off，按统一模型提供商构建规格（[model-providers.md](../../specs/model-providers.md)，下称“模型层规格”）§7.7、§9.1；
数据来自 `enhance.get` 新加的 `noOffPicks`（模型层规格 §7.7；规格 §8 `enhance.get` 一行、§10.4 的 2026-10-24 注）。
新增的界面（v0 没有对应的屏），在记忆页 `Project` 层、分节上面（[memory-page.md](memory-page.md)）；增强改了东西之后新会话顶部的提示见 [memory-chat.md](memory-chat.md)。
界面文字为英文，按规格 §10.4 原文。规格标了“临时”的文字（登记在规格 §12）写作“（临时，规格 §12）”；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `enhance.get { cwd }` 的结果 | `EnhanceInfo`：`enabled`、`pick`（没有默认范围时 null）、`thinking`、`team`、`time`（`HH:MM`）、`since`、`last`（三个任务各自的上次结果：`day`、`at`、`status`（`done` / `failed` / `skipped`）、`error`、`revision`、`tokens`、`counts`）、`running`（这个项目正在跑的 `{ task, day }`）、`queued`（这个项目在队列里排着的项数，不含正在跑的）、`next`（下次到点的时刻）、`effortPicks`（模型设置里每个选择范围按 §9.1 取到的第一个候选是否标了 Supports thinking，取不到候选的范围不在里面；设置对话框的 `Effort` 用）、`error`（读不出设置、项目目录被占用）（2026-10-24 补：另有 `noOffPicks`，见下一行） |
| `enhance.get { cwd }` 的结果里的 `noOffPicks`（2026-10-24 补，模型层规格 §7.7） | `ModelPick[]`：第一个候选（按 §9.1 的取法，同 `effortPicks`）的档案 `reasoning.off_refused` 为真的那些选择范围；那个候选没有档案时按假（不在里面），取不到候选的范围也不在里面。设置对话框的 `Effort` 用，下文称所选范围在 `noOffPicks` 里为“第一个候选没有 Off”。`effortPicks` 不变（仍是 `Record<ModelPick, boolean>`，录下的回放 fixture 照样有效） |
| `enhance.set { cwd, enabled?, pick?, thinking?, team?, time? }` 的结果 | `{ error, info: EnhanceInfo }` |
| `enhance.run { cwd }` 的结果 | `{ error }`：排进队列（§9.9） |
| `mori.enhance_progress { cwd, task, day, phase, error?, revision? }` | 全局事件：每个任务排队（`queued`）、开始（`running`）、结束（`done`）、跳过（`skipped`）、失败（`failed`）时 |
| `mori.memory_changed` | 增强运行的修订在 `beginRun`、`endRun` 各发一次（Revisions 节的 `Running` 行，见 memory-page.md） |
| 模型设置（`models.get` 的 `config`） | 设置对话框的 `Model range` 下拉（同设置页 Defaults） |
| 跟随的项目 | 记忆页 `Project` 层的项目（memory-page.md） |
| 界面的后台进程状态 | 后台进程退出、重新连上 |
| 你的操作 | 开关、`Run now`、`Settings…`、对话框里的四项与 `Save` |

`<KIND>` 是 `TASTE`、`STRATEGY`、`REVIEW`；时间写 `<Mon D> <hh:mm>`（本地时间，24 小时制，`shared/memory.ts` 的 `monthDayTime`）；
token 数不到 1000 写 `<n> tokens`（1 时 `1 token`），1000 起写 `<n>k tokens`，四舍五入到整数（`formatTokens`）。

## 增强一块

`Project` 时在分节上面一块（`memory-enhance`）；`User` 时没有这一块。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 进入 `Project`（打开记忆页、换层、跟随的项目改变）时发的 `enhance.get` 还没返回 | 开关 `Enhancement`；状态行留空（离开 `Project` 之前读到的状态、`Couldn’t run enhancement: …` 都不留）；开关、`Run now`、`Settings…` 不可用（临时，走查时可以改） | — |
| 已读到 | `enhance.get` 的结果 | 开关 `Enhancement`（`enhance-switch`，`role="switch"`，`aria-checked` 为 `info.enabled`）；右边状态行（`enhance-status`，下一节）；按钮 `Run now`（`enhance-run`）、`Settings…`（`enhance-settings`） | 开关；Run now；Settings… |
| 开关中 | 你点了开关，`enhance.set { cwd, enabled }` 还没返回 | 开关保持原来的状态、不可用（同模型菜单里 Task mode 一行的“切换中”，临时，走查时可以改） | — |
| 打开了 | `enhance.set` 返回 `{ error: null, info }` | 开关按 `info.enabled`；状态行按 `info`（下一节），例如第一次打开、设置里有默认范围时 `On · Next run <Mon D> <hh:mm>`，没有默认范围时 `On · Choose a model in enhancement settings`；F8 记 `Turn on enhancement <cwd>` | — |
| 关掉了 | 同上 | 开关关；状态行是关的那一行；这个项目排着的项去掉，正在跑的那一次停止并记失败（原因 `Enhancement was turned off`），已写入的改动留在条目里，可以用那条修订回滚（§9.4、§9.6）；F8 记 `Turn off enhancement <cwd>` | — |
| 开关失败 | `enhance.set` 返回 `error` | 开关下面一行 `Couldn’t change enhancement: <原因>`，开关回到 `info.enabled`（同 Task mode 一行）；这一行在下次点开关或 10 秒后消失（同 team-switch.md，临时，走查时可以改） | 再点 |
| 后台进程退出 | 界面的后台进程状态 | 保留最后读到的状态行（退出时还没返回的 `enhance.get` 不把它换成 `Couldn’t read the enhancement settings: …`）；开关、`Run now`、`Settings…` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`（§10.10） | — |
| 重新连上 | 你点了 `Restart` | 跟随的会话打开好之后重读 `enhance.get` | 照常 |

- `enhance.set`、`enhance.run` 返回时页面已经跟随了别的项目：不用这次的结果改状态行（`info`、`Couldn’t run enhancement: …`），状态行按那个项目读到的；
  `enhance.set` 期间又发了 `enhance.get`（例如收到进度事件，那次读可能在设置写进之前）：不用这次的 `info`，返回后再读一次 `enhance.get`（临时，走查时可以改）。

打开时取的值（§9.1）：`pick` 取设置里新会话的默认范围，`thinking` 取它第一个候选的默认思考强度，`team` 为假，`time` 为 `04:00`（已有的值保留）；
从打开那天读起，关着期间的日子不补。（2026-10-24 补：取到的是 Off 而第一个候选没有 Off 时照存 `off`，对话框里显示为 `Minimal`，见“设置对话框”。）

## 状态行

由 `enhance.get` 的结果渲染（`shared/memory.ts` 的 `enhanceStatusText`）；按表的顺序取第一个符合的。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读不出设置 | `info.error` 不为 null（`enhance.json` 读不出，或项目目录被别的工作目录占用，§3、§9.1） | `Couldn’t read the enhancement settings: <原因>`；开关按关显示 | 开关（`enhance.set` 返回同一原因时按“开关失败”显示）；Settings… |
| 关 | `enabled` 为假 | `Off · Each day, three background runs review this project’s sessions and improve its TASTE, STRATEGY, and REVIEW`（临时，规格 §12） | 打开开关；Settings… |
| 开，没有模型 | `enabled`，`pick` 为 null | `On · Choose a model in enhancement settings`；不跑（§9.1） | Settings…（选一个范围） |
| 正在跑 | `running` 不为 null（跑的是这个项目的项） | `Running <KIND> enhancement…`；这个项目还排着的（`queued` > 0）再加 ` · <n> queued` | 关开关 |
| 排着 | `running` 为 null，`queued` > 0（别的项目正在跑） | `On · <n> queued · Waiting for another project’s enhancement`（临时，规格 §12） | 关开关 |
| 上次有任务失败 | 三个任务里有 `last.status` 为 `failed` 的 | `On · Last run failed (<KIND>, …): <原因> · Next run <Mon D> <hh:mm>`：`<KIND>` 按 TASTE、STRATEGY、REVIEW 写所有失败的任务，`<原因>` 取其中 `last.at` 最晚那个的 `error` | Run now（从没处理完的那天起重跑，§9.9） |
| 上次全部跳过 | `last.day` 最晚的那一天，各任务都是 `skipped` | `On · Last run <Mon D> <hh:mm> · No finished sessions to read · Next run <Mon D> <hh:mm>`（临时，规格 §12） | Run now |
| 开，上次成功 | 上面都不符合，有 `last` | `On · Last run <Mon D> <hh:mm> · <KIND>: added 1, changed 1; <KIND>: deleted 1 · <n>k tokens · Next run <Mon D> <hh:mm>`；计数为 0 的不写、全为 0 的任务不写；都没有改动时 `No changes` | Run now |
| 开，还没跑过 | 三个 `last` 都为 null | `On · Next run <Mon D> <hh:mm>` | Run now |

- “上次”取三个任务里 `last.day` 最晚的那一天（三个任务一起写，跳过的任务不写）；token 是那一天三个任务的合计；
  `Last run` 的时刻取那一天各任务 `last.at` 里最晚的（规格没写，按 `enhanceStatusText` 的做法）。
- 失败的原因原文（§9.6、§9.10）：拒绝启动的种类与说明、`mori.prompt_error` 的 message、`No model available`、最后一条助手消息的 `errorMessage`、
  `Mori closed during the run`、`Enhancement was turned off`。
- 某个任务连续失败、别的任务已经跑到更晚的日子时，仍是“上次有任务失败”那一行（MEM-23）。
- `Next run` 取 `info.next`；状态行只在读 `enhance.get` 时变（不轮询，到点之前不自己刷新）。

## Run now

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可用 | 开关开、`pick` 不为 null、这个项目没有在跑也没有排着（`running` 为 null 且 `queued` 为 0） | `Run now` 可用 | 点击：`enhance.run { cwd }`；F8 记 `Run enhancement now <cwd>` |
| 不可用 | 这个项目正在跑或排着、开关关、没有模型；或读取中、后台进程退出 | `Run now` 不可用（规格没给悬停文字） | — |
| 发出中 | `enhance.run` 还没返回 | `Run now` 不可用（临时，走查时可以改） | — |
| 已排进队列 | `enhance.run` 返回 `error: null`；随后的 `mori.enhance_progress`（`queued`、`running`） | 状态行变为 `Running <KIND> enhancement…` 或排着的那一行；排进的是该跑的日子和“今天到现在”的三个任务（§9.9） | — |
| 失败 | `enhance.run` 返回 `error` | 状态行显示 `Couldn’t run enhancement: <原因>`；下一次重读 `enhance.get` 时换回状态行（临时，走查时可以改） | 再点 |

今天“现在运行”过之后，当天结束后的那一次只读新增的部分（§9.9）；“今天到现在”的那一次不推进 `doneThrough`（§9.8）。

## 设置对话框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开 | 你点了 `Settings…` | 对话框，标题 `Enhancement settings`（`enhance-dialog`），四项的初值取最近一次的 `info`；`Save`（`enhance-save`）、`Cancel` | 改；Save；Cancel 或 Esc（不写，Esc 临时，走查时可以改） |
| `Model range` | 模型设置（同设置页 Defaults 的下拉） | 标签 `Model range`；下拉（`enhance-model`）分三节 `Groups`、`Providers`、`Models`，项为分组 id、提供商名称、`<provider name> · <model id>`（同 Defaults）；不提供 `None`；当前值选中 | 选一项 |
| 没有选过范围 | `info.pick` 为 null | 下拉没有选中项（临时，走查时可以改） | 选一项 |
| `Effort` | `info.thinking`；`info.effortPicks[<所选范围>]`（后台进程按 §9.1 取默认强度的规则取第一个候选，§8） | 标签 `Effort`；下拉（`enhance-effort`）是 pi 的七档，文字同顶栏：`Off`、`Minimal`、`Low`、`Medium`、`High`、`Extra high`、`Max` | 选一档 |
| `Effort` 不可用 | `effortPicks[<所选范围>]` 为假：第一个候选的模型没标 Supports thinking | 下拉不可用，悬停 `This model isn’t marked “Supports thinking”`（同输入框下面一行的 Effort 按钮）；保持原来的值（临时，走查时可以改） | — |
| `Effort` 没有范围 | 下拉没有选中范围，或所选范围不在 `effortPicks` 里（取不到候选） | 下拉不可用，悬停 `Choose a model first.`；保持原来的值（临时，走查时可以改） | 选一个范围 |
| `Effort` 没有 Off（2026-10-24 补，模型层规格 §7.7、§9.1） | `effortPicks[<所选范围>]` 为真，且所选范围在 `info.noOffPicks` 里（`effortPicks` 为假时按“`Effort` 不可用”，不看 `noOffPicks`） | 下拉不列 `Off`（不是变淡），从 `Minimal` 起，其余同 `Effort`；没有悬停说明（模型层规格只给了输入框下面一行的 Effort 菜单那一句，临时，走查时可以改） | 选一档 |
| 存的是 Off、第一个候选没有 Off（2026-10-24 补，模型层规格 §7.7） | 草稿的强度是 `off`（`info.thinking` 为 `off`，或草稿是 Off 时改选了这样的范围），所选范围同上一行（在 `noOffPicks` 里） | 下拉显示 `Minimal`（增强会话经虚拟模型路由，pi 按实际模型把 Off 提到 Minimal，用的就是它）；不动 `Effort` 就保存时照存：`enhance.set` 带 `thinking: 'off'`；改选第一个候选有 Off 的范围时显示回 `Off` | 选另一档 |
| `Task mode`（2026-10-26 前叫 `Team mode`） | `info.team` | 标签 `Task mode`；勾选框 `Run in task mode`（`enhance-team`；原为 `Run with team mode`，负责人走查 M21），下面一行 `Uses this project’s agents in .mori/agents.`（临时，规格 §12） | 勾选 |
| `Daily time` | `info.time` | 标签 `Daily time`；`<input type="time">`（`enhance-time`），下面一行 `Runs once a day at this time. Conversations before it count as the previous day.`（临时，规格 §12） | 改时间 |
| 时间清空 | 你清空了时间框、点了 `Save` | 显示 `Choose a time.`，不发命令 | 填时间 |
| 保存中 | `enhance.set { cwd, pick, thinking, team, time }` 还没返回（没选范围时不带 `pick`，临时，走查时可以改） | `Save` 不可用（临时，走查时可以改） | — |
| 已保存 | 返回 `{ error: null, info }` | 对话框关闭；状态行按新的 `info`（改了时刻时 `Next run` 按新时刻，§9.1：已读过的部分不会重复读）；F8 记 `Save enhancement settings <cwd>` | — |
| 保存失败 | 返回 `error` | 对话框里 `Couldn’t save the enhancement settings: <原因>`，不关闭 | 改后再 Save；Cancel |
| 后台进程退出 | 界面的后台进程状态 | `Save` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`；对话框里的值保留 | Cancel |

- 开关关着时也能打开对话框、保存设置（规格没有限制）；保存不改开关。
- 选了范围之后 `Effort` 不自动换成那个模型的默认强度（规格只在打开开关时取默认值，临时，走查时可以改）。
- （2026-10-24）有没有 Off 按最近一次 `enhance.get` 的 `noOffPicks`：对话框开着时重新探测改了档案，下拉不跟着变，下次读 `enhance.get` 时按新的
  （同 `effortPicks`，不轮询）。界面不自己读档案或 `models.get` 判断有没有 Off（第一个候选只有后台进程取得出来）。

## 进度

收到 `mori.enhance_progress` 时重读 `enhance.get`：只在记忆页开着、事件的 `cwd` 是跟随的项目时（§10.4）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 排进队列 | `phase: 'queued'` | 状态行按重读的结果：本项目没有在跑时 `On · <n> queued · Waiting for another project’s enhancement`；`Run now` 不可用 | — |
| 开始 | `phase: 'running'` | `Running <KIND> enhancement…`（还排着的加 ` · <n> queued`）；`Revisions` 多一行 `<KIND> enhancement · <Mon D>`，标 `Running`（`beginRun` 的 `mori.memory_changed`，memory-page.md） | 关开关 |
| 结束 | `phase: 'done'`，`revision` | 下一个任务开始时是它的 `Running <KIND> enhancement…`；都结束后是“上次成功”那一行；`Revisions` 那一行不再标 `Running`，计数更新 | — |
| 跳过 | `phase: 'skipped'`（没有可读的会话，§9.5） | 没有修订、不建会话；那一天各任务都跳过时是“上次全部跳过”那一行 | — |
| 失败 | `phase: 'failed'`，`error`，`revision` | 状态行是“上次有任务失败”那一行；`Revisions` 那一行标 `Failed`（建立失败、拒绝启动也有这样一行，`No changes`，§9.8） | Run now |
| 别的项目的进度 | 事件的 `cwd` 不是跟随的项目 | 不重读 | — |
| 不在记忆页 | — | 不重读；下次打开记忆页时读 | — |

后台进程在运行中退出、重新启动后，那条修订变为 `Failed`，`last` 记失败（原因 `Mori closed during the run`），之后按 §9.3 重跑（§9.10）。

## 反例

- 增强会话不出现在侧栏和会话列表里，界面收不到它的事件，它的命令不出批准卡（§9.6）。
- 全应用同一时刻只有一个增强任务在跑：另一个项目到点时排着，它的 `Run now` 不可用。
- 没有模型时开关可以打开，但不跑；`Run now` 不可用。
- 关掉开关不撤销已写入的改动；它们在那条修订里，可以回滚。
- `User` 层没有增强一块；不开记忆页时界面不读 `enhance.get`（反馈表单除外，memory-chat.md）。
- 跳过的运行没有修订，不出现在 `Revisions` 里。
- （2026-10-24，模型层规格 §7.7）第一个候选没有 Off 时 `Effort` 不列 `Off`，但不把已经存的 `off` 改写成 `minimal`（照存）；
  增强运行时 pi 按实际模型把 Off 提到 Minimal，服务不回 400。第一个候选有 Off、或没标 Supports thinking 时下拉照旧（七档；不可用时照旧不可用）。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中状态行留空、三个控件不可用；开关中不可用；开关失败那一行的消失时机（同 team-switch.md）；
`Run now` 发出中不可用；`Couldn’t run enhancement: …` 在下一次重读时换回状态行；对话框 Esc 等于 `Cancel`；`pick` 为 null 时下拉没有选中项、不选就保存不带 `pick`；
`Effort` 不可用时保持原来的值、改范围时不自动换强度，没有选中范围或范围取不到候选时不可用、悬停 `Choose a model first.`；保存中 `Save` 不可用；
`enhance.set`、`enhance.run` 的结果在页面换了项目时不改状态行，`enhance.set` 期间又读了 `enhance.get` 时不用它的 `info`、返回后再读一次。按 `shared/memory.ts` 的 `enhanceStatusText`：`Last run` 的时刻取那一天最晚的 `last.at`。
（2026-10-24，模型层规格 §7.7 只定了“不列 Off、存的 Off 照存、显示为 Minimal”）`Effort` 没有 Off 时没有悬停说明；存的是 Off、显示 `Minimal` 时
在下拉里再点 `Minimal` 不算改动（它已经是显示的值，同输入框下面一行的 Effort 菜单点当前项），保存仍写 `off`；对话框开着时档案变了不跟着变。

规格自己标“临时”、登记在规格 §12 的：关着的状态行、排着的状态行、全部跳过的状态行、`Uses this project’s agents in .mori/agents.`、
`Runs once a day at this time. Conversations before it count as the previous day.`。

## 需要规格回答

已回答：

- （已回答：模型层规格 §7.7）**“第一个候选没有 Off”从哪里来**：第一个候选由后台进程按规格 §9.1 取，界面在范围是分组或提供商时算不出来。
  模型层规格 §7.7 定为 `EnhanceInfo` 加 `noOffPicks: ModelPick[]`（第一个候选的档案 `reasoning.off_refused` 为真的范围，没有档案按假），
  `effortPicks` 不变（录下的回放 fixture 照样有效）；没有采用把 `effortPicks` 的值改成对象的建议。规格 §8 `enhance.get` 一行与 §10.4
  加 2026-10-24 注。见“来源”的 `noOffPicks` 一行与“设置对话框”的 `Effort` 没有 Off。

待回答：没有。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 增强一块 | `data-testid="memory-enhance"`（只在 `Project`） |
| 开关 | `enhance-switch`（`role="switch"`、`aria-checked`） |
| 状态行 | `enhance-status`（`Couldn’t run enhancement: …` 也写在这里） |
| 按钮 | `enhance-run`、`enhance-settings` |
| 开关失败 | `data-testid="enhance-error"`（本表定，临时） |
| 设置对话框 | `enhance-dialog`，内含 `enhance-model`、`enhance-effort`、`enhance-team`、`enhance-time`、`enhance-save`；`Choose a time.` 与保存失败的文字是对话框里的 `role="alert"`（本表定，临时） |
| `Effort` 的强度（2026-10-24，模型层规格 §7.7） | `enhance-effort` 里每档一个 `option`，`value` 为强度（现有代码）；所选范围在 `info.noOffPicks` 里时没有 `option[value="off"]`（MP-39）；存的是 Off 时 `enhance-effort` 的 `value` 为 `minimal`，不动它保存时 `enhance.set` 的 `thinking` 为 `off` |
