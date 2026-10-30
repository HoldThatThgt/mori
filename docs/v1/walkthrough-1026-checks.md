# 2026-10-26 负责人走查（安装版）检查记录

依据：负责人在本机安装版 `D:\MORI`（`app-v0` 的 `2bfe0b8` 打包）上用了一轮，数据目录 `C:\Users\blue\AppData\Roaming\Mori`，
项目 `D:\code\Har-GUI` 与 `D:\code\LabelKit-DataSet`。共 28 条（M1–M28），诊断由两轮只读工作流完成（每组一个诊断、一个对抗复核，
最后一个跨组计划），诊断原文在会话的 scratchpad（`diag1.json`、`diag2.json`、`plan1.json`），这里只记结论、决定和状态。

## 条目

| # | 负责人原话 | 结论 | 工作包 |
| --- | --- | --- | --- |
| M1 | fetch models didn't auto fill compatibility options | 规格本来就不填；对 DeepSeek，pi 按地址自己调整，z.ai 的 Anthropic 接口没有这些选项。界面没说清楚 | WP-02 |
| M2 | after setup initial model the program didn't jump to main page | 测试通过后仍停在首次设置页，要再点 Open folder… | WP-01 |
| M3 | we do not need to separate local, intranet or public model | 去掉网络区域与按项目授权 | WP-05 |
| M4 | the AGENTS.md should put in customize rather setting | AGENTS.md 编辑从 Settings 移到 Customize | WP-07 |
| M5 | use drag to order model, not arrow button | 模型、key、分组成员三个列表改拖动 | WP-03 |
| M6 | "(not reported)" — what does it mean? | 服务器没报这个值，用的是 Mori 的默认值；改成 "(default)" 加悬停说明 | WP-02 |
| M7 | Verify / Long-input test… / Test / Tool calling / Handoff tier — delete, keep connection test & auto capability fill only | 删掉这些按钮和摘要；长输入测试、取消测试整个删掉 | WP-02、WP-04 |
| M8 | Reasoning field: native / Cancel: Unknown — what is this? | 推理内容放在哪个字段；能不能确认服务器停了请求。一并删掉 | WP-02 |
| M9 | instead of "new session" button, add a + icon next to the project title on the right | 每个项目行右侧一个 +（Claude 的做法） | WP-06 |
| M10 | no standalone TeamMode button, put it in model-selection panel | 模式开关进模型菜单 | WP-09 |
| M11 | show detail of Context window, like claude | 上下文环的详情里按 Claude 的分项显示 | WP-12 |
| M12 | why so many not-enabled tools? why can't I enable them? | pi 的可选工具（ls、grep、find、powershell）和只在任务模式出现的工具；加开关 | WP-08 |
| M13 | team mode didn't work, the agent worked inline | 任务模式其实派了 T1–T6；"自己干"发生在关掉模式之后，以及普通模式会话；另有 read_session 默认角色的 bug | WP-10 |
| M14 | can't view team mode status | 新视图，另开会话（规格先行） | 会话 bg-tasks-view |
| M15 | budget for AGENTS.md is too short, expand to 2000 tokens | AGENTS.md 单独一条 2,000 token 的提醒线 | WP-07 |
| M16 | mermaid diagram not rendered | 加 mermaid 渲染 | WP-13 |
| M17 | no subagent tool available when team mode off | 新功能，另开会话（规格先行） | 会话 subagent-tool |
| M18 | the process output didn't automatically collapse when dialog finished/paused | 一轮结束（含停止、出错）后把步骤折成一行 | WP-14 |
| M19 | I saw no memory tool used for a couple sessions | 现在只在"记住""从现在起"时保存 | WP-11 |
| M20 | can't find team mode setup panel (model per role, add extra agent) | 新功能，另开会话（规格先行） | 会话 customize-agents |
| M21 | team mode should be task mode | 界面、命令和发给模型的文字都改成 Task mode | WP-09、WP-10 |
| M22 | team mode on then off, the agent can't look back team session log | 关掉后板与会话的两个只读工具也被拿走，且没人告诉模型 | WP-10 |
| M23 | right panel can't resize fully to the left window edge | 800px 上限；加 Claude 的 Expand / Collapse；顺带修侧栏分隔条消失 | WP-13 |
| M24 | no preview on markdown on right panel | .md 文件加 Preview / View source | WP-13 |
| M25 | file preview didn't supply copy filepath option | 点标题里的路径复制完整路径（Claude 的做法） | WP-13 |
| M26 | the main agent asks users to call an agent tool themselves; prompts lack role boundaries | 各角色提示词补上"谁看得到什么"和各自的边界 | WP-10 |
| M27 | when close window, mori exits instead of minimizing to hidden icons panel | 关窗口留在系统托盘（Claude 的做法） | WP-20 |
| M28 | bash not usable in mori | Git 装在 `D:\Git`，pi 只找 Program Files 和 PATH；按方案第 6 节自动找 Git Bash | WP-00 |

## 负责人的回答（2026-10-26）

1. 模型列表只给名字时（z.ai），上下文窗口、最大输出和是否支持思考**按服务地址从 pi 自带的模型表取**（api.z.ai 取 z.ai 的条目），
   不按模型名猜；仍是猜的值标 "(default)"。这推翻了 2026-10-23 的"不用 pi 的模型表"（model-providers proposal §12 第 2 条、
   model-discovery 规格 §0 第 2 条），两处要先改（WP-15）。
2. 记忆：**主动保存你说出的长期事实，也在你纠正它时主动保存规则**；开着增强时，增强任务把记忆**重新归到对应的种类**
   （taste、strategy、review、facts）。原选项里"主动保存的规则标成 you said、增强永远不能改"由这条回答取代（WP-11）。
3. Customize 的工具列表给 pi 的 8 个内置工具加开关（存为 pi 的 `defaultTools`，对新会话生效），其余行写一行原因（WP-08）。
4. 这一轮：能直接做的在这个会话里做，一包一个分支，验证后 `--no-ff` 合进本地 `app-v0`，不推送；
   三项新功能（M14、M17、M20）各开一个会话，先写规格和状态表，问过负责人再做。
5. Customize 里 AGENTS.md 那一节叫 **Instructions**，放在最后（Plugins 之后），第一行说明这是每个会话都读的 AGENTS.md（WP-07）。
6. 测试（2026-10-26，写进 AGENTS.md "测试分层"）：每包只跑检查、构建、单元测试、`npm run test:quick`（不超过 2 分钟）和
   这包自己新增或改写的用例（`--only`）；完整界面回归、spec-coverage 和打包冒烟只在负责人要求推送时跑。
7. 不留未完成项、不做规格外的东西（2026-10-26，对 lead 和所有子会话；写进 AGENTS.md，WP-21）：规格写了的在同一个包、同一个会话里做完，
   不等、不往后推；用测试守住（`spec-ids` 检查、严格的单元报告器、推迟标记检查、覆盖检查）；规格没写的不做。
8. 按屏规格做的包不给状态表加编号，由审查守住（2026-10-26）：每包的检查记录列出它新加或改过的状态表每一行对应的用例；
   没有用例的行补上用例。已合并的包按这条补记录（见各包记录"状态表各行的用例"一节）。

## 工作包

顺序按共享文件排：第一波互不相干，并行开发、串行跑界面测试（测试端口固定）；第二波模型层与任务模式是一条链。

| 包 | 条目 | 给模型看的有变化 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| WP-00 自动找 Git Bash | M28 | 是（bash 能用了） | — | 已合并（`8ab308a`） |
| WP-01 首次设置后进主窗口 | M2 | 否 | — | 已合并（`a314244`） |
| WP-06 项目行的 + | M9 | 否 | — | 已合并（`e4301c9`） |
| WP-07 Customize › AGENTS.md、2,000 token | M4、M15 | 否 | — | 已合并（`58138cc`） |
| WP-11 记忆提示词、身份句 | M19（及 M17 的身份句） | 是 | — | 已合并（`1aa1d79`） |
| WP-12 上下文分项 | M11 | 否 | — | 已合并（`5199abf`） |
| WP-13 Markdown 与右侧面板 | M16、M23、M24、M25 | 否 | — | 已合并（`f62967f`） |
| WP-20 系统托盘 | M27 | 否（主进程，打包程序要跑相关套件） | — | 已合并（`45a3f6a`） |
| WP-02 精简模型行与提供商卡 | M1、M6、M7（界面）、M8 | 否 | WP-01 | 已合并（`10624c6`） |
| WP-03 拖动排序 | M5 | 否 | WP-02 | 已合并（`35fb828`） |
| WP-04 删掉长输入、取消测试 | M7 | 是（§5.7 超时换模型） | WP-02 | 已合并（`732d218`） |
| WP-15 按地址取 pi 模型表 | 回答 1 | 是 | WP-02 | 已合并（`989b6fa`） |
| WP-05 去掉网络区域 | M3 | 是 | WP-01、WP-02 | 已合并（`34fa29a`） |
| WP-08 内置工具开关、只读助手加 ls | M12 | 是 | WP-00、WP-07 | 已合并（`3aa835c`） |
| WP-09 模型菜单里的 Task mode（界面文字） | M10、M21 | 否 | WP-05 | 已合并（`e55b28b`） |
| WP-10 Task mode：模型读的文字、关掉后回看、角色边界 | M13、M21、M22、M26 | 是 | WP-09 | 已合并（`dca08a6`） |
| WP-14 一轮结束后折叠步骤 | M18 | 否 | WP-10 | 已合并（`d07cc41`） |
| WP-21 不留未完成项的规则与检查 | 回答 7 | 否（只改测试工具与 AGENTS.md） | — | 已合并（`f613281`，两次审查后 `531419c`） |

每包自己的检查记录写在 `docs/v1/walkthrough-1026/<包>.md`，包括按推荐定下的选择；本表在每包合并后更新。
（2026-10-26 补：模型层五包（WP-02、WP-03、WP-04、WP-15、WP-05）按回答 8 逐行补的用例在分支 `wt/cov-model-screens`，各包记录的
“状态表各行的用例”一节标“新加（集成时跑）”，集成时跑。独立核对之后补的（含 U17 的 Keys 两行）见 WP-02 记录“独立核对后补的”与“复核后补的”。）

