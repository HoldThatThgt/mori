# 收尾检查构建规格

状态：构建规格，按 [收尾检查 Proposal](../proposals/finish-check.md) 第一版（2026-10-27，已过一轮 Fable 评审，提交 `00e23b1`）写成，范围是 proposal §14 的**第 1 步**（收尾检查本身）；
写完后经一轮对抗评审（六个维度、每条发现一位反驳者对照代码核实：52 条发现，49 条成立或部分成立，都已改，处理见检查记录）；2026-10-27 已按本文实现，合并进 `app-v0`（`beda541`）并推送（实现结果、实现时补的两处、推送前的完整测试与未验证项见检查记录）；
第 2 步（过程的折叠）这一轮不做，留待负责人审完 proposal 与本文再写（§15）。写规格时负责人不在（无人模式），需要决定的地方按推荐定下，
列在 §0“写规格时定的”，同时登记在 [v1/defaults.md](../v1/defaults.md) 的“收尾检查”一节与检查记录 [v1/finish-check-checks.md](../v1/finish-check-checks.md)，**待负责人审**。更新日期：2026-10-27。

本文是 proposal 的实现说明：proposal 讲心智模型，本文讲在 Mori 里怎么做、做到什么算完成。
两者冲突时以 proposal 为准；本文不另加 proposal 没有的行为（§12 的临时默认值与 §0 列出的写规格时定的除外）。

收尾检查属于 [app-v0](../app-v0.md) §6“后台进程只做的事”的第 8 件（记忆、拼装与增强），由 inline extension `mori-memory` 做；
第 7 件（`mori-team`）、第 3 件（`mori-approval`）与第 6 件（模型层）各有配合改动（proposal §3）。
代码引用写相对仓库根的路径与行号（`app/src/...:行号`、`app/node_modules/@earendil-works/pi-coding-agent/dist/...:行号`，pi 1.3.0），以写规格时的 `app-v0`（`00e23b1`）为准。
[文件系统规格](file-system.md)现在只有文档、代码里还没实现，本文按现在的代码写；两者谁先落地都行，先后关系见 §11。

## 0. 范围

**本规格实现**（proposal §14 第 1 步）：

- `finish` 工具：没有参数，结果带 `terminate`；只在用户会话注册（增强任务的看不见的会话除外）、一直启用、免批准（§4）；
- 收尾检查：`mori-memory` 的 `agent_before_settle` 处理器在运行要结束、`outcome` 为 `completed` 时，从这次运行的上下文里数，按 proposal §5.4 的表检查或放行；
  检查时往会话里加一条不显示的 `custom_message`（`mori.finish_check`）并返回 `continue: true`（§5）；
- 检查那次请求：`mori-memory` 的 `context` 处理器在这次请求的副本里，把这次运行的 `<taste>`、`<review>` 接进检查那一行（§6）；
- 检查那一行、检查块与 `finish` 说明的英文原文（§7）；
- `mori-team`：一次 pi 运行只起一份运行记录；对话会话的工具里一直有 `finish`，`tool_call` 的限制放过它；检查那次请求出错时这次运行当作已完成（§8）；
- `mori-approval`：`finish` 免批准；模型层：跟在没有工具调用的助手消息之后的请求换模型时不隐藏、不加重做说明，窗口估算加上检查块（§9）；
- 界面：任何地方都不画 `finish`（实时、打开会话、接上运行中的会话、会话引用、阶段行的工具名），只有 `finish` 的助手消息不留空位；
  错误紧跟在这一轮一段没有工具调用的完整回复之后时，错误卡不带放回链接（§10）；
- 合成端点认出检查那一行；现有测试随之调整（§14）。

**不做**（proposal §9“不做”，加上本轮的范围）：

- **第 2 步“过程的折叠”**（proposal §11 最后一行、§13 第 4 条）这一轮不做，留待负责人审完再写规格（§15）。对话流照旧平铺：检查之后接着干活时，前一段回复留在原处成为过程里的一段文字。
- 不把回复放进工具参数；不改流式与 Markdown 渲染；不按回复文字猜模型是不是还没做完。
- 不按调没调过工具、上下文长度、模型能力过滤；不加开关（proposal §12 第 4 条、§13 第 11、13 条）。
- 不在实例会话（task、结案、分开时的立项、临时提问、订阅）和增强任务的看不见的会话里注册 `finish`、检查（proposal §9、§13 第 10 条）。
- 不把 TASTE、REVIEW 全文存进会话；不在每次请求末尾都贴（proposal §12 第 5 条）。
- 不加界面文字、后台进程命令和事件（proposal §6.2 最后一段、§9）：检查那一行是 `custom_message`，界面本来就不画；`finish` 由界面按工具名不画。
- 不改 pi。

**写规格时定的**（2026-10-27 无人模式下按推荐定，**待负责人审**；同时登记在 defaults.md“收尾检查”一节与检查记录）：

| # | 问题 | 定下的 | 理由 |
| --- | --- | --- | --- |
| 1 | 计数从哪条消息往后数 | 上下文里最后一条 `role: 'user'` 的消息（proposal §5.4“最近一条用户消息”取字面）。你的消息、排队与插话、程序投递、扩展用 `sendUserMessage` 发的都是这种消息。第三方扩展用 `sendMessage(…, { triggerTurn: true })` 以 custom 消息开始的运行不单独算，接着前一条 user 消息之后数（§5.2、§5.4 第 11 条） | Mori 与随带的扩展都不这样开始运行（`app/src/` 里没有 `sendMessage`，pi-mcp 也没有 `triggerTurn`）；为少见的第三方写法加一种起点规则不值得 |
| 2 | 压缩把更早的检查行收进摘要 | 从当前分支上数（`runMessages`，§5.2）：压缩只改投影、不删分支上的条目，收进摘要的检查行与 `finish` 照样数得到，上限不跟着从头算（§5.4 第 5 条）。2026-10-27 推送前的完整测试之后改，负责人不在时按推荐定，待复核 | 不另存状态（proposal §13 第 19 条），也守住负责人定的上限（proposal §12 第 3 条）。原来只数投影里还看得到的，以为最多多检查几次；pi 每次运行结束、到边界之前都按最后一条回复的用量做一次阈值检查（§3 第 12 条），`m1-app` 的“刚压缩完”（每次回复之后都压缩、只留最后一条）每次都把上一次检查连同 `finish` 收进摘要，一次运行检查了 23 次、3 分钟没有停 |
| 3 | `finish` 的结果与标签 | 结果正文 `Confirmed.`，`label` 为 `Finish`（§4.1、§7.3） | 结果只给模型看，短、不引出别的动作；`label` 是 pi 的必填字段，界面不显示 |
| 4 | 检查那一行与检查块的写法 | §7.1 的四种原文（按检查块里有的分节）；检查块与 system prompt 的两段同一写法，以一个空行接在检查那一行后面、同一个字符串（§7.2） | proposal §5.5 的大意逐条落实；一条消息、一个字符串，各家服务端都按一段文字收 |
| 5 | 检查那次请求出错（含候选耗尽）时 Team 怎么算 | 当作已完成：等它回复的 `agent_message` 发送方拿到检查之前的最后一段文字（出错消息里流到一半的文字不算）；记一行错误日志（§8.3） | proposal §8 的建议：回复已经完整，出错的只是确认；界面上错误卡照常显示（§10.3） |
| 6 | 一次 pi 运行一份运行记录对哪些会话生效 | 用户会话与各种实例都生效（`runStarted` 共用，§8.1）；强制填写的运行在压缩后重试时另把 `assistants`、`formMode` 清零，重试的请求照样套写法 | 压缩后接着跑（以及文件系统的提醒）在实例上今天就会丢运行记录；共用的前提（proposal §10）不分会话 |
| 7 | 换模型不隐藏的规则对哪些会话生效 | 所有会话：跟在没有 `finish` 以外工具调用的助手消息之后的请求（§9.2）。task 实例在这种请求上换模型时不重来，照普通会话换；这种条目不改同一段里更早的重做说明 | proposal §10 写的就是“跟在没有工具调用的助手消息之后的请求”，不分会话；回复已经完整，没有要重做的过程；`finish` 不算干活（§1），带着自己 `finish` 的回复同样完整 |
| 8 | 错误卡什么时候不带放回链接 | 错误紧跟在这一轮一段没有工具调用的完整回复之后（中间没有你的消息）时都不带，不只检查那次请求（§10.3）。Team 只把检查那次请求的出错当作已完成（§8.3）：只带提醒的那次请求出错（只在第 3 次检查后放行、之后才有你不在时的处理时出现）照旧按出错 | 规则只看对话流，不区分是检查还是你不在时的提醒，两者你的消息都已答完；Team 那边为一个很少见的情形加一条规则不值得 |
| 9 | 检查那次请求里模型的思考 | 照常显示，一块收起的 `Thought process`；只有 `finish`、没有文字也没有思考的那条消息整项不留（§10.1） | 不藏模型写出的东西（proposal §13 第 6 条），思考是模型写的；只有 `finish` 的卡不画（proposal §13 第 3 条）。消息流式时还不知道它会不会只有 `finish`，先藏思考会让它出现又消失 |
| 10 | 文件系统实现后 `finish` 算什么 | 路径闸的 `duty` 种类（免批准、不受收窄），但 `applyDutyTools` 不动它，同 `ask_user_question`（§11） | 协作模式下对话会话收窄为 `{ write: false, mcp: false }`，`mcp: false` 拒绝 `other` 种类的扩展工具，`finish` 必须是 `duty`；它一直启用，不随席位开关 |
| 11 | 界面里“一次运行”的模式 | 界面的 `runTeamMode` 只在这次运行的第一个 `agent_start` 记下（§10.1） | 检查之后的 `agent_start` 属于同一次运行；运行中切换协作模式时，这次运行的工具卡不该改记成新模式 |
| 12 | 合成端点怎样回应检查 | 请求末尾（跳过工作卡、提醒）是检查那一行时，默认只回一个 `finish` 调用、不写字，脚本模式与关键词模式都一样；`-replay`、`-alwaysthink`、`-nooff` 模型照旧带端点的思考。要别的回应时用场景 `fc-scenario:<名字>`（§14.1） | 现有场景脚本不用逐个改（proposal §14）；`-replay` 模型的 `finish` 调用不带思考时下一次请求会被端点按 400 拒绝；收尾检查自己的用例要能造出 a、b、c 与上限 |
| 13 | 测试的名字 | 覆盖检查 `--spec finish`、编号 `FC-n`、结果文件前缀 `fc-`、App 测试端口 4950–4979（§14） | 同其他规格的写法；这段端口没人用 |
| 14 | 回复下的操作行挂在哪 | 助手项里取这一轮最后一个有非空文字的（§10.1）；开了思考时检查那条消息的 `Thought process` 排在操作行之后。回复之后有进展摘要时操作行照旧在摘要下（平行 Agent 规格 §13.3） | 操作行（Copy 等）是对回复正文的；挂在只有思考的那一项上，旧轮次要悬停在思考块上才出现 |
| 15 | 测试里数请求的地方 | 合成端点的日志行给检查那次请求标 `check: true`；§14.4 点名的帮助函数默认跳过它，直接读 `ep.logs`、代理记录的测试自己过滤（§14.4） | 现有几十处按请求数、请求序号的断言不用逐条改；收尾检查自己的用例与“停止后没有请求”的用例显式取它 |
| 16 | 换到推理必须回传（`reasoning.replay: required`）的模型 | 接受：每次确认留下的 `finish` 调用算外来模型的工具调用，纯聊天的会话换到这种模型时也要重建或剥离（模型层规格 §6.2、§6.3），界面多一行重建说明（§9.5） | 不另写只针对 `finish` 的剥离规则（最简单）；写代码的会话几乎每轮都有工具调用，今天本来就要重建 |
| 17 | 检查时停止或出错之后的旧检查行 | 接受：它与你的下一条消息成为连着的两条 user 消息（pi-ai 发请求时去掉停止、出错的那条助手消息），同今天在你的消息之后停止或出错的情形（§7.1） | 不为它另加清理；意思上无害（它只关于紧挨着它的那段回复） |
| 18 | 之后再换模型、要隐藏一段过程时的检查那一行 | 落在隐藏区间里的检查那一行一起隐藏（§9.2） | 回复被隐藏了，留下“关于紧挨着它的那段回复”的检查那一行会让新模型盲确认 |

**语言**：Mori 注入给模型的文字（检查那一行、检查块、`finish` 的说明与结果）用英文（§7）；本步不加界面文字。文档正文、代码注释用中文；代码、日志、错误输出用英文。

## 1. 术语与代码名

| proposal 用语 | 本文与代码中 | 说明 |
| --- | --- | --- |
| 收尾检查 | finish check；`kernel/finishCheck.ts` | 一次运行要结束时 Mori 追加的一次请求 |
| 检查那一行 | check line；`custom_message` 条目，`customType: 'mori.finish_check'`（`FINISH_CHECK_TYPE`），`display: false` | 存进会话文件（§5.5）；pi 把它作为 user 消息发出 |
| 检查块 | check block | 只在检查那次请求里，接进检查那一行（§6） |
| `finish` | `FINISH_TOOL = 'finish'` | §4 |
| 一次运行 | pi 的一次运行：`prompt()`（或程序投递、扩展命令）到 `agent_settled` | 其中可以有多个 `agent_start`（§3 第 2 条） |
| 起点 | 上下文里最后一条 `role: 'user'` 的消息 | 计数从它之后数（§5.2）；与模型层的 anchor 无关 |
| 放行 | release | 处理器不返回结果，pi 照常结束这次运行 |
| 干活 | work | `finish` 以外的工具调用，不论成功、失败还是被拒绝（proposal §4） |
| 确认 | confirmed | 检查之后，一条助手消息里只有一个工具调用、是 `finish`，且它的结果不是错误 |
| 最终回复 | 这次运行最后一段非空文字 | 同 TaskBoard 的 `run.lastText`（`app/src/kernel/team.ts:1249-1254`） |
| 检查那次请求 | 检查那一行加进会话之后的第一次模型请求 | 换模型重发、重试都算这一次 |

## 2. 组件与代码落点

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 共享常量 | `shared/finishCheck.ts`（新） | `FINISH_TOOL`、`FINISH_CHECK_TYPE`、`CHECK_LINE_HEAD`（检查那一行的开头，§7.1）；界面不能 import `kernel/`，所以放在 shared。合成端点照现在 `WORK_CARD_OPEN`、`RESTART_PREFIX` 的做法自留一份，单元测试比对两边相等（`tests/unit/taskboard/text.test.mjs:93-95` 的写法，§14.2 FC-26） |
| 规则与文字 | `kernel/finishCheck.ts`（新） | `FINISH_CHECK_CAP = 3`；`FinishCheckLink`；`finishTool()`（§4.1）；纯函数 `checkLine(kinds)`、`checkBlock(sections)`（§7）、`settleDecision(messages)` 与 `runMessages(branch)`（§5.2）、`checkRequestIndex(messages)`、`withCheckBlock(messages, index, block)`（§6）、`followsCheck(branch)`（§8.3） |
| 扩展 | `kernel/memoryExtension.ts`（改） | `MemorySessionSpec`、`MemorySetupInput` 经 `spec`、`MemoryExtensionSetup` 加 `check: FinishCheckLink \| null`；`memoryExtension` 在 `setup.check` 为真时（写法同 `:208` 的 `if (setup.tool)`）注册 `finish`，`before_agent_start` 记下这次运行的检查块，加 `agent_before_settle`、`context`、`agent_settled` 三个处理器（§4、§5、§6、§9.3） |
| 会话 | `kernel/sessions.ts`（改） | `startUser` 给非增强的用户会话建 `FinishCheckLink`，经 `SessionSetup.memory` 交给 `memorySetup`；用户会话的 `extraContextTokens` 加上它（§9.3） |
| 实例 | `kernel/team.ts`（改） | `instanceSpec` 的 `memory` 加 `check: null`（`app/src/kernel/team.ts:1065`） |
| TaskBoard | `kernel/teamRuns.ts`、`kernel/team.ts`（改） | `runStarted` 一次运行一份运行记录；`laneEvent` 在强制填写的运行压缩后重试时清 `assistants`、`formMode`；`applyDialogTools` 三个分支留 `finish`；`onMessageEnd` 把检查那次请求的出错当作已完成（§8） |
| 批准 | `kernel/approval.ts`（改） | `FREE_TOOLS` 加 `FINISH_TOOL`（§9.1） |
| 模型层 | `shared/models.ts`、`kernel/modelContext.ts`、`kernel/modelSession.ts`（改） | `ModelSwitchEntryData.afterReply`；`followsToolFreeReply`；`switchFrom` 的 `hideUntil`；`notesPerReply` 跳过 `afterReply` 的条目；隐藏区间里的检查那一行一起隐藏（§9.2） |
| 界面 | `renderer/src/state/model.ts`、`transcript.ts`、`history.ts`、`turns.ts`、`actions.ts`、`teamEvents.ts`（改） | 不画 `finish`、只有 `finish` 的消息不留项、回复操作的位置、放回链接（`afterReply`）、`withRunMode`（§10） |
| 合成端点 | `tests/fake-endpoint/scripts.mjs`、`server.mjs`（改），`tests/fake-endpoint/finish.mjs`（新） | 认出检查请求、默认回 `finish`、`fc-*` 场景、日志的 `check`（§14.1） |

