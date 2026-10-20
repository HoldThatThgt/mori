# 工具页（M6）

依据：方案 5.13、第 4 节（Skill、MCP、Plugin 三行）、第 6 节"MCP""启停"；pi 行为见 [../m6-checks.md](../m6-checks.md)。

## 外框

| 项 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 入口 | — | 左栏"打开文件夹…"下面的"工具"（收起为图标栏时是图标按钮）；工具页打开时高亮 | 打开工具页 |
| 顶部 | — | "返回会话"；标题"工具"；跟随的会话："<项目名> · <会话名>"，或"没有打开的会话：只列出技能和插件（用户级）" | 返回会话（恢复分屏、滚动位置、草稿，与设置页相同） |
| 分节 | — | 照 Claude 桌面版的设置页：左边分节列表"内置工具""技能""MCP""插件"，右边内容；没有打开的会话时"内置工具""MCP"不出现 | 切换分节 |
| 改动何时生效 | pi 只在会话创建时读这些配置（m6-checks.md） | 页面顶部一行"启停和添加对新建的会话生效，已经打开的会话不变。"和"新建会话"按钮（在跟随的项目里新建，等于 Ctrl+N） | 新建会话 |
| 读取中 / 读取失败 | `tools.get` | "正在读取…" / 原文 | 重新读取 |

**跟随哪个会话**：当前会话（分屏时焦点所在的那一栏），即打开工具页之前中栏的那个会话；会话还在打开中时等它打开。工具页开着时在侧栏归档或删除了它，跟到剩下的那一栏；没有剩下的就是"没有打开的会话"。
工具页打开期间侧栏点别的会话会回到会话页（同设置页）。读取用 `tools.get`（带这个会话的 sessionId），每次进入工具页、
每次启停或添加之后重新读取；不监视文件。

**项目信任**：跟随的会话所在文件夹没有被信任（或没有回答）时，项目里的技能、扩展、插件和 `.pi/mcp.json` 都不列出，
顶部说明"没有信任这个文件夹，它自带的技能和配置不列出"（与会话横幅一致）。会话打开时文件夹没有要信任的内容、之后才出现的，
工具页每次读取照新会话重新判断：`trust.json` 没有记录时按没有回答处理（不列出、显示上面的说明）。

## 内置工具（只在有会话时）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `tools`：pi `session.getAllTools()`，不含 `hidden`；`active` 来自 `getActiveToolNames()` | 每个工具一行：名字、来源（内置 / 扩展 <路径> / MCP · <服务> / 插件 <包> / Mori 批准扩展不注册工具）、状态（"启用"，或"未启用"：注册了但没有给模型）、说明的第一行 | 展开看完整说明 |
| 说明 | — | 标题下一行"当前会话注册的全部工具。启用的才会给模型。" | — |

## 技能

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `skills`：pi `DefaultPackageManager.resolve()` 的全部技能（含已停用的），名字和用途取 pi 导出的 `loadSkills` | 每个技能一行：名字、来源（"用户级" / "本项目" / "插件 <包>"）、用途（description）、开关（启用 / 停用） | 启停；展开看正文 |
| 展开 | 你点了技能 | SKILL.md 的正文（去掉开头的 frontmatter）和文件路径 | 收起；用系统编辑器打开 |
| 停用 | 你关了开关：`resource.toggle`，写法照 `pi config`（照搬它的 `toggleTopLevelResource` / `togglePackageResource`）：用户级的写 `<agentDir>/settings.json` 的 `skills`（例如 `"-skills\\review\\SKILL.md"`），本项目的写项目的 `.pi/settings.json`（与 `pi config -l` 相同），插件里的写 `packages` 那一项的 `skills` | 开关关上、行变淡；页面顶部的"对新建的会话生效" | 再打开 |
| 写入失败 | `resource.toggle` 报错，或 pi 设置的 `drainErrors()` | 这一行下面"没能保存："+ 原文；开关回到原来的样子 | 再试 |
| 本项目的设置改了它 | 用户级技能在"只看用户设置"和"加上项目设置"两次 `resolve()` 里启用状态不同 | 开关不可用，说明"本项目的 .pi/settings.json 把它停用了（或启用了），只能在项目里改" | — |
| 有问题 | `loadSkills` 的 diagnostics（例如缺 description、同名冲突） | 列表下方警示色列出原文 | — |
| 没有技能 | 结果为空 | "还没有技能。把技能文件夹（含 SKILL.md）放进 <agentDir>\skills 或项目的 .pi\skills，或添加一个插件。" | — |

反例：项目没有被信任时，项目里的技能不出现；停用的技能，新会话问"你能用哪些技能"时没有它，`/` 补全里也没有。

## MCP（只在有会话时）

