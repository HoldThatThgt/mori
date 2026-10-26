# 屏幕状态表

每屏一张状态表：状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作。实现该屏之前写好，实现与测试都以它为准。
"来源"只能是 pi 的事件、pi SDK 的返回值、批准扩展的请求（M2 起）、主进程的系统操作结果（M3 起：删除会话文件；M4 起：读文件、用系统程序打开、写剪贴板、保存反馈；M7 起：读反馈和界面问题的文件、保存导出文件），pi 的配置文件（M6 起：后台进程读写 `models.json`、`settings.json`、`mcp.json`、`AGENTS.md`），2026-10-26 起还有主进程的窗口、托盘、单实例与退出事件和界面报告的正在生成的会话数（[window.md](window.md)），或你刚做的操作；没有来源的状态不显示。

| 文件 | 内容 | 里程碑 |
| --- | --- | --- |
| [connection.md](connection.md) | 首次启动、连接表单（也是"Settings → Connections and models"和"Go to settings"的落点）、打开文件夹 | M1 |
| [layout.md](layout.md) | 三栏布局、分隔线、窄窗口、侧栏、右栏、设置页外框 | M1 |
| [chat.md](chat.md) | 顶栏、对话流、阶段行、排队区、输入框和它下面一行、停止、错误、后台进程退出 | M1 |
| [tool-cards.md](tool-cards.md) | 工具卡状态与标题对照表 | M1（批准相关状态在 M2 接通） |
| [approval.md](approval.md) | 哪些调用要批准、批准卡、工具卡与阶段行的批准状态、权限菜单、任务栏闪烁 | M2 |
| [f8.md](f8.md) | F8 报告界面问题（Report a UI issue）：入口、报告框、保存的内容 | M2 |
| [sessions.md](sessions.md) | 左栏的项目 → 会话树、新建、打开、改名、删除、右键菜单、状态、草稿、项目信任询问 | M3 |
| [extension-ui.md](extension-ui.md) | 扩展的询问（确认、选择、输入）与通知 | M3（从 M6 提前） |
| [changes.md](changes.md) | 右栏：改动列表、文件阅读器、打开阅读器的入口 | M4 |
| [selection.md](selection.md) | 选区浮层、引用（Attach as context）的芯片与回到原位置、反馈、回复下的操作 | M4 |
| [split.md](split.md) | 左右分屏：拖会话到中栏、焦点所在的一栏、分屏中线、右栏跟随焦点与收起、关闭一栏 | M5 |
| [session-refs.md](session-refs.md) | 会话引用：拖会话进输入框、按轮预览与调整范围、发出后跳回原会话、原会话已删除 | M5 |
| [settings.md](settings.md) | 设置页：连接与多个模型、默认模型、支持思考与新会话默认的思考强度（Effort）、用户级 AGENTS.md、离开时有未保存的改动 | M6 |
| [models.md](models.md) | 输入框下面一行的选择范围按钮（v1）、思考强度（Effort）和上下文用量的圆环，菜单的位置与窄栏（每一栏各一组；2026-10-21 从顶栏移来） | M6 |
| [tools.md](tools.md) | Customize 页（工具页）：内置工具、技能、MCP、插件（pi 包）；启停照 pi config 的写法 | M6 |
| [slash.md](slash.md) | 输入框的"/"补全（提示词模板、技能命令）与技能调用的显示 | M6 |
| [review.md](review.md) | 工作回顾（Review）：对内容的反馈与界面问题的列表、详情、已处理与隐藏、回到原位置、导出为 Markdown（v1：见 docs/specs/memory.md §10.1、§10.8：由记忆页（Memory）取代，界面问题挪到设置页的"UI issues"，状态表见 [../../v1/screens/memory-page.md](../../v1/screens/memory-page.md)、[settings-issues.md](../../v1/screens/settings-issues.md)） | M7 |
| [window.md](window.md) | 关掉窗口留在系统托盘、托盘图标与菜单（Show App、Exit）、第一次关窗口的气泡、再次启动叫出窗口、有会话正在生成时退出先问、窗口藏着时的批准提醒（照 Claude 桌面版；来源是主进程的窗口、托盘、单实例与退出事件和界面报告的正在生成的会话数） | 2026-10-26 走查（WP-20） |

pi 事件名以 `@earendil-works/pi-coding-agent` 1.3.0 的 `AgentSessionEvent` 为准；
`message_update` 经后台进程精简为 `{ type, contentIndex, delta, toolCallId, toolName, args }`（见 `app/src/kernel/events.ts`）。
