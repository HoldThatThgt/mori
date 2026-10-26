# Mori App v0 方案

状态：草案，第二版。更新日期：2026-10-19。

第一版的里程碑在 pi 外面又造了一层后端（规则引擎、快照撤销、端点排队、事件对账等）。
本版改为 **UI 优先**：pi 原样作为后端，Mori 只做界面、离线安装包、一层很薄的进程桥和一个最小批准扩展。

依据：现有 `demo/` 代码审计、六份 proposal 梳理、DSH 现状调研、候选内核与桌面壳对比，
以及 pi 源码与文档核查（以 v1.3.0 为准，参考 `earendil-works/pi` main@`1402973`，相关文件与 1.3.0 相同）。
本版写完后又经过三路审查（后端膨胀、pi 事实、界面完整性），已按审查结果修正。

## 0. 结论

- **做什么**：Windows 桌面 App，可以离线安装。打开文件夹就开始对话，看到模型在做什么、改了什么，
  写入和命令先经你批准。对 App 本身不满意时按 F8 记下来，作为下一轮的工作单。
- **后端**：**pi-coding-agent SDK**（锁 1.3.0），原样使用。
  会话、技能、MCP、插件包、AGENTS.md、自动重试和上下文压缩都用 pi 自己的机制和配置文件。
  pi 没有的能力，v0 也先不做；唯一的例外是一个最小批准扩展。
- **Mori 自己写的**：界面（主体工作）、离线安装包、进程桥、最小批准扩展、反馈与 F8 记录。
  （2026-10-22 加：记忆（身份段与记忆分节的拼装、记忆模块、memory 工具、记忆页）和每个项目的增强任务，见 [specs/memory.md](specs/memory.md)。）
- **外壳**：Electron + React/TS。demo 的布局、视觉、`resize.js`、选区和拖拽交互移植过来；demo 的 JS 逻辑不沿用。
- **里程碑**：M0 壳与安装包之后，M1–M7 都是界面里程碑，验收都是"在界面上看到、做到什么"。

## 1. 诊断：上一轮为什么"只是能跑"

不只是 GLM 能力不够，任务本身的形状就注定只能做出浅层结果。

1. **demo 是故事板，不是应用**。
   - 每次操作都用 `innerHTML` 重绘整页（`demo/app.js:129`）。
   - 助手消息是写死的 HTML 模板，没有消息模型、流式、工具调用和持久化。
   - 真正经过打磨的只有布局、拖拽调宽、选区引用和拖会话这几个交互。
2. **proposal 在要求假实现**："界面 demo 的启停、连接与版本均为本页示例状态"（proposal.md:244）。
3. **规格指向仓库里不存在的 DSH 内部模块**，实现者只能在 mock 上画 UI。
4. **规则多是否定式**："不能/不等于"在 mock 上永远成立；验收表缺少可走查的用户体验标准。
5. **核心对象"任务"从未定义**，右侧"任务与文件"只能做成装饰。

所以本轮要改的不只是技术栈，还有**工作的形状**：真实后端、正向的"必须看到"、界面走查验收、禁止示例数据。

第一版方案又犯了另一个错：为了可靠性和安全，把 pi 没有的能力都放进 v0，结果每个里程碑都像后端任务。
本版的原则是：**pi 有的，界面直接用；pi 没有的，先不做。**

## 2. 产品原则

1. **第一天就是真的**：真后端、真模型、真文件，产品里没有示例数据。
2. **状态有来源**：界面上的每个状态都能追到一个来源，即 pi 的事件、批准扩展的请求，或你刚做的操作；
   没有来源就不显示。
3. **写入和命令先批准**："已停止"不等于"已撤销"，界面上明说（"Stopped · Changes made so far stay as they are"）。
4. **界面不谈自己**：界面文字不出现"演示""内核""回合""事件""SDK""compat"这类实现用语，
   也不出现"执行者""角色会话""任务版本"这类 proposal 术语。界面是英文（2026-10-21 起），对应地不出现 demo、mock、
   sample、example data、kernel、event、SDK、compat layer、IPC、renderer、utilityProcess，也不出现 executor、
   role session、task version 和版本代号 v0；"轮"在界面上写 turn，是你看得到的说法，不算实现用语
   （见 [v0/ui-strings.md](v0/ui-strings.md)）。所有操作都能用键盘完成。
   （2026-10-21：协作模式下界面显示你自己定义的角色名和 “Request 1”“T1” 编号，按 [specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md)；“实例”“权限会话”这类实现用语仍不出现。）
5. **配置就是 pi 的配置**：界面读写 pi 自己的配置文件，不另建一套格式。
   （2026-10-21 改：模型这一层改用 Mori 自己的模型配置，从 `models.json` 迁移一次，见 [specs/model-providers.md](specs/model-providers.md)；其余配置仍是 pi 的。）
   （2026-10-22 改：记忆文件也是例外：`<userData>/memory/` 下的条目、修订记录与增强设置是 Mori 自己的格式，只由记忆模块读写，见 [specs/memory.md](specs/memory.md) §3；AGENTS.md 仍是 pi 的。）

## 3. 后端与外壳选择

| 候选 | 能给 UI 的东西 | 关键问题 | 结论 |
| --- | --- | --- | --- |
| **pi-coding-agent SDK**（MIT，1.3.0） | 文本、思考和工具参数的增量流；排队、插话与停止；会话列表与命名；编辑 diff；技能、MCP、插件包；Windows shell | 不在工具调用前询问，需要一个小扩展；每周多次发布，必须锁版本 | **采用** |
| DSH（`dsh --profile acp`） | 会话、取消、权限请求、模型切换 | ACP 只发整条消息，**没有逐字流式**；恢复会话不回放历史；开发者预览，8 天 990 个提交 | 不作 v0 后端 |
| DSH fork 改 UI | 完整功能 | 约 500 个包，结构性简化要改大量 slot，上游每天上百提交 | 不做 |
| 自写最小循环 | 完全可控 | 最难的是各家端点的兼容怪癖，pi-ai 已经处理好 | 不做 |
| LangGraph / deepagents | 适合以后做多 agent | 对编码 UI 来说粒度太粗；兼容端点和 Windows 表现未验证 | 不选 |
| opencode | 功能最全 | v1→v2 接口正在重做；Windows 推荐用 WSL | 不选 |
| Codex app-server | 协议设计好 | 只支持 Responses API，内网 chat-completions 端点用不了 | 不选 |

DSH 自己的模型连接器 `dsh-llm-pi-ai` 依赖 pi-ai，v0 积累的模型配置和兼容经验以后可以带到 DSH。

外壳选 **Electron 44.9**（自带 Node 24.22，满足 pi 要求的 ≥22.19）+ electron-vite + electron-builder NSIS，不签名。
前端用 **React 19 + TypeScript + zustand**；Markdown 用 streamdown，代码高亮用 shiki，diff 用 @pierre/diffs，
长列表用 virtua。这些依赖都要在 M0 确认能离线打包，不能运行时从 CDN 拉取。

## 4. 谁负责什么

