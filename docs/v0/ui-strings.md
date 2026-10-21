# 界面文字（英文）

Mori 代码里显示和写出的文字全部是英文（2026-10-21 决定）：界面上的字、读屏名和悬停提示、发给模型的引用块和会话引用、写进文件的 F8 报告和导出、写进报告的操作记录。模型生成的内容随用法，不做翻译。有 Claude 桌面版对应的地方照 Claude 的用词（负责人 2026-10-21 要求："我最常用 Claude，想保持同样的说法"）。不做多语言、没有语言切换，也不读旧的中文记录：以前存下的中文 F8 报告和中文引用块不做兼容，按原文显示（负责人 2026-10-21 决定）。文档和代码注释仍用中文。

每一处文字的逐条对照（文件、行、种类、是否被别处解析、Claude 的键和原文）在实现时用的 `translations.json` 里；这份文档记下规则、术语和读的人要核对的固定说法。测试结果、与方案不同的地方和未验证的项见检查记录 [english-ui-checks.md](english-ui-checks.md)。

## 写法约定

- **照 Claude 的用词。** Mori 的元素在 Claude 桌面版里有对应（同一类控件或同一类提示）时，用 Claude 英文界面里的原词；只有意思真的一样才算对应。没有对应时按下面的规则自己写。
- **句子大小写（sentence case）。** 只有第一个词和专有名词大写："New session"、"Open in split view"，不写 "New Session"。
- **省略号用 "…"（U+2026），不用三个点。** 两种情况加："进行中"的状态（Loading…、Saving…、Thinking…、Restarting…），和点了会弹出对话框或选择器的命令（Open folder…、Delete…、Remove…、Export as Markdown…、Add plugin from folder…）。直接执行的命令不加（Archive、确认框里的 Delete / Remove）；只是跳到另一页的也不加（Manage models，同 Claude 的 "Manage plugins"）。
- **撇号和引号用排版符号。** 撇号 ’（Couldn’t、Mori’s、don’t），引号 “ ”（Allow “Run commands” for this session）。代码、JSON 示例和正则里的引号照原样。
- **分隔符 " · " 照 Mori 原来的用法。** " · " 后面的片段首字母大写（"Stopped · Changes made so far stay as they are"、"Saved · Applies to new sessions"）；只有行和轮的范围（"src/a.ts · lines 3–5"、"turns 3–4"）、以数字或 "~" 开头的片段保持原样，因为行和轮的范围同一个函数也用在发给模型的句子中间。
- **短、直白，称呼用 "you"。** 一句完整的话结尾加句号；用 " · " 拼起来的片段、按钮、标签、占位文字不加。
- **列表用 Oxford 逗号**（"base URL, API key, and model ID"）；中文的 "、" 拼接改成 ", "。"例如" 写 "e.g."（不加逗号）。
- **错误的说法**："Couldn’t <动作>: <原文>"（Couldn’t save: …、Couldn’t load sessions: …）；Claude 原文是 "Failed to …" 的地方照 Claude（Failed to open session: …）。冒号后面只放错误原文；要带文件名时不加冒号（"Couldn’t read the record <文件名>"）。表单校验的提示是完整的句子，带句号（"Name is required."）。
- **数量要有真正的英文复数。** 数字插进句子时两种形式都写出（"1 session" / "2 sessions"），实现按 `n === 1` 选；`translations.json` 里这样的条目标 `"plural": true`，`en` 里用 "  /  " 隔开单数和复数。只有数字、不跟名词时用 Claude 的 "{n} more"，不用分单复数。
- **界面不讲它自己（方案第 2 节第 4 条）。** 界面文字里不出现实现用词：demo、mock、sample、example data、kernel、event、SDK、compat layer、IPC、renderer、utilityProcess，也不出现方案里的行话（executor、role session、task version）、版本代号（v0）。中文原来就写出的 pi、MCP、AGENTS.md、JSON、API key、Markdown，以及 F8 版本列表里的 Electron / Chromium / Node / Windows 照写。Mori 的 "后台进程" 是用户看得到的东西，写 "Mori’s background process"。读屏名里不用 " · " 和 "/"（读屏会念出来），改用逗号、括号或 "of"。
- **系统给的文字不翻译，Chromium 的固定用英文。** Windows 的对话框除了 Mori 设的标题和按钮（"Select a folder"、"Export as Markdown"）之外的部分（Cancel、导航栏、文件名框），以及 Windows 和 Node 给的错误原文（例如 `shell.openPath` 打不开时的原因，放在 "Couldn’t open the folder: <原文>"、"Couldn’t open this file with the default app: <原文>" 后面），跟 Windows 的显示语言走，中文 Windows 上是中文；这是有意不翻的，走查时不算漏掉的文字。Chromium 自带的文字（表单的校验气泡、日期控件等）不跟系统走：主进程在 ready 之前设 `--lang=en-US`；Mori 的表单都加 `noValidate`，校验的说明由 Mori 自己给（"Context window must be a whole number above 0."）。
- **给模型读的文字要让模型看得懂**：引用块开头写 "Quoting …:"（界面上同一个功能叫 context，见术语表"引用"），会话引用里写 "User:" / "Assistant:"（不写 "You"，理由见 [defaults.md](defaults.md) "会话引用的内容格式"）。界面上助手的输出叫 "response"（Claude 的词），给模型的文字里叫 "reply"（"Quoting your earlier reply:"）。

## 术语表

