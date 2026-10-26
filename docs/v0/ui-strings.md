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
| 在这个项目里新建会话（项目行的 +） | New session in <folder> | New session in {folder} | 项目行右端 + 的读屏名和悬停，<folder> 是项目行显示的文件夹名（2026-10-26，负责人走查 M9）；操作记录仍写 "New session" |
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
| 右栏占满 / 回到原宽度（2026-10-26） | Expand / Collapse | Expand、Collapse（pane 上的图标按钮） | 读屏名和悬停说明都用这两个词；Claude 的快捷键 "Expand or collapse pane" 没有照搬 |
| 引用（动作：选区浮层的按钮、会话菜单、回复下的按钮、拖到输入框） | Attach as context / Attach message as context / Drop to attach as context | Attach as context、Attach message as context | 负责人定：整个引用功能在界面上用 Claude 的 context 说法。Claude 的 Code 标签页把"把消息、选区、会话带进下一条消息"叫这个（"Right-click a message or select text → Attach as context"） |
| 引用（芯片、预览） | Context · …（芯片、读取中的芯片、预览标题）/ Remove context / Cancel attaching “<name>” / Not attached / the attached text | Attached context | 负责人定；读屏名在 "Context" 后用冒号（"Context: src/a.ts · lines 3–5, jump to source"、"Remove context: …"）。给模型的文字不变，仍是 "Quoting …:" 和 "[Quote] …"。工作回顾里反馈记录的 "Quoted text" 是反馈针对的原文，不属于这个功能，不改 |
| 问 Mori | Attach as context | Attach as context | 负责人定：选区浮层的按钮与会话菜单同一个词；操作记录 "Attach as context (file)" / "Attach as context (response)" |
| 反馈（选区） / 反馈这条回复 | Feedback / Give feedback | Feedback、Give feedback | |
| 工作回顾 | Review | Review | 负责人定；导航和页标题（v1：见 docs/specs/memory.md §10.1：工作回顾页由记忆页替换，导航和页标题改为 "Memory"，见下面 "记忆" 一行；UI issues 移到设置页，§10.8） |
| 对内容的反馈（分节） | Feedback | Feedback | （v1：见 docs/specs/memory.md §10.7：这一节不再有，反馈出现在它支撑的条目的 Evidence 和用到它的修订里） |
| 界面问题 / 报告界面问题 | UI issue（报告标题）、UI issues（分节）/ Report a UI issue | —（Claude 的 "Report a bug" 是发给 Anthropic 的，不是一回事） | （v1：见 docs/specs/memory.md §10.8："UI issues" 是设置页的第三节） |
| 已处理 / 未处理 | Resolved / Unresolved | Resolved | 动作 "Resolve" / "Reopen"（Claude 评论用的词），"Hide resolved" / "Show resolved" |
| 回到原位置 / 回到原会话 | Jump to source / Jump to session | Jump to session | |
| 原文已变化 | Source changed | —（最近的是 "Outdated"） | 与 "Jump to source" 同一个 source；工作回顾里只写原因 "This response is no longer in the session." |
| 原会话已删除 | Session deleted | Session deleted | |
| 文件已被删除或移动 | File not found | File not found | 芯片和阅读器同一句 |
| 记忆 | Memory | — | v1（docs/specs/memory.md §1、§10.1）：左栏入口（在原来 Review 的位置）、页标题、F8 的 Page、操作记录 "Open Memory"；四种条目的统称 |
| 事实（种类） | Facts | — | 记忆页的分节；工具结果里同样写 "Facts"（"Saved to Facts (user level): …"）（记忆规格 §1、§7.4） |
| 三种规则（种类名） | TASTE / STRATEGY / REVIEW | — | 名字，全大写照 proposal，句子里不改写（"Running STRATEGY enhancement…"）；"REVIEW" 是一种条目，不是工作回顾的 "Review"（记忆规格 §1） |
| AGENT（记忆页的分节） | AGENT | — | 列出这个项目加载的 AGENTS.md；文件名照写 AGENTS.md（记忆规格 §10.3）；用户级那一行的链接 Edit in Customize（2026-10-26 改，原来 Edit in Settings），合计 "<total> / 2,000 tokens" |
| 修订记录 | Revisions | — | 记忆页的分节；条目详情里改过它的记录叫 "History"（记忆规格 §10.1、§10.5） |
| 增强模式 / 增强任务 | Enhancement（开关、对话框 "Enhancement settings"）/ enhancement（句子里） | — | "Running TASTE enhancement…"、"Created Oct 23 by enhancement"；操作记录 "Turn on enhancement <cwd>"（记忆规格 §1、§8、§10.4） |
| 你说的 / Mori 记的 / 它学的 | You said / Added by Mori / Learned | Added by Claude（Mori 记的那一个） | 条目行右边的标记、详情的第二行；在记忆页新增或修改后都是 "You said"；"Added by Mori" 是主 Agent 没被要求时主动记的（2026-10-26，记忆规格 §0 第 5 条、§1、§10.1）；增强任务第一条消息里写小写 "you said" / "added by Mori" / "learned" |
| 记忆的层（用户级 / 本项目） | User / Project（分段按钮）；user-level / user level / this project（句子里） | 见 "用户级 / 本项目" | 同 "用户级 / 本项目" 一行：形容词写 "user-level entries"，名词写 "Move to user level"、"(user level)"（记忆规格 §1、§7.4） |
| 删除（记忆条目） | Delete…（详情里的按钮）/ Delete（确认框的按钮）/ Deleting… / Deleted（修订里的改动、工具结果 "Deleted from …"） | Delete…、Delete、Deleting… | 同 "删除 / 移除" 一行；memory 工具的动作名是 forget，界面、修订和工具结果一律写 Delete 一族，不写 "Forget"（"Forget" 只用于权限菜单）（记忆规格 §1、§10.1） |
| 提升 / 放回 | Move to user level / Move to this project | — | 详情里的按钮与操作记录同一句；修订里的改动、说明和条目的 Revisions 行写过去式 "Moved to user level" / "Moved to this project"（记忆规格 §1、§3.2、§3.3、§8） |
| 增强用的模型 | Model range | — | 增强设置对话框的字段，同 "选择范围" 一行；下拉同设置页 Defaults，不提供 None（记忆规格 §10.4） |
| 以协作模式运行增强 | Run with team mode | — | 增强设置对话框 "Team mode" 下的勾选框（记忆规格 §10.4） |
| 回滚这次修订 | Roll back this revision（按钮）/ Rollback（列表的标记、修订的谁）/ Rolled back: <标题>（修订标题）/ Couldn’t roll back: … | — | 一键，不确认；操作记录 "Roll back revision"（记忆规格 §6.5、§8、§10.5） |
| 在记忆页查看 | View in Memory | — | memory 工具卡状态行后面的按钮；新会话提示的按钮写 "View"，操作记录两者都写 "View in Memory"（记忆规格 §7.5、§8、§10.6） |
| 在设置页查看（F8） | View in Settings | — | F8 保存后的按钮，取代 "View in Review"，打开设置页的 UI issues 并选中这一条（记忆规格 §10.9） |
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
| 设置 | Settings / Open settings | Settings、Open settings | 卡片和思考强度菜单里打开 Settings → Models 的按钮都叫 "Open settings"，范围菜单里是 "Manage models"；v0 错误卡上的 "Go to settings" v1 已删除（规格 §9.3） |
| 返回会话 | Back to app | Back to app | 设置、Customize、Review 三页的返回按钮，操作记录同（v1：见 docs/specs/memory.md §10.1：Review 换成 Memory） |
| 工具（页） | Customize（导航、页标题、F8 的 Page、操作记录 "Open Customize"） | Customize | Claude 开关技能、插件、连接器的页面叫 Customize；Claude 单独的 "Tools" 不是页名。分节标题 Built-in tools / Skills / Plugins / MCP 不变 |
| 内置工具 | Built-in tools | Built-in | |
| 角色（平行 Agent 的 role） | agent / Agents（Customize 的分节）/ New agent / Manage agents（模型菜单） | Agents、Custom agents、Subagent | 2026-10-26（[customize-agents.md](../specs/customize-agents.md) §1，负责人定）：界面上一律叫 agent，不写 role；基座叫 `Mori`，标记 `Built-in`，文件里的标记 `Project`。“Manage agents”只跳页，不加 “…”（同 “Manage models”） |
| AGENTS.md 编辑器（Customize 的分节） | Instructions（分节名）；正文里文件照写 AGENTS.md | Instructions、CLAUDE.md | 负责人 2026-10-26 定（customize-agents.md §0 第 1 条）：AGENTS.md 编辑器移到 Customize（WP-07）后分节叫 Instructions，免得与 “Agents” 混淆；两节不相邻。Customize › Agents 里 agent 的正文因此叫 “Prompt”（Claude 的 “Agent prompt”） |
| 三项权限（seat） | Jobs：Talks to you / Plans requests / Closes requests | — | Customize › Agents 的表单与行（临时，customize-agents.md §7） |
| 写入等级 | handoff tier | — | 模型卡上不再显示（WP-02）；只在 Customize › Agents 的 “Model needs” 与原因 `handoff tier C is below B` 里出现，并附一句说明 |
| 候选能用（静态检查通过） | Ready | — | Customize › Agents 每个候选模型的状态；不能用时显示选择器的原因原文（临时） |
| 技能 | skill / Skills | Skills、Skill | |
| 插件 / 包 | plugin / Plugins | Plugins、Add plugin | 只有讲 pi 包格式时写 "pi package" |
| 扩展 / 提示词 / 主题 | Extensions / Prompt templates / Themes | Extensions、Themes | 提示词与 "/" 列表同叫 prompt templates；开关的读屏名和操作记录用单数（Enable extension x、Enable prompt template x） |
| 提示词模板 | prompt templates | — | "/" 列表的读屏名是 Claude 的 "Slash commands" |
| MCP 服务 | MCP server | MCP server | |
| 直接调用 / 调用方式 | direct calls / Direct、codemode、Deferred、Hidden | — | 标签照 pi 的取值；正文说 "direct calls"，不写 v0 |
| 用户级 / 本项目 | User / Project（标签）；user-level / this project（正文） | User、Project | |
| 启用 / 停用 | Enable / Disable（动作）；Enabled / Not enabled（状态） | Enable {name}、Enabled | |
| 提供商 | provider / Providers / Add provider / Edit provider · <name> | — | 一个端点（Base URL、API type、Network zone，加它的 key 和模型），v1 取代 v0 的 connection（规格 §4.1）。界面上不再有 "connection" 这个名词，只留在动作 "Test connection" 和结果 "Connected · …"、"Connection failed: …" 里 |
| key | key / Keys / Add key / API key（输入框的标签） | — | 一个提供商最多 8 个，按列出的顺序用；明文从不显示，Keys 的每行只写 "Saved" |
| 分组 | group / Groups / New group / Group ID | — | 有序的成员：提供商成员 "<name> · all models"，模型成员 "<name> · <model id>" |
| 选择范围 | model range / Default model range for new sessions / No model range | — | 分组、提供商或模型（规格 §1）；输入框下面一行的范围按钮读屏名 "Model range: <按钮上的字>"（字里的 " · " 换成 ", "：“Model range: fast, deepseek-chat”），菜单的读屏名 "Model range" |
| 网络区域 | network zone / Network zone / Local / Intranet / Public | — | 标签、单选、勾选框和标记写 Local / Intranet / Public；句子里写区域代码（"Allow public for this project"、"zone public is not allowed for this project"） |
| 项目授权 | Project access / Allowed: … | — | 设置 → Models 的一节：按项目在 "Allowed zones for all projects" 之外另外允许的区域 |
| 验证（探针） | Verify / Verifying… / Re-verifying… / Verify again / Verify now | — | 结果写在档案摘要的 "Tool calling: Verified / Not verified / Failed"（2026-10-26 起首次启动表单下方不再有 "Verifying tool calling…" / "Tool calling verified"，见 v1/screens/first-run.md） |
| 服务地址 / 接口类型 / 模型 ID | base URL / API type / model ID | Gateway base URL、Model ID | |
| 测试连接 | Test connection / Test / Testing… | Test connection、Testing… | 提供商卡和首次启动表单用 "Test connection"，Keys 的行和模型行用 "Test" |
| 连接成功 / 连接失败 | Connected · … / Connection failed: … | Connected · {latency}ms、Connection failed: {error} | 毫秒和秒一样不加空格（120ms、5s） |
| 默认 | Defaults（设置 → Models 的一节）/ None（没有默认范围） | Default | v1 没有 v0 模型行上的 "Default" 标记和 "Set as default"：新会话的默认范围在 Defaults 的下拉里选（规格 §9.1） |
| 模型 | model / Models（设置页的分节、提供商卡里的一块、范围菜单和 Defaults 下拉的一节） | Model、Model: {name} | 设置页的 "Models" 取代 v0 的 "Connections and models"（规格 §9.1）；v0 顶栏的 "Model: <id>" v1 不再有，输入框下面一行是范围按钮（见 "选择范围"；不用 "Model: {name}"：按钮显示的不一定是一个模型） |
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
| 系统托盘 | system tray | system tray（"Claude runs in the system tray"） | 2026-10-26 加（WP-20，[screens/window.md](screens/window.md)） |
| 退出 | Exit（托盘菜单的项）；quit（句子和按钮：right-click to quit、Quit anyway、Quitting now…） | Exit（Windows 托盘菜单）、Quit anyway、Quitting now will interrupt that work. | 照 Claude 在 Windows 上的写法：菜单项是 "Exit"，说明和按钮里是 quit。2026-10-26 加 |

