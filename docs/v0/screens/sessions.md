# 项目与会话（M3）

依据：方案 5.1（左栏）、5.3、第 4 节"会话保存、列表、打开、命名 / 会话归档与删除 / 项目信任"、第 6 节。
左栏的外框、宽度与收起见 [layout.md](layout.md)；会话面板见 [chat.md](chat.md)。
M3 交付里的"恢复"指打开已保存的会话（pi 的 resume），以及把归档的会话恢复回来。
2026-10-19 负责人决定：会话的保持打开、归档与删除、界面重新加载、重新打开时的工具、扩展的询问都照 Claude 桌面版的做法（见各节）。

## pi 1.3.0 的相关行为（开工前对照源码核查）

| 事实 | 影响 |
| --- | --- |
| `SessionManager.listAll()` 读 `<agentDir>/sessions/` 下一层文件夹里的会话文件，返回会话文件、id、工作目录、名字、第一条你的消息、最后活动时间（最后一条你的消息或助手回复的时间），按最后活动时间从新到旧排；没有你的消息时第一条消息是字面值 `(no messages)` | 侧栏的数据来源；改名、模型或思考设置的记录不改变顺序；`(no messages)` 当作没有（文字匹配，登记在 defaults.md） |
| `listAll()` 不报错：会话目录读不了时返回空列表，读不了或不是合法会话的文件直接略过 | 侧栏不会因为 pi 而显示"Couldn’t load sessions: …"；损坏的会话文件不出现、也没有提示（交付说明列出） |
| 新会话在 pi 记下第一条你的消息（role=user 的 `message_end`）时才写成文件；发送时就失败的消息（例如找不到 key）不会被记下 | 还没保存的新会话只在本次运行里出现在侧栏，重启后不在；它的草稿留在本机但不再显示 |
| 名字是会话文件里最后一条 `session_info` 记录；pi 本身不起名，扩展可以调用 `setSessionName`（也发 `session_info_changed`） | 没有名字时显示第一条消息的前 20 个字，不替你写名字 |
| 打开中的会话改名要经它自己的 `AgentSession.setSessionName`（会发 `session_info_changed`）；没打开的用 `SessionManager.open(文件).appendSessionInfo` 立即写入；还没保存的新会话的名字随第一条消息一起写出 | 后台进程按会话是否打开选择写法；会话正在打开时不能改名（见右键菜单），同一个文件不会有两个写入者 |
| pi 没有删除接口，也没有归档；pi 自己的会话选择器先找 `trash` 命令，找不到就直接删除文件（Windows 上通常是永久删除），并拒绝删除当前会话 | Mori 照 Claude 桌面版分成两个操作：归档（平常用，可以恢复；已归档列表由 Mori 记在本机）和删除（永久，先确认，主进程删除会话文件）；两者都先在后台进程里关闭这个会话，否则之后的写入会重新生成一个没有文件头的会话文件，见"归档与删除" |
| `AgentSession.dispose()` 不通知扩展；pi 自己替换会话时按"停止 → 向扩展发 `session_shutdown` → dispose"的顺序 | Mori 关闭会话（归档、删除前）和退出时照这个顺序做；`session_shutdown` 的原因用 `quit`（pi 没有"删除"这个原因，登记在 defaults.md） |
| `reload({ resolveProjectTrust })` 在加载项目扩展之前调用回调，回调只返回"是否信任"；传了回调每次都调用，不自己判断要不要问。pi 命令行的顺序（`core/project-trust.js`，没有导出）：没有要信任的内容 → 信任；扩展的 `project_trust` 事件；`trust.json` 里本文件夹或最近上层文件夹的记录；设置 `defaultProjectTrust`；否则问；本次运行里的回答记在进程里 | Mori 照这个顺序自己判断，不做 `project_trust` 事件和 `defaultProjectTrust`（登记在 defaults.md）；本次运行里的回答由界面记住 |
| 需要信任的内容：`.pi/` 下的 `settings.json`、`mcp.json`、`extensions`、`skills`、`prompts`、`themes`、`SYSTEM.md`、`APPEND_SYSTEM.md`（存在即算，空文件夹也算），或本文件夹及任一上层文件夹里的 `.agents/skills`（`~/.agents/skills` 除外）；单独一个 `.pi` 文件夹、AGENTS.md 都不算 | 询问只在这些情况出现；AGENTS.md 照常加载 |
| 不信任时项目的 `.pi/settings.json` 当作空的，项目扩展、技能、提示词都不加载；信任后才加载，项目扩展注册的工具自动可用 | "Don’t trust"后项目扩展注册的工具不出现；回答之前什么都不加载 |
| 打开已保存的会话时，pi 按会话记录里的系统消息恢复当时启用的工具（`_restoreToolsFromTranscript`） | 照 Claude Code 恢复会话的做法用当前的工具：重新打开时、绑定扩展之前，把现在注册了的扩展工具（不是内置工具、会直接给模型用的、扩展没有标成默认不启用的）加进启用的工具（pi 的 `setActiveToolsByName`）；所以不信任时保存的会话，信任之后重新打开也有项目扩展的工具 |
| 扩展在 SDK 下默认拿到的是空的界面上下文（`hasUI` 为假，确认、选择、输入直接返回空）；绑定扩展时可以传入自己的界面上下文 | Mori 把通知、确认、选择、输入转给界面（方案第 6 节第 3 件，从 M6 提前），见 [extension-ui.md](extension-ui.md)；pi 的 RPC 模式还转达的多行编辑器、状态栏、小部件、标题 v0 不做，页眉页脚、自定义组件等终端界面才有的也不做 |
| pi 的 `state.streamingMessage` 是正在生成的回复，`state.pendingToolCalls` 是正在执行的工具 | 界面重新加载后点开还在后台进程里的会话时，后台进程交出这一刻的样子，界面接着显示（见"后台进程退出与重新载入"） |
| `trust.json` 的读写会抛错（格式错误、加锁失败） | 读不出时按"没有记录"处理，照常询问并显示原文；写不进时这次的选择照样生效并显示原文 |

