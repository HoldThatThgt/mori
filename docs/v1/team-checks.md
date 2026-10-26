# 平行 Agent 与 TaskBoard 检查记录

依据：[构建规格](../specs/parallel-agents-taskboard.md)（下称“规格”），它实现 [平行 Agent 与 TaskBoard Proposal](../proposals/parallel-agents-taskboard.md) 第四版，
并实现 [统一模型提供商规格](../specs/model-providers.md) §10 留下的规则。分支 `v1-taskboard`，从 `v1-model-providers` 的 90bacba 开出，
在 worktree `D:\code\mori\.claude\worktrees\v1-taskboard` 里做（`app\node_modules` 是指向 `D:\code\mori\app\node_modules` 的联接）。

## 状态

实现与测试完成（2026-10-22，`v1-taskboard` 本地提交，没有推送），等你走查与确认下面的选择。最后一次全部在开发构建上跑，代码为 `e5a20fa`（含 app-v0 `6217bfe`）：

| 层 | 结果 |
| --- | --- |
| 单元 | `npm run test:tb-unit` 327/327；`npm run test:unit`（模型层）373/373；`npm run check` 通过 |
| App（合成端点） | flow 43、roles 45、modes 58、ask 35、handoff 55、sched 24、models 32、stop 43、misc 20，全部通过 |
| 回放 | `tb-replay` 55/55（真实会话录的 4 个 fixture，加 m1–m7 的录制在合成的空 TeamState 下） |
| 真实模型 | `tb-real` 24/24（DeepSeek deepseek-flash 与 GLM-5.3，没有重跑）；模型层 MP-27 `v1-models-real` 通过 |
| 现有功能（TB-46） | m0–m7 的 App 与回放套件、v1-models 的 App 与回放套件、模型层单元与覆盖检查，24/24（第一次与 TaskBoard 套件同时跑时 m2-app 的 minWindow 因负载超时，单独跑 68/68，之后完整重跑全部通过）；同时写了 MP-37 |
| 覆盖检查 | `node tests/spec-coverage.mjs --spec taskboard` 与 `node tests/spec-coverage.mjs`（模型层）都是 every item is covered on every listed layer |

另外：实现中做过一次按规格分区的代码审查（5 个审查 + 5 个对抗核实），35 条发现里核实为真的 31 条全部修好并补了测试。

## 你不在时定下的选择（2026-10-21，待你确认）

你说“不用等我，选推荐的做法，做完列出来”。下面每一条都是 proposal 没定、实现又必须定的地方；括号里是另一种做法。

