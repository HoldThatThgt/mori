# 钩子在对话流与别处的显示

依据：负责人 2026-10-28 的要求 "make a hook system following claude's design"；[钩子构建规格](../../specs/hooks.md)（下称“规格”）§6、§7、§8。
补充 [v0 tool-cards.md](../../v0/screens/tool-cards.md)（工具卡的状态、`Denied · <理由>`）、[v0 chat.md](../../v0/screens/chat.md)（对话流、错误卡、停止）、
[fs-permissions.md](fs-permissions.md)（批准卡、工具卡的放行标签）与 [model-chat.md](model-chat.md)（准备中）。
照 Claude Code 显示钩子的做法（G、R）：成功时什么都不显示；拦下时显示拦下带的那句话；非阻断错误一行 `<事件> hook error`，带 `Failed with non-blocking status code:` 与 stderr 的第一行；
`systemMessage` 是给你看的提醒；Stop 拦下而接着跑时一行 `Stop hook error`，给 `additionalContext` 时一行 `Stop hook feedback`；PermissionRequest 替你允许时写 `Allowed by PermissionRequest hook`。完整的 stdout、stderr 只在 Claude 的调试日志里——Mori 不显示（也不写日志，规格 §10）。
界面文字为英文；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| 事件 `mori.hook_line { line }` 与会话文件里的 `mori.hook_line` 条目（规格 §8.2） | `line` = `{ event, kind, text, toolCallId }`；`kind` 为 `error`、`message`、`feedback`、`stopped`、`limit`；`text` 是要显示的整句 |
| 工具结果原文以 `Blocked by PreToolUse hook: `、`Blocked by PermissionRequest hook: ` 开头（规格 §7.1、§7.2，在 `DENIAL_PREFIXES` 里） | 工具卡按程序拒绝显示（实时与打开会话都一样） |
| `mori.approval_end` / `mori.team_approval_end` 的 `by: 'hook'` | 批准卡由 PermissionRequest 钩子结束 |
| `mori.approval_request` / `mori.team_approval_request` 的 `hookAsk` | 批准卡上那一行的整句（规格 §8.3，后台进程拼好，带来源与原因）；这张卡不是 PreToolUse 的 `ask` 出的时为 `null` |
| `mori.prompt_error`，`message` 以 `Blocked by UserPromptSubmit hook: ` 开头（规格 §8.4） | 你的消息被 UserPromptSubmit 拦下 |
| v0 已有的 pi 事件（`tool_execution_*`、`message_*`、`agent_settled`）、`mori.tool_gate`、`mori.prompt_done` | 工具卡、运行的开始与结束、准备中 |
| 你的操作 | 发送、插话、排队、停止、回答批准卡、重新打开会话、F8 |

钩子成功、没有给你看的东西时（放行、加了上下文、Notification、SessionEnd、PreCompact 拦下阈值压缩）对话流里没有任何变化（同 Claude）。给模型的 `mori.hook_message` 不显示（custom 消息不进对话流）。

## 钩子行