| 规格里的中文 | 界面英文 | Claude 桌面版的用词 | 说明 |
| --- | --- | --- | --- |
| 会话 | session / Sessions | Session、Sessions | 会话列表的读屏名 "Sessions"，菜单 "Session actions" |
| 新会话 / 新建会话 | New session | New session | 负责人定；按钮、标题的默认值、操作记录都用它 |
| 项目 / 项目文件夹 | project / project folder | — | 作用范围标签 "Project"，正文 "this project" |
| 打开文件夹… | Open folder… | Open folder… | 弹出选择器，所以带 "…"；选择器的标题 "Select a folder"（Claude 有这条）、按钮 "Select folder"，与 "Add plugin from folder…" 共用（`main/index.ts` 的 `mori:pick-folder`） |
| 轮 / 本轮 / 第 N 轮 | turn / the current turn / Turn N、turns a–b | # turn、after the current turn | 负责人定；句中小写 "turns 3–4" |
| 第 N 行 / 第 a–b 行 | line N / lines a–b | Line {line}、Lines {start}–{end} | 总跟在路径或 " · " 后面，所以小写 |
| 约 N 字 | ~N characters（1 character） | ~{count} characters | 复数 |
| 回复（助手的） | response | Response、Stop response | 给模型的文字里用 "reply" |
| 输入框 | message box | message box | |
| 插话 | Steer | — | 负责人定；按键提示 "Ctrl+Enter to steer" |
| 排队 / 排队发送 | Queue（按钮、记录）/ Queued（排队区的标签）| Queue、Queued | 会话照 Claude 的词定的（待负责人确认，见 english-ui-checks.md "需要你确认的地方"）；按键提示 "Enter to queue" |
| 撤回 | Withdraw | Withdraw | |
| 停止 | Stop / Stop response (Esc) | Stop、Stop response | |
| 发送 | Send | Send | |
| 批准 / 等你批准 | Waiting for your approval（阶段行、工具卡）/ Needs approval（侧栏的会话行）| 同左两种 | Claude 也是会话列表用短的、对话里用长的 |
| 等你回答 | Waiting for your answer / Needs input（侧栏）| 同左 | 同上 |
| 批准卡 | permission request | Permission request | 只在操作记录和 F8 字段 "Pending requests" 里出现 |
| 允许一次 | Allow once | Allow once | |
| 本会话不再询问 | Allow “<工具>” for this session（按钮）/ Allow for this session（记录） | Allow for this session | 按钮里带工具名 |
| 本会话已允许 | Allowed for this session | Allow for this session | 工具卡标签、权限菜单 |
| 拒绝 / 已拒绝 | Deny / Denied | Deny、Denied | |
| 每次询问 / 全部允许 | Ask each time / Allow all | Ask each time、Allow all | 权限模式；不用 Claude Code 的 "Bypass permissions"，因为 Mori 两种模式都放行只读工具 |
| 权限 | Permission mode（模式）/ Permissions（菜单名） | Permission mode、Permissions | |
| 清除（已允许的一项） | Forget | Forget | |
| 归档 / 已归档 | Archive / Archived | Archive、Archived | |
| 恢复（归档的会话） | Unarchive | Unarchive | |
| 删除 / 移除 | Delete…、Remove…（菜单项和行内按钮，会弹确认）/ Delete、Remove（确认按钮）/ Deleting…、Removing… | Delete…、Delete、Deleting…、Remove | 会话菜单、模型行、MCP 服务行、插件卡同一规则 |
| 重命名 / 改名 | Rename | Rename | |
| 分屏 | split view / Open in split view | Split view、Open in split view | |
| 一栏（分屏的一边） | pane | pane、Close pane | |
| 左栏 / 侧栏 | sidebar | Sidebar | |
| 右栏 | right panel | panel、Close panel | |
| 引用（动作：选区浮层的按钮、会话菜单、回复下的按钮、拖到输入框） | Attach as context / Attach message as context / Drop to attach as context | Attach as context、Attach message as context | 负责人定：整个引用功能在界面上用 Claude 的 context 说法。Claude 的 Code 标签页把"把消息、选区、会话带进下一条消息"叫这个（"Right-click a message or select text → Attach as context"） |
| 引用（芯片、预览） | Context · …（芯片、读取中的芯片、预览标题）/ Remove context / Cancel attaching “<name>” / Not attached / the attached text | Attached context | 负责人定；读屏名在 "Context" 后用冒号（"Context: src/a.ts · lines 3–5, jump to source"、"Remove context: …"）。给模型的文字不变，仍是 "Quoting …:" 和 "[Quote] …"。工作回顾里反馈记录的 "Quoted text" 是反馈针对的原文，不属于这个功能，不改 |
| 问 Mori | Attach as context | Attach as context | 负责人定：选区浮层的按钮与会话菜单同一个词；操作记录 "Attach as context (file)" / "Attach as context (response)" |
| 反馈（选区） / 反馈这条回复 | Feedback / Give feedback | Feedback、Give feedback | |
| 工作回顾 | Review | Review | 负责人定；导航和页标题 |
| 对内容的反馈（分节） | Feedback | Feedback | |
| 界面问题 / 报告界面问题 | UI issue（报告标题）、UI issues（分节）/ Report a UI issue | —（Claude 的 "Report a bug" 是发给 Anthropic 的，不是一回事） | |
| 已处理 / 未处理 | Resolved / Unresolved | Resolved | 动作 "Resolve" / "Reopen"（Claude 评论用的词），"Hide resolved" / "Show resolved" |
| 回到原位置 / 回到原会话 | Jump to source / Jump to session | Jump to session | |
| 原文已变化 | Source changed | —（最近的是 "Outdated"） | 与 "Jump to source" 同一个 source；工作回顾里只写原因 "This response is no longer in the session." |
| 原会话已删除 | Session deleted | Session deleted | |
| 文件已被删除或移动 | File not found | File not found | 芯片和阅读器同一句 |
| 思考（内容） | Thinking…（进行中）/ Thought process（完成后的块） | Thinking…、Thought process | |
| 思考强度 | Effort | Effort、Effort: {value}、Default effort level | 会话定的（待负责人确认），不用 "Thinking"；pi 叫 thinking level；"支持思考" 仍写 "Supports thinking" |
| 思考强度的档位 | Off / Minimal / Low / Medium / High / Extra high / Max | Off / — / Low / Medium / High / Extra high / Max | minimal 没有 Claude 对应，用 pi 的名字 |
| 上下文 / 上下文用量 / 上下文长度 | Context / context usage / Context window | Context、Context window | |
| 压缩（较早的对话） | Compacting session… / Compacted session | Compacting session…、Compacted session | |
| 工具卡状态 | Preparing… / Queued / Waiting for your approval / Running… / Done / Failed / Denied / Stopped / Interrupted | 全部同左 | 失败时 "Failed · Exit code N" |
| 工具卡标题：读取 / 修改 / 写入 / 运行 / 搜索 / 查找 / 列目录 | Read / Edit / Write / Run / Search / Find / List | Read、Edit、Write、Run、Search、Find、List | 标题不随状态变，所以不用 Claude 的 Reading… / Ran |
| 工具卡分节：参数 / 输出 / 写入的内容 | Input / Output / File content | Input、Output、File content | |
| 退出码 | Exit code N | Exit code {code} | |
| 后台进程 | Mori’s background process（F8 字段名 "Background process"） | — | 意外退出一律写 "crashed"（Claude："Claude Code crashed"），不写 "stopped"；"Stopped" 只留给停止按钮的结果 |
| 重新载入（后台进程） | Restart / Restarting… / Restarted | Restart、Restarting Claude Code on {host}… | Claude 重启本地进程用 restart；"Reload" 只留给文件阅读器的 "Reload file" |
| 设置 | Settings / Open settings / Go to settings | Settings、Open settings、Go to settings | |
| 返回会话 | Back to app | Back to app | 设置、Customize、Review 三页的返回按钮，操作记录同 |
| 工具（页） | Customize（导航、页标题、F8 的 Page、操作记录 "Open Customize"） | Customize | Claude 开关技能、插件、连接器的页面叫 Customize；Claude 单独的 "Tools" 不是页名。分节标题 Built-in tools / Skills / Plugins / MCP 不变 |
| 内置工具 | Built-in tools | Built-in | |
| 技能 | skill / Skills | Skills、Skill | |
| 插件 / 包 | plugin / Plugins | Plugins、Add plugin | 只有讲 pi 包格式时写 "pi package" |
| 扩展 / 提示词 / 主题 | Extensions / Prompt templates / Themes | Extensions、Themes | 提示词与 "/" 列表同叫 prompt templates；开关的读屏名和操作记录用单数（Enable extension x、Enable prompt template x） |
| 提示词模板 | prompt templates | — | "/" 列表的读屏名是 Claude 的 "Slash commands" |
| MCP 服务 | MCP server | MCP server | |
| 直接调用 / 调用方式 | direct calls / Direct、codemode、Deferred、Hidden | — | 标签照 pi 的取值；正文说 "direct calls"，不写 v0 |
| 用户级 / 本项目 | User / Project（标签）；user-level / this project（正文） | User、Project | |
| 启用 / 停用 | Enable / Disable（动作）；Enabled / Not enabled（状态） | Enable {name}、Enabled | |
| 连接 / 连接与模型 | connection / Connections and models | Connection、Add connection、Edit connection | |
| 服务地址 / 接口类型 / 模型 ID | base URL / API type / model ID | Gateway base URL、Model ID | |
| 测试连接 | Test connection / Test / Testing… | Test connection、Testing… | |
| 连接成功 / 连接失败 | Connected · … / Connection failed: … | Connected · {latency}ms、Connection failed: {error} | 毫秒和秒一样不加空格（120ms、5s） |
| 默认 / 设为默认 | Default / Set as default | Default、Set as default | |
| 模型 | model / Model: <id> | Model、Model: {name} | |
| 信任 | trust / Trust workspace / Don’t trust | Trust this workspace?、Trust workspace、This workspace isn’t trusted、Trust settings couldn’t be saved.、Couldn’t check whether this workspace is trusted. | 会话定的（待负责人确认）：讲信任时一律叫 "workspace"（Claude 的说法），打开时仍叫 "folder" |
| 配置（文件夹自带的） | settings | — | "its own extensions or settings" |
| 草稿 | draft | — | 界面上目前没有出现这个词 |
| 阶段行 | Status line（F8 字段名） | — | 内容见下面"会话" |
| 保存 / 保存中… / 已保存 | Save / Saving… / Saved | Save、Saving…、Saved | |
| 正在读取… / 重新读取 | Loading… / Retry（失败后）、Reload file（阅读器） | Loading…、Retry、Reload file | |
| 用系统编辑器打开 | Open in default app | Open in {editor}、Default app | 打开失败："Couldn’t open this file with the default app: …" |
| 打开所在文件夹 | Show in Explorer | Show in Explorer | Mori 只在 Windows 上运行 |
| 只作用于这个会话 | Applies to this session only. | Applies to this session only | |
| 对新建的会话生效 | Applies to new sessions | Applies to new sessions. | |
| 已经打开的会话 | sessions already open | — | |
| 扩展的询问 | An extension needs your input | An integration needs your input | |

