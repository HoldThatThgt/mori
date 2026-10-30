# 钩子构建规格

状态：构建规格，按负责人 2026-10-28 的要求（"make a hook system following claude's design"）与 §0 的两条决定写成；只有文档，代码与测试都还没写；**待负责人审**。更新日期：2026-10-29。

本文照 Claude Code 的钩子设计写：<https://code.claude.com/docs/en/hooks>（下称 R）、<https://code.claude.com/docs/en/hooks-guide>（G）、<https://code.claude.com/docs/en/settings>（S）、
<https://code.claude.com/docs/en/settings-reference>（SR）、<https://code.claude.com/docs/en/worktrees>（W），2026-10-29 取，页面标到 v2.1.309。逐条对照写进检查记录 [v1/hooks-checks.md](../v1/hooks-checks.md)（与规格同一次合进，§11.1）。
Claude 有、Mori 没有对应或负责人没要的，列在 §0“不做”，写明为什么；两边做法不同的地方列在 §0“写规格时定的”，同时登记进 defaults.md（§12 有可以直接贴的行）。

钩子属于 [app-v0](../app-v0.md) §6“后台进程只做的事”的**第 10 件**（2026-10-28 加，§11 写了要加的原文），由新的 inline extension `mori-hooks` 和几处后台进程的接线做；
配合改动分属第 3 件（路径闸：PreToolUse、PermissionRequest、Notification，`mori-approval`）、第 7 件（SubagentStop：subagent 实例的标记）与第 6 件（PreCompact 拦下模型层的重建时照它已有的失败处理）。
代码引用写相对仓库根的路径与行号（`app/src/...:行号`；pi 写 `pi-coding-agent/dist/...:行号`、`pi-agent-core/dist/...:行号`，都在 `app/node_modules/@earendil-works/` 下，pi 1.3.0），
以写规格时的工作树为准：`app-v0` 的 `67eeabe` 加上还没提交的 U76/U77 改动（改到 `sessions.ts`、`defaultTools.ts`、`resources.ts`、`shell.ts`、`protocol.ts`、`app/src/main/kernel-process.ts`，新加 `app/src/main/kernelPath.ts`）。
U76/U77 提交之后按那个提交把行号核对一遍、把提交号写在这里（检查记录记下核对的结果）；§5.2 的“PATH 最前面有 Mori 带的 `rg.exe`、`fd.exe`”依赖 U76（`kernelPath.ts`）。

## 0. 范围

**负责人的话**（2026-10-28，原话）："make a hook system following claude's design"。

**负责人的决定**（2026-10-28，回答 Claude 的两个问题；由工作流的包说明转达，写规格时没有看到负责人回答的原文，审时请核对，见“要问负责人的”第 1 条）：

| # | 问题 | 回答 |
| --- | --- | --- |
| 1 | 范围 | 只做 `type: "command"` 的钩子。事件 = Mori 有对应的全部 Claude Code 钩子事件：`PreToolUse`、`PostToolUse`、`PermissionRequest`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`SessionStart`、`SessionEnd`、`Notification`、`PreCompact`。照 Claude 的 settings.json 写法（`hooks` → 事件 → `[{ matcher, hooks: [{ type: "command", command, timeout }] }]`）、stdin 一份 JSON、退出码 2 拦下、JSON 输出（`decision`、`permissionDecision`、`additionalContext` 等）。`prompt`、`agent`、`http` 类型不做 |
| 2 | 配置与界面 | 用户级 pi 设置 `<userData>\pi\settings.json`（= `<agentDir>\settings.json`，`PI_CODING_AGENT_DIR`）和受信任项目的 `.pi\settings.json` 里的 `hooks` 键，照 Claude 的 JSON 写法；不读 `.claude/settings.json`。Customize 加 `Hooks` 一节：每条钩子一行的只读列表（事件、matcher、命令、User / Project）与 Open in default app，加一个 `Disable all hooks` 开关（Claude 的 `disableAllHooks`） |

**本规格实现**：

- 设置：两份 pi 设置里的 `hooks` 与 `disableAllHooks`，合并、matcher、有问题的条目、什么时候读（§4）；
- 跑一条钩子：shell、cwd、环境变量、stdin、时限、停止与清理、同时跑与去重、退出码与 stdout、JSON 通用字段、输出上限（§5）；
- 十个事件，每个落在 pi 的一个事件或 Mori 的一个点上（§6）；
- 交给模型的文字（§7）与界面上的文字、进程桥的命令和事件（§8）；
- 界面：Customize › Hooks（状态表 [customize-hooks.md](../v1/screens/customize-hooks.md)）；对话流里的钩子行、工具卡、批准卡、错误卡（状态表 [hooks-chat.md](../v1/screens/hooks-chat.md)）；
- 日志（§10）；要改的现有文档（§11）；临时默认值（§12）；验收（§13）。

**不做**（Claude 有、本轮不做的，逐项写为什么）：

| Claude 的功能 | 为什么不做 |
| --- | --- |
| `prompt`、`agent`、`http`、`mcp_tool` 类型的处理器 | 负责人定只做 `command`（决定第 1 条）。写了的按 §4.5 列为问题、不跑 |
| `.claude/settings.json`、`.claude/settings.local.json`、托管策略（managed policy、`allowManagedHooksOnly`）、`--settings` | 负责人定只读两份 pi 设置（决定第 2 条）；Mori 没有托管设置，也没有命令行参数 |
| 插件的 `hooks/hooks.json`、技能与 subagent frontmatter 里的钩子 | 决定第 2 条只有两份 settings.json；pi 包、`SKILL.md`、`.mori/agents/*.md` 都不带钩子 |
| 其余事件：`PostToolUseFailure`、`PermissionDenied`、`StopFailure`、`SubagentStart`、`PostCompact`、`Setup`、`CwdChanged`、`FileChanged`、`ConfigChange`、`PreModelSwitch`、`PostModelSwitch`、`MessageDisplay`、`TeammateIdle`、`TaskCompleted` 等 | 不在决定第 1 条的十个里。写了的按 §4.5 列为问题、不跑 |
| 处理器字段 `args`（不经 shell 直接起）、`async`、`asyncRewake`、`if`、`onFailure` | 决定第 1 条给的写法是 `type`、`command`、`timeout`。这几项改变钩子做什么（什么时候跑、拦不拦、等不等），不支持却照样跑会做错事，所以写了它们的那条按 §4.5 列为问题、不跑。`shell` 支持（§5.1，只是选 bash 还是 PowerShell，同一条命令在错的 shell 里多半失败）；`statusMessage` 只改等待时的文字，忽略；`once` 照 R 只在技能 frontmatter 里起作用、在设置文件里忽略，Mori 同样忽略（§4.1） |
| Notification 的 `idle_prompt`、`auth_success`、`elicitation_*`、`agent_needs_input`、`agent_completed`、`quota_*`、`plugin_notification` | Mori 没有对应：没有回复后 60 秒没有输入的计时、没有登录、没有 MCP elicitation、没有后台 agent 的通知。只做 `permission_prompt`（§6.11）。提问卡（`ask_user_question`）与扩展询问卡 Claude 的文档没写发不发 Notification，不发（要问负责人的第 7 条） |
| SessionStart 的 `clear`、`compact`、`fork`；SessionEnd 的 `clear`、`resume`、`logout` | Mori 没有 `/clear`、在会话里换会话、登录登出、fork。`compact`：Mori 的压缩发生在一次运行里面（阈值检查、溢出重试，finish-check §3 第 12 条），pi 不能在那次运行里把一条消息放到摘要之后（§3 第 10 条），留到你的下一条消息又不是 Claude 说的“压缩之后补回上下文”（要问负责人的第 8 条） |
| `CLAUDE_ENV_FILE` | 它让 SessionStart 给之后每条 Bash 命令加环境变量，要改 bash、powershell 工具的起法（`workEnv`，`app/src/kernel/workspace.ts:57-69`）；决定第 1 条的写法里没有，要问（第 8 条） |
| 输出字段 `sessionTitle`、`suppressOriginalPrompt`、`updatedToolOutput`、`updatedMCPToolOutput`、`classifierContext`、`initialUserMessage`、`watchPaths`、`reloadSkills`、`terminalSequence`；PreToolUse 的 `defer` | `sessionTitle` 要改会话名；`updatedToolOutput` 要换掉工具结果，工具卡显示的输出跟着变；其余是 `-p`、终端或较新版本才有的。都按“不认得的键”忽略并记日志（§5.7）；`defer` 照 R 在交互会话里的做法：记一行警告、忽略这条钩子的整个结果（§5.5；R：只在 `-p` 下起作用） |
| 钩子打印了放行之后起了没重定向输出的后台进程时拦下（R：`refusing to honor the suspect capture`） | Mori 照 R“进程退出后不久就停止读取”（§5.4），之后的输出丢掉、不另判这种情形；决定第 1 条的写法里没有它 |
| PermissionRequest 的 `updatedInput`、`updatedPermissions` | 要按改过的参数、改过的规则重新走一遍路径闸（R：改过的参数要再按规则查），不只是“允许或拒绝”。它们关乎放行什么，所以写了它们的输出按不合格处理（非阻断错误，批准卡照常等你，§6.4），不悄悄忽略（要问的第 8 条） |
| `/hooks` 菜单的 “All events” 视图；在界面里添加、修改、只停用一条钩子 | 决定第 2 条：列表只读，改要用 Open in default app 打开文件；Claude 也只能改文件、也不能只停用一条（SR） |
| 改了设置文件马上生效（Claude 现在的文档：监视设置文件、改了就重读，S） | Mori 的 pi 配置都在会话建好时读一次，Customize 顶部写着 “Changes apply to new sessions. Sessions already open aren’t affected.”（§4.6；Claude 旧版本也是开始时取快照）。要问（第 3 条） |
| 超过 10,000 个字符的输出存成文件、只给 2,000 个字符的预览（R） | 改为截断（§5.8），不在磁盘上另存钩子的输出。要问（第 9 条） |
| `--debug`、`/debug` 的调试日志，`Ctrl+O` 的转录视图 | Mori 只有后台进程的标准输出日志（§10）与对话流 |
| Claude 的环境变量（`CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`、`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`、`CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`、`CLAUDE_EFFORT`、`CLAUDE_CODE_REMOTE`） | Mori 不读也不设 Claude 的环境变量；bash 用 Mori 自己找到的（方案第 6 节 “Shell”）。唯一设的是 `CLAUDE_PROJECT_DIR`（§5.2），钩子脚本普遍用它 |
| 增强任务的看不见的会话里跑钩子 | Claude 没有对应（它是 Mori 自己的后台记忆运行，Full access、没人能批，记忆规格 §9.6），§6.2 |
| 改 pi | 不改 |

**写规格时定的**（负责人的决定与 Claude 的文档都没给、或 Mori 做不成 Claude 那样的，按推荐定下，**待负责人审**；同时登记进 defaults.md 的“钩子”一节，§12）：

