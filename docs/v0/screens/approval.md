# 批准（M2）

依据：方案 5.5、5.6、5.7、5.8，第 6 节"最小批准扩展"。工具卡的其余状态见 [tool-cards.md](tool-cards.md)，
阶段行与停止见 [chat.md](chat.md)。

## 哪些调用要批准

| 权限 | 工具 | 结果 |
| --- | --- | --- |
| 每次询问（新会话的默认值） | `read`、`grep`、`find`、`ls`（只读，放行名单是常量） | 直接执行，不出卡，没有标签 |
| 每次询问 | 本会话已允许的工具名 | 直接执行，卡上标"Allowed for this session" |
| 每次询问 | 其余所有工具：命令（`bash`、`powershell`）、`edit`、`write`、MCP 工具、插件和项目扩展注册的工具 | 出批准卡，等你选择 |
| 全部允许 | 只读工具 | 直接执行，不出卡，没有标签 |
| 全部允许 | 其余所有工具 | 直接执行，卡上标"Allow all" |

同一条回复里的多个调用逐张出卡：Mori 让 pi 按顺序执行一条回复里的工具调用（`toolExecution: "sequential"`，
临时默认值，见 defaults.md），上一张卡的工具执行完，下一个调用才开始，才出下一张卡。

## 来源（后台进程的批准扩展）

| 事件 / 命令 | 何时 | 内容 |
| --- | --- | --- |
| `mori.tool_gate`（事件） | pi 的 `tool_execution_start` 转发给界面之前，紧挨着它；批准处理器后来的决定与它不同（预告要批准，实际已不用批准，例如扩展里排队的嵌套调用在你选了"Allow “…” for this session"之后才轮到）时再发一次更正 | 这次调用会怎样处理：`ask` 要批准、`session` 本会话已允许、`all` 全部允许、`free` 只读工具 |
| `mori.approval_request`（事件） | pi 调用扩展的 `tool_call` 处理器，且需要批准 | 请求 id、调用 id、工具名、完整参数 |
| `mori.approval_end`（事件） | 请求得到答复 | 允许或拒绝；由谁决定：你、"Allow “…” for this session"、切到"Allow all"、你按了停止、会话结束；拒绝理由 |
| `approval.answer`（命令） | 你在卡上选择 | 允许一次 / 本会话不再询问此工具 / 拒绝（可带理由） |
| `approval.setMode`（命令） | 你在权限菜单里切换 | 每次询问 / 全部允许 |
| `approval.forget`（命令） | 你在权限菜单里清除（"Forget"）一项"Allowed for this session" | 工具名 |

拒绝时，扩展返回 `{ block: true, reason }`，pi 把 reason 原样作为工具结果回给模型。reason 的固定写法
（临时默认值，见 defaults.md；从会话记录载入时按它认出已拒绝，工具卡显示"Denied"）：

| 情况 | 回给模型的工具结果 | 工具卡 |
| --- | --- | --- |
| 你拒绝，没写理由 | `Rejected by the user.` | Denied |
| 你拒绝并写了理由 | `Rejected by the user. Reason: <理由>` | Denied · <理由> |
| 你按了停止（Esc 或"Stop"按钮） | `Rejected: the user stopped the run.` | Denied · You pressed Stop |

"Allow “…” for this session"的选择和权限只存在后台进程的内存里：后台进程重新载入（Restart）后都回到"Ask each time"，界面在对话流里明说（M1 已有这行）。

## 批准卡

批准卡停靠在输入框上方（排队区之上），不在对话流里滚走；对话流里的工具卡同时显示"Waiting for your approval"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 修改（`edit`） | `mori.approval_request`，工具名 `edit` | 标题"Edit `路径`"（长路径折行，不截断）；单独一行完整路径；每处替换的原文和新文（取自参数 `edits`），原文标红、新文标绿，超长时卡内滚动 | 见下"选项" |
| 写入（`write`） | 同上，工具名 `write` | 标题"Write `路径`"；单独一行完整路径；将写入的完整内容 | 同上 |
| 路径在项目文件夹之外 | 修改或写入的路径是会话文件夹之外的绝对路径，或含有 `..` | 警示一行"This file is outside the working directory" | 同上 |
| 内容里有不可见的控制字符 | 卡上要显示的文字含双向文字控制符或零宽字符（U+200B–U+200F、U+202A–U+202E、U+2060–U+2064、U+2066–U+2069、U+FEFF） | 这些字符换成可见的"⟨U+202E⟩"，并警示一行"Contains hidden characters, shown as ⟨U+XXXX⟩"（防止显示顺序与实际执行的不同） | 同上 |
| 命令（`bash` / `powershell`） | 同上 | 标题"Run a command"；完整命令行（多行原样显示）；有超时参数时显示"Timeout: Ns" | 同上 |
| MCP 工具 | 同上，工具名 `mcp__<服务>__<工具>` | 标题"<服务> · <工具>"；格式化后的参数 | 同上 |
| 其他工具 | 同上 | 标题为工具原名；格式化后的参数 | 同上 |
| 还有别的卡排在后面 | 同一会话同时有多个请求（例如扩展里嵌套调用） | 卡头"N more" | 处理完当前这张，下一张接着出现 |

### 选项