`kernel/finishCheck.ts` 不 import pi 的运行时代码，只 `import type`（AGENTS.md 工作约定第 7 条：pi 只在 `kernel/` 里 import，`finishTool` 返回的是普通对象）。

## 3. pi 上的落点（写规格时已核实）

| 项 | pi 1.3.0 的行为 | 位置 |
| --- | --- | --- |
| 1 | `agent_before_settle` 每到运行要结束时都发：`agent.prompt()` 返回、没有要接着跑的（溢出或截断后的压缩重试、排队）之后发；处理器要求接着跑时，`agent.continue()` 返回后再发。你按了停止时不发（`_agentRunAbortRequested` 时 `break`） | `dist/core/agent-session.js:1418-1431`、`1537-1560` |
| 2 | 处理器返回 `continue: true` 且上下文能接着请求时，pi 在**同一次运行**里调 `agent.continue()`：再发一个 `agent_start`、`turn_start`，但不发 `before_agent_start`；`agent_settled` 每次运行只在 `finally` 里发一次 | `agent-session.js:1427-1440`；`pi-agent-core/dist/agent-loop.js:59-70` |
| 3 | `event.outcome` 取最后一个 turn 的助手消息：`stopReason` 为 `aborted` → `aborted`，`error` → `error`，其余（含 `length`、`toolUse`、`stop`）→ `completed` | `agent-session.js:488-490` |
| 4 | `event.context.contextMessages` 是会话投影（加上前面处理器的 `entries`）的 AgentMessage：`custom_message` 条目是 `{ role: 'custom', customType, content, display, details, timestamp }`；工作卡不在里面（它只在 `context` 钩子的副本里）。路由失败（`prepareRequest` 抛错）结束的运行，pi 补的那条出错消息同样经 `turn_end` 把 `outcome` 记成 `error` | `agent-session.js:616-635`、`899-902`；`dist/core/session-manager.js:179-183`；`dist/core/messages.js:57-66` |
| 5 | `emitBoundary` 按扩展顺序逐个调处理器，处理器返回的 `entries` **替换**累计的数组（所以返回 `[...event.entries, 新条目]`），`continue` 取最后一个给出的值；后一个处理器看到的 `event.context` 已含前一个的条目；处理器抛错只记扩展错误 | `dist/core/extensions/runner.js:759-803` |
| 6 | 提交条目后 `canContinue` 要求上下文最后一条不是 assistant：加了 `custom_message`（发出时是 user，`messages.js:89-96`）就成立 | `agent-session.js:616-635`、`1546-1556` |
| 7 | 边界提交的条目只发 `entry_appended`，没有 `message_start`/`message_end` | `agent-session.js:636-641` |
| 8 | `context` 钩子在 `prepareRequest`（模型层的路由、接手判断）**之后**、`convertToLlm` 之前跑；处理器拿到的是去掉 system 的 AgentMessage 副本，可以返回新数组；按扩展顺序 `mori-models`（`processMessages`）、`mori-team`（接工作卡）、`mori-memory`、`mori-approval` | `pi-agent-core/dist/agent-loop.js:123-140`、`263-267`；`runner.js:1006-1035`；`app/src/kernel/sessions.ts:316-317` |
| 9 | 路由（`prepareRequest`）拿到的是 `convertToLlm(会话投影)`：检查那一行是 user 消息、没有检查块、没有工作卡；它后面没有 `role: 'user'` 的 AgentMessage，所以 `reason` 是 `continuation`（不开始模型层的新一段） | `agent-session.js:434-470` |
| 10 | 一批工具结果全带 `terminate` 时循环就此停下；`finish` 单独调用、成功即停。被拒绝、找不到、参数校验失败的调用结果是错误、不带 `terminate`（`tool_call` 的拒绝可以带） | `agent-loop.js:159-167`、`465-467`、`481-530` |
| 11 | 参数按 JSON Schema 编译校验（TypeBox `Compile`），`additionalProperties: false` 生效；没有 `prepareArguments` 时参数原样校验；不合格时工具结果为 `Validation failed for tool "finish": …` | `pi-ai/dist/utils/validation.js:280` 起；`agent-loop.js:468-492` |
| 12 | `stopReason: 'length'` 的消息里的工具调用全部判失败、循环接着跑。没有工具调用的被截断的回复：输出少于这个模型的 `maxTokens` 时（可恢复的截断），pi 在 `_checkCompaction` 里把它从上下文里去掉（`context_edit`）、做溢出压缩、在同一次运行里重试一次，不到边界；重试又被截断时发 `compaction_end` 的错误、再到边界。输出等于 `maxTokens` 时照常结束运行（`outcome` 为 `completed`）。另外每次运行结束、到边界之前，pi 都按最后一条回复的用量做一次阈值检查，超过就压缩（不重试） | `agent-loop.js:155-167`；`agent-session.js:1500-1535`、`2404-2445`；`pi-ai/dist/utils/overflow.js:170-172` |
| 13 | 排队（followUp）与插话（steer）的消息在同一次运行里接着处理：前一段回复之后循环先取它们，处理完才到 `agent_end`、`agent_before_settle` | `agent-loop.js:178-205` |
| 14 | `message_end` 先发给扩展与监听者，**之后**才写进会话文件 | `agent-session.js:752-765` |
| 15 | 扩展工具没有 `promptSnippet` 时不进 system prompt 的工具清单（`memory` 也没有） | `agent-session.js:2873`；`app/src/kernel/memoryText.ts:58-63` |
| 16 | `custom_message` 不进界面：打开会话时 `history.ts` 只画 `type: 'message'` 的条目；实时没有它的 `message_start`（第 7 条） | `app/src/renderer/src/state/history.ts:181` |
| 17 | pi-ai 发请求时去掉 `stopReason` 为 `error`、`aborted` 的助手消息 | `pi-ai/dist/api/transform-messages.js:172-180` |
| 18 | 检查那一行加进会话之后、检查那次请求出去之前，分支上还可能多出：启用的工具变了时 pi 插的 system 消息（`type: 'message'`、`role: 'system'`），路由时超过阈值的压缩条目（`compaction`） | `pi-agent-core/dist/agent-loop.js:116-121`、`241-244`；`agent-session.js:481-483`、`762-765` |
| 19 | `agent_settled` 先发给扩展（`_extensionRunner.emit`），再发给会话的监听者（后台进程的 `forward`） | `agent-session.js:684-694` |

平行 Agent 规格 §14.6 T-F3 已实测：`agent_before_settle` 加条目、`continue: true` 之后同一次运行里多一次请求。本文另外按上表核对了代码。

## 4. `finish` 工具

### 4.1 定义

`kernel/finishCheck.ts` 的 `finishTool(): ToolDefinition`：

| 字段 | 值 |
| --- | --- |
| `name` | `finish` |
| `label` | `Finish` |
| `description` | §7.3 的原文（第一行是人看得懂的一句，Customize 页显示它） |
| `parameters` | `{ type: 'object', properties: {}, additionalProperties: false }`（纯 JSON Schema，同 `memory` 的写法：`as unknown as ToolDefinition['parameters']`） |
| `prepareArguments` | 没有：多余字段不丢掉，由 pi 校验拒绝（proposal §6.1；`memory`、TaskBoard 工具会丢） |
| `promptSnippet`、`promptGuidelines` | 没有：不进 system prompt 的 `<tools>`、`<rules>`（§3 第 15 条），身份段不变 |
| `defaultActive` | `true` |
| `execute` | 不读写任何东西，返回 `{ content: [{ type: 'text', text: 'Confirmed.' }], details: {}, terminate: true }` |

检查之前调用（模型自己提前确认）结果相同；这次调用不算确认，照样检查（§5.4 第 6 条）。

### 4.2 哪些会话注册

`mori-memory` 在 `setup.check` 为真时注册一次（`memoryExtension.ts:206-213` 的工厂里，写法同 `:208` 的 `if (setup.tool)`；§5、§6、§9.3 的三个处理器同一个条件）。
现有单元测试的替身（`tests/unit/memory/text-callers.test.mjs:43`、`text-sections.test.mjs:67`、`:232`、`text-identity.test.mjs:128`、`:170`、`text-guard.test.mjs:24`）建 `MemorySessionSpec` 时不带 `check`，
按这个条件不注册 `finish`，它们不用改：

| 会话 | `check` | 有没有 `finish` |
| --- | --- | --- |
| 用户会话（主 Agent、对话、合并会话） | `startUser` 建的 `FinishCheckLink`（`app/src/kernel/sessions.ts:495-520`） | 有 |
| 增强任务的看不见的会话（`isHeadless`，`app/src/kernel/sessions.ts:387-389`） | `null`（`args.enhance` 不为空） | 没有（proposal §13 第 10 条） |
| 实例会话（立项、结案、task、临时提问、订阅；含增强会话的 Team） | `null`（`app/src/kernel/team.ts:1065` 的 `memory`） | 没有；实例有白名单（`createAgentSession({ tools })`），本来也进不去 |

`sessions.ts` 的 `startUser`：`const check = args.enhance ? null : { pendingTokens: 0 }`，写进 `setup.memory`（`{ enhance: args.enhance ?? null, check }`）；
`extra.extraContextTokens` 改为 `() => (team?.cardTokens() ?? 0) + (check?.pendingTokens ?? 0)`（§9.3）。`MemorySetupInput.spec` 照旧整个交给 `memorySetup`，`memorySetup` 把 `spec.check` 放进返回的设置。

### 4.3 一直启用

- **关闭模式、对话持有者是基座**：pi 按 `defaultActive` 启用；重新打开旧会话（没有 `finish` 时存下的）时，`refreshTools`（`app/src/kernel/sessions.ts:591-597`）把注册了、默认启用、恢复的组合里缺的扩展工具加进去，`finish` 也在内。
- **协作模式，以及关闭模式下对话持有者写了 `tools`**：`mori-team` 每次运行前重设对话会话的工具，`finish` 要留着（§8.2）。
- 启用的工具一变，pi 就记一条 system 补丁、请求的工具定义跟着变（记忆规格 §11.2 M2），所以不随检查开关（proposal §6.1）。

### 4.4 免批准

`app/src/kernel/approval.ts:27` 的 `FREE_TOOLS` 加 `FINISH_TOOL`：`gateFor` 返回 `free`，`announce` 发的 `mori.tool_gate` 为 `free`，不出批准卡；停止中（`approval.ts:180`）同其他免批准工具。

## 5. 什么时候检查：`agent_before_settle`

### 5.1 处理器

`memoryExtension` 在 `setup.check` 为真时注册 `pi.on('agent_before_settle', …)`（函数 `onBeforeSettle(event, ctx, run, link)`，≤ 50 行）：

1. `event.outcome !== 'completed'` → 返回 `undefined`（放行）。停止时 pi 根本不调它（§3 第 1 条）；路由失败结束的运行 `outcome` 是 `error`（§3 第 4 条）。
2. `const decision = settleDecision(runMessages(ctx.sessionManager.getBranch()))`（§5.2）。
3. 放行（`decision.check === false`）：`decision.checks > 0` 时记一行日志（§7.4），返回 `undefined`。
4. 检查：`link.pendingTokens = run.blockTokens`（这次运行检查块的估算，§9.3）；记日志；返回
   `{ entries: [...event.entries, { type: 'custom_message', customType: FINISH_CHECK_TYPE, content: checkLine(run.kinds), display: false }], continue: true }`。
   不带 `details`。

`run` 是 `before_agent_start` 记下的这次运行的 `{ kinds, block, blockTokens }`（§6.3）。处理器不抛错（`settleDecision` 是纯函数，读不出的消息形状按“不是工具调用”处理）。

### 5.2 怎么数：`settleDecision(messages)`

输入是 `runMessages(branch)`：用户会话当前分支上的条目按 AgentMessage 的形状排成的消息（§3 第 4 条的形状）。`message` 条目取它的消息，
`custom_message` 条目为 `{ role: 'custom', customType }`；压缩条目和其他不进上下文的条目（`custom`、`model_change`、`label` 等）跳过，
被 pi 用 `context_edit`（`replacement: null`）去掉的消息跳过（§5.4 第 4 条）。不用 `event.context.contextMessages`：那是压缩之后的投影，
这次运行的检查行与 `finish` 可能已收进摘要（§5.4 第 5 条，§0 第 2 条）。前面的处理器给的 `event.entries` 不在分支上，`mori-memory`
是这个边界的第一个处理器（`mori-approval` 的提醒在它之后，§5.4 第 13 条），所以不缺。不另存状态（proposal §13 第 19 条）：

1. **起点**：最后一条 `role === 'user'` 的消息；没有时从开头数。只看起点之后的消息。
2. 从前往后走：
   - 检查那一行（`role === 'custom' && customType === FINISH_CHECK_TYPE`）：`checks += 1`，清掉“这次检查之后”的两个标记 `worked`、`confirmed`。
   - `role === 'assistant'`：取它的 `toolCall` 块。名字不是 `finish` 的有一个，`worked = true`。只有一个块、名字是 `finish` 时记下它的 `id`（“单独的 `finish`”）。
   - `role === 'toolResult'`：`toolName === 'finish'`、`toolCallId` 是记下的单独的 `finish`、`isError` 不为真 → `confirmed = true`。
   - 其他角色（`custom` 的工作卡不在里面；提醒等别的 custom、`compactionSummary`、`branchSummary`、`bashExecution`）不影响计数。
3. 结果 `{ check: boolean, checks: number, reason }`，按 §5.3 的表取第一条成立的。

“干活”从助手消息里的工具调用块数，不从结果数：被 `mori-team` 或批准拒绝、找不到、参数校验失败、被截断判失败的调用都算（proposal §4）。

### 5.3 决定表

proposal §5.4 的表，按顺序取第一条成立的：

| 顺序 | 条件 | 结果 | `reason`（日志用） |
| --- | --- | --- | --- |
| 1 | `checks === 0` | 检查 | `first` |
| 2 | `confirmed` | 放行（a） | `confirmed` |
| 3 | `!worked` | 放行（c：重写了、什么都没写，或者 `finish` 失败后写了字） | `no work` |
| 4 | `checks >= FINISH_CHECK_CAP`（3） | 放行 | `limit` |
| 5 | 其余：检查之后干了活（b），或 `finish` 与别的调用在同一批 | 检查 | `work` |

### 5.4 边界

