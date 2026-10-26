# Customize › Agents（M20）检查记录

依据：2026-10-26 负责人走查 M20（"I can't find team mode setup panel, where can I setup model for each role and add extra agent?"，
[../walkthrough-1026-checks.md](../walkthrough-1026-checks.md)）、负责人批准的 [Customize › Agents 规格](../../specs/customize-agents.md)
与状态表 [../screens/customize-agents.md](../screens/customize-agents.md)。分支 `v1-customize-agents`，从本地 `app-v0` 开出，
合入过 WP-07（`58138cc`）、WP-08（`3aa835c`）、WP-21（不留未完成项，`f613281`）、WP-02（`10624c6`）、
WP-05（`34fa29a`）、WP-09（`e55b28b`）与第二波的 WP-10、WP-14（`d07cc41`，合并提交 `2d1939a`）；没有推送，没有合进 `app-v0`。

## 改了什么、为什么

负责人找不到给每个角色设模型、加 agent 的地方：今天唯一的办法是手写 `<project>/.mori/agents/*.md`。现在 Customize 有一节
“Agents”（Skills 之后、MCP 之前，只在有会话时出现）：

- **列表**：基座 Mori（`Built-in`，持有没人认领的职责）和这个项目的每个 agent 文件（`Project`，按文件名），每行说明的第一行、
  职责（`Talks to you` / `Plans requests` / `Closes requests`）和模型的一句话（`Models: <id> and <n> more`、
  `<k> of <n> models can’t run`、`No model can run this agent`、`No model range picked`）。有问题的文件标 `Can’t be used`，
  列出与 “Fix the agent files” 卡上相同的问题行，列表上方一行警示。
- **展开**：Models（会话的范围或 `Tries these in order:`，每个候选 `Ready` 或选择器的原因原文，例如 `handoff tier C is below B`）、
  Model needs（白话，handoff tier 的说明）、Tools、Other settings、Prompt、File（Edit、Open in default app、Delete…）。
- **New agent / Edit 表单**：Name、Description（n/200）、Jobs、Models（会话的范围，或 Add model range 加、拖动排序的列表，
  拖动排序用 Settings › Models 的同一个组件）、
  Tools（Same as Mori，或 pi 的 8 个工具与 All MCP tools）、Prompt。保存前用会话打开时的同一套规则检查，合格才写；
  编辑时文件名不变，`requires`、`differ_from`、`subscribe` 原样写回。有改动时离开先问。
- **后台进程**：`roles.get`、`roles.save`、`roles.delete`（`kernel/roleCommands.ts`）；`roles.ts` 拆出逐个文件的
  `inspectRoleFiles`（`parseRoleFiles` 用它，结果不变）、`readRoleFiles`、`nameProblems`；`roleFiles.ts` 写文件全文（只用 JSON
  写法，不加依赖）；`selector.ts` 导出 `staticExclusion` 与 `pickItems`（范围菜单的顺序与文字）；`sessions.ts` 的 `sessionPick`。
  对应方案第 6 节第 7 件（平行 Agent 与 TaskBoard）。
- **模型菜单的 Manage agents**（WP-09 合入后做）：Task mode 一组（`.task-mode-group`）的最后、`Manage models` 之前一项
  `Manage agents`，菜单的三种样子（一般、回复进行中、Task mode）都有；点或 Enter 关菜单，打开 Customize 并选中 Agents
  （`openTools('Open Customize → Agents', 'roles')`）。规格 §6.6 原来写 Task mode 下“模型那一节变灰”，WP-09 的菜单是
  没有三节，照 WP-09 改（WP-09 的记录也这样说）。TaskBoard 规格 §12.11、§13.1、TB-38 与 team-switch.md 写到 Task mode
  菜单里有什么的地方加上 `Manage agents`（带日期的注）；TB-38 的检查（`tb-app-models.mjs`）照改，AG-11 的预设加上这个套件。
- **TaskBoard 规格 §4.1、§4.4**：角色文件的 `tools` 可以写 `mcp__*`（全部 MCP 工具，同基座的白名单写法），给表单的
  All MCP tools 用（临时，已问负责人，见下面“等负责人定的”）。

## 测试（按 AGENTS.md“测试分层”，2026-10-26 改）

先写测试再写实现（提交 `945d73c` 在实现 `12e5afc` 之前）：规格 §9.2 的 AG-01–AG-11 每一条在它列出的每一层都有测试，
`tests/unit/spec-ids.test.mjs` 查过（`agents` 已加进 `tests/spec-coverage.mjs` 的 `SPECS`）。