| # | 选择 | 理由 | 另一种做法 |
| --- | --- | --- | --- |
| 1 | 把 unified provider 会话做完的模型层提交为 90bacba（本地，没推送），在它上面开 `v1-taskboard`；那个会话之后又开始修测试，所以我把自己的工作挪到单独的 worktree，不再动 `D:\code\mori`，它最后的提交我再合进来 | “在它的工作之上做”需要一个起点 | 等那个会话自己提交再开分支 |
| 2 | 权限写作 `seats: [dialog, create, close]` | proposal 只给了 `[create, close]`，对话用 `dialog` | `chat`、`speak` |
| 3 | `tools` 直接写 pi 的工具名和 MCP 工具名，不写时与基座相同 | “配置就是 pi 的配置”；proposal 的例子 `tools: [read]` 正好是 pi 的工具名 | 自定义分类 `read/execute/edit` |
| 4 | 角色不写 `models` 时用会话的选择范围；基座总是用会话的范围；协作模式下顶栏只显示、不能改 | 统一模型提供商 proposal §5“协作模式下用户不选” | 协作模式下仍让你改基座的范围 |
| 5 | `.mori/agents` 不受项目信任控制；会话打开时读一次；文件有错时会话拒绝启动并列出问题，`Check again` 重新读 | 与 AGENTS.md 相同；模型层规格要求“引用不存在的名字时拒绝启动” | 受信任控制；有错时只忽略那个角色 |
| 6 | `/team` 由界面识别（带引用芯片也行），不列在 “/” 补全里；`/team off` 是派生的命令；关掉时有未关闭的需求，模式变为“做完为止”（`once`），`Stop team` 之后要让立项撤销需求才能回到关闭 | proposal 只写了 `/team`、`/team on` 和开关；不改现有的补全列表 | 列进补全；关掉时问你“继续做完 / 撤销” |
| 7 | 协作开关放在顶栏（本分支现有布局） | proposal §5“对话顶栏的开关”；composer-pickers 合入时再调整位置 | 放进输入框下面那一行 |
| 8 | 协作模式下对话 Agent 只有读取类工具和 TaskBoard 工具；立项、结案会话也只有读取类工具；动手的事都在 task 里做 | proposal“对话 Agent 只传话”、规则 8“同一时间只有一个实例写工作区”；角色文件里的其他工具只在 task 和关闭模式的对话里生效 | 结案也能跑命令核验 |
| 9 | 立项一个回合的最后一段文字转给对话 Agent；程序唤醒的立项回合里用 `reply_via_dialog { note }` 请对话转告你 | proposal 只说“请它回答或转告用户”，没给工具；用户消息之后对话本来就要回复 | 加一个专门的转告工具 |
| 10 | 一条消息一种决定，另一类被拒绝；`task_create`、`task_edit` 必须在这次判断里先登记或补充需求（只把停止、等待的 task 交回的 `task_edit` 除外，例如你说“继续”）；`request_submit`、`request_cancel` 只在判断你的消息时可用 | proposal“每条用户消息，它必须做下面一件事”；登记与撤销是对你的话的决定 | 不限制 |
| 11 | 需求上的用户原话默认由程序填这条消息全文；立项另给的原话必须是你说过的原文 | proposal“用户原话照记”，由程序保证 | 完全由立项写 |
| 12 | 证据是程序在工具结果前加的编号 `[#n]`，只认实例自己会话里已经结束的调用，引用的调用可以出错（记 ✓/✗）；`done`、`pass` 至少一个成功的；“改过代码”只看 `edit`、`write` | 模型看得到编号，比工具调用 id 可靠；命令改的文件认不出（已知限制） | 用工具调用 id；把命令也算作改代码 |
| 13 | 实例没交接时按模型的写入等级强制填写一次，格式错误再投递一次，填出来的也交给结案；没有写入等级的模型直接交结案 | 统一模型提供商规格 §10“填交接单按写入等级”与 proposal §6.6“交接缺失交给结案”合起来 | 不强制填写，直接交结案 |
| 14 | B 级强制填写保留工具定义、加 `response_format`；C 级不改请求，只在消息里写标签格式 | 有工具历史的对话去掉工具定义，有的服务端会拒绝；两个真实模型都是 C 级 | 去掉工具定义 |
| 15 | 结案没处理交给它的 task：强制填写一次，仍不行交给立项；需求的 task 都结束而结案没关：强制关闭一次，仍不行交给立项；结案请立项建 task 而立项没建：再唤醒结案一次后强制关闭；立项对等你拿主意的 task 或需求级问题什么都没做：程序请对话 Agent 问你 | proposal“结案处理不了的交给立项”“不会没人管”；每条路都终止在告诉你 | 一直等结案 |
| 16 | 写入锁按 task：写 task 第一个实例开始时拿到，到这个 task 结束才放（包括交给评审、等你拿主意、被停止期间） | 评审不会跑在别的 task 改了一半的代码上；代价是被停止的写 task 挡住别的写 task | 停止时放锁 |
| 17 | 一个会话同时运行的 task 与订阅实例最多 4 个 | 与每个 key 的默认并发 4 一致 | 不限、或按角色限 |
| 18 | `agent_message`：关闭模式下一律开只读的临时提问；协作模式下发给持有立项、结案的角色进它的座位会话，其余（包括对话持有者）开临时提问；临时提问不能再发消息；上限 10 条 | proposal“持有权限的角色进它的会话，其他角色新开一个只读实例”；对话会话不被唤醒，因为里面的角色不对你说话 | 对话也能收消息 |
| 19 | 不读历史会话：`read_session` 只读这块 TaskBoard 上 task 实例的会话（可以读自己的）；proposal §6.1 记忆 Agent“查一下历史会话”的例子不实现 | proposal 附录 A 说 history 并入 read_session，§8.2 又说 read_session 读某个 task 上的实例、读不到对话和立项的会话，两处不一致；按 §8.2 做。已知限制：读取类工具能按绝对路径读任何文件 | 给 `read_session` 加一个读同项目历史会话的范围 |
| 20 | 订阅只有一个时刻 `request_closed`，过滤 `ruled_out`、`outcome` | proposal 唯一的例子“需求关闭且中途排除过方案” | 更多时刻 |
| 21 | 停止：Esc 和停止按钮只停对话这一回合与为它判断的立项，后台照常（照 Claude Code：只打断前台）；`Stop team` 停这个会话的全部 Agent，task 变为 Stopped；都不自动重新开始，之后由立项 `task_edit` 交回；重启后同样 | proposal 没写停止；不加 proposal 没有的“继续”按钮 | Esc 停全部 |
| 22 | 后台实例的批准卡放在用户会话那一栏，卡头写“角色 · T1 · 标题”；批准状态整个会话共用 | proposal §7 | 每个实例各自的批准状态 |
| 23 | 存放：`<userData>/teams/<会话 id>/board.json`（每次整体原子写）和 `sessions/` 下的实例会话；删除会话一并删除，归档不动 | 最简单；实例会话不进侧栏 | 只追加的事件日志 |
| 24 | 回执只给立项的三种需求写入：`Request 1 registered · …`、`Added to request 1: “…”`、`Request 1 cancelled` | proposal §7 的例子 | task 的建立和关闭也出回执 |
| 25 | 进展摘要：标题行 + 每个未结束的 task 一行（当前在做什么取最近一次工具调用），展开看交接链 | proposal §7 的样子 | — |
| 26 | 立项判断时阶段行显示 `<角色> is deciding…`（就是准备中的阶段行换了文字）；后台在运行时输入框旁有 `Stop team`；侧栏状态在只有后台运行时也是“生成中” | 不然等立项那几秒什么都看不到；停止要能停后台 | 不显示 |
| 27 | 程序注入给模型的文字（附加段、投递消息、工作卡）用英文；用户会话的段写在每次运行开始时的自定义段 `mori_team` 里，关闭模式、没有别的角色时不写，与 v0 完全相同 | 与 pi 默认的 system prompt 同语言；不改变 v0 的会话；项目有 `SYSTEM.md` 时也有效 | 中文；放进固定的附加段 |
| 28 | 后台实例改的文件不进右栏的“本会话的改动”，右栏写明 `Changes made by team tasks aren’t listed here.` | proposal 没提；右栏按对话的工具卡列出 | 一并列出（Claude 桌面版的改动视图包括所有 Agent） |
| 29 | 协作模式下每条消息先排进“待判断”队列，一条一条判断；判断完按你发送时的选择（Enter 排队、Ctrl+Enter 插话）交给对话 | proposal“每条用户消息先经立项 Agent 判断” | 立即投递，不排队 |
| 30 | 以 `/` 开头的 pi 扩展命令在协作模式下照 v0 直接交给对话，不经立项；提示词模板照常先经立项，投递里附上展开的文字；技能命令立项只看到原文 | 扩展命令由扩展处理，没有可判断的消息；技能的展开 pi 没有导出（已知限制） | 全部先经立项 |
| 31 | 扩展的询问（确认、选择、输入）在后台实例里不出卡，按 pi 没有界面时的默认回答 | 后台实例没有对应的界面；proposal 只说批准卡 | 像批准卡一样带归属出卡 |
| 32 | 每段程序注入的文字第一行固定，供合成端点认出会话的种类 | 测试需要（规格 §17.1） | — |
| 33 | 新需求在立项的回合结束时还没有 task：提醒立项一次，仍没有就唤醒结案 | “全部 task 已结束”只对有 task 的需求成立，没有 task 的需求不能没人管 | 不提醒 |
| 34 | 一个 key 上给对话和立项、结案留一个槽位：task 与订阅最多占并发上限 − 1 | 严格优先不打断已经发出的请求，4 个 task 会占满默认的 4 个槽位，对话和立项会等到超时 | 不留 |
| 35 | App 重启后角色文件里已经没有的角色：它的 task 交给结案；座位持有者变了，已有的立项、结案会话由新的持有者继续 | 不让 task 卡在不存在的角色上 | 拒绝启动 |
| 36 | 协作模式下对话会话被拒绝启动时，关掉开关直接回到关闭，未关闭需求的 task 变为 Stopped；拒绝启动卡有 `Turn off team mode` | 否则会话既不能用、也回不到关闭 | — |
| 37 | 立项看到的对话是你的消息和对话 Agent 每回合的正文（不含工具调用和思考），合计 12000 字符 | proposal“看着整个对话”；工具输出不需要 | 连工具调用一起 |
| 38 | 真实模型一层（`tb-real.mjs`）在**复制出的**模型配置里把两个提供商指向本机的转发代理 `127.0.0.1:4690`，记下请求体以核对“对话的请求里没有写入类工具”“临时提问只读”；代理不读、不记、不打印请求头，key 只在测试进程的内存里经过，复制出的 `credentials.json` 结束时删掉 | §17.1 要核对请求的内容，HTTPS 请求在别处看不到 | 只从 App 的状态核对（`SessionInfo.tools`），临时提问的请求则核对不了 |
| 39 | `board.json` 的整体替换在 Windows 上遇到文件被别的进程打开（EPERM、EACCES、EBUSY）时重试，最多 10 次、共不到 1 秒，每次记日志 | 杀毒、索引程序打开文件时那次写入会丢，要到下一次写入才补上（§3 原子整体写） | 不重试 |
| 40 | `6a57fd4`（app-v0：english-ui 与模型层合入后）和之后的 `2e67197`（v1 文字润色）合并进本分支（合并，不是变基）；TB-03 的对照构建改为 `2e67197` | 模型层会话说它最后的状态就是这个提交，而且有英文界面；变基要重写本分支的全部提交 | 变基到 `6a57fd4` |
| 41 | TB-09：对话调用不在启用工具里的 `bash`、`edit` 由 pi 拒绝（`Tool bash not found`），§5.5 的理由只给运行中才被启用的工具（例如晚连上的 MCP）；规格按 pi 的行为改写 | pi 1.3.0 不把没启用的工具交给 Mori 的处理器；要给 §5.5 的理由就得把 `bash` 留在请求的工具里，违反 TB-09 第一项 | 把写入类工具留在请求里再拦 |
| 42 | §7.3：只有执行了的调用的结果带 `[#n]`；被 `tool_call` 处理器拒绝、参数校验失败的结果没有编号，也不能作证据；规格照此写明 | pi 对没执行的调用不经 `tool_result` 钩子 | 另做一套机制给它们编号 |
| 43 | §7.6：结案发给立项（请它建 task）的消息还没处理完时（立项收到它的那次运行没结束），结案被“全部已结束”唤醒的回合结束时不强制关闭，等立项；立项没建新 task 时照 §5.4 兜底表第 3 行再唤醒结案一次，那次强制关闭 | 不加这一条时，排着的“全部已结束”唤醒会在立项回答前就强制关闭需求 | 只看结案这一回合有没有发消息 |
| 44 | §12.12：模型提示在 task 交给另一方（交接、兜底、交回）时也清掉 | 否则交给结案后这一行还挂着执行者的“等模型”提示 | 只在下一次运行开始时清 |
| 45 | 还没有 task 的需求在进展摘要里显示 `With <close role>`（§13.3 写明） | 按顺序取状态时“task 都已结束”对空集成立；立项回合结束仍没有 task 时结案确实会被唤醒（§5.4） | 显示 `Running` |
| 46 | 进展摘要“当前在做什么”带 `offset`、`limit`，命令给前 200 字符（标题取第一行、多行时加 …），与工具卡同一标题 | §13.3 要求与工具卡同一标题规则，原来的 §13.10 字段不够 | — |
| 47 | 合并会话里 `reply_via_dialog` 的结果文字是 `Noted: no collaboration needed. Answer the user in your reply.` | 原来的 `The dialog agent answers the user directly.` 让真实的 DeepSeek 以为别人会回答，连调了约 70 次工具 | — |
| 48 | 关闭模式的临时提问没有交集时，被交集去掉的候选写作 `<provider/model> · not in the range you chose for the dialog` | 规格只说“报错列出原因”，没给去掉的原因的文字 | — |
| 49 | 工具卡标题按这次运行开始时的协作模式定（`Message <role>` 与 `Ask <role>`），之后改模式、重新打开都不变 | §5.1 一次运行保持开始时的模式；内核也按它路由 | 按当前模式 |
| 50 | 对话正在输出一条助手消息时撤回已判断的消息，回执与 `mori.progress` 等这条消息结束再写 | 立刻写会落在这条消息之前，实时与重新打开的顺序就不同了（TB-08） | 立刻写 |
| 51 | 输入框里带引用芯片时 `/team on`、`/team off` 只清文字、芯片留着（状态表的写法） | 规格 §5.1 只说“清空输入框”，芯片是你另外加的 | 连芯片一起清 |
| 52 | TB-34“其他实例挂起中的同名请求一并允许”在 App 里到不了（同一时刻最多一个实例有要批准的工具：写入锁与只读工具），由单元测试覆盖，TB-34 的层加上“单元” | 规格的条目要每层都能验证 | — |
| 53 | TB-46 的运行同时写模型层 MP-37 的两个结果文件（规格 §17.4 原本就这样写，运行脚本漏了，已补上） | — | — |
| 54 | 基座在 `next`、`assignee` 说明和“Other roles”里的一句话：`General-purpose agent with the default tools`（原来两处写了两种文字，已统一到 `shared/team.ts`） | 规格没给 | — |
| 55 | 顶栏协作开关在栏宽 ≤ 860px 时只显示状态点（空心为关、实心为开），原来规格写的“窄栏（< 600px）显示 Team 和状态点”改为这一条；另把分屏窄栏的按钮间距与图标宽度收紧一点 | 现有顶栏的各档在阈值刚过时只剩 8–25px，放不下 55px 的“Team ●”，m6 的布局检查会失败；composer-pickers 合入后顶栏只剩会话名和两个按钮，到时可以放宽 | 让模型按钮更早收短 |
| 56 | m3-app、m3-real、m6-app-slash 的 Shift+Tab 次数上限从 8 改为 9（协作开关是真正可以聚焦的按钮）；规格 §17.4 照此写明 | 多一个停靠点是正确的行为 | 不让协作开关进 Tab 顺序 |

