# M6 检查记录（设置与工具页）

日期：2026-10-20（MCP 共享连接 2026-10-21）。机器：Windows 11（10.0.26300），Node 24.19.0；Electron 44.9.0；pi 1.3.0。
分支 `claude/m6-settings-tools-c46a07`（基于 `app-v0` 的 `9240114`，即 M5 合并之后；开工时基于 M5 的 `5f484e8`，两者内容相同，你让 M5 先合并后改到 `app-v0` 上）。

## 状态

按 AGENTS.md 的完成顺序（状态表 → 真实会话录 fixture → 界面测试 → 实现 → 真实模型走一遍 → 你走查），只差你走查。
M2–M5 的走查还没签收，你让我先做 M6；M6 没有改它们走查的行为，只有两处你会注意到的变化：顶栏多了模型和思考两个按钮
（M3 走查 2 的 Shift+Tab 路径从 6 次变成 8 次），"/"开头的输入会弹出补全列表（列表里没有可选的项时 Enter 照常发送）。
真实端点仍是 DeepSeek 公网端点（`deepseek-flash`，走查 1 加了 `deepseek-v4-pro`），key 用你在 Mori 里加密保存的那一份
（`%TEMP%\mori-real-data`）；脚本只复制加密的 key 文件，不读取 key；录下的 fixture 里没有 key（已扫描）。

结果一览：M6 的整机测试（设置 113 项、工具页 142 项、"/"补全 69 项、MCP 共享连接 49 项）、DeepSeek 走查 55 项在开发构建和打包程序上
全部通过，界面回放 82 项、`pi config` 写法对照在开发构建上通过；M0–M5 的测试在最后的代码上全部重新跑过，没有退步（M0 冒烟仍有 KNOWN #9129）。
MCP 按你选的 C 改成了共享连接（照 Claude 桌面版每个服务一个进程、所有会话共用）：10 个会话从 20 个进程约 525 MB 降到 1 个进程约 52 MB，
见下"打开很多会话时 MCP 的内存与进程"和 [m6-mcp-shared.md](m6-mcp-shared.md)。

## 照 Claude 桌面版

方案没定、按你的规则照 Claude 桌面版做的交互：

| 交互 | 照 Claude 桌面版的做法 |
| --- | --- |
| 设置页、工具页的结构 | 左边分节列表、右边内容，顶部"返回会话"；中栏窄于 620px 时分节列表移到内容上方 |
| 设置里的表单 | 在原位替换列表（不弹对话框），焦点放在第一个可以填的字段；编辑表单开着时这一行的其他按钮不可用，关闭后焦点回到打开它的按钮 |
| 模型菜单 | 一个按钮显示当前模型，点开按连接分组列出模型，当前的打勾，默认模型标"默认"，最后一项"管理模型…"进设置；只作用于这个会话 |
| 思考强度 | 与模型分开的一个按钮，菜单形式同上（方案 5.1 把它们列为顶栏的两项） |
| 工具页的列表 | 每项一个开关，点了马上切换，之后以重新读到的为准；技能点开看 SKILL.md 的内容；MCP 服务看它注册的工具 |
| 以 JSON 编辑 MCP 服务 | 与 Claude 桌面版 `claude_desktop_config.json`、pi 的 `mcp.json` 相同的 `mcpServers` 条目写法 |
| 改了 MCP 等配置之后 | Claude 桌面版改了本地 MCP 配置要重启才生效；Mori 对新建的会话生效，页面上明说，并给一个"新建会话"按钮 |
| 输入框的"/" | 打出 `/` 弹出命令列表，随打字过滤；↑ ↓ 选择，Enter / Tab 插入（不发送，方案"选中后插入"），Esc 关闭；列表只在输入框有焦点时出现，Esc 或插入之后直到第一个词变了才再出现 |
| 有未保存的改动时离开 | 先问，默认按钮是留下（"继续编辑"） |
| MCP 服务的进程（你定的，2026-10-20） | 每个服务一个进程，所有会话、所有项目共用；用户级启用的 stdio 服务在 Mori 启动时起、开到退出；用户级服务在你的用户目录里运行，`roots` 报挂着的会话的项目文件夹（[m6-mcp-shared.md](m6-mcp-shared.md)） |
| 工具页的 MCP 进程状态 | 照设置 → 开发者里每个本地服务的 running / failed：每个服务一行"运行中 · N 个会话在用""启动中…""失败：<原文第一行>"，完整原文展开看 |

## 需要你确认的地方（都已按推荐做法实现，走查时可以改）

1. **停用项目自己的技能写在项目的 `.pi/settings.json`**：方案 5.13 和第 6 节写"v0 只支持用户级启停"，但走查 3 要停用项目 `.pi/skills` 里的技能，
   而 pi 只按项目设置启停项目自己的资源（用户级设置停不了它，`package-manager.js` `addAutoDiscoveredResources`）。现在的做法：照搬的
   `toggleTopLevelResource` 对项目资源写项目的 `.pi/settings.json`，写出的条目与 `pi config -l` 完全相同（`tests/fixtures/m6/pi-config-toggles.json`
   用 pi 自己的组件录下对照）。项目设置对用户级资源的覆盖、项目里配置的包和 MCP 服务仍然只显示、不能改。
   另一种做法：项目资源也只显示，走查 3 改成停用用户级技能。推荐现在的做法；注意这个文件常常会提交进项目的 git。
2. **多个模型的存法**：`models.json` 里一个 provider 是一个"连接"（地址、接口类型、兼容选项、key），下面可以有多个模型，所以在同一个端点上
   "添加模型"不用再填 key。第一个连接沿用 `mori-endpoint`，之后的连接用 `mori-endpoint-<数字>`，删掉的 id 不再用（pi 按 provider id 找 key、
   会话文件记的是 `provider/模型`，重用会让旧会话悄悄连到新的端点）。
3. **改动何时生效**：AGENTS.md、技能、MCP、插件的改动只对之后新建的会话生效（pi 只在会话创建时读它们），界面上明说；连接和模型的改动对打开着的
   会话立刻生效（后台进程把它们换成新的模型对象）。
4. **顶栏按会话换模型、思考强度不改默认**：新会话仍用设置里的默认模型和它的默认强度（pi `setModel` / `setThinkingLevel` 不 persist，与 pi 的
   RPC 模式相同）。生成中这两个按钮不可用。
5. **键盘路径多了两步**：顶栏多了模型和思考两个按钮，M3 走查 2 的"从输入框 Shift+Tab 回到会话树"从 6 次变成 8 次（方案没有规定次数）。
6. **MCP 共享连接里 Claude 桌面版没有对应做法的几处**（都登记在 [defaults.md](defaults.md)）：
   - 项目 `.pi/mcp.json` 里的服务：这个项目最后一个用它的会话关闭（归档、删除）后关掉，不开到退出（去过很多项目时不积攒进程）；
   - HTTP 服务：第一次有会话用时才连，最后一个会话关闭后断开（没有进程要留着，没有会话时也没有登录凭据）；
   - 改了配置的服务：新会话用新配置起新进程，旧进程在最后一个旧会话关闭后关掉（Claude 桌面版要重启 App）；工具页那一行只显示新配置的进程；
   - 服务问 `roots` 时回答挂着的会话的项目文件夹，但会话进出时不通知服务（只在初始化时读一次 roots 的服务会看到空列表）。

## 开工前查的 pi 1.3.0 行为（"先确认"一列，对照源码，并用脚本实测）