## 按屏的固定说法

### 侧栏和会话列表

| 中文 | 英文 |
| --- | --- |
| 新会话 / 打开文件夹… / 工具 / 工作回顾 / 报告界面问题（F8） / 设置 | New session / Open folder… / Customize / Review / Report a UI issue (F8) / Settings |
| 展开侧栏 / 收起侧栏 | Open sidebar / Close sidebar（收起时带状态："Open sidebar (a session needs approval)"、"(a session needs input)"、"(a session has an error)"、"(a session has unread results)"） |
| 后台进程退出后导航不可用的提示 | Mori’s background process crashed. Restart it to continue. |
| 正在读取会话… / 读取会话列表失败：… / 重试 | Loading sessions… / Couldn’t load sessions: … / Retry |
| 已归档 N | Archived N |
| 会话行状态：等你批准 / 等你回答 / 生成中 / 出错 / 有新结果 | Needs approval / Needs input / Running / Error / Unread |
| 菜单：重命名 / 引用到当前会话 / 在右侧分屏打开 / 归档 / 恢复 / 删除 | Rename / Attach as context / Open in split view / Archive / Unarchive / Delete… |
| 菜单项不可用的原因 | No active session / This is the current session / No messages yet / Already open / Opening… / Still running |
| 永久删除会话'名字'？ | Delete “<name>”? |
| 对话记录会被删除，无法恢复。 / 这个会话还没有消息。 | This session will be permanently deleted. This can’t be undone. / This session has no messages yet. |
| 改名失败 / 删除失败 / 归档失败 | Couldn’t rename this session: … / Couldn’t delete this session: … / Couldn’t archive this session: … |
| 拖动提示 | Drop to open this session / Drop to attach as context / Already open · Drop to switch to this pane / Drop to open in split view on the left（right） |
| 重新启动后的提示 | Restarted · Queued messages, pending approvals, and “Allow for this session” choices weren’t restored / Restarted · This session had no messages yet and was reopened |
| 分屏标题的悬停说明 | Right-click for the session menu. Drag to the other pane’s message box to attach it as context, or to one side to open it in split view. |

### 会话（对话、输入框、阶段行）