## 开工前查的 pi 行为

见规格 §14.6（2026-10-21 用脚本对合成端点实测）；没有实测的项列在那一节最后一段。

## 交付了什么

- **规格**：[docs/specs/parallel-agents-taskboard.md](../specs/parallel-agents-taskboard.md)（proposal 第四版的实现说明；实现中按 pi 1.3.0 的实际行为与 App 测试发现的缺口修订过，见上表 41–47、52、55、56），
  状态表 `docs/v1/screens/team-*.md`，临时默认值 [defaults.md](defaults.md) 的“平行 Agent 与 TaskBoard”一节。
- **后台进程**（`app/src/kernel/`）：角色 `roles.ts`；TaskBoard `board.ts`、`teamTypes.ts`；路由与调度 `boardRoute.ts`；工具 `boardTools.ts`、`teamTools.ts`；
  文本 `boardText.ts`；读会话 `sessionReader.ts`；证据 `evidence.ts`；强制填写 `handoffForm.ts`、`forcedWrite.ts`（探针共用）；
  协作 `team.ts`、`teamFlow.ts`、`teamRuns.ts`、`teamLanes.ts`、`teamView.ts`、`teamExtension.ts`、`teamHost.ts`；实例 `instances.ts`；
  改动：`sessions.ts`、`approval.ts`（一个用户会话一份批准状态）、`extensionUi.ts`、`entries.ts`、`resources.ts`、`commands.ts`、`index.ts`、`agents.ts`（原子写在 Windows 上的重试）与模型层各文件（§12）。
