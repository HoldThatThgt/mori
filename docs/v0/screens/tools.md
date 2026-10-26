# 工具页（Customize，M6）

依据：方案 5.13、第 4 节（Skill、MCP、Plugin 三行）、第 6 节"MCP""启停"；pi 行为见 [../m6-checks.md](../m6-checks.md)。

## 外框

| 项 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 入口 | — | 左栏"Open folder…"下面的"Customize"（收起为图标栏时是图标按钮）；工具页打开时高亮 | 打开工具页 |
| 顶部 | — | "Back to app"；标题"Customize"；跟随的会话："<项目名> · <会话名>"，或"No open session. Only user-level skills and plugins are listed."（2026-10-26 改："No open session. Only user-level skills, plugins, and instructions are listed."） | Back to app（恢复分屏、滚动位置、草稿，与设置页相同） |
| 分节 | — | 照 Claude 桌面版的设置页：左边分节列表（读屏名称"Customize page sections"）"Built-in tools""Skills""MCP""Plugins"，右边内容；没有打开的会话时"Built-in tools""MCP"不出现（2026-10-26 改：负责人走查 M4，最后一节是"Instructions"（用户级 AGENTS.md，从设置页挪来；负责人定名与位置），没有会话时也在；从侧栏进入仍落在第一节，从记忆页的 Edit in Customize 进入落在它；状态表见 [../../v1/screens/customize-agents-md.md](../../v1/screens/customize-agents-md.md)） | 切换分节 |
| 改动何时生效 | pi 只在会话创建时读这些配置（m6-checks.md） | 页面顶部一行"Changes apply to new sessions. Sessions already open aren’t affected."和"New session"按钮（在跟随的项目里新建，等于 Ctrl+N） | New session |
| 读取中 / 读取失败 | `tools.get` | "Loading…" / 原文和"Retry"（2026-10-26：只在内置工具、技能、MCP、插件四节；Instructions 一节不等它，读取失败时照常可用） | Retry |
| 离开与换分节（2026-10-26 加） | Instructions 一节有未保存的改动 | 换分节（点、↑ ↓）、离开工具页都先出 AGENTS.md 的离开确认框（同 customize-agents-md.md）；点当前分节、已经在工具页时点左栏"Customize"什么都不变 | Discard；Keep editing |

**跟随哪个会话**：当前会话（分屏时焦点所在的那一栏），即打开工具页之前中栏的那个会话；会话还在打开中时等它打开（2026-10-26 加：Instructions 一节不等，先列出用户级，项目的文件等它打开好再读）。工具页开着时在侧栏归档或删除了它，跟到剩下的那一栏；没有剩下的就当作没有打开的会话
（顶部"No open session. Only user-level skills and plugins are listed."，2026-10-26 改为"No open session. Only user-level skills, plugins, and instructions are listed."）。工具页打开期间侧栏点别的会话会回到会话页（同设置页）。
读取用 `tools.get`（带这个会话的 sessionId），每次进入工具页、
每次启停或添加之后重新读取；不监视文件。

**项目信任**：跟随的会话所在文件夹没有被信任（或没有回答）时，项目里的技能、扩展、插件和 `.pi/mcp.json` 都不列出，
顶部说明"This workspace isn’t trusted, so its skills and settings aren’t listed"（与会话横幅一致）。会话打开时文件夹没有要信任的内容、之后才出现的，
工具页每次读取照新会话重新判断：`trust.json` 没有记录时按没有回答处理（不列出、显示上面的说明）。

## 内置工具（只在有会话时）