## 左栏

| 区域 | 内容 |
| --- | --- |
| 顶部 | "New session"主按钮（按钮上带"Ctrl+N"，读屏名称"New session (Ctrl+N)"）、"Open folder…"；后台进程已退出时两者都不可用，悬停说明"Mori’s background process crashed. Restart it to continue." |
| 中间 | 项目 → 会话树 |
| 底部 | "Report a UI issue (F8)"、"Settings"（M2 起） |

收起为图标栏时：展开、新会话、打开文件夹、报告界面问题、设置五个图标按钮；会话树不显示。
不在中栏显示的会话（包括界面重新加载后还没点开的会话）里有"Needs approval""Needs input""Error""Unread"时，
"Open sidebar"按钮上显示其中最要紧的那个的圆点（按这个顺序），悬停和读屏名称为"Open sidebar (a session needs approval)"等
（另外三种是"(a session needs input)"、"(a session has an error)"、"(a session has unread results)"）；
没有时是"Open sidebar"，展开时是"Close sidebar"。窄窗口下浮动展开的左栏里打开或切换会话后，左栏自动收起。

## 项目 → 会话树

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 正在读取 | 启动后 `session.list` 还没返回 | "Loading sessions…" | New session、Open folder… |
| 读取失败 | `session.list` 命令失败（后台进程没有回应；pi 自己不会报错） | "Couldn’t load sessions: "加原文；已有的列表保持显示 | "Retry" |
| 没有会话 | 列表为空，本次也没打开过文件夹（也可能是 pi 读不了会话目录，pi 不区分） | 不显示树；中栏只说"Choose a project folder to start a session." | New session、Open folder… |
| 有会话 | pi 的会话列表（`session.list` → `listAll()`），加上本次打开、还没保存的会话（协作模式：见 docs/specs/parallel-agents-taskboard.md §3、§14.5：实例会话存在 `<userData>/teams/<id>/sessions`，不进侧栏，也不算未保存的会话） | 按项目（会话的工作目录）分组：项目行显示文件夹名，悬停显示完整路径；项目下列出会话；当前会话高亮 | 点会话打开或切换；右键菜单；键盘见下 |
| 重新读取 | 改名没打开的会话、归档、删除、后台进程重新载入之后（界面重新加载后还没点开的会话的名字、排序、状态另随事件更新） | 旧的树保持显示，结果回来后整体替换，不回到"Loading sessions…"；正在改名的行不被打断 | — |
| 排序 | 会话的最后活动时间：pi 列表的 `modified`；本次运行里你发消息、以及你的消息或助手回复结束（`message_end`）的时间；新建会话的时间；取最新 | 项目按其中最新的会话排，会话在项目内从新到旧 | — |
| 项目里没有会话了 | 归档或删除了项目里最后一个会话 | 项目行一起消失（方案"本次打开的文件夹"也算项目；空项目行没有可做的操作，交付说明列出） | — |