### "/名称"在 `prompt()` 里怎样展开

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| `prompt(text)` 以 `/` 开头时先找扩展命令（按 `invocationName`），找到就交给扩展处理，不发给模型、不记进会话 | `core/agent-session.js` 1602–1692 `_tryExecuteExtensionCommand` | 扩展命令（例如 `/mcp`）不进"/"补全（方案只列提示词模板和技能命令） |
| 然后 `/skill:名字 参数` 展开成 `<skill name="名字" location="SKILL.md 路径">\nReferences are relative to <目录>.\n\n<正文>\n</skill>`，后面空一行接参数；技能不存在时原样发出 | `_expandSkillCommand` 1698–1722 | 补全里的技能命令写成 `/skill:名字` |
| 再按提示词模板展开 `/模板名 参数`：模板名是文件名去掉 `.md`；参数按 shell 规则拆分，支持 `$1`、`$@`、`$ARGUMENTS`、`${1:-默认}`、`${@:2}` | `core/prompt-templates.js` 252–266 | 补全里的模板写成 `/模板名`，显示模板的说明和 `argument-hint` |
| 发给模型的和记进会话的都是**展开后的文字**；原来的 `/名字 参数` 不保存，也没有专门的"展开了"事件，界面只收到普通的 `message_start`（你的消息） | 1466–1478、756–769 | 你的消息气泡里显示展开后的文字。技能调用（以 `<skill name=` 开头）照 pi 终端界面（`SkillInvocationMessageComponent`）缩成一行"技能 · 名字"加参数，可以展开看正文 |
| 不认识的 `/xxx`（包括 pi 终端里才有的 `/model`、`/thinking`）原样发给模型 | `core/slash-commands.js` | 补全只列模板和技能，不列终端命令 |
| 列表来源：`session.promptTemplates`（`{name, description, argumentHint, content, sourceInfo, filePath}`）、`session.resourceLoader.getSkills().skills`；pi 的 RPC 模式 `get_commands` 就是这样拼的（另加扩展命令） | `modes/rpc/rpc-mode.js` 540–567 | 后台进程新命令 `session.commands` 照这样取（不含扩展命令） |
| `enableSkillCommands` 设置只影响 pi 终端的补全，`prompt()` 照样展开技能命令 | `settings-manager.js` 913、`interactive-mode.js` 533 | 补全照 pi 终端：这个设置为 false 时不列技能命令 |
| 插话、排队（`steer` / `followUp`）也展开模板和技能，遇到扩展命令则报错 | 1723–1739、1794–1801 | 不影响补全 |

### MCP 扩展的通知在 SDK 下能否拿到

能。用合成 MCP 服务（`app/tests/mcp-server/server.mjs`）实测：把 `createMcpExtension()` 作为内置扩展加入资源加载器、`bindExtensions({ uiContext })` 之后，
pi 的 MCP 扩展经 `ctx.ui.notify` 发出的通知都到了 Mori 的界面上下文：

| 什么时候 | 原文（实测） |
| --- | --- |
| 有服务是 codemode 或延迟加载方式、而 codemode 和 tool_search 都没有加载（Mori 不加载它们） | `MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.`（warning） |
| 全部启用的服务连上或失败之后一次 | `MCP servers need attention:\n  broken: failed: MCP connection closed\n  initfail: failed: synthetic init failure\nRun /mcp to fix.`（warning）；每个出错的服务一行 `<名字>: failed: <错误第一行>`；pi 读配置时跳过的条目一行 `config: <文件>: server "<名字>": <原因>`（还有 `invalid server name "<名字>"`、`server "<名字>" conflicts with "<另一个>"`） |
| 第一次发提示时还有服务没连上 | `MCP servers are still connecting; their tools become available once connected.`（info） |
| 运行时加载失败 | `MCP failed to load: <原文>`（error） |

注意：

- 界面上下文必须是普通对象（pi 用展开运算符包一层，类的原型方法会丢）；Mori M3 起的 `ExtensionUi.context()` 已经是普通对象。
- Windows 上命令写错时（例如 `no-such-command-xyz`）pi 经 `cmd.exe` 启动，通知里只有 `failed: MCP connection closed`；
  cmd 的报错（GBK 编码）只在 pi 的 `/mcp` 状态里，而且被当成 UTF-8 显示成乱码。界面显示通知里的原文。
- pi 没有结构化的连接状态接口（`/mcp` 只把状态拼成一段文字发通知，例如 `empty: connected, 0 tools (direct)`）。
  Mori 不用它：工具页只显示 `getAllTools` 里这个服务注册的工具和通知里的错误原文，不显示"已连接"。

### MCP 的其他事实

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| 配置只有两处：`<agentDir>/mcp.json`（用户级）和 `<项目>/.pi/mcp.json`（项目信任后才读）；同名时项目的覆盖用户级；项目里只有 `enabled`、`exposure`、`toolExposure` 的条目是对用户级服务的覆盖 | `extensions/mcp/config.js` 36–117；docs/mcp.md | 工具页列出两处的服务；项目级的只显示，不能在这里改 |
| `mcp.json` 的位置取 `getAgentDir()`（即 `PI_CODING_AGENT_DIR`），不看传给资源加载器的 agentDir | `extensions/mcp/index.js` 1201 | Mori 已在环境变量里设好，两者一致 |
| 服务条目：stdio 用 `command`、`args`、`env`、`cwd`；HTTP 用 `url`、`headers`、`oauth`；共有 `enabled`（默认 true）、`exposure`（默认 **codemode**）、`toolExposure`、`timeout`、`description`；名字只能有字母、数字、`_`、`-` | `core/mcp-servers.js` 141–203 | Mori 添加的服务写 `"exposure": "direct"`；没写 exposure 的已有服务按 codemode 处理，显示"v0 只支持直接调用"和"改为直接调用" |
| 工具名 `mcp__<服务>__<工具>`（字母数字下划线以外的字符换成 `_`，超长或冲突时加哈希）；`getAllTools` 里的 `exposure`：直接调用为 `direct`，codemode 和延迟加载都是 `deferred`，停用或撤回的是 `hidden`；`namespace.aliases` 里有服务的原名；来源 `sourceInfo.path` 为 `builtin:mcp` | `extensions/mcp/tools.js` 25–51；实测 | 工具页按 `namespace` 把工具归到服务下，不列 `hidden` |
| 会话开始（`bindExtensions` 发 `session_start`）时在后台连接每个启用的服务，几百毫秒内工具出现；第一次提示最多等 10 秒（只等直接调用的服务） | index.js 971–1043；实测 | — |
| `mcp.json` 只在 `session_start` 读一次，没有监视文件；已经打开的会话要 `session.reload()`（pi 的 `/reload`）才会读到改动 | index.js 972；docs/mcp.md 28 | Mori 的添加、启停、改为直接调用都只对新会话生效，界面明说（见"照 Claude 桌面版"） |
| 每个会话的 MCP 扩展各自连接每个启用的服务：stdio 服务每个会话起一个子进程（Windows 上非 .exe 命令还多一个 `cmd.exe`）；没有跨会话共享、没有空闲断开 | `extensions/mcp/runtime.js` 87、278–299；pi-mcp `transports/stdio.js` | 见下"打开很多会话时 MCP 的内存与进程" |
| `AgentSession.dispose()` 不通知扩展；要先发 `session_shutdown`，MCP 扩展才关掉连接、结束子进程（Windows 上 `taskkill /T /F`） | agent-session.js 996–1015；index.js 1114–1120 | Mori 的 `release` 从 M3 起就是先发 `session_shutdown` 再释放 |
| 一个资源加载器只能给一个会话用（扩展状态挂在加载器上） | runner.js 208 | Mori 本来就是每个会话一个加载器 |
| 内置扩展用 `{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true }` 加入；在 `extensions` 设置里写 `-builtin:mcp` 可以停用 | `extensions/index.js` 5–12；docs/settings.md | 照方案第 6 节接入 |
| 项目信任：Mori 用 `projectTrusted: false` 建设置，`reload({ resolveProjectTrust })` 回调的结果由 pi 写回 `settingsManager.setProjectTrusted`，MCP 扩展按 `ctx.isProjectTrusted()` 决定读不读 `.pi/mcp.json` | resource-loader.js 349–372 | 不信任的项目不连它的 MCP 服务 |