| 能力 | 由谁提供 | 界面做什么 |
| --- | --- | --- |
| 对话、流式、工具执行、停止、排队、插话 | pi | 渲染事件；按钮对应 pi 的 `abort` / `clearQueue` / `followUp` / `steer` |
| 自动重试、上下文压缩 | pi（`auto_retry_*`、`compaction_*` 事件）。2026-10-21 起重试由模型层的模型池做，pi 的自动重试关闭 | 显示"Retrying (1/3)"、"Compacted session" |
| 会话保存、列表、打开、命名 | pi（`SessionManager`） | 侧栏、改名 |
| 会话归档与删除 | Mori（pi 没有归档和删除接口） | 照 Claude 桌面版：归档（可以恢复，已归档列表记在本机）；删除是永久的，先确认（2026-10-19 改）。2026-10-21 起：会话里有平行 Agent 在运行时也算生成中；删除同时永久删除这个会话的 TaskBoard 和实例会话文件（[specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md) §11.5） |
| 编辑后的 diff | pi（edit 结果的 `details.patch`；write 不提供 diff） | 工具卡与右栏显示；写入显示新内容 |
| 模型与端点 | v0：pi（`models.json`）。2026-10-21 起：**Mori 模型层**（分组、提供商、多个 key、模型、网络区域、选择器、模型池、档案与探针，[specs/model-providers.md](specs/model-providers.md)） | 连接表单、"Test connection"；模型层起见规格 §9 |
| AGENTS.md | pi（每个目录取 AGENTS.override.md、AGENTS.md、CLAUDE.md 中第一个存在的） | 用户级编辑，项目级只显示加载了哪些文件 |
| Skill | pi（`SKILL.md`，Agent Skills 规范） | 工具页列出、查看、启停 |
| MCP | pi（`mcp.json` 加 pi 的 MCP 扩展）；**Mori 共享连接**：每个服务一个进程，所有会话共用（2026-10-20 改为照 Claude 桌面版，[v0/m6-mcp-shared.md](v0/m6-mcp-shared.md)） | 工具页添加、启停、看工具、进程状态和错误原文 |
| Plugin | pi packages（一个包打包扩展、技能、提示词、主题） | 工具页添加本地包、按资源启停 |
| 项目信任 | pi 提供判断与存储（`hasTrustRequiringProjectResources`、`trust.json`） | 何时弹窗由 Mori 接线（SDK 默认不问，见第 6 节） |
| 批准 | **Mori 最小扩展** | 批准卡、权限切换 |
| 选区反馈、F8 界面问题 | **Mori** | 记录、收件箱、导出（2026-10-22 改：反馈不再单独成列表，作为开了增强的项目的增强依据；F8 界面问题挪到设置页"UI issues"，见 [specs/memory.md](specs/memory.md) §10.7–§10.9） |
| system prompt 拼装（2026-10-22 加） | **Mori**（inline extension `mori-memory`，经 pi 的 `before_agent_start`，[specs/memory.md](specs/memory.md) §4、§5） | — |
| 记忆与记忆页（2026-10-22 加） | **Mori**（记忆模块、memory 工具，[specs/memory.md](specs/memory.md) §3、§6、§7） | 记忆页（"Memory"）替换工作回顾：浏览、编辑、移动、回滚；对话里的 memory 工具卡 |
| 增强任务（2026-10-22 加） | **Mori**（每个项目的开关与每天的时刻、全应用串行的队列、看不见的会话，[specs/memory.md](specs/memory.md) §9） | 记忆页本项目顶部的开关、状态行、"Run now"、"Enhancement settings"；新会话顶部的提示 |
| 离线安装、进程桥 | **Mori** | — |

**pi 没有、v0 也不补的能力**（以后真用起来缺了再加）：

- 撤销与文件快照：v0 只看 diff，回退用 git。
- 按命令前缀放行、复合命令识别等批准规则。
- 端点并发排队：端点忙时由 pi 的自动重试处理，界面如实显示。（2026-10-21 起由模型层的模型池做，[specs/model-providers.md](specs/model-providers.md)）
- 完整模型体检（v0 只有"Test connection"）、原始请求轨迹、后台进程重启后的自动恢复。（模型体检 2026-10-21 起由模型层的探针做；其余仍不做）
- MCP 每个会话的连接状态：pi 没有提供；v0 显示 pi 给出的工具列表和错误原文，加上共享连接的进程状态，不显示"Connected"。
- MCP 的 codemode 和延迟加载方式：v0 只支持直接调用。

**界面上 v0 不做的**（2026-10-21 起多 agent 与任务记录按 [specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md) 做；监督、模型判决式验收仍不做；2026-10-22 起定时回顾由增强任务替代，见 [specs/memory.md](specs/memory.md) §9）：任务记录、多 agent、监督、模型判决式验收、定时回顾、模型池、内嵌浏览器、交互式终端、
暗色模式（CSS 先 token 化，以后成本很低）、demo 里的项目主页和任务阶段面板。

## 5. 界面与交互

每屏的完整状态表（空 / 加载 / 流式 / 等批准 / 错误 / 已停止）在实现该屏前写进 `docs/v0/screens/`。
本节只定主要行为。

### 5.1 布局

- **三栏**沿用 demo 的视觉和 `resize.js`。CSS 抽成约 30 个 token，字号同时重排：
  正文和输入框 13–14px，辅助文字（时间、来源、徽标）不小于 12px，demo 中 8–11px 的一律上调。
- **调宽**：分隔线可拖动，方向键每次 20px，双击恢复默认，宽度重启后保留。左栏可收起为图标栏。
- **窄窗口**：窄于 1024px 时左栏自动收起，窄于 800px 时右栏浮在上层；最小窗口 800×600。
- **左栏**：
  - "New session"作主按钮（Ctrl+N），"Open folder…"。
  - 导航：工具（Customize）、工作回顾（Review）。（2026-10-22 改：工作回顾换成记忆（"Memory"），见 [specs/memory.md](specs/memory.md) §10.1。）
  - 项目→会话树。
  - 底部："Settings"和"Report a UI issue (F8)"。
- **中栏**：
  - 顶栏：会话名（"项目名 › 会话名"）、右栏开关，分屏时还有"Close pane"。
  - 下方依次是对话流、阶段行、批准卡或询问卡、排队区和输入框。
  - 输入框下面一行（照 Claude 桌面版 prompt box 下面那一行；2026-10-21 起，原来在顶栏）：左端权限（"Ask each time" / "Allow all"，
    照 Claude 的模式选择只有文字，窄时截断）；靠右依次是选择范围（v1：分组、提供商或模型，[specs/model-providers.md](specs/model-providers.md) §9.2）、
    思考强度（Effort，单独一个按钮）、上下文用量的小圆环，
    最右是发送和停止（同一位置）。
- **右栏**：本会话的改动和文件阅读，见 5.9。
- 工具、设置、工作回顾（2026-10-22 起为记忆页）这几个独立页面顶部都有"Back to app"。
  返回时恢复分屏、滚动位置、右栏打开的文件和各会话草稿。

### 5.2 首次启动与连接

- 首次启动只有连接表单（"Connect a model"）：名称、服务地址、接口类型（默认 OpenAI 兼容）、API key、模型 ID、
  上下文长度，以及"Compatibility options"（每项配一句说明，例如"Endpoint doesn’t support the developer role"；
  列表登记在 `docs/v0/defaults.md`）。
- 保存时写入 pi 的 `models.json`，并把它设为默认模型。（2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §9.1：写 Mori 的模型配置，表单加网络区域）
  API key 由 Mori 用系统加密（Windows 上是 DPAPI，绑定当前用户）保存在本机，不写进 `models.json`，也不放进环境变量；
  启动时解密后只交给 pi 放在内存里，模型运行的命令读不到它。不再支持 `$环境变量名` 这种命令行时代的写法。
- "Test connection"：按钮变为"Testing…"，可以取消。成功时显示首字耗时，失败时显示错误原文。
- 测试成功后进入"Open folder…"。
- 同一张表单也是设置页"Connections and models"里的连接，以及错误卡上"Go to settings"打开的地方。
- 后台还没准备好时，输入框可以打字但不能发送，显示"Starting…"。

### 5.3 项目与会话

- **项目** = pi 会话列表里出现过的文件夹，加上本次打开的文件夹。
  打开文件夹即新建一个会话；发出第一条消息后会话才会保存。
- **新会话**（"New session"）属于当前项目，名字先取第一条消息的前 20 个字。
- **会话右键菜单**：重命名、引用到当前会话、在右侧分屏打开、归档、删除（已归档的会话：恢复、删除），
  界面上是"Rename"、"Attach as context"、"Open in split view"、"Archive"、"Delete…"（已归档的："Unarchive"、"Delete…"）。
  用菜单键或 Shift+F10 打开，方向键选择；分屏的标题行上也有同一菜单。
- **归档与删除**（2026-10-19 改为照 Claude 桌面版）：归档不确认，会话移到侧栏底部的"Archived"，可以恢复；
  删除先确认："Delete “X”?"，说明"This session will be permanently deleted. This can’t be undone."。
  正在生成的会话不能归档或删除。删除后，分屏中这一栏关闭，指向它的引用显示"Session deleted"。