会话行：

| 项 | 来源 | 必须可见 |
| --- | --- | --- |
| 会话名 | 名字（pi 的 `session_info`：列表里的 `name`、打开时的会话名、`session_info_changed` 事件）；没有名字时第一条你的消息（列表里的 `firstMessage`，或本次对话流里的第一条消息）的前 20 个字，超出加"…"；都没有时"New session" | 省略号截断，不换行；悬停显示完整的名字或第一条消息 |
| 状态 | 本次运行中打开过的会话，以及界面重新加载前就在后台进程里开着、还没点开的会话（见"界面重新加载"），见下表 | 圆点加文字，跟在会话名右边；侧栏窄于 220px 时只显示圆点（文字仍在读屏名称里，悬停圆点看文字），顶部"New session"也不再显示"Ctrl+N" |

顶栏的会话名、会话面板的读屏名称、F8 报告里的"Current session"与会话行同一来源、同一规则（取代 chat.md 顶栏"会话名"原来的写法）。

状态（同时满足时取排在前面的）：

| 文字 | 来源 | 消失于 |
| --- | --- | --- |
| Needs approval | 这个会话有挂起的批准请求（`mori.approval_request`）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.3、§13.6：后台实例的批准卡也算，没点开的会话用 `LiveStatus.teamApproval`） | 请求结束（`mori.approval_end`）；后台进程退出 |
| Needs input | 这个会话有挂起的扩展询问（`mori.ui_request`，见 extension-ui.md） | 询问结束（`mori.ui_end`）；后台进程退出 |
| Running | 本轮运行中（`agent_start` 到 `agent_settled`），或刚发出、还没开始（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.6：这个会话有任何 Agent 在运行、或有待判断的消息时也是，`TeamState.busy`，没点开的会话用 `LiveStatus.teamBusy`） | 本轮结束；后台进程退出 |
| Error | 新建或打开失败；本次运行里最近的一轮以错误结束（对话流最后一项是本次的错误卡）；后台进程意外退出时它正在生成 | 再发一条消息；重新打开成功 |
| Unread | 这个会话不在中栏显示（不在任一栏里，或中栏显示的是设置页；M5 起分屏的两栏都算显示）时本轮结束（`agent_settled`） | 它重新显示在中栏（点它、Enter，或设置页"Back to app"）；不跨重启保存 |

界面重新加载后还没点开的会话：状态先取 `session.list` 带回的 `live`，之后按后台进程转发的事件更新（`agent_start` /
`agent_settled`、批准请求和扩展询问的开始与结束）；本轮结束时标"Unread"，后台进程意外退出时它在生成就标"Error"，
点开后改按对话流判断。同一个会话同时挂着几个扩展询问时，结束一个就当作都没有了（交付说明列出）。

### 键盘

- 整棵树只占一个 Tab 停靠点：从别处 Tab / Shift+Tab 进来时焦点落在当前会话行（没有时落在第一行）。
- ↑ ↓ 在会话行之间移动焦点（跨项目，不打开会话）；Home / End 到第一行和最后一行。
- Enter 或 Space 打开或切换这个会话，焦点进入它的输入框。点会话行也一样。
- 菜单键或 Shift+F10 打开右键菜单。
- 走查 2 的路径：Ctrl+N（焦点在新会话的输入框）→ Shift+Tab 几次回到会话树（依次经过顶栏的右栏开关、左栏分隔线、
  左栏底部的"Settings"和"Report a UI issue (F8)"，第 5 次落在新会话行；2026-10-21 起权限、模型和 Effort 按钮在输入框下面一行、
  文字框之后，不在这条路上，原来是第 8 次，[models.md](models.md)）→ Shift+F10 → Enter（"Rename"）→ 输入 → Enter。