| # | 情况 | 怎样 |
| --- | --- | --- |
| 1 | `finish` 和别的调用在同一批 | 那条消息有两个工具调用，不是单独的 `finish`，`worked` 为真；pi 不停（不是一批全带 `terminate`），模型下一条消息之后再到边界 → 第 5 行，再检查（未到上限时） |
| 2 | `finish` 参数校验失败（例如模型把回复写进了参数） | 结果是错误，不算确认；`finish` 不算干活。模型多半接着写正文、再调一次 `finish`：调对了 → 第 2 行；只写了字 → 第 3 行放行，新写的那段就是最终回复 |
| 3 | 排队与插话 | 消息进了上下文就成为新的起点，之后的检查从 0 数；起点之前（对前一条消息的回复、对它的检查）不算。排队的消息在同一次运行里接着处理（§3 第 13 条），所以**只有这次运行最后那条消息的回复过检查**，前面那条的回复不单独检查（它不是这次运行的收尾） |
| 4 | 回复被 `max_tokens` 截断（`stopReason: 'length'`） | 没有工具调用、输出少于模型的 `maxTokens`（可恢复的截断）：pi 先把它从上下文里去掉、压缩、重试一次（§3 第 12 条），不到边界、不检查；那段被截断的文字留在对话流里，模型看不到它；检查跟在重试的回复之后。重试又被截断：界面有 `compaction_end` 的错误卡（§10.3），然后到边界，第 1 行检查（被去掉的那段 `settleDecision` 看不到）。输出等于 `maxTokens`：`outcome` 为 `completed`，第 1 行检查；模型可以接着写完，之后没干活 → 第 3 行放行，接着写的那段是最终回复。有工具调用：pi 把它们判失败、接着跑，在检查之后发生时算干活 |
| 5 | 压缩把起点或检查行收进摘要 | 照样数：`runMessages` 从分支上取，压缩不删分支上的条目，起点、检查行、`finish` 与它的结果都还在（§0 第 2 条）。pi 每次运行结束、到边界之前都按最后一条回复的用量做一次阈值检查（§3 第 12 条），检查那次请求之前也可能压缩（§3 第 18 条），所以检查那次请求可能发在刚压缩过的上下文上（从 `compactionSummary` 开始，你的消息在摘要里）；按投影数时，每次回复之后都压缩、留下的又不到一次检查那么长，每到边界都数不到上一次检查，运行停不下来 |
| 6 | 检查之前就调了 `finish` | `checks === 0` → 第 1 行，照样检查一次（proposal §5.4、§13 第 8 条） |
| 7 | 出错（`outcome: 'error'`） | 处理器返回 `undefined`（§5.1 第 1 步） |
| 8 | 你按了停止 | pi 不调处理器；检查时按停止，检查那一行留在会话里 |
| 9 | 上一次运行留下的检查行（检查时停止、检查出错、后台进程退出） | 在你的新消息之前，不在起点之后，不算；`context` 处理器也不给它接检查块（§6.1）。停止、出错的那条助手消息 pi-ai 发请求时去掉（§3 第 17 条），所以之后每次请求里这行与你的新消息是连着的两条 user 消息（§0 第 17 条） |
| 10 | Mori 开始的用户会话运行（程序投递的唤醒、扩展命令） | 照样检查（proposal §5.4 最后一条）：投递与扩展命令的消息都是 `role: 'user'` |
| 11 | 第三方扩展以 custom 消息开始的运行 | 不单独计数（§0 第 1 条）：起点是前一条 user 消息，前一次运行的检查行算进来，多半按第 2 行放行 |
| 12 | 运行中切换协作模式 | 检查那一行与检查块用这次运行开始时记下的种类（§6.3），下一次运行跟着变 |
| 13 | 你不在时的提醒（文件系统规格 §9.8）在同一个边界 | 它的处理器在 `mori-approval`，排在后面：返回 `[...event.entries, 提醒]`，合成一次请求，顺序 [检查那一行，提醒]；提醒不是 user 消息，不移动起点。用户会话里提醒因此跟在检查那一行之后，不再紧跟助手消息，也不另多一次请求（§11） |
| 14 | 一次运行里检查之后又排队了消息 | 检查那次请求之后 pi 先处理排队的消息（第 3 条），再到边界：起点是那条消息，从 0 数 |

### 5.5 检查那一行

存进会话文件的 `custom_message` 条目：`customType: 'mori.finish_check'`，`content` 为 §7.1 的原文（字符串），`display: false`，没有 `details`。
每次检查一条；只追加，随压缩进摘要。增强任务读会话时会看到它：它是 `type: 'custom_message'` 的条目，不是 `role: 'user'` 的消息，
增强任务的任务段只把用户的话当依据（TASTE：`Evidence is the user's words only`，记忆规格附录 B），所以不改增强任务的第一条消息（proposal §10“提示词分层与记忆”）。

## 6. 检查那次请求：`context` 处理器

### 6.1 找检查那一行：`checkRequestIndex(messages)`

`context` 钩子的消息（§3 第 8 条）在 `mori-memory` 这里已经过模型层的处理，末尾可能已有 `mori-team` 接的工作卡。从末尾往前走：

- `role === 'custom' && customType === FINISH_CHECK_TYPE` → 返回它的下标（这次请求就是检查那次请求）；
- 其他 `role === 'custom'`（工作卡 `mori.work_card`、提醒 `mori.away_reminder` 等）→ 跳过；
- 遇到别的角色（user、assistant、toolResult、摘要等）→ 返回 `-1`。

所以检查那一行在 [检查那一行，提醒，工作卡] 的第一个也能找到（proposal §5.5）；检查之后模型干了活，下一次请求最后是工具结果，找不到；
上一次运行留下的检查行后面跟着你的新消息（user），找不到。

### 6.2 接上检查块：`withCheckBlock(messages, index, block)`

`index >= 0` 且这次运行有检查块（`run.block !== null`）时，返回新数组，`index` 处换成一条新消息：同一条 custom 消息，`content` 为
`` `${原文}\n\n${block}` ``（原文是字符串；万一是内容块数组，在最后加一个 `{ type: 'text', text: `\n\n${block}` }`）。其余消息原样。
会话文件里的条目不变（pi 给处理器的是副本，§3 第 8 条）。没有检查块时不改（检查那一行用不点名分节的那种原文，§7.1）。

处理器（`pi.on('context', …)`，在 `setup.check` 为真时注册）：先 `link.pendingTokens = 0`（这次请求的检查块已在消息里，§9.3），再按上面两步返回 `{ messages }` 或 `undefined`。
同一个条件下还注册 `pi.on('agent_settled', () => { link.pendingTokens = 0; })`（检查那次请求没走到 `context` 钩子就结束时清掉，§9.3）。

### 6.3 种类在这次运行开始时定下

`before_agent_start` 的 `writePrompt`（`app/src/kernel/memoryExtension.ts:115-125`）已经算出这次运行的分节 `memorySections(snapshot, kindsFor(seats()))`。
`setup.check` 为真时，同一个处理器里接着记下这次运行的 `run`：

- `kinds`：`taste`、`review` 两段里内容不为 `null` 的（按 `taste`、`review` 的顺序）；
- `block = checkBlock({ taste: sections.taste, review: sections.review })`（§7.2，两段都为 `null` 时 `null`）；
- `blockTokens = block === null ? 0 : cardTokens(`\n\n${block}`)`（`app/src/kernel/boardText.ts:48-50`，与工作卡同一个估算）。

`before_agent_start` 每次运行只发一次（§3 第 2 条），所以检查之后的接着跑不改它；运行中切换协作模式不影响这次运行（proposal §9）。
席位按 prompt-and-memory §5.1：主 Agent 拿 `taste`、`review`；对话只拿 `taste`；合并会话（对话兼立项）是 `taste`（立项没有 `review`）。

### 6.4 位置与顺序

| 协作模式 | 检查那次请求的最后几条 |
| --- | --- |
| 关闭 | …助手的回复，检查那一行（含检查块） |
| 打开（工作卡） | …助手的回复，检查那一行（含检查块），工作卡 |
| 文件系统实现后、同时有提醒 | …助手的回复，检查那一行（含检查块），提醒，[工作卡] |

协作模式关闭、没有提醒时检查那次请求里没有连着的 user 消息；有工作卡、提醒时同现在的工作卡（proposal §8 严格交替一行）；检查时停止或出错之后的情形见 §7.1。
下一次请求（`finish` 之后，或你的下一条消息）里检查那一行只剩原文；缓存的情形见 proposal §5.5。

## 7. 模型看到的文字（英文原文）

### 7.1 检查那一行：`checkLine(kinds)`

四行，`\n` 分隔；第三行按 `kinds`（§6.3）选，没有时整行去掉：

```text
[Mori] This is Mori's end-of-turn check, not a message from the user. It is about your reply just before it.
If you said you would do something and haven't done it, or a tool call you meant to make was never sent, do it now with your tools. Don't retry calls that were rejected or denied.
Otherwise check that reply against <taste> and <review> below.
Anything you write now is shown to the user as your reply. If that reply is final, including a question that waits for the user's answer, only call finish. To change it, write the new reply, then call finish.
```

| `kinds` | 第三行 |
| --- | --- |
| `['taste', 'review']` | `Otherwise check that reply against <taste> and <review> below.` |
| `['taste']` | `Otherwise check that reply against <taste> below.` |
| `['review']` | `Otherwise check that reply against <review> below.` |
| `[]` | 没有这一行 |

- `CHECK_LINE_HEAD` = 第一行开头的 `[Mori] This is Mori's end-of-turn check`（合成端点与测试认它，§14.1）。
- 落实 proposal §14“构建规格定”的四点：自报来自 Mori、不是你的话（协作模式关闭时没有别处解释 `[Mori]`）；只点名检查块里有的分节；写明现在写的字会作为回复显示、确认就只调 `finish`；
  过期的那行无害：第一行说明它只关于紧挨着它的那段回复，之后的请求里它后面跟着 `finish` 或你的新消息。
  “无害”只说意思：检查时停止、出错或后台进程退出之后，那条助手消息在之后的请求里被 pi-ai 去掉（§3 第 17 条），这行与你的下一条消息成为连着的两条 user 消息，
  同今天在你的消息之后停止或出错的情形，接受（§0 第 17 条；要求严格交替的服务端上会回 400，FC-27 有这样的服务时记下）。
- 第二行只让模型补上**没发出去**的调用，并写明被拒绝的不重试：同身份段的 “follow it and don't repeat the call”（`app/src/kernel/memoryText.ts:22`）与文件系统规格的
  “Don't retry it.”、“Don't retry the denied calls.”（file-system.md §14），这些可能出现在同一次请求里（§6.4）。
- `\n\n` 之后接检查块时，第三行的 “below” 指的就是它；之后的请求里检查块不在了，那行原文不变。
- 量：四行的那种 560 字符、104 个词，约 140 token（字符数 ÷ 4，不含检查块）；加上 `finish` 调用与 `Confirmed.`，会话文件每次检查多约 160 token，一次运行最多 3 次（proposal §4、§8 的数字随之改）。改原文时更新这一条。

### 7.2 检查块：`checkBlock(sections)`

与 system prompt 里那两段同一写法（pi `dist/core/system-prompt.js:115-119`：`<名字>\n内容\n</名字>`；内容是 `memorySections` 的每行 `- <abstract>`，用户级在前、本项目在后）：

```text
<taste>
- …
</taste>
<review>
- …
</review>
```

两段之间一个 `\n`；只有一段时就是那一段；都没有时为 `null`。接进检查那一行时前面加 `\n\n`（§6.2）。不算进记忆的 2500 预算（proposal §10，同工作卡）。

### 7.3 `finish` 的说明与结果

说明（`description`，第一行 Customize 页显示；2026-10-27 注：Customize › Tools 展开一行时显示全文，所以第二行的撇号用 ’，
同 subagent 的说明，见 `docs/v1/walkthrough-1026-checks.md` 的 U49）：

```text
Confirm that your last reply is your final reply.
Call this only when Mori’s end-of-turn check asks for it. Write your reply as normal text first: finish takes no arguments, and anything passed to it is rejected.
```

结果：`Confirmed.`（§4.1）。参数不合格时的结果是 pi 自己的 `Validation failed for tool "finish": …`（§3 第 11 条），Mori 不另写。

### 7.4 日志（英文，`console.log`，同其他 `[kernel]` 行）

| 时机 | 原文 |
| --- | --- |
| 加检查 | `[kernel] <sessionId>: finish check <n> (<reason>)`（`n` 是加上这次之后的 `checks`，`reason` 为 `first` 或 `work`） |
| 检查过之后放行 | `[kernel] <sessionId>: finish check passed (<reason>)`（`confirmed`、`no work`、`limit`）；没检查过（`outcome` 不是 `completed`）不记 |
| 检查那次请求出错按已完成算（§8.3，`console.error`） | `[kernel] <sessionId>: the finish check request failed (<errorMessage>); the run counts as completed` |

`sessionId` 取 `ctx.sessionManager.getSessionId()`。真实模型走查按这些行和会话文件统计 a、b、c（§14.2 FC-27）。

## 8. `mori-team` 的配合改动

### 8.1 一次 pi 运行一份运行记录：`runStarted`

`app/src/kernel/teamRuns.ts:45-66` 的 `runStarted(team, lane)` 开头加：`lane.run !== null` 时直接返回（同一次 pi 运行里再来的 `agent_start`：检查、溢出压缩后接着跑、文件系统的提醒）。
`lane.run` 在 `runEnded`（`teamRuns.ts:152-155`，`agent_settled` 时）同步置空，所以下一次运行的第一个 `agent_start` 照常新起。所有会话都这样（§0 第 6 条）。

不再在同一次运行里重做的：`newRun`（`batch`、`judgment`、`command`、`lastText`、`assistants`、`handedOff` 等都留着）、`run.allowed`（对话的 `tool_call` 限制）、`team.nextUserRun` 的重置（它在第一个 `agent_start` 已被取用）、
`lane.sentThisTurn = 0`（关闭模式每轮的提问上限）、`team.flow.takeCommand()`、`team.flow.userRunStarted()`、`closeRunStart`、`startUserJudgment`/`startJudgment`、`lane.modelNote = null`。
这正是 proposal §10 要的：检查之后 `run.lastText` 仍是这次运行最后一段非空文字（不再是 `It ended without a reply.`），合并会话的判断照常写 `mori.progress`、提醒没有 task 的需求，工具限制在检查之后仍有效。

**强制填写的运行压缩后重试**（平行 Agent 规格 §7.5）：`shapeAttempt`（`team.ts:1529-1536`）只在 `run.assistants === 0` 时套写法，`forcedEnded`（`teamRuns.ts:345-363`）按 `run.formMode` 判断。
pi 对溢出出错或可恢复的截断压缩后在同一次运行里重试（§3 第 12 条），那次重试的请求以前因为新起的运行记录而重新套写法；现在运行记录不换，所以
`laneEvent`（`team.ts:1205-1229`）加一种事件：实例会话 `compaction_end` 且 `willRetry` 为真、`run.forced` 不为空时，`run.assistants = 0`、`run.formMode = null`，重试的请求照样套写法。
用户会话没有强制填写，不受影响。

### 8.2 对话会话的工具里留 `finish`：`applyDialogTools`

`app/src/kernel/team.ts:1426-1449` 的三个分支：

| 分支 | 什么时候 | 改法 |
| --- | --- | --- |
| `listed !== null` | 协作模式；关闭模式下对话持有者写了 `tools` | `entries` 在现有的 `memory` 之后再加 `FINISH_TOOL`（不论模式、合并与否）。`entries` 也是 `run.allowed`，所以 `guardCall`（`team.ts:1517-1525`）的 `matchesToolEntries(run.allowed, 'finish')` 为真，不出 `RELAY_ONLY` 或 `… is not one of <role>'s tools.` |
| `listed === null`，没有要恢复的 | 关闭模式、基座 | 不改：启用的工具里本来就有 `finish`（§4.3） |
| `listed === null`，`restoring !== null` | 从协作模式回到关闭模式，恢复最后一条 `mori.team` 的 `tools` | `wanted.add(FINISH_TOOL)`，同现在的 `wanted.add(MEMORY_TOOL)`（记下的那一组早于收尾检查时没有它）；`next` 照旧只留已注册的 |

没注册 `finish` 的用户会话（增强会话的 Team，`always` 模式）：`registered` 里没有它，不启用；`run.allowed` 里有它也无妨（调用时 pi 回 `Tool finish not found`，在 `tool_call` 之前）。
`userToolNames`、`registerUserTools` 不变（`finish` 由 `mori-memory` 注册）。

### 8.3 检查那次请求出错：当作已完成

`app/src/kernel/team.ts:1246-1254` 的 `onMessageEnd`：用户会话（`lane === this.user`）的助手消息 `stopReason === 'error'`，且 `checkLineIndex(this.branchOf(lane))` 找得到检查那一行（`followsCheck` 为真）时：

- `run.error` 设为 `null`（不记这个错误），记 §7.4 的错误日志；
- 这条消息**不**更新 `run.lastText`：出错的消息可能带着流到一半的文字（pi-ai 出错时带着已收到的部分，模型层对有内容之后的失败原样传下去），
  所以 `run.lastText` 取检查之前的最后一段非空文字：`textBeforeCheck(branch, 检查那一行的下标)`，从检查那一行往前走到最近一条 user 消息，跳过被 `context_edit` 去掉的消息；
  没有时不改。只“不更新”不够：检查那次请求的回复被可恢复地截断（§3 第 12 条）时，那条被截断的消息在它自己的 `message_end` 已改过 `run.lastText`，
  pi 随后去掉它、压缩、重试，重试再出错时要换回检查之前的那段（2026-10-27 发起会话评审实现时补，检查记录“实现的第二轮评审”）。

