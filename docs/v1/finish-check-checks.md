# 收尾检查 检查记录

依据：[构建规格](../specs/finish-check.md)（下称“规格”），它实现 [收尾检查 Proposal](../proposals/finish-check.md) 第一版（2026-10-27，提交 `00e23b1`）的 §14 第 1 步。
规格在 worktree `finish-check-spec-aa810c`（分支 `claude/finish-check-spec-aa810c`，基于 `00e23b1`）里写成，只改文档，没有提交；由发起会话提交、合并。

## 状态

**已实现、未提交**（2026-10-27，worktree `finish-check-impl-a75d50`，分支 `claude/finish-check-impl-a75d50`，基于规格提交 `3e5c3fc`）。
规格 §13 的文件都改了：别的规格里的注在写规格时（`3e5c3fc`）已加，这一次改了 `app/src`（按 §2）、`app/tests`（按 §14）、`app/package.json`、`AGENTS.md`、本文与 defaults.md，规格与 proposal 的状态行；`npm run test:min` 通过（见“实现结果”）；
FC-01..FC-29 的单元、App、回放、真实层都写了；回放用的 6 个合成 fixture 已从真实的 App 录下；真实模型走查 FC-27 的结果见“真实模型走查”。
按 AGENTS.md“测试分层”，开窗口的套件（新写的 `fc-*` App 与回放套件、改过的现有界面套件）与 `spec-coverage` 没有跑，列在“未验证项”，留给推送前的完整测试。
实现时补了两处规格没写到的（“实现时定的”第 1、2 条，规格 §9.2 与 FC-18 已加注），都**待负责人审**；实现时的其余选择同样待负责人审，登记在 [defaults.md](defaults.md)“收尾检查”第三张表。

第 2 步（过程的折叠，proposal §14）这一轮不做，规格 §15 写明留待负责人审完 proposal 与规格再写。

## 负责人的决定（2026-10-27，与发起会话谈定）

proposal §12 的 7 条：回复照常写成文字、只加一个不带参数的确认工具；用 `agent_before_settle`、只在 `completed` 时检查；上限（两次检查之间没调工具不再追问、一次运行最多 3 次、停止或出错不检查）；
每次运行都检查；会话里只存一行检查、TASTE 与 REVIEW 只在检查那次请求临时接上；先只做用户会话、席位按 prompt-and-memory；前一段回复变成过程文字、折叠与 `finish` 卡按“照 Claude 桌面版”推荐并登记。

## 负责人不在时定下的选择（无人模式，待负责人审）

写 proposal 时定的 19 条在 proposal §13，写规格时定的 18 条在规格 §0（评审后由 15 条加到 18 条）；两组都登记在 [defaults.md](defaults.md) 的“收尾检查”一节（第一张表、第二张表）。写规格时定的：

| # | 问题 | 可选 | 选了（推荐项） | 理由 | 改到的文件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 计数从哪条消息往后数 | 最后一条 `role: 'user'`；或另记这次运行的开始 | 最后一条 `role: 'user'` | proposal 的字面；Mori 不以 custom 消息开始运行；不另存状态 | 规格 §5.2、§5.4 |
| 2 | 压缩后数不到更早的检查行 | 只数看得到的；另存计数；从分支上数 | 从分支上数（2026-10-27 推送前的完整测试之后由“只数看得到的”改来，见“推送前完整测试：m1-app 与 m2-app 的两条失败”） | 不另存状态（proposal §13 第 19 条），也守住每次运行最多 3 次（proposal §12 第 3 条）；只数看得到的在每次回复之后都压缩时停不下来 | 规格 §0 第 2 条、§5.1、§5.2、§5.4 第 5 条、§9.2、FC-07、FC-08 |
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

## 实现结果（2026-10-27）

做法：先由发起实现的会话写共用部分（`shared/finishCheck.ts`、`kernel/finishCheck.ts` 的纯函数与 `mori-memory`、`sessions.ts` 的接线），
再用 Workflow 按文件分给十个实现者并行写其余部分（Team 与批准、内核单元测试、模型层、界面、合成端点、测试基建、现有测试的调整、
两个 App 套件、录制 / 回放 / 真实层），每份文件只有一个实现者；之后一轮对抗评审（见“实现的评审”）。

