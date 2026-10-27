# 批准（M2）

依据：方案 5.5、5.6、5.7、5.8，第 6 节"最小批准扩展"。工具卡的其余状态见 [tool-cards.md](tool-cards.md)，
阶段行与停止见 [chat.md](chat.md)。

## 哪些调用要批准

| 权限 | 工具 | 结果 |
| --- | --- | --- |
| 每次询问（新会话的默认值） | `read`、`grep`、`find`、`ls`（只读，放行名单是常量）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.2：TaskBoard 的 11 个工具同样免批准，从不出卡） | 直接执行，不出卡，没有标签 |
| 每次询问 | 本会话已允许的工具名 | 直接执行，卡上标"Allowed for this session" |
| 每次询问 | 其余所有工具：命令（`bash`、`powershell`）、`edit`、`write`、MCP 工具、插件和项目扩展注册的工具 | 出批准卡，等你选择 |
| 全部允许 | 只读工具 | 直接执行，不出卡，没有标签 |
| 全部允许 | 其余所有工具 | 直接执行，卡上标"Allow all" |

（2026-10-26 注：见 file-system-permissions.md §6 与 ../../v1/screens/fs-permissions.md：本表由路径闸取代。权限模式改为 Ask each time / Full access（“全部允许”去掉，§6.7）；
免批准的是读取类工具、按职责给的工具（TaskBoard 工具、`memory`、`ask_user_question`）和写 `.work/` 的 `edit`、`write`；写到工作路径外、受保护路径、
命令换到外面或分析不了的调用在两种模式下都出卡；“本会话已允许”的工具名只对工作路径里的调用生效（§6.8），另有按目录放行（§6.9）；Full access 下工作路径里的调用标 "Full access"。）

同一条回复里的多个调用逐张出卡：Mori 让 pi 按顺序执行一条回复里的工具调用（`toolExecution: "sequential"`，
临时默认值，见 defaults.md），上一张卡的工具执行完，下一个调用才开始，才出下一张卡。

## 来源（后台进程的批准扩展）

| 事件 / 命令 | 何时 | 内容 |
| --- | --- | --- |
| `mori.tool_gate`（事件） | pi 的 `tool_execution_start` 转发给界面之前，紧挨着它；批准处理器后来的决定与它不同（预告要批准，实际已不用批准，例如扩展里排队的嵌套调用在你选了"Allow “…” for this session"之后才轮到）时再发一次更正 | 这次调用会怎样处理：`ask` 要批准、`session` 本会话已允许、`all` 全部允许、`free` 只读工具（2026-10-26 注：见 file-system-permissions.md §6.14：改为 `ask`、`session`、`dir`（按目录放行）、`full`（Full access）、`free`（读取、按职责给的工具、写 `.work`）、`deny`（不出卡就拒绝），`all` 去掉） |
| `mori.approval_request`（事件） | pi 调用扩展的 `tool_call` 处理器，且需要批准（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.3：后台实例的请求在用户会话的信封上发 `mori.team_approval_request` / `mori.team_approval_end`，见 ../../v1/screens/team-approvals.md） | 请求 id、调用 id、工具名、完整参数（2026-10-26 注：见 file-system-permissions.md §6.13：加 `scope`、`targets`、`allowDirs`，由后台进程判定） |
| `mori.approval_end`（事件） | 请求得到答复 | 允许或拒绝；由谁决定：你、"Allow “…” for this session"、切到"Allow all"、你按了停止、会话结束；拒绝理由（2026-10-26 注：见 file-system-permissions.md §6.14、§9.4：`by` 为 `user`、`session`、`dir`、`full`、`stop`、`closed`、`away`，`all` 去掉） |
| `approval.answer`（命令） | 你在卡上选择（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.10：`requestId` 可以是后台批准的 `<实例 id>:<编号>`，`sessionId` 是用户会话） | 允许一次 / 本会话不再询问此工具 / 拒绝（可带理由）（2026-10-26 注：见 file-system-permissions.md §6.8、§6.9：另有 `allowDir`，按请求的 `allowDirs` 放行目录） |
| `approval.setMode`（命令） | 你在权限菜单里切换 | 每次询问 / 全部允许（2026-10-26 注：见 file-system-permissions.md §6.7：`mode` 为 `ask` / `full`） |
| `approval.forget`（命令） | 你在权限菜单里清除（"Forget"）一项"Allowed for this session" | 工具名（2026-10-26 注：见 file-system-permissions.md §6.9：或目录 `{ dir }`，两者给且只给一个） |

