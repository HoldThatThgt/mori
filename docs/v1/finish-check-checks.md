# 收尾检查 检查记录

依据：[构建规格](../specs/finish-check.md)（下称“规格”），它实现 [收尾检查 Proposal](../proposals/finish-check.md) 第一版（2026-10-27，提交 `00e23b1`）的 §14 第 1 步。
规格在 worktree `finish-check-spec-aa810c`（分支 `claude/finish-check-spec-aa810c`，基于 `00e23b1`）里写成，只改文档，没有提交；由发起会话提交、合并。

## 状态

**规格已写、未实现**（2026-10-27）。没有改 `app/`，没有跑任何测试。实现由另一个会话按规格做；实现之后在这里补“实现结果”“与规格不同之处”“未验证项”。

第 2 步（过程的折叠，proposal §14）这一轮不做，规格 §15 写明留待负责人审完 proposal 与规格再写。

## 负责人的决定（2026-10-27，与发起会话谈定）

proposal §12 的 7 条：回复照常写成文字、只加一个不带参数的确认工具；用 `agent_before_settle`、只在 `completed` 时检查；上限（两次检查之间没调工具不再追问、一次运行最多 3 次、停止或出错不检查）；
每次运行都检查；会话里只存一行检查、TASTE 与 REVIEW 只在检查那次请求临时接上；先只做用户会话、席位按 prompt-and-memory；前一段回复变成过程文字、折叠与 `finish` 卡按“照 Claude 桌面版”推荐并登记。

## 负责人不在时定下的选择（无人模式，待负责人审）

写 proposal 时定的 19 条在 proposal §13，写规格时定的 18 条在规格 §0（评审后由 15 条加到 18 条）；两组都登记在 [defaults.md](defaults.md) 的“收尾检查”一节（第一张表、第二张表）。写规格时定的：

| # | 问题 | 可选 | 选了（推荐项） | 理由 | 改到的文件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 计数从哪条消息往后数 | 最后一条 `role: 'user'`；或另记这次运行的开始 | 最后一条 `role: 'user'` | proposal 的字面；Mori 不以 custom 消息开始运行；不另存状态 | 规格 §5.2、§5.4 |
| 2 | 压缩后数不到更早的检查行 | 只数看得到的；另存计数 | 只数看得到的 | 不另存状态（proposal §13 第 19 条） | 规格 §5.4 |
| 3 | `finish` 的结果与标签 | — | `Confirmed.`；`Finish` | 短、只给模型看 | 规格 §4.1、§7.3 |
| 4 | 检查那一行、检查块的原文与拼法 | 单独一条消息；接进同一条 | 规格 §7 的原文，接进同一个字符串 | proposal §5.5、§14；一条消息 | 规格 §6、§7 |
| 5 | 检查那次请求出错时 Team 怎么算 | 当作已完成；当作出错 | 当作已完成（发送方拿到检查之前的那段回复，出错消息里的半截文字不算） | proposal §8 的建议 | 规格 §8.3 |
| 6 | 一次运行一份运行记录的范围 | 只用户会话；所有会话 | 所有会话（强制填写的运行压缩后重试时另清 `assistants`、`formMode`） | 实例上今天就会丢记录 | 规格 §8.1；平行 Agent 规格 §9.4、文件系统规格 §9.8 的注 |
| 7 | 换模型不隐藏的范围 | 只用户会话；所有会话 | 所有会话；`finish` 不算工具调用；条目带 `afterReply`、不改更早的重做说明 | proposal 的规则不分会话 | 规格 §9.2；模型层规格 §6.1、平行 Agent 规格 §12.4 的注 |
| 8 | 放回链接什么时候不带 | 只检查那次请求；所有跟在完整回复之后的错误 | 所有跟在完整回复之后的错误（Team 只把检查那次请求的出错当作已完成） | 规则只看对话流 | 规格 §10.3、§8.3 |
| 9 | 检查那次请求里的思考 | 显示；整条藏起 | 显示（只有 `finish` 的消息不留项） | 不藏模型写的；先藏会闪 | 规格 §10.1 |
| 10 | 文件系统实现后 `finish` 算什么 | 职责工具（进 `applyDutyTools` 的表）；同 `ask_user_question` | 路径闸的 `duty`，`applyDutyTools` 不动它 | 效果相同、规则更少；`mcp: false` 不能拒绝它 | 规格 §11；文件系统规格 §8.6 的注 |
| 11 | 界面的 `runTeamMode` | 每个 `agent_start` 记；只第一个 | 只第一个 | 同一次运行 | 规格 §10.1 |
| 12 | 合成端点怎样回应检查 | 默认 `finish`；逐个改脚本 | 默认 `finish`（带思考的模型照旧带思考），另有 `fc-scenario:` | 现有脚本不用改；`-replay` 模型去掉思考会 400 | 规格 §14.1 |
| 13 | 测试的名字 | — | `--spec finish`、`FC-n`、`fc-`、端口 4950–4979 | 同其他规格 | 规格 §14 |
| 14 | 回复下的操作行挂在哪 | 最后一个助手项；最后一个有文字的助手项 | 最后一个有文字的助手项（有进展摘要时照旧挂在摘要下） | 操作行是对正文的 | 规格 §10.1 |
| 15 | 测试里数请求的地方 | 逐条改断言；帮助函数默认跳过检查请求 | 点名的帮助函数默认跳过，读原始日志的测试自己过滤 | 现有几十处断言不变 | 规格 §14.4 |
| 16 | 换到推理必须回传的模型 | 接受重建；只对 `finish` 另写剥离 | 接受重建 | 最简单；写代码的会话本来就要重建 | 规格 §9.5；模型层规格 §6.2 的注 |
| 17 | 检查时停止或出错之后的旧检查行 | 接受连着的 user 消息；另加清理 | 接受 | 同今天停止或出错的情形 | 规格 §7.1、§5.4 |
| 18 | 之后再换模型时的检查那一行 | 留着；一起隐藏 | 一起隐藏 | 留着会让新模型盲确认 | 规格 §9.2 |