| 中文 | 英文 |
| --- | --- |
| 新会话的标题 | New session |
| 空白页 | Pick a session on the left to continue, or open a folder to start a new session. / Open a folder / Choose a project folder to start a session. / Opening <folder>… |
| 首次启动 | Connect a model / Enter the base URL, API key, and model ID, then test the connection. / Connected |
| 上下文 | Context 42% / Context —（刚压缩过："Just compacted. Context usage shows after the next response."）；读屏名 "Context usage 42%, about 53,760 of 128,000 tokens"，悬停 "About 53,760 / 128,000 tokens" |
| 后台进程意外退出 | Mori’s background process crashed · Unfinished responses were interrupted / Restart / Restarting… |
| 输入框不能发送时 | Mori’s background process crashed / Restarting… / Starting… / Session didn’t open |
| 打开失败 | Failed to open session: … |
| 输入框的读屏名 | Message Mori（会话定的，待负责人确认；不用 Claude 式的 "Reply to Mori"） |
| 按键提示 | Enter to send · Shift+Enter for new line / Enter to queue · Ctrl+Enter to steer · Shift+Enter for new line |
| 发送 / 停止 / 排队发送 / 插话 | Send / Stop（悬停 "Stop response (Esc)"）/ Queue（悬停 "Send after the current turn (Enter)"）/ Steer |
| 排队区 | 标签 Queued / Steer，按钮 Withdraw |
| 阶段行：等你批准 / 等你回答 | Waiting for your approval / Waiting for your answer |
| 阶段行：等待模型响应 / 思考中 / 生成中 | Waiting for the model… 12s / Thinking… 5s / Responding…（会话定的，待负责人确认；不用 Claude 的 "Writing…"） |
| 阶段行：工具 / 重试 / 压缩 | <工具卡标题> 8s（如 "Run npm test 8s"）/ Retrying (1/3) · <错误原文> / Compacting session… |
| 对话流里 | Thought process / Thinking… / Copy code / Compacted session / Stopped · Changes made so far stay as they are / Extension: … / Skill · <name> / Expand / Collapse |
| 滚动 | Scroll up to load earlier messages / Jump to latest |
| 错误卡 | Go to settings / Put your last message back in the message box |
| 回复下的按钮 | Copy / Copied / Copy failed / Attach message as context / Give feedback |
| 停止的原因 | You pressed Stop |
| 信任横幅 | This workspace isn’t trusted, so its extensions and settings weren’t loaded · You’ll be asked again after you restart Mori（或 "To change your remembered choice, delete this workspace’s entry from <dir>\trust.json and reopen the session"）/ This workspace now has its own extensions or settings, which weren’t loaded this time · You’ll be asked when you start a new session / Some extensions didn’t load: / Couldn’t save trust settings: … |

### 工具卡、批准卡、权限、扩展询问、信任

| 中文 | 英文 |
| --- | --- |
| 工具卡标题 | Read src/a.ts · lines 10–29 / Read src/a.ts · from line 10 / Run npm test / Edit src/a.ts / Write src/a.ts / Search / Find / List |
| 工具卡状态 | 见术语表；失败的命令 "Failed · Exit code 1" |
| 标签 | Allowed for this session / Allow all |
| 批准卡标题（bash） | Run a command |
| 批准卡按钮 | Allow once / Allow “Run commands” for this session / Deny |
| 拒绝理由 | Tell the model why (optional) |
| 按钮下的说明 | You won’t be asked again for any command in this session. / You won’t be asked again for “Edit files” in this session. |
| 警告 | This file is outside the working directory / Contains hidden characters, shown as ⟨U+XXXX⟩ |
| 还有 N 张 / 还有 N 个 | {n} more |
| 权限按钮 | 悬停 "Set the permission mode for this session"；读屏名 "Permission mode: Ask each time"（窄栏只显示盾牌图标时靠它） |
| 权限菜单 | Ask each time / Allow all / Allowed for this session: / Forget / None / Applies to this session only. New sessions start with “Ask each time”. |
| 切到全部允许的确认 | Switch to “Allow all”? / Edits, writes, and commands will run without asking. / Allow all |
| 扩展询问 | An extension needs your input / Yes / No / Submit / Cancel / {n} more / This request expires in 1 second（N seconds） |
| 信任询问 | Trust this workspace? / This workspace has its own extensions or settings. If you trust it, they’ll run on your computer. / Remember my choice / Trust workspace / Don’t trust / Couldn’t check whether this workspace is trusted: … |

### 选区、引用芯片、会话引用

| 中文 | 英文 |
| --- | --- |
| 选区弹出的按钮 | Attach as context / Feedback |
| 芯片 | src/a.ts · lines 3–5 / Response / Context · <会话名> · turns 3–8 · ~3,200 characters（读屏名 "Context: src/a.ts · lines 3–5, jump to source"；× 的读屏名 "Remove context: <芯片上的字>"，悬停 "Remove context"） |
| 芯片上的标记 | Source changed / File not found / Session deleted |
| 读取中的芯片 | Context · <会话名> · Loading…（× 的读屏名 "Cancel attaching “<会话名>”"） |
| 会话引用的预览 | Context · <name> / Turn N · ~1,200 characters · Not attached / From … to … / Done / Cancel / Close |
| 预览的说明 | This session is still running. Only the N finished turns are listed.（只有 1 轮时 "Only 1 finished turn is listed."）/ Source changed · Showing the attached text（还有 Session deleted · …、The session no longer has finished turns · …、Couldn’t read the session: … · …）/ The session changed since you attached it, so the range was reset to the default. |
| 没能加入 | “<name>” has no finished turns yet, so there’s nothing to attach. / Couldn’t attach “<name>” as context: … |
| 反馈表单 | What result were you hoping for? / This is only saved to Review and isn’t sent to the model. To have Mori act on it, use “Attach as context” instead. / Save / Saving… / Saved · View in Review |
| 带引用的消息打开 "/" 列表 | Prompt templates and skills don’t work in a message with attached context. Remove the context first. |

### 右栏（改动、文件阅读器）

| 中文 | 英文 |
| --- | --- |
| 本会话的改动 | This session’s changes（顶栏开关的读屏名 "Toggle changes"） |
| 还没有改动 | No changes yet. / Only edits and writes are listed. Files changed by commands aren’t included. |
| N 次 / 第 N 次 · 修改 | 1 change（N changes）/ Change N · Edit（Write） |
| 写入的内容 | File content |
| 阅读器 | Loading… / File not found / Source changed · Attached text: / Preview unavailable · Binary file / Preview unavailable · This is a folder / Couldn’t read this file: … / Reload file / Open in default app / Close panel |

### 设置

