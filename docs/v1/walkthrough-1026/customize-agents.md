# Customize › Agents（M20）检查记录

依据：2026-10-26 负责人走查 M20（"I can't find team mode setup panel, where can I setup model for each role and add extra agent?"，
[../walkthrough-1026-checks.md](../walkthrough-1026-checks.md)）、负责人批准的 [Customize › Agents 规格](../../specs/customize-agents.md)
与状态表 [../screens/customize-agents.md](../screens/customize-agents.md)。分支 `v1-customize-agents`，从本地 `app-v0` 开出，
合入过 WP-07（`58138cc`）、WP-08（`3aa835c`）、WP-21（不留未完成项，`f613281`）、WP-02（`10624c6`）、
WP-05（`34fa29a`）与 WP-09（`e55b28b`）；没有推送，没有合进 `app-v0`。

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
| 单元 | `npm run test:ag-unit`（`ag-unit.json`）、`npm run test:unit`（含 spec-ids 与 MP-38 标记检查）、`npm run test:tb-unit` | 33/33、463/463、334/334；合入 WP-02 之后 33/33、475/475、334/334；合入 WP-05（app-v0 `34fa29a`）之后 33/33、465/465、334/334 |
| App（只跑这次的用例） | `node tests/ui/ag-app.mjs --only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-09,AG-10`；为行与用例表补的用例再跑 `--only AG-01,AG-02,AG-04,AG-07,AG-09` 与 `--only AG-04`。端口 4960、4961，前后告诉了走查会话 | 除 AG-10 的 `Open Customize → Agents` 一条外全部通过（见下面“没有做完的”）；AG-08 没有跑（等 WP-09）。合入 WP-05 之后再跑第一条命令：44 条通过，失败的仍只有 AG-10 那一条。改用 WP-03 的拖动排序之后跑 `--only AG-04`：11 条全部通过。合入 WP-09、做完 Manage agents 之后跑 `--only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-08,AG-09,AG-10`：49 条全部通过，没有失败 |
| 快速集 `npm run test:quick`；`tb-app-models.mjs --only sel`（TB-38） | 还没有跑：两者用共用的端口（m0-smoke 的 4319、TaskBoard 的 4600 段），第二波（WP-10 到 WP-14）的集成方占着；走查会话同意在第二波结束后跑，那时先再合一次 `app-v0`（WP-10 改 Task mode），再跑这两项 | — |
| 完整回归、覆盖检查 | 按规则只在负责人要求推送前跑（`npm run test:agents`、`v1-models-existing.mjs --id AG-11`） | — |
| 回放、真实模型 | 不做：这一节不改发给模型的文字、工具、批准或会话事件（规格 §9.1）；`mcp__*` 在角色文件里与基座的白名单是同一个写法 | — |

改到的现有套件（只改了期望的分节列表，没有运行，留给推送前的 AG-11）：`m6-app-tools.mjs`（有会话时的分节、Skills 的 ↓
落在 Agents、Tab 走 14 步）、`m6-app-settings.mjs`、`m6-replay.mjs`；单元 `taskboard/roles.test.mjs`（`mcp__*` 合格）、
`taskboard/spec-coverage.test.mjs`（规格名多了 agents），都已通过。合入 WP-09 后又改了 `tb-app-models.mjs` 的 TB-38
（Task mode 菜单的项多了 `manage-agents`），加进 AG-11 的预设；它改写了一条检查，按测试分层第 2 条用 `--only sel` 跑
（结果见上表）。`tb-app-roles.mjs` 的 TB-53 只看菜单最后三个直接子元素（说明、`.task-mode-group`、`manage-models`），
`Manage agents` 在 `.task-mode-group` 里，不影响它。

合入 WP-05（网络区域删掉，2026-10-26）：`selector.ts` 的冲突只在注释，保留 `pickItems` 的拆分、用 app-v0 的“第 1、3 步”；
这一节的代码、规格和单元测试里“第 1–3 步”改成“第 1、3 步”，单元测试的静态输入去掉 `zoneOf`、`allowedZones`。
Agents 的界面、文件与原因文字原来就不涉及区域，没有别的改动。

统一拖动排序（2026-10-26 走查会话定：Mori 只留一份，后合入的一方统一）：WP-03 已在 app-v0 里，有共用的组件
`components/settings/Reorder.tsx`，所以表单的模型列表改用它（`useReorderRow`、`ReorderHandle`、`ReorderStatus`，`move` 用
`shared/models.ts` 的 `movedItems` 只改表单），原来的拖动代码与 `.agent-drag` 样式删掉。线与变淡的样式在 `models-settings.css`
里加上 `.agent-model-list > li`，表单引入这份样式（同 `FirstRunForm.tsx`、`MemoryEnhance.tsx`）。规格 §6.4 与状态表“选模型”
改写成同一份的行为（柄、上半边与下半边、方向键、播报），AG-04 加一条检查。`Reorder.tsx` 只改了注释，Settings › Models 的
行为不变，按测试分层第 2 条没有跑 `v1-models-app-reorder.mjs`（推送前的完整回归里有）。

测试时发现的：合成提供商不能叫 `deepseek`（pi 的内置提供商 id，模型配置整份被拒），App 套件改用 `ds`、`zg`。

## 状态表的行与用例（AGENTS.md“不留未完成项”第 4 条）

这个分支新加的状态表 [../screens/customize-agents.md](../screens/customize-agents.md) 的每一行，和改过的别的状态表的行。
“用例”写套件与 `--only` 名，再写检查名（结果文件 `ag-app.json` / `ag-partial-app.json` 里的 name）。