### 第一波合并后（2026-10-26）

八包都已合进本地 `app-v0`（`45a3f6a`），没有推送。每包按回答 6 跑了快速集和自己的用例；完整回归留到推送前。
各包没验证的项见各自的记录，走查时先看这几条：

- WP-00：m0-shell 的两种情形和真实模型都通过了；完全没有 bash 时改用 powershell、HKCU 注册表那条路只有单元测试。
- WP-01：首次设置里一次 404 失败后，什么都不改再点 Test connection 会直接显示 "Connection failed: Connection error."，
  不发请求（模型池按 §8.3 记了 not_found）。不是 WP-01 引起的，交给 WP-02 一起看。
- WP-07：Instructions 的第一行和没有会话时的标题句是这包临时定的，负责人还没看过。
- WP-11：真实模型（DeepSeek）把 "No tables in your answers, please … Use short bullet lists instead." 存成了你说的
  （`asked: true`），所以增强不能改它。这种"请改成……"的纠正算不算你要求保存，留给负责人（见 WP-11.md）。
- WP-13：新加 mermaid（devDependency）。主检出的 `node_modules` 已补装（只新增 113 个包，锁文件没变）。
- WP-20：托盘的真实外观、右键菜单、通知气泡和 Windows 注销关机没有在界面测试里看过。
- 快速集现在约 104 秒，其中 m0-smoke 首次设置的两步各等约 30 秒（失败的 key 之后 Test connection 要等），交给 WP-02 诊断。

### 本轮状态（2026-10-27，`wt/cov-integration`）

| 项 | 状态 |
| --- | --- |
| 三个功能（Customize › Agents、普通模式 subagent、Background tasks） | 已合进本地 `app-v0`（`ab1a617`，没有推送），集成分支在 `b6c310c` 合进来 |
| 覆盖补测（`wt/cov-tray`、`-firstrun-shell-context`、`-sidebar-plus`、`-instructions`、`-tools-memory`、`-markdown-panel`、`-model-screens`、`-taskmode`） | 已合进集成分支（`3e5d53e` … `22215be`，`04a2980`），没有进 `app-v0` |
| 推送前的完整回归（[regression.md](walkthrough-1026/regression.md)） | m0–m6、模型层、TaskBoard、记忆、subagent 与 Customize › Agents、真实模型、打包程序各组跑完；一键拉取模型组与收尾的覆盖检查、最后的第 1 层没写完（2026-10-28 注：占位已按实情填上，MD-15 第四遍的结果没有记下、覆盖检查与最后的第 1 层没跑完）；MP-40 的真实层阻塞（要负责人的 OpenRouter key）。合进 finish check 与文件系统之后第 3 层多了 `fc-*`、`fs-*` 与两份覆盖检查，要整套重跑 |
| 收尾检查（finish check） | 合进集成分支（`31b06c0`，合并 `origin/app-v0` `8accf1a`）；`fc-away-once` 见 U61 |
| 文件系统（FS-01…FS-115） | 合进集成分支：`3bd0c6f`（`origin/claude/happy-bell-a93948` `6470920`）、`09082da`（`wt/fs-fixes` `e76398a`）、`fcd3fce`（`wt/fs-suites` `954c689`），端口挪到 5000–5019（`c17ea9a`，U62）；合并定的 U47–U64 见下一节 |
| 第 1 层（合并之后） | `npm run test:min` 通过（143 秒）：check、构建、unit 510、tb 400、mem 243、md 222、sa 30、ag 41、fc 109、fs 957；合成端点自检 270/270；`npm run test:quick`（PATH 前加 `D:\Git\bin`）4/4，115 秒（含构建 141 秒）：tb-replay `tb-team` 19（U64 重录之后）、m0-smoke 41（1 条 KNOWN，pi #9129）、mem-replay 17、m1-replay 16。前一遍 `test:min` 里 FS-49“1 MB 的 bash 命令 500 毫秒内分析完”超时一次（同时别的会话有 28 个 node 进程），单独重跑与整遍重跑都通过 |
| 2026-10-28：接手 issue #3、修复与重录 | 四个修复包（`wt/fix-fsfc`、`wt/fix-main`、`wt/readonly-tools`、`wt/fix-replays`）与第二阶段的重录、真实层合进集成分支；决定 U65–U71；负责人定不跑完整回归，只跑第 1 层、`--only`、重录与受影响的真实层、打包冒烟（结果与没跑的层见 [regression.md](walkthrough-1026/regression.md) 文末“2026-10-28：合并之后”一节，要负责人回答的八条也在那里）；第 1 层（`33f0075`）`test:min` 120 秒全过、`test:quick` 4/4；合进 `app-v0` 并推送 |

## 按推荐定下的（负责人没单独回答的）

诊断给出的建议选项全部照用，除了上面的回答改过的。主要几条，便于走查时先看：

- M2：测试连接成功就进主窗口，"Connected · …"在主窗口的 Open a folder 提示里显示一次；验证进度显示在会话的卡片上。
- M3：不写兼容代码。旧 `model-config.json` 里的 `zone`、`allowedZones`、`projectZones` 在装新版时备份后删掉一次（安装版的数据目录与测试用的
  `%TEMP%\mori-real-data` 都要）；装新版前不动安装版的数据。
- M6：只有值仍等于 Mori 默认值时标 "(default)"，悬停说明。M7：模型行只在第一次检查进行中或模型不能用时显示一行状态，失败时带 Verify again。
- M9：顶部的 New session 去掉，每个项目行右端常显一个淡色 +，只能用鼠标点（键盘用 Ctrl+N）；收起的侧栏保留一个 +。
- M10：模型按钮上显示 "Task mode · <模型 id>"；回复进行中也能打开菜单切换模式（模型变灰）。
- M13/M22：关掉 Task mode 后，会话的板上有过请求时保留 board_read 与 read_session，并在工作卡里写明 "Task mode: off"；只读助手总有 ls。
- M18：折叠后显示 "{n} steps"（有失败时加 "· k failed"）；文字跟在后面或一轮结束时折叠；进行中全部显示。
- M21：命令改为 /task、/task on、/task off；"Stop team" 改为 "Stop agents"。
- M23：去掉 800px 上限（聊天区至少留 300px），加 Expand / Collapse；M24：.md 默认 Preview，从引用跳来时 View source；预览里选中文字引用的是对应的源码行；
  图片与链接同聊天（不加载、不跳转）。M25：点标题里的路径复制完整路径，提示 "Path copied to clipboard."。
- M26：主 Agent 自己读任务结果并完整交给你；只有你要求时才写文件。
- M28：先找 PATH 上的 `git.exe`（`<Git>\cmd\git.exe`）对应的 `<Git>\bin\bash.exe`，再看 Git for Windows 的注册表；
  找到就在内存里给 pi 的设置加 `shellPath`，不写你的 `settings.json`。

## 负责人不在时定下的选择（U1–U46，待复核）

下面 U1–U46 原来记在 lead 的会话里，2026-10-27 合并 finish check 与文件系统时照抄过来；U47 起是这次合并定的。每一条都照推荐定下、登记了临时默认值，负责人看过后可以改。

负责人原话："unattended mode, pick recommended option for questions and log them, I will read them after"。下面每一条照推荐定下、
登记临时默认值；负责人看过后可以改。原则：问"要不要加一个新东西"的，按推荐不加、照现在做的写进规格；问"现在这样写不写进规格"的，
写进规格并有用例。

