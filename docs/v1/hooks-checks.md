# 钩子 检查记录

依据：[构建规格](../specs/hooks.md)（下称“规格”）。规格按负责人 2026-10-28 的话 “make a hook system following claude's design”
与他对两个问题的回答写成，照 Claude Code 的钩子设计（规格开头列的 R、G、S、SR、W 五页，2026-10-29 取，页面标到 v2.1.309）。
状态表：[screens/customize-hooks.md](screens/customize-hooks.md)、[screens/hooks-chat.md](screens/hooks-chat.md)。
临时默认值：[defaults.md](defaults.md)“钩子”一节（规格 §12 原样贴过去的）。

## 状态

**规格已写、待负责人审；没有实现。** 2026-10-29 按规格 §11 随规格合进 `app-v0` 的只有文档：规格、两张状态表、本文、
`docs/app-v0.md`（§4 的表、§5.13 的 Hooks 一项、§6 的第 10 件与“九件事”改成“十件事”、§8 第 4 条）、`AGENTS.md`（仓库结构两处、
工作约定第 4 条与第 6 条）、`docs/v0/screens/tools.md`（顶部、分节、照 Claude 桌面版的表、界面测试用的标识）、
`docs/v1/screens/customize-agents-md.md`（“Customize 的分节”、“顶部”、“本表定下的界面细节”各一处，规格 §11.4 末段）、
`docs/v0/ui-strings.md`（术语表、Customize 页三行、会话一行、工具卡一行、操作记录一行）、`docs/v1/screens/README.md`（标题、
来源一段、文件表两行、标识两行、界面文字一条、需要规格回答第 15 条）、`docs/v1/defaults.md`（开头一句、“钩子”一节），
以及规格 §11.12 列的注（都标“随规格”）：平行 Agent 规格（§8.2、§14.3）、`file-system-permissions.md`（§6.1）、收尾检查规格（§5）、
记忆规格（§7.7、§9.6）、subagent 规格（§5.3）、模型层规格（§6.3）、`docs/v1/screens/fs-permissions.md`（批准卡的原因行、
工具卡两节）、`team-approvals.md`（开头）、`subagent-card.md`（每个 subagent 一行）。

还没有的：

- `app/src` 与 `app/tests` 的任何钩子代码与测试（规格 §2、§13.1、§13.2 的 HK-01–HK-37）。
- `tests/spec-coverage.mjs` 的 `SPECS` 里没有 `hooks`、`package.json` 没有 `test:hk-unit` / `test:hooks`、`v1-models-existing.mjs` 没有
  `HK-36` 预设、`tests/ui/run-plan.mjs` 没有 `hooks` 组。规格 §11.8–§11.11 写明这些**随实现合**：先加规格会让 `npm run test:unit` 的
  spec-ids 检查失败（AGENTS.md“验收表的新行和它的测试同一次合进 `app-v0`”），所以这一次一个也没动，`npm run test:min` 与钩子无关。
- `AGENTS.md`“测试分层”里“九组单元测试”“`hooks` 组”“`hk-real`”“九份 `spec-coverage --fresh`”那几处（规格 §11.3 第 5–9 条）
  说的是那时才有的命令，同样随实现合。

## 负责人的决定（2026-10-28）

规格 §0 的两条由包说明转达，写规格时没有看到负责人回答的原文；规格 §0“要问负责人的”第 1 条请负责人核对原话。按转达：

1. **范围**：只做 `type: "command"` 的钩子；事件 = Mori 有对应的全部 Claude Code 钩子事件（`PreToolUse`、`PostToolUse`、
   `PermissionRequest`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`SessionStart`、`SessionEnd`、`Notification`、`PreCompact`）；
   照 Claude 的 settings.json 写法、stdin 一份 JSON、退出码 2 拦下、JSON 输出；`prompt`、`agent`、`http` 类型不做。
2. **配置与界面**：读用户级 `<agentDir>\settings.json` 与受信任项目的 `.pi\settings.json` 里的 `hooks`，不读 `.claude/settings.json`；
   Customize 加 `Hooks` 一节，每条钩子一行的只读列表（事件、matcher、命令、User / Project）与 Open in default app，
   加一个 `Disable all hooks` 开关（Claude 的 `disableAllHooks`）。