一行灰色的提示（同 `Compacted session` 的 `notice`），`data-testid="hook-line"`、`data-event`、`data-kind`；`error`、`limit` 用警示色（同扩展通知的 `warning`），其余用普通提示色（临时，走查时可以改）。
排在事件发生的位置：工具事件的行紧跟在那张工具卡之后（同一轮里），其余跟在这时对话流的最后。文字整句是 `line.text`，长的折行、不截断。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 非阻断错误 | `kind: 'error'`（规格 §5.6：退出码不是 0 或 2 的纯文本、不合格的 JSON、到时、起不来） | 每条钩子一行，例如 `PreToolUse hook error: Failed with non-blocking status code: <stderr 的第一行>`、`Stop hook error: Invalid JSON output: <原因>`、`UserPromptSubmit hook error: Timed out after 30s`、`SessionStart hook error: Couldn’t start: <原文>`；这次调用、消息、运行照常（没有决定） | — |
| 给你的提醒 | `kind: 'message'`（`systemMessage`；SessionStart 退出码 2 的 stderr） | `<Event> hook: <内容>`，例如 `PostToolUse hook: Formatted 2 files.` | — |
| Stop 拦下而接着跑 | `kind: 'error'`，`event: 'Stop'`（退出码 2 或 `decision: "block"`，规格 §6.7） | 第一段回复之后一行 `Stop hook error: <原因>`（警示色）；之后照常是阶段行（`Waiting for the model…`）、停止按钮仍在、模型的下一段回复接在这一行下面；一次运行可以有几行（每次拦一行）；只有一次 `agent_settled`，回复下的操作行（Copy 等）在最后一段回复上 | 停止（同 v0） |
| Stop 的 additionalContext | `kind: 'feedback'`，`event: 'Stop'`（`hookSpecificOutput.additionalContext`，规格 §6.7） | 第一段回复之后一行 `Stop hook feedback: <内容>`（普通提示色）；接着跑的样子同上一行（阶段行、停止按钮仍在、下一段回复接在这一行下面、每次一行、只有一次 `agent_settled`、操作行在最后一段回复上）；同一个边界里既拦下又给了 `additionalContext` 时两行都出（规格 §6.7） | 停止（同 v0） |
| PostToolUse 的反馈 | `kind: 'feedback'`，`event: 'PostToolUse'` | 那张工具卡之后一行 `PostToolUse hook feedback: <内容>`；工具卡仍是 `Done`，它的输出最后也有这一句（模型看到的结果后面加了这一段，规格 §6.5） | 展开工具卡看输出 |
| 钩子让回复停下 | `kind: 'stopped'`（`continue: false`） | `Stopped by <Event> hook: <stopReason>`（没有原因时 `Stopped by <Event> hook`）；PreToolUse、PermissionRequest、PostToolUse 给的：之后是 v0 的停止（`Stopped · Changes made so far stay as they are`，排队区的消息回到输入框，同你按停止）；Stop 给的：回复照常结束，没有 `Stopped ·` 那一行；UserPromptSubmit 给的见下面“你的消息” | — |
| 到了上限 | `kind: 'limit'` | `Stop hook blocked 8 times in a row, so the response ended.`，之后回复照常结束 | — |
| 重新打开会话 | 会话文件里的 `mori.hook_line` 条目 | 同样的行在同样的位置（按条目在分支上的位置）；界面重新载入后接上运行中的会话时，已经写进文件的行照画，之后的实时到 | — |

## 工具卡与批准卡

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| PreToolUse 钩子在跑 | 预告 `mori.tool_gate`（预告不跑钩子） | 工具卡照预告显示（`Running…` 或等批准的样子），不另加状态；Claude 的 `statusMessage` 不显示 | 停止（钩子进程被杀，这次调用 `Stopped`） |
| PreToolUse 拦下 | 工具结果 `Blocked by PreToolUse hook: <原因>`；预告不是 `deny` 时先有更正的 `mori.tool_gate` | `Denied · Blocked by PreToolUse hook: <原因>`（理由超过 40 字截断加 `…`，悬停看全文，同 v0）；Full access、Allow for this session 下也一样；展开后 Output 是同一句（加了上下文时后面还有 `PreToolUse hook additional context: …`）；之后模型照常接着回复 | 展开 |
| PreToolUse 放行 | 钩子给了 `allow` | 工作路径里的调用不出批准卡，工具卡照常 `Running…` → `Done`，没有放行标签（Claude 不标）；工作路径外、受保护路径的照样出批准卡 | — |
| PreToolUse 要你批准 | `mori.approval_request` 的 `hookAsk` 不是 `null` | 照常的批准卡（fs-permissions.md），Full access、Allow for this session、读取也出；卡上 Scope 行之前一行，照抄 `hookAsk`：`PreToolUse hook (User settings): <原因>`（项目的写 `Project settings`，两种都有时 `User and Project settings`；没有原因时也有这一行，不带冒号与原因，例如 `PreToolUse hook (User settings)`；`approval-hook-reason`；临时，走查时可以改）；只有 `hookAsk` 为 `null`（卡不是钩子的 `ask` 出的）时没有这一行；批准卡显示的参数是钩子改过之后的 | Allow once、Allow for this session、Deny（同 fs-permissions.md） |
| PermissionRequest 钩子在跑 | 卡已经出现（规格 §6.4：同时跑） | 批准卡照常、可以回答；没有“钩子在跑”的提示 | 回答（先答的算数，钩子进程被杀） |
| PermissionRequest 允许 | `mori.approval_end`（或 `mori.team_approval_end`）`by: 'hook'`、`decision: 'allow'` | 批准卡消失；工具卡 `Running…`，标签 `Allowed by PermissionRequest hook`（`tool-badge`，同 `Allowed for this session` 的位置）；阶段行回到运行中 | — |
| PermissionRequest 拒绝 | `by: 'hook'`、`decision: 'reject'`，原文 `Blocked by PermissionRequest hook: <原因>` | 批准卡消失；工具卡 `Denied · Blocked by PermissionRequest hook: <原因>`（截断与悬停同上） | 展开 |
| PostToolUse 加了上下文 | 工具结果后面多了文字块 | 工具卡照常 `Done`；展开后输出最后是 `PostToolUse hook additional context: …`；没有钩子行 | 展开 |
| 重新打开会话 | 会话文件 | 拒绝的卡同实时；`Allowed by PermissionRequest hook` 的标签不在（批准事件不进会话文件，同 `Allowed for this session`） | — |