2026-10-26 改（负责人走查 M12"why so many not-enabled tools? why can't I enable them?"，回答 3）：pi 的 8 个内置工具各有一个开关，
存为 pi 设置的 `defaultTools`，对新会话生效；其余的行没有开关，下面一行写为什么。检查记录
[../../v1/walkthrough-1026/WP-08.md](../../v1/walkthrough-1026/WP-08.md)。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `tools`：pi `session.getAllTools()`，不含 `hidden`；`active` 来自 `getActiveToolNames()` | 每个工具一行：名字、来源（"Built-in" / "Extension <路径>" / "MCP · <服务>" / "Plugin <包>" / "Mori"；Mori 批准扩展不注册工具）、状态（"Enabled"，或"Not enabled"：注册了但没有给这个会话的模型）、说明的第一行；pi 的内置工具行右边一个开关，其余的行下面一行原因（见下面两行）。pi 总是注册全部 8 个内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`powershell`），默认只启用前 4 个。Mori 的 TaskBoard 工具（docs/specs/parallel-agents-taskboard.md §6.3）：项目有别的角色、或用过 Task mode 的会话另列出 `mori-team` 给用户会话注册的那一组，来源 `Mori`：对话与立项合并（只有基座，或一个角色持有两项）时 9 个（`board_read`、`read_session`、`agent_message`、`request_submit`、`request_update`、`request_cancel`、`task_create`、`task_edit`、`reply_via_dialog`），分开时 3 个（`board_read`、`read_session`、`agent_message`）；`task_handoff`、`request_close` 只在实例会话里，不在这里列出（2026-10-26 改：原来写 11 个，与代码和 TB-03 不符）。它们默认不启用，按模式启用（§5.2、§5.5）；没有角色、没用过 Task mode 的会话不列出。"Enabled"是这个会话上一轮运行时的样子：开关 Task mode 之后要到下一条消息开始才变（team.ts `beforeUserRun`） | 展开看完整说明 |
| 说明 | — | 标题下一行"All tools in this session. Only enabled tools are available to the model. Switches apply to new sessions." | — |
| pi 内置工具的开关 | `tools.get` 的 `tools[].byDefault`：用户级 `<agentDir>\settings.json` 里的 `defaultTools`（文件里的值，`getGlobalSettings()`；不含 Mori 只放在内存里的设置，例如没有 bash 时的 `-bash`、`+powershell`，方案第 6 节"Shell"）按 pi 的规则算出的新会话默认工具；没写 `defaultTools` 时是 `read`、`bash`、`edit`、`write` | 开关（`role="switch"`，读屏名称"Enable tool <名字>"）开着 = 新会话默认把它给模型；与同一行的"Enabled / Not enabled"（这个会话）是两回事 | 开、关 |
| 按了开关 | `tools.setDefault { sessionId, name, enabled }`：后台进程在 pi 自己的文件锁里读改写 `settings.json`，只改 `defaultTools`，其他字段原样保留；写成 pi 的 `+名字` / `-名字`（相对 pi 的默认 `read`、`bash`、`edit`、`write`，先 `-` 后 `+`，例如 `["+ls"]`、`["-bash", "+powershell"]`），与默认相同时去掉这一项 | 开关立刻变过去，写完重新读取；这一行的"Enabled / Not enabled"不变（开着的会话不变，页面顶部"Changes apply to new sessions. Sessions already open aren’t affected."）；之后新建的会话（含重启后重新打开的会话）里它是"Enabled"，发给模型的工具与 system prompt 的工具清单、规则随之变 | 再按 |
| 写入中（2026-10-26 补） | `tools.setDefault` 和之后的重新读取还没结束（`useChange` 的 busy，同技能） | 这一行的开关显示按下后的样子、不可用（不能连按）；读完后照常可用 | — |
| 写入失败 | 命令报错：`settings.json` 不是 JSON 或不是对象（原文带文件路径）、拿不到文件锁 | 这一行下面"Couldn’t save: "+ 原文；开关回到原来的样子；文件不变 | 改好文件后再按 |
| 本项目的设置改了它 | 受信任项目的 `.pi\settings.json` 也写了 `defaultTools`（pi 把 `+` / `-` 的写法接在用户级后面，普通工具名的写法整个代替），合并后这个工具与只按用户级时不同 | 开关显示合并后的样子、不可用，下面一行"Turned on in this project’s .pi/settings.json. To change it, edit that file."（关掉时"Turned off in …"，同技能）；合并后没变的工具照常可以开关 | — |
| 本项目的设置改了它：悬停（2026-10-26 补） | 同上一行（`byDefault.readOnly`） | 不可用的开关悬停提示与下面一行同一句（"Turned on in this project’s .pi/settings.json. To change it, edit that file." / "Turned off in …"，同技能的开关）；可以开关的开关没有悬停提示 | — |
| 操作记录（2026-10-26 补） | `tools.setDefault`（[f8.md](f8.md)"Recent activity"记发给后台进程的命令） | F8 报告的"Recent activity"每按一次开关记一条"Enable tool <名字>"或"Disable tool <名字>"（[../ui-strings.md](../ui-strings.md)"操作记录"，同"Enable skill <名字>"） | — |
| `grep`、`find` | — | 下面一行"Needs rg.exe in <agentDir>\bin or on PATH. Mori doesn’t download it."（`find` 是 fd.exe）。不检查有没有：Mori 让 pi 离线运行（`PI_OFFLINE`），pi 不下载它们，没有时调用失败，工具卡写 pi 的原文"ripgrep (rg) is not available and could not be downloaded"或"fd is not available and could not be downloaded" | — |
| 不是 pi 内置工具的行 | 来源与工具名 | 没有开关，下面一行原因：TaskBoard 工具"Mori turns this on and off with Task mode."；`memory`"Mori turns this on for the main agent."（记忆规格 §7.6）；MCP 的工具"Turn its server on or off in MCP."；插件的工具"Turn it on or off in Plugins."；扩展文件的工具"Set by this extension. To change it, edit the extension file." | — |