拒绝时，扩展返回 `{ block: true, reason }`，pi 把 reason 原样作为工具结果回给模型。reason 的固定写法
（临时默认值，见 defaults.md；从会话记录载入时按它认出已拒绝，工具卡显示"Denied"）：

| 情况 | 回给模型的工具结果 | 工具卡 |
| --- | --- | --- |
| 你拒绝，没写理由 | `Rejected by the user.` | Denied |
| 你拒绝并写了理由 | `Rejected by the user. Reason: <理由>` | Denied · <理由> |
| 你按了停止（Esc 或"Stop"按钮） | `Rejected: the user stopped the run.` | Denied · You pressed Stop |
| 你不在、到时（2026-10-26 注：见 file-system-permissions.md §9.4） | `The user was away and didn't answer within 5 minutes, so this was denied. Don't retry it. Mention it in your final summary.`（时长按当时的设置写 `60 seconds` / `5 minutes` / `10 minutes`；task 实例、结案会话最后一句为 `Mention it in your handoff.`） | Denied · No answer while you were away |

（2026-10-26 注：见 file-system.md §12：不出卡的程序拒绝（没人能批、收窄、`.work` 建不起来等）的原文开头列在 `DENIAL_PREFIXES`，工具卡显示 `Denied · <原文>`。）

"Allow “…” for this session"的选择和权限只存在后台进程的内存里：后台进程重新载入（Restart）后都回到"Ask each time"，界面在对话流里明说（M1 已有这行）。

## 批准卡

批准卡停靠在输入框上方（排队区之上），不在对话流里滚走；对话流里的工具卡同时显示"Waiting for your approval"。
（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.3：后台实例的卡停在用户会话那一栏，卡头多一行归属 `<role> · T1 · <task title>`，排在对话自己的卡之后，对话一轮结束不清掉；它们没有工具卡，见 ../../v1/screens/team-approvals.md）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 修改（`edit`） | `mori.approval_request`，工具名 `edit` | 标题"Edit `路径`"（长路径折行，不截断）；单独一行完整路径；每处替换的原文和新文（取自参数 `edits`），原文标红、新文标绿，超长时卡内滚动 | 见下"选项" |
| 写入（`write`） | 同上，工具名 `write` | 标题"Write `路径`"；单独一行完整路径；将写入的完整内容 | 同上 |
| 路径在项目文件夹之外 | 修改或写入的路径是会话文件夹之外的绝对路径，或含有 `..` | 警示一行"This file is outside the working directory"（2026-10-26 注：见 file-system-permissions.md §6.13 与 fs-permissions.md：这一行去掉，界面不再自己判断；按请求的 `targets` 每个一行原因行，如 `Writes outside the working directory: <path>`、`Protected path: <path>`，最多 5 行） | 同上 |
| 内容里有不可见的控制字符 | 卡上要显示的文字含双向文字控制符或零宽字符（U+200B–U+200F、U+202A–U+202E、U+2060–U+2064、U+2066–U+2069、U+FEFF） | 这些字符换成可见的"⟨U+202E⟩"，并警示一行"Contains hidden characters, shown as ⟨U+XXXX⟩"（防止显示顺序与实际执行的不同） | 同上 |
| 命令（`bash` / `powershell`） | 同上 | 标题"Run a command"；完整命令行（多行原样显示）；有超时参数时显示"Timeout: Ns" | 同上 |
| MCP 工具 | 同上，工具名 `mcp__<服务>__<工具>` | 标题"<服务> · <工具>"；格式化后的参数 | 同上 |
| 其他工具 | 同上 | 标题为工具原名；格式化后的参数 | 同上 |
| 还有别的卡排在后面 | 同一会话同时有多个请求（例如扩展里嵌套调用）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.3：后台实例的请求也算） | 卡头"N more" | 处理完当前这张，下一张接着出现 |