| # | 问题 | 定下的 | 理由 |
| --- | --- | --- | --- |
| 1 | matcher 比对哪个工具名、`tool_input` 是什么 | pi 的工具名与参数原样：`bash`、`powershell`、`read`、`edit`、`write`、`grep`、`find`、`ls`、`mcp__<服务>__<工具>`、Mori 的 `memory`、`subagent`、`ask_user_question` 与 TaskBoard 工具；`tool_input` 是 pi 校验过的参数（`edit` 是 `{ path, edits }`，不是 Claude 的 `file_path`、`old_string`）。matcher 照 Claude 区分大小写，所以 Claude 配置里的 `Bash`、`Edit\|Write` 在 Mori 里不匹配，要写成 `bash`、`edit\|write` | 模型调用的就是这些名字和参数；换成 Claude 的名字与参数是一层兼容（AGENTS.md 工程约束不加兼容层），两边参数的形状也对不上。要问（第 2 条） |
| 2 | `permission_mode` | Ask each time → `default`，Full access → `bypassPermissions`；照 R 各事件的例子，只有 PreToolUse、PermissionRequest、PostToolUse、UserPromptSubmit、Stop、SubagentStop 带，SessionStart、SessionEnd、Notification、PreCompact 不带（§5.3） | Claude 的取值是一组固定的词，脚本按它判断；Full access 是“工作路径里不问”，最接近 `bypassPermissions`（外面与受保护路径 Mori 仍问，§6.3）；R：不是每个事件都有这个字段，看各事件的例子 |
| 3 | 跑命令的 shell | 同 bash 工具用的 bash：这个会话设置的 `getShellPath()`，没有时用后台进程启动时查到的 `findShell` 结果（`configured`、`pi`、`git` 三种的 `shellPath`），`-c <命令>`；只有 `none`（或 WSL 的 bash）算没有 bash，这时用 PowerShell（先 `pwsh.exe` 后 `powershell.exe`，路径在后台进程启动时查一次）；写了 `shell` 时照它（§5.1）。跑钩子的路上不调 pi 的任何 shell 查找函数 | Claude 在 Windows 上先 Git Bash、没有时 PowerShell（R）；与模型的 bash 工具用同一个，免得两边行为不同；pi 的 `getPowerShellConfig()`、不带路径的 `getShellConfig()` 会同步起 `where.exe`（§3 第 14 条），每个调用都查会卡住后台进程 |
| 4 | `CLAUDE_PROJECT_DIR` | 会话的工作路径（`entry.cwd`）；工作路径在 Mori 的 worktree 里时（`worktreeOf(cwd)` 不为 null，`app/src/shared/workspace.ts:469`）是对应的主文件夹 `mainFolder`（你开这个会话的文件夹，同侧栏的分组），stdin 的 `cwd` 仍是 worktree 里的路径；PowerShell 里 `${CLAUDE_PROJECT_DIR}` 换成 `${env:CLAUDE_PROJECT_DIR}` | 照 R 与 W：`${CLAUDE_PROJECT_DIR}` 是会话开始时的项目根，进了 worktree 也不动（指向主文件夹，钩子脚本照样在主文件夹里找），worktree 的路径从 stdin 的 `cwd` 读；Claude 桌面版的 worktree 会话同样指向主文件夹的根 |
| 5 | 实例会话的 `session_id`、`transcript_path` | 用户会话的 id 与会话文件；另带 `agent_id`（实例的 pi 会话 id）、`agent_type`（角色名，基座 `mori`） | Claude 在 subagent 里的写法（R：subagent 里的工具事件带 `agent_id`、`agent_type`） |
| 6 | 哪些会话跑哪些事件 | §6.2 的表：用户会话跑全部；subagent 实例跑三个工具事件、SubagentStop、Notification；TaskBoard 实例只跑三个工具事件与 Notification；增强任务的会话与它的实例都不跑；`finish` 什么钩子都不跑 | Claude 的设置钩子也在 subagent 里跑（R）；TaskBoard 实例最接近 Claude 的 agent teams，它们的 `TeammateIdle`、`TaskCompleted` 不在十个里；`finish` 是 Mori 自己不显示的收尾确认，Claude 没有 |
| 7 | PreToolUse 与 Mori 的拒绝、路径闸谁先 | `mori-team`、`mori-memory` 先拒绝的调用（交接之后、强制填写、记忆目录写保护）不跑 PreToolUse；钩子在路径闸判断之前跑；`allow` 只省掉第 4 步（按权限模式）的卡，第 3 步（工作路径外、受保护路径）照样出卡，收窄与没人能批照样拒绝；`deny` 在任何模式下都拦；`updatedInput` 换过的参数先按 mori-memory 的记忆目录写保护（`guardWrite`，`app/src/kernel/memoryExtension.ts:238`）再查一次，再进路径闸 | R：`allow` 不盖过 deny、ask 规则，`deny` 在 `bypassPermissions` 下也拦，改过的参数要按规则重新判断。Mori 的这几条拒绝在 pi 的扩展顺序里先于路径闸（`app/src/kernel/sessions.ts:363-374`），把钩子提到它们前面要改扩展顺序；mori-memory 已经按原来的参数放过了，换过的 `path` 可能指进记忆目录；mori-team 的拒绝只看工具名，换参数改不了它 |
| 8 | PermissionRequest 什么时候跑 | 批准卡照常出现，同时跑钩子，谁先决定算谁的 | R：经 canUseTool 的宿主（Claude 桌面版、VS Code）就是这样，钩子与对话框比快；Mori 是桌面 App，同它。先跑完钩子再出卡要处理卡还没挂起时的切 Full access、Allow for this session（`app/src/kernel/approval.ts:269-298`），更复杂 |
| 9 | UserPromptSubmit 在哪里跑 | 后台进程收到 `session.prompt` 时、交给 Team 或 pi 之前（`promptEntry`）；空闲时发出、直接开始回复的在准备中跑（§6.6）；只跑你发的消息，程序投递（Team 投给用户会话的消息、唤醒）不跑 | 协作模式下你的消息先进立项判断（平行 Agent 规格 §5.3），在 pi 的 `input` 事件里拦已经晚了。R：Claude 对后台 subagent 的回报、别的会话发来的消息、定时任务也跑 UserPromptSubmit，它们对应 Mori 的 Team 投递与唤醒；Mori 不跑，因为程序投递是 Mori 自己的协议消息，拦下它们会打乱 TaskBoard 的投递记录。要问（第 12 条：只加上下文、从不拦下，还是照现在不跑） |
| 10 | UserPromptSubmit、SessionStart 的上下文怎样交给模型 | 一条不显示的 `custom_message`（`mori.hook_message`），由 `mori-hooks` 的 `before_agent_start` 处理器作为 pi 的 `BeforeAgentStartEventResult.message` 交：只交给这条消息开始的那次运行，紧跟在你的消息后面；这条消息没有开始运行（扩展命令、输入处理器接手，或 pi 报错）时它的上下文丢掉、记日志；生成中发出的消息（插话、排队、准备中暂存）的上下文等下一次运行开始时才到（§6.6） | pi 的插话与排队一次只取一条（`pi-agent-core/dist/agent.js:139-140`），一条 custom 消息没法和排进去的你的消息进同一次请求；把上下文拼进你的消息会改掉你的消息（界面上也看得到）；`deliverAs: 'nextTurn'` 只在下一次 `_prepareRun` 里取出、别处不清（§3 第 10 条），没开始运行时会跟着下一次不相干的运行走。要问（第 6 条） |
| 11 | SessionStart 在哪里跑 | pi 的 `session_start`：建 pi 会话时 Mori 传 `sessionStartEvent`（打开已有文件为 `resume`，其余为 `startup`）；Mori 每次建用户会话都跑，包括 Check again、建 worktree 时的重建（这两种不跑 SessionEnd） | 重建出来的是新的 pi 会话（新的 cwd、新的设置快照），上一次的上下文只在内存里、随旧会话丢掉（§6.9）；用 pi 自己的事件最简单 |
| 12 | SessionEnd 的 `reason` | 归档、删除（Mori 先关闭会话）为 `other`；退出 Mori 为 `prompt_input_exit`；内部重建、后台进程意外退出不跑 | Claude 的取值里没有“归档”；退出 Mori 最接近“你退出了输入” |
| 13 | PreCompact 的 `trigger` 与范围 | 只在用户会话；pi 的 `threshold`、`overflow` 与模型层换模型时的重建（pi 记为 `manual`）都是 `auto`；Mori 没有 `/compact`，没有 `manual` | 重建是 Mori 自动做的，不是你打的 `/compact`；实例的压缩 Claude 的文档没写 |
| 14 | Stop 与收尾检查、你不在的提醒 | `mori-hooks` 的 `agent_before_settle` 排在 `mori-approval` 之后；前面的处理器已经要接着跑（`event.continue` 为真）时不跑，只在运行真要结束的那个边界跑 | 收尾检查与提醒都会让模型再回答一次，它们之后才是“回复结束”；Stop 被拦时模型接着干活，收尾检查的计数照它的规则（§6.7） |
| 15 | Stop 连续拦几次 | 照 Claude：中间没有工具调用的连续 8 次接着跑之后，第 9 次拦下不再接着跑，这次运行结束，出一行提醒 | R 的上限；Mori 不读 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` |
| 16 | `continue: false` | 用户会话：照你按停止的做法停下这次运行（`abortEntry`，排队的消息回到输入框），`stopReason` 出一行，并作为不显示的 `mori.hook_message` 在下一次运行开始时交给模型（§7.7）；UserPromptSubmit 时等于拦下；Stop 时等于不接着跑；实例会话里只按拦下处理（不停实例的运行）、记日志 | 复用停止的路径，不另造一种结束；R：`stopReason` 留在对话里，接着对话时 Claude 看得到；停实例要经 Team 的停止，Claude 对 subagent 里的 `continue` 没有写 |
| 17 | 相同的处理器只跑一次 | `command` 与 `shell` 都相同的算同一个（不论在哪个文件），只跑排在前面的那条（用户级在前）、用它的 `timeout` | R：几份设置里相同的处理器只跑一次，但没说什么算相同 |
| 18 | 几个钩子的结果怎样合 | PreToolUse 照 R：`deny` > `defer` > `ask` > `allow`；Mori 没有 `-p`，给 `defer` 的那条照 R 在交互会话里的做法整个忽略（不算决定，它的 `additionalContext`、`updatedInput` 也不用），记一行警告（§10），所以实际是 `deny` > `ask` > `allow`；`updatedInput` 用排在最前面那条给的（R：不合并、用哪条没保证）；PermissionRequest 同样按最严：`deny` > `allow`（R 没写）；`additionalContext`、原因都保留，按顺序接起 | 按最严是 Claude 对 PreToolUse 定的，PermissionRequest 照它 |
| 19 | 钩子改了参数时界面怎样 | 工具卡的 Input 照旧是模型写的参数；批准卡显示的是改过的；对话流里不另加提示 | 工具卡的参数来自 `tool_execution_start`，pi 在 `tool_call` 之前就发了（§3 第 3 条），打开会话时来自模型的消息；不另加一种事件去改它。要不要在工具卡下面加一行说明钩子改了参数（Claude 文档没写），要问（第 10 条）；负责人同意之前不做（AGENTS.md“不做规格没写的东西”） |
| 20 | 显示与交给模型的原文 | §7、§8 的原文。照 R、G 的：`Stop hook feedback`（只用于 Stop、SubagentStop 的 `additionalContext`）、`<事件> hook error`、`Failed with non-blocking status code:`、`Allowed by PermissionRequest hook`、没有 Git Bash 时的 `blocking because Git Bash wasn’t found, so only exit code 0 or 2 counts as this hook’s verdict.`（§7.1）；其余是 Mori 写的 | R 只给了这几段原文。R 的例子里退出码 2 拦下时模型拿到 `PreToolUse:Bash hook error: [<命令>]: <stderr>`；Mori 不照它，用 `Blocked by PreToolUse hook: <原因>`：命令原文进模型的上下文与工具卡（命令里可能有密钥，§10 的日志也不写它），而且 `DENIAL_PREFIXES` 按固定的开头认拒绝。要问（第 14 条） |
| 21 | 输出上限 | stdout、stderr 各读前 1 MiB（之后的照读、丢掉）；照 R，`additionalContext`、`systemMessage`、纯文本 stdout 每段超过 10,000 个字符时只留前 10,000 个、接一句说明；Mori 另外对交给模型或给你看的原因（`reason`、`permissionDecisionReason`、`decision.message`、`stopReason`、作为原因的 stderr）同样截断（§5.8） | 照 R 的 10,000 字符，但不另存文件（要问第 9 条）；R 只截前三种，原因也截是 Mori 加的：原因会成为工具结果、进模型的上下文，stderr 最多 1 MiB，不截一条拦下就能塞满上下文 |
| 22 | 测试的名字 | 覆盖检查 `--spec hooks`、编号 `HK-n`、结果文件前缀 `hk-`、App 测试端口 5020–5039 | 同其他规格的写法；文件系统用到 5019 |
| 23 | 没有要信任的项目资源的文件夹 | 工作区不被信任（`projectTrust` 为 `untrusted`、`unasked`）时这个会话一个钩子都不跑，用户级的也不跑（照 R）；`none`（文件夹里没有要信任的项目资源，Mori 不问、按信任处理，`app/src/kernel/trust.ts` 的 `decideTrust`）时用户级钩子照跑 | R：交互会话在你接受信任对话框之前不跑任何设置文件里的钩子，连 `~/.claude/settings.json` 的也不跑；但 Claude 每个文件夹都问，Mori 只在文件夹有要信任的资源时问（方案 5.3），`none` 的文件夹没有人问过。要问（第 11 条） |
| 24 | UserPromptSubmit 拦下时留下什么 | 你的文字回到输入框（同准备中失败），错误卡 `Blocked by UserPromptSubmit hook: <原因>` 只在这次打开里看得到，不写进会话文件，也不在错误卡里接 `Original prompt:` 与原文 | R：给你看的拦下消息末尾是 `Original prompt:` 加原文，并写进会话文件。Mori 的发送前失败都把文字放回输入框、错误卡不进会话文件（v0 chat.md），原文已经在输入框里，再抄一遍是重复；要问（第 13 条） |
| 25 | PreToolUse 的上下文碰上别的拒绝 | `additionalContext` 只接在执行了的调用结果后面和钩子自己拦下的原因后面；被路径闸、你、停止拒绝的调用不接（丢掉、记日志） | R：上下文跟着工具结果。界面按原文整句认你拒绝、按停止的结果（`app/src/renderer/src/state/model.ts:437-443`、`app/src/shared/workspace.ts:562-571`），接上文字之后工具卡会从 `Denied`、`Stopped` 变成 `Failed` |
| 26 | 退出 Mori 时的 SessionEnd | 与关 Team、释放会话同时开始，合计时限固定 1.5 秒（不按 `timeout` 提高）；归档、删除时照 R 按 `timeout` 提高、最多 60 秒（§6.10） | 主进程只给后台进程 3 秒（`SHUTDOWN_TIMEOUT_MS`，`app/src/main/kernel-process.ts:14`），先跑钩子会挤掉写 board.json、结束快照的时间；R 的 60 秒在退出时给不了。要问（第 15 条） |
| 27 | PowerShell 里的退出码与编码 | 交给 `-Command` 的是 `try { [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}`、换行、你的命令、换行、`if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }`（§5.1） | `-Command` 把最后一个程序的非 0 退出码一律变成 1（2026-10-29 在本机实测：`node -e "process.exit(2)"` 退出 1），钩子就拦不了；控制台编码默认是系统代码页（本机 936），stdin 的 UTF-8 JSON 与输出的中文会乱。只接 `; exit $LASTEXITCODE` 时最后一条 cmdlet 失败会变成退出 0（实测），所以按 `$?` 判断；命令里写的 `exit <n>` 照样算数。pi 的 powershell 工具也加了输出编码这一句（§3 第 14 条） |
| 28 | PreCompact 拦下溢出恢复时显示什么 | 一行钩子行 `PreCompact hook blocked context overflow recovery: <原因>`（`error`，§8.2） | R：这时底下的溢出错误照常出现、这次请求失败；pi 把失败的那条回复先从会话里去掉、取消后不带错误，界面在压缩开始时已经去掉了溢出的错误卡（§3 第 19 条），不加这一行回复就无声地结束了 |
| 29 | 钩子要你批准时批准卡上的一行 | 只要这张卡是钩子的 `ask` 出的就有一行：`PreToolUse hook (User settings): <原因>`（项目的写 `Project settings`，两种都有时 `User and Project settings`；没有原因时不带冒号与原因）；后台进程拼好整句交给界面（`hookAsk`，§8.3） | R：钩子 `ask` 出的提示带一个标出来源的标签（设置文件里的钩子是 `[settings]`）；Mori 的两份文件都是设置，用 Customize 的 User / Project 写法。Full access、Allow for this session 下出的卡没有这一行就看不出为什么出卡 |

**要问负责人的**（写规格时按上表先定，审时请回答）：

1. 上面“负责人的决定”两条是包说明转达的，请核对原话。
2. matcher 与 `tool_input` 用 pi 的名字和参数（`bash`，不是 `Bash`），从 Claude 抄来的配置要改名才匹配；要不要改成 Claude 的名字（`Bash`、`Read`、`Edit`、`Write`、`Grep`、`Glob`、`LS`、`PowerShell`）和 Claude 的参数？（§0 第 1 条）
3. 设置文件改了以后，是只对新会话生效（现在），还是像 Claude 现在这样马上对开着的会话生效？（§4.6）
4. 增强任务的看不见的会话里一个钩子都不跑，对吗？（§6.2）
5. SubagentStop 只对 subagent 工具开出的实例；TaskBoard 的 task 等实例结束时要不要也跑？（§6.8）
6. 插话、排队的消息，UserPromptSubmit 给的上下文要到下一次运行才到模型那里，可以吗？（§0 第 10 条）
7. Notification 只在批准卡等了 6 秒时发；提问卡、扩展询问卡，以及 Claude 的 `idle_prompt`（回复后 60 秒没有输入），要不要也发？（§6.11）
8. “不做”里 Mori 能做、只是负责人没提的：`CLAUDE_ENV_FILE`、SessionStart 的 `compact`、PermissionRequest 的 `updatedInput` 与 `updatedPermissions`、`sessionTitle`、`updatedToolOutput`、处理器的 `args`、`async`、`if`、`onFailure`。要哪几项？
9. 超长输出截断，还是照 Claude 存成文件给预览？（§5.8）
10. 钩子改了参数时，要不要在工具卡下面加一行说明（例如 `PreToolUse hook changed the input of <tool>.`）？Claude 不显示；现在不加（§0 第 19 条）。
11. 文件夹里没有要信任的项目资源时 Mori 不问信任，用户级钩子照跑；Claude 每个文件夹都先问、接受之前一个钩子都不跑。照现在，还是这种文件夹也先问一次再跑钩子？（§0 第 23 条）
12. Claude 对后台 subagent 的回报、别的会话发来的消息、定时任务也跑 UserPromptSubmit；Mori 的 Team 投递与唤醒现在不跑。照现在不跑，还是跑、只用它给的上下文、从不拦下？（§0 第 9 条）
13. UserPromptSubmit 拦下时 Claude 在拦下的消息末尾接 `Original prompt:` 与原文、写进会话文件；Mori 把文字放回输入框、错误卡不写进会话文件。可以吗？（§0 第 24 条）
14. 被钩子拦下时模型看到的原文：Claude 是 `PreToolUse:Bash hook error: [<命令>]: <stderr>`（带钩子的命令），Mori 用 `Blocked by PreToolUse hook: <原因>`（不带命令）。可以吗？（§0 第 20 条）
15. 退出 Mori 时 SessionEnd 钩子最多 1.5 秒（Claude 可以按 `timeout` 提到 60 秒）：要不要让主进程退出时等得更久？（§0 第 26 条）

**语言**：钩子交给模型的内容原样转交，Mori 只在前面加 §7 的英文标签；界面文字是英文，照 [ui-strings.md](../v0/ui-strings.md)（§11 写了要加的条目）；
文档正文、代码注释用中文；代码、日志、错误输出用英文；日志里不写命令原文、stdin、stdout、stderr（§10）。

## 1. 术语与代码名

| Claude 用语 | 本文与代码 | 界面 | 说明 |
| --- | --- | --- | --- |
| hook | 钩子；一条处理器 `HookCommand` | `Hooks` | 只有 `type: "command"` |
| hook event | 事件；`HookEvent`（`shared/hooks.ts` 的 `HOOK_EVENTS`，按 §6.1 的顺序） | 原文：`PreToolUse` 等 | |
| matcher group | 一组：`HookGroup { matcher, hooks }` | — | 设置里事件下面的一项 |
| matcher | matcher | `Matcher` | §4.3 |
| scope | 来源 `user` / `project` | `User` / `Project` | 同 Customize 其他节 |
| block | 拦下 | — | 退出码 2 或 JSON 的决定 |
| non-blocking error | 非阻断错误 | `<Event> hook error: …` | §5.6 |
| — | 钩子行：`HookLine`，会话条目与事件都叫 `mori.hook_line` | 对话流里的一行 | 给你看的；不进模型的上下文 |
| additionalContext、反馈 | 钩子消息：`custom_message`，`customType: 'mori.hook_message'`，`display: false` | 不显示 | 给模型看的（§7） |
| — | `HookSession`（`kernel/hooks.ts`） | — | 一个会话的钩子：建会话时读的快照（§4.6）、正在跑的进程、Stop 的计数 |
| `disableAllHooks` | 同名 | `Disable all hooks` | §4.4 |

其他规格里的“`context` 钩子”“`tool_result` 钩子”（平行 Agent 规格 §14.3、收尾检查规格）指 pi 扩展的事件处理器，本文写作“pi 的处理器”或“`<事件>` 处理器”（例如 `tool_result` 处理器）；本文的“钩子”只指设置里的 command 钩子，单说“处理器”指钩子设置里的一条（`HookCommand`，Claude 的 handler）。

## 2. 组件与代码落点

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 共享 | `shared/hooks.ts`（新） | `HOOK_EVENTS`；`HOOK_LINE_TYPE = 'mori.hook_line'`、`HOOK_MESSAGE_TYPE = 'mori.hook_message'`；`HookLineSchema`（zod）；`HooksInfo`；命令 `hooks.get`、`hooks.setDisabled` 的 zod；§7.1、§7.2 两种拒绝原文的开头 `HOOK_BLOCK_PREFIXES`（界面不能 import `kernel/`，所以放在 shared） |
| 设置 | `kernel/hookConfig.ts`（新，纯函数） | `readHooks(user, project, files)` → `{ groups, problems }`（§4.1、§4.2、§4.5）；`matches(matcher, value)`（§4.3）；`disabledOf(user, project)`（§4.4）；`dedupe(commands)`（§5.5） |
| 运行 | `kernel/hookRun.ts`（新） | `runHook(command, stdin, options)`：起进程（`options.shell` 是调用方给的、已经查好的 `{ shell, args }`）、接住 stdin 与进程的错误、写 stdin、时限、按 signal 杀进程树、读 stdout 与 stderr、进程退出后按 §5.4 结束读取（§5.1–§5.4、§5.8）；纯函数 `powershellCommand(command)`（§5.1 的包装）、`parseOutcome(event, result)`（§5.6、§5.7 与 §6 各事件的 zod）与 `combine(event, outcomes)`（§5.5） |
| 会话的钩子 | `kernel/hooks.ts`（新） | `HookSession`：用户会话建好时从它的 SettingsManager 读一次，它的实例用这份快照（§4.6）；建时按 §5.1 定下 shell；`run(event, value, input, signal)`；§6 各事件的处理；`extension()` 即 inline extension `mori-hooks`（`tool_result`、`before_agent_start`（交上下文，§6.6）、`agent_before_settle`、`agent_settled`、`session_start`、`session_before_compact`、`tool_execution_start` 的计数）；`gateHooks()` 交给路径闸；`stopAll()`；`prompting()`（链上还有没过完钩子的消息，§6.6）；写钩子行（`mori.hook_line` 条目与事件） |
| 你的消息 | `kernel/hookPrompt.ts`（新） | UserPromptSubmit 与“先等 SessionStart”（§6.6）：空闲时发出的作为 `ReplyStart.before` 在准备中跑；其余的在一个用户会话一条按发送顺序的链上跑，停止时交回 |
| 命令 | `kernel/hookCommands.ts`（新） | `hooks.get`（每次新读，信任规则同 `resolveViews`，`app/src/kernel/resources.ts:84-106`）；`hooks.setDisabled`（在 pi 的文件锁里只改 `disableAllHooks`，§8.1） |
| 设置文件的改写 | `kernel/defaultTools.ts`（改） | 把 `rewrittenSettings`（`:172-193`）里“读原文、去 BOM、查是对象、两个空格写回”的部分提成 `rewriteSettings(current, file, edit)`，`loadStorage`（`:195-202`）导出；`defaultTools` 与 `disableAllHooks` 两处共用，不另写一份 |
| 路径闸 | `kernel/approval.ts`（改） | `GateOutput.hooks`（含 mori-memory 的 `guardWrite` 要的设置，§6.3）；`onToolCall`（`:387-403`）里先跑 PreToolUse（§6.3）；`request()`（`:424-445`）出卡时跑 PermissionRequest、开 Notification 的 6 秒计时（§6.4、§6.11）；`finish`（`:474-486`）结束时杀掉这张卡的钩子、清计时；`rejectForStop`（`:533-546`）把正在跑 PreToolUse 钩子的调用同挂着的卡一样处理（杀掉钩子、按停止拒绝、进 `endWaiters` 等它结束） |
| 会话表 | `kernel/sessions.ts`（改，只接线：文件已 1936 行，加的不超过 30 行；`createEntry` 已 49 行，钩子的接线放进 `kernel/hooks.ts` 的一个函数里调用） | 扩展列表加 `mori-hooks`（`:386-389`，`mori-approval` 之后、`mori-snapshots` 之前）、`requiredExtension` 认它（`:416-422`）；`createEntry`（`:503-551`）建 `HookSession`、交给路径闸、给 `createAgentSession` 传 `sessionStartEvent`；`Entry.hooks`；`promptEntry`（`:1094-1111`）经 `hookPrompt.ts`；`startReply` / `prepareReply`（`:1189-1222`）的 `before` 与新的结果 `blocked`；`isIdle`（`:969-971`）以外的忙闲判断认 `prompting()`（§6.6）；`dispatch`（`:1129-1137`）、`dialogStart`（`:1697-1711`）带上 `hookContext`；`runPrompt`（`:1254`）与 `sendToPi`（`:1159`）调 pi 之前把上下文交给 `HookSession`；`stopRun`（`:1317`）与 `release`（`:952`）先 `stopAll()`；`closeSession`（`:983-990`）与 `shutdownSessions`（`:1926-1936`）跑 SessionEnd；`createSession`（`:674-680`）、`openFromFile`（`:776-784`）、`recheckAgents`（`:1606-1626`）返回前与 `worktreeSession.ts` 的重建之后调 `entry.hooks.ready()`（§6.9） |
| Team | `kernel/teamHost.ts`、`kernel/team.ts`、`kernel/instances.ts`（改） | `InstanceSpec.subagent: boolean`（`team.ts` 的 `instanceSpec`，`:1150-1183`，为 `lane.subagent !== null`）与 `InstanceSpec.hooks`（用户会话的钩子快照，§4.6）；`instanceSetup`（`instances.ts:65-77`）把它们与用户会话的 id、会话文件（`spec.parentSession`）、角色交给 `HookSession`；`HeldItem.hookContext`（`teamHost.ts`）Team 原样传递 |
| 拒绝原文 | `shared/workspace.ts`（改） | `DENIAL_PREFIXES`（`:545-556`）加 `HOOK_BLOCK_PREFIXES` 的两行（按开头认，`label: null`） |
| 协议 | `shared/protocol.ts`、`kernel/commands.ts`（改） | 命令 `hooks.get`、`hooks.setDisabled` 与 `handleHooksCommand`（同 `handleToolsCommand`，`commands.ts:50-76`）；事件 `mori.hook_line`；`ApprovalEndBy`（`:792`）加 `'hook'`；`ApprovalRequestInfo`（`:656-671`）与 `TeamApprovalRequest`（`shared/team.ts:378`）加 `hookAsk: string \| null`（批准卡上那一行的整句，§8.3） |
| 界面 | `renderer/src/components/ToolsHooks.tsx`（新）；`ToolsPage.tsx`、`state/tools.ts`、`state/transcript.ts`、`state/history.ts`、`state/model.ts`、`components/Transcript.tsx`、`components/ToolCard.tsx`、`components/ApprovalCard.tsx`、`state/actionLog.ts`（改） | §9 的两张状态表 |
| 合成端点 | `tests/fake-endpoint/hooks.mjs`（新，synthetic） | 认出 §7 的几种开头、`hk-scenario:<名字>` 的场景（§13.1） |

`kernel/hookConfig.ts`、`kernel/hookRun.ts` 不 import pi 的运行时代码（`hookRun.ts` 只用 `node:child_process`；shell 的路径由调用方给）；`kernel/hooks.ts` 只 `import type` pi 的类型（AGENTS.md 工作约定第 7 条）。

## 3. pi 上的落点（写规格时已核实）

| # | pi 1.3.0 的行为 | 位置 | 本文怎样用 |
| --- | --- | --- | --- |
| 1 | `tool_call`：按扩展顺序调处理器，第一个 `block: true` 就返回；没有“放行、后面的别再管”这种结果；处理器抛错不接住，调用按拦下处理 | `pi-coding-agent/dist/core/extensions/runner.js:957-972`；`dist/core/agent-session.js:327-347` | PreToolUse 的 `allow` 要省掉 Mori 的卡，只能在路径闸自己的处理器里做（§6.3） |
| 2 | 拦下的原因成为这次调用的工具结果（`isError: true`）；处理器返回后 signal 已中止时结果是 `Operation aborted` | `pi-agent-core/dist/agent-loop.js:493-517`、`:500-506` | §7.1、§7.2 的原文就是模型看到的 |
| 3 | 改参数要在原对象上改 `event.input`：它就是之后执行的参数，不再校验；换成新对象不起作用。`tool_execution_start`（Mori 的预告、界面的工具卡参数）在 `tool_call` 之前发，带的是原来的参数 | `dist/core/extensions/types.d.ts:1089-1098`；`agent-loop.js:378-384`、`:491-531`；`app/src/kernel/sessions.ts:232-235` | `updatedInput`（§6.3）；工具卡那一行（§0 第 19 条） |
| 4 | `tool_result`：只对执行了的调用发（被拦下的不发），结果是错误的也发；处理器串着跑，换 `content` 时没给 `structuredContent` 就丢掉它；出错只记扩展错误 | `runner.js:900-956`；`agent-session.js:349-382`；`agent-loop.js:386-397` | PostToolUse 与 PreToolUse 的上下文（§6.3、§6.5） |
| 5 | 一条回复里的多个调用一个接一个执行 | `app/src/kernel/sessions.ts:526` | 每个调用的钩子按顺序跑 |
| 6 | `agent_before_settle`：处理器拿到前面处理器累计的 `entries` 与 `continue`，返回的 `entries` 替换累计的、`continue` 取最后给的；你按停止时不调；`ctx.signal` 为空；处理器跑的时候按停止，结果丢掉 | `runner.js:759-806`；`agent-session.js:1418-1431`、`:1537-1560`；finish-check §3 第 1、2、5 条 | Stop、SubagentStop（§6.7、§6.8）；停止要由 Mori 自己杀进程（§5.4） |
| 7 | `session_start` 在 `bindExtensions` 里发、等处理器返回；`reason` 来自 `createAgentSession` 的 `sessionStartEvent`，不传时为 `startup`（Mori 现在不传） | `agent-session.js:200`、`:2651`；`dist/core/sdk.d.ts:64`、`sdk.js:319`；`app/src/kernel/sessions.ts:520-535` | SessionStart（§6.9）：处理器只开始跑钩子、不等 |
| 8 | `session_shutdown` 是 Mori 自己在 `release` 里发的，一律 `reason: 'quit'` | `app/src/kernel/sessions.ts:952-966` | SessionEnd 不用它，从 Mori 关闭会话的两处跑（§6.10） |
| 9 | `session_before_compact`：返回 `{ cancel: true }` 取消；手动的 `compact()` 抛 `Compaction cancelled`；自动的发 `compaction_end { aborted: true }`、不重试；事件带 `reason`（`manual` / `threshold` / `overflow`）与 `signal` | `types.d.ts:601-611`、`:1137-1140`；`agent-session.js:2201-2266`、`:2492-2617` | PreCompact（§6.12） |
| 10 | `sendCustomMessage(…, { deliverAs: 'nextTurn' })` 先存着，下一次运行开始时紧跟在开始的那条消息后面进上下文，并写进会话；只在 `_prepareRun` 里取出，别处不清：`session.prompt` 没开始运行（扩展命令、`input` 处理器接手、抛错）时它留给之后不论哪一次运行；`custom` 消息发给模型时是 `role: 'user'` | `agent-session.js:1815-1830`、`:1449-1482`（取出在 `:1481-1482`）；`dist/core/messages.js:89-96` | 不用它交上下文，用第 20 条（§0 第 10 条）；`stopReason` 的消息（§7.7）同样经第 20 条 |
| 11 | 插话与排队的队列一次只取一条（`one-at-a-time`） | `pi-agent-core/dist/agent.js:60-86`、`:139-140`；`agent-loop.js:184-195` | §0 第 10 条 |
| 12 | `getGlobalSettings()`、`getProjectSettings()` 给各自文件的副本；项目不信任时项目一份为 `{}`；`getSettings()` 合并时数组是替换（项目的 `hooks.PreToolUse` 会盖掉用户级的）；pi 保存时不认得的键原样保留；文件不是 JSON 时那一份按 `{}`、错误记进 `drainErrors` | `dist/core/settings-manager.js:16-33`、`:257-279`、`:332-337`、`:449-485`、`:510-514` | 两份分开读再接起（§4.2）；`hooks`、`disableAllHooks` 不怕 pi 改写设置 |
| 13 | 项目的 `.pi/settings.json` 本来就是要问信任的资源 | `dist/core/trust-manager.js:8-17`；`app/src/kernel/trust.ts:37-76` | 项目里写了钩子会照常问 “Trust this workspace?”（§4.2） |
| 14 | 导出了 `getShellConfig(path)`（返回 `{ shell, args: ['-c'] }`）与 `getPowerShellConfig()`（先 `pwsh.exe` 后 `powershell.exe`，参数 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`）；`getPowerShellConfig()` 与不带路径的 `getShellConfig()` 经 `findExecutableOnPath` 同步起 `where`（`spawnSync`，每次最多 5 秒）；`killProcessTree` 没导出；pi 的 powershell 工具在命令前加 `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}` | `dist/index.d.ts:44`；`dist/utils/shell.js:15-33`、`:58-114`、`:157-170`；`dist/core/tools/powershell.js:4`、`:11-13` | §5.1：路径只在后台进程启动时查一次，PowerShell 的命令照 §0 第 27 条包一层；杀进程树用 `git.ts` 的做法（§5.4） |
| 15 | `pi.exec` 与 bash 工具的执行器都不能往 stdin 写东西（`stdio: ['ignore', …]`，或只在 `commandTransport` 为 stdin 时用）；bash 工具往 stdin 写时先 `child.stdin?.on("error", () => { })` | `dist/core/exec.js:10-43`；`dist/core/tools/bash.js:48-125`、`:70-72` | Mori 自己起进程，同样先接住 stdin 的错误（§5.1） |
| 16 | 会话文件在有第一条你的消息或助手消息之前不写盘，之前的条目留在内存里 | `dist/core/session-manager.js:791-813` | SessionStart 的上下文不在建会话时写，随你的消息交（§6.9） |
| 17 | pi 的命令行迁移看到 `<agentDir>\hooks\` 目录会提示 “Hooks have been renamed to extensions” | `dist/migrations.js:203-209` | Mori 不跑这段迁移；本文不用那个目录 |
| 18 | pi 等子进程结束不等 `close`：`exit` 之后等 stdout、stderr 都 `end`，或安静 100 毫秒（`EXIT_STDIO_GRACE_MS`，每来一段输出重新计时）就结束并 `destroy()` 两个流；留着管道的后代进程不让 `close` 到来。这个函数没导出 | `dist/utils/child-process.js:3`、`:23-105` | §5.4 照这个规则写一份 |
| 19 | 溢出恢复的压缩：pi 先把失败的那条回复从会话里去掉，再发 `compaction_start { reason: 'overflow' }`；扩展取消时按中止处理，`compaction_end` 不带 `errorMessage`。Mori 的界面在 `compaction_start`（`overflow`）时去掉对话流最后那张溢出的错误卡 | `agent-session.js:2437-2442`、`:2511-2527`、`:2587-2596`；`app/src/renderer/src/state/transcript.ts:531-540`、`:566-567` | PreCompact 拦下溢出恢复时要另出一行（§6.12） |
| 20 | `before_agent_start`：每个处理器可以返回一条 `message`，pi 把它们（custom 消息）放在开始的那条消息与 nextTurn 消息之后、进这次运行；只在一次运行开始时发（插话、排队送达不发） | `dist/core/extensions/runner.js:1121-1164`；`agent-session.js:1449-1492` | UserPromptSubmit、SessionStart 的上下文与 `stopReason` 的消息（§6.6、§6.9、§7.7） |

## 4. 设置

### 4.1 写法

照 Claude（R、SR）：设置文件顶层的 `hooks` 是一个以事件名为键的对象，每个事件是一组的数组，每组有可选的 `matcher` 与 `hooks`（处理器的数组）。

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [ { "type": "command", "command": "node C:/hooks/guard.mjs", "timeout": 30 } ] }
    ]
  },
  "disableAllHooks": false
}
```

处理器的字段：

| 字段 | Mori |
| --- | --- |
| `type` | 必须是 `"command"` |
| `command` | 必须是非空字符串，交给 shell 跑（§5.1） |
| `timeout` | 可选，秒，正数；不写时按 §5.4 |
| `shell` | 可选，`"bash"` 或 `"powershell"`（§5.1） |
| `statusMessage` | 忽略 |
| `once` | 忽略（R：只在技能 frontmatter 里起作用，设置文件里忽略）：写了的那条照常每次都跑 |
| `args`、`async`、`asyncRewake`、`if`、`onFailure` | 不支持：写了的那条列为问题、不跑（§4.5） |
| 其他键 | 忽略（同 pi 对设置里不认得的键） |

### 4.2 来源、合并与信任

- 两份：用户级 `<agentDir>\settings.json`（Mori 的 `<userData>\pi\settings.json`，`app/src/main/kernel-process.ts:34-37`、`:71-76`）与项目的 `<cwd>\.pi\settings.json`；
  读法：用户会话自己的 SettingsManager（`app/src/kernel/sessions.ts:406-409`）的 `getGlobalSettings().hooks` 与 `getProjectSettings().hooks`（§3 第 12 条），**不用** `getSettings()`。
- 信任（照 R：交互会话在接受工作区信任之前，任何设置文件里的钩子都不跑，连用户级的也不跑）：会话打开时的信任判断（`TrustDecision.projectTrust`，`app/src/kernel/trust.ts` 的 `decideTrust`）
  为 `untrusted`（你选了 Don’t trust，或 trust.json 记着不信任）或 `unasked`（该问而没有回答）时，这个会话的快照里一个钩子都没有，两份文件都不读；
  为 `trusted` 时两份都读；为 `none`（文件夹里没有要信任的项目资源，Mori 不问、按信任处理）时读用户级的（项目一份本来不在，§0 第 23 条）。项目里写了钩子本来就要问信任（§3 第 13 条）。
  实例用所属用户会话的快照（§4.6），所以也用它的信任判断。
- 增强任务的看不见的会话另有 §6.2 的规则（不跑钩子）。
- 合并照 Claude（SR：钩子跨文件合并、不互相替换）：每个事件的组按“用户级在前、项目在后，各按文件里的顺序”接起来。相同的处理器只跑一次（§5.5）。
- 不读 `.claude/settings.json`、`.claude/settings.local.json`，也不读 pi 包、技能、`.mori/agents` 里的任何钩子。

### 4.3 matcher

照 R 的三种：

| matcher | 怎样比 |
| --- | --- |
| 不写、`""`、`"*"` | 都匹配 |
| 只含字母、数字、`_`、`-`、空格、`,`、`\|` | 按 `\|` 或 `,` 拆开、去掉两边空格，逐个与值精确比较（区分大小写）：`edit\|write` 与 `edit, write` 相同 |
| 含别的字符 | 不锚定的 JavaScript 正则（`new RegExp(matcher).test(value)`）：`^mcp__`、`mcp__memory__.*`。不合法的正则按 §4.5 列为问题、这一组不跑 |

所以 `mcp__memory` 按精确比较，不匹配 `mcp__memory__create`（同 R）。每个事件比对的值见 §6.1；UserPromptSubmit 与 Stop 不看 matcher（写了也照跑，R：静默忽略）。