- **主进程**：删除会话时一并删除 `teams/<id>`（`main/teamDir.ts`）。
- **界面**：协作开关、`/team`、回执与进展摘要、带归属的后台批准卡、待判断的消息与阶段行、`Stop team`、`wake` 条目、工具卡标题、拒绝启动卡、模型按钮锁定、右栏说明、侧栏状态、F8 记录。
- **测试**：单元 `tests/unit/taskboard/`；合成端点的脚本模式（`tests/fake-endpoint/scripts.mjs`、`steps.mjs`、`scenarios/`）；
  App 套件 `tests/ui/tb-app-{flow,roles,modes,ask,handoff,sched,models,stop,misc}.mjs`（共用 `tb-helpers.mjs`，各自的构建目录用 `tb-build.mjs`，
  TB-03 的对照构建用 `tb-build-base.mjs`）；回放 `tb-replay.mjs` 与真实会话录的 `tests/fixtures/tb/`（`tb-record.mjs`）；真实模型 `tb-real.mjs`；
  `npm run test:taskboard`；覆盖检查 `node tests/spec-coverage.mjs --spec taskboard`。
- **合入**：`v1-model-providers` 的 `78df3dc`，app-v0 的 `6a57fd4`（english-ui 与模型层）、`2e67197`（v1 文字润色）、`6217bfe`（术语表）。

## 与规格不同、或需要你注意的地方

- english-ui 已随 `app-v0`（`6a57fd4`）合入（2026-10-21）：v0 界面文字与 TaskBoard 新加的文字都按
  [v0/ui-strings.md](../v0/ui-strings.md) 的英文，v0 工具卡与进展摘要的标题是同一套规则（`shared/team.ts` 的 `toolCallTitle`）。
  composer-pickers 还没有合入：界面按本分支的顶栏布局做（协作开关在 ≤ 860px 时只显示状态点，上表 55）。composer-pickers 会话已在它的顶栏里
  给协作开关留了位置（右边一组的第一个，`Toggle changes` 之前）；后合入的一方重算标题的宽度与阈值。
- 真实模型一层经本机转发代理看请求体（上表 38），请确认可以这样做。
- 严格优先意味着 task 一直在跑时，新加模型的探针要等（规格 §12.10）。
- `anthropic-messages` 的模型永远不满足 `requires: [structured_output]`（规格 §12.2）。
- 用命令改的文件认不出“改过代码”（规格 §7.3）。

## 未验证

- **负责人走查**：没做（方案第 8 节完成顺序的最后一步）。
- **安装包**：TaskBoard 的 App 套件与真实模型一层都只在开发构建上跑过，没有跑 `--exe`（打包后的 Mori.exe）。
- **真实模型没有走到的路**：分开的座位配置（chat 对话、planner 立项与结案）、A/B 级的强制填写（两个真实模型都是 C 级，真实运行里也没出现强制填写）、
  `need_user` 与 `waiting_user`、后台批准卡上带理由的拒绝和“本会话不再询问”、临时提问没有交集的报错。这些都只在合成端点上验证过。
- **没有失败用例证明的修复**：侧栏的后台批准状态重新读取（同一会话里两张后台卡不会同时挂起，上表 52）、退出时先关闭 Team（丢写入的竞争复现不了）、
  `pump` 里的模型锁检查、对话回复没开始运行就结束时通知 Team 的 `sessions.ts` 接线（只有 Team 一侧有单元测试）。这些是读代码确认需要的。
- **TB-47** 只走到了“新模型的上下文里没有别的模型的工具调用”这一支；“带压缩摘要”那一支没有出现（pi 判断不需要压缩）。
- **规格 §14.6 最后一段**：超过 6 个并发会话、带 MCP 与技能时的表现没有测量。
- 技能命令的展开立项看不到（pi 没有导出，规格 §5.3 写明的已知限制）。

## 2026-10-26 负责人走查之后（WP-10：Task mode 给模型的文字、关掉之后回看、角色边界）

依据：[走查记录](walkthrough-1026-checks.md) 的 M13、M21（给模型的部分）、M22、M26；这一包的记录见 [WP-10](walkthrough-1026/WP-10.md)。
规格改了 §0、§1、§5.1、§5.2、§5.5、§6.3、§6.4、§7.5、§8.1、§8.3、§8.5、§10.1、§10.2、§13.3、§13.10、§13.11、§15、§17.1–§17.3 与附录 A；
新的验收条目 TB-58（模式提示）、TB-59（关掉之后回看）。下表接着上面的编号，都是按诊断的推荐替你定的（括号里是另一种做法）。