| 规格 | 落点 | 说明 |
| --- | --- | --- |
| §4、§5、§6、§7 | `app/src/shared/finishCheck.ts`（新）、`app/src/kernel/finishCheck.ts`（新）、`kernel/memoryExtension.ts` | `finishTool`、`checkLine`、`checkBlock`、`settleDecision`、`checkRequestIndex`、`withCheckBlock`、`followsCheck`；`setup.check` 为真时注册 `finish` 与 `agent_before_settle`、`context`、`agent_settled` 三个处理器，`before_agent_start` 记下这次运行的种类、检查块与估算（`checkRunOf`）；§7.4 的日志原文 |
| §4.2、§9.3 | `kernel/sessions.ts` | `userCheckWiring(enhance, cardTokens)`（评审后为可测改成导出的纯函数）：非增强的用户会话建 `FinishCheckLink`，`extraContextTokens` = 工作卡 + `pendingTokens`；`team.ts` 的实例 `memory` 带 `check: null` |
| §8 | `kernel/teamRuns.ts`、`kernel/team.ts`、`kernel/teamHost.ts`（注释） | `runStarted` 在 `lane.run !== null` 时直接返回；实例 `compaction_end { willRetry }` 且强制填写时清 `assistants`、`formMode`；`applyDialogTools` 两个分支留 `finish`；用户会话检查那次请求出错按已完成（`followsCheck`），不改 `lastText`，记 §7.4 的错误日志 |
| §4.4、§9.1 | `kernel/approval.ts` | `FREE_TOOLS` 加 `finish` |
| §9.2、§9.3 | `shared/models.ts`、`kernel/modelContext.ts`、`kernel/modelSession.ts` | `ModelSwitchEntryData.afterReply`；`followsToolFreeReply(messages, since?)`；`switchFrom` 写 `afterReply`、`hideUntil = replyStartedAt`；`notesPerReply` 跳过它；`isHidden` 把隐藏区间里的检查那一行一起隐藏（两种形状） |
| §10 | `renderer/src/state/model.ts`、`transcript.ts`、`history.ts`、`turns.ts`、`actions.ts`、`teamEvents.ts` | `blocksFromContent` 不画 `finish`；`finishOnly`、`afterReplyOf`、`Transcript.afterReply`；增量、开始执行、执行中、结束、批准闸都跳过 `finish`（名字为空的增量也不建卡）；只有 `finish` 的消息实时与打开会话都不留项；错误卡在 `afterReply` 时不带放回；`replyTurns` 的键只取有正文的助手项；`withRunMode` |
| §14.1 | `tests/fake-endpoint/scripts.mjs`、`server.mjs`、`finish.mjs`（新） | `CHECK_LINE_HEAD`；`deliveriesOf` 跳过检查那一行；`sessionOf` 带 `check`、`checks`；日志行加 `check`、`checks`；`checkPlan`、`fcScenarioOf`、`finishReply` 与 14 个 `fc-*` 场景；`conversationPlan` 的判断顺序同规格 |
| §14.2 | `tests/unit/finish/*.test.mjs`（新：`core`、`extension`、`extension-instances`、`team`、`model`、`ui`、`endpoint`，加 `kernel-helpers.mjs`） | FC-01..FC-10、FC-17..FC-19、FC-21..FC-23、FC-26、FC-29 的单元部分，共 104 条 |
| §14.2 | `tests/ui/fc-app-check.mjs`、`fc-helpers.mjs`、`fc-app-team.mjs`、`fc-team-helpers.mjs`、`tests/fake-endpoint/scenarios/fc-team.mjs`（新） | App 层：关闭模式与界面（端口 4950–4951）；协作模式与 Team（4960–4963） |
| §14.1 | `tests/ui/fc-record.mjs`、`fc-replay.mjs`、`fc-real.mjs`、`fc-real-helpers.mjs`（新），`tests/ui/harness/main.jsx` | 录制（4970）、回放、真实层（转发代理 4975；`--source` 或 `--keys <文件夹>` 两种方式，key 只在进程里） |
| §14.3 | `app/package.json`、`tests/unit/fc-reporter.mjs`（新）、`tests/spec-coverage.mjs`、`tests/unit/taskboard/spec-coverage.test.mjs`、`tests/ui/v1-models-existing.mjs`、`AGENTS.md` | `test:fc-unit`、`test:finish`，`test:min` 末尾加 `test:fc-unit`；`--spec finish`；套件组 `finish` 与预设 `FC-28`；AGENTS.md 的测试分层与常用命令 |
| §13 | `docs/specs/finish-check.md`（开头状态、§9.2 与 FC-18 两处实现时补的注）、`docs/proposals/finish-check.md`（状态行）、本文、`docs/v1/defaults.md` | — |

**测试时长**（本机，2026-10-27）：`npm run test:fc-unit` 单独 5.9 秒（≤ 10 秒）；`npm run test:min` 77 秒（第一次）、69 秒（评审改完之后）、67 秒（最后一次，走查之后），
各组 418 / 338 / 222 / 197 / 104 条全部通过（≤ 2 分钟；文件系统的 `test:fs-unit` 还不在代码里，合起来的时长等文件系统实现时再量，规格 §11）。
AGENTS.md“测试分层”第 1 条的时长改为“2026-10-27 连同 `test:fc-unit` 约 80 秒”。

**单元测试的改动核对**（规格 §14.4 单元一行）：`tests/unit/memory/core-team`、`text-sections`、`text-identity`、`text-helpers`，`tests/unit/taskboard/lifecycle`、`team`、`teamHarness`
都没有改，在 `test:min` 里照样通过（替身不带 `check`，不注册 `finish`）；只改了 `text-callers.test.mjs:148`（`{ enhance: null, check: null }`）。
`tests/unit/taskboard/spec-coverage.test.mjs` 按 §14.3 加了 `finish` 的三条 TB-46 检查。

## 现有界面测试的改动（§14.4，没有跑）

按表改的：`tb-helpers.mjs` 的 `scenarioLines`、`scenarioRequests` 默认跳过 `check: true`，`{ check: true }` 才取；`v1-switch-helpers.mjs` 的记录代理按 `checkPlan` 给 `captures` 标 `check`，
检查请求的 `index` 为 0、不算进按模型的序号，`rule` 收到 `check`；`v1-models-app-switch.mjs` 的 `chatLogs`、`captures` 跳过检查请求；TB-10 `starts === 2` 并改名；
TB-03 去掉 `memory`、`finish`（`ADDED_TOOLS`）；TB-09 三组集合加 `finish`；MEM-02、MEM-11 的 `sameSet` 加 `finish`；`m6-app-slash.mjs` 与 `m4-app.mjs` 的 `sendQuote` 取最后一条文字不为空的助手消息；
TB-35 三处 `{ since: stopAt + 300, check: true }`；TB-41、MEM-32 在切片前滤掉 `check`；MP-22 的 `turnWith` 滤掉 `check`；`m3-helpers.mjs` 的 `lastReply` 取最后一个有 `.prose` 的助手项；
`v1-models-real.mjs` 用 `replyOf`（最后一条有文字、**没有工具调用**的助手消息：真实模型确认时可能“写话 + `finish`”，那条的 `stopReason` 是 `toolUse`）。
表里写“不改”的（`m6-app-tools` 的 `builtinRows`、TB-30、TB-56、m2 / m4 的界面读法、`paneState`、`transcriptItems`）读过代码，按 §10.1 应照样通过，没有改。

