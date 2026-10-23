# 屏幕状态表（v1：模型层、平行 Agent 与 TaskBoard、提示词分层与记忆）

每屏一张状态表：状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作。实现该屏之前写好，实现与测试都以它为准（AGENTS.md 第 1 条）。
依据：模型层的表按 [统一模型提供商构建规格](../../specs/model-providers.md)（在这几个文件里称“规格”），它实现 [统一模型提供商 Proposal](../../proposals/model-providers.md) 第四版；
`team-*.md` 按 [平行 Agent 与 TaskBoard 构建规格](../../specs/parallel-agents-taskboard.md)（在 `team-*.md` 里称“规格”，本文件称“TaskBoard 规格”），
它实现 [平行 Agent 与 TaskBoard Proposal](../../proposals/parallel-agents-taskboard.md) 第四版；
`memory-*.md` 与 `settings-issues.md` 按 [提示词分层与记忆构建规格](../../specs/memory.md)（在这几个文件里称“规格”，本文件称“记忆规格”），
它实现 [提示词分层与记忆 Proposal](../../proposals/prompt-and-memory.md) 第一版（2026-10-22）。

“来源”只能是：规格 §9.5 的事件（`mori.model_state`、`mori.model_switch`、`mori.model_rebuild`、`mori.model_wait`、
`mori.model_queue`、`mori.model_retry`、`mori.model_unavailable`、`mori.profiles`、`mori.key_status`）、命令的结果（`models.*`、
`session.setPick`、`connection.test`、`config.get`）、`SessionInfo` 里的 `ModelState`、会话文件里的自定义条目
（`mori.model_switch`、`mori.rebuild`）、v0 已有的 pi 事件与后台进程事件，或你刚做的操作；没有来源的状态不显示。
`team-*.md` 另有 TaskBoard 规格 §13.10–§13.11 的来源：事件（`mori.team_state`、`mori.board`、`mori.receipt`、`mori.progress`、`mori.wake`、
`mori.team_deciding`、`mori.team_approval_request`、`mori.team_approval_end`）、命令的结果（`session.setTeam`、`board.get`、`session.recheckAgents`、
`session.stopTeam`、`session.clearQueue` 的 `texts`；`session.prompt` 的 `team: 'once'`、`approval.answer` 的后台 `requestId`）、
`SessionInfo` 与 `LiveSnapshot` 的 `team`、`board`、`teamApprovals`、`deciding`，`LiveStatus` 的 `teamBusy`、`teamApproval`，
`ModelState` 的 `pickLocked` 与 `blocked.kind` 的 `agents_invalid`，会话文件里的 `mori.receipt`、`mori.progress`、`mori.wake`（`mori.team` 不显示）。
`memory-*.md` 与 `settings-issues.md` 另有记忆规格 §8 的来源：命令的结果（`memory.list`、`memory.get`、`memory.save`、`memory.delete`、`memory.move`、
`memory.revisions`、`memory.rollback`、`enhance.get`、`enhance.set`、`enhance.run`；`error` 只有原因，界面加前缀）、全局事件（`mori.memory_changed`、`mori.enhance_progress`）、
`SessionInfo.memoryNotice`（只有 `session.create` 带）、memory 工具结果的 `details`（`revision`、`kind`、`layer`、`entry`，实时的与会话文件里的）、
`agents.get` 新加的 `loaded: { path, tokens }[]`、`userTokens`、`total`，以及主进程的 `mori:issues-*` 通道（由 `mori:review-*` 去掉反馈部分改名）
和已有的 `mori:read-file`（反馈依据的 `Jump to source` 用它只读地读 `<userData>\feedback\<文件名>`）。