| 层 | 跑了什么 | 结果 |
| --- | --- | --- |
| 检查与构建 | `npm run check`、`npx electron-vite build` | 通过 |
| 单元 | `npm run test:ag-unit`（`ag-unit.json`）、`npm run test:unit`（含 spec-ids 与 MP-38 标记检查）、`npm run test:tb-unit` | 33/33、463/463、334/334；合入 WP-02 之后 33/33、475/475、334/334；合入 WP-05（app-v0 `34fa29a`）之后 33/33、465/465、334/334；合入 WP-10、WP-14（app-v0 `d07cc41`）之后 33/33、477/477、350/350；评审修正之后 40/40、477/477、350/350；改了直引号之后 41/41、477/477、350/350；第二次核对之后 42/42、477/477、350/350 |
| App（只跑这次的用例） | `node tests/ui/ag-app.mjs --only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-09,AG-10`；为行与用例表补的用例再跑 `--only AG-01,AG-02,AG-04,AG-07,AG-09` 与 `--only AG-04`。端口 4960、4961，前后告诉了走查会话 | 除 AG-10 的 `Open Customize → Agents` 一条外全部通过（见下面“没有做完的”）；AG-08 没有跑（等 WP-09）。合入 WP-05 之后再跑第一条命令：44 条通过，失败的仍只有 AG-10 那一条。改用 WP-03 的拖动排序之后跑 `--only AG-04`：11 条全部通过。合入 WP-09、做完 Manage agents 之后跑 `--only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-08,AG-09,AG-10`：49 条全部通过，没有失败。AG-04 的拖动排序检查加上下半边那一次之后再跑 `--only AG-04`：11 条全部通过。合入 WP-10、WP-14 之后再跑 `--only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-08,AG-09,AG-10`：50 条全部通过，没有失败。评审修正之后再跑同一条命令：58 条全部通过；`switchProject` 一条另在去掉修正（`ToolsPage.tsx` 的 key）时跑过一次，它失败（表单与展开的 planner 带到了另一个项目），修正放回后通过。第二次核对之后先跑 `--only AG-02,AG-04,AG-06,AG-08`：31 条全部通过；再跑 AG-01–AG-10 全部（AG-08 的 emptyConfigMenu 删掉全部提供商，排在最后）：61 条全部通过 |
| 快速集 `npm run test:quick`；`tb-app-models.mjs --only sel`（TB-38） | 两者用共用的端口（m0-smoke 的 4319、TaskBoard 的 4600 段），按走查会话的安排在第二波结束、再合一次 `app-v0`（`d07cc41`）之后跑，前后告诉了走查会话 | 快速集 4/4 通过（85 秒：m0-smoke 31、tb-replay 17、mem-replay 17、m1-replay 16）；`--only sel` 7 条全部通过，TB-38 的 Task mode 菜单项是 `team-switch`、`manage-agents`、`manage-models`。评审修正与直引号之后（`4bfda45`）走查会话给了端口，再跑快速集：4/4 通过（85 秒，m0-smoke 31、tb-replay 17、mem-replay 17、m1-replay 16） |
| 改到的现有套件（`--only`，合并前走查会话要求） | `m6-app-settings.mjs --only agentsUser`（4361）；`m6-app-tools.mjs --only noSession,entry,keyboard` 与 `--only noSession,entry,overrideProject,archiveFollow`（4362）；`m6-replay.mjs --only project-skill`；`v1-models-app-reorder.mjs --only handles,models,keys,members,cross,editor,inplace,failure`（4944） | 16/16；26 条通过 1 条失败、33 条通过 1 条失败；10/10；19/19。改过的检查全部通过。两条失败都不是改过的检查，是 `--only` 跳过了它们依赖的 MCP 步骤（这个套件各步骤依赖前一步，只有 entry 能单独跑）：keyboard 的“MCP 一节：Tab 走到服务的开关……”没有服务可走（只有 Add），overrideProject 的“项目覆盖了用户级服务 x 的 enabled……”没有用户级的 x。整套在推送前的 AG-11 里跑 |
| 评审修正改到的现有套件 | `m6-app-tools.mjs` 只把 keyboard 一条检查的条件并成一行、把一行注释并到常量后面（检查的名字与条件不变，评审 15，文件 1999 行）；`v1-models-existing.mjs` 的 AG-11 预设加上 TB-03 的对照构建（评审 7）。两个都用 `node --check` 与 `npm run check` 查过，没有再跑：前者不改任何检查，后者只在推送前的 AG-11 里跑 | — |
| 完整回归、覆盖检查 | 按规则只在负责人要求推送前跑（`npm run test:agents`、`v1-models-existing.mjs --id AG-11`） | — |
| 回放、真实模型 | 不做：这一节不改发给模型的文字、工具、批准或会话事件（规格 §9.1）；`mcp__*` 在角色文件里与基座的白名单是同一个写法 | — |

改到的现有套件（只改了期望的分节列表，改过的检查用 `--only` 跑过，结果见上表；整套在推送前的 AG-11 里跑）：
`m6-app-tools.mjs`（有会话时的分节、Skills 的 ↓ 落在 Agents、Tab 走 14 步；`noSession` 与 `archiveFollow` 两条检查名
里的“五个分节”改成“六个分节”）、`m6-app-settings.mjs`、`m6-replay.mjs`；单元 `taskboard/roles.test.mjs`（`mcp__*` 合格）、
`taskboard/spec-coverage.test.mjs`（规格名多了 agents），都已通过。合入 WP-09 后又改了 `tb-app-models.mjs` 的 TB-38
（Task mode 菜单的项多了 `manage-agents`），加进 AG-11 的预设；它改写了一条检查，按测试分层第 2 条用 `--only sel` 跑
（结果见上表）。`tb-app-roles.mjs` 的 TB-53 只看菜单最后三个直接子元素（说明、`.task-mode-group`、`manage-models`），
`Manage agents` 在 `.task-mode-group` 里，不影响它。

合入 WP-05（网络区域删掉，2026-10-26）：`selector.ts` 的冲突只在注释，保留 `pickItems` 的拆分、用 app-v0 的“第 1、3 步”；
这一节的代码、规格和单元测试里“第 1–3 步”改成“第 1、3 步”，单元测试的静态输入去掉 `zoneOf`、`allowedZones`。
Agents 的界面、文件与原因文字原来就不涉及区域，没有别的改动。