### 每个模型的思考强度怎样设置和保存

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| 思考强度有 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；模型在 `models.json` 里没标 `reasoning: true` 时只有 `off`；标了、没有 `thinkingLevelMap` 时可选 off–high | pi-ai `models.js` 679–710 | 界面文字：关、最低、低、中、高（xhigh、max 只在模型映射了时出现：很高、最高） |
| `session.setThinkingLevel(level)` 按模型能力收紧，变化时往会话里记一条 `thinking_level_change` 并发 `thinking_level_changed` 事件；只有传 `{ persist: true }` 才写设置的 `defaultThinkingLevel` | agent-session.js 2085–2104 | 顶栏切换只作用于这个会话（不 persist），重新打开会话时 pi 按记录恢复 |
| 新会话的初始强度：`settings.json` 的 `modelThinkingLevels["provider/模型"]` → `defaultThinkingLevel` → `medium`，再按模型收紧 | sdk.js 84–144 | 设置页每个模型的"新会话默认的思考强度"写 `modelThinkingLevels`（pi 自己的按模型设置，与 pi 终端 `/thinking` 里 Ctrl+S 保存的是同一项） |
| 换模型（`setModel`）时强度改为 `modelThinkingLevels[新模型]` → `defaultThinkingLevel` → 原来的强度 | agent-session.js 2134–2146 | 顶栏换模型后思考强度可能跟着变，界面以后台进程返回的为准 |
| OpenAI 兼容端点、地址含 `deepseek.com` 时 pi 自动用 DeepSeek 的格式：模型标了支持思考时，`off` 发 `thinking: {type: "disabled"}`，其他强度发 `thinking: {type: "enabled"}` 和 `reasoning_effort: <强度>`；没标时什么都不发（DeepSeek 默认会思考） | pi-ai `api/openai-completions.js` 670–681、1238–1285 | 没标支持思考的 DeepSeek 模型仍会思考，但不能控制（M0 记录过） |
| 实测 DeepSeek（两个模型都标支持思考）：`off` 不再有思考；`low`、`medium`、`high` 都接受（没有报错）；很简单的问题（"1+1 等于几"）即使开了也常常不思考，需要推理的问题（鸡兔同笼）在 `low`、`high` 都有思考 | `tests/ui` 外的一次性脚本，经 Mori 的进程桥，key 不经脚本 | 走查 8 用需要推理的问题 |
| `setModel(model)` 检查 key、往会话里记 `model_change`；只有传 `{ persist: true }` 才写默认模型；**没有**模型变化的事件 | agent-session.js 1979–1996 | 顶栏换模型只作用于这个会话；结果由命令返回 |
| `modelRuntime.refresh()` 之后，打开着的会话仍拿着旧的模型对象（地址、上下文长度、是否支持思考都是旧的）；pi 自己只在扩展注册 provider 时换成新对象（`_refreshCurrentModelFromRegistry`：`agent.state.model = runtime.getModel(...)`） | agent-session.js 2702–2712 | 保存连接或模型后，后台进程照这个做法把打开着的会话换成新的模型对象（再按新能力收紧思考强度），并告诉界面。M0 起设置页说"保存后，已经打开的会话也用新的连接"，当时只对 key 成立 |
| 一个 provider 下可以有多个模型，共用地址、接口类型、兼容选项和 key | `provider-composer.js` 84–115 | 多个模型的存法见"与方案不同、或需要你注意的地方" |

### 启停的写法（`pi config`）

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| `pi config` 的写入在没有导出的 `ConfigSelectorComponent`（`modes/interactive/components/config-selector.ts`）：用户级启停是 `toggleTopLevelResource`（改设置里的 `extensions` / `skills` / `prompts` / `themes` 数组，先去掉同一路径原有的 `+`、`-`、`!` 条目，再加 `-路径` 或 `+路径`，路径相对设置文件所在的目录）和 `togglePackageResource`（改 `packages` 里那一项的过滤数组，相对包的根目录） | config-selector.js 426–521（源码在 `.js.map` 里） | 照搬这两个函数（注明出处），`app/src/kernel/resourceToggles.ts`；只多一处：停用整个包写的 `[]` 后再单独打开一个资源时先写 `"!**"`（`pi config` 自己不写 `[]`，见 defaults.md） |
| `toggleTopLevelResource` 对项目自己的资源（`.pi/skills` 等）写项目的 `.pi/settings.json`，写出的条目与 `pi config -l` 一样（`-skills\x\SKILL.md`、`+skills\x\SKILL.md`） | 对照 config-selector.ts 671–760 `setProjectTopLevelOverride` | 走查 3 停用项目技能：写进这个项目的 `.pi/settings.json`（用户级设置停不了项目的技能），见"需要你确认" |
| 列表用 `DefaultPackageManager.resolve()`：每项带 `enabled` 和来源（`scope` 用户级 / 项目、`origin` 顶层 / 包、`source`、`baseDir`），停用的也在；不传回调时会去下载缺的 npm / git 包（`PI_OFFLINE=1` 时不会） | package-manager.js 704–745、1014–1028 | 只读地列出时传 `async () => "skip"` |
| `resourceLoader.getSkills()` 只有启用的技能 | resource-loader.js 380–393 | 技能列表用 `resolve()` 的路径加 pi 导出的 `loadSkills` 取名字和说明 |
| `pi install <本地文件夹>` 只把路径写进设置的 `packages`（相对设置文件所在的目录），不复制文件；"停用整个包"按 pi 文档是把四类资源都写成 `[]` | package-manager.js 624–654、1160–1169；docs/packages.md 111–117 | "添加本地包…"用 `addSourceToSettings`；停用整个包写 `[]`，启用整个包去掉过滤 |
| 项目设置覆盖用户级资源（项目设置里对用户级路径的 `+` / `-`）只在项目视图里出现 | config-selector.ts 739–800 | 工具页对比"只按用户设置"和"加上项目设置"两次 `resolve()` 的结果，不同的标"本项目的设置改了它"、只读 |

### AGENTS.md

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| 每个目录只取第一个存在的：`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`；顺序是 agentDir 一个，再从文件系统根到工作目录逐级 | resource-loader.js 115–196 | 用户级编辑 `<agentDir>/AGENTS.md`；agentDir 里有 `AGENTS.override.md` 时它才生效，界面标出；agentDir 里只有 `CLAUDE.md` 时，保存 `AGENTS.md` 后 `CLAUDE.md` 不再加载，界面也标出 |
| 不受项目信任控制；会话创建时读一次 | docs/configuration.md、security.md | 保存后新会话才读到，界面明说 |
| `resourceLoader.getAgentsFiles()` 给出这个会话实际加载的文件（路径和内容） | resource-loader.js 465–474 | 项目级列表取焦点会话加载的文件 |