## 你的消息（UserPromptSubmit）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 钩子在跑（空闲时发送） | 你刚发出，`session.prompt` 还没返回 | 同发送时：先显示的消息、`Sending…`（model-chat.md 的准备中）；不另加状态；第一条消息还要先等 SessionStart 钩子（同样显示） | Esc、停止：钩子进程被杀，这条消息与后面等着的回到输入框（`Stopped before sending`，不显示错误卡，同准备中停止） |
| 钩子在跑（生成中插话、排队） | 同上 | 同 v0 插话、排队时的样子（排队区） | 停止：同上，一起回到输入框 |
| 被拦下（空闲时发送） | `mori.prompt_error`，`message` 为 `Blocked by UserPromptSubmit hook: <原因>`，有先显示的消息 | 先显示的消息撤回；文字（与引用芯片）回到输入框；错误卡 `Blocked by UserPromptSubmit hook: <原因>`（`error-card`），没有 `Put your last message back in the message box`（文字已经在输入框里）；会话回到空闲；端点没有收到这条消息 | 改了再发 |
| 被拦下（带 worktree 的第一条消息） | 同上：`Worktree` 开关打开时发的第一条消息（`session.prompt { worktree: true }`，[fs-worktree.md](fs-worktree.md)“发第一条消息时建 worktree”），钩子在重建出来的会话里跑（规格 §6.6） | worktree 与重建的会话留着（同 fs-worktree.md“建好了、消息没能发出”）；输入框下一行的 `Worktree` 开关不再出现；先显示的消息撤回，文字（与引用芯片）回到输入框；同一张错误卡 `Blocked by UserPromptSubmit hook: <原因>`，没有 `Put your last message back in the message box`；端点没有收到这条消息 | 改了再发 |
| 被拦下（生成中插话、排队） | 同上，没有先显示的消息 | 错误卡 `Blocked by UserPromptSubmit hook: <原因>`，带 `Put your last message back in the message box`（同 v0 插话失败）；正在进行的回复不受影响 | 放回输入框 |
| 被拦下（协作模式） | 同上 | 同空闲时发送；立项没有收到这条消息，排队区里没有 `Waiting for <create role>` | 改了再发 |
| `continue: false` | 同被拦下，原因是 `stopReason` | 同被拦下（错误卡里是 `stopReason`） | 同上 |
| 加了上下文 | 钩子退出码 0 的纯文本或 `additionalContext` | 什么都不变：你的消息照常显示、照常回复；上下文不显示（同 Claude：不在转录里留可见的一项） | — |
| 到时、出错 | `kind: 'error'` 的钩子行 | 一行 `UserPromptSubmit hook error: Timed out after 30s`（或别的错误），消息照常发出、照常回复 | — |

## 会话开始与结束

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| SessionStart 钩子在跑 | 会话刚建好或打开 | 会话照常可用（输入框可以打字）；你发的第一条消息显示为 `Sending…`，等钩子结束才发出 | 打字、发送；停止同上 |
| SessionStart 给你看的 | `kind: 'message'`（退出码 2 的 stderr、`systemMessage`）、`kind: 'error'` | 对话流最前面（或当时的最后）一行 `SessionStart hook: <内容>` / `SessionStart hook error: …`；会话还没有消息、还没写盘时这些行只在这次打开里看得到（规格 §6.9） | — |
| SessionStart 加了上下文 | 退出码 0 的纯文本、`additionalContext` | 什么都不变（随你的第一条消息交给模型，不显示） | — |
| SessionEnd | 归档、删除、退出 Mori | 什么都不变：归档、删除在钩子结束（最多按规格 §6.10 的时限）之后照常完成；退出照常；钩子的输出不显示 | — |
| PreCompact 拦下阈值压缩 | pi 的 `reason: 'threshold'`；没有钩子行，只记日志（规格 §6.12） | 没有 `Compacted session`；会话照常回复 | — |
| PreCompact 拦下溢出恢复 | pi 的 `reason: 'overflow'`；`kind: 'error'` 的钩子行，`data-event="PreCompact"`（规格 §6.12、§8.2） | 一行 `PreCompact hook blocked context overflow recovery: <原因>`（警示色），这次回复结束；没有 v0 溢出的错误卡（界面在 `compaction_start` 时已经去掉，规格 §3 第 19 条）；重新打开会话这一行还在 | — |
| PreCompact 拦下换模型的重建 | pi 的 `reason: 'manual'`（模型层的重建） | 照 model-chat.md 的重建失败（pi 抛 `Compaction cancelled`，规格 §6.12）；没有钩子行 | — |
| PreCompact 出错 | `kind: 'error'` | `PreCompact hook error: …` 一行 | — |
| Notification | — | 什么都不变（只做钩子自己的副作用，例如它自己弹的窗口） | — |