## 按屏的固定说法

### 侧栏和会话列表

| 中文 | 英文 |
| --- | --- |
| 新会话 / 打开文件夹… / 工具 / 工作回顾 / 报告界面问题（F8） / 设置 | New session / Open folder… / Customize / Review / Report a UI issue (F8) / Settings（v1：见 docs/specs/memory.md §10.1：Review 换成 Memory）（2026-10-26 起展开的左栏顶部没有 New session，只在收起的图标栏上有一个 +，读屏名 "New session (Ctrl+N)"，见 screens/sessions.md"左栏"） |
| 项目行的 + | New session in <folder>（不可用时悬停 Mori’s background process crashed. Restart it to continue.） |
| 展开侧栏 / 收起侧栏 | Open sidebar / Close sidebar（收起时带状态："Open sidebar (a session needs approval)"、"(a session needs input)"、"(a session has an error)"、"(a session has unread results)"） |
| 后台进程退出后导航不可用的提示 | Mori’s background process crashed. Restart it to continue.（2026-10-26：Customize › Instructions 的项目一栏在后台进程退出时也写这一句） |
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
| 空白页 | Pick a session on the left to continue, or open a folder to start a new session. / Open a folder / Choose a project folder to start a session. / Opening <folder>…（v1：2026-10-26 起首次启动测试成功后进入这一页，标题 Open a folder 下面一行测试结果 "Connected · …"，打开会话之前只显示这一次，见 v1/screens/first-run.md） |
| 首次启动 | 整窗的首次启动表单 "Connect a model"，文字见下面 "首次启动" 一节（v1 没有 v0 测试成功后的标题 "Connected"） |
| 上下文 | 圆环（2026-10-21 起，照 Claude 的 usage ring）：悬停 "Context ≈ 53.8k / 128k (42%)"（Claude 的 "Context {summary}"，summary 是 "≈ " + "{used} / {max} ({pct}%)"；Claude 对估算的数加 "≈ "，pi 的数都是估算；百分比四舍五入，不写 "<1%"）；读屏名 "Usage: Context approximately 53,760 of 128,000 tokens (42%)"（Claude 的 "Usage: {parts}"，" / " 换成 " of "）；详情左边 "Context window"、右边同悬停的 summary "≈ 53.8k / 128k (42%)"，下面一条分段条和分项（2026-10-26 起，WP-12；Claude 桌面版用量浮层里的分项名，System prompt、MCP tools、Memory files、Skills、Messages 在 Claude 的字串表里，System tools、Autocompact buffer、Free space 是 Claude Code /context 给的数据，Claude 原样显示）：System prompt / System tools / MCP tools / Memory files / Skills / Messages / Autocompact buffer / Free space，每行 "≈ 1.1k"（Autocompact buffer 不加 "≈ "）和占窗口的百分比 "0.1%"（一位小数，同 Claude）；读屏的描述 "System prompt approximately 505 tokens (0.4%), …, Autocompact buffer 16,384 tokens (12.8%), Free space approximately 96,256 tokens (75.2%)"；还没有消息时悬停和读屏名 "Context window"，详情里条的位置是 "Send a message to see context usage."（Claude 原句，也是读屏的描述）；刚压缩过同样是 "Context window"，那句换成 Mori 的 "Just compacted. Context usage shows after the next response."。原来的 "Context 42%" / "Context —" / "About … tokens" 不再用。不用的 Claude 字串："{percent}% used"（套餐用量）、"{used} of {cap} tokens used"（组织的 Token limit 卡片）、"Compact session"、"Compacts automatically at {pct}%"、"Compacts automatically when full"、"Last updated {time}. Send a message to refresh."、"Loading context breakdown…"、"See detailed breakdown"、"Custom agents"、"Other"（Mori 的分项不超过八项，不合并） |
| 后台进程意外退出 | Mori’s background process crashed · Unfinished responses were interrupted / Restart / Restarting… |
| 输入框不能发送时 | Mori’s background process crashed / Restarting… / Starting… / Session didn’t open |
| 打开失败 | Failed to open session: … |
| 输入框的读屏名 | Message Mori（会话定的，待负责人确认；不用 Claude 式的 "Reply to Mori"） |
| 按键提示 | Enter to send · Shift+Enter for new line / Enter to queue · Ctrl+Enter to steer · Shift+Enter for new line / Enter to queue · Shift+Enter for new line（准备中，v1） |
| 发送 / 停止 / 排队发送 / 插话 | Send / Stop（悬停 "Stop response (Esc)"）/ Queue（悬停 "Queue for later (Enter)"，2026-10-21 起；原来是 "Send after the current turn (Enter)"）/ Steer |
| 排队区 | 标签 Queued / Steer，按钮 Withdraw |
| 阶段行：等你批准 / 等你回答 | Waiting for your approval / Waiting for your answer |
| 阶段行：等待模型响应 / 思考中 / 生成中 | Waiting for the model… 12s / Thinking… 5s / Responding…（会话定的，待负责人确认；不用 Claude 的 "Writing…"） |
| 阶段行：工具 / 重试 / 压缩 | <工具卡标题> 8s（如 "Run npm test 8s"）/ Retrying (1/3) · <错误原文> / Compacting session… |
| 对话流里 | Thought process / Thinking… / Copy code / Compacted session / Stopped · Changes made so far stay as they are / Extension: … / Skill · <name> / Expand / Collapse |
| mermaid 图（2026-10-26） | 读屏名 Mermaid diagram（Claude 的原词，`role="img"`）；画不出来时就是普通代码块，没有另外的文字（照 Claude；不用 Streamdown 自带的 "Mermaid Error: " / "Show Code" / "Loading diagram..."） |
| 滚动 | Scroll up to load earlier messages / Jump to latest |
| 错误卡 | Put your last message back in the message box（v1 删掉了 v0 的 "Go to settings"，规格 §9.3：模型的问题由换模型的一行、No model available 卡或拒绝启动卡说明） |
| 模型层的卡片 | No model available / <provider>/<model> — <原因> / Open settings；拒绝启动卡：Verifying <provider>/<model>… / This session can’t start: no model fits. / No default model range; pick one. / <name> is not in your model settings.（第二行 "Used by this session’s model range."）/ .mori/models.json: <原文> / Model settings can’t be read: <原文>，按钮 Verify now / Allow <zone> for this project / Confirm zone / Change model… / Open settings。换模型的一行、阶段行等见 [v1/screens/model-chat.md](../v1/screens/model-chat.md) |
| 候选的原因 | not in your model settings / removed from your model settings / network zone not confirmed / zone <zone> is not allowed for this project / verifying… / tool calling not verified yet / tool calling failed verification / rate limited until hh:mm:ss / API key rejected / quota exhausted / can’t connect until hh:mm:ss / model not found on the server / no response; unavailable until hh:mm:ss / waiting to make sure it stopped, until hh:mm:ss / failed earlier in this reply: <原因> / skipped at the start of this reply / conversation too long for this model / couldn’t rebuild the conversation: <原文> / waited N s for a free slot（`shared/models.ts` 的 `REASON_TEXTS`，后台进程和界面共用；小写开头，因为跟在 " — "、": " 后面。换模型的一行 "Switched model: A → B · <原因>" 里不带 until 部分，跟在 " · " 后面也是小写，与写法约定 " · " 那一条不同，待负责人确认） |
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
| 权限按钮 | 输入框下面一行的左端（2026-10-21 起）；照 Claude 的模式选择只有文字 "Ask each time ▾" / "Allow all ▾"，没有图标，窄时截断，只剩开头几个字母加 "…"（由 Chromium 决定，例如 "Ask …" / "Allo…"）；悬停两行：第一行全名 "Permission mode: Ask each time"，第二行照 Claude 的模式选择用当前模式的说明："Allow all" 时 "Edits, writes, and commands will run without asking."，"Ask each time" 时 "Change the permission mode"（Claude /permissions 命令的说明）；原来的 "Set the permission mode for this session" 不再用；读屏名 "Permission mode: Ask each time"（借用 Claude 定时任务卡片上的 "Permission mode: {mode}"；模式名截断时靠它读出全名） |
| 选择范围、Effort 按钮的悬停 | 第一行是按钮的全文（窄时按钮上的字会截断）。Effort 两行：第一行 "Effort: High"，第二行说明或原因。选择范围按钮三行：第一行按钮文字（"fast · deepseek-chat"），第二行 "<提供商名> · <区域>"（"DeepSeek · Public"；没有当前模型时 "No model can run in this session"），不可用时第三行原因。说明和原因："Set the effort level for this session"（Effort 能用时）、"This model isn’t marked “Supports thinking”"、"Can’t switch models until the response finishes"（准备中也用）、"Can’t change effort until the response finishes"；后台进程退出、重新载入、打开中时用按钮位置的说明 "Mori’s background process crashed"、"Restarting…"、"Starting…"。读屏的描述不含第一行：Effort 是第二行；选择范围按钮是第二行（" · "换成", "）加不可用时的 ". <原因>"，不把整个悬停说明当描述 |
| 权限按钮不可用时的原因 | 悬停的第二行和读屏的描述："Mori’s background process crashed"、"Restarting…"、"Starting…"、"Session didn’t open"（都是按钮位置原有的说明） |
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
| 反馈表单 | What result were you hoping for? / This is only saved to Review and isn’t sent to the model. To have Mori act on it, use “Attach as context” instead. / Save / Saving… / Saved · View in Review（v1：见 docs/specs/memory.md §10.7：底部说明按这个会话的项目是否开着增强二选一，整段是 "Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use “Attach as context” instead."，或者（没开、没有项目、后台进程退出或读不出增强设置时）"This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on it, use “Attach as context” instead."；保存后只写 "Saved"，没有链接） |
| 带引用的消息打开 "/" 列表 | Prompt templates and skills don’t work in a message with attached context. Remove the context first. |