| 中文 | 英文 |
| --- | --- |
| 页头 | Back to app / Settings / Connections and models |
| 连接 | Add connection / Edit connection · <name> / Add model / Edit model / Test / Test connection / Testing… / Set as default / Default / Edit / Delete…（确认框 "Delete model <id>?" 里的按钮是 Delete） |
| 表单字段 | Name / Base URL / API type / Model ID / Context window / Compatibility options / Supports thinking / Default effort for new sessions |
| 兼容选项 | 标签都写端点的情况：Endpoint doesn’t support the developer role / Endpoint doesn’t accept the store field / Endpoint needs max_tokens instead of max_completion_tokens / Endpoint doesn’t report usage while streaming / … |
| key | Kept encrypted on this computer after you save / Saved and encrypted · Re-enter it if you change the base URL / Key saved (encrypted) / No key |
| 测试结果 | Connected · First token 120ms · Total 950ms · Includes thinking · Response: … / Connection failed: … / No response / Test cancelled / Couldn’t test the connection: … |
| 保存 | Save / Saving… / Saved / Couldn’t save: … / Saved, but the configuration has an error: … |
| 模型行 | Context window: 128,000 · Supports thinking · Default effort: High / Doesn’t support thinking |
| 模型菜单 | Model: <id> / <id> (deleted) / No models available / Applies to this session only. New sessions use the default model from Settings. / Manage models |
| 思考强度菜单 | Effort: High / Unavailable / Applies to this session only. Set each model’s default for new sessions in Settings. / Open settings |
| AGENTS.md | User / In effect: <path> / <path> takes precedence, so what you write here has no effect. / <path> is in effect now. After you save, this AGENTS.md is loaded instead. / Save / Discard changes / Unsaved changes / Saved · Applies to new sessions / Open in default app |
| 离开确认 | Discard changes to AGENTS.md? / Your edits haven’t been saved. Leaving now discards them. / Discard / Keep editing |

### Customize 页（工具页）和 "/" 列表

| 中文 | 英文 |
| --- | --- |
| 页头 | Back to app / Customize（分节导航的读屏名 "Customize page sections"：Claude 的 "Customize sections" 是另一个命令）/ Changes apply to new sessions. Sessions already open aren’t affected. / New session |
| 分节 | Built-in tools / Skills / Plugins（MCP 服务一节 "MCP"） |
| 状态 | Enabled / Not enabled / Running · Used by 1 session（N sessions）/ Running · Not in use / Starting… / Failed: … |
| 作用范围 | User / Project |
| MCP | Edit / Edit as JSON / Remove…（确认框里是 Remove）/ Removing… / Remove MCP server “<name>”? / Saved · Only new sessions will connect to it / No MCP servers yet / Add / This server is set to “codemode”. Mori only supports direct calls, so the model can’t call its tools. / Switch to direct calls / Name is required. |
| 插件 | Extensions / Skills / Prompt templates / Themes / Enable all / Disable all / Remove…（确认框里是 Remove）/ Add plugin from folder… / Adding… / Plugins must be local folders that include their dependencies. Nothing is downloaded. / No plugins yet / Folder not found / Not used by Mori / Remove plugin “<path>”? |
| 只读的原因 | Set in this project’s .pi/mcp.json. To change it, edit that file. / Turned off（on）in this project’s .pi/settings.json. To change it, edit that file. / Only plugins from local folders are supported, so this one won’t be installed. You can remove it. |
| 不信任时 | This workspace isn’t trusted, so its skills and settings aren’t listed |
| "/" 列表 | Prompt templates / Skills / Loading… / No matching prompt templates or skills / This session has no prompt templates or skills. Add them in Customize. |

### F8 报告框

| 中文 | 英文 |
| --- | --- |
| 标题 | Report a UI issue |
| 字段 | What went wrong / What you expected |
| 说明 | Includes a screenshot, the current view, and your recent activity. Saved on this computer and never sent to the model. |
| 按钮和结果 | Save / Saving… / Cancel / Saved to <file> / Show in Explorer / View in Review / Close |
| 错误 | Couldn’t capture a screenshot: … / Couldn’t save the report: … |

### 工作回顾

| 中文 | 英文 |
| --- | --- |
| 页头 | Back to app / Review |
| 分节 | Feedback / UI issues |
| 工具行 | Hide resolved / Show resolved / Export as Markdown… / Open folder / Exported 1 record（N records）to <file> / Show in Explorer |
| 列表 | Resolved / No screenshot / No unresolved records · 1 resolved record hidden（N resolved records） / Couldn’t read the record <文件名> |
| 空的时候 | No feedback yet. Select text in a response or the file viewer and click “Feedback”, or use “Give feedback” under a response. / No UI issues yet. Press F8 to report one. |
| 详情 | Resolve / Reopen / Jump to source / Opening… / Show in Explorer / Session / File / Scope / Working directory / (not recorded) / What you hoped for / Quoted text |
| 回不到原位置 | Session deleted / This response is no longer in the session. / The session wasn’t saved, so there’s no source to jump to. / Mori’s background process crashed. Restart it to continue. / Sessions are still loading. Try again in a moment. / The original session isn’t in your session list. |
| 报告详情各节 | What went wrong / What you expected / Screenshot / Current view / Recent activity / Versions |

## Mori 写出的文字的完整格式

下面这些文字会被别处的代码按原样解析或拼回（标 "解析"），写的一方和读的一方必须用完全相同的字串。

### 发给模型的引用块（解析：`quoteText.ts` `stripQuotes` 按 `quoteBlock` 重新拼出前缀比对）

每个芯片一段，第一行是下面的开头，之后每行原文前加 `> `，段之间空一行，最后空一行接你写的字：

```
Quoting your earlier reply:
Quoting src/a.ts, line 3:
Quoting src/a.ts, lines 3–5:
Quoting session “Fix login”, turn 3:
Quoting session “Fix login”, turns 3–4:
```

行和轮的范围由 `lineText` / `turnsText` 给出：`line N`、`lines a–b`、`turn N`、`turns a–b`（"–" 是 U+2013）。同一对函数也给芯片（"src/a.ts · lines 3–5"）和工作回顾的范围（同样用 " · "："src/a.ts · lines 3–5"）。

### 会话引用的内容（解析：同上，`sessionRefs.ts` 调用 `stripQuotes`）

每轮一段，以 `Turn N` 开头，轮之间空一行：

```
Turn 3
User: <你写的字>
[Quote] src/a.ts, lines 3–5
[Quote] an earlier assistant reply
[Quote] session “Fix login”, turns 1–2
Assistant: <回复正文>
[Tool] Run npm test
```

`[Tool]` 后面是工具卡标题（`toolTitleText`），如 `Read src/a.ts · lines 10–29`；所以 `toolTitle.ts` 的动词和行范围也是给模型读的文字。

### F8 报告（解析：`main/review.ts` 的标题正则、`ISSUE_SECTIONS`、截图正则）