### 4.4 `disableAllHooks`

- 布尔值，两份设置里都可以写。生效的值照 Claude 的设置优先级（S：项目盖过用户）：受信任的项目写了时用项目的，否则用用户级的，都没写为 `false`。所以项目的 `false` 盖过用户级的 `true`。
- 为真时这个会话一个钩子都不起（十个事件都不跑），Customize 的列表照常列出（§9）。没有单独停用一条的写法（SR）。
- Customize 的开关只写用户级那一份（§8.1）；项目写了时开关只读（customize-hooks.md）。

### 4.5 有问题的条目

读设置时逐条检查；有问题的那一条（处理器、组或事件，按问题所在的那一层）不跑，同一文件里别的照跑（S：不认得的事件只跳过那一项）。问题写进 `HooksInfo.problems`（Customize 列出，§8.1）并在建会话时记日志（§10）。
`path` 是从 `hooks` 起的位置，例如 `hooks.PreToolUse[0].hooks[1]`。原文（英文，临时默认值；在 Customize 里显示，所以引号照 ui-strings.md 用 “ ”，同 `This server is set to “codemode”.`）：

| 问题 | `message` |
| --- | --- |
| `hooks` 不是对象 | `“hooks” must be an object keyed by hook event.` |
| 事件名不是 §6.1 的十个之一 | `Mori doesn’t run “<名字>” hooks.` |
| 事件的值不是数组、组不是对象、组的 `hooks` 不是数组 | `Must be an array.` / `Must be an object.` / `“hooks” must be an array.` |
| `matcher` 不是字符串 | `“matcher” must be a string.` |
| 正则不合法 | `Invalid matcher: <RegExp 的错误原文>` |
| `type` 不是 `"command"` | `Mori runs command hooks only (type “<type>”).`（没写 `type` 时 `“type” must be “command”.`） |
| `command` 不是非空字符串 | `“command” must be a non-empty string.` |
| `timeout` 不是正数 | `“timeout” must be a positive number of seconds.` |
| `shell` 不是两种之一 | `“shell” must be “bash” or “powershell”.` |
| 写了不支持的字段 | `Mori doesn’t support “<字段>” in hooks.` |

设置文件本身不是 JSON（pi 按 `{}` 读、错误进 `drainErrors`，§3 第 12 条）时，这份文件里的钩子都不跑，`HooksInfo.readErrors` 记 `{ file, message }`（原文同 pi 的错误）。

### 4.6 什么时候读

用户会话建好时读一次（`createEntry` 在建路径闸之前建 `HookSession`，读的是 `startUser` 刚为这个会话建的 SettingsManager，`createSettings`，`sessions.ts:406-409`；
`loadResources` 之后它按同样的文件再合并一次，`:394-396`，内容相同），之后这个会话一直按这份快照：
同 Mori 读别的 pi 配置（v0 m6-checks；Customize 顶部 “Changes apply to new sessions. Sessions already open aren’t affected.”）。打开着的会话不因设置文件改了而变；新建、重新打开、重启后重新打开的会话按新的读。
实例（TaskBoard 与 subagent 的）不读自己的 SettingsManager：`startInstance`（`sessions.ts:1638-1651`）往往在用户会话打开很久之后才建实例的设置，那时读会拿到之后改过的文件，
`none` 的会话里中途出现的 `.pi/settings.json`（例如模型跑的 `git checkout`）也会不经信任就跑。所以 `InstanceSpec.hooks` 带所属用户会话的快照（组、`disabled`、读不出的文件），
`instanceSetup` 交给实例的 `HookSession`；实例只按 §6.2 挑它跑的事件。
Customize 的列表每次进入、每次按开关之后新读（§8.1），所以它显示的是文件现在的样子，不一定是某个开着的会话正在用的。

## 5. 跑一条钩子

### 5.1 进程与 shell

后台进程自己起进程（pi 的执行器不能写 stdin，§3 第 15 条）：`spawn(shell, [...shellArgs, command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })`。

- **先接住错误再写**（同 pi 的 bash 工具，§3 第 15 条）：`child.on('error', …)` 接起不来（`spawn` 的错误，按 §5.6 的“起不来”）；`child.stdin.on('error', …)` 在写之前挂上：
  不读 stdin 就退出的钩子很常见（通知、`echo`、Stop 钩子），这时还在写的大 stdin（PostToolUse 的 `tool_response`、`write` 的内容）会报 `EPIPE`、`EOF` 或 `ERR_STREAM_DESTROYED`，
  没人接住时整个后台进程退出（2026-10-29 在本机实测：给 200 毫秒后退出的子进程写 4 MiB，`Error: write EOF … Unhandled 'error' event`）。这几种按正常处理（钩子不读 stdin 是允许的），记一行日志（§10，只写处理器的标识，不写内容）；别的错误同样记日志、不影响结果。
- **然后** `child.stdin.end(<stdin 的 JSON>)`。

shell 在建 `HookSession` 时定下（§2），`runHook` 只拿到已经查好的 `{ shell, args }`，跑钩子的路上不调 pi 的任何 shell 查找函数（它们同步起 `where.exe`，§3 第 14 条）：

| 情况 | shell |
| --- | --- |
| bash 的路径 | `settings.getShellPath()`（用户级或受信任项目设置的 `shellPath`，或 Mori 放进内存的 Git Bash）；没有时用后台进程启动时查到的 `findShell` 结果（`app/src/kernel/shell.ts`：`configured`、`pi`、`git` 三种都有 `shellPath`；`pi` 这种 Mori 不放进设置，`getShellPath()` 为空）。只有结果为 `none`、或路径是 WSL 的 bash（下面）时算这个会话没有 bash |
| 没写 `shell`，这个会话有 bash | `<bash.exe> -c <command>`（即 `getShellConfig(<bash 的路径>)` 的结果：带路径时只查文件在不在） |
| 没写 `shell`，这个会话没有 bash | PowerShell：`<pwsh.exe 或 powershell.exe> -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <下面的包装>`（同 R：没有 Git Bash 时用 PowerShell），并按 §6.3、§6.4 的“没有 Git Bash”一条处理 |
| `"shell": "bash"` | 同第二行；这个会话没有 bash 时起不来，按 §5.6 的“起不来” |
| `"shell": "powershell"` | 同第三行的 PowerShell（R：先 `pwsh.exe` 后 `powershell.exe`）；命令里的 `${CLAUDE_PROJECT_DIR}` 先换成 `${env:CLAUDE_PROJECT_DIR}`（R；不带花括号的 `$CLAUDE_PROJECT_DIR` 不换） |

- **PowerShell 的路径**：后台进程启动时与 `findShell` 一起查一次（`shell.ts` 的 `runSystem('where.exe', …)`，先 `pwsh.exe` 后 `powershell.exe`，同 pi 的顺序），之后复用；都没有时 PowerShell 的钩子按“起不来”。
- **PowerShell 的包装**（`hookRun.ts` 的纯函数 `powershellCommand`，§0 第 27 条，临时默认值）：交给 `-Command` 的是

  ```text
  try { [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}
  <command>
  if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }
  ```

  第一行让 stdin 的 JSON 与输出按 UTF-8 走（不然按系统代码页，中文的 `prompt`、路径会乱）；最后一行让最后那个程序的退出码成为钩子的退出码（`-Command` 本来把非 0 一律变成 1，退出码 2 就拦不了），
  最后一条 cmdlet 失败时照 PowerShell 本来的做法为 1；命令里自己写的 `exit <n>` 照样算数。各行之间用换行，命令以注释结尾也不吞掉最后一行。2026-10-29 在本机（Windows PowerShell 5.1，代码页 936）实测：
  `node -e "process.exit(2)"` 不包为 1、包了为 2；`throw "x"` 为 1；中文 `prompt` 读出的长度对了、输出的中文不乱。

pi 对 WSL 的 `System32\bash.exe` 给的是从 stdin 读命令的写法（`commandTransport: 'stdin'`，`shell.js:8-14`），与 stdin 的 JSON 冲突：这种路径按“没有 bash”处理。

### 5.2 cwd 与环境变量

- cwd：会话的工作路径（`entry.cwd`，与 `ctx.cwd` 同一个值）。不存在时（例如 worktree 被删了）照 R 的顺序取第一个还在的：worktree 会话的主文件夹（`CLAUDE_PROJECT_DIR`，§0 第 4 条）、
  用户目录（`os.homedir()`）、系统临时目录（`os.tmpdir()`），记一行警告日志（R：会话开始的文件夹、项目根、用户目录、系统临时目录；Mori 的会话开始的文件夹就是工作路径或主文件夹）。
- 环境变量：后台进程自己的（`process.env`：PATH 最前面已有 Mori 带的 `rg.exe`、`fd.exe` 所在目录，依赖 U76 的 `app/src/main/kernelPath.ts`；没有 API key，key 只在内存里，方案第 6 节），加上 `CLAUDE_PROJECT_DIR`（§0 第 4 条）。
  不用 bash 工具的 `workEnv`（`TEMP` 指向 `.work\tmp`，`app/src/kernel/workspace.ts:57-69`）：钩子不是模型跑的命令。
- 不读写 `CLAUDE_ENV_FILE`（§0“不做”）。

### 5.3 stdin 的公共字段

一个 JSON 对象（UTF-8，一行），每个事件都有这几项（`permission_mode` 除外），再加 §6 各事件自己的字段：

| 字段 | 值 |
| --- | --- |
| `session_id` | 用户会话的 pi 会话 id（实例里也是它所属用户会话的，§0 第 5 条） |
| `transcript_path` | 用户会话的 pi 会话文件路径（`.jsonl`，pi 的格式，不是 Claude 的；还没写盘时文件可能不存在，§3 第 16 条） |
| `cwd` | §5.2 的 cwd（不存在时是原来的工作路径；worktree 会话是 worktree 里的路径，§0 第 4 条） |
| `permission_mode` | 只在 PreToolUse、PermissionRequest、PostToolUse、UserPromptSubmit、Stop、SubagentStop（R 这几个事件的例子带它；SessionStart、SessionEnd、Notification、PreCompact 的不带，R：不是每个事件都有）：这个会话此刻的权限模式，`ApprovalPolicy.promptMode()`（`approval.ts:230`）为 `ask` → `default`，`full` → `bypassPermissions` |
| `hook_event_name` | 事件名 |
| `agent_id`、`agent_type` | 只在实例会话里：实例的 pi 会话 id、角色名（基座为 `mori`，`shared/team.ts:11`） |

三个工具事件对 MCP 工具（`mcp__<服务>__<工具>`）另带 `mcp_server: { name, source }`（R）：`name` 是服务名，`source` 是定义它的那份 Mori 的 MCP 配置，`user` 或 `project`（`app/src/kernel/mcpConfig.ts` 的 `scope`，建 `HookSession` 时随快照记下）。
Claude 的 `prompt_id`（Mori 没有给每条消息的 id）、`effort`（Claude 的努力等级；Mori 的 Effort 是 pi 的思考强度，取值是另一组）、`scratchpad_dir`（Mori 没有 scratchpad）不带；各事件不带的字段见 §6 与 §12“不带的字段”。

### 5.4 时限、停止与清理

- 时限：处理器的 `timeout`（秒）；不写时照 R：600 秒，UserPromptSubmit 30 秒；SessionEnd 另按 §6.10。
- **什么时候算跑完**（照 pi 的 `waitForChildProcess`，§3 第 18 条；R：钩子自己的进程退出后不久就停止读取）：`runHook` 不等 `close`。进程 `exit` 之后，stdout 与 stderr 都 `end` 了，
  或两个流安静了 100 毫秒（每来一段输出重新计时），就按 `exit` 的退出码结束，并 `destroy()` 两个流。所以钩子起的后代进程留着管道（`bash -c "some-daemon & exit 0"`、通知脚本起的助手）时，
  钩子照样在退出后约 100 毫秒结束，不会卡住这次调用、这次运行或停止。
- 到时：杀掉进程树，输出丢掉，按非阻断错误（`Timed out after <n>s`，§8.2），这个钩子算没有决定。
- 杀进程树：照 `app/src/kernel/git.ts` 的 `killTree`（`:363-395`：System32 的 `taskkill /F /T /PID`，不经 shell；taskkill 失败时退回 `child.kill()` 并记日志），提到 `hookRun.ts` 可以共用的地方或照写一份同样的；
  不用 `child.kill()` 当主路径（Windows 上杀不掉子进程，§3 第 14 条）。到时与中止时 `runHook` 在 taskkill 返回时就结束（等 taskkill 有上限，同 `git.ts` 的 `TASKKILL_WAIT_MS`），
  不等 `exit` 或 `close`：进程已经退出、留下的后代进程 taskkill 找不到时也不会一直等。
- 输出在进程退出之前照常读（§5.8）；结束之后到来的输出丢掉。
- 停止：每次 `run` 带一个 signal，中止时同样杀进程树、不再处理输出。signal 来自：
  - 工具事件：pi 的 `ctx.signal`（处理器开始时读，同 `approval.ts:428-429`）；路径闸的 `rejectForStop` 另外直接杀掉正在跑的 PreToolUse 钩子，并按停止拒绝这次调用（§6.3）；
  - Stop、SubagentStop、SessionStart：pi 不给 signal（§3 第 6 条），由 `HookSession.stopAll()` 中止：`sessions.ts` 的 `stopRun` 在 `session.abort()` 之前、`release` 在 `session.abort()` 之前调用它，
    否则 `session.abort()` 要等钩子到时（pi 等处理器返回，`app/src/kernel/approval.ts:8`）；
  - UserPromptSubmit：在准备中跑的用准备中的 signal（`preparing.controller`），链上的用 `hookPrompt.ts` 自己的 AbortController，停止时中止（§6.6）；
  - PreCompact：pi 事件的 `signal`；PermissionRequest：卡结束时（`finish`）中止；Notification：会话释放时中止。
- 清理：后台进程在 kill-on-close 的作业对象里（`app/src/main/job.ts`），钩子进程是它的子进程，Mori 退出、后台进程崩溃、被强行结束时一起结束（`app/src/main/kernel-process.ts:1-2`）。

### 5.5 同时跑、去重与结果的合并

- 一个事件匹配到的处理器同时开始，全部结束（含到时、被杀）之后才合并结果（R）；一个拦下不让别的停下（G）。
- 去重（§0 第 17 条）：`command` 与 `shell`（没写算 `null`）都相同的处理器只跑排在前面的一条，用它的 `timeout`。
- 合并：
  - 拦下：任何一条拦下就拦下；原因按处理器的顺序、每条一行接起来。
  - PreToolUse 的决定：R 的顺序是 `deny` > `defer` > `ask` > `allow`；给 `defer` 的那条照 R 在交互会话里的做法整个忽略（它的决定、`additionalContext`、`updatedInput`、`systemMessage` 都不用），
    记一行警告（§10），所以合并的是其余几条：`deny` > `ask` > `allow`。PermissionRequest：`deny` > `allow`（§0 第 18 条）。没给决定的不参与。
  - `updatedInput`：用最终决定为 `allow` 或 `ask` 时、排在最前面那条给的；其余记日志（§10）。
  - `additionalContext`、Stop 的原因、`systemMessage`：每条都保留、按顺序（G）。
  - `continue: false`：任何一条给了就算，`stopReason` 取排在最前面那条的。

### 5.6 退出码与 stdout

**stdout 什么时候算 JSON**（R）：只有整个 stdout 是一个 JSON 对象（一行或几行，前后只有空白）时算 JSON 输出：

- 去掉首尾空白后不以 `{` 开头，或以 `{` 开头而不以 `}` 结尾：纯文本（JSON 数组、带引号的字符串、空也是纯文本）。
- 两行或更多、每行单独都能解析成 JSON、第一行以 `{` 开头、最后一行以 `}` 结尾：没有一行是设了任何已知字段（§5.7 与这个事件的字段）的 JSON 对象时算纯文本；有一行是时算解析失败（R）。
- 别的以 `{` 开头、以 `}` 结尾的：按一个 JSON 解析；解析失败、或不合这个事件的 zod（§6 各事件）时算“不合格的 JSON”。

不认得的键忽略，记一行 `Hook JSON output had unrecognized keys: <键>`（R 的原文）；放错层的字段（例如顶层的 `additionalContext`、`permissionDecision`）不起作用（G）；
`hookSpecificOutput.hookEventName` 必须等于这个事件，否则按不合格。

| stdout | 退出码 0 | 退出码 2 | 其他退出码 |
| --- | --- | --- | --- |
| 合格的 JSON | 成功，字段起作用 | 拦下（按下一张表这个事件的效果）；字段照退出码 0 时一样起作用，只是改变不了拦下（`allow` 也放不过）；拦下的原因：JSON 自己给了拦下的决定时用它的原因（`deny` 的 `permissionDecisionReason`、`decision: "block"` 的 `reason`、PermissionRequest `deny` 的 `decision.message`），否则用 stderr（R） | 不看退出码，按字段，不算错误（没有 Git Bash 时的 PreToolUse、PermissionRequest 除外，§6.3、§6.4） |
| 不合格的 JSON | 非阻断错误（`Invalid JSON output: <原因>`） | 拦下，原因是 stderr | 非阻断错误（同左） |
| 纯文本或空 | 成功（UserPromptSubmit、SessionStart 的 stdout 是上下文，其余只记日志的长度） | 拦下，原因是 stderr | 非阻断错误（`Failed with non-blocking status code: <stderr 的第一行>`） |

起不来（`spawn` 报错）、到时、被杀不看输出：起不来与到时按非阻断错误（没有 Git Bash 时的 PreToolUse、PermissionRequest 除外），被杀（停止）什么都不显示。

**退出码 2 在每个事件的效果**（R）：

| 事件 | 效果 |
| --- | --- |
| PreToolUse | 拦下这次调用，stderr 给模型（§7.1） |
| PermissionRequest | 退出码 2 本身不起作用，stderr 丢掉；同时给了 `hookSpecificOutput.decision` 时照它（R：没有 `decision` 的退出码 2 不改变批准流程） |
| PostToolUse | stderr 给模型（§7.5），调用已经执行了 |
| UserPromptSubmit | 拦下这条消息，stderr 给你看、不进上下文（§8.4） |
| Stop | 这次运行接着跑，stderr 给模型（§7.6） |
| SubagentStop | 那个 subagent 接着跑，stderr 给它（§7.6） |
| SessionStart | 拦不了，stderr 只给你看（钩子行，§8.2） |
| SessionEnd | 拦不了，stderr 只给你看：会话已经在关，没有地方显示，只记日志 |
| Notification | 不起作用 |
| PreCompact | 拦下这次压缩（§6.12） |

stderr 在退出码 0 时从不给模型；退出码 1 不拦（R：要拦用 2）。

### 5.7 JSON 的通用字段

| 字段 | 默认 | 效果 |
| --- | --- | --- |
| `continue` | `true` | `false` 时盖过这个事件自己的决定，按 §0 第 16 条停下（Notification、PreCompact、SessionEnd、SessionStart 没有在跑的回复可停，忽略） |
| `stopReason` | — | `continue` 为 `false` 时给你看（钩子行 `Stopped by <Event> hook: …`，§8.2）；照 R 它也留在对话里：用户会话里停下运行的（PreToolUse、PermissionRequest、PostToolUse、Stop）另记一条不显示的 `mori.hook_message`，下一次运行开始时交给模型（§7.7）；UserPromptSubmit 的 `continue: false` 是拦下，原因同 `reason` 不进上下文（§6.6） |
| `systemMessage` | — | 给你看的提醒（钩子行 `<Event> hook: …`）；Notification、PreCompact、SessionEnd 丢掉（R） |
| `suppressOutput` | `false` | 收下，不起作用（R） |

各事件的 `hookSpecificOutput`、`decision`、`reason` 见 §6。§0“不做”里列的输出字段按不认得的键处理，PermissionRequest 的 `updatedInput`、`updatedPermissions` 除外（§6.4）。

### 5.8 输出上限

- stdout、stderr 各留前 1 MiB；之后照常读、读到的丢掉（不停止读：停止读时钩子写满管道会卡住，一直等到时限），什么时候算跑完照 §5.4。按 UTF-8 解码。
- 照 R 截断的（R 只截这几种，每个字段、每条钩子分开量，纯文本 stdout 整个量）：`additionalContext`、`systemMessage`、作为上下文的纯文本 stdout。
  Mori 另外截断的（§0 第 21 条：它们会成为工具结果、进模型的上下文）：`reason`、`permissionDecisionReason`、`decision.message`、`stopReason`、作为原因的 stderr。
  每段超过 10,000 个字符时只留前 10,000 个，后面接 `… [<n> more characters cut]`（`<n>` 为去掉的字符数；Claude 是另存文件给预览，要问第 9 条）。
- 钩子行里的 stderr 只取第一行（§8.2）。

### 5.9 每个处理器的标识

日志与问题里一条处理器写作 `<scope>:<事件>[<组>].hooks[<n>]`，例如 `user:PreToolUse[0].hooks[1]`：去重后跑的是哪一条一眼看得出，又不写命令原文（§10）。

## 6. 事件

### 6.1 对照表

| Claude 事件 | Mori 里什么时候 | 落点 | matcher 比对 | 能做的 |
| --- | --- | --- | --- | --- |
| `PreToolUse` | 模型的每个工具调用、执行之前（`finish` 与 Mori 先拒绝的除外） | `mori-approval` 的 `tool_call`（`ApprovalGate.onToolCall`） | `tool_name` | 拦下、放行、要你批准、改参数、加上下文 |
| `PermissionRequest` | Mori 出批准卡的时候 | `ApprovalGate.request()` | `tool_name` | 替你允许或拒绝 |
| `PostToolUse` | 调用执行完、结果不是错误 | `mori-hooks` 的 `tool_result` | `tool_name` | 给模型反馈、加上下文 |
| `UserPromptSubmit` | 你发出一条消息，Mori 处理它之前 | 后台进程 `promptEntry`（`hookPrompt.ts`） | 不看 | 拦下、加上下文 |
| `Stop` | 用户会话的运行真要结束 | `mori-hooks` 的 `agent_before_settle` | 不看 | 让它接着跑 |
| `SubagentStop` | subagent 工具开出的实例的运行要结束 | 那个实例的 `mori-hooks` 的 `agent_before_settle` | `agent_type` | 让它接着跑 |
| `SessionStart` | 建用户会话（新建、打开、重建） | `mori-hooks` 的 `session_start` | `source` | 加上下文 |
| `SessionEnd` | 归档、删除会话，退出 Mori | 后台进程 `closeSession`、`shutdownSessions` | `reason` | 只能做副作用 |
| `Notification` | 批准卡等了 6 秒 | `ApprovalGate.request()` 的计时 | `notification_type` | 只能做副作用 |
| `PreCompact` | 用户会话压缩之前 | `mori-hooks` 的 `session_before_compact` | `trigger` | 拦下压缩 |

`HOOK_EVENTS` 按这张表的顺序；Customize 的分组也按它（customize-hooks.md）。

### 6.2 哪些会话跑哪些事件

| 会话 | PreToolUse、PermissionRequest、PostToolUse | UserPromptSubmit | Stop | SubagentStop | SessionStart、SessionEnd | Notification | PreCompact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 用户会话（关闭模式、协作模式的对话、合并会话） | 跑 | 跑 | 跑 | — | 跑 | 跑（它自己的卡） | 跑 |
| subagent 工具开出的实例（`kind: 'ask'`，`InstanceSpec.subagent` 为真） | 跑 | — | — | 跑 | — | 跑（它的后台卡） | — |
| TaskBoard 实例（立项、结案、task、Task mode 的临时提问、订阅） | 跑 | — | — | — | — | 跑（它的后台卡） | — |
| 增强任务的看不见的会话，以及它的 Team 的实例（`memory.enhance` 不为空） | — | — | — | — | — | — | — |

- 工作区不被信任（`untrusted`、`unasked`，§4.2）的用户会话与它的实例照上表注册，但快照里没有钩子，十个事件都不起进程（同没写 `hooks`）。
- 没有 `HookSession` 的会话（最后一行）不注册 `mori-hooks`、路径闸的 `hooks` 为 `null`。
- `finish`（收尾检查的确认，`shared/finishCheck.ts`）在每种会话里都不跑 PreToolUse、PermissionRequest、PostToolUse（§0 第 6 条）；它也从不出批准卡。
- 实例里的钩子行写进实例自己的会话文件（§8.2），在 Background tasks 的 View transcript 里看得到（[team-tasks.md](../v1/screens/team-tasks.md)）；不在用户会话的对话流里。

### 6.3 PreToolUse

**什么时候**：路径闸的 `tool_call` 处理器 `onToolCall`（`app/src/kernel/approval.ts:387-403`）里，停止中的检查（`:392`）之后、`decide`（`:393`）之前。
`mori-team`、`mori-memory` 的 `tool_call` 处理器排在路径闸前面，它们先拒绝的调用到不了这里（§0 第 7 条）；`finish` 直接跳过。
钩子跑的时候工具卡照预告显示（`mori.tool_gate`，预告不跑钩子）；结果与预告不同时走现有的更正（`:395-397`）。

**stdin**：公共字段，加 `tool_name`（pi 的工具名）、`tool_input`（`event.input`，pi 校验过的参数，原样）、`tool_use_id`（`event.toolCallId`）；MCP 工具另带 `mcp_server`（§5.3）。

**结果**（合并按 §5.5）：