表外、实现前 grep 找到并改了的：
- `v1-models-app-switch.mjs` MP-15 `reopen15`：期望的请求角色在最后的 `user` 之前多了检查那一行、只有 `finish` 的助手消息与它的结果（`'user','assistant','tool'`）。
- `v1-models-app-switch.mjs` MP-20 `compactionNoModel`：阈值压缩失败之后 pi 照样到边界（规格 §3 第 12 条、§5.4 第 4 条），检查那次请求等冷却中的 y20（§10.4“检查那次请求等模型”）；
  测试改为等 `compaction_end` 的错误、按停止结束那次等待，阶段行只看到 `compaction_end` 为止（不按停止时等 60 秒后出 No model available 卡，同 §10.4）。
- `tb-record.mjs`：等协作空闲原来比 `agent_start` 与 `agent_settled` 的个数，检查之后同一次运行多一个 `agent_start`，永远不相等；改为看最后一个是不是 `agent_settled`（`sessionIdle`）。
- `tb-app-roles.mjs:683` TB-01、`tb-app-stop.mjs:685`（TB-35 `escJudge`）、`:869`（TB-36 `restartStep`）的“没有请求”加 `{ check: true }`，同 TB-35 那三处的理由。
- `mem-app-prompt.mjs` MEM-01 的 `suiteChecks`（“这个套件的每个对话请求”）加 `{ check: true }`：检查请求的 system prompt 同样要合格（FC-05）。
- grep 过、不用改的：`md-*`、`mem-app-team`、`tb-app-ask`、`tb-app-sched`、`m6-app-tools`、`v1-models-app-nooff`（读实例或增强会话，或检查请求同模型同 key 同强度）。
  （原来还列了 `tb-app-modes`：它的 `TEAM_DIALOG_TOOLS` 漏了 `finish`，推送前的完整测试里查到并改了，见“推送前的完整测试”。）

## 录 fixture（2026-10-27）

`node tests/ui/fc-record.mjs`（当时的构建）对合成端点录下 `tests/fixtures/finish/` 的 6 个 fixture，`source: 'synthetic'`：`fc-a`、`fc-a-text`、`fc-early`、`fc-b`、`fc-c`、`fc-a-think`
（`fc-a`、`fc-b`、`fc-a-think` 另录了重启后打开同一个会话的一段）。录制脚本自己的核对全部通过：每个场景的请求与检查请求数、`checks` 的值、一个 `agent_settled`、
每次检查多一个 `agent_start`、`finish` 的调用数、回复文字、思考、会话文件里检查那一行的条数与 `display: false`。例如 `fc-b` 的事件顺序是
回复 → 边界加检查那一行（`entry_appended`）→ `bash` → 新的回复 → 第二次检查 → 只有 `finish` → `Confirmed.` → 一个 `agent_settled`。
这是真实的内核、扩展顺序与 pi 1.3.0 在合成端点上走通的第一份证据；回放（`fc-replay.mjs`）没有跑。评审之后只改了模型层的换模型条目与 `sessions.ts` 的接线，
录制里没有换模型，没有重录。

## 真实模型走查（FC-27）

用 `fc-real.mjs` 的 key 方式跑（`--keys C:/Users/56865/OneDrive/Documents/HoldThatThgt`：key 只在进程里读，只输进 Mori 的密码框；
结果文件、note、fixture 与这次用过的数据目录都由脚本核对过没有 key，发起实现的会话另用进程内读出的 key 逐个比对了结果文件、note 与 fixture，没有）。
模型：DeepSeek `deepseek-flash`（openai-completions）、GLM `GLM-5.3`（anthropic-messages，`https://api.z.ai/api/anthropic`）、OpenRouter `qwen/qwen3.8-max-prime`。
用户级记忆写了一条 TASTE、一条 REVIEW（synthetic test setup），所以关闭模式的检查那一行点名两节、带检查块。

**几次运行**（2026-10-27）：

1. 三个服务全跑：GLM、Qwen 的五条程序保证全部通过；DeepSeek 的每个对话请求（10 个）都回 **422**，没有检查发生，四条失败。
2. 诊断：给转发代理加了出错响应的正文记录（`tb-real-helpers.mjs` 的 `errorText`，前 1000 字符；`fc-real.mjs` 的 note 加 `errors`、`failedSample`），
   `--only deepseek,record` 再跑一次拿到请求体；用进程内的 key 重放：原样 422，原文 `messages[0].role: unknown variant 'developer'`；去掉 `finish`、去掉 `memory` 仍是 422，
   只把 `developer` 改成 `system` 就是 200。原因在测试的转发代理：地址改成 `http://127.0.0.1:4975/p/<提供商 id>` 之后地址里没有 `deepseek.com`，
   pi 的 `detectCompat` 认不出 DeepSeek，按 OpenAI 的默认发 `developer` 角色与 `store`。**与收尾检查无关**（探针请求没有 system 消息，所以探针都过了）。
   改法只在测试里：代理地址写成 `/p/<提供商 id>@<原主机名>`（`fc-real-helpers.mjs` 的 `proxySegment`、`proxyRoutes`），pi 照样认得出 DeepSeek 与 OpenRouter。
   `tb-real-helpers.mjs` 自己的 `routeThroughProxy` 有同样的问题（TaskBoard 的真实层接 DeepSeek 时会 422），没有改，列为后续。
3. `--only deepseek`（改了代理之后，含 `team` 驱动）：DeepSeek 的五条程序保证全部通过。
4. 改了代理之后三个服务再全跑一次（下面“第 4 次运行”）：三个服务的五条程序保证全部通过。