- 焦点在会话树上按 Esc 不停止生成（方案 5.8：焦点在会话里才停止）。

## 打开、新建与切换

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 中栏没有会话 | 启动后还没点开会话；或当前会话被删除 | "Open a folder"、"Open folder…"；侧栏有会话时说明"Pick a session on the left to continue, or open a folder to start a new session."（取代 connection.md"等你选文件夹"里"已有连接"的情况；首次启动测试成功后仍用 connection.md 的文字） | Open folder…；点左侧会话；Ctrl+N |
| 打开文件夹 | 你在系统对话框里选了文件夹 | 新会话出现在该项目下（名为"New session"）并成为当前会话，按钮位置"Starting…"；需要时先弹信任询问（见下） | 输入 |
| 新会话（Ctrl+N 或"New session"） | 你的操作 | 在当前会话所在的项目里新建一个会话并切过去，焦点在输入框；没有当前会话时等于"Open folder…"；在设置页按时也回到会话面板 | 输入 |
| Ctrl+N 不起作用 | 首次启动页；按住不放的重复按键；上一个新会话还在"Starting…"；有菜单、对话框、信任询问、改名框或 F8 报告框开着（包括窄窗口下浮动展开的左栏、输入框下面一行的权限、范围、Effort 菜单和"Queue"的下拉；上下文用量的详情不算）；后台进程已退出 | 什么都不发生 | — |
| 打开已保存的会话 | 你点了一个本次还没打开的会话：`session.open`（会话文件） | 中栏立刻切到这个会话，按钮位置"Starting…"，顶栏先显示列表里的会话名，输入框下面一行还没有范围按钮、Effort 和上下文用量；打开后按 pi 记录的当前分支显示完整对话（先显示最近 50 条），输入框下面一行显示范围按钮、Effort 和上下文用量 | 继续对话 |
| 正在打开时再点 | 同一个会话行 | 只切过去，不再发 `session.open` | — |
| 新建或打开失败 | `session.create` / `session.open` / `trust.check` 报错（项目文件夹已不存在、会话文件已不存在、后台进程已退出等） | 横幅"Failed to open session: "加原文（后台进程已退出时显示退出横幅和"Restart"）；会话行状态"Error" | 再点这个会话重试；点别的会话；Delete… |
| 切换 | 你点了一个本次已打开的会话 | 直接切换；对话流的滚动位置、草稿、批准卡都还在 | — |

本次运行里打开过的会话一直保持打开（在后台进程里），直到归档、删除或退出 Mori，所以生成中的会话切走后照常进行，
"Allow for this session"的选择和权限也保留，界面重新加载也不停。这是负责人 2026-10-19 决定照 Claude 桌面版的做法（会话不因不在屏幕上
而停），方案第 6 节"会话与数据"已按此改写（原来写"不可见且不在生成就释放"）；代价是打开过的会话在本次运行里一直占着内存
（M6 接入 MCP 后还有每个会话各自的连接）。

## 右键菜单

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开 | 在会话行上右键（贴着鼠标位置）；焦点在会话行上按菜单键或 Shift+F10（贴着会话行下方）。右键不切换当前会话 | 菜单（读屏名称"Session actions"）：Rename、Attach as context、Open in split view（M5）、Archive、Delete…；焦点在第一个可用的菜单项 | ↑ ↓ 选择、Enter 执行；Esc、Tab 或点别处关闭，焦点回到会话行 |
| 正在生成的会话 | 会话行状态为"Running""Needs approval"或"Needs input"（包括界面重新加载后还在后台进程里生成的会话）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.5：只有后台 Agent 在运行、或有待判断的消息时同样，后台进程的 `session.close` 也拒绝） | "Archive""Delete…"不可用，旁边小字"Still running" | Rename |
| 正在打开的会话 | 会话还在打开（按钮位置"Starting…"） | "Rename""Archive""Delete…"三项都不可用，旁边小字"Opening…" | — |
| 还没保存的新会话 | 会话还没有消息 | "Archive"不可用，旁边小字"No messages yet" | Rename、Delete… |
| 已归档的会话 | 在"Archived"列表里的会话行上打开菜单 | 菜单：Unarchive、Delete… | 同上 |