### 选项

| 选项 | 键盘 | 结果 |
| --- | --- | --- |
| 允许一次（Allow once） | Alt+1 | 只放行这一次；工具卡变"Running…" |
| 本会话不再询问（"Allow “Run commands” for this session"，按工具名：Run commands / Edit files / Write files / `<服务> · <工具>` / 原名） | Alt+2 | 放行这一次，并记住工具名；命令类下方小字"You won’t be asked again for any command in this session."，其他类"You won’t be asked again for “Edit files” in this session."；排在后面的同名请求一起放行（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.1：这个用户会话里所有 Agent 挂起的同名请求一并放行，之后都不再询问） |
| 拒绝（Deny） | Alt+3；或在理由框里按 Enter | 不执行；理由框（占位文字"Tell the model why (optional)"）里的文字作为理由；工具卡变"Denied · <理由>" |

（2026-10-26 注：见 file-system-permissions.md §6.13：第二个选项按请求定：工作路径里的调用按工具名（小字改写，命令类为 `You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects that it writes outside the working directory or to a protected path, or changes to a folder outside it.`），
写到外面的调用按目录（`Allow writes to <目录> for this session`），受保护路径、看不出目标、换到外面、分析不了的没有第二个按钮，见 fs-permissions.md。
见 file-system-permissions.md §9.4、§9.9：你不在（Mori 窗口不在前台或最小化）时卡片计时，最后 20 秒卡头下一行 `You’re away · Denying in 12s`，到时按拒绝结束（`by: 'away'`），见 ../../v1/screens/fs-question.md。）

- 卡片出现时不抢焦点：焦点留在输入框，继续打字不受影响；没有默认按钮，在输入框里按 Enter 仍是发送 / 排队，不会批准。
- Tab 可以走到卡上的按钮和理由框；Alt+1 / Alt+2 / Alt+3（数字键区的数字不算）在焦点位于这个会话面板内任何位置（包括输入框）时都有效；
  有菜单、对话框或 F8 报告框开着时不起作用（M3 起还有会话的右键菜单、改名框、删除确认框、信任询问；
  输入框下面一行的权限、范围、Effort 菜单和"Queue"的下拉也算；上下文用量的详情不算，与选区浮层一样）。
  新的卡出现时，这一行开着的菜单和上下文用量的详情关闭，焦点回到打开它的按钮，所以卡一来就能用 Alt+1 / 2 / 3（[models.md](models.md)）。
- 焦点在卡片上（按钮或理由框）时按 Esc：有开着的浮层（"Queue"的下拉，输入框下面一行的权限、范围、Effort 菜单等）时先关闭它，卡不变
  （上下文用量的详情在焦点移到卡上时已经关了，见 [models.md](models.md)"Tab 移出时关闭"）；
  没有浮层时等于拒绝这张卡（带上理由框里的文字），生成继续，模型会收到拒绝。
- 焦点不在卡片上（例如在输入框）时按 Esc：停止生成（方案 5.8 的顺序：先把排队消息放回输入框，再停止），
  挂起的卡按拒绝处理，工具卡显示"Denied · You pressed Stop"。点"Stop"按钮同样处理。
  （协作模式：见 docs/specs/parallel-agents-taskboard.md §11.4：Esc 只停对话这一回合，后台实例的卡不变；`Stop agents` 时全部卡按拒绝处理）
- 卡片处理完后（允许或拒绝）卡片消失；焦点如果在卡上，回到输入框。

## 工具卡与阶段行（M2 起）