开关还管这几件事（2026-10-26，WP-08）：

- **Task mode 的助手**：Task mode 的基座工具就是这里的默认工具（`sessions.ts` 把 `getDefaultTools()` 交给 Team 作 `baseTools`）。
  没写 `tools` 的角色文件用它们（`roleTools`）；只读的助手（立项、结案、临时提问、订阅、只读的 task，以及 Task mode 下的对话）
  用其中的读取类（`readClassTools`：与 `read`、`grep`、`find`、`ls` 的交集，再加上 `ls`），所以打开 `grep`、`find` 也给了它们。
  轮次记录定的"只读助手总有 `ls`"（WP-10）：`ls` 不论开关都在读取类里，`ls` 的开关只影响别的会话。
- **批准**：`grep`、`find`、`ls` 是只读工具，不出批准卡（方案 5.7）；`powershell` 同 `bash` 要批准。
- **发给模型的文字**：每个启用的工具在 system prompt 的工具清单（`<tools>`）与规则（`<rules>`）里有 pi 给它的说明；
  打开 `grep`、`find`、`ls` 中任一个时，规则里不再有"Use bash for file operations like ls, rg, find"这一条
  （pi 1.3.0 `system-prompt.js`，记忆规格的 `memoryText.ts` 照写）。
- **没有 bash 时**：Mori 只在内存里放 `-bash`、`+powershell`（方案第 6 节"Shell"），接在文件里的 `defaultTools` 后面；
  开关读写的是文件里的值，所以那时 `bash` 的开关开着、新会话里它仍是"Not enabled"。

## 技能

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `skills`：pi `DefaultPackageManager.resolve()` 的全部技能（含已停用的），名字和用途取 pi 导出的 `loadSkills` | 每个技能一行：名字、来源（"User" / "Project" / "Plugin <包>"）、用途（description）、开关（启用 / 停用，读屏名称"Enable skill <名字>"） | 启停；展开看正文 |
| 展开 | 你点了技能 | SKILL.md 的正文（去掉开头的 frontmatter）和文件路径 | 收起；Open in default app |
| 停用 | 你关了开关：`resource.toggle`，写法照 `pi config`（照搬它的 `toggleTopLevelResource` / `togglePackageResource`）：用户级的写 `<agentDir>/settings.json` 的 `skills`（例如 `"-skills\\review\\SKILL.md"`），本项目的写项目的 `.pi/settings.json`（与 `pi config -l` 相同），插件里的写 `packages` 那一项的 `skills` | 开关关上、行变淡；页面顶部的"Changes apply to new sessions. Sessions already open aren’t affected." | 再打开 |
| 写入失败 | `resource.toggle` 报错，或 pi 设置的 `drainErrors()` | 这一行下面"Couldn’t save: "+ 原文；开关回到原来的样子 | 再试 |
| 本项目的设置改了它 | 用户级技能在"只看用户设置"和"加上项目设置"两次 `resolve()` 里启用状态不同 | 开关不可用，说明"Turned off in this project’s .pi/settings.json. To change it, edit that file."（项目启用了它时"Turned on in …"） | — |
| 有问题 | `loadSkills` 的 diagnostics（例如缺 description、同名冲突） | 列表下方警示色列出原文 | — |
| 没有技能 | 结果为空 | "No skills yet. Put a skill folder (with a SKILL.md) in <agentDir>\skills or in the project’s .pi\skills, or add a plugin." | — |

反例：项目没有被信任时，项目里的技能不出现；停用的技能，新会话问"你能用哪些技能"时没有它，`/` 补全里也没有。

## MCP（只在有会话时）

服务来自 `<agentDir>/mcp.json`（用户级）和项目的 `.pi/mcp.json`（项目信任后）；工具名来自跟随的会话的 `getAllTools()`；
进程状态来自后台进程的共享服务表。