| 文件 | 内容 | 取代 v0 的 |
| --- | --- | --- |
| [models-settings.md](models-settings.md) | 设置 → Models：迁移说明、区域未确认与 Confirm zone、Defaults、Providers（提供商卡、提供商表单、Keys、Models 行、模型表单、档案摘要、需要同意的探针）、Groups、Project access、删除与改地址的确认、配置读不出 | [v0 settings.md](../../v0/screens/settings.md)“Connections and models” |
| [first-run.md](first-run.md) | 首次启动表单（含网络区域）、Test connection、探针状态、Public 的说明、迁移失败 | [v0 connection.md](../../v0/screens/connection.md) 的表单与首次启动 |
| [model-menu.md](model-menu.md) | 输入框下面一行的选择范围按钮与菜单、按当前模型的思考强度菜单、准备中与生成中不可用 | [v0 models.md](../../v0/screens/models.md) |
| [model-chat.md](model-chat.md) | 换模型与重建的提示、阶段行（等模型、等它停下、排队、重试、重建）、准备中、No model available 卡、拒绝启动卡、v0 错误卡的规则 | [v0 chat.md](../../v0/screens/chat.md) 的阶段行重试、错误卡“Go to settings”、v0 的模型按钮 |
| [team-switch.md](team-switch.md) | 顶栏的协作开关（Off / On / Until done、窄栏、不可用）、`/team on`、`/team off`、`/team <文字>`、只有 `/team`，模式怎样变 | 补充 [v0 chat.md](../../v0/screens/chat.md) 的顶栏与输入框 |
| [team-stream.md](team-stream.md) | 回执、进展摘要（位置、折叠与展开、需求状态、task 的 phase 文字、交接链）、不显示的程序投递与回合、合并会话里立项工具的卡、重新打开 | 补充 [v0 chat.md](../../v0/screens/chat.md) 的对话流 |
| [team-approvals.md](team-approvals.md) | 后台实例的批准卡与归属、和对话自己的卡怎样排、全部允许与本会话不再询问作用于全部 Agent、权限菜单说明、侧栏状态、F8 计数 | 补充 [v0 approval.md](../../v0/screens/approval.md) |
| [team-stop.md](team-stop.md) | 待判断的消息（`<create role> is deciding…`、排队区的 `Waiting for <create role>`、撤回）、Esc 与 `Stop team`、回到输入框的文字、侧栏“Running”、正在生成时不能归档删除 | 补充 [v0 chat.md](../../v0/screens/chat.md) 的排队区与停止、[model-chat.md](model-chat.md) 的准备中、[v0 sessions.md](../../v0/screens/sessions.md) 的状态与归档删除 |
| [team-blocked.md](team-blocked.md) | `agents_invalid` 的拒绝启动卡（§4.4 的每一行、Check again）、`Turn off team mode`、协作模式下锁定的模型按钮、右栏的后台改动说明 | 补充 [model-chat.md](model-chat.md) 的拒绝启动卡、[model-menu.md](model-menu.md) 的按钮、[v0 changes.md](../../v0/screens/changes.md) |
| [memory-page.md](memory-page.md) | 记忆页：左栏 `Memory`、`User` ｜ `Project` 与跟随的项目、六个分节、用量与 `Last change`、列表与读不出来的条目、条目详情（Evidence、Details 与 `[[slug]]`、Linked from、History）、编辑与新增、离开确认、删除、移动、依据回到原位置、AGENT、Revisions 与回滚、数据何时读、后台进程退出 | [v0 review.md](../../v0/screens/review.md)（工作回顾，M7）的入口、页面、反馈部分与回到原位置；[v0 layout.md](../../v0/screens/layout.md) 左栏的“Review” |
| [memory-enhance.md](memory-enhance.md) | 记忆页 `Project` 顶部的增强：开关、状态行（规格 §10.4 的每一种）、`Run now`、`Enhancement settings` 对话框、进度事件 | 新增（v0 没有对应的屏） |
| [memory-chat.md](memory-chat.md) | memory 工具卡（标题、免批准、`View in Memory`、失败）、工具页的 `memory` 行、记忆目录的写保护、新会话顶部的提示、反馈表单的说明与 `Saved` | 补充 [v0 tool-cards.md](../../v0/screens/tool-cards.md)、[v0 tools.md](../../v0/screens/tools.md)；取代 [v0 selection.md](../../v0/screens/selection.md)“反馈”的底部说明与 `Saved · View in Review` |
| [settings-issues.md](settings-issues.md) | 设置 → `UI issues`（列表、详情与截图、Hide resolved、导出、打开文件夹）、F8 的 `View in Settings` 与 `Page`、设置 → AGENTS.md 的 token 数与超出标记 | [v0 review.md](../../v0/screens/review.md) 的 UI issues 部分与主进程通道；[v0 f8.md](../../v0/screens/f8.md) 的 `View in Review`；补充 [v0 settings.md](../../v0/screens/settings.md) 的 AGENTS.md 节 |

