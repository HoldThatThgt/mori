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

## 测试

见下面“测试结果”。