合入 WP-10、WP-14（第二波结束，app-v0 `d07cc41`，合并提交 `2d1939a`）：冲突只在两份文档。TaskBoard 规格的 TB-37、TB-38
用 app-v0 的行，TB-38 里照旧加上 `Manage agents` 与它的依据注；`docs/v1/screens/README.md` 留 app-v0 的 team-switch 行
（`/task`）和 customize-agents 一行。WP-10 给读取类工具加了 `ls`、`/team` 改成 `/task`，Agents 的界面、文件与原因文字
都不涉及；WP-14 折叠工具卡，不涉及 Customize。代码没有别的改动。

统一拖动排序（2026-10-26 走查会话定：Mori 只留一份，后合入的一方统一）：WP-03 已在 app-v0 里，有共用的组件
`components/settings/Reorder.tsx`，所以表单的模型列表改用它（`useReorderRow`、`ReorderHandle`、`ReorderStatus`，`move` 用
`shared/models.ts` 的 `movedItems` 只改表单），原来的拖动代码与 `.agent-drag` 样式删掉。线与变淡的样式在 `models-settings.css`
里加上 `.agent-model-list > li`，表单引入这份样式（同 `FirstRunForm.tsx`、`MemoryEnhance.tsx`）。规格 §6.4 与状态表“选模型”
改写成同一份的行为（柄、上半边与下半边、方向键、播报），AG-04 加一条检查。`Reorder.tsx` 只改了注释，Settings › Models 的
行为不变；它与 `models-settings.css` 是 Settings › Models 的几个列表共用的，合并前用 `--only` 跑了
`v1-models-app-reorder.mjs` 的全部步骤（结果见上表）。

测试时发现的：合成提供商不能叫 `deepseek`（pi 的内置提供商 id，模型配置整份被拒），App 套件改用 `ds`、`zg`。

## 评审修正（2026-10-26）

走查会话在合并前做了一次独立评审（评审时的分支头 `e1b5619`），确认了 17 条，这里逐条改完。先写测试再改：单元的 10 条新用例先跑出失败再改；App 的新用例与修正一起写，修正之后跑通，其中 switchProject 另在去掉修正时跑出失败（见测试表）。5、8 两条在 `5e1ce7f` 里已经做了（m6 的检查名、改到的现有套件用 `--only` 跑过）。

| # | 问题 | 改法 | 用例 |
| --- | --- | --- | --- |
| 1、11 | Edit 勾选工具时按勾选框重排，文件里的 `mcp__github__*` 一类写法被悄悄丢掉 | `shared/roles.ts` 的 `toolsToggled`：没有勾选框的写法原样留在后面；表单不显示它们（推荐，临时默认值，见“等负责人定的”） | 单元 “AG-06 ticking a tool keeps entries the form has no box for (mcp__github__*), after the boxes in their order”；App “AG-06 an MCP entry the form has no box for (mcp__github__*) isn’t shown and stays in the file after Save” |
| 2 | Add model range 与模型菜单不一致：模型只有一节、只写 id，空节也画出来 | `rangeGroups`：Groups、Providers，每个提供商一节 `Models · <提供商名称>`，空节不画（推荐，临时默认值） | 单元 “AG-04 Add model range: Groups, Providers, then one Models · <provider name> per provider; empty ones left out”；App “AG-04 Add model range has the model menu’s sections and words: …”（App 的数据目录加了第三个提供商 kx，与 zg 有同一个模型 id glm-4.6） |
| 3 | 另外五份文档写 Task mode 菜单时没有 Manage agents | team-blocked.md“锁定”、model-menu.md、model-providers.md、v0 models.md“范围菜单”、v0 chat.md“选择范围（v1）”都加上，日期注同 TaskBoard 规格 §12.11 | 见行与用例表 |
| 4 | 有问题的文件那一行显示了说明（§4.1 只有名字、文件、路径、问题） | `fileView` 给有问题的文件空说明 | 单元 “AG-03 a problem file’s view has no description: only its name, file, path and problems”；App “AG-03 a problem file’s row has no description, …” |
| 6 | 行与用例表说覆盖了、检查里没有断言的：Remove、下拉的节、Only these 的工具 | AG-04 加三条检查 | “AG-04 each range in the list has a Remove button; …”、“AG-04 Add model range has the model menu’s sections and words: …”、“AG-04 Only these has a box for each of the eight pi tools (read, bash, edit, write, grep, find, ls, powershell), then All MCP tools” |
| 7 | AG-11 的预设跑 tb-app-roles 却没有 TB-03 的对照构建 | `SUITE_LISTS.agents.app` 前面加 `TB_BASE`；文件头注释与规格 §9.2 AG-11 照改 | 推送前的 AG-11 |
| 9 | AGENTS.md 测试分层第 3 条没有 `ag-*` | 加上 | — |
| 10 | 原样写的 `null`、`true`、`1e3`、`0x1f` 等读回不是字符串，名字叫 `true` 的 agent 存不了 | `roleFiles.ts` 的 `NOT_A_STRING`：pi 的 yaml（YAML 1.2 core）会读成 null、布尔、数字的写法和单独的 `-` 写成 JSON 字符串；规格 §5.1 照改 | 单元 “AG-04 values YAML would read as null, a boolean or a number are quoted and read back as the same strings”、“AG-04 a name YAML would read as a boolean or null is saved and read back as that name” |
| 12 | 跟随的会话换到另一个项目时，表单、展开与 Saved 留着，Save 会写到另一个项目 | `ToolsPage.tsx` 按跟随的会话的 `cwd` 给这一节 key；规格 §6.4 与状态表“跟随的会话”照改 | App “AG-04 when Customize follows a session in another project, the open form and open rows don’t carry over”（分屏后归档跟随的那一栏；去掉修正时它失败） |
| 13 | 候选为空就写 `No model range picked`，范围展开不出模型时也这样写 | `modelLine(agent, pick)`：只在没写 models、会话也没有范围时写它，其他候选为空写 `No model can run this agent`（推荐，临时默认值） | 单元 “AG-02 the model line: a range that names no model is "No model can run this agent", not "No model range picked"”；App “AG-02 a range that names no model (the project’s .mori/models.json can’t be read) gives …”（新项目 unexpanded） |
| 14 | 编辑时文件头读不出就当作没有保留的字段重写（悄悄丢掉 requires 等） | `planEdit` 用 `inspectRoleFiles` 检查现在的文件，读不出时不写、`error` 为它的问题行；规格 §5.3 照改 | 单元 “AG-06 editing a file whose header can’t be read says so and leaves the file as it is”；App “AG-06 saving an edit after the file’s header broke elsewhere says "can’t read the header: …" and leaves the file as it is” |
| 15 | `m6-app-tools.mjs` 2001 行 | 并一行条件、一行注释，1999 行，检查不变 | — |
| 16 | `FormValues`、`FormStatus`、`OpenForm`、`RowProps`、`Deleting` 的成员没有说明 | 每个成员加中文 `/** */` | — |
| 17 | 重复的配置：表单自己的 200 与 `mcp__*` | 用 `TEXT_LIMITS.roleDescription`；`ALL_MCP_TOOLS` 放到 `shared/roles.ts`，表单、`toolsText` 与 `kernel/roles.ts` 都用它 | 单元 AG-06 那一条也查 `ALL_MCP_TOOLS === "mcp__*"` |