负责人原话只有 “make a hook system following claude's design”；上表第 1、2 条是他对 Claude 两个问题的回答，不是原话。

## 写规格时定的（待负责人审）

规格 §0“写规格时定的”定了 29 条，登记在 [defaults.md](defaults.md)“钩子”一节的条目中。要点（全部**待负责人审**）：

| # | 定下的 | 规格 |
| --- | --- | --- |
| 1 | matcher 与 `tool_input` 用 pi 的名字与参数（`bash`，不是 `Bash`），区分大小写 | §0 第 1 条 |
| 2 | `permission_mode`：Ask each time → `default`，Full access → `bypassPermissions`；只有六个事件带 | §0 第 2 条 |
| 3 | 跑命令的 shell：会话的 `getShellPath()`，没有时用启动时 `findShell` 的结果；没有 bash 时 PowerShell；跑钩子时不调 pi 的 shell 查找 | §0 第 3 条 |
| 4 | `CLAUDE_PROJECT_DIR` 是工作路径，worktree 会话为主文件夹 | §0 第 4 条 |
| 5 | 实例的 `session_id`、`transcript_path` 是用户会话的，另带 `agent_id`、`agent_type` | §0 第 5 条 |
| 6 | 哪些会话跑哪些事件（§6.2 的表）；增强会话与 `finish` 都不跑 | §0 第 6 条 |
| 7 | PreToolUse 在 `decide` 之前；换过的参数先经记忆目录写保护再查一次 | §0 第 7 条 |
| 8 | PermissionRequest 与批准卡同时跑，先决定的算 | §0 第 8 条 |
| 9 | UserPromptSubmit 在 `promptEntry` 里跑；只跑你发的消息，程序投递不跑 | §0 第 9 条 |
| 10 | UserPromptSubmit、SessionStart 的上下文由 `mori-hooks` 的 `before_agent_start` 交，不用 `nextTurn` | §0 第 10 条 |
| 11 | SessionStart 用 pi 的 `session_start`；打开为 `resume`，其余 `startup` | §0 第 11 条 |
| 12 | SessionEnd 的 `reason`：归档、删除为 `other`，退出 Mori 为 `prompt_input_exit` | §0 第 12 条 |
| 13 | PreCompact 只在用户会话；阈值、溢出、重建都是 `auto` | §0 第 13 条 |
| 14 | Stop 在收尾检查、你不在的提醒之后，它们要接着跑时不跑 | §0 第 14 条 |
| 15 | Stop 中间没有工具调用的连续 8 次接着跑之后，第 9 次不再接着跑、这次运行结束、出一行提醒；不读 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | §0 第 15 条 |
| 16 | `continue: false` 在用户会话里照停止按钮停下 | §0 第 16 条 |
| 17 | 去重：`command` 与 `shell` 都相同的算同一个 | §0 第 17 条 |
| 18 | PermissionRequest 的 `deny` > `allow` | §0 第 18 条 |
| 19 | 钩子改了参数时对话流里不加提示 | §0 第 19 条（要问第 10 条） |
| 20 | 交给模型的原文是 `Blocked by PreToolUse hook: <原因>`，不带钩子的命令 | §0 第 20 条（要问第 14 条） |
| 21 | 输出截断：每段超过 10,000 个字符只留前 10,000 个，不另存文件 | §0 第 21 条（要问第 9 条） |
| 22 | 测试的名字：`--spec hooks`、编号 `HK-n`、结果文件前缀 `hk-`、App 测试端口 5020–5039 | §0 第 22 条 |
| 23 | 文件夹里没有要信任的项目资源（`none`）时用户级钩子照跑，不问信任 | §0 第 23 条（要问第 11 条） |
| 24 | UserPromptSubmit 拦下：文字回到输入框、错误卡不写进会话文件、不接 `Original prompt:` | §0 第 24 条（要问第 13 条） |
| 25 | PreToolUse 的上下文碰上路径闸、你、停止的拒绝时丢掉 | §0 第 25 条 |
| 26 | 退出 Mori 时 SessionEnd 合计固定 1.5 秒，不按 `timeout` 提高 | §0 第 26 条（要问第 15 条） |
| 27 | PowerShell 的包装（UTF-8 两行 + 让退出码透出来） | §0 第 27 条、§5.1 |
| 28 | 拦下溢出恢复时另出一行 `PreCompact hook blocked context overflow recovery: <原因>` | §0 第 28 条 |
| 29 | 批准卡上写 `PreToolUse hook (User settings): <原因>` | §0 第 29 条 |

