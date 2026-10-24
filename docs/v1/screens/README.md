# 屏幕状态表（v1：模型层、平行 Agent 与 TaskBoard、提示词分层与记忆）

每屏一张状态表：状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作。实现该屏之前写好，实现与测试都以它为准（AGENTS.md 第 1 条）。
依据：模型层的表按 [统一模型提供商构建规格](../../specs/model-providers.md)（在这几个文件里称“规格”），它实现 [统一模型提供商 Proposal](../../proposals/model-providers.md) 第四版；
`team-*.md` 按 [平行 Agent 与 TaskBoard 构建规格](../../specs/parallel-agents-taskboard.md)（在 `team-*.md` 里称“规格”，本文件称“TaskBoard 规格”），
它实现 [平行 Agent 与 TaskBoard Proposal](../../proposals/parallel-agents-taskboard.md) 第四版；
`memory-*.md` 与 `settings-issues.md` 按 [提示词分层与记忆构建规格](../../specs/memory.md)（在这几个文件里称“规格”，本文件称“记忆规格”），
它实现 [提示词分层与记忆 Proposal](../../proposals/prompt-and-memory.md) 第一版（2026-10-22）。
[models-settings.md](models-settings.md) 与 [first-run.md](first-run.md) 里拉取模型的部分（提供商表单的 Fetch models、清单、列表错误、Add a model ID、
More settings，卡片上的 Fetch models，模型行的“not reported”与“Server reports …”提示，首次启动表单）按
[一键拉取模型构建规格](../../specs/model-discovery.md)（first-run.md 与本文件称“发现规格”），它扩展模型层规格，实现
[一键拉取模型 Proposal](../../proposals/model-discovery.md) 第一版（2026-10-23）。

“来源”只能是：规格 §9.5 的事件（`mori.model_state`、`mori.model_switch`、`mori.model_rebuild`、`mori.model_wait`、
`mori.model_queue`、`mori.model_retry`、`mori.model_unavailable`、`mori.profiles`、`mori.key_status`）、命令的结果（`models.*`、
`session.setPick`、`connection.test`、`config.get`）、`SessionInfo` 里的 `ModelState`、会话文件里的自定义条目
（`mori.model_switch`、`mori.rebuild`）、v0 已有的 pi 事件与后台进程事件，或你刚做的操作；没有来源的状态不显示。
拉取模型的部分另有发现规格 §5、§7.2 的来源：`models.discover` 的结果（`DiscoverResult`：`error`、`cancelled`、`server` 的 `kind` 与 `version`、
`api`、`baseUrl`、`name`、`anthropicShape`、`listError`、`truncated`、`notListed`，以及 `models` 里每个 `DiscoveredModel` 的值、`reported`、`chat`、
`hints`、`unusable`、`added`）、`models.discoverCancel` 与 `models.addModels` 的结果（`error`）、`ProfileView.reported`
（`models.get` 与 `mori.profiles` 的档案里服务报告的窗口、输出上限、思考、图片；档案没有 `meta` 时为 null；Ollama 只读到训练窗口时窗口为 null，
发现规格 §7.2），以及 `shared/models.ts` 的 `suggestZone`（按表单里的 Base URL 预选区域，发现规格 §3.4）与 `SERVER_KIND_LABELS`
（Detected 一行的种类名，§3.3）。首次启动表单还用到你在这张表单里最后填过的 key（只在表单内存里，发现规格 §6.6），属于“你刚做的操作”。
思考关不掉的模型（2026-10-24 补丁，规格 §7.7）另有一个来源：`ProfileView.reasoning.off_refused`（`models.get` 与 `mori.profiles` 的档案；
第 2 步关闭思考被服务以 400 或 422 拒绝、开思考（`medium`）有正文时为真，旧档案没有这个字段时读作 `false`），档案摘要的“Thinking: Can’t be turned off”与
模型表单（Edit）的 Default effort for new sessions 不列 Off 按它；增强设置的 Effort 不列 Off 不按它，按 `EnhanceInfo.noOffPicks`（见下面 `memory-*.md` 的来源）；
输入框下面一行的 Effort 菜单底部的“This model can’t turn thinking off.”按已有的 `ModelState.reasoning` 与 `ModelState.thinkingLevels`
（当前模型支持思考而强度里没有 `off`），不另加来源。第 2 步的说明“Thinking can’t be turned off: <原文>”只存在档案文件
（`model-profiles.json`）第 2 步的结果里，`ProfileView` 不带，不是界面的来源，界面不显示（规格 §7.7）。
`team-*.md` 另有 TaskBoard 规格 §13.10–§13.11 的来源：事件（`mori.team_state`、`mori.board`、`mori.receipt`、`mori.progress`、`mori.wake`、
`mori.team_deciding`、`mori.team_approval_request`、`mori.team_approval_end`）、命令的结果（`session.setTeam`、`board.get`、`session.recheckAgents`、
`session.stopTeam`、`session.clearQueue` 的 `texts`；`session.prompt` 的 `team: 'once'`、`approval.answer` 的后台 `requestId`）、
`SessionInfo` 与 `LiveSnapshot` 的 `team`、`board`、`teamApprovals`、`deciding`，`LiveStatus` 的 `teamBusy`、`teamApproval`，
`ModelState` 的 `pickLocked` 与 `blocked.kind` 的 `agents_invalid`，会话文件里的 `mori.receipt`、`mori.progress`、`mori.wake`（`mori.team` 不显示）。
`memory-*.md` 与 `settings-issues.md` 另有记忆规格 §8 的来源：命令的结果（`memory.list`、`memory.get`、`memory.save`、`memory.delete`、`memory.move`、
`memory.revisions`、`memory.rollback`、`enhance.get`、`enhance.set`、`enhance.run`；`error` 只有原因，界面加前缀；
`enhance.get` 的结果和 `enhance.set` 的 `info` 都是 `EnhanceInfo`，2026-10-24 起含 `noOffPicks: ModelPick[]`：第一个候选（按记忆规格 §9.1 的取法，同 `effortPicks`）
的档案 `reasoning.off_refused` 为真的那些范围，没有档案按假，增强设置的 Effort 不列 Off 按它；`effortPicks` 不变（规格 §7.7，记忆规格 §8 的 `enhance.get` 一行））、全局事件（`mori.memory_changed`、`mori.enhance_progress`）、
`SessionInfo.memoryNotice`（只有 `session.create` 带）、memory 工具结果的 `details`（`revision`、`kind`、`layer`、`entry`，实时的与会话文件里的）、
`agents.get` 新加的 `loaded: { path, tokens }[]`、`userTokens`、`total`，以及主进程的 `mori:issues-*` 通道（由 `mori:review-*` 去掉反馈部分改名）
和已有的 `mori:read-file`（反馈依据的 `Jump to source` 用它只读地读 `<userData>\feedback\<文件名>`）。