## 开工前核对的 pi 行为（写规格时，pi 1.3.0）

规格 §3 的 16 条，都对照了代码（行号见规格）。要点：

- `agent_before_settle` 只在运行要结束时发、停止时不发；`continue: true` 之后在同一次运行里再发 `agent_start`、`turn_start`，不发 `before_agent_start`，`agent_settled` 只发一次。
- `emitBoundary` 用处理器返回的 `entries` 替换累计的数组，后一个处理器看到的 `event.context` 已含前一个的条目。
- `context` 钩子在路由（`prepareRequest`）之后跑，路由看不到检查块与工作卡；扩展顺序 `mori-models`、`mori-team`、`mori-memory`、`mori-approval`。
- `message_end` 先发给监听者、后写盘（Team 判断“出错是否紧跟检查那一行”时分支上可能还没有这条消息）。
- 参数校验用 TypeBox 编译 JSON Schema，`additionalProperties: false` 生效。
- 文件系统规格还没实现（`applyDutyTools`、`agent_before_settle` 的提醒都不在代码里），规格按现在的代码写，先后关系见规格 §11。

## 规格的评审与改动

规格写完后用 Workflow 做了一轮对抗评审（2026-10-27）：六个维度（pi 的行为、内核落点、界面落点、与 proposal 是否一致与内部一致、测试与验收、与文件系统规格的配合）各一位评审，每条发现由一位反驳者对照代码核实，共 58 个 Agent。52 条发现：成立 29 条、部分成立 20 条、不成立 3 条；成立与部分成立的 49 条都已改（部分成立的按反驳者修正后的改法）。两条反驳者意见相冲突（合成端点默认回应要不要去掉思考），按代码（`probes.mjs:168-173` 的 `replayRejected`）定为保留。原始发现与判词在发起会话的共享笔记目录。