| 选项 | 键盘 | 结果 |
| --- | --- | --- |
| 允许一次（Allow once） | Alt+1 | 只放行这一次；工具卡变"Running…" |
| 本会话不再询问（"Allow “Run commands” for this session"，按工具名：Run commands / Edit files / Write files / `<服务> · <工具>` / 原名） | Alt+2 | 放行这一次，并记住工具名；命令类下方小字"You won’t be asked again for any command in this session."，其他类"You won’t be asked again for “Edit files” in this session."；排在后面的同名请求一起放行 |
| 拒绝（Deny） | Alt+3；或在理由框里按 Enter | 不执行；理由框（占位文字"Tell the model why (optional)"）里的文字作为理由；工具卡变"Denied · <理由>" |

- 卡片出现时不抢焦点：焦点留在输入框，继续打字不受影响；没有默认按钮，在输入框里按 Enter 仍是发送 / 排队，不会批准。
- Tab 可以走到卡上的按钮和理由框；Alt+1 / Alt+2 / Alt+3（数字键区的数字不算）在焦点位于这个会话面板内任何位置（包括输入框）时都有效；
  有菜单、对话框或 F8 报告框开着时不起作用（M3 起还有会话的右键菜单、改名框、删除确认框、信任询问）。
- 焦点在卡片上（按钮或理由框）时按 Esc：有开着的浮层（"Queue"的下拉、权限菜单等）时先关闭它，卡不变；
  没有浮层时等于拒绝这张卡（带上理由框里的文字），生成继续，模型会收到拒绝。
- 焦点不在卡片上（例如在输入框）时按 Esc：停止生成（方案 5.8 的顺序：先把排队消息放回输入框，再停止），
  挂起的卡按拒绝处理，工具卡显示"Denied · You pressed Stop"。点"Stop"按钮同样处理。
- 卡片处理完后（允许或拒绝）卡片消失；焦点如果在卡上，回到输入框。

## 工具卡与阶段行（M2 起）

| 状态 | 来源 | 工具卡 | 阶段行 |
| --- | --- | --- | --- |
| 等你批准 | `mori.tool_gate` 为 `ask`，随后的 `tool_execution_start`（pi 先发它，再调用批准处理器） | "Waiting for your approval" | "Waiting for your approval"（不显示"Responding…"或"<标题> Ns"） |
| 已允许、执行中 | `mori.approval_end` 为允许 | "Running… Ns"，从允许的那一刻计时 | "Run npm test 8s" 等 |
| 自动放行、执行中 | `mori.tool_gate` 为 `session` / `all` / `free`，随后的 `tool_execution_start` | "Running… Ns"；`session` 标"Allowed for this session"，`all` 标"Allow all" | 同上 |
| 预告要批准、实际不用批准 | 第二个 `mori.tool_gate`（更正，见上表） | "Running… Ns"，标出放行原因 | 同"自动放行"那一行 |
| 等待执行 | 回复已结束，前面的调用还在等批准或执行中（`toolExecution: "sequential"`） | "Queued" | 显示前面那个调用的阶段 |
| 已拒绝 | `mori.approval_end` 为拒绝 | "Denied"、"Denied · <理由>"或"Denied · You pressed Stop"；之后 pi 的 `tool_execution_end`（`isError`）不改变它 | 回到"Waiting for the model… Ns"（模型收到拒绝后再回复） |
| 从会话记录载入 | 工具结果 `isError` 且以上表的固定写法开头 | 同"已拒绝"那一行 | — |

"Allowed for this session"和"Allow all"标签只在实时运行时显示；从会话记录载入的工具卡不显示（pi 的记录里没有这个信息）。

## 权限菜单（顶栏）

M6 起会话面板窄于 600px 时，权限菜单与模型、思考菜单一样从面板右边缘弹出、不超出这一栏（见 [models.md](models.md)"窄栏"）。
顶栏按钮在会话面板 760px 以下去掉盾牌图标；400px 以下只显示盾牌图标（"Allow all" 仍用警示色），模式名放进读屏名
"Permission mode: Ask each time"；悬停说明总是"Set the permission mode for this session"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 每次询问 | 新会话、重新载入后；或你切回来 | 顶栏按钮"Ask each time" | 打开菜单 |
| 全部允许 | 你确认切换后 | 顶栏按钮"Allow all"，用警示色 | 打开菜单 |
| 菜单打开 | 你点了按钮 | 两个选项"Ask each time""Allow all"，当前项打勾；"Allowed for this session:"及其列表（Run commands、Write files……，没有时"None"），每项一个"Forget"；底部说明"Applies to this session only. New sessions start with “Ask each time”." | 选择；清除一项（Forget）；Esc 关闭菜单 |
| 确认切到全部允许 | 你在菜单里选了"Allow all" | 对话框："Switch to “Allow all”?"和"Edits, writes, and commands will run without asking."，按钮"Allow all"和"Cancel"，焦点在"Cancel" | Allow all；Cancel（Esc） |
| 切换时有挂起的卡 | 同上，确认后 | 挂起的卡按允许处理（`mori.approval_end`，由"Allow all"决定），工具卡标"Allow all" | — |

切回"Ask each time"不需要确认；之后需要批准的调用又出卡。"Allowed for this session:"的列表在切到"Allow all"时保留，切回后仍然有效。

## 任务栏闪烁

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 窗口不在前台时出现批准卡 | `mori.approval_request`，且 Mori 窗口没有焦点 | 任务栏上的 Mori 按钮闪烁（`BrowserWindow.flashFrame(true)`） | 切回 Mori |
| 切回 Mori | 窗口获得焦点 | 停止闪烁 | — |

反例：读取文件不出卡；等批准时阶段行显示"Waiting for your approval"，不显示"Responding…"或"<标题> Ns"；在输入框里按 Enter 不会批准；
新会话不继承别的会话的"Allowed for this session"和"Allow all"。