| 文件 | 内容 | 取代 v0 的 |
| --- | --- | --- |
| [models-settings.md](models-settings.md) | 设置 → Models：迁移说明、区域未确认与 Confirm zone、Defaults、Providers（提供商卡、提供商表单的 Base URL 与 API key → Fetch models → 清单 → Add、清单、列表错误、Add a model ID、More settings、卡片上的 Fetch models 与 Not listed by the server、Keys、Models 行与 not reported、Server reports … 提示与 Use、模型表单（只剩 Edit）、档案摘要、需要同意的探针）、Groups、Project access、删除与改地址的确认、配置读不出（拉取模型的部分按发现规格） | [v0 settings.md](../../v0/screens/settings.md)“Connections and models” |
| [first-run.md](first-run.md) | 首次启动表单（Base URL 与 API key → Fetch models → 清单、Name、API type、网络区域、Add a model ID、More settings 里的兼容选项（只在 OpenAI-compatible 时显示）、探针代价一句；拉取中两个框只读、再拉一次、保存后用内存里的 key 再拉取；没有关闭表单的 Cancel）、Test connection（先保存勾选的全部模型，再测第一个勾选的）、这个模型的探针状态、默认范围（一个模型时是它，多个时是提供商）、Public 的说明、迁移失败（按规格与发现规格 §5.4、§6.1、§6.6） | [v0 connection.md](../../v0/screens/connection.md) 的表单与首次启动 |
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
- 思考关不掉的模型的文字按规格 §7.7 原文（2026-10-24 补丁）：档案摘要“Thinking: Can’t be turned off”、Effort 菜单底部“This model can’t turn thinking off.”，
  探针出错的说明“Stopped at the probe output limit before answering”（同其他出错原文，出现在“Couldn’t verify: …”后面）；
  第 2 步的说明“Thinking can’t be turned off: <原文>”只存在档案文件（`model-profiles.json`）里，界面不显示（[v0/ui-strings.md](../../v0/ui-strings.md) 设置一节）。
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