| # | 选择 | 理由 | 另一种做法 |
| --- | --- | --- | --- |
| 57 | 命令改为 `/task`、`/task on`、`/task off`，没有 `/team` 的别名；给模型的文字一律写 task mode（附录 A 三段的第一句随之改，合成端点的 `SEGMENT_SENTENCES` 同改），`board_read` 的第一行写 `Task mode on` / `Task mode on until done` / `Task mode off`，工作卡写 `Task mode: …` | 你说“team mode should be task mode”；命令改了，提示 `/team` 的那句本来就要改 | 只改界面上的字，模型仍读 team mode |
| 58 | 每次模式改变，对话流里一行 `Task mode on` / `Task mode on until done` / `Task mode off`（照 Claude 的 `Fast mode on` / `Fast mode off`）；每次一行、不合并；新事件 `mori.team_mode` 与 `mori.team` 条目同一时刻发，`/task <文字>` 时这一行放在准备中先显示的你的消息之前，所以实时与重新打开一样 | 02:14 那次关掉时对话流里什么都没有，你和模型都不知道；不合并最简单，也照实记下“先变为做完为止、再关掉” | 相邻的两行只留后一行 |
| 59 | 关掉之后：这个会话的 TaskBoard 上有需求（不论开着还是已关闭）时，对话保留 `board_read`、`read_session`（只读），登记需求、建 task 等工具仍只在 Task mode 下；没有需求的会话（没用过，或只是打开又关掉）与 v0 相同（TB-03）；工具在打开会话时就注册，重启后关闭模式的会话也有 | M22：关掉之后模型连 T1–T6 的结果都读不到，只好自己重做；只读工具不改任何东西 | 只告诉模型关了、不留工具 |
| 60 | “模式关了”写在关闭模式的工作卡里，不写进 `mori_team` 段：`Task mode: off`、一句“只能自己做，你打开 Task mode 之前不能登记需求、建 task”、协作模式对话段的同一句 `Tools are yours, not the user's: …`（M26：关闭模式的 `mori_team` 段只在有别的角色时有，也没有这句；评审指出这里缺）、最近 5 个需求（更早的写成一行 `N earlier requests: board_read {}`，临时默认值） | §8.5 定的“模式与 TaskBoard 状态只在工作卡里”（第 27 条）不用改；卡片在上下文末尾，02:14 之后那次 system prompt 变了模型也没注意；走查主日志第 45 行（Task mode 开着）主 Agent 把“证据在哪”回成 `read_session` 的写法，关掉之后它同样有这个工具，却没有协作模式对话段里的那句 | 写进 `mori_team` 段 |
| 61 | 读取类总有 `ls`，不论角色写没写 `tools`：只读的 task、立项、结案、临时提问、订阅和 Task mode 下的对话都能列目录（写了 `tools: [read, bash, edit, write]` 的角色这些会话里是 `read`、`ls`；它的非只读 task 仍照它写的）；`grep`、`find` 不加（要 rg、fd，交给 WP-08 的开关与规则，集成时与 WP-08 合） | 走查记录“按推荐定下的”写的是“只读助手总有 `ls`”，不分角色；每个只读 task 都在猜文件名、碰到 EISDIR，负责人在 Customize › Agents 加了角色文件后同样会碰到；subagent 规格 §5.3 的只读 subagent 也按“读取类加总有的 `ls`”；pi 的 `ls` 只用 node:fs，离线可用 | 只给 `read`；只给基座和没写 `tools` 的角色（开发阶段的写法，评审指出与走查记录不符，已改） |
| 62 | `read_session` 省略 `role` 时取最近一棒的角色，只有读的一方正是这个 task 上同一角色的实例（读自己）时才要求写明；错误第二行的例子写 `"role":"<role>"` | 原来按角色名比较“是不是自己”，没有角色文件时人人都是 `mori`，对话和结案读基座做的 task 总被拒绝（M13 的两次拒绝）；例子里的 `executor` 不一定存在 | 照旧要求写明 |
| 63 | C 级强制填写的 `<evidence>`：编号之间用任何分隔符都认（字母、数字、`_`、`#`、`[`、`]` 之外的字符都算分隔），分出来不是编号的词照旧不合格（不从文字里猜编号）；给模型的说明仍写“每行一项”；`<open_items>` 仍每行一项 | T4 写 `#3、#4、#6` 被拒绝过一次，多一轮强制填写 | 只认换行 |
| 64 | 项目没有角色文件时，进展摘要的 task 行与交接链不写角色名（每个都是基座，写出来都是 `Mori`，看起来像对话 Agent 自己在做）；有角色文件时基座仍写 `Mori`；给模型的 `board_read` 总写角色名 | M13：“the agent worked inline”的一个原因是到处都写 Mori | 照旧写 `Mori` |
| 65 | 各角色提示词补“谁看得到什么”和各自的边界（附录 A）：共用段两行（只有对话里的 Agent 和你说话，别的都在你看不到的后台；你只看得到它的回复和进展摘要，看不到别的会话、留给 task 的消息和 `board_read`，也从不调工具）；对话段与合并会话的立项段“工具是 Agent 的，不让你调工具或去打开会话，自己读出来放进回复”，需求关闭时你要的清单、报告、计划要读出来完整交给你；立项两段：task 的结果交回对话 Agent，task 可以汇总别的 task，但交给你的是对话 Agent，只有你要求时才让 task 写文件；task 段：你看不到它的会话，完整结果写在交接时的回复里（`read_session` 读得到），不用 `agent_message` 交付；结案段：结果合起来满足验收才按完成关闭，缺的找立项再建 task，`request_close` 的结论就是告诉你的话、写明完整结果在哪；需求关闭的投递最后加“读出来完整给你、不让你调工具”；`agent_message` 的说明加 `The user never sees these messages.`；合并会话里 `reply_via_dialog` 保留，段里不再提它，说明改为 `No collaboration needed: you answer the user directly in your reply.` | M26：主 Agent 让你自己去调 `read_session`，T2、T5、T6 把结果留在给 task 的消息里，结案说“清单在 T6 的消息里”；每段第一句不变（除 team → task），合成端点照旧认得出 | 文件一律写进项目，再告诉你路径 |
| 66 | 共用段多了约 100 token，各种会话的段多了约 55–120 token（按字符数 ÷ 4）；合并会话的 `mori_team` 段（共用段加立项段）约 650 token（原来约 430） | 换来的是上面那些边界写清楚 | — |
| 67 | 身份段（记忆规格附录 A.1）不在这包改：它的“交出去那一句”按启用的工具出现（WP-11），subagent 的段与身份句由 subagent 会话改 | 范围分开，免得两边同时改一段文字 | — |
| 68 | `tests/ui/tb-app-flow.mjs` 套件末尾的 TB-12（board.json 读了 100 次以上）与 TB-37（状态采样 10 次以上）在 `--only` 时不做 | 只跑几步时读数与采样不够，原来总是失败（WP-11 的集成记录） | — |

没有验证的（开发阶段只跑了检查、构建与单元测试）：界面套件里新加和改过的用例、重录的回放 fixture、真实模型的 `lookback` 与 `team` 两个驱动
都要等集成阶段跑（命令见 WP-10 的记录）；模型读到这些新的边界后会不会照做（自己读 task 的回复、完整交给你、不让你调工具、task 不用
`agent_message` 交付）只能在真实模型上看，测试只断言程序保证的事，模型怎么做写进 note。

## 普通模式的 subagent 工具（2026-10-26，负责人走查 M17）

依据：[subagent 规格](../specs/subagent.md)（TaskBoard 规格的增补），状态表 [subagent-card.md](screens/subagent-card.md)，临时默认值
[defaults.md](defaults.md) 的“普通模式的 subagent 工具”一节。分支 `v1-subagent`（worktree `D:\code\mori\.claude\worktrees\wizardly-albattani-b7cb94`，
`app\node_modules` 是指向 `D:\code\mori\app\node_modules` 的联接），合过本地 `app-v0` 的 `f613281`；本地提交，没有推送，没有合进 `app-v0`。

### 负责人的回答（2026-10-26）

1. 照 Claude Code：每个 subagent 由主 Agent 选只读（像 Explore）或通用（像 general-purpose，照权限模式批准，卡头写明是哪个 subagent）；角色带自己的工具。
2. Task mode 关闭时总有（没有角色文件也有）。
3. 一次调用、一次回复都不设条数上限；全部同时开始，用满 key 并发设置的全部槽位，多出来的排队、不超时（新的调度类别 `subagent`）。
4. 保留普通模式下的 `agent_message`。