| 结果 | 来自 | 效果 |
| --- | --- | --- |
| 拦下 | 退出码 2（原因 = stderr，JSON 同时给了 `deny` 时用它的原因，§5.6）；`hookSpecificOutput.permissionDecision: "deny"`（原因 = `permissionDecisionReason`）；旧写法顶层 `decision: "block"`（原因 = `reason`，R：已不推荐） | 返回 `{ block: true, reason: §7.1 }`，不管权限模式、Allow for this session、按目录放行（R：`bypassPermissions` 下也拦）；预告不是 `deny` 时发更正 |
| 要你批准 | `permissionDecision: "ask"` | 照常 `decide`：判断是拒绝（收窄、没人能批）时照旧拒绝（拒绝比询问严）；否则不论 `free`、`full`、`session`、`dir` 都走 `request()` 出卡，卡带 `hookAsk`（§8.3 的整句：来源与 `permissionDecisionReason`）。职责工具（`memory`、TaskBoard 工具、`ask_user_question`、`subagent`）`decide` 不分类，出卡时用 `{ kind: 'duty', toolName, targets: [], scope: 'inside', realCwd: cwd, readOnly: false }`。实例里卡照常是用户会话上的后台卡（`TeamApprovalRequest` 同样带 `hookAsk`） |
| 放行 | `permissionDecision: "allow"`；旧写法 `decision: "approve"` | 照常 `decide`：拒绝照旧拒绝；`ask` 而 `call.scope` 不是 `inside`（工作路径外、受保护路径、看不出的目标，路径闸第 3 步）照旧出卡（R：`allow` 不盖过 ask 规则）；`ask` 而 `scope` 为 `inside`（第 4 步，按权限模式）不出卡，直接 `release(work)`（照旧先建 `.work`） |
| 没有决定 | 退出码 0 没给决定；给 `defer` 的那条（整个忽略、记警告，§5.5）；非阻断错误 | 照今天 |

- **没有 Git Bash**（R 的“Failed hooks on Windows without Git Bash”，v2.1.309）：这个会话没有 bash（§5.1）时，这个事件的每条钩子（Mori 的钩子都是 shell 形式；写了 `shell: "powershell"` 的也算，v2.1.309 起不再除外；`shell: "bash"` 而起不来的也算）
  失败或到时就拦下这次调用。失败照 R 的列法：起不来、到时、不合格的 JSON（解析失败或不合 zod）、退出码不是 0 也不是 2（不论 stdout 是什么，给了放行的 JSON 也算失败）；退出码 0 的纯文本 stdout 不算失败。
  原因是 §7.1 的 Git Bash 那一句（到时为 `timed out`，其余为 `failed`）。有 bash 时这些照 §5.6 按非阻断错误。
- **`updatedInput`**（只在最终决定为 `allow` 或 `ask` 时）：在 `decide` 之前把 `event.input` 原对象上的键全部删掉、换成 `updatedInput` 的（R：整个替换；pi 只认原对象，§3 第 3 条）。
  换过之后先按 mori-memory 的记忆目录写保护再查一次（`guardWrite`，`app/src/kernel/memoryExtension.ts:238`，已导出；它要的 `enhancement`、`memoryDir` 随 `GateOutput.hooks` 交给路径闸）：
  要拒绝时这次调用照它的原文拒绝（`MEMORY_FILES_ONLY`，同 mori-memory 拒绝的），不再出卡（§0 第 7 条：mori-memory 已经按原来的参数放过了）。
  之后路径闸按改过的参数判断、批准卡显示改过的、执行的也是改过的；工具卡的 Input 仍是模型写的，对话流里不另加提示（§0 第 19 条）。`updatedInput` 不是对象时按不合格的 JSON。
- **`additionalContext`**：按 `toolCallId` 记下，接在模型拿到的结果后面（R：与工具结果一起）：执行了的由 `mori-hooks` 的 `tool_result` 加一个文字块（§7.3）；
  被钩子自己拦下的（本节“拦下”、没有 Git Bash 时的拦下、`continue: false`），接在 §7.1 的原因后面（`\n\n` 分隔，开头仍是 `Blocked by PreToolUse hook: `）。
  被路径闸（收窄、没人能批、`.work` 建不起来）、你、停止、mori-memory 的再查拒绝的，不接：上下文丢掉、记日志（§10）。界面按整句认你拒绝与按停止的原文（`REJECTED_TEXT`、`REJECTED_BY_STOP`，
  `app/src/renderer/src/state/model.ts:437-443`），按 `whole` 认的程序拒绝也一样（`app/src/shared/workspace.ts:562-571`），接上文字之后工具卡会从 `Denied`、`Stopped` 变成 `Failed`（§0 第 25 条）。
- **`continue: false`**：这次调用按拦下处理（原因 = `stopReason`，没有时 `No reason given.`，§7.1），钩子行 `Stopped by PreToolUse hook: …`；用户会话再按你按停止的做法停下这次运行（`abortEntry`），
  在处理器返回之后做（处理器里等它会互相等死：`session.abort()` 要等处理器返回），并记下 §7.7 的消息。实例只拦下这次调用（§0 第 16 条）。
- **`systemMessage`**：钩子行（§8.2）。
- **停止**：钩子跑的时候按停止：这次调用同挂着的卡一样处理：`onToolCall` 跑钩子时把这次调用登记进 `endWaiters`（同 `request()` 挂起的卡），
  `rejectForStop`（`approval.ts:533-546`）看到它就杀掉它的钩子、让 `onToolCall` 返回 `REJECTED_BY_STOP`，并等它在 pi 里结束（最多 `STOP_SETTLE_MS`）；
  不登记的话 `rejectForStop` 在没有挂着的卡时立刻返回（`:537`），`session.abort()` 先中止 `ctx.signal`，pi 记下的是 `Operation aborted`，拒绝的原文就丢了（§3 第 2 条）。

### 6.4 PermissionRequest

**什么时候**：`ApprovalGate.request()`（`approval.ts:424-445`）发出批准卡（用户会话自己的 `mori.approval_request`，或实例经 `onRequest` 交给 Team 的后台卡）之后、登记你不在的计时（`register`，`:451-454`）的同时，
开始跑钩子；卡照常显示、照常等你（§0 第 8 条：谁先决定算谁的）。PreToolUse 的 `ask` 出的卡也跑。
不出卡的调用不跑：免批准的、Full access 下工作路径里的、Allow for this session 的、按目录放行的、被收窄或没人能批拒绝的。
R 还对“没人能回答、本来要直接拒绝”的调用跑 PermissionRequest；Mori 里只有增强任务的会话会这样（没人能批，`app/src/kernel/approval.ts:45`、`:118`），它不跑钩子（§6.2），所以没有可跑的。

**stdin**：公共字段，加 `tool_name`、`tool_input`（卡上的参数 `info.args`，即 `event.input` 的副本）；MCP 工具另带 `mcp_server`（§5.3）。没有 `tool_use_id`（R），不带 `permission_suggestions`（它是可选的；Mori 不收 `updatedPermissions`，给了建议也用不上）。

**结果**：

| 结果 | 来自 | 效果 |
| --- | --- | --- |
| 允许 | `hookSpecificOutput.decision.behavior: "allow"`（退出码 0 或 2 都照它，§5.6） | `finish(requestId, 'allow', 'hook', null)`：卡结束（`mori.approval_end` / `mori.team_approval_end` 的 `by: 'hook'`），照 `release` 建 `.work` 后执行；工具卡标 `Allowed by PermissionRequest hook`（G 的原文） |
| 拒绝 | `decision.behavior: "deny"`（退出码 0 或 2）；`message` 是原因 | `finish(requestId, 'reject', 'hook', §7.2)` |
| 拒绝并停下 | `deny` 且 `decision.interrupt: true`；或 `continue: false` | 同拒绝；用户会话再按停止的做法停下这次运行（同 §6.3 的 `continue: false`）；`continue: false` 出 `Stopped by PermissionRequest hook: …` 一行，`interrupt: true` 不另出一行（拒绝的原因已经在工具卡上），之后是 v0 的停止 |
| 没有决定 | 退出码 0 没给决定；退出码 2 而没有 `decision`（stderr 丢掉，R）；非阻断错误；给了 `updatedInput` 或 `updatedPermissions`（按不合格的 JSON，§0“不做”） | 卡照常等你 |

- **没有 Git Bash**：同 §6.3 的失败规则，失败或到时按拒绝（R：`onFailure: "block"` 的失败在 PermissionRequest 上是拒绝），原因是 §7.2 加 Git Bash 那一句。
- **先结束的算数**：你先回答、切 Full access、Allow for this session、按目录放行、你不在到时、停止、会话关闭让这张卡先结束了，`finish` 中止这张卡的钩子（杀进程）、它的结果丢掉；钩子先决定了，卡就结束，你之后点的按钮按“请求已经结束”处理（同今天，`approval.ts:492-494`）。
- 钩子跑的时间不影响你不在的计时（计时从卡出现开始，同今天）。

### 6.5 PostToolUse

**什么时候**：`mori-hooks` 的 `tool_result` 处理器，只对执行了、`event.isError` 为假的调用跑（R：失败的发 PostToolUseFailure，不做）；被拦下的调用 pi 不发 `tool_result`（§3 第 4 条）。
`mori-hooks` 排在 `mori-team` 之后，钩子看到的是 `mori-team` 已经编过号的结果（平行 Agent 规格的证据编号）。

**stdin**：公共字段，加 `tool_name`、`tool_input`（`event.input`，执行的参数）、`tool_use_id`、`tool_response`：`{ content, details }`，`content` 是 `event.content`，图片块只留 `{ type: 'image', mimeType }`（不带数据），`details` 原样（pi 的结构，不是 Claude 的）；
`duration_ms`（R，可选）：路径闸放行这次调用（`onToolCall` 返回）到 `tool_result` 的毫秒数，不含批准与 PreToolUse 钩子的时间（R 同样不含），路径闸放行时按 `toolCallId` 记下时刻；MCP 工具另带 `mcp_server`（§5.3）。

**结果**：

| 结果 | 来自 | 效果 |
| --- | --- | --- |
| 反馈 | 退出码 2（stderr）；`decision: "block"` 加 `reason` | 结果后面加一个文字块 `PostToolUse hook feedback: …`（§7.5），模型照样看到原来的输出（R）；钩子行同一句（§8.2） |
| 上下文 | `hookSpecificOutput.additionalContext` | 结果后面加一个文字块 `PostToolUse hook additional context: …`（§7.5），不出钩子行 |
| 停下 | `continue: false` | 同 §6.3（这个调用的结果照常交给模型） |

- 处理器返回 `{ content: [...event.content, ...新块], structuredContent: event.structuredContent }`：不动 `details`（Mori 从里面读 patch、记忆、subagent 的数据）与 `isError`；没有要加的块时返回 `undefined`。
- PreToolUse 记下的上下文（§6.3）在同一个处理器里、PostToolUse 的块之前加（`isError` 为真的调用也加）。
- 加的块在工具卡的输出里看得到（输出就是 `content` 的文字，`app/src/renderer/src/state/history.ts:89`），实时与打开会话相同。

### 6.6 UserPromptSubmit

**什么时候**：你发出的每条消息（Send、插话、排队、`/task <文字>`、`/` 的技能与扩展命令；照 R，钩子拿到的是你打的那一行、不是展开后的），
后台进程收到 `session.prompt`、在 `promptEntry`（`sessions.ts:1094-1111`）里 `isBlocked` 检查之后、交给 Team（`takesPrompt`，`:1102`）或 `dispatch` 之前。只在用户会话（不含看不见的会话）。
程序投递（`deliver`，`:1684-1691`；Team 的唤醒与 `agent_message`）不跑（§0 第 9 条：R 对后台 subagent 的回报、别的会话的消息也跑，要问第 12 条）。
带 `worktree: true` 的第一条消息在重建出来的会话里跑（`worktreeDeps.promptEntry`，`:1083-1088`），钩子的 `cwd` 是 worktree 里的路径。

**顺序与等待**（`kernel/hookPrompt.ts`）。钩子跑的时候会话不能看起来空闲，否则 Team 的程序投递、`dialogStart` 会在这段时间开始一次运行，`closeSession` 等也会照空闲放行（`isIdle`，`sessions.ts:969-971`）：

1. **空闲时发出、直接开始回复的**（关闭模式下不交给 Team、`isIdle(entry)` 为真、链上没有消息）：`dispatch` 照旧走 `startReply`，钩子作为 `ReplyStart.before` 在准备中跑（`prepareReply` 先跑它、再 `model.prepare`，`:1208-1222`）。
   这期间会话在准备中（`entry.preparing`、`entry.running`），侧栏、程序投递、`dialogStart`、`requireIdle`、`sessionGenerating` 都照准备中按忙；准备中又发的消息按第 2 步。
2. **其余的**（准备中、生成中发出的插话、排队与暂存；交给 Team 的，即协作模式与 `/task <文字>`；`once` 的扩展命令；链上已有消息时空闲发出的）：在一个用户会话一条按收到顺序的链上跑，前一条还在跑钩子时后一条排在后面等；
   过了之后照原来的路径（Team 的 `onUserPrompt`，或 `enterOnce` 之后的 `dispatch`）按那一刻的状态处理：没有 `behavior` 的消息（空闲时发出、准备中暂存的）这时会话在运行时按 `followUp` 交给 pi，
   不按 `undefined` 调（pi 会报 `Agent is already processing`，`agent-session.js:1637-1638`）；在准备中时照旧暂存；空闲时照旧 `startReply`（不再跑钩子）。
   链上有消息时 `HookSession.prompting()` 为真：`closeSession`、`recheckAgents` 与别的 `requireIdle` 调用方拒绝（`GENERATING`，同 Team 有待判断的消息），`busyNow()`、`sessionGenerating()` 为真；
   `deliver`、`dialogStart` 不看它、照旧按 `isIdle`：程序投递可以先开始，你的消息过了钩子之后排在它后面（不然投递会被丢掉，`deliver` 不空闲时只记日志）。
3. 两种都先等这个会话的 SessionStart 钩子跑完（R：第一次回复要等它们，§6.9），再跑 UserPromptSubmit；通过时照原来的路径继续，被拦时见下表。
4. `session.prompt` 命令：第 1 步照旧在开始准备时返回（`held: false`，界面是先显示的消息与 Sending…）；第 2 步在这条消息过了钩子、照原来的路径处理之后才返回（`held` 照旧，生成中是排队区）。不另加状态。
5. 停止（Esc、停止按钮，`abortEntry`，`:1365-1380`）：第 1 步的钩子随准备中停止中止（`preparing.controller`，杀进程），照准备中停止交回（`Stopped before sending`，暂存的进 `queued`）；
   链上的：中止正在跑的钩子（杀进程）、等着的全部丢掉，按发送顺序交回输入框：一个 `mori.prompt_error`，`message` 为 `Stopped before sending`、`text` 为第一条、`queued` 为其余（同准备中停止）；
   你在准备中、生成中按停止时，原来交回的消息排在这些之前。

**stdin**：公共字段，加 `prompt`（这条消息的原文，含输入框里引用芯片拼进去的引用块）；会话有名字时带 `session_title`（同 §6.9，R）。

**结果**：

| 结果 | 来自 | 效果 |
| --- | --- | --- |
| 拦下 | 退出码 2（原因 = stderr，JSON 同时给了 `decision: "block"` 时用它的 `reason`，§5.6）；`decision: "block"`（原因 = `reason`）；`continue: false`（原因 = `stopReason`） | 消息不交给 Team 也不交给 pi（R：拦下的消息到不了模型那里）、不写进会话（R 把拦下的消息写进会话文件、末尾接 `Original prompt:` 与原文，Mori 不这样，§0 第 24 条）。第 1 步：`prepareReply` 的结果为新的 `{ kind: 'blocked', message: §8.4 }`，`giveBack` 照“准备中没能发出”撤回这条与暂存的（暂存的进 `queued`）、发 `mori.prompt_error`，`dispatch` 的 `replyEnded()` 照旧，Team 照常开始投递；第 2 步：`mori.prompt_error { message: §8.4, text: 这条消息, refs, running: entry.running, queued: [] }`。界面撤回它、文字回到输入框、显示错误卡（hooks-chat.md）；原因不进上下文 |
| 上下文 | 退出码 0 的纯文本 stdout；`hookSpecificOutput.additionalContext` | 照常发出，带上上下文（见下） |
| 照常发出 | 没有决定；非阻断错误（钩子行）；到时（30 秒，钩子行 `UserPromptSubmit hook error: Timed out after 30s`，R：取消并提示） | 照常 |

**上下文怎样交**（§0 第 10 条）：

- 记在这条消息上：`HeldItem.hookContext`（`teamHost.ts` 的 `HeldItem` 加可选字段，Team 原样传递）；第 1 步在 `before` 里写进 `preparing`；`dispatch`（`:1129-1137`）与 `dialogStart`（`:1697-1711`）建 `HeldPrompt` 时带上。
- Mori 调 pi 之前把它交给 `HookSession`，不调 `sendCustomMessage`（`nextTurn` 没开始运行时会跟着下一次不相干的运行走，§3 第 10 条）：
  - 会开始一次运行的（`runPrompt`，`:1254-1278`：空闲时发送、协作模式下对话开始回复）：`hooks.arm(context)`，只给这次 `session.prompt` 开始的运行；
  - 生成中交给 pi 的（`sendToPi`，`:1159-1172`：插话、排队、准备中暂存而之后放出的）：`hooks.carry(context)`，等下一次运行开始。
- `mori-hooks` 的 `before_agent_start`（§3 第 20 条）：有要交的时返回一条 `message`（`{ customType: 'mori.hook_message', content, display: false }`），pi 把它放在开始的那条消息之后进这次运行，写进会话、发给模型；
  `content` 按顺序是：还没交的 SessionStart 上下文（§6.9）、`carry` 的上下文与 §7.7 的消息、`arm` 的这条消息的上下文，各段照 §7.4；交过的清掉。界面不显示（custom 消息不进对话流，`transcript.ts:165-174`、`history.ts:230-253`）。
- `runPrompt` 的 `session.prompt` 结束（兑现或拒绝）时 `arm` 的还在（没有 `before_agent_start`：扩展命令、`input` 处理器接手、pi 报错）：这条消息的上下文丢掉、记日志（§10）；SessionStart 与 `carry` 的留到下一次运行。
- 生成中发出的：等下一次运行开始时才到；那一次可能是程序投递开始的（§0 第 10 条，要问第 6 条）。
- 分开时的协作模式：立项实例收到的投递没有上下文；你的消息到了对话（`dialogStart`）时才带上。

### 6.7 Stop

**什么时候**：用户会话（不含看不见的会话）的 `mori-hooks` 的 `agent_before_settle`，排在 `mori-memory`（收尾检查，`memoryExtension.ts:214`）与 `mori-approval`（你不在的提醒，`approval.ts:378-379`）之后（§0 第 14 条）：

1. `event.outcome !== 'completed'` → 不跑（出错时 R 发 StopFailure，不做；你按停止时 pi 根本不调，§3 第 6 条）。
2. `event.continue` 已经为真（收尾检查要检查、要补提醒）→ 不跑，返回 `undefined`；接着跑之后再到边界时才轮到。
3. 没有 Stop 钩子 → 返回 `undefined`。
4. 跑钩子（signal 由 `stopAll()` 中止，§5.4）。

**stdin**：公共字段，加 `stop_hook_active`（这次运行已经因为 Stop 钩子接着跑过时为真）、`last_assistant_message`（这次运行最后一段非空的助手文字，从 `ctx.sessionManager.getBranch()` 取，同 `run.lastText` 的取法）。
R 的 `background_tasks`、`session_crons` 不带（Mori 没有对应）。

**结果**：

| 结果 | 来自 | 效果 |
| --- | --- | --- |
| 接着跑（拦下） | 退出码 2（原因 = stderr，JSON 同时给了 `decision: "block"` 时用它的 `reason`，§5.6）；`decision: "block"` 加 `reason`（R：`reason` 必须有，没有按不合格的 JSON） | 返回 `{ entries: [...event.entries, { type: 'custom_message', customType: 'mori.hook_message', content: §7.6, display: false }], continue: true }`；钩子行 `Stop hook error: <原因>`（`error`，警示色；R：`decision: "block"` 与退出码 2 在转录里显示为钩子错误）；`stop_hook_active` 置真 |
| 接着跑（反馈） | `hookSpecificOutput.additionalContext`（R：作为不是错误的反馈接着跑） | 同上；钩子行 `Stop hook feedback: <内容>`（`feedback`，普通提示色；R：转录里标 `Stop hook feedback`，不出钩子错误的提示）。同一个边界里既有拦下又有反馈时两种行各出 |
| 结束 | 没有决定、非阻断错误、`continue: false`（钩子行 `Stopped by Stop hook: …`，并记下 §7.7 的消息） | 返回 `undefined`（或 `event.entries` 原样），运行照常结束 |

交给模型的文字（§7.6）两种都一样，是 Mori 自己的。

- **上限**（§0 第 15 条）：从上一次工具调用起连续接着跑 8 次之后，第 9 次拦下不再接着跑：返回 `undefined`、钩子行 `Stop hook blocked 8 times in a row, so the response ended.`（§8.2）。
  这个会话的 `tool_execution_start` 把计数清零（R：Claude 调了工具就重新数）；`agent_settled` 清零计数与 `stop_hook_active`（同 `clearAwayReminder`，`sessions.ts:227-231`）。
- **与收尾检查**：钩子的消息不是 `role: 'user'`，不移动收尾检查的起点（finish-check §5.2）；接着跑之后模型干了活、又到边界时，收尾检查按它的表判断
  （检查之后确认过的照“已确认”放行，finish-check §5.3 第 2 行），然后才轮到 Stop。一次运行里的请求顺序因此可能是 [回复, 检查, `finish`, Stop 反馈, 回复]。
- **与 TaskBoard**：同一次 pi 运行只有一份运行记录（finish-check §8.1），接着跑不另起；协作模式的对话同样。

### 6.8 SubagentStop

**什么时候**：subagent 工具开出的实例（§6.2）自己的 `mori-hooks` 的 `agent_before_settle`，步骤同 §6.7 的 1–4（实例只有你不在的提醒在它前面；已交接的实例本来不会是 subagent）。
TaskBoard 的其他实例不跑（§0 第 6 条，要问第 5 条）。matcher 比对 `agent_type`（角色名，基座 `mori`）。

**stdin**：公共字段（`session_id`、`transcript_path` 是用户会话的），加 `stop_hook_active`、`agent_id`、`agent_type`、`agent_transcript_path`（实例的会话文件，`<userData>\teams\<用户会话 id>\sessions\…`）、`last_assistant_message`。

**结果**：同 §6.7（R：SubagentStop 用 Stop 的写法），交给实例的原文 `SubagentStop hook feedback: …`（§7.6），消息进那个实例的会话：实例接着跑，subagent 的行保持运行中（[subagent-card.md](../v1/screens/subagent-card.md)），
结束时 `Response` 是接着跑之后的最后一段文字（`teamRuns.ts` 的 `askRunEnded` 照旧取 `run.lastText`）。钩子行同 §6.7 分两种：拦下为 `SubagentStop hook error: <原因>`，`additionalContext` 为 `SubagentStop hook feedback: <内容>`，
写进实例的会话文件（§6.2）。上限同 §6.7（`SubagentStop hook blocked 8 times in a row, so the response ended.`）。

### 6.9 SessionStart

**什么时候**：`createEntry` 给 `createAgentSession` 传 `sessionStartEvent: { type: 'session_start', reason: args.restored ? 'resume' : 'startup' }`（`sessions.ts:520-523`，§3 第 7 条；
pi 的 MCP 扩展不看 `reason`，`pi-coding-agent/dist/extensions/mcp/index.js:971-977`）。`mori-hooks` 只在用户会话（不含看不见的会话）的 `session_start` 里跑：

| Mori 的情形 | `source` |
| --- | --- |
| New session（`createSession`，`:674-680`） | `startup` |
| 打开已有会话、后台进程重启后重新打开（`openFromFile`，`:776-784`） | `resume` |
| Check again（`recheckAgents`，`:1606-1626`，有会话文件时 `restored`） | `resume`；还没写盘时 `startup` |
| 第一条消息建 worktree 时重建（`worktreeDeps.startUser`，`:1083-1088`） | `startup`（新的 pi 会话在 worktree 里，§0 第 11 条） |

- 处理器只开始跑钩子、立刻返回（R：会话照常可用，第一次回复等它们），`HookSession.started` 是它们跑完（含到时、被杀）的 Promise，UserPromptSubmit 先等它（§6.6 第 3 步）。
- **stdin**：公共字段（不带 `permission_mode`，§5.3），加 `source`。R 的 `model` 不带：R 说它可以没有；Mori 的模型层每次回复才选模型（候选与范围），建会话时还没有在用的模型。
  会话有名字时（你改过名，pi 的 `session.sessionName`）带 `session_title`（R：有自定义名时带）。`agent_type`（R：只在 `--agent` 启动时有，Mori 的用户会话没有对应）与 resume 的费用字段（Mori 没有缓存费用的估算）不带。
- **结果**：退出码 0 的纯文本 stdout 与 `hookSpecificOutput.additionalContext` → 上下文，记在 `HookSession`（几条按顺序），在下一次运行开始时由 `before_agent_start` 交（§6.6“上下文怎样交”，排在最前），真交出去之后才清掉；
  不在建会话时直接写进会话（§3 第 16 条：还没写盘，重建时会丢）。退出码 2 → stderr 给你看（钩子行 `SessionStart hook: …`），不给模型；`systemMessage` → 钩子行；非阻断错误 → 钩子行。
- 钩子行先存着，等这个会话的结果交给界面之后再发：界面在 `session.create` / `session.open` 返回之前不认识这个会话 id，那之前的事件丢掉（`app/src/renderer/src/state/actions.ts:518-524`；
  `ExtensionUi` 在打开过程中存着通知也是这个理由，`extensionUi.ts:41`、`:68-71`），而快的钩子可能在 `createEntry` 之后的 `attachTeam`、`takeNotice` 那几步里就结束了。
  `createSession`、`recheckAgents`、worktree 的重建在返回会话信息之前调 `entry.hooks.ready()`，它在下一轮事件循环（`setImmediate`，命令的结果已经发出）把存着的行发出去，之后照常实时发。
  `openFromFile` 返回的 `entries`（`manager.getBranch()`）已经含存着的行的 `mori.hook_line` 条目（`appendCustomEntry` 在内存里就进了分支），界面按条目画（`transcriptFromEntries`），
  所以它在取 `getBranch()` 之后调 `ready({ inBranch: true })`：存着的丢掉不发，之后的照常实时发；不然同一行画两次。
  `mori.hook_line` 条目照常写进会话，只在会话文件写盘后才留在文件里（§3 第 16 条）。