### 右栏（改动、文件阅读器）

| 中文 | 英文 |
| --- | --- |
| 本会话的改动 | This session’s changes（顶栏开关的读屏名 "Toggle changes"，Claude 原词） |
| 还没有改动 | No changes yet. / Only edits and writes are listed. Files changed by commands aren’t included. |
| N 次 / 第 N 次 · 修改 | 1 change（N changes）/ Change N · Edit（Write） |
| 写入的内容 | File content |
| 阅读器 | Loading… / File not found / Source changed · Attached text: / Preview unavailable · Binary file / Preview unavailable · This is a folder / Couldn’t read this file: … / Reload file / Open in default app / Close panel |
| 阅读器顶部（2026-10-26） | 路径按钮的读屏名 Copy path <完整路径>（Claude 的 "Copy path {path}"），悬停是完整路径；复制后 Path copied to clipboard.（Claude 的原句）；失败 Copy failed（同回复下的 "Copy"，也是 Claude 的原词）/ Markdown 文件：View source（预览时）、Preview（看源码时），都是 Claude 文件面板的原词 / Expand、Collapse / 右栏窄于 320px 时 "← Changes" 只剩箭头，读屏名仍是 Changes |
| Markdown 预览里的图片 | Image not available（Streamdown 自带，也是 Claude 的原词） |

### 首次启动

v1 的首次启动表单（[v1/screens/first-run.md](../v1/screens/first-run.md)），取代 v0 的连接表单。

| 中文 | 英文 |
| --- | --- |
| 读取中 / 读取失败 | Loading… / Couldn’t load model settings: … |
| 标题和说明 | Connect a model / Enter the base URL, API key, and model ID, then test the connection.（v1：见 docs/specs/model-discovery.md §6.6：说明改为 "Enter the base URL and API key, then fetch the models."） |
| 迁移失败 | Couldn’t import your previous model settings: … |
| 字段 | Name / Base URL（占位 "http://host:8000/v1"）/ API type / Network zone（Local / Intranet / Public）/ API key（占位 "Optional"，保存过之后 "Saved. Leave empty to keep it."；v1：只在存过 key、且 Base URL 与保存的提供商同一个 origin 时，见 docs/specs/model-discovery.md §6.6 的 2026-10-23 负责人决定）/ Model ID / Context window / Max output / Supports thinking / Compatibility options（同下面 "设置"）；字段错误同下面 "设置"（v1：见 docs/specs/model-discovery.md §6.6：开始只有 Base URL、API key 和 Fetch models；Name、API type、Network zone 在拉取后出现并预填；Model ID、Context window、Max output、Supports thinking 移到清单的每一行；Compatibility options 收进 "More settings"，首次启动没有 Concurrency per key，API type 不是 OpenAI-compatible 时不显示 More settings；没有关闭表单的 Cancel，只有拉取中的 Cancel；保存后再拉取而 API key 框是空的时，用这张表单里最后填过的 key，不显示） |
| 拉取（v1：见 docs/specs/model-discovery.md §6.6） | Fetch models / Fetching models… / Cancel（拉取中的，`models.discoverCancel`）/ Fetch cancelled / Detected: <服务种类> <版本> / Updated to <url> so the model list loads.（只在拿到了列表时）；规则同下面 "设置" 的拉取；清单、列表错误、Add a model ID 和 More settings 的文字同下面 "设置"（More settings 里只有 Compatibility options） |
| 选了 Public | Public providers must be allowed per project. You’ll be asked when you open a folder. |
| 按钮 | Test connection / Saving… / Testing… / Cancel；保存失败 "Couldn’t save: …"；测试结果同下面 "设置"（v1：见 docs/specs/model-discovery.md §6.6：Test connection 上方一句 Each model is verified with up to 13 short requests.；没有勾选的模型时 Test connection 不可用；先保存勾选的模型，再测第一个勾选的模型；这里的 Cancel 是测试中的 Cancel，没有关闭表单的 Cancel） |
| 探针状态 | 2026-10-26 起首次启动没有探针状态（负责人走查 M2，见 v1/screens/first-run.md）：原来表单下方的 Verifying tool calling… / Tool calling verified / Tool calling failed verification: <detail>. Mori needs tool calling for the main agent; pick another model or check the server’s tool-call settings. / Couldn’t verify: … / Verify again 从首次启动删掉；验证进度看会话的拒绝启动卡（"Verifying <model>…"、"This session can’t start: no model fits."，见 v1/screens/model-chat.md） |
| 测试成功之后 | 进入主窗口的空白页（上面 "会话" 一节）：Open a folder / Connected · …（测试结果，标题下面一行，只显示一次）/ Choose a project folder to start a session. / Open folder… / Opening <folder>… / Failed to open session: … |