**共享连接**（[../m6-mcp-shared.md](../m6-mcp-shared.md)，照 Claude 桌面版）：每个服务一个进程（HTTP 服务一个连接），所有会话共用。
用户级的服务整个 Mori 一份、在你的用户目录里运行，启用的 stdio 服务在 Mori 启动时就起、一直开到退出 Mori，
HTTP 服务第一次有会话用时才连、最后一个会话关闭后断开；
项目 `.pi/mcp.json` 里的服务按项目文件夹共用、在项目文件夹里运行，这个项目最后一个用它的会话关闭后关掉；扩展用 `pi.registerMcpServer()` 注册的服务不共用（不在这一节里）。
配置改了、删了或停用了的服务，没有会话用它之后才关掉。进程状态是读取那一刻的，不自动刷新（不轮询），每次读取时更新。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `mcp.servers` | 每个服务一行：名字、来源（"User" / "Project"）、命令行（`command` 加 `args`）或地址、启用开关（读屏名称"Enable MCP server <名字>"）、调用方式（"Direct" / "codemode" / "Deferred" / "Hidden"）；pi 不会加载的条目也列出（见下一行），排在 pi 会加载的服务后面 | 启停（用户级）；Edit；Edit as JSON；Remove… |
| pi 不会加载 | `mcp.servers[].problem`：后台进程照 pi 1.3.0 读 `mcp.json` 的检查（照搬 `validateMcpServerConfig`：名字、字段类型、`url` 只能 http / https、不支持 SSE、oauth / auth 的写法；再加 `-` 和 `_` 算同名的冲突、项目里不能写 `auth`、项目覆盖没有被覆盖的服务或写了别的字段），原文同 pi | 这一行下面警示色"pi won’t load this server: <原文>"，例如"pi won’t load this server: server "x": args must be an array of strings"；开关关上、不可用；不显示调用方式、工具名和"Switch to direct calls"。本项目里同名的条目被跳过时，用户级的那个服务照常是另一行，编辑它时表单只接在用户级那一行下面 | Edit；Edit as JSON；Remove…（用户级的；条目不是对象时也能改写、移除） |
| 进程状态 | `tools.get` 的 `mcp.servers[].shared`：后台进程的共享服务表（[../m6-mcp-shared.md](../m6-mcp-shared.md)）里这个服务按现在的配置的那个共享连接（旧配置还在给旧会话用的进程不算）的状态、在用的会话数、失败原文 | 命令行下面一行："Running · Used by N sessions"（1 个时"Running · Used by 1 session"；没有会话在用时"Running · Not in use"）、"Starting…"、"Failed: <原文>"（警示色；`failed` 包括启动失败和运行后连接断了，原文说明是哪一种，如 `Connection closed`；只显示原文第一行；原文不止一行（stdio 时接上的 stderr 末尾）时下面有"Full error"可以展开）；`shared` 为 null（还没有这个服务的共享连接）时这一行不出现。这是共享服务表里的真实状态，不是"Connected"，也不凭工具列表推断 | — |
| 工具名 | 跟随的会话里 `sourceInfo.path` 为 `builtin:mcp`、`namespace.aliases` 里有这个服务名、不是 `hidden` 的工具 | "Tools in this session: mcp__x__echo, mcp__x__add"；一个都没有时"This server has no tools in this session"。**不显示"Connected"**：不凭工具列表猜连接状态，进程状态只来自共享服务表（上一行） | — |
| 出错 | 跟随的会话对话流里 pi 的 MCP 通知（以 `MCP ` 开头的扩展通知）里以 `<服务名>:` 开头的行（连接错误），和以 `config: ` 开头、含 `server "<服务名>"` 或 `invalid server name "<服务名>"` 的行（pi 读配置时跳过了它） | 这一行下面警示色显示原文，例如"broken: failed: MCP connection closed"、"config: C:\…\mcp.json: server "x": url must be an http or https URL"；与"pi won’t load this server"原因相同的 `config:` 行不重复；完整通知可以展开（"Full notice"） | — |
| 不是直接调用 | 条目的 `exposure` 不是 `direct`（没写时 pi 按 `codemode`） | 警示色"This server is set to “codemode”. Mori only supports direct calls, so the model can’t call its tools."（引号里是现在的调用方式："codemode"、"Deferred"或"Hidden"） | "Switch to direct calls"（`mcp.setDirect`，只改这个服务的 `exposure`，其他字段和别的服务原样保留） |
| 停用 | 你关了开关：`mcp.setEnabled`（写 `enabled: false`；打开时删掉这个字段） | 开关关上、行变淡 | 再打开 |
| 本项目的 | 条目来自 `.pi/mcp.json`，或项目里只写了 `enabled` / `exposure` 的覆盖 | 开关和按钮不可用，说明"Set in this project’s .pi/mcp.json. To change it, edit that file."；被覆盖的用户级服务说明"Overridden by this project: <字段>" | — |
| 读不出配置 | `mcp.json` 不能解析 | 原文；不能添加（免得覆盖坏文件），"Add"不可用，悬停说明"Fix mcp.json first: it can’t be read, and adding a server would overwrite it" | Open in default app |
| 没有服务 | 两处都没有 | "No MCP servers yet" | Add |

