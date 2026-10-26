# Customize › Agents（M20）检查记录

依据：2026-10-26 负责人走查 M20（"I can't find team mode setup panel, where can I setup model for each role and add extra agent?"，
[../walkthrough-1026-checks.md](../walkthrough-1026-checks.md)）、负责人批准的 [Customize › Agents 规格](../../specs/customize-agents.md)
与状态表 [../screens/customize-agents.md](../screens/customize-agents.md)。分支 `v1-customize-agents`，从本地 `app-v0` 开出，
合入过 WP-07（`58138cc`）、WP-08（`3aa835c`）与 WP-21（不留未完成项，`f613281`）；没有推送，没有合进 `app-v0`。

## 改了什么、为什么

负责人找不到给每个角色设模型、加 agent 的地方：今天唯一的办法是手写 `<project>/.mori/agents/*.md`。现在 Customize 有一节
“Agents”（Skills 之后、MCP 之前，只在有会话时出现）：

- **列表**：基座 Mori（`Built-in`，持有没人认领的职责）和这个项目的每个 agent 文件（`Project`，按文件名），每行说明的第一行、
  职责（`Talks to you` / `Plans requests` / `Closes requests`）和模型的一句话（`Models: <id> and <n> more`、
  `<k> of <n> models can’t run`、`No model can run this agent`、`No model range picked`）。有问题的文件标 `Can’t be used`，
  列出与 “Fix the agent files” 卡上相同的问题行，列表上方一行警示。
- **展开**：Models（会话的范围或 `Tries these in order:`，每个候选 `Ready` 或选择器的原因原文，例如 `handoff tier C is below B`）、
  Model needs（白话，handoff tier 的说明）、Tools、Other settings、Prompt、File（Edit、Open in default app、Delete…）。
- **New agent / Edit 表单**：Name、Description（n/200）、Jobs、Models（会话的范围，或 Add model range 加、拖动排序的列表）、
  Tools（Same as Mori，或 pi 的 8 个工具与 All MCP tools）、Prompt。保存前用会话打开时的同一套规则检查，合格才写；
  编辑时文件名不变，`requires`、`differ_from`、`subscribe` 原样写回。有改动时离开先问。
- **后台进程**：`roles.get`、`roles.save`、`roles.delete`（`kernel/roleCommands.ts`）；`roles.ts` 拆出逐个文件的
  `inspectRoleFiles`（`parseRoleFiles` 用它，结果不变）、`readRoleFiles`、`nameProblems`；`roleFiles.ts` 写文件全文（只用 JSON
  写法，不加依赖）；`selector.ts` 导出 `staticExclusion` 与 `pickItems`（范围菜单的顺序与文字）；`sessions.ts` 的 `sessionPick`。
  对应方案第 6 节第 7 件（平行 Agent 与 TaskBoard）。
- **TaskBoard 规格 §4.1、§4.4**：角色文件的 `tools` 可以写 `mcp__*`（全部 MCP 工具，同基座的白名单写法），给表单的
  All MCP tools 用（临时，已问负责人，见下面“等负责人定的”）。

## 测试（按 AGENTS.md“测试分层”，2026-10-26 改）

先写测试再写实现（提交 `945d73c` 在实现 `12e5afc` 之前）：规格 §9.2 的 AG-01–AG-11 每一条在它列出的每一层都有测试，
`tests/unit/spec-ids.test.mjs` 查过（`agents` 已加进 `tests/spec-coverage.mjs` 的 `SPECS`）。

| 层 | 跑了什么 | 结果 |
| --- | --- | --- |
| 检查与构建 | `npm run check`、`npx electron-vite build` | 通过 |
| 单元 | `npm run test:ag-unit`（`ag-unit.json`）、`npm run test:unit`（含 spec-ids 与 MP-38 标记检查）、`npm run test:tb-unit` | 33/33、463/463、334/334 |
| App（只跑这次的用例） | `node tests/ui/ag-app.mjs --only AG-01,AG-02,AG-03,AG-04,AG-05,AG-06,AG-07,AG-09,AG-10`，端口 4960、4961，前后告诉了走查会话 | 除 AG-10 的 `Open Customize → Agents` 一条外全部通过（见下面“没有做完的”） |
| 快速集 `npm run test:quick` | 没有跑：走查会话要求第二波集成方占着快速集的端口时不跑，集成时跑 | — |
| 完整回归、覆盖检查 | 按规则只在负责人要求推送前跑（`npm run test:agents`、`v1-models-existing.mjs --id AG-11`） | — |
| 回放、真实模型 | 不做：这一节不改发给模型的文字、工具、批准或会话事件（规格 §9.1）；`mcp__*` 在角色文件里与基座的白名单是同一个写法 | — |

改到的现有套件（只改了期望的分节列表，没有运行，留给推送前的 AG-11）：`m6-app-tools.mjs`（有会话时的分节、Skills 的 ↓
落在 Agents、Tab 走 14 步）、`m6-app-settings.mjs`、`m6-replay.mjs`；单元 `taskboard/roles.test.mjs`（`mcp__*` 合格）、
`taskboard/spec-coverage.test.mjs`（规格名多了 agents），都已通过。

测试时发现的：合成提供商不能叫 `deepseek`（pi 的内置提供商 id，模型配置整份被拒），App 套件改用 `ds`、`zg`。

## 没有做完的

- **AG-08 模型菜单的 Manage agents**：要放在 WP-09 加的 Task mode 那一行下面，WP-09 还没合进 `app-v0`。测试已经写好
  （`ag-app.mjs` 的 AG-08、AG-10 的第二条），WP-09 一合入就做，同时改 `docs/v1/screens/model-menu.md`。
- **WP-02**（精简模型卡）还没合入；这一节不依赖它，合入后再合一次 `app-v0` 跑第 1、2 层。
- **表单的拖动列表**：WP-03（Settings › Models 的拖动排序）还没合入，先用这一节自己的列表（规格 §6.4 写明）。Mori 最后只留
  一份实现（2026-10-26 走查会话定，集成时查）：WP-03 先合入时改用它的组件；它没有可以共用的组件时，把这里的列表挪成共用组件，
  Settings › Models 也用它。另一份删掉。

## 等负责人定的

- **All MCP tools 写进文件的样子**：现在写 `mcp__*`，为此 TaskBoard 规格 §4.1、§4.4 放开了这个写法（临时默认值，
  [../defaults.md](../defaults.md)“Customize › Agents”）。另两个做法：表单不提供 All MCP tools；或按此刻的 MCP 服务各写一个
  `mcp__<服务>__*`（以后加的服务不包括）。2026-10-26 已经经走查会话问负责人。

## 没有验证的

- 读不出 `.mori/agents`（权限）时的 `Couldn’t load agents` 与 Retry：单元测试用读不出的路径查了 `roles.get` 的结果；
  界面上要把测试目录的权限改掉才造得出，没有做。