## 实例里的钩子

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| TaskBoard 实例、subagent 的工具调用被拦 | 实例的会话文件 | 用户会话的对话流里没有钩子行；Background tasks 里 View transcript（[team-tasks.md](team-tasks.md)）里那张工具卡 `Denied · Blocked by PreToolUse hook: …`、钩子行照上面画；subagent 卡上那一行的状态照 [subagent-card.md](subagent-card.md) | View transcript |
| 后台批准卡被 PermissionRequest 结束 | `mori.team_approval_end`，`by: 'hook'` | 用户会话输入框上方的后台批准卡消失（同你在卡上回答）；实例的工具卡在 View transcript 里照上表 | — |
| SubagentStop 让 subagent 接着跑 | 实例的会话文件 | subagent 卡上那一行仍是运行中（最近一次工具调用的标题），之后 `Done`；`Response` 是接着跑之后的最后一段文字；拦下时一行 `SubagentStop hook error: <原因>`、给 `additionalContext` 时一行 `SubagentStop hook feedback: <内容>`，只在那个实例的 transcript 里 | 点开那一行 |
| 增强任务 | — | 没有任何钩子在跑，没有钩子行（规格 §6.2） | — |

## F8

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| F8 报告的 Recent activity | 界面的操作记录（[v0 f8.md](../../v0/screens/f8.md)） | Customize 的开关记 `Disable all hooks` / `Enable all hooks`；钩子的运行、拦下、钩子行都不进操作记录（它们不是你做的操作）；报告里没有钩子的命令、stdin、stdout、stderr | — |
| F8 报告的 Current view | 同 v0 | 对话流里的钩子行与别的提示一样算进当前看到的内容（同 v0 的写法，不另加字段） | — |

## 反例

- 钩子成功、没有要给你看的东西时，对话流里没有任何一行（没有“hook ran”之类的提示）。
- 钩子交给模型的上下文、Stop 的反馈消息本身不显示为一条消息（只有那一行 `Stop hook error: …` 或 `Stop hook feedback: …`）。
- 被 PreToolUse 拦下的调用不显示 `Failed`，显示 `Denied · …`；被拦的命令没有执行，没有输出。
- UserPromptSubmit 拦下的消息不留在对话流里，也不出现在会话引用、重新打开的会话里。
- 钩子行里不显示 stderr 第一行之后的内容，也不显示 stdout 的原文。
- 用户会话的对话流里没有实例的钩子行。
- 钩子改了参数时对话流里没有任何一行（规格 §0 第 19 条）。
- 重新打开会话时没有 `Allowed by PermissionRequest hook` 标签（同 `Allowed for this session`）。

## 本表定下的界面细节

规格与负责人的话没给、本表定的（临时，走查时可以改；登记在 [defaults.md](../defaults.md) 的“钩子”一节）：钩子行用 `notice` 的样子、`error` 与 `limit` 用警示色；工具事件的行紧跟在那张卡之后；批准卡上 `PreToolUse hook (User settings): <原因>` 那一行的位置；
钩子在跑时不另加状态；`Stopped by <Event> hook: …`、`Stop hook blocked 8 times in a row, so the response ended.`、`<Event> hook: <内容>`、`Blocked by … hook: …` 的写法。
照 Claude 的：`Stop hook feedback`（只给 `additionalContext`）、`Stop hook error`、Stop 与 SubagentStop 的拦下显示为钩子错误、`<Event> hook error`、`Failed with non-blocking status code:` 加 stderr 的第一行、`Allowed by PermissionRequest hook`、成功时不显示、拦下时显示原因、UserPromptSubmit 的上下文不显示。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 钩子行 | `data-testid="hook-line"`，`data-event`（事件名），`data-kind`（`error` / `message` / `feedback` / `stopped` / `limit`） |
| 工具卡 | v0 的 `tool-card`；拒绝的理由在状态行（同 v0）；放行标签 `tool-badge`，文字 `Allowed by PermissionRequest hook` |
| 批准卡 | v0 的 `approval-card`；钩子原因 `approval-hook-reason` |
| 错误卡 | v0 的 `error-card` |