### 设置

v1 的设置 → Models（[v1/screens/models-settings.md](../v1/screens/models-settings.md)）取代 v0 的 "Connections and models"，
v0 的连接表单、连接卡和它们的文字（"Add connection"、"Edit connection · <name>"、"Set as default"、"Key saved (encrypted)" 等）都已删除。

| 中文 | 英文 |
| --- | --- |
| 页头 | Back to app / Settings；左侧分节 Models / AGENTS.md（读屏名 "Settings sections"）（v1：见 docs/specs/memory.md §10.8：左侧分节为 Models / AGENTS.md / UI issues；UI issues 的文字同下面 "工作回顾" 一节的 UI issues 部分）（2026-10-26 改：AGENTS.md 挪到 Customize，左侧分节为 Models / UI issues） |
| Models 分节 | 标题 Models；从上到下：迁移说明、区域未确认、Defaults、Providers、Groups、Project access / Loading… / 配置读不出 "Couldn’t read model settings: <路径>: <原文>" 和 Retry |
| 迁移说明 | Imported your model settings from models.json / Imported: <name>, … / Renamed provider <from> to <id> / Dropped <subject>: <reason> / Add the API key again for: <name>, … / Kept the saved key for: <name>, …; the key written in models.json was ignored. / Dismiss |
| 区域未确认 | Confirm the network zone of these providers. Sessions don’t use them until you do. / <name> · <base URL> / Confirm zone…；对话框 Confirm network zone / Confirm / Cancel |
| Defaults | Defaults / Default model range for new sessions（下拉：None，再分 Groups / Providers / Models 三节，模型写 "<provider name> · <model id>"）/ Allowed zones for all projects（Local、Intranet）/ Public providers can only be allowed per project, below. |
| Providers | Providers / No providers yet. Add one to start a session. / Add provider；卡上 Base URL / API type / Network zone（未确认时 "Not confirmed"）/ Concurrency per key / Compatibility options（勾了的标签，逗号分隔，没有时 "None"）；按钮 Edit / Delete… / Test connection / Add model（v1：见 docs/specs/model-discovery.md §6.5："Add model" 换成 "Fetch models"，在卡里打开清单，见下面 "卡上的 Fetch models"） |
| 提供商表单 | Add provider（另有 First key、First model 两小节）/ Edit provider · <name>；字段 Name / Base URL（占位 "http://host:8000/v1"）/ API type / Network zone / Concurrency per key / Compatibility options / API key（占位 "Optional"）；Save / Cancel（v1：见 docs/specs/model-discovery.md §6.1：First key、First model 两小节不再有；Add provider 开始只有 Base URL、API key（占位 "Optional"）、Fetch models、Cancel，拉取后出现 Name、API type、Network zone、清单、Add a model ID、More settings 和底部的 Add 按钮，文字见下面几行；Edit provider · <name> 不变，仍是 Save / Cancel，没有 Fetch models） |
| 拉取（v1：见 docs/specs/model-discovery.md §6.1） | Fetch models（Base URL 不是 http 或 https URL 时不可用；拉取后仍在 API key 下面，再点一次从头拉）/ Fetching models…（不可用，旁边 Cancel；拉取中 Base URL、API key 只读，关闭表单的 Cancel 照样可用）/ Fetch cancelled（取消后回到开始）；拉取后一行 Detected: <服务种类> <版本>（版本为空时只写种类；没拿到列表时不显示）；建议的 Base URL 与你填的不同（两边去掉首尾空白和结尾的 / 后比较）时 Base URL 框换成它，拿到了列表时下面一行 Updated to <url> so the model list loads.，有列表错误时不写这一行；命令本身失败时的原文 Base URL must be an http or https URL. / API key contains characters that cannot be sent in a header |
| 服务种类（v1：见 docs/specs/model-discovery.md §3.3，`shared/models.ts` 的 `SERVER_KIND_LABELS`） | vLLM / SGLang / llama.cpp / Ollama / LM Studio / Xinference / GPUStack / MindIE / TGI / LMDeploy / LocalAI / TensorRT-LLM / LiteLLM / New API / One API / DeepSeek / Moonshot AI / Alibaba Cloud Model Studio / Baidu Qianfan / OpenRouter / Anthropic；认不出时 OpenAI-compatible server；认不出且列表是 Anthropic 形状时 Anthropic-compatible server。产品名照各自的写法，不按句子大小写改 |
| 清单（v1：见 docs/specs/model-discovery.md §6.2） | 标题 Models (N)（N 为列表条数）/ Select all / Clear selection（只对显示着的、能勾的行）/ Showing the first 1,000 models.（列表超过 1000 条时）/ 过滤框占位 Filter models（行数含手填的行超过 20 时；按 id 子串过滤，不分大小写，不改勾选）；列表是空的时标题 Models (0)，下面一句 The server didn’t list any models.，再下面是 Add a model ID；每行：勾选框（读屏名 "Add <id>"）、Model ID、Context window、Max output、Supports thinking、Image input；没报告的 Context window、Max output 旁写 Not reported（你改了值也留着）；改值的错误同下面 "字段错误"（Context window must be a whole number above 0. 等） |
| 清单行的标记与提示（v1：见 docs/specs/model-discovery.md §6.2、§6.4） | Not a chat model / Added / Can’t add this model: the ID contains spaces（"the ID is empty"）/ Entered by you（手填加进来的行）/ The server doesn’t list tool support for this model. / Trained context window. Ollama may use a smaller one; run the long-input test after adding. |
| 列表错误（v1：见 docs/specs/model-discovery.md §6.3、§5.2） | The server rejected the API key: <原文> / Couldn’t reach <host>: <原文>（超时时原文为 "Timed out after 15s"）/ This server doesn’t list its models. / Couldn’t read the model list: <原文>（响应体太大时 "The model list is larger than 8 MB."，跨 origin 重定向时 "Redirected to <location>"）；后面一句 You can still add model IDs below.；Add a model ID 加进来的行列在这句下面，样子同清单的行，没有 Models (N)、Select all、Clear selection 和过滤框 |
| Add a model ID（v1：见 docs/specs/model-discovery.md §6.4） | Add a model ID / Model ID（输入框）/ Add to list；错误 Model ID must be non-empty and contain no spaces. / Model IDs must be unique within a provider.（与清单里的行、提供商已有的模型重复时） |
| More settings 与底部（v1：见 docs/specs/model-discovery.md §6.1） | More settings（点开后 Concurrency per key、Compatibility options；Compatibility options 只在 API type 为 OpenAI-compatible 时）/ Each model is verified with up to 13 short requests. / Add 1 model（Add N models；没有勾选时 Add models，不可用）/ Adding… / Cancel；保存失败时表单里原文 |
| 卡上的 Fetch models（v1：见 docs/specs/model-discovery.md §6.5） | Fetch models（清单打开期间不可用）/ Fetching models… / Cancel / Fetch cancelled，清单、列表错误、Add a model ID、底部同上面几行；卡里不显示 Detected 一行；已加入的行标 Added；Not listed by the server: <id>, <id>（只列出，不删除）；Add 时 id 已在这个提供商里 "<id> is already in <provider name>." |
| 接口类型 | OpenAI-compatible (Chat Completions) / OpenAI Responses / Anthropic Messages |
| 兼容选项 | 标签写端点的情况，下面一行小字说明（`shared/models.ts` 的 `COMPAT_LABELS`、`COMPAT_HINTS`）：Endpoint doesn’t support the developer role（Sends the system prompt with the system role instead）/ Endpoint doesn’t accept the store field（Leaves store out of requests）/ Endpoint needs max_tokens instead of max_completion_tokens（Older endpoints don’t recognize max_completion_tokens）/ Endpoint doesn’t report usage while streaming（Doesn’t send stream_options, so the context usage shown will be inaccurate）/ Endpoint doesn’t support strict mode for tool parameters（Leaves strict out of tool definitions）/ Tool results must include the tool name（Some endpoints require a name field on tool result messages）；只在 API type 为 OpenAI-compatible 时显示 |
| Keys | Keys / Saved / Rate limited until hh:mm:ss / Rejected / Quota exhausted / Move up / Move down / Test / Remove（只剩一个 key 时 "Remove…"）/ Requests are sent without an API key. / Add key（内联表单 Label，默认 "Key <n>"；Secret；Save / Cancel）/ A provider can have at most 8 keys. |
| 模型行 | Models / <model id>，下面 "Context window: 128,000 · Max output: 16,384 · Family: <family> · Supports thinking"（模型族为空、不支持思考时那一段不显示）/ Verify / Long-input test… / Cancel test… / Move up / Move down / Edit / Delete… / Test（v1：见 docs/specs/model-discovery.md §8：服务没报告的窗口和输出上限后面加 " (not reported)"，见下面 "模型行的提示"） |
| 档案摘要 | Tool calling: Verified（Not verified、Failed、Verifying…、Re-verifying…）/ Handoff tier: A（B、C、—）/ Context: <有效窗口> / Reasoning field: <字段> / Cancel: Verified（Not verified、Unknown）/ Thinking: Can’t be turned off（v1：见 docs/specs/model-providers.md §7.7：只在档案 `reasoning.off_refused` 时有这一项）/ Silently truncates long input / Couldn’t verify: … |
| 探针各步的说明（v1：见 docs/specs/model-providers.md §7.7） | Thinking can’t be turned off: <原文>（第 2 步关闭思考被服务以 400 或 422 拒绝、`medium` 有正文时；<原文> 是服务的错误原文，例如 OpenRouter 的 "Reasoning is mandatory for this endpoint and cannot be disabled."；**只存不显示**：只写进档案文件 `model-profiles.json` 第 2 步的结果，`ProfileView` 不带，界面任何地方都不显示（同第 5、6 步被拒的原文）；设置页看到的是档案摘要的 "Thinking: Can’t be turned off"；这一步判定为不通过、不是出错，也不出现在 "Couldn’t verify: …" 后面）/ Stopped at the probe output limit before answering（任何一步回复停在输出上限、只有思考没有正文和工具调用时；这一步是出错，同其他出错原文一样出现在模型行和首次启动表单的 "Couldn’t verify: …" 后面）。第 2 步 `off` 被 400 或 422 拒绝而 `medium` 出错或没有正文时这一步是出错，说明：`medium` 出错时用它的说明（可能就是 Stopped at the probe output limit before answering），`medium` 没出错但没有正文时用 `off` 的原文 |
| 模型行的提示（v1：见 docs/specs/model-discovery.md §8） | 没报告：Context window: 128,000 (not reported) / Max output: 16,384 (not reported)；与配置不一致时每条一行小字和 Use：Server reports a context window of <N>. / Server reports max output of <N>. / The server says this model supports thinking. / This model returned thinking content. / The server says this model accepts images.（数字按千分位写，同模型行）；Use 失败时原文 |
| 模型表单 | Add model · <provider name> / Edit model · <provider name>；字段 Model ID（Edit 时只读）/ Context window / Max output / Family（占位 "Optional"）/ Supports thinking / Image input / Default effort for new sessions（勾了 Supports thinking 时；Off / Minimal / Low / Medium / High / Extra high / Max）；Save / Cancel（v1：见 docs/specs/model-discovery.md §6.5、§5.4："Add model · <provider name>" 不再有，模型表单只剩 Edit model · <provider name>；没设过强度的模型，Default effort for new sessions 显示 pi 设置的默认强度（没有时 Medium））（v1：见 docs/specs/model-providers.md §7.7：档案 `reasoning.off_refused` 的模型 Default effort for new sessions 不列 Off，已经存成 Off 的照存、显示为 Minimal；增强设置对话框的 Effort 在所选范围的第一个候选是这类模型时同样（按 `enhance.get` 的 `noOffPicks`，docs/specs/memory.md §10.4）） |
| Groups | Groups / No groups. A group lists the models to try, in order. / New group（内联表单 Group ID、成员选择、Create / Cancel）/ Add member / Remove / Delete… / <name> · all models / <name> · <model id> / A group needs at least one member; delete the group instead. |
| Project access | Project access / No projects yet. Open a folder to add one. / Allowed: Local · Intranet（没有时 "None"）/ Local / Intranet / Public（不在 "Allowed zones for all projects" 里的区域才有勾选框）/ .mori/models.json in this project doesn’t allow <zone>. / .mori/models.json: <原文>；勾 Public 的确认框 Allow public providers for this project? / Code and files from <path> may be sent to: <name>, <name>. / Allow / Cancel |
| 确认框 | Delete provider <name>?（Its models and keys are deleted too.）/ Delete model <id>? / Delete group <id>? / Change the base URL?（按钮 Save and remove keys）/ Remove the last key?（Requests to <name> will be sent without an API key.；按钮 Remove）/ Run the long-input test on <id>? / Run the cancel test on <id>?（按钮 Run test）；其余的按钮 Delete / Cancel。连带改动的各行由后台进程写，见 [v1/screens/models-settings.md](../v1/screens/models-settings.md) "确认框的文字" |
| 字段错误 | Name is required. / Base URL must be an http or https URL. / Use a whole number from 1 to 64. / Choose a network zone. / Model ID must be non-empty and contain no spaces. / Model IDs must be unique within a provider. / Context window must be a whole number above 0. / Max output must be a whole number above 0. / Max output must be smaller than the context window. / Label is required. / Use lowercase letters, digits, and hyphens. / <id> is reserved. / <id> is already used by a provider or group. |
| 测试结果 | Testing… / Cancel / Connected · First token 120ms · Total 950ms · Includes thinking · Response: …（没有首字时间时 "First token —"）/ Connection failed: …（没有原文时 "Connection failed: No response"）/ Test cancelled / Couldn’t test the connection: … |
| 保存 | 提供商表单、模型表单、Add key、New group 按 Save（Create）保存，保存中按钮不可用，失败时表单里原文；Defaults、Groups 的成员、Project access、Keys 和模型的上移下移、Confirm zone、Dismiss 改了就保存，没有 Save 按钮，成功时不提示（v1：见 docs/specs/model-discovery.md §6.1、§6.5、§8：Add provider 和卡上的清单按 "Add 1 model"（"Add N models"）保存，保存中 "Adding…"；模型行的 Use 点了就保存） |
| 范围菜单 | 按钮 "<范围名> · <当前模型 id>"（范围是模型时只写模型 id；没有当前模型时只写范围名）/ No model range；按钮在输入框下面一行，读屏名 "Model range: <按钮文字>"（" · " 换成 ", "）；悬停三行：第一行按钮文字，第二行 "<provider name> · <区域>"（没有当前模型时 "No model can run in this session"），不可用时第三行原因（准备中、生成中 "Can’t switch models until the response finishes"）；菜单和切换失败的一行从输入框下面一行往上打开；菜单 Groups / Providers / Models（Models 按提供商分小节），每项右边标区域（"Local · Public"，未确认时 "Zone not confirmed"；每项的读屏名只有名字，区域写进读屏的描述，用逗号："Local, Public"，被排除时再加 ". <原因>"）/ Applies to this session only. New sessions use the default range from Settings. / Manage models；换不了时 "Couldn’t change the model range: …" |
| 思考强度菜单 | Effort: High / Unavailable / Applies to this session only. Set each model’s default for new sessions in Settings. / Open settings / This model can’t turn thinking off.（v1：见 docs/specs/model-providers.md §7.7、§9.2：菜单底部，当前模型支持思考而它可选的强度里没有 Off 时；这时菜单没有 Off，会话原来是 Off 的按钮显示 "Effort: Minimal"）；不支持思考：This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Models and check “Supports thinking”. |
| 发送、停止、排队（只有图标时） | 读屏名 "Send" / "Stop" / "Queue" / "More send options"（都是 Claude 原词）；悬停 "Send (Enter)"、"Stop response (Esc)"、"Queue for later (Enter)"（Claude 的 "Queue for later"；原来是 "Send after the current turn (Enter)"）；▾ 菜单里 "Steer"，≤ 400px 时加上 "Queue for later"：项的名字只有文字，快捷键是旁边的提示（"Enter"、"Ctrl+Enter"，`aria-hidden`，另放在 `aria-keyshortcuts`），不写成 "Queue · Enter" |