### 6.10 SessionEnd

**什么时候**：

| Mori 的情形 | `reason` | 位置 |
| --- | --- | --- |
| 归档、删除会话（界面先发 `session.close`，操作记录 “Close session (before archiving or deleting)”） | `other` | `closeSession`（`sessions.ts:983-990`）里 `closeEntry` 之前 |
| 退出 Mori（托盘或 File 菜单的 Exit，主进程发 `shutdown`） | `prompt_input_exit` | `shutdownSessions`（`:1926-1936`）一开始，与关 Team、释放会话同时开始（不让它们等钩子），每个用户会话同时跑；`shutdownSessions` 等这几样都结束 |

不跑：Check again 与 worktree 的重建、建立失败时的释放（`attachTeam`）、实例与看不见的会话、后台进程意外退出（来不及，作业对象杀掉还在跑的钩子，§5.4）。

- **stdin**：公共字段（不带 `permission_mode`，§5.3），加 `reason`。
- **时限**（R）：归档、删除时，这个会话全部 SessionEnd 钩子共用一个时限：1.5 秒；SessionEnd 钩子里写的最大 `timeout` 更大时提高到它，最多 60 秒；到时杀掉。
  时限提高了时，没写 `timeout` 的钩子仍在 1.5 秒时杀掉（R：提高预算时没有自己 `timeout` 的钩子仍按默认值）；写了的按它自己的 `timeout`，都不超过合计的时限。归档、删除的命令等它们结束才返回。
- **退出 Mori**（§0 第 26 条）：主进程只给后台进程 3 秒（`SHUTDOWN_TIMEOUT_MS`，`app/src/main/kernel-process.ts:14`，之后结束整个作业），这 3 秒里还要关 Team（等 board.json 写完）、释放会话（`session_shutdown`、结束快照）、释放模型层。
  所以退出时合计时限固定 1.5 秒、不按 `timeout` 提高，钩子与关 Team、释放同时进行，`shutdownSessions` 最多为钩子多等到 1.5 秒；到时杀掉。
- **结果**：JSON 丢掉（R），退出码 2 的 stderr 只记日志（会话已经在关，没有地方显示）。

### 6.11 Notification

**什么时候**：一张批准卡（用户会话的、或后台的）出现之后 6 秒还没结束时（R：`permission_prompt` 约 6 秒；在 canUseTool 的宿主里你打字也不推迟），在那张卡所属会话的 `HookSession` 里跑一次。
`request()` 发卡时开计时，`finish` 时清掉。只有这一种通知（§0“不做”）；钩子在 Mori 不在前台、关了系统通知时也跑（Mori 没有系统通知）。

- **stdin**：公共字段（不带 `permission_mode`，§5.3），加 `message`、`title: "Permission needed"`（R 的 `permission_prompt` 例子）、`notification_type: "permission_prompt"`。
  `message` 是 Mori 的临时默认值 `Mori needs your permission to use <tool_name>`（R 的例子是 `Claude needs your permission`，不带工具名；Mori 加上工具名，几张卡同时等时分得清）。
- **结果**：只做副作用（R）：退出码、stderr、JSON 都不起作用，只记日志；会话释放时中止。

### 6.12 PreCompact

**什么时候**：用户会话的 `mori-hooks` 的 `session_before_compact`（`mori-models` 的处理器在它前面，`modelSession.ts:1030-1034`，它改 `preparation`、返回 `undefined`）。

| pi 的 `reason` | Mori 的情形 | `trigger` |
| --- | --- | --- |
| `threshold` | 上下文过了阈值的自动压缩 | `auto` |
| `overflow` | 请求超出窗口之后的恢复压缩（`willRetry`） | `auto` |
| `manual` | 模型层换模型时的重建（`modelSession.ts:1229-1252`；Mori 没有 `/compact`） | `auto`（§0 第 13 条） |

- **stdin**：公共字段（不带 `permission_mode`，§5.3），加 `trigger`、`custom_instructions: null`（Mori 不传压缩说明）。按 pi 事件的 `signal` 杀进程。
- **结果**：退出码 2 或 `decision: "block"` → 返回 `{ cancel: true }`（R）：
  - `threshold`：跳过这次压缩（pi 发 `compaction_end { aborted: true }`、不报错），不出钩子行，只记日志（R：主动压缩被拦时跳过、对话照常）；
  - `overflow`（`willRetry`）：恢复失败、这次运行结束。R 是底下的溢出错误照常出现、请求失败；Mori 里 pi 已经把失败的回复从会话里去掉、取消后不带错误，界面在压缩开始时也去掉了溢出的错误卡（§3 第 19 条），
    所以 `mori-hooks` 拦下时出一行钩子行 `PreCompact hook blocked context overflow recovery: <原因>`（`error`，§8.2，§0 第 28 条；原因是 stderr 或 `reason`），写进会话，打开会话时照画；
  - `manual`（重建）：重建失败，按模型层已有的重建失败处理（`Compaction cancelled`，`modelSession.ts:1238-1243`），不另出钩子行。
  R 只在手动压缩时给你看 stderr，Mori 没有手动压缩；`systemMessage`、`continue` 丢掉（R）；非阻断错误照常出钩子行。

## 7. 模型看到的文字（英文原文）

`<…>` 是钩子给的内容（按 §5.8 截断，去掉首尾空白）；内容为空时写 `No reason given.`。几条钩子的内容按顺序以一个换行接起（§5.5）。

### 7.1 PreToolUse 拦下（工具结果，`isError: true`）

```text
Blocked by PreToolUse hook: <reason>
```

没有 Git Bash 时按拦下处理的（§6.3），`<reason>` 为（分号后面是 R 的原句，撇号照 ui-strings.md 用 ’；钩子到时的 `failed` 换成 `timed out`，同 R 的 `onFailure` 原文的写法）：

```text
The hook failed; blocking because Git Bash wasn’t found, so only exit code 0 or 2 counts as this hook’s verdict.
```

几条钩子都失败时每条一行（§5.5）；同一个边界里别的钩子正常拦下的，它们的原因在前、按处理器的顺序。

### 7.2 PermissionRequest 拒绝（工具结果，`isError: true`）

```text
Blocked by PermissionRequest hook: <message>
```

没有 Git Bash 时 `<message>` 同 §7.1 的那一句。§7.1、§7.2 的开头 `Blocked by PreToolUse hook: `、`Blocked by PermissionRequest hook: ` 是 `HOOK_BLOCK_PREFIXES`，进 `DENIAL_PREFIXES`，工具卡显示 `Denied · <原文>`。

### 7.3 PreToolUse 的上下文（接在这次调用的结果后面）

```text
PreToolUse hook additional context: <additionalContext>
```

执行了的调用：一个新的文字块，接在 `content` 最后；被 PreToolUse 钩子自己拦下的：接在 §7.1 的原文后面，中间一个空行；被别的拒绝的不接（§6.3）。

### 7.4 UserPromptSubmit、SessionStart 的上下文（`mori.hook_message`，`display: false`）

```text
UserPromptSubmit hook additional context: <上下文>
```

```text
SessionStart hook additional context: <上下文>
```

一次运行开始时最多一条消息（`before_agent_start` 的 `message`，§6.6）：里面按 SessionStart、之前留下的（`carry`，含 §7.7）、这条消息的顺序，每条钩子的上下文各占一段、以一个空行分开（每段都带这个开头）。

### 7.5 PostToolUse（接在结果后面，各一个文字块）

```text
PostToolUse hook feedback: <stderr 或 reason>
```

```text
PostToolUse hook additional context: <additionalContext>
```

### 7.6 Stop、SubagentStop（`mori.hook_message`，`display: false`，一个边界一条）

```text
Stop hook feedback: <原因或 additionalContext>
```

```text
SubagentStop hook feedback: <原因或 additionalContext>
```

几条钩子的各占一段、以一个空行分开（每段都带这个开头）。拦下（退出码 2、`decision: "block"`）与 `additionalContext` 交给模型的写法相同；只有给你看的钩子行分开（§6.7）。

### 7.7 钩子让运行停下的原因（`mori.hook_message`，`display: false`，下一次运行开始时交）

```text
Stopped by <Event> hook: <stopReason>
```

用户会话里 `continue: false` 带了 `stopReason` 时（PreToolUse、PermissionRequest、PostToolUse、Stop，§5.7）记下，随下一次运行开始的那条消息交（同 §7.4 的 `carry`）；没有 `stopReason` 时不记。

## 8. 界面看到的文字与进程桥

### 8.1 命令

| 命令 | 结果 |
| --- | --- |
| `hooks.get { sessionId? }` | `HooksInfo`（下面）。不带会话时只有用户级；带会话时按那个会话的工作路径与信任（`toolsTrust` 的规则，`resources.ts:84-93`）：受信任才读项目一份。每次新读（`createSettingsManager`，`app/src/kernel/pi.ts:61-67`），不用会话的快照 |
| `hooks.setDisabled { sessionId?, disabled }` | `{ error: null }`。受信任的项目设置写了 `disableAllHooks` 时报错（开关本来就只读）；否则在 pi 的文件锁里（`FileSettingsStorage.withLock('global', …)`，同 `writeDefaultTool`，`defaultTools.ts:211-215`）读改写 `<agentDir>\settings.json`：`disabled` 为真写 `"disableAllHooks": true`，为假去掉这个键；别的键与顺序不变，两个空格缩进；文件不在时按 `{}` 改（同 `rewrittenSettings`），所以打开开关会新建只有 `{ "disableAllHooks": true }` 的文件，关掉时写出 `{}`；文件不是 JSON 对象时报错（带文件路径）、不写 |

`HooksInfo`（`shared/hooks.ts`）：

| 字段 | 内容 |
| --- | --- |
| `userFile` | `<agentDir>\settings.json`；`userExists` 文件在不在 |
| `projectFile` | 受信任时 `<cwd>\.pi\settings.json`，否则 `null`；`projectExists` |
| `projectTrust` | 同 `ToolsInfo.projectTrust`（没有会话时 `null`；`toolsTrust`：打开时为 `none` 的会话照新会话的判断重新算，其余照打开时的判断）：决定列不列项目一份（`projectFile`），为 `untrusted`、`unasked` 时新会话一个钩子都不跑（§4.2）；不表示这个会话正在跑哪些钩子：会话按打开时的判断与快照跑（§4.6），打开时为 `none`、之后出现 `.pi/settings.json` 的会话这里是 `unasked`，它的用户级钩子仍照跑。界面照 customize-hooks.md“不信任”一行说明 |
| `hooks` | 每条处理器一行 `{ event, matcher, command, scope: 'user' \| 'project', file, path }`（`matcher` 为设置里写的原文，没写为 `null`；`path` 同 §4.5），按 `HOOK_EVENTS` 的顺序，同一事件里用户级在前、各按文件顺序；有问题的不在这里 |
| `problems` | `{ file, path, message }[]`（§4.5） |
| `readErrors` | `{ file, message }[]`（设置文件不是 JSON） |
| `disabled` | `{ value, setIn: 'user' \| 'project' \| null, readOnly }`：`value` 为 §4.4 生效的值；`readOnly` 在受信任的项目写了它、或用户级文件读不出时为真 |

### 8.2 钩子行：`mori.hook_line`

钩子要给你看的，后台进程发事件 `mori.hook_line { line }`（这个会话的信封上；实例会话的事件本来丢掉，只写文件），同时用 `sessionManager.appendCustomEntry('mori.hook_line', line)` 写进这个会话的文件（不进模型的上下文），
打开会话时 `history.ts` 按条目画出同样的一行（同 `mori.model_switch`）。`line` = `{ event, kind, text, toolCallId }`（`toolCallId` 只有工具事件有）。原文（英文；`<Event>` 是事件名）：

| `kind` | 什么时候 | `text` |
| --- | --- | --- |
| `error` | 非阻断错误（§5.6），每条钩子一行 | `<Event> hook error: Failed with non-blocking status code: <stderr 的第一行>`（stderr 为空时 `<Event> hook error: Failed with non-blocking status code: exit code <n>`）/ `<Event> hook error: Invalid JSON output: <原因>` / `<Event> hook error: Timed out after <n>s` / `<Event> hook error: Couldn’t start: <原文>` |
| `error` | Stop、SubagentStop 被拦下而接着跑（退出码 2、`decision: "block"`，§6.7、§6.8），每个边界一行 | `Stop hook error: <原因>`（SubagentStop 的写进实例：`SubagentStop hook error: <原因>`） |
| `error` | PreCompact 拦下溢出恢复（§6.12） | `PreCompact hook blocked context overflow recovery: <原因>` |
| `message` | `systemMessage`；SessionStart 退出码 2 的 stderr | `<Event> hook: <内容>` |
| `feedback` | Stop、SubagentStop 的 `additionalContext`；PostToolUse 的反馈 | `Stop hook feedback: <内容>` / `PostToolUse hook feedback: <内容>`（SubagentStop 的写进实例：`SubagentStop hook feedback: <内容>`） |
| `stopped` | `continue: false` | `Stopped by <Event> hook: <stopReason>`（没有时 `Stopped by <Event> hook`）；PermissionRequest 的 `interrupt: true` 不出这一行（§6.4） |
| `limit` | Stop、SubagentStop 到了上限 | `Stop hook blocked 8 times in a row, so the response ended.`（SubagentStop 的写进实例：`SubagentStop hook blocked 8 times in a row, so the response ended.`） |

照 Claude 的（R、G）：`error` 的开头 `<Event> hook error`、`Failed with non-blocking status code:`；Stop、SubagentStop 的拦下显示为钩子错误、`additionalContext` 显示为 `Stop hook feedback`（R：Stop decision control）。
其余是 Mori 写的（§0 第 20 条）。界面用词照 ui-strings.md：助手的输出叫 response。钩子改了参数时不出行（§0 第 19 条）。

### 8.3 批准卡与工具卡

- `ApprovalEndBy` 加 `'hook'`（PermissionRequest 结束的卡）；界面的 `allowedBy` 加 `'hook'`，工具卡的标签 `Allowed by PermissionRequest hook`（G）。
- `ApprovalRequestInfo` 与 `TeamApprovalRequest` 加 `hookAsk: string | null`：这张卡是 PreToolUse 钩子的 `ask` 出的时为批准卡上那一行的整句（后台进程拼好，同钩子行的 `text`），否则 `null`（§0 第 29 条，临时默认值）：
  `PreToolUse hook (User settings): <原因>`；给 `ask` 的钩子来自项目时 `(Project settings)`，两种都有时 `(User and Project settings)`；原因是 `permissionDecisionReason`（几条按顺序换行接起，按 §5.8 截断），
  一条都没给时整句是 `PreToolUse hook (User settings)`（不带冒号）。R：`ask` 的原因显示在批准提示里，提示带一个标出钩子来源的标签（设置文件的是 `[settings]`）。
  用户会话自己的卡与实例的后台卡都显示这一行（`approval-hook-reason`，hooks-chat.md）。
- 工具卡的拒绝：§7.1、§7.2 按 `DENIAL_PREFIXES` 认出，`Denied · Blocked by PreToolUse hook: …`（理由长时截断加 `…`，悬停看全文，同 v0）。

### 8.4 UserPromptSubmit 拦下的原文（`mori.prompt_error` 的 `message`）

```text
Blocked by UserPromptSubmit hook: <reason>
```

### 8.5 操作记录（F8 的 Recent activity）

`hooks.setDisabled`：`Disable all hooks`（`disabled` 为真）/ `Enable all hooks`（为假）；`hooks.get` 是只读的查询，不记（同 `roles.get`，`app/src/renderer/src/state/actionLog.ts:117`）。
钩子的运行不是你做的操作，不进操作记录；F8 报告里也没有后台进程的日志（§10）。

## 9. 界面

- Customize › Hooks：状态表 [customize-hooks.md](../v1/screens/customize-hooks.md)（分节的位置、列表、有问题的条目、读不出的文件、不信任、`Disable all hooks` 开关与写入（含用户级文件还不在时）、项目设置改了它、打开失败、没有会话、后台进程退出）。
- 对话流与别处的显示：状态表 [hooks-chat.md](../v1/screens/hooks-chat.md)（工具卡的拒绝与标签、批准卡与后台批准卡上的钩子一行、钩子行、Stop 接着跑的两种行、UserPromptSubmit 拦下（含 worktree 的第一条消息）、等待中、PreCompact 拦下溢出恢复、实例里的显示、F8）。

## 10. 日志

后台进程的标准输出（`[kernel] hooks: …`，英文）。不写命令原文、stdin、stdout、stderr 的内容（可能有密钥）：用 §5.9 的标识、长度与退出码。

| 情形 | 级别 | 原文 |
| --- | --- | --- |
| 建会话时的设置问题 | `console.error` | `[kernel] hooks: <file>: <path>: <message>` |
| 设置文件读不出 | `console.error` | `[kernel] hooks: <file> can’t be read: <原文>` |
| 跑完一条 | `console.log` | `[kernel] hooks: <sessionId> <id> exited <code> in <ms> ms (stdout <n> chars, stderr <m> chars)` |
| 起不来、到时、不合格的 JSON、非阻断的退出码 | `console.error` | `[kernel] hooks: <sessionId> <id> failed: <couldn’t start: …> / <timed out after <n>s> / <invalid JSON output: …> / <non-blocking status code <n>>` |
| 不认得的键 | `console.log` | `[kernel] hooks: <sessionId> <id>: Hook JSON output had unrecognized keys: <键>`（R 的原文） |
| 用不上的 `updatedInput`（§5.5） | `console.log` | `[kernel] hooks: <sessionId> <id>: updatedInput ignored; <id> was first` |
| 换过的参数被记忆目录写保护拒绝（§6.3） | `console.log` | `[kernel] hooks: <sessionId> <id>: updatedInput writes to the memory folder; blocked` |
| 给了 `defer` 的钩子（§5.5） | `console.error` | `[kernel] hooks: <sessionId> <id>: permissionDecision defer is ignored outside -p; the hook result is dropped` |
| PreToolUse 的上下文碰上别的拒绝（§6.3） | `console.log` | `[kernel] hooks: <sessionId> <toolCallId>: additionalContext dropped (<n> chars); the call was denied by <path gate / user / stop / memory guard>` |
| 消息的上下文没交出去（`session.prompt` 没开始运行，§6.6） | `console.log` | `[kernel] hooks: <sessionId>: UserPromptSubmit context dropped (<n> chars); the prompt did not start a run` |
| 钩子不读 stdin 就退出（`EPIPE`、`EOF`、`ERR_STREAM_DESTROYED`，§5.1） | `console.log` | `[kernel] hooks: <sessionId> <id>: exited before reading stdin (<code>)` |
| stdin 别的错误 | `console.error` | `[kernel] hooks: <sessionId> <id>: writing stdin failed: <原文>` |
| 拦下、放行、接着跑、取消压缩 | `console.log` | `[kernel] hooks: <sessionId> <Event> <结果> by <id>`，例如 `PreToolUse denied by user:PreToolUse[0].hooks[0]` |
| SessionEnd 退出码 2 | `console.log` | `[kernel] hooks: <sessionId> <id>: SessionEnd stderr (<m> chars) not shown` |
| 杀进程失败 | `console.error` | `[kernel] hooks: <id>: taskkill failed (<原因>); ending only the started process` |
| 实例里的 `continue: false` | `console.log` | `[kernel] hooks: <sessionId> <id>: continue false in an instance; blocking only` |
| cwd 不存在 | `console.error` | `[kernel] hooks: <cwd> doesn’t exist; running in <退路的目录>` |

## 11. 要改的现有文档

规格先单独合进 `app-v0`（不碰 `SPECS`，否则 `test:unit` 的 spec-ids 检查会失败）；`SPECS`、`package.json`、报告器与全部 HK 测试和实现同一次合进（AGENTS.md“验收表的新行和它的测试同一次合进”）。
§11.1 的检查记录、§11.2、§11.4–§11.7、§11.12 标“随规格”的行与 §11.3 的第 1–4 条随规格一起合；§11.3 的第 5–9 条（说的是那时才有的命令）、§11.8–§11.11、§11.12 标“随实现”的行与 §11.1 的测试文件随实现合。

### 11.1 要新建的文件

- 随规格：`docs/v1/hooks-checks.md`，检查记录（同收尾检查规格的先例：规格合进时就建，状态写“规格已写、未实现”），节照 `finish-check-checks.md`：状态；负责人的决定（2026-10-28）；写规格时定的（待负责人审）；
  要问负责人的（§0 的问题与回答）；照 Claude 核对的（R、G、S、SR、W 的版本与日期，逐条：事件、stdin 字段、退出码、JSON 输出、显示）；规格的评审与改动（这次评审的发现、采纳与不采纳的理由）；
  这几节随规格写好。下面几节建文件时留空，实现时填：开工前核对的 pi 行为（§3 逐条复核）；实现结果；
  状态表的用例（AGENTS.md“不留未完成项”第 4 条：表“屏 ｜ 行 ｜ 用例（套件与 --only 名、检查名）”，customize-hooks.md、hooks-chat.md 的每一行，HK-29、HK-37）；现有界面测试的改动（§13.4）；录 fixture；
  真实模型走查（HK-35）；跑过的测试与跳过的层（`--only` 写的 `hk-partial-*.json` 不算覆盖）；未验证项。
- 随实现：`app/tests/unit/hk-reporter.mjs`（照 `fs-reporter.mjs`，必须含字面量 `createReporter('hk-unit.json')`）、`app/tests/unit/hooks/*.test.mjs`、`app/tests/ui/hk-*.mjs`、`app/tests/fixtures/hooks/*.json`、`app/tests/fake-endpoint/hooks.mjs`（§13）。

### 11.2 `docs/app-v0.md`

1. §4 的表，在“收尾检查（2026-10-27 加）”一行之后加：

   ```text
   | 钩子（2026-10-28 加） | **Mori**（inline extension `mori-hooks` 与路径闸、后台进程的几处接线：读用户级与受信任项目 pi 设置里的 `hooks`（Claude Code 的写法），在十个事件上跑 command 钩子，[specs/hooks.md](specs/hooks.md)） | Customize › Hooks：只读列表、Open in default app、Disable all hooks；对话流里的钩子行、被钩子拦下的工具卡、Allowed by PermissionRequest hook |
   ```

2. §5.13，在 “**Plugin**” 一项之后、“**启停的写法**” 之前加：

   ```text
   - **Hooks**（2026-10-28 加，负责人 "make a hook system following claude's design"）：Plugins 之后、Instructions 之前；没有会话时也在（只列用户级）。按事件分组列出用户级 `<agentDir>\settings.json` 与受信任项目 `.pi\settings.json` 里的 `hooks`：matcher、命令、User / Project、Open in default app（打开定义它的 settings.json）；有问题的条目列在下面、不跑；`Disable all hooks` 开关写用户级的 `disableAllHooks`，项目写了时只读。对新会话生效。见 [v1/screens/customize-hooks.md](v1/screens/customize-hooks.md) 与 [specs/hooks.md](specs/hooks.md)。
   ```

3. §6 的标题行 `**后台进程（utilityProcess）只做九件事**（第 5 件 2026-10-20 加，第 6、7 件 2026-10-21 加，第 8 件 2026-10-22 加，第 9 件 2026-10-26 加）：`
   改为 `**后台进程（utilityProcess）只做十件事**（第 5 件 2026-10-20 加，第 6、7 件 2026-10-21 加，第 8 件 2026-10-22 加，第 9 件 2026-10-26 加，第 10 件 2026-10-28 加）：`，第 9 项之后加：

   ```text
   10. 钩子（2026-10-28 加，[specs/hooks.md](specs/hooks.md)，负责人 "make a hook system following claude's design"）：照 Claude Code 的设计，从用户级与受信任项目的 pi 设置读 `hooks` 与 `disableAllHooks`（建会话时读一次），
      在 PreToolUse、PostToolUse、PermissionRequest、UserPromptSubmit、Stop、SubagentStop、SessionStart、SessionEnd、Notification、PreCompact 上起 command 钩子（stdin 一份 JSON、退出码 2 拦下、JSON 输出），
      把结果交给模型（不显示的 `mori.hook_message`、工具结果后面的文字）与界面（`mori.hook_line`）；Customize 的 `hooks.get` 与 `hooks.setDisabled`。inline extension `mori-hooks` 做 pi 事件上的几个；
      配合的改动分属第 3 件（路径闸里的 PreToolUse、PermissionRequest 与 Notification，`ApprovalEndBy` 的 `hook`）、第 6 件（PreCompact 拦下模型层的重建时照它已有的失败处理）
      与第 7 件（subagent 实例的标记与钩子快照，`HeldItem.hookContext`）。
   ```

4. §8 第 4 条（约第 528 行）`每加一段非界面代码，都要能指向第 6 节"后台进程只做九件事"或第 4 节表中标 Mori 的行。` 改为 `…第 6 节"后台进程只做十件事"…`。

### 11.3 `AGENTS.md`

1. “仓库结构” `src/kernel/` 一项：`…你不在、提问工具、worktree 与 Initialize git）。` 改为 `…你不在、提问工具、worktree 与 Initialize git）、钩子（读 pi 设置里的 hooks、按事件跑命令）。`
2. “仓库结构” `docs/specs/` 一项末尾 `…收尾检查（[docs/specs/finish-check.md](docs/specs/finish-check.md)，检查记录 `docs/v1/finish-check-checks.md`，临时默认值在 `docs/v1/defaults.md`）。` 之后加
   `钩子（[docs/specs/hooks.md](docs/specs/hooks.md)，检查记录 `docs/v1/hooks-checks.md`，临时默认值在 `docs/v1/defaults.md`）。`