### 打开很多会话时 MCP 的内存与进程（你选了 C，已经做了）

pi 的 MCP 扩展每个会话各连一次：每个启用的 stdio 服务，每个打开着的会话起一个子进程（Windows 上另带一个 `conhost.exe`）。
M3 起会话一直开着，直到归档、删除或退出，所以成本随打开过的会话数线性增长。实测（`tests/ui/m6-mcp-cost.mjs`，开发构建，
一个合成 MCP 服务 `tests/mcp-server/server.mjs`，会话只打开、不发消息；数字是工作集）：

| 打开的会话 | 共享之前：MCP 子进程 | 子进程合计内存 | 共享之后：MCP 子进程 | 子进程合计内存 |
| --- | --- | --- | --- | --- |
| 0 | — | — | node.exe ×1、conhost.exe ×1（Mori 启动时起） | 52 MB |
| 1 | node.exe ×1、conhost.exe ×1 | 52 MB | 同一个进程 | 52 MB |
| 5 | node.exe ×5、conhost.exe ×5 | 262 MB | 同一个进程 | 52 MB |
| 10 | node.exe ×10、conhost.exe ×10 | 525 MB | 同一个进程 | 53 MB |

后台进程自己约 135 MB，共享前后一样。3 个服务时共享之后始终是 3 个进程、约 157 MB（共享之前 10 个会话会是 30 个）。
合成服务是最小的 Node 脚本；真实服务常经 `npx` / `uvx` 启动（多一层进程），每个会更重，省下的也更多。

当时给的选项是 A 保持 pi 的做法、B 只给显示着的会话连、C 照 Claude 桌面版共享、D 限制会话数，推荐 A；你选了 C（2026-10-20），
并说"claude 有 counterpart 的先完全按照 claude 的设计来"。方案、你的决定和实现约定在 [m6-mcp-shared.md](m6-mcp-shared.md)，
结果见下"测试 / 结果"，审查中发现并修正的见"测试中发现并已修正的问题"第 4 条。

### 内置工具的开关（2026-10-26 加，负责人走查 M12，检查记录 [../v1/walkthrough-1026/WP-08.md](../v1/walkthrough-1026/WP-08.md)）

M6 的内置工具一节只显示状态。负责人问"why so many not-enabled tools? why can't I enable them?"，回答 3 定了加开关。查的 pi 1.3.0 行为：

| 事实 | 出处 | Mori 的做法 |
| --- | --- | --- |
| 每个会话都注册全部 8 个内置工具（`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`），只启用 `defaultTools` 选出的；没有这个设置时是 `read`、`bash`、`edit`、`write`（`DEFAULT_TOOL_NAMES`） | agent-session.js `createAllToolDefinitions`；sdk.js 148–160；settings-manager.js 35 | 工具页每行一个开关 |
| `defaultTools` 可以是普通工具名的列表（整个代替默认），也可以只有 `+名字` / `-名字`（在默认上加减）；项目设置只有 `+` / `-` 时接在用户级的后面，否则代替 | settings-manager.js 75–99 `mergeDefaultTools`、`resolveDefaultTools`、1060 `getDefaultTools` | `defaultTools.ts` 照写这三条规则（单元测试对照 pi 真实的 `SettingsManager`）；开关写 `+` / `-` 的写法 |
| `SettingsManager` 没有写 `defaultTools` 的方法；每个 setter 的保存在 `FileSettingsStorage.withLock`（proper-lockfile）里重新读文件、只合并改过的字段 | settings-manager.js 117–178、449–472 | 在同一把锁里读改写这一项（`writeDefaultTool`），见 [defaults.md](defaults.md)"写 `defaultTools` 用 pi 的文件锁" |
| `grep` 要 ripgrep（rg）、`find` 要 fd：先找 `<agentDir>\bin`，再看 PATH；`PI_OFFLINE` 时不下载，调用失败，原文"ripgrep (rg) is not available and could not be downloaded"/"fd is not available and could not be downloaded"。`ls` 用 node 的 fs、`powershell` 用系统的，离线都能用 | utils/tools-manager.js 75–92、300–311；tools/grep.js 52–54；tools/find.js 119–125；config.js 519 `getBinDir` | 两行下面写明要哪个程序、放在哪里；Mori 不带这两个程序。负责人这台机器上 PATH 和 `pi\bin` 里都没有 |

## 交付了什么

| 方案要求（第 7 节 M6、5.12、5.13） | 实现 |
| --- | --- |
| 多个模型：列表、添加、编辑、删除；默认模型 | 设置页"连接与模型"（`SettingsPage.tsx`、`ConnectionsSection.tsx`、`ConnectionsList.tsx`、`ConnectionForm.tsx`、`ModelForm.tsx`）；后台进程 `config.ts`：连接 = `models.json` 里 Mori 的一个 provider，下面多个模型；添加连接（与首次启动同一张表单）、编辑连接、添加 / 编辑模型（不用再填 key）、删除（最后一个模型连同连接和 key）、设为默认（pi `setDefaultModelAndProvider`）、每个模型的"测试" |
| 顶栏按栏换模型，新回复来自新模型 | `ModelMenu.tsx` + `session.setModel`（pi `setModel`，不改默认）；后台进程发 `mori.model_state`；改了设置里的模型后，打开着的会话换成新的模型对象（`refreshSessionModels`） |
| 思考强度（设置页与顶栏，写法与 pi 相同） | 模型"支持思考"写 `models.json` 的 `reasoning: true`；"新会话默认的思考强度"写 pi 设置的 `modelThinkingLevels`；顶栏 `ThinkingMenu.tsx` + `session.setThinking`（pi `setThinkingLevel`，pi 记进会话、重新打开时恢复）；不支持思考时不可选并说明原因 |
| 用户级 AGENTS.md | `AgentsSection.tsx` + 后台进程 `agents.ts`：读写 `<agentDir>/AGENTS.md`，生效的文件取 pi `loadProjectContextFiles`，标出 `AGENTS.override.md` 盖过它、`CLAUDE.md` 会被它盖过；离开时有未保存的改动先问（`leaveGuard.ts`、`LeaveDialog.tsx`，所有换页面、换会话的入口都经过它）；项目级列出焦点会话实际加载的文件（`getAgentsFiles`），"用系统编辑器打开" |
| 工具页：内置工具 | `ToolsBuiltin.tsx`；后台进程 `resources.ts` `readTools`：`getAllTools` 去掉 hidden，启用取 `getActiveToolNames`，来源分内置 / 扩展 / MCP / 插件 |
| 工具页：Skill | `ToolsSkills.tsx`：pi `DefaultPackageManager.resolve()` 的全部技能（含停用的）加 `loadSkills` 的名字、用途、正文；来源用户级 / 本项目 / 插件；启停照搬 `pi config` 的写法（`resourceToggles.ts`）；本项目设置改了的用户级技能只读 |
| 工具页：MCP | MCP 照 pi 命令行作为内置扩展加入每个会话（`sessions.ts`）；`ToolsMcp.tsx`、`ToolsMcpForm.tsx` + 后台进程 `mcpConfig.ts`：添加表单和以 JSON 编辑（Mori 添加的写 `exposure: direct`）、`enabled` 开关、"改为直接调用"、移除；照搬 pi 的配置检查，pi 不会加载的条目标出原因；工具名取 `getAllTools`；错误取 pi 通知的原文；不显示"已连接" |
| MCP 共享连接（你选的 C） | 后台进程 `mcpShare.ts`：交给 pi 的 MCP 扩展虚拟传输（`createMcpExtension({ createTransport })`），每个服务一个真连接（pi 自己的 `createDefaultTransport` 起进程、连 HTTP），请求换编号转发、进度和取消按编号送回、握手按缓存回答；Mori 启动时起用户级启用的 stdio 服务（`index.ts`），退出时等它们全部退出；`mcp.json` 写入后关掉配置已经不在、没有会话用的进程（`mcpConfig.ts`）；工具页每个服务一行进程状态（`ToolsMcp.tsx` `McpProcess`，`McpServerEntry.shared`）。pi 的 MCP 扩展本身一行没改 |
| 工具页：Plugin | `ToolsPlugins.tsx` + `resources.ts`：添加本地包（pi `addSourceToSettings`）、按资源启停（`togglePackageResource`）、停用 / 启用整个包、移除；主题标"Mori 不使用"；本项目的包和不是本地文件夹的来源只读 |
| 只支持用户级启停，项目级的覆盖只显示 | 见上"需要你确认"第 1 条（项目自己的技能按 `pi config -l` 写项目的设置） |
| 输入框"/" | `SlashMenu.tsx`、`state/slash.ts` + `session.commands`（`promptTemplates` 和技能命令）；技能调用的气泡缩成一行"技能 · 名字"（`skillText.ts`），会话名、排队区、放回输入框都写成 `/skill:名字 参数` |
| 左栏入口 | 侧栏"工具"（收起为图标栏时是图标按钮） |