### 添加与编辑

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 表单 | 你点了"Add"或一个用户级服务的"Edit" | "Name"、"Command"、"Arguments"（每行一个，占位文字"One per line"）、"Environment variables"（每行 `NAME=value`）；说明"Servers you add here always use direct calls (exposure: direct)" | Save、Cancel、"Edit as JSON" |
| 以 JSON 编辑 | 你点了"Edit as JSON" | "Name"和"Server config (JSON)"：这个服务条目的 JSON（与 Claude 桌面版 / pi 的 `mcpServers` 条目同样的写法） | Save、Cancel、"Back to form" |
| 保存 | `mcp.save`：写进 `<agentDir>/mcp.json` 的 `mcpServers`，只改这一项，文件里其他内容原样保留；没写 `exposure` 时写 `direct` | "Saved · Only new sessions will connect to it"和"New session" | New session |
| 保存失败 | pi 不接受的条目（照搬 pi `validateMcpServerConfig`，原文同 pi：名字不合规、没有命令也没有地址、`args` 不是字符串数组、`env` / `headers` 的值不是字符串、`url` 不是 http / https、`type: "sse"`、`enabled` 不是 true / false 等）、与已有的重名（`-` 和 `_` 算同一个，同 pi）、JSON 不能解析、`exposure` 写了 direct 以外的值 | "Couldn’t save: "+ 说明或原文，例如"Couldn’t save: server "x": legacy SSE transport is not supported; use the streamable HTTP URL"（名称为空时"Name is required."）；表单保留你写的；`mcp.json` 不变 | 改后再存 |
| 移除 | 你点了"Remove…"并确认 | 确认框"Remove MCP server “<名字>”?"，说明"Sessions already open aren’t affected."；移除中按钮是"Removing…" | Remove；Cancel |

反例：工具页不凭工具列表猜连接状态：没有注册任何工具的服务不显示"Connected"，注册了工具的也不显示；进程状态只来自共享服务表，
显示的是"Running"等进程状态，不是"Connected"；调用 MCP 服务的工具会出批准卡（标题"<服务> · <工具>"，M2 起）。

## 插件（pi 包）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `packages`：pi 设置里的 `packages`（用户级和信任后的本项目）和 `resolve()` 找到的包内资源 | 每个包一张卡：来源（设置里写的）和解析后的文件夹、"User" / "Project"；按"Extensions"、"Skills"、"Prompt templates"、"Themes"分组列出资源，每个资源一个开关（读屏名称用单数的类别，如"Enable skill <名字>"、"Enable prompt template <名字>"）；主题标"Not used by Mori" | 按资源启停；Disable all / Enable all；Remove… |
| 添加本地包 | 你点了"Add plugin from folder…"（添加中"Adding…"），在系统对话框里选了文件夹：`package.add`（pi `addSourceToSettings`，写进用户级设置的 `packages`，路径相对 agentDir，不复制文件） | 新的卡出现；按钮旁的说明"Plugins must be local folders that include their dependencies. Nothing is downloaded." | — |
| 添加失败 | 文件夹不存在、已经添加过 | "Couldn’t add: "+ 说明（"Folder not found: <路径>" / "This plugin is already added"） | — |
| 包里没有资源 | `resolve()` 没找到 | 卡里"No extensions, skills, prompt templates, or themes found in this folder (a pi package lists them in the pi field of package.json, or in extensions / skills / prompts / themes folders)" | Remove… |
| 按资源启停 | `resource.toggle`（`togglePackageResource` 的写法） | 同技能 | — |
| 启停没有生效 | 写入后重新 `resolve()`，这一项不是要的状态：设置里另有同一项的别的写法（例如 `"-skills/review"`、写成文件夹），pi 最后看 `-` 条目 | 这一行下面"Couldn’t save: "+ 原文（指出哪份设置文件、哪一类的过滤，请你去掉那一条："… overrides it … Remove that entry there."）；开关回到原来的样子 | 去设置文件里删掉那一条后再试 |
| 停用整个包 | `package.setAll`（enabled=false）：四类都写成 `[]`（pi 文档的写法） | 全部开关关上，卡上的按钮变成"Enable all" | Enable all（去掉过滤，全部启用）；按资源启停：这一类的 `[]` 先换成 `"!**"` 再加 `+路径`（Mori 加的，见 [../defaults.md](../defaults.md)），只有打开的那一个启用，同类的其他资源仍是停用 |
| 移除 | `package.remove`（pi `removeSourceFromSettings`）并确认 | 确认框"Remove plugin “<来源>”?"，说明"This only removes it from your settings. The folder isn’t deleted. Sessions already open aren’t affected."；卡消失；文件夹不删 | — |
| 本项目的包 | 来自项目的 `.pi/settings.json` | 开关和按钮不可用，说明"Set in this project’s .pi/settings.json. To change it, edit that file." | — |
| 不是本地文件夹的包 | 用户级设置里来源以 `npm:` `git:` `github:` `http:` `https:` `ssh:` 开头（只能手改 `<agentDir>\settings.json` 写进来；内网 `PI_OFFLINE` 下 pi 不安装） | 卡上说明"Only plugins from local folders are supported, so this one won’t be installed. You can remove it."；没有装过时文件夹一行是"Folder not found"；资源开关和"Disable all"不可用 | Remove… |