用户会话里读 `run.error` 的只有 `settleWaiters`（`teamRuns.ts:170-180`），所以效果就是：等这个会话回复的 `agent_message` 发送方拿到检查之前的那段回复，不按失败（§0 第 5 条）。
合并会话的判断由 `runEnded`（`teamRuns.ts:160`）里的 `endJudgment`（`teamRuns.ts:115-131`）照常结束、写 `mori.progress`，本来就不读 `run.error`，不受影响；
`decisionNote`（`teamFlow.ts:102-109`）只在分开时立项会话的 `createRunEnded` → `judgmentEnded` 里用，用户会话不经过。

`followsCheck(branch)`（`kernel/finishCheck.ts`，纯函数）：从当前分支末尾往前走，

- 跳过不进上下文的条目（`custom`、`model_change`、`thinking_level_change`、`label`、`session_info` 等，即 `type` 不是 `message`、`custom_message`、`compaction`、`branch_summary` 的）；
- 跳过末尾一条 `stopReason === 'error'` 的助手消息条目（`message_end` 先发给监听者、后写盘，§3 第 14 条，这条可能已在也可能还不在分支上）；
- 跳过被 pi 用 `context_edit`（`replacement: null`）从上下文里去掉的消息：检查那次请求的回复被可恢复地截断、或溢出出错时，pi 去掉它、压缩、在同一次运行里重试（§3 第 12 条），
  重试仍是检查那次请求（§1），那条去掉的消息（`stopReason` 为 `length` 或 `error`）还在分支上；只改内容的 `context_edit` 不算去掉；
- 跳过 `customType` 不是 `mori.finish_check` 的 `custom_message`（提醒）；
- 跳过 `role === 'system'` 的 `message` 条目（启用的工具变了时 pi 插的补丁）与 `compaction` 条目（检查那次请求路由时的阈值压缩）：它们可能落在检查那一行与出错的消息之间（§3 第 18 条）；
- 遇到 `mori.finish_check` → 真；遇到别的（user、assistant、toolResult 的 `message`，`branch_summary`）→ 假。

只对用户会话：实例会话没有检查那一行。候选耗尽（模型层在路由里抛出 `No model available …`，pi 以错误消息结束运行）走同一条路，界面另有 “No model available” 卡（§10.3）。
检查之后干了活（b）、之后的请求出错：分支末尾是工具结果，`followsCheck` 为假，照旧按出错。你在检查时按了停止：照旧按停止（`STOPPED_BY_USER`，`teamRuns.ts:175`）。
只带你不在时的提醒、没有检查那一行的那次请求出错（只在第 3 次检查后放行时出现）：`followsCheck` 为假，照旧按出错（§0 第 8 条）。

### 8.4 其余不变

- `run.lastText`：仍是最后一段非空文字（`team.ts:1249-1254`），可能是模型调 `finish` 时写的那句（proposal §4）；例外是 §8.3 检查那次请求出错的那条消息。
- 用户会话的 `agent_settled` 晚一次请求，等它的投递跟着晚（平行 Agent 规格 §5.6）；工作卡仍在最后（§6.4）。
- `tool_execution_start` 时 `lane.current = toolBrief('finish', …)`（`team.ts:1214-1216`）：用户会话的 `current` 不在任何视图里（`taskLive` 只读 task 实例，`team.ts:573-583`），不改。
- 实例会话的结束（平行 Agent 规格 §9.4 的表）不变；分开时立项看到的对话（§8.4）取对话 Agent 的正文，重写（c）时两段都在。

## 9. 批准与模型层的配合改动

### 9.1 免批准

见 §4.4。

### 9.2 换模型不隐藏：`switchFrom`

`kernel/modelContext.ts` 加纯函数 `followsToolFreeReply(messages: readonly MessageLike[]): boolean`（两种消息形状都适用，同这个文件的其他函数）。两条都成立时为真：

- 上下文里有最后一条 `role === 'assistant'` 的消息，它的内容里没有 `name` 不是 `finish` 的 `type === 'toolCall'` 块；
- 它之后没有 `toolName` 不是 `finish` 的 `role === 'toolResult'` 消息。

（2026-10-27 实现时补，待负责人审：`switchFrom` 另传这一段的开始 `reply.startedAt`，那条助手消息的时间戳早于它时为假。
包装里换模型时消息已经过 `processMessages`，同一段里先隐藏过一次之后，上下文里最后一条助手消息可能是更早一次运行的回复；
不加这一条，第二次换模型的条目会带 `afterReply`、重做说明错写成第一次的模型，MP-15 的情形就变了。函数签名为
`followsToolFreeReply(messages, since?)`，FC-21 加了这一例。）

`finish` 不算（同 §1 的“干活”）：带着自己 `finish` 的回复（§5.4 第 6 条，`fc-early`）同样完整，隐藏了它，检查那一行就指向空处。两种形状的 `toolCall` 块都有 `name`、工具结果都有 `toolName`，
这个文件里读内容块的 `ContentBlock`（`modelContext.ts:19-26`）加 `name`。

`shared/models.ts:1026-1044` 的 `ModelSwitchEntryData` 加一个可选成员（Doxygen 注释）：`/** 跟在没有工具调用的助手消息之后的请求上换的（收尾检查规格 §9.2）：不隐藏，也不改这段的重做说明 */ afterReply?: boolean`。
`app/src/kernel/modelSession.ts:1375-1398` 的 `switchFrom` 算条目时：`followsToolFreeReply(base)` 为真则 `hideUntil: reply.startedAt`、`afterReply: true`，否则照旧 `hideUntilOf(base, reply.startedAt)`、不写 `afterReply`。
`switchFrom`、`restartFrom` 的注释（`modelSession.ts:1366-1374`、`1399-1407`）随之写明这个条件。

- 这条条目没有隐藏区间（`hiddenRanges` 跳过 `hideUntil` 不晚于 `replyStartedAt` 的），`mori.model_switch` 的 `hidden` 为假；
  task 实例的 `entry.hideUntil > entry.replyStartedAt` 不成立，不走 `restartFrom`，照普通会话换（§0 第 7 条）。
- `notesPerReply`（`modelContext.ts:190-197`）跳过 `afterReply` 的条目：同一段里没有更早的隐藏时不加重做说明；有更早的隐藏（例如前面中途换过一次）时，说明仍取那条更早的条目的 `from` 与原因，
  不改成检查这次的。模型层规格 §6.1 的“`<from>`、`<reason>` 取最后一条条目”改为“取最后一条不带 `afterReply` 的条目”，MP-15（`tests/unit/modelContext.test.mjs:265-273`）不变。
- 两条路都经 `switchFrom`：路由时（`routeTurn`，`modelSession.ts:1330-1344`，消息是会话投影，检查那一行没有检查块）与包装里有内容之前失败（`afterFailure`，`modelSession.ts:440-466`，消息已过 `context` 钩子，检查那一行带检查块）。
- 换模型重发（`retarget`，`modelSession.ts:670-677`）：`processMessages` 不动 user 与 custom 消息，检查那一行连同检查块保留，工作卡照旧拿下再接回。
- 这一段之后再换模型时，上下文最后一条助手消息有 `finish` 以外的工具调用（b 之后）则照旧按 `hideUntilOf` 隐藏；规则只看换模型那一刻的上下文。
- **隐藏区间里的检查那一行一起隐藏**（§0 第 18 条）：b 之后再换模型、隐藏 [replyStartedAt, hideUntil] 时，回复与之后的工作都被隐藏，留下的检查那一行（“关于紧挨着它的那段回复”）会让新模型盲确认。
  所以 `isHidden`（`modelContext.ts:83-87`，`hiddenBy`、`applySwitchEntries` 与 `stripForCompaction` 都经它）也把时间戳落在区间里的检查那一行算作隐藏：AgentMessage 形状是
  `role === 'custom' && customType === FINISH_CHECK_TYPE`，pi-ai 形状是全部文字以 `CHECK_LINE_HEAD` 开头的 `role === 'user'` 消息（同 `isWorkCard` 的认法，常量从 `shared/finishCheck.ts` import）。
  它去掉之后 `noteTarget` 回到 anchor，重做说明加在 anchor 上。只靠 `mori-memory` 的 `context` 处理器不够：换模型那一次的请求由 `retarget` 用 `processMessages` 重组，`context` 钩子已经跑过。
  `settleDecision` 不变：它读分支上的记录（`runMessages`，§5.2），隐藏只改请求、不改分支，仍数得到那一行与 b 的工作，新模型重做后没有工具调用的回复照样再检查（§5.3 第 5 行）。
- 在新的一段（排队消息开始的段）开头，`reply.startedAt` 晚于之前的回复，两种算法结果相同。

### 9.3 窗口估算加上检查块

接手判断与窗口估算（`checkHandover`，`modelSession.ts:1478-1488`）用 `extraContextTokens` 加上不在消息里的部分（今天是工作卡）。检查块在两条路上：

| 路 | 消息里有没有检查块 | `pendingTokens` |
| --- | --- | --- |
| 路由（`prepareRequest`，`context` 钩子之前） | 没有 | 检查时（§5.1 第 4 步）设为这次运行的 `blockTokens` |
| 包装（`context` 钩子之后） | 有（在检查那一行里） | 检查那次请求的 `context` 处理器已清 0（§6.2） |

所以检查那次请求走到 `context` 钩子时，检查块在两条路上都只算一次。检查那次请求也可能没走到 `context` 钩子就结束：路由时候选耗尽（§8.3），
在路由的 §5.8 等模型时（`routeTurn`、`switchFrom`、`selectSegment`）按了停止，或在边界与 `agent.continue()` 之间按了停止。这时由 `mori-memory` 的 `agent_settled` 处理器清 0（§6.2）：
pi 先把 `agent_settled` 发给扩展、再发给后台进程（§3 第 19 条），所以下一次运行的 `prepare()`（`startHandover` → `checkHandover`，在任何 `context` 钩子之前）看不到旧的值；
只在 `before_agent_start` 清太晚（准备中的接手判断在它之前）。

`pendingTokens` 只给估算用；`FinishCheckLink` 是 `kernel/finishCheck.ts` 的接口（`/** 检查那次请求的检查块的 token 估算；那次请求的 context 处理器跑过之后、或这次运行 agent_settled 之后为 0 */ pendingTokens: number`），
一个用户会话一份，`sessions.ts` 与 `mori-memory` 共用。增强会话与实例没有它（`extraContextTokens` 不变）。

窗口判断只在选新模型时做：检查那次请求换模型时（`switchFrom`、`selectSegment` 经选择器第 6 步的段内接手判断），窗口放不下“上下文 + 检查块 + 最大输出”的候选被排除；
段内正在用的模型只经 `checkCurrent`（选择器第 1、4 步），不做窗口判断。

### 9.4 不变的

检查那次请求是这一段里的普通请求：同一个模型（`ReplyState.current`）、同一个调度类别（`conversation`）、同样的重试与换模型；思考强度用会话的（proposal §13 第 12 条）。

### 9.5 换到推理必须回传的模型（§0 第 16 条）

接手判断（模型层规格 §6.2）把外来模型的助手消息里的任何工具调用都算进“推理条件”。收尾检查之后，每次确认都留下一条当前模型的、带 `finish` 调用的助手消息，
所以以后换到 `reasoning.replay: required` 的模型时，即使这个会话只聊过天，也要在段开始时重建、在段内剥离（模型层规格 §6.3），界面多一行 `Rebuilt the conversation for <B>…`，可能多一次压缩请求。
本文接受这一点，不另写只针对 `finish` 的剥离规则：写代码的会话几乎每轮都有 `read`、`bash` 之类的调用，今天换到这种模型本来就要重建。模型层规格 §6.2 加注（§13）。
另一种做法（`hasForeignToolCalls` 不算 `finish`，换到这种模型时在请求里去掉外来的 `finish` 调用与结果）登记在 defaults.md，待负责人审。

## 10. 界面

### 10.1 不画 `finish`

界面按工具名认：`renderer` import `shared/finishCheck.ts` 的 `FINISH_TOOL`。

| 地方 | 文件与函数 | 改法 |
| --- | --- | --- |
| 回复结束、打开会话、接上运行中的会话、会话引用的 `[Tool]` 行 | `renderer/src/state/model.ts:331-346` 的 `blocksFromContent`（`transcript.ts:101-113` 的 `applyAssistantEnd`、`history.ts:45-56` 的 `addAssistant`、`history.ts:222-243` 的 `resumeTools`/`resumeStreaming`、`sessionRefs.ts:51-60` 的 `assistantLines` 都经它） | `finish` 调用换成 `{ type: 'text', text: '' }`（保住与 pi `contentIndex` 对齐的下标，同 :343 对认不出的部分），不进 `tools` |
| 写调用的增量 | `transcript.ts:73-85` 的 `applyToolCallUpdate` | `update.toolName` 为 `FINISH_TOOL` 或空字符串时不写 tool 块、不建 ToolCall；阶段照样设为 `generating`（`Responding…`，proposal §13 第 5 条）。空字符串：pi-ai 可能在名字到之前先发 `toolcall_start`（`pi-ai/dist/api/openai-completions.js:296-340`：第一块没有名字时 `name` 为空字符串，之后才补上），那时还不知道是不是 `finish`；平常的工具从第一个带名字的增量起出卡，`applyAssistantEnd` 照旧补全参数 |
| 开始执行 | `transcript.ts:194-207` 的 `applyToolStart` | `event.toolName === FINISH_TOOL` 时原样返回：不加块、不改阶段 |
| 执行中、结束 | `transcript.ts:231-246` 的 `applyToolExecution` | 按 `event.toolName` 跳过（`updateTool` 会补建缺的 ToolCall，`transcript.ts:34-37`，只按 id 跳不够） |
| 批准闸 | `transcript.ts:214-225` 的 `applyToolGate` | `event.toolName === FINISH_TOOL` 时原样返回（`mori.tool_gate` 带工具名，`app/src/kernel/approval.ts:156-160`；`finish` 免批准，不会有 `mori.approval_request`） |
| 阶段行 | 不改 `components/StageLine.tsx` | 上面几处保证 `finish` 不进 `state.tools`，`runningToolStage`（`transcript.ts:168-177`）不会选到它，阶段行不出现 `finish 0s` |
| 只有 `finish` 的助手消息 | `model.ts` 加 `finishOnly(content)`：有 `finish` 调用、没有别的工具调用、没有非空的文字与思考块（只看内容，不看 `stopReason`）；`transcript.ts:101-113` 的 `applyAssistantEnd`、`history.ts:45-56` 的 `addAssistant` | 实时：消息开始时照常推一项（`transcript.ts:139-145`，那时还不知道内容）；`applyAssistantEnd` 发现 `finishOnly` 时去掉的正是 `updateLastAssistant` 改的那一项，即 `message_start` 或 `resumeStreaming` 推的那条 `streaming: true` 的项。打开会话、接上运行中的会话：已写进会话文件的只有 `finish` 的消息，`addAssistant` 不加它那一项，但照旧按 `stopReason` 做 `:51-55` 的事（`aborted` 或匹配 `ABORTED_REPLY` 的 `error` 推一项 `stopped`，其余 `error` 推一张 `restore: null` 的错误卡，同实时的 `applySettled`、`agent_end`）；正在生成的那条由 `resumeStreaming`（`history.ts:236-243`）照常推一项，内容还可能变长，由它的 `message_end` 去掉；`resumeStreaming` 把名字还没到的工具调用（空字符串）先换成空的正文段、不出卡，同上面“写调用的增量”一行（2026-10-27 发起会话评审实现时补）。所以那条消息的 `message_end` 之后对话流里没有空的 `div[data-item]`（`Transcript.tsx:332`）；它的 `message_start` 到 `message_end` 之间对话流末尾有一项没有内容、没有高度的助手项，同今天任何助手消息第一个增量之前那一段，按项数、按最后一项的代码只在 `agent_settled` 之后读。只有 `finish` 和思考的消息照常是一项，`AssistantMessage.tsx:44-52` 只显示一块 `Thought process`（流式时展开的 `Thinking…`，结束时收起，§0 第 9 条） |
| 回复下操作行的位置 | `renderer/src/state/turns.ts:35-51` 的 `replyTurns` | 只改 Map 键（`:38`、`:47` 的局部 `anchor`）里助手项的那一支：助手项有非空文字、或这一轮还没有过有文字的助手项时才成为键。回复之后的 `progress` 项照旧取键（`:47`，平行 Agent 规格 §13.3、TB-37）：合并会话的 `mori.progress` 在 `agent_settled` 时写、在检查之后，操作行仍在进展摘要下。`ReplyTurn.anchor`（`toTurn`，第一个有文字的项，`turnSource` 给 “Attach message as context” 用）不变。于是旧轮次的悬停显示（`styles/quotes.css:129` 的 `[data-item]:hover > .reply-actions`）在回复正文那一项上（§0 第 14 条） |
| 这次运行的模式 | `renderer/src/state/transcript.ts` 新的纯函数 `withRunMode(state, event, mode)`；`renderer/src/state/actions.ts:419` 改为调它 | `event.type === 'agent_start' && !state.running` 时返回 `{ ...state, runTeamMode: mode }`，否则原样返回；`handleEvent` 写成 `applyEvent(withRunMode(t, event, tab.team.mode), event, now)`（§0 第 11 条） |