服务来自 `<agentDir>/mcp.json`（用户级）和项目的 `.pi/mcp.json`（项目信任后）；工具名来自跟随的会话的 `getAllTools()`。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `mcp.servers` | 每个服务一行：名字、来源（用户级 / 本项目）、命令行（`command` 加 `args`）或地址、启用开关、调用方式；pi 不会加载的条目也列出（见下一行），排在 pi 会加载的服务后面 | 启停（用户级）；编辑；以 JSON 编辑；移除 |
| pi 不会加载 | `mcp.servers[].problem`：后台进程照 pi 1.3.0 读 `mcp.json` 的检查（照搬 `validateMcpServerConfig`：名字、字段类型、`url` 只能 http / https、不支持 SSE、oauth / auth 的写法；再加 `-` 和 `_` 算同名的冲突、项目里不能写 `auth`、项目覆盖没有被覆盖的服务或写了别的字段），原文同 pi | 这一行下面警示色"pi 不会加载它：<原文>"，例如"pi 不会加载它：server "x": args must be an array of strings"；开关关上、不可用；不显示调用方式、工具名和"改为直接调用"。本项目里同名的条目被跳过时，用户级的那个服务照常是另一行，编辑它时表单只接在用户级那一行下面 | 编辑；以 JSON 编辑；移除（用户级的；条目不是对象时也能改写、移除） |
| 工具名 | 跟随的会话里 `sourceInfo.path` 为 `builtin:mcp`、`namespace.aliases` 里有这个服务名、不是 `hidden` 的工具 | "当前会话里注册的工具：mcp__x__echo、mcp__x__add"；一个都没有时"当前会话里它没有注册工具"。**不显示"已连接"**（pi 不提供连接状态） | — |
| 出错 | 跟随的会话对话流里 pi 的 MCP 通知（以 `MCP ` 开头的扩展通知）里以 `<服务名>:` 开头的行（连接错误），和以 `config: ` 开头、含 `server "<服务名>"` 或 `invalid server name "<服务名>"` 的行（pi 读配置时跳过了它） | 这一行下面警示色显示原文，例如"broken: failed: MCP connection closed"、"config: C:\…\mcp.json: server "x": url must be an http or https URL"；与"pi 不会加载它"原因相同的 `config:` 行不重复；完整通知可以展开 | — |
| 不是直接调用 | 条目的 `exposure` 不是 `direct`（没写时 pi 按 `codemode`） | 警示色"v0 只支持直接调用（现在是 codemode / 延迟加载 / 隐藏）：模型调用不到它的工具" | "改为直接调用"（`mcp.setDirect`，只改这个服务的 `exposure`，其他字段和别的服务原样保留） |
| 停用 | 你关了开关：`mcp.setEnabled`（写 `enabled: false`；打开时删掉这个字段） | 开关关上、行变淡 | 再打开 |
| 本项目的 | 条目来自 `.pi/mcp.json`，或项目里只写了 `enabled` / `exposure` 的覆盖 | 开关和按钮不可用，说明"本项目的 .pi/mcp.json，只能在项目里改"；被覆盖的用户级服务说明"本项目改了它的 <字段>" | — |
| 读不出配置 | `mcp.json` 不能解析 | 原文；不能添加（免得覆盖坏文件） | 用系统编辑器打开 |
| 没有服务 | 两处都没有 | "还没有 MCP 服务" | 添加 |

### 添加与编辑

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 表单 | 你点了"添加"或一个用户级服务的"编辑" | 名称、命令、参数（每行一个）、环境变量（每行 `名字=值`）；说明"Mori 添加的服务都用直接调用方式（exposure: direct）" | 保存、取消、"以 JSON 编辑" |
| 以 JSON 编辑 | 你点了"以 JSON 编辑" | 名称和这个服务条目的 JSON（与 Claude 桌面版 / pi 的 `mcpServers` 条目同样的写法） | 保存、取消、回到表单 |
| 保存 | `mcp.save`：写进 `<agentDir>/mcp.json` 的 `mcpServers`，只改这一项，文件里其他内容原样保留；没写 `exposure` 时写 `direct` | "已保存 · 新建的会话才会连接它" | 新建会话 |
| 保存失败 | pi 不接受的条目（照搬 pi `validateMcpServerConfig`，原文同 pi：名字不合规、没有命令也没有地址、`args` 不是字符串数组、`env` / `headers` 的值不是字符串、`url` 不是 http / https、`type: "sse"`、`enabled` 不是 true / false 等）、与已有的重名（`-` 和 `_` 算同一个，同 pi）、JSON 不能解析、`exposure` 写了 direct 以外的值 | "保存失败："+ 说明或原文，例如"保存失败：server "x": legacy SSE transport is not supported; use the streamable HTTP URL"；表单保留你写的；`mcp.json` 不变 | 改后再存 |
| 移除 | 你点了"移除"并确认 | 确认框"移除 MCP 服务 <名字>？已经打开的会话不受影响。" | 移除；取消 |