时刻 `hh:mm:ss` 一律是本地时间（24 小时制，`shared/models.ts` 的 `formatClock`），由事件里的毫秒时刻（`until`）换算。
记忆的几张表里日期写 `<Mon D>`（例如 `Oct 22`），时间写 `<Mon D> <hh:mm>`（本地时间，24 小时制，`shared/memory.ts` 的 `monthDay`、`monthDayTime`）。
`<provider>/<model>` 是模型的全名（规格 §1）。

## 界面文字

- 本目录写到的新界面和改写的界面用英文，按规格原文（规格 §0、§9）；与 english-ui 合并后（2026-10-21）按 [v0/ui-strings.md](../../v0/ui-strings.md) 的术语和写法统一（例如 Base URL、Model ID、Effort、弯撇号 ’）。规格没给文字的地方，各文件写了一个短的英文文字并标
  “（临时，走查时可以改）”，每个文件末尾的“本表定下的界面细节”列出这些决定。
- 规格让界面“沿用 v0”的几处：Test connection 的结果规格 §9.1 已给英文（“Connected · First token Nms · Total Nms”等）；
  模型按钮生成中的悬停规格 §9.2 已给英文（“Can’t switch models until the response finishes”）；思考强度菜单（强度名、
  “Effort: High”、生成中的悬停）、v0 错误卡的“Put your last message back in the message box”、“Stopped · …”
  “Compacted session”、排队区的“Queued”都是 english-ui 定的英文（v0/ui-strings.md）。
- 设置页左侧的分节按钮写“Models”（规格 §9.1 的叫法），“AGENTS.md”分节与“Back to app”不变。
- 区域在标签、单选、勾选框、标记里写作 Local / Intranet / Public；在句子里写区域代码（`local`、`intranet`、`public`），
  例如“Allow public for this project”“zone public is not allowed for this project”（规格 §4.6、§5.3、§9.1）。
- `team-*.md` 的新界面文字按 TaskBoard 规格 §13 原文（`Team: Off`、`Request 1 registered · <title>`、`Stop team`、`Fix the agent files` 等）；
  它们改到的 v0 界面（“Stop”“Queue”“Steer”“Withdraw”“Stopped · Changes made so far stay as they are”、批准卡的三个选项
  “Allow once”“Allow “…” for this session”“Deny”、“N more”、侧栏状态“Running”“Needs approval”）用 [v0 ui-strings.md](../../v0/ui-strings.md) 的英文
  （与 `english-ui` 合并后，2026-10-21）。角色名、需求和 task 的标题原样显示；基座的角色名 `mori` 显示为 `Mori`。
- `<create role>`、`<close role>` 取 `TeamState.holders` 的 `create`、`close`；进展摘要“当前在做什么”的英文动词见 team-stream.md。
- `memory-*.md` 与 `settings-issues.md` 的新界面文字按记忆规格 §10 原文（`Memory`、`You said`、`Learned`、`Jump to source`、`Roll back this revision`、`Enhancement` 等）；
  记忆规格自己标“临时”的文字（登记在记忆规格 §12 与 [v1/defaults.md](../defaults.md)）写作“（临时，规格 §12）”，规格没给、各表定的写作“（临时，走查时可以改）”。
  设置页左侧多了第三节 `UI issues`（记忆规格 §10.8），它的文字沿用 M7 的英文（[v0 review.md](../../v0/screens/review.md)）。种类名 `TASTE`、`STRATEGY`、`REVIEW` 全大写，事实写 `Facts`。

## 需要规格回答

不是纯界面细节、规格又没定的数据来源，各文件的“需要规格回答”一节写了详情：