| 编号 | 问题（出处） | 选项 | 定的 | 落在哪里 |
| --- | --- | --- | --- | --- |
| U1 | 普通模式子 Agent：身份段 549 token 超过 MEM-01 的 500（subagent 会话） | 1 把子 Agent 的说明挪进工具描述，身份段保持 500；2 把预算提到 600 | 1 | v1-subagent 已做，MEM-01 = 500 |
| U2 | Customize › Agents 的 "All MCP tools" 与 TaskBoard §4.1/§4.4（customize-agents 会话） | 1 允许 `mcp__*`；2 只列出已知的 MCP 工具 | 1 | v1-customize-agents 已做 |
| U3 | 拖动排序放下的规则：模型列表（WP-03）与 Customize › Agents 不同 | 1 都用 WP-03 的上半、下半插入前后；2 都用放到一项上取代它的位置 | 1 | customize-agents 已改用 WP-03 的 Reorder，状态表照 WP-03 写 |
| U4 | WP-11：带"请以后这样"的纠正，模型给 `asked: true`，记成 You said（WP-11 留给负责人） | 1 不改：照规格由模型判断 asked；2 改 A.2 的文字，只有 from now on / always / remember 才算 | 1 | 不改发给模型的文字；不用重录 |
| U5 | WP-07：Customize 没有会话时顶部那句、跟随中的项目一栏写法（WP-07 实现时定下的 4–12） | 照现在的写法 / 另写 | 照现在的写法 | docs/v0/defaults.md 已登记 |
| U6 | WP-20 需要你确认 1：要不要 Help 菜单；Windows 注销、关机时要不要有序关闭（接 `session-end`） | 1 不加 Help、不接 session-end，照现在写进规格；2 加 | 1 | window.md "其他退出的方式" 已写；测试到不了（要注销这台机器） |
| U7 | WP-20 需要你确认 2：确认框要不要 Claude 的第三个按钮 "Wait for Mori" | 1 不加；2 加 | 1 | 不改 |
| U8 | WP-20 需要你确认 3：托盘图标要不要也用作 Mori.exe、窗口和任务栏的图标 | 1 只用在托盘；2 都用 | 1 | 不改 |
| U9 | WP-20 需要你确认 4：只有增强任务在跑时 Exit 要不要先问 | 1 不问，增强记失败、下次启动补跑；2 问 | 1 | window.md 正文与 defaults.md 已写；用例 mem-app-enhance-b exitDuring |
| U10 | 托盘：写不进 tray-notice-shown 时每次关窗口都出气泡；确认框弹不出时 Exit 什么都不做（覆盖补测） | 1 照现在，登记为异常分支的临时默认值；2 改 | 1 | docs/v0/defaults.md 登记 |
| U11 | 项目行的 + 不让行变高（覆盖补测，WP-06） | 1 留作临时默认值；2 写成状态表一行 | 1 | docs/v0/defaults.md "项目行的 +"，用例 m3-app projectPlus |
| U12 | Customize 顶部 New session 在 Instructions 有未保存改动时先问（WP-07 补的行） | 1 留这一行（同 Ctrl+N）；2 去掉 | 1 | customize-agents-md.md 那一行，用例 m6-app-settings agentsLeave |
| U13 | 内置工具开关保存中显示新位置且不可点、项目设置定死时悬停说明（WP-08 覆盖补测） | 1 留作临时默认值；2 改 | 1 | docs/v0/defaults.md，用例 m6-app-tool-switches turnOff |
| U14 | 生成中的回复里代码块跟着往下滚、"Copy code" 生成中不可用（WP-13 决定 9，Streamdown 的副作用） | 1 照现在，写进 chat.md "代码块还在写"；2 只把 mermaid 标成没写完，去掉这个副作用 | 1 | chat.md 加一行与用例（集成时） |
| U15 | changes.md "复制路径"读取失败时复制解析后的完整路径（WP-13 覆盖补测更正） | 1 照代码更正规格；2 改代码 | 1 | changes.md 已更正 |
| U16 | 范围菜单可选的项没有读屏说明、F8 的几行去掉区域（WP-05 的连带变化） | 1 写成状态表的行；2 当作措辞，登记临时默认值 | 1 | model-menu.md、f8.md，有用例 |
| U17 | Keys 一行的 Test 与卡上 Test connection 走同一条路：不看任何不可用记录，成功后清提供商的 connection 和模型的 not_found（MP-41 来自 lead 转述 WP-01 的观察） | 1 照现在写进 Keys 状态表；2 改成只不看这个 key 的记录 | 1 | models-settings.md Keys 表与用例（集成时） |
| U18 | WP-10：关掉 Task mode 之后，DeepSeek 被问到清单在哪时没有用 read_session 读任务的会话，而是用 bash 重新列文件（Ask 下每次一张批准卡）。要不要在关闭后的说明卡里明说先用 read_session 读结果？ | 1 不改发给模型的文字（模型行为，不是 Mori 的缺陷）；2 改文字并重录 | 1 | 不改；记在 WP-10 记录 |
| U19 | WP-14：步骤折起后最后 50 条放得下时，滚轮往上加载更早的消息；键盘（PageUp/Home）在不能滚动时不加载 | 1 照现在（滚轮加载，登记临时默认值）；2 再加键盘加载 | 1 | docs/v0/defaults.md 已登记 |
| U20 | WP-14：折起的行只标 Failed（" · k failed"），不标 Denied、Stopped、Interrupted | 1 照现在；2 都标 | 1 | 不改 |
| U21 | WP-09：Task mode 一行在模型菜单里的位置、按钮上 "Task mode · <模型 id>" 是否太长、关闭时这一行要不要说明、"Stop agents" 这个名字 | 照现在（临时默认值，走查时看） | 照现在 | docs/v1/defaults.md |
| U22 | WP-08：开关是新会话的默认；手写的工具列表用过开关后会改写成相对 pi 默认的写法；grep、find 要 rg.exe、fd.exe，Mori 不带 | 照现在 | 照现在（2026-10-29 U76 改：Mori 随安装包带 rg.exe、fd.exe，grep、find 下面不再有说明） | WP-08 记录 |
| U23 | WP-04：发出后 2 分钟没有回音，一律再等满 2 分钟才换模型，换模型提示 "Couldn't confirm it stopped" | 照现在（负责人 M7 的结果） | 照现在 | WP-04 记录 |
| U24 | WP-05（M3 的后果，告知）：会话、压缩、增强、任务 Agent 和自动换模型都可能把项目代码发给范围里的任何提供商，包括公共的；要限制只能用分组加项目的 .mori/models.json | 告知，不需要选 | — | WP-05 记录 |

需要负责人自己处理的（不是选择题）：
- 一个 09:30 留下的测试窗口（Mori electron pid 21716，node pid 17628、1736，显示 "Mori's background process crashed · Restart"）
  还开着：集成 Agent 没有权限结束它们。请关掉这个窗口或结束这几个进程。端口 4399 由 pid 36088（lead 早先起的合成端点）占着，
  测试不用这个端口，可以一起结束。m0-smoke 失败时不退出的问题已在 wt/cov-model-screens 修好（closeOrKill）。
- 装新版之前：%APPDATA%\Mori\model-config.json 里还有 zone、allowedZones、projectZones，新版读到会拒绝（Settings › Models 只显示
  "Couldn't read model settings"）。lead 会在推送后给出备份和删除这三项的办法（见本轮结尾）。

功能会话与审查里按推荐定的（2026-10-26）：