另（走查会话在评审之后要求，负责人的规则是不留已知的缺陷）：`kernel/roles.ts` 的 `can't read the header: it must be "field: value" lines` 用的是直引号，同类的问题行都是 ’，这一节的行上会显示它，改成 ’。用例：单元“AG-03 every "can’t read the header" line uses the curly apostrophe, like the rest of the problem lines”（先跑出失败），TaskBoard 单元“TB-01 §4.4 row: the header can not be read (YAML error, no frontmatter)”的期望照改。

测试时发现的：模型档案按地址与模型 id 认，所以 kx 与 zg 用同一个地址时 kx/glm-4.6 与 zg/glm-4.6 共用一份档案，AG-02 的两条因此失败；kx 改用另一个端口（4960）。这是模型层原来的设计，不是这次的问题。

## 第二次核对（2026-10-26）

走查会话又独立核对了一遍：17 条都是真的修正，每条都有去掉修正就失败的用例；另找出 5 条小问题，这里改完。

| # | 问题 | 改法 | 用例 |
| --- | --- | --- | --- |
| 1 | 下拉的节按节名做 React 的 key，提供商名称可以重复 | `RangeGroup` 加 `key`（`groups`、`providers`、`models:<提供商 id>`），表单按它 | 单元 “AG-04 Add model range: two providers with the same name get two groups with distinct keys (by provider id)”（先跑出失败） |
| 2 | 评审 1 之后 Only these 一个都没勾、只剩表单外保留的条目时 Save 仍可用，状态表与 §6.4 没写 | 按推荐保留这个行为（保留的条目就是工具，逼人勾一个会改掉文件）；状态表“不能保存”、§6.4 Tools、§7 写明，登记临时默认值 | App “AG-06 with no box ticked, Save stays available while the file keeps an entry the form has no box for (mcp__github__*), and is unavailable without one” |
| 3 | Only these 的检查拿 roles.get 的 piTools 比，没有钉住 8 个名字 | 检查写死状态表的 8 个（PI_TOOL_NAMES） | “AG-04 Only these has a box for each of the eight pi tools (read, bash, edit, write, grep, find, ls, powershell), then All MCP tools” |
| 4 | model-menu.md“某一节为空”说全空时只有说明与 Manage models | 改成说明、Task mode 一行、Manage agents 与 Manage models | App “AG-08 with no providers left the model menu has no sections, only the note, the Task mode row, Manage agents and Manage models”（删掉全部提供商） |
| 5 | 跟随的会话换项目时，改过的表单不问就丢掉，没有用例 | 行为不变（§6.4“从头显示”，更安全）；状态表“跟随的会话”与 §6.4 写明“不问、直接收起、什么都不写” | App “AG-04 a form with unsaved edits is dropped too when Customize follows a session in another project: no "Discard this agent?", and nothing is written” |

共享与内核代码只改了 `RangeGroup`（加一个字段），按走查会话的说法不重跑快速集。

## 状态表的行与用例（AGENTS.md“不留未完成项”第 4 条）

这个分支新加的状态表 [../screens/customize-agents.md](../screens/customize-agents.md) 的每一行，和改过的别的状态表的行。
“用例”写套件与 `--only` 名，再写检查名（结果文件 `ag-app.json` / `ag-partial-app.json` 里的 name）。