后台进程新增的命令（全部是方案第 6 节第 1 件"调用 pi SDK：……读写配置"）：`connection.save`（带 provider）、`endpoint.save`、`model.save`、
`model.delete`、`model.setDefault`、`connection.test`（带模型）、`session.setModel`、`session.setThinking`、`session.commands`、`agents.get`、
`agents.save`、`tools.get`、`resource.toggle`、`package.add`、`package.setAll`、`package.remove`、`mcp.save`、`mcp.setEnabled`、`mcp.setDirect`、
`mcp.remove`；新事件 `mori.model_state`。主进程只多了"删除一个 provider 的 key"（删除连接时）。
状态表：新增 [screens/settings.md](screens/settings.md)、[screens/models.md](screens/models.md)、[screens/tools.md](screens/tools.md)、
[screens/slash.md](screens/slash.md)；改了 connection.md、chat.md、layout.md、approval.md、sessions.md（键盘路径）、README.md。

## 与方案不同、或需要你注意的地方

1. **照搬了 pi 没有导出的几段代码**（都注明出处，pi 升级时要对照）：`pi config` 的两个启停函数（多加一处 `"!**"`，见临时默认值）、
   pi-ai 的 `getSupportedThinkingLevels` / `clampThinkingLevel`、`utils/json.js` 去注释的两个正则、`validateMcpServerConfig`（MCP 条目的检查）、
   `isLocalPath` 的前缀；界面里照抄了 pi 认技能调用的正则（`parseSkillBlock`）。
2. **打开着的会话换模型对象**：pi 重读 `models.json` 后会话仍拿着旧的模型对象，后台进程照 pi 私有的 `_refreshCurrentModelFromRegistry`
   直接改 `session.agent.state.model`；打开设置页（`config.get`）也会让 pi 重读 `models.json`。
3. **MCP 的错误靠认 pi 通知的原文**：pi 没有结构化的连接状态，工具页从对话流里以 `MCP ` 开头的扩展通知里取以 `<服务名>:` 开头的行和
   `config:` 行；pi 改了通知的写法就认不出（登记为临时默认值）。命令写错时 Windows 上 pi 的原文是 `failed: MCP connection closed`
   （有时是 `write EPIPE`），cmd 的中文报错只在 pi 的 `/mcp` 状态里、而且是乱码。共享连接之后工具页另有进程状态一行（真实来源），
   失败时显示原文第一行，"完整原文"里接着 stderr 末尾，cmd 的中文报错在那里同样是乱码（pi-mcp 按 UTF-8 解码 stderr）。
4. **带引用芯片时"/"命令不会展开**：发给模型的全文以引用块开头，pi 只展开以 `/` 开头的消息；这时列表里只有一行说明。先输入命令再加芯片的
   情况没有提示（照常发出、不展开）。
5. **提示词模板发出后气泡里是展开后的全文**（pi 不保留原来的 `/名字`，与 pi 终端相同）；技能命令缩成一行。
6. **"/"列表里没有可选的项时 Enter 照常发送**（照 Claude 桌面版）：扩展命令（例如 M3 的 `/mori-ask`）不在列表里，也能直接发出。
7. **删除一个会话正在用的连接**：顶栏显示"<模型>（已删除）"；连接没了时 pi 的下一条消息报 `No API key found for …`，错误卡附"去设置"，
   落在连接列表上。
8. **`models.json` 里有 `//` 注释时不能在设置页保存**（pi 读得了，但 Mori 写回去会丢掉注释），保存失败并说明；只有结尾逗号的照常保存。
9. **不是本地文件夹的包**（`npm:`、`git:`）：内网用不了，卡片只读、说明"这一项不会被安装，可以移除"；它在设置里时 pi 每次读列表都会运行
   `npm root -g`。
10. **pi 把一个空的本地文件夹当成一个扩展**（`resolveLocalExtensionSource`），"包里没有资源"只在 `package.json` 写了空的 `pi` 字段时出现。
11. **MCP 改成了共享连接**（你选的 C）：后台进程多了第五件事（方案第 6 节已改），pi 没有导出的 `createDefaultTransport`、`loadMcpConfig`
    按 pi 1.3.0 包里的文件路径载入（核对版本，pi 升级时要对照）。同一个服务被所有会话共用，服务里的状态跨会话、跨项目都看得到；
    pi 的 `/mcp reconnect` 只重连这个会话，不重启用户级服务的进程。

## fixture（从真实会话录制）

`tests/ui/m6-record.mjs` 经界面用的进程桥对 DeepSeek 发命令，录下命令、结果和全部事件；每个场景用新的临时数据目录和一次新的启动，
录完先自查，不合要求的不写入。7 个场景，录下的文件里没有 key（已扫描；2026-10-26 加的 `tool-switch` 同样扫描过）。MCP 场景第一次录完后清理临时文件夹失败（MCP 服务以项目文件夹为
工作目录，Mori 关掉之前删不掉），改为关掉 Mori 后再删，重录。M1 的 `no-key` 用 M6 的后台进程重录了一次（M6 起没有可用模型时会话信息里的
模型是空，不再是 pi 的占位模型 `unknown/unknown`）。