```
# UI issue · 2026-10-21 14:03:22

## What went wrong

<你写的；没写时 (left blank)>

## What you expected

<你写的；没写时 (left blank)>

## Screenshot

![Screenshot](2026-10-21-140322.png)
（截不到时：Couldn’t capture a screenshot: <原文>）

## Current view

- Page: Session
- Current session: Fix login
- Folder: D:\code\app
- Session file: <路径>（还没有时 Not saved yet）
- Model: <id>（没有时 None）
- Running: Yes / No
- Status line: Thinking… 5s（不显示时 Hidden）
- Pending requests: 0
- Permission mode: Ask each time / Allow all
- Split view: Left: <名字> · Right: <名字> (focus in the left pane)
- Right panel: Open / Closed
- Window size: 1280×800
- Sidebar width: 260px（收起时 Hidden (saved width 260px)；被收紧时 220px (saved width 260px)）
- Right panel width: 420px
- Background process: Starting… / Running / Crashed / Restarting…

## Recent activity

- 14:02:58 Open session D:\…\session.jsonl
- 14:03:10 Send: <消息的前几十个字>

## Versions

- Mori: 0.1.0
- Electron: …
- Chromium: …
- Node: …
- Windows: …
```

- 没打开会话时 "Current session: None" 一行代替会话的几项；"Page" 的取值：Session / Settings / Customize / Review / First run / Loading connections… / Couldn’t load connections。
- 解析要求：标题行 `/^# UI issue · (.+)$/`；六节的标题与 `ISSUE_SECTIONS` 一字不差（What went wrong、What you expected、Screenshot、Current view、Recent activity、Versions）；截图行 `/^!\[Screenshot\]\((.+)\)$/`；截图失败行写成 `Couldn’t capture a screenshot: <原文>`（撇号是 U+2019，冒号后一个空格），读的一方用 `/^Couldn’t capture a screenshot:\s*/` 去掉前缀（各节读出来时去掉了首尾空白，原文为空时冒号后就没有空格）；"(left blank)" 与 `reviewText.ts` 的 `EMPTY_FIELD` 相同。
- 报告里你写的一行如果像 Markdown 标题，前面加 `\`，不会被当成一节。

### 工作回顾的导出

默认文件名：`feedback-<YYYY-MM-DD>.md`、`ui-issues-<YYYY-MM-DD>.md`（与记录文件夹 `feedback/`、`ui-issues/` 同名；保存对话框标题 "Export as Markdown"）。内容：

```
# Feedback

Exported 2026-10-21 14:10:05 · 3 records: 2 unresolved, 1 resolved

## 1. 2026-10-21 13:55:12 · Unresolved

- Session: Fix login（没有名字时 Untitled session）
- Scope: Selection in response / Whole response / File D:\code\app\src\a.ts, lines 3–5（导出写的是绝对路径 source.path，不是相对路径）
- Session file: <路径>（没有时 (not saved)）
- Working directory: <路径>（不知道时 (unknown)）
- Record file: <路径>

### What you hoped for

<原文>

### Quoted text

> <原文>
```

界面问题的导出开头是 `# UI issues`；每条在 "- Report file: <路径>" 之后照搬报告的六节，标题降为 `###`。读不出来的记录：`## N. <文件名> · Unresolved`、"- Record file: <路径>"、"Couldn’t read this record: <原文>"。只有一条时写 "1 record"。

### 操作记录（写进 F8 报告的 "Recent activity"）

每行 `- HH:mm:ss <动作>`。动作用控件上的字、祈使句，带对象时用 "动作: 对象" 或 "动作 对象"：

| 动作 | 写法 |
| --- | --- |
| 发送 / 排队 / 插话 | Send: <前几十个字> / Queue: … / Steer: … |
| 停止 / 撤回 | Stop / Stop response (Esc) / Withdraw queued messages |
| 批准卡 | Permission request: Allow once / Allow for this session / Deny（写了理由时加 " (reason: …)"） |
| 权限 | Permission mode: Allow all / Ask each time / Forget “Allow for this session”: <工具> |
| 会话 | New session / New session in <dir> (trusted, remembered) / Open session <file> / Switch session / Back to app / Rename: <名字> / Archive session / Unarchive session / Delete session / Close session (before archiving or deleting) / Close pane / Open in split view on the left（right）/ Drag an open session to the center / Retry opening session |
| 信任询问 | Trust prompt: Trust workspace (remembered) <dir> / Trust prompt: Don’t trust <dir> |
| 引用 | Attach as context (file) / Attach as context (response) / Attach session as context / Open file / Open file from attached context / Jump to response from attached context / Jump to session from attached context |
| 反馈 | Copy response / Give feedback on response / Give feedback on selection |
| 扩展询问 | Extension question: answered / Extension question: cancelled |
| 设置 | Save connection（新建，还没有 id）/ Save connection <id> / Test connection / Cancel connection test / Add model <provider>/<id> / Save model <provider>/<id> / Delete model <provider>/<id> / Set default model: <provider>/<id> / Switch model for this session: <id> / Change effort for this session: <level> / Save user-level AGENTS.md |
| Customize 页 | Open Customize / Enable（Disable）<单数的类别> <path>（Enable skill …、Disable extension …、Enable prompt template …）/ Enable all in plugin（Disable all in plugin）<source> / Add plugin from folder <path> / Remove plugin <source> / Save MCP server <name> / Enable（Disable）MCP server <name> / Remove MCP server <name> / Switch MCP server <name> to direct calls |
| 工作回顾 | Open Review / View in Review / Review: Feedback / View record: UI issues / Resolve / Reopen / Hide resolved / Show resolved / Export: Feedback / Open folder: UI issues / Show record in Explorer / Jump to source from Review |
| 其他 | Report a UI issue / Restart background process / Go to settings / Open settings |

"Feedback"、"UI issues" 是分节名（大写开头），所以放在冒号后面，不嵌进句子中间。

## 实现时要一起改的地方