M5 起菜单是：Rename、Attach as context、Open in split view、Archive、Delete…（已归档的会话仍是 Unarchive、Delete…）；分屏标题行上的会话名有同一菜单。
"Attach as context"不可用的情况见 [session-refs.md](session-refs.md)；"Open in split view"在这一行就是单栏里显示的会话时不可用
（旁边小字"Already open"），已在某一栏时只把焦点切过去，见 [split.md](split.md)。删除、归档分屏中的会话时这一栏关闭；指向它的引用显示"Session deleted"。

## 重命名

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 编辑中 | 你在右键菜单选了"Rename" | 会话行变成输入框并全选：有名字时填名字；没有名字时填第一条消息的前 20 个字（不带"…"） | Enter 保存；Esc 取消（不停止生成，也不关闭浮动的左栏）；在框外按下鼠标或按 Tab 等于保存；输入法组字时 Enter 只选词、Esc 只取消组字 |
| 不结束编辑 | 窗口失去焦点、F8 报告框打开、信任询问弹出 | 回来后继续编辑 | — |
| 名字没变或为空 | 你保存时，名字与预先填的相同或为空 | 退出编辑，什么都不写（起过名字后不能清除，交付说明列出） | — |
| 保存中 | `session.rename`：打开中的会话用 pi 的 `setSessionName`，没打开的写进它的会话文件 | 输入框不可编辑 | — |
| 已改名 | 打开中的会话：命令结果和 pi `session_info_changed`；没打开的：命令结果，随后重新读取列表 | 侧栏和顶栏显示新名字；重启后仍是新名字 | — |
| 改名失败 | `session.rename` 报错（例如后台进程已退出） | 输入框下"Couldn’t rename this session: "加原文，输入框保留你写的名字 | 再按 Enter 重试；Esc 或点别处放弃 |

焦点：Enter 保存成功、名字没变、Esc 取消 → 回到这个会话行；在框外按下鼠标 → 留在你点的地方；Tab → 下一个控件；失败 → 留在输入框。

还没发消息的新会话也可以改名：名字随第一条消息一起保存；没发消息就退出时，这个会话连同名字都不保留（pi 的做法）。
还没保存的会话在后台进程重新载入后是一个新会话，改过的名字不保留（交付说明列出）。

## 归档与删除

照 Claude 桌面版：归档是平常用的操作，可以恢复；删除是永久的，先确认。会话在生成时两者都不能用（Claude 同样不归档、不删除正在工作的会话）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 归档 | 你在右键菜单选了"Archive"：后台进程里开着的会话（本次打开过的，或界面重新加载前就开着的）先关闭（`session.close`：停止 → 通知扩展 → 释放），再把会话文件记进本机的已归档列表（`localStorage` 的 `mori.archived`） | 不确认；会话行从项目下移到侧栏底部的"Archived"（项目里只剩它时项目行一起消失）；如果它是当前会话，中栏回到"Open a folder"；焦点移到屏幕上排在它下面的会话行（没有时上一行；收起的"Archived"里的不算）；草稿保留 | — |
| 归档失败 | `session.close` 报错 | 侧栏里一行"Couldn’t archive this session: "加原文，会话不变 | 再试 |
| 已归档列表 | 本机的已归档列表里、pi 会话列表里也有的会话 | 侧栏底部一行"Archived N"（默认收起）；展开后列出这些会话，每行是会话名，悬停显示文件夹和完整名字 | 展开、收起；点一个已归档的会话：恢复并打开；右键：Unarchive、Delete… |
| 恢复 | 你选了"Unarchive"，或点了已归档的会话 | 回到它的项目下，按最后活动排序；点的是会话行时同时打开它 | — |
| 删除确认 | 你在右键菜单选了"Delete…" | 对话框"Delete “<会话名>”?"，说明"This session will be permanently deleted. This can’t be undone."；按钮"Delete"（危险色）和"Cancel"，焦点在"Cancel"，Tab 只在两个按钮之间切换 | Delete；Cancel 或 Esc |
| 还没保存的新会话 | 会话还没有消息 | 说明改为"This session has no messages yet." | 同上 |
| 删除中 | 你点了"Delete"：后台进程里开着的会话先关闭（同上）；没开着或打开失败的跳过这一步；再由主进程删除会话文件（只接受 `<agentDir>\sessions` 里的 `.jsonl`；还没保存的新会话没有文件可删）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.5：删除会话文件之后，按它第一行里的 id 一并永久删除 `<userData>/teams/<id>/`；归档不动它；`session.close` 同时关闭全部实例会话） | "Deleting…"，两个按钮不可用；Esc 不起作用 | — |
| 已删除 | 各自需要的步骤都成功；然后重新读取列表 | 对话框关闭，会话行消失（也从已归档列表去掉）；如果它是当前会话，中栏回到"Open a folder"；焦点移到屏幕上排在它下面的会话行（没有时上一行，收起的"Archived"里的不算；再没有时"New session"）；草稿一起删除；重启后不再出现 | — |
| 关闭失败 | `session.close` 报错 | 对话框里"Couldn’t delete this session: "加原文；什么都没变 | 再点"Delete"重试；Cancel（焦点回到会话行） |
| 已关闭、删除文件失败 | 主进程删除文件报错；主进程把原文交回界面 | 对话框里"Couldn’t delete this session: "加原文；文件还在；会话已经关闭，变回没打开的会话（再点它会重新打开，"Allow for this session"的选择和权限回到"Ask each time"） | 再点"Delete"重试；Cancel |
| 正在生成 | 会话在生成、等你批准或等你回答 | 菜单里"Archive""Delete…"不可用 | 先停止 |