**按服务的数字**（GLM、Qwen 取第 1 次运行，DeepSeek 取第 3 次运行；note 原件在共享笔记目录 `finish-check-fc27-notes.json`）：

| 服务 | 运行（你 / Mori） | 检查 | a | b | c | 未定 | 对检查的回应：只调 `finish` / 写话 + `finish` / 干活 / 停止 | 检查请求的输出 token 平均（最大） | 检查请求的思考 token 平均（最大） | 检查请求 `cache_read` 平均（最大） | `cache_creation` | 下一次请求 `cache_read` 平均 | `finish` 调用（都没有字段、都通过校验） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek | 10 / 1 | 11 | 10 | 0 | 0 | 1 | 7 / 2 / 1 / 1 | 64（293） | 37（271） | 2444（5376） | 0 | 2534 | 11 |
| GLM | 9 / 0 | 9 | 8 | 0 | 0 | 1 | 1 / 6 / 1 / 1 | 170（515） | 不报 | 1728（3520） | 0 | 1395 | 9 |
| Qwen | 9 / 0 | 9 | 8 | 0 | 0 | 1 | 6 / 1 / 1 / 1 | 77（200） | 64（147） | 1707（3072） | 0 | 2304 | 12 |

- “未定”的那一次都是 `stop` 驱动：看到检查那次请求就按停止，之后的检查行留在会话里；三个服务上停止之后发的下一条消息都是 **200**，没有服务因为连着的两条 user 消息回 400（规格 §0 第 17 条）。
- 这几次运行里每次运行至多 1 次检查（`maxPerRun` 1；第 4 次运行 Qwen 有一次 2 次）。**观察，待负责人看**：三个服务各有一次对检查的回应是干活（调了工具），
  之后模型单独调了 `finish`，按决定表第 2 行（proposal §5.4 第 2 条“最近一次检查之后，模型单独调用了 `finish` 并执行成功”）放行，日志记为 `passed (confirmed)`、算作 a；
  也就是检查之后补做的活没有再对照 TASTE、REVIEW 检查一次。这是规格与 proposal 的写法；想让“检查之后干了活”总要再检查，要改决定表的顺序或第 2 行的条件。
- 写话 + `finish`：GLM 9 次里 6 次，DeepSeek 2 次，Qwen 1 次；这句话就是最终回复（`run.lastText`），界面照常显示。只写话（c）一次也没有。
- 检查请求的 `cache_creation` 三个服务都是 0、`cache_read` 平均 1.7K–2.4K token：检查那次请求读到了前缀缓存（这三家都是自动前缀缓存，不报写入）。
- 被拒绝的调用：三个服务的 `reject` 驱动各拒绝了 1 个调用，检查之后都没有重试（FS-82 的那一条在收尾检查开着时同样成立，只记不断言）。
- Mori 开始的运行：只有 DeepSeek 跑了 `team` 驱动（第 1 次运行时它是第一个服务但请求都 422），程序投递开始的那次运行检查了 1 次。
- 没有字段的 `finish` 在三个服务上都调得通：调用 32 次，参数都为空、都通过校验、结果都不是错误。
- 真实录制见第 4 次运行。
- 检查那一行与 `finish` 在界面上从没出现（工具卡、阶段行都没有）；每个检查那次请求的检查那一行与检查块在同一条 user 消息里，点名的两节和写进去的那条都在。

**第 4 次运行**（改了代理之后三个服务全跑，`test-results/fc-real.json` 是这一次的，五条程序保证在三个服务上全部通过，覆盖检查读它）：

| 服务 | 运行（你 / Mori） | 检查 | a | b | c | 未定 | 对检查的回应：只调 `finish` / 写话 + `finish` / 只写话 / 干活 / 停止 | 检查请求的输出 token 平均（最大） | 思考 token 平均（最大） | 检查请求 `cache_read` 平均（最大） | `cache_creation` | 下一次请求 `cache_read` 平均 | `finish` 调用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek | 10 / 1 | 11 | 9 | 0 | 1 | 1 | 7 / 1 / 1 / 1 / 1 | 106（378） | 79（368） | 2479（4736） | 0 | 2714 | 9 |
| GLM | 9 / 0 | 9 | 8 | 0 | 0 | 1 | 0 / 7 / 0 / 1 / 1 | 274（1325） | 不报 | 1756（4032） | 0 | 1779 | 9 |
| Qwen | 9 / 0 | 10 | 8 | 1 | 0 | 1 | 8 / 0 / 0 / 1 / 1 | 78（343） | 66（289） | 1741（3072） | 0 | 2253 | 13 |

- 这一次 Qwen 有一次 b：检查之后调了工具、又写了回复，第二次检查（`finish check 2 (work)`）之后单独调 `finish` 放行，这次运行检查了 2 次；DeepSeek 有一次 c：检查之后只写了字（重写），按第 3 行放行（`passed (no work)`）。
  GLM 这一次同样有一次“干活之后单独调 `finish`”按第 2 行放行（上面的观察）。
- 真实录制：`fc-a-real.json`（DeepSeek）与 `fc-b-real.json`（Qwen 的那次 b）覆盖了第 3 次运行写的那份；没有 `fc-c-real.json`（c 出现在 `tasks` 驱动，不在录制的会话里）。
- 停止之后的下一条消息三个服务都是 200；被拒绝的调用检查之后都没有重试；DeepSeek 的 `team` 驱动里程序投递开始的那次运行检查了 1 次；没有字段的 `finish` 调用 31 次，全部通过。
- 合起来（第 1 次运行的 GLM、Qwen，第 3 次运行的 DeepSeek，第 4 次运行的三个服务，共六份）：59 次检查，a 51、b 1、c 1、停止 6；“写话 + `finish`”多见于 GLM（16 次里 13 次），DeepSeek、Qwen 多只调 `finish`；
  检查那次请求的输出平均 64–274 token、思考平均 37–79 token，`cache_read` 平均 1.7K–2.5K token、`cache_creation` 都是 0。