| fixture | 内容 |
| --- | --- |
| `model-switch` | 在 DeepSeek 连接下添加 deepseek-v4-pro（不填 key）；新会话先用 deepseek-flash 回答，顶栏换成 deepseek-v4-pro 后再回答（pi 记下的回复模型先后是 flash、v4-pro） |
| `thinking` | 把 deepseek-flash 标为支持思考（默认"中"）；新会话顶栏切到"高"问鸡兔同笼，回复有思考；切到"关"再问，没有思考 |
| `agents-md` | 写用户级 AGENTS.md"每次回答都以'收到'两个字开头"；新会话的第一条回复以"收到"开头 |
| `project-skill` | 信任的项目 `.pi/skills/m6-proj-skill`：工具页列为本项目，模型说得出它；停用后新会话的"/"列表和模型的回答里都没有它 |
| `mcp` | 添加合成 MCP 服务 mori-test、命令写错的 mori-broken、不注册工具的 mori-empty；新会话的工具页有 mori-test 的工具名、mori-empty 没有；pi 的通知里有 `mori-broken: failed`；DeepSeek 调用 `mcp__mori_test__echo` 出批准卡，允许后返回 `mori-mcp echo: hello-mori` |
| `plugin` | 添加 `tests/pi-package` 的副本：扩展、技能、提示词、主题四类；停用包里的技能、停用整个包、再启用；新会话里 `package_hello` 出批准卡，允许后返回 |
| `slash` | 用户级技能 m6-hello 和模板 m6-summary：`session.commands` 列出二者；发出 `/skill:m6-hello`（pi 展开成技能正文，回复 M6-SKILL-OK）和 `/m6-summary README.md`（展开成模板） |
| `tool-switch` | 2026-10-26 加（负责人走查 M12，[WP-08](../v1/walkthrough-1026/WP-08.md)）：会话 a 的内置工具里打开 `ls`（`tools.setDefault`，a 里仍是 Not enabled）；工具页新建的会话 b 里 `ls` 是 Enabled，DeepSeek（deepseek-flash）调用 `ls` 列出 `README.md`、`src/`，不出批准卡 |

另有 `tests/fixtures/m6/pi-config-toggles.json`：不是会话录制，是 `tests/ui/m6-pi-config.mjs` 用 pi 自己的 `ConfigSelectorComponent`
（`pi config` 的组件）在固定的目录布局里依次启停用户级技能、包里的技能、用户级模板、项目技能后读出的 `settings.json`；
`m6-app-tools` 在同样的布局里经 Mori 的界面做同样的启停，逐字比较。

## 测试

| 测试 | 做什么 |
| --- | --- |
| `tests/ui/m6-app-settings.mjs` | 真正的 Mori 对合成端点（synthetic）：首次启动表单的新字段；连接列表、添加 / 编辑连接、添加 / 编辑模型（不填 key、`credentials.json` 不变、重复 ID）、设为默认、每个模型的测试和取消、删除的各种限制、删除最后一个模型连同连接和 key、连接 id 不重用；改了地址不填 key 的原文；`models.json` 写坏 / 有注释 / 手工改好、`settings.json` 读不出；写入失败时 key 回滚；"去设置"落在出错连接的编辑表单、焦点在 key；顶栏模型菜单（分组、默认、管理模型、只用键盘切换、新回复来自新模型、生成中不可用、模型已删除）；思考强度（不支持思考时不可选和说明、标了之后打开着的会话也可选、高有思考 / 关没有、新会话用按模型的默认、换模型后收紧、重新打开时恢复、不改默认）；AGENTS.md（空状态、保存和 Ctrl+S、生效的文件、override 和只有 CLAUDE.md 两种提示、新会话读到 / 旧会话不读、读写失败的原文、项目级列表和用系统编辑器打开、离开时先问的各个入口和两种回答）；窄栏；没有小于 12px 的字 |
| `tests/ui/m6-app-tools.mjs` | 合成端点：入口和没有会话时只有技能、插件；跟随的会话（含打开中、归档后跟到剩下的一栏）；内置工具的来源和启用；技能三种来源、展开正文、本项目设置改了的只读、问题原文、未信任 / 之后才出现的项目配置不列出；按 `m6-pi-config` 的布局经界面启停，与 pi config 的写入逐字比较；MCP 表单和 JSON、各种保存失败（pi 的原文）、"改为直接调用"、开关、移除、本项目的只读和同名两行、pi 不会加载的条目、工具名、错误原文、没有工具的服务不显示"已连接"、调用出批准卡；插件添加、资源分组、主题"Mori 不使用"、按资源启停、停用 / 启用整个包（再单独打开一个时其余仍停用）、移除、不是本地文件夹的来源、包里的工具出批准卡；没有小于 12px 的字 |
| `tests/ui/m6-app-slash.mjs` | 合成端点："/"列表的分组、过滤、↑ ↓ 循环、Enter / Tab / 点插入不发送、没有可选的项时 Enter 照常发送（空闲时发出、生成中排队）、Esc 只关列表不停止生成、输入法组字、读取中 / 失败 / 没有匹配 / 会话没有模板、带引用芯片时的说明、会话没打开时不出；技能调用的气泡、会话名、排队区和放回输入框写成 `/skill:名字`；800×600、1200 分屏、1280、1400 各种宽度下顶栏的按钮逐级缩小、不溢出、菜单在这一栏里、会话名至少 36px；Shift+Tab 路径 8 次 |
| `tests/ui/m6-replay.mjs` | 回放上面 7 个 fixture，像你一样操作（设置页表单、顶栏菜单、工具页开关、添加本地包、MCP 表单、"/"补全）；界面发出的每条命令都要与录制一致，并核对显示的状态 |
| `tests/ui/m6-pi-config.mjs --check` | 用 pi 自己的 `pi config` 组件重新录一遍启停的写法，与 fixture 比较（pi 升级时用） |
| `tests/ui/m6-real.mjs` | 对 DeepSeek 的走查 1–8 与反例，每项截图 |
| `tests/ui/m6-mcp-cost.mjs` | 打开 1、5、10 个会话时 MCP 子进程的个数和内存（共享之后：每个服务始终 1 个进程、同一个 PID，退出后不留下） |
| `tests/ui/m6-app-mcp-shared.mjs` | 合成端点和带 `pid`、`cwd`、`roots`、`slow` 工具的合成 MCP 服务：启动时就起、只握手一次；两个项目的会话拿到同一个 PID；用户级服务在用户目录、项目的服务在项目文件夹里运行，同一个项目共用、不同项目各一个；`roots` 是挂着的会话的项目文件夹；两个会话同时调用各自出批准卡、编号不撞、进度只到发起的会话、停止只取消自己的那次；杀掉进程后工具页"失败：Connection closed"、下一次调用起新进程；改配置、停用、移除、归档后进程的去留；项目最后一个会话归档后它的服务退出；`-builtin:mcp` 时启动不起；退出 Mori 不留下进程 |
| M0–M5 的测试 | 确认没有退步；按 M6 的变化改了几处（设置页先是连接列表，改 key 在"编辑连接"里；Shift+Tab 8 次；M3 的扩展命令在"/"列表没有可选项时直接发出；M1 的 `no-key` 重录） |

回放桥（`tests/ui/harness/replay.js`）新增：`config.get`、`tools.get`、`agents.get`、`session.commands` 是只读查询，按录制回答（M1–M5 的录制里没有
`config.get`，用 synthetic 的一个连接）；M6 的写入命令逐项比较（不支持思考时不比较思考强度，MCP 条目没写 exposure 等于 direct）；选文件夹对话框在下一条命令是
`package.add` 时返回它的文件夹。合成端点新增 `which model`、`agents check`、`thinking check` 和带参数的 `call tool:`。