### Customize 页（工具页）和 "/" 列表

| 中文 | 英文 |
| --- | --- |
| 页头 | Back to app / Customize（分节导航的读屏名 "Customize page sections"：Claude 的 "Customize sections" 是另一个命令）/ Changes apply to new sessions. Sessions already open aren’t affected. / New session |
| 分节 | Built-in tools / Skills / Agents（在 Skills 之后，只在有会话时，2026-10-26，customize-agents.md §6.1） / Plugins（MCP 服务一节 "MCP"）/ Instructions（2026-10-26 加，最后一节，用户级 AGENTS.md 从设置页挪来；负责人定名 Instructions，同 Claude 桌面版的 Instructions / Global instructions / User instructions，不叫 AGENTS.md） |
| 没有会话时的顶部 | No open session. Only user-level skills and plugins are listed.（2026-10-26 改为 No open session. Only user-level skills, plugins, and instructions are listed.） |
| Instructions（用户级 AGENTS.md） | 标题 Instructions；第一行 Instructions here are saved in the AGENTS.md file that every session reads. Use this for preferences, conventions, or context that Mori should always know.（2026-10-26，照 Claude 桌面版 Global instructions 的说明 "Instructions here apply to all Cowork sessions. Use this for preferences, conventions, or context that Claude should always know."）/ User / Changes apply to new sessions only; sessions already open don’t change.（2026-10-26 改：去掉前面的 Every session reads this file.，挪到第一行）/ In effect: <path> / <path> takes precedence, so what you write here has no effect. / <path> is in effect now. After you save, this AGENTS.md is loaded instead. / Save / Discard changes / Unsaved changes / Saved · Applies to new sessions / Open in default app（v1：见 docs/specs/memory.md §10.3：生效的文件和每个加载的文件旁写 token 数 "<n> tokens"（1 时 "1 token"），合计超过 500 时警告 "Over 500 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short."）（2026-10-26 改：这一节从设置页挪到 Customize，叫 Instructions；提醒线改为 2,000："Over 2,000 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short."；token 数 1000 起按千分位写 "2,099 tokens"；项目的文件在会话打开中时 "Loading…"；重新读取失败时顶部 "Couldn’t load AGENTS.md: <原文>"） |
| 离开确认 | Discard changes to AGENTS.md? / Your edits haven’t been saved. Leaving now discards them. / Discard / Keep editing |
| Agents | Agents Mori can hand work to in Task mode. They’re files in this project’s .mori/agents folder. / New agent / Built-in / Project / Ready / Models: <id> and <n> more / <k> of <n> models can’t run / No model can run this agent / No model range picked / Same as the session’s model range (<range>) / Tries these in order: / Same as Mori: … , and all MCP tools / No prompt / No agents in this project yet. Mori does everything in Task mode until you add one. / New sessions in this project won’t start until these agent files are fixed. / Can’t be used / Saved · Applies to new sessions / Edit / Open in default app / Delete…（确认框 Delete agent “<name>”? / <file> will be permanently deleted. This can’t be undone. Sessions already open aren’t affected.） |
| Agents 的表单 | Name / Description / Jobs / Models / Tools / Prompt / Same as the session’s model range / Use these, in order / Add model range / Same as Mori / Only these / All MCP tools / <name> does this / Couldn’t save: … / Saving rewrites this file’s header and removes its comments. / Discard this agent? |
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
| 按钮和结果 | Save / Saving… / Cancel / Saved to <file> / Show in Explorer / View in Review / Close（v1：见 docs/specs/memory.md §10.9："View in Review" 改为 "View in Settings"，打开设置页的 UI issues 并选中这一条） |
| 错误 | Couldn’t capture a screenshot: … / Couldn’t save the report: … |