## 实现时定的（无人模式，待负责人审）

都登记在 [defaults.md](defaults.md)“收尾检查”的第三张表。

| # | 问题 | 定下的 | 理由 | 改到的文件 |
| --- | --- | --- | --- | --- |
| 1 | `followsToolFreeReply` 认不认更早一次运行的回复 | 不认：`switchFrom` 另传这一段的开始，助手消息早于它时为假（规格 §9.2 已加注） | 评审发现：包装里换模型时消息已去掉第一次隐藏的过程，最后一条助手消息可能是上一次运行的回复，第二次换模型的条目会带 `afterReply`、重做说明错写成第一次的模型（MP-15 的情形）；FC-21 加了这一例 | `modelContext.ts`、`modelSession.ts`、`tests/unit/finish/model.test.mjs` |
| 2 | FC-18 App：分开时对话在检查之后调 `bash` | `Tool bash not found` 与 `RELAY_ONLY` 都算拒绝（规格 FC-18 已加注） | 分开时对话启用的工具里没有 `bash`，pi 在 `tool_call` 之前就拒绝，`RELAY_ONLY` 在 App 里造不出来；检查之后 `run.allowed` 仍限制由单元测 | `tests/ui/fc-app-team.mjs` |
| 3 | FC-28 的套件组 | MD-15 的组之外另加 `v1-models-app-nooff` | §14.4 点名 MP-39 读改过的 `lastReply`，`-nooff` 模型的默认检查回应带思考；照 §14.3 字面它不在组里，FC-28 就看不到它退步 | `tests/ui/v1-models-existing.mjs` |
| 4 | 合成端点日志行的 `scenario` | 由 `fc-*` 场景回答的请求记 `fc` 场景名，其余照旧记 `tb-scenario` 名 | `scenarioLines(ep, 'fc-slow', { check: true })`（FC-16）与录制按场景名找请求；`sessionOf().scenario` 不变，脚本与实例不受影响 | `tests/fake-endpoint/scripts.mjs`、`finish.mjs` |
| 5 | 默认检查回应看不看 `tools` | 不看：任何检查请求都回一个 `finish`；只有 `fc-scenario:` 要求请求的 `tools` 有 `finish` | 规格的判断顺序如此；检查请求只出现在有 `finish` 的用户会话里 | `tests/fake-endpoint/server.mjs`、`finish.mjs` |
| 6 | `fc-*` 场景里规格没写的值 | `fc-cap` 调 `bash { command: "echo fc-cap" }`；`fc-mixed` 同一条消息里先 `finish` 后 `bash`；`fc-fail`、`fc-fail-first`、`fc-work-fail` 回 400，`fc-404` 回 404；`fc-slow` 等 8000 毫秒 | 规格只写了行为；这些值让测试读得出是哪一步 | `tests/fake-endpoint/finish.mjs` |
| 7 | `replyTurns` 的新规则对没有 `finish` 的轮次 | 同样生效（规格原文不分）：一轮最后一条助手消息只有工具调用（例如出错、停止）、前面有正文时，操作行挂在有正文的那一项 | 操作行是对回复正文的；规格 §10.1 的规则本来就不看有没有 `finish` | `renderer/src/state/turns.ts` |
| 8 | 界面里“非空”与没有名字的增量 | 正文、思考按去掉首尾空白后判断；`toolName` 缺失（`undefined`）同空字符串，不建卡 | 同 `AssistantMessage.tsx` 的显示与 `turns.ts` 的 `replyTexts`；录下的事件都带名字，回放不受影响 | `renderer/src/state/model.ts`、`transcript.ts` |
| 9 | 检查那次请求出错的日志用哪个 id | 用户会话的 id（`team.userId`），没有 `errorMessage` 时同原来写 `The model request failed.` | §7.4 写 `<sessionId>`；Team 里用户会话的 id 就是它 | `kernel/team.ts` |
| 10 | 用户会话接线怎么测 | `sessions.ts` 导出纯函数 `userCheckWiring`，`startUser` 用它；FC-22 加一条用真实 `memorySetup` 走检查、`context`、`agent_settled` 的测试 | 评审发现 `startUser` 里的加法没有测试；`startUser` 不导出、要 pi 才能跑 | `kernel/sessions.ts`、`tests/unit/finish/extension.test.mjs` |
| 11 | FC-11“`run.lastText` 是那句话” | 单元（`team.test.mjs`）与 App（`fc-app-team.mjs` 的合并会话多一条等回复的 `agent_message`，场景 `fc-a-text`）都测 | 关闭模式下 `run.lastText` 在 App 里看不到，只有等用户会话回复的 `agent_message` 读它 | `tests/unit/finish/team.test.mjs`、`tests/ui/fc-app-team.mjs`、`scenarios/fc-team.mjs` |
| 12 | 真实走查的 a、b、c 怎么数 | 每次检查看这个会话下一行内核日志：`finish check <n+1> (work)` → b，`passed (confirmed)` → a，`passed (no work)` → c，`passed (limit)` → b，出错 → 失败，之后没有日志或是下一次运行的 `first` → 未定 | 规格 §14.2 FC-27 说按日志行与会话文件数；日志行一对一对应决定表 | `tests/ui/fc-real-helpers.mjs` |
| 13 | 真实走查的范围 | 三个服务各一次启动、各一个模型（DeepSeek 与 GLM 用提供商的第一个模型，OpenRouter 用一个列出工具支持的 Qwen，先免费的）；用户级记忆写一条 TASTE、一条 REVIEW（synthetic test setup）让检查块两节都有；`team` 驱动只在第一个服务上跑 | 控制费用与时长；检查块要有内容才能核对“请求里有检查块” | `tests/ui/fc-real.mjs` |
| 14 | 真实走查经转发代理时的地址 | 代理地址写成 `/p/<提供商 id>@<原主机名>`；转发代理另记出错响应正文的前 1000 字符 | 第 1 次走查 DeepSeek 全部 422：地址里只有 127.0.0.1 时 pi 认不出 DeepSeek、发 `developer` 角色（见“真实模型走查”）；与收尾检查无关 | `tests/ui/fc-real-helpers.mjs`、`fc-real.mjs`、`tb-real-helpers.mjs`（只加了 `errorText`） |