- **状态点**只给后台进程里开着的会话（本次运行中打开过的，界面重新加载后也接着显示），并配文字：
  生成中 / 等你批准 / 等你回答 / 出错 / 有新结果（"Running" / "Needs approval" / "Needs input" / "Error" / "Unread"）。
  "Unread"是该会话不可见时完成了一轮，点开后消失，不跨重启保存。
- **草稿**：每个会话各自保存（含输入框里的引用芯片），切换会话、去别的页面再回来、重启 App 后都还在。
- **项目信任**：打开的文件夹带有自己的扩展或配置（`.pi/`）时，先弹窗"Trust this workspace?"：
  "This workspace has its own extensions or settings. If you trust it, they’ll run on your computer."
  选项为"Trust workspace"和"Don’t trust"，可勾选"Remember my choice"。

### 5.4 对话流

- 旧会话按 pi 记录的当前分支渲染：显示你的消息、助手回复和工具结果；
  压缩处显示一行"Compacted session"；系统提示、用量、模型切换等记录不显示。
- 先显示最近 50 条消息（一条你的消息或一条助手回复算一条），滚到顶部时再载入更早的 50 条。
- 助手正文按 Markdown 渲染。思考内容流入时展开，正文开始后自动折叠。
- 流式输出不打断输入框、选区和滚动位置。你不在底部时不自动滚动，有新内容时显示"Jump to latest"（带向下的箭头）。
- 每条助手回复下有：复制、引用到输入框、反馈这条回复（"Copy"、"Attach message as context"、"Give feedback"）。
  照 Claude 桌面版，一轮回复（含多次工具调用）只在最后一行，最新一轮常显，较早的悬停或键盘聚焦时显示（2026-10-20 定）。
- 新会话的空状态显示项目名和"Enter to send · Shift+Enter for new line"。

### 5.5 工具卡

- **标题**用人话：Read `src/a.ts`、Edit `src/a.ts`、Write `docs/a.md`、Run `npm test`、
  `<服务> · <工具>`（MCP）；未知工具显示原名。完整对照表写进 `docs/v0/screens/`。
- **状态与来源**：
  - 准备中（"Preparing…"）：模型正在生成这次调用的参数。
  - 等你批准（"Waiting for your approval"）：批准扩展发出请求时。
  - 执行中（"Running…"）：你点"Allow once"或"Allow “<工具>” for this session"之后；自动放行的工具在开始执行时。
  - 完成 / 失败（"Done" / "Failed"）：工具执行结束，按是否出错区分；失败显示退出码（"Failed · Exit code 1"）或错误原文。
  - 已拒绝（"Denied"）：你拒绝时，附你写的理由（"Denied · <理由>"）。
  - 已停止（"Stopped"）：你按了停止；已中断（"Interrupted"）：Mori 后台进程退出时还没结束。
- 自动放行的卡标"Allowed for this session"或"Allow all"，让你知道它为什么没问。
- 默认折叠，展开看参数和输出；编辑类工具展开后显示实际 diff。耗时只在实时运行时显示，旧会话的工具卡不显示。

### 5.6 阶段行

全部由 pi 事件和批准请求推出，本轮结束后隐藏。

- 每次请求模型（包括工具执行之后再次请求）时，显示"Waiting for the model… 12s"，直到助手开始回复。
- 思考内容流入时显示"Thinking… 5s"，正文流入时显示"Responding…"。
- 执行工具时显示"Run npm test 8s"；有批准卡挂起时显示"Waiting for your approval"。
- 自动重试时显示"Retrying (1/3) · <原因>"；压缩时显示"Compacting session…"。（2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §9.3：重试、排队、等模型由模型层的事件提供）

### 5.7 批准

- **哪些要批准**："Ask each time"档下，只有读取、搜索、查找、列目录四个只读工具直接放行，其余所有工具
  （命令、编辑、写入、MCP 工具、插件和项目扩展注册的工具）都出批准卡。放行名单是一个常量，没有其他规则。
- **卡片内容**：编辑显示每处替换的原文和新文（取自调用参数）；写入显示将写入的内容；
  命令显示完整命令行；MCP 工具显示"<服务> · <工具>"和格式化后的参数。同一条回复里的多个调用逐张出卡。
- **选项**：
  - 允许一次（"Allow once"）。
  - 本会话不再询问（"Allow “Run commands” for this session"，按工具名；命令类下方小字
    "You won’t be asked again for any command in this session."）。
  - 拒绝（"Deny"），可以写理由（"Tell the model why (optional)"），理由会作为工具结果回给模型。
- **焦点**：卡片出现时不抢输入框焦点，没有默认按钮，Enter 不会批准。
  用 Tab 或 Alt+1 / Alt+2 / Alt+3 选择；焦点在卡片上时 Esc 等于拒绝。
- **提醒**：窗口不在前台时任务栏闪烁。
- **权限菜单**（输入框下面一行的左端；2026-10-21 前在顶栏）：
  - 按钮只有文字（"Ask each time ▾" / "Allow all ▾"，"Allow all"用警示色），没有图标；窄时模式名截断，全名在悬停说明和读屏名里。
  - 只作用于当前会话；新会话都从"Ask each time"开始。（2026-10-21：作用于这个会话的全部 Agent，菜单说明改为"Applies to all agents in this session. New sessions start at Ask each time."，后台实例的批准卡标出角色和 task，[specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md) §11）
  - 菜单里在"Allowed for this session:"下列出"Run commands"、"Write files"等，每项可以"Forget"。
  - 切到"Allow all"前确认一次（"Switch to “Allow all”?"，文案为"Edits, writes, and commands will run without asking."）；
    切换时挂起的卡按允许处理。

### 5.8 停止、排队、插话与错误

- **输入**：输入法组字时 Enter 不发送；Shift+Enter 换行。
- **排队**：生成中输入框有字时，按钮区显示"Stop"和"Queue"（下拉里有"Steer"）。
  - Enter 排队（Queue）：排队区显示待发消息（标"Queued"），本轮结束后依次发出。"Withdraw"把排队消息全部放回输入框。
  - Ctrl+Enter 插话（Steer）：等本轮回复的所有工具调用执行完，在下一次请求模型前送达；多条插话每次送一条。
- **停止**：
  - Esc 先关闭最上层的浮层、菜单或对话框；没有浮层且焦点在这个会话时才停止。
  - 停止时先把排队消息放回输入框，再停止生成。有批准卡时按拒绝处理。
  - 停止后显示"Stopped · Changes made so far stay as they are"。（2026-10-21：协作模式下停止只停对话这一回合，后台 Agent 由 `Stop team` 停止，[specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md) §11.4）
- **错误**：都显示原文，来源有三种：发送时就失败（例如找不到模型或 key）、模型回复出错、自动重试最终失败。
  - 原文里有 401、unauthorized 或 api key 字样时，附"Go to settings"（这条文字匹配登记为临时默认值）。（2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §9.3 删除：认证类错误由模型层换 key、换模型或给出说明卡）
  - 其他错误附"Put your last message back in the message box"，由你决定是否再发。
- **后台进程退出**：每个打开的会话显示"Mori’s background process crashed · Unfinished responses were interrupted"
  和"Restart"。重新载入时从会话文件恢复对话；排队消息、批准卡和本会话已允许的工具不恢复，界面上明说
  （"Restarted · Queued messages, pending approvals, and “Allow for this session” choices weren’t restored"）。草稿不受影响。

### 5.9 右栏：改动与文件

- 列出本会话编辑或写入过的文件，点开按时间顺序显示每次编辑的 diff；写入显示新内容。
  列表顶部注明："Only edits and writes are listed. Files changed by commands aren’t included."
- 点工具卡或改动列表里的文件路径，打开只读阅读器；也可以用系统默认编辑器打开（"Open in default app"）。
- 没有改动时默认收起；手动打开时显示"No changes yet."。
- 文件已不存在时显示"File not found"；二进制或超过 1MB 的文件显示"Preview unavailable"。
- 分屏时右栏跟随焦点所在的一侧。

### 5.10 选区：问 Mori（Attach as context）与反馈（Feedback）

- 选中聊天或文件里的文字，浮层显示"Attach as context"和"Feedback"。范围是助手回复（含工具卡）和文件阅读器，你自己的消息里不出现；
  阅读器只用鼠标选字（照 Claude 桌面版带语法高亮），用键盘引用走回复下的"Attach message as context"（2026-10-20 定）。
