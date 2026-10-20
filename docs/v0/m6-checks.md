# M6 检查记录（设置与工具页）

日期：2026-10-20。机器：Windows 11（10.0.26300），Node 24.19.0；Electron 44.9.0；pi 1.3.0。
分支 `claude/m6-settings-tools-c46a07`（基于 M5 的 `5f484e8`，M5 还没有合并进 `app-v0`）。

## 状态

进行中。

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
| 全部启用的服务连上或失败之后一次 | `MCP servers need attention:\n  broken: failed: MCP connection closed\n  initfail: failed: synthetic init failure\nRun /mcp to fix.`（warning）；每个出错的服务一行 `<名字>: failed: <错误第一行>` |
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
| `pi config` 的写入在没有导出的 `ConfigSelectorComponent`（`modes/interactive/components/config-selector.ts`）：用户级启停是 `toggleTopLevelResource`（改设置里的 `extensions` / `skills` / `prompts` / `themes` 数组，先去掉同一路径原有的 `+`、`-`、`!` 条目，再加 `-路径` 或 `+路径`，路径相对设置文件所在的目录）和 `togglePackageResource`（改 `packages` 里那一项的过滤数组，相对包的根目录） | config-selector.js 426–521（源码在 `.js.map` 里） | 照搬这两个函数（注明出处），`app/src/kernel/resourceToggles.ts` |
| `toggleTopLevelResource` 对项目自己的资源（`.pi/skills` 等）写项目的 `.pi/settings.json`，写出的条目与 `pi config -l` 一样（`-skills\x\SKILL.md`、`+skills\x\SKILL.md`） | 对照 config-selector.ts 671–760 `setProjectTopLevelOverride` | 走查 3 停用项目技能：写进这个项目的 `.pi/settings.json`（用户级设置停不了项目的技能），见"需要你确认" |
| 列表用 `DefaultPackageManager.resolve()`：每项带 `enabled` 和来源（`scope` 用户级 / 项目、`origin` 顶层 / 包、`source`、`baseDir`），停用的也在；不传回调时会去下载缺的 npm / git 包（`PI_OFFLINE=1` 时不会） | package-manager.js 704–745、1014–1028 | 只读地列出时传 `async () => "skip"` |
| `resourceLoader.getSkills()` 只有启用的技能 | resource-loader.js 380–393 | 技能列表用 `resolve()` 的路径加 pi 导出的 `loadSkills` 取名字和说明 |
| `pi install <本地文件夹>` 只把路径写进设置的 `packages`（相对设置文件所在的目录），不复制文件；"停用整个包"按 pi 文档是把四类资源都写成 `[]` | package-manager.js 624–654、1160–1169；docs/packages.md 111–117 | "添加本地包…"用 `addSourceToSettings`；停用整个包写 `[]`，启用整个包去掉过滤 |
| 项目设置覆盖用户级资源（项目设置里对用户级路径的 `+` / `-`）只在项目视图里出现 | config-selector.ts 739–800 | 工具页对比"只按用户设置"和"加上项目设置"两次 `resolve()` 的结果，不同的标"本项目的设置改了它"、只读 |

### AGENTS.md

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| 每个目录只取第一个存在的：`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`；顺序是 agentDir 一个，再从文件系统根到工作目录逐级 | resource-loader.js 115–196 | 用户级编辑 `<agentDir>/AGENTS.md`；agentDir 里有 `AGENTS.override.md` 时它才生效，界面标出 |
| 不受项目信任控制；会话创建时读一次 | docs/configuration.md、security.md | 保存后新会话才读到，界面明说 |
| `resourceLoader.getAgentsFiles()` 给出这个会话实际加载的文件（路径和内容） | resource-loader.js 465–474 | 项目级列表取焦点会话加载的文件 |

### 打开很多会话时 MCP 的内存与进程

（实测数字见下"测试"。）