## 实现的评审（2026-10-27）

实现写完、`test:min` 通过之后用 Workflow 做了一轮对抗评审：七个维度（内核、模型层、界面、合成端点与测试基建、现有测试的调整、新的 App 与回放套件、工程约束），
每条发现一位反驳者对照代码核实，共 22 个 Agent。15 条发现：成立 11 条、部分成立 2 条、不成立 2 条；成立与部分成立的都已处理。

| 发现 | 判词 | 严重度 | 标题（评审原文） | 怎么处理 |
| --- | --- | --- | --- | --- |
| model#1 | valid | medium | afterReply also fires on a second switch whose last assistant is from an earlier run, so the redo note now names the wrong model | 实现时定的第 1 条；FC-21 加用例（去掉修复时它失败） |
| new-app-suites#1 | valid | medium | FC-23 reopen checks for the fc-fail and stopped sessions demand no empty [data-item], which a correct implementation cannot meet | `fc-app-check.mjs` 的 `reopenedViews`：出错、停止的那两个会话允许紧挨错误卡或 Stopped 的那一个空助手项（没有内容的检查回应） |
| conventions#1、existing-tests#3 | valid | medium / low | Check record still says 'spec written, not implemented'… / Test changes and grep results from §14.4 not written to the checks record | 本文 |
| kernel#1、model#2、conventions#4 | valid / partly / valid | low | FC-22: no test covers how sessions.ts builds extraContextTokens… | 实现时定的第 10 条；`prepare()` 的接手判断读的就是这个 `extraContextTokens`，`agent_settled` 清零之后它只剩工作卡，没有另写 `prepare()` 的用例 |
| endpoint-infra#1 | valid | low | FC-28 never runs v1-models-app-nooff (MP-39), a suite that §14.4 lists as affected | 实现时定的第 3 条 |
| existing-tests#2、conventions#3 | valid | low | driver() grows past the 50-line function limit | `tb-record.mjs` 的查询提到顶层 `sessionIdle`，`driver` 回到 47 行 |
| new-app-suites#2 | valid | low | FC-25 for the off-mode enhancement run is not asserted (session file and Notes) | `fc-app-check.mjs` 的 `enhance()` 加 FC-25：请求、日志、看不见的会话文件里都没有检查与 `finish`，各任务修订的 Notes 仍是最后一条回复 |
| new-app-suites#3 | valid | low | FC-11 'run.lastText is it' for fc-a-text has no App assertion | 实现时定的第 11 条 |
| conventions#2 | partly | low | MP-20 now presses Stop and drops stages after the compaction error, hiding the new wait for a model | 反驳者核实这正是规格要的行为（§5.4 第 4 条、§10.4）；代码不改，改动写进“现有界面测试的改动” |
| renderer#1 | invalid | low | afterReplyOf counts a truncated (stopReason 'length') reply as complete… | 不改：规格 §10.3 的规则逐字如此，§5.4 第 4 条把被截断、等于上限的回复当作答完；想改是规格的事 |
| existing-tests#1 | invalid | low | TB-30 no longer checks the finish-check request… | 不改：§14.4 写 TB-30 不改；检查那次请求里工作卡在最后由 FC-10、FC-20（`fc-app-team.mjs`）断言 |

## 实现的第二轮评审（2026-10-27，发起会话）

实现交回之后，发起会话在提交 `10e5836` 上又做了一轮独立评审：五个区域（内核与 pi 的衔接、TaskBoard 与批准、模型层、界面、测试与合成端点和工程约束）各一位评审，
每个区域的发现再由一位反驳者对照代码核实，共 10 个 Agent。5 条发现，全部是 low：成立 2 条（内核与 TaskBoard 两位评审报的是同一处，合成 1 条），部分成立 1 条（同一处），不成立 2 条。

| 发现 | 判词 | 标题 | 怎么处理 |
| --- | --- | --- | --- |
| renderer#0 | confirmed | 界面重新加载、接上运行中的会话时，名字还没到的 `finish` 调用被画成一张没有标题的 `Preparing…` 卡 | `history.ts` 的 `resumeStreaming` 先把名字为空的 `toolCall` 换成空的正文段、不建 ToolCall，同实时的增量；之后带名字的 `finish` 增量照旧不出卡，别的工具照常出卡。没有改 `blocksFromContent` 本身：那样会让服务端从没给名字、pi 回 `Tool not found` 的调用在会话里丢卡。规格 §10.1 加注；FC-23 加单元用例 |
| kernel-core#0、team-approval#0 | partly / confirmed | 检查那次请求的回复被可恢复地截断、pi 去掉它压缩后重试，重试出错时 `followsCheck` 为假，这次运行按出错算 | `kernel/finishCheck.ts`：`checkLineIndex`（`followsCheck` 改为调它）跳过被 `context_edit`（`replacement: null`）去掉的消息；新的 `textBeforeCheck` 取检查那一行之前、这次运行里最后一段非空文字。`team.ts` 的 `onMessageEnd` 在检查那次请求出错时把 `run.lastText` 换成它：被截断的那条已在自己的 `message_end` 改过 `lastText`（反驳者补的第二半）。规格 §8.3 加注；FC-19 加两个单元用例（`core.test.mjs` 的分支形状、`team.test.mjs` 的等回复的一方拿到检查之前的回复） |
| model-layer#0 | refuted | 模型层规格 §6.1 的注没写“同一段”这个条件 | 不改：§6.1 的注指向本规格 §9.2，那里写了；实现时定的第 1 条已登记待审 |
| tests-endpoint#0 | refuted | TB-30 不再看检查那次请求 | 不改：同上一轮的 existing-tests#1 |