### 结果

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| 静态检查 `npm run check`（类型、禁用词、行宽）；另用 TypeScript 语法树核对了改动和新增的 53 个源文件里没有超过 50 行或 5 个参数的函数 | 通过 | — |
| M6 整机 `m6-app-settings`（合成端点） | 113 项全部通过 | 113 项全部通过 |
| M6 整机 `m6-app-tools` | 142 项全部通过 | 142 项全部通过 |
| M6 整机 `m6-app-slash` | 69 项全部通过 | 69 项全部通过 |
| M6 整机 `m6-app-mcp-shared`（MCP 共享连接） | 49 项全部通过 | 49 项全部通过 |
| MCP 进程与内存 `m6-mcp-cost`（1 个服务 / 3 个服务） | 5 项全部通过：0、1、5、10 个会话始终 1 个进程（同一个 PID）约 52 MB；3 个服务始终 3 个、约 157 MB；退出后不留下 | 5 项全部通过：同左（后台进程自己约 170 MB） |
| M6 界面回放 `m6-replay` | 82 项全部通过 | 不适用 |
| `pi config` 写法对照 `m6-pi-config --check` | 通过 | 不适用 |
| 真实端点走查 `m6-real`（DeepSeek；其中 6 项是模型行为，标为模型行为） | 55 项全部通过 | 55 项全部通过 |
| M5 整机 / 回放 | 36 / 20 项全部通过 | 36 项全部通过 / 不适用 |
| M4 整机 / 回放 | 61 / 26 项全部通过 | 61 项全部通过（见下）/ 不适用 |
| M3 整机 / 回放 | 137 / 60 项全部通过 | 137 项全部通过 / 不适用 |
| M2 整机 / 回放 | 68 / 98 项全部通过 | 68 项全部通过 / 不适用 |
| M1 整机 / 回放 | 35 / 57 项全部通过 | 35 项全部通过 / 不适用 |
| M0 冒烟 `m0-smoke` | 16 项通过，1 项 KNOWN（pi #9129，与 M1–M5 相同） | 同左 |

M4 整机在打包程序上前两遍有 3 项没过，都是"生成中选中一句话"那一处：拖选落在目标前面一句（"。第一段：春天来了"），之后的反馈也跟着不对。
拿共享连接之前的提交（`8c3505f`）打包的程序跑同一个测试，也出现同样的 3 项，再各跑一遍时两边又都通过，所以这是 M4 测试本来就有的时机问题
（流式输出时滚动和拖选的先后），不是这次的改动带来的；记录在这里，没有改测试。

M1–M5 的真实端点走查（`m1-real` 到 `m5-real`）这次没有重跑：M6 没有改它们走查的行为，合成端点的整机测试和真实录制的回放都覆盖了
（`m1-real` 改 key 的一步按 M6 的设置页改了写法，没有跑）。

### 走查 1–8 与反例（真实端点，开发构建与打包程序各一遍）

截图在 [m6/](m6/)（取自打包程序那一遍），全部截图在 `app/test-results/m6-real(-packaged)/`（不提交）。窗口 1200×800。

| 走查 | 结果 | 说明 |
| --- | --- | --- |
| 1 加第二个模型，在顶栏切换，新回复来自新模型 | 通过 | 连接卡上"添加模型"：没有 key 框，说明用这个连接的 key；保存 deepseek-v4-pro（上下文 1,000,000），`credentials.json` 不变。顶栏菜单按连接分组列出两个模型、当前的打勾、默认标"默认"；切到 deepseek-v4-pro 后的回复，会话文件里记的模型是 deepseek-v4-pro；`settings.json` 的默认模型不变。[添加模型](m6/1-add-model.png)、[菜单](m6/1-model-menu.png)、[切换后](m6/1-switched.png) |
| 2 用户级 AGENTS.md 写"每次回答以'收到'开头" | 通过 | 设置页 AGENTS.md：保存后"生效中：<agentDir>\AGENTS.md"；新会话的第一条回复以"收到"开头；项目级列出测试项目的 CLAUDE.md。[设置页](m6/2-agents.png)、[回复](m6/2-reply.png) |
| 3 已信任项目的 `.pi/skills` 技能 | 通过 | 工具页列出 m6-proj-skill、标"本项目"，展开看到正文；关掉后项目的 `.pi/settings.json` 是 `-skills\m6-proj-skill\SKILL.md`（与 pi config -l 相同）；停用前新会话的回答和"/"列表里有它，停用后都没有。[技能](m6/3-skill.png)、[停用后](m6/3-skill-off.png) |
| 4 表单添加 stdio MCP 服务，看到工具名，调用出批准卡 | 通过 | 表单保存后 `mcp.json` 里是直接调用；新会话的工具页"当前会话里注册的工具：mcp__mori_test__echo、mcp__mori_test__add"；DeepSeek 调用 echo 出批准卡"mori_test · echo"，允许后输出 `mori-mcp echo: hello-mori`。[工具名](m6/4-mcp-tools.png)、[调用](m6/4-mcp-call.png) |
| 5 MCP 服务的命令写错 | 通过 | 工具页这一行下面是 pi 的原文"mori_broken: failed: MCP connection closed"，"完整通知"与对话流里 pi 的通知相同；没有"已连接"。[截图](m6/5-mcp-error.png) |
| 6 添加本地文件夹的 pi 包，按资源启停 | 通过 | 包的卡按扩展、技能、提示词、主题列出资源，主题标"Mori 不使用"；关掉包里的技能，设置里写 `-skills\package-review\SKILL.md`（同 pi config），新会话的"/"列表没有它、同一个包的模板还在；再打开；包的扩展注册的 `package_hello` 出批准卡、允许后返回。[插件](m6/6-package.png) |
| 7 输入"/" | 通过 | 分"提示词模板""技能"两组列出 /m6-summary 和 /skill:m6-hello；过滤、↑ ↓、Esc、点击插入、Tab 插入；技能命令发出后气泡是"技能 · m6-hello"、DeepSeek 回 M6-SKILL-OK；模板发出后是展开后的全文。[列表](m6/7-slash.png)、[技能调用](m6/7-skill.png) |
| 8 标"支持思考"，顶栏"高"有思考、"关"没有 | 通过 | 没标时"思考：不可选"、菜单说明原因；编辑模型勾"支持思考"、默认"低"，已经打开的会话随之可选；新会话是"低"；切到"高"问鸡兔同笼，回复有思考；切到"关"再问，没有思考（会话文件里两次的思考强度分别是 high、off）；换到没标的 v4-pro 收紧为"不可选"。[没标](m6/8-unmarked.png)、[编辑模型](m6/8-edit-model.png)、[高](m6/8-high.png)、[关](m6/8-off.png) |
| 反例：没标支持思考时思考强度不可选 | 通过 | 见走查 8 |
| 反例：项目未信任时项目技能不出现 | 通过 | 不信任的项目里 `.pi/skills` 的技能不在工具页、不在"/"列表，顶部说明"没有信任这个文件夹"。[截图](m6/c-untrusted.png) |
| 反例：没有注册任何工具的 MCP 服务不显示"已连接" | 通过 | 不注册工具的合成服务写"当前会话里它没有注册工具"，工具页和会话页都没有"已连接"。[截图](m6/c-mcp-empty.png) |

## 测试中发现并已修正的问题

实现分三轮工作流做：六组各自实现（文件互不重叠）、每组接一个对照状态表的复查；之后一轮只读的代码审查（后台进程对 pi 的用法、界面对状态表、
key 与写文件的安全和方案原则三组，每条再由一个反驳者核对：确认 27 条，驳回 2 条），按文件分五组修正、每组再核对；最后写测试时又发现几处。

1. **实现时的复查**：首次启动表单改了模型 ID 再保存时，默认模型还停在第一次填的错 ID 上（测试连接测的是表单里的、打开文件夹后的会话用的却是
   旧的）→ 保存连接时默认模型跟着这个连接走；删除最后一个模型时删 key 失败会让界面以为没删（文件已经改了）→ 删 key 失败只记录并在结果里说明。