Copy、“Attach message as context” 与反馈取 `turn.text`（`turns.ts:20-29`，全轮非空文字块，空字符串块不进去），不用改。
Customize 页不用改：`resources.ts:228-247` 列出 `getAllTools()` 里不是 `hidden` 的工具，`<inline:mori-memory>` 的来源写 `Mori`，说明取第一行（`ToolsBuiltin.tsx:17-24`）。

### 10.2 阶段行、停止按钮与侧栏

不加文字，照常按事件（proposal §5.1、§13 第 5 条）：回复的助手消息 `message_end` 把阶段清空 → 检查那次请求的 `turn_start` 显示 `Waiting for the model… Ns`
→ 开了思考时 `Thinking… Ns` → 写 `finish` 调用的那一下 `Responding…` → 那条消息结束清空 → `agent_settled`。
`agent_start` 再来一次时 `running` 本来就是真（`transcript.ts:428-429`），`agent_end` 没有待显示的错误时不做事（`transcript.ts:432-437`），所以同一次运行里多一组事件不闪。
停止按钮到 `agent_settled` 才消失；侧栏的 Running 同样；不在前台时 Unread 只在 `agent_settled` 标一次（`actions.ts:360`、`430-432`）。

### 10.3 错误卡不带放回链接

`renderer/src/state/model.ts` 的 `Transcript` 加 `afterReply: boolean`（这一轮里最近一条助手消息完成了一段没有工具调用的回复；`emptyTranscript`，`model.ts:232`，为 `false`）。
规则放在 `model.ts` 的一个纯函数 `afterReplyOf(content, stopReason, current)` 里，实时与打开会话两处共用，不会各写一套：

- `stopReason` 是 `error`、`aborted` → 返回 `current`（出错与中止的消息不改它）；否则有 `finish` 以外的工具调用 → `false`；否则有非空文字 → `true`；都没有（只有 `finish`、只有思考、空）→ `current`。
- 实时：`applyAssistantEnd`（`transcript.ts:101-113`）用它更新；`applyUserStart`（`transcript.ts:134`）与程序投递的 `takeWake`（`teamEvents.ts:73`）置 `false`（新的一轮）。
- 打开会话、接上运行中的会话：`transcriptFromEntries`（`history.ts:203-209`）按同一个规则维护——`addAssistant`（`history.ts:45-56`）用 `afterReplyOf` 更新，`addEntry` 里 user 消息的条目（`history.ts:183-186`）置 `false`
  （之后被 `mori.wake` 认作投递的也一样），所以界面重新加载后接上一个正在检查的会话（`projects.ts:269-270` 的 `attachLive`）也带着它。
- `agent_end`（`transcript.ts:432-437`）与 `compaction_end` 的错误（`transcript.ts:446`）推错误卡时：`afterReply` 为真则 `restore` 为 `null`，否则照旧 `state.lastUserText`。

`restore` 为 `null` 时错误卡只显示原文（`Transcript.tsx:29-38`）；侧栏照旧按最后一项是实时错误卡显示 Error（`sessionRows.ts:45-54`）。
候选耗尽时界面照旧只显示 “No model available” 卡，不另显示错误卡（`transcript.ts:108-111`，`state.unavailable`）。打开会话时的错误卡本来就没有放回链接（`history.ts:54`）。
`mori.prompt_error`（准备中出错，`transcript.ts:347-352`）不在运行里，不受影响。

### 10.4 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 回复写完、检查请求还没发出 | 回复的助手消息 `message_end`（没有工具调用），还没有 `agent_settled` | 回复完整显示（流式与 Markdown 照旧）；阶段行不显示；停止按钮在；回复下没有操作行；侧栏 Running | 停止；排队、插话 |
| 检查那次请求等模型 | `turn_start` | `Waiting for the model… Ns`；开了思考时之后 `Thinking… Ns`，对话流里回复下面一块展开的 `Thinking…`，思考结束时收起为 `Thought process`（§0 第 9 条） | 停止 |
| 模型写 `finish` 调用 | `message_update` 的 `toolcall_*` | 短暂 `Responding…`；没有工具卡 | 停止 |
| a：确认 | `finish` 的结果、`agent_settled` | 对话流与检查之前相同：没有 `finish` 的卡、没有空位、没有检查那一行（开了思考时多一块收起的 `Thought process`）；操作行出现在回复下；不在前台时侧栏 Unread | Copy、Attach message as context、反馈 |
| a，确认时写了话 | 那条助手消息有文字和 `finish` | 那句话作为这一轮的最后一段文字显示，是最终回复（TaskBoard 的 `run.lastText`）；Copy 带着它 | 同上 |
| b：检查之后干活 | 检查那次请求里有别的工具调用 | 前一段回复留在原处，成为过程里的一段文字；后面接工具卡（批准照常）和新的回复；新回复之后再检查一次（最多 3 次） | 同平常的运行 |
| c：重写 | 检查那次请求只写了字（之后调不调 `finish` 都行） | 前一段与新的一段都显示（平铺，第 2 步才折叠）；Copy、Attach message as context 取整轮正文，两段都在；最终回复与 `run.lastText` 是新的那段（增强任务读会话片段时两段、检查那一行与 `finish` 都在，不另处理，§5.5）；不再检查 | Copy 等 |
| 检查那次请求出错 | 出错的助手消息、`agent_end` | 回复完整，下面错误卡显示原文，**没有** `Put your last message back in the message box`；侧栏 Error；协作模式下等这个会话回复的发送方拿到的是回复（§8.3） | 发新消息 |
| 检查那次请求候选耗尽 | `mori.model_unavailable` | 回复完整，下面 `No model available` 卡（不另有错误卡） | 卡上的操作（Open settings 等） |
| 检查时按了停止 | `agent_settled { aborted: true }` | 回复完整，下面 `Stopped · Changes made so far stay as they are`；检查那一行留在会话里（不显示），意思上对下一条消息无害（连着的 user 消息见 §7.1） | 发新消息 |
| 打开会话 | 会话文件 | 检查那一行、`finish` 的调用与结果都不画；只有 `finish` 的助手消息不留项；写 `finish` 时停止或出错的，照旧显示 `Stopped · …` 或错误卡（没有放回链接）；回复下的操作行在回复那一项上 | 同平常 |
| 会话引用 | `session.read` 的条目 | 预览与引用文字里没有 `finish` 的 `[Tool]` 行、没有检查那一行（`quotableEntries` 只取 user、assistant 与 `mori.ref`，`app/src/kernel/entries.ts:135-140`） | — |
| Customize 页 | `tools` | Built-in tools 有一行：`finish` · Mori · Enabled · `Confirm that your last reply is your final reply.` | 只读（同 `memory`） |
| 协作模式 | 用户会话是对话 Agent | 同 a、b、c；工作卡照旧不显示；对话 Agent 调 `finish` 不被拒绝 | 同平常 |

## 11. 与文件系统实现的先后

（2026-10-27 注：两边都已合进集成分支 `wt/cov-integration`，顺序是本文先落地，按下表左列做了：`applyDialogTools` 与本文
§8.2 的改动随文件系统删掉，`finish` 在路径闸的 `DUTY_TOOLS` 里，`applyDutyTools` 不动它；FS-115 建在 FC-28 之上；合成端点的
`checkPlan` 跳过末尾的提醒；`tests/unit/finish/*.test.mjs`、`tests/ui/fc-app-team.mjs`、`fc-app-check.mjs`、
`fs-app-away.mjs` 照改；§14.2 原来标“（文件系统实现前）”的几处改成文件系统之后的写法。记录见
[finish-check-checks.md](../v1/finish-check-checks.md) 的“合进文件系统之后”。）

文件系统规格（[file-system.md](file-system.md)、[file-system-permissions.md](file-system-permissions.md)）写规格时还没落地，可能先于或晚于本文实现。两边要对上的是下表七处（各处要改的另一份规格都已加注“2026-10-27 注：收尾检查”）：

| 处 | 本文先落地时，文件系统实现要做的 | 文件系统先落地时，本文实现要做的 |
| --- | --- | --- |
| 对话会话的工具 | `applyDialogTools` 连同本文 §8.2 的改动一起删掉，换成 `applyDutyTools`；`finish` 不在它的表里、它不动 `finish`，同 `ask_user_question`（file-system-permissions §8.6 已加注）；`guardCall` 的用户会话分支与 `LaneRun.allowed` 删掉，本文在 `entries` 里加的 `finish` 随之消失 | §8.2 不做：`applyDutyTools` 不动 `finish`，`defaultActive` 与 `refreshTools` 保证它一直启用 |
| 路径闸 | `finish` 进 `DUTY_TOOLS`：协作模式下对话会话的 `{ write: false, mcp: false }` 里，`mcp: false` 拒绝 `other` 种类，`finish` 不能落进 `other`；`FREE_TOOLS`（已含 `finish`，§4.4）拆分时它跟着去 `DUTY_TOOLS`（§0 第 10 条）。定义 `DUTY_TOOLS` 的各处都已加注：file-system-permissions §6.1 第 1 步、§6.2 `duty` 一行与拆分那一句、§8.2“职责工具从不被收窄”、§8.6；file-system.md §1 的 `DUTY_TOOLS` 一行、§2 的 `pathGate.ts` 一行、FS-30、FS-84 | 同左：§4.4 改为加进 `DUTY_TOOLS`（`decide` 对 `finish` 给 `free`，种类 `duty`） |
| 你不在时的提醒 | `mori-approval` 的 `agent_before_settle` 照 §9.8 返回 `[...event.entries, 提醒]`，不返回 `continue` 时保留 `mori-memory` 给的 `true`（§3 第 5 条）：同一个边界合成一次请求，顺序 [检查那一行（含检查块），提醒，工作卡]（§6.4）。所以用户会话里提醒跟在检查那一行之后、不紧跟助手消息，也不另多一次请求；file-system-permissions §9.8 的“在上下文里的位置”“代价”两行与 FS-78 已加注（实例会话没有检查，不变）。FS-78、FS-79 的 App 测试用 `{ check: true }` 取这次合起来的请求，期望合成端点默认回 `finish`；文件系统实现时在 `checkPlan` 与记录代理的规则里加上“跳过末尾的提醒”（§14.1、§14.4） | 同左；本文实现时按上面改 `tests/ui/fs-app-away.mjs`（FS-78、FS-79）；FC-10 已用合成的提醒消息测 `checkRequestIndex` 跳过它 |
| 一次 pi 运行一份运行记录（§8.1） | 不用做：提醒的 `continue` 再发的 `agent_start` 沿用同一份运行记录 | 文件系统的 §9.8 实现带上 §8.1 的改动（`teamRuns.ts:45-66` 在 `lane.run !== null` 时直接返回，连同强制填写的例外）与 FC-18 的单元用例（file-system-permissions §9.8 已加注）；本文实现时只核对 |
| 被文件系统删掉的代码上的验收 | 文件系统实现时把 `tests/unit/finish/*.test.mjs`、`tests/ui/fc-app-team.mjs` 里下一列的几处照改（file-system-permissions §8.6 的注点名了它们） | FC-03 去掉对 `applyDialogTools` 的条目、`run.allowed`、`guardCall` 的单元断言与“恢复记下的那一组（没有 `finish` 的旧 `mori.team`）”一种，保留其余几种情况与“对话调 `finish` 得到 `Confirmed.`，不是 `RELAY_ONLY`、不是 `Tool finish not found`”，另加：对话会话的闸带 `TEAM_DIALOG_LIMITS` 时 `decide` 给 `finish` `free`（种类 `duty`）；FC-04 的单元用 `decide` 代替 `gateFor('finish')`；FC-18 的单元去掉 `allowed`；§14.4 的 MEM-02、MEM-11（`mem-app-prompt.mjs:796`）一行与单元一行里“`applyDialogTools` 的条目或 `run.allowed`”没有可改的（文件系统删了这些用例）；TB-09 照文件系统规格 §19.4 改写，职责工具里加 `finish`。这几处在 §14.2 标“（文件系统实现前）” |
| 汇总预设与覆盖检查（§14.3） | FS-115 改在 FC-28 之上建：`filesystem` 组 = `finish` 组加本规格的套件（`fc-app-check`、`fc-app-team`、`test:fc-unit`、`fc-replay`）；回放层末尾 = FC-28 的末尾再加 `--spec finish`；`also` = MP-37、TB-46、MEM-35、MD-15 加 `{ id: 'FC-28', before: <spec-coverage-finish 那一项> }`；`spec-coverage.test.mjs:309` 的原文按 `SPECS` 的键序为 `(expected model, taskboard, memory, discovery, finish or filesystem)`，`:145-149` 的循环与“不归其他规格”的检查含 `finish`、`fc-`；AGENTS.md 里 FS-115 写“also writes MP-37, TB-46, MEM-35, MD-15, FC-28”（file-system.md §19.3、§19.4 已加注） | §14.3 写的：FC-28 建在 FS-115 之上，原文为 `(expected model, taskboard, memory, discovery, filesystem or finish)` |
| `test:min` 的时长 | 文件系统实现时连同 `test:fc-unit` 重量一次 `test:min`，再用它的 `test:fs-unit` 额度（file-system.md §19.1 已加注） | 本文实现时连同 `test:fs-unit` 量 `test:min` |

两种顺序下 `test:min` 都不能超过 2 分钟：`test:fc-unit` 不超过 10 秒（§14.1）。量出来超过时停下，把各组单元测试的时长报告给负责人（AGENTS.md 工作约定第 6 条），
建议把最慢的真实 git 单元测试移出 `test:min`，不悄悄超出。

其余互不影响：提醒每次运行只补一次，检查按 §5.3 计数，提醒不是 user 消息、不移动起点；两者在停止或出错后都会留在会话里；
文件系统规格 §9.8 已写明清单在 `agent_settled` 清、不在 `agent_start` 清，与 §8.1 同一个理由；一轮的快照按运行前后拍，检查之后多干的活落在同一轮里（proposal §10）。
TB-03 的对照比较里要去掉的工具（记忆规格 §14.4、文件系统规格 §19.4）同样加 `finish`（§14.4）。
第二行“被拒绝的不重试”（§7.1）与提醒的 `Don't retry the denied calls.` 一致；FS-82（真实模型不重试被拒绝的调用）在收尾检查开着时同样要成立，FC-27 另记这一项。

## 12. 临时默认值

都登记在 [v1/defaults.md](../v1/defaults.md) 的“收尾检查”一节（proposal §13 的 19 条改写代码落点，加上 §0“写规格时定的”）。数值在 `kernel/finishCheck.ts`。

| 项 | 值 |
| --- | --- |
| 一次运行最多检查几次 | 3（`FINISH_CHECK_CAP`，proposal §12 第 3 条，负责人定的，不是临时默认值，列在这里方便找） |
| 计数的起点 | 最后一条 `role: 'user'` 的消息（§0 第 1 条） |
| 检查块的 token 估算 | 字符数 ÷ 4 向上取整（`cardTokens`，同工作卡；登记在 defaults.md 第二张表） |
| `finish` 的结果 | `Confirmed.`（§0 第 3 条） |
| 检查那一行、检查块、`finish` 说明 | §7（§0 第 4 条） |