- 复数：标 `"plural": true` 的条目要按数量选单复数（导出条数、隐藏条数、改动次数、字数、MCP 服务的会话数、已完成的轮数、模型数、剩余秒数）。
- `ToolsPlugins.tsx` 的开关读屏名要单数（Enable extension x），需要一张单数的分类名表 `KIND_ONE`（extension / skill / prompt template / theme，放在 `shared/protocol.ts` 的 `RESOURCE_KINDS` 旁边）；分节标题仍用复数。`actionLog.ts:93` 的操作记录也用这张表（`command.kind` 是 pi 的复数键）。
- `Sidebar.tsx:66` 收起侧栏时的读屏名要一张小写分句的表 `RAIL_TEXT`（a session needs approval / a session needs input / a session has an error / a session has unread results），不再拼 `STATUS_TEXT`。
- `ChatPane.tsx:50` 上下文用量的读屏名自己拼（"Context usage 42%, about 53,760 of 128,000 tokens"），不再复用悬停说明 `detail`。
- `state/transcript.ts:302` 重试的 detail 改成 `(${attempt}/${maxAttempts}) · <错误>`，阶段行读作 "Retrying (1/3) · …"。
- 中文 "、" 拼接改成 ", "（`ToolsMcp.tsx` 两处）。
- `reviewText.ts:26` 文件范围在路径和行范围之间加 " · "（"src/a.ts · lines 3–5"），同芯片。
- `main/review.ts:141` 截图失败的正则改成 `/^Couldn’t capture a screenshot:\s*/`（见上 "F8 报告"）。
- 导出的默认文件名按类别取 `feedback` / `ui-issues`，不再用分节名（见上）。
- 已经是英文、但用词要跟着改的错误原文（没有中文，所以清单里原来没有；`translations.json` 里都有条目）：`kernel/config.ts` "API key is required when the base URL changes"（界面上前面加 "Couldn’t save: "，`tests/ui/m0-smoke.mjs:99`、`tests/ui/m6-app-settings.mjs:738` 跟着改成 "Couldn’t save: API key is required when the base URL changes"）；`kernel/sessions.ts:412` 和 `state/projects.ts:180` 同一句 "This session is still running. Stop it first."，`state/projects.ts:182` 跟着它改成 "This session is still opening."；`preload/index.ts:40`、`:62` "Mori’s background process crashed (exit code N)"（`tests/ui/harness/replay.js:457` 跟着改）；`kernel/mcpConfig.ts:388` "Mori only supports direct calls (exposure: direct)."（`tests/ui/m6-app-tools.mjs:1127-1128` 跟着改，record() 的说明也改）；`kernel/resources.ts:299` "<path> is read-only in Customize"、`:343` "This plugin is already added"、`:357` / `:366` "Plugin <source> isn’t in your user-level settings"（`:305` 原来是 "Package … is not in the settings"，`translations.json` 里没有条目，只会在用户级的包上报出，改成同一句）；`main/review.ts:107` 的引号改成 “ ”。
- 审查后补的（2026-10-21）：`main/index.ts` 在 ready 之前 `app.commandLine.appendSwitch('lang', 'en-US')`（不写时 Chromium 按 Windows 显示语言选，中文 Windows 上上下文长度填 0 时浏览器弹出"值必须大于或等于 1。"）；`ConnectionForm.tsx`、`ModelForm.tsx` 的 `<form>` 加 `noValidate`（`min={1}` 不再先被浏览器拦下，Mori 的说明才看得到；`m6-app-settings` 两项检查）；选文件夹对话框加 `title` / `buttonLabel`（`m1-app` 一项检查）。
- `src/renderer/index.html` 的 `<html lang="zh-CN">` 改成 `lang="en"`（读屏按它选语音，Chromium 按它回退字体）。
- `electron-builder.yml` 的 `nsis:` 下加 `installerLanguages: [en_US]`：不写时 electron-builder 打出带全部语言的安装包，中文系统上安装界面会是中文。
- `tests/check.mjs` 加一项：`src/` 里 .ts/.tsx 的字符串、模板字符串、正则字面量和 JSX 文本（用 TypeScript 语法树找），以及去掉注释后的 .html、.css 不能有中文（含中文标点、全角字符和假名），报 "<文件>:<行> contains Chinese text: …"；注释不查。
- 仓库根目录 `build-installer.cmd` 的输出只用英文：去掉文件末尾的中文提示和失败时切到 65001 用 `findstr` 取出它们的代码。仍要切到 437：实测控制台是 936（中文 Windows 的默认）时，cmd 会把含中文的 REM 注释拆开、把半句当命令执行；65001 和 437 下不切也正常。只在开头 `chcp 437` 还不够（electron-builder 启动的 PowerShell 会把控制台的输出代码页改成 65001，从 936 启动的 cmd 之后又读错），所以脚本记下原代码页、切到 437 后用新的 cmd 重新运行自己，结束时恢复原代码页（见 [english-ui-checks.md](english-ui-checks.md) "测试中发现并已修正的问题"第 5 条）。
- 顶栏宽度：`chat.css` 的 `@container` 阈值（720 / 600 / 480 / 400px）和 `models.css` 里思考按钮的档位是按中文字宽估的，要用英文重新量（"Effort: Unavailable"、"Extra high ▾"、"Ask each time"、"Allow all"、"Context 100%"；最窄是分屏每栏 280px、中栏 300px），并改那段注释。按 Segoe UI 12px 量，280px 一栏里 "Ask each time" + "High" 已经超出约 15px，所以 400px 以下权限按钮只显示盾牌图标（"Allow all" 保留警告色），模式名放进读屏名 "Permission mode: <模式>"（悬停说明不带模式名，是 "Set the permission mode for this session"）；按钮上的模式名包在 `.permission-text` 里，窄栏时由 `chat.css` 藏起。实际改成的阈值：760px 以下权限按钮去掉图标（`models.css` 里模型按钮 120px 的上限仍在 720px）；660px 以下不显示项目名和 ›（分屏 690px 起，`split.css`）；600px 以下内边距收小、菜单贴右；500px 以下不显示上下文用量；400px 以下权限按钮只显示盾牌。思考按钮的档位（`models.css` 720 / 600 / 400px）不变。工具卡的标题至少留 56px，徽标放不下时截断加省略号。
- 侧栏宽度：侧栏最窄 180px（`state/layout.ts` LIMITS）时，"Needs approval" 只给会话名留约 4px，"New session Ctrl+N" 会折行。侧栏做成 size container，窄于 220px（`@container (max-width: 219px)`；1024–1150px 宽窗口的默认宽度 220px 时仍显示文字，会话名留约 44px）会话行只显示状态圆点（状态文字 `.session-status-text` 用 clip 藏起，仍在读屏名里；title 在状态圆点上，不在会话行上），并隐藏 `.nav-hint`。
- 其他宽度：设置页左侧导航 180px 改成 200px（"Connections and models" 不折行）；设置页 760px 以下连接表单的标签放到输入框上面（已保存的 key 的提示 "Saved and encrypted · Re-enter it if you change the base URL" 约 350px，在 96px 标签列旁放不下；分节导航仍到 620px 才横排）；Customize 页 MCP 表单的标签列 84px 改成 132px（"Environment variables"、"Server config (JSON)" 不折行）；工具卡状态 `max-width: max(60%, 140px)`（"Waiting for your approval"、"Denied · You pressed Stop" 在分屏 280px 一栏里不截断）；会话右键菜单 `width: max-content`（"Attach as context" + "This is the current session" 约 280px，右边放不下时由 `SessionMenu` 往左挪，不被挤得折行）；会话菜单的项目名和不可用原因（`.menu-hint`）之间留 16px。
- 其他写出固定格式或界面文字的文档要跟着改（说明文字仍用中文；改成本文 "Mori 写出的文字的完整格式" 里的英文，或直接指向这一节）：
  - 引用和会话引用：`defaults.md:42`（引用块开头）、`:49`（字数含 "Turn N" 标题）、`:50`（"Turn N"、"User:"、"Assistant:"、"[Tool]"、"[Quote]"）、`:51`（"约 X 字" 改成 "~N characters"）；`screens/selection.md:61`；`screens/session-refs.md:19-51`、`:28`（"~N characters"）、`:65`（芯片 "Context · <会话名> · turns 3–8 · ~3,200 characters"）、`:80`（预览顶部的轮次范围和字数）。
  - F8 报告：`screens/f8.md:20`、`:42-48`（报告标题、各节、截图行、"Couldn’t capture a screenshot: …"、"(left blank)"）。
  - 工作回顾的导出：`defaults.md:86`（默认文件名 `feedback-<YYYY-MM-DD>.md` / `ui-issues-<YYYY-MM-DD>.md`）、`:87`（`# Feedback` / `# UI issues`、"Exported <time> · N records: a unresolved, b resolved"、"### What you hoped for"、"### Quoted text"、"Couldn’t read this record: …"）；`screens/review.md:104`（对话框标题 "Export as Markdown"、默认文件名）、`:112-120`（开头、条数、各节标题）；`m7-checks.md:147` 那条 "以后改成英文时要一起改工作回顾" 的提醒已经做完。
  - 设置：`screens/settings.md:60`（"Couldn’t save: API key is required when the base URL changes"）。
  - 顶栏和侧栏的宽度：`defaults.md:57`（≤ 760px 权限按钮去掉图标；≤ 720px 模型按钮最长 120px；≤ 660px（分屏 ≤ 690px）不显示项目名和 ›；≤ 600px 思考按钮只显示强度（"High ▾"）、菜单贴着面板右边；≤ 500px 不显示上下文用量；≤ 400px 去掉 ▾、权限按钮只留盾牌图标；字串 "Effort: Unavailable ▾"、"Ask each time"、"Context 100%"、"<ID> (deleted)"），并加一行侧栏窄于 220px 只留状态圆点、藏起 "Ctrl+N"（`:58`）；`screens/models.md:44` 起的 "窄栏" 一节（同样的阈值；"Effort: High ▾"、"Unavailable ▾"、"Model: <ID> (deleted)"、" (deleted)"）；`screens/approval.md:90`（400px 以下权限按钮只留盾牌）；`screens/chat.md:13`（480px 改成 500px；"Context 12%"、"Context —"、"About 15,360 / 128,000 tokens"）；`screens/sessions.md:58`（状态一行加侧栏窄于 220px 的例外）。
  - 仓库规则：`AGENTS.md:37` "界面文字用中文" 改成界面文字用英文（注释仍用中文），指向本文；`AGENTS.md:45`、`app/README.md:55` 的 `npm run check` 说明加 "界面字串不能有中文"；`app/README.md:39` 改成失败的一步只用英文写明。