| 发现 | 判词 | 严重度 | 标题（评审原文） | 怎么处理 |
| --- | --- | --- | --- | --- |
| pi-behavior#1 | invalid | high | event.outcome goes stale when a request fails in routing, so the check runs after a failed request and the routing failure (wait plus No model available card) happens twice | 不改：反驳者核实 pi 在路由失败时经 turn_end（agent-session.js:899-902）把 outcome 记成 error；§3 第 4 条补了这一点 |
| pi-behavior#2 | valid | medium | When the reply already carries a finish call, followsToolFreeReply is false, so switching models on the check request hides the reply | §9.2：followsToolFreeReply 不算 finish；FC-21 加 fc-early |
| pi-behavior#3 | invalid | low | Queued messages already in pi's queue at the boundary are not handled; a steer lands after the check line and the check block is dropped | 不改：反驳者核实不成立 |
| pi-behavior#4 | partly | low | §5.4 #4 and #5 leave out pi's post-run _checkCompaction, which runs just before the boundary (truncated-reply retry, threshold compaction) | §3 第 12 条、§5.4 第 4、5 条、§0 第 2 条：可恢复的截断先压缩重试、不到边界；每次运行结束前的阈值压缩 |
| pi-behavior#5 | valid | low | pendingTokens stays set when the check request never reaches the context hook, inflating the next run's routing estimate | §6.2、§9.3：mori-memory 在 agent_settled 时清 pendingTokens；FC-22 |
| pi-behavior#6 | valid | low | followsCheck's skip list misses entries pi can append between the check line and the error | §8.3 followsCheck 跳过 system 消息与 compaction 条目；§3 第 18 条；FC-19 |
| pi-behavior#7 | partly | low | §3 row 1 wording and row 4 citation do not match pi | §3 第 1、4 条改写与改引用 |
| kernel-landing#1 | valid | medium | §8.3 says decisionNote records the merged session's judgment, but decisionNote never runs for the user lane | §8.3、§0 第 5 条、FC-19：去掉 decisionNote 的说法，只影响 settleWaiters |
| kernel-landing#2 | partly | medium | A non-hiding switch on the check request can rewrite an earlier redo note in the same segment | §9.2：ModelSwitchEntryData.afterReply，notesPerReply 跳过它；模型层规格 §6.1 的注；FC-21 |
| kernel-landing#3 | valid | low | pendingTokens stays set when the check request's context hook never runs (routing exhaustion, Stop while waiting for a model) | 同 pi-behavior#5；FC-22 的窗口判断一句改为只在选新模型时 |
| kernel-landing#4 | valid | medium | Existing test call sites build MemorySessionSpec without `check`; `!== null` registers finish for them, and text-callers.test.mjs:148 is not listed | §4.2：注册条件写成 setup.check 为真（同 if (setup.tool)），不带 check 的替身不注册；§14.4 加 text-callers.test.mjs:148 |
| kernel-landing#5 | partly | low | Applying one-run-one-record to instances stops forced-fill shaping after an overflow-compaction retry | §8.1：强制填写的运行在 compaction_end { willRetry } 时清 assistants、formMode；§0 第 6 条；FC-18 |
| kernel-landing#6 | valid | low | The error override delivers a partial check-request message as a successful reply | §8.3：出错消息不更新 run.lastText；FC-19 |
| kernel-landing#7 | partly | low | After b, a later hidden switch leaves the check line in context with its reply hidden, and settleDecision then accepts a blind finish | §9.2：隐藏区间里的检查那一行一起隐藏（isHidden，两种形状）；§0 第 18 条；FC-21 |
| renderer-landing#1 | valid | medium | afterReply is not rebuilt from history, so after reattaching mid-check the error card still offers the put-back link | §10.3：afterReplyOf 共用，transcriptFromEntries 也维护；FC-17 |
| renderer-landing#2 | valid | medium | Removing a finish-only item assumes resumeStreaming always pushes the streaming item; the spec's wording invites the opposite | §10.1：只有 addAssistant 不加项，resumeStreaming 照常推、由 message_end 去掉；FC-23 |
| renderer-landing#3 | valid | medium | The replyTurns anchor change drops the progress-summary rule and blurs two different 'anchors' | §10.1、§0 第 14 条：只改 Map 键的助手项那一支，进展摘要照旧取键；FC-23 |
| renderer-landing#4 | valid | low | The runTeamMode change (record only on the first agent_start) has no acceptance item | §10.1：withRunMode 纯函数；FC-23 |
| renderer-landing#5 | valid | low | A finish-only message whose stopReason is aborted or error would lose its Stopped/error line on reopen | §10.1：打开会话时只有 finish 的停止、出错消息照旧推 stopped 或错误卡；FC-23 |
| renderer-landing#6 | partly | low | A late tool name can leave an empty-titled card, because the finish skip keys on toolName alone | §10.1：名字为空的增量也不建卡（取简单的那种）；FC-23 |
| renderer-landing#7 | partly | low | The claim 'no empty div[data-item]' and the state table ignore what shows while the check message streams | §10.1、§10.4：流式时那一项没有内容、开了思考时有展开的 Thinking…；FC-23 改为 agent_settled 之后 |
| fidelity-consistency#1 | partly | medium | Every run's `finish` call now counts as a foreign tool call, so switching to a replay-required model always rebuilds; the spec says the model layer is unchanged | §9.5、§0 第 16 条、模型层规格 §6.2 的注、defaults.md：接受重建（另一种做法登记待审）；FC-29 |
| fidelity-consistency#2 | valid | medium | §8.3 says `decisionNote` records the merged session's judgment, but `decisionNote` never runs for the user session | 同 kernel-landing#1；defaults.md 那一行 |
| fidelity-consistency#3 | partly | medium | The file-system §9.8 reminder position and FS-78 conflict with the check line on the same boundary, and no note was added there | 文件系统规格 §9.8 两行与 FS-78 加注；平行 Agent 规格 §12.4 加注；§11、§13 |
| fidelity-consistency#4 | partly | low | The synthetic endpoint's dispatch order between the default check reply, fc-scenarios and -replay thinking is contradictory or unspecified | §14.1：判断顺序写明；思考钩子照旧（按 tests-acceptance#3，-replay 去掉思考会 400） |
| fidelity-consistency#5 | partly | low | The UI `runTeamMode` change (§0 #11) and other §10 behaviours have no acceptance item | 同 renderer-landing#4；FC-17 加 compaction_end；FC-11 加 Unread 一次 |
| fidelity-consistency#6 | valid | low | The `replyTurns` anchor rule leaves out the existing progress-summary anchor | 同 renderer-landing#3 |
| fidelity-consistency#7 | partly | low | `pendingTokens` stays set when the check request never reaches the context hook | 同 pi-behavior#5 |
| fidelity-consistency#8 | invalid | low | Proposal §14's step-2 "构建规格定" item is deferred without a registered decision | 不改：反驳者核实不成立 |
| fidelity-consistency#9 | valid | low | Small mismatches between defaults.md, §12 and the spec body, plus a wrong cross-reference in §0 #1 | §0 第 1 条改引用；defaults.md 加检查块的 token 估算一行、改两处位置 |
| fidelity-consistency#10 | partly | low | Saying the stale check line is harmless ignores consecutive user messages after Stop or an error | §7.1、§5.4 第 9 条、§10.4、§0 第 17 条、proposal §8 严格交替一行：接受连着的 user 消息；FC-16、FC-27 |
| fidelity-consistency#11 | valid | low | The state table says the enhancement task "only looks at the new paragraph", but nothing implements it | §10.4 c 行与 proposal §5.3、§6.3：去掉“增强任务只看新的那段” |
| fidelity-consistency#12 | partly | low | The Team treats an error after a reminder-only request as an error, while the UI treats it as a finished reply | 取 B：§0 第 8 条、§8.3 写明只带提醒的那次请求出错照旧按出错 |
| fidelity-consistency#13 | partly | low | The check line is about four times the size the proposal states | §7.1 加量（560 字符、约 140 token）；proposal §4、§8 的数字改 |
| tests-acceptance#1 | valid | high | Scheduling-order tests read raw endpoint logs; check requests jump the queue and break TB-41 and MEM-32 | §14.4 加 TB-41、MEM-32 两行，前言写明读原始日志的测试自己过滤 |
| tests-acceptance#2 | partly | high | MP-22 asserts an exact status sequence through a second proxy/log that the default skip does not cover | §14.4 加 MP-22（v1-models-app-session.mjs 的 turnWith） |
| tests-acceptance#3 | valid | medium | Always-thinking models turn the default check reply into a visible 'Thought process' item; lastReply-based checks break | §14.1 默认回应保留思考钩子；§14.4 加 m3-helpers.mjs 的 lastReply（MP-21、MP-39） |
| tests-acceptance#4 | valid | medium | m4-app sendQuote reads the last assistant message in the session file; missing from §14.4 | §14.4 加 m4-app.mjs:370-371 的 sendQuote |
| tests-acceptance#5 | valid | medium | Unit stubs: `check` is undefined, not null, so `!== null` registers finish; text-callers deepEqual on instance memory breaks | 同 kernel-landing#4 |
| tests-acceptance#6 | partly | medium | The fake endpoint cannot give a non-default check response inside a tb-scenario team session (FC-18/FC-19 App) | §14.1：判断顺序、fc-scenario 只认 tools 有 finish 的请求、协作模式怎样带场景名、加 fc-work-fail 与 fc-a-think |
| tests-acceptance#7 | valid | low | checkPlan/fc dispatcher placement makes FC-26 untestable as written and risks an import cycle | §14.1：CHECK_LINE_HEAD 在 scripts.mjs，checkPlan 与场景在新文件 finish.mjs（不放 scenarios/）；FC-26 |
| tests-acceptance#8 | valid | low | Replay layer depends on a fixture only the owner-run real layer produces | §14.1：回放的 fixture 全由 fc-record.mjs 合成录制，真实录制另名 *-real.json；FC-11、FC-23、FC-27 |
| tests-acceptance#9 | valid | low | Default skip makes the 'no request after Stop' checks blind to check requests | §14.4：TB-35 三处加 { check: true }；FC-16 加停止之后没有请求 |
| tests-acceptance#10 | partly | low | runTeamMode-on-first-agent_start (§10.1, §0 #11) has no acceptance item | 同 renderer-landing#4 |
| fs-interplay#1 | valid | medium | finish is added to DUTY_TOOLS only by a note in FS-permissions §8.6; the FS sections that define DUTY_TOOLS still list members that leave it out | 文件系统规格 §6.1、§6.2（两处）、§8.2、file-system.md §1、§2、FS-30、FS-84 加注；§11、§13 |
| fs-interplay#2 | valid | medium | When the check and the away reminder share a boundary, FS §9.8 and FS-78 no longer hold for user sessions, and the test helpers hide the combined request | §11 提醒一行、§5.4 第 13 条；文件系统规格 §9.8 两行与 FS-78 加注；§14.4 加 fs-app-away.mjs；proposal §10 |
| fs-interplay#3 | valid | medium | One run record per pi run (§8.1) is also a prerequisite of the FS reminder, but §11 says only three places need to match | §11 加“一次运行一份运行记录”一行；文件系统规格 §9.8 加注 |
| fs-interplay#4 | valid | medium | FC-03, FC-04, FC-18 and some §14.4 rows test code the file-system spec deletes, and neither order says how they change | §11 加“被文件系统删掉的代码上的验收”一行；FC-03、FC-04、FC-18 标“文件系统实现前”；文件系统规格 §8.6 的注点名这些测试 |
| fs-interplay#5 | valid | medium | In the finish-check-first order, the FS-115 preset and the spec-coverage expected message ignore FC-28 and `--spec finish` | §11 加“汇总预设与覆盖检查”一行；file-system.md §19.3、§19.4 加注 |
| fs-interplay#6 | valid | medium | The check line tells the model to redo calls that 'didn't go through', which conflicts with FS's 'Don't retry' denial texts and with FS-82 | §7.1 第二行改为只补没发出去的调用、不重试被拒绝的；§11；FC-27 记重试数 |
| fs-interplay#7 | partly | low | The model-providers §6.1 note says task instances don't restart, but TaskBoard §12.4 and the model-providers §10 row were not annotated, and FS's reminder is the only instance trigger | 平行 Agent 规格 §12.4 加注；§9.2 写明改 switchFrom、restartFrom 的注释；FC-21 加 task 种类 |
| fs-interplay#8 | partly | low | With both specs, the per-task test:min budget exceeds the 2-minute cap | §14.1 test:fc-unit 降到 10 秒；§11 加“test:min 的时长”一行与超出时停下报告；file-system.md §19.1 加注 |

## 实现时要记的

- `npm run test:fc-unit` 与 `npm run test:min` 实测的时长（前者 ≤ 10 秒，后者 ≤ 2 分钟；与文件系统的 `test:fs-unit` 合起来超过时停下报告，规格 §11）。
- 规格 §14.4 列的现有测试改了哪些、实现前 grep 又找到哪些。
- 真实模型走查（FC-27）的数字：按服务的 a、b、c，“写话 + `finish`”与“只写话”，没有字段的工具调不调得通，检查那次请求的思考与输出 token、缓存，Mori 开始的运行的检查次数。
- 跳过的测试层（AGENTS.md“测试分层”：任务里只跑 `test:min`，App、回放、真实、`spec-coverage` 留到推送前的完整测试）。

## 未验证项

全部：规格还没实现。
