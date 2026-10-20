# M6 检查记录（设置与工具页）

日期：2026-10-20。机器：Windows 11（10.0.26300），Node 24.19.0；Electron 44.9.0；pi 1.3.0。
分支 `claude/m6-settings-tools-c46a07`（基于 `app-v0` 的 `9240114`，即 M5 合并之后；开工时基于 M5 的 `5f484e8`，两者内容相同，你让 M5 先合并后改到 `app-v0` 上）。

## 状态

进行中。

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

### 打开很多会话时 MCP 的内存与进程（需要你决定）

pi 的 MCP 扩展每个会话各连一次：每个启用的 stdio 服务，每个打开着的会话起一个子进程（Windows 上另带一个 `conhost.exe`）。
M3 起会话一直开着，直到归档、删除或退出，所以成本随打开过的会话数线性增长。实测（`tests/ui/m6-mcp-cost.mjs`，开发构建，
一个合成 MCP 服务 `tests/mcp-server/server.mjs`，会话只打开、不发消息；数字是工作集）：

| 打开的会话 | MCP 子进程 | 子进程合计内存 | 后台进程自己 |
| --- | --- | --- | --- |
| 0 | — | — | 131 MB |
| 1 | node.exe ×1、conhost.exe ×1 | 52 MB | 134 MB |
| 5 | node.exe ×5、conhost.exe ×5 | 262 MB | 135 MB |
| 10 | node.exe ×10、conhost.exe ×10 | 525 MB | 135 MB |

合成服务是最小的 Node 脚本；真实服务常经 `npx` / `uvx` 启动（多一层进程），每个会更重。

Claude 桌面版的做法：本地 MCP 服务是整个 App 一份，每个服务一个进程，启动 App 时连上，所有对话共用；改了配置要重启 App。

选项：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| A（推荐，现在的做法） | 保持 pi 的做法，v0 不改；用不到的服务在工具页停用 | 打开的会话多、服务多时内存和进程多；你说过"不拿内存和 CPU 换性能"（2026-10-20） |
| B | 只给显示着的会话（或最近 N 个）连 MCP | pi 没有只断开 MCP 的接口，要 `session.reload()` 重跑全部扩展；也违背 M3 定的"会话不因不在屏幕上而停" |
| C | 照 Claude 桌面版：每个服务一个进程，所有会话共用 | 要在 pi 的 MCP 扩展下面接一层 Mori 自己的共享连接（`createMcpExtension` 的 `createTransport` 选项），是 pi 没有的后端（方案第 8 节第 4 条），要你同意 |
| D | 限制同时开着的会话数，超过时关掉最早的 | 违背 M3 时你定的"会话一直开着" |

推荐 A：v0 先不加后端；等你真的同时开很多会话、用多个服务时，再考虑 C。

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
   （有时是 `write EPIPE`），cmd 的中文报错只在 pi 的 `/mcp` 状态里、而且是乱码。
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
11. **MCP 每个会话各连一次**：见上"打开很多会话时 MCP 的内存与进程（需要你决定）"。

## fixture（从真实会话录制）

`tests/ui/m6-record.mjs` 经界面用的进程桥对 DeepSeek 发命令，录下命令、结果和全部事件；每个场景用新的临时数据目录和一次新的启动，
录完先自查，不合要求的不写入。7 个场景，录下的文件里没有 key（已扫描）。MCP 场景第一次录完后清理临时文件夹失败（MCP 服务以项目文件夹为
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

另有 `tests/fixtures/m6/pi-config-toggles.json`：不是会话录制，是 `tests/ui/m6-pi-config.mjs` 用 pi 自己的 `ConfigSelectorComponent`
（`pi config` 的组件）在固定的目录布局里依次启停用户级技能、包里的技能、用户级模板、项目技能后读出的 `settings.json`；
`m6-app-tools` 在同样的布局里经 Mori 的界面做同样的启停，逐字比较。