- 测试要跟着改（`tests/ui` 里中文的 record() 说明和注释可以留）：
  - 断言界面文字、读屏名、title、F8 报告、导出、操作记录的地方都按 `translations.json` 和本文改成英文（`tests/ui/*.mjs` 几乎每个文件都有）。已知要点：`m2-app.mjs:36`、`:1049-1050`、`:1192-1204`；`m2-real.mjs:30`、`:560-561`、`:621`（"- Page: Settings"）；`m4-app.mjs:310-374`、`:695-696`（芯片 "README.md · lines 1–2"、"Quoting README.md, lines 1–2:"）；`m4-replay.mjs:184-220`；`m5-app.mjs:392-408`、`:438`、`:462`、`:482`、`:513-514`、`:534`、`:550`、`:576-577`；`m5-real.mjs:252-309`；`m5-replay.mjs:243-389`；`m7-app.mjs:89`、`:1404`（`ui-issues-*.md`）、`:160-175`、`:238-242`、`:804-821`、`:1093-1094`、`:1313-1315`（"Export as Markdown"、`feedback-<today>.md`）、`:1332-1395`、`:1700-1713`；`m7-real.mjs:71`、`:604-605`、`:622-624`、`:653-658`、`:724`。
  - `m7-helpers.mjs:204` 用 `/^Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? · (\d+) records?: (\d+) unresolved, (\d+) resolved$/`，`:210` 用 `/^- (?:Record file|Report file): (.+)$/`。
  - 顶栏窄栏：`m6-app-slash.mjs:882-897` 的 `barProblems` 改成 `permissionIcon: !narrow(760) || narrow(400)`（或看 `.permission-text` 是否可见：`!narrow(400)`）、`crumbLimit = pane.split ? 690 : 660`、`usage: narrow(500) ? false : pane.usageInDom`、前缀 "Effort: "，`:985`、`:1102`、`:1111` 的分档说明跟着改；`m6-app-settings.mjs:1786` 起的 `LEVEL_TEXT` 用 Off / Minimal / Low / Medium / High / Extra high / Max，"Unavailable"、`Effort: ${label}`、按钮名 "Toggle changes"（720 / 600 / 400px 的档位不变）。
  - `tests/ui/m4-record.mjs:116-129` 自己抄的 `quoteBlock` 改成英文格式（`Quoting your earlier reply:`、`` `Quoting ${displayPath(s.path, cwd)}, ${lines}:` ``，`lines` 是 `line N` / `lines a–b`），或像 `m5-record.mjs` 那样用 esbuild 引 `quoteText.ts`；`:280` 检查 `startsWith('Quoting src/a.ts, lines 1–3:')`。
  - 重新录制：`tests/fixtures/m4/quote-*.json`（4 个）、`tests/fixtures/m5/ref-*.json`（4 个），里面 Mori 写的 "引用…："、"第 N 轮"、"用户："、"助手："、"[工具] …"、"[引用] …" 要变成英文（模型自己写的中文可以留）；`tests/fixtures/m7/review-reply.json` 用 `tests/ui/m7-record.mjs` 重新录（报告里的 "- 页面：…"、"- Mori：…"）。
  - `tests/ui/harness/replay.js:457` 改成 `new Error('Mori’s background process crashed (exit code 1)')`；`tests/ui/harness/index.html` 改成 `<html lang="en">`，与 `src/renderer/index.html` 一致。
- 不改行为（会话定的，待负责人确认）：读一行时工具卡仍写 "lines 5–5"（`toolTitle.ts:78`）；MCP 表单在表单和 JSON 之间切换失败时，问题仍显示在 "Couldn’t save:" 后面（`ToolsMcpForm.tsx:160`）。