### 状态（随各包合并更新；最后一次 2026-10-26，合过本地 `app-v0` 的 `25d06fb`，即 WP-10、WP-14 与 customize-agents）

第二轮审查之后（2026-10-26，8 条；合过本地 `app-v0` 的 `25d06fb`，即 customize-agents）：TaskBoard 的后台卡不改阶段行有了用例
（`tb-replay --only tb-approval` 的 `TB-34 replay tb-approval: a TaskBoard background card leaves the stage line alone …`；对 e7c332b 的旧 fixture
跑这一条失败、对重录的通过；单元 TB-34 另查 task 实例的卡 `subagent` 为 `null`）；`role` 不写枚举是给模型的变化，真实模型那一层用
`tb-real --only ask`（`sa-real` 的项目没有角色文件，发不出带 `role` 的 schema；关闭模式、有别的角色的对话是最窄的一个）：新加的
`TB-04 real ask: off mode with other roles the dialog's requests also carry subagent, whose role parameter is a plain string without an enum …`
通过，模型照旧用 `agent_message` 问角色。结果：`npm run check` 通过；`test:unit` 481/481、`test:tb-unit` 350/350、`test:sa-unit` 29/29、
`test:mem-unit` 239/239、`test:md-unit` 222/222、`test:ag-unit` 42/42、合成端点自检 184/184；`tb-replay --only tb-approval` 8/8；
真实 `tb-real --only ask` 9/9；`npm run test:quick` 4/4（84 秒）。

审查之后（2026-10-26，walkthrough-fixes 会话转来的 14 条，先写测试再改）：阶段行在普通模式 subagent 的批准卡挂着时写 `Waiting for your approval`
（`StageLine.tsx`；TaskBoard 的后台卡仍不改阶段行）；`role` 不写枚举（“要你决定的”第 3 条）；秒数文字合进 `components/duration.ts`；
`tb-approval` 用今天的程序从真实会话重录（批准请求带 `subagent: null`，`tb-replay --only tb-approval` 7/7）；新加或补全的用例：
准备中（`sa-replay`）、等待执行（`sa-app --only queued`，新的合成脚本 `sa-queued`）、阶段行等你批准（`sa-app --only approval`、`sa-replay`）、
被拒绝的卡按参数画的行与 Agent prompt、停止后的 `Ran 2 agents`、有别的角色时写错的角色（`sa-app --only roles`）、Task mode 下的合并会话没有
`subagent`（单元 SA-01 与 `sa-app --only normal`）、MEM-02 readonly 的期望补上 `subagent`（`mem-app-prompt.mjs` 在合 WP-10 时是自动合并，
没有冲突，这一条是审查时补的）。结果：`npm run check` 通过；`test:unit` 477/477、`test:tb-unit` 350/350、`test:sa-unit` 29/29、
`test:mem-unit` 239/239、`test:md-unit` 222/222、合成端点自检 184/184；`sa-app --only normal,parallel,queued,approval,stop,roles` 全过、
`sa-replay` 16/16；用共用端口的：`npm run test:quick` 4/4（82 秒）、`tb-app-roles --only v0same` 11/11（改写后的 TB-03）、
`mem-app-prompt --only prompt,merged,split,readonly` 与 `--only prompt,snapshot,merged`（`merged` 要先跑 `snapshot`）全过（MEM-01 实测 500 token、
MEM-02 readonly 过）、真实模型 `tb-real --only team` 10/10：这次运行里 task 实例（`t1.executor`、`t1.reviewer`、`t2.reviewer`）与结案实例的
会话文件里是只说问题的那一句，合并会话里是 WP-11 那一句。

合 WP-14 时做的：`sa-app`、`sa-replay` 点开或读一张 subagent 卡之前先用 `tests/ui/page.mjs` 的 `showStep` 点开它所在的步骤组（一轮结束后卡片在
折起的组里）。合并后 `test:unit` 477/477、`test:tb-unit` 350/350、`test:sa-unit` 28/28、`test:mem-unit` 239/239、`test:md-unit` 222/222、
合成端点自检 184/184、`npm run check` 通过；整套 `sa-app` 43/43、`sa-replay` 14/14（SA-11 折进 `1 step`、展开那一行时卡片是收起的，两层都过）。

合 WP-10 时做的（同一次集成）：只读 subagent 改用 `roles.ts` 的 `readClassTools`（WP-10 起总有 `ls`），删掉本分支自己加的那一份；
关闭模式的临时提问（`agent_message` 开的）不带共用段（`boardText.ts` 的 `segments`，`team.ts` 传 `lane.team`）；TaskBoard 规格照本规格 §11 改了
§0、§5.2、§8.1、§8.5、§11.3、§12.1、§12.10、§13.8、§13.12、§17.2 TB-03 与附录 A；`tb-app-ask` 的 TB-04 第一条另查请求里没有共用段。
tb fixture 里录到的 system prompt：`tb-approval`、`tb-receipts`、`tb-team` 录的都是 Task mode 的合并会话（有 `task_create` 与 `agent_message`，
那一句与 WP-11 逐字相同），不用重录；`tb-ask` 录的是关闭模式、有别的角色的对话（有 `agent_message`、没有 `task_create`），用今天的文字从真实
DeepSeek 与 GLM 会话重录（`tools` 多 `subagent`，那一句是“Questions you send to other agents and prompts you give subagents …”），
`tb-replay --only tb-ask` 10/10。合并后 `test:unit` 465/465、`test:tb-unit` 350/350（TB-59 的两条期望补上普通模式的 `subagent`）、
`test:sa-unit` 28/28、`test:mem-unit` 239/239、`test:md-unit` 222/222、合成端点自检 184/184；`sa-app --only normal,parallel` 21/22、
`sa-replay` 13/14（没过的都是 SA-11 折进 `<n> steps`，等 WP-14）。

用共用端口的（第二波做完后，walkthrough-fixes 会话排到本分支时跑，合过 WP-10 与 WP-14 之后）：`npm run test:quick` 4/4（89 秒）；
`tb-app-ask --only offAsk` 10/10（含 TB-04 新加的一项：请求里没有共用段）；`tb-app-roles --only fields` 13/13（TB-09 合并时改的期望）；
真实模型 `tb-real --only ask` 8/8（DeepSeek 与 GLM；关闭模式的临时提问少了共用段，给模型的文字变了）。

合 WP-10 之前的结果：