1. 新地址的建议区域从哪里来（models-settings.md、first-run.md）。
2. 菜单里当前范围以外的项是否被本会话静态校验排除，数据从哪里来（model-menu.md）。
3. 换模型提示的“Couldn’t confirm it stopped”由哪个字段标出（model-chat.md）。
4. `agents_invalid` 时协作开关能不能用；TB-03“没有 Team 相关元素”与总在顶栏的开关（team-switch.md）。
5. `TaskView` 没有 `assignee`；交接链截断的位置（defaults.md 与 `shared/team.ts` 不一致）；`current.args` 不够写 TaskBoard 工具的标题；
   进展摘要的英文动词与 v0 工具卡的标题（与 `english-ui` 合并后 v0 工具卡也是英文，team-stream.md）。`RequestView.state`、`holder`、`chain` 的写法已由 `shared/team.ts` 定下，规格应补上。
6. 对话卡与后台卡同时挂着时，正在显示的卡是否被换掉（team-approvals.md）。
7. `Stop team` 的显示条件（`TeamState.busy` 含对话自己的运行）；`Stop team` 时待判断的消息经哪里回到输入框；重新载入的快照没有 `since`（team-stop.md）。
8. 说明卡上的 `Turn off team mode` 是否直接回到 `off`；右栏说明在 `BoardView` 里没有依据；`agents_invalid` 而模式不是 `off`（team-blocked.md）。
   问题列表 `ModelBlocked.problems` 与动作 `turn_off_team` 已由 `shared/models.ts` 定下，规格 §16 应补上。