### 系统托盘与退出（主进程，2026-10-26 加，[screens/window.md](screens/window.md)）

| 中文 | 英文 | Claude 的键和原文 |
| --- | --- | --- |
| 托盘图标的悬停说明 | Mori | 应用名（`setToolTip(app.getName())`） |
| 托盘菜单：打开窗口 / 退出 | Show App / Exit | `DQTgg21B7g` "Show App"、`7fdcqxofEs` "Exit"（Claude 的 Windows 托盘菜单只有这两项，登录后中间多两行用量） |
| 应用菜单（菜单栏） | File（只有 Exit）/ Edit / View / Window | `EfdnINFnIz` "File"、`7fdcqxofEs` "Exit"、`/PgA81GVOD` "Edit"、`LCWUQ/4Fu6` "View"、`1HUTYwndT2` "Window"；Edit、View、Window 和它们的项是 Electron 的菜单角色自带的英文，Mori 不另写（2026-10-26 审查修正加） |
| 第一次关窗口的气泡：标题 | Mori runs in the system tray | `QlSoWmoIH3` "Claude runs in the system tray" |
| 第一次关窗口的气泡：正文 | Mori runs in the background even when you close the window. Click the Mori icon in the system tray to reopen the app, or right-click to quit. | `pYqTQaQNu2`，把 Claude 换成 Mori |
| 退出前的确认框：标题 | Mori is still working | `kdoUubpNNW` "Claude is still working" |
| 退出前的确认框：说明 | Mori is working in 1 session. Quitting now will interrupt that work. / Mori is working in N sessions. Quitting now will interrupt that work. | `V9Eb08nwTF`（复数，按 `n === 1` 选） |
| 退出前的确认框：按钮 | Quit anyway / Cancel | `j17BCr6YjW` "Quit anyway"、`47FYwba+bI` "Cancel"；Claude 中间还有 `71dtHvbhEs` "Wait for Claude"，Mori 不做（[../v1/walkthrough-1026/WP-20.md](../v1/walkthrough-1026/WP-20.md) 决定 4） |

### 工作回顾

（v1：见 docs/specs/memory.md §10.1、§10.7、§10.8：工作回顾页由记忆页替换，记忆页的文字见规格 §10。下面 UI issues 的文字照旧，放在设置页的 UI issues 一节，"页头"、"分节" 两行不再有；
Feedback 一节和反馈的空列表、详情、导出不再有。依据的 "Jump to source" 与跳不过去时的文字见规格 §10.2。）

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
- Model range: <选择范围>（没有时 None）
- Model: <id>（没有时 None）
- Effort: High（不支持思考时 Unavailable；没有当前模型时 None）
- Running: Yes / No
- Status line: Thinking… 5s（不显示时 Hidden）
- Pending requests: 0
- Permission mode: Ask each time / Allow all
- Split view: Left: <名字> · Right: <名字> (focus in the left pane)
- Right panel: Open / Open · Expanded / Closed（Expanded 是 2026-10-26 加的）
- Window size: 1280×800
- Pane width: 740px（焦点所在那一栏；不在会话页时 None）
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