- **问 Mori**（"Attach as context"）：把原文和来源作为引用芯片放进输入框；发送后点芯片可以回到原位置，重启后也可以。
  原位置不在已载入范围时自动载入；原文已变化时保留引用当时的原文，并提示"Source changed"。
  文件里的引用"Source changed"指引用的文字在文件里找不到了；别处改了、原文还在就跳到它现在的位置。只在点芯片时检查，不监视文件
  （2026-10-20 定：不拿内存和 CPU 换性能）。
- **反馈**（"Feedback"）：只问"What result were you hoping for?"，底部写
  "This is only saved to Review and isn’t sent to the model. To have Mori act on it, use “Attach as context” instead."。
  提交后提示"Saved · View in Review"；保存失败时保留已输入的文字并显示错误。
  （2026-10-22 改：底部说明按这个项目是否开了增强写：开了是"Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use “Attach as context” instead."，
  没开是"This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on it, use “Attach as context” instead."；
  提交后只提示"Saved"，见 [specs/memory.md](specs/memory.md) §10.7。）
- 锚点：会话与消息的记录 id，或文件路径加内容哈希、行范围和原文。

### 5.11 分屏与会话引用

- **分屏**：
  - 把会话名拖到聊天区左侧或右侧，放下前提示"Drop to open in split view on the right"；
    也可以用右键菜单的"Open in split view"。
  - 最多左右两栏。每栏有自己的标题行（可右键、可拖）、输入框（下面一行有权限、模型、Effort 和上下文用量）、草稿和批准卡。
  - Esc、F8 和右栏都以焦点所在的一栏为准。分屏中线可以拖动。
  - 拖入已经打开的会话只切换焦点。两栏各不足 280px 时先收起右栏。
  - 关闭分屏不会停止正在生成的会话。
- **会话引用**：
  - 把会话名拖进输入框（或用右键菜单"Attach as context"），生成芯片"Context · <会话名> · turns 3–8 · ~3,200 characters"。
  - 一轮 = 你的一条消息，加上它之后、下一条消息之前的全部回复。
  - 引用内容只取你和助手的正文，工具调用压成一行标题，不含思考内容。
    默认引用全部；超过 2 万字时默认改为最近 5 轮（临时默认值）。
  - 点开芯片可以预览每轮内容并调整范围。引用正在生成的会话时，只取已完成的轮次。
  - 发送后点消息里的引用可以跳回原会话；原会话改名后仍有效，删除后显示"Session deleted"，原文仍可查看。

### 5.12 设置页

- **连接**（"Connections and models"）：与首次启动同一张表单；可以添加多个模型，并设定默认模型。（2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §9.1：由设置页 Models 分节取代）
- **思考**：每个模型可以标"Supports thinking"（写入 `models.json` 的 `reasoning: true`，pi 才会发送思考参数），
  并设定新会话默认的思考强度（"Default effort for new sessions"，pi 的 thinking level）。
  输入框下的 Effort 按钮按会话切换思考强度（"Effort: High"；2026-10-21 前在顶栏）；模型不支持思考时这一项不可选，并说明原因。
- **用户级 AGENTS.md**：编辑 `<agentDir>/AGENTS.md`，标出当前实际生效的是哪个文件。有未保存改动时离开，先询问。
  （2026-10-22 加：每个文件的 token 数，合计超过 500 时标出来、不截断，见 [specs/memory.md](specs/memory.md) §10.3。）
- **界面问题**（"UI issues"，2026-10-22 加）：工作回顾里的 F8 报告列表与详情挪到这里，在 AGENTS.md 下面，见 [specs/memory.md](specs/memory.md) §10.8。

### 5.13 工具页（Customize）

- 跟随当前焦点会话的项目。没有打开的会话时，只列 Skill 和 Plugin。
- **内置工具**：当前会话注册的全部工具，标出是否启用和来源。
- **Skill**：pi 找到的全部技能（含已停用的），显示来源（用户级 / 本项目）、用途和正文，可以启停。
- **MCP**：
  - "Add"表单（名称、命令、参数、环境变量），另有"Edit as JSON"；写入 pi 的 `mcp.json`，启停即 `enabled`。
  - Mori 添加的服务都写成直接调用方式。已有的服务如果是 codemode 或延迟加载方式，显示
    "This server is set to “<方式>”. Mori only supports direct calls, so the model can’t call its tools."，
    并提供一键改为直接调用（"Switch to direct calls"）。
  - 显示该服务注册的工具名；连接出错时显示 pi 给出的错误原文。没有结构化的"Connected"标记，因为 pi 不提供。
  - 每个服务一个进程，所有会话共用（照 Claude 桌面版）：用户级启用的 stdio 服务在 Mori 启动时起、开到退出，HTTP 服务第一次用时才连；
    项目的服务在项目文件夹里运行，这个项目最后一个会话关闭后关掉；
    显示共享连接的进程状态（运行中和在用的会话数、启动中、失败原文："Running · Used by 1 session"、"Starting…"、"Failed: …"）。
- **Plugin**：
  - "Add plugin from folder…"选择文件夹，写入 pi 设置的 packages。
  - 列出包内的扩展、技能、提示词和主题，按资源启停；"Disable all"即全部资源停用。
  - 内网只支持本地文件夹的包，包要自带依赖。主题标"Not used by Mori"。
- **启停的写法**与 `pi config` 相同：v0 只支持用户级启停；项目级的覆盖只显示，不能在这里改。
- **输入框 "/"**：列出 pi 的提示词模板和技能命令，选中后插入。

### 5.14 工作回顾页（Review）

（2026-10-22 改：工作回顾页由记忆页（"Memory"）替换，见 [specs/memory.md](specs/memory.md) §10；反馈不再单独成列表，界面问题挪到设置页（5.12）。下面是 v0 的做法。）

v0 只汇总和导出，不做定时回顾和候选整理。

- **对内容的反馈**（"Feedback"）：列出所有选区反馈和回复反馈，显示原文、你的期望和来源，可以跳回原位置。
- **界面问题**（"UI issues"）：列出 F8 报告，带截图。
- 两类都可以标为已处理（"Resolve"，标后显示"Resolved"）并用"Hide resolved"筛掉，都可以导出为 Markdown（"Export as Markdown…"）。

### 5.15 F8 报告界面问题（Report a UI issue）

- 按 F8 或点左下角的"Report a UI issue (F8)"，自动附上截图、当前界面和最近的操作记录，只问"What went wrong" /
  "What you expected"。
- 保存为 Markdown 文件和截图，提示保存位置（"Saved to <文件>"），可以"Show in Explorer"。

## 6. 架构

```text
app/
  src/shared/protocol.ts     Mori 自己的命令（zod 校验）；pi 事件只 import 类型，不重新定义
  src/main/
    index.ts                 窗口、菜单；utilityProcess.fork 启动后台进程，退出时通知界面
    feedback.ts              反馈与 F8（截图用 capturePage；不依赖 pi，后台进程退出也能记录）
    credentials.ts           API key 用系统加密保存；启动时解密后经进程通道交给后台进程
  src/preload/               contextBridge 暴露 window.mori，用 MessagePort 直连后台进程
  src/kernel/
    host.ts                  创建、打开、并存多个 pi 会话；转发事件；执行命令
    approval.ts              最小批准扩展
    trust.ts                 项目信任接线
    config.ts                读写 pi 的配置文件（models.json、mcp.json、settings.json、AGENTS.md）
  src/renderer/              React；从 demo 移植 CSS token、布局、resize、选区与拖拽交互
  tests/ui/                  Playwright _electron 界面走查测试
  tests/fixtures/            从真实会话录下的 pi 事件，供界面测试回放
docs/v0/                     screens/（每屏一张状态表）、defaults.md
```

**后台进程（utilityProcess）只做八件事**（第 5 件 2026-10-20 加，第 6、7 件 2026-10-21 加，第 8 件 2026-10-22 加）：

1. 调用 pi SDK：新建或打开会话、`prompt`、`steer`、`followUp`、`clearQueue`、`abort`、改名、读写配置。
2. 转发事件：`session.subscribe` 收到的事件原样转发，外面包一层 `{ sessionId, event }`。
   唯一的精简：`message_update` 只转发类型、内容序号和增量，不带完整消息，否则传输量随回复长度平方增长。