改完之后 `test:fc-unit` 107 / 107（多 3 条），`npm run test:min` 见“状态”。

## 推送前的完整测试（2026-10-27，发起会话）

按 AGENTS.md“测试分层”第 3 条，在提交 `5dc778b` 的开发构建上依次跑了 `test:fc-unit`、构建、`fc-app-check`、`fc-app-team`、`fc-replay`、
`v1-models-existing.mjs --id FC-28`（全部现有套件，约 105 分钟）、`spec-coverage.mjs --spec finish --allow-missing-real`，再 `npm run dist:dir`、
`m0-smoke --exe`、`fc-app-check --exe`（06:20–08:17）。通过的：`test:fc-unit`、构建、`fc-app-team`、`dist:dir`；其余有失败。
一个 workflow 按失败分六组查原因（每组一个查的 Agent、一个复核的 Agent，都不开窗口），结论与处理：

| 失败 | 原因 | 处理 |
| --- | --- | --- |
| `m1-app`“圆环刚压缩完：流程”超时 | **这个分支的产品问题**：每次回复后都压缩时检查停不下来（下面一节） | 改产品代码：从分支上数（`runMessages`） |
| `tb-app-modes` 4 条（TB-05 开关两条、TB-56、TB-05 `/team /<扩展命令>`） | 测试没跟上：`TEAM_DIALOG_TOOLS` 没有 `finish`（§8.2 要求一直有），`teamShape` 因此不成立；工具以外各项（工作卡、段、`late`、once 的顺序）都对 | 集合加 `finish`；规格 §14.4 加一行 |
| `mem-app-prompt` MEM-13 | 测试没跟上：`callTool` 取会话文件最后一个工具结果，现在是 `finish` 的 `Confirmed.`；会话文件里 6 次 write / edit 各自的结果都是拒绝原文、没有批准卡、没有写文件 | 取这次调用的那个工具自己的结果；规格 §14.4 加一行 |
| `fc-replay` FC-12 `fc-b`（直播与重新打开） | 新测试本身的问题：卡片标题的动词与目标是相邻两段，合起来是 `Runecho fc-b`，`/^Run\b/` 不成立；卡片其实在第一段回复与最后回复之间、状态 done | 按 `.tool-verb` 认 bash 的卡 |
| `m1-app`“复制代码”、`m4-app`“复制”、`fc-app-check` FC-11 `fc-a-text`、FC-13 `fc-c` 的 Copy（读回空字符串） | 环境：整段时间这台机器锁屏（`LogonUI` 从 01:33 起在运行），系统剪贴板不能用。`m1-app` 自己先写进剪贴板的内容也读不回来；08:47 在 PowerShell 里 `Set-Clipboard` 之后 `Get-Clipboard` 读回空的。同一份文字 Attach 拿到了，回放里 Copy 交给 `copyText` 的文字正确；Copy 的代码这个分支没改 | 不改；解锁后重跑 |
| `m2-app`“Restart 之后重新打开中……焦点留在权限按钮上” | 时序：测试点 Restart 与聚焦之间的竞争（下面一节） | 不改 |
| `m0-smoke --exe`、`fc-app-check --exe`：`electron.launch` 180 秒超时 | 环境：这个 worktree 的 `app/node_modules` 是指向主检出的 junction，electron-builder 26.17 经 `npm list` 找不到间接依赖（日志 “cannot find path for dependency”），`allowMissingDependencies` 默认为真只告警，`app.asar` 少了 257 个包（64 MB，之前约 150 MB），其中有 koffi 的原生包，主进程启动时 `require('koffi')` 失败、停在出错对话框上。主进程、preload、打包配置这个分支都没改 | 打包程序在合并之后、在主检出（真的 `node_modules`）上重建、重跑 |
| `spec-coverage --spec finish` 与 FC-28 里四个覆盖检查 | 上面各条失败的连带 | 随重跑 |

### m1-app 与 m2-app 的两条失败

推送前在开发构建上跑的 FC-28 汇总（`v1-models-existing.mjs --id FC-28`）里，现有套件各有一条失败；按会话文件与代码查了原因。

