# 扩展的询问（M3）

依据：方案第 6 节第 3 件"转达 pi 扩展的界面请求（通知、确认、选择、输入）"。v0 只转这四种；pi 的 RPC 模式另外还转达多行编辑器、状态栏、小部件、标题和编辑器文字，v0 不做（编辑器按取消回答，其余什么都不做）。
原排在 M6，2026-10-19 负责人决定照 Claude 桌面版（扩展、工具要问你的事都出现在界面上等你回答）提前到 M3：M3 开始加载你信任的项目扩展。

## pi 1.3.0 的相关行为

| 事实 | 影响 |
| --- | --- |
| 扩展经 `ctx.ui` 调用 `notify(message, type)`、`confirm(title, message, opts)`、`select(title, options, opts)`、`input(title, placeholder, opts)`；`opts` 可带 `timeout`（毫秒）和 `signal` | 后台进程在 `bindExtensions` 时传入自己的界面上下文，把这四种转给界面；其余（多行编辑器、状态栏、小部件、页眉页脚、标题、编辑器文字、自定义组件）照 pi 的空实现，什么都不做 |
| `bindExtensions` 里向扩展发 `session_start`，这时界面还不认识这个会话；扩展命令（`/名字`）由 pi 的 `prompt()` 交给扩展处理，不开始一轮运行 | 打开过程中的询问不出卡（见下）；扩展命令里的询问照常出卡，`prompt()` 结束时后台进程发 `mori.prompt_done`，界面据此结束"刚发出" |
| 没有界面时 pi 的默认值：确认返回"否"，选择和输入返回空 | 询问被取消、超时、会话关闭时也按这个回给扩展 |
| 停止时 pi 中止本轮，但扩展不一定把 `signal` 交给询问，可能取消一个就接着问下一个 | 停止过程中新的询问直接按取消回答，不出卡，停止不会被卡住 |

## 来源（后台进程）

| 事件 / 命令 | 何时 | 内容 |
| --- | --- | --- |
| `mori.notify`（事件） | 扩展调用 `notify`；会话打开过程中发的先存着，随 `session.create` / `session.open` 的结果（`extensionNotices`）交给界面 | 原文和级别（info / warning / error） |
| `mori.ui_request`（事件） | 扩展调用 `confirm` / `select` / `input` | 询问 id、种类、标题、说明（确认）、选项（选择）、提示文字（输入）、超时、提出的时刻 |
| `mori.ui_end`（事件） | 询问结束：你回答了、超时、扩展的 signal 中止、你按了停止、会话关闭 | 询问 id |
| `ui.answer`（命令） | 你在询问卡上作答或取消 | 询问 id；确认为真假，选择为选中的那一项，输入为文字；取消为空 |
| `mori.prompt_done`（事件） | pi 的 `prompt()` 结束（包括交给扩展命令处理、没有开始运行的） | — |

不出卡、直接按取消回给扩展（后台进程记错误日志）的询问：会话打开过程中（`session_start` 等）、你按了停止到停止结束之间、
会话关闭（归档、删除、退出）之后。否则打开、停止、关闭会一直等下去。会话关闭后扩展的通知不再转发。

## 询问卡

询问卡停靠在输入框上方，排在批准卡之后（同一时刻有批准卡时先显示批准卡）；不抢输入框的焦点，没有默认按钮，Enter 不会作答。
（2026-10-26 注：见 file-system-permissions.md §10.4：询问卡与 `ask_user_question` 的提问卡排在一起，按到达顺序一次显示一张，卡头 "N more" 计入两种；批准卡仍在前。
见 file-system-permissions.md §9：你不在（Mori 窗口不在前台或最小化）时询问卡同样计时，到时按取消回给扩展（同现在的取消），见下表“你不在”一行；任务栏仍不闪，不变。）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 确认 | `mori.ui_request`，种类 confirm | 卡头"An extension needs your input"；标题；说明原文；按钮"Yes"和"No" | "Yes"；"No"；焦点在卡上时 Esc 等于"No" |
| 选择 | 种类 select | 卡头"An extension needs your input"；标题；每个选项一个按钮 | 选一项；"Cancel"；焦点在卡上时 Esc 等于"Cancel" |
| 输入 | 种类 input | 卡头"An extension needs your input"；标题；输入框（显示提示文字）；"Submit"和"Cancel" | 输入框里 Enter 等于"Submit"（输入法组字时只选词）；Esc 等于"Cancel" |
| 有超时 | 询问带 `timeout` | 卡上一行"This request expires in N seconds"（1 秒时"This request expires in 1 second"；从后台进程提出询问的时刻算起，每秒刷新；界面重新加载后接上也一样） | 同上 |
| 你不在（2026-10-26 注：见 file-system-permissions.md §9.3、§9.4、§9.9） | `mori.away_timer { requestId, deadline }`；切回 Mori 时 `deadline: null`；到时 `mori.ui_end` 与 `mori.away_decision` | 剩下 20 秒以内时卡头下一行 `You’re away · Cancelling in 12s`，每秒刷新；扩展自己的"This request expires in N seconds"照旧另起一行，两个计时各管各的，先到的生效；到时卡消失，按取消回给扩展，这一轮末尾的 `Decided while you were away` 多一行 `Cancelled` · `Extension: <title>`（见 ../../v1/screens/fs-question.md） | 同上 |
| 还有别的询问排在后面 | 同一会话同时有多个询问 | 卡头"N more" | 处理完这一个，下一个接着出现 |
| 结束 | `mori.ui_end` | 卡消失 | — |
| 阶段行 | 有挂起的询问、没有批准卡时（包括扩展命令里的询问，这时没有在生成） | "Waiting for your answer" | — |
| 会话行 | 同上 | 状态"Needs input"（见 sessions.md） | — |

停止（Esc 或"Stop"按钮）时挂着的询问按取消回给扩展。后台进程退出时询问卡消失。界面重新加载后点开还在后台进程里的会话，挂着的询问照常出现。

## 通知

| 状态 | 来源 | 必须可见 |
| --- | --- | --- |
| 通知 | `mori.notify` | 对话流里一行"Extension: <原文>"；warning 用警示色、error 用危险色 |
| 打开过程中的通知 | `session.create` / `session.open` 结果里的 `extensionNotices`（只在真正打开它的那次；界面重新加载后接上时没有） | 打开后接在对话流后面，样子同上 |

通知不写进会话记录：重新打开会话、界面重新加载后接上，之前的通知都不再显示。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 询问卡 | `data-testid="ext-ui-card"`，`data-request` 为询问 id，`data-method` 为种类 |
| 通知 | 对话流里 `data-testid="ext-notify"` |