方案第 4 节原来写"把会话文件移到回收站"，5.3 写"对话记录会移到回收站"；2026-10-19 负责人决定照 Claude 桌面版改为归档 + 永久删除。
Claude 的归档和删除还会清理会话的 git worktree，Mori 没有 worktree，不涉及。

## 项目信任

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 本次回答过 | 界面记下的你本次运行里对这个文件夹的回答（只记"Trust workspace"或"Don’t trust"，"没有要信任的内容"不记；后台进程重新载入后还在） | 不弹窗，直接带上这个回答打开 | — |
| 不用问 | `trust.check`：文件夹没有要信任的内容，或 `trust.json` 有本文件夹或上层文件夹的记录 | 不弹窗，直接打开 | — |
| 询问 | `trust.check` 说要问；在新建或打开这个文件夹里的会话之前（中栏已切到这个会话，显示"Starting…"） | 对话框"Trust this workspace?"，说明"This workspace has its own extensions or settings. If you trust it, they’ll run on your computer."、完整路径、复选框"Remember my choice"（默认不勾）；按钮"Trust workspace"和"Don’t trust"，焦点在"Don’t trust"；Tab 只在复选框和两个按钮之间切换；回答之前项目自带的扩展一个都不加载 | Trust workspace；Don’t trust；Esc 等于"Don’t trust"（不记住）。回答后焦点进这个会话的输入框 |
| 读不出已记住的选择 | `trust.check` 时 pi 读 `trust.json` 报错 | 照常询问，询问框里"Couldn’t check whether this workspace is trusted: "加原文 | 同上 |
| 排队 | 同一个文件夹同时要问 | 只问一次；不同文件夹的询问排队，一次显示一个 | — |
| 已回答 | 你的选择随 `session.create` / `session.open` 的 `trust` 交给后台进程，由 pi 的 `resolveProjectTrust` 生效；勾了"Remember my choice"时写进 pi 的 `trust.json` | 打开会话；本次运行里同一文件夹不再问；勾了"Remember my choice"后重启也不再问 | — |
| 信任 | 会话信息里的 `projectTrust` 为 `trusted` | 项目扩展注册的工具可以用：让模型调用它时出批准卡，标题为工具原名（approval.md"其他工具"）；不信任时保存的会话信任后重新打开也有它（Mori 重新打开时用当前的工具，见上表） | — |
| 不信任 | `projectTrust` 为 `untrusted` | 顶栏下横幅"This workspace isn’t trusted, so its extensions and settings weren’t loaded"，" · "后面说明怎样改回：这次没勾"Remember my choice"（或记住失败）时"You’ll be asked again after you restart Mori"；这次勾了"Remember my choice"或来自原有的记录时"To change your remembered choice, delete this workspace’s entry from <agentDir>\trust.json and reopen the session"（v0 没有改回的界面）。项目扩展注册的工具不出现：问模型能用哪些工具时没有它，让它调用时它说没有这个工具，也不会出批准卡（界面测试断言会话信息的 `tools` 里没有它） | — |
| 问过之后才出现要信任的内容 | `trust.check` 说不用问，之后文件夹里才出现要信任的内容；后台进程在 `resolveProjectTrust` 里再判断时发现没有回答（`projectTrust` 为 `unasked`） | 按不信任打开；横幅"This workspace now has its own extensions or settings, which weren’t loaded this time · You’ll be asked when you start a new session" | 新建会话时会问 |
| 记住失败 | 写 `trust.json` 报错 | 横幅"Couldn’t save trust settings: "加原文；这次的选择照样生效 | — |
| 检查失败 | `trust.check` 报错 | 见"新建或打开失败"，不打开会话 | 重试 |