| 屏 | 行 | 用例（套件与 --only 名、检查名） |
| --- | --- | --- |
| [customize-agents](../screens/customize-agents.md) | 外框 · 跟随的会话（评审 12 加：换到另一个项目时从头显示） | `ag-app.mjs --only AG-04`：“AG-04 when Customize follows a session in another project, the open form and open rows don’t carry over”；“AG-04 a form with unsaved edits is dropped too when Customize follows a session in another project: no "Discard this agent?", and nothing is written” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 分节 | `ag-app.mjs --only AG-01`：“AG-01 with no open session Customize has no Agents section (Skills, Plugins, Instructions)”；“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 读取中 | `ag-app.mjs --only AG-01`：“AG-01 entering Agents shows Loading… until the list is read” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 读取失败 | `ag-app.mjs --only AG-01`：“AG-01 a .mori/agents folder that can’t be read shows "Couldn’t load agents: <text>" and Retry”；“AG-01 after the folder is fixed, Retry lists its agents” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 标题 | `ag-app.mjs --only AG-01`：“AG-01 the header: "Agents", the one-line explanation and New agent” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · Mori | `ag-app.mjs --only AG-01`：“AG-01 Mori is the first row: Built-in, its description, the jobs nobody claimed” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 项目的 agent | `ag-app.mjs --only AG-01`：“AG-01 agent files follow by file name, tagged Project, with the description’s first line and their jobs” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 没有文件 | `ag-app.mjs --only AG-01`：“AG-01 a project without agent files shows only Mori, holding every job, and the empty-state text” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 有问题的文件 | `ag-app.mjs --only AG-03`：“AG-03 the warning above the list, and the rows’ problem lines are exactly the "Fix the agent files" card’s”；“AG-03 a problem file is named by its header name (or file name), tagged Project and Can’t be used”；“AG-03 expanded, a problem file has only the File block: Open in default app and Delete…, no Edit”；“AG-03 the good file in the same folder is listed as usual”；“AG-03 a problem file’s row has no description, even when its header has one (only name, tags and problems)” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 刚保存 | `ag-app.mjs --only AG-04`：“AG-04 after Save the form closes and the new row is open with "Saved · Applies to new sessions"” |
| [customize-agents](../screens/customize-agents.md) | 模型的一句话 · 都能用、部分不能用、都不能用（评审 13 改了“都不能用”的来源） | `ag-app.mjs --only AG-02`：“AG-02 the model line: all ready names the first model, some can’t run counts them, none says so”；“AG-02 a range that names no model (the project’s .mori/models.json can’t be read) gives "No model can run this agent", not "No model range picked"” |
| [customize-agents](../screens/customize-agents.md) | 模型的一句话 · 没有候选 | `ag-app.mjs --only AG-02`：“AG-02 with no model range the line says "No model range picked"; expanded, "The session has no model range." and no candidates” |
| [customize-agents](../screens/customize-agents.md) | 展开 · Models：用会话的范围 | `ag-app.mjs --only AG-09`：“AG-09 Mori: the session’s model range, Same as Mori with the default tools, no File block”；没有范围时见上一行（AG-02） |
| [customize-agents](../screens/customize-agents.md) | 展开 · Models：写了的 | `ag-app.mjs --only AG-09`：“AG-09 an agent with its own models, a handoff tier need, its tools, its prompt and its file” |
| [customize-agents](../screens/customize-agents.md) | 展开 · 每个候选 | `ag-app.mjs --only AG-02`：“AG-02 expanded, every candidate shows Ready or the selector’s reason, exactly as roles.get gives them”；“AG-02 the reasons include "handoff tier C is below B" and the effective window for context>=65536” |
| [customize-agents](../screens/customize-agents.md) | 展开 · Model needs | `ag-app.mjs --only AG-09`：“AG-09 an agent with its own models, a handoff tier need, its tools, its prompt and its file”；“AG-09 needs without a tier note, all MCP tools, other settings, and No prompt” |
| [customize-agents](../screens/customize-agents.md) | 展开 · Tools | `ag-app.mjs --only AG-09`：“AG-09 Mori: the session’s model range, Same as Mori with the default tools, no File block”；“AG-09 needs without a tier note, all MCP tools, other settings, and No prompt” |
| [customize-agents](../screens/customize-agents.md) | 展开 · Other settings | `ag-app.mjs --only AG-09`：“AG-09 needs without a tier note, all MCP tools, other settings, and No prompt” |
| [customize-agents](../screens/customize-agents.md) | 展开 · Prompt | `ag-app.mjs --only AG-09`：“AG-09 an agent with its own models, a handoff tier need, its tools, its prompt and its file”；“AG-09 needs without a tier note, all MCP tools, other settings, and No prompt” |
| [customize-agents](../screens/customize-agents.md) | 展开 · File | `ag-app.mjs --only AG-09`：“AG-09 an agent with its own models, a handoff tier need, its tools, its prompt and its file”；“AG-09 Open in default app hands the agent file’s path to the system”；“AG-09 clicking an open row closes it again” |
| [customize-agents](../screens/customize-agents.md) | 展开 · 打开失败 | `ag-app.mjs --only AG-09`：“AG-09 when the system can’t open the file the row says "Couldn’t open this file with the default app: <text>"” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 新建 | `ag-app.mjs --only AG-04`：“AG-04 the New agent form: six fields with their hints; no jobs, the session’s range, Same as Mori, no prompt” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 编辑 | `ag-app.mjs --only AG-06`：“AG-06 Edit fills the form with the file’s values and warns that the header’s comments go”；“AG-06 Save keeps the file name and writes requires, differ_from and subscribe back unchanged, without comments” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 文件头有注释 | `ag-app.mjs --only AG-06`：“AG-06 Edit fills the form with the file’s values and warns that the header’s comments go” |
| [customize-agents](../screens/customize-agents.md) | 表单 · Jobs 被别人认领 | `ag-app.mjs --only AG-05`：“AG-05 a job another file claims can’t be ticked and says who does it”；新建表单里的那一项见“表单 · 新建” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 选模型 | `ag-app.mjs --only AG-04`：“AG-04 Models: an ordered list from Add model range, reordered by dragging; Save waits for a model and a tool”；“AG-04 the model list reorders as in Settings › Models: a Reorder handle from two items; dropped on the top half of an item it goes before it, on the bottom half after it, with the line there; arrow keys keep focus; each move is announced”；“AG-04 Add model range has the model menu’s sections and words: Groups, Providers, then Models · <provider> for each provider; the same model id under two providers is listed under each”；“AG-04 each range in the list has a Remove button; removing one takes it out of the list and makes it available in Add model range again” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 选工具 | `ag-app.mjs --only AG-04`：“AG-04 Only these has a box for each of the eight pi tools (read, bash, edit, write, grep, find, ls, powershell), then All MCP tools”；“AG-04 Models: an ordered list from Add model range, reordered by dragging; Save waits for a model and a tool”；“AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says”；`ag-app.mjs --only AG-06`：“AG-06 an MCP entry the form has no box for (mcp__github__*) isn’t shown and stays in the file after Save” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 不能保存 | `ag-app.mjs --only AG-05`：“AG-05 Save is unavailable without a name, a description, a model in the list or a tool; the description stops at 200 characters with an n/200 count”；`ag-app.mjs --only AG-06`：“AG-06 with no box ticked, Save stays available while the file keeps an entry the form has no box for (mcp__github__*), and is unavailable without one”（第二次核对改了这一行） |
| [customize-agents](../screens/customize-agents.md) | 表单 · 保存中 | `ag-app.mjs --only AG-04`：“AG-04 while saving, the button reads "Saving…" and the form can’t be changed” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 保存失败 | `ag-app.mjs --only AG-05`：“AG-05 a reserved name, a name another file uses and an existing <name>.md are refused with those lines; the form keeps what you typed and no file is written”；`ag-app.mjs --only AG-06`：“AG-06 saving an edit after the file was deleted elsewhere says "This agent file no longer exists."”；“AG-06 saving an edit after the file’s header broke elsewhere says "can’t read the header: …" and leaves the file as it is” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 有改动时离开 | `ag-app.mjs --only AG-04`：“AG-04 leaving a changed form asks "Discard this agent?"; Keep editing keeps it, Discard leaves”；“AG-04 with a changed form, opening another agent’s Edit or another session in the sidebar asks first; Keep editing keeps the form”；“AG-04 Back to app with a changed form asks "Discard this agent?" too; Discard goes back to the session” |
| [customize-agents](../screens/customize-agents.md) | 删除 · 确认 | `ag-app.mjs --only AG-07`：“AG-07 Delete… asks "Delete agent “reviewer”?" with the permanent-delete text; Cancel keeps the file” |
| [customize-agents](../screens/customize-agents.md) | 删除 · 删除中 | `ag-app.mjs --only AG-07`：“AG-07 while deleting, the dialog says "Deleting…" and its buttons are unavailable” |
| [customize-agents](../screens/customize-agents.md) | 删除 · 已删除 | `ag-app.mjs --only AG-07`：“AG-07 Delete removes the file and its row” |
| [customize-agents](../screens/customize-agents.md) | 删除 · 删除失败 | `ag-app.mjs --only AG-07`：“AG-07 a failed delete keeps the dialog open with "Couldn’t delete: <text>"” |
| [customize-agents](../screens/customize-agents.md) | 模型菜单的 Manage agents · 菜单打开 | `ag-app.mjs --only AG-08`：“AG-08 with Task mode off the model menu has Manage agents under the Task mode row, above Manage models; clicking it opens Customize › Agents for this session”；“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents”；`ag-app.mjs --only AG-10`：“AG-10 Recent activity has "Open Customize → Agents" after Manage agents” |
| [customize-agents](../screens/customize-agents.md) | 模型菜单的 Manage agents · Task mode 打开 | `ag-app.mjs --only AG-08`：“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents” |
| [customize-agents](../screens/customize-agents.md) | 模型菜单的 Manage agents · 回复进行中（新加） | `ag-app.mjs --only AG-08`：“AG-08 during a reply the range items are unavailable but Manage agents is there and opens Customize › Agents” |
| [model-menu](../screens/model-menu.md) | 菜单（加 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 with Task mode off the model menu has Manage agents under the Task mode row, above Manage models; clicking it opens Customize › Agents for this session” |
| [model-menu](../screens/model-menu.md) | 协作模式的菜单（加 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents”；`tb-app-models.mjs --only sel`：“TB-38 task mode: the model button in the message-box row reads … the Task mode row (focused), Manage agents and Manage models — no Groups/Providers/Models …” |
| [model-menu](../screens/model-menu.md) | 回复进行中的菜单（加 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 during a reply the range items are unavailable but Manage agents is there and opens Customize › Agents” |
| [model-menu](../screens/model-menu.md) | Manage agents（新加） | `ag-app.mjs --only AG-08`：“AG-08 with Task mode off the model menu has Manage agents under the Task mode row, above Manage models; clicking it opens Customize › Agents for this session”；“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents”；“AG-08 during a reply the range items are unavailable but Manage agents is there and opens Customize › Agents”；`ag-app.mjs --only AG-10`：“AG-10 Recent activity has "Open Customize → Agents" after Manage agents” |
| [model-menu](../screens/model-menu.md) | 某一节为空（第二次核对：全空时还有 Task mode 一行与 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 with no providers left the model menu has no sections, only the note, the Task mode row, Manage agents and Manage models” |
| [team-blocked](../screens/team-blocked.md) | 锁定（评审 3：菜单与操作加 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents”；`tb-app-models.mjs --only sel`：TB-38 的 Task mode 菜单一条（菜单项 `team-switch`、`manage-agents`、`manage-models`） |
| [v0 models](../../v0/screens/models.md) | 关闭与重开 · 范围菜单（评审 3：回复进行中 Manage agents 也能用） | `ag-app.mjs --only AG-08`：“AG-08 during a reply the range items are unavailable but Manage agents is there and opens Customize › Agents” |
| [v0 chat](../../v0/screens/chat.md) | 选择范围（v1）（评审 3：协作模式的菜单加 Manage agents） | `ag-app.mjs --only AG-08`：“AG-08 with Task mode on the menu is the note, the Task mode row, Manage agents and Manage models; Enter on Manage agents opens Customize › Agents” |
| [customize-agents](../screens/customize-agents.md) | 反例 · 已经打开的会话不变 | `ag-app.mjs --only AG-04`：“AG-04 the session already open still has its old agents; a new session has reviewer, holding Plans requests” |
| [customize-agents](../screens/customize-agents.md) | 反例 · 不显示此刻的状态 | `ag-app.mjs --only AG-02`：“AG-02 expanded, every candidate shows Ready or the selector’s reason, exactly as roles.get gives them” |
| [customize-agents](../screens/customize-agents.md) | 反例 · 写出的文件不带 Mori 的标记 | `ag-app.mjs --only AG-04`：“AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says” |
| [tools.md](../../v0/screens/tools.md) | 外框 · 分节（加 Agents） | `ag-app.mjs --only AG-01`：“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions”；`m6-app-tools.mjs --only noSession,entry,keyboard` 与 `--only noSession,entry,overrideProject,archiveFollow`（结果见测试表）：“分节列表里 ↓ ↑ 切换分节，焦点跟着走（Skills 的下一节是 Agents）”、“技能一节：从"返回会话"按 Tab 走到"新建会话"、分节按钮、技能行和它的开关”，以及用 `WITH_SESSION` 的 noSession、entry、archiveFollow 各检查 |
| [customize-agents-md](../screens/customize-agents-md.md) | Customize 的分节（列表加 Agents） | `ag-app.mjs --only AG-01`：“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions”；`m6-app-settings.mjs --only agentsUser`（16/16）：“Customize 的分节（2026-10-26 负责人定）：有会话时 Built-in tools、Skills、Agents、MCP、Plugins、Instructions…” |