3. 工作约定第 4 条：`后台进程只做九件事` 改为 `后台进程只做十件事`；`第 9 件是工作区，按 `docs/specs/file-system.md`）` 改为 `第 9 件是工作区，按 `docs/specs/file-system.md`；第 10 件是钩子，按 `docs/specs/hooks.md`）`。
4. 工作约定第 6 条：`模型层、一键拉取模型、平行 Agent、记忆、收尾检查与文件系统的登记在` 改为 `模型层、一键拉取模型、平行 Agent、记忆、收尾检查、文件系统与钩子的登记在`。
5. “测试分层”第 1 条：`三段回放与八组单元测试（…、`test:fc-unit`、`test:fs-unit`）` 改为 `三段回放与九组单元测试（…、`test:fc-unit`、`test:fs-unit`、`test:hk-unit`）`；`八组单元，约 2 分钟` 改为 `九组单元，约 2 分钟`。
6. “测试分层”第 2 条的组名加 `hooks`：`…、`finish`、`filesystem`、`hooks`，组里的套件取自 package.json 的各组总命令`。
7. “测试分层”第 3 条：真实层加 `hk-real`；`汇总 `v1-models-existing.mjs --id FS-115`（同时写 MP-37、TB-46、MEM-35、MD-15、FC-28）` 改为 `汇总 `v1-models-existing.mjs --id HK-36`（同时写 MP-37、TB-46、MEM-35、MD-15、FC-28、FS-115）`；`八份规格的 `spec-coverage --fresh`` 改为 `九份规格的 `spec-coverage --fresh``。
8. “不留未完成项”第 3 条：`TaskBoard、记忆、一键拉取模型、subagent、Customize › Agents、收尾检查与文件系统的套件 `--only` 写 `*-partial-*.json`` 改为 `…、收尾检查、文件系统与钩子的套件 `--only` 写 `*-partial-*.json``。
9. “常用命令”：`test:min`、`test:quick` 两行的 `八组单元测试` 改为 `九组单元测试`，`test:min` 的列表加 `test:hk-unit`；`test:publish` 一行 `八份 `spec-coverage --fresh`` 改为 `九份`；`test:filesystem` 一行之后加：

   ```text
   | `npm run test:hk-unit` | 钩子的单元测试（`node --test`，跳过的、标为待办的测试算失败） |
   | `npm run test:hooks` | 钩子的单元、App、回放测试和现有套件（`--id HK-36`），最后检查规格 §13.2 的每一条都有通过的结果（真实层 HK-35 由你跑 `hk-real.mjs`） |
   ```

   表下一段的列表 `…、`test:finish`、`test:filesystem` 和 `test:m6-app`` 改为 `…、`test:finish`、`test:filesystem`、`test:hooks` 和 `test:m6-app``。

### 11.4 `docs/v0/screens/tools.md`

1. “外框”的“顶部”一行：没有会话时的原文后面加 `（2026-10-28 改："No open session. Only user-level skills, plugins, hooks, and instructions are listed."，加了 Hooks）`。
2. “外框”的“分节”一行末尾加 `（2026-10-28：Plugins 之后加 "Hooks"，没有会话时也在（只列用户级），Instructions 仍是最后一节；状态表见 [../../v1/screens/customize-hooks.md](../../v1/screens/customize-hooks.md)）`。
3. “跟随哪个会话”一段里两处没有会话时的原文同第 1 条改。
4. “照 Claude 桌面版”表加一行：`| 钩子（2026-10-28） | Claude 桌面版的 Customize 没有钩子；照 Claude Code 的 `/hooks`：按事件分组的只读列表、每条显示来源，要改就编辑 settings.json；Mori 另有 Disable all hooks 开关（Claude 的 `disableAllHooks`） |`
5. “界面测试用的标识”的“工具页”一行：`2026-10-26 加最后一节 `agents`（Instructions）` 后面加 `；2026-10-28 在 `plugins` 之后加 `hooks`，这一节的标识见 customize-hooks.md`。

`docs/v1/screens/customize-agents-md.md` 同样改：“位置”的“Customize 的分节”一行，有会话时的列表在 `Plugins` 后加 `Hooks`（[customize-hooks.md](../v1/screens/customize-hooks.md)），没有会话时为 `Skills`、`Plugins`、`Hooks`、`Instructions`；“顶部”一行与“本表定下的界面细节”里没有会话时的原文同 tools.md 第 1 条。

### 11.5 `docs/v0/ui-strings.md`

1. 术语表，“内置工具”一行之后加：

   ```text
   | 钩子 | Hooks（Customize 的分节）/ Disable all hooks / 事件名照原文（PreToolUse、PostToolUse、PermissionRequest、UserPromptSubmit、Stop、SubagentStop、SessionStart、SessionEnd、Notification、PreCompact）/ Matcher / User / Project | — （Claude Code：hooks、`/hooks`、`disableAllHooks`、"Stop hook feedback"、"<event> hook error"、"Allowed by PermissionRequest hook"、"blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict."） | 2026-10-28 加（docs/specs/hooks.md）。事件名、字段名不翻译、不改大小写；对话流里的钩子行以事件名开头 |
   ```

2. “Customize 页（工具页）和 "/" 列表”：“分节”一行加 `/ Hooks（Plugins 之后、Instructions 之前，没有会话时也在，2026-10-28，customize-hooks.md）`；“没有会话时的顶部”一行加 `（2026-10-28 改为 No open session. Only user-level skills, plugins, hooks, and instructions are listed.）`；表末加一行：

   ```text
   | Hooks（2026-10-28，customize-hooks.md） | 标题 Hooks；第一行 Shell commands that run at set points in a session, such as before a tool runs or when a response ends. Mori reads them from the hooks key in settings.json, in Claude Code’s format. / Matcher: <matcher> / Matcher: All / User / Project / Open in default app / No hooks yet. Add them to the hooks key in <path>, in Claude Code’s format.（有受信任的项目时 …in <path> or in this project’s .pi/settings.json, in Claude Code’s format.）/ These hooks don’t run: / Couldn’t read hook settings: <path>: <原文>（同 Couldn’t read model settings: <路径>: <原文> 的写法）/ Fix settings.json first: it can’t be read.（同 tools.md 的 Fix mcp.json first: it can’t be read, …）/ Hooks don’t run in this workspace because it isn’t trusted. / Loading this project’s hooks… / Disable all hooks / New sessions don’t run any hooks while this is on. / Turned on（off）in this project’s .pi/settings.json. To change it, edit that file. / Couldn’t save: <原文> / Couldn’t load hooks: <原文> / Couldn’t open this file with the default app: <原文>（v0 原有）/ 问题的原文见 docs/specs/hooks.md §4.5 |
   ```

3. “工具卡、批准卡、权限、扩展询问、信任”加一行：

   ```text
   | 钩子（2026-10-28，hooks-chat.md） | 工具卡 Denied · Blocked by PreToolUse hook: <原因> / Denied · Blocked by PermissionRequest hook: <原因>（没有 Git Bash 时原因为 The hook failed; blocking because Git Bash wasn’t found, so only exit code 0 or 2 counts as this hook’s verdict.，到时为 The hook timed out; …）/ 标签 Allowed by PermissionRequest hook / 批准卡（与后台批准卡）一行 PreToolUse hook (User settings): <原因> / PreToolUse hook (Project settings): <原因> / PreToolUse hook (User and Project settings): <原因>（没有原因时不带冒号与原因） |
   ```

4. “会话（对话、输入框、阶段行）”加一行：

   ```text
   | 钩子行（2026-10-28，hooks-chat.md） | <Event> hook error: Failed with non-blocking status code: <第一行>（stderr 为空时 … status code: exit code <n>）/ <Event> hook error: Invalid JSON output: <原因> / <Event> hook error: Timed out after <n>s / <Event> hook error: Couldn’t start: <原文> / Stop hook error: <原因> / SubagentStop hook error: <原因> / PreCompact hook blocked context overflow recovery: <原因> / <Event> hook: <内容> / Stop hook feedback: <内容> / SubagentStop hook feedback: <内容> / PostToolUse hook feedback: <内容> / Stopped by <Event> hook: <原因> / Stop hook blocked 8 times in a row, so the response ended. / SubagentStop hook blocked 8 times in a row, so the response ended. / 错误卡 Blocked by UserPromptSubmit hook: <原因> |
   ```

5. “操作记录”的“Customize 页”一行末尾加 ` / Disable all hooks / Enable all hooks（2026-10-28，Customize › Hooks 的开关）`。

### 11.6 `docs/v1/screens/README.md`

1. 标题 `（v1：模型层、平行 Agent 与 TaskBoard、提示词分层与记忆、文件系统）` 改为 `（v1：模型层、平行 Agent 与 TaskBoard、提示词分层与记忆、文件系统、钩子）`。
2. “来源”一段（`fs-*.md` 另有…那一段之后）加：

   ```text
   [customize-hooks.md](customize-hooks.md) 与 [hooks-chat.md](hooks-chat.md) 按 [钩子构建规格](../../specs/hooks.md)（在这两个文件里称“规格”，本文件称“钩子规格”）另有这些来源：`hooks.get`、`hooks.setDisabled` 的结果（`HooksInfo`，钩子规格 §8.1）、
   事件 `mori.hook_line` 与会话文件里的 `mori.hook_line` 条目（§8.2）、`mori.approval_end` / `mori.team_approval_end` 的 `by: 'hook'` 与批准请求的 `hookAsk`（§8.3）、以 `Blocked by PreToolUse hook: `、`Blocked by PermissionRequest hook: ` 开头的工具结果（§7.1、§7.2，在 `DENIAL_PREFIXES` 里）、
   `mori.prompt_error` 的 `Blocked by UserPromptSubmit hook: …`（§8.4）。`mori.hook_message`（给模型的）不显示。
   ```

3. 文件表，`customize-agents-md.md` 一行之后加：

   ```text
   | [customize-hooks.md](customize-hooks.md) | Customize › Hooks（2026-10-28，钩子规格 §9）：分节的位置、按事件分组的只读列表、Open in default app 与打开失败、有问题的条目、读不出的设置文件、不信任、Disable all hooks 开关（写入、用户级文件还不在、失败、项目设置改了它）、没有会话、后台进程退出 | 补充 [v0 tools.md](../../v0/screens/tools.md) 的外框 |
   | [hooks-chat.md](hooks-chat.md) | 钩子在对话流与别处的显示（钩子规格 §6–§8）：被拦下的工具卡、Allowed by PermissionRequest hook、批准卡与后台批准卡上的钩子一行、钩子行（错误、Stop 的拦下与反馈、systemMessage、停下、上限、PreCompact 拦下溢出恢复）、UserPromptSubmit 拦下与等待（含 worktree 的第一条消息）、SessionStart、实例里的显示、F8 | 补充 [v0 tool-cards.md](../../v0/screens/tool-cards.md)、[v0 chat.md](../../v0/screens/chat.md) 与 [fs-permissions.md](fs-permissions.md) |
   ```

4. “界面测试用的标识（汇总）”加两行：

   ```text
   | `tools-nav` 的 `button[data-section="hooks"]`、`hooks-section`、`hooks-intro`、`hooks-event`（`data-event`）、`hook-row`（`data-event`、`data-scope`）、`.hook-matcher`、`.hook-command`、`.hook-scope`、`hook-open`、`hook-open-error`、`hooks-empty`、`hooks-problems`（`.hook-problem`）、`hooks-read-error`、`hooks-disable`、`hooks-project-loading` | Customize 的 Hooks 一节 | customize-hooks.md |
   | `hook-line`（`data-event`、`data-kind`）、`approval-hook-reason`；`tool-badge` 的 `Allowed by PermissionRequest hook` | 钩子行、批准卡的钩子一行、工具卡标签 | hooks-chat.md |
   ```

5. “界面文字”一节，`fs-*.md` 一项之后加：

   ```text
   - `customize-hooks.md`、`hooks-chat.md` 的新界面文字按钩子规格 §4.5、§7、§8 原文（`Hooks`、`Disable all hooks`、`Matcher: All`、`<Event> hook error: …`、`Stop hook feedback: …`、`Blocked by PreToolUse hook: …`、
     `Allowed by PermissionRequest hook`、`PreToolUse hook (User settings): …` 等）；事件名原样显示、不翻译。钩子规格标“临时”的文字登记在钩子规格 §12 与 [v1/defaults.md](../defaults.md)“钩子”一节，
     规格没给、各表定的写作“（临时，走查时可以改）”。Customize 多了一节 `Hooks`（`Plugins` 之后、`Instructions` 之前）。
   ```

6. “需要规格回答”一节末尾加：

   ```text
   15. （无）`customize-hooks.md`、`hooks-chat.md` 没有待规格回答的：起草时的未定项已由钩子规格 §0“写规格时定的”与 §12 的临时默认值定下，要负责人回答的列在钩子规格 §0“要问负责人的”。
   ```

### 11.7 `docs/v1/defaults.md`

开头第 5 行 `后面的平行 Agent 与 TaskBoard、提示词分层与记忆、一键拉取模型、文件系统、收尾检查各成一节` 改为 `…、文件系统、收尾检查、钩子各成一节`；文件末尾加 §12 的一节。
“第一层的分线”一行（约第 580 行，`app/tests/ui/quick.mjs` 的 `FIRST`、`LANES`）随实现改：`单元 md+tb+unit+fc` 改为 `单元 md+tb+unit+fc+hk`，`八组单元` 改为 `九组单元`（§11.10 把 `test:hk-unit` 加进第二条单元线）。

### 11.8 `app/tests/spec-coverage.mjs`

`SPECS` 末尾（`filesystem` 之后，键序决定 `specNames()`）加：

```js
  hooks: {
    path: 'docs/specs/hooks.md',
    section: '13.2',
    row: /^\|\s*HK-\d+\s*\|/,
    prefix: 'HK',
    strayLabel: 'an HK id',
    files: { unit: 'hk-unit.json', app: 'hk-app', replay: 'hk-replay', real: 'hk-real', partial: 'hk-partial-' },
  },
```

文件开头的注释：`--spec` 列表加 `//   hooks      docs/specs/hooks.md §13.2（§13.1、§13.3），编号 HK-n`；层的说明加
`//   hooks：单元 hk-unit.json（hk-reporter.mjs，严格模式），App hk-app*.json（含 -existing），回放 hk-replay*.json（含 -existing），真实 hk-real.json。`；
`*-partial-*.json` 一句加“钩子的 hk-partial-*.json”；`--packaged` 一句加 `hk-app*-packaged.json、hk-real-packaged.json`。逻辑不改。

### 11.9 `app/package.json`

```json
"test:hk-unit": "node --test --test-reporter=./tests/unit/hk-reporter.mjs \"tests/unit/hooks/*.test.mjs\"",
"test:hooks": "npm run test:hk-unit && electron-vite build && node tests/ui/hk-app-tools.mjs && node tests/ui/hk-app-session.mjs && node tests/ui/hk-app-customize.mjs && node tests/ui/hk-replay.mjs && node tests/ui/v1-models-existing.mjs --id HK-36 && node tests/spec-coverage.mjs --spec hooks --allow-missing-real",
```

`test:min` 末尾加 ` && npm run test:hk-unit`；`test:publish` 的 `v1-models-existing.mjs --id FS-115` 改为 `--id HK-36`，`--spec filesystem --fresh` 之后加 ` && node tests/spec-coverage.mjs --spec hooks --fresh`。

### 11.10 其他测试接线（随实现合）

| 文件 | 改什么 |
| --- | --- |
| `app/tests/unit/taskboard/spec-coverage.test.mjs` | 规格名的解构与原文（`…, finish, filesystem or hooks`）加 `hooks`；“不归其他规格”的几个循环加 `hooks`；照 FC 那一组加三条 `TB-46 …`：读 hooks §13.2 的每一行与层、`hk-` 结果文件归到层（partial 不算、别的规格不拿）、`hk-reporter.mjs` 严格模式写 `hk-unit.json` |
| `app/tests/ui/v1-models-existing.mjs` | 加 `FS_APP_SUITES`（`fs-app-changes`、`-rewind`、`-gate`、`-work`、`-team`、`-away`、`-question`、`-worktree`）、`FS_UNIT_CHECK`（`test:fs-unit`）、`FS_COVERAGE_CHECK`（`--spec filesystem --allow-missing-real`，`failLine: /^ {2}FS-\d+ /`）；`SUITE_LISTS.hooks = { app: [...filesystem.app, ...FS_APP_SUITES], replay: [...filesystem.replay, FS_UNIT_CHECK, suite('fs-replay', false)] }`；预设 `'HK-36'`：`hk-app-existing.json`、`hk-replay-existing.json`、`hk-partial-existing-`、`hk-existing`、`suites: 'hooks'`、`withUnit: true`、`tail: [...FINISH_TAIL, FC_COVERAGE_CHECK, FS_COVERAGE_CHECK]`、`also: [...FINISH_ALSO, { id: 'FC-28', before: FC_COVERAGE_CHECK }, { id: 'FS-115', before: FS_COVERAGE_CHECK }]`；开头的用法注释 |
| `app/tests/ui/run-plan.mjs` | `FAMILY_SCRIPTS` 加 `hooks: ['test:hooks']`；`run.mjs` 开头的组名列表加 `hooks` |
| `app/tests/ui/quick.mjs` | 第二条单元线（`test:md-unit`、`test:tb-unit`、`test:unit`、`test:fc-unit`）加 `test:hk-unit`；“八组单元测试”的注释改“九组” |
| `app/tests/ui/harness/main.jsx` | 加 `...import.meta.glob('../../fixtures/hooks/*.json', { eager: true, import: 'default' }),`（回放页面的哈希因此变，现有回放的戳失效一次） |

### 11.11 `docs/v1/test-strategy.md`（随实现合）

1. §1 “现有功能不退步”一项（约第 20–21 行）：`七个汇总（MP-37、TB-46、MEM-35、MD-15、AG-11、FC-28、FS-115）` 改为 `八个汇总（…、FS-115、HK-36）`，同一句后面加 `HK-36 建在 FS-115 之上`。
2. §2.1 三层的表（约第 34–36 行）：第 1 层 `两条单元测试线（八组）` 改为 `（九组）`；第 3 层 `汇总 FS-115、AG-11（只收集）` 改为 `汇总 HK-36、AG-11（只收集）`，`八份 `spec-coverage --fresh`` 改为 `九份`。
3. 表下一段（约第 38 行）组名列表 `…、`finish`、`filesystem`` 改为 `…、`finish`、`filesystem`、`hooks``。

### 11.12 其他构建规格与状态表（加注，2026-10-28 注：钩子，见 hooks.md 的对应节）

| 文件 | 随 | 改什么 |
| --- | --- | --- |
| `docs/specs/parallel-agents-taskboard.md` | 规格 | §8.2 的 `extensionFactories`（约第 639 行）与 §14.3 的处理器顺序：`mori-approval` 之后、`mori-snapshots` 之前有 `mori-hooks`（`tool_result` 排在 `mori-team` 之后，PostToolUse 看到编过号的结果；`agent_before_settle` 在最后；`before_agent_start` 交钩子的上下文；hooks.md §2、§6.5–§6.7）；`TeamApprovalRequest` 加 `hookAsk`、`HeldItem` 加 `hookContext`、`InstanceSpec` 加 `subagent` 与 `hooks`（实例用用户会话的钩子快照，hooks.md §4.6、§8.3） |
| `docs/specs/file-system.md` | 规格 | §12：`ApprovalEndBy` 的取值加 `'hook'`（hooks.md §6.4）；`DENIAL_PREFIXES` 的表加两行 `Blocked by PreToolUse hook: `、`Blocked by PermissionRequest hook: `（`HOOK_BLOCK_PREFIXES`，hooks.md §7.1、§7.2），工具卡 `Denied · <原文>` |
| `docs/specs/file-system-permissions.md` | 规格 | §6.1 判断顺序：PreToolUse 钩子在 `decide` 之前（`deny` 在任何模式下都拦；`ask` 在 Full access、Allow for this session、按目录放行下也出卡；`allow` 只省掉第 4 步的卡），换过的参数先经记忆目录写保护再判断（hooks.md §6.3）；§6.13 的批准请求加 `hookAsk`；`ApprovalEndBy` 加 `hook`（hooks.md §6.4）（`DENIAL_PREFIXES` 的两行、`ApprovalEndBy` 的最终取值在 file-system.md §12，见那一行）；停止时正在跑 PreToolUse 钩子的调用同挂着的卡（hooks.md §6.3） |
| `docs/v1/screens/fs-permissions.md` | 规格 | 批准卡上 Scope 行之前的 `PreToolUse hook (…): <原因>` 一行（`approval-hook-reason`）；工具卡的放行标签多一种 `Allowed by PermissionRequest hook`（`by: 'hook'`）；见 hooks-chat.md |
| `docs/v1/screens/team-approvals.md` | 规格 | 后台批准卡同样有 `PreToolUse hook (…): <原因>` 一行；`mori.team_approval_end` 的 `by` 多一种 `hook`（卡片消失，同你在卡上回答）；见 hooks-chat.md“实例里的钩子” |
| `docs/specs/finish-check.md` | 规格 | §5（`agent_before_settle`）：Stop 钩子在 `mori-memory` 与 `mori-approval` 之后、它们都不接着跑的那个边界才跑；钩子的消息不是 `role: 'user'`，不移动检查的起点；一次运行的请求顺序可能是 [回复, 检查, `finish`, Stop 反馈, 回复]（hooks.md §6.7） |
| `docs/specs/memory.md` | 规格 | §9.6 看不见的会话：增强会话与它的实例不注册 `mori-hooks`，一个钩子都不跑（hooks.md §6.2）；§7.7 记忆目录的写保护另在 PreToolUse 换过参数之后由路径闸再查一次（`guardWrite`，hooks.md §6.3） |
| `docs/specs/subagent.md`、`docs/v1/screens/subagent-card.md` | 规格 | SubagentStop 拦下时实例接着跑，那一行保持运行中，`Response` 是接着跑之后的最后一段文字（hooks.md §6.8） |
| `docs/specs/model-providers.md` | 规格 | 换模型时的重建（`session.compact()`）可能被 PreCompact 钩子取消，抛 `Compaction cancelled`，按已有的重建失败处理（hooks.md §6.12） |

## 12. 临时默认值（登记到 docs/v1/defaults.md）

下面一节原样贴到 `docs/v1/defaults.md` 末尾。标“Claude”的是照 Claude 文档的值（列在这里方便找，不是临时默认值）；其余都是写规格时定的，待负责人审。