3. 转达批准请求，以及 pi 扩展的界面请求（通知、确认、选择、输入；pi 的 RPC 模式另外还转达的编辑器、状态栏、小部件、标题 v0 不做）。
4. 补充条目 id：pi 先发 `message_end` 再写入会话文件，后台进程随后从当前分支找到这条消息的 id 补发给界面，
   供反馈和引用做锚点。
5. MCP 共享连接（`mcpShare.ts`，[v0/m6-mcp-shared.md](v0/m6-mcp-shared.md)）：pi 的 MCP 扩展给每个会话要传输时，
   交给它挂在共享服务上的虚拟传输；每个服务一个真连接（pi 自己起进程、连 HTTP 的方式），各会话的请求按编号转发。
   pi 的 MCP 扩展不改。
6. 模型层（2026-10-21 加，[specs/model-providers.md](specs/model-providers.md)）：Mori 自己的模型配置与迁移、选择器、按 key 的模型池、
   模型档案与探针；每个会话的模型请求经 Mori 的虚拟模型、流函数包装和模型池的 fetch 发出。
   （2026-10-23 加：一键拉取模型，即你点 Fetch models 时读出服务的模型列表和它报告的窗口、输出上限、思考、图片，探针第 0 步用同一个读取器，
   按 [specs/model-discovery.md](specs/model-discovery.md)。）
7. 平行 Agent 与 TaskBoard（2026-10-21 加，[specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md)）：读 `.mori/agents/*.md`，协作模式下的立项与对话，按 task 建实例会话，TaskBoard 服务、
   唤醒与交接、工作卡、写入排队，把后台实例的批准请求、回执和进展交给界面。
8. 记忆、拼装与增强（2026-10-22 加，[specs/memory.md](specs/memory.md)）：记忆模块（条目、修订记录与回滚唯一的读写入口）与 memory 工具；
   inline extension `mori-memory` 每次运行写身份段和四个记忆分节；每个项目的增强任务（每天的时刻与补跑、全应用串行的队列、看不见的会话）。

**会话与数据**

- `host.ts` 持有 `Map<sessionId, AgentSession>`，每个会话用 `createAgentSession` 独立创建；
  打开过的会话一直保持存活，直到归档、删除或退出；界面重新加载也不停，重新加载后的界面接上它们（2026-10-19 改为照 Claude 桌面版：
  会话不因不在屏幕上而停）。不做调度、优先级或并发限制（模型请求的排队和优先级属于第 6 件事，2026-10-21；后台实例的同时运行上限属于第 7 件事；
  增强任务的一个定时器和全应用同一时刻只跑一个的队列属于第 8 件事，2026-10-22）。
- 历史：后台进程调用 `SessionManager.open(path).getBranch()`，把当前分支的条目交给界面；不自己解析会话文件。
- 引用来源用 pi 的自定义条目（`appendCustomEntry("mori.ref", …)`）写进会话文件，它不进入模型上下文。
- 会话内容只存一份，就是 pi 的会话文件（2026-10-21：协作模式另存 `<userData>/teams/<会话 id>/` 下的 TaskBoard 和各实例的 pi 会话文件）。Mori 自己只保存：界面状态（栏宽、分屏、各会话草稿、已归档的会话列表）、
  反馈和 F8 报告，以及加密后的 API key（`<userData>/credentials.json`）。
  （2026-10-22 加：记忆 `<userData>/memory/`：条目、修订记录、增强设置与水位、增强任务的会话文件，见 [specs/memory.md](specs/memory.md) §3。）
- API key：主进程用 Electron safeStorage 加密保存；启动时解密，经进程通道交给后台进程，
  后台进程用 pi 的 `setRuntimeApiKey` 只放在内存里。key 不进 `models.json`，也不进任何进程的环境变量。
  （2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §8.4：一个提供商可以有多个 key，按引用存；明文只在模型池的内存里，pi 只拿到占位 key。）

**pi 装配要点**（已对照 pi 源码核查）

- **离线**：import pi 之前设 `PI_OFFLINE=1`、`PI_TELEMETRY=0`、`PI_CODING_AGENT_DIR`。
  v0 用 pi 的默认工具（读取、命令、编辑、写入），不需要 rg 和 fd；以后启用搜索工具时再把它们放进 `<agentDir>/bin`。
- **目录**：`agentDir` 默认是 `%APPDATA%/Mori/pi`，目录结构与 pi 一致；每处都显式传 `cwd`。
  注意 pi 仍会读取 `%USERPROFILE%\.agents\skills`。
- **项目信任**：SDK 默认信任项目，不接线就会不经询问加载 `.pi/extensions`。
  每个文件夹用 `projectTrusted: false` 创建设置，再在 `resourceLoader.reload({ resolveProjectTrust })` 的回调里，
  照 pi 命令行（`src/main.ts:720–778`）的流程处理：
  `hasTrustRequiringProjectResources(cwd)` 为假就不问；`trust.json`（`ProjectTrustStore`）有记录就用记录；
  否则弹窗，勾了"Remember my choice"就写回 `trust.json`。AGENTS.md 不受信任控制，照常加载。
- **MCP**：SDK 会话不加载 pi 的内置扩展。照 pi 自己的注册方式把 MCP 扩展作为内置扩展加入
  （`{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true }`），
  这样 `pi config` 和设置里的启停对它有效；再对每个会话调用 `bindExtensions()`，服务才开始连接。
  codemode 不进 v0，所以服务要用直接调用方式。
  `createMcpExtension` 多传 `{ createTransport }`：用户级、项目级的服务走 Mori 的共享连接（第 5 件事），
  扩展注册的服务照 pi 原来的方式直连。pi 起进程的 `createDefaultTransport` 和读配置的 `loadMcpConfig` 没有导出，
  按 pi 1.3.0 包里的文件路径载入，pi 升级时复查。
- **扩展界面**：`bindExtensions` 时传入 Mori 实现的界面上下文，把通知、确认、选择、输入转给界面；
  其余能力按 pi RPC 模式的范围不实现。MCP 的错误原文就是从通知里来的。
- **Shell**：不传 `shellPath`，靠 pi 自己的查找顺序（先找 Program Files 下的 Git Bash）。
  Git Bash 装在别处时，把 `shellPath` 写进 pi 的 `settings.json`；
  没有 bash 时写 `defaultTools: ["-bash", "+powershell"]`。
- **模型**（2026-10-21 起按 [specs/model-providers.md](specs/model-providers.md) §4.4、§7、§11：Mori 的模型配置编译到 pi；探针和模型池经 pi-ai 的 fetch 选项发请求）：保存 `models.json` 后调用 `modelRegistry.refresh()`，用 `getError()` 显示配置错误；
  "Test connection"用 `modelRegistry.streamSimple` 发一条短消息，测到第一个文字增量的时间。不自己发 HTTP 请求。
- **启停**：列表来自 `DefaultPackageManager.resolve()`（每项带启用状态和来源）。
  写入逻辑在 pi 未导出的 `config-selector.ts` 里，v0 照搬其中用户级启停的两个函数，注明出处，
  并用 fixture 对比 `pi config` 的写入结果。
- **打包**：pi 运行时按自身包目录解析资源（`package.json`、wasm、worker、扩展加载器），不能进 Vite bundle；
  标为 external，随 `node_modules` 发布。

**最小批准扩展**

- 用 inline extension 注册 `tool_call` 处理器，在闭包里 await 界面的答复；拒绝时返回 `{ block: true, reason }`，
  reason 会作为工具结果回给模型。处理器出错时 pi 按拦截处理。
- 每个待批准请求都绑定 `ctx.signal`，一旦中止就按拒绝处理，否则停止会卡住。
- 注意顺序：pi 先发 `tool_execution_start`，然后才调用处理器，所以"Running…"要以批准结果为准（见 5.5）。
- "Allow “<工具>” for this session"只是一个按工具名记录的集合，存在内存里，不做其他规则。

## 7. 里程碑

每个里程碑签收后才开始下一个。"先确认"一列是实现者动手前的技术检查，不属于你的走查；
"走查"一列是你在 App 里要看到、做到的事。