- 没打开会话时 "Current session: None" 一行代替会话的几项；"Page" 的取值：Session / Settings / Customize / Review / First run / Loading… / Couldn’t load model settings（v1：见 docs/specs/memory.md §10.9：去掉 Review，加 Memory；在设置页的 UI issues 时是 Settings）。
- 解析要求：标题行 `/^# UI issue · (.+)$/`；六节的标题与 `ISSUE_SECTIONS` 一字不差（What went wrong、What you expected、Screenshot、Current view、Recent activity、Versions）；截图行 `/^!\[Screenshot\]\((.+)\)$/`；截图失败行写成 `Couldn’t capture a screenshot: <原文>`（撇号是 U+2019，冒号后一个空格），读的一方用 `/^Couldn’t capture a screenshot:\s*/` 去掉前缀（各节读出来时去掉了首尾空白，原文为空时冒号后就没有空格）；"(left blank)" 与 `reviewText.ts` 的 `EMPTY_FIELD` 相同。
- 报告里你写的一行如果像 Markdown 标题，前面加 `\`，不会被当成一节。

### 工作回顾的导出

（v1：见 docs/specs/memory.md §10.7、§10.8：反馈的导出不再有；UI issues 的导出照旧，在设置页。）

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
| 设置 | Open settings（侧栏的 Settings）/ Open Settings → Models（卡片和菜单里的按钮；带落点时加 " (keys)"、" (zones)"、" (project)"）/ Save user-level AGENTS.md（2026-10-26 起在 Customize › Instructions 里保存） |
| 首次启动、设置 → Models | Save first-run provider <name>（第一次保存，还没有 id）/ Save first-run provider <id> / Add provider <name> / Save provider <id> / Delete provider <id> / Add model <provider>/<id> / Save model <provider>/<id> / Delete model <provider>/<id> / Move model <provider>/<id> -1（上移；下移是 1）/ Add key <provider> / Remove key <ref> / Move key <ref> -1（1）/ Create group <id> / Save group <id> / Delete group <id> / Set defaults <默认范围，没有时 None> · <允许的区域，空格分隔> / Set project zones <path> · <区域，空格分隔> / Confirm zone <provider> · <zone> / Dismiss migration notice / Reload model settings / Verify <provider>/<id> (auto)（拒绝启动卡的 Verify now 可能带多个模型，空格分隔；需要你同意的探针是 (long_input)、(cancel)）；删除的确认框打开时算连带改动的那一次不记；从不记 key 的明文（v1：见 docs/specs/model-discovery.md §5.5：另有 Fetch models <host>（新提供商：Add provider 表单和首次启动表单）/ Fetch models <provider>（卡上）/ Cancel fetch models / Add models <provider> · <条数>；Add provider 仍记 "Add provider <name>"；`models.saveModel` 去掉了 `adding`、不再加模型，界面上也没有新建模型的表单，"Add model <provider>/<id>" 这一行删掉；模型表单的 Edit 和模型行的 Use 发的都是 `models.saveModel`，记 "Save model <provider>/<id>"） |
| 测试连接 | Test connection <provider>/<id>（Keys 的行的 Test 加 " with key <ref>"）/ Cancel connection test |
| 输入框下面一行 | Set model range <范围> / Change effort for this session: <level>（<level> 是 pi 的取值，如 high、xhigh） |
| Customize 页 | Open Customize / Enable（Disable）<单数的类别> <path>（Enable skill …、Disable extension …、Enable prompt template …）/ Enable all in plugin（Disable all in plugin）<source> / Add plugin from folder <path> / Remove plugin <source> / Save MCP server <name> / Enable（Disable）MCP server <name> / Remove MCP server <name> / Switch MCP server <name> to direct calls（2026-10-26：从记忆页 AGENT 的 Edit in Customize 进来时 Open Customize → Instructions） / Save agent <name> / Delete agent <name>（2026-10-26，Customize › Agents；从模型菜单的 Manage agents 进来时 Open Customize → Agents） |
| 工作回顾 | Open Review / View in Review / Review: Feedback / View record: UI issues / Resolve / Reopen / Hide resolved / Show resolved / Export: Feedback / Open folder: UI issues / Show record in Explorer / Jump to source from Review（v1：见 docs/specs/memory.md §8：这一行由记忆页的动作记录替换：Open Memory、Memory: <层或分节>、View in Memory、Dismiss memory notice、Jump to source from Memory、F8 的 View in Settings，以及命令的 Save memory entry、Roll back revision、Turn on enhancement <cwd> 等，全文见规格 §8；设置页的 UI issues 沿用 View record: UI issues、Resolve、Reopen、Hide resolved、Show resolved、Export: UI issues、Open folder: UI issues、Show record in Explorer；Review: Feedback、Export: Feedback 不再有） |
| 其他 | Report a UI issue / Restart background process |

"Feedback"、"UI issues" 是分节名（大写开头），所以放在冒号后面，不嵌进句子中间。

## 实现时要一起改的地方

- 复数：标 `"plural": true` 的条目要按数量选单复数（导出条数、隐藏条数、改动次数、字数、MCP 服务的会话数、已完成的轮数、模型数、剩余秒数）。
  （v1：见 docs/specs/memory.md §10.3–§10.5：另有 token 数 "1 token" / "<n> tokens"（记忆页 AGENT 节、设置页 AGENTS.md（2026-10-26 起在 Customize › Instructions，1000 起按千分位写）、修订详情）和修订详情的会话数 "1 session" / "<n> sessions"；
  增强状态行与修订详情里 1000 起写 "<n>k tokens"（四舍五入到整数）；"<m> feedback" 不分单复数。）
  （v1：见 docs/specs/model-discovery.md §6.1：清单底部的 "Add 1 model" / "Add N models"；"Models (N)" 只有数字、不分单复数。）
  （2026-10-26 加：托盘"Exit"的确认框 "Mori is working in 1 session." / "… in N sessions."，`main/tray.ts`。）
- `ToolsPlugins.tsx` 的开关读屏名要单数（Enable extension x），需要一张单数的分类名表 `KIND_ONE`（extension / skill / prompt template / theme，放在 `shared/protocol.ts` 的 `RESOURCE_KINDS` 旁边）；分节标题仍用复数。`actionLog.ts:93` 的操作记录也用这张表（`command.kind` 是 pi 的复数键）。
- `Sidebar.tsx:66` 收起侧栏时的读屏名要一张小写分句的表 `RAIL_TEXT`（a session needs approval / a session needs input / a session has an error / a session has unread results），不再拼 `STATUS_TEXT`。
- `ChatPane.tsx:50` 上下文用量的读屏名自己拼（"Context usage 42%, about 53,760 of 128,000 tokens"），不再复用悬停说明 `detail`。（2026-10-21 起被 [composer-pickers.md](composer-pickers.md) 取代：用量改成圆环，读屏名 "Usage: Context approximately … of … tokens (N%)"；这里留作记录）
- `state/transcript.ts:302` 重试的 detail 改成 `(${attempt}/${maxAttempts}) · <错误>`，阶段行读作 "Retrying (1/3) · …"。
- 中文 "、" 拼接改成 ", "（`ToolsMcp.tsx` 两处）。
- `reviewText.ts:26` 文件范围在路径和行范围之间加 " · "（"src/a.ts · lines 3–5"），同芯片。
- `main/review.ts:141` 截图失败的正则改成 `/^Couldn’t capture a screenshot:\s*/`（见上 "F8 报告"）。
- 导出的默认文件名按类别取 `feedback` / `ui-issues`，不再用分节名（见上）。
- 已经是英文、但用词要跟着改的错误原文（没有中文，所以清单里原来没有；`translations.json` 里都有条目）：`kernel/config.ts` "API key is required when the base URL changes"（界面上前面加 "Couldn’t save: "，`tests/ui/m0-smoke.mjs:99`、`tests/ui/m6-app-settings.mjs:738` 跟着改成 "Couldn’t save: API key is required when the base URL changes"）；`kernel/sessions.ts:412` 和 `state/projects.ts:180` 同一句 "This session is still running. Stop it first."，`state/projects.ts:182` 跟着它改成 "This session is still opening."；`preload/index.ts:40`、`:62` "Mori’s background process crashed (exit code N)"（`tests/ui/harness/replay.js:457` 跟着改）；`kernel/mcpConfig.ts:388` "Mori only supports direct calls (exposure: direct)."（`tests/ui/m6-app-tools.mjs:1127-1128` 跟着改，record() 的说明也改）；`kernel/resources.ts:299` "<path> is read-only in Customize"、`:343` "This plugin is already added"、`:357` / `:366` "Plugin <source> isn’t in your user-level settings"（`:305` 原来是 "Package … is not in the settings"，`translations.json` 里没有条目，只会在用户级的包上报出，改成同一句）；`main/review.ts:107` 的引号改成 “ ”。
- 审查后补的（2026-10-21）：`main/index.ts` 在 ready 之前 `app.commandLine.appendSwitch('lang', 'en-US')`（不写时 Chromium 按 Windows 显示语言选，中文 Windows 上上下文长度填 0 时浏览器弹出"值必须大于或等于 1。"）；`ConnectionForm.tsx`、`ModelForm.tsx` 的 `<form>` 加 `noValidate`（`min={1}` 不再先被浏览器拦下，Mori 的说明才看得到；`m6-app-settings` 两项检查；v1 已删掉这两个表单，v1 的首次启动表单、提供商表单、模型表单、Add key 和 New group 也都带 `noValidate`）；选文件夹对话框加 `title` / `buttonLabel`（`m1-app` 一项检查）。
- `src/renderer/index.html` 的 `<html lang="zh-CN">` 改成 `lang="en"`（读屏按它选语音，Chromium 按它回退字体）。
- `electron-builder.yml` 的 `nsis:` 下加 `installerLanguages: [en_US]`：不写时 electron-builder 打出带全部语言的安装包，中文系统上安装界面会是中文。
- `tests/check.mjs` 加一项：`src/` 里 .ts/.tsx 的字符串、模板字符串、正则字面量和 JSX 文本（用 TypeScript 语法树找），以及去掉注释后的 .html、.css 不能有中文（含中文标点、全角字符和假名），报 "<文件>:<行> contains Chinese text: …"；注释不查。
- 仓库根目录 `build-installer.cmd` 的输出只用英文：去掉文件末尾的中文提示和失败时切到 65001 用 `findstr` 取出它们的代码。仍要切到 437：实测控制台是 936（中文 Windows 的默认）时，cmd 会把含中文的 REM 注释拆开、把半句当命令执行；65001 和 437 下不切也正常。只在开头 `chcp 437` 还不够（electron-builder 启动的 PowerShell 会把控制台的输出代码页改成 65001，从 936 启动的 cmd 之后又读错），所以脚本记下原代码页、切到 437 后用新的 cmd 重新运行自己，结束时恢复原代码页（见 [english-ui-checks.md](english-ui-checks.md) "测试中发现并已修正的问题"第 5 条）。
- 顶栏宽度：（2026-10-21 起被 [composer-pickers.md](composer-pickers.md) 取代：按钮移到输入框下面一行，阈值重新定；这里留作记录）`chat.css` 的 `@container` 阈值（720 / 600 / 480 / 400px）和 `models.css` 里思考按钮的档位是按中文字宽估的，要用英文重新量（"Effort: Unavailable"、"Extra high ▾"、"Ask each time"、"Allow all"、"Context 100%"；最窄是分屏每栏 280px、中栏 300px），并改那段注释。按 Segoe UI 12px 量，280px 一栏里 "Ask each time" + "High" 已经超出约 15px，所以 400px 以下权限按钮只显示盾牌图标（"Allow all" 保留警告色），模式名放进读屏名 "Permission mode: <模式>"（悬停说明不带模式名，是 "Set the permission mode for this session"）；按钮上的模式名包在 `.permission-text` 里，窄栏时由 `chat.css` 藏起。实际改成的阈值：760px 以下权限按钮去掉图标（`models.css` 里模型按钮 120px 的上限仍在 720px）；660px 以下不显示项目名和 ›（分屏 690px 起，`split.css`）；600px 以下内边距收小、菜单贴右；500px 以下不显示上下文用量；400px 以下权限按钮只显示盾牌。思考按钮的档位（`models.css` 720 / 600 / 400px）不变。工具卡的标题至少留 56px，徽标放不下时截断加省略号。
- 侧栏宽度：侧栏最窄 180px（`state/layout.ts` LIMITS）时，"Needs approval" 只给会话名留约 4px，"New session Ctrl+N" 会折行（2026-10-26 起左栏没有这个按钮和 `.nav-hint` 了，项目行的 + 不折行，见 screens/sessions.md"项目行的 +"）。侧栏做成 size container，窄于 220px（`@container (max-width: 219px)`；1024–1150px 宽窗口的默认宽度 220px 时仍显示文字，会话名留约 44px）会话行只显示状态圆点（状态文字 `.session-status-text` 用 clip 藏起，仍在读屏名里；title 在状态圆点上，不在会话行上），并隐藏 `.nav-hint`。
- 其他宽度：设置页左侧导航 180px 改成 200px（"Connections and models" 不折行）；设置页 760px 以下连接表单的标签放到输入框上面（已保存的 key 的提示 "Saved and encrypted · Re-enter it if you change the base URL" 约 350px，在 96px 标签列旁放不下；分节导航仍到 620px 才横排）（v1 已删掉连接表单和这句提示，分节名改为 "Models"）；Customize 页 MCP 表单的标签列 84px 改成 132px（"Environment variables"、"Server config (JSON)" 不折行）；工具卡状态 `max-width: max(60%, 140px)`（"Waiting for your approval"、"Denied · You pressed Stop" 在分屏 280px 一栏里不截断）；会话右键菜单 `width: max-content`（"Attach as context" + "This is the current session" 约 280px，右边放不下时由 `SessionMenu` 往左挪，不被挤得折行）；会话菜单的项目名和不可用原因（`.menu-hint`）之间留 16px。
- 其他写出固定格式或界面文字的文档要跟着改（说明文字仍用中文；改成本文 "Mori 写出的文字的完整格式" 里的英文，或直接指向这一节）：
  - 引用和会话引用：`defaults.md:42`（引用块开头）、`:49`（字数含 "Turn N" 标题）、`:50`（"Turn N"、"User:"、"Assistant:"、"[Tool]"、"[Quote]"）、`:51`（"约 X 字" 改成 "~N characters"）；`screens/selection.md:61`；`screens/session-refs.md:19-51`、`:28`（"~N characters"）、`:65`（芯片 "Context · <会话名> · turns 3–8 · ~3,200 characters"）、`:80`（预览顶部的轮次范围和字数）。
  - F8 报告：`screens/f8.md:20`、`:42-48`（报告标题、各节、截图行、"Couldn’t capture a screenshot: …"、"(left blank)"）。
  - 工作回顾的导出：`defaults.md:86`（默认文件名 `feedback-<YYYY-MM-DD>.md` / `ui-issues-<YYYY-MM-DD>.md`）、`:87`（`# Feedback` / `# UI issues`、"Exported <time> · N records: a unresolved, b resolved"、"### What you hoped for"、"### Quoted text"、"Couldn’t read this record: …"）；`screens/review.md:104`（对话框标题 "Export as Markdown"、默认文件名）、`:112-120`（开头、条数、各节标题）；`m7-checks.md:147` 那条 "以后改成英文时要一起改工作回顾" 的提醒已经做完。
  - 设置：`screens/settings.md:60`（"Couldn’t save: API key is required when the base URL changes"）。
  - 顶栏和侧栏的宽度：（2026-10-21 起被 [composer-pickers.md](composer-pickers.md) 取代：按钮移到输入框下面一行，阈值重新定；这里留作记录）`defaults.md:57`（≤ 760px 权限按钮去掉图标；≤ 720px 模型按钮最长 120px；≤ 660px（分屏 ≤ 690px）不显示项目名和 ›；≤ 600px 思考按钮只显示强度（"High ▾"）、菜单贴着面板右边；≤ 500px 不显示上下文用量；≤ 400px 去掉 ▾、权限按钮只留盾牌图标；字串 "Effort: Unavailable ▾"、"Ask each time"、"Context 100%"、"<ID> (deleted)"），并加一行侧栏窄于 220px 只留状态圆点、藏起 "Ctrl+N"（`:58`）；`screens/models.md:44` 起的 "窄栏" 一节（同样的阈值；"Effort: High ▾"、"Unavailable ▾"、"Model: <ID> (deleted)"、" (deleted)"）；`screens/approval.md:90`（400px 以下权限按钮只留盾牌）；`screens/chat.md:13`（480px 改成 500px；"Context 12%"、"Context —"、"About 15,360 / 128,000 tokens"）；`screens/sessions.md:58`（状态一行加侧栏窄于 220px 的例外）。
  - 仓库规则：`AGENTS.md:37` "界面文字用中文" 改成界面文字用英文（注释仍用中文），指向本文；`AGENTS.md:45`、`app/README.md:55` 的 `npm run check` 说明加 "界面字串不能有中文"；`app/README.md:39` 改成失败的一步只用英文写明。