## 13. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `docs/specs/finish-check.md` | 本文 |
| `docs/proposals/finish-check.md` | 开头的状态行：构建规格见本文；按本文改正的几处事实：§4、§8 检查那一行的量（§7.1），§5.3 与 §6.3 增强任务读到的（§10.4），§8 严格交替一行加检查时停止或出错之后的情形（§0 第 17 条），§10 文件系统一段里提醒的位置与请求数（§11） |
| `docs/v1/finish-check-checks.md`（新） | 检查记录：规格已写、未实现；写规格时定的；开工前核对的 pi 行为；规格评审；之后的实现结果、跳过的测试层与未验证项 |
| `docs/v1/defaults.md` | “收尾检查”一节：“位置”改为代码落点；加 §0“写规格时定的”各行与检查块的 token 估算 |
| `docs/specs/parallel-agents-taskboard.md` | §5.5：对话会话启用的工具另有 `finish`、`tool_call` 的限制放过它；§9.4：同一次 pi 运行只有一份运行记录，用户会话的检查那次请求出错按正常结束；§12.4：跟在没有工具调用的助手消息之后的请求上换模型不重来（本文 §8、§9.2） |
| `docs/specs/memory.md` | §7.5：`finish` 同样在 `FREE_TOOLS`；§7.6：`mori-memory` 另在用户会话注册 `finish`（增强会话除外），`team.ts` 各分支都留着它（本文 §4、§8.2） |
| `docs/specs/file-system-permissions.md` | §6.1 第 1 步、§6.2 的 `duty` 一行与拆分那一句、§8.2“职责工具从不被收窄”：`DUTY_TOOLS` 含 `finish`；§8.6：`finish` 同 `ask_user_question`，一直启用、`applyDutyTools` 不动它，本文先落地时要照改的验收；§9.8：提醒的 `continue` 不另起运行记录（本文 §8.1），用户会话里提醒跟在检查那一行之后、不另多一次请求（本文 §11） |
| `docs/specs/file-system.md` | §1 的 `DUTY_TOOLS` 一行、§2 的 `pathGate.ts` 一行、FS-30、FS-84：含 `finish`；FS-78：用户会话里提醒跟在检查那一行之后；§19.1：`test:min` 的时长连同 `test:fc-unit`；§19.3、§19.4：本文先落地时 FS-115 建在 FC-28 之上、覆盖检查的原文（本文 §11） |
| `docs/specs/model-providers.md` | §6.1：跟在没有 `finish` 以外工具调用的助手消息之后的请求换模型时 `hideUntil` 取 `replyStartedAt`、条目带 `afterReply`，不隐藏、不改重做说明，隐藏区间里的检查那一行一起隐藏；§6.2：`finish` 调用算外来模型的工具调用（本文 §9.2、§9.5） |
| `AGENTS.md` | 仓库结构：`docs/specs/` 加本文、`docs/v1/` 加检查记录；工作约定第 4 条第 8 件加本文；实现时：`test:min` 加 `test:fc-unit`，测试分层第 2、3 条加 `fc-*` 套件与 `--spec finish`，常用命令加 `test:fc-unit`、`test:finish` |
| `docs/app-v0.md` | 不改：第 4、6、11 节在 proposal 那一轮已改（proposal §10 第 1 条） |
| `docs/v0/ui-strings.md` | 不改：本步不加界面文字（第 2 步折叠头的文字到时再登记，§15） |
| `app/src/` | §2 的文件（含 `shared/models.ts` 的 `ModelSwitchEntryData.afterReply`） |
| `app/tests/` | §14 |
| `app/package.json` | 脚本 `test:fc-unit`（`node --test --test-reporter=./tests/unit/fc-reporter.mjs "tests/unit/finish/*.test.mjs"`）、`test:finish`（§14.3）；`test:min` 在最后一组单元测试之后加 `npm run test:fc-unit` |


## 14. 验收

### 14.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/finish/*.test.mjs`（`node --test`，经 `tests/unit/load.mjs` 用 esbuild 打包内核与界面模块，同 `memory/`、`taskboard/` 的单元测试；报告器 `tests/unit/fc-reporter.mjs` = `createReporter('fc-unit.json', true)`，严格模式同 `md-reporter.mjs`） | `kernel/finishCheck.ts` 的纯函数；`finishTool`；`mori-memory` 的 `before_agent_start` 与三个新处理器（替身 `ExtensionAPI`，synthetic）；`runStarted`、`laneEvent` 的 `compaction_end`、`applyDialogTools`、`onMessageEnd`（`tests/unit/taskboard/teamHarness.mjs` 的替身会话）；`FREE_TOOLS`；`followsToolFreeReply`、`switchFrom` 的条目、`notesPerReply`、`applySwitchEntries` 隐藏检查那一行、`extraContextTokens`；界面状态函数 `blocksFromContent`、`finishOnly`、`afterReplyOf`、`withRunMode`、`applyToolCallUpdate`、`applyToolStart`、`applyToolExecution`、`applyToolGate`、`applyAssistantEnd`、`transcriptFromEntries` 与 `attachLive`、`replyTurns`、`agent_end` 与 `compaction_end` 错误的放回链接（`core-bridge.test.mjs`、`stream.test.mjs` 已这样打包界面模块）；合成端点的认出、默认回应、日志与场景（import `tests/fake-endpoint/scripts.mjs` 与 `finish.mjs`，不 import `server.mjs`：它在载入时就开始监听） |
| 合成端点 | `tests/fake-endpoint/`（synthetic） | 见下 |
| App | `tests/ui/fc-app-check.mjs`（端口 4950–4959，关闭模式与界面）、`tests/ui/fc-app-team.mjs`（4960–4969，协作模式与 Team） | Electron + 合成端点，逐条验收；模型配置按 `v1-switch-helpers.seedUserData` 写好（注明 synthetic）；要看换模型时经记录代理（`v1-switch-helpers.mjs:97-117`） |
| 回放 | `tests/ui/fc-replay.mjs`，fixture 在 `tests/fixtures/finish/`（`harness/main.jsx` 加载这个目录） | `fc-record.mjs` 从真实的 App 对合成端点录下 FC-11、FC-12、FC-13、FC-23 用的全部 fixture：`fc-a.json`、`fc-a-text.json`、`fc-early.json`、`fc-b.json`、`fc-c.json`、`fc-a-think.json`，都标 `source: 'synthetic'`（同记忆规格 §14.1 的做法），所以 `npm run test:finish` 在负责人走查之前就能过。`fc-real.mjs`（FC-27）另把真实录制写成 `fc-a-real.json`（模型走出 b、c 时另有 `fc-b-real.json`、`fc-c-real.json`），不覆盖合成的；`fc-replay.mjs` 有这些文件时一并回放，没有不算失败 |
| 真实 | `tests/ui/fc-real.mjs --source <你的数据目录>`，或照 `md-real.mjs` 的 key 模式从负责人的 env 文件读 key（只在进程里读，不打印、不落盘） | FC-27；只断言程序保证的事，模型怎么回应写进 note |

**合成端点**（只用于测试，`tests/fake-endpoint/`，文件开头注释逐条列出）：

- **放在哪**：`CHECK_LINE_HEAD` 定义并导出在 `scripts.mjs`，挨着 `WORK_CARD_OPEN`、`RESTART_PREFIX`（`scripts.mjs:66-69`）；`deliveriesOf`、`logFields` 也在这个文件里改。
  `checkPlan(body)` 与 `fc-*` 场景的分派、步骤表放在新文件 `tests/fake-endpoint/finish.mjs`（同 `enhance.mjs`，可以 import `./scripts.mjs`、`./steps.mjs`）。
  不放进 `scenarios/`：`scripts.mjs` 在顶层 `await` 里自动载入 `scenarios/` 下的每个文件、合并它们的 `SCENARIOS`，那里的文件 import `scripts.mjs` 会互相等待（Node 退出码 13）。
- **认出检查请求**：`checkPlan(body)` 只认、不回答，返回 `{ check, checks }`：去掉末尾只有工作卡的 user 消息（`withoutWorkCards`，`scripts.mjs:192-197`）与提醒
  （文件系统实现后，以 `[Mori] The user was away` 开头的 user 消息，由文件系统的实现加上）之后，最后一条是 user 消息、去掉首部空白后以 `CHECK_LINE_HEAD` 开头时 `check` 为真
  （不用相等：换模型的说明可能接在 user 消息末尾，`server.mjs:305-309`）；`checks` 是起点（最后一条既不是检查那一行、也不是提醒或只有工作卡的 user 消息）之后检查那一行的条数。
  FC-26 比对 `scripts.CHECK_LINE_HEAD` 与 `shared/finishCheck.ts` 相等。
- **判断顺序**（`server.mjs` 的 `conversationPlan`，`:480-489`）：压缩请求（`isSummaryRequest`）→ `checkPlan` 认出 → 起点那条消息里有 `fc-scenario:<名字>`、且请求的 `tools` 里有 `finish` 时，
  这次运行的每个请求（含检查请求）都由 `finish.mjs` 的场景回答 → 其余的检查请求回默认回应 → `tb-scenario:` 脚本 → 增强 → 关键词，同现在。
  只认 `tools` 里有 `finish` 的请求（用户会话：对话、关闭模式的对话、协作模式的对话、合并会话），因为分开时你的原文也会进立项实例的投递（`[Mori] New user message: …`，`boardText.ts:1142`）。
- **默认回应**：只回一个 `finish` 调用（参数 `{}`）、不写字。脚本模式（`tb-scenario:`）与关键词模式都一样，所以现有场景脚本不用逐个改（proposal §14）。
  起点那条消息里有 `fc-check-wait:<毫秒>` 时，默认回应推迟那么久（2026-10-27 注：文件系统已合并，`fs-app-away.mjs` 的 FS-79 用它让带提醒的那次检查请求回得慢，§11、§14.4）。
  加思考的钩子照旧：`-replay` 模型开着思考时 `conversationPlan` 加的思考（`server.mjs:485-487`），`-alwaysthink`、`-nooff` 在 `handleChat` 里加的思考（`server.mjs:528-529`）。
  `-replay` 模型不能去掉：带工具调用、没有 `reasoning_content` 的助手消息会让之后开着思考的请求被端点按 400 拒绝（`probes.mjs:163-173` 的 `replayRejected`）。
  所以这几种模型每次检查之后多一项只有收起的 `Thought process` 的助手项（§0 第 9 条），读最后一个助手项的帮助函数按 §14.4 改。
- **不算投递**：`scripts.mjs:215-224` 的 `deliveriesOf` 跳过检查那一行（同工作卡），投递序号 `k` 与步骤 `j` 不变；检查之后模型的 `finish` 调用让 pi 停下（§3 第 10 条），不会再有请求落到脚本的下一步。
- **日志**：检查请求的日志行加 `check: true` 与 `checks`；`logFields`（`scripts.mjs:285-289`）照加。
- **协作模式的用例怎样带场景名**：分开时的对话、合并会话写在你的消息里；程序投递到用户会话开始的运行（例如 FC-19 里等它回复的 `agent_message`），由脚本里的发送方把 `fc-scenario:<名字>` 写进 `agent_message` 的正文（`boardText.ts:1167` 原样投递）。
- **收尾检查自己的场景**：场景按“起点之后检查那一行的条数”与“最近一行检查之后的助手消息数”取步骤，步骤用现有的 `say`、`call`、`think`、`together`、`wait`、`fail`（`steps.mjs`）：

  | 场景 | 回复 | 检查 1 | 之后 |
  | --- | --- | --- | --- |
  | `fc-a` | `say Done.` | `call finish {}` | — |
  | `fc-a-think` | `together(think …, say Done.)` | `together(think …, call finish {})` | — |
  | `fc-a-text` | `say Done.` | `say The reply stands.` + `call finish {}`（同一条消息） | — |
  | `fc-b` | `say I'll run the tests.` | `call bash { command: "echo fc-b" }`，结果回来后 `say The tests passed.` | 检查 2：`call finish {}` |
  | `fc-c` | `say Draft answer.` | `say Conclusion first: rewritten answer.` | 不再检查 |
  | `fc-cap` | `say Working.` | 每次检查都 `call bash`、再 `say Still working.` | 第 3 次检查之后照样干活，第 4 个边界放行 |
  | `fc-mixed` | `say Done.` | `call finish {}` 与 `call bash` 同一条消息，之后 `say Done again.` | 检查 2：`call finish {}` |
  | `fc-bad-args` | `say Done.` | `call finish { reply: "Done." }`（校验失败），之后 `say Final reply.` | 不再检查 |
  | `fc-early` | `say Done.` + `call finish {}`（检查之前） | `call finish {}` | — |
  | `fc-slow` | `say Done.` | `wait` 8 秒后 `call finish {}`（停止、排队、插话用） | — |
  | `fc-fail` | `say Done.` | `fail` HTTP 400（模型层不重试、不换模型的错误） | — |
  | `fc-fail-first` | `fail` HTTP 400 | — | — |
  | `fc-404` | `say Done.` | `fail` HTTP 404（模型不可用；会话的范围只有这一个模型时候选耗尽） | — |
  | `fc-work-fail` | `say Done.` | `call bash { command: "echo fc" }`，结果回来后的那次请求 `fail` HTTP 400 | — |
  | `fc-away-once` | `call write { path: "../fs78-b1.md" }`，结果回来后 `wait` 4 秒、`say First summary fs78b.` | `call write { path: "../fs78-b2.md" }`，结果回来后 `say Second summary fs78b.` | 检查 2：`call finish {}` |

  （2026-10-27 注：文件系统已合并，`fc-away-once` 是 `tests/ui/fs-app-away.mjs` 的 once 那条链用的（§11、§14.4）：你不在时第一次写被拒绝，提醒与检查 1 同一次请求，检查 1 之后的写是第二次自动处理。）
- `selfcheck.mjs` 不在任何 npm 脚本里，端点的检查放进 FC-26 的单元测试。

**与 AGENTS.md“测试分层”的关系**：每个任务只跑 `npm run test:min`，它加上 `test:fc-unit`（§13）；`test:fc-unit` 不超过 10 秒，`test:min` 仍不超过 2 分钟（实测写进检查记录；与文件系统的 `test:fs-unit` 合起来的规则见 §11）。
App、回放、真实、`spec-coverage` 与 `npm run test:finish` 不在任务里跑，交付说明列为未验证，留到负责人要求推送前的完整测试。
模型看到的变了（多了 `finish`、多了检查那次请求），所以录 fixture 与真实模型走查要做（AGENTS.md 工作约定第 2 条）：`fc-real.mjs` 由负责人用数据目录跑，或在负责人允许时用 env 文件里的 key 跑（key 只在进程里读，不打印、不写进日志与结果文件）。