| 里程碑 | 交付 | 先确认 | 走查（含反例） |
| --- | --- | --- | --- |
| M0 壳与安装包 | Electron + pi + 进程桥 + 离线安装包；一个临时的最简对话窗口（M1 替换） | ESM 入口能否在 utilityProcess 运行；asar 是否需要解包；同一进程能否同时跑两个 pi 会话，不行就每个活动会话一个后台进程；pi 在目标机器上找到哪个 shell | 1. 在外网机器构建安装包，拿到内网机器离线安装并启动<br>2. 填入真实端点，"Test connection"成功<br>3. 让它"总结 README"：看到流式文字和一次读取<br>4. 打开 Windows 资源监视器的"网络"页并勾选 Mori 的进程，从启动到完成一次对话，只出现配置端点的地址<br><br>端点不支持工具调用时，先停下来商量 |
| M1 对话 | 移植 demo 布局与视觉；首次启动连接表单；打开文件夹；对话流、工具卡、阶段行；停止、排队、插话；错误与后台进程退出提示 | pi 的插话是否会跳过本轮剩余的工具调用（决定工具卡是否需要"已跳过"） | 1. 首次启动 → 填连接 → 测试成功 → 选文件夹 → 发第一条消息<br>2. 先看到"Waiting for the model… Ns"，再看到流式 Markdown；有思考内容时显示"Thinking…"，正文开始后思考折叠<br>3. 工具卡从"Running…"变为"Done"，可以展开参数和输出；上下文用量随对话增长<br>4. 生成中排队一条、插话一条：两条先出现在排队区；插话那条在本轮工具执行完后进入对话流，排队那条在本轮结束后进入<br>5. 运行一个耗时命令时按 Esc：命令卡显示"Stopped"，提示"Stopped · Changes made so far stay as they are"，排队消息回到输入框<br>6. key 填错：看到错误原文和"Go to settings"；key 写成一个没设置的 `$变量`：看到找不到 key 的错误和"Go to settings"<br>7. 在任务管理器里结束 Mori 的后台进程：看到退出提示和"Restart"，输入框里的草稿还在<br>8. 把上下文长度临时设成 8k 并长聊：看到"Compacting session…"，对话流留下"Compacted session"<br>9. 拖动左右分隔线、双击恢复，重启后宽度还在；窗口拉到 800 宽时没有内容被裁掉；没有小于 12px 的文字<br>10. 用拼音输入时按 Enter 选词，不会发送<br><br>反例：失败的命令不显示"Done"；没有事件时阶段行不显示"Responding…" |
| M2 批准与 F8 | 最小批准扩展与批准卡；权限菜单；任务栏闪烁；F8 报告界面问题 | — | 1. 让它改一个文件：批准卡显示每处替换的原文和新文；允许后工具卡执行并完成，展开能看到实际 diff<br>2. 拒绝并写理由：工具卡显示"Denied · <理由>"，模型的下一条回复出现在它之后<br>3. 在输入框打字时出现批准卡：继续打字、按 Enter 都不会批准；Alt+1 允许<br>4. 选"Allow “Run commands” for this session"：之后的命令不出卡，标"Allowed for this session"；权限菜单里能看到并清除（"Forget"）；新会话重新询问<br>5. 切到"Allow all"先弹确认；之后改文件不出卡；切回后又出卡<br>6. 有批准卡时按 Esc：按拒绝处理，并停止生成<br>7. 切到别的窗口等批准：任务栏闪烁<br>8. 按 F8 写一条：生成带截图的 Markdown 文件，点"Show in Explorer"能看到<br><br>反例：等批准时阶段行显示"Waiting for your approval"，不显示"Responding…"或"Running…"；读取文件不出卡 |
| M3 项目与会话 | 侧栏项目→会话树；新建、改名、归档、删除、恢复；右键菜单；项目信任弹窗；状态点；按会话保存草稿；扩展的询问（从 M6 提前）；界面重新加载后接上后台进程里的会话（2026-10-19 加） | — | 1. 打开两个文件夹，各建两个会话并各发一条消息：侧栏按项目分组，会话名取第一条消息的前 20 个字<br>2. 只用键盘：Ctrl+N 新建，Shift+F10 打开右键菜单改名<br>3. 改名后重启 App：名字和完整对话都在<br>4. 归档一个会话：侧栏移到"Archived"，可以恢复；删除一个会话：确认后永久删除，重启后不再出现；正在生成的会话不能归档或删除（2026-10-19 改）<br>5. 打开带 `.pi/extensions` 的仓库：先弹信任询问；选"Don’t trust"后该扩展注册的工具不出现；勾"Remember my choice"后重启不再询问<br>6. 在 A 写半句话，切到 B 再回 A，草稿还在；重启后也在<br>7. 不可见的会话生成完成时，侧栏显示"Unread"，点开后消失<br><br>反例：打开带 `.pi/extensions` 的仓库，任何情况下都不会不经询问就加载扩展 |
| M4 改动与选区 | 右栏改动列表与 diff；只读文件阅读器；选区"Attach as context"（问 Mori）与"Feedback"；回复下的"Copy"、"Attach message as context"、"Give feedback" | — | 1. 让它改两个文件：右栏列出两个文件，点开按时间显示每次编辑的 diff，顶部注明命令改动不在此列<br>2. 点工具卡里的文件路径打开阅读器；删掉这个文件再点，显示"File not found"<br>3. 在阅读器里选一段点"Attach as context"：输入框出现带来源的芯片；发送后点芯片回到原位置；重启后仍能点回<br>4. 流式输出时选中一句话点"Feedback"：选区不被打断；提交后提示"Saved · View in Review"（2026-10-22 改：只提示"Saved"，见 [specs/memory.md](specs/memory.md) §10.7），当前会话没有新消息<br>5. 不用鼠标选字，用回复下的"Attach message as context"完成同样的引用<br><br>反例：原文已变化时，芯片保留当时的原文并提示"Source changed" |
| M5 分屏与会话引用 | 左右分屏；拖会话引用；右键菜单的"Open in split view"和"Attach as context" | — | 1. 把会话 B 拖到 A 的右侧：放下前出现"Drop to open in split view on the right"；两边各自发消息、各自批准<br>2. 在左栏按 Esc 只停止左栏；F8 和右栏跟随焦点所在的一栏<br>3. 拖动分屏中线调整比例<br>4. 把会话 C 拖进输入框：预览按"Turn N"标出内容和总字数；改成第 3–5 轮后发送<br>5. 点消息里的引用跳回 C；C 改名后仍有效；C 删除后芯片显示"Session deleted"，原文仍可查看<br>6. 用右键菜单完成同样的分屏和引用<br><br>反例：关闭分屏不停止正在生成的会话；预览里没有按钮文字等界面文字 |
| M6 设置与工具页 | 多个模型与切换；思考强度（Effort）；用户级 AGENTS.md；工具页（Customize：内置工具、Skill、MCP、Plugin）；输入框 "/" 补全 | pi 如何在 prompt 中展开 "/名称"；MCP 扩展的通知在 SDK 下能否拿到 | 1. 加第二个模型，在顶栏切换（2026-10-21 改到输入框下方一行，v1 起是选择范围菜单），新回复来自新模型<br>2. 在用户级 AGENTS.md 写"每次回答以'收到'开头"：新会话的第一条回复符合；设置页标出生效的文件<br>3. 在已信任项目的 `.pi/skills` 放一个技能：工具页出现并标"Project"；停用后 `settings.json` 出现与 `pi config` 相同的条目，新会话问"你能用哪些技能"时没有它<br>4. 用表单添加一个 stdio MCP 服务：保存后看到它注册的工具名；调用它的工具会出批准卡<br>5. MCP 服务的命令写错：看到 pi 给出的错误原文<br>6. 添加一个本地文件夹的 pi 包：列出包内资源，可以按资源启停<br>7. 输入 "/"：列出提示词模板和技能命令<br>8. 把模型标为"Supports thinking"，顶栏切到"High"（2026-10-21 改到输入框下方一行的 Effort 按钮）：回复带思考内容；切到"Off"：不再有思考内容<br><br>反例：模型没标"Supports thinking"时，思考强度不可选；项目未信任时项目技能不出现；没有注册任何工具的 MCP 服务不显示"Connected" |
| M7 工作回顾（Review） | 反馈收件箱（Feedback）、界面问题收件箱（UI issues）、"Resolved"、导出；一键导出安装包（2026-10-21 加）（2026-10-22 改：工作回顾由记忆页替换，走查 1–4 不再做，见 [specs/memory.md](specs/memory.md) §10、§14.4） | — | 1. M4 起写的反馈都在，点开跳回原位置<br>2. M2 起的 F8 报告都在"UI issues"里，带截图<br>3. 点"Resolve"标为已处理后，可以用"Hide resolved"筛掉<br>4. 两类都能导出为 Markdown（"Export as Markdown…"）<br>5. 双击 `build-installer.cmd`：结束时打开 `release\`，里面是安装包；任何一步失败时停下并说明哪一步 |

界面改为英文之后（第 11 节"显示语言"，不兼容旧的中文记录），M4 走查 3、M5 走查 5、M7 走查 1–2 要用英文构建新建的会话、
引用和 F8 报告来做：M2–M7 的构建存下的 F8 报告在工作回顾里列为读不出来的记录，旧消息里的中文引用块按全文显示、没有芯片
（[english-ui-checks.md](v0/english-ui-checks.md)"未验证"）。

M1 签收后就可以用它做日常工作；M2 起用 F8 记录界面问题，每个里程碑签收时，这些问题直接进入下一步的工作单。

## 8. 工作约定

v0 全部由 Claude 实现，你按界面走查签收。约定写进仓库根目录的 `AGENTS.md`，以后换任何模型来实现都适用。

1. **规格只写"必须看到"**：每屏一张状态表（状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作），实现该屏前写好。
2. **完成顺序**：写状态表 → 从真实会话录 fixture → 界面测试 → 实现 → 用真实模型走一遍 → 你走查。缺一步不算完成。
   录 fixture 和真实模型走查只在模型看到的或做的有变化时做；只改界面布局、文字或样式时可以跳过，在检查记录里写明
   （2026-10-23 定，测试怎样分层见 AGENTS.md"测试分层"）。
3. **每一步都可以走查**：一步只做一屏的状态或一族事件，每步都有你能在 App 里看到的变化。
4. **不造后端**：pi 有的能力直接用；pi 没有的，先回到第 4 节确认是否在 v0 范围内，不在就不写。
   每加一段非界面代码，都要能指向第 6 节"后台进程只做八件事"或第 4 节表中标 Mori 的行。
5. **CI 把关**：`src/` 中出现"示例/演示/mock"即失败，界面字串里出现中文也失败（2026-10-21 加）；界面测试回放的事件必须来自真实录制，手写的要标明。
6. **诚实交付**：交付说明列出未验证的项；遇到阻塞就停下来报告并给出选项，不写假实现，不静默换路线。
   临时默认值（2 万字、兼容选项说明、401 文字匹配等）登记在 `docs/v0/defaults.md`。
7. **边界**：只有 `src/kernel/` 可以 import pi；pi 和其他新依赖都锁版本，并确认可以离线使用。

## 9. 与原 proposal 的关系

**本轮暂停或修改的规则**：

- 暂停 proposal.md:44 和 :66 的"不接入外部 Agent 运行时 / 不叠加 Pi"，以及 :504 的"不增加临时运行时"：
  v0 以 pi 为后端。
- 推翻 :198 和 :534 的"无差异视图"。
- 修改 :553：允许使用默认值，但要标"临时默认值"并登记。
- 废止 :244、:270–272、:281 等 demo 示例条款。工具页、设置和工作回顾保留界面形态，但必须接 pi 的真实数据。
- 多 agent、通信、协作、Chrome、模型池五份子 proposal，以及工作回顾的定时与反证流程，本轮都不实现。（多 agent、通信、协作三份已被平行 Agent 与 TaskBoard Proposal 第四版取代，2026-10-21 起按其规格实现）
  （2026-10-22 改：工作回顾的定时与反证流程由[提示词分层与记忆 Proposal](proposals/prompt-and-memory.md) 的增强任务替代，用依据核对、修订记录与回滚代替反证，见 [specs/memory.md](specs/memory.md) §9。）
- 2026-10-19 的两份重设计草案（平行 Agent 与 TaskBoard、统一模型提供商）不在 v0 范围，v0 稳定后再对照。
  2026-10-21：统一模型提供商 proposal 第四版的普通模式部分开始实现（[specs/model-providers.md](specs/model-providers.md)），它取代模型池子 proposal 中“不自动切换”的规则。同日平行 Agent 与 TaskBoard 第四版开始按 [specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md) 实现。

**保留的规则**：

- :563 和 :567–570 的工程约束。
- :497–499：实测工具调用、不静默切换资源、须实际运行验证。
- 离线分发要求。
- "已取消不等于已撤销"；选区锚点。

`demo/` 冻结，作为视觉与交互参考，不再继续开发。

## 10. 风险与对策

1. **又变成"只是能跑"**：按第 8 节交付，每个里程碑都要在 App 里走查，验收项带反例。
2. **又长出后端**：按第 8 节第 4 条检查；指不到第 4、6 节的非界面代码，先停下来问。
3. **多个会话能否并存在一个后台进程里**：pi 没有说明，M0 先确认；不行就每个活动会话一个后台进程，
   每个进程仍是原样的 pi。
4. **内网模型工具调用能力差**：M0 的真实对话就是放行门。
5. **公司机器上打包或运行失败**（ESM、asar、未签名、Smart App Control）：M0 第一天验证；
   退路是同一入口改用 `ELECTRON_RUN_AS_NODE` 子进程。
6. **pi 每周多次发布，有已知问题**：锁定版本，只在 `src/kernel/` 里使用 pi。
   已知问题包括 #9361（加载扩展时 shellPath 可能被忽略）和 #9129（命令超时留下孤儿进程），M0 时检查。

## 11. 决定与待确认的问题

**已决定（2026-10-19）**

- 后端：pi 原样作为后端，Mori 只做界面、安装包、进程桥和最小批准扩展。
- API key：由 Mori 用系统加密保存，经 pi 的 runtime API key 只在内存里交给 pi；不写进 `models.json`，不用环境变量。
- 思考强度：要，在 M6 的设置页和顶栏提供（2026-10-21 起在输入框下面一行）。
- 批准：允许一次 / 本会话不再询问此工具 / 拒绝（"Allow once" / "Allow “<工具>” for this session" / "Deny"），不做规则引擎。
- 使用环境：在有外网的机器上构建，在公司内网机器上离线安装。
- 任务记录：暂不做。（2026-10-21：由协作模式的 TaskBoard 取代）
- 会话的保持打开、归档与删除、界面重新加载、重新打开时的工具、扩展的询问都照 Claude 桌面版的做法（M3 时决定；扩展的询问从 M6 提前到 M3）。
- 交互细节不清楚时照 Claude 桌面版（2026-10-20）。M4：阅读器只用鼠标选字、带语法高亮；文件引用的"Source changed"按原文找不找得到判断，
  只在点芯片时检查；选区浮层只在助手回复和阅读器里出现；回复下的操作每轮一行。
- demo 交互：分屏、拖会话引用、工具页、工作回顾页都进 v0，接 pi 的真实数据。
- 工作回顾（M7，2026-10-21）：三级结构（左栏入口 → 中栏列表和摘要 → 右栏详情）；已处理（"Resolved"）是你自己打的勾，用"Hide resolved"开关筛掉，
  标记记在本机界面状态里；界面问题的数据都在 `<userData>\ui-issues\` 一个文件夹里，交给别人时打成 zip，或导出一个只链接原截图的 `.md`。
- 一键导出安装包（2026-10-21 加进 M7）：仓库根目录的 `build-installer.cmd`，双击后装依赖、检查、构建 NSIS 安装包，复制到 `release\` 并打开文件夹。
- 显示语言（2026-10-21）：Mori 代码显示和写出的文字（界面、对话框、F8 报告、导出、Mori 加进消息里的引用标题等）全部改为英文；
  模型生成的内容随你的用法。文档正文仍用中文，引用的界面文字改成英文；代码注释仍用中文。工作量大（M0–M7 的全部界面文字、测试和
  含 Mori 文字的 fixture），你同意另开任务、在 M7 之后做。
  M7 之后在 `english-ui` 分支上改：`app/src` 里的界面文字、读屏名、悬停提示、对话框、F8 报告、工作回顾的导出、
  操作记录、引用块和会话引用都改成英文，逐条的术语、写法和 Mori 写出的固定格式见 [v0/ui-strings.md](v0/ui-strings.md)；
  `npm run check` 在 `src/` 的字符串、正则、JSX 文本和 .html / .css 里发现中文就失败（注释不查）；
  NSIS 安装包只带英文界面，`build-installer.cmd` 只输出英文；顶栏、侧栏等按英文字宽重新定了窄栏的宽度阈值（顶栏的几档 2026-10-21 随按钮移到输入框下面一行重新定，见下一条）。
  你在 2026-10-20 / 21 定的用词：
  - 有 Claude 桌面版对应的地方照 Claude 英文界面的用词（"我最常用 Claude，想保持同样的说法"）；没有对应的按 ui-strings.md 的写法自己写。
  - 轮 = turn（"Turn 3"、"turns 3–4"）；插话 = Steer（排队用 Claude 的 Queue）。
  - 工作回顾页 = Review；工具页 = Customize（Claude 开关技能、插件、连接器的页面叫这个）。
  - 引用这一族（选区的"问 Mori"、会话菜单的"引用到当前会话"、回复下的"引用到输入框"、把会话拖进输入框）在界面上都用
    Claude 的说法"Attach as context"（回复下是"Attach message as context"），芯片和预览写"Context · …"；
    发给模型的文字仍让模型看得懂："Quoting …:"，会话引用里是"Turn N"、"User:"、"Assistant:"、"[Tool] …"、"[Quote] …"。
  - 思考强度 = Effort，档位 Off / Minimal / Low / Medium / High / Extra high / Max（minimal 没有 Claude 对应，用 pi 的名字）。
  - 不兼容旧的中文记录：以前存下的中文 F8 报告在工作回顾里是读不出来的记录（"Couldn’t read the record <文件名>"），
    旧消息里的中文引用块不再拆成芯片，按原文显示。
- 模型层（2026-10-21）：按统一模型提供商 proposal 第四版和构建规格（[specs/model-providers.md](specs/model-providers.md)）实现普通模式的模型层；
  界面文字是英文，与 `english-ui` 合并后按 [v0/ui-strings.md](v0/ui-strings.md) 的术语表统一（例如思考强度写 Effort、"Model ID"、"Base URL"）。
- 平行 Agent 与 TaskBoard（2026-10-21）：按 proposal 第四版和构建规格（[specs/parallel-agents-taskboard.md](specs/parallel-agents-taskboard.md)）实现；新写的界面用英文，按 [v0/ui-strings.md](v0/ui-strings.md) 的术语表。负责人不在时定下的选择列在 [v1/team-checks.md](v1/team-checks.md)。
- 输入框下面一行（2026-10-21，照 Claude 桌面版）：会话面板顶栏上的模型、思考强度（Effort）、权限三个按钮移到输入框里、
  文字框下面那一行（Claude 的 prompt box 下面一行：左边模式选择，靠右是模型，用量圆环在旁边）。Effort 仍是单独一个按钮
  （你的选择；Claude 的文档把 effort 放在模型菜单里）。右边的顺序：模型、Effort、圆环，然后是发送（你定的，同装在本机的
  Claude）。上下文用量改成小圆环，
  悬停说明、读屏名和点开的详情里有原来"Context 12%"和"About 15,360 / 128,000 tokens"的信息（用 Claude 的写法，估算的数前面加"≈"，
  见 [v0/screens/models.md](v0/screens/models.md)）。权限按钮照 Claude 的模式选择只有文字、任何宽度都没有盾牌图标，
  窄时模式名截断加"…"（全名在悬停说明和读屏名里），即使模型按钮因此更挤；"Allow all"保留警示色和文字。
  顶栏只留会话名（"项目名 › 会话名"）和这一栏的按钮（TaskBoard 的协作开关、"Toggle changes"、分屏时"Close pane"；协作开关
  ≤ 600px 时只有状态点，2026-10-22 合入时定），让分屏时的会话名有地方显示
  （原来 460px 的一栏里只剩约 2 个字母）。设计说明见 [v0/composer-pickers.md](v0/composer-pickers.md)；不加后台进程命令，事件和命令不变，所以有意不重录 fixture。
  合并 v1 之后搬进这一行的是选择范围按钮（"<范围名> · <当前模型 id>"），截短时先截模型 id；上限 200px
  （2026-10-21 合并时改，原来 160 / 120px）；其余按推荐定的见 composer-pickers.md"v1 之后的调整"。
- 提示词分层与记忆（2026-10-22）：按 [proposal 第一版](proposals/prompt-and-memory.md)和构建规格（[specs/memory.md](specs/memory.md)）实现，proposal §14 的四步一起交付；
  临时默认值登记在 [v1/defaults.md](v1/defaults.md)，检查记录在 [v1/memory-checks.md](v1/memory-checks.md)。
  - proposal 的决定（§15；§16 的默认做法一并采用）：system prompt 分身份与 harness、AGENT（就是 AGENTS.md，留在仓库）、记忆三块；
    记忆是事实、TASTE、STRATEGY、REVIEW 四种条目，一行 abstract 链一份 detail，按席位分发，每种用户级与本项目合计 500 token，超了拒绝、不截断；
    事实由主 Agent、立项 Agent 用 memory 工具记，subagent 不写；增强任务每天固定时刻跑（默认 04:00，没开 Mori 时下次启动补跑），
    是看不见的会话，只读当天结束的会话，直接改本项目“它学的”条目、每次一条修订记录、可以回滚，用依据核对代替反证；
    它的工具不限、命令和 MCP 自动执行，只限能写的文件；记忆存在本机，不进仓库；记忆页替换工作回顾（M7 的工作回顾不再走查），
    反馈作为增强的依据，F8 界面问题挪到设置页。
  - 写规格时定的（规格 §0）：增强任务打开协作模式时由立项 Agent 和 task 实例拿 memory 工具，关闭时是主 Agent；
    身份段总是用 Mori 的，项目或用户级有 `SYSTEM.md` 也不用；每天的时刻（也是日界）每个项目一份，放在增强设置里；
    这台机器没有带 key 的数据目录，回放的 fixture 从真实的 App 对合成端点录制（标 synthetic），真实模型套件写好、标为未运行。
- 测试分层（2026-10-23）：你问"挪一个按钮为什么要把界面测试全跑一遍"，同意按改动范围分层跑：每次改动只跑检查、构建、单元测试
  和相关套件；推送 `app-v0` 前在开发构建上跑一次完整回归；打包程序只做冒烟（改了打包配置、主进程或 preload 时加跑相关套件）；
  录 fixture 和真实模型走查只在模型看到的或做的变了时做。写进 AGENTS.md"测试分层"，第 8 节第 2 条按它执行。
- 测试分层改（2026-10-26）：你说每个任务都跑整套界面测试、不停弹出 Mori 窗口，改为每个任务只跑不开窗口的最小集
  （`npm run test:min`：检查、构建、四组单元测试，2 分钟内跑完）；界面套件、冒烟和覆盖检查只在你要求推送到远端时作为完整测试跑。
  写进 AGENTS.md"测试分层"。
- 实现者：全部由 Claude 实现，你按界面走查签收。

**待确认**（括号里是默认推荐，没有异议就按默认执行）

1. **第一个端点**：用哪个模型？原生工具调用和流式能用吗？
   开发期能否先用协议相同的公网端点？（默认：能；内网端点在 M0 验证。）
2. **公司机器**：是否允许运行未签名的 exe？是否装了 Git Bash？（默认：允许；没有 Git Bash 就用 PowerShell。）
3. **配置目录**：用 Mori 独立的 `%APPDATA%/Mori/pi`，还是和 pi 命令行共用 `~/.pi/agent`？（默认：独立。）
4. **第 9 节的规则暂停或修改**是否同意？（默认：同意。）
5. **使用者**：只有你自己用，还是也会给同事？（默认：只有你。）