另有三条不是 §0“写规格时定的”表里的编号行，出处如下：

| 定下的 | 规格 |
| --- | --- |
| 支持与不支持的处理器字段（`args`、`async`、`asyncRewake`、`if`、`onFailure` 列为问题、不跑） | §0“不做”表、§4.1、§4.5 |
| 实例用所属用户会话的钩子快照，不读自己的 SettingsManager | §4.6 |
| 设置文件里的钩子不跟 Claude 那样改了就重读，只对新会话生效 | §0“不做”表、§4.6（要问第 3 条） |

## 要问负责人的（规格 §0，审时请回答）

15 条，原文与理由在规格 §0“要问负责人的”。摘要：核对第 1 条那两句话的原话（1）；matcher 与参数要不要改成 Claude 的名字（2）；
设置改了要不要对开着的会话马上生效（3）；增强会话不跑钩子对不对（4）；TaskBoard 实例要不要跑 SubagentStop（5）；插话、排队的
UserPromptSubmit 上下文要到下一次运行才到可不可以（6）；Notification 只发 `permission_prompt` 够不够（7）；`CLAUDE_ENV_FILE`、
`updatedInput` 等没做的几项要哪几个（8）；超长输出截断还是存文件（9）；改参数时要不要加一行说明（10）；`none` 的文件夹要不要先问信任（11）；
程序投递要不要跑 UserPromptSubmit（12）；UserPromptSubmit 拦下时不写进会话文件可不可以（13）；拦下的原文不带命令可不可以（14）；
退出时 SessionEnd 的 1.5 秒够不够（15）。

## 照 Claude 核对的

规格开头记的来源：R（hooks）、G（hooks-guide）、S（settings）、SR（settings-reference）、W（worktrees），2026-10-29 取，
页面标到 v2.1.309。规格正文逐处的 “R：”“G：”“S：”“SR：”“W：” 引用是写规格时对照那五页记下的。

**这一节该有的逐条对照表（事件、stdin 字段、退出码、JSON 输出、显示）还没有写**：写规格之后没有重新取那五页逐条核对。
实现前要按规格 §3 的办法把 pi 的行为再核一遍（§3 的 20 条，pi 1.3.0，行号见规格），并补上这张表；在那之前，规格里的
Claude 引用只能算写规格时的一次对照，不算复核过。

## 规格的评审与改动

**还没评审。** 规格是 2026-10-29 一次写成的，还没有经过审查，也没有按审查改过。评审的发现、采纳与不采纳的理由在评审之后补在这里。

## 实现时要填的（现在都空）

按规格 §11.1，下面几节实现时填：

- 开工前核对的 pi 行为（规格 §3 的 20 条逐条复核）。
- 实现结果。
- 状态表的用例（AGENTS.md“不留未完成项”第 4 条：表“屏 ｜ 行 ｜ 用例（套件与 --only 名、检查名）”，
  `customize-hooks.md` 与 `hooks-chat.md` 的每一行，HK-29、HK-37；customize-hooks.md 的“不信任”一行 `untrusted`、`unasked`
  各一例（有 `hooks-untrusted`、用户级的行变淡），“没有要信任的项目资源”一行一例（`none`：不变淡、没有 `hooks-untrusted`）；customize-hooks.md 的
  “打开失败”一行一例（`hook-open-error`），hooks-chat.md 的“被拦下（带 worktree 的第一条消息）”一行一例（HK-18 的 App 用例可以算））。
- 现有界面测试的改动（规格 §13.4）。
- 录 fixture。
- 真实模型走查（HK-35）。
- 跑过的测试与跳过的层（`--only` 写的 `hk-partial-*.json` 不算覆盖；真实层由负责人用数据目录或 env 文件的 key 跑）。
- 未验证项。