9. （9–11 问记忆规格）界面怎么认出依据里的 TaskBoard 实例会话（本表按 `<userData>\teams\…\sessions\` 路径判断）；`entry` 为 null 时那一句显示在哪里（跳转后中栏已是会话）（memory-page.md）。
10. `Project` 的用量含用户级，但只改用户级的 `mori.memory_changed` 按“这一层”不重读 `Project`；本表让 `Project` 的前四节也重读（memory-page.md）。
11. 修订详情每处改动的 `<abstract>`：`RevisionChange` 没有这个字段（memory-page.md）。

## 界面测试用的标识（汇总）

同一个标识在各表里含义相同；`data-action` 只在它所在的卡、行或表单里唯一。

| 标识 | 用在 | 文件 |
| --- | --- | --- |
| `settings-page`、`settings-nav` 的 `button[data-section="models"]` | 设置页与 Models 分节 | models-settings.md |
| `models-loading`、`models-load-error`、`migration-notice` | Models 的读取中、配置读不出、迁移说明 | models-settings.md |
| `zone-unconfirmed`、`zone-dialog`、`input[name="zone"][value]` | 区域未确认、Confirm zone 对话框；区域单选也用在 `provider-form`、`connection-form` | models-settings.md、first-run.md |
| `default-pick`、`allowed-zone` | Defaults | models-settings.md |
| `provider-card`、`provider-zone`、`providers-empty`、`test-result`、`provider-form` | Providers | models-settings.md |
| `key-row`、`key-state`、`key-form`、`key-test`、`no-keys` | Keys | models-settings.md |
| `model-row`、`profile`、`truncation-warning`、`probe-error`、`model-test`、`model-form` | Models 行与模型表单（`model-row`、`model-test`、`model-form` 沿用 v0） | models-settings.md |
| `confirm-dialog`（`data-kind`）、`cascade`、`public-dialog` | 确认框 | models-settings.md |
| `group-row`、`group-member`、`member-picker`、`group-form`、`group-error`、`groups-empty` | Groups | models-settings.md |
| `project-row`、`project-zone`、`project-config-error`、`projects-empty` | Project access | models-settings.md |
| `field-error`（`data-field`） | 提供商表单、模型表单、首次启动表单的字段错误 | models-settings.md、first-run.md |
| `form-message` | 表单的结果文字（沿用 v0） | models-settings.md、first-run.md |
| `data-action="test-cancel"` | 三处测试与首次启动测试中的“Cancel” | models-settings.md、first-run.md |
| `connection-form`、`first-run-loading`、`migration-error`、`zone-public-note`、`probe-status`、`open-folder` | 首次启动（`connection-form`、`open-folder` 沿用 v0） | first-run.md |
| `model-button`、`model-menu`、`model-menu-note`、`pick-error` | 输入框下面一行的范围按钮与菜单（前两个沿用 v0） | model-menu.md |
| `thinking-button`、`thinking-menu` | 思考强度（沿用 v0） | model-menu.md |
| `notice`（`data-kind="model-switch"` / `"rebuild"`）、`stage`（`data-kind`）、`queue`、`error-card` | 对话流提示、阶段行、排队区、错误卡（`notice`、`stage`、`queue`、`error-card` 沿用 v0） | model-chat.md |
| `unavailable-card`、`blocked-card`、`candidate` | No model available 卡、拒绝启动卡、卡里的候选行 | model-chat.md |
| `data-action="open-settings"` | 说明卡、拒绝启动卡、思考菜单里打开 设置 → Models 的按钮 | model-chat.md、model-menu.md |
| `data-action="verify"` | 模型行的 Verify、首次启动的 Verify again、拒绝启动卡的 Verify now | 三个文件 |
| `team-switch`（`role="switch"`、`aria-checked`、`data-mode`）、`team-error` | 协作开关、切换失败（`team-error` 该文件定，临时） | team-switch.md |
| `receipt`（`data-kind`、`data-request`） | 回执 | team-stream.md |
| `progress`（`data-request`、`data-state`）、`progress-task`（`data-task`、`data-phase`）、`progress-chain`、`progress-ruled-out`、`progress-conclusion` | 进展摘要（后三个该文件定，临时） | team-stream.md |
| `approval-card` 的 `data-agent`、`data-task`；`approval-attribution` | 后台批准卡的归属（`approval-card` 沿用 v0；`approval-attribution` 该文件定，临时） | team-approvals.md |
| `stop-team`；`stage` 的 `data-kind="deciding"`；`queue` 里的 `data-deciding="true"` | Stop team、立项判断的阶段行、待判断的消息（后两个该文件定，临时） | team-stop.md |
| `blocked-card[data-kind="agents_invalid"]`、`agent-problem`；`data-action="check-agents"`、`data-action="turn-off-team"` | 角色文件的拒绝启动卡、问题行、Check again、Turn off team mode（`agent-problem` 该文件定，临时） | team-blocked.md |
| `model-button` 的 `data-locked="true"` | 协作模式下锁定的模型按钮（该文件定，临时） | team-blocked.md |
| `team-changes-note` | 右栏的后台改动说明 | team-blocked.md |
| `nav-memory`、`memory-page`、`memory-scope-user`、`memory-scope-project`、`memory-section-<facts\|taste\|strategy\|review\|agent\|revisions>` | 记忆页的入口、页面、层与分节（记忆规格 §10.11） | memory-page.md |
| `memory-usage`、`memory-last-change`、`memory-new`、`memory-list`、`memory-row`（`data-id`、`data-source`）、`memory-broken` | 前四节的用量与列表 | memory-page.md |
| `memory-detail`、`memory-evidence`、`memory-jump`、`memory-jump-status`、`memory-backlinks`、`memory-history`、`memory-error`、`memory-edit`、`memory-delete`、`memory-move` | 条目详情 | memory-page.md |
| `memory-form`（`memory-abstract`、`memory-details`、`memory-save`）；`leave-dialog` | 编辑与新增、离开确认（`leave-dialog` 沿用 v0） | memory-page.md |
| `memory-agent-file`、`memory-agent-total` | 记忆页的 AGENT | memory-page.md |
| `revision-row`（`data-id`）、`revision-detail`、`revision-rollback` | Revisions 与回滚 | memory-page.md |
| `memory-enhance`、`enhance-switch`、`enhance-status`、`enhance-run`、`enhance-settings`、`enhance-dialog`（`enhance-model`、`enhance-effort`、`enhance-team`、`enhance-time`、`enhance-save`）；`enhance-error` | 增强一块与设置对话框（`enhance-error` 该文件定，临时） | memory-enhance.md |
| `tool-memory-view`、`memory-notice`、`memory-notice-view`、`feedback-note`、`feedback-saved` | 工具卡的 View in Memory、新会话提示、反馈表单（提示里 `Dismiss` 的 `data-action="dismiss"` 该文件定，临时） | memory-chat.md |
| `settings-nav` 的 `button[data-section="issues"]`；`issues-*`（由 M7 的 `review-*` 改名）；`issue-open-settings` | 设置页的 UI issues、F8 的 View in Settings | settings-issues.md |
| `agents-tokens`、`.agents-tokens`、`agents-over` | 设置页 AGENTS.md 节的 token 数与超出标记 | settings-issues.md |