反例：没有注册任何工具的服务不显示"已连接"；调用 MCP 服务的工具会出批准卡（标题"<服务> · <工具>"，M2 起）。

## 插件（pi 包）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `tools.get` 的 `packages`：pi 设置里的 `packages`（用户级和信任后的本项目）和 `resolve()` 找到的包内资源 | 每个包一张卡：来源（设置里写的）和解析后的文件夹、用户级 / 本项目；按扩展、技能、提示词、主题分组列出资源，每个资源一个开关；主题标"Mori 不使用" | 按资源启停；停用整个包 / 启用整个包；移除 |
| 添加本地包 | 你点了"添加本地包…"，在系统对话框里选了文件夹：`package.add`（pi `addSourceToSettings`，写进用户级设置的 `packages`，路径相对 agentDir，不复制文件） | 新的卡出现；说明"内网只支持本地文件夹的包，包要自带依赖" | — |
| 添加失败 | 文件夹不存在、已经添加过 | "没能添加："+ 说明 | — |
| 包里没有资源 | `resolve()` 没找到 | 卡里"这个文件夹里没有找到扩展、技能、提示词或主题（pi 包的 package.json 的 pi 字段，或 extensions / skills / prompts / themes 文件夹）" | 移除 |
| 按资源启停 | `resource.toggle`（`togglePackageResource` 的写法） | 同技能 | — |
| 启停没有生效 | 写入后重新 `resolve()`，这一项不是要的状态：设置里另有同一项的别的写法（例如 `"-skills/review"`、写成文件夹），pi 最后看 `-` 条目 | 这一行下面"没能保存："+ 原文（指出哪份设置文件、哪一类的过滤，请你去掉那一条）；开关回到原来的样子 | 去设置文件里删掉那一条后再试 |
| 停用整个包 | `package.setAll`（enabled=false）：四类都写成 `[]`（pi 文档的写法） | 全部开关关上 | 启用整个包（去掉过滤，全部启用）；按资源启停：这一类的 `[]` 先换成 `"!**"` 再加 `+路径`（Mori 加的，见 [../defaults.md](../defaults.md)），只有打开的那一个启用，同类的其他资源仍是停用 |
| 移除 | `package.remove`（pi `removeSourceFromSettings`）并确认 | 卡消失；文件夹不删 | — |
| 本项目的包 | 来自项目的 `.pi/settings.json` | 开关和按钮不可用，说明"本项目的设置，只能在项目里改" | — |
| 不是本地文件夹的包 | 用户级设置里来源以 `npm:` `git:` `github:` `http:` `https:` `ssh:` 开头（只能手改 `<agentDir>\settings.json` 写进来；内网 `PI_OFFLINE` 下 pi 不安装） | 卡上说明"内网只支持本地文件夹的包；这一项不会被安装，可以移除"；没有装过时文件夹一行是"找不到这个文件夹"；资源开关和"停用整个包"不可用 | 移除 |

反例：插件里的扩展注册的工具在新会话里出现，调用时出批准卡（插件和项目扩展注册的工具都要批准，方案 5.7）。

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 页面结构 | 左边分节、右边列表，每项一个开关（Claude 桌面版的"连接器"和"技能"列表） |
| 技能 | 列表里开关启停，点开看 SKILL.md 内容 |
| MCP 服务 | 列表里开关启停、看这个服务的工具；本地服务的配置用与 Claude 桌面版 `claude_desktop_config.json` 相同的 `mcpServers` 条目写法（"以 JSON 编辑"） |
| 改了 MCP 配置之后 | Claude 桌面版改了本地 MCP 配置要重启才生效；Mori 对新建的会话生效、界面明说 |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 工具页 | `data-testid="tools-page"`；左栏入口 `data-testid="nav-tools"`；分节按钮 `button[data-section]`（`builtin` / `skills` / `mcp` / `plugins`） |
| 内置工具 | `[data-testid="tool-row"][data-tool]`，`data-active` |
| 技能 | `[data-testid="skill-row"][data-name]`，`data-scope`（`user` / `project` / `package`），开关 `role="switch"` |
| MCP | `[data-testid="mcp-row"][data-server]`，`data-scope`（`user` / `project`；同名的服务可能各有一行）；工具名 `data-testid="mcp-tools"`；错误 `data-testid="mcp-error"`；pi 不会加载的原因 `data-testid="mcp-problem"`；"改为直接调用" `data-testid="mcp-direct"`；表单 `data-testid="mcp-form"`，JSON `data-testid="mcp-json"` |
| 插件 | `[data-testid="package-card"][data-source]`；资源行 `[data-testid="package-resource"][data-kind][data-path]` |
