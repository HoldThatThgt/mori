# 屏幕状态表

每屏一张状态表：状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作。实现该屏之前写好，实现与测试都以它为准。
"来源"只能是 pi 的事件、pi SDK 的返回值、批准扩展的请求（M2 起），或你刚做的操作；没有来源的状态不显示。

| 文件 | 内容 | 里程碑 |
| --- | --- | --- |
| [connection.md](connection.md) | 首次启动、连接表单（也是"设置 → 连接"和"去设置"的落点）、打开文件夹 | M1 |
| [layout.md](layout.md) | 三栏布局、分隔线、窄窗口、侧栏、右栏、设置页外框 | M1 |
| [chat.md](chat.md) | 顶栏、对话流、阶段行、排队区、输入框、停止、错误、后台进程退出 | M1 |
| [tool-cards.md](tool-cards.md) | 工具卡状态与标题对照表 | M1（批准相关状态在 M2 接通） |
| [approval.md](approval.md) | 哪些调用要批准、批准卡、工具卡与阶段行的批准状态、权限菜单、任务栏闪烁 | M2 |
| [f8.md](f8.md) | F8 报告界面问题：入口、报告框、保存的内容 | M2 |

pi 事件名以 `@earendil-works/pi-coding-agent` 1.3.0 的 `AgentSessionEvent` 为准；
`message_update` 经后台进程精简为 `{ type, contentIndex, delta, toolCallId, toolName, args }`（见 `app/src/kernel/events.ts`）。