### 14.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| FC-01 | `finish` 的定义 | `finishTool()` 的 `name`、`label`、`description`（与 §7.3 的块逐字相同，测试从本文读 `specBlock`）、`parameters` 深等于 §4.1、没有 `prepareArguments`、`promptSnippet`、`promptGuidelines`，`defaultActive` 为真；`execute` 返回 `Confirmed.`、`terminate: true`，不读写文件；用 pi 的 `validateToolArguments` 校验：`{}` 通过，`{ reply: "x" }` 抛出 `Validation failed for tool "finish"` | 单元 |
| FC-02 | 哪些会话有 `finish` | 关闭模式、协作模式（分开、合并）的用户会话的请求 `tools` 里有它；增强任务的看不见的会话（关闭与 `team` 两种）、立项、结案、task、临时提问、订阅的请求里没有；`memorySetup` 对实例与增强会话给 `check: null`；`MemorySessionSpec` 不带 `check` 的替身（§4.2）不注册 `finish` | 单元、App |
| FC-03 | 一直启用 | 关闭模式基座；关闭模式下由角色持有对话（chat.md，角色没有 `tools`）；协作模式分开时对话、合并会话；从协作模式回到关闭模式；重新打开没有 `finish` 时存下的会话（`refreshTools`）：每种情况第一次与第二次运行请求的 `tools` 都有 `finish`，第二次运行没有工具的 system 补丁；协作模式分开时对话调 `finish` 得到 `Confirmed.`，不是 `RELAY_ONLY`，不是 `Tool finish not found`。单元：`applyDutyTools` 不动 `finish`（各模式下都启用），对话会话的路径闸带 `TEAM_DIALOG_LIMITS` 时 `finish` 为 `free`（种类 `duty`），同一个闸对 `bash` 给 `RELAY_ONLY`（§11）。（2026-10-27 注：文件系统已合并，按 §11 左列改写：原来的“对话持有者写了 `tools`”“恢复记下的那一组（没有 `finish` 的旧 `mori.team`）”两种与 `applyDialogTools` 的条目、`run.allowed`、`guardCall` 的单元断言随文件系统删掉的代码去掉） | 单元、App |
| FC-04 | 免批准 | 单元：`finish` 在路径闸的 `DUTY_TOOLS` 里，`callKind` 为 `duty`；对话会话的闸（`decide`，经 `announce` 与 `tool_call` 处理器）在 Ask each time 与 Full access 下、协作模式开与关时都给 `free`，没有 `mori.approval_request`（2026-10-27 注：文件系统已合并，`gateFor` 随文件系统删掉，§11）。App：Ask each time 下检查后调 `finish`：`mori.tool_gate` 为 `free`，没有 `mori.approval_request`、没有批准卡、侧栏不显示 Needs approval | 单元、App |
| FC-05 | system prompt 不变 | 同一组输入下身份段的 `<tools>`、`<rules>` 与没注册 `finish` 时逐字相同（MEM-01 的比较照样通过）；请求的 `tools` 参数有 `finish`，`<tools>` 里没有 | 单元、App |
| FC-06 | 决定表 | §5.3 每一行，用 synthetic 的 AgentMessage 上下文：没有检查行 → 检查；检查后单独 `finish` 成功 → 放行 `confirmed`；检查后只写字、什么都没写、`finish` 失败后写字 → 放行 `no work`；3 行检查且第 3 行之后干了活 → 放行 `limit`；检查后干了活（1、2 行时）→ 检查 `work`；`finish` 与 `bash` 同一批 → 检查；返回的 `checks` 等于起点之后检查行的条数 | 单元 |
| FC-07 | 边界 | §5.4 每一条的 synthetic 上下文：被 `mori-team` 拒绝、批准拒绝、`Tool x not found`、参数校验失败、`stopReason: 'length'` 判失败的调用都算干活；检查之前调的 `finish` 不算确认；起点之后有一条排队或插话的 user 消息时只数它之后的；上一次运行的检查行在新消息之前不算；没有 user 消息时从开头数；提醒（`custom`，`mori.away_reminder`）与 `compactionSummary` 不影响计数；`runMessages`：按分支顺序给出 message 与 custom_message 条目，跳过压缩条目、不进上下文的条目和被 `context_edit` 去掉的消息；每次回复之后都压缩、检查那一行与 `finish` 都已收进摘要时（投影只剩摘要、`finish` 与结果）仍按确认放行，3 次检查都收进摘要时仍按上限放行 | 单元 |
| FC-08 | 处理器 | `outcome` 为 `error` 时返回 `undefined`；从 `ctx.sessionManager.getBranch()` 数，不从 `event.context.contextMessages` 数（投影只剩摘要、`finish` 与结果时放行）；检查时返回的 `entries` 保留 `event.entries` 原有的项（前一个处理器的条目）并在最后加检查那一行、`continue: true`；条目 `customType`、`display: false`、没有 `details`；检查那一行按这次运行记下的种类选原文；`pendingTokens` 等于这次运行的 `blockTokens`；§7.4 的日志行（加检查、放行各一种）；`setup.check` 为假（`null` 或没有）时不注册 `finish` 与 `agent_before_settle`、`context`、`agent_settled` 三个处理器 | 单元 |
| FC-09 | 原文 | `checkLine` 的四种与 §7.1 的块和表逐字相同（测试从本文读）；`checkBlock` 的三种（两段、只有 TASTE、只有 REVIEW）与 `null`，内容与同一份快照写出的 system prompt 分节逐字相同；`CHECK_LINE_HEAD` 是每种原文的开头 | 单元 |
| FC-10 | 检查那次请求的检查块 | `checkRequestIndex`：末尾是检查那一行、[检查那一行，工作卡]、[检查那一行，提醒（synthetic）]、[检查那一行，提醒，工作卡] 时找到它；末尾是工具结果、你的新消息（旧检查行在它之前）时为 `-1`。App：检查那次请求里检查那一行带检查块、是同一条 user 消息（关闭模式下请求里没有连着的两条 user 消息），协作模式下工作卡仍是最后一条；下一次请求（你的下一条消息）里那一行只剩原文；会话文件里的条目是原文；记忆页在会话打开后加的条目不进检查块（快照）；运行中切换协作模式，这次运行的检查块与检查那一行不变，下一次运行跟着变；没有 TASTE、REVIEW 条目时检查那一行是没有第三行的那种、没有检查块 | 单元、App |
| FC-11 | a：确认 | `fc-a`：一次运行恰好两个请求（第二个 `check: true`），一个 `agent_settled`；对话流与没有检查时相同（一项回复、没有工具卡，`agent_settled` 之后没有空的 `[data-item]`）；会话文件多一条 `custom_message`（`mori.finish_check`）、一条只有 `finish` 的助手消息与它的结果；阶段行在两次请求之间显示 `Waiting for the model…`，从不显示 `finish`；回复下的操作行在 `agent_settled` 之后出现、挂在回复那一项上；会话不在前台时侧栏 Unread 只在 `agent_settled` 标一次；`fc-a-text`：那句话显示为回复的最后一段，Copy 带着它，`run.lastText` 是它；`fc-early`：检查之前的 `finish` 之后照样检查一次。回放：`fc-a.json`、`fc-a-text.json`、`fc-early.json` | App、回放 |
| FC-12 | b：说了要做却停了 | `fc-b`：两次检查（日志 `checks` 为 1、2）；`bash` 的卡照常显示在第一段回复之后；最终回复 `The tests passed.`；第一段回复留在原处；`fc-mixed`：同一批里的 `finish` 不算确认，再检查一次。回放：`fc-b.json` | App、回放 |
| FC-13 | c：重写 | `fc-c`：一次检查；两段都显示；Copy 与 “Attach message as context” 的内容两段都在；没有第二次检查；`fc-bad-args`：`finish` 的校验错误不显示卡，`Final reply.` 是最终回复，不再检查。回放：`fc-c.json` | App、回放 |
| FC-14 | 上限 | `fc-cap`：恰好 3 次检查，第 4 个边界放行（日志 `finish check passed (limit)`），运行结束 | App |
| FC-15 | 排队与插话 | `fc-slow` 的检查等待中排队一条消息：检查那次请求的 `finish` 之后 pi 接着回答这条消息，之后的检查从 0 数（日志 `checks` 为 1）；插话同理；运行只有一个 `agent_settled` | App |
| FC-16 | 停止 | `fc-slow` 的检查等待中按停止：回复完整，下面 `Stopped · Changes made so far stay as they are`，没有错误卡；停止之后 6 秒内（发下一条消息之前）端点没有这个场景的请求，连 `check: true` 的也没有（`scenarioLines(…, { since: stopAt + 300, check: true })` 为空）；会话文件留着检查那一行；发下一条消息：请求里那一行没有检查块、后面紧跟你的新消息，这次运行照常检查一次 | App |
| FC-17 | 检查那次请求出错 | App：`fc-fail`：回复完整，错误卡显示原文、没有 `Put your last message back in the message box`，侧栏 Error；`fc-fail-first`（第一个请求就出错）仍有放回链接；`fc-404`（范围里只有一个模型）：只有 `No model available` 卡、没有错误卡。单元：`afterReplyOf` 在文字回复、只有 `finish` 的消息之后为真，在有别的工具调用之后为假，出错与中止的消息不改它（实时与打开会话都一样）；你的消息、程序投递置假；`transcriptFromEntries([你的消息, 文字回复])` 之后为真，再 `attachLive`（`running: true`）、出错的 `message_end` 与 `agent_end` 推的错误卡 `restore` 为 `null`；[你的消息, 有别的工具调用的回复, 工具结果] 之后同样的序列仍有放回内容；`compaction_end` 带 `errorMessage`：文字回复之后 `restore` 为 `null`，工具调用之后为 `lastUserText` | 单元、App |
| FC-18 | 一次运行一份运行记录 | 单元：同一次运行里第二个 `agent_start` 之后 `lane.run` 是同一个对象，`lastText`、`judgment`、`command`、`sentThisTurn` 与这次运行的模式（用户会话的收窄按它）不变；`agent_settled` 之后的下一个 `agent_start` 新起；task 实例同样；强制填写的实例运行第一条消息是溢出出错、或可恢复的截断，之后 `compaction_end { willRetry: true }` 与第二个 `agent_start`：重试的请求 `shapeAttempt` 照样给写法、`run.formMode` 与它一致，正常回答之后的下一次请求仍不套写法。App：协作模式分开时对话在检查之后调 `bash` 仍被拒绝（`fc-b`：路径闸按这次运行的收窄 `TEAM_DIALOG_LIMITS` 给 `RELAY_ONLY`；2026-10-27 注：文件系统已合并，对话的工具里有 `bash`，不再有 `Tool bash not found`）；合并会话在检查之后照常写 `mori.progress`；等用户会话回复的 `agent_message` 拿到最终回复，不是 `It ended without a reply.` | 单元、App |
| FC-19 | 检查那次请求出错按已完成算 | 单元：`followsCheck` 在 [检查那一行]、[检查那一行，提醒]、[检查那一行，出错的助手消息]、[检查那一行，system 消息，出错的助手消息]、[检查那一行，压缩，出错的助手消息] 之后为真，在 [工具结果，压缩，出错的助手消息]、你的消息之后为假；`onMessageEnd` 之后 `run.error` 为 `null`、记错误日志；出错的消息带着半截文字时 `run.lastText` 仍是检查之前那段。App（协作模式）：用户会话那次运行的检查请求出错（`fc-fail`，由发送方写进 `agent_message`）时，等它回复的发送方拿到回复的最后一段文字、不按失败；检查之后干了活再出错（`fc-work-fail`）仍按出错 | 单元、App |
| FC-20 | 协作模式 | 分开时：对话 Agent 的检查块只有 `<taste>`，检查那一行是 TASTE 那种；对话调 `finish` 成功；工作卡在最后；程序投递到用户会话开始的运行同样检查（`check: true` 的日志行 `kind` 为对话）；合并会话：检查块只有 `<taste>`；立项、结案、task 实例的请求里没有检查 | App |
| FC-21 | 换模型不隐藏 | 单元：`followsToolFreeReply` 的真假各例（两种消息形状）：[文字回复, 检查那一行]、[文字加 `finish` 的回复, `finish` 的结果, 检查那一行]、[前面干过活、最后一条只有 `finish`] 为真，后面跟着 `finish` 以外的工具结果为假；`switchFrom` 在检查那次请求上写 `hideUntil === replyStartedAt`、`afterReply: true`，在工具结果之后照旧；同一段里先有一条隐藏的条目 e1（来自 A）、再有 `afterReply` 的 e2（来自 B）时，A 的过程照旧隐藏、B 的回复留着、只有一条重做说明且等于 `redoNote(A, e1 的原因)`；`applySwitchEntries` 对 [anchor, 回复, 检查那一行, 有工具调用的助手消息, 工具结果] 与一条 `hideUntil` 为工具结果时间戳的条目，两种形状都返回 [anchor 加重做说明]，没有检查那一行；`kind: 'task'` 的 ModelSession 在跟在没有工具调用的回复之后的请求上换模型时不走 `restartFrom`、`takeRestart()` 为 `null`，工具结果之后照旧重来；MP-15（`tests/unit/modelContext.test.mjs:265-273`）不变。App：记录代理拒绝检查那次请求，换到另一个模型：新模型的请求里有回复与带检查块的检查那一行，没有重做说明，`mori.model_switch.hidden` 为假，界面没有隐藏提示；`fc-early` 同样；`fc-b` 的检查之后再换模型：新模型的请求里没有检查那一行，重做说明在 anchor 上；平常换模型（工具结果之后）仍隐藏 | 单元、App |
| FC-22 | 窗口估算加检查块 | 检查之后、`context` 处理器之前 `extraContextTokens()` = 工作卡 + `blockTokens`，之后 = 工作卡；检查那次请求没走到 `context` 钩子就结束（路由时候选耗尽、等模型时停止）时，`agent_settled` 之后 = 工作卡，下一次运行 `prepare()` 的接手判断不含检查块；检查那次请求换模型时（`switchFrom`、`selectSegment` 经选择器第 6 步），窗口放不下“上下文 + 检查块 + 最大输出”的候选被排除，段内正在用的模型只经 `checkCurrent`；增强会话与实例的 `extraContextTokens` 不变 | 单元 |
| FC-23 | 界面不画 `finish` | 单元：`blocksFromContent` 把 `finish` 换成空文字块、下标不变；`finishOnly`；增量（名字为 `finish` 或空字符串）、开始执行、执行中、结束、`mori.tool_gate` 的处理不建卡、不改阶段（增量仍设 `generating`）；先来一个名字为空的 `toolcall_start`、再来名字为 `finish` 的增量：最后一个助手项在那个下标没有 tool 块、`tools` 里没有它；只有 `finish` 的消息结束时整项去掉，`finish` 加思考的保留一项；打开会话时只有 `finish`、`stopReason` 为 `aborted` 的消息没有助手项、有一项 `stopped`，为 `error` 的没有助手项、有一张 `restore: null` 的错误卡；`transcriptFromEntries`（你的消息 + 回复）之后 `attachLive`（`running: true`，`live.streaming` 是只有 `finish` 的半截消息），再来同样内容的 `message_end`：回复那一项不变、仍是最后一个助手项，没有多出的助手项，`tools` 里没有那个调用；`replyTurns`：[回复, 只有思考的项] → 键是回复，[回复, 进展摘要] → 进展摘要，[回复, 只有思考的项, 进展摘要] → 进展摘要；`withRunMode`：第一个 `agent_start`（`running` 为假）记下模式，`running` 时再来的 `agent_start` 保留原来的模式（传进来的模式不同也一样），之后 `applyToolStart` 建的卡带运行开始时的模式，`agent_settled` 之后的下一个 `agent_start` 取新模式。App 与回放：实时、打开会话、界面重新加载后接上运行中的会话、会话引用的预览与引用文字里都没有 `finish`；`agent_settled` 之后只有 `finish` 的消息没有 `[data-item]`；开了思考时（`fc-a-think`，回放 `fc-a-think.json`）只多一块收起的 `Thought process`，操作行在回复正文那一项 | 单元、App、回放 |
| FC-24 | Customize 页 | Built-in tools 有 `finish` · Mori · Enabled · `Confirm that your last reply is your final reply.`；`memory` 一行不变 | App |
| FC-25 | 增强会话与实例 | 增强运行（关闭与协作两种）请求里没有 `finish`、日志没有 `check: true`、会话文件没有 `mori.finish_check`，修订的 Notes 照旧是最后一条回复；协作模式的实例同上 | App |
| FC-26 | 合成端点 | 测试 import `scripts.mjs` 与 `finish.mjs`，不 import `server.mjs`。`checkPlan` 认出：末尾检查那一行、后面跟工作卡、末尾接了换模型说明；不认：你的消息里引用了 `[Mori] This is…` 但不在开头、工作卡本身；默认回一个 `finish`、不写字，`-replay`（开着思考）、`-alwaysthink`、`-nooff` 模型照旧带思考；`fc-scenario` 只在请求的 `tools` 有 `finish` 时生效，场景的运行里检查请求由场景回答、不是默认回应；经 `sessionOf` 的 `k`、`j` 看 `deliveriesOf` 不算检查那一行；日志 `check`、`checks`；`fc-*` 场景（含 `fc-a-think`、`fc-work-fail`）的步骤；`scripts.CHECK_LINE_HEAD` 与 `shared/finishCheck.ts` 相等 | 单元 |
| FC-27 | 真实模型走查 | 用你的数据目录（或 env 文件的 key）跑 `fc-real.mjs`：DeepSeek、GLM、OpenRouter 上的 Qwen 各一个模型（有内网模型时加一个）；每个服务上 `finish` 这种没有字段的工具调得通（校验通过、运行结束）；每个服务若干轮普通任务（含一个“说了要做”的引导），按服务记 a、b、c 各多少、“写话 + `finish`”与“只写话”各多少、检查那次请求的思考与输出 token、检查那次与下一次请求的 `cache_read`、`cache_creation`、你开始的运行与 Mori 开始的运行各检查几次（proposal §14），以及检查之后模型重试了几个被拒绝、被批准拒绝或得到 `RELAY_ONLY` 的调用（只记，不断言）；有要求严格交替的服务时，记下检查时停止之后发的下一条消息是不是回 400。只断言程序保证的事：每次运行至多 3 次检查、请求里有检查块、检查那一行不显示；数字写进 note 与检查记录；录下 `fc-a-real.json` | 真实 |
| FC-28 | 现有功能不退步 | §14.4 改过的现有 App、回放与单元测试，以及 `v1-models-existing.mjs --id FC-28` 的全部现有套件通过（§14.3）；改过的真实层（`v1-models-real.mjs` 等）在走查时跑，交付说明列为未验证 | App、回放 |
| FC-29 | 换到推理必须回传的模型 | 单元：`handoverCheck` 对 [你的消息, A 的文字回复, 检查那一行, A 的 `finish`, `finish` 的结果]、目标为 `reasoning.replay: required` 时 `reasoningOk` 为假（§9.5，接受的行为）。App：只聊过天、检查过一次的会话换到 `pb/fake-coder-replay`：有重建说明，没有 400，有回复 | 单元、App |