| 层 | 结果 |
| --- | --- |
| 单元 | `npm run test:sa-unit` 26/28：没过的两条是先写好的 WP-10 部分（只读 subagent 经 Task mode 只读实例的同一个函数拿到 `ls`；关闭模式的临时提问不带共用段）；`test:unit` 485/485（含 spec-ids、MP-38）、`test:tb-unit` 334/334、`test:mem-unit` 239/239、合成端点自检 194/194；`npm run check` 通过 |
| App（合成端点，`sa-app.mjs`，端口 4970/4971） | 42/43：没过的是 SA-11 折进 `<n> steps`（等 WP-14） |
| 回放（`sa-replay.mjs`） | 13/14：没过的同上（等 WP-14）；fixture `tests/fixtures/sa/sa-subagent.json` 用新的给模型的文字从真实 DeepSeek 会话重录（批准卡挂 1.5 秒再允许，录下“等你批准”的那一行） |
| 真实模型（`sa-real.mjs`，代理 4972） | 22/22：DeepSeek 与 GLM 各跑只读的三路分工与通用 subagent 跑命令（带归属的批准卡），没有重跑 |
| 给模型的文字变了、覆盖它的别的用例（`--only`） | `mem-app-prompt`（prompt、snapshot、merged、split、restart）34/34，MEM-01 实测普通模式身份段 500 token；`tb-app-roles`（v0same、fields）21/21，TB-03 已改写为“v0 加 subagent”；`tb-app-flow`（sysmd）里身份段那一条通过（同一次的 TB-12、TB-37 是要整套样本的汇总检查，只跑 sysmd 时没有样本）；`m6-app-tool-switches`（setup、rows）6/6；`tb-app-misc`（changes、plainChanges）6/6；真实模型 `tb-real --only ask` 8/8、`mem-real --only dialog,page` 17/17 |

### 状态表的行与用例（2026-10-26 负责人定：屏的规格由走查对照这张表核对）

本分支新增或改动的状态表行，每行对应的界面用例（套件与 `--only` 的步骤名、检查名的开头）。SA 编号的验收由 spec-ids 与覆盖检查管。

| 屏 | 行 | 用例 |
| --- | --- | --- |
| [subagent-card.md](screens/subagent-card.md) 卡片 | 准备中 | `sa-replay`（sa-subagent）`SA-11 replay sa-subagent: while the arguments stream in the card is open with "Preparing…" …`（`Running agents`，之后按已收到的项数；每项一行、状态空着） |
| 同上 | 等待执行 | `sa-app --only queued` `SA-11 a subagent call behind a command that waits for approval in the same reply reads "Running 2 agents" · "Queued" …` |
| 同上 | 阶段行：有 subagent 等你批准时 `Waiting for your approval` | `sa-app --only approval` `SA-12 while a general subagent's approval card is pending the stage line reads "Waiting for your approval" …`；`sa-replay` `SA-11 replay sa-subagent: while the general subagent's approval card is pending the stage line reads …` |
| 同上 | 执行中（标题、`<d> of <n> done · <s>`、展开、阶段行） | `sa-app --only parallel` `SA-11 while running the card is open …`、`SA-11 the stage line reads …`；`sa-replay` 同名 |
| 同上 | 结束（`Ran <n> agents · Done · <s>`、收起一次；`Done · 1 failed`） | `sa-app --only parallel` `SA-11 when the call ends the card collapses once …`；`--only roles` `SA-11 a role row reads …` |
| 同上 | 全部失败（`Failed`） | `sa-app --only roles` `SA-11 when every subagent failed the card reads "Ran agent" · "Failed" …` |
| 同上 | 被拒绝（`Run <n> agents · Failed · <原因>`；按参数画出各行，状态空着；点开一行只有 Agent prompt） | `sa-app --only parallel` `SA-03 the refused call's card reads "Run agent" …`、`SA-03 the refused call's card has one row per task drawn from its arguments …`；`--only roles` `SA-03 with other roles an unknown role reaches the §3.3 check …` |
| 同上 | 已停止（`Ran <n> agents` · `Stopped`） | `sa-app --only stop` `SA-13 stopping the reply stops every subagent … the title reads "Ran 2 agents"` |
| 同上 | 已中断 | `sa-app --only kill` `SA-14 when the background process exits …` |
| 同上 | 重新打开（已结束；没有结果的按参数画） | `sa-app --only kill` `SA-14 reopening an ended call …`、`SA-14 reopened after a restart …`；`sa-replay` `SA-14 replay sa-subagent: reopened …` |
| 同上 | 界面重新载入（执行中） | `sa-app --only reload` `SA-14 after Ctrl+R the running card comes back …`、`SA-14 after the reload the card keeps updating …` |
| 同上 | 一轮结束后折进 `<n> steps`（WP-14） | `sa-app --only parallel` `SA-11 after the turn the subagent card is one step of it …`；`sa-replay` `SA-11 replay sa-subagent: after the turn …` |
| subagent-card.md 每一行 | 开始了、还没调用工具（`Starting`）；执行中（工具标题） | `sa-app --only parallel` `SA-11 while running …` |
| 同上 | 在等模型的槽位（`Waiting for <提供商>`、`Switched model …`） | `sa-app --only slots` `SA-06 a subagent waiting for a slot shows "Waiting for SAM" …`；`Switched model` 的文字在单元 `SA-06 a row's note follows the model layer …` |
| 同上 | 等你批准 | `sa-app --only approval` `SA-12 a general subagent running a command shows …`；`sa-replay` `SA-11 replay sa-subagent: while running …`（含 Waiting for your approval） |
| 同上 | 正常结束；点开一行（`Agent prompt`、`Response`） | `sa-app --only parallel` `SA-11 each row: …`、`SA-11 opening a row shows …`；`sa-replay` `SA-11 replay sa-subagent: opening a row …` |
| 同上 | 失败（80 字符截断、悬停全文） | `sa-app --only roles` `SA-11 a role row reads …` |
| 同上 | 被停止；中断 | `sa-app --only stop` `SA-13 …`；`--only kill` `SA-14 when the background process exits …` |
| subagent-card.md 右栏；[changes.md](../v0/screens/changes.md) 两行；[team-blocked.md](screens/team-blocked.md) 两行（说明改为 `Changes made by other agents aren’t listed here.`） | 通用 subagent 改过文件；没有 Agent 改过文件 | `sa-app --only edits` `SA-15 a read-only subagent does not set the note …`；task 改过文件的两行 `tb-app-misc --only changes` `TB-57 …`（期望的文字已改） |
| [team-approvals.md](screens/team-approvals.md) | 后台实例要批准（归属 `<Role> · <description>`、`data-subagent`）；界面重新载入；阶段行（普通模式 subagent 的卡除外，2026-10-26 改） | `tb-replay --only tb-approval` `TB-34 replay tb-approval: a TaskBoard background card leaves the stage line alone …`；`sa-app --only approval` `SA-12 while a general subagent's approval card is pending the stage line reads …`； `sa-app --only approval` `SA-12 a general subagent running a command shows …`、`SA-12 allowed with Alt+1 …`、`SA-12 choosing "Allow bash for this session" …`；`--only reload` `SA-12 the pending approval card of a subagent is still there after the reload …`；`sa-real` `SA-12 real command on …` |
| [tools.md](../v0/screens/tools.md) | 不是 pi 内置工具的行（`subagent` 的原因） | `sa-app --only normal` `SA-01 Customize › Tools has a subagent row …`；`m6-app-tool-switches --only setup,rows` `M12 没有开关的行 …`；`tb-app-roles --only v0same` `TB-03 off mode without role files: the Tools page rows …` |
| [tool-cards.md](../v0/screens/tool-cards.md) | 标题对照表的 `subagent` 一行 | `sa-app --only parallel` 的 `SA-11 while running the card is open …`（Running）、`SA-11 when the call ends the card collapses once …`（Ran）、`SA-03 the refused call's card reads "Run agent" …`（Run） |

