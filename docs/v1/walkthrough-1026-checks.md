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
| WP-09 模型菜单里的 Task mode（界面文字） | M10、M21 | 否 | WP-05 | 待做 |
| WP-10 Task mode：模型读的文字、关掉后回看、角色边界 | M13、M21、M22、M26 | 是 | WP-09 | 待做 |
| WP-14 一轮结束后折叠步骤 | M18 | 否 | WP-10 | 待做 |
| WP-21 不留未完成项的规则与检查 | 回答 7 | 否（只改测试工具与 AGENTS.md） | — | 已合并（`f613281`，两次审查后 `531419c`） |

每包自己的检查记录写在 `docs/v1/walkthrough-1026/<包>.md`，包括按推荐定下的选择；本表在每包合并后更新。
（2026-10-26 补：模型层五包（WP-02、WP-03、WP-04、WP-15、WP-05）按回答 8 逐行补的用例在分支 `wt/cov-model-screens`，各包记录的
“状态表各行的用例”一节标“新加（集成时跑）”，集成时跑。）

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