与方案第 6 节的不同：方案写的是在 `resolveProjectTrust` 回调里需要时再弹窗；实现改为界面先用 `trust.check` 判断要不要问，
回答随 `session.create` / `session.open` 带给后台进程，后台进程在回调里按同样顺序再判断一次（没有回答就不加载）。
这样询问不必在后台进程里挂起等待，后台进程退出时也不会卡住打开。

反例：打开带 `.pi/extensions` 的文件夹，在你回答之前、选"Don’t trust"、按 Esc、检查失败、检查之后才出现 `.pi/` 时，
项目扩展都不加载（它的代码不会运行）。

## 有扩展没有加载

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有扩展没有加载 | `session.create` / `session.open` 返回值里的 `extensionErrors`（pi 的 `extensionsResult.errors`：用户级和项目级扩展的加载错误、工具名冲突；批准扩展的错误另行处理，会话不打开） | 会话横幅"Some extensions didn’t load:"加路径和原文 | — |

## 草稿

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有草稿 | 你在输入框里写的字，按会话文件存在本机（`localStorage`） | 切换会话、去设置页再回来、重启后打开这个会话，输入框里都是原来的字（走查 6 用发过消息的会话） | 继续写；发送后清空 |
| 重新载入、会话还没保存过 | chat.md"会话还没保存过"新建了会话 | 输入框里的字不变，之后存在新会话文件下 | 继续写 |
| 还没保存的新会话 | 会话文件还不存在 | 本次运行里切换、去设置页再回来都在；重启后会话不在，草稿也不再显示（与方案 5.3 的差异，交付说明列出） | — |
| 会话被删除 | 你删除了会话 | 草稿一起删除 | — |

M4 起输入框里的引用芯片也按会话文件存在本机（`localStorage` 的 `mori.draftRefs`，见 [selection.md](selection.md)），与文字草稿一起切换、恢复，会话删除时一起删除。不按会话列表清理草稿（pi 读不出会话目录时列表为空，按它清理会误删全部草稿）。

## 后台进程退出与重新载入（补充 chat.md）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 意外退出 | 主进程的退出通知 | 会话行的"Running""Needs approval""Needs input"消失；退出时正在生成的会话（包括界面重新加载后还没点开的）显示"Error"；会话树保持原样；"New session""Open folder…"不可用 | 切换已打开的会话；点没打开的会话（中栏显示退出横幅，重新载入后自动打开它）；Restart |
| 重新载入 | 你点了"Restart" | 重新读取会话列表（旧的树保持显示）；打开过的会话照 chat.md 的做法重新打开，信任沿用本次的回答；会话名从会话文件恢复；"Error"在重新打开成功后消失 | — |
| 界面重新加载 | 页面重新加载（例如 Electron 默认菜单的 Ctrl+R）：界面状态清空；后台进程里的会话照常运行（照 Claude 桌面版：会话不因窗口而停，只有停止、归档、删除或退出才停） | 重新读取会话列表；后台进程里打开着的会话在侧栏显示状态（`session.list` 带回的 `live`：Running、Needs approval、Needs input），之后随事件更新（见"状态"）；本次新建、还没发消息的会话也列出（后台进程把它补进列表，名为"New session"）；草稿还在（存在本机）；"Allow for this session"的选择和权限还在（会话没停）；本次运行里信任询问的回答清空，新打开的文件夹会再问 | 点会话接上 |
| 接上后台进程里的会话 | 你点了一个还在后台进程里的会话：`session.open` 返回它这一刻的样子（已经写进会话文件的对话、`live`：是否在生成、正在生成的回复、正在执行的工具、挂着的批准请求和扩展询问、排队区）（协作模式：见 docs/specs/parallel-agents-taskboard.md §11.6、§13.10：另带协作模式、TaskBoard 视图、待判断的消息和挂起的后台批准卡，后台实例照常运行） | 不问信任；对话流显示到这一刻，正在生成的回复接着流入，正在执行的工具卡是"Running…"，挂着的批准卡和扩展询问照常出现；阶段行按这一刻定（模型还没开始回复时"Waiting for the model…"，只有思考时"Thinking…"）；之后的事件照常接着显示。扩展的通知不在会话记录里，界面重新加载前显示过的不再显示 | 照常操作 |