```markdown
## 钩子（2026-10-29 写规格时定、待负责人审）

来源：[钩子构建规格](../specs/hooks.md) §0“写规格时定的”；状态表 [screens/customize-hooks.md](screens/customize-hooks.md)、[screens/hooks-chat.md](screens/hooks-chat.md)；检查记录 [hooks-checks.md](hooks-checks.md)。
范围（只做 command、十个事件、两份 pi 设置、Customize 的只读列表与开关）是负责人 2026-10-28 定的，不在这里。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| matcher 与 `tool_input` | pi 的工具名与参数原样（`bash`、`edit`、`mcp__<服务>__<工具>`…），区分大小写；Claude 的 `Bash`、`Edit\|Write` 不匹配 | `app/src/kernel/hooks.ts`；规格 §0 第 1 条 | 模型调用的就是这些；改成 Claude 的名字与参数是一层兼容，参数形状也对不上 | 你审时；从 Claude 抄配置不方便时 |
| `permission_mode` | Ask each time → `default`，Full access → `bypassPermissions`；只在 PreToolUse、PermissionRequest、PostToolUse、UserPromptSubmit、Stop、SubagentStop 带 | `app/src/kernel/hooks.ts`；§5.3 | Claude 的取值是固定的词；Full access 最接近；带哪些事件照 Claude 各事件的例子 | 你审时 |
| 跑命令的 shell | bash 为会话设置的 `getShellPath()`，没有时用启动时 `findShell` 查到的；只有 `none` 与 WSL 的 bash 算没有；没有 bash 时 PowerShell（路径在启动时查一次）；`shell` 字段照它；跑钩子时不调 pi 的 shell 查找 | `app/src/kernel/hooks.ts`、`app/src/kernel/shell.ts`、`app/src/kernel/hookRun.ts`；§5.1 | 同 Claude 的顺序，与模型的 bash 工具一致；pi 的查找同步起 `where.exe` | 你审时 |
| PowerShell 的包装 | 前面一行把输入输出编码设成 UTF-8，后面一行 `if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }` | `app/src/kernel/hookRun.ts`；§5.1、§0 第 27 条 | `-Command` 把退出码 2 变成 1、按系统代码页读写（本机实测） | 你审时；换到 pwsh 7 的机器上实测时 |
| stdin 与跑完 | 写 stdin 之前接住 stdin 与进程的错误（钩子不读 stdin 就退出不算错误）；进程退出、两个流结束或安静 100 毫秒就算跑完；到时、中止时 taskkill 返回就结束；1 MiB 之后照读、丢掉 | `app/src/kernel/hookRun.ts`；§5.1、§5.4、§5.8 | 同 pi 的 bash 工具与 `waitForChildProcess`；留着管道的后代进程不让 `close` 到来 | 你审时 |
| 支持的处理器字段 | `type`、`command`、`timeout`、`shell`；`statusMessage`、`once` 忽略（`once` 同 Claude 在设置文件里忽略）；`args`、`async`、`asyncRewake`、`if`、`onFailure` 写了列为问题、不跑 | `app/src/kernel/hookConfig.ts`；§4.1、§4.5 | 不支持却照跑会做错事 | 你要其中哪项时 |
| 设置问题的原文 | §4.5 的表（引号用 “ ”） | `app/src/kernel/hookConfig.ts` | Claude 的原文不在文档里 | 你走查时 |
| 什么时候读设置 | 用户会话建好时读一次；开着的会话不变；实例用所属用户会话的快照 | `app/src/kernel/hooks.ts`、`app/src/kernel/team.ts`；§4.6 | 同 Mori 读别的 pi 配置；Claude 现在是改了就重读；实例晚建时读会拿到之后改的、不经信任的文件 | 你审时 |
| 信任 | 工作区不被信任（`untrusted`、`unasked`）时一个钩子都不跑；没有项目资源、Mori 不问的文件夹（`none`）用户级照跑 | `app/src/kernel/hooks.ts`；§4.2、§0 第 23 条 | Claude 接受信任之前一个都不跑，但 Claude 每个文件夹都问 | 你审时 |
| `CLAUDE_PROJECT_DIR` | 会话的工作路径；worktree 里的会话为主文件夹（`worktreeOf(cwd).mainFolder`）；PowerShell 里 `${CLAUDE_PROJECT_DIR}` 换成 `${env:CLAUDE_PROJECT_DIR}` | `app/src/kernel/hookRun.ts`；§5.2、§0 第 4 条 | Claude（worktree 里也指向会话开始的项目根，`cwd` 字段才是 worktree） | — |
| 环境变量与 cwd | 后台进程的环境加 `CLAUDE_PROJECT_DIR`，不用 `workEnv`；cwd 不存在时依次为主文件夹、用户目录、系统临时目录 | `app/src/kernel/hookRun.ts`；§5.2 | 钩子不是模型的命令；退路的顺序照 Claude | 你审时 |
| 实例的公共字段 | `session_id`、`transcript_path` 是用户会话的；另带 `agent_id`、`agent_type`（角色名，基座 `mori`） | `app/src/kernel/hooks.ts`；§5.3 | Claude 在 subagent 里的写法 | 你审时 |
| 带上的可选字段 | MCP 工具的 `mcp_server: { name, source }`（`source` 为 Mori 的 MCP 配置的 `user` / `project`）；PostToolUse 的 `duration_ms`（路径闸放行到 `tool_result`）；会话有名字时 SessionStart、UserPromptSubmit 的 `session_title`；Notification 的 `title: "Permission needed"` | `app/src/kernel/hooks.ts`；§5.3、§6.5、§6.9、§6.11 | Claude 有、Mori 有对应 | 你审时 |
| 不带的字段 | `prompt_id`（没有每条消息的 id）、`effort`（Effort 是 pi 的另一组取值）、`scratchpad_dir`（没有 scratchpad）、`permission_suggestions`（不收 `updatedPermissions`）、`background_tasks`、`session_crons`（没有对应）、SessionStart 的 `model`（每次回复才选模型）、`agent_type`（没有 `--agent`）与 resume 的费用字段 | §5.3、§6 | 写在各项后面 | 你要时 |
| `tool_response` | `{ content, details }`，图片块不带数据 | `app/src/kernel/hooks.ts`；§6.5 | pi 的结果没有 Claude 那样按工具的结构 | 你审时 |
| 时限 | 600 秒；UserPromptSubmit 30 秒；SessionEnd 合计 1.5 秒、按最大 `timeout` 提高、最多 60 秒，没写 `timeout` 的仍在 1.5 秒时杀掉（Claude） | `app/src/kernel/hookRun.ts`；§5.4、§6.10 | Claude | — |
| 退出 Mori 时的 SessionEnd | 与关 Team、释放会话同时开始，合计固定 1.5 秒、不按 `timeout` 提高 | `app/src/kernel/sessions.ts`；§6.10、§0 第 26 条 | 主进程只给后台进程 3 秒 | 你审时 |
| SessionEnd 时归档、删除等钩子 | 归档、删除的命令等这个会话的 SessionEnd 钩子结束（最多 60 秒）才返回 | `app/src/kernel/sessions.ts`；§6.10 | 照 Claude 的时限，钩子在会话文件还在时跑完 | 你审时 |
| 去重 | `command` 与 `shell` 都相同算同一个，跑排在前面的、用它的 `timeout` | `app/src/kernel/hookConfig.ts`；§5.5 | Claude 没说什么算相同 | 你审时 |
| 结果合并 | PreToolUse `deny` > `defer` > `ask` > `allow`（Claude），给 `defer` 的那条整个忽略、记警告；PermissionRequest `deny` > `allow`；`updatedInput` 用最前面的；原因、上下文都保留 | `app/src/kernel/hookRun.ts`；§5.5 | 按最严；Mori 没有 `-p` | 你审时 |
| 退出码 2 与 JSON | 退出码 2 时合格的 JSON 照样起作用、只是改变不了拦下；原因优先用 JSON 给的拦下原因；PermissionRequest 带 `decision` 的照它 | `app/src/kernel/hookRun.ts`；§5.6 | Claude | — |
| 输出上限 | stdout、stderr 各留前 1 MiB；`additionalContext`、`systemMessage`、纯文本 stdout（Claude）与原因、`stopReason`、作为原因的 stderr（Mori 加的）每段超过 10,000 个字符时只留前 10,000 个、接 `… [<n> more characters cut]` | `app/src/kernel/hookRun.ts`；§5.8 | Claude 是 10,000 字符、另存文件给预览；原因会进工具结果 | 你审时 |
| 哪些会话跑哪些事件 | §6.2 的表；增强任务的会话与它的实例都不跑；`finish` 都不跑 | `app/src/kernel/hooks.ts`、`app/src/kernel/sessions.ts` | Claude 的设置钩子也在 subagent 里跑；增强会话、`finish` Claude 没有 | 你审时 |
| PreToolUse 的位置 | 路径闸里、`decide` 之前；`mori-team`、`mori-memory` 先拒绝的不跑；换过的参数先经记忆目录写保护再查一次 | `app/src/kernel/approval.ts`；§6.3 | pi 没有“放行”的结果；改扩展顺序牵动面大 | 你审时 |
| 没有 Git Bash | PreToolUse、PermissionRequest 的钩子失败（起不来、到时、不合格的 JSON、退出码不是 0 或 2）就拦下或拒绝，写了 `shell: "powershell"` 的也算 | `app/src/kernel/hooks.ts`；§6.3、§6.4 | Claude v2.1.309 | — |
| PreToolUse 的上下文碰上别的拒绝 | 只接在执行了的结果与钩子自己的拦下后面；路径闸、你、停止拒绝的丢掉 | `app/src/kernel/approval.ts`、`app/src/kernel/hooks.ts`；§6.3、§0 第 25 条 | 界面按整句认这些拒绝 | 你审时 |
| 停止时正在跑的 PreToolUse 钩子 | 同挂着的卡：杀掉、按停止拒绝、等它在 pi 里结束 | `app/src/kernel/approval.ts`；§6.3 | 不然拒绝原文被 `Operation aborted` 盖掉 | — |
| `allow` 与路径闸 | 只省掉第 4 步的卡；第 3 步照样出卡，收窄、没人能批照样拒绝 | `app/src/kernel/approval.ts`；§6.3 | Claude：`allow` 不盖过 deny、ask 规则 | 你审时 |
| 职责工具上的 `ask` | 出 scope 为 `inside`、没有目标的卡 | `app/src/kernel/approval.ts`；§6.3 | 职责工具平时不分类 | 你走查时 |
| PermissionRequest 的时机 | 卡照常出现、同时跑钩子，先决定的算 | `app/src/kernel/approval.ts`；§6.4 | Claude 在桌面版、VS Code 里的做法 | 你审时 |
| PermissionRequest 的 `updatedInput`、`updatedPermissions` | 按输出不合格：非阻断错误，卡照常等 | `app/src/kernel/hookRun.ts`；§6.4 | 要按改过的参数、规则重走路径闸 | 你要时 |
| Notification | 只有 `permission_prompt`，批准卡等了 6 秒（Claude 的“约 6 秒”）；`title` 为 `Permission needed`（Claude）；`message` 为 `Mori needs your permission to use <tool>`（Mori 的，Claude 的例子是 `Claude needs your permission`） | `app/src/kernel/approval.ts`；§6.11 | Mori 没有别的通知；带工具名分得清几张卡 | 你审时 |
| UserPromptSubmit 的位置 | `promptEntry` 里、交给 Team 或 pi 之前；空闲时直接开始回复的在准备中跑，其余在按发送顺序的链上跑；只跑你的消息，程序投递（Team 投递、唤醒）不跑；先等 SessionStart | `app/src/kernel/hookPrompt.ts`、`app/src/kernel/sessions.ts`；§6.6、§0 第 9 条 | 协作模式下 pi 的 `input` 太晚；钩子跑的时候会话不能看起来空闲；Claude 对后台 subagent 的回报、别的会话的消息也跑，Mori 的程序投递是协议消息、拦下会打乱投递记录 | 你审时（要问第 12 条） |
| UserPromptSubmit 拦下时留下什么 | 文字回到输入框，错误卡只在这次打开里，不写进会话文件，不接 `Original prompt:` | `app/src/kernel/sessions.ts`；§6.6、§0 第 24 条 | 同 Mori 别的发送前失败；Claude 写进会话文件、接原文 | 你审时（要问第 13 条） |
| 上下文怎样交 | `mori.hook_message`（`display: false`）由 `mori-hooks` 的 `before_agent_start` 只交给这条消息开始的那次运行；没开始运行时丢掉；生成中发出的消息要等下一次运行；不用 `nextTurn` | `app/src/kernel/sessions.ts`、`app/src/kernel/hooks.ts`；§6.6、§6.9 | pi 的插话、排队一次一条；`nextTurn` 没开始运行时会跟着下一次不相干的运行走 | 你审时 |
| `stopReason` 进上下文 | 用户会话里 `continue: false` 带的 `stopReason` 另记一条不显示的 `Stopped by <Event> hook: …`，下一次运行开始时交 | `app/src/kernel/hooks.ts`；§5.7、§7.7 | Claude：`stopReason` 留在对话里 | 你审时 |
| SessionStart 的时机与 `source` | pi 的 `session_start`（`sessionStartEvent`）；打开为 `resume`，其余 `startup`；Check again、worktree 重建也跑 | `app/src/kernel/sessions.ts`、`app/src/kernel/hooks.ts`；§6.9 | 重建出来的是新的 pi 会话 | 你审时 |
| SessionEnd 的 `reason` | 归档、删除为 `other`；退出 Mori 为 `prompt_input_exit`；重建与崩溃不跑 | `app/src/kernel/sessions.ts`；§6.10 | Claude 的取值里没有归档 | 你审时 |
| PreCompact | 只在用户会话；阈值、溢出、重建都为 `auto`；`custom_instructions` 为 `null`；拦下溢出恢复时出一行 `PreCompact hook blocked context overflow recovery: <原因>` | `app/src/kernel/hooks.ts`；§6.12、§0 第 28 条 | Mori 没有 `/compact`；Claude 拦下溢出恢复时显示底下的错误，Mori 的界面那时已经去掉了那张错误卡 | 你审时 |
| Stop 的位置与上限 | 在收尾检查、你不在的提醒之后，它们要接着跑时不跑；连续 8 次（Claude）、调了工具清零 | `app/src/kernel/hooks.ts`；§6.7 | 只在回复真要结束时跑 | 你审时 |
| SubagentStop 的范围 | 只对 subagent 工具开出的实例 | `app/src/kernel/hooks.ts`、`app/src/kernel/team.ts`；§6.8 | Claude 的 subagent 对应它；TaskBoard 实例对应的是 agent teams 的事件 | 你审时 |
| `continue: false` | 用户会话照停止按钮停下（排队的回到输入框）；实例只拦下；PermissionRequest 的 `interrupt: true` 同样停下、不另出一行 | `app/src/kernel/hooks.ts`、`app/src/kernel/sessions.ts`；§0 第 16 条、§6.4 | 复用停止的路径；拒绝的原因已经在工具卡上 | 你审时 |
| 交给模型的原文 | §7（不带钩子的命令；Claude 的例子是 `PreToolUse:Bash hook error: [<命令>]: <stderr>`） | `app/src/kernel/hooks.ts`、`app/src/shared/hooks.ts` | 命令原文可能有密钥；`DENIAL_PREFIXES` 按固定开头认 | 你走查时（要问第 14 条） |
| 钩子行与批准卡、工具卡的文字 | §8.2–§8.4（`Stop hook feedback`（只给 `additionalContext`）、`<Event> hook error`（含 Stop 的拦下）、`Failed with non-blocking status code:`、`Allowed by PermissionRequest hook`、Git Bash 那一句照 Claude）；界面用 response 不用 reply | `app/src/shared/hooks.ts`、界面 | 其余 Claude 的原文不在文档里 | 你走查时 |
| 批准卡上钩子的一行 | 钩子 `ask` 出的卡都有一行 `PreToolUse hook (User settings): <原因>`（`Project settings`、`User and Project settings`；没有原因时不带冒号）；后台批准卡同样 | `app/src/kernel/approval.ts`、界面；§8.3、§0 第 29 条 | Claude 的提示带钩子来源的标签 `[settings]`；Mori 用 Customize 的 User / Project | 你走查时 |
| 钩子行存在哪 | 会话文件的 `mori.hook_line` 条目（不进模型的上下文），打开会话时照画；打开会话时已经在返回的条目里的不再实时发 | `app/src/kernel/hooks.ts`、`app/src/renderer/src/state/history.ts`；§8.2、§6.9 | 同模型层的换模型提示 | 你审时 |
| 对话流里钩子的显示 | hooks-chat.md“本表定下的界面细节”：钩子行用 `notice` 的样子，`error`、`limit` 用警示色；工具事件的行紧跟那张卡；批准卡上那一行在 Scope 行之前；钩子在跑时不另加状态 | 界面；hooks-chat.md | 规格没给 | 你走查时 |
| 操作记录 | `Disable all hooks` / `Enable all hooks`；`hooks.get` 不记 | `app/src/renderer/src/state/actionLog.ts`；§8.5 | 同别的开关 | 你走查时 |
| 开关的写法 | 为真写 `"disableAllHooks": true`，为假去掉这个键；用户级文件不在时新建 | `app/src/kernel/hookCommands.ts`；§8.1 | 同 `defaultTools` 与默认相同时去掉 | 你审时 |
| Customize 的位置与文字 | Plugins 之后、Instructions 之前，没有会话时也在；不信任（`untrusted`、`unasked`）时开关之后一行 `Hooks don’t run in this workspace because it isn’t trusted.`、用户级的行变淡（`.hooks-off`），`none` 时不变淡、没有这一行；第一行、空列表、问题、读不出、不信任等原文见 customize-hooks.md | `app/src/renderer/src/components/ToolsHooks.tsx` | Instructions 是负责人定的最后一节 | 你走查时 |
| Disable all hooks 在项目写了时只读 | 受信任项目的 `.pi/settings.json` 写了 `disableAllHooks` 时开关只读、显示生效的值与一句说明 | `app/src/renderer/src/components/ToolsHooks.tsx`；customize-hooks.md | 开关只写用户级，项目的值盖过它（Claude 的优先级），按了也不起作用；同内置工具与技能的只读写法 | 你走查时 |
| 两份文件里相同的处理器都列出 | 用户级与项目里 `command`、`shell` 都相同的两行都列，运行时只跑一次 | `app/src/renderer/src/components/ToolsHooks.tsx`；customize-hooks.md | 列表照文件，看得出两边都写了；Claude 的 `/hooks` 没说 | 你走查时 |
| 测试的名字 | `--spec hooks`、`HK-n`、`hk-`、App 测试端口 5020–5039 | `app/tests/` | 同其他规格 | — |
| `test:hk-unit` 的时长 | 不超过 20 秒（单元测试要起几十个 node 进程） | `app/package.json` | `test:min` 仍不超过 3 分钟 | 量出来超过时 |
```

## 13. 验收

### 13.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/hooks/*.test.mjs`（`node --test`，经 `tests/unit/load.mjs` 打包内核与界面模块，同 `finish/`；报告器 `tests/unit/hk-reporter.mjs` = `createReporter('hk-unit.json')`，严格模式） | `hookConfig.ts`、`hookRun.ts` 的纯函数；`runHook` 起真的 node 进程（测试在临时目录写的钩子脚本，synthetic）；`HookSession` 与 `mori-hooks` 的处理器（替身 `ExtensionAPI` 与替身 `sessionManager`，synthetic）；路径闸的 `onToolCall`、`request`、`finish`、`rejectForStop`（`tests/unit/` 现有的路径闸替身）；`hookPrompt.ts`；`hookCommands.ts`（临时 agentDir）；协议的 zod；界面状态函数（`applyApproval` 的 `hook`、钩子行的实时与 `transcriptFromEntries`、`denialOf`） |
| App | `tests/ui/hk-app-tools.mjs`（端口 5020–5025：PreToolUse、PermissionRequest、PostToolUse、Notification）、`tests/ui/hk-app-session.mjs`（5026–5031：UserPromptSubmit、Stop、SubagentStop、SessionStart、SessionEnd、PreCompact、钩子行）、`tests/ui/hk-app-customize.mjs`（5032–5035：customize-hooks.md）；帮助函数在 `tests/ui/hk-helpers.mjs` | Electron + 合成端点 + 记录代理（`v1-switch-helpers.mjs`）。测试在临时 userData 的 `pi\settings.json`（与项目的 `.pi\settings.json`、`trust.json`）里写钩子，命令是 `node "<正斜杠的路径>" <场景>`（bash 与 PowerShell 都能跑；PowerShell 下 node 的退出码 2 靠 §5.1 的包装才交得出来，HK-06、HK-15 的用例就查这一点），脚本是测试运行时在临时目录写的 node 文件（synthetic，不提交带 `HK-` 字面量的脚本）：把 stdin、cwd、`CLAUDE_PROJECT_DIR` 记进文件，按场景睡、写 stderr、输出 JSON、以某个退出码结束 |
| 回放 | `tests/ui/hk-replay.mjs`，fixture 在 `tests/fixtures/hooks/`（`harness/main.jsx` 加载这个目录） | `tests/ui/hk-record.mjs` 从真实的 App 对合成端点录下 `hk-pre-block.json`、`hk-prompt-block.json`、`hk-stop.json`、`hk-lines.json`，都标 `source: 'synthetic'`（同收尾检查规格 §14.1）；`hk-real.mjs` 另把真实录制写成 `*-real.json`，有时一并回放。缺 fixture 记失败 `HK-nn replay fixture missing` |
| 真实 | `tests/ui/hk-real.mjs --source <你的数据目录>` 或 `--keys D:\code`（deepseek、glm 的 `.env`，key 只在进程里读，不打印、不落盘） | HK-35；只断言程序保证的事，模型怎么回应写进 note |

**合成端点**（`tests/fake-endpoint/hooks.mjs`，synthetic，照 `finish.mjs` 的放法，不放进 `scenarios/`）：起点那条消息里有 `hk-scenario:<名字>` 时，这次运行的请求按场景回答（例如第一次回 `call bash { command: "echo hk > hk-marker.txt" }`，
看到工具结果以 `Blocked by PreToolUse hook: ` 开头时回 `say Blocked.`；最后一条 user 消息以 `Stop hook feedback: ` 开头时回 `say Continued.`）；场景按 §13.2 的需要逐个列在文件开头的注释里。收尾检查的默认回应照旧（`finish.mjs`）。

**与 AGENTS.md“测试分层”的关系**：每次改动跑第一层 `npm run test:quick`（加上 `test:hk-unit`，§11.10）与这包的 `--only` 用例；`test:hk-unit` 不超过 20 秒（§12）。
模型看到的会变（工具结果后面的文字、`mori.hook_message`、Stop 之后接着跑），所以录 fixture 与真实模型走查要做（工作约定第 2 条）。App、回放、真实层与 `spec-coverage --spec hooks` 在功能做完时的第二层与发版前的第三层跑。
`app/src`、`app/tests` 里新加的行不能有 `tests/md-markers.mjs` 认作推迟标记的词（测试与报告器里写“标为待办”，不写那几个英文词）。

