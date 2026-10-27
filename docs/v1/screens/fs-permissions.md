# 权限：模式、按目录放行、批准卡的原因行、工具卡标签

依据：文件系统构建规格（下称“规格”，两个文件：§0–§5、§11–§19 在 [file-system.md](../../specs/file-system.md)，§6–§10 在
[file-system-permissions.md](../../specs/file-system-permissions.md)）的 [§6](../../specs/file-system-permissions.md)（路径闸：§6.1 判断顺序、§6.4 归类、
§6.7 两种模式、§6.8 按工具名放行、§6.9 按目录放行、§6.11 没人能批、§6.12 后台卡、§6.13 载荷与卡片、§6.14 工具卡、§6.15 拒绝原文）、
[§7.8](../../specs/file-system-permissions.md)（分析不了的命令）；[文件系统 Proposal](../../proposals/file-system.md) §6。
补充并部分取代 [v0 approval.md](../../v0/screens/approval.md) 的“哪些调用要批准”“权限菜单”和批准卡的警示行，以及 [team-approvals.md](team-approvals.md) 的“哪些调用出卡”
“权限菜单”两节：卡片的其余内容、三个选项的键盘、焦点规则、任务栏闪烁、后台卡的归属行与排序都沿用它们，下面只写不同的地方。
批准卡与提问卡在你不在时的倒计时见 [fs-question.md](fs-question.md)。界面文字为英文，写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。
标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo.approval`、`approval.setMode` / `approval.answer` / `approval.forget` 的结果 | `ApprovalState`：`{ mode: 'ask' \| 'full', allowed: string[], allowedDirs: string[] }`（[规格 §6.7–§6.9](../../specs/file-system-permissions.md)）；新建、重新打开的会话都是 `{ mode: 'ask', allowed: [], allowedDirs: [] }` |
| `mori.approval_request`、`mori.team_approval_request`（与 `LiveSnapshot.approvals`、`SessionInfo.teamApprovals`、`LiveSnapshot.teamApprovals`） | 现有字段加 `scope: 'inside' \| 'outside' \| 'protected'`、`targets: { reason: 'outside' \| 'protected' \| 'unresolved' \| 'leaves' \| 'unanalyzed'; path: string \| null; text: string }[]`、`allowDirs: string[]`（[规格 §6.13](../../specs/file-system-permissions.md)；`unanalyzed` 是命令分析不了的那一种，`ok: false`，[规格 §7.8](../../specs/file-system-permissions.md)）；由后台进程判定，界面不自己猜 |
| `mori.approval_end`、`mori.team_approval_end` | `by: 'user' \| 'session' \| 'dir' \| 'full' \| 'stop' \| 'closed' \| 'away'`（最终取值见 [规格 §12](../../specs/file-system.md)；`away` 是无人应答的那一种，见 fs-question.md） |
| `mori.tool_gate` | `gate: 'ask' \| 'session' \| 'dir' \| 'full' \| 'free' \| 'deny'`（[规格 §6.14](../../specs/file-system-permissions.md)，最终取值见 [规格 §12](../../specs/file-system.md)） |
| pi 的 `tool_execution_end`（`isError`） | 不出卡的程序拒绝：输出以 `DENIAL_PREFIXES`（`shared/workspace.ts`）之一开头（[规格 §6.15](../../specs/file-system-permissions.md)，完整的一张在 [规格 §12](../../specs/file-system.md)） |
| 会话记录里的工具结果 | 从会话记录载入时，`isError` 且是你拒绝、停止或程序拒绝的原文 |
| 你的操作 | 权限按钮与菜单、确认框、卡上的选择（按钮、Alt+1/2/3、Esc） |

## 哪些调用出卡

| 调用 | Ask each time | Full access |
| --- | --- | --- |
| `read`、`grep`、`find`、`ls`（任何路径）；TaskBoard 工具、`memory`、`ask_user_question` | 直接执行，没有标签 | 直接执行，没有标签 |
| `edit`、`write` 写 `.work/` 下 | 直接执行，没有标签 | 直接执行，没有标签 |
| `edit`、`write` 写工作路径里（不是受保护路径） | 出卡，没有原因行；工具名在 Allowed for this session 里时直接执行，标 `Allowed for this session` | 直接执行，标 `Full access` |
| 命令，后台进程没看出它写到外面或受保护路径 | 出卡，没有原因行；`Run commands` 已允许时直接执行，标 `Allowed for this session` | 直接执行，标 `Full access` |
| 命令分析不了（`ok: false`：引号或括号没闭合、命令名来自变量、`-EncodedCommand` 等，[规格 §7.8](../../specs/file-system-permissions.md)） | 出卡，带原因行 `Couldn’t analyze this command: <reason>`；`Run commands` 已允许时也出卡 | 同左 |
| MCP 工具、扩展注册的工具 | 出卡，没有原因行；已允许时直接执行，标 `Allowed for this session` | 直接执行，标 `Full access` |
| 写到工作路径外（含看不出目标、命令换到外面） | 出卡，带原因行；目标都在已放行的目录里时直接执行，标 `Allowed for this session` | 同左 |
| 写受保护路径（`.git`、`.mori`、`.pi`、`.vscode`……，命令删掉或移走工作路径本身或它的上级） | 每次都出卡，带原因行 | 同左 |
| 收窄越界（[规格 §8](../../specs/file-system-permissions.md)）、没人能批的会话（增强，[规格 §6.11](../../specs/file-system-permissions.md)） | 不出卡，工具卡 `Denied · <原文>` | 同左 |

## 权限按钮（输入框下面一行的左端）

位置、截断、读屏名的写法、不可用时的行为都同 v0 approval.md“权限菜单”，只换模式名。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Ask each time | `ApprovalState.mode` 为 `ask`（新会话、重新载入后、你切回来） | 按钮 `Ask each time ▾`，只有文字；读屏名 `Permission mode: Ask each time`；悬停第二行 `Change the permission mode`（同 v0） | 打开菜单 |
| Full access | 你确认切换后，`mode` 为 `full` | 按钮 `Full access ▾`，警示色（底色警示色的 12%，字是 `--color-warn-text`，同 v0 的 Allow all）；读屏名 `Permission mode: Full access`；悬停第二行 `Edits, writes, and commands inside the working directory run without asking.` | 打开菜单 |
| 窄栏 | 这一行放不下 | 模式名截断加“…”（`Full …` 之类，由 Chromium 决定），全名在悬停第一行与读屏名里（同 v0） | 同上 |
| 不可用 | 后台进程退出、重新载入、打开中、打开失败（同 v0） | `aria-disabled`；开着的菜单与确认框关上，确认框按取消算 | — |

## 权限菜单

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单打开 | 你点了按钮 | 两项 `Ask each time`、`Full access`，当前项打勾；`Allowed for this session:` 与列表；底部说明 `Applies to all agents in this session. New sessions start at Ask each time.`（同 team-approvals.md） | 选择；Forget；Esc 关闭 |
| 列表：工具名 | `ApprovalState.allowed` | 每项按 v0 的写法（`Run commands`、`Edit files`、`Write files`、`<服务> · <工具>`、原名），带 `Forget`，悬停 `Forget “<label>”` | Forget：`approval.forget { toolName }` |
| 列表：目录 | `ApprovalState.allowedDirs` | 每项 `Writes to <目录>`（完整路径，长了折行），排在工具名之后，按放行的顺序，带 `Forget`，悬停 `Forget “Writes to <目录>”`（临时，走查时可以改） | Forget：`approval.forget { dir }` |
| 列表为空 | 两组都没有 | `None`（同 v0） | — |
| 忘掉一项之后 | 命令的结果 | 这一项从列表消失；挂着的卡不变；之后这个用户会话里任何 Agent 的同类调用又出卡 | — |
| 选 Ask each time（当前是 Full access） | 你的选择 → `approval.setMode { mode: 'ask' }` | 不确认；按钮变 `Ask each time ▾`；挂着的卡都不变；列表保留 | — |
| 选 Full access（当前是 Ask each time） | 你的选择 | 菜单关上，弹确认框（下节） | — |

## 切到 Full access 的确认

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 确认框 | 你在菜单里选了 Full access | 对话框（`alertdialog`，警示色）：标题 `Switch to “Full access”?`；正文 `Edits, writes, and commands inside the working directory will run without asking. Mori still asks before writes it can detect outside it or to protected files. This isn’t a sandbox: scripts and MCP tools can still write anywhere.`；按钮 `Full access` 与 `Cancel`，焦点在 `Cancel` | `Full access`；`Cancel`（Esc） |
| 取消 | 你点了 Cancel 或按 Esc | 对话框关上，焦点回到权限按钮，模式不变 | — |
| 确认 | 你点了 Full access → `approval.setMode { mode: 'full' }` | 按钮 `Full access ▾`；焦点回到权限按钮 | — |
| 确认时有挂着的卡 | 随后各个请求的 `mori.approval_end` / `mori.team_approval_end`（`by: 'full'`） | 没有原因行的卡（工作路径里的编辑、写入、命令，MCP）消失，对应的工具卡变 `Running…` 并标 `Full access`；带原因行的卡（写到外面、受保护路径、分析不了的命令）**还在**，“N more”按剩下的算 | 照常处理剩下的卡 |
| 确认框开着时按钮变得不可用 | 同 v0 | 确认框按取消关上 | — |

## 批准卡的原因行与第二个选项

卡的标题、完整路径一行（参数里的原文）、替换与内容、命令行、不可见字符的警示、Allow once 与 Deny、理由框、Esc 都同 v0 approval.md。
v0 的警示行 `This file is outside the working directory` 去掉，换成下面的原因行；界面不再自己按 `..`、绝对路径判断。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 工作路径里的调用 | `scope` 为 `inside`，`targets` 为空 | 没有原因行；第二个按钮按工具名：`Allow “Run commands” for this session`（小字 `You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects that it writes outside the working directory or to a protected path, or changes to a folder outside it.`）、`Allow “Edit files” for this session` / `Allow “Write files” for this session`（小字 `You won’t be asked again for “Edit files” in this session, except outside the working directory or in protected paths.`，Write files 同理）、其他工具 `Allow “<label>” for this session`（小字 `You won’t be asked again for “<label>” in this session.`） | Alt+1；Alt+2 按工具名放行；Alt+3 |
| 写到工作路径外 | `targets` 里 `reason: 'outside'` | 原因行 `Writes outside the working directory: <path>`（后台进程给的真实路径，长了折行），警示色 | 同下面按 `allowDirs` 的两行 |
| 写受保护路径 | `reason: 'protected'` | 原因行 `Protected path: <path>`；删掉工作路径本身时同样写（`<path>` 是工作路径） | Alt+1；Alt+3；没有第二个按钮，Alt+2 不起作用 |
| 看不出写到哪里 | `reason: 'unresolved'` | 原因行 `Writes to a path Mori can’t resolve: <text>`（命令里的原文，如 `$OUT/a.log`） | 同上，没有第二个按钮 |
| 命令换到工作路径外 | `reason: 'leaves'` | 原因行 `Runs outside the working directory: <path>`（看不出目录时是命令里的原文） | 同上，没有第二个按钮 |
| 命令分析不了 | `reason: 'unanalyzed'`（`ok: false`，`scope` 为 `outside`） | 只有一行原因行 `Couldn’t analyze this command: <reason>`（`<reason>` 是 [规格 §7.8](../../specs/file-system-permissions.md) 表里的英文原因，如 `unclosed quote`、`encoded command`、`nested too deeply`） | 同上，没有第二个按钮（不能按目录放行） |
| 几种原因同时有 | 几个 `targets` | 每个一行，按 `targets` 的顺序；最多 5 行，多的一行 `and {n} more`（临时，走查时可以改） | 按 `allowDirs` 定第二个按钮 |
| 可以按一个目录放行 | `allowDirs` 有一个 | 第二个按钮 `Allow writes to <目录> for this session`；小字 `You won’t be asked again in this session for writes directly in this folder (not its subfolders).`；目录是目标的上一级，命令文字看得出东西落进一个目录时（`cp x ../bk/`）是那个目录本身（[规格 §6.9](../../specs/file-system-permissions.md)、§7.2 的 `into`） | Alt+2：`approval.answer { decision: 'allowDir' }` |
| 可以按几个目录放行 | `allowDirs` 有几个 | 第二个按钮 `Allow writes to these folders for this session`；小字 `You won’t be asked again in this session for writes directly in: <目录>, <目录>.` | 同上 |
| 不能按目录放行 | 写到外面但 `allowDirs` 为空（有看不出的目标、换了目录、命令分析不了、目标的上一级是盘符根或共享根，如 `D:\x.log`） | 没有第二个按钮 | Alt+1；Alt+3 |
| 选了按目录放行 | `approval.answer`（`allowDir`）；随后这个用户会话里**所有 Agent** 挂着的、目标全部被覆盖的请求各自的结束事件（`by: 'dir'`；Ask each time 下还写工作路径里的调用不在内，（2026-10-27 注：负责人定）） | 这张卡和被覆盖的卡一起消失；权限菜单的列表多出 `Writes to <目录>`；之后任何 Agent 写这个目录里的文件都不出卡，标 `Allowed for this session`；写它的子目录仍出卡 | — |
| 选了按工具名放行 | 同 v0，只放行 `scope` 为 `inside` 的同名请求（`by: 'session'`） | 写到外面、受保护路径、分析不了的同名卡**还在** | — |
| 后台实例的卡 | `mori.team_approval_request` | 同上的原因行与第二个按钮；归属行在卡头上面（同 team-approvals.md） | 同上 |
| 界面重新载入（Ctrl+R） | `LiveSnapshot.approvals` / `teamApprovals` | 卡重新出现，原因行与第二个按钮照旧 | 照常选择 |
| 原因行里有不可见字符 | 路径或原文含 v0 列出的控制字符 | 换成 `⟨U+XXXX⟩`，并出现 v0 的不可见字符警示行 | — |

## 工具卡

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 按工具名或按目录放行 | `mori.tool_gate` 为 `session` / `dir`，或 `mori.approval_end` 的 `by` 为 `session` / `dir` | `Running…`，标 `Allowed for this session` | 展开 |
| Full access 放行 | `gate` 或 `by` 为 `full` | `Running…`，标 `Full access`（取代 v0 的 `Allow all`） | 展开 |
| 读取、按职责给的工具、写 `.work` | `gate` 为 `free` | `Running…`，没有标签 | 展开 |
| 不出卡就拒绝 | `gate` 为 `deny`，随后 `tool_execution_end`（`isError`，输出以 `DENIAL_PREFIXES` 之一开头） | `Denied · <原文>`（40 字截断加“…”，悬停看全文）；没有出现过 `Waiting for your approval` | 展开看完整原文 |
| 从会话记录载入的程序拒绝 | 工具结果 `isError` 且以 `DENIAL_PREFIXES` 之一开头 | 同上；没有放行标签（同 v0） | 同上 |
| 预告与实际不同 | 第二个 `mori.tool_gate`（[规格 §6.14](../../specs/file-system-permissions.md)） | 还在 `Waiting for your approval`、没有挂着的卡时变 `Running…` 并按新的 `gate` 标出（同 v0）；新的 `gate` 是 `ask` 时等随后的批准请求 | — |
| 预告放行、实际要批准 | 预告 `full` / `session` / `dir` 之后收到这次调用的 `mori.approval_request` | `Waiting for your approval`，预告时标上的放行标签去掉 | — |
| `.work` 建不起来 | 预告 `full` / `session` / `free`，随后 `tool_execution_end`（`isError`，输出以 `Mori couldn't prepare .work in the working directory` 开头，[规格 §7.10](../../specs/file-system-permissions.md)） | `Denied · Mori couldn't prepare .work…`（40 字截断加“…”，悬停看全文）；预告时标上的放行标签去掉，没有 `tool-badge` | 展开看完整原文（原因：`.work` 是文件、只读文件夹等） |
| mori-team、mori-memory 先拒绝 | 预告的 `gate` 之后 `tool_execution_end`（`isError`，输出是交接后、强制填写、记忆目录写保护或增强会话的拒绝原文，在 `DENIAL_PREFIXES` 里，[规格 §12](../../specs/file-system.md)） | `Denied · <原文>`（40 字截断加“…”，悬停看全文）；预告时标上的放行标签去掉（2026-10-27 注：负责人定） | 展开看完整原文 |

## F8 报告与操作记录

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| F8 报告 | 你按了 F8 | “Permission mode” 写 `Ask each time` 或 `Full access` | — |
| 操作记录 | 你的操作 | `Permission mode: Full access` / `Permission mode: Ask each time`；`Permission request: Allow writes to folders for this session`；`Forget “Allow for this session”: writes to <目录>`；其余同 v0 | — |

## 反例

- 读取工作路径外的文件不出卡（任何模式）。
- Full access 下写到工作路径外、写 `.git/config` 仍出卡。
- 写 `.work/` 下的文件在 Ask each time 下也不出卡；但 Ask each time 下的命令即使只写 `.work` 也出卡。
- 在 `Run commands` 已允许之后，写到外面的命令、分析不了的命令仍出卡。
- 分析不了的命令（例如引号没闭合）在 Full access 下也出卡，卡上没有按目录放行。
- 受保护路径的卡上没有第二个按钮，按 Alt+2 什么都不发生、不会放行。
- 放行 `D:\out\a` 之后，写 `D:\out\a\sub\x.log` 仍出卡。
- 切到 Full access 时，写到外面的卡不会被一起放行。
- 相对路径 `a/../b.md`（解析后在工作路径里）的卡上没有原因行。
- `cp a.txt .`（写进工作路径）不算删掉工作路径：Full access 下不出卡；`rm -rf .` 每次都出卡，原因行 `Protected path: <工作路径>`。
- 停止中排在后面的调用不出卡也不执行，写 `.work` 的也一样。
- 新会话不继承 Full access、已允许的工具名和目录。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：目录项排在工具名之后、写法 `Writes to <目录>`、悬停 `Forget “Writes to <目录>”`；原因行用警示色、每个目标一行、最多 5 行；
不能放行时不放第二个按钮（不放一个灰掉的按钮）。

## 需要规格回答

无。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 权限按钮 | `data-testid="permission-button"`（沿用）；Full access 时类名含 `full`（取代 `all`） |
| 权限菜单与列表 | `data-testid="permission-menu"`、`data-testid="permission-allowed"`（沿用）；列表项 `data-kind="tool"` / `data-kind="dir"`（本表定，临时） |
| 确认框 | `data-testid="confirm-dialog"`（沿用） |
| 批准卡 | `data-testid="approval-card"`（沿用），加 `data-scope`（`inside` / `outside` / `protected`） |
| 原因行 | `data-testid="approval-scope"`，`data-reason` 为 `outside` / `protected` / `unresolved` / `leaves` / `unanalyzed`；多出来的那一行 `data-testid="approval-scope-more"`（本表定，临时）；v0 的 `approval-outside` 去掉 |
| 第二个按钮 | `data-testid="approval-allow-session"`（沿用），加 `data-kind="tool"` / `data-kind="dir"`；没有这个选项时不渲染 |
| 工具卡标签 | `data-testid="tool-badge"`（沿用），文字 `Allowed for this session` / `Full access` |
