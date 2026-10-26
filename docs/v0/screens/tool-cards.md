# 工具卡（M1；批准相关状态 M2 接通）

依据：方案 5.5、5.7。批准卡、权限菜单和批准相关状态的来源见 [approval.md](approval.md)。

## 标题对照表

路径在会话工作目录之内时显示相对路径，否则显示原路径。命令只取第一行，超过 80 个字截断加"…"。
阶段行用同一段文字（例如"Run npm test 8s"）。
（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.7、§13.8：下表新增的 11 个 TaskBoard 工具标题是英文；它们出现在用户会话自己的调用里（合并会话的立项、协作模式下对话的 `board_read` 等），
免批准、不出批准卡（§11.2）；后台实例的调用不出工具卡，只在进展摘要里，见 ../../v1/screens/team-stream.md）

| 工具名（pi） | 参数 | 标题 |
| --- | --- | --- |
| `read` | `path`，可选 `offset`、`limit` | Read `path`；有行范围时加" · lines a–b"（只有 `offset` 时" · from line a"） |
| `bash` | `command` | Run `command` |
| `powershell` | `command` | Run `command` |
| `edit` | `path` | Edit `path` |
| `write` | `path` | Write `path` |
| `grep` | `pattern` | Search `pattern` |
| `find` | `pattern` | Find `pattern` |
| `ls` | `path`（可省略） | List `path`（省略时为"List ."） |
| `mcp__<服务>__<工具>` | — | `<服务> · <工具>` |
| `board_read`（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.8） | 不带参数 / `request` / `task` | `Read the board` / `Read request 1` / `Read T1` |
| `read_session`（同上） | `task`、`role` | `Read <role>’s work on T1` |
| `agent_message`（同上） | `to` | 发给角色、开临时提问：`Ask <role>`；发进座位会话：`Message <role>`；发到 task：`Message T1` |
| `task_handoff`（同上） | `task` | `Hand off T1` |
| `request_submit`（同上） | — | `Register a request` |
| `request_update`（同上） | `request` | `Add to request 1` |
| `request_cancel`（同上） | `request` | `Cancel request 1` |
| `task_create`（同上） | — | `Create a task` |
| `task_edit`（同上） | `task` | `Edit T1` |
| `reply_via_dialog`（同上） | — | `Answer directly` |
| `request_close`（同上） | `request` | `Close request 1` |
| 其他 | — | 原名 |
| 参数还没写完 | `toolcall_delta` 期间参数解析不出 | 按工具名给动词，例如"Run …"；未知工具显示原名 |

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 准备中 | `toolcall_start`、`toolcall_delta`：模型正在生成这次调用的参数 | 标题（参数够用时）+"Preparing…" | 展开看已收到的参数 |
| 等待执行 | 这条回复已结束（`message_end`，参数完整），pi 还没发这次调用的 `tool_execution_start`：一条回复里的调用按顺序执行，前面的调用还在等批准或执行中（M2） | "Queued" | 展开看参数 |
| 等你批准 | `mori.tool_gate` 为 `ask` 时的 `tool_execution_start`，或批准扩展的 `mori.approval_request`（M2） | "Waiting for your approval" | 输入框上方的批准卡（approval.md） |
| 执行中 | 自动放行（`mori.tool_gate` 为 `free` / `session` / `all`）时的 `tool_execution_start`；要批准的调用在 `mori.approval_end` 为允许时（M2） | "Running…"和实时耗时（"Running… 8s"），从开始执行（或你允许）的那一刻计时；命令有输出时展开能看到实时输出（`tool_execution_update`） | 展开 |
| 完成 | `tool_execution_end`，`isError` 为假 | "Done"，实时运行时加耗时（`durationMs`，如"Done · 1.2s"） | 展开看参数和输出；编辑类显示 diff，写入显示新内容 |
| 失败 | `tool_execution_end`，`isError` 为真，且你没按停止 | "Failed · Exit code N"（输出里有 `Command exited with code N` 时）或"Failed · <错误原文第一行>" | 展开看完整输出 |
| 已拒绝 | `mori.approval_end` 为拒绝；从会话记录载入时，工具结果是 Mori 拒绝的固定写法（M2） | "Denied"、"Denied · <你写的理由>"（理由超过 40 字时截断加"…"，悬停看全文），或卡挂着时你按了停止："Denied · You pressed Stop"；之后的 `tool_execution_end` 不改变它 | 展开（输出里有完整理由） |
| 已停止 | 你按了停止：之后结束的工具（`isError`）、还在准备中、等待执行或没开始执行的调用 | "Stopped" | 展开看已有输出 |
| 已中断 | Mori 后台进程退出时还没结束；或会话记录里这次调用没有结果；或本轮结束（`agent_settled`）时它还没执行（例如回复出错，pi 不执行其中的调用） | "Interrupted" | 展开 |
| 本会话已允许 / 全部允许 | `mori.tool_gate` 为 `session` / `all`，或挂着的卡被"Allow “…” for this session"（同名的其余请求）或切到"Allow all"放行（M2）；只在实时运行时 | 卡上小字标签"Allowed for this session" / "Allow all"；你亲手允许的那张卡不标 | — |

