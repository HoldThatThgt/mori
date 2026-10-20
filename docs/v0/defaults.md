# 临时默认值

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是"临时默认值"，拿到依据后再定。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 连接表单的上下文长度 | 128000 | `app/src/renderer/src/components/ConnectionForm.tsx` `emptyForm` | 与 pi 的默认值相同 | 拿到内网端点时 |
| 测试连接的最大输出 | 512 token | `app/src/kernel/config.ts` `TEST_MAX_TOKENS` | 推理模型先输出思考，太小时只收到思考、没有正文 | 拿到内网端点时 |
| 测试连接的超时 | 30 秒 | `app/src/kernel/config.ts` `TEST_TIMEOUT_MS` | 端点接受连接却不回复时，按钮不至于一直处于"测试中" | 拿到内网端点时 |
| 测试连接的提示词 | `Reply with one short sentence.` | `app/src/kernel/config.ts` `testConnection` | 短、任何模型都能回答；M1 用 DeepSeek 两个模型都正常 | 拿到内网端点时 |
| Mori 在 `models.json` 中的 provider id | `mori-endpoint` | `app/src/kernel/config.ts` `PROVIDER_ID` | 与 pi 内置 provider 不冲突 | M6（多模型） |
| 打开信任询问之前按不信任创建 | `projectTrusted: false`，pi 在加载项目资源前调用 `resolveProjectTrust` 再定 | `app/src/kernel/sessions.ts` `loadResources` | 与 pi 自己的 `loadProjectTrustExtensions` 相同；M3 起接上信任询问（见 [screens/sessions.md](screens/sessions.md)） | — |
| 文件夹没有要信任的内容时直接按信任处理、不问 | `resolveProjectTrust` 返回 true | `app/src/kernel/trust.ts` `decideTrust` | 与 pi 命令行相同；这时没有项目资源可加载 | M6（工具页） |
| 信任判断不看扩展的 `project_trust` 事件和 `defaultProjectTrust` 设置 | 只按"有没有要信任的内容 → trust.json → 你的回答" | `app/src/kernel/trust.ts` | pi 没有导出 `resolveProjectTrusted` / `emitProjectTrustEvent`；`defaultProjectTrust` 设为 always 会与 M3 反例"任何情况下都不会不经询问就加载扩展"冲突 | M6 或 pi 升级时 |
| 本次运行里同一文件夹只问一次（没勾"记住"时） | 界面记下回答，后台进程重新载入后沿用；只记"信任 / 不信任" | `app/src/renderer/src/state/trust.ts` | 与 pi 命令行的 `projectTrustByCwd` 相同（每个进程问一次） | 你走查时 |
| 信任询问里 Esc 的含义 | 等于"不信任"，不记住 | `app/src/renderer/src/components/TrustDialog.tsx` | 与 pi 取消询问时相同（按不信任、不保存） | 你走查时 |
| trust.json 读不出来时 | 按"没有记录"处理，照常询问并在询问框里显示原文 | `app/src/kernel/trust.ts` `savedDecision` | 不因配置文件损坏挡住打开 | 你走查时 |
| 关闭会话时通知扩展的原因 | `session_shutdown`，reason 为 `quit` | `app/src/kernel/sessions.ts` `release` | pi 的原因只有 quit / reload / new / resume / fork，没有"删除" | pi 升级时 |
| 识别 pi 列表里"没有你的消息" | `firstMessage` 等于 `(no messages)` 时当作没有 | `app/src/kernel/sessions.ts` `NO_MESSAGES` | pi 用这个字面值占位（`session-manager.js` buildSessionInfo） | pi 升级时复查原文 |
| 已归档列表的存放 | 本机 `localStorage`（`mori.archived`），按会话文件；本机存储被清掉时已归档的会话回到项目下 | `app/src/renderer/src/state/archive.ts` | pi 没有归档；会话内容仍只有 pi 的会话文件一份 | 你走查时 |
| 重新打开时补上的工具 | 现在注册了的扩展工具里，不是内置工具（来源不是 `builtin:`）、会直接给模型用的（exposure 为 direct 或 model-only）、扩展没有标成默认不启用的（`defaultActive` 不是 false）；在绑定扩展之前补上 | `app/src/kernel/sessions.ts` `refreshTools` | 照 Claude Code 恢复会话时用当前工具；pi 判断"注册时启用"的函数没有导出，这里按同样的三个条件自己判断 | pi 升级时 |
| 扩展询问的超时 | 按扩展给的 `timeout` 由后台进程计时，到时按取消回给扩展 | `app/src/kernel/extensionUi.ts` | 与 pi 的 RPC 模式相同 | — |
| 不出卡的扩展询问 | 会话打开过程中、停止过程中、会话关闭后提出的询问直接按取消回答，记错误日志；打开过程中的通知打开后再显示 | `app/src/kernel/extensionUi.ts` `blocked` | 打开时界面还不认识这个会话；停止、关闭时出卡会让它们一直等下去（扩展取消一个就接着问下一个） | 你走查时 |
| 界面重新加载后列出的还没保存的会话 | 后台进程里开着、会话文件还不存在的会话补在 `session.list` 后面，最后活动时间取打开它的时刻 | `app/src/kernel/sessions.ts` `unsavedLive` | pi 的列表只读会话文件；不列出就点不回这个会话 | 你走查时 |
| 侧栏排序 | 按最后一条你的消息或助手回复的时间，项目按其中最新的会话 | `app/src/renderer/src/components/sessionRows.ts` `groupRows` | 与 pi 会话列表的 `modified` 同一规则 | 你走查时觉得顺序乱跳再调 |
| 改名：起过名字后不能清除 | 名字为空时什么都不写 | `app/src/renderer/src/components/SessionEdits.tsx` `useRename` | 方案没有要求清除；pi 的会话选择器同样不能清除 | 你走查时 |
| 草稿存放 | 本机 `localStorage`（`mori.drafts`），按会话文件；不按会话列表清理 | `app/src/renderer/src/state/drafts.ts` | 方案第 6 节"界面状态（……各会话草稿）"；pi 读不出会话目录时列表为空，按它清理会误删全部草稿 | M4（引用芯片） |
| 退出时等后台进程释放会话 | 3 秒 | `app/src/main/kernel-process.ts` `SHUTDOWN_TIMEOUT_MS` | 超时后直接结束后台进程的作业（后台进程和它启动的所有进程）；M1 没有发现需要调整的情况 | M6 |
| 兼容选项列表 | 端点不支持 developer 角色（`supportsDeveloperRole: false`）、不接受 store（`supportsStore: false`）、最大输出用 `max_tokens`（`maxTokensField`）、不支持流式用量（`supportsUsageInStreaming: false`）、不支持 strict 模式（`supportsStrictMode: false`）、工具结果需要带工具名（`requiresToolResultName: true`） | `app/src/shared/protocol.ts` `COMPAT_OPTIONS` | 方案 5.2 要求每项配中文说明；挑的是 OpenAI 兼容端点最常见的几处差异，与思考有关的（需要 `reasoning: true` 才生效）留到 M6 | 拿到内网端点时 |
| 错误卡附"去设置"的文字匹配 | 原文含 `401`、`unauthorized` 或 `api key`（不区分大小写） | `app/src/renderer/src/components/Transcript.tsx` `SETTINGS_HINT` | 方案 5.8；其他错误附"把上一条消息放回输入框" | 拿到内网端点的错误原文时 |
| 从会话记录载入时识别"你按过停止" | 工具结果以 `Command aborted` / `Operation aborted` 结尾，或回复的错误原文以 `This operation was aborted` / `Request was aborted` / `Operation aborted` 开头 | `app/src/renderer/src/state/history.ts` `ABORTED_TOOL`、`ABORTED_REPLY` | 实时运行时按你按了停止判断；pi 的会话记录里没有"被停止"的标记，停止后的回复记为 `stopReason: error`，只能看原文 | pi 升级时复查原文 |
| 工具卡展开后输出最多显示 | 最后 20,000 字 | `app/src/renderer/src/components/ToolCard.tsx` `OUTPUT_MAX` | 避免超长输出卡住渲染；pi 的命令输出本身已截到 50KB 左右 | M4（文件阅读器） |
| "在底部"的判定 | 离底部不超过 24px | `app/src/renderer/src/components/Transcript.tsx` `BOTTOM_SLACK` | 小于一行字，滚轮停在差几像素处也算在底部 | 你走查时觉得跟随不对再调 |
| 输入框最高 | 220px，之后在框内滚动 | `app/src/renderer/src/components/Composer.tsx` `MAX_INPUT_HEIGHT` | 约 9 行；再高会挤掉对话流 | 同上 |
| 一条回复里的多个工具调用按顺序执行 | pi 的 `toolExecution: "sequential"`（pi 默认是 `parallel`） | `app/src/kernel/sessions.ts` `startSession` | pi 默认并行时，一条回复里的调用先逐个经过批准处理器，全部放行后才一起执行：允许第一张卡后它并不马上执行，要等后面的卡也答复，而且多条命令会同时运行。按顺序执行时允许一张就执行一张，你看到上一条的结果再决定下一张（方案 5.7"逐张出卡"） | M2 签收时请你确认；只读工具多时可能变慢 |
| 停止时等 pi 记下拒绝的上限 | 2 秒 | `app/src/kernel/approval.ts` `STOP_SETTLE_MS` | 有挂着的卡时按停止，先拒绝、等这次调用在 pi 里结束再中止；先中止的话 pi 只记"Operation aborted"，重新打开会话就认不出"已拒绝"。正常不到 10 毫秒就结束，超时后照样中止 | 你走查时停止变慢再调 |
| 工具卡上拒绝理由显示的长度 | 40 字，超出部分用"…"，悬停看全文 | `app/src/renderer/src/components/ToolCard.tsx` | 长理由会挤掉工具卡的标题；展开工具卡能看到完整理由 | 你走查时觉得不够再调 |
| 拒绝时回给模型的工具结果 | `Rejected by the user.`；写了理由时 `Rejected by the user. Reason: <理由>`；你按了停止时 `Rejected: the user stopped the run.` | `app/src/shared/protocol.ts` `REJECTED_*` | pi 把扩展给的 reason 原样作为工具结果；固定写法让模型明白是你拒绝的，从会话记录载入时也能据此显示"已拒绝" | 内网模型对英文提示的理解不好时 |
| 界面问题报告的保存位置 | `<userData>/ui-issues/<YYYY-MM-DD-HHmmss>.md` 和同名 `.png` | `app/src/main/feedback.ts` | 一个文件夹里平铺，"打开所在文件夹"就能看到全部报告；M7 的收件箱读同一个文件夹 | M7 |
| 界面问题报告里"最近的操作"的条数 | 30 条（只在本次运行的内存里） | `app/src/renderer/src/state/actionLog.ts` `ACTION_LOG_SIZE` | 够看清出问题前做了什么，文件不会太长 | 你用 F8 时觉得不够再调 |
| 右栏在出现改动时自动打开 | 本会话第一次有编辑或写入结果时打开；你手动开关之后以你为准 | `app/src/renderer/src/App.tsx` `Workspace` | 方案 5.9 只说"没有改动时默认收起"，有改动时按"默认打开"理解 | M4 |