| 屏 | 行 | 用例（套件与 --only 名、检查名） |
| --- | --- | --- |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 分节 | `ag-app.mjs --only AG-01`：“AG-01 with no open session Customize has no Agents section (Skills, Plugins, Instructions)”；“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 读取中 | `ag-app.mjs --only AG-01`：“AG-01 entering Agents shows Loading… until the list is read” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 读取失败 | `ag-app.mjs --only AG-01`：“AG-01 a .mori/agents folder that can’t be read shows "Couldn’t load agents: <text>" and Retry”；“AG-01 after the folder is fixed, Retry lists its agents” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 标题 | `ag-app.mjs --only AG-01`：“AG-01 the header: "Agents", the one-line explanation and New agent” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · Mori | `ag-app.mjs --only AG-01`：“AG-01 Mori is the first row: Built-in, its description, the jobs nobody claimed” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 项目的 agent | `ag-app.mjs --only AG-01`：“AG-01 agent files follow by file name, tagged Project, with the description’s first line and their jobs” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 没有文件 | `ag-app.mjs --only AG-01`：“AG-01 a project without agent files shows only Mori, holding every job, and the empty-state text” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 有问题的文件 | `ag-app.mjs --only AG-03`：“AG-03 the warning above the list, and the rows’ problem lines are exactly the "Fix the agent files" card’s”；“AG-03 a problem file is named by its header name (or file name), tagged Project and Can’t be used”；“AG-03 expanded, a problem file has only the File block: Open in default app and Delete…, no Edit”；“AG-03 the good file in the same folder is listed as usual” |
| [customize-agents](../screens/customize-agents.md) | 分节与列表 · 刚保存 | `ag-app.mjs --only AG-04`：“AG-04 after Save the form closes and the new row is open with "Saved · Applies to new sessions"” |
| [customize-agents](../screens/customize-agents.md) | 模型的一句话 · 都能用、部分不能用、都不能用 | `ag-app.mjs --only AG-02`：“AG-02 the model line: all ready names the first model, some can’t run counts them, none says so” |
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
| [customize-agents](../screens/customize-agents.md) | 表单 · 选模型 | `ag-app.mjs --only AG-04`：“AG-04 Models: an ordered list from Add model range, reordered by dragging; Save waits for a model and a tool”；“AG-04 the model list reorders as in Settings › Models: a Reorder handle from two items, a line where it drops, arrow keys that keep focus, and each move announced” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 选工具 | `ag-app.mjs --only AG-04`：“AG-04 Models: an ordered list from Add model range, reordered by dragging; Save waits for a model and a tool”；“AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 不能保存 | `ag-app.mjs --only AG-05`：“AG-05 Save is unavailable without a name, a description, a model in the list or a tool; the description stops at 200 characters with an n/200 count” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 保存中 | `ag-app.mjs --only AG-04`：“AG-04 while saving, the button reads "Saving…" and the form can’t be changed” |
| [customize-agents](../screens/customize-agents.md) | 表单 · 保存失败 | `ag-app.mjs --only AG-05`：“AG-05 a reserved name, a name another file uses and an existing <name>.md are refused with those lines; the form keeps what you typed and no file is written”；`ag-app.mjs --only AG-06`：“AG-06 saving an edit after the file was deleted elsewhere says "This agent file no longer exists."” |
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
| [customize-agents](../screens/customize-agents.md) | 反例 · 已经打开的会话不变 | `ag-app.mjs --only AG-04`：“AG-04 the session already open still has its old agents; a new session has reviewer, holding Plans requests” |
| [customize-agents](../screens/customize-agents.md) | 反例 · 不显示此刻的状态 | `ag-app.mjs --only AG-02`：“AG-02 expanded, every candidate shows Ready or the selector’s reason, exactly as roles.get gives them” |
| [customize-agents](../screens/customize-agents.md) | 反例 · 写出的文件不带 Mori 的标记 | `ag-app.mjs --only AG-04`：“AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says” |
| [tools.md](../../v0/screens/tools.md) | 外框 · 分节（加 Agents） | `ag-app.mjs --only AG-01`：“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions”；`m6-app-tools.mjs`（整套，推送前）：检查名“分节列表里 ↓ ↑ 切换分节，焦点跟着走（Skills 的下一节是 Agents）”与用 `WITH_SESSION` 的各检查 |
| [customize-agents-md](../screens/customize-agents-md.md) | Customize 的分节（列表加 Agents） | `ag-app.mjs --only AG-01`：“AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions”；`m6-app-settings.mjs`（整套，推送前）：“Customize 的分节（2026-10-26 负责人定）：有会话时 Built-in tools、Skills、Agents、MCP、Plugins、Instructions…” |

## 没有做完的

- 没有。AG-08 模型菜单的 Manage agents 原来列在这里（等 WP-09），WP-09 合入后做完，用例全部通过（见上）。

表单的拖动列表已经做完：WP-03 先合入（经 app-v0 `34fa29a` 进来），这一节改用它的 `settings/Reorder.tsx`，自己的拖动列表删掉
（见上面“统一拖动排序”）。

## 等负责人定的

- **All MCP tools 写进文件的样子**：现在写 `mcp__*`，为此 TaskBoard 规格 §4.1、§4.4 放开了这个写法（临时默认值，
  [../defaults.md](../defaults.md)“Customize › Agents”）。另两个做法：表单不提供 All MCP tools；或按此刻的 MCP 服务各写一个
  `mcp__<服务>__*`（以后加的服务不包括）。2026-10-26 已经经走查会话问负责人。

## 没有验证的

- 没有：读不出 `.mori/agents` 时的 `Couldn’t load agents` 与 Retry 原来列在这里，后来用指向自己的目录联接（ELOOP，不改权限）
  造出来，写成了 AG-01 的用例。会话打开时目录就读不出的话会话起不来（TaskBoard 的启动校验），所以用例在会话打开之后才把它弄坏。