反例：插件里的扩展注册的工具在新会话里出现，调用时出批准卡（插件和项目扩展注册的工具都要批准，方案 5.7）。

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 页面结构 | 左边分节、右边列表，每项一个开关（Claude 桌面版的"Connectors"和"Skills"列表） |
| 技能 | 列表里开关启停，点开看 SKILL.md 内容 |
| MCP 服务 | 列表里开关启停、看这个服务的工具；本地服务的配置用与 Claude 桌面版 `claude_desktop_config.json` 相同的 `mcpServers` 条目写法（"Edit as JSON"） |
| MCP 进程状态 | Claude 桌面版设置 → 开发者里每个本地服务显示 running / failed 和失败原文；Mori 每个服务一行"Running · Used by N sessions""Starting…""Failed: <原文第一行>"（完整原文在"Full error"里展开看），来源是共享服务表 |
| MCP 进程共用 | Claude 桌面版每个本地服务整个 App 一个进程，启动 App 时起、退出时关；Mori 同样（用户级服务，[../m6-mcp-shared.md](../m6-mcp-shared.md)） |
| 改了 MCP 配置之后 | Claude 桌面版改了本地 MCP 配置要重启才生效；Mori 对新建的会话生效、界面明说；旧进程没有会话用了才关 |
| 内置工具的开关（2026-10-26） | Claude 桌面版的 Customize 只有 Skills、Connectors、Plugins，没有内置工具的列表，没有对应；开关的样子和读屏名称照技能、MCP 一节（"Enable tool <名字>"） |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 工具页 | `data-testid="tools-page"`；左栏入口 `data-testid="nav-tools"`；分节按钮 `button[data-section]`（`builtin` / `skills` / `mcp` / `plugins`；2026-10-26 加最后一节 `agents`（Instructions），这一节的标识见 customize-agents-md.md） |
| 内置工具 | `[data-testid="tool-row"][data-tool]`，`data-active`；pi 内置工具行的开关 `role="switch"`（2026-10-26）；行下面的原因、`grep` / `find` 的说明和本项目设置的说明都是 `.tools-row-note`，写入失败是 `.form-message.error` |
| 技能 | `[data-testid="skill-row"][data-name]`，`data-scope`（`user` / `project` / `package`），开关 `role="switch"` |
| MCP | `[data-testid="mcp-row"][data-server]`，`data-scope`（`user` / `project`；同名的服务可能各有一行）；工具名 `data-testid="mcp-tools"`；进程状态 `data-testid="mcp-process"`，`data-state`（`starting` / `running` / `failed`；`shared` 为 null 时没有这个元素）；错误 `data-testid="mcp-error"`；pi 不会加载的原因 `data-testid="mcp-problem"`；"Switch to direct calls" `data-testid="mcp-direct"`；表单 `data-testid="mcp-form"`，JSON `data-testid="mcp-json"` |
| 插件 | `[data-testid="package-card"][data-source]`；资源行 `[data-testid="package-resource"][data-kind][data-path]` |