| 编号 | 问题（出处） | 选项 | 定的 | 落在哪里 |
| --- | --- | --- | --- | --- |
| U25 | Customize › Agents：Edit 表单没有勾选框的工具写法（如 `mcp__github__*`）以前一点勾选就被删掉（审查发现） | 1 留在文件里、表单里不显示；2 在表单里另列出来 | 1 | v1-customize-agents，defaults.md，AG-06 用例 |
| U26 | Customize › Agents："Add model range" 的模型怎么分节（下拉框不能嵌套） | 1 每个提供商一节 "Models · <提供商名>"，空的节不显示；2 一节 Models | 1 | defaults.md，AG-04 用例对照模型菜单 |
| U27 | Customize › Agents：只有表单外保留的工具、一个框都没勾时能不能保存 | 1 能（保留的条目就是工具）；2 不能，要求至少勾一个 | 1 | 状态表"不能保存"一行与 §6.4，defaults.md |
| U28 | 普通模式 subagent：项目有别的角色时 role 用 enum，未知角色拿到 pi 的 "Validation failed"，规格 §3.3 的文字到不了模型（审查发现） | 1 去掉 enum，由 Mori 的检查给出规格的两行错误；2 保留 enum，改规格 | 1 | v1-subagent，defaults.md，SA-03 用例 |
| U29 | Background tasks：项目没有角色文件时，基础 agent 在列表里仍写 "Mori"（WP-10 #64 只在进度摘要里去掉） | 照 bg-tasks 会话的推荐（见 team-checks.md 后台 task 一节第 5 条） | 推荐项 | v1-bg-tasks，defaults.md |
| U30 | 改界面文字里的直撇号：kernel/roles.ts 的 "can't read the header: it must be…"（Customize › Agents 修了）、board.ts 的 "<close role> can't run: no model available"（集成时修）；发给模型的文字（boardText.ts）不改 | 照 ui-strings.md 第 12 条改成 ’ | 改界面文字，模型文字不动 | 两处各有测试 |
| U31 | 普通模式 subagent：交接句按会话真有的工具写；Task mode 下只有 agent_message、没有 task_create 的会话（拆开的对话、task、结案、订阅实例）因此拿到 "Questions you send to other agents …"，不再是 WP-11 的原句（原来转达的选择是"Task mode 的文字与 WP-11 逐字相同"） | 1 照工具写（准确，tb-real --only team 10/10）；2 Task mode 下一律用 WP-11 原句 | 1 | v1-subagent，team-checks.md 子 Agent 一节 #2 另记一行 |
| U32 | Task mode 的模型菜单里新加的两项怎么排（Background tasks 与 Customize › Agents 各加一项） | 照现在渲染的顺序：Task mode 一行、它的失败说明、See background tasks（有需求或 Task mode 开着时）、Manage agents、Manage models | 照现在 | v1-bg-tasks 记录 #10，defaults.md；TB-38 与 AG-08 断言这个顺序 |
| U33 | TaskBoard TB-18 证据分隔线只在单元层（forced.test.mjs）测，没有界面用例（Task mode 覆盖补测） | 1 照规格的层（单元），不加界面用例；2 加界面用例 | 1 | wt/cov-taskmode 记录 |
| U34 | tb-app-stop 用 --only 跑时跳过整套才有意义的 TB-34 门槛（同 tb-app-flow 已有的做法） | 1 照 tb-app-flow 跳过；2 --only 时也查 | 1 | wt/cov-taskmode；整套在推送前的完整回归里查 |
| U35 | WP-09 改过的真实层检查（m3-real 走查 2、m6-real 走查 8）与 WP-14 改过助手的 m1/m2/m4/m6/mem-real | 1 推送前跑 m3-real --only 2 与 m6-real --only 8（检查本身改了）；其余真实套件只改了界面助手，同样的助手在完整回归的 App 套件里跑到，记明不跑真实层的理由；2 全跑真实层 | 1 | 本轮记录 |
| U36 | 合并 app-v0 之后：Background tasks 的只读会话把 task 实例与结案会话收到的 `[Mori]` 投递照原文显示（boardText.ts 的 `DELIVERIES`、`forcedHead`、`USER_ANSWERED`，原来按“只给模型看”标了撇号照原样）。这些投递要不要按 U30 改成 ’ | 1 仍算发给模型的文字，照原样，只改标记的注释（同 Claude 把子 Agent 收到的 prompt 原样显示；改了要真实模型走查与重录，旧会话照样是直撇号）；2 改成 ’，附录 A 原文、合成端点与 TaskBoard 用例一起改，回来后跑 tb-real | 1 | wt/cov-integration，WP-21.md“合并 wt/cov-taskmode 与 app-v0 之后” |
| U37 | 改 U36（lead 的跟进）：标了“撇号照原样”的文字按“会不会出现在 Background tasks 画出来的会话里”重新分。task 实例与结案会话收到的投递在那里显示为用户一侧的气泡，工作卡、system prompt、参数的 schema、立项与用户会话（`mori.wake` 隐藏）、临时提问、订阅、增强会话不显示 | 1 显示的改成 ’、去掉标记，从不显示的留标记；2 照 U36 一律不改 | 1：`USER_ANSWERED`（`see User’s words.`）与强制填写的结案一行（`you didn’t decide`）改成 ’；`DELIVERIES` 去掉整个对象的标记，只在 `ask`、`create_unavailable` 两个属性前标；其余 20 处照原样（标记现在 22 处）。规格 §7.5、§8.5 两句原文与单元、合成端点自检、`tb-app-handoff` 的期望跟着改 | wt/cov-integration，WP-21.md“跟进”一节 |
| U38 | memory 工具的说明（记忆规格附录 A.2）也显示在 Customize › Tools，里面两处用作引号的直双引号要不要改 | 1 改成 “ ”（给人看的文字，ui-strings.md 写法约定），JSON 与代码的引号不动；2 照原样 | 1：`memoryText.ts` `AGENT_DESCRIPTION` 与附录 A.2 一起改，MEM-12 加断言没有直引号 | wt/cov-integration，WP-21.md“跟进” |
| U39 | 模型看到的文字变了几个字符（memory 与 subagent 的说明、两句投递）：真实模型走查与重录怎么做 | 1 推送前的完整回归加跑 `tb-real --only approval` 与 `mem-real --only dialog`（`--source C:\Users\blue\AppData\Local\Temp\mori-real-data`，脚本复制它，不读 key），不重录（没有回放检查断言这些字）；2 跑全部真实套件并重录 fixture | 1 | wt/cov-integration，WP-21.md“跟进” |
| U40 | 长度上限进 `npm run check`（`tests/limits.mjs`）时怎么数：函数的行数、入参个数、查哪些文件 | 1 函数从开头（不含上面的注释）数到最后一行，里面的注释与嵌套函数都算；解构对象、剩余参数各算一个入参；查 `app/src`、`app/tests` 的代码文件（.ts .tsx .mts .mjs .js .cjs .jsx .css .html），不查 `tests/fixtures` 和 `node_modules`、`.tb-runs`、`test-results`、`out`、`dist`，.md/.json/.txt 不查；2 只数函数体里的代码行，或连文档与数据文件一起查 | 1 | wt/cov-integration，`tests/limits.mjs` 与 `tests/unit/limits.test.mjs`，WP-21.md“长度上限进 npm run check” |
| U41 | m4/m5/m6-record 的 `installRecorder` 超过 50 行，它经 `page.evaluate` 整个送进页面，不能拆成文件里的帮助函数 | 1 等待的方法原样移到第二个注入的函数 `installWaits`（`Object.assign` 到同一个 `window.__rec`），`startMori` 接着注入；2 把方法体压紧（例如 try/catch 改成 `.catch`），行为可能有细微差别 | 1 | wt/cov-integration，同上 |
| U42 | 推送前完整回归（m0–m2 组）：会话锁屏时（负责人不在，LogonUI 在运行，WTS 会话标记为锁定）Windows 拒绝所有进程打开剪贴板（PowerShell `Set-Clipboard` 同样报 "Requested Clipboard operation did not succeed."），`m1-app` 的“复制代码”读回空串、detail 也是空的。以前的做法是解锁后重跑（english-ui-checks.md 第二轮），无人值守时解不了锁 | 1 检查前先经主进程写一段文字再读回：读不回且 LogonUI 在运行时记 KNOWN（这台机器此时造不出的环境，detail 写明），读不回却没锁屏时照样记失败，读得回时断言不变；未验证项写进 regression.md，解锁后重跑 `m1-app --only copyCode`；2 一直记失败，等负责人解锁 | 1 | wt/cov-integration，`tests/ui/lib.mjs` `clipboardBlocked`、`m1-app.mjs` `copyCode`，docs/v1/walkthrough-1026/regression.md m0–m2 一节 |
| U43 | 推送前完整回归（m6 组）：Customize › Instructions 的“重新读取失败”一行说“项目一栏读到过跟随的会话的列表时留着，还没读到时整栏不显示”。后台进程 `Restart` 后，跟随的会话如果有消息，会从会话文件重新打开、pi 会话 id 不变；Restart 之前读到的那份列表算不算“读到过”（界面现在按 pi 会话 id 认：算，重新读取失败时列表留着）。`m6-app-settings` 的检查“Restart 后重新读取失败……没读到这个会话的项目文件，项目一栏不显示”只在 `--only` 时成立（那时跟随的会话没有消息，Restart 后新建、id 换了），整套时 S1 有消息就失败 | 1 照现在的界面：同一个 pi 会话读到过就留着（与“重新读取失败”时留着读到过的用户级内容一致）；测试另开一个没有消息的会话去造“没读到”的情形，并断言它确实是新建的；2 改界面：Restart 之前读到的一律不算，重新读取失败时都不显示项目一栏 | 1 | wt/cov-integration，`tests/ui/m6-app-settings.mjs` `exitRereadFailure`（`b908a8d`），docs/v1/walkthrough-1026/regression.md m6 一节 |
| U44 | 推送前完整回归（m6 组）：tools.md“按了开关”写“之后新建的会话（含重启后重新打开的会话）里它是 Enabled”（WP-08 替负责人定的第 1 条，理由写的是“pi 在建会话时选默认工具”）。实际上 pi 1.3.0 打开有记录的会话时按记录恢复当时启用的工具（`_restoreToolsFromTranscript`），不看现在的 `defaultTools`；Mori 原来只补扩展的工具。`m6-app-tool-switches` 的 `reopen`（集成时第一次跑）因此失败：重启后重新打开的旧会话里 ls、grep、find 仍是 Not enabled | 1 照状态表改 Mori：从会话文件打开用户会话时，内置工具换成现在的设置选出的（开和关都算，换了时排在前面，同新会话的顺序），别的工具照恢复的留着、再补扩展的工具，和恢复的是同一组时不动；登记临时默认值；2 改状态表：重新打开的会话照 pi 恢复当时的工具，开关只管新建的会话 | 1 | wt/cov-integration，`app/src/kernel/defaultTools.ts` `reopenedTools`、`sessions.ts` `refreshTools`，单元 `tests/unit/defaultTools.test.mjs`，docs/v0/defaults.md，regression.md m6 一节；发给模型的工具只在“重新打开的会话的内置工具和现在的设置不同”时变，没有录 fixture、没有跑真实模型（理由见 regression.md） |
| U45 | 推送前完整回归（记忆组）：记忆规格 §14.4 写 MEM-35 的 App 层跑 `tb-app-*`，`v1-models-existing.mjs` 的 `TB_APP_SUITES`（注释写“与 test:taskboard 的顺序相同”）却只到 `tb-app-misc`；Background tasks 合进来时 `test:taskboard` 加了 `tb-app-tasks`、`tb-app-tasks-owner`，这张列表没跟上。`tb-app-*` 写的时候还没有这两个，要不要算进去 | 1 算进去：照规格的 `tb-app-*` 与 `test:taskboard` 的顺序加在最后（MD-15 经 MEMORY_LISTS 也跟着跑）；2 只跑原来的 9 个，规格改成列出这 9 个名字 | 1 | wt/cov-integration，`app/tests/ui/v1-models-existing.mjs`（`5039944`，见 regression.md 记忆组）；`--id MEM-35 --only tb-app-tasks,tb-app-tasks-owner` 两项都通过 |
| U46 | 推送前完整回归（真实模型组）：`tb-real --only approval` 的 TB-37“running 行等于实例最近一次工具调用的标题”要求至少核对 1 行 running。这一次 DeepSeek 在合并会话登记需求的那一段里 `task_create` 之后接着调 `board_read` ×3、`read_session`、`reply_via_dialog`，直到 T1 做完才结束那一段；进展摘要按 team-stream.md“位置”要等那一段结束（`mori.progress`）才显示，出现时 T1 已经停了，界面上从来没有 running 行（核对 0 行，标题都对）。§17.1 说模型怎么做只写进 note、前提没满足时最多重跑 2 次，没说“没有样本”算什么 | 1 记 KNOWN（模型的做法）：没看到 running 行、而每个需求的摘要第一次出现时它的每个 task 实例都已经停了时，detail 写明两个时刻与那一段里对话调用的工具；标题不对、没有摘要、摘要出现时还有实例在跑却没看到 running 行照样失败；不重跑（approval 驱动要的批准卡已经有了）；2 当作驱动的前提没满足，换新项目重跑最多 2 次，仍没有就失败 | 1 | wt/cov-integration，`app/tests/ui/tb-real.mjs` `progressChecks`、`tb-real-helpers.mjs` `lateSummary`（`39c69c6`）；重跑 10/10（TB-37 核对 3 行 running）；docs/v1/walkthrough-1026/regression.md 真实模型一节 |

合并 finish check 与文件系统时按推荐定的（2026-10-27，`wt/cov-integration`；规格冲突时照较新的、负责人批过的规格，临时默认值登记在 docs/v1/defaults.md“合并 finish check 与文件系统”一节）：