- 默认折叠。展开看"Input"（参数，格式化 JSON）和"Output"（输出，最多显示最后 20,000 字，临时默认值）。
- 编辑工具展开后显示 pi 结果里的 `details.patch`（@pierre/diffs 渲染）；写入显示参数里的 `content`（"File content"）。
- 耗时只在实时运行时显示；从会话记录载入的工具卡不显示耗时。
- M4 起，读取、修改、写入的标题里的路径是按钮：点它（或 Tab 到它按 Enter）在右栏打开文件阅读器
  （悬停"Open <路径> in the right panel"），不展开工具卡（见 [changes.md](changes.md)）。

反例：失败的命令不显示"Done"；读取、搜索、查找、列目录不出批准卡；等你批准时不显示"Running…"。

## 命令用的 shell（2026-10-26 补）

负责人走查 M28（"bash not usable in mori"）由 WP-00 实现，做法在方案第 6 节"Shell"（检查记录
[../../v1/walkthrough-1026/WP-00.md](../../v1/walkthrough-1026/WP-00.md)）；当时只改了方案，这里补上看得见的两行。
命令卡本身的样子不变，由上面的"完成""失败"等通用行描述；界面上不说明用的是哪个 bash（同 Claude 桌面版）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| pi 找不到 bash、Mori 找到 Git Bash（2026-10-26 补） | 后台进程启动时查一次（`kernel/shell.ts`）：用户级 pi 设置里没有 `shellPath`，pi 自己的查找（`%ProgramFiles%\Git\bin\bash.exe` 及 x86 的、PATH 上的 `bash.exe`）落空；PATH 上的 `<Git>\cmd\git.exe`（或 `bin`、`mingw64\bin` 下的）推出、或 Git for Windows 注册表 `InstallPath` 下有 `bin\bash.exe`。找到的路径作为 `shellPath` 只放进内存里的 pi 设置，不写 `settings.json` | 模型调用 `bash` 时同普通的命令卡：标题"Run `command`"，命令在这个 Git Bash 里跑，完成时"Done"，展开的输出是 bash 的（例如 `uname -s` 打出 `MINGW64_NT-…`）；不再是每次都"Failed · No bash shell found" | 同"完成" |
| 哪里都没有 bash（2026-10-26 补） | 上面的查找都落空：后台进程只在内存里给 pi 设置放 `defaultTools: ["-bash", "+powershell"]`（方案第 6 节"Shell"，第 11 节待确认第 2 条的默认"没有 Git Bash 就用 PowerShell"）；设置（用户级或受信任项目的）里已有 `shellPath` 时不放 | 新会话没有 `bash` 工具、有 `powershell`：模型的命令是 `powershell` 的命令卡，标题同样是"Run `command`"，要批准（同 `bash`）；Customize 工具列表里新会话的 `bash` 一行是"Not enabled"、`powershell` 一行是"Enabled"（[tools.md](tools.md)"没有 bash 时"：`bash` 的开关读文件里的值，仍开着） | 同上 |