### 13.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| HK-01 | 读两份设置与信任 | 单元：`readHooks` 读出用户级与受信任项目 `hooks` 的全部条目，同一事件两边的组都在、用户级在前、各按文件顺序（不是 `getSettings()` 的数组替换）；`projectTrust` 为 `untrusted`、`unasked` 时快照里一个钩子都没有（用户级的也没有），为 `none` 时只有用户级，为 `trusted` 时两份都有；实例的 `HookSession` 用 `InstanceSpec.hooks`（所属用户会话的快照与信任），不读实例自己的 SettingsManager；`.claude/settings.json`、`.claude/settings.local.json` 里的钩子不读。App：用户级与项目各写一条 PreToolUse，Trust 之后一次 `bash` 调用两条都跑（两份 stdin 记录）；Don’t trust 时一份 stdin 记录都没有（用户级的也不跑）；`.claude/settings.json` 里的那条没有记录 | 单元、App |
| HK-02 | 有问题的条目 | §4.5 表的每一种（含 settings.json 不是 JSON）：进 `problems` 或 `readErrors`、原文与表相同（引号是 “ ”），那一条不跑，同一文件里别的照跑；`statusMessage` 不算问题；写了 `once: true` 的不算问题、每次匹配的事件都跑（跑两次有两份记录）；`args`、`async`、`asyncRewake`、`if`、`onFailure` 各一例 | 单元 |
| HK-03 | matcher | §4.3 的每一种：`*`、`""`、不写都匹配；`edit\|write` 与 `edit, write` 相同；`Bash` 不匹配 `bash`；`^mcp__`、`mcp__memory__.*` 按不锚定的正则；`mcp__memory` 不匹配 `mcp__memory__create`；不合法的正则列为问题；每个事件比对 §6.1 的那个值；UserPromptSubmit、Stop 写了 matcher 也照跑 | 单元 |
| HK-04 | disableAllHooks | 单元：`disabledOf`：用户级真 → 关；受信任项目写了按项目的（项目 `false` 盖过用户级 `true`）；不信任的项目写了不算；关着时十个事件都不起进程。App：用户级 `disableAllHooks: true` 时一次发送、一次 `bash` 调用、一次运行结束、一次归档都没有 stdin 记录；Customize 照常列出 | 单元、App |
| HK-05 | 建会话时读一次 | App：会话打开之后加一条 PreToolUse、改 `disableAllHooks`：这个会话照打开时的跑；之后才开出的 subagent 实例的工具调用也照会话打开时的跑（加的那条没有记录）；新建的会话、重新打开的会话、重启后台进程后重新打开的会话按新的跑 | App |
| HK-06 | 进程 | 单元：§5.1 每一行的 `spawn` 参数（有 bash、没有 bash、`shell: "bash"` 而没有 bash 时起不来、`shell: "powershell"`、WSL 的 bash 按没有）；bash 的路径：`getShellPath()` 有值时用它，没有时用 `findShell` 的 `configured`、`pi`、`git` 结果（`pi` 这种 `getShellPath()` 为空也有 bash），只有 `none` 算没有；建 `HookSession` 之后跑钩子不调 pi 的 `getShellConfig()`、`getPowerShellConfig()`（替身记下调用次数为 0）；PowerShell 的命令是 §5.1 的包装（`powershellCommand` 逐字），`${CLAUDE_PROJECT_DIR}` 换成 `${env:CLAUDE_PROJECT_DIR}`、`$CLAUDE_PROJECT_DIR` 不换；真的 `powershell.exe` 跑 `node -e "process.exit(2)"` 退出码为 2、`throw "x"` 为 1、`exit 3` 为 3；含中文的 `prompt` 经 stdin 读进 PowerShell 再写到 stdout，回来的与发出的逐字相同；cwd 为工作路径，不存在时依次为主文件夹、用户目录、临时目录并记日志；`CLAUDE_PROJECT_DIR` 为工作路径，worktree 会话为 `worktreeOf(cwd).mainFolder`、stdin 的 `cwd` 仍是 worktree 里的路径；环境变量为后台进程的加 `CLAUDE_PROJECT_DIR`；stdin 是 §5.3 加这个事件的字段（每个事件一个用例，逐项比较；`permission_mode` 只在 §5.3 的六个事件里有；MCP 工具有 `mcp_server`），写完关闭；`windowsHide`；不读 stdin、立刻退出的钩子给它写 4 MiB 的 stdin：结果照常（按退出码），后台进程（测试进程）没有未处理的 `error`，日志一行 `exited before reading stdin`；起不来的命令（不存在的 shell）按“起不来”、不抛错。App：脚本记下的 stdin、cwd、`CLAUDE_PROJECT_DIR` 与期望相同；实例里的 `bash`（task 实例）带 `agent_id`、`agent_type`，`session_id` 是用户会话的 | 单元、App |
| HK-07 | 时限、停止与清理 | 单元：默认 600 秒、UserPromptSubmit 30 秒、`timeout` 覆盖；到时杀掉进程树（它起的子进程也不在了）、输出丢掉、按非阻断错误；signal 中止时杀掉、不处理输出；`stopAll()` 杀掉这个会话正在跑的全部钩子；`bash -c "sleep 30 & exit 0"`（后代进程留着管道）不到 1 秒就按退出码 0 结束；退出后还在写的输出在安静 100 毫秒之前照收；`rejectForStop` 时正在跑 PreToolUse 钩子的调用返回 `REJECTED_BY_STOP`，`rejectForStop` 等它结束（最多 `STOP_SETTLE_MS`）。App：PreToolUse 钩子睡 60 秒时按停止，2 秒内回复停下、工具卡 `Stopped`（下一次请求里这个调用的结果是 `REJECTED_BY_STOP` 的原文，不是 `Operation aborted`）、钩子进程与它的子进程都不在了；Stop 钩子睡 60 秒时按停止同样；PreToolUse 钩子是 `bash -c "sleep 30 & exit 0"` 时命令照常执行、按停止时 2 秒内回复停下；退出 Mori 后没有钩子进程留下 | 单元、App |
| HK-08 | 同时跑与去重 | 两条各睡 1 秒的同一事件钩子合计不到 2 秒；全部结束后才合并（一条拦下时另一条照样跑完）；用户级与项目里 `command`、`shell` 都相同的只跑一次、用前一条的 `timeout`；`shell` 不同的都跑 | 单元 |
| HK-09 | 退出码与 stdout | §5.6 第一张表的每一格，加第二张表每个事件的退出码 2；JSON 只认整个 stdout 是一个 JSON 对象（一行或几行）；数组、带引号的字符串算纯文本；几行各自是 JSON、第一行 `{` 开头、最后一行 `}` 结尾时：没有一行设了已知字段算纯文本（UserPromptSubmit 的上下文是这段原文），有一行设了算解析失败；退出码 2 加合格的 JSON：`additionalContext`、`systemMessage` 照样起作用，`permissionDecision: "allow"` 放不过；`deny` 的 `permissionDecisionReason`、`decision: "block"` 的 `reason` 存在时它们是原因、否则 stderr；退出码 2 加不合格的 JSON：原因是 stderr；不认得的键忽略并记 `Hook JSON output had unrecognized keys`；放错层的 `additionalContext`、`permissionDecision` 不起作用；`hookEventName` 与事件不同按不合格；退出码 0 时 stderr 不给模型 | 单元 |
| HK-10 | 通用字段 | 单元：`continue: false` 盖过事件自己的决定、取最前面那条的 `stopReason`；用户会话里 PreToolUse、PermissionRequest、PostToolUse、Stop 的 `continue: false` 带 `stopReason` 时记下 §7.7 的消息、下一次运行开始时由 `before_agent_start` 交，没有 `stopReason` 时不记，实例里不记；`systemMessage` 在 Notification、PreCompact、SessionEnd 之外出钩子行；`suppressOutput` 不起作用。App：PreToolUse 钩子输出 `{"continue": false, "stopReason": "hk stop"}`：命令没有执行、回复停下（`Stopped · Changes made so far stay as they are`）、钩子行 `Stopped by PreToolUse hook: hk stop`；你再发一条时，那次请求里紧跟你的消息有 `Stopped by PreToolUse hook: hk stop`（界面不显示）；`systemMessage` 出 `PreToolUse hook: <内容>` | 单元、App |
| HK-11 | 输出上限 | stdout、stderr 各只留前 1 MiB，之后照读（写 2 MiB 的脚本照常、很快结束，不等到时限）；`additionalContext`、`systemMessage`、纯文本 stdout、`reason`、`permissionDecisionReason`、`decision.message`、`stopReason`、作为原因的 stderr 每段超过 10,000 个字符时按 §5.8 截断，`<n>` 正确，几条钩子分开量；钩子行里的 stderr 只有第一行 | 单元 |
| HK-12 | PreToolUse 拦下 | 单元：退出码 2、`permissionDecision: "deny"`、旧写法 `decision: "block"` 都返回 `{ block: true, reason }`，原文按 §7.1；Ask each time、Full access、Allow for this session、按目录放行下都拦；几条里一条拦就拦、原因按顺序换行接起；预告不是 `deny` 时发更正 `mori.tool_gate`。App：`bash` 被拦时标记文件不存在，工具卡 `Denied · Blocked by PreToolUse hook: …`（悬停全文），下一次请求里这个调用的工具结果是 §7.1 的原文；重新打开会话后卡片相同。回放：`hk-pre-block.json` | 单元、App、回放 |
| HK-13 | PreToolUse 放行与询问 | 单元：`allow` 时 Ask each time 下工作路径里的写入与命令不出卡；工作路径外与受保护路径照样出卡；收窄、没人能批照样拒绝；`ask` 时 Full access、Allow for this session、按目录放行、读取下也出卡，卡的 `hookAsk` 为 §8.3 的整句（用户级的 `(User settings)`、项目的 `(Project settings)`、两种都有的 `(User and Project settings)`，没有原因时不带冒号）；实例里的 `ask` 出的后台卡（`TeamApprovalRequest`）同样带 `hookAsk`；职责工具的 `ask` 出 scope 为 `inside` 的卡；`deny` > `ask` > `allow`；给 `defer` 的那条整个忽略（它的 `additionalContext`、`updatedInput` 都不用）、记警告，其余几条照合并；没有决定照旧；`mori-team`、`mori-memory` 先拒绝的调用与 `finish` 不跑钩子。App：`allow` 时没有批准卡、命令执行；Full access 下 `ask` 出批准卡、卡上有 `PreToolUse hook (User settings): <原因>`（`approval-hook-reason`）；不给原因的 `ask` 卡上是 `PreToolUse hook (User settings)`；task 实例里 `ask` 出的后台批准卡上有同样的一行 | 单元、App |
| HK-14 | PreToolUse 改参数与上下文 | 单元：`updatedInput` 在 `allow`、`ask` 时整个换掉 `event.input`（同一个对象），路径闸按换过的判断；换过的 `write`、`edit` 的 `path` 指进记忆目录时按 mori-memory 的原文拒绝、不出卡、记日志；`deny`、没有决定、`defer` 时不换；几条都给时用最前面的、其余记日志；`updatedInput` 不是对象时按不合格；`additionalContext` 接在执行了的调用结果后面（§7.3 的文字块），钩子自己拦下的接在 §7.1 的原因后面，几条都保留、按顺序；被你拒绝（不带理由）、按停止、路径闸拒绝的调用不接（结果与没有钩子时逐字相同）、记日志。App：钩子把命令换成写另一个标记文件：执行的是换过的，对话流里没有钩子行、工具卡的 Input 仍是模型写的；钩子把 `write` 的 `path` 换进记忆目录：文件没有写、工具卡 `Denied · …`；上下文出现在下一次请求的工具结果里、工具卡的输出里；给了上下文的调用你按 Deny（不带理由）时工具卡是 `Denied`、按停止时是 `Stopped`（实时与重新打开都一样） | 单元、App |
| HK-15 | 没有 Git Bash | 没有 bash（`findShell` 为 `none`）时 PreToolUse、PermissionRequest 的每条钩子（没写 `shell`、写了 `shell: "powershell"`、写了 `shell: "bash"` 而起不来的都算）：退出码 1（stdout 空）、退出码 1 而 stdout 是放行的 JSON（`permissionDecision: "allow"` / `decision.behavior: "allow"`）、到时、起不来、退出码 0 而 JSON 不合格各一例，都按拦下（PreToolUse）或拒绝（PermissionRequest），原因是 §7.1 的 Git Bash 一句（到时为 `timed out`）；退出码 0 的纯文本 stdout 照常成功；退出码 2 照常拦下、原因是 stderr；用 PowerShell 跑的 `node -e "process.exit(2)"` 拦下、原因是 stderr；有 bash 时这些按非阻断错误；别的事件照非阻断错误 | 单元 |
| HK-16 | PermissionRequest | 单元：只在 `request()` 出卡时跑（用户会话的卡、实例的后台卡、PreToolUse 的 `ask` 出的卡），免批准、Full access 里面的、Allow for this session、按目录放行、收窄拒绝的不跑；`allow` → `finish(…, 'allow', 'hook')` 并执行；`deny` → §7.2；`interrupt: true` 或 `continue: false` 另外停下用户会话的运行（`interrupt` 不出 `stopped` 钩子行，`continue: false` 出）；你先答、切 Full access、Allow for this session、停止、你不在到时、会话关闭先结束时结果丢掉、进程杀掉；退出码 2 而没有 `decision` 不起作用；退出码 2 而有 `decision`（`deny` 或 `allow`）照 `decision`；`updatedInput`、`updatedPermissions` 按不合格、卡照常等；`deny` > `allow`；你不在的计时不变。App：`allow` 钩子：卡出现后消失，工具卡标签 `Allowed by PermissionRequest hook`；`deny` 钩子：工具卡 `Denied · Blocked by PermissionRequest hook: …`；钩子睡 10 秒时你先 Allow once：照你的，钩子进程不在了；task 实例的后台批准卡被 `allow` 钩子结束：用户会话输入框上方的后台卡消失、实例的工具卡在 View transcript 里标 `Allowed by PermissionRequest hook` | 单元、App |
| HK-17 | PostToolUse | 单元：只对执行了、`isError` 为假的调用跑；`tool_response` 按 §6.5（图片不带数据）；task 实例里 `tool_response.content` 是 `mori-team` 已经编过号的（第一个文字块以 `[#1] ` 开头）；`duration_ms` 是路径闸放行到 `tool_result` 的毫秒数（批准卡等的时间不算在里面）；MCP 工具带 `mcp_server`；退出码 2 的 stderr、`decision: "block"` 的 `reason`、`additionalContext` 按 §7.5 各成一个文字块接在 `content` 后面，`structuredContent`、`details`、`isError` 不变，没有要加的时返回 `undefined`；PreToolUse 的上下文排在 PostToolUse 的块之前；`continue: false` 在这个调用之后停下运行。App：`write` 之后钩子退出码 2：下一次请求里这个工具结果后面有 `PostToolUse hook feedback: …`；工具卡仍是 `Done`、输出里有这一句；钩子行同一句；`write` 之后钩子给 `additionalContext`：下一次请求里有 `PostToolUse hook additional context: …`、工具卡输出最后是这一句、没有钩子行 | 单元、App |
| HK-18 | UserPromptSubmit 拦下 | 单元：退出码 2、`decision: "block"`、`continue: false`：消息不交给 Team 也不交给 pi，`mori.prompt_error` 的 `message` 为 §8.4、`text` 为这条消息；空闲时发出的被拦时 `prepareReply` 的结果为 `blocked`、暂存的进 `queued`、`replyEnded()` 照调；其他非 0 与到时（30 秒）：钩子行、消息照常发出；程序投递与看不见的会话不跑。App：空闲时发送被拦：先显示的消息撤回、文字回到输入框、错误卡 `Blocked by UserPromptSubmit hook: …`、没有 `Put your last message back in the message box`，端点没有收到这条消息；重新打开会话时没有这张错误卡、会话文件里没有这条消息；生成中插话被拦：错误卡带放回链接；协作模式（分开）下被拦时立项实例没有收到这条消息的投递；带 `worktree: true` 的第一条消息被拦：worktree 与重建的会话留着、开关不再出现、文字回到输入框、错误卡同上；到时（钩子睡 31 秒）：一行 `UserPromptSubmit hook error: Timed out after 30s`、消息照常发出；退出码 1：一行 `UserPromptSubmit hook error: Failed with non-blocking status code: …`、照常发出。回放：`hk-prompt-block.json` | 单元、App、回放 |
| HK-19 | UserPromptSubmit 的上下文与顺序 | 单元：退出码 0 的纯文本与 `additionalContext` 成 §7.4 的一段，空闲时发出的经 `hooks.arm` 只交给这次 `session.prompt` 开始的运行（`mori-hooks` 的 `before_agent_start` 返回一条 `mori.hook_message`，`display: false`），`session.prompt` 结束时还没交的丢掉、记日志；生成中交给 pi 的经 `hooks.carry` 留到下一次运行；不调 `sendCustomMessage`；`HeldItem.hookContext` 经 Team 到 `dialogStart`、`dispatch`；空闲时发出的钩子在准备中跑（`entry.preparing` 不为空：`isIdle` 为假、`TeamHost.status` 的 `preparing` 为真）；链上有消息时 `prompting()` 为真、`closeSession` 与 `recheckAgents` 拒绝，而 `deliver` 照常开始，钩子过了之后你的消息按 `followUp` 交（不抛 `Agent is already processing`）；同一会话的消息按发送顺序过钩子；钩子跑的时候停止：这条与后面等着的按 `Stopped before sending` 回到输入框（`text` 第一条、`queued` 其余）、钩子进程杀掉。App：上下文在这次请求里紧跟你的消息、界面不显示、会话文件里是 `custom_message`；扩展命令（被扩展接手、不开始运行）之后再发一条普通消息：那次请求里没有第一条的上下文；技能命令与 `/task x` 的钩子 stdin 的 `prompt` 是你打的那一行；带 `worktree: true` 的第一条消息的钩子 `cwd` 是 worktree 里的路径；连发两条（第一条的钩子睡 2 秒）时请求里的顺序同发送；生成中排队的消息的上下文在下一次运行开始的请求里；生成中插话时钩子睡 2 秒、按停止：插话的文字回到输入框 | 单元、App |
| HK-20 | Stop | 单元：只在用户会话、`outcome` 为 `completed`、`event.continue` 为假时跑；退出码 2、`decision: "block"`（没有 `reason` 按不合格）、`additionalContext` → 返回 `[...event.entries, mori.hook_message]` 与 `continue: true`，原文 §7.6；退出码 2 与 `decision: "block"` 出 `error` 钩子行 `Stop hook error: <原因>`，`additionalContext` 出 `feedback` 钩子行 `Stop hook feedback: <内容>`；`stop_hook_active` 在接着跑之后为真、`agent_settled` 后清掉；`last_assistant_message` 是这次运行最后一段非空文字；`continue: false` 不接着跑、出钩子行。App：第一次拦（`stop_hook_active` 为假时退出码 2）：同一次运行多一个请求，末尾是 `Stop hook feedback: …`，只有一个 `agent_settled`，钩子行 `Stop hook error: …`（警示色）在第一段回复之后；第二次放行；给 `additionalContext` 的钩子：钩子行 `Stop hook feedback: …`（普通提示色），同样多一个请求；协作模式的对话会话里同样拦一次、同样多一个请求。回放：`hk-stop.json` | 单元、App、回放 |
| HK-21 | Stop 与收尾检查、提醒、上限 | 单元：收尾检查要检查时（前面给了 `continue: true`）不跑、确认之后的边界跑；同一边界有你不在的提醒时不跑；钩子的消息不移动收尾检查的起点；中间没有工具调用的连续 8 次之后第 9 次不接着跑、出 `limit` 钩子行 `Stop hook blocked 8 times in a row, so the response ended.`；调了工具（`tool_execution_start`）从 0 数。App：一次运行的请求顺序为 [回复, 检查, `finish`, Stop 反馈, 回复]，之后运行结束；一直拦的 Stop 钩子：9 次之后回复结束、对话流里有那一行 `limit` 钩子行 | 单元、App |
| HK-22 | SubagentStop | 单元：只在 `InstanceSpec.subagent` 为真的实例的运行要结束时跑，matcher 比对角色名（基座 `mori`）；stdin 有 `agent_id`、`agent_type`、`agent_transcript_path`、`transcript_path`（用户会话的）、`stop_hook_active`、`last_assistant_message`；拦下时那个实例接着跑（§7.6），钩子行 `SubagentStop hook error: <原因>`，`additionalContext` 时 `SubagentStop hook feedback: <内容>`；task、立项、结案、Task mode 的临时提问、订阅实例不跑 Stop 也不跑 SubagentStop；上限同 Stop（`SubagentStop hook blocked 8 times in a row, so the response ended.`）。App：拦一次：那个 subagent 的行仍在运行、之后 `Done`，`Response` 是接着跑之后的最后一段文字；实例的会话文件里有 `mori.hook_line` 条目 | 单元、App |
| HK-23 | SessionStart | 单元：`sessionStartEvent` 按 `restored` 给 `resume` 或 `startup`；§6.9 表的四种情形与 `source`；实例与看不见的会话不跑；处理器不等钩子；stdin 不带 `permission_mode`、`model`，会话有名字时带 `session_title`；退出码 0 的纯文本与 `additionalContext` 记在 `HookSession`、在下一次运行开始时由 `before_agent_start` 交、排在 UserPromptSubmit 的那段之前、真交出去之后才清掉（中间那条消息没开始运行时留着）；退出码 2 的 stderr 成 `message` 钩子行、不给模型；UserPromptSubmit 先等它；`ready()` 之前的钩子行存着、`ready()` 之后的下一轮事件循环才发；`ready({ inBranch: true })` 时存着的丢掉不发。App：钩子睡 2 秒时 `session.create` 照常很快返回，第一条消息的请求在钩子结束后才发出、带着上下文；新建为 `startup`、打开为 `resume`；立刻结束、退出码 2 的钩子的 `SessionStart hook: …` 一行在新会话的对话流里出现（不因早于 `session.create` 的结果而丢掉），`session.open` 一个已有会话时同样的一行恰好一行 | 单元、App |
| HK-24 | SessionEnd | 单元：`closeSession` 为 `other`（归档与删除都是）、`shutdownSessions` 为 `prompt_input_exit`；Check again、worktree 重建、`attachTeam` 失败的释放、实例、看不见的会话不跑；stdin 不带 `permission_mode`；归档、删除时合计时限默认 1.5 秒、按最大 `timeout` 提高、最多 60 秒，没写 `timeout` 的钩子在提高之后仍在 1.5 秒时杀掉，到时杀掉；`closeSession` 在钩子结束（或到时）之后才返回；退出时合计固定 1.5 秒（写了 `timeout: 30` 也在 1.5 秒杀掉），两个会话的钩子同时开始、与关 Team 和释放同时进行；输出与退出码只记日志。App：归档一个会话：钩子记下 `reason: "other"`、`transcript_path` 是那个会话的文件；删除一个会话：同样记下 `other`；钩子睡 1 秒时归档在钩子结束之后才完成；退出 Mori：两个开着的会话各记下 `prompt_input_exit`；SessionEnd 钩子睡 10 秒（`timeout: 30`）时退出 Mori：TaskBoard 的 board.json 与会话的结束快照照常写好 | 单元、App |
| HK-25 | Notification | 单元：批准卡（用户会话的与后台的）出现 6 秒还没结束时跑一次，`notification_type: "permission_prompt"`、`title: "Permission needed"`、`message` 为 §6.11 的原文，不带 `permission_mode`；6 秒内结束的不跑；退出码、stderr、JSON 都不起作用；提问卡、扩展询问卡不跑。App：Ask each time 下批准卡等 7 秒：一份记录；3 秒内 Allow once：没有记录 | 单元、App |
| HK-26 | PreCompact | 单元：用户会话的 `session_before_compact`，`threshold`、`overflow`、`manual`（重建）都为 `trigger: "auto"`、`custom_instructions: null`、不带 `permission_mode`；退出码 2 或 `decision: "block"` → `{ cancel: true }`；按 `event.signal` 杀进程；拦下 `threshold`、`manual` 不出钩子行，拦下 `overflow` 出 `PreCompact hook blocked context overflow recovery: <原因>`（`error`）；非阻断错误出钩子行；实例不跑。App：阈值压缩被拦：没有 `Compacted session`，会话照常回复；溢出恢复被拦：回复结束、对话流里有 `PreCompact hook blocked context overflow recovery: …` 一行，重新打开会话这一行还在；换模型的重建被拦：按模型层的重建失败显示；钩子退出码 1：一行 `PreCompact hook error: Failed with non-blocking status code: …`、照常压缩 | 单元、App |
| HK-27 | 哪些会话跑钩子 | 单元：§6.2 表的每一格（用户会话、subagent 实例、TaskBoard 各种实例、增强会话与它的实例）；没有 `HookSession` 的会话不注册 `mori-hooks`、路径闸的 `hooks` 为 `null`；`finish` 不跑三个工具事件；`mori-hooks` 加载失败时会话不打开（`requiredExtension`）。App：增强运行（关闭与协作两种）里一个钩子都没有跑；task 实例的 `bash` 跑了 PreToolUse、它的钩子行在 Background tasks 的 View transcript 里 | 单元、App |
| HK-28 | 钩子行 | 单元：§8.2 每种 `kind` 的原文（`error` 的三种情形、`message`、`feedback`、`stopped`、`limit`；没有 `input`）；stderr 为空、退出码 3 时为 `<Event> hook error: Failed with non-blocking status code: exit code 3`；`mori.hook_line` 写进这个会话的文件（实例写进实例的）；实时（`mori.hook_line` 事件）与打开会话（`transcriptFromEntries`）画同一行、位置相同；`applyApproval` 的 `by: 'hook'` 标 `Allowed by PermissionRequest hook`。App：退出码 1、stderr 两行的 PreToolUse：一行 `PreToolUse hook error: Failed with non-blocking status code: <第一行>`、命令照常执行；不合格的 JSON 一行；`systemMessage` 一行；重新打开会话这些行还在。回放：`hk-lines.json` | 单元、App、回放 |
| HK-29 | Customize › Hooks | 状态表 customize-hooks.md 的每一行（检查记录列出“屏 ｜ 行 ｜ 用例”） | App |
| HK-30 | Disable all hooks 开关 | 单元：`hooks.setDisabled` 在 pi 的文件锁里只改用户级 `settings.json` 的 `disableAllHooks`（真写 `true`，假去掉），别的键、顺序、两个空格缩进不变；文件不在时打开开关新建 `{ "disableAllHooks": true }`；文件不是 JSON 对象时报错不写；受信任项目写了它时拒绝；`rewriteSettings` 改写之后 `defaultTools` 的单元用例照样通过。App：开关写入后重新读取、操作记录 `Disable all hooks` / `Enable all hooks`；写入失败显示原文、开关回去；用户级文件不在时打开开关：文件建好、开关开着；之后新建的会话不跑钩子，开着的会话照旧 | 单元、App |
| HK-31 | 进程桥 | `hooks.get`、`hooks.setDisabled` 的 zod（多余字段、类型不对时拒绝）与 §8.1 的结果形状；不带会话时只有用户级；带不受信任的会话时 `projectFile` 为 `null`、`projectTrust` 为 `untrusted`；`mori.hook_line`、`ApprovalEndBy` 的 `hook`、`ApprovalRequestInfo` 与 `TeamApprovalRequest` 的 `hookAsk` 的校验 | 单元 |
| HK-32 | 日志 | §10 每一种日志行；日志里没有命令原文、stdin、stdout、stderr 的内容（用带标记字符串的命令与输出查） | 单元 |
| HK-33 | 没有钩子时不变 | 单元：没写 `hooks` 时 `mori-hooks` 的处理器都返回 `undefined`、不起进程。App：同一段操作（发送、工具调用、运行结束、阈值压缩、归档）在“没写 `hooks`”与“写了全部十个事件的钩子但 `disableAllHooks: true`”两种设置下，发给模型的请求逐字相同、都没有起钩子进程；`sessionStartEvent` 不改 MCP 服务的连接 | 单元、App |
| HK-34 | 原文 | §7 每个块、§8.2 的表、§8.4、§4.5 的表与代码写出的逐字相同（测试从本文读）；`HOOK_BLOCK_PREFIXES` 是 §7.1、§7.2 的开头、在 `DENIAL_PREFIXES` 里，`denialOf` 认出它们 | 单元 |
| HK-35 | 真实模型走查 | 用你的数据目录或 env 文件的 key 跑 `hk-real.mjs`：DeepSeek、GLM 各一个模型。钩子：拦含 `hk-blocked` 的 `bash`（退出码 2）、UserPromptSubmit 加一句上下文、Stop 第一次拦（`stop_hook_active` 为假时）。只断言程序保证的事：被拦的命令没有执行；拦下原文、上下文、Stop 反馈都在之后的请求里；每份 stdin 的字段齐全；Stop 之后同一次运行多一个请求。模型怎样回应（有没有换种写法重试、有没有照 Stop 的反馈做）写进 note 与检查记录；录下 `hk-pre-block-real.json`、`hk-stop-real.json` | 真实 |
| HK-36 | 现有功能不退步 | §13.4 改过的现有测试，以及 `v1-models-existing.mjs --id HK-36` 的全部现有套件通过（§11.10，建在 FS-115 之上）；改过的真实层在走查时跑，交付说明列为未验证 | App、回放 |
| HK-37 | 对话流里的钩子显示 | 状态表 hooks-chat.md 的每一行（检查记录列出“屏 ｜ 行 ｜ 用例”；上面各条已有的 App 用例可以算，没有的在这一条补上，例如重新打开会话没有 `Allowed by PermissionRequest hook`、F8 的 Current view 与 Recent activity、`allow` 而工作路径外照样出卡） | App |

### 13.3 不留未完成项

`tests/spec-coverage.mjs` 的 `SPECS` 加规格 `hooks`（§11.8）：读本文 §13.2（`/^\|\s*HK-\d+\s*\|/`，前缀 `HK`），层的结果文件为 `hk-unit.json`（单元）、`hk-app*.json`（App，含 `-existing`）、
`hk-replay*.json`（回放，含 `-existing`）、`hk-real.json`（真实）；`hk-partial-*.json` 不计入；带跳过或待办标记的检查一律不算通过（同文件系统规格 §19.3）。
`npm run test:hooks` 见 §11.9；真实层由你跑 `hk-real.mjs`，最终一遍不带 `--allow-missing-real`。`v1-models-existing.mjs` 的组 `hooks` 与预设 `HK-36` 见 §11.10；
`tests/unit/taskboard/spec-coverage.test.mjs` 的改动见同一张表。

### 13.4 现有测试

| 测试 | 为什么改 | 怎么改 |
| --- | --- | --- |
| `tests/ui/m6-app-tools.mjs:69-70`、`:467`、`:1942`；`tests/ui/ag-app.mjs:41`、`:132`；`tests/ui/m6-app-settings.mjs` 与 `tests/ui/m6-replay.mjs:947` 里核对分节与没有会话时原文的地方 | Customize 多了 `hooks` 一节（Plugins 之后），没有会话时的原文多了 `hooks` | 有会话时 `['builtin', 'skills', 'roles', 'mcp', 'plugins', 'hooks', 'agents']`，没有会话时 `['skills', 'plugins', 'hooks', 'agents']`；`NO_SESSION` 改为 `No open session. Only user-level skills, plugins, hooks, and instructions are listed.` |
| 断言 `DENIAL_PREFIXES` 全表、`ApprovalEndBy` 取值、`ApprovalRequestInfo` 字段的单元测试（实现前 grep `tests/unit`） | 加了两行开头、`hook`、`hookAsk` | 期望照加 |
| 断言 sessions 扩展顺序或扩展数的单元测试（`requiredExtension`、`loadResources`） | 多了 `mori-hooks` | 期望照加 |
| `defaultTools` 的单元测试（`rewrittenSettings`） | 提出了 `rewriteSettings` | 不改断言，必须照样通过 |
| 其余现有 App、回放、单元测试 | 没写 `hooks` 时一切照旧（HK-33） | 不改，必须照样通过（HK-36） |

实现前再 grep 一遍 `app/tests` 里核对 Customize 分节、没有会话时原文、`DENIAL_PREFIXES`、`ApprovalEndBy`、扩展列表的地方（上表是写规格时查到的），改了哪些写进检查记录。