### 14.3 不留未完成项

`tests/spec-coverage.mjs` 的 `SPECS`（`:48-82`）加规格 `finish`：读本文 §14.2（`/^\|\s*FC-\d+\s*\|/`，前缀 `FC`），层的结果文件为 `fc-unit.json`（单元）、`fc-app*.json`（App，含 `-existing`）、
`fc-replay*.json`（回放，含 `-existing`）、`fc-real.json`（真实），`fc-partial-*.json` 不计入；带跳过或待办标记的检查一律不算通过（同文件系统规格 §19.3）。
`app/src`、`app/tests` 里新加的文字不能含 `tests/md-markers.mjs` 认作推迟标记的词。

`npm run test:finish` = `npm run test:fc-unit && electron-vite build && node tests/ui/fc-app-check.mjs && node tests/ui/fc-app-team.mjs && node tests/ui/fc-replay.mjs && node tests/ui/v1-models-existing.mjs --id FC-28 && node tests/spec-coverage.mjs --spec finish --allow-missing-real`
（同 `test:discovery` 的写法）。真实层由你跑 `fc-real.mjs`；最终一遍不带 `--allow-missing-real`。

`tests/ui/v1-models-existing.mjs` 加套件组 `finish` 和预设 `FC-28`，照实现时最后加的那个预设（`MD-15`；文件系统已实现时是 `FS-115`）的写法：
`finish` 组 = 那个预设的组，再加那个预设所属规格自己的 App 与回放套件、单元脚本（`MD-15` 时是 `md-app-form`、`md-app-card`、`md-app-firstrun`、`test:md-unit`、`md-replay`）；
App 结果写 `fc-app-existing.json`，回放结果写 `fc-replay-existing.json`，部分运行的前缀 `fc-partial-existing-`，日志目录 `fc-existing`；
回放层最后依次跑那个预设的全部覆盖检查与 `md-markers.mjs`，再加那个预设所属规格的 `--spec`（例如 `--spec discovery`），各记一条 “FC-28 <名字>”；
`also` 是那个预设的 `also` 加上它自己（例如 `MP-37`、`TB-46`、`MEM-35`、`MD-15`），各在读它的那项覆盖检查之前写。
`tests/unit/taskboard/spec-coverage.test.mjs:305-309` 的原文随之加 `finish`（`(expected model, taskboard, memory, discovery or finish)`，文件系统已实现时为 `…, discovery, filesystem or finish`），
`:145-149` 的循环加 `finish`，另查 `fc-` 的结果文件不归其他规格。

### 14.4 现有测试

数请求的办法（§0 第 15 条）：合成端点给检查请求的日志行标 `check: true`，记录代理（`v1-switch-helpers.mjs:97-117`）按同样的规则给 `captures` 标 `check: true`、
按模型数的请求序号 `index` 不算检查请求（检查请求的 `index` 为 `0`，规则照常拿到它，FC-21 据此拒绝它）。下表点名的帮助函数默认跳过 `check: true`，加参数 `{ check: true }` 才取；
直接读 `ep.logs`、`ep.log`、`proxy.captures` 等原始记录的测试自己过滤 `check`（下表也列了写规格时查到的几处）：

| 现有测试或帮助函数 | 改法 |
| --- | --- |
| `tests/ui/tb-helpers.mjs:138-143` 的 `scenarioLines`、`:170-186` 的 `scenarioRequests`（`sessionOf` 的结果加 `check`） | 默认跳过检查请求。于是 TB-03（`tb-app-roles.mjs:361-364` 的 `length === 1`）、TB-09（`:870-878` 的 `k === 1`、`k === 4` 各一条）、TB-10（`tb-app-flow.mjs:205-222` 的三步 `calls`、`:263-268`、`:285-295`）、TB-38（`tb-app-models.mjs:565-571`）、TB-40（`:816-826`）、TB-28（`tb-app-ask.mjs:306-316`）、TB-20（`tb-app-handoff.mjs:553-560`）的请求数与 `k` 不变 |
| `tests/ui/v1-models-app-switch.mjs:162` 的 `chatLogs`、`:165` 一带的 `captures` | 默认跳过检查请求：`length === 1/2/3` 的各处（`:366-371`、`:404`、`:421`、`:545-549`、`:573`、`:594`、`:619`、`:655`、`:679`、`:761-782`、`:878-981`）不变；MP-15 的规则（`:1100`、`:1141-1142`、`:1158`、`:1177`、`:1199`）按不算检查请求的 `index`，不变；`failed.length === 3` 不变 |
| TB-10（`tb-app-flow.mjs:205-222` 的 `starts === 1`） | 改为 `starts === 2`：第二个 `agent_start` 是收尾检查在同一次运行里接着跑（§3 第 2 条），`agent_settled` 仍只有一个；检查名里 “one agent_start before the first agent_settled” 改为 “one run (agent_start again only for the finish check)” |
| TB-03（`tb-app-roles.mjs:281-284` 的 `withoutMemoryTool`、`withoutMemoryRow`；`:348-360`；`:396-404`） | 请求的 `tools` 与工具页的行在与 v0 对照比较前，除 `memory` 外同样去掉 `finish`；来源 `Mori` 的行去掉 `memory`、`finish` 后等于 TaskBoard 工具（文件系统实现后还有 `ask_user_question`，文件系统规格 §19.4） |
| TB-09（`tb-app-roles.mjs:870-878`、`:931-933`） | 协作模式对话的集合加 `finish`（`['agent_message','board_read','finish','read','read_session']`）；关闭模式的集合加 `finish`；`:931-933` 加 `finish` |
| MEM-02、MEM-11（`mem-app-prompt.mjs:796` 的 `sameSet`） | 期望加 `finish`；`identityProblems`（`:331-351`）不改，必须照样通过（`finish` 没有 snippet，`<tools>` 不变，FC-05） |
| `tests/ui/m6-app-tools.mjs:677-695` 的 `builtinRows` | 不改，必须照样通过：启用的行与 “list tools” 报出的请求工具都多了 `finish`；“list tools” 那条回复按 `.last()` 读助手项，只有 `finish` 的消息不留项（§10.1），读到的仍是那条回复 |
| `tests/ui/m6-app-slash.mjs:337-349`、`:726`、`:746` 的 `assistantTexts(file).at(-1)` | 会话文件里最后一条助手消息现在是只有 `finish` 的那条（文字为空）：改为最后一条文字不为空的助手消息 |
| `tests/ui/tb-app-misc.mjs:79-85`、`:500-524`（TB-30：对话与合并会话的每个请求都以工作卡结尾） | 不改，必须照样通过：检查那次请求的工作卡仍在最后（§6.4） |
| `tests/ui/tb-app-modes.mjs:874-895`（TB-56 的时序） | 不改，必须照样通过：合成端点回 `finish` 只多几毫秒 |
| `tests/ui/tb-app-modes.mjs` 的 `TEAM_DIALOG_TOOLS`（`teamShape`：TB-05 两条开关、TB-56、TB-05 `/team /<扩展命令>`） | 集合加 `finish`（§8.2：协作模式下对话的工具里一直有它）；`teamShape` 其余条件不变（只许读取类、TaskBoard 工具与 `finish`，要有 `board_read`、工作卡与两段）。写规格时漏了，推送前的完整测试里查到 |
| `tests/ui/mem-app-prompt.mjs` 的 `callTool`（MEM-13） | 原来取会话文件里最后一个工具结果，现在那是检查之后 `finish` 的 `Confirmed.`：改为取这次调用的那个工具自己的结果（上次调用之后第一个同名的）。MEM-13 的断言不变。写规格时漏了，推送前的完整测试里查到 |
| `tests/ui/tb-app-stop.mjs:470`、`:542`、`:572`（TB-35：Stop team 之后没有请求，断言在 `:482`、`:517`、`:546`、`:577`，都是 `length === 0`） | 三处调用改为 `scenarioLines(ctx.ep, '<场景>', { since: stopAt + 300, check: true })`：检查请求也算“停止之后的请求”，否则默认跳过让这几条看不见它；断言不变（`:470` 的改动也盖住 `teamStopQuiet` 的 `:517`） |
| TB-41（`tests/ui/tb-app-models.mjs:412` 的 `checkOrder`） | 在 `after.slice(0, 4)` 之前滤掉 `line.check`（`detail` 用同一份）：占着并发 1 的模型的 `tb-models-hold-order` 与排队的对话都是用户会话，它们的检查请求是 `conversation` 类别（§9.4），会排在立项、task、后台之前；滤掉之后断言的顺序仍是 [conversation, decision, task, background]，`after[0].t >= released - 1000` 不变 |
| MEM-32（`tests/ui/mem-app-enhance-a.mjs:1159` 的 `sched`） | 在 `.map(classOf)` 之前滤掉 `l.check`，`after.slice(0, 3)` 仍是 [conversation, task, enhancement]；`:1146` 找 `hold` 不用改（第一行就是 hold 的请求） |
| MP-22（`tests/ui/v1-models-app-session.mjs:932-942` 的 `turnWith`，读合成端点自己的 `ep.log`，`v1-models-session-setup.mjs:21-49`、`:110`） | `turnWith` 默认取 `ep.log.slice(mark.log).filter((line) => !line.check)`：溢出那一轮现在末尾多一个 `check: true` 的 200，滤掉之后 `:1123` 的 `[400, 200, 200]` 不变；`:959`、`:1010`、`:1117-1118` 的其他 `turn.lines` 断言、`:1144-1156` 的 `untilCompaction`、`:444-453`、`:1285`、`:1818`、`:1840` 的 `talk()` 断言不改，必须照样通过；这个文件自己的代理与 `talk()` 不用加 `check` |
| `tests/ui/m3-helpers.mjs:114` 的 `lastReply`（MP-21：`v1-models-app-session.mjs:959`、`:987`、`:1011`，`:941` 经 `turnWith` 读它，模型是 `pb/fake-coder-replay`；MP-39：`v1-models-app-nooff.mjs:459`，模型是 `fake-coder-nooff`） | 这些模型的默认检查回应带思考（§14.1），每次检查之后多一项只有 `Thought process` 的助手项：`lastReply` 改为取窗格里最后一个正文不为空（有 `.prose`）的 `[data-testid="assistant"]`，不取 `.last()`；`:434`、`:1066` 的回应不带思考，本来不受影响 |
| `tests/ui/m4-app.mjs:370-371`（`sendQuote`，从会话文件取最后一条助手消息核对引用块） | 会话文件里最后一条助手消息现在是只有 `finish` 的那条（文字为空）：改为最后一条文字不为空的助手消息（同 `m6-app-slash.mjs` 那一行） |
| `tests/ui/m2-app.mjs:567`、`:588-589`、`:946-976`，`m4-app.mjs:447-541`、`:650`、`:701`（界面上的检查，不含 `sendQuote` 读会话文件的那一处），`m1-app.mjs`、`m5-app.mjs`、`m3-helpers.mjs` 的其余读法、`v1-switch-helpers.mjs:261-288`（`paneState`）、`tb-helpers.mjs:782-796`（`transcriptItems`）里按最后一个助手项、助手项数、最后一张工具卡的地方 | 不改，必须照样通过：只有 `finish` 的消息在 `agent_settled` 之后不留项、不建卡（§10.1）。在 `-replay`（开着思考）、`-alwaysthink`、`-nooff` 模型上读最后一个助手项的地方同上一行处理。不通过时先查 §10.1 有没有做到，不改断言 |
| 单元：`tests/unit/memory/core-team.test.mjs:16-18`、`:69`、`:72`，`tests/unit/taskboard/lifecycle.test.mjs:17-19`、`:249`、`:261`，`team.test.mjs:519`，`tests/unit/memory/text-sections.test.mjs:252-258`、`:298`，`text-callers.test.mjs:105`，`text-identity.test.mjs:43-66` | 这些替身会话（`taskboard/teamHarness.mjs:58-70`、`memory/text-helpers.mjs:121`）建 `MemorySessionSpec` 时不带 `check`，按 §4.2 的条件不注册 `finish`，启用的工具不变；断言 `applyDialogTools` 返回的条目或 `run.allowed` 的地方加 `finish`（文件系统实现后没有这些断言，§11）。实现时逐个跑过，改了哪些写进检查记录 |
| `tests/unit/memory/text-callers.test.mjs:148`（`assert.deepEqual(create.memory, { enhance: null })`） | `team.ts:1065` 现在给 `{ enhance, check: null }`：期望改为 `{ enhance: null, check: null }`；`:166` 的 `spec.memory.enhance` 不变 |
| `tests/ui/fs-app-away.mjs`（FS-78、FS-79；文件系统先落地时才有） | 本文实现时照 §11 改：用户会话里提醒跟在检查那一行之后、与检查合成一次请求，用 `{ check: true }` 取那次请求，期望合成端点默认回 `finish`（2026-10-27 注：文件系统已合并，照此改了；FS-79 用起点消息里的 `fc-check-wait:3000` 把这次默认回应推迟 3 秒，在检查之后还要再自动处理一次的 once 那条链改用 fc 场景 `fc-away-once`，都在 `tests/fake-endpoint/finish.mjs`） |
| `tests/unit/taskboard/platform.test.mjs:64-72`（TB-34 的免批准集合） | 不改；`finish` 的免批准由 FC-04 测。`TEAM_TOOLS` 不加 `finish`（`tb-app-roles.mjs:398`、`tb-app-stop.mjs:1118` 用这张表） |
| `tests/ui/v1-models-real.mjs:192`、`:253`、`:479`（一轮最后一条助手消息 `stopReason` 为 `stop` 且有文字），`:143-148`、`:230-242`（每轮的片段） | 改为这一轮最后一条有文字的助手消息；片段里多出的检查那一行与 `finish` 调用、结果跳过。真实层在走查时跑 |
| `tests/ui/m0-real.mjs`–`m6-real.mjs` 里按界面最后一个回复、助手项数的检查 | 不改：只有 `finish` 的消息不留项；走查时跑一遍确认 |
| `tests/ui/tb-real.mjs`、`tb-real-helpers.mjs:202` | 不改原有断言（`:58-68` 跳过没有文字的消息，`:213-218` 只禁写入工具）；FC-27 另记真实模型调没调 `finish` |
| 现有回放的 fixture（`tests/fixtures/{m1..m6,tb,v1,mem,discovery}`） | 不重录：录制里没有检查的事件，回放的是旧会话，界面照旧（§10 的改动对没有 `finish` 的事件不起作用）。将来因别的原因重录时（例如文件系统规格 §19.4 要求的重录），录制里会有检查：`mem-replay.mjs:171` 的 `cards.length === 6`、`tb-replay.mjs:340`、`m3-replay.mjs:489`（最后一条助手消息的 `message_end`）按 §10.1 应照样通过，不通过时按 FC-23 查 |
| `tests/spec-coverage.mjs`、`tests/unit/taskboard/spec-coverage.test.mjs`、`tests/unit/fc-reporter.mjs`（新） | §14.3 |
| `tests/ui/v1-models-existing.mjs` | 加套件组 `finish` 和预设 `FC-28`（§14.3） |

实现前再 grep 一遍 `app/tests` 里断言用户会话的请求数、请求的顺序（共用或限并发的模型上）、请求的 `tools`、会话文件里最后一条助手消息、`agent_start` 次数的地方，
以及在 `-replay`、`-alwaysthink`、`-nooff` 模型上读最后一个助手项（`paneState().assistants`、`transcriptItems`）的地方（上表是写规格时查到的），改了哪些写进检查记录。

## 15. 第 2 步：过程的折叠（本轮不做）

proposal §14 第 2 步“照 Claude 桌面版（Code 标签页）把一轮里最后一次干活之前的文字和工具卡收进可以展开的过程”这一轮不做，规格留待负责人审完 proposal 与本文再写。
到时要定的（proposal §13 第 4、17 条）：折叠头的文字、悬停与读屏名（对照 Claude 桌面版，登记进 [v0/ui-strings.md](../v0/ui-strings.md)）；“干活”同本文 §1（`finish` 不算）；
Copy 要不要只复制最终回复；Code 标签页若其实不折叠，改记为 Mori 自己的决定。本步的界面不依赖它：b、c 的对话流照旧平铺（§10.4）。