## 没有做完的

- 没有。AG-08 模型菜单的 Manage agents 原来列在这里（等 WP-09），WP-09 合入后做完，用例全部通过（见上）。

表单的拖动列表已经做完：WP-03 先合入（经 app-v0 `34fa29a` 进来），这一节改用它的 `settings/Reorder.tsx`，自己的拖动列表删掉
（见上面“统一拖动排序”）。

## 等负责人定的

负责人不在时（2026-10-26 起，原话 "unattended mode, pick recommended option for questions and log them, I will read them
after"），每个问题按推荐做完、登记临时默认值，记在这里，等负责人回来看。

- **All MCP tools 写进文件的样子**
  - 问题：表单 Tools 的 `All MCP tools` 写进角色文件是什么样子？TaskBoard 规格 §4.4 原来不认 `mcp__*` 这个写法，
    只认 `mcp__<服务>__<工具或 *>`。
  - 选项：(1) 写 `mcp__*`（全部 MCP 工具，同基座的白名单写法，以后加的服务也算在内；TaskBoard 规格 §4.1、§4.4 为它放开）；
    (2) 表单不提供 `All MCP tools`；(3) 按此刻的 MCP 服务各写一个 `mcp__<服务>__*`（以后加的服务不包括）。
  - 选了：(1)，推荐的。临时默认值登记在 [../defaults.md](../defaults.md)“Customize › Agents”的“All MCP tools 写进文件的样子”，
    TaskBoard 规格 §4.1、§4.4 有带日期的注。2026-10-26 经走查会话问过负责人，没有回答前照 (1)。
  - 做在：`kernel/roles.ts`（`toolProblems` 认 `ALL_MCP_TOOLS`）、`components/ToolsAgentForm.tsx`（`All MCP tools` → `mcp__*`）、
    `shared/roles.ts`（`toolsText` 把它写成 all MCP tools）。
  - 测在：单元 `taskboard/roles.test.mjs`“TB-01 §4.4 row: unknown tool; TaskBoard tools are added by Mori”（`mcp__*` 合格、
    `mcp__` 不合格），`agents/roleFiles.test.mjs`、`agents/roleCommands.test.mjs` 的 AG-04（写出并读回 `"mcp__*"`），
    `agents/text.test.mjs`“AG-09 tools: written ones joined, mcp__* as all MCP tools; …”；App `ag-app.mjs --only AG-04`
    “AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says”、`--only AG-09`“AG-09 needs without a tier note,
    all MCP tools, other settings, and No prompt”。
  - 改成 (2) 或 (3) 时：去掉 TaskBoard 规格的放开与 `ALL_MCP_TOOLS`，表单相应改，上面这些用例照改。