- 测试要跟着改（`tests/ui` 里中文的 record() 说明和注释可以留）：
  - 断言界面文字、读屏名、title、F8 报告、导出、操作记录的地方都按 `translations.json` 和本文改成英文（`tests/ui/*.mjs` 几乎每个文件都有）。已知要点：`m2-app.mjs:36`、`:1049-1050`、`:1192-1204`；`m2-real.mjs:30`、`:560-561`、`:621`（"- Page: Settings"）；`m4-app.mjs:310-374`、`:695-696`（芯片 "README.md · lines 1–2"、"Quoting README.md, lines 1–2:"）；`m4-replay.mjs:184-220`；`m5-app.mjs:392-408`、`:438`、`:462`、`:482`、`:513-514`、`:534`、`:550`、`:576-577`；`m5-real.mjs:252-309`；`m5-replay.mjs:243-389`；`m7-app.mjs:89`、`:1404`（`ui-issues-*.md`）、`:160-175`、`:238-242`、`:804-821`、`:1093-1094`、`:1313-1315`（"Export as Markdown"、`feedback-<today>.md`）、`:1332-1395`、`:1700-1713`；`m7-real.mjs:71`、`:604-605`、`:622-624`、`:653-658`、`:724`。
  - `m7-helpers.mjs:204` 用 `/^Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? · (\d+) records?: (\d+) unresolved, (\d+) resolved$/`，`:210` 用 `/^- (?:Record file|Report file): (.+)$/`。
  - 顶栏窄栏：（2026-10-21 起被 [composer-pickers.md](composer-pickers.md) 取代：按钮移到输入框下面一行，阈值重新定；这里留作记录）`m6-app-slash.mjs:882-897` 的 `barProblems` 改成 `permissionIcon: !narrow(760) || narrow(400)`（或看 `.permission-text` 是否可见：`!narrow(400)`）、`crumbLimit = pane.split ? 690 : 660`、`usage: narrow(500) ? false : pane.usageInDom`、前缀 "Effort: "，`:985`、`:1102`、`:1111` 的分档说明跟着改；`m6-app-settings.mjs:1786` 起的 `LEVEL_TEXT` 用 Off / Minimal / Low / Medium / High / Extra high / Max，"Unavailable"、`Effort: ${label}`、按钮名 "Toggle changes"（720 / 600 / 400px 的档位不变）。
  - `tests/ui/m4-record.mjs:116-129` 自己抄的 `quoteBlock` 改成英文格式（`Quoting your earlier reply:`、`` `Quoting ${displayPath(s.path, cwd)}, ${lines}:` ``，`lines` 是 `line N` / `lines a–b`），或像 `m5-record.mjs` 那样用 esbuild 引 `quoteText.ts`；`:280` 检查 `startsWith('Quoting src/a.ts, lines 1–3:')`。
  - 重新录制：`tests/fixtures/m4/quote-*.json`（4 个）、`tests/fixtures/m5/ref-*.json`（4 个），里面 Mori 写的 "引用…："、"第 N 轮"、"用户："、"助手："、"[工具] …"、"[引用] …" 要变成英文（模型自己写的中文可以留）；`tests/fixtures/m7/review-reply.json` 用 `tests/ui/m7-record.mjs` 重新录（报告里的 "- 页面：…"、"- Mori：…"）。
  - `tests/ui/harness/replay.js:457` 改成 `new Error('Mori’s background process crashed (exit code 1)')`；`tests/ui/harness/index.html` 改成 `<html lang="en">`，与 `src/renderer/index.html` 一致。
- 不改行为（会话定的，待负责人确认）：读一行时工具卡仍写 "lines 5–5"（`toolTitle.ts:78`）；MCP 表单在表单和 JSON 之间切换失败时，问题仍显示在 "Couldn’t save:" 后面（`ToolsMcpForm.tsx:160`）。