| 状态 | 来源 | 工具卡 | 阶段行 |
| --- | --- | --- | --- |
| 等你批准 | `mori.tool_gate` 为 `ask`，随后的 `tool_execution_start`（pi 先发它，再调用批准处理器） | "Waiting for your approval" | "Waiting for your approval"（不显示"Responding…"或"<标题> Ns"） |
| 已允许、执行中 | `mori.approval_end` 为允许 | "Running… Ns"，从允许的那一刻计时 | "Run npm test 8s" 等 |
| 自动放行、执行中 | `mori.tool_gate` 为 `session` / `all` / `free`，随后的 `tool_execution_start` | "Running… Ns"；`session` 标"Allowed for this session"，`all` 标"Allow all"（2026-10-26 注：见 file-system-permissions.md §6.14：`session`、`dir` 标 "Allowed for this session"，`full` 标 "Full access"，"Allow all" 标签去掉；`deny` 不出卡就拒绝，工具卡 `Denied · <原文>`） | 同上 |
| 预告要批准、实际不用批准 | 第二个 `mori.tool_gate`（更正，见上表） | "Running… Ns"，标出放行原因 | 同"自动放行"那一行 |
| 等待执行 | 回复已结束，前面的调用还在等批准或执行中（`toolExecution: "sequential"`） | "Queued" | 显示前面那个调用的阶段 |
| 已拒绝 | `mori.approval_end` 为拒绝 | "Denied"、"Denied · <理由>"或"Denied · You pressed Stop"；之后 pi 的 `tool_execution_end`（`isError`）不改变它 | 回到"Waiting for the model… Ns"（模型收到拒绝后再回复） |
| 从会话记录载入 | 工具结果 `isError` 且以上表的固定写法开头 | 同"已拒绝"那一行 | — |

"Allowed for this session"和"Allow all"标签只在实时运行时显示；从会话记录载入的工具卡不显示（pi 的记录里没有这个信息）。
（2026-10-26 注：见 file-system-permissions.md §6.14："Allow all" 标签改为 "Full access"，规则不变。）

## 权限菜单（输入框下面一行的左端）

2026-10-21 起权限按钮从顶栏移到输入框下面一行的左端，位置照 Claude 桌面版的模式选择（mode selector）；菜单的内容不变
（方案第 11 节 2026-10-21 的决定）。这一行的整体见 [chat.md](chat.md)"输入框下面一行"。

（2026-10-26 注：见 file-system-permissions.md §6.7、§6.13 与 ../../v1/screens/fs-permissions.md：本节的 "Allow all" 一律改为 "Full access"（按钮 `Full access ▾`、读屏名 `Permission mode: Full access`，
警示色与字色不变）；Full access 的悬停第二行为 `Edits, writes, and commands inside the working directory run without asking.`；确认框标题 `Switch to “Full access”?`，正文
`Edits, writes, and commands inside the working directory will run without asking. Mori still asks before writes it can detect outside it or to protected files. This isn’t a sandbox: scripts and MCP tools can still write anywhere.`，
按钮 `Full access` 与 `Cancel`；切换时只有工作路径里的挂起请求按允许结束（`by: 'full'`），带原因行的卡还在；菜单的 "Allowed for this session:" 列表多出目录项 `Writes to <目录>`，各有 Forget。）

- 按钮照 Claude 的模式选择只有文字："Ask each time ▾"或"Allow all ▾"，任何宽度都没有图标（原来的盾牌去掉），
  不会只剩图标（负责人 2026-10-21 定）。"Allow all"用警示色，也写着"Allow all"，不靠颜色也读得出：底色是警示色的 12%，
  字用较深的 `--color-warn-text`（#855f1e，5.09:1，悬停时 4.66:1；原来的警示色 #b78022 在这个底色上只有 3.02:1，不到 4.5:1）。
- 菜单从按钮往上打开，任何宽度都左边对齐这一行的左端（就是按钮的左边），不超出这一栏和窗口；
  最高 min(440px, 这一行的上边到顶栏下边 − 12px)，"Allowed for this session:"的列表长了在菜单里滚动（见 [models.md](models.md)"菜单的位置与键盘"）。
- 会话面板 ≤ 460px 时去掉 ▾；这一行放不下时模式名截断加"…"（模型 ID 先截，模式名其次，最窄 44px，≤ 340px 时 40px，
  只剩开头几个字母，量到的是"Ask …"、"Allo…"），见 [models.md](models.md)"窄栏"。
- 读屏名总是全名"Permission mode: Ask each time"（借用 Claude 定时任务卡片上的"Permission mode: {mode}"；截断时靠它读出全名）。
  看得见的模式名在这个名字的末尾、不在开头；名字包含看得见的文字，符合 WCAG 2.5.3。