- **表单没有勾选框的工具写法（评审 1、11）**
  - 问题：角色文件的 `tools` 里有表单没有勾选框的写法（`mcp__github__*`、`mcp__fs__read_file`，TaskBoard 规格 §4.1 允许）时，Edit 表单怎么办？
  - 选项：(1) 不显示、不改，勾或取消别的项时原样留着，保存时写在列表后面；(2) 每个这样的写法显示一个勾选框；(3) 保存前提示会去掉它们。
  - 选了：(1)，走查会话按推荐定的。临时默认值登记在 [../defaults.md](../defaults.md)“表单没有勾选框的工具写法”；规格 §6.4 Tools、§7，状态表“选工具”。
  - 做在：`shared/roles.ts` 的 `toolsToggled`、`components/ToolsAgentForm.tsx` 的 `ToolsField`。
  - 测在：单元 “AG-06 ticking a tool keeps entries the form has no box for (mcp__github__*), after the boxes in their order”；App `ag-app.mjs --only AG-06` “AG-06 an MCP entry the form has no box for (mcp__github__*) isn’t shown and stays in the file after Save”。
  - 改成 (2) 或 (3) 时：表单加勾选框或提示（新的界面行，先写状态表），这两条用例照改。
- **Add model range 的节（评审 2）**
  - 问题：下拉要“同模型菜单”，可模型菜单的 Models 一节按提供商分小节，`<optgroup>` 不能套，怎么写？
  - 选项：(1) Groups、Providers，再按提供商各一节 `Models · <提供商名称>`，空节不画；(2) 节名只写提供商名称；(3) 只有一节 Models，项写 `<提供商名称> · <模型 id>`。
  - 选了：(1)，推荐的。临时默认值“Add model range 的节”；规格 §6.4 Models、§7，状态表“选模型”。
  - 做在：`shared/roles.ts` 的 `rangeGroups`、`ToolsAgentForm.tsx` 的 `ModelsField`。
  - 测在：单元 “AG-04 Add model range: Groups, Providers, then one Models · <provider name> per provider; empty ones left out”；App `--only AG-04` “AG-04 Add model range has the model menu’s sections and words: …”（与同一份配置的模型菜单逐节对照）。
  - 改成 (2) 或 (3) 时：改 `rangeGroups` 与这两条用例的期望。