2. **代码审查确认、已修正的**：
   - 删掉的连接的 provider id 会被下一个新连接重用，用旧连接的会话（和会话文件）会悄悄连到新的端点，key 也可能发错地方 → id 不再重用；
   - "停用整个包"后单独打开一个资源，这一类的资源全部回来（扩展也是）→ 先写 `"!**"`；
   - `models.json`、`mcp.json` 的读改写没有排队，几次快速的点击会互相覆盖 → 排队（`mcp.json` 照 pi 同步写）；
   - `models.json` 有 `//` 注释时（pi 读得了）设置页打不开、保存会丢掉注释 → 照 pi 去注释读，有注释时拒绝保存；
   - 新 key 先存了、`models.json` 却没写成时，重启后新 key 会发给旧地址 → 写失败时把 key 恢复成原来的；
   - `settings.json` 读不出时设置页没有任何提示 → 显示原文；
   - MCP 条目 pi 会拒绝、Mori 却当正常的列出，`__proto__` 这样的名字能改到对象原型 → 照搬 pi 的检查、标出"pi 不会加载它"、只认自己的键；
   - 一个资源在设置里另有写法时，开关点了没反应也没提示 → 写完重新读，没生效时说明是哪一条挡住了；
   - 不是本地文件夹的包每次读列表都会同步运行 `npm root -g` → 卡片只读、可以移除；
   - 会话打开时文件夹没有要信任的内容、之后才出现的项目配置，工具页当成信任的列出、还能写 → 每次重新判断；
   - 工具页一直跟着进入时的会话，归档它之后显示"没有打开的会话" → 跟着现在的焦点；
   - 顶栏的模型、思考按钮在 600px 以下藏起，1280 宽打开右栏时就换不了模型 → 逐级缩小、不藏起；
   - 撤回、停止、错误卡把技能命令展开后的 `<skill>` 原文放回输入框 → 写回 `/skill:名字 参数`；带引用芯片时"/"命令不会展开 → 列表里说明；
   - 有未保存的 AGENTS.md 时点已归档的会话，先恢复了再问；选"放弃改动"后取消选文件夹，改动留在框里却不再问 → 都先问、放弃即回到读到的内容；
     agentDir 里只有 `CLAUDE.md` 时说"这里写的不会生效"（其实保存后它就被盖过）→ 分开说明；
   - 分节列表的 ↑ ↓ 从选中的那一节而不是有焦点的那一节算起；连接列表里删除、设为默认之后焦点掉到页面上 → 都改了。
3. **测试发现的**：
   - 手工修好 `models.json` 后重新打开设置页，错误还在（pi 只在保存时重读）→ 每次 `config.get` 先让 pi 重读；
   - 没有 key 时会话里的模型是 pi 的占位模型 `unknown/unknown`，顶栏显示"unknown（已删除）"和思考按钮，"去设置"落在列表上（M5 时是"unknown"）
     → 后台进程把占位模型当作没有模型；M1 的 `no-key` fixture 用 M6 的后台进程重录；
   - "/"列表开着、没有可选的项时 Enter 不发送，M3 的扩展命令 `/mori-ask` 要先按 Esc 才能发 → 没有可选的项时 Enter 照常发送；
   - 800×600、右栏打开时会话名被挤到只剩几个像素 → 600px 以下也藏起项目名（分屏时原来就藏）；
   - 录制：MCP 场景收尾时删不掉临时项目文件夹（MCP 服务以它为工作目录）→ 关掉 Mori 后再删。
4. **MCP 共享连接**（你选 C 之后做的：一轮实现、两轮只读审查、两轮核对，每条都先用后台进程脚本或界面测试复现，改完再跑一遍）：
   - 共享键含了只影响 pi 怎样给出工具的 `enabled`、`exposure`、`toolExposure`：项目的覆盖、工具页的开关、"改为直接调用"都会让同一个用户级
     服务多起一个进程 → 键里不算这三项；
   - 配置改了以后，旧会话按旧配置重连起的进程一直开到退出 → 新建的记录先核对是不是现在的配置；
   - 关闭不等进程退出：项目的服务重连、归档后马上开新会话时新旧进程同时占着端口（`EADDRINUSE`），退出 Mori 时没退完的被直接结束
     → 关闭等进程退出（同 pi 自己的传输），同一个配置的新进程先等旧的退出；
   - 没有会话用的项目服务在每次写用户级 `mcp.json` 时被顺带关掉（规则不一致）→ 项目的服务在这个项目最后一个会话关闭后关掉；
   - 改了配置、新配置起不来时，工具页那一行显示旧配置的进程"运行中" → 只取现在配置的进程（手改的配置也一样）；
   - 共享的 HTTP 连接一直留着第一个会话（关了也不放）的登录凭据提供者；HTTP 会话过期后旧连接到退出都不关；新会话挂到过期的连接上报
     "MCP session expired"、拿不到工具 → 凭据每次转给挂着的会话、没有会话时断开，过期时在共享层换新连接重发；
   - 启动时不管设置里的 `-builtin:mcp` 照样起服务 → 照 pi 的判断，停用时不起；
   - 版本核对拿 pi 自己报的版本比、总能通过，`PI_PACKAGE_DIR` 能让 Mori 载入别处的 pi 内部文件 → 核对固定的 1.3.0，载入 pi 前去掉这个变量；
   - 工具页"失败"一行接上整段 stderr，中文 Windows 上 cmd 的报错是乱码、行很高 → 只显示原文第一行，完整原文展开看；
   - "已经停了"这一状态不会出现（关掉的服务已经不在共享服务表里）→ 去掉。

## 未验证

- 内网端点、离线安装、安装包：按你的决定（2026-10-20）推迟到 M7 之后。M6 新加的东西都不需要联网（合成 MCP 服务、本地包都是本地文件），也没有新的依赖。
- 真实的第三方 MCP 服务：只用了合成的 stdio 服务（`tests/mcp-server/server.mjs`）。npm 上的官方服务需要先下载、经 `npx` 启动，内网装不了，
  这次没有接；HTTP 方式的 MCP 服务、OAuth 登录在 Mori 里都没有测（共享的 HTTP 连接、会话过期、登录凭据转给挂着的会话只在后台进程的脚本里
  用合成的 HTTP 服务验证过）。
- MCP 共享连接里没有在 Mori 里走到的：扩展用 `pi.registerMcpServer()` 注册的服务（不共用，照 pi 原来的方式）；服务主动推送的列表变化和日志
  通知（只在脚本里验证过）；"启动中…"这一状态（合成服务启动太快，工具页读不到）；用户扩展顶替内置 MCP 扩展时启动仍会起服务（登记在 defaults.md）。
- 真的输入法组字时的"/"列表：测试用 CDP 模拟组字（Enter 带 `isComposing`），真的中文输入法发的 `keyCode 229` 走同一个判断，没有单独测。
- 先输入"/命令"再加引用芯片：照常发出、不展开，没有提示（见"与方案不同"第 4 条）。
- 关闭 Mori 窗口时 AGENTS.md 有未保存的改动：不问（状态表写明）。
- 让 `models.json` 写失败时的 key 回滚：整机测试用"临时文件路径是一个文件夹"让写入失败来验证编辑连接的情况；添加连接时的回滚只看了代码。
- 打开很多会话时的 MCP 进程和内存：只用合成服务量了 1、5、10 个会话（见上），没有用真实服务、也没有量更长时间。