- 悬停两行：第一行全名"Permission mode: Ask each time"（截断时看全名）；第二行照 Claude 是当前模式的说明："Allow all"时
  "Edits, writes, and commands will run without asking."（确认框里的同一句），"Ask each time"没有说明，用 Claude /permissions
  命令的说明"Change the permission mode"。原来的"Set the permission mode for this session"不再用。读屏的描述只有第二行
  （`aria-describedby` 指向藏起来的第二行，不让 `title` 整个变成描述、把全名念两遍）。
- 生成中仍可用，菜单开着时生成开始也不关（同原来）；后台进程退出、重新载入、打开中、打开失败时不可用（`aria-disabled`，
  样式同模型按钮），开着的菜单关闭（原来不关），开着的"Switch to “Allow all”?"确认框也关上、按取消算（不切换，焦点回到
  权限按钮；2026-10-22 审查时补上：不关的话确认后会把切换发给已退出或正在重启的后台进程）；这时悬停的第二行和读屏的描述是原因，就是按钮位置的说明：
  "Mori’s background process crashed"、"Restarting…"、"Starting…"、"Session didn’t open"（[models.md](models.md)
  "不可用时、按钮消失时的焦点"）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 每次询问 | 新会话、重新载入后；或你切回来 | 权限按钮"Ask each time ▾"（只有文字，窄时截断） | 打开菜单 |
| 全部允许 | 你确认切换后 | 权限按钮"Allow all ▾"（只有文字），用警示色（字是较深的 `--color-warn-text`） | 打开菜单 |
| 菜单打开 | 你点了按钮 | 两个选项"Ask each time""Allow all"，当前项打勾；"Allowed for this session:"及其列表（Run commands、Write files……，没有时"None"），每项一个"Forget"；底部说明"Applies to this session only. New sessions start with “Ask each time”."（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.1：说明改为 `Applies to all agents in this session. New sessions start at Ask each time.`，模式与列表作用于这个用户会话的全部 Agent） | 选择；清除一项（Forget）；Esc 关闭菜单 |
| 确认切到全部允许 | 你在菜单里选了"Allow all" | 对话框："Switch to “Allow all”?"和"Edits, writes, and commands will run without asking."，按钮"Allow all"和"Cancel"，焦点在"Cancel" | Allow all；Cancel（Esc） |
| 切换时有挂起的卡 | 同上，确认后（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.1：所有 Agent 挂起的请求一并允许，之后后台实例也不再出卡） | 挂起的卡按允许处理（`mori.approval_end`，由"Allow all"决定），工具卡标"Allow all"（2026-10-26 注：见 file-system-permissions.md §6.7：切到 Full access 时只有 scope 为 `inside` 的卡按允许结束（`by: 'full'`），工具卡标 "Full access"；写到外面、受保护路径、分析不了的卡还在） | — |

切回"Ask each time"不需要确认；之后需要批准的调用又出卡。"Allowed for this session:"的列表在切到"Allow all"时保留，切回后仍然有效。

## 任务栏闪烁

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 窗口不在前台时出现批准卡 | `mori.approval_request`，且 Mori 窗口没有焦点（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.3：`mori.team_approval_request` 同样闪烁） | 任务栏上的 Mori 按钮闪烁（`BrowserWindow.flashFrame(true)`） | 切回 Mori |
| 窗口藏在托盘里时出现批准卡（2026-10-26 加，[window.md](window.md)） | 同上，窗口关掉后藏在系统托盘里（任务栏上没有它的按钮） | 先把窗口以最小化的样子放回任务栏（`BrowserWindow.minimize()`，不抢焦点、不弹到前面），再让按钮闪烁 | 点任务栏按钮或托盘图标切回 Mori |
| 切回 Mori | 窗口获得焦点 | 停止闪烁 | — |

反例：读取文件不出卡；等批准时阶段行显示"Waiting for your approval"，不显示"Responding…"或"<标题> Ns"；在输入框里按 Enter 不会批准；
新会话不继承别的会话的"Allowed for this session"和"Allow all"。
（2026-10-26 注：见 file-system-permissions.md §6.7："Allow all" 改为 "Full access"；Full access 下写到工作路径外、受保护路径仍出卡，反例见 fs-permissions.md。）