### 等别的包合并之后做的

- WP-10：做完了（见上面“状态”），用共用端口的几项也跑过了。
- WP-14：做完了（见上面“状态”）。

### 要你决定的（2026-10-26 你不在：照“unattended mode, pick recommended option for questions and log them”按推荐做了，等你回来看）

1. **原来的准则放在哪里**（规格 §6.1、§6.4）
   - 问题：普通模式的会话从此总有 `subagent`；原来那条准则（什么时候用、每个 prompt 要能单独看懂）放进身份段，默认工具下的普通模式
     身份段会到 549 token，超过记忆规格的 500 上限（MEM-01）。
   - 选项：① 准则的话并进工具说明的第三行，不写 `promptGuidelines`（500 token）；② 保留准则（549，超上限）；③ 缩短准则（522，仍超上限）。
   - 选了：①（推荐），登记为临时默认值（[defaults.md](defaults.md) 的“原来的准则……放在哪里”一行）。
   - 实现：`app/src/kernel/subagent.ts`（`SUBAGENT_DESCRIPTION`；`subagentTool` 不带 `promptGuidelines`）。
   - 测试：单元 `SA-10 normal mode (default tools with subagent on) keeps the identity section within 500 tokens …`
     （`tests/unit/subagent/identity.test.mjs`）；App `sa-app --only normal` `SA-17 normal mode = v0 + subagent …`（请求里没有准则、
     工具说明里有这几句），`mem-app-prompt --only prompt` `MEM-01 with the default tools the identity section actually sent is at most
     500 tokens …`（实测 500）。
2. **交出去的活那一句怎么写**（规格 §6.4、记忆规格附录 A.1.1）
   - 问题：WP-11 的那一句是固定的，只说 task 与问题；普通模式只有 `subagent` 时，它让模型去找不存在的工具，或把事实写进卡上的
     `description` 而不是 `prompt`。
   - 选项：① 按这次运行启用的 `task_create`、`agent_message`、`subagent` 拼，Task mode 的文字与 WP-11 逐字相同；② 照旧用固定的句子；
     ③ 普通模式不加这一句，只靠工具说明里的“Each subagent starts with no context except the prompt you write”。
   - 选了：①（推荐，walkthrough-fixes 会话转达“现在就写”），登记为临时默认值（[defaults.md](defaults.md) 的“交出去的活那一句”一行）。
   - 2026-10-26 无人值守时按推荐改为：那一句跟着会话实际有的工具，同时有 `task_create` 与 `agent_message` 的会话（Task mode 的合并会话、
     分开时的立项）与 WP-11 逐字相同；Task mode 下只有 `agent_message`、没有 `task_create` 的（分开时的对话，task、结案、订阅实例）是只说问题的
     那一句 `Questions you send to other agents are worked on by agents that don't see <facts>: write the facts they need into the question.`（U31）。
     另一种做法请你定：Task mode 的每个会话都照 WP-11 那一句逐字不变（只在普通模式按工具拼）。
   - 实现：`app/src/kernel/memoryText.ts`（`HANDOFF_PARTS`、`handoffText`；`HANDOFF_TEXT` 由它拼出）。
   - 测试：单元 `SA-10 the sentence lists only the handoff tools of this run, in §6.4 order`、`MEM-01 the handoff sentence (appendix A.1.1)
     ends the third line only when …`；App `mem-app-prompt --only prompt,snapshot,merged,split,restart`、`tb-app-flow --only sysmd`
     （期望的句子由 `tests/ui/tb-helpers.mjs` 的 `expectedHandoff` 另行拼出）；真实 `mem-real --only dialog,page`、`tb-real --only ask`、
     `sa-real`；U31 的范围：真实 `tb-real --only team` 10/10（task 实例 `t1.executor`、`t1.reviewer`、`t2.reviewer` 与结案实例的会话文件里是
     只说问题的那一句，合并会话里是 WP-11 那一句）。

3. **有别的角色时 `role` 写不写枚举**（规格 §3.1、§3.3；2026-10-26 审查发现）
   - 问题：写了枚举时，写错的角色在执行前就被 pi 的 schema 校验以 `Validation failed for tool "subagent"` 拒绝，§3.3 的原因（列出可用的
     角色）与 `Correct form` 到不了模型。
   - 选项：① 不写枚举，说明里列出角色，写错的由 §3.3 的检查拒绝；② 保留枚举，接受 pi 的校验文字。
   - 选了：①（推荐，walkthrough-fixes 会话转达），登记为临时默认值（[defaults.md](defaults.md) 的“`role` 参数的写法”一行）。
   - 实现：`app/src/kernel/subagent.ts`（`subagentSchema`）。
   - 测试：单元 `SA-02 with other roles role is a plain string (no enum …`；App `sa-app --only roles` `SA-03 with other roles an unknown role
     reaches the §3.3 check (role has no enum) …`（模型收到的两行逐字、不开实例、`teams/` 下不多写文件、端点没有它的请求）。

### 未验证

- **负责人走查**：没做。
- **安装包**：只在开发构建上跑过，没有跑 `--exe`。
- **同时很多 subagent**：并发 4 的 key 上 6 个在合成端点上验证过；更多的同时会话（超过 6 个）没有测量（同 TaskBoard 规格 §14.6）。
- **通用 subagent 同时改同一个文件**：没有隔离也没有写入锁（规格 §0 不做），互相覆盖的情形没有测试。
- **右栏不列 subagent 改的文件**：只显示一句说明（规格 §0 不做、§7.6）。
- **Task mode 下分开时的对话那一句**：改为只说问题的那一句，真实模型没有跑到：`tb-real` 的设置里基座持有对话、立项与结案（合并会话），
  走不到分开时的对话；合成端点上 `tb-app-flow`、`mem-app-prompt --only split` 的期望由 `expectedHandoff` 另行拼出，跑过。