chat.md"会话还没保存过"的判断改为：这个会话没有你的消息（本次运行里没发过，会话列表里也没有它的第一条消息），且会话文件不存在。
保存过的会话文件不在时（例如被外部删掉）显示"Failed to open session: "加原文，不再换成一个空会话。

## Esc 与浮层

会话菜单、改名框、删除确认框、信任询问都是浮层（扩展的询问卡不是浮层，与批准卡相同）：Esc 按方案 5.8 的顺序先关最上层的那个（信任询问的 Esc 等于"Don’t trust"，
删除中的确认框不关）。它们开着时 Alt+1 / Alt+2 / Alt+3 和 Ctrl+N 不起作用。

## 后台与主进程做的事（方案对应）

| 做的事 | 方案 |
| --- | --- |
| `session.list`（`listAll`）、`session.rename`（`setSessionName` / `appendSessionInfo`）、`session.open` | 第 4 节"会话保存、列表、打开、命名"（pi）；第 6 节第 1 件 |
| `session.close`（停止 → `session_shutdown` → 释放） | 第 6 节"会话与数据"的释放；第 4 节"会话归档与删除" |
| `session.open` 对还开着的会话交出这一刻的样子、`session.list` 带回 `live`、补上还没写成文件的打开着的会话 | 第 6 节第 1、2 件（打开会话、转发事件）：界面重新加载后接着显示，事件仍原样转发 |
| 把扩展的通知、确认、选择、输入转给界面（`mori.ui_request` / `ui.answer`） | 第 6 节第 3 件"pi 扩展的界面请求" |
| `trust.check`、`session.create` / `session.open` 带 `trust`、写 `trust.json`（`ProjectTrustStore`） | 第 4 节"项目信任"；第 6 节 trust.ts（与回调内弹窗的不同见上） |
| 主进程删除会话文件（只接受 `<agentDir>\sessions` 里的 `.jsonl`） | 第 4 节"会话归档与删除"（Mori），照 Claude 为永久删除 |
| 已归档列表存 `localStorage` | 第 6 节"Mori 自己只保存：界面状态"（会话内容仍只有 pi 的会话文件一份） |
| 草稿存 `localStorage` | 第 6 节"Mori 自己只保存：界面状态（……各会话草稿）" |
| 打开过的会话保持打开 | 第 6 节"会话与数据"（2026-10-19 改为照 Claude 桌面版） |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 会话树 | `data-testid="session-tree"`（`role="tree"`）；项目 `.project-group[data-cwd]`；会话行 `.session-item[data-file]`（`role="treeitem"`，`data-row` 为行标识；还没保存的新会话也有路径） |
| 新会话按钮 | `data-testid="new-session"` |
| 会话状态 | 会话行里的 `[data-testid="session-status"]`，`data-status` 为 `approval` / `question` / `running` / `error` / `unseen`；图标栏上的 `[data-testid="rail-status"]` |
| 右键菜单 | `data-testid="session-menu"`，菜单项 `role="menuitem"` |
| 改名输入框 | `data-testid="rename-input"`；错误 `data-testid="rename-error"` |
| 删除确认框 | `data-testid="delete-dialog"` |
| 已归档 | 侧栏底部 `data-testid="archived-toggle"`（"Archived N"）；展开后 `data-testid="archived-list"`，行是 `.session-item.archived` |
| 信任询问 | `data-testid="trust-dialog"`，路径 `data-testid="trust-path"` |
| 会话横幅 | `data-testid="trust-banner"`、`data-testid="extension-errors"` |