| 编号 | 问题（出处） | 选项 | 定的 | 落在哪里 |
| --- | --- | --- | --- | --- |
| U47 | 合并 finish check 与文件系统两条线（2026-10-27）：FC-28、FS-115 两个汇总预设（`v1-models-existing.mjs`）只列它们那条线上的套件，不知道这条线后加的 `v1-models-app-reorder`、`sa-app`、`ag-app` 与 `test:sa-unit`、`sa-replay`、`test:ag-unit`（lead 的合并说明要求列上） | 1 两个预设都加上（`LINE_APP_SUITES`、`LINE_REPLAY_SUITES`），FS-115 建在 FC-28 之上；2 只跑原来的 | 1 | `app/tests/ui/v1-models-existing.mjs`，AGENTS.md 测试分层第 3 条 |
| U48 | AGENTS.md 测试分层两种写法：`origin/app-v0` 第 1 层是 `npm run test:min`，这条线是检查、构建、单元测试加 `test:quick` | 1 第 1 层 = `test:min` 扩到每条线的单元脚本（unit、tb、mem、md、sa、ag、fc、fs），改到界面或后台进程时再跑 `test:quick`；第 3 层加 `fc-*`、`fs-*`、`fc-replay`、`fs-replay` 与八份规格的 `spec-coverage`；命令表跟着改；2 照某一条线原样 | 1 | AGENTS.md“测试分层”“常用命令”，`app/package.json` `test:min` |
| U49 | `finish` 工具的说明在 Customize › Tools 显示，里面 `Mori's` 是直撇号；检查的几行只给模型看 | 1 说明改成 ’（ui-strings.md 第 12 条），检查的几行标“撇号照原样”；2 都照原样 | 1 | `kernel/finishCheck.ts`、`shared/finishCheck.ts`，finish-check.md 注 |
| U50 | 角色文件的 `tools`：文件系统去掉了角色的 `tools`（实例的工具由职责与 `limits` 定，file-system-permissions.md §8.6），这条线的 Customize › Agents（M20）表单有 Tools 一栏、普通模式 subagent 按角色的 tools 给工具 | 1 照文件系统：Customize › Agents 去掉 Tools 一栏、不再写 `tools:`，subagent 的工具同其他实例（`instanceTools`）；2 保留 `tools`（两种写法都要认，是兼容层） | 1 | `shared/roles.ts`、`kernel/roles.ts`、`roleFiles.ts`、`subagent.ts`、`ToolsAgentForm.tsx`、`ToolsAgents.tsx`；customize-agents.md、subagent.md、平行 Agent 规格的注 |
| U51 | 只读 subagent（`read_only: true`）原来靠裁掉工具做到只读，文件系统去掉了裁剪 | 1 工具同通用的，收窄 `{ write: false }`（`PROGRAM_LIMITS`），改文件和命令在路径闸被拒绝；2 只给只读 subagent 留裁剪 | 1 | `kernel/subagent.ts`，subagent.md、subagent-card.md 注，SA-05 的真实层断言改为“被收窄拒绝” |
| U52 | `finish` 与 `subagent` 算不算按职责给的工具（`DUTY_TOOLS`，路径闸不管）；关闭模式下 subagent 与 M22 的回看工具由谁启用 | 1 都算职责工具；关闭模式由 `applyDutyTools` 启用 `subagent`（增强会话没有）和看过板时的 `board_read`、`read_session`；2 当作普通工具过路径闸 | 1 | `kernel/pathGate.ts`、`team.ts`，file-system.md、subagent.md、平行 Agent 规格的注 |
| U53 | 文件系统的文字（`RELAY_ONLY`、协作模式对话与合并会话的说明）还写 team mode、`/team` | 1 照这条线的 Task mode 改名（WP-10）改成 Task mode、`/task`；2 照原样 | 1 | `shared/workspace.ts`、`boardText.ts`，file-system.md 注，单元断言 |
| U54 | Background tasks 的 task 行 `· Read-only` 原来看 task 的 `read_only`，文件系统去掉了这个字段 | 1 `limits.write === false` 算只读；2 去掉这个标记 | 1 | `kernel/teamView.ts`、`shared/team.ts`，team-tasks.md 注 |
| U55 | Customize › Tools 上 `finish` 与 `ask_user_question` 的说明（两条线都没写） | 1 写 "Mori turns this on for the agent you talk to."（同 subagent 那句的写法）；2 不写说明 | 1 | `ToolsBuiltin.tsx`，tools.md 注 |
| U56 | 文件系统拒绝打开工具被旧版本收窄过的旧会话；这条线 WP-08 让重新打开的会话的内置工具按现在的开关换（`reopenedTools`） | 1 拒绝只看现在的默认工具里旧版本会收窄掉的 `bash`、`edit`、`write`，之后照 `refreshTools` 换；2 照文件系统看全部默认工具（开关打开 ls、grep、find 之后旧会话都打不开） | 1 | `kernel/sessions.ts`，file-system-permissions.md 注 |
| U57 | 右栏的 `Changes made by other agents aren’t listed here.`（`BoardView.teamEdited`）：文件系统的 Changes › This session 按快照列出每个 Agent 改的文件 | 1 去掉 `teamEdited` 与那句说明；2 两样都留 | 1 | `kernel/team.ts`、`teamView.ts`，subagent.md、subagent-card.md 注，`tb-app-misc`、`sa-app` 的断言 |
| U58 | 右栏顶部：这条线的 Changes / Background tasks 页签、Expand，文件系统的 Changes 视图有自己的标题与 Refresh | 1 用这条线的页签那一行，Changes 选中时右边加 Refresh，文件系统的视图不再画自己的标题（`tabbed`）；2 两行都留 | 1 | `ChangesPanel.tsx` |
| U59 | Customize › Agents 在 worktree 会话里读写哪个 `.mori/agents` | 1 主文件夹（`projectFolder(cwd)`，同文件系统的项目设置）；2 worktree 里的 | 1 | `kernel/roleCommands.ts`、`roles.ts`，customize-agents.md 注 |
| U60 | 文件系统新加的文字里的直撇号（问用户的说明、away、`.work`、limits、快照） | 1 用户看得到的改成 ’，只给模型看的标“撇号照原样”（同 U30、U37）；2 照原样 | 1 | `askQuestion.ts`、`away.ts`、`limits.ts`、`workspace.ts`、`snapshots.ts`、`approval.ts`，file-system.md、file-system-permissions.md 的原文 |
| U61 | `fs-app-away` 的 FS-78、FS-79 在收尾检查之后要一个“检查之后还要再自动处理一次”的场景和推迟检查回应的办法，收尾检查规格没有 | 1 合成端点加 `fc-away-once` 场景与 `fc-check-wait:<毫秒>` 标记，写进收尾检查规格 §14.1；2 改 FS-78、FS-79 的断言 | 1 | `tests/fake-endpoint`，finish-check.md §14.1 注（没有新的界面或给模型的文字） |
| U62 | 两条线的界面套件端口重了（文件系统 4950–4983，这条线 tb-app-tasks、ag、sa、fc 占 4950–4979） | 1 文件系统的套件挪到 5000–5019（fs-app-* 5000–5015，真实层记录代理 5016）；2 挪这条线的 | 1 | `tests/ui/fs-helpers.mjs` `FS_PORTS`、`fs-real-setup.mjs`，defaults.md 一行，fs-checks.md |
| U63 | spec-ids 只认真实层驱动 `fs-real.mjs` 的结果文件，文件系统的真实层检查写在 `fs-real-setup.mjs`、`-perm`、`-team`、`-wt` 里 | 1 `<真实层文件名>-*.mjs` 的模块也算真实层（它们由那个驱动加载、结果写进同一个文件）；2 把检查名搬回 `fs-real.mjs` | 1 | `tests/unit/spec-ids.test.mjs` `layersOf` |
| U64 | `test:quick` 的 `tb-replay --only tb-team` 失败：文件系统把 Allow all 换成 Full access（`approval.setMode` 的 `all` 改 `full`），fixture 还是旧的；文件系统规格把 tb 的四个 fixture 都列为要重录，fs-checks.md 记着没录 | 1 快速集用的 `tb-team` 现在用真实模型重录（DeepSeek、GLM，`--source %TEMP%\mori-real-data`，脚本只复制加密文件），其余（`tb-ask`、`tb-receipts`、`tb-approval`、`stop-task`、sa 与 m2–m6、mem 的旧 fixture）仍是文件系统那一包没做完的项（fs-checks.md“没跑到”）；2 现在全部重录；3 回放时把 `all` 当作 `full`（兼容层，不做） | 1 | `tests/fixtures/tb/tb-team.json`（一次录成，扫过没有 key），`tb-replay --only tb-team` 19/19；2026-10-28 `wt/fix-replays` 重录 m2–m6 的十九个、mem 四个与 finish 六个合成 fixture（见 fs-checks.md“重录旧 fixture”）；2026-10-28 第二阶段 `wt/readonly-tools` 在 U71 之后用真实模型重录 tb 的五个（`tb-ask`、`tb-team`、`tb-receipts`、`tb-approval`、`stop-task`）与 `sa-subagent`（DeepSeek，reviewer 用 GLM；每个一次录成，扫过没有 key），`tb-replay --only` 五个与 TB-03 十个、`sa-replay --only sa-subagent` 通过，`tb-real` 的 ask、team、approval、stop、lookback 与 `sa-real` 的 read、command 也走过（见 fs-checks.md“第二阶段：真实层与重录（2026-10-28）”的 tb、sa 部分）；`fc-a-real`、`fc-b-real` 与 fs-real 的 away 提醒见同一节其他组的部分；2026-10-28 第二阶段 `wt/fix-replays` 又重录了 `fc-a-real`（DeepSeek）、`fc-b-real`（Qwen）与 `filesystem/away-reminder`（DeepSeek）；2026-10-28 `wt/claude-perms` 在 U73（照 Claude 的做法改权限）之后又重录了 41 个：m2 九个、m3 三个、m4 三个、m5 两个、m6 三个与 filesystem 三个（DeepSeek），tb 五个与 `sa-subagent`（DeepSeek，reviewer 用 GLM），`fc-a-real`（DeepSeek）、`fc-b-real`（GLM），以及 finish 六个与 mem 四个合成 fixture。每个都扫过，没有 key；回放都用 `--only` 通过；`tb-real` 的 ask、approval、stop、lookback、team，`sa-real` 的 read、command 与 `fs-real --only team-limits` 也走过（见 fs-checks.md“照 Claude 的做法改权限（2026-10-28，U73）”的“重录与真实层”）；2026-10-28 `wt/catchup-fix` 在 U74（分开时立项不再收到重复的你的消息）之后查过 fixture：`tests/fixtures/` 141 个录制里带 `holders` 的 45 个都是合并会话，里面没有分开时立项的投递，也没有 `Conversation since your last turn`、`mori.create_cursor`，所以没有要重录的。真实层走了 `tb-real` 的 team、catchup（12/0/0；catchup 另查了代理转发给模型的立项请求，7a1244a），以及 `fs-real` 的 team-limits（8/0/0）、ask-split（第一次 4/2/0，对话改写了推荐项的写法，属于模型的做法；重跑一次 8/0/0）。见 fs-checks.md“立项的对话不再重复你的消息（2026-10-28，U74）”的“重录与真实层” |
| U65 | 合并之后 `tb-app-tasks` 的 TB-80、TB-87 还找右栏标题 “This session’s changes”：文件系统把没有页签时右栏的标题改成了 `Changes`（file-system.md §5.1、ui-strings.md 第 98 行），TaskBoard 规格 TB-80 那一行、§13.13.1 与 docs/v1/screens/team-tasks.md 第 29、30 行还引着旧标题，`tabs` 的 TB-80 查右栏文字里没有旧标题、合并后总是通过（诊断 #27、审查） | 1 照文件系统：没有页签时右栏只有 `Changes` 一个标题，有页签时改动视图没有自己的标题行；TaskBoard 规格与状态表加 2026-10-28 注，测试改为看 `Changes` 与 `.changes-header`；2 没有 TaskBoard 的会话留着 “This session’s changes” | 1 | `tests/ui/tb-app-tasks.mjs` `plain`（TB-80、TB-87 改名）、`tabs`（TB-80 改查没有 `.changes-header`、只有页签那一行），parallel-agents-taskboard.md TB-80 一行与 §13.13.1 注，team-tasks.md 第 29、30 行注，file-system.md §19.4 “用到 `Toggle changes` 的套件”一行注，team-checks.md 第 292 行注，defaults.md 一行 |
| U66 | TB-88 读负责人 2026-10-26 Har-GUI 那次的 `board.json`：task 带 `readOnly`、没有 `limits`，按 file-system-permissions.md §8.8（负责人 2026-10-26：“我们不做兼容，就是打不开”）这个会话打不开，`tb-app-tasks-owner` 三步都等不到界面（诊断 #29） | 1 测试只把复制到临时数据目录的那份转换（`readOnly: true` → `limits: { write: false }`，否则 `limits: {}`），产品照旧不写转换代码；2 TB-88 改为断言 §8.8 的拒绝；3 负责人在合并后的构建上另录一段 | 1（负责人 2026-10-28 定） | `tests/ui/tb-app-tasks-owner.mjs` `convertCopiedBoard`，parallel-agents-taskboard.md TB-88 一行注，file-system-permissions.md §8.8 注 |
| U67 | 2026-10-28 修合并后的失败（`wt/fix-fsfc`）：`fc-app-team` 的 FC-10 要关闭模式的检查请求里“没有工作卡”（finish-check.md §6.4、FC-10 写在 M22 合进来之前）；M22 之后关闭模式下 TaskBoard 上有需求（含已关闭的）的用户会话每次请求都带关闭模式的工作卡（“Task mode: off”，平行 Agent 规格 §6.3、§8.3），检查那次请求也一样 | 1 照负责人批过的 M22：卡留在检查那一行之后、最后一条（同打开时），finish-check.md §6.4 表下与 FC-10 加注，模型看到的不变；2 检查请求不带关闭模式的卡（改实现，模型看到的变） | 1 | `app/tests/ui/fc-app-team.mjs`（`OFF_MODE_LINE`、`offCard`），finish-check.md §6.4 表下的注与 FC-10 的注 |
| U68 | 文件系统规格 §19.4 两行冲突：`m4-replay` 一行的前提是 `m4/edit-two.json` 里没有 `mori.turn_changes`（edit-two 点 `Toggle changes` 查说明）；m3–m6 一行与 §0“载荷变了的录制重录，不给它们补默认值”要求在新构建上重录 edit-two，新录制带 `mori.turn_changes`（结束快照在 `agent_settled` 时排队，录不录得到看先后，`m4-record` 现在等到它再停）。旧录制回放时页面报 `approval.targets.slice` 的错，给它补默认值是 §0 不许的兼容层。诊断原记作 U65，lead 改编为 U68。问负责人：照 1 做对不对 | 1 照录下的 `mori.turn_changes` 查 FS-12：不点 `Toggle changes`，右栏自己打开到 Changes，This session 列出的正是录下的文件，§19.4 的 `m4-replay` 一行加注；2 照旧点 `Toggle changes` 查说明，另录一份没有 `turn_changes` 的 | 1（待负责人复核） | `tests/ui/m4-replay.mjs` `editTwo`、`m4-record.mjs` `turnChanges`，file-system.md §19.4 注 |
| U69 | `m5-replay` 的右栏跟随焦点原来给两栏各注入一条 synthetic 的 `mori.turn_changes`（README.md、notes.md）；重录的 split-approvals 里两个会话同在一个文件夹、同时运行，录下的 `mori.turn_changes` 两边都列出两栏改的文件（FS-11 overlap），用这两个名字分不出右栏跟着哪一栏 | 1 synthetic 记录改用录制里不会有的 `synthetic-left.md`、`synthetic-right.md`，查焦点那一栏的在、另一栏的不在；2 改 `m5-record`，两栏用两个文件夹重录 | 1 | `tests/ui/m5-replay.mjs` `rightPanelFollows` |
| U70 | `fc-b-real.json`（FC-12 的真实回放）要真实模型在检查之后再做一次事，第二阶段的 `fc-real` 不一定录得出 | 1 录不出 b 时删掉 `fc-b-real.json`，FC-12 靠合成的 `fc-b` 与单元层（`fc-replay` 没有真实录制不算失败）；2 一直重跑到录出为止 | 1（第一阶段只登记，第二阶段照做）（2026-10-28 第二阶段：录出了 b（Qwen），`fc-b-real.json` 重录，选项 1 的删除没有用上） | `tests/fixtures/finish/fc-b-real.json`、`tests/ui/fc-real.mjs`（2026-10-28 U73 之后：`fc-b-real.json` 用 GLM 重录（`--source` 的数据目录没有 OpenRouter，第一次检查是 b），删除仍没有用上） |
| U71 | 只读的会话给什么工具（负责人 2026-10-28：“regroup tools so mori's read only task grant the agent with same tools as claude”，grep、find 选 “grep/find only if installed”；诊断 #4 问的 M13“只读助手总有 ls”也由这一条回答，没有另开 U65） | 1 照 Claude 的只读 Agent（Explore、Plan）：`read`、默认工具里的命令工具只跑只读命令、装了 `rg.exe`/`fd.exe` 时加 `grep`/`find`、没有 `edit`/`write`；2 照 U51 不裁工具、按调用收窄（只读命令也拒绝）；3 照 M13 给每种实例加 pi 的 `ls` | 1（负责人定的只是工具的分组）。（2026-10-28 U73 代替 b、d 里的 `> NUL` 与变量、e、f、i：负责人定照 Claude 的做法，只读会话的命令不再按收窄拒绝，只读命令在每种会话免批准，见 U73。）下面的细节按推荐定，是临时默认值（登记在 defaults.md），待复核：a 只读会话＝收窄的 `limits.write` 为 `false` 且不是对话会话（`write: false` 的 task、分开时的立项、结案、临时提问（含 `read_only: true` 的 subagent）、订阅，增强会话的 Team 里同种实例也算；用户会话、协作模式的对话、增强会话本身不算）；b 只读会话里的只读命令免批准（路径闸第 4 步 `free`，不论权限模式，不出卡），所以只读 subagent 仍“从不等批准”；c “装了”＝`<agentDir>\bin` 或 PATH 的某一项里有 `rg.exe`（`fd.exe`）这个文件，每次建、打开实例时查，不起进程、不下载（2026-10-29 U76：Mori 随程序带这两个程序、放在后台进程的 PATH 最前面，总算装了，只读会话总有 `grep`、`find`）；d 只读命令＝§7.7 的只读名单加四条（分析成功、没有认出的写入、每条简单命令都在名单里、PowerShell 的 .NET 调用不算）。不算只读的 .NET 调用有四种：成员的方法调用（成员名可以是名字、引号里的字符串、`$变量`、`${…}`、`$(…)`、`(…)`、`@(…)`、`{…}`；`.`/`::` 之后可以隔空白、换行、续行和注释；紧跟 `(` 或 `{`）、给成员赋值（`=`、`+=` 等，属性的 setter 会改文件属性）、类型转换 `[类型]值` 与 `-as`（会调构造函数，`[IO.StreamWriter]'a.txt'` 会建文件）、`ForEach-Object` 按成员名调用。这些按文字找，引号里的也算。`> NUL` 算写入，`/dev/null`、`2>&1`、`$null` 不算。`hash` 只有没有参数时在名单里（`hash -p /bin/rm ls` 让之后的 `ls` 跑 `rm`）；e 拒绝原文 `<开头>: only read-only commands.`，`limitsText` 的 `write: false` 为 `no file changes; only read-only commands`；f 给模型的文字按 file-system.md §14 的 2026-10-28 注，协作模式对话段、合并会话立项段、身份段、subagent 工具的说明不变；g `read` 总有，你在 Built-in tools 打开的 `ls`、`grep`、`find`、`powershell` 照有；h 测试：真实层（fs-real-team、tb-real）用内核的 `scanVerdict` 判断只读命令。tb、sa 的 App 套件按测试进程的 PATH 算 `grep`、`find`（tb-helpers `READ_ONLY_FILE_TOOLS`）。fs-app-team 启动 App 时，PATH 去掉含 `rg.exe`、`fd.exe`、`fdfind.exe` 的目录（tb-helpers `withoutSearchPrograms`，从 m6-app-tool-switches 搬来）。FS-116 在 `<userData>\pi\bin` 放一个空的 `rg.exe`（synthetic），所以多出的 `grep` 只能来自 `<agentDir>\bin`，也查得到没有多出 `find`（2026-10-29 U76 改：`READ_ONLY_FILE_TOOLS` 总有 `grep`、`find`，FS-116 不再放 synthetic 的 `rg.exe`，测试进程 PATH 里的这两个程序仍去掉，请求里的 `grep`、`find` 只能来自 Mori 带的）；i 命令里设的环境变量（`GIT_EXTERNAL_DIFF=… git diff`、`LESSOPEN`、PowerShell 的 `$env:…`）和改 `PATH`（`PATH=… ls`、`export PATH=…`）能让名单里的程序跑别的程序：记为 §8.11 的已知限制，不拒绝（拒绝就得拒绝名单里的 `export`、`set`；§7 开头说明路径闸不是沙箱）。2026-10-28 审查后补了 d 的方法调用、赋值、转换与 `hash`，h 的 PATH 处理，加了 i | file-system-permissions.md §8.11（新）、§7.7 末尾与 bash 名单的 `hash`、§7.2、§6.1 与 §8.2–§8.9 的注；file-system.md §14、FS-48、FS-116–FS-119、FS-57/58/59/60/64/67 的注、§19.4（含 TB-45 一行）；平行 Agent 规格 TB-04、TB-24、TB-33、TB-45、§17.1、附录 A 与正文三处注；subagent 规格 SA-05、§6.1；`commandScan.ts`、`commandScanBash.ts`、`commandScanPs.ts`、`pathGate.ts`、`limits.ts`、`approval.ts`、`roles.ts`、`defaultTools.ts`、`team.ts`、`teamHost.ts`、`sessions.ts`、`boardText.ts`、`boardTools.ts`、`subagent.ts`；`wt/readonly-tools` 32e236f–9904089 |
| U72 | MP-40 换成哪两个模型（负责人 2026-10-28：“MP-40 pick a different models”；免费的 flint、lfm 在 2026-10-28 三次真实运行里一直 429 上游限流，见 regression.md“还开着的”第 1 条的注） | 1 第一个 `minimax/minimax-m3.1-flash`、第二个 `liquid/lfm-2.5-24b-a2b`（实测：第一个 4 组都 `ready`、最多 68 token；第二个 4 组第 6 步都停在输出上限）；2 两个位置都用最便宜的 `openai/gpt-oss-20b`（第 6 步 3 组里 1 组停在上限，做第一个时档案会是 `error`）；3 第二个用原来模型的付费端点 `liquid/lfm-2.5-2.6b`（要先改 OpenRouter 账户的数据设置，现在每个请求都是 404 Paid model training violation） | 1（推荐，待负责人复核；通过条件不变） | 规格 §7.7 末尾（2026-10-28 实测）、§14.1、§14.2 MP-40 与开头的补丁说明；`tests/ui/v1-real-helpers.mjs` `NO_OFF_MODELS`、`tests/ui/v1-models-real.mjs`；models-checks.md“思考关不掉的模型：换模型”；defaults.md 一行；`wt/mp40-models` 25da102、5628cdf、d1742f5 |
| U73 | 工具权限的未决问题（U71 按推荐定的细节；“`write: false` 的 task 拒绝 `node --version`”）。负责人 2026-10-28：“follow claude's design on tool permission related issues” | 1 照 Claude 的做法：只读会话只去掉 `edit`、`write`，命令不按收窄拒绝、照常走路径闸（Ask each time 出卡，Full access 执行，不能问的会话拒绝）；只读命令在每种会话、每种权限模式下免批准；只读命令的判断照 Claude 改 `PATH`/`IFS`、开头赋值与空设备重定向；2 保留 U71：只读会话只跑只读命令、其余拒绝，只读命令只在只读会话里免批准 | 1（负责人 2026-10-28 定：照 Claude 的做法）。下面的细节按推荐定，是临时默认值（登记在 defaults.md），待复核：a 只读会话的范围同 U71a；协作模式对话会话的 `RELAY_ONLY`、`commands: false`、`write_paths` 照旧拒绝；`write: false` 不再去掉 `commands: false`，临时提问继承发起方的 `commands: false`；b 只读命令在路径闸第 4 步 `free`，不出卡、不标 `Full access` / `Allowed for this session`；停止时仍拒绝，`.work` 照旧先准备；只读 subagent 不再“从不等批准”，跑不是只读命令的命令时出卡头 `Mori · <description>` 的后台卡；c 设值仍算只读命令的变量为 `LANG`、`NO_COLOR`、`NODE_ENV`、`TZ` 与以 `LC_` 开头的（Claude 没有公开完整名单）；动 `PATH`、`IFS` 的写法见 file-system.md §17；PowerShell 的 `> NUL` 不算写入（同 `$null`），Git Bash 的 `> NUL` 仍算（这台机器上实测会建名为 NUL 的文件）；d 给模型的文字：`limitsText` 与 `limits.write` 为 `no file changes`，`<开头>: only read-only commands.` 去掉，`edit`、`write` 为 `<开头>: no file changes.`，subagent 工具说明第二行与 `read_only` 参数的 “never waits for the user’s approval” 改为 “can’t change files”，其余段、投递、`MARK_LINE`、身份段不变（file-system.md §14 的 2026-10-28 又注）；e U71b、U71d 的 `> NUL`、U71e、U71f、U71i 由这一条代替。审查（2026-10-28）发现的写法（用别的写法设值再导出、`set -a`、`$[…]`、PowerShell 给提供器变量赋值、`git -c`、`git grep -O`、`rg --pre`）已补成不是只读命令（§7.7 末尾“审查后补”，FS-124，e25a4dc）；其中 git、rg 的几条与“像环境变量”的名字判断是推荐；`sed` 照 Claude 的只读集不算只读命令；结案会话自己的验证命令照常出卡（卡头 `Mori`） | `app/src/kernel/approval.ts`、`limits.ts`、`commandScan.ts`、`commandScanBash.ts`、`commandScanPs.ts`、`boardTools.ts`、`subagent.ts`、`teamTypes.ts`；file-system-permissions.md §6.1、§6.7、§7.2、§7.5、§7.7、§8.2–§8.11，file-system.md §14、§17、§19，parallel-agents-taskboard.md TB-04、TB-09、TB-24、TB-33、TB-45，subagent.md SA-05、SA-12、SA-15、§3.1、§5.3、§6.1，docs/v1/screens/fs-permissions.md、subagent-card.md；重录 41 个 fixture 与真实层见 fs-checks.md 同一节的“重录与真实层”；测试的改动：`m6-record.mjs`、`m6-replay.mjs` 的 slash 模板（接 `| tee` 的命令出卡），`fs-real-team.mjs` 的 FS-67 归一（`write: false` 照留 `commands: false`），`fc-real.mjs` 只选 record 时不记界面那一条；审查后补 e25a4dc（新模块 `commandScanVars.ts`） |
| U74 | 分开时立项下一次投递的“自上次投递以来的对话”（§8.4）又以 `User: …` 抄一遍它刚以 `[Mori] New user message:` 判断过的你的消息：带到哪里在投递时取（`team.ts` 的 `withCatchUp`），你的消息要等立项判断完才由对话写进用户会话（`teamFlow.ts` 的 `startFor`）。重复的消息费 token，也可能让立项再登记一次需求（合成端点就登记过：诊断 #10 的 Request 2、T2）；出处 team-checks.md“与规格不同”的 2026-10-28 一条、fs-checks.md“合并之后的失败修复”的“要负责人回答的”。负责人 2026-10-28：“fix it” | 1 对话写下立项已经收到的消息时，在立项会话里写 `mori.create_seen { entryId }` 指向它的条目，每次投递读出、这一段跳过它（对话的回复、关闭模式下与协作模式关掉期间的消息、判断没开始运行的消息照常带上）；2 同样的标记写在用户会话里；3 把带到的位置挪到那条消息之后（夹在中间的对话回复会丢） | 1（负责人 2026-10-28 定：“fix it”；用哪一种按推荐）。下面的细节按推荐定，是临时默认值（登记在 defaults.md），待复核：a 标记写在立项会话里、与 `mori.create_cursor` 同一个文件，两者一起留下、一起没有（立项会话新建时从头带上全部对话），用户会话不加条目，界面、Rewind、会话引用、原话核对都不变；b “已经收到”＝判断它的那次投递开始运行过（立项会话的 `agent_start`，含出错结束的），没能开始的（选不到模型、没能开始）照常带上；c 跳过的消息不算进 12000 字符与 `N earlier messages omitted`，它前后的对话回复仍分成两段；d 文字相同、一条收到一条没收到的两条消息被 pi 换了先后（插话排到排队之前）时可能标错一条，最多多抄或少抄一次。合成端点的 `stripCatchUp` 留着（这一段仍抄对话的回复和关闭模式下的消息），只改注释。另：`tb-app-modes` 的 `createDelivery` 原来取合成端点的 `info.last`，2026-10-28 加 `stripCatchUp` 之后它不再带这一段，TB-11 的四条 App 检查从那以后一直失败（那时没跑 `tb-app-*`），改为取这次请求最后一条 user 消息、去掉工作卡 | `app/src/kernel/teamFlow.ts`（`markReceived`）、`team.ts`（`withCatchUp`）、`boardText.ts`（`receivedMessageIds`、`createCatchUp`）、`entries.ts`（导出 `findEntryId`），`app/src/shared/team.ts`（`TEAM_ENTRY_TYPES.createSeen`、`CreateSeenEntrySchema`）；parallel-agents-taskboard.md §3、§5.3 第 5 步、§8.4、§14.2、§16、§17.1、§17.3 与 TB-11 注，新行 TB-60（单元、App、真实）；测试 `tests/unit/taskboard/text.test.mjs`、`flow.test.mjs`（含 Stop agents 一条）、`lifecycle.test.mjs`、`shared-team.test.mjs`、`spec-coverage.test.mjs`、`teamHarness.mjs`（`seedInstance`），`tests/unit/filesystem/team-ask.test.mjs`，`tests/ui/tb-app-modes.mjs`（`catchUp`、`restart`、`createDelivery`），`tests/ui/tb-real.mjs`（`catchup`，对话对第一条有文字回复是前提）与 `tb-real-helpers.mjs`，`tests/fake-endpoint/scripts.mjs` 注释；fs-checks.md“立项的对话不再重复你的消息”与上一节“要负责人回答的”后的注，team-checks.md 一条；`wt/catchup-fix` 5253bd0，评审之后 d91ffec（`tb-real` 的 catchup 没有回复时“带上回复”那一半不再算通过；`flow.test.mjs` 加 Stop agents 一条）；重录与真实层 7a1244a：`tb-real` 的 catchup 另查代理转发给模型的立项请求，`tb-real-helpers.mjs` 的 `chatRequests` 记下各条 user 消息。没有要重录的 fixture（都是合并会话）。`tb-real --only team,catchup`、`fs-real --only team-limits,ask-split` 走过，见 fs-checks.md 同一节的“重录与真实层” |
| U75 | 卸载旧版本、在同一位置装新版本后首次启动表单不出现，设置 → Models 停在 “Couldn’t read model settings”（旧的 `model-config.json` 还写着 M3 删掉的 `zone`、`allowedZones`、`projectZones`，按 §4.1 读不出；卸载程序本来不删 `%APPDATA%\Mori`）。负责人 2026-10-28：“fix my file first and when uninstall mori, those old setup file should goes away as well” | 1 卸载时删掉全部 Mori 数据；2 只删设置文件（`model-config.json`、`model-profiles.json`、`model-migration.json`、`credentials.json`）；3 卸载向导里问，默认保留 | 3（负责人 2026-10-28 定：“Ask in the uninstaller”）。读不出的旧配置照 M3 仍不写兼容代码，负责人本机的文件备份后去掉这三个字段。下面的细节按推荐定，是临时默认值（登记在 docs/v0/defaults.md），待复核：a 勾上时删整个 `%APPDATA%\Mori` 与 `%LOCALAPPDATA%\Mori`（同选项 1 的范围）；b 欢迎页之后单独一页，按钮写 “Uninstall”，第一次进来不勾；c 文字见 ui-strings.md “卸载向导”；d 为所有用户安装时删当前用户的 | `app/installer/uninstall.nsh`（新）、`app/electron-builder.yml` 的 `nsis.include`；docs/v0/screens/uninstall.md（新状态表）、README、ui-strings.md、defaults.md、app-v0.md 一条、AGENTS.md 测试分层第 4 条与命令表；测试 `tests/ui/uninstall.mjs`、`uninstall-ui.ps1`（`npm run test:uninstall`）；检查记录 docs/v0/uninstall-checks.md |
| U76 | 离线安装包里没有 `grep`、`find` 要的程序：Mori 让 pi 离线运行（`PI_OFFLINE`），pi 不下载 `rg.exe`、`fd.exe`，这台电脑和内网的电脑上都没有，Customize › Built-in tools 一直写 “Needs rg.exe in <agentDir>\bin or on PATH. Mori doesn’t download it.”，打开了也调用失败，只读会话按 U71 也没有 `grep`、`find`。负责人 2026-10-28/29：“we should include grep and find in offline installer” | 1 提交锁版本的程序（“Commit pinned binaries”）：ripgrep 15.2.0、fd 10.5.0（x64 Windows，GitHub release，核对 SHA-256）与许可提交在 `app/vendor`，安装包放进 `resources\bin`、`resources\licenses`，主进程把 `bin` 放在后台进程的 PATH 最前面；2 构建时下载（要联网，打包的机器上另锁地址与 digest）；3 照现在不带 | 1（负责人定：“Commit pinned binaries”；程序、许可与 `app/vendor/README.md` 由 lead 下载、核对 GitHub 公布的 digest 后放好）。下面的细节按推荐定，是临时默认值（登记在 docs/v0/defaults.md），待复核：a 只改环境变量副本里原有的 PATH 键（不分大小写，Windows 上常写作 `Path`），值前面加 `<bin>;`，没有时新建 `PATH`，不另建第二个（审查后补：`<bin>` 里有 `;` 时加双引号，pi 的 `grep`、`find` 与 `installedSearchTools` 认得，Git Bash 与 PowerShell 不认）；b `<bin>` 打包后是 `process.resourcesPath\bin`，开发与测试的构建是 `app\vendor\bin`（审查后补：`MORI_APP_DIR` 指向的单独构建由 `tb-build.mjs` 与两个故障拷贝另拷一份 `vendor\bin`）；c 文件夹不在时照样加、记一行错误日志；d `installedSearchTools` 照旧查（现在总找得到），所以只读会话总有 `grep`、`find`；e Built-in tools 那句 “Needs rg.exe …” 去掉，`grep`、`find` 同别的 pi 工具 | `app/vendor/`；`app/electron-builder.yml` `extraResources`；`app/src/main/kernelPath.ts`（新，`withBinOnPath`）、`kernel-process.ts`（`bundledBinDir`）；`ToolsBuiltin.tsx`；`kernel/defaultTools.ts` 注释；docs/v0/screens/tools.md “grep、find” 一行与几处注、ui-strings.md、docs/v0/defaults.md（作废一行、加两行）、docs/v1/defaults.md 两行、app-v0.md 三处、file-system-permissions.md §8.6 与 §8.11 的注、file-system.md FS-116、平行 Agent 规格两处与 subagent.md SA-05 的注、app/README.md、AGENTS.md 仓库结构；测试 `tests/unit/kernelPath.test.mjs`（新），`m0-smoke`（`--exe` 查 resources），`m6-app-tool-switches`（rows、reopen），`m6-app-tools`、`m6-tools-helpers`、`m6-replay`，`fs-app-team` 与 `fs-team-helpers`（FS-116），`tb-helpers` 的 `READ_ONLY_FILE_TOOLS` 与 `tb-app-ask`、`-flow`、`-roles`、`-sched`、`sa-app` 的检查名与注释；审查后补（同日）：`tests/ui/vendor-files.mjs`（新），`tb-build.mjs` 与 `mem-app-prompt`、`tb-app-roles` 的故障拷贝带上 `vendor\bin`，`uninstall.mjs` 查安装包装好的 `resources`，`m0-smoke` 在 Git Bash 里查 `command -v rg fd` 与两个版本，`kernelPath.ts` 与 `installedSearchTools` 处理带 `;` 的文件夹（单元 `kernelPath.test.mjs`、`defaultTools.test.mjs` 各一条），平行 Agent 规格 TB-04、TB-24，subagent.md 只读 subagent 两处，file-system.md §19.4 一行，本表 U22、U71 c/h 的注；检查记录 [walkthrough-1026/U76-U77.md](walkthrough-1026/U76-U77.md) |
| U77 | Customize › Built-in tools 打开一个工具的开关后，这一行仍写 “Not enabled”（跟随的会话里没有它）。负责人 2026-10-28/29：“once enabled, the title should be grey out rather shown: available on new sessions”。另：lead 查到规格写了没做到的一处：tools.md “按了开关” 说重启后重新打开的会话也按新的开关，`sessions.ts` 的 `refreshTools` 只把 `sourceInfo.path` 以 `builtin:` 开头的当内置工具，Mori 经 `customTools` 换掉的 `bash`、`powershell` 来源是 `sdk`（`<sdk:bash>`），重新打开的会话里打开 `powershell` 不加、关掉 `bash` 不去 | 1 灰色的 “Available in new sessions”（“Grey 'Available in new sessions'”）：pi 内置工具的开关开着、跟随的会话里没有它时状态写这一句；开关关掉而会话里还有它时仍写 “Enabled”；状态跟着显示出来的开关（按下时一起变，写入失败时一起回去）；2 照现在 | 1（负责人定）。`refreshTools` 照规格修，不是新行为：内置工具与工具页的来源用同一条规则 `isBuiltinTool`（`builtin:` 开头且不是 `builtin:mcp`，或来源是 `sdk`）。下面的细节按推荐定，是临时默认值（登记在 docs/v0/defaults.md），待复核：a 颜色用 `--color-faint`（同 “Not enabled”），类名 `next`；b 开关开着、新会话里也没有它时（没有 Git Bash 时 Mori 在内存里放 `-bash`，或受信任项目的设置去掉了它）仍写 “Not enabled”（`byDefault.heldOff`，与开关现在的样子无关，所以状态照旧跟着开关变；审查后改，审查前照字面写 “Available in new sessions”），要问负责人；c 不是 pi 内置工具的行没有开关，仍只有 Enabled / Not enabled。与 U56 的关系（没有改 U56）见检查记录“与 U56”，要问负责人：U56 分不出“旧版本收窄过”和“打开时没有 `bash`”，有两条路会让会话以后打不开——关着 `bash` 的开关重新打开、运行过的会话，以及不碰开关、在一次没找到 Git Bash 的启动里重新打开、运行过的会话（之后找到 Git Bash 时被拒绝，例如重装或升级 Git for Windows 之后）；U56 的规则要不要改（例如现在的默认工具与加上 `NO_BASH_TOOLS` 之后的默认工具都对不上时才拒绝）由负责人定 | `ToolsBuiltin.tsx`（`stateOf`、`RowFrame`）、`styles/tools.css` `.tools-state.next`；`kernel/defaultTools.ts`（`isBuiltinTool`、`refreshedTools`）、`sessions.ts` `refreshTools`、`resources.ts` `toolSource`；docs/v0/screens/tools.md 列表、开关、按了开关、写入中、写入失败与标识几行，ui-strings.md 状态一行，docs/v0/defaults.md 两行，app-v0.md §5.13 的注；测试 `tests/unit/defaultTools.test.mjs` 两条（真的 pi 会话），`m6-app-tool-switches` 的 turnOn、turnOff、writeFailure、reopen，`m6-tools-helpers`（`expectedState`、`toolRows`），`m6-app-tools` entry，`m6-replay` tool-switch，`m6-real`、`m6-record` 的检查名与注释；审查后补（同日）：`shared/protocol.ts` `DefaultToolState.heldOff`、`kernel/defaultTools.ts` `toolDefaults`、`kernel/shell.ts` `memoryDefaultTools`、`kernel/resources.ts` `defaultStates`、`ToolsBuiltin.tsx` `stateOf`，单元 `defaultTools.test.mjs` 一条（对照 pi 真实的 `SettingsManager` 与 `applyShell`），`m6-app-tool-switches` 的 turnOff 改按 `find`，tools.md 开关一行与“没有 bash 时”的注、defaults.md、ui-strings.md；检查记录同 U76 |