- **`m1-app`“圆环刚压缩完：流程”等本轮结束超时（180 秒）：这个分支带来的，改了产品代码。**
  这一步把 pi 的压缩调到每次回复之后都压缩（窗口 128,000、`reserveTokens` 127500、`keepRecentTokens` 1）。那次运行留下的会话文件
  （`%TEMP%\mori-m1-app-compact-ZwFibT`）里，1 条你的消息、1 段回复之后是 23 行检查、23 条只有 `finish` 的回复与 `Confirmed.`、46 次压缩，3 分钟没有停。
  原因：pi 每次运行结束、到边界之前做一次阈值压缩（规格 §3 第 12 条），检查那次请求之前又压缩一次（§3 第 18 条）；`keepRecentTokens` 1 只留最后一条助手消息，
  检查那一行连同 `finish` 每次都被收进摘要；`settleDecision` 原来读 `event.context.contextMessages`（压缩后的投影：摘要、`finish`、结果），
  数不到检查那一行，决定表第 1 行“没检查过”成立，再检查，循环不止。这违反负责人定的上限（proposal §12 第 3 条：两次检查之间没调工具就不再追问、一次运行最多 3 次）；
  规格 §0 第 2 条原以为压缩后“最多多检查几次”。
  改法（负责人不在时按推荐定，待复核）：`kernel/finishCheck.ts` 新的 `runMessages(branch)` 把当前分支上的条目排成 AgentMessage 的形状（跳过压缩条目、
  不进上下文的条目和被 `context_edit` 去掉的消息），`kernel/memoryExtension.ts` 的 `onBeforeSettle` 改为 `settleDecision(runMessages(ctx.sessionManager.getBranch()))`。
  压缩只改投影、不删分支上的条目，收进摘要的检查行与 `finish` 照样数得到；仍不另存状态。这样这一步是：回复 → 压缩 → 检查 → 压缩 → `finish` → 压缩 → 放行（confirmed），
  最后一件事是压缩，圆环“刚压缩完”，测试本身不用改。没选的两种：另存这次运行的检查次数（违反 proposal §13 第 19 条）；只改测试，把 `keepRecentTokens` 调大到留得下检查那一行
  （那样最后一件事是 `finish` 的回复，圆环有用量，测不到“刚压缩完”；真实的设置里只要留下的不到一次检查那么长，照样停不下来）。
  规格 §0 第 2 条、§5.1、§5.2、§5.4 第 5 条、§9.2 的一句、FC-07、FC-08 与 defaults.md 那一行跟着改。单元：FC-07 加两条（`runMessages` 的形状；投影只剩摘要、`finish`
  与结果时按投影数是第 1 行、按分支数放行，3 次检查都收进摘要时仍按上限放行），FC-08 加一条（处理器从分支数）；`test:fc-unit` 110 / 110，`npm run check` 通过。
  **`m1-app` 没有重跑**（当时另一个开窗口的测试在跑），留给下一次完整测试；别的把压缩调小的套件（`tb-app-misc`、`v1-models-app-session`、`v1-models-app-switch`）
  只在检查行被收进摘要时才会不同（少检查几次），同样没有重跑。
- **`m2-app`“Restart 之后重新打开中……焦点留在权限按钮上”（`focus [null], at the end true`）：时序，不是这个分支带来的，没有改。**
  这个分支没改 `src/main`、`src/preload` 和界面的焦点与重新载入（界面只改了 `state/` 里与 `finish` 有关的几处），`m2-app.mjs`、`m2-helpers.mjs` 也没改。
  测试先点 Restart（焦点随按钮消失落到 body），再调 `permissionButton.focus()`；`watchRow` 只在 DOM 变化时记一行。记下的 `Starting…` 只有一行、焦点为 null，
  最后焦点却在权限按钮上：测试的 `focus()` 晚于 `Restarting…` 到 `Starting…` 的切换（或落在 `Starting…` 里、之后再没有 DOM 变化），是测试的点击、聚焦与后台进程重启之间的竞争。
  以前也有过：[models-checks.md](models-checks.md)“现有套件的时序”记着第一次完整回归里 `m2-app` 一条输入框下面一行的焦点失败、单独重跑通过，
  [team-checks.md](team-checks.md) 记着 `m2-app` 因负载超时。可以改的（没有做）：照 `m1-app` 的 `restartFromModel`，先把焦点放到权限按钮上、再用 `element.click()` 点 Restart（不挪焦点）。

## 未验证项

- **新写的开窗口套件一次都没有跑**（AGENTS.md“测试分层”第 2 条）：`fc-app-check.mjs`（FC-02..FC-05、FC-10..FC-17、FC-21、FC-23..FC-25、FC-29 的 App 部分）、
  `fc-app-team.mjs`（FC-02、FC-03、FC-10、FC-11、FC-18..FC-20、FC-25 的 App 部分）、`fc-replay.mjs`（FC-11..FC-13、FC-23 的回放）、`v1-models-existing.mjs --id FC-28`、
  `spec-coverage.mjs --spec finish`、`npm run test:finish`。写它们的 Agent 只做了语法、引用与纯函数的离线核对，下面这些是它们自己列的假设：
  隐藏的会话窗格里阶段行与操作行照常渲染；检查等待中 Ctrl+Enter 插话在 `finish` 之后同一次运行里处理；空的新会话在侧栏有能点的行；
  `pb/fake-coder-replay` 的档案照探针写好就会重建；`fc-fail` 的错误卡原文含 `Synthetic HTTP 400`；协作模式里分开时对话在两条你的消息之间恰好收到一次程序投递；
  第一次进入协作模式写的 `mori.team` 带 `finish`；5 秒的回复延迟够点协作开关。
- **改过的现有界面套件没有跑**：`tb-app-flow`、`tb-app-roles`、`tb-app-stop`、`tb-app-models`、`tb-record`、`mem-app-prompt`、`mem-app-enhance-a`、`m4-app`、`m6-app-slash`、
  `v1-models-app-switch`、`v1-models-app-session`，以及用 `m3-helpers.lastReply` 的 `m3-app`、`m3-app-live`、`v1-models-app-nooff`；其余现有套件（每个用户会话的运行多一次请求）同样没有跑。
  限并发或共用模型上的时序（MP-03 的不排队、MP-17、MP-19）只按道理推，没有观察。
- **真实层**：`v1-models-real.mjs`（MP-27、MP-40）、`m0-real`..`m6-real`、`tb-real`、`mem-real`、`md-real` 没有重跑；FC-27 的情况见上一节。
- **单元层没有覆盖、只能在 App 里看到的**：真实 pi 的 `compaction_end` 与重试的 `agent_start` 的先后（FC-18 用合成事件测）、出错消息写盘前后 `followsCheck` 的两种情形（合成事件）。
- 回放的 fixture 是合成端点上录的；评审之后没有重录（改动不影响录下的事件）。