1. （已答：发现规格 §3.4，界面照现在的规则用 `shared/models.ts` 的 `suggestZone` 按 Base URL 预选）新地址的建议区域从哪里来（models-settings.md、first-run.md）。
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
12. （已回答：发现规格 §5.4、§6.1–§6.3、§6.5、§6.6）拉取模型的界面问题（models-settings.md 九条、first-run.md 九条）都已由修订后的发现规格回答，
    两个文件里不再有待回答的：
    - 拉取中 Base URL、API key 只读；提供商表单的 Cancel 照样可用，关闭表单（Cancel、打开别的表单、离开设置页）先发 `models.discoverCancel`（§6.1）；
    - 拉取后 Fetch models 仍在 API key 下方，再点或改 Base URL、key 就从头来（清单与手填的行清掉）；Name、API type、Network zone、More settings 里
      你改过的值不被下次拉取覆盖，没改过的重新预填；改过的 API type 作为 `target.api` 发出；改 API type 不清掉清单（§6.1）；
    - 建议的 Base URL 两边去掉首尾空白和结尾 `/` 后比较，不同才换框；“Updated to <url> so the model list loads.”只在拿到列表时显示（§6.1 第 3 项）；
    - Select all、Clear selection 只作用于显示着的、能勾的行；过滤不分大小写，藏起来的勾选行照样加入；手填的行算进 20 行；“Not reported”改值后仍在；
      空列表为“Models (0)”和“The server didn’t list any models.”（§6.2）；列表错误时手填的行列在错误一句下面，没有标题、Select all、Clear selection 和过滤框（§6.3）；
    - 卡上的清单不显示 Detected，清单开着时卡上的 Fetch models 不可用（§6.5）；Edit 里没设过强度的模型显示 `config.get` 的 `defaultThinkingLevel`（§5.4）；
    - 首次启动有探针代价一句、没有关闭表单的 Cancel、More settings 只有兼容选项且非 OpenAI-compatible 时不显示、保存后框空时用内存里的 key 再拉取（§6.6）。