- **范围展开不出模型时的一句话（评审 13）**
  - 问题：会话有范围、或 agent 写了 models，候选却为空（例如项目的 `.mori/models.json` 读不出）时，一行上写什么？
  - 选项：(1) `No model can run this agent`（同全部不能用）；(2) 另加一句专门的话（新的界面文字）。
  - 选了：(1)，推荐的。临时默认值“范围展开不出模型时的一句话”；规格 §6.2、§7，状态表“都不能用”。
  - 做在：`shared/roles.ts` 的 `modelLine`（多了 `pick` 参数）、`ToolsAgents.tsx`。
  - 测在：单元 “AG-02 the model line: "No model range picked" only without models and without a session range”、“AG-02 the model line: a range that names no model is "No model can run this agent", not "No model range picked"”；App `--only AG-02` “AG-02 a range that names no model (the project’s .mori/models.json can’t be read) gives "No model can run this agent", not "No model range picked"”。
  - 改成 (2) 时：加这句话（先写状态表与 §7），改 `modelLine` 与这几条用例。

- **Only these 一个都没勾时的 Save（第二次核对 2）**
  - 问题：文件里有表单外保留的条目（例如 `mcp__github__*`），勾选框一个都没勾时，Save 能不能用？
  - 选项：(1) 能用，保存后 `tools` 只有这些条目；(2) 只看勾选框，一个都没勾就不能保存。
  - 选了：(1)，走查会话按推荐定的。临时默认值“Only these 一个都没勾时的 Save”；规格 §6.4 Tools、§7，状态表“不能保存”。
  - 做在：`components/ToolsAgentForm.tsx` 的 `canSave`（行为本来就是这样，只改了注释）。
  - 测在：App `ag-app.mjs --only AG-06` “AG-06 with no box ticked, Save stays available while the file keeps an entry the form has no box for (mcp__github__*), and is unavailable without one”。
  - 改成 (2) 时：`canSave` 只数勾选框里的项，这条用例的期望照改。

（拖动排序的放法不在这里：走查会话按推荐定了两处都用 WP-03 的规则，上半边插在前面、下半边插在后面，这一节已经照做，见上面
“统一拖动排序”与状态表“选模型”。）

## 没有验证的

- 没有：读不出 `.mori/agents` 时的 `Couldn’t load agents` 与 Retry 原来列在这里，后来用指向自己的目录联接（ELOOP，不改权限）
  造出来，写成了 AG-01 的用例。会话打开时目录就读不出的话会话起不来（TaskBoard 的启动校验），所以用例在会话打开之后才把它弄坏。