13. （已回答：规格 §7.7）思考关不掉的模型（2026-10-24 补丁）：
    - 增强设置的 `Effort` 怎样知道“第一个候选没有 Off”（memory-enhance.md）：`enhance.get` 的 `EnhanceInfo` 加 `noOffPicks: ModelPick[]`，
      是第一个候选（按记忆规格 §9.1 的取法，同 `effortPicks`）的档案 `reasoning.off_refused` 为真的那些范围，没有档案按假；
      `effortPicks` 不变（仍表示是否标了 Supports thinking，录下的回放 fixture 照样有效），没有采用把 `effortPicks` 的值改成对象的建议。
      所选范围在 `noOffPicks` 里时 Effort 不列 Off；已经存成 Off 的照存，显示为 Minimal。记忆规格 §8 的 `enhance.get` 一行与 §10.4 的 Effort 一行已加 2026-10-24 注。
    - 第 2 步的说明“Thinking can’t be turned off: <原文>”显示在哪里（models-settings.md 原来作为本表定的细节）：只存在档案（`model-profiles.json`）
      第 2 步的结果里，`ProfileView` 不带，界面不显示；设置页看到的是档案摘要的“Thinking: Can’t be turned off”。
    - 第 2 步 `off` 被拒、`medium` 出错或没有正文时这一步是出错，“Couldn’t verify: …”后面的说明：`medium` 出错时用它的说明
      （可能是“Stopped at the probe output limit before answering”），`medium` 没出错但没有正文时用 `off` 的原文。

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
| `profile` 里的 `[data-field="thinking_off"][data-value="refused"]` | 档案摘要的“Thinking: Can’t be turned off”，只在 `ProfileView.reasoning.off_refused` 时有（规格 §7.7，2026-10-24 补丁） | models-settings.md |
| `confirm-dialog`（`data-kind`）、`cascade`、`public-dialog` | 确认框 | models-settings.md |
| `group-row`、`group-member`、`member-picker`、`group-form`、`group-error`、`groups-empty` | Groups | models-settings.md |
| `project-row`、`project-zone`、`project-config-error`、`projects-empty` | Project access | models-settings.md |
| `field-error`（`data-field`） | 提供商表单、模型表单、首次启动表单的字段错误 | models-settings.md、first-run.md |
| `form-message` | 表单的结果文字（沿用 v0） | models-settings.md、first-run.md |
| `data-action="test-cancel"` | 三处测试与首次启动测试中的“Cancel” | models-settings.md、first-run.md |
| `connection-form`、`first-run-loading`、`migration-error`、`zone-public-note`、`probe-status`、`open-folder` | 首次启动（`connection-form`、`open-folder` 沿用 v0） | first-run.md |
| `data-action="fetch-models"`、`data-action="fetch-cancel"`、`fetch-status`（`data-state` 为 `fetching` / `cancelled`）；拉取中 Base URL、API key 输入框的 `readonly`；`data-action="close-form"` | 提供商表单、首次启动表单与提供商卡上的 Fetch models（卡上的取代 `data-action="add-model"`）、拉取中的 Cancel、拉取的状态、拉取中只读的两个框（发现规格 §6.1、§6.5）；提供商表单与卡上清单底部关闭用的 Cancel（拉取中照样可用；首次启动没有） | models-settings.md、first-run.md |
| `detected-server`（`data-kind` 为 `ServerKind`）、`base-url-note` | 认出的服务（卡上的清单不显示）、Base URL 换成建议值的说明（只在拿到列表时，发现规格 §6.1 第 3 项） | models-settings.md、first-run.md |
| `list-error`（`data-kind` 为 `rejected` / `unreachable` / `no_list` / `invalid`） | 列表错误（发现规格 §6.3） | models-settings.md、first-run.md |
| `checklist`、`data-action="select-all"`、`data-action="clear-selection"`、`checklist-filter`、`checklist-truncated` | 清单、Select all、Clear selection、过滤框、“Showing the first 1,000 models.”（发现规格 §6.2） | models-settings.md、first-run.md |
| `discovered-row`（`data-model`；`data-chat` 为 `true` / `false` / `unknown`；`data-added="true"`、`data-unusable="true"`）、行的勾选框 `input[name="pick"]`；行内输入框的 `data-field` 为 `contextWindow`、`maxTokens`、`reasoning`、`image`（`settings/fields.tsx` 模型字段的名字，同字段错误的 `data-field`） | 清单的行（`data-added` 只在提供商卡的清单里） | models-settings.md、first-run.md |
| `not-reported`（`data-field`）、`row-tag`（`data-kind` 为 `not-chat` / `added` / `unusable` / `entered`）、`row-hint`（`data-kind` 为 `no_tools` / `trained_window`） | 清单行的 Not reported、标记与提示；`not-reported` 也用在 Models 行 | models-settings.md、first-run.md |
| `manual-model`（Model ID 输入框 `data-field="id"`）、`data-action="add-to-list"` | Add a model ID 一行与 Add to list（发现规格 §6.4） | models-settings.md、first-run.md |
| `more-settings`、`probe-cost-note` | More settings（首次启动里只有兼容选项，API type 不是 OpenAI-compatible 时不显示）、探针代价的说明（提供商表单与卡上清单的底部，首次启动在 Test connection 上方，发现规格 §6.1 第 8 项、§6.6） | models-settings.md、first-run.md |
| `data-action="add-models"`、`not-listed` | 清单底部的 Add 按钮（Add 1 model / Add N models）、卡片清单下的 Not listed by the server（发现规格 §6.5） | models-settings.md |
| `model-hint`（`data-kind` 为 `context` / `max-output` / `reasoning` / `thinking-seen` / `image`）、`data-action="use-reported"` | Models 行的 Server reports … 提示与 Use（发现规格 §8） | models-settings.md |
| `model-button`、`model-menu`、`model-menu-note`、`pick-error` | 输入框下面一行的范围按钮与菜单（前两个沿用 v0） | model-menu.md |
| `thinking-button`、`thinking-menu` | 思考强度（沿用 v0） | model-menu.md |
| `thinking-off-note` | 思考强度菜单底部的“This model can’t turn thinking off.”：当前模型支持思考而 `thinkingLevels` 里没有 `off` 时（规格 §7.7、§9.2，2026-10-24 补丁） | model-menu.md |
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
